---
tags: [control-flow]
timeout: 900s
---

# Control flow — decide once, then loop

Drives the fixture app's Payments page (`fixtures/test-app/control-flow.html`,
port 8787) through every control form in
[stories/control-flow.md](../../../stories/control-flow.md): a chain that
decides, a `While` that stops when the page says stop, a `Repeat … until` with
a cap, and a `For each` over names read off the page.

Nothing here is timing-dependent. The page keeps all its state in the browser
and resets on load, so each form runs a known number of times:

- **Cash is ticked when the page opens**, which is what sends step 2 down its
  `If` branch. Step 3's `Otherwise` and the whole of `Pay by card` are skipped
  — that untaken section is half of what this file is for. The companion
  [control-flow-otherwise.md](control-flow-otherwise.md) unticks Cash first, so
  the same chain falls through to `Otherwise` instead.
- **Next disables on page 4** of the Statements panel, so the `While` runs
  exactly three passes and then stops on its own condition rather than on a cap.
- **Load more removes itself on its third click**, so the `Repeat` runs exactly
  three passes. The `, up to 10 times` cap is there to fail loudly if the page
  ever stops removing it; it is not the exit.
- **Three accounts are listed**, so the `For each` runs three passes with
  `{{account}}` bound to a name read off the page rather than typed by an
  author.

Steps 9 and 10 are the evidence the `Repeat` really looped: eight alerts is two
on load plus two per click, three times.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to control-flow.html
2. If the Cash checkbox is ticked, then Pay with cash
3. Otherwise, Pay by card
4. Verify the Payment method panel says "Paid in cash"
5. While the Next button is enabled, Go to the next page
6. Verify the Statements panel says "Page 4 of 4"
7. Repeat Click Load more until the Load more button is gone, up to 10 times
8. Verify the Alerts panel says "All alerts loaded"
9. Count the alerts in the Alerts panel [store as: alert_count]
10. Assert that {{alert_count}} equals 8
11. Read the name of every account in the Your accounts panel [store as: accounts]
12. For each {{account}} in {{accounts}}, Check the account
13. Verify there are exactly 3 accounts in the Your accounts panel

### Pay with cash
1. Click Pay now
2. Verify the Payment method panel says "Paid in cash"

### Pay by card
1. Tick the Card checkbox
2. Type "4111 1111 1111 1111" into the Card number field
3. Click Pay now
4. Verify the Payment method panel says "Paid by card"

### Go to the next page
1. Click the Next button

### Check the account
1. Verify the Your accounts panel has a row for "{{account}}" showing a balance in dollars
