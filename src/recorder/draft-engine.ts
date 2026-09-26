import { RECORD_DRAFT_REWRITE_LIMIT } from '../ai/prompts.js';
import type { ChatMessage } from '../ai/types.js';
import { logger } from '../utils/logger.js';
import { redact } from '../utils/secrets.js';
import type { TargetFileSummary } from './target-file.js';
import type { RecordEventListener, RecordedAction } from './types.js';
import {
  askForDraft,
  draftStateNotes,
  settleParameters,
  type DraftAnswer,
  type RecordStepsAnswer,
} from './write-steps.js';

/**
 * Live drafting (stories/testbench-record-steps.md, decision 9;
 * docs/specs/SPEC-record-steps.md §8, §9.2).
 *
 * The recording's steps are written WHILE the author works: each action goes
 * to the model shortly after it happens, with the draft so far, and the model
 * answers the draft's new tail. This class decides when a call happens, what
 * it covers, and what its answer does to the draft — and holds the one rule
 * the whole design leans on: **never two draft calls at once for one
 * recording**. Every call goes through {@link runCall}, which refuses to start
 * while another is in flight; actions that arrive meanwhile wait for the next.
 *
 * The draft is the steps, their parameters, and the set of action ids it
 * COVERS. Incremental calls always cover every uncovered remaining action, in
 * order, so what is covered is always a prefix of the remaining actions — and
 * `through`, the last covered id, says where the draft has got to.
 */

/** How long after the last action a draft call waits, so a quick burst of
 *  actions goes in one call (§8, "a short settle window"). */
export const DRAFT_SETTLE_MS = 600;

type CallKind = 'incremental' | 'full';
type CallOutcome = 'ok' | 'failed' | 'stale';

export interface DraftEngineOptions {
  file: TargetFileSummary;
  /** `ai.sendScreenshots` for this session. */
  sendImages: boolean;
  /** Values that must not reach the model or the stream. Read per call. */
  secrets: () => string[];
  /** The session's model, with the run AI switch lifted for the call. */
  complete: (messages: ChatMessage[], signal: AbortSignal) => Promise<{ text: string }>;
  emit: RecordEventListener;
  settleMs?: number;
  now?: () => number;
}

interface InFlight {
  promise: Promise<void>;
  abort: AbortController;
  /** The action ids the call was asked about — a drop of one of them makes
   *  its answer stale. */
  covers: ReadonlySet<string>;
  startedAt: number;
}

export class DraftEngine {
  private readonly actions: RecordedAction[] = [];
  private readonly dropped = new Set<string>();
  private readonly settleMs: number;
  private readonly now: () => number;

  // The draft.
  private steps: string[] = [];
  private parameters: Array<{ name: string; value: string }> = [];
  /** What the model said, and what settling the parameters changed — kept for
   *  the life of the draft, reset by a full redraft. */
  private keptNotes: string[] = [];
  private covered = new Set<string>();
  private revision = 0;

  /** The draft includes something it no longer may (a drop) or misses
   *  something before its end (a restore): the next call is a full redraft. */
  private needsFull = false;
  /** Bumped by every drop/restore that invalidates the draft. A call that
   *  started under an older generation is stale: its answer is thrown away. */
  private generation = 0;
  private current: InFlight | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastActionAt = Number.NEGATIVE_INFINITY;
  /** False from Stop or cancel on: nothing new is scheduled. */
  private open = true;
  /** True after `record:writing` or cancel: no drafting frames, no warnings. */
  private silent = false;
  /** `record:drafting busy: true` sent and not yet answered. */
  private busyShown = false;
  /** The model rejected images once; later calls go without them. */
  private imagesRejected = false;

