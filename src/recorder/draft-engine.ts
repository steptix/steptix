import { RECORD_DRAFT_REWRITE_LIMIT } from '../ai/prompts.js';
import type { ChatMessage } from '../ai/types.js';
import { logger } from '../utils/logger.js';
import { redact } from '../utils/secrets.js';
import type { TargetFileSummary } from './target-file.js';
import type { RecordEventListener, RecordStepSource, RecordedAction } from './types.js';
import {
  askForDraft,
  draftStateNotes,
  settleParameters,
  type DraftAnswer,
  type RecordStepsAnswer,
} from './write-steps.js';

/**
 * Live drafting (stories/testbench-record-steps.md, decision 9;
 * docs/specs/SPEC-record-steps.md §8, §9.2), with the author's own steps and
 * the locks they make (stories/testbench-record-toolbar.md, "Steps you
 * write").
 *
 * The recording's steps are written WHILE the author works: each action goes
 * to the model shortly after it happens, with the draft so far, and the model
 * answers the draft's new tail. This class decides when a call happens, what
 * it covers, and what its answer does to the draft — and holds the one rule
 * the whole design leans on: **never two draft calls at once for one
 * recording**. Every call goes through {@link runCall}, which refuses to start
 * while another is in flight; actions that arrive meanwhile wait for the next.
 *
 * ## Stretches and locks
 *
 * A step the author writes (the toolbar's box, a line typed in the editor) is
 * a fixed point, and everything before it is settled: a LOCK. The draft is
 * therefore kept as a list of STRETCHES — the steps between two locks, and the
 * run of actions they are written from:
 *
 *   stretch 0 │ stretch 1 │ … │ open stretch
 *   (closed by an author step)  (after the last lock)
 *
 * Every stretch but the last is closed, and its steps are locked: the model
 * can no longer rewrite them on its own. An ordinary call only ever works on
 * the OPEN stretch — an incremental call over its uncovered actions, which may
 * reach back three steps but never past the last lock, or a redraft of the
 * open stretch alone. A closed stretch is redrafted (in one call, just that
 * stretch) only when the author changes it: an action inside it dropped or
 * restored. And a catch-up that failed when a step was added leaves the
 * actions before the step uncovered in its closed stretch; the next call
 * drafts them into the space above the step (a "gap" call) and moves nothing
 * after it.
 *
 * Within a stretch, what is covered is always a prefix of its remaining
 * actions, as before, and `through` is the last action covered anywhere.
 */

/** How long after the last action a draft call waits, so a quick burst of
 *  actions goes in one call (§8, "a short settle window"). */
export const DRAFT_SETTLE_MS = 600;

type CallOutcome = 'ok' | 'failed' | 'stale';

/** One step of the draft: the model's, or the author's (with its id). */
interface Item {
  text: string;
  authorId?: string;
}

interface Stretch {
  items: Item[];
  /** The action ids its model-written steps are written from. */
  covered: Set<string>;
  /** Where its actions start in the recording (index into `actions`)… */
  startAt: number;
  /** …and end, exclusive — Infinity for the open stretch. */
  endAt: number;
  /** The author step whose lock ends this stretch; undefined when open. */
  closedBy?: string;
  /** It must be redrafted over its remaining actions. */
  dirty: boolean;
  /** Bumped on every change, so a restore can tell an untouched stretch. */
  version: number;
}

/** A step the author wrote. */
export interface AuthorStep {
  id: string;
  text: string;
  source: RecordStepSource;
  /** How many actions had been recorded when it joined: it sits after them. */
  boundary: number;
  /** Its order among author steps. */
  seq: number;
  /** The recording's clock when it joined. */
  atMs: number;
  /** The draft's revision when it was added: no draft up to this one
   *  showed it. */
  sinceRevision: number;
  /** Where in the recording its lock sits (the end of the stretch it
   *  closed): `boundary` for a step added at the end; for one typed between
   *  two recorded steps, just after the last action drafted then. */
  lockAt: number;
  /** Typed between two recorded steps (the editor), not at the end. */
  between: boolean;
  /** Parameters its text names that the file does not define: a secret it
   *  held, written as `{{name}}` (record-steps-run.ts `authorStepSecrets`). */
  parameters: Array<{ name: string; value: string }>;
}

/** What one call works on. */
type Work =
  /** The open stretch's uncovered actions — below `upTo` when a catch-up. */
  | { kind: 'incremental'; upTo?: number }
  /** The open stretch, redrafted over its remaining actions (below `upTo`). */
  | { kind: 'open-redraft'; upTo?: number }
  /** One closed stretch, redrafted over its remaining actions. */
  | { kind: 'stretch'; stretch: Stretch }
  /** One closed stretch's uncovered actions, inserted above its lock. */
  | { kind: 'gap'; stretch: Stretch };

export interface DraftEngineOptions {
  file: TargetFileSummary;
  /** `ai.sendScreenshots` for this session. */
  sendImages: boolean;
  /** Values that must not reach the model or the stream. Read per call. */
  secrets: () => string[];
  /** The session's model, with the run AI switch lifted for the call. */
  complete: (messages: ChatMessage[], signal: AbortSignal) => Promise<{ text: string }>;
  emit: RecordEventListener;
  /** A draft call failed (the warning has gone out as `output`). */
  onCallFailed?: () => void;
  settleMs?: number;
  now?: () => number;
}

interface InFlight {
  promise: Promise<void>;
  abort: AbortController;
  /** The action ids the call was asked about — a drop of one of them makes
   *  its answer stale. */
  covers: Set<string>;
  startedAt: number;
}

/** A step (or steps) the author added, where it went. */
export interface AddedAuthorStep {
  step: AuthorStep;
  /** Its index in the draft it joined. */
  index: number;
}

