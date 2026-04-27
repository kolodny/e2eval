/**
 * Generic transparent HTTP proxy with hooks for SSE synthesis.
 *
 * Both the Anthropic /v1/messages and OpenAI /v1/responses proxies
 * have identical HTTP plumbing — body buffering, header forwarding,
 * fetch upstream, 502 on connection error, force-non-streaming on
 * the upstream request and synthesize SSE on the way back. This
 * module owns that plumbing; wire-format-specific code lives in the
 * caller's hooks.
 *
 * Lifecycle of a single request:
 *   1. Buffer incoming body, parse as JSON if URL matches.
 *   2. If `transformRequest` provided, run it on the parsed body
 *      (mutates in place). Detect `stream: true`, force `false` for
 *      upstream — we synthesize SSE locally.
 *   3. Forward to upstream with sanitised headers.
 *   4. If the URL matched and the agent expected SSE, parse the JSON
 *      response, run `transformResponse`, then synthesize SSE via the
 *      provided synthesizer. Otherwise pass through verbatim.
 *
 * Errors:
 *   - Network/connection error → 502 with `{error:{type:'proxy_error'}}`.
 *   - Upstream non-JSON or shape mismatch on a matched request → pass
 *     through verbatim with the upstream's content-type.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export type AgentProxy = {
  /** URL agents use as their provider base. */
  url: string;
  port: number;
  upstream: string;
  close(): Promise<void>;
};

export type ProxyServerOpts<TRequest, TResponse> = {
  /** Upstream root URL (no trailing slash sensitivity). */
  upstream: string;
  /** Match the URL we should intercept (e.g. `(u) => u.includes('/v1/messages')`). */
  match: (url: string) => boolean;
  /**
   * Mutate the parsed request body before forwarding upstream — the
   * caller restores originals, splices substitutions, etc.
   */
  transformRequest?: (parsed: TRequest) => Promise<void> | void;
  /**
   * Validate that the upstream JSON body is the shape we expect to
   * synthesize SSE from. Return false to pass the response through
   * unchanged (e.g. error envelopes).
   */
  isValidResponse: (parsed: unknown) => parsed is TResponse;
  /**
   * Mutate the parsed response body before synthesizing SSE — the
   * caller runs the middleware chain on each tool call here.
   */
  transformResponse?: (parsed: TResponse) => Promise<void> | void;
  /** Synthesize the SSE byte stream the agent expects. */
  synthesizeSse: (parsed: TResponse) => string;
  /**
   * Called once per matched upstream round-trip with the raw request
   * and response bytes (post our restore-originals transform on the
   * request, raw upstream body on the response). Used by the runner's
   * `record` mode to capture exchanges for later replay. Bytes, not
   * parsed objects — the recording stays format-agnostic.
   */
  onExchange?: (request: string, response: string) => void;
  /** Called once when `proxy.close()` runs. */
  onClose?: () => void;
};

/**
 * Forward incoming headers to the upstream verbatim minus the few
 * hop-by-hop ones we're rewriting (host, content-length, connection),
 * and force `accept: application/json` when the agent asked for SSE so
 * a gateway honoring Accept doesn't surprise us with SSE.
 */
function forwardHeaders(req: IncomingMessage, agentExpectsStreaming: boolean): Headers {
  const fwd = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || k === 'content-length' || k === 'connection') continue;
    if (typeof v === 'string') fwd.set(k, v);
    else if (Array.isArray(v)) fwd.set(k, v.join(', '));
  }
  if (agentExpectsStreaming) fwd.set('accept', 'application/json');
  return fwd;
}

function copyResponseHeaders(upstreamResp: Response): Record<string, string> {
  const out: Record<string, string> = {};
  upstreamResp.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(lk)) return;
    out[k] = v;
  });
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function streamUpstreamThrough(upstreamResp: Response, res: ServerResponse, baseHeaders: Record<string, string>) {
  res.writeHead(upstreamResp.status, {
    ...baseHeaders,
    'content-type': upstreamResp.headers.get('content-type') ?? 'application/octet-stream',
  });
  if (upstreamResp.body) {
    const reader = upstreamResp.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

export async function startProxyServer<TRequest = any, TResponse = any>(
  opts: ProxyServerOpts<TRequest, TResponse>,
): Promise<AgentProxy> {
  const upstream = opts.upstream.replace(/\/$/, '');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }

    const url = req.url ?? '/';
    const matched = opts.match(url);
    let bodyBytes = await readBody(req);
    let agentExpectsStreaming = false;

    if (matched) {
      let parsed: any = null;
      try { parsed = JSON.parse(bodyBytes.toString('utf8')); } catch { /* keep raw */ }
      if (parsed) {
        agentExpectsStreaming = parsed.stream === true;
        if (opts.transformRequest) await opts.transformRequest(parsed as TRequest);
        // Force non-streaming upstream — we synthesize SSE locally.
        parsed.stream = false;
        bodyBytes = Buffer.from(JSON.stringify(parsed));
      }
    }

    const fwdHeaders = forwardHeaders(req, agentExpectsStreaming);

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(`${upstream}${url}`, {
        method: 'POST',
        headers: fwdHeaders,
        body: new Uint8Array(bodyBytes),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: msg } }));
      return;
    }

    const respHeaders = copyResponseHeaders(upstreamResp);

    if (matched && agentExpectsStreaming) {
      const respText = await upstreamResp.text();
      // Capture the round-trip BEFORE we mutate `parsed` via
      // transformResponse — the recording should preserve what the
      // upstream actually returned, byte-for-byte.
      if (opts.onExchange) opts.onExchange(bodyBytes.toString('utf8'), respText);
      let parsed: unknown = null;
      try { parsed = JSON.parse(respText); } catch { /* not JSON */ }

      if (!opts.isValidResponse(parsed)) {
        res.writeHead(upstreamResp.status, {
          ...respHeaders,
          'content-type': upstreamResp.headers.get('content-type') ?? 'application/json',
        });
        res.end(respText);
        return;
      }

      if (opts.transformResponse) await opts.transformResponse(parsed);
      const sse = opts.synthesizeSse(parsed);
      res.writeHead(upstreamResp.status, {
        ...respHeaders,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(sse);
      return;
    }

    await streamUpstreamThrough(upstreamResp, res, respHeaders);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        upstream,
        close: () => new Promise<void>((r) => {
          if (opts.onClose) opts.onClose();
          server.close(() => r());
          // Forcibly drop any keep-alive sockets the agent left behind
          // — server.close() otherwise waits on each one's idle timeout
          // (seconds), which leaks past test exits and hangs the process.
          server.closeAllConnections();
        }),
      });
    });
  });
}
