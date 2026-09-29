/**
 * Live end-to-end CDP tab focus (stories/cdp-tab-focus.md).
 *
 * Drives a REAL Chrome over CDP through the REAL Steptix Sessions API
 * server ($LIVE_SERVER_URL, default http://localhost:3100). Most of it needs no
 * AI and no session; the last scenario runs real steps to prove focusing does
 * not disturb them.
 *
 * **What it can and cannot prove.** No assertion in this repo can see a screen,
 * so "the user can see that window" stays a human check (the story's
 * verification rule 1). What *is* observable is that the browser **selected**
 * the tab: Chrome serves `/json/list` in most-recently-used order, and a tab
 * that moves to the head of that list after a focus call is one the browser
 * really activated rather than merely acknowledged. That is the half this test
 * owns.
 *
 * **It is NOT a substitute for W0, and it is not fully independent of it
 * either.** An earlier version of this comment claimed the ordering check was
 * "structurally blind" to whether the OS honoured the window raise, on the
 * grounds that `ActivateTabAt` bumps the activity clock regardless. That is
 * stronger than the mechanism supports: the clock behind the ordering is
 * `WebContents::GetLastActiveTime()`, and Chromium stamps `last_active_time_`
 * on the transition to VISIBLE — so a tab activated inside a window the
 * compositor considers occluded may not bump it at all. In other words, on the
 * exact machine state W0 exists to investigate (Chrome fully covered by another
 * window, Windows declining the raise), this assertion could go red for the one
 * thing it was designed not to test. Run it with the browser not buried, and
 * read a failure here as "look at the screen", not as "the route is broken".
 *
 * **Run this with the Chrome window visible.** Measured 2026-08-09 on Chrome
 * 150, both ways: with the window on screen, a repaint made while the tab was
 * backgrounded reached `Page.captureScreenshot` in ~940ms and the bytes
 * changed. With the window fully covered — which is the normal state here,
 * since the suite runs under a VS Code host that owns the foreground —
 * Chromium produces no frames for it and the same capture times out. Two
 * scenarios below therefore grade their outcome: a wrong or stale picture
 * fails, no picture at all is recorded as a skip and reported as one. This is
 * a real property of the feature (stories/cdp-tab-focus.md §Risks), not a
 * flake — a run whose browser is buried keeps working and loses its
 * screenshots.
 *
 * MRU ordering is documented for Chrome and unverified for Edge, so this
 * launches Chrome explicitly rather than whatever is around.
 *
 * It also stands as the story's rule (9): the focus route answers a plain
 * authenticated HTTP request, so it is not MCP-private. Nothing here goes
 * through the MCP server — those layers are covered by tests/mcp-cdp-seam.
 *
 * IMPORTANT: the live server runs the BUILT dist/, so rebuild (`npm run build`
 * at repo root) and restart the server before running, or a missing route
 * reads as a missing tab.
 *
 * Isolation: every browser here belongs to a dedicated `focus-live` profile
 * under templates/init/.steptix/cdp-profiles/, and the test closes it on the way
 * out — it never touches a profile anyone signs into.
 *
 * NOT part of the fast suite. Run via: node tests/integration/runLiveTest.cjs
 * (auto-discovered by the glob), or scope it with
 * STEPTIX_LIVE_GREP="CDP tab focus".
 *
 * Required env: `STEPTIX_SERVER_API_KEY`, resolved the way the framework resolves
 * it (project `.env` → environment → the machine key file). Only the run-in-
 * flight scenario needs an AI key; the rest need none.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const vscode = require('vscode');

const PROFILE = 'focus-live';

/** Three pages with distinct titles, so the route's echo can be checked against
 *  something only the browser could have told us. */
const PAGES = {
  '/alpha': 'Alpha Tab',
  '/beta': 'Beta Tab',
  '/gamma': 'Gamma Tab',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a response body ONCE and hand back both the status and the parsed
 *  payload. A `fetch` body can only be consumed once, so reading it eagerly
 *  for an assertion message and then parsing it is a TypeError rather than the
 *  failure the assertion was about. */
async function readJson(res) {
  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { error: raw };
  }
  return { status: res.status, body, raw };
}

/** Read one key out of an env file without pulling in a dotenv dependency.
 *  Missing file or missing key both read as absent — every caller here sits at
 *  one rung of a resolution chain and only asks "is there a value". */
