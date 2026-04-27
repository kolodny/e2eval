/**
 * `ctx.data` — per-run mutable state shared across lifecycle phases.
 *
 *   - Same object identity flows through beforeEval → onToolCall → afterEval.
 *   - Each `runner.run()` gets a fresh `data: {}`.
 *   - Two middleware in the same run share the same `data` (write/read).
 *   - Available on every `MiddlewareContext`, including `OnToolCallArg`.
 *
 * For declaration-merging type safety, see `tests/data.test.ts` augments
 * the `Data` interface inline at the top of this file.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createClaudeTestAdapter,
  type Middleware,
} from '../src/index.js';

declare module '../src/core/types.js' {
  interface Data {
    seenInBefore?: string;
    toolCallsObserved?: string[];
    counter?: number;
  }
}

const TEST_TIMEOUT = 30_000;
const bashCmd = (command: string, description = 'test') => ({ command, description });

test('ctx.data: same object flows through beforeEval → onToolCall → afterEval', { timeout: TEST_TIMEOUT }, async () => {
  const refsSeen = new Set<object>();

  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo x') }] },
      { content: [{ type: 'text', text: 'done' }] },
    ],
  });

  const tracker: Middleware = {
    name: 'tracker',
    async beforeEval({ data }) {
      refsSeen.add(data);
      data.seenInBefore = 'set-in-before';
      data.toolCallsObserved = [];
    },
    async onToolCall({ data, input, handler }) {
      refsSeen.add(data);
      data.toolCallsObserved!.push((input as any).command);
      return await handler(input);
    },
    async afterEval({ data }) {
      refsSeen.add(data);
      return {
        seenInBefore: data.seenInBefore,
        toolCallsObserved: data.toolCallsObserved,
      };
    },
  };

  const runner = await startRunner({ adapter, middleware: [tracker] });
  const ran = await runner.run({ name: 'data-flow', question: 'x' });
  await runner.close();

  // Same object identity across all three phases.
  assert.equal(refsSeen.size, 1, 'data should be the same object identity in all phases');
  assert.deepEqual(ran.results.tracker, {
    seenInBefore: 'set-in-before',
    toolCallsObserved: ['echo x'],
  });
});

test('ctx.data: each runner.run() gets a fresh data object', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });

  const counter: Middleware = {
    name: 'counter',
    async beforeEval({ data }) {
      // Reads previous run's value if data leaks; expects undefined each run.
      assert.equal(data.counter, undefined, 'data should be empty at the start of each run');
      data.counter = 1;
    },
    async afterEval({ data }) {
      return { counter: data.counter };
    },
  };

  const runner = await startRunner({ adapter, middleware: [counter] });
  const a = await runner.run({ name: 'a', question: 'x' });
  const b = await runner.run({ name: 'b', question: 'x' });
  await runner.close();

  assert.deepEqual(a.results.counter, { counter: 1 });
  assert.deepEqual(b.results.counter, { counter: 1 });
});

test('ctx.data: two middleware share the same data object', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo y') }] },
      { content: [{ type: 'text', text: 'ok' }] },
    ],
  });

  // Producer writes in beforeEval; consumer reads in afterEval. No
  // ctx.results dependency — just the shared data bag.
  const producer: Middleware = {
    name: 'producer',
    async beforeEval({ data }) {
      data.toolCallsObserved = [];
    },
    async onToolCall({ data, input, handler }) {
      data.toolCallsObserved!.push((input as any).command);
      return await handler(input);
    },
  };
  const consumer: Middleware = {
    name: 'consumer',
    async afterEval({ data }) {
      return { observed: data.toolCallsObserved };
    },
  };

  const runner = await startRunner({ adapter, middleware: [producer, consumer] });
  const ran = await runner.run({ name: 'shared', question: 'x' });
  await runner.close();

  assert.deepEqual(ran.results.consumer, { observed: ['echo y'] });
  // Producer doesn't return anything from afterEval, so it's not in results.
  assert.equal('producer' in ran.results, false);
});

test('ctx.data: writes from middleware A\'s onToolCall are visible to middleware B\'s onToolCall on the next call', { timeout: TEST_TIMEOUT }, async () => {
  // Two parallel tool calls; first middleware bumps a counter on each, second
  // reads the counter and asserts the order it sees.
  const adapter = createClaudeTestAdapter({
    respond: [
      {
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'Bash', input: bashCmd('echo first') },
          { type: 'tool_use', id: 'tu_b', name: 'Bash', input: bashCmd('echo second') },
        ],
      },
      { content: [{ type: 'text', text: 'ok' }] },
    ],
  });

  const observations: number[] = [];
  const bumper: Middleware = {
    name: 'bumper',
    async beforeEval({ data }) { data.counter = 0; },
    async onToolCall({ data, input, handler }) {
      data.counter = (data.counter ?? 0) + 1;
      return await handler(input);
    },
  };
  const reader: Middleware = {
    name: 'reader',
    async onToolCall({ data, input, handler }) {
      observations.push(data.counter ?? -1);
      return await handler(input);
    },
  };

  const runner = await startRunner({ adapter, middleware: [bumper, reader] });
  await runner.run({ name: 'order', question: 'x' });
  await runner.close();

  // bumper increments before reader sees it (Koa-style: outer-before runs
  // first), so reader sees 1 then 2 — proving writes within the chain
  // propagate during a single tool call.
  assert.deepEqual(observations, [1, 2]);
});
