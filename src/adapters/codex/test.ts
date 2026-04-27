/**
 * Test adapter for codex — real codex bin, fake OpenAI Responses upstream.
 *
 * Spawns the actual `codex exec --json` CLI with the proxy pointed at
 * an in-process fake `/v1/responses` server returning prebaked
 * Response JSON objects. Everything else is real: codex's tool
 * dispatch, native shell execution, the proxy itself, the middleware
 * chain. Only the model's outputs are scripted.
 *
 *   import { createCodexTestAdapter } from 'e2eval';
 *
 *   const adapter = createCodexTestAdapter({
 *     respond: [
 *       { output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"echo hi"}' }] },
 *       { output: [{ type: 'message', id: 'm_1', role: 'assistant', content: [{ type: 'output_text', text: 'final' }] }] },
 *     ],
 *   });
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { $ } from 'zx';
import type {
  AgentAdapter, AgentProxy, AgentRunOpts, StartProxyOpts,
} from '../../core/types.js';
import { startCodexProxy } from './proxy.js';
import { parseCodexTranscript } from './parse-transcript.js';
import { startFakeUpstream } from '../../core/test/fake-upstream.js';

$.verbose = false;

/**
 * Build a minimal `~/.codex/config.toml` defining a provider that
 * points at the test proxy. We isolate via `CODEX_HOME` so tests
 * don't inherit (or break on) the user's real codex config — which
 * may target a private gateway, be malformed, or otherwise differ
 * machine-to-machine.
 */
function minimalCodexConfig(proxyBaseUrl: string): string {
  return [
    'model_provider = "test"',
    '',
    '[model_providers.test]',
    'name = "e2eval test provider"',
    `base_url = "${proxyBaseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n');
}

// ────────────────────────────────────────────────────────────── script types

export type CodexOutputItem =
  | { type: 'message'; id?: string; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string }
  | { type: string; [k: string]: unknown };

export type CodexScriptedResponse = {
  output: CodexOutputItem[];
  /** Optional usage override — defaults to `{input_tokens:1, output_tokens:1, total_tokens:2}`. */
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; [k: string]: unknown };
};

export type CodexScriptedRequest = {
  model?: string;
  instructions?: string;
  input?: any[];
  tools?: any[];
  [k: string]: unknown;
};

export type CodexRespondContext = {
  turnIndex: number;
};

export type CodexRespondFn = (
  req: CodexScriptedRequest,
  ctx: CodexRespondContext,
) => CodexScriptedResponse | Promise<CodexScriptedResponse>;

export type CodexAgentScript = {
  respond: CodexScriptedResponse[] | CodexRespondFn;
};

// ────────────────────────────────────────────────────────────── adapter

function buildCodexBody(scripted: CodexScriptedResponse, parsedReq: CodexScriptedRequest): unknown {
  const usage = scripted.usage ?? { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  return {
    id: 'resp_' + randomUUID().slice(0, 12),
    object: 'response',
    model: parsedReq.model ?? 'codex-test',
    output: scripted.output,
    usage,
    status: 'completed',
  };
}

export function createCodexTestAdapter(script: CodexAgentScript): AgentAdapter {
  return {
    name: 'codex-test',

    async startProxy(opts: StartProxyOpts): Promise<AgentProxy> {
      const fake = await startFakeUpstream<CodexScriptedRequest, CodexScriptedResponse>({
        pathMatch: (url) => url.includes('/v1/responses'),
        respond: script.respond,
        buildBody: buildCodexBody,
        scriptName: 'fake-OpenAI-Responses',
      });
      let proxy: AgentProxy | undefined;
      try {
        proxy = await startCodexProxy({ ...opts, upstream: fake.url });
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
      // Isolated CODEX_HOME so we don't inherit / depend on the user's
      // real `~/.codex/config.toml`. The minimal config defines a
      // single provider pointing at our proxy.
      const codexHome = await mkdtemp(path.join(tmpdir(), 'e2eval-codex-'));
      try {
        await writeFile(
          path.join(codexHome, 'config.toml'),
          minimalCodexConfig(`${opts.proxyUrl}/v1`),
        );

        const args = [
          'exec',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
        ];

        const proc = $({
          cwd: opts.runDir,
          env: { ...opts.env, OPENAI_API_KEY: 'sk-fake-eval', CODEX_HOME: codexHome },
          timeout: '5m',
          nothrow: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          input: opts.prompt,
          ...(opts.signal ? { signal: opts.signal } : {}),
        })`codex ${args}`;
        proc.stderr?.pipe(process.stderr, { end: false });
        const result = await proc;
        return parseCodexTranscript(result.stdout ?? '');
      } finally {
        await rm(codexHome, { recursive: true, force: true }).catch(() => {});
      }
    },

    callLLM: async () => '',
  };
}