/** What the toolbar's Undo would take out next. */
export interface LiveEntry {
  id: string;
  kind: 'action' | 'author';
  /** One line, for "Removed: …". */
  summary: string;
}

const MAX_DRAFT_HISTORY = 30;

function cloneStretch(s: Stretch): Stretch {
  return {
    items: s.items.map((i) => ({ ...i })),
    covered: new Set(s.covered),
    startAt: s.startAt,
    endAt: s.endAt,
    ...(s.closedBy !== undefined && { closedBy: s.closedBy }),
    dirty: s.dirty,
    version: s.version,
  };
}

/** Where the trailing run of author steps starts in a stretch's items: the
 *  steps at its edge, which stay at its edge through any redraft. */
function trailingAuthorStart(items: readonly Item[]): number {
  let i = items.length;
  while (i > 0 && items[i - 1]!.authorId !== undefined) i--;
  return i;
}

/**
 * A redraft's new steps with the stretch's author steps put back: the ones at
 * its edge after them, the ones inside it (an editor line typed between two
 * recorded steps) at the index they had among its steps.
 */
function withAuthorSteps(old: readonly Item[], fresh: readonly Item[]): Item[] {
  const edge = trailingAuthorStart(old);
  const out = [...fresh];
  old.slice(0, edge).forEach((item, offset) => {
    if (item.authorId !== undefined) out.splice(Math.min(offset, out.length), 0, item);
  });
  return [...out, ...old.slice(edge)];
}

export class DraftEngine {
  private readonly actions: RecordedAction[] = [];
  private readonly dropped = new Set<string>();
  private readonly authors = new Map<string, AuthorStep>();
  private authorSeq = 0;
  private readonly settleMs: number;
  private readonly now: () => number;

  // The draft.
  private stretches: Stretch[] = [
    { items: [], covered: new Set(), startAt: 0, endAt: Number.POSITIVE_INFINITY, dirty: false, version: 0 },
  ];
  private parameters: Array<{ name: string; value: string }> = [];
  /** What the model said, and what settling the parameters changed — kept for
   *  the life of the draft, reset by a redraft from nothing. */
  private keptNotes: string[] = [];
  private revision = 0;
  /** Recent drafts' steps, so an editor step's `revision` can be read. */
  private readonly history: Array<{ revision: number; steps: string[] }> = [];
  /** An author step's drop, remembered so Restore can put the two stretches
   *  back exactly as they were when nothing touched them since. */
  private readonly authorDrops = new Map<
    string,
    {
      merged: Stretch | null;
      mergedVersion: number;
      before: Stretch[];
      holder: Stretch | null;
      holderInBefore: boolean;
      at: number;
      /** The draft step just before it when it was dropped — an author
       *  step by its id, the model's by its text — and where it was. */
      prev: Item | null;
      flatAt: number;
    }
  >();
  /** When the last call that FAILED started. Its actions are asked about
   *  again only once an action has arrived since (`nextWork`). */
  private failedCallStartedAt = Number.NEGATIVE_INFINITY;

  /** Bumped by every drop/restore that invalidates the draft. A call that
   *  started under an older generation is stale: its answer is thrown away. */
  private generation = 0;
  private current: InFlight | null = null;
  /** Held while an author step is being added: no call starts meanwhile. */
  private holding: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastActionAt = Number.NEGATIVE_INFINITY;
  /** False from Stop or cancel on: nothing new is scheduled. */
  private open = true;
  /** True after `record:writing` or cancel: no drafting frames, no warnings. */
  private silent = false;
  /** Cancelled: no call is made from here, not even Stop's final one. */
  private abandoned = false;
  /** Paused: no new call starts for new actions (one in flight finishes). */
  private paused = false;
  /** `record:drafting busy: true` sent and not yet answered. */
  private busyShown = false;
  /** The model rejected images once; later calls go without them. */
  private imagesRejected = false;

  constructor(private readonly opts: DraftEngineOptions) {
    this.settleMs = opts.settleMs ?? DRAFT_SETTLE_MS;
    this.now = opts.now ?? Date.now;
  }

  // ── The draft, read ────────────────────────────────────────────────────

  private get openStretch(): Stretch {
    return this.stretches[this.stretches.length - 1]!;
  }

  /** How many leading steps are locked: every step of every closed stretch. */
  private get lockedCount(): number {
    let n = 0;
    for (let i = 0; i < this.stretches.length - 1; i++) n += this.stretches[i]!.items.length;
    return n;
  }

  private flatItems(): Item[] {
    return this.stretches.flatMap((s) => s.items);
  }

  private flatSteps(): string[] {
    return this.flatItems().map((i) => i.text);
  }

  private authoredOf(items: readonly Item[]): { indices: number[]; ids: string[] } {
    const indices: number[] = [];
    const ids: string[] = [];
    items.forEach((item, i) => {
      if (item.authorId !== undefined) {
        indices.push(i);
        ids.push(item.authorId);
      }
    });
    return { indices, ids };
  }

  /** Every action not dropped, in recording order. */
  private get remaining(): RecordedAction[] {
    return this.actions.filter((a) => !this.dropped.has(a.id));
  }

  /** How many actions the result would be written from. */
  get remainingCount(): number {
    return this.remaining.length;
  }

  /** How many ACTIONS (decision 4) are in — what the toolbar counts. */
  get actionCount(): number {
    return this.actions.filter((a) => a.action && !this.dropped.has(a.id)).length;
  }

  /** How many actions have been recorded, dropped ones included — where an
   *  author step added now sits. */
  get recordedCount(): number {
    return this.actions.length;
  }

  /** How many steps the author wrote are in. */
  get authorCount(): number {
    let n = 0;
    for (const id of this.authors.keys()) if (!this.dropped.has(id)) n++;
    return n;
  }

