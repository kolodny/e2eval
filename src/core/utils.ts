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

export function tryParseJson(s: string): unknown {
  const trimmed = s.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    const m = unfenced.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
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

