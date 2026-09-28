/**
 * Live end-to-end: editing, deleting and typing steps in the TEST FILE while
 * a recording writes into it (stories/testbench-record-edit-steps.md, "In the
 * file"; docs/specs/SPEC-record-steps.md §7.4, §7.6).
 *
 * Record at the cursor on a small test's first step, then — in the recording
 * browser, reached over DevTools (record-steps-live.cjs) — reject the cookie
 * banner, sign in and click menu links, while in the editor:
 *
 *  - a recorded line's words are changed and the cursor leaves it: the edit
 *    goes to the server (the next draft shows the step as the author's —
 *    what the panel shows as `yours`), survives two more actions, and is
 *    never written twice;
 *  - only a recorded line's number is changed: no edit, and the next draft
 *    gives the number back;
 *  - a recorded line is deleted (Delete Line): its step goes and the actions
 *    behind it are struck in the panel; the next action's redraft does not
 *    bring it back; Ctrl+Z (as many as it takes) puts it back, restored;
 *  - a new line is typed among the recorded ones, then Cancel: every recorded
 *    line goes — the reworded one too — the typed line stays, and the rest of
 *    the file is byte for byte as it was;
 *  - one more recording, a recorded line reworded, Stop: the file runs green.
 *
 * What nothing below this layer proves: the fast suite plays the server with
 * FakeApiClient and the server suites stub the model, so neither shows the
 * real editor's change events, the real server's edit-step/drop/restore and a
 * real model's redrafts agreeing about which line is which step.
 *
 * The model writes the words: assertions are strict about placement, count,
 * the author's text, parameters and struck actions, and tolerant about the
 * model's wording.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const L = require('./record-steps-live.cjs');

const EMAIL = 'demo@securebank.com';
const SECRET = 'password123';
const ANCHOR = 'Navigate to the baseUrl';
const TAIL = 'Click "Sign out"';
const REWORDED = 'Open Transactions from the main menu';
const TYPED = 'Verify the page shows "SecureBank"';
const REWORDED_2 = 'Click the Reject button in the cookie banner';

const FIXTURE = `# Edit file

## Config
- baseUrl: ${L.APP}/

## Steps
1. ${ANCHOR}
2. ${TAIL}
`;

/** What the file is for the second recording: the typed line kept, numbered. */
const SECOND = `# Edit file

## Config
- baseUrl: ${L.APP}/

## Steps
1. ${ANCHOR}
2. ${TYPED}
3. ${TAIL}
`;

