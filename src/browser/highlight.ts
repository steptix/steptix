/**
 * The interaction highlight's Node side (docs/specs/SPEC-interaction-highlight.md).
 *
 * What lives here:
 *
 *  - **The setting.** `resolveHighlight` turns `browser.highlight` (a boolean
 *    or an object) into one complete shape, or `null` for off, the way
 *    `resolveVideoMode` normalises `browser.video`, so no read site writes
 *    `?? 3000`. `ringsOutOfScreenshots` and `reportAudience` decide who a
 *    run's pictures are for (§4.2).
 *  - **The sink.** `createHighlighter` (`highlighterFor` from a config) is
 *    what `executeAction`'s handlers call at the act (§2.2). `mark` is
 *    synchronous and returns nothing: it starts a `locator.evaluateAll` and
 *    never awaits it, so a step never waits for a ring and a ring can never
 *    fail a step (§5.1). It also runs the late-element wait (§5.5), with
 *    `frameOfLocator` naming the frame. `drawRings` draws directly.
 *  - **The records** of where a ring of ours may show (§4.3): per Page, per
 *    CDP tab through each registered connection (`registerCdpBrowser`,
 *    `pagesDetaching`), and `pageEverRinged` for the diagnosis fallback.
 *  - **Hiding.** `hiddenFor` takes the rings out of a screenshot whose image
 *    goes to a model (§4.2), `hiddenForReport` out of a report's when the
 *    config says so, and `endRings` removes them before `[use computer]`
 *    grabs the screen (§6), each through one registry call per frame
 *    (`onRegistry`). A ring left from the previous action would otherwise be
 *    page state the page does not have.
 *
 * The drawing itself is scripts/highlight.js, in the page.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ElementHandle, Frame, Locator, Page } from 'playwright';
import { logger } from '../utils/logger.js';

/**
 * The host element's tag. One constant for both page scripts that need it:
 * highlight.js creates the element, and capture-dom.js must skip it, or the AI
 * reads `<steptix-highlight>` in every snapshot taken while a ring is live
 * (§4.1, measured by the prototype in §15). Substituted into capture-dom.js
 * by dom-cleaner.ts, passed to highlight.js as an argument.
 */
export const HIGHLIGHT_TAG = 'steptix-highlight';

/** The `Symbol.for` key of the registry handle on the host (§3.3 item 9). */
export const HIGHLIGHT_REGISTRY_KEY = 'steptix.highlight';

/** What an action did to the element: act on it, or read or count it (§8). */
export type HighlightKind = 'act' | 'read';

/**
 * How many matches a read of every match or a count rings (§5.3, §13
 * decision 7). Fixed: those can match hundreds of elements, and twenty rings
 * already say "these".
 */
export const HIGHLIGHT_MANY_MAX = 20;

/** `browser.highlight` with every field present. */
export interface ResolvedHighlight {
  durationMs: number;
  colors: { act: string; read: string };
  /** Rings show in the report's screenshots (§4.2, §13 decision 2). Never
   *  in a model's: that is not a setting. */
  inScreenshots: boolean;
}

/** §7.1's defaults: three seconds, blue for act, violet for read, shown in
 *  report screenshots. */
export const HIGHLIGHT_DEFAULTS: ResolvedHighlight = {
  durationMs: 3000,
  colors: { act: '#3b82f6', read: '#a855f7' },
  inScreenshots: true,
};

/**
 * `browser.highlight` as `null` (off) or a complete {@link ResolvedHighlight}.
 *
 *   - `true` → on, with the defaults;
 *   - `false`, `undefined` → off (the latter for configs synthesised without
 *     `DEFAULT_CONFIG`: CDP, tests);
 *   - an object → on unless `enabled` is `false`; each field it leaves out
 *     takes its default.
 *
 * Anything else is off. The loader refuses it at load (`assertHighlight`), so
 * reaching here with one means a config built in code, and painting over the
 * page on a value nobody can read is the wrong guess.
 */
export function resolveHighlight(
  // Typed by what it reads rather than as `BrowserConfig`, which any config
  // satisfies. actions.ts imports this module and the report types import
  // actions.ts, so the Runner UI's renderer type-checks this file: a config
  // import here would pull the Node config types, and the ambient AI gateway
  // module they need, into that check.
  browser: { highlight?: unknown } | undefined,
): ResolvedHighlight | null {
  const value = browser?.highlight;
  if (value === true) return { ...HIGHLIGHT_DEFAULTS, colors: { ...HIGHLIGHT_DEFAULTS.colors } };
  if (value === null || typeof value !== 'object') return null;
  const object = value as {
    enabled?: unknown;
    durationMs?: unknown;
    colors?: { act?: unknown; read?: unknown };
    inScreenshots?: unknown;
  };
  if (object.enabled === false) return null;
  const colour = (written: unknown, fallback: string): string => (typeof written === 'string' ? written : fallback);
  return {
    durationMs: typeof object.durationMs === 'number' && Number.isFinite(object.durationMs)
      ? object.durationMs
      : HIGHLIGHT_DEFAULTS.durationMs,
    colors: {
      act: colour(object.colors?.act, HIGHLIGHT_DEFAULTS.colors.act),
      read: colour(object.colors?.read, HIGHLIGHT_DEFAULTS.colors.read),
    },
    inScreenshots: object.inScreenshots !== false,
  };
}

/**
 * `browser` with the rings kept out of every report capture: `inScreenshots:
 * false` written in, the rest as resolved. For a run whose "report" pictures
 * all go to a model — an errand writes no report, and its receipt hands its
 * screenshots to the agent that asked for it (§4.2). Unchanged when the
 * highlight is off.
 */
export function ringsOutOfScreenshots<B extends { highlight?: unknown }>(browser: B): B {
  const resolved = resolveHighlight(browser);
  // Off is written too, as `{ enabled: false, inScreenshots: false }`: this
  // run draws nothing, but a ring another caller drew on the same page a
  // moment ago (a `log_into_site`, the previous batch) must still stay out
  // of its pictures, and {@link reportAudience} reads the switch whatever
  // `enabled` says.
  if (resolved === null) {
    const written = browser.highlight;
    const kept = typeof written === 'object' && written !== null ? written : {};
    return { ...browser, highlight: { ...kept, enabled: false, inScreenshots: false } };
  }
  return { ...browser, highlight: { enabled: true, ...resolved, inScreenshots: false } };
}

/**
 * Who a run's report screenshots are for, from its own config: `'model'`
 * when `browser.highlight.inScreenshots` is `false` — the project's choice,
 * or a run whose pictures go back to a model (`ringsOutOfScreenshots`) — and
 * `'report'` otherwise. Read off the object whatever `enabled` says, so a
 * run that draws nothing still keeps out a ring someone else drew.
 *
 * The run's own answer is what decides, not the last highlighter to draw on
 * the page: a `run_steps` batch whose pictures go to an agent must hide a
 * ring a login drew with `inScreenshots: true` seconds earlier.
 */
export function reportAudience(browser: { highlight?: unknown } | undefined): 'model' | 'report' {
  const written = browser?.highlight;
  return typeof written === 'object' && written !== null
    && (written as { inScreenshots?: unknown }).inScreenshots === false
    ? 'model'
    : 'report';
}

/** What `executeAction`'s handlers are handed (`ExecuteActionOptions.highlight`). */
export interface HighlightSink {
  /**
   * Ring what `locator` matches now. Synchronous, returns nothing, and is not
   * to be awaited: call it immediately before the Playwright call that acts or
   * reads, on the FINAL locator — the stand-in label for a hidden toggle, not
   * the input (§2.2). Never from a probe: a ring means an action.
   *
   * `max` rings only the first `max` matches, in document order (§5.3).
   */
  mark(locator: Locator, kind: HighlightKind, max?: number, options?: MarkOptions): void;
}

/**
 * How a mark relates to the act it decorates. Without `settled` a mark rings
 * what is there now and nothing later.
 */
export interface MarkOptions {
  /**
   * Settles when the act does: `true` if it succeeded, `false` if it failed.
   * A mark that found nothing waits for its element only until then — the
   * act's own auto-wait is the one window in which a late element is the
   * act's — and draws once more when the act succeeded, because what it
   * acted on was there. A failed act, a navigation of the page, or the
   * five-second bound ends the wait with nothing drawn.
   */
  settled?: Promise<boolean>;
  /** `false`: never wait, even with `settled`. For a target that is "whatever
   *  has the focus", where a later element is a different target. */
  wait?: boolean;
}

/** Late-ring waits that may still draw: for tests, which must show a wait
 *  ended without sleeping to find out. */
let lateWaits = 0;
export function lateRingWaitsPending(): number {
  return lateWaits;
}

/** A sink that draws, and hides what it drew from a model's screenshot. */
export interface Highlighter extends HighlightSink {
  readonly settings: ResolvedHighlight;
  /** {@link hiddenFor} on this highlighter's clock. */
  hiddenFor<T>(page: Page, fn: () => Promise<T>): Promise<T>;
}

/** Injected for tests: the clock behind "was a ring drawn here recently". */
export interface HighlightClock {
  now?: () => number;
}

