import * as vscode from 'vscode';
import { TestBenchEditorProvider, VIEW_TYPE } from './editor-provider.js';
import { registerCommands } from './commands/index.js';
import { disposeOutputChannel, getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';

const FIRST_ACTIVATION_KEY = 'testbench.shownActivationToast';

export function activate(context: vscode.ExtensionContext): void {
  const out = getOutputChannel();
  const ts = () => new Date().toISOString().slice(11, 23);
  out.appendLine(`[${ts()}] TestBench activate() called — version=${context.extension.packageJSON.version}`);
  out.appendLine(`[${ts()}] extensionPath=${context.extensionPath}`);

  const provider = new TestBenchEditorProvider(context);
  out.appendLine(`[${ts()}] registering custom editor viewType=${VIEW_TYPE}`);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    ...registerCommands(provider),
    new EnvSelector(),
  );

  out.appendLine(`[${ts()}] activation complete — ${context.subscriptions.length} disposables`);

  // Show a one-shot toast so users have a visible signal that the extension
  // loaded. This makes "extension didn't load" debugging trivial — if the
  // toast didn't appear, activation didn't fire.
  if (!context.globalState.get<boolean>(FIRST_ACTIVATION_KEY)) {
    void context.globalState.update(FIRST_ACTIVATION_KEY, true);
    void vscode.window.showInformationMessage(
      'TestBench is active. Open a Markdown file with a "## Steps" heading to see it in action.',
      'Show Run Log',
    ).then((choice) => {
      if (choice === 'Show Run Log') void vscode.commands.executeCommand('testbench.showRunLog');
    });
  }
}

export function deactivate(): void {
  disposeOutputChannel();
}
