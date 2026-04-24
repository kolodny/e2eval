/**
 * Discover opencode's MCP stack.
 *
 * Opencode reads MCP from two places ONLY:
 *   - `~/.config/opencode/opencode.jsonc` (user-level)
 *   - `./opencode.jsonc` (project-local, overrides user on name conflict)
 *
 * It does NOT read `.mcp.json` files — that's a Claude/MCP-SDK convention.
 * Each entry maps name → either
 *   `{type: "local", command: ["cmd", "arg"], environment?}`
 * or
 *   `{type: "remote", url, headers?}`.
 *
 * We normalise to canonical MCP shape (`{command,args,env}` or `{url,type:'http'}`)
 * so the core wrapper treats it the same as any other MCP config.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type OpencodeMcp =
  | { type: 'local'; command: string[]; environment?: Record<string, string> }
  | { type: 'remote'; url: string; headers?: Record<string, string> };

function stripJsonc(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

function readJsonc(p: string): any {
  try {
    return JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

function normalise(
  _name: string,
  def: OpencodeMcp,
  sourceDir?: string,
): { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; type?: string } | null {
  if (def.type === 'local') {
    const [cmd, ...args] = def.command ?? [];
    if (!cmd) return null;
    return {
      command: cmd,
      args,
      ...(def.environment ? { env: def.environment } : {}),
      // Relative `command`/`args` in opencode.jsonc resolve against the
      // dir the config lived in. Stamp that dir so e2eval's cwd pivot
      // doesn't strand them at the scratch dir.
      ...(sourceDir ? { cwd: sourceDir } : {}),
    };
  }
  if (def.type === 'remote') {
    return { url: def.url, type: 'http' };
  }
  return null;
}

export function discoverOpencodeMcpStack(cwd: string = process.cwd()): {
  mcpServers: Record<string, any>;
} {
  const home = os.homedir();
  const userConfigDir = path.join(home, '.config', 'opencode');
  const userConfig = readJsonc(path.join(userConfigDir, 'opencode.jsonc')) ?? {};
  const projectConfig = readJsonc(path.join(cwd, 'opencode.jsonc')) ?? {};

  // Track which source each entry came from so we can pick the right
  // default cwd for relative-path resolution. Project overrides user on
  // name conflict.
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(userConfig.mcp ?? {})) {
    const n = normalise(name, def as OpencodeMcp, userConfigDir);
    if (n) out[name] = n;
  }
  for (const [name, def] of Object.entries(projectConfig.mcp ?? {})) {
    const n = normalise(name, def as OpencodeMcp, cwd);
    if (n) out[name] = n;
  }

  return { mcpServers: out };
}
