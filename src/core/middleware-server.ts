/**
 * In-process HTTP server — the single home for all eval middleware. Starts
 * once per runner, shared across concurrent eval runs. Each run registers
 * its context by runId; every inbound request includes the runId so the
 * server routes to the correct context.
 *
 * Endpoints (two-phase protocol for onToolCall):
 *
 *   POST /on-tool-use/pre   { tool, args, serverName, callId, runId }
 *   POST /on-tool-use/post  { tool, args, serverName, callId, runId, response }
 *   POST /pre-tool          { ..., runId }
 *   POST /post-tool         { ..., runId }
 *   POST /after-tool-response { tool, input, response, serverName, runId }
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

export type RunContext = {
  evalName: string;
  config: Readonly<Config>;
  toolLogPath: string;
  runId: string;
  abort?: (reason?: string) => void;
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

export async function startMiddlewareServer(
  middleware: readonly Middleware[],
): Promise<MiddlewareServer> {
  const middlewareWithOnTool = middleware.filter((h) => h.onToolCall);
  const middlewareWithAfter = middleware.filter((h) => h.afterToolCall);

  const runs = new Map<string, RunContext>();

  function getCtx(runId: string | undefined): RunContext {
    if (runId && runs.has(runId)) return runs.get(runId)!;
    return EMPTY_CTX;
  }

  const noop = () => {};

  const NEEDS_BACKEND = Symbol('needs_backend');

  async function handlePreCall(body: {
    tool: string;
    args: unknown;
    serverName: string;
    callId: string;
    runId?: string;
  }): Promise<{ action: 'proceed' } | { action: 'respond'; response: CallToolResult }> {
    if (middlewareWithOnTool.length === 0) return { action: 'proceed' };
    const ctx = getCtx(body.runId);

    for (const mw of middlewareWithOnTool) {
      let handlerWasCalled = false;
      const handler = async (_args: unknown) => {
        handlerWasCalled = true;
        return NEEDS_BACKEND as unknown as CallToolResult;
      };

      try {
        const result = await mw.onToolCall!({
          server: body.serverName,
          tool: body.tool,
          input: body.args,
          handler,
          evalName: ctx.evalName,
          config: ctx.config,
          abort: ctx.abort ?? noop,
        });

        if (handlerWasCalled) return { action: 'proceed' };
        if (result !== undefined) return { action: 'respond', response: result };
      } catch (e) {
        return {
          action: 'respond',
          response: {
            content: [{ type: 'text' as const, text: `[${mw.name} failed: ${(e as Error).message}]` }],
            isError: true,
          },
        };
      }
    }

    return { action: 'proceed' };
  }

  async function handlePostCall(body: {
    tool: string;
    args: unknown;
    serverName: string;
    callId: string;
    runId?: string;
    response: CallToolResult;
  }): Promise<{ response: CallToolResult }> {
    if (middlewareWithOnTool.length === 0) return { response: body.response };
    const ctx = getCtx(body.runId);
    let currentResponse = body.response;

    for (const mw of middlewareWithOnTool) {
      const handler = async (_args: unknown): Promise<CallToolResult> => currentResponse;

      try {
        const result = await mw.onToolCall!({
          server: body.serverName,
          tool: body.tool,
          input: body.args,
          handler,
          evalName: ctx.evalName,
          config: ctx.config,
          abort: ctx.abort ?? noop,
        });
        if (result !== undefined) currentResponse = result;
      } catch (e) {
        currentResponse = {
          content: [{ type: 'text' as const, text: `[${mw.name} failed: ${(e as Error).message}]` }],
          isError: true,
        };
      }
    }

    return { response: currentResponse };
  }

  // ──────────────────────────── Native tool endpoints (/pre-tool, /post-tool)

  function parseNativePayload(body: any): {
    tool: string; input: unknown; response: unknown; pluginType: string;
  } {
    return {
      tool: String(body.tool_name ?? body.tool ?? ''),
      input: body.tool_input ?? body.args ?? body.input ?? {},
      response: body.tool_response ?? body.output ?? body.response ?? null,
      pluginType: body.plugin_type ?? body.pluginType ?? 'post',
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
        return { block: true, message: `[${mw.name} failed: ${(e as Error).message}]` };
      }
    }
    return { block: false };
  }

  async function handlePostTool(body: any): Promise<{ ok: true }> {
    const { tool, input, response } = parseNativePayload(body);
    if (!tool) return { ok: true };

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
      } catch {
        // swallow — middleware is responsible for its own error handling
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
    if (req.url === '/on-tool-use/pre') {
      out = await handlePreCall(body);
    } else if (req.url === '/on-tool-use/post') {
      out = await handlePostCall(body);
    } else if (req.url === '/pre-tool') {
      out = handlePreTool(body);
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
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
