/**
 * Test adapter for opencode — real opencode bin, fake Anthropic upstream.
 *
 * Spawns the actual `opencode run` CLI with the proxy pointing at an
 * in-process fake-Anthropic that returns prebaked responses.
 * Everything else is real: opencode's tool dispatch, native tool
 * execution, the proxy itself, the middleware chain. Only the
 * model's outputs are scripted.
 *
 *   import { createOpencodeTestAdapter } from 'e2eval';
 *
 *   const adapter = createOpencodeTestAdapter({
 *     respond: [
 *       { content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'echo hi' } }] },
 *       { content: [{ type: 'text', text: 'final answer' }] },
 *     ],
 *   });
 *
 * `bash` (lowercase) is opencode's native shell tool — that's what
 * the proxy will redirect to on short-circuit.
 */
import { randomUUID } from 'node:crypto';
import { $ } from 'zx';
import type {
  AgentAdapter, AgentProxy, AgentRunOpts, StartProxyOpts,
} from '../../core/types.js';
import { startOpencodeProxy } from './proxy.js';
import { parseOpencodeTranscript } from './parse-transcript.js';
import { startFakeUpstream } from '../../core/test/fake-upstream.js';
import type {
  AgentScript, ScriptedResponse, ScriptedRequest,
} from '../../providers/anthropic-script-types.js';

$.verbose = false;

// Re-export the shared Anthropic-wire script types so opencode users
// don't have to import claude-named modules.
export type {
  ScriptedBlock, ScriptedResponse, ScriptedRequest, RespondFn, RespondContext,
  AgentScript, MessageParam, MessageCreateParams,
} from '../../providers/anthropic-script-types.js';

// ────────────────────────────────────────────────────────────── adapter

export type CreateOpencodeTestAdapterOptions = {
  /** Provider name in opencode config to override. Default `anthropic`. */
  provider?: string;
  /** Model id under that provider. Default `claude-haiku-4-5`. */
  model?: string;
};

/** Build the inline opencode config that overrides the provider's baseURL. */
function buildConfigContent(provider: string, baseURL: string): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [provider]: {
        options: {
          baseURL,
          apiKey: 'sk-fake-eval',
        },
      },
    },
  });
}

/**
 * Auto-skip opencode's title-generation Haiku call (system prompt:
 * "You are a title generator…") so tests only see substantive turns.
 */
function opencodeAutoSkip(req: ScriptedRequest): unknown | null {
  const sys = (req as any).system;
  const sysText = Array.isArray(sys)
    ? sys.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
    : (typeof sys === 'string' ? sys : '');
  if (!/title generator/i.test(sysText)) return null;
  return {
    id: 'msg_' + randomUUID().slice(0, 12),
    type: 'message', role: 'assistant', model: req.model ?? 'opencode-test',
    content: [{ type: 'text', text: '' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function buildOpencodeBody(scripted: ScriptedResponse): unknown {
  const stop_reason = scripted.stop_reason
    ?? (scripted.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return {
    id: 'msg_' + randomUUID().slice(0, 12),
    type: 'message',
    role: 'assistant',
    model: 'opencode-test',
    content: scripted.content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function createOpencodeTestAdapter(
  script: AgentScript,
  opts: CreateOpencodeTestAdapterOptions = {},
): AgentAdapter {
  const provider = opts.provider ?? 'anthropic';
  const model = opts.model ?? 'claude-haiku-4-5';

  return {
    name: 'opencode-test',

    async startProxy(proxyOpts: StartProxyOpts): Promise<AgentProxy> {
      const fake = await startFakeUpstream<ScriptedRequest, ScriptedResponse>({
        pathMatch: (url) => url.includes('/v1/messages'),
        respond: script.respond,
        buildBody: buildOpencodeBody,
        autoSkip: opencodeAutoSkip,
        scriptName: 'fake-Anthropic',
      });
      let proxy: AgentProxy | undefined;
      try {
        proxy = await startOpencodeProxy({ ...proxyOpts, upstream: fake.url });
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

    async run(runOpts: AgentRunOpts) {
      // `@ai-sdk/anthropic` appends `/messages` to the baseURL, not
      // `/v1/messages` — so we tack `/v1` onto our proxy URL.
      const env = {
        ...runOpts.env,
        OPENCODE_CONFIG_CONTENT: buildConfigContent(provider, `${runOpts.proxyUrl}/v1`),
      };
      const proc = $({
        cwd: runOpts.runDir,
        env,
        timeout: '2m',
        nothrow: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        input: runOpts.prompt,
        ...(runOpts.signal ? { signal: runOpts.signal } : {}),
      })`opencode run --format json --model ${`${provider}/${model}`} --dangerously-skip-permissions`;
      proc.stderr?.pipe(process.stderr, { end: false });
      const result = await proc;
      return parseOpencodeTranscript(result.stdout ?? '');
    },

    callLLM: async () => '',
  };
}
