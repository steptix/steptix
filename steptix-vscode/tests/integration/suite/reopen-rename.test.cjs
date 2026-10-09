/**
 * A test file that is closed and opened again, or renamed, must run the text
 * it has now (issue 50).
 *
 * The registry caches one RunController per document URI. VS Code keeps a
 * CLOSED TextDocument readable with its last text and hands out a NEW object
 * when the file is opened again, so a controller that kept its first document
 * ran that frozen text — old steps, and old `sourceLines` that the server
 * echoes back on `step:start`, painting the running dot on old line numbers.
 *
 * Closing a document is not instant, and how long it waits depends on who
 * opened it. An editor's document closes once its last editor does. One an
 * extension opened with `openTextDocument` (the Test Explorer run does) is held
 * by VS Code for up to three minutes, or until about sixty newer ones push it
 * out (MainThreadDocuments' BoundModelReferenceCollection) — `closeDocument`
 * below does the pushing rather than waiting.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR ||
  path.resolve(__dirname, '..', 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* retry */ }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/**
 * A test whose step 1 sits on `firstStepLine`: a heading, prose filler, then
 * `## Steps` on the line before. Two steps, so a breakpoint on step 2 leaves
 * something to Continue into.
 */
function testText(firstStepLine, words) {
  const lines = [`# ${words} test`, ''];
  while (lines.length < firstStepLine - 3) lines.push(`Prose line ${lines.length + 1}.`);
  lines.push('');
  lines.push('## Steps');
  lines.push(`1. ${words} first step`);
  lines.push(`2. ${words} second step`);
  lines.push('');
  assert.equal(lines.indexOf(`1. ${words} first step`) + 1, firstStepLine);
  return lines.join('\n');
}

const isOpen = (uri) =>
  vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());

/**
 * Close every editor and wait until VS Code has actually closed `uri`'s
 * document — `onDidCloseTextDocument` for it — so the next open is a new
 * TextDocument object.
 *
 * If closing the editors is not enough within a second, the document is being
 * held by an `openTextDocument` reference: open enough throwaway documents to
 * push it out of VS Code's bounded collection of those, which keeps fifty and
 * drops the oldest ten when it reaches sixty.
 *
 * Returns how it closed: 'editor', 'evicted', or 'already' (it was not open).
 */
async function closeDocument(uri) {
  const key = uri.toString();
  if (!isOpen(uri)) return 'already';
  let closed = false;
  const sub = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (doc.uri.toString() === key) closed = true;
  });
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      await waitFor(`${path.basename(uri.fsPath)} closed with its editor`, () => closed, 1_000);
      return 'editor';
    } catch {
      // Held by an openTextDocument reference — evict it below.
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stx-evict-'));
    try {
      for (let i = 0; i < 70 && !closed; i++) {
        const file = path.join(dir, `evict-${i}.txt`);
        fs.writeFileSync(file, `${i}\n`);
        await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      }
      await waitFor(`${path.basename(uri.fsPath)} closed after eviction`, () => closed, 5_000);
      return 'evicted';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  } finally {
    sub.dispose();
  }
}

