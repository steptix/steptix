import * as vscode from 'vscode';
import * as path from 'node:path';
import type {
  HostToWebviewMsg,
  RecordingPanelState,
  RecordStepsEvent,
  RecordStepsRequest,
  RecordToolbarDock,
} from 'ai-ui-automation-runner-core';
import type { RecordStepsOutcome, RunController } from './run-controller.js';
import { getOutputChannel } from './output-channel.js';
import {
  applyRecordFrame,
  assignAuthorStepId,
  authorLinesOf,
  authoredForResult,
  beginLiveRecord,
  carryAuthorState,
  cleanStepText,
  commitAuthorLines,
  commitLineEdits,
  editRefused,
  followDeclined,
  followLiveRecord,
  idsForResult,
  keepAuthorLines,
  leftInFileText,
  liveRecordWrite,
  markStepDeleted,
  newLineBook,
  noteStepEdited,
  noteStepRestored,
  oneShotSteps,
  splitAuthorSteps,
  newRecordingState,
  planRecordInsertion,
  plainNotificationText,
  recordedLines,
  recordedStepsText,
  recordingStatusText,
  removeUnfinishedRecording,
  takeLineControls,
  trackAnchorThroughChanges,
  unfinishedRecordingOf,
  type AuthorStepCommit,
  type LineBook,
  type LineEditCommit,
  type LiveDraft,
  type LiveRecord,
  type RecordAnchor,
  type RecordInsertionPlan,
  type UnfinishedRecording,
} from './record-steps-core.js';

/**
 * Record Steps, the TestBench half (stories/testbench-record-steps.md): one
 * recording at a time per window, its live state for the panel and the status
 * bar, the controls the author steers it with, and the file: each draft is
 * written into it as it arrives, in place of the last, and the result over the
 * last draft (or, at Cancel, everything the drafts wrote taken back out).
 *
 * The recording itself runs in the document's `RunController` (it owns the
 * session, the env, the write-once `config`); this class owns everything the
 * author sees. It is window-wide rather than per document because the author
 * is clicking in a browser while it runs, not reading an editor: the panel's
 * Recording block and the Stop / Add check buttons have to be there whichever
 * file happens to be active.
 */
export interface RecordStartOptions {
  mode: 'cursor' | 'new';
  /** Where the steps go. Null for Record New Test: under `## Steps`. */
  anchor: RecordAnchor | null;
  /** 1-based line sent to the server as `target.cursorLine` (mode `cursor`). */
  cursorLine?: number;
  /** A step-paused run was just stopped for this recording — see
   *  `RunController.recordSteps`. */
  retryConflict?: boolean;
}

/** How the last recording ended, and what the author was told — the
 *  notifications themselves are not readable from the extension host. */
export interface RecordingReport {
  /** `empty`: the result had no steps (nothing recorded, or every action
   *  dropped) — said, not an error. */
  status: 'inserted' | 'empty' | 'cancelled' | 'error';
  /** `cancelled` by Cancel pressed in the browser's toolbar. */
  by?: 'browser';
  /** Steps inserted, when `inserted`. */
  steps?: number;
  /** Each notification as shown: plain text (`plainNotificationText`), with
   *  the buttons it offered. */
  messages: Array<{ level: 'info' | 'warn' | 'error'; text: string; actions?: string[] }>;
  /** A result that could not be inserted, as written to the output channel
   *  and copied by the notification's "Copy steps". */
  rescued?: string;
}

interface ActiveRecording {
  controller: RunController;
  /** The document the steps go into. The controller's own until the file is
   *  renamed while recording: then the renamed one, which VS Code opens with
   *  the same (unsaved) text — the recording follows it. */
  doc: vscode.TextDocument;
  /** `doc.uri.toString()`. */
  key: string;
  /** Where the steps go, carried through every edit made to the document
   *  while recording (`trackAnchorThroughChanges`) — until the first write
   *  fixes the place (`LiveFile.record`). */
  anchor: RecordAnchor | null;
  /** The listeners that carry `anchor` and the live slots; disposed when the
   *  insertion is over. */
  watch: vscode.Disposable | null;
  state: RecordingPanelState;
  /** Stop has been sent; a second press waits for the result. */
  stopSent: boolean;
  /** The error lines the server already put in the log, so the closing
   *  error is not printed twice. */
  loggedErrors: string[];
  live: LiveFile;
  /** Ids of steps `record:step` said came from the toolbar or the panel —
   *  never taken for a line the author typed in the file. */
  foreignIds: Set<string>;
  /** The add-steps for lines typed in the file, sent one after another, in
   *  the order the author left the lines. */
  authorSends: Promise<void>;
  /** Lines of the author's already said to have stayed in the file when
   *  their step was dropped (by key) — said once each. */
  leftSaid: Set<string>;
  /**
   * What the author did to the recording's steps in the file — lines
   * reworded, deleted, brought back by Ctrl+Z — as far as the server has to
   * hear it, and the words it holds for each step
   * (stories/testbench-record-edit-steps.md).
   */
  book: LineBook;
  /** A draft came with steps and no ids — a server that predates editing —
   *  and the log said so. */
  idlessSaid: boolean;
}

/**
 * The recorded file while recording (SPEC-record-steps.md §7): each draft is
 * written into it in place of the last, and what the recording wrote is
 * tracked through the author's own edits, so Stop writes the result over it
 * and Cancel takes it out again.
 */
interface LiveFile {
  /** Where the recording writes and what the file had there. Null until the
   *  first write, which plans against the document as it is then. */
  record: LiveRecord | null;
  /** Revision of the draft last written; 0 before any. */
  written: number;
  /** Our own edit in flight: the text it leaves and the record after it, so
   *  its change event is told from the author's (`matched`). */
  pending: { text: string; record: LiveRecord; matched: boolean } | null;
  /** Every write runs after the one before it. */
  chain: Promise<void>;
  /** A draft write is queued on `chain` and has not started. */
  queued: boolean;
  /** The queued write writes the latest draft even when it is the one
   *  already written: a step of the author's was dropped or restored, and
   *  the file follows the panel at once. */
  rewrite: boolean;
  /** No more draft writes: the recording is over or ending. */
  stopped: boolean;
  /** The document was closed while recording: never written again. */
  closed: boolean;
  /** The file is being renamed (`onWillRenameFiles`): where it is going, so
   *  the old document closing is not taken for the author closing it. */
  renameTo: vscode.Uri | null;
  /**
   * What the recording wrote could not be found in the file any more (§7:
   * part of it gone, or there twice): nothing more is written into the file
   * while this recording lasts. The panel keeps drafting; Stop looks once
   * more and otherwise inserts the result at the anchor; Cancel takes out
   * only what it can still find.
   */
  detached: boolean;
  /** Taking the drafts out at the end was tried and the edit did not go
   *  through: what is kept for a reload is not forgotten. */
  keepUnfinished: boolean;
  /**
   * The recording's writes so far are one undo step, still open for the next
   * write to join (`undoStopBefore: false`). False before the first write, and
   * after anything else changed the document — the author's edit is its own
   * undo step, so the recording's next write starts a new one rather than
   * joining whatever the author left open.
   */
  groupOpen: boolean;
  /** Something the recording wrote is in the document's undo history. */
  wroteAny: boolean;
  /**
   * The recording's writes may no longer be ONE undo step: since the first
   * write, the document changed under another hand, the author moved the
   * cursor in it (VS Code closes the open undo step on a cursor move), it was
   * saved, or a draft went in as a WorkspaceEdit. The result is then written
   * as two steps — the drafts taken out, then the result — so one Ctrl+Z
   * after Stop still lands on the file without the recording.
   */
  split: boolean;
  /** The one warning about editing the lines being recorded has been shown. */
  warned: boolean;
  /** Notifications shown while recording, as shown. */
  notices: Array<{ level: 'info' | 'warn' | 'error'; text: string }>;
  /** The highlight on the recorded lines; disposed when the recording ends. */
  decoration: vscode.TextEditorDecorationType | null;
  /** 0-based lines highlighted now. */
  highlighted: number[];
  /** Why no draft could be written yet, said once in the output. */
  unwritable: string | null;
}

const COPY_STEPS = 'Copy steps';
const SHOW_OUTPUT = 'Show output';

/** SPEC-record-steps.md §7: said once per recording — when an edit inside
 *  the recorded lines is written over by the next draft, which is now only
 *  with a server whose drafts name no steps (`IDLESS_SERVER`), or a blank
 *  spacing line the recording keeps typed on. */
export const EDITED_WHILE_RECORDING =
  'Lines being recorded are rewritten as the model updates them — edit them after Stop.';

/** stories/testbench-record-edit-steps.md: said once, to a server whose
 *  drafts carry no step ids — the author's edits of recorded lines cannot be
 *  kept then, and are written over as they always were. */
export const IDLESS_SERVER =
  'This server does not name its steps, so recorded lines cannot be edited or deleted while recording: ' +
  'an edit inside them is rewritten by the next draft — edit them after Stop.';

/** SPEC-record-steps.md §7: the recording stopped writing into its file. */
export const NO_LONGER_LIVE =
  'The recorded steps could not be found in the file any more, so they are no longer written live; ' +
  'the panel keeps them and Stop will insert them at your cursor line.';

/** SPEC-record-steps.md §7: the offer after a window reload cut a recording off. */
export const REMOVE_UNFINISHED = "Remove the unfinished recording's steps";
export const KEEP_UNFINISHED = 'Keep them';

/** workspaceState key: what an in-flight recording has written, and where. */
const UNFINISHED_KEY = 'testbench-native.recordSteps.unfinished';

/** workspaceState key: where the browser toolbar was docked, and whether it
 *  was minimised, when the last recording's `record:toolbar` said so. */
const TOOLBAR_KEY = 'testbench-native.recordSteps.toolbar';

