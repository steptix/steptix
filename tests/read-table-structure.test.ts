/**
 * §7.10's half of the structure question that lives in the EXTRACTOR: the
 * sketch a shape refusal carries, and the validated `mapping` replayed against
 * the page (docs/specs/SPEC-structured-table-reads.md §5.9, §7.10, §12 item
 * 30).
 *
 * Nothing here calls a model. The question itself — the prompt, the answer,
 * the run's memo — is `tests/api-server-table-structure.test.ts`'s and
 * `tests/prompts-grid-structure.test.ts`'s; this file pins what the extractor
 * hands that machinery and what it does with the answer it gets back.
 *
 * The fixtures are the four shapes of §5.9, inline for the reason
 * `read-table.test.ts` gives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  executeAction,
  readTableRecords,
  formatTableReadSummary,
  TableShapeError,
  type TableSketch,
} from '../src/browser/actions.js';
import type { AIAction, TableReadColumn, TableReadMapping } from '../src/ai/types.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
}, 30_000);

async function load(bodyHtml: string): Promise<void> {
  await page.setContent(`<html><body>${bodyHtml}</body></html>`);
}

function run(
  action: Partial<AIAction> & { selector: string; columns: TableReadColumn[] },
  maskValues?: string[],
) {
  return executeAction(
    page,
    { action: 'readTable', as: 'rows', description: 'Read the table', ...action } as AIAction,
    undefined,
    undefined,
    maskValues !== undefined ? { maskValues } : undefined,
  );
}

/** Read with a mapping and return the message when it refuses. */
async function mapped(
  selector: string,
  columns: TableReadColumn[],
  mapping: TableReadMapping,
) {
  return readTableRecords(page, { selector, columns, mapping });
}

async function mappingRefusal(
  selector: string,
  columns: TableReadColumn[],
  mapping: TableReadMapping,
): Promise<string> {
  try {
    const result = await mapped(selector, columns, mapping);
    throw new Error(`expected a refusal, got ${JSON.stringify(result.records)}`);
  } catch (err) {
    return (err as Error).message;
  }
}

// ── §5.9.1: headings written as <td> in the first body row ──────────────────

const TD_HEADED = `
<table id="orders">
  <tbody>
    <tr><td><b>Name</b></td><td><b>Amount</b></td></tr>
    <tr><td>Alice Smith</td><td>$125.00</td></tr>
    <tr><td>Bob Jones</td><td>$89.50</td></tr>
  </tbody>
</table>`;

const NAME_AND_AMOUNT: TableReadColumn[] = [
  { header: 'Name', key: 'name' },
  { header: 'Amount', key: 'amount' },
];

// ── §5.9.2: a header table AFTER the rows, with text between them ───────────

const HEADER_AFTER_ROWS = `
<div id="grid">
  <table id="rows">
    <tbody>
      <tr><td>Alice Smith</td><td>$125.00</td></tr>
      <tr><td>Bob Jones</td><td>$89.50</td></tr>
    </tbody>
  </table>
  <p class="caption">Figures are inclusive of GST.</p>
  <table id="head"><thead><tr><th>Name</th><th>Amount</th></tr></thead></table>
  <table id="blank"><thead><tr><th></th><th></th></tr></thead></table>
  <table id="wide"><thead><tr><th>Name</th><th>Amount</th><th>Status</th></tr></thead></table>
</div>`;

// ── the sketch ──────────────────────────────────────────────────────────────