  constructor(private readonly opts: DraftEngineOptions) {
    this.settleMs = opts.settleMs ?? DRAFT_SETTLE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Every action not dropped, in recording order. */
  private get remaining(): RecordedAction[] {
    return this.actions.filter((a) => !this.dropped.has(a.id));
  }

  /** How many actions the result would be written from. */
  get remainingCount(): number {
    return this.remaining.length;
  }

  /** How many draft calls are running right now — 0 or 1, by construction. */
  get callsInFlight(): number {
    return this.current ? 1 : 0;
  }

  private uncovered(): RecordedAction[] {
    return this.remaining.filter((a) => !this.covered.has(a.id));
  }

  // ── Inputs ─────────────────────────────────────────────────────────────

  /** A new action: draft it once the settle window has passed quietly. */
  addAction(action: RecordedAction): void {
    this.actions.push(action);
    this.lastActionAt = this.now();
    if (this.open) this.schedule(this.settleMs);
  }

  /**
   * Leave an action out. Answers false for an id the recording does not have,
   * or one already dropped. A drop that touches the draft — or the call now in
   * flight — makes the next call a full redraft, and the in-flight answer is
   * thrown away: no draft that includes a dropped action is ever emitted.
   */
  drop(id: string): boolean {
    if (!this.actions.some((a) => a.id === id) || this.dropped.has(id)) return false;
    this.dropped.add(id);
    if (this.covered.has(id) || this.current?.covers.has(id)) this.invalidate();
    return true;
  }

  /**
   * Put a dropped action back. Answers false when it was not dropped. When the
   * draft (or the call in flight) already reaches past it, the whole recording
   * is redrafted; otherwise the next incremental call simply picks it up.
   */
  restore(id: string): boolean {
    if (!this.dropped.has(id)) return false;
    this.dropped.delete(id);
    const at = this.actions.findIndex((a) => a.id === id);
    const reachesPast = this.actions.some(
      (a, i) => i > at && (this.covered.has(a.id) || this.current?.covers.has(a.id) === true),
    );
    if (reachesPast) this.invalidate();
    else if (this.open) this.schedule(0);
    return true;
  }

  /** Stop's `dropped`, united with the live drops. */
  dropAll(ids: readonly string[]): void {
    for (const id of ids) this.drop(id);
  }

  private invalidate(): void {
    this.needsFull = true;
    this.generation++;
    // Its answer would describe a recording that no longer exists.
    this.current?.abort.abort();
    if (this.open) this.schedule(0);
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  private schedule(delayMs: number): void {
    if (!this.open) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, Math.max(0, delayMs));
  }

  private nextKind(): CallKind | null {
    if (this.needsFull) return 'full';
    if (this.uncovered().length > 0) return 'incremental';
    return null;
  }

  /** Start the next call, if there is work and none is running. The running
   *  call pumps again when it ends, so nothing waits for a timer that fired
   *  while it was busy. */
  private async pump(): Promise<void> {
    if (!this.open || this.current) return;
    const kind = this.nextKind();
    if (!kind) return;
    const startedAt = this.now();
    const outcome = await this.runCall(kind, false);
    if (!this.open || !this.nextKind()) return;
    if (outcome === 'failed') {
      // "The next call covers those actions again" — the next one an ACTION
      // causes. Retrying on our own would hammer a model that just failed; an
      // action that arrived during the failed call is its own reason to go.
      if (this.lastActionAt > startedAt) this.schedule(this.settleWait());
      return;
    }
    // `stale` goes straight to the redraft; `ok` batches what arrived meanwhile
    // and still honours the settle window from the last of it.
    this.schedule(this.needsFull ? 0 : this.settleWait());
  }

  private settleWait(): number {
    return Math.max(0, this.lastActionAt + this.settleMs - this.now());
  }

  // ── One call ───────────────────────────────────────────────────────────

  private warn(message: string): void {
    if (this.silent) return;
    this.opts.emit({ type: 'output', msg: redact(message, this.opts.secrets()), kind: 'warn' });
  }

  private ask(kind: CallKind, actions: RecordedAction[], signal: AbortSignal): Promise<DraftAnswer> {
    const remaining = this.remaining;
    const index = remaining.indexOf(actions[0]!);
    return askForDraft({
      actions,
      draft: kind === 'full' ? { steps: [], parameters: [] } : { steps: this.steps, parameters: this.parameters },
      firstActionNumber: index + 1,
      previousAtMs: index > 0 ? remaining[index - 1]!.atMs : 0,
      file: this.opts.file,
      sendImages: this.opts.sendImages && !this.imagesRejected,
      secrets: this.opts.secrets(),
      complete: this.opts.complete,
      signal,
      onImagesRejected: () => {
        if (this.imagesRejected) return;
        this.imagesRejected = true;
        this.warn(
          'The model does not accept images, so the steps are drafted from the page descriptions alone ' +
            '(icon-only targets may be described less well).',
        );
      },
    });
  }

  /** Is `replaceFrom` inside the draft and no more than three steps back? */
  private acceptable(replaceFrom: number | undefined): replaceFrom is number {
    if (this.steps.length === 0) return true; // nothing to reach back into: 0
    if (replaceFrom === undefined) return false;
    return (
      replaceFrom >= Math.max(0, this.steps.length - RECORD_DRAFT_REWRITE_LIMIT) &&
      replaceFrom <= this.steps.length
    );
  }

  /**
   * Run one draft call — incremental over the uncovered actions, or full over
   * every remaining one — and apply its answer. A `final` call (Stop's) throws
   * on failure; any other failure is a warning and the previous draft stands.
   */
  private async runCall(kind: CallKind, final: boolean): Promise<CallOutcome> {
    if (this.current) throw new Error('a draft call is already running');
    const generation = this.generation;
    const actions = kind === 'full' ? this.remaining : this.uncovered();
    if (actions.length === 0) {
      // A full redraft of nothing — every action was dropped. No call needed:
      // the draft is empty.
      this.apply('full', { replaceFrom: 0, steps: [], parameters: [], notes: [] }, []);
      return 'ok';
    }

    const abort = new AbortController();
    let settle: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.current = {
      promise,
      abort,
      covers: new Set(actions.map((a) => a.id)),
      startedAt: this.now(),
    };
    if (!this.silent) {
      this.busyShown = true;
      this.opts.emit({ type: 'record:drafting', busy: true });
    }
    const stale = (): boolean => generation !== this.generation || abort.signal.aborted;
    try {
      let answer = await this.ask(kind, actions, abort.signal);
      if (stale()) return 'stale';
      if (kind === 'incremental' && !this.acceptable(answer.replaceFrom)) {
        // §8: reaching back more than three steps is refused, and the call is
        // retried ONCE as a full redraft — replaceFrom 0, over every remaining
        // action. Said in the log, not the panel: the author sees the draft.
        logger.info(
          `[record-steps] draft answer refused (replaceFrom ${String(answer.replaceFrom)} on a ` +
            `${this.steps.length}-step draft); redrafting in full`,
        );
        const all = this.remaining;
        this.current.covers = new Set(all.map((a) => a.id));
        answer = await this.ask('full', all, abort.signal);
        if (stale()) return 'stale';
        this.apply('full', answer, all);
        return 'ok';
      }
      this.apply(kind, answer, actions);
      return 'ok';
    } catch (err) {
      if (stale()) return 'stale';
      if (final) throw err;
      const reason = (err instanceof Error ? err.message : String(err)).replace(/\.\s*$/, '');
      this.warn(
        `The draft could not be updated: ${reason}. The steps so far stand; ` +
          'the next update covers those actions again.',
      );
      return 'failed';
    } finally {
      this.current = null;
      settle();
      if (this.busyShown && !this.silent) {
        this.busyShown = false;
        this.opts.emit({ type: 'record:drafting', busy: false });
      }
    }
  }

  private apply(kind: CallKind, answer: DraftAnswer, actions: readonly RecordedAction[]): void {
    const from = kind === 'full' || this.steps.length === 0 ? 0 : answer.replaceFrom!;
    const merged: RecordStepsAnswer = {
      steps: [...this.steps.slice(0, from), ...answer.steps],
      parameters: answer.parameters,
      notes: answer.notes,
    };
    const settled = settleParameters(merged, this.opts.file);
    this.steps = settled.steps;
    this.parameters = settled.parameters;
    this.keptNotes = [...new Set([...(kind === 'full' ? [] : this.keptNotes), ...settled.notes])];
    if (kind === 'full') {
      this.covered = new Set(actions.map((a) => a.id));
      this.needsFull = false;
    } else {
      for (const a of actions) this.covered.add(a.id);
    }
    this.revision++;
    if (this.silent) return;
    const notes = this.notes();
    const through = [...this.remaining].reverse().find((a) => this.covered.has(a.id))?.id;
    this.opts.emit({
      type: 'record:draft',
      revision: this.revision,
      steps: [...this.steps],
      parameters: this.parameters.map((p) => ({ ...p })),
      ...(notes.length > 0 && { notes }),
      ...(through !== undefined && { through }),
    });
  }

  private notes(): string[] {
    return [...new Set([...this.keptNotes, ...draftStateNotes(this.steps, this.parameters, this.opts.file)])];
  }

  // ── Stop and cancel ────────────────────────────────────────────────────

  /** Stop was received: schedule nothing more. The call in flight goes on. */
  close(): void {
    this.open = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * `record:writing` is about to go out: from here no drafting frames and no
   * warnings. A call still in flight is marked finished for the panel — its
   * "updating…" gives way to "Finishing…" — though it runs on.
   */
  silence(): void {
    this.close();
    if (this.busyShown) {
      this.busyShown = false;
      this.opts.emit({ type: 'record:drafting', busy: false });
    }
    this.silent = true;
  }

  /**
   * The final draft: wait for the call in flight, then make ONE more call only
   * when the draft does not cover every remaining action (or a drop at Stop
   * touched it). That call's failure is thrown — the recording ends with an
   * error and nothing is inserted (§8).
   */
  async finish(): Promise<RecordStepsAnswer> {
    while (this.current) await this.current.promise;
    const kind = this.nextKind();
    if (kind) await this.runCall(kind, true);
    return { steps: [...this.steps], parameters: this.parameters.map((p) => ({ ...p })), notes: this.notes() };
  }

  /** Cancel, or the stream closed: abandon the call in flight, make no more. */
  abandon(): void {
    this.close();
    this.silent = true;
    this.generation++;
    this.current?.abort.abort();
  }
}
