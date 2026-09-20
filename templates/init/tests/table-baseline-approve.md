---
tags: [table-baseline]
timeout: 600s
---

# Table baseline — approve every payment, by name

Baseline for the structured-table-read story, recorded BEFORE `readTable`
exists. Loops over `scheduled-payments.html` by payee name and tries to
approve each row. Two rows cannot be approved: row 3 (Origin Energy, Paused —
it has Resume, not Approve) and row 4 (Sydney Water, Overdue — Pay now).
Row 1 is also Origin Energy, so pass 3 and pass 1 share a name.

`otherwise continue` is on both body steps so the run reaches every pass and
the report shows what each one did, rather than stopping at the first row
without an Approve button. Without it the run ends on pass 3.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Read the payee name of every row in the Scheduled payments table [store as: payees]
3. For each {{payee}} in {{payees}}, Approve the payment
4. Verify the Scheduled payments table shows 5 payments

### Approve the payment
1. In the Scheduled payments row for "{{payee}}", click Approve otherwise continue with warning "No Approve button in the row for {{payee}}"
2. Verify the row for "{{payee}}" now shows "Approved" otherwise continue with warning "The row for {{payee}} was not approved"
