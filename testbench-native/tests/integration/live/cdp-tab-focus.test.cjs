/**
 * Live end-to-end CDP tab focus (stories/cdp-tab-focus.md).
 *
 * Drives a REAL Chrome over CDP through the REAL ai-ui-automation Sessions API
 * server ($LIVE_SERVER_URL, default http://localhost:3100). No AI calls and no
 * session: this exercises the browser-control routes, which is the whole of
 * what the feature is.
 *
 * **What it can and cannot prove.** No assertion in this repo can see a screen,
 * so "the user can see that window" stays a human check (the story's
 * verification rule 1). What *is* observable is that the browser selected the
 * tab: Chrome serves `/json/list` in most-recently-used order — the HTTP
 * handler sorts by `GetLastActivityTime()` descending, and `ActivateTabAt`
 * bumps that clock — so a tab that moves to the head of the list after a focus
 * call is a tab the browser really activated. That is the half this test owns.
 * It is deliberately blind to whether the OS honoured the window raise, which
 * is exactly why `focused: true` means "the browser accepted it".
 *
 * MRU ordering is source-confirmed for Chrome and unverified for Edge, so this
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
 * Required env: SERVER_API_KEY in templates/.env. No AI key needed.
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
  let projectRoot;
  /** @type {http.Server} */
  let fixtureServer;
  let fixtureBase;
  /** CDP debug port of the browser this test launched. */
  let cdpPort;
  /** targetId of every tab this test opened, so cleanup closes exactly those. */
  const openedTabs = [];

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

  /** The browser's raw target list, newest-activity first (see the header). */
  async function rawTargets() {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const all = await res.json();
    return all.filter((t) => t.type === 'page');
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
    openedTabs.push(target.id);
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

    apiKey = readEnvValue(path.join(workspaceRoot, '.env'), 'SERVER_API_KEY');
    assert.ok(apiKey, 'SERVER_API_KEY missing from templates/.env');

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
    await sleep(300);

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

    await sleep(300);
    const targets = await rawTargets();
    assert.equal(
      targets[0].id,
      alpha.targetId,
      'the browser did not select the focused tab — /json/list is most-recently-used ' +
        'ordered on Chrome, so the focused tab should now be first. ' +
        `Got: ${JSON.stringify(targets.map((t) => t.title))}`,
    );

    // And it moves again, so the first result was not a tab that happened to
    // already be selected.
    res = await readJson(await focusTab(gamma.targetId));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.title, 'Gamma Tab');
    await sleep(300);
    assert.equal((await rawTargets())[0].id, gamma.targetId);
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

      await sleep(300);
      const head = (await rawTargets())[0];
      assert.equal(
        head.id,
        tab.targetId,
        `after focusing ${JSON.stringify(tab.title)} the browser's most-recently-used ` +
          `tab is ${JSON.stringify(head.title)}`,
      );
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

  it('closes nothing and starts nothing — the tab count is unchanged', async () => {
    // Verification rule (5), at the layer an automated test can reach: focus is
    // the one operation here that is free of consequence, and a regression that
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
