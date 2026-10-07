---
tags: [variables]
timeout: 300s
---

# Copy and export variables

What `steptix-vscode/tests/integration/live/copy-variables.test.cjs` copies
and exports, from a real run of the kinds of variable an author pauses to
look at: a password parameter the views mask, a whole table read into one
variable (a JSON array of records), a single value captured from the page,
and one built by a `Set` step. The live test puts a breakpoint on the last
step, so the run parks with all four in scope.

`fixtures/test-app/scheduled-payments.html` has five rows and no header row,
so the columns are read by position. The first row's payee is Origin Energy.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to scheduled-payments.html?reset=1
2. Read the 1st column as payee, the 3rd column as amount and the 5th column as status from every row in the Scheduled payments table [store as: payments]
3. Capture the payee in the first row of the Scheduled payments table [store as: first_payee]
4. Set {{greeting}} to "Hello {{username}}"
5. Verify the Scheduled payments table is shown
