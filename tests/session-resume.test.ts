/**
 * Session-id round-trip — the highest-value integration test we have.
 *
 * Each agent emits a session id in its native output format that
 * `parse-transcript` extracts. The runner then injects that id into
 * `callLLM` calls that pass `resume: true` so middleware-authored
 * grader/judge calls can resume from the eval session.
 *
 * If any of the following silently break, this test catches it:
 *   - Claude/opencode/codex change the field name or position of the
 *     session id in their `--output-format=stream-json` / `--format json`
 *     / `--json` output.
 *   - Our `parseXTranscript` regex/predicate stops matching.
 *   - The runner's `callLLM` wrapper drops the `sessionId` injection
 *     when `resume: true`.
 *
 * Each per-agent test uses the agent's actual session-id shape — the
 * regex assertions are how this catches a wire-format change.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createClaudeTestAdapter,
  createOpencodeTestAdapter,
  createCodexTestAdapter,
  type CallLLM,
  type Middleware,
} from '../src/index.js';

const TEST_TIMEOUT = 60_000;

/** Build a custom callLLM that captures whatever sessionId the runner injects. */
function makeCapture() {
  const captured: { value: string | undefined } = { value: 'unset' };
  const callLLM: CallLLM = async (_p, opts) => {
    captured.value = opts?.sessionId;
    return '';
  };
  return { callLLM, captured };
}

const resumer: Middleware = {
  name: 'resumer',
  async afterEval({ callLLM }) {
    await callLLM('continue', { resume: true });
    return {};
  },
};

test('claude: real session_id from stream-json reaches callLLM resume', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'first turn' }] }],
  });
  const { callLLM, captured } = makeCapture();

  const runner = await startRunner({ adapter, callLLM, middleware: [resumer] });
  await runner.run({ name: 'claude-resume', question: 'x' });
  await runner.close();

  // Claude emits `{type:'system',subtype:'init',session_id:<uuid>}` as
  // its first stream-json line. parseClaudeTranscript must extract it
  // and the runner must inject it on resume.
  assert.ok(captured.value, 'sessionId was not propagated through callLLM resume');
  assert.match(
    captured.value!,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    `expected UUID-shaped sessionId, got ${captured.value}`,
  );
});

test('opencode: real sessionID from JSONL events reaches callLLM resume', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createOpencodeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'first turn' }] }],
  });
  const { callLLM, captured } = makeCapture();

  const runner = await startRunner({ adapter, callLLM, middleware: [resumer] });
  await runner.run({ name: 'opencode-resume', question: 'x' });
  await runner.close();

  // OpenCode emits `{type:'step_start',sessionID:'ses_…',...}` as its
  // first event. parseOpencodeTranscript must capture it.
  assert.ok(captured.value, 'sessionId was not propagated through callLLM resume');
  assert.match(
    captured.value!,
    /^ses_[A-Za-z0-9]+$/,
    `expected ses_-prefixed sessionId, got ${captured.value}`,
  );
});

test('codex: real thread_id from JSONL events reaches callLLM resume', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createCodexTestAdapter({
    respond: [{
      output: [
        { type: 'message', id: 'm_1', role: 'assistant', content: [{ type: 'output_text', text: 'first turn' }] },
      ],
    }],
  });
  const { callLLM, captured } = makeCapture();

  const runner = await startRunner({ adapter, callLLM, middleware: [resumer] });
  await runner.run({ name: 'codex-resume', question: 'x' });
  await runner.close();

  // Codex emits `{type:'thread.started',thread_id:<uuid>}` as its
  // first JSONL event. parseCodexTranscript must extract it.
  assert.ok(captured.value, 'sessionId was not propagated through callLLM resume');
  assert.match(
    captured.value!,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    `expected UUID-shaped sessionId, got ${captured.value}`,
  );
});

test('runner does NOT inject sessionId when resume: false', { timeout: TEST_TIMEOUT }, async () => {
  // Counter-test — verifies the gate works the other way too. With
  // resume: false (the default), the runner must NOT attach the
  // sessionId. If it did, downstream callers would inadvertently
  // share state between unrelated callLLM calls.
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'first' }] }],
  });
  const { callLLM, captured } = makeCapture();

  const m: Middleware = {
    name: 'no-resume',
    async afterEval({ callLLM }) {
      await callLLM('plain'); // no resume
      return {};
    },
  };

  const runner = await startRunner({ adapter, callLLM, middleware: [m] });
  await runner.run({ name: 'no-resume', question: 'x' });
  await runner.close();

  assert.equal(captured.value, undefined, `sessionId leaked into non-resume callLLM`);
});

test('answer round-trips through parse-transcript for all three agents', { timeout: TEST_TIMEOUT }, async () => {
  // Lightweight smoke that parse-transcript's *answer* extraction is
  // also alive. The session-resume tests above cover sessionId; this
  // covers the answer field. If the agent's "final assistant text" key
  // moves, EvalResult.answer goes empty here.
  const claudeAdapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'CLAUDE_OK' }] }],
  });
  const opencodeAdapter = createOpencodeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'OPENCODE_OK' }] }],
  });
  const codexAdapter = createCodexTestAdapter({
    respond: [{
      output: [
        { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'CODEX_OK' }] },
      ],
    }],
  });

  for (const [adapter, expected] of [
    [claudeAdapter, /CLAUDE_OK/],
    [opencodeAdapter, /OPENCODE_OK/],
    [codexAdapter, /CODEX_OK/],
  ] as const) {
    const runner = await startRunner({ adapter });
    const ran = await runner.run({ name: 'answer-rt', question: 'x' });
    await runner.close();
    assert.match(ran.answer, expected, `agent ${ran.agent} answer mismatch`);
  }
});
