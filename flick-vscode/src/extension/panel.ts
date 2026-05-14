// WebviewViewProvider for the Flick sidebar view. Thin shell: it builds the
// webview, wires it to the FlickController, and keeps it alive when hidden so
// chat state survives the user collapsing the panel.

import * as vscode from 'vscode';
import type { FlickController } from './controller';
import { renderHtml } from './html';

export class FlickViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'flick.chat';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly screenshotsRoot: vscode.Uri,
    private readonly controller: FlickController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        this.screenshotsRoot,
      ],
    };
    view.webview.html = renderHtml(view.webview, this.extensionUri);
    this.controller.attachWebview(view.webview);
    view.onDidDispose(() => this.controller.detachWebview());
  }
}
