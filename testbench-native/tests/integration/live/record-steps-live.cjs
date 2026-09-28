/**
 * Shared plumbing for the Record Steps live tests (record-steps-*.test.cjs).
 * Not a test file itself: the live runner schedules `*.test.cjs` only.
 *
 * THE TECHNIQUE. The recording browser belongs to the shard's server (it is
 * launched by Playwright inside the server process), so a test cannot click in
 * it directly. But the server takes `browser.launchArgs` from the PROJECT's
 * `aiui.config.json` — resolved from the test file's path — so each test makes
 * its own project folder inside the shard's workspace with
 * `--remote-debugging-port=<a free port>` in it, records into a test file in
 * that project, and then attaches to the recording browser over DevTools
 * (`chromium.connectOverCDP`) to click, type and navigate like a person.
 * Playwright's input over CDP is trusted, as a person's is.
 *
 * The toolbar is a CLOSED shadow root. DevTools can see into it
 * (`DOM.getDocument` with `pierce: true`), which is how its buttons are found
 * and read — a port of tests/record-toolbar-cdp.ts, the server suite's helper.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const TEST_APP_PORT = 8787;
const APP = `http://localhost:${TEST_APP_PORT}`;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Into the shard's own log as well as stdout — a passing launch's stdout is discarded. */
function say(line) {
  console.log(`[live] ${line}`);
  const file = process.env.TESTBENCH_LIVE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `[live] ${line}\n`);
  } catch {
    /* best effort */
  }
}

/** Poll until `predicate` holds; the error names what was last seen. */
async function waitFor(label, predicate, timeoutMs = 60_000, describe) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  let seen = '';
  if (describe) {
    try {
      seen = ` — last seen: ${await describe()}`;
    } catch {
      /* ignore */
    }
  }
  throw new Error(`timeout waiting for: ${label}${last ? ` (last error: ${last.message})` : ''}${seen}`);
}

/** The output channel, teed to a file by the live runner. */
function readLiveLog() {
  const file = process.env.TESTBENCH_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** The extension's test hooks, after checking the server and the fixture app. */
async function setUp() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `${EXT_ID} not loaded`);
  if (!ext.isActive) await ext.activate();
  const hooks = ext.exports?.__testHooks;
  assert.ok(hooks, '__testHooks missing — activation may have failed');

  const serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
  try {
    const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
    assert.ok(res.status === 204 || res.status === 200, `Server at ${serverUrl} not responding`);
  } catch (err) {
    throw new Error(
      `Live test requires the API server running at ${serverUrl}. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // runLiveTest.cjs boots (or adopts) the fixture app before any shard runs.
  assert.ok(await up(`${APP}/`), `the fixture app must be listening on ${APP}`);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
  return { hooks, serverUrl, workspaceRoot };
}

/**
 * A project folder of the test's own inside the workspace: an
 * `aiui.config.json` whose browser listens for DevTools on `cdpPort`, a `.env`
 * (the workspace's — the shard's SERVER_URL, key and model — plus `extraEnv`),
 * and `tests/` holding `files`.
 *
 * The `.env` is a whole copy because TestBench takes the FIRST `.env` walking
 * up from the test file (runner-core env-file.ts): one holding only PASSWORD
 * would hide the shard's SERVER_URL.
 */
function makeProject(workspaceRoot, name, { cdpPort, files = {}, extraEnv = {} }) {
  const dir = path.join(workspaceRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  // The same model the rest of the live suite drives (templates/init's).
  let ai;
  try {
    ai = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'init', 'aiui.config.json'), 'utf8')).ai;
  } catch {
    ai = undefined;
  }
  const config = {
    ...(ai && { ai }),
    browser: { launchArgs: [`--remote-debugging-port=${cdpPort}`] },
    tests: { dir: './tests' },
    reports: { outputDir: './reports' },
  };
  fs.writeFileSync(path.join(dir, 'aiui.config.json'), JSON.stringify(config, null, 2) + '\n');
  writeEnv(workspaceRoot, dir, extraEnv);
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'tests', file), text);
  return { dir, testsDir: path.join(dir, 'tests'), cdpPort };
}

/** (Re)write the project's `.env`: the workspace's, minus the two settings
 *  that write to disk or open windows after a run, plus `extraEnv`. */
function writeEnv(workspaceRoot, dir, extraEnv = {}) {
  const base = fs
    .readFileSync(path.join(workspaceRoot, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^(APPEND_RUN_HISTORY_TO_TEST_FILE|OPEN_REPORT_IN_BROWSER_AFTER_RUN)=/.test(l));
  const extra = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(
    path.join(dir, '.env'),
    [...base, 'APPEND_RUN_HISTORY_TO_TEST_FILE=false', 'OPEN_REPORT_IN_BROWSER_AFTER_RUN=false', ...extra, ''].join('\n'),
  );
}

/** Open `file` and wait until TestBench owns it as the active test. */
async function openTest(hooks, file) {
  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await waitFor(
    `${path.basename(file)} becomes the active editor`,
    () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    15_000,
  );
  await waitFor('TestBench recognises the test file', () => hooks.tracker.snapshot().isTestFile, 15_000);
  return { uri, doc, editor };
}

/** 1-based line of the first line of `text` matching `re`, or -1. */
function lineOf(text, re) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? -1 : i + 1;
}

/** The numbered steps under `## Steps` (main flow), as { n, text, line }. */
function stepsOf(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+Steps\s*$/.test(l));
  const out = [];
  if (at < 0) return out;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) break;
    const m = /^(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (m) out.push({ n: Number(m[1]), text: m[2].trim(), line: i + 1 });
  }
  return out;
}

