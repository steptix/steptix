/**
 * `read` with `attribute: "url"` — capturing the page's own address.
 *
 * The gap this closes: no element carries the page URL as an attribute, so a
 * step like "Capture the current page URL [store as: target_url]" had no
 * expression in the action vocabulary at all. The model reached for `@url`
 * regardless, `getAttribute('url')` returned null, and the framework stored
 * the empty string — a silent miscapture whose only symptom was a LATER step
 * navigating nowhere. Asserted against a real Playwright page, because the
 * extraction runs in the browser context and cannot be unit-tested in Node.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction } from '../src/browser/actions.js';

const PAGE_URL = 'http://127.0.0.1:8787/nowhere/deep-link?q=1';

describe('read @url — the page address', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    // Routed rather than served: the assertion is about location.href, so the
    // URL has to be a real one the page navigated to, not a data: URL.
    await page.route('**/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body>
          <a id="link" href="/elsewhere">Elsewhere</a>
          <iframe id="f" src="/framed"></iframe>
        </body></html>`,
      }),
    );
    await page.goto(PAGE_URL);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('captures the current page URL, not an empty string', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: 'body',
      attribute: 'url',
      as: 'target_url',
      description: 'Capture the current page URL',
    });

    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe(PAGE_URL);
  });

  it('is the page URL even when read off a link, not that link’s href', async () => {
    // The trap the prompt warns about: `href` is where a link GOES, `url` is
    // where the page IS. Reading @url off an anchor must not yield /elsewhere.
    const result = await executeAction(page, {
      action: 'read',
      selector: '#link',
      attribute: 'url',
      as: 'here',
      description: 'Capture the page URL from a link element',
    });

    expect(result.capturedValue).toBe(PAGE_URL);
    expect(result.capturedValue).not.toContain('/elsewhere');
  });

  it('still resolves href normally, so the existing behaviour is untouched', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '#link',
      attribute: 'href',
      as: 'dest',
      description: 'Capture the link destination',
    });

    expect(result.capturedValue).toBe('http://127.0.0.1:8787/elsewhere');
  });

  it('an attribute that really is absent still captures empty, not the URL', async () => {
    // `url` is a special case, not a new fallback: a genuinely missing
    // attribute must keep reading as "" rather than quietly becoming the page.
    const result = await executeAction(page, {
      action: 'read',
      selector: '#link',
      attribute: 'data-nope',
      as: 'missing',
      description: 'Capture an attribute that is not there',
    });

    expect(result.capturedValue).toBe('');
  });

  it('multiple: true keeps the two extraction copies in lockstep', async () => {
    // executeReadMultiple carries its own inline copy of the extraction — it
    // cannot close over the shared helper. If only one copy learned `url`,
    // this is the test that says so.
    const result = await executeAction(page, {
      action: 'read',
      selector: 'a',
      attribute: 'url',
      as: 'urls',
      multiple: true,
      description: 'Capture the page URL for every link',
    });

    expect(result.capturedValues).toEqual([PAGE_URL]);
  });
});
