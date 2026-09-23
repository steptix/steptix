---
tags: [table-read]
timeout: 900s
---

# Table read — grids with no `<table>` in them: MUI DataGrid and ag-Grid

The §5.8 / §7.9 case of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md),
against `fixtures/test-app/aria-grid.html`. Neither grid on that page contains
a single `<table>`, `<tr>` or `<td>`: both are `<div>`s carrying the ARIA table
model, which is what makes them tables to a screen reader and — since §7.9 —
tables here too. Nothing in the steps below says so. That is the point: an
author writes the same sentence for a `<table>`, for a Kendo split grid and
for these, and the runtime decides which mechanism reads it.

Two grids:

- **Accounts** (`#accounts-grid`) — the MUI DataGrid shape, walked from
  `https://mui.com/x/react-data-grid/`. `role="grid"` sits two `<div>`s *inside*
  the id the author names, so the read has to find the one grid under the
  wrapper rather than expect the wrapper to be it. Every row begins and ends
  with a `role="none"` filler that is not a cell and takes no column, and
  `aria-colindex="1"` is the select-all checkbox column whose heading renders
  blank — so the first column an author can ask for is the second one that
  exists. Eight accounts, every account name distinct; the read takes
  *Account*, *Balance* and *Status* and **not** *Owner*, so nothing it
  captures is ambiguous. The loop still names `row {{a._row}}` rather than
  the account, because what this file is proving is that each pass acts on
  **its own** row: the Freeze click has to land in the row the record was
  read from, and the banner it raises names that account, so a click that
  drifted by one row would name a different one and fail. Re-finding the row
  by its account name would be testing the model's re-find instead of the
  read's numbering. (*Owner* is where the grid's duplicates are — two of the
  eight belong to Sarah Mitchell — which is why a test that captured it
  would have no choice but `_row`.)
- **Trades** (`#trades-grid`) — the ag-Grid shape, with **Symbol pinned left**.
  A pinned column is not a column that renders first; it is a SECOND
  `role="row"` element, in a different container, carrying that row's first
  cell — and the only thing in the markup saying the two halves are one trade
  is that they share `aria-rowindex`. §7.9 joins them by that index, so the
  read must return six records each carrying Symbol *and* Value. A read that
  did not join would return twelve records, half of them one column wide, and
  the loop would fail on the first pass rather than quietly reporting the
  wrong thing.

`aria-rowindex` is deliberately NOT `_row`, and the page proves it twice: the
header is row 1 so the first account is `aria-rowindex="2"`, and the Status
filter hides rows with `display:none` **without renumbering**, so filtering to
Frozen leaves two visible rows still reading 5 and 9. `_row` is the position
among the data rows the read actually captured, which is what
`row {{a._row}}` in the loop resolves against.

**Requires phase 1 of the spec.** What the proving run must show, beyond
green: the Accounts read captures 8 records and the Trades read captures 6,
each Trades record carrying both the pinned Symbol and the Value beside it;
every `Freeze` click lands in the row its record came from, which the banner
`Freeze requested for <Account>.` is what checks — a click that drifted one
row would name a different account and fail. And **no structure question is asked
anywhere in this run**: an ARIA grid is decided structurally, so the run log
must carry no `readTable: structure asked of the model` line. The odd shapes
that do ask are `table-odd-shapes.md`.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to aria-grid.html
2. Read the Account column as account, Balance column as balance, and Status column as status from every row in the Accounts grid [store as: accounts]
3. Verify the Accounts grid shows 8 accounts
4. For each {{a}} in {{accounts}}, Check the account
5. Read the Symbol column as symbol, Side column as side, and Value column as value from every row in the Trades grid [store as: trades]
6. Verify the Trades grid shows 6 trades
7. For each {{t}} in {{trades}}, Check the trade

### Check the account
1. Verify row {{a._row}} of the Accounts grid is "{{a.account}}" with balance {{a.balance}}
2. Click Freeze in row {{a._row}} of the Accounts grid
3. Verify the page shows "Freeze requested for {{a.account}}."

### Check the trade
1. Verify the Trades grid has a row for "{{t.symbol}}" showing {{t.value}}
