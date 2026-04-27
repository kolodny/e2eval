/**
 * Replay-with-divergence tests — the key feature for testing
 * "I added a new MCP/skill, would the original failure now resolve?"
 *
 * Three core checks:
 *   1. **Round-trip identity** — record a run, replay it with `upTo`
 *      covering everything, the suffix is empty, and the agent's
 *      final answer matches the original.
 *   2. **Strict tool short-circuit** — recording contains a `touch`
 *      sentinel command. On replay, the bash shouldn't actually run
 *      again — the proxy should auto-substitute the recorded
 *      tool_result, and no new sentinel file should be created.
 *   3. **Divergence at cutoff** — record a run where the script ends
 *      with a generic answer. Replay with `upTo` cutting off before
 *      the final response; the suffix's scripted upstream emits a
 *      different final answer, proving the agent picks up live LLM
 *      output past the cutoff.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createClaudeTestAdapter,
  type ScriptedResponse,
} from '../src/index.js';

const TEST_TIMEOUT = 90_000;
const bashCmd = (command: string, description = 'test') => ({ command, description });

/**
 * Spin up a tiny in-process Anthropic-compatible server that returns
 * scripted responses on /v1/messages. Used as the LIVE upstream for
 * the suffix — the replay-upstream forwards here once the prefix is
 * exhausted.
 */
async function startScriptedAnthropic(
  responses: ScriptedResponse[],
): Promise<{ url: string; close: () => Promise<void>; calls: () => number }> {
  let i = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (i >= responses.length) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'live_exhausted', message: `live had ${responses.length}` } }));
      return;
    }
    const scripted = responses[i++];
    const body = {
      id: 'msg_' + randomUUID().slice(0, 12),
      type: 'message',
      role: 'assistant',
      model: 'replay-live',
      content: scripted.content,
      stop_reason: scripted.stop_reason
        ?? (scripted.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    calls: () => i,
  };
}

test('record produces a recording on EvalResult.recording', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'hello' }] }],
  });
  const runner = await startRunner({ adapter });
  const ran = await runner.run({ name: 'rec', question: 'x' }, { record: true });
  await runner.close();

  assert.ok(ran.recording, 'recording should be present when record:true');
  assert.ok(ran.recording!.exchanges.length >= 1, 'at least one exchange captured');
  // Each exchange has request and response strings (raw bytes).
  for (const ex of ran.recording!.exchanges) {
    assert.equal(typeof ex.request, 'string');
    assert.equal(typeof ex.response, 'string');
    // Should parse as JSON since the proxy captures upstream JSON bodies.
    assert.doesNotThrow(() => JSON.parse(ex.request));
    assert.doesNotThrow(() => JSON.parse(ex.response));
  }
});

test('record is absent when record is not set', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'x' }] }],
  });
  const runner = await startRunner({ adapter });
  const ran = await runner.run({ name: 'no-rec', question: 'x' });
  await runner.close();

  assert.equal(ran.recording, undefined);
});

test('replay round-trip: same answer when the entire recording is replayed', { timeout: TEST_TIMEOUT }, async () => {
  // Step 1: record a run. The deterministic respond callback emits
  // text containing a marker we can grep for.
  const recAdapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'ORIGINAL_ANSWER_MARKER_xyz' }] }],
  });
  const recRunner = await startRunner({ adapter: recAdapter });
  const ranRec = await recRunner.run({ name: 'rt-rec', question: 'x' }, { record: true });
  await recRunner.close();
  assert.match(ranRec.answer, /ORIGINAL_ANSWER_MARKER_xyz/);
  assert.ok(ranRec.recording);

  // Step 2: replay with a LIVE that would error if reached. Since
  // upTo == recording.length, the live should never be hit and the
  // answer should match the original.
  const live = await startScriptedAnthropic([]);
  // The replay adapter still uses claudeAdapter shape — but to reach
  // the live we need to wire it through. The test adapter's fake
  // upstream is what the proxy normally talks to; the replay-upstream
  // wraps that. Use the test adapter as the source of agent + proxy
  // and provide replay via runOpts.
  const replayAdapter = createClaudeTestAdapter({
    respond: () => {
      throw new Error('LIVE was reached but should not have been');
    },
  });
  const replayRunner = await startRunner({ adapter: replayAdapter });
  const ranReplay = await replayRunner.run(
    { name: 'rt-replay', question: 'x' },
    { replay: { recording: ranRec.recording!, upTo: ranRec.recording!.exchanges.length } },
  );
  await replayRunner.close();
  await live.close();

  assert.match(ranReplay.answer, /ORIGINAL_ANSWER_MARKER_xyz/);
});

