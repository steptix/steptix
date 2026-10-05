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
    '127.0.0.1:9229/json/version': () => ({ json: { Browser: 'Edg/151.0.4129.78' } }),
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
  assert.equal(result[0].reachable, true);
  assert.ok(result[0].tabs, 'port 9222 tabs should not be null');
  assert.equal(result[0].tabs!.length, 1);
  assert.equal(result[0].tabs![0].targetId, 'a1');
  assert.equal(result[0].tabs![0].title, 'GitHub');
  assert.equal(result[0].error, undefined);

  assert.equal(result[1].engine, 'unknown');
  assert.equal(result[1].reachable, false, 'unreachable port is not reachable');
  assert.equal(result[1].tabs, null);
  assert.ok(result[1].error && result[1].error.length > 0, 'port 9223 should carry an error');

  assert.equal(result[2].engine, 'edge');
  assert.equal(result[2].reachable, true);
  assert.ok(result[2].tabs);
  assert.equal(result[2].tabs!.length, 1);
  assert.equal(result[2].tabs![0].targetId, 'e1');
});

test('ports queried in parallel', async () => {
  // Concurrency, counted rather than timed: a fetch is in flight from its call
  // until its answer. Probing the ports one after another never has more than
  // one; probing them together has all three /json/version calls out at once
  // (each port's /json/list is sequenced after its own /json/version).
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn: FetchFn = (async (input: RequestInfo | URL) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const url = typeof input === 'string' ? input : input.toString();
    await new Promise((r) => setImmediate(r));
    inFlight--;
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

  assert.equal(maxInFlight, 3, 'all three ports should be probed at once');
});

test('reachable but no pages → engine classified, tabs: [], no error', async () => {
  const fetchFn = mockFetch({
    '127.0.0.1:9222/json/version': () => ({ json: { Browser: 'Chrome/121.0.0.0' } }),
    '127.0.0.1:9222/json/list': () => ({ json: [] }),
  });
  const [r] = await discoverCdpPorts([9222], { fetchFn });
  assert.equal(r.engine, 'chrome');
  assert.equal(r.reachable, true);
  assert.deepEqual(r.tabs, []);
  assert.equal(r.error, undefined);
});

test('engine classification by Browser-field prefix', async () => {
  const cases: Array<{ browser: unknown; expected: string }> = [
    { browser: 'Chrome/120.0.6099.130', expected: 'chrome' },
    // The string a real Edge actually sends. Measured against Edge
    // 151.0.4129.78; the table used to carry only the `Edge/` spelling below,
    // which no shipping Edge has used for years — so every case here passed
    // while the live suite failed on `Edg/` classifying as 'unknown'.
    { browser: 'Edg/151.0.4129.78', expected: 'edge' },
    { browser: 'Edge/120.0.2210.91', expected: 'edge' },
    { browser: 'Chromium/118.0.5993.117', expected: 'chromium' },
    { browser: 'HeadlessChrome/120.0.6099.0', expected: 'chrome' },
    { browser: 'SomeOtherBrowser/1.0', expected: 'unknown' },
    // No Browser field at all: classified from '' rather than throwing.
    { browser: undefined, expected: 'unknown' },
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
  assert.equal(r.reachable, true, '/json/version answered, so still reachable');
  assert.equal(r.tabs, null);
  assert.ok(r.error && r.error.length > 0);
});

test('Node.js inspector → engine "node", reachable, so the dropdown can hide it', async () => {
  // Node's --inspect endpoint (port 9229 default) speaks CDP but is not a
  // browser. It must classify as 'node' (reachable: true) so the webview can
  // exclude it while still showing genuine unknown-Chromium browsers.
  const fetchFn = mockFetch({
    '/json/version': () => ({ json: { Browser: 'node.js/v22.22.0', 'Protocol-Version': '1.1' } }),
    '/json/list': () => ({
      json: [{ id: 'n1', type: 'node', title: 'dist/index.js', url: 'file:///x/dist/index.js' }],
    }),
  });
  const [r] = await discoverCdpPorts([9229], { fetchFn });
  assert.equal(r.engine, 'node');
  assert.equal(r.reachable, true);
  // type: 'node' targets are filtered out (not pages), so tabs is empty.
  assert.deepEqual(r.tabs, []);
});
