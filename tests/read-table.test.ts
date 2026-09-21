/**
 * `readTable` extraction over a real Playwright page
 * (docs/specs/SPEC-structured-table-reads.md §7, §10, §12).
 *
 * The fixtures are INLINE rather than the pages under `fixtures/test-app/`:
 * nothing in the fast suite drives the fixture app over HTTP, and a unit test
 * that needs a listening server is a unit test that fails for reasons which
 * have nothing to do with the code it covers. The structures here are copied
 * from the spec's own §5 examples and from `table-edge-cases.html`, so the
 * shapes are the same ones the live acceptance tests read.
 *
 * Almost everything goes through `executeAction`, not the extractor directly:
 * a refusal is only useful if it survives the action layer as a failed action
 * with its message intact, which is what the model and the report see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction, readTableRecords } from '../src/browser/actions.js';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { StepCache } from '../src/cache/step-cache.js';
import type { AIAction, TableReadColumn } from '../src/ai/types.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  // Explicit budget: this is the suite's SECOND Chromium-launching file, so
  // under a full-suite run two browsers start and stop at once and the
  // default 10s hook budget is occasionally not enough to close one.
}, 30_000);

/**
 * The app's own table style: `<th>` is upper-cased for looks only (§7.3).
 *
 * Scoped to `thead`, as `table-edge-cases.html` scopes it. A bare `th` rule —
 * which `structured-orders.html` uses — also upper-cases a `<th scope="row">`
 * in the body, and a read of that column would then store EVERYDAY, because
 * the cell value is defined as RENDERED text (§7.4). That is the rule working,
 * not a defect, but it is not the shape being asserted below.
 */
const TABLE_CSS = `<style>
  thead th { text-transform: uppercase; letter-spacing: 0.06em; text-align: left; }
  .col-hidden, .row-hidden { display: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>`;

async function load(bodyHtml: string): Promise<void> {
  await page.setContent(`<html><body>${TABLE_CSS}${bodyHtml}</body></html>`);
}

/** Run a readTable action and return the result, whatever its outcome. */
function run(action: Partial<AIAction> & { selector: string; columns: TableReadColumn[] }) {
  return executeAction(page, {
    action: 'readTable',
    as: 'rows',
    description: 'Read the table',
    ...action,
  } as AIAction);
}

/** Run a readTable action that is expected to fail, and return its message. */
async function refusal(
  action: Partial<AIAction> & { selector: string; columns: TableReadColumn[] },
): Promise<string> {
  const result = await run(action);
  expect(result.success, `expected a refusal, got ${JSON.stringify(result.capturedRecords)}`).toBe(false);
  return result.error ?? '';
}

// ── §5.1 the primary fixture ────────────────────────────────────────────────

/** §5.1 verbatim: a select-all checkbox first, and no row data attributes. */
const ORDERS_HTML = `
<table id="orders" aria-label="Orders">
  <thead>
    <tr>
      <th scope="col"><input type="checkbox" aria-label="Select all orders"></th>
      <th scope="col">Order ID</th>
      <th scope="col">Customer</th>
      <th scope="col">Total</th>
      <th scope="col">Status</th>
      <th scope="col">Actions</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><input type="checkbox" aria-label="Select order ORD-1001"></td>
      <td><a href="/orders/ORD-1001">ORD-1001</a></td>
      <td>Alice Smith</td>
      <td>$125.00</td>
      <td><span class="status status-complete">Completed</span></td>
      <td><button type="button">Review</button></td>
    </tr>
    <tr>
      <td><input type="checkbox" aria-label="Select order ORD-1002"></td>
      <td><a href="/orders/ORD-1002">ORD-1002</a></td>
      <td>Bob Jones</td>
      <td>$89.50</td>
      <td><span class="status status-pending">Pending</span></td>
      <td><button type="button">Review</button></td>
    </tr>
  </tbody>
</table>`;

const ORDERS_COLUMNS: TableReadColumn[] = [
  { header: 'Order ID', key: 'id' },
  { header: 'Customer', key: 'customer' },
  { header: 'Status', key: 'status' },
];

