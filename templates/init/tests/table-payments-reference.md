---
tags: [table-read]
timeout: 600s
---

# Table read — check the Reference cell of every row, from the record

The "after" of [table-baseline-reference.md](table-baseline-reference.md),
which failed on its first pass both times it ran: the judge read "the row
for Origin Energy" as row 3 (empty Reference) and the assertion in the
branch it chose read it as row 1 (INV-2291). Here the condition is on the
captured value — no page reading, no row finding — and the branch's check
names `row {{payment._row}}`.

**Requires phase 1 of the spec.** Rows 2 and 3 have an empty Reference; rows
1, 4 and 5 have an `INV-` one. An empty cell is stored as `""`, not dropped
(§7.4), so `{{payment.reference}}` substitutes to nothing on those passes.
That is why the condition quotes it: `If "" is empty` reads as it should,
where `If  is empty` would not.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Read the 1st column as payee and the 2nd column as reference from every row in the Scheduled payments table [store as: payments]
3. For each {{payment}} in {{payments}}, Check the reference

### Check the reference
1. If "{{payment.reference}}" is empty, then Verify the Reference cell in row {{payment._row}} of the Scheduled payments table is empty
2. Otherwise, Verify the Reference cell in row {{payment._row}} of the Scheduled payments table reads "{{payment.reference}}"