/** `- name: value` lines under `## Parameters`. */
function parametersOf(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+Parameters\s*$/.test(l));
  const out = [];
  if (at < 0) return out;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    const m = /^\s*[-*+]\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) out.push({ name: m[1], value: m[2].trim() });
  }
  return out;
}

/** Every recording-panel field as one string, for secret scans. */
function stateText(hooks) {
  return JSON.stringify(hooks.recordingState() ?? null);
}

/** The recorded ACTIONS (not markers, not steps of the author's). */
function actionRows(hooks) {
  return (hooks.recordingState()?.actions ?? []).filter((a) => a.action);
}

/** Wait until a draft covers every action recorded so far and no call runs. */
async function draftSettled(hooks, label, timeoutMs = 120_000) {
  await waitFor(
    `the draft catches up (${label})`,
    () => {
      const s = hooks.recordingState();
      if (!s || s.drafting || !s.draft) return false;
      const last = [...s.actions].reverse().find((a) => a.action && !a.dropped);
      return !last || s.draft.through === undefined || s.draft.through === last.id;
    },
    timeoutMs,
    () => {
      const s = hooks.recordingState();
      return JSON.stringify({ drafting: s?.drafting, through: s?.draft?.through, rev: s?.draft?.revision, actions: s?.actions?.map((a) => a.id) });
    },
  );
}

/** Run the active file to rest: started, then not running. */
async function runAllToRest(hooks, label, timeoutMs = 600_000) {
  hooks.clearRunError();
  void vscode.commands.executeCommand('testbench-native.runAll');
  await waitFor(`${label}: run started`, () => hooks.isRunning(), 60_000);
  await waitFor(`${label}: run finished`, () => !hooks.isRunning(), timeoutMs);
}

// ---------------------------------------------------------------------------
// The recording browser, over DevTools
// ---------------------------------------------------------------------------

function playwright() {
  // The repo root's copy: the one the server itself runs.
  return require(path.join(REPO_ROOT, 'node_modules', 'playwright'));
}

/** Attach to the recording browser listening on `port`. */
async function connectBrowser(port, timeoutMs = 60_000) {
  const { chromium } = playwright();
  let browser = null;
  await waitFor(
    `the recording browser answers DevTools on :${port}`,
    async () => {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs,
  );
  return browser;
}

function allPages(browser) {
  return browser.contexts().flatMap((c) => c.pages());
}

/** The page (tab) whose URL starts with `prefix`, waiting for it. */
async function pageAt(browser, prefix, timeoutMs = 30_000) {
  let found = null;
  await waitFor(
    `a tab at ${prefix}`,
    () => {
      found = allPages(browser).find((p) => p.url().startsWith(prefix)) ?? null;
      return found !== null;
    },
    timeoutMs,
    () => JSON.stringify(allPages(browser).map((p) => p.url())),
  );
  return found;
}

/**
 * Click `selector` with the real mouse at its middle. Not `locator.click()`:
 * its hit-target check would object to the toolbar or the pick outline in the
 * top layer, and a person's click has no such check.
 */
async function clickOn(page, selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout: 15_000 });
  await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  const box = await loc.boundingBox();
  assert.ok(box, `${selector} has no box to click`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// ── The toolbar's closed shadow root (tests/record-toolbar-cdp.ts) ─────────

async function withCdp(page, work) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    return await work(cdp, root);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function attr(node, name) {
  const a = node.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return null;
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType === 1 && attr(node, 'hidden') !== undefined) return '';
  const inner = [...(node.shadowRoots ?? []), ...(node.children ?? [])].map(textOf).join('');
  return node.nodeType === 1 ? ` ${inner} ` : inner;
}

