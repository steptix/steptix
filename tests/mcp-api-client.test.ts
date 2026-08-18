import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SseParser, createApiClient } from '../src/mcp/api-client.js';
import { ApiHttpError, ApiRouteNotFoundError } from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// The SSE reader is hand-written (taking runner-core as a dependency would put
// a CommonJS package inside this ESM one), so the framing rules need pinning
// here rather than being inherited from a tested library. The awkward cases
// are all real: the server sends `: keep-alive` comment frames every 25s, and
// a chunk boundary can fall anywhere — including mid-frame.
// ---------------------------------------------------------------------------

describe('SseParser', () => {
  it('parses a single frame', () => {
    const parser = new SseParser();
    const { events } = parser.push(
      'event: step:pass\ndata: {"type":"step:pass","line":4}\n\n',
    );

    expect(events).toEqual([{ type: 'step:pass', line: 4 }]);
  });

  it('dispatches on the payload type, not the event field', () => {
    // Both are sent and they agree today, but the payload is the one the type
    // system knows about — trusting the header would make a mismatch silent.
    const parser = new SseParser();
    const { events } = parser.push('event: nonsense\ndata: {"type":"done","status":"passed"}\n\n');

    expect(events).toEqual([{ type: 'done', status: 'passed' }]);
  });

  it('skips comment frames', () => {
    const parser = new SseParser();
    const { events, dropped } = parser.push(': keep-alive\n\n');

    expect(events).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('reassembles a frame split across chunks', () => {
    const parser = new SseParser();
    const first = parser.push('data: {"type":"step:');
    expect(first.events).toEqual([]);

    const second = parser.push('start","line":7}\n\n');
    expect(second.events).toEqual([{ type: 'step:start', line: 7 }]);
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    const { events } = parser.push('data: {"type":"done","status":"failed"}\r\n\r\n');

    expect(events).toEqual([{ type: 'done', status: 'failed' }]);
  });

  it('accepts a data field with or without the conventional space', () => {
    // One space after the colon is framing, not value. Both spellings are
    // legal SSE and the server has used both over its life, so neither may
    // depend on the other.
    const withSpace = new SseParser().push('data: {"type":"done","status":"passed"}\n\n');
    const withoutSpace = new SseParser().push('data:{"type":"done","status":"passed"}\n\n');

    expect(withSpace.events).toEqual([{ type: 'done', status: 'passed' }]);
    expect(withoutSpace.events).toEqual(withSpace.events);
  });

  it('joins multi-line data fields with newlines', () => {
    const parser = new SseParser();
    const { events } = parser.push('data: {"type":"output",\ndata: "msg":"a\\nb","kind":"warn"}\n\n');

    expect(events).toEqual([{ type: 'output', msg: 'a\nb', kind: 'warn' }]);
  });

  it('records an unparseable frame instead of failing the run', () => {
    const parser = new SseParser();
    const { events, dropped } = parser.push('data: {not json\n\n');

    expect(events).toEqual([]);
    expect(dropped[0]).toContain('unparseable');
  });

  it('records an unknown event type instead of failing the run', () => {
    // A server that grows a new event type should not break an older client
    // in the middle of a run.
    const parser = new SseParser();
    const { events, dropped } = parser.push('data: {"type":"step:teleported"}\n\n');

    expect(events).toEqual([]);
    expect(dropped[0]).toContain('step:teleported');
  });

  it('delivers several frames from one chunk in order', () => {
    const parser = new SseParser();
    const { events } = parser.push(
      'data: {"type":"step:start","line":1}\n\n' +
        ': keep-alive\n\n' +
        'data: {"type":"step:pass","line":1}\n\n' +
        'data: {"type":"done","status":"passed"}\n\n',
    );

    expect(events.map((e) => e.type)).toEqual(['step:start', 'step:pass', 'done']);
  });
});

// ---------------------------------------------------------------------------
// Client behaviour over a real socket. Mocking fetch would only assert about
// the mock; the interesting cases here — a stream that stops without a `done`,
// a 400 that arrives as ordinary HTTP despite `?stream=1` — are transport
// facts.
// ---------------------------------------------------------------------------

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startServer(
  handler: (url: string, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req.url ?? '', res));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('createApiClient.streamSteps', () => {
  it('reads a complete run', async () => {
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"step:start","line":1}\n\n');
      res.write('data: {"type":"step:pass","line":1}\n\n');
      res.write('data: {"type":"done","status":"passed"}\n\n');
      res.end();
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    const seen: string[] = [];
    const result = await client.streamSteps('s1', { steps: ['x'] }, undefined, (e) =>
      seen.push(e.type),
    );

    expect(result.streamDropped).toBe(false);
    expect(seen).toEqual(['step:start', 'step:pass', 'done']);
  });

  it('reports a stream that ends without done', async () => {
    // The server was killed, force-stopped or reaped mid-run. The run may
    // still be executing over there, so this is not simply a failure.
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"step:start","line":1}\n\n');
      res.end();
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    const result = await client.streamSteps('s1', { steps: ['x'] });

    expect(result.streamDropped).toBe(true);
    expect(result.events.map((e) => e.type)).toEqual(['step:start']);
  });

  it('surfaces a validation 400, which arrives as plain HTTP even with ?stream=1', async () => {
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body must include a "steps" array' }));
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await expect(client.streamSteps('s1', { steps: [] })).rejects.toThrow(ApiHttpError);
    await expect(client.streamSteps('s1', { steps: [] })).rejects.toThrow(/steps" array/);
  });

  it('surfaces a 401 with the server message', async () => {
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid x-api-key header' }));
    });

    const client = createApiClient({ baseUrl, apiKey: 'wrong' });
    await expect(client.streamSteps('s1', { steps: ['x'] })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rethrows on our own cancellation rather than calling it a dropped stream', async () => {
    // The distinction matters: a cancelled tool call returns nothing to the
    // host, while a dropped stream produces a result saying the run may still
    // be running.
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"step:start","line":1}\n\n');
      // deliberately never ends
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await expect(
      client.streamSteps('s1', { steps: ['x'] }, controller.signal),
    ).rejects.toThrow();
  });

  it('sends the api key and asks for a stream', async () => {
    let seenUrl = '';
    let seenKey: string | undefined;
    server = createServer((req, res) => {
      seenUrl = req.url ?? '';
      seenKey = req.headers['x-api-key'] as string;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"done","status":"passed"}\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');

    const client = createApiClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'secret',
    });
    await client.streamSteps('mcp:c:/a b/test.md', { steps: ['x'] });

    expect(seenKey).toBe('secret');
    expect(seenUrl).toContain('stream=1');
    // Session ids are file paths, so they must survive the URL intact.
    expect(seenUrl).toContain(encodeURIComponent('mcp:c:/a b/test.md'));
  });
});