function readEnvValue(envPath, key) {
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return '';
  }
  const line = content.split(/\r?\n/).find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return '';
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

/** `%LOCALAPPDATA%\steptix\.env` / `$XDG_CONFIG_HOME/steptix/.env` / `~/.steptix/.env`,
 *  mirroring `src/env/user-root.ts`. */
function userRootEnvPath() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'steptix', '.env');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'steptix', '.env') : path.join(os.homedir(), '.steptix', '.env');
}

/**
 * Resolve a credential the way the framework does: project `.env`, then the
 * environment, then the machine-wide file.
 *
 * The chain is not optional politeness. stories/machine-key.md moved
 * `STEPTIX_SERVER_API_KEY` out of per-project `.env` files and into one
 * self-provisioned machine key, so a test that reads only `templates/.env`
 * finds nothing and takes the whole suite down in `before()`.
 */
function resolveCredential(projectEnvPath, key) {
  return (
    readEnvValue(projectEnvPath, key) ||
    (process.env[key] ?? '') ||
    readEnvValue(userRootEnvPath(), key)
  );
}

describe('Steptix live — CDP tab focus (stories/cdp-tab-focus.md)', function () {
  this.timeout(180_000);

  let serverUrl;
  let apiKey;
  /** AI credentials for the one scenario that runs real steps. */
  let aiKey;
  let aiModel;
  let projectRoot;
  /** @type {http.Server} */
  let fixtureServer;
  let fixtureBase;
  /** CDP debug port of the browser this test launched. */
  let cdpPort;

  const auth = () => ({ 'x-api-key': apiKey });

  /** GET /cdp/browsers, i.e. the listing an agent reads targetIds out of. */
  async function listBrowsers() {
    const res = await fetch(
      `${serverUrl}/cdp/browsers?projectRoot=${encodeURIComponent(projectRoot)}`,
      { headers: auth() },
    );
    assert.equal(res.status, 200, 'listing browsers failed');
    return res.json();
  }

  /** Our browser's tabs, as the framework's own shared filter reports them. */
  async function ourTabs() {
    const body = await listBrowsers();
    const entry = body.running.find((b) => b.port === cdpPort);
    assert.ok(entry, `port ${cdpPort} is not in \`running\` — did the browser exit?`);
    return entry.tabs;
  }

  /**
   * Wait for `targetId` to reach the head of the tab list, i.e. for the browser
   * to report it as the most recently active tab.
   *
   * Two things this deliberately does NOT do. It does not hand-roll a page
   * filter: `ourTabs()` comes back through the framework's own `toPageTabs`,
   * which preserves `/json/list` order while dropping `devtools://`,
   * `chrome-extension://` and the `*-dialog` surfaces Chromium reports as
   * `type: 'page'`. A raw `type === 'page'` filter would let a sync-confirmation
   * dialog or an extension page take the head and fail the run for a reason
   * that has nothing to do with focus.
   *
   * And it does not sleep a fixed amount and then assert. Activation is
   * asynchronous, so a single settle is a bet on a machine's timing.
   *
   * **The budget alone was not enough, because each attempt is expensive.**
   * `GET /cdp/browsers` walks every profile directory under
   * `.steptix/cdp-profiles/` and probes each one with a 1500 ms timeout — and
   * stale profile dirs are the normal state, since `DevToolsActivePort` is
   * never deleted. On a machine carrying a couple of those, a 5 s wall-clock
   * budget buys two or three attempts; if one listing runs long it buys
   * exactly one, which is the fixed-sleep-and-assert-once shape this was
   * written to replace. So a minimum number of attempts is guaranteed
   * regardless of the clock, and the budget only ever ends a poll that has
   * already had a fair go.
   */
  async function waitForHeadTab(targetId, label, budgetMs = 5_000, minAttempts = 8) {
    const deadline = Date.now() + budgetMs;
    let head;
    for (let attempt = 0; ; attempt++) {
      const tabs = await ourTabs();
      head = tabs[0];
      if (head && head.targetId === targetId) return;
      if (attempt + 1 >= minAttempts && Date.now() >= deadline) break;
      await sleep(100);
    }
    assert.fail(
      `after focusing ${label} the browser's most-recently-used tab is still ` +
        `${JSON.stringify(head ? head.title : '(none)')} after ${minAttempts}+ attempts ` +
        `over ${budgetMs}ms.\n` +
        'Chrome serves /json/list most-recently-used first, so the focused tab should ' +
        'head it. If the browser window is buried behind another application, see this ' +
        "file's header — the ordering can depend on the raise the OS may have declined.",
    );
  }

  async function focusTab(targetId, extraQuery = '') {
    return fetch(
      `${serverUrl}/cdp/browsers/${cdpPort}/tabs/${encodeURIComponent(targetId)}/focus` +
        `?projectRoot=${encodeURIComponent(projectRoot)}${extraQuery}`,
      { method: 'POST', headers: auth() },
    );
  }

  async function closeTab(targetId, extraQuery = '') {
    return fetch(
      `${serverUrl}/cdp/browsers/${cdpPort}/tabs/${encodeURIComponent(targetId)}` +
        `?projectRoot=${encodeURIComponent(projectRoot)}${extraQuery}`,
      { method: 'DELETE', headers: auth() },
    );
  }

  /** Open a tab straight on the DevTools HTTP surface. Chrome 111+ wants PUT
   *  for `/json/new`; older builds only answer GET, so try both. */
  async function openTab(url) {
    const endpoint = `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`;
    let res = await fetch(endpoint, { method: 'PUT' });
    if (!res.ok) res = await fetch(endpoint);
    assert.ok(res.ok, `/json/new refused (${res.status})`);
    const target = await res.json();
    assert.ok(target.id, '/json/new returned no target id');
    return target.id;
  }

  before(async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');
    // The server resolves a project by walking up for steptix.config.json;
    // templates/init is the marker directory, so CDP profiles land in
    // templates/init/.steptix/cdp-profiles/ (gitignored).
    projectRoot = path.resolve(workspaceRoot, 'init');
    assert.ok(
      fs.existsSync(path.join(projectRoot, 'steptix.config.json')),
      `no steptix.config.json under ${projectRoot}`,
    );

    const projectEnv = path.join(workspaceRoot, '.env');
    apiKey = resolveCredential(projectEnv, 'STEPTIX_SERVER_API_KEY');
    assert.ok(
      apiKey,
      'No STEPTIX_SERVER_API_KEY in templates/.env, the environment, or the machine key ' +
        `file (${userRootEnvPath()}). Start the server once and it provisions one.`,
    );

    // AI credentials prefer the REPO ROOT `.env` over `templates/.env`, and the
    // difference is the MODEL rather than the key. Both files carry the same
    // `AI_API_KEY`, but templates names a bare `openrouter/…` model, which
    // routes direct/BYOK — so the gateway key is sent to a provider that has
    // never heard of it and the first step dies on `401 Missing Authentication
    // header`. The root file's `aibroker/…` prefix routes through the gateway
    // the key actually belongs to.
    const repoRootEnv = path.resolve(workspaceRoot, '..', '.env');
    const preferred = fs.existsSync(repoRootEnv) ? repoRootEnv : projectEnv;
    aiKey = resolveCredential(preferred, 'AI_API_KEY') || resolveCredential(projectEnv, 'AI_API_KEY');
    aiModel = readEnvValue(preferred, 'AI_MODEL') || readEnvValue(projectEnv, 'AI_MODEL');

    serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/health`);
      assert.ok(res.ok, `Server at ${serverUrl} not healthy (status=${res.status})`);
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. Start it with ` +
          `\`npm run dev\` or \`steptix serve\`. Original error: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    fixtureServer = http.createServer((req, res) => {
      const route = (req.url || '/').split('?')[0];
      const title = PAGES[route];
      if (!title) {
        res.writeHead(404).end('no');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
    });
    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;

    // A dedicated profile, launched through the same route an agent uses.
    const started = await readJson(
      await fetch(`${serverUrl}/cdp/browsers`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, engine: 'chrome', profile: PROFILE }),
      }),
    );
    assert.equal(started.status, 200, `start_cdp_browser failed: ${started.raw}`);
    cdpPort = started.body.port;
    console.log(`[live] chrome "${PROFILE}" on port ${cdpPort} (${started.body.outcome})`);

    for (const route of ['/alpha', '/beta', '/gamma']) {
      await openTab(`${fixtureBase}${route}`);
    }

    // Wait for the titles rather than sleeping for them — the same reasoning as
    // `waitForHeadTab`, and this one runs first, so a fixed settle's failure
    // mode on a cold machine is every test in the file reporting "fixture tabs
    // missing".
    const wanted = ['Alpha Tab', 'Beta Tab', 'Gamma Tab'];
    const deadline = Date.now() + 15_000;
    for (;;) {
      const titles = (await ourTabs()).map((t) => t.title);
      if (wanted.every((w) => titles.includes(w))) break;
      assert.ok(
        Date.now() < deadline,
        `fixture tabs never appeared — wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(titles)}`,
      );
      await sleep(150);
    }
  });

  after(async () => {
    // Leave nothing on the user's screen or in their profile directory's way:
    // close every tab we opened, then take the browser down with its last one.
    if (cdpPort) {
      // A session left holding a tab makes the close below refuse, so it goes
      // first. Harmless when the run test already closed it — the route 404s
      // and we do not care.
      try {
        await fetch(`${serverUrl}/sessions/${encodeURIComponent(`live-focus-run-${cdpPort}`)}`, {
          method: 'DELETE',
          headers: auth(),
        });
      } catch {
        /* nothing to close */
      }
      try {
        const remaining = await ourTabs();
        for (let i = 0; i < remaining.length; i++) {
          const last = i === remaining.length - 1;
          await closeTab(remaining[i].targetId, last ? '&allowBrowserExit=true' : '');
        }
      } catch (err) {
        console.log(`[live] cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
  });

  it('brings a named tab to the front and echoes what it brought forward', async () => {
    const tabs = await ourTabs();
    const alpha = tabs.find((t) => t.title === 'Alpha Tab');
    const gamma = tabs.find((t) => t.title === 'Gamma Tab');
    assert.ok(alpha && gamma, `fixture tabs missing — got ${JSON.stringify(tabs.map((t) => t.title))}`);

    // Put a DIFFERENT tab in front first, so "alpha is frontmost" afterwards
    // cannot be an accident of the order they were opened in.
    let res = await readJson(await focusTab(gamma.targetId));
    assert.equal(res.status, 200, res.raw);
    await waitForHeadTab(gamma.targetId, 'Gamma Tab');

    res = await readJson(await focusTab(alpha.targetId));
    assert.equal(res.status, 200, res.raw);
    const body = res.body;

    // The echo is the payload the agent repeats back to the user. It comes
    // from the browser's own tab list, not from anything the caller sent.
    assert.equal(body.focused, true);
    assert.equal(body.targetId, alpha.targetId);
    assert.equal(body.title, 'Alpha Tab');
    assert.equal(body.url, `${fixtureBase}/alpha`);
    assert.equal(body.engine, 'chrome');
    assert.equal(body.profile, PROFILE);
    assert.equal(body.port, cdpPort);
    assert.deepEqual(body.warnings, []);
    // Nothing was closed and no session was made: the shape has no
    // `remainingTabs`, no `browserExited`, no `sessionId`.
    assert.equal('remainingTabs' in body, false);
    assert.equal('browserExited' in body, false);

    await waitForHeadTab(alpha.targetId, 'Alpha Tab');

    // And it moves again, so the first result was not a tab that happened to
    // already be selected.
    res = await readJson(await focusTab(gamma.targetId));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.title, 'Gamma Tab');
    await waitForHeadTab(gamma.targetId, 'Gamma Tab');
  });

  it('switches between EVERY tab of a multi-tab browser, in both directions', async () => {
    // The scenario the feature exists for: a browser holding several tabs, and
    // a user asking for one after another. Two tabs would pass with an
    // implementation that merely toggles; walking the whole set forwards and
    // then backwards means every tab has been both the one being left and the
    // one being asked for.
    //
    // Each hop asserts three things at once: the route accepted it, the echo
    // names the right tab (so the agent can say what it showed), and the
    // browser's own most-recently-used ordering now heads with that tab (so
    // something actually happened inside the browser, not just in our reply).
    const tabs = await ourTabs();
    assert.ok(
      tabs.length >= 3,
      `expected a multi-tab browser, got ${tabs.length}: ${JSON.stringify(tabs.map((t) => t.title))}`,
    );

    const order = [...tabs, ...[...tabs].reverse()];
    const visited = [];
    for (const tab of order) {
      const res = await readJson(await focusTab(tab.targetId));
      assert.equal(res.status, 200, `focusing ${JSON.stringify(tab.title)} failed: ${res.raw}`);
      assert.equal(res.body.focused, true);
      assert.equal(res.body.targetId, tab.targetId);
      assert.equal(
        res.body.title,
        tab.title,
        `the echo named the wrong tab: asked for ${JSON.stringify(tab.title)}, ` +
          `got ${JSON.stringify(res.body.title)}`,
      );
      assert.equal(res.body.url, tab.url);

      await waitForHeadTab(tab.targetId, JSON.stringify(tab.title));
      visited.push(tab.title);
    }

    // Every tab really was visited — a loop that silently skipped would
    // otherwise pass on the strength of the ones it did run.
    assert.deepEqual(
      [...new Set(visited)].sort(),
      tabs.map((t) => t.title).sort(),
    );
    console.log(`[live] switched through ${visited.length} focus hops: ${visited.join(' → ')}`);

    // And the whole walk left the browser exactly as it found it.
    const after = await ourTabs();
    assert.deepEqual(
      after.map((t) => t.targetId).sort(),
      tabs.map((t) => t.targetId).sort(),
    );
  });

  it('photographs a backgrounded tab CURRENTLY — the rendering half of rule (5)', async function () {
    // The part of verification rule (5) the story says nobody had measured:
    // "does `Page.captureScreenshot` render a backgrounded tab of a headful
    // browser identically". Everything above the renderer is target-addressed
    // and provably unaffected by a focus; this is the layer that could
    // plausibly have differed, because a compositor is entitled to stop
    // producing frames for a tab nobody is looking at.
    //
    // **The obvious assertion is the wrong one, and it took a review to see
    // it.** An earlier version shot the tab in front, focused another, shot it
    // again and asserted the bytes were EQUAL. Against a static fixture page
    // that proves nothing about the failure it exists to exclude: if the
    // compositor had handed back the last frame from when the tab was visible,
    // the bytes would be identical too. Stale and current are the same picture.
    //
    // So the tab is CHANGED while it is backgrounded, and the assertion is that
    // the capture moved with it. That proves the frame is current — which the
    // equality never did — and it survives an antialiasing or device-pixel
    // difference, which the equality would not have.
    let chromium;
    try {
      // playwright-core, not playwright: this only ever calls
      // `chromium.connectOverCDP` against a browser the framework already
      // launched, so the full package's postinstall would download ~300MB of
      // browsers that nothing here starts — on every clean install and in CI.
      ({ chromium } = require('playwright-core'));
    } catch {
      console.log('[live] playwright not resolvable from here — skipping the pixel check');
      this.skip();
      return;
    }

    const tabs = await ourTabs();
    const alphaTab = tabs.find((t) => t.title === 'Alpha Tab');
    const gammaTab = tabs.find((t) => t.title === 'Gamma Tab');
    assert.ok(alphaTab && gammaTab, 'fixture tabs missing');

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    try {
      const pages = browser.contexts()[0].pages();
      const alpha = pages.find((p) => p.url() === alphaTab.url);
      assert.ok(alpha, `no attached page for ${alphaTab.url}`);

      await focusTab(alphaTab.targetId);
      await waitForHeadTab(alphaTab.targetId, 'Alpha Tab');
      const frontmost = await alpha.screenshot({ timeout: 20_000 });

      await focusTab(gammaTab.targetId);
      await waitForHeadTab(gammaTab.targetId, 'Gamma Tab');

      // **Every capture taken while the tab is backgrounded goes through here.**
      // An occluded window produces no frames, so such a capture can time out —
      // the documented limitation described on the mutation capture below, and
      // a skip rather than a failure. Both backgrounded captures need that
      // grading: this used to be inlined on the second one only, so a timeout on
      // the first (a bare `await`, 29 lines earlier) failed the test outright
      // and never let the graded catch report the known case. Returns null on
      // the documented timeout; anything else still throws.
      const captureBackgrounded = async () => {
        try {
          return await alpha.screenshot({ timeout: 20_000 });
        } catch (err) {
          if (!/Timeout .* exceeded/i.test(String(err))) throw err;
          console.log(
            '[live] the backgrounded capture timed out — the browser window is occluded, so ' +
              'Chromium is producing no frames for it. This is the documented limitation ' +
              '(stories/cdp-tab-focus.md §Risks), not a focus regression. Re-run with the ' +
              'Chrome window visible to exercise the currency check.',
          );
          return null;
        }
      };

      // Unchanged, and behind another tab: the observation the story wanted,
      // kept as a log line rather than an assertion. "Renders identically" is a
      // nice measured fact, not an invariant the feature depends on — asserting
      // it buys nothing the currency check below does not, and costs a red run
      // the day a GPU-process restart flips rasterisation between two captures.
      // It is still the baseline the currency check compares against, so a
      // timeout here skips: without it there is nothing to compare.
      const unchanged = await captureBackgrounded();
      if (!unchanged) {
        this.skip();
        return;
      }
      console.log(
        `[live] backgrounded, unchanged: ${unchanged.length} bytes, ` +
          `byte-identical to frontmost: ${Buffer.compare(frontmost, unchanged) === 0}`,
      );

      // Now change something visible WHILE the tab is behind another one. A
      // compositor that had stopped producing frames for it would keep handing
      // back the old picture.
      await alpha.evaluate(() => {
        document.body.style.background = 'rgb(0, 128, 0)';
        document.title = 'Alpha Tab';
      });

      // **A timeout here is a measured limitation, not a regression** — see the
      // header. Chromium produces no new frames for a window the compositor
      // considers occluded, so a capture that needs a fresh one waits for
      // something that never arrives. Measured 2026-08-09 both ways on Chrome
      // 150: with the browser window visible, a repaint made while the tab was
      // backgrounded reached the capture in ~940ms and the bytes changed; with
      // the window fully covered (this suite runs under a VS Code host that
      // owns the foreground) the same capture times out.
      //
      // So the outcome is graded rather than binary: a picture must be a
      // CURRENT picture, but no picture at all is the documented case and is
      // recorded as a skip — which the runner now reports, rather than
      // swallowing it the way it used to.
      const afterMutation = await captureBackgrounded();
      if (!afterMutation) {
        this.skip();
        return;
      }

      assert.equal(
        afterMutation.subarray(0, 8).toString('hex'),
        '89504e470d0a1a0a',
        'the backgrounded capture is not a PNG',
      );
      assert.ok(
        afterMutation.length > 2_000,
        `backgrounded frame is only ${afterMutation.length} bytes — likely blank`,
      );
      // Same dimensions, so this is the same tab and not a differently-sized
      // surface: bytes 16-24 of a PNG are IHDR's width and height.
      assert.deepEqual(
        afterMutation.subarray(16, 24),
        frontmost.subarray(16, 24),
        'the backgrounded capture has different dimensions',
      );
      assert.notEqual(
        Buffer.compare(unchanged, afterMutation),
        0,
        'a repaint made while the tab was backgrounded did not reach the capture — ' +
          '`Page.captureScreenshot` returned a STALE frame. Rule (5) claims a run keeps ' +
          'working normally when another tab is focused; if this fails, screenshots taken ' +
          'after a focus cannot be trusted and the tool description has to say so.',
      );
      console.log(
        `[live] a repaint made while backgrounded reached the capture (${afterMutation.length} bytes)`,
      );
    } finally {
      // `close()` over CDP is a no-op on the browser itself — it detaches.
      await browser.close().catch(() => {});
    }
  });

  it('leaves a RUN IN FLIGHT on another tab alone, screenshots included', async function () {
    // **Verification rule (5)** — the one thing the story says it "genuinely
    // has to prove rather than assume", and the only scenario here that needs
    // a real session and real AI steps.
    //
    // A session attaches to the alpha tab and starts running. Mid-run, while a
    // step is executing, a focus call brings a DIFFERENT tab to the front. The
    // run must not notice: Playwright drives a page by target, not by which tab
    // is frontmost.
    //
    // The screenshot half is why `capture: 'every-step'` is set. Everything
    // above the renderer is target-addressed and provably unaffected, but "does
    // `Page.captureScreenshot` render a backgrounded tab of a headful browser
    // identically" is the part of the claim nobody had measured — so this
    // asserts the steps taken *after* the focus still come back with real,
    // decodable PNG frames rather than blank or stale ones.
    // The only scenario here that spends an AI call.
    //
    // A genuinely ABSENT credential skips, decided before anything runs, so it
    // cannot mask a result. A credential that is present but rejected does NOT
    // skip — it fails, like every other AI-driven test in this directory would.
    // An earlier version tried to be clever and skipped when the run failed
    // *and* the log mentioned a 401; that hatch could swallow a genuine "the
    // run did not survive the focus" failure, because `output` events come from
    // a process-global log bridge and another session's 401 on the same server
    // lands in this stream.
    if (!aiKey) {
      console.log('[live] no AI_API_KEY — skipping rule (5)');
      this.skip();
      return;
    }

    const tabs = await ourTabs();
    const alpha = tabs.find((t) => t.title === 'Alpha Tab');
    const gamma = tabs.find((t) => t.title === 'Gamma Tab');
    assert.ok(alpha && gamma, 'fixture tabs missing');

    const sessionId = `live-focus-run-${cdpPort}`;
    const events = [];
    let focusResult = null;

    // Two navigations rather than assertions: deterministic, cheap, and each
    // one produces a step:pass carrying a frame.
    //
    // **This mutates the fixture set for everything after it**: the alpha tab
    // ends on /gamma, so two tabs then share the title "Gamma Tab" and the same
    // url. Harmless for the tests below, which address tabs by `targetId` — but
    // do NOT add `this.retries(...)` to this suite without re-opening the tabs
    // first. A retried pass of this test would match "Gamma Tab" against the
    // ex-alpha tab and drive the very tab a session holds, then pass while
    // proving nothing.
    const body = {
      steps: [`Navigate to ${fixtureBase}/beta`, `Navigate to ${fixtureBase}/gamma`],
      testFilePath: path.join(projectRoot, '.steptix-live-focus.md'),
      config: { cdp: { port: cdpPort, tab: `targetId:${alpha.targetId}` } },
      runSettings: { capture: 'every-step' },
      // The AI credentials travel per request, exactly as Steptix sends them
      // — the server resolves its AI config from the *project's* env bundle, so
      // the key in the shell that started it is not what a run uses.
      env: { AI_API_KEY: aiKey, ...(aiModel ? { AI_MODEL: aiModel } : {}) },
    };

    const res = await fetch(`${serverUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Read the body ONLY on failure. An `await res.text()` in the assertion
    // message is evaluated eagerly, which consumes the very stream this test
    // is about to read.
    if (res.status !== 200) assert.fail(`starting the run failed: ${await res.text()}`);

    // Read the SSE stream by hand, and fire the focus at the first sign the run
    // is actually executing — "in flight" is the whole point, so focusing
    // before the first step or after the last would prove nothing.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split('\n\n');
      buffered = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const event = JSON.parse(line.slice('data:'.length).trim());
        events.push(event);

        if (event.type === 'step:start' && focusResult === null) {
          focusResult = await readJson(await focusTab(gamma.targetId));
          console.log(`[live] focused "Gamma Tab" mid-run (status ${focusResult.status})`);
        }
      }
    }

    assert.ok(focusResult, 'never saw a step start, so nothing was focused mid-run');
    assert.equal(focusResult.status, 200, focusResult.raw);
    assert.equal(focusResult.body.title, 'Gamma Tab');

    // ── Asserted whatever the AI did ──────────────────────────────────────
    //
    // Every step still reports the tab the SESSION owns, not the one now in
    // front. This is rule (5)'s core claim and it holds on a failing run as
    // firmly as on a passing one — a step that errored still errored *on its
    // own tab*. (`tab` rides the streaming path only; the non-streaming
    // response has never carried it, a trap cdp-tabs.md §Tests records.)
    const withTab = events.filter((e) => e.tab);
    assert.ok(withTab.length > 0, 'no step event carried a `tab` — is this the streaming path?');
    for (const event of withTab) {
      assert.equal(
        event.tab.targetId,
        alpha.targetId,
        `a ${event.type} reported tab ${JSON.stringify(event.tab)} — the run moved off its own tab`,
      );
    }
    assert.equal(events.filter((e) => e.type === 'step:start').length >= 1, true);

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, `the run produced no done event: ${JSON.stringify(events.map((e) => e.type))}`);

    await fetch(`${serverUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: auth(),
    });

    assert.equal(
      done.status,
      'passed',
      `the run did not survive the focus: ${JSON.stringify(
        events.filter((e) => e.type === 'step:fail' || e.type === 'output').slice(-5),
      )}`,
    );

    // Steps that ran while another tab was in front. Whatever frames came back
    // must be real ones — a blank or truncated capture attached to a report is
    // worse than none, because it looks like evidence.
    const shots = events.filter((e) => e.type === 'step:pass' && e.screenshot);
    for (const shot of shots) {
      const base64 = String(shot.screenshot).replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
      assert.ok(buf.length > 2_000, `screenshot is only ${buf.length} bytes — likely blank`);
    }

    // **Whether there are any is a separate question, and the answer is
    // environmental.** The same occlusion limitation the pixel test measures
    // reaches the runner here: with the browser window covered, Chromium
    // produces no frames for it and `captureScreenshot` times out, so the run
    // completes normally — right tab, right steps, `passed` — carrying no
    // pictures. The automation is unaffected; only the evidence is. The runner
    // logs each miss, so this looks for that rather than guessing.
    const shotTimedOut = events.some(
      (e) =>
        e.type === 'output' &&
        /screenshot capture failed/i.test(String(e.msg ?? '')) &&
        /timeout/i.test(String(e.msg ?? '')),
    );
    if (shots.length === 0) {
      assert.ok(
        shotTimedOut,
        'capture: every-step produced no screenshots and the runner never reported a ' +
          'capture timeout — so they went missing for some reason other than the ' +
          'documented occlusion case.',
      );
      console.log(
        `[live] run survived the focus (${withTab.length} events on tab ${alpha.targetId}), ` +
          'but its screenshots timed out — the browser window is occluded ' +
          '(stories/cdp-tab-focus.md §Risks). Re-run with it visible to cover the frames.',
      );
      this.skip();
      return;
    }

    console.log(
      `[live] run survived the focus: ${withTab.length} events on tab ${alpha.targetId}, ` +
        `${shots.length} screenshots`,
    );
  });

  it('closes nothing and starts nothing — the tab count is unchanged', async () => {
    // The cheap half of rule (5), with no session in play: a regression that
    // quietly closed or re-bound something would still look like a success.
    const before = await ourTabs();
    const sessionsBefore = await (await fetch(`${serverUrl}/sessions`, { headers: auth() })).json();

    const res = await focusTab(before[0].targetId);
    assert.equal(res.status, 200);

    const after = await ourTabs();
    assert.deepEqual(
      after.map((t) => t.targetId).sort(),
      before.map((t) => t.targetId).sort(),
      'focusing changed which tabs are open',
    );
    const sessionsAfter = await (await fetch(`${serverUrl}/sessions`, { headers: auth() })).json();
    assert.equal(
      sessionsAfter.sessions.length,
      sessionsBefore.sessions.length,
      'focusing created or destroyed a session',
    );
  });

  it('refuses an id the browser does not have, naming both readings', async () => {
    // Never a silent success: "already closed" and "wrong browser's id" are
    // indistinguishable from the caller's side, so the message says both.
    const res = await readJson(await focusTab('DEADBEEFDEADBEEFDEADBEEFDEADBEEF'));
    assert.equal(res.status, 404, res.raw);
    assert.match(res.body.error, /already been closed/i);
    assert.match(res.body.error, /different browser/i);
    assert.match(res.body.error, /list_cdp_browsers/);
  });

  it('refuses a port this project does not own', async () => {
    // The ownership gate, live. Port 1 has nothing on it, but the refusal must
    // be about ownership rather than reachability — the registry checks whose
    // it is before it checks whether it answers.
    const res = await readJson(
      await fetch(
        `${serverUrl}/cdp/browsers/1/tabs/T1/focus?projectRoot=${encodeURIComponent(projectRoot)}`,
        { method: 'POST', headers: auth() },
      ),
    );
    assert.equal(res.status, 404, res.raw);
    // Assert the code, not the sentence. The message's tail names which roots
    // were actually swept, so it reads differently depending on whether a
    // user-root browser happens to be open on the machine — string-matching it
    // made this test pass or fail on machine state rather than on behaviour.
    // `reason` is the part the server promises to keep.
    assert.equal(res.body.reason, 'port_not_owned', res.raw);
  });

  it('requires the api key, like every other route', async () => {
    const tabs = await ourTabs();
    const res = await fetch(
      `${serverUrl}/cdp/browsers/${cdpPort}/tabs/${tabs[0].targetId}/focus` +
        `?projectRoot=${encodeURIComponent(projectRoot)}`,
      { method: 'POST' },
    );
    assert.equal(res.status, 401);
  });
});