describe('readTable — the checkbox-first fixture (§5.1)', () => {
  it('produces exactly the records the spec shows, _row first', async () => {
    await load(ORDERS_HTML);
    const result = await run({ selector: '#orders', columns: ORDERS_COLUMNS, as: 'orders' });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: 'ORD-1001', customer: 'Alice Smith', status: 'Completed' },
      { _row: '2', id: 'ORD-1002', customer: 'Bob Jones', status: 'Pending' },
    ]);
    // Key ORDER is part of the contract: `_row` first, then the author's
    // columns in the order they asked for them (§7.5).
    expect(Object.keys(result.capturedRecords![0]!)).toEqual(['_row', 'id', 'customer', 'status']);
    // Flat and structured captures stay distinct (§7.1).
    expect(result.capturedValue).toBeUndefined();
    expect(result.capturedValues).toBeUndefined();
  });

  it('never includes the checkbox, Total or Actions columns nobody asked for', async () => {
    await load(ORDERS_HTML);
    const result = await run({ selector: '#orders', columns: ORDERS_COLUMNS });
    for (const record of result.capturedRecords!) {
      expect(Object.keys(record)).toHaveLength(4);
      expect(JSON.stringify(record)).not.toContain('$125.00');
      expect(JSON.stringify(record)).not.toContain('Review');
    }
  });

  it('matches a CSS-uppercased header against the text the author wrote (§7.3)', async () => {
    // `text-transform: uppercase` on <th> means innerText says ORDER ID while
    // the author wrote Order ID. The case-fold is what makes them one key —
    // this is the app's real styling, not a contrived case.
    await load(ORDERS_HTML);
    const shown = await page.locator('#orders thead th').nth(1).innerText();
    expect(shown).toBe('ORDER ID');
    const result = await run({ selector: '#orders', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(result.capturedRecords).toEqual([{ _row: '1', id: 'ORD-1001' }, { _row: '2', id: 'ORD-1002' }]);
  });

  it('matches a header regardless of surrounding whitespace and capitalisation', async () => {
    await load(ORDERS_HTML);
    const result = await run({
      selector: '#orders',
      columns: [{ header: '  order\n  id  ', key: 'id' }],
    });
    expect(result.capturedRecords?.[0]).toEqual({ _row: '1', id: 'ORD-1001' });
  });

  it('reads the same values after the columns are reordered (§5.2)', async () => {
    await load(`
      <table id="orders" aria-label="Orders">
        <thead><tr><th>Status</th><th>Customer</th><th>Order ID</th></tr></thead>
        <tbody><tr><td>Completed</td><td>Alice Smith</td><td>ORD-1001</td></tr></tbody>
      </table>`);
    const result = await run({ selector: '#orders', columns: ORDERS_COLUMNS });
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: 'ORD-1001', customer: 'Alice Smith', status: 'Completed' },
    ]);
  });

  it('accepts an aria-label selector containing a space', async () => {
    // `executeAction` splits a selector on whitespace looking for an iframe to
    // promote, and `table[aria-label="Scheduled payments"]` is the shape the
    // prompt teaches — so this is the selector the live tests will send.
    await load(`
      <table aria-label="Scheduled payments"><tbody>
        <tr><td>Origin Energy</td><td>$140.00</td></tr>
      </tbody></table>`);
    const result = await run({
      selector: 'table[aria-label="Scheduled payments"]',
      columns: [{ index: 1, key: 'payee' }],
    });
    expect(result.error ?? '').toBe('');
    expect(result.capturedRecords).toEqual([{ _row: '1', payee: 'Origin Energy' }]);
  });

  it('end-to-end: raw AI JSON → parseAIResponse → executeAction → records', async () => {
    await load(ORDERS_HTML);
    const parsed = parseAIResponse(JSON.stringify({
      actions: [{
        action: 'readTable',
        selector: 'table[aria-label="Orders"]',
        columns: ORDERS_COLUMNS,
        as: 'orders',
        description: 'Read the requested values from every visible Orders table row',
      }],
      reasoning: 'The step asks for three named columns from every row.',
    }));
    const result = await executeAction(page, parsed.actions[0]!);
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toHaveLength(2);
  });
});

// ── cell values (§7.4) ──────────────────────────────────────────────────────

