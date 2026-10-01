/**
 * §7.9's ARIA table model, over a real Playwright page
 * (docs/specs/SPEC-structured-table-reads.md §5.8, §7.9, §10, §12 item 29).
 *
 * The fixtures are inline copies of the shapes in
 * `scratchpad/aria-grid-markup.txt`: MUI DataGrid as measured on
 * mui.com/x/react-data-grid on 2026-09-23, and ag-Grid as its documentation
 * describes it. Inline for the reason `read-table.test.ts` gives — nothing in
 * the fast suite drives the fixture app over HTTP, and a unit test that needs
 * a listening server fails for reasons that have nothing to do with the code
 * it covers.
 *
 * Everything goes through `executeAction` where the outcome is a refusal: a
 * message is only useful if it survives the action layer with its text
 * intact, which is what the model and the report see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction, readTableRecords } from '../src/browser/actions.js';
import type { AIAction, TableReadColumn } from '../src/ai/types.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
}, 60_000);

async function load(bodyHtml: string): Promise<void> {
  await page.setContent(`<html><body>${bodyHtml}</body></html>`);
}

function run(action: Partial<AIAction> & { selector: string; columns: TableReadColumn[] }) {
  return executeAction(page, {
    action: 'readTable',
    as: 'rows',
    description: 'Read the grid',
    ...action,
  } as AIAction);
}

async function refusal(
  action: Partial<AIAction> & { selector: string; columns: TableReadColumn[] },
): Promise<string> {
  const result = await run(action);
  expect(result.success, `expected a refusal, got ${JSON.stringify(result.capturedRecords)}`)
    .toBe(false);
  return result.error ?? '';
}

// ── §5.8: MUI DataGrid, as measured ─────────────────────────────────────────

/**
 * The measured MUI shape: a `role="none"` filler FIRST in every row, a blank
 * `columnheader` for the checkbox column at `aria-colindex="1"`, and
 * `aria-rowindex` counting the header as 1.
 */
const MUI_ROWS = [
  ['1', 'Jon', 'Snow'],
  ['2', 'Cersei', 'Lannister'],
  ['3', 'Jaime', 'Lannister'],
];

function muiGrid(extraRows = ''): string {
  const body = MUI_ROWS.map(([id, first, last], i) => `
      <div role="row" aria-rowindex="${i + 2}" class="MuiDataGrid-row">
        <div role="none"></div>
        <div role="gridcell" aria-colindex="1" aria-colspan="1"></div>
        <div role="gridcell" aria-colindex="2" aria-colspan="1">${id}</div>
        <div role="gridcell" aria-colindex="3" aria-colspan="1">${first}</div>
        <div role="gridcell" aria-colindex="4" aria-colspan="1">${last}</div>
      </div>`).join('');
  return `
<div role="grid" id="mui" class="MuiDataGrid-main" aria-rowcount="10" aria-colcount="4"
     aria-label="People">
  <div role="presentation" class="MuiDataGrid-virtualScroller">
    <div role="presentation" class="MuiDataGrid-virtualScrollerContent">
      <div role="row" aria-rowindex="1" class="MuiDataGrid-row--borderBottom">
        <div role="none"></div>
        <div role="columnheader" aria-colindex="1"></div>
        <div role="columnheader" aria-colindex="2">ID</div>
        <div role="columnheader" aria-colindex="3">First name</div>
        <div role="columnheader" aria-colindex="4">Last name</div>
      </div>
      <div role="rowgroup">${body}${extraRows}</div>
    </div>
  </div>
</div>`;
}

const MUI_COLUMNS: TableReadColumn[] = [
  { header: 'ID', key: 'id' },
  { header: 'First name', key: 'first' },
  { header: 'Last name', key: 'last' },
];

