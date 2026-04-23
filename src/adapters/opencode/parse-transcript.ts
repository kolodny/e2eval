/**
 * Parse opencode `--format json` JSONL into a NormalizedTranscript.
 *
 * Event shape (per line):
 *   {type:'step_start', sessionID, part:{...}}
 *   {type:'text',       sessionID, part:{type:'text', text:'...'}}
 *   {type:'tool_use',   sessionID, part:{type:'tool', tool:'<name>', ...}}
 *   {type:'step_finish', sessionID, part:{...}}
 *
 * We concatenate all `text` parts for the final answer (opencode may stream
 * multiple chunks for a single logical answer).
 *
 * `nativeToolCalls` is always empty. The opencode hooks adapter
 * (`adapters/opencode/hooks.mjs`) logs every opencode tool call (native
 * AND MCP) into `$EVAL_TOOL_LOG` via the `tool.execute.after` event, so
 * extracting them here too would just duplicate entries.
 */
import { readFileSync } from 'node:fs';
import type { NormalizedTranscript } from '../../core/types.js';

export function parseOpencodeTranscript(jsonlPath: string): NormalizedTranscript {
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  const textChunks: string[] = [];
  let sessionId: string | undefined;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessionId && entry.sessionID) sessionId = entry.sessionID;
    const part = entry.part;
    if (part?.type === 'text' && typeof part.text === 'string') {
      textChunks.push(part.text);
    }
  }

  return { finalAnswer: textChunks.join(''), nativeToolCalls: [], sessionId };
}
