/**
 * Wire-format-agnostic Koa-style middleware chain for adapter proxies.
 *
 * Each adapter's proxy detects `tool_use` blocks in the LLM's response (in
 * its own wire format), then calls `startChain` to run the framework's
 * middleware exactly once per call. The chain races to one of two outcomes:
 *
 *   - `'short-circuit'` — middleware returned a `ToolResult` without
 *     calling `handler`. The proxy redirects the tool_use to a benign
 *     equivalent (Bash echo + base64 in the claude adapter) and replaces
 *     the result the LLM sees on the next request with `outcome.result`.
 *
 *   - `'descended'` — middleware (somewhere in the chain) called
 *     `handler(args)`, possibly with mutated args. The chain pauses on
 *     the inner handler's promise; the proxy emits a `tool_use` with
 *     `finalArgs` to the agent, lets it run, then on the next request
 *     calls `resolveBackend(realResult)`. The chain finishes by walking
 *     back up; the final result lives in `chainComplete`.
 *
 * This file knows nothing about HTTP, SSE, or any specific provider.
 */
import type {
  Config, Data, Handler, Middleware, ToolResult, OnToolCallArg,
} from '../types.js';

export type ChainCtx = {
  evalName: string;
  config: Readonly<Config>;
  data: Data;
  abort: (reason?: unknown) => void;
  server: string;
  tool: string;
  input: unknown;
};

export type ChainOutcome =
  | {
      kind: 'short-circuit';
      /** Final ToolResult to feed to the LLM as the synthetic tool_result. */
      result: ToolResult;
    }
  | {
      kind: 'descended';
      /** Args the proxy should send the agent — possibly middleware-mutated. */
      finalArgs: unknown;
      /** Resolve when the agent's real tool_result arrives in the next request. */
      resolveBackend: (real: ToolResult) => void;
      /** Reject when the agent fails to produce a result (timeout, abort, etc.). */
      rejectBackend: (err: Error) => void;
      /** Resolves with the chain's final ToolResult once `resolveBackend` is called and middleware finishes transforming. */
      chainComplete: Promise<ToolResult>;
    };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function wrapMiddlewareError(name: string, e: unknown): Error {
  const original = e instanceof Error ? e : new Error(String(e));
  return new Error(`middleware ${name}.onToolCall threw: ${original.message}`, { cause: original });
}

/**
 * Run the `onToolCall` chain Koa-style for a single tool call. Returns as
 * soon as the chain either completes (short-circuit) or descends to the
 * synthetic backend at the bottom (need-backend); the caller handles each
 * shape differently.
 */
export function startChain(
  middleware: readonly Middleware[],
  ctx: ChainCtx,
): Promise<ChainOutcome> {
  const chain = middleware.filter((m) => m.onToolCall);

  // `argsReady` fires when execution descends past every middleware to the
  // synthetic backend — `args` are what the agent should run the tool with.
  // `backend` is what the bottom handler awaits; the proxy resolves it once
  // the next request comes in carrying the real tool_result.
  const argsReady = deferred<unknown>();
  const backend = deferred<ToolResult>();

  const baseHandler: Handler = async (args) => {
    argsReady.resolve(args);
    return backend.promise;
  };

  let idx = 0;
  async function next(args: unknown): Promise<ToolResult> {
    if (idx >= chain.length) return baseHandler(args);
    const mw = chain[idx++];
    let handlerCalled = false;
    let handlerResult: ToolResult | undefined;
    const handler: Handler = async (a) => {
      if (handlerCalled) throw new Error(`${mw.name}.onToolCall called handler twice`);
      handlerCalled = true;
      handlerResult = await next(a);
      return handlerResult;
    };
    try {
      const arg: OnToolCallArg = {
        evalName: ctx.evalName,
        config: ctx.config,
        data: ctx.data,
        abort: ctx.abort,
        server: ctx.server,
        tool: ctx.tool,
        input: args,
        handler,
      };
      const result = await mw.onToolCall!(arg);
      if (result !== undefined) return result;
      if (handlerCalled) return handlerResult!;
      return next(args);
    } catch (e) {
      ctx.abort(wrapMiddlewareError(mw.name, e));
      return errorResult(`[${mw.name} failed: ${(e as Error).message}]`);
    }
  }

  const chainPromise = next(ctx.input);

  // Race chain-complete (short-circuit) vs descend-to-backend.
  return Promise.race([
    chainPromise.then(
      (result) => ({ kind: 'short-circuit' as const, result }),
      (error) => ({
        kind: 'short-circuit' as const,
        result: errorResult(error instanceof Error ? error.message : String(error)),
      }),
    ),
    argsReady.promise.then((finalArgs) => ({
      kind: 'descended' as const,
      finalArgs,
      resolveBackend: backend.resolve,
      rejectBackend: backend.reject,
      chainComplete: chainPromise,
    })),
  ]);
}

/** Flatten a `ToolResult.content` array to a plain string. */
export function stringifyToolResult(r: ToolResult): string {
  return r.content
    .map((b: any) => (b.type === 'text' ? String(b.text ?? '') : JSON.stringify(b)))
    .join('\n');
}
