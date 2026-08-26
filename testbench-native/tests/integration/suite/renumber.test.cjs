/**
 * Renumber Steps wiring, in a real VS Code extension host.
 *
 * The numbering DECISION is unit-tested without a host
 * (`tests/renumber.test.js`); what only a host can prove is the wiring —
 * the command reads the editor's real selection shapes and applies every
 * replacement as ONE edit so a single undo restores the file. (Registration
 * itself is pinned centrally by activation.test.cjs's command sweep; every
 * executeCommand here would reject if it broke.)
 *
 * Nothing here saves. The fixture on disk stays misnumbered (later runs open
 * it fresh), so every case reverts its buffer instead.
 *
 * `renumber.md` line numbers, 1-based: main flow 12-15, `### Login` heading
 * 17, body 18-20.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // transient
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** The step lines of the buffer, so a case names what it expects, not offsets. */
const stepLines = (doc) =>
  doc
    .getText()
    .split(/\r?\n/)
    .filter((l) => /^\d+\.\s+\S/.test(l));

describe('TestBench renumber steps', function () {
  this.timeout(20_000);

  let hooks;
  let uri;
  /** The fixture exactly as it sits on disk — the undo target. */
  let onDisk;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed — did activate() forget to return them?');
    uri = fixtureUri('renumber.md');
    onDisk = fs.readFileSync(uri.fsPath, 'utf8');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    // The command's guard is the tracker, not the raw active editor, and the
    // tracker updates on its own event — without this wait the first case
    // races it and the command no-ops.
    await waitFor('active file detected as test file', () => hooks.tracker.snapshot().isTestFile);
    const editor = vscode.window.activeTextEditor;
    // An empty selection is the renumber-all case; each test that wants the
    // other mode sets a range itself.
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
  });

  afterEach(async () => {
    // Never save. Reverting also keeps the next case's `vscode.open` from
    // reusing a renumbered buffer; the beforeEach closeAllEditors is the
    // backstop, per suite convention.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), onDisk, 'the fixture on disk must not change');
  });

  it('with no selection, renumbers the main flow and restarts the body at 1', async () => {
    const editor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('testbench-native.renumberSteps');

    assert.deepEqual(stepLines(editor.document), [
      '1. Open the site',
      '2. Login',
      '3. Check the dashboard',
      '4. Sign out',
      '1. Go to the login page',
      '2. Type the username',
      '3. Click Sign in',
    ]);
    // Everything that is not a step line is byte-identical — the command
    // touches leading digits and nothing else.
    const untouched = (text) => text.split(/\r?\n/).filter((l) => !/^\d+\.\s+\S/.test(l));
    assert.deepEqual(untouched(editor.document.getText()), untouched(onDisk));
    assert.equal(editor.document.isDirty, true, 'the edit lands on the buffer, unsaved');
  });

  it('one undo restores the original — every replacement is a single edit', async () => {
    const editor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('testbench-native.renumberSteps');
    assert.notEqual(editor.document.getText(), onDisk, 'nothing to undo');

    await vscode.commands.executeCommand('undo');
    await waitFor('undo restores the original', () => editor.document.getText() === onDisk);
  });

  it('a second run changes nothing', async () => {
    const editor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('testbench-native.renumberSteps');
    const once = editor.document.getText();

    await vscode.commands.executeCommand('testbench-native.renumberSteps');
    assert.equal(editor.document.getText(), once);
  });

  it('with the tail of the main flow selected, only those lines change', async () => {
    const editor = vscode.window.activeTextEditor;
    // Whole-line select of lines 14-15 (0-based 13-14) the way gutter drags
    // and Shift+Down produce it: the range ends at COLUMN 0 OF THE NEXT
    // LINE. The trimmed-end rule (selectionLinesForEdit) must not target
    // that trailing line.
    editor.selection = new vscode.Selection(
      new vscode.Position(13, 0),
      new vscode.Position(15, 0),
    );

    await vscode.commands.executeCommand('testbench-native.renumberSteps');

    assert.deepEqual(stepLines(editor.document), [
      '1. Open the site',
      '2. Login',
      // Continue from the step above the selection…
      '3. Check the dashboard',
      '4. Sign out',
      // …and leave the Login body's duplicate `1.`s exactly as authored.
      '1. Go to the login page',
      '1. Type the username',
      '2. Click Sign in',
    ]);
  });

  it('a whole-line selection does not renumber the step below it', async () => {
    const editor = vscode.window.activeTextEditor;
    // Gutter-click the line number of line 13 (`2. Login`, correctly
    // numbered): the selection runs [12,0]→[13,0]. Untrimmed, line 13's
    // trailing neighbour — the duplicate `2.` on line 14 — was silently
    // rewritten too; the correct outcome is no edit at all.
    editor.selection = new vscode.Selection(
      new vscode.Position(12, 0),
      new vscode.Position(13, 0),
    );

    await vscode.commands.executeCommand('testbench-native.renumberSteps');

    assert.equal(editor.document.getText(), onDisk);
  });

  it('a breakpoint on a renumbered line survives (acceptance #5)', async () => {
    const editor = vscode.window.activeTextEditor;
    const bpAt = (line0) =>
      vscode.debug.breakpoints.some(
        (bp) =>
          bp instanceof vscode.SourceBreakpoint &&
          bp.location.uri.toString() === uri.toString() &&
          bp.location.range.start.line === line0,
      );
    // Gutter form: toggleBreakpoint takes the clicked line directly. Line 14
    // (1-based) is the duplicate `2.` whose ordinal the renumber rewrites.
    await vscode.commands.executeCommand('testbench-native.toggleBreakpoint', { lineNumber: 14 });
    await waitFor('breakpoint added', () => bpAt(13));

    await vscode.commands.executeCommand('testbench-native.renumberSteps');

    assert.notEqual(editor.document.getText(), onDisk, 'the renumber must have applied');
    assert.ok(bpAt(13), 'the breakpoint must stay on its line after the renumber');

    vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  });
});
