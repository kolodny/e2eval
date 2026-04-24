/**
 * Opencode adapter.
 *
 * Opencode reads MCP config from `opencode.jsonc` at `~/.config/opencode/`
 * (user) or the CWD (project-local, overrides user). For eval runs we write
 * a project-local `opencode.jsonc` into runDir with the wrapped MCP map
 * translated to opencode's `{type:'local', command:[cmd, ...args]}` shape.
 *
 * Unlike claude, opencode has no native walk-up for per-run overrides, and
 * it spawns every configured MCP server at startup — so we don't merge
 * pwd-discovered MCPs into the run-local config. The agent sees exactly the
 * servers the runner asked to wrap, and nothing else.
 *
 * Opencode has no `--disallowed-tools` flag. The adapter runs with all tools
 * enabled; any gating is expected to happen in `onToolCall` middleware. Evals
 * that need hard enforcement should avoid ever making those tools reachable
 * (by not configuring the MCP, not by trying to deny them at call time).
 *
 * `callLLM` supports single-shot and resume (fork + continue session) modes.
 *
 * Prompt-size limit: unlike claude/codex, `opencode run` does NOT accept the
 * prompt on stdin (upstream issue — see https://github.com/anomalyco/opencode/issues/18659),
 * so the prompt goes through argv and hits Linux's MAX_ARG_STRLEN cap
 * (128KB per argv entry). The adapter throws loudly on oversized prompts
 * instead of letting execve fail silently with E2BIG + empty stdout.
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

const DEFAULT_MODEL = process.env.OPENCODE_MODEL ?? 'ncp-anthropic/claude-sonnet-4-6';

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
    // Write ONLY the wrapped set to runDir/opencode.jsonc. We don't merge in
    // pwd-discovered MCPs because opencode spawns every entry at startup —
    // bundling the user's ambient stack (newt-exec, playwright, etc.) can
    // add minutes of boot time for no gain, and opencode has no native
    // walk-up for per-run overrides anyway.
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

    // Copy the plugin file into runDir so opencode can load it with a
    // relative `./` reference. Opencode's plugin loader rejects bare absolute
    // FS paths on some versions; relative-in-cwd is the portable form.
    const pluginDst = path.join(opts.runDir, 'e2eval-plugin.mjs');
    await fs.copy(OPENCODE_PLUGIN, pluginDst);
    await fs.writeJson(path.join(opts.runDir, 'opencode.jsonc'), {
      $schema: 'https://opencode.ai/config.json',
      mcp,
      plugin: ['./e2eval-plugin.mjs'],
    }, { spaces: 2 });

    // `stdio: ['ignore', 'pipe', 'pipe']`: opencode blocks reading stdin
    // when a writable pipe is inherited (zx's default). Close the handle
    // so opencode sees EOF immediately and proceeds.
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
      })`opencode run --format json --dangerously-skip-permissions --model ${DEFAULT_MODEL} ${opts.prompt}`;
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

  callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;
    const model = opts?.model ?? DEFAULT_MODEL;
    const fullPrompt = opts?.systemPrompt
      ? `<system-instructions>${opts.systemPrompt}</system-instructions>\n\n${prompt}`
      : prompt;
    assertPromptFitsArgv(fullPrompt);

    const args = opts?.resume && opts.sessionId
      ? ['run', '--format', 'json', '--dangerously-skip-permissions', '--continue', '--session', opts.sessionId, '--fork', '--model', model, fullPrompt]
      : ['run', '--format', 'json', '--pure', '--dangerously-skip-permissions', '--model', model, fullPrompt];

    const res = spawnSync('opencode', args, {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) return Promise.reject(res.error);
    if (res.status !== 0) {
      return Promise.reject(new Error(`opencode exited ${res.status}${res.signal ? ` (${res.signal})` : ''}\n${(res.stderr ?? '').slice(-2000)}`));
    }
    try {
      const parsed = JSON.parse(res.stdout ?? '');
      return Promise.resolve(parsed?.response ?? res.stdout ?? '');
    } catch {
      return Promise.resolve(res.stdout ?? '');
    }
  },
};

export default adapter;
