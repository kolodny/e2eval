/**
 * Parse OpenCode's `--format json` JSONL output into a NormalizedTranscript.
 *
 * Schema (one JSON object per line):
 *   {type:'step_start', sessionID, part:{messageID, ...}}
 *   {type:'text', sessionID, part:{text, ...}}
 *   {type:'tool', sessionID, part:{...}}        — tool calls; we ignore for answer
 *   {type:'step_finish', sessionID, part:{reason, tokens, ...}}
 *
 * Different opencode versions have emitted slightly different envelopes;
 * we accept any line with a `text` field nested under `part` and pull
 * the LAST one in the stream as the final answer. `sessionID` from any
 * line populates the session id.
 */
import type { NormalizedTranscript } from '../../core/types.js';

export function parseOpencodeTranscript(streamJson: string): NormalizedTranscript {
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

    if (typeof entry.sessionID === 'string' && !sessionId) {
      sessionId = entry.sessionID;
    }

    // Concatenate all text parts in source order — opencode emits one
    // `text` event per chunk, and the final assistant answer is the
    // concatenation of every `text` part in the latest step. Using
    // "last text" alone would lose multi-chunk replies.
    const part = entry?.part;
    if (entry?.type === 'text' && part && typeof part.text === 'string') {
      answer = answer ? `${answer}${part.text}` : part.text;
    }
  }

  return { answer, sessionId };
}
