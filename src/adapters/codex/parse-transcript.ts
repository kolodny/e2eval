/**
 * Parse codex `exec --json` JSONL into a NormalizedTranscript.
 *
 * Event shape (per line):
 *   {type:"thread.started", thread_id:"019db..."}
 *   {type:"turn.started"}
 *   {type:"item.started",  item:{id, type:"mcp_tool_call", server, tool, arguments, result:null, status:"in_progress"}}
 *   {type:"item.completed",item:{id, type:"mcp_tool_call", server, tool, arguments, result:{content:[{type:"text",text:"..."}]}, status:"completed"}}
 *   {type:"item.completed",item:{id, type:"agent_message", text:"..."}}
 *   {type:"turn.completed", usage:{...}}
 *
 * MCP calls are filtered out (our wrapper logs them already). Other item
 * types (e.g. `reasoning`, `agent_message`, future: tool calls that aren't
 * MCP) are treated as native tool calls unless they're pure text output.
 *
 * We concatenate every `agent_message` item's `text` to form the final
 * answer — codex may emit multiple messages in a single turn.
 */
import { readFileSync } from 'node:fs';
import type { NormalizedTranscript, ToolCall } from '../../core/types.js';

type CodexItem = Record<string, any>;

export function parseCodexTranscript(jsonlPath: string): NormalizedTranscript {
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);

  const textChunks: string[] = [];
  const nativeToolCalls: ToolCall[] = [];
  const seenItemIds = new Set<string>();
  // Codex splits tool calls across item.started (has command/arguments)
  // and item.completed (has result/status). Collect started items by id
  // so we can merge them when the completed event arrives.
  const startedItems = new Map<string, CodexItem>();

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'item.started' && entry.item?.id) {
      startedItems.set(entry.item.id, entry.item);
      continue;
    }

    if (entry.type !== 'item.completed') continue;
    const completed: CodexItem | undefined = entry.item;
    if (!completed) continue;

    if (completed.id && seenItemIds.has(completed.id)) continue;
    if (completed.id) seenItemIds.add(completed.id);

    // Merge started + completed for full picture
    const started = completed.id ? startedItems.get(completed.id) : undefined;
    const item = { ...started, ...completed };

    if (item.type === 'agent_message' && typeof item.text === 'string') {
      textChunks.push(item.text);
    } else if (item.type === 'mcp_tool_call') {
      continue;
    } else if (item.type === 'reasoning') {
      continue;
    } else if (typeof item.type === 'string') {
      const input = item.command
        ? { command: item.command }
        : (item.arguments ?? item.input ?? {});
      const resultText = stringifyResult(item.result) ?? String(item.output ?? '');
      nativeToolCalls.push({
        toolUseId: String(item.id ?? `${item.type}-${nativeToolCalls.length}`),
        tool: String(item.tool ?? item.type),
        input,
        resultText,
        resultBytes: resultText.length,
        source: 'native',
        isError: item.status === 'error' || item.error != null,
      });
    }
  }

  const sessionId = extractCodexThreadId(readFileSync(jsonlPath, 'utf8')) ?? undefined;
  return { finalAnswer: textChunks.join(''), nativeToolCalls, sessionId };
}

function stringifyResult(r: unknown): string | null {
  if (r == null) return null;
  if (typeof r === 'string') return r;
  // Codex's mcp_tool_call.result has shape {content:[{type,text}], ...}.
  const content = (r as any).content;
  if (Array.isArray(content)) {
    const parts = content.map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : JSON.stringify(c)));
    return parts.join('\n');
  }
  return JSON.stringify(r);
}

/**
 * Extract the thread id from codex's `exec --json` stdout — the very first
 * line is `{"type":"thread.started","thread_id":"..."}`.
 */
export function extractCodexThreadId(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'thread.started' && typeof e.thread_id === 'string') {
        return e.thread_id;
      }
    } catch { /* ignore */ }
  }
  return null;
}
