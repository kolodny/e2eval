/**
 * Claude-specific Anthropic proxy.
 *
 * Thin wrapper around the agent-neutral `startAnthropicProxy` in
 * `src/providers/anthropic-proxy.ts`. Claude-specific bits:
 *
 *   - Redirect tool name is `Bash` (capitalised — claude's native tool).
 *   - `<persisted-output>` dereferencing: when claude spools a large
 *     Bash or MCP result to disk and returns a pointer, the proxy
 *     reads the file so middleware sees full content; the wire keeps
 *     the envelope (preview stripped) so the LLM is unaware.
 *   - When no `upstream:` is passed and `ANTHROPIC_BASE_URL` isn't in
 *     the env, we ask claude itself what it would resolve via a
 *     UserPromptSubmit hook trick (see `discover-upstream.ts`). That
 *     way users with a corp gateway in `~/.claude/settings.json` don't
 *     have to mirror it on `startRunner({ upstream })`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  startAnthropicProxy,
  type AgentProxy,
  type StartAnthropicProxyOpts,
} from '../../providers/anthropic-proxy.js';
import type { ToolResult, ContentBlock } from '../../core/types.js';
import { discoverClaudeUpstream } from './discover-upstream.js';

export type StartProxyOpts = Omit<
  StartAnthropicProxyOpts,
  'redirectToolName' | 'upstreamResolver' | 'dereferencer'
>;

export function startClaudeProxy(opts: StartProxyOpts): Promise<AgentProxy> {
  return startAnthropicProxy({
    ...opts,
    redirectToolName: 'Bash',
    upstreamResolver: claudeUpstreamResolver,
    dereferencer: persistedOutputDereferencer,
  });
}

// ────────────────────────────── persisted-output dereferencer

type PersistedPointer = { path: string; kind: 'json' | 'text' };

/**
 * Format claude emits for oversized tool_results (Bash, MCP):
 *
 *   <persisted-output>
 *   Output too large (488.3KB). Full output saved to: <abs path>
 *
 *   Preview (first 2KB):
 *   <2KB of content>
 *   ...
 *   </persisted-output>
 *
 * The on-disk format depends on the source: Bash spool is raw text
 * in `<random>.txt`, MCP spool is a JSON-serialized content array
 * in `<tool_use_id>.json`.
 */
const PERSISTED_RE = /<persisted-output>[\s\S]*?Full output saved to: (.+?)\n/;
// Strips from the blank line preceding "Preview" up to (but not
// including) the closing tag — leaves the path mention intact.
const PREVIEW_RE = /\n\s*\nPreview \(first[\s\S]*?(?=\n<\/persisted-output>)/;

/**
 * Exported for unit tests. Stable shape (same Dereferencer type as
 * `StartAnthropicProxyOpts['dereferencer']`), but consumers should
 * import via `claudeAdapter` rather than poking at this directly.
 */
export const persistedOutputDereferencer: NonNullable<StartAnthropicProxyOpts['dereferencer']> = {
  detect(real: ToolResult): PersistedPointer | null {
    if (real.content.length !== 1 || real.content[0].type !== 'text') return null;
    const text = (real.content[0] as { text?: string }).text ?? '';
    const m = PERSISTED_RE.exec(text);
    if (!m) return null;
    const path = m[1].trim();
    return { path, kind: path.endsWith('.json') ? 'json' : 'text' };
  },

  async read(pointer): Promise<ToolResult> {
    const info = pointer as PersistedPointer;
    const buf = await readFile(info.path, 'utf8');
    if (info.kind === 'json') {
      try {
        const parsed = JSON.parse(buf);
        if (Array.isArray(parsed)) return { content: parsed as ContentBlock[] };
      } catch {
        // Fall through — treat as raw text rather than throwing.
      }
    }
    return { content: [{ type: 'text', text: buf }] };
  },

  async write(pointer, result): Promise<void> {
    const info = pointer as PersistedPointer;
    if (info.kind === 'json') {
      await writeFile(info.path, JSON.stringify(result.content), 'utf8');
      return;
    }
    // For text-format files, flatten any text blocks back to raw text.
    // Non-text blocks are JSON-stringified rather than dropped — better
    // to leak structure than silently lose content.
    const text = result.content
      .map((b) => (b.type === 'text' ? String((b as { text?: string }).text ?? '') : JSON.stringify(b)))
      .join('\n');
    await writeFile(info.path, text, 'utf8');
  },

  rewriteWire(_pointer, original): ToolResult {
    if (original.content.length !== 1 || original.content[0].type !== 'text') return original;
    const text = (original.content[0] as { text?: string }).text ?? '';
    return {
      content: [{ type: 'text', text: text.replace(PREVIEW_RE, '') }],
      isError: original.isError,
    };
  },
};

/**
 * Resolution order:
 *   1. `process.env.ANTHROPIC_BASE_URL`
 *   2. Hook discovery (claude's own resolved settings — managed/user/project)
 *   3. `https://api.anthropic.com`
 *
 * The explicit `upstream:` passed to `startRunner` is handled before
 * this resolver is even called.
 */
async function claudeUpstreamResolver(): Promise<string> {
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  const discovered = await discoverClaudeUpstream();
  return discovered ?? 'https://api.anthropic.com';
}
