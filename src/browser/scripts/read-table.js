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
//   args    — { selector, columns, limit, maxRows, rowKey, mapping,
//               maskValues, sketchOnly }.
// It answers
// { ok: true, records, placeholdersSkipped, dataRowCount, label,
//   headerFromSeparateTable, structure, fieldsMissing }
// or { ok: false, error, shape, sketch } and never throws: a throw arrives at
// the caller as a Playwright evaluation error, which buries the message the
// author must read.
//
// Three things live here that the tag names alone do not explain:
//
//  - §7.9's ARIA table model. A `div[role="grid"]` of `role="row"` /
//    `role="gridcell"` is a table in everything but tag names. It is read by
//    the SAME code as a `<table>`: every rule below §7.3's header SEARCH runs
//    against "row views" a provider builds, so the header grid, the
//    placeholder and detail rules, the naming, the stamp and the records loop
//    are one algorithm with two providers rather than two copies that drift.
//  - §7.10's sketch. When a read fails for a SHAPE reason — nothing with rows
//    under the region, two things with rows, no header found at all — the
//    refusal carries a description of what IS there, so the caller can ask the
//    model to name the parts once. Every other refusal (a header typo, a short
//    row, a merged cell, too many rows, an ambiguous selector) is the author's
//    own problem and carries none.
//  - §7.10's `mapping`, the validated answer to that question, replayed
//    deterministically: `{ kind: 'table', rows, header }` pins the tables the
//    search would have looked for, and `{ kind: 'collection', item, fields }`
//    reads repeated elements that are not a table at all.
//
// It also writes ONE thing to the page: `data-aiui-row` on the rows it
// numbered (§7.4, step 8), so that "row 7 of the Orders table" is a selector a
// later step can use rather than a sum it has to do. Only a read that
// SUCCEEDS writes it.
(matches, args) => {
  const {
    selector: sel,
    columns: wanted,
    limit: bound,
    maxRows,
    rowKey,
    // §7.10: the validated structure, when this read is replaying one. Absent
    // on an ordinary read, which searches for the table itself.
    mapping,
    // Where that mapping came from — `model`, `memo` or `cache` — so the one
    // summary line §7.6 writes can say it. The extractor cannot know: a
    // mapping the model answered a moment ago and one read back off disk are
    // the same object by the time they get here, and "structure from the
    // model" printed over a cached replay is a line that says a model call
    // happened when none did.
    structureSource,
    // §7.6's secret set, for the sketch's cell text ONLY. The sketch is the
    // one place this extractor quotes page CONTENT back to the caller, and it
    // goes to a model and to the debug log.
    maskValues,
    // Build the sketch and answer with it, reading nothing. What
    // `sketchTable()` calls for the re-ask path (§7.10's "asked once more").
    sketchOnly,
  } = args;

  // ── page-context helpers ─────────────────────────────────────────────────
  const all = matches;
  /** The attribute this read leaves on the rows it numbered (§7.4, step 8). */
  const ROW_STAMP = 'data-aiui-row';
  /**
   * Number `rows` 1..N inside `root`, clearing whatever was there.
   *
   * Cleared over every DESCENDANT carrying the stamp, not over a row list: a
   * nested table inside a detail row is not in `table.rows`, so a stamp an
   * earlier read of THAT table left behind survived a row-list clear, and
   * `#outer [data-aiui-row="2"]` then matched the nested row as well as the
   * real one. The root itself is never stamped and never cleared — it is not
   * one of its own rows.
   */
  const stampRows = (root, rows) => {
    for (const stamped of items(root.querySelectorAll(`[${ROW_STAMP}]`))) {
      stamped.removeAttribute(ROW_STAMP);
    }
    for (let i = 0; i < rows.length; i++) {
      rows[i].setAttribute(ROW_STAMP, String(i + 1));
    }
  };
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
  /**
   * Rendered header text, falling back to `textContent` for a visually-hidden
   * accessible heading (§7.3) — RadGrid's expand column renders nothing and
   * carries `<span style="display:none">ExpandColumn</span>`, which is the
   * name it would be read out by.
   *
   * What a FIELD holds is not a heading, though (§7.3b.3). A filter row's
   * cells hold inputs and selects, and a `<select>` renders its options — so
   * the Status filter's "All" became the name of the Status column, one row
   * below the word Status, and every read of that column failed "no column is
   * headed". An `<input>` and a `<textarea>` contribute nothing to `innerText`
   * in the first place (measured: a `<textarea>`'s content is its VALUE, and
   * `innerText` is "" for it); a `<select>` contributes its option text, which
   * is a value rather than a label.
   *
   * So the heading is the cell's OWN rendered text: `innerText` with each
   * control's `innerText` subtracted out of it as a string. `innerText`
   * rather than a text-node walk is the whole point — a walk reads
   * `display:none` text, so `<th>Status<span style="display:none">SORTKEY
   * </span><input type="hidden"></th>` was named `StatusSORTKEY`. A
   * `<button>` is deliberately left in: a sortable header's title is
   * routinely inside one, and dropping it would leave that column nameless.
   *
   * The accessible-name fallback below is for a cell that renders NOTHING.
   * A cell holding a RENDERED control renders something — it just is not a
   * heading — so it names nothing rather than falling through: RadGrid's
   * filter cell is `<td><input><span style="display:none">Filter Name</span>
   * </td>`, and the fallback read that hidden span as the column's name, one
   * row below the real one. A control that is not rendered (`<input
   * type="hidden">`) is no such evidence and does not block the fallback,
   * which is why the walk still skips the three tags: a `display:none`
   * `<select>` answers `innerText` with its options and would otherwise
   * donate them as the heading. `OPTION` is not in that list because `SELECT`
   * is — the walk never descends into one.
   */
  const headerTextOf = (cell) => {
    const controls = items(cell.querySelectorAll('input, select, textarea'));
    let text = squash(cell.innerText || '');
    for (const control of controls) {
      const value = squash(control.innerText || '');
      if (value === '') continue;
      const at = text.indexOf(value);
      if (at >= 0) text = squash(`${text.slice(0, at)} ${text.slice(at + value.length)}`);
    }
    if (text !== '') return text;
    if (controls.some(rendered)) return '';
    let out = '';
    const walk = (node) => {
      for (const child of items(node.childNodes)) {
        // 3 is `Node.TEXT_NODE`, 1 is `Node.ELEMENT_NODE`, spelled as numbers
        // because this file is evaluated as source in the page and should not
        // depend on a global the page could have shadowed.
        if (child.nodeType === 3) { out += child.nodeValue || ''; continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') continue;
        walk(child);
      }
    };
    walk(cell);
    return squash(out);
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
   *  `down !== 1`, not `> 1`: `rowspan="0"` is legal HTML for "to the end
   *  of this row group", Chromium reports `el.rowSpan === 0` for it, and the
   *  rows below are shifted exactly as `rowspan="2"` shifts them. Read with
   *  `> 1` the whole grid came back misaligned and the action SUCCEEDED.
   *  `colSpan` has no such zero form — the parser clamps `colspan="0"` to 1.
   *  An ARIA cell's `aria-rowspan="0"` is read the same way (§7.9). */
  const spanned = (cell) => cell.across > 1 || cell.down !== 1;
  const plural = (n, one, many) => (n === 1 ? one : many);
  /**
   * A refusal. `shape` marks the five SHAPE reasons of §7.10 — the ones a
   * structure question can answer — and only those carry a sketch; the caller
   * throws a different error class for them. Everything else is the author's
   * own problem and gets the sentence it has always had.
   *
   * The sketch is built HERE rather than in a second evaluation, because a
   * second round-trip describes a page that has had time to change: the
   * refusal and the sketch must be two halves of one observation.
   */
  const fail = (error) => ({ ok: false, error, shape: false });
  /** Set once `el` is known — until then there is no region to sketch. */
  let sketchRegion = null;
  const failShape = (error) => ({
    ok: false,
    error,
    shape: true,
    sketch: sketchRegion ? buildSketch(sketchRegion) : null,
  });
  /** Quote a page-supplied string for a message. `JSON.stringify` rather than
   *  `"…"`, because an aria-label or caption may contain quotes of its own and
   *  `readTable cannot map table "The "Orders" table"` reads as nonsense. */
  const quoted = (s) => JSON.stringify(String(s));

  // ── rows and cells, for BOTH providers (§7.9) ────────────────────────────
  //
  // Everything from §7.3b's header grid down to the `data-aiui-row` stamp is
  // written against these two shapes, so a `<table>` and a `div[role="grid"]`
  // are read by the same code:
  //
  //   cell view — { el, across, down, at, pos }
  //     `across`/`down` are `colspan`/`rowspan`, with `down === 0` keeping its
  //     "to the end of this row group" meaning (§4.8). `at` is the ZERO-based
  //     column the cell declares (`aria-colindex` minus one), or null for "the
  //     next free column", which is what every `<td>` is and what §7.9 says an
  //     ARIA cell without `aria-colindex` is. `pos` is the ONE-based position
  //     a requested column is looked up by — the cell's order in the row for a
  //     table, its `aria-colindex` for a grid that declares one.
  //
  //   row view — { el, els, cells, byPos, width }
  //     `els` is the row's FRAGMENTS: ag-Grid renders one logical row as two
  //     `role="row"` elements, one per pinned container, and §7.9 joins them
  //     by `aria-rowindex`. `el` is the first of them — the one that carries
  //     the stamp and the one whose document position orders the rows. A
  //     `<tr>` is always a row of one fragment, so the table path pays
  //     nothing for the generality.
  //
  // `width` is how many COLUMNS the row reaches, which for a `<tr>` is its
  // cell count (what §4.8's rules have always measured) and for a grid row is
  // the highest column any of its cells covers.

  /** The roles that make an element a table (§7.9). A `<table>` carrying one
   *  is still a table — the tag wins (§10) — so the tag is tested too. */
  const GRID_ROLES = { grid: 1, table: 1, treegrid: 1 };
  /** The roles that make a row's child a cell. `role="none"` /
   *  `"presentation"` (MUI's filler) and a child with no role are not here,
   *  which is how they are skipped. */
  const CELL_ROLES = { columnheader: 1, rowheader: 1, gridcell: 1, cell: 1 };
  /**
   * `role` is a TOKEN LIST, not a word (WAI-ARIA: "an ordered set of
   * whitespace-separated values, the first one the user agent supports"), and
   * frameworks write several: `role="row presentation"` on a decorated row,
   * `role="gridcell selected"` on a cell. Compared as a whole string, a data
   * row spelled that way was not a row at all — the grid read its remaining
   * rows and answered successfully with half the table in it, which is the
   * outcome this action exists to prevent.
   *
   * So: an element counts for a role when ANY of its tokens is that role,
   * folded to lower case (`role="GRID"` is a grid).
   */
  const rolesOf = (e) => {
    const raw = fold(e.getAttribute('role') || '');
    return raw === '' ? [] : raw.split(' ');
  };
  const hasRole = (e, name) => rolesOf(e).indexOf(name) !== -1;
  /** The first token of `e` that names a CELL role, or `''`. What the layout
   *  and the sketch read: `role="gridcell selected"` is a gridcell. */
  const cellRoleOf = (e) => {
    for (const role of rolesOf(e)) if (CELL_ROLES[role] === 1) return role;
    return '';
  };
  const isGridRole = (e) => rolesOf(e).some((role) => GRID_ROLES[role] === 1);
  /** An ARIA grid: a role that makes it a table, on something that is not one
   *  already. `<table role="grid">` reads through the table path (§10). */
  const isAriaGrid = (e) => e.tagName !== 'TABLE' && isGridRole(e);
  /**
   * The nearest element above `node` that is a table — by role, or by being a
   * `<table>`. What decides whose rows these are when one grid holds another
   * (§7.9).
   *
   * A `<table>` counts whatever role it carries, and that is load-bearing
   * rather than tidy: Kendo writes `role="row"` on its `<tr>`s and
   * `role="grid"` on its WRAPPER, so rows that plainly belong to the tables
   * inside it answered to the wrapper, which then read as an ARIA grid of one
   * header row and no data — `[]`, successfully, for a grid with five rows in
   * it. A `<tr>` belongs to its table; nothing above the table can claim it.
   */
  const gridHostOf = (node) => {
    let p = node.parentElement;
    while (p) {
      if (p.tagName === 'TABLE' || isGridRole(p)) return p;
      p = p.parentElement;
    }
    return null;
  };
  /** A positive integer attribute, or null. `aria-colindex="0"` and
   *  `aria-colspan="x"` are not counts and are read as absent. */
  const countAttr = (el2, name) => {
    const raw = el2.getAttribute(name);
    if (raw === null) return null;
    const n = Number(squash(raw));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  /** Finish a row view: index its cells by position and measure its width. */
  const rowView = (el2, els, cells) => {
    const byPos = new Map();
    let width = 0;
    for (const cell of cells) {
      if (!byPos.has(cell.pos)) byPos.set(cell.pos, cell);
      const reach = cell.pos + (cell.across > 0 ? cell.across : 1) - 1;
      if (reach > width) width = reach;
    }
    return { el: el2, els, cells, byPos, width };
  };

  /**
   * One `<tr>` as a row view — remembered, because §7.3a asks about the same
   * tables from both sides and the views must be the same objects each time
   * (`messageRow` and the classification compare them by identity).
   *
   * `width` is the CELL COUNT, not the columns the cells cover: that is what
   * §4.8's placeholder rule, §7.4's short-row refusal and §7.3a's pairing
   * check have always measured, and a merged data cell is refused rather than
   * laid out, so the two numbers only differ on rows that are about to be
   * refused anyway.
   */
  const rowViewsByRow = new Map();
  const tableRowView = (tr) => {
    let view = rowViewsByRow.get(tr);
    if (view) return view;
    const cells = items(tr.cells).map((el2, i) => ({
      el: el2,
      across: el2.colSpan > 0 ? el2.colSpan : 1,
      down: el2.rowSpan,
      at: null,
      pos: i + 1,
    }));
    view = rowView(tr, [tr], cells);
    view.width = cells.length;
    rowViewsByRow.set(tr, view);
    return view;
  };

  /**
   * The `role="row"` elements belonging to grid `g` — its own, never a nested
   * grid's (§7.9). Scanned over `[role]` rather than `[role="row"]` because
   * the attribute is a whitespace-separated list that a framework may write
   * padded or capitalised, and a grid whose rows were missed reads `[]`
   * successfully, which is the outcome this action exists to prevent.
   */
  const ariaRowsOf = (g) =>
    items(g.querySelectorAll('[role]')).filter(
      (e) => hasRole(e, 'row') && gridHostOf(e) === g,
    );

  /**
   * Is this element an ARIA grid that actually HAS rows of its own?
   *
   * The role alone is not enough, and Kendo is why: its wrapper is
   * `<div class="k-grid" role="grid" aria-label="Dividends">` and everything
   * inside it is native `<table>` markup, with not one `role="row"` anywhere.
   * Read as a grid on the strength of the attribute, that wrapper answered
   * `[]` — a green step that read nothing, which is the outcome §2 exists to
   * prevent — and the two real tables under it were never looked at. A role
   * with no rows under it is a WRAPPER (§7.2), whatever it calls itself.
   *
   * Remembered: `nestedUnder` asks it of every ancestor of every candidate,
   * and each answer is a `querySelectorAll` over everything below.
   */
  const ariaRowOwners = new Map();
  const ownsAriaRows = (e) => {
    let owns = ariaRowOwners.get(e);
    if (owns === undefined) {
      owns = isAriaGrid(e) && ariaRowsOf(e).length > 0;
      ariaRowOwners.set(e, owns);
    }
    return owns;
  };

  /**
   * One grid's rows as views, fragments joined (§7.9).
   *
   * ag-Grid renders a pinned column's cells in a container of their own, so
   * ONE logical row is two `role="row"` elements sharing `aria-rowindex` (and
   * `row-index`, and `row-id`). Read as two rows, a pinned grid produced two
   * half-records per row — the misalignment §4.5 exists to prevent, with
   * twice as many rows as the grid has. Joined, the cells merge by position:
   * the pinned fragment's `aria-colindex="1"` and the centre fragment's 2, 3, 4
   * are one row of four cells.
   *
   * A row with neither attribute is its own row — MUI writes only
   * `aria-rowindex`, and a grid that writes nothing at all has no fragments to
   * join.
   */
  const ariaRowViews = (g) => {
    const groups = [];
    const byKey = new Map();
    for (const el2 of ariaRowsOf(g)) {
      // `aria-rowindex` first, `row-index` only when it is absent (§7.9), and
      // the two are kept in separate key spaces: a grid that writes
      // `row-index` on some rows and `aria-rowindex` on others must not merge
      // its row 2 with its row 2.
      const aria = squash(el2.getAttribute('aria-rowindex') || '');
      const own = squash(el2.getAttribute('row-index') || '');
      const key = aria !== '' ? `a:${aria}` : (own !== '' ? `r:${own}` : null);
      let group = key !== null ? byKey.get(key) : undefined;
      if (!group) {
        group = { els: [] };
        groups.push(group);
        if (key !== null) byKey.set(key, group);
      }
      group.els.push(el2);
    }
    return groups.map((group) => {
      const cells = [];
      const taken = new Set();
      // The running column, carried ACROSS fragments: a cell with no
      // `aria-colindex` takes the next one (§7.9), and the pinned fragment's
      // cells come first in document order.
      let next = 1;
      for (const el2 of group.els) {
        for (const child of items(el2.children)) {
          if (cellRoleOf(child) === '') continue;
          const declared = countAttr(child, 'aria-colindex');
          const colspan = countAttr(child, 'aria-colspan');
          const rowspan = countAttr(child, 'aria-rowspan');
          const across = colspan !== null && colspan > 0 ? colspan : 1;
          const pos = declared !== null && declared > 0 ? declared : next;
          next = pos + across;
          // Two fragments claiming one position is a grid contradicting
          // itself; the first fragment's cell stands, because dropping the row
          // or guessing between them are both worse than reading what the row
          // says first.
          if (taken.has(pos)) continue;
          taken.add(pos);
          cells.push({
            el: child,
            across,
            // `aria-rowspan="0"` keeps `rowspan="0"`'s meaning (§4.8).
            down: rowspan !== null ? rowspan : 1,
            at: declared !== null && declared > 0 ? declared - 1 : null,
            pos,
          });
        }
      }
      cells.sort((a, b) => a.pos - b.pos);
      const view = rowView(group.els[0], group.els, cells);
      view.hasHeadings = cells.some((c) => cellRoleOf(c.el) === 'columnheader');
      view.hasData = cells.some((c) => {
        const role = cellRoleOf(c.el);
        return role === 'gridcell' || role === 'cell';
      });
      return view;
    });
  };

  /**
   * §7.9's split of one grid's rows: the header rows that form the header grid
   * (§7.3b) and the rows left over, which §4.8 and §7.4 classify exactly as
   * they classify a `<tbody>`'s.
   *
   * A header row is one holding at least one `columnheader` and no
   * `gridcell`/`cell` — several of them in a row are a banded header. One
   * AFTER the data is the ARIA spelling of `<tfoot>` and is excluded the same
   * way (§7.4), rather than becoming a record of heading text.
   *
   * A row holding only `rowheader`s is neither, and stays in the body: a row
   * heading is that row's own cell at its logical position (§10), so the row
   * is data with one cell in it.
   */
  /**
   * The section each of `views` belongs to, in one pass — the classification
   * `ariaSplit` splits on AND the word the sketch prints, so the two can never
   * disagree about which row is the header.
   *
   *   `header` — a header row, one of the header grid's (§7.3b).
   *   `row`    — a body row, which §4.8 and §7.4 then classify.
   *   `tfoot`  — a heading row AFTER the data. §7.9 calls it the ARIA spelling
   *              of `<tfoot>` and excludes it the same way, so it is given the
   *              table's own word for it: a model naming it as the header then
   *              gets the footer refusal rather than a body-row number that
   *              would splice a real row out of the data.
   */
  const ariaSections = (views) => {
    const out = [];
    let seenData = false;
    for (const view of views) {
      if (view.hasHeadings && !view.hasData) {
        out.push(seenData ? 'tfoot' : 'header');
        continue;
      }
      if (view.hasData) seenData = true;
      out.push('row');
    }
    return out;
  };

  const ariaSplit = (g) => {
    const views = ariaRowViews(g);
    const sections = ariaSections(views);
    const headerRows = [];
    const bodyRows = [];
    for (let i = 0; i < views.length; i++) {
      if (sections[i] === 'header') headerRows.push(views[i]);
      else if (sections[i] === 'row') bodyRows.push(views[i]);
    }
    return { headerRows, bodyRows };
  };

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
    const cells = row.cells;
    if (cells.length === 0) return true;
    if (cells.length === 1) return cells[0].across > 1;
    const wide = cells.filter((c) => c.across > 1);
    return (
      wide.length === 1
      && rendered(wide[0].el)
      && cells.every((c) => c === wide[0] || !rendered(c.el))
    );
  };

  /**
   * §7.3b's header GRID: the header rows laid out the way the HTML table
   * algorithm lays a table out, and the name each column ends up with.
   *
   * More than one header row is the norm for a grid widget — a band row over
   * groups of columns, the row of column names, and often a filter row of
   * inputs. V1 read exactly ONE row and refused the rest as "merged headers",
   * which on RadGrid refused every read by header of a nine-column grid whose
   * band row has four cells and whose name row has eight.
   *
   * Each cell takes the first column of its row that no cell from a row above
   * already occupies, and covers `colspan` columns across and `rowspan` rows
   * down. `rowspan="0"` — legal HTML for "to the end of this row group", which
   * the DOM reports as `0` (§4.8) — runs to the LAST header row; read as 1, a
   * corner cell written that way stopped occupying the name row and every
   * column under it took the wrong row's heading.
   *
   * The name of a column is the text of the LOWEST cell covering it that says
   * anything. A blank corner cell and a filter cell holding only an input name
   * nothing, so a filter row is laid out — it can widen the grid — and never
   * names a column. A non-blank cell that names no column is a BAND (§7.3b.4):
   * it groups columns, and a request for it is refused by name (§5.3).
   *
   * `width` is the highest column any cell reached plus one, and is the width
   * every later rule uses — §4.8's placeholder rule, §7.4's short row, §7.3a's
   * pairing check — never a row's cell count, which for RadGrid's name row is
   * eight of nine.
   */
  const headerGridOf = (headerRows) => {
    const cells = [];
    const taken = headerRows.map(() => new Set());
    let width = 0;
    for (let r = 0; r < headerRows.length; r++) {
      let c = 0;
      for (const cell of headerRows[r].cells) {
        // A cell that DECLARES its column takes it, occupied or not: that is
        // what `aria-colindex` is for (§7.9), and a grid that repeats a column
        // across two fragments is saying they are the same column, not the
        // next free one. Everything else — every `<td>`, and an ARIA cell with
        // no `aria-colindex` — takes the first column no cell above it holds.
        if (cell.at !== null) c = cell.at;
        else while (taken[r].has(c)) c++;
        const across = cell.across > 0 ? cell.across : 1;
        const down =
          cell.down === 0 ? headerRows.length - r : (cell.down > 0 ? cell.down : 1);
        const lastRow = Math.min(headerRows.length - 1, r + down - 1);
        for (let rr = r; rr <= lastRow; rr++) {
          for (let cc = c; cc < c + across; cc++) taken[rr].add(cc);
        }
        cells.push({ text: headerTextOf(cell.el), first: c, last: c + across - 1, row: r });
        if (c + across > width) width = c + across;
        c += across;
      }
    }
    const names = [];
    const namers = [];
    for (let col = 0; col < width; col++) {
      let lowest = null;
      for (const cell of cells) {
        if (cell.first > col || cell.last < col || cell.text === '') continue;
        if (!lowest || cell.row > lowest.row) lowest = cell;
      }
      namers.push(lowest);
      names.push(lowest ? lowest.text : '');
    }
    const bands = cells.filter((cell) => cell.text !== '' && !namers.includes(cell));
    return { width, names, cells, namers, bands };
  };

  /** The bands over one column, TOP-DOWN — what `Band > Leaf` walks (§7.3b.4). */
  const bandsOver = (grid, col) =>
    grid.bands
      .filter((band) => band.first <= col && band.last >= col)
      .sort((a, b) => a.row - b.row);

  /** The non-blank column names under a band, in column order and without
   *  repeats — a leaf cell spanning two columns names both, and listing it
   *  twice reads as a mistake. */
  const leavesUnder = (grid, band) => {
    const out = [];
    for (let col = band.first; col <= band.last; col++) {
      const name = grid.names[col];
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  };

  /**
   * §7.3's header ROWS, over one table and its body rows.
   *
   * Returns { rows, index }: `index` is the row's position in `rows` when the
   * header came from the BODY (the caller splices it out), -1 from a
   * `<thead>`. Nothing is refused here any more — §7.3b.6: the header grid
   * lays every shape out, and "merged headers" and "its header has N rows"
   * are gone. A merged BODY cell is still the §7.4 error, further down.
   */
  const findHeader = (t, rows) => {
    const none = { rows: null, index: -1 };
    const thead = t.tHead;
    const headRows = thead && thead.parentElement === t ? items(thead.rows) : [];
    if (headRows.length > 0) return { rows: headRows, index: -1 };
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
    // A body-row header is always ONE row (§7.3b.1), laid out like any other.
    return { rows: [first], index: firstAt };
  };

  /**
   * One table, described the way §7.2 and §7.3a ask about it: its body rows,
   * its header grid, the body rows that are LEFT once a body header is taken
   * out, which of those are DATA, and whether it is **header-only** — a header
   * and no data under it.
   *
   * Kendo's header table is a `<thead>` with no `<tbody>` at all; RadGrid's
   * holds one hidden `<td colspan="9">` spacer row, which is a §4.8 message
   * row and not data; a framework that puts the headings in the first
   * `<tbody>` row and nothing below them qualifies the same way. So
   * header-only is measured over the rows that are DATA (§7.2, §7.3a.2), not
   * by counting `<tr>`s.
   *
   * §7.3b.5: a `<thead>` whose grid names NO column is no header at all.
   * RadGrid's data table carries a `<thead>` of its own, hidden, with a single
   * empty `<th>`; taken as the header, every read by name failed "its header
   * row has no non-empty headings" one table away from the headings. Treated
   * as none, §7.3a finds the real one through `aria-owns` or beside.
   *
   * A `<thead>` ONLY. A BODY row §7.3 took as the header is still the header
   * when its cells happen to be blank — `<tr><th></th><th></th></tr>` above
   * the data — because it is a row of the table and nothing else would take it
   * out: read as "no header" it stayed in the body, became record 1 with two
   * empty values and shifted every `_row` below it by one, which is §4.5's
   * misalignment. Nothing is lost by keeping it: a grid naming no column
   * refuses every read BY name anyway, and a read by position gets the right
   * rows.
   *
   * `headerOnly` still means a header that NAMES something, because that is
   * what §7.3a adopts: a blank grid donated to the table beside it would give
   * every column of it no name at all.
   */
  const classify = (t) => {
    // The header SEARCH is the one part of this that a `<table>` does its own
    // way (§7.3: a `<thead>`, or the first body row that carries a `<th>`);
    // §7.9's provider answers it from `role="columnheader"` instead. From the
    // header GRID down, both hand the same row views to the same code.
    const trs = bodyRowsOf(t);
    const head = findHeader(t, trs);
    const rows = trs.map(tableRowView);
    const laid = head.rows ? headerGridOf(head.rows.map(tableRowView)) : null;
    const named = laid !== null && laid.names.some((name) => name !== '');
    const grid = laid !== null && (named || head.index >= 0) ? laid : null;
    const index = grid ? head.index : -1;
    const body = index >= 0 ? rows.filter((_, i) => i !== index) : rows;
    const data = body.filter((row) => !messageRow(row));
    return {
      table: t,
      rows,
      grid,
      index,
      body,
      data,
      headerOnly: named && data.length === 0,
    };
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
      // DATA rows, not any rows: a pager or spacer table whose one row is a
      // lone spanning cell (§4.8, RadGrid) is not the data table that would
      // have been this header's own partner.
      if (classified(other).data.length > 0) found.push(other);
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
      // "Header-only" is §7.3a.2's: its header grid NAMES at least one column
      // (§7.3b.5 — a `<thead>` of blank cells is no header) and it has no data
      // row. A hidden spacer row in its body is a message row and does not
      // make it a data table (§5.7).
      if (!info.headerOnly) continue;
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
        if (info.data.length === 0) continue;
        if (info.grid !== null) continue;
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

  // ── the sketch (§7.10) ───────────────────────────────────────────────────
  // What the region HOLDS, described rather than read, so that a shape refusal
  // can be turned into one question to the model instead of a dead end. It is
  // built in this evaluation and not a second one: a sketch fetched after the
  // refusal describes a page that has had time to change, and the model would
  // be answering about markup the refusal never saw.
  //
  // Everything in it is DATA FROM THE PAGE. It reaches a model as such, never
  // as instructions, and every piece of cell text goes through the caller's
  // secret set first (§7.6) — the sketch is the one place this file quotes
  // page content back out, and it lands in a model call and in the debug log.

  /** The whole sketch, in bytes of JSON. A few kilobytes is what §7.10 allows
   *  — enough to describe a grid, far short of a page of markup. */
  const SKETCH_BYTES = 6144;
  /** `…` rather than a hard cut, so a truncated value is visibly truncated. */
  const cut = (s, n) => (n <= 0 ? '' : (s.length > n ? `${s.slice(0, n - 1)}…` : s));

  /**
   * §7.6's masking, over one string of page text.
   *
   * LONGEST first, so a secret that contains another secret is replaced whole
   * rather than left with `***` embedded in the rest of it. Applied BEFORE the
   * length cut, because a cut applied first can slice a secret in half and
   * leave the first half in the sketch.
   */
  const masked = (s) => {
    if (!maskValues || maskValues.length === 0) return s;
    const values = maskValues
      .filter((v) => typeof v === 'string' && v !== '')
      .sort((a, b) => b.length - a.length);
    let out = s;
    for (const value of values) out = out.split(value).join('***');
    return out;
  };

  /** `#id`, escaped, or null. The escape matters: a grid widget's id is
   *  routinely a GUID, and `#14277be2-grid` starts with a number, so it is not
   *  a selector at all (see `wrapperSelector`). */
  const cssId = (e) => {
    if (!e.id) return null;
    const view = e.ownerDocument.defaultView;
    const css = view ? view.CSS : null;
    return css && typeof css.escape === 'function'
      ? `#${css.escape(e.id)}`
      : `[id=${cssString(e.id)}]`;
  };

  /**
   * A selector for `e` that `root.querySelector` resolves back to it — `#id`
   * when the id is unique under the root, otherwise a `:scope > …` path of
   * `nth-of-type` steps, which needs no class names and survives a page whose
   * classes are generated (MUI's `css-1hburdq` changes with the build).
   *
   * `:scope` alone is the ROOT itself: a mapping that names the region — the
   * §5.9 table whose headings are its own first body row — has nothing else to
   * call it, and `querySelector` never matches its own root.
   *
   * NEVER null. Both dead ends below — an element that is not under the root
   * at all, and one whose id cannot be spelled as a selector — fall back to
   * `:scope`, which resolves to something and refuses honestly ("matches no
   * table or ARIA grid", or a width that does not line up). A `null` here
   * would reach the sketch as `"selector": null`, and the model would answer
   * with it: `JSON.stringify(null)` is the string `"null"`, which
   * `querySelectorAll` throws on, so an unreachable element turned into a
   * refusal about CSS syntax instead of about the page.
   */
  const pathFrom = (root, e) => {
    if (e === root) return ':scope';
    const byId = cssId(e);
    if (byId) {
      try {
        if (root.querySelector(byId) === e) return byId;
      } catch (err) { /* an id no selector can spell: fall through to the path */ }
    }
    const parts = [];
    let node = e;
    while (node && node !== root) {
      const parent = node.parentElement;
      if (!parent) return byId || ':scope';
      const sames = items(parent.children).filter((c) => c.tagName === node.tagName);
      const tag = node.tagName.toLowerCase();
      parts.unshift(sames.length > 1 ? `${tag}:nth-of-type(${sames.indexOf(node) + 1})` : tag);
      node = parent;
    }
    if (node !== root) return byId || ':scope';
    return `:scope > ${parts.join(' > ')}`;
  };

  /** Is `e` inside a table or an ARIA grid that is itself under `root`? A
   *  table in a cell of another belongs to that table, not to the region
   *  (§7.2), and the same is true of a grid inside a gridcell. `root` itself
   *  counts, which is what keeps a `<table>` region's own nested tables out of
   *  its candidate list. */
  const nestedUnder = (root, e) => {
    let p = e.parentElement;
    while (p && root.contains(p)) {
      if (p.tagName === 'TABLE' || ownsAriaRows(p)) return true;
      p = p.parentElement;
    }
    return false;
  };

  /**
   * The tables and ARIA grids of a region, in document order — the things a
   * structure answer can name (§7.10).
   *
   * A region that is ITSELF a table or a grid is the one candidate: what is
   * inside it belongs to it (§7.2's nested-table rule), and a mapping naming
   * one of its own cells' tables would be reading a table out of a cell.
   */
  const candidatesOf = (root) => {
    if (root.tagName === 'TABLE') return [{ el: root, kind: 'table' }];
    if (ownsAriaRows(root)) return [{ el: root, kind: 'grid' }];
    const found = [];
    for (const e of items(root.querySelectorAll('table, [role]'))) {
      if (nestedUnder(root, e)) continue;
      if (e.tagName === 'TABLE') found.push({ el: e, kind: 'table' });
      else if (ownsAriaRows(e)) found.push({ el: e, kind: 'grid' });
    }
    return found;
  };

  /**
   * The element a sketch's selectors are relative to, and the one a `mapping`
   * is resolved against.
   *
   * The matched element, except when it is a `<table>`: a table's partner is
   * beside it, not inside it (§5.9's header table after the rows), so the
   * sketch is taken from the nearest ancestor below `<body>` that holds
   * something else as well. Below `<body>` for §7.3a's reason — the body
   * element is the page, not a grid container. With no such ancestor the table
   * is its own root and is the one candidate, named `:scope`.
   */
  const sketchRootOf = (e) => {
    if (e.tagName !== 'TABLE') return e;
    let anc = e.parentElement;
    while (anc && anc.tagName !== 'BODY') {
      if (candidatesOf(anc).length > 1) return anc;
      anc = anc.parentElement;
    }
    return e;
  };

  /** The accessible name of anything, for the sketch and for the log. */
  const nameOf = (e) =>
    squash(e.getAttribute('aria-label') || '')
    || (e.tagName === 'TABLE' && e.caption ? squash(e.caption.textContent || '') : '')
    || labelledByText(e)
    || e.id
    || '';

  /** The rows of one candidate as views, in document order, headings and all
   *  — the sketch describes what is there, including the `<thead>` and
   *  `<tfoot>` rows a read would never return. */
  const sketchRowsOf = (cand) => {
    if (cand.kind === 'grid') return ariaRowViews(cand.el);
    return items(cand.el.rows)
      .filter((tr) => tr.closest('table') === cand.el)
      .map(tableRowView);
  };

  /**
   * The section words the sketch prints for one candidate's rows, in order.
   *
   * This is what turns a model's "row 2 of T1" into a `header` mapping: a
   * heading row needs no number (the extractor finds the header grid of the
   * element it was handed), a body row is counted among the BODY rows alone,
   * and a footer row is refused. So the two shapes have to be TELLABLE APART
   * here or the arithmetic is done on the wrong list — an ARIA grid whose
   * every row said `row` had its blank `columnheader` row counted as body row
   * 1, and "row 2" then read the row of real headings as data.
   *
   *   `<tr>`     — `thead` / `tbody` / `tfoot`, from the section it sits in.
   *   ARIA row   — `header` / `row` / `tfoot`, from {@link ariaSections}.
   */
  const sectionsOf = (views, kind) => {
    if (kind === 'grid') return ariaSections(views);
    return views.map((view) => {
      const parent = view.el.parentElement;
      const tag = parent ? parent.tagName : '';
      if (tag === 'THEAD') return 'thead';
      if (tag === 'TFOOT') return 'tfoot';
      return 'tbody';
    });
  };

  /** `th×8`, `td×1+th×2`, `columnheader×3` — the composition of one row, in
   *  first-appearance order, which is how a `<td>`-headed row (§5.9.1) is
   *  told apart from a real one without quoting the markup. */
  const tagsOf = (view, kind) => {
    const order = [];
    const counts = new Map();
    for (const cell of view.cells) {
      const name = kind === 'grid' ? cellRoleOf(cell.el) : cell.el.tagName.toLowerCase();
      if (!counts.has(name)) order.push(name);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return order.map((name) => `${name}×${counts.get(name)}`).join('+');
  };

  /** `colspan 2,3,3; rowspan 2`, or "" — the spans alone, which is what
   *  decides whether a header is banded and whether a row is a message. */
  const spansOf = (view) => {
    const across = view.cells.filter((c) => c.across > 1).map((c) => c.across);
    const down = view.cells.filter((c) => c.down !== 1).map((c) => c.down);
    const parts = [];
    if (across.length > 0) parts.push(`colspan ${across.join(',')}`);
    if (down.length > 0) parts.push(`rowspan ${down.join(',')}`);
    return parts.join('; ');
  };

  /** One candidate at one budget. */
  const renderCandidate = (root, cand, index, budget) => {
    const id = `T${index + 1}`;
    const rows = sketchRowsOf(cand);
    let headerRowCount = 0;
    let dataRowCount = 0;
    if (cand.kind === 'grid') {
      const split = ariaSplit(cand.el);
      headerRowCount = split.headerRows.length;
      dataRowCount = split.bodyRows.filter((v) => !messageRow(v)).length;
    } else {
      const info = classified(cand.el);
      const thead = cand.el.tHead;
      headerRowCount = thead && thead.parentElement === cand.el
        ? items(thead.rows).length
        : (info.index >= 0 ? 1 : 0);
      dataRowCount = info.data.length;
    }
    const sections = sectionsOf(rows, cand.kind);
    const shown = rows.slice(0, budget.rows).map((view, i) => ({
      id: `${id}.r${i + 1}`,
      section: sections[i],
      cells: view.cells.length,
      tags: tagsOf(view, cand.kind),
      spans: spansOf(view),
      rendered: view.els.some(rendered),
      text: view.cells
        .slice(0, budget.cells)
        .map((cell) => cut(masked(cellTextOf(cell.el)), budget.text)),
    }));
    const out = {
      id,
      // NOT masked, unlike everything else here: this string is machinery, not
      // description. The caller looks the model's `"rows": "T2"` up in this
      // list and hands the selector back as the mapping, so a `#***` would be
      // a mapping that resolves to nothing. A selector holding a secret is a
      // page whose ids are secrets; the label and the cell text beside it are
      // where the values actually live.
      selector: pathFrom(root, cand.el),
      kind: cand.kind,
      label: masked(nameOf(cand.el)),
      headerRowCount,
      dataRowCount,
      rows: shown,
    };
    if (rows.length > shown.length) out.moreRows = rows.length - shown.length;
    return out;
  };

  /**
   * The sketch of one region, shrunk until it fits (§7.10's "capped at a few
   * kilobytes"). Text goes first, then rows, then candidates: the SHAPE of the
   * region is what the question is about, and a page with forty tables in it
   * still has to describe all of them before it describes any of their
   * contents.
   *
   * The first budget's EIGHT rows is the number the question actually needs,
   * not a round one. The header is in the first few rows of a candidate — a
   * band row, a row of names, a filter row is the widest real header measured
   * (RadGrid, §5.7) — and everything below that is data whose shape repeats,
   * so the model learns nothing from row nine that row four did not tell it.
   * Eight leaves room for a three-row banded header and still shows several
   * data rows under it, which is what an answer has to tell apart; at the same
   * time it is what keeps a 500-row grid inside the byte cap at the FIRST
   * budget, so the common case is never described at the shrunken one.
   */
  const buildSketch = (region) => {
    const root = sketchRootOf(region);
    const cands = candidatesOf(root);
    const budgets = [
      { rows: 8, cells: 6, text: 40, cands: 12 },
      { rows: 6, cells: 4, text: 28, cands: 12 },
      { rows: 4, cells: 3, text: 20, cands: 8 },
      { rows: 2, cells: 2, text: 14, cands: 6 },
      { rows: 1, cells: 0, text: 0, cands: 4 },
    ];
    let out = null;
    for (let b = 0; b < budgets.length; b++) {
      const budget = budgets[b];
      const kept = cands.slice(0, budget.cands);
      out = {
        region: {
          // Masked like every other string in here, and for the same reason:
          // a selector is as often page-derived as a cell is
          // (`[data-token="…"]`, `#user-hunter2`), and this object is rendered
          // whole into a model call and the debug log (§7.6).
          selector: masked(sel),
          tag: region.tagName.toLowerCase(),
          id: masked(region.id || ''),
          label: masked(nameOf(region)),
        },
        candidates: kept.map((cand, i) => renderCandidate(root, cand, i, budget)),
      };
      if (cands.length > kept.length) out.moreCandidates = cands.length - kept.length;
      if (b > 0) out.truncated = true;
      let size = SKETCH_BYTES + 1;
      try {
        size = JSON.stringify(out).length;
      } catch (err) { /* nothing here is circular; a throw would be the page's */ }
      if (size <= SKETCH_BYTES) return out;
    }
    // Even the smallest form is over budget — a page of hundreds of tables.
    // Answering with it beats answering with nothing: the caller caps what it
    // sends, and a question with a long sketch is still a question.
    return out;
  };

  /** The `T<n>` a resolved element has in its own region's sketch, for the log
   *  line (§7.6: `rows in T2, header row 2 of T1`), or the selector when it is
   *  not one of them — the caller's summary should name what the model named. */
  const candidateIdOf = (root, e) => {
    const cands = candidatesOf(root);
    for (let i = 0; i < cands.length; i++) {
      if (cands[i].el === e) return `T${i + 1}`;
    }
    return null;
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
  // The region every §7.10 answer is about: the element the author's selector
  // matched, which is what a sketch describes and what a `mapping`'s selectors
  // are resolved against.
  sketchRegion = el;
  if (sketchOnly) {
    // `sketchTable()`'s call: describe the region and read nothing. Not an
    // `ok: true`, because nothing was read — the caller reads `.sketch`.
    return {
      ok: false,
      error: `readTable described "${sel}" without reading it`,
      shape: true,
      sketch: buildSketch(el),
    };
  }

  // ── the validated structure, replayed (§7.10) ────────────────────────────
  //
  // A `mapping` is an answer that has already been through the model ONCE and
  // is now page data like any other: every selector in it is resolved against
  // the page and every count is checked before a single cell is read. It
  // names the parts the search would otherwise have looked for, so the rules
  // it replaces — §7.2's "which table", §7.3's header search, §7.3a's pairing
  // — are skipped, and everything else (§7.3b's layout, §4.8, §7.4, `_row`,
  // the stamp) runs exactly as it does on an ordinary read.
  //
  // Its selectors are relative to the MAPPING ROOT, which is the region — the
  // element the author's selector matched — except when the region is a
  // `<table>`, where it is the same ancestor the sketch's candidates were
  // listed from, since a table's partner sits beside it and `querySelector`
  // cannot reach out of its own root. `:scope` is that root itself, which is
  // how a table whose headings are its own first body row (§5.9.1) names
  // itself. Root and region are not the same fence: see `mayName` for what a
  // mapping is allowed to READ once the root has been widened.
  //
  // Worked out LAZILY, and only on a mapped read: for a `<table>` region the
  // walk asks every ancestor up to `<body>` what tables and grids it holds,
  // and a page of several hundred tables pays for that walk on every
  // ordinary read that never needed it (§7.3a's beside search measured 1.3s
  // on exactly such a page before it was made to walk once).
  let mappingRootCache = null;
  const rootForMapping = () => {
    if (mappingRootCache === null) mappingRootCache = sketchRootOf(el);
    return mappingRootCache;
  };
  /** What the refusals call the region. The model was asked about THIS, so a
   *  sentence about its answer names it and not the table it chose. */
  const regionLabel = nameOf(el) || sel;
  const badStructure = (why) =>
    fail(`readTable cannot use the structure given for ${quoted(regionLabel)}: ${why}`);
  /** `root.querySelectorAll`, with `:scope` meaning the root and a selector
   *  the browser rejects answered as a refusal rather than a thrown error —
   *  the string came from a model and may be anything at all. */
  const lookup = (spelled) => {
    if (spelled === ':scope') return [rootForMapping()];
    try {
      return items(rootForMapping().querySelectorAll(spelled));
    } catch (err) {
      return null;
    }
  };
  /**
   * May a `table` mapping name this element (§7.10)?
   *
   * The mapping root is deliberately WIDER than the region — a `<table>`
   * region resolves its selectors against the ancestor its sketch was taken
   * from, because §5.9.2's header table sits beside the rows and
   * `querySelector` cannot reach out of its own root. Widening the root
   * widened what a mapping can READ, and that is a different thing: measured,
   * `{ rows: "#payroll" }` under `selector: "#orders"` read the payroll table
   * and reported it as the orders table, with the author's selector in the log
   * line and somebody else's salaries in the records. Nothing about the answer
   * looked wrong.
   *
   * So the two halves get different reach:
   *
   *   ROWS — the region itself or something inside it. The author chose that
   *     element and the VALUES come out of it.
   *   HEADER — that, or one of the candidates this region's sketch listed,
   *     which is how §5.9.2 and §7.3a's `aria-owns` partner are named. A
   *     header supplies only NAMES, and the width and name checks below have
   *     to agree with them before a cell is read.
   */
  const insideRegion = (target) => target === el || el.contains(target);
  const listedForRegion = (target) =>
    candidatesOf(rootForMapping()).some((cand) => cand.el === target);
  const mayName = (target, what) =>
    insideRegion(target) || (what === 'header' && listedForRegion(target));

  /** One table or ARIA grid the mapping names, or the refusal that says why
   *  not. Only a table or a grid can be one: a `<div>` the model liked the
   *  look of is a structure answer that would read nothing. */
  const resolveTarget = (raw, what) => {
    const spelled = typeof raw === 'string' ? squash(raw) : '';
    if (spelled === '') return { error: badStructure(`no ${what} selector was given`) };
    const found = lookup(spelled);
    if (found === null) {
      return { error: badStructure(`the ${what} selector "${spelled}" is not a CSS selector`) };
    }
    const targets = found.filter((e) => e.tagName === 'TABLE' || ownsAriaRows(e));
    if (targets.length === 0) {
      return {
        error: badStructure(
          `the ${what} selector "${spelled}" matches no table or ARIA grid under "${sel}"`,
        ),
      };
    }
    if (targets.length > 1) {
      return {
        error: badStructure(
          `the ${what} selector "${spelled}" matches ${targets.length} tables or ARIA grids under `
          + `"${sel}" — it must match exactly one`,
        ),
      };
    }
    const target = targets[0];
    if (!mayName(target, what)) {
      return {
        error: badStructure(
          `the ${what} selector "${spelled}" is not the selected element nor one of the tables `
          + `beside it`,
        ),
      };
    }
    // Named as the SKETCH named it (`T2`) with the selector beside it: the
    // model's answer says T2 and the log line says T2 (§7.6), but an author
    // reading a refusal has never seen the sketch and needs the selector.
    const id = candidateIdOf(rootForMapping(), target);
    return {
      el: target,
      kind: target.tagName === 'TABLE' ? 'table' : 'grid',
      selector: spelled,
      name: id ? `${id} ("${spelled}")` : `"${spelled}"`,
    };
  };

  /** §7.6's parenthetical, when a structure answer produced this read. */
  let structure = null;

  if (mapping && mapping.kind === 'collection') {
    // §7.10's other answer: the region holds no rows and no cells at all —
    // repeated cards, or one small key/value table per record (§5.9.3, §5.9.4)
    // — so there is no table to read and the record is assembled from one
    // field selector per requested column. Everything the author can observe
    // is the same as a table read: `_row` first, hidden items excluded, the
    // §7.4 rendered-text rule, the `data-aiui-row` stamp.
    const itemSel = typeof mapping.item === 'string' ? squash(mapping.item) : '';
    if (itemSel === '') return badStructure('no item selector was given');
    const found = lookup(itemSel);
    if (found === null) {
      return badStructure(`the item selector "${itemSel}" is not a CSS selector`);
    }
    if (found.length === 0) {
      return badStructure(`the item selector "${itemSel}" matches nothing under "${sel}"`);
    }
    // The same fence the `rows` half gets, for the same measured reason: the
    // mapping root is wider than the region, so `".card"` written against a
    // sibling box would collect records the author never selected and report
    // them under the author's selector.
    const outside = found.filter((e) => !insideRegion(e));
    if (outside.length > 0) {
      return badStructure(
        `the item selector "${itemSel}" matches ${outside.length} `
        + `${plural(outside.length, 'element', 'elements')} outside "${sel}" — every item must `
        + `be inside the selected element`,
      );
    }
    if (found.length > maxRows) {
      return badStructure(
        `the item selector "${itemSel}" matches ${found.length} elements under "${sel}" — the `
        + `maximum is ${maxRows}`,
      );
    }
    // An item inside another item is a selector that matched a container AND
    // its contents, so every record would be read twice, once whole and once
    // in pieces. Refused rather than de-duplicated: which of the two the
    // author meant is exactly the guess this action does not make.
    const nested = found.filter((e) => found.some((other) => other !== e && other.contains(e)));
    if (nested.length > 0) {
      return badStructure(
        `the item selector "${itemSel}" matches ${nested.length} `
        + `${plural(nested.length, 'element', 'elements')} inside another match — an item must not `
        + `contain another item`,
      );
    }
    // A field is keyed by the column's KEY, not by its header or its position:
    // a collection has no headers to name and no columns to count, so the name
    // the author gave the value is the only thing both sides can agree on.
    const fieldsFor = mapping.fields && typeof mapping.fields === 'object' ? mapping.fields : {};
    const fieldSelectors = new Map();
    for (const col of wanted) {
      const raw = fieldsFor[col.key];
      const spelled = typeof raw === 'string' ? squash(raw) : '';
      if (spelled === '') return badStructure(`no field was given for the "${col.key}" column`);
      fieldSelectors.set(col.key, spelled);
    }
    const shownItems = found.filter(rendered);
    const chosenItems = bound === null ? shownItems : shownItems.slice(0, bound);
    /** How many items a field was ABSENT from — §7.10's "counted in the log
     *  line", which is the only signal that a column read `""` because the
     *  card did not have it rather than because it was empty. */
    const fieldsMissing = {};
    const fieldsFound = new Map();
    const collected = [];
    for (let i = 0; i < chosenItems.length; i++) {
      const item = chosenItems[i];
      const record = {};
      record[rowKey] = String(i + 1);
      for (const col of wanted) {
        const spelled = fieldSelectors.get(col.key);
        let matched;
        try {
          matched = items(item.querySelectorAll(spelled));
        } catch (err) {
          return badStructure(`the field "${col.key}" ("${spelled}") is not a CSS selector`);
        }
        if (matched.length > 1) {
          // Two elements for one value is the collection's version of §7.4's
          // misalignment: whichever was picked, half the records could take
          // the other one.
          return badStructure(
            `the field "${col.key}" ("${spelled}") matches ${matched.length} elements in item `
            + `${i + 1} — it must match at most one`,
          );
        }
        if (matched.length === 0) {
          record[col.key] = '';
          fieldsMissing[col.key] = (fieldsMissing[col.key] || 0) + 1;
          continue;
        }
        fieldsFound.set(col.key, (fieldsFound.get(col.key) || 0) + 1);
        record[col.key] = cellTextOf(matched[0]);
      }
      collected.push(record);
    }
    for (const col of wanted) {
      // Absent from EVERY item is a wrong selector, not an empty value: a
      // column of nothing but `""` is a convincingly wrong answer, which is
      // the one outcome this action exists to prevent.
      if (!fieldsFound.has(col.key)) {
        return badStructure(
          `the field "${col.key}" ("${fieldSelectors.get(col.key)}") matches nothing in any of the `
          + `${chosenItems.length} ${plural(chosenItems.length, 'item', 'items')}`,
        );
      }
    }
    const missingNotes = Object.keys(fieldsMissing).map(
      (key) => `${fieldsMissing[key]} ${plural(fieldsMissing[key], 'item', 'items')} missing ${key}`,
    );
    stampRows(rootForMapping(), chosenItems);
    return {
      ok: true,
      records: collected,
      // Nothing here is a placeholder: an item either rendered and was read or
      // was not there at all.
      placeholdersSkipped: 0,
      dataRowCount: shownItems.length,
      label: regionLabel,
      headerFromSeparateTable: false,
      structure: {
        kind: 'collection',
        source: structureSource || 'model',
        summary:
          `${shownItems.length} ${plural(shownItems.length, 'item', 'items')} by "${itemSel}"`
          + (missingNotes.length > 0 ? `; ${missingNotes.join('; ')}` : ''),
      },
      ...(missingNotes.length > 0 && { fieldsMissing }),
    };
  }

  /** The two halves a `{ kind: 'table' }` mapping pins (§7.10). */
  let mappedRows = null;
  let mappedHeader = null;
  if (mapping && mapping.kind === 'table') {
    const rowsTarget = resolveTarget(mapping.rows, 'rows');
    if (rowsTarget.error) return rowsTarget.error;
    mappedRows = rowsTarget;
    const spec = mapping.header;
    if (spec && typeof spec === 'object') {
      const headerTarget = resolveTarget(spec.selector, 'header');
      if (headerTarget.error) return headerTarget.error;
      mappedHeader = { target: headerTarget, bodyRow: spec.bodyRow };
    }
  }

  /** The thing being read: a `<table>`, or an ARIA grid (§7.9). Both answer
   *  the same questions from here on, through their row views. */
  let container = null;
  let containerKind = 'table';
  /**
   * The grid WRAPPER, when one is in play (§5.6): the matched element itself
   * when it is neither a table nor an ARIA grid, and otherwise the element
   * holding both halves once a header is adopted from another table (§7.3a),
   * which is discovered further down.
   *
   * It exists for the diagnostics as much as for the search. Kendo's own
   * tables carry `role="none"` and no accessible name at all, so without the
   * wrapper's name a failure reads `cannot map table "#holdings-grid
   * .k-grid-content table"` — the selector, not the grid (§7.2 point 4).
   */
  let wrapper = el.tagName === 'TABLE' || ownsAriaRows(el) ? null : el;
  /** Every table under that wrapper, classified — kept so the header search
   *  below does not walk the grid a second time. */
  let wrapperTables = [];
  /** The selected table, already classified on the wrapper path. */
  let picked = null;

  if (mappedRows) {
    // §7.10: the rows were NAMED, so §7.2's search does not run. Validated
    // already — it resolved to exactly one table or grid under the region.
    container = mappedRows.el;
    containerKind = mappedRows.kind;
  } else if (!wrapper) {
    // §7.9: the matched element IS the table — as a `<table>` whatever role it
    // carries (`<table role="grid">` is a table, §10), or as an ARIA grid.
    container = el;
    containerKind = el.tagName === 'TABLE' ? 'table' : 'grid';
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
    // §7.9: the ARIA grids under the wrapper, on the same terms — rendered,
    // and not sitting inside a table or another grid, which `candidatesOf`
    // already decides. A `<table role="grid">` is not among them: the tag
    // wins, so it is one of `wrapperTables` and is read as a table (§10).
    const ariaGrids = candidatesOf(wrapper)
      .filter((cand) => cand.kind === 'grid' && rendered(cand.el))
      .map((cand) => ({ el: cand.el, split: ariaSplit(cand.el) }));
    const ariaWithData = ariaGrids.filter(
      (grid) => grid.split.bodyRows.some((view) => !messageRow(view)),
    );
    // DATA rows (§7.2): body rows that are not §4.8 message rows, rendered or
    // not. RadGrid's header table holds one hidden `<td colspan="9">` spacer
    // and its pager table one `<td colspan="9">` row, and counting those as
    // rows made its box "3 tables with rows" — the measured refusal §5.7 is
    // written to fix.
    //
    // The fallback is the emptied grid: a split grid whose rows have become
    // one "No records available." message row has no table with DATA under
    // its wrapper at all, and §4.8 says that reads `[]`. So when nothing has
    // data, the tables that have any body row are counted instead — but
    // counted FLAT, that is every table in the box: RadGrid's emptied box
    // still holds the header table's hidden `<td colspan="9">` spacer and the
    // pager's own row, so it refused "found 3 tables with rows … frozen
    // (locked) columns" for a grid that simply has no rows in it.
    //
    // So the fallback asks which of those is the DATA half (§7.2), in three
    // steps that are each a fact the page states about itself:
    //
    //  - a HEADER-ONLY table is out. It names columns and has no data row,
    //    which is what the header half of a split grid is; the spacer row in
    //    RadGrid's header table is a §4.8 message and does not make it a data
    //    table (§5.7).
    //  - a table whose `aria-owns` names another table's header (§7.3a.1) is
    //    the row half, said outright. RadGrid's emptied data table carries it.
    //  - failing that, `role="grid"` — what Kendo's body table carries and its
    //    header table (a `<thead>` with no `<tbody>` at all) does not.
    //
    // The first level that has anything in it decides, and it has to hold
    // exactly ONE table: two tables at the same level is still the frozen
    // (locked) columns shape, and picking one of them would be reading half a
    // grid (§7.3a, §14).
    const withData = wrapperTables.filter((info) => info.data.length > 0);
    // §7.9's arbitration between the two providers, asked before either is
    // read. A `<table>` with data rows and an ARIA grid with data rows under
    // one wrapper are TWO things with rows, and picking either is the
    // half-a-grid misalignment §7.2 refuses for two tables. An ARIA grid with
    // no data rows is not in the running at all — a MUI grid rendered empty
    // beside a real table must not stop that table from being read.
    if (withData.length > 0 && ariaWithData.length > 0) {
      return failShape(
        `readTable found a table and an ARIA grid with rows under "${sel}" — it must be exactly `
        + `one, so select the one you mean`,
      );
    }
    if (ariaWithData.length > 1) {
      return failShape(
        `readTable found ${ariaWithData.length} ARIA grids with rows under "${sel}" — it must be `
        + `exactly one, so select the one you mean`,
      );
    }
    // The one grid with rows wins whenever no table has any; failing that, a
    // LONE grid with no data rows is still the thing the author pointed at,
    // and §4.8 says an empty table reads `[]` rather than refusing. Both are
    // gated on there being no table under the wrapper to read instead.
    const grid = ariaWithData.length === 1
      ? ariaWithData[0]
      : (withData.length === 0 && wrapperTables.length === 0 && ariaGrids.length === 1
        ? ariaGrids[0]
        : null);
    if (grid) {
      container = grid.el;
      containerKind = 'grid';
    }
    let withRows = container ? [] : withData;
    if (!container && withRows.length === 0) {
      const candidates = wrapperTables.filter(
        (info) => info.body.length > 0 && !info.headerOnly,
      );
      const declaring = candidates.filter((info) => declaredHeaderSource(info.table) !== null);
      const grids = candidates.filter(
        (info) => hasRole(info.table, 'grid'),
      );
      const rest = candidates.filter(
        (info) => !declaring.includes(info) && !grids.includes(info),
      );
      for (const level of [declaring, grids, rest]) {
        if (level.length > 0) {
          withRows = level;
          break;
        }
      }
    }
    if (!container && withRows.length === 0) {
      // Nothing with rows under the wrapper at all. §7.9 widens what the
      // sentence MEANS — no `<table>` and no ARIA grid with data rows — and
      // leaves the words alone, because they still say what was looked for.
      // §7.10 can answer this one: it is the first of the shape reasons.
      return failShape(`readTable found no table with rows under "${sel}"`);
    }
    if (withRows.length > 1) {
      // Never `.first()`: a grid with frozen (locked) columns renders its
      // rows TWICE, split by column across two tables, so reading one half is
      // exactly the misalignment this action exists to prevent (§7.3a, §14).
      return failShape(
        `readTable found ${withRows.length} tables with rows under "${sel}" — it must be exactly `
        + `one; a grid with frozen (locked) columns splits its rows across two tables, which is `
        + `not supported`,
      );
    }
    if (!container) {
      picked = withRows[0];
      container = picked.table;
    }
  }
  /** The selected `<table>`, or null on the ARIA path. Every §7.3/§7.3a rule
   *  below is a question about a `<table>` and is asked only when there is
   *  one; §7.9's provider answers the same questions its own way. */
  const table = containerKind === 'table' ? container : null;

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
   *
   * §7.9 spells the same chain for an ARIA grid — `aria-label`, then what
   * `aria-labelledby` names, then the `id`, then the selector — with the
   * wrapper's name in the one place a table's grid name goes. A grid has no
   * `<caption>`, so that link of the chain is simply absent for one.
   */
  const caption = table ? table.caption : null;
  const ownName =
    squash(container.getAttribute('aria-label') || '')
    || (caption ? squash(caption.textContent || '') : '')
    || labelledByText(container);
  const nameNow = () => ownName || (wrapper ? wrapperName(wrapper) : '') || container.id || sel;
  let label = nameNow();
  const cannot = (why) => fail(`readTable cannot map table ${quoted(label)}: ${why}`);
  /** The same sentence, for the two `cannot` refusals §7.10 counts as SHAPE:
   *  a header that was requested and does not exist anywhere, and a pairing
   *  whose two halves are different widths. Both are questions about what the
   *  page IS, which is the only kind the model is asked. */
  const cannotShape = (why) => failShape(`readTable cannot map table ${quoted(label)}: ${why}`);
  /** Adopt `found` as the grid now that it is known to hold both halves, and
   *  rename the table after it. */
  const nameAfterWrapper = (found) => {
    if (!found) return;
    wrapper = found;
    label = nameNow();
  };
  /** §7.4, verbatim, for a merged BODY cell: a guessed logical grid would be
   *  plausible and wrong. The header has no such refusal any more — §7.3b lays
   *  every header shape out instead (§7.3b.6). */
  const merged = () =>
    cannot('merged headers or cells (rowspan/colspan > 1) are not supported');

  // ── 2. rows and the header grid, from ONE of the two providers ───────
  //
  // Four answers is all the rest of this file needs: which rows are the
  // body’s, how wide the thing is, what its header grid is, and whether that
  // header came from somewhere else. A `<table>` answers them through §7.4,
  // §7.3 and §7.3a; an ARIA grid answers them through §7.9. Nothing below this
  // point asks which it was reading — that is what keeps §4.8’s placeholder
  // rules, §7.4’s records loop and the stamp from existing twice.
  let bodyRows;
  let widestBody = 0;
  let headerGrid = null;
  /** Did the header come from a DIFFERENT table (§7.3a)? The summary line says
   *  so (§7.6): a wrong pairing is otherwise invisible in the log, and the
   *  records it produces look exactly like a correct read. Always false on the
   *  ARIA path: a grid’s header is inside it or nowhere (§7.9). */
  let headerFromSeparateTable = false;

  if (mappedRows) {
    // ── §7.10: both halves named, nothing searched for ─────────────────────
    //
    // The validation is everything the search would otherwise have
    // established, asked outright: the rows table has rows, the header names
    // columns, and the two line up. All of it is deterministic — the model
    // said where to look, never what is there — so a mapping that has stopped
    // fitting the page fails with a sentence about the page rather than
    // reading the wrong columns (§7.10, "a cached mapping no longer fits").
    //
    // `bodyRowsOf` for a table, NOT `classify`: §7.3's header search must not
    // run here at all. A §5.9.1 table's headings are in its first body row,
    // and the search — which needs a `<th>` — would leave that row in the
    // data and read the headings as record 1.
    bodyRows = containerKind === 'grid'
      ? ariaSplit(container).bodyRows
      : bodyRowsOf(container).map(tableRowView);
    if (mappedHeader) {
      const target = mappedHeader.target;
      const asked = mappedHeader.bodyRow;
      if (asked !== undefined && asked !== null) {
        // "the k-th BODY row", one-based — the rows a read would return, not
        // the rows of the element, so `<thead>` never shifts the count.
        const rows = target.kind === 'grid'
          ? ariaSplit(target.el).bodyRows
          : bodyRowsOf(target.el).map(tableRowView);
        const at = Math.trunc(Number(asked));
        if (!Number.isFinite(at) || at < 1 || at > rows.length) {
          return badStructure(
            `${target.name} has ${rows.length} body ${plural(rows.length, 'row', 'rows')}, so `
            + `there is no body row ${JSON.stringify(asked)} to use as the header`,
          );
        }
        const named = rows[at - 1];
        // A header row has to be a row a reader can SEE holding the names,
        // and the two rows that are not are exactly the two this mapping can
        // land on by accident. An unrendered row is a template or a filtered
        // row: its cells still hold text, so it would name every column
        // plausibly and the read would look right. A §4.8 message row ("No
        // records found", one cell across the table) names one column and
        // nothing else, and taking it as the header ALSO splices the real
        // first row out of the data.
        if (!named.els.some(rendered)) {
          return badStructure(`body row ${at} of ${target.name} is hidden`);
        }
        if (messageRow(named)) {
          return badStructure(
            `body row ${at} of ${target.name} is a placeholder row, not a header`,
          );
        }
        headerGrid = headerGridOf([named]);
        // Spliced out of the data when it is THIS table's own row: a header
        // left in the body becomes record 1 and shifts every `_row` below it
        // by one, which is §4.5's misalignment (§7.3 splices it for the same
        // reason).
        if (target.el === container) bodyRows.splice(at - 1, 1);
      } else {
        // No row named: the header is that element's own header grid — a
        // `<thead>`, or an ARIA grid's `columnheader` rows (§7.3b, §7.9).
        const own = target.kind === 'grid'
          ? (() => {
            const split = ariaSplit(target.el);
            return split.headerRows.length > 0 ? headerGridOf(split.headerRows) : null;
          })()
          : classified(target.el).grid;
        if (!own) {
          return badStructure(
            `${target.name} has no header row of its own — name the body row that holds the `
            + `headings`,
          );
        }
        headerGrid = own;
      }
      if (!headerGrid.names.some((name) => name !== '')) {
        return badStructure(`${target.name} names no column, so it cannot be the header`);
      }
      headerFromSeparateTable = target.el !== container;
    }
    const mappedData = bodyRows.filter((row) => !messageRow(row));
    if (mappedData.length === 0) {
      // An empty table reads `[]` when the author pointed at it (§4.8), but a
      // STRUCTURE answer naming a table with no rows in it is an answer about
      // the wrong table — the rows the author asked for are somewhere else.
      return badStructure(`${mappedRows.name} has no data rows`);
    }
    for (const row of bodyRows) {
      if (row.width > widestBody) widestBody = row.width;
    }
    if (headerGrid) {
      let widestData = 0;
      for (const row of mappedData) {
        if (row.width > widestData) widestData = row.width;
      }
      if (headerGrid.width !== widestData) {
        // §7.3a's sentence, word for word: a header one column off is the
        // same misalignment whether a search or a model paired the two.
        return cannot(
          `the header table has ${headerGrid.width} `
          + `${plural(headerGrid.width, 'cell', 'cells')} but its widest row has `
          + `${widestData} — the two tables do not line up`,
        );
      }
    }
    structure = {
      kind: 'table',
      source: structureSource || 'model',
      // Did the mapping read a table OTHER than the one the author selected?
      // Legitimate and common — a wrapper region's rows are always a table
      // inside it — but it is the difference between "the read you asked for"
      // and "a read of something next to it", and the caller warns on it so a
      // reader of the log has been told before the values look wrong.
      rowsElsewhere: mappedRows.el !== el,
      summary:
        `rows in ${mappedRows.name}`
        + (mappedHeader
          ? (mappedHeader.bodyRow !== undefined && mappedHeader.bodyRow !== null
            ? `, header row ${mappedHeader.bodyRow} of ${mappedHeader.target.name}`
            : `, header from ${mappedHeader.target.name}`)
          : ', no header'),
    };
  } else if (containerKind === 'grid') {
    // §7.9: the rows are the `role="row"` descendants this grid owns — never a
    // nested grid’s — joined by `aria-rowindex` where a pinned container has
    // split one row across two elements; the header rows are the ones holding
    // `columnheader`s and no data, laid out by the same §7.3b code as a
    // `<thead>`. There is no §7.3a pairing here and no header-only pick: a
    // grid that holds only headings is an empty table and reads `[]` (§4.8).
    const split = ariaSplit(container);
    bodyRows = split.bodyRows;
    headerGrid = split.headerRows.length > 0 ? headerGridOf(split.headerRows) : null;
    // A grid row’s width is the highest column its cells COVER, not how many
    // it has: `aria-colindex` may leave gaps, and MUI’s `role="none"` filler
    // occupies no column at all, so a cell count measures a four-column row
    // as three and §4.8’s full-width test then misreads every message row.
    for (const row of bodyRows) {
      if (row.width > widestBody) widestBody = row.width;
    }
  } else {
    // ── 2. rows belonging to THIS table (§7.4) ───────────────────────────────
    // A COPY: the header row is spliced out below, and `selected` is the
    // classification `classified` remembers — §7.3a asks about this same table
    // again from the other side, and it must not be asked about a row list this
    // read has since edited.
    const selectedInfo = picked || classified(table);
    bodyRows = selectedInfo.rows.slice();

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
    for (const row of bodyRows) {
      if (row.width > widestBody) widestBody = row.width;
    }

    // ── 3. the header grid (§7.3, §7.3b), and where it comes from (§7.3a) ────
    headerGrid = selectedInfo.grid;
    if (headerGrid && selectedInfo.index >= 0) bodyRows.splice(selectedInfo.index, 1);

    /** The rows of this table that are DATA — §7.2's test, the cheap one that
     *  does not need the width (§4.8's own rule runs later, against it). Two
     *  questions ask it: whether a header-only table is the one being read, and
     *  what an adopted header's width has to line up with. */
    const nonMessageRows = bodyRows.filter((row) => !messageRow(row));

    if (!headerGrid) {
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
        return failShape(
          `readTable found ${ambiguous} header-only tables beside ${quoted(label)} — it must be `
          + `exactly one; a grid with frozen (locked) columns splits its header across two tables, `
          + `which is not supported`,
        );
      }
      if (source) {
        // Both halves are known, so the element holding them is the grid and
        // the diagnostics name the table after it (§7.2 point 4) — BEFORE the
        // width refusal below, which otherwise names the grid by the row table's
        // generated GUID (`cannot map table "14277be2-015b-…"`).
        if (!wrapper) nameAfterWrapper(commonAncestor(table, source.table));
        // The adopted header is the other table's HEADER GRID (§7.3b), laid out
        // in the table it lives in — RadGrid's is three rows of bands, names and
        // filters and is nine columns wide.
        const adopted = source.grid;
        if (adopted) {
          // The widths must line up, because a header one column off is §4.5's
          // misalignment wearing a plausible face. Measured over the rows that
          // hold a GRID: a body of nothing but full-width message rows (the
          // grouped grid's "No records available." row, §4.8) is one cell wide
          // and has nothing to misalign, so it is no evidence either way —
          // counted, it refused every emptied grid as a mismatch.
          let widestData = 0;
          for (const row of nonMessageRows) {
            if (row.width > widestData) widestData = row.width;
          }
          if (nonMessageRows.length > 0 && adopted.width !== widestData) {
            // "the header table", not "the header in the table beside it": the
            // same check runs on the DECLARED path, where the header table is
            // wherever `aria-owns` pointed and need not be beside anything. The
            // count is the header GRID's width, not a row's cell count: a banded
            // header's name row is narrower than the grid it names (§7.3b).
            return cannotShape(
              `the header table has ${adopted.width} `
              + `${plural(adopted.width, 'cell', 'cells')} but its widest row has `
              + `${widestData} — the two tables do not line up`,
            );
          }
          headerGrid = adopted;
          headerFromSeparateTable = true;
        }
      }
    } else if (!wrapper && nonMessageRows.length === 0) {
      // §7.3a.3, the header-only pick. This table holds the header row and no
      // DATA — RadGrid's header table holds one hidden `<td colspan="9">` spacer
      // row, which is a message and not a row of the grid (§4.8, §5.7) — and the
      // rows are in a table that names this header through
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
  }

  // ── 4. which rows are rendered, and how wide the table is ────────────────
  // The width the placeholder rule measures against is the header GRID's
  // width (§7.3b: never a row's cell count — RadGrid's name row has eight
  // cells for nine columns), or, with no header, `widestBody` — every body
  // row, rendered or not (§4.8, and see that measurement for why the hidden
  // ones count).
  //
  // It is settled BEFORE any row is classified, because the classification
  // depends on it.
  //
  // A row is rendered when ANY of its fragments is (§7.9): ag-Grid's pinned
  // container and its centre container are laid out separately, and a row
  // whose pinned half is scrolled out of view is still on the page.
  const visibleRows = bodyRows.filter((row) => row.els.some(rendered));
  const width = headerGrid ? headerGrid.width : widestBody;

  // ── 5. resolve each column to a one-based position ───────────────────────
  const headerLabels = headerGrid ? headerGrid.names : [];

  /**
   * The one-based positions a requested header matches (§7.3b.4).
   *
   * The PLAIN reading is tried first, over the whole string: a column whose
   * heading genuinely contains " > " is named by typing it, and splitting
   * first would make that column unreachable. Only when nothing is headed
   * that is the request read as `Band > Leaf` — the last segment names the
   * leaf, and each earlier segment must match a band over that column, taken
   * from the top down. That is how `Q1 > Fee` and `Q2 > Fee` are told apart
   * where the plain `Fee` is the duplicate refusal with two positions.
   *
   * The split takes ANY whitespace around the `>`, none included: `Q1>Fee` and
   * `Q1 >Fee` are how the separator gets typed at least as often as the spaced
   * form, and split on the three-character `' > '` alone each of those stayed
   * ONE segment, matched no leaf and refused a column that is there.
   */
  const matchHeader = (grid, requested) => {
    const plain = [];
    const wantPlain = fold(requested);
    for (let col = 0; col < grid.width; col++) {
      if (fold(grid.names[col] || '') === wantPlain) plain.push(col + 1);
    }
    if (plain.length > 0) return plain;
    const segments = requested.split(/\s*>\s*/).map(squash).filter((s) => s !== '');
    if (segments.length < 2) return plain;
    const leaf = fold(segments[segments.length - 1]);
    const over = segments.slice(0, -1).map(fold);
    const hits = [];
    for (let col = 0; col < grid.width; col++) {
      if (fold(grid.names[col] || '') !== leaf) continue;
      let at = 0;
      for (const band of bandsOver(grid, col)) {
        if (at < over.length && fold(band.text) === over[at]) at++;
      }
      if (at === over.length) hits.push(col + 1);
    }
    return hits;
  };

  const resolved = [];
  for (const col of wanted) {
    if (typeof col.header === 'string') {
      if (!headerGrid) {
        // §5.4, verbatim: the message's whole job is to name the way out.
        // SHAPE (§7.10): a header was asked for and no path found one — not a
        // `<thead>`, not a body row of `<th>`s, not a table beside it, not a
        // grid's `columnheader`s. That is exactly the question §5.9's
        // `<td>`-headed table and header-after-rows pair are answered by.
        return cannotShape(
          `it has no header row, so "${col.header}" cannot be matched — name columns by `
          + `position ("the 1st column as ${col.key}")`,
        );
      }
      const hits = matchHeader(headerGrid, col.header);
      if (hits.length === 0) {
        // Exact match only. A renamed header is a test failure worth reading;
        // a fuzzy match would quietly read the wrong column.
        const available = headerLabels.filter((t) => t !== '');
        // A request that names a BAND says so (§5.3): "Order" over ID and
        // Customer is not a column, and the leaves under it are what the
        // author meant to type. The second half of this sentence is the only
        // difference between "you named a group" and "you named nothing here".
        const band = headerGrid.bands.find((b) => fold(b.text) === fold(col.header));
        // A header that EXISTS and does not hold this name is the author's own
        // problem — a typo, or a renamed column — and §7.10 never asks the
        // model about it: the answer would be a licence to read some other
        // column. A header that names NOTHING is the shape question again,
        // asked one row too high.
        const say = available.length > 0 ? cannot : cannotShape;
        return say(
          `no column is headed "${col.header}"`
          // §7.3b.5 keeps a `<thead>` that names nothing from being a header at
          // all, so the second branch is reached only by a BODY-row header
          // whose cells are all blank — which stays the header, because it is a
          // row of the table and nothing else would take it out of the data.
          + (available.length > 0
            ? ` — available headers are ${available.join(', ')}`
            : ' — its header row has no non-empty headings')
          + (band
            ? ` ("${col.header}" is a band over ${leavesUnder(headerGrid, band).join(', ')}, `
              + 'not a column)'
            : ''),
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
    //
    // `across` rather than `colSpan`, so §4.8's lone-spanning test reads an
    // ARIA row's `aria-colspan` the same way (§7.9). A `role="row"` with no
    // cell in it at all lands in the first branch, as an empty `<tr>` does.
    const full = Math.max(width, 2);
    if (cells.length === 0 || (cells.length === 1 && cells[0].across >= full)) {
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
      const wide = cells.filter((c) => c.across >= full);
      if (
        wide.length === 1
        && rendered(wide[0].el)
        && cells.every((c) => c === wide[0] || !rendered(c.el))
      ) {
        placeholdersSkipped++;
        continue;
      }
    }
    // The DETAIL row, measured on RadGrid and the same in Kendo: expanding a
    // row inserts, right after it and with no class or id of its own,
    // `<td class="rgExpandCol">&nbsp;</td><td colspan="8">…</td>` — TWO cells,
    // both rendered, so neither rule above sees it. It reached the merged-cell
    // refusal, and every read of the grid failed from the moment a user
    // expanded anything.
    //
    // What it is, structurally: TWO OR MORE cells fewer than the grid has
    // columns, spanning their way to the full width. Four neighbours stay out
    // of it, each because a skip would be the wrong answer:
    //
    //  - a row that does NOT reach the width (§10's `<td colspan="3">` in a
    //    five-column table) is a merged grid, not a message, and is refused;
    //  - a row with as many cells as the width AND a spanning cell is wider
    //    than the grid, so it is refused as before;
    //  - a row ONE cell short of the width is refused too. `<td>a</td>
    //    <td colspan="2">b</td>` in a three-column table is the merged DATA
    //    row §10 has always refused — two values where three columns are, and
    //    which of B and C the wide cell holds is exactly the guess §7.4 exists
    //    not to make. A detail row is a row of a different SHAPE, not a row
    //    missing one cell: RadGrid's is 2 cells of 9 and Kendo's 2 of 6, so
    //    `width - cells.length >= 2` keeps both and hands the one-short row
    //    back to the merged-cell refusal;
    //  - a cell spanning ROWS shifts every row below it (§4.8's `rowspan="0"`
    //    included, which the DOM reports as 0), and nothing about skipping one
    //    row fixes what it did to the next.
    if (cells.length > 0 && width - cells.length >= 2) {
      let covered = 0;
      let across = false;
      let down = false;
      for (const cell of cells) {
        covered += cell.across > 0 ? cell.across : 1;
        if (cell.across > 1) across = true;
        if (cell.down !== 1) down = true;
      }
      if (across && !down && covered >= width) {
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
    const cells = row.cells;
    // Cell-shape validation applies to SELECTED rows only: a malformed row
    // past the author's explicit bound is a row nobody asked for.
    for (const cell of cells) {
      if (spanned(cell)) return merged();
    }
    const record = {};
    // `_row` first, so the report and the Variables panel show it first.
    record[rowKey] = String(rowNumber);
    for (const col of resolved) {
      // By POSITION, not by order: a `<td>`'s position is its place in the
      // row, but an ARIA cell's is its `aria-colindex` (§7.9), which is what
      // makes MUI's `role="none"` filler cost nothing and what lets ag-Grid's
      // pinned fragment contribute column 1 while the centre one contributes
      // 2 and 3.
      const cell = row.byPos.get(col.position);
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
      record[col.key] = cellTextOf(cell.el);
    }
    records.push(record);
  }

  // ── 8. leave the numbering ON the page (§7.4) ────────────────────────────
  //
  // The one and only mutation this extractor makes, and it is here because of
  // a measured failure. On pass 7 of a loop over the RadGrid records the step
  // read "row 7 of the Loan applications grid"; the model counted the rows
  // itself and built `#RadGrid1_ctl00__7`, whose ids run from ZERO — so it
  // clicked row 8, Grace Abernathy, and the step passed green. A row's own
  // number is written nowhere in the markup, so the read writes it: every DATA
  // row of the table it just read carries `data-aiui-row="<_row>"`, which a
  // later step addresses as `[data-aiui-row="7"]` instead of doing arithmetic
  // on an id.
  //
  // Cleared over the table FIRST, so a re-read after paging, sorting or
  // filtering renumbers from scratch and a row that has stopped being a data
  // row — hidden by a filter, or now sitting under a detail row — loses its
  // stamp instead of keeping a stale one. A header, filter, spacer,
  // placeholder, detail or hidden row is never stamped, and nothing outside
  // this table is touched at all.
  //
  // Over every DESCENDANT carrying the stamp, not `table.rows`: a nested table
  // inside a detail row is not in `table.rows`, so a stamp an earlier read of
  // THAT table left behind survived the clear, and `#outer [data-aiui-row="2"]`
  // then matched the nested row as well as the real one.
  //
  // ALL the data rows, not only the `limit` prefix: the numbering describes
  // the table, and a bounded read must not leave row 11 of the same table
  // unaddressable.
  //
  // Written LAST, after the row cap and after every cell of every selected row
  // has been read, so a read that REFUSES — too many rows, a merged cell, a
  // row too short for a column — changes nothing at all. Stamped before those
  // checks, a failed read left its own numbering behind and the next step
  // addressed rows of a table the framework had just said it could not map.
  //
  // An ARIA grid's data rows are stamped the same way (§7.9), on the FIRST
  // fragment: ag-Grid's pinned half and its centre half are one row, and
  // stamping both would make `[data-aiui-row="7"]` match two elements and the
  // step after the read ambiguous.
  stampRows(container, dataRows.map((row) => row.el));

  return {
    ok: true,
    records,
    placeholdersSkipped,
    dataRowCount: dataRows.length,
    label,
    headerFromSeparateTable,
    ...(structure !== null && { structure }),
  };
}