/** The arguments highlight.js takes. */
interface HighlightArgs {
  tag: string;
  key: string;
  /** Answer `{ drawn, href }` rather than the count alone. */
  withHref?: boolean;
  kind: HighlightKind;
  durationMs: number;
  colors: { act: string; read: string };
  max?: number;
}

/**
 * The page script as a function. highlight.js is one function expression, so
 * `return (<text>)` builds it from the text here and Playwright serialises it
 * back to that same text — no esbuild/TS helper can reach the page. A string
 * would not do: `evaluateAll` evaluates a string as an expression and never
 * calls the function it yields.
 */
function loadHighlightScript(): (elements: unknown[], args: HighlightArgs) => number {
  const url = new URL('./scripts/highlight.js', import.meta.url);
  const text = readFileSync(fileURLToPath(url), 'utf8');
  // The parenthesis opens on the `return` line: the file starts with comments,
  // and a line break straight after `return` would return undefined.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn: unknown = new Function(`return (\n${text}\n);`)();
  if (typeof fn !== 'function') throw new Error('scripts/highlight.js must be one function expression');
  return fn as (elements: unknown[], args: HighlightArgs) => number;
}

/**
 * Read on first use, not at import. This module is reachable from
 * `steptix/tools` (through the tool executor's page wrapper), and a project's
 * tool file is bundled with what it imports, so `import.meta.url` can be the
 * bundle's own location, with no scripts/ beside it. Reading at import made
 * every tool in such a bundle fail to load; read lazily, only a ring needs it.
 */
let highlightScript: ((elements: unknown[], args: HighlightArgs) => number) | undefined;
function highlightScriptFn(): (elements: unknown[], args: HighlightArgs) => number {
  highlightScript ??= loadHighlightScript();
  return highlightScript;
}

/**
 * Until when each page may still show a ring, on the clock of whichever
 * highlighter drew it, and whether the last one to draw there lets the rings
 * into report screenshots. Module-level, not per highlighter, because the
 * executor builds its options per action: the ring a step's last click drew
 * is still up for the next step's first capture, and that capture must know.
 */
let ringsOn = new WeakMap<Page, PageRecord>();

/** Pages already told about at debug level, so a page that refuses every
 *  ring says so once (§5.1). */
const noted = new WeakSet<Page>();

function noteOnce(page: Page, err: unknown): void {
  if (noted.has(page)) return;
  noted.add(page);
  let where = '';
  try {
    where = ` on ${page.url()}`;
  } catch {
    // A closed page has no URL to name.
  }
  const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
  logger.debug(`Highlight not drawn${where}: ${message} (said once per page)`);
}

/**
 * Draw the rings for what `locator` matches now, answering how many were
 * drawn. The sink does NOT await this; it is exported for the tests that
 * need to know the draw has happened before they look (§10.1 case 4).
 */
export function drawRings(
  locator: Locator,
  kind: HighlightKind,
  settings: ResolvedHighlight,
  max?: number,
): Promise<number> {
  const args: HighlightArgs = {
    tag: HIGHLIGHT_TAG,
    key: HIGHLIGHT_REGISTRY_KEY,
    kind,
    durationMs: settings.durationMs,
    colors: settings.colors,
    ...(max !== undefined && { max }),
  };
  return locator.evaluateAll(highlightScriptFn(), args) as Promise<number>;
}

/** {@link drawRings}, also answering the URL of the document that drew. */
function drawRingsAt(
  locator: Locator,
  kind: HighlightKind,
  settings: ResolvedHighlight,
  max?: number,
): Promise<{ drawn: number; href: string | null }> {
  const args: HighlightArgs = {
    tag: HIGHLIGHT_TAG,
    key: HIGHLIGHT_REGISTRY_KEY,
    withHref: true,
    kind,
    durationMs: settings.durationMs,
    colors: settings.colors,
    ...(max !== undefined && { max }),
  };
  return (locator.evaluateAll(highlightScriptFn() as never, args) as Promise<unknown>).then((answer) =>
    typeof answer === 'number'
      ? { drawn: answer, href: null }
      : {
          drawn: Number((answer as { drawn?: unknown })?.drawn) || 0,
          href: typeof (answer as { href?: unknown })?.href === 'string' ? (answer as { href: string }).href : null,
        });
}

/** A highlighter for these settings. `clock.now` is for tests. */
export function createHighlighter(settings: ResolvedHighlight, clock: HighlightClock = {}): Highlighter {
  const now = clock.now ?? Date.now;
  return {
    settings,
    mark(locator: Locator, kind: HighlightKind, max?: number, options?: MarkOptions): void {
      let page: Page;
      try {
        page = locator.page();
      } catch {
        return;
      }
      // "Drawn recently" is stamped before the draw is even issued, so a
      // capture racing the draw already hides; and stamped again when a draw
      // lands, so a ring that landed late — or after the wait below — is
      // hidden for its whole life, fade included. The margin covers the frames
      // between the page drawing and the clock reading.
      const stamp = (drewIn?: readonly Frame[]): void => {
        const until = now() + settings.durationMs + RING_CLOCK_MARGIN_MS;
        recordRing(page, until, settings.inScreenshots, now, drewIn);
      };
      stamp();
      // Counted as on its way until it answers (`trackDraw`): until then a
      // capture cannot know where or when its ring will appear.
      const draw = (): Promise<number> =>
        trackDraw(page, drawRingsAt(locator, kind, settings, max).then(({ drawn, href }) => {
          if (drawn > 0) stamp(framesThatDrew(page, locator, href));
          return drawn;
        }), now);
      // Fire and forget, issued just before the act so the ring appears as the
      // action happens. `evaluateAll`, not `evaluate`: it resolves the matches
      // there are now and returns at once, where `evaluate` would wait the
      // full timeout for an element that is gone (§3.3 item 1). A detached
      // frame, a context the action's own navigation destroyed, or a page that
      // tampered with `attachShadow` all land in the catch.
      //
      // An element that is not there yet — a dialog animating in, a row the
      // fetch has not delivered, the normal case for compiled code that acts
      // straight after the previous step — is the act's own auto-wait to find.
      // The ring waits for it only while the act does (`MarkOptions.settled`),
      // never awaited by anyone: an element that arrives after the act is not
      // the act's, whatever its selector says. Singular marks only: a read of
      // every match or a count has taken its matches already.
      const settled = options?.settled;
      const mayWait = settled !== undefined && max === undefined && options?.wait !== false;
      try {
        void draw()
          .then(async (drawn) => {
            if (drawn > 0 || !mayWait) return;
            if (await waitForLateElement(page, locator, settled)) await draw();
          })
          .catch((err: unknown) => noteOnce(page, err));
      } catch (err) {
        noteOnce(page, err);
      }
    },
    hiddenFor<T>(page: Page, fn: () => Promise<T>): Promise<T> {
      return hiddenFor(page, fn, { now });
    },
  };
}

/** A highlighter for `browser.highlight`, or undefined when it is off — for
 *  the call sites that hand a sink on rather than act. */
export function highlighterFor(browser: { highlight?: unknown } | undefined): Highlighter | undefined {
  const settings = resolveHighlight(browser);
  return settings === null ? undefined : createHighlighter(settings);
}

/**
 * Whether to draw once more for a mark that found nothing: `true` when the
 * element attached while the act was still waiting for it, or the act
 * succeeded (so what it acted on was there); `false` when the act failed,
 * the page navigated — a new document's element of the same selector is not
 * the one acted on — or the bound ran out.
 */
async function waitForLateElement(page: Page, locator: Locator, settled: Promise<boolean>): Promise<boolean> {
  lateWaits++;
  let finish: (draw: boolean) => void = () => {};
  const verdict = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  // `endRings` ends a wait outright: a ring that landed after `[use
  // computer]` took the rings down would be in the next screen grab.
  const cancel = (): void => finish(false);
  let pending = lateWaitsOn.get(page);
  if (!pending) {
    pending = new Set();
    lateWaitsOn.set(page, pending);
  }
  pending.add(cancel);
  // Navigation of the frame the locator resolves in — or of the main frame,
  // which takes every frame with it — ends the wait. Another frame's (an ad
  // rotating) says nothing about this element. `_frame` is Playwright's own
  // field for the locator's frame; when it is not there, the main frame alone.
  // A locator that enters a frame (`frameLocator(…).locator(…)`) resolves
  // from its OUTER frame, so for it any frame below that one counts too: the
  // element's own iframe navigating ends the wait. (A sibling iframe under
  // the same outer frame ends it as well, the cautious side.)
  const { frame: own, entersFrame } = frameOfLocator(locator);
  const onNavigated = (frame: Frame): void => {
    try {
      if (frame === own || frame === page.mainFrame()) finish(false);
      else if (entersFrame && own !== undefined && descendsFrom(frame, own)) finish(false);
    } catch {
      finish(false);
    }
  };
  try {
    page.on('framenavigated', onNavigated);
  } catch {
    // A page that cannot be listened to only loses the navigation guard.
  }
  void settled.then((ok) => finish(ok), () => finish(false));
  void locator
    .first()
    .waitFor({ state: 'attached', timeout: LATE_RING_WAIT_MS })
    .then(() => finish(true), () => finish(false));
  try {
    return await verdict;
  } finally {
    lateWaits--;
    pending.delete(cancel);
    try {
      page.off('framenavigated', onNavigated);
    } catch {
      // Nothing to undo.
    }
  }
}