describe('readTable — the §7.10 sketch', () => {
  it('rides on a shape refusal and describes the region it was taken from', async () => {
    await load(TD_HEADED);
    const result = await run({ selector: '#orders', columns: NAME_AND_AMOUNT });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'readTable cannot map table "orders": it has no header row, so "Name" cannot be matched — '
      + 'name columns by position ("the 1st column as name")',
    );
    const sketch = result.sketch as TableSketch;
    expect(sketch).toBeDefined();
    expect(sketch.region).toEqual({
      selector: '#orders', tag: 'table', id: 'orders', label: 'orders',
    });
    expect(sketch.candidates).toHaveLength(1);
    const [table] = sketch.candidates;
    // A `<table>` region with no table-bearing ancestor is its own root, so
    // the one candidate is named `:scope` — the one selector a mapping can
    // use for it, since `querySelector` never matches its own root.
    expect(table).toMatchObject({
      id: 'T1',
      selector: ':scope',
      kind: 'table',
      headerRowCount: 0,
      dataRowCount: 3,
    });
    expect(table?.rows).toEqual([
      {
        id: 'T1.r1',
        section: 'tbody',
        cells: 2,
        tags: 'td×2',
        spans: '',
        rendered: true,
        text: ['Name', 'Amount'],
      },
      {
        id: 'T1.r2',
        section: 'tbody',
        cells: 2,
        tags: 'td×2',
        spans: '',
        rendered: true,
        text: ['Alice Smith', '$125.00'],
      },
      {
        id: 'T1.r3',
        section: 'tbody',
        cells: 2,
        tags: 'td×2',
        spans: '',
        rendered: true,
        text: ['Bob Jones', '$89.50'],
      },
    ]);
  });

  it('lists every table and grid beside a <table> region, bounded below <body>', async () => {
    await load(HEADER_AFTER_ROWS);
    // The region is `#rows`, whose partner sits BESIDE it: the sketch is taken
    // from the nearest ancestor holding something else as well, so the model
    // can see the header table it is being asked about.
    const result = await run({ selector: '#rows', columns: NAME_AND_AMOUNT });
    const sketch = result.sketch as TableSketch;
    expect(sketch.candidates.map((c) => [c.id, c.selector, c.headerRowCount, c.dataRowCount]))
      .toEqual([
        ['T1', '#rows', 0, 2],
        ['T2', '#head', 1, 0],
        ['T3', '#blank', 1, 0],
        ['T4', '#wide', 1, 0],
      ]);
    expect(sketch.candidates[1]?.rows?.[0]).toMatchObject({
      id: 'T2.r1', section: 'thead', cells: 2, tags: 'th×2',
    });
  });

  it('describes an ARIA grid by role, with its spans', async () => {
    await load(`
      <div id="box">
        <div role="grid" aria-label="Fees">
          <div role="row">
            <div role="columnheader" aria-colindex="1" aria-colspan="2">Q1</div>
          </div>
          <div role="row">
            <div role="columnheader" aria-colindex="1">Fee</div>
            <div role="columnheader" aria-colindex="2">Tax</div>
          </div>
          <div role="row">
            <div role="gridcell" aria-colindex="1">$10</div>
            <div role="gridcell" aria-colindex="2">$1</div>
          </div>
        </div>
        <div role="grid">
          <div role="row"><div role="gridcell">b</div></div>
        </div>
      </div>`);
    // The second grid is what makes this a SHAPE refusal, so the sketch is the
    // one a real read carries. It also makes the first grid's path an
    // `:nth-of-type(1)` — alone in `#box` it would be `:scope > div`.
    const result = await run({ selector: '#box', columns: [{ index: 1, key: 'a' }] });
    expect(result.error).toContain('found 2 ARIA grids with rows under');
    const sketch = result.sketch as TableSketch | undefined;
    expect(sketch).toBeDefined();
    expect(sketch?.candidates[0]).toMatchObject({
      id: 'T1',
      selector: ':scope > div:nth-of-type(1)',
      kind: 'grid',
      label: 'Fees',
      headerRowCount: 2,
      dataRowCount: 1,
    });
    // `header`, not `row`: the band row and the name row are the grid's
    // HEADER rows, and the section word is what turns a model's "row 2 of T1"
    // into a `header` mapping. Said `row`, both were counted as body rows and
    // "row 3" — the data — came out as body row 3, a row that does not exist.
    expect(sketch?.candidates[0]?.rows?.map((r) => (r as { section: string }).section))
      .toEqual(['header', 'header', 'row']);
    expect(sketch?.candidates[0]?.rows?.[0]).toMatchObject({
      section: 'header', tags: 'columnheader×1', spans: 'colspan 2',
    });
  });

  it('gives a <tfoot> row its own section word, and an ARIA heading row after the data too', async () => {
    // The section is the whole of the caller's arithmetic: `thead`/`header`
    // means "no row number needed", `tbody`/`row` means "count it among the
    // body rows", and `tfoot` is refused. §7.9 says a heading row AFTER the
    // data is the ARIA spelling of `<tfoot>` and is excluded the same way, so
    // it gets the word that earns it the same refusal.
    //
    // Each is read through a wrapper that also holds a plain table, which is
    // what makes the read a SHAPE refusal and so puts the sketch on it; the
    // candidate under test comes first, so it is T1.
    const OTHER = '<table><tbody><tr><td>b</td></tr></tbody></table>';
    await load(`
      <div id="wrap">
        <table id="totals">
          <thead><tr><th>Payee</th><th>Amount</th></tr></thead>
          <tbody><tr><td>Origin</td><td>$1</td></tr></tbody>
          <tfoot><tr><td>Total</td><td>$1</td></tr></tfoot>
        </table>
        ${OTHER}
      </div>`);
    const totals = await run({ selector: '#wrap', columns: [{ index: 1, key: 'a' }] });
    expect(totals.error).toContain('found 2 tables with rows under');
    const totalsSketch = totals.sketch as TableSketch | undefined;
    expect(totalsSketch?.candidates[0]?.selector).toBe('#totals');
    expect(totalsSketch?.candidates[0]?.rows.map((r) => r.section))
      .toEqual(['thead', 'tbody', 'tfoot']);

    await load(`
      <div id="wrap">
        <div id="g" role="grid">
          <div role="row"><div role="columnheader">A</div></div>
          <div role="row"><div role="gridcell">a1</div></div>
          <div role="row"><div role="columnheader">Z</div></div>
        </div>
        ${OTHER}
      </div>`);
    const grid = await run({ selector: '#wrap', columns: [{ index: 1, key: 'a' }] });
    expect(grid.error).toContain('found a table and an ARIA grid with rows under');
    const gridSketch = grid.sketch as TableSketch | undefined;
    expect(gridSketch?.candidates[0]?.selector).toBe('#g');
    expect(gridSketch?.candidates[0]?.rows.map((r) => r.section))
      .toEqual(['header', 'row', 'tfoot']);
  });

  it('masks the region\'s own selector, id and label as well as the cell text', async () => {
    // Everything in the sketch is rendered whole into a model call and the
    // debug log. A selector is page-derived as often as a cell is
    // (`#user-hunter2`), so it is masked with the rest — except the
    // CANDIDATE selector, which is machinery the caller hands back as the
    // mapping and would resolve to nothing as `#***`.
    await load(`
      <div id="box-hunter2" aria-label="Account hunter2">
        <table id="inner"><tbody><tr><td>a</td></tr></tbody></table>
      </div>`);
    // A header asked of a table that has none: a shape refusal, so a sketch.
    const result = await run(
      { selector: '#box-hunter2', columns: [{ header: 'User', key: 'user' }] },
      ['hunter2'],
    );
    expect(result.error).toContain('it has no header row');
    const sketch = result.sketch as TableSketch | undefined;
    expect(sketch).toBeDefined();
    expect(sketch?.region.selector).toBe('#box-***');
    expect(sketch?.region.id).toBe('box-***');
    expect(sketch?.region.label).toBe('Account ***');
    expect(sketch?.candidates[0]?.selector).toBe('#inner');
  });

  it('masks the caller\'s secret values in the cell text it quotes', async () => {
    // §7.6: the sketch is the ONE place this extractor quotes page content
    // back out, and it goes to a model call and the debug log. Masked where
    // it is built, and before the 40-character cut — cut first, a long secret
    // leaves its first 39 characters in the sketch.
    await load(`
      <table id="creds">
        <tbody>
          <tr><td><b>User</b></td><td><b>Password</b></td></tr>
          <tr><td>ada</td><td>hunter2-the-real-one</td></tr>
        </tbody>
      </table>`);
    const result = await run(
      { selector: '#creds', columns: [{ header: 'User', key: 'user' }] },
      ['hunter2-the-real-one'],
    );
    const sketch = result.sketch as TableSketch;
    const text = JSON.stringify(sketch);
    expect(text).not.toContain('hunter2');
    expect(sketch.candidates[0]?.rows?.[1]?.text).toEqual(['ada', '***']);
  });

  it('cuts text and rows before candidates, and stays inside its size cap', async () => {
    // §7.10's "capped at a few kilobytes". Text goes first, then rows, then
    // candidates: the SHAPE of the region is what the question is about, so a
    // box of twelve tables has to describe all of them before it describes
    // any of their contents.
    const table = (n: number) => `<table id="t${n}"><tbody>${
      Array.from({ length: 20 }, (_, i) =>
        `<tr>${Array.from({ length: 8 }, (_, c) =>
          `<td>t${n} row ${i} cell ${c} ${'x'.repeat(120)}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`;
    await load(`<div id="big">${Array.from({ length: 12 }, (_, n) => table(n)).join('')}</div>`);
    const big = await run({ selector: '#big', columns: [{ index: 1, key: 'a' }] });
    expect(big.error).toContain('found 12 tables with rows under');
    const sketch = big.sketch as TableSketch | undefined;
    expect(sketch).toBeDefined();
    expect(JSON.stringify(sketch).length).toBeLessThanOrEqual(6144);
    expect(sketch?.truncated).toBe(true);
    // The counts survive whatever the cap does to the contents.
    expect(sketch?.candidates[0]?.dataRowCount).toBe(20);
    expect((sketch?.candidates[0]?.rows?.length ?? 0) + (sketch?.candidates[0]?.moreRows ?? 0))
      .toBe(20);
    expect((sketch?.candidates.length ?? 0) + (sketch?.moreCandidates ?? 0)).toBe(12);

    // A region that fits is not marked truncated and keeps its full budget:
    // six cells of text per row, cut at 40 characters.
    // Refused for its missing header row: a shape refusal, so it carries one.
    await load(`<div id="small">${table(0)}</div>`);
    const one = await run({ selector: '#small', columns: [{ header: 'Name', key: 'name' }] });
    expect(one.error).toContain('it has no header row');
    const small = one.sketch as TableSketch | undefined;
    expect(small).toBeDefined();
    expect(small?.truncated).toBeUndefined();
    expect(small?.candidates[0]?.rows).toHaveLength(8);
    expect(small?.candidates[0]?.moreRows).toBe(12);
    expect(small?.candidates[0]?.rows[0]?.text).toHaveLength(6);
    expect(small?.candidates[0]?.rows[0]?.text[0]).toHaveLength(40);
    expect(small?.candidates[0]?.rows[0]?.text[0].endsWith('…')).toBe(true);
  });

  it('is absent from every refusal that is not about shape', async () => {
    // §7.10's "NEVER for the author's own problems". Asking the model about a
    // header typo is asking for permission to read a different column.
    await load(`
      <table id="orders" aria-label="Orders">
        <thead><tr><th>Name</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>Alice</td><td>$1</td></tr>
          <tr><td>Bob</td><td colspan="2">$2</td></tr>
        </tbody>
      </table>
      <div class="two"><table><tbody><tr><td>a</td></tr></tbody></table></div>
      <div class="two"><table><tbody><tr><td>b</td></tr></tbody></table></div>`);
    const typo = await run({ selector: '#orders', columns: [{ header: 'Naem', key: 'n' }] });
    expect(typo.error).toContain('no column is headed "Naem"');
    expect(typo.sketch).toBeUndefined();

    const merged = await run({ selector: '#orders', columns: NAME_AND_AMOUNT });
    expect(merged.error).toContain('merged headers or cells');
    expect(merged.sketch).toBeUndefined();

    const ambiguous = await run({ selector: '.two', columns: [{ index: 1, key: 'a' }] });
    expect(ambiguous.error).toContain('it must match exactly one table');
    expect(ambiguous.sketch).toBeUndefined();

    const missing = await run({ selector: '#nothing', columns: [{ index: 1, key: 'a' }] });
    expect(missing.error).toBe('readTable could not find a table matching "#nothing"');
    expect(missing.sketch).toBeUndefined();
  });

  it('rides on every one of the EIGHT shape refusals', async () => {
    // Nothing with rows under the region.
    await load('<div id="menu"><ul><li>Home</li></ul></div>');
    expect((await run({ selector: '#menu', columns: [{ index: 1, key: 'a' }] })).sketch)
      .toBeDefined();

    // Two things with rows.
    await load(`
      <div id="pair">
        <table><tbody><tr><td>a</td></tr></tbody></table>
        <table><tbody><tr><td>b</td></tr></tbody></table>
      </div>`);
    const two = await run({ selector: '#pair', columns: [{ index: 1, key: 'a' }] });
    expect(two.error).toContain('2 tables with rows under');
    expect(two.sketch).toBeDefined();

    // A header requested and none found by any path.
    await load(TD_HEADED);
    expect((await run({ selector: '#orders', columns: NAME_AND_AMOUNT })).sketch).toBeDefined();

    // A header grid that names nothing.
    await load(`
      <table id="blankhead">
        <tbody>
          <tr><th></th><th></th></tr>
          <tr><td>Alice</td><td>$1</td></tr>
        </tbody>
      </table>`);
    const blank = await run({ selector: '#blankhead', columns: NAME_AND_AMOUNT });
    expect(blank.error).toContain('its header row has no non-empty headings');
    expect(blank.sketch).toBeDefined();

    // Two header-only tables beside the rows — a grid with frozen columns.
    await load(`
      <div id="frozen">
        <table><thead><tr><th>Name</th></tr></thead></table>
        <table><thead><tr><th>Amount</th></tr></thead></table>
        <table id="frozen-rows"><tbody><tr><td>Alice</td></tr></tbody></table>
      </div>`);
    const frozen = await run({ selector: '#frozen-rows', columns: [{ header: 'Name', key: 'n' }] });
    expect(frozen.error).toContain('header-only tables beside');
    expect(frozen.sketch).toBeDefined();

    // A pairing whose widths disagree.
    await load(`
      <div id="mismatch">
        <table><thead><tr><th>Name</th><th>Amount</th><th>Status</th></tr></thead></table>
        <table id="mismatch-rows"><tbody><tr><td>Alice</td><td>$1</td></tr></tbody></table>
      </div>`);
    const mismatch = await run({
      selector: '#mismatch-rows', columns: [{ header: 'Name', key: 'n' }],
    });
    expect(mismatch.error).toContain('the two tables do not line up');
    expect(mismatch.sketch).toBeDefined();

    // §7.9's two arbitration refusals. They were the two `failShape` sites
    // this test did not reach, and they are the two most likely to be met by
    // an author pointing at a modern grid: a page that renders a MUI grid
    // beside a legacy table, and one that renders two grids in one box.
    await load(`
      <div id="mixed">
        <table><tbody><tr><td>a</td></tr></tbody></table>
        <div role="grid">
          <div role="row"><div role="columnheader">A</div></div>
          <div role="row"><div role="gridcell">b</div></div>
        </div>
      </div>`);
    const mixed = await run({ selector: '#mixed', columns: [{ index: 1, key: 'a' }] });
    expect(mixed.error).toContain('found a table and an ARIA grid with rows under');
    expect(mixed.sketch).toBeDefined();

    await load(`
      <div id="twogrids">
        <div role="grid">
          <div role="row"><div role="gridcell">a</div></div>
        </div>
        <div role="grid">
          <div role="row"><div role="gridcell">b</div></div>
        </div>
      </div>`);
    const twoGrids = await run({ selector: '#twogrids', columns: [{ index: 1, key: 'a' }] });
    expect(twoGrids.error).toContain('found 2 ARIA grids with rows under');
    expect(twoGrids.sketch).toBeDefined();
  });

  it('throws TableShapeError out of readTableRecords, with the sketch on it', async () => {
    await load(TD_HEADED);
    const err = await readTableRecords(page, { selector: '#orders', columns: NAME_AND_AMOUNT })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TableShapeError);
    expect((err as TableShapeError).sketch?.candidates).toHaveLength(1);
  });
});