describe('readTable — cell values', () => {
  it('reads nested markup as its rendered text, and an empty cell as ""', async () => {
    await load(`
      <table id="t" aria-label="Plans">
        <thead><tr><th>Plan</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><a href="/p/1"><strong>Every</strong>day</a></td><td>  Two   spaces
            and a newline </td></tr>
          <tr><td>Savings</td><td></td></tr>
        </tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Plan', key: 'plan' }, { header: 'Notes', key: 'notes' }],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', plan: 'Everyday', notes: 'Two spaces and a newline' },
      // Empty stays "" and the row stays: one blank cell is data, not a fault.
      { _row: '2', plan: 'Savings', notes: '' },
    ]);
  });

  it('keeps a row whose cells are ALL empty', async () => {
    // The visibility filter asks whether the row has a rendered box, not
    // whether it has text — a row of blanks is data with nothing in it, and
    // dropping it would renumber every row below it.
    await load(`
      <table id="t" aria-label="Payments">
        <thead><tr><th>Payee</th><th>Reference</th></tr></thead>
        <tbody>
          <tr><td>Origin Energy</td><td>INV-2291</td></tr>
          <tr><td></td><td></td></tr>
          <tr><td>Netflix Australia</td><td></td></tr>
        </tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Payee', key: 'payee' }, { header: 'Reference', key: 'reference' }],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', payee: 'Origin Energy', reference: 'INV-2291' },
      { _row: '2', payee: '', reference: '' },
      { _row: '3', payee: 'Netflix Australia', reference: '' },
    ]);
  });

  it('reads a cell holding only a control or an icon as "" in phase 1', async () => {
    await load(`
      <table id="t" aria-label="Cards">
        <thead><tr><th>Card</th><th>Auto-pay</th></tr></thead>
        <tbody><tr><td>Everyday Visa</td><td><input type="checkbox" checked aria-label="Auto-pay"></td></tr></tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Card', key: 'card' }, { header: 'Auto-pay', key: 'autopay' }],
    });
    // Phase 1 must NOT guess that a ticked box means "true" — reading control
    // state is phase 2, behind an explicit per-column mode (§7.4).
    expect(result.capturedRecords).toEqual([{ _row: '1', card: 'Everyday Visa', autopay: '' }]);
  });

  it('reads a hidden column as "" while every other cell keeps its position (§10)', async () => {
    await load(`
      <table id="t" aria-label="Filtered payments">
        <thead><tr><th>Payee</th><th class="col-hidden">Reference</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>Origin Energy</td><td class="col-hidden">INV-2291</td><td>$140.00</td></tr>
        </tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [
        { header: 'Payee', key: 'payee' },
        { header: 'Reference', key: 'reference' },
        { header: 'Amount', key: 'amount' },
      ],
    });
    // `innerText` on an unrendered element falls back to textContent, so the
    // hidden value would leak without the explicit rendered check.
    expect(result.capturedRecords).toEqual([
      { _row: '1', payee: 'Origin Energy', reference: '', amount: '$140.00' },
    ]);
  });

  it('matches a visually-hidden accessible heading by its textContent (§7.3)', async () => {
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th><span class="sr-only">Select</span></th><th>Order ID</th></tr></thead>
        <tbody><tr><td><input type="checkbox"></td><td>ORD-1001</td></tr></tbody>
      </table>`);
    const result = await run({ selector: '#t', columns: [{ header: 'Select', key: 'select' }] });
    expect(result.capturedRecords).toEqual([{ _row: '1', select: '' }]);
  });
});

// ── row selection (§7.4) ────────────────────────────────────────────────────

describe('readTable — which rows are data', () => {
  it('excludes hidden rows, nested-table rows, <tfoot>, and spans every <tbody>', async () => {
    await load(`
      <table id="t" aria-label="Accounts">
        <thead><tr><th>Account</th><th>Balance</th></tr></thead>
        <tbody>
          <tr><td>Everyday</td><td>
            <table id="inner" aria-label="Fees">
              <tbody><tr><td>Overseas</td><td>$5.00</td></tr></tbody>
            </table>
          </td></tr>
          <tr class="row-hidden"><td>Filtered out</td><td>$0.00</td></tr>
        </tbody>
        <tbody>
          <tr><td>Savings</td><td>$8,410.00</td></tr>
        </tbody>
        <tfoot><tr><th scope="row">Total</th><td>$8,410.00</td></tr></tfoot>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Account', key: 'account' }, { header: 'Balance', key: 'balance' }],
    });
    // Two data rows across two tbodies in DOM order; the nested table's own
    // row is the inner table's, the hidden row is not data on this page, and
    // the footer total is not a row of the body.
    expect(result.capturedRecords).toEqual([
      { _row: '1', account: 'Everyday', balance: 'Overseas $5.00' },
      { _row: '2', account: 'Savings', balance: '$8,410.00' },
    ]);
  });

  it('counts a <th scope="row"> as that row\'s cell at its logical position (§10)', async () => {
    await load(`
      <table id="t" aria-label="Balances by account">
        <thead><tr><th>Account</th><th>Number</th><th>Available</th></tr></thead>
        <tbody>
          <tr><th scope="row">Everyday</th><td>•••• 4417</td><td>$1,234.56</td></tr>
          <tr><th scope="row">Savings</th><td>•••• 9082</td><td>$8,410.00</td></tr>
        </tbody>
      </table>`);
    const byHeader = await run({
      selector: '#t',
      columns: [{ header: 'Account', key: 'account' }, { header: 'Available', key: 'available' }],
    });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', account: 'Everyday', available: '$1,234.56' },
      { _row: '2', account: 'Savings', available: '$8,410.00' },
    ]);
    // A row header must not be mistaken for the table's header row: the read
    // by position reaches it as column 1, not as a heading.
    const byPosition = await run({ selector: '#t', columns: [{ index: 1, key: 'account' }] });
    expect(byPosition.capturedRecords).toEqual([
      { _row: '1', account: 'Everyday' },
      { _row: '2', account: 'Savings' },
    ]);
  });

  it('accepts a header made of <th> in the first body row, with no <thead>', async () => {
    await load(`
      <table id="t" aria-label="Direct debits">
        <tbody>
          <tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Amount</th></tr>
          <tr><td>1 Oct 2026</td><td>Origin Energy</td><td>$140.00</td></tr>
          <tr><td>3 Oct 2026</td><td>Telstra broadband</td><td>$79.00</td></tr>
        </tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Description', key: 'description' }],
    });
    // The header row is excluded from the data, so the debits are rows 1 and 2.
    expect(result.capturedRecords).toEqual([
      { _row: '1', description: 'Origin Energy' },
      { _row: '2', description: 'Telstra broadband' },
    ]);
  });

  it('numbers _row among data rows, skipping a hidden row and a placeholder row (§12.11)', async () => {
    await load(`
      <table id="t" aria-label="Payments">
        <thead><tr><th>Payee</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>Origin Energy</td><td>$140.00</td><td>Scheduled</td></tr>
          <tr><td>Netflix Australia</td><td>$22.99</td><td>Scheduled</td></tr>
          <tr class="row-hidden"><td>Spotify AU</td><td>$13.99</td><td>Paused</td></tr>
          <tr class="group"><td colspan="3">Overdue</td></tr>
          <tr><td>City of Sydney Rates</td><td>$318.75</td><td>Overdue</td></tr>
        </tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Payee', key: 'payee' }],
    });
    // Neither the hidden row nor the full-width group row consumes a number,
    // so the third payment is row 3 — not row 5, which is its <tr> position.
    expect(result.capturedRecords).toEqual([
      { _row: '1', payee: 'Origin Energy' },
      { _row: '2', payee: 'Netflix Australia' },
      { _row: '3', payee: 'City of Sydney Rates' },
    ]);
  });
});

