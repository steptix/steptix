# 059 — a headerless table whose rows are all row headers loses its first row

**Status:** open / known limitation — §7.3's three conditions cannot tell a
row-header COLUMN from a header ROW when there is no header row to compare it
with, and `scope="row"` is the escape hatch.
**Area:**
[src/browser/scripts/read-table.js](../src/browser/scripts/read-table.js) —
the body-row header acceptance test (~line 340): `cells.length > 0 &&
hasHeading && !rowScoped && !lonelySpan`, with `rowScoped` (~line 336) the
only thing that can refuse the shape below.
**Related:**
[docs/specs/SPEC-structured-table-reads.md](../docs/specs/SPEC-structured-table-reads.md)
§7.3 (the body-row rule and its residual limits), §10 (`scope="row"` is that
row's own heading) and §14, which carries this as deferred.
[058](058-tbody-totals-row-steps-over-a-one-cell-header.md) is the other
shape the same review left.
**Opened:** 2026-09-21

## Summary

When the `<thead>` is absent or empty, the first body row that contains at
least one `<th>`, has no `scope="row"` cell and is not a lone spanning cell
is the header row — and it is removed from the body. That is right for the
common `<tr><td></td><th>Order ID</th><th>Status</th></tr>`.

It is wrong for a table with NO header at all whose every row carries its own
unscoped `<th>` heading. The first such row meets all three conditions, so it
is taken as the header and spliced out, and the read silently returns one
record fewer, starting at the second row. Nothing fails; the count is just
short.

## What it looks like

```html
<table id="t">
  <tbody>
    <tr><th>O-1</th><td>Delete</td></tr>
    <tr><th>O-2</th><td>Delete</td></tr>
    <tr><th>O-3</th><td>Delete</td></tr>
  </tbody>
</table>
```

Measured against the extractor in a real page, reading the 1st column:

    [{_row:"1",c1:"O-2"},{_row:"2",c1:"O-3"}]

`O-1` is gone, `dataRowCount` is 2, and `placeholdersSkipped` is 0 — there is
no signal anywhere that a row left the table. A header-named read is worse
again, because the row that vanished is also what the available-headers list
is built from.

The same markup with `scope="row"` reads all three:

    [{_row:"1",c1:"O-1"},{_row:"2",c1:"O-2"},{_row:"3",c1:"O-3"}]

Review 5 fixed the neighbouring half of this — a row-header row no longer
counts as the WIDER heading row that steps a one-cell header over — but the
acceptance test itself was left alone, so a row-header row with nothing above
it is still eligible to be the header.

## What a fix looks like

Refuse a multi-cell candidate whose `<th>` positions match the NEXT body
row's. Two consecutive rows with their headings in the same columns are a
row-header column, not a header row followed by data: a header row names the
columns once, and the row under it holds values. On the table above, rows 1
and 2 both have a `<th>` at position 1, so row 1 is refused, no header is
found, and all three rows are read.

The reviewer wrote that change during the review of this feature and measured
it green over 98 tests.

## Why it is not fixed here

Left by decision during the structured-table-reads review; the fix risks the
next shape. The comparison is with ONE following row, so a table whose first
data row happens to repeat the header's `<th>` layout — a `<thead>`-less grid
with a heading row of `<th>`s above a first row that is itself a subtotal or
a "select all" row of `<th>`s — would lose its header instead, which is the
failure this rule exists to avoid and is harder to spot than a missing row.
Widening the comparison to "every body row" trades that for a full pass over
the table before the header is known, which is a different shape of change
than a heuristic tweak.

There is also a legitimate escape hatch already, and it is the markup the
shape should carry: `scope="row"` is what says "this `<th>` heads its row"
(§10), and a table of row headers with no header row is exactly what the
attribute is for. Fixing the heuristic would make correct-but-unmarked HTML
read correctly; it would not make the marked-up form any better.

## Revisit when

- A real app's table is read short this way, or
- the header search is touched for any other reason — at which point 058 and
  059 should be answered together, since both are cuts of the same heuristic.
