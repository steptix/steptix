import * as vscode from 'vscode';
import { extractStepLineIds } from '../step-lines.js';
import type { ActiveFileTracker } from '../active-file-tracker.js';
import type { RunController } from '../run-controller.js';
import { getOutputChannel } from '../output-channel.js';

interface Registry {
  active(): RunController | undefined;
  refreshRunningContext(): void;
  notifyRunning(running: boolean): void;
}

/**
 * Register every contributed command. Returns disposables for the activator
 * to push into context.subscriptions.
 *
 * All commands work against the *active TextEditor*. The
 * `testbench.activeFile` context key (set by ActiveFileTracker) gates menu
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
    const lines = selectionLines(editor);
    const breakpoints = tracker.breakpoints(controller.document.uri);
    registry.notifyRunning(true);
    await controller.runLines(lines, { breakpoints }).finally(() => registry.notifyRunning(false));
  };

  return [
    vscode.commands.registerCommand('testbench.runSelected', runSelected),

    vscode.commands.registerCommand('testbench.runAll', async () => {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      await controller
        .runLines([], { breakpoints })
        .finally(() => registry.notifyRunning(false));
    }),

    vscode.commands.registerCommand('testbench.pause', () => {
      const controller = registry.active();
      if (!controller || !controller.isRunning) {
        vscode.window.setStatusBarMessage('TestBench: nothing to pause', 1500);
        return;
      }
      controller.pause();
    }),

    vscode.commands.registerCommand('testbench.stop', () => {
      const controller = registry.active();
      controller?.stop();
      const editor = tracker.activeEditor;
      if (editor && tracker.isActiveTestFile) {
        tracker.setBreakpointStop(editor.document.uri, null);
      }
      registry.notifyRunning(false);
    }),

    vscode.commands.registerCommand('testbench.resume', async () => {
      const controller = registry.active();
      const editor = tracker.activeEditor;
      if (!controller || !editor) return notifyNoActive();
      const state = tracker.state(controller.document.uri);
      const startLine = state.breakpointStop;
      if (startLine == null) {
        vscode.window.setStatusBarMessage('TestBench: no run paused at a breakpoint', 2000);
        return;
      }
      tracker.setBreakpointStop(controller.document.uri, null);
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      await controller
        .runLines([startLine], { breakpoints, skipBreakpointAtStart: true })
        .finally(() => registry.notifyRunning(false));
    }),

    vscode.commands.registerCommand('testbench.restartSession', async () => {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      await controller.closeSession();
      vscode.window.setStatusBarMessage(
        'TestBench: session closed — next F5 starts a fresh browser',
        3000,
      );
    }),

    vscode.commands.registerCommand('testbench.toggleBreakpoint', (target?: { lineNumber?: number }) => {
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

    vscode.commands.registerCommand('testbench.runStepHere', (target?: { lineNumber?: number }) => {
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

    vscode.commands.registerCommand('testbench.clearBreakpoints', () => {
      const editor = tracker.activeEditor;
      if (!editor) return notifyNoActive();
      tracker.clearBreakpoints(editor.document.uri);
    }),

    vscode.commands.registerCommand('testbench.clearStatuses', () => {
      const editor = tracker.activeEditor;
      if (!editor) return notifyNoActive();
      tracker.clearStatuses(editor.document.uri);
    }),

    vscode.commands.registerCommand('testbench.revealEnvFile', async () => {
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

    vscode.commands.registerCommand('testbench.showRunLog', () => {
      getOutputChannel().show(true);
    }),

    vscode.commands.registerCommand('testbench.dismissError', () => {
      // No-op host side — the webview owns the banner state.
    }),

    vscode.commands.registerCommand('testbench.focusRunner', async () => {
      await vscode.commands.executeCommand('testbench.runner.focus');
    }),
  ];
}

/** 1-based line numbers covered by every selection in the editor. */
function selectionLines(editor: vscode.TextEditor): number[] {
  const set = new Set<number>();
  for (const sel of editor.selections) {
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
