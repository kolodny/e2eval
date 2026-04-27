/**
 * Shared script types for Anthropic-wire-format test adapters.
 *
 * Consumed by both `adapters/claude/test.ts` and `adapters/opencode/test.ts`.
 * Living in `providers/` (not `adapters/claude/`) so opencode users
 * don't have to import claude-named modules to get the test types.
 */
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources';

// Re-export so consumers can `import type { MessageParam } from 'e2eval'`
// without taking a direct SDK dependency.
export type { MessageParam, MessageCreateParams } from '@anthropic-ai/sdk/resources';

export type ScriptedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature?: string };

export type ScriptedResponse = {
  /** Content blocks the fake LLM "emits" this turn. */
  content: ScriptedBlock[];
  /** Defaults: `'tool_use'` if any block is `tool_use`, else `'end_turn'`. */
  stop_reason?: 'end_turn' | 'tool_use';
};

/**
 * The /v1/messages request body the proxy forwarded to the fake upstream.
 * Tool_use blocks have been restored to their original name/input by the
 * proxy and tool_result blocks contain post-middleware content — i.e.
 * exactly what an LLM would see.
 */
export type ScriptedRequest = MessageCreateParams;

export type RespondContext = {
  /** Zero-indexed turn — 0 is the first request from the agent. */
  turnIndex: number;
};

/**
 * Construct the LLM's response from the incoming request. Useful for
 * middleware tests that need to assert "given an agent in state X, the
 * LLM sees Y" — your callback inspects `req.messages`, decides what to
 * emit. Throw to fail the test loudly with that message.
 */
export type RespondFn = (
  req: ScriptedRequest,
  ctx: RespondContext,
) => ScriptedResponse | Promise<ScriptedResponse>;

export type AgentScript = {
  /**
   * How the simulated LLM responds. Either:
   *   - `ScriptedResponse[]` — one response per turn, consumed in order
   *     (test fails if the agent makes more API calls than scripted).
   *   - `RespondFn` — a callback invoked per request.
   */
  respond: ScriptedResponse[] | RespondFn;
};