  /** How many draft calls are running right now — 0 or 1, by construction. */
  get callsInFlight(): number {
    return this.current ? 1 : 0;
  }

  /** The draft's revision, as the last `record:draft` said. */
  get currentRevision(): number {
    return this.revision;
  }

  private indexOfAction(id: string): number {
    return this.actions.findIndex((a) => a.id === id);
  }

  private stretchOfIndex(i: number): Stretch {
    return this.stretches.find((s) => s.startAt <= i && i < s.endAt) ?? this.openStretch;
  }

  private remainingIn(s: Stretch, upTo = Number.POSITIVE_INFINITY): RecordedAction[] {
    const end = Math.min(s.endAt, upTo, this.actions.length);
    const out: RecordedAction[] = [];
    for (let i = s.startAt; i < end; i++) {
      const a = this.actions[i]!;
      if (!this.dropped.has(a.id)) out.push(a);
    }
    return out;
  }

  private uncoveredIn(s: Stretch, upTo?: number): RecordedAction[] {
    return this.remainingIn(s, upTo).filter((a) => !s.covered.has(a.id));
  }

  private isCovered(id: string): boolean {
    return this.stretches.some((s) => s.covered.has(id));
  }

  /** The next thing a call should do, or null. Closed stretches first, in
   *  order — they are above the open one — then the open stretch.
   *  `includeIncremental` false: only what the author's own changes asked
   *  for (while paused, no call starts for new actions).
   *
   *  A gap — actions a failed catch-up left undrafted above a step of the
   *  author's — is the model's failure to make up, not something the author
   *  asked for: like any failed call's actions it waits for the next ACTION,
   *  not for whatever work happens to be scheduled next (review, finding 7:
   *  it was retried at once, from the catch-up's own clean-up). Stop's
   *  `final` pass takes it regardless. */
  private nextWork(includeIncremental: boolean, final = false): Work | null {
    const gapsDue = final || this.lastActionAt > this.failedCallStartedAt;
    for (let i = 0; i < this.stretches.length - 1; i++) {
      const s = this.stretches[i]!;
      if (s.dirty) return { kind: 'stretch', stretch: s };
      if (gapsDue && this.uncoveredIn(s).length > 0) return { kind: 'gap', stretch: s };
    }
    const open = this.openStretch;
    if (open.dirty) return { kind: 'open-redraft' };
    if (includeIncremental && this.uncoveredIn(open).length > 0) return { kind: 'incremental' };
    return null;
  }

  // ── Inputs ─────────────────────────────────────────────────────────────

  /**
   * A new recorded event. Only an ACTION (decision 4 — a click, a drag, Enter
   * or Tab, Back/Forward/Refresh, a typed address, a check) sends the draft to
   * the model, once the settle window has passed quietly. Any other event —
   * typing, a choice in a list, a tick, files chosen, a tab — is kept and rides
   * with the next action's call (or Stop's): typing an email address costs no
   * model call; the Tab or the click after it does, and the model sees both.
   */
  addAction(action: RecordedAction): void {
    this.actions.push(action);
    if (!action.action) return;
    this.lastActionAt = this.now();
    if (this.open && !this.paused) this.schedule(this.settleMs);
  }

  /** Paused: no call starts for new actions; a call already running goes on.
   *  Resumed: what waited is drafted. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.kick();
  }

  /**
   * Leave an action — or a step the author wrote — out. Answers false for an
   * id the recording does not have, or one already dropped.
   *
   * An action the draft covers (or the call in flight was asked about) makes
   * its stretch be redrafted — the open stretch as before, a closed one on its
   * own, between the locks around it — and the in-flight answer is thrown
   * away: no draft that includes a dropped action is ever emitted.
   */
  drop(id: string): boolean {
    if (this.authors.has(id)) return this.dropAuthor(id);
    const i = this.indexOfAction(id);
    if (i < 0 || this.dropped.has(id)) return false;
    this.dropped.add(id);
    const s = this.stretchOfIndex(i);
    if (s.covered.has(id) || this.current?.covers.has(id)) {
      s.dirty = true;
      s.version++;
      this.invalidate();
    }
    return true;
  }

  /**
   * Put a dropped action (or author step) back. Answers false when it was not
   * dropped. In the open stretch: redrafted when the draft (or the call in
   * flight) already reaches past it, else the next incremental call picks it
   * up. In a closed stretch: that stretch is redrafted.
   */
  restore(id: string): boolean {
    if (this.authors.has(id)) return this.restoreAuthor(id);
    if (!this.dropped.has(id)) return false;
    this.dropped.delete(id);
    const at = this.indexOfAction(id);
    const s = this.stretchOfIndex(at);
    const reachesPast = this.actions.some(
      (a, i) => i > at && i < s.endAt && (s.covered.has(a.id) || this.current?.covers.has(a.id) === true),
    );
    if (s !== this.openStretch || reachesPast) {
      s.dirty = true;
      s.version++;
      this.invalidate();
    } else if (this.open) {
      this.schedule(0);
    }
    return true;
  }

  /** Stop's `dropped`, united with the live drops. */
  dropAll(ids: readonly string[]): void {
    for (const id of ids) this.drop(id);
  }

  private invalidate(): void {
    this.generation++;
    // Its answer would describe a recording that no longer exists.
    this.current?.abort.abort();
    if (this.open) this.schedule(0);
  }

