import * as vscode from 'vscode';
import {
  isWebviewMsg,
  type HostToWebviewMsg,
  type WebviewToHostMsg,
} from 'ai-ui-automation-runner-core';
import { buildWebviewHtml } from './webview-html.js';
import { getOutputChannel } from './output-channel.js';
import type { ActiveFileTracker, FileStateSnapshot } from './active-file-tracker.js';
import type { RunController } from './run-controller.js';

/**
 * Sidebar webview view that hosts the TestBench UI (toolbar, output log,
 * variables, error panel). Replaces the previous webview-panel custom editor
 * — there is no Monaco inside; the user edits the .md in VS Code's native
 * editor and this panel just drives runs and renders results.
 */
export class TestBenchRunnerView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'testbench.runner';

  private view: vscode.WebviewView | undefined;
  private messageHandler:
    | ((msg: WebviewToHostMsg) => void | Promise<void>)
    | null = null;
  /** Pending snapshots posted before the webview was ready. */
  private pendingSnapshot: FileStateSnapshot | null = null;
  private webviewReady = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tracker: ActiveFileTracker,
  ) {
    tracker.onChange((snap) => this.postActiveFile(snap));
  }

  setMessageHandler(handler: (msg: WebviewToHostMsg) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Forward a host→webview message. Safe to call before the view exists. */
  post(msg: HostToWebviewMsg): void {
    void this.view?.webview.postMessage(msg);
  }

  postActiveFile(snap: FileStateSnapshot): void {
    if (!this.webviewReady) {
      this.pendingSnapshot = snap;
      return;
    }
    this.post({ type: 'activeFile', snapshot: snap });
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    // Attach the message listener before setting `webview.html`. The webview
    // posts `ready` immediately on script load; if we set HTML first the
    // message gets dropped because our listener isn't registered yet.
    view.webview.onDidReceiveMessage((raw: unknown) => {
      if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'webviewError') {
        const r = raw as { label?: string; detail?: string };
        getOutputChannel().appendLine(`[webview ${r.label}] ${r.detail}`);
        return;
      }
      if (!isWebviewMsg(raw)) {
        getOutputChannel().appendLine(`ignored unknown webview message: ${JSON.stringify(raw)}`);
        return;
      }
      // Intercept `ready` here so we can flush any pending state snapshot
      // before whoever owns messageHandler runs the rest of the wiring.
      if (raw.type === 'ready') {
        this.webviewReady = true;
        if (this.pendingSnapshot) {
          this.post({ type: 'activeFile', snapshot: this.pendingSnapshot });
          this.pendingSnapshot = null;
        } else {
          this.post({ type: 'activeFile', snapshot: this.tracker.snapshot() });
        }
      }
      void this.messageHandler?.(raw);
    });

    view.webview.html = await buildWebviewHtml(this.context, view.webview);

    view.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
    });
  }
}