const hostOf = (root) => find(root, (n) => n.localName === 'aiui-recorder');
const byClass = (shadow, cls) =>
  find(shadow, (n) => n.nodeType === 1 && (attr(n, 'class') ?? '').split(/\s+/).includes(cls));

/** What the toolbar in `page` shows now, or null when there is none. */
function readToolbar(page) {
  return withCdp(page, async (_cdp, root) => {
    const host = hostOf(root);
    if (!host) return null;
    const shadow = host.shadowRoots?.[0];
    if (!shadow) return { shadowType: undefined, sub: '', status: '', all: '', minimised: false };
    const sub = byClass(shadow, 'sub');
    const status = byClass(shadow, 'status');
    const pill = byClass(shadow, 'pill');
    return {
      shadowType: shadow.shadowRootType,
      sub: sub ? textOf(sub).replace(/\s+/g, ' ').trim() : '',
      status: status ? textOf(status).replace(/\s+/g, ' ').trim() : '',
      all: textOf(shadow).replace(/\s+/g, ' ').trim(),
      minimised: pill !== null && attr(pill, 'hidden') === undefined,
    };
  });
}

/** The computed background of the bar's surface (`.tb`) inside the closed root. */
function toolbarSurfaceColour(page) {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const bar = host?.shadowRoots?.[0] ? byClass(host.shadowRoots[0], 'tb') : null;
    if (!bar) return null;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: bar.nodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return getComputedStyle(this).backgroundColor; }',
      returnByValue: true,
    });
    return result.value;
  });
}

/** Where a toolbar button (`data-cmd`) is on screen, or null. */
function toolbarButtonAt(page, cmd) {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const button = host ? find(host, (n) => n.nodeType === 1 && attr(n, 'data-cmd') === cmd) : null;
    if (!button) return null;
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { nodeId: button.nodeId });
      const q = model.content;
      return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
    } catch {
      return null;
    }
  });
}

/** Click a toolbar button with the real (trusted) mouse, waiting for it to show. */
async function clickToolbar(page, cmd, timeoutMs = 10_000) {
  let at = null;
  await waitFor(`the toolbar's "${cmd}" button`, async () => (at = await toolbarButtonAt(page, cmd)) !== null, timeoutMs);
  await page.mouse.click(at.x, at.y);
}

// ── The Steps so far drawer (stories/testbench-record-edit-steps.md) ───────
// A port of readDrawer / drawerAt / clickDrawer / barFocus in
// tests/record-toolbar-cdp.ts, the server suite's helper.

/** The lock icon's shackle — the path only the lock glyph draws. */
const LOCK_SHACKLE = 'M4 5.2V3.8a2 2 0 0 1 4 0v1.4';

const hasClass = (n, cls) => n.nodeType === 1 && (attr(n, 'class') ?? '').split(/\s+/).includes(cls);

async function valueOf(cdp, nodeId) {
  const { object } = await cdp.send('DOM.resolveNode', { nodeId });
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { return this.value; }',
    returnByValue: true,
  });
  return result.value;
}

async function centreOf(cdp, nodeId) {
  try {
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
    const q = model.content;
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  } catch {
    return null;
  }
}

/**
 * The drawer of the toolbar in `page`, read inside its closed root, or null
 * when there is no toolbar: `{ open, rows: [{ id, kind, text, n, yours,
 * editing }], foot, lock, lockInBar }`. `kind` is live | deleted | restoring |
 * pending; `text` is what the row's box holds while it is edited. `lock`: a
 * lock glyph anywhere in the drawer; `lockInBar`: anywhere in the bar (the
 * status row's "Typing hidden" chip draws one on purpose).
 */
