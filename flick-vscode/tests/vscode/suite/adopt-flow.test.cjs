// End-to-end coverage for the "Adopt server session" flow inside a real
// Extension Development Host. Drives the controller through __testHooks
// (the exact path the real webview takes via postMessage) against a real
// HTTP server that implements the GET /sessions contract.
//
// Catches a class of regressions the node:test controller suite cannot:
//   * activation errors in extension.ts that prevent __testHooks from
//     being returned
//   * runtime crashes in handleMessage when running inside a real VS Code
//     host (Node version mismatches, missing globals, etc.)
//   * the message switch in the controller not actually routing the new
//     listServerSessions / adoptServerSession cases
const assert = require('node:assert/strict');
const http = require('node:http');
const vscode = require('vscode');

const EXT_ID = 'pkent.flick-vscode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tiny scriptable Sessions API stand-in. Each test starts its own. */
class FakeSessionsServer {
  constructor() {
    this.sessions = [];
    this.requests = [];
  }
  async start() {
    this.server = http.createServer((req, res) => {
      this.requests.push({ method: req.method, url: req.url });
      if (req.method === 'GET' && req.url === '/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessions: this.sessions }));
        return;
      }
      // The connectivity ping is also GET /sessions; we already handled it
      // above. Anything else is unexpected for this test.
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${addr.port}`;
  }
  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = undefined;
  }
}

/**
 * Intercept host→webview postMessage on a real webview so the test can
 * observe the controller's replies (serverSessions, sessions, etc).
 * Returns the captured array — kept by reference so callers can poll it.
 */
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
  // The same provider serves both sidebar variants but only one resolves
  // per VS Code version; either way at least one webview is attached.
  return hooks.webviews()[0];
}

describe('Flick adopt-server-session flow (real VS Code host)', function () {
  this.timeout(20_000);

  let server;
  let restoreConfig;

  beforeEach(async () => {
    server = new FakeSessionsServer();
    await server.start();
    const cfg = vscode.workspace.getConfiguration('flick');
    const previousUrl = cfg.get('apiUrl');
    const previousKey = cfg.get('apiKey');
    // ConfigurationTarget.Global so the change actually lands during the
    // ephemeral test profile (no workspace folder writes to .vscode).
    await cfg.update('apiUrl', server.url, vscode.ConfigurationTarget.Global);
    await cfg.update('apiKey', 'test-key', vscode.ConfigurationTarget.Global);
    restoreConfig = async () => {
      await cfg.update('apiUrl', previousUrl, vscode.ConfigurationTarget.Global);
      await cfg.update('apiKey', previousKey, vscode.ConfigurationTarget.Global);
    };
    // Settle: the onDidChangeConfiguration listener triggers a re-ping; let
    // it run before each test so we start from a known state.
    await sleep(150);
  });

  afterEach(async () => {
    await server.stop();
    if (restoreConfig) await restoreConfig();
  });

  it('listServerSessions: controller forwards the list to the webview', async () => {
    server.sessions = [
      {
        sessionId: 'real-vscode-1',
        status: 'active',
        currentUrl: 'https://example.com/',
        pageTitle: 'Example',
        totalStepsExecuted: 2,
      },
      {
        sessionId: 'real-vscode-2',
        status: 'executing',
        currentUrl: 'https://other.test/',
        pageTitle: 'Other',
        totalStepsExecuted: 0,
      },
    ];
    const hooks = await getHooks();
    const webview = await getOrOpenWebview(hooks);
    const seen = tap(webview);

    await hooks.dispatch(webview, { type: 'listServerSessions' });
    await hooks.waitFor(
      () => seen.some((m) => m.type === 'serverSessions'),
      6_000,
      'serverSessions reply',
    );

    const reply = seen.filter((m) => m.type === 'serverSessions').pop();
    assert.ok(reply, 'serverSessions message must arrive');
    assert.equal(reply.error, null);
    assert.equal(reply.sessions.length, 2);
    assert.equal(reply.sessions[0].sessionId, 'real-vscode-1');
    assert.equal(reply.sessions[0].pageTitle, 'Example');
  });

  it('adoptServerSession: creates a tab keyed by the server id with used:true', async () => {
    const hooks = await getHooks();
    const webview = await getOrOpenWebview(hooks);
    const before = hooks.controller.__testSessions.length;
    const item = {
      sessionId: 'adopted-vscode-' + Date.now(),
      status: 'active',
      currentUrl: 'https://www.example.org/path',
      pageTitle: 'Adopted Tab',
      totalStepsExecuted: 5,
    };

    await hooks.dispatch(webview, { type: 'adoptServerSession', item });
    await hooks.waitFor(
      () => hooks.controller.__testSessions.length === before + 1,
      4_000,
      'controller sessions to grow',
    );

    const adopted = hooks.controller.__testSessions[
      hooks.controller.__testSessions.length - 1
    ];
    assert.equal(adopted.id, item.sessionId, 'tab id matches the server id verbatim');
    assert.equal(adopted.name, 'Adopted Tab', 'name derives from pageTitle');
    assert.equal(adopted.used, true, 'adopted sessions skip the first-request config send');
    assert.equal(hooks.controller.__testActiveSessionId, item.sessionId);
  });

  it('adoptServerSession dedupes: re-adopting the same id activates the existing tab', async () => {
    const hooks = await getHooks();
    const webview = await getOrOpenWebview(hooks);
    const item = {
      sessionId: 'dedupe-' + Date.now(),
      status: 'active',
      currentUrl: '',
      pageTitle: 'Dedupe',
      totalStepsExecuted: 0,
    };

    await hooks.dispatch(webview, { type: 'adoptServerSession', item });
    const afterFirst = hooks.controller.__testSessions.length;

    // Switch focus elsewhere so the re-adoption has to perform real
    // activation work (not a no-op because activeSessionId already matched).
    if (afterFirst >= 2) {
      const other = hooks.controller.__testSessions.find((s) => s.id !== item.sessionId);
      if (other) {
        await hooks.dispatch(webview, { type: 'switchSession', sessionId: other.id });
      }
    } else {
      // Only one tab exists — make another so we can switch off it.
      await vscode.commands.executeCommand('flick.newSession');
      await hooks.waitFor(
        () => hooks.controller.__testSessions.length === afterFirst + 1,
        2_000,
        'second session via flick.newSession',
      );
      const other = hooks.controller.__testSessions[
        hooks.controller.__testSessions.length - 1
      ];
      await hooks.dispatch(webview, { type: 'switchSession', sessionId: other.id });
    }
    await hooks.waitFor(
      () => hooks.controller.__testActiveSessionId !== item.sessionId,
      2_000,
      'switched away from the adopted tab',
    );

    const totalBeforeReadopt = hooks.controller.__testSessions.length;
    await hooks.dispatch(webview, { type: 'adoptServerSession', item });
    await hooks.waitFor(
      () => hooks.controller.__testActiveSessionId === item.sessionId,
      2_000,
      're-adoption re-activates the existing tab',
    );

    assert.equal(
      hooks.controller.__testSessions.length,
      totalBeforeReadopt,
      'must NOT create a second tab for the same server id',
    );
  });

  it('listServerSessions: empty server list arrives intact', async () => {
    server.sessions = [];
    const hooks = await getHooks();
    const webview = await getOrOpenWebview(hooks);
    const seen = tap(webview);

    await hooks.dispatch(webview, { type: 'listServerSessions' });
    await hooks.waitFor(
      () => seen.some((m) => m.type === 'serverSessions'),
      4_000,
      'serverSessions reply',
    );
    const reply = seen.filter((m) => m.type === 'serverSessions').pop();
    assert.equal(reply.error, null);
    assert.ok(Array.isArray(reply.sessions));
    assert.equal(reply.sessions.length, 0);
  });
});
