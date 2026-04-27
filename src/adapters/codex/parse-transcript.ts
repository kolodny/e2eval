/**
 * Parse codex's `--json` JSONL output into a NormalizedTranscript.
 *
 * Schema (one JSON object per line):
 *   {type:'thread.started', thread_id}
 *   {type:'turn.started'}
 *   {type:'item.completed', item:{id, type:'agent_message', text}}
 *   {type:'item.completed', item:{id, type:'agent_reasoning', text}}
 *   {type:'item.completed', item:{type:'function_call', ...}}
 *   {type:'turn.completed', usage:{...}}
 *   {type:'error', message}
 *
 * The final answer is the last `agent_message` item's text. `thread_id`
 * from the first `thread.started` event populates `sessionId`.
 */
import type { NormalizedTranscript } from '../../core/types.js';

export function parseCodexTranscript(streamJson: string): NormalizedTranscript {
  const lines = streamJson.split('\n').filter(Boolean);
  let answer = '';
  let sessionId: string | undefined;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type === 'thread.started' && typeof entry.thread_id === 'string' && !sessionId) {
      sessionId = entry.thread_id;
    } else if (entry?.type === 'item.completed') {
      const item = entry.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        // Last agent_message wins. Codex sometimes emits intermediate
        // messages followed by a final summary; we take the latest.
        answer = item.text;
      }
    }
  }

  return { answer, sessionId };
}
