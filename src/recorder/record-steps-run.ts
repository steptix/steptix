import path from 'node:path';
import type { ChatMessage } from '../ai/types.js';
import type { BrowserSession } from '../browser/manager.js';
import { addLogCallback, logger, shouldEmit } from '../utils/logger.js';
import { isSecretName, RECORD_SECRET_MIN_LENGTH, redact } from '../utils/secrets.js';
import {
  secretSpellings,
  StepRecorder,
  type KnownSecret,
  type StepRecorderOptions,
  type ToolbarCommand,
} from './step-recorder.js';
import { summarizeTargetFile, type TargetFileSummary } from './target-file.js';
import type {
  RecordControl,
  RecordControlOutcome,
  RecordEventListener,
  RecordStepSource,
  RecordStepsRequest,
  RecordedAction,
  ToolbarDock,
} from './types.js';
import { DraftEngine, type StepChange } from './draft-engine.js';
import { envReferenceFor } from './write-steps.js';

/**
 * One recording, from `POST /sessions/:id/record-steps` to its `done` frame
 * (stories/steptix-record-steps.md, "On the wire").
 *
 * The session manager decides whether a recording may start and what it holds
 * while it runs (the queue, the in-flight count, the session's one recording
 * slot); this class owns what happens inside it: getting a browser, the
 * recorder, the live frames, the live draft (./draft-engine.ts), Stop → the
 * final draft → the result, and handing everything back on every way out.
 */

/** Test-only knobs: the recorder's, and the draft engine's settle window. */
export type RecordStepsTestKnobs = Partial<
  Pick<
    StepRecorderOptions,
    'typedNavigationWindowMs' | 'historyCausedWindowMs' | 'tap' | 'maxCrops' | 'checkInMs' | 'endShowMs'
  >
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

/** How long the toolbar's confirmations stay (stories/steptix-record-toolbar.md). */
const ADDED_NOTICE_MS = 4_000;
const REMOVED_NOTICE_MS = 8_000;
const NOTHING_TO_UNDO_MS = 3_000;

/** At most this many steps go to the toolbar's drawer. */
const MAX_TOOLBAR_STEPS = 500;

/**
 * The lines of a step the author wrote, each one step: exactly as typed, bar a
 * leading number (`8.`) or list marker, which the recording's numbering
 * replaces, and the whitespace at the ends. A blank line adds nothing — nor
 * does a lone number or marker (`3.`, `-`): the number is the recording's, so
 * nothing of the author's is left (review round 2, finding 10). An edit to one
 * is therefore not an edit (delete the step instead), and an Add step of one
 * adds nothing.
 */
