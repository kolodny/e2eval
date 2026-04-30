/**
 * Codex adapter — OpenAI Responses API edition.
 *
 * Spawns `codex exec --json` with a runtime `-c` config flag overriding
 * the configured model provider's `base_url` to point at our Responses
 * proxy. Codex always uses `wire_api = "responses"` for its OpenAI-style
 * providers; the proxy speaks that wire format. Output is line-streamed
 * through a parser that holds only `{answer, sessionId}` so memory is
 * bounded regardless of run length.
 *
 * Defaults assume the user's `~/.codex/config.toml` has a provider
 * named `openai-chat-completions` (the codex default). Override via
 * the adapter constructor for custom provider names.
 */
import type { AgentAdapter, AgentRunOpts } from '../../core/types.js';
import { spawnStreaming, spawnWithStdin } from '../../core/process.js';
import { createStreamingCodexParser } from './parse-transcript.js';
import { startCodexProxy } from './proxy.js';

export type CodexAdapterOptions = {
  /** Provider name in `~/.codex/config.toml [model_providers.X]` to override. Default `openai-chat-completions`. */
  provider?: string;
  /** Model id. If omitted, codex uses its config default. */
  model?: string;
};

const DEFAULT_PROVIDER = 'openai-chat-completions';

function buildCodexArgs(provider: string, proxyUrl: string, model: string | undefined): string[] {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    // The provider's base_url is the override point. Codex appends
    // `/responses` to it, so we hand `<proxyUrl>/v1` to land on
    // `/v1/responses`. The TOML override value is parsed as TOML, so
    // we wrap in quotes.
    '-c', `model_providers.${provider}.base_url="${proxyUrl}/v1"`,
  ];
  if (model) args.push('-m', model);
  return args;
}

async function runCodex(
  provider: string,
  model: string | undefined,
  opts: AgentRunOpts,
) {
  const parser = createStreamingCodexParser();
  await spawnStreaming({
    cmd: 'codex',
    args: buildCodexArgs(provider, opts.proxyUrl, model),
    cwd: opts.runDir,
    env: opts.env,
    stdin: opts.prompt,
    timeoutMs: 30 * 60_000,
    signal: opts.signal,
    onStdoutChunk: opts.onStdout,
    onStderrChunk: opts.onStderr,
    onStdoutLine: (line) => parser.feed(line),
  });
  return parser.finalize();
}

const codexAdapter: AgentAdapter = {
  name: 'codex',

  startProxy(opts) {
    return startCodexProxy(opts);
  },

  run(opts) {
    return runCodex(DEFAULT_PROVIDER, undefined, opts);
  },

  async callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;
    const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json'];
    if (opts?.model) args.push('-m', opts.model);
    const stdout = await spawnWithStdin('codex', args, opts?.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt, {
      timeout, cwd: opts?.cwd,
    });
    const parser = createStreamingCodexParser();
    for (const line of stdout.split('\n')) if (line) parser.feed(line);
    return parser.finalize().answer;
  },
};

export function createCodexAdapter(opts: CodexAdapterOptions = {}): AgentAdapter {
  if (Object.keys(opts).length === 0) return codexAdapter;
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const model = opts.model;
  return {
    ...codexAdapter,
    run(runOpts) { return runCodex(provider, model, runOpts); },
  };
}

export default codexAdapter;
