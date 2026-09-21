// Browser-side extractor for `readTable`
// (docs/specs/SPEC-structured-table-reads.md §7).
//
// Loaded as a STRING by ../actions.ts, compiled there with `new Function` (in
// NODE, so no page Content-Security-Policy is involved) and handed to
// Playwright's `locator.evaluateAll`, which ships this source into the page.
//
// It lives outside the TypeScript sources on purpose. Under esbuild — `tsx`
// (`npm run dev`, `npm run dev:debug`) today, and phase 3's `tables.read`
// bundle next — `keepNames` rewrites every named helper inside a page callback
// into `__name(fn, "fn")`, and `__name` exists only in the bundle, never in
// the page: the whole extraction died with `ReferenceError: __name is not
// defined`. Every other action survived because its callbacks are anonymous
// one-liners. A file the bundler never reads cannot be rewritten, which is the
// same reason `find-in-dom.js` and `capture-dom.js` sit here.
//
// The file is ONE expression — an arrow function of (matches, args):
//   matches — the elements Playwright's locator matched, in DOM order.
//   args    — { selector, columns, limit, maxRows, rowKey }.
// It answers { ok: true, records, placeholdersSkipped, dataRowCount, label }
// or { ok: false, error } and never throws: a throw arrives at the caller as a
// Playwright evaluation error, which buries the message the author must read.
(matches, args) => {
  const {
    selector: sel,
    columns: wanted,
    limit: bound,
    maxRows,
    rowKey,
  } = args;

  // ── page-context helpers ─────────────────────────────────────────────────
  const all = matches;
  /** `Array.from` over a live DOM collection. */
  const items = (collection) => Array.from(collection);
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const styleOf = (el) => {
    const view = el.ownerDocument.defaultView;
    return view ? view.getComputedStyle(el) : null;
  };

  /**
   * Is this element rendered? Covers `display:none`, the `hidden` attribute
   * and a hidden/collapsed ancestor (none of which produce a client rect),
   * plus `visibility:hidden` (which does).
   *
   * `display: contents` is the one case where having no box of its own does
   * NOT mean invisible: the element generates no box, its children do. That
   * is the standard way to lay a semantic `<table>` out with CSS grid
   * (`table{display:grid} thead,tbody,tr{display:contents}`), and a
   * client-rect test alone dropped every `<tr>` of one — so the read stored
   * `[]` and the action SUCCEEDED, the outcome §2/§13.4 exist to prevent.
   */
  const rendered = (el) => {
    if (el.getClientRects().length > 0) {
      const boxed = styleOf(el);
      if (!boxed) return true;
      return boxed.visibility !== 'hidden' && boxed.visibility !== 'collapse';
    }
    const style = styleOf(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.display !== 'contents') return false;
    const children = items(el.children);
    for (const child of children) {
      if (rendered(child)) return true;
    }
    // A `display: contents` element with no element children is rendered when
    // it has text for the parent's layout to place.
    return children.length === 0 && squash(el.textContent || '') !== '';
  };

  /** Normalised header key: trimmed, collapsed and case-folded. The fold is
   *  load-bearing — the app's own table style upper-cases `<th>`, so
   *  `innerText` says ORDER ID where the author wrote Order ID (§7.3). */
  const fold = (s) => squash(s).toLowerCase();
  /** Rendered header text, falling back to `textContent` for a
   *  visually-hidden accessible heading (§7.3). */
  const headerTextOf = (cell) => {
    const shown = squash(cell.innerText || '');
    return shown !== '' ? shown : squash(cell.textContent || '');
  };
  /** Rendered cell text. A cell that is not rendered reads as "" — a hidden
   *  column keeps its position and contributes nothing (§10). `innerText`
   *  alone would not do: on an unrendered element it falls back to
   *  `textContent`, which would hand back the hidden value.
   *
   *  The `display: contents` fallback is the mirror of that: such a cell IS
   *  rendered (its content is), but it has no box for `innerText` to read, so
   *  Chromium answers "" for one holding plain text — a whole column of empty
   *  strings, stored and passed on. `textContent` is only reached for that
   *  case. */
  const cellTextOf = (cell) => {
    if (!rendered(cell)) return '';
    const shown = squash(cell.innerText || '');
    if (shown !== '') return shown;
    const style = styleOf(cell);
    return style && style.display === 'contents' ? squash(cell.textContent || '') : '';
  };
  /** Does this cell span more than its own square of the grid?
   *
   *  `rowSpan !== 1`, not `> 1`: `rowspan="0"` is legal HTML for "to the end
   *  of this row group", Chromium reports `el.rowSpan === 0` for it, and the
   *  rows below are shifted exactly as `rowspan="2"` shifts them. Read with
   *  `> 1` the whole grid came back misaligned and the action SUCCEEDED.
   *  `colSpan` has no such zero form — the parser clamps `colspan="0"` to 1. */
  const spanned = (cell) => cell.colSpan > 1 || cell.rowSpan !== 1;
  const plural = (n, one, many) => (n === 1 ? one : many);
  const fail = (error) => ({ ok: false, error });
  /** Quote a page-supplied string for a message. `JSON.stringify` rather than
   *  `"…"`, because an aria-label or caption may contain quotes of its own and
   *  `readTable cannot map table "The "Orders" table"` reads as nonsense. */
  const quoted = (s) => JSON.stringify(String(s));

  // ── 1. table selection (§7.2) ────────────────────────────────────────────
  const visible = all.filter(rendered);
  if (visible.length === 0) {
    return fail(
      all.length === 0
        ? `readTable could not find a table matching "${sel}"`
        : `readTable could not find a visible table matching "${sel}" (${all.length} `
          + `${plural(all.length, 'match', 'matches')}, none visible)`,
    );
  }
  if (visible.length > 1) {
    // No `.first()`: picking one of several would be the misalignment this
    // action exists to prevent, one table out instead of one column.
    return fail(
      `readTable found ${visible.length} visible elements matching "${sel}" — it must match `
      + `exactly one table, so use a more specific selector`,
    );
  }
  const el = visible[0];
  if (el.tagName !== 'TABLE') {
    return fail(
      `readTable requires a native <table> element, but "${sel}" matched a `
      + `<${el.tagName.toLowerCase()}> — ARIA grids and <div role="table"> are not supported`,
    );
  }
  const table = el;

  /** How the diagnostics name this table: its accessible name where it has
   *  one, else whatever the author can recognise it by. */
  const caption = table.caption;
  const label =
    table.getAttribute('aria-label')
    || (caption ? squash(caption.textContent || '') : '')
    || table.id
    || sel;
  const cannot = (why) => fail(`readTable cannot map table ${quoted(label)}: ${why}`);
  /** §5.3, verbatim, for a merged header AND for a merged body cell: both mean
   *  the same thing — that a guessed logical grid would be plausible and
   *  wrong. */
  const merged = () =>
    cannot('merged headers or cells (rowspan/colspan > 1) are not supported');

  // ── 2. rows belonging to THIS table (§7.4) ───────────────────────────────
  // `table.rows` is every `<tr>` whose parent is the table itself or one of
  // its direct `<thead>`/`<tbody>`/`<tfoot>` children, in tree order. The
  // parent test then keeps the body rows: rows under a direct `<tbody>` AND
  // rows placed directly under `<table>` — HTML source always gets a `<tbody>`
  // from the parser, but `table.appendChild(tr)` does not, and the earlier
  // `tBodies`-only scan read such a table as `[]`, green (§7.4). A nested
  // table's rows are not in this collection at all; `closest` keeps that
  // exclusion explicit, as §7.3 states it.
  const bodyRows = [];
  for (const row of items(table.rows)) {
    const parent = row.parentElement;
    if (!parent) continue;
    const direct =
      parent === table || (parent.tagName === 'TBODY' && parent.parentElement === table);
    if (!direct) continue;
    if (row.closest('table') !== table) continue;
    bodyRows.push(row);
  }

  /**
   * How wide the table is, measured over ALL body rows — rendered or not.
   *
   * The hidden rows are evidence of the grid's shape and nothing else left
   * says it: a table whose only rendered row is a full-width message, or one
   * whose every data row a filter has hidden, measures ONE column wide over
   * the visible rows, and then `<td colspan="7">No scheduled payments.</td>`
   * reads as a message in one table and a merged cell in the next by accident
   * of what was on screen. §4.8's placeholder rule asks this, and the
   * headerless width below is this, so it is measured once, here, over the
   * same rows. (§7.3's group-row step-over used to ask it too, and asking the
   * BODY's width there is what made it swallow a genuine one-cell header —
   * see `lastWideHeadingAt`, which is the question it actually has.)
   *
   * Taken BEFORE the header row is spliced out of `bodyRows`, which is safe:
   * the only reader that could see the difference is the headerless branch
   * below, and nothing is spliced when there is no header.
   */
  let widestBody = 0;
  for (const row of bodyRows) {
    if (row.cells.length > widestBody) widestBody = row.cells.length;
  }

  /**
   * The LAST body row that carries a `<th>` and is more than one cell wide,
   * by index; -1 when there is none.
   *
   * The one thing that tells a group heading apart from a genuine one-cell
   * header: a group heading has the row that names the columns BELOW it, and
   * a real header has only data below it. Measured once here because the
   * candidate search below asks it per candidate, and `> i` answers "is there
   * a later one" for every i at once. Such a row is always one the search
   * would consider anyway — carrying a `<th>` satisfies the rendered-or-
   * heading filter on its own.
   */
  let lastWideHeadingAt = -1;
  for (let i = 0; i < bodyRows.length; i++) {
    const cells = items(bodyRows[i].cells);
    if (cells.length > 1 && cells.some((c) => c.tagName === 'TH')) lastWideHeadingAt = i;
  }

  // ── 3. the header row (§7.3) ─────────────────────────────────────────────
  let headerRow = null;
  const thead = table.tHead;
  const headRows = thead && thead.parentElement === table ? items(thead.rows) : [];
  if (headRows.length > 0) {
    // Spans first, so the two-row merged header of §5.3 reports what it
    // actually is rather than "your header has 2 rows".
    for (const row of headRows) {
      for (const cell of items(row.cells)) {
        if (spanned(cell)) return merged();
      }
    }
    if (headRows.length > 1) {
      return cannot(`its header has ${headRows.length} rows, and v1 supports exactly one`);
    }
    headerRow = headRows[0] || null;
  }
  if (!headerRow) {
    // No header row in a `<thead>` — either because there is no `<thead>` at
    // all, or because there is an EMPTY one. The empty case is real: a
    // framework that renders `<thead></thead>` and puts the headings in the
    // first `<tbody>` row was read as headerless when this branch keyed on the
    // PRESENCE of the element, so a positional read made the heading text
    // record 1 and a header-named one failed with the §5.4 message.
    //
    // A body row is the header when it CONTAINS a `<th>`, has no `scope="row"`
    // cell, and is not a lone cell spanning more than one column (§7.3).
    //
    // "contains at least one `<th>`" is what admits
    // `<tr><td></td><th>Order ID</th><th>Status</th></tr>` — a checkbox cell
    // beside headings, which is what this app's own sortable tables look like.
    // Requiring EVERY cell to be a `<th>` missed it: a header-named read then
    // failed "it has no header row", and a positional one made the heading
    // text record 1 and left every `_row` off by one.
    // `scope="row"` marks that row's own heading (§10), not the table's, and a
    // lone spanning cell is a group or placeholder row (§4.8).
    //
    // Exactly ONE row is considered: the first that is RENDERED or carries a
    // `<th>`. Index 0 alone was not enough — a `display:none` template row,
    // the standard way to clone a row in plain JS, sat in front of the
    // headings and produced both failures above. Stopping at the first
    // rendered row keeps the original guard: a `<th>` further down — a
    // row-header column with no `scope` attribute is the realistic case —
    // cannot be reached and taken for the table's header, which would
    // silently delete a data row from the middle of the read.
    let first = null;
    let firstAt = -1;
    for (let i = 0; i < bodyRows.length; i++) {
      const row = bodyRows[i];
      if (!(rendered(row) || items(row.cells).some((c) => c.tagName === 'TH'))) continue;
      // One exception to "exactly one row is considered": a lone HEADING cell
      // narrower than the grid is a GROUP row, and a header is never narrower
      // than the table it names. `<tr><th>Section A</th></tr>` above the real
      // `<tr><th>Name</th><th>Status</th></tr>` was accepted as the header, so
      // the heading row became record 1 (`{_row:"1",name:"Name"}`) and every
      // real row was numbered one too high — §4.5's misalignment, arriving
      // through the door `lonelySpan` guards, which this shape walks past
      // because the cell carries no colspan at all.
      //
      // Stepping OVER it rather than refusing is what lets the search reach
      // the row that does name the columns, and the step is deliberately
      // narrow: only a row that carries a `<th>`, and so would otherwise have
      // been ACCEPTED here. A one-cell `<td>` row already ends the search with
      // no header (it has no heading in it), and that stays — stepping over
      // one could reach a `<th>` further down that is a row-header column,
      // silently deleting a data row from the middle of the read.
      //
      // And narrow in the other direction too: what makes this row a group
      // heading is the LATER, WIDER heading row it sits above, not the width
      // of the body. Asked as `widestBody > 1`, the step swallowed a genuine
      // one-cell header whose DATA rows are wider — §7.4's "extra cells are
      // harmless", as in `<tr><th>Order ID</th></tr>` above
      // `<tr><td>O-1</td><td><button>Delete</button></td></tr>`. That table
      // read as "it has no header row" by header, and by position made
      // `Order ID` record 1 and numbered every real row one too high: the
      // same §4.5 misalignment the step-over was added to prevent, produced
      // by the step-over itself.
      if (
        row.cells.length === 1
        && lastWideHeadingAt > i
        && items(row.cells).some((c) => c.tagName === 'TH')
      ) continue;
      first = row;
      firstAt = i;
      break;
    }
    if (first) {
      const cells = items(first.cells);
      const hasHeading = cells.some((c) => c.tagName === 'TH');
      const rowScoped = cells.some(
        (c) => (c.getAttribute('scope') || '').toLowerCase() === 'row',
      );
      const lonelySpan = cells.length === 1 && cells[0].colSpan > 1;
      if (cells.length > 0 && hasHeading && !rowScoped && !lonelySpan) {
        for (const cell of cells) {
          if (spanned(cell)) return merged();
        }
        headerRow = first;
        bodyRows.splice(firstAt, 1);
      }
    }
  }

  // ── 4. which rows are rendered, and how wide the table is ────────────────
  // The width the placeholder rule measures against is the header row's cell
  // count, or, with no header, `widestBody` — every body row, rendered or not
  // (§4.8, and see that measurement for why the hidden ones count).
  //
  // It is settled BEFORE any row is classified, because the classification
  // depends on it.
  const visibleRows = bodyRows.filter(rendered);
  const width = headerRow ? headerRow.cells.length : widestBody;

  // ── 5. resolve each column to a one-based position ───────────────────────
  const headerLabels = headerRow ? items(headerRow.cells).map(headerTextOf) : [];
  const resolved = [];
  for (const col of wanted) {
    if (typeof col.header === 'string') {
      if (!headerRow) {
        // §5.4, verbatim: the message's whole job is to name the way out.
        return cannot(
          `it has no header row, so "${col.header}" cannot be matched — name columns by `
          + `position ("the 1st column as ${col.key}")`,
        );
      }
      const want = fold(col.header);
      const hits = [];
      headerLabels.forEach((text, i) => {
        if (fold(text) === want) hits.push(i + 1);
      });
      if (hits.length === 0) {
        // Exact match only. A renamed header is a test failure worth reading;
        // a fuzzy match would quietly read the wrong column.
        const available = headerLabels.filter((t) => t !== '');
        return cannot(
          `no column is headed "${col.header}"`
          + (available.length > 0
            ? ` — available headers are ${available.join(', ')}`
            : ' — its header row has no non-empty headings'),
        );
      }
      if (hits.length > 1) {
        return cannot(
          `"${col.header}" matches ${hits.length} columns (positions ${hits.join(', ')}) — name `
          + `the one you mean by position`,
        );
      }
      resolved.push({ key: col.key, position: hits[0], header: col.header });
    } else {
      resolved.push({ key: col.key, position: col.index, header: null });
    }
  }

  // ── 6. data rows (§7.4) ──────────────────────────────────────────────────
  const dataRows = [];
  let placeholdersSkipped = 0;
  for (const row of visibleRows) {
    const cells = row.cells;
    // A placeholder is a message, not a grid: ONE cell spanning the whole
    // width of the table (§4.8).
    //
    // `>=`, not `===`: `<td colspan="99">No results</td>` is the common "span
    // all" idiom and it failed with the merged-cell message.
    //
    // `Math.max(width, 2)` is the whole rule for BOTH the headed and the
    // headerless case, and the floor of 2 is what keeps a ONE-column table's
    // ordinary rows out of the branch: `colSpan 1 >= 2` is false, so they are
    // data. An earlier `width > 1` guard did that by excluding one-column
    // tables from the rule altogether, which was wrong in the other
    // direction — a one-column table with a lone `colspan="2"` message row
    // then failed as a merged cell instead of answering `[]`. The floor says
    // what is actually meant: a lone cell that spans MORE than its own
    // column is a message.
    //
    // Checked BEFORE the merged-cell rule, which is what lets
    // `<td colspan="5">No documents uploaded yet.</td>` answer `[]` instead of
    // failing the read of an empty table.
    //
    // A row with NO cells is skipped the same way and counted the same way:
    // there is nothing in it to map and nothing to number, and failing a whole
    // read over a `<tr>` that renders as nothing would contradict §4.8. The
    // count is what keeps the skip observable in the log (§7.6).
    if (cells.length === 0 || (cells.length === 1 && cells[0].colSpan >= Math.max(width, 2))) {
      placeholdersSkipped++;
      continue;
    }
    dataRows.push(row);
  }

  if (bound === null && dataRows.length > maxRows) {
    return fail(
      `readTable cannot read table ${quoted(label)}: it has ${dataRows.length} visible data rows, `
      + `more than the ${maxRows}-row maximum — read a bounded window instead ("the first `
      + `${maxRows} visible rows") or narrow the table first`,
    );
  }
  // `limit` selects a PREFIX of the data rows, so a selected row's `_row` is
  // its index here plus one — the same number it would have had on an
  // unbounded read.
  const selected = bound === null ? dataRows : dataRows.slice(0, bound);

  // ── 7. cells (§7.4) ──────────────────────────────────────────────────────
  const records = [];
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    const rowNumber = i + 1;
    const cells = items(row.cells);
    // Cell-shape validation applies to SELECTED rows only: a malformed row
    // past the author's explicit bound is a row nobody asked for.
    for (const cell of cells) {
      if (spanned(cell)) return merged();
    }
    const record = {};
    // `_row` first, so the report and the Variables panel show it first.
    record[rowKey] = String(rowNumber);
    for (const col of resolved) {
      const cell = cells[col.position - 1];
      if (!cell) {
        // Never drop the row and never shift the values: a record whose fields
        // came from the wrong columns is exactly the failure this action
        // exists to make impossible.
        return cannot(
          `row ${rowNumber} has ${cells.length} ${plural(cells.length, 'cell', 'cells')}, so `
          + (col.header !== null
            ? `there is no cell for the "${col.header}" column at position ${col.position}`
            : `there is no cell at position ${col.position} for "${col.key}"`),
        );
      }
      record[col.key] = cellTextOf(cell);
    }
    records.push(record);
  }

  return {
    ok: true,
    records,
    placeholdersSkipped,
    dataRowCount: dataRows.length,
    label,
  };
}
