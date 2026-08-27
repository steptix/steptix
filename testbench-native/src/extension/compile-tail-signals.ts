import * as vscode from 'vscode';
import {
  notificationDetail,
  progressIncrement,
  quickPickLabel,
  statusBarText,
  statusBarTooltip,
  stripFraction,
  type CompileTail,
} from './compile-progress-core.js';

/**
 * The workbench-global half of the compile tail's progress
 * (stories/compile-tail-progress.md §The workbench-global signals).
 *
 * The division of labour, stated once: the panel strip is the detail while you
 * are looking, the notification is the announcement, and the status bar item is
 * the always-on glance. The toast can be dismissed and the panel can be hidden;
 * the status bar item is the signal of last resort and cannot be closed.
 *
 * Owned by the controller registry rather than by a run controller, because
 * controllers are per-document and the status bar item is the one piece of UI
 * that has to see across them: two files compiling at once is a state the
 * compile lock already allows (it is per test file), so the item has to be able
 * to say "compiling 2".
 */
export class CompileTailSignals implements vscode.Disposable {
  /** Command the status bar item invokes. Registered by the registry. */
  static readonly clickCommand = 'testbench-native.showCompileProgress';

  private readonly running = new Map<string, Entry>();
  private item: vscode.StatusBarItem | undefined;

  /**
   * How a toast is raised. Swappable for the Electron harness, which has no
   * way to read a real notification back — and would otherwise leave one on
   * screen for the length of the suite.
   */
  private withProgress: ProgressReporter = vscode.window.withProgress.bind(vscode.window);

  /** Replace the reporter. Test-only; production never calls it. */
  setProgressReporter(reporter: ProgressReporter): void {
    this.withProgress = reporter;
  }

  /**
   * A tail has begun for `uri`. Idempotent: a second call for a file already
   * compiling updates it rather than raising a second toast, which is what a
   * split run (one compile, several blocks) would otherwise do.
   */
  begin(uri: vscode.Uri, tail: CompileTail): void {
    const key = uri.toString();
    const existing = this.running.get(key);
    if (existing) {
      this.update(uri, tail);
      return;
    }
    const entry: Entry = { uri, tail, lastFraction: 0, report: undefined, done: () => {} };
    this.running.set(key, entry);
    this.render();
    // The toast's whole purpose is to be meaningful after the author has
    // navigated away, so it names the file. Not cancellable on purpose: a
    // Cancel link on a toast is a destructive control in a place people click
    // reflexively, and Stop in the panel already aborts the tail.
    void this.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Compiling code-behind for ${tail.file}`,
        cancellable: false,
      },
      (progress) =>
        new Promise<void>((resolve) => {
          entry.report = progress;
          entry.done = resolve;
          // A tail that ended between `begin` and the callback running (VS Code
          // invokes it on a later turn) must not leave the toast up forever.
          if (!this.running.has(key)) resolve();
          else this.reportTo(entry);
        }),
    );
  }

  /** New counts for a running tail. A no-op for a file with no tail. */
  update(uri: vscode.Uri, tail: CompileTail): void {
    const entry = this.running.get(uri.toString());
    if (!entry) return;
    entry.tail = tail;
    this.reportTo(entry);
    this.render();
  }

  /** The tail is over — the result arrived, or the run ended without one. */
  end(uri: vscode.Uri): void {
    const entry = this.running.get(uri.toString());
    if (!entry) return;
    this.running.delete(uri.toString());
    entry.done();
    this.render();
  }

  /** Every running tail, for the status bar item's click handler. */
  get tails(): CompileTail[] {
    return [...this.running.values()].map((e) => e.tail);
  }

  /**
   * The status bar item's click: with one compile, go to it; with several, ask
   * which. Nothing is running by the time the click lands often enough to be
   * worth handling — the item is removed asynchronously — so a stale click is
   * silently a no-op rather than an error.
   */
  async reveal(): Promise<void> {
    const entries = [...this.running.values()];
    if (entries.length === 0) return;
    if (entries.length === 1) {
      await this.open(entries[0]!.uri);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({ label: quickPickLabel(e.tail), uri: e.uri })),
      { placeHolder: 'Which compile?' },
    );
    if (picked) await this.open(picked.uri);
  }

  dispose(): void {
    for (const entry of this.running.values()) entry.done();
    this.running.clear();
    this.item?.dispose();
    this.item = undefined;
  }

  private async open(uri: vscode.Uri): Promise<void> {
    await vscode.window.showTextDocument(uri, { preview: false });
    // The strip is where the detail is, and it lives in the panel.
    await vscode.commands.executeCommand('testbench-native.focusRunner');
  }

  private reportTo(entry: Entry): void {
    if (!entry.report) return;
    const increment = progressIncrement(entry.tail, entry.lastFraction);
    entry.lastFraction = stripFraction(entry.tail) ?? entry.lastFraction;
    const message = notificationDetail(entry.tail);
    entry.report.report({
      ...(message !== '' && { message }),
      ...(increment > 0 && { increment }),
    });
  }

  private render(): void {
    const text = statusBarText(this.tails);
    if (text === '') {
      this.item?.dispose();
      this.item = undefined;
      return;
    }
    if (!this.item) {
      // Left-aligned and low priority: it sits with the other run-state
      // indicators rather than jumping in front of them.
      this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
      this.item.command = CompileTailSignals.clickCommand;
    }
    this.item.text = text;
    this.item.tooltip = statusBarTooltip(this.tails);
    this.item.show();
  }
}

/** The shape of `vscode.window.withProgress` this class actually uses. */
export type ProgressReporter = (
  options: vscode.ProgressOptions,
  task: (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ) => Thenable<void>,
) => Thenable<void>;

interface Entry {
  uri: vscode.Uri;
  tail: CompileTail;
  /** Fraction last reported, because `increment` is a delta and VS Code has no
   *  way to render a bar going backwards. */
  lastFraction: number;
  report: vscode.Progress<{ message?: string; increment?: number }> | undefined;
  /** Resolves the `withProgress` promise, taking the toast down. */
  done: () => void;
}
