/**
 * Cancel stops an install (docs/specs/SPEC-install.md §5.2 "Cancelling an
 * install", §8.3), from each place its progress shows: the Test Runner's
 * banner, the welcome page's server step and the progress notification.
 * Each cancels a real install while npm is downloading the server into its
 * scratch folder. Then nothing half-installed is left; the banner and the
 * welcome page say not installed; "Install cancelled." shows and no failure
 * does; and Install works again straight away, which the next case's install
 * and the last one's, run to the end, show. A Run waiting for the install
 * ends with STX034 and asks no question.
 *
 * Only the user's presses are scripted: message boxes are stubbed, and the
 * notification's Cancel is pressed through a cancellation token that a stub
 * of `withProgress` hands the install in place of VS Code's own, which it
 * still forwards. The notification itself is VS Code's and is still shown.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { ROOT, VERSION, hooks, installed, stubPrompts, waitFor } = require('./helpers.cjs');

const RUN_QUESTION = /^Steptix needs its local server to run this test\./;
const CANCELLED = /^Install cancelled\.$/;
const READY = /^Steptix server .* is ready\.$/;
/** The Run's checks before it reaches the install it waits for have nothing
 *  to watch from here: a health probe of a closed port, then the wait. Long
 *  enough for those; too short could only fail the test (the Run would then
 *  ask), never pass it wrongly. */
const RUN_SETTLE_MS = 5_000;

/** What an install left half-done in the Steptix folder. */
function partials() {
  return ['runtimes', 'node', 'downloads'].flatMap((name) => {
    const dir = path.join(ROOT(), name);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('.partial-')).map((n) => `${name}/${n}`) : [];
  });
}

/** npm is downloading the server: its scratch folder in downloads/ has
 *  something in it (SPEC-install.md §3.3). */
function npmDownloading() {
  const dir = path.join(ROOT(), 'downloads');
  try {
    return fs.readdirSync(dir).some((n) => n.startsWith('.partial-npm-') && fs.readdirSync(path.join(dir, n)).length > 0);
  } catch {
    return false;
  }
}

/** Poll faster than helpers.cjs does: the moment to cancel is while npm writes. */
async function soon(label, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('Cancel stops an install', function () {
  this.timeout(30 * 60_000);
  const prompts = stubPrompts();
  let h;

  before(async () => {
    h = await hooks();
    prompts.answer(() => undefined);
    // The welcome page stays open throughout, so what it shows is what the
    // install's own change events gave it.
    await vscode.commands.executeCommand('steptix.welcome');
  });
  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /** Start Install Server, and wait until npm is downloading. */
  async function installUntilDownloading() {
    assert.deepEqual(installed(), [], 'starts with nothing installed');
    const mark = prompts.prompts.length;
    let ended = false;
    const install = Promise.resolve(vscode.commands.executeCommand('steptix.installServer')).finally(() => {
      ended = true;
    });
    await soon('npm to download the server', () => npmDownloading() || ended, 10 * 60_000);
    assert.equal(ended, false, `the install ended before it could be cancelled: ${JSON.stringify(prompts.prompts.slice(mark))}`);
    assert.equal(h.runnerReplay().serverSetup, 'installing', "the banner shows the install's progress");
    // Also shows the page is still open and being told, so its "not
    // installed" below is news and not what an earlier case left.
    assert.equal(h.welcome.shown()?.server.state, 'installing', 'the welcome page shows the install');
    return { install, mark, ended: () => ended };
  }

  /** What every Cancel leaves, once the install it cancelled has ended. */
  async function assertCancelled({ install, mark }) {
    await install;
    const shown = prompts.prompts.slice(mark);
    assert.equal(shown.filter((p) => CANCELLED.test(p.message)).length, 1, `said once that it was cancelled: ${JSON.stringify(shown)}`);
    assert.deepEqual(shown.filter((p) => p.kind === 'showErrorMessage'), [], 'reported a failure');
    assert.deepEqual(installed(), [], 'a server was installed');
    assert.deepEqual(partials(), [], 'something half-installed was left');
    assert.equal(h.runnerReplay().serverSetup, 'not-installed', 'the banner');
    await soon('the welcome page to say not installed', () => h.welcome.shown()?.server.state === 'not-installed', 10_000);
  }

  it("from the Test Runner's banner; a Run waiting for the install ends as not installed, and asks nothing", async () => {
    const test = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'tests', 'waits-for-install.md');
    fs.mkdirSync(path.dirname(test), { recursive: true });
    fs.writeFileSync(test, '# Waits for the install\n\n## Steps\n1. Check the page is blank\n');
    try {
      const started = await installUntilDownloading();
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(test));
      h.clearRunError();
      void vscode.commands.executeCommand('steptix.runAll');
      await waitFor('the Run to start', () => h.isRunning(), 30_000);
      await new Promise((r) => setTimeout(r, RUN_SETTLE_MS));
      assert.equal(started.ended(), false, 'the install ended before it could be cancelled');

      await h.dispatchWebviewMessage({ type: 'cancelInstall' });
      await assertCancelled(started);
      await waitFor('the Run to end', () => !h.isRunning(), 60_000);
      assert.equal(h.lastRunError()?.code, 'STX034');
      // Says the install was cancelled, and does not tell the user to "choose
      // Install" in a question the next Run may not ask.
      assert.match(h.lastRunError().diagnosis, /install was cancelled/);
      assert.doesNotMatch(h.lastRunError().fix, /choose Install/);
      assert.deepEqual(prompts.matching(RUN_QUESTION), [], 'the Run asked for the install it waited for');
    } finally {
      // Its own tab: the welcome page stays open for the cases below.
      const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input?.uri?.fsPath === test);
      if (tab) await vscode.window.tabGroups.close(tab);
      fs.rmSync(test, { force: true });
    }
  });

  it("from the welcome page's server step", async () => {
    const started = await installUntilDownloading();
    const [posted] = await h.welcome.send({ type: 'ready' });
    assert.equal(posted.state.server.state, 'installing');
    assert.match(posted.state.server.progress ?? '', /^Downloading steptix /, 'the step shows what the install is doing');

    await h.welcome.send({ type: 'cancelInstall' });
    await assertCancelled(started);
  });

  it('from the progress notification', async () => {
    const withProgress = vscode.window.withProgress;
    /** The install's notification: its options, and its Cancel. */
    let notification;
    vscode.window.withProgress = (options, task) =>
      withProgress.call(vscode.window, options, (progress, token) => {
        const cancel = new vscode.CancellationTokenSource();
        token.onCancellationRequested(() => cancel.cancel());
        notification = { options, press: () => cancel.cancel() };
        return task(progress, cancel.token);
      });
    try {
      const started = await installUntilDownloading();
      assert.equal(notification?.options.cancellable, true, 'the notification offers Cancel');
      notification.press();
      await assertCancelled(started);
    } finally {
      vscode.window.withProgress = withProgress;
    }
  });

  it('then Install installs the server', async () => {
    const mark = prompts.prompts.length;
    await vscode.commands.executeCommand('steptix.installServer');
    assert.deepEqual(installed(), [VERSION()]);
    assert.deepEqual(partials(), []);
    assert.ok(prompts.prompts.slice(mark).some((p) => READY.test(p.message)), `said it is ready: ${JSON.stringify(prompts.prompts.slice(mark))}`);
    assert.equal(h.runnerReplay().serverSetup, null);
    await soon('the welcome page to say ready', () => h.welcome.shown()?.server.state === 'ready', 10_000);
  });
});
