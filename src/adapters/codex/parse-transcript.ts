/**
 * Parse codex `exec --json` JSONL into a NormalizedTranscript.
 *
 * Event shape (per line):
 *   {type:"thread.started", thread_id:"019db..."}
 *   {type:"item.completed", item:{type:"agent_message", text:"..."}}
 */
import { readFileSync } from 'node:fs';
import type { NormalizedTranscript } from '../../core/types.js';

export function parseCodexTranscript(jsonlPath: string): NormalizedTranscript {
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);

  const textChunks: string[] = [];
  let sessionId: string | undefined;

  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'thread.started' && typeof entry.thread_id === 'string') {
      sessionId = entry.thread_id;
    } else if (entry.type === 'item.completed' && entry.item?.type === 'agent_message'
      && typeof entry.item.text === 'string') {
      textChunks.push(entry.item.text);
    }
  }

  return { finalAnswer: textChunks.join(''), sessionId };
}
