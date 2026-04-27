import * as vscode from 'vscode';
import { TestBenchEditorProvider, VIEW_TYPE } from './editor-provider.js';
import { registerCommands } from './commands/index.js';
import { disposeOutputChannel, getOutputChannel } from './output-channel.js';

export function activate(context: vscode.ExtensionContext): void {
  const out = getOutputChannel();
  out.appendLine('TestBench activated');

  const provider = new TestBenchEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Keep the webview alive when its tab is hidden so a long-running test
      // continues even if the user clicks away.
      webviewOptions: { retainContextWhenHidden: true },
      // Allow VS Code to share one provider across editors of the same doc.
      supportsMultipleEditorsPerDocument: false,
    }),
    ...registerCommands(provider),
  );
}

export function deactivate(): void {
  disposeOutputChannel();
}
