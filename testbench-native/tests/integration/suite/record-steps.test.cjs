/**
 * Record Steps, the TestBench half (stories/testbench-record-steps.md), in a
 * real VS Code extension host against a FakeApiClient that plays the server.
 *
 * What only a host can prove, and so what this file is for:
 *
 *  - the wire as the extension sends it: the start body (`testFilePath`,
 *    `target` with the document and the cursor's line, `config` on the
 *    session's FIRST request only) and every control (`stop` with `dropped`,
 *    `check` / `cancel-check`, `cancel`);
 *  - the live state the panel and the status bar are fed from, as frames
 *    arrive, including a ✕ dropped from the panel's own message;
 *  - the result landing as ONE editor edit, so one undo restores the file;
 *  - the drafts in the file never overwriting what the recording cannot prove
 *    it wrote, under the change events only a host sends: File: Revert, a
 *    reload from disk, a line-ending change, undo and redo, typing and Tab at
 *    a later step's start, End+Enter, a rename, and a window closing;
 *  - Record's relationship to runs: refused while one executes, and a paused
 *    one ended first.
 *
 * The text decisions — where the steps go, the renumbering, the parameter
 * merge — are pinned without a host in tests/record-steps.test.js.
 *
 * Fixtures are written at runtime (`*.tmp.md`, like the viewport suite) and
 * never saved over; each case reverts its buffer.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');

const FILE = 'record-steps.tmp.md';
const NEW_NAME = 'record-new.tmp';
const NEW_FILE = `${NEW_NAME}.md`;

/**
 * 1-based: `## Steps` 9, main flow 10-12, blank 13, `### Sign in` 14, body
 * 16-17. `## Parameters` holds `email` only.
 */
const FIXTURE = [
  '# Record fixture',
  '',
  '## Config',
  '- baseUrl: https://example.test/',
  '',
  '## Parameters',
  '- email: demo@example.test',
  '',
  '## Steps',
  '1. Navigate to login.html',
  '2. Click Sign in',
  '3. Open the dashboard',
  '',
  '### Sign in',
  '',
  '1. Type {{email}} into the Email field',
  '2. Click Submit',
  '',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // transient
    }
    await sleep(25);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const stepLines = (text) => text.split(/\r?\n/).filter((l) => /^\d+\.\s+\S/.test(l));

