#!/usr/bin/env node
/**
 * Codex PreToolUse + PostToolUse hook — thin pipe to the middleware server.
 *
 * Installed into `$CODEX_HOME/hooks.json` by `setupCodexHome`. The hook runs
 * as a child of codex, so it inherits the EVAL_PLUGIN_SERVER / EVAL_RUN_ID
 * env the adapter set when spawning codex.
 *
 * Protocol is the same as claude's: read the hook payload from stdin, POST
 * to the middleware server, and (for PreToolUse) exit 2 with a stderr
 * message to block the tool. The only difference is codex's event
 * discriminator: `hook_event_name` vs claude's `hook_type`.
 */
import http from 'node:http';

const PLUGIN_SERVER = process.env.EVAL_PLUGIN_SERVER ?? '';
const RUN_ID = process.env.EVAL_RUN_ID ?? '';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function post(path, body) {
  if (!PLUGIN_SERVER) return Promise.resolve(null);
  const data = JSON.stringify(body);
  const url = new URL(path, PLUGIN_SERVER);
  return new Promise((resolve) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return; }

  const hookEvent = String(payload.hook_event_name ?? '');

  payload.runId = RUN_ID;

  if (hookEvent === 'PreToolUse') {
    const result = await post('/pre-tool', payload);
    if (result?.block) {
      process.stderr.write(result.message + '\n');
      process.exit(2);
    }
  } else if (hookEvent === 'PostToolUse') {
    await post('/post-tool', payload);
  }
  // Other codex hook events (SessionStart, PermissionRequest,
  // UserPromptSubmit, Stop) are no-ops.
}

main().catch((e) => {
  process.stderr.write(`[codex-hooks] fatal: ${e.stack ?? e}\n`);
});
