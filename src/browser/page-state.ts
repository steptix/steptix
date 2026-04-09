import type { Page } from 'playwright';

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
