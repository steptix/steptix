import * as vscode from 'vscode';
import type { ActiveFileTracker, FileStateSnapshot } from './active-file-tracker.js';

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
  private readonly errorLine: vscode.TextEditorDecorationType;

  constructor(
    context: vscode.ExtensionContext,
    private readonly tracker: ActiveFileTracker,
  ) {
    const icon = (name: string): vscode.Uri =>
      vscode.Uri.joinPath(context.extensionUri, 'icons', name);

    this.breakpointStopped = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('breakpoint-stopped.svg'),
      gutterIconSize: 'contain',
    });
    this.statusPass = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('status-pass.svg'),
      gutterIconSize: 'contain',
    });
    this.statusFail = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('status-fail.svg'),
      gutterIconSize: 'contain',
    });
    this.statusRunning = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('status-running.svg'),
      gutterIconSize: 'contain',
    });
    this.statusSkip = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('status-skip.svg'),
      gutterIconSize: 'contain',
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
    editor.setDecorations(this.errorLine, []);
  }

  private apply(editor: vscode.TextEditor, snap: FileStateSnapshot): void {
    const lineCount = editor.document.lineCount;
    const range = (line: number): vscode.Range => {
      const idx = Math.max(0, Math.min(line - 1, lineCount - 1));
      return new vscode.Range(idx, 0, idx, 0);
    };

    // Breakpoint dots are painted by VS Code's debug system (we contribute
    // `breakpoints` for markdown). We only own the yellow ▶ arrow that
    // marks the line where a run paused at a breakpoint.
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
    for (const [line, status] of snap.statuses) {
      const r = range(line);
      switch (status) {
        case 'pass': passRanges.push(r); break;
        case 'fail': failRanges.push(r); break;
        case 'running': runningRanges.push(r); break;
        case 'skip': skipRanges.push(r); break;
      }
    }

    const errorRanges = snap.errors.map(([line]) => range(line));

    editor.setDecorations(this.breakpointStopped, stopped);
    editor.setDecorations(this.statusPass, passRanges);
    editor.setDecorations(this.statusFail, failRanges);
    editor.setDecorations(this.statusRunning, runningRanges);
    editor.setDecorations(this.statusSkip, skipRanges);
    editor.setDecorations(this.errorLine, errorRanges);
  }

}
