/**
 * Test adapter for claude — real claude bin, fake Anthropic upstream.
 *
 * Spawns the actual `claude` CLI, with the proxy pointed at an in-process
 * fake-Anthropic that returns prebaked responses. Everything else is real:
 * settings.json merging, tool dispatch, native tool execution, transcript
 * generation, the proxy itself, the middleware chain. Only the model's
 * outputs are scripted.
 *
 * Use this for integration tests that need to verify the entire pipeline
 * without depending on the actual Anthropic API. CI without network, dev
 * loops without burning tokens, deterministic LLM outputs.
 *
 *   import { createClaudeTestAdapter } from 'e2eval';
 *
 *   const adapter = createClaudeTestAdapter({
 *     respond: [
 *       { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } }] },
 *       { content: [{ type: 'text', text: 'final answer' }] },
 *     ],
 *   });
 *
 * Real claude runs the `echo hi` command for real — `Bash` is its actual
 * tool runner, not a mock. Test scripts should only use commands and
 * tools that are safe to actually execute.
 *
 * MCP servers from the user's `~/.claude/settings.json` (or project
 * `.mcp.json`) load normally — middleware that filters on MCP-prefixed
 * tool names can be exercised end-to-end. If you need a hermetic run,
 * pass `--strict-mcp-config` via your own claude wrapper or set MCP
 * config in the eval's working directory.
 */
import { randomUUID } from 'node:crypto';
import { $ } from 'zx';
import type {
  AgentAdapter, AgentProxy, AgentRunOpts, StartProxyOpts,
} from '../../core/types.js';
import { startClaudeProxy } from './proxy.js';
import { parseClaudeTranscript } from './parse-transcript.js';
import { startFakeUpstream } from '../../core/test/fake-upstream.js';
import type {
  AgentScript, ScriptedResponse, ScriptedRequest,
} from '../../providers/anthropic-script-types.js';

$.verbose = false;

// Re-export the shared Anthropic-wire script types so existing imports
// (e.g. `import type { ScriptedBlock } from 'e2eval'`) keep working.
export type {
  ScriptedBlock, ScriptedResponse, ScriptedRequest, RespondFn,
  RespondContext, AgentScript, MessageParam, MessageCreateParams,
} from '../../providers/anthropic-script-types.js';

// ────────────────────────────────────────────────────────────── adapter

function buildSettings(proxyUrl: string): string {
  return JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: proxyUrl,
      ANTHROPIC_API_KEY: 'sk-fake-eval',
    },
  });
}

/**
 * Auto-skip claude's auxiliary Haiku "decision" calls (auto-compact,
 * model selection). Tests that specifically need to assert on Haiku
 * traffic can detect the model in their RespondFn and bypass.
 */
function claudeAutoSkip(req: ScriptedRequest): unknown | null {
  if (typeof req.model === 'string' && /haiku/i.test(req.model)) {
    return {
      id: 'msg_' + randomUUID().slice(0, 12),
      type: 'message', role: 'assistant', model: req.model,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return null;
}

function buildClaudeBody(scripted: ScriptedResponse): unknown {
  const stop_reason = scripted.stop_reason
    ?? (scripted.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return {
    id: 'msg_' + randomUUID().slice(0, 12),
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: scripted.content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function createClaudeTestAdapter(script: AgentScript): AgentAdapter {
  return {
    name: 'claude-test',

    async startProxy(opts: StartProxyOpts): Promise<AgentProxy> {
      // Fake-Anthropic listens first; if startClaudeProxy throws (e.g.
      // invalid replay opts) the `finally` closes it so the process
      // doesn't leak a server handle. On success the wrapper below
      // owns close.
      const fake = await startFakeUpstream<ScriptedRequest, ScriptedResponse>({
        pathMatch: (url) => url.includes('/v1/messages'),
        respond: script.respond,
        buildBody: buildClaudeBody,
        autoSkip: claudeAutoSkip,
        scriptName: 'fake-Anthropic',
      });
      let proxy: AgentProxy | undefined;
      try {
        proxy = await startClaudeProxy({ ...opts, upstream: fake.url });
        return {
          url: proxy.url,
          port: proxy.port,
          upstream: fake.url,
          async close() {
            await proxy!.close();
            await fake.close();
          },
        };
      } finally {
        if (!proxy) await fake.close();
      }
    },

    async run(opts: AgentRunOpts) {
      const settings = buildSettings(opts.proxyUrl);
      // stderr piped (not inherited) so an orphan claude can't keep our
      // outer test runner's stderr pipe alive after node:test cancels a
      // test — that's the hang npm test was hitting.
      const proc = $({
        cwd: opts.runDir,
        env: opts.env,
        timeout: '10m',
        nothrow: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        input: opts.prompt,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })`claude --settings ${settings} --permission-mode=bypassPermissions --output-format=stream-json --verbose -p`;
      proc.stderr?.pipe(process.stderr, { end: false });
      const result = await proc;
      return parseClaudeTranscript(result.stdout ?? '');
    },

    callLLM: async () => '',
  };
}
