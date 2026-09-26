import type { ChatMessage } from '../ai/types.js';
import type { BrowserSession } from '../browser/manager.js';
import { addLogCallback, logger, shouldEmit } from '../utils/logger.js';
import { isSecretName, redact } from '../utils/secrets.js';
import { StepRecorder, type KnownSecret, type StepRecorderOptions } from './step-recorder.js';
import { summarizeTargetFile, type TargetFileSummary } from './target-file.js';
import type {
  RecordControl,
  RecordControlOutcome,
  RecordEventListener,
  RecordStepsRequest,
  RecordedAction,
} from './types.js';
import { writeRecordedSteps } from './write-steps.js';

/**
 * One recording, from `POST /sessions/:id/record-steps` to its `done` frame
 * (stories/testbench-record-steps.md, "On the wire").
 *
 * The session manager decides whether a recording may start and what it holds
 * while it runs (the queue, the in-flight count, the session's one recording
 * slot); this class owns what happens inside it: getting a browser, the
 * recorder, the live frames, Stop → the model → the result, and handing
 * everything back on every way out.
 */

/** Everything a recording needs from the session it belongs to. */
export interface RecordStepsRunDeps {
  sessionId: string;
  request: RecordStepsRequest;
  /**
   * A browser to record in — launched and sent to `baseUrl` when the session
   * has none, exactly as the first step of a run would — plus the settings the
   * recording reads from the project.
   */
  prepareBrowser(): Promise<{ browser: BrowserSession; sendScreenshots: boolean; launched: boolean }>;
  /** The session's model, with the run AI switch lifted for this call. */
  complete(messages: ChatMessage[], signal: AbortSignal): Promise<{ text: string }>;
  /** Secrets the session already knows (its parameters, its env). */
  knownSecrets(): KnownSecret[];
  /** Give back what beginning the recording took. Idempotent. */
  finish(): void;
  /** Tests only: recorder knobs (the typed-navigation window, a tap). */
  recorderOptions?: Partial<Pick<StepRecorderOptions, 'typedNavigationWindowMs' | 'tap' | 'maxCrops'>>;
}

type EndReason =
  | { kind: 'stop'; dropped: ReadonlySet<string> }
  | { kind: 'cancel' }
  | { kind: 'gone' };

type Phase = 'starting' | 'recording' | 'writing' | 'done';

export class RecordStepsRun {
  private phase: Phase = 'starting';
  private recorder: StepRecorder | null = null;
  private endReason: EndReason | null = null;
  private resolveEnd: ((reason: EndReason) => void) | null = null;
  private readonly ended: Promise<EndReason>;
  /** Add check asked for while the browser was still coming up. */
  private pendingPick: boolean | null = null;
  private readonly writeAbort = new AbortController();

  constructor(private readonly deps: RecordStepsRunDeps) {
    this.ended = new Promise<EndReason>((resolve) => {
      this.resolveEnd = resolve;
    });
  }

  /** Where this recording is — for the session's refusals and for tests. */
  get state(): Phase {
    return this.phase;
  }

  /** A method, not an inline test, because the answer changes across awaits
   *  and TypeScript would otherwise narrow it to what it was at the first. */
  private cancelled(): boolean {
    return this.endReason?.kind === 'cancel';
  }

  private settle(reason: EndReason): void {
    if (this.endReason) return;
    this.endReason = reason;
    this.resolveEnd?.(reason);
  }

  /**
   * Give everything back without running — for a route that took the slot and
   * then could not open its stream. A no-op once `run` has started, whose own
   * `finally` does the same.
   */
  abandon(): void {
    if (this.started) return;
    this.phase = 'done';
    this.deps.finish();
  }

  private started = false;

