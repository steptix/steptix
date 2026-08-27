import * as vscode from 'vscode';
import {
  isWebviewMsg,
  type HostToWebviewMsg,
  type WebviewToHostMsg,
} from 'ai-ui-automation-runner-core';
import { buildWebviewHtml } from './webview-html.js';
import { getOutputChannel } from './output-channel.js';
import type { ActiveFileTracker, FileStateSnapshot } from './active-file-tracker.js';

/**
 * One attached webview surface — the sidebar view or a detached panel.
 * Each surface tracks its own `ready` state because the React bundle in
 * each panel boots independently and posts its own `ready` message; if we
 * flushed pending state on a shared flag, the second panel would never
 * see the initial snapshot.
 */
interface Attachment {
  webview: vscode.Webview;
  ready: boolean;
  pendingSnapshot: FileStateSnapshot | null;
}

/**
 * Sidebar webview view that hosts the TestBench UI (toolbar, output log,
 * variables, error panel). Also acts as a broadcaster: detached editor
 * panels created via `testbench-native.openInEditor` register themselves here so
 * they receive the same run events, batch banners, and activeFile
 * snapshots as the sidebar.
 */
export class TestBenchRunnerView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'testbench-native.runner';

  private readonly attachments: Attachment[] = [];
  private messageHandler:
    | ((msg: WebviewToHostMsg) => void | Promise<void>)
    | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tracker: ActiveFileTracker,
  ) {
    this.recording = context.extensionMode === vscode.ExtensionMode.Test;
    tracker.onChange((snap) => this.postActiveFile(snap));
  }

  setMessageHandler(handler: (msg: WebviewToHostMsg) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Everything `post` has sent, most recent last, capped.
   *
   * The webview's own state is not readable from the extension host, so this
   * is how the integration suite asserts what the panel was TOLD — which is
   * the half of the per-file scoping that lives on this side: the URI stamp
   * that decides which file's Output section a line lands in
   * (stories/compile-tail-progress.md).
   */
  private readonly sent: HostToWebviewMsg[] = [];
  private static readonly SENT_CAP = 2000;
  /**
   * Only a test window records. In a real one the buffer would hold thousands
   * of live messages — `activeFile` carries the WHOLE document text and is
   * posted on every selection change, and a `step:fail` runEvent carries a
   * base64 screenshot — for the benefit of a hook nothing there ever calls.
   */
  private readonly recording: boolean;
  /** How many messages have EVER been posted — the index space a caller marks
   *  in. The buffer drops from the front once it is full, so a plain array
   *  index stops meaning anything the moment that happens. */
  private sentTotal = 0;

  /** Test-only: the mark to pass back to `messagesSince`. */
  get sentMessageCount(): number {
    return this.sentTotal;
  }

  /** Test-only: everything posted since `mark` that is still retained. */
  messagesSince(mark: number): HostToWebviewMsg[] {
    const dropped = this.sentTotal - this.sent.length;
    return this.sent.slice(Math.max(0, mark - dropped));
  }

  /** Forward a host→webview message to every attached surface. Posts to a
   *  not-yet-ready webview are still safe — VS Code queues them. */
  post(msg: HostToWebviewMsg): void {
    if (this.recording) {
      this.sent.push(msg);
      this.sentTotal += 1;
      if (this.sent.length > TestBenchRunnerView.SENT_CAP) {
        this.sent.splice(0, this.sent.length - TestBenchRunnerView.SENT_CAP);
      }
    }
    for (const a of this.attachments) {
      void a.webview.postMessage(msg);
    }
  }

  /** Forward an activeFile snapshot. If a surface hasn't posted `ready`
   *  yet, hold the snapshot for flushing when it does — otherwise the
   *  initial state arrives before the React bundle subscribes and the
   *  panel renders empty. */
  postActiveFile(snap: FileStateSnapshot): void {
    for (const a of this.attachments) {
      if (!a.ready) {
        a.pendingSnapshot = snap;
      } else {
        void a.webview.postMessage({ type: 'activeFile', snapshot: snap });
      }
    }
  }

  /** Number of attached surfaces — used by the openInEditor command to
   *  decide whether to spawn another panel or just focus an existing one. */
  attachmentCount(): number {
    return this.attachments.length;
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    await this.attach(view.webview, view.onDidDispose.bind(view));
  }

  /**
   * Attach a detached editor-area panel to the broadcaster. The panel's
   * webview is wired up exactly like the sidebar view — same HTML, same
   * message routing, same activeFile state — so run events, banners,
   * and snapshots flow to both surfaces with no further branching.
   */
  async attachPanel(panel: vscode.WebviewPanel): Promise<void> {
    await this.attach(panel.webview, panel.onDidDispose.bind(panel));
  }

  private async attach(
    webview: vscode.Webview,
    onDispose: (cb: () => void) => vscode.Disposable,
  ): Promise<void> {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    const attachment: Attachment = { webview, ready: false, pendingSnapshot: null };
    this.attachments.push(attachment);

    // Attach the message listener BEFORE setting html. The webview posts
    // `ready` immediately on script load; if we set html first the message
    // gets dropped because our listener isn't registered yet.
    webview.onDidReceiveMessage((raw: unknown) => {
      if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'webviewError') {
        const r = raw as { label?: string; detail?: string };
        getOutputChannel().appendLine(`[webview ${r.label}] ${r.detail}`);
        return;
      }
      if (!isWebviewMsg(raw)) {
        getOutputChannel().appendLine(`ignored unknown webview message: ${JSON.stringify(raw)}`);
        return;
      }
      if (raw.type === 'ready') {
        attachment.ready = true;
        if (attachment.pendingSnapshot) {
          void attachment.webview.postMessage({
            type: 'activeFile',
            snapshot: attachment.pendingSnapshot,
          });
          attachment.pendingSnapshot = null;
        } else {
          void attachment.webview.postMessage({
            type: 'activeFile',
            snapshot: this.tracker.snapshot(),
          });
        }
      }
      void this.messageHandler?.(raw);
    });

    webview.html = await buildWebviewHtml(this.context, webview);

    onDispose(() => {
      const idx = this.attachments.indexOf(attachment);
      if (idx >= 0) this.attachments.splice(idx, 1);
    });
  }
}
