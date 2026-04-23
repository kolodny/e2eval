/**
 * Public API surface for the eval framework.
 *
 *   import { startRunner, claudeAdapter } from 'e2eval';
 *
 *   const runner = await startRunner({ adapter: claudeAdapter, middleware: [...] });
 *   const result = await runner.run(myEval);
 *   console.log(result.grader.scores);
 *   await runner.close();
 */

// Session API
export { startRunner, type EvalRunner, type RunnerConfig, type EvalRunOpts, type EvalResult } from './core/runner.js';

// Framework types
export type {
  Eval,
  Middleware,
  MiddlewareContext,
  OnToolCallArg,
  AfterToolCallArg,
  BeforeEvalContext,
  BeforeEvalResult,
  AfterEvalContext,
  AfterEvalResult,
  AgentAdapter,
  CallLLM,
  Config,
  Score,
  ToolCall,
  GraderOutput,
  RunResult,
} from './core/types.js';

// Utilities (for middleware authors)
export { escapeXml, tryParseJson, normaliseForMatch, longestCommonSubstringRatio } from './core/utils.js';

// Adapters
export { default as claudeAdapter } from './adapters/claude/adapter.js';
export { default as opencodeAdapter } from './adapters/opencode/adapter.js';
export { default as codexAdapter } from './adapters/codex/adapter.js';
export { builtinAdapters } from './adapters/index.js';
