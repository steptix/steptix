/**
 * Live end-to-end: editing, deleting and inserting steps in the browser
 * toolbar's Steps so far drawer while recording
 * (stories/testbench-record-edit-steps.md, "The drawer").
 *
 * Recordings of the fixture app — the cookie banner, a sign-in, menu clicks —
 * driven the way an author drives them: in the recording browser (reached
 * over DevTools, record-steps-live.cjs), with the drawer's controls found
 * inside the toolbar's CLOSED shadow root and used with the trusted mouse and
 * keyboard. Watched from TestBench: the file the drafts are written into, and
 * the panel state the frames build (the draft, the struck steps, the action
 * list).
 *
 *  - a step the model wrote, reworded in place and saved with Enter, is in the
 *    file in exactly those words, numbered, shown `yours` — and two actions
 *    later it is still there once, and the model wrote no second step for the
 *    click it stands for;
 *  - ✕ on a misclick's step takes it out of the file at once and strikes its
 *    click in the panel; the row's Restore puts both back; deleted again, the
 *    next action's redraft does not bring it back, and the panel's Restore
 *    puts it back after the step that was before it;
 *  - `+` between two steps adds a Verify there, exactly as typed;
 *  - no lock glyph anywhere in the drawer;
 *  - Stop, and the recorded file — the reworded step among it — runs green;
 *  - (a recording of its own) deleting, with the keyboard — Alt+Shift+R, Tab,
 *    the arrows, Delete — the step that typed the email takes `email` out of
 *    `## Parameters`; the row's Restore puts both back.
 *
 * What nothing below this layer proves: the two halves were built against a
 * stubbed model and a fake server; here a real model says which actions each
 * step stands for (so a delete drops the RIGHT actions, or does not), the real
 * server applies the drawer's edit-step and delete-step, and TestBench writes
 * what that produces into a real file.
 *
 * The model writes the words, so assertions are strict about placement,
 * count, the author's text, parameters and struck actions, and tolerant about
 * the model's wording.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const L = require('./record-steps-live.cjs');

const EMAIL = 'demo@securebank.com';
const SECRET = 'password123';
const EDITED = 'Open Transactions from the main menu';
const INSERTED = 'Verify the page heading says "Transaction History"';
const ANCHOR = 'Navigate to the baseUrl';

const seed = (title) => `# ${title}

## Config
- baseUrl: ${L.APP}/

## Steps
1. ${ANCHOR}
`;

describe('TestBench live — Record Steps: edit, delete and insert steps in the drawer', function () {
  this.timeout(1_500_000);

  let hooks;
  let workspaceRoot;
  let project;
  let file;
  let uri;
  let browser = null;
  let page = null;

  before(async () => {
    ({ hooks, workspaceRoot } = await L.setUp());
    project = L.makeProject(workspaceRoot, 'record-live-edit-drawer', {
      cdpPort: await L.freePort(),
      files: { 'drawer.md': seed('Drawer'), 'email.md': seed('Email') },
    });
    file = path.join(project.testsDir, 'drawer.md');
    uri = vscode.Uri.file(file);
    L.say(`project ${project.dir}, recording browser DevTools on :${project.cdpPort}`);
  });

  // The tests that carry on the recording the test before them left.
  const carriesOn = new Set();
  const continuing = (test) => (carriesOn.add(test), test);

  // A test that FAILS mid-recording must not leave it running for a later
  // Record to find (record-steps-extend.test.cjs measured that cascade). Only
  // on failure — and not when the next test carries on this very recording:
  // then it is that test's to use, so one failure (a known bug, say) does not
  // take every later scenario down with it. `after` cancels whatever is left.
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed' || !hooks?.recordingState()) return;
    L.say(`"${this.currentTest.title}" failed with the recording at: ${summary()}`);
    const tests = this.currentTest.parent.tests;
    const next = tests[tests.indexOf(this.currentTest) + 1];
    if (next && carriesOn.has(next)) return;
    await vscode.commands.executeCommand('testbench-native.cancelRecording');
    await L.waitFor('the leftover recording ends', () => hooks.recordingState() === null, 30_000).catch(() => {});
  });

  after(async () => {
    if (hooks?.recordingState()) await vscode.commands.executeCommand('testbench-native.cancelRecording');
    await browser?.close().catch(() => {});
    try {
      await vscode.commands.executeCommand('testbench-native.restartSession');
    } catch {
      /* best effort */
    }
    if (project) fs.rmSync(project.dir, { recursive: true, force: true });
  });

  const fileText = () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.getText() ?? '';
  const state = () => hooks.recordingState();
  const draft = () => state()?.draft ?? { steps: [], ids: [], edited: [], authored: [], parameters: [] };
  const summary = () => `${L.recordingSummary(hooks)}\nfile:\n${fileText()}`;
  /** The file's steps are the anchor, then the draft — in order, numbered. */
  const fileIsDraft = () => L.stepsRead(fileText(), [ANCHOR, ...draft().steps]);
  const struckWith = (id) => (state()?.actions ?? []).filter((a) => a.droppedWith === id);
  const edits = () => (state()?.actions ?? []).filter((a) => a.kind === 'edit');

  function recording() {
    assert.equal(state()?.phase, 'recording', `the recording must still run (an earlier test failed?): ${summary()}`);
  }

  /** Every action recorded so far is drafted, and the file shows the draft. */
  async function settled(label) {
    await L.draftSettled(hooks, label);
    await L.waitFor(`the file shows the draft (${label})`, fileIsDraft, 30_000, summary);
  }

  /** A click in the page, recorded and settled. */
  async function clickTo(selector, urlRe, label) {
    const before = L.actionRows(hooks).length;
    await L.clickOn(page, selector);
    if (urlRe) await page.waitForURL(urlRe, { timeout: 30_000 });
    await L.waitFor(`${label} is recorded`, () => L.actionRows(hooks).length > before, 15_000, summary);
    await settled(label);
  }

  /** Record at step 1 of the active file, attach to the browser, sign in. */
  async function recordSignIn(label) {
    const { editor } = await L.openTest(hooks, file);
    const at = L.stepsOf(editor.document.getText()).pop();
    editor.selection = new vscode.Selection(at.line - 1, 0, at.line - 1, 0);
    void vscode.commands.executeCommand('testbench-native.recordSteps');
    await L.waitFor(
      `${label}: the recording starts`,
      () => state()?.phase === 'recording',
      120_000,
      () => JSON.stringify({ phase: state()?.phase, refusal: hooks.recordingRefusal(), report: hooks.recordingReport() }),
    );
    browser = await L.connectBrowser(project.cdpPort);
    page = await L.pageAt(browser, L.APP);
    await L.waitFor('the toolbar is in the page', async () => (await L.readToolbar(page))?.status.startsWith('REC'));

    await L.clickOn(page, '#cookie-reject');
    await L.clickOn(page, '#email');
    await page.keyboard.type(EMAIL);
    await page.keyboard.press('Tab');
    await page.keyboard.type(SECRET);
    await page.keyboard.press('Enter');
    await page.waitForURL(/dashboard\.html/, { timeout: 30_000 });
    await settled(`${label}: the sign-in`);
  }

  /** The drawer's live rows agree with the draft TestBench holds. */
  async function drawerShowsDraft(label) {
    await L.openDrawer(page);
    await L.waitFor(
      `the drawer shows the draft (${label})`,
      async () => {
        const rows = (await L.readDrawer(page))?.rows.filter((r) => r.kind === 'live') ?? [];
        const d = draft();
        return rows.length === d.steps.length && rows.every((r, i) => r.text === d.steps[i] && r.id === d.ids[i]);
      },
      30_000,
      async () => `${JSON.stringify(await L.readDrawer(page))}\n${summary()}`,
    );
    return L.readDrawer(page);
  }

  it('records the banner, a sign-in and a menu click; the drawer lists every step the draft holds, and no lock', async () => {
    await recordSignIn('the drawer recording');
    await clickTo('nav a[href="transactions.html"]', /transactions\.html/, 'the Transactions click');
    L.say(`after the Transactions click: ${summary()}`);

    const d = await drawerShowsDraft('after the Transactions click');
    L.say(`drawer: ${JSON.stringify(d)}`);
    assert.ok(d.rows.some((r) => /transaction/i.test(r.text)), `a step for the Transactions click: ${JSON.stringify(d.rows)}`);
    assert.equal(d.foot, 'Click a step to change it · ✕ removes it · + adds one below', 'the hint says how to change them');
    assert.equal(d.lock, false, 'no lock glyph in the drawer');
    assert.ok(d.rows.every((r) => r.kind === 'live' && !r.yours), `every step is the model's: ${JSON.stringify(d.rows)}`);
  });

  continuing(
    it("rewords a step the model wrote in place: Enter puts exactly those words in the file, numbered, `yours`; two actions later it is there once and the click has no second step", async () => {
      recording();
      await L.openDrawer(page);
      const rows = (await L.readDrawer(page)).rows;
      const row = rows.find((r) => r.kind === 'live' && /transaction/i.test(r.text));
      assert.ok(row, `the Transactions step is in the drawer: ${JSON.stringify(rows)}`);
      const id = row.id;
      const actionsBefore = L.actionRows(hooks).length;

      await L.clickDrawer(page, id, 'row-edit');
      await L.waitFor('the step is in a box', async () => (await L.readDrawer(page)).rows.find((r) => r.id === id)?.editing === true, 10_000);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(EDITED);
      await page.keyboard.press('Enter');

      await L.waitFor(
        "the draft holds the words as the author's edit, under the same id",
        () => {
          const d = draft();
          const i = (d.ids ?? []).indexOf(id);
          return i >= 0 && d.steps[i] === EDITED && (d.edited ?? []).includes(i);
        },
        60_000,
        summary,
      );
      const i = draft().ids.indexOf(id);
      await L.waitFor('the file shows it', fileIsDraft, 30_000, summary);
      assert.ok(
        fileText().split(/\r?\n/).includes(`${i + 2}. ${EDITED}`),
        `the line reads "${i + 2}. ${EDITED}":\n${fileText()}`,
      );
      await L.waitFor(
        'the panel lists the edit, made in the browser',
        () => edits().some((a) => a.source === 'toolbar' && a.summary.includes(EDITED)),
        15_000,
        summary,
      );
      await L.waitFor(
        'the drawer shows it, yours',
        async () => {
          const r = (await L.readDrawer(page)).rows.find((x) => x.id === id);
          return r?.text === EDITED && r.yours && !r.editing;
        },
        15_000,
        async () => JSON.stringify(await L.readDrawer(page)),
      );
      assert.equal(L.actionRows(hooks).length, actionsBefore, 'editing in the drawer records no action');

      // Two more actions: the Documents link, then Settings (a hash link on the same page).
      await clickTo('nav a[href="documents.html"]', /documents\.html/, 'the Documents click');
      await clickTo('nav a[href="#settings"]', /#settings$/, 'the Settings click');
      L.say(`two actions after the edit: ${summary()}`);

      const d = draft();
      const at = d.steps.indexOf(EDITED);
      assert.ok(at >= 0, `the edit is still in the draft: ${summary()}`);
      assert.equal(d.steps.filter((s) => s === EDITED).length, 1, 'once in the draft');
      assert.ok((d.edited ?? []).includes(at), `still the author's edit: ${JSON.stringify(d.edited)}`);
      assert.deepEqual(
        d.steps.filter((s) => /transaction/i.test(s)),
        [EDITED],
        `the model wrote no second step for the Transactions click:\n${summary()}`,
      );
      assert.equal(fileText().split(/\r?\n/).filter((l) => l.includes(EDITED)).length, 1, `once in the file:\n${fileText()}`);
      assert.ok(fileIsDraft(), `the file is the draft:\n${summary()}`);
      assert.ok(d.steps.some((s) => /document/i.test(s)), `the Documents click has a step: ${JSON.stringify(d.steps)}`);
      assert.ok(d.steps.some((s) => /settings/i.test(s)), `the Settings click has a step: ${JSON.stringify(d.steps)}`);
    }),
  );

  continuing(
    it("✕ on a misclick's step takes it out of the file and strikes its click; the row's Restore puts both back; deleted again, the next redraft leaves it out, and the panel's Restore puts it back after the step before it", async () => {
      recording();
      const d0 = draft();
      const idx = d0.steps.findIndex((s) => /settings/i.test(s));
      assert.ok(idx > 0, `a Settings step: ${summary()}`);
      const text = d0.steps[idx];
      const before = d0.steps[idx - 1];
      const settingsClick = L.actionRows(hooks).find((a) => /settings/i.test(a.summary));
      assert.ok(settingsClick, `the Settings click is in the action list: ${summary()}`);

      // ── ✕ in the drawer ──────────────────────────────────────────────
      await L.openDrawer(page);
      let id = d0.ids[idx];
      await L.clickDrawer(page, id, 'row-delete');
      await L.waitFor(
        'the step is deleted: out of the draft, struck in the panel with the actions it stood for',
        () => (state().deletedSteps ?? []).some((x) => x.id === id) && !draft().steps.includes(text) && struckWith(id).length > 0,
        60_000,
        summary,
      );
      await L.waitFor('out of the file', () => !fileText().includes(text) && fileIsDraft(), 30_000, summary);
      const struck = struckWith(id);
      L.say(`✕ "${text}" (${id}) struck: ${JSON.stringify(struck.map((a) => `${a.id} ${a.kind}: ${a.summary}`))}`);
      assert.ok(struck.every((a) => a.dropped), 'every action it took is struck');
      assert.ok(struck.some((a) => a.id === settingsClick.id), `the Settings click is among them: ${JSON.stringify(struck)}`);
      assert.ok(
        struck.every((a) => /settings/i.test(a.summary)),
        `and nothing but it — a delete drops only what the step stood for: ${JSON.stringify(struck)}`,
      );
      await L.waitFor(
        'the drawer strikes the row',
        async () => (await L.readDrawer(page)).rows.find((r) => r.id === id)?.kind === 'deleted',
        15_000,
        async () => JSON.stringify(await L.readDrawer(page)),
      );

      // ── The row's Restore ────────────────────────────────────────────
      await L.clickDrawer(page, id, 'row-restore');
      await L.waitFor(
        'restored: back in its place, its actions un-struck',
        () =>
          !(state().deletedSteps ?? []).some((x) => x.id === id) &&
          draft().steps[idx] === text &&
          struck.every((a) => state().actions.find((b) => b.id === a.id)?.dropped === false),
        60_000,
        summary,
      );
      await L.waitFor('back in the file', fileIsDraft, 30_000, summary);
      assert.equal(fileText().split(/\r?\n/).filter((l) => l.includes(text)).length, 1, `once:\n${fileText()}`);

      // ── ✕ again, then another action ─────────────────────────────────
      id = draft().ids[draft().steps.indexOf(text)];
      await L.waitFor(
        'the drawer shows it live again',
        async () => (await L.readDrawer(page)).rows.find((r) => r.id === id)?.kind === 'live',
        15_000,
        async () => JSON.stringify(await L.readDrawer(page)),
      );
      await L.clickDrawer(page, id, 'row-delete');
      await L.waitFor(
        'deleted again',
        () => (state().deletedSteps ?? []).some((x) => x.id === id) && !draft().steps.includes(text) && struckWith(id).length > 0,
        60_000,
        summary,
      );
      await L.waitFor('out of the file again', () => !fileText().includes(text) && fileIsDraft(), 30_000, summary);
      const struckAgain = struckWith(id).map((a) => a.id);
      await clickTo('nav a[href="dashboard.html"]', /dashboard\.html/, 'the Dashboard click');
      L.say(`after the Dashboard click: ${summary()}`);
      assert.ok(!draft().steps.includes(text), `the redraft did not bring it back:\n${summary()}`);
      assert.ok(!draft().steps.some((s) => /settings/i.test(s)), `nor a step for the Settings click in other words:\n${summary()}`);
      assert.ok(!fileText().includes(text), `nor the file:\n${fileText()}`);
      assert.ok((state().deletedSteps ?? []).some((x) => x.id === id), 'the panel still has it struck');
      for (const a of struckAgain) assert.equal(state().actions.find((b) => b.id === a)?.dropped, true, `${a} is still struck`);
      assert.ok(draft().steps.some((s) => /dashboard/i.test(s)), `the Dashboard click has a step: ${JSON.stringify(draft().steps)}`);

      // ── The panel's Restore: the draft moved on, so it goes back after the step before it ──
      await hooks.dispatchWebviewMessage({ type: 'recordDrop', id, dropped: false });
      await L.waitFor(
        'restored from the panel',
        () =>
          !(state().deletedSteps ?? []).some((x) => x.id === id) &&
          draft().steps.includes(text) &&
          struckAgain.every((a) => state().actions.find((b) => b.id === a)?.dropped === false),
        60_000,
        summary,
      );
      await L.waitFor('back in the file', fileIsDraft, 30_000, summary);
      const steps = draft().steps;
      const at = steps.indexOf(text);
      L.say(`after the panel's Restore: ${summary()}`);
      assert.equal(steps.filter((s) => s === text).length, 1, `once: ${JSON.stringify(steps)}`);
      if (steps.includes(before)) assert.equal(steps[at - 1], before, `after the step that was before it: ${JSON.stringify(steps)}`);
      const dash = steps.findIndex((s) => /dashboard/i.test(s));
      assert.ok(at < dash, `and before the Dashboard click's step: ${JSON.stringify(steps)}`);
    }),
  );

  continuing(
    it('+ between two steps adds a Verify there, exactly as typed; the drawer shows no lock', async () => {
      recording();
      await L.openDrawer(page);
      const id = draft().ids[draft().steps.indexOf(EDITED)];
      assert.ok(id, `the reworded step is in the draft: ${summary()}`);
      await L.clickDrawer(page, id, 'row-insert');
      await L.waitFor(
        'the step box, aimed below it',
        async () => /Goes after step/.test((await L.readToolbar(page))?.sub ?? ''),
        10_000,
        async () => JSON.stringify(await L.readToolbar(page)),
      );
      await page.keyboard.type(INSERTED);
      await page.keyboard.press('Enter');
      await L.waitFor(
        "the panel lists it as the author's step from the toolbar",
        () => (state()?.actions ?? []).some((a) => a.kind === 'step' && a.source === 'toolbar' && a.summary === INSERTED),
        60_000,
        summary,
      );
      await L.waitFor(
        'the draft holds it right after the reworded step',
        () => {
          const d = draft();
          const i = d.steps.indexOf(EDITED);
          return i >= 0 && d.steps[i + 1] === INSERTED && (d.authored ?? []).includes(i + 1);
        },
        120_000,
        summary,
      );
      await L.waitFor('the file shows it there', fileIsDraft, 30_000, summary);
      const lines = L.stepsOf(fileText());
      const at = lines.findIndex((s) => s.text === EDITED);
      assert.equal(lines[at + 1].text, INSERTED, `exactly as typed, right after it:\n${fileText()}`);
      assert.equal(fileText().split(/\r?\n/).filter((l) => l.includes(INSERTED)).length, 1, 'once');

      const d = await drawerShowsDraft('after the insert');
      L.say(`drawer after the insert: ${JSON.stringify(d)}`);
      assert.ok(d.rows.find((r) => r.text === INSERTED)?.yours, 'the inserted step shows yours');
      assert.ok(d.rows.find((r) => r.text === EDITED)?.yours, 'the reworded step shows yours');
      assert.equal(d.lock, false, 'no lock glyph anywhere in the drawer');
      const bar = await L.readToolbar(page);
      if (!/Typing hidden/.test(bar.sub)) assert.equal(d.lockInBar, false, `nor in the bar: ${JSON.stringify(bar)}`);
    }),
  );

  continuing(
    it('Stop from the toolbar: the file holds the edits, and it runs green', async () => {
      recording();
      await L.clickToolbar(page, 'stop', 30_000);
      await L.waitFor(
        'the recording ends and its steps are written',
        () => hooks.recordingState() === null && hooks.recordingReport() !== null,
        180_000,
        () => JSON.stringify({ phase: hooks.recordingState()?.phase, report: hooks.recordingReport() }),
      );
      const report = hooks.recordingReport();
      L.say(`report: ${JSON.stringify(report)}`);
      assert.equal(report.status, 'inserted', JSON.stringify(report));

      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      L.say(`recorded file:\n${text}`);
      const steps = L.stepsOf(text);
      steps.forEach((s, i) => assert.equal(s.n, i + 1, `steps are numbered 1..n in order:\n${text}`));
      assert.equal(steps[0].text, ANCHOR);
      const idx = (re) => steps.findIndex((s) => re.test(s.text));
      const edited = steps.findIndex((s) => s.text === EDITED);
      assert.ok(edited > 0, `the reworded step is in the result:\n${text}`);
      assert.equal(steps.filter((s) => s.text === EDITED).length, 1, 'once');
      assert.equal(steps[edited + 1]?.text, INSERTED, `the inserted Verify follows it:\n${text}`);
      assert.deepEqual(steps.filter((s) => /transaction/i.test(s.text)).map((s) => s.text), [EDITED, INSERTED]);
      const docs = idx(/document/i);
      const settings = idx(/settings/i);
      const dash = idx(/dashboard/i);
      assert.ok(edited < docs && docs < settings && settings < dash, `in the order they happened:\n${text}`);

      const params = L.parametersOf(text);
      assert.ok(params.some((p) => p.value === EMAIL), `## Parameters has the email: ${JSON.stringify(params)}`);
      const secret = params.find((p) => /^\$[A-Z][A-Z0-9_]*$/.test(p.value));
      assert.ok(secret, `## Parameters has the password as a $VAR: ${JSON.stringify(params)}`);
      assert.ok(!text.includes(SECRET), 'the literal password is not in the file');

      // ── It runs ──────────────────────────────────────────────────────
      await browser?.close().catch(() => {});
      browser = null;
      page = null;
      L.writeEnv(workspaceRoot, project.dir, { [secret.value.slice(1)]: SECRET });
      await doc.save();
      await L.openTest(hooks, file);
      await vscode.commands.executeCommand('testbench-native.restartSession');
      await L.sleep(1_500);
      await L.runAllToRest(hooks, 'the recorded test');
      const statuses = Object.fromEntries(hooks.tracker.snapshotFor(uri)?.statuses ?? []);
      L.say(`run: done=${hooks.lastDoneStatus()} statuses=${JSON.stringify(statuses)} error=${JSON.stringify(hooks.lastRunError())}`);
      assert.equal(hooks.lastDoneStatus(), 'passed', `the recorded test must pass:\n${text}\nerror: ${JSON.stringify(hooks.lastRunError())}`);
      for (const s of steps) {
        assert.ok(
          typeof statuses[s.line] === 'string' && statuses[s.line].startsWith('pass'),
          `step ${s.n} (line ${s.line}) "${s.text}" must pass; got ${statuses[s.line]}`,
        );
      }
    }),
  );

  it('deleting the step that typed the email — with the keyboard — takes `email` out of ## Parameters; the row\'s Restore puts both back', async () => {
    // A recording of its own, in a file of its own: drawer.md already holds
    // `email` in ## Parameters, written by the recording above.
    await L.openTest(hooks, file);
    await vscode.commands.executeCommand('testbench-native.restartSession'); // frees the DevTools port
    await browser?.close().catch(() => {});
    browser = null;
    file = path.join(project.testsDir, 'email.md');
    uri = vscode.Uri.file(file);
    const seedText = seed('Email');
    await recordSignIn('the email recording');
    L.say(`after the sign-in: ${summary()}`);

    const param = draft().parameters.find((p) => p.value === EMAIL);
    assert.ok(param, `the draft has the email as a parameter: ${summary()}`);
    assert.ok(L.parametersOf(fileText()).some((p) => p.name === param.name && p.value === EMAIL), `and the file:\n${fileText()}`);
    const uses = draft().steps.filter((s) => s.includes(`{{${param.name}}}`));
    assert.equal(uses.length, 1, `one step types {{${param.name}}}: ${summary()}`);
    const text = uses[0];
    const idx = draft().steps.indexOf(text);
    const id = draft().ids[idx];
    // Every row, not only `action` ones: the typing rides with the click.
    const emailActions = state().actions.filter((a) => /email/i.test(a.summary) || a.summary.includes(EMAIL));
    L.say(`deleting "${text}" (${id}); rows: ${JSON.stringify(state().actions.map((a) => `${a.id} ${a.kind}: ${a.summary}`))}`);

    await L.openDrawer(page);
    await L.focusDrawerRow(page, id);
    await page.keyboard.press('Delete');
    await L.waitFor(
      'the step is deleted and its parameter gone from the draft',
      () =>
        (state().deletedSteps ?? []).some((x) => x.id === id) &&
        !draft().steps.includes(text) &&
        !draft().parameters.some((p) => p.name === param.name),
      60_000,
      summary,
    );
    await L.waitFor(
      `${param.name} leaves ## Parameters in the file`,
      () => !L.parametersOf(fileText()).some((p) => p.name === param.name) && fileIsDraft(),
      30_000,
      summary,
    );
    const struck = struckWith(id);
    L.say(`deleting "${text}" struck: ${JSON.stringify(struck.map((a) => `${a.id} ${a.kind}: ${a.summary}`))}`);
    assert.ok(struck.length > 0, `the actions it stood for are struck: ${summary()}`);
    assert.ok(
      struck.every((a) => emailActions.some((e) => e.id === a.id)),
      `only the email field's actions: struck ${JSON.stringify(struck)}, the email field's ${JSON.stringify(emailActions)}`,
    );
    assert.ok(L.parametersOf(fileText()).some((p) => /^\$[A-Z][A-Z0-9_]*$/.test(p.value)), `the password's parameter stays:\n${fileText()}`);
    const focus = await L.barFocus(page);
    L.say(`focus after Delete: ${JSON.stringify(focus)}`);

    // Restore, from the struck row.
    await L.waitFor(
      'the drawer strikes the row',
      async () => (await L.readDrawer(page)).rows.find((r) => r.id === id)?.kind === 'deleted',
      15_000,
      async () => JSON.stringify(await L.readDrawer(page)),
    );
    await L.clickDrawer(page, id, 'row-restore');
    await L.waitFor(
      'the step and its parameter are back',
      () =>
        !(state().deletedSteps ?? []).some((x) => x.id === id) &&
        draft().steps[idx] === text &&
        draft().parameters.some((p) => p.name === param.name && p.value === EMAIL) &&
        struck.every((a) => state().actions.find((b) => b.id === a.id)?.dropped === false),
      60_000,
      summary,
    );
    await L.waitFor(
      'and in the file',
      () => fileIsDraft() && L.parametersOf(fileText()).some((p) => p.name === param.name && p.value === EMAIL),
      30_000,
      summary,
    );
    await L.draftSettled(hooks, 'after the Restore');
    await L.sleep(2_000); // a redraft the Restore set off, if any, has had its moment
    await L.draftSettled(hooks, 'after the Restore, again');
    L.say(`after restoring the email step: ${summary()}`);
    assert.deepEqual(
      draft().steps.filter((s) => /email/i.test(s)),
      [text],
      `the email field has one step, the restored one — no other step for its click:\n${summary()}`,
    );
    assert.equal(state().actions.filter((a) => a.dropped).length, 0, `nothing is left struck:\n${summary()}`);

    await vscode.commands.executeCommand('testbench-native.cancelRecording');
    await L.waitFor('the recording ends', () => hooks.recordingState() === null, 60_000);
    await L.waitFor('Cancel leaves the file as it was', () => fileText() === seedText, 15_000, fileText);
  });
});
