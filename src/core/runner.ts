/**
 * Eval runner — proxy-based, no per-run output files.
 *
 *   startRunner(config) → EvalRunner
 *   runner.run(ev)      → EvalResult
 *   runner.close()      → tears down per-runner scratch unless `cleanupOnClose: false`
 *
 * Per-run flow:
 *   1. Start a per-agent proxy. The proxy collects tool calls into an
 *      in-process array via the `onToolCall` callback the runner provides.
 *   2. Run `beforeEval` middleware — they may rewrite the prompt.
 *   3. Spawn the agent with `proxyUrl` so its provider env var points at
 *      us. The adapter returns a parsed `NormalizedTranscript`.
 *   4. Run `afterEval` (grading) middleware. Each return is recorded
 *      under `result.results[<middleware-name>]`.
 *   5. Stop the proxy.
 *
 * Tool calls live in memory; the agent's transcript is consumed inline;
 * afterEval receives `toolCalls` directly. The agent's own session
 * logs (e.g. claude's `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`)
 * are still written by the agent itself for post-hoc inspection.
 */
import { fs } from 'zx';
import path from 'node:path';

import type {
  AgentAdapter, AgentProxy, CallLLM, Data, Eval, EvalResult,
  Middleware, Recording, ToolCall,
} from './types.js';

// ────────────────────────────────────────────────────────────── Public API

export type RunnerConfig = {
  adapter: AgentAdapter;
  middleware?: readonly Middleware[];
  callLLM?: CallLLM;
  /** Override the upstream URL the proxy forwards to. */
  upstream?: string;
  /**
   * Whether `runner.close()` (and the SIGINT/SIGTERM/exit handlers
   * installed at `startRunner`) should recursively remove
   * `<cwd>/.eval_runs/`. Defaults to `true`.
   *
   * Set to `false` when multiple runner processes might be running
   * concurrently against the same project tree (e.g. parallel test
   * runners), since one runner's cleanup would yank the scratch dirs
   * out from under another's in-flight evals. In that case, do the
   * cleanup yourself once all runners are done — for tests, a
   * `posttest` script is the natural place.
   */
  cleanupOnClose?: boolean;
};

export type EvalRunOpts = {
  /**
   * Wall-clock budget for this run. When elapsed, the run aborts: the
   * agent process is killed and `runner.run()` rejects with a timeout
   * error. Default is no timeout (only the adapter's own per-spawn
   * timeout, e.g. claude's 30m, applies).
   */
  timeoutMs?: number;
  /**
   * Capture every upstream round-trip (raw request + response bytes)
   * and expose them on `EvalResult.recording`. Pass that recording to
   * a later `runner.run(ev, { replay })` to reproduce the same
   * conversation deterministically up to a cutoff point.
   */
  record?: boolean;
  /**
   * Replay a prior `EvalResult.recording` for the first `upTo` upstream
   * exchanges, then forward to the live upstream after. The proxy
   * auto-short-circuits any tool calls that occur during the replayed
   * prefix, splicing in the recorded tool_results — so the agent sees
   * the original conversation byte-for-byte until the cutoff, then
   * makes real LLM calls with whatever new tools/MCPs/config you've
   * added.
   *
   *   const ran = await runner.run(ev, { record: true });
   *   const ran2 = await runner.run(ev, { replay: { recording: ran.recording!, upTo: 5 } });
   */
  replay?: {
    recording: Recording;
    upTo: number;
  };
};

export type EvalRunner = {
  run(ev: Eval, opts?: EvalRunOpts): Promise<EvalResult>;
  close(): Promise<void>;
};

