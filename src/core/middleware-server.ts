/**
 * In-process HTTP server — the single home for all eval middleware. Starts
 * once per runner, shared across concurrent eval runs. Each run registers
 * its context by runId; every inbound request includes the runId so the
 * server routes to the correct context.
 *
 * Endpoints:
 *
 *   POST /on-tool-use/call           { tool, args, serverName, callId, runId }
 *   POST /on-tool-use/backend-result { callId, response? | error? }
 *   POST /pre-tool                   (native tools: hookType=before)
 *   POST /post-tool                  (native tools: hookType=after)
 *   POST /after-tool-response        (MCP tools, fire-and-forget observer)
 *
 * Single-fire MCP protocol. Each middleware's `onToolCall` body runs exactly
 * once per tool call. When the Koa-style chain descends to the backend,
 * `baseHandler` suspends on a pending promise; the server responds
 * `need-backend` and stashes the resolvers keyed by callId. The wrapper runs
 * the backend and POSTs `/backend-result`, which resolves the stashed promise,
 * unwinds the chain, and returns the final response.
 *
 * If middleware short-circuits (returns a CallToolResult without calling
 * handler), the chain never descends and `/on-tool-use/call` responds
 * `{type:'final', response}` directly — no backend round-trip.
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import type { Middleware, Config } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function writeLog(filePath: string, entry: Record<string, unknown>, runId: string): void {
  if (!filePath) return;
  try {
    appendFileSync(filePath, JSON.stringify({ ts: Date.now(), runId, ...entry }) + '\n');
  } catch { /* best-effort */ }
}

