import * as vscode from 'vscode';
import { TestBenchEditorProvider, VIEW_TYPE } from '../editor-provider.js';
import { getOutputChannel } from '../output-channel.js';

/**
 * Register every contributed command. Returns an array of disposables so the
 * extension entry point can collect them into context.subscriptions.
 *
 * Commands resolve the *active* TestBench editor — the focused custom editor.
 * If no TestBench editor is focused, a status-bar message is shown instead of
 * silently no-op'ing.
 */
export function registerCommands(
  provider: TestBenchEditorProvider,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('testbench.runSelected', async () => {
      const ctrl = activeController(provider);
      if (!ctrl) return notifyNoActive();
      // The webview owns selection/cursor state and posts a `run` message
      // when F5 fires. Surface a hint if no run was triggered (e.g. user
      // invoked the command from palette without a webview focused).
      vscode.window.setStatusBarMessage('TestBench: F5 forwarded to active editor', 2000);
    }),

    vscode.commands.registerCommand('testbench.runAll', async () => {
      const ctrl = activeController(provider);
      if (!ctrl) return notifyNoActive();
      await ctrl.runAll();
    }),

    vscode.commands.registerCommand('testbench.stop', () => {
      const ctrl = activeController(provider);
      if (!ctrl) return notifyNoActive();
      ctrl.stop();
    }),

    vscode.commands.registerCommand('testbench.toggleBreakpoint', () => {
      // Wired in webview today; this command exists so users can bind it via
      // keybindings.json. Phase 2 work.
      vscode.window.setStatusBarMessage('TestBench: breakpoints not yet implemented', 2000);
    }),

    vscode.commands.registerCommand('testbench.reopenAsText', async () => {
      const editor = vscode.window.activeTextEditor;
      const uri = editor?.document.uri ?? activeUri();
      if (!uri) return notifyNoActive();
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),

    vscode.commands.registerCommand('testbench.revealEnvFile', async () => {
      const ctrl = activeController(provider);
      if (!ctrl) return notifyNoActive();
      const path = ctrl.lastEnvPath;
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
  ];
}

function activeController(provider: TestBenchEditorProvider) {
  const uri = activeUri();
  return uri ? provider.controllerFor(uri) : undefined;
}

function activeUri(): vscode.Uri | undefined {
  // VS Code's `activeTextEditor` is set even for custom editors backed by a
  // text document. When that's not populated (e.g. webview-only focus) the
  // active tab gives us the URI as a fallback.
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.document.uri;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input as { uri?: vscode.Uri } | undefined;
  return input?.uri;
}

function notifyNoActive(): void {
  vscode.window.setStatusBarMessage(
    'TestBench: no active TestBench editor',
    2000,
  );
}

// Exported so the editor-provider knows the view-type id used for `when` clauses.
export { VIEW_TYPE };
