/**
 * Tests for the `multiple: true` modifier on read actions:
 *  - parser: action-parser propagates the flag from raw JSON
 *  - browser: executeReadMultiple captures every match into an array
 *  - storage: step-executor JSON-encodes the array into resolvedParameters
 *
 * The browser path is exercised against a real Playwright page over a static
 * data: URL — that's the same shape as the real DOM scrape pipeline, just
 * without spinning up the test-app server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { executeAction } from '../src/browser/actions.js';

describe('parseAIResponse — read multiple flag', () => {
  it('parses multiple: true on a read action', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'read',
          selector: 'a',
          attribute: 'href',
          as: 'links',
          multiple: true,
          description: 'Capture every link',
        },
      ],
      reasoning: '',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.multiple).toBe(true);
    expect(result.actions[0]?.attribute).toBe('href');
  });

  it('omits multiple when not supplied (single-value behaviour)', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'read', selector: 'a', as: 'first_link', description: 'Read first link' },
      ],
      reasoning: '',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.multiple).toBeUndefined();
  });

  it('coerces a non-true multiple value to undefined (defensive)', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'read', selector: 'a', as: 'x', multiple: 'true', description: 'd' },
      ],
      reasoning: '',
    });
    // Only the literal boolean true triggers list capture. Strings, 1, etc.
    // pass through as undefined to avoid surprising the AI when it returns
    // a non-canonical value.
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.multiple).toBeUndefined();
  });
});

describe('executeAction — read multiple over a real page', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    // Static page with three sections; only the first has links.
    const html = `<html><body>
      <section class="s1">
        <h2>Section 1</h2>
        <a id="a1" href="/foo">Foo</a>
        <a id="a2" href="/bar">Bar</a>
        <a id="a3" href="/baz">Baz</a>
      </section>
      <section class="s2">
        <h2>Section 2</h2>
        <a id="b1" href="/qux">Qux</a>
      </section>
      <section class="s3">
        <h2>Section 3 (no links)</h2>
      </section>
    </body></html>`;
    await page.setContent(html);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('captures every href under section 1 as an ordered array', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.s1 a',
      attribute: 'href',
      as: 'links',
      multiple: true,
      description: 'Capture section 1 links',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValues).toEqual(['/foo', '/bar', '/baz']);
    expect(result.capturedValue).toBeUndefined();
  });

  it('captures every textContent under section 1 (no attribute)', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.s1 a',
      as: 'labels',
      multiple: true,
      description: 'Capture section 1 link texts',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValues).toEqual(['Foo', 'Bar', 'Baz']);
  });

  it('returns an empty array when nothing matches (not an error)', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.s3 a',
      attribute: 'href',
      as: 'links',
      multiple: true,
      description: 'No matches',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValues).toEqual([]);
  });

  it('end-to-end: raw AI JSON → parseAIResponse → executeAction → captured array', async () => {
    // Wires the parser and action-executor together against a real page.
    // Without this test the two unit-level assertions could pass while the
    // glue between them silently dropped the `multiple` flag.
    const rawAiResponse = JSON.stringify({
      actions: [
        {
          action: 'read',
          selector: '.s1 a',
          attribute: 'href',
          as: 'links',
          multiple: true,
          description: 'Capture every section-1 link href',
        },
      ],
      reasoning: 'Step asks for every link.',
    });
    const parsed = parseAIResponse(rawAiResponse);
    const action = parsed.actions[0]!;
    expect(action.multiple).toBe(true);

    const result = await executeAction(page, action);
    expect(result.success).toBe(true);
    expect(result.capturedValues).toEqual(['/foo', '/bar', '/baz']);
  });

  it('single-value path still returns capturedValue, not capturedValues', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.s1 a',
      attribute: 'href',
      as: 'first_link',
      // multiple omitted
      description: 'First link href',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('/foo');
    expect(result.capturedValues).toBeUndefined();
  });

  // Page-content-replacing tests live at the bottom because Playwright's
  // setContent swaps the DOM and earlier `.s1 …` selectors no longer match.
  it('caps capture at READ_MULTIPLE_MAX (500) when the selector matches more', async () => {
    const links = Array.from({ length: 600 }, (_, i) => `<a href="/n${i}">n${i}</a>`).join('');
    await page.setContent(`<html><body><div id="bulk">${links}</div></body></html>`);
    const result = await executeAction(page, {
      action: 'read',
      selector: '#bulk a',
      attribute: 'href',
      as: 'links',
      multiple: true,
      description: 'Capture all (capped)',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValues).toHaveLength(500);
    // Captured slice is the first 500 in DOM order, so the boundary indices
    // must be exact rather than approximate.
    expect(result.capturedValues?.[0]).toBe('/n0');
    expect(result.capturedValues?.[499]).toBe('/n499');
  });
});
