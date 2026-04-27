/**
 * End-to-end scenario tests — combinations of `beforeEval`, `onToolCall`,
 * and `afterEval` in patterns real eval authors would write. These
 * complement the lifecycle-isolated tests in runner / on-tool-call /
 * call-llm by exercising the framework as a whole.
 *
 * Scenarios:
 *   1. Full guardrail pipeline (single middleware, all three phases)
 *   2. Composed middleware (PII scrub + dangerous-tool counter, separate concerns)
 *   3. LLM-as-judge grader (afterEval calls callLLM, uses custom adapter callLLM)
 *   4. Tool-trace grading (afterEval inspects toolCalls)
 *   5. Multi-turn allow → block → allow agent loop
 *   6. Outer-mutates-args + inner-transforms-output chain
 *   7. beforeEval prompt-template + afterEval format-grader pair
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createClaudeTestAdapter,
  startChain,
  type CallLLM,
  type ChainOutcome,
  type Middleware,
  type ToolResult,
} from '../src/index.js';

const TEST_TIMEOUT = 25_000;
const bashCmd = (command: string, description = 'test') => ({ command, description });

const collectPrompt = (req: any): string => {
  const first = req.messages[0];
  if (Array.isArray(first?.content)) {
    return (first.content as any[])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return typeof first?.content === 'string' ? first.content : '';
};

// ────────────────────────────────────────────────────────────── 1. Full guardrail

test('scenario: single middleware combining beforeEval + onToolCall + afterEval', { timeout: TEST_TIMEOUT }, async () => {
  // Realistic shape: one middleware = one concern, all three phases.
  // This one is a "PII guardrail":
  //   - beforeEval: prepend a "redact PII" instruction
  //   - onToolCall: scrub SSN-shaped tokens from any tool result
  //   - afterEval: assert the answer doesn't leak the SSN we know was returned
  let toolResultLLMSaw: string | null = null;

  const adapter = createClaudeTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 0) {
        // Sanity: the prompt the LLM sees has the redaction preamble.
        assert.match(collectPrompt(req), /\[REDACT\]/);
        return {
          content: [{
            type: 'tool_use', id: 'tu_1', name: 'Bash',
            input: bashCmd('echo "user record: SSN 123-45-6789"'),
          }],
        };
      }
      const lastUser = req.messages.at(-1) as any;
      const tr = (lastUser.content as any[]).find((b: any) => b?.type === 'tool_result');
      toolResultLLMSaw = JSON.stringify(tr?.content);
      return { content: [{ type: 'text', text: 'all good — no PII surfaced' }] };
    },
  });

  const guardrail: Middleware = {
    name: 'pii-guardrail',
    async beforeEval({ prompt }) {
      return { replacePromptWith: `[REDACT] You must never reveal PII.\n\n${prompt}` };
    },
    async onToolCall({ input, handler }) {
      const real = await handler(input);
      const text = (real.content[0] as any).text as string;
      const scrubbed = text.replace(/\d{3}-\d{2}-\d{4}/g, '[REDACTED-SSN]');
      return { content: [{ type: 'text', text: scrubbed }] };
    },
    async afterEval({ answer, toolCalls }) {
      const leaked = /\d{3}-\d{2}-\d{4}/.test(answer);
      const seenInToolResults = toolCalls.some((c) => /\d{3}-\d{2}-\d{4}/.test(c.resultText));
      return { leaked, seenInToolResults };
    },
  };

  const runner = await startRunner({ adapter, middleware: [guardrail] });
  const ran = await runner.run({ name: 'pii-guard', question: 'fetch user info' });
  await runner.close();

  // The LLM saw scrubbed content, not the raw SSN.
  assert.match(toolResultLLMSaw ?? '', /\[REDACTED-SSN\]/);
  assert.doesNotMatch(toolResultLLMSaw ?? '', /123-45-6789/);
  // afterEval saw the scrubbed toolCalls (post-middleware view) — same data.
  assert.deepEqual(ran.results['pii-guardrail'], { leaked: false, seenInToolResults: false });
});

// ────────────────────────────────────────────────────────────── 2. Composed middleware

test('scenario: two middleware, separate concerns — PII scrubber + dangerous-tool counter', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: (_req, { turnIndex }) => {
      if (turnIndex === 0) {
        return {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo "alice@example.com"') },
            { type: 'tool_use', id: 'tu_2', name: 'Bash', input: bashCmd('rm -rf /tmp/__never_run__') },
            { type: 'tool_use', id: 'tu_3', name: 'Bash', input: bashCmd('curl -X DELETE http://example.com/api/users/1') },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'finished' }] };
    },
  });

  const scrubber: Middleware = {
    name: 'scrub',
    async onToolCall({ input, handler }) {
      const real = await handler(input);
      const text = (real.content[0] as any).text as string;
      return { content: [{ type: 'text', text: text.replace(/[\w.+-]+@[\w.-]+/g, '[EMAIL]') }] };
    },
    async afterEval({ toolCalls }) {
      const stillLeaks = toolCalls.filter((c) => /@/.test(c.resultText));
      return { leaks: stillLeaks.length };
    },
  };

  const dangerCounter: Middleware = {
    name: 'danger',
    async onToolCall({ input, handler }) {
      const cmd = (input as any).command as string;
      if (/^(rm |curl .*-X (DELETE|PUT))/.test(cmd)) {
        return { content: [{ type: 'text', text: 'BLOCKED_DANGEROUS' }], isError: true };
      }
      return await handler(input);
    },
    async afterEval({ toolCalls }) {
      return {
        total: toolCalls.length,
        blocked: toolCalls.filter((c) => c.blocked).length,
      };
    },
  };

  const runner = await startRunner({ adapter, middleware: [scrubber, dangerCounter] });
  const ran = await runner.run({ name: 'composed', question: 'do dangerous stuff' });
  await runner.close();

  // 3 tool calls total, 2 blocked by dangerCounter (rm + curl DELETE).
  assert.deepEqual(ran.results.danger, { total: 3, blocked: 2 });
  // The one tool that ran (echo email) had its email scrubbed before
  // hitting toolCalls (post-middleware view).
  assert.deepEqual(ran.results.scrub, { leaks: 0 });
});

// ────────────────────────────────────────────────────────────── 3. LLM-as-judge grader

test('scenario: afterEval calls callLLM as a judge to score the answer', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: [{ content: [{ type: 'text', text: 'The capital of France is Paris.' }] }],
  });

  // Stub LLM judge — the runner should pass through prompt + opts.
  const judgeCalls: { prompt: string; cwd?: string; systemPrompt?: string }[] = [];
  const fakeJudge: CallLLM = async (prompt, opts) => {
    judgeCalls.push({ prompt, cwd: opts?.cwd, systemPrompt: opts?.systemPrompt });
    // Crude judge: 1 if "Paris" appears, else 0.
    return /Paris/.test(prompt) ? 'SCORE: 1' : 'SCORE: 0';
  };

  const llmJudge: Middleware = {
    name: 'judge',
    async afterEval({ question, answer, callLLM }) {
      const verdict = await callLLM(
        `Question: ${question}\nAnswer: ${answer}\nReply "SCORE: 1" if correct, "SCORE: 0" if not.`,
        { systemPrompt: 'You are a strict grader.', model: 'claude-haiku-4-5' },
      );
      const score = /SCORE:\s*1/.test(verdict) ? 1 : 0;
      return { verdict, score };
    },
  };

  const runner = await startRunner({ adapter, middleware: [llmJudge], callLLM: fakeJudge });
  const ran = await runner.run({ name: 'judge', question: 'What is the capital of France?' });
  await runner.close();

  assert.equal((ran.results.judge as any).score, 1);
  assert.match((ran.results.judge as any).verdict, /SCORE:\s*1/);
  // Sanity: the runner's wrapper injected cwd, and the system prompt
  // we passed flowed straight through.
  assert.equal(judgeCalls.length, 1);
  assert.ok(judgeCalls[0].cwd, 'cwd should have been injected by the runner');
  assert.equal(judgeCalls[0].systemPrompt, 'You are a strict grader.');
});

// ────────────────────────────────────────────────────────────── 4. Tool-trace grading

test('scenario: afterEval grades by which tools the agent used, not the answer text', { timeout: TEST_TIMEOUT }, async () => {
  // Common eval pattern: the question requires the agent to *use* a
  // particular tool — answer correctness alone isn't enough.
  const adapter = createClaudeTestAdapter({
    respond: (_req, { turnIndex }) => {
      if (turnIndex === 0) {
        return { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('cat /etc/hostname') }] };
      }
      if (turnIndex === 1) {
        return { content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: bashCmd('whoami') }] };
      }
      return { content: [{ type: 'text', text: 'done investigating' }] };
    },
  });

  const traceGrader: Middleware = {
    name: 'trace',
    async afterEval({ toolCalls }) {
      const commands = toolCalls.map((c) => (c.input as any).command);
      const usedHostname = commands.some((c: string) => /hostname/.test(c));
      const usedWhoami = commands.some((c: string) => /whoami/.test(c));
      return {
        totalToolCalls: toolCalls.length,
        usedHostname,
        usedWhoami,
        passes: usedHostname && usedWhoami,
      };
    },
  };

  const runner = await startRunner({ adapter, middleware: [traceGrader] });
  const ran = await runner.run({ name: 'trace', question: 'investigate the box' });
  await runner.close();

  assert.deepEqual(ran.results.trace, {
    totalToolCalls: 2,
    usedHostname: true,
    usedWhoami: true,
    passes: true,
  });
});

// ────────────────────────────────────────────────────────────── 5. Multi-turn allow → block → allow

test('scenario: multi-turn agent with allow → block → allow tool sequence', { timeout: TEST_TIMEOUT }, async () => {
  // The agent makes one tool call per turn, three turns total. Middle is
  // blocked by middleware. Final answer references all three.
  const adapter = createClaudeTestAdapter({
    respond: (_req, { turnIndex }) => {
      if (turnIndex === 0) {
        return { content: [{ type: 'tool_use', id: 'tu_a', name: 'Bash', input: bashCmd('echo step_a') }] };
      }
      if (turnIndex === 1) {
        return { content: [{ type: 'tool_use', id: 'tu_b', name: 'Bash', input: bashCmd('rm -rf /tmp/__nope__') }] };
      }
      if (turnIndex === 2) {
        return { content: [{ type: 'tool_use', id: 'tu_c', name: 'Bash', input: bashCmd('echo step_c') }] };
      }
      return { content: [{ type: 'text', text: 'walked through a-b-c' }] };
    },
  });

  const guard: Middleware = {
    name: 'guard',
    async onToolCall({ input, handler }) {
      const cmd = (input as any).command as string;
      if (/^rm /.test(cmd)) {
        return { content: [{ type: 'text', text: 'NOPE_BLOCKED' }], isError: true };
      }
      return await handler(input);
    },
  };

  const runner = await startRunner({ adapter, middleware: [guard] });
  const ran = await runner.run({ name: 'multi-turn', question: 'walk a-b-c' });
  await runner.close();

  assert.equal(ran.toolCalls.length, 3);
  const a = ran.toolCalls.find((c) => /step_a/.test((c.input as any).command))!;
  const b = ran.toolCalls.find((c) => /^rm /.test((c.input as any).command))!;
  const c = ran.toolCalls.find((c) => /step_c/.test((c.input as any).command))!;
  assert.ok(a && b && c);
  assert.equal(a.blocked, false);
  assert.equal(b.blocked, true);
  assert.match(b.resultText, /NOPE_BLOCKED/);
  assert.equal(c.blocked, false);
});

// ────────────────────────────────────────────────────────────── 6. Outer mutates input + inner transforms output

test('scenario: outer mw rewrites args, inner mw transforms result — chain composition', { timeout: TEST_TIMEOUT }, async () => {
  let toolResultLLMSaw: string | null = null;
  const adapter = createClaudeTestAdapter({
    respond: (req, { turnIndex }) => {
      if (turnIndex === 1) {
        const lastUser = req.messages.at(-1) as any;
        const tr = (lastUser.content as any[]).find((b: any) => b?.type === 'tool_result');
        toolResultLLMSaw = JSON.stringify(tr?.content);
      }
      if (turnIndex === 0) {
        return { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: bashCmd('echo cmd_orig') }] };
      }
      return { content: [{ type: 'text', text: 'fin' }] };
    },
  });

  // Outer prepends a banner to whatever command runs.
  const outer: Middleware = {
    name: 'outer-banner',
    async onToolCall({ input, handler }) {
      const original = (input as any).command as string;
      return await handler({ ...(input as any), command: `${original} && echo BANNER` });
    },
  };

  // Inner trims whitespace and uppercases the final result.
  const inner: Middleware = {
    name: 'inner-loud',
    async onToolCall({ input, handler }) {
      const real = await handler(input);
      const text = (real.content[0] as any).text as string;
      return { content: [{ type: 'text', text: text.trim().toUpperCase() }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [outer, inner] });
  const ran = await runner.run({ name: 'outer-inner', question: 'go' });
  await runner.close();

  // Real bash ran `echo cmd_orig && echo BANNER` (outer's mutation),
  // produced "cmd_orig\nBANNER", inner uppercased it.
  assert.match(toolResultLLMSaw ?? '', /CMD_ORIG\\nBANNER/);
  // No banner in the original command in the captured tool log — proxy
  // restores the *original* tool_use args before recording, so afterEval
  // sees what the LLM emitted, not what bash actually ran.
  // Actually: the proxy records `pending.originalInput` which is the input
  // as the LLM emitted it. Verify that.
  assert.equal((ran.toolCalls[0].input as any).command, 'echo cmd_orig');
});

// ────────────────────────────────────────────────────────────── 7. Prompt-template + format-grader

test('scenario: beforeEval enforces output format, afterEval validates it', { timeout: TEST_TIMEOUT }, async () => {
  const adapter = createClaudeTestAdapter({
    respond: (req) => {
      // The LLM sees the structured-output instruction; pretend to comply.
      assert.match(collectPrompt(req), /JSON\b.*answer/i);
      return { content: [{ type: 'text', text: '{"answer":"Paris","confidence":0.95}' }] };
    },
  });

  const formatGuard: Middleware = {
    name: 'json-format',
    async beforeEval({ prompt }) {
      return {
        replacePromptWith:
          `${prompt}\n\nFormat: respond with a single JSON object {"answer": string, "confidence": number}. No prose.`,
      };
    },
    async afterEval({ answer }) {
      try {
        const parsed = JSON.parse(answer);
        return {
          valid: typeof parsed.answer === 'string' && typeof parsed.confidence === 'number',
          parsed,
        };
      } catch {
        return { valid: false, parsed: null };
      }
    },
  };

  const runner = await startRunner({ adapter, middleware: [formatGuard] });
  const ran = await runner.run({ name: 'format', question: 'capital of France' });
  await runner.close();

  const result = ran.results['json-format'] as any;
  assert.equal(result.valid, true);
  assert.deepEqual(result.parsed, { answer: 'Paris', confidence: 0.95 });
});

// ────────────────────────────────────────────────────────────── 8. Isolating one middleware via startChain

/**
 * Helper for testing a middleware (or a chain of them) without the runner
 * or the agent. Invokes `startChain` directly with a mock backend. The
 * caller controls what `handler(args)` resolves to, then asserts on the
 * final ToolResult and the args the bottom-most middleware tried to run.
 *
 *   const { result, args } = await runMiddlewareChain([myMw], {
 *     input: { command: 'echo x' },
 *     mockBackend: async (mutated) => ({ content: [{ type: 'text', text: 'fake' }] }),
 *   });
 */
