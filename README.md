# e2eval

[![npm version](https://img.shields.io/npm/v/e2eval.svg)](https://www.npmjs.com/package/e2eval)
[![npm downloads](https://img.shields.io/npm/dm/e2eval.svg)](https://www.npmjs.com/package/e2eval)

Eval framework for [Claude Code](https://claude.ai/code), [OpenCode](https://github.com/sst/opencode),
and [Codex](https://github.com/openai/codex) that uses real tools against
real data. Evals are built from actual tasks — someone asked a question
in Slack, debugged a production issue, or traced a config problem through
logs and APIs. The agent solves the same task using the same MCP tools:
searching messages, querying service catalogs, reading docs, calling
internal APIs.

The problem is that a good searcher will find the exact thread the eval
was sourced from, or the post-mortem doc, or the incident report — and
the answer is right there. e2eval intercepts the LLM API the agent
talks to (Anthropic for claude/opencode, OpenAI Responses for codex) so
you can surgically scrub these sources from tool results, redact leaking
references, and observe exactly what evidence the agent used — without
disabling the tools it needs to actually solve the problem.

## How it works

```
                 ┌── beforeEval (rewrite prompt)
                 │
   agent ──────► proxy ────► LLM API (or self-hosted gateway)
                 │
                 ├── onToolCall (Koa-style: short-circuit, mutate args, transform result)
                 ├── toolCalls[] (one entry per call after the chain settles, in-process)
                 │
                 └── afterEval (grade once agent finishes; receives toolCalls + answer)
```

The proxy sits between the agent and the LLM API. When the LLM emits
a `tool_use` block, the proxy pauses before forwarding it to the agent
and runs the middleware chain. Middleware can:

  - **Short-circuit** (return `ToolResult` without calling `handler`) —
    the agent still runs the tool, but the LLM only ever sees the
    middleware's synthetic result on the next request. Same shape an
    `exit 2` PreToolUse hook would produce in the conversation history.
  - **Modify the request** (`await handler(mutatedArgs)`) — the proxy
    rewrites the `tool_use.input` before the agent reads it; the tool
    runs with the new args.
  - **Modify the response** (`await handler(args)` then transform the
    return) — tool runs with the original args; the LLM sees a
    middleware-transformed result.

The chain suspends across HTTP cycles: when middleware calls `handler`,
the proxy emits the (possibly-mutated) `tool_use` to the agent, the
agent runs the tool locally, and on the next request the proxy resolves
`handler`'s promise with the real `tool_result`.

## Quick start

```ts
import { startRunner, claudeAdapter } from 'e2eval';
// Or: opencodeAdapter, codexAdapter — same API.
import { myGrader } from './middleware/my-grader.js';

const runner = await startRunner({
  adapter: claudeAdapter,
  middleware: [myGrader],
});

const ran = await runner.run({
  name: 'deploy-rollback',
  question: `Service X had a bad deploy last Tuesday. What config flag was reverted to fix it?`,
  config: { expectedAnswer: 'enable_canary_bypass' },
});

console.log(ran.answer);            // what the agent said
console.log(ran.results.myGrader);  // whatever myGrader.afterEval returned
console.log(ran.toolCalls);         // every tool call, post-middleware
await runner.close();
```

## Middleware

Middleware is the extension point. A scrubber that redacts a source
thread from search results, a grader that checks correctness via LLM,
and a logger that prints tool calls are all middleware — they just
implement different lifecycle methods.

| Phase        | When                                  | Use case                                               |
| ------------ | ------------------------------------- | ------------------------------------------------------ |
| `beforeEval` | Before the agent runs                 | Modify the prompt                                      |
| `onToolCall` | Wraps each tool call (Koa-style)      | Block, mutate args, or transform results               |
| `afterEval`  | After the agent answers               | Grade the answer; whatever you return lands in `result.results[<name>]` |

`onToolCall` runs exactly once per call, in declaration order. Each
middleware receives `handler` — descend by calling `await handler(args)`,
short-circuit by returning a `ToolResult` without calling it.

```ts
async onToolCall({ tool, input, handler }) {
  if (tool !== 'mcp__search__messages') return await handler(input);

  // Short-circuit: tool not run, LLM sees this synthetic result.
  if (input.query.includes('source-thread-id')) {
    return { content: [{ type: 'text', text: 'blocked' }], isError: true };
  }

  // Modify request: tool runs with sanitized args.
  if (input.query.includes('PII')) {
    return await handler({ ...input, query: redact(input.query) });
  }

  // Modify response: tool runs as-is, transform what LLM sees.
  const real = await handler(input);
  return scrubResults(real, config.scrubThreadIds ?? []);
}
```

Every context exposes `ctx.abort(reason)` — any phase can kill the run
(rejects `runner.run()` with `reason`). If a middleware throws, the run
fails loudly instead of being silently swallowed. Each run also has a
shared `ctx.data` bag that flows through every phase (and every
middleware) — use it to pass values from `beforeEval`/`onToolCall` into
`afterEval` without going through module-level globals.

Both `Config` (read-only, set by the eval) and `Data` (read-write, scratch
during the run) are extensible via `declare module`:

```ts
declare module 'e2eval/types' {
  interface Config { scrubThreadIds?: string[]; }     // ev.config.scrubThreadIds
  interface Data { citations?: string[]; }            // ctx.data.citations
}
```

### Per-eval timeout

`runner.run(ev, { timeoutMs })` aborts the run when the budget elapses;
the agent is killed and `runner.run()` rejects. Default is no timeout
beyond the adapter's own per-spawn cap.

### Block semantics

When middleware short-circuits (returns a `ToolResult` without calling
`handler`), the proxy redirects the call to a benign shell tool the
agent always has — `Bash` for claude, `bash` for opencode,
`exec_command` for codex — encoding the synthetic content as base64
args. The original tool — built-in, Read, MCP, anything — never runs.
On the next request the proxy restores the original tool name + input
in conversation history and replaces the tool_result content with the
exact `ToolResult` you returned, so the LLM sees a coherent transcript
with the original tool name. Middleware names must be unique within a
run; duplicates throw at `startRunner`.

## `callLLM`

Middleware that needs an LLM (e.g., for grading) gets `ctx.callLLM` in
`afterEval`. It runs claude with all tools denied, so it's a single-shot
text generation.

```ts
export const correctness: Middleware = {
  name: 'correctness',

  async afterEval(ctx) {
    const expected = ctx.config.expectedAnswer;
    if (!expected) return;

    const raw = await ctx.callLLM(
      `Question: ${ctx.question}\nAnswer: ${ctx.answer}\nExpected: ${expected}\nReply with JSON: {verdict, reasoning}`,
    );
    const parsed = JSON.parse(raw);

    return { verdict: parsed.verdict, reasoning: parsed.reasoning };
  },
};
// result.results.correctness → { verdict: 'correct', reasoning: '…' }
```

`afterEval` returns whatever you want; the runner stores it under
`result.results[<middleware-name>]`. Returning `undefined` skips the
entry. Later middleware can read prior middleware's return via
`ctx.results[<earlier-name>]`.

`callLLM(prompt, { resume: true })` forks the eval session so the LLM
inherits the agent's context (tool calls, intermediate state) — useful
for graders that need to inspect long tool outputs claude truncated in
the transcript.

## Adapters

```ts
import { claudeAdapter, opencodeAdapter, codexAdapter } from 'e2eval';
```

All three present the same `AgentAdapter` interface — swap them by
changing the `adapter:` passed to `startRunner`. Each adapter knows how
to spawn its CLI and point it at the proxy:

| Adapter            | CLI        | Wire format       | How the proxy URL is injected                                      |
| ------------------ | ---------- | ----------------- | ------------------------------------------------------------------ |
| `claudeAdapter`    | `claude`   | Anthropic         | inline `--settings env.ANTHROPIC_BASE_URL`                         |
| `opencodeAdapter`  | `opencode` | Anthropic         | inline `--config` with the named provider's `baseURL` overridden   |
| `codexAdapter`     | `codex`    | OpenAI Responses  | inline `-c model_providers.<provider>.base_url=<proxyUrl>/v1`      |

For claude specifically, we override via `--settings` because its
precedence puts `--settings.env` above `~/.claude/settings.json env`
and process env — without it, a user with `ANTHROPIC_BASE_URL` already
in settings.json would bypass the proxy.

### Upstream

The proxy forwards to whatever `upstream:` you pass to `startRunner`.
Each adapter has its own fallback chain when you don't pass one:

| Adapter            | Resolution order                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claudeAdapter`    | `upstream:` → `process.env.ANTHROPIC_BASE_URL` → **hook discovery** (asks claude itself what it would resolve) → `https://api.anthropic.com`           |
| `opencodeAdapter`  | `upstream:` → `process.env.ANTHROPIC_BASE_URL` → `https://api.anthropic.com`                                                                           |
| `codexAdapter`     | `upstream:` → `process.env.OPENAI_BASE_URL` → `https://api.openai.com`                                                                                 |

**Hook discovery** (claude only): on first proxy start with no
`upstream:` and no env var, we run a one-shot
`claude -p x --no-session-persistence --settings ...` whose
`UserPromptSubmit` hook captures `$ANTHROPIC_BASE_URL` and exits
before any API call. That gives us whatever claude itself would
resolve from its full settings chain (managed → user → project →
env), without us mirroring the precedence rules. ~3-4s on first call,
cached after that. Override or skip it by passing `upstream:`
explicitly or setting `ANTHROPIC_BASE_URL`.

```ts
const runner = await startRunner({
  adapter: claudeAdapter,
  upstream: 'https://my-private-gateway.example.com',
});
```

## Recording and replay

`runner.run(ev, { record: true })` captures every upstream round-trip
(raw request + response bytes) and exposes them on
`EvalResult.recording`. Pass that recording to a later run via
`replay: { recording, upTo }` to reproduce the conversation
deterministically through the first `upTo` LLM exchanges, then
diverge: the proxy switches to the live upstream once `upTo` is hit,
and any tool calls inside the replayed prefix are auto-short-circuited
with the recorded results — so the agent sees the original transcript
byte-for-byte until the cutoff, then makes real LLM calls with whatever
new tools / MCP servers / config you've added since.

```ts
const baseline = await runner.run(ev, { record: true });
// You add a new MCP server, fix a tool, etc. Now ask: would this
// failure resolve at turn 5 with the new setup?
const after = await runner.run(ev, {
  replay: { recording: baseline.recording!, upTo: 5 },
});
```

## Cleanup

By default the runner creates a deterministic per-eval scratch dir at
`<cwd>/.eval_runs/<eval-name>/` (used as the agent's `cwd`, so its
session JSONL lives in a stable `~/.claude/projects/<encoded-cwd>/`
that `callLLM({ resume })` can find across processes). The directory
is removed on `runner.close()` and on SIGINT/SIGTERM/exit.

If you run multiple `startRunner` instances concurrently against the
same project tree (e.g. a parallel test runner), pass
`cleanupOnClose: false` so one runner's cleanup doesn't yank dirs out
from under another's in-flight evals — and clean up yourself once all
runners are done. The `E2EVAL_NO_CLEANUP=1` env var flips the default
to off, useful for `npm test`:

```json
{
  "scripts": {
    "test": "E2EVAL_NO_CLEANUP=1 node --test ...",
    "posttest": "rm -rf .eval_runs"
  }
}
```

## What you bring

e2eval handles agent lifecycle, API proxying, tool logging, middleware
orchestration, and `callLLM` plumbing. You bring:

- **Scrubbing middleware** — redact source threads, filter search results
- **Grading middleware** — check correctness, verify citations, detect cheating
- **Eval definitions** — questions sourced from real tasks, with config
- **A run script** that composes the middleware stack and drives execution

## Testing your middleware

`createClaudeTestAdapter({ respond })` (and `createOpencodeTestAdapter`,
`createCodexTestAdapter` for the other agents) swaps the upstream for an
in-process fake — the agent CLI itself still runs (so middleware that
targets MCP or native tools sees real tool dispatch), but the model's
responses are scripted. Use it for hermetic e2e tests with no API spend.

```ts
import { startRunner, createClaudeTestAdapter } from 'e2eval';

const adapter = createClaudeTestAdapter({
  respond: [
    { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi', description: 'test' } }] },
    { content: [{ type: 'text', text: 'final answer' }] },
  ],
});
```

Pass an array (one response per turn) for canned scripts, or a callback
`(req, { turnIndex }) => ScriptedResponse` to assert on what reached the
LLM after middleware ran.

For unit-testing a single middleware without claude at all, drive
`startChain` directly with a mock backend handler.
