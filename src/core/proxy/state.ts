/**
 * Per-call orchestrator state shared by every wire-format proxy.
 *
 * Each provider proxy (Anthropic /v1/messages, OpenAI /v1/responses,
 * future ones) does the same bookkeeping per tool call:
 *
 *   1. On the response side: see a tool call from the LLM, run
 *      `startChain`, race short-circuit vs descended.
 *   2. Stash the *original* tool name + args so we can restore them on
 *      the next request — the LLM's view of conversation history
 *      should never include our redirect or middleware mutations.
 *   3. On short-circuit: also stash the synthetic ToolResult so we can
 *      splice it into the next request's tool_result/function_call_output.
 *   4. On descend: register a pending handler so we can resolve the
 *      chain's bottom-most `await handler(args)` once the agent's real
 *      tool result arrives in the next request.
 *   5. Emit each completed call exactly once via the `onToolCall`
 *      callback — runner accumulates these into `EvalResult.toolCalls`.
 *
 * `createProxyState` returns an object encapsulating that state with
 * the operations both proxies need. The wire-format-specific code is
 * only the part that walks the response/request body shapes.
 */
import {
  startChain, stringifyToolResult,
  type ChainOutcome,
} from './middleware.js';
import type { Config, Data, Middleware, ToolCall, ToolResult } from '../types.js';

export type ProxyStateCtx = {
  evalName: string;
  config: Readonly<Config>;
  data: Data;
  middleware: readonly Middleware[];
  abort: (reason?: unknown) => void;
  onToolCall: (call: ToolCall) => void;
};

type PendingHandler = {
  server: string;
  tool: string;
  originalInput: unknown;
  resolveBackend: (real: ToolResult) => void;
  rejectBackend: (err: Error) => void;
  chainComplete: Promise<ToolResult>;
};

/**
 * Whatever a wire format needs to remember about the LLM's original
 * tool call so we can restore it in subsequent conversation history.
 * Anthropic uses `{ name, input }`; OpenAI uses `{ name, arguments }`
 * where `arguments` is a JSON string. Stored as opaque `unknown` —
 * each proxy reads back what it wrote.
 */
export type OriginalCall = {
  name: string;
  input: unknown;
};

export type ResultSubstitution = {
  server: string;
  tool: string;
  input: unknown;
  result: ToolResult;
  blocked: boolean;
};

export type ProxyState = {
  /**
   * Run the middleware chain for one tool call. Returns the chain
   * outcome — short-circuit (caller redirects the tool to the agent's
   * shell) or descended (caller mutates args, awaits real result).
   */
  runChain(args: {
    callId: string;
    server: string;
    tool: string;
    originalName: string;
    originalInput: unknown;
    chainInput: unknown;
  }): Promise<ChainOutcome>;

  /**
   * After short-circuit: register what the LLM's next-request view
   * should contain (synthetic result + restored original).
   */
  registerShortCircuit(args: {
    callId: string;
    server: string;
    tool: string;
    originalName: string;
    originalInput: unknown;
    syntheticResult: ToolResult;
  }): void;

  /**
   * After descend: register so the next request's real tool_result
   * resolves the chain's pending `await handler(args)`.
   */
  registerDescended(args: {
    callId: string;
    server: string;
    tool: string;
    originalName: string;
    originalInput: unknown;
    outcome: Extract<ChainOutcome, { kind: 'descended' }>;
  }): void;

  /**
   * Resolve a pending handler with the real tool result (one-shot).
   * Returns the chain's final ToolResult after lower middleware ran.
   * Records a substitution so subsequent calls to `getSubstitution(callId)`
   * return the post-middleware result.
   */
  resolvePending(callId: string, realResult: ToolResult): Promise<ToolResult | null>;

  /** Lookup the original {name, input} for a call id, or undefined. */
  getOriginalCall(callId: string): OriginalCall | undefined;

  /** Lookup the cached substitution for a call id, or undefined. */
  getSubstitution(callId: string): ResultSubstitution | undefined;

  /**
   * Emit `onToolCall` for this id, exactly once per id. Caller invokes
   * after the substitution has been spliced into the request being
   * forwarded — the recorded result is what the LLM saw next turn.
   */
  emitToolCallOnce(callId: string): void;

  /** Reject any still-pending handlers. Call from server.close(). */
  closeAllPending(reason?: string): void;
};

export function createProxyState(ctx: ProxyStateCtx): ProxyState {
  const pendingHandlers = new Map<string, PendingHandler>();
  const originalCalls = new Map<string, OriginalCall>();
  const resultSubstitutions = new Map<string, ResultSubstitution>();
  const emitted = new Set<string>();

  return {
    runChain({ callId, server, tool, chainInput }) {
      return startChain(ctx.middleware, {
        evalName: ctx.evalName,
        config: ctx.config,
        data: ctx.data,
        abort: ctx.abort,
        toolUseId: callId,
        server,
        tool,
        input: chainInput,
      });
    },

    registerShortCircuit({ callId, server, tool, originalName, originalInput, syntheticResult }) {
      originalCalls.set(callId, { name: originalName, input: originalInput });
      resultSubstitutions.set(callId, {
        server, tool, input: originalInput,
        result: syntheticResult, blocked: true,
      });
    },

    registerDescended({ callId, server, tool, originalName, originalInput, outcome }) {
      originalCalls.set(callId, { name: originalName, input: originalInput });
      pendingHandlers.set(callId, {
        server, tool,
        originalInput,
        resolveBackend: outcome.resolveBackend,
        rejectBackend: outcome.rejectBackend,
        chainComplete: outcome.chainComplete,
      });
    },

    async resolvePending(callId, realResult) {
      const pending = pendingHandlers.get(callId);
      if (!pending) return null;
      pendingHandlers.delete(callId);
      pending.resolveBackend(realResult);
      let final: ToolResult;
      try {
        final = await pending.chainComplete;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        final = { content: [{ type: 'text', text: errMsg }], isError: true };
      }
      resultSubstitutions.set(callId, {
        server: pending.server, tool: pending.tool,
        input: pending.originalInput, result: final, blocked: false,
      });
      return final;
    },

    getOriginalCall(callId) { return originalCalls.get(callId); },
    getSubstitution(callId) { return resultSubstitutions.get(callId); },

    emitToolCallOnce(callId) {
      if (emitted.has(callId)) return;
      const sub = resultSubstitutions.get(callId);
      if (!sub) return;
      emitted.add(callId);
      const text = stringifyToolResult(sub.result);
      ctx.onToolCall({
        toolUseId: callId,
        server: sub.server,
        tool: sub.tool,
        input: sub.input,
        resultText: text,
        resultBytes: text.length,
        isError: !!sub.result.isError,
        blocked: sub.blocked,
      });
    },

    closeAllPending(reason = 'proxy closed') {
      for (const p of pendingHandlers.values()) {
        p.rejectBackend(new Error(reason));
      }
      pendingHandlers.clear();
    },
  };
}
