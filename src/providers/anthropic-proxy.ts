/**
 * Anthropic API proxy — `/v1/messages` wire format, agent-neutral.
 *
 * Reusable across any agent that speaks Anthropic (claude itself,
 * opencode via `@ai-sdk/anthropic`, future agents). The agent-specific
 * bits — tool name to redirect short-circuits to, how to resolve the
 * upstream URL, and the redirect tool's input shape — are passed in
 * by the caller.
 *
 * Strategy: never see SSE on the wire. We force `stream: false`
 * upstream, get a single JSON `Message` back, mutate it in place, then
 * synthesize the SSE event sequence the agent expects via the shared
 * HTTP server scaffolding.
 *
 * The two-way lie:
 *
 * When middleware short-circuits, we don't strip the tool_use (the
 * agent would just retry) and we can't directly prevent execution
 * from outside the agent. Instead we redirect the tool_use to the
 * caller's configured shell tool (claude: `Bash`, opencode: `bash`)
 * with a base64-encoded synthesis. The agent runs that, gets exactly
 * the bytes we wanted as the result, then sends the next request. On
 * that request we restore the original tool name + input in the
 * assistant message so the LLM never sees the redirect: it sees its
 * own emission and a coherent tool_result. Same trick handles mutated
 * args: the agent runs with mutatedArgs, the LLM sees originalArgs.
 */
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

type ContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: 'thinking'; thinking: string; signature?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

type AnthropicMessage = {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Record<string, unknown>;
  [k: string]: unknown;
};

type AnyBlock = { type: string; [k: string]: unknown };
type Message = { role: string; content: string | AnyBlock[] };

// ────────────────────────────────────────────────────────────── SSE synthesis

/**
 * Build the SSE event sequence Anthropic streams for a complete `Message`.
 * Every required envelope field must be present, even ones that look
 * optional (`stop_sequence: null`, full `usage`).
 *
 *   message_start  →  per-block (content_block_start → delta → stop)  →
 *   message_delta  →  message_stop
 */
export function synthesizeSse(msg: AnthropicMessage): string {
  const parts: string[] = [];
  const push = (event: string, data: unknown) => {
    parts.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  push('message_start', {
    type: 'message_start',
    message: {
      id: msg.id,
      type: 'message',
      role: msg.role ?? 'assistant',
      model: msg.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 },
    },
  });

  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i];
    if (block.type === 'text') {
      push('content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      });
      push('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: String((block as any).text ?? '') },
      });
    } else if (block.type === 'tool_use') {
      const tu = block as any;
      push('content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} },
      });
      push('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input ?? {}) },
      });
    } else if (block.type === 'thinking') {
      const th = block as any;
      push('content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      push('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'thinking_delta', thinking: String(th.thinking ?? '') },
      });
      // Signature delta MUST come after the thinking delta — it's
      // cryptographic and the model rejects modified thinking content
      // with a stale signature on the next request.
      if (th.signature) {
        push('content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'signature_delta', signature: String(th.signature) },
        });
      }
    } else {
      // Unknown block type — emit start so the agent doesn't desync indices.
      push('content_block_start', { type: 'content_block_start', index: i, content_block: block });
    }
    push('content_block_stop', { type: 'content_block_stop', index: i });
  }

  push('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: msg.stop_reason ?? 'end_turn',
      stop_sequence: msg.stop_sequence ?? null,
    },
    usage: msg.usage ?? { output_tokens: 0 },
  });
  push('message_stop', { type: 'message_stop' });

  return parts.join('');
}

// ────────────────────────────────────────────────────────────── helpers

export function splitMcpName(name: string): { server: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { server: m[1], tool: m[2] };
  return { server: 'native', tool: name };
}

/**
 * Build a shell-tool input that, when run, emits exactly the synthetic
 * content as stdout and exits non-zero iff the synthetic is an error.
 * base64 round-tripping avoids any shell-quoting hazards.
 *
 * Returns `{ command, description }` — what claude's `Bash` tool and
 * opencode's `bash` tool both accept. Override via
 * `redirectInputBuilder` for tools with different input shapes.
 */
export function encodeAsToolRedirect(synthetic: ToolResult): { command: string; description: string } {
  const text = stringifyToolResult(synthetic);
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  // base64 alphabet is `A-Za-z0-9+/=` — no shell-special chars, so
  // single-quoting is safe with no escaping pass.
  const command = synthetic.isError
    ? `echo '${b64}' | base64 -d; exit 1`
    : `echo '${b64}' | base64 -d`;
  return { command, description: 'e2eval: middleware redirect' };
}

/**
 * Normalise an Anthropic `tool_result.content` (string or block array)
 * to a `ToolResult.content` array so middleware sees a uniform shape.
 */
function parseToolResultContent(c: unknown): ToolResult['content'] {
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (Array.isArray(c)) {
    return c.map((item: any) => {
      if (typeof item === 'string') return { type: 'text', text: item };
      if (item && item.type === 'text') return { type: 'text', text: String(item.text ?? '') };
      return item;
    });
  }
  if (c == null) return [{ type: 'text', text: '' }];
  return [{ type: 'text', text: flattenToText(c) }];
}

