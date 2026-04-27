/**
 * Claude Code adapter — proxy edition.
 *
 * Spawns claude with stream-json output, captures stdout, parses it
 * inline, and returns the `NormalizedTranscript`. No transcript or
 * stderr file is written by the framework — claude maintains its own
 * session logs under `~/.claude/projects/` for users who want to audit.
 */
import { $ } from 'zx';
import type { AgentAdapter } from '../../core/types.js';
import { spawnWithStdin } from '../../core/process.js';
import { parseClaudeTranscript } from './parse-transcript.js';
import { startClaudeProxy } from './proxy.js';

$.verbose = false;

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
    // Prompt goes through stdin (argv caps at 128KB). stderr is captured
    // (pipe) and forwarded to our stderr — NOT inherited. If claude is
    // ever orphaned (test cancellation, killed parent), an inherited fd
    // would keep our outer-process stderr pipe alive, blocking node:test
    // from exiting. With pipe+forward, the orphan dies on its next write
    // (SIGPIPE) or just sits there harmlessly.
    const proc = $({
      cwd: opts.runDir,
      env: opts.env,
      timeout: '30m',
      nothrow: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.prompt,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })`claude --settings ${settings} --permission-mode=bypassPermissions --output-format=stream-json --verbose -p`;
    proc.stderr?.pipe(process.stderr, { end: false });
    const result = await proc;
    return parseClaudeTranscript(result.stdout ?? '');
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
