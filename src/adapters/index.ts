/**
 * Library entry for the built-in adapters.
 *
 *   import { claude, opencode, codex, builtinAdapters } from 'e2eval/adapters';
 *
 * There is intentionally no adapter-customisation API. If you need to run
 * an agent through a wrapper (e.g. `newt exec claude`, a stricter auth
 * shim, etc.), drop an executable named `claude` / `opencode` / `codex`
 * earlier on `$PATH` than the real binary and have it `exec "$@"` the
 * real one with whatever wrapping you need. The adapter spawns by name,
 * so the shim is transparent.
 */
import type { AgentAdapter } from '../core/types.js';
import claudeAdapter from './claude/adapter.js';
import opencodeAdapter from './opencode/adapter.js';
import codexAdapter from './codex/adapter.js';

export const claude: AgentAdapter = claudeAdapter;
export const opencode: AgentAdapter = opencodeAdapter;
export const codex: AgentAdapter = codexAdapter;

/** All built-in adapters keyed by name. */
export const builtinAdapters: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  opencode: opencodeAdapter,
  codex: codexAdapter,
};

export type { AgentAdapter } from '../core/types.js';
