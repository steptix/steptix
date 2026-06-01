/**
 * Tests for the `pattern` modifier on read actions (issue 020):
 *  - parser: action-parser propagates the field from raw JSON
 *  - browser (single): executeRead slices the captured value to the first
 *    capture group, or the whole match when the pattern has no group
 *  - browser (multiple): the pattern is applied per element; non-matching
 *    elements are dropped
 *  - fail-hard: an invalid pattern or a non-match fails the action (success:
 *    false) rather than silently storing "" or the whole text
 *
 * The browser path runs against a real Playwright page over a static
 * `setContent` DOM — the same shape as the real scrape pipeline without the
 * test-app server. Mirrors tests/read-multiple.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { executeAction } from '../src/browser/actions.js';

describe('parseAIResponse — read pattern field', () => {
  it('parses pattern on a read action', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'read',
          selector: 'div.account',
          as: 'account_number',
          pattern: 'Account number: ([0-9]{4} [0-9]{4} [0-9]{4})',
          description: 'Capture the account number',
        },
      ],
      reasoning: '',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.pattern).toBe('Account number: ([0-9]{4} [0-9]{4} [0-9]{4})');
  });

  it('omits pattern when not supplied (whole-value behaviour)', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'read', selector: 'div.account', as: 'x', description: 'd' },
      ],
      reasoning: '',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.pattern).toBeUndefined();
  });

  it('ignores a non-string pattern (defensive)', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'read', selector: 'div', as: 'x', pattern: 123, description: 'd' },
      ],
      reasoning: '',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.pattern).toBeUndefined();
  });
});

describe('executeAction — read pattern over a real page', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    const html = `<html><body>
      <div class="account">Account number: 1234 1234 1234 OIN:12345678</div>
      <div class="code">Reference CODE: AB-1234 (active)</div>
      <div class="meta" data-sku="SKU-007-RED">Widget</div>
      <div class="long">${'x'.repeat(200)} no digits</div>
      <ul class="orders">
        <li><a class="order" href="/orders/O-1001/details">Order 1001</a></li>
        <li><a class="order" href="/orders/O-1007/details">Order 1007</a></li>
        <li><a class="order" href="/account/settings">Settings</a></li>
      </ul>
      <ul class="codes">
        <li class="codeitem">A1</li>
        <li class="codeitem">A</li>
        <li class="codeitem">B2</li>
      </ul>
      <span class="empty">No digits here</span>
    </body></html>`;
    await page.setContent(html);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('stores the first capture group (the motivating account-number case)', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.account',
      as: 'account_number',
      pattern: 'Account number: ([0-9]{4} [0-9]{4} [0-9]{4})',
      description: 'Capture just the account number',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('1234 1234 1234');
  });

  it('falls back to the whole match when the pattern has no capture group', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.code',
      as: 'ref_code',
      pattern: '[A-Z]{2}-[0-9]{4}',
      description: 'Capture the reference code',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('AB-1234');
  });

  it('composes with attribute — slices an id out of an href', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.order',
      attribute: 'href',
      as: 'order_id',
      pattern: '/orders/([A-Z0-9-]+)',
      description: 'Capture the first order id from its link',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('O-1001');
  });

  it('leaves the value untouched when no pattern is supplied (regression)', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.account',
      as: 'raw',
      description: 'Whole text, no pattern',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('Account number: 1234 1234 1234 OIN:12345678');
  });

  it('FAILS the action when the pattern matches nothing', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.empty',
      as: 'digits',
      pattern: '([0-9]{4})',
      description: 'No digits to find',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/matched nothing/);
    expect(result.capturedValue).toBeUndefined();
  });

  it('FAILS the action on an invalid pattern', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.account',
      as: 'x',
      pattern: '(', // unbalanced group
      description: 'Invalid regex',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a valid regular expression/);
  });

  it('FAILS when the pattern matches but captures an empty substring', async () => {
    // `[A-Z]*` after "OIN:" matches zero letters (next char is a digit) → "".
    // Storing "" is the silent-empty outcome the feature exists to prevent.
    const result = await executeAction(page, {
      action: 'read',
      selector: '.account',
      as: 'oin_letters',
      pattern: 'OIN:([A-Z]*)',
      description: 'Empty capture',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty substring/);
    expect(result.capturedValue).toBeUndefined();
  });

  it('composes with a non-URL attribute (plain getAttribute branch)', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.meta',
      attribute: 'data-sku',
      as: 'sku_num',
      pattern: 'SKU-([0-9]+)',
      description: 'Slice the numeric part of the SKU',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('007');
  });

  it('truncates very long captured text in the fail-hard error message', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.long',
      as: 'x',
      pattern: '([0-9]{5})',
      description: 'No 5-digit run exists',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/matched nothing/);
    expect(result.error).toContain('…'); // truncation marker present
    // The 200-char body is clipped, not echoed whole into the message.
    expect(result.error!.length).toBeLessThan(220);
  });

  it('multiple: keeps empty-string captures but drops non-matching elements', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.codeitem',
      as: 'a_digits',
      multiple: true,
      pattern: 'A([0-9]*)',
      description: 'Digits after A, if any',
    });
    expect(result.success).toBe(true);
    // "A1" → "1"; "A" → "" (kept — a single read would fail); "B2" → no A → dropped.
    expect(result.capturedValues).toEqual(['1', '']);
  });

  it('multiple: applies the pattern per element and drops non-matching ones', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.order',
      attribute: 'href',
      as: 'order_ids',
      multiple: true,
      pattern: '/orders/([A-Z0-9-]+)',
      description: 'Capture every order id',
    });
    expect(result.success).toBe(true);
    // Third .order link (/account/settings) does not match → dropped.
    expect(result.capturedValues).toEqual(['O-1001', 'O-1007']);
  });

  it('multiple: an all-miss pattern yields an empty array (not an error)', async () => {
    const result = await executeAction(page, {
      action: 'read',
      selector: '.order',
      attribute: 'href',
      as: 'order_ids',
      multiple: true,
      pattern: '/invoices/([0-9]+)',
      description: 'Pattern matches none of them',
    });
    expect(result.success).toBe(true);
    expect(result.capturedValues).toEqual([]);
  });

  it('end-to-end: raw AI JSON → parseAIResponse → executeAction → sliced value', async () => {
    const rawAiResponse = JSON.stringify({
      actions: [
        {
          action: 'read',
          selector: '.account',
          as: 'account_number',
          pattern: 'Account number: ([0-9]{4} [0-9]{4} [0-9]{4})',
          description: 'Capture just the account number',
        },
      ],
      reasoning: 'Step asks for only the account number.',
    });
    const parsed = parseAIResponse(rawAiResponse);
    const action = parsed.actions[0]!;
    expect(action.pattern).toBe('Account number: ([0-9]{4} [0-9]{4} [0-9]{4})');

    const result = await executeAction(page, action);
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('1234 1234 1234');
  });
});
