---
tags: [table-read]
timeout: 600s
---

# Table read — approve every scheduled payment, by row number

The "after" of [table-baseline-approve.md](table-baseline-approve.md). The
baseline came back green with pass 3 having approved nothing: the model
found no Approve button in "the row for Origin Energy", emitted a no-op,
and the verify then passed on the *other* Origin Energy row. Here the pass
holds the row's status, so the decision is a string comparison on a captured
value rather than a page judgement, and the click and the verify both name
`row {{payment._row}}`, so they cannot be satisfied by different rows.

**Requires phase 1 of the spec** (`readTable` by position, `_row`,
`{{item.property}}`).

Overdue is deliberately left alone: Pay now removes its row, and every row
below it would then have a different number from the one captured in
step 2 — the §4.5 caveat. A table that changes as you act on it is the
`Repeat … until` case, which [table-baseline-pay-overdue.md](table-baseline-pay-overdue.md)
already covers.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Read the 1st column as payee and the 5th column as status from every row in the Scheduled payments table [store as: payments]
3. For each {{payment}} in {{payments}}, Approve the payment
4. Verify rows 1, 2 and 5 of the Scheduled payments table show "Approved"
5. Verify row 3 of the Scheduled payments table still shows "Paused"
6. Verify row 4 of the Scheduled payments table still shows "Overdue"
7. Verify the Scheduled payments table still shows 5 payments

### Approve the payment
1. If {{payment.status}} is not "Scheduled", then return
2. Click Approve in row {{payment._row}} of the Scheduled payments table
3. Verify row {{payment._row}} of the Scheduled payments table now shows "Approved"