describe('createApiClient other routes', () => {
  it('unwraps the sessions list', async () => {
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [{ sessionId: 'mcp:a' }] }));
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await expect(client.listSessions()).resolves.toEqual([{ sessionId: 'mcp:a' }]);
  });

  it('returns last-run info as given', async () => {
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ finalized: false }));
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await expect(client.getLastRun('s1')).resolves.toEqual({ finalized: false });
  });

  it('builds the page-content query, encoding the selector and session id', async () => {
    let seen = '';
    const baseUrl = await startServer((url, res) => {
      seen = url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId: 'mcp:a b', content: 'hi' }));
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await client.getPageContent('mcp:a b', {
      format: 'dom',
      selector: 'div > p[data-x="1"]',
      maxChars: 5000,
    });

    expect(seen).toContain('/sessions/mcp%3Aa%20b/content?');
    expect(seen).toContain('format=dom');
    expect(seen).toContain('max_chars=5000');
    // Encoded, not raw — a selector carries >, ", # and & routinely, and an
    // unencoded # would truncate the URL at the fragment.
    expect(seen).toContain(`selector=${encodeURIComponent('div > p[data-x="1"]').replace(/%20/g, '+')}`);
  });

  it('sends no query at all when nothing was asked for', async () => {
    let seen = '';
    const baseUrl = await startServer((url, res) => {
      seen = url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId: 's1' }));
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await client.getPageContent('s1', {});

    expect(seen).toBe('/sessions/s1/content');
  });

  it('surfaces the server message on a failed page read', async () => {
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'the page navigated while it was being read' }));
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await expect(client.getPageContent('s1', {})).rejects.toMatchObject({
      status: 409,
      serverMessage: 'the page navigated while it was being read',
    });
  });

  it('closes a session', async () => {
    let method = '';
    const baseUrl = await startServer((_url, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'closed' }));
    });
    server!.on('request', (req) => {
      method = req.method ?? '';
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await client.closeSession('s1');
    expect(method).toBe('DELETE');
  });

  it('POSTs a tab focus, encoding the target id and sending allowUnowned only when asked', async () => {
    let seen = '';
    let method = '';
    const baseUrl = await startServer((url, res) => {
      seen = url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ focused: true, targetId: 'A/B', title: 'Docs' }));
    });
    server!.on('request', (req) => {
      method = req.method ?? '';
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await client.focusCdpTab({ projectRoot: 'C:\\proj', port: 51000, targetId: 'A/B' });

    expect(method).toBe('POST');
    // Encoded, so an id carrying `/`, `?` or `#` addresses the tab it names
    // rather than a different route.
    expect(seen).toContain('/cdp/browsers/51000/tabs/A%2FB/focus?');
    expect(seen).not.toContain('allowUnowned');

    await client.focusCdpTab({
      projectRoot: 'C:\\proj',
      port: 51000,
      targetId: 'A/B',
      allowUnowned: true,
    });
    expect(seen).toContain('allowUnowned=true');
  });

  it('distinguishes "no such tab" from "no such route" on a 404', async () => {
    // Both are 404s and they mean opposite things. Our route answers with a
    // JSON `error`; a server from a build that predates the route has Express
    // answer its own 404 with HTML, and flattening that into the status text
    // would tell the agent the user's tab is gone.
    const ours = await startServer((_url, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No tab with target id GONE is open' }));
    });
    const tabGone = await createApiClient({ baseUrl: ours, apiKey: 'k' })
      .focusCdpTab({ projectRoot: 'C:\\proj', port: 51000, targetId: 'GONE' })
      .catch((e: unknown) => e);
    expect(tabGone).toBeInstanceOf(ApiHttpError);
    expect(tabGone).not.toBeInstanceOf(ApiRouteNotFoundError);
    expect(tabGone).toMatchObject({
      status: 404,
      serverMessage: 'No tab with target id GONE is open',
    });

    await new Promise<void>((r) => server!.close(() => r()));

    const older = await startServer((_url, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>Cannot POST /cdp/browsers/51000/tabs/T1/focus</body></html>');
    });
    const routeGone = await createApiClient({ baseUrl: older, apiKey: 'k' })
      .focusCdpTab({ projectRoot: 'C:\\proj', port: 51000, targetId: 'T1' })
      .catch((e: unknown) => e);
    // A distinct TYPE, not an empty message — see the next test for why.
    expect(routeGone).toBeInstanceOf(ApiRouteNotFoundError);
  });

  it('does not call a JSON 404 a stale server just because it parsed to nothing useful', async () => {
    // Round two of the same hole. `envelope === null` was doing double duty as
    // "did not parse" and "parsed to JSON null", and a bare scalar or an empty
    // body fell through the same crack — all reported as a missing route, which
    // is the confident lie this branch exists to prevent. An empty-body 404
    // from a load balancer is the realistic trigger.
    for (const [label, raw, contentType] of [
      ['JSON null', 'null', 'application/json'],
      ['bare string', '"not found"', 'application/json'],
      ['bare number', '404', 'application/json'],
      ['empty body', '', 'application/json'],
    ] as const) {
      const proxy = await startServer((_url, res) => {
        res.writeHead(404, { 'Content-Type': contentType });
        res.end(raw);
      });
      const err = await createApiClient({ baseUrl: proxy, apiKey: 'k' })
        .focusCdpTab({ projectRoot: 'C:\\proj', port: 51000, targetId: 'T1' })
        .catch((e: unknown) => e);

      // An empty body does not parse, so it IS a missing route by this rule;
      // the other three are deliberate answers and must not be.
      if (label === 'empty body') {
        expect(err, label).toBeInstanceOf(ApiRouteNotFoundError);
      } else {
        expect(err, label).toBeInstanceOf(ApiHttpError);
        expect(err, label).not.toBeInstanceOf(ApiRouteNotFoundError);
        expect((err as ApiHttpError).serverMessage, label).not.toBe('');
      }

      await new Promise<void>((r) => server!.close(() => r()));
    }
  });

  it('never leaves an ApiHttpError with an empty message, even over an empty status text', async () => {
    // `statusText` is empty over HTTP/2 and from servers that send a bare
    // reason phrase. Seeded from it alone, the error carries nothing, and the
    // tool layer renders "rejected the request (HTTP 404): " — a dangling
    // colon that reads like the message was lost rather than never sent.
    const baseUrl = await startServer((_url, res) => {
      // Node lets an empty reason phrase through, which is what a proxy or an
      // HTTP/2 hop produces.
      res.writeHead(503, '', { 'Content-Type': 'text/plain' });
      res.end('');
    });

    const err = await createApiClient({ baseUrl, apiKey: 'k' })
      .listSessions()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as ApiHttpError).serverMessage).not.toBe('');
    expect((err as ApiHttpError).serverMessage).toContain('503');
  });

  it('does not call a JSON 404 a stale server just because it has no `error` string', async () => {
    // The hole in inferring route-missing from an absent message. Any
    // intermediary that answers 404 with JSON carrying a non-string `error` —
    // an error object, a `message` key, a proxy's own envelope — parses fine
    // and leaves nothing to quote. Reported as "your server predates this
    // route, run npm run build" it is a confident lie about a server that may
    // be perfectly current.
    for (const body of [
      { error: { code: 'ENOTFOUND' } },
      { message: 'not found' },
      { error: 42 },
      {},
    ]) {
      const gateway = await startServer((_url, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      const err = await createApiClient({ baseUrl: gateway, apiKey: 'k' })
        .focusCdpTab({ projectRoot: 'C:\\proj', port: 51000, targetId: 'T1' })
        .catch((e: unknown) => e);

      expect(err, JSON.stringify(body)).toBeInstanceOf(ApiHttpError);
      expect(err, JSON.stringify(body)).not.toBeInstanceOf(ApiRouteNotFoundError);
      // And it still says *something* rather than going quiet.
      expect((err as ApiHttpError).serverMessage).not.toBe('');

      await new Promise<void>((r) => server!.close(() => r()));
    }
  });

  // -------------------------------------------------------------------------
  // peekCdpTab (stories/tab-peek.md)
  // -------------------------------------------------------------------------

  it('GETs a tab read, encoding the target id and sending only the params it was given', async () => {
    let seen = '';
    let method = '';
    const baseUrl = await startServer((url, res) => {
      seen = url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ targetId: 'A/B', root: null, content: 'hello' }));
    });
    server!.on('request', (req) => {
      method = req.method ?? '';
    });

    const client = createApiClient({ baseUrl, apiKey: 'k' });
    await client.peekCdpTab({
      port: 51000,
      targetId: 'A/B',
      testFilePath: 'C:\\proj\\.aiui-peek.md',
    });

    // A read: GET, no body (page-content.md §Locked's reasoning, verbatim).
    expect(method).toBe('GET');
    // Encoded, so an id carrying `/`, `?` or `#` addresses the tab it names
    // rather than a different route.
    expect(seen).toContain('/cdp/browsers/51000/tabs/A%2FB/content?');
    expect(seen).toContain('testFilePath=');
    // Omitted rather than defaulted client-side: the server owns the defaults,
    // and sending our own would let the two drift.
    expect(seen).not.toContain('format=');
    expect(seen).not.toContain('selector=');
    expect(seen).not.toContain('max_chars=');
    expect(seen).not.toContain('full_page=');

    await client.peekCdpTab({
      port: 51000,
      targetId: 'A/B',
      testFilePath: 'C:\\proj\\.aiui-peek.md',
      format: 'dom',
      selector: '#total',
      maxChars: 500,
    });
    expect(seen).toContain('format=dom');
    expect(seen).toContain('selector=%23total');
    // The sibling content route's spelling, not a camelCase invention.
    expect(seen).toContain('max_chars=500');

    // The picture's own parameter (stories/cdp-tab-screenshot.md), in the same
    // snake_case the route parses — and `false` is SENT rather than treated as
    // a no-op, so an explicit viewport request does not depend on the server's
    // default staying what it is today.
    await client.peekCdpTab({
      port: 51000,
      targetId: 'A/B',
      testFilePath: 'C:\\proj\\.aiui-peek.md',
      format: 'screenshot',
      fullPage: true,
    });
    expect(seen).toContain('format=screenshot');
    expect(seen).toContain('full_page=true');

    await client.peekCdpTab({
      port: 51000,
      targetId: 'A/B',
      testFilePath: 'C:\\proj\\.aiui-peek.md',
      format: 'screenshot',
      fullPage: false,
    });
    expect(seen).toContain('full_page=false');
  });

  it('distinguishes "no such tab" from "no such route" on a peek 404 too', async () => {
    // The same split, and it has to be the same CODE: "the tab is gone" and
    // "your dist/ predates this tool" are opposite remedies, and a peek that
    // reported the first about the second would send a user hunting for a
    // window still sitting on their screen.
    const ours = await startServer((_url, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No tab with target id GONE is open' }));
    });
    const tabGone = await createApiClient({ baseUrl: ours, apiKey: 'k' })
      .peekCdpTab({ port: 51000, targetId: 'GONE', testFilePath: 'C:\\proj\\.aiui-peek.md' })
      .catch((e: unknown) => e);
    expect(tabGone).toBeInstanceOf(ApiHttpError);
    expect(tabGone).not.toBeInstanceOf(ApiRouteNotFoundError);
    expect(tabGone).toMatchObject({
      status: 404,
      serverMessage: 'No tab with target id GONE is open',
    });

    await new Promise<void>((r) => server!.close(() => r()));

    const older = await startServer((_url, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(
        '<!DOCTYPE html><html><body>Cannot GET /cdp/browsers/51000/tabs/T1/content</body></html>',
      );
    });
    const routeGone = await createApiClient({ baseUrl: older, apiKey: 'k' })
      .peekCdpTab({ port: 51000, targetId: 'T1', testFilePath: 'C:\\proj\\.aiui-peek.md' })
      .catch((e: unknown) => e);
    expect(routeGone).toBeInstanceOf(ApiRouteNotFoundError);
  });

  it('leaves a peek 409 and 400 as ordinary HTTP errors', async () => {
    // The `PageCaptureError` mapping is the route's; the client must not
    // reinterpret either status, or a navigated read would reach the tool
    // wearing the gone-tab or the stale-build story.
    for (const status of [409, 400]) {
      const srv = await startServer((_url, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'the page navigated during the read' }));
      });
      const err = await createApiClient({ baseUrl: srv, apiKey: 'k' })
        .peekCdpTab({ port: 51000, targetId: 'T1', testFilePath: 'C:\\proj\\.aiui-peek.md' })
        .catch((e: unknown) => e);

      expect(err, String(status)).toBeInstanceOf(ApiHttpError);
      expect(err, String(status)).not.toBeInstanceOf(ApiRouteNotFoundError);
      expect((err as ApiHttpError).status, String(status)).toBe(status);

      await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});