describe('readTable — MUI DataGrid (§5.8, §7.9)', () => {
  it('reads a div grid by header name, ordering cells by aria-colindex', async () => {
    await load(muiGrid());
    const result = await run({ selector: '#mui', columns: MUI_COLUMNS });
    expect(result.success).toBe(true);
    // The `role="none"` filler is FIRST in every row and occupies no column:
    // counted as a cell it takes position 1, the blank checkbox header is
    // dropped as already-taken, and every value shifts one column left.
    expect(result.capturedRecords).toEqual([
      { _row: '1', id: '1', first: 'Jon', last: 'Snow' },
      { _row: '2', id: '2', first: 'Cersei', last: 'Lannister' },
      { _row: '3', id: '3', first: 'Jaime', last: 'Lannister' },
    ]);
  });

  it('numbers rows by position, not by aria-rowindex', async () => {
    // MUI's `aria-rowindex` counts the header (header = 1, first data row = 2)
    // and, in a virtualised grid, rows that are not in the DOM. `_row` is the
    // position among the data rows that ARE there (§7.9, §4.5): read from
    // `aria-rowindex` the records above would be numbered 2, 3, 4 and every
    // `{{item._row}}` selector would address the row below the one meant.
    await load(muiGrid());
    const result = await readTableRecords(page, { selector: '#mui', columns: MUI_COLUMNS });
    expect(result.records.map((r) => r['_row'])).toEqual(['1', '2', '3']);
    expect(result.dataRowCount).toBe(3);
  });

  it('names the grid by its aria-label in a refusal', async () => {
    // §7.9's label chain: `aria-label`, then `aria-labelledby`, then the id,
    // then the selector. Without it the sentence reads `cannot map table
    // "#mui"` — the selector, not the grid.
    await load(muiGrid());
    expect(await refusal({ selector: '#mui', columns: [{ header: 'Nickname', key: 'n' }] }))
      .toBe(
        'readTable cannot map table "People": no column is headed "Nickname" — available headers '
        + 'are ID, First name, Last name',
      );
  });

  it('falls back to aria-labelledby, then the id', async () => {
    await load(`
      <h2 id="grid-title">Open orders</h2>
      <div role="grid" id="labelled" aria-labelledby="grid-title">
        <div role="row"><div role="columnheader">Ref</div></div>
        <div role="row"><div role="gridcell">O-1</div></div>
      </div>
      <div role="grid" id="bare-grid">
        <div role="row"><div role="columnheader">Ref</div></div>
        <div role="row"><div role="gridcell">O-2</div></div>
      </div>`);
    expect(await refusal({ selector: '#labelled', columns: [{ header: 'Nope', key: 'n' }] }))
      .toContain('cannot map table "Open orders"');
    expect(await refusal({ selector: '#bare-grid', columns: [{ header: 'Nope', key: 'n' }] }))
      .toContain('cannot map table "bare-grid"');
  });

  it('excludes a hidden row and does not let it consume a _row', async () => {
    await load(muiGrid(`
      <div role="row" aria-rowindex="5" style="display:none">
        <div role="none"></div>
        <div role="gridcell" aria-colindex="1"></div>
        <div role="gridcell" aria-colindex="2">4</div>
        <div role="gridcell" aria-colindex="3">Arya</div>
        <div role="gridcell" aria-colindex="4">Stark</div>
      </div>`));
    const result = await readTableRecords(page, { selector: '#mui', columns: MUI_COLUMNS });
    expect(result.records.map((r) => r['first'])).toEqual(['Jon', 'Cersei', 'Jaime']);
    expect(result.dataRowCount).toBe(3);
  });

  it('skips a row with no cells and counts it as a placeholder', async () => {
    // §7.9, as for a `<tr>`: there is nothing in it to map and nothing to
    // number, and failing a whole read over a row that renders as nothing
    // would contradict §4.8. The COUNT is what keeps the skip visible in the
    // log (§7.6).
    await load(muiGrid('<div role="row" aria-rowindex="9" style="height:6px"></div>'));
    const result = await readTableRecords(page, { selector: '#mui', columns: MUI_COLUMNS });
    expect(result.records).toHaveLength(3);
    expect(result.placeholdersSkipped).toBe(1);
  });

  it('stamps data-steptix-row on the grid rows it numbered', async () => {
    // §7.4's stamp, on an ARIA grid: "row 2 of the People grid" has to be a
    // selector rather than a sum, and a grid's rows carry no number of their
    // own that means what `_row` means (`aria-rowindex` counts the header).
    await load(muiGrid());
    await readTableRecords(page, { selector: '#mui', columns: MUI_COLUMNS });
    const stamped = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mui [data-steptix-row]')).map((e) => ({
        n: e.getAttribute('data-steptix-row'),
        text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      })));
    expect(stamped.map((s) => s.n)).toEqual(['1', '2', '3']);
    expect(stamped[1]?.text).toContain('Cersei');
    // Never the header row.
    const headerStamped = await page.evaluate(() =>
      document.querySelector('[aria-rowindex="1"]')?.hasAttribute('data-steptix-row'));
    expect(headerStamped).toBe(false);
  });

  it('skips role="none"/"presentation" and role-less children wherever they sit', async () => {
    // In the measured MUI shape the filler is first in EVERY row, header and
    // data alike, so counting it shifts both sides equally and nothing shows.
    // It bites where the two rows differ — a per-row drag handle the header
    // has no counterpart for, which is how a reorderable grid is built — and
    // then every value is read one column to the left.
    await load(`
      <div role="grid" id="reorder" aria-label="Reorderable">
        <div role="row">
          <div role="columnheader">Account</div>
          <div role="columnheader">Balance</div>
        </div>
        <div role="row">
          <div role="presentation" class="handle">⋮</div>
          <div role="gridcell">Everyday</div>
          <div role="gridcell">$2,340.10</div>
        </div>
        <div role="row">
          <div class="handle-no-role">⋮</div>
          <div role="gridcell">Savings</div>
          <div role="gridcell">$18,004.22</div>
        </div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#reorder',
      columns: [{ header: 'Account', key: 'account' }, { header: 'Balance', key: 'balance' }],
    });
    expect(result.records).toEqual([
      { _row: '1', account: 'Everyday', balance: '$2,340.10' },
      { _row: '2', account: 'Savings', balance: '$18,004.22' },
    ]);
  });

  it('holds a column-virtualised grid\'s gaps open with aria-colindex', async () => {
    // ag-Grid virtualises columns as well as rows: only the ones on screen
    // are in the DOM, and `aria-colindex` stays ABSOLUTE across the gap. Laid
    // out by order instead of by the index each cell declares, the header is
    // three columns wide, "Country" lands on column 3, and the data row —
    // whose cells are at 1, 2 and 4 — has nothing there, so a grid that is
    // simply scrolled sideways fails as a short row.
    await load(`
      <div role="grid" id="virt" aria-colcount="4" aria-label="Athletes">
        <div role="row" aria-rowindex="1">
          <div role="columnheader" aria-colindex="1">Athlete</div>
          <div role="columnheader" aria-colindex="2">Age</div>
          <div role="columnheader" aria-colindex="4">Country</div>
        </div>
        <div role="row" aria-rowindex="2">
          <div role="gridcell" aria-colindex="1">Michael Phelps</div>
          <div role="gridcell" aria-colindex="2">23</div>
          <div role="gridcell" aria-colindex="4">United States</div>
        </div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#virt',
      columns: [{ header: 'Athlete', key: 'athlete' }, { header: 'Country', key: 'country' }],
    });
    expect(result.records).toEqual([
      { _row: '1', athlete: 'Michael Phelps', country: 'United States' },
    ]);
  });

  it('does not read a nested grid\'s rows as its own', async () => {
    // §7.9: a row belongs to its NEAREST grid/table ancestor. Read without
    // that test the inner grid's rows join the outer grid's, and the read
    // returns four records for a two-row grid — one of them from a different
    // table altogether.
    await load(`
      <div role="grid" id="outer" aria-label="Outer">
        <div role="row"><div role="columnheader">Name</div><div role="columnheader">Detail</div></div>
        <div role="row">
          <div role="gridcell">Alice</div>
          <div role="gridcell">
            <div role="grid" aria-label="Inner">
              <div role="row"><div role="columnheader">Item</div></div>
              <div role="row"><div role="gridcell">Widget</div></div>
            </div>
          </div>
        </div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#outer',
      columns: [{ header: 'Name', key: 'name' }],
    });
    expect(result.records).toEqual([{ _row: '1', name: 'Alice' }]);
    const inner = await readTableRecords(page, {
      selector: '[aria-label="Inner"]',
      columns: [{ header: 'Item', key: 'item' }],
    });
    expect(inner.records).toEqual([{ _row: '1', item: 'Widget' }]);
  });
});

// ── §5.8: ag-Grid's pinned columns ──────────────────────────────────────────

/**
 * ag-Grid renders a pinned column's cells in a container of their own, so ONE
 * logical row is two `role="row"` elements carrying the same `aria-rowindex`
 * (and `row-index`, and `row-id`).
 *
 * `rowAttrs` decides which of the two index attributes the rows carry, which
 * is the whole point of the three tests below.
 */
function agGrid(rowAttrs: (i: number) => string): string {
  const athletes = [
    ['Michael Phelps', '23', 'United States'],
    ['Natalie Coughlin', '25', 'United States'],
  ];
  const pinned = athletes.map(([name], i) => `
        <div class="ag-row" role="row" ${rowAttrs(i)}>
          <div class="ag-cell" role="gridcell" aria-colindex="1">${name}</div>
        </div>`).join('');
  const centre = athletes.map(([, age, country], i) => `
        <div class="ag-row" role="row" ${rowAttrs(i)}>
          <div class="ag-cell" role="gridcell" aria-colindex="2">${age}</div>
          <div class="ag-cell" role="gridcell" aria-colindex="3">${country}</div>
        </div>`).join('');
  return `
<div class="ag-root-wrapper">
  <div class="ag-root" id="ag" role="grid" aria-colcount="3" aria-rowcount="3" aria-label="Athletes">
    <div class="ag-header" role="presentation">
      <div class="ag-pinned-left-header" role="presentation">
        <div class="ag-header-row" role="row" aria-rowindex="1">
          <div class="ag-header-cell" role="columnheader" aria-colindex="1" col-id="athlete">Athlete</div>
        </div>
      </div>
      <div class="ag-header-viewport" role="presentation"><div class="ag-header-container">
        <div class="ag-header-row" role="row" aria-rowindex="1">
          <div class="ag-header-cell" role="columnheader" aria-colindex="2" col-id="age">Age</div>
          <div class="ag-header-cell" role="columnheader" aria-colindex="3" col-id="country">Country</div>
        </div>
      </div></div>
    </div>
    <div class="ag-body-viewport" role="presentation">
      <div class="ag-pinned-left-cols-container" role="rowgroup">${pinned}
      </div>
      <div class="ag-center-cols-container" role="rowgroup">${centre}
      </div>
    </div>
  </div>
</div>`;
}

const AG_COLUMNS: TableReadColumn[] = [
  { header: 'Athlete', key: 'athlete' },
  { header: 'Age', key: 'age' },
  { header: 'Country', key: 'country' },
];

const AG_RECORDS = [
  { _row: '1', athlete: 'Michael Phelps', age: '23', country: 'United States' },
  { _row: '2', athlete: 'Natalie Coughlin', age: '25', country: 'United States' },
];

describe('readTable — ag-Grid pinned fragments (§5.8, §7.9)', () => {
  it('joins fragments sharing aria-rowindex into one record', async () => {
    // Read as separate rows a pinned grid produces FOUR half-records for a
    // two-row grid — the §4.5 misalignment with twice as many rows as the
    // grid has, and each one missing the columns the other fragment held.
    await load(agGrid((i) => `row-index="${i}" aria-rowindex="${i + 2}" row-id="${i}"`));
    const result = await readTableRecords(page, { selector: '#ag', columns: AG_COLUMNS });
    expect(result.records).toEqual(AG_RECORDS);
    expect(result.dataRowCount).toBe(2);
  });

  it('falls back to row-index when aria-rowindex is absent', async () => {
    await load(agGrid((i) => `row-index="${i}" row-id="${i}"`));
    const result = await readTableRecords(page, { selector: '#ag', columns: AG_COLUMNS });
    expect(result.records).toEqual(AG_RECORDS);
  });

  it('treats each fragment as its own row when neither index is there', async () => {
    // §7.9's stated limit, pinned so the fallback above is not mistaken for a
    // guess about which fragments belong together: with nothing saying so,
    // each `role="row"` is a row of its own — four rows for a two-row grid,
    // the last two holding only the centre container's columns. The read
    // FAILS rather than storing half-records, which is the point: the short
    // row is refused by name and position (§7.4).
    await load(agGrid(() => ''));
    expect(await refusal({ selector: '#ag', columns: [{ header: 'Athlete', key: 'athlete' }] }))
      .toBe(
        'readTable cannot map table "Athletes": row 3 has 2 cells, so there is no cell for the '
        + '"Athlete" column at position 1',
      );
  });

  it('stamps the FIRST fragment only, so the stamp is not ambiguous', async () => {
    await load(agGrid((i) => `row-index="${i}" aria-rowindex="${i + 2}"`));
    await readTableRecords(page, { selector: '#ag', columns: AG_COLUMNS });
    const stamps = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#ag [data-steptix-row]')).map((e) => ({
        n: e.getAttribute('data-steptix-row'),
        pinned: e.parentElement?.className ?? '',
      })));
    expect(stamps).toEqual([
      { n: '1', pinned: 'ag-pinned-left-cols-container' },
      { n: '2', pinned: 'ag-pinned-left-cols-container' },
    ]);
  });
});

// ── header grids, tables that are grids, and two things with rows ───────────

describe('readTable — ARIA header grids and arbitration (§7.9, §7.3b, §10)', () => {
  const BANDED = `
<div role="grid" id="fees" aria-label="Fees">
  <div role="row">
    <div role="columnheader" aria-colindex="1" aria-colspan="2">Q1</div>
    <div role="columnheader" aria-colindex="3" aria-colspan="2">Q2</div>
  </div>
  <div role="row">
    <div role="columnheader" aria-colindex="1">Fee</div>
    <div role="columnheader" aria-colindex="2">Tax</div>
    <div role="columnheader" aria-colindex="3">Fee</div>
    <div role="columnheader" aria-colindex="4">Tax</div>
  </div>
  <div role="row">
    <div role="gridcell" aria-colindex="1">$10</div>
    <div role="gridcell" aria-colindex="2">$1</div>
    <div role="gridcell" aria-colindex="3">$20</div>
    <div role="gridcell" aria-colindex="4">$2</div>
  </div>
</div>`;

  it('lays two header rows out over aria-colspan and names each column by its leaf', async () => {
    // §7.3b's header grid with `aria-colspan` in place of `colspan` (§7.9).
    // Read as one header row, the band row alone names columns 1 and 3 "Q1"
    // and "Q2" and the leaf names are lost; read without the spans, Q2 lands
    // on column 2.
    await load(BANDED);
    const result = await readTableRecords(page, {
      selector: '#fees',
      columns: [{ header: 'Q1 > Fee', key: 'q1' }, { header: 'Q2 > Fee', key: 'q2' }],
    });
    expect(result.records).toEqual([{ _row: '1', q1: '$10', q2: '$20' }]);
  });

  it('refuses a repeated leaf name by position, as a table does', async () => {
    await load(BANDED);
    expect(await refusal({ selector: '#fees', columns: [{ header: 'Fee', key: 'f' }] }))
      .toBe(
        'readTable cannot map table "Fees": "Fee" matches 2 columns (positions 1, 3) — name the '
        + 'one you mean by position',
      );
  });

  it('refuses a band the way §5.3 does, naming the leaves under it', async () => {
    await load(BANDED);
    expect(await refusal({ selector: '#fees', columns: [{ header: 'Q1', key: 'q' }] }))
      .toBe(
        'readTable cannot map table "Fees": no column is headed "Q1" — available headers are Fee, '
        + 'Tax, Fee, Tax ("Q1" is a band over Fee, Tax, not a column)',
      );
  });

  it('reads a <table role="grid"> as a table — the tag wins', async () => {
    // §10: a `<table role="grid">` is a table. Read through the ARIA model it
    // has no `role="row"` descendants at all and answers `[]` — a green step
    // that read nothing, which is the outcome §2 exists to prevent.
    await load(`
      <table id="kendo" role="grid" aria-label="Holdings">
        <thead><tr><th>Symbol</th><th>Units</th></tr></thead>
        <tbody>
          <tr><td>VAS</td><td>120</td></tr>
          <tr><td>VGS</td><td>80</td></tr>
        </tbody>
      </table>`);
    const result = await readTableRecords(page, {
      selector: '#kendo',
      columns: [{ header: 'Symbol', key: 'symbol' }, { header: 'Units', key: 'units' }],
    });
    expect(result.records).toEqual([
      { _row: '1', symbol: 'VAS', units: '120' },
      { _row: '2', symbol: 'VGS', units: '80' },
    ]);
  });

  it('refuses a wrapper holding both a table and an ARIA grid with rows', async () => {
    // §10: two things with rows. Picking either is the half-a-grid
    // misalignment §7.2 refuses for two tables, and §7.10 may ask the model
    // which one was meant.
    await load(`
      <div id="both">
        <table><thead><tr><th>Ref</th></tr></thead><tbody><tr><td>T-1</td></tr></tbody></table>
        <div role="grid">
          <div role="row"><div role="columnheader">Ref</div></div>
          <div role="row"><div role="gridcell">G-1</div></div>
        </div>
      </div>`);
    expect(await refusal({ selector: '#both', columns: [{ header: 'Ref', key: 'ref' }] }))
      .toBe(
        'readTable found a table and an ARIA grid with rows under "#both" — it must be exactly '
        + 'one, so select the one you mean',
      );
  });

  it('refuses a wrapper holding two ARIA grids with rows', async () => {
    await load(`
      <div id="pair">
        <div role="grid" aria-label="Left">
          <div role="row"><div role="columnheader">Ref</div></div>
          <div role="row"><div role="gridcell">L-1</div></div>
        </div>
        <div role="grid" aria-label="Right">
          <div role="row"><div role="columnheader">Ref</div></div>
          <div role="row"><div role="gridcell">R-1</div></div>
        </div>
      </div>`);
    expect(await refusal({ selector: '#pair', columns: [{ header: 'Ref', key: 'ref' }] }))
      .toBe(
        'readTable found 2 ARIA grids with rows under "#pair" — it must be exactly one, so select '
        + 'the one you mean',
      );
  });

  it('reads the one grid under a wrapper, and an empty one as []', async () => {
    await load(`
      <div id="box" class="grid-box">
        <div role="grid" aria-label="Accounts">
          <div role="row"><div role="columnheader">Account</div></div>
          <div role="row"><div role="gridcell">Everyday</div></div>
        </div>
      </div>`);
    const full = await readTableRecords(page, {
      selector: '#box',
      columns: [{ header: 'Account', key: 'account' }],
    });
    expect(full.records).toEqual([{ _row: '1', account: 'Everyday' }]);

    // Emptied, the grid keeps its header and has no data row. §4.8 says that
    // reads `[]`; refused instead, an author who filtered every row out gets
    // a broken step rather than an empty list.
    await load(`
      <div id="box" class="grid-box">
        <div role="grid" aria-label="Accounts">
          <div role="row"><div role="columnheader">Account</div></div>
        </div>
      </div>`);
    const empty = await readTableRecords(page, {
      selector: '#box',
      columns: [{ header: 'Account', key: 'account' }],
    });
    expect(empty.records).toEqual([]);
  });

  it('still refuses a region with nothing that has rows in it', async () => {
    // §7.9 widened what the sentence MEANS — no `<table>` and no ARIA grid
    // with data rows — and left the words alone.
    await load('<div id="menu"><ul><li>Home</li><li>Orders</li></ul></div>');
    expect(await refusal({ selector: '#menu', columns: [{ index: 1, key: 'a' }] }))
      .toBe('readTable found no table with rows under "#menu"');
  });

  it('reads a row-header cell and a placeholder row the way a table does', async () => {
    await load(`
      <div role="grid" id="mixed" aria-label="Statements">
        <div role="row">
          <div role="columnheader">Account</div>
          <div role="columnheader">Balance</div>
          <div role="columnheader">Status</div>
        </div>
        <div role="row">
          <div role="rowheader">Everyday</div>
          <div role="gridcell">$2,340.10</div>
          <div role="gridcell">Active</div>
        </div>
        <div role="row"><div role="gridcell" aria-colspan="3">Loading more…</div></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#mixed',
      columns: [{ header: 'Account', key: 'account' }, { header: 'Status', key: 'status' }],
    });
    // The `rowheader` counts as that row's cell at its logical position (§10),
    // and the lone spanning cell is a message row (§4.8) read through
    // `aria-colspan` — counted as data it would be the merged-cell refusal.
    expect(result.records).toEqual([{ _row: '1', account: 'Everyday', status: 'Active' }]);
    expect(result.placeholdersSkipped).toBe(1);
  });

  it('refuses a merged ARIA data cell, as it refuses a merged <td>', async () => {
    await load(`
      <div role="grid" id="merged" aria-label="Merged">
        <div role="row">
          <div role="columnheader">A</div><div role="columnheader">B</div>
          <div role="columnheader">C</div>
        </div>
        <div role="row">
          <div role="gridcell">1</div><div role="gridcell" aria-colspan="2">2</div>
        </div>
      </div>`);
    expect(await refusal({ selector: '#merged', columns: [{ header: 'A', key: 'a' }] }))
      .toBe(
        'readTable cannot map table "Merged": merged headers or cells (rowspan/colspan > 1) are '
        + 'not supported',
      );
  });
});