async function runMiddlewareChain(
  middleware: Middleware[],
  opts: {
    input: unknown;
    server?: string;
    tool?: string;
    mockBackend?: (finalArgs: unknown) => Promise<ToolResult> | ToolResult;
  },
): Promise<{ result: ToolResult; finalArgs?: unknown }> {
  const outcome: ChainOutcome = await startChain(middleware, {
    evalName: 'isolation-test',
    config: {} as any,
    abort: () => {},
    server: opts.server ?? 'native',
    tool: opts.tool ?? 'Bash',
    input: opts.input,
  });

  if (outcome.kind === 'short-circuit') {
    return { result: outcome.result };
  }

  const fake = opts.mockBackend
    ? await opts.mockBackend(outcome.finalArgs)
    : { content: [{ type: 'text', text: '__FAKE_BACKEND__' }] } as ToolResult;
  outcome.resolveBackend(fake);
  const final = await outcome.chainComplete;
  return { result: final, finalArgs: outcome.finalArgs };
}

test('isolation: drive a single middleware with a stubbed handler (no runner, no claude)', async () => {
  const upper: Middleware = {
    name: 'upper',
    async onToolCall({ input, handler }) {
      const real = await handler(input);
      const text = (real.content[0] as any).text as string;
      return { content: [{ type: 'text', text: text.toUpperCase() }] };
    },
  };

  const { result, finalArgs } = await runMiddlewareChain([upper], {
    input: { command: 'whatever' },
    mockBackend: () => ({ content: [{ type: 'text', text: 'hello world' }] }),
  });

  assert.equal((result.content[0] as any).text, 'HELLO WORLD');
  // upper passed args through unchanged.
  assert.deepEqual(finalArgs, { command: 'whatever' });
});

