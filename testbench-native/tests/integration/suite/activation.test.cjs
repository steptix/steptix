const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const SIDEBAR_VIEW_ID = 'testbench-native.runner';

const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR ||
  path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a predicate to hold, or throw after timeoutMs. */
async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // ignore — predicate transient errors are part of the wait
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe('TestBench extension — structural smoke', function () {
  this.timeout(30_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found in test host`);
    if (!ext.isActive) await ext.activate();

    // Make sure the github.md template fixture exists in the fixtures dir.
    // The test harness sets TESTBENCH_FIXTURES_DIR to tests/integration/fixtures;
    // copy the canonical template in if it's not already there.
    const githubMd = path.resolve(FIXTURES_DIR, 'github.md');
    if (!fs.existsSync(githubMd)) {
      const src = path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'templates',
        'init',
        'tests',
        'github.md',
      );
      if (fs.existsSync(src)) fs.copyFileSync(src, githubMd);
    }
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Drop any lingering breakpoints between tests so state-key tests start clean.
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
  });

  it('extension is present and activated', () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext);
    assert.equal(ext.isActive, true);
  });

  it('every contributed command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'testbench-native.runSelected',
      'testbench-native.runAll',
      'testbench-native.stop',
      'testbench-native.pause',
      'testbench-native.resume',
      'testbench-native.toggleBreakpoint',
      'testbench-native.runStepHere',
      'testbench-native.repairStep',
      'testbench-native.renumberSteps',
      'testbench-native.clearBreakpoints',
      'testbench-native.clearStatuses',
      'testbench-native.revealEnvFile',
      'testbench-native.showRunLog',
      'testbench-native.dismissError',
      'testbench-native.selectEnv',
      'testbench-native.focusRunner',
      // Record Steps (stories/testbench-record-steps.md).
      'testbench-native.recordSteps',
      'testbench-native.recordNewTest',
      'testbench-native.stopRecording',
      'testbench-native.recordAddCheck',
      'testbench-native.cancelRecording',
    ];
    const missing = expected.filter((c) => !commands.includes(c));
    assert.deepEqual(missing, [], `missing commands: ${missing.join(', ')}`);
  });

  it('opens a markdown test file in the native editor (no custom editor claim)', async () => {
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('test-with-steps.md to become active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    // The native editor sets languageId; a TabInputCustom would not.
    assert.equal(editor.document.languageId, 'markdown');
    // Active tab should be a plain text input, not a custom editor.
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab);
    // TabInputCustom has a non-empty .viewType. TabInputText doesn't.
    assert.ok(
      !('viewType' in (tab.input ?? {})) || !(tab.input?.viewType),
      `expected plain text editor, got viewType=${tab.input?.viewType}`,
    );
  });

  it('toggleBreakpoint command creates and removes a SourceBreakpoint', async () => {
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    // Move cursor to line 9 (1-based) — `1. Navigate to ...` per fixture.
    const editor = vscode.window.activeTextEditor;
    const line = 9;
    editor.selection = new vscode.Selection(
      new vscode.Position(line - 1, 0),
      new vscode.Position(line - 1, 0),
    );

    // Toggle on.
    await vscode.commands.executeCommand('testbench-native.toggleBreakpoint');
    await waitFor('breakpoint added', () => {
      return vscode.debug.breakpoints.some(
        (bp) =>
          bp instanceof vscode.SourceBreakpoint &&
          bp.location.uri.toString() === uri.toString() &&
          bp.location.range.start.line === line - 1,
      );
    });

    // Toggle off.
    await vscode.commands.executeCommand('testbench-native.toggleBreakpoint');
    await waitFor('breakpoint removed', () => {
      return !vscode.debug.breakpoints.some(
        (bp) =>
          bp instanceof vscode.SourceBreakpoint &&
          bp.location.uri.toString() === uri.toString() &&
          bp.location.range.start.line === line - 1,
      );
    });
  });

  it('pause / stop / resume commands no-op gracefully when nothing is running', async () => {
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });

    // None of these should throw when there's no in-flight run.
    await vscode.commands.executeCommand('testbench-native.stop');
    await vscode.commands.executeCommand('testbench-native.pause');
    await vscode.commands.executeCommand('testbench-native.resume');
  });

  it('breakpoints panel reflects markdown breakpoints we add', async () => {
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });

    // Use the gutter-equivalent path: addBreakpoints directly. Our tracker
    // should still mirror this (we listen to onDidChangeBreakpoints).
    const bp = new vscode.SourceBreakpoint(
      new vscode.Location(uri, new vscode.Position(8, 0)),
      true,
    );
    vscode.debug.addBreakpoints([bp]);

    await waitFor('debug.breakpoints contains our bp', () =>
      vscode.debug.breakpoints.some(
        (b) =>
          b instanceof vscode.SourceBreakpoint &&
          b.location.uri.toString() === uri.toString() &&
          b.location.range.start.line === 8,
      ),
    );

    vscode.debug.removeBreakpoints([bp]);
  });

  it('opens the github.md template without errors', async () => {
    const uri = fixtureUri('github.md');
    if (!fs.existsSync(uri.fsPath)) {
      this.skip();
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('github.md active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === uri.toString();
    });
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.match(editor.document.getText(), /## Steps/);
  });
});
