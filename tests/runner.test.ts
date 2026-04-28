/**
 * Runner-level concerns: middleware registration, results map, lifecycle.
 *
 * Tests here cover what `startRunner` and `runner.run` guarantee at the
 * framework boundary — independent of any specific `onToolCall` behavior.
 * For tool-call semantics see on-tool-call.test.ts.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createClaudeTestAdapter,
  type Middleware,
} from '../src/index.js';

const TEST_TIMEOUT = 30_000;

test('duplicate middleware names throw at startRunner (no claude spawn)', async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: '' }] }],
  });
  await assert.rejects(
    () => startRunner({ adapter, middleware: [{ name: 'a' }, { name: 'a' }] }),
    /duplicate middleware name: "a"/,
  );
});

test('results map preserves middleware array order', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'final' }] }],
  });
  const a: Middleware = { name: 'a', async afterEval() { return { from: 'a' }; } };
  const b: Middleware = { name: 'b', async afterEval() { return { from: 'b' }; } };
  const c: Middleware = { name: 'c', async afterEval() { return { from: 'c' }; } };

  const runner = await startRunner({ adapter, middleware: [a, b, c] });
  const ran = await runner.run({ name: 'order', question: 'x' });
  await runner.close();

  assert.deepEqual(Object.keys(ran.results), ['a', 'b', 'c']);
});

test('returning undefined from afterEval skips that middleware in results', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'final' }] }],
  });
  const present: Middleware = { name: 'present', async afterEval() { return { kept: true }; } };
  const absent: Middleware = { name: 'absent', async afterEval() { return undefined; } };

  const runner = await startRunner({ adapter, middleware: [present, absent] });
  const ran = await runner.run({ name: 'skip', question: 'x' });
  await runner.close();

  assert.ok('present' in ran.results);
  assert.ok(!('absent' in ran.results));
});

test('afterEval can read prior middleware\'s results via ctx.results', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'ok' }] }],
  });
  const first: Middleware = {
    name: 'first',
    async afterEval() { return { value: 42 }; },
  };
  let observed: unknown;
  const second: Middleware = {
    name: 'second',
    async afterEval({ results }) {
      observed = results.first;
      return { saw: results.first };
    },
  };

  const runner = await startRunner({ adapter, middleware: [first, second] });
  const ran = await runner.run({ name: 'pipe', question: 'x' });
  await runner.close();

  assert.deepEqual(observed, { value: 42 });
  assert.deepEqual(ran.results.second, { saw: { value: 42 } });
});

test('beforeEval rewrites the prompt; afterEval result lands in results', { timeout: TEST_TIMEOUT }, async () => {
  let promptSeenByLLM = '';
  const adapter = createClaudeTestAdapter({
    respond: (req) => {
      // Claude wraps the user prompt with multiple system-reminder text
      // blocks. Concat all text blocks and substring-match.
      const first = req.messages[0] as any;
      if (typeof first?.content === 'string') {
        promptSeenByLLM = first.content;
      } else if (Array.isArray(first?.content)) {
        promptSeenByLLM = (first.content as any[])
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      }
      return { content: [{ type: 'text', text: 'k' }] };
    },
  });

  const m: Middleware = {
    name: 'pre',
    async beforeEval({ prompt }) {
      return { replacePromptWith: prompt + ' [appended]' };
    },
    async afterEval({ question, answer }) {
      return { question, answer };
    },
  };

  const runner = await startRunner({ adapter, middleware: [m] });
  const ran = await runner.run({ name: 'before', question: 'hello' });
  await runner.close();

  assert.match(promptSeenByLLM, /\[appended\]/);
  assert.deepEqual(ran.results.pre, { question: 'hello', answer: 'k' });
});

test('EvalResult shape: answer, results, toolCalls, evalName, agent, elapsedSeconds', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'hi' }] }],
  });
  const runner = await startRunner({ adapter });
  const ran = await runner.run({ name: 'shape-test', question: '?' });
  await runner.close();

  assert.equal(ran.evalName, 'shape-test');
  assert.equal(ran.agent, 'claude-test');
  assert.match(ran.answer, /hi/);
  assert.ok(Array.isArray(ran.toolCalls));
  assert.equal(typeof ran.elapsedSeconds, 'number');
  assert.equal(typeof ran.results, 'object');
});

test('multiple beforeEval middleware compose: each sees the prior\'s rewritten prompt', { timeout: TEST_TIMEOUT }, async () => {
  let promptSeenByLLM = '';
  const adapter = createClaudeTestAdapter({
    respond: (req) => {
      const first = req.messages[0] as any;
      if (Array.isArray(first?.content)) {
        promptSeenByLLM = (first.content as any[])
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      } else if (typeof first?.content === 'string') {
        promptSeenByLLM = first.content;
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });

  const innerSawPrompts: string[] = [];
  const a: Middleware = {
    name: 'a',
    async beforeEval({ prompt }) {
      innerSawPrompts.push(prompt);
      return { replacePromptWith: prompt + ' [a]' };
    },
  };
  const b: Middleware = {
    name: 'b',
    async beforeEval({ prompt }) {
      innerSawPrompts.push(prompt);
      return { replacePromptWith: prompt + ' [b]' };
    },
  };
  const c: Middleware = {
    name: 'c',
    async beforeEval({ prompt }) {
      innerSawPrompts.push(prompt);
      return { replacePromptWith: prompt + ' [c]' };
    },
  };

  const runner = await startRunner({ adapter, middleware: [a, b, c] });
  await runner.run({ name: 'before-chain', question: 'start' });
  await runner.close();

  // a saw the original; b saw a's output; c saw b's output.
  assert.deepEqual(innerSawPrompts, ['start', 'start [a]', 'start [a] [b]']);
  assert.match(promptSeenByLLM, /start \[a\] \[b\] \[c\]/);
});

test('beforeEval returning undefined leaves prompt unchanged', { timeout: TEST_TIMEOUT }, async () => {
  let promptSeenByLLM = '';
  const adapter = createClaudeTestAdapter({
    respond: (req) => {
      const first = req.messages[0] as any;
      if (Array.isArray(first?.content)) {
        promptSeenByLLM = (first.content as any[])
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      } else if (typeof first?.content === 'string') {
        promptSeenByLLM = first.content;
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });

  const noop: Middleware = {
    name: 'noop',
    async beforeEval() { /* return undefined */ },
  };
  const empty: Middleware = {
    name: 'empty',
    async beforeEval() { return {}; /* no replacePromptWith */ },
  };

  const runner = await startRunner({ adapter, middleware: [noop, empty] });
  await runner.run({ name: 'noop-before', question: 'untouched_prompt' });
  await runner.close();

  assert.match(promptSeenByLLM, /untouched_prompt/);
});

