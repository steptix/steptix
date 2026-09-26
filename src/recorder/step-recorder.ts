import type { BrowserContext, CDPSession, Frame, Page } from 'playwright';
import { briefly, type BrowserSession } from '../browser/manager.js';
import { logger } from '../utils/logger.js';
import { MASK, redact, redactDeep } from '../utils/secrets.js';
import { cropAround } from './crop.js';
import { RECORD_BINDING_NAME, RECORD_CONTROL_NAME, recordStepsPageScript } from './page-script.js';
import { ACTION_KINDS } from './types.js';
import type {
  ActionCrop,
  Box,
  ElementDescription,
  FrameDescription,
  RecordActionKind,
  RecordedAction,
} from './types.js';

/**
 * The step recorder (stories/testbench-record-steps.md, decisions 4–7, 10).
 *
 * Watches ONE browser context — the session's active one — while a recording
 * runs: every page it has, every tab it opens, every frame in them. The page
 * script (`src/browser/scripts/record-steps.js`) describes what the author did
 * and reports it over one binding; this class numbers the actions, takes the
 * crop for each, notices typed navigation and tab changes, and hands each
 * finished action to `onAction` as it happens.
 *
 * It knows nothing about HTTP, the model or the session queue — that is
 * `RecordStepsRun` (./record-steps-run.ts).
 */

/** At most this many crops per recording (decision 6). */
export const MAX_CROPS = 40;

/**
 * A main-frame navigation within this long after the author touched the page
 * is taken to be CAUSED by that touch, not typed into the address bar.
 *
 * The fallback half of the rule, and the only half on a browser that cannot
 * give a CDP session (Firefox, WebKit). On Chromium the primary signal is
 * exact — `Page.frameRequestedNavigation` fires for every navigation the page
 * itself asked for (a link, a form, a script) and never for one the browser
 * started (the address bar, a bookmark, back/forward) — and a navigation must
 * pass BOTH to be recorded as typed. The window then only guards the gap where
 * the CDP event could be missed; three seconds covers a slow form post without
 * swallowing an address-bar visit the author makes a moment after a click that
 * went nowhere.
 */
export const TYPED_NAVIGATION_WINDOW_MS = 3_000;

/** A new tab that opened this soon after a touch was opened BY it, so its first
 *  load is part of that action rather than a typed navigation. */
const POPUP_FIRST_LOAD_MS = 15_000;

/**
 * A Back, Forward or Refresh within this long of a touch is taken to be the
 * PAGE's (`history.back()` or `location.reload()` in a click handler), not the
 * author's use of the browser's buttons. Shorter than the typed-navigation
 * window on purpose: a script's traversal lands in well under a second, while
 * a person who clicks a link and then presses Back takes longer than that —
 * and that is the common case this must not swallow.
 */
export const HISTORY_CAUSED_WINDOW_MS = 1_000;

/** How long a page's own navigation request is believed without a commit
 *  (a slow server can take this long; a request older than this is stale). */
const RENDERER_REQUEST_TTL_MS = 30_000;

/** Without CDP: how long a commit waits for the page's own history hint. */
const HISTORY_HINT_WAIT_MS = 500;

/** The tab's navigation history over CDP, or null when it cannot be read. */
async function readHistory(cdp: CDPSession): Promise<{ index: number; ids: number[] } | null> {
  try {
    const h = (await cdp.send('Page.getNavigationHistory')) as {
      currentIndex: number;
      entries: Array<{ id: number }>;
    };
    return { index: h.currentIndex, ids: h.entries.map((e) => e.id) };
  } catch {
    return null;
  }
}

/** Upper bound on any one page round-trip the recorder makes. */
const PAGE_CALL_MS = 2_500;

/** A typed value is kept to this many characters — cut after masking. */
const MAX_TYPED_VALUE = 2_000;

/** How long a crop waits for a frame to say where its secret fields are. A
 *  frame that does not answer in time costs the crop (see `secretBoxes`). */
const FIELD_RECTS_MS = 1_000;

/** CSS pixels added round every painted-out box: a frame's border, rounding
 *  and a focus ring must not leave a sliver of the value showing. */
const PAINT_MARGIN_PX = 3;

/** A secret the run already knows: its value, and its parameter name if any. */
export interface KnownSecret {
  name: string | null;
  value: string;
}

export interface StepRecorderOptions {
  /** The session's active browser — its context is what is watched. */
  browser: BrowserSession;
  /** `ai.sendScreenshots` as it resolves for this session: false takes none. */
  sendScreenshots: boolean;
  /** Secrets the run already knows (parameters, env), read fresh per use. */
  knownSecrets: () => KnownSecret[];
  onAction: (action: RecordedAction) => void;
  onPick: (armed: boolean) => void;
  /** The context closed under the recording — the author closed the browser. */
  onGone?: () => void;
  onWarning?: (message: string) => void;
  maxCrops?: number;
  /** Override {@link TYPED_NAVIGATION_WINDOW_MS} — tests only. */
  typedNavigationWindowMs?: number;
  /** Override {@link HISTORY_CAUSED_WINDOW_MS} — tests only. */
  historyCausedWindowMs?: number;
  /** Every message the binding receives, raw — for tests that must assert on
   *  what crossed from the page, not on what the recorder kept of it. */
  tap?: (message: unknown) => void;
  now?: () => number;
}

interface BindingSource {
  context: BrowserContext;
  page: Page;
  frame: Frame;
}

/**
 * One context's binding and init script — installed ONCE, because Playwright
 * can do nothing else: a second `exposeBinding` under the same name throws, and
 * there is no way to remove an init script. The binding dispatches to whichever
 * recorder is current, and says "not recording" when none is.
 */
interface ContextHook {
  current: StepRecorder | null;
  ready: Promise<void>;
}

const hooks = new WeakMap<BrowserContext, ContextHook>();