describe('TestBench live — Record Steps: edit, delete and type steps in the test file while recording', function () {
  this.timeout(1_500_000);

  let hooks;
  let workspaceRoot;
  let project;
  let file;
  let uri;
  let browser = null;
  let page = null;
  /** The steps before the recorded block (the anchor's line and above). */
  let pre = [ANCHOR];

  before(async () => {
    ({ hooks, workspaceRoot } = await L.setUp());
    project = L.makeProject(workspaceRoot, 'record-live-edit-file', {
      cdpPort: await L.freePort(),
      files: { 'edit-file.md': FIXTURE },
    });
    file = path.join(project.testsDir, 'edit-file.md');
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
  const summary = () =>
    `${L.recordingSummary(hooks)}\nauthor lines: ${JSON.stringify(hooks.recordingAuthorLines())}\nnotices: ${JSON.stringify(
      hooks.recordingNotices(),
    )}\nfile:\n${fileText()}`;
  /** The file's steps: those before the block, the draft, then the tail — numbered 1..n. */
  const fileIsDraft = () => L.stepsRead(fileText(), [...pre, ...draft().steps, TAIL]);
  const struckWith = (id) => (state()?.actions ?? []).filter((a) => a.droppedWith === id);
  const edits = () => (state()?.actions ?? []).filter((a) => a.kind === 'edit');

  function recording() {
    assert.equal(state()?.phase, 'recording', `the recording must still run (an earlier test failed?): ${summary()}`);
  }

  async function settled(label) {
    await L.draftSettled(hooks, label);
    await L.waitFor(`the file shows the draft (${label})`, fileIsDraft, 30_000, summary);
  }

  async function clickTo(selector, urlRe, label) {
    const before = L.actionRows(hooks).length;
    await L.clickOn(page, selector);
    if (urlRe) await page.waitForURL(urlRe, { timeout: 30_000 });
    await L.waitFor(`${label} is recorded`, () => L.actionRows(hooks).length > before, 15_000, summary);
    await settled(label);
  }

  /** The test file in front, with keyboard focus — where `type` and `undo` go. */
  async function focusEditor() {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor?.document.uri.toString(), uri.toString(), 'the test file has focus');
    return editor;
  }

  /** 0-based line of the step reading `text` (number aside), or -1. */
  const lineOfStep = (text) => {
    const s = L.stepsOf(fileText()).find((x) => x.text === text);
    return s ? s.line - 1 : -1;
  };

  function cursorTo(editor, line, ch = 0) {
    editor.selection = new vscode.Selection(line, ch, line, ch);
  }

  /** Record at the step `anchor` reads, attach to the browser, sign in, and click Transactions. */
  async function recordSignInAndTransactions(anchor, label) {
    const { editor } = await L.openTest(hooks, file);
    const at = L.stepsOf(editor.document.getText()).find((s) => s.text === anchor);
    cursorTo(editor, at.line - 1);
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
    await clickTo('nav a[href="transactions.html"]', /transactions\.html/, `${label}: the Transactions click`);
    L.say(`${label}, after the Transactions click: ${summary()}`);
  }

  /** Change a recorded step's words in the editor (its number kept), then leave the line. */
  async function reword(from, to) {
    const editor = await focusEditor();
    const ln = lineOfStep(from);
    assert.ok(ln >= 0, `"${from}" is in the file:\n${fileText()}`);
    const lt = editor.document.lineAt(ln).text;
    const prefix = /^\d+\.\s+/.exec(lt)[0];
    editor.selection = new vscode.Selection(ln, prefix.length, ln, lt.length);
    await vscode.commands.executeCommand('type', { text: to });
    assert.equal(editor.document.lineAt(ln).text, `${prefix}${to}`, 'typed over the words');
    L.say(`reworded line ${ln + 1}: "${lt}" -> "${prefix}${to}"`);
    cursorTo(editor, 0); // it counts when the cursor leaves the line
    return ln;
  }

  /** The server took the reworded line: the draft shows it as the author's, under the line's step id. */
  async function editHeld(to, id, label) {
    await L.waitFor(
      `${label}: the draft shows the step as the author's edit`,
      () => {
        const d = draft();
        const i = d.steps.indexOf(to);
        return i >= 0 && (d.edited ?? []).includes(i) && (id === undefined || d.ids?.[i] === id);
      },
      60_000,
      summary,
    );
    await L.waitFor(
      `${label}: the panel lists the edit, made in the file`,
      () => edits().some((a) => a.source === 'editor' && a.summary.includes(to)),
      15_000,
      summary,
    );
    await L.waitFor(`${label}: the file is the draft`, fileIsDraft, 30_000, summary);
  }

  // ── The first recording ──────────────────────────────────────────────────

  it("a recorded line reworded in the file goes as an edit when the cursor leaves it; the next draft shows it the author's, and two actions later it is there once, with no second step for its click", async () => {
    pre = [ANCHOR];
    await recordSignInAndTransactions(ANCHOR, 'the first recording');
    const d0 = draft();
    const i0 = d0.steps.findIndex((s) => /transaction/i.test(s));
    assert.ok(i0 >= 0, `a step for the Transactions click: ${summary()}`);
    const from = d0.steps[i0];
    const id = d0.ids[i0];

    await reword(from, REWORDED);
    await editHeld(REWORDED, id, 'the reworded line');
    const author = hooks.recordingAuthorLines().find((l) => l.origin === 'edit');
    assert.ok(author && author.line.includes(REWORDED) && author.stepId === id, `the line stands for its step: ${JSON.stringify(hooks.recordingAuthorLines())}`);

    await clickTo('nav a[href="documents.html"]', /documents\.html/, 'the Documents click');
    await clickTo('nav a[href="dashboard.html"]', /dashboard\.html/, 'the Dashboard click');
    L.say(`two actions after the edit: ${summary()}`);

    const d = draft();
    assert.equal(d.steps.filter((s) => s === REWORDED).length, 1, `once in the draft: ${JSON.stringify(d.steps)}`);
    assert.ok((d.edited ?? []).includes(d.steps.indexOf(REWORDED)), `still the author's: ${JSON.stringify(d.edited)}`);
    assert.deepEqual(d.steps.filter((s) => /transaction/i.test(s)), [REWORDED], `no second step for the Transactions click:\n${summary()}`);
    assert.ok(!d.steps.includes(from), 'the model\'s words are not back');
    assert.equal(fileText().split(/\r?\n/).filter((l) => l.includes(REWORDED)).length, 1, `once in the file:\n${fileText()}`);
    assert.ok(!fileText().includes(from), `the model's words are nowhere in the file:\n${fileText()}`);
    assert.ok(fileIsDraft(), `the file is the draft:\n${summary()}`);
    assert.deepEqual(hooks.recordingNotices(), [], 'no warning: the edit was kept, not written over');
  });

  continuing(
    it("changing only a recorded line's number is no edit: nothing is sent, and the next draft gives the number back", async () => {
      recording();
      const text = draft().steps.find((s) => /document/i.test(s));
      assert.ok(text, `a Documents step: ${summary()}`);
      const editsBefore = edits().length;
      const editedBefore = JSON.stringify(draft().edited ?? []);
      const authorBefore = hooks.recordingAuthorLines().length;

      const editor = await focusEditor();
      const ln = lineOfStep(text);
      const digits = /^(\d+)\./.exec(editor.document.lineAt(ln).text)[1];
      editor.selection = new vscode.Selection(ln, 0, ln, digits.length);
      await vscode.commands.executeCommand('type', { text: '42' });
      assert.equal(editor.document.lineAt(ln).text, `42. ${text}`);
      cursorTo(editor, 0);
      await L.sleep(1_500); // the moment an edit would go; nothing should

      // The next action's draft.
      await clickTo('nav a[href="#profile"]', /#profile$/, 'the Profile click');
      L.say(`after the number change and the Profile click: ${summary()}`);
      assert.ok(fileIsDraft(), `the draft gave the number back:\n${summary()}`);
      assert.ok(!/^42\./m.test(fileText()), `no line keeps 42:\n${fileText()}`);
      assert.ok(draft().steps.includes(text), 'the step itself is untouched');
      assert.equal(edits().length, editsBefore, `no edit was sent: ${JSON.stringify(edits())}`);
      assert.equal(JSON.stringify(draft().edited ?? []), editedBefore, 'no step became the author\'s');
      assert.equal(hooks.recordingAuthorLines().length, authorBefore, `no line became the author's: ${JSON.stringify(hooks.recordingAuthorLines())}`);
    }),
  );

  continuing(
    it('deleting a whole recorded line drops its step and the actions behind it; the next redraft does not bring it back; Ctrl+Z restores it', async () => {
      recording();
      const d0 = draft();
      const idx = d0.steps.findLastIndex((s) => /dashboard/i.test(s));
      assert.ok(idx >= 0, `a Dashboard step: ${summary()}`);
      const text = d0.steps[idx];
      const id = d0.ids[idx];
      const dashClick = L.actionRows(hooks).findLast((a) => /dashboard/i.test(a.summary));
      assert.ok(dashClick, `the Dashboard click is in the action list: ${summary()}`);

      const editor = await focusEditor();
      cursorTo(editor, lineOfStep(text), 2);
      await vscode.commands.executeCommand('editor.action.deleteLines');
      assert.ok(!fileText().includes(text), 'the line is gone');
      await L.waitFor(
        'the step is deleted: out of the draft, the actions it stood for struck',
        () => (state().deletedSteps ?? []).some((x) => x.id === id) && !draft().steps.includes(text) && struckWith(id).length > 0,
        60_000,
        summary,
      );
      await L.waitFor('the file is the draft without it', fileIsDraft, 30_000, summary);
      const struck = struckWith(id);
      L.say(`deleting line "${text}" (${id}) struck: ${JSON.stringify(struck.map((a) => `${a.id} ${a.kind}: ${a.summary}`))}`);
      assert.ok(struck.every((a) => a.dropped));
      assert.ok(struck.some((a) => a.id === dashClick.id), `the Dashboard click is among them: ${JSON.stringify(struck)}`);
      assert.ok(struck.every((a) => /dashboard/i.test(a.summary)), `and nothing but it: ${JSON.stringify(struck)}`);

      // Another action: the redraft leaves it out.
      await clickTo('nav a[href="#settings"]', /#settings$/, 'the Settings click');
      L.say(`after the delete and the Settings click: ${summary()}`);
      assert.ok(!draft().steps.includes(text), `the redraft did not bring it back:\n${summary()}`);
      assert.ok(!fileText().includes(text), `nor the file:\n${fileText()}`);
      assert.ok((state().deletedSteps ?? []).some((x) => x.id === id), 'still struck in the panel');
      for (const a of struck) assert.equal(state().actions.find((b) => b.id === a.id)?.dropped, true, `${a.id} is still struck`);

      // Ctrl+Z, as many times as it takes to bring the line back: the
      // recording's writes since the delete are their own undo step.
      await focusEditor();
      const states = [];
      for (let i = 0; i < 5 && !fileText().includes(text); i++) {
        await vscode.commands.executeCommand('undo');
        await L.waitFor('the undo lands', () => fileText().includes(text), 2_000).catch(() => {});
        states.push(fileText());
        L.say(`after Ctrl+Z ${i + 1}:\n${fileText()}`);
      }
      assert.ok(fileText().includes(text), `Ctrl+Z brought the line back (${states.length} undos):\n${states.join('\n---\n')}`);
      await L.waitFor(
        'the delete is restored: the step back, its actions un-struck',
        () =>
          !(state().deletedSteps ?? []).some((x) => x.id === id) &&
          draft().steps.includes(text) &&
          struck.every((a) => state().actions.find((b) => b.id === a.id)?.dropped === false),
        60_000,
        summary,
      );
      await L.draftSettled(hooks, 'after the restore');
      await L.waitFor('the file is the draft, every step once', fileIsDraft, 30_000, summary);
      L.say(`after Ctrl+Z: ${summary()}`);
      const steps = draft().steps;
      assert.equal(steps.filter((s) => s === text).length, 1, 'the restored step once');
      assert.ok(steps.some((s) => /settings/i.test(s)), `the Settings click still has its step: ${JSON.stringify(steps)}`);
      assert.ok(steps.indexOf(text) < steps.findIndex((s) => /settings/i.test(s)), `back in its place, before the later click's step: ${JSON.stringify(steps)}`);
      assert.equal(state().actions.filter((a) => a.dropped).length, 0, `nothing is left struck:\n${summary()}`);
      assert.deepEqual(hooks.recordingNotices(), [], 'the file was never given up on');
    }),
  );

  continuing(
    it('Cancel takes out every recorded line — the reworded one too — keeps the line typed as a new step, and leaves the rest of the file byte for byte', async () => {
      recording();
      // A step of the author's, typed under the reworded line.
      const editor = await focusEditor();
      const ln = lineOfStep(REWORDED);
      assert.ok(ln >= 0, `the reworded line is in the file:\n${fileText()}`);
      const lt = editor.document.lineAt(ln).text;
      const n = Number(/^(\d+)\./.exec(lt)[1]) + 1;
      cursorTo(editor, ln, lt.length);
      await vscode.commands.executeCommand('type', { text: '\n' });
      await vscode.commands.executeCommand('type', { text: `${n}. ${TYPED}` });
      cursorTo(editor, 0);
      await L.waitFor(
        'the typed line goes to the recording and a draft holds it',
        () => hooks.recordingAuthorLines().some((l) => l.inDraft && l.origin !== 'edit' && l.line.includes(TYPED)),
        120_000,
        summary,
      );
      await L.waitFor(
        'right after the reworded step',
        () => {
          const d = draft();
          return d.steps[d.steps.indexOf(REWORDED) + 1] === TYPED;
        },
        60_000,
        summary,
      );
      await L.waitFor('the file is the draft', fileIsDraft, 30_000, summary);
      L.say(`before Cancel: ${summary()}`);

      await vscode.commands.executeCommand('testbench-native.cancelRecording');
      await L.waitFor(
        'the recording ends, cancelled',
        () => hooks.recordingState() === null && hooks.recordingReport() !== null,
        60_000,
        () => JSON.stringify(hooks.recordingReport()),
      );
      assert.equal(hooks.recordingReport().status, 'cancelled', JSON.stringify(hooks.recordingReport()));
      await L.waitFor(
        'every recorded line is out',
        () => L.stepsOf(fileText()).length === 3,
        15_000,
        fileText,
      );
      const text = fileText();
      L.say(`after Cancel:\n${text}`);
      const lines = text.split(/\r?\n/);
      assert.equal(lines.filter((l) => l.includes(TYPED)).length, 1, `the typed line stays, once:\n${text}`);
      assert.ok(!text.includes(REWORDED), `the reworded line is taken out with the rest:\n${text}`);
      const at = lines.findIndex((l) => l.includes(TYPED));
      assert.equal(lines[at], `${n}. ${TYPED}`, 'as the author typed it, their number with it');
      assert.equal(lines[at - 1], `1. ${ANCHOR}`, 'where it now sits: after the anchor');
      assert.equal(
        [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n'),
        FIXTURE,
        `and the rest of the file is byte for byte as before:\n${text}`,
      );
    }),
  );

  // ── The second recording: an edit, Stop, and the file runs ─────────────

  it('one more recording: a recorded line reworded in the file, Stop, and the recorded file runs green', async () => {
    // The file as the last test left it, numbered: set here, so this test
    // stands on its own if that one failed.
    const editor = await focusEditor();
    const whole = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
    assert.ok(await editor.edit((b) => b.replace(whole, SECOND)));
    await editor.document.save();
    await browser?.close().catch(() => {});
    browser = null;
    page = null;
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await L.sleep(1_000);

    pre = [ANCHOR, TYPED];
    await recordSignInAndTransactions(TYPED, 'the second recording');
    const d0 = draft();
    const i0 = d0.steps.findIndex((s) => /cookie|reject/i.test(s));
    assert.ok(i0 >= 0, `a step for the cookie banner: ${summary()}`);
    await reword(d0.steps[i0], REWORDED_2);
    await editHeld(REWORDED_2, d0.ids[i0], 'the reworded cookie line');

    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await L.waitFor(
      'the recording ends and its steps are written',
      () => hooks.recordingState() === null && hooks.recordingReport() !== null,
      180_000,
      () => JSON.stringify({ phase: hooks.recordingState()?.phase, report: hooks.recordingReport() }),
    );
    assert.equal(hooks.recordingReport().status, 'inserted', JSON.stringify(hooks.recordingReport()));

    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    L.say(`recorded file:\n${text}`);
    const steps = L.stepsOf(text);
    steps.forEach((s, i) => assert.equal(s.n, i + 1, `steps are numbered 1..n in order:\n${text}`));
    assert.deepEqual(steps.slice(0, 2).map((s) => s.text), [ANCHOR, TYPED], 'the steps before the cursor are untouched');
    assert.equal(steps[2].text, REWORDED_2, `the reworded line is the first recorded step, in the author's words:\n${text}`);
    assert.equal(text.split(/\r?\n/).filter((l) => l.includes(REWORDED_2)).length, 1, 'once');
    assert.equal(steps[steps.length - 1].text, TAIL, 'the later step is still last');
    assert.ok(steps.some((s) => /transaction/i.test(s.text)), `the Transactions click has its step:\n${text}`);
    const params = L.parametersOf(text);
    assert.ok(params.some((p) => p.value === EMAIL), `## Parameters has the email: ${JSON.stringify(params)}`);
    const secret = params.find((p) => /^\$[A-Z][A-Z0-9_]*$/.test(p.value));
    assert.ok(secret, `## Parameters has the password as a $VAR: ${JSON.stringify(params)}`);
    assert.ok(!text.includes(SECRET), 'the literal password is not in the file');

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
  });
});
