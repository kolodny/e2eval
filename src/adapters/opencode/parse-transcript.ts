/**
 * Parse opencode `--format json` JSONL into a NormalizedTranscript.
 *
 * Event shape (per line):
 *   {type:'step_start', sessionID, part:{...}}
 *   {type:'text',       sessionID, part:{type:'text', text:'...'}}
 *   {type:'step_finish', sessionID, part:{...}}
 *
 * Opencode may stream multiple `text` parts for a single answer, so we
 * concatenate them.
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

  return { finalAnswer: textChunks.join(''), sessionId };
}
