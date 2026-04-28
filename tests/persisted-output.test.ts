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
import { startChain } from '../src/core/proxy/middleware.js';
import type { Middleware, ToolResult } from '../src/index.js';

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

test('rewriteWire: rebuilds Preview block from the (post-write) file content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2eval-deref-'));
  try {
    const file = path.join(dir, 'after-scrub.txt');
    // Original wire envelope mentions the unredacted preview claude
    // captured at spool time. The file on disk has already been
    // scrubbed by middleware at this point in the flow.
    const wireText = persistedEnvelope(file, '48.8', 'leak-this-preview-text');
    await writeFile(file, 'POST_SCRUB_CONTENT no leaks here', 'utf8');

    const out = await persistedOutputDereferencer.rewriteWire({ path: file, kind: 'text' }, wireResult(wireText));
    const stripped = (out.content[0] as { text: string }).text;

    // Envelope and path mention preserved (replay/record stay stable).
    assert.match(stripped, /<persisted-output>/);
    assert.match(stripped, new RegExp(`Full output saved to: ${file.replace(/\//g, '\\/')}`));
    assert.match(stripped, /<\/persisted-output>$/);
    // The preview reflects the on-disk (post-scrub) content, not the
    // original leak.
    assert.match(stripped, /Preview \(first 2KB\):/);
    assert.match(stripped, /POST_SCRUB_CONTENT/);
    assert.equal(stripped.includes('leak-this-preview-text'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWire: file missing → falls back to stripping preview entirely', async () => {
  const wireText = persistedEnvelope('/tmp/this-path-does-not-exist-xyz.txt', '48.8', 'leak-text');
  const out = await persistedOutputDereferencer.rewriteWire(
    { path: '/tmp/this-path-does-not-exist-xyz.txt', kind: 'text' },
    wireResult(wireText),
  );
  const stripped = (out.content[0] as { text: string }).text;
  assert.equal(stripped.includes('leak-text'), false);
  assert.equal(stripped.includes('Preview (first'), false);
  assert.match(stripped, /<\/persisted-output>$/);
});

test('rewriteWire: passes through unchanged if no Preview block', async () => {
  const text = '<persisted-output>\nOutput too large. Full output saved to: /tmp/x.txt\n</persisted-output>';
  const tr = wireResult(text);
  const out = await persistedOutputDereferencer.rewriteWire({ path: '/tmp/x.txt', kind: 'text' }, tr);
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

test('chain: two middleware mutate dereffed content; both mutations land on disk and in the preview', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2eval-deref-'));
  try {
    const file = path.join(dir, 'spooled.txt');
    const original = 'SECRET_TOKEN=abc PASSWORD=xyz everything-else-stays\n'.repeat(100);
    await writeFile(file, original, 'utf8');
    const pointer = { path: file, kind: 'text' as const };

    // Outer scrubs SECRET_TOKEN; inner scrubs PASSWORD. Both mutate the
    // text and pass through. Inner sees the dereffed content first
    // (Koa-style: outer wraps, descends, then sees inner's output).
    const outer: Middleware = {
      name: 'outer-scrub-secret',
      async onToolCall({ input, handler }) {
        const real = await handler(input);
        const text = (real.content[0] as { text: string }).text;
        return {
          content: [{ type: 'text', text: text.replaceAll(/SECRET_TOKEN=\w+/g, '[OUTER]') }],
          isError: real.isError,
        };
      },
    };
    const inner: Middleware = {
      name: 'inner-scrub-password',
      async onToolCall({ input, handler }) {
        const real = await handler(input);
        // Inner sees the raw dereffed content — both needles still here.
        assert.match((real.content[0] as { text: string }).text, /SECRET_TOKEN=abc/);
        assert.match((real.content[0] as { text: string }).text, /PASSWORD=xyz/);
        const text = (real.content[0] as { text: string }).text;
        return {
          content: [{ type: 'text', text: text.replaceAll(/PASSWORD=\w+/g, '[INNER]') }],
          isError: real.isError,
        };
      },
    };

    // Drive the chain manually with a fake backend that returns the
    // dereffed file content (mirrors what the proxy does with `read`).
    const outcome = await startChain([outer, inner], {
      evalName: 'chain-test',
      config: {} as any,
      data: {} as any,
      abort: () => {},
      toolUseId: 'tu_chain',
      server: 'native',
      tool: 'Bash',
      input: {},
    });
    assert.equal(outcome.kind, 'descended');
    if (outcome.kind !== 'descended') return;

    const dereffed = await persistedOutputDereferencer.read(pointer);
    outcome.resolveBackend(dereffed);
    const final = await outcome.chainComplete;

    // Both mutations applied (chain order: backend → inner → outer).
    const finalText = (final.content[0] as { text: string }).text;
    assert.equal(finalText.includes('SECRET_TOKEN'), false, 'outer should have removed SECRET_TOKEN');
    assert.equal(finalText.includes('PASSWORD'), false, 'inner should have removed PASSWORD');
    assert.match(finalText, /\[OUTER\]/);
    assert.match(finalText, /\[INNER\]/);

    // Write back: on-disk file reflects both mutations.
    await persistedOutputDereferencer.write(pointer, final);
    const onDisk = await readFile(file, 'utf8');
    assert.equal(onDisk.includes('SECRET_TOKEN'), false);
    assert.equal(onDisk.includes('PASSWORD'), false);
    assert.match(onDisk, /\[OUTER\]/);
    assert.match(onDisk, /\[INNER\]/);

    // Wire preview is rebuilt from disk → also reflects both mutations.
    const wireText = persistedEnvelope(file, '5.2', 'leak-from-original-preview');
    const rewritten = await persistedOutputDereferencer.rewriteWire(pointer, wireResult(wireText));
    const wire = (rewritten.content[0] as { text: string }).text;
    assert.equal(wire.includes('SECRET_TOKEN'), false);
    assert.equal(wire.includes('PASSWORD'), false);
    assert.equal(wire.includes('leak-from-original-preview'), false);
    assert.match(wire, /\[OUTER\]/);
    assert.match(wire, /\[INNER\]/);
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
