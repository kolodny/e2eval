/**
 * Claude-specific Anthropic proxy.
 *
 * Thin wrapper around the agent-neutral `startAnthropicProxy` in
 * `src/providers/anthropic-proxy.ts`. The only claude-specific bit:
 * the redirect tool is `Bash` (capitalised — claude's native tool).
 *
 * Upstream resolution is explicit:
 *
 *   - Pass `upstream:` to `startRunner({ upstream })` for an explicit URL.
 *   - Or set `ANTHROPIC_BASE_URL` in your shell env.
 *   - Otherwise we default to `https://api.anthropic.com`.
 *
 * We deliberately don't read `~/.claude/settings.json` (or any other
 * tool-internal config) to discover an upstream — claude's settings
 * precedence chain is its own internal contract and mirroring it
 * client-side is a maintenance trap.
 */
import {
  startAnthropicProxy,
  type AgentProxy,
  type StartAnthropicProxyOpts,
} from '../../providers/anthropic-proxy.js';

export type StartProxyOpts = Omit<StartAnthropicProxyOpts, 'redirectToolName' | 'upstreamResolver'>;

export function startClaudeProxy(opts: StartProxyOpts): Promise<AgentProxy> {
  return startAnthropicProxy({
    ...opts,
    redirectToolName: 'Bash',
    // No custom resolver — startAnthropicProxy's default already does
    // `process.env.ANTHROPIC_BASE_URL ?? https://api.anthropic.com`.
  });
}
