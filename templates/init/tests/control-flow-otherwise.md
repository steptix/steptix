---
tags: [control-flow]
timeout: 600s
---

# Control flow — the branch nobody took

The companion to [control-flow.md](control-flow.md), which takes its `If`. Here
step 2 unticks Cash before the chain is reached, so the same three-member chain
ends up on its last member instead:

- `If the Cash checkbox is ticked` — false, because step 2 unticked it.
- `Else if the Pay now button is enabled` — false, because the page disables
  Pay now while neither method is chosen. Its tail is a plain instruction
  rather than a section, which is the shape a one-step branch should use.
- `Otherwise, Pay by card` — taken. That section ticks Card, which is what
  re-enables Pay now, so the payment goes through as a card payment.

Read the report from this file beside the report from `control-flow.md`: the
same two sections appear in both, and the one that paints skipped swaps over.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to control-flow.html
2. Untick the Cash checkbox
3. If the Cash checkbox is ticked, then Pay with cash
4. Else if the Pay now button is enabled, then Click Pay now
5. Otherwise, Pay by card
6. Verify the Payment method panel says "Paid by card"

### Pay with cash
1. Click Pay now
2. Verify the Payment method panel says "Paid in cash"

### Pay by card
1. Tick the Card checkbox
2. Type "4111 1111 1111 1111" into the Card number field
3. Click Pay now
4. Verify the Payment method panel says "Paid by card"