// ── §7.9: `role` is a TOKEN LIST ────────────────────────────────────────────
//
// WAI-ARIA defines `role` as "an ordered set of whitespace-separated values",
// and frameworks write several. Compared as a whole string, a row spelled
// `role="row presentation"` was not a row at all — so the grid read its
// REMAINING rows and answered SUCCESSFULLY with half the table in it, which is
// the one outcome this action exists to prevent (§2).

describe('readTable — a role of several tokens (§7.9)', () => {
  it('reads a DATA row whose role carries a second token', async () => {
    await load(`
      <div id="g" role="grid">
        <div role="row"><div role="columnheader">A</div><div role="columnheader">B</div></div>
        <div role="row"><div role="gridcell">a1</div><div role="gridcell">b1</div></div>
        <div role="row presentation"><div role="gridcell">a2</div><div role="gridcell">b2</div></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#g',
      columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }],
    });
    expect(result.records).toEqual([
      { _row: '1', a: 'a1', b: 'b1' },
      { _row: '2', a: 'a2', b: 'b2' },
    ]);
  });

  it('reads a CELL whose role carries a second token', async () => {
    // Dropped, the row is one cell short and column B reads "" for every row
    // — a convincingly wrong answer, not a refusal.
    await load(`
      <div id="g2" role="grid">
        <div role="row"><div role="columnheader">A</div><div role="columnheader">B</div></div>
        <div role="row"><div role="gridcell">a1</div><div role="gridcell selected">b1</div></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#g2',
      columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }],
    });
    expect(result.records).toEqual([{ _row: '1', a: 'a1', b: 'b1' }]);
  });

  it('reads a HEADER row whose role carries a second token', async () => {
    await load(`
      <div id="g3" role="grid">
        <div role="row presentation"><div role="columnheader">A</div></div>
        <div role="row"><div role="gridcell">1</div></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#g3', columns: [{ header: 'A', key: 'a' }],
    });
    expect(result.records).toEqual([{ _row: '1', a: '1' }]);
  });

  it('still skips a child whose only role is none/presentation', async () => {
    // The guard the tokenising must not undo: MUI's filler has ONE token and
    // it is not a cell role, so it still occupies no column.
    await load(`
      <div id="g4" role="grid">
        <div role="row"><div role="columnheader">A</div></div>
        <div role="row"><div role="presentation">x</div><div role="gridcell">a1</div></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#g4', columns: [{ header: 'A', key: 'a' }],
    });
    expect(result.records).toEqual([{ _row: '1', a: 'a1' }]);
  });

  it('folds case, as it always did', async () => {
    await load(`
      <div id="g5" role="GRID">
        <div role="ROW"><div role="COLUMNHEADER">A</div></div>
        <div role="ROW"><div role="GRIDCELL">a1</div></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#g5', columns: [{ header: 'A', key: 'a' }],
    });
    expect(result.records).toEqual([{ _row: '1', a: 'a1' }]);
  });
});

// ── §7.9's refinements, each measured on the way in ─────────────────────────

describe('readTable — which element owns which rows (§7.9)', () => {
  it('treats a role="grid" wrapper around native tables as a WRAPPER', async () => {
    // Kendo: `<div class="k-grid" role="grid" aria-label="Dividends">` with
    // native `<table>` markup inside and not one `role="row"` of its own.
    // Read as a grid on the strength of the attribute, it answered `[]` —
    // green, for a grid with rows in it — and the real table was never
    // looked at.
    await load(`
      <div id="k" class="k-grid" role="grid" aria-label="Dividends">
        <table>
          <thead><tr role="row"><th>Payer</th><th>Amount</th></tr></thead>
          <tbody><tr role="row"><td>BHP</td><td>$1.10</td></tr></tbody>
        </table>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#k',
      columns: [{ header: 'Payer', key: 'payer' }, { header: 'Amount', key: 'amount' }],
    });
    expect(result.records).toEqual([{ _row: '1', payer: 'BHP', amount: '$1.10' }]);
  });

  it('gives a <tr role="row"> to its own table, not to a grid above it', async () => {
    // The other half of the same measurement: Kendo writes `role="row"` on
    // its `<tr>`s, and those rows answered to the wrapper two levels up. A
    // `<tr>` belongs to its `<table>`; nothing above the table can claim it.
    // Two tables under the wrapper is then the split-grid shape, refused —
    // which is only reachable if the rows were attributed correctly.
    await load(`
      <div id="k2" role="grid" aria-label="Split">
        <table><thead><tr role="row"><th>Payer</th></tr></thead></table>
        <table><tbody>
          <tr role="row"><td>BHP</td></tr>
          <tr role="row"><td>CSL</td></tr>
        </tbody></table>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#k2', columns: [{ header: 'Payer', key: 'payer' }],
    });
    expect(result.records).toEqual([
      { _row: '1', payer: 'BHP' },
      { _row: '2', payer: 'CSL' },
    ]);
    expect(result.headerFromSeparateTable).toBe(true);
  });

  it('excludes an ARIA header row that comes AFTER the data rows', async () => {
    // The ARIA spelling of `<tfoot>` (§7.4). Left in the body it would be a
    // record of heading text — one more row than the grid has, with the
    // column names as its values.
    await load(`
      <div id="g6" role="grid">
        <div role="row"><div role="columnheader">A</div></div>
        <div role="row"><div role="gridcell">a1</div></div>
        <div role="row"><div role="columnheader">Z</div></div>
      </div>`);
    const result = await readTableRecords(page, {
      selector: '#g6', columns: [{ header: 'A', key: 'a' }],
    });
    expect(result.records).toEqual([{ _row: '1', a: 'a1' }]);
    // And the trailing row is not counted as a skipped placeholder either:
    // it is not a body row at all.
    expect(result.placeholdersSkipped).toBe(0);
  });
});
