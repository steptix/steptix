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
import { DraftEngine } from './draft-engine.js';

/**
 * One recording, from `POST /sessions/:id/record-steps` to its `done` frame
 * (stories/testbench-record-steps.md, "On the wire").
 *
 * The session manager decides whether a recording may start and what it holds
 * while it runs (the queue, the in-flight count, the session's one recording
 * slot); this class owns what happens inside it: getting a browser, the
 * recorder, the live frames, the live draft (./draft-engine.ts), Stop → the
 * final draft → the result, and handing everything back on every way out.
 */

/** Test-only knobs: the recorder's, and the draft engine's settle window. */
export type RecordStepsTestKnobs = Partial<
  Pick<StepRecorderOptions, 'typedNavigationWindowMs' | 'historyCausedWindowMs' | 'tap' | 'maxCrops'>
> & { draftSettleMs?: number };

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
  /** Tests only: recorder knobs (the typed-navigation window, a tap) and the
   *  draft engine's settle window. */
  recorderOptions?: RecordStepsTestKnobs;
}

type EndReason =
  | { kind: 'stop'; dropped: ReadonlySet<string> }
  | { kind: 'cancel' }
  | { kind: 'gone' };

/**
 * `done.error` when a recording ends because its session was closed (a
 * DELETE, another window's first-use DELETE, the idle reaper, shutdown). The
 * client shows it as the reason, word for word, so it is a contract.
 */
export const RECORD_STEPS_SESSION_CLOSED_MESSAGE = 'The session was closed while recording.';

/** Why a recording is being abandoned: the author's Cancel (or the stream
 *  closing), or its session going away. */
type AbortCause = 'cancel' | 'session-closed';

type Phase = 'starting' | 'recording' | 'writing' | 'done';

