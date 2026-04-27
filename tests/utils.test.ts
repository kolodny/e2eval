/**
 * Unit tests for `e2eval/utils` helpers exposed to middleware authors.
 *
 * `tryParseJson` is the only one with non-trivial logic (depth-aware
 * brace scanning, quoted-string awareness, prose-then-JSON last-block
 * preference). `escapeXml` / `normaliseForMatch` /
 * `longestCommonSubstringRatio` are tiny enough that their behavior is
 * obvious from one example each — included for coverage.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  tryParseJson,
  escapeXml,
  normaliseForMatch,
  longestCommonSubstringRatio,
} from '../src/index.js';

// ────────────────────────────────────────────────────────────── tryParseJson

test('tryParseJson: pure JSON parses directly', () => {
  assert.deepEqual(tryParseJson('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
});

test('tryParseJson: leading/trailing whitespace is tolerated', () => {
  assert.deepEqual(tryParseJson('   \n  {"x":true}\n   '), { x: true });
});

test('tryParseJson: ```json fence is stripped', () => {
  assert.deepEqual(tryParseJson('```json\n{"verdict":"correct"}\n```'), { verdict: 'correct' });
});

test('tryParseJson: bare ``` fence (no language) is stripped', () => {
  assert.deepEqual(tryParseJson('```\n{"x":1}\n```'), { x: 1 });
});

test('tryParseJson: prose before, JSON after — last balanced block wins', () => {
  const s = `Here's my reasoning: the answer matches expected.

{"verdict":"correct","reasoning":"matches"}`;
  assert.deepEqual(tryParseJson(s), { verdict: 'correct', reasoning: 'matches' });
});

test('tryParseJson: multiple JSON blocks — last one wins (graders put answer last)', () => {
  // Both blocks are valid JSON; the LAST one is the grader's actual verdict.
  const s = `Considering: {"option":"A"}. Considering: {"option":"B"}. Final: {"verdict":"B"}.`;
  assert.deepEqual(tryParseJson(s), { verdict: 'B' });
});

test('tryParseJson: pure-JSON nested object — whole-string parse succeeds first', () => {
  // Without prose noise, the initial `JSON.parse(trimmed)` happy-path
  // catches it before the brace scanner runs.
  assert.deepEqual(
    tryParseJson('{"outer":{"inner":{"deep":true}}}'),
    { outer: { inner: { deep: true } } },
  );
});

test('tryParseJson: nested object inside prose — innermost wins (last-block-first scan)', () => {
  // The brace scanner pushes a block at every `{` it finds. With nested
  // objects, that's outer + inner + deepest, all valid JSON. Tried
  // last-to-first, the deepest block parses first and wins. This is the
  // intended bias for grader output ("explain-then-{verdict}"); it just
  // means tryParseJson is a poor fit for legitimately nested JSON
  // embedded in prose.
  assert.deepEqual(
    tryParseJson('Result: {"outer":{"inner":{"deep":true}}}'),
    { deep: true },
  );
});

test('tryParseJson: braces inside strings do NOT confuse depth counting', () => {
  // The `}` inside the string would prematurely close the object if
  // the scanner didn't track string state.
  const s = 'noise {"text":"contains } and { brace chars","ok":true} more noise';
  assert.deepEqual(tryParseJson(s), { text: 'contains } and { brace chars', ok: true });
});

test('tryParseJson: escaped quotes inside strings handled', () => {
  // Escape \" must not flip the in-string flag off.
  const s = 'pre {"q":"she said \\"hi\\" to me"} post';
  assert.deepEqual(tryParseJson(s), { q: 'she said "hi" to me' });
});

test('tryParseJson: returns null when nothing parses', () => {
  assert.equal(tryParseJson('not even close'), null);
  assert.equal(tryParseJson(''), null);
  assert.equal(tryParseJson('{ broken'), null);
});

test('tryParseJson: skips a malformed earlier block to find a valid later one', () => {
  // First brace block is broken JSON (trailing comma); the second is valid.
  const s = '{"oops": 1,} ... reasoning ... {"verdict":"correct"}';
  assert.deepEqual(tryParseJson(s), { verdict: 'correct' });
});

test('tryParseJson: standalone object with internal arrays', () => {
  assert.deepEqual(
    tryParseJson('{"evidence":["a","b","c"],"verdict":"x"}'),
    { evidence: ['a', 'b', 'c'], verdict: 'x' },
  );
});

test('tryParseJson: a JSON array at top level is NOT extracted (function targets {} blocks)', () => {
  // The whole-string parse succeeds for a top-level array, so this round-trips.
  assert.deepEqual(tryParseJson('[1,2,3]'), [1, 2, 3]);
});

test('tryParseJson: a JSON array inside prose — the function only scans for `{`, not `[`, so an array-only payload returns null', () => {
  // Documenting the current behavior. If we ever extend it to scan for
  // top-level `[…]` too, update this test.
  assert.equal(tryParseJson('here you go: [1,2,3] enjoy'), null);
});

// ────────────────────────────────────────────────────────────── escapeXml

test('escapeXml: replaces &, <, >', () => {
  assert.equal(escapeXml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('escapeXml: empty string passes through', () => {
  assert.equal(escapeXml(''), '');
});

test('escapeXml: ampersand replaced first (no double-encoding)', () => {
  // If `&` were replaced after `<`, `<` would become `&amp;lt;` not `&lt;`.
  assert.equal(escapeXml('<&>'), '&lt;&amp;&gt;');
});

// ────────────────────────────────────────────────────────────── normaliseForMatch

test('normaliseForMatch: lowercases, collapses whitespace, unescapes common sequences', () => {
  assert.equal(
    normaliseForMatch('Hello\\nWorld\\t\\"quoted\\"   spaces'),
    'hello world "quoted" spaces',
  );
});

test('normaliseForMatch: backslash escape unescaped', () => {
  assert.equal(normaliseForMatch('a\\\\b'), 'a\\b');
});

// ────────────────────────────────────────────────────────────── longestCommonSubstringRatio

test('longestCommonSubstringRatio: full match → 1', () => {
  assert.equal(longestCommonSubstringRatio('abc', 'xxxabcxxx'), 1);
});

test('longestCommonSubstringRatio: no match → 0', () => {
  assert.equal(longestCommonSubstringRatio('zzz', 'abcdef'), 0);
});

test('longestCommonSubstringRatio: partial match → ratio of longest substring length to needle length', () => {
  // "abcd" in "xxabcxxx" → longest common substring is "abc" (3 chars), needle is 4 → 0.75.
  assert.equal(longestCommonSubstringRatio('abcd', 'xxabcxxx'), 0.75);
});

test('longestCommonSubstringRatio: empty inputs → 0', () => {
  assert.equal(longestCommonSubstringRatio('', 'anything'), 0);
  assert.equal(longestCommonSubstringRatio('anything', ''), 0);
});
