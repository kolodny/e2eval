/**
 * Claude Code adapter — proxy edition.
 *
 * Spawns claude with stream-json output and a streaming line parser
 * that holds only `{answer, sessionId}` regardless of run length —
 * a 30-minute eval with a long transcript stays at O(longest single
 * line) rather than buffering the entire stream-json in memory. No
 * transcript or stderr file is written by the framework — claude
 * maintains its own session logs under `~/.claude/projects/` for
 * users who want to audit.
 */
import type { AgentAdapter } from '../../core/types.js';
import { spawnStreaming, spawnWithStdin } from '../../core/process.js';
import { createStreamingClaudeParser } from './parse-transcript.js';
import { startClaudeProxy } from './proxy.js';

/**
 * Inline `--settings` to override only `ANTHROPIC_BASE_URL` — the rest of
 * the user's claude config (`apiKeyHelper`, OTEL env, hooks, effort level)
 * keeps applying via the normal `~/.claude/settings.json` chain.
 *
 * Why we override BASE_URL via --settings rather than process env: claude's
 * precedence is `--settings.env` > `~/.claude/settings.json env` > process
 * env, so a user with `ANTHROPIC_BASE_URL` set in settings.json would
 * otherwise win and bypass our proxy.
 *
 * We do NOT override `ANTHROPIC_API_KEY`: the proxy passes the auth header
 * through to the upstream gateway / Anthropic API, so claude needs its
 * real credentials to flow through.
 */
function buildSettings(proxyUrl: string): string {
  return JSON.stringify({
    env: { ANTHROPIC_BASE_URL: proxyUrl },
  });
}

const adapter: AgentAdapter = {
  name: 'claude',

  startProxy(opts) {
    return startClaudeProxy(opts);
  },

  async run(opts) {
    const settings = buildSettings(opts.proxyUrl);
    const parser = createStreamingClaudeParser();
    // stderr is piped (not inherited) — see `process.ts`. An inherited
    // fd on an orphaned child blocks node:test from exiting after the
    // outer test cancels.
    await spawnStreaming({
      cmd: 'claude',
      args: [
        '--settings', settings,
        '--permission-mode=bypassPermissions',
        '--output-format=stream-json',
        '--verbose',
        '-p',
      ],
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
  },

  callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;
    // Deny all tools so callLLM is a single-shot text generation.
    const denyAllTools = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'exit 2' }] }] },
    });

    const args = ['-p'];
    if (opts?.resume && opts.sessionId) {
      args.push('--resume', opts.sessionId, '--fork-session');
    }
    args.push('--settings', denyAllTools, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
    if (opts?.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
    if (opts?.model) args.push('--model', opts.model);

    return spawnWithStdin('claude', args, prompt, { timeout, cwd: opts?.cwd });
  },
};

export default adapter;
