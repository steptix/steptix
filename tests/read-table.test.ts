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
import { executeAction, readTableRecords, formatTableReadSummary } from '../src/browser/actions.js';
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

/** §5.3 verbatim: a band over two columns, and a heading spanning both header
 *  rows beside it. Three columns, named ID, Customer and Status (§7.3b). */
const BANDED_ORDERS_HTML = `
<table id="t" aria-label="Orders">
  <thead>
    <tr><th colspan="2">Order</th><th rowspan="2">Status</th></tr>
    <tr><th>ID</th><th>Customer</th></tr>
  </thead>
  <tbody><tr><td>ORD-1001</td><td>Alice Smith</td><td>Completed</td></tr></tbody>
</table>`;

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

  it('accepts colspan="99" as the "span all" idiom it is (§4.8)', async () => {
    // A wide round number is how a hand-written empty-state row spans the
    // table. Tested for EQUALITY with the width, it was neither a placeholder
    // nor a data row shape, so the read of an empty table failed with
    // "merged headers or cells are not supported".
    await load(`
      <table id="t" aria-label="Uploaded documents">
        <thead><tr><th>Name</th><th>Size</th><th>Type</th></tr></thead>
        <tbody><tr><td colspan="99">No documents uploaded yet.</td></tr></tbody>
      </table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'Name', key: 'name' }],
    });
    expect(outcome.records).toEqual([]);
    expect(outcome.placeholdersSkipped).toBe(1);
  });

  it('skips a <tr> with no cells at all rather than failing the whole read', async () => {
    // A stray empty row renders as nothing and carries nothing: there is no
    // cell to map and no value to number. Failing the read over it would
    // contradict §4.8, which exists so that an empty-looking table answers
    // `[]` rather than an error. The skip is counted, so the log still
    // explains a short result (§7.6).
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>ID</th><th>Name</th></tr></thead>
        <tbody><tr><td>1</td><td>Alice</td></tr><tr></tr><tr><td>2</td><td>Bob</td></tr></tbody>
      </table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'ID', key: 'id' }, { header: 'Name', key: 'name' }],
    });
    expect(outcome.records).toEqual([
      { _row: '1', id: '1', name: 'Alice' },
      { _row: '2', id: '2', name: 'Bob' },
    ]);
    expect(outcome.placeholdersSkipped).toBe(1);
  });

  it('reads a HEADERLESS table whose only row is the message as [] (§4.8)', async () => {
    // `scheduled-payments.html` with nothing scheduled. The width was measured
    // over the RENDERED rows only, so the lone message row made the table one
    // column wide, `width > 1` never fired, and the read failed with
    // "merged headers or cells" on a table §4.8 says must answer [].
    await load(`
      <table id="scheduled-payments" aria-label="Scheduled payments"><tbody>
        <tr><td colspan="7">No scheduled payments.</td></tr>
      </tbody></table>`);
    const outcome = await readTableRecords(page, {
      selector: '#scheduled-payments',
      columns: [{ index: 1, key: 'payee' }, { index: 3, key: 'amount' }],
    });
    expect(outcome.records).toEqual([]);
    expect(outcome.placeholdersSkipped).toBe(1);
  });

  it('reads a FILTERED headerless table, every data row hidden, as [] (§4.8)', async () => {
    // Same cause with the rows still in the DOM: a filter hid all three, the
    // "no matches" row rendered, and the visible-rows-only width was 1 again.
    await load(`
      <table id="t" aria-label="Scheduled payments"><tbody>
        <tr class="row-hidden"><td>Origin Energy</td><td>REF-1</td><td>$120.00</td></tr>
        <tr class="row-hidden"><td>Acme Water</td><td>REF-2</td><td>$80.00</td></tr>
        <tr><td colspan="3">No payments match this filter.</td></tr>
      </tbody></table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ index: 1, key: 'payee' }],
    });
    expect(outcome.records).toEqual([]);
    expect(outcome.placeholdersSkipped).toBe(1);
  });

  it('reads a one-column table with a header and a colspan="2" message row as []', async () => {
    // The other half of the unified test: in a one-column table a lone cell
    // spanning TWO columns is still a message, not a merged grid — but the
    // one-column guard (`width > 1`) had excluded the whole table from the
    // rule, so this failed as a merged cell.
    await load(`
      <table id="t" aria-label="Statuses">
        <thead><tr><th>Status</th></tr></thead>
        <tbody><tr><td colspan="2">No statuses yet.</td></tr></tbody>
      </table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'Status', key: 'status' }],
    });
    expect(outcome.records).toEqual([]);
    expect(outcome.placeholdersSkipped).toBe(1);
    // And an ordinary one-column row — colSpan 1 — is still data, which is
    // what `Math.max(width, 2)` protects.
    await load(`<table id="u" aria-label="Names"><tbody>
      <tr><td>Alice</td></tr><tr><td>Bob</td></tr>
    </tbody></table>`);
    const data = await readTableRecords(page, {
      selector: '#u',
      columns: [{ index: 1, key: 'name' }],
    });
    expect(data.records).toEqual([{ _row: '1', name: 'Alice' }, { _row: '2', name: 'Bob' }]);
    expect(data.placeholdersSkipped).toBe(0);
  });

  it('measures a HEADERLESS table against its hidden rows, so a narrow message still fails', async () => {
    // The half of the width rule that `Math.max(width, 2)` cannot stand in
    // for. Every data row is hidden by a filter and the visible message spans
    // FIVE of the table's seven columns, so it is a merged grid and not a
    // message (§10) — but only if the width came from the rows that are still
    // there to say so. Measured over the visible rows alone the width is 1,
    // `5 >= max(1, 2)` is true, and the read answers `[]` and SUCCEEDS on a
    // table it could not map.
    await load(`
      <table id="t" aria-label="Scheduled payments"><tbody>
        <tr class="row-hidden">
          <td>Origin Energy</td><td>INV-1</td><td>$140.00</td><td>3 Oct 2026</td>
          <td>Scheduled</td><td>Yes</td><td>View</td>
        </tr>
        <tr><td colspan="5">No scheduled payments.</td></tr>
      </tbody></table>`);
    expect(await refusal({ selector: '#t', columns: [{ index: 1, key: 'payee' }] }))
      .toBe(
        'readTable cannot map table "Scheduled payments": merged headers or cells '
        + '(rowspan/colspan > 1) are not supported',
      );
  });

  it('and reads the same table as [] when the message spans all seven', async () => {
    // The sibling that says what the refusal above is actually about: not
    // colspan, but a message narrower than the grid it sits in. Same table,
    // same hidden row, one number different.
    await load(`
      <table id="t" aria-label="Scheduled payments"><tbody>
        <tr class="row-hidden">
          <td>Origin Energy</td><td>INV-1</td><td>$140.00</td><td>3 Oct 2026</td>
          <td>Scheduled</td><td>Yes</td><td>View</td>
        </tr>
        <tr><td colspan="7">No scheduled payments.</td></tr>
      </tbody></table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ index: 1, key: 'payee' }],
    });
    expect(outcome.records).toEqual([]);
    expect(outcome.placeholdersSkipped).toBe(1);
  });

  it('reads a colspan="1" message row in a one-column table as a data record (§4.8)', async () => {
    // The deliberate floor, stated as an outcome rather than as a guard: a
    // lone cell that spans no more than its own column is data, whatever its
    // text says. A one-column table is the only place the two readings differ,
    // and the rule picks this one — because the alternative deletes an
    // ordinary row from every one-column read.
    await load(`<table id="t" aria-label="Names"><tbody>
      <tr><td>Alice</td></tr>
      <tr><td colspan="1">No more names.</td></tr>
    </tbody></table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ index: 1, key: 'name' }],
    });
    expect(outcome.records).toEqual([
      { _row: '1', name: 'Alice' },
      { _row: '2', name: 'No more names.' },
    ]);
    expect(outcome.placeholdersSkipped).toBe(0);
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

// ── the ways a table can read as [] and still succeed (§2, §13.4) ──────────
//
// Every case here used to return `[]` from a SUCCESSFUL action: the loop over
// the capture ran zero passes and the step passed. That is the outcome this
// whole action exists to prevent — worse than any refusal, because nothing in
// the run says a thing.

describe('readTable — tables that silently read as []', () => {
  it('reads a ONE-COLUMN table with a header (§4.8)', async () => {
    // The placeholder test was `cells.length === 1 && colSpan === width`, and
    // in a one-column table `colSpan 1 === width 1` is true of every ordinary
    // row — so all three rows were skipped as "placeholders".
    await load(`
      <table id="t" aria-label="Statuses">
        <thead><tr><th>Status</th></tr></thead>
        <tbody><tr><td>Completed</td></tr><tr><td>Overdue</td></tr><tr><td>Pending</td></tr></tbody>
      </table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'Status', key: 'status' }],
    });
    expect(outcome.records).toEqual([
      { _row: '1', status: 'Completed' },
      { _row: '2', status: 'Overdue' },
      { _row: '3', status: 'Pending' },
    ]);
    expect(outcome.placeholdersSkipped).toBe(0);
  });

  it('reads a ONE-COLUMN table with no header', async () => {
    // Headerless, the same test had no width to compare against and skipped
    // every single-cell row unconditionally.
    await load(`<table id="t" aria-label="Names"><tbody>
      <tr><td>Alice</td></tr><tr><td>Bob</td></tr>
    </tbody></table>`);
    const result = await run({ selector: '#t', columns: [{ index: 1, key: 'name' }] });
    expect(result.capturedRecords).toEqual([
      { _row: '1', name: 'Alice' },
      { _row: '2', name: 'Bob' },
    ]);
  });

  it('accepts a header row that mixes <td> and <th> (§7.3)', async () => {
    // A checkbox cell beside the headings — what every sortable table in this
    // app looks like. Requiring EVERY cell to be a <th> missed it, and the
    // read then failed "it has no header row".
    await load(`
      <table id="t" aria-label="Orders"><tbody>
        <tr><td><input type="checkbox" aria-label="Select all"></td><th>Order ID</th><th>Status</th></tr>
        <tr><td><input type="checkbox"></td><td>O-1</td><td>Paid</td></tr>
        <tr><td><input type="checkbox"></td><td>O-2</td><td>Due</td></tr>
      </tbody></table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Order ID', key: 'id' }, { header: 'Status', key: 'status' }],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: 'O-1', status: 'Paid' },
      { _row: '2', id: 'O-2', status: 'Due' },
    ]);
  });

  it('keeps that header row out of the data, so no _row is off by one', async () => {
    // The louder half of the same bug: with POSITIONAL columns the read did
    // not need a header at all, so the heading text became record 1 and every
    // row number after it was one too high — a pass then acted on the row
    // above the one its record came from.
    await load(`
      <table id="t" aria-label="Orders"><tbody>
        <tr><td></td><th>Order ID</th><th>Status</th></tr>
        <tr><td></td><td>O-1</td><td>Paid</td></tr>
        <tr><td></td><td>O-2</td><td>Due</td></tr>
      </tbody></table>`);
    const result = await run({ selector: '#t', columns: [{ index: 2, key: 'id' }] });
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);
  });

  it('finds the header in the body when an EMPTY <thead> element sits above it', async () => {
    // The branch keyed on the PRESENCE of a `<thead>`, not on whether a header
    // row was found in it. A framework that renders `<thead></thead>` and puts
    // the headings in the first `<tbody>` row therefore read as headerless:
    // positionally the heading text became record 1 and every `_row` was one
    // too high, and by header the read failed "it has no header row".
    const html = `
      <table id="t" aria-label="Orders">
        <thead></thead>
        <tbody>
          <tr><td><input type="checkbox" aria-label="Select all"></td><th>Order ID</th><th>Status</th></tr>
          <tr><td><input type="checkbox"></td><td>O-1</td><td>Paid</td></tr>
          <tr><td><input type="checkbox"></td><td>O-2</td><td>Due</td></tr>
        </tbody>
      </table>`;
    await load(html);
    expect(await page.locator('#t thead').count()).toBe(1);
    const positional = await run({ selector: '#t', columns: [{ index: 2, key: 'id' }] });
    expect(positional.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);
    const byHeader = await run({
      selector: '#t',
      columns: [{ header: 'Order ID', key: 'id' }, { header: 'Status', key: 'status' }],
    });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', id: 'O-1', status: 'Paid' },
      { _row: '2', id: 'O-2', status: 'Due' },
    ]);
  });

  it('looks past a hidden template row to find the heading row (§7.3)', async () => {
    // The same two failures from the other direction: the body branch looked
    // at `bodyRows[0]` BEFORE the visibility filter, so a `display:none`
    // template row — the standard way to clone a row in plain JS — stood in
    // front of the headings and the table read as headerless.
    const html = `
      <table id="t" aria-label="Orders"><tbody>
        <tr class="row-hidden" id="tpl"><td></td><td>—</td><td>—</td></tr>
        <tr><td></td><th>Order ID</th><th>Status</th></tr>
        <tr><td></td><td>O-1</td><td>Paid</td></tr>
        <tr><td></td><td>O-2</td><td>Due</td></tr>
      </tbody></table>`;
    await load(html);
    expect(await page.locator('#tpl').evaluate(
      (el: Element) => (el as HTMLElement).getClientRects().length,
    )).toBe(0);
    const positional = await run({ selector: '#t', columns: [{ index: 3, key: 'status' }] });
    expect(positional.capturedRecords).toEqual([
      { _row: '1', status: 'Paid' },
      { _row: '2', status: 'Due' },
    ]);
    const byHeader = await run({ selector: '#t', columns: [{ header: 'Status', key: 'status' }] });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', status: 'Paid' },
      { _row: '2', status: 'Due' },
    ]);
  });

  it('takes a one-column <tr><th>Order ID</th></tr> as a header (§7.3)', async () => {
    await load(`<table id="t" aria-label="Orders"><tbody>
      <tr><th>Order ID</th></tr><tr><td>O-1</td></tr><tr><td>O-2</td></tr>
    </tbody></table>`);
    const result = await run({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(result.capturedRecords).toEqual([{ _row: '1', id: 'O-1' }, { _row: '2', id: 'O-2' }]);
  });

  it('does NOT take a one-cell GROUP row as the header of a wider table', async () => {
    // `<tr><th>Section A</th></tr>` above the real headings is a group row,
    // and a header is never narrower than the grid it names. Taken as the
    // header, the heading row became record 1 — `{_row:"1",name:"Name"}` —
    // and every real row was numbered one too high, which is exactly the
    // misalignment §4.5 exists to prevent. `lonelySpan` did not catch it
    // because the cell carries no colspan at all.
    const SECTIONED = `<table id="t" aria-label="Accounts"><tbody>
      <tr><th>Section A</th></tr>
      <tr><th>Name</th><th>Status</th></tr>
      <tr><td>Alice</td><td>Active</td></tr>
      <tr><td>Bob</td><td>Closed</td></tr>
    </tbody></table>`;

    await load(SECTIONED);
    // By header: the read now finds the row that actually names the columns,
    // which is what this message proves — it lists what the header row holds.
    expect(await refusal({ selector: '#t', columns: [{ header: 'Payee', key: 'p' }] }))
      .toBe(
        'readTable cannot map table "Accounts": no column is headed "Payee" — available '
        + 'headers are Name, Status',
      );
    const byHeader = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'Name', key: 'name' }],
    });
    expect(byHeader.records).toEqual([
      // The group row spans nothing, so §4.8's floor leaves it a data row —
      // loud and visible, rather than silently renumbering the ones below it.
      { _row: '1', name: 'Section A' },
      { _row: '2', name: 'Alice' },
      { _row: '3', name: 'Bob' },
    ]);

    // By position, the same three rows and the same numbers.
    await load(SECTIONED);
    const byIndex = await readTableRecords(page, {
      selector: '#t',
      columns: [{ index: 1, key: 'name' }],
    });
    expect(byIndex.records.map((r) => r['_row'])).toEqual(['1', '2', '3']);
    expect(byIndex.records.map((r) => r['name'])).toEqual(['Section A', 'Alice', 'Bob']);
  });

  it('a stepped-over group row is a data row — record 1, or a short row (§4.8)', async () => {
    // The other half of the step-over: the row is not deleted, it is left in
    // the body, and §4.8's floor says a lone cell spanning ONE column is data.
    // Both of its observable outcomes are pinned here, because "stepped over"
    // is easy to read as "dropped".
    const SECTIONED = `<table id="t" aria-label="Accounts"><tbody>
      <tr><th>Section A</th></tr>
      <tr><th>Name</th><th>Status</th></tr>
      <tr><td>Alice</td><td>Active</td></tr>
      <tr><td>Bob</td><td>Closed</td></tr>
    </tbody></table>`;

    // ONE requested column: it is record 1, holding the heading's own text.
    await load(SECTIONED);
    const one = await run({ selector: '#t', columns: [{ header: 'Name', key: 'name' }] });
    expect(one.capturedRecords).toEqual([
      { _row: '1', name: 'Section A' },
      { _row: '2', name: 'Alice' },
      { _row: '3', name: 'Bob' },
    ]);

    // TWO: the group row has no cell for the second, and the read fails
    // rather than storing a record whose fields came from the wrong columns.
    await load(SECTIONED);
    expect(await refusal({
      selector: '#t',
      columns: [{ header: 'Name', key: 'name' }, { header: 'Status', key: 'status' }],
    })).toBe(
      'readTable cannot map table "Accounts": row 1 has 1 cell, so there is no cell for the '
      + '"Status" column at position 2',
    );
  });

  it('takes a one-cell <th> header above WIDER data rows (§7.3, §7.4)', async () => {
    // The step-over is for a group row, and a group row is known by the
    // HEADINGS BELOW it. Deciding it from the body's width alone stepped over
    // this table's genuine one-cell header — §7.4's "extra cells are
    // harmless" arriving as a header that is narrower than its own data rows.
    // By header the read then said "it has no header row"; by position the
    // heading text became record 1 and every real row was numbered one too
    // high.
    const WIDER = `<table id="t" aria-label="Orders"><tbody>
      <tr><th>Order ID</th></tr>
      <tr><td>O-1</td><td><button type="button">Delete</button></td></tr>
      <tr><td>O-2</td><td><button type="button">Delete</button></td></tr>
    </tbody></table>`;

    await load(WIDER);
    const byHeader = await run({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);

    await load(WIDER);
    const byIndex = await run({ selector: '#t', columns: [{ index: 1, key: 'id' }] });
    expect(byIndex.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);
  });

  it('finds that one-cell <th> header past a hidden template row too (§7.3)', async () => {
    // The two guards compose: the `display:none` template row is skipped
    // because it is neither rendered nor a heading row, and the one-cell
    // heading behind it is still the header even though the template row —
    // and the data rows — are wider.
    await load(`<table id="t" aria-label="Orders"><tbody>
      <tr class="row-hidden" id="tpl"><td>—</td><td>—</td></tr>
      <tr><th>Order ID</th></tr>
      <tr><td>O-1</td><td><button type="button">Delete</button></td></tr>
      <tr><td>O-2</td><td><button type="button">Delete</button></td></tr>
    </tbody></table>`);
    expect(await page.locator('#tpl').evaluate(
      (el: Element) => (el as HTMLElement).getClientRects().length,
    )).toBe(0);
    const byHeader = await run({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);
  });

  it('keeps that one-cell header when the DATA rows carry row headers (§7.3)', async () => {
    // §7.3's "realistic case": a row-header column with no `scope` attribute.
    // Such a row is `<tr><th>O-1</th><td>Delete</td></tr>` — one `<th>` and
    // more than one cell — and the step-over's "is there a later, wider
    // heading row" question answered YES to it. The genuine one-cell header
    // above was therefore stepped over, the FIRST DATA ROW became the header
    // (`available headers are O-1, Delete`), and the positional read returned
    // `[{_row:1,id:"Order ID"},{_row:2,id:"O-2"}]` — a data row silently
    // deleted from the middle, which is the one outcome the step-over exists
    // to prevent. A heading row names EVERY column, so it carries more than
    // one `<th>`; one `<th>` beside `<td>`s is a row header.
    const ROWHEADS = `<table id="t" aria-label="Orders"><tbody>
      <tr><th>Order ID</th></tr>
      <tr><th>O-1</th><td><button type="button">Delete</button></td></tr>
      <tr><th>O-2</th><td><button type="button">Delete</button></td></tr>
    </tbody></table>`;

    // By header: the refusal names what the header row actually holds, so it
    // proves WHICH row was taken — `O-1, Delete` is the bug's signature.
    await load(ROWHEADS);
    const message = await refusal({ selector: '#t', columns: [{ header: 'Payee', key: 'p' }] });
    expect(message).not.toContain('O-1, Delete');
    expect(message).toBe(
      'readTable cannot map table "Orders": no column is headed "Payee" — available '
      + 'headers are Order ID',
    );

    await load(ROWHEADS);
    const byHeader = await run({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);

    // By position: both data rows are present, and numbered from 1.
    await load(ROWHEADS);
    const byIndex = await run({ selector: '#t', columns: [{ index: 1, key: 'id' }] });
    expect(byIndex.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);
  });

  it('keeps it when those row headers are marked scope="row" (§10)', async () => {
    // The `scope="row"` spelling of the same table. The step-over asked only
    // whether a later row carries a `<th>`, and `scope` does not enter that
    // question, so the header was stepped over here too — and then the row
    // below was REFUSED as a header for being row-scoped, leaving the table
    // headerless: `Order ID` became record 1 and every real row was numbered
    // one too high.
    const SCOPED = `<table id="t" aria-label="Orders"><tbody>
      <tr><th>Order ID</th></tr>
      <tr><th scope="row">O-1</th><td><button type="button">Delete</button></td></tr>
      <tr><th scope="row">O-2</th><td><button type="button">Delete</button></td></tr>
    </tbody></table>`;

    await load(SCOPED);
    const byHeader = await run({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);

    await load(SCOPED);
    const byIndex = await run({ selector: '#t', columns: [{ index: 1, key: 'id' }] });
    expect(byIndex.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);
  });

  it('finds it past a hidden template row above row-header data rows (§7.3)', async () => {
    // All three guards at once: the `display:none` template row is skipped,
    // the one-cell heading behind it is the header, and the row headers below
    // do not pull the step-over onto it.
    await load(`<table id="t" aria-label="Orders"><tbody>
      <tr class="row-hidden" id="tpl"><td>—</td><td>—</td></tr>
      <tr><th>Order ID</th></tr>
      <tr><th>O-1</th><td><button type="button">Delete</button></td></tr>
      <tr><th>O-2</th><td><button type="button">Delete</button></td></tr>
    </tbody></table>`);
    expect(await page.locator('#tpl').evaluate(
      (el: Element) => (el as HTMLElement).getClientRects().length,
    )).toBe(0);
    const byHeader = await run({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(byHeader.capturedRecords).toEqual([
      { _row: '1', id: 'O-1' },
      { _row: '2', id: 'O-2' },
    ]);
  });

  it('does NOT take a <th scope="row"> first row as the header (§10)', async () => {
    // That <th> is the row's own heading, not the table's headings — reading
    // it as a header row would delete the first account from the read.
    await load(`<table id="t" aria-label="Balances"><tbody>
      <tr><th scope="row">Everyday</th><td>$1,234.56</td></tr>
      <tr><th scope="row">Savings</th><td>$8,410.00</td></tr>
    </tbody></table>`);
    const result = await run({ selector: '#t', columns: [{ index: 1, key: 'account' }] });
    expect(result.capturedRecords).toEqual([
      { _row: '1', account: 'Everyday' },
      { _row: '2', account: 'Savings' },
    ]);
    // And a header-named column against it still gets the §5.4 way out.
    expect(await refusal({ selector: '#t', columns: [{ header: 'Account', key: 'a' }] }))
      .toContain('it has no header row');
  });

  it('takes a BLANK body-row header as the header, out of the data (§7.3, §7.3b.5)', async () => {
    // §7.3b.5 — a header grid that names nothing is no header — is about a
    // `<thead>`. A BODY row §7.3 has already taken as the header is a row of
    // the table, and nothing else takes it out: treated as "no header" it
    // stayed in the body, became record 1 with two empty values and left every
    // `_row` below it one too high, which is §4.5's misalignment.
    await load(`
      <table id="t" aria-label="Orders">
        <tbody>
          <tr><th></th><th></th></tr>
          <tr><td>O-1</td><td>Paid</td></tr>
          <tr><td>O-2</td><td>Due</td></tr>
        </tbody>
      </table>`);
    expect((await run({ selector: '#t', columns: [{ index: 1, key: 'id' }] })).capturedRecords)
      .toEqual([{ _row: '1', id: 'O-1' }, { _row: '2', id: 'O-2' }]);
    // Nothing is lost by keeping it: it names no column, so a read BY name is
    // refused in the words of a header that has no headings in it.
    expect(await refusal({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] }))
      .toBe(
        'readTable cannot map table "Orders": no column is headed "Order ID" — its header row '
        + 'has no non-empty headings',
      );
  });

  it('does NOT take an unscoped row-header <th> as the header under a blank <thead> (§7.3b.5)', async () => {
    // The other side of that line, and the shape issue 059 is about. The
    // `<thead>` names nothing, so it is no header — and the search must not
    // then walk into the body and take the first DATA row's own `<th>`:
    // `<tr><th>O-1</th><td>Delete</td></tr>` is a ROW header (§7.3), and
    // taken as the table's it deletes a data row from the middle of the read.
    await load(`
      <table id="t" aria-label="Orders">
        <thead style="display:none"><tr><th></th></tr></thead>
        <tbody>
          <tr><th>O-1</th><td>Delete</td></tr>
          <tr><th>O-2</th><td>Delete</td></tr>
        </tbody>
      </table>`);
    expect((await run({ selector: '#t', columns: [{ index: 1, key: 'id' }] })).capturedRecords)
      .toEqual([{ _row: '1', id: 'O-1' }, { _row: '2', id: 'O-2' }]);
    expect(await refusal({ selector: '#t', columns: [{ header: 'O-1', key: 'id' }] }))
      .toContain('it has no header row');
  });

  it('reads a CSS-grid table, where every <tr> has display: contents (§7.4)', async () => {
    // `table{display:grid} thead,tbody,tr{display:contents}` is the standard
    // idiom for laying a semantic table out with grid. A `<tr>` with
    // `display: contents` generates no box, so a client-rect visibility test
    // dropped every row of one — and the read stored [] and SUCCEEDED.
    await load(`
      <style>
        table.grid { display: grid; grid-template-columns: repeat(2, auto); }
        table.grid thead, table.grid tbody, table.grid tr { display: contents; }
      </style>
      <table id="t" class="grid" aria-label="Grid orders">
        <thead><tr><th>Order ID</th><th>Status</th></tr></thead>
        <tbody><tr><td>O-1</td><td>Paid</td></tr><tr><td>O-2</td><td>Due</td></tr></tbody>
      </table>`);
    // The row really has no box of its own — this is the condition, not a
    // contrived fixture.
    expect(await page.locator('#t tbody tr').first().evaluate(
      (el: Element) => (el as HTMLElement).getClientRects().length,
    )).toBe(0);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'Order ID', key: 'id' }, { header: 'Status', key: 'status' }],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: 'O-1', status: 'Paid' },
      { _row: '2', id: 'O-2', status: 'Due' },
    ]);
  });

  it('reads a display: contents CELL as its text, not as ""', async () => {
    // Same cause, one level down: the cell is rendered — its text is on the
    // page — but it has no box, so it read as the empty string and a whole
    // column of them was stored and passed on.
    await load(`
      <table id="t" aria-label="Contents">
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td style="display:contents">x</td><td>y</td></tr></tbody>
      </table>`);
    const result = await run({
      selector: '#t',
      columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }],
    });
    expect(result.capturedRecords).toEqual([{ _row: '1', a: 'x', b: 'y' }]);
    // A genuinely hidden cell still reads as "" — the fallback is for
    // `display: contents` only and must not resurrect a hidden column (§10).
    await load(`
      <table id="t" aria-label="Contents">
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td class="col-hidden">secret</td><td>y</td></tr></tbody>
      </table>`);
    const hidden = await run({
      selector: '#t',
      columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }],
    });
    expect(hidden.capturedRecords).toEqual([{ _row: '1', a: '', b: 'y' }]);
  });

  it('reads rows a script appended straight under <table>, with no <tbody> (§7.4)', async () => {
    // HTML source always gets a <tbody> from the parser; `table.appendChild(tr)`
    // does not. A scan of `tBodies` alone found no rows at all and read the
    // table as [], green.
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.evaluate(() => {
      const table = document.createElement('table');
      table.id = 'built';
      table.setAttribute('aria-label', 'Built by script');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const name of ['Order ID', 'Status']) {
        const th = document.createElement('th');
        th.textContent = name;
        headRow.appendChild(th);
      }
      head.appendChild(headRow);
      table.appendChild(head);
      for (const row of [['O-1', 'Paid'], ['O-2', 'Due']]) {
        const tr = document.createElement('tr');
        for (const value of row) {
          const td = document.createElement('td');
          td.textContent = value;
          tr.appendChild(td);
        }
        table.appendChild(tr); // no <tbody> anywhere
      }
      document.getElementById('host')!.appendChild(table);
    });
    expect(await page.locator('#built tbody').count()).toBe(0);
    const result = await run({
      selector: '#built',
      columns: [{ header: 'Order ID', key: 'id' }, { header: 'Status', key: 'status' }],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: 'O-1', status: 'Paid' },
      { _row: '2', id: 'O-2', status: 'Due' },
    ]);
  });
});

// ── structural refusals (§5.3, §7.2, §7.3, §7.4) ────────────────────────────

describe('readTable — structural refusals', () => {
  it('refuses a request for a BAND and names the leaves under it (§5.3, §7.3b)', async () => {
    // Retargeted from `refuses a merged header rather than pretending Order is
    // one column`, which pinned the "merged headers or cells" sentence for a
    // HEADER. §7.3b lays this header out instead — the read of its leaves is
    // in the header-grid suite below — so the only thing left to refuse is a
    // request for the band itself, which is not a column at all.
    await load(BANDED_ORDERS_HTML);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Order', key: 'order' }] }))
      .toBe(
        // §5.3's sentence, with the headers as the suite's `<thead> th` style
        // renders them: the author still writes "ID"/"Customer", and the fold
        // is what matches them (§7.3).
        'readTable cannot map table "Orders": no column is headed "Order" — available headers '
        + 'are ID, CUSTOMER, STATUS ("Order" is a band over ID, CUSTOMER, not a column)',
      );
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

  it('refuses rowspan="0", which spans to the end of the row group', async () => {
    // `rowspan="0"` is legal HTML for "to the end of this row group", and
    // Chromium reports `el.rowSpan === 0` for it — which `rowSpan > 1` missed
    // entirely. The grid below it is shifted exactly as a `rowspan="2"` one
    // is, but the read SUCCEEDED and stored `Bonus` as row 2's Balance.
    await load(`
      <table id="t" aria-label="Accounts by region">
        <thead><tr><th>Region</th><th>Balance</th></tr></thead>
        <tbody>
          <tr><td rowspan="0">New South Wales</td><td>$1,234.56</td></tr>
          <tr><td>$8,410.00</td><td>Bonus</td></tr>
        </tbody>
      </table>`);
    expect(await page.locator('#t tbody td').first().evaluate(
      (el: Element) => (el as HTMLTableCellElement).rowSpan,
    )).toBe(0);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Balance', key: 'balance' }] }))
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

  it('reads a <div role="grid">, which §7.9 made a table', async () => {
    await load(`
      <div id="grid" role="grid" aria-label="Cards">
        <div role="row"><span role="columnheader">Card</span></div>
        <div role="row"><span role="gridcell">Visa</span></div>
      </div>`);
    // This shape used to be the "found no table with rows under" refusal, and
    // §7.9 turned it into a read: the roles that make a div grid a table for a
    // screen reader make it one here. The sentence is still the one a region
    // holding NOTHING with rows gets, which `tests/read-table-aria.test.ts`
    // and `tests/read-table-structure.test.ts` pin from the other side.
    const result = await run({
      selector: '#grid',
      columns: [{ header: 'Card', key: 'card' }],
    });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([{ _row: '1', card: 'Visa' }]);
  });
});

// ── columns by position (§4.4, §5.4) ────────────────────────────────────────

describe('readTable — columns by position', () => {
  /**
   * §5.4: no `<thead>`, a duplicate payee, and cells empty on some rows.
   *
   * The `data-id`s are 7, 8, 9 rather than the page's own 1, 2, 3 on purpose:
   * those aliased `_row` exactly, so an implementation that read the row's
   * `data-id` — the obvious wrong way to number rows, and the one the spec
   * rules out in §4.5 — passed this test.
   */
  const PAYMENTS_HTML = `
    <table id="scheduled-payments" aria-label="Scheduled payments">
      <tbody>
        <tr data-id="7">
          <td>Origin Energy</td><td>INV-2291</td><td>$140.00</td><td>3 Oct 2026</td><td>Scheduled</td>
          <td><input type="checkbox" aria-label="Auto-pay for Origin Energy" checked></td>
          <td><button type="button">View</button> <button type="button">Approve</button></td>
        </tr>
        <tr data-id="8">
          <td>Netflix Australia</td><td></td><td>$22.99</td><td>1 Oct 2026</td><td>Scheduled</td>
          <td><input type="checkbox" aria-label="Auto-pay for Netflix Australia" checked></td>
          <td><button type="button">View</button> <button type="button">Approve</button></td>
        </tr>
        <tr data-id="9">
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
    // `data-id` is the page's own key and is never read: `_row` counts the
    // visible data rows, and is what the read gives a body to find the row by.
    // Asserting on the attribute NAME could not fail — it is not a value —
    // so assert on the numbers, which the fixture made deliberately different.
    expect(result.capturedRecords?.map((r) => r['_row'])).toEqual(['1', '2', '3']);
    expect(await page.locator('#scheduled-payments tbody tr').first().getAttribute('data-id')).toBe('7');
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

// ── how the extractor reaches the page ──────────────────────────────────────

describe('readTable — the page-side extractor is a file, not a TS callback', () => {
  it('hands evaluateAll the compiled script, so esbuild never rewrites its helpers', async () => {
    // Written inline as a TypeScript callback, `keepNames` turned every named
    // helper into `__name(fn, "fn")` — and `__name` exists only in the bundle.
    // Under `tsx` (`npm run dev`) the whole extraction died with
    // `ReferenceError: __name is not defined`, while `dist/` (tsc, no such
    // rewrite) was fine, so nothing in this suite or in a live run from
    // `dist/` could see it. Phase 3's `tables.read` bundle meets the same
    // wall. The remedy is the one `find-in-dom.js` and `capture-dom.js` use:
    // keep the page source in a .js file the bundler never reads.
    const source = await fs.readFile(new URL('../src/browser/actions.ts', import.meta.url), 'utf8');
    const extractor = source.slice(source.indexOf('export async function readTableRecords'));
    expect(extractor).toContain('.evaluateAll(readTableInPage,');
    expect(extractor).not.toMatch(/evaluateAll\(\s*(\(|function|async)/);

    // And the file really is the single expression `new Function` wraps.
    const script = await fs.readFile(
      new URL('../src/browser/scripts/read-table.js', import.meta.url),
      'utf8',
    );
    const compiled = new Function('matches', 'args', `return (\n${script}\n)(matches, args);`);
    expect(typeof compiled).toBe('function');
    // Playwright ships `Function.prototype.toString`, so the .js file's own
    // text is what the browser evaluates.
    expect(compiled.toString()).toContain(script.trim());
  });
});

// ── diagnostics and the column cap (§7.5, §9.2) ─────────────────────────────

/** Twenty columns exactly, so the cap can be tested at its boundary on both
 *  paths rather than at a number comfortably under it. Headerless, because the
 *  boundary is about the COUNT and positional columns say it with no fixture
 *  headings to invent. */
const WIDE_HTML = `<table id="wide" aria-label="Wide"><tbody><tr>${
  Array.from({ length: 20 }, (_, i) => `<td>c${i + 1}</td>`).join('')
}</tr></tbody></table>`;

describe('readTable — how a refusal names the table', () => {
  it('quotes a caption containing quote marks so the message stays readable', async () => {
    await load(`
      <table id="t"><caption>The "Orders" table</caption>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td></tr></tbody>
      </table>`);
    // Interpolated bare, this read `cannot map table "The "Orders" table":`,
    // where the reader cannot tell the table's name from the message's own
    // punctuation.
    expect(await refusal({
      selector: '#t',
      columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }],
    })).toBe(
      'readTable cannot map table "The \\"Orders\\" table": row 1 has 1 cell, so there is no cell '
      + 'for the "B" column at position 2',
    );
  });

  it('refuses more than 20 columns in the extractor as well as in the parser (§9.2)', async () => {
    // §9.2: phase 3's generated `tables.read` calls the extractor directly and
    // never passes through `action-parser.ts`, so the cap has to hold in both
    // places — and hold at the SAME number.
    await load(ORDERS_HTML);
    const columns: TableReadColumn[] = Array.from({ length: 21 }, (_, i) => ({
      index: i + 1,
      key: `k${i}`,
    }));
    await expect(readTableRecords(page, { selector: '#orders', columns }))
      .rejects.toThrow('readTable requests 21 columns — the maximum is 20');
    expect(() => parseAIResponse(JSON.stringify({
      actions: [{ action: 'readTable', selector: '#orders', columns, as: 'rows', description: 'd' }],
      reasoning: '',
    }))).toThrow(/requests 21 columns — the maximum is 20/);
    // Twenty is still fine on both paths — the boundary itself, not a number
    // safely under it. Six columns proved only that the cap is above six, so
    // a cap that had drifted to 19 on one path went unnoticed here.
    await load(WIDE_HTML);
    const twenty = columns.slice(0, 20);
    const accepted = await readTableRecords(page, { selector: '#wide', columns: twenty });
    expect(accepted.records).toHaveLength(1);
    expect(Object.keys(accepted.records[0]!)).toHaveLength(21); // 20 columns plus `_row`
    expect(accepted.records[0]!['k19']).toBe('c20');
    expect(() => parseAIResponse(JSON.stringify({
      actions: [{ action: 'readTable', selector: '#wide', columns: twenty, as: 'rows', description: 'd' }],
      reasoning: '',
    }))).not.toThrow();
  });

  it('refuses an empty column list', async () => {
    await load(ORDERS_HTML);
    await expect(readTableRecords(page, { selector: '#orders', columns: [] }))
      .rejects.toThrow('readTable has an empty "columns" array — name at least one column to read');
  });
});

// ── §6.2 validation, on the helper path too (§9.2) ──────────────────────────
//
// "Identical validation in both paths" was true of the 20-column cap and of
// nothing else: every other §6.2 rule lived in `action-parser.ts` alone, so
// phase 3's generated `tables.read` — which calls the extractor directly and
// never sees the parser — got a silently wrong read where the AI action gets a
// precise refusal. One exported validator now answers for both, which is what
// these pin: the same rule, and the same sentence.

describe('readTable — §6.2 column and limit validation on the helper path', () => {
  /** The message the PARSER gives for the same malformed action, minus its
   *  `at index N` prefix — so a drift in either path shows up here. */
  function parserMessage(action: Record<string, unknown>): string {
    try {
      parseAIResponse(JSON.stringify({
        actions: [{ action: 'readTable', selector: '#orders', as: 'rows', description: 'd', ...action }],
        reasoning: '',
      }));
    } catch (err) {
      return String((err as Error).message).replace('readTable action at index 0', 'readTable');
    }
    throw new Error('the parser accepted it');
  }

  async function bothRefuse(
    request: { columns: TableReadColumn[]; limit?: number },
    expected: string,
  ): Promise<void> {
    await load(ORDERS_HTML);
    await expect(readTableRecords(page, { selector: '#orders', ...request }))
      .rejects.toThrow(expected);
    expect(parserMessage(request as unknown as Record<string, unknown>)).toBe(expected);
  }

  it('refuses the reserved key `_row` instead of overwriting it with the row number', async () => {
    // Unvalidated, `record[rowKey] = String(rowNumber)` was written first and
    // the author's `_row` column overwrote it — or, ordered the other way,
    // theirs was overwritten. Either way the read succeeded and one of the two
    // values was gone.
    await bothRefuse(
      { columns: [{ header: 'Order ID', key: '_row' }] },
      'readTable: column 1 uses the reserved key "_row" — the runtime writes the row number on every record',
    );
  });

  it('refuses a dangerous key instead of dropping the column', async () => {
    // `record['__proto__'] = …` on an object literal assigns nothing: the
    // column silently vanished from every record, and the loop over them
    // failed later on a property that was never there.
    await bothRefuse(
      { columns: [{ header: 'Order ID', key: '__proto__' }] },
      'readTable: column 1 uses the reserved key "__proto__"',
    );
  });

  it('refuses a column that names neither a header nor a position', async () => {
    // It reached the page and came back as
    // `there is no cell at position undefined for "id"` — a message about the
    // table, for a fault in the request.
    await bothRefuse(
      { columns: [{ key: 'id' }] },
      'readTable: column 1 has neither "header" nor "index" — name the column by its header text or by its one-based position',
    );
  });

  it('refuses `limit: 0` instead of reading nothing and succeeding', async () => {
    // `limit: 0` sliced zero rows and stored `[]`, so the loop over it ran
    // zero passes and the step passed — §2's silent-`[]` outcome, reached
    // through the request rather than the DOM.
    await bothRefuse(
      { columns: [{ header: 'Order ID', key: 'id' }], limit: 0 },
      'readTable has an invalid "limit" 0 — use a whole number from 1 to 500',
    );
  });

  it('refuses a limit above the 500-row cap instead of stepping around it', async () => {
    // With any `limit` the unbounded 500-row guard does not apply, so
    // `limit: 99999` was a way to ask for a 20,000-row capture the spec
    // refuses (§7.5).
    await bothRefuse(
      { columns: [{ header: 'Order ID', key: 'id' }], limit: 99999 },
      'readTable has an invalid "limit" 99999 — use a whole number from 1 to 500',
    );
  });

  it('still reads a valid request, so the validator is not just a refusal', async () => {
    await load(ORDERS_HTML);
    const outcome = await readTableRecords(page, {
      selector: '#orders',
      columns: ORDERS_COLUMNS,
      limit: 1,
    });
    expect(outcome.records).toEqual([
      { _row: '1', id: 'ORD-1001', customer: 'Alice Smith', status: 'Completed' },
    ]);
  });
});

// ── split grids: the header in another table (§5.6, §7.2, §7.3a, §12.24) ───
//
// The markup is Telerik's, taken from a DOM walk of the live Kendo UI grid
// demo and matched by `fixtures/test-app/split-grids.html`: the wrapper
// carries the app's id and no accessible name of its own, the header is a
// `<table role="none">` holding only a `<thead>`, the rows are a second
// `<table role="grid">` whose `aria-owns` names that `<thead>`, and the footer
// is a third table holding only a `<tfoot>`. DevExpress and Syncfusion render
// the same split under their own class names.
//
// Every case below is a failure this shape produced before §7.3a existed: a
// header-named read of the row table failed "it has no header row", and a read
// of the header table — the one selector a model reaches for first, because it
// is where the words "Symbol" and "Value" are — stored `[]` and passed GREEN.

/** Symbol, Name, Units, Price, Value, Change — the Holdings grid of §5.6. */
const HOLDINGS: Array<[string, string, string, string, string, string]> = [
  ['VAS', 'Vanguard Australian Shares', '120', '$95.10', '$11,412.00', '+1.2%'],
  ['VGS', 'Vanguard International Shares', '80', '$130.45', '$10,436.00', '-0.4%'],
  ['NDQ', 'Betashares Nasdaq 100', '50', '$42.30', '$2,115.00', '+2.1%'],
  ['IOO', 'iShares Global 100', '15', '$150.20', '$2,253.00', '+0.6%'],
  ['A200', 'Betashares Australia 200', '200', '$135.60', '$27,120.00', '-1.1%'],
  ['BOND', 'Vanguard Bond Index', '300', '$48.75', '$14,625.00', '+0.1%'],
];

/** One Kendo header cell: the title sits three spans deep, beside an
 *  icon-only `<a aria-hidden>` that renders no text of its own — so a naive
 *  `textContent` read of the `<th>` would still work, and the point of
 *  copying it is that `innerText` does too. */
const kendoTh = (title: string) =>
  `<th scope="col" rowspan="1" data-title="${title}" class="k-table-th k-header" role="columnheader">`
  + `<span class="k-cell-inner"><span class="k-link"><span class="k-column-title">${title}</span></span>`
  + `<a class="k-grid-column-menu" href="#" aria-hidden="true" title="${title} edit column settings">`
  + `<span class="k-icon k-svg-icon" aria-hidden="true"></span></a></span></th>`;

/**
 * The Holdings grid, with or without the `aria-owns` that DECLARES the
 * pairing. Without it, the only thing holding the two tables together is
 * §7.3a.2 — one header-only table, neither self-named, nothing with text
 * between them, and the widths matching.
 */
function holdingsGrid(opts: {
  id: string;
  owns: boolean;
  /** What Kendo really puts on the row table: a generated GUID (§7.2). */
  rowId?: string;
  /** An accessible name on the WRAPPER, which is where a grid widget puts
   *  one — never on either table. */
  label?: string;
}): string {
  const heads = ['Symbol', 'Name', 'Units', 'Price', 'Value', 'Change', 'Actions']
    .map(kendoTh).join('');
  const rows = HOLDINGS.map(([symbol, name, units, price, value, change]) => `
        <tr class="k-table-row k-master-row" role="row">
          <td class="k-table-td" role="gridcell"><input type="checkbox" aria-label="Select row"></td>
          <td class="k-table-td" role="gridcell">${symbol}</td>
          <td class="k-table-td" role="gridcell">${name}</td>
          <td class="k-table-td" role="gridcell">${units}</td>
          <td class="k-table-td" role="gridcell">${price}</td>
          <td class="k-table-td" role="gridcell">${value}</td>
          <td class="k-table-td" role="gridcell">${change}</td>
          <td class="k-table-td" role="gridcell"><button type="button">Sell</button></td>
        </tr>`).join('');
  const owns = opts.owns ? ` aria-owns="${opts.id}-thead ${opts.id}-tbody"` : '';
  return `
<div id="${opts.id}" class="k-grid" data-role="grid"${opts.label ? ` aria-label="${opts.label}"` : ''}>
  <div class="k-grid-header"><div class="k-grid-header-wrap">
    <table role="none" class="k-grid-header-table k-table">
      <colgroup><col><col><col><col><col><col><col><col></colgroup>
      <thead class="k-table-thead" role="rowgroup" id="${opts.id}-thead">
        <tr class="k-table-row" role="row">
          <th scope="col" class="k-table-th k-header checkbox-align" role="columnheader"><input type="checkbox" aria-label="Select all rows"></th>
          ${heads}
        </tr>
      </thead>
    </table>
  </div></div>
  <div class="k-grid-container"><div class="k-grid-content">
    <table class="k-grid-table k-table" id="${opts.rowId ?? `${opts.id}-table`}" tabindex="0" role="grid" aria-rowcount="-1"${owns}>
      <colgroup><col><col><col><col><col><col><col><col></colgroup>
      <tbody class="k-table-tbody" role="rowgroup" id="${opts.id}-tbody">${rows}
      </tbody>
    </table>
  </div></div>
  <div class="k-grid-footer"><div class="k-grid-footer-wrap">
    <table class="k-table k-grid-footer-table" role="none">
      <tfoot class="k-table-tfoot" role="rowgroup"><tr class="k-footer-template k-table-row" role="row">
        <td></td><td></td><td>Total</td><td></td><td></td><td>$67,961.00</td><td></td><td></td>
      </tr></tfoot>
    </table>
  </div></div>
</div>`;
}

const HOLDINGS_COLUMNS: TableReadColumn[] = [
  { header: 'Symbol', key: 'symbol' },
  { header: 'Name', key: 'name' },
  { header: 'Value', key: 'value' },
];

const HOLDINGS_RECORDS = HOLDINGS.map(([symbol, name, , , value], i) => ({
  _row: String(i + 1),
  symbol,
  name,
  value,
}));

/** The Dividends grid: grouped, no `aria-owns`, and the wrapper — not either
 *  table — is what carries `role="grid"` and the accessible name. */
function dividendsGrid(bodyRows: string): string {
  const heads = ['Symbol', 'Ex-date', 'Amount', 'Franking', 'Paid'].map(kendoTh).join('');
  return `
<div id="dividends-grid" class="k-grid" data-role="grid" role="grid" aria-label="Dividends">
  <div class="k-grid-header"><div class="k-grid-header-wrap">
    <table role="none" class="k-grid-header-table k-table">
      <thead class="k-table-thead" role="rowgroup" id="dividends-thead">
        <tr class="k-table-row" role="row">
          <th class="k-group-cell k-header k-table-th" scope="col" role="columnheader"></th>
          ${heads}
        </tr>
      </thead>
    </table>
  </div></div>
  <div class="k-grid-container"><div class="k-grid-content">
    <table class="k-grid-table k-table" tabindex="0" role="grid" aria-rowcount="-1">
      <tbody class="k-table-tbody" role="rowgroup" id="dividends-tbody">${bodyRows}
      </tbody>
    </table>
  </div></div>
</div>`;
}

/** Kendo's group row: ONE visible cell spanning the grid, then five
 *  `<td hidden>` fillers — six cells, one of them rendered (§4.8). */
const dividendGroup = (year: string) => `
        <tr class="k-table-group-row k-grouping-row k-table-row" role="row">
          <td class="k-table-td" colspan="6" aria-expanded="true" role="gridcell"><p class="k-reset"><a href="#" tabindex="-1" aria-label="Collapse" class="k-icon" aria-hidden="true"></a>Year: ${year}</p></td>
          <td hidden group-header-spanned-hidden role="gridcell"></td>
          <td hidden group-header-spanned-hidden role="gridcell"></td>
          <td hidden group-header-spanned-hidden role="gridcell"></td>
          <td hidden group-header-spanned-hidden role="gridcell"></td>
          <td hidden group-header-spanned-hidden role="gridcell"></td>
        </tr>`;

const dividendRow = (symbol: string, exDate: string, amount: string, franking: string, paid: string) => `
        <tr class="k-table-row k-master-row" role="row">
          <td class="k-group-cell k-table-group-td k-table-td" role="gridcell"></td>
          <td class="k-table-td" role="gridcell">${symbol}</td>
          <td class="k-table-td" role="gridcell">${exDate}</td>
          <td class="k-table-td" role="gridcell">${amount}</td>
          <td class="k-table-td" role="gridcell">${franking}</td>
          <td class="k-table-td" role="gridcell">${paid}</td>
        </tr>`;

const DIVIDEND_ROWS =
  dividendGroup('2026')
  + dividendRow('VAS', '2026-03-28', '$412.50', '100%', 'Yes')
  + dividendRow('VGS', '2026-03-20', '$88.20', '0%', 'Yes')
  + dividendRow('A200', '2026-01-15', '$655.00', '100%', 'No')
  + dividendGroup('2025')
  + dividendRow('VAS', '2025-12-19', '$398.10', '100%', 'Yes')
  + dividendRow('NDQ', '2025-12-05', '$21.40', '0%', 'Yes');

/** The Watchlist grid: DevExpress class names, no `aria-owns`, no name on
 *  either table or on the wrapper, and a hidden Target column — the `<th>`
 *  and every `<td>` of it are `display:none` together, so the counts still
 *  line up and the column reads `""` (§10). */
const WATCHLIST_HTML = `
<div id="watchlist-grid" class="dx-widget dx-datagrid">
  <div class="dx-datagrid-headers"><div class="dx-datagrid-content">
    <table class="dx-datagrid-table dx-datagrid-table-fixed" role="presentation">
      <thead><tr class="dx-row dx-header-row" role="row">
        <th class="dx-datagrid-action">Symbol</th>
        <th class="dx-datagrid-action">Name</th>
        <th class="dx-datagrid-action">Last</th>
        <th class="dx-datagrid-action col-hidden">Target</th>
        <th class="dx-datagrid-action">Alert</th>
      </tr></thead>
    </table>
  </div></div>
  <div class="dx-datagrid-rowsview"><div class="dx-datagrid-content">
    <table class="dx-datagrid-table dx-datagrid-table-fixed" role="presentation">
      <tbody>
        <tr class="dx-row dx-data-row"><td>VHY</td><td>Vanguard High Yield</td><td>$70.15</td><td class="col-hidden">$75.00</td><td>On</td></tr>
        <tr class="dx-row dx-data-row"><td>VEU</td><td>Vanguard All-World ex-US</td><td>$88.90</td><td class="col-hidden">$90.00</td><td>Off</td></tr>
        <tr class="dx-row dx-data-row"><td>QUAL</td><td>VanEck Quality</td><td>$52.35</td><td class="col-hidden">$55.00</td><td>On</td></tr>
        <tr class="dx-row dx-data-row"><td>ETHI</td><td>Betashares Ethical</td><td>$12.80</td><td class="col-hidden">$14.00</td><td>Off</td></tr>
      </tbody>
    </table>
  </div></div>
</div>`;

/**
 * Kendo's locked-columns form: FOUR tables, the SAME rows split by column
 * across two of them. Deferred (§14) and refused by name rather than
 * half-read.
 *
 * Unlike `holdingsGrid`, this nesting is DOCUMENTATION-derived, not walked:
 * the DOM dump this file's Kendo markup comes from is of a demo with no
 * locked columns, so the class names and the two-tables-per-half arrangement
 * are Telerik's published structure for a locked grid rather than something
 * measured. What the tests below pin is this shape, whatever a particular
 * Kendo build emits.
 *
 * The nesting is the point of the fixture either way: the two header tables
 * share `div.k-grid-header` and the two row tables share
 * `div.k-grid-container`, so the nearest ancestor holding another table,
 * asked from the unlocked row table, is the row half — where there is no
 * header table to find. A candidate walk that stopped there left this grid
 * headerless, and a positional read of it then returned half a grid with no
 * complaint at all.
 */
function frozenGrid(owns: boolean): string {
  return `
<div id="frozen-grid" class="k-grid" data-role="grid">
  <div class="k-grid-header">
    <div class="k-grid-header-locked">
      <table id="frozen-locked-header" role="none" class="k-grid-header-table k-table">
        <thead id="frozen-locked-thead"><tr><th scope="col">Symbol</th></tr></thead>
      </table>
    </div>
    <div class="k-grid-header-wrap">
      <table id="frozen-header" role="none" class="k-grid-header-table k-table">
        <thead id="frozen-thead"><tr><th scope="col">Units</th><th scope="col">Price</th><th scope="col">Value</th></tr></thead>
      </table>
    </div>
  </div>
  <div class="k-grid-container">
    <div class="k-grid-content-locked">
      <table class="k-grid-table k-table" id="frozen-locked-rows" role="grid">
        <tbody><tr><td>VAS</td></tr><tr><td>VGS</td></tr></tbody>
      </table>
    </div>
    <div class="k-grid-content">
      <table class="k-grid-table k-table" id="frozen-rows" role="grid"${owns ? ' aria-owns="frozen-thead frozen-tbody"' : ''}>
        <tbody id="frozen-tbody">
          <tr><td>120</td><td>$95.10</td><td>$11,412.00</td></tr>
          <tr><td>80</td><td>$130.45</td><td>$10,436.00</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>`;
}

describe('readTable — header and rows in separate tables (§5.6, §7.2, §7.3a)', () => {
  it('gives the same records through the wrapper, the row table, and a row table with no aria-owns', async () => {
    // Three selectors, one grid: the wrapper (what §6.3 tells the model to
    // emit), the row table that DECLARES its header through `aria-owns`
    // (§7.3a.1), and the same row table with that attribute removed, where
    // only the sibling rule pairs them (§7.3a.2). A difference between any
    // two of them is a difference the author cannot see in the test text.
    await load(holdingsGrid({ id: 'holdings-grid', owns: true }));
    expect((await run({ selector: '#holdings-grid', columns: HOLDINGS_COLUMNS })).capturedRecords)
      .toEqual(HOLDINGS_RECORDS);
    expect((await run({ selector: '#holdings-grid-table', columns: HOLDINGS_COLUMNS })).capturedRecords)
      .toEqual(HOLDINGS_RECORDS);

    await load(holdingsGrid({ id: 'sibling-grid', owns: false }));
    expect((await run({ selector: '#sibling-grid-table', columns: HOLDINGS_COLUMNS })).capturedRecords)
      .toEqual(HOLDINGS_RECORDS);
    expect((await run({ selector: '#sibling-grid', columns: HOLDINGS_COLUMNS })).capturedRecords)
      .toEqual(HOLDINGS_RECORDS);
  });

  it('says on the result and in the summary line that the header came from another table (§7.6)', async () => {
    await load(holdingsGrid({ id: 'holdings-grid', owns: true }));
    const split = await readTableRecords(page, {
      selector: '#holdings-grid',
      columns: HOLDINGS_COLUMNS,
    });
    expect(split.headerFromSeparateTable).toBe(true);
    expect(formatTableReadSummary(split, 3, 'holdings', undefined))
      .toBe('readTable captured 6 rows × 3 columns as "{{holdings}}" (header from a separate table)');
    // A one-table read must not claim it: the note is the only place a wrong
    // pairing is visible, so it has to mean something.
    await load(ORDERS_HTML);
    const plain = await readTableRecords(page, { selector: '#orders', columns: ORDERS_COLUMNS });
    expect(plain.headerFromSeparateTable).toBe(false);
    expect(formatTableReadSummary(plain, 3, 'orders', undefined))
      .toBe('readTable captured 2 rows × 3 columns as "{{orders}}"');
  });

  it('ignores the footer table, which has neither rows nor a header', async () => {
    // Counted as a table with rows it would make the wrapper ambiguous; taken
    // for a data row its Total would become record 7.
    await load(holdingsGrid({ id: 'holdings-grid', owns: true }));
    const result = await readTableRecords(page, {
      selector: '#holdings-grid',
      columns: HOLDINGS_COLUMNS,
    });
    expect(result.records).toHaveLength(6);
    expect(result.records.some((r) => r['value'] === '$67,961.00')).toBe(false);
  });

  it('refuses the header-only table and names the wrapper, instead of storing [] green', async () => {
    // Declared, and then the same grid with no `aria-owns` at all: the
    // refusal has to reach the author either way, because storing `[]` for
    // the table where the column names are visible is the quiet pass §7.3a.3
    // exists to stop.
    //
    // "beside it", not "after it": `aria-owns` pairs a header table that
    // FOLLOWS its rows just as readily (the test below), so a sentence that
    // said "after" would send the author looking the wrong way down the page.
    await load(holdingsGrid({ id: 'holdings-grid', owns: true }));
    expect(await refusal({
      selector: '#holdings-grid .k-grid-header-table',
      columns: HOLDINGS_COLUMNS,
    })).toBe(
      'readTable cannot read table "holdings-grid": it holds only the header row; the rows are '
      + 'in the table beside it — select the element that contains both ("#holdings-grid") or that table',
    );

    await load(holdingsGrid({ id: 'sibling-grid', owns: false }));
    expect(await refusal({
      selector: '#sibling-grid .k-grid-header-table',
      columns: HOLDINGS_COLUMNS,
    })).toBe(
      'readTable cannot read table "sibling-grid": it holds only the header row; the rows are '
      + 'in the table beside it — select the element that contains both ("#sibling-grid") or that table',
    );
  });

  it('spells the grid in that refusal as a selector the author can paste, or not at all', async () => {
    // A grid widget's wrapper id is routinely a GUID, and `#14277be2-grid` is
    // not a selector — a leading digit starts a number, so `querySelector`
    // throws on it. Escaped, the sentence hands back something that works.
    await load(`
      <div id="14277be2-grid">
        <table id="guid-header"><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
        <table><tbody><tr><td>2026-01-02</td><td>$12.00</td></tr></tbody></table>
      </div>`);
    expect(await refusal({ selector: '#guid-header', columns: [{ header: 'Date', key: 'date' }] }))
      .toBe(
        'readTable cannot read table "14277be2-grid": it holds only the header row; the rows are '
        + 'in the table beside it — select the element that contains both ("#\\31 4277be2-grid") '
        + 'or that table',
      );
    // And with nothing to name the grid by, the sentence drops the
    // parenthetical rather than inventing a selector out of a class name.
    await load(`
      <div>
        <table id="nameless-header"><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
        <table><tbody><tr><td>2026-01-02</td><td>$12.00</td></tr></tbody></table>
      </div>`);
    expect(await refusal({ selector: '#nameless-header', columns: [{ header: 'Date', key: 'date' }] }))
      .toBe(
        'readTable cannot read table "nameless-header": it holds only the header row; the rows '
        + 'are in the table beside it — select the element that contains both or that table',
      );
  });

  it('still reads a header-only table with no partner as an empty table (§4.8)', async () => {
    // The mirror of the refusal above, and the reason it cannot simply key on
    // "a header and no rows": that is also what an empty table looks like.
    await load(`
      <table id="lonely" aria-label="Holdings">
        <thead><tr><th>Symbol</th><th>Value</th></tr></thead>
        <tbody></tbody>
      </table>`);
    const result = await run({ selector: '#lonely', columns: [{ header: 'Symbol', key: 'symbol' }] });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([]);
  });

  it('does not pair two tables that name themselves, and reads the second by position', async () => {
    // A table with an `aria-label` or a `<caption>` is a whole table, not half
    // of a grid (§7.3a): pairing these two would invent a grid out of two
    // unrelated tables that happen to sit together.
    await load(`
      <div id="statements">
        <table aria-label="Statement columns"><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
        <table aria-label="Statement rows"><tbody>
          <tr><td>2026-01-02</td><td>$12.00</td></tr>
          <tr><td>2026-02-02</td><td>$14.00</td></tr>
        </tbody></table>
      </div>`);
    expect(await refusal({
      selector: '[aria-label="Statement rows"]',
      columns: [{ header: 'Date', key: 'date' }],
    })).toBe(
      'readTable cannot map table "Statement rows": it has no header row, so "Date" cannot be '
      + 'matched — name columns by position ("the 1st column as date")',
    );
    const byPosition = await run({
      selector: '[aria-label="Statement rows"]',
      columns: [{ index: 1, key: 'date' }, { index: 2, key: 'amount' }],
    });
    expect(byPosition.capturedRecords).toEqual([
      { _row: '1', date: '2026-01-02', amount: '$12.00' },
      { _row: '2', date: '2026-02-02', amount: '$14.00' },
    ]);
  });

  it('does not pair two unnamed tables with a heading between them — and does pair them without it', async () => {
    // Both halves, because the separator test is only worth anything if the
    // SAME markup pairs once the separator goes: a contiguity rule that never
    // pairs and a contiguity rule that always pairs both pass the first half.
    const report = (heading: string) => `
      <div id="report">
        <table><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
        ${heading}
        <table id="report-rows"><tbody>
          <tr><td>2026-01-02</td><td>$12.00</td></tr>
        </tbody></table>
      </div>`;
    await load(report('<h3>Transactions</h3>'));
    expect(await refusal({ selector: '#report-rows', columns: [{ header: 'Date', key: 'date' }] }))
      .toBe(
        'readTable cannot map table "report-rows": it has no header row, so "Date" cannot be '
        + 'matched — name columns by position ("the 1st column as date")',
      );
    // Empty wrapper `<div>`s and `<colgroup>`s are not text, so a grid whose
    // halves are wrapped in scroll containers stays contiguous.
    await load(report('<div class="scroll-pad"><colgroup></colgroup></div>'));
    expect((await run({ selector: '#report-rows', columns: [{ header: 'Date', key: 'date' }] })).capturedRecords)
      .toEqual([{ _row: '1', date: '2026-01-02' }]);
  });

  it('refuses a header whose width does not match the rows, naming both counts', async () => {
    // A header one column off is §4.5's misalignment with a plausible face —
    // every record would be built, and every value would be from the cell
    // next door.
    await load(`
      <div id="mismatch-grid">
        <div><table><thead><tr><th>Date</th><th>Payee</th><th>Amount</th></tr></thead></table></div>
        <div><table><tbody>
          <tr><td>2026-01-02</td><td>Origin Energy</td><td>$12.00</td><td><button type="button">Pay</button></td></tr>
        </tbody></table></div>
      </div>`);
    expect(await refusal({ selector: '#mismatch-grid', columns: [{ header: 'Payee', key: 'payee' }] }))
      .toBe(
        'readTable cannot map table "mismatch-grid": the header table has 3 cells '
        + 'but its widest row has 4 — the two tables do not line up',
      );

    // The same sentence on the DECLARED path, where the header table is
    // wherever `aria-owns` pointed and need not be beside anything: "the
    // header in the table beside it" was a claim about the markup that this
    // grid does not make.
    await load(`
      <div id="declared-mismatch">
        <table><thead id="dm-head"><tr><th>Date</th><th>Payee</th><th>Amount</th></tr></thead></table>
        <table id="dm-rows" aria-owns="dm-head"><tbody>
          <tr><td>2026-01-02</td><td>Origin Energy</td><td>$12.00</td><td><button type="button">Pay</button></td></tr>
        </tbody></table>
      </div>`);
    expect(await refusal({ selector: '#dm-rows', columns: [{ header: 'Payee', key: 'payee' }] }))
      .toBe(
        'readTable cannot map table "declared-mismatch": the header table has 3 cells '
        + 'but its widest row has 4 — the two tables do not line up',
      );
  });

  it('names the GRID in the width-mismatch refusal, not the row table\'s generated id (§7.2)', async () => {
    // The grid is discovered when the header is adopted, and the label is
    // settled from it BEFORE this refusal is built — otherwise the sentence
    // reads `cannot map table "14277be2-guid-rows"`, a GUID that names
    // nothing the author can look for.
    await load(`
      <div id="holdings-grid">
        <div><table><thead><tr><th>Date</th><th>Payee</th><th>Amount</th></tr></thead></table></div>
        <div><table id="14277be2-guid-rows"><tbody>
          <tr><td>2026-01-02</td><td>Origin Energy</td><td>$12.00</td><td><button type="button">Pay</button></td></tr>
        </tbody></table></div>
      </div>`);
    expect(await refusal({
      selector: '[id="14277be2-guid-rows"]',
      columns: [{ header: 'Payee', key: 'payee' }],
    })).toBe(
      'readTable cannot map table "holdings-grid": the header table has 3 cells but its widest '
      + 'row has 4 — the two tables do not line up',
    );
  });

  it('refuses a frozen-column grid through its wrapper and through its locked row table', async () => {
    // Four tables, the SAME rows split by column across two of them: reading
    // either half is the misalignment this action exists to prevent (§7.3a,
    // §14).
    await load(frozenGrid(false));
    expect(await refusal({ selector: '#frozen-grid', columns: [{ header: 'Value', key: 'value' }] }))
      .toBe(
        'readTable found 2 tables with rows under "#frozen-grid" — it must be exactly one; a grid '
        + 'with frozen (locked) columns splits its rows across two tables, which is not supported',
      );
    // From the LOCKED row table, both header tables are beside it: the walk
    // reaches `div.k-grid` rather than stopping at `div.k-grid-container`,
    // and the second header does not separate it from the first because text
    // inside a table is not a separator (§7.3a.2).
    expect(await refusal({ selector: '#frozen-locked-rows', columns: [{ header: 'Symbol', key: 's' }] }))
      .toBe(
        'readTable found 2 header-only tables beside "frozen-locked-rows" — it must be exactly one; '
        + 'a grid with frozen (locked) columns splits its header across two tables, which is not supported',
      );
    // Not only about header names: a POSITIONAL read of that half would have
    // returned one column of a four-column grid and said nothing.
    expect(await refusal({ selector: '#frozen-locked-rows', columns: [{ index: 1, key: 'a' }] }))
      .toContain('2 header-only tables beside "frozen-locked-rows"');
  });

  it('refuses EITHER header table of a frozen grid, which used to read [] green', async () => {
    // The blocker §7.3a.3 exists for, in its worst form: each header table of
    // a locked grid holds a header and no rows, so both stored `[]` and both
    // steps passed — with the words "Symbol", "Units", "Price" and "Value"
    // visible on screen and nothing read.
    //
    // The refusal is reached by running the beside-it search from the LOCKED
    // row table, which finds two header-only candidates with this table among
    // them: one rule asked from the other side, so the two halves of the
    // section cannot drift apart (§7.3a.3).
    await load(frozenGrid(false));
    for (const selector of ['#frozen-locked-header', '#frozen-header']) {
      expect(await refusal({ selector, columns: [{ index: 1, key: 'a' }] })).toBe(
        'readTable cannot read table "frozen-grid": it holds only the header row of a grid with '
        + 'frozen (locked) columns, which is not supported',
      );
    }
    // `aria-owns` changes which sentence the unlocked header gets — the rows
    // that DECLARE it are readable, so it is the ordinary header-only pick —
    // but the locked header, which nothing declares, is still half a split
    // header.
    await load(frozenGrid(true));
    expect(await refusal({ selector: '#frozen-header', columns: [{ index: 1, key: 'a' }] })).toBe(
      'readTable cannot read table "frozen-grid": it holds only the header row; the rows are in '
      + 'the table beside it — select the element that contains both ("#frozen-grid") or that table',
    );
    expect(await refusal({ selector: '#frozen-locked-header', columns: [{ index: 1, key: 'a' }] })).toBe(
      'readTable cannot read table "frozen-grid": it holds only the header row of a grid with '
      + 'frozen (locked) columns, which is not supported',
    );
  });

  it('leaves the UNLOCKED row table of a frozen grid headerless, because a data table sits between', async () => {
    // Measured, and pinned as measured (§7.3a.2): between either header table
    // and these rows sits the LOCKED row table, and a table with rows between
    // a header and a candidate's rows is that header's partner rather than
    // something to look past — so neither header is a candidate here and the
    // table is simply headerless.
    //
    // That is weaker than the locked half, which is refused as ambiguous: a
    // positional read of THIS half returns three columns of a four-column
    // grid and says nothing. What stops the grid from being read in halves
    // unnoticed is the wrapper (two tables with rows), the locked row table
    // (two header-only tables beside it) and both header tables (the frozen
    // refusal above) — three of the four ways in.
    await load(frozenGrid(false));
    expect(await refusal({ selector: '#frozen-rows', columns: [{ header: 'Value', key: 'value' }] }))
      .toBe(
        'readTable cannot map table "frozen-rows": it has no header row, so "Value" cannot be '
        + 'matched — name columns by position ("the 1st column as value")',
      );
    const byPosition = await run({ selector: '#frozen-rows', columns: [{ index: 1, key: 'units' }] });
    expect(byPosition.success).toBe(true);
    expect(byPosition.capturedRecords).toEqual([
      { _row: '1', units: '120' },
      { _row: '2', units: '80' },
    ]);
  });

  it('reads the unlocked half of a frozen grid that DECLARES its header, and refuses a locked-half name', async () => {
    // `aria-owns` is the page saying outright which header belongs to these
    // rows, so the ambiguity above does not arise: the declared path wins and
    // the read is of the three columns that table actually holds. Asking for
    // a column from the LOCKED half then fails the way any missing header
    // does, listing what this half has — which is the honest answer, and not
    // the same as silently reading the wrong column.
    await load(frozenGrid(true));
    const result = await run({
      selector: '#frozen-rows',
      columns: [
        { header: 'Units', key: 'units' },
        { header: 'Price', key: 'price' },
        { header: 'Value', key: 'value' },
      ],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', units: '120', price: '$95.10', value: '$11,412.00' },
      { _row: '2', units: '80', price: '$130.45', value: '$10,436.00' },
    ]);
    // The headings are upper-cased by the suite's own table style, as this
    // app's are (§7.3): the match still works because the fold is applied to
    // an adopted header exactly as to a native one, and the message lists the
    // headings as the page renders them.
    expect(await refusal({ selector: '#frozen-rows', columns: [{ header: 'Symbol', key: 'symbol' }] }))
      .toBe(
        'readTable cannot map table "frozen-grid": no column is headed "Symbol" — available '
        + 'headers are UNITS, PRICE, VALUE',
      );
  });

  it('does not adopt a header-only table far above it in the page', async () => {
    // The walk goes up until it finds a header-only table that precedes the
    // rows — as far as `<body>` — so an unrelated one at the top of the page
    // IS a candidate, and the thing that rejects it is the text between them,
    // not the walk giving up early.
    await load(`
      <table><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
      <h2>Transactions</h2>
      <section><div class="panel">
        <table id="far-rows"><tbody><tr><td>2026-01-02</td><td>$12.00</td></tr></tbody></table>
      </div></section>`);
    expect(await refusal({ selector: '#far-rows', columns: [{ header: 'Date', key: 'date' }] }))
      .toBe(
        'readTable cannot map table "far-rows": it has no header row, so "Date" cannot be matched '
        + '— name columns by position ("the 1st column as date")',
      );
  });

  it('reads a grouped grid: group rows are placeholders, master rows are numbered without them', async () => {
    // Kendo's group row is one spanning cell plus five `<td hidden>` fillers,
    // so it has SIX cells and one rendered one. Counted as six it reached the
    // merged-cell rule and failed the whole read of a grouped grid (§4.8).
    await load(dividendsGrid(DIVIDEND_ROWS));
    const columns: TableReadColumn[] = [
      { header: 'Symbol', key: 'symbol' },
      { header: 'Ex-date', key: 'ex_date' },
      { header: 'Amount', key: 'amount' },
    ];
    const result = await readTableRecords(page, { selector: '#dividends-grid', columns });
    expect(result.records).toEqual([
      { _row: '1', symbol: 'VAS', ex_date: '2026-03-28', amount: '$412.50' },
      { _row: '2', symbol: 'VGS', ex_date: '2026-03-20', amount: '$88.20' },
      { _row: '3', symbol: 'A200', ex_date: '2026-01-15', amount: '$655.00' },
      { _row: '4', symbol: 'VAS', ex_date: '2025-12-19', amount: '$398.10' },
      { _row: '5', symbol: 'NDQ', ex_date: '2025-12-05', amount: '$21.40' },
    ]);
    expect(result.placeholdersSkipped).toBe(2);
    expect(result.headerFromSeparateTable).toBe(true);
    // No "Year: 2026" anywhere in the records, and the row table's own
    // selector answers the same thing.
    const viaRows = await readTableRecords(page, { selector: '#dividends-grid .k-grid-content table', columns });
    expect(viaRows.records).toEqual(result.records);

    // Emptied, the grid keeps its header table and its rows become one
    // full-width message. That row is one cell wide, so the §7.3a width check
    // must not measure the grid by it — measured, it refused every emptied
    // split grid as a mismatch.
    await load(dividendsGrid(`
        <tr class="k-table-row" role="row"><td class="k-table-td" colspan="6" role="gridcell">No records available.</td></tr>`));
    const empty = await readTableRecords(page, { selector: '#dividends-grid', columns });
    expect(empty.records).toEqual([]);
    expect(empty.placeholdersSkipped).toBe(1);
    expect(formatTableReadSummary(empty, 3, 'dividends', undefined))
      .toBe('readTable captured 0 rows × 3 columns as "{{dividends}}" (1 placeholder row skipped, header from a separate table)');
  });

  it('keeps a hidden column aligned across both tables and reads it as ""', async () => {
    // The `<th>` and every `<td>` of the Target column are `display:none`
    // together, so the cell counts still match on both sides and the column
    // holds its position — the value is empty because it is not rendered,
    // which is the one-table behaviour §10 pins.
    await load(WATCHLIST_HTML);
    const result = await run({
      selector: '#watchlist-grid',
      columns: [
        { header: 'Symbol', key: 'symbol' },
        { header: 'Target', key: 'target' },
        { header: 'Alert', key: 'alert' },
      ],
    });
    expect(result.capturedRecords).toEqual([
      { _row: '1', symbol: 'VHY', target: '', alert: 'On' },
      { _row: '2', symbol: 'VEU', target: '', alert: 'Off' },
      { _row: '3', symbol: 'QUAL', target: '', alert: 'On' },
      { _row: '4', symbol: 'ETHI', target: '', alert: 'Off' },
    ]);
  });

  it('picks the DATA half of an EMPTIED grid by role="grid" (§7.2)', async () => {
    // Kendo's shape with no rows left in it. No table under the wrapper has a
    // DATA row, so the fallback counts tables with any body row — and counted
    // flat that is the emptied body table AND the pager, which refused a grid
    // that simply has no rows as frozen (locked) columns. `role="grid"` is
    // the page saying which of the two is the grid; the header table, a
    // `<thead>` with no `<tbody>` at all, is not in the running either way.
    await load(`
      <div id="k-grid">
        <div class="k-grid-header"><table role="presentation">
          <thead><tr><th>Payee</th><th>Amount</th></tr></thead>
        </table></div>
        <div class="k-grid-content"><table role="grid">
          <tbody><tr><td colspan="2">No records available.</td></tr></tbody>
        </table></div>
        <div class="k-pager"><table role="presentation">
          <tbody><tr><td colspan="2">0 - 0 of 0 items</td></tr></tbody>
        </table></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#k-grid',
      columns: [{ header: 'Payee', key: 'payee' }, { header: 'Amount', key: 'amount' }],
    });
    expect(result.records).toEqual([]);
    // The message row of the half that was picked, and the header it adopted
    // — so the columns the author named resolved against the real headings.
    expect(result.placeholdersSkipped).toBe(1);
    expect(result.headerFromSeparateTable).toBe(true);
  });

  it('still refuses an emptied grid whose rows are split across two tables (§14)', async () => {
    // Two row tables that each say `role="grid"`: frozen (locked) columns with
    // the rows gone. Preferring one of them would be reading half a grid,
    // which is the one outcome the count exists to prevent.
    await load(`
      <div id="frozen">
        <table role="grid"><tbody><tr><td colspan="2">No records.</td></tr></tbody></table>
        <table role="grid"><tbody><tr><td colspan="3">No records.</td></tr></tbody></table>
      </div>`);
    expect(await refusal({ selector: '#frozen', columns: [{ index: 1, key: 'a' }] }))
      .toBe(
        'readTable found 2 tables with rows under "#frozen" — it must be exactly one; a grid '
        + 'with frozen (locked) columns splits its rows across two tables, which is not supported',
      );
  });

  it('says "no table with rows" for a box holding only a header half (§7.2)', async () => {
    // Every table under the wrapper is a header table — this one with the
    // hidden spacer row RadGrid puts in its body — so there is no row table to
    // read, and the sentence says which question was asked rather than
    // answering [] from the header.
    await load(`
      <div id="box">
        <table>
          <thead><tr><th>Payee</th><th>Amount</th></tr></thead>
          <tbody style="display:none"><tr><td colspan="2"></td></tr></tbody>
        </table>
      </div>`);
    expect(await refusal({ selector: '#box', columns: [{ header: 'Payee', key: 'payee' }] }))
      .toBe('readTable found no table with rows under "#box"');
  });

  it('names the grid by the wrapper when neither table has a name of its own (§7.2)', async () => {
    // Kendo's and DevExpress's tables carry `role="none"`/`role="presentation"`
    // and nothing else, so without the wrapper's name a failure reads
    // `cannot map table "#watchlist-grid .dx-datagrid-rowsview table"` — the
    // selector, which tells the author nothing about which grid broke. The
    // wrapper's `aria-label` is the preference and its `id` the fallback
    // (§7.2 point 4).
    await load(WATCHLIST_HTML);
    expect(await refusal({ selector: '#watchlist-grid .dx-datagrid-rowsview table', columns: [{ index: 7, key: 'x' }] }))
      .toBe('readTable cannot map table "watchlist-grid": row 1 has 5 cells, so there is no cell at position 7 for "x"');
    await load(dividendsGrid(DIVIDEND_ROWS));
    expect(await refusal({ selector: '#dividends-grid .k-grid-content table', columns: [{ header: 'Yield', key: 'y' }] }))
      .toBe(
        'readTable cannot map table "Dividends": no column is headed "Yield" — available headers '
        + 'are SYMBOL, EX-DATE, AMOUNT, FRANKING, PAID',
      );
  });

  it('names the grid rather than the row table\'s generated id, but not over a plain table\'s own id (§7.2)', async () => {
    // The order is: the table's own ACCESSIBLE name, the grid's name, the
    // table's id, the selector. The middle two are the only pair that is not
    // obvious, and this is why round: Kendo writes
    // `id="14277be2-015b-4257-bd9e-b7fa3904037e"` on the row table — a GUID
    // that names nothing to anyone — while the app's own `#holdings-grid` is
    // on the wrapper, so naming the table by its id would make every failure
    // on every grid unreadable.
    await load(holdingsGrid({ id: 'holdings-grid', owns: true, rowId: '14277be2-guid' }));
    expect(await refusal({ selector: '[id="14277be2-guid"]', columns: [{ index: 12, key: 'x' }] }))
      .toBe('readTable cannot map table "holdings-grid": row 1 has 8 cells, so there is no cell at position 12 for "x"');

    // A name on the grid beats its id, the same way round as on a table.
    await load(holdingsGrid({ id: 'holdings-grid', owns: true, rowId: '14277be2-guid', label: 'Holdings' }));
    expect(await refusal({ selector: '[id="14277be2-guid"]', columns: [{ index: 12, key: 'x' }] }))
      .toBe('readTable cannot map table "Holdings": row 1 has 8 cells, so there is no cell at position 12 for "x"');

    // And an ordinary one-table read is untouched: with no grid in the
    // picture its id is still what names it.
    await load(`
      <table id="plain-orders">
        <thead><tr><th>Order ID</th><th>Status</th></tr></thead>
        <tbody><tr><td>ORD-1001</td><td>Completed</td></tr></tbody>
      </table>`);
    expect(await refusal({ selector: '#plain-orders', columns: [{ index: 5, key: 'x' }] }))
      .toBe('readTable cannot map table "plain-orders": row 1 has 2 cells, so there is no cell at position 5 for "x"');
  });

  it('prefers a table\'s own header to a header-only table beside it', async () => {
    // "A header in the table always wins" (§7.3a): the sibling here would
    // give every record the wrong column names, and nothing in the result
    // would look wrong.
    await load(`
      <div id="mixed-grid">
        <table><thead><tr><th>Wrong</th><th>Also wrong</th></tr></thead></table>
        <table id="mixed-rows">
          <thead><tr><th>Symbol</th><th>Value</th></tr></thead>
          <tbody><tr><td>VAS</td><td>$11,412.00</td></tr></tbody>
        </table>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#mixed-grid',
      columns: [{ header: 'Symbol', key: 'symbol' }, { header: 'Value', key: 'value' }],
    });
    expect(result.records).toEqual([{ _row: '1', symbol: 'VAS', value: '$11,412.00' }]);
    expect(result.headerFromSeparateTable).toBe(false);
  });

  it('does not adopt a header from a table that is not rendered', async () => {
    // A `display:none` table is not part of the grid on screen, and a grid
    // widget that keeps a template table around would otherwise donate its
    // headings to whatever rows follow.
    await load(`
      <div id="hidden-header-grid">
        <table style="display:none"><thead><tr><th>Symbol</th><th>Value</th></tr></thead></table>
        <table><tbody><tr><td>VAS</td><td>$11,412.00</td></tr></tbody></table>
      </div>`);
    expect(await refusal({ selector: '#hidden-header-grid', columns: [{ header: 'Symbol', key: 'symbol' }] }))
      .toBe(
        'readTable cannot map table "hidden-header-grid": it has no header row, so "Symbol" cannot '
        + 'be matched — name columns by position ("the 1st column as symbol")',
      );
  });

  it('does not make <body> a grid container, so two sections stay two tables', async () => {
    // An EMPTY table in one section and an unrelated headerless one in the
    // next is the ordinary page, not a split grid: the walk stops below
    // `<body>`, so neither table can reach the other. Reaching it, the empty
    // Orders table was refused as "the header half of the grid below" and the
    // unrelated table read its rows under Orders' column names.
    const page = `
      <div id="section-a">
        <table id="empty-orders"><thead><tr><th>Order ID</th><th>Status</th></tr></thead><tbody></tbody></table>
      </div>
      <div id="section-b">
        <table id="later-rows"><tbody><tr><td>ORD-1001</td><td>Completed</td></tr></tbody></table>
      </div>`;
    await load(page);
    const empty = await run({ selector: '#empty-orders', columns: [{ header: 'Order ID', key: 'id' }] });
    expect(empty.success).toBe(true);
    expect(empty.capturedRecords).toEqual([]);
    // The other one reads by position, and by header name it fails with the
    // §5.4 message — the answer for a table that has no header, not for half
    // a grid.
    expect((await run({ selector: '#later-rows', columns: [{ index: 1, key: 'id' }] })).capturedRecords)
      .toEqual([{ _row: '1', id: 'ORD-1001' }]);
    expect(await refusal({ selector: '#later-rows', columns: [{ header: 'Order ID', key: 'id' }] }))
      .toBe(
        'readTable cannot map table "later-rows": it has no header row, so "Order ID" cannot be '
        + 'matched — name columns by position ("the 1st column as id")',
      );
  });

  it('does not pair two tables sitting in two cells of a layout table', async () => {
    // A table inside another table belongs to that table (§7.2, §7.3a), and
    // the test has to be asked WITHOUT a root: relative to the ancestor this
    // walk reaches — the `<tr>`, then the layout table itself — neither of
    // these is "nested inside a table under it", so both looked like halves
    // of one grid and the second read its rows under the first's headings.
    await load(`
      <table id="layout"><tbody><tr>
        <td><table><thead><tr><th>Date</th><th>Amount</th></tr></thead></table></td>
        <td><table id="cell-rows"><tbody><tr><td>2026-01-02</td><td>$12.00</td></tr></tbody></table></td>
      </tr></tbody></table>`);
    expect(await refusal({ selector: '#cell-rows', columns: [{ header: 'Date', key: 'date' }] }))
      .toBe(
        'readTable cannot map table "cell-rows": it has no header row, so "Date" cannot be '
        + 'matched — name columns by position ("the 1st column as date")',
      );
    expect((await run({ selector: '#cell-rows', columns: [{ index: 2, key: 'amount' }] })).capturedRecords)
      .toEqual([{ _row: '1', amount: '$12.00' }]);
  });

  it('does not give a table nested in a header cell the header it is sitting in', async () => {
    // The mirror shape, and the reason the document-order test is not enough
    // on its own: an ancestor "precedes" its descendant, so the header-only
    // table wrapped around this one was a candidate to donate its headings to
    // it — `<th>Date</th>` became the name of the inner table's first column.
    await load(`
      <div id="outer-grid">
        <table><thead><tr>
          <th>Date</th>
          <th><table id="inner"><tbody><tr><td>2026-01-02</td><td>$12.00</td></tr></tbody></table></th>
        </tr></thead></table>
      </div>`);
    expect(await refusal({ selector: '#inner', columns: [{ header: 'Date', key: 'date' }] }))
      .toBe(
        'readTable cannot map table "inner": it has no header row, so "Date" cannot be matched '
        + '— name columns by position ("the 1st column as date")',
      );
  });

  it('reads a wrapper whose header table FOLLOWS its rows when aria-owns declares it', async () => {
    // What the page declares beats what sits beside it on the WRAPPER path
    // too (§7.3a.1 before §7.3a.2): asked only of "the header-only table
    // before the rows", the wrapper answered `[]`'s headerless read for a
    // grid whose own row table read correctly — the same grid, two answers,
    // depending on which selector the author happened to write.
    const declared = `
      <div id="footer-header-grid">
        <table id="fh-rows" aria-owns="fh-head"><tbody>
          <tr><td>2026-01-02</td><td>$12.00</td></tr>
        </tbody></table>
        <table><thead id="fh-head"><tr><th>Date</th><th>Amount</th></tr></thead></table>
      </div>`;
    await load(declared);
    const columns: TableReadColumn[] = [{ header: 'Date', key: 'date' }, { header: 'Amount', key: 'amount' }];
    const viaWrapper = await run({ selector: '#footer-header-grid', columns });
    const viaRows = await run({ selector: '#fh-rows', columns });
    expect(viaWrapper.capturedRecords).toEqual([{ _row: '1', date: '2026-01-02', amount: '$12.00' }]);
    expect(viaRows.capturedRecords).toEqual(viaWrapper.capturedRecords);

    // Without that declaration the header table is simply one that follows
    // the rows, and "the one header-only table BEFORE it" finds nothing — the
    // grid stays headerless rather than pairing across the rows.
    await load(`
      <div id="undeclared-grid">
        <table id="ud-rows"><tbody><tr><td>2026-01-02</td><td>$12.00</td></tr></tbody></table>
        <table><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
      </div>`);
    expect(await refusal({ selector: '#undeclared-grid', columns: [{ header: 'Date', key: 'date' }] }))
      .toBe(
        'readTable cannot map table "undeclared-grid": it has no header row, so "Date" cannot be '
        + 'matched — name columns by position ("the 1st column as date")',
      );
  });

  it('counts a nested table in a data cell as part of its row, not as a second half of the grid', async () => {
    // "Exactly one table with rows under the wrapper" is what refuses a
    // frozen grid, so a table inside a CELL has to be excluded from the
    // count: an expandable detail row would otherwise make every such grid
    // ambiguous.
    await load(`
      <div id="nested-cell-grid">
        <table><thead><tr><th>Date</th><th>Detail</th></tr></thead></table>
        <table><tbody><tr>
          <td>2026-01-02</td>
          <td><table><tbody><tr><td>Origin Energy</td><td>$12.00</td></tr></tbody></table></td>
        </tr></tbody></table>
      </div>`);
    const result = await run({
      selector: '#nested-cell-grid',
      columns: [{ header: 'Date', key: 'date' }, { header: 'Detail', key: 'detail' }],
    });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([
      { _row: '1', date: '2026-01-02', detail: 'Origin Energy $12.00' },
    ]);
  });

  it('pairs a grid whose row table has a dangling aria-labelledby and an empty caption', async () => {
    // Both are markup a widget leaves behind, and counted as names they made
    // the row table a "whole table" — this grid read as headerless, with the
    // column names visible on screen one table above.
    await load(`
      <div id="leftovers-grid">
        <table><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
        <table id="leftovers-rows" aria-labelledby="not-on-this-page"><caption></caption><tbody>
          <tr><td>2026-01-02</td><td>$12.00</td></tr>
        </tbody></table>
      </div>`);
    const result = await run({ selector: '#leftovers-rows', columns: [{ header: 'Amount', key: 'amount' }] });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([{ _row: '1', amount: '$12.00' }]);

    // An `aria-labelledby` that RESOLVES is a name, and still ends the
    // pairing — the difference is whether anything on the page says it.
    await load(`
      <h3 id="statement-heading">Statement rows</h3>
      <div id="named-grid">
        <table><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>
        <table id="named-rows" aria-labelledby="statement-heading"><tbody>
          <tr><td>2026-01-02</td><td>$12.00</td></tr>
        </tbody></table>
      </div>`);
    expect(await refusal({ selector: '#named-rows', columns: [{ header: 'Amount', key: 'amount' }] }))
      .toBe(
        'readTable cannot map table "Statement rows": it has no header row, so "Amount" cannot be '
        + 'matched — name columns by position ("the 1st column as amount")',
      );
  });

  it('adopts a TWO-ROW header from the table beside it, and through the wrapper', async () => {
    // Retargeted from `does not take a two-row header from the table beside
    // it, but does through the wrapper`, which pinned "its header has 2 rows,
    // and v1 supports exactly one" and the split between the two paths that
    // refusal created. §7.3b lays a two-row header out, so this header is no
    // longer evidence of nothing: it names its columns by the LOWER row, the
    // table beside it adopts it, and both paths answer the same thing.
    const markup = (wrapperId: string) => `
      <div id="${wrapperId}">
        <table><thead>
          <tr><th>Date</th><th>Amount</th></tr>
          <tr><th>(AEST)</th><th>(AUD)</th></tr>
        </thead></table>
        <table id="two-row-rows"><tbody><tr><td>2026-01-02</td><td>$12.00</td></tr></tbody></table>
      </div>`;
    for (const wrapperId of ['beside-two-row', 'wrapper-two-row']) {
      await load(markup(wrapperId));
      for (const selector of ['#two-row-rows', `#${wrapperId}`]) {
        expect((await run({
          selector,
          columns: [{ header: '(AEST)', key: 'date' }, { header: '(AUD)', key: 'amount' }],
        })).capturedRecords).toEqual([{ _row: '1', date: '2026-01-02', amount: '$12.00' }]);
        // The upper row groups the two columns and names neither.
        expect(await refusal({ selector, columns: [{ header: 'Date', key: 'date' }] }))
          .toBe(
            `readTable cannot map table "${wrapperId}": no column is headed "Date" — available `
            + 'headers are (AEST), (AUD) ("Date" is a band over (AEST), not a column)',
          );
      }
      // A positional read is untouched by any of it.
      expect((await run({ selector: '#two-row-rows', columns: [{ index: 1, key: 'date' }] })).capturedRecords)
        .toEqual([{ _row: '1', date: '2026-01-02' }]);
    }
  });

  it('looks for no partner at all for a table that names itself (§7.3a)', async () => {
    // A name is the author saying this is a whole table, so the beside-it
    // search does not run — not even far enough to find two header-only
    // tables and refuse as ambiguous, which would end a read that a name was
    // supposed to make safe.
    await load(`
      <div id="named-half-grid">
        <table><thead><tr><th>Date</th></tr></thead></table>
        <table><thead><tr><th>Amount</th></tr></thead></table>
        <table id="self-named-rows" aria-label="Statement rows"><tbody>
          <tr><td>2026-01-02</td></tr>
        </tbody></table>
      </div>`);
    const result = await run({ selector: '#self-named-rows', columns: [{ index: 1, key: 'date' }] });
    expect(result.success).toBe(true);
    expect(result.capturedRecords).toEqual([{ _row: '1', date: '2026-01-02' }]);
  });
});

// ── banded headers: the header grid (§5.3, §7.3b, §12.26) ──────────────────
//
// V1 read exactly ONE header row and refused every other shape as "merged
// headers", which on the live RadGrid demo refused every read by header name.
// §7.3b lays the header rows out the way the HTML table algorithm lays a table
// out — each cell takes the first free column of its row and spans across and
// down — and names a column by the LOWEST cell covering it that says anything.
//
// The `<thead> th` rule in TABLE_CSS upper-cases headings for looks (§7.3), so
// the headers these messages list come back upper-cased; the author still
// writes them in the case the page's source uses, and the fold matches them.

describe('readTable — banded headers, the header grid (§7.3b)', () => {
  it('names each column by the LOWEST heading over it (§5.3)', async () => {
    // "Order" spans ID and Customer and names neither; "Status" spans both
    // header rows and names its own column, because nothing sits below it.
    await load(BANDED_ORDERS_HTML);
    expect((await run({
      selector: '#t',
      columns: [
        { header: 'ID', key: 'id' },
        { header: 'Customer', key: 'customer' },
        { header: 'Status', key: 'status' },
      ],
    })).capturedRecords).toEqual([
      { _row: '1', id: 'ORD-1001', customer: 'Alice Smith', status: 'Completed' },
    ]);
  });

  it('lets a blank corner cell spanning two rows make the grid wider than the name row', async () => {
    // RadGrid's expand column: `<th rowspan="2">` with nothing in it, so the
    // name row has TWO cells for a three-column grid. Read without the layout,
    // the name row starts at column 0 and every column reads one cell left —
    // `applicant` would come back as the expand cell's "+".
    await load(`
      <table id="t" aria-label="Loan applications">
        <thead>
          <tr><th rowspan="2"></th><th colspan="2">APPLICANT</th></tr>
          <tr><th>Applicant</th><th>Type</th></tr>
        </thead>
        <tbody>
          <tr><td>+</td><td>Sarah Mitchell</td><td>Home</td></tr>
          <tr><td colspan="3">No more applications.</td></tr>
        </tbody>
      </table>`);
    const outcome = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'Applicant', key: 'applicant' }, { header: 'Type', key: 'type' }],
    });
    expect(outcome.records).toEqual([
      { _row: '1', applicant: 'Sarah Mitchell', type: 'Home' },
    ]);
    // And the width every later rule uses is the GRID's three, not the name
    // row's two: the message row spans three and is a placeholder (§4.8).
    expect(outcome.placeholdersSkipped).toBe(1);

    // The other side of that number, which is what makes it measurable: a lone
    // cell spanning only TWO of the three columns is a merged grid and not a
    // message (§10). Measured against a width of two — the name row's cell
    // count — this row would have been skipped and the read would have
    // succeeded on a table it could not map.
    await load(`
      <table id="t" aria-label="Loan applications">
        <thead>
          <tr><th rowspan="2"></th><th colspan="2">APPLICANT</th></tr>
          <tr><th>Applicant</th><th>Type</th></tr>
        </thead>
        <tbody><tr><td colspan="2">Something merged</td></tr></tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Applicant', key: 'applicant' }] }))
      .toBe('readTable cannot map table "Loan applications": merged headers or cells (rowspan/colspan > 1) are not supported');
  });

  it('lays a filter row out, and lets it name nothing (§7.3b.3)', async () => {
    // RadGrid's filter row is inside the `<thead>` and holds only inputs. It
    // is laid out — it can widen the grid — but a blank cell names nothing, so
    // the names still come from the row above. Counted as the lowest cell
    // whatever it holds, every column would be nameless and every read by name
    // would fail "no column is headed".
    await load(`
      <table id="t" aria-label="Loan applications">
        <thead>
          <tr><th rowspan="2"></th><th>Applicant</th><th>Status</th></tr>
          <tr class="filter"><td><input aria-label="Filter applicant"></td><td><select aria-label="Filter status"><option>All</option></select></td></tr>
        </thead>
        <tbody><tr><td>+</td><td>Sarah Mitchell</td><td>Approved</td></tr></tbody>
      </table>`);
    expect((await run({
      selector: '#t',
      columns: [{ header: 'Applicant', key: 'applicant' }, { header: 'Status', key: 'status' }],
    })).capturedRecords).toEqual([
      { _row: '1', applicant: 'Sarah Mitchell', status: 'Approved' },
    ]);
  });

  it('names a heading cell by its own rendered text, not by what a FIELD holds (§7.3b.3)', async () => {
    // Measured: a cell holding a control used to switch to a raw text-node
    // walk, which reads `display:none` text and concatenates with no spaces —
    // `<th>Status<span style="display:none">SORTKEY</span><input
    // type="hidden"></th>` was named `StatusSORTKEY`, so no read of that
    // column matched and the available-headers list showed the run-on word.
    // The heading is `innerText`, which never sees the hidden span, with each
    // control's own `innerText` subtracted out of it. A `<button>` stays: a
    // sortable header's title is routinely inside one.
    await load(`
      <table id="t" aria-label="Payments">
        <thead><tr>
          <th>Status<span style="display:none">SORTKEY</span><input type="hidden" name="sort"></th>
          <th><button type="button">Amount</button></th>
        </tr></thead>
        <tbody><tr><td>Approved</td><td>$1.00</td></tr></tbody>
      </table>`);
    expect((await run({
      selector: '#t',
      columns: [{ header: 'Status', key: 'status' }, { header: 'Amount', key: 'amount' }],
    })).capturedRecords).toEqual([{ _row: '1', status: 'Approved', amount: '$1.00' }]);
    // `Amount` keeps its own case: a `<button>` does not inherit the `<th>`
    // style's `text-transform`, which is one more reason the match folds case.
    expect(await refusal({ selector: '#t', columns: [{ header: 'Sort', key: 'sort' }] }))
      .toBe(
        'readTable cannot map table "Payments": no column is headed "Sort" — available headers '
        + 'are STATUS, Amount',
      );
  });

  it('lets a filter cell name nothing even when it hides a label (§7.3b.3)', async () => {
    // The other half of the same fix, and the one that decides where the
    // accessible-name fallback stops. A filter cell is `<td><input><span
    // style="display:none">Filter Name</span></td>`; the fallback read that
    // hidden span as the column's name, one row BELOW the real heading, so it
    // won and every read of the column failed "no column is headed". A cell
    // holding a RENDERED control renders something — it is a field, not a
    // heading — and a `<select>`'s options and a `<textarea>`'s text are
    // values, not labels.
    await load(`
      <table id="t" aria-label="Orders">
        <thead>
          <tr><th>Name</th><th>Status</th><th>Notes</th></tr>
          <tr class="filter">
            <td><input aria-label="Filter name"><span style="display:none">Filter Name</span></td>
            <td><select aria-label="Filter status"><option>All</option><option>Open</option></select></td>
            <td><textarea aria-label="Filter notes">DRAFT</textarea></td>
          </tr>
        </thead>
        <tbody><tr><td>Ada</td><td>Open</td><td>n1</td></tr></tbody>
      </table>`);
    expect((await run({
      selector: '#t',
      columns: [
        { header: 'Name', key: 'name' },
        { header: 'Status', key: 'status' },
        { header: 'Notes', key: 'notes' },
      ],
    })).capturedRecords).toEqual([{ _row: '1', name: 'Ada', status: 'Open', notes: 'n1' }]);
    // None of the three fields named anything: not the hidden span, not the
    // select's "All", not the textarea's "DRAFT".
    expect(await refusal({ selector: '#t', columns: [{ header: 'Filter Name', key: 'k' }] }))
      .toBe(
        'readTable cannot map table "Orders": no column is headed "Filter Name" — available '
        + 'headers are NAME, STATUS, NOTES',
      );
  });

  it('reads a visually-hidden heading past an UNRENDERED control, skipping its text (§7.3b.3)', async () => {
    // Where the fallback still runs. An `<input type="hidden">` is not
    // evidence that the cell renders anything, so a postback field beside
    // RadGrid's `<span style="display:none">ExpandColumn</span>` must not cost
    // that column its accessible name. What the fallback must NOT read is a
    // control's own content: a `display:none` `<select>` answers `innerText`
    // with its options — unrendered elements fall back to `textContent` — and
    // would otherwise donate "All" as the heading of the column it sits in.
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr>
          <th><input type="hidden" name="sort"><span style="display:none">Select</span></th>
          <th><select style="display:none"><option>All</option></select></th>
          <th>Order ID</th>
        </tr></thead>
        <tbody><tr><td><input type="checkbox"></td><td>x</td><td>ORD-1001</td></tr></tbody>
      </table>`);
    expect((await run({ selector: '#t', columns: [{ header: 'Select', key: 'select' }] }))
      .capturedRecords).toEqual([{ _row: '1', select: '' }]);
    expect(await refusal({ selector: '#t', columns: [{ header: 'All', key: 'k' }] }))
      .toBe(
        'readTable cannot map table "Orders": no column is headed "All" — available headers '
        + 'are Select, ORDER ID',
      );
  });

  it('tells "Q1 > Fee" from "Q2 > Fee", and lists positions for the plain name', async () => {
    // The Quarterly fees table of `radgrid.html`: the same two leaf names
    // under two bands. The plain name is ambiguous and says where both are
    // (§7.3), and the band written with the leaf picks one (§7.3b.4).
    await load(QUARTERLY_FEES_HTML);
    expect((await run({
      selector: '#banded-table',
      columns: [
        { header: 'Account', key: 'account' },
        { header: 'Q1 > Fee', key: 'q1_fee' },
        { header: 'Q2 > Rebate', key: 'q2_rebate' },
      ],
    })).capturedRecords).toEqual([
      { _row: '1', account: 'Everyday', q1_fee: '$4.00', q2_rebate: '$1.50' },
      { _row: '2', account: 'Savings', q1_fee: '$0.00', q2_rebate: '$0.00' },
    ]);
    expect(await refusal({ selector: '#banded-table', columns: [{ header: 'Fee', key: 'fee' }] }))
      .toBe(
        'readTable cannot map table "Quarterly fees": "Fee" matches 2 columns (positions 2, 4) '
        + '— name the one you mean by position',
      );
    // A band that is not over that leaf matches nothing at all.
    expect(await refusal({ selector: '#banded-table', columns: [{ header: 'Q3 > Fee', key: 'fee' }] }))
      .toBe(
        'readTable cannot map table "Quarterly fees": no column is headed "Q3 > Fee" — '
        + 'available headers are ACCOUNT, FEE, REBATE, FEE, REBATE',
      );
  });

  it('accepts "Q1>Fee" however the separator was typed, plain reading first (§7.3b.4)', async () => {
    // The segments are split on the `>` with ANY whitespace around it, none
    // included. Split on the three-character `' > '` alone, `Q1>Fee` stayed
    // ONE segment, matched no leaf and refused a column that is there.
    await load(QUARTERLY_FEES_HTML);
    for (const header of ['Q1>Fee', 'Q1 >Fee', 'Q1> Fee', 'Q1  >  Fee']) {
      expect(
        (await run({ selector: '#banded-table', columns: [{ header, key: 'fee' }] }))
          .capturedRecords,
        header,
      ).toEqual([{ _row: '1', fee: '$4.00' }, { _row: '2', fee: '$0.00' }]);
    }
    // And the PLAIN reading is still tried first, over the whole string, so a
    // heading that genuinely contains the separator stays reachable by typing
    // it — split first, `A>B` would look for a column headed `B` under a band
    // called `A` and refuse the column that is there.
    await load(`
      <table id="t" aria-label="Rules">
        <thead><tr><th>A&gt;B</th><th>C</th></tr></thead>
        <tbody><tr><td>allow</td><td>deny</td></tr></tbody>
      </table>`);
    expect((await run({ selector: '#t', columns: [{ header: 'A>B', key: 'rule' }] }))
      .capturedRecords).toEqual([{ _row: '1', rule: 'allow' }]);
  });

  it('walks the bands TOP-DOWN, and lets a level be skipped (§7.3b.4)', async () => {
    // Two levels of band over the same column. Every segment but the last
    // names a band over it, consumed in the order they were typed against the
    // bands taken from the top down — so the path has to be written the way
    // the table reads, and a level in the middle may be left out.
    await load(`
      <table id="t" aria-label="Nested bands">
        <thead>
          <tr><th colspan="2">Top</th></tr>
          <tr><th colspan="2">Mid</th></tr>
          <tr><th>L1</th><th>L2</th></tr>
        </thead>
        <tbody><tr><td>one</td><td>two</td></tr></tbody>
      </table>`);
    expect((await run({ selector: '#t', columns: [{ header: 'Top > Mid > L1', key: 'k' }] }))
      .capturedRecords).toEqual([{ _row: '1', k: 'one' }]);
    expect((await run({ selector: '#t', columns: [{ header: 'Top > L1', key: 'k' }] }))
      .capturedRecords).toEqual([{ _row: '1', k: 'one' }]);
    // Written bottom-up it is not a path down this header and matches nothing.
    expect(await refusal({ selector: '#t', columns: [{ header: 'Mid > Top > L1', key: 'k' }] }))
      .toBe(
        'readTable cannot map table "Nested bands": no column is headed "Mid > Top > L1" — '
        + 'available headers are L1, L2',
      );
  });

  it('lists a leaf spanning two columns ONCE under its band (§7.3b.4)', async () => {
    // "Amount" is the name of BOTH columns, so the band above covers that one
    // name twice; listed twice the sentence reads as a mistake in the table
    // rather than a band over one column.
    await load(`
      <table id="t" aria-label="Quarterly totals">
        <thead>
          <tr><th colspan="2">Totals</th></tr>
          <tr><th colspan="2">Amount</th></tr>
        </thead>
        <tbody><tr><td>$1.00</td><td>$2.00</td></tr></tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Totals', key: 'k' }] }))
      .toBe(
        'readTable cannot map table "Quarterly totals": no column is headed "Totals" — available '
        + 'headers are AMOUNT, AMOUNT ("Totals" is a band over AMOUNT, not a column)',
      );
  });

  it('lets a band NAME the one column nothing below it names (§7.3b)', async () => {
    // A cell is a BAND only when no column ends up taking its name. Here the
    // name row leaves column 2 blank, so "Group" is the lowest non-blank
    // heading over it and names it. Classed as a band whatever is below,
    // column 2 would be nameless and the request would be refused as a group.
    await load(`
      <table id="t" aria-label="Ledger">
        <thead>
          <tr><th colspan="2">Group</th></tr>
          <tr><th>Account</th><th></th></tr>
        </thead>
        <tbody><tr><td>Everyday</td><td>$1.00</td></tr></tbody>
      </table>`);
    expect((await run({
      selector: '#t',
      columns: [{ header: 'Account', key: 'account' }, { header: 'Group', key: 'group' }],
    })).capturedRecords).toEqual([{ _row: '1', account: 'Everyday', group: '$1.00' }]);
  });

  it('names both columns from a leaf cell spanning two, and refuses the request', async () => {
    // §7.3b.6: a leaf that spans names each column it covers, so asking for it
    // is the ordinary duplicate refusal — and the positions it lists are the
    // way in.
    await load(`
      <table id="t" aria-label="Regions">
        <thead><tr><th>Region</th><th colspan="2">Amount</th></tr></thead>
        <tbody><tr><td>NSW</td><td>$10.00</td><td>$20.00</td></tr></tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Amount', key: 'amount' }] }))
      .toBe(
        'readTable cannot map table "Regions": "Amount" matches 2 columns (positions 2, 3) — '
        + 'name the one you mean by position',
      );
    expect((await run({ selector: '#t', columns: [{ index: 3, key: 'amount' }] })).capturedRecords)
      .toEqual([{ _row: '1', amount: '$20.00' }]);
  });

  it('runs a rowspan="0" header cell to the LAST header row (§4.8, §7.3b.2)', async () => {
    // Legal HTML for "to the end of this row group", reported by the DOM as 0.
    // Read as 1, the cell stops occupying the name row, "Bid" lands in column
    // 1 under "Symbol" and takes the name off it — every read by name then
    // fails or reads the wrong column.
    await load(`
      <table id="t" aria-label="Quotes">
        <thead>
          <tr><th rowspan="0">Symbol</th><th colspan="2">Price</th></tr>
          <tr><th>Bid</th><th>Ask</th></tr>
        </thead>
        <tbody><tr><td>VAS</td><td>$95.10</td><td>$95.20</td></tr></tbody>
      </table>`);
    expect(await page.locator('#t thead th').first().evaluate(
      (el: Element) => (el as HTMLTableCellElement).rowSpan,
    )).toBe(0);
    expect((await run({
      selector: '#t',
      columns: [
        { header: 'Symbol', key: 'symbol' },
        { header: 'Bid', key: 'bid' },
        { header: 'Ask', key: 'ask' },
      ],
    })).capturedRecords).toEqual([
      { _row: '1', symbol: 'VAS', bid: '$95.10', ask: '$95.20' },
    ]);
  });

  it('takes no header from a <thead> whose grid names nothing, and uses the declared one', async () => {
    // §7.3b.5, the RadGrid data table in miniature: its own `<thead>` is one
    // hidden empty `<th>`. Taken as the header, every read by name failed
    // "its header row has no non-empty headings" one table away from the
    // headings that `aria-owns` names.
    await load(`
      <div id="grid">
        <table id="head-half"><thead id="head-thead"><tr><th>Payee</th><th>Amount</th></tr></thead></table>
        <table id="row-half" aria-owns="head-thead row-tbody">
          <thead style="display:none"><tr><th></th></tr></thead>
          <tbody id="row-tbody"><tr><td>Origin Energy</td><td>$140.00</td></tr></tbody>
        </table>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#row-half',
      columns: [{ header: 'Payee', key: 'payee' }, { header: 'Amount', key: 'amount' }],
    });
    expect(result.records).toEqual([{ _row: '1', payee: 'Origin Energy', amount: '$140.00' }]);
    expect(result.headerFromSeparateTable).toBe(true);
  });

  it('carries neither header refusal in the extractor any more (§7.3b.6)', async () => {
    // The two sentences §7.3b deletes. The merged-cell sentence itself stays —
    // a BODY cell that spans is still the §7.4 error, pinned above — so what is
    // asserted is the half that named a HEADER.
    const source = await fs.readFile(
      new URL('../src/browser/scripts/read-table.js', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('and v1 supports exactly one');
    expect(source).not.toContain("refusal: 'merged'");
    // The sentence itself stays, for the body cell it is now only about.
    expect(source).toContain('merged headers or cells (rowspan/colspan > 1) are not supported');
  });
});

// ── Telerik RadGrid: three tables, a banded header, a pager (§5.7, §12.27) ──
//
// Walked from the live ASP.NET AJAX demo on 2026-09-23 and matched by
// `fixtures/test-app/radgrid.html`. What the extractor made of the real page
// before §7.3b: the box refused "found 3 tables with rows" (the header
// table's hidden spacer row and the pager's one row counted as rows), the data
// table read by POSITION only (its own hidden empty `<thead>` won over the
// `aria-owns` header), and the header table was refused as merged.

/** Applicant, Type, Amount, Term, Rate, Status, Officer — plus the expand cell
 *  and the Review button, nine columns in all. Page one of `radgrid.html`,
 *  which pages 10/10/6: two rows for the same applicant, different amounts. */
const LOANS: Array<[string, string, string, string, string, string, string]> = [
  ['Sarah Mitchell', 'Home', '$420,000.00', '30 years', '5.89%', 'Approved', 'D. Okafor'],
  ['Sarah Mitchell', 'Car', '$32,500.00', '5 years', '8.25%', 'Pending', 'L. Fontaine'],
  ['James Whitfield', 'Home', '$615,000.00', '25 years', '5.74%', 'Approved', 'D. Okafor'],
  ['Priya Raghunathan', 'Personal', '$12,000.00', '3 years', '11.20%', 'Declined', 'L. Fontaine'],
  ['Tomas Iversen', 'Car', '$48,900.00', '7 years', '7.95%', 'Approved', 'M. Castillo'],
  ['Grace Abernathy', 'Home', '$298,400.00', '20 years', '6.10%', 'Declined', 'D. Okafor'],
  ['Kwame Boateng', 'Personal', '$7,500.00', '2 years', '12.40%', 'Pending', 'M. Castillo'],
  ['Elena Vasquez', 'Home', '$505,000.00', '30 years', '5.99%', 'Approved', 'L. Fontaine'],
  ['Hiroshi Tanaka', 'Car', '$26,750.00', '5 years', '8.40%', 'Pending', 'M. Castillo'],
  ['Aoife Donnelly', 'Home', '$372,000.00', '25 years', '6.05%', 'Approved', 'D. Okafor'],
];

const loanRow = (
  [applicant, type, amount, term, rate, status, officer]: (typeof LOANS)[number],
  i: number,
) => `
        <tr id="RadGrid1_ctl00__${i}" class="${i % 2 === 0 ? 'rgRow' : 'rgAltRow'}" role="row">
          <td class="rgExpandCol" role="gridcell"><button type="button" title="Expand" aria-label="Expand"></button></td>
          <td role="gridcell">${applicant}</td><td role="gridcell">${type}</td>
          <td role="gridcell">${amount}</td><td role="gridcell">${term}</td>
          <td role="gridcell">${rate}</td>
          <td role="gridcell"><span class="badge">${status}</span></td>
          <td role="gridcell">${officer}</td>
          <td role="gridcell"><input type="button" value="Review"></td>
        </tr>`;

/**
 * The static-headers grid: a header table whose `<thead>` is a band row, a
 * name row and a filter row and whose `<tbody>` holds one hidden spacer, the
 * data table with an empty hidden `<thead>` of its own and `aria-owns`, and a
 * pager table whose one row is a lone `<td colspan="9">` around nested tables.
 */
function radgrid(extraRows = '', owns = true): string {
  return `
<h2>Loan applications</h2>
<div id="RadGrid1" class="RadGrid RadGrid_Silk rgMultiHeader" tabindex="0">
  <div class="rgHeaderWrapper"><div class="rgHeaderDiv">
    <table id="RadGrid1_ctl00_Header" class="rgMasterTable" role="presentation">
      <thead id="RadGrid1_ctl00_Header_thead">
        <tr class="rgMultiHeaderRow" role="row">
          <th scope="col" class="rgHeader rgExpandCol" rowspan="2" aria-label="ExpandColumn"><span style="display:none">ExpandColumn</span></th>
          <th scope="col" class="rgHeader" colspan="2">APPLICANT</th>
          <th scope="col" class="rgHeader" colspan="3">LOAN</th>
          <th scope="col" class="rgHeader" colspan="3">REVIEW</th>
        </tr>
        <tr class="rgMultiHeaderRow" role="row">
          <th scope="col" class="rgHeader">Applicant</th><th scope="col" class="rgHeader">Type</th>
          <th scope="col" class="rgHeader">Amount</th><th scope="col" class="rgHeader">Term</th>
          <th scope="col" class="rgHeader">Rate</th><th scope="col" class="rgHeader">Status</th>
          <th scope="col" class="rgHeader">Officer</th><th scope="col" class="rgHeader">Action</th>
        </tr>
        <tr class="rgFilterRow" role="presentation">
          <td></td><td><input aria-label="Filter Applicant"></td><td></td><td></td><td></td><td></td>
          <td><select aria-label="Filter Status"><option>All</option></select></td><td></td><td></td>
        </tr>
      </thead>
      <tbody style="display:none"><tr role="presentation"><td colspan="9"></td></tr></tbody>
    </table>
  </div></div>
  <div class="rgDataDiv">
    <table id="RadGrid1_ctl00" class="rgMasterTable" role="grid"${
      owns ? '\n           aria-owns="RadGrid1_ctl00_Header_thead RadGrid1_ctl00_tbody "' : ''}>
      <thead style="display:none"><tr><th scope="col"></th></tr></thead>
      <tbody id="RadGrid1_ctl00_tbody">${LOANS.map(loanRow).join('')}${extraRows}
      </tbody>
    </table>
  </div>
  <table id="RadGrid1_ctl00_Pager" class="rgMasterTable" role="presentation">
    <thead><tr style="display:none"></tr></thead>
    <tbody><tr class="rgPager"><td class="rgPagerCell" colspan="9">
      <div class="rgWrap rgNumPart"><a href="#">1</a> <a href="#">2</a> <a href="#">3</a></div>
      <div class="rgWrap rgInfoPart">26 items in 3 pages</div>
    </td></tr></tbody>
  </table>
</div>`;
}

/**
 * The same box with its data table EMPTIED to §4.8's message row — the shape
 * a filter with no matches leaves behind. Three tables, and not one of them
 * has a data row: the header table's hidden spacer, the message row, and the
 * pager's row.
 */
const EMPTY_RADGRID = radgrid().replace(
  LOANS.map(loanRow).join(''),
  '\n        <tr role="row"><td colspan="9">No records available.</td></tr>',
);

const LOAN_COLUMNS: TableReadColumn[] = [
  { header: 'Applicant', key: 'applicant' },
  { header: 'Amount', key: 'amount' },
  { header: 'Status', key: 'status' },
];

const LOAN_RECORDS = LOANS.map(([applicant, , amount, , , status], i) => ({
  _row: String(i + 1),
  applicant,
  amount,
  status,
}));

/** `#RadGrid2`: the non-scrolling form — ONE table with the same three header
 *  rows and the pager in a `<tfoot>`. */
const RADGRID2_HTML = `
<h2>Direct debit mandates</h2>
<div id="RadGrid2" class="RadGrid RadGrid_Silk rgMultiHeader">
  <table id="RadGrid2_ctl00" class="rgMasterTable" role="grid"
         aria-owns="RadGrid2_ctl00_thead RadGrid2_ctl00_tbody ">
    <thead id="RadGrid2_ctl00_thead">
      <tr class="rgMultiHeaderRow">
        <th colspan="2">MANDATE</th><th colspan="2">PAYMENT</th><th colspan="2">STATE</th>
      </tr>
      <tr class="rgMultiHeaderRow">
        <th>Payee</th><th>Reference</th><th>Amount</th><th>Frequency</th>
        <th>Next date</th><th>Status</th>
      </tr>
      <tr class="rgFilterRow"><td></td><td></td><td></td><td></td><td></td><td><input aria-label="Filter Status"></td></tr>
    </thead>
    <tbody id="RadGrid2_ctl00_tbody">
      <tr class="rgRow"><td>Origin Energy</td><td>DD-1</td><td>$140.00</td><td>Monthly</td><td>3 Oct 2026</td><td>Active</td></tr>
      <tr class="rgAltRow"><td>Netflix Australia</td><td>DD-2</td><td>$22.99</td><td>Monthly</td><td>1 Oct 2026</td><td>Active</td></tr>
    </tbody>
    <tfoot><tr class="rgPager"><td colspan="6"><a href="#">1</a></td></tr></tfoot>
  </table>
</div>`;

/** `#banded-table`, the Quarterly fees table: the same leaf name under two
 *  bands (§5.3's last paragraph). */
const QUARTERLY_FEES_HTML = `
<table id="banded-table" aria-label="Quarterly fees">
  <thead>
    <tr><th rowspan="2">Account</th><th colspan="2">Q1</th><th colspan="2">Q2</th></tr>
    <tr><th>Fee</th><th>Rebate</th><th>Fee</th><th>Rebate</th></tr>
  </thead>
  <tbody>
    <tr><td>Everyday</td><td>$4.00</td><td>$1.00</td><td>$4.50</td><td>$1.50</td></tr>
    <tr><td>Savings</td><td>$0.00</td><td>$0.00</td><td>$0.00</td><td>$0.00</td></tr>
  </tbody>
</table>`;

describe('readTable — Telerik RadGrid (§5.7)', () => {
  it('gives the same ten records through the box, the data table and by position', async () => {
    await load(radgrid());
    const viaBox = await readTableRecords(page, { selector: '#RadGrid1', columns: LOAN_COLUMNS });
    expect(viaBox.records).toHaveLength(10);
    expect(viaBox.records).toEqual(LOAN_RECORDS);
    // The two rows for the same applicant are both there, with their own
    // amounts and their own numbers — which is what `_row` is for (§4.5).
    expect(viaBox.records.filter((r) => r.applicant === 'Sarah Mitchell')).toEqual([
      { _row: '1', applicant: 'Sarah Mitchell', amount: '$420,000.00', status: 'Approved' },
      { _row: '2', applicant: 'Sarah Mitchell', amount: '$32,500.00', status: 'Pending' },
    ]);
    // The spacer row in the header table and the pager row count for nothing:
    // counted as rows, the box was "found 3 tables with rows" and counted as
    // data they would be records of their own.
    expect(viaBox.placeholdersSkipped).toBe(0);
    expect(viaBox.headerFromSeparateTable).toBe(true);
    expect(viaBox.label).toBe('RadGrid1');

    // The row table's own `aria-owns` — with the TRAILING SPACE RadGrid emits,
    // which a split on whitespace has to ignore rather than look up as an id.
    expect(await page.locator('#RadGrid1_ctl00').getAttribute('aria-owns'))
      .toBe('RadGrid1_ctl00_Header_thead RadGrid1_ctl00_tbody ');
    const viaTable = await readTableRecords(page, {
      selector: '#RadGrid1_ctl00',
      columns: LOAN_COLUMNS,
    });
    expect(viaTable.records).toEqual(LOAN_RECORDS);
    expect(viaTable.headerFromSeparateTable).toBe(true);

    // And by position, which is what the data table could already do: column 2
    // is Applicant because column 1 is the expand cell.
    const byIndex = await readTableRecords(page, {
      selector: '#RadGrid1_ctl00',
      columns: [{ index: 2, key: 'applicant' }, { index: 4, key: 'amount' }],
    });
    expect(byIndex.records.map((r) => r.applicant)).toEqual(LOANS.map(([a]) => a));
    expect(byIndex.records[0]).toEqual({ _row: '1', applicant: 'Sarah Mitchell', amount: '$420,000.00' });
  });

  it('refuses the header table and names the box (§7.3a.3)', async () => {
    // The selector a model reaches for first — the table where it can SEE the
    // words "Applicant" and "Status". Its hidden spacer row is a message, so
    // it is still header-only and still refused, rather than storing [] green.
    await load(radgrid());
    expect(await refusal({ selector: '#RadGrid1_ctl00_Header', columns: LOAN_COLUMNS }))
      .toBe(
        'readTable cannot read table "RadGrid1": it holds only the header row; the rows are in '
        + 'the table beside it — select the element that contains both ("#RadGrid1") or that table',
      );
  });

  it('still pairs the halves with no aria-owns, past the hidden spacer row', async () => {
    // §7.3a.2 with RadGrid's shape: "header-only" has to mean no DATA row, not
    // no row at all, because the header table's body holds one hidden
    // `<td colspan="9">` spacer. Counted as a row, this table is not a header
    // half at all, the beside search finds no candidate and the grid reads as
    // headerless — the §5.4 message for every column the author named.
    await load(radgrid('', false));
    expect(await page.locator('#RadGrid1_ctl00').getAttribute('aria-owns')).toBeNull();
    expect(await page.locator('#RadGrid1_ctl00_Header tbody tr').count()).toBe(1);
    for (const selector of ['#RadGrid1', '#RadGrid1_ctl00']) {
      const result = await readTableRecords(page, { selector, columns: LOAN_COLUMNS });
      expect(result.records).toEqual(LOAN_RECORDS);
      expect(result.headerFromSeparateTable).toBe(true);
    }
  });

  it('reads the pager table as an empty table, not as a row of anything', async () => {
    await load(radgrid());
    const pager = await readTableRecords(page, {
      selector: '#RadGrid1_ctl00_Pager',
      columns: [{ index: 1, key: 'page' }],
    });
    expect(pager.records).toEqual([]);
    expect(pager.placeholdersSkipped).toBe(1);
  });

  it('skips an expanded DETAIL row and does not read its nested table (§7.4)', async () => {
    // Measured: expanding a row inserts a row with no class and no id, of TWO
    // cells — the expand column's own, and one spanning the other eight around
    // a whole table of its own. Neither lone-cell rule sees it, so before this
    // rule every read of the grid failed with the merged-cell refusal from the
    // moment a user expanded anything. It is a message row: no `_row`, counted
    // as a skip, and its nested rows belong to that table and not to this one.
    await load(radgrid(`
        <tr role="row"><td class="rgExpandCol">&nbsp;</td><td colspan="8">
          <table class="loanInfo"><tbody>
            <tr><td>Deposit:</td><td>$84,000.00</td></tr>
            <tr><td>Lodged:</td><td>2026-02-11</td></tr>
          </tbody></table>
        </td></tr>`));
    const outcome = await readTableRecords(page, { selector: '#RadGrid1', columns: LOAN_COLUMNS });
    expect(outcome.records).toEqual(LOAN_RECORDS);
    expect(outcome.placeholdersSkipped).toBe(1);
    expect(JSON.stringify(outcome.records)).not.toContain('2026-02-11');
    // Through the data table's own selector too — the skip is §7.4's, not the
    // wrapper path's.
    expect((await readTableRecords(page, {
      selector: '#RadGrid1_ctl00',
      columns: LOAN_COLUMNS,
    })).records).toEqual(LOAN_RECORDS);
  });

  it('keeps refusing the two rows that only LOOK like a detail row (§7.4)', async () => {
    // The line is drawn by what the cells cover, and both neighbours of the
    // detail row are refusals a skip would turn into a silent misread.
    //
    // A cell spanning ROWS shifts every row below it, so skipping this one
    // fixes nothing about the next.
    await load(radgrid(`
        <tr role="row"><td class="rgExpandCol" rowspan="2">&nbsp;</td><td colspan="8">Detail</td></tr>`));
    expect(await refusal({ selector: '#RadGrid1', columns: LOAN_COLUMNS }))
      .toBe('readTable cannot map table "RadGrid1": merged headers or cells (rowspan/colspan > 1) are not supported');

    // And a row with as many cells as the grid is wide, one of which spans, is
    // WIDER than the grid — a merged data row, not a message.
    await load(radgrid(`
        <tr role="row"><td>&nbsp;</td><td colspan="2">Merged</td><td>c</td><td>d</td><td>e</td><td>f</td><td>g</td><td>h</td><td>i</td></tr>`));
    expect(await refusal({ selector: '#RadGrid1', columns: LOAN_COLUMNS }))
      .toBe('readTable cannot map table "RadGrid1": merged headers or cells (rowspan/colspan > 1) are not supported');
  });

  it('reads the EMPTIED box as [], instead of "3 tables with rows" (§7.2, §5.7)', async () => {
    // The measured refusal, with the loan rows replaced by §4.8's message
    // row: nothing under the box has a DATA row, so the fallback counts body
    // rows — and the header table's hidden `<td colspan="9">` spacer and the
    // pager's own row are two of the three it found. `aria-owns` says which
    // table is the row half, so the read answers [] for a grid that has no
    // rows, and the column names still resolve against the header table.
    await load(EMPTY_RADGRID);
    const result = await readTableRecords(page, {
      selector: '#RadGrid1',
      columns: LOAN_COLUMNS,
    });
    expect(result.records).toEqual([]);
    expect(result.placeholdersSkipped).toBe(1);
    expect(result.headerFromSeparateTable).toBe(true);
    // The header really is the one the box shows, not an empty stand-in.
    expect(await refusal({ selector: '#RadGrid1', columns: [{ header: 'Borrower', key: 'x' }] }))
      .toBe(
        'readTable cannot map table "RadGrid1": no column is headed "Borrower" — available '
        + 'headers are ExpandColumn, APPLICANT, TYPE, AMOUNT, TERM, RATE, STATUS, OFFICER, ACTION',
      );
    // The data table's own selector answers the same, so the fallback is not
    // a wrapper-only rule.
    expect((await readTableRecords(page, {
      selector: '#RadGrid1_ctl00',
      columns: LOAN_COLUMNS,
    })).records).toEqual([]);
  });

  it('refuses a row ONE cell short of the width, and skips one TWO short (§7.4)', async () => {
    // Where the detail-row skip stops. `<td>a2</td><td colspan="2">merged</td>`
    // in a three-column table is §10's merged DATA row — two values where
    // three columns are, and which of B and C the wide cell holds is exactly
    // the guess this action exists not to make. Skipped as a detail row, that
    // row vanished from the read and the count came back one short, green.
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
        <tbody>
          <tr><td>a1</td><td>b1</td><td>c1</td></tr>
          <tr><td>a2</td><td colspan="2">merged</td></tr>
        </tbody>
      </table>`);
    expect(await refusal({
      selector: '#t',
      columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }],
    })).toBe(
      'readTable cannot map table "Orders": merged headers or cells (rowspan/colspan > 1) are '
      + 'not supported',
    );

    // A detail row is a row of a different SHAPE, not a row missing one cell:
    // RadGrid's is 2 cells where the grid is 9 wide and Kendo's 2 where it is
    // 6, so the line is `width - cells.length >= 2`.
    await load(`
      <table id="t2" aria-label="Loans">
        <thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead>
        <tbody>
          <tr><td>a1</td><td>b1</td><td>c1</td><td>d1</td></tr>
          <tr><td>&nbsp;</td><td colspan="3">Deposit: $84,000.00</td></tr>
        </tbody>
      </table>`);
    const detail = await readTableRecords(page, {
      selector: '#t2',
      columns: [{ header: 'A', key: 'a' }],
    });
    expect(detail.records).toEqual([{ _row: '1', a: 'a1' }]);
    expect(detail.placeholdersSkipped).toBe(1);
  });

  it('names the expand column by its visually-hidden text, and the leaf beats the band', async () => {
    // Two measured details of the same header. The expand `<th>` renders
    // nothing but carries `<span style="display:none">ExpandColumn</span>`, so
    // §7.3's `textContent` fallback names column 1 — which is what an
    // accessible name is for, and it is what the available-headers list shows.
    //
    // And "APPLICANT" is both the BAND over columns 2–3 and, once the header
    // style has upper-cased it, column 2's own leaf. A request for it must
    // match the LEAF: bands are consulted only when no leaf does, so this is
    // one column, not the band refusal.
    await load(radgrid());
    expect((await readTableRecords(page, {
      selector: '#RadGrid1',
      columns: [{ header: 'Applicant', key: 'applicant' }],
    })).records.map((r) => r.applicant)).toEqual(LOANS.map(([a]) => a));

    expect(await refusal({ selector: '#RadGrid1', columns: [{ header: 'Borrower', key: 'x' }] }))
      .toBe(
        'readTable cannot map table "RadGrid1": no column is headed "Borrower" — available '
        + 'headers are ExpandColumn, APPLICANT, TYPE, AMOUNT, TERM, RATE, STATUS, OFFICER, ACTION',
      );
    // The band above the leaves is still a band, and says what is under it.
    expect(await refusal({ selector: '#RadGrid1', columns: [{ header: 'LOAN', key: 'loan' }] }))
      .toBe(
        'readTable cannot map table "RadGrid1": no column is headed "LOAN" — available headers '
        + 'are ExpandColumn, APPLICANT, TYPE, AMOUNT, TERM, RATE, STATUS, OFFICER, ACTION '
        + '("LOAN" is a band over AMOUNT, TERM, RATE, not a column)',
      );
  });

  it('sees the hidden spacer row and the empty header row as unrendered', async () => {
    // Both are hidden by `display:none` on the `<tbody>`/`<thead>` ELEMENT,
    // not on the `<tr>`, which is how RadGrid writes them: a row-level test
    // would have called them rendered, made the spacer a data row of the
    // header table and the empty `<th>` row a header that names nothing.
    await load(radgrid());
    expect(await page.locator('#RadGrid1_ctl00_Header tbody tr').isVisible()).toBe(false);
    expect(await page.locator('#RadGrid1_ctl00 thead tr').isVisible()).toBe(false);
  });

  it('reads the non-scrolling form as one table, with no pairing and no <tfoot>', async () => {
    await load(RADGRID2_HTML);
    const result = await readTableRecords(page, {
      selector: '#RadGrid2_ctl00',
      columns: [
        { header: 'Payee', key: 'payee' },
        { header: 'Amount', key: 'amount' },
        { header: 'Status', key: 'status' },
      ],
    });
    expect(result.records).toEqual([
      { _row: '1', payee: 'Origin Energy', amount: '$140.00', status: 'Active' },
      { _row: '2', payee: 'Netflix Australia', amount: '$22.99', status: 'Active' },
    ]);
    // Its header is its own, so nothing was adopted — and the `<tfoot>` pager
    // is excluded as a footer always is (§7.4). The `aria-owns` this form
    // carries names its OWN `<thead>` and `<tbody>`, which declares nothing:
    // an owned element inside the same table is not another table's header.
    expect(await page.locator('#RadGrid2_ctl00').getAttribute('aria-owns'))
      .toBe('RadGrid2_ctl00_thead RadGrid2_ctl00_tbody ');
    expect(result.headerFromSeparateTable).toBe(false);
    expect(result.placeholdersSkipped).toBe(0);
    // The box around it answers the same, through the one table with data.
    expect((await readTableRecords(page, {
      selector: '#RadGrid2',
      columns: [{ header: 'Payee', key: 'payee' }],
    })).records).toEqual([
      { _row: '1', payee: 'Origin Energy' },
      { _row: '2', payee: 'Netflix Australia' },
    ]);
  });
});

// ── the numbering the read leaves on the page (§4.5) ───────────────────────
//
// Measured on the live acceptance run: pass 7 of the loop over the RadGrid
// records reached "Click Review in row 7 of the Loan applications grid", the
// model counted the rows itself and emitted `#RadGrid1_ctl00__7` — ids that
// run from ZERO — so it clicked row 8, Grace Abernathy, and the step passed.
// The read now stamps its own numbering onto the rows it numbered, so "row 7"
// is a selector rather than a sum.

/** Every `<tr>` of a table, paired with its stamp (`null` when it has none). */
async function stamps(selector: string): Promise<Array<[string, string | null]>> {
  return page.locator(`${selector} tr`).evaluateAll((rows) =>
    rows.map((row) => [
      (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      row.getAttribute('data-aiui-row'),
    ] as [string, string | null]));
}

describe('readTable — data-aiui-row, the numbering left on the page', () => {
  it('stamps the data rows 1..N and nothing else', async () => {
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>Order ID</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>O-1</td><td>Paid</td></tr>
          <tr class="row-hidden"><td>O-H</td><td>Hidden</td></tr>
          <tr><td colspan="2">No more orders today.</td></tr>
          <tr><td>O-2</td><td>Due</td></tr>
        </tbody>
      </table>`);
    const result = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'Order ID', key: 'id' }],
    });
    expect(result.records).toEqual([{ _row: '1', id: 'O-1' }, { _row: '2', id: 'O-2' }]);
    // The header row, the hidden row and the message row take no number, and
    // the numbers the data rows carry are the `_row` of their own record.
    expect(await stamps('#t')).toEqual([
      ['Order IDStatus', null],
      ['O-1Paid', '1'],
      ['O-HHidden', null],
      ['No more orders today.', null],
      ['O-2Due', '2'],
    ]);
  });

  it('renumbers on a re-read and clears a row a filter has hidden', async () => {
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>Order ID</th></tr></thead>
        <tbody>
          <tr id="r1"><td>O-1</td></tr>
          <tr id="r2"><td>O-2</td></tr>
          <tr id="r3"><td>O-3</td></tr>
        </tbody>
      </table>`);
    const columns: TableReadColumn[] = [{ header: 'Order ID', key: 'id' }];
    await readTableRecords(page, { selector: '#t', columns });
    expect((await stamps('#t')).map(([, n]) => n)).toEqual([null, '1', '2', '3']);

    // A filter hides the first row. The second read must renumber the rest AND
    // take the stale number off the hidden one — left there, "row 1" would
    // address a row no record came from.
    await page.locator('#r1').evaluate((el) => el.classList.add('row-hidden'));
    const after = await readTableRecords(page, { selector: '#t', columns });
    expect(after.records).toEqual([{ _row: '1', id: 'O-2' }, { _row: '2', id: 'O-3' }]);
    expect(await stamps('#t')).toEqual([
      ['Order ID', null],
      ['O-1', null],
      ['O-2', '1'],
      ['O-3', '2'],
    ]);
  });

  it('numbers ALL the data rows, not just the ones a limit selected', async () => {
    // The numbering describes the table; a bounded read must not leave the
    // rows past the bound unaddressable.
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>Order ID</th></tr></thead>
        <tbody><tr><td>O-1</td></tr><tr><td>O-2</td></tr><tr><td>O-3</td></tr></tbody>
      </table>`);
    const result = await readTableRecords(page, {
      selector: '#t',
      columns: [{ header: 'Order ID', key: 'id' }],
      limit: 2,
    });
    expect(result.records).toHaveLength(2);
    expect((await stamps('#t')).map(([, n]) => n)).toEqual([null, '1', '2', '3']);
  });

  it('leaves NO stamp behind when the read REFUSES (§7.4)', async () => {
    // The numbering is written LAST, after the row cap and after every cell of
    // every selected row has been read. Written before that, a read that went
    // on to refuse still numbered the rows, and the next step addressed rows
    // of a table the framework had just said it could not map — a click that
    // lands somewhere and a step that passes.
    await load(`
      <table id="t" aria-label="Orders">
        <thead><tr><th>Order ID</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>O-1</td><td>Paid</td></tr>
          <tr><td rowspan="2">O-2</td><td>Due</td></tr>
          <tr><td>Overdue</td></tr>
        </tbody>
      </table>`);
    expect(await refusal({ selector: '#t', columns: [{ header: 'Order ID', key: 'id' }] }))
      .toContain('merged headers or cells');
    expect(await page.locator('#t [data-aiui-row]').count()).toBe(0);
  });

  it('clears a stale stamp inside a NESTED table, and nothing outside this one', async () => {
    // The clear runs over every descendant carrying the stamp, not over
    // `table.rows` — a nested table's rows are not in `table.rows` at all, so
    // a stamp an earlier read of THAT table left behind survived, and
    // `#outer [data-aiui-row="2"]` matched the nested row as well as the real
    // one. "Row 2 of the Outer table" was then two elements.
    await load(`
      <table id="outer" aria-label="Outer">
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody>
          <tr><td>a1</td><td>
            <table id="inner" aria-label="Inner">
              <thead><tr><th>X</th></tr></thead>
              <tbody><tr><td>x1</td></tr><tr><td>x2</td></tr></tbody>
            </table>
          </td></tr>
          <tr><td>a2</td><td>b2</td></tr>
        </tbody>
      </table>
      <table id="other" aria-label="Other">
        <thead><tr><th>A</th></tr></thead><tbody><tr><td>z1</td></tr></tbody>
      </table>`);
    await readTableRecords(page, { selector: '#inner', columns: [{ header: 'X', key: 'x' }] });
    await readTableRecords(page, { selector: '#other', columns: [{ header: 'A', key: 'a' }] });
    expect(await page.locator('#inner [data-aiui-row]').count()).toBe(2);

    await readTableRecords(page, { selector: '#outer', columns: [{ header: 'A', key: 'a' }] });
    expect(await page.locator('#inner [data-aiui-row]').count()).toBe(0);
    expect(await page.locator('#outer [data-aiui-row="2"]').count()).toBe(1);
    expect(await page.locator('#outer [data-aiui-row="2"] td').first().innerText()).toBe('a2');
    // A table that was not read keeps its own numbering: the clear is scoped
    // to the table being read and reaches nothing above or beside it.
    expect(await page.locator('#other [data-aiui-row]').count()).toBe(1);
  });

  it('numbers the RadGrid rows so __7 is row 8, detail row and all (§5.7)', async () => {
    // The measured failure, in the markup it happened in: the row the model
    // built `#RadGrid1_ctl00__7` for is row EIGHT, and it now says so itself.
    await load(radgrid());
    await readTableRecords(page, { selector: '#RadGrid1', columns: LOAN_COLUMNS });
    expect(await page.locator('#RadGrid1_ctl00__7').getAttribute('data-aiui-row')).toBe('8');
    expect(await page.locator('#RadGrid1_ctl00__0').getAttribute('data-aiui-row')).toBe('1');
    // Nothing outside the table that was read, including the two tables in the
    // same box: the header table's spacer row and the pager's row.
    expect((await stamps('#RadGrid1_ctl00_Header')).map(([, n]) => n)).toEqual([null, null, null, null]);
    expect((await stamps('#RadGrid1_ctl00_Pager')).map(([, n]) => n)).toEqual([null, null]);

    // An expanded detail row takes no number and shifts none: the rows below
    // it keep the numbers their records carry.
    await load(radgrid(`
        <tr role="row"><td class="rgExpandCol">&nbsp;</td><td colspan="8">Detail</td></tr>`));
    const expanded = await readTableRecords(page, { selector: '#RadGrid1', columns: LOAN_COLUMNS });
    expect(expanded.records).toEqual(LOAN_RECORDS);
    expect(await page.locator('#RadGrid1_ctl00__7').getAttribute('data-aiui-row')).toBe('8');
    expect(await page.locator('#RadGrid1_ctl00 tbody tr:not([id])').getAttribute('data-aiui-row'))
      .toBeNull();
  });
});

// ── the run-log summary line (§7.6) ─────────────────────────────────────────
//
// Counts, not contents: the captured cells belong in the variable and the
// report, not in every console the run passes through. The bound and the
// placeholder-skip count ride along because without them a short result has no
// explanation in the log.

describe('formatTableReadSummary', () => {
  const result = (records: number, placeholdersSkipped = 0, headerFromSeparateTable = false) => ({
    records: Array.from({ length: records }, (_, i) => ({ _row: String(i + 1) })),
    placeholdersSkipped,
    dataRowCount: records,
    label: 'Orders',
    headerFromSeparateTable,
  });

  it('says how many rows by how many columns, under the variable name', () => {
    expect(formatTableReadSummary(result(2), 3, 'orders', undefined))
      .toBe('readTable captured 2 rows × 3 columns as "{{orders}}"');
  });

  it('includes the requested bound, so a short table is observable', () => {
    expect(formatTableReadSummary(result(7), 1, 'orders', 10))
      .toBe('readTable captured 7 rows × 1 column as "{{orders}}" (limit 10)');
  });

  it('says how many placeholder rows were skipped, so 0 rows explains itself', () => {
    expect(formatTableReadSummary(result(0, 1), 2, 'docs', undefined))
      .toBe('readTable captured 0 rows × 2 columns as "{{docs}}" (1 placeholder row skipped)');
    expect(formatTableReadSummary(result(1, 3), 2, 'docs', undefined))
      .toBe('readTable captured 1 row × 2 columns as "{{docs}}" (3 placeholder rows skipped)');
  });

  it('carries both notes at once, and names an unnamed capture', () => {
    expect(formatTableReadSummary(result(1, 2), 1, undefined, 5))
      .toBe('readTable captured 1 row × 1 column as "{{(unnamed)}}" (limit 5, 2 placeholder rows skipped)');
  });

  it('says when the header came from a separate table (§7.3a), beside the other notes', () => {
    // §7.6 verbatim. A grid whose header was paired with the wrong rows
    // returns records that look exactly like a correct read, so this note is
    // the only place the pairing shows up at all.
    expect(formatTableReadSummary(result(6, 0, true), 3, 'holdings', undefined))
      .toBe('readTable captured 6 rows × 3 columns as "{{holdings}}" (header from a separate table)');
    expect(formatTableReadSummary(result(2, 1, true), 3, 'holdings', 5))
      .toBe('readTable captured 2 rows × 3 columns as "{{holdings}}" (limit 5, 1 placeholder row skipped, header from a separate table)');
  });
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
        columns: [{ header: '{{column_name}}', key: 'the_{{column_name}}_cell' }],
        as: 'rows',
        description: 'Read a column',
      };
      await cache.write(1, [{ rawResponse: '{}', actions: [action], reasoning: '' }], {});
      const replayed = (await cache.read(1, { column_name: 'Status' }))![0]!.actions[0]!;
      expect(replayed.columns?.[0]?.header).toBe('Status');
      // `key` is a definition, not a reference — it names the property later
      // steps read, and must survive interpolation untouched (§9.1). The key
      // carries a placeholder of its own precisely so this cannot pass by
      // identity: a substitution that walked it would make it `the_Status_cell`.
      expect(replayed.columns?.[0]?.key).toBe('the_{{column_name}}_cell');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
