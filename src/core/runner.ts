/**
 * Eval runner — the execution engine.
 *
 * Public API:
 *   startRunner(config) → EvalRunner  — boots middleware server
 *   runner.run(ev)      → EvalResult  — runs one eval
 *   runner.close()                    — tears down middleware server
 *
 * Internal:
 *   runEval(ev, opts) — per-eval execution (called by runner.run)
 *   grade(opts)       — runs afterEval middleware chain
 */
import { fs, $ } from 'zx';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter, CallLLM, Config, Eval, GraderOutput,
  Middleware, RunResult, Score, ToolCall,
} from './types.js';
import { startMiddlewareServer, type MiddlewareServer } from './middleware-server.js';
import { wrapMcpStack } from './mcp/wrap.js';
import { readToolLog } from './mcp/tool-log.js';

$.verbose = false;

// ────────────────────────────────────────────────────────────── Public API

export type RunnerConfig = {
  adapter: AgentAdapter;
  middleware?: readonly Middleware[];
  ignoreMcps?: string[];
  callLLM?: CallLLM;
};

export type EvalRunOpts = {
  out?: string;
  /** Remove the per-run scratch dir (`.eval_runs/run_<id>`) after the run. Defaults to true; set `false` to keep it for debugging. */
  cleanupRunDir?: boolean;
};

export type EvalResult = RunResult;

export type EvalRunner = {
  run(ev: Eval, opts?: EvalRunOpts): Promise<EvalResult>;
  close(): Promise<void>;
};

export async function startRunner(config: RunnerConfig): Promise<EvalRunner> {
  const middlewareServer = await startMiddlewareServer(config.middleware ?? []);

  return {
    async run(ev, opts = {}) {
      const out = opts.out ?? path.join(os.tmpdir(), `eval-${ev.name}`);
      return runEval(ev, {
        adapter: config.adapter,
        out,
        middleware: config.middleware,
        ignoreMcps: config.ignoreMcps,
        middlewareServer,
        cleanupRunDir: opts.cleanupRunDir,
        callLLM: config.callLLM,
      });
    },
    async close() {
      await middlewareServer.close();
    },
  };
}

// ────────────────────────────────────────────────────────────── runEval

type RunOptions = {
  adapter: AgentAdapter;
  out: string;
  ignoreMcps?: string[];
  middleware?: readonly Middleware[];
  cleanupRunDir?: boolean;
  middlewareServer?: MiddlewareServer;
  callLLM?: CallLLM;
};