export function authorStepLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(/^(?:\d+[.)]|[-*+])(?:\s+|$)/, '').trim())
    .filter((line) => line !== '');
}

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The lines of a step the author wrote, with every secret the recording knows
 * written as a typed one is (decision 7; review, finding 5): the value — in
 * each spelling the recording masks — becomes `{{name}}`, the parameter the
 * secret came from, and a parameter `name: $NAME` reads it from the project's
 * `.env` (the `P4` rule's name, {@link envReferenceFor}) unless the file
 * already has a parameter of that name, which already says where it comes
 * from. A secret with no usable name cannot be written that way: `unnamed`,
 * and the caller refuses the step rather than send the value anywhere.
 */
export function authorStepSecrets(
  lines: readonly string[],
  known: readonly KnownSecret[],
  fileParameters: ReadonlyArray<{ name: string }>,
): { lines: string[]; parameters: Array<{ name: string; value: string }>; names: string[]; unnamed: boolean } {
  const nameOf = new Map<string, string | null>();
  for (const s of known) {
    if (s.value === '') continue;
    for (const spelling of secretSpellings([s.value])) if (!nameOf.has(spelling)) nameOf.set(spelling, s.name);
  }
  if (nameOf.size === 0) return { lines: [...lines], parameters: [], names: [], unnamed: false };
  // One pass, longest spelling first: a secret that holds another is
  // replaced whole, and nothing written in its place is looked at again.
  const pattern = new RegExp(
    [...nameOf.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
    'g',
  );
  const names: string[] = [];
  let unnamed = false;
  const out = lines.map((line) =>
    line.replace(pattern, (hit) => {
      const name = nameOf.get(hit) ?? null;
      if (name === null || !PARAMETER_NAME.test(name)) {
        unnamed = true;
        return hit;
      }
      if (!names.includes(name)) names.push(name);
      return `{{${name}}}`;
    }),
  );
  const existing = new Set(fileParameters.map((p) => p.name));
  const parameters = names.filter((n) => !existing.has(n)).map((name) => ({ name, value: envReferenceFor(name) }));
  return { lines: out, parameters, names, unnamed };
}

/** The toolbar's status line while it shows something other than the last step. */
interface ToolbarNotice {
  kind: 'adding' | 'added' | 'removed' | 'error' | 'info';
  text: string;
  seq: number;
  /** Date.now() when it stops showing; undefined: until replaced. */
  until?: number;
  restore?: boolean;
  /** Something the author did after Stop that was not carried out: it stays
   *  through "Writing the steps…". */
  late?: boolean;
}

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
  /** Where a Cancel came from — the browser's toolbar ends with `done`
   *  `cancelledBy: 'browser'`; the toolbar says which it was. */
  private cancelSource: 'browser' | 'control' | 'stream' | null = null;
  /** The stream's emit, once `run` has it. */
  private out: RecordEventListener = () => {};

  // The browser toolbar (stories/steptix-record-toolbar.md).
  private readonly toolbarEnabled: boolean;
  private dock: ToolbarDock;
  private minimised: boolean;
  private toolbarPhase: 'recording' | 'writing' | 'done' | 'ended' = 'recording';
  private endKind: 'done' | 'nothing' | 'cancelled' | 'ended' | null = null;
  private endText = '';
  private notice: ToolbarNotice | null = null;
  private noticeSeq = 0;
  private boxText = '';
  private draftView: { steps: string[]; ids: string[]; authored: number[]; edited: number[]; revision: number } = {
    steps: [],
    ids: [],
    authored: [],
    edited: [],
    revision: 0,
  };
  /**
   * Steps deleted since the last step landed, for the drawer: struck through
   * where they were, with Restore (stories/steptix-record-edit-steps.md,
   * "The drawer"). From any source — the drawer, the panel, the file, Undo.
   */
  private deletedRows: Array<{ id: string; text: string; afterId: string | null }> = [];
  /** The draft's ids right after the last delete or restore: a draft with an
   *  id not among them is the next step landing, and the rows go. */
  private idsAtDelete: Set<string> | null = null;
  private deletePending = false;
  private updating = false;
  /** What the toolbar's Undo took out, most recent last — Restore's list. */
  private readonly undoStack: string[] = [];
  /** Reworded steps the author has been told stay when the panel dropped
   *  the last action behind them: said once each. */
  private readonly toldStays = new Set<string>();
  /** Add step, Undo and Restore, one at a time and in order. */
  private ops: Promise<void> = Promise.resolve();
  /** Resolved once the recording is up (or will never be): an Add step that
   *  arrived while the browser was coming up waits for it. */
  private markReady: () => void = () => {};
  private readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve;
  });
  /** The file the steps go into, as the prompt is told about it. */
  private readonly file: TargetFileSummary;
  /** Every secret this recording knows, by name — read fresh per use. */
  private readonly namedSecrets: () => KnownSecret[];
  /** …and every spelling of each one, for masking. */
  private readonly secretValues: () => string[];
  /** Steps typed in the browser's box after Stop, not added: the end says so. */
  private lateSteps = 0;

  constructor(private readonly deps: RecordStepsRunDeps) {
    this.ended = new Promise<EndReason>((resolve) => {
      this.resolveEnd = resolve;
    });
    const prefs = deps.request.toolbar;
    this.toolbarEnabled = prefs?.enabled !== false;
    this.dock = prefs?.dock ?? 'bc';
    this.minimised = prefs?.minimised === true;
    const { target } = deps.request;
    const file = summarizeTargetFile(target.fileText, target.mode, target.cursorLine);
    this.file = file;
    // Known from the first action: what the session holds, the file's own
    // secret-named literals, and what the request's `.env` says — its
    // secret-named keys, and whatever a `$VAR` parameter of the file will
    // resolve to (review, finding 7). Known from the constructor on, so an
    // Add step that arrives before the browser is up is held to them too.
    const fromEnv = envSecrets(file, deps.request.env);
    this.namedSecrets = () => [...this.safeKnownSecrets(), ...fileSecrets(file), ...fromEnv];
    // Every spelling — as typed, JSON-escaped, URL-encoded — for everything
    // this run masks: the frames, the prompt, the log lines.
    this.secretValues = () => secretSpellings(this.namedSecrets().map((s) => s.value));
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

  /**
   * A run is starting on this session: the ended recording's bar (Done,
   * cancelled, ended — shown six seconds) leaves every page now, before the
   * run's first step. Its clicks must not land on it, and its screenshots
   * must not show it (review, finding 6). Nothing while recording.
   */
  async dismissToolbar(): Promise<void> {
    await this.recorder?.dismissToolbar().catch(() => undefined);
  }

  /** The `done` frame of an abandoned recording — and the toolbar's last word. */
  private abortedFrame(): { type: 'done'; status: 'aborted'; error?: string; cancelledBy?: 'browser' } {
    if (this.abortCause === 'session-closed') {
      this.endWith('ended', 'Recording ended: the session was closed while recording. Nothing was written.');
      return { type: 'done', status: 'aborted', error: RECORD_STEPS_SESSION_CLOSED_MESSAGE };
    }
    if (this.cancelSource === 'browser') {
      this.endWith('cancelled', 'Recording cancelled. Nothing was written.');
      return { type: 'done', status: 'aborted', cancelledBy: 'browser' };
    }
    this.endWith(
      'ended',
      this.cancelSource === 'stream'
        ? 'Recording ended: Steptix closed the recording. Nothing was written.'
        : 'Recording ended: it was cancelled in VS Code. Nothing was written.',
    );
    return { type: 'done', status: 'aborted' };
  }

  // ── The browser toolbar ────────────────────────────────────────────────

  /** What the page's toolbar shows. Everything in it is text the panel
   *  already shows, so it is already masked — and masked again here. */
  private toolbarView(): Record<string, unknown> {
    const secrets = this.secretValues();
    const now = Date.now();
    const notice = this.notice && (this.notice.until === undefined || now < this.notice.until) ? this.notice : null;
    const authored = new Set(this.draftView.authored);
    const edited = new Set(this.draftView.edited);
    // No lock: "locked" is the engine's word for what the MODEL may not
    // rewrite, and nothing is locked against the author
    // (stories/steptix-record-edit-steps.md, decision 1). `yours`: a step
    // the author wrote, or one they reworded.
    const steps = this.draftView.steps.slice(0, MAX_TOOLBAR_STEPS).map((text, i) => ({
      id: this.draftView.ids[i] ?? '',
      text: redact(text, secrets),
      yours: authored.has(i) || edited.has(i),
      ...(edited.has(i) && { edited: true }),
    }));
    return {
      phase: this.toolbarPhase,
      actions: this.engine?.actionCount ?? 0,
      steps,
      revision: this.draftView.revision,
      deleted: this.deletedRows.slice(-MAX_TOOLBAR_STEPS).map((r) => ({
        id: r.id,
        text: redact(r.text, secrets),
        afterId: r.afterId,
      })),
      updating: this.updating,
      dock: this.dock,
      minimised: this.minimised,
      boxText: this.boxText,
      ...(notice && {
        notice: {
          kind: notice.kind,
          text: redact(notice.text, secrets),
          seq: notice.seq,
          ...(notice.until !== undefined && { remainingMs: Math.max(0, notice.until - now) }),
          ...(notice.restore === true && { restore: true }),
        },
      }),
      ...(this.endKind && { endKind: this.endKind, endText: redact(this.endText, secrets) }),
    };
  }

  private pushView(): void {
    if (this.toolbarEnabled) this.recorder?.setToolbar(this.toolbarView());
  }

  private setNotice(n: { kind: ToolbarNotice['kind']; text: string; ms?: number; restore?: boolean } | null): void {
    this.notice = n
      ? {
          kind: n.kind,
          text: n.text,
          seq: ++this.noticeSeq,
          ...(n.ms !== undefined && { until: Date.now() + n.ms }),
          ...(n.restore === true && { restore: true }),
        }
      : null;
    this.pushView();
  }

  /** The toolbar's last state: done, cancelled, or ended elsewhere. */
  private endWith(kind: 'done' | 'nothing' | 'cancelled' | 'ended', text: string): void {
    this.toolbarPhase = kind === 'ended' ? 'ended' : 'done';
    this.endKind = kind;
    // Written up: a step typed in the browser after Stop is not among them.
    const late = this.lateSteps;
    this.endText =
      (kind === 'done' || kind === 'nothing') && late > 0
        ? `${text.replace(/\.$/, '')} · ${late} step${late === 1 ? '' : 's'} typed after Stop ${late === 1 ? 'was' : 'were'} not added`
        : text;
    this.notice = null;
    this.updating = false;
    this.pushView();
  }

  /** Run toolbar work one piece at a time, in the order it was asked for. */
  private enqueueOp(work: () => Promise<void>): void {
    this.ops = this.ops.then(work).catch((err: unknown) => {
      logger.debug(`[record-steps] toolbar work failed: ${redact(messageOf(err), this.secretValues())}`);
    });
  }

  /** Stop has been received: the recording's content is settled. Whatever
   *  was accepted before it still runs to completion (`run`, "Stop"). */
  private get stopping(): boolean {
    return this.endReason !== null || this.phase === 'writing';
  }

  /**
   * Something the author did in the browser's toolbar after Stop — too late
   * to change the recording. Refused up front, as `control` answers
   * `stopping`, and said where the author is looking: the bar (through
   * "Writing the steps…"), and for a step, the panel and the end of the bar,
   * so the words they typed are not lost without a trace (review, finding 1).
   */
  private refuseLate(
    what: 'step' | 'undo' | 'restore' | 'pause' | 'resume' | 'check' | 'edit' | 'delete',
    text?: string,
  ): false {
    const said: Record<typeof what, string> = {
      step: 'Your step came after Stop, so it was not added.',
      undo: 'Undo came after Stop, so nothing was removed.',
      restore: 'Restore came after Stop, so nothing was put back.',
      pause: 'Stop came first: the steps are already being written.',
      resume: 'Stop came first: the steps are already being written.',
      check: 'Add check came after Stop, so no check was added.',
      edit: 'Your change came after Stop, so it was not made.',
      delete: 'Removing a step came after Stop, so nothing was removed.',
    };
    if (what === 'step' && text !== undefined) {
      this.lateSteps++;
      this.out({
        type: 'output',
        msg: redact(
          `A step typed in the browser after Stop was not added to the recording: "${text.trim()}". ` +
            'Add it to the test by hand.',
          this.secretValues(),
        ),
        kind: 'warn',
      });
    }
    if (what === 'edit' && text !== undefined) {
      // The author's words are not lost without a trace (as a late step's).
      this.out({
        type: 'output',
        msg: redact(
          `A change to a step made in the browser after Stop was not made: "${text.trim()}". ` +
            'Change the step in the test by hand.',
          this.secretValues(),
        ),
        kind: 'warn',
      });
    }
    this.notice = { kind: 'error', text: said[what], seq: ++this.noticeSeq, late: true };
    this.pushView();
    return false;
  }

  /** A command from the page's toolbar, its token already checked. Answers
   *  whether it was taken (the page takes back what it showed if not). */
  private onToolbar(command: ToolbarCommand): boolean {
    switch (command.kind) {
      case 'paused':
        this.afterPaused(command.paused, 'toolbar');
        return true;
      case 'late':
        return this.refuseLate(command.command);
      case 'undo':
        if (this.stopping) return this.refuseLate('undo');
        this.enqueueOp(() => this.undo());
        return true;
      case 'restore':
        if (this.stopping) return this.refuseLate('restore');
        this.enqueueOp(() => this.restoreLast());
        return true;
      case 'stop':
        return this.control({ action: 'stop' }) === 'accepted';
      case 'cancel':
        this.cancelSource ??= 'browser';
        return this.control({ action: 'cancel' }) === 'accepted';
      case 'minimise':
      case 'toggle-minimised':
        this.minimised = command.kind === 'minimise' ? command.minimised : !this.minimised;
        this.out({ type: 'record:toolbar', dock: this.dock, minimised: this.minimised });
        this.pushView();
        return true;
      case 'dock':
        this.dock = command.dock;
        this.out({ type: 'record:toolbar', dock: this.dock, minimised: this.minimised });
        this.pushView();
        return true;
      case 'step': {
        // The box is empty from the moment its step arrives: a push made
        // while the step is being added ("Adding…") must not hand the page
        // the sent text back, or reopening the box offers it again and Enter
        // adds it twice (review, finding 3).
        this.boxText = '';
        if (this.stopping) return this.refuseLate('step', command.text);
        const after = command.after;
        const outcome = this.addStep(command.text, 'toolbar', after?.index, after?.revision, after?.id);
        this.pushView();
        return outcome === 'accepted';
      }
      case 'edit-step': {
        if (this.stopping) return this.refuseLate('edit', command.text);
        const outcome = this.editStep(command.id, command.text, 'toolbar');
        if (outcome === 'accepted') {
          const now = this.engine?.describeStep(command.id);
          this.setNotice({
            kind: 'added',
            text: now ? `Changed step ${now.index + 1}` : 'Changed the step',
            ms: ADDED_NOTICE_MS,
          });
          return true;
        }
        this.setNotice({ kind: 'error', text: typeof outcome === 'object' ? outcome.ignored : 'The step was not changed.' });
        return false;
      }
      case 'delete-step': {
        if (this.stopping) return this.refuseLate('delete');
        const text = this.engine?.describeStep(command.id)?.text;
        const r = this.dropOrRestore(command.id, true, 'toolbar');
        if (r !== true) {
          if (typeof r === 'object') this.setNotice({ kind: 'error', text: r.ignored });
          return false;
        }
        this.removedNotice(command.id, text);
        return true;
      }
      case 'restore-step': {
        if (this.stopping) return this.refuseLate('restore');
        const r = this.dropOrRestore(command.id, false, 'toolbar');
        if (r !== true) {
          if (typeof r === 'object') this.setNotice({ kind: 'error', text: r.ignored });
          return false;
        }
        this.setNotice(null);
        return true;
      }
      case 'box-text':
        this.boxText = command.text;
        return true;
      case 'typing-hidden':
        return true;
    }
  }

  /** Pause or resume, from the toolbar or the panel. */
  private setPaused(paused: boolean, source: 'toolbar' | 'panel'): boolean {
    const recorder = this.recorder;
    if (!recorder) return false;
    const changed = paused ? recorder.pause() : recorder.resume();
    if (!changed) return false;
    this.afterPaused(paused, source);
    return true;
  }

  private afterPaused(paused: boolean, source: 'toolbar' | 'panel'): void {
    this.engine?.setPaused(paused);
    const atMs = this.recorder?.clockMs ?? 0;
    this.out({ type: 'record:paused', paused, atMs, source });
    logger.info(`Session "${this.deps.sessionId}": Record Steps ${paused ? 'paused' : 'resumed'} (${source})`);
    this.pushView();
  }

  /**
   * A step the author wrote — from the toolbar's box, the editor or the panel
   * (stories/steptix-record-toolbar.md, "Steps you write"). Typing still
   * open is collected first; the draft is brought up to date (the toolbar
   * says "Adding…" meanwhile); the lines go in exactly as written and lock
   * everything up to them. `record:step` goes out for each, before the draft
   * that holds them.
   */
  private addStep(
    text: string,
    source: RecordStepSource,
    afterStep?: number,
    revision?: number,
    afterId?: string,
  ): RecordControlOutcome {
    const typed = authorStepLines(text);
    if (typed.length === 0) return 'ignored';
    // A secret the recording knows goes in as `{{name}}`, never in clear
    // (review, finding 5). Not from the editor: that line is the author's own
    // text in the file, which the recording does not rewrite, and Steptix
    // knows it by the text it sent — so it is refused, saying what to write.
    const safe = authorStepSecrets(typed, this.namedSecrets(), this.file.parameters);
    const refs = safe.names.map((n) => `{{${n}}}`).join(', ');
    if (safe.unnamed || (source === 'editor' && safe.names.length > 0)) {
      const reason = safe.unnamed
        ? 'The step holds a secret value this recording knows, with no parameter name to write in its place, so it was not added.'
        : `The step holds the value of ${refs}, a secret this recording knows, so it was not added and the line stays yours. ` +
          `Write ${refs} in its place to add it.`;
      if (source === 'toolbar') this.setNotice({ kind: 'error', text: reason });
      return { ignored: reason };
    }
    const lines = safe.lines;
    this.enqueueOp(async () => {
      await this.ready;
      const engine = this.engine;
      const recorder = this.recorder;
      // Accepted before Stop, so carried out whether Stop has come since or
      // not: `run` waits for this work before it writes anything. Checking
      // for Stop here dropped a step that had been answered 202 (review,
      // finding 1). Only Cancel — nothing is written then — abandons it.
      if (!engine || !recorder || this.cancelled()) return;
      await recorder.flushTyping();
      if (this.cancelled()) return;
      const boundary = engine.recordedCount;
      const atMs = recorder.clockMs;
      const added = await engine.addAuthorSteps(lines, {
        source,
        boundary,
        atMs,
        afterStep,
        revision,
        afterId,
        parameters: safe.parameters,
        onCatchUp: () => this.setNotice({ kind: 'adding', text: 'Adding…' }),
        onJoined: (list) => {
          for (const a of list) {
            this.out({
              type: 'record:step',
              id: a.step.id,
              text: a.step.text,
              source,
              afterStep: a.index - 1,
              atMs,
            });
          }
        },
      });
      if (added.length === 0) return;
      const first = added[0]!.index + 1;
      const last = added[added.length - 1]!.index + 1;
      const where = first === last ? `Added as step ${first}` : `Added as steps ${first}–${last}`;
      // Nothing is locked against the author (stories/steptix-record-edit-steps.md,
      // decision 1), so the bar no longer says "steps 1–7 locked".
      this.setNotice({
        kind: 'added',
        text: where + (refs ? ` · the secret is written as ${refs}` : ''),
        ms: ADDED_NOTICE_MS,
      });
      logger.info(
        `Session "${this.deps.sessionId}": Record Steps — ${added.length} step(s) written by the author (${source}) ` +
          `joined at step ${first}`,
      );
    });
    return 'accepted';
  }

  /**
   * The author reworded a step (stories/steptix-record-edit-steps.md) — from
   * the drawer, the file or the panel. One line, exactly as written bar a
   * leading number or list marker. A secret the recording knows is written as
   * `{{name}}`, as in a step the author adds; from the editor it is refused
   * instead, with what to write in its place — that line is the author's own
   * text, which the recording does not rewrite.
   *
   * Carried out at once, not queued behind an Add step's catch-up: an edit
   * needs no model call, so whether it applies is known when it arrives, and
   * the answer says so. Before Stop it is therefore always complete by the
   * time Stop writes the steps; after Stop `control` refuses it up front.
   */
  private editStep(id: string, text: string, source: RecordStepSource): RecordControlOutcome {
    const lines = authorStepLines(text);
    if (lines.length === 0) {
      return { ignored: 'An empty step is not a change: delete the step instead.' };
    }
    if (lines.length > 1) {
      return { ignored: 'A change is one line: add the other lines as steps of their own.' };
    }
    const safe = authorStepSecrets(lines, this.namedSecrets(), this.file.parameters);
    const refs = safe.names.map((n) => `{{${n}}}`).join(', ');
    if (safe.unnamed || (source === 'editor' && safe.names.length > 0)) {
      return {
        ignored: safe.unnamed
          ? 'The change holds a secret value this recording knows, with no parameter name to write in its place, so it was not made.'
          : `The change holds the value of ${refs}, a secret this recording knows, so it was not made and the line ` +
            `stays as you typed it. Write ${refs} in its place to make it.`,
      };
    }
    const engine = this.engine;
    if (!engine) return { ignored: 'The recording is still starting: it has no steps to change yet.' };
    const r = engine.editStep(id, safe.lines[0]!, { source, parameters: safe.parameters });
    if (r !== true) return r === false ? 'ignored' : r;
    logger.info(`Session "${this.deps.sessionId}": Record Steps — step ${id} reworded by the author (${source})`);
    return 'accepted';
  }

  /**
   * Drop or restore by id — an action, a step the author wrote, a step of the
   * draft. A step of the draft's frame is the engine's (before the draft
   * without it). An action's or an author step's is said here, after it, when
   * it came from the toolbar — as Undo always has; the panel's own are not
   * echoed.
   */
  private dropOrRestore(id: string, dropped: boolean, source: RecordStepSource): StepChange {
    const engine = this.engine;
    if (!engine) return false;
    const kind = engine.kindOf(id);
    const r = dropped ? engine.drop(id, source) : engine.restore(id, source);
    if (r === true && source === 'toolbar' && (kind === 'action' || kind === 'author')) {
      this.out({ type: 'record:dropped', id, dropped, source: 'toolbar' });
    }
    return r;
  }

  /** "Removed …" with Restore on the bar — which puts back the last thing
   *  taken out (the toolbar's Restore). */
  private removedNotice(id: string, text: string | undefined): void {
    this.undoStack.push(id);
    this.setNotice({
      kind: 'removed',
      text: text !== undefined ? `Removed "${text}"` : 'Removed the step',
      ms: REMOVED_NOTICE_MS,
      restore: true,
    });
  }

  /** A step came and went in the draft: the drawer's struck-through rows. */
  private onStepDropped(change: { id: string; text: string; afterId: string | null; dropped: boolean }): void {
    this.deletedRows = this.deletedRows.filter((r) => r.id !== change.id);
    if (change.dropped) this.deletedRows.push({ id: change.id, text: change.text, afterId: change.afterId });
    this.deletePending = true;
  }

  /** The toolbar's Undo: take out the most recent entry still in — an
   *  action, a check or a step of the author's — as the panel's ✕ does.
   *  Accepted before Stop, it is carried out after it too (finding 1).
   *
   *  The last entry a step the author REWORDED stands for goes with that
   *  step: one Undo is the action and its step, deleted as the drawer's ✕
   *  deletes it, and Restore brings both back (review round 2, finding 6).
   *  Left in, the reworded step described an action that was gone, and was
   *  written. */
  private async undo(): Promise<void> {
    const engine = this.engine;
    const recorder = this.recorder;
    if (!engine || !recorder || this.cancelled()) return;
    await recorder.flushTyping();
    const entry = engine.latestLiveEntry();
    if (!entry) {
      this.setNotice({ kind: 'info', text: 'Nothing to undo.', ms: NOTHING_TO_UNDO_MS });
      return;
    }
    const step = entry.kind === 'action' ? engine.editedStepLeftBy(entry.id) : null;
    if (step) {
      if (this.dropOrRestore(step.id, true, 'toolbar') !== true) return;
      this.undoStack.push(step.id);
      this.setNotice({
        kind: 'removed',
        text: `Removed: ${entry.summary} and your step "${step.text}"`,
        ms: REMOVED_NOTICE_MS,
        restore: true,
      });
      return;
    }
    if (this.dropOrRestore(entry.id, true, 'toolbar') !== true) return;
    this.undoStack.push(entry.id);
    this.setNotice({
      kind: 'removed',
      text: entry.kind === 'author' ? `Removed your step: ${entry.summary}` : `Removed: ${entry.summary}`,
      ms: REMOVED_NOTICE_MS,
      restore: true,
    });
  }

  /** The toolbar's Restore: put back the last thing its Undo took out (one
   *  the panel restored meanwhile is passed over). */
  private async restoreLast(): Promise<void> {
    const engine = this.engine;
    if (!engine || this.cancelled()) return;
    while (this.undoStack.length > 0) {
      const id = this.undoStack.pop()!;
      const r = this.dropOrRestore(id, false, 'toolbar');
      if (r === false) continue;
      // A deleted step some of whose actions came back on their own since.
      if (r !== true) this.setNotice({ kind: 'error', text: r.ignored });
      else this.setNotice(null);
      return;
    }
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
    this.markReady();
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
        this.cancelSource ??= 'control';
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
        this.cancelSource ??= 'control';
        this.abortRun('cancel');
        return 'accepted';
      case 'drop':
      case 'restore': {
        const dropping = control.action === 'drop';
        const kind = this.engine?.kindOf(control.id);
        const text = kind === 'step' ? this.engine?.describeStep(control.id)?.text : undefined;
        // The panel's ✕ on the last action a reworded step stands for: the
        // step stays (the author's words are never lost) — said once
        // (review round 2, finding 6).
        const left = dropping && kind === 'action' ? this.engine?.editedStepLeftBy(control.id) : null;
        const r = this.dropOrRestore(control.id, dropping, control.source ?? 'panel');
        if (r === true) {
          // A step of the draft deleted from the panel or the file: the bar
          // says so too, with Restore (stories/steptix-record-edit-steps.md, "Delete").
          if (kind === 'step' && dropping) this.removedNotice(control.id, text);
          else if (kind === 'step') this.setNotice(null);
          if (left && !this.toldStays.has(left.id)) {
            this.toldStays.add(left.id);
            this.out({
              type: 'output',
              msg: redact(`Your reworded step ${left.index + 1} stays — delete it if you meant to.`, this.secretValues()),
              kind: 'info',
            });
          }
          return 'accepted';
        }
        return r === false ? 'ignored' : r;
      }
      case 'edit-step':
        return this.editStep(control.id, control.text, control.source);
      case 'check':
      case 'cancel-check': {
        const arm = control.action === 'check';
        if (!this.recorder) {
          this.pendingPick = arm;
          return 'accepted';
        }
        if (arm) return this.recorder.armPick() ? 'accepted' : 'ignored';
        this.recorder.cancelPick();
        return 'accepted';
      }
      case 'pause':
      case 'resume':
        return this.setPaused(control.action === 'pause', 'panel') ? 'accepted' : 'ignored';
      case 'add-step':
        return this.addStep(control.text, control.source, control.afterStep, control.revision);
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
    this.out = emit;
    // Closing the stream is `cancel` (On the wire).
    const onClientGone = (): void => {
      this.cancelSource ??= 'stream';
      this.abortRun('cancel');
    };
    if (signal.aborted) onClientGone();
    signal.addEventListener('abort', onClientGone, { once: true });

    const file = this.file;
    const secrets = this.namedSecrets;
    const secretValues = this.secretValues;

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
      // The draft's frames go out as they are, and the toolbar follows them:
      // its "updating…", its last step and its drawer.
      const engineEmit: RecordEventListener = (event) => {
        if (event.type === 'record:drafting') {
          this.updating = event.busy;
          this.pushView();
        } else if (event.type === 'record:draft') {
          this.draftView = {
            steps: [...event.steps],
            ids: [...event.ids],
            authored: [...event.authored],
            edited: [...event.edited],
            revision: event.revision,
          };
          // The drawer's struck rows stay "until the next step lands": a
          // draft with a step no draft since the delete had.
          if (this.deletePending) {
            this.idsAtDelete = new Set(event.ids);
            this.deletePending = false;
          } else if (this.idsAtDelete && event.ids.some((id) => !this.idsAtDelete!.has(id))) {
            this.deletedRows = [];
            this.idsAtDelete = null;
          }
          if (this.notice?.kind === 'error') this.notice = null;
          this.pushView();
        }
        emit(event);
      };
      const engine = new DraftEngine({
        file,
        sendImages: prepared.sendScreenshots,
        secrets: secretValues,
        complete: (messages, s) => this.deps.complete(messages, s),
        emit: engineEmit,
        onCallFailed: () =>
          this.setNotice({ kind: 'error', text: "Couldn't update the steps. They'll catch up with your next action." }),
        onStepDropped: (change) => this.onStepDropped(change),
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
          this.pushView();
        },
        onPick: (armed) => {
          emit({ type: 'record:pick', armed });
          this.pushView();
        },
        onGone: () => this.settle({ kind: 'gone' }),
        onWarning: (msg) => emit({ type: 'output', msg, kind: 'warn' }),
        toolbar: this.toolbarEnabled ? this.toolbarView() : null,
        onToolbar: (command) => this.onToolbar(command),
        isStopping: () => this.stopping,
        ...recorderKnobs,
      });
      this.recorder = recorder;
      const started = await recorder.start();
      this.phase = 'recording';
      this.markReady();
      logger.info(
        // The address can carry a token (`?token=…`): masked like everything
        // else this recording says (review 2, finding 10).
        `Session "${sessionId}": Record Steps started on ${redact(started.url, secretValues())}` +
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

      // Stop: nothing new is scheduled; every Add step, Undo and Restore
      // accepted before it — one waiting behind another's catch-up included
      // — finishes first (anything that arrives from now on is refused up
      // front: `control` answers `stopping`, the toolbar `refuseLate`); a
      // field still being typed into is collected (its action frame goes out
      // now, before record:writing); the Stop's own `dropped` joins the live
      // drops.
      engine.close();
      await this.ops;
      this.toolbarPhase = 'writing';
      // A confirmation is over; a "came after Stop" stays through Writing.
      if (!this.notice?.late) this.notice = null;
      this.pushView();
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

      // A step the author reworded is kept even when every action behind it
      // was dropped since: their words are never lost.
      if (engine.remainingCount === 0 && engine.authorCount === 0 && engine.editedCount === 0) {
        engine.abandon();
        this.endWith('nothing', 'Nothing was recorded, so no steps were written.');
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
      const written = answer.steps.length;
      this.endWith(
        written > 0 ? 'done' : 'nothing',
        written > 0
          ? `Done · ${written} step${written === 1 ? '' : 's'} written to ${path.basename(request.testFilePath)}`
          : 'Nothing was recorded, so no steps were written.',
      );
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
      this.endWith('ended', `Recording ended: ${message.charAt(0).toLowerCase()}${message.slice(1)}`);
      emit({ type: 'output', msg: message, kind: 'error' });
      emit({ type: 'done', status: 'error', error: message });
      // Info, not warn: the log bridge above would echo a warning back onto
      // this stream as a second copy of the frame just sent.
      logger.info(`Session "${sessionId}": ${message}`);
    } finally {
      signal.removeEventListener('abort', onClientGone);
      this.markReady();
      removeLogBridge();
      this.phase = 'done';
      this.engine?.abandon();
      try {
        await this.recorder?.cancel();
      } catch {
        // The browser may be gone; there is nothing left to switch off.
      }
      // The session is free when `done` has gone out — before the page is
      // told anything more.
      this.deps.finish();
      // The toolbar's last word — Done, cancelled, or why it ended — then it
      // leaves the page on its own. Never over a recording that started since.
      if (this.toolbarEnabled && this.endKind) {
        await this.recorder?.flushToolbar().catch(() => undefined);
      }
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
 * Secrets the request's `.env` carries (Steptix sends the file's resolved
 * `.env` with the recording): every secret-named key's value, and the value
 * each `$VAR` parameter of the target file will resolve to — the request's
 * `.env` first, then the server's environment, as a run resolves it. A
 * parameter whose value is `$VAR` is named in the step as that parameter, so
 * the parameter's name is what a secret typed from it is reported as.
 *
 * Not every value under a secret-SOUNDING name is a secret. `.env` files are
 * full of settings the name rule catches by a word — `TOKEN_TTL_MINUTES=30`,
 * `ENABLE_PASSWORD_RESET=true`, `MAX_TOKENS=2048` — and a known secret is
 * masked out of everything as a substring: "1300" typed into an Amount field
 * was recorded as "1***0", "true story" as "*** story", and a typed "30"
 * became `{{TOKEN_TTL_MINUTES}}` (review 2, finding 2). So a value known
 * only because a VARIABLE's name sounds secret is known only when it could be
 * a credential ({@link couldBeCredential}): {@link RECORD_SECRET_MIN_LENGTH}
 * characters or more — the floor the runner already applies to page-derived
 * secrets (a run's own `.env` masking has none, but it masks the run's output,
 * not what the author typed) — and not a boolean or a number.
 *
 * A `$VAR` parameter whose own name is secret-sounding (`- password:
 * $LOGIN_PW`) is exempt: the author named that parameter a password, which is
 * the deliberate instruction the runner's rule never puts a floor under — a
 * numeric password is still a password. So are the file's secret-named
 * literals and the session's secret-named variables, which do not come
 * through here.
 */
export function envSecrets(file: TargetFileSummary, env: Record<string, string> | undefined): KnownSecret[] {
  const out: KnownSecret[] = [];
  for (const p of file.parameters) {
    const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(p.value.trim());
    if (!ref) continue;
    const name = ref[1]!;
    const value = env?.[name] ?? process.env[name];
    if (!value) continue;
    if (isSecretName(p.name) || (isSecretName(name) && couldBeCredential(value))) {
      out.push({ name: p.name, value });
    }
  }
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value && couldBeCredential(value) && isSecretName(name) && !out.some((s) => s.value === value)) {
      out.push({ name, value });
    }
  }
  return out;
}

/** A setting's value rather than a credential: a flag, or a number. */
const SETTING_VALUE = /^\s*(true|false|yes|no|on|off|null|none|undefined|[+-]?\d+(?:[.,]\d+)?)\s*$/i;

/**
 * Could this `.env` value be a credential? Long enough not to turn up by
 * chance inside ordinary text ({@link RECORD_SECRET_MIN_LENGTH}), and not a
 * boolean or a plain number — the values a TTL, a limit or a feature flag
 * holds.
 */
export function couldBeCredential(value: string): boolean {
  return value.length >= RECORD_SECRET_MIN_LENGTH && !SETTING_VALUE.test(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
