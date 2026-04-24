/**
 * Shared utilities for plugins.
 *
 * Pure functions used by two or more plugins. Plugin-specific logic
 * (prompts, response parsing, domain types) lives in the middleware itself.
 */
export type { CallLLM } from './types.js';

// ────────────────────────────────────────────────────────────── Text

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Best-effort JSON extractor for LLM grader responses. Tries, in order:
 *
 *   1. Parse the whole string (with ```json``` fencing stripped).
 *   2. Scan for every top-level balanced `{...}` block, respecting string
 *      quoting so JSON-internal `{` / `}` don't confuse depth counting.
 *   3. Try the blocks from last to first — graders almost always put the
 *      answer *after* their reasoning prose.
 *
 * Returns the first successful parse, or `null` if nothing parses.
 */
export function tryParseJson(s: string): unknown {
  const trimmed = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  const blocks: string[] = [];
  const n = trimmed.length;
  for (let i = 0; i < n; i++) {
    if (trimmed[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < n; j++) {
      const c = trimmed[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { blocks.push(trimmed.slice(i, j + 1)); break; }
      }
    }
  }

  for (let k = blocks.length - 1; k >= 0; k--) {
    try { return JSON.parse(blocks[k]); } catch { /* try earlier */ }
  }
  return null;
}

export function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\s+/g, ' ').trim();
}

export function longestCommonSubstringRatio(needle: string, haystack: string): number {
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) return 1;
  let longest = 0;
  for (let i = 0; i < needle.length; i++) {
    for (let j = i + longest + 1; j <= needle.length; j++) {
      const sub = needle.slice(i, j);
      if (haystack.includes(sub)) { if (sub.length > longest) longest = sub.length; }
      else break;
    }
  }
  return longest / needle.length;
}

