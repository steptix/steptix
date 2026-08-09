import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

/**
 * Resolved video-recording mode. The user-facing config (`BrowserConfig.video`)
 * also admits booleans as sugar; `resolveVideoMode` normalises to these three
 * canonical strings so every consumer (launch + teardown) sees one shape.
 */
export type VideoMode = 'off' | 'on' | 'retain-on-failure';

/**
 * Normalise `BrowserConfig.video` (tri-state string OR boolean sugar) to a
 * canonical `VideoMode`. Pure + exported so the coercion is unit-testable
 * without launching a browser, and so it is applied at exactly one
 * consumption point rather than smeared across the config loader.
 *   - `true`  → `'on'`
 *   - `false` / `undefined` → `'off'` (the latter defends synthesized
 *     BrowserConfigs — CDP, tests — that skip `DEFAULT_CONFIG`)
 *   - any of the three strings passes through unchanged.
 */
export function resolveVideoMode(v: BrowserConfig['video']): VideoMode {
  if (v === true) return 'on';
  if (v === false || v === undefined) return 'off';
  if (v === 'off' || v === 'on' || v === 'retain-on-failure') return v;
  // Runtime guard: the loader is a plain deep-merge with no per-field
  // validation, so a hand-edited config can carry a value the TS type / JSON
  // schema would reject — e.g. a typo'd "retain-on-faliure". Fail safe to
  // 'off' rather than silently record-and-keep on an unrecognised string.
  logger.warn(
    `Unknown browser.video value ${JSON.stringify(v as unknown)} — recording disabled ` +
      `(expected "off" | "on" | "retain-on-failure", or true/false)`,
  );
  return 'off';
}

// Apply stealth plugin to avoid bot detection. Gated per-run via
// BrowserConfig.stealth so sites incompatible with stealth's monkey-patching
// (e.g. Polymer 1 stacks) can opt out.
let stealthApplied = false;
function ensureStealth(): void {
  if (stealthApplied) return;
  stealthChromium.use(StealthPlugin());
  stealthApplied = true;
}

/**
 * Pre-flight check that the target channel binary is available before we
 * call Playwright's launch — gives a clear "Edge not found" error instead
 * of an opaque "Failed to launch" stack trace from chromium.
 */
async function assertChannelAvailable(channel: string): Promise<void> {
  const known = new Set([
    'chrome',
    'chrome-beta',
    'chrome-dev',
    'chrome-canary',
    'msedge',
    'msedge-beta',
    'msedge-dev',
  ]);
  if (!known.has(channel)) {
    throw new Error(
      `Unknown chromium channel "${channel}". Supported: ${[...known].join(', ')}.`,
    );
  }
  // Lazy-load the executable resolver — Playwright doesn't expose channel
  // path resolution on its public API, so we shell out to a single launch
  // attempt with a short args probe. Failure mode: process.platform-specific
  // binary search for the well-known install paths.
  if (channel === 'chrome') return; // default — no extra check
  const platform = process.platform;
  const candidatePaths = channelInstallPaths(channel, platform);
  if (candidatePaths.length === 0) return; // unknown platform — skip check, let Playwright report
  const fs = await import('node:fs');
  const found = candidatePaths.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      `Channel "${channel}" requested but no matching browser binary was found in any of the expected install locations:\n` +
      candidatePaths.map((p) => `  - ${p}`).join('\n') +
      `\nInstall the browser, or set a different channel.`,
    );
  }
}

