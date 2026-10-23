/**
 * The install question appears once (docs/specs/SPEC-install.md §5.2, §4.5):
 * asked in a notification when the extension first starts, and not asked
 * again when the extension starts again. That notification stays unanswered
 * here, as one VS Code moved into its notification centre would, and a Run
 * does not wait on it: the Run asks its own question, in a dialog. A Run
 * waiting on that dialog stops on Stop, and a Run while it is showing asks no
 * second. The Test Runner's banner says no server is installed until one is,
 * and Install on the notification, answered once a server has turned up,
 * does nothing.
 *
 * "Starts again" is the startup checks run a second time in the same window.
 * VS Code keeps an extension's state in memory while it runs extension tests
 * (no state database is written, even on a graceful quit), so a second test
 * launch would start with nothing remembered. Keeping that state on disk
 * across a real restart is VS Code's part; remembering that it asked is the
 * extension's, and that is what this checks.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { ROOT, VERSION, health, hooks, installed, stubPrompts, waitFor } = require('./helpers.cjs');

const QUESTION = /^Steptix needs its local server to run tests\. About \d+ MB to download\.$/;
const RUN_QUESTION = /^Steptix needs its local server to run this test\. About \d+ MB to download\.$/;
/** Long enough for the startup checks' question, which they do not wait
 *  for, to have come if it was going to. */
const QUESTION_SETTLE_MS = 30_000;
/** Long enough for an install that a late answer started to have said so. */
const LATE_ANSWER_SETTLE_MS = 10_000;

/**
 * A server that turned up since the startup checks, as `npm i -g steptix`
 * or another window would leave it: what an install leaves in runtimes/.
 * Returns what removes it again.
 */
function serverTurnsUp() {
  const dir = path.join(ROOT(), 'runtimes', VERSION());
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'steptix', version: VERSION() }));
  fs.writeFileSync(path.join(dir, '.steptix-install.json'), JSON.stringify({ source: 'npm' }));
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), '');
  return () => fs.rmSync(dir, { recursive: true, force: true });
}

describe('the install question', function () {
  this.timeout(10 * 60_000);
  const prompts = stubPrompts();
  /** Answers the start notification, which stays unanswered until the last
   *  test answers it. */
  let answerStart;
  const startAnswer = new Promise((resolve) => (answerStart = resolve));
  after(() => answerStart(undefined));

  it('is asked once when the extension first starts, in a notification', async () => {
    prompts.answer((message) => (QUESTION.test(message) ? startAnswer : undefined));
    await (await hooks()).serverStartupChecks();
    await waitFor('the question', () => prompts.matching(QUESTION).length > 0, 60_000);
    assert.equal(prompts.matching(QUESTION).length, 1);
    const [asked] = prompts.matching(QUESTION);
    assert.deepEqual(asked.items, ['Install', 'Install and add steptix to PATH', 'Not now']);
    assert.equal(asked.modal, false, 'nobody asked for this question, so it must not be a dialog');
    assert.deepEqual(installed(), []);
  });

  it('is not asked again when the extension starts again', async () => {
    await (await hooks()).serverStartupChecks();
    await new Promise((r) => setTimeout(r, QUESTION_SETTLE_MS));
    assert.equal(prompts.matching(QUESTION).length, 1, 'asked again when the extension started again');
  });

  it('a Run asks its own question, in a dialog, while the notification is unanswered; Cancel installs nothing', async () => {
    // VS Code answers undefined for a dialog's Cancel.
    prompts.answer(() => undefined);
    const started = vscode.commands.executeCommand('steptix.startServer');
    // A Run that waited on the notification would never ask.
    await waitFor("the Run's question", () => prompts.matching(RUN_QUESTION).length === 1, 60_000);
    await started;
    const [asked] = prompts.matching(RUN_QUESTION);
    assert.equal(asked.modal, true, 'the user is waiting for the Run, so it asks in a dialog');
    assert.deepEqual(asked.items, ['Install', 'Install and add steptix to PATH'], 'a dialog has its own Cancel');
    assert.equal(await health(), null, 'Cancel started a server');
    assert.deepEqual(installed(), []);
  });

  it('a Run waiting on the question stops on Stop, and Run again asks no second question', async () => {
    const test = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'tests', 'stop-while-asked.md');
    fs.mkdirSync(path.dirname(test), { recursive: true });
    fs.writeFileSync(test, '# Stop while asked\n\n## Steps\n1. Check the page is blank\n');
    const h = await hooks();
    /** The question stays unanswered until this is called with the answer. */
    let answer;
    const answered = new Promise((resolve) => (answer = resolve));
    prompts.answer((message) => (RUN_QUESTION.test(message) ? answered : undefined));
    const before = prompts.matching(RUN_QUESTION).length;
    try {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(test));
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('the question', () => prompts.matching(RUN_QUESTION).length === before + 1, 60_000);
      assert.equal(prompts.matching(RUN_QUESTION).at(-1).modal, true, 'a Run asks in a dialog');
      assert.equal(h.isRunning(), true);

      // The dialog stays unanswered; Stop ends the Run without waiting for it.
      await vscode.commands.executeCommand('steptix.stop');
      await waitFor('the run to stop', () => !h.isRunning(), 10_000);
      assert.equal(h.lastDoneStatus(), 'aborted');

      h.clearRunError();
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('the second run', () => h.isRunning(), 10_000);
      await new Promise((r) => setTimeout(r, QUESTION_SETTLE_MS));
      assert.equal(prompts.matching(RUN_QUESTION).length, before + 1, 'a second question was stacked on the first');

      answer(undefined); // Cancel
      await waitFor('the second run to end', () => !h.isRunning(), 10_000);
      assert.equal(h.lastRunError()?.code, 'STX034');
      assert.deepEqual(installed(), []);
    } finally {
      answer(undefined);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(test, { force: true });
    }
  });

  it("the Test Runner's banner says no server is installed, opens the welcome page, and goes once one is", async () => {
    const h = await hooks();
    assert.equal(h.runnerReplay().serverSetup, 'not-installed');

    await h.dispatchWebviewMessage({ type: 'openWelcome' });
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    await waitFor('the welcome page', () => tabs().includes('Welcome to Steptix'), 10_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const removeServer = serverTurnsUp();
    try {
      // The panel coming into view looks again. The Runs above may have
      // revealed it already, so hide it first.
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('steptix.runner.focus');
      await waitFor('the banner to go', () => h.runnerReplay().serverSetup === null, 30_000);
    } finally {
      removeServer();
    }
  });

  it('Install on the notification, answered once a server has turned up, does nothing', async () => {
    const h = await hooks();
    /** The welcome page's server step: `installing` while an install runs. */
    const serverState = async () =>
      (await h.welcome.send({ type: 'ready' })).find((m) => m.type === 'state').state.server.state;
    const removeServer = serverTurnsUp();
    try {
      assert.equal(await serverState(), 'ready');
      const said = prompts.prompts.length;
      answerStart('Install');
      // An install would start the moment the answer is handled, which is
      // before the next turn of the event loop; then watch for a while for
      // anything it would say.
      await new Promise((r) => setImmediate(r));
      const start = Date.now();
      while (Date.now() - start < LATE_ANSWER_SETTLE_MS) {
        assert.equal(await serverState(), 'ready', 'Install on the notification started an install');
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.deepEqual(prompts.prompts.slice(said).map((p) => p.message), [], 'the late answer said something');
      assert.deepEqual(installed(), [VERSION()]);
      assert.equal(prompts.matching(QUESTION).length, 1);
    } finally {
      removeServer();
    }
  });
});
