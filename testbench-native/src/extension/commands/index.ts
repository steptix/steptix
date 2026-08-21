import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSteps, sectionBodyLinesAt, type StepMode } from 'ai-ui-automation-runner-core';
import { extractStepLineIds } from '../step-lines.js';
import type { ActiveFileTracker } from '../active-file-tracker.js';
import type { RunController, SkillDebugContext } from '../run-controller.js';
import { getOutputChannel } from '../output-channel.js';
import { cacheDirsForTestAllEnvs } from '../cache-paths.js';
import { sectionedSkillRefusal } from '../sections.js';

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
  /** The controller for a test document URI string, if one exists. */
  controllerForUri(uri: string): RunController | undefined;
  /** The controller holding a parked skill-step failure, if any (Stop capture). */
  controllerWithSkillFailure(): RunController | undefined;
  /** The single active "debug a skill after Stop" context, or null. */
  readonly skillDebug: SkillDebugContext | null;
  /** Set/replace the skill-debug context (latest Stop wins). */
  setSkillDebug(ctx: SkillDebugContext): void;
  /** Clear the skill-debug context unconditionally (Close Session, dead session). */
  clearSkillDebug(): void;
  /** Clear the skill-debug context only if it is owned by `testUri`. */
  clearSkillDebugIfOwnedBy(testUri: string): void;
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
  const performStop = (opts: { setSkillDebug?: boolean } = {}): void => {
    const controller = registry.active();
    // On an explicit Stop (not Close Session), park a skill-debug context for a
    // parked TOP-LEVEL skill failure — read BEFORE resetFrameState wipes
    // lastSkillFailure. Latest Stop wins (setSkillDebug replaces any prior).
    if (opts.setSkillDebug) {
      const failed = controller?.lastSkillFailure
        ? controller
        : registry.controllerWithSkillFailure();
      const f = failed?.lastSkillFailure;
      // Skill failures only. "Debug a skill after Stop" opens the skill file
      // and runs its body against the stopped session — for a SECTION,
      // `skillUri` is the test file itself, so that flow would activate
      // against the wrong thing entirely: it would offer to debug "the skill"
      // by reopening the test the user is already looking at. Section re-runs
      // go through the Variables panel path instead, which needs no such
      // context.
      if (f && f.kind === 'skill') {
        registry.setSkillDebug({
          testUri: f.testUri,
          testLine: f.testLine,
          skillUri: f.skillUri,
          skillName: f.skillName,
          frameId: f.frameId,
        });
      }
    }
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
      performStop({ setSkillDebug: true });
    }),

    // "Debug a skill against a stopped session": run the selected skill step(s)
    // (or the whole skill body if nothing is selected) against the still-live
    // session of the test that was Stopped inside this skill. Routes through the
    // owning test's controller so the open browser + live variables are reused.
    // See stories/specs/skill-debug-after-stop.md.
    vscode.commands.registerCommand('testbench-native.runSkillStepsOnStoppedSession', async () => {
      const ctx = registry.skillDebug;
      if (!ctx) {
        vscode.window.setStatusBarMessage(
          'TestBench: no stopped skill to debug — Stop a test that failed inside a skill first',
          3000,
        );
        return;
      }
      const editor = tracker.activeEditor;
      if (!editor || vscode.Uri.file(ctx.skillUri).toString() !== editor.document.uri.toString()) {
        vscode.window.setStatusBarMessage(
          `TestBench: open the skill being debugged (${ctx.skillName}) to run its steps`,
          3000,
        );
        return;
      }
      // Range = the selected step lines, or the whole skill body when nothing is
      // selected. `extractSteps` keys on the `## Steps` list, which skills have;
      // its line model matches the server's expanded source lines.
      const steps = extractSteps(editor.document.getText());
      if (steps.length === 0) {
        vscode.window.setStatusBarMessage('TestBench: no steps found in this skill', 2500);
        return;
      }
      const bodyLines = steps.map((s) => s.line);
      const stepLineSet = new Set(bodyLines);
      const selected = selectionLines(editor).filter((l) => stepLineSet.has(l));
      const targetLines = selected.length > 0 ? selected : bodyLines;
      const startLine = targetLines[0]!;
      const endLine = targetLines[targetLines.length - 1]!;

      const controller = registry.controllerForUri(ctx.testUri.toString());
      if (!controller) {
        registry.clearSkillDebug();
        vscode.window.setStatusBarMessage('TestBench: the stopped test is no longer open', 3000);
        return;
      }
      // Liveness pre-flight BEFORE notifyRunning — a dead session must refuse
      // (and clear the context) rather than silently spin up a blank browser.
      const live = await controller.isRerunSessionLive();
      if (!live) {
        registry.clearSkillDebug();
        vscode.window.setStatusBarMessage(
          'TestBench: the stopped session is no longer alive — re-run the test to debug again',
          4000,
        );
        return;
      }
      // Same anchoring hazard as the Variables-panel re-run: a skill that
      // defines its own sections cannot be line-anchored safely, because the
      // server applies exact matching only to the test file and falls back to
      // nearest-line in a skill — landing inside a body that already ran.
      // This context is skill-kind by construction (it comes from the Stop
      // gate, which only captures skill failures).
      const unsupported = sectionedSkillRefusal({
        kind: 'skill',
        skillUri: ctx.skillUri,
        skillName: ctx.skillName,
      });
      if (unsupported) {
        vscode.window.setStatusBarMessage(unsupported, 6000);
        return;
      }
      registry.notifyRunning(true);
      void controller
        .runLines([ctx.testLine], {
          isContinuation: true,
          rerun: {
            startAt: { uri: ctx.skillUri, line: startLine },
            endAt: { uri: ctx.skillUri, line: endLine },
          },
        })
        .finally(() => registry.notifyRunning(false));
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
      const sectionCtx = tracker.resumeContextFor(controller.document.uri);
      if (startLine != null && !controller.isRunning) {
        tracker.setBreakpointStop(controller.document.uri, null);
        const breakpoints = tracker.breakpoints(controller.document.uri);
        // A marker parked inside a section body resumes THAT step, not the
        // invocation above it. The context is also the discriminator: a body
        // line without one is a marker we can't resume (dropped stream,
        // restarted server) and still falls through to the refusal below.
        if (sectionCtx) {
          const plan = sectionResumePlan(
            editor.document.getText(),
            startLine,
            sectionCtx.callLine,
            controller.document.uri.fsPath,
          );
          if (!plan) {
            refuseStaleResume(tracker, controller.document.uri);
            return;
          }
          registry.notifyRunning(true);
          await controller
            .runLines(plan.lines, {
              breakpoints,
              skipBreakpointAtStart: true,
              isContinuation: true,
              ...(plan.rerun && { rerun: plan.rerun }),
            })
            .finally(() => registry.notifyRunning(false));
          return;
        }
        // Continue runs from startLine to end-of-document. Passing
        // `[startLine]` alone would collapse through resolveRunLines
        // to a one-step run — useful for Step Over but not Continue.
        const resumeLines = extractSteps(editor.document.getText())
          .map((s) => s.line)
          .filter((line) => line >= startLine);
        if (resumeLines.length === 0) {
          refuseStaleResume(tracker, controller.document.uri);
          return;
        }
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
      // Closing this test's session ends its debug context (page is gone).
      registry.clearSkillDebugIfOwnedBy(controller.document.uri.toString());
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

    // Wipes <project-root>/.cache/<env>/<dir>/ for the active test across EVERY
    // env segment, not just the active one. A single file can populate multiple
    // segments: an interactive run uses the EnvSelector's active env, while a
    // batch run keys off the test's frontmatter env (test-controller.ts's
    // `frontmatter.env ?? batchEnv`), so the same file may have written
    // `.cache/dev/<dir>/` AND `.cache/staging/<dir>/`. Clearing only the active
    // env's entry would silently leave the others stale (issue 012 gap), so this
    // enumerates all segments — "clear" means clear. Skill steps invoked from
    // this test live in the same dir (the cache is keyed off the test file, not
    // per-skill) so they go too. Bundle-hash invalidation already covers "I
    // edited a step" — this command is for the cases the hash can't see: env
    // values changed, model upgraded, real-world page drift on a step that
    // scrapes a live site, etc.
    vscode.commands.registerCommand('testbench-native.clearCacheForThisTest', async () => {
      const editor = tracker.activeEditor;
      if (!editor) return notifyNoActive();
      const testFilePath = editor.document.uri.fsPath;
      const cacheDirs = cacheDirsForTestAllEnvs(testFilePath);
      if (cacheDirs.length === 0) {
        vscode.window.setStatusBarMessage(
          'TestBench: no cache to clear for this test',
          2000,
        );
        return;
      }
      const fileLabel = path.basename(testFilePath);
      const detail =
        cacheDirs.length === 1
          ? `This removes ${cacheDirs[0]}.\n\nThe next run will call the AI again to repopulate it.`
          : `This removes ${cacheDirs.length} cached env entries:\n${cacheDirs.join('\n')}\n\nThe next run will call the AI again to repopulate them.`;
      const choice = await vscode.window.showWarningMessage(
        `Delete cached AI responses for ${fileLabel}?`,
        { modal: true, detail },
        'Delete',
      );
      if (choice !== 'Delete') return;
      const failed: string[] = [];
      for (const dir of cacheDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          getOutputChannel().appendLine(`Cleared step cache: ${dir}`);
        } catch (err) {
          failed.push(`${dir} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failed.length > 0) {
        vscode.window.showErrorMessage(
          `TestBench: failed to clear cache — ${failed.join('; ')}`,
        );
        return;
      }
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
  const sectionCtx = tracker.resumeContextFor(controller.document.uri);
  if (startLine != null) {
    tracker.setBreakpointStop(controller.document.uri, null);
    const breakpoints = tracker.breakpoints(controller.document.uri);
    // Same section-body branch as `continueRun` — this is the second consumer
    // of the resume marker, and the one that gets forgotten.
    if (sectionCtx) {
      const plan = sectionResumePlan(
        editor.document.getText(),
        startLine,
        sectionCtx.callLine,
        controller.document.uri.fsPath,
      );
      if (!plan) {
        refuseStaleResume(tracker, controller.document.uri);
        return;
      }
      registry.notifyRunning(true);
      await controller
        .runLines(plan.lines, {
          breakpoints,
          skipBreakpointAtStart: true,
          isContinuation: true,
          stepMode: mode,
          ...(plan.rerun && { rerun: plan.rerun }),
        })
        .finally(() => registry.notifyRunning(false));
      return;
    }
    const resumeLines = extractSteps(editor.document.getText())
      .map((s) => s.line)
      .filter((line) => line >= startLine);
    if (resumeLines.length === 0) {
      refuseStaleResume(tracker, controller.document.uri);
      return;
    }
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

/**
 * Refuse to resume from a pause marker that no longer names a runnable step.
 *
 * Both call sites have already cleared the marker by the time they get here —
 * they clear it before computing `resumeLines`, so a refused resume does not
 * leave the arrow painted. The clear below is belt-and-braces for a future
 * caller that doesn't.
 *
 * Both resume paths compute `resumeLines` as "every main-flow step at or
 * after the parked line". For a marker parked on a SECTION BODY line that
 * list is empty — bodies are defined below the main flow, so no main-flow
 * step sits at or after them — and passing `[]` to `runLines` is the literal
 * "run everything" convention. The run-line guard cannot help here: it fires
 * on a non-empty request that resolves to nothing, and this request is empty
 * to begin with, indistinguishable from batch mode.
 *
 * Body-line markers became possible the moment breakpoints inside sections
 * started pausing server-side. Nothing clears a marker except Stop, a new
 * run, or the next `step:start`, so a dropped stream or a restarted server
 * leaves one behind — and resuming from it would silently re-run the whole
 * test against a live session.
 */
/**
 * How to resume a marker parked inside a section body, or null when it can't
 * be resumed from where it sits.
 *
 * Two shapes, decided by whether an invocation was recorded with the marker:
 *
 *  - **Anchored** (`callLine` set) — the body was running under a call. Send
 *    that call line *and every main-flow step after it*, with `startAt` on
 *    the body line. The server expands the invocation into the whole body,
 *    anchors at the failed step, and runs on into the rest of the test — so
 *    Continue means the same thing here as it does in the main flow. Sending
 *    the whole tail rather than the invocation alone is also what
 *    disambiguates a section invoked twice: the first exact match inside an
 *    expansion that STARTS at this call can only be this invocation's.
 *  - **Detached** (`callLine` null) — nothing invoked the body; it was run
 *    directly from a selection. Re-run the rest of that section's body the
 *    same way, with no anchor. `runLines` re-derives section-body scope from
 *    the lines themselves.
 *
 * Null when the file has changed out from under the marker — no main-flow
 * step at the call line, or no body step left at the anchor.
 */
function sectionResumePlan(
  text: string,
  bodyLine: number,
  callLine: number | null,
  testFilePath: string,
): { lines: number[]; rerun?: { startAt: { uri: string; line: number } } } | null {
  if (callLine == null) {
    const lines = sectionBodyLinesAt(text, bodyLine).filter((line) => line >= bodyLine);
    return lines.length > 0 ? { lines } : null;
  }
  const lines = extractSteps(text)
    .map((s) => s.line)
    .filter((line) => line >= callLine);
  if (lines.length === 0) return null;
  return { lines, rerun: { startAt: { uri: testFilePath, line: bodyLine } } };
}

function refuseStaleResume(tracker: ActiveFileTracker, uri: vscode.Uri): void {
  tracker.setBreakpointStop(uri, null);
  vscode.window.setStatusBarMessage(
    'TestBench: the paused step is no longer runnable on its own — use Run All',
    4000,
  );
}
