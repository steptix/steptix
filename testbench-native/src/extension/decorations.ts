import * as vscode from 'vscode';
import type { ActiveFileTracker, FileStateSnapshot } from './active-file-tracker.js';
import { extractStepLineIds, findStepsHeadingLine } from './step-lines.js';

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
  private readonly statusFail: vscode.TextEditorDecorationType;
  private readonly statusRunning: vscode.TextEditorDecorationType;
  private readonly statusSkip: vscode.TextEditorDecorationType;
  private readonly statusStopped: vscode.TextEditorDecorationType;
  private readonly statusPlaceholder: vscode.TextEditorDecorationType;
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
    this.statusFail.dispose();
    this.statusRunning.dispose();
    this.statusSkip.dispose();
    this.statusStopped.dispose();
    this.statusPlaceholder.dispose();
    this.stepsSummary.dispose();
    this.errorLine.dispose();
  }

  /** Re-apply decorations to whichever editor matches the snapshot's URI. */
  private refresh(snap: FileStateSnapshot): void {
    if (!snap.uri) {
      // No active test file — clear from every visible editor.
      for (const editor of vscode.window.visibleTextEditors) {
        this.clear(editor);
      }
      return;
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== snap.uri) {
        this.clear(editor);
        continue;
      }
      this.apply(editor, snap);
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.breakpointStopped, []);
    editor.setDecorations(this.statusPass, []);
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
        case 'fail': failRanges.push(r); break;
        case 'running': runningRanges.push(r); break;
        case 'skip': skipRanges.push(r); break;
        case 'stopped': stoppedRanges.push(r); break;
      }
    }

    const stepLines = extractStepLineIds(snap.text);
    const stepLineSet = new Set(stepLines);
    const placeholderRanges = stepLines
      .filter((line) => line !== snap.breakpointStop && !linesWithStatus.has(line))
      .map((line) => range(line));

    const errorRanges = snap.errors.map(([line]) => range(line));
    const headingLine = findStepsHeadingLine(snap.text);
    const passed = snap.statuses.filter(
      ([line, status]) => status === 'pass' && stepLineSet.has(line),
    ).length;
    const summaryRanges: vscode.DecorationOptions[] =
      headingLine && stepLines.length > 0
        ? [{
            range: rangeAtLineEnd(headingLine),
            renderOptions: {
              after: {
                contentText: `${passed}/${stepLines.length} passed`,
              },
            },
          }]
        : [];

    editor.setDecorations(this.breakpointStopped, stopped);
    editor.setDecorations(this.statusPass, passRanges);
    editor.setDecorations(this.statusFail, failRanges);
    editor.setDecorations(this.statusRunning, runningRanges);
    editor.setDecorations(this.statusSkip, skipRanges);
    editor.setDecorations(this.statusStopped, stoppedRanges);
    editor.setDecorations(this.statusPlaceholder, placeholderRanges);
    editor.setDecorations(this.stepsSummary, summaryRanges);
    editor.setDecorations(this.errorLine, errorRanges);
  }

}
