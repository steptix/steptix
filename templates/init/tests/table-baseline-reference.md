---
tags: [table-baseline]
timeout: 600s
---

# Table baseline — check the Reference cell of every row, by name

Baseline for the structured-table-read story, recorded BEFORE `readTable`
exists. Rows 2 and 3 of `scheduled-payments.html` have an empty Reference
cell; rows 1, 4 and 5 have an `INV-` reference. Today a pass cannot hold a
cell value, so the `If` asks the judge model to find the row by name and read
the cell off the page snapshot on every pass.

The interesting pass is the third: "the row for Origin Energy" is row 1
(INV-2291) and row 3 (empty). If the judge picks row 1, the `Otherwise`
branch runs and passes — for a row whose Reference is empty. A green run here
is not a correct one; read the guard rows' reasoning in the report.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Read the payee name of every row in the Scheduled payments table [store as: payees]
3. For each {{payee}} in {{payees}}, Check the reference

### Check the reference
1. If the Reference cell in the Scheduled payments row for "{{payee}}" is empty, then Note the missing reference
2. Otherwise, Verify the Scheduled payments row for "{{payee}}" shows a reference beginning with "INV-"

### Note the missing reference
1. Verify the Scheduled payments row for "{{payee}}" has an empty Reference cell
