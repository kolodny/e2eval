/**
 * Discovers Claude Code's MCP stack the same way the CLI would.
 *
 * Walks:
 *   ~/.claude.json                            (user-level mcpServers)
 *   ~/.claude/settings.json                   (user settings: mcpServers + env)
 *   .claude/settings.json + settings.local.json  (project-level, walking up)
 *   .mcp.json chain from cwd to /              (project-declared MCPs)
 *   ~/.claude/config_tracker.json             (plugin MCPs)
 *   ~/.claude.json projects[cwd].mcpServers   (project-pinned in user file)
 *
 * Returns the merged `mcpServers` map in canonical shape, plus a merged
 * `env` block from settings files (ANTHROPIC_BASE_URL, OTEL vars, etc.)
 * that MCP subprocesses may need.
 */
// @ts-nocheck
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

function walkMcpJson(start: string): Array<{ dir: string; servers: Record<string, unknown> }> {
  const out: Array<{ dir: string; servers: Record<string, unknown> }> = [];
  let d = path.resolve(start);
  while (true) {
    const v = readJson(path.join(d, '.mcp.json'));
    if (v?.mcpServers) out.unshift({ dir: d, servers: v.mcpServers });
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return out;
}

function collectPluginMcps(): Record<string, unknown> {
  const tracker = readJson(path.join(os.homedir(), '.claude', 'config_tracker.json'));
  const plugins = new Map<string, string>();
  (function walk(o: any): void {
    if (!o || typeof o !== 'object') return;
    if (o.pluginId && o.cachePath) plugins.set(o.pluginId, o.cachePath);
    for (const v of Object.values(o)) walk(v);
  })(tracker);

  const out: Record<string, unknown> = {};
  for (const [id, cachePath] of plugins) {
    const wrapped = readJson(path.join(cachePath, '.claude-plugin', 'plugin.json'))?.mcpServers;
    const bare = readJson(path.join(cachePath, '.mcp.json'));
    const servers = wrapped ?? bare ?? {};
    for (const [name, cfg] of Object.entries(servers)) {
      out[`plugin:${id}:${name}`] = cfg;
    }
  }
  return out;
}

/**
 * Walk from `cwd` up to `/` collecting `.claude/settings.json` and
 * `.claude/settings.local.json` files. Returns them root-first so
 * child entries override parent (Object.assign order).
 */
function collectProjectSettings(cwd: string): Array<{ mcpServers?: Record<string, any>; env?: Record<string, string> }> {
  const out: Array<{ mcpServers?: Record<string, any>; env?: Record<string, string> }> = [];
  let d = path.resolve(cwd);
  while (true) {
    const base = readJson(path.join(d, '.claude', 'settings.json'));
    if (base) out.unshift(base);
    const local = readJson(path.join(d, '.claude', 'settings.local.json'));
    if (local) out.unshift(local);
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  // local.json files were pushed before their base, but we want root-first
  // with local overriding base at the same level. Since we unshift both,
  // the array is root→leaf with local after base at each level — which is
  // correct for Object.assign merge order.
  return out;
}

export function discoverClaudeMcpStack(cwd: string = process.cwd()): {
  mcpServers: Record<string, any>;
  env: Record<string, string>;
} {
  const home = os.homedir();
  const homeClaudeJson = readJson(path.join(home, '.claude.json')) ?? {};
  const homeProject = homeClaudeJson.projects?.[path.resolve(cwd)] ?? {};

  // User-level settings: ~/.claude/settings.json
  const userSettings = readJson(path.join(home, '.claude', 'settings.json')) ?? {};

  // Collect project-level .claude/settings.json + settings.local.json
  const projectSettings = collectProjectSettings(cwd);

  // Merge env: user settings first, then project settings (child overrides)
  const env: Record<string, string> = { ...(userSettings.env ?? {}) };
  for (const s of projectSettings) Object.assign(env, s.env ?? {});

  // Merge mcpServers: plugins → user ~/.claude.json → user settings.json →
  // project settings chain → .mcp.json walk-up → project-pinned in ~/.claude.json
  const mcpServers: Record<string, any> = {
    ...collectPluginMcps(),
    ...(homeClaudeJson.mcpServers ?? {}),
    ...(userSettings.mcpServers ?? {}),
  };
  for (const s of projectSettings) Object.assign(mcpServers, s.mcpServers ?? {});
  // Stamp each `.mcp.json` entry's source dir as its `cwd` (unless the
  // entry already specifies one). Needed because e2eval pivots cwd to a
  // scratch dir before spawning the agent, which would otherwise break
  // relative paths in `command`/`args`.
  for (const { dir, servers } of walkMcpJson(cwd)) {
    for (const [name, def] of Object.entries(servers)) {
      if (def && typeof def === 'object' && (def as any).command && !(def as any).cwd) {
        (def as any).cwd = dir;
      }
      mcpServers[name] = def;
    }
  }
  Object.assign(mcpServers, homeProject.mcpServers ?? {});

  // Stamp settings env onto each server that doesn't already have its own
  if (Object.keys(env).length > 0) {
    for (const [, def] of Object.entries(mcpServers)) {
      if (def && typeof def === 'object' && def.command) {
        def.env = { ...env, ...(def.env ?? {}) };
      }
    }
  }

  return { mcpServers, env };
}
