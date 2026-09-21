---
tags: [table-read]
timeout: 600s
---

# Table read — open every payment's details, by row number

The third end-to-end proof of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md)
§12, and the "after" of [table-baseline-view.md](table-baseline-view.md).
`fixtures/test-app/scheduled-payments.html` has **no header row**, so the
columns are named by position (§4.4), and it has Origin Energy twice — row 1
at $140.00 and row 3 at $86.10 — so the body finds its row by
`{{payment._row}}` (§4.5), not by name.

**Requires phase 1 of the spec.** What the proving run must show (§12): the
recorded action has `index` columns and no `header`; five records with
`_row` 1 to 5; the Overdue pass (row 4, Sydney Water) ends at its first
step with the rest skipped as not-taken; and the two Origin Energy passes
(rows 1 and 3) open *different* details pages, each showing that pass's
`{{payment.amount}}` — $140.00 and $86.10. Opening the first Origin Energy
row twice is the failure this file exists to catch. The `return` is on
Overdue rather than Paused precisely so that row 3, the second Origin
Energy, is visited.

The baseline got this right by inference — the step prompt's prior-steps
history let the model reason "already reviewed", and the rows differ in
status. This version does not need either.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Read the 1st column as payee, the 3rd column as amount and the 5th column as status from every row in the Scheduled payments table [store as: payments]
3. For each {{payment}} in {{payments}}, Review the payment
4. Verify the Scheduled payments table still shows 5 payments

### Review the payment
1. If {{payment.status}} is "Overdue", then return
2. Click View in row {{payment._row}} of the Scheduled payments table
3. Verify the Payment details page shows "{{payment.payee}}" and the amount {{payment.amount}}
4. Click Back to scheduled payments
5. Verify the Scheduled payments table is shown
