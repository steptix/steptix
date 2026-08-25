import * as vscode from 'vscode';
import type { ActiveFileTracker, FileStateSnapshot } from './active-file-tracker.js';
import { classifyLines, extractSteps } from 'ai-ui-automation-runner-core';
import { extractStepLineIds, findStepsHeadingLine } from './step-lines.js';

/**
 * The N/M pass-summary counts for a snapshot.
 *
 * Exported and pure so the test hook asserts THIS, not a copy of it — the
 * whole point of the summary is that M is the author's main-flow step count,
 * and a body line can run zero times or many, so counting body lines makes M
 * meaningless and lets N exceed it. A test that reimplemented the rule would
 * pass while the rendered decoration was wrong.
 *
 * `mainFlowLines` is the denominator's source, returned so the render path
 * can reuse it for the "any steps at all?" gate without re-extracting.
 */
export function computeStepsSummary(snap: FileStateSnapshot): {
  passed: number;
  passedCached: number;
  /** Passed by running compiled code — no model call. */
  passedCodeBehind: number;
  /** Passed under AI after the compiled entry threw. */
  stale: number;
  total: number;
  mainFlowLines: number[];
} {
  const mainFlowLines = extractSteps(snap.text).map((s) => s.line);
  const mainFlowSet = new Set(mainFlowLines);
  const count = (...wanted: string[]): number =>
    snap.statuses.filter(([line, status]) => wanted.includes(status) && mainFlowSet.has(line))
      .length;
  // Every 'pass*' counts as passed — a cache hit, a code-behind entry and a
  // step that healed under AI are all successful steps. What differs is what
  // it cost and whether it needs attention, which is what the breakdown says.
  const passed = count('pass', 'pass-cached', 'pass-code-behind', 'pass-stale');
  return {
    passed,
    passedCached: count('pass-cached'),
    passedCodeBehind: count('pass-code-behind'),
    stale: count('pass-stale'),
    total: mainFlowLines.length,
    mainFlowLines,
  };
}

/**
 * Paints TestBench decorations on the active TextEditor: breakpoint dot,
 * per-step status icons (pass/fail/skip/running), the yellow "paused-at"
 * arrow, and an inline error band on lines that errored.
 *
 * One DecorationManager exists for the lifetime of the extension. It
 * subscribes to the ActiveFileTracker's state changes and re-applies
 * decorations whenever the snapshot moves.
 */
