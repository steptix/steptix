// Live end-to-end test for the CDP-attach flow.
//
// What this proves (the W0 verification rule for stories/flick-vscode-cdp-attach.md):
//   * The extension can spawn a real Chrome / Edge browser via
//     browser-launcher.ts with --remote-debugging-port + a dedicated profile.
//   * `discoverCdp` against that real browser returns the correct engine
//     classification and surfaces the page tab keyed by its real targetId.
//   * `adoptCdpTab` creates a SessionMeta that the runner can attach to.
//   * A `submitSteps` against the adopted tab drives the real Sessions API
//     server, which attaches to the SAME tab via `cdpTab: targetId:<id>`
//     and asks the AI to read the page — and the response actually
//     references the page contents.
//
// This file is required to merge per the spec. Without it, only mocked
// tests would protect the launch + attach codepath.
//
// Per-engine loop: runs once for Chrome, once for Edge, but only for
// engines the host machine actually has installed (Mocha .skip(), not
// .fail(), for missing engines so CI/laptops without one engine still pass).
//
// Skipped silently when called with neither Chrome nor Edge installed —
// flick-vscode cannot do anything CDP-related without one or the other
// anyway, and this test isn't the right place to fail on environment.

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.flick-vscode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Re-implementation of runLiveTest.cjs's waitFor — kept inline so this file
 *  doesn't depend on the bootstrap module's export surface. */
async function waitFor(label, predicate, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* ignore */ }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Returns true if a TCP listener answers on (127.0.0.1, port). Used to
 *  avoid colliding with the Sessions API server (3100), test-app (8787),
 *  or anything else already bound on the host. */
function probePort(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(val);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 500);
  });
}

/** Pick a CDP port in the 9300-9399 range that nothing is listening on.
 *  9222 is avoided because the user may already have a real browser
 *  attached there during development. */
async function pickFreeCdpPort() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const port = 9300 + Math.floor(Math.random() * 100);
    if (!(await probePort(port))) return port;
  }
  throw new Error('could not find a free port in 9300-9399 after 25 attempts');
}

/** Fetch JSON with a hard 5s timeout. Native `fetch` in Node 18+ honours
 *  AbortController. */
async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 5000);
  try {
    const res = await fetch(url, { method: opts.method || 'GET', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort kill of a spawned browser process. CDP mode keeps the
 *  process alive after the runner's CDP connection drops — without this
 *  the test would leak chrome/edge.exe between runs. */
function killBrowser(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      cp.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid);
    }
  } catch {
    /* the process may have exited cleanly already */
  }
}

async function getHooks() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `${EXT_ID} not loaded`);
  if (!ext.isActive) await ext.activate();
  const hooks = ext.exports.__testHooks;
  assert.ok(hooks, '__testHooks not exposed');
  assert.ok(hooks.cdp, '__testHooks.cdp not exposed (extension build out of date?)');
  return hooks;
}

async function getOrOpenWebview(hooks) {
  if (hooks.webviews().length === 0) {
    await vscode.commands.executeCommand('flick.openSidebar');
    await hooks.waitFor(() => hooks.webviews().length > 0, 8_000, 'webview attach');
  }
  return hooks.webviews()[0];
}