/** The frame Playwright resolves `locator` from, and whether its selector
 *  goes on into a child frame. Exported for the test that pins Playwright's
 *  private `_frame` / `_selector`, so a rename is caught rather than silently
 *  turning the navigation guard into "main frame only". */
export function frameOfLocator(locator: Locator): { frame: Frame | undefined; entersFrame: boolean } {
  try {
    const internal = locator as unknown as { _frame?: Frame; _selector?: string };
    return {
      frame: internal._frame,
      entersFrame: typeof internal._selector === 'string' && internal._selector.includes('internal:control=enter-frame'),
    };
  } catch {
    return { frame: undefined, entersFrame: false };
  }
}

function descendsFrom(frame: Frame, ancestor: Frame): boolean {
  for (let f: Frame | null = frame.parentFrame(); f !== null; f = f.parentFrame()) {
    if (f === ancestor) return true;
  }
  return false;
}

/** The late waits still pending on each page, to cancel (`endRings`). */
let lateWaitsOn = new WeakMap<Page, Set<() => void>>();

/** Added to a ring's life on the "drawn recently" clock (`ringsOn`). */
const RING_CLOCK_MARGIN_MS = 1_000;

/**
 * How long a ring waits for an element that is not there when the act starts.
 * Shorter than any act's own budget, so a ring cannot outlast the act by
 * much; the act fails or proceeds on its own wait, not this one.
 */
const LATE_RING_WAIT_MS = 5_000;

/**
 * Whether a ring was ever drawn on `page` by this process. For a picture taken
 * earlier, whose audience nobody recorded: one taken of a page never ringed
 * cannot hold a ring.
 */
export function pageEverRinged(page: Page): boolean {
  return everRinged.has(page);
}

/**
 * Every Page a ring was ever drawn on, or asked to be: never cleared, unlike
 * the records (which page close and `endRings` drop), so a closed page's old
 * report picture is still known to be one that may show a ring.
 */
let everRinged = new WeakSet<Page>();

/**
 * Forget every record of rings drawn, for tests only. The CDP endpoints
 * registered by connections stay registered: they describe connections, not
 * rings.
 */
export function resetRingRecordsForTests(): void {
  ringsOn = new WeakMap();
  everRinged = new WeakSet();
  detaching = new WeakSet();
  watchedForClose = new WeakSet();
  confirmTimers = new WeakMap();
  slowLookups = new WeakSet();
  tabRecords.clear();
  pendingAt.clear();
  totalMarks = 0;
  marksOnPage = new WeakMap();
  marksAt.clear();
  lateWaitsOn = new WeakMap();
}

/**
 * What this process knows of its rings on one Page object: until when one may
 * show, whether report pictures may show it, which frames actually drew one,
 * and which draws are still on their way. Frames are kept as Playwright's own
 * Frame objects, not by address: a frame keeps its Frame across `pushState`,
 * a hash change and a navigation, where an address would stop matching and
 * leave the entry with nothing to clear it.
 *
 * A frame's entry is dropped only when the FRAME says there is nothing of
 * ours left in it: an evaluation there finds no Steptix host (the controller
 * removes the host when its last ring retires), or the frame is gone. Never
 * on the clock: a frame that blocks between the draw and the next paint
 * starts its ring only when it unblocks, and shows it for a full `durationMs`
 * from then, whatever any clock in Node says (§16.10).
 */
interface PageRecord {
  until: number;
  inScreenshots: boolean;
  frames: Map<Frame, number>;
  /** Draws sent and not yet answered: until one answers, nobody knows where
   *  or when its ring will appear. */
  inFlight: Set<Promise<unknown>>;
}

function newPageRecord(inScreenshots: boolean): PageRecord {
  return { until: 0, inScreenshots, frames: new Map<Frame, number>(), inFlight: new Set() };
}

// ── Other Page objects on the same tab ───────────────────────────────────────
//
// Two Playwright Page objects can be one browser tab only when both are
// connected over CDP to the same browser process: an errand's attach and a
// session's on one CDP tab. Every such connection Steptix makes goes through
// manager.ts `connectOverCdpSession`, which registers its Browser here with
// its endpoint. A Page whose Browser is not registered (a launched browser,
// Firefox, WebKit) cannot share its tab with another Page, so it keeps its
// own record only and never looks a target id up.
//
// A ring drawn through a registered Page is also recorded for its tab, keyed
// by (endpoint, target id). While that record exists, every Page on the tab
// holds every frame. It ends only when:
//   1. a capture or a confirmation through ANY Page on the tab finds every
//      frame free of our hosts, with no draw on the tab in flight;
//   2. Steptix's own teardown closes the tab (any close of a Page that its
//      owner did not mark with `pagesDetaching`);
//   3. every connection to the endpoint has gone, when no Page is left that
//      could capture it.
// No timers and no clock decide it.

/** Each registered CDP connection's endpoint. */
const endpointOfBrowser = new WeakMap<object, string>();

/** The connections still open to each endpoint. */
const browsersAt = new Map<string, Set<object>>();

/**
 * For the code that connects over CDP (`connectOverCdpSession`): `browser` is
 * a connection to the browser at `endpoint` (e.g. `localhost:9222`). Pages of
 * two connections to one endpoint can be the same tab.
 */
export function registerCdpBrowser(
  browser: { on(event: 'disconnected', listener: () => void): unknown },
  endpoint: string,
): void {
  if (endpointOfBrowser.has(browser)) return;
  endpointOfBrowser.set(browser, endpoint);
  let open = browsersAt.get(endpoint);
  if (open === undefined) {
    open = new Set();
    browsersAt.set(endpoint, open);
  }
  open.add(browser);
  try {
    browser.on('disconnected', () => {
      const still = browsersAt.get(endpoint);
      still?.delete(browser);
      if (still !== undefined && still.size > 0) return;
      // Nothing is left that could capture a tab of this browser.
      browsersAt.delete(endpoint);
      for (const [key, record] of [...tabRecords]) if (record.endpoint === endpoint) tabRecords.delete(key);
    });
  } catch {
    // A connection that cannot be listened to keeps its records until a
    // capture confirms them.
  }
}

/** The endpoint `page` is connected to over CDP, or null for any other page. */
function endpointOf(page: Page): string | null {
  try {
    const browser = page.context().browser();
    return browser === null ? null : endpointOfBrowser.get(browser) ?? null;
  } catch {
    return null;
  }
}

/** A tab's record: the latest ring's end on the drawing clock, and the draws
 *  on the tab not yet answered. */
interface TabRecord {
  key: string;
  endpoint: string;
  targetId: string;
  until: number;
  drawing: number;
  /** The draws counted in `drawing`, to wait on. */
  inFlight: Set<Promise<unknown>>;
}

/** Tab records by `endpoint + '\n' + targetId`. */
const tabRecords = new Map<string, TabRecord>();

const tabKey = (endpoint: string, targetId: string): string => `${endpoint}\n${targetId}`;

function tabRecordFor(endpoint: string, targetId: string): TabRecord {
  const key = tabKey(endpoint, targetId);
  let record = tabRecords.get(key);
  if (record === undefined) {
    record = { key, endpoint, targetId, until: 0, drawing: 0, inFlight: new Set() };
    tabRecords.set(key, record);
  }
  return record;
}

function hasTabRecordsAt(endpoint: string): boolean {
  for (const record of tabRecords.values()) if (record.endpoint === endpoint) return true;
  return false;
}

/** Target-id lookups still in flight for a ring just drawn, per endpoint; a
 *  capture through a Page on that endpoint waits for them (within
 *  TARGET_ID_WAIT_MS), so a fresh ring is never missed. */
const pendingAt = new Map<string, Set<Promise<void>>>();

function pending(endpoint: string, work: Promise<unknown>): void {
  let set = pendingAt.get(endpoint);
  if (set === undefined) {
    set = new Set();
    pendingAt.set(endpoint, set);
  }
  const bounded = within(work.then(() => undefined), TARGET_ID_WAIT_MS, undefined);
  set.add(bounded);
  void bounded.finally(() => {
    set.delete(bounded);
    if (set.size === 0 && pendingAt.get(endpoint) === set) pendingAt.delete(endpoint);
  });
}

/** Pages whose owner is disconnecting from their tab, which stays open. */
let detaching = new WeakSet<Page>();

/**
 * For the code that owns a teardown: these Pages are about to be closed by a
 * disconnect that leaves their tabs open — `closeBrowser` severing a CDP
 * connection it did not launch. Their tabs' records then outlive them, for
 * the other Pages on those tabs. Any other close of a Page is its tab
 * closing.
 */
export function pagesDetaching(pages: readonly Page[]): void {
  for (const page of pages) detaching.add(page);
}

function isDetached(frame: Frame): boolean {
  try {
    return frame.isDetached();
  } catch {
    return true;
  }
}

function isClosed(page: Page): boolean {
  try {
    return page.isClosed();
  } catch {
    return false;
  }
}

/**
 * The frames whose document a draw landed in. A locator that does not enter a
 * frame resolves in its own (`_frame`), so that frame is exact. One that does
 * (`frameLocator(…).locator(…)`) is matched by the address the draw answered
 * with, read now, and every frame at that address is kept — two frames can
 * share one, and the cautious side is to hold both. When none is there any
 * more (it navigated between the draw and this answer), every frame from the
 * locator's own down.
 */
