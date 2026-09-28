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
 * write"), and the author's edits and deletes of any step
 * (stories/testbench-record-edit-steps.md).
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
 *
 * ## Steps, their ids and their actions
 *
 * Every step has an id (`record:draft.ids`): an author step its `s` id, a
 * step the model wrote a `d` id that it keeps while it stays as it is and
 * that a rewrite replaces. And every step the model wrote knows which
 * recorded actions it stands for — the model says so beside each step
 * (`stepActions`), the engine checks it, and infers it when the answer does
 * not hold up. That is what lets the author:
 *
 * - **edit** a step: its text becomes theirs (`edited`), it keeps its
 *   actions, and the model never rewrites it or writes another step for them
 *   — a redraft leaves its actions out of the call altogether, and puts the
 *   step back among the new ones by where its actions are;
 * - **delete** a step: it goes at once, with no call, and the actions behind
 *   it are dropped, so no redraft can bring it back; Restore puts both back.
 *
 * Neither locks anything: an edited step is a floor for an ordinary call's
 * `replaceFrom` (as a step of the author's is), and that is all.
 */

/** How long after the last action a draft call waits, so a quick burst of
 *  actions goes in one call (§8, "a short settle window"). */
export const DRAFT_SETTLE_MS = 600;

type CallOutcome = 'ok' | 'failed' | 'stale';

type Params = Array<{ name: string; value: string }>;

/** One step of the draft: the model's, or the author's (with its id). */
interface Item {
  /** Stable id — an author step's `s` id; a model step's `d` id, new each
   *  time the model writes the step. */
  id: string;
  text: string;
  authorId?: string;
  /** The recorded actions (riding events included) this step stands for.
   *  Always empty for a step of the author's. */
  actions: string[];
  /** The author reworded this step of the model's: the text is theirs. */
  edited?: {
    /** The model's words when the author first reworded it — editing back to
     *  them makes it the model's step again. */
    modelText: string;
    /** Parameters the text names that the file does not define (a secret
     *  written as `{{name}}`): part of the draft while the step is. */
    parameters: Params;
  };
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
  /** Bumped on every change of its steps (not of their text), so a restore
   *  can tell an untouched stretch. */
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
  parameters: Params;
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

/** The draft as one call is shown it. The items are copies: what the model
 *  saw, whatever the author changes while it answers. */
interface View {
  items: Item[];
  locked: number;
  insertAt?: number;
  alsoByAuthor?: string[];
  alsoEdited?: Item[];
  fresh: boolean;
}

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
  /** A step — the model's or the author's — left the draft or came back
   *  (a delete, an Undo, a Restore), from anywhere: what the browser's drawer
   *  strikes through. `afterId` is the step that was just before it. */
  onStepDropped?: (change: { id: string; text: string; afterId: string | null; dropped: boolean }) => void;
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
  /** What the call works on — an edit or a delete of a step a redraft is
   *  rewriting makes its answer stale. */
  work: Work;
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

/** A drop, a restore or an edit: done, nothing to do (an id the recording
 *  does not have, or one already in that state), or not done, and why. */
export type StepChange = boolean | { ignored: string };

/** A deleted step of the model's (or several, when the id named a step the
 *  model had since rewritten): what Restore puts back. */
interface StepDrop {
  entries: Array<{ item: Item; stretch: Stretch; local: number; prevId: string | null; flatAt: number }>;
  /** Each stretch's version once the steps were out: the same at Restore
   *  means nothing touched it since, and the steps go back exactly. */
  versions: Map<Stretch, number>;
  /** The recorded actions the delete dropped. */
  actions: string[];
  /** Actions its steps listed that were already dropped (the panel's ✕,
   *  a redraft still to come): theirs too, for "came back on their own". */
  alsoHad: string[];
  /** One of those came back on its own since (and was redrafted into a step
   *  of its own): the step cannot come back as it was — ever, even should
   *  that action be dropped again (property run, seed 53). */
  broken: boolean;
}

const MAX_DRAFT_HISTORY = 30;
/** How many model step ids are remembered with their actions. */
const MAX_REMEMBERED_IDS = 5000;

/** Why an edit or a delete could not apply — said to the author. */
export const STEP_GONE_MESSAGE =
  'No step stands for the actions that step stood for any more (the recording has moved on), so nothing was changed.';
const STEP_DELETED_MESSAGE = 'That step has been deleted; restore it first to change it.';
const STEP_SAME_MESSAGE = 'The step already reads that way.';
const STEP_UNKNOWN_MESSAGE = 'The recording has no step with that id.';
const STEP_PARTLY_BACK_MESSAGE =
  'Some of the actions behind that step were restored on their own since, so it cannot come back as it was. ' +
  'Restore the rest of its actions from the TestBench panel.';

function cloneItem(i: Item): Item {
  return {
    id: i.id,
    text: i.text,
    ...(i.authorId !== undefined && { authorId: i.authorId }),
    actions: [...i.actions],
    ...(i.edited && {
      edited: { modelText: i.edited.modelText, parameters: i.edited.parameters.map((p) => ({ ...p })) },
    }),
  };
}

function cloneStretch(s: Stretch): Stretch {
  return {
    items: s.items.map(cloneItem),
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
 * Two recorded entries are on the same element: the click into a field and
 * the typing or the Tab in it after. By the page's selector when both have
 * one and it matches; else by what names the element — tag, role, name, id,
 * `name` attribute — with at least one of those not empty, so two nameless
 * inputs are never taken for one. Same tab, same frame.
 */
function sameElement(a: RecordedAction | undefined, b: RecordedAction | undefined): boolean {
  const x = a?.target;
  const y = b?.target;
  if (!a || !b || !x || !y) return false;
  if (a.tab !== b.tab || (a.frame?.url ?? '') !== (b.frame?.url ?? '')) return false;
  if (x.selector !== undefined && x.selector === y.selector) return true;
  const named = (x.name ?? '') !== '' || (x.id ?? '') !== '' || (x.nameAttr ?? '') !== '';
  return (
    named &&
    x.tag === y.tag &&
    (x.role ?? '') === (y.role ?? '') &&
    (x.name ?? '') === (y.name ?? '') &&
    (x.id ?? '') === (y.id ?? '') &&
    (x.nameAttr ?? '') === (y.nameAttr ?? '')
  );
}

/** The `{{name}}` roots a text uses. */
function placeholderRoots(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}/g)) out.add(m[1]!.split('.')[0]!);
  return out;
}

export class DraftEngine {
  private readonly actions: RecordedAction[] = [];
  private readonly dropped = new Set<string>();
  private readonly authors = new Map<string, AuthorStep>();
  private authorSeq = 0;
  /** Model steps are `d1`, `d2`… — never an action's `a` id, never an author
   *  step's `s` id. */
  private stepSeq = 0;
  /** What each model step id stood for when a draft last showed it: an edit
   *  or a delete that names a step the model has since rewritten applies to
   *  whatever stands for the same actions now. */
  private readonly idActions = new Map<string, string[]>();
  /** …and the words it had then: what a delete naming it puts back on
   *  Restore when the model had merged it into another step. */
  private readonly idTexts = new Map<string, string>();
  /** Deleted steps of the model's, by the id their delete named. */
  private readonly stepDrops = new Map<string, StepDrop>();
  private readonly settleMs: number;
  private readonly now: () => number;

  // The draft.
  private stretches: Stretch[] = [
    { items: [], covered: new Set(), startAt: 0, endAt: Number.POSITIVE_INFINITY, dirty: false, version: 0 },
  ];
  private parameters: Params = [];
  /** What the model said, and what settling the parameters changed — kept for
   *  the life of the draft, reset by a redraft from nothing. */
  private keptNotes: string[] = [];
  private revision = 0;
  /** Recent drafts' steps and ids, so an editor step's `revision` can be read. */
  private readonly history: Array<{ revision: number; steps: string[]; ids: string[] }> = [];
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

  private editedOf(items: readonly Item[]): number[] {
    const out: number[] = [];
    items.forEach((item, i) => {
      if (item.edited) out.push(i);
    });
    return out;
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

  /** How many steps of the draft are the author's rewording — kept even when
   *  every action behind one was dropped since. */
  get editedCount(): number {
    return this.flatItems().filter((i) => i.edited).length;
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

  private isAction(id: string): boolean {
    return this.actions[this.indexOfAction(id)]?.action === true;
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

  /** What is not drafted yet. An action a rewording of the author's stands
   *  for is drafted, wherever the bookkeeping says it is: no call is ever
   *  asked about it again. */
  private uncoveredIn(s: Stretch, upTo?: number): RecordedAction[] {
    const held = this.heldActions();
    return this.remainingIn(s, upTo).filter((a) => !s.covered.has(a.id) && !held.has(a.id));
  }

  private isCovered(id: string): boolean {
    return this.stretches.some((s) => s.covered.has(id));
  }

  /** The recorded actions the author's rewordings stand for: no call is
   *  asked about them again, and no other step may claim them. */
  private heldActions(): Set<string> {
    const out = new Set<string>();
    for (const item of this.flatItems()) {
      if (!item.edited) continue;
      for (const a of item.actions) if (!this.dropped.has(a)) out.add(a);
    }
    return out;
  }

  /** A step of the draft by its id, and where it is. */
  private findItem(id: string): { item: Item; stretch: Stretch; local: number; flat: number } | null {
    let flat = 0;
    for (const stretch of this.stretches) {
      const local = stretch.items.findIndex((i) => i.id === id);
      if (local >= 0) return { item: stretch.items[local]!, stretch, local, flat: flat + local };
      flat += stretch.items.length;
    }
    return null;
  }

  /** The earliest action a step stands for that is still in, by where it
   *  was recorded — undefined for one that stands for none. */
  private firstOrder(item: Item): number | undefined {
    let best: number | undefined;
    for (const a of item.actions) {
      if (this.dropped.has(a)) continue;
      const at = this.indexOfAction(a);
      if (at >= 0 && (best === undefined || at < best)) best = at;
    }
    return best;
  }

  /** Where a step whose earliest action is `order` goes among `items`: before
   *  the first that stands for a later one (a step that stands for none sits
   *  with the one before it). */
  private slotFor(items: readonly Item[], order: number): number {
    let last = -1;
    for (let j = 0; j < items.length; j++) {
      const k = this.firstOrder(items[j]!) ?? last;
      if (k > order) return j;
      last = k;
    }
    return items.length;
  }

  private byOrder(ids: Iterable<string>): string[] {
    return [...new Set(ids)]
      .map((id) => ({ id, at: this.indexOfAction(id) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((x) => x.id);
  }

  /** Each remaining action's number, as the prompt shows it: where it sits
   *  among the actions still in, from 1. */
  private numbering(): Map<string, number> {
    const out = new Map<string, number>();
    this.remaining.forEach((a, i) => out.set(a.id, i + 1));
    return out;
  }

  /** The actions — each ACTION with the events that ride with it (the ones
   *  recorded since the action before) — among `ids`, in recording order.
   *  Events after the last action go with it. */
  private groupsOf(ids: Iterable<string>): string[][] {
    const groups: string[][] = [];
    let pending: string[] = [];
    for (const id of this.byOrder(ids)) {
      pending.push(id);
      if (this.isAction(id)) {
        groups.push(pending);
        pending = [];
      }
    }
    if (pending.length > 0) {
      if (groups.length > 0) groups[groups.length - 1]!.push(...pending);
      else groups.push(pending);
    }
    return groups;
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

  /** What an id names: a recorded action, a step the author wrote, a step of
   *  the draft (or one the model has since rewritten, or one deleted). */
  kindOf(id: string): 'action' | 'author' | 'step' | null {
    if (this.authors.has(id)) return 'author';
    if (this.indexOfAction(id) >= 0) return 'action';
    if (this.findItem(id) || this.stepDrops.has(id) || this.idActions.has(id)) return 'step';
    return null;
  }

  /** The draft's steps with what each stands for — for tests that check the
   *  engine's own bookkeeping (no action in two steps, none dropped). */
  inspect(): {
    steps: Array<{ id: string; text: string; actions: string[]; edited: boolean; author: boolean; locked: boolean }>;
    dropped: string[];
  } {
    const locked = this.lockedCount;
    return {
      steps: this.flatItems().map((i, n) => ({
        id: i.id,
        text: i.text,
        actions: [...i.actions],
        edited: i.edited !== undefined,
        author: i.authorId !== undefined,
        locked: n < locked,
      })),
      dropped: [...this.dropped],
    };
  }

  /** A step of the draft as the author sees it now, or null. */
  describeStep(id: string): { text: string; index: number } | null {
    const found = this.findItem(id);
    return found ? { text: found.item.text, index: found.flat } : null;
  }

  /**
   * The step the author reworded whose last recorded entry still in is `id`
   * — the one dropping `id` would leave standing for nothing — or null. The
   * toolbar's Undo of that entry takes the step out with it, and the panel's
   * ✕ of it says the step stays (review round 2, finding 6).
   */
  editedStepLeftBy(id: string): { id: string; text: string; index: number } | null {
    if (this.dropped.has(id)) return null;
    const flat = this.flatItems();
    for (let i = 0; i < flat.length; i++) {
      const item = flat[i]!;
      if (!item.edited || !item.actions.includes(id)) continue;
      if (item.actions.every((a) => a === id || this.dropped.has(a))) return { id: item.id, text: item.text, index: i };
    }
    return null;
  }

  /**
   * Leave an action — or a step the author wrote, or a step of the draft —
   * out. Answers false for an id the recording does not have, or one already
   * dropped.
   *
   * An action the draft covers (or the call in flight was asked about) makes
   * its stretch be redrafted — the open stretch as before, a closed one on its
   * own, between the locks around it — and the in-flight answer is thrown
   * away: no draft that includes a dropped action is ever emitted.
   *
   * A step of the draft is deleted at once, with no call, and the actions
   * behind it are dropped with it ({@link deleteStep}).
   */
  drop(id: string, source: RecordStepSource = 'panel'): StepChange {
    if (this.authors.has(id)) return this.dropAuthor(id);
    const i = this.indexOfAction(id);
    if (i < 0) return this.deleteStep(id, source);
    if (this.dropped.has(id)) return false;
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
   * Put a dropped action (or author step, or deleted step) back. Answers false
   * when it was not dropped. In the open stretch: redrafted when the draft (or
   * the call in flight) already reaches past it, else the next incremental
   * call picks it up. In a closed stretch: that stretch is redrafted.
   *
   * One action of a deleted step, restored on its own, is an action like any
   * other: its stretch is redrafted and the model writes a step for it. The
   * deleted step stays deleted — and can no longer come back as it was.
   */
  restore(id: string, source: RecordStepSource = 'panel'): StepChange {
    if (this.authors.has(id)) return this.restoreAuthor(id);
    if (this.indexOfAction(id) < 0) return this.restoreStep(id, source);
    if (!this.dropped.has(id)) return false;
    this.dropped.delete(id);
    const at = this.indexOfAction(id);
    const s = this.stretchOfIndex(at);
    const reachesPast = this.actions.some(
      (a, i) => i > at && i < s.endAt && (s.covered.has(a.id) || this.current?.covers.has(a.id) === true),
    );
    // One a step's delete dropped is still counted as drafted, and no step
    // stands for it: its stretch is redrafted (the story's "restoring any of
    // them redrafts, as today").
    const deletedWith = [...this.stepDrops.values()].some((d) => d.actions.includes(id));
    this.breakDeletesOf([id]);
    if (s !== this.openStretch || reachesPast || deletedWith) {
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
   * A step in one of `stretches` changed — edited, deleted, put back — or
   * `actions` were dropped: a call in flight whose answer would rewrite that
   * step, or that was asked about those actions, is thrown away (and made
   * again). An ordinary call is not: where its answer lands is found by the
   * ids of the steps it replaces, when it comes (`apply`).
   */
  private staleIfTouched(stretches: ReadonlySet<Stretch>, actions: readonly string[]): void {
    const c = this.current;
    if (!c) return;
    const redraft =
      (c.work.kind === 'open-redraft' && stretches.has(this.openStretch)) ||
      (c.work.kind === 'stretch' && stretches.has(c.work.stretch));
    if (!redraft && !actions.some((a) => c.covers.has(a))) return;
    this.generation++;
    c.abort.abort();
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
    const prev = flatAt > 0 ? cloneItem(flat[flatAt - 1]!) : null;
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
    const step = this.authors.get(id)!;
    this.opts.onStepDropped?.({ id, text: step.text, afterId: prev?.id ?? null, dropped: true });
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
      // The steps as they are NOW, in the stretches as they were: an edit
      // made since (which changes no stretch) is never undone by a Restore.
      const now = new Map(memo.merged.items.map((i) => [i.id, i]));
      const back = memo.before.map(cloneStretch);
      for (const s of back) s.items = s.items.map((i) => (now.has(i.id) ? cloneItem(now.get(i.id)!) : i));
      this.stretches.splice(k, 1, ...back);
      // A line typed between two recorded steps sat in another stretch.
      if (!memo.holderInBefore && memo.holder && this.stretches.includes(memo.holder)) {
        memo.holder.items.splice(Math.min(Math.max(0, memo.at), memo.holder.items.length), 0, this.authorItem(step));
        memo.holder.version++;
      }
    } else {
      this.splitAt(step, memo?.holder ?? null, memo?.at ?? -1, memo ?? null);
    }
    this.generation++;
    this.current?.abort.abort();
    this.opts.onStepDropped?.({ id, text: step.text, afterId: memo?.prev?.id ?? null, dropped: false });
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
   *
   * A step the author reworded goes to the half its actions are in: the
   * other half's redraft would otherwise be asked about them.
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
    const item = this.authorItem(step);
    const later = (i: Item): boolean => i.edited !== undefined && (this.firstOrder(i) ?? -1) >= b;
    const first: Stretch = {
      items: m.items.filter((i) => !later(i)),
      covered: new Set([...m.covered].filter((a) => this.indexOfAction(a) < b)),
      startAt: m.startAt,
      endAt: Math.max(m.startAt, b),
      closedBy: step.id,
      dirty: true,
      version: 0,
    };
    const secondCovered = new Set([...m.covered].filter((a) => this.indexOfAction(a) >= b));
    const second: Stretch = {
      items: m.items.filter(later),
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
          candidate.id === prev.id ||
          (prev.authorId !== undefined
            ? candidate.authorId === prev.authorId
            : candidate.authorId === undefined && candidate.text === prev.text);
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

  private authorItem(step: AuthorStep): Item {
    return { id: step.id, text: step.text, authorId: step.id, actions: [] };
  }

  // ── The author's edits and deletes ─────────────────────────────────────

  /** The steps of the draft (the model's, reworded or not) that stand for
   *  any of `actions` still in. */
  private standingFor(actions: readonly string[]): Item[] {
    const want = new Set(actions.filter((a) => !this.dropped.has(a)));
    if (want.size === 0) return [];
    return this.flatItems().filter((i) => i.authorId === undefined && i.actions.some((a) => want.has(a)));
  }

  /**
   * An edit or a delete naming a step the model has since rewritten: the
   * steps that stand for what it stood for now, split into those that stand
   * for nothing else (`whole`) and those the model merged it into, which
   * also stand for actions the author never saw in the step they named
   * (`partial`). Only what the named step stood for — `take` — is the
   * author's to reword or delete (review round 2, finding 3): the Four click
   * of "Click Two, then Four" is not taken over by an edit of "Click Two".
   */
  private splitStale(stood: readonly string[]): { take: string[]; whole: Item[]; partial: Item[] } {
    const named = new Set(stood.filter((a) => !this.dropped.has(a)));
    const targets = this.standingFor(stood);
    const whole = targets.filter((t) => t.actions.every((a) => named.has(a) || this.dropped.has(a)));
    const partial = targets.filter((t) => !whole.includes(t));
    const take = this.byOrder(targets.flatMap((t) => t.actions.filter((a) => named.has(a))));
    return { take, whole, partial };
  }

  /**
   * A step the model merged a named step into gives the named step's actions
   * up and keeps the rest. Its words described both, so a step of the
   * model's is redrafted — its stretch is dirty, and the model writes those
   * actions into a step of their own; one the author reworded keeps their
   * words for what is left of it (their words are never lost). Answers
   * whether a redraft is due.
   */
  private giveUp(partial: readonly Item[], take: ReadonlySet<string>): boolean {
    let redraft = false;
    for (const t of partial) {
      t.actions = t.actions.filter((a) => !take.has(a));
      if (t.edited) continue;
      const where = this.findItem(t.id);
      if (where) {
        where.stretch.dirty = true;
        redraft = true;
      }
    }
    return redraft;
  }

  /** Put `item` among the steps of the stretch its actions are in, by where
   *  they are (before any steps of the author's at the stretch's edge). */
  private placeByActions(item: Item): Stretch {
    const order = this.firstOrder(item);
    const home = order !== undefined ? this.stretchOfIndex(order) : this.openStretch;
    const at = order !== undefined ? this.slotFor(home.items, order) : home.items.length;
    home.items.splice(Math.min(at, trailingAuthorStart(home.items)), 0, item);
    return home;
  }

  /**
   * Recorded entries no step stands for, directly before `first` and on the
   * same element: the click into a field the model folded into the typing
   * after it (review round 2, finding 2). A delete of the typing's step takes
   * them too — left behind, the next redraft would write "Click the Email
   * field" back as a step of its own.
   */
  private foldedBefore(first: string): string[] {
    const start = this.indexOfAction(first);
    if (start < 0) return [];
    const at = this.actions[start]!;
    const owned = new Set(this.flatItems().flatMap((i) => i.actions));
    const out: string[] = [];
    for (let i = start - 1; i >= 0; i--) {
      const a = this.actions[i]!;
      if (this.dropped.has(a.id)) continue;
      if (owned.has(a.id) || !sameElement(a, at)) break;
      out.push(a.id);
    }
    return out;
  }

  /**
   * The author reworded a step (stories/testbench-record-edit-steps.md, "An
   * edited step is yours"). `text` is one line, already the recording's to
   * write (a leading number taken off, a secret written as `{{name}}`).
   *
   * - A step of the model's: the text is the author's from now on. It keeps
   *   the actions it stands for; the model never rewrites it, and writes no
   *   other step for them. Edited back to the model's exact words, it is the
   *   model's again.
   * - A step of the author's: its text is replaced.
   * - A step the model has rewritten since (its id is gone): the edit takes
   *   over what that step stood for, from whatever steps stand for it now —
   *   one step, the author's text, under the id the edit named. A step that
   *   stood for nothing else goes; one the model merged it into keeps the
   *   rest of its actions and is redrafted ({@link giveUp}). The author's
   *   text is never lost, and never written twice.
   *
   * No call, bar that redraft: the next one is shown the step as the author
   * left it.
   */
  editStep(id: string, text: string, opts: { source: RecordStepSource; parameters?: Params }): StepChange {
    const params = (opts.parameters ?? []).filter((p) => text.includes(`{{${p.name}}}`)).map((p) => ({ ...p }));
    const author = this.authors.get(id);
    if (author) {
      const found = this.findItem(id);
      if (this.dropped.has(id) || !found) return { ignored: STEP_DELETED_MESSAGE };
      if (found.item.text === text) return { ignored: STEP_SAME_MESSAGE };
      author.text = text;
      author.parameters = params;
      found.item.text = text;
      // A redraft of its stretch in flight was shown the old words, and may
      // copy them — no longer the author's, so written beside the new ones
      // (review round 2, finding 9). It is asked again.
      this.staleIfTouched(new Set([found.stretch]), []);
      return this.edited(id, text, opts.source);
    }
    if (this.stepDrops.has(id)) return { ignored: STEP_DELETED_MESSAGE };
    const found = this.findItem(id);
    if (found) {
      const item = found.item;
      if (item.text === text) return { ignored: STEP_SAME_MESSAGE };
      if (item.edited && item.edited.modelText === text) {
        delete item.edited;
      } else if (item.edited) {
        item.edited.parameters = params;
      } else {
        item.edited = { modelText: item.text, parameters: params };
      }
      item.text = text;
      this.staleIfTouched(new Set([found.stretch]), []);
      return this.edited(id, text, opts.source);
    }
    // Gone: the model rewrote it while the author was typing.
    const stood = this.idActions.get(id);
    if (!stood) return { ignored: STEP_UNKNOWN_MESSAGE };
    const { take, whole, partial } = this.splitStale(stood);
    if (take.length === 0) return { ignored: STEP_GONE_MESSAGE };
    const first = whole[0];
    // "The model's words" to edit back to: the step that now stands for
    // exactly those actions, else the named step's own last words.
    const modelText = first
      ? first.edited
        ? first.edited.modelText
        : first.text
      : (this.idTexts.get(id) ?? '');
    const item: Item = {
      id,
      text,
      actions: take,
      ...(text !== modelText && { edited: { modelText, parameters: params } }),
    };
    const touched = new Set<Stretch>();
    for (const t of [...whole, ...partial]) touched.add(this.findItem(t.id)!.stretch);
    this.staleIfTouched(touched, []);
    const redraft = this.giveUp(partial, new Set(take));
    // The later whole ones out; the first replaced where it stands — or,
    // with none, the step goes where its actions are.
    for (const t of [...whole].reverse()) {
      const where = this.findItem(t.id)!;
      if (t === first) where.stretch.items.splice(where.local, 1, item);
      else where.stretch.items.splice(where.local, 1);
    }
    if (!first) touched.add(this.placeByActions(item));
    for (const s of touched) s.version++;
    const done = this.edited(id, text, opts.source);
    if (redraft) this.invalidate();
    return done;
  }

  private edited(id: string, text: string, source: RecordStepSource): true {
    if (!this.silent) this.opts.emit({ type: 'record:edited', id, text, source });
    this.emitDraft();
    return true;
  }

  /**
   * Delete a step of the model's (reworded or not): it leaves the draft at
   * once, with no model call, and every recorded action behind it — the
   * events riding with them included — is dropped, as the panel's ✕ drops an
   * action, so no redraft ever brings it back; so is a click into the same
   * field just before them that no step stands for ({@link foldedBefore}).
   * An id the model has since rewritten deletes what that step stood for,
   * from whatever steps stand for it now: a step that stood for nothing else
   * goes, one the model merged it into keeps the rest and is redrafted
   * ({@link giveUp}).
   */
  private deleteStep(id: string, source: RecordStepSource): StepChange {
    if (this.stepDrops.has(id)) return false;
    const found = this.findItem(id);
    let targets: Item[];
    let partial: Item[] = [];
    let take: string[];
    if (found) {
      targets = [found.item];
      take = found.item.actions.filter((a) => !this.dropped.has(a));
    } else {
      const stood = this.idActions.get(id);
      if (!stood) return false;
      const split = this.splitStale(stood);
      if (split.take.length === 0) return { ignored: STEP_GONE_MESSAGE };
      targets = split.whole;
      partial = split.partial;
      take = split.take;
    }
    const flat = this.flatItems();
    const firstTaken = this.byOrder(take)[0];
    const folded = firstTaken !== undefined ? this.foldedBefore(firstTaken) : [];
    const actions = this.byOrder([...take, ...folded]);
    const alsoHad = this.byOrder(targets.flatMap((t) => t.actions).filter((a) => this.dropped.has(a)));
    const taken = new Set(take);
    const entries: StepDrop['entries'] = targets
      .map((item) => {
        const where = this.findItem(item.id)!;
        const at = flat.indexOf(item);
        // What it stands for when it comes back: what this delete dropped —
        // and, for the author's rewording, all it stood for, so an action
        // Undo took before it comes back to it (review round 2, finding 6).
        const kept = {
          ...cloneItem(item),
          actions: item.edited ? [...item.actions] : item.actions.filter((a) => !this.dropped.has(a)),
        };
        return {
          item: kept,
          stretch: where.stretch,
          local: where.local,
          prevId: at > 0 ? flat[at - 1]!.id : null,
          flatAt: at,
        };
      })
      .sort((a, b) => a.flatAt - b.flatAt);
    // What a merged step gave up comes back as the step the author deleted:
    // with the first whole one, else as that step, in the words they saw.
    const fromMerged = this.byOrder(partial.flatMap((t) => t.actions.filter((a) => taken.has(a))));
    if (fromMerged.length > 0) {
      if (entries.length > 0) {
        entries[0]!.item.actions = this.byOrder([...entries[0]!.item.actions, ...fromMerged]);
      } else {
        const host = partial[0]!;
        const at = flat.indexOf(host);
        entries.push({
          item: { id, text: this.idTexts.get(id) ?? host.text, actions: fromMerged },
          stretch: this.findItem(host.id)!.stretch,
          // Never "exactly where it was": it goes back by where its actions are.
          local: -1,
          prevId: at > 0 ? flat[at - 1]!.id : null,
          flatAt: at,
        });
      }
    }
    const touched = new Set(entries.map((e) => e.stretch));
    for (const t of partial) touched.add(this.findItem(t.id)!.stretch);
    this.staleIfTouched(touched, actions);
    for (const e of [...entries].reverse()) if (e.local >= 0) e.stretch.items.splice(e.local, 1);
    this.giveUp(partial, taken);
    for (const s of touched) s.version++;
    for (const a of actions) this.dropped.add(a);
    this.stepDrops.set(id, {
      entries,
      versions: new Map([...touched].map((s) => [s, s.version])),
      actions,
      alsoHad,
      broken: false,
    });
    if (!this.silent) this.opts.emit({ type: 'record:dropped', id, dropped: true, source, actions: [...actions] });
    this.opts.onStepDropped?.({ id, text: entries[0]!.item.text, afterId: entries[0]!.prevId, dropped: true });
    this.emitDraft();
    if (this.open) this.kick();
    return true;
  }

  /**
   * Put a deleted step back, with its actions. Exactly where it was, with no
   * call, when nothing has touched its stretch since; otherwise after the step
   * that was before it (among the steps its actions are with), else where its
   * actions put it. Refused when some of its actions came back on their own
   * meanwhile (the panel's ✕ on a struck action): they were redrafted into a
   * step of their own, and this one would describe them twice.
   */
  private restoreStep(id: string, source: RecordStepSource): StepChange {
    const memo = this.stepDrops.get(id);
    if (!memo) return false;
    if (memo.broken || [...memo.actions, ...memo.alsoHad].some((a) => !this.dropped.has(a))) {
      return { ignored: STEP_PARTLY_BACK_MESSAGE };
    }
    this.stepDrops.delete(id);
    for (const a of memo.actions) this.dropped.delete(a);
    this.breakDeletesOf(memo.actions);
    const exact = memo.entries.every(
      (e) => e.local >= 0 && this.stretches.includes(e.stretch) && e.stretch.version === memo.versions.get(e.stretch),
    );
    const touched = new Set<Stretch>();
    for (const e of memo.entries) {
      const item = cloneItem(e.item);
      if (exact) {
        e.stretch.items.splice(Math.min(e.local, e.stretch.items.length), 0, item);
        touched.add(e.stretch);
      } else {
        touched.add(this.placeRestored(item, e.prevId, e.flatAt));
      }
    }
    // Drafted again, where they are: no call is asked about them.
    for (const a of memo.actions) this.stretchOfIndex(this.indexOfAction(a)).covered.add(a);
    for (const s of touched) s.version++;
    // A call in flight was made without them.
    if (this.current) {
      this.generation++;
      this.current.abort.abort();
    }
    if (!this.silent) {
      this.opts.emit({ type: 'record:dropped', id, dropped: false, source, actions: [...memo.actions] });
    }
    const first = memo.entries[0]!;
    this.opts.onStepDropped?.({ id, text: first.item.text, afterId: first.prevId, dropped: false });
    this.emitDraft();
    if (this.open) this.schedule(0);
    return true;
  }

  /** `actions` came back: a deleted step that stood for any of them can no
   *  longer come back as it was. */
  private breakDeletesOf(actions: readonly string[]): void {
    for (const memo of this.stepDrops.values()) {
      if (actions.some((a) => memo.actions.includes(a) || memo.alsoHad.includes(a))) memo.broken = true;
    }
  }

  /**
   * Where a restored step goes once the draft has moved on. One that stands
   * for actions goes among the steps of the stretch they are in, by where they
   * are — no earlier than just after the step that was before it, when that
   * one is there too. By its actions, not merely "after the one before it":
   * two neighbours deleted top to bottom both had the first step before
   * them, and restored in that order the second went in above the first
   * (review round 2, finding 1). One that stands for none goes after the
   * step before it; else at its old index.
   */
  private placeRestored(item: Item, prevId: string | null, flatAt: number): Stretch {
    const order = this.firstOrder(item);
    const home = order !== undefined ? this.stretchOfIndex(order) : null;
    const flat = this.flatItems();
    const prevAt = prevId !== null ? flat.findIndex((i) => i.id === prevId) : -1;
    const prev = prevAt >= 0 ? this.locate(prevAt) : null;
    if (home) {
      const start = prev && prev.stretch === home ? prev.local + 1 : 0;
      const edge = trailingAuthorStart(home.items);
      let at = start + this.slotFor(home.items.slice(start), order!);
      if (start <= edge) at = Math.min(at, edge);
      home.items.splice(at, 0, item);
      return home;
    }
    if (prev) {
      prev.stretch.items.splice(prev.local + 1, 0, item);
      return prev.stretch;
    }
    if (flat.length === 0 || Math.min(flatAt, flat.length) === 0) {
      const s = this.stretches[0]!;
      s.items.unshift(item);
      return s;
    }
    const { stretch, local } = this.locate(Math.min(flatAt, flat.length) - 1);
    stretch.items.splice(local + 1, 0, item);
    return stretch;
  }

  // ── The author's own steps ─────────────────────────────────────────────

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
   *   line, or the drawer's `+`): it goes in there; everything drafted so far
   *   is locked, on both sides of it; actions not drafted yet go after the
   *   whole block.
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
      /** The step it goes after, by its id (the drawer's `+`): read against
       *  the draft as it is when the step joins — `afterStep` and `revision`
       *  when that step is gone. */
      afterId?: string | undefined;
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
      const at =
        opts.afterStep === undefined && opts.afterId === undefined
          ? undefined
          : this.mapIndex(opts.afterStep ?? steps.length - 1, opts.revision, opts.afterId);
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
        const end = this.closeOpen(boundary, made, true);
        for (const step of made) step.lockAt = end;
        const flat = this.flatItems();
        added = made.map((step) => ({ step, index: flat.findIndex((i) => i.authorId === step.id) }));
      } else {
        const insertAfter = at!;
        const { stretch, local } = this.locate(insertAfter);
        stretch.items.splice(local + 1, 0, ...made.map((s) => this.authorItem(s)));
        stretch.version++;
        // Everything drafted so far is locked; what is not drafted yet happened
        // after all of it, so it goes after the whole block. "Drafted so far"
        // includes actions recorded after the line was sent that a call it
        // waited for took in: their steps are in the block, around the line.
        const open = this.openStretch;
        const coveredAt = [...open.covered].map((a) => this.indexOfAction(a)).filter((i) => i >= 0);
        const end = Math.max(open.startAt, coveredAt.length ? Math.max(...coveredAt) + 1 : open.startAt);
        const closedAt = this.closeOpen(end, made, false);
        for (const step of made) step.lockAt = closedAt;
        const flat = this.flatItems();
        added = made.map((step) => ({ step, index: flat.findIndex((i) => i.authorId === step.id) }));
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
   * The draft's parameters: the model's, and those the author's steps and
   * rewordings still in the draft name (a secret they held, written as
   * `{{name}}`) that the model's list does not have — each only while some
   * step still uses it. The model's answer replaces its list every call; the
   * author's are theirs and stay while their step does. A parameter no step
   * uses any more (the step that typed it deleted, or reworded without it)
   * leaves the list (stories/testbench-record-edit-steps.md, "Delete").
   */
  private allParameters(): Params {
    const out = this.parameters.map((p) => ({ ...p }));
    const named = new Set(out.map((p) => p.name));
    const items = this.flatItems();
    for (const item of items) {
      const step = item.authorId !== undefined ? this.authors.get(item.authorId) : undefined;
      for (const p of [...(step?.parameters ?? []), ...(item.edited?.parameters ?? [])]) {
        if (named.has(p.name)) continue;
        named.add(p.name);
        out.push({ ...p });
      }
    }
    const used = new Set<string>();
    for (const item of items) for (const name of placeholderRoots(item.text)) used.add(name);
    return out.filter((p) => used.has(p.name));
  }

  /**
   * Close the open stretch at `endAt`: the first author step closes it (its
   * line appended when `append`), each further one closes an empty stretch
   * of its own, and a new open stretch starts. Answers where it closed.
   *
   * Steps the model drafted over actions recorded after that point — a call
   * the step waited for can take in actions that arrived meanwhile — go
   * below the line with their actions, into the new open stretch, as they
   * are. And a step drafted over actions on both sides of the point stays
   * whole, above the line: the stretch closes after its last action. Before,
   * those actions were redrafted below the line while the steps that already
   * described them stayed above it — the same action written twice (found by
   * the property run in tests/record-steps-edit.test.ts).
   */
  private closeOpen(endAt: number, made: readonly AuthorStep[], append: boolean): number {
    const open = this.openStretch;
    let end = endAt;
    for (const item of open.items) {
      const first = this.firstOrder(item);
      if (first === undefined || first >= endAt) continue;
      for (const a of item.actions) {
        const at = this.indexOfAction(a);
        if (!this.dropped.has(a) && at >= end) end = at + 1;
      }
    }
    open.endAt = end;
    const below = open.items.filter((i) => i.authorId === undefined && (this.firstOrder(i) ?? -1) >= end);
    if (below.length > 0) open.items = open.items.filter((i) => !below.includes(i));
    const moved = new Set([...open.covered].filter((a) => this.indexOfAction(a) >= end));
    for (const a of moved) open.covered.delete(a);
    made.forEach((step, n) => {
      if (n === 0) {
        if (append) open.items.push(this.authorItem(step));
        open.closedBy = step.id;
        open.version++;
        return;
      }
      this.stretches.push({
        items: append ? [this.authorItem(step)] : [],
        covered: new Set(),
        startAt: end,
        endAt: end,
        closedBy: step.id,
        dirty: false,
        version: 0,
      });
    });
    // What was drafted past the line keeps its steps: nothing to redraft.
    // Covered actions no step moved with stand for no step (the model
    // folded them away); they stay drafted.
    this.stretches.push({
      items: below,
      covered: moved,
      startAt: end,
      endAt: Number.POSITIVE_INFINITY,
      dirty: false,
      version: 0,
    });
    return end;
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
   * same step — by its id, else by its text — found in the draft as it is now;
   * and then past any step of the author's that joined right after it since
   * that draft. Two lines typed under the same step of the same draft, sent
   * one after the other, land in the order they were sent: the second after
   * the first, not between the step and the first (review, TestBench half).
   * `afterId` (the drawer's `+`) names the step directly.
   */
  private mapIndex(afterStep: number, revision: number | undefined, afterId?: string): number {
    const items = this.flatItems();
    const steps = items.map((i) => i.text);
    const clamp = (i: number): number => Math.max(0, Math.min(i, steps.length - 1));
    const byId = afterId !== undefined ? items.findIndex((i) => i.id === afterId) : -1;
    let at: number;
    if (byId >= 0) {
      at = byId;
    } else if (revision === undefined || revision === this.revision) {
      return afterStep;
    } else {
      const seen = this.history.find((h) => h.revision === revision);
      const id = seen?.ids[afterStep];
      const idAt = id !== undefined ? items.findIndex((i) => i.id === id) : -1;
      const text = seen?.steps[afterStep];
      if (idAt >= 0) {
        at = idAt;
      } else if (text === undefined) {
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
    }
    if (revision === undefined || revision >= this.revision) return at;
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

  /** The actions one piece of work is about. Never what an author's
   *  rewording stands for: the model is not asked about those again (A4). */
  private actionsFor(work: Work): RecordedAction[] {
    const held = this.heldActions();
    const free = (list: RecordedAction[]): RecordedAction[] => list.filter((a) => !held.has(a.id));
    switch (work.kind) {
      case 'incremental':
        return free(this.uncoveredIn(this.openStretch, work.upTo));
      case 'open-redraft':
        return free(this.remainingIn(this.openStretch, work.upTo));
      case 'stretch':
        return free(this.remainingIn(work.stretch));
      case 'gap':
        return free(this.uncoveredIn(work.stretch));
    }
  }

  /**
   * The draft as one call is shown it: every step, which are locked, which the
   * author's and which the author reworded — and for a call that INSERTS, the
   * draft without the steps it rewrites, where its steps go, and the steps of
   * the author's inside what it rewrites. Copies, so what the model saw can be
   * compared with the draft when the answer comes.
   */
  private viewFor(work: Work): View {
    if (work.kind === 'incremental' || work.kind === 'gap') {
      const view: View = { items: this.flatItems().map(cloneItem), locked: this.lockedCount, fresh: false };
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
    const insideEdited: Item[] = [];
    this.stretches.forEach((s, k) => {
      const closed = k < this.stretches.length - 1;
      if (s !== target) {
        shown.push(...s.items.map(cloneItem));
        if (closed) lockedShown += s.items.length;
        return;
      }
      insertAt = shown.length;
      const edge = trailingAuthorStart(s.items);
      s.items.slice(0, edge).forEach((i) => {
        if (i.authorId !== undefined) inside.push(i.text);
        else if (i.edited) insideEdited.push(cloneItem(i));
      });
      const trailing = s.items.slice(edge).map(cloneItem);
      shown.push(...trailing);
      if (closed) lockedShown += trailing.length;
    });
    return {
      items: shown,
      locked: lockedShown,
      insertAt,
      ...(inside.length > 0 && { alsoByAuthor: inside }),
      ...(insideEdited.length > 0 && { alsoEdited: insideEdited }),
      fresh: shown.length === 0 && inside.length === 0 && insideEdited.length === 0,
    };
  }

  private ask(
    view: View,
    actions: RecordedAction[],
    numberOf: ReadonlyMap<string, number>,
    signal: AbortSignal,
  ): Promise<DraftAnswer> {
    const remaining = this.remaining;
    const index = remaining.indexOf(actions[0]!);
    const numbers = (ids: readonly string[]): number[] =>
      ids.filter((id) => numberOf.has(id)).map((id) => numberOf.get(id)!).sort((a, b) => a - b);
    return askForDraft({
      actions,
      draft: {
        steps: view.items.map((i) => i.text),
        // A redraft from nothing starts its parameters from nothing too.
        parameters: view.fresh ? [] : this.allParameters(),
        locked: view.locked,
        authored: this.authoredOf(view.items).indices,
        edited: this.editedOf(view.items),
        stepActions: view.items.map((i) => (i.authorId !== undefined ? null : numbers(i.actions))),
        ...(view.insertAt !== undefined && !view.fresh && { insertAt: view.insertAt }),
        ...(view.alsoByAuthor && { alsoByAuthor: view.alsoByAuthor }),
        ...(view.alsoEdited && {
          alsoEdited: view.alsoEdited.map((i) => ({ step: i.text, actions: numbers(i.actions) })),
        }),
      },
      firstActionNumber: index + 1,
      actionNumbers: actions.map((a) => numberOf.get(a.id) ?? index + 1),
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
   * Is an incremental answer's `replaceFrom` inside the draft the model saw,
   * no more than three steps back, and past every lock, every step of the
   * author's and every step they reworded?
   */
  private acceptable(replaceFrom: number | undefined, view: View): replaceFrom is number {
    const items = view.items;
    if (items.length === 0) return true; // nothing to reach back into: 0
    if (replaceFrom === undefined) return false;
    const floor = Math.max(
      0,
      items.length - RECORD_DRAFT_REWRITE_LIMIT,
      view.locked,
      ...this.authoredOf(items).indices.map((i) => i + 1),
      ...this.editedOf(items).map((i) => i + 1),
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
      // A redraft of nothing — every action in it was dropped, or is one a
      // rewording of the author's stands for. No call needed: only the
      // author's steps are left there.
      if (work.kind === 'open-redraft' || work.kind === 'stretch') {
        const view = this.viewFor(work);
        const parameters = view.fresh ? [] : this.parameters;
        this.apply(
          work,
          { replaceFrom: 0, steps: [], stepActions: [], parameters, notes: [] },
          [],
          this.numbering(),
          view,
        );
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
      work,
    };
    if (!this.silent) {
      this.busyShown = true;
      this.opts.emit({ type: 'record:drafting', busy: true });
    }
    const stale = (): boolean => generation !== this.generation || abort.signal.aborted;
    try {
      const numberOf = this.numbering();
      const view = this.viewFor(work);
      let answer = await this.ask(view, actions, numberOf, abort.signal);
      if (stale()) return 'stale';
      if (work.kind === 'incremental' && !this.acceptable(answer.replaceFrom, view)) {
        // §8 with locks: reaching back more than three steps, or past a lock,
        // is refused, and the call is retried ONCE as a redraft of the OPEN
        // steps only. Said in the log, not the panel: the author sees the draft.
        logger.info(
          `[record-steps] draft answer refused (replaceFrom ${String(answer.replaceFrom)} on a ` +
            `${view.items.length}-step draft, ${view.locked} locked); redrafting the open steps`,
        );
        const retry: Work = { kind: 'open-redraft', ...(work.upTo !== undefined && { upTo: work.upTo }) };
        const all = this.actionsFor(retry);
        this.current.covers = new Set(all.map((a) => a.id));
        this.current.work = retry;
        const retryNumbers = this.numbering();
        const retryView = this.viewFor(retry);
        answer = await this.ask(retryView, all, retryNumbers, abort.signal);
        if (stale()) return 'stale';
        return this.apply(retry, answer, all, retryNumbers, retryView) ? 'ok' : 'stale';
      }
      return this.apply(work, answer, actions, numberOf, view) ? 'ok' : 'stale';
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

  /**
   * The actions each of the answer's steps stands for — as the model said,
   * when that holds up: every number one this call may give out (its own
   * actions, and the ones the steps it replaces stood for), each action in one
   * step at most, in the order the author acted. Else inferred: see
   * {@link infer}. Either way the events that ride with an action go with it.
   *
   * `held` are the actions the author's rewordings stand for — left out of
   * the call. A step the model tied to nothing but those re-describes one of
   * them (A4 says never), and is not written. Without a mapping that holds
   * up, an exact copy of a rewording's words (`reworded`) is taken for one
   * too.
   */
  private mapSteps(
    texts: readonly string[],
    stepActions: readonly number[][] | undefined,
    old: readonly Item[],
    available: readonly string[],
    held: ReadonlySet<string>,
    numberOf: ReadonlyMap<string, number>,
    reworded: ReadonlySet<string> = new Set(),
  ): Item[] {
    const checked = this.checkMapping(stepActions, texts.length, available, held, numberOf);
    let lists: string[][];
    let keep: boolean[];
    if (checked) {
      if (checked.drop.size > 0) {
        logger.info(
          `[record-steps] ${checked.drop.size} step(s) of the answer stood only for actions the author's reworded ` +
            'steps stand for; not written (A4)',
        );
      }
      keep = texts.map((_t, j) => !checked.drop.has(j));
      lists = checked.lists;
    } else {
      keep = texts.map((t) => !reworded.has(t.trim()));
      lists = [];
    }
    const kept = texts.map((text, j) => ({ text, j })).filter((s) => keep[s.j]);
    // "Unchanged in place": the same text at the same place among the steps
    // it replaces keeps that step's id.
    const same = kept.map((s, k) => {
      const before = old[k];
      return before && before.authorId === undefined && !before.edited && before.text === s.text ? before : null;
    });
    if (!checked) {
      const fixed = new Map<number, string[]>();
      const avail = new Set(available);
      same.forEach((before, k) => {
        if (before) fixed.set(k, before.actions.filter((a) => avail.has(a)));
      });
      lists = this.infer(kept.length, available, fixed);
    } else {
      lists = kept.map((s) => checked.lists[s.j]!);
    }
    lists = this.withRiders(lists, available);
    return kept.map((s, k) => ({
      id: same[k]?.id ?? `d${++this.stepSeq}`,
      text: s.text,
      actions: lists[k]!,
    }));
  }

  /** The model's `stepActions`, turned into action ids and checked — or null
   *  when it is missing or does not hold up. */
  private checkMapping(
    raw: readonly number[][] | undefined,
    count: number,
    available: readonly string[],
    held: ReadonlySet<string>,
    numberOf: ReadonlyMap<string, number>,
  ): { lists: string[][]; drop: Set<number> } | null {
    if (!raw || raw.length !== count) return null;
    const idOf = new Map<number, string>();
    for (const [id, n] of numberOf) idOf.set(n, id);
    const allowed = new Set([...available, ...held]);
    const seen = new Set<string>();
    const lists: string[][] = [];
    let last = -1;
    for (const numbers of raw) {
      const ids: string[] = [];
      for (const n of new Set(numbers)) {
        const id = idOf.get(n);
        if (id === undefined || !allowed.has(id) || seen.has(id)) return null;
        seen.add(id);
        ids.push(id);
      }
      const ordered = this.byOrder(ids);
      if (ordered.length > 0) {
        if (this.indexOfAction(ordered[0]!) <= last) return null;
        last = this.indexOfAction(ordered[ordered.length - 1]!);
      }
      lists.push(ordered);
    }
    const drop = new Set<number>();
    lists.forEach((l, j) => {
      if (l.length > 0 && l.every((id) => held.has(id))) drop.add(j);
    });
    return { lists: lists.map((l) => l.filter((id) => !held.has(id))), drop };
  }

  /**
   * The mapping when the model's does not hold up — conservatively: only this
   * call's actions (and the replaced steps'), only to this call's steps. Each
   * action with the events that ride with it is one group; the groups go to
   * the steps in order from the LAST — the newest step is the one the newest
   * action asked for — one each, and any earlier groups left over go to the
   * nearest step, the first (a focus click the step folded away, the menu a
   * "Click Payments in the main menu" opened). Steps kept unchanged in place
   * (`fixed`) keep what they stood for.
   */
  private infer(count: number, available: readonly string[], fixed: ReadonlyMap<number, string[]>): string[][] {
    const lists: string[][] = Array.from({ length: count }, (_x, k) => [...(fixed.get(k) ?? [])]);
    const taken = new Set([...fixed.values()].flat());
    const groups = this.groupsOf(available.filter((a) => !taken.has(a)));
    const free = lists.map((_l, k) => k).filter((k) => !fixed.has(k));
    const n = Math.min(free.length, groups.length);
    for (let i = 0; i < n; i++) lists[free[free.length - 1 - i]!] = [...groups[groups.length - 1 - i]!];
    if (groups.length > free.length && free.length > 0) {
      const first = free[0]!;
      lists[first] = this.byOrder([...groups.slice(0, groups.length - free.length).flat(), ...lists[first]!]);
    }
    return lists;
  }

  /** The events that ride with an action go with the step that claimed it —
   *  and when no step claimed the action but one step claimed the rest of its
   *  group, the action goes there too. A click no step claimed goes with the
   *  step that claimed what came next, when that is on the same element: the
   *  click into a field that a "Type … into the Email field" step folded
   *  away is that step's (review round 2, finding 2) — else a delete of the
   *  step left it behind, and the next redraft wrote it back as "Click the
   *  Email field". */
  private withRiders(lists: string[][], available: readonly string[]): string[][] {
    const owner = new Map<string, number>();
    lists.forEach((l, k) => l.forEach((id) => owner.set(id, k)));
    const out = lists.map((l) => [...l]);
    const groups = this.groupsOf(available);
    const ownerOf = (group: readonly string[]): number | undefined => {
      const action = group.find((id) => this.isAction(id));
      const direct = action !== undefined ? owner.get(action) : undefined;
      if (direct !== undefined) return direct;
      const owners = new Set(group.map((id) => owner.get(id)).filter((o): o is number => o !== undefined));
      return owners.size === 1 ? [...owners][0] : undefined;
    };
    for (const group of groups) {
      const target = ownerOf(group);
      if (target === undefined) continue;
      for (const id of group) {
        if (owner.has(id)) continue;
        owner.set(id, target);
        out[target]!.push(id);
      }
    }
    // From the last back, so a run of clicks into one field all follow.
    for (let g = groups.length - 2; g >= 0; g--) {
      const action = groups[g]!.find((id) => this.isAction(id));
      if (action === undefined || owner.has(action)) continue;
      const click = this.actions[this.indexOfAction(action)];
      if (click?.kind !== 'click') continue;
      const next = groups[g + 1]!;
      const target = ownerOf(next);
      if (target === undefined || !sameElement(click, this.actions[this.indexOfAction(next[0]!)])) continue;
      owner.set(action, target);
      out[target]!.push(action);
    }
    return out.map((l) => this.byOrder(l));
  }

  /** The answer without exact copies of the steps the author wrote in
   *  `window` — theirs, and never written a second time (A2). (A copy of a
   *  REWORDED step is `mapSteps`'s to judge: with a mapping that holds up it
   *  may be a repeat of the action, which gets its own step, I10.) */
  private withoutCopies(answer: DraftAnswer, window: readonly Item[]): { steps: string[]; stepActions?: number[][] } {
    const theirs = new Set(window.filter((i) => i.authorId !== undefined).map((i) => i.text.trim()));
    const keep = answer.steps.map((t) => !theirs.has(t.trim()));
    return {
      steps: answer.steps.filter((_t, j) => keep[j]),
      ...(answer.stepActions && { stepActions: answer.stepActions.filter((_l, j) => keep[j]) }),
    };
  }

  /**
   * Apply one answer. False when it no longer fits: an ordinary call's answer
   * replaces the steps it was shown from `replaceFrom` on, and one of those
   * was edited, deleted or put back while it ran — it is asked again.
   */
  private apply(
    work: Work,
    answer: DraftAnswer,
    actions: readonly RecordedAction[],
    numberOf: ReadonlyMap<string, number>,
    view: View,
  ): boolean {
    const fresh = (work.kind === 'open-redraft' || work.kind === 'stretch') && view.fresh;
    const callIds = actions.map((a) => a.id);
    const held = this.heldActions();
    switch (work.kind) {
      case 'incremental': {
        const open = this.openStretch;
        // The steps the answer replaces, as the model saw them — and where
        // they are now. They must still be the open stretch's last steps,
        // untouched; the ones before them may have moved.
        const from = view.items.length === 0 ? 0 : answer.replaceFrom!;
        const replaced = view.items.slice(from);
        if (replaced.length > open.items.length) return false;
        const tail = open.items.length - replaced.length;
        for (let j = 0; j < replaced.length; j++) {
          const now = open.items[tail + j]!;
          const then = replaced[j]!;
          if (now.id !== then.id || now.text !== then.text || now.edited || now.authorId !== undefined) return false;
        }
        const region = open.items.slice(tail);
        const available = this.byOrder([...region.flatMap((i) => i.actions), ...callIds]).filter(
          (a) => !this.dropped.has(a) && !held.has(a),
        );
        // A4 holds here too (review round 2, finding 8): a step tied to
        // nothing but a rewording's actions, or — with no mapping that holds
        // up — an exact copy of its words, re-describes it, and is not written.
        const reworded = new Set(open.items.filter((i) => i.edited).map((i) => i.text.trim()));
        const made = this.mapSteps(answer.steps, answer.stepActions, region, available, held, numberOf, reworded);
        open.items = [...open.items.slice(0, tail), ...made];
        for (const a of callIds) open.covered.add(a);
        open.version++;
        break;
      }
      case 'open-redraft':
      case 'stretch': {
        const s = work.kind === 'stretch' ? work.stretch : this.openStretch;
        const oldModel = s.items.filter((i) => i.authorId === undefined && !i.edited);
        const available = callIds.filter((a) => !held.has(a));
        const clean = this.withoutCopies(answer, s.items);
        const reworded = new Set(s.items.filter((i) => i.edited).map((i) => i.text.trim()));
        const made = this.mapSteps(clean.steps, clean.stepActions, oldModel, available, held, numberOf, reworded);
        s.items = this.withKept(s.items, made);
        const upTo = work.kind === 'open-redraft' && work.upTo !== undefined ? work.upTo : Number.POSITIVE_INFINITY;
        const heldHere = [...held].filter((a) => {
          const at = this.indexOfAction(a);
          return at >= s.startAt && at < Math.min(s.endAt, upTo);
        });
        s.covered = new Set([...callIds, ...heldHere]);
        s.dirty = false;
        s.version++;
        break;
      }
      case 'gap': {
        const s = work.stretch;
        const cut = trailingAuthorStart(s.items);
        const available = callIds.filter((a) => !held.has(a));
        const clean = this.withoutCopies(answer, s.items);
        const reworded = new Set(s.items.filter((i) => i.edited).map((i) => i.text.trim()));
        const made = this.mapSteps(clean.steps, clean.stepActions, [], available, held, numberOf, reworded);
        s.items = [...s.items.slice(0, cut), ...made, ...s.items.slice(cut)];
        for (const a of callIds) s.covered.add(a);
        s.version++;
        break;
      }
    }
    // The parameter rules, enforced over the whole draft — the author's lines
    // and rewordings are theirs and are never rewritten by them.
    const items = this.flatItems();
    const merged: RecordStepsAnswer = {
      steps: items.map((i) => i.text),
      parameters: answer.parameters,
      notes: answer.notes,
    };
    const settled = settleParameters(merged, this.opts.file);
    items.forEach((item, i) => {
      if (item.authorId === undefined && !item.edited) item.text = settled.steps[i]!;
    });
    // The model was shown the author's own parameters and may hand them back:
    // they stay the author's, in the draft for as long as their step is.
    this.parameters = settled.parameters.filter((p) => !this.authorsOnly(p));
    this.keptNotes = [...new Set([...(fresh ? [] : this.keptNotes), ...settled.notes])];
    this.emitDraft();
    return true;
  }

  /**
   * A redraft's new steps with the stretch's steps that are the author's put
   * back: the ones at its edge after them; a rewording by where its actions
   * are among the new steps; the rest (an editor line typed between two
   * recorded steps, a rewording whose actions were all dropped) at the index
   * they had among its steps.
   */
  private withKept(old: readonly Item[], fresh: readonly Item[]): Item[] {
    const edge = trailingAuthorStart(old);
    const out = [...fresh];
    const byOffset: Array<{ item: Item; offset: number }> = [];
    old.slice(0, edge).forEach((item, offset) => {
      if (item.authorId !== undefined) {
        byOffset.push({ item, offset });
        return;
      }
      if (!item.edited) return;
      const order = this.firstOrder(item);
      if (order === undefined) byOffset.push({ item, offset });
      else out.splice(this.slotFor(out, order), 0, item);
    });
    for (const { item, offset } of byOffset) out.splice(Math.min(offset, out.length), 0, item);
    return [...out, ...old.slice(edge)];
  }

  /** A parameter that is one of the author's steps' or rewordings' (same name
   *  and value) and that none of the model's own steps uses. */
  private authorsOnly(p: { name: string; value: string }): boolean {
    const items = this.flatItems();
    const theirs =
      [...this.authors.values()].some((a) => a.parameters.some((q) => q.name === p.name && q.value === p.value)) ||
      items.some((i) => i.edited?.parameters.some((q) => q.name === p.name && q.value === p.value) === true);
    if (!theirs) return false;
    return !items.some((i) => i.authorId === undefined && !i.edited && placeholderRoots(i.text).has(p.name));
  }

  private emitDraft(): void {
    this.revision++;
    const items = this.flatItems();
    const steps = items.map((i) => i.text);
    const ids = items.map((i) => i.id);
    this.history.push({ revision: this.revision, steps, ids });
    if (this.history.length > MAX_DRAFT_HISTORY) this.history.shift();
    for (const item of items) {
      if (item.authorId !== undefined) continue;
      this.idActions.delete(item.id);
      this.idActions.set(item.id, [...item.actions]);
      this.idTexts.set(item.id, item.text);
    }
    while (this.idActions.size > MAX_REMEMBERED_IDS) {
      const oldest = this.idActions.keys().next().value!;
      this.idActions.delete(oldest);
      this.idTexts.delete(oldest);
    }
    if (this.silent) return;
    const notes = this.notes();
    const through = [...this.remaining].reverse().find((a) => this.isCovered(a.id))?.id;
    const { indices, ids: authoredIds } = this.authoredOf(items);
    this.opts.emit({
      type: 'record:draft',
      revision: this.revision,
      steps: [...steps],
      parameters: this.allParameters(),
      ...(notes.length > 0 && { notes }),
      ...(through !== undefined && { through }),
      locked: this.lockedCount,
      authored: indices,
      authoredIds,
      ids: [...ids],
      edited: this.editedOf(items),
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
