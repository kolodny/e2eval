/**
 * Spawn helper for adapter `callLLM` implementations.
 *
 * Pipes `prompt` to the child's stdin (NOT argv): Linux's execve caps
 * any single argv entry at 128KB (MAX_ARG_STRLEN). Large grader prompts —
 * full tool calls, transcripts, citation evidence — blow past that; the
 * child fails with E2BIG and spawnSync returns silently with empty stdout.
 * stdin has no such cap.
 *
 * Always throws on failure (spawn error, non-zero exit, timeout) rather
 * than returning an empty string — callers can't distinguish "LLM returned
 * empty" from "child never ran" otherwise.
 */
import { spawn } from 'node:child_process';

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

    child.stdin!.end(prompt);
  });
}