function channelInstallPaths(channel: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localApp = process.env['LOCALAPPDATA'] ?? '';
    switch (channel) {
      case 'msedge':
        return [
          `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ];
      case 'msedge-beta':
        return [`${pf}\\Microsoft\\Edge Beta\\Application\\msedge.exe`];
      case 'msedge-dev':
        return [`${pf}\\Microsoft\\Edge Dev\\Application\\msedge.exe`];
      case 'chrome-beta':
        return [`${pf}\\Google\\Chrome Beta\\Application\\chrome.exe`];
      case 'chrome-dev':
        return [`${pf}\\Google\\Chrome Dev\\Application\\chrome.exe`];
      case 'chrome-canary':
        return localApp
          ? [`${localApp}\\Google\\Chrome SxS\\Application\\chrome.exe`]
          : [];
    }
  } else if (platform === 'darwin') {
    switch (channel) {
      case 'msedge': return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
      case 'msedge-beta': return ['/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta'];
      case 'msedge-dev': return ['/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev'];
      case 'chrome-beta': return ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'];
      case 'chrome-dev': return ['/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev'];
      case 'chrome-canary': return ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'];
    }
  } else if (platform === 'linux') {
    switch (channel) {
      case 'msedge': return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
      case 'msedge-beta': return ['/usr/bin/microsoft-edge-beta'];
      case 'msedge-dev': return ['/usr/bin/microsoft-edge-dev'];
      case 'chrome-beta': return ['/usr/bin/google-chrome-beta'];
      case 'chrome-dev': return ['/usr/bin/google-chrome-unstable'];
    }
  }
  return [];
}

export interface TrackedPage {
  page: Page;
  label: string;
  openedAt: number;
  /**
   * The CDP target id, resolved once and cached.
   *
   * **This, not the label, is the load-bearing identifier.** Labels are
   * per-session: two sessions attached to one browser will both have a
   * `page:2`, and only the target id says whether they are the same tab. W0
   * confirmed that every tab any session opens is adopted by every other
   * session on that browser, so this is the common case, not an edge one.
   *
   * `null` until resolved, and permanently null on a browser whose context
   * cannot make CDP sessions (Firefox, WebKit) — the field is a diagnostic,
   * so its absence degrades the report rather than failing the run.
   */
  targetId: string | null;
  /**
   * True when this tab appeared with nothing in this session accounting for
   * it: no step asked for it, and its opener is not a page we drive.
   *
   * Diagnostics only, never enforcement. A wrong guess here is a misleading
   * note in a report; the same guess used as a guard would break a legitimate
   * test. See the §11 rejection of opener-based filtering as a gate.
   */
  unexpected: boolean;
}

export interface PageInfo {
  label: string;
  url: string;
  title: string;
  isActive: boolean;
}

/** Per-step tab attribution, carried on `step:*` events and into the report. */
export interface TabInfo {
  label: string;
  targetId: string | null;
  url: string;
  title: string;
  unexpected: boolean;
}

/** Bound so one hung page cannot stall a run through a diagnostic field.
 *  `page.title()` has no timeout of its own. */
const TAB_TITLE_TIMEOUT_MS = 500;

/** Bound on ONE page's target-id lookup. Per page rather than per sweep, so a
 *  single wedged page does not discard the ids resolved beside it. */
const TARGET_ID_LOOKUP_TIMEOUT_MS = 2_000;

/** A lookup that ran out of time — distinct from `null` ("this page has no
 *  target id"), because only the first means the answer is incomplete. */
const TIMED_OUT = Symbol('target-id-timed-out');

/**
 * Every target id a tracker could resolve, and whether that list is the whole
 * truth.
 *
 * `complete` exists because the consumer is a guard. A caller that cannot tell
 * "nobody holds this tab" from "I could not find out" will treat the second as
 * the first and close a tab out from under a running session.
 */
export interface TargetIdSweep {
  ids: string[];
  complete: boolean;
}

export async function briefly<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask a page for its CDP target id.
 *
 * One CDP round-trip, which is why callers cache the result rather than doing
 * this per step: on a 40-step run that would be 40 extra round-trips per page,
 * in launch mode as well as CDP, to populate a diagnostic field.
 *
 * Returns null rather than throwing on any engine or state that cannot answer.
 */
export async function resolvePageTargetId(page: Page): Promise<string | null> {
  try {
    const context = page.context() as unknown as {
      newCDPSession?: (p: Page) => Promise<{ send: (m: string) => Promise<unknown>; detach: () => Promise<void> }>;
    };
    if (typeof context.newCDPSession !== 'function') return null;
    const session = await context.newCDPSession(page);
    try {
      const info = (await session.send('Target.getTargetInfo')) as
        | { targetInfo?: { targetId?: string } }
        | undefined;
      return info?.targetInfo?.targetId ?? null;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    return null;
  }
}

/** Validation rules for author-supplied custom page labels (the `as` field on
 *  openPage). Returns null when valid, or a human-readable reason when not. */
function validateCustomLabel(label: string): string | null {
  if (!label || typeof label !== 'string') return 'must be a non-empty string';
  if (label === 'main') return '"main" is reserved for the initial page';
  if (/^page:\d+$/i.test(label)) return 'must not match the auto-generated `page:N` form';
  if (!/^[a-z][a-z0-9_-]*$/i.test(label)) {
    return 'must start with a letter and contain only letters, digits, underscore, or hyphen';
  }
  if (label.length > 40) return 'must be 40 characters or fewer';
  return null;
}

export class PageTracker {
  private pages: TrackedPage[] = [];
  private activeIndex = 0;
  /** Pages we should not track. CDP mode pre-populates this with tabs that
   *  existed in the user's Chrome before the test attached. */
  private ignored: Set<Page>;
  /** In-flight target-id lookups, so a describe that races the constructor's
   *  head start joins it rather than starting a second round-trip. */
  private targetIdResolutions = new Map<Page, Promise<string | null>>();

  constructor(initialPage: Page, ignoredPages?: Set<Page>) {
    const entry: TrackedPage = {
      page: initialPage,
      label: 'main',
      openedAt: Date.now(),
      targetId: null,
      // The page we started on is by definition accounted for.
      unexpected: false,
    };
    this.pages.push(entry);
    this.ignored = ignoredPages ?? new Set();
    // Started here rather than on first use so the id is usually cached before
    // the first step needs it; `describeActiveTab` still resolves on demand,
    // so a slow round-trip degrades to one await rather than a null field.
    this.beginTargetIdResolution(entry);
  }

  /**
   * Register a newly opened page. Returns the assigned label, or `null` when
   * the page is on the ignore list (CDP mode: pre-existing user tabs) and
   * should not be tracked or surfaced to the AI.
   */
  addPage(page: Page): string | null {
    if (this.ignored.has(page)) return null;
    const label = `page:${this.pages.length + 1}`;
    const entry: TrackedPage = {
      page,
      label,
      openedAt: Date.now(),
      targetId: null,
      // Provisionally unexpected, then cleared by whichever of the two things
      // that legitimately open a tab actually did:
      //   - a step (`openPage`) calls `markExpected` once newPage resolves;
      //   - a `window.open` from a page we drive resolves an opener we track.
      // What is left is a tab this session cannot account for — most often
      // another session on the same browser, which W0 confirmed we always see.
      unexpected: true,
    };
    this.pages.push(entry);
    this.beginTargetIdResolution(entry);
    void this.resolveOpener(entry);
    logger.info(`New page detected: ${label} (${page.url()})`);

    page.on('close', () => {
      const idx = this.pages.findIndex((p) => p.page === page);
      if (idx === -1) return;
      const closedLabel = this.pages[idx]!.label;
      const wasActive = this.activeIndex === idx;
      this.pages.splice(idx, 1);
      logger.info(`Page closed: ${closedLabel}`);
      if (wasActive) {
        // Active page was closed — fall back to main
        this.activeIndex = 0;
      } else if (this.activeIndex > idx) {
        // A page before the active one was removed — shift index down
        this.activeIndex--;
      }
    });

    return label;
  }

  /** Get the currently active page. */
  getActive(): Page {
    return this.pages[this.activeIndex]?.page ?? this.pages[0]!.page;
  }

  /**
   * Start resolving a page's target id and remember the in-flight promise.
   *
   * The promise is kept, not just the eventual value, because `addPage` is
   * synchronous while resolution is not: a `describeActiveTab` arriving before
   * the head start lands would otherwise see a null field and fire a *second*
   * round-trip for the same page. Awaiting the same promise makes it one
   * round-trip per page however the calls interleave.
   */
  private beginTargetIdResolution(entry: TrackedPage): void {
    const pending = resolvePageTargetId(entry.page)
      .then((id) => {
        if (id !== null) entry.targetId = id;
        return id;
      })
      .catch(() => null);
    this.targetIdResolutions.set(entry.page, pending);
  }

  /** A tab opened by a page we already drive is accounted for. */
  private async resolveOpener(entry: TrackedPage): Promise<void> {
    try {
      const opener = await entry.page.opener();
      if (opener && this.pages.some((p) => p.page === opener)) entry.unexpected = false;
    } catch {
      // Popup already closed, or an engine without opener tracking. Leaving
      // the flag set is the honest answer: we still cannot account for it.
    }
  }

  /**
   * Record that this session deliberately opened `page`.
   *
   * Called by the `openPage` action after `context.newPage()` resolves.
   * Necessary because our own `newPage()` and *another session's* produce an
   * identical signal — both fire `context.on('page')` with a null opener — so
   * the opener heuristic alone would flag every tab a test opens.
   */
  markExpected(page: Page): void {
    const entry = this.pages.find((p) => p.page === page);
    if (entry) entry.unexpected = false;
  }

  /**
   * Describe the tab a step is running in, for the step event and the report.
   *
   * Resolves the target id if the constructor's head start has not landed yet,
   * then caches it — so this is one CDP round-trip per page for the whole run,
   * not one per step. The title is raced against a short timeout because
   * `page.title()` has none of its own and this is a diagnostic field: a hung
   * page must not stall the run that is trying to report on it.
   */
  async describeActiveTab(): Promise<TabInfo | null> {
    const entry = this.pages[this.activeIndex] ?? this.pages[0];
    if (!entry) return null;
    if (entry.targetId === null) {
      // Join the lookup already in flight where there is one; only start a
      // fresh one if it has already settled without an answer.
      const pending = this.targetIdResolutions.get(entry.page);
      entry.targetId = pending ? await pending : await resolvePageTargetId(entry.page);
    }
    let url = '';
    try {
      url = entry.page.url();
    } catch {
      // Page closed between the step finishing and this call.
    }
    const title = await briefly(
      entry.page.title().catch(() => ''),
      TAB_TITLE_TIMEOUT_MS,
      '',
    );
    return {
      label: entry.label,
      targetId: entry.targetId,
      url,
      title,
      unexpected: entry.unexpected,
    };
  }

  /** Every tracked tab, for the report's run-level timeline. */
  tabs(): readonly TrackedPage[] {
    return this.pages;
  }

  /**
   * Target ids of every tab this session is tracking — not just the active one.
   *
   * Awaits any resolution still in flight rather than reading the cached field,
   * because the caller is a guard: "no target id yet" must not read as "this
   * session is not on that tab". A session can `switchPage` back to any tab it
   * holds, so all of them are load-bearing, and a tab whose id never resolved
   * is simply omitted — it cannot match an id the caller is asking about.
   */
  async resolvedTargetIds(): Promise<TargetIdSweep> {
    const ids = await Promise.all(this.pages.map((entry) => this.resolveOne(entry)));
    return {
      // Typed rather than `!== null`: the timeout sentinel is a symbol, and a
      // null-only filter let it through into the id list.
      ids: ids.filter((id): id is string => typeof id === 'string'),
      // `complete` is false when any page could not be resolved *in time*, and
      // it is load-bearing rather than diagnostic: the close guard asks this
      // question to decide whether a session is driving a tab, and for a guard
      // "I could not find out" must never read the same as "nobody is". An
      // earlier version bounded the whole sweep and returned `[]` on expiry,
      // which failed the guard OPEN — one slow lookup and a tab a session was
      // mid-run on became closable.
      complete: !ids.includes(TIMED_OUT),
    };
  }

  /**
   * One page's target id, bounded.
   *
   * The budget is **per page**, not over the whole sweep: one wedged lookup
   * then costs one page rather than every id resolved alongside it, so the
   * partial answer is real rather than a fallback to empty.
   */
  private async resolveOne(entry: TrackedPage): Promise<string | null | typeof TIMED_OUT> {
    if (entry.targetId !== null) return entry.targetId;
    return briefly<string | null | typeof TIMED_OUT>(
      this.resolveOneNow(entry),
      TARGET_ID_LOOKUP_TIMEOUT_MS,
      TIMED_OUT,
    );
  }

  private async resolveOneNow(entry: TrackedPage): Promise<string | null> {
    // Join a lookup already in flight, so concurrent callers cost one
    // round-trip between them.
    const pending = this.targetIdResolutions.get(entry.page);
    let resolved = pending ? await pending : null;
    if (resolved === null) {
      // The head start settled without an answer. Awaiting that same settled
      // promise again — which is all "join the in-flight lookup" does once it
      // has finished — would leave the page permanently invisible after one
      // transient failure. This list is a guard, and an invisible tab is one
      // that can be closed out from under a running session.
      resolved = await resolvePageTargetId(entry.page);
    }
    if (resolved !== null) entry.targetId = resolved;
    return resolved;
  }

  /**
   * The active tab's id and url, for `list_sessions`.
   *
   * Deliberately no title: `page.title()` is a round-trip into the page, and
   * one wedged page would stall a listing that already carries a timeout for
   * exactly that reason. `describeActiveTab` is the variant that pays for a
   * title, and it is called per step, where the cost is already budgeted.
   */
  async activeTabRef(): Promise<{ targetId: string | null; url: string } | null> {
    const entry = this.pages[this.activeIndex] ?? this.pages[0];
    if (!entry) return null;
    if (entry.targetId === null) {
      // Bounded like the sweep. This runs inside `GET /sessions`, which has no
      // timeout of its own, so an unbounded await here hangs the listing —
      // and `list_sessions` is exactly what a caller is told to check when a
      // close is refused for a session that is slow to report its tabs. The
      // remedy must not be blocked by the condition that produced it.
      const pending = this.targetIdResolutions.get(entry.page);
      entry.targetId = pending
        ? await briefly(pending, TARGET_ID_LOOKUP_TIMEOUT_MS, null)
        : null;
    }
    let url = '';
    try {
      url = entry.page.url();
    } catch {
      // Page closed underneath us; the id is still the useful half.
    }
    return { targetId: entry.targetId, url };
  }

  /**
   * Reassign a custom label to an already-tracked page. Used by the openPage
   * action when the test author supplies an `as` field — the auto-handler
   * registered the page as `page:N` first, this lets us replace that label
   * with the author-chosen one for deterministic switchPage targeting.
   *
   * Throws on invalid label (reserved name, bad characters, collision).
   */
  relabelPage(page: Page, newLabel: string): void {
    const validation = validateCustomLabel(newLabel);
    if (validation) {
      throw new Error(`Invalid page label "${newLabel}": ${validation}`);
    }
    if (this.pages.some((p) => p.label === newLabel && p.page !== page)) {
      throw new Error(`Page label "${newLabel}" is already taken by another page`);
    }
    const entry = this.pages.find((p) => p.page === page);
    if (!entry) {
      throw new Error(`Cannot relabel: page is not tracked`);
    }
    const oldLabel = entry.label;
    entry.label = newLabel;
    logger.info(`Page relabelled: ${oldLabel} → ${newLabel} (${page.url()})`);
  }

  /**
   * Switch to a page by label, URL substring, or title substring.
   * Returns the page if found, or null if no match.
   */
  switchTo(identifier: string): Page | null {
    // 1. Exact label match
    const byLabel = this.pages.findIndex((p) => p.label === identifier);
    if (byLabel !== -1) {
      this.activeIndex = byLabel;
      return this.pages[byLabel]!.page;
    }

    // 2. URL substring match
    const byUrl = this.pages.findIndex((p) => p.page.url().includes(identifier));
    if (byUrl !== -1) {
      this.activeIndex = byUrl;
      return this.pages[byUrl]!.page;
    }

    // 3. Title substring match (synchronous — uses last known title)
    const byTitle = this.pages.findIndex((p) => {
      try { return p.page.url() !== 'about:blank'; } catch { return false; }
    });
    // Try title() which returns a promise — but we need a sync fallback.
    // For now, URL and label matching covers the primary use cases.
    // Title matching is attempted via a loop with try/catch on the page reference.
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i]!;
      try {
        // Playwright's page doesn't have a sync title accessor, but we can
        // check if the identifier looks like it could match common patterns
        if (p.page.url().toLowerCase().includes(identifier.toLowerCase())) {
          this.activeIndex = i;
          return p.page;
        }
      } catch { /* page may be closed */ }
    }

    return null;
  }

  /**
   * Switch to a page by label, URL substring, or title.
   * Async variant that also checks page titles.
   */
  async switchToAsync(identifier: string): Promise<Page | null> {
    // 1. Exact label match
    const byLabel = this.pages.findIndex((p) => p.label === identifier);
    if (byLabel !== -1) {
      this.activeIndex = byLabel;
      return this.pages[byLabel]!.page;
    }

    // 2. URL substring match (case-insensitive)
    const byUrl = this.pages.findIndex((p) =>
      p.page.url().toLowerCase().includes(identifier.toLowerCase()),
    );
    if (byUrl !== -1) {
      this.activeIndex = byUrl;
      return this.pages[byUrl]!.page;
    }

    // 3. Title substring match
    for (let i = 0; i < this.pages.length; i++) {
      try {
        const title = await this.pages[i]!.page.title();
        if (title.toLowerCase().includes(identifier.toLowerCase())) {
          this.activeIndex = i;
          return this.pages[i]!.page;
        }
      } catch { /* page may be closed */ }
    }

    return null;
  }

  /**
   * Close a page by label, URL substring, or title.
   * Cannot close the main page. Returns the new active page after closing,
   * or null if the page was not found or is the main page.
   */
  async closePage(identifier: string): Promise<{ closed: boolean; activePage: Page; error?: string }> {
    // Find the target page (reuse switchToAsync matching logic)
    let targetIdx = -1;

    // 1. Exact label match
    targetIdx = this.pages.findIndex((p) => p.label === identifier);

    // 2. URL substring match (case-insensitive)
    if (targetIdx === -1) {
      targetIdx = this.pages.findIndex((p) =>
        p.page.url().toLowerCase().includes(identifier.toLowerCase()),
      );
    }

    // 3. Title substring match
    if (targetIdx === -1) {
      for (let i = 0; i < this.pages.length; i++) {
        try {
          const title = await this.pages[i]!.page.title();
          if (title.toLowerCase().includes(identifier.toLowerCase())) {
            targetIdx = i;
            break;
          }
        } catch { /* page may be closed */ }
      }
    }

    if (targetIdx === -1) {
      return { closed: false, activePage: this.getActive(), error: `no page matching "${identifier}"` };
    }

    if (targetIdx === 0) {
      return { closed: false, activePage: this.getActive(), error: 'cannot close the main page' };
    }

    const targetPage = this.pages[targetIdx]!.page;
    try {
      await targetPage.close();
    } catch {
      // Page may already be closed — the 'close' event handler will clean up
    }

    // The 'close' event handler (registered in addPage) removes the page from
    // the array and adjusts activeIndex, so just return the new active page.
    return { closed: true, activePage: this.getActive() };
  }

  /** Get metadata for all open pages. */
  getPageList(): PageInfo[] {
    return this.pages.map((p, i) => ({
      label: p.label,
      url: p.page.url(),
      title: '', // title requires async — populated by caller if needed
      isActive: i === this.activeIndex,
    }));
  }

  /** Async version of getPageList that includes page titles. */
  async getPageListWithTitles(): Promise<PageInfo[]> {
    const result: PageInfo[] = [];
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i]!;
      let title = '';
      try { title = await p.page.title(); } catch { /* closed */ }
      result.push({
        label: p.label,
        url: p.page.url(),
        title,
        isActive: i === this.activeIndex,
      });
    }
    return result;
  }

  /** Number of tracked pages. */
  get count(): number {
    return this.pages.length;
  }
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  pageTracker: PageTracker;
  /** True when the session was created via `connectOverCDP` rather than a
   *  fresh launch. Drives different teardown semantics (don't kill user's
   *  Chrome, only close the tab we opened). */
  cdp?: boolean;
  /** Set to true when CDP mode opened a new tab for the test. The teardown
   *  closes only this tab; if `cdpTab` selected an existing tab, this is
   *  false and the tab is left open. */
  cdpTabOpenedByUs?: boolean;
  /** Engine + channel labels for reporting and prompt grounding. Optional
   *  for back-compat with code paths that synthesize a `BrowserSession`
   *  without going through `launchBrowser` (CDP mode, tests, etc). */
  engine?: 'chromium' | 'firefox' | 'webkit';
  channel?: string;
  /**
   * Whether this browser has a window a human can watch.
   *
   * Recorded per session rather than read back off the shared `BrowserConfig`
   * because `openBrowser` can override `headed` per browser, so a run can hold
   * a headed one and a headless one at once. The step executor reads it to
   * decide whether bringing a tab to the front is worth doing
   * (stories/cdp-tab-focus.md §4) — pointless in headless, and the point of
   * the feature in headed.
   *
   * Always true under CDP: we attached to a real browser someone started, and
   * `incompatibleCdpConfig` already reports `headed: false` as ignored there.
   */
  headed?: boolean;
}

/** Validation rules for author-supplied browser labels (the `as` field on
 *  openBrowser). Returns null when valid, or a human-readable reason when not. */
function validateBrowserLabel(label: string): string | null {
  if (!label || typeof label !== 'string') return 'must be a non-empty string';
  if (label === 'default') return '"default" is reserved for the initial browser';
  if (!/^[a-z][a-z0-9_-]*$/i.test(label)) {
    return 'must start with a letter and contain only letters, digits, underscore, or hyphen';
  }
  if (label.length > 40) return 'must be 40 characters or fewer';
  return null;
}

export interface BrowserInfo {
  label: string;
  engine: string;
  channel: string;
  activePageUrl: string;
  isActive: boolean;
}

/**
 * Tracks every `Browser` instance opened during a test. Mirrors the
 * `PageTracker` pattern at the level above: tracker holds N labelled
 * sessions, exactly one is active at a time, all are closed in reverse
 * creation order at test end.
 *
 * Each tracked entry is a full `BrowserSession` (browser + context + its
 * own `PageTracker`). Switching between tracked browsers is just a pointer
 * update; the new session's active page becomes whatever its `pageTracker`
 * currently points to.
 */
export class BrowserTracker {
  private sessions: Array<{ label: string; session: BrowserSession }> = [];
  private activeIndex = 0;

  constructor(initialSession: BrowserSession, initialLabel = 'default') {
    this.sessions.push({ label: initialLabel, session: initialSession });
  }

  /** Register a freshly-launched browser session under a custom label.
   *  Throws on validation failure (reserved name, bad characters, collision). */
  add(label: string, session: BrowserSession): void {
    const err = validateBrowserLabel(label);
    if (err) throw new Error(`Invalid browser label "${label}": ${err}`);
    if (this.sessions.some((s) => s.label === label)) {
      throw new Error(`Browser label "${label}" is already taken`);
    }
    this.sessions.push({ label, session });
    // Auto-promote to active — matches openPage precedent (saves authors a
    // separate switchBrowser turn after openBrowser).
    this.activeIndex = this.sessions.length - 1;
    logger.info(`Browser added: ${label} (${session.engine ?? '?'}${session.channel ? '/' + session.channel : ''})`);
  }

  /** Get the currently active browser session. Throws when nothing is
   *  active — the natural consequence of an author closing the only
   *  remaining browser. */
  getActive(): BrowserSession {
    const entry = this.sessions[this.activeIndex];
    if (!entry) {
      throw new Error('no active browser session — closeBrowser left zero browsers tracked');
    }
    return entry.session;
  }

  /** Get the currently active page (active session's active page). */
  getActivePage(): Page {
    return this.getActive().pageTracker.getActive();
  }

  /** Get the currently active browser's label. */
  getActiveLabel(): string {
    return this.sessions[this.activeIndex]?.label ?? 'default';
  }

  has(label: string): boolean {
    return this.sessions.some((s) => s.label === label);
  }

  /**
   * Every browser this session owns, not just the active one.
   *
   * `getActive()` is the wrong question for anything asking "does this session
   * hold X", because `add()` auto-promotes: a session that attached to a CDP
   * tab and then ran `openBrowser` has its CDP browser sitting at index 0 while
   * the active pointer is on the new one. Callers that guard against closing
   * something out from under a session must look at all of them.
   */
  all(): readonly BrowserSession[] {
    return this.sessions.map((s) => s.session);
  }

  /** Switch to a tracked browser by label. Returns the session, throws on
   *  unknown label (matches resolved decision: fail loudly). */
  switchTo(label: string): BrowserSession {
    const idx = this.sessions.findIndex((s) => s.label === label);
    if (idx === -1) {
      const known = this.sessions.map((s) => s.label).join(', ');
      throw new Error(`No browser registered as "${label}" — known: ${known}`);
    }
    this.activeIndex = idx;
    return this.sessions[idx]!.session;
  }

  /** Close a tracked browser by label. Permissive — closes whatever you
   *  point it at, including `default` and including the last remaining one.
   *  If the active browser was closed, the active pointer falls back to
   *  whichever session is now at the same index (or the previous one if the
   *  list is now shorter); a subsequent step with no active browser fails
   *  naturally with `getActive()`'s error. */
  async close(label: string): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.label === label);
    if (idx === -1) {
      const known = this.sessions.map((s) => s.label).join(', ');
      throw new Error(`No browser registered as "${label}" — known: ${known}`);
    }
    const { session } = this.sessions[idx]!;
    try {
      // Same routing as `closeAll`, for the same reason — issues/006 names
      // both. The initial session can be a CDP one, and `default` is a label
      // an author can pass here.
      await closeBrowser(session);
    } catch (err) {
      logger.debug(`Error closing browser "${label}" — ${(err as Error).message}`);
    }
    this.sessions.splice(idx, 1);
    if (this.activeIndex >= this.sessions.length) {
      this.activeIndex = Math.max(0, this.sessions.length - 1);
    } else if (this.activeIndex > idx) {
      this.activeIndex--;
    }
    logger.info(`Browser closed: ${label}`);
  }

  /** Close all tracked browsers in reverse creation order. Called by the
   *  test runner's `finally` block at test end. */
  async closeAll(): Promise<void> {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const { label, session } = this.sessions[i]!;
      try {
        // Routed through `closeBrowser` rather than closing context+browser
        // here, which is issues/006's fix. Its deferral rested on "CDP
        // sessions never enter the tracker" — true of the CLI test-runner,
        // which special-cases `initialSession.cdp` in its `finally`, but NOT
        // of `SessionManager.closeSession`, which calls this unconditionally.
        // That is the path TestBench, flick and MCP all use.
        //
        // Nothing was being destroyed: `context.close()` and `browser.close()`
        // are both verified no-ops against a `connectOverCDP` connection
        // (stories/mcp-cdp-browser.md §8). What WAS happening is that the tab
        // the test opened never got closed, because only `closeBrowser` knows
        // about `cdpTabOpenedByUs` — so every CDP run left a tab behind in the
        // user's signed-in browser. Rare when CDP was a hand-written config
        // line; constant once an agent can drive it.
        await closeBrowser(session);
      } catch (err) {
        logger.debug(`Error closing browser "${label}" — ${(err as Error).message}`);
      }
    }
    this.sessions.length = 0;
  }

  /** Snapshot for reports / prompt context. */
  list(): BrowserInfo[] {
    return this.sessions.map((s, i) => ({
      label: s.label,
      engine: s.session.engine ?? 'chromium',
      channel: s.session.channel ?? 'chrome',
      activePageUrl: (() => {
        try { return s.session.pageTracker.getActive().url(); } catch { return ''; }
      })(),
      isActive: i === this.activeIndex,
    }));
  }

  get count(): number {
    return this.sessions.length;
  }
}

// ---------------------------------------------------------------------------
// CDP support
// ---------------------------------------------------------------------------

/** Parsed `cdpTab` selector. `invalid` carries a reason for clear errors. */
export type CdpTabSpec =
  | { kind: 'new' }
  | { kind: 'active' }
  | { kind: 'index'; index: number }
  | { kind: 'urlSubstring'; value: string }
  | { kind: 'titleSubstring'; value: string }
  | { kind: 'targetId'; value: string }
  | { kind: 'invalid'; reason: string };

/**
 * Parse the raw `cdpTab` string from a test's `## Config` section into a
 * structured selector. Pure / synchronous — unit-testable without a browser.
 */
export function parseCdpTabSpec(raw: string | undefined): CdpTabSpec {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { kind: 'new' };
  const lower = trimmed.toLowerCase();
  if (lower === 'new') return { kind: 'new' };
  if (lower === 'active') return { kind: 'active' };

  // Integer index
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n < 0) return { kind: 'invalid', reason: `cdpTab index must be >= 0, got ${trimmed}` };
    return { kind: 'index', index: n };
  }

  if (lower.startsWith('url~')) {
    const value = trimmed.slice(4).trim();
    if (!value) return { kind: 'invalid', reason: `cdpTab url~ requires a substring, got "${trimmed}"` };
    return { kind: 'urlSubstring', value };
  }

  if (lower.startsWith('title~')) {
    const value = trimmed.slice(6).trim();
    if (!value) return { kind: 'invalid', reason: `cdpTab title~ requires a substring, got "${trimmed}"` };
    return { kind: 'titleSubstring', value };
  }

  if (lower.startsWith('targetid:')) {
    // Preserve the id value verbatim (case + special chars). Only the prefix
    // is case-insensitive.
    const value = trimmed.slice('targetid:'.length).trim();
    if (!value) return { kind: 'invalid', reason: `cdpTab targetId: requires a non-empty id, got "${trimmed}"` };
    return { kind: 'targetId', value };
  }

  return {
    kind: 'invalid',
    reason: `cdpTab "${trimmed}" is not recognised — expected: new, active, <integer>, url~<substr>, title~<substr>, or targetId:<id>`,
  };
}

/**
 * Resolve a `CdpTabSpec` against a list of pages to a specific Page (or null
 * for `new`, meaning the caller should open a fresh tab). Throws with a clear
 * error listing open tabs when nothing matches.
 */
export async function resolveCdpTab(
  pages: ReadonlyArray<Page>,
  spec: CdpTabSpec,
): Promise<Page | null> {
  if (spec.kind === 'invalid') throw new Error(spec.reason);
  if (spec.kind === 'new') return null;

  if (spec.kind === 'index') {
    const p = pages[spec.index];
    if (!p) {
      throw new Error(
        `CDP: no tab at index ${spec.index}. ${await formatTabList(pages)}`,
      );
    }
    return p;
  }

  if (spec.kind === 'urlSubstring') {
    const needle = spec.value.toLowerCase();
    const match = pages.find((p) => p.url().toLowerCase().includes(needle));
    if (!match) {
      throw new Error(
        `CDP: no tab matches url substring "${spec.value}". ${await formatTabList(pages)}`,
      );
    }
    return match;
  }

  if (spec.kind === 'titleSubstring') {
    const needle = spec.value.toLowerCase();
    for (const p of pages) {
      let title = '';
      try { title = await p.title(); } catch { /* tab may have closed */ }
      if (title.toLowerCase().includes(needle)) return p;
    }
    throw new Error(
      `CDP: no tab matches title substring "${spec.value}". ${await formatTabList(pages)}`,
    );
  }

  if (spec.kind === 'targetId') {
    // Use Playwright's CDPSession to ask each page for its underlying
    // Target.targetId. Exact string match — target ids are hex from Chrome
    // and case-sensitive.
    for (const p of pages) {
      const ctx = (p as any).context?.();
      const newCDPSession = ctx?.newCDPSession;
      if (typeof newCDPSession !== 'function') {
        throw new Error(
          `CDP: targetId selector requires a context that supports newCDPSession (Playwright Chromium).`,
        );
      }
      let id = '';
      try {
        const session = await newCDPSession.call(ctx, p);
        const info: any = await session.send('Target.getTargetInfo');
        id = info?.targetInfo?.targetId ?? '';
      } catch { /* tab may have closed or CDP send failed; skip */ }
      if (id && id === spec.value) return p;
    }
    throw new Error(
      `CDP: no tab matches targetId "${spec.value}". ${await formatTabList(pages)}`,
    );
  }

  // 'active' — best effort: pick the first non-DevTools page. Real
  // most-recently-focused detection requires CDP Target.getTargets, which we
  // can wire later via CDPSession.send. For now this is good enough for the
  // common case of a single user-facing tab.
  if (spec.kind === 'active') {
    const candidate = pages.find((p) => !p.url().startsWith('devtools://'));
    if (!candidate) {
      throw new Error(`CDP: no active tab found. ${await formatTabList(pages)}`);
    }
    return candidate;
  }

  // Exhaustiveness — TypeScript should make this unreachable.
  throw new Error(`CDP: unhandled tab spec`);
}

async function formatTabList(pages: ReadonlyArray<Page>): Promise<string> {
  if (pages.length === 0) return 'No tabs are open.';
  const lines: string[] = [`Open tabs (${pages.length}):`];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    let title = '';
    try { title = await p.title(); } catch { /* ignore */ }
    lines.push(`  [${i}] ${p.url()}${title ? `  (${title})` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Verify Chrome is reachable on the given CDP port before attempting to
 * connect. Throws an actionable error telling the user how to start Chrome
 * if it isn't. The optional `fetchFn` parameter exists for unit testing.
 */
export async function preflightCdpPort(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = `http://localhost:${port}/json/version`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await fetchFn(url, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(
        `Cannot connect to Chrome on port ${port}: HTTP ${res.status} from ${url}. ` +
        `Is Chrome running with --remote-debugging-port=${port}?`,
      );
    }
  } catch (err) {
    // Re-throw our own errors as-is; wrap network errors.
    if (err instanceof Error && err.message.startsWith('Cannot connect to Chrome')) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot connect to Chrome on port ${port}. Start Chrome with:\n` +
      `  chrome --remote-debugging-port=${port} --user-data-dir=<some-dir>\n` +
      `and try again. (underlying: ${detail})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface CdpLaunchOptions {
  /** Port Chrome was started with (`--remote-debugging-port=<port>`). */
  port: number;
  /** Raw `cdpTab` string from the test config (parsed internally). */
  tab?: string | undefined;
}

/** Per-launch overrides applied on top of `BrowserConfig`. Used by the
 *  multi-browser feature: each spawned browser can pick its own engine and
 *  channel without mutating the test's shared config. */
export interface LaunchOverrides {
  engine?: 'chromium' | 'firefox' | 'webkit';
  /** Chromium-only — Playwright channel name (`chrome` (default), `msedge`,
   *  `chrome-beta`, `chrome-dev`, `msedge-beta`, `msedge-dev`). */
  channel?: string;
  headed?: boolean;
  /** Absolute `<reports.outputDir>/videos` directory. When set AND
   *  `config.video` resolves to a non-`'off'` mode, the new context is created
   *  with Playwright's `recordVideo: { dir }`. Threaded here (rather than as a
   *  positional param) because `overrides` already carries per-launch context
   *  not present in the shared `BrowserConfig`. */
  videoDir?: string;
}

/**
 * Launch a Playwright browser and create a new page with the given configuration.
 * When `cdp` is provided, attaches to a running Chrome over CDP instead of
 * launching a fresh browser. Chromium (non-CDP) uses playwright-extra with
 * stealth plugin to avoid bot detection.
 *
 * `overrides` lets callers (notably the multi-browser openBrowser action)
 * pick a different engine/channel/headed mode without mutating the test's
 * shared `BrowserConfig`.
 */
export async function launchBrowser(
  config: BrowserConfig,
  cdp?: CdpLaunchOptions,
  overrides?: LaunchOverrides,
): Promise<BrowserSession> {
  if (cdp) {
    return connectOverCdpSession(config, cdp);
  }

  const browserType = overrides?.engine ?? config.browser;
  const headed = overrides?.headed ?? config.headed;
  const channel = overrides?.channel; // undefined = default ('chrome' for chromium)
  const channelLabel = channel ? `/${channel}` : '';
  logger.info(
    `Launching ${browserType}${channelLabel} browser (${headed ? 'headed' : 'headless'})`,
  );

  const { width, height } = headed ? config.windowSize : config.viewport;
  const launchOptions = {
    headless: !headed,
    slowMo: config.slowMo,
    args: [`--window-size=${width},${height}`],
  };

  let browser: Browser;
  switch (browserType) {
    case 'firefox':
      browser = await firefox.launch(launchOptions);
      break;
    case 'webkit':
      browser = await webkit.launch(launchOptions);
      break;
    case 'chromium':
    default: {
      // Default channel = 'chrome' (real Google Chrome — better fingerprint
      // than bundled Chromium). Override via `overrides.channel` for Edge
      // (`msedge`), Chrome Beta, etc.
      const effectiveChannel = channel ?? 'chrome';
      await assertChannelAvailable(effectiveChannel);
      const chromeOpts = { ...launchOptions, channel: effectiveChannel };
      // Stealth's monkey-patches target Chrome internals — apply on the
      // `chrome` channel only; for `msedge` or other channels, fall back to
      // the plain chromium driver (matches user intent: "I want real Edge").
      if (effectiveChannel === 'chrome' && config.stealth !== false) {
        ensureStealth();
        browser = await stealthChromium.launch(chromeOpts) as unknown as Browser;
      } else {
        browser = await chromium.launch(chromeOpts);
      }
    }
  }

  // Record video into `<outputDir>/videos` when the caller threaded a videoDir
  // AND the resolved mode isn't 'off'. Playwright records the whole context at
  // the viewport/window size (headed mode uses `viewport: null` → real window
  // size); the .webm is finalised on context close. The CDP path short-circuits
  // above before reaching newContext, so recording is never attached to an
  // attached browser (Playwright can't record those).
  const videoMode = resolveVideoMode(config.video);
  const context = await browser.newContext({
    viewport: headed ? null : config.viewport,
    // Accept all permissions by default
    permissions: ['clipboard-read', 'clipboard-write'],
    // Do not override userAgent — on the `chrome` channel, the real Chrome UA
    // is already realistic, and hardcoding a mismatched version trips
    // user-agent sniffing on some banking sites (Polymer/browserDetection.js).
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    extraHTTPHeaders: {
      'Accept-Language': 'en-AU,en;q=0.9',
    },
    bypassCSP: config.bypassCSP === true,
    ...(videoMode !== 'off' && overrides?.videoDir
      ? { recordVideo: { dir: overrides.videoDir } }
      : {}),
  });

  const page = await context.newPage();
  const pageTracker = new PageTracker(page);

  // In headed mode, ensure the new window grabs OS focus. On Windows
  // multi-monitor setups a Playwright-launched browser frequently comes up
  // in the background — the user sees a taskbar icon but no visible window
  // until they click it. Page.bringToFront sends the CDP focus call.
  if (headed) {
    try { await page.bringToFront(); } catch { /* non-fatal */ }
  }

  // Auto-register new pages (popups, new tabs) as they open
  context.on('page', async (newPage) => {
    const label = pageTracker.addPage(newPage);
    if (label === null) return; // ignored (CDP pre-existing tab — shouldn't happen here)
    try {
      await newPage.waitForLoadState('domcontentloaded');
      logger.info(`Page ${label} loaded: ${newPage.url()}`);
    } catch {
      logger.debug(`Page ${label} closed before load completed`);
    }
  });

  logger.debug(`Browser launched: ${browserType} ${browser.version()}`);

  const session: BrowserSession = { browser, context, page, pageTracker, engine: browserType, headed };
  if (browserType === 'chromium') session.channel = channel ?? 'chrome';
  return session;
}

/**
 * Connect to a running Chrome over CDP and produce a BrowserSession. The
 * `config` is mostly advisory in this mode — see "Limitations" in the
 * cdp-connection story for what is and isn't honoured.
 */
async function connectOverCdpSession(
  config: BrowserConfig,
  cdp: CdpLaunchOptions,
): Promise<BrowserSession> {
  // Warn loudly about config that won't apply, so the user isn't left wondering
  // why their viewport / stealth / bypassCSP setting did nothing.
  warnOnIncompatibleConfigForCdp(config);

  const tabSpec = parseCdpTabSpec(cdp.tab);
  if (tabSpec.kind === 'invalid') {
    throw new Error(tabSpec.reason);
  }

  await preflightCdpPort(cdp.port);

  logger.info(`Connecting to Chrome over CDP on port ${cdp.port}`);
  const browser = await chromium.connectOverCDP(`http://localhost:${cdp.port}`);

  // The default context exposes the user's profile (cookies, extensions, etc.)
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(
      `CDP: connected to Chrome on port ${cdp.port} but it has no contexts. ` +
      `This is unexpected — try restarting Chrome.`,
    );
  }

  const preExistingPages = new Set<Page>(context.pages());
  let page: Page;
  let openedByUs = false;

  if (tabSpec.kind === 'new') {
    page = await context.newPage();
    openedByUs = true;
    // Match the headed-launch path: pull the window forward so the user sees
    // it on the active monitor instead of having to click the taskbar icon.
    try { await page.bringToFront(); } catch { /* non-fatal */ }
    logger.info(`CDP: opened new tab`);
  } else {
    const existing = context.pages();
    const resolved = await resolveCdpTab(existing, tabSpec);
    if (!resolved) {
      // Should be impossible — non-`new` specs return a Page or throw.
      throw new Error(`CDP: tab resolution returned null for spec ${tabSpec.kind}`);
    }
    page = resolved;
    // Don't ignore the resolved tab — it's our main page. Anything else
    // pre-existing should be ignored.
    preExistingPages.delete(page);
    // Same call its `new`-tab sibling makes a few lines up, and the asymmetry
    // had no defence: a user who names the tab they want the run to use then
    // watches their carefully arranged cart sit untouched while steps run
    // behind it. Silent `catch` to match both neighbours — a browser that
    // declines to raise a window must not fail an attach.
    try { await page.bringToFront(); } catch { /* non-fatal */ }
    logger.info(`CDP: attached to existing tab (${page.url()})`);
  }

  const pageTracker = new PageTracker(page, preExistingPages);

  context.on('page', async (newPage) => {
    const label = pageTracker.addPage(newPage);
    if (label === null) return;
    try {
      await newPage.waitForLoadState('domcontentloaded');
      logger.info(`Page ${label} loaded: ${newPage.url()}`);
    } catch {
      logger.debug(`Page ${label} closed before load completed`);
    }
  });

  logger.debug(`CDP browser version: ${browser.version()}`);

  return {
    browser,
    context,
    page,
    pageTracker,
    cdp: true,
    cdpTabOpenedByUs: openedByUs,
    // Not read off `config`: a CDP browser is one a human started and is
    // looking at, and `incompatibleCdpConfig` already reports `headed: false`
    // as one of the settings this mode ignores.
    headed: true,
  };
}

