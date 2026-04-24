/**
 * Opencode adapter.
 *
 * Writes a project-local `opencode.jsonc` into runDir with the wrapped MCP
 * map translated to opencode's `{type:'local', command:[cmd, ...args]}`
 * shape. Opencode spawns every configured MCP server at startup and has no
 * per-run override, so pwd-discovered MCPs are *not* merged in.
 *
 * Prompt-size limit: `opencode run` does not accept stdin prompts
 * (https://github.com/anomalyco/opencode/issues/18659), so the prompt goes
 * through argv and hits Linux's MAX_ARG_STRLEN cap (128KB per entry). The
 * adapter throws on oversized prompts instead of letting execve fail
 * silently with E2BIG.
 */
import { $, fs } from 'zx';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, McpServerDef } from '../../core/types.js';
import { discoverOpencodeMcpStack } from './discover-mcp.js';
import { parseOpencodeTranscript } from './parse-transcript.js';

const OPENCODE_PLUGIN = fileURLToPath(
  new URL('./hooks.mjs', import.meta.url),
);

$.verbose = false;

const DEFAULT_MODEL = process.env.OPENCODE_MODEL ?? null;

// Linux execve caps any single argv entry at 32 × PAGE_SIZE = 131072 bytes.
// We reserve a little headroom for other argv entries on the same line.
const ARGV_PROMPT_LIMIT = 120_000;

function assertPromptFitsArgv(prompt: string): void {
  const size = Buffer.byteLength(prompt, 'utf8');
  if (size > ARGV_PROMPT_LIMIT) {
    throw new Error(
      `opencode prompt is ${size} bytes, exceeds ${ARGV_PROMPT_LIMIT} byte argv cap. ` +
      `Upstream opencode does not accept prompts on stdin yet ` +
      `(https://github.com/anomalyco/opencode/issues/18659).`,
    );
  }
}

const adapter: AgentAdapter = {
  name: 'opencode',
  supportsMcp: true,

  discoverMcpStack(cwd) {
    return discoverOpencodeMcpStack(cwd);
  },

  async run(opts): Promise<void> {
    const wrappedMap: Record<string, McpServerDef> = opts.mcpConfigPath
      ? (await fs.readJson(opts.mcpConfigPath)).mcpServers ?? {}
      : {};
    const mcp: Record<string, any> = {};
    for (const [name, def] of Object.entries(wrappedMap)) {
      if (def.url) mcp[name] = { type: 'remote', url: def.url };
      else if (def.command) {
        mcp[name] = {
          type: 'local',
          command: [def.command, ...(def.args ?? [])],
          ...(def.env ? { environment: def.env } : {}),
        };
      }
    }

    // Opencode's plugin loader rejects absolute paths on some versions —
    // copy into runDir and reference it relative-in-cwd.
    const pluginDst = path.join(opts.runDir, 'e2eval-plugin.mjs');
    await fs.copy(OPENCODE_PLUGIN, pluginDst);
    await fs.writeJson(path.join(opts.runDir, 'opencode.jsonc'), {
      $schema: 'https://opencode.ai/config.json',
      mcp,
      plugin: ['./e2eval-plugin.mjs'],
    }, { spaces: 2 });

    // stdio[0]='ignore': opencode blocks reading stdin when it inherits
    // a writable pipe (zx's default); closed stdin makes it proceed.
    assertPromptFitsArgv(opts.prompt);
    const stderrFd = openSync(opts.stderrPath, 'w');
    try {
      const proc = $({
        cwd: opts.runDir,
        env: opts.env,
        timeout: '30m',
        nothrow: true,
        stdio: ['ignore', 'pipe', stderrFd],
        ...(opts.signal ? { signal: opts.signal } : {}),
      })`opencode run --format json --dangerously-skip-permissions ${DEFAULT_MODEL ? ['--model', DEFAULT_MODEL] : []} ${opts.prompt}`;
      const result = await proc;
      await fs.writeFile(opts.transcriptPath, result.stdout ?? '');
    } finally {
      closeSync(stderrFd);
    }
  },

  parseTranscript(path) {
    const result = parseOpencodeTranscript(path);
    return result;
  },

  async callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;
    const model = opts?.model ?? DEFAULT_MODEL;
    const fullPrompt = opts?.systemPrompt
      ? `<system-instructions>${opts.systemPrompt}</system-instructions>\n\n${prompt}`
      : prompt;
    assertPromptFitsArgv(fullPrompt);

    const args = ['run', '--format', 'json', '--dangerously-skip-permissions'];
    if (opts?.resume && opts.sessionId) {
      args.push('--continue', '--session', opts.sessionId, '--fork');
    } else {
      args.push('--pure');
    }
    if (model) args.push('--model', model);
    args.push(fullPrompt);

    const res = spawnSync('opencode', args, {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`opencode exited ${res.status}${res.signal ? ` (${res.signal})` : ''}\n${(res.stderr ?? '').slice(-2000)}`);
    }
    const stdout = res.stdout ?? '';
    try {
      return JSON.parse(stdout)?.response ?? stdout;
    } catch {
      return stdout;
    }
  },
};

export default adapter;