// ── kind: 'table' ───────────────────────────────────────────────────────────

describe('readTable — a { kind: "table" } mapping (§7.10)', () => {
  it('reads the §5.9.1 table with its first body row as the header', async () => {
    await load(TD_HEADED);
    const result = await mapped('#orders', NAME_AND_AMOUNT, {
      kind: 'table',
      rows: ':scope',
      header: { selector: ':scope', bodyRow: 1 },
    });
    // The heading row is spliced out of the data: left in, it becomes record 1
    // and every `_row` below it is one too high (§4.5).
    expect(result.records).toEqual([
      { _row: '1', name: 'Alice Smith', amount: '$125.00' },
      { _row: '2', name: 'Bob Jones', amount: '$89.50' },
    ]);
    expect(result.structure).toEqual({
      kind: 'table',
      source: 'model',
      rowsElsewhere: false,
      summary: 'rows in T1 (":scope"), header row 1 of T1 (":scope")',
    });
    expect(formatTableReadSummary(result, 2, 'orders', undefined)).toBe(
      'readTable captured 2 rows × 2 columns as "{{orders}}" (structure from the model: rows in '
      + 'T1 (":scope"), header row 1 of T1 (":scope"))',
    );
  });

  it('names the layer the structure came from, not always "the model"', async () => {
    // §7.6's line is the only place a reader can see whether a model call was
    // spent. "structure from the model" over a mapping reused from an earlier
    // step says one was when none was, and a reader counting calls in the log
    // counts wrong.
    // "the run" rather than "the memo": a run log's reader has never heard of
    // a memo, and what the phrase has to say is that an earlier step paid.
    await load(TD_HEADED);
    const mapping: TableReadMapping = {
      kind: 'table', rows: ':scope', header: { selector: ':scope', bodyRow: 1 },
    };
    // The `model` side is the test above's summary line.
    const result = await readTableRecords(page, {
      selector: '#orders', columns: NAME_AND_AMOUNT, mapping, structureSource: 'memo',
    });
    expect(result.structure?.source).toBe('memo');
    expect(formatTableReadSummary(result, 2, 'orders', undefined))
      .toContain('(structure from the run: rows in T1');
  });

  it('stamps the rows it numbered, as a structural read does', async () => {
    await load(TD_HEADED);
    await mapped('#orders', NAME_AND_AMOUNT, {
      kind: 'table', rows: ':scope', header: { selector: ':scope', bodyRow: 1 },
    });
    expect(await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-steptix-row]'))
        .map((e) => `${e.getAttribute('data-steptix-row')}:${(e as HTMLElement).innerText.trim().split('\t')[0]}`)))
      .toEqual(['1:Alice Smith', '2:Bob Jones']);
  });

  it('pairs the §5.9.2 header table that follows the rows', async () => {
    await load(HEADER_AFTER_ROWS);
    const result = await mapped('#grid', NAME_AND_AMOUNT, {
      kind: 'table',
      rows: '#rows',
      header: { selector: '#head' },
    });
    expect(result.records).toEqual([
      { _row: '1', name: 'Alice Smith', amount: '$125.00' },
      { _row: '2', name: 'Bob Jones', amount: '$89.50' },
    ]);
    expect(result.headerFromSeparateTable).toBe(true);
    expect(result.structure?.summary).toBe('rows in T1 ("#rows"), header from T2 ("#head")');
  });

  it('reads by position with no header at all', async () => {
    await load(HEADER_AFTER_ROWS);
    const result = await mapped('#grid', [{ index: 2, key: 'amount' }], {
      kind: 'table',
      rows: '#rows',
    });
    expect(result.records).toEqual([
      { _row: '1', amount: '$125.00' },
      { _row: '2', amount: '$89.50' },
    ]);
    expect(result.structure?.summary).toBe('rows in T1 ("#rows"), no header');
  });

  it('pins an ARIA grid as readily as a table', async () => {
    await load(`
      <div id="box">
        <div role="grid" aria-label="Fees">
          <div role="row"><div role="gridcell">Fee</div><div role="gridcell">Tax</div></div>
          <div role="row"><div role="gridcell">$10</div><div role="gridcell">$1</div></div>
        </div>
      </div>`);
    // Every row here is a data row: the grid writes `gridcell` even for the
    // heading row, which is why structure cannot decide it.
    const result = await mapped('#box', [{ header: 'Fee', key: 'fee' }], {
      kind: 'table',
      rows: ':scope > div',
      header: { selector: ':scope > div', bodyRow: 1 },
    });
    expect(result.records).toEqual([{ _row: '1', fee: '$10' }]);
  });

  it('refuses a mapping naming something that is not there', async () => {
    await load(HEADER_AFTER_ROWS);
    expect(await mappingRefusal('#grid', NAME_AND_AMOUNT, { kind: 'table', rows: '#nope' }))
      .toBe(
        'readTable cannot use the structure given for "grid": the rows selector "#nope" matches '
        + 'no table or ARIA grid under "#grid"',
      );
    expect(await mappingRefusal('#grid', NAME_AND_AMOUNT, { kind: 'table', rows: 'table' }))
      .toBe(
        'readTable cannot use the structure given for "grid": the rows selector "table" matches 4 '
        + 'tables or ARIA grids under "#grid" — it must match exactly one',
      );
    expect(await mappingRefusal('#grid', NAME_AND_AMOUNT, { kind: 'table', rows: 'tr:::' }))
      .toBe(
        'readTable cannot use the structure given for "grid": the rows selector "tr:::" is not a '
        + 'CSS selector',
      );
  });

  it('refuses a rows table with no data rows in it', async () => {
    await load(HEADER_AFTER_ROWS);
    expect(await mappingRefusal('#grid', NAME_AND_AMOUNT, {
      kind: 'table', rows: '#head', header: { selector: '#head' },
    })).toBe(
      'readTable cannot use the structure given for "grid": T2 ("#head") has no data rows',
    );
  });

  it('refuses a header that names no column', async () => {
    await load(HEADER_AFTER_ROWS);
    // A `<thead>` of blank cells is no header at all (§7.3b.5), so the table
    // has none of its own and the answer has to name a body row.
    expect(await mappingRefusal('#grid', NAME_AND_AMOUNT, {
      kind: 'table', rows: '#rows', header: { selector: '#blank' },
    })).toBe(
      'readTable cannot use the structure given for "grid": T3 ("#blank") has no header row of '
      + 'its own — name the body row that holds the headings',
    );

    await load(`
      <table id="quiet">
        <tbody>
          <tr><td></td><td></td></tr>
          <tr><td>Alice</td><td>$1</td></tr>
        </tbody>
      </table>`);
    expect(await mappingRefusal('#quiet', NAME_AND_AMOUNT, {
      kind: 'table', rows: ':scope', header: { selector: ':scope', bodyRow: 1 },
    })).toBe(
      'readTable cannot use the structure given for "quiet": T1 (":scope") names no column, so it '
      + 'cannot be the header',
    );
  });

  it('refuses a body row that is not there', async () => {
    await load(TD_HEADED);
    expect(await mappingRefusal('#orders', NAME_AND_AMOUNT, {
      kind: 'table', rows: ':scope', header: { selector: ':scope', bodyRow: 9 },
    })).toBe(
      'readTable cannot use the structure given for "orders": T1 (":scope") has 3 body rows, so '
      + 'there is no body row 9 to use as the header',
    );
  });

  it('refuses a pairing whose widths disagree, in §7.3a\'s own words', async () => {
    await load(HEADER_AFTER_ROWS);
    expect(await mappingRefusal('#grid', NAME_AND_AMOUNT, {
      kind: 'table', rows: '#rows', header: { selector: '#wide' },
    })).toBe(
      'readTable cannot map table "grid": the header table has 3 cells but its widest row has 2 — '
      + 'the two tables do not line up',
    );
  });

  it('still refuses a header the mapped table does not have', async () => {
    // The mapping says where to look, never what is there: every §7.3 rule
    // runs unchanged against the header it named.
    await load(TD_HEADED);
    expect(await mappingRefusal('#orders', [{ header: 'Status', key: 's' }], {
      kind: 'table', rows: ':scope', header: { selector: ':scope', bodyRow: 1 },
    })).toBe(
      'readTable cannot map table "orders": no column is headed "Status" — available headers are '
      + 'Name, Amount',
    );
  });
});

