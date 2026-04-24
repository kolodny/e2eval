/**
 * Codex adapter.
 *
 * Codex reads MCP from `$CODEX_HOME/config.toml` under `[mcp_servers.<name>]`
 * tables. For eval runs we write a per-run CODEX_HOME with:
 *   1. A fresh `config.toml` that copies the user's (for provider config)
 *      and replaces the `mcp_servers` section with the wrapped stack.
 *   2. A symlink to the user's `auth.json` (codex needs it to hit the API).
 *   3. A per-server `env = {EVAL_TOOL_LOG, EVAL_CONFIG, PATH}`
 *      block — codex does NOT forward its runtime env to MCP subprocesses,
 *      so the wrapper wouldn't see these otherwise.
 *
 * Codex has no CLI deny-flag, but it does support a hooks.json in CODEX_HOME
 * (same protocol as claude's, with `hook_event_name` as the discriminator).
 * The adapter installs a PreToolUse + PostToolUse hook that pipes every
 * native tool call through the middleware server — `onToolCall` middleware
 * can deny a call by returning a CallToolResult (the hook will exit 2 and
 * block it) and observe results via `afterToolCall`.
 *
 * Session resume: codex supports `codex exec resume <thread_id> <prompt>`.
 * The session handle is `{sessionId, codexHome}` — codex looks up rollouts
 * in CODEX_HOME, so the same directory must be used for the resume.
 */
import { $, fs } from 'zx';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, McpServerDef } from '../../core/types.js';
import { spawnWithStdin } from '../../core/process.js';
import { discoverCodexMcpStack } from './discover-mcp.js';
import { parseCodexTranscript } from './parse-transcript.js';

const HOOK_ADAPTER = fileURLToPath(
  new URL('./hooks.mjs', import.meta.url),
);

$.verbose = false;

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? null;

const adapter: AgentAdapter = {
  name: 'codex',
  supportsMcp: true,

  discoverMcpStack(cwd) {
    return discoverCodexMcpStack(cwd);
  },

  async run(opts): Promise<void> {
    const codexHome = await setupCodexHome(opts);

    const modelArgs = DEFAULT_MODEL ? ['--model', DEFAULT_MODEL] : [];

    // Codex reads the prompt from stdin when no positional prompt is given.
    const stderrFd = openSync(opts.stderrPath, 'w');
    try {
      const result = await $({
        cwd: opts.runDir,
        env: {
          ...opts.env,
          CODEX_HOME: codexHome,
          // Codex requires `OPENAI_API_KEY` to be set even when the provider
          // uses a different auth mechanism — the gate is unconditional.
          OPENAI_API_KEY: opts.env.OPENAI_API_KEY ?? 'unused',
        },
        timeout: '30m',
        nothrow: true,
        stdio: ['pipe', 'pipe', stderrFd],
        input: opts.prompt,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })`codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${modelArgs} -C ${opts.runDir}`;

      await fs.writeFile(opts.transcriptPath, result.stdout ?? '');
    } finally {
      closeSync(stderrFd);
    }
  },

  parseTranscript(path) {
    const result = parseCodexTranscript(path);
    return result;
  },

  async callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;
    const env = { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'unused' };
    const isResume = !!(opts?.resume && opts.sessionId);

    const args = ['exec'];
    if (isResume) args.push('resume', opts!.sessionId!);
    args.push('--json', '--skip-git-repo-check', '--sandbox', 'read-only');
    if (!isResume) args.push('--ignore-user-config');
    if (opts?.systemPrompt) args.push('--config', `developer_instructions="${opts.systemPrompt}"`);
    if (opts?.model) args.push('--model', opts.model);

    const stdout = await spawnWithStdin('codex', args, prompt, { timeout, env });
    try {
      return JSON.parse(stdout)?.items?.find((i: any) => i.type === 'message')?.content?.[0]?.text ?? '';
    } catch {
      return stdout;
    }
  },
};

/**
 * Build a per-run CODEX_HOME under the runDir. Copies the user's config so
 * provider settings survive, then replaces the MCP stack with ours (and
 * adds per-server env so the wrapper can write `EVAL_TOOL_LOG`).
 */
async function setupCodexHome(opts: {
  runDir: string;
  mcpConfigPath: string | null;
  env: Record<string, string>;
}): Promise<string> {
  const home = path.join(opts.runDir, 'codex-home');
  await fs.ensureDir(home);

  const userHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  const userAuth = path.join(userHome, 'auth.json');
  if (fs.existsSync(userAuth)) {
    await fs.copy(userAuth, path.join(home, 'auth.json'));
  }

  // Start from user config (provider definitions etc.); our mcp_servers
  // entries below fully replace the user's.
  let baseToml = '';
  const userCfg = path.join(userHome, 'config.toml');
  if (fs.existsSync(userCfg)) {
    baseToml = fs.readFileSync(userCfg, 'utf8');
    baseToml = stripMcpServersSections(baseToml);
  }

  const mcpBlock = opts.mcpConfigPath
    ? renderMcpServersToml(
        (await fs.readJson(opts.mcpConfigPath)).mcpServers,
        opts.env,
      )
    : '';

  await fs.writeFile(path.join(home, 'config.toml'), baseToml + '\n' + mcpBlock);

  // PreToolUse/PostToolUse hooks — codex looks for hooks.json next to
  // config.toml in CODEX_HOME. Matcher `.*` covers every native tool; the
  // hook script pipes payloads to the middleware server where `onToolCall`
  // middleware can block (via exit 2) and `afterToolCall` observes.
  await fs.writeJson(path.join(home, 'hooks.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: `node ${HOOK_ADAPTER}`, timeout: 10 }],
        },
      ],
      PostToolUse: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: `node ${HOOK_ADAPTER}`, timeout: 10 }],
        },
      ],
    },
  }, { spaces: 2 });

  return home;
}

function stripMcpServersSections(toml: string): string {
  // Drop any `[mcp_servers.*]` table — including `.env` sub-tables — up to
  // the next top-level table header or EOF.
  const lines = toml.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      skipping = header[1].startsWith('mcp_servers');
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function renderMcpServersToml(
  servers: Record<string, McpServerDef>,
  env: Record<string, string>,
): string {
  // Codex doesn't forward its runtime env to MCP subprocesses, so PATH and
  // every EVAL_* var the runner set are embedded per-server below.
  const evalEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('EVAL_') && typeof v === 'string') evalEnv[k] = v;
  }

  const blocks: string[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (def.command) {
      blocks.push(`[mcp_servers."${name}"]`);
      blocks.push(`command = ${JSON.stringify(def.command)}`);
      blocks.push(`args = ${JSON.stringify(def.args ?? [])}`);
      const merged: Record<string, string> = {
        PATH: env.PATH ?? process.env.PATH ?? '',
        ...evalEnv,
        ...(def.env ?? {}),
      };
      blocks.push(`[mcp_servers."${name}".env]`);
      for (const [k, v] of Object.entries(merged)) {
        blocks.push(`${k} = ${JSON.stringify(v)}`);
      }
      blocks.push('');
    } else if (def.url) {
      blocks.push(`[mcp_servers."${name}"]`);
      blocks.push(`url = ${JSON.stringify(def.url)}`);
      blocks.push('');
    }
  }
  return blocks.join('\n');
}


export default adapter;