  /**
   * `POST /sessions/:id/record-steps/control`.
   *
   * While recording, every action is accepted. Once Stop has been received the
   * steps are being written: only `cancel` still means something (it abandons
   * the model call), and anything else answers `stopping`.
   */
  control(control: RecordControl): RecordControlOutcome {
    if (this.phase === 'done') return 'no-recording';
    if (this.phase === 'writing' || this.endReason) {
      if (control.action === 'cancel') {
        this.settle({ kind: 'cancel' });
        this.writeAbort.abort();
        return 'accepted';
      }
      return 'stopping';
    }
    switch (control.action) {
      case 'stop':
        this.settle({ kind: 'stop', dropped: new Set(control.dropped ?? []) });
        return 'accepted';
      case 'cancel':
        this.settle({ kind: 'cancel' });
        return 'accepted';
      case 'check':
      case 'cancel-check': {
        const arm = control.action === 'check';
        if (!this.recorder) {
          this.pendingPick = arm;
          return 'accepted';
        }
        if (arm) this.recorder.armPick();
        else this.recorder.cancelPick();
        return 'accepted';
      }
    }
  }

  /**
   * Run the recording to its end, emitting every frame on `emit`. Never throws:
   * whatever goes wrong becomes an `output` frame and `done: error`, and
   * `finish` runs on every path.
   */
  async run(emit: RecordEventListener, signal: AbortSignal): Promise<void> {
    this.started = true;
    const { sessionId, request } = this.deps;
    // Closing the stream is `cancel` (On the wire).
    const onClientGone = (): void => {
      this.settle({ kind: 'cancel' });
      this.writeAbort.abort();
    };
    if (signal.aborted) onClientGone();
    signal.addEventListener('abort', onClientGone, { once: true });

    // Warnings the server logs while this recording runs reach the author as
    // `output` frames, as a run's do. Warnings and errors only: an info line
    // from another session's run is noise in a recording's panel.
    const removeLogBridge = addLogCallback((level, message) => {
      if (level !== 'warn' && level !== 'error') return;
      if (!shouldEmit(level)) return;
      emit({ type: 'output', msg: message, kind: level });
    });

    const file = summarizeTargetFile(request.target.fileText, request.target.mode, request.target.cursorLine);
    const secrets = (): KnownSecret[] => [...this.safeKnownSecrets(), ...fileSecrets(file)];
    const secretValues = (): string[] => secrets().map((s) => s.value);

    try {
      // A client that left before the stream opened gets no browser launched
      // on its behalf.
      if (this.cancelled()) {
        emit({ type: 'done', status: 'aborted' });
        return;
      }
      let prepared: Awaited<ReturnType<RecordStepsRunDeps['prepareBrowser']>>;
      try {
        prepared = await this.deps.prepareBrowser();
      } catch (err) {
        // The project config, or the launch (and its baseUrl navigation).
        const message = `Record Steps could not start: ${messageOf(err)}`;
        emit({ type: 'output', msg: message, kind: 'error' });
        emit({ type: 'done', status: 'error', error: message });
        return;
      }
      if (this.cancelled()) {
        emit({ type: 'done', status: 'aborted' });
        return;
      }

      const recorder = new StepRecorder({
        browser: prepared.browser,
        sendScreenshots: prepared.sendScreenshots,
        knownSecrets: secrets,
        onAction: (a: RecordedAction) =>
          emit({
            type: 'record:action',
            id: a.id,
            kind: a.kind,
            summary: a.summary,
            atMs: a.atMs,
            ...(a.tab !== 'main' && { tab: a.tab }),
          }),
        onPick: (armed) => emit({ type: 'record:pick', armed }),
        onGone: () => this.settle({ kind: 'gone' }),
        onWarning: (msg) => emit({ type: 'output', msg, kind: 'warn' }),
        ...this.deps.recorderOptions,
      });
      this.recorder = recorder;
      const started = await recorder.start();
      this.phase = 'recording';
      logger.info(
        `Session "${sessionId}": Record Steps started on ${started.url}` +
          (prepared.launched ? ' (browser launched for it)' : '') +
          (prepared.sendScreenshots ? '' : ' — no screenshots (ai.sendScreenshots is off)'),
      );
      emit({
        type: 'record:started',
        url: redact(started.url, secretValues()),
        title: redact(started.title, secretValues()),
      });
      if (this.pendingPick !== null) {
        if (this.pendingPick) recorder.armPick();
        else recorder.cancelPick();
        this.pendingPick = null;
      }

      const reason = await this.ended;
      if (reason.kind === 'cancel') {
        await recorder.cancel();
        logger.info(`Session "${sessionId}": Record Steps cancelled — nothing written`);
        emit({ type: 'done', status: 'aborted' });
        return;
      }
      if (reason.kind === 'gone') {
        await recorder.cancel();
        const message = 'The browser was closed during the recording, so nothing was written.';
        emit({ type: 'output', msg: message, kind: 'error' });
        emit({ type: 'done', status: 'error', error: message });
        return;
      }

      const all = await recorder.stop();
      const kept = all.filter((a) => !reason.dropped.has(a.id));
      this.phase = 'writing';
      emit({ type: 'record:writing' });
      logger.info(
        `Session "${sessionId}": Record Steps stopped — ${all.length} action(s), ` +
          `${all.length - kept.length} dropped; writing the steps`,
      );

      if (kept.length === 0) {
        emit({
          type: 'record:result',
          steps: [],
          parameters: [],
          notes: ['Nothing was recorded (or every action was removed), so there are no steps to add.'],
        });
        emit({ type: 'done', status: 'passed' });
        return;
      }

      const writeSignal = AbortSignal.any([signal, this.writeAbort.signal]);
      const answer = await writeRecordedSteps({
        actions: kept,
        file,
        sendImages: prepared.sendScreenshots,
        secrets: secretValues(),
        complete: (messages, s) => this.deps.complete(messages, s),
        signal: writeSignal,
        warn: (msg) => emit({ type: 'output', msg, kind: 'warn' }),
      });
      if (this.cancelled()) {
        emit({ type: 'done', status: 'aborted' });
        return;
      }
      emit({
        type: 'record:result',
        steps: answer.steps,
        parameters: answer.parameters,
        ...(answer.notes.length > 0 && { notes: answer.notes }),
      });
      emit({ type: 'done', status: 'passed' });
    } catch (err) {
      if (this.cancelled()) {
        emit({ type: 'done', status: 'aborted' });
        return;
      }
      const reason = redact(messageOf(err), secretValues()).replace(/\.\s*$/, '');
      // SPEC-record-steps.md §10's sentence once Stop has been received — the
      // model's answer, or the call for it, failed; before that, the recording
      // itself did.
      const message =
        this.phase === 'writing'
          ? `The steps could not be written: ${reason}. Nothing was inserted.`
          : `Record Steps failed: ${reason}.`;
      emit({ type: 'output', msg: message, kind: 'error' });
      emit({ type: 'done', status: 'error', error: message });
      // Info, not warn: the log bridge above would echo a warning back onto
      // this stream as a second copy of the frame just sent.
      logger.info(`Session "${sessionId}": ${message}`);
    } finally {
      signal.removeEventListener('abort', onClientGone);
      removeLogBridge();
      this.phase = 'done';
      try {
        await this.recorder?.cancel();
      } catch {
        // The browser may be gone; there is nothing left to switch off.
      }
      this.deps.finish();
    }
  }

  private safeKnownSecrets(): KnownSecret[] {
    try {
      return this.deps.knownSecrets();
    } catch {
      return [];
    }
  }
}

/** The file's own secret-named parameters that hold a literal: their values
 *  are secrets too, whether or not a run ever loaded them. */
function fileSecrets(file: TargetFileSummary): KnownSecret[] {
  return file.parameters
    .filter((p) => isSecretName(p.name) && p.value !== '' && !p.value.trim().startsWith('$'))
    .map((p) => ({ name: p.name, value: p.value }));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