export class DecorationManager implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];

  private readonly breakpointStopped: vscode.TextEditorDecorationType;
  private readonly statusPass: vscode.TextEditorDecorationType;
  private readonly statusPassCached: vscode.TextEditorDecorationType;
  private readonly statusCodeBehind: vscode.TextEditorDecorationType;
  private readonly statusStale: vscode.TextEditorDecorationType;
  private readonly statusFail: vscode.TextEditorDecorationType;
  private readonly statusRunning: vscode.TextEditorDecorationType;
  private readonly statusSkip: vscode.TextEditorDecorationType;
  private readonly statusStopped: vscode.TextEditorDecorationType;
  private readonly statusPlaceholder: vscode.TextEditorDecorationType;
  private readonly inertStep: vscode.TextEditorDecorationType;
  private readonly stepsSummary: vscode.TextEditorDecorationType;
  private readonly errorLine: vscode.TextEditorDecorationType;

  constructor(
    context: vscode.ExtensionContext,
    private readonly tracker: ActiveFileTracker,
  ) {
    const icon = (name: string): vscode.Uri =>
      vscode.Uri.joinPath(context.extensionUri, 'icons', name);

    // Reserve a status cell before every step line, even before a run has
    // started. Visible statuses and the invisible placeholder use the same
    // text attachment metrics, so the numbered Markdown list stays aligned.
    const statusIcon = (name: string): vscode.DecorationRenderOptions => ({
      before: {
        contentIconPath: icon(name),
        width: '1.2em',
        height: '1.2em',
        margin: '0 0.35em 0 0',
      },
    });
    this.statusPass = vscode.window.createTextEditorDecorationType(
      statusIcon('status-pass.svg'),
    );
    this.statusPassCached = vscode.window.createTextEditorDecorationType(
      statusIcon('status-pass-cached.svg'),
    );
    this.statusCodeBehind = vscode.window.createTextEditorDecorationType(
      statusIcon('status-code-behind.svg'),
    );
    this.statusStale = vscode.window.createTextEditorDecorationType(
      statusIcon('status-code-behind-stale.svg'),
    );
    this.statusFail = vscode.window.createTextEditorDecorationType(
      statusIcon('status-fail.svg'),
    );
    this.statusRunning = vscode.window.createTextEditorDecorationType(
      statusIcon('status-running.svg'),
    );
    this.statusSkip = vscode.window.createTextEditorDecorationType(
      statusIcon('status-skip.svg'),
    );
    this.statusStopped = vscode.window.createTextEditorDecorationType(
      statusIcon('status-stopped.svg'),
    );
    this.statusPlaceholder = vscode.window.createTextEditorDecorationType(
      statusIcon('status-placeholder.svg'),
    );
    // A numbered item under a `####` heading. It reads as a step and nothing
    // runs it (sections contract §5 rule 4a), so it is painted as what it is:
    // prose. No status cell, no run affordance — just dimmed, with the reason
    // on hover. The warning diagnostic says the same thing in the Problems
    // panel; this is the version you see without looking for it.
    this.inertStep = vscode.window.createTextEditorDecorationType({
      opacity: '0.55',
      fontStyle: 'italic',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.breakpointStopped = vscode.window.createTextEditorDecorationType(
      statusIcon('breakpoint-stopped.svg'),
    );

    this.stepsSummary = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('descriptionForeground'),
        margin: '0 0 0 1em',
        fontStyle: 'normal',
        fontWeight: '400',
      },
    });

    this.errorLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
      overviewRulerColor: new vscode.ThemeColor('errorForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.subs.push(
      tracker.onChange((snap) => this.refresh(snap)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh(tracker.snapshot())),
    );
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.breakpointStopped.dispose();
    this.statusPass.dispose();
    this.statusPassCached.dispose();
    this.statusCodeBehind.dispose();
    this.statusStale.dispose();
    this.statusFail.dispose();
    this.statusRunning.dispose();
    this.statusSkip.dispose();
    this.statusStopped.dispose();
    this.statusPlaceholder.dispose();
    this.inertStep.dispose();
    this.stepsSummary.dispose();
    this.errorLine.dispose();
  }

  /**
   * Walk every visible editor and decorate it against its own per-URI run
   * state — not just the editor whose URI matches the active-editor
   * snapshot. This is how Phase 2's "arrow follows frames across files"
   * works: when a run descends into a `[skill: ...]`, statuses land on
   * the skill `.md`'s URI in the tracker, and any open editor showing
   * that file gets the decorations even though the active test file has
   * its own (running) status on the `[skill:]` line.
   *
   * The active-file snapshot is still used as the fallback for the
   * currently-focused editor so legacy behaviour (no skills involved) is
   * unchanged: an editor with no run state but matching `snap.uri` still
   * paints the step-placeholder reservation marks.
   */
  private refresh(snap: FileStateSnapshot): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      // Prefer the controller's own snapshot for the active editor (it
      // includes breakpoints + text the per-URI store doesn't carry).
      if (snap.uri && uri === snap.uri) {
        this.apply(editor, snap);
        continue;
      }
      // Other visible editors get decorations only when they have state
      // (e.g. skill `.md` opened during a run). Editors with no state
      // get cleared so stale icons from a previous run don't linger.
      const perUri = this.tracker.snapshotFor(editor.document.uri);
      if (perUri) {
        this.apply(editor, perUri);
      } else {
        this.clear(editor);
      }
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.breakpointStopped, []);
    editor.setDecorations(this.statusPass, []);
    editor.setDecorations(this.statusPassCached, []);
    editor.setDecorations(this.statusCodeBehind, []);
    editor.setDecorations(this.statusStale, []);
    editor.setDecorations(this.statusFail, []);
    editor.setDecorations(this.statusRunning, []);
    editor.setDecorations(this.statusSkip, []);
    editor.setDecorations(this.statusStopped, []);
    editor.setDecorations(this.statusPlaceholder, []);
    editor.setDecorations(this.stepsSummary, []);
    editor.setDecorations(this.errorLine, []);
  }

  private apply(editor: vscode.TextEditor, snap: FileStateSnapshot): void {
    const lineCount = editor.document.lineCount;
    const range = (line: number): vscode.Range => {
      const idx = Math.max(0, Math.min(line - 1, lineCount - 1));
      return new vscode.Range(idx, 0, idx, 0);
    };
    const rangeAtLineEnd = (line: number): vscode.Range => {
      const idx = Math.max(0, Math.min(line - 1, lineCount - 1));
      const end = editor.document.lineAt(idx).text.length;
      return new vscode.Range(idx, end, idx, end);
    };

    // Breakpoint dots are painted by VS Code's debug system (we contribute
    // `breakpoints` for markdown). The yellow pause arrow lives in the
    // reserved inline status cell before the numbered step, not in the gutter.
    const stopped: vscode.Range[] = [];
    if (snap.breakpointStop != null) {
      stopped.push(range(snap.breakpointStop));
    }

    // Statuses — running supersedes pass/fail/skip if both happen to land
    // on the same line during a re-run.
    const passRanges: vscode.Range[] = [];
    const passCachedRanges: vscode.Range[] = [];
    const codeBehindRanges: vscode.Range[] = [];
    const staleRanges: vscode.Range[] = [];
    const failRanges: vscode.Range[] = [];
    const runningRanges: vscode.Range[] = [];
    const skipRanges: vscode.Range[] = [];
    const stoppedRanges: vscode.Range[] = [];
    const linesWithStatus = new Set<number>();
    for (const [line, status] of snap.statuses) {
      if (line === snap.breakpointStop) continue;
      const r = range(line);
      linesWithStatus.add(line);
      switch (status) {
        case 'pass': passRanges.push(r); break;
        case 'pass-cached': passCachedRanges.push(r); break;
        case 'pass-code-behind': codeBehindRanges.push(r); break;
        case 'pass-stale': staleRanges.push(r); break;
        case 'fail': failRanges.push(r); break;
        case 'running': runningRanges.push(r); break;
        case 'skip': skipRanges.push(r); break;
        case 'stopped': stoppedRanges.push(r); break;
      }
    }

    // Paintable lines: main flow AND section bodies, so body steps get the
    // same ✓ / ✗ / ⚡ / ▶ treatment. This is where sections beat skills
    // ergonomically — the whole run paints in one editor.
    const stepLines = extractStepLineIds(snap.text);
    const stepLineSet = new Set(stepLines);
    // The "N/M passed" summary counts MAIN-FLOW steps only. M is the
    // author's step count, and a body line can be visited zero times (never
    // invoked) or many (invoked repeatedly), so counting body lines makes M
    // meaningless and N unbounded. An all-green sectioned run still reads
    // M/M, because the invocation line itself carries a ✓ from the
    // frame:pop aggregate.
    const summary = computeStepsSummary(snap);
    const summaryLines = summary.mainFlowLines;
    const placeholderRanges = stepLines
      .filter((line) => line !== snap.breakpointStop && !linesWithStatus.has(line))
      .map((line) => range(line));

    const errorRanges = snap.errors.map(([line]) => range(line));
    const headingLine = findStepsHeadingLine(snap.text);
    const passed = summary.passed;
    const passedCached = summary.passedCached;
    // The "N/M passed" summary belongs on the user's actual test file —
    // not on skill `.md`s we surfaced during a descent. A skill running
    // halfway through its own body would otherwise show a misleading
    // "0/4 passed" while it's still executing, and a skill the user
    // never wrote a test for shouldn't carry a passed-count signal at
    // all. Phase 2.1 cleanup.
    // "12/12 passed (7 code-behind, 1 stale, 2 cached)" — one parenthesis
    // listing only what actually happened, so an ordinary all-AI run reads
    // exactly as it did before this feature existed.
    const notes = [
      summary.passedCodeBehind > 0 ? `${summary.passedCodeBehind} code-behind` : '',
      summary.stale > 0 ? `${summary.stale} stale` : '',
      passedCached > 0 ? `${passedCached} cached` : '',
    ].filter((n) => n !== '');
    const summaryText =
      notes.length > 0
        ? `${passed}/${summaryLines.length} passed (${notes.join(', ')})`
        : `${passed}/${summaryLines.length} passed`;
    const summaryRanges: vscode.DecorationOptions[] =
      snap.isTestFile && headingLine && summaryLines.length > 0
        ? [{
            range: rangeAtLineEnd(headingLine),
            renderOptions: {
              after: {
                contentText: summaryText,
              },
            },
          }]
        : [];

    editor.setDecorations(this.breakpointStopped, stopped);
    editor.setDecorations(this.statusPass, passRanges);
    editor.setDecorations(this.statusPassCached, passCachedRanges);
    editor.setDecorations(this.statusCodeBehind, codeBehindRanges);
    editor.setDecorations(this.statusStale, staleRanges);
    editor.setDecorations(this.statusFail, failRanges);
    editor.setDecorations(this.statusRunning, runningRanges);
    editor.setDecorations(this.statusSkip, skipRanges);
    editor.setDecorations(this.statusStopped, stoppedRanges);
    editor.setDecorations(this.statusPlaceholder, placeholderRanges);
    // Inert items are not in `stepLines`, so they already carry no status
    // cell; this is what makes them LOOK inert rather than merely unpainted.
    editor.setDecorations(
      this.inertStep,
      classifyLines(snap.text)
        .filter((c) => c.kind === 'inert-step')
        .map((c) => ({
          range: range(c.line),
          hoverMessage:
            "This step never runs: steps under a '####' heading are ignored. " +
            "Use '###' to define a section, then call it by name from the main flow.",
        })),
    );
    editor.setDecorations(this.stepsSummary, summaryRanges);
    editor.setDecorations(this.errorLine, errorRanges);
  }

}
