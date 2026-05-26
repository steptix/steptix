import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSteps, type StepMode } from 'ai-ui-automation-runner-core';
import { extractStepLineIds } from '../step-lines.js';
import type { ActiveFileTracker } from '../active-file-tracker.js';
import type { RunController } from '../run-controller.js';
import { getOutputChannel } from '../output-channel.js';
import { cacheDirForTest } from '../cache-paths.js';

interface Registry {
  active(): RunController | undefined;
  /** The currently-running controller, if any. Prefer this over
   *  `active()` for step commands when a run is in flight — see
   *  `dispatchStep` for the routing rule. */
  runningController(): RunController | undefined;
  refreshRunningContext(): void;
  notifyRunning(running: boolean): void;
  /** Phase 3.1 — drop step-paused yellow ▶ markers across every URI
   *  they live on (test file AND any skill file the run descended into). */
  clearAllStepPausedMarkers(): void;
  /** Phase 3.1.b — distinguish step-paused (server blocked on
   *  pendingRunControl) from running-but-not-step-paused (server is
   *  mid-step). dispatchStep uses this to give a clean diagnostic
   *  instead of a 409. */
  isStepPaused(controllerUri: vscode.Uri): boolean;
  /** Phase 5 — where the step-paused yellow ▶ is parked, so dispatch
   *  can detect F11-on-a-tool-line and request the tool-debugger pause. */
  stepPausedEntry(controllerUri: vscode.Uri): { uri: vscode.Uri; line: number } | null;
}

/**
 * Register every contributed command. Returns disposables for the activator
 * to push into context.subscriptions.
 *
 * All commands work against the *active TextEditor*. The
 * `testbench-native.activeFile` context key (set by ActiveFileTracker) gates menu
 * visibility so users can't invoke them on non-test markdown.
 */