describe('TestBench Record Steps', function () {
  this.timeout(30_000);

  /** @type {FakeApiClient} */
  let fake;
  let hooks;
  const fixturePath = path.resolve(FIXTURES_DIR, FILE);
  const newPath = path.resolve(FIXTURES_DIR, NEW_FILE);
  const uri = vscode.Uri.file(fixturePath);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
    fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
  });

  after(() => {
    fs.rmSync(fixturePath, { force: true });
    fs.rmSync(newPath, { force: true });
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    // Discards every controller, which also cancels a recording a failed case
    // left behind — so each case starts with a fresh session record too.
    hooks.setApiClientFactory(() => fake);
    await hooks.recordingSettled();
    hooks.clearRunError();
  });

  afterEach(async () => {
    // A case that failed midway must not leave a recording for the next.
    if (hooks.recordingState() !== null) {
      await vscode.commands.executeCommand('testbench-native.cancelRecording');
      fake.endRecord();
      await hooks.recordingSettled();
    }
    // Never save: revert whatever the case did to the buffer.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(fs.readFileSync(fixturePath, 'utf8'), FIXTURE, 'the fixture on disk must not change');
  });

  async function openFixture() {
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    await waitFor('active file detected as test file', () => hooks.tracker.snapshot().isTestFile);
    return vscode.window.activeTextEditor;
  }

  function cursorAt(editor, line) {
    const pos = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
  }

  /** Start a recording at `line` and wait for the stream to open. */
  async function recordAt(editor, line) {
    cursorAt(editor, line);
    const before = fake.recordRequests.length;
    await vscode.commands.executeCommand('testbench-native.recordSteps');
    await waitFor('record stream open', () => fake.recordRequests.length === before + 1 && fake.hasActiveRecordStream);
    return fake.recordRequests[before];
  }

  /** Cancel the recording in flight and wait for it to be over. */
  async function cancelRecording() {
    await vscode.commands.executeCommand('testbench-native.cancelRecording');
    await hooks.recordingSettled();
  }

  it('records at the cursor: actions stream in, Stop sends dropped, the result is one undo step', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    const mark = hooks.hostMessageCount();

    const req = await recordAt(editor, 11);
    assert.equal(fake.recordSessionIds[0], uri.fsPath, 'the session is the test\'s own — its file path');
    assert.equal(req.testFilePath, uri.fsPath);
    assert.deepEqual(req.target, { mode: 'cursor', fileText: original, cursorLine: 11 });
    assert.deepEqual(req.config, { baseUrl: 'https://example.test/' }, 'the session\'s first request carries config');
    assert.equal(hooks.recordingState().phase, 'starting');

    fake.pushRecord({ type: 'record:started', url: 'https://example.test/login.html', title: 'Login' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'type', summary: 'Typed into Email', atMs: 1200 });
    fake.pushRecord({ type: 'record:action', id: 'a2', kind: 'click', summary: 'Clicked link "Reports"', atMs: 2400 });
    fake.pushRecord({ type: 'record:action', id: 'a3', kind: 'click', summary: 'Clicked button "Sign in"', atMs: 3100, tab: 'popup-1' });
    await waitFor('three actions', () => hooks.recordingState()?.actions.length === 3);
    const state = hooks.recordingState();
    assert.equal(state.phase, 'recording');
    assert.equal(state.startedUrl, 'https://example.test/login.html');
    assert.equal(state.file, FILE);
    assert.deepEqual(state.actions[2], {
      id: 'a3',
      kind: 'click',
      // No `action` flag on the frame: read as an action, as before the flag.
      action: true,
      summary: 'Clicked button "Sign in"',
      atMs: 3100,
      tab: 'popup-1',
      dropped: false,
    });
    assert.equal(hooks.recordingStatusText(), '● Recording — 3 actions');
    // The panel was told, with the whole list.
    const posted = hooks.hostMessagesSince(mark).filter((m) => m.type === 'recording');
    assert.ok(posted.length > 0, 'no recording message reached the panel');
    assert.equal(posted[posted.length - 1].state.actions.length, 3);

    // The ✕ on "Reports", from the panel's own message.
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 'a2', dropped: true });
    assert.equal(hooks.recordingState().actions.find((a) => a.id === 'a2').dropped, true);
    assert.equal(hooks.recordingStatusText(), '● Recording — 2 actions');
    // …and put back, and dropped again. Each ✕ is sent at once (decision 9:
    // the server redrafts without it), and Stop still sends the last word.
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 'a2', dropped: false });
    assert.equal(hooks.recordingState().actions.find((a) => a.id === 'a2').dropped, false);
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 'a2', dropped: true });

    fake.recordControlImpl = async (_sessionId, body) => {
      if (body.action === 'stop') fake.pushRecord({ type: 'record:writing' });
    };
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    assert.deepEqual(
      fake.recordControlCalls.map((c) => c.body),
      [
        { action: 'drop', id: 'a2' },
        { action: 'restore', id: 'a2' },
        { action: 'drop', id: 'a2' },
        { action: 'stop', dropped: ['a2'] },
      ],
    );
    assert.ok(fake.recordControlCalls.every((c) => c.sessionId === uri.fsPath));
    await waitFor('finishing', () => hooks.recordingState()?.phase === 'finishing');
    assert.equal(hooks.recordingStatusText(), '$(loading~spin) Finishing…');
    // After Stop only `cancel` does anything server-side, so the rows freeze.
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 'a1', dropped: true });
    assert.equal(fake.recordControlCalls.length, 4, 'no drop is sent while finishing');
    assert.equal(hooks.recordingState().actions.find((a) => a.id === 'a1').dropped, false);

    fake.pushRecord({
      type: 'record:result',
      steps: ['Type {{email}} into the Email field', 'Type {{password}} into the Password field', 'Click the Sign in button'],
      parameters: [
        { name: 'email', value: 'demo@example.test' },
        { name: 'password', value: '$PASSWORD' },
      ],
      notes: ['The Sign in button has no label; the step names it by its text.'],
    });
    fake.pushRecord({ type: 'done', status: 'passed' });
    fake.endRecord();
    await hooks.recordingSettled();
    assert.equal(hooks.recordingState(), null, 'the Recording block comes down');
    assert.equal(hooks.recordingStatusText(), null);

    const after = editor.document.getText();
    assert.deepEqual(stepLines(after), [
      '1. Navigate to login.html',
      '2. Click Sign in',
      '3. Type {{email}} into the Email field',
      '4. Type {{password}} into the Password field',
      '5. Click the Sign in button',
      '6. Open the dashboard',
      // The section body is its own flow and is not renumbered.
      '1. Type {{email}} into the Email field',
      '2. Click Submit',
    ]);
    // `email` was already there with this value; `password` is new, as a reference.
    assert.match(after, /## Parameters\n- email: demo@example\.test\n- password: \$PASSWORD\n\n## Steps/);
    assert.equal(editor.document.isDirty, true, 'the edit lands on the buffer, unsaved');
    // The inserted steps are selected (the parameter line shifts them down one).
    assert.equal(editor.selection.start.line + 1, 13);
    assert.equal(editor.selection.end.line + 1, 15);

    const report = hooks.recordingReport();
    assert.equal(report.status, 'inserted');
    assert.equal(report.steps, 3);
    assert.match(report.messages[0].text, /Recorded 3 steps into record-steps\.tmp\.md; added password to ## Parameters\. The Sign in button has no label/);
    // The fixture .env has no PASSWORD, so the next Run would fail — said now.
    assert.ok(
      report.messages.some((m) => m.level === 'warn' && /\{\{password\}\} reads \$PASSWORD/.test(m.text)),
      JSON.stringify(report.messages),
    );

    await vscode.commands.executeCommand('undo');
    await waitFor('one undo restores the original', () => editor.document.getText() === original);
  });

  it('drafts stream into Steps so far and into the file; a late, older draft changes neither; the result goes over the last draft', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    const mark = hooks.hostMessageCount();
    await recordAt(editor, 12);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked button "Menu"', atMs: 900 });
    fake.pushRecord({ type: 'record:drafting', busy: true });
    await waitFor('updating marker on', () => hooks.recordingState()?.drafting === true);
    assert.equal(hooks.recordingState().draft, null, 'no draft yet');
    fake.pushRecord({ type: 'record:draft', revision: 1, steps: ['Click Menu'], parameters: [], through: 'a1' });
    fake.pushRecord({ type: 'record:drafting', busy: false });
    await waitFor('first draft', () => hooks.recordingState()?.draft?.revision === 1 && !hooks.recordingState().drafting);
    assert.deepEqual(hooks.recordingState().draft.steps, ['Click Menu']);
    await waitFor('first draft in the file', () => stepLines(editor.document.getText())[3] === '4. Click Menu');

    // The next action changed what the last one meant: the draft is REPLACED,
    // not appended to.
    fake.pushRecord({ type: 'record:action', id: 'a2', kind: 'click', summary: 'Clicked link "Payments"', atMs: 1700 });
    fake.pushRecord({ type: 'record:drafting', busy: true });
    fake.pushRecord({
      type: 'record:draft',
      revision: 2,
      steps: ['Click Payments in the main menu'],
      parameters: [],
      notes: ['The two clicks were one menu choice.'],
      through: 'a2',
    });
    // A late, older draft must not put the stale list back.
    fake.pushRecord({ type: 'record:draft', revision: 1, steps: ['Click Menu'], parameters: [] });
    fake.pushRecord({ type: 'record:drafting', busy: false });
    await waitFor('second draft', () => hooks.recordingState()?.draft?.revision === 2 && !hooks.recordingState().drafting);
    // Give the stale frame time to arrive; it must change nothing.
    await sleep(100);
    const state = hooks.recordingState();
    assert.deepEqual(state.draft.steps, ['Click Payments in the main menu']);
    assert.deepEqual(state.draft.notes, ['The two clicks were one menu choice.']);
    assert.equal(state.draft.through, 'a2');
    // The panel was told each draft, whole.
    const drafts = hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'recording' && m.state?.draft)
      .map((m) => m.state.draft.revision);
    assert.ok(drafts.includes(1) && drafts.includes(2), JSON.stringify(drafts));
    assert.equal(drafts[drafts.length - 1], 2);
    // The file shows revision 2 — in place of revision 1, not beside it.
    assert.deepEqual(stepLines(editor.document.getText()).slice(0, 5), [
      '1. Navigate to login.html',
      '2. Click Sign in',
      '3. Open the dashboard',
      '4. Click Payments in the main menu',
      '1. Type {{email}} into the Email field',
    ]);

    fake.recordControlImpl = async (_s, body) => {
      if (body.action !== 'stop') return;
      fake.pushRecord({ type: 'record:writing' });
      // Differs from the last draft on purpose: what goes in is the result.
      fake.pushRecord({
        type: 'record:result',
        steps: ['Click Payments in the main menu', 'Tick the Cash checkbox'],
        parameters: [],
      });
      fake.pushRecord({ type: 'done', status: 'passed' });
      fake.endRecord();
    };
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.deepEqual(stepLines(editor.document.getText()).slice(0, 5), [
      '1. Navigate to login.html',
      '2. Click Sign in',
      '3. Open the dashboard',
      '4. Click Payments in the main menu',
      '5. Tick the Cash checkbox',
    ]);
    assert.equal(hooks.recordingReport().steps, 2);
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo restores the original', () => editor.document.getText() === original);
  });

  // ---- The file while recording (the author's request, 2026-09-27: "the
  // steps appeared in the test after every action") -------------------------

  /** FIXTURE with `lines` (1-based line → text) replaced and `insert`
   *  (after 1-based line → texts) added — the expected document, spelled out. */
  function fixtureWith({ replace = {}, insert = {} } = {}) {
    const out = [];
    FIXTURE.split('\n').forEach((line, i) => {
      out.push(replace[i + 1] ?? line);
      out.push(...(insert[i + 1] ?? []));
    });
    return out.join('\n');
  }

  function pushDraft(revision, steps, parameters = []) {
    fake.pushRecord({ type: 'record:drafting', busy: true });
    fake.pushRecord({ type: 'record:draft', revision, steps, parameters });
    fake.pushRecord({ type: 'record:drafting', busy: false });
  }

  it('each draft is written into the file as it arrives, highlighted; the result replaces the last one; one undo takes it all back', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    // The cursor sits where the steps go in — the start of line 12, after
    // "2. Click Sign in" — so every write lands on it.
    cursorAt(editor, 12);
    await vscode.commands.executeCommand('testbench-native.recordSteps', { line: 11 });
    await waitFor('record stream open', () => fake.hasActiveRecordStream);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked "Menu"', atMs: 100 });
    await waitFor('action listed', () => hooks.recordingState()?.actions.length === 1);
    assert.deepEqual(hooks.recordingHighlight(), [], 'nothing written, nothing highlighted');

    pushDraft(1, ['Click Menu']);
    const d1 = fixtureWith({ insert: { 11: ['3. Click Menu'] }, replace: { 12: '4. Open the dashboard' } });
    await waitFor('draft 1 in the file', () => editor.document.getText() === d1);
    assert.deepEqual(hooks.recordingHighlight(), [12]);

    // The model rewrote its last step and added one with a parameter.
    pushDraft(2, ['Click Payments in the main menu', 'Type {{password}} into the Password field'], [
      { name: 'password', value: '$PASSWORD' },
    ]);
    const d2 = fixtureWith({
      insert: { 7: ['- password: $PASSWORD'], 11: ['3. Click Payments in the main menu', '4. Type {{password}} into the Password field'] },
      replace: { 12: '5. Open the dashboard' },
    });
    await waitFor('draft 2 in place of draft 1', () => editor.document.getText() === d2);
    assert.deepEqual(hooks.recordingHighlight(), [8, 13, 14], 'the added parameter and the recorded steps');

    // A late, older draft changes nothing.
    pushDraft(1, ['Click Menu']);
    await sleep(150);
    assert.equal(editor.document.getText(), d2);

    pushDraft(3, ['Click Payments in the main menu', 'Type {{password}} into the Password field', 'Tick the Cash checkbox'], [
      { name: 'password', value: '$PASSWORD' },
      { name: 'amount', value: '10' },
    ]);
    await waitFor('draft 3', () => editor.document.getText().includes('5. Tick the Cash checkbox\n6. Open the dashboard'));
    assert.match(editor.document.getText(), /- password: \$PASSWORD\n- amount: 10\n\n## Steps/);

    // The result differs from the last draft: `amount` is gone, a step is added.
    answerStopWith({
      steps: ['Click Payments in the main menu', 'Type {{password}} into the Password field', 'Tick the Cash checkbox', 'Click Pay'],
      parameters: [{ name: 'password', value: '$PASSWORD' }],
    });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    const final = fixtureWith({
      insert: {
        7: ['- password: $PASSWORD'],
        11: ['3. Click Payments in the main menu', '4. Type {{password}} into the Password field', '5. Tick the Cash checkbox', '6. Click Pay'],
      },
      replace: { 12: '7. Open the dashboard' },
    });
    assert.equal(editor.document.getText(), final, 'the result, written once, over the last draft');
    assert.equal(hooks.recordingReport().status, 'inserted');
    assert.equal(hooks.recordingReport().steps, 4);
    assert.equal(hooks.recordingHighlight(), null, 'the highlight is gone');
    assert.deepEqual(hooks.recordingNotices(), [], 'no warning: the author edited nothing');
    assert.equal(editor.selection.start.line + 1, 13, 'the recorded steps are selected');
    assert.equal(editor.selection.end.line + 1, 16);

    // Measured (VS Code 1.95): the drafts and the result are ONE undo step —
    // one Ctrl+Z restores the file byte for byte, and it is no longer dirty.
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo restores the original', () => editor.document.getText() === original);
    assert.equal(editor.document.isDirty, false);
  });

  it('Cancel takes out everything the drafts wrote — steps, renumbering, parameters — and keeps the author\'s own edits', async () => {
    const editor = await openFixture();
    await recordAt(editor, 10); // "1. Navigate to login.html"
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, ['Click Menu', 'Type {{amount}} into Amount'], [{ name: 'amount', value: '10' }]);
    await waitFor('draft 1 in the file', () =>
      editor.document.getText() ===
      fixtureWith({
        insert: { 7: ['- amount: 10'], 10: ['2. Click Menu', '3. Type {{amount}} into Amount'] },
        replace: { 11: '4. Click Sign in', 12: '5. Open the dashboard' },
      }),
    );
    // The author adds a line under the title while recording: the recording's
    // lines move down with it, and it is theirs to keep.
    assert.ok(await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'Written while recording.\n')));
    pushDraft(2, ['Click Menu', 'Type {{amount}} into Amount', 'Click Pay'], [{ name: 'amount', value: '10' }]);
    await waitFor('draft 2, below the author\'s line', () =>
      editor.document.getText() ===
      fixtureWith({
        insert: { 1: ['Written while recording.'], 7: ['- amount: 10'], 10: ['2. Click Menu', '3. Type {{amount}} into Amount', '4. Click Pay'] },
        replace: { 11: '5. Click Sign in', 12: '6. Open the dashboard' },
      }),
    );
    assert.deepEqual(hooks.recordingNotices(), [], 'an edit above the recorded lines is not warned about');

    await cancelRecording();
    assert.equal(hooks.recordingReport().status, 'cancelled');
    assert.equal(
      editor.document.getText(),
      fixtureWith({ insert: { 1: ['Written while recording.'] } }),
      'the file as it was, byte for byte, with the author\'s line',
    );
    assert.equal(hooks.recordingHighlight(), null);
  });

  it('a recording that ends in an error takes its drafts back out; one the server ends says so and does too', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, ['Click Menu'], [{ name: 'q', value: 'x' }]);
    await waitFor('draft in the file', () => editor.document.getText().includes('3. Click Menu'));
    fake.pushRecord({ type: 'done', status: 'error', error: 'The model call failed: rate limited.' });
    fake.endRecord();
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().status, 'error');
    assert.equal(editor.document.getText(), original);

    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, ['Click Menu']);
    await waitFor('draft in the file', () => editor.document.getText().includes('3. Click Menu'));
    fake.pushRecord({ type: 'done', status: 'aborted', error: 'The session was closed while recording.' });
    fake.endRecord();
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().messages[0].text, 'The session was closed while recording.');
    assert.equal(editor.document.getText(), original);
  });

  it('an edit inside the lines being recorded is warned about once, and the next draft writes over it', async () => {
    const editor = await openFixture();
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, ['Click Menu', 'Tick the Cash checkbox']);
    const d1 = fixtureWith({ insert: { 11: ['3. Click Menu', '4. Tick the Cash checkbox'] }, replace: { 12: '5. Open the dashboard' } });
    await waitFor('draft 1 in the file', () => editor.document.getText() === d1);

    assert.ok(await editor.edit((b) => b.replace(new vscode.Range(12, 3, 12, 7), 'Untick')));
    await waitFor('warned', () => hooks.recordingNotices().length === 1);
    assert.deepEqual(hooks.recordingNotices(), [
      { level: 'warn', text: 'Lines being recorded are rewritten as the model updates them — edit them after Stop.' },
    ]);
    assert.ok(await editor.edit((b) => b.insert(new vscode.Position(11, 13), ' twice')));
    await sleep(100);
    assert.equal(hooks.recordingNotices().length, 1, 'once per recording');

    pushDraft(2, ['Click Menu', 'Tick the Cash checkbox']);
    await waitFor('the draft is back as the model wrote it', () => editor.document.getText() === d1);
    assert.deepEqual(hooks.recordingHighlight(), [12, 13]);
    await cancelRecording();
    assert.equal(editor.document.getText(), FIXTURE);
  });

  /**
   * Record at line 11, write draft 1, let `interrupt` happen, write draft 2,
   * Stop with a result — then ONE undo, and what the file reads.
   */
  async function oneUndoAfter(interrupt) {
    const editor = await openFixture();
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, ['Click Menu']);
    await waitFor('draft 1 in the file', () => editor.document.getText().includes('3. Click Menu\n4. Open'));
    await interrupt(editor);
    pushDraft(2, ['Click Menu', 'Click Payments']);
    const recorded = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    await waitFor('draft 2 in the file', () => recorded.getText().includes('4. Click Payments\n5. Open'));
    answerStopWith({ steps: ['Click Menu', 'Click Payments', 'Tick Cash'] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().status, 'inserted');
    const shown = vscode.window.activeTextEditor;
    assert.equal(shown?.document.uri.toString(), uri.toString(), 'the recorded file is the active editor after Stop');
    assert.match(shown.document.getText(), /3\. Click Menu\n4\. Click Payments\n5\. Tick Cash\n6\. Open the dashboard/);
    await vscode.commands.executeCommand('undo');
    await sleep(150);
    return shown.document.getText();
  }

  // Measured (VS Code 1.95): VS Code closes an open undo step when the author
  // types, moves the cursor, or saves, and a draft written while the file is
  // in no visible editor is a WorkspaceEdit — always a step of its own. The
  // result is then written as two steps (the drafts taken out, then the
  // result), so ONE undo still lands on the file without the recording.
  it('one undo after Stop removes the recording even when the author typed in the file between drafts — the typing stays', async () => {
    const after = await oneUndoAfter(async (editor) => {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      editor.selection = new vscode.Selection(0, 16, 0, 16);
      await vscode.commands.executeCommand('type', { text: '!' });
      await waitFor('typed', () => editor.document.lineAt(0).text === '# Record fixture!');
    });
    assert.equal(after, fixtureWith({ replace: { 1: '# Record fixture!' } }));
  });

  it('one undo after Stop removes the recording even when the author moved the cursor in the file between drafts', async () => {
    const after = await oneUndoAfter(async () => {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand('cursorDown');
    });
    assert.equal(after, FIXTURE);
  });

  it('a draft that arrives while another file is showing still edits the recorded file; one undo after Stop still removes it all', async () => {
    const after = await oneUndoAfter(async () => {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(FIXTURES_DIR, 'plain.md')));
      await waitFor('the other file active', () => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('plain.md'));
      assert.ok(
        !vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri.toString()),
        'the recorded file is in no visible editor',
      );
    });
    assert.equal(after, FIXTURE);
  });

  it('a file closed while recording is not written again, and the result is rescued rather than lost', async () => {
    const editor = await openFixture();
    const doc = editor.document;
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, ['Click Menu']);
    await waitFor('draft 1 in the file', () => doc.getText().includes('3. Click Menu'));
    // The author closes it, not saving the draft.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await waitFor('the document is closed', () => doc.isClosed, 10_000);
    pushDraft(2, ['Click Menu', 'Click Payments']);
    answerStopWith({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    const report = hooks.recordingReport();
    assert.equal(report.status, 'error');
    assert.match(report.messages[0].text, /record-steps\.tmp\.md was closed while recording\. They are in the TestBench output/);
    assert.equal(report.rescued, '## Steps\n1. Click Menu\n2. Click Payments');
    assert.ok(
      !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty),
      'the file was not reopened and written',
    );
  });

  // ---- Never overwrite text the recording cannot prove it wrote
  // (SPEC-record-steps.md §7). Each case below is a sequence an adversarial
  // review reproduced against tb 0.5.153 in this host, where it deleted or
  // duplicated the author's text; the events VS Code reports for them (an
  // undo, a revert, a line-ending change) are the ones offsets cannot follow.

  const D1 = ['Click Menu'];
  const D2 = ['Click Menu', 'Click Payments'];
  const D3 = ['Click Menu', 'Click Payments', 'Tick Cash'];
  /** FIXTURE with `steps` recorded after line 11, and what else is asked. */
  const recorded = (steps, extra = {}) =>
    fixtureWith({
      insert: { ...(extra.insert ?? {}), 11: [...steps.map((s, k) => `${3 + k}. ${s}`), ...(extra.after ?? [])] },
      replace: { 12: `${3 + steps.length}. Open the dashboard`, ...(extra.replace ?? {}) },
    });

  /** Record at line 11 and write draft 1 (`D1` unless said) into the file. */
  async function recordDraft1(editor, steps = D1, parameters = []) {
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, steps, parameters);
    const expected = recorded(steps, parameters.length > 0 ? { insert: { 7: parameters.map((p) => `- ${p.name}: ${p.value}`) } } : {});
    await waitFor('draft 1 in the file', () => editor.document.getText() === expected);
    return expected;
  }

  it('File: Revert while recording is not written over: the next draft goes in afresh at the anchor, and Cancel restores the file', async () => {
    const editor = await openFixture();
    const pw = [{ name: 'password', value: '$PASSWORD' }];
    await recordDraft1(editor, D2, pw);
    // VS Code sends the revert as ONE line diff reaching from the parameters
    // through the recorded steps into the flow; 0.5.153 widened the recording's
    // lines over it and the next draft deleted `## Steps` and the main flow.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitFor('reverted', () => editor.document.getText() === FIXTURE);
    pushDraft(2, D3, pw);
    await waitFor('draft 2, afresh', () => editor.document.getText() === recorded(D3, { insert: { 7: ['- password: $PASSWORD'] } }));
    assert.deepEqual(hooks.recordingNotices(), [], 'a revert is not an edit inside the recorded lines');
    await cancelRecording();
    assert.equal(editor.document.getText(), FIXTURE);
  });

  /** Write `text` to the fixture on disk, retrying while Windows still holds
   *  the file from VS Code's own save (EBUSY), as a checkout would. */
  async function writeFixtureOnDisk(text) {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(fixturePath, text, 'utf8');
        return;
      } catch (err) {
        if (err.code !== 'EBUSY' || attempt >= 40) throw err;
        await sleep(50);
      }
    }
  }

  it('the file reloaded from disk while recording (saved, then changed underneath — a checkout) is not written over', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    const other = FIXTURE.replace('# Record fixture', '# Record fixture, as another branch has it');
    try {
      assert.ok(await editor.document.save());
      await writeFixtureOnDisk(other);
      await waitFor('reloaded from disk', () => editor.document.getText() === other, 15_000);
      pushDraft(2, D2);
      await waitFor('draft 2, afresh', () => editor.document.getText() === recorded(D2).replace('# Record fixture', '# Record fixture, as another branch has it'));
      await cancelRecording();
      assert.equal(editor.document.getText(), other, 'the file as the checkout left it');
    } finally {
      await writeFixtureOnDisk(FIXTURE);
    }
  });

  it('the line endings changed while recording (one change over the whole document) keep the file: the next draft goes in, in CRLF; Cancel restores it', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    // 0.5.153: the recorded lines were widened over the whole file, which
    // then became just the recorded steps; Cancel left it empty.
    assert.ok(await editor.edit((b) => b.setEndOfLine(vscode.EndOfLine.CRLF)));
    pushDraft(2, D2);
    await waitFor('draft 2, in CRLF', () => editor.document.getText() === recorded(D2).replace(/\n/g, '\r\n'));
    await cancelRecording();
    assert.equal(editor.document.getText(), FIXTURE.replace(/\n/g, '\r\n'), 'the author\'s line endings kept, the recording gone');
  });

  it('Ctrl+Z then Ctrl+Y while recording does not duplicate the steps and warns about nothing; Cancel leaves no stray copy', async () => {
    const editor = await openFixture();
    const d1 = await recordDraft1(editor);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await waitFor('undone', () => editor.document.getText() === FIXTURE);
    await vscode.commands.executeCommand('redo');
    await waitFor('redone', () => editor.document.getText() === d1);
    assert.deepEqual(hooks.recordingHighlight(), [12], 'found again by its text: highlighted where it is');
    pushDraft(2, D2);
    await waitFor('draft 2 over the redone draft', () => editor.document.getText() === recorded(D2));
    await sleep(100);
    assert.equal(editor.document.getText(), recorded(D2), 'once');
    assert.deepEqual(hooks.recordingNotices(), [], 'undo and redo are not edits inside the recorded lines');
    await cancelRecording();
    assert.equal(editor.document.getText(), FIXTURE);
  });

  it('Ctrl+Z while recording takes the draft out and the next goes back in — no warning; one Ctrl+Z after Stop still removes the recording', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await waitFor('undone', () => editor.document.getText() === FIXTURE);
    pushDraft(2, D2);
    await waitFor('draft 2 back in at the anchor', () => editor.document.getText() === recorded(D2));
    assert.deepEqual(hooks.recordingNotices(), [], 'nothing was edited: no warning');
    answerStopWith({ steps: D3 });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().status, 'inserted');
    assert.equal(editor.document.getText(), recorded(D3));
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo removes the recording', () => editor.document.getText() === FIXTURE);
  });

  it('typing at the start of a later step is the author\'s line: never overwritten, and Cancel keeps it', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    // 0.5.153 took the typing into that step's number and wrote the number
    // back over it at the next draft — the typed text gone, silently.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(12, 0, 12, 0); // "4. Open the dashboard"
    await vscode.commands.executeCommand('type', { text: 'Check the banner' });
    await vscode.commands.executeCommand('type', { text: '\n' });
    const typed = editor.document.lineAt(12).text;
    assert.equal(typed.trim(), 'Check the banner');
    pushDraft(2, D2);
    // The step below the typed line is exactly as the recording numbered it,
    // so it is still renumbered.
    await waitFor('draft 2, the typed line kept', () => editor.document.getText() === recorded(D2, { after: [typed] }));
    assert.deepEqual(hooks.recordingNotices(), []);
    await cancelRecording();
    assert.equal(editor.document.getText(), fixtureWith({ insert: { 11: [typed] } }));
  });

  it('indenting a later step while recording (Tab) is the author\'s: the indentation is never stripped', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(12, 0, 12, 0);
    await vscode.commands.executeCommand('tab');
    const indented = editor.document.lineAt(12).text;
    assert.match(indented, /^\s+4\. Open the dashboard$/);
    pushDraft(2, D2);
    await waitFor('draft 2', () => editor.document.getText().includes('4. Click Payments\n'));
    assert.equal(editor.document.lineAt(13).text, indented, 'the indented step is the author\'s now: left as it is');
    await cancelRecording();
    assert.equal(editor.document.getText(), fixtureWith({ replace: { 12: indented } }));
  });

  it('End, Enter on the last recorded line starts the author\'s own line below the steps: a step typed there is kept', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    // 0.5.153 counted the new line inside the recorded block, and the next
    // draft deleted the step typed on it.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13); // the end of "3. Click Menu"
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: '4. Check the banner' });
    const mine = editor.document.lineAt(12).text;
    assert.equal(mine.trim(), '4. Check the banner');
    pushDraft(2, D2);
    await waitFor('draft 2, the author\'s step kept below it', () => editor.document.getText() === recorded(D2, { after: [mine] }));
    assert.deepEqual(hooks.recordingNotices(), []);
    await cancelRecording();
    assert.equal(editor.document.getText(), fixtureWith({ insert: { 11: [mine] } }));
  });

  it('one undo per recording: Stop, undo, redo — then a second recording in the same file, and one undo takes out only that one', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    answerStopWith({ steps: D2 });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    const first = recorded(D2);
    assert.equal(editor.document.getText(), first);
    await vscode.commands.executeCommand('undo');
    await waitFor('undo', () => editor.document.getText() === FIXTURE);
    assert.equal(editor.document.isDirty, false);
    await vscode.commands.executeCommand('redo');
    await waitFor('redo', () => editor.document.getText() === first);
    // "5. Open the dashboard", the main flow's last step now.
    await recordAt(editor, 14);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    pushDraft(1, ['Click Logout']);
    await waitFor('second recording, draft 1', () => editor.document.getText().includes('5. Open the dashboard\n6. Click Logout\n'));
    answerStopWith({ steps: ['Click Logout', 'Close the tab'] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.ok(editor.document.getText().includes('5. Open the dashboard\n6. Click Logout\n7. Close the tab\n'));
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo: the first recording\'s result', () => editor.document.getText() === first);
    await vscode.commands.executeCommand('undo');
    await waitFor('a second: the file before either', () => editor.document.getText() === FIXTURE);
  });

  it('Cancel, then record again and Stop: one undo takes out that recording', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    await cancelRecording();
    assert.equal(editor.document.getText(), FIXTURE);
    await recordDraft1(editor);
    answerStopWith({ steps: D2 });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.equal(editor.document.getText(), recorded(D2));
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo', () => editor.document.getText() === FIXTURE);
    await vscode.commands.executeCommand('undo');
    await sleep(150);
    assert.equal(editor.document.getText(), FIXTURE, 'the cancelled recording\'s undo step changes nothing');
  });

  /**
   * Record D2, then delete from the middle of the anchor line into the middle
   * of the first recorded line — across the recording's edge, leaving
   * "4. Click Payments" behind: what the recording wrote can no longer be
   * proved to be where it is.
   */
  async function recordThenCutAcross(editor) {
    await recordDraft1(editor, D2);
    assert.ok(await editor.edit((b) => b.delete(new vscode.Range(10, 12, 11, 10))));
    const cut = editor.document.getText();
    assert.match(cut, /\n2\. Click Sigenu\n4\. Click Payments\n5\. Open the dashboard\n/);
    pushDraft(2, D3);
    await waitFor('told once', () => hooks.recordingNotices().length === 1);
    assert.deepEqual(hooks.recordingNotices(), [
      {
        level: 'warn',
        text:
          'The recorded steps could not be found in the file any more, so they are no longer written live; ' +
          'the panel keeps them and Stop will insert them at your cursor line.',
      },
    ]);
    await sleep(100);
    assert.equal(editor.document.getText(), cut, 'nothing written into the file');
    assert.deepEqual(hooks.recordingHighlight(), [], 'nothing highlighted: nothing is known to be the recording\'s');
    assert.deepEqual(hooks.recordingState().draft.steps, D3, 'the panel keeps drafting');
    return cut;
  }

  it('what the recording wrote cannot be found any more: it stops writing live, says so once, and Stop inserts the result once at the anchor', async () => {
    const editor = await openFixture();
    const cut = await recordThenCutAcross(editor);
    pushDraft(3, [...D3, 'Click Pay']);
    await sleep(150);
    assert.equal(editor.document.getText(), cut, 'still nothing written');
    assert.equal(hooks.recordingNotices().length, 1, 'said once');
    answerStopWith({ steps: D3 });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().status, 'inserted');
    // One insertion after the anchor, the flow renumbered — what is left of
    // the drafts (the author's to delete) included.
    assert.equal(
      editor.document.getText(),
      cut.replace(
        '2. Click Sigenu\n4. Click Payments\n5. Open the dashboard\n',
        '2. Click Sigenu\n3. Click Menu\n4. Click Payments\n5. Tick Cash\n6. Click Payments\n7. Open the dashboard\n',
      ),
    );
    // Its own undo step.
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo takes the insertion out', () => editor.document.getText() === cut);
  });

  it('what the recording wrote cannot be found any more: Cancel takes nothing out', async () => {
    const editor = await openFixture();
    const cut = await recordThenCutAcross(editor);
    await cancelRecording();
    assert.equal(hooks.recordingReport().status, 'cancelled');
    assert.equal(editor.document.getText(), cut);
  });

  /** Rename the fixture to `record-steps-renamed.tmp.md`; `body` runs with
   *  the renamed document; the fixture is put back afterwards. */
  async function withRenamedFixture(body) {
    const newUri = vscode.Uri.file(path.resolve(FIXTURES_DIR, 'record-steps-renamed.tmp.md'));
    const renamed = () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === newUri.toString() && !d.isClosed);
    try {
      const we = new vscode.WorkspaceEdit();
      we.renameFile(uri, newUri, { overwrite: true });
      assert.ok(await vscode.workspace.applyEdit(we));
      await waitFor('the renamed document is open', () => renamed() !== undefined);
      await body(renamed);
    } finally {
      const doc = renamed();
      if (doc) {
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
      fs.rmSync(newUri.fsPath, { force: true });
      fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
    }
  }

  it('a file renamed while recording is followed: the next draft and the result go into it under its new name', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    // 0.5.153 took the rename for the file being closed: the result was
    // rescued, and the renamed buffer kept the draft.
    await withRenamedFixture(async (renamed) => {
      assert.equal(renamed().getText(), recorded(D1), 'VS Code moved the unsaved draft along');
      await waitFor('what is kept for a reload moved along', () => hooks.recordingPersisted()?.uri === renamed().uri.toString());
      pushDraft(2, D2);
      await waitFor('draft 2 in the renamed file', () => renamed().getText() === recorded(D2));
      assert.equal(hooks.recordingState().file, 'record-steps-renamed.tmp.md');
      answerStopWith({ steps: D3 });
      await vscode.commands.executeCommand('testbench-native.stopRecording');
      await hooks.recordingSettled();
      assert.equal(hooks.recordingReport().status, 'inserted');
      assert.equal(renamed().getText(), recorded(D3));
    });
  });

  it('a file renamed while recording and then cancelled: the renamed file keeps nothing of the recording', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    await withRenamedFixture(async (renamed) => {
      await cancelRecording();
      assert.equal(renamed().getText(), FIXTURE);
    });
  });

  it('a window closing on a recording takes its draft out; one that could not is offered for removal at the next activation', async () => {
    const editor = await openFixture();
    const pw = [{ name: 'password', value: '$PASSWORD' }];
    const drafted = await recordDraft1(editor, D2, pw);
    // What a reload leaves behind is kept after every write.
    await waitFor('kept for a reload', () => hooks.recordingPersisted()?.block === '3. Click Menu\n4. Click Payments\n');
    const kept = hooks.recordingPersisted();
    assert.equal(kept.uri, uri.toString());
    assert.equal(kept.params, '- password: $PASSWORD\n');
    assert.deepEqual(kept.tails, [{ wrote: '5', original: '3', rest: '. Open the dashboard' }]);

    // deactivate(): the recording is cancelled and its draft taken out while
    // the host still runs (0.5.153 marked it stopped and left the draft).
    await hooks.shutdownRecording();
    await hooks.recordingSettled();
    assert.equal(editor.document.getText(), FIXTURE, 'the draft taken back out');
    assert.equal(hooks.recordingPersisted(), undefined, 'nothing left to recover');

    // A reload that took the window before that: hot exit restored the
    // buffer, draft and all, and the kept record says what the recording wrote.
    const whole = () => new vscode.Range(0, 0, editor.document.lineCount, 0);
    assert.ok(await editor.edit((b) => b.replace(whole(), drafted)));
    await hooks.setRecordingPersisted(kept);
    assert.equal(await hooks.recoverUnfinishedRecording('Keep them'), 'kept');
    assert.equal(editor.document.getText(), drafted);
    assert.equal(hooks.recordingPersisted(), undefined, 'forgotten either way');

    await hooks.setRecordingPersisted(kept);
    assert.equal(await hooks.recoverUnfinishedRecording("Remove the unfinished recording's steps"), 'removed');
    assert.equal(editor.document.getText(), FIXTURE, 'the verified empty draft');

    // Edited since, inside the recorded lines: nothing can be proved, nothing offered.
    const edited = drafted.replace('Click Payments', 'Tap Payments');
    assert.ok(await editor.edit((b) => b.replace(whole(), edited)));
    await hooks.setRecordingPersisted(kept);
    assert.equal(await hooks.recoverUnfinishedRecording("Remove the unfinished recording's steps"), 'not-found');
    assert.equal(editor.document.getText(), edited);
    assert.equal(hooks.recordingPersisted(), undefined);
  });

  it('a drop the server cannot take is said in the log and still counts at Stop', async () => {
    const editor = await openFixture();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked "Pay"', atMs: 100 });
    await waitFor('action listed', () => hooks.recordingState()?.actions.length === 1);
    const { ApiClientError } = require('ai-ui-automation-runner-core');
    fake.recordControlImpl = async (_s, body) => {
      if (body.action === 'drop') throw new ApiClientError('not-found', 'No recording is running for this session.', { status: 404 });
    };
    const mark = hooks.hostMessageCount();
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 'a1', dropped: true });
    assert.equal(hooks.recordingState().actions[0].dropped, true, 'the row stays struck through');
    const logged = hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'output')
      .map((m) => m.event);
    assert.ok(
      logged.some((e) => e.kind === 'warn' && /Could not drop that action now/.test(e.msg)),
      JSON.stringify(logged),
    );
    fake.recordControlImpl = null;
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    assert.deepEqual(fake.recordControlCalls[fake.recordControlCalls.length - 1].body, { action: 'stop', dropped: ['a1'] });
    await cancelRecording();
  });

  it('Record New Test creates the file, records into it, and inserts under ## Steps', async () => {
    fs.rmSync(newPath, { force: true });
    await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: NEW_NAME });
    await waitFor('record stream open', () => fake.recordRequests.length === 1 && fake.hasActiveRecordStream);

    assert.ok(fs.existsSync(newPath), 'the file is created on disk');
    const onDisk = fs.readFileSync(newPath, 'utf8');
    // Title case (SPEC-record-steps.md §7.2).
    assert.match(onDisk, /^# Record New Tmp\n\n## Config\n(- baseUrl: \S+\n)?\n## Parameters\n\n## Steps\n$/);
    const editor = vscode.window.activeTextEditor;
    // Compared as VS Code spells the path (it lower-cases the drive letter).
    const newFsPath = vscode.Uri.file(newPath).fsPath;
    assert.equal(editor.document.uri.fsPath, newFsPath, 'the new test is open');
    assert.equal(editor.selection.active.line, onDisk.split('\n').length - 1, 'the cursor is under ## Steps');

    const req = fake.recordRequests[0];
    assert.equal(req.testFilePath, newFsPath);
    assert.equal(fake.recordSessionIds[0], newFsPath);
    assert.deepEqual(req.target, { mode: 'new', fileText: onDisk });
    const baseUrl = /- baseUrl: (\S+)/.exec(onDisk)?.[1];
    if (baseUrl) assert.deepEqual(req.config, { baseUrl });
    else assert.equal(req.config, undefined);

    fake.pushRecord({ type: 'record:started', url: baseUrl ?? 'about:blank', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'navigate', summary: 'Went to /login.html', atMs: 500 });
    fake.recordControlImpl = async (_s, body) => {
      if (body.action !== 'stop') return;
      fake.pushRecord({ type: 'record:writing' });
      fake.pushRecord({
        type: 'record:result',
        steps: ['Navigate to login.html', 'Type {{user}} into the Username field'],
        parameters: [{ name: 'user', value: 'demo' }],
      });
      fake.pushRecord({ type: 'done', status: 'passed' });
      fake.endRecord();
    };
    await waitFor('action listed', () => hooks.recordingState()?.actions.length === 1);
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    assert.deepEqual(fake.recordControlCalls.map((c) => c.body), [{ action: 'stop' }], 'nothing dropped, so no `dropped`');
    await hooks.recordingSettled();

    assert.equal(
      editor.document.getText(),
      onDisk.replace(
        '## Parameters\n\n## Steps\n',
        '## Parameters\n- user: demo\n\n## Steps\n1. Navigate to login.html\n2. Type {{user}} into the Username field\n',
      ),
    );
  });

  it('Record New Test refuses a name that already exists, and asks nothing of the server', async () => {
    fs.writeFileSync(newPath, '# Existing\n\n## Steps\n1. A\n', 'utf8');
    try {
      await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: NEW_NAME });
      assert.equal(fake.recordRequests.length, 0);
      // SPEC-record-steps.md §10, verbatim — the workspace-relative path.
      assert.equal(hooks.recordingRefusal(), `${NEW_FILE} already exists.`);
      assert.equal(fs.readFileSync(newPath, 'utf8'), '# Existing\n\n## Steps\n1. A\n', 'never overwritten');
      await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: 'a/b' });
      assert.match(hooks.recordingRefusal(), /no folders/);
    } finally {
      fs.rmSync(newPath, { force: true });
    }
  });

  it('Add check toggles pick mode, and the toggle shows what record:pick said', async () => {
    const editor = await openFixture();
    await recordAt(editor, 12);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');

    fake.recordControlImpl = async (_s, body) => {
      if (body.action === 'check') fake.pushRecord({ type: 'record:pick', armed: true });
      if (body.action === 'cancel-check') fake.pushRecord({ type: 'record:pick', armed: false });
    };
    await vscode.commands.executeCommand('testbench-native.recordAddCheck');
    await waitFor('armed', () => hooks.recordingState()?.pickArmed === true);
    // The panel's toggle is the same gesture.
    await hooks.dispatchWebviewMessage({ type: 'recordCheck' });
    await waitFor('disarmed', () => hooks.recordingState()?.pickArmed === false);
    assert.deepEqual(fake.recordControlCalls.map((c) => c.body), [{ action: 'check' }, { action: 'cancel-check' }]);

    // Armed again, and the author picks an element: the pick disarms and
    // arrives as a `check` action.
    await vscode.commands.executeCommand('testbench-native.recordAddCheck');
    await waitFor('armed again', () => hooks.recordingState()?.pickArmed === true);
    fake.pushRecord({ type: 'record:pick', armed: false });
    fake.pushRecord({ type: 'record:action', id: 'c1', kind: 'check', summary: 'Check: Payment method panel', atMs: 900 });
    await waitFor('check listed', () => hooks.recordingState()?.actions.length === 1);
    assert.equal(hooks.recordingState().pickArmed, false);
    assert.equal(hooks.recordingState().actions[0].kind, 'check');

    await cancelRecording();
  });

  it('Cancel ends the recording and inserts nothing', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked "Pay"', atMs: 100 });
    await waitFor('action listed', () => hooks.recordingState()?.actions.length === 1);

    await hooks.dispatchWebviewMessage({ type: 'recordCancel' });
    await hooks.recordingSettled();
    assert.deepEqual(fake.recordControlCalls.map((c) => c.body), [{ action: 'cancel' }]);
    assert.equal(fake.hasActiveRecordStream, false, 'the stream is closed — the wire\'s cancel');
    assert.equal(hooks.recordingState(), null);
    assert.equal(hooks.recordingReport().status, 'cancelled');
    assert.equal(editor.document.getText(), original);
    assert.equal(editor.document.isDirty, false);
  });

  it('is refused while a run of the test is executing', async () => {
    const editor = await openFixture();
    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(9, 5));
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('run stream open', () => fake.hasActiveStream);

    cursorAt(editor, 11);
    await vscode.commands.executeCommand('testbench-native.recordSteps');
    assert.equal(fake.recordRequests.length, 0);
    assert.equal(hooks.recordingRefusal(), 'Stop the run before recording.');
    assert.equal(hooks.recordingState(), null);

    fake.end();
    await waitFor('run over', () => !hooks.isRunning());
  });

  it('ends a run paused at a breakpoint first — that run only — then records in the same session', async () => {
    const editor = await openFixture();
    await vscode.commands.executeCommand('testbench-native.toggleBreakpoint', { lineNumber: 11 });
    fake.streamScripts[0] = async (f) => {
      f.push({ type: 'step:start', line: 10 });
      f.push({ type: 'step:pass', line: 10 });
      f.end();
    };
    await vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor('parked at line 11', () => hooks.tracker.snapshot().breakpointStop === 11);
    assert.equal(hooks.isParkedAtPause(uri), true);
    assert.equal(hooks.keepAliveActive(), true, 'the pause pins the server');
    assert.ok(fake.requests[0].config, 'the run created the session, with config');
    // Another test's spinner: ending THIS test's paused run must not touch it
    // (Stop's own teardown flips every spinner in the window).
    const otherUri = vscode.Uri.file(path.resolve(FIXTURES_DIR, 'plain.md'));
    hooks.tracker.setStatus(otherUri, 3, 'running');

    const req = await recordAt(editor, 10);
    assert.equal(hooks.tracker.snapshot().breakpointStop, null, 'the pause marker is gone');
    assert.equal(hooks.isParkedAtPause(uri), false, 'the paused run is over');
    assert.equal(hooks.keepAliveActive(), false, 'and so is its keep-alive');
    assert.equal(req.config, undefined, 'the session exists, so config is not sent again');
    assert.equal(fake.recordSessionIds[0], fake.streamSessionIds[0], 'the same session the run used');
    assert.equal(fake.closeSessionCalls, 1, 'only the run\'s first-use close — the browser stays');
    assert.deepEqual(
      new Map(hooks.tracker.snapshotFor(otherUri)?.statuses ?? []).get(3),
      'running',
      'the other test\'s spinner is not this run\'s to stop',
    );

    await cancelRecording();
    hooks.tracker.setStatuses(otherUri, [{ line: 3, status: null }]);
    await vscode.commands.executeCommand('testbench-native.toggleBreakpoint', { lineNumber: 11 });
  });

  it('ends a step-paused run (its stream still open) first, retrying while the server lets go of the session', async () => {
    const editor = await openFixture();
    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(11, 5));
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('run stream open', () => fake.hasActiveStream);
    fake.push({ type: 'step:start', line: 10 });
    fake.push({ type: 'step:pass', line: 10 });
    fake.push({ type: 'step:awaiting', line: 11 });
    await waitFor('step-paused', () => hooks.isStepPaused());
    // The server's run has not let go of the session's queue yet: one 409,
    // then the recording starts.
    const { ApiClientError } = require('ai-ui-automation-runner-core');
    fake.recordThrows.push(new ApiClientError('conflict', 'A run holds this session.', { status: 409 }));

    cursorAt(editor, 10);
    await vscode.commands.executeCommand('testbench-native.recordSteps');
    assert.equal(fake.hasActiveStream, false, 'the paused run\'s stream was closed');
    assert.equal(hooks.isRunning(), false);
    await waitFor('record stream open after the retry', () => fake.recordRequests.length === 2 && fake.hasActiveRecordStream);
    assert.equal(hooks.tracker.snapshot().breakpointStop, null);
    assert.equal(hooks.recordingState().phase, 'starting');

    await cancelRecording();
  });

  it('sends config only on the session\'s first request, and a Run after a recording reuses its session', async () => {
    const editor = await openFixture();
    const first = await recordAt(editor, 10);
    assert.deepEqual(first.config, { baseUrl: 'https://example.test/' });
    assert.equal(fake.closeSessionCalls, 1, 'the first-use close, as a Run makes');
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');
    await cancelRecording();

    const second = await recordAt(editor, 10);
    assert.equal(second.config, undefined);
    await cancelRecording();

    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(9, 5));
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('run stream open', () => fake.hasActiveStream);
    assert.equal(fake.requests[0].config, undefined, 'the Run continues the recording\'s session');
    assert.equal(fake.closeSessionCalls, 1, 'and does not close it first');
    fake.end();
    await waitFor('run over', () => !hooks.isRunning());
  });

  it('a run is refused while the recording holds the session', async () => {
    const editor = await openFixture();
    await recordAt(editor, 10);
    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(9, 5));
    await vscode.commands.executeCommand('testbench-native.runSelected');
    assert.equal(fake.streamCallCount, 0, 'no step request while recording');
    assert.equal(fake.closeSessionCalls, 1, 'and no session close under the recording');
    await cancelRecording();
  });

  it('refuses a cursor that is not on a step, and asks nothing of the server', async () => {
    const editor = await openFixture();
    cursorAt(editor, 9); // `## Steps` itself
    await vscode.commands.executeCommand('testbench-native.recordSteps');
    assert.equal(fake.recordRequests.length, 0);
    assert.equal(hooks.recordingRefusal(), 'Put the cursor on a step, or the blank line after one, under ## Steps.');
    cursorAt(editor, 4); // `- baseUrl:` under ## Config
    await vscode.commands.executeCommand('testbench-native.recordSteps');
    assert.equal(fake.recordRequests.length, 0);
  });

  it('a done error says why and inserts nothing; a 409 names the conflict', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'done', status: 'error', error: 'The model call failed: rate limited.' });
    fake.endRecord();
    await hooks.recordingSettled();
    const report = hooks.recordingReport();
    assert.equal(report.status, 'error');
    assert.equal(report.messages[0].text, 'The model call failed: rate limited.', 'the server\'s sentence, as it came');
    assert.equal(editor.document.getText(), original);

    const { ApiClientError } = require('ai-ui-automation-runner-core');
    fake.recordThrows.push(new ApiClientError('conflict', 'A run holds this session.', { status: 409 }));
    cursorAt(editor, 10);
    await vscode.commands.executeCommand('testbench-native.recordSteps');
    await hooks.recordingSettled();
    assert.match(hooks.recordingReport().messages[0].text, /A run holds this session\./);
    assert.equal(hooks.recordingState(), null);
  });

  /** Play the server's Stop: Finishing…, then this result, then done. */
  function answerStopWith(result) {
    fake.recordControlImpl = async (_s, body) => {
      if (body.action !== 'stop') return;
      fake.pushRecord({ type: 'record:writing' });
      fake.pushRecord({ type: 'record:result', parameters: [], ...result });
      fake.pushRecord({ type: 'done', status: 'passed' });
      fake.endRecord();
    };
  }

  /** Start a Run of line 10 and return its request; the caller ends it. */
  async function runLine10(editor) {
    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(9, 5));
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('run stream open', () => fake.hasActiveStream);
    return fake.requests[0];
  }

  it('a cancel before the first frame still counts the config sent: the server answered, so the next Run reuses the session', async () => {
    const editor = await openFixture();
    const first = await recordAt(editor, 10);
    assert.deepEqual(first.config, { baseUrl: 'https://example.test/' });
    assert.equal(fake.recordAnswers, 1, 'the server answered 200');
    // No frame at all — the server is still launching the browser.
    await cancelRecording();
    assert.equal(hooks.recordingReport().status, 'cancelled');

    const run = await runLine10(editor);
    // A real server answers 400 "Config can only be provided on the first
    // request" to a second config.
    assert.equal(run.config, undefined, 'the session the recording created already has its config');
    assert.equal(fake.closeSessionCalls, 1, 'and it is not closed first');
    fake.end();
    await waitFor('run over', () => !hooks.isRunning());
  });

  it('a cancel before the server answers leaves the session unknown: the next Run closes it and sends config', async () => {
    const editor = await openFixture();
    fake.recordAnswerGate = new Promise(() => {}); // never answers
    cursorAt(editor, 10);
    await vscode.commands.executeCommand('testbench-native.recordSteps');
    await waitFor('record request sent', () => fake.recordRequests.length === 1);
    assert.deepEqual(fake.recordRequests[0].config, { baseUrl: 'https://example.test/' });
    assert.equal(fake.closeSessionCalls, 1, 'the first-use close');
    await cancelRecording();
    assert.equal(fake.recordAnswers, 0, 'no 200 ever came');

    const run = await runLine10(editor);
    assert.equal(fake.closeSessionCalls, 2, 'whatever the abandoned request left is closed first');
    assert.deepEqual(run.config, { baseUrl: 'https://example.test/' }, 'so config rides again, to a session known to be new');
    fake.end();
    await waitFor('run over', () => !hooks.isRunning());
  });

  it('TestBench: Stop while the test records means Stop Recording — the steps are written, not thrown away', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'click', action: true, summary: 'Clicked button "Pay"', atMs: 1000 });
    await waitFor('action listed', () => hooks.recordingState()?.actions.length === 1);
    answerStopWith({ steps: ['Click Pay'] });

    // The palette's "TestBench: Stop Run", as the panel's run Stop and Shift+F5 send it.
    await vscode.commands.executeCommand('testbench-native.stop');
    await hooks.recordingSettled();
    assert.deepEqual(fake.recordControlCalls.map((c) => c.body), [{ action: 'stop' }]);
    assert.equal(hooks.recordingReport().status, 'inserted');
    assert.deepEqual(stepLines(editor.document.getText()).slice(0, 4), [
      '1. Navigate to login.html',
      '2. Click Pay',
      '3. Click Sign in',
      '4. Open the dashboard',
    ]);
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo restores the original', () => editor.document.getText() === original);
  });

  it('the steps go after the line the author chose, carried through edits made while recording', async () => {
    const editor = await openFixture();
    await recordAt(editor, 11); // "2. Click Sign in"
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');

    // While recording, the author adds a step at the top of the flow and
    // renumbers: the anchor's line moves, and its text changes to "3. …".
    assert.ok(await editor.edit((b) => b.insert(new vscode.Position(9, 0), '1. Open the home page\n')));
    assert.ok(
      await editor.edit((b) => {
        b.replace(new vscode.Range(10, 0, 10, 1), '2');
        b.replace(new vscode.Range(11, 0, 11, 1), '3');
        b.replace(new vscode.Range(12, 0, 12, 1), '4');
      }),
    );
    answerStopWith({ steps: ['Accept the cookie banner'] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();

    assert.deepEqual(stepLines(editor.document.getText()).slice(0, 5), [
      '1. Open the home page',
      '2. Navigate to login.html',
      '3. Click Sign in',
      '4. Accept the cookie banner',
      '5. Open the dashboard',
    ]);
    const report = hooks.recordingReport();
    assert.equal(report.status, 'inserted');
    assert.ok(!report.messages.some((m) => m.level === 'warn'), JSON.stringify(report.messages));
  });

  it('a result that cannot be inserted is not lost: it goes to the output, and the error offers Copy steps', async () => {
    const editor = await openFixture();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');
    // While recording, the author deletes the ## Steps heading: there is
    // nowhere left to insert.
    assert.ok(await editor.edit((b) => b.delete(new vscode.Range(8, 0, 9, 0))));
    const edited = editor.document.getText();
    answerStopWith({ steps: ['Click Pay'], parameters: [{ name: 'amount', value: '10' }] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();

    const report = hooks.recordingReport();
    assert.equal(report.status, 'error');
    assert.equal(report.rescued, '## Parameters\n- amount: 10\n\n## Steps\n1. Click Pay');
    assert.equal(report.messages.length, 1);
    assert.equal(report.messages[0].level, 'error');
    assert.match(report.messages[0].text, /not inserted .*They are in the TestBench output/);
    assert.deepEqual(report.messages[0].actions, ['Copy steps', 'Show output']);
    assert.equal(editor.document.getText(), edited, 'nothing was written into the file');
  });

  it('a result with no steps is said as the server\'s note, not as an error', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');
    const note = 'Nothing was recorded (or every action was removed), so there are no steps to add.';
    answerStopWith({ steps: [], notes: [note] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.deepEqual(hooks.recordingReport(), { status: 'empty', messages: [{ level: 'info', text: note }] });
    assert.equal(editor.document.getText(), original);
  });

  it('notes the model wrote are shown as plain text: page content cannot make a link', async () => {
    const editor = await openFixture();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');
    answerStopWith({ steps: ['Click Pay'], notes: ['The button said [Pay now](command:workbench.action.quit).'] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    const report = hooks.recordingReport();
    assert.equal(report.status, 'inserted');
    // A notification links `[text](target)` only with the brackets adjacent.
    for (const m of report.messages) assert.doesNotMatch(m.text, /\]\(/, m.text);
    assert.match(report.messages[0].text, /\[Pay now\] \(command:workbench\.action\.quit\)/, 'the words are all still there');
  });

  it('a recording the server ends by closing the session says so — and the next Run sends config again', async () => {
    const editor = await openFixture();
    const original = editor.document.getText();
    await recordAt(editor, 10);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'click', action: true, summary: 'Clicked "Pay"', atMs: 100 });
    // Another window's Run, Close Session or the idle reaper closed it.
    fake.pushRecord({ type: 'done', status: 'aborted', error: 'The session was closed while recording.' });
    fake.endRecord();
    await hooks.recordingSettled();
    assert.deepEqual(hooks.recordingReport(), {
      status: 'cancelled',
      messages: [{ level: 'warn', text: 'The session was closed while recording.' }],
    });
    assert.equal(editor.document.getText(), original);

    const run = await runLine10(editor);
    assert.deepEqual(run.config, { baseUrl: 'https://example.test/' }, 'the session that had it is gone');
    fake.end();
    await waitFor('run over', () => !hooks.isRunning());
  });

  it('Record New Test: no tests.dir means the server default ./tests; one outside the workspace is refused before anything is created', async () => {
    const configPath = path.resolve(FIXTURES_DIR, 'aiui.config.json');
    assert.equal(fs.existsSync(configPath), false, 'the fixtures workspace has no project config of its own');
    const outside = path.resolve(FIXTURES_DIR, '..', '..', 'record-outside.tmp');
    const testsDir = path.resolve(FIXTURES_DIR, 'tests');
    fs.rmSync(path.join(testsDir, NEW_FILE), { force: true });
    try {
      fs.writeFileSync(configPath, JSON.stringify({ tests: { dir: '../../record-outside.tmp' } }), 'utf8');
      await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: NEW_NAME });
      assert.match(hooks.recordingRefusal(), /outside this workspace/);
      assert.equal(fs.existsSync(outside), false, 'refused before anything is created');
      assert.equal(fake.recordRequests.length, 0);

      await sleep(20); // a new mtime, so the config is read again
      fs.writeFileSync(configPath, JSON.stringify({ tests: { pattern: '**/*.md' } }), 'utf8');
      await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: NEW_NAME });
      await waitFor('record stream open', () => fake.recordRequests.length === 1 && fake.hasActiveRecordStream);
      const created = vscode.Uri.file(path.join(testsDir, NEW_FILE)).fsPath;
      assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, created);
      assert.equal(fake.recordRequests[0].testFilePath, created);
      await cancelRecording();
    } finally {
      fs.rmSync(configPath, { force: true });
      // The new test is open, and Windows will not remove its folder until it
      // is closed.
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // The file first: a folder VS Code has just seen created can refuse
      // rmdir (EBUSY) for a while, and a file left in it would make the next
      // run's Record New Test refuse "already exists". An empty folder left
      // behind is harmless (git does not track it).
      for (const dir of [testsDir, outside]) {
        fs.rmSync(path.join(dir, NEW_FILE), { force: true });
        for (const deadline = Date.now() + 10_000; fs.existsSync(dir) && Date.now() < deadline; ) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            await sleep(250);
          }
        }
      }
    }
  });

  it('Record New Test with no editor in a project: the one project in a subfolder is used; several are asked about', async () => {
    assert.equal(fs.existsSync(path.resolve(FIXTURES_DIR, 'aiui.config.json')), false, 'no config at the workspace root');
    const projA = path.resolve(FIXTURES_DIR, 'record-proj-a.tmp');
    const projB = path.resolve(FIXTURES_DIR, 'record-proj-b.tmp');
    const atRoot = path.resolve(FIXTURES_DIR, NEW_FILE);
    const originalPick = vscode.window.showQuickPick;
    /** What the stub is to answer: an index into the items, or null for Escape. */
    let answer = null;
    const picks = [];
    const closeAll = async () => {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    };
    try {
      fs.mkdirSync(projA, { recursive: true });
      fs.writeFileSync(path.join(projA, 'aiui.config.json'), '{}', 'utf8');
      assert.equal(vscode.window.activeTextEditor, undefined, 'no editor open');

      // One project, in a subfolder: the walk up from the workspace root finds
      // nothing, the search finds it, and the test goes in its ./tests.
      await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: NEW_NAME });
      await waitFor('record stream open', () => fake.recordRequests.length === 1 && fake.hasActiveRecordStream);
      const inA = vscode.Uri.file(path.join(projA, 'tests', NEW_FILE)).fsPath;
      assert.equal(fake.recordRequests[0].testFilePath, inA);
      assert.equal(fs.existsSync(atRoot), false, 'not created at the workspace root, outside the project');
      await cancelRecording();
      await closeAll();

      // Two: the author is asked, and Escape creates nothing. With a test open
      // at the workspace root this time — an editor in no project leads to
      // none, so the search still decides. (It also displaces the tracker's
      // sticky editor, which would otherwise still be the test just created
      // in project A, whose config the walk up would find.)
      fs.mkdirSync(projB, { recursive: true });
      fs.writeFileSync(path.join(projB, 'aiui.config.json'), '{}', 'utf8');
      const plain = vscode.Uri.file(path.resolve(FIXTURES_DIR, 'plain.md'));
      await vscode.commands.executeCommand('vscode.open', plain);
      await waitFor('root-level editor tracked', () => hooks.tracker.activeEditor?.document.uri.fsPath === plain.fsPath);
      vscode.window.showQuickPick = (items, options) => {
        picks.push({ labels: items.map((i) => i.label), placeHolder: options?.placeHolder });
        return Promise.resolve(answer === null ? undefined : items[answer]);
      };
      await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: NEW_NAME });
      assert.equal(picks.length, 1, 'asked once');
      assert.deepEqual(picks[0].labels, ['record-proj-a.tmp', 'record-proj-b.tmp']);
      assert.match(picks[0].placeHolder, /several projects/);
      assert.equal(fake.recordRequests.length, 1, 'a dismissed pick records nothing');
      assert.equal(fs.existsSync(path.join(projB, 'tests', NEW_FILE)), false, 'and creates nothing');
      assert.equal(fs.existsSync(atRoot), false);

      // Picking one records into that project.
      answer = 1;
      await vscode.commands.executeCommand('testbench-native.recordNewTest', { name: NEW_NAME });
      await waitFor('record stream open', () => fake.recordRequests.length === 2 && fake.hasActiveRecordStream);
      const inB = vscode.Uri.file(path.join(projB, 'tests', NEW_FILE)).fsPath;
      assert.equal(fake.recordRequests[1].testFilePath, inB);
      assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, inB);
      await cancelRecording();
    } finally {
      vscode.window.showQuickPick = originalPick;
      await closeAll();
      fs.rmSync(atRoot, { force: true });
      // As above: the files first, then the folders, which Windows may hold
      // for a moment after the editors on them close.
      for (const dir of [projA, projB]) {
        fs.rmSync(path.join(dir, 'tests', NEW_FILE), { force: true });
        fs.rmSync(path.join(dir, 'aiui.config.json'), { force: true });
        for (const deadline = Date.now() + 10_000; fs.existsSync(dir) && Date.now() < deadline; ) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            await sleep(250);
          }
        }
      }
    }
  });

  // ---- The browser toolbar, TestBench's half (stories/testbench-record-toolbar.md):
  // Pause / Resume and Add step in VS Code, the author's own steps in the
  // action list, steps typed in the test file, where the toolbar was left,
  // and a Cancel pressed in the browser.

  /** The fake server's answers to the toolbar's controls, as a real one
   *  would push them; anything else is left to `extra`, whose answer (a
   *  `{ ignored, reason }`) is the control's. */
  function playToolbarControls(extra = async () => {}) {
    let at = 5_000;
    fake.recordControlImpl = async (_s, body) => {
      if (body.action === 'pause' || body.action === 'resume') {
        at += 1_000;
        fake.pushRecord({ type: 'record:paused', paused: body.action === 'pause', atMs: at, source: 'panel' });
      }
      return extra(body);
    };
  }

  const controlBodies = () => fake.recordControlCalls.map((c) => c.body);

  it('Pause and Resume: the commands and the panel send them; the markers, the status bar and Add check follow record:paused', async () => {
    const editor = await openFixture();
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    fake.pushRecord({ type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked "Menu"', atMs: 900 });
    await waitFor('action listed', () => hooks.recordingState()?.actions.length === 1);
    playToolbarControls();

    await vscode.commands.executeCommand('testbench-native.pauseRecording');
    await waitFor('paused', () => hooks.recordingState()?.paused === true);
    assert.deepEqual(controlBodies(), [{ action: 'pause' }]);
    assert.equal(hooks.recordingStatusText(), '❚❚ Recording paused — 1 action');
    assert.deepEqual(
      hooks.recordingState().actions.map((a) => [a.kind, a.summary]),
      [
        ['click', 'Clicked "Menu"'],
        ['pause', 'Paused'],
      ],
    );
    // A check is recording: paused, Add check asks nothing of the server.
    await vscode.commands.executeCommand('testbench-native.recordAddCheck');
    // Pause again is nothing to do.
    await vscode.commands.executeCommand('testbench-native.pauseRecording');
    assert.deepEqual(controlBodies(), [{ action: 'pause' }]);

    // The panel's Resume.
    await hooks.dispatchWebviewMessage({ type: 'recordPause', paused: false });
    await waitFor('resumed', () => hooks.recordingState()?.paused === false);
    assert.deepEqual(controlBodies(), [{ action: 'pause' }, { action: 'resume' }]);
    assert.equal(hooks.recordingStatusText(), '● Recording — 1 action');
    assert.deepEqual(hooks.recordingState().actions.map((a) => a.kind), ['click', 'pause', 'resume']);

    // Paused from the browser's toolbar: no control from here, the same rows.
    fake.pushRecord({ type: 'record:paused', paused: true, atMs: 12_000, source: 'toolbar' });
    await waitFor('paused from the toolbar', () => hooks.recordingState()?.paused === true);
    await vscode.commands.executeCommand('testbench-native.resumeRecording');
    await waitFor('resumed again', () => hooks.recordingState()?.paused === false);
    assert.deepEqual(controlBodies().map((b) => b.action), ['pause', 'resume', 'resume']);
    await cancelRecording();
  });

  it('Add Step to Recording sends add-step from the panel; the ✎ rows appear, drop by id, and strike on record:dropped', async () => {
    const editor = await openFixture();
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');
    let n = 0;
    playToolbarControls(async (body) => {
      if (body.action !== 'add-step') return;
      for (const text of body.text.split('\n')) {
        n += 1;
        fake.pushRecord({ type: 'record:step', id: `p${n}`, text, source: 'panel', afterStep: n - 1, atMs: 1_000 * n });
      }
    });

    // Several lines are several steps; numbers, markers and blank lines go.
    await vscode.commands.executeCommand('testbench-native.addStepToRecording', { text: '8. Verify the total\n\n- Click Pay' });
    assert.deepEqual(controlBodies(), [{ action: 'add-step', text: 'Verify the total\nClick Pay', source: 'panel' }]);
    await waitFor('two ✎ rows', () => hooks.recordingState()?.actions.length === 2);
    assert.deepEqual(
      hooks.recordingState().actions.map((a) => [a.id, a.kind, a.summary, a.source, a.dropped]),
      [
        ['p1', 'step', 'Verify the total', 'panel', false],
        ['p2', 'step', 'Click Pay', 'panel', false],
      ],
    );
    // The panel's box is the same gesture.
    await hooks.dispatchWebviewMessage({ type: 'recordAddStep', text: 'Sign out' });
    assert.deepEqual(controlBodies()[1], { action: 'add-step', text: 'Sign out', source: 'panel' });
    await waitFor('three ✎ rows', () => hooks.recordingState()?.actions.length === 3);

    // The ✕ on a step row drops it by the step's id.
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 'p2', dropped: true });
    assert.deepEqual(controlBodies()[2], { action: 'drop', id: 'p2' });
    assert.equal(hooks.recordingState().actions.find((a) => a.id === 'p2').dropped, true);
    // Undo in the browser strikes another; Restore puts the first back.
    fake.pushRecord({ type: 'record:dropped', id: 'p3', dropped: true, source: 'toolbar' });
    fake.pushRecord({ type: 'record:dropped', id: 'p2', dropped: false, source: 'toolbar' });
    await waitFor('struck and restored', () => {
      const rows = hooks.recordingState().actions;
      return rows.find((a) => a.id === 'p3').dropped && !rows.find((a) => a.id === 'p2').dropped;
    });

    // A step added from the panel is the recording's text: written into the
    // file by the drafts, locked, and taken out again by Cancel.
    pushDraft(1, ['Verify the total', 'Click Pay'], []);
    fake.pushRecord({ type: 'record:drafting', busy: true });
    fake.pushRecord({
      type: 'record:draft',
      revision: 2,
      steps: ['Verify the total', 'Click Pay'],
      parameters: [],
      locked: 2,
      authored: [0, 1],
      authoredIds: ['p1', 'p2'],
    });
    fake.pushRecord({ type: 'record:drafting', busy: false });
    await waitFor('the panel\'s steps in the file', () => editor.document.getText() === recorded(['Verify the total', 'Click Pay']));
    assert.deepEqual([hooks.recordingState().draft.locked, hooks.recordingState().draft.authored], [2, [0, 1]]);
    await cancelRecording();
    assert.equal(editor.document.getText(), FIXTURE);
  });

  it('a line typed under the recorded steps is sent when the cursor leaves it; the draft that holds it adopts it (never twice), later steps go below; Cancel keeps it', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    const steps = [];
    playToolbarControls(async (body) => {
      if (body.action !== 'add-step') return;
      steps.push(body);
      fake.pushRecord({ type: 'record:step', id: 's1', text: body.text, source: 'editor', afterStep: 1, atMs: 3_000 });
    });
    // End, Enter on "3. Click Menu", and a step typed on the new line.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13);
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: '4. Check the banner' });
    // As typed — whatever indentation the editor gave the new line included.
    const mine = editor.document.lineAt(12).text;
    assert.equal(mine.trim(), '4. Check the banner');
    await sleep(100);
    assert.equal(steps.length, 0, 'not counted while the cursor is on it');
    // A draft meanwhile goes above it, as below the block always did.
    pushDraft(2, D2);
    await waitFor('draft 2 above the typed line', () => editor.document.getText() === recorded(D2, { after: [mine] }));
    assert.equal(steps.length, 0);

    // The cursor leaves the line: one add-step, at the end, naming the draft
    // the author was looking at.
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await waitFor('add-step sent', () => steps.length === 1);
    assert.deepEqual(steps[0], { action: 'add-step', text: 'Check the banner', source: 'editor', revision: 2 });
    await waitFor('the line has its id', () => hooks.recordingAuthorLines()[0]?.stepId === 's1');

    // The server locks it in and records on below it.
    fake.pushRecord({
      type: 'record:draft',
      revision: 3,
      steps: [...D2, 'Check the banner', 'Tick Cash'],
      parameters: [],
      locked: 3,
      authored: [2],
      authoredIds: ['s1'],
    });
    // Its number is the recording's to give while the draft holds it.
    const adopted = fixtureWith({
      insert: { 11: ['3. Click Menu', '4. Click Payments', mine.replace('4.', '5.'), '6. Tick Cash'] },
      replace: { 12: '7. Open the dashboard' },
    });
    await waitFor('adopted, numbered on, the next step below it', () => editor.document.getText() === adopted);
    await sleep(100);
    assert.equal(editor.document.getText().split('Check the banner').length, 2, 'the step is in the file once');
    assert.deepEqual(hooks.recordingAuthorLines().map((l) => [l.status, l.stepId, l.inDraft]), [['sent', 's1', true]]);
    assert.deepEqual(hooks.recordingNotices(), [], 'nothing of the recording\'s was edited');
    // Moving about sends nothing more.
    editor.selection = new vscode.Selection(12, 2, 12, 2);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await sleep(100);
    assert.equal(steps.length, 1);

    // Cancel: the recording's lines out, the author's kept — with the number
    // they gave it.
    await cancelRecording();
    assert.equal(editor.document.getText(), fixtureWith({ insert: { 11: [mine] } }));
  });

  it('a typed line the server does not take is logged by its line number, never quoted — it may hold a secret the server refused', async () => {
    const editor = await openFixture();
    await recordDraft1(editor);
    const secret = 'pw-from-env-77';
    playToolbarControls(async (body) =>
      body.action === 'add-step' ? { ignored: true, reason: 'it holds a secret — write {{password}} in its place' } : undefined,
    );
    const mark = hooks.hostMessageCount();
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13);
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: `Type ${secret} into the Password field` });
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const warned = () =>
      hooks
        .hostMessagesSince(mark)
        .filter((m) => m.type === 'runEvent' && m.event.type === 'output' && m.event.kind === 'warn')
        .map((m) => m.event.msg);
    await waitFor('the refusal logged', () => warned().some((msg) => msg.includes('was not added')));
    assert.deepEqual(
      warned().filter((msg) => msg.includes('was not added')),
      [
        'Your step on line 13 was not added to the recording (it holds a secret — write {{password}} in its place); ' +
          'it stays in the file as you wrote it.',
      ],
    );
    assert.ok(!JSON.stringify(hooks.hostMessagesSince(mark)).includes(secret), 'the value is in no message to the panel');
    assert.ok(editor.document.lineAt(12).text.includes(secret), 'the line stays the author\'s');
    await cancelRecording();
  });

  it('a line typed between two recorded steps: add-step with afterStep and revision; locked lines only renumbered; one Ctrl+Z after Stop leaves the typed line', async () => {
    const editor = await openFixture();
    await recordDraft1(editor, D2);
    const sent = [];
    playToolbarControls(async (body) => {
      if (body.action !== 'add-step') return;
      sent.push(body);
      fake.pushRecord({ type: 'record:step', id: 's1', text: body.text, source: 'editor', afterStep: 0, atMs: 3_000 });
      fake.pushRecord({
        type: 'record:draft',
        revision: 2,
        steps: ['Click Menu', 'Verify the menu is open', 'Click Payments'],
        parameters: [],
        locked: 3,
        authored: [1],
        authoredIds: ['s1'],
      });
    });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13); // the end of "3. Click Menu"
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: '4. Verify the menu is open' });
    const mine = editor.document.lineAt(12).text;
    assert.equal(mine.trim(), '4. Verify the menu is open');
    assert.deepEqual(hooks.recordingNotices(), [], 'a new line between steps is not an edit of the recorded ones');
    /** FIXTURE with `after` recorded after line 11, the author's line among them. */
    const withMine = (...after) =>
      fixtureWith({
        insert: { 11: ['3. Click Menu', mine, ...after.map((s, k) => `${5 + k}. ${s}`)] },
        replace: { 12: `${5 + after.length}. Open the dashboard` },
      });
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await waitFor('add-step sent', () => sent.length === 1);
    // After step 0 ("Click Menu") of revision 1, the draft the author saw.
    assert.deepEqual(sent[0], { action: 'add-step', text: 'Verify the menu is open', source: 'editor', afterStep: 0, revision: 1 });
    // "4. Click Payments" is locked: only its number moves on.
    await waitFor('the draft that holds it, around it', () => editor.document.getText() === withMine('Click Payments'));
    assert.equal(editor.document.getText().split('Verify the menu is open').length, 2, 'once');

    answerStopWith({ steps: ['Click Menu', 'Verify the menu is open', 'Click Payments', 'Tick Cash'] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().status, 'inserted');
    assert.equal(editor.document.getText(), withMine('Click Payments', 'Tick Cash'));
    // One Ctrl+Z: the file without the recording — the author's typed line
    // still there.
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo', () => editor.document.getText() === fixtureWith({ insert: { 11: [mine] } }));
  });

  it('the toolbar\'s place (record:toolbar) is remembered and sent in the next start body; the setting turns the toolbar off', async () => {
    const cfg = () => vscode.workspace.getConfiguration('testbench-native');
    await hooks.setRecordingToolbar(undefined);
    try {
      const editor = await openFixture();
      const first = await recordAt(editor, 11);
      assert.deepEqual(first.toolbar, { enabled: true }, 'on by default, placed by the server');
      fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
      fake.pushRecord({ type: 'record:toolbar', dock: 'tl', minimised: true });
      await waitFor('remembered', () => hooks.recordingToolbar()?.dock === 'tl');
      assert.deepEqual(hooks.recordingToolbar(), { dock: 'tl', minimised: true });
      await cancelRecording();

      const second = await recordAt(editor, 11);
      assert.deepEqual(second.toolbar, { enabled: true, dock: 'tl', minimised: true });
      await cancelRecording();

      await cfg().update('recordSteps.browserToolbar', false, vscode.ConfigurationTarget.Global);
      const third = await recordAt(editor, 11);
      assert.deepEqual(third.toolbar, { enabled: false, dock: 'tl', minimised: true });
      await cancelRecording();
    } finally {
      await cfg().update('recordSteps.browserToolbar', undefined, vscode.ConfigurationTarget.Global);
      await hooks.setRecordingToolbar(undefined);
    }
  });

  // ---- The review of 0.5.155: lines sent before a draft holds the one next
  // to them, lines counted when the author leaves the editor or stops, Undo
  // of a typed step, the one-shot insertion, and the Add step box's answer.

  /**
   * The fake server's side of the author's add-steps, as draft-engine.ts
   * places them (FakeServer in tests/record-steps-authored.test.js): each
   * step after the step `afterStep` names in the draft `revision` names — that
   * step's text, found nearest its index now — or at the end; then
   * `record:step`, and the draft that holds it. `lag`: that draft waits for
   * `release()` (one draft per call). `extra` sees every other control.
   */
  function playAuthorSteps(initial, revision, { lag = false, extra = async () => {} } = {}) {
    const steps = initial.map((text) => ({ text }));
    const history = new Map([[revision, [...initial]]]);
    let rev = revision;
    let ids = 0;
    const held = [];
    const sent = [];
    const texts = () => steps.map((s) => s.text);
    const draftNow = () => {
      rev += 1;
      history.set(rev, texts());
      const authored = [];
      const authoredIds = [];
      steps.forEach((s, i) => {
        if (s.id) {
          authored.push(i);
          authoredIds.push(s.id);
        }
      });
      return { type: 'record:draft', revision: rev, steps: texts(), parameters: [], locked: steps.length, authored, authoredIds };
    };
    const mapIndex = (afterStep, revisionSeen) => {
      const clamp = (i) => Math.max(0, Math.min(i, steps.length - 1));
      const text = history.get(revisionSeen)?.[afterStep];
      if (text === undefined) return clamp(afterStep);
      let best = -1;
      steps.forEach((s, i) => {
        if (s.text === text && (best < 0 || Math.abs(i - afterStep) < Math.abs(best - afterStep))) best = i;
      });
      return best >= 0 ? best : clamp(afterStep);
    };
    playToolbarControls(async (body) => {
      if (body.action !== 'add-step') return extra(body);
      sent.push(body);
      const at = body.afterStep === undefined ? undefined : mapIndex(body.afterStep, body.revision);
      const made = body.text.split('\n').map((text) => ({ text, id: `s${++ids}` }));
      if (at === undefined || at >= steps.length - 1) steps.push(...made);
      else steps.splice(at + 1, 0, ...made);
      for (const s of made) fake.pushRecord({ type: 'record:step', id: s.id, text: s.text, source: 'editor', afterStep: steps.indexOf(s) - 1, atMs: 3_000 });
      const draft = draftNow();
      if (lag) held.push(draft);
      else fake.pushRecord(draft);
      return undefined;
    });
    return {
      sent,
      texts,
      /** The next draft that waited, into the stream. */
      release: () => fake.pushRecord(held.shift()),
      /** Stop answered with the server's steps, and `more` after them. */
      stopWith: (more = []) => {
        extra = async (body) => {
          if (body.action !== 'stop') return;
          fake.pushRecord({ type: 'record:writing' });
          fake.pushRecord({ type: 'record:result', steps: [...texts(), ...more], parameters: [] });
          fake.pushRecord({ type: 'done', status: 'passed' });
          fake.endRecord();
        };
      },
    };
  }

  it('two lines typed one after the other between recorded steps: the second waits for the draft that holds the first, then goes after it, naming that draft — the order holds and Stop writes over it', async () => {
    const editor = await openFixture();
    await recordDraft1(editor, D2);
    const server = playAuthorSteps(D2, 1, { lag: true });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13); // the end of "3. Click Menu"
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: '4. Verify A' });
    // Enter: the cursor moves to a new line — A is left.
    await vscode.commands.executeCommand('type', { text: '\n' });
    await waitFor('A sent', () => server.sent.length === 1);
    assert.deepEqual(server.sent[0], { action: 'add-step', text: 'Verify A', source: 'editor', afterStep: 0, revision: 1 });
    await vscode.commands.executeCommand('type', { text: '5. Verify B' });
    const mineA = editor.document.lineAt(12).text;
    const mineB = editor.document.lineAt(13).text;
    assert.deepEqual([mineA.trim(), mineB.trim()], ['4. Verify A', '5. Verify B']);
    editor.selection = new vscode.Selection(0, 0, 0, 0); // B is left
    await sleep(150);
    assert.equal(server.sent.length, 1, 'B waits: it would name the step A names, and land in front of it');
    // The draft that holds A reaches the file: B goes, after A.
    server.release();
    await waitFor('B sent', () => server.sent.length === 2);
    assert.deepEqual(server.sent[1], { action: 'add-step', text: 'Verify B', source: 'editor', afterStep: 1, revision: 2 });
    server.release();
    await waitFor('both held, in the order they were typed', () =>
      editor.document.getText() === fixtureWith({ insert: { 11: ['3. Click Menu', mineA, mineB, '6. Click Payments'] }, replace: { 12: '7. Open the dashboard' } }),
    );
    assert.deepEqual(server.texts(), ['Click Menu', 'Verify A', 'Verify B', 'Click Payments']);
    assert.deepEqual(hooks.recordingNotices(), [], 'the file was never given up on');
    server.stopWith(['Tick Cash']);
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().status, 'inserted');
    assert.equal(
      editor.document.getText(),
      fixtureWith({ insert: { 11: ['3. Click Menu', mineA, mineB, '6. Click Payments', '7. Tick Cash'] }, replace: { 12: '8. Open the dashboard' } }),
      'the result over the draft: each line once',
    );
  });

  it('a line typed in the file counts when the window loses focus (the author went to the browser), and Stop sends the line the cursor is still on — then stops', async () => {
    const editor = await openFixture();
    await recordDraft1(editor, D2);
    const server = playAuthorSteps(D2, 1);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13); // the end of "3. Click Menu"
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: '4. Verify A' });
    const mineA = editor.document.lineAt(12).text;
    await sleep(150);
    assert.equal(server.sent.length, 0, 'the cursor is still on it');
    hooks.recordingWindowFocus(false);
    await waitFor('sent when the window lost focus', () => server.sent.length === 1);
    assert.deepEqual(server.sent[0], { action: 'add-step', text: 'Verify A', source: 'editor', afterStep: 0, revision: 1 });
    await waitFor('held', () =>
      editor.document.getText() === fixtureWith({ insert: { 11: ['3. Click Menu', mineA, '5. Click Payments'] }, replace: { 12: '6. Open the dashboard' } }),
    );
    // Regaining focus counts nothing.
    hooks.recordingWindowFocus(true);
    // A line under the last recorded step, the cursor left on it, and Stop.
    editor.selection = new vscode.Selection(13, 17, 13, 17); // the end of "5. Click Payments"
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: 'Verify B' });
    await sleep(150);
    assert.equal(server.sent.length, 1);
    server.stopWith(['Tick Cash']);
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.deepEqual(
      controlBodies().map((b) => [b.action, b.text]),
      [
        ['add-step', 'Verify A'],
        ['add-step', 'Verify B'],
        ['stop', undefined],
      ],
      'the line goes to the server before Stop',
    );
    assert.equal(controlBodies()[1].afterStep, undefined, 'below everything recorded');
    assert.equal(hooks.recordingReport().status, 'inserted');
    assert.equal(
      editor.document.getText(),
      fixtureWith({ insert: { 11: ['3. Click Menu', mineA, '5. Click Payments', '6. Verify B', '7. Tick Cash'] }, replace: { 12: '8. Open the dashboard' } }),
    );
  });

  it('Undo in the browser of a step typed in the file takes its line out and Restore puts it back; the panel\'s ✕ does the same; a line edited since stays, said once', async () => {
    const editor = await openFixture();
    await recordDraft1(editor, D2);
    const server = playAuthorSteps(D2, 1);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13);
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: '4. Verify A' });
    const mine = editor.document.lineAt(12).text;
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const heldText = fixtureWith({ insert: { 11: ['3. Click Menu', mine, '5. Click Payments'] }, replace: { 12: '6. Open the dashboard' } });
    await waitFor('held', () => editor.document.getText() === heldText);
    await waitFor('its row', () => hooks.recordingState()?.actions.some((a) => a.id === 's1'));
    const row = () => hooks.recordingState().actions.find((a) => a.id === 's1');

    // The toolbar's Undo: the row struck, the line out.
    fake.pushRecord({ type: 'record:dropped', id: 's1', dropped: true, source: 'toolbar' });
    await waitFor('the line is out', () => editor.document.getText() === recorded(D2));
    assert.equal(row().dropped, true);
    // The server's draft without it changes nothing more.
    fake.pushRecord({ type: 'record:draft', revision: 10, steps: D2, parameters: [] });
    await sleep(100);
    assert.equal(editor.document.getText(), recorded(D2));
    // Restore in the browser: back where it was, adopted when the server's
    // draft holds it again.
    fake.pushRecord({ type: 'record:dropped', id: 's1', dropped: false, source: 'toolbar' });
    await waitFor('back', () => editor.document.getText().includes(`3. Click Menu\n${mine}\n`));
    fake.pushRecord({ type: 'record:draft', revision: 11, steps: ['Click Menu', 'Verify A', 'Click Payments'], parameters: [], authored: [1], authoredIds: ['s1'] });
    await waitFor('held again', () => editor.document.getText() === heldText);

    // The panel's ✕, and its ↺.
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 's1', dropped: true });
    await waitFor('out by the panel', () => editor.document.getText() === recorded(D2));
    assert.deepEqual(controlBodies().slice(-1), [{ action: 'drop', id: 's1' }]);
    await hooks.dispatchWebviewMessage({ type: 'recordDrop', id: 's1', dropped: false });
    await waitFor('back by the panel', () => editor.document.getText().includes(`3. Click Menu\n${mine}\n`));
    fake.pushRecord({ type: 'record:draft', revision: 12, steps: ['Click Menu', 'Verify A', 'Click Payments'], parameters: [], authored: [1], authoredIds: ['s1'] });
    await waitFor('held once more', () => editor.document.getText() === heldText);

    // Edited since: it stays, and the log says so once.
    const mark = hooks.hostMessageCount();
    editor.selection = new vscode.Selection(12, mine.length, 12, mine.length);
    await vscode.commands.executeCommand('type', { text: '!' });
    fake.pushRecord({ type: 'record:dropped', id: 's1', dropped: true, source: 'toolbar' });
    await waitFor('struck', () => row().dropped === true);
    await sleep(150);
    assert.equal(editor.document.lineAt(12).text, `${mine}!`, 'the edited line stays');
    const said = () =>
      hooks
        .hostMessagesSince(mark)
        .filter((m) => m.type === 'runEvent' && m.event.type === 'output' && /was left in the file because you edited it/.test(m.event.msg))
        .map((m) => m.event.msg);
    assert.deepEqual(said(), ['Your step 4 was left in the file because you edited it — delete it if you meant to.']);
    fake.pushRecord({ type: 'record:draft', revision: 13, steps: D2, parameters: [] });
    await sleep(100);
    assert.equal(said().length, 1, 'said once');
    await cancelRecording();
    assert.equal(editor.document.getText(), fixtureWith({ insert: { 11: [`${mine}!`] } }), 'Cancel keeps the author\'s line');
  });

  it('what the recording wrote cannot be found any more, with a line the author typed among it: Stop inserts the result once — without that step, whose line is still there', async () => {
    const editor = await openFixture();
    await recordDraft1(editor, D2);
    playAuthorSteps(D2, 1);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selection = new vscode.Selection(11, 13, 11, 13);
    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: '4. Verify A' });
    const mine = editor.document.lineAt(12).text;
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await waitFor('held', () =>
      editor.document.getText() === fixtureWith({ insert: { 11: ['3. Click Menu', mine, '5. Click Payments'] }, replace: { 12: '6. Open the dashboard' } }),
    );
    // Cut across the recording's edge: from the anchor line into "3. Click Menu".
    assert.ok(await editor.edit((b) => b.delete(new vscode.Range(10, 12, 11, 10))));
    pushDraft(3, ['Click Menu', 'Verify A', 'Click Payments', 'Tick Cash']);
    await waitFor('given up on', () => hooks.recordingNotices().length === 1);
    answerStopWith({ steps: ['Click Menu', 'Verify A', 'Click Payments', 'Tick Cash'] });
    await vscode.commands.executeCommand('testbench-native.stopRecording');
    await hooks.recordingSettled();
    assert.equal(hooks.recordingReport().status, 'inserted');
    assert.equal(hooks.recordingReport().steps, 3, 'the author\'s step is not inserted again');
    const text = editor.document.getText();
    assert.equal(text.split('Verify A').length, 2, 'the author\'s line is in the file once');
    // Their line where they typed it — renumbered with the rest of the flow
    // below the insertion, as a one-shot insertion renumbers every step there.
    assert.equal(mine, '4. Verify A');
    assert.match(text, /\n\d+\. Verify A\n/, text);
  });

  it('the panel\'s Add step box is answered by its id: the server took the steps, or did not and why', async () => {
    const editor = await openFixture();
    await recordAt(editor, 11);
    fake.pushRecord({ type: 'record:started', url: 'https://example.test/', title: '' });
    await waitFor('recording', () => hooks.recordingState()?.phase === 'recording');
    let answer;
    playToolbarControls(async (body) => (body.action === 'add-step' ? answer : undefined));
    const answers = (mark) => hooks.hostMessagesSince(mark).filter((m) => m.type === 'recordAddStepResult');
    let mark = hooks.hostMessageCount();
    await hooks.dispatchWebviewMessage({ type: 'recordAddStep', text: 'Verify the total', id: 'add-1' });
    assert.deepEqual(controlBodies().slice(-1), [{ action: 'add-step', text: 'Verify the total', source: 'panel' }]);
    assert.deepEqual(answers(mark), [{ type: 'recordAddStepResult', id: 'add-1', accepted: true }]);
    // A 202 that did nothing: not taken, and why — no notification, the box says it.
    answer = { ignored: true, reason: 'Stop was pressed' };
    mark = hooks.hostMessageCount();
    await hooks.dispatchWebviewMessage({ type: 'recordAddStep', text: 'Click Pay', id: 'add-2' });
    assert.deepEqual(answers(mark), [{ type: 'recordAddStepResult', id: 'add-2', accepted: false, reason: 'Stop was pressed' }]);
    // A box of blank lines never reaches the server.
    answer = undefined;
    const calls = fake.recordControlCalls.length;
    mark = hooks.hostMessageCount();
    await hooks.dispatchWebviewMessage({ type: 'recordAddStep', text: '7.\n  - ', id: 'add-3' });
    assert.equal(fake.recordControlCalls.length, calls);
    assert.deepEqual(answers(mark), [{ type: 'recordAddStepResult', id: 'add-3', accepted: false, reason: 'an empty step adds nothing' }]);
    await cancelRecording();
    // Nothing recording: refused, said.
    mark = hooks.hostMessageCount();
    await hooks.dispatchWebviewMessage({ type: 'recordAddStep', text: 'Verify', id: 'add-4' });
    assert.deepEqual(answers(mark), [{ type: 'recordAddStepResult', id: 'add-4', accepted: false, reason: 'nothing is recording' }]);
  });

  it('Cancel pressed in the browser ends quietly: the drafts come out of the file, a line in the log, no error', async () => {
    const editor = await openFixture();
    await recordDraft1(editor, D2);
    const mark = hooks.hostMessageCount();
    fake.pushRecord({ type: 'done', status: 'aborted', cancelledBy: 'browser' });
    fake.endRecord();
    await hooks.recordingSettled();
    const report = hooks.recordingReport();
    assert.equal(report.status, 'cancelled');
    assert.equal(report.by, 'browser');
    assert.deepEqual(report.messages, [], 'no notification');
    assert.equal(editor.document.getText(), FIXTURE);
    const logged = hooks
      .hostMessagesSince(mark)
      .filter((m) => m.type === 'runEvent' && m.event.type === 'output')
      .map((m) => m.event);
    assert.ok(
      logged.some((e) => e.kind === 'info' && e.msg === 'Recording cancelled in the browser — nothing was written.'),
      JSON.stringify(logged),
    );
    assert.ok(!logged.some((e) => e.kind === 'error'), JSON.stringify(logged));
  });
});
