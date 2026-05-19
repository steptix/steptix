// Unit coverage for the CDP discovery module
// (stories/flick-vscode-cdp-attach.md "Extension: CDP discovery").
// fetch is mocked via the fetchFn option so tests run with no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCdpPorts } from '../../src/extension/cdp-discovery';

type FetchFn = typeof fetch;

interface CannedResponse {
  ok?: boolean;
  status?: number;
  json: unknown;
}

/** Build a fetchFn that dispatches by URL substring. A handler may return a
 *  canned response, throw, or return a Promise. */
function mockFetch(
  handlers: Record<string, () => CannedResponse | Promise<CannedResponse> | never>,
): FetchFn {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const key of Object.keys(handlers)) {
      if (url.includes(key)) {
        const result = await handlers[key]();
        return {
          ok: result.ok ?? true,
          status: result.status ?? 200,
          json: async () => result.json,
        } as Response;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as FetchFn;
}

test('two ports respond, one is unreachable; tabs filtered to page-type non-devtools', async () => {
  const fetchFn = mockFetch({
    '127.0.0.1:9222/json/version': () => ({ json: { Browser: 'Chrome/120.0.6099.130' } }),
    '127.0.0.1:9222/json/list': () => ({
      json: [
        { id: 'a1', type: 'page', title: 'GitHub', url: 'https://github.com/pkent' },
        { id: 'a2', type: 'page', title: 'devtools', url: 'devtools://devtools/bundled/inspector.html' },
        { id: 'a3', type: 'iframe', title: 'frame', url: 'https://example.com/iframe' },
      ],
    }),
    '127.0.0.1:9223': () => {
      throw new TypeError('connection refused');
    },
    '127.0.0.1:9229/json/version': () => ({ json: { Browser: 'Edge/120.0.2210.91' } }),
    '127.0.0.1:9229/json/list': () => ({
      json: [{ id: 'e1', type: 'page', title: 'Inbox', url: 'https://outlook.office.com/' }],
    }),
  });

  const result = await discoverCdpPorts([9222, 9223, 9229], { fetchFn });

  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((r) => r.port),
    [9222, 9223, 9229],
  );

  assert.equal(result[0].engine, 'chrome');
  assert.ok(result[0].tabs, 'port 9222 tabs should not be null');
  assert.equal(result[0].tabs!.length, 1);
  assert.equal(result[0].tabs![0].targetId, 'a1');
  assert.equal(result[0].tabs![0].title, 'GitHub');
  assert.equal(result[0].error, undefined);

  assert.equal(result[1].engine, 'unknown');
  assert.equal(result[1].tabs, null);
  assert.ok(result[1].error && result[1].error.length > 0, 'port 9223 should carry an error');

  assert.equal(result[2].engine, 'edge');
  assert.ok(result[2].tabs);
  assert.equal(result[2].tabs!.length, 1);
  assert.equal(result[2].tabs![0].targetId, 'e1');
});

test('ports queried in parallel', async () => {
  const startTimestamps: number[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fetchFn: FetchFn = (async (input: RequestInfo | URL) => {
    startTimestamps.push(Date.now());
    const url = typeof input === 'string' ? input : input.toString();
    await sleep(50);
    const body = url.includes('/json/version')
      ? { Browser: 'Chrome/120.0.0.0' }
      : [];
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as FetchFn;

  await discoverCdpPorts([9222, 9223, 9229], { fetchFn });

  // Only the *first* fetch per port runs in parallel — the /json/list call
  // is sequenced after /json/version on each port — so check just the first
  // three timestamps. Their spread is the parallelism signal.
  const firstThree = startTimestamps.slice(0, 3);
  const spread = Math.max(...firstThree) - Math.min(...firstThree);
  assert.ok(spread < 20, `expected parallel start (spread < 20ms), got ${spread}ms`);
});

test('reachable but no pages → engine classified, tabs: [], no error', async () => {
  const fetchFn = mockFetch({
    '127.0.0.1:9222/json/version': () => ({ json: { Browser: 'Chrome/121.0.0.0' } }),
    '127.0.0.1:9222/json/list': () => ({ json: [] }),
  });
  const [r] = await discoverCdpPorts([9222], { fetchFn });
  assert.equal(r.engine, 'chrome');
  assert.deepEqual(r.tabs, []);
  assert.equal(r.error, undefined);
});

test('engine classification by Browser-field prefix', async () => {
  const cases: Array<{ browser: string; expected: string }> = [
    { browser: 'Chrome/120.0.6099.130', expected: 'chrome' },
    { browser: 'Edge/120.0.2210.91', expected: 'edge' },
    { browser: 'Chromium/118.0.5993.117', expected: 'chromium' },
    { browser: 'HeadlessChrome/120.0.6099.0', expected: 'chrome' },
    { browser: 'SomeOtherBrowser/1.0', expected: 'unknown' },
  ];
  for (const { browser, expected } of cases) {
    const fetchFn = mockFetch({
      '/json/version': () => ({ json: { Browser: browser } }),
      '/json/list': () => ({ json: [] }),
    });
    const [r] = await discoverCdpPorts([9222], { fetchFn });
    assert.equal(r.engine, expected, `Browser=${browser}`);
  }
});

test('chrome-extension:// URLs are filtered', async () => {
  const fetchFn = mockFetch({
    '/json/version': () => ({ json: { Browser: 'Chrome/120.0.0.0' } }),
    '/json/list': () => ({
      json: [
        { id: 'p1', type: 'page', title: 'Real', url: 'https://example.com/' },
        { id: 'ext', type: 'page', title: 'Ext', url: 'chrome-extension://abc/popup.html' },
      ],
    }),
  });
  const [r] = await discoverCdpPorts([9222], { fetchFn });
  assert.ok(r.tabs);
  assert.equal(r.tabs!.length, 1);
  assert.equal(r.tabs![0].targetId, 'p1');
});

test('/json/version succeeds but /json/list fails → engine kept, tabs: null, error set', async () => {
  const fetchFn = mockFetch({
    '/json/version': () => ({ json: { Browser: 'Chrome/120.0.0.0' } }),
    '/json/list': () => {
      throw new Error('boom');
    },
  });
  const [r] = await discoverCdpPorts([9222], { fetchFn });
  assert.equal(r.engine, 'chrome');
  assert.equal(r.tabs, null);
  assert.ok(r.error && r.error.length > 0);
});

test('empty Browser field → engine "unknown"', async () => {
  const fetchFn = mockFetch({
    '/json/version': () => ({ json: { Browser: '' } }),
    '/json/list': () => ({ json: [] }),
  });
  const [r] = await discoverCdpPorts([9222], { fetchFn });
  assert.equal(r.engine, 'unknown');
  assert.deepEqual(r.tabs, []);
});
