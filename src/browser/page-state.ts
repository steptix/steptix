import type { BrowserContext, Page, Request, Response } from 'playwright';

/**
 * Tracks in-flight network requests for a Page so callers can cheaply ask
 * "is the network idle right now?" without a timeout-based probe.
 *
 * Attach once per step (listeners live until `dispose()` is called).
 */
export class PageActivityTracker {
  private inFlight = 0;
  private readonly onRequest: (req: Request) => void;
  private readonly onFinished: (req: Request) => void;
  private readonly onFailed: (req: Request) => void;

  constructor(private readonly page: Page) {
    this.onRequest = () => { this.inFlight++; };
    this.onFinished = () => { this.inFlight = Math.max(0, this.inFlight - 1); };
    this.onFailed = () => { this.inFlight = Math.max(0, this.inFlight - 1); };
    page.on('request', this.onRequest);
    page.on('requestfinished', this.onFinished);
    page.on('requestfailed', this.onFailed);
  }

  /** True when there are no outstanding requests. */
  isIdle(): boolean {
    return this.inFlight <= 0;
  }

  /** Number of requests currently in flight. */
  get pendingCount(): number {
    return Math.max(0, this.inFlight);
  }

  /** Remove listeners. Safe to call multiple times. */
  dispose(): void {
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onFinished);
    this.page.off('requestfailed', this.onFailed);
  }
}

/** Diagnosis of the current page state, used to inform retry decisions */
export interface PageStateDiagnosis {
  /** Current URL */
  url: string;
  /** Page title */
  title: string;
  /** Whether common loading indicators are visible */
  isLoading: boolean;
  /** Descriptions of detected loading indicators */
  loadingIndicators: string[];
  /** Whether an error/alert overlay or toast is visible */
  hasErrorOverlay: boolean;
  /** Text content of any visible error overlays */
  errorMessages: string[];
  /** Whether a generic modal/dialog is visible */
  hasModal: boolean;
  /** Whether the document is still loading (readyState !== 'complete') */
  documentLoading: boolean;
}

interface RawDiagnosis {
  readyState: string;
  loadingIndicators: string[];
  errorMessages: string[];
  hasModal: boolean;
}

/**
 * Browser-side script that checks for loading indicators, error overlays,
 * and modals. Returns a plain object serialisable by Playwright.
 */
const DIAGNOSE_SCRIPT = `(() => {
  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.getBoundingClientRect().height > 0
    );
  };

  const visibleMatching = (selectors) => {
    const results = [];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (isVisible(el)) results.push(el);
        }
      } catch { /* skip invalid selectors */ }
    }
    return results;
  };

  const describeElement = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    return '<' + tag + id + cls + '>';
  };

  // --- Loading indicators ---
  const loadingSelectors = [
    '.spinner', '.loading', '.loader', '.skeleton',
    '[aria-busy="true"]', '[role="progressbar"]',
    '.progress:not([value="100"])', '.loading-overlay',
    '.spin', '.pulse',
  ];
  const loadingEls = visibleMatching(loadingSelectors);

  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    if (
      el.children.length === 0 &&
      isVisible(el) &&
      /^(loading|please wait|submitting)\\s*\\.{0,3}$/i.test((el.textContent || '').trim())
    ) {
      loadingEls.push(el);
    }
  }

  const loadingIndicators = loadingEls.map(describeElement);

  // --- Error overlays ---
  const errorSelectors = [
    '[role="alert"]',
    '.toast-error', '.alert-danger', '.alert-error',
    '.notification-error', '.error-message',
    '.Toastify__toast--error',
  ];
  const errorEls = visibleMatching(errorSelectors);

  const dialogs = visibleMatching(['[role="dialog"]', '[role="alertdialog"]']);
  for (const d of dialogs) {
    const text = (d.textContent || '').toLowerCase();
    if (/error|failed|problem|unable|sorry/.test(text)) {
      errorEls.push(d);
    }
  }

  const seen = new Set();
  const errorMessages = [];
  for (const el of errorEls) {
    const text = (el.textContent || '').trim().slice(0, 200) || describeElement(el);
    if (!seen.has(text)) { seen.add(text); errorMessages.push(text); }
  }

  // --- Modals/dialogs ---
  const modalSelectors = [
    '[role="dialog"]', '[role="alertdialog"]',
    '.modal.show', '.modal[open]', 'dialog[open]',
  ];
  const modalEls = visibleMatching(modalSelectors);

  return {
    readyState: document.readyState,
    loadingIndicators,
    errorMessages,
    hasModal: modalEls.length > 0,
  };
})()`;

