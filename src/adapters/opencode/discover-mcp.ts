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

function normalise(name: string, def: OpencodeMcp): { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: string } | null {
  if (def.type === 'local') {
    const [cmd, ...args] = def.command ?? [];
    if (!cmd) return null;
    return { command: cmd, args, ...(def.environment ? { env: def.environment } : {}) };
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
  const userConfig = readJsonc(path.join(home, '.config', 'opencode', 'opencode.jsonc')) ?? {};
  const projectConfig = readJsonc(path.join(cwd, 'opencode.jsonc')) ?? {};

  const merged: Record<string, OpencodeMcp> = {
    ...(userConfig.mcp ?? {}),
    ...(projectConfig.mcp ?? {}),
  };

  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(merged)) {
    const n = normalise(name, def as OpencodeMcp);
    if (n) out[name] = n;
  }

  return { mcpServers: out };
}