/**
 * List the `browser` config values that CDP mode silently ignores (the user's
 * running Chrome controls them, or — for `video` — Playwright cannot record a
 * browser it attached to rather than launched). Pure + exported so the list is
 * unit-testable without a real CDP connection.
 */
export function incompatibleCdpConfig(config: BrowserConfig): string[] {
  const ignored: string[] = [];
  if (config.headed === false) ignored.push('headed=false (headless)');
  if (config.stealth === true) ignored.push('stealth=true');
  if (config.bypassCSP === true) ignored.push('bypassCSP=true');
  if (config.slowMo && config.slowMo > 0) ignored.push(`slowMo=${config.slowMo}`);
  // CDP attaches to a browser the harness didn't create; Playwright only
  // records contexts it launched, so video can't be captured under CDP.
  const videoMode = resolveVideoMode(config.video);
  if (videoMode !== 'off') ignored.push(`video=${videoMode}`);
  return ignored;
}

function warnOnIncompatibleConfigForCdp(config: BrowserConfig): void {
  const ignored = incompatibleCdpConfig(config);
  if (ignored.length > 0) {
    logger.warn(
      `CDP mode ignores these browser config values (the user's running Chrome ` +
      `controls them): ${ignored.join(', ')}`,
    );
  }
}

/**
 * Close the browser session and release all resources. In CDP mode this only
 * closes the tab the harness opened (if any) and severs the WebSocket — it
 * does not kill the user's Chrome process.
 */
