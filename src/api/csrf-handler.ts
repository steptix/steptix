import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';

export interface CsrfResult {
  token: string;
  selector: string;
}

/** Common CSRF token selector patterns to try as a fallback */
const COMMON_CSRF_SELECTORS = [
  'input[name="__RequestVerificationToken"]',
  'input[name="_csrf"]',
  'input[name="csrf_token"]',
  'input[name="csrfToken"]',
  'meta[name="csrf-token"]',
  'meta[name="_csrf_token"]',
  'meta[name="x-csrf-token"]',
];

/**
 * Extract a CSRF token from the current browser page.
 *
 * @param page — the Playwright page to search
 * @param selector — CSS selector from the context file (tried first)
 * @param navigateTo — optional URL to navigate to before extracting (if not already there)
 */
export async function extractCsrfToken(
  page: Page,
  selector: string,
  navigateTo?: string,
): Promise<CsrfResult | undefined> {
  // Navigate to the specified page if we're not already there
  if (navigateTo) {
    const currentUrl = page.url();
    if (!currentUrl.includes(navigateTo)) {
      // Resolve relative URLs against the current page URL
      let targetUrl = navigateTo;
      if (!navigateTo.startsWith('http://') && !navigateTo.startsWith('https://')) {
        try {
          targetUrl = new URL(navigateTo, currentUrl).toString();
        } catch {
          // leave as-is
        }
      }
      logger.debug(`Navigating to ${targetUrl} to extract CSRF token`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
  }

  // Try the selector specified in the context first
  if (selector) {
    const token = await tryExtractFromSelector(page, selector);
    if (token !== undefined) {
      logger.debug(`CSRF token extracted via context selector: ${selector}`);
      return { token, selector };
    }
  }

  // Fall back to common patterns
  for (const pattern of COMMON_CSRF_SELECTORS) {
    const token = await tryExtractFromSelector(page, pattern);
    if (token !== undefined) {
      logger.debug(`CSRF token extracted via fallback selector: ${pattern}`);
      return { token, selector: pattern };
    }
  }

  logger.warn('Could not extract CSRF token — none of the known selectors matched');
  return undefined;
}

async function tryExtractFromSelector(
  page: Page,
  selector: string,
): Promise<string | undefined> {
  try {
    const locator = page.locator(selector).first();
    const count = await locator.count();
    if (count === 0) return undefined;

    // For input elements the .value JS property is the source of truth — especially for
    // hidden inputs whose value is populated asynchronously (e.g. a CSRF token loaded
    // by a fetch() on page load).  getAttribute('value') only returns the static HTML
    // attribute and misses JS-set values.
    //
    // Poll via locator.evaluate() every 100 ms for up to 5 s to handle async timing.
    // evaluate() bypasses Playwright visibility restrictions so it works on hidden inputs.
    const deadline = Date.now() + 5_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let inputVal = await locator.evaluate((el) => (el as any).value as string).catch(() => '');
    while (!inputVal && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputVal = await locator.evaluate((el) => (el as any).value as string).catch(() => '');
    }
    if (inputVal) return inputVal;

    // Try value attribute (static fallback for elements not covered by the poll above)
    const value = await locator.getAttribute('value');
    if (value) return value;

    // Try content attribute (for <meta name="csrf-token" content="...">)
    const content = await locator.getAttribute('content');
    if (content) return content;

    return undefined;
  } catch {
    return undefined;
  }
}