test('replay strict: prefix tool_use does not re-run the original bash', { timeout: TEST_TIMEOUT }, async () => {
  // Step 1: record a run that touches a sentinel file.
  const sentinel = `/tmp/e2eval-replay-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const recAdapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd(`touch ${sentinel}`) }] },
      { content: [{ type: 'text', text: 'sentinel created' }] },
    ],
  });
  const recRunner = await startRunner({ adapter: recAdapter });
  const ranRec = await recRunner.run({ name: 'strict-rec', question: 'x' }, { record: true });
  await recRunner.close();

  assert.equal(existsSync(sentinel), true, 'sentinel should exist after record run');
  unlinkSync(sentinel);
  assert.equal(existsSync(sentinel), false, 'sentinel cleaned up before replay');

  // Step 2: replay the entire recording. During the prefix the proxy
  // should auto-short-circuit the touch with the recorded tool_result —
  // so the sentinel file is NOT recreated.
  const replayAdapter = createClaudeTestAdapter({
    respond: () => {
      throw new Error('LIVE should not be reached');
    },
  });
  const replayRunner = await startRunner({ adapter: replayAdapter });
  await replayRunner.run(
    { name: 'strict-replay', question: 'x' },
    { replay: { recording: ranRec.recording!, upTo: ranRec.recording!.exchanges.length } },
  );
  await replayRunner.close();

  assert.equal(
    existsSync(sentinel), false,
    `sentinel ${sentinel} should NOT exist — strict replay must short-circuit prefix tools`,
  );
});

test('replay divergence: suffix takes a different path with new live LLM output', { timeout: TEST_TIMEOUT }, async () => {
  // Step 1: record a run with two turns — a tool call, then a final
  // answer. We'll cut off BEFORE the final answer and let a different
  // live upstream produce a new answer.
  const recAdapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo divergence') }] },
      { content: [{ type: 'text', text: 'OLD_ANSWER' }] },
    ],
  });
  const recRunner = await startRunner({ adapter: recAdapter });
  const ranRec = await recRunner.run({ name: 'div-rec', question: 'x' }, { record: true });
  await recRunner.close();
  assert.match(ranRec.answer, /OLD_ANSWER/);
  // Recording should have two substantive exchanges.
  assert.ok(ranRec.recording!.exchanges.length >= 2);

  // Step 2: replay only the first exchange, divert to a live upstream
  // that returns a different final answer. The agent should pick up
  // NEW_ANSWER from the live, proving the divergence point worked.
  const replayAdapter = createClaudeTestAdapter({
    respond: [
      // Agent's POST after the cutoff lands here: emit a different final.
      { content: [{ type: 'text', text: 'NEW_ANSWER' }] },
    ],
  });
  const replayRunner = await startRunner({ adapter: replayAdapter });
  const ranReplay = await replayRunner.run(
    { name: 'div-replay', question: 'x' },
    { replay: { recording: ranRec.recording!, upTo: 1 } },
  );
  await replayRunner.close();

  assert.match(ranReplay.answer, /NEW_ANSWER/);
  assert.doesNotMatch(ranReplay.answer, /OLD_ANSWER/);
});

test('replay throws if upTo exceeds recording length', { timeout: TEST_TIMEOUT }, async () => {
  const recAdapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'one turn' }] }],
  });
  const recRunner = await startRunner({ adapter: recAdapter });
  const ranRec = await recRunner.run({ name: 'small-rec', question: 'x' }, { record: true });
  await recRunner.close();

  const replayAdapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'never' }] }],
  });
  const replayRunner = await startRunner({ adapter: replayAdapter });
  await assert.rejects(
    () => replayRunner.run(
      { name: 'overrun', question: 'x' },
      { replay: { recording: ranRec.recording!, upTo: 999 } },
    ),
    /upTo \(999\) exceeds recording length/,
  );
  await replayRunner.close();
});
