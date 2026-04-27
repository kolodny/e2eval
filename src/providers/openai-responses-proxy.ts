/**
 * OpenAI Responses API proxy — `/v1/responses` wire format,
 * agent-neutral.
 *
 * Counterpart of `anthropic-proxy.ts` for any agent that uses
 * `wire_api = "responses"` (codex 0.125+ and successors). Same
 * two-way-lie strategy: force `stream: false` upstream, get a single
 * JSON Response back, mutate it in place, synthesize SSE on the way
 * back via the shared HTTP scaffolding.
 *
 * Wire format differences from Anthropic:
 *   - Endpoint:  `/v1/responses` (vs `/v1/messages`).
 *   - Tool calls live in `output[]` items as
 *     `{type:'function_call', id, call_id, name, arguments}` —
 *     `arguments` is a JSON STRING.
 *   - Tool results are `{type:'function_call_output', call_id, output}`
 *     items in the next request's `input[]`.
 *   - SSE event names are `response.created`,
 *     `response.output_item.{added,done}`, `response.completed`. The
 *     `response.completed.response.usage.total_tokens` field is
 *     required — codex rejects responses without it.
 */
import { randomUUID } from 'node:crypto';
import {
  startProxyServer,
  type AgentProxy,
} from '../core/proxy/http-server.js';
import { createProxyState } from '../core/proxy/state.js';
import { stringifyToolResult } from '../core/proxy/middleware.js';
import { flattenToText } from '../core/proxy/content.js';
import { startReplayUpstream } from '../core/proxy/replay-upstream.js';
import type {
  Config, Data, Middleware, Recording, ToolCall, ToolResult,
} from '../core/types.js';

// ────────────────────────────────────────────────────────────── types

type FunctionCallItem = {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
  [k: string]: unknown;
};

type MessageItem = {
  type: 'message';
  id?: string;
  role: 'assistant' | 'user' | 'system';
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
};

type ReasoningItem = {
  type: 'reasoning';
  id?: string;
  content?: unknown;
  summary?: unknown;
  [k: string]: unknown;
};

type OutputItem = FunctionCallItem | MessageItem | ReasoningItem | { type: string; [k: string]: unknown };

type OpenAIResponse = {
  id: string;
  object: 'response';
  model: string;
  output: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; [k: string]: unknown };
  [k: string]: unknown;
};

// ────────────────────────────────────────────────────────────── SSE synthesis

/**
 * Build the SSE event sequence the Responses API streams for a
 * complete `Response`. Codex requires `usage.total_tokens` on
 * `response.completed`; we compute it if upstream omits it.
 *
 *   response.created
 *   ├─ per-item (response.output_item.added → .done)
 *   │     for function_call: also emit response.function_call_arguments.delta then .done
 *   │     for message.output_text: also emit response.output_text.delta/.done inside content_part
 *   └─ response.completed
 */
export function synthesizeResponsesSse(resp: OpenAIResponse): string {
  const parts: string[] = [];
  const push = (event: string, data: unknown) => {
    parts.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  push('response.created', {
    type: 'response.created',
    response: { id: resp.id, object: 'response', model: resp.model, output: [], status: 'in_progress' },
  });

  resp.output.forEach((item, output_index) => {
    if (item.type === 'function_call') {
      const fc = item as FunctionCallItem;
      const itemId = fc.id ?? `fc_${randomUUID().slice(0, 8)}`;
      push('response.output_item.added', {
        type: 'response.output_item.added',
        output_index,
        item: {
          id: itemId,
          type: 'function_call',
          call_id: fc.call_id,
          name: fc.name,
          arguments: '',
          status: 'in_progress',
        },
      });
      push('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: itemId,
        output_index,
        delta: String(fc.arguments ?? ''),
      });
      push('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: itemId,
        output_index,
        arguments: String(fc.arguments ?? ''),
      });
      push('response.output_item.done', {
        type: 'response.output_item.done',
        output_index,
        item: { ...fc, status: 'completed' },
      });
    } else if (item.type === 'message') {
      const msg = item as MessageItem;
      const itemId = msg.id ?? `msg_${randomUUID().slice(0, 8)}`;
      push('response.output_item.added', {
        type: 'response.output_item.added',
        output_index,
        item: {
          id: itemId,
          type: 'message',
          role: msg.role,
          content: [],
          status: 'in_progress',
        },
      });
      (msg.content ?? []).forEach((part, content_index) => {
        if (part.type === 'output_text') {
          const text = String(part.text ?? '');
          push('response.content_part.added', {
            type: 'response.content_part.added',
            item_id: itemId, output_index, content_index,
            part: { type: 'output_text', text: '' },
          });
          push('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: itemId, output_index, content_index, delta: text,
          });
          push('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: itemId, output_index, content_index, text,
          });
          push('response.content_part.done', {
            type: 'response.content_part.done',
            item_id: itemId, output_index, content_index,
            part: { type: 'output_text', text },
          });
        }
      });
      push('response.output_item.done', {
        type: 'response.output_item.done',
        output_index,
        item: { ...msg, status: 'completed' },
      });
    } else {
      // Reasoning items and unknowns — bracket added/done so codex's
      // index counter stays in sync.
      push('response.output_item.added', {
        type: 'response.output_item.added',
        output_index,
        item: { ...item, status: 'in_progress' } as any,
      });
      push('response.output_item.done', {
        type: 'response.output_item.done',
        output_index,
        item: { ...item, status: 'completed' } as any,
      });
    }
  });

  // total_tokens is required — compute if omitted.
  const usage = resp.usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);

  push('response.completed', {
    type: 'response.completed',
    response: {
      ...resp,
      status: 'completed',
      usage: { ...usage, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
    },
  });

  return parts.join('');
}

