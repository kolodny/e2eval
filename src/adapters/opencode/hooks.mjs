/**
 * Opencode plugin adapter — thin pipe to the plugin server.
 *
 * Opencode requires a `.mjs` file with `{ id, server() }` export. The
 * adapter copies this into runDir and registers it in `opencode.jsonc`.
 *
 * All logic (format parsing, tool-log writes, forbidden-path checks,
 * afterToolResponse hooks) lives in the plugin server. This file just
 * translates opencode's plugin events into HTTP calls.
 */
import http from 'node:http';

const PLUGIN_SERVER = process.env.EVAL_PLUGIN_SERVER ?? '';
const RUN_ID = process.env.EVAL_RUN_ID ?? '';

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

export default {
  id: 'e2eval-tool-logger',
  async server(_input, _options) {
    return {
      // Disable auto-continue after compaction — without this, opencode
      // loops endlessly ("anything else?") after answering the question.
      'experimental.compaction.autocontinue': async (_input, output) => {
        output.enabled = false;
      },
      // Reinforce citation instructions in the system prompt. Opencode's
      // default system prompt uses a task/plan format that often swallows
      // the user-prompt-level citation instructions.
      'experimental.chat.system.transform': async (_input, output) => {
        output.system.push(
          'CRITICAL: Your final response MUST end with a Sources: block. ' +
          'Format: the word "Sources:" on its own line, followed by a JSON array ' +
          'of objects with "tool" and "input" keys. Every tool call you relied on ' +
          'must appear. If you used no tools, emit Sources: []. ' +
          'Do NOT use markdown code fences around the JSON. ' +
          'Do NOT omit this block — responses without it are graded as failures.'
        );
      },
      'tool.execute.before': async (input, output) => {
        const result = await post('/pre-tool', {
          tool: input.tool,
          args: output?.args,
          hookType: 'before',
          runId: RUN_ID,
        });
        if (result?.block) {
          throw new Error(result.message);
        }
      },
      'tool.execute.after': async (input, output) => {
        await post('/post-tool', {
          tool: input.tool,
          args: input.args,
          output: output?.output,
          hookType: 'after',
          runId: RUN_ID,
        });
      },
    };
  },
};