// ── The fence: what a mapping may READ (§7.10) ──────────────────────────────
//
// The mapping ROOT is wider than the region — a `<table>` region resolves its
// selectors against the ancestor its sketch was taken from, because §5.9.2's
// header table sits beside the rows. That widening is about where a selector
// RESOLVES, not about what may be read, and the two were the same thing:
// `{ rows: "#payroll" }` under `selector: "#orders"` read the payroll table
// and reported it as the orders table, under the author's own selector.

const TWO_TABLES = `
<div id="page">
  <table id="orders"><tbody>
    <tr><td>Alice</td><td>$1.00</td></tr>
  </tbody></table>
  <table id="payroll"><tbody>
    <tr><td>CEO salary</td><td>$999999</td></tr>
  </tbody></table>
</div>`;

describe('readTable — a mapping cannot read outside the selected element', () => {
  it('refuses a rows table that is not the region nor inside it', async () => {
    await load(TWO_TABLES);
    expect(await mappingRefusal(
      '#orders',
      [{ index: 1, key: 'a' }, { index: 2, key: 'b' }],
      { kind: 'table', rows: '#payroll' },
    )).toBe(
      'readTable cannot use the structure given for "orders": the rows selector "#payroll" is '
      + 'not the selected element nor one of the tables beside it',
    );
  });

  it('still lets a HEADER come from a candidate beside the rows (§5.9.2)', async () => {
    // The half that must not be broken by the fence above: a header supplies
    // only NAMES, the width and name checks have to agree with them, and
    // §5.9.2's header table is a sibling of the rows by construction.
    // The author selected the ROW table, so the mapping root is the box above
    // it and `#head` is a sibling — outside the region, and still legal.
    await load(HEADER_AFTER_ROWS);
    const result = await mapped('#rows', NAME_AND_AMOUNT, {
      kind: 'table', rows: '#rows', header: { selector: '#head' },
    });
    expect(result.records).toEqual([
      { _row: '1', name: 'Alice Smith', amount: '$125.00' },
      { _row: '2', name: 'Bob Jones', amount: '$89.50' },
    ]);
    expect(result.headerFromSeparateTable).toBe(true);
    expect(result.structure?.rowsElsewhere).toBe(false);
  });

  it('refuses a collection item outside the selected element', async () => {
    await load(TWO_TABLES);
    expect(await mappingRefusal(
      '#orders',
      [{ header: 'x', key: 'a' }],
      { kind: 'collection', item: '#payroll td', fields: { a: '*' } },
    )).toContain('outside "#orders" — every item must be inside the selected element');
  });

  it('says so when the rows come from a table under the region rather than the region', async () => {
    // Legitimate — a wrapper's rows are always a table inside it — but the
    // records look identical to a read of the element itself, so the flag is
    // what the warn line is built from.
    await load(`
      <div id="grid2">
        <table id="g2-head"><thead><tr><th>Name</th><th>Amount</th></tr></thead></table>
        <table id="g2-rows"><tbody><tr><td>Alice</td><td>$1</td></tr></tbody></table>
      </div>`);
    const result = await mapped('#grid2', NAME_AND_AMOUNT, {
      kind: 'table', rows: '#g2-rows', header: { selector: '#g2-head' },
    });
    expect(result.records).toEqual([{ _row: '1', name: 'Alice', amount: '$1' }]);
    expect(result.structure?.rowsElsewhere).toBe(true);
  });
});

