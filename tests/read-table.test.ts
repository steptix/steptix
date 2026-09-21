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

// ── the run-log summary line (§7.6) ─────────────────────────────────────────
//
// Counts, not contents: the captured cells belong in the variable and the
// report, not in every console the run passes through. The bound and the
// placeholder-skip count ride along because without them a short result has no
// explanation in the log.

describe('formatTableReadSummary', () => {
  const result = (records: number, placeholdersSkipped = 0) => ({
    records: Array.from({ length: records }, (_, i) => ({ _row: String(i + 1) })),
    placeholdersSkipped,
    dataRowCount: records,
    label: 'Orders',
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
