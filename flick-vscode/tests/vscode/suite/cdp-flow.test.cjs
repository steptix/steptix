// End-to-end coverage for the CDP discovery + adopt + launch flows inside a
// real Extension Development Host. Sibling to adopt-flow.test.cjs — same
// shape (FakeBrowserServer + __testHooks.dispatch + tap), but exercises the
// `discoverCdp` / `adoptCdpTab` / `launchBrowserCdp` message handlers added
// by W6.
//
// Why a real-EDH test on top of the node:test integration suite:
//   * proves the message switch in controller.ts actually routes the new
//     CDP cases when running inside a real VS Code Node host (Node version
//     mismatches, missing globals, esbuild bundling skew, etc.)
//   * proves __testSetCdpDeps reaches all four seams from the test side —
//     the extension is activated by VS Code at startup with the production
//     CdpDeps, so the test MUST patch the deps after the fact.
//
// The fake browser server is inlined here (mirroring how adopt-flow.test.cjs
// inlines FakeSessionsServer) so this file is self-contained: vscode .cjs
// tests can't import the TS FakeBrowserServer without dragging a build step
// in.
const assert = require('node:assert/strict');
const http = require('node:http');
const vscode = require('vscode');
const { listenFetchable } = require('../../../../tests/listen-fetchable.cjs');

const EXT_ID = 'pkent.flick-vscode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A scriptable Chromium-debug-port stand-in. Each test pair gets one for
 *  Chrome + one for Edge so engine classification + per-port routing both
 *  exercise the real classifier in cdp-discovery.ts. */
class FakeBrowserServer {
  constructor() {
    // Defaults to Chrome; tests override before start().
    this.browserField = 'Chrome/120.0.6099.130';
    this.tabs = [];
  }
  async start() {
    this.server = http.createServer((req, res) => {
      const url = req.url || '';
      if (url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: this.browserField }));
        return;
      }
      if (url === '/json/list' || url === '/json') {
        const wire = this.tabs.map((t) => ({
          id: t.id,
          type: t.type || 'page',
          url: t.url,
          title: t.title,
          ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}),
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(wire));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await listenFetchable(this.server, '127.0.0.1');
    this.port = this.server.address().port;
  }
  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = undefined;
  }
}

/** Intercept host→webview postMessage on a real webview so the test can
 *  observe the controller's replies. Returns the captured array — kept by
 *  reference so callers can poll it. Mirrors adopt-flow.test.cjs's `tap`. */
function tap(webview) {
  const seen = [];
  const original = webview.postMessage.bind(webview);
  webview.postMessage = (msg) => {
    seen.push(msg);
    return original(msg);
  };
  return seen;
}

async function getHooks() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `${EXT_ID} not found`);
  if (!ext.isActive) await ext.activate();
  return ext.exports.__testHooks;
}

async function getOrOpenWebview(hooks) {
  if (hooks.webviews().length === 0) {
    await vscode.commands.executeCommand('flick.openSidebar');
    await hooks.waitFor(() => hooks.webviews().length > 0, 8_000, 'webview attach');
  }
  return hooks.webviews()[0];
}

