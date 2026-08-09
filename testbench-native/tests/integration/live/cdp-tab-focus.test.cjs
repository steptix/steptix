/**
 * Live end-to-end CDP tab focus (stories/cdp-tab-focus.md).
 *
 * Drives a REAL Chrome over CDP through the REAL ai-ui-automation Sessions API
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
 * under templates/init/.aiui/cdp-profiles/, and the test closes it on the way
 * out — it never touches a profile anyone signs into.
 *
 * NOT part of the fast suite. Run via: node tests/integration/runLiveTest.cjs
 * (auto-discovered by the glob), or scope it with
 * TESTBENCH_LIVE_GREP="CDP tab focus".
 *
 * Required env: AIUI_SERVER_API_KEY in templates/.env. No AI key needed.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
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

/** Read one key out of templates/.env without pulling in a dotenv dependency. */
function readEnvValue(envPath, key) {
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return '';
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

describe('TestBench live — CDP tab focus (stories/cdp-tab-focus.md)', function () {
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
   * asynchronous, so a single settle is a bet on a machine's timing; polling
   * to a budget passes instantly on a quick machine and still gives a loaded
   * one room. Exhausting the budget means what it says.
   */
  async function waitForHeadTab(targetId, label, budgetMs = 5_000) {
    const deadline = Date.now() + budgetMs;
    let head;
    for (;;) {
      const tabs = await ourTabs();
      head = tabs[0];
      if (head && head.targetId === targetId) return;
      if (Date.now() >= deadline) break;
      await sleep(100);
    }
    assert.fail(
      `after focusing ${label} the browser's most-recently-used tab is still ` +
        `${JSON.stringify(head ? head.title : '(none)')} after ${budgetMs}ms.\n` +
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
    // The server resolves a project by walking up for aiui.config.json;
    // templates/init is the marker directory, so CDP profiles land in
    // templates/init/.aiui/cdp-profiles/ (gitignored).
    projectRoot = path.resolve(workspaceRoot, 'init');
    assert.ok(
      fs.existsSync(path.join(projectRoot, 'aiui.config.json')),
      `no aiui.config.json under ${projectRoot}`,
    );

    apiKey = readEnvValue(path.join(workspaceRoot, '.env'), 'AIUI_SERVER_API_KEY');
    assert.ok(apiKey, 'AIUI_SERVER_API_KEY missing from templates/.env');

    // AI credentials come from the REPO ROOT `.env` in preference to
    // `templates/.env`, and the difference is the model rather than the key.
    // The two files carry the same `AI_API_KEY`, but templates names a bare
    // `openrouter/…` model, which routes direct/BYOK — so the gateway key is
    // sent to a provider that has never heard of it and the first step dies on
    // `401 Missing Authentication header`. The root file's `aibroker/…` prefix
    // routes through the gateway the key actually belongs to.
    const repoRootEnv = path.resolve(workspaceRoot, '..', '.env');
    const preferred = fs.existsSync(repoRootEnv) ? repoRootEnv : path.join(workspaceRoot, '.env');
    aiKey = readEnvValue(preferred, 'AI_API_KEY') || readEnvValue(path.join(workspaceRoot, '.env'), 'AI_API_KEY');
    aiModel = readEnvValue(preferred, 'AI_MODEL') || readEnvValue(path.join(workspaceRoot, '.env'), 'AI_MODEL');

    serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/health`);
      assert.ok(res.ok, `Server at ${serverUrl} not healthy (status=${res.status})`);
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. Start it with ` +
          `\`npm run dev\` or \`aiui serve\`. Original error: ` +
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
    // Titles arrive with the document, and the echo assertions read them.
    await sleep(1_500);
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

  it('photographs a backgrounded tab identically — the rendering half of rule (5)', async function () {
    // The part of verification rule (5) the story says nobody had measured:
    // "does `Page.captureScreenshot` render a backgrounded tab of a headful
    // browser identically". Everything above the renderer is target-addressed
    // and provably unaffected by a focus; this is the layer that could
    // plausibly have differed, because a compositor is entitled to stop
    // producing frames for a tab nobody is looking at.
    //
    // Measured here rather than reasoned about, and deliberately WITHOUT the
    // AI: shoot the tab while it is in front, focus a different one through the
    // real route, shoot it again, and compare the bytes.
    let chromium;
    try {
      ({ chromium } = require('playwright'));
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
      const backgrounded = await alpha.screenshot({ timeout: 20_000 });

      assert.ok(backgrounded.length > 2_000, `backgrounded frame is only ${backgrounded.length} bytes`);
      assert.equal(
        Buffer.compare(frontmost, backgrounded),
        0,
        `a backgrounded tab photographed differently: ${frontmost.length} bytes in front, ` +
          `${backgrounded.length} behind. Rule (5) claims focus changes nothing observable — ` +
          'if this ever fails, the tool description has to stop saying so.',
      );
      console.log(
        `[live] backgrounded screenshot is byte-identical (${backgrounded.length} bytes)`,
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
    // The only scenario here that spends an AI call. Skipped rather than failed
    // without a key, so the rest of this file stays runnable on a machine that
    // has none.
    if (!aiKey) {
      console.log('[live] AI_API_KEY missing from templates/.env — skipping rule (5)');
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
    const body = {
      steps: [`Navigate to ${fixtureBase}/beta`, `Navigate to ${fixtureBase}/gamma`],
      testFilePath: path.join(projectRoot, '.aiui-live-focus.md'),
      config: { cdp: { port: cdpPort, tab: `targetId:${alpha.targetId}` } },
      runSettings: { capture: 'every-step' },
      // The AI credentials travel per request, exactly as TestBench sends them
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

    // ── The half that needs the model to have answered ────────────────────
    //
    // A dead AI credential is an environment problem, not a focus regression,
    // and every other AI-driven test in this directory is failing the same way
    // when it happens. Narrowed to authentication specifically so a genuine
    // failure — a step that broke because of the focus — still fails here.
    const authFailed = events.some(
      (e) =>
        e.type === 'output' &&
        /\b401\b|missing authentication|unauthor/i.test(String(e.msg ?? '')),
    );
    if (done.status !== 'passed' && authFailed) {
      console.log(
        '[live] the run could not reach the model (auth) — the tab invariant above still ' +
          'held; skipping the screenshot half. Check AI_API_KEY in templates/.env.',
      );
      this.skip();
      return;
    }

    assert.equal(
      done.status,
      'passed',
      `the run did not survive the focus: ${JSON.stringify(
        events.filter((e) => e.type === 'step:fail' || e.type === 'output').slice(-5),
      )}`,
    );

    // Steps that ran while another tab was in front still photographed their
    // own backgrounded tab. The pixel-level version of this is the test above,
    // which needs no AI; this is the same claim through the whole runner.
    const shots = events.filter((e) => e.type === 'step:pass' && e.screenshot);
    assert.ok(
      shots.length > 0,
      'no step:pass carried a screenshot — capture: every-step should have produced one per step',
    );
    for (const shot of shots) {
      const base64 = String(shot.screenshot).replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      // A real PNG, not a blank or truncated frame: magic bytes plus enough
      // bytes that an empty capture would not pass.
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
      assert.ok(buf.length > 2_000, `screenshot is only ${buf.length} bytes — likely blank`);
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
    assert.match(res.body.error, /not a CDP browser this project has running/i);
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