async function runEval(ev: Eval, opts: RunOptions): Promise<RunResult> {
  const adapter = opts.adapter;

  // Resolve out to an absolute path once — the sibling paths travel through
  // subprocesses (MCP wrapper, agent CLI) whose cwd is `runDir`, not the
  // caller's cwd. Any relative component would silently resolve against the
  // wrong directory and writes would fail with ENOENT.
  const resolvedOut = path.resolve(opts.out);
  const transcriptPath = `${resolvedOut}.${adapter.name}.jsonl`;
  const toolLogPath = `${resolvedOut}.${adapter.name}.tool-log.jsonl`;
  const graderPath = `${resolvedOut}.${adapter.name}.grader.json`;
  const stderrPath = `${resolvedOut}.${adapter.name}.stderr.log`;

  for (const p of [transcriptPath, toolLogPath, graderPath, stderrPath]) {
    await fs.remove(p);
  }

  const startTime = Date.now();
  const runId = randomUUID();
  const shortId = runId.slice(0, 8);
  const runDir = path.join(process.cwd(), '.eval_runs', `run_${shortId}`);
  const ac = new AbortController();
  const abort = (reason?: unknown) => ac.abort(reason);

  await fs.ensureDir(runDir);
  try {
    const evalConfig: Record<string, unknown> = { ...(ev.config ?? {}) };

    const configPath = path.join(runDir, 'eval-config.json');
    await fs.writeJson(configPath, evalConfig, { spaces: 2 });

    let mcpConfigPath: string | null = null;
    let discoveredEnv: Record<string, string> = {};
    if (adapter.supportsMcp) {
      const { mcpServers, env: mcpEnv } = adapter.discoverMcpStack(process.cwd());
      if (mcpEnv) discoveredEnv = mcpEnv;
      const wrapped = wrapMcpStack({
        mcpServers,
        skip: opts.ignoreMcps ?? [],
      });
      mcpConfigPath = path.join(runDir, 'mcp.json');
      await fs.writeJson(mcpConfigPath, wrapped, { spaces: 2 });
    }

    let prompt = ev.question;
    for (const mw of opts.middleware ?? []) {
      if (!mw.beforeEval) continue;
      const result = await mw.beforeEval({ evalName: ev.name, prompt, config: evalConfig as any, abort });
      if (result?.replacePromptWith) prompt = result.replacePromptWith;
    }

    opts.middlewareServer?.registerRun({
      evalName: ev.name,
      config: evalConfig as any,
      toolLogPath,
      runId,
      abort,
    });

    const middlewareServerUrl = opts.middlewareServer
      ? `http://127.0.0.1:${opts.middlewareServer.port}`
      : '';

    await adapter.run({
      prompt,
      mcpConfigPath,
      runDir,
      env: {
        ...process.env as Record<string, string>,
        ...discoveredEnv,
        EVAL_CONFIG: configPath,
        EVAL_TOOL_LOG: toolLogPath,
        EVAL_RUN_ID: runId,
        EVAL_PLUGIN_SERVER: middlewareServerUrl,
      },
      transcriptPath,
      stderrPath,
      signal: ac.signal,
    });

    // Middleware can abort via the HTTP bridge; surface that as a rejection.
    if (ac.signal.aborted) {
      throw ac.signal.reason instanceof Error
        ? ac.signal.reason
        : new Error(String(ac.signal.reason ?? 'run aborted'));
    }

    const runIdCheck = checkToolLogRunId(toolLogPath, runId);
    const { finalAnswer, sessionId } = adapter.parseTranscript(transcriptPath);
    const toolCalls = readToolLog(toolLogPath);

    const baseCallLLM = opts.callLLM ?? adapter.callLLM;
    const callLLM: CallLLM = (prompt, callOpts) =>
      baseCallLLM(prompt, { ...callOpts, cwd: runDir, ...(callOpts?.resume && sessionId ? { sessionId } : {}) });

    const graderOutput = await grade({
      evalName: ev.name,
      question: ev.question,
      finalAnswer,
      toolCalls,
      config: evalConfig as any,
      middleware: opts.middleware ?? [],
      callLLM,
      stderrPath,
      abort,
    });

    graderOutput.evalName = ev.name;
    graderOutput.agent = adapter.name;
    graderOutput.elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    graderOutput.toolCallCount = toolCalls.length;
    graderOutput.integrity = {
      runIdMismatch: runIdCheck.mismatch,
      runIdMissing: runIdCheck.missing,
    };

    await fs.writeJson(graderPath, graderOutput, { spaces: 2 });

    return { grader: graderOutput, transcriptPath, toolLogPath, graderPath };
  } finally {
    opts.middlewareServer?.unregisterRun(runId);
    if (opts.cleanupRunDir !== false) {
      await fs.remove(runDir).catch(() => {});
      // rmdir (not remove) — succeeds only if `.eval_runs` is empty, so
      // concurrent runs keep the parent alive until the last one finishes.
      await fs.rmdir(path.join(process.cwd(), '.eval_runs')).catch(() => {});
    }
  }
}

// ────────────────────────────────────────────────────────────── grade

async function grade(opts: {
  evalName: string;
  question: string;
  finalAnswer: string;
  toolCalls: ToolCall[];
  config: Readonly<Config>;
  middleware: readonly Middleware[];
  callLLM: CallLLM;
  stderrPath: string;
  abort: (reason?: unknown) => void;
}): Promise<GraderOutput> {
  const { question, finalAnswer, toolCalls } = opts;

  const scores: Array<Score & { middleware: string }> = [];
  const middlewareOutputs: Record<string, unknown> = {};

  for (const mw of opts.middleware) {
    if (!mw.afterEval) continue;
    const result = await mw.afterEval({
      evalName: opts.evalName,
      question,
      answer: finalAnswer,
      toolCalls,
      config: opts.config,
      scores,
      callLLM: opts.callLLM,
      stderrPath: opts.stderrPath,
      abort: opts.abort,
    });
    if (result?.data !== undefined) middlewareOutputs[mw.name] = result.data;
    if (result?.score) scores.push({ middleware: mw.name, ...result.score });
  }

  return {
    finalAnswer,
    middleware: middlewareOutputs,
    scores,
  };
}

// ────────────────────────────────────────────────────────────── Integrity checks

function checkToolLogRunId(logPath: string, expected: string) {
  if (!existsSync(logPath)) return { mismatch: 0, missing: 0 };
  const src = readFileSync(logPath, 'utf8');
  if (!src) return { mismatch: 0, missing: 0 };
  let mismatch = 0, missing = 0;
  for (const line of src.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.runId !== 'string') missing += 1;
      else if (e.runId !== expected) mismatch += 1;
    } catch { missing += 1; }
  }
  return { mismatch, missing };
}

