/**
 * Reads the wrapper's tool log into `ToolCall[]`.
 *
 * The log has three kinds of entries:
 *   - `request` — what the agent asked for (tool name + input)
 *   - `result`  — what we returned (post-middleware-chain content, isError flag)
 *   - `audit`   — middleware-originated structured notes
 *
 * We correlate request + result by `callId` (synthetic monotonic per server
 * assigned in `server.ts`). Audit entries are ignored here; the runner
 * surfaces them separately via the audit file.
 *
 * A request without a matching result means the agent triggered a call that
 * was aborted (e.g. short-circuited exception) — we emit those too, with
 * empty resultText, so they're visible to the grader.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { ToolCall } from '../types.js';

type Entry =
  | { kind: 'request'; ts: number; callId: string; server: string; tool: string; input: unknown }
  | { kind: 'result'; ts: number; callId: string; server: string; tool: string; isError: boolean; content: string; contentBytes: number }
  | { kind: 'audit'; ts: number; callId: string; server: string; tool: string; plugin: string; [k: string]: unknown };

export function readMcpToolLog(path: string): ToolCall[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);

  const requests = new Map<string, Entry & { kind: 'request' }>();
  const results = new Map<string, Entry & { kind: 'result' }>();

  for (const line of lines) {
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (e.kind === 'request') requests.set(e.callId, e);
    else if (e.kind === 'result') results.set(e.callId, e);
  }

  const out: ToolCall[] = [];
  for (const [callId, req] of requests) {
    const res = results.get(callId);
    const resultText = res ? decodeContent(res.content) : '';
    const isNative = req.server === 'native';
    out.push({
      toolUseId: callId,
      ...(isNative ? {} : { server: req.server }),
      tool: req.tool,
      input: req.input,
      resultText,
      resultBytes: resultText.length,
      source: isNative ? 'native' : 'mcp',
      isError: res?.isError,
    });
  }
  return out;
}

/**
 * `result.content` is stored as a JSON-stringified array of content items
 * (the MCP shape). Unpack into the flat text the grader wants. If items
 * aren't text (image, resource), stringify them — better to have something
 * grabbable than nothing.
 */
function decodeContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;
    return parsed
      .map((item: unknown) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const o = item as { type?: string; text?: string };
          if (o.type === 'text' && typeof o.text === 'string') return o.text;
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join('\n');
  } catch {
    return raw;
  }
}
