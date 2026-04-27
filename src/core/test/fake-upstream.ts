/**
 * Generic fake-upstream HTTP server for test adapters.
 *
 * Each test adapter (claude, opencode, codex) drives a real agent
 * binary against an in-process fake provider. The fake's plumbing is
 * identical across adapters — only the URL match, response body
 * shape, and any per-format auto-skip filter differ. This module
 * owns that plumbing.
 *
 *   - Buffers body, parses as JSON.
 *   - Optional `autoSkip(req) → unknown | null` short-circuits a
 *     request before it reaches the script (e.g. claude's Haiku
 *     decision calls, opencode's title-gen calls). Return any value
 *     to use it as the response body, null to fall through.
 *   - Then one of:
 *       script: array form — consumed in order, 500 on overflow with
 *         `script_exhausted`.
 *       script: callback form — invoked with the parsed request.
 *   - Wraps the user's script result via `buildBody(scripted, req)`
 *     and returns it as JSON.
 *   - Throws inside script callbacks become 400s with the message —
 *     so test fixture errors surface fast as run failures rather than
 *     silent timeouts (4xx doesn't trigger SDK retry).
 */
import http from 'node:http';

export type FakeRequestContext = {
  /** Zero-indexed substantive turn — autoSkip-handled requests don't increment. */
  turnIndex: number;
};

export type FakeUpstreamOpts<TReq, TScripted> = {
  /** Path the fake responds to (anything else returns 404). */
  pathMatch: (url: string) => boolean;
  /** Either a per-turn array, or a callback computing the response. */
  respond: TScripted[] | ((req: TReq, ctx: FakeRequestContext) => TScripted | Promise<TScripted>);
  /** Build the JSON response body to send. Receives the user's scripted entry plus the parsed request. */
  buildBody: (scripted: TScripted, parsedReq: TReq) => unknown;
  /**
   * Optional pre-filter. Return non-null to short-circuit with that
   * body and not consume the script / not call respond. Useful for
   * auxiliary calls the agent makes that aren't part of the
   * substantive turn (title generation, model routing, etc.).
   */
  autoSkip?: (parsedReq: TReq) => unknown | null;
  /** Human-readable name in error messages — defaults to "fake-upstream". */
  scriptName?: string;
};

export type FakeUpstream = {
  url: string;
  close: () => Promise<void>;
};

export async function startFakeUpstream<TReq = any, TScripted = any>(
  opts: FakeUpstreamOpts<TReq, TScripted>,
): Promise<FakeUpstream> {
  const { pathMatch, respond, buildBody, autoSkip } = opts;
  const scriptName = opts.scriptName ?? 'fake-upstream';
  const isArray = Array.isArray(respond);
  const arr = isArray ? [...(respond as TScripted[])] : null;
  let turnIndex = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST' || !pathMatch(req.url ?? '')) {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let parsedReq = {} as TReq;
    try { parsedReq = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TReq; } catch { /* keep default */ }

    if (autoSkip) {
      const skipBody = autoSkip(parsedReq);
      if (skipBody != null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(skipBody));
        return;
      }
    }

    let scripted: TScripted;
    try {
      if (arr) {
        if (turnIndex >= arr.length) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              type: 'script_exhausted',
              message: `${scriptName} ran out of scripted responses after ${turnIndex}`,
            },
          }));
          return;
        }
        scripted = arr[turnIndex];
      } else {
        scripted = await (respond as (req: TReq, ctx: FakeRequestContext) => TScripted | Promise<TScripted>)(
          parsedReq, { turnIndex },
        );
      }
    } catch (err) {
      // 400 (not 500) so the SDK doesn't retry — test fixture throws
      // surface as fast run failures, not silent timeouts.
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: `e2eval respond callback threw: ${msg}` },
      }));
      return;
    }

    turnIndex += 1;
    const body = buildBody(scripted, parsedReq);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => {
          server.close(() => r());
          // Drop any keep-alive sockets the proxy's outbound fetch left
          // pooled — otherwise server.close() waits on idle timeouts and
          // the test process won't exit until they expire.
          server.closeAllConnections();
        }),
      });
    });
  });
}