  /**
   * Take an author step out and lift its lock: the stretch it closed and the
   * one after it become one again, as if it had never been added. When the
   * model had drafted actions after it — which may have been left unwritten
   * because the step covered them (rule A2) — the joined stretch is redrafted.
   * The draft without the line is emitted at once.
   */
  private dropAuthor(id: string): boolean {
    if (this.dropped.has(id)) return false;
    let holder: Stretch | null = null;
    let at = -1;
    for (const s of this.stretches) {
      const j = s.items.findIndex((i) => i.authorId === id);
      if (j >= 0) {
        holder = s;
        at = j;
      }
    }
    // Where it sat in the whole draft, and the step before it there — what
    // a Restore after its stretch changed puts it back after.
    const flat = this.flatItems();
    const flatAt = flat.findIndex((i) => i.authorId === id);
    const prev = flatAt > 0 ? { ...flat[flatAt - 1]! } : null;
    this.dropped.add(id);
    const k = this.stretches.findIndex((s) => s.closedBy === id);
    const pair = k >= 0 && k < this.stretches.length - 1 ? [this.stretches[k]!, this.stretches[k + 1]!] : [];
    const before = pair.map(cloneStretch);
    const holderInBefore = holder !== null && pair.includes(holder);
    if (holder) {
      holder.items.splice(at, 1);
      holder.version++;
    }
    let merged: Stretch | null = null;
    if (k >= 0 && k < this.stretches.length - 1) {
      const s = this.stretches[k]!;
      const next = this.stretches[k + 1]!;
      merged = {
        items: [...s.items, ...next.items],
        covered: new Set([...s.covered, ...next.covered]),
        startAt: s.startAt,
        endAt: next.endAt,
        ...(next.closedBy !== undefined && { closedBy: next.closedBy }),
        dirty: s.dirty || next.dirty || [...next.covered].some((a) => !this.dropped.has(a)),
        version: 0,
      };
      this.stretches.splice(k, 2, merged);
    }
    this.authorDrops.set(id, {
      merged,
      mergedVersion: merged?.version ?? 0,
      before,
      holder,
      holderInBefore,
      at,
      prev,
      flatAt,
    });
    this.generation++;
    this.current?.abort.abort();
    this.emitDraft();
    if (this.open) this.schedule(0);
    return true;
  }

  /**
   * Put an author step back. When the stretch its drop made has not changed
   * since, the two stretches come back exactly as they were — no call. Else
   * its lock is put back where it was in the recording, and both sides are
   * redrafted.
   */
  private restoreAuthor(id: string): boolean {
    const step = this.authors.get(id);
    if (!step || !this.dropped.has(id)) return false;
    this.dropped.delete(id);
    const memo = this.authorDrops.get(id);
    this.authorDrops.delete(id);
    const k = memo?.merged ? this.stretches.indexOf(memo.merged) : -1;
    if (memo && memo.merged && k >= 0 && memo.merged.version === memo.mergedVersion && memo.before.length === 2) {
      this.stretches.splice(k, 1, ...memo.before.map(cloneStretch));
      // A line typed between two recorded steps sat in another stretch.
      if (!memo.holderInBefore && memo.holder && this.stretches.includes(memo.holder)) {
        memo.holder.items.splice(Math.min(Math.max(0, memo.at), memo.holder.items.length), 0, {
          text: step.text,
          authorId: step.id,
        });
        memo.holder.version++;
      }
    } else {
      this.splitAt(step, memo?.holder ?? null, memo?.at ?? -1, memo ?? null);
    }
    this.generation++;
    this.current?.abort.abort();
    this.emitDraft();
    if (this.open) this.schedule(0);
    return true;
  }

  /**
   * Put an author step's lock back at its place in the recording (where the
   * stretch it closed ended), splitting the stretch that holds that place;
   * both halves are redrafted.
   *
   * The line itself goes back where it was among the steps. For a step added
   * at the end, that is the edge of the stretch it closes. For one typed
   * BETWEEN two recorded steps it is after the step that was before it — the
   * file still has it there, and the lock's place in the recording (the end
   * of what was drafted when it was typed) says nothing about which steps
   * are around it. Put at the lock instead, it moved below steps it was
   * typed above, and TestBench's order check took the recording out of the
   * file (review, finding 10).
   */
  private splitAt(
    step: AuthorStep,
    holder: Stretch | null,
    at: number,
    memo: { prev: Item | null; flatAt: number } | null,
  ): void {
    const b = step.lockAt;
    let k = this.stretches.findIndex((s) => s.startAt <= b && b < s.endAt);
    if (k < 0) k = this.stretches.length - 1;
    const m = this.stretches[k]!;
    const item: Item = { text: step.text, authorId: step.id };
    const first: Stretch = {
      items: [...m.items],
      covered: new Set([...m.covered].filter((a) => this.indexOfAction(a) < b)),
      startAt: m.startAt,
      endAt: Math.max(m.startAt, b),
      closedBy: step.id,
      dirty: true,
      version: 0,
    };
    const secondCovered = new Set([...m.covered].filter((a) => this.indexOfAction(a) >= b));
    const second: Stretch = {
      items: [],
      covered: secondCovered,
      startAt: Math.max(m.startAt, b),
      endAt: m.endAt,
      ...(m.closedBy !== undefined && { closedBy: m.closedBy }),
      dirty: secondCovered.size > 0,
      version: 0,
    };
    this.stretches.splice(k, 1, first, second);
    if (step.between && memo) {
      this.placeAfterNeighbour(item, memo.prev, memo.flatAt);
      return;
    }
    if (holder && holder !== m && this.stretches.includes(holder)) {
      holder.items.splice(Math.min(Math.max(0, at), holder.items.length), 0, item);
      holder.version++;
    } else {
      first.items.push(item);
    }
  }