function wrapMiddlewareError(
  middlewareName: string,
  phase: 'onToolCall' | 'afterToolCall',
  err: unknown,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  return new Error(`middleware ${middlewareName}.${phase} threw: ${original.message}`, { cause: original });
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export type RunContext = {
  evalName: string;
  config: Readonly<Config>;
  toolLogPath: string;
  runId: string;
  abort?: (reason?: unknown) => void;
};

export type MiddlewareServer = {
  port: number;
  registerRun(ctx: RunContext): void;
  unregisterRun(runId: string): void;
  close(): Promise<void>;
};

const EMPTY_CTX: RunContext = {
  evalName: '',
  config: {} as Readonly<Config>,
  toolLogPath: '',
  runId: '',
};

type PendingMcp = {
  resolveBackend: (v: CallToolResult) => void;
  rejectBackend: (e: Error) => void;
  chainPromise: Promise<CallToolResult>;
};

export async function startMiddlewareServer(
  middleware: readonly Middleware[],
): Promise<MiddlewareServer> {
  const middlewareWithOnTool = middleware.filter((h) => h.onToolCall);
  const middlewareWithAfter = middleware.filter((h) => h.afterToolCall);

  const runs = new Map<string, RunContext>();
  const pendingMcp = new Map<string, PendingMcp>();

  function getCtx(runId: string | undefined): RunContext {
    if (runId && runs.has(runId)) return runs.get(runId)!;
    return EMPTY_CTX;
  }

  const noop = () => {};

  // ──────────────────────────── Koa-style MCP chain

  /**
   * Runs the `onToolCall` chain Koa-style. Each middleware runs exactly once.
   * Calling `handler(args)` descends to the next middleware (or `baseHandler`
   * at the bottom). Returning a CallToolResult either short-circuits (if
   * handler wasn't called) or transforms the response (if it was). Returning
   * undefined after calling handler passes the handler's result through
   * unchanged; returning undefined without calling handler delegates to the
   * next middleware as if this one weren't installed.
   */
  async function runMcpChain(
    chain: readonly Middleware[],
    baseHandler: (args: unknown) => Promise<CallToolResult>,
    ctx: {
      server: string;
      tool: string;
      evalName: string;
      config: Readonly<Config>;
      abort: (reason?: unknown) => void;
    },
    input: unknown,
  ): Promise<CallToolResult> {
    let idx = 0;
    async function next(args: unknown): Promise<CallToolResult> {
      if (idx >= chain.length) return baseHandler(args);
      const mw = chain[idx++];
      let handlerWasCalled = false;
      let handlerResult: CallToolResult | undefined;
      const handler = async (a: unknown): Promise<CallToolResult> => {
        if (handlerWasCalled) throw new Error(`${mw.name}.onToolCall called handler twice`);
        handlerWasCalled = true;
        handlerResult = await next(a);
        return handlerResult;
      };
      try {
        const result = await mw.onToolCall!({
          server: ctx.server,
          tool: ctx.tool,
          input: args,
          handler,
          evalName: ctx.evalName,
          config: ctx.config,
          abort: ctx.abort,
        });
        if (result !== undefined) return result;
        if (handlerWasCalled) return handlerResult!;
        return next(args);
      } catch (e) {
        ctx.abort(wrapMiddlewareError(mw.name, 'onToolCall', e));
        return errorResult(`[${mw.name} failed: ${(e as Error).message}]`);
      }
    }
    return next(input);
  }

  async function handleCall(body: {
    tool: string;
    args: unknown;
    serverName: string;
    callId: string;
    runId?: string;
  }): Promise<
    | { type: 'final'; response: CallToolResult }
    | { type: 'need-backend'; args: unknown }
  > {
    const ctx = getCtx(body.runId);

    // `argsReady` fires when the chain descends to baseHandler (the args it
    // passed are what the backend should be called with — middleware may have
    // mutated them). `backend` is the promise baseHandler awaits; it resolves
    // later when /backend-result is POSTed back.
    const argsReady = deferred<unknown>();
    const backend = deferred<CallToolResult>();

    const baseHandler = async (args: unknown): Promise<CallToolResult> => {
      argsReady.resolve(args);
      return backend.promise;
    };

    const chainPromise = runMcpChain(
      middlewareWithOnTool,
      baseHandler,
      {
        server: body.serverName,
        tool: body.tool,
        evalName: ctx.evalName,
        config: ctx.config,
        abort: ctx.abort ?? noop,
      },
      body.args,
    );

    // Race chain-complete (short-circuit) vs need-backend (descended).
    // Wrap chainPromise to convert rejections into a result — otherwise
    // Promise.race propagates the rejection as an exception.
    const outcome = await Promise.race([
      chainPromise.then(
        (result) => ({ kind: 'complete' as const, result }),
        (error) => ({ kind: 'error' as const, error: error as unknown }),
      ),
      argsReady.promise.then((args) => ({ kind: 'need-backend' as const, args })),
    ]);

    if (outcome.kind === 'complete') {
      return { type: 'final', response: outcome.result };
    }
    if (outcome.kind === 'error') {
      const err = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      ctx.abort?.(err);
      return { type: 'final', response: errorResult(err.message) };
    }
    // need-backend: chain is paused at `await backend.promise`. Stash the
    // resolvers so /backend-result can wake it, and return the args the
    // chain descended with (possibly middleware-mutated).
    pendingMcp.set(body.callId, {
      resolveBackend: backend.resolve,
      rejectBackend: backend.reject,
      chainPromise,
    });
    return { type: 'need-backend', args: outcome.args };
  }

  async function handleBackendResult(body: {
    callId: string;
    response?: CallToolResult;
    error?: string;
  }): Promise<{ type: 'final'; response: CallToolResult }> {
    const state = pendingMcp.get(body.callId);
    if (!state) {
      return { type: 'final', response: errorResult(`unknown callId ${body.callId}`) };
    }
    pendingMcp.delete(body.callId);

    if (body.error !== undefined) {
      state.rejectBackend(new Error(body.error));
    } else if (body.response !== undefined) {
      state.resolveBackend(body.response);
    } else {
      state.rejectBackend(new Error('backend-result without response or error'));
    }

    try {
      const result = await state.chainPromise;
      return { type: 'final', response: result };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return { type: 'final', response: errorResult(err.message) };
    }
  }

  // ──────────────────────────── Native tool endpoints (/pre-tool, /post-tool)

  function parseNativePayload(body: any): {
    tool: string; input: unknown; response: unknown;
  } {
    return {
      tool: String(body.tool_name ?? body.tool ?? ''),
      input: body.tool_input ?? body.args ?? body.input ?? {},
      response: body.tool_response ?? body.output ?? body.response ?? null,
    };
  }

  function stringifyResponse(r: unknown): string {
    if (r == null) return '';
    if (typeof r === 'string') return r;
    try { return JSON.stringify(r); } catch { return String(r); }
  }

  let nativeCallSeq = 0;
  function nextNativeCallId(): string {
    nativeCallSeq += 1;
    return `native#${nativeCallSeq}`;
  }

  async function handlePreTool(body: any): Promise<{ block: boolean; message?: string }> {
    const { tool, input } = parseNativePayload(body);
    if (!tool || middlewareWithOnTool.length === 0) return { block: false };

    // Skip MCP tools — /on-tool-use/call already ran the onToolCall chain
    // with the canonical short name + server. Running here too would fire
    // every onToolCall middleware twice per MCP call (once as `native`,
    // once as the real server).
    if (tool.startsWith('mcp__')) return { block: false };

    const ctx = getCtx(body.runId);
    for (const mw of middlewareWithOnTool) {
      try {
        const result = await mw.onToolCall!({
          server: 'native',
          tool,
          input,
          evalName: ctx.evalName,
          config: ctx.config,
          abort: ctx.abort ?? noop,
        });
        if (result !== undefined) {
          const msg = result.content
            ?.filter((c): c is { type: 'text'; text: string } => (c as any).type === 'text')
            .map((c) => c.text)
            .join(' ') ?? 'blocked by middleware';
          return { block: true, message: msg };
        }
      } catch (e) {
        ctx.abort?.(wrapMiddlewareError(mw.name, 'onToolCall', e));
        return { block: true, message: `[${mw.name} failed: ${(e as Error).message}]` };
      }
    }
    return { block: false };
  }

  async function handlePostTool(body: any): Promise<{ ok: true }> {
    const { tool, input, response } = parseNativePayload(body);
    if (!tool) return { ok: true };

    // Skip MCP tools — the wrapper already wrote its own request/result
    // entries to the tool log and fired afterToolCall with the canonical
    // server name. Running here too would produce duplicate tool-log rows
    // (one as `native`, one as the real server) and double-fire every
    // afterToolCall middleware.
    if (tool.startsWith('mcp__')) return { ok: true };

    const ctx = getCtx(body.runId);
    const content = stringifyResponse(response);
    const isError = Boolean(
      response && typeof response === 'object' &&
      ((response as any).is_error || (response as any).error || (response as any).interrupted),
    );
    const callId = nextNativeCallId();

    writeLog(ctx.toolLogPath, {
      kind: 'request', callId, server: 'native', tool, input,
    }, ctx.runId);
    writeLog(ctx.toolLogPath, {
      kind: 'result', callId, server: 'native', tool, isError, content,
      contentBytes: content.length,
    }, ctx.runId);

    await handleAfterToolResponse({
      tool, input, response: content, serverName: 'native', runId: body.runId,
    });

    return { ok: true };
  }

  async function handleAfterToolResponse(body: {
    tool: string;
    input: unknown;
    response: string;
    serverName?: string;
    runId?: string;
  }) {
    const ctx = getCtx(body.runId);

    for (const mw of middlewareWithAfter) {
      try {
        await mw.afterToolCall!({
          server: body.serverName ?? 'native',
          tool: body.tool,
          input: body.input,
          response: body.response,
          evalName: ctx.evalName,
          config: ctx.config,
          abort: ctx.abort ?? noop,
        });
      } catch (e) {
        ctx.abort?.(wrapMiddlewareError(mw.name, 'afterToolCall', e));
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }

    let out: unknown;
    if (req.url === '/on-tool-use/call') {
      out = await handleCall(body);
    } else if (req.url === '/on-tool-use/backend-result') {
      out = await handleBackendResult(body);
    } else if (req.url === '/pre-tool') {
      out = await handlePreTool(body);
    } else if (req.url === '/post-tool') {
      out = await handlePostTool(body);
    } else if (req.url === '/after-tool-response') {
      await handleAfterToolResponse(body);
      out = { ok: true };
    } else {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        registerRun(ctx) { runs.set(ctx.runId, ctx); },
        unregisterRun(runId) { runs.delete(runId); },
        close: () => new Promise<void>((r) => {
          // Reject any outstanding suspended chains so the associated
          // /backend-result handlers unwind instead of hanging forever.
          for (const state of pendingMcp.values()) {
            state.rejectBackend(new Error('middleware server closed'));
          }
          pendingMcp.clear();
          server.close(() => r());
        }),
      });
    });
  });
}
