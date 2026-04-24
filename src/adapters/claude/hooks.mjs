#!/usr/bin/env node
/**
 * Claude PreToolUse + PostToolUse adapter — thin pipe to the plugin server.
 *
 * Passes tool responses verbatim to the middleware server — including
 * truncated `<persisted-output>` blocks. Middleware that needs the full
 * content can use `callLLM({ resume: true })` to fork the agent's session.
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

  // Claude Code payloads carry `hook_event_name`; the `hook_type` fallback
  // is a belt-and-suspenders for any older/forked build that still emits
  // the old field.
  const hookEvent = String(payload.hook_event_name ?? payload.hook_type ?? '');

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
  // Other hook types (Notification, SessionStart, UserPromptSubmit,
  // SubagentStop, PreCompact, SessionEnd, etc.) are no-ops — they're not
  // tool events.
}

main();
