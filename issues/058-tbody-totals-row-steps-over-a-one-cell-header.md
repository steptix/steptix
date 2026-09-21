# 058 — a totals row inside `<tbody>` steps over a genuine one-cell `<th>` header

**Status:** open / known limitation — the header-row heuristic of §7.3 reads
the whole `<tbody>`, so a heading-shaped row BELOW the data decides what
happens to a candidate ABOVE it.
**Area:**
[src/browser/scripts/read-table.js](../src/browser/scripts/read-table.js) —
the `lastWideHeadingAt` scan (~line 228), which counts a row carrying more
than one `<th>` as a heading row wherever in the body it sits; the step-over
that reads it is the `row.cells.length === 1 && lastWideHeadingAt > i` test
(~line 325) inside the body-row header search (~line 281).
**Related:**
[docs/specs/SPEC-structured-table-reads.md](../docs/specs/SPEC-structured-table-reads.md)
§7.3 (the step-over and its limits), §7.4 ("extra cells are harmless") and
§14, which carries this as deferred.
[059](059-all-row-header-table-loses-its-first-row.md) is the other shape the
same review left.
**Opened:** 2026-09-21

## Summary

A one-cell `<th>` row is stepped over as a GROUP heading when a wider heading
row — more than one `<th>` — follows it, because a header is never narrower
than the grid it names. "Follows it" is asked of every later body row, and a
totals row is heading-shaped: `<tr><th>Total</th><th>12</th></tr>` has two
`<th>` cells. Put that row in `<tbody>` and it answers the question from
below the data, so the table's real header is stepped over and the read finds
none.

`<tfoot>` is unaffected: only body rows are scanned, so the same markup one
element out reads correctly. That is the whole difference, and neither
spelling is wrong HTML.

## What it looks like

```html
<table id="t">
  <tbody>
    <tr><th>Order ID</th></tr>
    <tr><td>O-1</td><td>5</td></tr>
    <tr><td>O-2</td><td>7</td></tr>
    <tr><th>Total</th><th>12</th></tr>
  </tbody>
</table>
```

Measured against the extractor in a real page:

- by header — `readTable cannot map table "t": it has no header row, so
  "Order ID" cannot be matched — name columns by position ("the 1st column as
  id")`;
- by position — four records, `Order ID` as record 1 and every real row
  numbered one too high:
  `[{_row:"1",c1:"Order ID"},{_row:"2",c1:"O-1"},{_row:"3",c1:"O-2"},{_row:"4",c1:"Total"}]`.

The same table with the totals row moved into `<tfoot>` reads
`[{_row:"1",id:"O-1"},{_row:"2",id:"O-2"}]` by header and the same by
position — the correct answer.

This is §4.5's misalignment arriving through the door the step-over was added
to guard, which is exactly the shape review 5 fixed for a row-header row
(`<th>` then `<td>`s, now refused as a heading row because it carries only
one `<th>`). A totals row carries two, so the "more than one `<th>`" rule
cannot tell it from a header.

## What a fix looks like

Count a wide heading row only while the scan is still ABOVE the data: stop
`lastWideHeadingAt` at the first body row that contains no `<th>` at all. A
group heading sits above the heading row it groups, so nothing legitimate is
lost; a totals row sits below the data by definition, so it stops counting.

The reviewer wrote that change during the review of this feature and measured
it: `tests/read-table.test.ts` stayed green at 83 tests, and the shapes above
plus the §7.3 probes read correctly with it.

## Why it is not fixed here

Left by decision during the structured-table-reads review; the fix risks the
next shape. Every cut of this heuristic so far has traded one wrong table for
another — the first stepped over a genuine one-cell header (round 4), the
second took a row-header row for a heading row (round 5) — and each was found
by a reader who had a specific table in mind. "The first body row with no
`<th>`" is a third line drawn on the same axis, and a table with a hidden
template row of `<td>`s above its headings, or a `<tbody>` split into
per-group blocks each with its own heading row, would meet it in a way nobody
has looked at yet. It wants doing with a corpus of real tables rather than as
a rider on a masking review.

The author's workaround is the markup the shape should carry anyway: a totals
row belongs in `<tfoot>`.

## Revisit when

- A real app's table is read wrongly this way, or
- `readTable` gains a corpus of real-world tables to measure a heuristic
  against, or
- the header search is touched for any other reason — at which point 058 and
  059 should be answered together.