export async function closeBrowser(session: BrowserSession): Promise<void> {
  try {
    if (session.cdp) {
      if (session.cdpTabOpenedByUs) {
        try { await session.page.close(); } catch { /* tab may already be gone */ }
      }
      // Severs the CDP WebSocket without killing the user's Chrome.
      await session.browser.close().catch(() => {});
      logger.debug('CDP browser session detached');
      return;
    }
    await session.context.close();
    await session.browser.close();
    logger.debug('Browser session closed');
  } catch (err) {
    logger.warn(`Error closing browser: ${String(err)}`);
  }
}

export interface FinalizeMainPageVideoArgs {
  /** The MAIN page — its `video()` handle must be grabbed BEFORE the context
   *  is closed, so pass the page itself and let this helper read it. */
  page: Page;
  /** Resolved recording mode. */
  mode: VideoMode;
  /** Run's overall outcome: `true` = passed, `false` = failed/aborted. Drives
   *  the `retain-on-failure` deletion. */
  passed: boolean;
  /** Absolute `<reports.outputDir>/videos` directory the .webm was recorded into. */
  videoDir: string;
  /** Stable, report-matching base name (no extension), e.g.
   *  `<timestamp>-<safeTestName>` — produced by `buildReportBaseName` so the
   *  .webm sits beside its .html. */
  stableBaseName: string;
  /** Closes the context/browser(s); awaited here so Playwright finalises the
   *  .webm on disk before we rename/delete it. */
  closeContext: () => Promise<void>;
}