// ── empty tables and placeholder rows (§4.8, §5.5) ──────────────────────────

describe('readTable — empty tables and placeholder rows', () => {
  /** §5.5: `documents.html` after "Clear all". */
  const DOCUMENTS_HTML = `
    <table id="documents-table" aria-label="Uploaded documents">
      <thead><tr><th>Name</th><th>Size</th><th>Type</th><th>SHA-256</th><th>Uploaded</th></tr></thead>
      <tbody>
        <tr id="documents-empty"><td class="doc-empty" colspan="5">No documents uploaded yet.</td></tr>
      </tbody>
    </table>`;

  it('reads the §5.5 placeholder body as [] rather than a merged-cell error', async () => {
    await load(DOCUMENTS_HTML);
    const result = await run({
      selector: '#documents-table',
      columns: [{ header: 'Name', key: 'name' }, { header: 'Size', key: 'size' }],
      as: 'docs',
    });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([]);
  });

  it('reports the skipped placeholder so a short result explains itself (§7.6)', async () => {
    await load(DOCUMENTS_HTML);
    const outcome = await readTableRecords(page, {
      selector: '#documents-table',
      columns: [{ header: 'Name', key: 'name' }, { header: 'Size', key: 'size' }],
    });
    expect(outcome.records).toEqual([]);
    expect(outcome.placeholdersSkipped).toBe(1);
  });

  it('reads a "Loading…" row as [] too — waiting is the author\'s step', async () => {
    await load(`
      <table id="t" aria-label="Recent transfers">
        <thead><tr><th>To</th><th>Reference</th><th>Amount</th><th>Date</th></tr></thead>
        <tbody><tr class="empty-row"><td colspan="4">Loading…</td></tr></tbody>
      </table>`);
    const result = await run({ selector: '#t', columns: [{ header: 'To', key: 'to' }] });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([]);
  });

  it('skips a placeholder sitting among data rows without consuming a _row', async () => {
    await load(`
      <table id="t" aria-label="Accounts by group">
        <thead><tr><th>Account</th><th>Balance</th></tr></thead>
        <tbody>
          <tr class="group"><th colspan="2" scope="rowgroup">Everyday accounts</th></tr>
          <tr><td>Everyday</td><td>$1,234.56</td></tr>
        </tbody>
        <tbody>
          <tr class="group"><th colspan="2" scope="rowgroup">Savings accounts</th></tr>
          <tr><td>Bonus Saver</td><td>$8,410.00</td></tr>
        </tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Account', key: 'account' }],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', account: 'Everyday' },
      { _row: '2', account: 'Bonus Saver' },
    ]);
  });

  it('reads a genuinely empty <tbody> as [], with or without a limit', async () => {
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>Order ID</th></tr></thead>
        <tbody></tbody>
      </table>`);
    const columns: TableReadColumn[] = [{ header: 'Order ID', key: 'id' }];
    expect((await run({ selector: '#t', columns })).capturedRecords).toEqual([]);
    expect((await run({ selector: '#t', columns, limit: 10 })).capturedRecords).toEqual([]);
  });

  it('still fails a colspan narrower than the table (§10)', async () => {
    await load(`
      <table id="t" aria-label="Pending transfers">
        <thead><tr><th>To</th><th>Reference</th><th>Amount</th><th>Date</th><th>Status</th></tr></thead>
        <tbody><tr><td colspan="3">Something merged</td></tr></tbody>
      </table>`);
    // Narrower than the width, so it is a merged grid and not a message.
    expect(await refusal({ selector: '#t', columns: [{ header: 'To', key: 'to' }] }))
      .toBe('readTable cannot map table "Pending transfers": merged headers or cells (rowspan/colspan > 1) are not supported');
  });
});

