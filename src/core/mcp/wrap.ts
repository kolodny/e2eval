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
const SERVER = path.join(HERE, 'server.ts');

// Absolute tsx binary. The wrapper server's shebang (`tsx`) works too, but
// pinning avoids any ambiguity about which tsx the agent's CWD would resolve.
const TSX = path.join(HERE, '..', '..', 'node_modules', '.bin', 'tsx');

function wrap(name: string, server: McpServerDef): McpServerDef {
  if (server.url) {
    return {
      command: TSX,
      args: [SERVER, '--type=http', `--name=${name}`, server.url],
    };
  }
  if (server.command) {
    return {
      command: TSX,
      args: [
        SERVER,
        '--type=stdio',
        `--name=${name}`,
        '--',
        server.command,
        ...(server.args ?? []),
      ],
      ...(server.env ? { env: server.env } : {}),
    };
  }
  throw new Error(`cannot wrap server ${name}: no command or url`);
}

/** Wrap a discovered MCP stack. */
export function wrapMcpStack(opts: {
  mcpServers: Record<string, McpServerDef>;
  skip?: string[];
}): { mcpServers: Record<string, McpServerDef> } {
  const skip = new Set(opts.skip ?? []);
  const wrapped: Record<string, McpServerDef> = {};
  for (const [name, server] of Object.entries(opts.mcpServers)) {
    if (skip.has(name)) continue;
    wrapped[name] = wrap(name, server);
  }
  return { mcpServers: wrapped };
}
