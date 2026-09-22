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
// It answers
// { ok: true, records, placeholdersSkipped, dataRowCount, label,
//   headerFromSeparateTable }
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

  // ── structure, asked of ANY table (§7.2, §7.3, §7.3a) ────────────────────
  // A split grid means the same three questions — where are the body rows,
  // where is the header row, is this half a grid — have to be asked of a
  // table that is not the one being read. They were inline before, answering
  // only for the selected table; a second copy for the partner is how one
  // header algorithm becomes two that drift (§9.2's whole argument).

  /**
   * §7.4's body rows of one table: rows whose parent is the table itself or
   * one of its direct `<tbody>` children, in tree order.
   *
   * HTML source always gets a `<tbody>` from the parser, but
   * `table.appendChild(tr)` does not, and the earlier `tBodies`-only scan read
   * such a table as `[]`, green. A nested table's rows are not in
   * `table.rows` at all; `closest` keeps that exclusion explicit, as §7.3
   * states it.
   */
  const bodyRowsOf = (t) => {
    const rows = [];
    for (const row of items(t.rows)) {
      const parent = row.parentElement;
      if (!parent) continue;
      const direct =
        parent === t || (parent.tagName === 'TBODY' && parent.parentElement === t);
      if (!direct) continue;
      if (row.closest('table') !== t) continue;
      rows.push(row);
    }
    return rows;
  };

  /**
   * Is this row a MESSAGE rather than a row of the grid — §4.8's shape, asked
   * with the cheap test that does not need the table's width: a lone cell
   * spanning more than its own column, a lone RENDERED one doing so with
   * unrendered fillers behind it (Kendo's group row, §5.6), or no cells at
   * all.
   *
   * Used only by §7.3a's width check, which must not measure a table by its
   * "No records available." row — that row is one cell wide whatever the grid
   * is, and counting it refused every emptied split grid as a mismatch. The
   * classification that decides what is DATA stays in §4.8's own rule below,
   * against the table's real width.
   */
  const messageRow = (row) => {
    const cells = items(row.cells);
    if (cells.length === 0) return true;
    if (cells.length === 1) return cells[0].colSpan > 1;
    const wide = cells.filter((c) => c.colSpan > 1);
    return (
      wide.length === 1
      && rendered(wide[0])
      && cells.every((c) => c === wide[0] || !rendered(c))
    );
  };

  /**
   * §7.3's header search, over one table and its body rows.
   *
   * Returns { row, index, refusal }: `index` is the row's position in `rows`
   * when the header came from the BODY (the caller splices it out), -1 from a
   * `<thead>`. `refusal` is a TOKEN — 'merged' or 'rows:<n>' — not a
   * sentence, because §7.3a runs this against a DIFFERENT table and the
   * message has to name the table being READ, not the one the header sits in.
   *
   * Nothing here decides anything new; it is the code that used to be inline,
   * moved so the adopted header of §7.3a goes through exactly these checks.
   */
  const findHeader = (t, rows) => {
    const none = { row: null, index: -1, refusal: null };
    const thead = t.tHead;
    const headRows = thead && thead.parentElement === t ? items(thead.rows) : [];
    if (headRows.length > 0) {
      // Spans first, so the two-row merged header of §5.3 reports what it
      // actually is rather than "your header has 2 rows".
      for (const row of headRows) {
        for (const cell of items(row.cells)) {
          if (spanned(cell)) return { row: null, index: -1, refusal: 'merged' };
        }
      }
      if (headRows.length > 1) {
        return { row: null, index: -1, refusal: `rows:${headRows.length}` };
      }
      return { row: headRows[0], index: -1, refusal: null };
    }
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

    /**
     * The LAST body row that carries MORE THAN ONE `<th>`, by index; -1 when
     * there is none.
     *
     * The one thing that tells a group heading apart from a genuine one-cell
     * header: a group heading has the row that names the columns BELOW it, and
     * a real header has only data below it. `> i` answers "is there a later
     * one" for every i at once. Such a row is always one the search would
     * consider anyway — carrying a `<th>` satisfies the rendered-or-heading
     * filter on its own.
     *
     * MORE THAN ONE, not "any", because a row naming the columns names them
     * ALL: `<td></td><th>Order ID</th><th>Status</th>` is a heading row beside
     * a checkbox, whereas ONE `<th>` among `<td>`s is a ROW header —
     * `<tr><th>O-1</th><td><button>Delete</button></td></tr>`, §7.3's
     * realistic case. Counted as "any", such a data row answered "yes, a wider
     * heading follows" for the genuine one-cell `<th>` header above it, which
     * was then stepped over: the first data row became the header (`available
     * headers are O-1, Delete`) and a positional read returned `Order ID` as
     * record 1 with the O-1 row gone from the middle — the §4.5 misalignment
     * the step-over exists to prevent, produced by the step-over itself.
     *
     * The residual limit is the mirror image, and far rarer: a real heading
     * row that carries a single `<th>` beside `<td>`s (`<tr><th>Name</th><td>
     * Actions</td></tr>`) is not recognised here, so a group row sitting above
     * IT is not stepped over. §7.3 states it.
     */
    let lastWideHeadingAt = -1;
    for (let i = 0; i < rows.length; i++) {
      const cells = items(rows[i].cells);
      if (cells.length > 1 && cells.filter((c) => c.tagName === 'TH').length > 1) {
        lastWideHeadingAt = i;
      }
    }

    let first = null;
    let firstAt = -1;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
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
      // narrow: only a ONE-CELL row that carries a `<th>`.
      //
      // Narrow is not the same as "a row this branch would otherwise have
      // ACCEPTED", which is what this said and §7.3 does not: the acceptance
      // test below also refuses a lone SPANNING cell (`lonelySpan`), so
      // `<tr><th colspan="3">Group A</th></tr>` is stepped over HERE and
      // would have been refused THERE. That is the right way round — a
      // spanned group row is dropped again a moment later as a placeholder
      // (§4.8, `colSpan >= max(width, 2)`), so ending the search on it would
      // mean refusing to look past a row that is about to leave the table
      // anyway.
      //
      // A one-cell `<td>` row already ends the search with
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
    if (!first) return none;
    const cells = items(first.cells);
    const hasHeading = cells.some((c) => c.tagName === 'TH');
    const rowScoped = cells.some(
      (c) => (c.getAttribute('scope') || '').toLowerCase() === 'row',
    );
    const lonelySpan = cells.length === 1 && cells[0].colSpan > 1;
    if (!(cells.length > 0 && hasHeading && !rowScoped && !lonelySpan)) return none;
    for (const cell of cells) {
      if (spanned(cell)) return { row: null, index: -1, refusal: 'merged' };
    }
    return { row: first, index: firstAt, refusal: null };
  };

  /**
   * One table, described the way §7.2 and §7.3a ask about it: its body rows,
   * its header row, the body rows that are LEFT once the header is taken out,
   * and whether it is **header-only** — a header and nothing under it.
   *
   * Kendo's header table is a `<thead>` with no `<tbody>` at all; a framework
   * that puts the headings in the first `<tbody>` row and nothing below them
   * qualifies the same way, which is why `body` is measured after the header
   * row is removed rather than by counting `<tr>`s.
   *
   * A table whose header REFUSES (a merged or two-row header) still counts as
   * having one: where the author POINTS at the pairing — a wrapper (§7.2), or
   * `aria-owns` (§7.3a.1) — it is half of a grid either way, and the refusal
   * is reported when it is adopted rather than making the table vanish from
   * the search. The beside-it path (§7.3a.2) narrows that to a header the
   * search FINDS, because there the table is evidence for the pairing rather
   * than a consequence of it; `candidatesUnder` is where that is asked.
   */
  const classify = (t) => {
    const rows = bodyRowsOf(t);
    const head = findHeader(t, rows);
    const body = head.index >= 0 ? rows.filter((_, i) => i !== head.index) : rows;
    const hasHeader = head.row !== null || head.refusal !== null;
    return { table: t, rows, head, body, headerOnly: hasHeader && body.length === 0 };
  };

  /**
   * `classify`, asked once per table.
   *
   * §7.3a asks the same question about the same tables from both sides: the
   * header-only pick runs the beside-it search from every candidate row
   * table, and each of those searches classifies every table at every
   * ancestor level it walks. `findHeader` costs a computed style per row it
   * considers, so the repeat is the difference between one pass and a
   * quadratic one on a page of many tables.
   */
  const classifications = new Map();
  const classified = (t) => {
    let info = classifications.get(t);
    if (!info) {
      info = classify(t);
      classifications.set(t, info);
    }
    return info;
  };

  /** Does `a` start before `b` in document order? */
  const precedes = (a, b) => (a.compareDocumentPosition(b) & 4) !== 0;

  /** Does `node` END before `t` STARTS — is it strictly outside and before it?
   *  Bit 4 is FOLLOWING (t comes after node), bit 16 is CONTAINED_BY (t is
   *  inside node, so node has not ended at all). */
  const endsBefore = (node, t) => {
    const pos = node.compareDocumentPosition(t);
    return (pos & 4) !== 0 && (pos & 16) === 0;
  };

  /** The tables under `root` that are not nested inside another table under it
   *  (§7.2), in document order. A table in a cell of another belongs to that
   *  table, not to the grid.
   *
   *  Remembered per root for the same reason `classified` is: §7.3a's two
   *  searches ask this of the same handful of ancestors over and over, and
   *  each answer is a `querySelectorAll` over everything below. */
  const tablesByRoot = new Map();
  const tablesUnder = (root) => {
    let found = tablesByRoot.get(root);
    if (found) return found;
    found = items(root.querySelectorAll('table')).filter((t) => {
      const outer = t.parentElement ? t.parentElement.closest('table') : null;
      return !(outer && root.contains(outer));
    });
    tablesByRoot.set(root, found);
    return found;
  };

  /**
   * Is this table inside ANOTHER table, anywhere above it?
   *
   * `tablesUnder`'s question asked with no root, which is the form §7.3a's
   * beside search needs. Relative to the ancestor that search walks to, two
   * tables sitting in two CELLS of an enclosing layout table are each "not
   * nested inside a table under it" — the enclosing table IS that ancestor,
   * or is above it — so they looked like the two halves of one grid and a
   * read of the second took the first's headings. The same test throws out
   * the mirror shape: a table inside a `<th>` of a header-only table, which
   * adopted the header it was sitting in.
   */
  const insideATable = (t) => !!(t.parentElement && t.parentElement.closest('table'));

  /** The text `aria-labelledby` resolves to, or "". A DANGLING reference —
   *  an id that is not on the page — names nothing, and counted as a name it
   *  stopped a real grid from pairing (§7.3a). */
  const labelledByText = (el2) => {
    const by = el2.getAttribute('aria-labelledby');
    if (!by) return '';
    const parts = [];
    for (const id of by.split(/\s+/)) {
      const named = id ? el2.ownerDocument.getElementById(id) : null;
      if (named) parts.push(squash(named.textContent || ''));
    }
    return squash(parts.join(' '));
  };

  /**
   * A table that names ITSELF is a whole table, not half of a grid (§7.3a).
   * The name a wrapper carries is fine — that one is the grid's.
   *
   * Each of the three has to be a name that SAYS something: an empty
   * `<caption>` and an `aria-labelledby` pointing at an id that is not on the
   * page are both markup a grid widget leaves behind, and taken for names
   * they left a genuine split grid unpaired and headerless.
   */
  const selfNamed = (t) =>
    squash(t.getAttribute('aria-label') || '') !== ''
    || (!!t.caption && squash(t.caption.textContent || '') !== '')
    || labelledByText(t) !== '';

  /** The accessible name of a non-table element, for the label (§7.2 point 4)
   *  and for the selector a refusal suggests. */
  const wrapperName = (el2) => {
    const aria = squash(el2.getAttribute('aria-label') || '');
    if (aria !== '') return aria;
    const by = labelledByText(el2);
    if (by !== '') return by;
    return el2.id || '';
  };

  /** A page-supplied value as a CSS string, for an attribute selector. Single
   *  quotes: the whole selector goes inside a double-quoted parenthetical,
   *  and `("[aria-label="Dividends"]")` cannot be told where it ends. */
  const cssString = (value) =>
    `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

  /**
   * How a refusal spells the wrapper so the author can paste it (§7.3a's
   * header-only pick). `null` when it has nothing to be named by, and then
   * the message drops the parenthetical rather than inventing a selector.
   *
   * The id goes through `CSS.escape`, because a grid widget's wrapper id is
   * routinely a GUID and `#14277be2-grid` is not a selector at all — a
   * leading digit starts a number, so `querySelector` throws on it — and the
   * sentence would be handing the author something that cannot be pasted.
   * `[id='…']` is the same selector written without the escape, for a page
   * where `CSS` is not there to ask.
   *
   * What this returns is a SELECTOR, and the caller quotes it as it stands:
   * run through `quoted` (`JSON.stringify`) it came back as
   * `"#\\31 4277be2-grid"`, an escape of the escape, which is a different
   * selector and matches nothing.
   */
  const wrapperSelector = (el2) => {
    if (el2.id) {
      const view = el2.ownerDocument.defaultView;
      const css = view ? view.CSS : null;
      return css && typeof css.escape === 'function'
        ? `#${css.escape(el2.id)}`
        : `[id=${cssString(el2.id)}]`;
    }
    const aria = el2.getAttribute('aria-label');
    return aria ? `[aria-label=${cssString(aria)}]` : null;
  };

  /**
   * What breaks the CONTIGUITY of a grid under `root`: the LAST thing before
   * `t` that a header table cannot be on the far side of (§7.3a), or null.
   *
   * Two things tell two tables that merely sit near each other apart from the
   * two halves of one grid:
   *
   *  - rendered text OUTSIDE a table. A fixed-header grid has none between
   *    its halves; two tables under a heading have the heading. Text INSIDE a
   *    table is not a separator: Kendo's frozen grid puts its second header
   *    table between the first header and the rows, and counted as text that
   *    table's own column titles separated every locked grid from its rows.
   *  - a table WITH ROWS. A data table between a header and these rows is
   *    that header's partner, not something to look past.
   *
   * What counts is a property of the node alone, so the subtree is walked
   * ONCE per ancestor and the answer for a particular table is the last entry
   * that ends before it — which is what keeps a page of many tables
   * near-linear. Asked per candidate, the walk ran once per candidate row
   * table in the header-only pick, and a page of 400 tables took 1.3s.
   *
   * A candidate is contiguous with `t` exactly when this node is not after
   * it, because every position between a candidate's start and its end
   * belongs to its own descendants.
   */
  const separatorsByRoot = new Map();
  const separatorsUnder = (root) => {
    let found = separatorsByRoot.get(root);
    if (found) return found;
    found = [];
    // 4 is `NodeFilter.SHOW_TEXT`, spelled as the number because this file is
    // evaluated as source in the page and the constants it uses should not
    // depend on a global the page could have shadowed.
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    let node = walker.nextNode();
    while (node) {
      if (squash(node.nodeValue || '') !== '') {
        const holder = node.parentElement;
        if (holder && !holder.closest('table') && rendered(holder)) found.push(node);
      }
      node = walker.nextNode();
    }
    for (const other of tablesUnder(root)) {
      if (classified(other).body.length > 0) found.push(other);
    }
    // Two lists, each already in document order, so the sort only interleaves
    // them — and the caller reads the list from the end, which needs it.
    found.sort((a, b) => (precedes(a, b) ? -1 : 1));
    separatorsByRoot.set(root, found);
    return found;
  };
  const lastSeparatorBefore = (root, t) => {
    const found = separatorsUnder(root);
    for (let i = found.length - 1; i >= 0; i--) {
      if (endsBefore(found[i], t)) return found[i];
    }
    return null;
  };

  /** Is `candidate` contiguous with the table the separator was measured
   *  against? Only a separator AFTER its end counts — one inside it is its
   *  own content. */
  const contiguous = (candidate, separator) =>
    separator === null || !(precedes(candidate, separator) && !candidate.contains(separator));

  /**
   * The header-only tables beside `t` under `root` — §7.3a's candidates.
   *
   * Every per-table condition first, and the contiguity question — the one
   * that looks at what lies BETWEEN two tables, and the only expensive one —
   * asked once, and only if a candidate survived the rest.
   */
  const candidatesUnder = (root, t) => {
    const cheap = [];
    for (const other of tablesUnder(root)) {
      if (other === t || other.contains(t) || !precedes(other, t)) continue;
      // The remembered classification first, so the repeat of this scan — once
      // per candidate row table in the header-only pick — costs a map lookup
      // for every table that is not a header, rather than a computed style.
      const info = classified(other);
      // On THIS path "header-only" means §7.3's search FINDS a header row. A
      // table whose header is refused — two rows, a spanned cell — is half of
      // a grid when the author POINTS at the pairing (a wrapper, or
      // `aria-owns`), and that refusal is then reported; but it is no
      // evidence that these two tables are one grid, and treated as a
      // candidate it failed the read of the plain table that merely sat
      // after it.
      if (!(info.headerOnly && info.head.row !== null)) continue;
      if (insideATable(other) || selfNamed(other) || !rendered(other)) continue;
      cheap.push(info);
    }
    if (cheap.length === 0) return cheap;
    const separator = lastSeparatorBefore(root, t);
    return cheap.filter((info) => contiguous(info.table, separator));
  };

  /** The nearest element holding both tables — what the label and the
   *  header-only pick name when the tables themselves have no name. */
  const commonAncestor = (a, b) => {
    let anc = a.parentElement;
    while (anc && !anc.contains(b)) anc = anc.parentElement;
    return anc;
  };

  /** §7.3a.1: the table whose header this one's `aria-owns` names. Kendo
   *  writes `aria-owns="<header thead id> <own tbody id>"` on the ROW table,
   *  which is the page saying outright which header is this table's. */
  const declaredHeaderSource = (t) => {
    const owns = (t.getAttribute('aria-owns') || '').trim();
    if (owns === '') return null;
    const doc = t.ownerDocument;
    for (const id of owns.split(/\s+/)) {
      const owned = id ? doc.getElementById(id) : null;
      if (!owned) continue;
      if (owned.tagName !== 'THEAD' && owned.tagName !== 'TR') continue;
      const home = owned.closest('table');
      if (home && home !== t) return home;
    }
    return null;
  };

  /**
   * §7.3a.2: the header-only tables BESIDE `t` — none, the one to adopt, or
   * the two that mean a grid with frozen (locked) columns, which the caller
   * refuses rather than reading half of.
   *
   * The walk stops at the first ancestor under which a candidate PRECEDES
   * `t`, not at the first that holds any other table at all. Kendo's
   * locked-columns grid is why: its two row tables share
   * `div.k-grid-container` and its two header tables share
   * `div.k-grid-header`, so a walk that stopped at the first table-bearing
   * ancestor stopped inside the row half, saw no header-only table, and left
   * the table headerless — and a POSITIONAL read of it then quietly returned
   * half a grid, which is the one outcome §7.3a promises never to produce.
   *
   * The walk stays BELOW `<body>`: the body element is the page, not a grid
   * container, and a walk that reached it made every headerless table on a
   * page a candidate to adopt the headings of every table above it — an
   * empty `<thead>`-only table in one section donated its headings to an
   * unrelated table in the next, which the text between them happened to
   * block and nothing else would have.
   */
  const besideHeaderSource = (t) => {
    // A table that names itself is a WHOLE table (§7.3a), so no partner is
    // looked for at all — not even far enough to find two and refuse, which
    // is the one way a name could otherwise end a read.
    if (selfNamed(t)) return [];
    let anc = t.parentElement;
    while (anc && anc.tagName !== 'BODY') {
      const found = candidatesUnder(anc, t);
      if (found.length > 0) return found;
      anc = anc.parentElement;
    }
    return [];
  };

  /**
   * §7.3a.3, the other way round: the table holding the rows that belong to
   * header-only table `t`, when there is one.
   *
   * Either that table names `t`'s header through its own `aria-owns` —
   * wherever it sits, before or after — or it is a headerless table with rows
   * after `t` that would have adopted `t`'s header from beside. The second is
   * asked by running the beside-it search from ITS side rather than restating
   * those conditions backwards, so the refusal fires exactly when selecting
   * that table would have paired the two — one rule, not a mirror of one that
   * can drift out of step. This walk stopping below `<body>` decides nothing
   * on its own — the search it defers to already stops there, so a row table
   * only reachable across `<body>` could not adopt this header anyway — it
   * just keeps the scan off the rest of the page.
   *
   * Returns { partner, frozen }. `frozen` is the case that made this half of
   * the section a BLOCKER: when the row table's beside search finds two
   * header-only candidates and `t` is one of them, selecting `t` cannot be
   * answered with `[]` either — those two tables are the split header of a
   * grid with frozen (locked) columns, and every way into that grid is
   * refused (§7.3a, §14). Read as an empty table, the header halves of a
   * frozen grid passed green with nothing read.
   */
  const rowPartnerOf = (t) => {
    const doc = t.ownerDocument;
    for (const other of items(doc.querySelectorAll('table[aria-owns]'))) {
      if (other !== t && declaredHeaderSource(other) === t) {
        return { partner: other, frozen: false };
      }
    }
    let anc = t.parentElement;
    while (anc && anc.tagName !== 'BODY') {
      for (const other of tablesUnder(anc)) {
        if (other === t || t.contains(other) || !precedes(t, other)) continue;
        if (!rendered(other)) continue;
        const info = classified(other);
        if (info.body.length === 0) continue;
        if (info.head.row !== null || info.head.refusal !== null) continue;
        const beside = besideHeaderSource(other);
        if (beside.length === 1 && beside[0].table === t) {
          return { partner: other, frozen: false };
        }
        if (beside.length > 1 && beside.some((info2) => info2.table === t)) {
          return { partner: other, frozen: true };
        }
      }
      anc = anc.parentElement;
    }
    return { partner: null, frozen: false };
  };

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

  /**
   * The grid WRAPPER, when one is in play (§5.6): the matched element itself
   * when it is not a table, and otherwise the element holding both halves
   * once a header is adopted from another table (§7.3a), which is discovered
   * further down.
   *
   * It exists for the diagnostics as much as for the search. Kendo's own
   * tables carry `role="none"` and no accessible name at all, so without the
   * wrapper's name a failure reads `cannot map table "#holdings-grid
   * .k-grid-content table"` — the selector, not the grid (§7.2 point 4).
   */
  let wrapper = el.tagName === 'TABLE' ? null : el;
  /** Every table under that wrapper, classified — kept so the header search
   *  below does not walk the grid a second time. */
  let wrapperTables = [];
  let table;
  /** The selected table, already classified on the wrapper path. */
  let picked = null;

  if (!wrapper) {
    table = el;
  } else {
    // §7.2: any non-table match is a grid wrapper. The tables under it that
    // are not nested inside another one are the grid's halves; exactly one of
    // them has body rows and that is the table to read. A footer table —
    // a `<tfoot>` alone, neither rows nor a header — is neither and is
    // ignored, which is why this counts rows rather than tables.
    //
    // Unrendered tables are left out for the same reason the matched element
    // must be visible: a `display:none` table is not part of the grid on
    // screen, and counting one would refuse a live grid as ambiguous.
    wrapperTables = tablesUnder(wrapper).filter(rendered).map(classified);
    const withRows = wrapperTables.filter((info) => info.body.length > 0);
    if (withRows.length === 0) {
      // A `<div role="grid">` of `<div role="row">`s lands here: still
      // unsupported (§3), now said in terms of what was looked for.
      return fail(`readTable found no table with rows under "${sel}"`);
    }
    if (withRows.length > 1) {
      // Never `.first()`: a grid with frozen (locked) columns renders its
      // rows TWICE, split by column across two tables, so reading one half is
      // exactly the misalignment this action exists to prevent (§7.3a, §14).
      return fail(
        `readTable found ${withRows.length} tables with rows under "${sel}" — it must be exactly `
        + `one; a grid with frozen (locked) columns splits its rows across two tables, which is `
        + `not supported`,
      );
    }
    picked = withRows[0];
    table = picked.table;
  }

  /**
   * How the diagnostics name this table (§7.2 point 4), in order: the table's
   * own ACCESSIBLE name — `aria-label`, `<caption>`, then what
   * `aria-labelledby` points at — then the GRID's name, then the table's
   * `id`, then the selector.
   *
   * The grid beats the table's id, which looks backwards until you read the
   * markup: Kendo's row table carries `id="14277be2-015b-4257-bd9e-…"`, a
   * generated GUID that names nothing to anyone, while the wrapper carries
   * the app's own `#holdings-grid`. An accessible name on the table is
   * different — somebody wrote it about that table — so it still wins.
   *
   * Reassigned when the grid is discovered later (a header adopted from
   * another table, §7.3a), which is why `cannot` reads the variable rather
   * than closing over a copy — and why that discovery happens BEFORE the
   * refusals that follow it, which otherwise name a grid by its row table's
   * GUID.
   */
  const caption = table.caption;
  const ownName =
    squash(table.getAttribute('aria-label') || '')
    || (caption ? squash(caption.textContent || '') : '')
    || labelledByText(table);
  const nameNow = () => ownName || (wrapper ? wrapperName(wrapper) : '') || table.id || sel;
  let label = nameNow();
  const cannot = (why) => fail(`readTable cannot map table ${quoted(label)}: ${why}`);
  /** Adopt `found` as the grid now that it is known to hold both halves, and
   *  rename the table after it. */
  const nameAfterWrapper = (found) => {
    if (!found) return;
    wrapper = found;
    label = nameNow();
  };
  /** §5.3, verbatim, for a merged header AND for a merged body cell: both mean
   *  the same thing — that a guessed logical grid would be plausible and
   *  wrong. */
  const merged = () =>
    cannot('merged headers or cells (rowspan/colspan > 1) are not supported');
  /** Turn one of `findHeader`'s refusal TOKENS into the sentence, now that
   *  there is a label to name. The token exists because the same search runs
   *  against a table that is not the one being read (§7.3a), and the message
   *  must still name the table the author asked for. */
  const headerRefusal = (info) =>
    info.refusal === 'merged'
      ? merged()
      // `'rows:'.length` — the token carries the count the sentence needs.
      : cannot(`its header has ${info.refusal.slice(5)} rows, and v1 supports exactly one`);

  // ── 2. rows belonging to THIS table (§7.4) ───────────────────────────────
  // A COPY on the wrapper path: the header row is spliced out below, and
  // `picked` is the classification `classified` remembers — §7.3a asks about
  // this same table again from the other side, and it must not be asked about
  // a row list this read has since edited.
  const bodyRows = picked ? picked.rows.slice() : bodyRowsOf(table);

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

  // ── 3. the header row (§7.3), and where it comes from (§7.3a) ────────────
  const own = picked ? picked.head : findHeader(table, bodyRows);
  if (own.refusal !== null) return headerRefusal(own);
  let headerRow = own.row;
  /** Did the header come from a DIFFERENT table (§7.3a)? The summary line says
   *  so (§7.6): a wrong pairing is otherwise invisible in the log, and the
   *  records it produces look exactly like a correct read. */
  let headerFromSeparateTable = false;
  if (headerRow && own.index >= 0) bodyRows.splice(own.index, 1);

  if (!headerRow) {
    // §7.3a: a table with no header of its own may take one from another
    // table — the grid of §5.6, where the header and the rows are separate
    // `<table>` elements. A header IN the table always wins, which is why this
    // whole branch is reached only when the search above found none.
    let source = null;
    let ambiguous = 0;
    // What the page DECLARES beats what merely sits beside it (§7.3a.1 before
    // §7.3a.2) — on BOTH paths. Asked only of the tables under the wrapper,
    // the wrapper answered differently from the row table's own selector for
    // the same grid: a wrapper whose header table follows its rows read as
    // headerless while `#rows` read the grid correctly, because `aria-owns`
    // is the one thing that says which half is which whatever the DOM order.
    const declared = declaredHeaderSource(table);
    if (declared) {
      source = classified(declared);
    } else if (wrapper) {
      // Naming the wrapper is the author asserting that these tables belong
      // together, so §7.3a's name and contiguity conditions do not apply here
      // (§7.2 point 3) — only "the one header-only table before it".
      const before = wrapperTables.filter(
        (info) => info.headerOnly && precedes(info.table, table),
      );
      if (before.length > 1) ambiguous = before.length;
      else source = before[0] || null;
    } else {
      const beside = besideHeaderSource(table);
      if (beside.length > 1) ambiguous = beside.length;
      else source = beside[0] || null;
    }
    if (ambiguous > 0) {
      // Two header tables for one row table is the frozen-columns shape seen
      // from the row table's side — the same grid the wrapper path refuses by
      // counting tables with rows (§7.3a, "what this does not read").
      //
      // `beside "<label>"` rather than `beside table "<label>"`: the label is
      // the GRID's name as often as the table's (§7.2 point 4), and calling a
      // wrapper a table is the kind of small lie that sends an author looking
      // for the wrong element.
      return fail(
        `readTable found ${ambiguous} header-only tables beside ${quoted(label)} — it must be `
        + `exactly one; a grid with frozen (locked) columns splits its header across two tables, `
        + `which is not supported`,
      );
    }
    if (source) {
      // Both halves are known, so the element holding them is the grid and
      // the diagnostics name the table after it (§7.2 point 4) — BEFORE the
      // two refusals below, which otherwise name the grid by the row table's
      // generated GUID (`cannot map table "14277be2-015b-…"`).
      if (!wrapper) nameAfterWrapper(commonAncestor(table, source.table));
      // The adopted row goes through §7.3's own checks, in the table it lives
      // in: a spanned or two-row header is refused exactly as a native one is.
      if (source.head.refusal !== null) return headerRefusal(source.head);
      const adopted = source.head.row;
      if (adopted) {
        // The widths must line up, because a header one column off is §4.5's
        // misalignment wearing a plausible face. Measured over the rows that
        // hold a GRID: a body of nothing but full-width message rows (the
        // grouped grid's "No records available." row, §4.8) is one cell wide
        // and has nothing to misalign, so it is no evidence either way —
        // counted, it refused every emptied grid as a mismatch.
        let widestData = 0;
        let dataShaped = 0;
        for (const row of bodyRows) {
          if (messageRow(row)) continue;
          dataShaped++;
          if (row.cells.length > widestData) widestData = row.cells.length;
        }
        if (dataShaped > 0 && adopted.cells.length !== widestData) {
          // "the header table", not "the header in the table beside it": the
          // same check runs on the DECLARED path, where the header table is
          // wherever `aria-owns` pointed and need not be beside anything.
          return cannot(
            `the header table has ${adopted.cells.length} `
            + `${plural(adopted.cells.length, 'cell', 'cells')} but its widest row has `
            + `${widestData} — the two tables do not line up`,
          );
        }
        headerRow = adopted;
        headerFromSeparateTable = true;
      }
    }
  } else if (!wrapper && bodyRows.length === 0) {
    // §7.3a.3, the header-only pick. This table holds the header row and
    // nothing else, and the rows are in a table that names this header through
    // `aria-owns` or would have adopted it from beside. It is the selector a
    // model reaches for first — the table where it can SEE the words "Order
    // ID" — and storing `[]` for it is a green step that read nothing, which
    // is the outcome this action exists to make impossible. With no such
    // partner, a header with no rows is simply an empty table and still reads
    // `[]` (§4.8).
    const partner = rowPartnerOf(table);
    if (partner.partner) {
      // Named after the grid before either sentence is built, so a Kendo
      // failure says `#holdings-grid` and not a GUID (§7.2 point 4).
      nameAfterWrapper(commonAncestor(table, partner.partner));
      if (partner.frozen) {
        // Two header tables for the rows beside them: this table is one half
        // of a split header, and there is no half of a grid to read (§14).
        return fail(
          `readTable cannot read table ${quoted(label)}: it holds only the header row of a grid `
          + `with frozen (locked) columns, which is not supported`,
        );
      }
      const where = wrapper ? wrapperSelector(wrapper) : null;
      // "beside it", not "after it": `aria-owns` pairs a header table that
      // FOLLOWS its rows just as readily, and the sentence has to be true of
      // the grid the author is looking at.
      return fail(
        `readTable cannot read table ${quoted(label)}: it holds only the header row; the rows `
        + `are in the table beside it — select the element that contains both`
        + (where ? ` ("${where}")` : '')
        + ` or that table`,
      );
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
    const full = Math.max(width, 2);
    if (cells.length === 0 || (cells.length === 1 && cells[0].colSpan >= full)) {
      placeholdersSkipped++;
      continue;
    }
    // The same row, written the way a grid widget writes it (§4.8, §7.4):
    // Kendo's group row is `<td colspan="6">Year: 2026</td>` followed by five
    // `<td hidden>` filler cells, so it has SIX cells and one rendered one.
    // Counted as six it reached the merged-cell rule below and failed the
    // whole read of a grouped grid — a read of the Dividends grid could not
    // be done at all.
    //
    // Guarded by "is there a full-width cell here at all", which is a cheap
    // attribute test: an ordinary row never has one, so the `rendered()` scan
    // (a computed style per cell) does not run on the 500-row case.
    if (cells.length > 1) {
      const list = items(cells);
      const wide = list.filter((c) => c.colSpan >= full);
      if (
        wide.length === 1
        && rendered(wide[0])
        && list.every((c) => c === wide[0] || !rendered(c))
      ) {
        placeholdersSkipped++;
        continue;
      }
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
    headerFromSeparateTable,
  };
}
