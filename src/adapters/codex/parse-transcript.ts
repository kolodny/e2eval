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
 * from the first `thread.started` event populates `sessionId`. Feed
 * each JSONL line to `feed()` as it arrives, then `finalize()` to read
 * out `{answer, sessionId}`.
 */
import type { NormalizedTranscript } from '../../core/types.js';

export type StreamingCodexParser = {
  feed(line: string): void;
  finalize(): NormalizedTranscript;
};

export function createStreamingCodexParser(): StreamingCodexParser {
  let answer = '';
  let sessionId: string | undefined;

  return {
    feed(line: string) {
      let entry: any;
      try { entry = JSON.parse(line); } catch { return; }

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
    },

    finalize(): NormalizedTranscript {
      return { answer, sessionId };
    },
  };
}