// ── Which body row may be the header (§7.10) ────────────────────────────────

describe('readTable — a header bodyRow has to be a row a reader can see', () => {
  it('refuses an unrendered row as the header', async () => {
    // Its cells still hold text, so it would name every column plausibly and
    // the read would look right — a template row or one a filter hid.
    await load(`
      <table id="t">
        <tbody>
          <tr style="display:none"><td>Secret</td><td>Ghost</td></tr>
          <tr><td>Name</td><td>Amount</td></tr>
          <tr><td>Alice</td><td>$1</td></tr>
        </tbody>
      </table>`);
    expect(await mappingRefusal(
      '#t',
      [{ header: 'Secret', key: 's' }, { header: 'Ghost', key: 'g' }],
      { kind: 'table', rows: ':scope', header: { selector: ':scope', bodyRow: 1 } },
    )).toBe('readTable cannot use the structure given for "t": body row 1 of T1 (":scope") is hidden');
  });

  it('refuses a §4.8 placeholder row as the header', async () => {
    // "No records found" across the table names ONE column and nothing else,
    // and taking it also splices the first real row out of the records.
    await load(`
      <table id="t2">
        <tbody>
          <tr><td colspan="2">No records found</td></tr>
          <tr><td>Alice</td><td>$1</td></tr>
        </tbody>
      </table>`);
    expect(await mappingRefusal(
      '#t2',
      [{ index: 1, key: 'a' }],
      { kind: 'table', rows: ':scope', header: { selector: ':scope', bodyRow: 1 } },
    )).toBe(
      'readTable cannot use the structure given for "t2": body row 1 of T1 (":scope") is a '
      + 'placeholder row, not a header',
    );
  });
});

