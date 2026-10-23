/**
 * The welcome page coming back (docs/specs/SPEC-install.md §7.1).
 *
 * After a plain Reload Window, VS Code restores a webview panel only through
 * a serializer the extension registers for its type, and hands the panel to
 * it. A test cannot reload its own window, so `__testHooks.welcome.restore`
 * hands a panel to that same serializer, as VS Code would.
 *
 * Open a folder picks the folder itself and notes it before opening it, so
 * the reopened window can bring the page back. The note goes in the Steptix
 * folder, which this test points at a folder of its own.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'steptix.steptix-vscode';
const VIEW_TYPE = 'steptix.welcome';

/** The welcome pages open in any tab group. VS Code prefixes a webview's
 *  type with its own name in the tab's input. */
const welcomeTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(VIEW_TYPE));

/** A panel as VS Code restores one: its type, and nothing set on it yet. */
const restoredPanel = () => vscode.window.createWebviewPanel(VIEW_TYPE, 'Welcome to Steptix', vscode.ViewColumn.Active, {});

/** Tabs reach the extension host as events, so wait for the count. */
async function waitForTabs(count, label) {
  const start = Date.now();
  while (welcomeTabs().length !== count) {
    if (Date.now() - start > 10_000) {
      throw new Error(`${label}: ${welcomeTabs().length} welcome tabs (${welcomeTabs().map((t) => t.label).join(', ')}), not ${count}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('the welcome page coming back', function () {
  this.timeout(30_000);
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found in test host`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks?.welcome?.restore, '__testHooks.welcome.restore not exposed');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('after a Reload Window: takes the restored panel as the page, and keeps one page when another comes back too', async () => {
    const panel = restoredPanel();
    await hooks.welcome.restore(panel);
    assert.match(panel.webview.html, /<title>Welcome to Steptix<\/title>/, 'the page is back in the panel');
    assert.equal(panel.webview.options.enableScripts, true, 'its script runs again');

    const second = restoredPanel();
    let secondClosed = false;
    second.onDidDispose(() => (secondClosed = true));
    await hooks.welcome.restore(second);
    assert.equal(secondClosed, true, 'a second page was kept');

    // Steptix: Welcome shows the restored page rather than opening another.
    await vscode.commands.executeCommand('steptix.welcome');
    await waitForTabs(1, 'Steptix: Welcome with the restored page open');

    // Closed, the page opens afresh.
    panel.dispose();
    await waitForTabs(0, 'the restored page closed');
    await vscode.commands.executeCommand('steptix.welcome');
    await waitForTabs(1, 'Steptix: Welcome after the restored page closed');
  });

  it('Open a folder: the folder picked is noted, then opens in this window; cancelled, nothing opens', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-welcome-open-'));
    const note = path.join(scratch, 'steptix', 'welcome-reopen.json');
    const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    const originalDialog = vscode.window.showOpenDialog;
    const originalExecute = vscode.commands.executeCommand;
    /** What the page asked VS Code to open, held back: opening reloads the window. */
    const opened = [];
    let picked;
    try {
      // The Steptix folder: <LOCALAPPDATA>/steptix on Windows, else
      // <XDG_CONFIG_HOME>/steptix.
      process.env.LOCALAPPDATA = scratch;
      process.env.XDG_CONFIG_HOME = scratch;
      vscode.window.showOpenDialog = async () => picked;
      vscode.commands.executeCommand = (command, ...args) => {
        if (command !== 'vscode.openFolder') return originalExecute.call(vscode.commands, command, ...args);
        opened.push(args[0]);
        return Promise.resolve(undefined);
      };

      picked = undefined;
      await hooks.welcome.send({ type: 'openFolder' });
      assert.deepEqual(opened, [], 'opened a folder although none was picked');
      assert.equal(fs.existsSync(note), false, 'noted a folder although none was picked');

      const folder = vscode.Uri.file(path.join(scratch, 'my-tests'));
      fs.mkdirSync(folder.fsPath);
      picked = [folder];
      await hooks.welcome.send({ type: 'openFolder' });
      assert.deepEqual(opened.map((u) => u.fsPath), [folder.fsPath]);
      // The note names the folder and when it was written: it counts only for
      // the few minutes the window takes to reopen.
      const written = JSON.parse(fs.readFileSync(note, 'utf8'));
      assert.equal(written.folder, folder.fsPath);
      assert.equal(typeof written.since, 'number');
    } finally {
      vscode.window.showOpenDialog = originalDialog;
      vscode.commands.executeCommand = originalExecute;
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
