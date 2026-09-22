---
tags: [table-read]
timeout: 600s
---

# Table read — a grid whose header and rows are separate tables

The §5.6 case of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md),
against `fixtures/test-app/split-grids.html`. Telerik/Kendo, DevExpress and
Syncfusion all render a scrollable grid as TWO tables inside one wrapper
`<div>` — the header row in the first, the data rows in the second, and often
a footer in a third — so the column names the test author reads off the screen
are not in the table the rows are in. Before §7.3a, a header-named read of the
row table failed "it has no header row" and a read of the header table stored
`[]` and passed green.

Three grids are read here:

- **Holdings** (`#holdings-grid`) — Kendo markup with `aria-owns` on the row
  table, declaring which `<thead>` is its header (§7.3a.1), plus a footer
  table the read must ignore.
- **Dividends** (`#dividends-grid`) — the grouped form with NO `aria-owns`, so
  the two tables are paired by the sibling rule (§7.3a.2). Its group rows are
  one spanning cell followed by `<td hidden>` fillers, which §4.8 skips as
  placeholders: they take no `_row`, so the master rows number straight
  through them.
- **Watchlist** (`#watchlist-grid`) — the sibling rule again, with nothing
  Kendo-shaped to key off: DevExpress class names, no `aria-owns`, and no
  `role` or `aria-label` on the wrapper, so the pairing has only the structure
  and the id to go on. Its fourth column, Target, is hidden in the header and
  in every row, so each row has five cells while four render: the hidden cell
  reads as `""` and keeps Symbol, Name, Last and Alert lined up with their own
  headings (§7.4, §10). The read here names **Symbol and Last**, not the
  hidden column — the alignment is what Target proves, not the value.
- The **Frozen holdings** grid on the same page is Kendo's locked-columns
  form — four tables, the rows split by column across two of them — and is
  deliberately NOT read here: §7.3a refuses it by name rather than reading
  half a grid.

**Requires phase 1 of the spec.** What the proving run must show, beyond
green: the run log records which selector the model actually chose for each of
the four reads — the wrapper, or the row table — and either choice must come
out with the same records, because the runtime pairs the halves whichever half
it was handed and refuses the header-only table outright. Those log lines are
the measurement of the "SPLIT GRIDS" prompt clause of §6.3; the summary line
beside each says `(header from a separate table)`, which is where a wrong
pairing would show — including on the Watchlist read, where nothing but the
sibling structure could have produced it. As in
`table-orders.md`, each record is checked against the page rather than
asserted over the JSON: the click-then-verify in the loop body is the proof
that a record came from the row it claims, and `Assert that {{holdings}}
contains "…"` would be a model-evaluated assertion over a long JSON literal.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to split-grids.html
2. Read the Symbol column as symbol, Name column as name, and Value column as value from every row in the Holdings grid [store as: holdings]
3. For each {{holding}} in {{holdings}}, Check the holding
4. Click the "Swap the Symbol and Value columns" button
5. Read the Symbol column as symbol, Name column as name, and Value column as value from every row in the Holdings grid [store as: holdings_after]
6. For each {{holding}} in {{holdings_after}}, Check the holding after the swap
7. Read the Symbol column as symbol, Ex-date column as ex_date, and Amount column as amount from every row in the Dividends grid [store as: dividends]
8. For each {{dividend}} in {{dividends}}, Check the dividend
9. Read the Symbol column as symbol and Last column as last from every row in the Watchlist grid [store as: watchlist]
10. For each {{item}} in {{watchlist}}, Check the watchlist item

### Check the holding
1. Verify row {{holding._row}} of the Holdings grid is "{{holding.symbol}}"
2. Click Sell in row {{holding._row}} of the Holdings grid
3. Verify the page shows "Sell order for {{holding.symbol}} placed."

### Check the holding after the swap
1. Verify the Holdings grid has a row for "{{holding.symbol}}" showing {{holding.value}}

### Check the dividend
1. Verify the Dividends grid has a row for "{{dividend.symbol}}" with ex-date {{dividend.ex_date}} and amount {{dividend.amount}}

### Check the watchlist item
1. Verify the Watchlist grid has a row for "{{item.symbol}}" showing {{item.last}}
