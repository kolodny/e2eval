/**
 * `onToolCall` lifecycle: the four single-middleware outcomes (passthrough
 * / mutate args / modify response / block), plus chain semantics
 * (multiple middleware), parallel tool calls in one response, and the
 * handler-called-twice guard.
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

// ────────────────────────────────────────────────────────────── single-middleware outcomes

test('passthrough: handler returns the agent\'s actual tool output', { timeout: TEST_TIMEOUT }, async () => {
  let realFromMiddleware = '';

  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo passthrough_works') }] },
      { content: [{ type: 'text', text: 'observed' }] },
    ],
  });

  const observe: Middleware = {
    name: 'observe',
    async onToolCall({ tool, input, handler }) {
      assert.equal(tool, 'Bash');
      const real = await handler(input);
      realFromMiddleware = (real.content[0] as any).text;
      return real;
    },
  };

  const runner = await startRunner({ adapter, middleware: [observe] });
  const ran = await runner.run({ name: 'passthrough', question: 'run echo' });
  await runner.close();

  assert.match(realFromMiddleware, /passthrough_works/);
  assert.equal(ran.toolCalls.length, 1);
});

test('mutate args: agent runs the mutated command', { timeout: TEST_TIMEOUT }, async () => {
  let toolResultLLMSaw: string | null = null;

  const adapter = createClaudeTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 1) {
        const lastUser = req.messages.at(-1) as any;
        const tr = (lastUser?.content as any[])?.find((b: any) => b?.type === 'tool_result');
        toolResultLLMSaw = JSON.stringify(tr?.content);
      }
      if (turnIndex === 0) {
        return {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('rm -rf /tmp/__e2eval_should_never_run__') },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'finished' }] };
    },
  });

  const sanitize: Middleware = {
    name: 'sanitize',
    async onToolCall({ input, handler }) {
      return await handler({ ...(input as any), command: 'echo mutated_by_middleware' });
    },
  };

  const runner = await startRunner({ adapter, middleware: [sanitize] });
  await runner.run({ name: 'mutate', question: 'do thing' });
  await runner.close();

  assert.match(toolResultLLMSaw ?? '', /mutated_by_middleware/);
});

test('modify response: tool runs as-is, LLM sees transformed result', { timeout: TEST_TIMEOUT }, async () => {
  let toolResultLLMSaw: string | null = null;
  const adapter = createClaudeTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 1) {
        const lastUser = req.messages.at(-1) as any;
        const tr = (lastUser?.content as any[])?.find((b: any) => b?.type === 'tool_result');
        toolResultLLMSaw = JSON.stringify(tr?.content);
      }
      if (turnIndex === 0) {
        return { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo hi') }] };
      }
      return { content: [{ type: 'text', text: 'over' }] };
    },
  });

  const upper: Middleware = {
    name: 'upper',
    async onToolCall({ input, handler }) {
      const real = await handler(input);
      const text = (real.content[0] as any).text as string;
      return { content: [{ type: 'text', text: text.toUpperCase().trim() }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [upper] });
  await runner.run({ name: 'transform', question: 'say hi' });
  await runner.close();

  assert.match(toolResultLLMSaw ?? '', /HI/);
  assert.doesNotMatch(toolResultLLMSaw ?? '', /^"?hi"?$/m);
});

test('block: original tool never runs; LLM sees synthetic; tool log marks blocked', { timeout: TEST_TIMEOUT }, async () => {
  // Sentinel file that the original Bash command would touch — verifies
  // the tool actually didn't run, not just that the result was lied about.
  const sentinelPath = `/tmp/e2eval-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd(`touch ${sentinelPath}`) }] },
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
  const ran = await runner.run({ name: 'block', question: 'touch file' });
  await runner.close();

  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(sentinelPath), false, `sentinel ${sentinelPath} should not exist — touch should have been blocked`);

  assert.equal(ran.toolCalls.length, 1);
  assert.equal(ran.toolCalls[0].tool, 'Bash');
  assert.equal(ran.toolCalls[0].blocked, true);
  assert.match(ran.toolCalls[0].resultText, /BLOCKED/);
  assert.equal((ran.toolCalls[0].input as any).command, `touch ${sentinelPath}`);
});

test('respond callback can assert on what the LLM saw post-middleware (PII scrub)', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 0) {
        return {
          content: [{
            type: 'tool_use', id: 'tu_1', name: 'Bash',
            input: bashCmd('echo "SSN: 123-45-6789, Email: alice@example.com"'),
          }],
        };
      }
      const lastUser = req.messages.at(-1) as any;
      const tr = (lastUser.content as any[]).find((b: any) => b?.type === 'tool_result');
      const rendered = JSON.stringify(tr?.content);
      assert.match(rendered, /\[REDACTED\]/);
      assert.doesNotMatch(rendered, /123-45-6789/);
      assert.doesNotMatch(rendered, /alice@example\.com/);
      return { content: [{ type: 'text', text: 'scrubbed ok' }] };
    },
  });

  const scrub: Middleware = {
    name: 'scrub',
    async onToolCall({ input, handler }) {
      const real = await handler(input);
      const text = (real.content[0] as any).text as string;
      return { content: [{ type: 'text', text:
        text.replace(/SSN: \S+/, 'SSN: [REDACTED]').replace(/Email: \S+/, 'Email: [REDACTED]'),
      }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [scrub] });
  await runner.run({ name: 'scrub', question: 'read secrets' });
  await runner.close();
});

test('mutate input AND output in same call (two-pass through one middleware)', { timeout: TEST_TIMEOUT }, async () => {
  let toolResultLLMSaw: string | null = null;
  const adapter = createClaudeTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 1) {
        const lastUser = req.messages.at(-1) as any;
        const tr = (lastUser?.content as any[])?.find((b: any) => b?.type === 'tool_result');
        toolResultLLMSaw = JSON.stringify(tr?.content);
      }
      if (turnIndex === 0) {
        return { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo BOTH_original') }] };
      }
      return { content: [{ type: 'text', text: 'done' }] };
    },
  });

  const both: Middleware = {
    name: 'both',
    async onToolCall({ input, handler }) {
      // Mutate input (concat) → tool runs with new args
      const real = await handler({ ...(input as any), command: (input as any).command + 'INPUT_MUTATE' });
      // Mutate output (append) → LLM sees this
      const text = (real.content[0] as any).text as string;
      return { content: [{ type: 'text', text: text.trim() + 'OUTPUT_MUTATE' }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [both] });
  await runner.run({ name: 'both', question: 'go' });
  await runner.close();

  // Real Bash ran `echo BOTH_originalINPUT_MUTATE` (the input mutation),
  // produced "BOTH_originalINPUT_MUTATE", middleware appended OUTPUT_MUTATE.
  assert.match(toolResultLLMSaw ?? '', /BOTH_originalINPUT_MUTATEOUTPUT_MUTATE/);
});

// ────────────────────────────────────────────────────────────── chain semantics

test('chain: 3 stacked middleware run inside-out around handler', { timeout: TEST_TIMEOUT }, async () => {
  const trace: string[] = [];

  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo chain') }] },
      { content: [{ type: 'text', text: 'ok' }] },
    ],
  });

  const make = (name: string): Middleware => ({
    name,
    async onToolCall({ input, handler }) {
      trace.push(`${name}:before`);
      const r = await handler(input);
      trace.push(`${name}:after`);
      return r;
    },
  });

  const runner = await startRunner({ adapter, middleware: [make('a'), make('b'), make('c')] });
  await runner.run({ name: 'chain', question: 'x' });
  await runner.close();

  // Koa-style: outer-before, ..., inner-before, handler, inner-after, ..., outer-after
  assert.deepEqual(trace, ['a:before', 'b:before', 'c:before', 'c:after', 'b:after', 'a:after']);
});

test('chain: a middleware short-circuit prevents lower middleware from seeing the call', { timeout: TEST_TIMEOUT }, async () => {
  const seen: string[] = [];

  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo unused') }] },
      { content: [{ type: 'text', text: 'ok' }] },
    ],
  });

  const outer: Middleware = {
    name: 'outer',
    async onToolCall() {
      seen.push('outer');
      // Short-circuit: don't call handler.
      return { content: [{ type: 'text', text: 'BLOCKED' }] };
    },
  };
  const inner: Middleware = {
    name: 'inner',
    async onToolCall({ input, handler }) {
      seen.push('inner');
      return await handler(input);
    },
  };

  const runner = await startRunner({ adapter, middleware: [outer, inner] });
  const ran = await runner.run({ name: 'short-circuit-chain', question: 'x' });
  await runner.close();

  assert.deepEqual(seen, ['outer']);  // inner never fired
  assert.equal(ran.toolCalls[0].blocked, true);
});

test('chain: outer middleware can mutate args before inner sees them', { timeout: TEST_TIMEOUT }, async () => {
  const innerSawInput: any[] = [];

  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('original_cmd') }] },
      { content: [{ type: 'text', text: 'ok' }] },
    ],
  });

  const outer: Middleware = {
    name: 'outer',
    async onToolCall({ input, handler }) {
      return await handler({ ...(input as any), command: 'echo mutated_by_outer' });
    },
  };
  const inner: Middleware = {
    name: 'inner',
    async onToolCall({ input, handler }) {
      innerSawInput.push(input);
      return await handler(input);
    },
  };

  const runner = await startRunner({ adapter, middleware: [outer, inner] });
  await runner.run({ name: 'chain-mutate', question: 'x' });
  await runner.close();

  // Inner middleware saw the args outer mutated, not the original.
  assert.equal(innerSawInput.length, 1);
  assert.equal((innerSawInput[0] as any).command, 'echo mutated_by_outer');
});

// ────────────────────────────────────────────────────────────── parallel tool calls

test('parallel tool_uses in one response: each middleware fires independently', { timeout: TEST_TIMEOUT }, async () => {
  const seenInputs: string[] = [];

  const adapter = createClaudeTestAdapter({
    respond: [
      {
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'Bash', input: bashCmd('echo first') },
          { type: 'tool_use', id: 'tu_b', name: 'Bash', input: bashCmd('echo second') },
          { type: 'tool_use', id: 'tu_c', name: 'Bash', input: bashCmd('echo third') },
        ],
      },
      { content: [{ type: 'text', text: 'all done' }] },
    ],
  });

  const observe: Middleware = {
    name: 'observe',
    async onToolCall({ input, handler }) {
      seenInputs.push((input as any).command);
      return await handler(input);
    },
  };

  const runner = await startRunner({ adapter, middleware: [observe] });
  const ran = await runner.run({ name: 'parallel', question: 'x' });
  await runner.close();

  // Middleware fires in source order, but the agent runs the bash
  // commands in parallel — the proxy records each ToolCall when its
  // tool_result arrives back, so `toolCalls[]` is ordered by completion,
  // not by source. Match by command rather than by index.
  assert.deepEqual(seenInputs, ['echo first', 'echo second', 'echo third']);
  assert.equal(ran.toolCalls.length, 3);
  const byCmd = (kw: string) =>
    ran.toolCalls.find((c) => (c.input as any).command === `echo ${kw}`)!;
  assert.match(byCmd('first').resultText, /first/);
  assert.match(byCmd('second').resultText, /second/);
  assert.match(byCmd('third').resultText, /third/);
});

test('parallel tool_uses: mixed block + passthrough behaviour', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [
      {
        content: [
          { type: 'tool_use', id: 'tu_safe', name: 'Bash', input: bashCmd('echo safe') },
          { type: 'tool_use', id: 'tu_dangerous', name: 'Bash', input: bashCmd('rm -rf /tmp/__nope__') },
        ],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ],
  });

  const guard: Middleware = {
    name: 'guard',
    async onToolCall({ input, handler }) {
      if (/^rm /.test((input as any).command)) {
        return { content: [{ type: 'text', text: 'DANGEROUS_BLOCKED' }], isError: true };
      }
      return await handler(input);
    },
  };

  const runner = await startRunner({ adapter, middleware: [guard] });
  const ran = await runner.run({ name: 'parallel-mixed', question: 'x' });
  await runner.close();

  const safe = ran.toolCalls.find((c) => (c.input as any).command === 'echo safe')!;
  const danger = ran.toolCalls.find((c) => (c.input as any).command.startsWith('rm '))!;
  assert.ok(safe);
  assert.ok(danger);
  assert.equal(safe.blocked, false);
  assert.match(safe.resultText, /safe/);
  assert.equal(danger.blocked, true);
  assert.match(danger.resultText, /DANGEROUS_BLOCKED/);
});

// ────────────────────────────────────────────────────────────── handler guards

test('calling handler twice in the same middleware throws synchronously', { timeout: TEST_TIMEOUT }, async () => {
  let secondCallError: Error | undefined;

  const adapter = createClaudeTestAdapter({
    respond: [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo x') }] },
      { content: [{ type: 'text', text: 'done' }] },
    ],
  });

  const buggy: Middleware = {
    name: 'buggy',
    async onToolCall({ input, handler }) {
      const r = await handler(input);
      try {
        await handler(input);
      } catch (e) {
        secondCallError = e as Error;
      }
      return r;
    },
  };

  const runner = await startRunner({ adapter, middleware: [buggy] });
  await runner.run({ name: 'handler-twice', question: 'x' });
  await runner.close();

  assert.ok(secondCallError, 'second handler() call should have thrown');
  assert.match(secondCallError!.message, /handler twice/);
});
