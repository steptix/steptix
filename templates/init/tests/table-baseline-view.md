---
tags: [table-baseline]
timeout: 600s
---

# Table baseline — open every payment's details, by name

Baseline for the structured-table-read story
(docs/specs/SPEC-structured-table-reads.md), recorded BEFORE `readTable`
exists. Drives `fixtures/test-app/scheduled-payments.html`: a table with no
header row, five payments, and **Origin Energy twice** (row 1, $140.00 and
row 3, $86.10).

Today a `For each` pass knows its row by one string — the payee name read in
step 2 — so the body has to say "the row for {{payee}}" on every step. This
file exists to show what that does on the third pass, where "the row for
Origin Energy" is ambiguous: the amount captured in step 3 of the body is the
evidence. Row 3's details page says $86.10; if pass 3 records $140.00 it
opened row 1 again.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Read the payee name of every row in the Scheduled payments table [store as: payees]
3. For each {{payee}} in {{payees}}, Review the payment
4. Verify the Scheduled payments table shows 5 payments

### Review the payment
1. In the Scheduled payments row for "{{payee}}", click View
2. Verify the Payment details page shows "{{payee}}"
3. Read the amount shown on the Payment details page [store as: amount]
4. Click Back to scheduled payments
5. Verify the Scheduled payments table is shown
