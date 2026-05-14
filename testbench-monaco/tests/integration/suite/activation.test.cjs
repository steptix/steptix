const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench';
const VIEW_TYPE = 'testbench.editor';

const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR ||
  path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

/** Sleep helper for the inevitable VS Code async race. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * VS Code routes a tab open through extension activation + custom-editor
 * resolution asynchronously. Poll the active tab until it's the one we want.
 */
async function waitForActiveTab(predicate, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && predicate(tab)) return tab;
    await sleep(100);
  }
  throw new Error('timeout waiting for active tab');
}

describe('TestBench extension activation', function () {
  this.timeout(30_000);

  before(async () => {
    // Ensure the extension is loaded.
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found in test host`);
    if (!ext.isActive) await ext.activate();
  });

  beforeEach(async () => {
    // Close all open editors between tests so editor associations don't bleed.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('extension is present and activated', () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext);
    assert.equal(ext.isActive, true);
  });

  it('all contributed commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'testbench.runSelected',
      'testbench.runAll',
      'testbench.stop',
      'testbench.toggleBreakpoint',
      'testbench.reopenAsText',
      'testbench.revealEnvFile',
      'testbench.showRunLog',
      'testbench.dismissError',
    ];
    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `missing command ${cmd}`);
    }
  });

  it('opens a .md with ## Steps in the TestBench custom editor by default', async () => {
    const uri = fixtureUri('test-with-steps.md');
    // Using `vscode.open` lets the registered priority resolve the editor.
    await vscode.commands.executeCommand('vscode.open', uri);
    const tab = await waitForActiveTab((t) => {
      const input = t.input;
      return input && input.uri && input.uri.toString() === uri.toString();
    });
    // For a custom editor, tab.input is a TabInputCustom with viewType.
    const input = tab.input;
    assert.ok(input, 'active tab has no input');
    assert.equal(
      input.viewType,
      VIEW_TYPE,
      `expected TestBench editor, got viewType=${input.viewType ?? '(plain text)'}`,
    );
  });

  it('hands a .md without ## Steps back to the default markdown editor', async () => {
    const uri = fixtureUri('plain.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    const tab = await waitForActiveTab((t) => {
      const input = t.input;
      return input && input.uri && input.uri.toString() === uri.toString();
    });
    const input = tab.input;
    // TabInputText has no viewType. TabInputCustom has viewType. So we expect
    // the TestBench editor NOT to claim plain markdown.
    assert.notEqual(
      input.viewType,
      VIEW_TYPE,
      'TestBench should not claim plain markdown',
    );
  });

  it('reopen-as-text command sends the tab back to the plain editor', async () => {
    const uri = fixtureUri('test-with-steps.md');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitForActiveTab((t) => {
      const input = t.input;
      return input && input.viewType === VIEW_TYPE;
    });

    await vscode.commands.executeCommand('testbench.reopenAsText');

    const tab = await waitForActiveTab((t) => {
      const input = t.input;
      return (
        input &&
        input.uri &&
        input.uri.toString() === uri.toString() &&
        input.viewType !== VIEW_TYPE
      );
    });
    assert.notEqual(tab.input.viewType, VIEW_TYPE);
  });
});