// ── structural refusals (§5.3, §7.2, §7.3, §7.4) ────────────────────────────

describe('readTable — structural refusals', () => {
  it('refuses a merged header rather than pretending Order is one column (§5.3)', async () => {
    await load(`
      <table id="t" aria-label="Orders">
        <thead>
          <tr><th colspan="2">Order</th><th rowspan="2">Status</th></tr>
          <tr><th>ID</th><th>Customer</th></tr>
        </thead>
        <tbody><tr><td>ORD-1001</td><td>Alice Smith</td><td>Completed</td></tr></tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Status', key: 'status' }] }))
      .toBe('readTable cannot map table "Orders": merged headers or cells (rowspan/colspan > 1) are not supported');
  });

  it('refuses a body rowspan, which would shift the row below it', async () => {
    await load(`
      <table id="t" aria-label="Accounts by region">
        <thead><tr><th>Region</th><th>Account</th><th>Balance</th></tr></thead>
        <tbody>
          <tr><td rowspan="2">New South Wales</td><td>Everyday</td><td>$1,234.56</td></tr>
          <tr><td>Savings</td><td>$8,410.00</td></tr>
        </tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Account', key: 'account' }] }))
      .toBe('readTable cannot map table "Accounts by region": merged headers or cells (rowspan/colspan > 1) are not supported');
  });

  it('refuses a missing header and lists the ones the table has (§10)', async () => {
    await load(ORDERS_HTML);
    const message = await refusal({
      selector: '#orders',
      columns: [{ header: 'Order number', key: 'id' }],
    });
    // Never a fuzzy match onto "Order ID": a rename is a finding, not a thing
    // to paper over.
    expect(message).toBe(
      'readTable cannot map table "Orders": no column is headed "Order number" — '
      + 'available headers are ORDER ID, CUSTOMER, TOTAL, STATUS, ACTIONS',
    );
  });

  it('refuses a duplicate header and names the columns that matched (§10)', async () => {
    await load(`
      <table id="t" aria-label="Cards and accounts">
        <thead><tr><th>Card</th><th>Status</th><th>Account</th><th>Status</th></tr></thead>
        <tbody><tr><td>Visa</td><td>Active</td><td>Everyday</td><td>Open</td></tr></tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Status', key: 'status' }] }))
      .toBe('readTable cannot map table "Cards and accounts": "Status" matches 2 columns (positions 2, 4) — name the one you mean by position');
    // The way out the message names: pick the one you meant by position.
    const result = await run({ selector: '#t', columns: [{ index: 4, key: 'account_status' }] });
    expect(result.capturedRecords).toEqual([{ _row: '1', account_status: 'Open' }]);
  });

  it('refuses a short row by naming its _row and the column it lacks', async () => {
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>Order ID</th><th>Customer</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>ORD-1001</td><td>Alice Smith</td><td>Completed</td></tr>
          <tr><td>ORD-1002</td><td>Bob Jones</td></tr>
        </tbody>
      </table>`);
    // Never drop the row and never shift the values: a record whose `status`
    // came from `customer` is the failure this action exists to prevent.
    expect(await refusal({ selector: '#t', columns: ORDERS_COLUMNS }))
      .toBe('readTable cannot map table "Orders": row 2 has 2 cells, so there is no cell for the "Status" column at position 3');
  });

  it('refuses a positional column past the row\'s last cell, naming the position', async () => {
    await load(`
      <table id="t" aria-label="Scheduled payments">
        <tbody><tr><td>Origin Energy</td><td>$140.00</td></tr></tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ index: 5, key: 'status' }] }))
      .toBe('readTable cannot map table "Scheduled payments": row 1 has 2 cells, so there is no cell at position 5 for "status"');
  });

  it('refuses an ambiguous selector instead of taking the first table (§7.2)', async () => {
    await load(`
      <table class="data" aria-label="First"><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
      <table class="data" aria-label="Second"><thead><tr><th>A</th></tr></thead><tbody><tr><td>2</td></tr></tbody></table>`);
    expect(await refusal({ selector: '.data', columns: [{ header: 'A', key: 'a' }] }))
      .toBe('readTable found 2 visible elements matching ".data" — it must match exactly one table, so use a more specific selector');
  });

  it('refuses a selector that matches nothing, and one whose only match is hidden', async () => {
    await load(`<table id="hidden-table" style="display:none"><tbody><tr><td>x</td></tr></tbody></table>`);
    expect(await refusal({ selector: '#missing', columns: [{ index: 1, key: 'a' }] }))
      .toBe('readTable could not find a table matching "#missing"');
    expect(await refusal({ selector: '#hidden-table', columns: [{ index: 1, key: 'a' }] }))
      .toBe('readTable could not find a visible table matching "#hidden-table" (1 match, none visible)');
  });

  it('refuses a <div role="grid">, which is a v1 non-goal (§3)', async () => {
    await load(`
      <div id="grid" role="grid" aria-label="Cards">
        <div role="row"><span role="columnheader">Card</span></div>
        <div role="row"><span role="gridcell">Visa</span></div>
      </div>`);
    expect(await refusal({ selector: '#grid', columns: [{ header: 'Card', key: 'card' }] }))
      .toBe('readTable requires a native <table> element, but "#grid" matched a <div> — ARIA grids and <div role="table"> are not supported');
  });
});

// ── columns by position (§4.4, §5.4) ────────────────────────────────────────

describe('readTable — columns by position', () => {
  /** §5.4: no `<thead>`, a duplicate payee, and cells empty on some rows. */
  const PAYMENTS_HTML = `
    <table id="scheduled-payments" aria-label="Scheduled payments">
      <tbody>
        <tr data-id="1">
          <td>Origin Energy</td><td>INV-2291</td><td>$140.00</td><td>3 Oct 2026</td><td>Scheduled</td>
          <td><input type="checkbox" aria-label="Auto-pay for Origin Energy" checked></td>
          <td><button type="button">View</button> <button type="button">Approve</button></td>
        </tr>
        <tr data-id="2">
          <td>Netflix Australia</td><td></td><td>$22.99</td><td>1 Oct 2026</td><td>Scheduled</td>
          <td><input type="checkbox" aria-label="Auto-pay for Netflix Australia" checked></td>
          <td><button type="button">View</button> <button type="button">Approve</button></td>
        </tr>
        <tr data-id="3">
          <td>Origin Energy</td><td></td><td>$86.10</td><td></td><td>Paused</td>
          <td><input type="checkbox" aria-label="Auto-pay for Origin Energy"></td>
          <td><button type="button">View</button> <button type="button">Resume</button></td>
        </tr>
      </tbody>
    </table>`;

  const PAYMENT_COLUMNS: TableReadColumn[] = [
    { index: 1, key: 'payee' },
    { index: 2, key: 'reference' },
    { index: 3, key: 'amount' },
    { index: 5, key: 'status' },
  ];

  it('produces exactly the records the spec shows for the headerless table (§5.4)', async () => {
    await load(PAYMENTS_HTML);
    const result = await run({
      selector: '#scheduled-payments',
      columns: PAYMENT_COLUMNS,
      as: 'payments',
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', payee: 'Origin Energy', reference: 'INV-2291', amount: '$140.00', status: 'Scheduled' },
      { _row: '2', payee: 'Netflix Australia', reference: '', amount: '$22.99', status: 'Scheduled' },
      { _row: '3', payee: 'Origin Energy', reference: '', amount: '$86.10', status: 'Paused' },
    ]);
    // `data-id` is the page's own key and is never read: `_row` is what the
    // read gives a body to find the row by.
    expect(JSON.stringify(result.capturedRecords)).not.toContain('data-id');
  });

  it('refuses a header-named column against it, with the §5.4 message', async () => {
    await load(PAYMENTS_HTML);
    expect(await refusal({
      selector: '#scheduled-payments',
      columns: [{ header: 'Payee', key: 'payee' }],
    })).toBe(
      'readTable cannot map table "Scheduled payments": it has no header row, so "Payee" cannot be '
      + 'matched — name columns by position ("the 1st column as payee")',
    );
  });

  it('reads a positional column against a table that HAS a header (§10)', async () => {
    await load(ORDERS_HTML);
    // The header is still identified so it stays out of the body; the
    // positional column simply ignores it. Reordering would break this read,
    // which is the documented trade-off of §4.4 and not a bug.
    const result = await run({
      selector: '#orders',
      columns: [{ index: 2, key: 'id' }, { header: 'Status', key: 'status' }],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: 'ORD-1001', status: 'Completed' },
      { _row: '2', id: 'ORD-1002', status: 'Pending' },
    ]);
  });
});

// ── bounded reads and the row cap (§4.6, §7.5) ──────────────────────────────

describe('readTable — limit and the 500-row cap', () => {
  /** `n` visible rows with a hidden one before the `hiddenBefore`-th. */
  async function manyRows(n: number, hiddenBefore?: number): Promise<void> {
    const rows: string[] = [];
    for (let i = 1; i <= n; i++) {
      if (hiddenBefore === i) {
        rows.push('<tr class="row-hidden"><td>ORD-HIDDEN</td><td>Filtered</td></tr>');
      }
      rows.push(`<tr><td>ORD-${1000 + i}</td><td>Customer ${i}</td></tr>`);
    }
    await load(`
      <table id="orders" aria-label="Orders">
        <thead><tr><th>Order ID</th><th>Customer</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>`);
  }

  const ID_ONLY: TableReadColumn[] = [{ header: 'Order ID', key: 'id' }];

  it('returns the first N visible rows in DOM order, skipping a hidden one', async () => {
    await manyRows(14, 8);
    const result = await run({ selector: '#orders', columns: ID_ONLY, limit: 10 });
    expect(result.capturedRecords).toHaveLength(10);
    // The hidden row does not consume one of the ten slots (§10), and the
    // eleventh and later visible rows are not read at all.
    expect(result.capturedRecords?.map((r) => r['id'])).toEqual(
      Array.from({ length: 10 }, (_, i) => `ORD-${1001 + i}`),
    );
    expect(result.capturedRecords?.at(-1)).toEqual({ _row: '10', id: 'ORD-1010' });
  });

  it('returns fewer rows than the limit without error', async () => {
    await manyRows(3);
    const result = await run({ selector: '#orders', columns: ID_ONLY, limit: 10 });
    expect(result.success).toBe(true);
    // Not an implicit cardinality assertion: an author who needs ten rows
    // asserts that separately (§4.6).
    expect(result.capturedRecords).toHaveLength(3);
  });

  it('ignores a malformed row that sits past the bound', async () => {
    await load(`
      <table id="orders" aria-label="Orders">
        <thead><tr><th>Order ID</th><th>Customer</th></tr></thead>
        <tbody>
          <tr><td>ORD-1001</td><td>Alice Smith</td></tr>
          <tr><td>ORD-1002</td><td>Bob Jones</td></tr>
          <tr><td rowspan="2">ORD-1003</td><td>Chen Wei</td></tr>
          <tr><td>Dana Ito</td></tr>
        </tbody>
      </table>`);
    const bounded = await run({ selector: '#orders', columns: ID_ONLY, limit: 2 });
    expect(bounded.capturedRecords).toHaveLength(2);
    // Unbounded, the same table fails on the row the bound excluded.
    expect(await refusal({ selector: '#orders', columns: ID_ONLY }))
      .toContain('merged headers or cells');
  });

  it('fails an unbounded read of more than 500 visible rows instead of truncating', async () => {
    await manyRows(520);
    const message = await refusal({ selector: '#orders', columns: ID_ONLY });
    expect(message).toBe(
      'readTable cannot read table "Orders": it has 520 visible data rows, more than the 500-row '
      + 'maximum — read a bounded window instead ("the first 500 visible rows") or narrow the table first',
    );
  }, 30_000);

  it('succeeds on the same table with an explicit limit', async () => {
    await manyRows(520);
    const result = await run({ selector: '#orders', columns: ID_ONLY, limit: 25 });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toHaveLength(25);
    expect(result.capturedRecords?.at(-1)).toEqual({ _row: '25', id: 'ORD-1025' });
  }, 30_000);

  it('reads exactly 500 rows without a limit', async () => {
    await manyRows(500);
    const result = await run({ selector: '#orders', columns: ID_ONLY });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toHaveLength(500);
  }, 30_000);
});

// ── cache replay (§9.1) ─────────────────────────────────────────────────────

describe('readTable — cached actions replay against the current DOM (§9.1)', () => {
  it('keeps index, header and limit through a cache round-trip and rereads the page', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-readtable-cache-'));
    try {
      const cache = await StepCache.initialize(dir, 'read table', ['Read the payments table']);
      const action = parseAIResponse(JSON.stringify({
        actions: [{
          action: 'readTable',
          selector: '#t',
          columns: [{ index: 1, key: 'payee' }, { header: 'Status', key: 'status' }],
          limit: 2,
          as: 'payments',
          description: 'Read the payments table',
        }],
        reasoning: '',
      })).actions[0]!;

      await cache.write(1, [{ rawResponse: '{}', actions: [action], reasoning: '' }], {});
      const replayed = (await cache.read(1, {}))![0]!.actions[0]!;

      // Cache the SHAPE, never the captured rows (§9.1).
      expect(replayed.columns).toEqual([
        { index: 1, key: 'payee' },
        { header: 'Status', key: 'status' },
      ]);
      expect(replayed.limit).toBe(2);

      const table = (payee: string, status: string) => `
        <table id="t" aria-label="Payments">
          <thead><tr><th>Payee</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>${payee}</td><td>${status}</td></tr>
            <tr><td>Netflix Australia</td><td>Scheduled</td></tr>
            <tr><td>City of Sydney Rates</td><td>Overdue</td></tr>
          </tbody>
        </table>`;

      await load(table('Origin Energy', 'Scheduled'));
      const first = await executeAction(page, replayed);
      expect(first.capturedRecords).toEqual([
        { _row: '1', payee: 'Origin Energy', status: 'Scheduled' },
        { _row: '2', payee: 'Netflix Australia', status: 'Scheduled' },
      ]);

      // The same cached plan against changed data reads the new values —
      // a cached readTable is a plan, not a stored answer.
      await load(table('Origin Energy', 'Paused'));
      const second = await executeAction(page, replayed);
      expect(second.capturedRecords?.[0]).toEqual({ _row: '1', payee: 'Origin Energy', status: 'Paused' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('substitutes a parameterised header but never a column key', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-readtable-cache-'));
    try {
      const cache = await StepCache.initialize(dir, 'read table params', ['Read a column']);
      const action: AIAction = {
        action: 'readTable',
        selector: '#t',
        columns: [{ header: '{{column_name}}', key: 'status' }],
        as: 'rows',
        description: 'Read a column',
      };
      await cache.write(1, [{ rawResponse: '{}', actions: [action], reasoning: '' }], {});
      const replayed = (await cache.read(1, { column_name: 'Status' }))![0]!.actions[0]!;
      expect(replayed.columns?.[0]?.header).toBe('Status');
      // `key` is a definition, not a reference — it names the property later
      // steps read, and must survive interpolation untouched (§9.1).
      expect(replayed.columns?.[0]?.key).toBe('status');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