test('runner is reusable: sequential run() calls are independent', { timeout: TEST_TIMEOUT }, async () => {
  // Echo the user's question back verbatim — proves each run gets the
  // right prompt and isn't reusing the previous run's state.
  const adapter = createClaudeTestAdapter({
    respond: (req) => {
      const first = req.messages[0] as any;
      const text = Array.isArray(first?.content)
        ? (first.content as any[]).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ')
        : (first?.content ?? '');
      // Pull a marker word out of the question to keep the answer short.
      const marker = /MARK_(\w+)/.exec(text)?.[1] ?? 'none';
      return { content: [{ type: 'text', text: `saw-${marker}` }] };
    },
  });

  let invocations = 0;
  const counter: Middleware = {
    name: 'counter',
    async afterEval() {
      invocations += 1;
      return { invocations };
    },
  };

  const runner = await startRunner({ adapter, middleware: [counter] });
  const a = await runner.run({ name: 'first', question: 'do MARK_alpha please' });
  const b = await runner.run({ name: 'second', question: 'do MARK_beta please' });
  await runner.close();

  // Distinct EvalResults — names, results, and answers all flow per-run.
  assert.equal(a.evalName, 'first');
  assert.equal(b.evalName, 'second');
  assert.deepEqual(a.results.counter, { invocations: 1 });
  assert.deepEqual(b.results.counter, { invocations: 2 });
  assert.match(a.answer, /saw-alpha/);
  assert.match(b.answer, /saw-beta/);
});

test('Eval.config flows into middleware ctx.config (declaration-merged surface)', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });

  let beforeSeen: unknown;
  let afterSeen: unknown;
  const m: Middleware = {
    name: 'cfg',
    async beforeEval({ config }) { beforeSeen = config; },
    async afterEval({ config }) { afterSeen = config; return {}; },
  };

  const runner = await startRunner({ adapter, middleware: [m] });
  // Cast through `any` because `Config` is intentionally an empty interface
  // augmented per-middleware; users with `declare module` blocks get type
  // safety, generic tests don't.
  await runner.run({
    name: 'cfg-test',
    question: 'x',
    config: { customKey: 'custom-value' } as any,
  });
  await runner.close();

  assert.deepEqual(beforeSeen, { customKey: 'custom-value' });
  assert.deepEqual(afterSeen, { customKey: 'custom-value' });
});

test('timeoutMs: run rejects with a timeout error when the budget elapses', { timeout: TEST_TIMEOUT }, async () => {
  // Hold the fake-Anthropic respond callback open longer than the
  // run's timeoutMs so the run definitely outlasts its budget.
  const adapter = createClaudeTestAdapter({
    respond: async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return { content: [{ type: 'text', text: 'too late' }] };
    },
  });

  const runner = await startRunner({ adapter });
  const start = Date.now();
  await assert.rejects(
    () => runner.run({ name: 'slow', question: 'x' }, { timeoutMs: 500 }),
    /timed out after 500ms/,
  );
  const elapsed = Date.now() - start;
  await runner.close();

  // Sanity: we actually aborted near the deadline, not after the 5s respond.
  assert.ok(elapsed < 4_000, `run should have aborted near 500ms, took ${elapsed}ms`);
});

test('timeoutMs: no timeout when omitted (run finishes normally even if slow-ish)', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { content: [{ type: 'text', text: 'finished' }] };
    },
  });

  const runner = await startRunner({ adapter });
  const ran = await runner.run({ name: 'no-timeout', question: 'x' });
  await runner.close();

  assert.match(ran.answer, /finished/);
});

test('timeoutMs: middleware afterEval does not run when the agent run timed out', { timeout: TEST_TIMEOUT }, async () => {
  let afterEvalRan = false;
  const adapter = createClaudeTestAdapter({
    respond: async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return { content: [{ type: 'text', text: 'never' }] };
    },
  });

  const m: Middleware = {
    name: 'never-graded',
    async afterEval() { afterEvalRan = true; return {}; },
  };

  const runner = await startRunner({ adapter, middleware: [m] });
  await assert.rejects(
    () => runner.run({ name: 'slow-graded', question: 'x' }, { timeoutMs: 500 }),
    /timed out/,
  );
  await runner.close();

  assert.equal(afterEvalRan, false, 'afterEval should not run after a timeout abort');
});
