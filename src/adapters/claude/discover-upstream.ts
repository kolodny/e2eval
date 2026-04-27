/**
 * Runtime discovery of `ANTHROPIC_BASE_URL` via a UserPromptSubmit
 * hook. We spawn `claude -p` with a hook that captures the resolved
 * env var to a temp file and exits 2 — the prompt is blocked before
 * any API call, but the hook has already run with claude's full
 * settings chain merged (managed → user → project → process env).
 *
 * Why: that precedence chain is claude's own internal contract.
 * Mirroring it client-side would couple us to claude's internals;
 * asking claude itself, via a hook, is authoritative.
 *
 * Cost: ~3-4s claude startup. No upstream call (hook exits before any
 * network round-trip), no session persisted (`--no-session-persistence`).
 * The result is memoized at module scope: the first caller pays, every
 * subsequent caller is free.
 */
import { rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { $ } from 'zx';

let cached: Promise<string | undefined> | undefined;

/**
 * Returns the `ANTHROPIC_BASE_URL` claude resolves at runtime, or
 * `undefined` if claude has none set or the probe fails (e.g. claude
 * not on PATH). Memoized — safe to call repeatedly.
 */
export function discoverClaudeUpstream(): Promise<string | undefined> {
  if (!cached) cached = probe();
  return cached;
}

/** For tests / scripts that need to force a re-probe. */
export function resetClaudeUpstreamCache(): void {
  cached = undefined;
}

async function probe(): Promise<string | undefined> {
  const probeFile = path.join(tmpdir(), `e2eval-claude-probe-${randomUUID()}.txt`);
  // The hook command runs in claude's process env, so `$ANTHROPIC_BASE_URL`
  // is whatever claude resolved from its settings chain. `printf %s`
  // (no trailing newline) makes the captured value byte-clean.
  const settings = JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        hooks: [{
          type: 'command',
          command: `printf %s "$ANTHROPIC_BASE_URL" > ${probeFile}; exit 2`,
        }],
      }],
    },
  });
  try {
    await $({
      input: '',
      nothrow: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })`claude -p x --no-session-persistence --settings ${settings} --output-format=json`;
    const url = (await readFile(probeFile, 'utf8').catch(() => '')).trim();
    return url || undefined;
  } catch {
    return undefined;
  } finally {
    await rm(probeFile, { force: true }).catch(() => {});
  }
}
