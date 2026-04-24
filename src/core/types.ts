/**
 * Core types for e2eval.
 *
 * Agent-agnostic. The `Config` interface is intentionally empty and is
 * augmented by middleware modules via `declare module` (declaration merging).
 * The `AgentAdapter` interface is what a new agent implements to plug in.
 *
 * The transcript pipeline has two inputs:
 *   1. Our MCP wrapper writes a structured tool log (`EVAL_TOOL_LOG`) for
 *      every MCP call made during the run. Authoritative for MCP traffic
 *      and independent of whatever the agent's native transcript looks like.
 *   2. The adapter's `parseTranscript` reads the agent's native output and
 *      returns a `NormalizedTranscript` — final answer and any *non-MCP*
 *      tool calls the agent made.
 *
 * The runner merges these into a single `ToolCall[]` for the grader.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ────────────────────────────────────────────────────────────── Eval + Config

/** Middleware-augmented configuration surface. Populated by `declare module` blocks. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Config {}

// ────────────────────────────────────────────────────────────── Middleware

/** Per-invocation context passed to all middleware lifecycle methods. */
export type MiddlewareContext = {
  evalName: string;
  config: Readonly<Config>;
  /**
   * Abort the current eval run. Kills the agent process if still running
   * and causes the outer `runner.run()` promise to reject with `reason`.
   * Matches the `AbortController.abort` signature — pass an Error to
   * preserve its stack, or anything else and it will be wrapped.
   */
  abort(reason?: unknown): void;
};

/**
 * Argument to `Middleware.onToolCall`. Fires before a tool runs — both MCP
 * and native tools. Return a `CallToolResult` to short-circuit (block or
 * replace), or `undefined` to let it proceed.
 */
export type OnToolCallArg = MiddlewareContext & {
  /** MCP server name, or 'native' for agent-native tools (Bash, Read, etc.). */
  server: string;
  tool: string;
  input: unknown;
  /** Call the MCP backend (MCP tools only, undefined for native). */
  handler?: (args: unknown) => Promise<CallToolResult>;
};

/**
 * Context for `afterToolCall` — the tool has already run and the agent has
 * already received the response. Middleware can observe but not modify.
 */
export type AfterToolCallArg = MiddlewareContext & {
  /** MCP server name, or 'native' for non-MCP tools (Bash, Read, etc.). */
  server: string;
  /** Short tool name — MCP tools surface as their canonical name (e.g. `rag-slack-prod`), not the agent-exposed form (`mcp__core-tools__rag-slack-prod`). */
  tool: string;
  input: unknown;
  response: string;
};


/**
 * Extensible score record. Accepts any properties by default; plugins
 * can augment via `declare module` to add typed fields with autocomplete.
 *
 * Example (in a middleware file):
 *   declare module '../types.ts' {
 *     interface Score {
 *       efficiency?: number;
 *     }
 *   }
 */
export interface Score {
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────── beforeEval

/**
 * Context for `beforeEval` — runs before the agent starts. Plugins can
 * modify the prompt (e.g. append citation instructions).
 */
export type BeforeEvalContext = MiddlewareContext & {
  /** Current prompt. Starts as `ev.question`; evolves as plugins replace it. */
  prompt: string;
};

export type BeforeEvalResult = {
  /** Full replacement for the prompt. Omit to leave unchanged. */
  replacePromptWith?: string;
};

// ────────────────────────────────────────────────────────────── afterEval

/**
 * Context for `afterEval` — the agent has finished, all tool calls are
 * collected. Plugins run sequentially; each sees the evolving state from
 * prior plugins.
 */
export type AfterEvalContext = MiddlewareContext & {
  question: string;
  answer: string;
  toolCalls: ToolCall[];
  scores: Array<Score & { middleware: string }>;
  callLLM: CallLLM;
  /** Full stderr of the agent process. Read lazily — `readFileSync(ctx.stderrPath, 'utf8')`. */
  stderrPath: string;
};

export type AfterEvalResult = {
  /** Middleware-specific data, stored under graderOutput.middleware[name]. */
  data?: Record<string, unknown>;
  /** Score entry — pushed onto `scores[]` by the runner (with middleware name added). */
  score?: Score;
};

/**
 * A middleware can participate in four lifecycle phases:
 *   1. `beforeEval` — pre-agent: modify the prompt
 *   2. `onToolCall` — before a tool runs (MCP or native): can block or replace
 *   3. `afterToolCall` — after a tool ran: observe and flag
 *   4. `afterEval` — post-agent grading/analysis: emit scores
 */
export type Middleware = {
  name: string;
  beforeEval?(
    ctx: BeforeEvalContext,
  ): Promise<BeforeEvalResult | void> | BeforeEvalResult | void;
  onToolCall?(
    arg: OnToolCallArg,
  ): Promise<CallToolResult | undefined> | CallToolResult | undefined;
  afterToolCall?(
    arg: AfterToolCallArg,
  ): Promise<void> | void;
  afterEval?(
    ctx: AfterEvalContext,
  ): Promise<AfterEvalResult | void> | AfterEvalResult | void;
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

// ────────────────────────────────────────────────────────────── Transcript

/**
 * Unified tool-call record. Populated from two sources:
 *   - MCP tool log (our wrapper server writes this) → `source = 'mcp'`
 *   - Adapter's parsed transcript (agent's native tools) → `source = 'native'`
 */
export type ToolCall = {
  toolUseId: string;
  /** MCP server name. Absent for native agent tools (Bash, Read, etc.). */
  server?: string;
  /** Tool name — always the short form (e.g. 'rag-slack-prod', not 'mcp__core-tools__rag-slack-prod'). */
  tool: string;
  input: unknown;
  resultText: string;
  resultBytes: number;
  source: 'mcp' | 'native';
  isError?: boolean;
};

/** What the adapter returns after parsing its native transcript. */
export type NormalizedTranscript = {
  finalAnswer: string;
  nativeToolCalls: ToolCall[];
  sessionId?: string;
};

// ────────────────────────────────────────────────────────────── Agent adapter

export type AgentRunOpts = {
  prompt: string;
  mcpConfigPath: string | null;
  runDir: string;
  env: Record<string, string>;
  transcriptPath: string;
  /** Adapter writes the agent process's stderr here (OS-level redirect). */
  stderrPath: string;
  signal?: AbortSignal;
};

export interface AgentAdapter {
  readonly name: string;
  readonly supportsMcp: boolean;
  discoverMcpStack(cwd: string): { mcpServers: Record<string, McpServerDef>; env?: Record<string, string> };
  run(opts: AgentRunOpts): Promise<void>;
  parseTranscript(path: string): NormalizedTranscript;
  callLLM: CallLLM;
}

/** MCP server shape we understand — canonical across agents. */
export type McpServerDef = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
};

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

export type GraderOutput = {
  finalAnswer: string;
  middleware: Record<string, unknown>;
  scores: Array<Score & { middleware: string }>;
  evalName?: string;
  agent?: string;
  elapsedSeconds?: number;
  toolCallCount?: number;
  integrity?: {
    runIdMismatch: number;
    runIdMissing: number;
  };
};

// ────────────────────────────────────────────────────────────── Runner output

export type RunResult = {
  grader: GraderOutput;
  transcriptPath: string;
  toolLogPath: string;
  graderPath: string;
};