// ────────────────────────────────────────────────────────────── server

export type StartAnthropicProxyOpts = {
  evalName: string;
  config: Readonly<Config>;
  data: Data;
  middleware: readonly Middleware[];
  abort: (reason?: unknown) => void;
  onToolCall: (call: ToolCall) => void;
  /** Override upstream URL. If provided, takes priority over `upstreamResolver`. */
  upstream?: string;
  /**
   * Resolve the upstream URL when `upstream` isn't passed. Each adapter
   * brings its own resolver. Defaults to `process.env.ANTHROPIC_BASE_URL`
   * → `https://api.anthropic.com`.
   */
  upstreamResolver?: () => string | Promise<string>;
  /**
   * Tool name used as the redirect target on short-circuit. Claude has
   * `Bash`; opencode has `bash`. If your agent's redirect tool takes a
   * different input shape, also pass `redirectInputBuilder`.
   */
  redirectToolName: string;
  /**
   * Build the input object passed to the redirect tool. Defaults to
   * `encodeAsToolRedirect`, which produces `{ command, description }`.
   */
  redirectInputBuilder?: (synthetic: ToolResult) => unknown;
  /**
   * Capture each upstream round-trip as raw bytes — used by the
   * runner's `record` mode to gather exchanges for later replay.
   */
  onExchange?: (request: string, response: string) => void;
  /**
   * Map of `tool_use_id → recorded ToolResult`. When the agent emits a
   * tool_use with one of these ids during the replay prefix, the proxy
   * auto-short-circuits it with the recorded result and skips
   * middleware (strict replay). Built by `extractAnthropicReplayResults`
   * from the captured request bytes.
   *
   * Set automatically by `startAnthropicProxy` when `replay` is
   * provided — callers don't normally pass this by hand.
   */
  replayResults?: ReadonlyMap<string, ToolResult>;
  /**
   * Replay the first `upTo` recorded exchanges before forwarding to
   * the live upstream. When set, the proxy spins up an in-process
   * replay-upstream (using `upstream`/`upstreamResolver` as the LIVE
   * URL) and routes the agent's traffic through it. Tool calls during
   * the prefix auto-short-circuit using the recording's tool_results.
   */
  replay?: {
    recording: Recording;
    upTo: number;
  };
  /**
   * Optional pointer-dereferencer for tools that spool large outputs
   * to disk and return a marker on the wire (e.g. claude's
   * `<persisted-output>` for oversized Bash / MCP results).
   *
   * Per tool_result the proxy:
   *   1. `detect(wireResult)` — return truthy "pointer info" if this
   *      result is a spooled-output marker, else null.
   *   2. `read(pointer)` — load the underlying file. The result is
   *      handed to the middleware chain so middleware sees the full
   *      content as if it had been inline.
   *   3. `write(pointer, finalResult)` — persist any middleware
   *      mutation back to disk. The agent's next `Read` of that path
   *      sees the mutated content.
   *   4. `rewriteWire(pointer, original)` — produce the wire-side
   *      tool_result the LLM should see. Typically strips the inline
   *      preview that the marker carries, so unredacted content
   *      doesn't leak across turns; the path stays so the LLM can
   *      Read it. The original pointer envelope is preserved by
   *      design — replay/record stay byte-stable in shape.
   *
   * Adapter-internal: opencode shares this provider but doesn't have
   * a pointer convention, so it just doesn't pass a dereferencer.
   */
  dereferencer?: {
    detect: (real: ToolResult) => unknown | null | Promise<unknown | null>;
    read: (pointer: unknown) => Promise<ToolResult>;
    write: (pointer: unknown, result: ToolResult) => Promise<void>;
    rewriteWire: (pointer: unknown, original: ToolResult) => ToolResult;
  };
};

/**
 * Walk a `Recording`'s captured request bodies and pull out every
 * `tool_result` block keyed by `tool_use_id`. The map is what the
 * proxy uses to auto-short-circuit prefix tool calls during replay.
 *
 * Only the Anthropic wire format — `messages[].content[]` containing
 * `{type:'tool_result', tool_use_id, content, is_error}`.
 */
export function extractAnthropicReplayResults(
  recording: { exchanges: Array<{ request: string; response: string }> },
): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const ex of recording.exchanges) {
    let body: any;
    try { body = JSON.parse(ex.request); } catch { continue; }
    if (!Array.isArray(body?.messages)) continue;
    for (const m of body.messages) {
      if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        map.set(block.tool_use_id, {
          content: parseToolResultContent(block.content),
          isError: !!block.is_error,
        });
      }
    }
  }
  return map;
}

const DEFAULT_UPSTREAM_RESOLVER = (): string =>
  process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';

export type { AgentProxy };