describe('Steptix: a reopened or renamed test runs its current text (issue 50)', function () {
  this.timeout(60_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  /** Files this suite wrote, removed in `afterEach`. */
  let written = [];

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
    await hooks.discoveryReady();
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
    written = [];
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('steptix.stop');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    for (const file of written) {
      try { fs.rmSync(file, { force: true, maxRetries: 5 }); } catch { /* ignore */ }
    }
  });

  /** Write a test file into the workspace and remember it for cleanup. */
  function writeTest(name, text) {
    const file = path.resolve(FIXTURES_DIR, name);
    fs.writeFileSync(file, text, 'utf-8');
    if (!written.includes(file)) written.push(file);
    return vscode.Uri.file(file);
  }

  /** Open `uri` in an editor and wait until Steptix treats it as the active test. */
  async function openTest(uri) {
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('editor active', () =>
      vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    );
    await waitFor('active file detected as a test', () => hooks.tracker.snapshot().isTestFile === true);
    const editor = vscode.window.activeTextEditor;
    // Cursor only: Run Selected reads that as "run the whole test".
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    return editor;
  }

  /** Run the active test to the end: every step passes, as the server would
   *  report them — on the `sourceLines` the request sent. */
  async function runAllToEnd() {
    const before = fake.requests.length;
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('run requested', () => fake.requests.length > before);
    const request = fake.requests[fake.requests.length - 1];
    for (const line of request.sourceLines) {
      fake.push({ type: 'step:start', line });
      fake.push({ type: 'step:pass', line });
    }
    fake.end();
    await waitFor('idle after the run', () => !hooks.isRunning());
    return request;
  }

  describe('reproduction', () => {
    it('editor run: close, change the file on disk, reopen — the run sends the new text and lines', async () => {
      const uri = writeTest('reopen-editor.tmp.md', testText(15, 'Old'));
      await openTest(uri);
      const first = await runAllToEnd();
      assert.equal(first.steps[0], 'Old first step');
      assert.equal(first.sourceLines[0], 15);

      const how = await closeDocument(uri);
      fs.writeFileSync(uri.fsPath, testText(10, 'New'), 'utf-8');
      const editor = await openTest(uri);
      assert.equal(editor.document.lineAt(9).text, '1. New first step', 'the editor shows the new text');

      const closesBefore = fake.closeSessionIds.length;
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('second run requested', () => fake.requests.length > 1);
      const second = fake.requests[1];
      const sent = `sent ${JSON.stringify(second.steps)} on lines ${JSON.stringify(second.sourceLines)} (document closed: ${how})`;
      assert.equal(second.steps[0], 'New first step', `the run must send the text the editor shows; ${sent}`);
      assert.equal(second.sourceLines[0], 10, `the run must send the line numbers the editor shows; ${sent}`);
      // Rewritten in place, it is still the same file: an edit made while the
      // tab was closed, which carries on in the session as one made with it
      // open does.
      assert.deepEqual(fake.closeSessionIds.slice(closesBefore), [], 'the session is reused');

      // The server echoes the request's line back; the dot lands on line 10.
      fake.push({ type: 'step:start', line: second.sourceLines[0] });
      await waitFor('running on line 10', () =>
        Object.fromEntries(hooks.tracker.snapshot().statuses)[10] === 'running',
      );
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());
    });

    it('Test Explorer run: close, change the file on disk, run again — the run sends the new text and lines', async () => {
      const uri = writeTest('reopen-batch.tmp.md', testText(15, 'Old'));
      await hooks.discoveryRefresh();
      const pass = async (f) => {
        const request = f.requests[f.requests.length - 1];
        for (const line of request.sourceLines) {
          f.push({ type: 'step:start', line });
          f.push({ type: 'step:pass', line });
        }
        f.end();
      };
      fake.streamScripts = [pass, pass];

      await hooks.runBatchByUris([uri]);
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].steps[0], 'Old first step');
      assert.equal(fake.requests[0].sourceLines[0], 15);

      // The batch run opened the document itself, so no editor holds it.
      assert.ok(isOpen(uri), 'precondition: the batch run left its document open');
      const how = await closeDocument(uri);
      fs.writeFileSync(uri.fsPath, testText(10, 'New'), 'utf-8');
      await hooks.discoveryRefresh();

      await hooks.runBatchByUris([uri]);
      assert.equal(fake.requests.length, 2);
      const second = fake.requests[1];
      const sent = `sent ${JSON.stringify(second.steps)} on lines ${JSON.stringify(second.sourceLines)} (document closed: ${how})`;
      assert.equal(second.steps[0], 'New first step', `the run must send the file as it is now; ${sent}`);
      assert.equal(second.sourceLines[0], 10, `the run must send the line numbers the file has now; ${sent}`);

      // Issue 032: the controller's run counter is what keeps two batch runs
      // of one path in two sessions, so it must survive the new document.
      assert.equal(fake.streamSessionIds.length, 2);
      for (const id of fake.streamSessionIds) assert.match(id, /::run-\d+$/, id);
      assert.notEqual(fake.streamSessionIds[0], fake.streamSessionIds[1], 'two runs, two sessions');
    });
  });

  describe('what the controller holds survives its tab closing', () => {
    it('a test paused at a breakpoint survives closing and reopening its tab, and Continue resumes it', async () => {
      const uri = writeTest('reopen-paused.tmp.md', testText(15, 'Paused'));
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(15, 0)), true),
      ]);
      await openTest(uri);
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('run requested', () => fake.requests.length === 1);
      assert.deepEqual(fake.requests[0].sourceLines, [15], 'the run stops short of the breakpoint');
      fake.push({ type: 'step:start', line: 15 });
      fake.push({ type: 'step:pass', line: 15 });
      fake.end();
      await waitFor('parked at line 16', () => hooks.tracker.snapshot().breakpointStop === 16);
      await waitFor('idle while parked', () => !hooks.isRunning());
      assert.equal(hooks.keepAliveActive(), true, 'a parked run pins its session');

      await closeDocument(uri);
      assert.equal(hooks.keepAliveActive(), true, 'closing the tab must not end the parked run');

      await openTest(uri);
      await waitFor('the pause shows again', () => hooks.tracker.snapshot().breakpointStop === 16);
      const closesBefore = fake.closeSessionIds.length;
      void vscode.commands.executeCommand('steptix.continueRun');
      await waitFor('continue requested', () => fake.requests.length === 2);
      assert.deepEqual(fake.requests[1].sourceLines, [16], 'Continue resumes at the paused step');
      assert.equal(fake.streamSessionIds[1], fake.streamSessionIds[0], 'in the same session');
      assert.deepEqual(fake.closeSessionIds.slice(closesBefore), [], 'nothing closed the session');
      fake.push({ type: 'step:start', line: 16 });
      fake.push({ type: 'step:pass', line: 16 });
      fake.end();
      await waitFor('idle after Continue', () => !hooks.isRunning());
      assert.equal(hooks.tracker.snapshot().breakpointStop, null);
      assert.equal(hooks.keepAliveActive(), false, 'the finished run lets its session go');
    });

    it('a running test keeps running after its tab closes, paints the reopened editor, and Stop stops it', async () => {
      const uri = writeTest('reopen-running.tmp.md', testText(15, 'Running'));
      await openTest(uri);
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({ type: 'step:start', line: 15 });
      await waitFor('running on 15', () =>
        Object.fromEntries(hooks.tracker.snapshot().statuses)[15] === 'running',
      );

      await closeDocument(uri);
      assert.equal(hooks.isRunning(), true, 'closing the tab must not stop the run');
      assert.equal(fake.hasActiveStream, true);
      fake.push({ type: 'step:pass', line: 15 });
      fake.push({ type: 'step:start', line: 16 });

      await openTest(uri);
      await waitFor('the reopened editor shows step 2 running', () =>
        Object.fromEntries(hooks.tracker.snapshot().statuses)[16] === 'running',
      );
      assert.equal(hooks.runningContextValue(), true, 'Stop and Pause show for the reopened file');

      await vscode.commands.executeCommand('steptix.stop');
      await waitFor('idle after Stop', () => !hooks.isRunning());
      assert.equal(Object.fromEntries(hooks.tracker.snapshot().statuses)[16], 'stopped');
      assert.equal(fake.requests.length, 1, 'still the one run');
    });

    it('Stop still stops a running test whose tab is closed', async () => {
      const uri = writeTest('reopen-stop-closed.tmp.md', testText(15, 'Closed'));
      await openTest(uri);
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({ type: 'step:start', line: 15 });

      await closeDocument(uri);
      assert.equal(hooks.isRunning(), true);
      await vscode.commands.executeCommand('steptix.stop');
      await waitFor('idle after Stop', () => !hooks.isRunning());
      assert.equal(fake.hasActiveStream, false, 'the stream was aborted');
    });

    it('the same file, closed and reopened unchanged, carries on in its session', async () => {
      const uri = writeTest('reopen-same.tmp.md', testText(15, 'Same'));
      await openTest(uri);
      await runAllToEnd();
      await closeDocument(uri);
      await openTest(uri);
      const closesBefore = fake.closeSessionIds.length;
      const second = await runAllToEnd();
      assert.equal(second.sourceLines[0], 15);
      assert.deepEqual(fake.closeSessionIds.slice(closesBefore), [], 'the session is reused, not closed');
      assert.equal(fake.streamSessionIds[1], fake.streamSessionIds[0]);
    });

    it('an edit saved in VS Code keeps the session: a save is not a different file', async () => {
      // The file's on-disk identity is what tells "renamed onto this path"
      // apart from "edited". A save that wrote a new file would make every
      // save look like a rename and throw the session away.
      const uri = writeTest('reopen-saved.tmp.md', testText(15, 'Saved'));
      const editor = await openTest(uri);
      await runAllToEnd();
      assert.ok(await editor.edit((b) => b.insert(new vscode.Position(2, 0), 'One more line.\n')));
      assert.ok(await editor.document.save(), 'saved');
      const closesBefore = fake.closeSessionIds.length;
      const second = await runAllToEnd();
      assert.equal(second.sourceLines[0], 16, 'the run sends the saved text');
      assert.deepEqual(fake.closeSessionIds.slice(closesBefore), [], 'the session is reused, not closed');
    });
  });

  // Run ABC1 and ABC2, rename ABC2 → ABC3 and then ABC1 → ABC2, and run ABC2
  // again. The file now called ABC2 is the old ABC1: it must run ABC1's text,
  // and it must not run inside the old ABC2's browser session — an
  // interactive session is named after the file's path, so ABC2's is still
  // open on the server under exactly the name the renamed file now has.
  describe('a file renamed onto the name of another test that ran', () => {
    /** Run the active test to the end and say which sessions it closed and
     *  ran in. A fresh controller closes its file's session before its first
     *  run; one that is reused carries on in the session it has. */
    async function runAndWatchSessions() {
      const closesBefore = fake.closeSessionIds.length;
      const request = await runAllToEnd();
      return {
        request,
        closed: fake.closeSessionIds.slice(closesBefore),
        session: fake.streamSessionIds[fake.streamSessionIds.length - 1],
      };
    }

    function setUp() {
      return {
        abc1: writeTest('rename-abc1.tmp.md', testText(15, 'One')),
        abc2: writeTest('rename-abc2.tmp.md', testText(12, 'Two')),
        abc3: (() => {
          const file = path.resolve(FIXTURES_DIR, 'rename-abc3.tmp.md');
          written.push(file);
          return vscode.Uri.file(file);
        })(),
      };
    }

    async function runBoth({ abc1, abc2 }) {
      await openTest(abc1);
      const one = await runAndWatchSessions();
      assert.equal(one.request.steps[0], 'One first step');
      await openTest(abc2);
      const two = await runAndWatchSessions();
      assert.equal(two.request.steps[0], 'Two first step');
    }

    /** Rename through VS Code, the way the Explorer does it. */
    async function renameInVSCode(from, to) {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(from, to);
      assert.ok(await vscode.workspace.applyEdit(edit), `rename ${path.basename(from.fsPath)}`);
    }

    /** What a run of the old ABC1, now named ABC2, must look like. */
    async function assertRunsAsOldAbc1(abc2) {
      const editor = await openTest(abc2);
      assert.equal(editor.document.lineAt(14).text, '1. One first step', 'ABC2 now holds ABC1\'s text');
      const { request, closed, session } = await runAndWatchSessions();
      const sent = `sent ${JSON.stringify(request.steps)} on lines ${JSON.stringify(request.sourceLines)}`;
      assert.equal(request.steps[0], 'One first step', `ABC2 must run the text it has now; ${sent}`);
      assert.equal(request.sourceLines[0], 15, `ABC2 must send the lines it has now; ${sent}`);
      assert.ok(samePath(session, abc2.fsPath), session);
      assert.ok(
        closed.some((id) => samePath(id, abc2.fsPath)),
        `ABC2 must start in a fresh session, not the old ABC2's; closed before the run: ${JSON.stringify(closed)}`,
      );
    }

    it('renamed in VS Code: ABC2 runs ABC1\'s text in a fresh session, and ABC3 runs the old ABC2', async () => {
      const files = setUp();
      await runBoth(files);
      await renameInVSCode(files.abc2, files.abc3);
      await renameInVSCode(files.abc1, files.abc2);

      await assertRunsAsOldAbc1(files.abc2);

      await openTest(files.abc3);
      const three = await runAndWatchSessions();
      assert.equal(three.request.steps[0], 'Two first step');
      assert.equal(three.request.sourceLines[0], 12);
      assert.ok(three.closed.some((id) => samePath(id, files.abc3.fsPath)), JSON.stringify(three.closed));
    });

    it('renamed on disk while closed: ABC2 runs ABC1\'s text in a fresh session', async () => {
      const files = setUp();
      await runBoth(files);
      await closeDocument(files.abc1);
      await closeDocument(files.abc2);
      fs.renameSync(files.abc2.fsPath, files.abc3.fsPath);
      fs.renameSync(files.abc1.fsPath, files.abc2.fsPath);

      await assertRunsAsOldAbc1(files.abc2);
    });

    it('renamed on disk while ABC2 is open: ABC2 runs ABC1\'s text in a fresh session', async () => {
      const files = setUp();
      await runBoth(files);
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.uri.toString(), files.abc2.toString());
      fs.renameSync(files.abc2.fsPath, files.abc3.fsPath);
      fs.renameSync(files.abc1.fsPath, files.abc2.fsPath);
      // The open document is the same object; VS Code reloads it from disk.
      await waitFor('the open ABC2 reloads ABC1\'s text', () =>
        editor.document.getText().includes('One first step'), 10_000);

      await assertRunsAsOldAbc1(files.abc2);
    });

    it('Test Explorer runs: ABC2 runs ABC1\'s text in a session of its own', async () => {
      const files = setUp();
      await hooks.discoveryRefresh();
      const pass = async (f) => {
        for (const line of f.requests[f.requests.length - 1].sourceLines) {
          f.push({ type: 'step:start', line });
          f.push({ type: 'step:pass', line });
        }
        f.end();
      };
      fake.streamScripts = [pass, pass, pass];
      await hooks.runBatchByUris([files.abc1, files.abc2]);
      assert.deepEqual(fake.requests.map((r) => r.steps[0]), ['One first step', 'Two first step']);

      await renameInVSCode(files.abc2, files.abc3);
      await renameInVSCode(files.abc1, files.abc2);
      await hooks.discoveryRefresh();
      await hooks.runBatchByUris([files.abc2]);

      assert.equal(fake.requests.length, 3);
      assert.equal(fake.requests[2].steps[0], 'One first step');
      assert.equal(fake.requests[2].sourceLines[0], 15);
      const ids = fake.streamSessionIds;
      assert.ok(samePath(ids[2].replace(/::run-\d+$/, ''), files.abc2.fsPath), ids[2]);
      assert.equal(new Set(ids).size, 3, `every batch run is a session of its own: ${JSON.stringify(ids)}`);
    });
  });

  // The same rename made outside VS Code while the test holds a run: nothing
  // says which file went where, only that the file at the path is a
  // different one when its document is opened again.
  describe('a different file lands on a test\'s path while it holds a run', () => {
    // line 3 '## Steps', 4–7 the table, 9 the step: one batch per row, and
    // each row's batch reads the document again.
    const ROWS = [
      '# Rows test',
      '',
      '## Steps',
      '| email |',
      '|-------|',
      '| a@b.c |',
      '| d@e.f |',
      '',
      '1. Old row step {{email}}',
      '',
    ].join('\n');

    it('a run in flight keeps the steps it started with; the next run is the new file in a fresh session', async () => {
      const uri = writeTest('replace-running.tmp.md', ROWS);
      const other = writeTest('replace-running-other.tmp.md', testText(10, 'Other'));
      await openTest(uri);
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('row 1 requested', () => fake.requests.length === 1);
      assert.equal(fake.requests[0].steps[0], 'Old row step {{email}}');

      await closeDocument(uri);
      fs.renameSync(other.fsPath, uri.fsPath);
      await openTest(uri);
      assert.ok(hooks.isRunning(), 'the run is still in flight');

      fake.end();
      await waitFor('row 2 requested', () => fake.requests.length === 2);
      const row2 = fake.requests[1];
      assert.equal(row2.dataRow, 2);
      // A row's `steps` were decided when Run was pressed; what each batch
      // reads from the document again is the whole step list (`fullSteps`),
      // the sections and the ## Context.
      assert.equal(row2.steps[0], 'Old row step {{email}}');
      assert.deepEqual(
        row2.fullSteps,
        ['Old row step {{email}}'],
        `the rest of the run must not read the other file's steps; got ${JSON.stringify(row2.fullSteps)}`,
      );
      fake.end();
      await waitFor('idle', () => !hooks.isRunning());

      const closesBefore = fake.closeSessionIds.length;
      const next = await runAllToEnd();
      assert.equal(next.steps[0], 'Other first step', 'the next run is the file at the path now');
      assert.equal(next.sourceLines[0], 10);
      assert.ok(
        fake.closeSessionIds.slice(closesBefore).some((id) => samePath(id, uri.fsPath)),
        'in a fresh session',
      );
    });

    it('a paused run is ended rather than continued into the other file', async () => {
      const uri = writeTest('replace-paused.tmp.md', testText(15, 'Parked'));
      const other = writeTest('replace-paused-other.tmp.md', testText(10, 'Other'));
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(15, 0)), true),
      ]);
      await openTest(uri);
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('run requested', () => fake.requests.length === 1);
      fake.push({ type: 'step:start', line: 15 });
      fake.push({ type: 'step:pass', line: 15 });
      fake.end();
      await waitFor('parked at line 16', () => hooks.tracker.snapshot().breakpointStop === 16);
      await waitFor('idle while parked', () => !hooks.isRunning());
      assert.equal(hooks.keepAliveActive(), true);

      await closeDocument(uri);
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
      fs.renameSync(other.fsPath, uri.fsPath);
      await openTest(uri);
      assert.equal(hooks.keepAliveActive(), false, 'the paused run is over and lets its session go');
      assert.equal(hooks.tracker.snapshot().breakpointStop, null, 'nothing to Continue');

      const closesBefore = fake.closeSessionIds.length;
      const next = await runAllToEnd();
      assert.equal(next.steps[0], 'Other first step');
      assert.equal(next.sourceLines[0], 10);
      assert.ok(
        fake.closeSessionIds.slice(closesBefore).some((id) => samePath(id, uri.fsPath)),
        'in a fresh session, not the paused one',
      );
    });
  });

  describe('a test renamed in VS Code while it holds a run', () => {
    async function renameInVSCode(from, to) {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(from, to);
      assert.ok(await vscode.workspace.applyEdit(edit), `rename ${path.basename(from.fsPath)}`);
    }

    function renamedPath(name) {
      const file = path.resolve(FIXTURES_DIR, name);
      written.push(file);
      return vscode.Uri.file(file);
    }

    it('a running test is stopped, its session closed, and the renamed file starts fresh', async () => {
      const uri = writeTest('rename-running.tmp.md', testText(15, 'Moving'));
      const moved = renamedPath('rename-running-moved.tmp.md');
      await openTest(uri);
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('stream active', () => fake.hasActiveStream);
      fake.push({ type: 'step:start', line: 15 });

      await renameInVSCode(uri, moved);
      await waitFor('the run under the old name stops', () => !hooks.isRunning());
      await waitFor('its session is closed', () =>
        fake.closeSessionIds.some((id) => samePath(id, uri.fsPath)),
      );

      await openTest(moved);
      const closesBefore = fake.closeSessionIds.length;
      const request = await runAllToEnd();
      assert.equal(request.steps[0], 'Moving first step');
      assert.ok(samePath(fake.streamSessionIds[1], moved.fsPath), fake.streamSessionIds[1]);
      assert.ok(
        fake.closeSessionIds.slice(closesBefore).some((id) => samePath(id, moved.fsPath)),
        'the renamed file starts in a fresh session',
      );
    });

    it('a paused test has its pause ended and its session closed; there is nothing to Continue under the new name', async () => {
      const uri = writeTest('rename-paused.tmp.md', testText(15, 'Parked'));
      const moved = renamedPath('rename-paused-moved.tmp.md');
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(15, 0)), true),
      ]);
      await openTest(uri);
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('run requested', () => fake.requests.length === 1);
      fake.push({ type: 'step:start', line: 15 });
      fake.push({ type: 'step:pass', line: 15 });
      fake.end();
      await waitFor('parked at line 16', () => hooks.tracker.snapshot().breakpointStop === 16);
      await waitFor('idle while parked', () => !hooks.isRunning());
      assert.equal(hooks.keepAliveActive(), true);

      await renameInVSCode(uri, moved);
      await waitFor('the parked run lets its session go', () => !hooks.keepAliveActive());
      await waitFor('its session is closed', () =>
        fake.closeSessionIds.some((id) => samePath(id, uri.fsPath)),
      );

      await openTest(moved);
      assert.equal(hooks.tracker.snapshot().breakpointStop, null, 'no pause under the new name');
      // Ends at once if it does start a run, so a wrong answer fails below
      // rather than hanging the command.
      fake.streamScripts = [undefined, async (f) => f.end()];
      await vscode.commands.executeCommand('steptix.continueRun');
      assert.equal(fake.requests.length, 1, 'Continue has nothing to resume');
    });

    it('a folder renamed with a test inside it closes that test\'s session', async () => {
      const folder = path.resolve(FIXTURES_DIR, 'rename-folder.tmp');
      const movedFolder = path.resolve(FIXTURES_DIR, 'rename-folder-moved.tmp');
      fs.mkdirSync(folder, { recursive: true });
      try {
        const uri = writeTest(path.join('rename-folder.tmp', 'inner.md'), testText(15, 'Inner'));
        await openTest(uri);
        await runAllToEnd();

        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(vscode.Uri.file(folder), vscode.Uri.file(movedFolder));
        assert.ok(await vscode.workspace.applyEdit(edit), 'rename the folder');
        await waitFor('the inner test\'s session is closed', () =>
          fake.closeSessionIds.filter((id) => samePath(id, uri.fsPath)).length >= 2,
        );
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (const dir of [folder, movedFolder]) {
          if (!fs.existsSync(dir)) continue;
          // Through VS Code first: on Windows its file watcher can hold a
          // folder it just saw renamed, and a plain rmdir then fails EBUSY.
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true, useTrash: false });
          } catch {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
          }
        }
      }
    });
  });
});

function samePath(a, b) {
  const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return fold(a) === fold(b);
}
