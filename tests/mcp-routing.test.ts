/**
 * MCP-name routing — end-to-end coverage of the `mcp__<server>__<tool>`
 * convention. The LLM emits a tool call with that name; the proxy
 * splits it into `{server, tool}` and middleware sees the split.
 *
 * Tests the path through the full pipeline (proxy → middleware) for
 * each wire format we support. If `splitMcpName`'s regex regresses
 * (e.g. greedy quantifier on a server name with internal underscores —
 * a bug litmus actually shipped once), middleware sees the wrong
 * `{server, tool}` and these tests fail.
 *
 * Each test short-circuits the call so the agent doesn't try to
 * invoke an MCP server it doesn't have configured.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  startRunner,
  createClaudeTestAdapter,
  createOpencodeTestAdapter,
  createCodexTestAdapter,
  type Middleware,
} from '../src/index.js';

const TEST_TIMEOUT = 60_000;

test('claude: mcp__svr__tool routes with split server/tool', { timeout: TEST_TIMEOUT }, async () => {
  let observed: { server?: string; tool?: string; input?: unknown } = {};
  const adapter = createClaudeTestAdapter({
    respond: [
      {
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'mcp__core-tools__fake_search',
          input: { query: 'hello' },
        }],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ],
  });

  const observer: Middleware = {
    name: 'observer',
    async onToolCall({ server, tool, input }) {
      observed = { server, tool, input };
      // Short-circuit so claude doesn't actually try the unknown MCP tool.
      return { content: [{ type: 'text', text: 'observed' }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [observer] });
  const ran = await runner.run({ name: 'claude-mcp', question: 'go' });
  await runner.close();

  assert.equal(observed.server, 'core-tools');
  assert.equal(observed.tool, 'fake_search');
  assert.deepEqual(observed.input, { query: 'hello' });
  // Tool log should record the MCP-style server, not 'native'.
  assert.equal(ran.toolCalls[0].server, 'core-tools');
  assert.equal(ran.toolCalls[0].tool, 'fake_search');
});

test('claude: server name with internal underscores splits non-greedily', { timeout: TEST_TIMEOUT }, async () => {
  // The bug litmus shipped: `mcp__plugin_amp-team_amp-mcp__getMovie`
  // greedily matched `plugin_amp-team_amp-mcp__getMovie` as server,
  // dropping the tool. Non-greedy fix gives the right split.
  let observed: { server?: string; tool?: string } = {};
  const adapter = createClaudeTestAdapter({
    respond: [
      {
        content: [{
          type: 'tool_use', id: 'tu_1',
          name: 'mcp__plugin_amp-team_amp-mcp__getMovie',
          input: { movieId: 1 },
        }],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ],
  });

  const observer: Middleware = {
    name: 'observer',
    async onToolCall({ server, tool }) {
      observed = { server, tool };
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [observer] });
  await runner.run({ name: 'mcp-greedy', question: 'go' });
  await runner.close();

  assert.equal(observed.server, 'plugin_amp-team_amp-mcp');
  assert.equal(observed.tool, 'getMovie');
});

test('opencode: mcp__svr__tool routes with split server/tool', { timeout: TEST_TIMEOUT }, async () => {
  let observed: { server?: string; tool?: string } = {};
  const adapter = createOpencodeTestAdapter({
    respond: [
      {
        content: [{
          type: 'tool_use', id: 'tu_1',
          name: 'mcp__some-mcp__do_thing',
          input: { x: 1 },
        }],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ],
  });

  const observer: Middleware = {
    name: 'observer',
    async onToolCall({ server, tool }) {
      observed = { server, tool };
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [observer] });
  await runner.run({ name: 'opencode-mcp', question: 'go' });
  await runner.close();

  assert.equal(observed.server, 'some-mcp');
  assert.equal(observed.tool, 'do_thing');
});

test('codex: mcp__svr__tool routes with split server/tool (function_call name)', { timeout: TEST_TIMEOUT }, async () => {
  // Codex tool calls live in `output[].type === 'function_call'`.
  // The same `splitMcpName` convention applies — middleware should
  // see the same `{server, tool}` regardless of wire format.
  let observed: { server?: string; tool?: string; input?: unknown } = {};
  const adapter = createCodexTestAdapter({
    respond: [
      {
        output: [{
          type: 'function_call',
          id: 'fc_1', call_id: 'call_1',
          name: 'mcp__custom-svr__lookup',
          arguments: JSON.stringify({ q: 'hi' }),
        }],
      },
      {
        output: [{
          type: 'message', id: 'm_1', role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        }],
      },
    ],
  });

  const observer: Middleware = {
    name: 'observer',
    async onToolCall({ server, tool, input }) {
      observed = { server, tool, input };
      return { content: [{ type: 'text', text: 'observed' }] };
    },
  };

  const runner = await startRunner({ adapter, middleware: [observer] });
  await runner.run({ name: 'codex-mcp', question: 'go' });
  await runner.close();

  assert.equal(observed.server, 'custom-svr');
  assert.equal(observed.tool, 'lookup');
  assert.deepEqual(observed.input, { q: 'hi' });
});
