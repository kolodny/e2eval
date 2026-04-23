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
 * Tool denial is weaker than Claude's — opencode has no `--disallowed-tools`
 * flag. We pass the denied-tool list as a prompt prefix. Good enough for
 * "don't hit WebSearch", not good enough for hard enforcement. Evals that
 * need hard enforcement should avoid ever making those tools reachable
 * (by not configuring the MCP, not by trying to deny them at call time).
 *
 * `callLLM` supports single-shot and resume (fork + continue session) modes.
 */
import { $, fs } from 'zx';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentRunResult, McpServerDef } from '../../core/types.js';
import { discoverOpencodeMcpStack } from './discover-mcp.js';
import { parseOpencodeTranscript } from './parse-transcript.js';

const OPENCODE_PLUGIN = fileURLToPath(
  new URL('./hooks.mjs', import.meta.url),
);

$.verbose = false;

const DEFAULT_MODEL = process.env.OPENCODE_MODEL ?? 'ncp-anthropic/claude-sonnet-4-6';

const adapter: AgentAdapter = {
  name: 'opencode',
  supportsMcp: true,

  discoverMcpStack(cwd) {
    return discoverOpencodeMcpStack(cwd);
  },

  async run(opts): Promise<AgentRunResult> {
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
    const proc = $({
      cwd: opts.runDir,
      env: opts.env,
      timeout: '30m',
      nothrow: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    })`opencode run --format json --dangerously-skip-permissions --model ${DEFAULT_MODEL} ${opts.prompt}`;
    const result = await proc;
    await fs.writeFile(opts.transcriptPath, result.stdout ?? '');

    return {
      exitCode: result.exitCode ?? 1,
      stderrTail: (result.stderr ?? '').slice(-2000),
    };
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

    if (opts?.resume && opts.sessionId) {
      const res = spawnSync(
        'opencode', ['run', '--format', 'json', '--dangerously-skip-permissions', '--continue', '--session', opts.sessionId, '--fork', '--model', model, fullPrompt],
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        const parsed = JSON.parse(res.stdout ?? '');
        return Promise.resolve(parsed?.response ?? res.stdout ?? '');
      } catch { return Promise.resolve(res.stdout ?? ''); }
    }

    const res = spawnSync(
      'opencode', ['run', '--format', 'json', '--pure', '--dangerously-skip-permissions', '--model', model, fullPrompt],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const parsed = JSON.parse(res.stdout ?? '');
      return Promise.resolve(parsed?.response ?? res.stdout ?? '');
    } catch { return Promise.resolve(res.stdout ?? ''); }
  },
};

export default adapter;
