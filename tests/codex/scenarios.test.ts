/**
 * Integration scenarios for the codex adapter.
 *
 * Real `codex exec --json` against a fake `/v1/responses` upstream
 * served via the test adapter. Covers passthrough, short-circuit
 * (block), mutate args, and basic answer round-trip.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createCodexTestAdapter,
  type Middleware,
} from '../../src/index.js';

const TEST_TIMEOUT = 60_000;

test('codex: text-only response round-trips through the proxy', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createCodexTestAdapter({
    respond: [
      {
        output: [
          {
            type: 'message', id: 'm_1', role: 'assistant',
            content: [{ type: 'output_text', text: 'hello from codex' }],
          },
        ],
      },
    ],
  });

  const runner = await startRunner({ adapter });
  const ran = await runner.run({ name: 'cx-smoke', question: 'say hi' });
  await runner.close();

  assert.match(ran.answer, /hello from codex/);
  assert.equal(ran.toolCalls.length, 0);
  assert.equal(ran.agent, 'codex-test');
});

test('codex: passthrough — middleware sees the real exec_command result', { timeout: TEST_TIMEOUT }, async () => {
  let realFromMiddleware = '';
  const adapter = createCodexTestAdapter({
    respond: [
      {
        output: [
          {
            type: 'function_call', id: 'fc_1', call_id: 'call_1',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'echo codex_passthrough' }),
          },
        ],
      },
      {
        output: [
          { type: 'message', id: 'm_2', role: 'assistant', content: [{ type: 'output_text', text: 'observed' }] },
        ],
      },
    ],
  });

  const observe: Middleware = {
    name: 'observe',
    async onToolCall({ tool, input, handler }) {
      assert.equal(tool, 'exec_command');
      const real = await handler(input);
      realFromMiddleware = (real.content[0] as any).text;
      return real;
    },
  };

  const runner = await startRunner({ adapter, middleware: [observe] });
  const ran = await runner.run({ name: 'cx-pass', question: 'echo' });
  await runner.close();

  assert.match(realFromMiddleware, /codex_passthrough/);
  assert.equal(ran.toolCalls.length, 1);
  assert.equal(ran.toolCalls[0].tool, 'exec_command');
});

test('codex: short-circuit blocks the original tool from running', { timeout: TEST_TIMEOUT }, async () => {
  const sentinel = `/tmp/e2eval-cx-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const adapter = createCodexTestAdapter({
    respond: [
      {
        output: [
          {
            type: 'function_call', id: 'fc_1', call_id: 'call_1',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: `touch ${sentinel}` }),
          },
        ],
      },
      {
        output: [
          { type: 'message', id: 'm_2', role: 'assistant', content: [{ type: 'output_text', text: 'all done' }] },
        ],
      },
    ],
  });

  const blocker: Middleware = {
    name: 'blocker',
    async onToolCall() {
      return { content: [{ type: 'text', text: 'BLOCKED' }], isError: true };
    },
  };

  const runner = await startRunner({ adapter, middleware: [blocker] });
  const ran = await runner.run({ name: 'cx-block', question: 'touch sentinel' });
  await runner.close();

  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(sentinel), false, `sentinel ${sentinel} must not exist`);
  assert.equal(ran.toolCalls.length, 1);
  assert.equal(ran.toolCalls[0].blocked, true);
  assert.match(ran.toolCalls[0].resultText, /BLOCKED/);
});

test('codex: mutate args — agent runs the mutated command', { timeout: TEST_TIMEOUT }, async () => {
  let toolOutputLLMSaw: string | null = null;
  const adapter = createCodexTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 1) {
        const fco = (req.input as any[]).find((i) => i?.type === 'function_call_output');
        toolOutputLLMSaw = fco?.output ?? null;
      }
      if (turnIndex === 0) {
        return {
          output: [
            {
              type: 'function_call', id: 'fc_1', call_id: 'call_1',
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'rm -rf /tmp/__never_run_codex__' }),
            },
          ],
        };
      }
      return {
        output: [
          { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        ],
      };
    },
  });

  const sanitize: Middleware = {
    name: 'sanitize',
    async onToolCall({ input, handler }) {
      // Codex passes args as { cmd: '<shell line>' }. Replace cmd.
      return await handler({ ...(input as any), cmd: 'echo codex_mutated' });
    },
  };

  const runner = await startRunner({ adapter, middleware: [sanitize] });
  await runner.run({ name: 'cx-mutate', question: 'do thing' });
  await runner.close();

  assert.match(toolOutputLLMSaw ?? '', /codex_mutated/);
});

test('codex: respond callback sees the original tool name+args after the redirect splice', { timeout: TEST_TIMEOUT }, async () => {
  // After short-circuit, the proxy renames the function_call to
  // exec_command for codex to actually run, then on the next request
  // restores the original name+args in the assistant item. The
  // RespondFn on turn 1 should see the ORIGINAL name (not exec_command).
  let observedOnTurn1: { name?: string; args?: string } = {};
  const adapter = createCodexTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 1) {
        // Find the function_call item from turn 0 in the input array.
        const fc = (req.input as any[]).find((i) => i?.type === 'function_call');
        observedOnTurn1 = { name: fc?.name, args: fc?.arguments };
      }
      if (turnIndex === 0) {
        return {
          output: [
            {
              type: 'function_call', id: 'fc_1', call_id: 'call_1',
              name: 'fancy_custom_tool',
              arguments: JSON.stringify({ original: 'args' }),
            },
          ],
        };
      }
      return {
        output: [
          { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'fin' }] },
        ],
      };
    },
  });

  const blocker: Middleware = {
    name: 'blocker',
    async onToolCall() {
      return { content: [{ type: 'text', text: 'denied' }], isError: true };
    },
  };

  const runner = await startRunner({ adapter, middleware: [blocker] });
  await runner.run({ name: 'cx-restore', question: 'x' });
  await runner.close();

  assert.equal(observedOnTurn1.name, 'fancy_custom_tool');
  assert.deepEqual(JSON.parse(observedOnTurn1.args ?? '{}'), { original: 'args' });
});