function readDrawer(page) {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const shadow = host?.shadowRoots?.[0];
    if (!shadow) return null;
    const isLock = (n) => n.localName === 'path' && attr(n, 'd') === LOCK_SHACKLE;
    const lockInBar = find(shadow, isLock) !== null;
    const drawer = find(shadow, (n) => hasClass(n, 'drawer'));
    if (!drawer) return { open: false, rows: [], foot: '', lock: false, lockInBar };
    const rows = [];
    const walk = async (n) => {
      if (n.localName === 'li' && hasClass(n, 'row')) {
        const cls = (attr(n, 'class') ?? '').split(/\s+/);
        const kind = ['live', 'deleted', 'restoring', 'pending'].find((k) => cls.includes(k)) ?? 'live';
        const t = find(n, (c) => hasClass(c, 't'));
        const input = find(n, (c) => c.localName === 'input');
        const num = find(n, (c) => hasClass(c, 'n'));
        let text = t ? textOf(t).replace(/\s+/g, ' ').trim() : '';
        if (input) text = await valueOf(cdp, input.nodeId);
        rows.push({
          id: attr(n, 'data-row-id') ?? '',
          kind,
          text,
          n: num ? textOf(num).trim() : '',
          yours: find(n, (c) => hasClass(c, 'yours')) !== null,
          editing: input !== null,
        });
        return;
      }
      for (const c of n.children ?? []) await walk(c);
    };
    await walk(drawer);
    const foot = find(drawer, (n) => hasClass(n, 'foot'));
    return {
      open: attr(drawer, 'hidden') === undefined,
      rows,
      foot: foot ? textOf(foot).replace(/\s+/g, ' ').trim() : '',
      lock: find(drawer, isLock) !== null,
      lockInBar,
    };
  });
}

/** Where a drawer row (`cmd` null) or one of its controls is on screen:
 *  `row-edit` (its words), `row-delete` (✕), `row-restore`, `row-insert` (the
 *  + in the gap below it). */
function drawerAt(page, id, cmd) {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const node = host
      ? find(
          host,
          (n) =>
            n.nodeType === 1 &&
            (cmd === null
              ? n.localName === 'li' && attr(n, 'data-row-id') === id
              : attr(n, 'data-cmd') === cmd && attr(n, 'data-id') === id),
        )
      : null;
    return node ? centreOf(cdp, node.nodeId) : null;
  });
}

/** Use a drawer row's control with the real mouse: the pointer goes over the
 *  row first — its ✕ and + show on hover — then onto the control, once the
 *  bar has stopped moving (a push that adds a row moves every row). */
async function clickDrawer(page, id, cmd) {
  const row = await drawerAt(page, id, null);
  assert.ok(row, `the drawer has no row for ${id}`);
  await page.mouse.move(row.x, row.y);
  await sleep(80);
  let at = await drawerAt(page, id, cmd);
  for (let i = 0; i < 10 && at; i++) {
    await sleep(60);
    const again = await drawerAt(page, id, cmd);
    if (again && Math.abs(again.x - at.x) < 0.5 && Math.abs(again.y - at.y) < 0.5) break;
    at = again;
  }
  assert.ok(at, `the row for ${id} has no "${cmd}"`);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await sleep(50);
  await page.mouse.click(at.x, at.y);
}

/** Where keyboard focus is inside the bar, and whether it shows. */
function barFocus(page) {
  return withCdp(page, async (cdp, root) => {
    const shadow = hostOf(root)?.shadowRoots?.[0];
    if (!shadow) return null;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: shadow.nodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function () { const a = this.activeElement; if (!a) return null; return { cmd: a.getAttribute("data-cmd"), ' +
        'id: a.getAttribute("data-row-id") || a.getAttribute("data-id"), row: a.localName === "li", ' +
        'visible: a.matches(":focus-visible") }; }',
      returnByValue: true,
    });
    return result.value;
  });
}

/** Open Steps so far (it is closed in every new document), and wait for it. */
async function openDrawer(page, timeoutMs = 30_000) {
  const d = await readDrawer(page);
  if (d?.open) return;
  await clickToolbar(page, 'drawer', timeoutMs);
  await waitFor('the drawer opens', async () => (await readDrawer(page))?.open === true, 10_000, async () =>
    JSON.stringify(await readToolbar(page)),
  );
}

