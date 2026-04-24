/**
 * Generic MCP wrapper builder.
 *
 * Takes a canonical `mcpServers` map (adapter-discovered) and rewrites each
 * entry to route through our middleware server. The output is our canonical
 * shape (`{mcpServers: {...}}`) — each adapter translates it into whatever
 * config format its CLI expects (Claude: `--mcp-config=<path>`; opencode:
 * merged into `opencode.jsonc`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerDef } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const NODE = process.execPath;
const SERVER = path.join(HERE, 'server.js');

/**
 * Precedence for the wrapped subprocess env (later keys win):
 *   1. `PATH` from the runner process — so `node` can locate the backend cmd.
 *   2. User's `server.env` from settings (auth tokens, etc.).
 *   3. Framework `evalEnv` (EVAL_PLUGIN_SERVER/EVAL_TOOL_LOG/EVAL_CONFIG/
 *      EVAL_RUN_ID) — never overridable, otherwise the wrapper silently
 *      skips the middleware chain and drops tool-log entries.
 *
 * We have to set `env` unconditionally even when server.env is empty:
 * without it, agents like Claude may spawn the wrapper with an explicit
 * env that doesn't carry EVAL_* through, and the wrapper ends up with
 * `process.env.EVAL_PLUGIN_SERVER === ''` (server.ts:30) which causes it
 * to bypass the middleware chain entirely.
 */
function wrap(
  name: string,
  server: McpServerDef,
  evalEnv: Record<string, string>,
): McpServerDef {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...(server.env ?? {}),
    ...evalEnv,
  };
  if (server.url) {
    return {
      command: NODE,
      args: [SERVER, '--type=http', `--name=${name}`, server.url],
      env,
    };
  }
  if (server.command) {
    return {
      command: NODE,
      args: [
        SERVER,
        '--type=stdio',
        `--name=${name}`,
        '--',
        server.command,
        ...(server.args ?? []),
      ],
      env,
    };
  }
  throw new Error(`cannot wrap server ${name}: no command or url`);
}

/** Wrap a discovered MCP stack. */
export function wrapMcpStack(opts: {
  mcpServers: Record<string, McpServerDef>;
  skip?: string[];
  /**
   * EVAL_* vars the wrapper subprocess (`server.ts`) reads from
   * `process.env`. Stamped onto every wrapped server's env so the wrapper
   * sees them regardless of what the agent does about env inheritance.
   */
  env?: Record<string, string>;
}): { mcpServers: Record<string, McpServerDef> } {
  const skip = new Set(opts.skip ?? []);
  const evalEnv = opts.env ?? {};
  const wrapped: Record<string, McpServerDef> = {};
  for (const [name, server] of Object.entries(opts.mcpServers)) {
    if (skip.has(name)) continue;
    wrapped[name] = wrap(name, server, evalEnv);
  }
  return { mcpServers: wrapped };
}
