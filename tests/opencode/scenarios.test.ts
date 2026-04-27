/**
 * Integration scenarios for the opencode adapter.
 *
 * Mirrors the high-value subset of the claude scenarios: passthrough,
 * short-circuit (block), mutate args, basic answer round-trip.
 *
 * Each test spawns real `opencode` against a fake-Anthropic upstream
 * served via the test adapter. The proxy intercepts /v1/messages exactly
 * as in production. Wall-clock per test is ~5–8s on this machine.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createOpencodeTestAdapter,
  type Middleware,
} from '../../src/index.js';

const TEST_TIMEOUT = 60_000;
const bashCmd = (command: string, description = 'test') => ({ command, description });

test('opencode: text-only response round-trips through the proxy', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createOpencodeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'hello from opencode' }] }],
  });

  const runner = await startRunner({ adapter });
  const ran = await runner.run({ name: 'oc-smoke', question: 'say hi' });
  await runner.close();

  assert.match(ran.answer, /hello from opencode/);
  assert.equal(ran.toolCalls.length, 0);
  assert.equal(ran.agent, 'opencode-test');
});

test('opencode: passthrough — middleware sees the real bash result', { timeout: TEST_TIMEOUT }, async () => {
  let realFromMiddleware = '';
  const adapter = createOpencodeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: bashCmd('echo opencode_passthrough') }] },
      { content: [{ type: 'text', text: 'observed' }] },
    ],
  });

  const observe: Middleware = {
    name: 'observe',
    async onToolCall({ tool, input, handler }) {
      assert.equal(tool, 'bash');
      const real = await handler(input);
      realFromMiddleware = (real.content[0] as any).text;
      return real;
    },
  };

  const runner = await startRunner({ adapter, middleware: [observe] });
  const ran = await runner.run({ name: 'oc-pass', question: 'echo' });
  await runner.close();

  assert.match(realFromMiddleware, /opencode_passthrough/);
  assert.equal(ran.toolCalls.length, 1);
  assert.equal(ran.toolCalls[0].tool, 'bash');
});

test('opencode: short-circuit blocks the original tool from running', { timeout: TEST_TIMEOUT }, async () => {
  const sentinel = `/tmp/e2eval-oc-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const adapter = createOpencodeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: bashCmd(`touch ${sentinel}`) }] },
      { content: [{ type: 'text', text: 'all done' }] },
    ],
  });

  const blocker: Middleware = {
    name: 'blocker',
    async onToolCall() {
      return { content: [{ type: 'text', text: 'BLOCKED' }], isError: true };
    },
  };

  const runner = await startRunner({ adapter, middleware: [blocker] });
  const ran = await runner.run({ name: 'oc-block', question: 'touch sentinel' });
  await runner.close();

  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(sentinel), false, `sentinel ${sentinel} must not exist`);
  assert.equal(ran.toolCalls.length, 1);
  assert.equal(ran.toolCalls[0].blocked, true);
  assert.match(ran.toolCalls[0].resultText, /BLOCKED/);
});

test('opencode: mutate args — agent runs the mutated command', { timeout: TEST_TIMEOUT }, async () => {
  let toolResultLLMSaw: string | null = null;
  const adapter = createOpencodeTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 1) {
        const lastUser = req.messages.at(-1) as any;
        const tr = (lastUser?.content as any[])?.find((b: any) => b?.type === 'tool_result');
        toolResultLLMSaw = JSON.stringify(tr?.content);
      }
      if (turnIndex === 0) {
        return {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'bash', input: bashCmd('rm -rf /tmp/__never_run__') },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'finished' }] };
    },
  });

  const sanitize: Middleware = {
    name: 'sanitize',
    async onToolCall({ input, handler }) {
      return await handler({ ...(input as any), command: 'echo opencode_mutated' });
    },
  };

  const runner = await startRunner({ adapter, middleware: [sanitize] });
  await runner.run({ name: 'oc-mutate', question: 'do thing' });
  await runner.close();

  assert.match(toolResultLLMSaw ?? '', /opencode_mutated/);
});

test('opencode: title-gen calls are auto-skipped — RespondFn only sees real turns', { timeout: TEST_TIMEOUT }, async () => {
  // The test adapter recognises opencode's title-generation Haiku call
  // (system prompt: "You are a title generator…") and auto-serves it
  // with an empty `end_turn` so tests don't have to script it. The
  // user's RespondFn only sees substantive turns.
  const seenSystems: string[] = [];
  const adapter = createOpencodeTestAdapter({
    respond: (req) => {
      const sys = (req as any).system;
      const sysText = Array.isArray(sys)
        ? sys.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
        : String(sys ?? '');
      seenSystems.push(sysText.slice(0, 80));
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });

  const runner = await startRunner({ adapter });
  await runner.run({ name: 'oc-introspect', question: 'do a thing' });
  await runner.close();

  assert.equal(seenSystems.length, 1, `RespondFn should see exactly the real turn, got ${seenSystems.length}`);
  assert.doesNotMatch(seenSystems[0], /title generator/i);
  assert.match(seenSystems[0], /OpenCode/i);
});