export async function startRunner(config: RunnerConfig): Promise<EvalRunner> {
  // Middleware names key the `results` map and error messages from the
  // chain. Duplicates are almost always a misconfig — fail fast at
  // construction.
  const seen = new Set<string>();
  for (const mw of config.middleware ?? []) {
    if (seen.has(mw.name)) {
      throw new Error(`duplicate middleware name: "${mw.name}"`);
    }
    seen.add(mw.name);
  }

  // Per-runner shared parent for run scratch dirs. Lives in the user's
  // CWD so claude (and other agents) walk up from `cwd` and find the
  // project's `.mcp.json` / `.claude/settings.json`. Hidden in a
  // dedicated subdir so claude session JSONLs created during eval runs
  // (which live under `~/.claude/projects/<encoded-cwd>/`) don't show
  // up in the user's normal `/resume` list — that's keyed off
  // `process.cwd()`, and our cwd is one level deeper.
  const runDirParent = path.join(process.cwd(), '.eval_runs');

  // Default: clean up. If `E2EVAL_NO_CLEANUP=1` is set in the env,
  // flip the default to off — useful for parallel test runners where
  // multiple runner instances share `<cwd>/.eval_runs/` and one
  // runner's cleanup would yank dirs out from under another.
  const cleanupOnClose = config.cleanupOnClose
    ?? (process.env.E2EVAL_NO_CLEANUP !== '1');

  // Best-effort cleanup on process exit. Without this, ctrl+c during a
  // running eval leaves `.eval_runs/` behind. The handler is sync —
  // node won't await async work in a SIGINT handler — so we use the
  // sync remove. Errors are swallowed; we'd rather skip cleanup than
  // crash the user's process on the way out. Skipped when
  // `cleanupOnClose: false` so concurrent runners don't yank the dir
  // out from under each other. Stored so close() can detach them —
  // otherwise N runners pile up 3N listeners and trip the
  // MaxListenersExceededWarning at 10.
  const onExit = () => { try { fs.removeSync(runDirParent); } catch {} };
  const onSigint = () => { onExit(); process.exit(130); };
  const onSigterm = () => { onExit(); process.exit(143); };
  if (cleanupOnClose) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('exit', onExit);
  }

  return {
    async run(ev, opts = {}) {
      return runEval(ev, {
        adapter: config.adapter,
        middleware: config.middleware,
        runDirParent,
        timeoutMs: opts.timeoutMs,
        record: opts.record,
        replay: opts.replay,
        callLLM: config.callLLM,
        upstream: config.upstream,
      });
    },
    async close() {
      // Detach the signal/exit listeners we registered. process.once
      // self-clears on fire, but in normal close() flow they never
      // fire — leaving them attached leaks listeners across runners.
      if (cleanupOnClose) {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('exit', onExit);
      }
      // Recursive remove: per-eval subdirs persist between runs (so
      // sequential `runner.run()` calls of the same eval reuse the
      // same `cwd` and claude can `--resume` across them). They get
      // cleaned up once when the runner shuts down — unless
      // `cleanupOnClose: false`, in which case the caller owns it.
      if (cleanupOnClose) {
        await fs.remove(runDirParent).catch(() => {});
      }
    },
  };
}

// ────────────────────────────────────────────────────────────── runEval

type RunOptions = {
  adapter: AgentAdapter;
  middleware?: readonly Middleware[];
  /** Per-runner parent directory that holds all per-run scratch dirs. */
  runDirParent: string;
  timeoutMs?: number;
  record?: boolean;
  replay?: { recording: Recording; upTo: number };
  callLLM?: CallLLM;
  upstream?: string;
};

