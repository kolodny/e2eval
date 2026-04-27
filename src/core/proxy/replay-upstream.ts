/**
 * Replay upstream — wire-format-agnostic.
 *
 * An in-process HTTP server that masquerades as the real
 * `/v1/messages` (or `/v1/responses`, or whatever) upstream the
 * proxy forwards to. For the first `upTo` matched POST requests it
 * returns the recorded response bytes verbatim. Once the prefix is
 * exhausted it forwards every subsequent request to the live upstream.
 *
 * The proxy in front of this server doesn't know it's hybrid — to the
 * proxy it's just an upstream that happens to return prebaked
 * responses for a while. This is what lets us run a real agent
 * deterministically up to a chosen point and then let it diverge with
 * fresh LLM calls afterward.
 *
 * The recording format is bytes, not parsed objects — so this module
 * works for Anthropic, OpenAI Responses, and any future wire format
 * with no changes.
 */
import http from 'node:http';
import type { Recording } from '../types.js';

export type StartReplayUpstreamOpts = {
  /** Pre-captured exchanges; replayed in order. */
  recording: Recording;
  /**
   * Number of matched POSTs to replay before falling through to the
   * live upstream. Must be ≥ 0 and ≤ recording.exchanges.length.
   */
  upTo: number;
  /** URL forwarded to once the prefix is exhausted. */
  liveUpstream: string;
  /** Path predicate — only POSTs matching this get replay/forward treatment. */
  matchPath: (url: string) => boolean;
};

export type ReplayUpstream = {
  /** URL the proxy forwards to. */
  url: string;
  /** Number of matched POSTs served from the recording so far. */
  exchangeIndex(): number;
  close(): Promise<void>;
};

export async function startReplayUpstream(opts: StartReplayUpstreamOpts): Promise<ReplayUpstream> {
  if (opts.upTo < 0) {
    throw new Error(`replay upTo must be ≥ 0, got ${opts.upTo}`);
  }
  if (opts.upTo > opts.recording.exchanges.length) {
    throw new Error(
      `replay upTo (${opts.upTo}) exceeds recording length (${opts.recording.exchanges.length})`,
    );
  }

  const liveUpstream = opts.liveUpstream.replace(/\/$/, '');
  let i = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST' || !opts.matchPath(req.url ?? '')) {
      res.writeHead(404).end();
      return;
    }

    // Replay the prefix verbatim.
    if (i < opts.upTo) {
      const exchange = opts.recording.exchanges[i];
      i += 1;
      // Drain the request body so the client doesn't hang on
      // back-pressure even though we're ignoring it.
      for await (const _ of req) { /* discard */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(exchange.response);
      return;
    }

    // Past the cutoff — forward to the live upstream verbatim.
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyBytes = Buffer.concat(chunks);

    const fwdHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host' || k === 'content-length' || k === 'connection') continue;
      if (typeof v === 'string') fwdHeaders.set(k, v);
      else if (Array.isArray(v)) fwdHeaders.set(k, v.join(', '));
    }

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(`${liveUpstream}${req.url}`, {
        method: 'POST',
        headers: fwdHeaders,
        body: new Uint8Array(bodyBytes),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'replay_proxy_error', message: msg } }));
      return;
    }

    const respHeaders: Record<string, string> = {};
    upstreamResp.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lk)) return;
      respHeaders[k] = v;
    });

    res.writeHead(upstreamResp.status, respHeaders);
    if (upstreamResp.body) {
      const reader = upstreamResp.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        exchangeIndex: () => i,
        close: () => new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections();
        }),
      });
    });
  });
}
