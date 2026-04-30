/**
 * OpenCode adapter — Anthropic provider edition.
 *
 * Spawns `opencode run --format json --model <provider>/<model>` with a
 * runtime `OPENCODE_CONFIG_CONTENT` JSON injected into the env. The
 * config overrides the named provider's `baseURL` to point at our
 * Anthropic proxy. OpenCode's docs document `OPENCODE_CONFIG_CONTENT`
 * as the highest-priority config layer; opencode merges it deeply with
 * any other config files, so we only need to specify the override.
 * Output is line-streamed through a parser that holds only
 * `{answer, sessionId}` so memory is bounded regardless of run length.
 *
 * Defaults: provider `anthropic`, model `claude-haiku-4-5`. To target a
 * different provider name (e.g. a private gateway registered in the
 * user's opencode config) or model, build a customised adapter:
 *
 *   const adapter = createOpencodeAdapter({ provider: 'my-gateway', model: '…' });
 */
import type { AgentAdapter } from '../../core/types.js';
import { spawnStreaming, spawnWithStdin } from '../../core/process.js';
import { createStreamingOpencodeParser } from './parse-transcript.js';
import { startOpencodeProxy } from './proxy.js';

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
      const parser = createStreamingOpencodeParser();
      await spawnStreaming({
        cmd: 'opencode',
        args: ['run', '--format', 'json', '--model', `${provider}/${model}`, '--dangerously-skip-permissions'],
        cwd: opts.runDir,
        env,
        stdin: opts.prompt,
        timeoutMs: 30 * 60_000,
        signal: opts.signal,
        onStdoutChunk: opts.onStdout,
        onStderrChunk: opts.onStderr,
        onStdoutLine: (line) => parser.feed(line),
      });
      return parser.finalize();
    },

    async callLLM(prompt, opts) {
      const timeout = opts?.timeout ?? 240_000;
      // Stand-alone single-shot — uses opencode `run` with no tools by
      // setting `--agent build-no-tools` if available, otherwise just
      // sends the prompt and returns the answer text. Resume isn't
      // supported here yet (would need session forking).
      const args = ['run', '--format', 'json', '--model', `${provider}/${opts?.model ?? model}`];
      // opencode CLI doesn't take a --system flag in `run`; the system
      // prompt is bundled into the user message instead.
      const stdinText = opts?.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
      const stdout = await spawnWithStdin('opencode', args, stdinText, {
        timeout, cwd: opts?.cwd,
      });
      const parser = createStreamingOpencodeParser();
      for (const line of stdout.split('\n')) if (line) parser.feed(line);
      return parser.finalize().answer;
    },
  };
}

const opencodeAdapter = createOpencodeAdapter();
export default opencodeAdapter;