function ensureHook(context: BrowserContext): Promise<ContextHook> {
  let hook = hooks.get(context);
  if (!hook) {
    const created: ContextHook = { current: null, ready: Promise.resolve() };
    created.ready = (async () => {
      // Binding FIRST: Playwright installs a binding with its own init script,
      // so registering it before ours puts it on `window` by the time ours
      // runs at document start.
      await context.exposeBinding(RECORD_BINDING_NAME, (source: BindingSource, message: unknown) => {
        const recorder = created.current;
        if (!recorder) {
          return isRecord(message) && message['type'] === 'hello'
            ? { recording: false, pick: false }
            : null;
        }
        return recorder.onMessage(source, message);
      });
      await context.addInitScript({ content: recordStepsPageScript() });
    })();
    hooks.set(context, created);
    hook = created;
    // A failed install must not be remembered, or the next recording would
    // await the same rejection forever.
    created.ready.catch(() => {
      if (hooks.get(context) === created) hooks.delete(context);
    });
  }
  return hook.ready.then(() => hook!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A page string, whitespace-folded, MASKED, then clipped — in that order. The
 * page sends its text long for exactly this reason (record-steps.js,
 * `PAGE_CLIP_FLOOR`): clipped first, a secret that crossed the cut would
 * arrive as a prefix no mask could match (review, finding 8).
 */
function str(value: unknown, max: number, secrets: readonly string[] = []): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = redact(value.replace(/\s+/g, ' ').trim(), [...secrets]);
  if (s === '') return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Icon glyphs, emoji and their joiners at either end of a name. A link
 * labelled "💳 Transactions" is "Transactions" to a step writer — the model
 * copied the emoji into a step once (smoke run, review item 16), and a step
 * that names an element by its decoration breaks the moment the icon changes.
 */
const DECORATION =
  // Emoji and pictographs, their skin tones, variation selectors, joiners and
  // keycaps; icon-font glyphs (the Private Use Areas); arrows, bullets,
  // geometric shapes, dingbats and the chevrons "Next \u203A" and "\u00AB Back" wear.
  '\\s\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\uFE0E\\uFE0F\\u200D\\u20E3' +
  '\\u{E000}-\\u{F8FF}\\u{F0000}-\\u{FFFFD}\\u2190-\\u21FF\\u2022\\u25A0-\\u25FF\\u2600-\\u27BF' +
  '\\u2039\\u203A\\u00AB\\u00BB';
const EDGE_PICTOGRAPHS = new RegExp(`^[${DECORATION}]+|[${DECORATION}]+$`, 'gu');

export function stripEdgePictographs(text: string): string {
  return text.replace(EDGE_PICTOGRAPHS, '').trim();
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function box(value: unknown): Box | null {
  if (!isRecord(value)) return null;
  const x = num(value['x']);
  const y = num(value['y']);
  const width = num(value['width']);
  const height = num(value['height']);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
  if (width < 0 || height < 0 || width > 20_000 || height > 20_000) return null;
  return { x, y, width, height };
}

/**
 * The page's description, re-built field by field. The page is untrusted: what
 * it sends is clipped and typed here, and a field the recorder does not know is
 * never carried forward to the model.
 */
function sanitizeDescription(raw: unknown, secrets: readonly string[] = []): ElementDescription | undefined {
  if (!isRecord(raw)) return undefined;
  const tag = str(raw['tag'], 40);
  if (!tag) return undefined;
  const d: ElementDescription = { tag };
  const fields: Array<[keyof ElementDescription, number]> = [
    ['role', 40], ['name', 150], ['text', 150], ['inputType', 40], ['placeholder', 100],
    ['href', 200], ['id', 80], ['nameAttr', 80], ['testId', 80], ['title', 100],
    ['classes', 100], ['selector', 300],
  ];
  for (const [key, max] of fields) {
    const v = str(raw[key], max, secrets);
    if (v !== undefined) (d as unknown as Record<string, unknown>)[key] = v;
  }
  // The name and text without their decoration; the raw name kept beside it
  // when that changed something, for a model that needs to know it was there.
  for (const key of ['name', 'text'] as const) {
    const v = d[key];
    if (v === undefined) continue;
    const bare = stripEdgePictographs(v);
    if (bare === v) continue;
    if (key === 'name') d.rawName = v;
    if (bare === '') delete d[key];
    else d[key] = bare;
  }
  if (raw['disabled'] === true) d.disabled = true;
  if (raw['inFrame'] === true) d.inFrame = true;
  if (isRecord(raw['context'])) {
    const c = raw['context'];
    const ctx: NonNullable<ElementDescription['context']> = {};
    for (const key of ['dialog', 'menu', 'fieldset', 'landmark', 'row', 'column', 'heading'] as const) {
      const v = str(c[key], 120, secrets);
      if (v !== undefined) ctx[key] = v;
    }
    if (Object.keys(ctx).length > 0) d.context = ctx;
  }
  return d;
}

function strings(
  value: unknown,
  maxItems: number,
  maxLen: number,
  secrets: readonly string[] = [],
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    const s = typeof item === 'string' ? redact(item, [...secrets]).slice(0, maxLen) : undefined;
    if (s !== undefined) out.push(s);
  }
  return out;
}

const PAGE_KINDS = new Set<RecordActionKind>(['click', 'type', 'select', 'tick', 'untick', 'key', 'upload', 'drag']);
/** Enter and Tab are actions; no other key is recorded (Escape included). */
const KEYS = new Set(['Enter', 'Tab']);

/** How an element reads in a one-line summary: `button "Sign in"`. */
function targetPhrase(t: ElementDescription | undefined): string {
  if (!t) return 'the page';
  const role = t.role || t.tag;
  const label = t.name || t.text || t.rawName || t.placeholder || t.title || t.nameAttr || t.id || '';
  const short = label.length > 60 ? `${label.slice(0, 59)}…` : label;
  return short ? `${role} "${short}"` : role;
}

function quoteShort(value: string, max = 60): string {
  const s = value.replace(/\s+/g, ' ');
  return `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;
}

/**
 * The panel line for one action (`record:action.summary`). With `secrets`,
 * the action is masked BEFORE its text is shortened for the line — the other
 * order leaves a secret's first sixty characters on screen, a prefix no mask
 * can match (review, finding 8). The recorder also masks at intake, so this is
 * the second of two.
 */
export function summarizeAction(a: Omit<RecordedAction, 'summary'>, secrets: readonly string[] = []): string {
  if (secrets.length > 0) {
    const masked = redactDeep(a, [...secrets]);
    return redact(summarizeAction(masked), [...secrets]);
  }
  const phrase = targetPhrase(a.target);
  switch (a.kind) {
    case 'click':
      return `Clicked ${phrase}${a.focusOnly ? ' (into the field)' : ''}`;
    case 'type':
      if (a.secret) return `Typed ${MASK} into ${phrase}`;
      if (!a.value) return `Cleared ${phrase}`;
      return `Typed ${quoteShort(a.value)} into ${phrase}`;
    case 'select':
      return `Selected ${(a.options ?? []).map((o) => quoteShort(o, 40)).join(', ') || 'nothing'} in ${phrase}`;
    case 'tick':
      return a.target?.role === 'radio' || a.target?.inputType === 'radio' ? `Chose ${phrase}` : `Ticked ${phrase}`;
    case 'untick':
      return `Unticked ${phrase}`;
    case 'key':
      return `Pressed ${a.shift ? 'Shift+' : ''}${a.key ?? 'a key'}${a.target ? ` in ${phrase}` : ''}`;
    case 'upload':
      return `Chose ${(a.files ?? []).join(', ') || 'no file'} for ${phrase}`;
    case 'navigate':
      return `Navigated to ${a.url ?? '(unknown)'}`;
    case 'tab': {
      const where = [a.title ? quoteShort(a.title) : '', a.url ?? ''].filter(Boolean).join(' ');
      return a.tabEvent === 'opened'
        ? `Opened a new tab ${a.tab}${where ? ` — ${where}` : ''}`
        : `Moved to tab ${a.tab}${where ? ` — ${where}` : ''}`;
    }
    case 'drag':
      return `Dragged ${phrase} onto ${targetPhrase(a.dropTarget)}`;
    case 'back':
      return `Went back${a.url ? ` to ${a.url}` : ''}`;
    case 'forward':
      return `Went forward${a.url ? ` to ${a.url}` : ''}`;
    case 'reload':
      return `Reloaded the page${a.url ? ` — ${a.url}` : ''}`;
    case 'check': {
      const said = a.check?.secret
        ? MASK
        : a.check?.value ?? a.check?.text ?? (a.check?.checked !== undefined ? (a.check.checked ? 'ticked' : 'not ticked') : '');
      return `Check: ${phrase}${said ? ` — ${quoteShort(said)}` : ''}`;
    }
  }
}

/** An action before the recorder numbers it, times it, labels its tab and
 *  decides whether it is an ACTION. */
type PartialAction = Omit<RecordedAction, 'id' | 'atMs' | 'summary' | 'tab' | 'action'>;

/** Per-page navigation bookkeeping. */
interface PageWatch {
  page: Page;
  cdp: CDPSession | null;
  mainFrameId: string | null;
  /** When the page itself last asked its main frame to navigate (Chromium).
   *  Cleared by the commit; by the load stopping without one (a 204, a
   *  cancelled navigation); by a navigation the page did NOT ask for starting
   *  in its place (the author's Reload or Back superseding it); by a
   *  same-document commit to the address it asked for — and not believed
   *  after {@link RENDERER_REQUEST_TTL_MS} (review, finding 5). */
  rendererNavAt: number | null;
  /** Where that request was going. */
  rendererNavUrl: string | null;
  /** The request's own navigation has started (`frameStartedNavigating`). */
  requestStarted: boolean;
  /** A load started after that request: its stop without a commit ends it. */
  loadAfterRequest: boolean;
  /** A popup's first load is part of the click that opened it. */
  skipFirstCommitUntil: number;
  lastUrl: string;
  /** The tab's navigation history as last read over CDP: the current index,
   *  and every entry's id — what tells Back from Forward from Reload from a
   *  new navigation (`classifyHistoryMove`). Null without CDP. */
  history: { index: number; ids: number[] } | null;
  /** Without CDP: when the page last said a document arrived by history or
   *  reload, so the typed-navigation check does not also call it `navigate`. */
  historyHintAt: number;
  detach: () => void;
}

/** What a navigation was, read from the tab's history before and after. */
export type HistoryMove = 'back' | 'forward' | 'reload' | 'new';

/**
 * Classify one navigation from the tab's navigation history
 * (`Page.getNavigationHistory`) before and after it.
 *
 * Entry ids are stable per entry, which is the whole trick: a move to an index
 * whose entry existed before with the same id is a traversal — Back when the
 * index went down, Forward when it went up — and the same index with the same
 * id is a Reload. Anything else (a new id at the index: a link, a typed
 * address, `location.replace`, `pushState`) is a new navigation. Exported for
 * the unit test that pins it.
 */
export function classifyHistoryMove(
  before: { index: number; ids: number[] } | null,
  after: { index: number; ids: number[] },
): HistoryMove {
  if (!before) return 'new';
  const sameEntry = before.ids[after.index] !== undefined && before.ids[after.index] === after.ids[after.index];
  if (!sameEntry) return 'new';
  if (after.index < before.index) return 'back';
  if (after.index > before.index) return 'forward';
  return 'reload';
}

/** Two addresses that differ only after `#`. */
function pathOnlyHash(a: string, b: string): boolean {
  const strip = (u: string): string => u.replace(/#.*$/, '');
  return strip(a) === strip(b);
}

function isWebUrl(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

export class StepRecorder {
  private readonly context: BrowserContext;
  private readonly now: () => number;
  private readonly maxCrops: number;
  private readonly navWindowMs: number;
  private readonly historyWindowMs: number;
  private active = false;
  private pickArmed = false;
  private stopped = false;
  /** Cancelled: work still in flight finishes into nothing (review, finding 10). */
  private discarding = false;
  private startedAt = 0;
  /** When this recorder switched on — before the open frames were brought in,
   *  so a document older than this is one that was already there. */
  private activeSince = Number.POSITIVE_INFINITY;
  private seq = 0;
  private cropsTaken = 0;
  private warnedCropCap = false;
  private lastInteractionAt = Number.NEGATIVE_INFINITY;
  private lastActingPage: Page | null = null;
  private readonly openedSinceLastAction = new Set<Page>();
  private readonly crops = new Map<string, Promise<ActionCrop | null>>();
  private readonly watches = new Map<Page, PageWatch>();
  private readonly frameCache = new WeakMap<Frame, FrameDescription>();
  private readonly recorded: RecordedAction[] = [];
  private chain: Promise<void> = Promise.resolve();
  private hook: ContextHook | null = null;

  constructor(private readonly opts: StepRecorderOptions) {
    this.context = opts.browser.context;
    this.now = opts.now ?? Date.now;
    this.maxCrops = opts.maxCrops ?? MAX_CROPS;
    this.navWindowMs = opts.typedNavigationWindowMs ?? TYPED_NAVIGATION_WINDOW_MS;
    this.historyWindowMs = opts.historyCausedWindowMs ?? HISTORY_CAUSED_WINDOW_MS;
  }

  /** Every action recorded so far, in order. */
  get actions(): readonly RecordedAction[] {
    return this.recorded;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Install (once per context), switch this recorder on, and bring every open
   * frame into it. Answers the page the recording starts on.
   */
  async start(): Promise<{ url: string; title: string }> {
    const hook = await ensureHook(this.context);
    if (hook.current && hook.current !== this) {
      throw new Error('Another recording is already running in this browser.');
    }
    hook.current = this;
    this.hook = hook;
    this.active = true;
    this.activeSince = this.now();
    this.context.on('page', this.onPage);
    this.context.on('close', this.onContextClose);

    for (const page of this.context.pages()) await this.attachPage(page);
    await this.injectIntoOpenFrames();

    const page = this.opts.browser.pageTracker.getActive();
    this.lastActingPage = page;
    const title = await briefly(page.title(), PAGE_CALL_MS, '');
    this.startedAt = this.now();
    return { url: page.url(), title };
  }

  /** Add check: the next click anywhere is picked, not performed. */
  armPick(): boolean {
    if (!this.active) return false;
    this.pickArmed = true;
    void this.pushState();
    this.opts.onPick(true);
    return true;
  }

  cancelPick(): boolean {
    if (!this.active) return false;
    const was = this.pickArmed;
    this.pickArmed = false;
    void this.pushState();
    if (was) this.opts.onPick(false);
    return true;
  }

  /**
   * Stop: collect every field still being typed into (the page RETURNS those
   * rather than sending them, so none is lost to the race with "stop"), make
   * the script inert, and wait for every action already in flight.
   */
  async stop(): Promise<RecordedAction[]> {
    if (this.stopped) return [...this.recorded];
    for (const page of this.context.pages()) {
      for (const frame of page.frames()) {
        const pending = await briefly<unknown>(
          frame.evaluate(
            `(window[${JSON.stringify(RECORD_CONTROL_NAME)}] && window[${JSON.stringify(RECORD_CONTROL_NAME)}].flush()) || []`,
          ),
          PAGE_CALL_MS,
          [],
        );
        if (!Array.isArray(pending)) continue;
        for (const item of pending) {
          this.enqueue(() => this.ingestPageAction({ context: this.context, page, frame }, item));
        }
      }
    }
    await this.deactivate();
    await this.chain;
    return [...this.recorded];
  }

  /** End without collecting anything further. */
  async cancel(): Promise<void> {
    this.discarding = true;
    if (this.stopped) return;
    await this.deactivate();
  }

  // ── The binding ────────────────────────────────────────────────────────

  /** Called by the context's binding for every message from any frame. */
  onMessage(source: BindingSource, message: unknown): unknown {
    this.opts.tap?.(message);
    if (!isRecord(message)) return null;
    const type = message['type'];
    if (type === 'hello') {
      // Without CDP, a new top document says how it came to be. Only one that
      // started during the recording counts — the frames already open when
      // Record was pressed say hello too, about how THEY arrived.
      const navType = message['navType'];
      const age = num(message['docAgeMs']);
      if (
        this.active &&
        source.frame === source.page.mainFrame() &&
        (navType === 'reload' || navType === 'back_forward') &&
        age !== undefined &&
        this.now() - age >= this.activeSince
      ) {
        this.historyHint(source.page, navType === 'reload' ? 'reload' : 'back');
      }
      return { recording: this.active, pick: this.active && this.pickArmed };
    }
    if (!this.active) return null;
    if (type === 'history') {
      if (source.frame === source.page.mainFrame()) this.historyHint(source.page, 'back');
      return null;
    }
    // What can CAUSE a navigation opens the typed-navigation window: a
    // pointer-down or first keystroke (a mark), a pick, and the actions that
    // follow a touch. A finished field of typing does not — it is reported on
    // focus-out, which is exactly what clicking into the address bar causes.
    if (type === 'mark' || type === 'pick' ||
        (type === 'action' && isRecord(message['action']) && message['action']['kind'] !== 'type')) {
      this.lastInteractionAt = this.now();
    }
    if (type === 'mark') {
      const mark = str(message['mark'], 64);
      const b = box(message['box']);
      if (mark && b) this.startCrop(source, mark, b);
      return null;
    }
    if (type === 'action') {
      const raw = message['action'];
      this.enqueue(() => this.ingestPageAction(source, raw));
      return null;
    }
    if (type === 'pick') {
      // Disarmed at once, everywhere: the page that took the pick has already
      // disarmed itself, and no other frame may take a second one.
      this.pickArmed = false;
      void this.pushState();
      const raw = message['pick'];
      this.enqueue(() => this.ingestPick(source, raw));
      return null;
    }
    return null;
  }

  // ── Actions ────────────────────────────────────────────────────────────

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((err: unknown) => {
      logger.debug(`[record-steps] action dropped: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private secretValuesNow(): string[] {
    return this.secretsNow().map((s) => s.value);
  }

  private secretsNow(): KnownSecret[] {
    try {
      return this.opts.knownSecrets().filter((s) => s.value.length > 0);
    } catch {
      return [];
    }
  }

  private addAction(partial: PartialAction, page: Page): RecordedAction | null {
    // After cancel, whatever was still in flight (a crop being taken, a tab
    // title being read) finishes into nothing: no frame may follow `done`.
    if (this.discarding) return null;
    const withMeta: Omit<RecordedAction, 'summary'> = {
      ...partial,
      id: `a${++this.seq}`,
      atMs: Math.max(0, this.now() - this.startedAt),
      tab: this.labelOf(page),
      action: ACTION_KINDS.has(partial.kind),
    };
    const summary = summarizeAction(withMeta, this.secretValuesNow());
    const action: RecordedAction = { ...withMeta, summary };
    this.recorded.push(action);
    this.opts.onAction(action);
    return action;
  }

  private labelOf(page: Page): string {
    const tracked = this.opts.browser.pageTracker.tabs().find((t) => t.page === page);
    return tracked?.label ?? 'page:?';
  }

  /** The author acted on `page`. A different tab from last time is a move —
   *  unless that tab opened since, which the `opened` action already says. */
  private async noteActingPage(page: Page): Promise<void> {
    if (this.discarding) return;
    const previous = this.lastActingPage;
    if (previous && previous !== page && !this.openedSinceLastAction.has(page)) {
      const title = await briefly(page.title(), PAGE_CALL_MS, '');
      this.addAction({ kind: 'tab', tabEvent: 'moved', url: page.url(), ...(title && { title }) }, page);
    }
    if (previous !== page && !this.discarding) {
      // Follow the author: the session's active tab is where they left off, so
      // the next run step (or the next recording) starts there.
      const label = this.labelOf(page);
      if (label !== 'page:?') this.opts.browser.pageTracker.switchTo(label);
    }
    this.openedSinceLastAction.clear();
    this.lastActingPage = page;
  }

  private matchKnownSecret(value: string): KnownSecret | null {
    if (value === '') return null;
    for (const secret of this.secretsNow()) {
      if (secret.value === value) return secret;
    }
    return null;
  }

  private async claimCrop(mark: unknown): Promise<ActionCrop | undefined> {
    if (typeof mark !== 'string') return undefined;
    const pending = this.crops.get(mark);
    if (!pending) return undefined;
    this.crops.delete(mark);
    return (await pending) ?? undefined;
  }

  private async ingestPageAction(source: BindingSource, raw: unknown): Promise<void> {
    if (this.discarding || !isRecord(raw)) return;
    const kind = raw['kind'];
    if (typeof kind !== 'string' || !PAGE_KINDS.has(kind as RecordActionKind)) return;
    const secrets = this.secretValuesNow();
    const target = sanitizeDescription(raw['target'], secrets);
    const partial: PartialAction = {
      kind: kind as RecordActionKind,
      ...(target && { target }),
    };
    if (kind === 'type') {
      if (raw['secret'] === true) {
        partial.secret = true;
      } else if (typeof raw['value'] === 'string') {
        const value = raw['value'];
        // A value that IS a secret the run knows is withheld like a secret
        // field's, whatever the field is called (decision 7's spirit: the
        // model never sees it; the step names the parameter instead).
        const known = this.matchKnownSecret(value);
        if (known) {
          partial.secret = true;
          if (known.name) partial.knownSecret = known.name;
        } else {
          // A value that CONTAINS a known secret ("Bearer sk_…") keeps its
          // words and loses the secret — masked first, THEN cut to length,
          // so a secret across the cut cannot leave its first half behind.
          partial.value = redact(value, secrets).slice(0, MAX_TYPED_VALUE);
        }
      }
    }
    if (kind === 'click') {
      if (raw['focusOnly'] === true) partial.focusOnly = true;
      if (raw['keyboard'] === true) partial.keyboard = true;
    }
    if (kind === 'tick' || kind === 'untick') {
      const via = sanitizeDescription(raw['viaLabel'], secrets);
      if (via) partial.viaLabel = via;
    }
    if (kind === 'select') partial.options = strings(raw['options'], 20, 150, secrets) ?? [];
    if (kind === 'drag') {
      const dropTarget = sanitizeDescription(raw['dropTarget'], secrets);
      if (!dropTarget) return;
      partial.dropTarget = dropTarget;
      const dropCrop = await this.claimCrop(raw['dropMark']);
      if (dropCrop) partial.dropCrop = dropCrop;
    }
    if (kind === 'upload') partial.files = strings(raw['files'], 20, 200, secrets) ?? [];
    if (kind === 'key') {
      const key = raw['key'];
      if (typeof key !== 'string' || !KEYS.has(key)) return;
      partial.key = key;
      if (raw['shift'] === true) partial.shift = true;
    }
    const crop = await this.claimCrop(raw['mark']);
    if (crop) partial.crop = crop;
    const frame = await this.describeFrame(source);
    if (frame) partial.frame = frame;
    await this.noteActingPage(source.page);
    this.addAction(partial, source.page);
  }

  private async ingestPick(source: BindingSource, raw: unknown): Promise<void> {
    // Cancelled while this waited in the chain: not even the disarm frame.
    if (this.discarding) return;
    this.opts.onPick(false);
    if (!isRecord(raw)) return;
    const secrets = this.secretValuesNow();
    const target = sanitizeDescription(raw['target'], secrets);
    const check: NonNullable<RecordedAction['check']> = {};
    const text = str(raw['text'], 300, secrets);
    if (text !== undefined) check.text = text;
    if (raw['secret'] === true) {
      check.secret = true;
    } else if (typeof raw['value'] === 'string') {
      const value = raw['value'];
      if (this.matchKnownSecret(value)) check.secret = true;
      else check.value = redact(value, secrets).slice(0, 300);
    }
    if (typeof raw['checked'] === 'boolean') check.checked = raw['checked'];
    const selected = strings(raw['selected'], 20, 150, secrets);
    if (selected) check.selected = selected;
    if (isRecord(raw['container'])) {
      const c = raw['container'];
      const container: NonNullable<NonNullable<RecordedAction['check']>['container']> = {};
      const role = str(c['role'], 40, secrets);
      const name = str(c['name'], 120, secrets);
      const ctext = str(c['text'], 300, secrets);
      if (role) container.role = role;
      if (name) container.name = name;
      if (ctext) container.text = ctext;
      if (Object.keys(container).length > 0) check.container = container;
    }
    const partial: PartialAction = {
      kind: 'check',
      ...(target && { target }),
      check,
    };
    const crop = await this.claimCrop(raw['mark']);
    if (crop) partial.crop = crop;
    const frame = await this.describeFrame(source);
    if (frame) partial.frame = frame;
    await this.noteActingPage(source.page);
    this.addAction(partial, source.page);
  }

  private async describeFrame(source: BindingSource): Promise<FrameDescription | undefined> {
    const { frame, page } = source;
    if (frame === page.mainFrame()) return undefined;
    const cached = this.frameCache.get(frame);
    if (cached) return cached;
    const description: FrameDescription = { url: frame.url() };
    if (frame.name()) description.name = frame.name();
    try {
      const element = await briefly(frame.frameElement(), PAGE_CALL_MS, null);
      if (element) {
        const attrs: NonNullable<FrameDescription['element']> = {};
        for (const key of ['id', 'name', 'title'] as const) {
          const v = await briefly(element.getAttribute(key), PAGE_CALL_MS, null);
          if (v) attrs[key] = v.slice(0, 120);
        }
        if (Object.keys(attrs).length > 0) description.element = attrs;
      }
    } catch {
      // A detached frame still has its URL, which is most of what matters.
    }
    this.frameCache.set(frame, description);
    return description;
  }

  // ── Crops (decision 6) ─────────────────────────────────────────────────

  private startCrop(source: BindingSource, mark: string, target: Box): void {
    if (!this.opts.sendScreenshots) return;
    if (this.cropsTaken >= this.maxCrops) {
      if (!this.warnedCropCap) {
        this.warnedCropCap = true;
        this.opts.onWarning?.(
          `Record Steps took the ${this.maxCrops}-screenshot limit; the rest of the recording ` +
            'goes to the model as descriptions only.',
        );
      }
      return;
    }
    this.cropsTaken++;
    const pending = (async (): Promise<ActionCrop | null> => {
      const pageBox = { ...target };
      if (source.frame !== source.page.mainFrame()) {
        const element = await source.frame.frameElement();
        const offset = await element.boundingBox();
        if (!offset) return null;
        pageBox.x += offset.x;
        pageBox.y += offset.y;
      }
      const [png, paintOut] = await Promise.all([
        source.page.screenshot({ type: 'png', scale: 'css', timeout: 5_000 }),
        this.secretBoxes(source.page),
      ]);
      return cropAround(png, pageBox, paintOut);
    })().catch((err: unknown) => {
      logger.debug(`[record-steps] no crop for ${mark}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    this.crops.set(mark, pending);
  }

  /**
   * Where secrets are on screen, in page coordinates, across every frame of
   * the page: every field the page script calls secret (remembered, so a
   * password box its eye has flipped to text is included), and every other
   * field whose value contains a secret the run knows. The page reports field
   * boxes and the non-secret values; the comparison happens here, so the known
   * secrets never go into the page.
   *
   * Fails CLOSED: a frame that does not answer within {@link FIELD_RECTS_MS}
   * throws, and the crop is not kept — a picture whose secret fields could
   * not be located is not sent. A frame whose evaluate REJECTS (detached, or
   * mid-navigation) is showing nothing of its old document, and one with no
   * script to ask (`null`) has no fields this recording knows about; both
   * paint nothing.
   */
  private async secretBoxes(page: Page): Promise<Box[]> {
    const known = this.secretValuesNow().filter((v) => v.length >= 3);
    const ctl = JSON.stringify(RECORD_CONTROL_NAME);
    const GONE = Symbol('gone');
    const TIMED_OUT = Symbol('timed out');
    const out: Box[] = [];
    const grow = (b: Box, dx: number, dy: number): Box => ({
      x: b.x + dx - PAINT_MARGIN_PX,
      y: b.y + dy - PAINT_MARGIN_PX,
      width: b.width + 2 * PAINT_MARGIN_PX,
      height: b.height + 2 * PAINT_MARGIN_PX,
    });
    await Promise.all(
      page.frames().map(async (frame) => {
        const found = await briefly<unknown>(
          frame
            .evaluate(`(window[${ctl}] && window[${ctl}].fieldRects && window[${ctl}].fieldRects()) || null`)
            .catch(() => GONE),
          FIELD_RECTS_MS,
          TIMED_OUT,
        );
        if (found === TIMED_OUT) throw new Error(`a frame (${frame.url()}) did not say where its secret fields are`);
        if (!isRecord(found)) return;
        let dx = 0;
        let dy = 0;
        if (frame !== page.mainFrame()) {
          const element = await briefly(frame.frameElement(), FIELD_RECTS_MS, null);
          const at = element ? await briefly(element.boundingBox(), FIELD_RECTS_MS, null) : null;
          if (!at) return;
          dx = at.x;
          dy = at.y;
        }
        const secretList = Array.isArray(found['secret']) ? found['secret'] : [];
        for (const raw of secretList) {
          const b = box(raw);
          if (b) out.push(grow(b, dx, dy));
        }
        const fieldList = Array.isArray(found['fields']) ? found['fields'] : [];
        for (const f of fieldList) {
          if (!isRecord(f) || typeof f['value'] !== 'string') continue;
          const value = f['value'];
          if (!known.some((k) => value.includes(k))) continue;
          const b = box(f['box']);
          if (b) out.push(grow(b, dx, dy));
        }
      }),
    );
    return out;
  }

  // ── Pages, tabs and typed navigation ───────────────────────────────────

  private readonly onPage = (page: Page): void => {
    if (!this.active) return;
    const createdAt = this.now();
    const causedByTouch = createdAt - this.lastInteractionAt < this.navWindowMs;
    void this.attachPage(page, causedByTouch ? createdAt + POPUP_FIRST_LOAD_MS : 0);
    this.openedSinceLastAction.add(page);
    this.enqueue(async () => {
      await briefly(page.waitForLoadState('domcontentloaded', { timeout: 5_000 }), 5_500, undefined);
      const url = page.url();
      const title = await briefly(page.title(), PAGE_CALL_MS, '');
      this.addAction({ kind: 'tab', tabEvent: 'opened', ...(isWebUrl(url) && { url }), ...(title && { title }) }, page);
    });
  };

  private readonly onContextClose = (): void => {
    if (!this.active) return;
    this.active = false;
    this.opts.onGone?.();
  };

  private async attachPage(page: Page, skipFirstCommitUntil = 0): Promise<void> {
    if (this.watches.has(page)) return;
    const watch: PageWatch = {
      page,
      cdp: null,
      mainFrameId: null,
      rendererNavAt: null,
      rendererNavUrl: null,
      requestStarted: false,
      loadAfterRequest: false,
      skipFirstCommitUntil,
      lastUrl: page.url(),
      history: null,
      historyHintAt: Number.NEGATIVE_INFINITY,
      detach: () => {},
    };
    this.watches.set(page, watch);

    // Chromium: the exact signals — who asked for a navigation, and where in
    // the tab's own history it landed. Anything that goes wrong here falls
    // back to the time window and the page's own hints, which is what Firefox
    // and WebKit always get.
    try {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send('Page.enable');
      const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      watch.mainFrameId = tree.frameTree.frame.id;
      watch.history = await readHistory(cdp);
      const forgetRequest = (): void => {
        watch.rendererNavAt = null;
        watch.rendererNavUrl = null;
        watch.requestStarted = false;
        watch.loadAfterRequest = false;
      };
      const onRequested = (e: { frameId: string; url?: string; disposition?: string }): void => {
        if (e.frameId === watch.mainFrameId && (e.disposition ?? 'currentTab') === 'currentTab') {
          watch.rendererNavAt = this.now();
          watch.rendererNavUrl = typeof e.url === 'string' ? e.url : null;
          watch.requestStarted = false;
          watch.loadAfterRequest = false;
        }
      };
      // A requested navigation that never commits would otherwise leave the
      // request standing, and the author's NEXT Back, Reload or typed address
      // would be taken for the page's (review, finding 5). Three ways out:
      //
      // - superseded: a navigation starts that is not the one requested — the
      //   page's own request is always followed at once by ITS start, at the
      //   same address, so any other start is one the browser began: the
      //   author's Reload, Back or address bar, cutting the slow one short
      //   (measured, Chromium 147: no stop-loading comes between them);
      // - it stopped without committing — a 204, a download, an abort. Only a
      //   load that started after the request can end it, so a previous
      //   load's late stop cannot;
      // - a same-document commit to the address it asked for (a `#hash` link,
      //   on a Chromium that reports one as requested), in `onWithinDocument`.
      //
      // `Page.frameStartedNavigating` is recent; a Chromium without it still
      // gets the other two and the time limit.
      const onStartedNavigating = (e: { frameId: string; url?: string }): void => {
        if (e.frameId !== watch.mainFrameId || watch.rendererNavAt === null) return;
        if (!watch.requestStarted && (watch.rendererNavUrl === null || e.url === watch.rendererNavUrl)) {
          watch.requestStarted = true;
          return;
        }
        forgetRequest();
      };
      const onStartedLoading = (e: { frameId: string }): void => {
        if (e.frameId === watch.mainFrameId && watch.rendererNavAt !== null) watch.loadAfterRequest = true;
      };
      const onStoppedLoading = (e: { frameId: string }): void => {
        if (e.frameId !== watch.mainFrameId || !watch.loadAfterRequest) return;
        forgetRequest();
      };
      const onNavigated = (e: { frame: { id: string; parentId?: string; url: string; urlFragment?: string } }): void => {
        if (e.frame.parentId) return;
        watch.mainFrameId = e.frame.id;
        this.onMainCommit(watch, e.frame.url + (e.frame.urlFragment ?? ''), false);
      };
      // A same-document move — `pushState`, a `#hash`, and Back/Forward
      // between such entries — commits no new document, so `frameNavigated`
      // never hears it.
      const onWithinDocument = (e: { frameId: string; url: string }): void => {
        if (e.frameId !== watch.mainFrameId) return;
        this.onMainCommit(watch, e.url, true);
        if (watch.rendererNavAt !== null && watch.rendererNavUrl === e.url) forgetRequest();
      };
      cdp.on('Page.frameRequestedNavigation', onRequested);
      cdp.on('Page.frameStartedNavigating', onStartedNavigating);
      cdp.on('Page.frameStartedLoading', onStartedLoading);
      cdp.on('Page.frameStoppedLoading', onStoppedLoading);
      cdp.on('Page.frameNavigated', onNavigated);
      cdp.on('Page.navigatedWithinDocument', onWithinDocument);
      watch.cdp = cdp;
      watch.detach = () => {
        cdp.off('Page.frameRequestedNavigation', onRequested);
        cdp.off('Page.frameStartedNavigating', onStartedNavigating);
        cdp.off('Page.frameStartedLoading', onStartedLoading);
        cdp.off('Page.frameStoppedLoading', onStoppedLoading);
        cdp.off('Page.frameNavigated', onNavigated);
        cdp.off('Page.navigatedWithinDocument', onWithinDocument);
        void cdp.detach().catch(() => {});
      };
      return;
    } catch {
      watch.cdp = null;
    }
    const onFrameNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) this.onMainCommit(watch, frame.url(), false);
    };
    page.on('framenavigated', onFrameNavigated);
    watch.detach = () => page.off('framenavigated', onFrameNavigated);
  }

  /**
   * A main frame moved — a new document, or (`sameDocument`) a history entry
   * within one. What it was decides what is recorded:
   *
   * - **Back, Forward, Refresh** (decision 4 — actions). On Chromium the tab's
   *   own navigation history says which ({@link classifyHistoryMove}). One the
   *   PAGE caused is not the author's: a reload or traversal a script asked
   *   for (`frameRequestedNavigation`), or one within
   *   {@link HISTORY_CAUSED_WINDOW_MS} of a touch — `history.back()` in a
   *   click handler lands that fast, while a person moving to the toolbar
   *   does not.
   * - **An address typed into the bar** (`navigate`). A new navigation only
   *   when nothing on the page asked for it, the author did not touch the page
   *   in the typed-navigation window, it is not a popup's own first load, it
   *   lands on a web address and goes somewhere new.
   * - Anything else — a link, a form, `pushState`, a `#hash` — is the page
   *   following an action already recorded, and records nothing.
   *
   * Without CDP (Firefox, WebKit) the page script's hints stand in: the new
   * document's `performance` navigation type, `popstate` and a back/forward
   * cache restore ({@link historyHint}). Those cannot tell Back from Forward, so
   * a traversal there is recorded as `back`. The typed-navigation check waits
   * a moment for the hint, so a traversal is not ALSO called `navigate`.
   */
  private onMainCommit(watch: PageWatch, url: string, sameDocument: boolean): void {
    const t = this.now();
    const requestedByPage =
      watch.rendererNavAt !== null && t - watch.rendererNavAt < RENDERER_REQUEST_TTL_MS;
    if (!sameDocument) {
      watch.rendererNavAt = null;
      watch.rendererNavUrl = null;
      watch.requestStarted = false;
      watch.loadAfterRequest = false;
    }
    const previous = watch.lastUrl;
    watch.lastUrl = url;
    const sinceTouch = t - this.lastInteractionAt;
    let popupFirstLoad = false;
    if (!sameDocument && watch.skipFirstCommitUntil > 0) {
      popupFirstLoad = t < watch.skipFirstCommitUntil;
      watch.skipFirstCommitUntil = 0;
    }
    const page = watch.page;
    const typedNavigation = (): boolean =>
      !sameDocument &&
      !popupFirstLoad &&
      isWebUrl(url) &&
      !requestedByPage &&
      sinceTouch >= this.navWindowMs &&
      url !== previous;

    const cdp = watch.cdp;
    if (cdp) {
      // In the action chain, so a history read that takes a moment cannot put
      // this ahead of the click that came before it.
      this.enqueue(async () => {
        const before = watch.history;
        const after = await readHistory(cdp);
        if (after) watch.history = after;
        if (!this.active && !this.stopped) return;
        let move = after ? classifyHistoryMove(before, after) : 'new';
        // A same-document commit at the same entry is `history.replaceState`
        // — the page rewriting its own address — never the reload button,
        // which always makes a new document (review, finding 4).
        if (sameDocument && move === 'reload') move = 'new';
        if (move !== 'new') {
          if (popupFirstLoad || requestedByPage || sinceTouch < this.historyWindowMs) return;
          if (!isWebUrl(url)) return;
          await this.noteActingPage(page);
          this.addAction({ kind: move, url }, page);
          return;
        }
        if (!typedNavigation()) return;
        await this.noteActingPage(page);
        this.addAction({ kind: 'navigate', url }, page);
      });
      return;
    }

    if (!this.active) return;
    if (!typedNavigation() || pathOnlyHash(previous, url)) return;
    // Give the new document's hint (it rides the page's "hello") a moment to
    // arrive: a traversal or reload it reports is not a typed address.
    setTimeout(() => {
      if (Math.abs(watch.historyHintAt - t) < HISTORY_HINT_WAIT_MS * 3) return;
      this.enqueue(async () => {
        await this.noteActingPage(page);
        this.addAction({ kind: 'navigate', url }, page);
      });
    }, HISTORY_HINT_WAIT_MS);
  }

  /**
   * Without CDP: the page said a document or entry arrived by the browser's
   * history or a reload. Recorded as `back` (a traversal's direction is not
   * knowable from the page) or `reload`, unless a touch just before says the
   * page did it.
   */
  private historyHint(page: Page, move: 'back' | 'reload'): void {
    const watch = this.watches.get(page);
    if (!watch || watch.cdp) return; // Chromium reads the tab's own history instead.
    const t = this.now();
    watch.historyHintAt = t;
    if (t - this.lastInteractionAt < this.historyWindowMs) return;
    const url = page.url();
    this.enqueue(async () => {
      await this.noteActingPage(page);
      this.addAction({ kind: move, ...(isWebUrl(url) && { url }) }, page);
    });
  }

  // ── Frames ─────────────────────────────────────────────────────────────

  private async eachFrame(work: (frame: Frame) => Promise<unknown>): Promise<void> {
    const all: Promise<unknown>[] = [];
    for (const page of this.context.pages()) {
      for (const frame of page.frames()) {
        all.push(briefly(work(frame), PAGE_CALL_MS, undefined));
      }
    }
    await Promise.all(all);
  }

  /** The init script only reaches documents created from now on; every frame
   *  already open gets the same text evaluated into it, then is told the state
   *  (a frame a previous recording left its script in skips the install and
   *  would otherwise stay inert). */
  private async injectIntoOpenFrames(): Promise<void> {
    const script = recordStepsPageScript();
    await this.eachFrame((frame) => frame.evaluate(script).catch(() => undefined));
    await this.pushState();
  }

  private pushState(): Promise<void> {
    const state = JSON.stringify({ recording: this.active, pick: this.active && this.pickArmed });
    const ctl = JSON.stringify(RECORD_CONTROL_NAME);
    const expr = `(window[${ctl}] && window[${ctl}].setState(${state})) || false`;
    return this.eachFrame((frame) => frame.evaluate(expr).catch(() => undefined));
  }

  private async deactivate(): Promise<void> {
    this.stopped = true;
    this.active = false;
    this.pickArmed = false;
    await this.pushState();
    this.context.off('page', this.onPage);
    this.context.off('close', this.onContextClose);
    for (const watch of this.watches.values()) {
      try {
        watch.detach();
      } catch {
        // A page that already closed has nothing left to detach.
      }
    }
    this.watches.clear();
    if (this.hook?.current === this) this.hook.current = null;
  }
}
