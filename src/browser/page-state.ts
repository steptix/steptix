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

  const deadline = Date.now() + timeoutMs;

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
  // Uses a string expression (like DIAGNOSE_SCRIPT) to avoid TypeScript DOM type issues.
  const remaining = deadline - Date.now();
  if (remaining > quiesceMs) {
    const qMs = quiesceMs;
    const rMs = Math.min(remaining, timeoutMs);
    const domQuiesceScript = `new Promise((resolve) => {
      let timer = null;
      const overallTimer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, ${rMs});

      const resetQuiesce = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          observer.disconnect();
          clearTimeout(overallTimer);
          resolve();
        }, ${qMs});
      };

      const observer = new MutationObserver(() => resetQuiesce());
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      resetQuiesce();
    })`;

    await page
      .evaluate(domQuiesceScript)
      .catch(() => {
        /* page navigated or closed — fine, we'll diagnose whatever state we're in */
      });
  }

  return diagnosePageState(page);
}
