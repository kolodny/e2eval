/**
 * Claude-specific Anthropic proxy.
 *
 * Thin wrapper around the agent-neutral `startAnthropicProxy` in
 * `src/providers/anthropic-proxy.ts`. Claude-specific bits:
 *
 *   - Redirect tool name is `Bash` (capitalised — claude's native tool).
 *   - When no `upstream:` is passed and `ANTHROPIC_BASE_URL` isn't in
 *     the env, we ask claude itself what it would resolve via a
 *     UserPromptSubmit hook trick (see `discover-upstream.ts`). That
 *     way users with a corp gateway in `~/.claude/settings.json` don't
 *     have to mirror it on `startRunner({ upstream })`.
 */
import {
  startAnthropicProxy,
  type AgentProxy,
  type StartAnthropicProxyOpts,
} from '../../providers/anthropic-proxy.js';
import { discoverClaudeUpstream } from './discover-upstream.js';

export type StartProxyOpts = Omit<StartAnthropicProxyOpts, 'redirectToolName' | 'upstreamResolver'>;

export function startClaudeProxy(opts: StartProxyOpts): Promise<AgentProxy> {
  return startAnthropicProxy({
    ...opts,
    redirectToolName: 'Bash',
    upstreamResolver: claudeUpstreamResolver,
  });
}

/**
 * Resolution order:
 *   1. `process.env.ANTHROPIC_BASE_URL`
 *   2. Hook discovery (claude's own resolved settings — managed/user/project)
 *   3. `https://api.anthropic.com`
 *
 * The explicit `upstream:` passed to `startRunner` is handled before
 * this resolver is even called.
 */
async function claudeUpstreamResolver(): Promise<string> {
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  const discovered = await discoverClaudeUpstream();
  return discovered ?? 'https://api.anthropic.com';
}