export class RecordStepsRun {
  private phase: Phase = 'starting';
  private recorder: StepRecorder | null = null;
  private endReason: EndReason | null = null;
  private resolveEnd: ((reason: EndReason) => void) | null = null;
  private readonly ended: Promise<EndReason>;
  /** Add check asked for while the browser was still coming up. */
  private pendingPick: boolean | null = null;
  /** The live draft — created once the browser is up, before the first action. */
  private engine: DraftEngine | null = null;
  /**
   * Set by Cancel (or the stream closing, or the session closing) at ANY point
   * before `record:result` goes out — including after Stop, while the final
   * draft is being written. Separate from {@link endReason}, which Stop has
   * already settled by then (review, finding 2).
   */
  private abortCause: AbortCause | null = null;
  /** `record:result` has gone out: nothing can take it back any more. */
  private resultSent = false;

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
    return this.abortCause !== null;
  }

  /**
   * Abandon the recording: end the wait for Stop if it is still going on,
   * abort the model call in flight, and make sure no further one is made. The
   * run's own path then ends with `done: aborted` and no result. A no-op once
   * the result is out, and the first cause wins.
   */
  private abortRun(cause: AbortCause): void {
    if (this.resultSent) return;
    this.abortCause ??= cause;
    this.settle({ kind: 'cancel' });
    this.engine?.abandon();
  }

  /**
   * The session this recording belongs to is closing (DELETE, the idle reaper,
   * shutdown). Same path as Cancel; the `done` frame says why.
   */
  sessionClosed(): void {
    this.abortRun('session-closed');
  }

  /** The `done` frame of an abandoned recording. */
  private abortedFrame(): { type: 'done'; status: 'aborted'; error?: string } {
    return this.abortCause === 'session-closed'
      ? { type: 'done', status: 'aborted', error: RECORD_STEPS_SESSION_CLOSED_MESSAGE }
      : { type: 'done', status: 'aborted' };
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
   * While recording, every action is accepted. `drop` / `restore` of an id
   * the recording does not have (or one already in that state) answers
   * `ignored`. Once Stop has been received the draft is being finished: only
   * `cancel` still means something — it wins until `record:result` is out:
   * the call in flight is aborted, no result is sent and `done` is
   * `aborted` — and anything else answers `stopping`.
   */
  control(control: RecordControl): RecordControlOutcome {
    if (this.phase === 'done' || this.resultSent) return 'no-recording';
    if (this.phase === 'writing' || this.endReason) {
      if (control.action === 'cancel') {
        this.abortRun('cancel');
        return 'accepted';
      }
      return 'stopping';
    }
    switch (control.action) {
      case 'stop':
        this.settle({ kind: 'stop', dropped: new Set(control.dropped ?? []) });
        return 'accepted';
      case 'cancel':
        this.abortRun('cancel');
        return 'accepted';
      case 'drop':
        return this.engine?.drop(control.id) ? 'accepted' : 'ignored';
      case 'restore':
        return this.engine?.restore(control.id) ? 'accepted' : 'ignored';
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
  async run(out: RecordEventListener, signal: AbortSignal): Promise<void> {
    this.started = true;
    const { sessionId, request } = this.deps;
    // `done` is the last frame, whatever is still settling behind it — a crop
    // being taken, a pick waiting in the recorder's chain, a warning logged
    // by another session (review, finding 10). The recorder drops its own
    // late work too; this is the one place that can promise it for every
    // source at once.
    let closed = false;
    const emit: RecordEventListener = (event) => {
      if (closed) return;
      if (event.type === 'done') closed = true;
      out(event);
    };
    // Closing the stream is `cancel` (On the wire).
    const onClientGone = (): void => {
      this.abortRun('cancel');
    };
    if (signal.aborted) onClientGone();
    signal.addEventListener('abort', onClientGone, { once: true });

    const file = summarizeTargetFile(request.target.fileText, request.target.mode, request.target.cursorLine);
    // Known from the first action: what the session holds, the file's own
    // secret-named literals, and what the request's `.env` says — its
    // secret-named keys, and whatever a `$VAR` parameter of the file will
    // resolve to (review, finding 7).
    const fromEnv = envSecrets(file, request.env);
    const secrets = (): KnownSecret[] => [...this.safeKnownSecrets(), ...fileSecrets(file), ...fromEnv];
    const secretValues = (): string[] => secrets().map((s) => s.value);

    // Warnings the server logs while this recording runs reach the author as
    // `output` frames, as a run's do. Warnings and errors only: an info line
    // from another session's run is noise in a recording's panel. The logger
    // fans out process-wide, so a line that names ANOTHER session is not this
    // recording's and is skipped, and every line forwarded is masked with this
    // recording's secrets — a line from code that does not say its session
    // still gets through, but not in clear (review, finding 15).
    const ownSession = `Session "${sessionId}"`;
    const removeLogBridge = addLogCallback((level, message) => {
      if (level !== 'warn' && level !== 'error') return;
      if (!shouldEmit(level)) return;
      if (/\bSession "[^"]*"/.test(message) && !message.includes(ownSession)) return;
      emit({ type: 'output', msg: redact(message, secretValues()), kind: level });
    });

    try {
      // A client that left before the stream opened gets no browser launched
      // on its behalf.
      if (this.cancelled()) {
        emit(this.abortedFrame());
        return;
      }
      let prepared: Awaited<ReturnType<RecordStepsRunDeps['prepareBrowser']>>;
      try {
        prepared = await this.deps.prepareBrowser();
      } catch (err) {
        if (this.cancelled()) {
          emit(this.abortedFrame());
          return;
        }
        // The project config, or the launch (and its baseUrl navigation).
        const message = `Record Steps could not start: ${messageOf(err)}`;
        emit({ type: 'output', msg: message, kind: 'error' });
        emit({ type: 'done', status: 'error', error: message });
        return;
      }
      if (this.cancelled()) {
        emit(this.abortedFrame());
        return;
      }

      const { draftSettleMs, ...recorderKnobs } = this.deps.recorderOptions ?? {};
      const engine = new DraftEngine({
        file,
        sendImages: prepared.sendScreenshots,
        secrets: secretValues,
        complete: (messages, s) => this.deps.complete(messages, s),
        emit,
        ...(draftSettleMs !== undefined && { settleMs: draftSettleMs }),
      });
      this.engine = engine;
      const recorder = new StepRecorder({
        browser: prepared.browser,
        sendScreenshots: prepared.sendScreenshots,
        knownSecrets: secrets,
        onAction: (a: RecordedAction) => {
          emit({
            type: 'record:action',
            id: a.id,
            kind: a.kind,
            summary: a.summary,
            atMs: a.atMs,
            ...(a.tab !== 'main' && { tab: a.tab }),
            action: a.action,
          });
          // After the frame, so the draft that covers it never arrives first.
          engine.addAction(a);
        },
        onPick: (armed) => emit({ type: 'record:pick', armed }),
        onGone: () => this.settle({ kind: 'gone' }),
        onWarning: (msg) => emit({ type: 'output', msg, kind: 'warn' }),
        ...recorderKnobs,
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
      if (reason.kind !== 'stop') engine.abandon();
      if (reason.kind === 'cancel') {
        await recorder.cancel();
        logger.info(`Session "${sessionId}": Record Steps cancelled — nothing written`);
        emit(this.abortedFrame());
        return;
      }
      if (reason.kind === 'gone') {
        await recorder.cancel();
        const message = 'The browser was closed during the recording, so nothing was written.';
        emit({ type: 'output', msg: message, kind: 'error' });
        emit({ type: 'done', status: 'error', error: message });
        return;
      }

      // Stop: nothing new is scheduled; a field still being typed into is
      // collected (its action frame goes out now, before record:writing); the
      // Stop's own `dropped` joins the live drops.
      engine.close();
      const all = await recorder.stop();
      if (this.cancelled()) {
        emit(this.abortedFrame());
        return;
      }
      engine.dropAll([...reason.dropped]);
      engine.silence();
      this.phase = 'writing';
      emit({ type: 'record:writing' });
      logger.info(
        `Session "${sessionId}": Record Steps stopped — ${all.length} action(s), ` +
          `${all.length - engine.remainingCount} dropped; finishing the draft`,
      );

      if (engine.remainingCount === 0) {
        engine.abandon();
        this.resultSent = true;
        emit({
          type: 'record:result',
          steps: [],
          parameters: [],
          notes: ['Nothing was recorded (or every action was removed), so there are no steps to add.'],
        });
        emit({ type: 'done', status: 'passed' });
        return;
      }

      // The call in flight finishes; one more only when the draft does not
      // cover every remaining action (§8). Its failure is thrown: nothing is
      // inserted.
      const answer = await engine.finish();
      // Cancel wins until the result is out — here it has not gone yet.
      if (this.cancelled()) {
        logger.info(`Session "${sessionId}": Record Steps cancelled while finishing — nothing written`);
        emit(this.abortedFrame());
        return;
      }
      this.resultSent = true;
      emit({
        type: 'record:result',
        steps: answer.steps,
        parameters: answer.parameters,
        ...(answer.notes.length > 0 && { notes: answer.notes }),
      });
      emit({ type: 'done', status: 'passed' });
    } catch (err) {
      if (this.cancelled()) {
        emit(this.abortedFrame());
        return;
      }
      this.engine?.abandon();
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
      this.engine?.abandon();
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

/**
 * Secrets the request's `.env` carries (TestBench sends the file's resolved
 * `.env` with the recording): every secret-named key's value, and the value
 * each `$VAR` parameter of the target file will resolve to — the request's
 * `.env` first, then the server's environment, as a run resolves it. A
 * parameter whose value is `$VAR` is named in the step as that parameter, so
 * the parameter's name is what a secret typed from it is reported as.
 */
export function envSecrets(file: TargetFileSummary, env: Record<string, string> | undefined): KnownSecret[] {
  const out: KnownSecret[] = [];
  for (const p of file.parameters) {
    const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(p.value.trim());
    if (!ref) continue;
    const name = ref[1]!;
    const value = env?.[name] ?? process.env[name];
    if (value && (isSecretName(p.name) || isSecretName(name))) out.push({ name: p.name, value });
  }
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value && isSecretName(name) && !out.some((s) => s.value === value)) out.push({ name, value });
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
