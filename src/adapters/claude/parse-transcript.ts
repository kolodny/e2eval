/**
 * Parse Claude Code's stream-json output into a NormalizedTranscript.
 *
 * Schema (one JSON object per line):
 *   {type:'system', subtype:'init', session_id, ...}
 *   {type:'assistant', message:{role:'assistant', content:[{type:'text',text}, ...]}}
 *   {type:'result',    result:'<final string>'}
 */
import type { NormalizedTranscript } from '../../core/types.js';

export function parseClaudeTranscript(streamJson: string): NormalizedTranscript {
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

    if (entry.type === 'system' && entry.subtype === 'init' && entry.session_id) {
      sessionId = entry.session_id;
    } else if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      // A single assistant message can carry multiple `text` blocks when
      // the model interleaves prose with `tool_use` items. Joining preserves
      // the full answer; the outer loop overwrites across messages, so the
      // last message wins.
      const texts = content
        .filter((item: any) => item.type === 'text' && typeof item.text === 'string')
        .map((item: any) => item.text as string);
      if (texts.length > 0) answer = texts.join('');
    } else if (entry.type === 'result' && typeof entry.result === 'string') {
      if (!answer) answer = entry.result;
    }
  }

  return { answer, sessionId };
}
