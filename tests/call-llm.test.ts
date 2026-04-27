/**
 * `callLLM` injection: the runner wraps whatever `callLLM` is in scope
 * (custom-passed `RunnerConfig.callLLM`, or the adapter's own) and:
 *
 *   - Always sets `cwd` to the per-run scratch dir so `--resume` finds the
 *     session claude wrote there.
 *   - Injects `sessionId` only when the caller passes `resume: true`.
 *   - Otherwise passes `model`, `systemPrompt`, `timeout` through verbatim.
 *
 * Tests use a fake `callLLM` so we can inspect every arg the wrapper hands
 * down — no need to spawn a real claude `-p` for these.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import {
  startRunner,
  createClaudeTestAdapter,
  type CallLLM,
  type CallLLMOpts,
  type Middleware,
} from '../src/index.js';

const TEST_TIMEOUT = 20_000;

test('custom callLLM passed to startRunner overrides the adapter\'s callLLM', { timeout: TEST_TIMEOUT }, async () => {
  let customCalledWith: { prompt: string; opts?: CallLLMOpts } | null = null;
  const customCallLLM: CallLLM = async (prompt, opts) => {
    customCalledWith = { prompt, opts };
    return 'custom-llm-response';
  };

  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'agent ans' }] }],
  });

  let observedAnswer: string | undefined;
  const grader: Middleware = {
    name: 'grader',
    async afterEval({ callLLM }) {
      observedAnswer = await callLLM('grade this please');
      return { observedAnswer };
    },
  };

  const runner = await startRunner({ adapter, callLLM: customCallLLM, middleware: [grader] });
  await runner.run({ name: 'override', question: 'x' });
  await runner.close();

  assert.equal(observedAnswer, 'custom-llm-response');
  assert.ok(customCalledWith, 'custom callLLM was never called');
  assert.equal((customCalledWith as any).prompt, 'grade this please');
});

test('callLLM wrapper injects cwd = runDir', { timeout: TEST_TIMEOUT }, async () => {
  let observedCwd: string | undefined;
  const customCallLLM: CallLLM = async (_p, opts) => {
    observedCwd = opts?.cwd;
    return '';
  };

  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'ok' }] }],
  });

  const grader: Middleware = {
    name: 'grader',
    async afterEval({ callLLM }) {
      await callLLM('hi');
      return {};
    },
  };

  const runner = await startRunner({ adapter, callLLM: customCallLLM, middleware: [grader] });
  await runner.run({ name: 'cwd', question: 'x' });
  await runner.close();

  assert.ok(observedCwd, 'cwd was not injected');
  // runDir lives under `<cwd>/.eval_runs/<eval-name>/` so claude walks
  // up and picks up the user's project-level `.mcp.json` / `.claude/`.
  const expectedParent = path.join(process.cwd(), '.eval_runs');
  assert.ok(
    observedCwd!.startsWith(expectedParent),
    `expected cwd under ${expectedParent}, got ${observedCwd}`,
  );
});

test('callLLM does not inject sessionId by default', { timeout: TEST_TIMEOUT }, async () => {
  let observedSessionId: string | undefined = 'unset';
  const customCallLLM: CallLLM = async (_p, opts) => {
    observedSessionId = opts?.sessionId;
    return '';
  };

  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'ok' }] }],
  });

  const grader: Middleware = {
    name: 'grader',
    async afterEval({ callLLM }) {
      await callLLM('without resume');
      return {};
    },
  };

  const runner = await startRunner({ adapter, callLLM: customCallLLM, middleware: [grader] });
  await runner.run({ name: 'no-resume', question: 'x' });
  await runner.close();

  assert.equal(observedSessionId, undefined);
});

test('callLLM passes model/systemPrompt/timeout through unchanged', { timeout: TEST_TIMEOUT }, async () => {
  let observedOpts: CallLLMOpts | undefined;
  const customCallLLM: CallLLM = async (_p, opts) => {
    observedOpts = opts;
    return '';
  };

  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'ok' }] }],
  });

  const grader: Middleware = {
    name: 'grader',
    async afterEval({ callLLM }) {
      await callLLM('hi', {
        model: 'claude-haiku-4-5',
        systemPrompt: 'you are a grader',
        timeout: 5_000,
      });
      return {};
    },
  };

  const runner = await startRunner({ adapter, callLLM: customCallLLM, middleware: [grader] });
  await runner.run({ name: 'opts-passthru', question: 'x' });
  await runner.close();

  assert.equal(observedOpts?.model, 'claude-haiku-4-5');
  assert.equal(observedOpts?.systemPrompt, 'you are a grader');
  assert.equal(observedOpts?.timeout, 5_000);
});

test('falls back to adapter.callLLM when no custom callLLM is provided', { timeout: TEST_TIMEOUT }, async () => {
  // The test adapter's callLLM is a stub that returns ''. We're not
  // asserting what it does — just that the wrapper actually invokes it
  // when the user didn't pass a runner-level override.
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'ok' }] }],
  });

  let received: string | undefined;
  const grader: Middleware = {
    name: 'grader',
    async afterEval({ callLLM }) {
      received = await callLLM('anything');
      return {};
    },
  };

  const runner = await startRunner({ adapter, middleware: [grader] });
  await runner.run({ name: 'fallback', question: 'x' });
  await runner.close();

  // test adapter's stub returns ''.
  assert.equal(received, '');
});
