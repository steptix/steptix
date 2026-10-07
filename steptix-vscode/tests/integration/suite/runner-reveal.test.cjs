/**
 * A run puts the Test Runner on screen, and its error banner follows the
 * latest run (steptix/steptix#13).
 *
 * The run's errors land in the Test Runner — the red banner a `runError`
 * raises, and the failure text under each step — so a run started from the
 * editor reveals it when it is hidden, without taking keyboard focus: F5 and
 * Shift+F5 only mean Pause and Stop while the editor has text focus. A new run
 * closes the previous run's banner as it starts, and puts up its own only if
 * it fails.
 *
 * One reveal path needs a Test Runner with no view behind it — never opened in
 * this window, or hidden through its title menu's "Hide 'Test Runner'", which
 * disposes it — the one state `WebviewView.show` cannot handle. File order
 * cannot promise "never opened" (the harness's user-data dir is reused, and a
 * restored Steptix sidebar resolves the view at startup), so those cases hide
 * it. `removeView` only disposes a view that is on screen, so they show it
 * first.
 *
 * KEYBOARD FOCUS is asserted in its own block, because it can only be observed
 * while the test window has OS focus: VS Code tracks which editor has focus
 * through DOM focus events, and a window in the background does not get them
 * reliably — measured, the full suite runs long enough for another window to
 * take the foreground, and the probe below then says the Explorer has editor
 * focus. Those cases skip themselves (reported pending, not passed) when the
 * window is not focused, and the reveal cases above them never look at focus.
 *
 * The webview's DOM is not readable from the extension host, so the banner
 * and the panel's focus are read from what the webview reports back over
 * `webviewState`.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { ApiClientError } = require('steptix-runner-core');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

// --- fixtures/test-with-steps.md ----------------------------------------
const STEP_1 = 8; // 1. Navigate to https://example.com

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // transient predicate errors are part of the wait
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('Steptix Test Runner — revealed on run, banner follows the latest run', function () {
  this.timeout(30_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  let testUri;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
    hooks.clearRunError();

    testUri = fixtureUri('test-with-steps.md');
    await openFixture();
  });

  /** Open the fixture in the first editor group and wait for the tracker. */
  async function openFixture() {
    const doc = await vscode.workspace.openTextDocument(testUri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    // With a second group open, the group can turn active while
    // `activeTextEditor` still names the other group's editor; focusing the
    // group settles it, as a click in it would.
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await waitFor('fixture editor active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === testUri.toString();
    }).catch((err) => {
      const groups = vscode.window.tabGroups.all.map(
        (g) => `${g.viewColumn}${g.isActive ? '*' : ''}: ${g.tabs.map((t) => t.label).join(', ')}`,
      );
      const active = vscode.window.activeTextEditor?.document.uri.fsPath ?? '(none)';
      throw new Error(`${err.message} — active editor ${active}; groups ${groups.join(' | ')}`);
    });
    await waitFor('detected as test file', () => hooks.tracker.snapshot().isTestFile === true);
    // VS Code restores the selection an earlier suite left on this file, and
    // Run runs a highlighted selection — so put the cursor back at the top,
    // where Run means the whole test.
    vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
  }

  /** Put the Test Runner on screen and focus back on the editor. */
  async function showRunner() {
    await vscode.commands.executeCommand('steptix.runner.focus');
    await waitFor('runner visible', () => hooks.runnerVisible());
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  /** Put the Test Runner out of sight by showing the Explorer instead, with
   *  the author still typing in the editor. */
  async function hideRunner() {
    await vscode.commands.executeCommand('workbench.view.explorer');
    await waitFor('runner hidden', () => !hooks.runnerVisible());
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  /** Leave no Test Runner view at all: "Hide 'Test Runner'" disposes it. */
  async function disposeRunner() {
    if (hooks.runnerResolved()) {
      await showRunner();
      await vscode.commands.executeCommand('steptix.runner.removeView');
      await waitFor('view disposed', () => !hooks.runnerResolved());
    }
    await openFixture();
    assert.equal(hooks.runnerVisible(), false);
  }

  const fixtureStillActive = () =>
    vscode.window.activeTextEditor?.document.uri.toString() === testUri.toString();

  /** Start a run the way the editor's Run button does and wait for its stream. */
  async function startRun() {
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('stream active', () => fake.hasActiveStream);
  }

  /** Finish the open stream with one passing step. */
  async function passRun() {
    fake.push({ type: 'step:start', line: STEP_1 });
    fake.push({ type: 'step:pass', line: STEP_1 });
    fake.push({ type: 'done', status: 'passed' });
    fake.end();
    await waitFor('run finished', () => !hooks.isRunning(), 10_000);
  }

  /** Run once with the stream refusing as `kind`, and wait for the banner. */
  async function errorRun(kind, code) {
    hooks.clearRunError();
    fake.streamThrows = new ApiClientError(kind, `fake ${kind}`);
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor(`runError ${code} reported`, () => hooks.lastRunError()?.code === code);
    await waitFor(`banner shows ${code}`, () => hooks.webviewBanner().hostError?.code === code);
    await waitFor('run finished', () => !hooks.isRunning(), 10_000);
    fake.streamThrows = null;
  }

  const lastReveal = () => hooks.runnerRevealHistory().at(-1);

  // ── Reveal ────────────────────────────────────────────────────────────

  it('a run with no Test Runner view behind it opens one', async () => {
    await disposeRunner();
    const shownBefore = hooks.webviewStateUpdateCount();

    await startRun();
    await hooks.runnerRevealSettled();
    assert.equal(lastReveal(), 'focus', 'only the view’s focus command can create it');
    await waitFor('runner visible', () => hooks.runnerVisible());
    await waitFor('new webview mounted', () => hooks.webviewStateUpdateCount() > shownBefore);
    assert.ok(fixtureStillActive(), 'the test file is still the active editor');

    await passRun();
    assert.ok(hooks.runnerVisible(), 'still on screen after the run');
  });

  it('a run with another sidebar container showing switches to the Test Runner', async () => {
    await hideRunner();

    await startRun();
    await hooks.runnerRevealSettled();
    assert.equal(lastReveal(), 'show');
    await waitFor('runner visible', () => hooks.runnerVisible());
    assert.ok(fixtureStillActive());

    await passRun();
  });

  it('a run with the sidebar closed opens it on the Test Runner', async () => {
    await hideRunner();
    await vscode.commands.executeCommand('workbench.action.closeSidebar');

    await startRun();
    await hooks.runnerRevealSettled();
    assert.equal(lastReveal(), 'show');
    await waitFor('runner visible', () => hooks.runnerVisible());
    assert.ok(fixtureStillActive());

    await passRun();
  });

  it('a run with the Test Runner already visible changes nothing', async () => {
    await showRunner();

    await startRun();
    await hooks.runnerRevealSettled();
    assert.equal(lastReveal(), 'none');
    assert.ok(hooks.runnerVisible());

    await passRun();
  });

  it('a visible detached runner panel counts as visible', async () => {
    await hideRunner();
    await vscode.commands.executeCommand('steptix.openInEditor');
    await waitFor('detached panel visible', () => hooks.runnerVisible());
    // The panel opened beside the editor and took focus; Run is an editor
    // gesture, so go back to the fixture without covering the panel.
    await openFixture();
    assert.ok(hooks.runnerVisible(), 'the panel is in its own group, still visible');

    await startRun();
    await hooks.runnerRevealSettled();
    assert.equal(lastReveal(), 'none', 'the sidebar is not forced open beside a visible panel');

    await passRun();
  });

  it('a Test Explorer batch run does not reveal the Test Runner', async () => {
    await hideRunner();
    const before = hooks.runnerRevealHistory().length;

    fake.streamScripts = [
      async (f) => {
        f.push({ type: 'step:start', line: STEP_1 });
        f.push({ type: 'step:pass', line: STEP_1 });
        f.push({ type: 'done', status: 'passed' });
        f.end();
      },
    ];
    await hooks.discoveryReady();
    const counts = await hooks.runBatchByUris([testUri]);
    assert.equal(counts.passed, 1, 'the batch ran the fixture');

    await hooks.runnerRevealSettled();
    assert.equal(hooks.runnerRevealHistory().length, before, 'a batch never asks for a reveal');
    assert.equal(hooks.runnerVisible(), false);
  });

  // ── Keyboard focus ────────────────────────────────────────────────────

  describe('keyboard focus (needs the test window in the foreground)', () => {
    /**
     * Does the fixture's editor have keyboard focus — what F5's
     * `editorTextFocus` asks? Context keys are not readable from the extension
     * host, and the active editor stays active while focus is in a sidebar.
     * The `type` command is: it types into the FOCUSED code editor and does
     * nothing without one. So type a character, see whether the document took
     * it, and undo it.
     *
     * Skips the calling test when the window is not in the foreground, before
     * or after the probe — the answer is not trustworthy then (see header).
     */
    async function editorHasTextFocus(ctx) {
      if (!vscode.window.state.focused) ctx.skip();
      const doc = vscode.window.activeTextEditor?.document;
      assert.ok(doc, 'an active editor to probe');
      const before = doc.version;
      await vscode.commands.executeCommand('type', { text: 'Z' });
      const typed = doc.version !== before;
      if (typed) {
        await vscode.commands.executeCommand('undo');
        await waitFor('probe undone', () => !doc.isDirty);
      }
      if (!vscode.window.state.focused) ctx.skip();
      return typed;
    }

    it('the probe tells an editor with focus from one without', async function () {
      // Every "focus stayed in the editor" below rests on this probe, so prove
      // it can say no as well as yes.
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
      assert.equal(await editorHasTextFocus(this), false, 'focus in the Explorer is not editor focus');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      assert.equal(await editorHasTextFocus(this), true, 'focus in the editor is');
    });

    it('opening a Test Runner that had no view hands focus back to the editor', async function () {
      if (!vscode.window.state.focused) this.skip();
      await disposeRunner();

      await startRun();
      await hooks.runnerRevealSettled();
      assert.equal(lastReveal(), 'focus');
      await passRun();
      // Probed after the run so the probe's keystroke cannot land mid-run, and
      // so a webview that grabs focus as its content loads — after the reveal
      // handed it back — has had the time to.
      assert.equal(await editorHasTextFocus(this), true, 'F5 still reaches the editor');
      assert.equal(hooks.webviewBanner().hasFocus, false, 'focus stayed out of the panel');
    });

    it('showing a hidden Test Runner leaves focus in the editor', async function () {
      if (!vscode.window.state.focused) this.skip();
      await showRunner();
      await hideRunner();

      await startRun();
      await hooks.runnerRevealSettled();
      assert.equal(lastReveal(), 'show');
      await passRun();
      assert.equal(await editorHasTextFocus(this), true, 'F5 still reaches the editor');
      assert.equal(hooks.webviewBanner().hasFocus, false, 'focus stayed out of the panel');
    });

    it('a run with the Test Runner already visible leaves focus in the editor', async function () {
      if (!vscode.window.state.focused) this.skip();
      await showRunner();

      await startRun();
      await hooks.runnerRevealSettled();
      assert.equal(lastReveal(), 'none');
      await passRun();
      assert.equal(await editorHasTextFocus(this), true, 'F5 still reaches the editor');
    });
  });

  // ── The error banner ──────────────────────────────────────────────────

  describe('error banner', () => {
    beforeEach(async () => {
      await showRunner();
      await openFixture();
      // Start each case from no banner, whatever the last case left.
      await vscode.commands.executeCommand('steptix.dismissError');
      await waitFor('no banner', () => hooks.webviewBanner().hostError === null);
    });

    it('a run that errors shows its banner, and the run after it that passes closes it as it starts', async () => {
      await errorRun('unauthorized', 'STX011');

      await startRun();
      // Still running: the banner is gone because the run STARTED, not
      // because it passed.
      await waitFor('banner closed on run start', () => hooks.webviewBanner().hostError === null);
      assert.ok(hooks.isRunning(), 'cleared while the new run is in flight');

      await passRun();
      assert.equal(hooks.webviewBanner().hostError, null, 'a passing run leaves no banner');
    });

    it('an error after an error replaces the banner with the new run’s own', async () => {
      await errorRun('unauthorized', 'STX011');
      const mark = hooks.webviewBannerHistory().length;

      await errorRun('not-found', 'STX012');
      assert.deepEqual(
        hooks.webviewBannerHistory().slice(mark),
        [null, 'STX012'],
        'the first banner closed when the run started, then the second went up',
      );
    });

    it('the same error twice is a fresh banner, not one that never closed', async () => {
      await errorRun('unauthorized', 'STX011');
      const mark = hooks.webviewBannerHistory().length;

      await errorRun('unauthorized', 'STX011');
      assert.deepEqual(
        hooks.webviewBannerHistory().slice(mark),
        [null, 'STX011'],
        'without the close in between this reads [] — the old banner, still up',
      );
    });

    it('a dismissed banner stays closed through a passing run', async () => {
      await errorRun('unauthorized', 'STX011');
      await vscode.commands.executeCommand('steptix.dismissError');
      await waitFor('banner dismissed', () => hooks.webviewBanner().hostError === null);
      const mark = hooks.webviewBannerHistory().length;

      await startRun();
      await passRun();
      assert.equal(hooks.webviewBanner().hostError, null);
      assert.deepEqual(hooks.webviewBannerHistory().slice(mark), [], 'nothing came back');
    });

    it('a run from a hidden Test Runner that errors shows its banner there', async () => {
      await hideRunner();

      await errorRun('unauthorized', 'STX011');
      assert.ok(hooks.runnerVisible(), 'the run revealed the panel the error is in');
      assert.ok(fixtureStillActive());
    });
  });

  // ── What an author actually does ──────────────────────────────────────
  //
  // The cases above pin each mechanism. These follow an author through the
  // situations the feature exists for, most common first, and assert what
  // they would SEE: the panel on screen, and the right thing in it.

  describe('what an author does', () => {
    const statuses = () => Object.fromEntries(hooks.tracker.snapshot().statuses);
    const failures = () => Object.fromEntries(hooks.tracker.snapshot().failures);

    afterEach(async () => {
      if (vscode.debug.breakpoints.length > 0) {
        vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
      }
      fake.endAll();
      await waitFor('idle', () => !hooks.isRunning(), 10_000);
    });

    it('first Run of the day: server not started, Test Runner never opened — the panel opens ON the error', async () => {
      await disposeRunner();

      // What a stopped server looks like once auto-start has nothing to do:
      // the connection is refused (STX010).
      await errorRun('connect-failed', 'STX010');
      assert.ok(hooks.runnerVisible(), 'the run put the panel on screen');
      assert.equal(hooks.webviewBanner().running, false, 'and it does not claim a run is going');
    });

    it('…then starts the server and presses Run again: the error goes and the run shows as running', async () => {
      await showRunner();
      await errorRun('connect-failed', 'STX010');

      await startRun();
      await waitFor('banner closed', () => hooks.webviewBanner().hostError === null);
      await waitFor('panel shows the run', () => hooks.webviewBanner().running === true);

      await passRun();
      await waitFor('panel shows it finished', () => hooks.webviewBanner().running === false);
      assert.equal(hooks.webviewBanner().hostError, null);
    });

    it('Run with the Test Runner never opened: the panel that opens mid-run knows a run is going', async () => {
      // Its toolbar decides Run versus Stop and Pause from this. A panel
      // created after `running` was posted would offer Run during the run.
      await disposeRunner();

      await startRun();
      await waitFor('runner visible', () => hooks.runnerVisible());
      await waitFor('panel shows the run', () => hooks.webviewBanner().running === true);

      await passRun();
      await waitFor('panel shows it finished', () => hooks.webviewBanner().running === false);
    });

    it('a step fails with the Test Runner hidden: it opens with the failure, and a fixed re-run clears it', async () => {
      await hideRunner();

      await startRun();
      fake.push({ type: 'step:start', line: 8 });
      fake.push({ type: 'step:pass', line: 8 });
      fake.push({ type: 'step:start', line: 9 });
      fake.push({ type: 'step:fail', line: 9, error: 'No "Get started" button on the page' });
      fake.push({ type: 'done', status: 'failed' });
      fake.end();
      await waitFor('run finished', () => !hooks.isRunning(), 10_000);

      assert.ok(hooks.runnerVisible(), 'the failure is somewhere the author can see it');
      assert.equal(statuses()[9], 'fail');
      assert.equal(failures()[9]?.error, 'No "Get started" button on the page');
      assert.equal(hooks.webviewBanner().hostError, null, 'a failed step is not a run error');

      // The author fixes the step and runs the test again.
      await startRun();
      for (const line of [8, 9, 10]) {
        fake.push({ type: 'step:start', line });
        fake.push({ type: 'step:pass', line });
      }
      fake.push({ type: 'done', status: 'passed' });
      fake.end();
      await waitFor('run finished', () => !hooks.isRunning(), 10_000);

      assert.deepEqual(failures(), {}, 'the old failure text is gone');
      assert.equal(statuses()[9], 'pass');
    });

    it('the connection drops mid-run: the panel shows why, and the next run clears it', async () => {
      await hideRunner();

      await startRun();
      fake.push({ type: 'step:start', line: 8 });
      fake.push({ type: 'step:pass', line: 8 });
      fake.drop('stream-dropped', 'socket hang up');
      await waitFor('STX014 reported', () => hooks.lastRunError()?.code === 'STX014');
      await waitFor('banner shows STX014', () => hooks.webviewBanner().hostError?.code === 'STX014');
      assert.ok(hooks.runnerVisible());
      assert.equal(statuses()[8], 'pass', 'the step that ran keeps its mark');

      await startRun();
      await waitFor('banner closed', () => hooks.webviewBanner().hostError === null);
      await passRun();
    });

    it('paused at a breakpoint, the author closes the sidebar for room, then Continues: the panel comes back', async () => {
      await showRunner();
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(testUri, new vscode.Position(9, 0)), true),
      ]);

      await startRun();
      fake.push({ type: 'step:start', line: 8 });
      fake.push({ type: 'step:pass', line: 8 });
      fake.push({ type: 'step:start', line: 9 });
      fake.push({ type: 'step:pass', line: 9 });
      fake.end();
      await waitFor('paused at step 3', () => hooks.tracker.snapshot().breakpointStop === 10);

      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await waitFor('runner hidden', () => !hooks.runnerVisible());

      void vscode.commands.executeCommand('steptix.continueRun');
      await waitFor('continued', () => fake.hasActiveStream);
      await waitFor('runner visible again', () => hooks.runnerVisible());
      assert.ok(fixtureStillActive());

      fake.push({ type: 'step:start', line: 10 });
      fake.push({ type: 'step:pass', line: 10 });
      fake.push({ type: 'done', status: 'passed' });
      fake.end();
      await waitFor('run finished', () => !hooks.isRunning(), 10_000);
    });

    it('closing and reopening the Test Runner keeps an error until the author dismisses it', async () => {
      await showRunner();
      await errorRun('connect-failed', 'STX010');

      // Hidden and reopened later — a brand-new view.
      await disposeRunner();
      const mark = hooks.webviewStateUpdateCount();
      await showRunner();
      await waitFor('new webview reported', () => hooks.webviewStateUpdateCount() > mark);
      await waitFor('error still shown', () => hooks.webviewBanner().hostError?.code === 'STX010');

      // The banner's ✕, as the webview sends it.
      await hooks.dispatchWebviewMessage({ type: 'dismissRunError' });
      await waitFor('dismissed', () => hooks.webviewBanner().hostError === null);
      // What a view opened from now on is handed. Read on the host: a new
      // webview's first report comes before it has handled the hand-over,
      // so "no banner" there would pass whether or not one was coming.
      assert.equal(hooks.runnerReplay().runError, null, 'a dismissed error does not come back');
    });

    // ── Edge cases ──

    it('the Test Runner moved to the bottom panel, panel closed: Run opens the panel on it', async () => {
      await vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: ['steptix.runner'],
        destinationId: 'workbench.panel.output',
      });
      try {
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await openFixture();
        await waitFor('runner hidden', () => !hooks.runnerVisible());

        await startRun();
        await hooks.runnerRevealSettled();
        await waitFor('runner visible in the panel', () => hooks.runnerVisible());
        assert.ok(fixtureStillActive());
        await passRun();
      } finally {
        await vscode.commands.executeCommand('steptix.runner.resetViewLocation');
        await vscode.commands.executeCommand('workbench.action.closePanel');
      }
    });

    it('a detached runner hidden behind another tab does not count: the sidebar runner is shown', async () => {
      await hideRunner();
      await vscode.commands.executeCommand('steptix.openInEditor');
      await waitFor('detached panel visible', () => hooks.runnerVisible());
      // Something else opens in the panel's group, covering it. Without
      // moving focus: switching the active editor between two text editors in
      // different groups is only reliable while the window is in the
      // foreground (see the header), and this case is not about focus.
      const other = await vscode.workspace.openTextDocument(fixtureUri('plain.md'));
      await vscode.window.showTextDocument(other, {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      });
      await openFixture();
      await waitFor('nothing visible', () => !hooks.runnerVisible());

      await startRun();
      await hooks.runnerRevealSettled();
      assert.notEqual(lastReveal(), 'none');
      await waitFor('runner visible', () => hooks.runnerVisible());
      await passRun();
    });
  });
});
