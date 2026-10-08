/**
 * `fetch` for a browser's DevTools HTTP endpoint, over `node:http`.
 *
 * Node's global `fetch` (undici) refuses the Fetch standard's "bad ports" —
 * 6000, 6665-6669, 10080 and the rest of
 * https://fetch.spec.whatwg.org/#port-blocking — before it opens a socket. A
 * browser `cdp-launcher.ts` starts with `--remote-debugging-port=0` listens on
 * whatever port the OS hands it, and on a machine whose dynamic range starts
 * low (1024-65535 is a legitimate setting) that can be one of those. `fetch`
 * then fails every `/json/version` probe with `bad port`, and a healthy browser
 * is reported as never ready. Playwright's `connectOverCDP` does its own HTTP
 * and WebSocket, so it was never affected; only these probes were. The block
 * list protects browsers from being steered at non-HTTP services, which does
 * not apply to a loopback port a browser told us it is serving DevTools on.
 *
 * Only what the DevTools surface needs: a URL string or `URL` (not a
 * `Request`), `http:`, a method with no request body or headers, and an
 * `AbortSignal` — which callers must pass, since this has no deadline of its
 * own. Anything else is refused rather than silently dropped. The answer is a
 * real `Response`, so callers keep `res.ok`, `res.status` and `res.json()`.
 * No connection pooling: these probes are occasional, and a pooled socket the
 * browser has since closed would fail the next one.
 */
import http from 'node:http';

/** Statuses whose `Response` may not carry a body (1xx never reach here). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export const loopbackFetch: typeof fetch = (input, init) => {
  if (input instanceof Request) {
    return Promise.reject(new TypeError('loopbackFetch takes a URL, not a Request'));
  }
  const url = new URL(String(input));
  if (url.protocol !== 'http:') {
    return Promise.reject(new TypeError(`loopbackFetch only speaks http:, not ${url.protocol}`));
  }
  if (init?.body != null) {
    return Promise.reject(new TypeError('loopbackFetch sends no request body'));
  }
  if (init?.headers !== undefined) {
    return Promise.reject(new TypeError('loopbackFetch sends no request headers'));
  }
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<Response>((resolve, reject) => {
    const req = http.request(url, { method: init?.method ?? 'GET', signal, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      // Cut off mid-body with no 'error' (the browser exiting, say): settle
      // rather than hang. After 'end' this is a no-op.
      res.on('close', () => {
        if (!res.complete) reject(new Error(`connection closed before the response from ${url.href} was complete`));
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        // Everything that can throw is in here: a throw out of an 'end'
        // listener is an uncaught exception, and the promise never settles.
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
          }
          resolve(
            new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), {
              status,
              statusText: res.statusMessage ?? '',
              headers,
            }),
          );
        } catch (err) {
          // A header the WHATWG Headers class refuses, or a status a `Response`
          // cannot represent (outside 200-599). No DevTools endpoint answers
          // either, so say what came back rather than guess.
          reject(new Error(`unreadable response (HTTP ${status}) from ${url.href}: ${(err as Error).message}`));
        }
      });
    });
    // An abort arrives here as an AbortError, the same rejection `fetch` gives.
    req.on('error', reject);
    req.end();
  });
};