/** The setting that turns the browser toolbar off. */
export const BROWSER_TOOLBAR_SETTING = 'recordSteps.browserToolbar';

const DOCKS: readonly RecordToolbarDock[] = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];

/** What `TOOLBAR_KEY` holds. */
export interface RememberedToolbar {
  dock: RecordToolbarDock;
  minimised: boolean;
}

/** stories/testbench-record-toolbar.md §"VS Code alongside": a Cancel pressed
 *  in the browser ends quietly. */
export const CANCELLED_IN_BROWSER = 'Recording cancelled in the browser — nothing was written.';

/** What `UNFINISHED_KEY` holds. */
export interface PersistedRecording extends UnfinishedRecording {
  uri: string;
  file: string;
}

/** How long a closing window waits for a recording's draft to be taken out. */
const SHUTDOWN_WAIT_MS = 1500;

export class StepRecorder implements vscode.Disposable {
  private current: ActiveRecording | null = null;
  /** The most recent recording's file state — outlives `current`, which is
   *  dropped as soon as the stream ends, while the result is still written. */
  private lastLive: LiveFile | null = null;
  private readonly statusItem: vscode.StatusBarItem;
  private lastContextValue = false;
  /** `testbench-native.recordingPaused`, as last set. */
  private lastPausedValue = false;
  /** The workspace's state, where an in-flight recording's writes are kept
   *  (`attachStorage`). Absent in a recorder nobody gave one. */
  private storage: vscode.Memento | null = null;

  /** Test-only: how the most recent recording ended. */
  lastReport: RecordingReport | null = null;
  /** Test-only: why the most recent Record gesture was refused, or null. */
  lastRefusal: string | null = null;
  /** Test-only: settles when the current recording — insertion included — is
   *  over. */
  settled: Promise<void> = Promise.resolve();