  /**
   * Put `item` just after the step that was before it (`prev`, the nearest
   * copy of it to where it was; the very start when there was none) — or,
   * that step no longer being in the draft as it was (a redraft reworded
   * it), back at the index it had.
   */
  private placeAfterNeighbour(item: Item, prev: Item | null, flatAt: number): void {
    const flat = this.flatItems();
    let after = -1;
    if (prev !== null) {
      flat.forEach((candidate, i) => {
        const same =
          prev.authorId !== undefined
            ? candidate.authorId === prev.authorId
            : candidate.authorId === undefined && candidate.text === prev.text;
        if (same && (after < 0 || Math.abs(i - (flatAt - 1)) < Math.abs(after - (flatAt - 1)))) after = i;
      });
      if (after < 0) after = Math.min(flatAt, flat.length) - 1;
    }
    if (after < 0) {
      const s = this.stretches[0]!;
      s.items.unshift(item);
      s.version++;
      return;
    }
    const { stretch, local } = this.locate(after);
    stretch.items.splice(local + 1, 0, item);
    stretch.version++;
  }

  /**
   * The author wrote steps (stories/testbench-record-toolbar.md, "Locking in").
   *
   * - At the END of the draft (the toolbar's box, a new line under the block):
   *   the draft is brought up to date first, in one call, over the actions
   *   recorded before `boundary` — as Stop does; the lines go in after it,
   *   exactly as written; everything up to and including them is locked, and
   *   recording carries on below. When that call fails, the lines still go in
   *   where the author put them, and the actions before them are drafted into
   *   the space above them by the next call.
   * - BETWEEN two recorded steps (`afterStep` inside the draft — an editor
   *   line): it goes in there; everything drafted so far is locked, on both
   *   sides of it; actions not drafted yet go after the whole block.
   *
   * Each line is one step, and each locks what is above it. `onJoined` is
   * told where they went BEFORE the draft that holds them is emitted.
   */
  async addAuthorSteps(
    lines: readonly string[],
    opts: {
      source: RecordStepSource;
      boundary: number;
      atMs: number;
      afterStep?: number | undefined;
      revision?: number | undefined;
      /** Parameters the lines name that the file does not define (a secret
       *  written as `{{name}}`): part of the draft while the step is in. */
      parameters?: ReadonlyArray<{ name: string; value: string }>;
      onCatchUp?: () => void;
      onJoined?: (added: AddedAuthorStep[]) => void;
    },
  ): Promise<AddedAuthorStep[]> {
    return this.exclusive(async () => {
      if (lines.length === 0 || this.abandoned) return [];
      const boundary = Math.max(this.openStretch.startAt, Math.min(opts.boundary, this.actions.length));
      const steps = this.flatSteps();
      const at = opts.afterStep === undefined ? undefined : this.mapIndex(opts.afterStep, opts.revision);
      const atEnd = at === undefined || at >= steps.length - 1;
      const made = lines.map((text) => {
        const step = this.newAuthor(text, opts.source, boundary, opts.atMs);
        step.between = !atEnd;
        step.parameters = (opts.parameters ?? []).filter((p) => text.includes(`{{${p.name}}}`)).map((p) => ({ ...p }));
        return step;
      });
      let added: AddedAuthorStep[];

      if (atEnd) {
        const open = this.openStretch;
        const catchUp: Work | null = open.dirty
          ? { kind: 'open-redraft', upTo: boundary }
          : this.uncoveredIn(open, boundary).length > 0
            ? { kind: 'incremental', upTo: boundary }
            : null;
        if (catchUp) {
          opts.onCatchUp?.();
          await this.runCall(catchUp, false);
        }
        const start = this.flatItems().length;
        this.closeOpen(boundary, made, true);
        added = made.map((step, i) => ({ step, index: start + i }));
      } else {
        const insertAfter = at!;
        const { stretch, local } = this.locate(insertAfter);
        stretch.items.splice(local + 1, 0, ...made.map((s) => ({ text: s.text, authorId: s.id })));
        stretch.version++;
        // Everything drafted so far is locked; what is not drafted yet happened
        // after all of it, so it goes after the whole block.
        const open = this.openStretch;
        const coveredAt = [...open.covered].map((a) => this.indexOfAction(a)).filter((i) => i >= 0);
        const end = Math.max(open.startAt, Math.min(boundary, coveredAt.length ? Math.max(...coveredAt) + 1 : open.startAt));
        for (const step of made) step.lockAt = end;
        this.closeOpen(end, made, false);
        added = made.map((step, i) => ({ step, index: insertAfter + 1 + i }));
      }
      // The draft emitted next is the first to show them.
      for (const step of made) step.sinceRevision = this.revision;
      opts.onJoined?.(added);
      this.emitDraft();
      return added;
    });
  }

  private newAuthor(text: string, source: RecordStepSource, boundary: number, atMs: number): AuthorStep {
    const seq = ++this.authorSeq;
    const step: AuthorStep = {
      id: `s${seq}`,
      text,
      source,
      boundary,
      seq,
      atMs,
      sinceRevision: this.revision,
      lockAt: boundary,
      between: false,
      parameters: [],
    };
    this.authors.set(step.id, step);
    return step;
  }

  /**
   * The draft's parameters: the model's, and those the author's steps still
   * in the draft name (a secret they held, written as `{{name}}`) that the
   * model's list does not have. The model's answer replaces its list every
   * call; the author's are theirs and stay while their step does.
   */
  private allParameters(): Array<{ name: string; value: string }> {
    const out = this.parameters.map((p) => ({ ...p }));
    const named = new Set(out.map((p) => p.name));
    for (const item of this.flatItems()) {
      const step = item.authorId !== undefined ? this.authors.get(item.authorId) : undefined;
      for (const p of step?.parameters ?? []) {
        if (named.has(p.name)) continue;
        named.add(p.name);
        out.push({ ...p });
      }
    }
    return out;
  }