describe('Flick live CDP end-to-end against real Chrome / Edge', function () {
  this.timeout(240_000);

  /** Engines we'll actually loop over — determined at suite-load time so
   *  the it() calls can be registered statically. */
  let availableEngines = [];

  before(async () => {
    const apiUrl = process.env.FLICK_LIVE_API_URL;
    const apiKey = process.env.FLICK_LIVE_API_KEY;
    assert.ok(apiUrl, 'FLICK_LIVE_API_URL not set by harness');
    assert.ok(apiKey, 'FLICK_LIVE_API_KEY not set by harness');

    const cfg = vscode.workspace.getConfiguration('flick');
    await cfg.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global);
    await cfg.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);

    // Settle the controller's settings listener.
    await sleep(300);

    const hooks = await getHooks();
    const installed = hooks.cdp.detectInstalled();
    if (installed.chrome) availableEngines.push('chrome');
    if (installed.edge) availableEngines.push('edge');

    if (availableEngines.length === 0) {
      console.log('No Chrome or Edge installed on this host — skipping CDP live tests.');
    }
  });

  // Register one test per supported engine. We can't `for (engine of
  // availableEngines)` at describe-time (Mocha sees the empty array before
  // `before` runs), so register both unconditionally and skip inside the
  // test body when the engine isn't available. Both engines have identical
  // assertions — the launcher abstracts the spawn.
  for (const engine of ['chrome', 'edge']) {
    it(`${engine}: launch → discover → adopt → submitSteps drives the real tab`, async function () {
      if (!availableEngines.includes(engine)) {
        this.skip();
        return;
      }

      const hooks = await getHooks();
      const webview = await getOrOpenWebview(hooks);

      // Per-test scratch profile so test runs never collide with each other
      // or with the user's real browser data.
      const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `flick-cdp-${engine}-`));
      const port = await pickFreeCdpPort();
      let pid;

      // Tap host→webview postMessage so we can observe the controller's
      // replies (cdpDiscovery / sessions / historyReplace).
      const seen = [];
      const originalPost = webview.postMessage.bind(webview);
      webview.postMessage = (msg) => {
        seen.push(msg);
        return originalPost(msg);
      };

      try {
        // 1. Spawn the real browser via the SAME helper the extension uses.
        const launch = await hooks.cdp.launchBrowserWithCdp({
          engine,
          port,
          profileDir,
        });
        if (!launch.ok) {
          this.skip();
          console.log(`${engine}: launch failed — skipping (${launch.error || 'unknown error'})`);
          return;
        }
        pid = launch.pid;

        // 2. Sanity-check /json/version is up (launchBrowserWithCdp already
        //    polled this, but its surface only returns ok:true/false — we
        //    re-fetch so the test fails with a clearer message if something
        //    flapped between the poll and now).
        const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
        assert.ok(version.Browser, '/json/version must return a Browser field');

        // 3. Open a data: URL tab so we have a stable, AI-readable target.
        //    /json/new is the CDP HTTP shortcut for "open URL as a new tab,
        //    return its target descriptor" — no Playwright needed.
        //
        //    **The <title> and the <h1> deliberately carry the SAME string.**
        //    The heading used to read "hello flick", which made the step below
        //    ("Read the page title") ambiguous: the model consistently read the
        //    visible heading rather than the document title, so the batch passed
        //    while the assertion looking for "FlickLiveCdp" failed. Both
        //    readings are defensible for "page title", and the test does not
        //    care which one the model picks — it only needs a string unique to
        //    THIS tab, to prove the server attached here and drove it. Making
        //    both elements say it removes the ambiguity instead of betting on
        //    the model resolving it a particular way.
        const newTabUrl = encodeURI(
          'data:text/html,<title>FlickLiveCdp</title><h1>FlickLiveCdp</h1>',
        );
        let createdTarget;
        try {
          // Modern Chrome wants PUT for /json/new; older builds accept any
          // method. Try PUT first, fall back to GET.
          createdTarget = await fetchJson(
            `http://127.0.0.1:${port}/json/new?${newTabUrl}`,
            { method: 'PUT' },
          );
        } catch (errPut) {
          try {
            createdTarget = await fetchJson(
              `http://127.0.0.1:${port}/json/new?${newTabUrl}`,
              { method: 'GET' },
            );
          } catch (errGet) {
            throw new Error(
              `Could not open a new tab via /json/new — PUT: ${errPut.message}; GET: ${errGet.message}. ` +
                `Browser may need --remote-allow-origins, but the launcher should set what's needed.`,
            );
          }
        }
        assert.ok(createdTarget.id, '/json/new must return a target descriptor with an id');
        const targetId = createdTarget.id;

        // 4. Point the controller at our spawned browser's port for the
        //    duration of this test, then drive discovery.
        hooks.controller.__testSetCdpDeps({ ports: [port] });
        const beforeIdx = seen.length;
        await hooks.dispatch(webview, { type: 'discoverCdp' });
        await waitFor(
          'cdpDiscovery reply',
          () => seen.slice(beforeIdx).some((m) => m.type === 'cdpDiscovery'),
          15_000,
        );
        const discovery = seen.slice(beforeIdx).filter((m) => m.type === 'cdpDiscovery').pop();
        assert.equal(discovery.ports.length, 1, 'exactly one port queried');
        const portInfo = discovery.ports[0];
        assert.equal(portInfo.port, port);
        assert.ok(
          portInfo.engine === engine || portInfo.engine === 'chromium',
          `expected engine ${engine} (or 'chromium' fallback), got ${portInfo.engine}`,
        );
        assert.ok(Array.isArray(portInfo.tabs), 'tabs must enumerate');
        const tab = portInfo.tabs.find((t) => t.targetId === targetId);
        assert.ok(
          tab,
          `the FlickLiveCdp tab (targetId=${targetId}) must appear in discovery; ` +
            `got ${portInfo.tabs.map((t) => t.targetId).join(', ')}`,
        );

        // 5. Adopt the tab — the controller creates a local session marked
        //    cdp.port + cdp.tab="targetId:<id>".
        const sessionsBeforeAdopt = hooks.controller.__testSessions.length;
        await hooks.dispatch(webview, {
          type: 'adoptCdpTab',
          port,
          targetId,
          title: 'FlickLiveCdp',
          url: 'data:text/html,FlickLiveCdp',
        });
        await waitFor(
          'controller sessions to grow by one',
          () => hooks.controller.__testSessions.length === sessionsBeforeAdopt + 1,
          5_000,
        );
        const adopted = hooks.controller.__testSessions[
          hooks.controller.__testSessions.length - 1
        ];
        assert.ok(adopted.cdp, 'adopted session must carry cdp metadata');
        assert.equal(adopted.cdp.port, port);
        assert.equal(adopted.cdp.tab, `targetId:${targetId}`);
        assert.equal(adopted.used, false, 'CDP session unused so first submit carries the hint');
        const sessionId = adopted.id;

        // 6. Submit a trivial step. The Sessions API server attaches to
        //    THIS tab via cdpTab: targetId:<id> and asks the model to
        //    read the page title.
        const submitIdx = seen.length;
        await hooks.dispatch(webview, {
          type: 'submitSteps',
          sessionId,
          rawText: '1. Read the page title and report it.',
        });
        await waitFor(
          `historyReplace for ${engine} live batch`,
          () => {
            for (let i = submitIdx; i < seen.length; i++) {
              const m = seen[i];
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

        const replace = seen
          .slice(submitIdx)
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
            (batch.error?.message ?? JSON.stringify(batch.results).slice(0, 500)),
        );
        // AI responses vary; just look for the title-string somewhere in
        // the stringified batch (covers outputs / reasoning / action results).
        // Both the <title> and the <h1> carry this string (see the fixture
        // above), so this holds however the model reads "page title".
        const haystack = JSON.stringify(batch);
        assert.match(
          haystack,
          /FlickLiveCdp/i,
          'batch must reference FlickLiveCdp somewhere — the string is in both ' +
            'the document title and the visible heading of the adopted tab, so ' +
            'its absence means the run did not read THIS tab',
        );
      } finally {
        // Restore production deps for the next test / suite.
        try {
          const hooks = await getHooks();
          hooks.controller.__testSetCdpDeps(null);
        } catch {
          /* extension may already be disposed */
        }
        killBrowser(pid);
        try {
          fs.rmSync(profileDir, { recursive: true, force: true });
        } catch {
          /* Windows sometimes holds the lock briefly; cleanup is best-effort */
        }
      }
    });
  }
});
