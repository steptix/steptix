import * as vscode from 'vscode';
import * as path from 'node:path';
import type {
  HostToWebviewMsg,
  RecordingPanelState,
  RecordStepsEvent,
} from 'ai-ui-automation-runner-core';
import type { RecordStepsOutcome, RunController } from './run-controller.js';
import { getOutputChannel } from './output-channel.js';
import {
  applyRecordFrame,
  cleanStepText,
  newRecordingState,
  planRecordInsertion,
  plainNotificationText,
  recordedStepsText,
  recordingStatusText,
  trackAnchorThroughChanges,
  type RecordAnchor,
} from './record-steps-core.js';

/**
 * Record Steps, the TestBench half (stories/testbench-record-steps.md): one
 * recording at a time per window, its live state for the panel and the status
 * bar, the controls the author steers it with, and — when the result comes
 * back — the one edit that inserts it.
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
  /** Where the steps go, carried through every edit made to the document
   *  while recording (`trackAnchorThroughChanges`). */
  anchor: RecordAnchor | null;
  /** The listeners that carry `anchor`; disposed when the insertion is over. */
  watch: vscode.Disposable | null;
  state: RecordingPanelState;
  /** Stop has been sent; a second press waits for the result. */
  stopSent: boolean;
  /** The error lines the server already put in the log, so the closing
   *  error is not printed twice. */
  loggedErrors: string[];
}

const COPY_STEPS = 'Copy steps';
const SHOW_OUTPUT = 'Show output';

export class StepRecorder implements vscode.Disposable {
  private current: ActiveRecording | null = null;
  private readonly statusItem: vscode.StatusBarItem;
  private lastContextValue = false;

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
      // Tracked from here on: the line it names is the anchor line whatever
      // the author does to the text around it (or to it — a renumber).
      anchor: opts.anchor ? { ...opts.anchor, tracked: true } : null,
      watch: null,
      stopSent: false,
      loggedErrors: [],
      state: newRecordingState({
        uri: doc.uri.toString(),
        file: path.basename(doc.uri.fsPath),
        mode: opts.mode,
      }),
    };
    rec.watch = this.watchAnchor(rec, doc.uri);
    this.current = rec;
    this.publish();
    controller.postRecordLog(
      opts.mode === 'new'
        ? `● Recording a new test into ${rec.state.file} — use the app in the test's browser, then press Stop.`
        : `● Recording after line ${opts.cursorLine ?? '?'} of ${rec.state.file} — use the app in the test's browser, then press Stop.`,
      'info',
    );
    this.settled = this.run(rec, opts)
      .catch((err: unknown) => {
        this.finish('error', [{ level: 'error', text: `Record Steps failed: ${err instanceof Error ? err.message : String(err)}` }]);
      })
      .finally(() => {
        rec.watch?.dispose();
        rec.watch = null;
        this.release(rec);
      });
  }

  /**
   * Carry `rec.anchor` through the author's edits while recording — and
   * until the insertion is made — so the steps go after the line the author
   * chose even when lines were added above it, or it was renumbered. An edit
   * that deletes the line, or the document closing (its unsaved edits gone
   * with it), loses the track; the insertion then finds the line by its text.
   */
  private watchAnchor(rec: ActiveRecording, uri: vscode.Uri): vscode.Disposable | null {
    if (!rec.anchor) return null;
    const key = uri.toString();
    return vscode.Disposable.from(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!rec.anchor || e.document.uri.toString() !== key || e.contentChanges.length === 0) return;
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
      }),
      vscode.workspace.onDidCloseTextDocument((closed) => {
        if (rec.anchor && closed.uri.toString() === key) rec.anchor = { ...rec.anchor, tracked: false };
      }),
    );
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
    const dropped = rec.state.actions.filter((a) => a.dropped).map((a) => a.id);
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
    const sent = await rec.controller.controlRecording({
      action: rec.state.pickArmed ? 'cancel-check' : 'check',
    });
    if (!sent.ok) void this.notify('warn', `Record Steps: ${sent.error}`);
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
    const action = rec?.state.actions.find((a) => a.id === id);
    if (!rec || !action || action.dropped === dropped) return;
    if (rec.state.phase === 'finishing' || rec.stopSent) return;
    action.dropped = dropped;
    this.publish();
    const sent = await rec.controller.controlRecording({ action: dropped ? 'drop' : 'restore', id });
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

  dispose(): void {
    const rec = this.current;
    this.current = null;
    if (rec) {
      rec.watch?.dispose();
      rec.watch = null;
      void rec.controller.cancelRecording();
    }
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
      ...(opts.retryConflict && { retryConflict: true }),
    });
    // The recording is over, however it ended: take the block down before
    // touching the document.
    this.release(rec);
    if (outcome.status === 'cancelled') {
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
    // The block's state is folded by the pure core, where it is pinned.
    const changed = applyRecordFrame(rec.state, event as unknown as { type: string } & Record<string, unknown>);
    if (changed && this.current === rec) this.publish();
  }

  /**
   * The result, as ONE editor edit — one undo step (decision 11): the steps
   * after the anchor, the rest of that flow renumbered, and the parameters
   * the file lacks. Planned against the document as it is NOW, with the anchor
   * carried through the author's edits while recording.
   *
   * A result is never lost. One with no steps is said as the server's note,
   * not as an error; one that cannot be inserted — the plan refused, the edit
   * rejected three times, the file renamed or deleted — is written to the
   * TestBench output, and the error offers "Copy steps".
   */
  private async insert(
    rec: ActiveRecording,
    outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
  ): Promise<void> {
    if (outcome.steps.map(cleanStepText).every((s) => s === '')) {
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
    this.rescue(rec, outcome, failure);
  }

  /** The edit itself, or why it could not be made. */
  private async applyResult(
    rec: ActiveRecording,
    outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const uri = rec.controller.document.uri;
    const file = rec.state.file;
    const doc = rec.controller.document.isClosed
      ? await vscode.workspace.openTextDocument(uri)
      : rec.controller.document;
    const editor =
      vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ??
      (await vscode.window.showTextDocument(doc, { preview: false }));

    let plan: ReturnType<typeof planRecordInsertion> | undefined;
    let applied = false;
    // The edit is version-checked against the live buffer: a keystroke landing
    // between the plan and the apply rejects it whole. Plan again and retry.
    for (let attempt = 0; attempt < 3 && !applied; attempt++) {
      plan = planRecordInsertion(editor.document.getText(), {
        anchor: rec.state.mode === 'new' ? null : rec.anchor,
        steps: outcome.steps,
        parameters: outcome.parameters,
      });
      if ('error' in plan) return { ok: false, reason: plan.error };
      const edits = plan.edits;
      applied = await editor.edit(
        (builder) => {
          for (const e of edits) {
            builder.replace(new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar), e.text);
          }
        },
        { undoStopBefore: true, undoStopAfter: true },
      );
    }
    if (!applied || !plan || 'error' in plan) {
      return { ok: false, reason: `${file} kept changing while the steps were being inserted` };
    }

    const first = plan.insertedLines[0]!;
    const last = plan.insertedLines[plan.insertedLines.length - 1]!;
    const end = editor.document.lineAt(last - 1).text.length;
    editor.selection = new vscode.Selection(first - 1, 0, last - 1, end);
    editor.revealRange(new vscode.Range(first - 1, 0, last - 1, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

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
    if (!state) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text =
      state.phase === 'finishing'
        ? `$(loading~spin) ${recordingStatusText(state)}`
        : `● ${recordingStatusText(state)}`;
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
