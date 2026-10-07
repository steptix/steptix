import type { Page, Request } from 'playwright';

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
