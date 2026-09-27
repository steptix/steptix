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
});
