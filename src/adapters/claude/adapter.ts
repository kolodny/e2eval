/**
 * Claude Code adapter.
 *
 * - `run` spawns `claude -p` with `--mcp-config=<our wrapped config>`
 *   (without `--strict-mcp-config`, so claude layers the wrapped file on
 *   top of its normal discovery chain — the agent sees wrapped servers +
 *   any pwd `.mcp.json` walk-up entries not in the wrapped set).
 * - `parseTranscript` returns only the final answer; the PostToolUse hook
 *   logs every tool call to `$EVAL_TOOL_LOG`, so there's nothing else to
 *   extract from the transcript.
 * - `discoverMcpStack` walks Claude's config convention.
 * - `callLLM` supports single-shot and resume (fork-session) modes.
 */
import { $, fs } from 'zx';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter } from '../../core/types.js';
import { spawnWithStdin } from '../../core/process.js';
import { discoverClaudeMcpStack } from './discover-mcp.js';
import { parseClaudeTranscript } from './parse-transcript.js';

const HOOK_ADAPTER = fileURLToPath(
  new URL('./hooks.mjs', import.meta.url),
);

$.verbose = false;

const adapter: AgentAdapter = {
  name: 'claude',
  supportsMcp: true,

  discoverMcpStack(cwd) {
    return discoverClaudeMcpStack(cwd);
  },

  async run(opts): Promise<void> {
    // Deliberately NO `--strict-mcp-config`: we want claude's normal
    // discovery chain (user-level + pwd `.mcp.json` walk-up) to layer on
    // top of our wrapped config. That way an eval inherits any MCP server
    // the user has set up in their repo pwd without us having to re-wire
    // it. The wrapped entries still win on name conflict.
    const mcpArgs = opts.mcpConfigPath
      ? [`--mcp-config=${opts.mcpConfigPath}`]
      : [];

    // `--settings <json-literal>` registers PreToolUse + PostToolUse hooks
    // that pipe every native tool call through the middleware server.
    // `onToolCall` middleware can block by returning a CallToolResult (the
    // hook exits 2); `afterToolCall` observes.
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: `node ${HOOK_ADAPTER}`, timeout: 10 },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: `node ${HOOK_ADAPTER}`, timeout: 10 },
            ],
          },
        ],
      },
    });

    // OS-level redirect stderr → stderrPath. Skips zx's buffer (no
    // maxBuffer risk on chatty runs) and is streamable from disk during
    // the run for debugging.
    // Prompt piped via stdin (not argv) — see core/process.ts for why.
    const stderrFd = openSync(opts.stderrPath, 'w');
    try {
      const proc = $({
        cwd: opts.runDir,
        env: opts.env,
        timeout: '30m',
        nothrow: true,
        stdio: ['pipe', 'pipe', stderrFd],
        input: opts.prompt,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })`claude ${mcpArgs} --settings ${settings} --permission-mode=bypassPermissions --output-format=stream-json --verbose -p`;
      const result = await proc;
      await fs.writeFile(opts.transcriptPath, result.stdout ?? '');
    } finally {
      closeSync(stderrFd);
    }
  },

  parseTranscript(path) {
    return parseClaudeTranscript(path);
  },

  callLLM(prompt, opts) {
    const timeout = opts?.timeout ?? 240_000;
    const denyAllTools = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'exit 2' }] }] },
    });

    // Prompt is piped via stdin, NOT argv: Linux's execve caps any single
    // argv entry at 128KB (MAX_ARG_STRLEN). Large grader prompts (full tool
    // calls, transcripts) blow past that — the child fails with E2BIG and
    // spawnSync returns silently with empty stdout. stdin has no such cap.
    const args = opts?.resume && opts.sessionId
      ? [
          '-p',
          '--resume', opts.sessionId,
          '--fork-session',
          '--settings', denyAllTools,
          '--strict-mcp-config',
          '--mcp-config', '{"mcpServers":{}}',
        ]
      : [
          '-p',
          '--settings', denyAllTools,
          '--strict-mcp-config',
          '--mcp-config', '{"mcpServers":{}}',
        ];
    if (opts?.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
    if (opts?.model) args.push('--model', opts.model);

    return spawnWithStdin('claude', args, prompt, { timeout, cwd: opts?.cwd });
  },
};

export default adapter;
