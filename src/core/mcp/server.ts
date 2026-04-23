#!/usr/bin/env -S tsx
/**
 * MCP wrapper server — agent-agnostic.
 *
 * Sits between an MCP-speaking agent and a real MCP backend, routes every
 * `tools/call` through the middleware chain, and writes a structured tool log
 * (`EVAL_TOOL_LOG`) that captures every request/response pair.
 *
 * The tool log is the grader's authoritative source for MCP traffic — no
 * more dependency on the agent's native transcript format for MCP calls.
 * The agent's transcript contributes only the final answer and any
 * non-MCP (agent-built-in) tool calls.
 *
 * Log schema (one JSON object per line):
 *   {ts, kind: 'request',  callId, server, tool, input}
 *   {ts, kind: 'result',   callId, server, tool, isError, content, contentBytes}
 *   {ts, kind: 'audit',    callId, server, tool, plugin, ...customFields}
 *
 * `callId` is a synthetic monotonic id assigned here — the runner correlates
 * request and result by `callId`. The agent's own tool_use_ids are opaque
 * to us (not all agents expose them) and are intentionally not used.
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

// The middleware server runs in the runner process. We POST to it for onToolCall
// and afterToolCall. No config import here — the middleware server owns all state.
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

    // Log the request BEFORE running the middleware chain — captures what the
    // agent actually asked for. Middleware-mutated args show up as separate
    // audit entries via the middleware's `audit` callback.
    writeLog(TOOL_LOG, {
      kind: 'request',
      callId,
      server: serverName,
      tool,
      input: originalRequest.params.arguments ?? {},
    });

    // Two-phase middleware protocol:
    //   1. Pre-call: middleware inspects tool+args, may short-circuit (skip backend).
    //   2. If proceed: call backend, then post-call: middleware inspects/modifies response.
    let result: CallToolResult;
    if (PLUGIN_SERVER) {
      const pre = await postJson(`${PLUGIN_SERVER}/on-tool-use/pre`, {
        tool,
        args: originalRequest.params.arguments,
        serverName,
        callId,
        runId: RUN_ID,
      });

      if (pre.action === 'respond') {
        result = pre.response as CallToolResult;
      } else {
        const backendResult = (await client.request(originalRequest, z.any(), extra)) as CallToolResult;
        const post = await postJson(`${PLUGIN_SERVER}/on-tool-use/post`, {
          tool,
          args: originalRequest.params.arguments,
          serverName,
          callId,
          runId: RUN_ID,
          response: backendResult,
        });
        result = (post.response as CallToolResult) ?? backendResult;
      }
    } else {
      result = (await client.request(originalRequest, z.any(), extra)) as CallToolResult;
    }

    // Log the result the agent actually sees — post-middleware-chain, so scrubbed
    // responses are recorded as scrubbed. This is the grader's evidence.
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
