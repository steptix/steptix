/**
 * Live end-to-end: extending an existing test with Record Steps
 * (docs/specs/SPEC-record-steps.md §3.3, §7.1, §7.6; stories/testbench-record-toolbar.md).
 *
 * The way the spec says a test is extended: a breakpoint after sign-in, Run to
 * it, the cursor on the last step that ran, Record Steps. Then, in the
 * recording browser (reached over DevTools, record-steps-live.cjs): click a
 * menu link; type a step of the author's own into the test file under the
 * recorded block and move the cursor off it; click a second link; Back; Reload;
 * Stop. The steps must land after the cursor's line with the later step
 * renumbered, the typed line kept exactly once with the next recorded step
 * after it, Back and Reload written as steps, and the whole test must replay
 * green.
 *
 * Then Cancel pressed in the browser — the toolbar's Cancel, then Discard —
 * must leave the file byte for byte as it was.
 *
 * What nothing below this layer proves: that a real model's draft, a real
 * editor's change events and the real server's add-step/lock handling agree
 * on where a typed line sits (the fast suite scripts the server's half, the
 * server suite stubs the model); that the server's own Back/Reload detection
 * fires for a real browser's history; and that the steps it all produces run.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const L = require('./record-steps-live.cjs');

const SECRET = 'password123';
const TYPED = 'Verify the page heading says "Transaction History"';

const FIXTURE = `# Extend

## Config
- baseUrl: ${L.APP}/

## Parameters
- email: demo@securebank.com
- password: $PASSWORD

## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter {{email}} into the Email address field
4. Enter {{password}} into the Password field
5. Click the Sign In button
6. Click "Sign out"
`;

describe('TestBench live — Record Steps extends an existing test', function () {
  this.timeout(1_500_000);

  let hooks;
  let workspaceRoot;
  let project;
  let file;
  let uri;
  let browser = null;

  before(async () => {
    ({ hooks, workspaceRoot } = await L.setUp());
    project = L.makeProject(workspaceRoot, 'record-live-extend', {
      cdpPort: await L.freePort(),
      files: { 'extend.md': FIXTURE },
      extraEnv: { PASSWORD: SECRET },
    });
    file = path.join(project.testsDir, 'extend.md');
    uri = vscode.Uri.file(file);
    L.say(`project ${project.dir}, recording browser DevTools on :${project.cdpPort}`);
  });

  // A test that fails mid-recording leaves it running, and the next test's
  // Record would then find it already recording and drive THAT one — measured:
  // a failed first test made the Cancel test cancel the wrong recording.
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed' || !hooks?.recordingState()) return;
    await vscode.commands.executeCommand('testbench-native.cancelRecording');
    await L.waitFor('the leftover recording ends', () => hooks.recordingState() === null, 30_000).catch(() => {});
  });

  after(async () => {
    if (hooks?.recordingState()) await vscode.commands.executeCommand('testbench-native.cancelRecording');
    if (vscode.debug.breakpoints.length > 0) vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    await browser?.close().catch(() => {});
    try {
      await vscode.commands.executeCommand('testbench-native.restartSession');
    } catch {
      /* best effort */
    }
    if (project) fs.rmSync(project.dir, { recursive: true, force: true });
  });

  function editorOf() {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    assert.ok(editor, 'extend.md is not in an editor');
    return editor;
  }

  function putCursorOn(line) {
    const editor = editorOf();
    const pos = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
  }

  async function startRecording(label) {
    void vscode.commands.executeCommand('testbench-native.recordSteps');
    await L.waitFor(
      `${label}: the recording starts`,
      () => hooks.recordingState()?.phase === 'recording',
      120_000,
      () => JSON.stringify({ phase: hooks.recordingState()?.phase, refusal: hooks.recordingRefusal(), report: hooks.recordingReport() }),
    );
    if (!browser) browser = await L.connectBrowser(project.cdpPort);
  }

  it('records after the cursor line from a breakpoint, keeps a step typed in the file once with the next action after it, and writes Back and Reload', async () => {
    const { editor } = await L.openTest(hooks, file);
    const signIn = L.lineOf(FIXTURE, /^5\. Click the Sign In button/);
    const signOut = L.lineOf(FIXTURE, /^6\. Click "Sign out"/);

    // ── Run to a breakpoint after sign-in ────────────────────────────────
    if (vscode.debug.breakpoints.length > 0) vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(signOut - 1, 0)), true)]);
    await L.waitFor('TestBench sees the breakpoint', () => hooks.tracker.breakpoints(uri).has(signOut), 10_000);
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await L.sleep(1_000);
    hooks.clearRunError();
    void vscode.commands.executeCommand('testbench-native.runAll');
    await L.waitFor('the run starts', () => hooks.isRunning(), 60_000);
    await L.waitFor(
      'the run parks at the breakpoint on "Click Sign out"',
      () => hooks.tracker.snapshotFor(uri)?.breakpointStop === signOut && (hooks.isParkedAtPause(uri) || hooks.isStepPaused()),
      600_000,
      () => JSON.stringify({ running: hooks.isRunning(), bp: hooks.tracker.snapshotFor(uri)?.breakpointStop, done: hooks.lastDoneStatus(), err: hooks.lastRunError() }),
    );
    L.say(`parked at line ${signOut}`);

    // ── Cursor on the last step that ran; Record ─────────────────────────
    putCursorOn(signIn);
    await startRecording('record from the breakpoint');
    const page = await L.pageAt(browser, `${L.APP}/dashboard`);
    await L.waitFor('the toolbar is in the page', async () => (await L.readToolbar(page))?.status.startsWith('REC'));

    // ── A menu link ────────────────────────────────────────────────────────
    await L.clickOn(page, 'nav a[href="transactions.html"]');
    await page.waitForURL(/transactions\.html/, { timeout: 30_000 });
    await L.draftSettled(hooks, 'the Transactions click');
    await L.waitFor(
      'the draft is written into the file under step 5',
      () => (hooks.recordingHighlight() ?? []).length > 0 && /transaction/i.test(editor.document.lineAt(signIn).text),
      30_000,
      () => editor.document.getText(),
    );

    // ── A step of the author's, typed under the recorded block ──────────
    const highlighted = hooks.recordingHighlight();
    const lastRecorded = Math.max(...highlighted); // 1-based
    const lastText = editor.document.lineAt(lastRecorded - 1).text;
    const nextN = Number((/^(\d+)\./.exec(lastText) ?? [])[1]) + 1;
    await vscode.window.showTextDocument(editor.document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const eol = new vscode.Position(lastRecorded - 1, lastText.length);
    editorOf().selection = new vscode.Selection(eol, eol);
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: `${nextN}. ${TYPED}` });
    L.say(`typed "${nextN}. ${TYPED}" under line ${lastRecorded}`);
    // It counts when the cursor LEAVES the line.
    putCursorOn(1);
    await L.waitFor(
      'the typed line goes to the recording and a draft holds it',
      () => hooks.recordingAuthorLines().some((l) => l.inDraft && l.line.includes(TYPED)),
      120_000,
      () => JSON.stringify(hooks.recordingAuthorLines()),
    );
    const stepRow = (hooks.recordingState()?.actions ?? []).find((a) => a.kind === 'step');
    assert.equal(stepRow?.source, 'editor', `the panel lists it as the author's step from the editor: ${JSON.stringify(stepRow)}`);

    // ── A second link, Back, Reload ─────────────────────────────────────
    await L.clickOn(page, 'nav a[href="documents.html"]');
    await page.waitForURL(/documents\.html/, { timeout: 30_000 });
    await L.draftSettled(hooks, 'the Documents click');
    await page.goBack();
    await page.waitForURL(/transactions\.html/, { timeout: 30_000 });
    await L.waitFor('Back is recorded', () => L.actionRows(hooks).some((a) => a.kind === 'back'), 15_000, () => JSON.stringify(L.actionRows(hooks)));
    await page.reload();
    await L.waitFor('Reload is recorded', () => L.actionRows(hooks).some((a) => a.kind === 'reload'), 15_000, () => JSON.stringify(L.actionRows(hooks)));
    await L.draftSettled(hooks, 'Back and Reload');
    L.say(`actions: ${JSON.stringify(L.actionRows(hooks).map((a) => `${a.kind}: ${a.summary}`))}`);

    // ── Stop (TestBench's command) ───────────────────────────────────────
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await L.waitFor(
      'the recording ends and its steps are written',
      () => hooks.recordingState() === null && hooks.recordingReport() !== null,
      180_000,
      () => JSON.stringify({ phase: hooks.recordingState()?.phase, report: hooks.recordingReport() }),
    );
    assert.equal(hooks.recordingReport().status, 'inserted', JSON.stringify(hooks.recordingReport()));

    const text = editor.document.getText();
    L.say(`extended file:\n${text}`);
    const steps = L.stepsOf(text);
    steps.forEach((s, i) => assert.equal(s.n, i + 1, `steps are numbered 1..n in order:\n${text}`));
    // Everything before the cursor's line is as it was.
    assert.deepEqual(
      steps.slice(0, 5).map((s) => `${s.n}. ${s.text}`),
      L.stepsOf(FIXTURE).slice(0, 5).map((s) => `${s.n}. ${s.text}`),
      'steps 1-5 are untouched',
    );
    // The later step, renumbered, is last.
    const last = steps[steps.length - 1];
    assert.equal(last.text, 'Click "Sign out"', `the step after the insertion is still last:\n${text}`);
    assert.ok(last.n > 6, `and renumbered after the inserted steps (got ${last.n})`);
    const inserted = steps.slice(5, -1);
    const at = (re) => inserted.findIndex((s) => re.test(s.text));
    const menu = at(/transaction/i);
    const typed = inserted.findIndex((s) => s.text === TYPED);
    const docs = at(/document/i);
    const back = at(/\bback\b/i);
    const reload = at(/reload|refresh/i);
    for (const [what, i] of Object.entries({ menu, typed, docs, back, reload })) {
      assert.ok(i >= 0, `no inserted step for ${what}:\n${text}`);
    }
    assert.equal(
      text.split(/\r?\n/).filter((l) => l.includes(TYPED)).length,
      1,
      `the typed line is in the file exactly once:\n${text}`,
    );
    assert.ok(menu < typed, `the typed line sits after the step recorded before it:\n${text}`);
    assert.ok(typed < docs, `the next recorded action's step lands AFTER the typed line:\n${text}`);
    assert.ok(docs < back && back <= reload, `Back and Reload follow, in order:\n${text}`);
    await editor.document.save();
  });

  it('Cancel from the browser (Cancel, then Discard) leaves the file byte for byte as it was', async () => {
    const { editor } = await L.openTest(hooks, file);
    const before = editor.document.getText();
    const lastStep = L.stepsOf(before).pop();
    assert.ok(lastStep, 'the file has steps to record after');
    putCursorOn(lastStep.line);

    await startRecording('record to cancel');
    const page = await L.pageAt(browser, `${L.APP}/transactions`);
    await L.waitFor('the toolbar is in the page', async () => (await L.readToolbar(page))?.status.startsWith('REC'));
    await L.clickOn(page, 'nav a[href="documents.html"]');
    await page.waitForURL(/documents\.html/, { timeout: 30_000 });
    await L.draftSettled(hooks, 'the click to cancel');
    await L.waitFor('the draft is in the file', () => editor.document.getText() !== before, 30_000);

    await L.clickToolbar(page, 'cancel');
    await L.waitFor('Cancel asks first', async () => /discard/i.test((await L.readToolbar(page))?.all ?? ''), 10_000);
    await L.clickToolbar(page, 'discard');
    await L.waitFor(
      'the recording ends as cancelled in the browser',
      () => hooks.recordingState() === null && hooks.recordingReport() !== null,
      60_000,
      () => JSON.stringify(hooks.recordingReport()),
    );
    const report = hooks.recordingReport();
    assert.equal(report.status, 'cancelled', JSON.stringify(report));
    assert.equal(report.by, 'browser', `a Cancel pressed in the browser says so: ${JSON.stringify(report)}`);
    assert.deepEqual(report.messages, [], 'a browser Cancel ends quietly, with no notification');
    await L.waitFor('the draft is taken back out', () => editor.document.getText() === before, 15_000);
    assert.equal(editor.document.getText(), before, 'the file is byte for byte as it was');
  });

  it('the extended test replays green', async () => {
    const { editor } = await L.openTest(hooks, file);
    if (vscode.debug.breakpoints.length > 0) vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    if (editor.document.isDirty) await editor.document.save();
    await browser?.close().catch(() => {});
    browser = null;
    const text = editor.document.getText();
    const steps = L.stepsOf(text);
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await L.sleep(1_500);
    await L.runAllToRest(hooks, 'the extended test');
    const statuses = Object.fromEntries(hooks.tracker.snapshotFor(uri)?.statuses ?? []);
    L.say(`replay: done=${hooks.lastDoneStatus()} statuses=${JSON.stringify(statuses)} error=${JSON.stringify(hooks.lastRunError())}`);
    assert.equal(hooks.lastDoneStatus(), 'passed', `the extended test must pass:\n${text}\nerror: ${JSON.stringify(hooks.lastRunError())}`);
    for (const s of steps) {
      assert.ok(
        typeof statuses[s.line] === 'string' && statuses[s.line].startsWith('pass'),
        `step ${s.n} (line ${s.line}) "${s.text}" must pass; got ${statuses[s.line]}`,
      );
    }
  });
});
