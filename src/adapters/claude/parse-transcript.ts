/**
 * Parse Claude Code's stream-json transcript into a NormalizedTranscript.
 *
 * Schema (one JSON object per line):
 *   {type:'system', subtype:'init', session_id, ...}
 *   {type:'assistant', message:{role:'assistant', content:[{type:'tool_use',id,name,input}, {type:'text',text}, ...]}}
 *   {type:'user',      message:{role:'user',      content:[{type:'tool_result', tool_use_id, content}, ...]}}
 *   {type:'result',    result:'<final string>'}
 *
 * `nativeToolCalls` is always empty. The PostToolUse hook
 * (`adapters/claude/hooks.mjs`) writes every Claude tool call
 * (native AND MCP) into `$EVAL_TOOL_LOG`, so extracting them here too
 * would just duplicate entries and skew grader counts.
 */
import { readFileSync } from 'node:fs';
import type { NormalizedTranscript } from '../../core/types.js';

export function parseClaudeTranscript(jsonlPath: string): NormalizedTranscript {
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  let finalAnswer = '';
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
      for (const item of content) {
        if (item.type === 'text') finalAnswer = item.text;
      }
    } else if (entry.type === 'result' && typeof entry.result === 'string') {
      if (!finalAnswer) finalAnswer = entry.result;
    }
  }

  return { finalAnswer, nativeToolCalls: [], sessionId };
}
