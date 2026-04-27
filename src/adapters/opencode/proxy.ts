/**
 * OpenCode Anthropic-provider proxy.
 *
 * Thin wrapper around `startAnthropicProxy`. OpenCode's
 * `@ai-sdk/anthropic` provider speaks the same `/v1/messages` wire
 * format as claude, so the generic Anthropic proxy handles
 * everything; the only opencode-specific bit is that opencode's
 * redirect tool is lowercase `bash` (not `Bash`).
 *
 * Upstream resolution falls through to the proxy default —
 * `process.env.ANTHROPIC_BASE_URL` → `https://api.anthropic.com` —
 * which is what opencode users want by default.
 */
import {
  startAnthropicProxy,
  type AgentProxy,
  type StartAnthropicProxyOpts,
} from '../../providers/anthropic-proxy.js';

export type StartOpencodeProxyOpts = Omit<StartAnthropicProxyOpts, 'redirectToolName'>;

export function startOpencodeProxy(opts: StartOpencodeProxyOpts): Promise<AgentProxy> {
  return startAnthropicProxy({ ...opts, redirectToolName: 'bash' });
}
