/**
 * Discover codex's MCP stack.
 *
 * Codex reads MCP from `$CODEX_HOME/config.toml` (`mcp_servers` tables)
 * and the project-local `.mcp.json` file (NOT a walk-up — just the cwd).
 * It does NOT walk the `.mcp.json` chain up to `/` like Claude does.
 *
 * TOML table names can be bare (`[mcp_servers.foo]`) or quoted
 * (`[mcp_servers."core-tools"]`).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function discoverCodexMcpStack(cwd: string = process.cwd()): {
  mcpServers: Record<string, any>;
} {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');

  const out: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    try {
      const src = fs.readFileSync(configPath, 'utf8');
      Object.assign(out, parseMcpServersFromToml(src));
    } catch {
      /* ignore */
    }
  }

  // Codex also reads the project-local .mcp.json (cwd only, no walk-up).
  // Project entries override TOML entries on name conflict.
  const projectMcp = readJson(path.join(cwd, '.mcp.json'));
  if (projectMcp?.mcpServers) {
    Object.assign(out, projectMcp.mcpServers);
  }

  return { mcpServers: out };
}

/**
 * Minimal TOML subset: we only need `[mcp_servers.<name>]` and
 * `[mcp_servers.<name>.env]`. Supports bare names (`foo-bar`) and
 * quoted names (`"core-tools"`). Handles `command = "str"`,
 * `args = [...]`, and string-keyed env tables.
 */
export function parseMcpServersFromToml(src: string): Record<string, any> {
  const lines = src.split('\n');
  const out: Record<string, any> = {};
  let currentServer: string | null = null;
  let inEnvTable = false;

  // Match both bare and quoted table names:
  //   [mcp_servers.foo-bar]         → name = "foo-bar"
  //   [mcp_servers."core-tools"]    → name = "core-tools"
  //   [mcp_servers.foo.env]         → name = "foo", env section
  //   [mcp_servers."core-tools".env] → name = "core-tools", env section
  const headerRe = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_\-.:]+))(?:\.(env))?\]\s*$/;
  const stringRe = /^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*$/;
  const arrayRe = /^\s*([A-Za-z_][\w-]*)\s*=\s*(\[.*\])\s*$/;
  const genericTableRe = /^\s*\[([^\]]+)\]\s*$/;

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (!line.trim()) continue;

    const header = headerRe.exec(line);
    if (header) {
      const name = header[1] ?? header[2]; // quoted or bare
      inEnvTable = header[3] === 'env';
      currentServer = name;
      if (!out[name]) out[name] = {};
      if (inEnvTable) out[name].env = out[name].env ?? {};
      continue;
    }
    const anyHeader = genericTableRe.exec(line);
    if (anyHeader) {
      currentServer = null;
      inEnvTable = false;
      continue;
    }

    if (!currentServer) continue;
    const server = out[currentServer];

    const sm = stringRe.exec(line);
    if (sm) {
      const [, key, val] = sm;
      const unescaped = val.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (inEnvTable) {
        server.env[key] = unescaped;
      } else if (key === 'command' || key === 'url' || key === 'type') {
        server[key] = unescaped;
      }
      continue;
    }
    const am = arrayRe.exec(line);
    if (am && am[1] === 'args') {
      try {
        server.args = JSON.parse(am[2]);
      } catch {
        /* ignore malformed arrays */
      }
    }
  }

  const valid: Record<string, any> = {};
  for (const [name, def] of Object.entries(out)) {
    if (def.command || def.url) valid[name] = def;
  }
  return valid;
}
