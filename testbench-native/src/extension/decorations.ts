import * as vscode from 'vscode';
import type { ActiveFileTracker, FileStateSnapshot } from './active-file-tracker.js';
import { classifyLines, extractSteps } from 'ai-ui-automation-runner-core';
import { extractStepLineIds, findStepsHeadingLine } from './step-lines.js';
import {
  failHoverMessage,
  staleHoverMessage,
  toleratedHoverMessage,
  STALE_HOVER_MESSAGE,
} from './failure-hover-core.js';
import { rowHeaderSummary } from './row-summary-core.js';
import { skipHoverMessage } from './step-skip-core.js';
import { alignmentLinesOf, dataTablesOf, type DataTableLines } from './data-tables-core.js';
import {
  countMainFlowStatuses,
  stepsSummaryText,
  type StepsSummaryCounts,
} from './steps-summary-core.js';

// The hover wording lives in failure-hover-core.ts (pure, node-testable);
// re-exported here because this module is where every consumer historically
// found it. Same for the table scan, which moved to data-tables-core.ts so
// the fast suite can pin which lines take a status and which only reserve the
// cell (`alignmentLinesOf`).
export { STALE_HOVER_MESSAGE, dataTablesOf, alignmentLinesOf };
export type { DataTableLines };

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
export function computeStepsSummary(
  snap: FileStateSnapshot,
): StepsSummaryCounts & { mainFlowLines: number[] } {
  const mainFlowLines = extractSteps(snap.text).map((s) => s.line);
  // The counting and the wording both live in steps-summary-core.ts, which
  // imports no VS Code, so the fast suite pins THEM rather than a copy of the
  // rule. What stays here is the one thing that needs a snapshot: which lines
  // the author wrote under `## Steps`.
  // A ⚠ on a line that did not run counts as the skip it was (`notTaken`).
  const notTaken = new Set(
    (snap.failures ?? []).filter(([, f]) => f.notTaken !== undefined).map(([line]) => line),
  );
  return { ...countMainFlowStatuses(snap.statuses, mainFlowLines, notTaken), mainFlowLines };
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
  private readonly statusCodeBehind: vscode.TextEditorDecorationType;
  private readonly statusStale: vscode.TextEditorDecorationType;
  private readonly statusFail: vscode.TextEditorDecorationType;
  /** An `otherwise continue` failure — the same ✗, in the ⚠'s amber
   *  (stories/step-failure-outcomes.md, decision 6). */
  private readonly statusFailTolerated: vscode.TextEditorDecorationType;
  private readonly statusRunning: vscode.TextEditorDecorationType;
  private readonly statusSkip: vscode.TextEditorDecorationType;
  private readonly statusStopped: vscode.TextEditorDecorationType;
  private readonly statusPlaceholder: vscode.TextEditorDecorationType;
  private readonly inertStep: vscode.TextEditorDecorationType;
  private readonly stepsSummary: vscode.TextEditorDecorationType;
  private readonly errorLine: vscode.TextEditorDecorationType;
  private readonly runningRow: vscode.TextEditorDecorationType;

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
    this.statusCodeBehind = vscode.window.createTextEditorDecorationType(
      statusIcon('status-code-behind.svg'),
    );
    this.statusStale = vscode.window.createTextEditorDecorationType(
      statusIcon('status-code-behind-stale.svg'),
    );
    this.statusFail = vscode.window.createTextEditorDecorationType(
      statusIcon('status-fail.svg'),
    );
    // The SAME cross as `status-fail.svg`, in `status-code-behind-stale.svg`'s
    // amber. Deliberately not a different SHAPE: a glyph that stopped looking like
    // a failure would read as a pass with a caveat. The colour is the whole
    // message — the run went on past it.
    this.statusFailTolerated = vscode.window.createTextEditorDecorationType(
      statusIcon('status-fail-tolerated.svg'),
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

    // The data row that is executing right now, banded across the whole line.
    // The spinner alone is a 1.2em glyph in a table that can be a hundred
    // columns wide; the band is what makes "row 3 is running" readable at a
    // glance.
    //
    // `editor.stackFrameHighlightBackground` is the debugger's "the line
    // executing now" colour, which is exactly what this is, and — unlike
    // `editor.rangeHighlightBackground`, which is ~4% white in Dark+ and
    // invisible over a table — it is legible in both default themes. The
    // overview ruler gets a solid token rather than the same translucent
    // wash, because a 4%-alpha tick in the scrollbar is no tick at all.
    this.runningRow = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
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
    this.statusCodeBehind.dispose();
    this.statusStale.dispose();
    this.statusFail.dispose();
    this.statusFailTolerated.dispose();
    this.statusRunning.dispose();
    this.statusSkip.dispose();
    this.statusStopped.dispose();
    this.statusPlaceholder.dispose();
    this.inertStep.dispose();
    this.stepsSummary.dispose();
    this.errorLine.dispose();
    this.runningRow.dispose();
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
    editor.setDecorations(this.statusCodeBehind, []);
    editor.setDecorations(this.statusStale, []);
    editor.setDecorations(this.statusFail, []);
    editor.setDecorations(this.statusFailTolerated, []);
    editor.setDecorations(this.statusRunning, []);
    editor.setDecorations(this.statusSkip, []);
    editor.setDecorations(this.statusStopped, []);
    editor.setDecorations(this.statusPlaceholder, []);
    editor.setDecorations(this.stepsSummary, []);
    editor.setDecorations(this.errorLine, []);
    editor.setDecorations(this.runningRow, []);
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

    // Which lines are data rows, read before the status loop because a row's
    // ✗ / ◌ / ■ hovers are not a step's (below).
    const tables = dataTablesOf(snap.text);
    const rowLines = tables.flatMap((t) => t.rowLines);
    const rowLineSet = new Set(rowLines);

    // Statuses — running supersedes pass/fail/skip if both happen to land
    // on the same line during a re-run.
    const passRanges: vscode.Range[] = [];
    const codeBehindRanges: vscode.Range[] = [];
    // Options rather than bare Ranges: ⚠ and ✗ carry a hover — the ⚠ names
    // the action that fixes it, the ✗ says what the step died of, and both
    // lead with the actual error when the tracker pinned one to the line
    // (failure-hover-core.ts).
    const staleRanges: vscode.DecorationOptions[] = [];
    const failRanges: vscode.DecorationOptions[] = [];
    // The amber ✗ carries a hover too, and needs one more than the red ✗ does:
    // an amber mark on a green run is unreadable until something says the tail
    // asked for it (stories/step-failure-outcomes.md, decision 6).
    const failToleratedRanges: vscode.DecorationOptions[] = [];
    const runningRanges: vscode.Range[] = [];
    // Options, not bare Ranges: a skipped or interrupted DATA ROW says why it
    // never ran or never finished ("not run (stopped)", "not run (iteration 2
    // failed)", "stopped — the run was stopped while this row was running") —
    // the one thing those marks cannot say on their own. A skipped STEP now
    // says the same kind of thing, since `step:skip` pins its reason to the
    // line (stories/step-flow-control.md); a stopped step still carries no
    // hover, because nothing pins a detail to it.
    const skipRanges: vscode.DecorationOptions[] = [];
    const stoppedRanges: vscode.DecorationOptions[] = [];
    const linesWithStatus = new Set<number>();
    const runningLines = new Set<number>();
    const failures = new Map(snap.failures);
    for (const [line, status] of snap.statuses) {
      if (line === snap.breakpointStop) continue;
      const r = range(line);
      linesWithStatus.add(line);
      const failure = failures.get(line);
      switch (status) {
        case 'pass': passRanges.push(r); break;
        case 'pass-code-behind': codeBehindRanges.push(r); break;
        case 'pass-stale':
          staleRanges.push({ range: r, hoverMessage: staleHoverMessage(failure) });
          break;
        case 'fail':
          failRanges.push({
            range: r,
            // A DATA ROW's hover is rendered verbatim: it is authored by
            // `rowFailureError`, which already leads with the row heading and
            // the values as prose and fences only the error. Sending it
            // through `failHoverMessage` put "This step failed:" over a row —
            // it is not a step — and fenced the whole thing at 1000
            // characters, so a long Playwright log clipped the values off the
            // end of the very hover that exists to name them.
            //
            // A step with no detail (state persisted by an older build) gets
            // no hover, exactly as before the detail existed.
            ...(failure?.error !== undefined &&
              rowLineSet.has(line) && { hoverMessage: failure.error }),
            ...(!rowLineSet.has(line) && failure && { hoverMessage: failHoverMessage(failure) }),
          });
          break;
        case 'fail-tolerated':
          failToleratedRanges.push({
            range: r,
            // Only a STEP ever wears this: a data row's vocabulary comes from
            // `lineStatusFromRowStatus`, which has no tolerated member — a row whose
            // only failures were tolerated is a PASSED row (decision 6). So no row
            // branch, and no hover for a line with no detail, which is what an older
            // build's persisted state looks like.
            ...(failure && { hoverMessage: toleratedHoverMessage(failure) }),
          });
          break;
        case 'running':
          runningRanges.push(r);
          runningLines.add(line);
          break;
        case 'skip': {
          const hover = skipHoverMessage(failure?.error);
          skipRanges.push({
            range: r,
            // For both kinds of skipped line. A ROW's hover is authored by
            // `rowSkipHover`; a STEP's is the `reason` off the wire — `Not
            // run: step 3 returned from "Sign in"`, or `Skipped: another
            // branch of this decision was taken`. Both are prose written to be
            // read, so neither goes through `failHoverMessage`, which would
            // put "This step failed:" over a line that did not fail and fence
            // a sentence as if it were a stack trace.
            //
            // `skipHoverMessage` is where the one difference from the run
            // log's wording is decided and explained — the hover keeps the
            // `Skipped:` the log line strips — and it is what turns a blank
            // reason into no hover rather than an empty box. No detail at all
            // (an older build's persisted state) still means no hover.
            ...(hover !== undefined && { hoverMessage: hover }),
          });
          break;
        }
        case 'stopped':
          stoppedRanges.push({
            range: r,
            ...(rowLineSet.has(line) && failure?.error && { hoverMessage: failure.error }),
          });
          break;
      }
    }

    // Paintable lines: main flow AND section bodies, so body steps get the
    // same ✓ / ✗ / ▶ treatment. This is where sections beat skills
    // ergonomically — the whole run paints in one editor.
    // The data rows of every table join the paintable set: they wear the same
    // status vocabulary as the steps and are the control surface the author
    // reads a matrix run off (stories/data-row-progress-and-selection.md,
    // decision 2). The header and the delimiter never take a status — a
    // status cell on a header would read as "the table passed", which is not
    // a thing — but they DO reserve the cell, below.
    const stepLines = [...extractStepLineIds(snap.text), ...rowLines];
    // The "N/M passed" summary counts MAIN-FLOW steps only. M is the
    // author's step count, and a body line can be visited zero times (never
    // invoked) or many (invoked repeatedly), so counting body lines makes M
    // meaningless and N unbounded. An all-green sectioned run still reads
    // M/M, because the invocation line itself carries a ✓ from the
    // frame:pop aggregate.
    const summary = computeStepsSummary(snap);
    const summaryLines = summary.mainFlowLines;
    const placeholderRanges = [...stepLines, ...alignmentLinesOf(tables)]
      .filter((line) => line !== snap.breakpointStop && !linesWithStatus.has(line))
      .map((line) => range(line));

    const errorRanges = snap.errors.map(([line]) => range(line));
    const headingLine = findStepsHeadingLine(snap.text);
    // The "N/M passed" summary belongs on the user's actual test file —
    // not on skill `.md`s we surfaced during a descent. A skill running
    // halfway through its own body would otherwise show a misleading
    // "0/4 passed" while it's still executing, and a skill the user
    // never wrote a test for shouldn't carry a passed-count signal at
    // all. Phase 2.1 cleanup.
    // "12/12 passed (7 code-behind, 1 stale), 1 skipped" — the
    // wording lives in steps-summary-core.ts so the fast suite can pin it.
    const summaryText = stepsSummaryText(summary);
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

    // Each table's own summary, on its header line, in the same after-text
    // style as the `## Steps` one. The two lines are one apart and say
    // different things: `## Steps` counts steps (during a loop, the current
    // row's; after it, worst-of-rows), the header counts rows.
    //
    // Derived entirely from the statuses already on the row lines — no run
    // state — so it is right after a reload, after a partial run, and for a
    // file nobody has run.
    const statusByLine = new Map(snap.statuses);
    if (snap.isTestFile) {
      for (const table of tables) {
        summaryRanges.push({
          range: rangeAtLineEnd(table.headerLine),
          renderOptions: {
            after: {
              contentText: rowHeaderSummary(
                table.rowLines.map((line) => statusByLine.get(line)),
                table.kind,
              ),
            },
          },
        });
      }
    }

    // The whole-line band on the row that is executing. Only data rows get it:
    // a running STEP has never been banded, and banding one now would be a
    // separate decision about how the editor reads during a run.
    const runningRowRanges = rowLines
      .filter((line) => runningLines.has(line))
      .map((line) => range(line));

    editor.setDecorations(this.breakpointStopped, stopped);
    editor.setDecorations(this.statusPass, passRanges);
    editor.setDecorations(this.statusCodeBehind, codeBehindRanges);
    editor.setDecorations(this.statusStale, staleRanges);
    editor.setDecorations(this.statusFail, failRanges);
    editor.setDecorations(this.statusFailTolerated, failToleratedRanges);
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
    editor.setDecorations(this.runningRow, runningRowRanges);
  }

}