// ────────────────────────────────────────────────────────────── helpers

export function splitMcpName(name: string): { server: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { server: m[1], tool: m[2] };
  return { server: 'native', tool: name };
}

/**
 * Build the function-call `arguments` JSON string for a redirect to
 * codex's `exec_command`: `{ "cmd": "<shell line>" }`. base64 keeps
 * the payload free of shell-special chars so single-quoting is safe.
 */
export function encodeAsResponsesRedirect(synthetic: ToolResult): string {
  const text = stringifyToolResult(synthetic);
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const shellLine = synthetic.isError
    ? `echo '${b64}' | base64 -d; exit 1`
    : `echo '${b64}' | base64 -d`;
  return JSON.stringify({ cmd: shellLine });
}

// ────────────────────────────────────────────────────────────── server

export type StartOpenAIResponsesProxyOpts = {
  evalName: string;
  config: Readonly<Config>;
  data: Data;
  middleware: readonly Middleware[];
  abort: (reason?: unknown) => void;
  onToolCall: (call: ToolCall) => void;
  upstream?: string;
  upstreamResolver?: () => string;
  /** Tool name used as the redirect target on short-circuit. Codex: `exec_command`. */
  redirectToolName: string;
  /** Build the `arguments` string for the redirect tool. */
  redirectArgumentsBuilder?: (synthetic: ToolResult) => string;
  /**
   * Capture each upstream round-trip as raw bytes — used by the
   * runner's `record` mode to gather exchanges for later replay.
   */
  onExchange?: (request: string, response: string) => void;
  /**
   * Map of `call_id → recorded ToolResult`. When the agent emits a
   * function_call with one of these ids during the replay prefix, the
   * proxy auto-short-circuits it with the recorded result and skips
   * middleware (strict replay).
   */
  replayResults?: ReadonlyMap<string, ToolResult>;
  /**
   * Replay the first `upTo` recorded exchanges before forwarding to
   * the live upstream. The proxy spins up an in-process replay
   * server and routes traffic through it.
   */
  replay?: { recording: Recording; upTo: number };
};

/**
 * Walk a `Recording`'s captured request bodies and pull out every
 * `function_call_output` item keyed by `call_id`. Used to auto-short-
 * circuit prefix tool calls during replay.
 */
export function extractResponsesReplayResults(
  recording: { exchanges: Array<{ request: string; response: string }> },
): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const ex of recording.exchanges) {
    let body: any;
    try { body = JSON.parse(ex.request); } catch { continue; }
    if (!Array.isArray(body?.input)) continue;
    for (const item of body.input) {
      if (item?.type !== 'function_call_output' || typeof item.call_id !== 'string') continue;
      map.set(item.call_id, {
        content: [{ type: 'text', text: flattenToText(item.output) }],
      });
    }
  }
  return map;
}

const DEFAULT_UPSTREAM_RESOLVER = (): string =>
  process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';

export type { AgentProxy };