describe('Flick CDP discovery + adopt flow (real VS Code host)', function () {
  this.timeout(20_000);

  let chromeServer;
  let edgeServer;
  let launchCalls;

  beforeEach(async () => {
    chromeServer = new FakeBrowserServer();
    chromeServer.browserField = 'Chrome/120.0.6099.130';
    chromeServer.tabs = [
      // Page tab — should appear in discovery.
      {
        id: 'chrome-tab-real',
        type: 'page',
        url: 'https://example.com/dashboard',
        title: 'Dashboard',
      },
      // Non-page target — must be filtered out by cdp-discovery.
      {
        id: 'chrome-iframe-hidden',
        type: 'iframe',
        url: 'https://example.com/iframe',
        title: 'Hidden iframe',
      },
    ];
    await chromeServer.start();

    edgeServer = new FakeBrowserServer();
    edgeServer.browserField = 'Edg/151.0.4129.78'; // what a real Edge sends
    edgeServer.tabs = [
      {
        id: 'edge-tab-inbox',
        type: 'page',
        url: 'https://outlook.office.com/mail',
        title: 'Inbox',
      },
    ];
    await edgeServer.start();

    launchCalls = [];

    // Wire the controller to our two fake servers + stub launcher. The
    // detect override returns truthy strings so `installed.{chrome,edge}`
    // both flip to true. Launch is a recording no-op — the non-live test
    // never spawns a real browser.
    const hooks = await getHooks();
    hooks.controller.__testSetCdpDeps({
      ports: [chromeServer.port, edgeServer.port],
      detectInstalled: () => ({ chrome: '/fake/chrome', edge: '/fake/edge' }),
      launchBrowserWithCdp: async (opts) => {
        launchCalls.push(opts);
        return { ok: true, pid: 999 };
      },
    });

    // Settle so any in-flight ping/discovery from a prior test completes
    // before the next one drains the tap.
    await sleep(50);
  });

  afterEach(async () => {
    // Restore production deps so subsequent test files (and the activation
    // suite re-running this whole module on a retry) don't see fake servers
    // that have since stopped.
    try {
      const hooks = await getHooks();
      hooks.controller.__testSetCdpDeps(null);
    } catch {
      /* extension may already be disposed */
    }
    await chromeServer.stop();
    await edgeServer.stop();
  });

  it('discoverCdp returns one Chrome section + one Edge section with iframe filtered', async () => {
    const hooks = await getHooks();
    const webview = await getOrOpenWebview(hooks);
    const seen = tap(webview);

    await hooks.dispatch(webview, { type: 'discoverCdp' });
    await hooks.waitFor(
      () => seen.some((m) => m.type === 'cdpDiscovery'),
      6_000,
      'cdpDiscovery reply',
    );

    const reply = seen.filter((m) => m.type === 'cdpDiscovery').pop();
    assert.ok(reply, 'cdpDiscovery message must arrive');
    assert.equal(reply.ports.length, 2, 'one entry per scanned port');

    const chromePort = reply.ports.find((p) => p.port === chromeServer.port);
    const edgePort = reply.ports.find((p) => p.port === edgeServer.port);
    assert.ok(chromePort, 'Chrome port present in discovery');
    assert.ok(edgePort, 'Edge port present in discovery');

    assert.equal(chromePort.engine, 'chrome', 'engine classified from Browser field');
    assert.ok(Array.isArray(chromePort.tabs));
    assert.equal(chromePort.tabs.length, 1, 'iframe target filtered out');
    assert.equal(chromePort.tabs[0].targetId, 'chrome-tab-real');
    assert.equal(chromePort.tabs[0].title, 'Dashboard');

    assert.equal(edgePort.engine, 'edge', 'Edge classified by Browser-string prefix');
    assert.ok(Array.isArray(edgePort.tabs));
    assert.equal(edgePort.tabs.length, 1);
    assert.equal(edgePort.tabs[0].targetId, 'edge-tab-inbox');

    // The installed booleans come from the stub.
    assert.equal(reply.installed.chrome, true);
    assert.equal(reply.installed.edge, true);
  });

  it('adoptCdpTab against the Edge tab creates a session keyed by targetId+port', async () => {
    const hooks = await getHooks();
    const webview = await getOrOpenWebview(hooks);
    const seen = tap(webview);

    // First discover so the controller's view of the fake servers matches
    // what the webview would have rendered before the click.
    await hooks.dispatch(webview, { type: 'discoverCdp' });
    await hooks.waitFor(
      () => seen.some((m) => m.type === 'cdpDiscovery'),
      4_000,
      'cdpDiscovery before adopt',
    );

    const before = hooks.controller.__testSessions.length;

    await hooks.dispatch(webview, {
      type: 'adoptCdpTab',
      port: edgeServer.port,
      targetId: 'edge-tab-inbox',
      title: 'Inbox',
      url: 'https://outlook.office.com/mail',
    });
    await hooks.waitFor(
      () => hooks.controller.__testSessions.length === before + 1,
      4_000,
      'controller sessions to grow',
    );

    const adopted = hooks.controller.__testSessions[
      hooks.controller.__testSessions.length - 1
    ];
    assert.ok(adopted.cdp, 'adopted session must carry a cdp attachment');
    assert.equal(adopted.cdp.port, edgeServer.port, 'cdp.port matches the Edge fake');
    assert.equal(
      adopted.cdp.tab,
      'targetId:edge-tab-inbox',
      'tab selector encodes the targetId verbatim',
    );
    assert.equal(adopted.used, false, 'CDP sessions stay unused so the first submit carries the hint');
    assert.equal(adopted.name, 'Inbox', 'name derives from the supplied title');
    assert.equal(
      hooks.controller.__testActiveSessionId,
      adopted.id,
      'newly adopted CDP tab becomes the active session',
    );
  });

  it('launchBrowserCdp invokes the injected launcher and re-broadcasts discovery', async () => {
    const hooks = await getHooks();
    const webview = await getOrOpenWebview(hooks);
    const seen = tap(webview);

    // Prime: one discovery before launch so the post-launch re-broadcast is
    // unambiguous (we count cdpDiscovery messages after this point).
    await hooks.dispatch(webview, { type: 'discoverCdp' });
    await hooks.waitFor(
      () => seen.some((m) => m.type === 'cdpDiscovery'),
      4_000,
      'priming cdpDiscovery',
    );
    const beforeIdx = seen.length;

    await hooks.dispatch(webview, {
      type: 'launchBrowserCdp',
      engine: 'edge',
      port: 9222,
    });

    // Wait for the launcher stub to actually fire — protects against the
    // dispatch returning before the awaited handler runs (it doesn't in
    // practice, but cheap insurance).
    await hooks.waitFor(
      () => launchCalls.length === 1,
      4_000,
      'launcher stub invoked',
    );
    const call = launchCalls[0];
    assert.equal(call.engine, 'edge');
    assert.equal(call.port, 9222);
    assert.match(
      call.profileDir.replace(/\\/g, '/'),
      /\.flick\/edge-profile$/,
      'profileDir ends with .flick/edge-profile',
    );

    // cdpLaunchResult arrives on the webview.
    await hooks.waitFor(
      () => seen.slice(beforeIdx).some((m) => m.type === 'cdpLaunchResult'),
      4_000,
      'cdpLaunchResult posted',
    );
    const result = seen.slice(beforeIdx).filter((m) => m.type === 'cdpLaunchResult').pop();
    assert.equal(result.engine, 'edge');
    assert.equal(result.ok, true);
    assert.equal(result.port, 9222);

    // And a follow-up cdpDiscovery so the dropdown refreshes without a
    // manual ⟳ click.
    await hooks.waitFor(
      () => seen.slice(beforeIdx).some((m) => m.type === 'cdpDiscovery'),
      4_000,
      'follow-up cdpDiscovery broadcast',
    );
  });
});
