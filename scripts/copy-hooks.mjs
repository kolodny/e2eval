#!/usr/bin/env node
/**
 * Copy adapter hook scripts (hooks.mjs) from src/ to dist/.
 *
 * Each Claude/Opencode adapter resolves its hook script via
 *   new URL('./hooks.mjs', import.meta.url)
 * so the file must sit next to the compiled adapter.js in dist/. tsc does
 * not copy non-.ts files, hence this step in the build pipeline.
 */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const hooks = [
  'adapters/claude/hooks.mjs',
  'adapters/opencode/hooks.mjs',
];

for (const rel of hooks) {
  const src = resolve(repoRoot, 'src', rel);
  const dst = resolve(repoRoot, 'dist', rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  console.log(`copied ${rel}`);
}