async function runEval(ev: Eval, opts: RunOptions): Promise<EvalResult> {
  const adapter = opts.adapter;

  const startTime = Date.now();
  // Per-eval scratch directory used as the agent process's `cwd`.
  // Name is **deterministic** from the eval name: claude derives the
  // session-JSONL path from cwd (`~/.claude/projects/<encoded-cwd>/`),
  // so a stable cwd makes sessions from any prior run of this eval
  // discoverable. Random suffixes would scatter sessions across many
  // `~/.claude/projects/` directories and break `callLLM({ resume })`
  // across process invocations.
  //
  // Sits under `<cwd>/.eval_runs/` (hidden subdir of the user's project
  // tree) so:
  //   - claude walks up and finds `.mcp.json` / `.claude/settings.json`.
  //   - eval session JSONLs live under a separate
  //     `~/.claude/projects/<encoded-eval-cwd>/` and don't appear in the
  //     user's normal `/resume` list (which is keyed off `process.cwd()`).
  //
  // Concurrent runs of the same eval safely share this dir — claude
  // generates unique session IDs and writes to different files. We
  // never write to it ourselves.
  const safeName = ev.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
  const runDir = path.join(opts.runDirParent, safeName);
  const ac = new AbortController();
  const abort = (reason?: unknown) => ac.abort(reason);

  await fs.ensureDir(runDir);
  // Per-eval timeout: fire abort once the budget elapses. The signal
  // already aborts the agent spawn (claude is killed on signal) and the
  // post-run check below converts the abort into a thrown error.
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      ac.abort(new Error(`eval "${ev.name}" timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  }
  let proxy: AgentProxy | undefined;
  try {
    const evalConfig: Record<string, unknown> = { ...(ev.config ?? {}) };
    // Per-run mutable scratch for cross-phase / cross-middleware state.
    // Same object identity flows through beforeEval → onToolCall → afterEval.
    const data: Data = {} as Data;

    let prompt = ev.question;
    for (const mw of opts.middleware ?? []) {
      if (!mw.beforeEval) continue;
      const result = await mw.beforeEval({
        evalName: ev.name,
        prompt,
        config: evalConfig as any,
        data,
        abort,
      });
      if (result?.replacePromptWith) prompt = result.replacePromptWith;
    }

    const toolCalls: ToolCall[] = [];
    // Capture upstream round-trips when record is on. The adapter's
    // proxy emits via onExchange; we accumulate raw bytes here.
    const exchanges: Array<{ request: string; response: string }> = [];
    const onExchange = opts.record
      ? (request: string, response: string) => { exchanges.push({ request, response }); }
      : undefined;

    proxy = await adapter.startProxy({
      evalName: ev.name,
      config: evalConfig as any,
      data,
      middleware: opts.middleware ?? [],
      onToolCall: (call) => { toolCalls.push(call); },
      abort,
      upstream: opts.upstream,
      onExchange,
      replay: opts.replay,
    });

    const transcript = await adapter.run({
      prompt,
      proxyUrl: proxy.url,
      runDir,
      env: { ...process.env as Record<string, string> },
      signal: ac.signal,
    });

    if (ac.signal.aborted) {
      throw ac.signal.reason instanceof Error
        ? ac.signal.reason
        : new Error(String(ac.signal.reason ?? 'run aborted'));
    }

    const baseCallLLM = opts.callLLM ?? adapter.callLLM;
    const sessionId = transcript.sessionId;
    const callLLM: CallLLM = (p, callOpts) =>
      baseCallLLM(p, { ...callOpts, cwd: runDir, ...(callOpts?.resume && sessionId ? { sessionId } : {}) });

    const results = await grade({
      evalName: ev.name,
      question: ev.question,
      answer: transcript.answer,
      toolCalls,
      config: evalConfig as any,
      data,
      middleware: opts.middleware ?? [],
      callLLM,
      abort,
    });

    return {
      answer: transcript.answer,
      results,
      toolCalls,
      evalName: ev.name,
      agent: adapter.name,
      elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      ...(opts.record ? { recording: { exchanges } } : {}),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (proxy) await proxy.close().catch(() => {});
    // We do NOT remove `runDir` per-run: the dir is keyed
    // deterministically off the eval name so concurrent runs of the
    // same eval share it (and so claude's `~/.claude/projects/<encoded-cwd>/`
    // session location stays stable for `--resume`). Cleanup happens
    // once in `runner.close()`.
  }
}

// ────────────────────────────────────────────────────────────── grade

async function grade(opts: {
  evalName: string;
  question: string;
  answer: string;
  toolCalls: ToolCall[];
  config: Readonly<Record<string, unknown>>;
  data: Data;
  middleware: readonly Middleware[];
  callLLM: CallLLM;
  abort: (reason?: unknown) => void;
}): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  for (const mw of opts.middleware) {
    if (!mw.afterEval) continue;
    const result = await mw.afterEval({
      evalName: opts.evalName,
      question: opts.question,
      answer: opts.answer,
      toolCalls: opts.toolCalls,
      config: opts.config as any,
      data: opts.data,
      results,
      callLLM: opts.callLLM,
      abort: opts.abort,
    });
    if (result != null) results[mw.name] = result;
  }

  return results;
}