/**
 * Diagnose the current page state by checking for loading indicators,
 * error overlays, and modals. Runs a single page.evaluate() for speed.
 */
export async function diagnosePageState(page: Page): Promise<PageStateDiagnosis> {
  const [raw, title] = await Promise.all([
    page.evaluate(DIAGNOSE_SCRIPT) as Promise<RawDiagnosis>,
    page.title().catch(() => ''),
  ]);

  return {
    url: page.url(),
    title,
    isLoading: raw.readyState !== 'complete' || raw.loadingIndicators.length > 0,
    loadingIndicators: raw.loadingIndicators,
    hasErrorOverlay: raw.errorMessages.length > 0,
    errorMessages: raw.errorMessages,
    hasModal: raw.hasModal,
    documentLoading: raw.readyState !== 'complete',
  };
}

export interface PageStabilityOptions {
  /** Maximum time to wait for stability in ms (default: 10_000) */
  timeoutMs?: number;
  /** How long the DOM must be mutation-free to be considered quiet (default: 1_000) */
  quiesceMs?: number;
  /**
   * Also wait for network idle (default: false).
   * Defaults to false because SPAs with websockets, analytics beacons, or
   * long-polls never reach networkidle, making it a poor blocking signal.
   * DOM quiescence is the primary settle signal.
   */
  networkIdle?: boolean;
  /**
   * Keep waiting across ONE navigation (docs/specs/SPEC-codebehind-robustness.md
   * §6.1). Off by default, so every caller that does not ask keeps today's
   * timing exactly.
   *
   * Without it, a navigation that lands during the quiet wait destroys the
   * script doing the waiting, and the wait returns at that instant — the very
   * moment a reader needs it to carry on. A compiled `If the page title
   * contains "Dashboard" then return` asked right after a sign-in click read
   * the title of a page still loading, and missed the return.
   *
   * With it: when the quiet wait rejects and the page navigated — its URL
   * changed since the wait began, or the error says the execution context was
   * destroyed — and the page is still open, wait for the new document's
   * `domcontentloaded` and then for quiet once more, all within what is left
   * of `timeoutMs`. At most one such re-wait; any other rejection returns at
   * once, as without the option.
   */
  followNavigation?: boolean;
  /** The clock, injected by tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Cheap fingerprint of the page's user-visible state.
 * Used to detect "something changed after the action ran" without capturing
 * the full DOM snapshot. Stable enough for equality comparison, coarse enough
 * that cosmetic animations and analytics pings don't flap it.
 */
export interface PageSignal {
  url: string;
  /** Composite fingerprint: body html length : text length : element count */
  domFingerprint: string;
}

const FINGERPRINT_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return { bodyLen: 0, textLen: 0, elCount: 0 };
  const html = body.innerHTML || '';
  const text = body.textContent || '';
  const els = body.getElementsByTagName('*').length;
  return { bodyLen: html.length, textLen: text.length, elCount: els };
})()`;

export async function capturePageSignal(page: Page): Promise<PageSignal> {
  try {
    const fp = (await page.evaluate(FINGERPRINT_SCRIPT)) as {
      bodyLen: number;
      textLen: number;
      elCount: number;
    };
    return {
      url: page.url(),
      domFingerprint: `${fp.bodyLen}:${fp.textLen}:${fp.elCount}`,
    };
  } catch {
    // Page may have navigated away mid-evaluate — return a synthetic signal
    // that will compare unequal to any prior.
    return { url: page.url(), domFingerprint: `navigating:${Date.now()}` };
  }
}

export interface PostActionSettleOptions {
  /** Page signal captured before the triggering action executed */
  preSignal: PageSignal;
  /** Hard cap on total wait time (default 3500ms) */
  timeoutMs?: number;
  /** If the signal hasn't changed for this long, treat the action as a no-op (default 1200ms) */
  noChangeTimeoutMs?: number;
  /** Once the signal has changed, require this much quiet time before declaring settled (default 600ms) */
  settleMs?: number;
  /** Poll cadence (default 150ms) */
  pollMs?: number;
}

/**
 * Wait for the page to finish reacting to an action.
 *
 * Strategy: pre/post diff with early exit.
 *   - Poll the page signal (URL + DOM fingerprint) at `pollMs` cadence.
 *   - If the signal has changed and has been stable for `settleMs`, we're done.
 *   - If the signal has never changed and `noChangeTimeoutMs` has elapsed, the
 *     action was a no-op; return (don't burn the full timeout).
 *   - If neither condition is hit, bail at `timeoutMs`.
 *
 * Deliberately does NOT wait for `networkidle` — SPAs with websockets,
 * long-polls, or analytics beacons never reach it, producing long dead waits
 * even when the user-visible page is stable.
 */
export async function waitForPostActionSettle(
  page: Page,
  options: PostActionSettleOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3_500;
  const noChangeTimeoutMs = options.noChangeTimeoutMs ?? 1_200;
  const settleMs = options.settleMs ?? 600;
  const pollMs = options.pollMs ?? 150;

  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastSignal = options.preSignal;
  let lastChangeAt = start;
  let everChanged = false;

  while (Date.now() < deadline) {
    if (page.isClosed()) return;

    const current = await capturePageSignal(page);
    if (
      current.url !== lastSignal.url ||
      current.domFingerprint !== lastSignal.domFingerprint
    ) {
      everChanged = true;
      lastChangeAt = Date.now();
      lastSignal = current;
    }

    const sinceChange = Date.now() - lastChangeAt;
    if (everChanged && sinceChange >= settleMs) return;
    if (!everChanged && sinceChange >= noChangeTimeoutMs) return;

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Wait for the page to reach a stable state before making decisions.
 * Combines network idle detection with DOM mutation monitoring.
 * Returns the page state diagnosis once stable, or after timeout.
 */
export async function waitForPageStability(
  page: Page,
  options?: PageStabilityOptions,
): Promise<PageStateDiagnosis> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const quiesceMs = options?.quiesceMs ?? 1_000;
  // Default to false: networkidle is a poor signal on SPAs (websockets, long-polls,
  // analytics beacons keep it busy even when the page is visually stable).
  const networkIdle = options?.networkIdle ?? false;
  const followNavigation = options?.followNavigation ?? false;
  const now = options?.now ?? Date.now;

  const deadline = now() + timeoutMs;
  // Only read when it is used: a page that has gone away answers `url()` from
  // its last state, but a test's hand-built page may not answer at all.
  const startUrl = followNavigation ? urlOf(page) : undefined;

  // Wait for network idle first (if enabled) — use a shorter timeout so we
  // still have time for the DOM quiescence check.
  if (networkIdle) {
    const netTimeout = Math.min(timeoutMs * 0.6, timeoutMs - quiesceMs - 500);
    if (netTimeout > 0) {
      await page
        .waitForLoadState('networkidle', { timeout: netTimeout })
        .catch(() => {
          /* network didn't go idle in time — continue anyway */
        });
    }
  }

  // Now wait for DOM quiescence: no mutations for `quiesceMs` milliseconds.
  let followed = false;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= quiesceMs) break;
    try {
      await page.evaluate(domQuiesceScript(quiesceMs, Math.min(remaining, timeoutMs)));
      break;
    } catch (err) {
      // The page navigated or closed under the script. Without
      // `followNavigation` that ends the wait — we diagnose whatever state the
      // page is in. With it, a navigation gets one re-wait in the new document.
      if (!followNavigation || followed) break;
      if (!navigatedSince(page, startUrl, err)) break;
      if (pageClosed(page)) break;
      followed = true;
      const left = deadline - now();
      if (left <= 0) break;
      await page
        .waitForLoadState('domcontentloaded', { timeout: left })
        .catch(() => {
          /* the new document did not get that far in time — quiet-wait what is there */
        });
    }
  }

  return diagnosePageState(page);
}

/**
 * The DOM quiet wait: resolves once nothing has mutated for `quietMs`, or at
 * `budgetMs` whatever the page is doing. A string expression (like
 * DIAGNOSE_SCRIPT) to avoid TypeScript DOM type issues.
 */
function domQuiesceScript(quietMs: number, budgetMs: number): string {
  return `new Promise((resolve) => {
      let timer = null;
      const overallTimer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, ${budgetMs});

      const resetQuiesce = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          observer.disconnect();
          clearTimeout(overallTimer);
          resolve();
        }, ${quietMs});
      };

      const observer = new MutationObserver(() => resetQuiesce());
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      resetQuiesce();
    })`;
}

/** The page's URL, or undefined when it cannot say. */
function urlOf(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/** Did the page navigate since a wait that began at `startUrl` — its URL
 *  moved, or `err` is Playwright's "the document went away under the script"? */
function navigatedSince(page: Page, startUrl: string | undefined, err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/execution context was destroyed/i.test(message)) return true;
  const current = urlOf(page);
  return current !== undefined && startUrl !== undefined && current !== startUrl;
}

/** `page.isClosed()`, read defensively: a closed page is never waited on. */
function pageClosed(page: Page): boolean {
  try {
    return typeof page.isClosed === 'function' && page.isClosed();
  } catch {
    return true;
  }
}

// ── The wait after a compiled action (docs/specs/SPEC-codebehind-robustness.md §6.4) ──

/**
 * One first-party request that began while the watcher was armed, as it saw
 * it (docs/specs/SPEC-codebehind-robustness.md §6.9) — what a compile run
 * shows the generator an action did on the network.
 */
export interface ObservedRequest {
  method: string;
  /** The URL's path; the query is left off, since it can carry a token. */
  path: string;
  /** The response's status — absent when the request failed, or had not
   *  answered when the settle ended. */
  status?: number;
  /** From the request to its end — absent while it was still in flight. */
  ms?: number;
}

/** What one {@link ActionWatcher.settle} waited for, and what it left behind. */
export interface SettleReport {
  /** How long the settle took. */
  waitedMs: number;
  /** First-party requests that began since the watcher was armed (or since
   *  the previous settle ended) and were waited for. */
  tracked: number;
  /** `METHOD /path` of each tracked request still in flight when the budget
   *  ran out — empty unless it did. */
  stillPending: string[];
  /** The first-party requests that began in the same window, in the order
   *  they began (§6.9). */
  requests: ObservedRequest[];
}

export interface ActionWatcherOptions {
  /** The most one settle waits, in all — `min(10 s, execution.timeout)`. */
  budgetMs: number;
  /** How long the URL and the DOM fingerprint must hold still once every
   *  tracked request is done. */
  quietMs: number;
  /** With nothing tracked and nothing changed, stop after this long. */
  quickExitMs: number;
  /** Sampling cadence. Default 100 ms. */
  pollMs?: number;
  /** The page to sample, read at each sample — the active tab, after a switch
   *  the entry made. Defaults to the page the watcher was armed on. */
  activePage?: () => Page;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** An armed watcher. Dispose of it when the entry is done with it. */
export interface ActionWatcher {
  /**
   * Wait until what began since the watcher was armed — or since the previous
   * settle ended — is over: every tracked request finished, then the page
   * quiet for `quietMs`. Never throws and never fails; at the budget it stops
   * and reports what is still pending.
   *
   * `onlyIfPending`: with no tracked request in flight, report at once rather
   * than wait — for a caller that has already waited for the page to hold
   * still, and needs this wait only for a request that outlived it (§6.9).
   *
   * `ifActive`: when an earlier settle has finished and nothing has happened
   * since — no request begun or in flight, and the page as that settle left
   * it — report at once rather than give the page another quick-exit window.
   * For the wait after an entry whose code ends by settling itself: a second
   * window there only stacks one wait on another.
   */
  settle(signal?: AbortSignal, options?: { onlyIfPending?: boolean; ifActive?: boolean }): Promise<SettleReport>;
  dispose(): void;
}

/** What a sample of the page holds, as one comparable string; `undefined`
 *  when the page could not be read (closed, or between documents). */
type Sample = string | undefined;

/** A sample that could not be read. Constant, so a page that stays unreadable
 *  holds still rather than reading as a change on every sample. */
const UNREADABLE = 'unreadable';

/**
 * The bookkeeping of one settle, as a pure state machine: told what happened
 * and when, asked whether to stop. No clock and no page of its own, so its
 * rules are tested with no timers at all.
 */
export class SettleTracker {
  private readonly pending = new Map<unknown, string>();
  private begun = 0;
  private changed = false;
  private lastActivityAt: number;
  private lastSample: string;

  constructor(
    private readonly startedAt: number,
    firstSample: string,
    private readonly options: Pick<ActionWatcherOptions, 'budgetMs' | 'quietMs' | 'quickExitMs'>,
    /** Requests already in flight that this settle must also wait for — begun
     *  since the watcher was armed, before this settle started. */
    inFlight: ReadonlyMap<unknown, string> = new Map(),
    /** Requests that began, or a change seen, since the watcher was armed or
     *  the previous settle ended, before this settle started. */
    carried: { begun: number; changed: boolean } = { begun: 0, changed: false },
  ) {
    this.lastActivityAt = startedAt;
    this.lastSample = firstSample;
    for (const [key, label] of inFlight) this.pending.set(key, label);
    this.begun = carried.begun;
    this.changed = carried.changed;
  }

  requestBegan(key: unknown, label: string, at: number): void {
    this.pending.set(key, label);
    this.begun++;
    this.lastActivityAt = at;
  }

  requestEnded(key: unknown, at: number): void {
    if (this.pending.delete(key)) this.lastActivityAt = at;
  }

  sampled(sample: string, at: number): void {
    if (sample === this.lastSample) return;
    this.lastSample = sample;
    this.changed = true;
    this.lastActivityAt = at;
  }

  /**
   * Whether to keep waiting, or why to stop.
   *
   * The quiet a settle ends on depends on what happened. After a request, the
   * page is given `quietMs` (600 ms) to render what it answered. With no
   * request at all — the page changed by itself, or did not change — it is
   * given `quickExitMs` (250 ms) after the last change: long enough to see a
   * request a handler starts on a short timer, and no longer. Measured live,
   * 600 ms after every DOM-only change cost a compiled click about 0.6 s it
   * had no use for (docs/specs/SPEC-codebehind-robustness.md §6.4, as built).
   */
  decide(at: number): 'wait' | 'settled' | 'quick-exit' | 'budget' {
    if (at - this.startedAt >= this.options.budgetMs) return 'budget';
    if (this.pending.size > 0) return 'wait';
    if (this.begun === 0 && !this.changed) {
      return at - this.startedAt >= this.options.quickExitMs ? 'quick-exit' : 'wait';
    }
    const quiet = this.begun > 0 ? this.options.quietMs : this.options.quickExitMs;
    return at - this.lastActivityAt >= quiet ? 'settled' : 'wait';
  }

  get tracked(): number {
    return this.begun;
  }

  stillPending(): string[] {
    return [...this.pending.values()];
  }
}

/**
 * Arm the wait after a compiled action (docs/specs/SPEC-codebehind-robustness.md
 * §6.4) — on the browser CONTEXT, so a request from a tab the entry opens
 * counts too — just before the entry runs.
 *
 * `waitForPostActionSettle` cannot see the network at all, on purpose: it
 * replaced a wait for `networkidle`, which single-page apps with websockets,
 * long-polls or analytics pings never reach. Measured, it returned on the OLD
 * page after a click whose API took 2 s, and the compiled entries that follow
 * a click had no wait at all. This one waits for exactly the network work that
 * matters and nothing else:
 *
 *  - **tracked:** a request that begins after arming, of type `document`,
 *    `fetch` or `xhr`, and first-party — same origin as the page when armed. A
 *    main-frame navigation always counts, wherever it goes;
 *  - **ignored:** WebSockets, EventSource, beacons and pings, images, fonts,
 *    scripts, third-party hosts, and anything already open when it was armed.
 *
 * It cannot tell which code started a request, so any first-party request that
 * begins while it is armed counts (D2): a poll that starts in the window is
 * waited for, up to the budget. Never a failure — at the budget the report
 * names what is still pending and the caller carries on.
 *
 * With no DOM signal when armed (no page, a page that cannot be read) the
 * watcher is inert and every settle returns at once: a page that cannot be
 * sampled would otherwise read as "changed" on every sample and spin to the
 * budget.
 */
export function armActionWatcher(
  context: BrowserContext,
  page: Page,
  options: ActionWatcherOptions,
): ActionWatcher & { ready: Promise<void> } {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 50;
  const activePage = options.activePage ?? ((): Page => page);
  const origin = originOf(urlOf(page));
  /** Tracked requests in flight, keyed by the request itself. */
  const inFlight = new Map<unknown, string>();
  /** Requests begun since arming, or since the previous settle ended. */
  let begunSince = 0;
  /** The first-party ones among them, as observed (§6.9). */
  let observed: Array<ObservedRequest & { key: unknown; startedAt: number }> = [];
  let current: SettleTracker | undefined;
  let disposed = false;
  /** A settle has finished, and `baseline` is the page it left. */
  let settledOnce = false;

  const onRequest = (req: Request): void => {
    if (!trackable(req, origin)) return;
    const label = requestLabel(req);
    inFlight.set(req, label);
    begunSince++;
    current?.requestBegan(req, label, now());
    if (firstParty(req, origin) && observed.length < MAX_OBSERVED_REQUESTS) {
      observed.push({ key: req, method: methodOf(req), path: pathOf(req), startedAt: now() });
    }
  };
  const onResponse = (res: Response): void => {
    let req: Request;
    try {
      req = res.request();
    } catch {
      return;
    }
    const seen = observed.find((o) => o.key === req);
    if (seen === undefined) return;
    try {
      seen.status = res.status();
    } catch {
      /* no status to report */
    }
  };
  const onDone = (req: Request): void => {
    const seen = observed.find((o) => o.key === req);
    if (seen !== undefined && seen.ms === undefined) seen.ms = now() - seen.startedAt;
    if (!inFlight.delete(req)) return;
    current?.requestEnded(req, now());
  };
  const listening = typeof (context as { on?: unknown } | undefined)?.on === 'function';
  if (listening) {
    context.on('request', onRequest);
    context.on('response', onResponse);
    context.on('requestfinished', onDone);
    context.on('requestfailed', onDone);
  }
  /** What was observed, in the report's shape. */
  const requestsSoFar = (): ObservedRequest[] =>
    observed.map(({ method, path, status, ms }) => ({
      method,
      path,
      ...(status !== undefined && { status }),
      ...(ms !== undefined && { ms }),
    }));
  /** The page when armed: the baseline a change is measured against, and the
   *  proof there is a DOM signal at all. */
  const armed = samplePage(page);
  let baseline: Sample;
  const ready = armed.then((s) => {
    baseline = s;
  });

  return {
    ready,
    async settle(
      signal?: AbortSignal,
      settleOptions?: { onlyIfPending?: boolean; ifActive?: boolean },
    ): Promise<SettleReport> {
      await ready;
      if (baseline === undefined || disposed || signal?.aborted) {
        return { waitedMs: 0, tracked: 0, stillPending: [], requests: requestsSoFar() };
      }
      if (settleOptions?.onlyIfPending === true && inFlight.size === 0) {
        return { waitedMs: 0, tracked: begunSince, stillPending: [], requests: requestsSoFar() };
      }
      const startedAt = now();
      let last = (await samplePage(activePage())) ?? UNREADABLE;
      // Nothing since the last settle finished: no request, and the page as
      // that settle left it. Another quick-exit window would only stack.
      if (
        settleOptions?.ifActive === true &&
        settledOnce &&
        inFlight.size === 0 &&
        begunSince === 0 &&
        last === baseline
      ) {
        return { waitedMs: now() - startedAt, tracked: 0, stillPending: [], requests: requestsSoFar() };
      }
      const tracker = new SettleTracker(startedAt, last, options, inFlight, {
        begun: begunSince,
        changed: last !== baseline,
      });
      current = tracker;
      let decision = tracker.decide(now());
      try {
        while (decision === 'wait' && !signal?.aborted && !disposed) {
          await sleep(pollMs);
          last = (await samplePage(activePage())) ?? UNREADABLE;
          tracker.sampled(last, now());
          decision = tracker.decide(now());
        }
      } finally {
        current = undefined;
      }
      const requests = requestsSoFar();
      // The next settle waits only for what happens after this one.
      // Each request is reported once, by the settle whose window it began in.
      begunSince = 0;
      observed = [];
      baseline = last;
      settledOnce = true;
      return {
        waitedMs: now() - startedAt,
        tracked: tracker.tracked,
        stillPending: decision === 'budget' ? tracker.stillPending() : [],
        requests,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (!listening) return;
      context.off('request', onRequest);
      context.off('response', onResponse);
      context.off('requestfinished', onDone);
      context.off('requestfailed', onDone);
    },
  };
}

/** The request types an action's answer arrives as. */
const TRACKED_TYPES = new Set(['document', 'fetch', 'xhr']);

/** How many requests one settle's report lists: enough for what one action
 *  starts, and a bound on a page that polls (§6.9). Every one is still waited
 *  for. */
const MAX_OBSERVED_REQUESTS = 20;

/** Is `req` network work the wait after an action waits for? */
function trackable(req: Request, origin: string | undefined): boolean {
  let type: string;
  try {
    type = req.resourceType();
  } catch {
    return false;
  }
  if (!TRACKED_TYPES.has(type)) return false;
  if (type === 'document' && isMainFrameNavigation(req)) return true;
  if (origin === undefined) return false;
  try {
    return originOf(req.url()) === origin;
  } catch {
    return false;
  }
}

function isMainFrameNavigation(req: Request): boolean {
  try {
    return req.isNavigationRequest() && req.frame().parentFrame() === null;
  } catch {
    return false;
  }
}

/** `METHOD /path` — the query left off, since it can carry a token. */
function requestLabel(req: Request): string {
  return `${methodOf(req)} ${pathOf(req)}`;
}

function methodOf(req: Request): string {
  try {
    return req.method();
  } catch {
    return 'GET';
  }
}

/** The request URL's path — the query left off, since it can carry a token. */
function pathOf(req: Request): string {
  let path: string;
  try {
    path = req.url();
  } catch {
    return '';
  }
  try {
    return new URL(path).pathname;
  } catch {
    return path.split('?')[0] ?? path;
  }
}

/** Same origin as the page when the watcher was armed. A main-frame
 *  navigation elsewhere is waited for, but is not the app's own request. */
function firstParty(req: Request, origin: string | undefined): boolean {
  if (origin === undefined) return false;
  try {
    return originOf(req.url()) === origin;
  } catch {
    return false;
  }
}

/** An http(s) origin, or undefined — `about:blank` has none worth comparing. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** The page's URL and DOM fingerprint as one comparable string, or undefined
 *  when it cannot be read — unlike `capturePageSignal`, never a fresh value per
 *  failure, so a page that stays unreadable holds still. */
async function samplePage(page: Page): Promise<Sample> {
  try {
    if (page.isClosed()) return undefined;
    const fp = (await page.evaluate(FINGERPRINT_SCRIPT)) as {
      bodyLen: number;
      textLen: number;
      elCount: number;
    };
    return `${page.url()}|${fp.bodyLen}:${fp.textLen}:${fp.elCount}`;
  } catch {
    return undefined;
  }
}