test('isolation: short-circuit middleware never reaches the mock handler', async () => {
  let backendCalls = 0;
  const blocker: Middleware = {
    name: 'blocker',
    async onToolCall() {
      return { content: [{ type: 'text', text: 'denied' }], isError: true };
    },
  };

  const { result, finalArgs } = await runMiddlewareChain([blocker], {
    input: { command: 'rm -rf /' },
    mockBackend: () => { backendCalls += 1; return { content: [{ type: 'text', text: 'never' }] }; },
  });

  assert.equal(backendCalls, 0, 'mock backend must not run when middleware short-circuits');
  assert.equal((result.content[0] as any).text, 'denied');
  assert.equal(result.isError, true);
  // Short-circuit outcome carries no finalArgs (the chain never descended).
  assert.equal(finalArgs, undefined);
});

test('isolation: assert what the LAST middleware sees by stubbing the chain below it', async () => {
  // The pattern users write to test "given middleware X is wrapped by
  // outer middleware Y, what does X actually see?". We compose [Y, X]
  // and assert on what X received via the stub backend.
  let xSawArgs: unknown;
  const x: Middleware = {
    name: 'x-under-test',
    async onToolCall({ input, handler }) {
      xSawArgs = input;
      return await handler(input);
    },
  };
  const y: Middleware = {
    name: 'y-rewriter',
    async onToolCall({ input, handler }) {
      // y mutates input before it reaches x.
      return await handler({ ...(input as any), tagged_by_y: true });
    },
  };

  await runMiddlewareChain([y, x], {
    input: { command: 'cmd' },
    mockBackend: () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });

  assert.deepEqual(xSawArgs, { command: 'cmd', tagged_by_y: true });
});

test('isolation: middleware that calls handler twice surfaces the guard error via chainComplete', async () => {
  const buggy: Middleware = {
    name: 'buggy',
    async onToolCall({ input, handler }) {
      await handler(input);
      // Second call is a programmer error — the framework must surface it.
      return await handler(input);
    },
  };

  // The `startChain` implementation catches throws from the middleware
  // and returns an errorResult with the message; that's what we assert.
  const { result } = await runMiddlewareChain([buggy], {
    input: { command: 'x' },
    mockBackend: () => ({ content: [{ type: 'text', text: 'first' }] }),
  });
  assert.match((result.content[0] as any).text, /handler twice/);
  assert.equal(result.isError, true);
});
