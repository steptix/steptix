// Flick extension entry point: wires the persistence store, the controller, the
// sidebar webview view, the commands, and the configuration-change listener.

import * as vscode from 'vscode';
import { FlickController } from './controller';
import { FlickViewProvider } from './panel';
import { Store } from './store';
import { affectsFlick } from './settings';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new Store(context.globalStorageUri.fsPath);
  const controller = new FlickController(store);
  await controller.start();
  context.subscriptions.push({ dispose: () => controller.dispose() });

  const provider = new FlickViewProvider(
    context.extensionUri,
    vscode.Uri.file(store.screenshotsRoot),
    controller,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FlickViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('flick.newSession', () => controller.commandNewSession()),
    vscode.commands.registerCommand('flick.openSettings', () => controller.openSettingsInUi()),
    vscode.commands.registerCommand('flick.focus', () =>
      vscode.commands.executeCommand('flick.chat.focus'),
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (affectsFlick(e)) controller.onSettingsChanged();
    }),
  );
}

export function deactivate(): void {
  // Controller disposal is handled via context.subscriptions.
}
