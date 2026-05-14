// The two webview surfaces Flick can be shown on, both backed by the same
// FlickController and the same webview bundle:
//
//   FlickPanel           — an editor-tab WebviewPanel. VS Code can move it
//                          into its own editor group or float it into a
//                          separate window. Singleton.
//   FlickSidebarProvider — a WebviewViewProvider for the docked sidebar view
//                          (secondary side bar on VS Code >= 1.95, activity
//                          bar otherwise).
//
// Both can be open at once; the controller broadcasts state to every attached
// webview so the surfaces stay in sync.

import * as vscode from 'vscode';
import type { FlickController } from './controller';
import { renderHtml } from './html';

function webviewOptions(
  extensionUri: vscode.Uri,
  screenshotsRoot: vscode.Uri,
): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
      screenshotsRoot,
    ],
  };
}

// --- editor-tab panel ------------------------------------------------------

export class FlickPanel {
  /** Matches the `onWebviewPanel:` activation event and the serializer key. */
  static readonly viewType = 'flick.panel';

  private static current: FlickPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  /** Open the Flick panel, or reveal it if it is already open. */
  static createOrShow(
    extensionUri: vscode.Uri,
    screenshotsRoot: vscode.Uri,
    controller: FlickController,
  ): void {
    if (FlickPanel.current) {
      FlickPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      FlickPanel.viewType,
      'Flick',
      vscode.ViewColumn.Active,
      { retainContextWhenHidden: true },
    );
    FlickPanel.current = new FlickPanel(panel, extensionUri, screenshotsRoot, controller);
  }

  /** Reattach a panel that VS Code restored after a window reload. */
  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    screenshotsRoot: vscode.Uri,
    controller: FlickController,
  ): void {
    FlickPanel.current?.dispose();
    FlickPanel.current = new FlickPanel(panel, extensionUri, screenshotsRoot, controller);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    screenshotsRoot: vscode.Uri,
    private readonly controller: FlickController,
  ) {
    panel.webview.options = webviewOptions(extensionUri, screenshotsRoot);
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'icons', 'flick.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);
    controller.attachWebview(panel.webview);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private dispose(): void {
    if (FlickPanel.current === this) FlickPanel.current = undefined;
    this.controller.detachWebview(this.panel.webview);
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

// --- docked sidebar view ---------------------------------------------------

export class FlickSidebarProvider implements vscode.WebviewViewProvider {
  /** View id used in the activity-bar container (older VS Code). */
  static readonly viewId = 'flick.sidebar';
  /** View id used in the secondary-side-bar container (VS Code >= 1.95). */
  static readonly viewIdSecondary = 'flick.sidebarSecondary';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly screenshotsRoot: vscode.Uri,
    private readonly controller: FlickController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.extensionUri, this.screenshotsRoot);
    view.webview.html = renderHtml(view.webview, this.extensionUri);
    this.controller.attachWebview(view.webview);
    view.onDidDispose(() => this.controller.detachWebview(view.webview));
  }
}
