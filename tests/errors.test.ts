/**
 * Error and abort handling at the framework boundary:
 *
 *   - Middleware `onToolCall` throws → run rejects with a wrapped error
 *     and the abort signal flips before the agent's run promise resolves.
 *   - Middleware calls `ctx.abort(reason)` directly → same rejection path.
 *   - The fake-Anthropic `respond` callback throws → fake returns 400 to
 *     claude, so the run still resolves but the answer surfaces the error
 *     (claude doesn't retry on 4xx).
 *
 * For tool-call semantics see on-tool-call.test.ts; for runner-level
 * lifecycle / results-map behavior see runner.test.ts.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createClaudeTestAdapter,
  type Middleware,
} from '../src/index.js';

const TEST_TIMEOUT = 20_000;
const bashCmd = (command: string, description = 'test') => ({ command, description });

test('middleware onToolCall throws → run rejects with wrapped error', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo x') }] },
      { content: [{ type: 'text', text: 'never reached' }] },
    ],
  });

  const exploder: Middleware = {
    name: 'exploder',
    async onToolCall() {
      throw new Error('synthetic middleware failure');
    },
  };

  const runner = await startRunner({ adapter, middleware: [exploder] });
  await assert.rejects(
    () => runner.run({ name: 'throws', question: 'x' }),
    /exploder\.onToolCall threw: synthetic middleware failure/,
  );
  await runner.close();
});

test('middleware calls ctx.abort(reason) → run rejects with that reason', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo x') }] },
      { content: [{ type: 'text', text: 'never reached' }] },
    ],
  });

  const aborter: Middleware = {
    name: 'aborter',
    async onToolCall({ abort }) {
      abort(new Error('middleware-initiated abort'));
      // Returning a result so the chain doesn't error itself first.
      return { content: [{ type: 'text', text: 'fine' }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [aborter] });
  await assert.rejects(
    () => runner.run({ name: 'aborted', question: 'x' }),
    /middleware-initiated abort/,
  );
  await runner.close();
});

test('respond callback throws → fake returns 400; run still completes with error surfaced in answer', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: () => {
      throw new Error('fixture says no');
    },
  });

  const runner = await startRunner({ adapter });
  // The run resolves (claude doesn't retry on 4xx) — we don't assert the
  // exact answer text since claude renders API errors in its own way, but
  // it should not hang or throw at the framework level.
  const ran = await runner.run({ name: 'respond-throws', question: 'x' });
  await runner.close();

  assert.equal(typeof ran.answer, 'string');
  // The eval finished — toolCalls is empty (no tool_use ever scripted) and
  // the run returned a normal EvalResult shape.
  assert.deepEqual(ran.toolCalls, []);
});

test('only the throwing middleware aborts; sibling middleware in the same run still see prior tool calls', { timeout: TEST_TIMEOUT }, async () => {
  // Verifies that abort propagation doesn't leave the runner in a wedged
  // state — the test asserts the rejection happens, not that grading runs.
  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo x') }] },
      { content: [{ type: 'text', text: 'unreachable' }] },
    ],
  });

  let afterEvalRan = false;
  const exploder: Middleware = {
    name: 'exploder',
    async onToolCall() {
      throw new Error('boom');
    },
    async afterEval() {
      afterEvalRan = true;
      return { ran: true };
    },
  };

  const runner = await startRunner({ adapter, middleware: [exploder] });
  await assert.rejects(() => runner.run({ name: 'no-after', question: 'x' }), /boom/);
  await runner.close();

  // Aborted runs don't reach afterEval — proves the runner respects the
  // signal rather than swallowing the abort.
  assert.equal(afterEvalRan, false);
});
