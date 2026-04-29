/**
 * Codex adapter — OpenAI Responses API edition.
 *
 * Spawns `codex exec --json` with a runtime `-c` config flag overriding
 * the configured model provider's `base_url` to point at our Responses
 * proxy. Codex always uses `wire_api = "responses"` for its OpenAI-style
 * providers; the proxy speaks that wire format.
 *
 * Defaults assume the user's `~/.codex/config.toml` has a provider
 * named `openai-chat-completions` (the codex default). Override via
 * the adapter constructor for custom provider names.
 */
import { $ } from 'zx';
import type { AgentAdapter } from '../../core/types.js';
import { spawnWithStdin } from '../../core/process.js';
import { parseCodexTranscript } from './parse-transcript.js';
import { startCodexProxy } from './proxy.js';

$.verbose = false;

export type CodexAdapterOptions = {
  /** Provider name in `~/.codex/config.toml [model_providers.X]` to override. Default `openai-chat-completions`. */
  provider?: string;
  /** Model id. If omitted, codex uses its config default. */
  model?: string;
};

const DEFAULT_PROVIDER = 'openai-chat-completions';

const codexAdapter: AgentAdapter = {
  name: 'codex',

  startProxy(opts) {
    return startCodexProxy(opts);
  },

  async run(opts) {
    const provider = DEFAULT_PROVIDER;
    // Override the provider's base_url to point at our proxy. Codex
    // appends `/responses` to the configured base_url, so we hand it
    // `<proxyUrl>/v1` to land on `/v1/responses`. The TOML override
    // value is parsed as TOML, so we wrap in quotes.
    const overrides = [
      `model_providers.${provider}.base_url="${opts.proxyUrl}/v1"`,
    ];

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
    ];
    for (const o of overrides) args.push('-c', o);

    // stderr piped (not inherited) — see claude/adapter.ts.
    const proc = $({
      cwd: opts.runDir,
      env: opts.env,
      timeout: '30m',
      nothrow: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.prompt,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })`codex ${args}`;
    if (opts.onStdout) proc.stdout?.on('data', (c: Buffer) => opts.onStdout!(c));
    if (opts.onStderr) proc.stderr?.on('data', (c: Buffer) => opts.onStderr!(c));
    else proc.stderr?.pipe(process.stderr, { end: false });
    const result = await proc;
    return parseCodexTranscript(result.stdout ?? '');
  },

  callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;
    const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json'];
    if (opts?.model) args.push('-m', opts.model);
    return spawnWithStdin('codex', args, opts?.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt, {
      timeout, cwd: opts?.cwd,
    }).then((stdout) => parseCodexTranscript(stdout).answer);
  },
};

export function createCodexAdapter(opts: CodexAdapterOptions = {}): AgentAdapter {
  if (Object.keys(opts).length === 0) return codexAdapter;
  // Per-instance variant when a non-default provider is requested.
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const model = opts.model;
  return {
    ...codexAdapter,
    async run(runOpts) {
      const overrides = [`model_providers.${provider}.base_url="${runOpts.proxyUrl}/v1"`];
      const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json'];
      for (const o of overrides) args.push('-c', o);
      if (model) args.push('-m', model);
      const proc = $({
        cwd: runOpts.runDir, env: runOpts.env, timeout: '30m', nothrow: true,
        stdio: ['pipe', 'pipe', 'pipe'], input: runOpts.prompt,
        ...(runOpts.signal ? { signal: runOpts.signal } : {}),
      })`codex ${args}`;
      if (runOpts.onStdout) proc.stdout?.on('data', (c: Buffer) => runOpts.onStdout!(c));
      if (runOpts.onStderr) proc.stderr?.on('data', (c: Buffer) => runOpts.onStderr!(c));
      else proc.stderr?.pipe(process.stderr, { end: false });
      const result = await proc;
      return parseCodexTranscript(result.stdout ?? '');
    },
  };
}

export default codexAdapter;
