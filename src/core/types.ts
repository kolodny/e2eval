/**
 * Core types for e2eval — proxy-based architecture.
 *
 * The framework intercepts Anthropic API calls (not MCP servers, not agent
 * hooks): every tool call shows up as a `tool_use` block in an assistant
 * message and a `tool_result` block in the next user message. The proxy
 * pairs them by id and runs middleware on each pair before forwarding.
 *
 * The `Config` interface is intentionally empty and is augmented by
 * middleware modules via `declare module` (declaration merging). The
 * `AgentAdapter` interface is what a new agent implements to plug in.
 *
 * The transcript pipeline has two inputs:
 *   1. The proxy's tool log — authoritative for every tool call the LLM
 *      saw the result of, regardless of whether it was MCP or native.
 *   2. The adapter's `parseTranscript` reads the agent's native output
 *      and returns the final answer.
 */

// ────────────────────────────────────────────────────────────── Eval + Config

/** Middleware-augmented configuration surface. Populated by `declare module` blocks. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Config {}

/**
 * Per-run mutable state shared across middleware lifecycle phases.
 *
 * Same declaration-merging machinery as `Config`, but read-write at runtime.
 * Use it when a middleware needs to stash a value in `beforeEval` /
 * `onToolCall` and read it back later — `ctx.results` is `afterEval`-only,
 * and module-level state races on concurrent runs.
 *
 *   declare module 'e2eval/types' {
 *     interface Data {
 *       citations?: string[];
 *     }
 *   }
 *
 * Each `runner.run()` gets a fresh `data: {}`. The runner does not freeze
 * or copy it — middleware is trusted to namespace its own keys.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Data {}

// ────────────────────────────────────────────────────────────── Tool result

/**
 * MCP-style content block. Same shape as `@modelcontextprotocol/sdk`'s
 * `CallToolResult.content`, copied here so the framework no longer depends
 * on the MCP SDK.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: string; [k: string]: unknown };

/** What `onToolCall` returns to replace the result the LLM sees. */
export type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

// ────────────────────────────────────────────────────────────── Middleware

/** Per-invocation context passed to all middleware lifecycle methods. */
export type MiddlewareContext = {
  evalName: string;
  config: Readonly<Config>;
  /**
   * Per-run mutable scratch shared across lifecycle phases. Use this to
   * pass info from `beforeEval`/`onToolCall` into `afterEval` (or between
   * middleware) without going through `Config` (read-only) or
   * module-level globals (race on concurrent runs). Augment the shape
   * via `declare module 'e2eval/types' { interface Data { ... } }`.
   */
  data: Data;
  /**
   * Abort the current eval run. Kills the agent process if still running
   * and causes the outer `runner.run()` promise to reject with `reason`.
   */
  abort(reason?: unknown): void;
};

/**
 * Descend into the next middleware (or, at the bottom, the agent's actual
 * tool execution). Returns the real result after lower middleware has run,
 * the agent has executed the tool, and the `tool_result` came back. Pass
 * mutated args to change what the tool actually runs with.
 */
export type Handler = (input: unknown) => Promise<ToolResult>;

/**
 * Argument to `Middleware.onToolCall`. Fires when the proxy sees a
 * `tool_use` block in the LLM's response — *before* the agent runs the
 * tool. The middleware body runs exactly once per call:
 *
 *   - Return `ToolResult` WITHOUT calling `handler` → short-circuit.
 *     The agent never runs the tool; `tool_use` is stripped from the
 *     response stream and a synthetic `tool_use`/`tool_result` pair with
 *     this content is injected into the next request, so the LLM sees the
 *     same shape an `exit 2` PreToolUse hook would produce.
 *   - Call `handler(args)`, return its result → pass-through; the tool runs
 *     with the (possibly mutated) `args`. Useful for sanitizing input.
 *   - Call `handler(args)`, return a transformed `ToolResult` → modify the
 *     result the LLM sees while still letting the tool run.
 *   - Return `undefined` (with or without calling `handler`) → delegate
 *     to the next middleware as if this one weren't installed.
 */
export type OnToolCallArg = MiddlewareContext & {
  /**
   * Per-call id from the wire format — Anthropic's `tool_use.id`
   * (`tu_xxx`), OpenAI Responses' `function_call.call_id` (`call_xxx`).
   * Same value as the eventual `ToolCall.toolUseId` in `afterEval`'s
   * `toolCalls`, so middleware can correlate on/after-call work, or
   * key per-call state in `ctx.data`.
   */
  toolUseId: string;
  /** MCP server name (e.g. `core-tools`), or `'native'` for non-MCP tools. */
  server: string;
  /** Short tool name — `mcp__server__tool` is split into (server, tool). */
  tool: string;
  input: unknown;
  /** Descend to the actual tool execution. Omit (don't call) to short-circuit. */
  handler: Handler;
};

// ────────────────────────────────────────────────────────────── beforeEval

export type BeforeEvalContext = MiddlewareContext & {
  /** Current prompt. Starts as `ev.question`; evolves as plugins replace it. */
  prompt: string;
};

export type BeforeEvalResult = {
  /** Full replacement for the prompt. Omit to leave unchanged. */
  replacePromptWith?: string;
};

// ────────────────────────────────────────────────────────────── afterEval

export type AfterEvalContext = MiddlewareContext & {
  question: string;
  answer: string;
  toolCalls: ToolCall[];
  /** Results emitted by prior middleware in this run, keyed by middleware name. */
  results: Readonly<Record<string, unknown>>;
  callLLM: CallLLM;
};

/**
 * A middleware can participate in three lifecycle phases:
 *   1. `beforeEval` — pre-agent: modify the prompt
 *   2. `onToolCall` — wrap each tool call (block, mutate args, transform result)
 *   3. `afterEval` — post-agent: return any value to record under
 *      `result.results[<name>]`. Return `undefined` to skip.
 */