/**
 * Put keyboard focus on the drawer row for `id` the way a person does:
 * Alt+Shift+R into the bar, Tab round it to the first row, then the arrow
 * keys to the one wanted. Returns the focus as the bar has it.
 */
async function focusDrawerRow(page, id) {
  await page.keyboard.press('Alt+Shift+R');
  await waitFor('focus in the bar', async () => (await barFocus(page)) !== null, 10_000);
  let f = await barFocus(page);
  for (let i = 0; i < 40 && !f?.row; i++) {
    await page.keyboard.press('Tab');
    f = await barFocus(page);
  }
  assert.ok(f?.row, `Tab never reached a drawer row: ${JSON.stringify(f)}`);
  for (let i = 0; i < 40 && f?.id !== id; i++) {
    const order = ((await readDrawer(page))?.rows ?? []).filter((r) => r.kind !== 'pending').map((r) => r.id);
    const from = order.indexOf(f?.id);
    const to = order.indexOf(id);
    assert.ok(to >= 0, `no drawer row ${id}: ${JSON.stringify(order)}`);
    await page.keyboard.press(from < to ? 'ArrowDown' : 'ArrowUp');
    f = await barFocus(page);
  }
  assert.equal(f?.id, id, `the arrow keys reach row ${id}: ${JSON.stringify(f)}`);
  return f;
}

// ── Reading the recording, for assertions and for the report ──────────────

/** The recording as TestBench holds it, compact: the draft, the struck
 *  steps and the action list — what an assertion message should show. */
function recordingSummary(hooks) {
  const s = hooks.recordingState();
  if (!s) return 'no recording';
  const d = s.draft;
  return JSON.stringify(
    {
      phase: s.phase,
      drafting: s.drafting,
      draft: d && {
        revision: d.revision,
        steps: d.steps,
        ids: d.ids,
        edited: d.edited,
        authored: d.authored,
        parameters: d.parameters,
        through: d.through,
      },
      deletedSteps: s.deletedSteps,
      actions: s.actions.map((a) =>
        [a.id, a.kind, a.summary, a.dropped ? 'DROPPED' : '', a.droppedWith ?? '', a.source ?? ''].filter(Boolean).join(' | '),
      ),
    },
    null,
    1,
  );
}

/** The file's numbered steps read `expected` in order, numbered 1..n. */
/** The file's steps read `expected`, in order. `numbers: false` ignores the
 *  step numbers — right after the author deletes a line, a write that would
 *  only renumber waits, so one Ctrl+Z still brings the line back. */
function stepsRead(text, expected, { numbers = true } = {}) {
  const steps = stepsOf(text);
  return (
    steps.length === expected.length &&
    steps.every((s, i) => (!numbers || s.n === i + 1) && s.text === expected[i])
  );
}

/** The toolbar host's box and whether it is in the top layer (light DOM, so the page can say). */
function hostState(page) {
  return page.evaluate(() => {
    const host = document.querySelector('aiui-recorder');
    if (!host) return { present: false, topLayer: false, x: 0, y: 0, width: 0, height: 0, parent: '' };
    const r = host.getBoundingClientRect();
    let topLayer = false;
    try {
      topLayer = host.matches(':popover-open');
    } catch {
      /* no popover support */
    }
    return {
      present: true,
      topLayer,
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      parent: host.parentElement ? host.parentElement.tagName : '',
    };
  });
}

module.exports = {
  APP,
  EXT_ID,
  REPO_ROOT,
  sleep,
  say,
  waitFor,
  readLiveLog,
  freePort,
  setUp,
  makeProject,
  writeEnv,
  openTest,
  lineOf,
  stepsOf,
  parametersOf,
  stateText,
  actionRows,
  draftSettled,
  runAllToRest,
  connectBrowser,
  allPages,
  pageAt,
  clickOn,
  readToolbar,
  toolbarSurfaceColour,
  toolbarButtonAt,
  clickToolbar,
  hostState,
  readDrawer,
  drawerAt,
  clickDrawer,
  barFocus,
  openDrawer,
  focusDrawerRow,
  recordingSummary,
  stepsRead,
};
