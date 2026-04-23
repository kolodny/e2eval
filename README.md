# e2eval

[![npm version](https://img.shields.io/npm/v/e2eval.svg)](https://www.npmjs.com/package/e2eval)
[![npm downloads](https://img.shields.io/npm/dm/e2eval.svg)](https://www.npmjs.com/package/e2eval)

Eval framework for agents that use real tools against real data. Evals
are built from actual tasks — someone asked a question in Slack, debugged
a production issue, or traced a config problem through logs and APIs. The
agent solves the same task using the same MCP tools: searching messages,
querying service catalogs, reading docs, calling internal APIs.

The problem is that a good searcher will find the exact thread the eval
was sourced from, or the post-mortem doc, or the incident report — and
the answer is right there. The framework wraps every MCP server with
middleware so you can surgically scrub these sources from search results,
redact leaking references, and observe exactly what evidence the agent
used — without disabling the tools it needs to actually solve the
problem.

e2eval spawns an actual agent process, wraps its MCP servers so you can
intercept every tool call, collects a structured tool log, then hands
the full context to your grading middleware.

Ships with adapters for **Claude Code**, **Codex**, and **opencode**. The
Claude adapter is the most mature — the Codex and opencode adapters were
built to validate the abstraction layer and may have rough edges.

## Quick start

```ts
import { startRunner, claudeAdapter } from 'e2eval';
import { myGrader } from './middleware/my-grader.ts';

const runner = await startRunner({
  adapter: claudeAdapter,
  middleware: [myGrader],
});

const result = await runner.run({
  name: 'deploy-rollback',
  question: `Service X had a bad deploy last Tuesday. What config flag was reverted to fix it?`,
  config: { expectedAnswer: 'enable_canary_bypass' },
});

console.log(result.grader.scores);
await runner.close();
```

## Middleware

Middleware is the extension point. A scrubber that redacts a source
thread from search results, a grader that checks correctness via LLM,
and a logger that prints tool calls are all middleware — they just
implement different lifecycle methods.

| Phase           | When                    | Use case                                               |
| --------------- | ----------------------- | ------------------------------------------------------ |
| `beforeEval`    | Before the agent runs   | Modify the prompt                                      |
| `onToolCall`    | Before a tool executes  | Block, replace, or scrub tool calls                    |
| `afterToolCall` | After a tool executes   | Observe results you can't control (native tools, etc.) |
| `afterEval`     | After the agent answers | Grade the answer, emit scores                          |

```ts
import type { Middleware } from 'e2eval';

declare module 'e2eval/types' {
  interface Config {
    scrubThreadIds?: string[];
  }
}

export const searchScrubber: Middleware = {
  name: 'search-scrubber',

  async onToolCall({ tool, input, handler, config }) {
    if (tool !== 'search-threads' || !handler) return;
    const scrub = config.scrubThreadIds ?? [];
    if (scrub.length === 0) return;

    const response = await handler(input);
    // filter out threads that match the source — the agent should
    // find the answer through other evidence, not the source thread
    return filterResults(response, scrub);
  },
};
```

`Config` and `Score` are extensible via `declare module` — each
middleware declares its own typed fields.

## `callLLM`

Middleware that needs an LLM (e.g., for grading) gets `ctx.callLLM` in
`afterEval`. It uses the same agent flavor as the eval — claude evals
call claude, codex evals call codex.

```ts
export const correctness: Middleware = {
  name: 'correctness',

  async afterEval(ctx) {
    const expected = ctx.config.expectedAnswer;
    if (!expected) return;

    // Single-shot: fresh session, tools disabled
    const raw = await ctx.callLLM(
      `Question: ${ctx.question}\nAnswer: ${ctx.answer}\nExpected: ${expected}\nReply with JSON: {verdict, reasoning}`,
    );
    const parsed = JSON.parse(raw);

    return {
      data: { raw, reasoning: parsed.reasoning },
      score: { verdict: parsed.verdict, correctness: parsed.verdict },
    };
  },
};
// result.grader.scores → [{ middleware: 'correctness', verdict: 'correct', correctness: 'correct' }]
```

## MCP wrapping

All MCP servers discovered by the adapter are wrapped through the
middleware server by default. Use `ignoreMcps` to skip specific ones:

```ts
const runner = await startRunner({
  adapter: claudeAdapter,
  middleware: [...],
  ignoreMcps: ['some-server-to-skip'],
});
```

The wrapper intercepts every `tools/call`, runs `onToolCall` middleware
before/after the backend, and writes a structured tool log for every
request/response pair.

## Adapters

Each adapter implements `AgentAdapter` — spawning the agent, parsing its
transcript, discovering its MCP config, and providing a `callLLM` that
speaks the agent's native CLI.

```ts
const runner = await startRunner({ adapter: myAdapter, middleware: [...] });
```

To add a new agent, implement the interface and pass it to `startRunner`.

## What you bring

e2eval handles agent lifecycle, MCP wrapping, tool logging, middleware
orchestration, and `callLLM` plumbing. You bring:

- **Scrubbing middleware** — redact source threads, filter search results
- **Grading middleware** — check correctness, verify citations, detect cheating
- **Eval definitions** — questions sourced from real tasks, with config
- **A run script** that composes the middleware stack and drives execution
