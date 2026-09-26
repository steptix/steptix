import * as vscode from 'vscode';
import * as path from 'node:path';
import type {
  HostToWebviewMsg,
  RecordingPanelState,
  RecordStepsEvent,
} from 'ai-ui-automation-runner-core';
import type { RecordStepsOutcome, RunController } from './run-controller.js';
import {
  applyRecordFrame,
  newRecordingState,
  planRecordInsertion,
  recordingStatusText,
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
  status: 'inserted' | 'cancelled' | 'error';
  /** Steps inserted, when `inserted`. */
  steps?: number;
  messages: Array<{ level: 'info' | 'warn' | 'error'; text: string }>;
}

interface ActiveRecording {
  controller: RunController;
  anchor: RecordAnchor | null;
  state: RecordingPanelState;
  /** Stop has been sent; a second press waits for the result. */
  stopSent: boolean;
  /** The error lines the server already put in the log, so the closing
   *  error is not printed twice. */
  loggedErrors: string[];
}

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
      anchor: opts.anchor,
      stopSent: false,
      loggedErrors: [],
      state: newRecordingState({
        uri: doc.uri.toString(),
        file: path.basename(doc.uri.fsPath),
        mode: opts.mode,
      }),
    };
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
      .finally(() => this.release(rec));
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
      void vscode.window.showErrorMessage(`Record Steps: could not stop the recording — ${sent.error}`);
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
    if (!sent.ok) void vscode.window.showWarningMessage(`Record Steps: ${sent.error}`);
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
    if (rec) void rec.controller.cancelRecording();
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
   * the file lacks. Planned against the document as it is NOW, which is why
   * the anchor carries its text: the author may have edited while recording.
   */
  private async insert(
    rec: ActiveRecording,
    outcome: Extract<RecordStepsOutcome, { status: 'result' }>,
  ): Promise<void> {
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
      if ('error' in plan) {
        rec.controller.postRecordLog(`Record Steps: ${plan.error}`, 'error');
        this.finish('error', [{ level: 'error', text: `Record Steps: ${plan.error}` }]);
        return;
      }
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
      const text = 'Record Steps: the steps were not inserted — the document kept changing. Record again.';
      this.finish('error', [{ level: 'error', text }]);
      return;
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
      if (m.level === 'warn') void vscode.window.showWarningMessage(`Record Steps: ${m.text}`);
      else void vscode.window.showInformationMessage(m.text);
    }
    this.lastReport = { status: 'inserted', steps: n, messages };
  }

  /** Show what went wrong and remember how it ended. */
  private finish(status: RecordingReport['status'], messages: RecordingReport['messages']): void {
    for (const m of messages) {
      if (m.level === 'error') void vscode.window.showErrorMessage(m.text);
      else if (m.level === 'warn') void vscode.window.showWarningMessage(m.text);
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