function framesThatDrew(page: Page, locator: Locator, href: string | null): Frame[] {
  const { frame: own, entersFrame } = frameOfLocator(locator);
  if (own !== undefined && !entersFrame) return [own];
  // highlight.js always answers with its document's address; an answer
  // without one did not come from it, and names no frame.
  if (href === null) return [];
  let frames: Frame[];
  try {
    frames = page.frames();
  } catch {
    return []; // A closed page: nothing of it is on screen.
  }
  const matches = frames.filter((frame) => {
    try {
      return frame.url() === href;
    } catch {
      return false;
    }
  });
  if (matches.length > 0) return matches;
  return own === undefined ? frames : frames.filter((frame) => frame === own || descendsFrom(frame, own));
}

/** Each Page's target-id lookup, asked once, off the capture path. */
const targetIds = new WeakMap<Page, Promise<string | null>>();

/** Pages whose `close` already clears their records. */
let watchedForClose = new WeakSet<Page>();

/**
 * The longest a capture waits on a target-id lookup. Attaching to a tab whose
 * main thread is busy, or whose browser has stopped answering, can take as
 * long as the busy spell; past this the lookup counts as "no id" for this
 * capture and is left to finish for the next.
 */
const TARGET_ID_WAIT_MS = 1_000;

/** `promise`, or `fallback` once `waitMs` has passed. */
async function within<T>(promise: Promise<T>, waitMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The page's CDP target id, or null where there is none to ask for. The
 *  same question `resolvePageTargetId` (manager.ts) asks, asked here so this
 *  module stays free of the browser manager. Not bounded: see
 *  {@link targetIdOf} for the bounded read. */
function lookUpTargetId(page: Page): Promise<string | null> {
  let id = targetIds.get(page);
  if (id === undefined) {
    id = (async () => {
      try {
        const context = page.context() as unknown as {
          newCDPSession?: (p: Page) => Promise<{ send: (m: string) => Promise<unknown>; detach: () => Promise<void> }>;
        };
        if (typeof context?.newCDPSession !== 'function') return null;
        const session = await context.newCDPSession(page);
        try {
          const info = (await session.send('Target.getTargetInfo')) as { targetInfo?: { targetId?: string } } | undefined;
          await dropRecordsOfClosedTabs(page, session);
          return info?.targetInfo?.targetId ?? null;
        } finally {
          await session.detach().catch(() => {});
        }
      } catch {
        return null;
      }
    })();
    targetIds.set(page, id);
  }
  return id;
}

/**
 * On a lookup, while the page's endpoint has tab records: drop those whose
 * tab no longer exists. A tab the user closed, with no Steptix Page on it
 * that had looked it up, would otherwise keep its record until the endpoint
 * disconnects, and every new Page on the endpoint would pay a lookup for it.
 * One more call on a session the lookup already holds.
 */
async function dropRecordsOfClosedTabs(page: Page, session: { send: (m: string) => Promise<unknown> }): Promise<void> {
  const endpoint = endpointOf(page);
  if (endpoint === null || !hasTabRecordsAt(endpoint)) return;
  let targets: unknown;
  try {
    targets = ((await session.send('Target.getTargets')) as { targetInfos?: unknown } | undefined)?.targetInfos;
  } catch {
    return;
  }
  if (!Array.isArray(targets)) return;
  const alive = new Set(targets.map((t) => (t as { targetId?: unknown })?.targetId));
  for (const record of [...tabRecords.values()]) {
    if (record.endpoint === endpoint && !alive.has(record.targetId)) tabRecords.delete(record.key);
  }
}

/** Pages whose lookup has already outrun TARGET_ID_WAIT_MS once and not
 *  answered since: asked again, they answer null at once, so one capture
 *  (which asks more than once) or the next does not wait the budget again. */
let slowLookups = new WeakSet<Page>();

/** {@link lookUpTargetId}, or null once TARGET_ID_WAIT_MS has passed. */
async function targetIdOf(page: Page): Promise<string | null> {
  const lookup = lookUpTargetId(page);
  if (slowLookups.has(page)) return null;
  const timedOut = Symbol('timed out');
  const id = await within<string | null | typeof timedOut>(lookup, TARGET_ID_WAIT_MS, timedOut);
  if (id !== timedOut) return id;
  slowLookups.add(page);
  void lookup.then(() => slowLookups.delete(page));
  return null;
}

/** What a Page knows of its tab's record (rule 9). */
interface TabView {
  /** The record of its tab, when the tab is known and has one. */
  tab: TabRecord | undefined;
  /** The page is on an endpoint with records but its own tab could not be
   *  told (its target-id lookup failed or ran out of time): it holds every
   *  frame as if its tab had one, and confirms nothing. */
  unknown: boolean;
  /** The lifetime of what is held: the tab's `until`, or for an unknown tab
   *  the latest of the endpoint's. */
  holdUntil: number;
  /** Draws on the tab (or, unknown, on any tab of the endpoint) in flight. */
  drawing: number;
  /** Those draws, to wait on (rule 5). */
  draws: Promise<unknown>[];
}

const NO_TAB: TabView = { tab: undefined, unknown: false, holdUntil: 0, drawing: 0, draws: [] };

/** The record of `page`'s tab, when it is on a registered endpoint and one
 *  exists. Looks the target id up only when the endpoint has a record. */
async function tabRecordOf(page: Page): Promise<TabView> {
  // No ring recorded for any tab, none on its way: nothing to look at.
  if (tabRecords.size === 0 && pendingAt.size === 0) return NO_TAB;
  const endpoint = endpointOf(page);
  if (endpoint === null) return NO_TAB;
  if (!hasTabRecordsAt(endpoint) && !pendingAt.has(endpoint)) return NO_TAB;
  await Promise.all([...(pendingAt.get(endpoint) ?? [])]);
  const id = await targetIdOf(page);
  // A Page that has looked its tab up learns of its tab closing (rule 2).
  watchForClose(page);
  if (id !== null) {
    const tab = tabRecords.get(tabKey(endpoint, id));
    return tab === undefined
      ? NO_TAB
      : { tab, unknown: false, holdUntil: tab.until, drawing: tab.drawing, draws: [...tab.inFlight] };
  }
  // The lookup failed or ran out of time: a busy tab answers it as late as
  // its busy spell. This page may be on any ringed tab of the endpoint.
  let holdUntil = 0;
  let drawing = 0;
  let any = false;
  const draws: Promise<unknown>[] = [];
  for (const record of tabRecords.values()) {
    if (record.endpoint !== endpoint) continue;
    any = true;
    holdUntil = Math.max(holdUntil, record.until);
    drawing = Math.max(drawing, record.drawing);
    draws.push(...record.inFlight);
  }
  return any ? { tab: undefined, unknown: true, holdUntil, drawing, draws } : NO_TAB;
}

/** Clear a page's records when it closes: a closed tab shows nothing. */
function watchForClose(page: Page): void {
  if (watchedForClose.has(page)) return;
  watchedForClose.add(page);
  try {
    page.on('close', () => forgetPage(page));
  } catch {
    // A page that cannot be listened to keeps its records until confirmed.
  }
}

/** The pending {@link confirmWhenOver} timer of each page that drew. */
let confirmTimers = new WeakMap<Page, ReturnType<typeof setTimeout>>();

/** The longest delay `setTimeout` takes as given; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** How often a page asks again after a frame still had a host of ours: the
 *  first retry after a second, doubling to at most half a minute, and at
 *  most this many retries. The ring's own lifetime is ten seconds at most,
 *  so a host still there after that is a ring that started late (a frame
 *  blocked before its first paint) or one that will not go; the page's own
 *  captures keep asking either way. */
const CONFIRM_RETRY_FIRST_MS = 1_000;
const CONFIRM_RETRY_MAX_MS = 30_000;
const CONFIRM_RETRIES = 10;

/**
 * Once the last ring a page drew is over on our clock, ask whether a Steptix
 * host is still there: each frame that drew, and, while the page's tab has a
 * record, every frame of the tab. A frame that says no loses its entry, and a
 * round in which every frame says no ends the tab's record (rule 1). A host
 * still there is asked again later, up to the retry cap. Without this, a page
 * that drew and was then left alone (an MCP session between batches) would
 * keep its records until its next capture. The cost is the drawing page's,
 * after the ring; with the highlight off nothing is drawn and nothing is
 * scheduled.
 */
function confirmWhenOver(page: Page, now: () => number, retry = 0, tabUntil = 0): void {
  const own = ringsOn.get(page);
  if (own === undefined) return;
  if (own.frames.size === 0 && tabUntil === 0) return;
  if (retry > CONFIRM_RETRIES) return;
  const previous = confirmTimers.get(page);
  if (previous !== undefined) clearTimeout(previous);
  const last = Math.max(tabUntil, ...own.frames.values());
  const delay = retry === 0
    ? Math.max(0, last - now())
    : Math.min(CONFIRM_RETRY_FIRST_MS * 2 ** (retry - 1), CONFIRM_RETRY_MAX_MS);
  const timer = setTimeout(() => {
    confirmTimers.delete(page);
    void confirmQuietly(page, now, retry);
  }, Math.min(delay, MAX_TIMER_MS));
  (timer as { unref?: () => void }).unref?.();
  confirmTimers.set(page, timer);
}

async function confirmQuietly(page: Page, now: () => number, retry: number): Promise<void> {
  const own = ringsOn.get(page);
  if (own === undefined || isClosed(page)) return;
  const marksBefore = marksOf(page);
  const { tab, unknown } = await tabRecordOf(page);
  const withDocument = await framesToAsk(page);
  forgetFramesWithoutDocument(own, withDocument);
  // With a tab record, every frame of the tab; otherwise the frames that drew.
  const asked = tab !== undefined || unknown ? withDocument : [...own.frames.keys()];
  let again = false;
  let notDue = false;
  let everyFrameClear = true;
  const clearFrames = new Map<Frame, number | undefined>();
  await Promise.all(asked.map(async (frame) => {
    const heldUntil = own.frames.get(frame);
    if (heldUntil !== undefined && now() < heldUntil) {
      notDue = true;
      everyFrameClear = false;
      return;
    }
    // Bounded: a frame that cannot answer (busy, or a document not yet
    // committed) is not clear, and is asked again.
    const answer = await answerWithin(onRegistry(frame, 'probe', '', false), TOGGLE_TIMEOUT_MS);
    if (!answer.landed || answer.present) {
      again = true;
      everyFrameClear = false;
    } else {
      clearFrames.set(frame, heldUntil);
    }
  }));
  // Only answers that cannot predate a mark count: a ring stamped on this
  // page or its endpoint while the round ran may be one they missed.
  if (marksOf(page) === marksBefore) {
    for (const [frame, heldUntil] of clearFrames) {
      // Unless the frame drew again meanwhile, nothing of ours is left there.
      if (heldUntil !== undefined && own.frames.get(frame) === heldUntil) own.frames.delete(frame);
    }
    if (tab !== undefined && everyFrameClear && tab.drawing === 0 && own.inFlight.size === 0) {
      tabRecords.delete(tab.key);
    }
  } else {
    again = true;
  }
  for (const frame of [...own.frames.keys()]) if (isDetached(frame)) own.frames.delete(frame);
  const tabLeft = tab !== undefined && tabRecords.get(tab.key) === tab ? tab.until : 0;
  if (own.frames.size > 0 || tabLeft > 0) {
    // A ring drawn since, or a host still there: ask again.
    confirmWhenOver(page, now, again || !notDue ? retry + 1 : 0, tabLeft);
  }
}

function forgetPage(page: Page): void {
  const timer = confirmTimers.get(page);
  if (timer !== undefined) clearTimeout(timer);
  confirmTimers.delete(page);
  ringsOn.delete(page);
  // A page closing is its tab closing, unless its owner said it was only
  // disconnecting from a tab that stays open (rule 2).
  const endpoint = endpointOf(page);
  const lookup = targetIds.get(page);
  if (endpoint === null || lookup === undefined || detaching.has(page)) return;
  void lookup.then((id) => {
    if (id !== null) tabRecords.delete(tabKey(endpoint, id));
  });
}

/**
 * Count `draw` as on its way until it answers or fails: on its page and, on
 * a registered endpoint, on its tab. While one is, a model capture of the
 * page or tab hides with a ring of ours known to be coming, so a host built
 * during the capture starts hidden; and nothing about it is decided on the
 * clock, since it has not even started.
 */
function trackDraw<T>(page: Page, draw: Promise<T>, now: () => number): Promise<T> {
  const own = ringsOn.get(page) ?? newPageRecord(true);
  ringsOn.set(page, own);
  everRinged.add(page);
  watchForClose(page);
  own.inFlight.add(draw);
  let finished = false;
  let tab: TabRecord | undefined;
  const endpoint = endpointOf(page);
  if (endpoint !== null && !isClosed(page)) {
    pending(endpoint, lookUpTargetId(page).then((id) => {
      if (id === null || finished || isClosed(page)) return;
      tab = tabRecordFor(endpoint, id);
      tab.drawing++;
      tab.inFlight.add(draw);
    }));
  }
  const done = (): void => {
    finished = true;
    own.inFlight.delete(draw);
    if (tab !== undefined) {
      tab.drawing--;
      tab.inFlight.delete(draw);
    }
    // Answered, drawn or not: on a registered endpoint the page confirms
    // its tab once the ring is due, so its record cannot outlive it unasked.
    if (endpoint !== null) confirmWhenOver(page, now, 0, Math.max(own.until, tab?.until ?? 0));
  };
  draw.then(done, done);
  return draw;
}

/** Stamp a ring drawn (or about to be) on `page`: its own record, with the
 *  frames that drew when the draw has landed; and, on a registered endpoint,
 *  its tab's record, looked up in the background. */
function recordRing(
  page: Page,
  until: number,
  inScreenshots: boolean,
  now: () => number,
  drewIn?: readonly Frame[],
): void {
  const endpoint = endpointOf(page);
  countMark(page, endpoint);
  const own = ringsOn.get(page) ?? newPageRecord(inScreenshots);
  own.inScreenshots = inScreenshots;
  own.until = Math.max(own.until, until);
  for (const frame of drewIn ?? []) own.frames.set(frame, Math.max(own.frames.get(frame) ?? 0, until));
  ringsOn.set(page, own);
  everRinged.add(page);
  watchForClose(page);
  if (drewIn !== undefined && drewIn.length > 0) confirmWhenOver(page, now);
  if (endpoint === null) return;
  pending(endpoint, lookUpTargetId(page).then((id) => {
    if (id === null || isClosed(page)) return;
    const record = tabRecordFor(endpoint, id);
    record.until = Math.max(record.until, until);
  }));
}

/**
 * Stamps counted per page and per endpoint, and in all. A round of answers
 * (a capture's, a confirmation's) confirms nothing when a stamp for its page
 * or endpoint came while it ran: a ring drawn and landed meanwhile may be one
 * its answers predate. And a capture that took its picture with no hiding
 * retakes it when one came while it was being taken (`hiddenFor`).
 */
let totalMarks = 0;
let marksOnPage = new WeakMap<Page, number>();
const marksAt = new Map<string, number>();

function countMark(page: Page, endpoint: string | null): void {
  totalMarks++;
  marksOnPage.set(page, (marksOnPage.get(page) ?? 0) + 1);
  if (endpoint !== null) marksAt.set(endpoint, (marksAt.get(endpoint) ?? 0) + 1);
}

/** Stamps so far on `page` and on its endpoint; 0 with nothing ever stamped
 *  in the process, without touching the page. */
function marksOf(page: Page): number {
  if (totalMarks === 0) return 0;
  const endpoint = endpointOf(page);
  return (marksOnPage.get(page) ?? 0) + (endpoint === null ? 0 : marksAt.get(endpoint) ?? 0);
}

/** What is known of rings this process drew that may show through one page. */
interface RingView {
  /** Until when a ring of ours may show anywhere on the page. */
  until: number;
  /** The page's own record, if it drew. */
  own: PageRecord | undefined;
  /** What the page knows of its tab: while it has a record, or cannot be
   *  told from a ringed tab, every frame is held. */
  tabView: TabView;
  /** Draws through this page, or on its tab, not yet answered. */
  drawing: number;
}

/** Whether a frame may hold a ring of ours, and until when that ring lives. */
function heldUntilIn(view: RingView, frame: Frame): number | undefined {
  const own = view.own?.frames.get(frame);
  if (view.tabView.tab === undefined && !view.tabView.unknown) return own;
  return Math.max(own ?? 0, view.tabView.holdUntil);
}

function viewMayShow(view: RingView, now: number): boolean {
  return now < view.until
    || view.drawing > 0
    || (view.own?.frames.size ?? 0) > 0
    || view.tabView.tab !== undefined
    || view.tabView.unknown;
}

/**
 * What is known of rings this process drew that may show through `page`: its
 * own record and, for a Page on a registered CDP endpoint that has a tab
 * record, its tab's. Any other page asks nothing beyond its own record.
 */
async function ringRecordFor(page: Page, _now: number): Promise<RingView> {
  const own = ringsOn.get(page);
  if (own !== undefined) {
    for (const frame of [...own.frames.keys()]) if (isDetached(frame)) own.frames.delete(frame);
  }
  const tabView = await tabRecordOf(page);
  return {
    until: Math.max(own?.until ?? 0, tabView.holdUntil),
    own,
    tabView,
    drawing: Math.max(own?.inFlight.size ?? 0, tabView.drawing),
  };
}

/** Whether a ring may still be showing on `page`, on `clock`. */
async function ringsMayShow(page: Page, clock: HighlightClock): Promise<boolean> {
  const now = (clock.now ?? Date.now)();
  return viewMayShow(await ringRecordFor(page, now), now);
}

/** After a round in which every frame of the tab answered that no host of
 *  ours is there, with no draw on its way: the tab's record ends (rule 1). */
function confirmTab(view: RingView, everyFrameClear: boolean): void {
  const tab = view.tabView.tab;
  if (tab === undefined || !everyFrameClear || tab.drawing > 0 || view.drawing > 0) return;
  if (tabRecords.get(tab.key) === tab) tabRecords.delete(tab.key);
}

/** How long hiding, restoring or ending is given in one frame when no ring
 *  of ours is known to be up — a forced peek's frames, a restore. Short,
 *  because the page does no work worth waiting for: a few synchronous DOM
 *  writes. */
const TOGGLE_TIMEOUT_MS = 500;

/** The longest a capture waits for a frame's hide to land while one of our
 *  rings may be up: past the longest ring life (10 s, plus the margin), so in
 *  practice it is the ring's own lifetime that ends the wait. */
const MAX_HIDE_WAIT_MS = 15_000;

/** What an end (`[use computer]`) gives a frame that drew a ring, past the
 *  ring's own lifetime, before it goes on without that frame's answer. */
const END_GRACE_MS = 2_000;

/**
 * How long one capture's hide holds before it lapses on its own, in case its
 * restore never lands. Comfortably above the longest capture — Playwright's
 * screenshot gives up at 30 s, a tab peek at 15 s — so no capture outlives
 * its own entry. Kept equal to HIDE_LAPSE_MS in scripts/highlight.js.
 */
const HIDE_LAPSE_MS = 60_000;

/** The longest a hide or end waits, in the frame, for the change to be
 *  painted (two animation frames): an out-of-process frame's last painted
 *  picture is what a screenshot composites. */
const PAINT_WAIT_MS = 200;

/** A document counts as being drawn when its ring controller ran an
 *  animation frame this recently; otherwise there is no paint to wait for.
 *  Several frames at 60 Hz. Chrome runs none in a cross-site frame scrolled
 *  out of view, and one every 1–2 s in a background tab. */
const DRAWN_WITHIN_MS = 100;

function isMainFrame(frame: Frame): boolean {
  try {
    return frame.parentFrame() === null;
  } catch {
    return false;
  }
}

/**
 * A capture whose picture goes to a model could not get a frame to hide our
 * ring in time, while the ring may still be up. `captureScreenshot` turns it
 * into no picture, which every caller already handles as a failed capture.
 */
export class RingsNotHiddenError extends Error {
  constructor() {
    super('A highlight ring could not be hidden in time, so no screenshot was taken for the model');
    this.name = 'RingsNotHiddenError';
  }
}

/**
 * Wait for one frame's `onRegistry` call to LAND, or for the deadline.
 * `landed` when it did (or the frame went away, taking its document and any
 * ring with it), and `present` when the frame said a Steptix host is still
 * there. The evaluation is never abandoned: it is ordered and will land, and
 * the caller decides how long it is worth waiting for.
 */
async function answerWithin(call: Promise<boolean>, waitMs: number): Promise<{ landed: boolean; present: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call.then((present) => ({ landed: true, present: present === true }), () => ({ landed: true, present: false })),
      new Promise<{ landed: boolean; present: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ landed: false, present: false }), Math.max(0, waitMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send `method` to every frame worth asking and wait for each to land.
 * Answers whether every frame is known to be safe to photograph.
 *
 *  - No ring of ours known on the page: the short budget alone.
 *  - A draw on its way: until it lands, with no escape on the clock — that
 *    ring has not started, so no lifetime of it has passed.
 *  - Otherwise a hide is waited for until it lands or the ring's lifetime has
 *    passed. A ring that painted before its frame blocked fades on the
 *    compositor by then (§16.9); one that had not painted is not on screen,
 *    and the frame's entry stays until the frame itself says the host is gone,
 *    so the capture after it unblocks still hides (§16.10).
 *  - An end is given the lifetime and a grace on top, then goes on: what
 *    follows is `[use computer]`'s screen grab, which cannot be withheld, and
 *    a frame that does not answer by then is most often one a modal holds.
 *
 * A frame's entry goes only when the frame answers that no Steptix host is
 * there — never because a clock says so.
 */
async function toEveryFrame(
  page: Page,
  method: 'hide' | 'end',
  token: string,
  clock: HighlightClock,
): Promise<FrameRound> {
  const now = clock.now ?? Date.now;
  const marksBefore = marksOf(page);
  const view = await ringRecordFor(page, now());
  const asked = await framesToAsk(page);
  forgetFramesWithoutDocument(view.own, asked);
  const ours = viewMayShow(view, now());
  let endBudgetSpent = false;
  /** A frame's lifetime, read when it is needed: a draw that lands while a
   *  round waits stamps the records this reads. */
  const lifetimeOf = (frame: Frame): number => {
    const held = view.own?.frames.get(frame);
    const tabUntil = view.tabView.tab?.until ?? (view.tabView.unknown ? view.tabView.holdUntil : undefined);
    if (held === undefined && tabUntil === undefined) return Math.max(view.until, view.own?.until ?? 0);
    return Math.max(held ?? 0, tabUntil ?? 0);
  };
  const results = await Promise.all(asked.map(async (frame): Promise<{ ok: boolean; clear: boolean; landed: boolean }> => {
    const call = onRegistry(frame, method, token, ours);
    if (!ours) {
      const answer = await answerWithin(call, TOGGLE_TIMEOUT_MS);
      return { ok: answer.landed, clear: answer.landed && !answer.present, landed: answer.landed };
    }
    const heldUntil = heldUntilIn(view, frame);
    let answer: { landed: boolean; present: boolean };
    if (method === 'end') {
      const waitMs = heldUntil !== undefined
        ? Math.min(MAX_HIDE_WAIT_MS, Math.max(0, heldUntil - now()) + END_GRACE_MS)
        : Math.min(Math.max(view.until - now(), TOGGLE_TIMEOUT_MS), MAX_HIDE_WAIT_MS);
      answer = await answerWithin(call, waitMs);
      if (!answer.landed && heldUntil !== undefined) endBudgetSpent = true;
      return { ok: true, clear: answer.landed && !answer.present, landed: answer.landed };
    }
    if (view.drawing > 0) {
      // A draw on its way has no lifetime yet: wait for the hide to land, or
      // for the draws to settle, whichever comes first. Read as they go, so a
      // draw that lands early does not leave the rest of the wait at 15 s.
      const first = await Promise.race([
        answerWithin(call, MAX_HIDE_WAIT_MS),
        drawsSettled(view).then(() => 'settled' as const),
      ]);
      if (first !== 'settled') {
        return { ok: first.landed, clear: first.landed && !first.present, landed: first.landed };
      }
    }
    // Landed, or the lifetime of what may be there has passed. A timer can
    // fire a little before the clock reaches the lifetime: the remainder is
    // waited too, within the bound.
    const lifetime = lifetimeOf(frame);
    let budget = MAX_HIDE_WAIT_MS;
    let waitMs = Math.min(Math.max(lifetime - now(), TOGGLE_TIMEOUT_MS), budget);
    for (;;) {
      answer = await answerWithin(call, waitMs);
      budget -= waitMs;
      if (answer.landed || now() >= lifetime || budget <= 0) break;
      waitMs = Math.min(Math.max(lifetime - now(), 1), budget);
    }
    return {
      ok: answer.landed || now() >= lifetime,
      clear: answer.landed && !answer.present,
      landed: answer.landed,
    };
  }));
  if (endBudgetSpent) {
    logger.debug('Highlight: a frame that drew a ring did not answer the end within its ring\'s lifetime and a grace, so `[use computer]` goes on without it');
  }
  const landed = results.map((r) => r.landed);
  if (!ours) return { ok: true, asked, landed };
  // Only answers that cannot predate a mark confirm anything (see countMark).
  if (marksOf(page) === marksBefore) {
    results.forEach((result, i) => {
      // The frame says nothing of ours is there: its entry can go.
      const frame = asked[i];
      if (result.clear && frame !== undefined) view.own?.frames.delete(frame);
    });
    if (!view.tabView.unknown) confirmTab(view, results.every((r) => r.clear));
  }
  // Without a ring of ours, a frame that did not answer is the documented
  // residual (a forced peek of another process's ring in a busy frame).
  return { ok: results.every((r) => r.ok), asked, landed };
}

/** One round of `method` over a page's frames: whether the picture may be
 *  taken, which frames were asked, and whose call landed in time. */
interface FrameRound {
  ok: boolean;
  asked: Frame[];
  landed: boolean[];
}

/** Every draw known to be on its way to `page` or its tab, settled. */
function drawsSettled(view: RingView): Promise<void> {
  const draws = [...(view.own?.inFlight ?? []), ...view.tabView.draws];
  return Promise.all(draws.map((draw) => draw.then(() => undefined, () => undefined))).then(() => undefined);
}

/**
 * Run `fn` — a screenshot whose image goes to a model — with every ring on
 * `page` out of sight, then put them back so the person watching still sees
 * the full three seconds (§4.2).
 *
 * Free when nothing of ours may show on the page: no ring within its
 * lifetime, no frame still holding one (a held frame), no draw on its way,
 * and no live record for its CDP tab (`ringRecordFor`, `viewMayShow`).
 * Then `fn` runs directly, with no round trip. So every model-bound capture
 * can go through here whatever the config says, and a run with the highlight
 * off pays nothing.
 *
 * Otherwise `hide()` runs on every frame's registry at once, then `fn`, then
 * `restore()` on every frame. Restored in all of them rather than only those
 * that answered: a hide that timed out may still land, and a restore where
 * nothing was hidden does nothing.
 */
export async function hiddenFor<T>(
  page: Page,
  fn: () => Promise<T>,
  options: HighlightClock & {
    /**
     * Hide whatever the page shows, whether or not this process drew on THIS
     * Page object. For a tab peek, which attaches a Page of its own to a CDP
     * tab a session may have just ringed (stories/cdp-tab-screenshot.md):
     * the record above is keyed on the session's Page, never on the peek's —
     * and the ring may be another process's altogether (a CLI run on the
     * same CDP browser), so this always asks. What bounds the cost is how
     * little it asks: one synchronous evaluate per frame with a document,
     * half a second at most each (`onRegistry`).
     */
    force?: boolean;
  } = {},
): Promise<T> {
  let retakes = 1;
  if (options.force !== true) {
    const before = markSnapshot(page);
    if (!(await ringsMayShow(page, options))) {
      const picture = await fn();
      if (!(await stampedMeanwhile(page, before))) return picture;
      // A ring was stamped where this picture can see it while it was taken
      // with nothing hidden: taken again, once, through the hide below.
      retakes = 0;
    }
  }
  for (;;) {
    const before = markSnapshot(page);
    const picture = await throughHide(page, fn, options);
    // A ring stamped while the picture was taken, perhaps in a frame that
    // was attached or committed after the hide went out (§4.3 rule 11).
    if (retakes === 0 || !(await stampedMeanwhile(page, before))) return picture;
    retakes--;
  }
}

/** Hide every frame's rings, run `fn`, restore. */
async function throughHide<T>(page: Page, fn: () => Promise<T>, options: HighlightClock): Promise<T> {
  const token = randomUUID();
  // Only once every frame's hide has LANDED (or our ring's lifetime has
  // passed) is the picture taken: `page.screenshot` waits for frames, but
  // the raw-CDP tab peek does not, and a busy cross-origin frame shows its
  // last painted frame, ring and all.
  const round = await toEveryFrame(page, 'hide', token, options);
  try {
    if (!round.ok) throw new RingsNotHiddenError();
    return await fn();
  } finally {
    // A frame runs its evaluations in order, so a restore lands after its
    // hide whenever that lands. Waited on, briefly, only where the hide
    // landed; where it did not, the restore follows it whenever it does.
    await Promise.all(round.asked.map((frame, i) => {
      const restore = answerWithin(onRegistry(frame, 'restore', token, false), TOGGLE_TIMEOUT_MS);
      return round.landed[i] ? restore : undefined;
    }));
  }
}

/** Stamps so far, for {@link stampedMeanwhile}; nothing read off the page
 *  while nothing was ever stamped in the process. */
function markSnapshot(page: Page): { total: number; page: number; endpoint: number } {
  if (totalMarks === 0) return { total: 0, page: 0, endpoint: 0 };
  const endpoint = endpointOf(page);
  return {
    total: totalMarks,
    page: marksOnPage.get(page) ?? 0,
    endpoint: endpoint === null ? 0 : marksAt.get(endpoint) ?? 0,
  };
}

/**
 * Whether a ring was stamped since `before` where `page`'s picture can see
 * it: on this page, or on another Page of its tab. A stamp elsewhere on the
 * same CDP browser counts only once this page's tab is found to have a record
 * (or cannot be told), so a highlight-off capture is not retaken whenever
 * another tab draws.
 */
async function stampedMeanwhile(page: Page, before: { total: number; page: number; endpoint: number }): Promise<boolean> {
  if (totalMarks === before.total) return false;
  if ((marksOnPage.get(page) ?? 0) !== before.page) return true;
  const endpoint = endpointOf(page);
  if (endpoint === null || (marksAt.get(endpoint) ?? 0) === before.endpoint) return false;
  const { tab, unknown } = await tabRecordOf(page);
  return tab !== undefined || unknown;
}

/**
 * Run `fn` — a screenshot for the report — with the rings hidden only when
 * the project said `inScreenshots: false` (§4.2). By default the ring is the
 * point of a report picture: "what did step 4 click?" answered without the
 * log. Free, like {@link hiddenFor}, when no ring is recent.
 */
export async function hiddenForReport<T>(page: Page, fn: () => Promise<T>, clock: HighlightClock = {}): Promise<T> {
  const rings = ringsOn.get(page);
  if (rings === undefined || rings.inScreenshots !== false) return fn();
  return hiddenFor(page, fn, clock);
}

/**
 * End every ring on these pages for good, and wait until they are gone: for
 * `[use computer]` (§6 item 1). The browser is usually on screen, and
 * `screen.grab()` cannot be asked to leave anything out, so a ring from the
 * last browser action would be in the first computer turn's picture. Not a
 * hide: nothing would restore them, and anything that did would bring back a
 * ring mid-turn.
 */
export async function endRings(pages: readonly Page[], clock: HighlightClock = {}): Promise<void> {
  const live = await Promise.all(pages.map((page) => ringsMayShow(page, clock)));
  await Promise.all(pages.filter((_page, i) => live[i]).map(async (page) => {
    // A late ring still waiting for its element would land after this.
    for (const cancel of [...(lateWaitsOn.get(page) ?? [])]) cancel();
    // A draw on its way would build its host after the end removed the
    // others: let it land first, for as long as a hide would wait for it.
    const drawing = [...(ringsOn.get(page)?.inFlight ?? [])];
    if (drawing.length > 0) {
      const settled = Promise.all(drawing.map((draw) => draw.then(() => true, () => true)));
      if ((await within<unknown>(settled, MAX_HIDE_WAIT_MS, false)) === false) {
        logger.debug('Highlight: a draw was still unanswered when `[use computer]` ended the rings; going on without it');
      }
    }
    // Resolved once every frame's end has landed, or its budget is spent —
    // the screen grab that follows does not wait for frames.
    await toEveryFrame(page, 'end', '', clock);
    // Every frame that drew has answered that its host is gone. A frame that
    // did not answer stays held: a capture after this still asks it.
    const own = ringsOn.get(page);
    if (own !== undefined && own.frames.size === 0 && own.inFlight.size === 0) ringsOn.delete(page);
  }));
}

/**
 * Every tab of every browser a tracker holds — what {@link endRings} takes on
 * `[use computer]`, when any of them may be on screen. Typed by what it
 * reads, for the reason `resolveHighlight` is.
 */
export function pagesOf(tracker: {
  all(): readonly { pageTracker: { tabs(): readonly { page: Page }[] } }[];
}): Page[] {
  try {
    return tracker.all().flatMap((session) => session.pageTracker.tabs().map((tab) => tab.page));
  } catch {
    return [];
  }
}

/**
 * Hide, restore or end the rings in one frame, with the page doing nothing
 * but plain, synchronous DOM writes: add or remove this capture's entry on
 * `documentElement` (see HIDE_LAPSE_MS), then set each Steptix host's
 * visibility from the entries, or remove the host. It never calls the
 * registry handle, whose methods a page can replace with ones that never
 * return, so a planted `<steptix-highlight>` cannot hold a capture up. The
 * one thing it awaits is the paint of what it changed (`registryCall`'s
 * `painted`), through the window's own `requestAnimationFrame` and
 * `setTimeout`: a hostile page that replaces those can end that wait early or
 * keep it from ending (SPEC-interaction-highlight.md §3.3 item 9). How long a
 * caller waits for a frame that does not answer at all is `toEveryFrame`'s
 * call.
 *
 * Balance: a frame runs its evaluations in the order they were sent, so a
 * restore never lands before its own hide, even when the hide outran its
 * budget. A restore that never lands leaves an entry that lapses on its own
 * after HIDE_LAPSE_MS, and the page's next frame shows the rings again. A
 * hide that never lands hides nothing, and its restore then removes nothing.
 */
async function onRegistry(
  frame: Frame,
  method: 'hide' | 'restore' | 'end' | 'probe',
  token: string,
  ours: boolean,
): Promise<boolean> {
  const args = {
    tag: HIGHLIGHT_TAG,
    key: HIGHLIGHT_REGISTRY_KEY,
    method,
    token,
    lapseMs: HIDE_LAPSE_MS,
    ours,
    paintMs: PAINT_WAIT_MS,
    // A hide in the main frame needs no paint wait: a capture
    // (`page.screenshot`, the peek's `Page.captureScreenshot`) draws the main
    // document afresh. Every other frame's hide, and every end (the screen
    // grab that follows draws nothing new), waits for the change to be
    // painted.
    paint: method === 'end' || (method === 'hide' && !isMainFrame(frame)),
    drawnWithinMs: DRAWN_WITHIN_MS,
  };
  if (hasNoAddress(frame) && routeOf.get(frame) === 'parent') {
    // Through the element, once its lookup lands: while it has not, the call
    // has not landed either.
    return parentRoute(frame).then((element) => (element === null ? false : element.evaluate(registryCall, args)))
      .catch((err: unknown) => {
        // A stale element (its document gone): look it up afresh next time.
        parentRoutes.delete(frame);
        throw err;
      });
  }
  return frame.evaluate(registryCall, args);
}

/**
 * The page side of `onRegistry`. Called as `frame.evaluate(fn, args)` it
 * works on the frame's own document; as `element.evaluate(fn, args)` on an
 * `<iframe>` element, on that element's `contentDocument` (none, when it is
 * cross-origin, which is the out-of-process path instead).
 */
function registryCall(first: unknown, second?: unknown): boolean | Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = second === undefined ? (globalThis as any).document : (first as any)?.contentDocument;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const html: any = doc?.documentElement;
  // Every clock reading is the changed document's own: its controller
  // stamps its animation frames and lapses its hide entries on that clock.
  // Through the parent (rule 3) this code runs in the PARENT's realm, whose
  // `Date.now` the page may have shifted (a page correcting for server
  // time), and a reading from it would misjudge both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realm: any = doc?.defaultView ?? globalThis;
  const clock = (): number => realm.Date.now();
  const a = (second ?? first) as {
    tag: string;
    key: string;
    method: string;
    token: string;
    lapseMs: number;
    ours: boolean;
    paintMs: number;
    paint: boolean;
    drawnWithinMs: number;
  };
  /**
   * Resolve once the document has painted what was just changed: two
   * animation frames, or `paintMs` at most. A screenshot composites an
   * out-of-process frame's LAST PAINTED picture, so a hide that has landed in
   * the DOM but not yet been painted still shows the ring. Called only where
   * a host is there, so this costs nothing when no ring is up; and not at all
   * when `paint` is off (the main frame's hide: a screenshot draws the main
   * document afresh) or in a document Chrome is not drawing (no animation
   * frame of the controller's within `drawnWithinMs`: an out-of-view
   * cross-site frame, which a capture draws blank).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const painted = (win: any, answer: boolean): boolean | Promise<boolean> => {
    if (!a.paint || !win || typeof win.requestAnimationFrame !== 'function') return answer;
    const drawnAt = html[Symbol.for(`${a.key}.tick`)];
    if (typeof drawnAt !== 'number' || clock() - drawnAt > a.drawnWithinMs) return answer;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve(answer);
      };
      win.requestAnimationFrame(() => win.requestAnimationFrame(finish));
      win.setTimeout(finish, a.paintMs);
    });
  };
  if (!html) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hosts = Array.from(html.children as ArrayLike<any>).filter(
    (el) => String(el.tagName).toLowerCase() === a.tag && !!el[Symbol.for(a.key)],
  );
  // The answer: whether a Steptix host is still here after this call.
  // The controller removes its host when the last ring retires, so no
  // host means nothing of ours can show in this document.
  if (a.method === 'probe') return hosts.length > 0;
  if (a.method === 'end') {
    for (const el of hosts) html.removeChild(el);
    return hosts.length > 0 ? painted(doc.defaultView, false) : false;
  }
  const hiddenKey = Symbol.for(`${a.key}.hidden`);
  let entries = html[hiddenKey];
  if (a.method === 'restore') {
    // Removes this capture's entry wherever it is; never creates one.
    if (entries && typeof entries === 'object') delete entries[a.token];
  } else {
    // With no host of ours here and no ring of ours known to be up — a
    // forced peek of a tab Steptix never drew on — write nothing at all
    // on the page. With a ring of ours up, the entry is written even
    // before a host exists, so one built during the capture starts hidden.
    if (hosts.length === 0 && !a.ours) return false;
    if (!entries || typeof entries !== 'object') {
      entries = {};
      html[hiddenKey] = entries;
    }
    entries[a.token] = clock() + a.lapseMs;
  }
  if (!entries || typeof entries !== 'object') return hosts.length > 0;
  const now = clock();
  const hidden = Object.keys(entries).some((k) => entries[k] > now);
  for (const el of hosts) el.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
  // A hide waits for the paint; a restore does not (showing late is harmless).
  if (a.method === 'hide' && hosts.length > 0) return painted(doc.defaultView, true);
  return hosts.length > 0;
}

/**
 * The frames to ask: every attached one that has a document. A frame whose
 * address reads '' or ':' has none when Playwright saw the page load (a lazy
 * iframe below the fold, a response that never arrives), and is skipped: it
 * cannot hold a ring, and an evaluation into it waits for a document that may
 * never come. On a Page attached over CDP, one exception: a cross-site frame
 * that loaded before the attach also reads '', yet has a document and
 * answers. It is the frame of another renderer process, so it has a CDP
 * session of its own, which a document-less frame in the page's process has
 * not (`outOfProcess`, asked once per Frame).
 */
async function framesToAsk(page: Page): Promise<Frame[]> {
  let frames: Frame[];
  try {
    frames = page.frames().filter((frame) => !isDetached(frame));
  } catch {
    return [];
  }
  if (!frames.some(hasNoAddress)) return frames;
  const attached = endpointOf(page) !== null;
  const keep = await Promise.all(frames.map(async (frame) => {
    if (!hasNoAddress(frame)) return true;
    // A cross-site frame that loaded before the attach: asked itself.
    if (attached && (await outOfProcess(page, frame))) {
      routeOf.set(frame, 'self');
      return true;
    }
    // In the page's process: asked through its <iframe> element.
    routeOf.set(frame, 'parent');
    disposeOnDetach(page);
    const element = await within<ElementHandle | null | 'pending'>(parentRoute(frame), TARGET_ID_WAIT_MS, 'pending');
    // Rejected: the frame went away, and nothing of it can show. Still being
    // looked up (a busy parent answers as late as its busy spell): asked all
    // the same, its call chained on the lookup, so it counts as not landed
    // and rules 5 and 6 wait for it.
    return element !== null;
  }));
  return frames.filter((_frame, i) => keep[i]);
}

/** How each frame with no address is asked: itself (out of process) or
 *  through its `<iframe>` element in the parent. */
const routeOf = new WeakMap<Frame, 'self' | 'parent'>();

/** Pages whose `framedetached` already disposes the elements looked up for
 *  their frames. */
const detachWatched = new WeakSet<Page>();

/**
 * Release a frame's `<iframe>` element handle when the frame goes: an ad slot
 * that replaces its `javascript:` iframe over and over would otherwise keep
 * every old element alive in the page. Handles live as long as their frame,
 * so a lazy frame is looked up once, not on every capture.
 */
function disposeOnDetach(page: Page): void {
  if (detachWatched.has(page)) return;
  detachWatched.add(page);
  try {
    page.on('framedetached', (frame: Frame) => {
      const route = parentRoutes.get(frame);
      parentRoutes.delete(frame);
      routeOf.delete(frame);
      void route?.then((element) => element?.dispose().catch(() => {}));
    });
  } catch {
    // A page that cannot be listened to keeps its handles until it closes.
  }
}

/**
 * The `<iframe>` element of each in-process frame with no address, through
 * which the frame is asked (`onRegistry`): from the parent, its
 * `contentDocument`. Such a frame may have no document of its own yet (a lazy
 * iframe below the fold, whose own context an evaluation would wait for), or
 * a live one Playwright never reported an address for (`javascript:` frames
 * the parent fills, a 204 or a download left on its initial document). Both
 * share the parent's origin, so the parent reaches the document either way,
 * and never enters the frame's own context.
 */
const parentRoutes = new WeakMap<Frame, Promise<ElementHandle | null>>();

function parentRoute(frame: Frame): Promise<ElementHandle | null> {
  let route = parentRoutes.get(frame);
  if (route === undefined) {
    try {
      route = frame.frameElement().then((element) => element as ElementHandle, () => null);
    } catch {
      route = Promise.resolve(null);
    }
    parentRoutes.set(frame, route);
  }
  return route;
}

/**
 * Drop a page's held entries for frames that have no document now: a frame
 * held only because a draw's frame could not be told apart from the others
 * (`framesThatDrew`'s fallback) cannot show a ring without a document, and
 * is never asked, so its entry would never be confirmed.
 */
function forgetFramesWithoutDocument(own: PageRecord | undefined, withDocument: readonly Frame[]): void {
  if (own === undefined) return;
  for (const frame of [...own.frames.keys()]) {
    if (!isDetached(frame) && !withDocument.includes(frame)) own.frames.delete(frame);
  }
}

/** A frame's address, or '' when it has none (or cannot say). */
function urlOf(frame: Frame): string {
  try {
    return frame.url();
  } catch {
    return '';
  }
}

/** No committed document, as Playwright reports it: '' (seen loading) or ':'. */
function hasNoAddress(frame: Frame): boolean {
  const url = urlOf(frame);
  return url === '' || url === ':';
}

/** Each frame's answer to "are you in a renderer process of your own?". */
const outOfProcessChecks = new WeakMap<Frame, Promise<boolean>>();

/**
 * Whether `frame` is an out-of-process frame: Playwright opens a CDP session
 * to it only then, and refuses at once (no browser round trip) for a frame in
 * the page's own process. Asked once per Frame; a check that does not answer
 * within TARGET_ID_WAIT_MS counts as "yes", the cautious side.
 */
function outOfProcess(page: Page, frame: Frame): Promise<boolean> {
  let check = outOfProcessChecks.get(frame);
  if (check === undefined) {
    check = (async () => {
      try {
        const context = page.context() as unknown as {
          newCDPSession?: (target: Frame) => Promise<{ detach: () => Promise<void> }>;
        };
        if (typeof context?.newCDPSession !== 'function') return false;
        const session = await context.newCDPSession(frame);
        await session.detach().catch(() => {});
        return true;
      } catch {
        return false;
      }
    })();
    outOfProcessChecks.set(frame, check);
  }
  return within(check, TARGET_ID_WAIT_MS, true);
}
