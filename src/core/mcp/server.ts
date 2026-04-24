#!/usr/bin/env node
/**
 * MCP wrapper server — agent-agnostic. Sits between an MCP-speaking agent
 * and a real MCP backend, routes every `tools/call` through the middleware
 * chain, and writes a structured tool log (`EVAL_TOOL_LOG`).
 *
 * Log schema (one JSON object per line):
 *   {ts, kind: 'request',  callId, server, tool, input}
 *   {ts, kind: 'result',   callId, server, tool, isError, content, contentBytes}
 *   {ts, kind: 'audit',    callId, server, tool, plugin, ...customFields}
 *
 * `callId` is a synthetic monotonic id — the runner correlates request and
 * result by it. Agent tool_use_ids aren't used (not all agents expose them).
 */
import { mcpMiddleware } from 'mcp-middleware';
import { StdioClientTransport as Stdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport as HTTP } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Command } from 'commander';
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';

import type { Config } from '../types.js';

const PLUGIN_SERVER = process.env.EVAL_PLUGIN_SERVER ?? '';

function postJson(urlStr: string, body: unknown): Promise<any> {
  const data = JSON.stringify(body);
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve({});
        }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const program = new Command()
  .requiredOption('--type <type>', 'stdio | http')
  .requiredOption('--name <name>', 'server identifier included in log entries')
  .argument('<target>', 'command (stdio) or URL (http)')
  .argument('[args...]', 'extra args for stdio command')
  .parse();

const { type, name: serverName } = program.opts<{ type: string; name: string }>();
const [target, ...args] = program.args;

const makeTransport = () => {
  if (type === 'stdio') return new Stdio({ command: target, args });
  if (type === 'http') return new HTTP(new URL(target));
  throw new Error(`unknown --type=${type}`);
};

const CONFIG_PATH = process.env.EVAL_CONFIG ?? '';
const config: Config = (() => {
  if (!CONFIG_PATH) return {} as Config;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return {} as Config;
  }
})();

const TOOL_LOG = process.env.EVAL_TOOL_LOG ?? '';
// Per-run correlation id. Every log entry carries it so the runner can
// sanity-check that nothing leaked in from another run. Empty if the
// runner didn't set one (e.g. someone runs server.ts standalone).
const RUN_ID = process.env.EVAL_RUN_ID ?? '';

let callSeq = 0;
function nextCallId(): string {
  callSeq += 1;
  // Include serverName so IDs are unique across concurrently-spawned wrappers.
  return `${serverName}#${callSeq}`;
}

function writeLog(path: string, entry: Record<string, unknown>): void {
  if (!path) return;
  try {
    appendFileSync(
      path,
      JSON.stringify({ ts: Date.now(), runId: RUN_ID, ...entry }) + '\n',
    );
  } catch {
    /* best-effort */
  }
}

const { connect } = await mcpMiddleware({
  makeTransport,
  requestHandler: async (req, extra, client) => {
    const parsed = CallToolRequestSchema.safeParse(req);
    if (!parsed.success) {
      // Non-tool call (initialize, list_tools, etc.).
      writeLog(TOOL_LOG, {
        kind: 'request',
        callId: 'protocol',
        server: serverName,
        tool: (req as any).method ?? '?',
        input: {},
      });
      const response = await client.request(req, z.any(), extra);

      // Strip outputSchema from list_tools responses. Some agents (opencode)
      // strictly validate tool results against the declared schema and reject
      // responses with extra properties. Stripping the schema makes validation
      // a no-op while keeping the tool definitions intact.
      if ((req as any).method === 'tools/list' && response && typeof response === 'object') {
        const r = response as any;
        if (Array.isArray(r.tools)) {
          for (const tool of r.tools) {
            delete tool.outputSchema;
          }
          writeLog(TOOL_LOG, {
            kind: 'audit',
            callId: 'list_tools',
            server: serverName,
            tool: '*',
            plugin: 'strip-output-schema',
            toolCount: r.tools.length,
          });
        }
      }

      return response;
    }

    const originalRequest = parsed.data;
    const tool = originalRequest.params.name;
    const callId = nextCallId();

    // Log the request before the middleware chain runs, so mutated args
    // don't overwrite what the agent actually asked for.
    writeLog(TOOL_LOG, {
      kind: 'request',
      callId,
      server: serverName,
      tool,
      input: originalRequest.params.arguments ?? {},
    });

    // Single-fire middleware protocol: the server runs the Koa-style chain
    // once, either short-circuits with a final response or asks us to run
    // the backend with the (possibly middleware-mutated) args and echoes
    // the result back for the chain to unwind and transform.
    let result: CallToolResult;
    if (PLUGIN_SERVER) {
      const call = await postJson(`${PLUGIN_SERVER}/on-tool-use/call`, {
        tool,
        args: originalRequest.params.arguments,
        serverName,
        callId,
        runId: RUN_ID,
      });

      if (call?.type === 'final') {
        result = call.response as CallToolResult;
      } else if (call?.type === 'need-backend') {
        let backendResponse: CallToolResult | undefined;
        let backendError: string | undefined;
        try {
          // Middleware may have mutated the args before calling handler(),
          // so hit the backend with what the chain descended with.
          const backendRequest = {
            ...originalRequest,
            params: {
              ...originalRequest.params,
              arguments: call.args as Record<string, unknown>,
            },
          };
          backendResponse = (await client.request(backendRequest, z.any(), extra)) as CallToolResult;
        } catch (e) {
          backendError = e instanceof Error ? e.message : String(e);
        }

        const finalReply = await postJson(`${PLUGIN_SERVER}/on-tool-use/backend-result`, {
          callId,
          runId: RUN_ID,
          ...(backendError !== undefined ? { error: backendError } : { response: backendResponse }),
        });
        result = (finalReply?.response as CallToolResult) ?? {
          content: [{ type: 'text' as const, text: backendError ?? 'middleware server returned no response' }],
          isError: true,
        };
      } else {
        result = {
          content: [{ type: 'text' as const, text: `unexpected middleware-server response: ${JSON.stringify(call)}` }],
          isError: true,
        };
      }
    } else {
      result = (await client.request(originalRequest, z.any(), extra)) as CallToolResult;
    }

    // Log the result after the middleware chain, so scrubbed responses
    // are recorded as the agent saw them.
    const content = JSON.stringify(result.content ?? []);
    writeLog(TOOL_LOG, {
      kind: 'result',
      callId,
      server: serverName,
      tool,
      isError: !!result.isError,
      content,
      contentBytes: content.length,
    });

    // afterToolCall: fire-and-forget POST so detection plugins run.
    if (PLUGIN_SERVER) {
      postJson(`${PLUGIN_SERVER}/after-tool-response`, {
        tool,
        input: originalRequest.params.arguments,
        response: content,
        serverName,
        runId: RUN_ID,
      }).catch(() => {});
    }

    return result;
  },
});

await connect();
