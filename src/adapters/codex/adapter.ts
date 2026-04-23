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
 * Codex has no CLI deny-flag; like opencode, deny requests are a prompt
 * prefix. Evals that need hard deny should not expose the tool at all.
 *
 * Session resume: codex supports `codex exec resume <thread_id> <prompt>`.
 * The session handle is `{sessionId, codexHome}` — codex looks up rollouts
 * in CODEX_HOME, so the same directory must be used for the resume.
 */
import { $, fs } from 'zx';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { AgentAdapter, AgentRunResult, McpServerDef } from '../../core/types.js';
import { discoverCodexMcpStack } from './discover-mcp.js';
import { parseCodexTranscript } from './parse-transcript.js';

$.verbose = false;

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? null;

const adapter: AgentAdapter = {
  name: 'codex',
  supportsMcp: true,

  discoverMcpStack(cwd) {
    return discoverCodexMcpStack(cwd);
  },

  async run(opts): Promise<AgentRunResult> {
    const codexHome = await setupCodexHome(opts);

    const modelArgs = DEFAULT_MODEL ? ['--model', DEFAULT_MODEL] : [];

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
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    })`codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${modelArgs} -C ${opts.runDir} ${opts.prompt}`;

    await fs.writeFile(opts.transcriptPath, result.stdout ?? '');

    return {
      exitCode: result.exitCode ?? 1,
      stderrTail: (result.stderr ?? '').slice(-2000),
    };
  },

  parseTranscript(path) {
    const result = parseCodexTranscript(path);
    return result;
  },

  callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;

    if (opts?.resume && opts.sessionId) {
      const args = ['exec', 'resume', opts.sessionId, '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
      if (opts.systemPrompt) args.push('--config', `developer_instructions="${opts.systemPrompt}"`);
      if (opts.model) args.push('--model', opts.model);
      args.push(prompt);
      const res = spawnSync('codex', args, {
        encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'unused' },
      });
      try {
        const parsed = JSON.parse(res.stdout ?? '');
        return Promise.resolve(parsed?.items?.find((i: any) => i.type === 'message')?.content?.[0]?.text ?? '');
      } catch { return Promise.resolve(res.stdout ?? ''); }
    }

    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--ignore-user-config'];
    if (opts?.systemPrompt) args.push('--config', `developer_instructions="${opts.systemPrompt}"`);
    if (opts?.model) args.push('--model', opts.model);
    args.push(prompt);
    const res = spawnSync('codex', args, {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'unused' },
    });
    try {
      const parsed = JSON.parse(res.stdout ?? '');
      return Promise.resolve(parsed?.items?.find((i: any) => i.type === 'message')?.content?.[0]?.text ?? '');
    } catch { return Promise.resolve(res.stdout ?? ''); }
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

  // auth.json — copy so codex can authenticate. Hardlink would be fine too.
  const userAuth = path.join(userHome, 'auth.json');
  if (fs.existsSync(userAuth)) {
    await fs.copy(userAuth, path.join(home, 'auth.json'));
  }

  // Start from user config (provider definitions etc.), strip any existing
  // mcp_servers entries so ours fully replace them.
  let baseToml = '';
  const userCfg = path.join(userHome, 'config.toml');
  if (fs.existsSync(userCfg)) {
    baseToml = fs.readFileSync(userCfg, 'utf8');
    baseToml = stripMcpServersSections(baseToml);
  }

  // Append our wrapped MCP stack as TOML.
  const mcpBlock = opts.mcpConfigPath
    ? renderMcpServersToml(
        (await fs.readJson(opts.mcpConfigPath)).mcpServers,
        opts.env,
      )
    : '';

  await fs.writeFile(path.join(home, 'config.toml'), baseToml + '\n' + mcpBlock);

  // Note: codex v0.122 scopes hooks to plugins only — there is no global
  // `hooks.json` in CODEX_HOME (unlike claude's `~/.claude/settings.json`).
  // Codex's native tool calls (`command_execution`, `web_search`) are
  // captured via `parseCodexTranscript` instead.

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
  // Codex does NOT forward its runtime env to MCP subprocesses, so we embed
  // the env the wrapper needs into each `[mcp_servers.<name>.env]` block.
  // Propagate:
  //   - PATH (so node/binaries resolve)
  //   - every `EVAL_*` var the runner set (EVAL_TOOL_LOG, EVAL_CONFIG,
  //     EVAL_RUN_ID, plus any future ones the runner adds)
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
