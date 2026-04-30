/**
 * Spawn helpers for adapters.
 *
 *   spawnWithStdin    — buffered, single-shot. For `callLLM`: pipes `prompt`
 *                       to stdin, collects all stdout, throws on failure.
 *   spawnStreaming    — line-streamed, long-running. For `adapter.run`: pipes
 *                       `stdin` then forwards each stdout line to a callback
 *                       as it arrives. Holds O(longest line) at any moment
 *                       instead of the full transcript, which matters for
 *                       multi-MB stream-json output across long agent runs.
 *
 * Why stdin not argv for the prompt: Linux's execve caps a single argv
 * entry at 128KB (MAX_ARG_STRLEN). Large prompts blow past that; the
 * child fails with E2BIG and spawnSync returns silently with empty
 * stdout. stdin has no such cap.
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function spawnWithStdin(
  cmd: string,
  args: string[],
  prompt: string,
  opts: { timeout: number; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: opts.env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeout);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout!.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr!.on('data', (c: Buffer) => stderrChunks.push(c));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${opts.timeout}ms\n${stderr.slice(-2000)}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${cmd} exited ${code}${signal ? ` (${signal})` : ''}\n${stderr.slice(-2000)}`));
        return;
      }
      resolve(stdout);
    });

    // If the child crashes before Node finishes the stdin write (E2BIG,
    // startup panic, auth failure, etc.), the pipe closes mid-write and
    // Node emits 'error'. Without a listener that becomes an unhandled
    // error and crashes the runner. Swallow it — the 'close' handler
    // above surfaces the real exit code and stderr tail.
    child.stdin!.on('error', () => {});
    child.stdin!.end(prompt);
  });
}

// ────────────────────────────────────────────────────────────── spawnStreaming

export type SpawnStreamingOpts = {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin then closed. */
  stdin: string;
  /** Wall-clock kill budget. Child receives SIGKILL on expiry. */
  timeoutMs: number;
  /** AbortSignal — child receives SIGKILL when aborted (Node native, no grace). */
  signal?: AbortSignal;
  /** Forward each stdout chunk verbatim — used by `EvalRunOpts.onStdout`. */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** Forward each stderr chunk verbatim. If unset, stderr is piped to `process.stderr`. */
  onStderrChunk?: (chunk: Buffer) => void;
  /** Called once per complete stdout line, in order. Trailing line without `\n` is flushed on close. */
  onStdoutLine: (line: string) => void;
};

/**
 * Long-running spawn with line-streamed stdout — for agent CLIs that
 * emit JSONL transcripts (claude `--output-format=stream-json`, codex
 * `--json`, opencode `--format json`). The caller hands a parser
 * callback; we feed it each complete line as the child emits it,
 * holding only one partial line in memory at any moment.
 *
 * Resolves on close regardless of exit code or timeout — agents
 * frequently exit non-zero (transient API errors, killed by abort
 * signal) yet leave a usable partial transcript. The caller decides
 * what to do based on parser state plus the abort signal it owns.
 *
 * Multi-byte UTF-8 sequences split across stdout chunks are handled
 * via `StringDecoder` so the line-splitter never sees half a codepoint.
 */
export function spawnStreaming(opts: SpawnStreamingOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    // `killSignal: 'SIGKILL'` makes Node hard-kill on abort instead of
    // the default SIGTERM. Wedged agents (e.g. claude waiting for a
    // tool_result that'll never arrive after the model emitted a
    // malformed tool_use) ignore SIGTERM, so without this an
    // aborted-but-stuck child stays pinned until the adapter-level
    // kill budget expires (~30m).
    const child = spawn(opts.cmd, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: opts.env,
      ...(opts.signal ? { signal: opts.signal, killSignal: 'SIGKILL' } : {}),
    });

    const decoder = new StringDecoder('utf8');
    let leftover = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);

    child.stdout!.on('data', (c: Buffer) => {
      if (opts.onStdoutChunk) opts.onStdoutChunk(c);
      leftover += decoder.write(c);
      let nl: number;
      while ((nl = leftover.indexOf('\n')) >= 0) {
        const line = leftover.slice(0, nl);
        leftover = leftover.slice(nl + 1);
        if (line) opts.onStdoutLine(line);
      }
    });

    if (opts.onStderrChunk) {
      child.stderr!.on('data', (c: Buffer) => opts.onStderrChunk!(c));
    } else {
      child.stderr!.pipe(process.stderr, { end: false });
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      // AbortSignal-triggered kills surface as ERR_ABORTED — let the
      // runner's own signal-handling raise; we have nothing to add.
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') { resolve(); return; }
      reject(err);
    });

    child.on('close', () => {
      clearTimeout(timer);
      const tail = leftover + decoder.end();
      if (tail) opts.onStdoutLine(tail);
      resolve();
    });

    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.stdin);
  });
}