  constructor(private readonly post: (msg: HostToWebviewMsg) => void) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = 'testbench-native.focusRunner';
  }

  get isRecording(): boolean {
    return this.current !== null;
  }

  /** A copy of the panel state, or null. */
  get state(): RecordingPanelState | null {
    return this.current ? snapshotOf(this.current.state) : null;
  }

  /** The status bar item's text while recording, or null when hidden. */
  get statusText(): string | null {
    return this.current ? this.statusItem.text : null;
  }

  /** Test-only: the 1-based lines the recording highlights now, or null when
   *  no highlight exists (before the first recording, and once one ends). */
  get highlightedLines(): number[] | null {
    const live = this.lastLive;
    return live?.decoration ? live.highlighted.map((l) => l + 1) : null;
  }

  /** Test-only: the notifications the most recent recording showed while it
   *  ran (the in-block edit warning). */
  get liveNotices(): Array<{ level: 'info' | 'warn' | 'error'; text: string }> {
    return (this.lastLive?.notices ?? []).map((n) => ({ ...n }));
  }

  /** Test-only: what the in-flight recording has written, as kept in the
   *  workspace's state, or undefined. */
  get persisted(): PersistedRecording | undefined {
    return this.storage?.get<PersistedRecording>(UNFINISHED_KEY);
  }

  /** Test-only: put a kept recording back, as a window reload leaves it. */
  async setPersisted(value: PersistedRecording | undefined): Promise<void> {
    await this.storage?.update(UNFINISHED_KEY, value);
  }

  /** Test-only: the lines the author wrote into the recorded block of the
   *  current (or last) recording, and what became of each. */
  get authorLines(): ReturnType<typeof authorLinesOf> {
    const record = this.lastLive?.record;
    return record ? authorLinesOf(record) : [];
  }

  /** Where the browser toolbar was last left (`record:toolbar`), as the next
   *  recording's start body sends it — or undefined before any. */
  get rememberedToolbar(): RememberedToolbar | undefined {
    const kept = this.storage?.get<RememberedToolbar>(TOOLBAR_KEY);
    return kept && DOCKS.includes(kept.dock) ? { dock: kept.dock, minimised: kept.minimised === true } : undefined;
  }

  /** Test-only: forget (or set) where the toolbar was left. */
  async setRememberedToolbar(value: RememberedToolbar | undefined): Promise<void> {
    await this.storage?.update(TOOLBAR_KEY, value);
  }

  /**
   * Keep every write of an in-flight recording in `memento` (the workspace's
   * state), so that one a window reload cuts off can be taken back out at the
   * next activation (`recoverUnfinished`).
   */
  attachStorage(memento: vscode.Memento): void {
    this.storage = memento;
  }

  /**
   * At activation: a recording the window closed on (a reload, an extension
   * host restart) may have left its draft in a file — hot exit restores the
   * unsaved buffer draft and all. When what it wrote is still in that file
   * EXACTLY, the author is offered to take it out (the verified empty draft)
   * or keep it. The kept record is forgotten either way.
   *
   * `ask` stands in for the notification in tests.
   */
  async recoverUnfinished(
    ask: (message: string, actions: string[]) => Thenable<string | undefined> = (message, actions) =>
      vscode.window.showWarningMessage(message, ...actions),
  ): Promise<'none' | 'not-found' | 'kept' | 'removed'> {
    const saved = this.persisted;
    if (!saved) return 'none';
    await this.storage?.update(UNFINISHED_KEY, undefined);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(saved.uri));
    } catch {
      return 'none';
    }
    if (!removeUnfinishedRecording(doc.getText(), saved)) return 'not-found';
    const choice = await ask(
      plainNotificationText(
        `Record Steps: a recording was still running when the window closed, and its draft steps are still in ${saved.file}.`,
      ),
      [REMOVE_UNFINISHED, KEEP_UNFINISHED],
    );
    if (choice !== REMOVE_UNFINISHED) return 'kept';
    // Looked for again: the author may have typed while the question was up.
    const removal = removeUnfinishedRecording(doc.getText(), saved);
    if (!removal || doc.isClosed) return 'not-found';
    const edit = new vscode.WorkspaceEdit();
    for (const e of removal.edits) {
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
    }
    return (await vscode.workspace.applyEdit(edit)) ? 'removed' : 'not-found';
  }

  /**
   * The window is closing (deactivate): cancel the recording and wait a
   * moment for its draft to be taken out of the file. Best effort — on a
   * window reload hot exit has already backed the buffer up by now; what is
   * left is offered for removal at the next activation.
   */
  async shutdown(timeoutMs = SHUTDOWN_WAIT_MS): Promise<void> {
    const rec = this.current;
    if (!rec) return;
    void rec.controller.cancelRecording();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Say why a Record gesture did nothing — a warning, remembered for tests. */
  refuse(reason: string): void {
    this.lastRefusal = reason;
    void vscode.window.showWarningMessage(reason);
  }

  /**
   * Start recording in `controller`'s session. Returns at once: the recording
   * lasts until the author stops or cancels it, and the command that started
   * it must not hold its caller that long.
   */
  start(controller: RunController, opts: RecordStartOptions): void {
    this.lastRefusal = null;
    this.lastReport = null;
    const doc = controller.document;
    const rec: ActiveRecording = {
      controller,
      doc,
      key: doc.uri.toString(),
      // Tracked from here on: the line it names is the anchor line whatever
      // the author does to the text around it (or to it — a renumber).
      anchor: opts.anchor ? { ...opts.anchor, tracked: true } : null,
      watch: null,
      stopSent: false,
      loggedErrors: [],
      foreignIds: new Set(),
      authorSends: Promise.resolve(),
      leftSaid: new Set(),
      book: newLineBook(),
      idlessSaid: false,
      state: newRecordingState({
        uri: doc.uri.toString(),
        file: path.basename(doc.uri.fsPath),
        mode: opts.mode,
      }),
      live: {
        record: null,
        written: 0,
        pending: null,
        chain: Promise.resolve(),
        queued: false,
        rewrite: false,
        stopped: false,
        closed: doc.isClosed,
        renameTo: null,
        detached: false,
        keepUnfinished: false,
        groupOpen: false,
        wroteAny: false,
        split: false,
        warned: false,
        notices: [],
        // A faint "added lines" background with a bar at the left, in the
        // theme's own diff colours.
        decoration: vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
          borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
          borderStyle: 'solid',
          borderWidth: '0 0 0 2px',
          overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
          overviewRulerLane: vscode.OverviewRulerLane.Left,
        }),
        highlighted: [],
        unwritable: null,
      },
    };
    this.lastLive?.decoration?.dispose();
    this.lastLive = rec.live;
    rec.watch = this.watchDocument(rec);
    this.current = rec;
    this.publish();
    controller.postRecordLog(
      opts.mode === 'new'
        ? `● Recording a new test into ${rec.state.file} — use the app in the test's browser, then press Stop.`
        : `● Recording after line ${opts.cursorLine ?? '?'} of ${rec.state.file} — use the app in the test's browser, then press Stop.`,
      'info',
    );
    this.settled = this.run(rec, opts)
      .catch(async (err: unknown) => {
        this.release(rec);
        await this.clearLive(rec).catch(() => undefined);
        this.finish('error', [{ level: 'error', text: `Record Steps failed: ${err instanceof Error ? err.message : String(err)}` }]);
      })
      .finally(() => {
        rec.watch?.dispose();
        rec.watch = null;
        this.endHighlight(rec);
        this.release(rec);
        // Over: nothing of it is the recording's to take back after a reload
        // any more — unless taking the draft out was tried and the edit did
        // not go through (a window closing under it): then it is kept for the
        // next activation to offer.
        if (!rec.live.keepUnfinished) this.forget();
      });
  }

  /**
   * Follow the recorded document while recording — and until the result is
   * written:
   *
   *  - `rec.anchor` through every edit, so the first write goes after the line
   *    the author chose even when lines were added above it or it was
   *    renumbered. An edit that deletes the line, or the document closing,
   *    loses the track; the first write then finds the line by its text.
   *  - once something is written, what the recording wrote, through everyone
   *    else's edits (`followLiveRecord`), telling our own writes apart by the
   *    text they leave. Where offsets cannot follow an edit — an undo or redo,
   *    a revert or a reload from disk (the document is not dirty after it),
   *    or anything reaching across the recorded lines' edge — the recording's
   *    text is looked for by the text itself instead. An edit wholly inside
   *    the recorded lines is warned about, once; nothing else is.
   *  - the file being renamed: the recording follows it to its new name.
   *  - the document closing otherwise: it is not written again (§7 — the
   *    result is rescued at the end instead).
   *  - the highlight, onto each editor that shows the document.
   */
  private watchDocument(rec: ActiveRecording): vscode.Disposable {
    const live = rec.live;
    return vscode.Disposable.from(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== rec.key || e.contentChanges.length === 0) return;
        if (rec.anchor) {
          rec.anchor = trackAnchorThroughChanges(
            rec.anchor,
            e.contentChanges.map((c) => ({
              startLine: c.range.start.line,
              startChar: c.range.start.character,
              endLine: c.range.end.line,
              endChar: c.range.end.character,
              text: c.text,
            })),
          );
        }
        const pending = live.pending;
        if (pending && !pending.matched && e.document.getText() === pending.text) {
          // Our own write: the record is what the write made it — and the
          // highlight moves with the text, not a moment after it (the edit's
          // promise settles after this event). A line of the author's sent
          // while the write was in flight stays sent.
          pending.matched = true;
          live.record = live.record ? carryAuthorState(live.record, pending.record) : pending.record;
          this.highlight(rec);
          return;
        }
        // Someone else's edit — the author's, usually. It is its own undo
        // step, so the recording's next write starts a new one.
        live.groupOpen = false;
        if (live.wroteAny) live.split = true;
        if (!live.record) return;
        const followed = followLiveRecord(
          live.record,
          e.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })),
          {
            text: () => e.document.getText(),
            // An undo, a redo, a revert and a reload from disk are not
            // followed by offsets alone: what the recording wrote is looked
            // for by its text (a revert or reload is the change that leaves
            // the document clean without the recording having saved it).
            uncertain: e.reason !== undefined || !e.document.isDirty,
            // Measured in VS Code 1.95: an undo reports the exact inverse of
            // the edits it undoes. One inside a line of the author's is their
            // typing undone, followed as it was typed; Ctrl+Z of emptying a
            // line of a step is that step restored.
            undo: e.reason !== undefined,
            anchor: rec.state.mode === 'new' ? null : rec.anchor,
            book: rec.book,
          },
        );
        live.record = followed.record;
        if (followed.touched && !live.warned && !live.detached) {
          live.warned = true;
          const notice = { level: 'warn' as const, text: EDITED_WHILE_RECORDING };
          live.notices.push(notice);
          rec.controller.postRecordLog(notice.text, 'warn');
          void this.notify(notice.level, notice.text);
        }
        // A line of a step deleted is a drop as soon as it is gone, and one
        // back (Ctrl+Z) is a restore (stories/testbench-record-edit-steps.md).
        this.sendLineControls(rec);
        // Lines of the author's are counted when the cursor leaves them — the
        // selection event that follows this one (Enter included) — not here,
        // where the editor's selection can still be the one before the edit.
        this.highlight(rec);
      }),
      // A rename closes the old document and opens the new one with the same
      // unsaved text. Known before it happens, so that close is not taken for
      // the author closing the file.
      vscode.workspace.onWillRenameFiles((e) => {
        for (const f of e.files) {
          const target = renamedUri(rec.key, f.oldUri, f.newUri);
          if (target) live.renameTo = target;
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          const target = renamedUri(rec.key, f.oldUri, f.newUri);
          if (target) void this.followRename(rec, target);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed.uri.toString() !== rec.key || live.renameTo) return;
        if (rec.anchor) rec.anchor = { ...rec.anchor, tracked: false };
        live.closed = true;
        this.highlight(rec);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.highlight(rec);
        // No editor shows the file any more: nobody is typing on its lines.
        this.countAuthorLines(rec);
      }),
      // A cursor the author moves closes the open undo step (measured with
      // `cursorDown`). Every selection change that carries a kind counts —
      // one set through the API carries one too (a command's) and does not
      // close the step, but a false alarm only costs a split result, and a
      // missed one leaves a draft behind one Ctrl+Z.
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() !== rec.key) return;
        if (e.kind !== undefined && live.wroteAny) live.split = true;
        // The cursor left a line the author typed: it counts as written.
        this.countAuthorLines(rec);
      }),
      // The window lost focus — the author went back to the browser, which is
      // the usual next move after typing a step: the line the cursor is on is
      // finished too.
      vscode.window.onDidChangeWindowState((e) => this.windowFocusChanged(e.focused, rec)),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (live.wroteAny && saved.uri.toString() === rec.key) live.split = true;
      }),
    );
  }

  /**
   * The recorded file was renamed: carry on in the document at its new name,
   * which VS Code opened with the old one's text (unsaved drafts included).
   * What the recording wrote is looked for there by its text before the next
   * write. A document that cannot be opened there is a closed one: the result
   * is rescued at the end.
   */
  private async followRename(rec: ActiveRecording, uri: vscode.Uri): Promise<void> {
    const live = rec.live;
    const key = uri.toString();
    if (rec.key === key) return;
    let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        doc = undefined;
      }
    }
    live.renameTo = null;
    if (!doc || doc.isClosed) {
      live.closed = true;
      return;
    }
    rec.doc = doc;
    rec.key = key;
    live.closed = false;
    if (live.record) live.record = { ...live.record, uncertain: true };
    rec.state.uri = key;
    rec.state.file = path.basename(uri.fsPath);
    if (this.current === rec) this.publish();
    // What is kept for a reload is the same text, in the file's new place.
    const kept = this.persisted;
    if (kept) void this.storage?.update(UNFINISHED_KEY, { ...kept, uri: key, file: rec.state.file });
    this.highlight(rec);
  }

  /**
   * A notification. Everything shown this way may carry text the page or the
   * model wrote (a note, a parameter name, the server's error), and a
   * notification turns `[text](target)` into a link — so it is shown as
   * plain text.
   */
  private notify(level: 'info' | 'warn' | 'error', text: string, actions: string[] = []): Thenable<string | undefined> {
    const plain = plainNotificationText(text);
    if (level === 'error') return vscode.window.showErrorMessage(plain, ...actions);
    if (level === 'warn') return vscode.window.showWarningMessage(plain, ...actions);
    return vscode.window.showInformationMessage(plain, ...actions);
  }

  /**
   * The window's focus changed (`onDidChangeWindowState`). Losing it counts
   * every line of the author's with a step on it, the one the cursor is on
   * included: they left the editor. Public so a test can stand in for the
   * window, which it cannot unfocus.
   */
  windowFocusChanged(focused: boolean, rec: ActiveRecording | null = this.current): void {
    if (focused || !rec) return;
    this.countAuthorLines(rec, { ignoreCursors: true });
  }

  /** Stop: write the steps, leaving the dropped actions out. */
  async stop(): Promise<void> {
    const rec = this.current;
    if (!rec) {
      vscode.window.setStatusBarMessage('TestBench: nothing is recording', 2000);
      return;
    }
    if (rec.stopSent || rec.state.phase === 'finishing') return;
    // Before `record:started` the server's recorder may not exist yet, and
    // there is nothing recorded to write — Stop there is a cancel.
    if (rec.state.phase === 'starting') {
      await rec.controller.cancelRecording();
      return;
    }
    rec.stopSent = true;
    // Every line typed in the file goes to the server ahead of Stop — the one
    // the cursor is still on too — after those already on their way, and
    // once the drafts in flight are in the file (they say which lines the
    // server holds, and where a new one goes).
    await this.flushAuthorLines(rec);
    if (this.current !== rec) return;
    // Belt and braces, as for actions: the steps deleted too.
    const dropped = [
      ...new Set([
        ...rec.state.actions.filter((a) => a.dropped).map((a) => a.id),
        ...(rec.state.deletedSteps ?? []).map((d) => d.id),
      ]),
    ];
    const sent = await rec.controller.controlRecording({
      action: 'stop',
      ...(dropped.length > 0 && { dropped }),
    });
    if (!sent.ok) {
      rec.stopSent = false;
      void this.notify('error', `Record Steps: could not stop the recording — ${sent.error}`);
    }
  }

  /** Cancel: end the recording and write nothing. */
  async cancel(): Promise<void> {
    const rec = this.current;
    if (!rec) {
      vscode.window.setStatusBarMessage('TestBench: nothing is recording', 2000);
      return;
    }
    await rec.controller.cancelRecording();
  }

  /**
   * Add check (decision 10): arm pick mode — the next click in the page is
   * swallowed and becomes a check — or disarm it. The toggle shows what the
   * server's `record:pick` said, not what was asked for.
   */
  async toggleCheck(): Promise<void> {
    const rec = this.current;
    if (!rec) {
      vscode.window.setStatusBarMessage('TestBench: nothing is recording', 2000);
      return;
    }
    if (rec.state.phase !== 'recording') {
      vscode.window.setStatusBarMessage(
        rec.state.phase === 'starting'
          ? 'TestBench: the recording is still starting'
          : 'TestBench: the recording is finishing',
        2000,
      );
      return;
    }
    // A check is recording: paused, there is nothing to pick
    // (stories/testbench-record-toolbar.md §"Its states", Paused).
    if (rec.state.paused && !rec.state.pickArmed) {
      vscode.window.setStatusBarMessage('TestBench: resume the recording to add a check', 2000);
      return;
    }
    const sent = await rec.controller.controlRecording({
      action: rec.state.pickArmed ? 'cancel-check' : 'check',
    });
    if (!sent.ok) void this.notify('warn', `Record Steps: ${sent.error}`);
  }

  /**
   * Pause or Resume (stories/testbench-record-toolbar.md §"Pause and resume,
   * in detail"): nothing is recorded, and no draft call starts, until Resume.
   * The panel and the status bar show what the server's `record:paused` said,
   * not what was asked for — the toolbar in the browser can pause too.
   */
  async setPaused(paused: boolean): Promise<void> {
    const rec = this.current;
    if (!rec) {
      vscode.window.setStatusBarMessage('TestBench: nothing is recording', 2000);
      return;
    }
    if (rec.state.phase !== 'recording' || rec.stopSent) {
      vscode.window.setStatusBarMessage(
        rec.state.phase === 'starting' ? 'TestBench: the recording is still starting' : 'TestBench: the recording is finishing',
        2000,
      );
      return;
    }
    if ((rec.state.paused === true) === paused) return;
    const sent = await rec.controller.controlRecording({ action: paused ? 'pause' : 'resume' });
    if (!sent.ok) void this.notify('warn', `Record Steps: could not ${paused ? 'pause' : 'resume'} the recording — ${sent.error}`);
  }

  /**
   * Add Step to Recording — the command, and the panel's Add step box
   * (stories/testbench-record-toolbar.md §"Steps you write"). One line is one
   * step, several lines several steps, in order; a leading number or list
   * marker is the recording's to give, so it is taken off. Asks for the text
   * when none is given. Paused, it still works: it records nothing.
   *
   * Returns whether the steps went to the server and it took them, and if
   * not, why — for the panel's box, which keeps its text until then
   * (`addStepFromPanel`). `quiet`: the reason is shown where the text was
   * typed, not in a notification.
   */
  async addStep(text?: string, opts: { quiet?: boolean } = {}): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    const refuse = (reason: string, notify: boolean): { accepted: false; reason: string } => {
      if (opts.quiet) return { accepted: false, reason };
      if (notify) void this.notify('warn', `Record Steps: the step was not added — ${reason}`);
      else vscode.window.setStatusBarMessage(`TestBench: ${reason}`, 2000);
      return { accepted: false, reason };
    };
    const rec = this.current;
    if (!rec) return refuse('nothing is recording', false);
    if (rec.state.phase !== 'recording' || rec.stopSent) {
      return refuse(rec.state.phase === 'starting' ? 'the recording is still starting' : 'the recording is finishing', false);
    }
    const raw =
      text ??
      (await vscode.window.showInputBox({
        title: 'TestBench: Add Step to Recording',
        prompt: 'The step exactly as it should read in the test. Everything recorded so far is locked in above it.',
        placeHolder: 'Verify the balance shows "$1,234.56"',
      }));
    if (raw === undefined) return { accepted: false, reason: 'dismissed' };
    const steps = splitAuthorSteps(raw);
    if (steps.length === 0) return refuse('an empty step adds nothing', false);
    if (this.current !== rec) return refuse('the recording ended', false);
    const sent = await rec.controller.controlRecording({ action: 'add-step', text: steps.join('\n'), source: 'panel' });
    if (!sent.ok || sent.ignored) {
      return refuse(sent.ok ? (sent.reason ?? 'the recording is no longer taking steps') : sent.error, true);
    }
    return { accepted: true };
  }

  /**
   * The panel's Add step box: the steps, and then the answer posted back to
   * the box by `id` — which clears it only when the server took them, and
   * otherwise keeps the text and shows why.
   */
  async addStepFromPanel(text: string, id: string): Promise<void> {
    const answer = await this.addStep(text, { quiet: true });
    this.post({
      type: 'recordAddStepResult',
      id,
      accepted: answer.accepted,
      ...(!answer.accepted && { reason: answer.reason }),
    });
  }

  /**
   * The lines the author typed into the recorded block that count as WRITTEN
   * now — left by the cursor, with a step on them (`commitAuthorLines`) — go
   * to the server as `add-step` from the editor, with where they sit in the
   * draft the author was looking at (stories/testbench-record-toolbar.md
   * §"Steps typed in the editor"). Only while recording: after Stop a line is
   * the author's text, as it always was.
   *
   * `ignoreCursors`: the author left the editor (the window lost focus), so
   * the line the cursor is on is finished too. `final`: Stop — every line
   * with a step on it goes, the cursor's included, waiting for nothing
   * (`commitAuthorLines`); it runs as Stop is sent, or as the server's
   * `record:writing` arrives for a Stop pressed in the browser.
   */
  private countAuthorLines(rec: ActiveRecording, opts: { ignoreCursors?: boolean; final?: boolean } = {}): void {
    const live = rec.live;
    if (this.current !== rec || rec.state.phase !== 'recording') return;
    if (rec.stopSent && !opts.final) return;
    // A write in flight is fine: what is sent now is carried into the record
    // that write leaves (`carryAuthorState`).
    if (!live.record || live.detached || live.closed || live.stopped || rec.doc.isClosed) return;
    if (!live.record.slots.some((s) => s.kind === 'mine')) return;
    const doc = rec.doc;
    const cursors =
      opts.ignoreCursors || opts.final
        ? []
        : vscode.window.visibleTextEditors
            .filter((e) => e.document.uri.toString() === rec.key)
            .flatMap((e) => e.selections.map((sel) => doc.offsetAt(sel.active)));
    const text = doc.getText();
    const counted = commitAuthorLines(live.record, text, cursors, { final: opts.final === true });
    live.record = counted.record;
    for (const commit of counted.commits) {
      rec.authorSends = rec.authorSends.then(() => this.sendAuthorStep(rec, commit)).catch(() => undefined);
    }
    // Recorded lines the author reworded, and the lines of their steps they
    // changed after sending, count at the same moments
    // (stories/testbench-record-edit-steps.md §"In the file").
    const edited = commitLineEdits(live.record, text, cursors, { final: opts.final === true, book: rec.book });
    live.record = edited.record;
    for (const commit of edited.commits) {
      if (commit.action === 'drop') this.markDeleted(rec, commit.id, true);
      rec.authorSends = rec.authorSends.then(() => this.sendLineEdit(rec, commit)).catch(() => undefined);
    }
  }

  /**
   * The deletes and restores the file asked for — lines of steps deleted, and
   * Ctrl+Z bringing one back — sent at once, in order, after what is already
   * on its way; the panel strikes (or restores) the step as they go.
   */
  private sendLineControls(rec: ActiveRecording): void {
    if (this.current !== rec || rec.state.phase !== 'recording') {
      // After Stop the server takes nothing but `cancel`: what the file does
      // then is the author's text, as it always was.
      takeLineControls(rec.book);
      return;
    }
    for (const control of takeLineControls(rec.book)) {
      this.markDeleted(rec, control.id, control.action === 'drop');
      rec.authorSends = rec.authorSends.then(() => this.sendStepControl(rec, control)).catch(() => undefined);
    }
  }

  /** Strike a step in Steps so far (or put it back), and show it. */
  private markDeleted(rec: ActiveRecording, id: string, deleted: boolean): void {
    if (markStepDeleted(rec.state, id, deleted) && this.current === rec) this.publish();
  }

  /** A `drop` / `restore` of a step whose line was deleted in the file (or
   *  brought back). One the server does not take is said in the log — by the
   *  step's number, never its words. */
  private async sendStepControl(rec: ActiveRecording, control: { action: 'drop' | 'restore'; id: string }): Promise<void> {
    const sent = await rec.controller.controlRecording({ action: control.action, id: control.id, source: 'editor' });
    if (sent.ok && !sent.ignored) return;
    if (this.current !== rec) return;
    const why = sent.ok ? (sent.reason ?? 'the server did not take it') : sent.error;
    rec.controller.postRecordLog(
      control.action === 'drop'
        ? `A step whose line you deleted from the file was not taken out of the recording (${why}).`
        : `A step whose line you brought back in the file was not put back in the recording (${why}).`,
      'warn',
    );
  }

  /**
   * One edit of a step made in the file: its new words (`edit-step`), or —
   * the line emptied — its delete (`drop`). A server that does not take an
   * edit leaves the line as the author wrote it, said once in the log by its
   * line number, never by quoting it: the server refuses words holding a
   * secret it knows, and TestBench cannot tell which those are.
   */
  private async sendLineEdit(rec: ActiveRecording, commit: LineEditCommit): Promise<void> {
    if (commit.action === 'drop') {
      await this.sendStepControl(rec, { action: 'drop', id: commit.id });
      return;
    }
    const sent = await rec.controller.controlRecording({
      action: 'edit-step',
      id: commit.id,
      text: commit.text ?? '',
      source: 'editor',
      ...(commit.revision !== undefined && { revision: commit.revision }),
    });
    if (sent.ok && !sent.ignored) return;
    if (rec.live.record) rec.live.record = editRefused(rec.live.record, commit, rec.book);
    const at = this.lineOf(rec, commit.key);
    rec.controller.postRecordLog(
      `Your edit${at >= 0 ? ` on line ${at + 1}` : ''} was not taken by the recording ` +
        `(${sent.ok ? (sent.reason ?? 'the server did not take it') : sent.error}); it stays in the file as you wrote it.`,
      'warn',
    );
  }

  /** The 0-based line a line of the author's is on now, or -1. */
  private lineOf(rec: ActiveRecording, key: string): number {
    const slot = rec.live.record?.slots.find((s) => s.kind === 'mine' && s.key === key);
    if (!slot || rec.doc.isClosed) return -1;
    const lead = slot.lineEnd ? (slot.wrote.startsWith('\r\n') ? 2 : slot.wrote.startsWith('\n') ? 1 : 0) : 0;
    return rec.doc.positionAt(slot.start + lead).line;
  }

  /**
   * Stop is about to go: the add-steps already on their way first, and the
   * drafts in flight into the file; then every line typed in the file that
   * has not gone yet (`countAuthorLines` final), and those sent too — so the
   * server has them all before it hears Stop.
   */
  private async flushAuthorLines(rec: ActiveRecording): Promise<void> {
    await rec.authorSends;
    await rec.live.chain;
    this.countAuthorLines(rec, { final: true });
    await rec.authorSends;
  }

  /** One add-step for lines the author wrote in the file, naming the draft
   *  they were counted against. A server that does not take it leaves them
   *  the author's text, said once in the log — by line number, never by
   *  quoting it: the server refuses a line holding a secret it knows
   *  (SPEC-record-steps §7.6), and TestBench cannot tell which that is. */
  private async sendAuthorStep(rec: ActiveRecording, commit: AuthorStepCommit): Promise<void> {
    const sent = await rec.controller.controlRecording({
      action: 'add-step',
      text: commit.lines.join('\n'),
      source: 'editor',
      ...(commit.afterStep !== undefined && { afterStep: commit.afterStep }),
      ...(commit.revision !== undefined && { revision: commit.revision }),
    });
    if (sent.ok && !sent.ignored) return;
    if (rec.live.record) rec.live.record = keepAuthorLines(rec.live.record, commit.keys);
    const first = commit.lines[0] ?? '';
    const at = rec.doc.isClosed || !first ? -1 : rec.doc.getText().split(/\r?\n/).findIndex((l) => l.includes(first));
    const many = commit.lines.length > 1;
    const which = many
      ? `Your ${commit.lines.length} steps${at >= 0 ? ` from line ${at + 1}` : ''} were`
      : `Your step${at >= 0 ? ` on line ${at + 1}` : ''} was`;
    rec.controller.postRecordLog(
      `${which} not added to the recording ` +
        `(${sent.ok ? (sent.reason ?? 'the server did not take it') : sent.error}); it stays in the file as you wrote it.`,
      'warn',
    );
    // A line waiting on this one may go now.
    this.countAuthorLines(rec);
  }

  /**
   * The ✕ on an action row, or putting a struck-through one back. Shown at
   * once, and sent at once as `drop` / `restore` so the server redrafts
   * without that action (decision 9) — the Steps so far list catches up when
   * the redraft arrives. Stop sends the whole `dropped` list as well, which
   * the server unions with these, so a control that failed here still counts
   * at Stop. After Stop only `cancel` does anything server-side, so the rows
   * are frozen then.
   */
  async setDropped(id: string, dropped: boolean): Promise<void> {
    const rec = this.current;
    if (!rec || rec.state.phase === 'finishing' || rec.stopSent) return;
    const action = rec.state.actions.find((a) => a.id === id);
    // A step of the draft — the ✕ or Restore on a Steps so far row
    // (stories/testbench-record-edit-steps.md §"The panel"): the step goes (or
    // comes back) with the actions it stands for; the file follows at once.
    const isStep = rec.state.draft?.ids?.includes(id) === true || (rec.state.deletedSteps ?? []).some((d) => d.id === id);
    if (!action && isStep) {
      const text = rec.state.draft?.steps[rec.state.draft.ids?.indexOf(id) ?? -1];
      const after = rec.state.deletedSteps?.find((d) => d.id === id)?.after;
      if (!markStepDeleted(rec.state, id, dropped)) return;
      if (!dropped) noteStepRestored(id, rec.book);
      this.publish();
      this.queueDraftWrite(rec, { rewrite: true });
      const sent = await rec.controller.controlRecording({ action: dropped ? 'drop' : 'restore', id, source: 'panel' });
      if (this.current !== rec || (sent.ok && !sent.ignored)) return;
      // Not done: the row shows what the recording has — and the file with it.
      if (dropped) markStepDeleted(rec.state, id, false);
      else if (!rec.state.draft?.ids?.includes(id)) {
        rec.state.deletedSteps = [...(rec.state.deletedSteps ?? []), { id, text: text ?? '', after: after ?? null }];
      }
      this.publish();
      this.queueDraftWrite(rec, { rewrite: true });
      rec.controller.postRecordLog(
        `Could not ${dropped ? 'delete' : 'restore'} that step (${sent.ok ? (sent.reason ?? 'the server did not take it') : sent.error}).`,
        'warn',
      );
      return;
    }
    // A pause marker or an edit row is not in the recording: nothing to drop.
    if (!action || action.dropped === dropped || action.kind === 'pause' || action.kind === 'resume' || action.kind === 'edit') return;
    action.dropped = dropped;
    if (!dropped) delete action.droppedWith;
    // A step of the author's: struck in Steps so far too, where it was.
    if (action.kind === 'step') {
      markStepDeleted(rec.state, id, dropped);
      if (!dropped) noteStepRestored(id, rec.book);
    }
    this.publish();
    // A step of the author's: the file follows the row at once — its line
    // (typed in the file) comes out or goes back, or (the toolbar's or the
    // panel's) the recording's line for it.
    if (action.kind === 'step') this.queueDraftWrite(rec, { rewrite: true });
    const sent = await rec.controller.controlRecording({
      action: dropped ? 'drop' : 'restore',
      id,
      ...(action.kind === 'step' && { source: 'panel' as const }),
    });
    if (!sent.ok && this.current === rec) {
      rec.controller.postRecordLog(
        `Could not ${dropped ? 'drop' : 'restore'} that action now (${sent.error}); it is still ${dropped ? 'left out' : 'included'} when you press Stop.`,
        'warn',
      );
    }
  }

  /** Re-post the state — the panel was rebuilt and asked (`ready`). */
  republish(): void {
    this.publish();
  }

  /**
   * The recording, if one is running, is cancelled — which takes its draft
   * back out of the file (`run` → `clearLive`), if the host lives long enough:
   * `deactivate` waits for that a moment first (`shutdown`). What does not
   * make it stays in the workspace's state for `recoverUnfinished`.
   */
  dispose(): void {
    const rec = this.current;
    this.current = null;
    if (rec) {
      rec.live.stopped = true;
      void rec.controller.cancelRecording();
    }
    this.lastLive?.decoration?.dispose();
    this.statusItem.dispose();
  }

  // -------------------------------------------------------------------------

  private async run(rec: ActiveRecording, opts: RecordStartOptions): Promise<void> {
    const outcome = await rec.controller.recordSteps({
      target: {
        mode: opts.mode,
        ...(opts.cursorLine !== undefined && { cursorLine: opts.cursorLine }),
      },
      onEvent: (event) => this.onEvent(rec, event),
      toolbar: this.toolbarPreferences(),
      ...(opts.retryConflict && { retryConflict: true }),
    });
    // The recording is over, however it ended: take the block down before
    // touching the document, and write no more drafts.
    rec.live.stopped = true;
    this.release(rec);
    if (outcome.status !== 'result') {
      // Cancelled, aborted or failed: nothing recorded stays in the file.
      await this.clearLive(rec);
    }
    if (outcome.status === 'cancelled') {
      if (outcome.by === 'browser') {
        // Cancel pressed in the browser's toolbar: the author's own Cancel,
        // made there — quiet, no notification.
        rec.controller.postRecordLog(CANCELLED_IN_BROWSER, 'info');
        this.finish('cancelled', []);
        if (this.lastReport) this.lastReport.by = 'browser';
        return;
      }
      if (outcome.reason) {
        // The server ended it — the session was closed under the recording
        // (another window's Run, Close Session, the idle reaper). The author
        // did not cancel, so they are told why, in the server's words.
        rec.controller.postRecordLog(outcome.reason, 'warn');
        this.finish('cancelled', [{ level: 'warn', text: outcome.reason }]);
        return;
      }
      rec.controller.postRecordLog('Recording cancelled — nothing was written.', 'info');
      this.finish('cancelled', []);
      return;
    }
    if (outcome.status === 'error') {
      // Shown as it came: the server's `done.error` is written as the one
      // sentence the author sees (SPEC-record-steps.md §10), and this client's
      // own failures are whole sentences too.
      if (!rec.loggedErrors.some((line) => line.includes(outcome.error))) {
        rec.controller.postRecordLog(outcome.error, 'error');
      }
      this.finish('error', [{ level: 'error', text: outcome.error }]);
      return;
    }
    await this.insert(rec, outcome);
  }

  private onEvent(rec: ActiveRecording, event: RecordStepsEvent): void {
    if (event.type === 'output') {
      // A failed draft call arrives here as a warning (decision 9): the
      // previous draft stands, and the author is told in the panel's log.
      if (event.kind === 'error') rec.loggedErrors.push(event.msg);
      rec.controller.postRecordLog(event.msg, event.kind);
      return;
    }
    if (event.type === 'record:toolbar') {
      // Where the author left the browser toolbar: the next recording's start
      // body puts it back there (stories/testbench-record-toolbar.md).
      this.rememberToolbar(event.dock, event.minimised);
      return;
    }
    if (event.type === 'record:step') {
      if (event.source === 'editor') {
        // The server's name for a line the author typed in the file — or for
        // one they deleted before it came, whose step then goes too.
        if (rec.live.record) rec.live.record = assignAuthorStepId(rec.live.record, event.id, event.text, rec.book);
        this.sendLineControls(rec);
      } else {
        rec.foreignIds.add(event.id);
      }
    }
    let rewrite = false;
    if (event.type === 'record:edited' && rec.live.record) {
      // A step reworded — an edit of ours taken, or newer words from the
      // drawer or the panel, which a line of the author's standing for it
      // takes at the next write (stories/testbench-record-edit-steps.md) —
      // unless they changed that line since the recording last held it: the
      // file wins, said once, by the line's number, never its words.
      const declined = followDeclined(rec.live.record, event);
      if (declined !== null && !rec.leftSaid.has(`follow:${declined}`)) {
        rec.leftSaid.add(`follow:${declined}`);
        const at = this.lineOf(rec, declined);
        rec.controller.postRecordLog(
          `A step was reworded in the browser while you were changing it in the file${at >= 0 ? ` (line ${at + 1})` : ''}; the line keeps what you wrote.`,
          'info',
        );
      }
      const before = rec.live.record;
      rec.live.record = noteStepEdited(before, event, rec.book);
      rewrite = rec.live.record !== before;
    }
    // A step restored anywhere is no longer one whose line was deleted here.
    if (event.type === 'record:dropped' && event.dropped === false) noteStepRestored(event.id, rec.book);
    if (event.type === 'record:draft' && !rec.idlessSaid && !Array.isArray(event.ids) && event.steps.some((s) => cleanStepText(s) !== '')) {
      // A server that predates editing: say once what that means here.
      rec.idlessSaid = true;
      rec.controller.postRecordLog(IDLESS_SERVER, 'info');
    }
    // Stop pressed in the browser: the lines typed in the file that have not
    // gone yet go now, the cursor's included. The server may no longer take
    // them — they then stay the author's text, said in the log.
    if (event.type === 'record:writing' && !rec.stopSent) this.countAuthorLines(rec, { final: true });
    // The block's state is folded by the pure core, where it is pinned.
    const changed = applyRecordFrame(rec.state, event as unknown as { type: string } & Record<string, unknown>);
    if (changed && this.current === rec) this.publish();
    // A newer draft goes into the file too (a stale one changed nothing).
    if (changed && event.type === 'record:draft') this.queueDraftWrite(rec);
    // A step dropped or restored elsewhere (the browser's Undo, the drawer's
    // ✕): its line in the file follows at once — and a line of the author's
    // takes newer words for its step.
    if ((changed && event.type === 'record:dropped') || rewrite) this.queueDraftWrite(rec, { rewrite: true });
  }

  /** The start body's `toolbar`: the setting, and where the last recording
   *  left the toolbar. */
  private toolbarPreferences(): NonNullable<RecordStepsRequest['toolbar']> {
    const enabled = vscode.workspace.getConfiguration('testbench-native').get<boolean>(BROWSER_TOOLBAR_SETTING) !== false;
    const kept = this.rememberedToolbar;
    return { enabled, ...(kept && { dock: kept.dock, minimised: kept.minimised }) };
  }

  private rememberToolbar(dock: unknown, minimised: unknown): void {
    if (!DOCKS.includes(dock as RecordToolbarDock)) return;
    void this.storage?.update(TOOLBAR_KEY, { dock, minimised: minimised === true });
  }

  /** A draft as the file writer takes it: its steps, and which of them are
   *  the author's (to be laid out around their lines in the file). */
  private liveDraftOf(rec: ActiveRecording, draft: NonNullable<RecordingPanelState['draft']>): LiveDraft {
    return {
      steps: draft.steps,
      parameters: draft.parameters,
      ...(draft.authored && { authored: draft.authored, authoredIds: draft.authoredIds ?? [] }),
      ...(draft.ids && { ids: draft.ids }),
      ...(draft.edited && { edited: draft.edited }),
      foreignIds: [...rec.foreignIds],
      revision: draft.revision,
      droppedIds: this.droppedStepIds(rec),
    };
  }

  /**
   * The steps dropped now elsewhere than the file: the author's steps struck
   * in the panel (its ✕, or the browser's Undo — `record:dropped`), and the
   * steps deleted from Steps so far in the panel or the browser's drawer. A
   * step whose line the author deleted in the file is the book's to leave out
   * (`LineBook.deleted`): it never takes another line of theirs with it.
   */
  private droppedStepIds(rec: ActiveRecording): string[] {
    const struck = rec.state.actions.filter((a) => a.kind === 'step' && a.dropped).map((a) => a.id);
    const deleted = (rec.state.deletedSteps ?? []).map((d) => d.id);
    return [...new Set([...struck, ...deleted])].filter((id) => !rec.book.deleted.has(id));
  }

  // -------------------------------------------------------------------------
  // The file while recording
  // -------------------------------------------------------------------------

  /**
   * Write the latest draft into the file, after any write still in flight.
   * Drafts that arrive meanwhile coalesce: the queued write reads the latest
   * one when it starts, so a burst costs one edit. `rewrite`: write it even
   * when it is the one already written — a step of the author's was dropped
   * or restored, and its line follows the panel.
   */
  private queueDraftWrite(rec: ActiveRecording, opts: { rewrite?: boolean } = {}): void {
    const live = rec.live;
    if (opts.rewrite) live.rewrite = true;
    if (live.queued || live.stopped || live.closed || live.detached) return;
    live.queued = true;
    live.chain = live.chain
      .then(async () => {
        live.queued = false;
        const rewrite = live.rewrite;
        live.rewrite = false;
        const draft = rec.state.draft;
        if (live.stopped || live.closed || live.detached || !draft) return;
        if (draft.revision <= live.written && !(rewrite && live.written > 0)) return;
        const written = await this.writeLive(rec, this.liveDraftOf(rec, draft), 'draft');
        if (written.ok) {
          live.written = Math.max(live.written, draft.revision);
          this.sayLeft(rec, written.left);
          // What finding the file again told the book (a line an undo brought
          // back is its step restored).
          this.sendLineControls(rec);
          // A line the author left while the write was in flight — or one
          // that waited for the line above it to be held.
          this.countAuthorLines(rec);
        } else if (written.lost) {
          this.detach(rec);
        } else if (live.unwritable !== written.reason) {
          // Said once, in the output: the panel still shows the draft, and the
          // result is written — or rescued — at Stop.
          live.unwritable = written.reason;
          getOutputChannel().appendLine(`Record Steps: the draft is not shown in ${rec.state.file} — ${written.reason}.`);
        }
      })
      .catch((err: unknown) => {
        getOutputChannel().appendLine(
          `Record Steps: writing the draft into ${rec.state.file} failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Make the file read as `draft`: each slot the recording owns replaced by
   * what the draft puts there (`liveRecordWrite`). The first write fixes the
   * slots, planning against the document as it is then. Every later one first
   * finds what the recording wrote — by its text, when the offsets could not
   * follow — and writes nothing when that fails (`lost`): the caller decides
   * what then (a draft stops writing live, Stop inserts once at the anchor,
   * Cancel takes nothing out).
   *
   * Undo (SPEC-record-steps.md §7): the recording's writes are meant to be one
   * undo step. A draft goes in through the document's editor with no undo stop
   * after it, so the next one joins the same step; the final write (the result,
   * or the empty draft at Cancel) closes it. The first write — and the first
   * after anything else changed the document — opens a new step instead of
   * joining one the author left open. A document shown in no editor has no
   * editor to join a step through: a DRAFT for it goes in as a WorkspaceEdit,
   * which is always an undo step of its own; the FINAL write shows the
   * document first, as the insertion always has, and goes through its editor.
   *
   * An edit rejected because the document changed under it (an author's
   * keystroke landing first) is planned again, three times.
   */
  private async writeLive(
    rec: ActiveRecording,
    draft: LiveDraft,
    kind: 'draft' | 'final' | 'clear',
  ): Promise<
    | {
        ok: true;
        plan: RecordInsertionPlan | null;
        editor: vscode.TextEditor | null;
        /** Lines of the author's that stayed when their step was dropped. */
        left: Array<{ key: string; line: string }>;
      }
    | { ok: false; reason: string; lost?: boolean }
  > {
    const live = rec.live;
    // A rename in flight: the old document is closed and the new one open.
    if (rec.doc.isClosed && live.renameTo) await this.followRename(rec, live.renameTo);
    const doc = rec.doc;
    const file = rec.state.file;
    if (live.closed || doc.isClosed) {
      live.closed = true;
      return { ok: false, reason: `${file} was closed while recording` };
    }
    const anchor = rec.state.mode === 'new' ? null : rec.anchor;
    for (let attempt = 0; attempt < 3; attempt++) {
      let editor = visibleEditorFor(doc);
      if (!editor && kind === 'final') editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (doc.isClosed) {
        live.closed = true;
        return { ok: false, reason: `${file} was closed while recording` };
      }
      if (!live.record) {
        // Nothing written yet, so nothing to take out.
        if (kind === 'clear') return { ok: true, plan: null, editor, left: [] };
        const begun = beginLiveRecord(doc.getText(), anchor);
        if ('error' in begun) return { ok: false, reason: begun.error };
        live.record = begun;
      }
      // Once the file has been given up on, only its text says what is still
      // the recording's: the offsets are not trusted at all.
      const record = live.detached ? { ...live.record, uncertain: true } : live.record;
      const current = doc.getText();
      const write = liveRecordWrite(record, current, draft, { anchor, book: rec.book });
      if ('error' in write) return { ok: false, reason: write.error, lost: write.lost === true };
      // The final write closes the undo step the drafts left open — which
      // takes an edit even when the draft already said it all: a replace of
      // the block with itself carries the undo stop.
      const closing = kind !== 'draft' && live.groupOpen && editor !== null;
      const edits =
        write.edits.length > 0 || !closing
          ? write.edits
          : write.slots.filter((s) => s.kind === 'block').map((s) => ({ start: s.start, end: s.end, text: current.slice(s.start, s.end) }));
      if (edits.length === 0) {
        live.record = write.record;
        return { ok: true, plan: write.plan, editor, left: write.left };
      }
      const watching = editor !== null && kind === 'draft' && this.isWatching(rec, editor);
      live.pending = { text: write.text, record: write.record, matched: false };
      let applied = false;
      try {
        const toRange = (e: { start: number; end: number }): vscode.Range =>
          new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end));
        if (editor) {
          applied = await editor.edit(
            (builder) => {
              for (const e of edits) builder.replace(toRange(e), e.text);
            },
            { undoStopBefore: !live.groupOpen, undoStopAfter: kind !== 'draft' },
          );
          if (applied) live.groupOpen = kind === 'draft';
        } else {
          const we = new vscode.WorkspaceEdit();
          for (const e of edits) we.replace(doc.uri, toRange(e), e.text);
          applied = await vscode.workspace.applyEdit(we);
          // Always an undo step of its own.
          if (applied) {
            live.groupOpen = false;
            if (kind === 'draft') live.split = true;
          }
        }
        if (applied && kind === 'draft') live.wroteAny = true;
      } catch (err) {
        // The editor went away between finding it and editing through it:
        // try again with whatever shows the document now.
        getOutputChannel().appendLine(
          `Record Steps: an edit to ${file} was refused (${err instanceof Error ? err.message : String(err)}); trying again.`,
        );
        applied = false;
      } finally {
        const matched = live.pending?.matched ?? false;
        live.pending = null;
        // An edit that changed nothing sends no change event to match. What
        // became of the author's lines meanwhile is kept.
        if (applied && !matched) live.record = live.record ? carryAuthorState(live.record, write.record) : write.record;
      }
      if (applied) {
        if (kind === 'draft') this.persist(rec);
        this.highlight(rec);
        if (watching && editor) this.followBlock(rec, editor);
        return { ok: true, plan: write.plan, editor, left: write.left };
      }
    }
    return { ok: false, reason: `${file} kept changing while the steps were being inserted` };
  }

  /**
   * What the recording wrote could not be found in the file any more: stop
   * writing into it for the rest of this recording, and say so, once. The
   * panel keeps drafting; Stop looks once more and otherwise inserts the
   * result at the anchor, as a one-shot insertion always did.
   */
  private detach(rec: ActiveRecording): void {
    const live = rec.live;
    if (live.detached) return;
    live.detached = true;
    if (live.record) live.record = { ...live.record, uncertain: true };
    const notice = { level: 'warn' as const, text: NO_LONGER_LIVE };
    live.notices.push(notice);
    rec.controller.postRecordLog(notice.text, 'warn');
    void this.notify(notice.level, notice.text);
    this.forget();
    this.highlight(rec);
  }

  /**
   * A step of the author's was dropped (the panel's ✕, the browser's Undo),
   * and its line stayed in the file because they had edited it since the
   * recording last left it: said once per line, in the log and the status
   * bar — the panel row is struck, and the file does not follow it.
   */
  private sayLeft(rec: ActiveRecording, left: Array<{ key: string; line: string }>): void {
    for (const { key, line } of left) {
      if (rec.leftSaid.has(key)) continue;
      rec.leftSaid.add(key);
      const text = leftInFileText(line);
      rec.controller.postRecordLog(text, 'warn');
      vscode.window.setStatusBarMessage(`TestBench: ${text}`, 5000);
    }
  }

  /** Keep what the in-flight recording has written, for `recoverUnfinished`. */
  private persist(rec: ActiveRecording): void {
    if (!this.storage) return;
    const live = rec.live;
    const facts = live.record && !live.detached && !live.closed ? unfinishedRecordingOf(live.record) : null;
    void this.storage.update(UNFINISHED_KEY, facts ? { uri: rec.key, file: rec.state.file, ...facts } : undefined);
  }

  /** The recording is over (or gave up on its file): nothing to recover. */
  private forget(): void {
    if (this.storage?.get(UNFINISHED_KEY) !== undefined) void this.storage?.update(UNFINISHED_KEY, undefined);
  }

  /**
   * Take out everything the recording wrote — the empty draft: no block, no
   * added parameter lines, every later step's number as the file had it. What
   * the author changed elsewhere stays. Used at Cancel, at a recording that
   * ends in an error, and before a result is rescued. Only what is found, by
   * its text, to be the recording's is taken out: when it cannot be found,
   * nothing is.
   */
  private async clearLive(rec: ActiveRecording): Promise<void> {
    const live = rec.live;
    live.stopped = true;
    await live.chain;
    if (!live.record || live.closed) return;
    const cleared = await this.writeLive(rec, { steps: [], parameters: [], clear: true }, 'clear');
    // The edit itself did not go through — not "not found", not "closed":
    // what the drafts wrote is still in the buffer, and kept for a reload.
    live.keepUnfinished = !cleared.ok && !cleared.lost && !live.closed;
    if (!cleared.ok) {
      rec.controller.postRecordLog(
        cleared.lost
          ? `The steps written while recording could not be found in ${rec.state.file} any more, so nothing was taken out of it.`
          : `The draft steps written while recording could not be taken out of ${rec.state.file} — ${cleared.reason}.`,
        'warn',
      );
    }
  }

  /** The editor shows where the recording writes: the block's first line (or
   *  the anchor, before anything is written) is on screen. */
  private isWatching(rec: ActiveRecording, editor: vscode.TextEditor): boolean {
    const block = rec.live.record?.slots.find((s) => s.kind === 'block');
    const line = block ? editor.document.positionAt(block.start).line : (rec.anchor?.line ?? 1) - 1;
    return editor.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line);
  }

  /** Keep the block's last line on screen as it grows — only for an author
   *  who was looking at it; one who scrolled elsewhere is left there. */
  private followBlock(rec: ActiveRecording, editor: vscode.TextEditor): void {
    const record = rec.live.record;
    if (!record) return;
    const lines = recordedLines(editor.document.getText(), record.slots, ['block']);
    const last = lines[lines.length - 1];
    if (last === undefined) return;
    editor.revealRange(new vscode.Range(last, 0, last, 0), vscode.TextEditorRevealType.Default);
  }

  /** Put the highlight on the recorded lines in every editor showing the
   *  document — none while they are not known to be where the offsets say
   *  (until the next write finds them), or once the file is given up on. */
  private highlight(rec: ActiveRecording): void {
    const live = rec.live;
    if (!live.decoration) return;
    const doc = rec.doc;
    const known = live.record && !live.closed && !live.detached && !live.record.uncertain && !doc.isClosed;
    live.highlighted = known && live.record ? recordedLines(doc.getText(), live.record.slots) : [];
    const ranges = live.highlighted.map((line) => new vscode.Range(line, 0, line, 0));
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === rec.key) editor.setDecorations(live.decoration, ranges);
    }
  }

  /** The recording is over: its highlight comes off. */
  private endHighlight(rec: ActiveRecording): void {
    const live = rec.live;
    live.decoration?.dispose();
    live.decoration = null;
    live.highlighted = [];
  }

  /**
   * The result, written over the last draft through the same path every draft
   * took (`writeLive`) — so nothing is inserted twice, and it closes the undo
   * step the drafts opened (decision 11): the steps after the anchor, the rest
   * of that flow renumbered, and the parameters the file lacks. When no draft
   * was written, the place is fixed now, against the document as it is, with
   * the anchor carried through the author's edits while recording.
   *
   * A result is never lost. One with no steps is said as the server's note,
   * not as an error (and whatever the drafts wrote is taken out); one that
   * cannot be written — `## Steps` gone before anything was written, the edit
   * rejected three times, the file closed, renamed or deleted — is written to
   * the TestBench output, and the error offers "Copy steps".
   */
  private async insert(
    rec: ActiveRecording,
    outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
  ): Promise<void> {
    if (outcome.steps.map(cleanStepText).every((s) => s === '')) {
      await this.clearLive(rec);
      const text = outcome.notes.length > 0 ? outcome.notes.join(' ') : 'Nothing was recorded, so nothing was written.';
      rec.controller.postRecordLog(text, 'info');
      this.finish('empty', [{ level: 'info', text }]);
      return;
    }
    let failure: string;
    try {
      const inserted = await this.applyResult(rec, outcome);
      if (inserted.ok) return;
      failure = inserted.reason;
    } catch (err) {
      failure = `${rec.state.file} could not be opened for editing (${err instanceof Error ? err.message : String(err)})`;
    }
    // The file keeps no half-written draft beside a rescued result.
    await this.clearLive(rec).catch(() => undefined);
    this.rescue(rec, outcome, failure);
  }

  /** The edit itself, or why it could not be made. */
  private async applyResult(
    rec: ActiveRecording,
    outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const file = rec.state.file;
    // A draft still being written finishes first; the result goes over it.
    await rec.live.chain;
    // One Ctrl+Z after Stop takes the whole recording back. The drafts and the
    // result are one undo step unless something closed it on the way (`split`);
    // then the drafts are taken out first, closing whatever step is open, and
    // the result goes in as a step of its own — so the state one undo returns
    // to is the file without the recording, the author's own edits kept.
    if (rec.live.split && !rec.live.detached) {
      const cleared = await this.writeLive(rec, { steps: [], parameters: [], clear: true }, 'clear');
      // Not found: the final write below looks once more, then inserts once.
      if (!cleared.ok && !cleared.lost) return cleared;
    }
    let plan: RecordInsertionPlan | null;
    let editor: vscode.TextEditor | null;
    let lines: number[];
    // The author's steps in the result are where the last draft had them
    // (`record:result` does not say): their lines in the file are adopted,
    // not written a second time.
    const authored = authoredForResult(rec.state.draft, outcome.steps);
    // The last draft's step ids, placed in the result (which carries none): a
    // line the author reworded is its step, never written a second time.
    const stepIds = idsForResult(rec.state.draft, outcome.steps);
    const written = await this.writeLive(
      rec,
      {
        steps: outcome.steps,
        parameters: outcome.parameters,
        ...authored,
        ...stepIds,
        foreignIds: [...rec.foreignIds],
        droppedIds: this.droppedStepIds(rec),
        // A line sent as Stop went, which no draft held yet, is its step.
        adoptSentByText: true,
      },
      'final',
    );
    if (written.ok) {
      plan = written.plan;
      editor = written.editor;
      // The recorded steps, selected (the blank lines the block may carry for
      // spacing are not steps).
      const block = rec.live.record?.slots.filter((s) => s.kind === 'block') ?? [];
      lines = editor ? recordedLines(editor.document.getText(), block) : [];
    } else if (written.lost) {
      // What the drafts wrote is not in the file as they wrote it (§7): the
      // result goes in once, at the anchor, and what is left of the drafts is
      // not touched — nor are the author's own lines, whose steps are not put
      // in a second time.
      const once = await this.insertOnce(rec, outcome, { ...authored, ...(stepIds.ids && { ids: stepIds.ids }) });
      if (!once.ok) return once;
      if (!once.plan) {
        const text = `Every recorded step is one you typed in ${file}, and they are all still there; nothing more was inserted.`;
        rec.controller.postRecordLog(text, 'info');
        void this.notify('info', text);
        this.lastReport = { status: 'inserted', steps: 0, messages: [{ level: 'info', text: plainNotificationText(text) }] };
        return { ok: true };
      }
      plan = once.plan;
      editor = once.editor;
      lines = once.plan.insertedLines.map((l) => l - 1);
    } else {
      return written;
    }
    if (!plan) return { ok: false, reason: 'The recording came back with no steps.' };

    const first = lines[0];
    const last = lines[lines.length - 1];
    if (editor && first !== undefined && last !== undefined) {
      const end = editor.document.lineAt(last).text.length;
      editor.selection = new vscode.Selection(first, 0, last, end);
      editor.revealRange(new vscode.Range(first, 0, last, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    const messages: RecordingReport['messages'] = [];
    const n = plan.insertedLines.length;
    const where = plan.section === null ? '' : ` (section "${plan.section}")`;
    const added = plan.parametersAdded.length > 0 ? `; added ${plan.parametersAdded.join(', ')} to ## Parameters` : '';
    const summary = `Recorded ${n} ${n === 1 ? 'step' : 'steps'} into ${file}${where}${added}.`;
    rec.controller.postRecordLog(summary, 'info');
    for (const note of outcome.notes) rec.controller.postRecordLog(`Note: ${note}`, 'info');
    messages.push({ level: 'info', text: outcome.notes.length > 0 ? `${summary} ${outcome.notes.join(' ')}` : summary });

    const warnings = [...plan.warnings, ...missingEnvWarnings(outcome, plan.parametersAdded)];
    for (const w of warnings) {
      rec.controller.postRecordLog(w, 'warn');
      messages.push({ level: 'warn', text: w });
    }

    for (const m of messages) {
      m.text = plainNotificationText(m.text);
      void this.notify(m.level, m.level === 'warn' ? `Record Steps: ${m.text}` : m.text);
    }
    this.lastReport = { status: 'inserted', steps: n, messages };
    return { ok: true };
  }

  /**
   * The result as one insertion at the anchor into the document as it is now
   * — how every recording's result went in before drafts were written live —
   * for a recording that gave up on its file. Its own undo step. The anchor is
   * where it has been followed to, else found again by its text; failing
   * both, the steps go at the end of its flow and the author is told.
   *
   * The author's own steps whose lines are still in the file are left out
   * (`oneShotSteps`): those lines are theirs and stay where they typed them,
   * and inserting the steps again would put each in the file twice. `plan`
   * null: every step was one of those — nothing to insert.
   */
  private async insertOnce(
    rec: ActiveRecording,
    outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
    authored: { authored: number[]; authoredIds: string[]; ids?: string[] },
  ): Promise<{ ok: true; plan: RecordInsertionPlan | null; editor: vscode.TextEditor } | { ok: false; reason: string }> {
    const file = rec.state.file;
    const doc = rec.doc;
    if (doc.isClosed) return { ok: false, reason: `${file} was closed while recording` };
    const editor = visibleEditorFor(doc) ?? (await vscode.window.showTextDocument(doc, { preview: false }));
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = editor.document.getText();
      const once = oneShotSteps(rec.live.record, text, { steps: outcome.steps, ...authored });
      if (once.steps.length === 0) return { ok: true, plan: null, editor };
      const plan = planRecordInsertion(text, {
        anchor: rec.state.mode === 'new' ? null : rec.anchor,
        steps: once.steps,
        parameters: outcome.parameters,
      });
      if ('error' in plan) return { ok: false, reason: plan.error };
      const applied = await editor.edit(
        (builder) => {
          for (const e of plan.edits) {
            builder.replace(new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar), e.text);
          }
        },
        { undoStopBefore: true, undoStopAfter: true },
      );
      if (applied) return { ok: true, plan, editor };
    }
    return { ok: false, reason: `${file} kept changing while the steps were being inserted` };
  }

  /**
   * The result could not be inserted: put it where the author can take it —
   * the TestBench output, whole, and the clipboard on "Copy steps".
   */
  private rescue(
    rec: ActiveRecording,
    outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
    reason: string,
  ): void {
    const text = recordedStepsText(outcome.steps, outcome.parameters);
    const out = getOutputChannel();
    out.appendLine(`Record Steps: the recorded steps were not inserted — ${reason}. Here they are, to paste by hand:`);
    for (const line of text.split('\n')) out.appendLine(`    ${line}`);
    for (const note of outcome.notes) out.appendLine(`Note: ${note}`);
    rec.controller.postRecordLog(
      `The recorded steps were not inserted — ${reason}. They are in the TestBench output; "Copy steps" copies them.`,
      'error',
    );
    const message = {
      level: 'error' as const,
      text: plainNotificationText(
        `Record Steps: the recorded steps were not inserted — ${reason}. They are in the TestBench output.`,
      ),
      actions: [COPY_STEPS, SHOW_OUTPUT],
    };
    void this.notify(message.level, message.text, message.actions).then((choice) => {
      if (choice === COPY_STEPS) void vscode.env.clipboard.writeText(text);
      else if (choice === SHOW_OUTPUT) out.show(true);
    });
    this.lastReport = { status: 'error', messages: [message], rescued: text };
  }

  /** Show what went wrong and remember how it ended. */
  private finish(status: RecordingReport['status'], messages: RecordingReport['messages']): void {
    for (const m of messages) {
      m.text = plainNotificationText(m.text);
      void this.notify(m.level, m.text, m.actions);
    }
    this.lastReport = { status, messages };
  }

  /** Drop `rec` as the current recording, if it still is. */
  private release(rec: ActiveRecording): void {
    if (this.current !== rec) return;
    this.current = null;
    this.publish();
  }

  /** Panel, context key and status bar, from `current`. */
  private publish(): void {
    const state = this.current ? snapshotOf(this.current.state) : null;
    this.post({ type: 'recording', state });
    const recording = state !== null;
    if (recording !== this.lastContextValue) {
      this.lastContextValue = recording;
      void vscode.commands.executeCommand('setContext', 'testbench-native.recording', recording);
    }
    // Pause / Resume in the editor title bar and the palette.
    const paused = state !== null && state.paused === true && state.phase === 'recording';
    if (paused !== this.lastPausedValue) {
      this.lastPausedValue = paused;
      void vscode.commands.executeCommand('setContext', 'testbench-native.recordingPaused', paused);
    }
    if (!state) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text =
      state.phase === 'finishing'
        ? `$(loading~spin) ${recordingStatusText(state)}`
        : `${paused ? '❚❚' : '●'} ${recordingStatusText(state)}`;
    this.statusItem.tooltip = `Recording steps into ${state.file}. Click to show the TestBench panel.`;
    this.statusItem.show();
  }
}

/** A deep copy — the panel message and the test hook must not alias the
 *  live state the next frame mutates. */
function snapshotOf(state: RecordingPanelState): RecordingPanelState {
  return {
    ...state,
    actions: state.actions.map((a) => ({ ...a })),
    draft: state.draft
      ? {
          ...state.draft,
          steps: [...state.draft.steps],
          parameters: state.draft.parameters.map((p) => ({ ...p })),
          notes: [...state.draft.notes],
          ...(state.draft.authored && { authored: [...state.draft.authored] }),
          ...(state.draft.authoredIds && { authoredIds: [...state.draft.authoredIds] }),
        }
      : null,
  };
}

/**
 * A `$NAME` parameter reads `.env` at run time (decision 7). One the resolved
 * env does not define will fail the next Run, so say so now, while the author
 * still remembers what they typed.
 */
function missingEnvWarnings(
  outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
  added: string[],
): string[] {
  const out: string[] = [];
  const known = new Set(outcome.envKeys);
  for (const p of outcome.parameters) {
    const name = String(p?.name ?? '');
    if (!added.includes(name)) continue;
    const ref = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(p?.value ?? '').trim());
    if (ref && !known.has(ref[1]!)) {
      out.push(`{{${name}}} reads $${ref[1]} from .env, which does not set it yet. Add ${ref[1]}=… to .env before running.`);
    }
  }
  return out;
}

/**
 * Where a document at `key` goes when `oldUri` is renamed to `newUri` — the
 * file itself, or a folder it is in — or null when the rename is not about it.
 */
function renamedUri(key: string, oldUri: vscode.Uri, newUri: vscode.Uri): vscode.Uri | null {
  const from = oldUri.toString();
  if (key === from) return newUri;
  const prefix = from.endsWith('/') ? from : `${from}/`;
  if (!key.startsWith(prefix)) return null;
  const rest = decodeURIComponent(key.slice(prefix.length)).split('/');
  return vscode.Uri.joinPath(newUri, ...rest);
}

/** An editor showing `doc` now, if any — one in any visible editor group. */
function visibleEditorFor(doc: vscode.TextDocument): vscode.TextEditor | null {
  const key = doc.uri.toString();
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key) ?? null;
}
