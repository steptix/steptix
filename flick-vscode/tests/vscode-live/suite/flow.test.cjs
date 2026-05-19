// Live end-to-end test for flick-vscode.
//
// What it proves:
//   * The extension activates inside a real VS Code host.
//   * Flick's webview-to-host bridge correctly relays a `submitSteps`
//     message to the controller.
//   * The controller's HTTP client reaches the REAL Sessions API server.
//   * The Sessions API server actually drives a real browser via Playwright
//     and a real AI call against AI_API_KEY.
//   * The resulting batch lands back in Flick's history as a passed entry.
//
// The runLiveTest.cjs bootstrap is responsible for:
//   * Spawning fixtures/test-app/server.ts (the target site)
//   * Spawning the Sessions API server with the right env
//   * Forwarding FLICK_LIVE_API_URL / FLICK_LIVE_API_KEY /
//     FLICK_LIVE_TEST_APP_URL into the Extension Development Host.

const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXT_ID = 'pkent.flick-vscode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* ignore */ }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe('Flick live end-to-end against real Sessions API + test-app', function () {
  this.timeout(240_000);

  /** @type {import('../../../dist/extension/extension').FlickTestHooks} */
  let hooks;
  let webview;
  let postedToWebview;

  before(async () => {
    const apiUrl = process.env.FLICK_LIVE_API_URL;
    const apiKey = process.env.FLICK_LIVE_API_KEY;
    const testAppUrl = process.env.FLICK_LIVE_TEST_APP_URL;
    assert.ok(apiUrl, 'FLICK_LIVE_API_URL not set by harness');
    assert.ok(apiKey, 'FLICK_LIVE_API_KEY not set by harness');
    assert.ok(testAppUrl, 'FLICK_LIVE_TEST_APP_URL not set by harness');

    // Point flick at the spawned servers. ConfigurationTarget.Global so the
    // update lands in this run's isolated user-data dir (the harness uses
    // a separate --user-data-dir from the host machine's profile).
    const cfg = vscode.workspace.getConfiguration('flick');
    await cfg.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global);
    await cfg.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');

    // Settle the controller's settings listener.
    await sleep(300);

    // Open a webview so we have a host channel to dispatch through.
    if (hooks.webviews().length === 0) {
      await vscode.commands.executeCommand('flick.openSidebar');
      await hooks.waitFor(() => hooks.webviews().length > 0, 8_000, 'sidebar webview');
    }
    webview = hooks.webviews()[0];

    // Tap host→webview postMessage so we can observe the result entry the
    // controller emits when the live batch comes back.
    postedToWebview = [];
    const originalPost = webview.postMessage.bind(webview);
    webview.postMessage = (msg) => {
      postedToWebview.push(msg);
      return originalPost(msg);
    };
  });

  it('submits a real step batch and gets a passed result back', async () => {
    const testAppUrl = process.env.FLICK_LIVE_TEST_APP_URL;

    // 1. Create a brand-new Flick session.
    await hooks.dispatch(webview, { type: 'newSession' });
    await hooks.waitFor(
      () => hooks.controller.__testSessions.length > 0,
      4_000,
      'controller session created',
    );
    const sessionId = hooks.controller.__testActiveSessionId;
    assert.ok(sessionId, 'active session id must be set');

    // Drain any earlier messages so we can wait for the specific
    // historyReplace that resolves THIS batch's pending entry.
    const beforeIdx = postedToWebview.length;

    // 2. Submit one simple step against the test-app. Single AI turn:
    //    "Navigate to <url>" → goto action. Cheap, deterministic.
    await hooks.dispatch(webview, {
      type: 'submitSteps',
      sessionId,
      rawText: `1. Navigate to ${testAppUrl}/`,
    });

    // 3. Wait for the controller to replace the pending entry with the
    //    real result. The full path here is:
    //    webview → controller.handleMessage → SessionsApiClient.submitSteps
    //    → Sessions API server → Playwright browser → AI call → response
    //    → result card persisted → historyReplace posted to webview.
    await waitFor(
      'historyReplace with the live batch result',
      () => {
        for (let i = beforeIdx; i < postedToWebview.length; i++) {
          const m = postedToWebview[i];
          if (
            m.type === 'historyReplace' &&
            m.sessionId === sessionId &&
            m.entry?.kind === 'result'
          ) {
            return true;
          }
        }
        return false;
      },
      200_000,
    );

    // 4. The replace carries a BatchResult. Status must be passed.
    const replace = postedToWebview
      .slice(beforeIdx)
      .filter(
        (m) =>
          m.type === 'historyReplace' &&
          m.sessionId === sessionId &&
          m.entry?.kind === 'result',
      )
      .pop();
    const batch = replace.entry.batch;
    assert.equal(
      batch.status,
      'passed',
      `expected batch passed, got ${batch.status}: ` +
        (batch.error?.message ?? JSON.stringify(batch.results)),
    );
    assert.equal(batch.stepsTotal, 1);
    assert.equal(batch.stepsCompleted, 1);
    assert.equal(batch.results.length, 1);
    assert.equal(batch.results[0].status, 'passed');

    // The controller marked the session as used now that one batch landed.
    const session = hooks.controller.__testSessions.find((s) => s.id === sessionId);
    assert.ok(session);
    assert.equal(session.used, true, 'session must flip to used after a passed batch');
  });
});