export type Middleware = {
  name: string;
  beforeEval?(
    ctx: BeforeEvalContext,
  ): Promise<BeforeEvalResult | void> | BeforeEvalResult | void;
  onToolCall?(
    arg: OnToolCallArg,
  ): Promise<ToolResult | undefined | void> | ToolResult | undefined | void;
  afterEval?(
    ctx: AfterEvalContext,
  ): Promise<unknown> | unknown;
};

// ────────────────────────────────────────────────────────────── Eval

/** An eval definition. The agent is selected at run time via `startRunner({ adapter })`. */
export type Eval = {
  name: string;
  /** The question posed to the agent. */
  question: string;
  /** Middleware-provided options. Fields come from middleware `declare module` blocks. */
  config?: Config;
};

// ────────────────────────────────────────────────────────────── Tool log

/**
 * Tool-call record written by the proxy and read back by the runner. One
 * entry per unique `tool_use_id` the LLM saw a result for.
 */
export type ToolCall = {
  toolUseId: string;
  /** MCP server name (e.g. `core-tools`), or `'native'` for non-MCP. */
  server: string;
  tool: string;
  input: unknown;
  resultText: string;
  resultBytes: number;
  isError?: boolean;
  /** True when middleware short-circuited and the agent never ran the tool. */
  blocked?: boolean;
};

/** What the adapter returns after parsing its native transcript. */
export type NormalizedTranscript = {
  answer: string;
  sessionId?: string;
};

// ────────────────────────────────────────────────────────────── Agent adapter

export type AgentRunOpts = {
  prompt: string;
  /** URL the agent should use as its provider base (set into the right env var by the adapter). */
  proxyUrl: string;
  runDir: string;
  env: Record<string, string>;
  signal?: AbortSignal;
};

/** Args passed to `AgentAdapter.startProxy` — handed straight through from the runner. */
export type StartProxyOpts = {
  evalName: string;
  config: Readonly<Config>;
  /** Per-run mutable state shared with `beforeEval`/`afterEval`. */
  data: Data;
  middleware: readonly Middleware[];
  abort: (reason?: unknown) => void;
  /**
   * Receive each tool call after the middleware chain settles. The runner
   * accumulates these and feeds them to `afterEval.toolCalls`.
   */
  onToolCall: (call: ToolCall) => void;
  /** Override upstream URL. Each adapter has its own default resolution chain. */
  upstream?: string;
  /**
   * Capture each upstream round-trip as raw bytes. The runner sets this
   * when `EvalRunOpts.record: true` to populate `EvalResult.recording`.
   */
  onExchange?: (request: string, response: string) => void;
  /**
   * Replay a prior recording for the first `upTo` upstream exchanges,
   * then forward to the live upstream. The adapter is responsible for
   * spinning up a wire-format-aware replay-upstream and (in strict
   * mode) pre-populating the proxy's tool_result substitutions for
   * the prefix.
   */
  replay?: {
    recording: Recording;
    upTo: number;
  };
};

/** Returned from `AgentAdapter.startProxy` — opaque to the runner. */
export type AgentProxy = {
  /** URL the agent should use as its provider base. */
  url: string;
  port: number;
  upstream: string;
  close(): Promise<void>;
};

export interface AgentAdapter {
  readonly name: string;
  /**
   * Boot a per-run proxy for this agent's provider wire format. The runner
   * stops it after the run by calling `proxy.close()`.
   */
  startProxy(opts: StartProxyOpts): Promise<AgentProxy>;
  /**
   * Run the agent with `proxyUrl` injected into its provider env var. The
   * adapter is responsible for capturing whatever its CLI emits and
   * returning a normalised transcript (final answer + optional session id).
   * No files are written by the framework.
   */
  run(opts: AgentRunOpts): Promise<NormalizedTranscript>;
  callLLM: CallLLM;
}

// ────────────────────────────────────────────────────────────── LLM

export type CallLLMOpts = {
  model?: string;
  timeout?: number;
  /** Fork + resume from the eval session. */
  resume?: boolean;
  /** System-level instructions. */
  systemPrompt?: string;
  /** Session ID for resume — auto-injected by the runner, not set by middleware. */
  sessionId?: string;
  /** Working directory — auto-injected by the runner so resume finds the session. */
  cwd?: string;
};

export type CallLLM = (prompt: string, opts?: CallLLMOpts) => Promise<string>;

// ────────────────────────────────────────────────────────────── Grader output

// ────────────────────────────────────────────────────────────── Recording

/**
 * Captured upstream round-trips for one run. Each exchange is the raw
 * request body the proxy forwarded to upstream and the raw response
 * body upstream returned. Format-agnostic — the bytes are whatever the
 * adapter's wire format uses (Anthropic JSON, OpenAI Responses JSON,
 * etc.). Pass this back via `EvalRunOpts.replay` to re-run the same
 * conversation deterministically up to a cutoff.
 */
export type Recording = {
  exchanges: Array<{
    request: string;
    response: string;
  }>;
};

// ────────────────────────────────────────────────────────────── Runner output

export type EvalResult = {
  /** What the agent ended its turn with — its final user-visible reply. */
  answer: string;
  /** Per-middleware `afterEval` return values, keyed by middleware name. */
  results: Record<string, unknown>;
  /** Every tool call the LLM saw a result for, with the post-middleware view. */
  toolCalls: ToolCall[];
  evalName: string;
  agent: string;
  elapsedSeconds: number;
  /** Captured upstream exchanges. Present iff `EvalRunOpts.record: true`. */
  recording?: Recording;
};
