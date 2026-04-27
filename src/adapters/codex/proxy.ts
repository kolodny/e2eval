/**
 * Codex-specific OpenAI Responses proxy.
 *
 * Thin wrapper around `startOpenAIResponsesProxy`. Codex uses
 * `exec_command` as its native shell tool — that's the redirect
 * target on short-circuit.
 *
 * Upstream resolution falls through to the proxy default —
 * `process.env.OPENAI_BASE_URL` → `https://api.openai.com`.
 */
import {
  startOpenAIResponsesProxy,
  type AgentProxy,
  type StartOpenAIResponsesProxyOpts,
} from '../../providers/openai-responses-proxy.js';

export type StartCodexProxyOpts = Omit<StartOpenAIResponsesProxyOpts, 'redirectToolName'>;

export function startCodexProxy(opts: StartCodexProxyOpts): Promise<AgentProxy> {
  return startOpenAIResponsesProxy({ ...opts, redirectToolName: 'exec_command' });
}
