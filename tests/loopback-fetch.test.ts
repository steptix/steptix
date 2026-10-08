import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackFetch } from '../src/browser/loopback-fetch.js';
import { probePort } from '../src/browser/cdp-discovery.js';
import { preflightCdpPort } from '../src/browser/manager.js';
import { FETCH_BAD_PORTS, listenFetchable } from './listen-fetchable.cjs';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const server = createServer(handler);
  servers.push(server);
  return server;
}

/** What `/json/version` answers on Chrome, trimmed to what discovery reads. */
const VERSION_JSON = JSON.stringify({ Browser: 'Chrome/150.0.0.0', webSocketDebuggerUrl: 'ws://x' });

/**
 * Listen on a port the Fetch standard blocks. There is no way to make the OS
 * choose one, so this tries the unprivileged ones in turn and takes the first
 * that binds — a fixed port, unlike every other test here, because the port
 * IS the subject. A port already taken (another run doing the same, a real
 * service, a Windows reserved range) is skipped, not fought over. Null when
 * none binds.
 */
async function listenOnBadPort(server: Server): Promise<number | null> {
  for (const port of [...FETCH_BAD_PORTS].filter((p) => p >= 1024)) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return port;
    } catch {
      // Taken or reserved here: try the next one.
    }
  }
  return null;
}

describe('loopbackFetch', () => {
  it('answers like fetch: status, ok and a JSON body', async () => {
    const server = serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"a":1}');
    });
    const port = await listenFetchable(server, '127.0.0.1');
    const res = await loopbackFetch(`http://127.0.0.1:${port}/json/version`);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('reports a 404 as a response, not a rejection', async () => {
    const server = serve((_req, res) => {
      res.writeHead(404);
      res.end('No such target id: x');
    });
    const port = await listenFetchable(server, '127.0.0.1');
    const res = await loopbackFetch(`http://127.0.0.1:${port}/json/close/x`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('No such target id: x');
  });

  it('rejects a response it cannot represent, rather than throwing out of the socket handler', async () => {
    // 600 is outside what a `Response` accepts (200-599); Node passes it on.
    const server = serve((_req, res) => {
      res.writeHead(600);
      res.end('?');
    });
    const port = await listenFetchable(server, '127.0.0.1');
    await expect(loopbackFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow('unreadable response (HTTP 600)');
  });

  it('sends the method it is given', async () => {
    let method = '';
    const server = serve((req, res) => {
      method = req.method ?? '';
      res.end('{}');
    });
    const port = await listenFetchable(server, '127.0.0.1');
    await loopbackFetch(`http://127.0.0.1:${port}/json/new`, { method: 'PUT' });
    expect(method).toBe('PUT');
  });

  it('rejects with an AbortError when the signal fires mid-request', async () => {
    const server = serve(() => {
      // Never answers: the abort is the only way out.
    });
    const port = await listenFetchable(server, '127.0.0.1');
    const controller = new AbortController();
    const reached = once(server, 'request');
    const pending = loopbackFetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    await reached;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects at once for a signal that has already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loopbackFetch('http://127.0.0.1:1/', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('refuses what the DevTools surface never needs rather than dropping it', async () => {
    await expect(loopbackFetch('https://127.0.0.1:1/')).rejects.toThrow('only speaks http:');
    await expect(loopbackFetch('http://127.0.0.1:1/', { method: 'POST', body: 'x' })).rejects.toThrow(
      'sends no request body',
    );
    await expect(loopbackFetch('http://127.0.0.1:1/', { headers: { a: 'b' } })).rejects.toThrow(
      'sends no request headers',
    );
    await expect(loopbackFetch(new Request('http://127.0.0.1:1/'))).rejects.toThrow('not a Request');
  });
});

describe('a browser on a port fetch refuses (#22)', () => {
  it('is unreachable through fetch, and reachable — and identified — through discovery and attach', async (ctx) => {
    const requests: string[] = [];
    const server = serve((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url === '/json/list' ? '[]' : VERSION_JSON);
    });
    const port = await listenOnBadPort(server);
    if (port === null) ctx.skip();
    let connections = 0;
    server.on('connection', () => connections++);

    // The bug: global fetch will not even try. Refused in-process, so the
    // server sees no connection at all — not a failed request, nothing.
    const err = await fetch(`http://127.0.0.1:${port}/json/version`).then(
      () => null,
      (e: unknown) => e as Error & { cause?: Error },
    );
    expect(err?.cause?.message).toBe('bad port');
    expect(connections).toBe(0);
    expect(requests).toEqual([]);

    // The fix: discovery's default goes through loopbackFetch.
    const probed = await probePort(port!, 2_000);
    expect(probed).toMatchObject({ port, reachable: true, engine: 'chrome', tabs: [] });
    // Over the wire, to that very port.
    expect(requests).toEqual(['/json/version', '/json/list']);

    // And attaching a session to it gets past the preflight, by `localhost`.
    await expect(preflightCdpPort(port!)).resolves.toBeUndefined();
    expect(requests).toEqual(['/json/version', '/json/list', '/json/version']);
  });
});