/**
 * Finalise the MAIN page's session video after a run.
 *
 * Sequence (the order matters — Playwright only writes the .webm on context
 * close, and `page.video()` must be read while the page is still alive):
 *   1. Grab the `Video` handle from the page (before closing).
 *   2. Close the context/browser(s) — this finalises the .webm (random-hash
 *      name) inside `videoDir`.
 *   3. No video handle → nothing was recorded → return undefined.
 *   4. `retain-on-failure` + passed → delete the .webm and return undefined
 *      (deleting BEFORE any saveAs avoids leaking a copy).
 *   5. Otherwise `saveAs` to the stable name (waits for finalisation; works
 *      cross-device; unlike `path()` it does not throw under remote/CDP — though
 *      CDP never records), then delete the original hash-named file so `videos/`
 *      holds one file per kept run.
 *
 * Returns the ABSOLUTE saved path, or undefined when nothing was kept. Every
 * failure is non-fatal (logged) — recording must never break a run, mirroring
 * the report-generation posture.
 */
export async function finalizeMainPageVideo(
  args: FinalizeMainPageVideoArgs,
): Promise<string | undefined> {
  // Grab the handle + its on-disk path BEFORE closing. page.video() is only
  // non-null when the context was created with recordVideo. video.path()
  // resolves to the local .webm path immediately (no need to wait for close)
  // and keeps working after the browser is gone — UNLIKE video.saveAs()/
  // .delete(), which need the live browser connection that `closeContext()`
  // (closeAll → browser.close()) tears down. So we capture the path now and do
  // a filesystem rename/delete after close. Recording never happens under CDP
  // (caveat #1 — no recordVideo on attached browsers), so page.video() is null
  // there and path()'s remote-throw case is never reached; the file is always
  // local to the server, and source+target share videoDir, so the rename is
  // same-dir (never EXDEV).
  const video = args.mode === 'off' ? null : args.page.video();
  let sourcePath: string | undefined;
  if (video) {
    try {
      sourcePath = await video.path();
    } catch (err) {
      logger.warn(`Could not resolve session video path: ${String(err)}`);
    }
  }

  // Finalises the .webm on disk (at sourcePath, random-hash name).
  await args.closeContext();

  if (!video || !sourcePath) return undefined;

  // retain-on-failure on a PASSING run: drop the recording, no report link.
  if (args.mode === 'retain-on-failure' && args.passed) {
    await fs.rm(sourcePath, { force: true }).catch(() => { /* non-fatal */ });
    return undefined;
  }

  const target = path.join(args.videoDir, `${args.stableBaseName}.webm`);
  try {
    // Rename the finalised hash-named file to the stable, report-matching name.
    // A filesystem rename works after the browser is closed; video.saveAs() does
    // not.
    await fs.rename(sourcePath, target);
    return target;
  } catch (err) {
    logger.warn(`Failed to save session video to ${target}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Get the currently active page from the page tracker.
 */
export function getActivePage(session: BrowserSession): Page {
  return session.pageTracker.getActive();
}
