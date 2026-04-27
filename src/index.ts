/**
 * Public API surface for the eval framework.
 *
 *   import { startRunner, claudeAdapter } from 'e2eval';
 *
 *   const runner = await startRunner({ adapter: claudeAdapter, middleware: [...] });
 *   const ran = await runner.run(myEval);
 *   console.log(ran.answer, ran.results);
 *   await runner.close();
 */

// Session API
export { startRunner, type EvalRunner, type RunnerConfig, type EvalRunOpts } from './core/runner.js';

// Framework types
export type {
  Eval,
  EvalResult,
  Middleware,
  MiddlewareContext,
  OnToolCallArg,
  BeforeEvalContext,
  BeforeEvalResult,
  AfterEvalContext,
  AgentAdapter,
  AgentProxy,
  StartProxyOpts,
  NormalizedTranscript,
  CallLLM,
  CallLLMOpts,
  Config,
  Data,
  Recording,
  ToolCall,
  ToolResult,
  ContentBlock,
  Handler,
} from './core/types.js';

// Proxy helpers (for adapter authors writing their own provider proxy)
export {
  startChain,
  stringifyToolResult,
  type ChainCtx,
  type ChainOutcome,
} from './core/proxy/middleware.js';

// Utilities (for middleware authors)
export { escapeXml, tryParseJson, normaliseForMatch, longestCommonSubstringRatio } from './core/utils.js';

// Adapters
export { default as claudeAdapter } from './adapters/claude/adapter.js';
export { default as opencodeAdapter, createOpencodeAdapter, type OpencodeAdapterOptions } from './adapters/opencode/adapter.js';
export { default as codexAdapter, createCodexAdapter, type CodexAdapterOptions } from './adapters/codex/adapter.js';

// Test adapters (for e2e tests of middleware/runner without hitting upstream APIs)
export {
  createClaudeTestAdapter,
  type AgentScript,
  type ScriptedBlock,
  type ScriptedResponse,
  type ScriptedRequest,
  type RespondFn,
  type RespondContext,
  type MessageParam,
  type MessageCreateParams,
} from './adapters/claude/test.js';
export {
  createOpencodeTestAdapter,
  type CreateOpencodeTestAdapterOptions,
} from './adapters/opencode/test.js';
export {
  createCodexTestAdapter,
  type CodexAgentScript,
  type CodexScriptedResponse,
  type CodexScriptedRequest,
  type CodexRespondFn,
  type CodexRespondContext,
  type CodexOutputItem,
} from './adapters/codex/test.js';