export function registerCommands(
  registry: Registry,
  tracker: ActiveFileTracker,
): vscode.Disposable[] {
  const runSelected = async (): Promise<void> => {
    const controller = registry.active();
    const editor = tracker.activeEditor;
    if (!controller || !editor) return notifyNoActive();
    // selectionLines returns [] for cursor-only "selections" (no
    // highlighted range), which runLines interprets as "run every step in
    // the document" — the same behavior as Run All. See selectionLines'
    // doc comment for why.
    const lines = selectionLines(editor);
    const breakpoints = tracker.breakpoints(controller.document.uri);
    registry.notifyRunning(true);
    await controller.runLines(lines, { breakpoints }).finally(() => registry.notifyRunning(false));
  };

  /**
   * Fully stop the active run and wipe its UI state. Shared by the Stop
   * command and Close Session — closing a session while a run is in flight
   * (or paused awaiting Continue) must first tear the run down, otherwise
   * spinners and the yellow ▶ stay painted with no session behind them.
   */
  const performStop = (): void => {
    const controller = registry.active();
    controller?.stop();
    // Stop must flip running statuses on BOTH the test file and any skill
    // file the run descended into — otherwise skill-body lines keep
    // spinning. Frame state on the controller is wiped too so a subsequent
    // run doesn't inherit stale frames.
    controller?.resetFrameState();
    const editor = tracker.activeEditor;
    if (editor && tracker.isActiveTestFile) {
      tracker.setBreakpointStop(editor.document.uri, null);
    }
    tracker.markAllRunningStopped();
    // A step-paused yellow ▶ may live on a SKILL file the run descended
    // into — `setBreakpointStop` above only cleared the test-file marker.
    // Walk every recorded step-paused entry and clear it where painted.
    registry.clearAllStepPausedMarkers();
    registry.notifyRunning(false);
  };

  return [
    vscode.commands.registerCommand('testbench-native.runSelected', runSelected),

    vscode.commands.registerCommand('testbench-native.runAll', async () => {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      await controller
        .runLines([], { breakpoints })
        .finally(() => registry.notifyRunning(false));
    }),

    vscode.commands.registerCommand('testbench-native.pause', () => {
      const controller = registry.active();
      if (!controller || !controller.isRunning) {
        vscode.window.setStatusBarMessage('TestBench: nothing to pause', 1500);
        return;
      }
      controller.pause();
      // Pause leaves the in-flight step's status as `running` (blue spinner)
      // unless we flip it. The spinner spins forever on whichever file the
      // step belonged to — most visibly on a skill body line, where the
      // yellow ▶ doesn't even live on the same file. Same wipe Stop uses
      // (running → stopped across every tracked URI) is the right move here:
      // the step was interrupted mid-flight, so it isn't passing, failing,
      // or still executing.
      tracker.markAllRunningStopped();
    }),

    vscode.commands.registerCommand('testbench-native.stop', () => {
      performStop();
    }),

    // ── Phase 3 step controls ────────────────────────────────────────
    //
    // The three step commands share dispatch logic:
    //  - If a step:awaiting run is in flight (stepPaused), POST a
    //    run-control to advance.
    //  - If a breakpoint pause is set (the run isn't in flight; the
    //    extension trimmed at a breakpoint), launch a fresh run from
    //    that line with the requested stepMode — Step Into starts a
    //    stepping session.
    //  - Step Into from a fully idle state launches a new run with
    //    stepMode='into' starting at the cursor/selection. Step Over /
    //    Step Out from idle are surface-only no-ops with a status
    //    message — they only have meaning once you're inside a run.
    vscode.commands.registerCommand('testbench-native.stepInto', () =>
      dispatchStep('into', registry, tracker),
    ),
    vscode.commands.registerCommand('testbench-native.stepOver', () =>
      dispatchStep('over', registry, tracker),
    ),
    vscode.commands.registerCommand('testbench-native.stepOut', () =>
      dispatchStep('out', registry, tracker),
    ),
    // Unified Continue (matches VS Code's standard debugger
    // convention — one Continue regardless of how you got paused):
    //   - Step-paused (mid stepping run, server blocked on
    //     pendingRunControl): POST run-control with mode='continue'.
    //     Drains the rest of the run or hits the next breakpoint.
    //   - Breakpoint-paused (run trimmed at a breakpoint, no SSE
    //     stream open): re-open the stream from the pause line and
    //     run through to the end of the document or the next break.
    // The `testbench-native.resume` command stays as a back-compat
    // alias for any user keybindings + existing integration tests
    // that call it by name.
    vscode.commands.registerCommand('testbench-native.continueRun', async () => {
      // Same routing rule as `dispatchStep`: prefer the running
      // controller so Continue from a side-by-side skill file
      // advances the outer run instead of trying to relaunch the
      // skill file as a new test.
      const controller = registry.runningController() ?? registry.active();
      const editor = tracker.activeEditor;
      if (!controller || !editor) return notifyNoActive();

      // Step-paused branch — fast path: deliver the next mode via
      // run-control. The controller's `isRunning` is still true in
      // this state (SSE stream is open, just blocked on a Promise).
      if (controller.isRunning && registry.isStepPaused(controller.document.uri)) {
        await controller.sendRunControl('continue');
        return;
      }

      // Breakpoint-paused branch — re-open the stream. Read the anchor-derived
      // current line (not the raw pause-time line) so edits made while paused
      // resume the step the user actually paused on.
      const startLine = tracker.breakpointStopFor(controller.document.uri);
      if (startLine != null && !controller.isRunning) {
        tracker.setBreakpointStop(controller.document.uri, null);
        const breakpoints = tracker.breakpoints(controller.document.uri);
        // Continue runs from startLine to end-of-document. Passing
        // `[startLine]` alone would collapse through resolveRunLines
        // to a one-step run — useful for Step Over but not Continue.
        const resumeLines = extractSteps(editor.document.getText())
          .map((s) => s.line)
          .filter((line) => line >= startLine);
        registry.notifyRunning(true);
        await controller
          .runLines(resumeLines, { breakpoints, skipBreakpointAtStart: true, isContinuation: true })
          .finally(() => registry.notifyRunning(false));
        return;
      }

      vscode.window.setStatusBarMessage('TestBench: nothing to continue', 2000);
    }),

    // Back-compat alias: `testbench-native.resume` delegates to
    // continueRun. Existing tests and user-configured keybindings
    // keep working unchanged.
    //
    // NOTE: renaming or removing `testbench-native.continueRun`
    // silently breaks this alias with a runtime "command not found"
    // (the registration happens at activation; there's no compile-
    // time link between the two command IDs).
    vscode.commands.registerCommand('testbench-native.resume', () =>
      vscode.commands.executeCommand('testbench-native.continueRun'),
    ),

    vscode.commands.registerCommand('testbench-native.restartSession', async () => {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      // Close Session must also stop the test: a run that's in flight (or
      // paused awaiting Continue) otherwise keeps its spinners / yellow ▶
      // painted after the session is gone, and a later Continue would spin
      // up a brand-new session against stale UI state.
      performStop();
      await controller.closeSession();
      vscode.window.setStatusBarMessage(
        'TestBench: session closed — next F5 starts a fresh browser',
        3000,
      );
    }),

    vscode.commands.registerCommand('testbench-native.toggleBreakpoint', (target?: { lineNumber?: number }) => {
      const editor = tracker.activeEditor;
      if (!editor || !tracker.isActiveTestFile) return notifyNoActive();

      // Editor lineNumber context menus pass `{ lineNumber }` (1-based).
      // Keybindings have no argument; fall back to the cursor's line.
      const line =
        typeof target?.lineNumber === 'number'
          ? target.lineNumber
          : editor.selection.active.line + 1;

      const stepIds = new Set(extractStepLineIds(editor.document.getText()));
      if (!stepIds.has(line)) {
        vscode.window.setStatusBarMessage(
          'TestBench: breakpoints can only sit on numbered step lines',
          2500,
        );
        return;
      }
      tracker.toggleBreakpoint(editor.document.uri, line);
    }),

    vscode.commands.registerCommand('testbench-native.runStepHere', (target?: { lineNumber?: number }) => {
      const editor = tracker.activeEditor;
      const controller = registry.active();
      if (!editor || !controller) return notifyNoActive();
      const line =
        typeof target?.lineNumber === 'number'
          ? target.lineNumber
          : editor.selection.active.line + 1;
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      void controller
        .runLines([line], { breakpoints })
        .finally(() => registry.notifyRunning(false));
    }),

    vscode.commands.registerCommand('testbench-native.clearBreakpoints', () => {
      const editor = tracker.activeEditor;
      if (!editor) return notifyNoActive();
      tracker.clearBreakpoints(editor.document.uri);
    }),

    vscode.commands.registerCommand('testbench-native.clearStatuses', () => {
      const editor = tracker.activeEditor;
      if (!editor) return notifyNoActive();
      tracker.clearStatuses(editor.document.uri);
    }),

    // Wipes <project-root>/.cache/<sanitized-test-path>/ for the active
    // test. Skill steps invoked from this test live in the same dir (the
    // cache is keyed off the test file, not per-skill) so they go too.
    // Bundle-hash invalidation already covers "I edited a step" — this
    // command is for the cases the hash can't see: env values changed,
    // model upgraded, real-world page drift on a step that scrapes a live
    // site, etc.
    vscode.commands.registerCommand('testbench-native.clearCacheForThisTest', async () => {
      const editor = tracker.activeEditor;
      if (!editor) return notifyNoActive();
      const testFilePath = editor.document.uri.fsPath;
      const cacheDir = cacheDirForTest(testFilePath);
      if (!cacheDir) {
        vscode.window.setStatusBarMessage(
          'TestBench: no aiui.config.json above this file — nothing to clear',
          3000,
        );
        return;
      }
      if (!fs.existsSync(cacheDir)) {
        vscode.window.setStatusBarMessage(
          'TestBench: no cache to clear for this test',
          2000,
        );
        return;
      }
      const fileLabel = path.basename(testFilePath);
      const choice = await vscode.window.showWarningMessage(
        `Delete cached AI responses for ${fileLabel}?`,
        { modal: true, detail: `This removes ${cacheDir}.\n\nThe next run will call the AI again to repopulate it.` },
        'Delete',
      );
      if (choice !== 'Delete') return;
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      } catch (err) {
        vscode.window.showErrorMessage(
          `TestBench: failed to clear cache — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      getOutputChannel().appendLine(`Cleared step cache: ${cacheDir}`);
      vscode.window.setStatusBarMessage(`TestBench: cleared cache for ${fileLabel}`, 3000);
    }),

    vscode.commands.registerCommand('testbench-native.revealEnvFile', async () => {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const path = controller.lastEnvPath;
      if (!path) {
        vscode.window.setStatusBarMessage(
          'TestBench: no .env resolved yet — run a test first',
          3000,
        );
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
    }),

    // Opens the HTML report from the most recently completed run for the
    // active test file. The server writes the report and announces the
    // path via the `done` event's optional `reportPath` field — see the
    // Open Last Report spec under stories/specs/. We use openExternal so
    // the file launches in the user's default browser; VS Code's preview
    // is markdown-only and the report uses CSS + linked screenshots that
    // only render correctly in a real browser.
    vscode.commands.registerCommand('testbench-native.openLastReport', async () => {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const reportPath = controller.lastReportPath;
      if (!reportPath) {
        vscode.window.setStatusBarMessage(
          'TestBench: no report yet — run a test first',
          3000,
        );
        return;
      }
      if (!fs.existsSync(reportPath)) {
        vscode.window.setStatusBarMessage(
          `TestBench: report file no longer exists at ${reportPath}`,
          4000,
        );
        return;
      }
      await vscode.env.openExternal(vscode.Uri.file(reportPath));
    }),

    vscode.commands.registerCommand('testbench-native.showRunLog', () => {
      getOutputChannel().show(true);
    }),

    vscode.commands.registerCommand('testbench-native.dismissError', () => {
      // No-op host side — the webview owns the banner state.
    }),

    vscode.commands.registerCommand('testbench-native.focusRunner', async () => {
      await vscode.commands.executeCommand('testbench-native.runner.focus');
    }),
  ];
}

/**
 * 1-based line numbers covered by every *range* selection in the editor.
 * Cursor-only "selections" (no highlighted range) are ignored: a cursor
 * just means "I'm parked here," not "run this." See the same helper in
 * active-file-tracker.ts for the full rationale.
 */
function selectionLines(editor: vscode.TextEditor): number[] {
  const set = new Set<number>();
  for (const sel of editor.selections) {
    if (sel.isEmpty) continue;
    const start = sel.start.line;
    const end = sel.end.line;
    for (let i = start; i <= end; i++) set.add(i + 1);
  }
  return [...set].sort((a, b) => a - b);
}

function notifyNoActive(): void {
  vscode.window.setStatusBarMessage(
    'TestBench: open a Markdown file with a "## Steps" heading first',
    2500,
  );
}

/**
 * True when the controller's step-paused yellow ▶ is parked on a
 * `[tool: ...]` invocation. Reads the document at the paused line.
 * Returns false on any miss (no pause, document not open, no match) —
 * the caller falls back to normal stepInto behaviour, which is correct
 * for skill lines and inline AI steps.
 */
function isAtToolLine(registry: Registry, controller: RunController): boolean {
  const entry = registry.stepPausedEntry(controller.document.uri);
  if (!entry) return false;
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === entry.uri.toString(),
  );
  if (!doc) return false;
  const lineIdx = entry.line - 1;
  if (lineIdx < 0 || lineIdx >= doc.lineCount) return false;
  const text = doc.lineAt(lineIdx).text;
  return /\[tool:\s*[A-Za-z0-9_-]+/.test(text);
}

/**
 * Phase 3 step-control dispatch. Routes Step Into / Over / Out to one of
 * three behaviours depending on current state:
 *
 *  1. Run is step-paused (`step:awaiting` already received) → POST the
 *     new mode to the server's run-control endpoint. The SSE stream
 *     continues emitting events from the server's resumed step loop.
 *  2. Run is breakpoint-paused (the extension trimmed its step list at
 *     a breakpoint) → launch a fresh run from the pause line with the
 *     requested stepMode. Step Into starts a stepping session; Step
 *     Over / Out from a breakpoint pause behave the same way (they're
 *     all "advance one step from here under stepMode X").
 *  3. Otherwise (idle) → Step Into starts a fresh run from cursor/
 *     selection with stepMode='into'. Step Over / Out from idle are
 *     surface-only no-ops: there's no "current frame" to step over
 *     or out of yet.
 *
 * Toolbar-vs-keybinding asymmetry (Option D follow-up): the F11
 * keybinding deliberately fires from IDLE too (case 3 above), but the
 * StepInto toolbar button is hidden in IDLE — a StepInto glyph there
 * would imply "advance into the next call" when nothing is running,
 * which is misleading. The keybind preserves the power-user shortcut
 * "F11 starts a stepping run from cursor."
 */
async function dispatchStep(
  mode: StepMode,
  registry: Registry,
  tracker: ActiveFileTracker,
): Promise<void> {
  // Prefer the running controller over the active-editor controller
  // when a run is in flight. Without this, if the user has clicked
  // onto a side-by-side skill file (auto-revealed when the run paused
  // inside the skill), `registry.active()` returns the SKILL file's
  // controller — which has never run — so Step Over / Step Into try
  // to launch a NEW run on the skill file instead of advancing the
  // already-running outer test. When no run is in flight, fall back
  // to the active-editor controller so the "from idle" path (F11
  // starts a fresh stepping run) keeps working.
  const controller = registry.runningController() ?? registry.active();
  const editor = tracker.activeEditor;
  if (!controller || !editor) return notifyNoActive();

  // (1) Already step-paused — fast path: just deliver the next mode.
  // Phase 3.1.b: only POST when there's an actual paused step. A run
  // that's running-but-not-step-paused would otherwise generate a 409
  // and an ugly status-bar warning.
  if (controller.isRunning) {
    if (!registry.isStepPaused(controller.document.uri)) {
      vscode.window.setStatusBarMessage(
        'TestBench: run is in flight, not paused — press F5 to pause first',
        2500,
      );
      return;
    }
    // Phase 3.1.d: Step Out at depth 0 (test frame) is functionally
    // identical to Continue — the server's `'out'` decision never pauses
    // when there's no shallower frame to return to. Send `'continue'`
    // for cleaner intent and tell the user why.
    if (mode === 'out' && controller.frameStack.length === 0) {
      vscode.window.setStatusBarMessage(
        'TestBench: Step Out at the test frame = Continue',
        2000,
      );
      await controller.sendRunControl('continue');
      return;
    }
    // Phase 5 — Step Into on a `[tool: ...]` line asks the server to
    // pause at the tool dispatcher so VS Code's Node debugger can
    // attach. Detected by reading the line text at the parked
    // step-pause position; falls back to normal `into` otherwise.
    if (mode === 'into' && isAtToolLine(registry, controller)) {
      await controller.sendRunControl('into', { pauseAtNextTool: true });
      return;
    }
    await controller.sendRunControl(mode);
    return;
  }

  // (2) Breakpoint-paused: relaunch from that line with the chosen mode.
  // Anchor-derived current line — see continueRun above.
  const startLine = tracker.breakpointStopFor(controller.document.uri);
  if (startLine != null) {
    tracker.setBreakpointStop(controller.document.uri, null);
    const breakpoints = tracker.breakpoints(controller.document.uri);
    const resumeLines = extractSteps(editor.document.getText())
      .map((s) => s.line)
      .filter((line) => line >= startLine);
    // Phase 5 — if the breakpoint sat on a `[tool: ...]` line and the
    // command is Step Into, seed the run with `pauseAtNextTool: true`
    // so the server emits `tool:awaiting-debugger` before that step.
    const lineText = editor.document.lineAt(Math.max(0, startLine - 1)).text;
    const isToolLine = /\[tool:\s*[A-Za-z0-9_-]+/.test(lineText);
    const pauseAtNextTool = mode === 'into' && isToolLine;
    registry.notifyRunning(true);
    await controller
      .runLines(resumeLines, {
        breakpoints,
        skipBreakpointAtStart: true,
        stepMode: mode,
        // Resuming from a breakpoint pause is a continuation (same as
        // Continue) — without this, runLines clears all statuses and the
        // pass marks earned by steps before the breakpoint disappear when
        // the user Steps Into the next step.
        isContinuation: true,
        ...(pauseAtNextTool && { pauseAtNextTool: true }),
      })
      .finally(() => registry.notifyRunning(false));
    return;
  }

  // (3) Idle: only Step Into has meaning; Step Over / Out need a frame
  // to operate against and the user hasn't started one yet.
  if (mode !== 'into') {
    vscode.window.setStatusBarMessage(
      'TestBench: start a run (F5 or F11) before using Step Over / Step Out',
      2500,
    );
    return;
  }
  const lines = selectionLines(editor);
  const breakpoints = tracker.breakpoints(controller.document.uri);
  registry.notifyRunning(true);
  await controller
    .runLines(lines, { breakpoints, stepMode: 'into' })
    .finally(() => registry.notifyRunning(false));
}
