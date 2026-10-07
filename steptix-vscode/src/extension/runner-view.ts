import * as vscode from 'vscode';
import {
  isWebviewMsg,
  type HostToWebviewMsg,
  type WebviewToHostMsg,
} from 'steptix-runner-core';
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
  /** Whether the surface is on screen now — collapsed, in a hidden
   *  container or in a background tab all read false. */
  isVisible: () => boolean;
}

/**
 * What {@link SteptixRunnerView.reveal} had to do:
 * - `none`: some runner surface was already visible.
 * - `show`: the sidebar view existed but was hidden; shown without focus.
 * - `focus`: there was no sidebar view — never opened in this window, or
 *   hidden through its title menu, which disposes it — so only its focus
 *   command could create one; focus was handed back to the editor after.
 */
export type RevealAction = 'none' | 'show' | 'focus';

/**
 * Sidebar webview view that hosts the Steptix UI (toolbar, output log,
 * variables, error panel). Also acts as a broadcaster: detached editor
 * panels created via `steptix.openInEditor` register themselves here so
 * they receive the same run events, batch banners, and activeFile
 * snapshots as the sidebar.
 */
export class SteptixRunnerView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'steptix.runner';

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

  /**
   * The run state a surface must be told when it becomes ready, because it
   * missed the messages that set it: whether a run is in flight, and the
   * banner the last run left. A run that reveals a runner with no view
   * creates one — and the run's `running`, and a refusal's `runError`, are
   * posted before that view exists, so without this it would open empty and
   * offer Run in the middle of a run.
   */
  private replayRunning = false;
  private replayRunError: HostToWebviewMsg | null = null;

  /** Test-only: what a surface attaching now would be handed. */
  replayState(): { running: boolean; runError: string | null } {
    const err = this.replayRunError;
    return {
      running: this.replayRunning,
      runError: err && err.type === 'runError' ? err.payload.code : null,
    };
  }

  /** Track {@link replayRunning} and {@link replayRunError} the way the
   *  webview tracks its own copy of them. */
  private remember(msg: HostToWebviewMsg): void {
    switch (msg.type) {
      case 'running':
        // The webview closes the banner on the same edge.
        if (msg.running && !this.replayRunning && !msg.sync) this.replayRunError = null;
        this.replayRunning = msg.running;
        return;
      case 'runError':
        this.replayRunError = msg;
        return;
      case 'dismissRunError':
        this.replayRunError = null;
        return;
    }
  }

  /** Forward a host→webview message to every attached surface. Posts to a
   *  not-yet-ready webview are still safe — VS Code queues them. */
  post(msg: HostToWebviewMsg): void {
    this.remember(msg);
    if (this.recording) {
      this.sent.push(msg);
      this.sentTotal += 1;
      if (this.sent.length > SteptixRunnerView.SENT_CAP) {
        this.sent.splice(0, this.sent.length - SteptixRunnerView.SENT_CAP);
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

  /** The sidebar view once VS Code has resolved it — null until the Steptix
   *  container is first opened in this window, and again after VS Code
   *  disposes it (the user hid it with "Hide 'Test Runner'"). */
  private sidebarView: vscode.WebviewView | null = null;

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.sidebarView = view;
    view.onDidDispose(() => {
      if (this.sidebarView === view) this.sidebarView = null;
    });
    await this.attach(view.webview, view.onDidDispose.bind(view), () => view.visible);
  }

  /**
   * Attach a detached editor-area panel to the broadcaster. The panel's
   * webview is wired up exactly like the sidebar view — same HTML, same
   * message routing, same activeFile state — so run events, banners,
   * and snapshots flow to both surfaces with no further branching.
   */
  async attachPanel(panel: vscode.WebviewPanel): Promise<void> {
    await this.attach(panel.webview, panel.onDidDispose.bind(panel), () => panel.visible);
  }

  /** Test-only: every action {@link reveal} took, oldest first. Recorded in
   *  a test window only, like `sent`. */
  readonly revealHistory: RevealAction[] = [];
  private revealing: Promise<void> = Promise.resolve();

  private noteReveal(action: RevealAction): void {
    if (this.recording) this.revealHistory.push(action);
  }

  /** Test-only: settles when the reveals started so far have finished,
   *  focus hand-back included. */
  revealSettled(): Promise<void> {
    return this.revealing;
  }

  /** Whether any runner surface — sidebar or detached panel — is on screen. */
  isVisible(): boolean {
    return this.attachments.some((a) => a.isVisible());
  }

  /** Test-only: whether the sidebar view has been created in this window. */
  isResolved(): boolean {
    return this.sidebarView !== null;
  }

  /**
   * Put the Test Runner on screen for a run that is starting, so its error
   * banner and failure text are seen. A no-op when any runner surface — the
   * sidebar view or a detached panel — is already visible.
   *
   * Keyboard focus stays in the editor: F5 and Shift+F5 only mean Pause and
   * Stop while the editor has text focus. The view opens wherever the user
   * has put it (activity bar, secondary sidebar or panel); `show` and the
   * view's `.focus` command both follow its current location.
   */
  reveal(): Promise<void> {
    this.revealing = this.revealing.then(() => this.revealNow()).catch((err: unknown) => {
      getOutputChannel().appendLine(`could not reveal the Test Runner: ${String(err)}`);
    });
    return this.revealing;
  }

  private async revealNow(): Promise<void> {
    if (this.isVisible()) {
      this.noteReveal('none');
      return;
    }
    if (this.sidebarView) {
      this.noteReveal('show');
      this.sidebarView.show(true);
      return;
    }
    // No view to `show` — never opened in this window, or hidden by the
    // user, which disposes it — and the view's `.focus` command is the only
    // way to create one. It takes focus, so hand it back to the editor group
    // the run came from.
    this.noteReveal('focus');
    const hadEditor = vscode.window.activeTextEditor !== undefined;
    await vscode.commands.executeCommand(`${SteptixRunnerView.viewId}.focus`);
    if (hadEditor) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  private async attach(
    webview: vscode.Webview,
    onDispose: (cb: () => void) => vscode.Disposable,
    isVisible: () => boolean,
  ): Promise<void> {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    const attachment: Attachment = { webview, ready: false, pendingSnapshot: null, isVisible };
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
        // `sync`: this is the state the surface missed, not a run starting,
        // so it must not reset what a run start resets.
        void attachment.webview.postMessage({
          type: 'running',
          running: this.replayRunning,
          sync: true,
        });
        if (this.replayRunError) void attachment.webview.postMessage(this.replayRunError);
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