  /** Close the open stretch at `endAt`: the first author step closes it (its
   *  line appended when `append`), each further one closes an empty stretch
   *  of its own, and a new open stretch starts. */
  private closeOpen(endAt: number, made: readonly AuthorStep[], append: boolean): void {
    const open = this.openStretch;
    open.endAt = endAt;
    const moved = new Set([...open.covered].filter((a) => this.indexOfAction(a) >= endAt));
    for (const a of moved) open.covered.delete(a);
    made.forEach((step, n) => {
      if (n === 0) {
        if (append) open.items.push({ text: step.text, authorId: step.id });
        open.closedBy = step.id;
        open.version++;
        return;
      }
      this.stretches.push({
        items: append ? [{ text: step.text, authorId: step.id }] : [],
        covered: new Set(),
        startAt: endAt,
        endAt,
        closedBy: step.id,
        dirty: false,
        version: 0,
      });
    });
    this.stretches.push({
      items: [],
      covered: moved,
      startAt: endAt,
      endAt: Number.POSITIVE_INFINITY,
      dirty: moved.size > 0,
      version: 0,
    });
  }

  /** The stretch holding draft step `index`, and its place in it. */
  private locate(index: number): { stretch: Stretch; local: number } {
    let base = 0;
    for (const s of this.stretches) {
      if (index < base + s.items.length) return { stretch: s, local: index - base };
      base += s.items.length;
    }
    const last = this.openStretch;
    return { stretch: last, local: last.items.length - 1 };
  }

  /**
   * An editor step's `afterStep` read against the draft the author saw: the
   * same step's text, found in the draft as it is now — and then past any
   * step of the author's that joined right after it since that draft. Two
   * lines typed under the same step of the same draft, sent one after the
   * other, land in the order they were sent: the second after the first,
   * not between the step and the first (review, TestBench half).
   */
  private mapIndex(afterStep: number, revision: number | undefined): number {
    const items = this.flatItems();
    const steps = items.map((i) => i.text);
    const clamp = (i: number): number => Math.max(0, Math.min(i, steps.length - 1));
    if (revision === undefined || revision === this.revision) return afterStep;
    const seen = this.history.find((h) => h.revision === revision);
    const text = seen?.steps[afterStep];
    let at: number;
    if (text === undefined) {
      at = clamp(afterStep);
    } else {
      let best = -1;
      let distance = Number.POSITIVE_INFINITY;
      steps.forEach((s, i) => {
        if (s === text && Math.abs(i - afterStep) < distance) {
          best = i;
          distance = Math.abs(i - afterStep);
        }
      });
      at = best >= 0 ? best : clamp(afterStep);
    }
    while (at + 1 < items.length) {
      const id = items[at + 1]!.authorId;
      const step = id !== undefined ? this.authors.get(id) : undefined;
      if (!step || step.sinceRevision < revision) break;
      at++;
    }
    return at;
  }

