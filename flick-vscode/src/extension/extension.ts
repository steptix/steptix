// Flick extension entry point: wires the persistence store, the controller, the
// two webview surfaces (editor-tab panel + docked sidebar view), the commands,
// and the configuration-change listener.

import * as vscode from 'vscode';
import { FlickController } from './controller';
import { FlickPanel, FlickSidebarProvider } from './panel';
import { Store } from './store';
import { affectsFlick } from './settings';

/** `viewsContainers.secondarySidebar` contributions require VS Code >= 1.95. */
function supportsSecondarySidebarContainers(): boolean {
  const [major, minor] = vscode.version.split('.').map((n) => parseInt(n, 10));
  return major > 1 || (major === 1 && minor >= 95);
}

/**
 * Test-only surface returned from activate(). Lets the @vscode/test-electron
 * suite reach into the extension and drive it without depending on the
 * webview's DOM. Production code never reads these — they are intentionally
 * prefixed `__` to signal "internal".
 */
export interface FlickTestHooks {
  controller: FlickController;
  /** Every webview currently attached to the controller (panel + sidebar). */
  webviews(): vscode.Webview[];
  /** Forge a message from `webview` to the controller, as the real bridge would. */
  dispatch(webview: vscode.Webview, msg: import('../shared/protocol').WebviewToHost): Promise<void>;
  /** Wait until predicate holds or throw after timeoutMs. */
  waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs?: number, label?: string): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<{
  __testHooks: FlickTestHooks;
}> {
  // Drives the dual view-container `when` clauses: the sidebar lives in the
  // secondary side bar where supported, and falls back to the activity bar
  // otherwise — the pattern Claude Code / Codex use to dock on the right.
  void vscode.commands.executeCommand(
    'setContext',
    'flick.doesNotSupportSecondarySidebar',
    !supportsSecondarySidebarContainers(),
  );

  const store = new Store(context.globalStorageUri.fsPath);
  const controller = new FlickController(store);
  await controller.start();
  context.subscriptions.push({ dispose: () => controller.dispose() });

  const screenshotsRoot = vscode.Uri.file(store.screenshotsRoot);

  // One provider instance serves both sidebar container variants; the
  // mutually-exclusive `when` clauses mean only one is ever resolved.
  const sidebar = new FlickSidebarProvider(context.extensionUri, screenshotsRoot, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FlickSidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(FlickSidebarProvider.viewIdSecondary, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const openPanel = (): void =>
    FlickPanel.createOrShow(context.extensionUri, screenshotsRoot, controller);
  const openSidebar = (): void => {
    void vscode.commands.executeCommand(
      supportsSecondarySidebarContainers()
        ? `${FlickSidebarProvider.viewIdSecondary}.focus`
        : `${FlickSidebarProvider.viewId}.focus`,
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('flick.open', openPanel),
    vscode.commands.registerCommand('flick.openSidebar', openSidebar),
    vscode.commands.registerCommand('flick.newSession', () => {
      openPanel();
      void controller.commandNewSession();
    }),
    vscode.commands.registerCommand('flick.openSettings', () => {
      openPanel();
      void controller.openSettingsInUi();
    }),
  );

  // Restore the editor panel if VS Code reopens with the Flick tab present.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(FlickPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        FlickPanel.revive(panel, context.extensionUri, screenshotsRoot, controller);
      },
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (affectsFlick(e)) controller.onSettingsChanged();
    }),
  );

  return {
    __testHooks: {
      controller,
      webviews: () => collectAttachedWebviews(controller),
      dispatch: (webview, msg) => controller.__testDispatch(webview, msg),
      waitFor: async (predicate, timeoutMs = 5000, label = 'predicate') => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (await predicate()) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`flick __testHooks.waitFor: ${label} did not become true within ${timeoutMs}ms`);
      },
    },
  };
}

/**
 * Reach into the controller's attachments map. The controller holds it as
 * private; the test surface reads it via the test-only accessor. Production
 * has no other reason to enumerate webviews — the controller broadcasts via
 * `post()` and routes by webview identity internally.
 */
function collectAttachedWebviews(controller: FlickController): vscode.Webview[] {
  // Accessor exists on the controller; declared as a getter on the class.
  return [...controller.__testAttachedWebviews];
}

export function deactivate(): void {
  // Controller disposal is handled via context.subscriptions.
}