// ── kind: 'collection' ──────────────────────────────────────────────────────

/** §5.9.3: repeated cards, each holding label/value pairs. */
function cards(extra = ''): string {
  const card = (account: string, balance: string, status: string) => `
    <div class="account-card">
      <div class="field"><span class="label">Account</span><span class="value">${account}</span></div>
      <div class="field"><span class="label">Balance</span><span class="value">${balance}</span></div>
      <div class="field"><span class="label">Status</span><span class="value">${status}</span></div>
    </div>`;
  return `
<div id="accounts">
  ${card('Everyday', '$2,340.10', 'Active')}
  ${card('Savings', '$18,004.22', 'Active')}
  ${card('Offset', '$0.00', 'Closed')}
  ${extra}
</div>`;
}

const CARD_COLUMNS: TableReadColumn[] = [
  { header: 'Account', key: 'account' },
  { header: 'Balance', key: 'balance' },
  { header: 'Status', key: 'status' },
];

const CARD_MAPPING: TableReadMapping = {
  kind: 'collection',
  item: '.account-card',
  fields: {
    account: '.field:nth-child(1) .value',
    balance: '.field:nth-child(2) .value',
    status: '.field:nth-child(3) .value',
  },
};

describe('readTable — a { kind: "collection" } mapping (§7.10)', () => {
  it('reads a card list, one record per rendered item', async () => {
    await load(cards());
    const result = await mapped('#accounts', CARD_COLUMNS, CARD_MAPPING);
    expect(result.records).toEqual([
      { _row: '1', account: 'Everyday', balance: '$2,340.10', status: 'Active' },
      { _row: '2', account: 'Savings', balance: '$18,004.22', status: 'Active' },
      { _row: '3', account: 'Offset', balance: '$0.00', status: 'Closed' },
    ]);
    expect(result.dataRowCount).toBe(3);
    expect(result.structure).toEqual({
      kind: 'collection', source: 'model', summary: '3 items by ".account-card"',
    });
    expect(formatTableReadSummary(result, 3, 'accounts', undefined)).toBe(
      'readTable captured 3 rows × 3 columns as "{{accounts}}" '
      + '(collection: 3 items by ".account-card")',
    );
  });

  it('reads §5.9.4\'s one key/value table per record', async () => {
    const record = (account: string, balance: string) => `
      <table class="kv"><tbody>
        <tr><td>Account</td><td>${account}</td></tr>
        <tr><td>Balance</td><td>${balance}</td></tr>
      </tbody></table>`;
    await load(`<div id="records">${record('Everyday', '$1.00')}${record('Savings', '$2.00')}</div>`);
    const result = await mapped('#records', [
      { header: 'Account', key: 'account' },
      { header: 'Balance', key: 'balance' },
    ], {
      kind: 'collection',
      item: 'table.kv',
      fields: {
        account: 'tr:nth-child(1) td:nth-child(2)',
        balance: 'tr:nth-child(2) td:nth-child(2)',
      },
    });
    expect(result.records).toEqual([
      { _row: '1', account: 'Everyday', balance: '$1.00' },
      { _row: '2', account: 'Savings', balance: '$2.00' },
    ]);
  });

  it('excludes a hidden item and does not let it consume a _row', async () => {
    await load(cards(`
      <div class="account-card" style="display:none">
        <div class="field"><span class="label">Account</span><span class="value">Hidden</span></div>
        <div class="field"><span class="label">Balance</span><span class="value">$9.99</span></div>
        <div class="field"><span class="label">Status</span><span class="value">Closed</span></div>
      </div>`));
    const result = await mapped('#accounts', CARD_COLUMNS, CARD_MAPPING);
    expect(result.records.map((r) => r['account'])).toEqual(['Everyday', 'Savings', 'Offset']);
    expect(result.dataRowCount).toBe(3);
  });

  it('stamps data-steptix-row on the items it numbered', async () => {
    await load(cards());
    await mapped('#accounts', CARD_COLUMNS, CARD_MAPPING);
    expect(await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-steptix-row]'))
        .map((e) => [e.className, e.getAttribute('data-steptix-row')])))
      .toEqual([
        ['account-card', '1'],
        ['account-card', '2'],
        ['account-card', '3'],
      ]);
  });

  it('reads "" for a field absent from SOME items, and counts them', async () => {
    await load(`
      <div id="accounts">
        <div class="account-card">
          <div class="field"><span class="label">Account</span><span class="value">Everyday</span></div>
          <div class="field"><span class="label">Balance</span><span class="value">$1.00</span></div>
        </div>
        <div class="account-card">
          <div class="field"><span class="label">Account</span><span class="value">Savings</span></div>
        </div>
        <div class="account-card">
          <div class="field"><span class="label">Account</span><span class="value">Offset</span></div>
        </div>
      </div>`);
    const result = await mapped('#accounts', [
      { header: 'Account', key: 'account' },
      { header: 'Balance', key: 'balance' },
    ], {
      kind: 'collection',
      item: '.account-card',
      fields: {
        account: '.field:nth-child(1) .value',
        balance: '.field:nth-child(2) .value',
      },
    });
    expect(result.records).toEqual([
      { _row: '1', account: 'Everyday', balance: '$1.00' },
      { _row: '2', account: 'Savings', balance: '' },
      { _row: '3', account: 'Offset', balance: '' },
    ]);
    expect(result.fieldsMissing).toEqual({ balance: 2 });
    expect(result.structure?.summary).toBe('3 items by ".account-card"; 2 items missing balance');
  });

  it('fails a field absent from EVERY item', async () => {
    // A column of nothing but `""` is a convincingly wrong answer, which is
    // the one outcome this action exists to prevent.
    await load(cards());
    expect(await mappingRefusal('#accounts', CARD_COLUMNS, {
      kind: 'collection',
      item: '.account-card',
      fields: {
        account: '.field:nth-child(1) .value',
        balance: '.field:nth-child(2) .value',
        status: '.nowhere',
      },
    })).toBe(
      'readTable cannot use the structure given for "accounts": the field "status" (".nowhere") '
      + 'matches nothing in any of the 3 items',
    );
  });

  it('refuses a field matching two elements in an item, naming the item', async () => {
    await load(cards());
    expect(await mappingRefusal('#accounts', [{ header: 'Account', key: 'account' }], {
      kind: 'collection', item: '.account-card', fields: { account: '.value' },
    })).toBe(
      'readTable cannot use the structure given for "accounts": the field "account" (".value") '
      + 'matches 3 elements in item 1 — it must match at most one',
    );
  });

  it('refuses a missing field, an item selector matching nothing, and a bad selector', async () => {
    await load(cards());
    expect(await mappingRefusal('#accounts', CARD_COLUMNS, {
      kind: 'collection',
      item: '.account-card',
      fields: { account: '.field:nth-child(1) .value' },
    })).toBe(
      'readTable cannot use the structure given for "accounts": no field was given for the '
      + '"balance" column',
    );
    expect(await mappingRefusal('#accounts', CARD_COLUMNS, {
      kind: 'collection', item: '.nope', fields: {},
    })).toBe(
      'readTable cannot use the structure given for "accounts": the item selector ".nope" matches '
      + 'nothing under "#accounts"',
    );
    expect(await mappingRefusal('#accounts', CARD_COLUMNS, {
      kind: 'collection', item: '.a:::', fields: {},
    })).toBe(
      'readTable cannot use the structure given for "accounts": the item selector ".a:::" is not '
      + 'a CSS selector',
    );
  });

  it('refuses an item selector matching more than 500 elements', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `<div class="row">${i}</div>`).join('');
    await load(`<div id="many">${many}</div>`);
    expect(await mappingRefusal('#many', [{ index: 1, key: 'a' }], {
      kind: 'collection', item: '.row', fields: { a: 'span' },
    })).toBe(
      'readTable cannot use the structure given for "many": the item selector ".row" matches 501 '
      + 'elements under "#many" — the maximum is 500',
    );
  });

  it('refuses an item selector whose matches nest inside each other', async () => {
    // One selector matching a container AND its contents reads every record
    // twice, once whole and once in pieces.
    await load(`
      <div id="boxes">
        <div class="box"><span class="value">outer</span>
          <div class="box"><span class="value">inner</span></div>
        </div>
      </div>`);
    expect(await mappingRefusal('#boxes', [{ header: 'V', key: 'v' }], {
      kind: 'collection', item: '.box', fields: { v: '.value' },
    })).toBe(
      'readTable cannot use the structure given for "boxes": the item selector ".box" matches 1 '
      + 'element inside another match — an item must not contain another item',
    );
  });

  it('honours limit over the rendered items', async () => {
    await load(cards());
    const result = await readTableRecords(page, {
      selector: '#accounts',
      columns: CARD_COLUMNS,
      limit: 2,
      mapping: CARD_MAPPING,
    });
    expect(result.records.map((r) => r['account'])).toEqual(['Everyday', 'Savings']);
    // The count in the log is what is THERE, not what was taken (§7.6).
    expect(result.dataRowCount).toBe(3);
  });
});
