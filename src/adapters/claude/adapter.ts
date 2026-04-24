/** Claude Code adapter. */
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
    // No `--strict-mcp-config`: claude layers the wrapped file over its
    // normal discovery chain, so an eval inherits pwd `.mcp.json` entries
    // the user has set up. Wrapped entries win on name conflict.
    const mcpArgs = opts.mcpConfigPath
      ? [`--mcp-config=${opts.mcpConfigPath}`]
      : [];

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

    // stderr redirects OS-level (skips zx's maxBuffer); prompt goes via
    // stdin (argv caps at 128KB — see core/process.ts).
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

    const args = ['-p'];
    if (opts?.resume && opts.sessionId) {
      args.push('--resume', opts.sessionId, '--fork-session');
    }
    args.push('--settings', denyAllTools, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
    if (opts?.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
    if (opts?.model) args.push('--model', opts.model);

    return spawnWithStdin('claude', args, prompt, { timeout, cwd: opts?.cwd });
  },
};

export default adapter;
