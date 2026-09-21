---
tags: [table-baseline]
timeout: 600s
---

# Table baseline — pay every overdue payment with Repeat … until

Baseline for the structured-table-read story, recorded BEFORE `readTable`
exists. This is the one loop shape that already fits a table which changes
as you act on it: Pay now REMOVES the row, so a list read up front would be
stale by the second pass, and `Repeat … until` reads the page as it is now
instead. `scheduled-payments.html` has one Overdue row (Sydney Water,
$210.45), so the loop runs one pass and stops on its own condition; the
cap is there to fail loudly if the row ever stops disappearing.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Repeat Pay the first overdue payment until no row in the Scheduled payments table shows "Overdue", up to 10 times
3. Verify the Scheduled payments table shows 4 payments
4. Verify the total under the Scheduled payments table is "$336.49"

### Pay the first overdue payment
1. Click Pay now in the first Scheduled payments row whose status is Overdue
2. Verify that payment is no longer in the Scheduled payments table
