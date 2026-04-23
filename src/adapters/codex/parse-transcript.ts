/**
 * Parse codex `exec --json` JSONL into a NormalizedTranscript.
 *
 * Event shape (per line):
 *   {type:"thread.started", thread_id:"019db..."}
 *   {type:"turn.started"}
 *   {type:"item.completed", item:{type:"agent_message", text:"..."}}
 *   {type:"turn.completed", usage:{...}}
 *
 * We only care about two things from the transcript: the final answer
 * (concatenated `agent_message` text) and the session id (for `callLLM`
 * resume). Every tool call — MCP and native — is already in the tool log
 * via the MCP wrapper and the PreToolUse/PostToolUse hooks, so
 * `nativeToolCalls` is always empty (extracting them here would just
 * duplicate log entries).
 */
import { readFileSync } from 'node:fs';
import type { NormalizedTranscript } from '../../core/types.js';

export function parseCodexTranscript(jsonlPath: string): NormalizedTranscript {
  const src = readFileSync(jsonlPath, 'utf8');
  const lines = src.split('\n').filter(Boolean);

  const textChunks: string[] = [];
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'item.completed') continue;
    const item = entry.item;
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      textChunks.push(item.text);
    }
  }

  return {
    finalAnswer: textChunks.join(''),
    nativeToolCalls: [],
    sessionId: extractCodexThreadId(src) ?? undefined,
  };
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