export async function startAnthropicProxy(opts: StartAnthropicProxyOpts): Promise<AgentProxy> {
  const liveUpstream = opts.upstream ?? await (opts.upstreamResolver ?? DEFAULT_UPSTREAM_RESOLVER)();
  const buildRedirectInput = opts.redirectInputBuilder ?? encodeAsToolRedirect;

  // If replay is requested, route the proxy's upstream through an
  // in-process replay-server first. The proxy doesn't know — it just
  // sees an upstream that returns prebaked responses for a while.
  let upstream = liveUpstream;
  let replayServer: { close: () => Promise<void> } | undefined;
  let replayResults = opts.replayResults;
  if (opts.replay) {
    const replay = await startReplayUpstream({
      recording: opts.replay.recording,
      upTo: opts.replay.upTo,
      liveUpstream,
      matchPath: (url) => url.includes('/v1/messages'),
    });
    replayServer = replay;
    upstream = replay.url;
    if (!replayResults) {
      replayResults = extractAnthropicReplayResults(opts.replay.recording);
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

  // ──────────────────────────── response side: middleware on each tool_use

  async function processResponse(msg: AnthropicMessage): Promise<void> {
    if (!Array.isArray(msg.content)) return;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block.type !== 'tool_use') continue;
      const tu = block as any;
      const originalName: string = tu.name;
      const originalInput = tu.input ?? {};
      const { server, tool } = splitMcpName(originalName);

      // Replay prefix: if the recording has a prebaked tool_result for
      // this call id, short-circuit with it directly and skip the
      // middleware chain. Strict replay means the LLM sees exactly the
      // original conversation up to the cutoff.
      const recorded = replayResults?.get(tu.id);
      if (recorded) {
        state.registerShortCircuit({
          callId: tu.id, server, tool,
          originalName, originalInput,
          syntheticResult: recorded,
        });
        tu.name = opts.redirectToolName;
        tu.input = buildRedirectInput(recorded);
        continue;
      }

      const outcome = await state.runChain({
        callId: tu.id,
        server, tool,
        originalName, originalInput,
        chainInput: originalInput,
      });

      if (outcome.kind === 'short-circuit') {
        state.registerShortCircuit({
          callId: tu.id, server, tool,
          originalName, originalInput,
          syntheticResult: outcome.result,
        });
        tu.name = opts.redirectToolName;
        tu.input = buildRedirectInput(outcome.result);
      } else {
        state.registerDescended({
          callId: tu.id, server, tool,
          originalName, originalInput,
          outcome,
        });
        tu.input = outcome.finalArgs;
      }
    }
  }

  // ──────────────────────────── request side: restore originals, splice results

  async function processRequest(body: any): Promise<void> {
    if (!body || !Array.isArray(body.messages)) return;

    // Restore tool_use name+input on every assistant message — so the
    // LLM's view of conversation history matches what it emitted.
    for (const m of body.messages as Message[]) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if ((block as any).type !== 'tool_use') continue;
        const tu = block as any;
        const orig = state.getOriginalCall(tu.id);
        if (orig) {
          tu.name = orig.name;
          tu.input = orig.input;
        }
      }
    }

    // Walk user-message tool_result blocks: resolve pending handlers
    // first, then apply substitutions. For pointer-style results
    // (e.g. claude's `<persisted-output>`) the dereferencer reads the
    // spooled file so middleware sees full content; the wire keeps the
    // pointer envelope but with its inline preview stripped.
    for (const m of body.messages as Message[]) {
      if (m.role !== 'user' || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if ((block as any).type !== 'tool_result') continue;
        const tr = block as any as { tool_use_id: string; content: unknown; is_error?: boolean };
        const id = tr.tool_use_id;

        const wireResult: ToolResult = {
          content: parseToolResultContent(tr.content),
          isError: !!tr.is_error,
        };

        // Detect on every walk — the wire is rebuilt each request, so a
        // pointer's preview-strip needs to happen each time we see it.
        const pointer = opts.dereferencer
          ? await opts.dereferencer.detect(wireResult)
          : null;

        // First pass for this id (no substitution yet): hand the
        // dereferenced (or wire) content to middleware, then write back
        // any mutation. Subsequent walks just splice the recorded sub.
        if (!state.getSubstitution(id)) {
          let realResult = wireResult;
          if (pointer && opts.dereferencer) {
            realResult = await opts.dereferencer.read(pointer);
            realResult.isError = wireResult.isError;
          }
          await state.resolvePending(id, realResult);
          if (pointer && opts.dereferencer) {
            const fresh = state.getSubstitution(id);
            if (fresh) await opts.dereferencer.write(pointer, fresh.result);
          }
        }

        const sub = state.getSubstitution(id);
        if (sub) {
          if (pointer && opts.dereferencer) {
            // Wire keeps the pointer envelope but loses the preview so
            // unredacted content doesn't leak in conversation history.
            const rewritten = opts.dereferencer.rewriteWire(pointer, wireResult);
            tr.content = rewritten.content;
          } else {
            tr.content = sub.result.content;
            tr.is_error = !!sub.result.isError;
          }
          state.emitToolCallOnce(id);
        }
      }
    }
  }

  const proxy = await startProxyServer<any, AnthropicMessage>({
    upstream,
    match: (url) => url.includes('/v1/messages'),
    transformRequest: processRequest,
    isValidResponse: (p): p is AnthropicMessage =>
      !!p && typeof p === 'object' && Array.isArray((p as any).content),
    transformResponse: processResponse,
    synthesizeSse,
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
