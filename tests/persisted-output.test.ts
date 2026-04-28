/**
 * Unit tests for the claude `<persisted-output>` dereferencer — the
 * adapter-internal hook that lets middleware operate on a tool's
 * actual content even when claude has spooled it to disk and is
 * passing only a pointer over the wire.
 *
 * Two on-disk formats:
 *   - Bash: raw text in `<random>.txt`
 *   - MCP:  JSON-serialized content blocks in `<tool_use_id>.json`
 *
 * No real claude here. Real-claude integration is exercised separately
 * via probe-large.ts; this file just pins the deref/scrub/write logic.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistedOutputDereferencer } from '../src/adapters/claude/proxy.js';
import type { ToolResult } from '../src/index.js';

function persistedEnvelope(filePath: string, sizeKB: string, preview: string): string {
  return [
    '<persisted-output>',
    `Output too large (${sizeKB}KB). Full output saved to: ${filePath}`,
    '',
    'Preview (first 2KB):',
    preview,
    '...',
    '</persisted-output>',
  ].join('\n');
}

function wireResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

// ────────────────────────────────────────────────────────────── detect

test('detect: Bash-shaped wrapper → text-kind pointer', () => {
  const tr = wireResult(persistedEnvelope('/tmp/foo/abc.txt', '48.8', 'preview-text'));
  const result = persistedOutputDereferencer.detect(tr);
  assert.deepEqual(result, { path: '/tmp/foo/abc.txt', kind: 'text' });
});

test('detect: MCP-shaped wrapper (.json) → json-kind pointer', () => {
  const tr = wireResult(persistedEnvelope('/tmp/foo/toolu_xyz.json', '488.3', 'json-preview'));
  const result = persistedOutputDereferencer.detect(tr);
  assert.deepEqual(result, { path: '/tmp/foo/toolu_xyz.json', kind: 'json' });
});

test('detect: non-pointer text → null', () => {
  const tr = wireResult('just a regular tool output, nothing spooled');
  assert.equal(persistedOutputDereferencer.detect(tr), null);
});

test('detect: multi-block content → null (only single-text-block matches)', () => {
  const tr: ToolResult = {
    content: [
      { type: 'text', text: persistedEnvelope('/tmp/x.txt', '10', 'p') },
      { type: 'text', text: 'extra' },
    ],
  };
  assert.equal(persistedOutputDereferencer.detect(tr), null);
});

// ────────────────────────────────────────────────────────────── rewriteWire

test('rewriteWire: strips the Preview block, keeps path + tags', () => {
  const text = persistedEnvelope('/tmp/foo.txt', '48.8', 'leak-this-preview-text');
  const tr = wireResult(text);
  const out = persistedOutputDereferencer.rewriteWire({ path: '/tmp/foo.txt', kind: 'text' }, tr);
  const stripped = (out.content[0] as { text: string }).text;
  assert.match(stripped, /<persisted-output>/);
  assert.match(stripped, /Full output saved to: \/tmp\/foo\.txt/);
  assert.match(stripped, /<\/persisted-output>$/);
  // The unredacted preview must be gone.
  assert.equal(stripped.includes('leak-this-preview-text'), false);
  assert.equal(stripped.includes('Preview (first'), false);
});

test('rewriteWire: passes through unchanged if no Preview block', () => {
  const text = '<persisted-output>\nOutput too large. Full output saved to: /tmp/x.txt\n</persisted-output>';
  const tr = wireResult(text);
  const out = persistedOutputDereferencer.rewriteWire({ path: '/tmp/x.txt', kind: 'text' }, tr);
  assert.equal((out.content[0] as { text: string }).text, text);
});

// ────────────────────────────────────────────────────────────── read + write round-trip

test('read+write: text format — full file content visible to middleware; mutation lands back on disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2eval-deref-'));
  try {
    const file = path.join(dir, 'spooled.txt');
    const original = 'STUFF before SECRET_TOKEN=abc123 STUFF after\n'.repeat(2000); // ~88KB
    await writeFile(file, original, 'utf8');

    const pointer = { path: file, kind: 'text' as const };

    // Middleware sees full file content as a single text block.
    const real = await persistedOutputDereferencer.read(pointer);
    assert.equal(real.content.length, 1);
    assert.equal(real.content[0].type, 'text');
    const seen = (real.content[0] as { text: string }).text;
    assert.equal(seen, original);
    assert.match(seen, /SECRET_TOKEN=abc123/);

    // Scrub and write back.
    const scrubbed = seen.replaceAll(/SECRET_TOKEN=\w+/g, '[REDACTED]');
    await persistedOutputDereferencer.write(pointer, {
      content: [{ type: 'text', text: scrubbed }],
    });

    // On-disk file is now scrubbed — the agent's next Read sees this.
    const onDisk = await readFile(file, 'utf8');
    assert.equal(onDisk.includes('SECRET_TOKEN'), false);
    assert.match(onDisk, /\[REDACTED\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read+write: json format (MCP) — content blocks visible to middleware; scrubbed blocks written back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2eval-deref-'));
  try {
    const file = path.join(dir, 'toolu_abc.json');
    const blocks = [
      { type: 'text', text: 'first chunk with SECRET_TOKEN=zzz inside' },
      { type: 'text', text: 'second chunk: more SECRET_TOKEN=qqq data' },
    ];
    await writeFile(file, JSON.stringify(blocks), 'utf8');

    const pointer = { path: file, kind: 'json' as const };

    // Middleware sees the original content array — same shape it would
    // have seen if not spooled.
    const real = await persistedOutputDereferencer.read(pointer);
    assert.equal(real.content.length, 2);
    assert.equal(real.content[0].type, 'text');
    assert.match((real.content[0] as { text: string }).text, /SECRET_TOKEN=zzz/);

    // Scrub each block and write back.
    const scrubbed = real.content.map((b) =>
      b.type === 'text'
        ? { type: 'text', text: (b as { text: string }).text.replaceAll(/SECRET_TOKEN=\w+/g, '[REDACTED]') }
        : b,
    );
    await persistedOutputDereferencer.write(pointer, { content: scrubbed });

    // On-disk file is JSON-serialized scrubbed blocks.
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(Array.isArray(onDisk), true);
    assert.equal(onDisk.length, 2);
    assert.equal(onDisk[0].text.includes('SECRET_TOKEN'), false);
    assert.match(onDisk[0].text, /\[REDACTED\]/);
    assert.match(onDisk[1].text, /\[REDACTED\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read: malformed JSON in .json file falls back to wrapping as text', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2eval-deref-'));
  try {
    const file = path.join(dir, 'broken.json');
    await writeFile(file, 'not valid {{ json', 'utf8');

    const real = await persistedOutputDereferencer.read({ path: file, kind: 'json' });
    assert.equal(real.content.length, 1);
    assert.equal(real.content[0].type, 'text');
    assert.equal((real.content[0] as { text: string }).text, 'not valid {{ json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
