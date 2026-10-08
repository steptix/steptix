/**
 * Live end-to-end: the Record Steps toolbar in the recorded page
 * (stories/steptix-record-toolbar.md; docs/specs/SPEC-record-steps.md §3.4).
 *
 * One recording driven from the toolbar the way an author uses it — its
 * shortcuts pressed in the page with trusted keys, its buttons found inside
 * the closed shadow root over DevTools (record-steps-live.cjs) — and watched
 * from Steptix: the panel state the frames build, the file the drafts are
 * written into, and the workspace state the toolbar's place is kept in.
 *
 *  - the toolbar is there: an `<steptix-recorder>` host on <html>, a manual
 *    popover in the top layer, its root closed;
 *  - Pause records nothing — clicks, typing, an address typed, a Back — and
 *    after Resume the next action is recorded;
 *  - Add step writes the line into the file exactly as typed, marked the
 *    author's and locked, and the next action does not repeat it as a Verify;
 *  - Undo takes the last action's step back out;
 *  - dragged to a corner and minimised, the NEXT recording starts there,
 *    minimised — the round trip through `record:toolbar`, the workspace state
 *    and the start body;
 *  - `steptix.recordSteps.browserToolbar: false` puts no toolbar in
 *    the page and takes no shortcut;
 *  - under `default-src 'none'; style-src 'none'; script-src 'none'` the bar
 *    still shows, styled, and the recording still records.
 *
 * The strict-CSP page is served by this file, not by fixtures/test-app: the
 * app on :8787 may be another checkout's (the live runner adopts whatever
 * owns the port), so a page added there would not be served by it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');
const L = require('./record-steps-live.cjs');
const { listenFetchable } = require('../../../../tests/listen-fetchable.cjs');

const FIXTURE = `# Toolbar

## Config
- baseUrl: ${L.APP}/

## Steps
1. Navigate to the baseUrl
`;

const AUTHOR_STEP = 'Verify the page heading says "Sign in"';

const STRICT_CSP = "default-src 'none'; style-src 'none'; script-src 'none'";
const STRICT_PAGE = `<!doctype html>
<html><head><title>Strict</title>
<style>body { background: rgb(255, 0, 0); }</style></head>
<body>
  <h1>Strict page</h1>
  <div id="inline" style="width:300px;height:40px;background:rgb(0,0,255)">Inline styled</div>
  <p><button id="go" type="button">Continue to review</button></p>
  <script>document.title = 'Script ran';</script>
</body></html>`;

describe('Steptix live — the Record Steps toolbar in the page', function () {
  this.timeout(1_500_000);

  let hooks;
  let workspaceRoot;
  let project;
  let file;
  let uri;
  let browser = null;
  let page = null;
  let strictServer = null;
  let strictOrigin = '';

  before(async () => {
    ({ hooks, workspaceRoot } = await L.setUp());
    project = L.makeProject(workspaceRoot, 'record-live-toolbar', {
      cdpPort: await L.freePort(),
      files: { 'toolbar.md': FIXTURE },
    });
    file = path.join(project.testsDir, 'toolbar.md');
    uri = vscode.Uri.file(file);
    await hooks.setRecordingToolbar(undefined);
    await vscode.workspace
      .getConfiguration('steptix')
      .update('recordSteps.browserToolbar', undefined, vscode.ConfigurationTarget.Global);

    strictServer = http.createServer((req, res) => {
      if ((req.url ?? '').split('?')[0] === '/strict.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': STRICT_CSP });
        res.end(STRICT_PAGE);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const port = await listenFetchable(strictServer, '127.0.0.1');
    strictOrigin = `http://127.0.0.1:${port}`;
    L.say(`project ${project.dir}, recording browser DevTools on :${project.cdpPort}, strict page ${strictOrigin}/strict.html`);
  });

  // A test that FAILS mid-recording must not leave it running for a later
  // test's Record to find (record-steps-extend.test.cjs measured that cascade).
  // Only on failure: the first five tests here share one recording on purpose.
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed' || !hooks?.recordingState()) return;
    await vscode.commands.executeCommand('steptix.cancelRecording');
    await L.waitFor('the leftover recording ends', () => hooks.recordingState() === null, 30_000).catch(() => {});
  });

  after(async () => {
    if (hooks?.recordingState()) await vscode.commands.executeCommand('steptix.cancelRecording');
    await hooks?.setRecordingToolbar(undefined);
    await vscode.workspace
      .getConfiguration('steptix')
      .update('recordSteps.browserToolbar', undefined, vscode.ConfigurationTarget.Global);
    await browser?.close().catch(() => {});
    await new Promise((resolve) => (strictServer ? strictServer.close(resolve) : resolve()));
    try {
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* best effort */
    }
    if (project) fs.rmSync(project.dir, { recursive: true, force: true });
  });

  const fileText = () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.getText() ?? '';
  const rows = () => hooks.recordingState()?.actions ?? [];

  async function startRecording(label) {
    const { editor } = await L.openTest(hooks, file);
    const last = L.stepsOf(editor.document.getText()).pop();
    const pos = new vscode.Position(last.line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    void vscode.commands.executeCommand('steptix.recordSteps');
    await L.waitFor(
      `${label}: the recording starts`,
      () => hooks.recordingState()?.phase === 'recording',
      120_000,
      () => JSON.stringify({ phase: hooks.recordingState()?.phase, refusal: hooks.recordingRefusal(), report: hooks.recordingReport() }),
    );
    if (!browser) browser = await L.connectBrowser(project.cdpPort);
    if (!page) page = await L.pageAt(browser, L.APP);
  }

  async function endRecording(command, status) {
    await vscode.commands.executeCommand(command);
    await L.waitFor(
      `the recording ends (${status})`,
      () => hooks.recordingState() === null && hooks.recordingReport() !== null,
      180_000,
      () => JSON.stringify({ phase: hooks.recordingState()?.phase, report: hooks.recordingReport() }),
    );
    assert.equal(hooks.recordingReport().status, status, JSON.stringify(hooks.recordingReport()));
  }

  it('is in the page: an <steptix-recorder> host on <html>, a popover in the top layer, its shadow root closed', async () => {
    await startRecording('first recording');
    const host = await (async () => {
      let s;
      await L.waitFor('the toolbar host', async () => (s = await L.hostState(page)).present && s.width > 0, 30_000);
      return s;
    })();
    L.say(`toolbar host: ${JSON.stringify(host)}`);
    assert.equal(host.parent, 'HTML', 'the host hangs off <html>, not the page body');
    assert.equal(host.topLayer, true, 'the host is an open popover: in the top layer');
    const bar = await L.readToolbar(page);
    assert.equal(bar.shadowType, 'closed', 'its shadow root is closed');
    assert.match(bar.status, /^REC\b/, `the status reads REC: ${bar.status}`);
    assert.equal(await page.evaluate(() => document.querySelector('steptix-recorder').shadowRoot), null, 'the page cannot reach into it');
  });

  it('Pause records nothing — clicks, typing, an address, a Back — and after Resume the next action is recorded', async () => {
    await L.clickOn(page, '#cookie-reject');
    await L.waitFor('the first click is recorded', () => L.actionRows(hooks).length >= 1, 15_000);
    await L.draftSettled(hooks, 'the first click');
    await L.waitFor('its draft is in the file', () => L.stepsOf(fileText()).length >= 2, 30_000, fileText);

    await page.keyboard.press('Alt+Shift+P');
    await L.waitFor('paused, as the panel hears it', () => hooks.recordingState()?.paused === true, 15_000);
    await L.waitFor('the toolbar says PAUSED', async () => /PAUSED/.test((await L.readToolbar(page))?.status ?? ''), 10_000);
    const rowsAtPause = rows().length;
    const textAtPause = fileText();
    const revisionAtPause = hooks.recordingState().draft.revision;
    assert.equal(rows()[rowsAtPause - 1].kind, 'pause', 'the panel lists a Paused marker where it happened');

    // Everything a person might do while paused.
    await L.clickOn(page, '#email');
    await page.keyboard.type('paused@example.com');
    await page.keyboard.press('Tab');
    await L.clickOn(page, '.forgot-link');
    await page.goto(`${L.APP}/assertions.html`);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/' || u.pathname.endsWith('index.html'), { timeout: 15_000 });
    // Nothing may arrive. A bounded watch, polling, rather than one sleep.
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      assert.equal(rows().length, rowsAtPause, `nothing is recorded while paused: ${JSON.stringify(rows().slice(rowsAtPause))}`);
      assert.equal(fileText(), textAtPause, 'nothing is drafted into the file while paused');
      await L.sleep(250);
    }
    assert.equal(hooks.recordingState().draft.revision, revisionAtPause, 'no draft call while paused');

    await page.keyboard.press('Alt+Shift+P');
    await L.waitFor('resumed', () => hooks.recordingState()?.paused === false, 15_000);
    assert.equal(rows()[rows().length - 1].kind, 'resume', 'the panel lists a Resumed marker');
    const afterResume = rows().length;
    await L.clickOn(page, '.forgot-link');
    await L.waitFor('the next action after Resume is recorded', () => rows().length === afterResume + 1, 15_000, () => JSON.stringify(rows()));
    const added = rows().slice(afterResume);
    assert.equal(added.length, 1, `exactly one new row: ${JSON.stringify(added)}`);
    assert.equal(added[0].kind, 'click', `and it is the click: ${JSON.stringify(added)}`);
    assert.match(added[0].summary, /forgot/i, `on the link clicked after Resume: ${added[0].summary}`);
    await L.draftSettled(hooks, 'the click after Resume');
    await L.waitFor('its step is drafted into the file', () => fileText() !== textAtPause, 30_000);
  });

  it('Add step writes the line exactly as typed, the author\'s and locked, and the next action repeats no Verify', async () => {
    await page.keyboard.press('Alt+Shift+S');
    await L.waitFor('the step box opens', async () => /Enter to add/.test((await L.readToolbar(page))?.sub ?? ''), 10_000);
    await page.keyboard.type(AUTHOR_STEP);
    await page.keyboard.press('Enter');

    await L.waitFor(
      "the panel lists it as the author's step from the toolbar",
      () => rows().some((a) => a.kind === 'step' && a.source === 'toolbar' && a.summary === AUTHOR_STEP),
      60_000,
      () => JSON.stringify(rows()),
    );
    await L.waitFor(
      "a draft holds it as the author's, locked",
      () => {
        const d = hooks.recordingState()?.draft;
        if (!d) return false;
        const i = d.steps.indexOf(AUTHOR_STEP);
        return i >= 0 && (d.authored ?? []).includes(i) && (d.locked ?? 0) >= i + 1;
      },
      120_000,
      () => JSON.stringify(hooks.recordingState()?.draft),
    );
    await L.waitFor(
      'the line is in the file exactly as typed',
      () => L.stepsOf(fileText()).some((s) => s.text === AUTHOR_STEP),
      30_000,
      fileText,
    );

    // The next action: the model must not write a Verify of its own for it.
    const before = L.actionRows(hooks).length;
    await L.clickOn(page, '#sign-in-btn');
    await L.waitFor('the click after the step is recorded', () => L.actionRows(hooks).length === before + 1, 15_000);
    await L.draftSettled(hooks, 'the click after the author step');
    const draft = hooks.recordingState().draft;
    L.say(`draft after Add step + click: ${JSON.stringify(draft)}`);
    const i = draft.steps.indexOf(AUTHOR_STEP);
    assert.ok(i >= 0, 'the author step is still in the draft');
    assert.ok(draft.steps.length > i + 1, `the click after it has a step of its own: ${JSON.stringify(draft.steps)}`);
    assert.deepEqual(
      draft.steps.filter((s) => /^verify\b/i.test(s)),
      [AUTHOR_STEP],
      'the only Verify is the author\'s — none repeated for the next action',
    );
    await L.waitFor('the file holds the new step too', () => L.stepsOf(fileText()).length === draft.steps.length + 1, 30_000, fileText);
    const inFile = L.stepsOf(fileText());
    assert.equal(inFile.filter((s) => s.text === AUTHOR_STEP).length, 1, `the author step is in the file once:\n${fileText()}`);
    assert.deepEqual(inFile.filter((s) => /^verify\b/i.test(s.text)).map((s) => s.text), [AUTHOR_STEP]);
  });

  it("Undo (Alt+Shift+Z) takes the last action's step back out", async () => {
    const lastAction = L.actionRows(hooks).pop();
    const stepsBefore = hooks.recordingState().draft.steps;
    await page.keyboard.press('Alt+Shift+Z');
    await L.waitFor(
      'the last action is struck',
      () => rows().find((a) => a.id === lastAction.id)?.dropped === true,
      15_000,
      () => JSON.stringify(rows()),
    );
    await L.waitFor(
      'a draft without its step',
      () => {
        const d = hooks.recordingState()?.draft;
        return !!d && !hooks.recordingState().drafting && d.steps.length === stepsBefore.length - 1 && d.steps[d.steps.length - 1] === AUTHOR_STEP;
      },
      120_000,
      () => JSON.stringify(hooks.recordingState()?.draft),
    );
    await L.waitFor(
      'the file without it',
      () => {
        const s = L.stepsOf(fileText());
        return s.length === stepsBefore.length && s[s.length - 1].text === AUTHOR_STEP;
      },
      30_000,
      fileText,
    );
  });

  it('dragged to a corner and minimised, the next recording starts there, minimised', async () => {
    const grip = await L.toolbarButtonAt(page, 'grip');
    assert.ok(grip, 'the grip is showing');
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x - 150, grip.y - 200, { steps: 6 });
    await page.mouse.move(60, 40, { steps: 6 });
    await page.mouse.up();
    await L.waitFor('Steptix keeps the dock', () => hooks.recordingToolbar()?.dock === 'tl', 15_000, () => JSON.stringify(hooks.recordingToolbar()));
    await page.keyboard.press('Alt+Shift+M');
    await L.waitFor('the toolbar is minimised', async () => (await L.readToolbar(page))?.minimised === true, 10_000);
    await L.waitFor('Steptix keeps it minimised', () => hooks.recordingToolbar()?.minimised === true, 15_000, () => JSON.stringify(hooks.recordingToolbar()));
    assert.equal(L.actionRows(hooks).filter((a) => !a.dropped).length, 2, 'neither the drag nor the shortcut was recorded');

    await endRecording('steptix.stopRecording', 'inserted');
    L.say(`toolbar.md after the first recording:\n${fileText()}`);
    assert.ok(L.stepsOf(fileText()).some((s) => s.text === AUTHOR_STEP), 'the result keeps the author step');
    const textBefore = fileText();

    await startRecording('second recording');
    await L.waitFor('the new recording\'s bar comes up minimised', async () => (await L.readToolbar(page))?.minimised === true, 20_000);
    const host = await L.hostState(page);
    L.say(`second recording's host: ${JSON.stringify(host)}`);
    assert.ok(host.x < 120 && host.y < 120, `docked top-left, where it was left: ${JSON.stringify(host)}`);
    await endRecording('steptix.cancelRecording', 'cancelled');
    assert.equal(fileText(), textBefore, 'Cancel writes nothing');
    await hooks.setRecordingToolbar(undefined);
  });

  it('with steptix.recordSteps.browserToolbar off, there is no toolbar in the page and no shortcut is taken', async () => {
    // A fresh document: the last recording's bar leaves on its own a few
    // seconds after it ends, and this must not be mistaken for it.
    await page.reload();
    await L.waitFor('no toolbar before recording', async () => !(await L.hostState(page)).present, 15_000);
    await vscode.workspace
      .getConfiguration('steptix')
      .update('recordSteps.browserToolbar', false, vscode.ConfigurationTarget.Global);
    try {
      await startRecording('recording without the toolbar');
      await page.reload();
      await page.waitForLoadState('load');
      const until = Date.now() + 3_000;
      while (Date.now() < until) {
        assert.equal((await L.hostState(page)).present, false, 'no <steptix-recorder> in the page');
        await L.sleep(250);
      }
      await page.keyboard.press('Alt+Shift+P');
      await L.sleep(1_500);
      assert.notEqual(hooks.recordingState()?.paused, true, 'Alt+Shift+P is not taken without the toolbar');
      await endRecording('steptix.cancelRecording', 'cancelled');
    } finally {
      await vscode.workspace
        .getConfiguration('steptix')
        .update('recordSteps.browserToolbar', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("under a strict Content-Security-Policy the bar shows, styled, and the recording still records", async () => {
    await startRecording('recording onto a strict-CSP page');
    const textBefore = fileText();
    await page.goto(`${strictOrigin}/strict.html`);
    // The control: the policy is in force — the page's own style, inline
    // style and script are all refused.
    const own = await page.evaluate(() => ({
      title: document.title,
      body: getComputedStyle(document.body).backgroundColor,
      inline: Math.round(document.getElementById('inline').getBoundingClientRect().width),
    }));
    assert.equal(own.title, 'Strict', `the page's script was refused: ${JSON.stringify(own)}`);
    assert.notEqual(own.body, 'rgb(255, 0, 0)', `the page's <style> was refused: ${JSON.stringify(own)}`);
    assert.notEqual(own.inline, 300, `the page's inline style was refused: ${JSON.stringify(own)}`);

    let host;
    await L.waitFor('the toolbar on the strict page', async () => (host = await L.hostState(page)).present && host.width > 0, 20_000);
    const surface = await L.toolbarSurfaceColour(page);
    L.say(`strict CSP: host ${JSON.stringify(host)}, surface ${surface}, page ${JSON.stringify(own)}`);
    assert.equal(host.topLayer, true, 'in the top layer');
    assert.ok(host.width > 300 && host.height > 30 && host.height < 120, `laid out as a bar: ${JSON.stringify(host)}`);
    assert.equal(surface, 'rgb(27, 30, 35)', 'its adopted sheet applied: the graphite surface (#1B1E23)');
    assert.match((await L.readToolbar(page)).status, /^REC\b/);

    const before = L.actionRows(hooks).length;
    await L.clickOn(page, '#go');
    await L.waitFor(
      'the click on the strict page is recorded',
      () => L.actionRows(hooks).slice(before).some((a) => a.kind === 'click' && /continue/i.test(a.summary)),
      15_000,
      () => JSON.stringify(L.actionRows(hooks)),
    );
    await endRecording('steptix.cancelRecording', 'cancelled');
    await L.waitFor('Cancel writes nothing', () => fileText() === textBefore, 15_000);
  });
});