export async function startOpenAIResponsesProxy(
  opts: StartOpenAIResponsesProxyOpts,
): Promise<AgentProxy> {
  const liveUpstream = opts.upstream ?? (opts.upstreamResolver ?? DEFAULT_UPSTREAM_RESOLVER)();
  const buildRedirectArguments = opts.redirectArgumentsBuilder ?? encodeAsResponsesRedirect;

  let upstream = liveUpstream;
  let replayServer: { close: () => Promise<void> } | undefined;
  let replayResults = opts.replayResults;
  if (opts.replay) {
    const replay = await startReplayUpstream({
      recording: opts.replay.recording,
      upTo: opts.replay.upTo,
      liveUpstream,
      matchPath: (url) => url.includes('/v1/responses'),
    });
    replayServer = replay;
    upstream = replay.url;
    if (!replayResults) {
      replayResults = extractResponsesReplayResults(opts.replay.recording);
    }
  }

  const state = createProxyState({
    evalName: opts.evalName,
    config: opts.config,
    data: opts.data,
    middleware: opts.middleware,
    abort: opts.abort,
    onToolCall: opts.onToolCall,
  });

  // ──────────────────────────── response side: middleware on each function_call

  async function processResponse(resp: OpenAIResponse): Promise<void> {
    if (!Array.isArray(resp.output)) return;
    for (const item of resp.output) {
      if (item.type !== 'function_call') continue;
      const fc = item as FunctionCallItem;
      const originalName = fc.name;
      const originalArgsStr = fc.arguments ?? '{}';
      let parsedArgs: unknown = {};
      try { parsedArgs = JSON.parse(originalArgsStr); } catch { /* keep {} */ }
      const { server, tool } = splitMcpName(originalName);

      // Replay prefix: if the recording has a prebaked tool_result for
      // this call_id, short-circuit with it directly and skip the
      // middleware chain.
      const recorded = replayResults?.get(fc.call_id);
      if (recorded) {
        state.registerShortCircuit({
          callId: fc.call_id, server, tool,
          originalName, originalInput: originalArgsStr,
          syntheticResult: recorded,
        });
        fc.name = opts.redirectToolName;
        fc.arguments = buildRedirectArguments(recorded);
        continue;
      }

      const outcome = await state.runChain({
        callId: fc.call_id,
        server, tool,
        originalName,
        originalInput: originalArgsStr,
        chainInput: parsedArgs,
      });

      if (outcome.kind === 'short-circuit') {
        state.registerShortCircuit({
          callId: fc.call_id, server, tool,
          originalName, originalInput: originalArgsStr,
          syntheticResult: outcome.result,
        });
        fc.name = opts.redirectToolName;
        fc.arguments = buildRedirectArguments(outcome.result);
      } else {
        state.registerDescended({
          callId: fc.call_id, server, tool,
          originalName, originalInput: originalArgsStr,
          outcome,
        });
        fc.arguments = JSON.stringify(outcome.finalArgs ?? {});
      }
    }
  }

  // ──────────────────────────── request side: restore originals, splice outputs

  async function processRequest(body: any): Promise<void> {
    if (!body || !Array.isArray(body.input)) return;

    // Restore name+arguments on every function_call item.
    for (const item of body.input) {
      if (item?.type !== 'function_call') continue;
      const orig = state.getOriginalCall(item.call_id);
      if (orig) {
        item.name = orig.name;
        // The Anthropic proxy stores `originalInput` as the parsed
        // input (object), but here the wire sends `arguments` as a
        // string. We stashed the original arguments string under
        // `input` — read it back as a string.
        item.arguments = orig.input as string;
      }
    }

    // Walk function_call_output items: resolve pending handlers, splice.
    for (const item of body.input) {
      if (item?.type !== 'function_call_output') continue;
      const callId = item.call_id;
      if (!callId) continue;

      const realResult: ToolResult = {
        content: [{ type: 'text', text: flattenToText(item.output) }],
      };
      await state.resolvePending(callId, realResult);

      const sub = state.getSubstitution(callId);
      if (sub) {
        item.output = stringifyToolResult(sub.result);
        state.emitToolCallOnce(callId);
      }
    }
  }

  const proxy = await startProxyServer<any, OpenAIResponse>({
    upstream,
    match: (url) => url.includes('/v1/responses'),
    transformRequest: processRequest,
    isValidResponse: (p): p is OpenAIResponse =>
      !!p && typeof p === 'object' && Array.isArray((p as any).output),
    transformResponse: processResponse,
    synthesizeSse: synthesizeResponsesSse,
    onExchange: opts.onExchange,
    onClose: () => state.closeAllPending(),
  });

  if (replayServer) {
    const baseClose = proxy.close;
    return {
      ...proxy,
      close: async () => {
        await baseClose();
        await replayServer!.close();
      },
    };
  }

  return proxy;
}

export { stringifyToolResult };
