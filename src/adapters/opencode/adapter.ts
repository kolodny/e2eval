/**
 * OpenCode adapter — Anthropic provider edition.
 *
 * Spawns `opencode run --format json --model <provider>/<model>` with a
 * runtime `OPENCODE_CONFIG_CONTENT` JSON injected into the env. The
 * config overrides the named provider's `baseURL` to point at our
 * Anthropic proxy. OpenCode's docs document `OPENCODE_CONFIG_CONTENT`
 * as the highest-priority config layer; opencode merges it deeply with
 * any other config files, so we only need to specify the override.
 *
 * Defaults: provider `anthropic`, model `claude-haiku-4-5`. To target a
 * different provider name (e.g. a private gateway registered in the
 * user's opencode config) or model, build a customised adapter:
 *
 *   const adapter = createOpencodeAdapter({ provider: 'my-gateway', model: '…' });
 */
import { $ } from 'zx';
import type { AgentAdapter } from '../../core/types.js';
import { spawnWithStdin } from '../../core/process.js';
import { parseOpencodeTranscript } from './parse-transcript.js';
import { startOpencodeProxy } from './proxy.js';

$.verbose = false;

export type OpencodeAdapterOptions = {
  /** Provider name to override (must exist in opencode's config or auth.json). Default `anthropic`. */
  provider?: string;
  /** Model id (without provider prefix). Default `claude-haiku-4-5`. */
  model?: string;
};

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-haiku-4-5';

/** Build the inline opencode config that overrides only the provider's baseURL. */
function buildConfigContent(provider: string, baseURL: string): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [provider]: {
        options: {
          baseURL,
          // apiKey is required by some @ai-sdk/* loaders even when the
          // upstream proxy validates auth itself. Any non-empty string works.
          apiKey: process.env.ANTHROPIC_API_KEY ?? 'e2eval-placeholder',
        },
      },
    },
  });
}

export function createOpencodeAdapter(adapterOpts: OpencodeAdapterOptions = {}): AgentAdapter {
  const provider = adapterOpts.provider ?? DEFAULT_PROVIDER;
  const model = adapterOpts.model ?? DEFAULT_MODEL;

  return {
    name: 'opencode',

    startProxy(opts) {
      return startOpencodeProxy(opts);
    },

    async run(opts) {
      // `@ai-sdk/anthropic` appends `/messages` (not `/v1/messages`) to
      // the configured baseURL. The proxy listens on `/v1/messages`, so
      // we hand opencode a base of `<proxyUrl>/v1` to land on the right
      // path. Same convention claude/Anthropic SDKs use.
      const env = {
        ...opts.env,
        OPENCODE_CONFIG_CONTENT: buildConfigContent(provider, `${opts.proxyUrl}/v1`),
      };
      // stderr piped (not inherited) — see claude/adapter.ts for why:
      // an orphaned child holding an inherited stderr fd blocks the
      // outer node:test process from exiting.
      const proc = $({
        cwd: opts.runDir,
        env,
        timeout: '30m',
        nothrow: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        input: opts.prompt,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })`opencode run --format json --model ${`${provider}/${model}`} --dangerously-skip-permissions`;
      if (opts.onStdout) proc.stdout?.on('data', (c: Buffer) => opts.onStdout!(c));
      if (opts.onStderr) proc.stderr?.on('data', (c: Buffer) => opts.onStderr!(c));
      else proc.stderr?.pipe(process.stderr, { end: false });
      const result = await proc;
      return parseOpencodeTranscript(result.stdout ?? '');
    },

    callLLM(prompt, opts) {
      const timeout = opts?.timeout ?? 240_000;
      // Stand-alone single-shot — uses opencode `run` with no tools by
      // setting `--agent build-no-tools` if available, otherwise just
      // sends the prompt and returns the answer text. Resume isn't
      // supported here yet (would need session forking).
      const args = ['run', '--format', 'json', '--model', `${provider}/${opts?.model ?? model}`];
      if (opts?.systemPrompt) {
        // opencode CLI doesn't take a --system flag in `run`; the system
        // prompt is bundled into the user message instead.
        return spawnWithStdin('opencode', args, `${opts.systemPrompt}\n\n${prompt}`, {
          timeout, cwd: opts?.cwd,
        }).then((stdout) => parseOpencodeTranscript(stdout).answer);
      }
      return spawnWithStdin('opencode', args, prompt, {
        timeout, cwd: opts?.cwd,
      }).then((stdout) => parseOpencodeTranscript(stdout).answer);
    },
  };
}

const opencodeAdapter = createOpencodeAdapter();
export default opencodeAdapter;