  /** The most recent entry still in — an action (event included) or a step
   *  the author wrote — for the toolbar's Undo. */
  latestLiveEntry(): LiveEntry | null {
    let best: { key: number; entry: LiveEntry } | null = null;
    this.actions.forEach((a, i) => {
      if (this.dropped.has(a.id)) return;
      const key = i + 1;
      if (!best || key > best.key) best = { key, entry: { id: a.id, kind: 'action', summary: a.summary } };
    });
    for (const a of this.authors.values()) {
      if (this.dropped.has(a.id)) continue;
      const key = a.boundary + 0.5 + a.seq * 1e-6;
      if (!best || key > best.key) best = { key, entry: { id: a.id, kind: 'author', summary: a.text } };
    }
    return (best as { key: number; entry: LiveEntry } | null)?.entry ?? null;
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

  /** Start whatever is waiting: at once for work the author asked for, after
   *  the settle window for new actions. */
  private kick(): void {
    if (!this.open) return;
    const work = this.nextWork(!this.paused);
    if (!work) return;
    if (work.kind !== 'incremental') this.schedule(0);
    else if (this.uncoveredIn(this.openStretch).some((a) => a.action)) this.schedule(this.settleWait());
  }

  /** Start the next call, if there is work and none is running. The running
   *  call pumps again when it ends, so nothing waits for a timer that fired
   *  while it was busy. */
  private async pump(): Promise<void> {
    if (!this.open || this.current || this.holding) return;
    const work = this.nextWork(!this.paused);
    if (!work) return;
    const startedAt = this.now();
    const outcome = await this.runCall(work, false);
    if (!this.open) return;
    if (outcome === 'failed') {
      // "The next call covers those actions again" — the next one an ACTION
      // causes. Retrying on our own would hammer a model that just failed; an
      // action that arrived during the failed call is its own reason to go.
      if (this.lastActionAt > startedAt) this.schedule(this.settleWait());
      return;
    }
    // `stale` goes straight to the redraft; `ok` batches the ACTIONS that
    // arrived meanwhile and still honours the settle window from the last of
    // them. Events that arrived meanwhile wait for the next action, as they
    // would have without the call.
    this.kick();
  }

  private settleWait(): number {
    return Math.max(0, this.lastActionAt + this.settleMs - this.now());
  }

  /**
   * Run `fn` with no call in flight and none starting until it is done. After
   * it: work the author's change asked for goes at once; new actions that
   * arrived meanwhile go after the settle window — and actions a failed call
   * left behind still wait for the next action, as they always have.
   */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.holding) await this.holding;
    let release: () => void = () => {};
    this.holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldAt = this.now();
    try {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      while (this.current) await this.current.promise;
      return await fn();
    } finally {
      this.holding = null;
      release();
      const work = this.open ? this.nextWork(!this.paused) : null;
      if (work && work.kind !== 'incremental') this.schedule(0);
      else if (work && this.lastActionAt >= heldAt) this.schedule(this.settleWait());
    }
  }

  // ── One call ───────────────────────────────────────────────────────────

  private warn(message: string): void {
    if (this.silent) return;
    this.opts.emit({ type: 'output', msg: redact(message, this.opts.secrets()), kind: 'warn' });
  }

  /** The actions one piece of work is about. */
  private actionsFor(work: Work): RecordedAction[] {
    switch (work.kind) {
      case 'incremental':
        return this.uncoveredIn(this.openStretch, work.upTo);
      case 'open-redraft':
        return this.remainingIn(this.openStretch, work.upTo);
      case 'stretch':
        return this.remainingIn(work.stretch);
      case 'gap':
        return this.uncoveredIn(work.stretch);
    }
  }

  /**
   * The draft as one call is shown it: every step, which are locked and which
   * the author's — and for a call that INSERTS, the draft without the steps it
   * rewrites, and where its steps go.
   */
  private viewFor(work: Work): {
    steps: string[];
    locked: number;
    authored: number[];
    insertAt?: number;
    alsoByAuthor?: string[];
    fresh: boolean;
  } {
    if (work.kind === 'incremental' || work.kind === 'gap') {
      const items = this.flatItems();
      const view = {
        steps: items.map((i) => i.text),
        locked: this.lockedCount,
        authored: this.authoredOf(items).indices,
        fresh: false,
      };
      if (work.kind === 'incremental') return view;
      let base = 0;
      for (const s of this.stretches) {
        if (s === work.stretch) break;
        base += s.items.length;
      }
      return { ...view, insertAt: base + trailingAuthorStart(work.stretch.items) };
    }
    const target = work.kind === 'stretch' ? work.stretch : this.openStretch;
    const shown: Item[] = [];
    let insertAt = 0;
    let lockedShown = 0;
    const inside: string[] = [];
    this.stretches.forEach((s, k) => {
      const closed = k < this.stretches.length - 1;
      if (s !== target) {
        shown.push(...s.items);
        if (closed) lockedShown += s.items.length;
        return;
      }
      insertAt = shown.length;
      const edge = trailingAuthorStart(s.items);
      s.items.slice(0, edge).forEach((i) => {
        if (i.authorId !== undefined) inside.push(i.text);
      });
      const trailing = s.items.slice(edge);
      shown.push(...trailing);
      if (closed) lockedShown += trailing.length;
    });
    return {
      steps: shown.map((i) => i.text),
      locked: lockedShown,
      authored: this.authoredOf(shown).indices,
      insertAt,
      ...(inside.length > 0 && { alsoByAuthor: inside }),
      fresh: shown.length === 0 && inside.length === 0,
    };
  }

  private ask(work: Work, actions: RecordedAction[], signal: AbortSignal): Promise<DraftAnswer> {
    const remaining = this.remaining;
    const index = remaining.indexOf(actions[0]!);
    const view = this.viewFor(work);
    return askForDraft({
      actions,
      draft: {
        steps: view.steps,
        // A redraft from nothing starts its parameters from nothing too.
        parameters: view.fresh ? [] : this.allParameters(),
        locked: view.locked,
        authored: view.authored,
        ...(view.insertAt !== undefined && !view.fresh && { insertAt: view.insertAt }),
        ...(view.alsoByAuthor && { alsoByAuthor: view.alsoByAuthor }),
      },
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

  /**
   * Is an incremental answer's `replaceFrom` inside the draft, no more than
   * three steps back, and past every lock and every step of the author's?
   */
  private acceptable(replaceFrom: number | undefined): replaceFrom is number {
    const items = this.flatItems();
    if (items.length === 0) return true; // nothing to reach back into: 0
    if (replaceFrom === undefined) return false;
    const floor = Math.max(
      0,
      items.length - RECORD_DRAFT_REWRITE_LIMIT,
      this.lockedCount,
      ...this.authoredOf(items).indices.map((i) => i + 1),
    );
    return replaceFrom >= floor && replaceFrom <= items.length;
  }

  /**
   * Run one draft call and apply its answer. A `final` call (Stop's) throws
   * on failure; any other failure is a warning and the previous draft stands.
   */
  private async runCall(work: Work, final: boolean): Promise<CallOutcome> {
    if (this.current) throw new Error('a draft call is already running');
    if (this.abandoned) return 'stale';
    const generation = this.generation;
    const actions = this.actionsFor(work);
    if (actions.length === 0) {
      // A redraft of nothing — every action in it was dropped. No call
      // needed: only the author's steps are left there.
      if (work.kind === 'open-redraft' || work.kind === 'stretch') {
        const parameters = this.viewFor(work).fresh ? [] : this.parameters;
        this.apply(work, { replaceFrom: 0, steps: [], parameters, notes: [] }, []);
      }
      return 'ok';
    }

    const abort = new AbortController();
    let settle: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const startedAt = this.now();
    this.current = {
      promise,
      abort,
      covers: new Set(actions.map((a) => a.id)),
      startedAt,
    };
    if (!this.silent) {
      this.busyShown = true;
      this.opts.emit({ type: 'record:drafting', busy: true });
    }
    const stale = (): boolean => generation !== this.generation || abort.signal.aborted;
    try {
      let answer = await this.ask(work, actions, abort.signal);
      if (stale()) return 'stale';
      if (work.kind === 'incremental' && !this.acceptable(answer.replaceFrom)) {
        // §8 with locks: reaching back more than three steps, or past a lock,
        // is refused, and the call is retried ONCE as a redraft of the OPEN
        // steps only. Said in the log, not the panel: the author sees the draft.
        logger.info(
          `[record-steps] draft answer refused (replaceFrom ${String(answer.replaceFrom)} on a ` +
            `${this.flatItems().length}-step draft, ${this.lockedCount} locked); redrafting the open steps`,
        );
        const retry: Work = { kind: 'open-redraft', ...(work.upTo !== undefined && { upTo: work.upTo }) };
        const all = this.actionsFor(retry);
        this.current.covers = new Set(all.map((a) => a.id));
        answer = await this.ask(retry, all, abort.signal);
        if (stale()) return 'stale';
        this.apply(retry, answer, all);
        return 'ok';
      }
      this.apply(work, answer, actions);
      return 'ok';
    } catch (err) {
      if (stale()) return 'stale';
      if (final) throw err;
      this.failedCallStartedAt = Math.max(this.failedCallStartedAt, startedAt);
      const reason = (err instanceof Error ? err.message : String(err)).replace(/\.\s*$/, '');
      this.warn(
        `The draft could not be updated: ${reason}. The steps so far stand; ` +
          'the next update covers those actions again.',
      );
      if (!this.silent) this.opts.onCallFailed?.();
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

  private apply(work: Work, answer: DraftAnswer, actions: readonly RecordedAction[]): void {
    const fresh = (work.kind === 'open-redraft' || work.kind === 'stretch') && this.viewFor(work).fresh;
    const answerItems = (texts: readonly string[], window: readonly Item[]): Item[] => {
      // A step the author wrote in this stretch is theirs: an exact copy of it
      // in the model's answer is not written a second time (rule A2).
      const theirs = new Set(window.filter((i) => i.authorId !== undefined).map((i) => i.text.trim()));
      return texts.filter((t) => !theirs.has(t.trim())).map((text) => ({ text }));
    };
    switch (work.kind) {
      case 'incremental': {
        const open = this.openStretch;
        const openStart = this.lockedCount;
        const length = openStart + open.items.length;
        const from = length === 0 ? 0 : answer.replaceFrom!;
        open.items = [...open.items.slice(0, Math.max(0, from - openStart)), ...answer.steps.map((text) => ({ text }))];
        for (const a of actions) open.covered.add(a.id);
        open.version++;
        break;
      }
      case 'open-redraft':
      case 'stretch': {
        const s = work.kind === 'stretch' ? work.stretch : this.openStretch;
        s.items = withAuthorSteps(s.items, answerItems(answer.steps, s.items));
        s.covered = new Set(actions.map((a) => a.id));
        s.dirty = false;
        s.version++;
        break;
      }
      case 'gap': {
        const s = work.stretch;
        const cut = trailingAuthorStart(s.items);
        s.items = [...s.items.slice(0, cut), ...answerItems(answer.steps, s.items), ...s.items.slice(cut)];
        for (const a of actions) s.covered.add(a.id);
        s.version++;
        break;
      }
    }
    // The parameter rules, enforced over the whole draft — the author's lines
    // are theirs and are never rewritten by them.
    const items = this.flatItems();
    const merged: RecordStepsAnswer = {
      steps: items.map((i) => i.text),
      parameters: answer.parameters,
      notes: answer.notes,
    };
    const settled = settleParameters(merged, this.opts.file);
    items.forEach((item, i) => {
      if (item.authorId === undefined) item.text = settled.steps[i]!;
    });
    // The model was shown the author's own parameters and may hand them back:
    // they stay the author's, in the draft for as long as their step is.
    this.parameters = settled.parameters.filter((p) => !this.authorsOnly(p));
    this.keptNotes = [...new Set([...(fresh ? [] : this.keptNotes), ...settled.notes])];
    this.emitDraft();
  }

  /** A parameter that is one of the author's steps' (same name and value)
   *  and that none of the model's own steps uses. */
  private authorsOnly(p: { name: string; value: string }): boolean {
    const theirs = [...this.authors.values()].some((a) =>
      a.parameters.some((q) => q.name === p.name && q.value === p.value),
    );
    if (!theirs) return false;
    const ref = `{{${p.name}}}`;
    return !this.flatItems().some((i) => i.authorId === undefined && i.text.includes(ref));
  }

  private emitDraft(): void {
    this.revision++;
    const steps = this.flatSteps();
    this.history.push({ revision: this.revision, steps });
    if (this.history.length > MAX_DRAFT_HISTORY) this.history.shift();
    if (this.silent) return;
    const notes = this.notes();
    const through = [...this.remaining].reverse().find((a) => this.isCovered(a.id))?.id;
    const { indices, ids } = this.authoredOf(this.flatItems());
    this.opts.emit({
      type: 'record:draft',
      revision: this.revision,
      steps: [...steps],
      parameters: this.allParameters(),
      ...(notes.length > 0 && { notes }),
      ...(through !== undefined && { through }),
      locked: this.lockedCount,
      authored: indices,
      authoredIds: ids,
    });
  }

  private notes(): string[] {
    return [...new Set([...this.keptNotes, ...draftStateNotes(this.flatSteps(), this.allParameters(), this.opts.file)])];
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
   * The final draft: wait for the call in flight, then make the calls the
   * draft still needs — none when it covers every remaining action, one when
   * it does not (a drop at Stop that touched it included), and one per
   * locked stretch the author changed. A failure is thrown — the recording
   * ends with an error and nothing is inserted (§8).
   */
  async finish(): Promise<RecordStepsAnswer> {
    while (this.current || this.holding) {
      if (this.current) await this.current.promise;
      else if (this.holding) await this.holding;
    }
    // Cancelled while the call in flight ran: no final call — its answer
    // would be thrown away, and the model is not asked for nothing.
    let guard = this.stretches.length * 2 + 4;
    while (!this.abandoned && guard-- > 0) {
      const work = this.nextWork(true, true);
      if (!work) break;
      await this.runCall(work, true);
    }
    return { steps: this.flatSteps(), parameters: this.allParameters(), notes: this.notes() };
  }

  /** Cancel, or the stream closed: abandon the call in flight, make no more. */
  abandon(): void {
    this.abandoned = true;
    this.close();
    this.silent = true;
    this.generation++;
    this.current?.abort.abort();
  }
}
