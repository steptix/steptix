---
tags: [live-integration]
timeout: 600s
---

# Verify steps — the passing catalogue

Drives one step per common verification shape against the fixture app's
portfolio page (`fixtures/test-app/assertions.html`). Every step here is
expected to PASS.

This file alone cannot prove verification works — a verify that can never
fail looks identical to one that is a no-op. The two companion fixtures,
[verify-near-miss.md](verify-near-miss.md) and
[verify-false-negation.md](verify-false-negation.md), are the ones that prove
a wrong expectation actually goes red. Read all three as one suite.

Page values are static, so every expectation below is a literal from the
markup rather than something read back off an earlier step.

## Config
- baseUrl: http://localhost:8787/assertions

## Steps

<!-- ── Text and number equality ───────────────────────────────────────────── -->

1. Navigate to the baseUrl
2. Verify the page heading says "SecureBank Portfolio"
3. Verify the total portfolio value is $148,320.50

<!-- ── Negation — the shape most easily got backwards ─────────────────────── -->

4. Verify the Cash & Savings total is NOT $60.00

<!-- ── Threshold and sign ─────────────────────────────────────────────────── -->

5. Verify the total portfolio value is greater than $100,000
6. Verify today's gain/loss is a positive value

<!-- ── Substring / row lookup ─────────────────────────────────────────────── -->

7. Verify the transaction history contains a Woolworths Supermarket transaction

<!-- ── Counting ───────────────────────────────────────────────────────────── -->

8. Verify there are exactly 10 holdings in the investment holdings list

<!-- ── Cross-element: displayed total vs sum of its parts ─────────────────── -->

9. Verify the displayed holdings total of $52,150.00 matches the sum of all individual holding values

<!-- ── Ordering. Phrased as "none newer than the row above" rather than
     "sorted newest first" on purpose: every date in the table appears twice,
     so a strict descending comparison fails on the ties. The observed run
     wrote `timestamps[index - 1] >= timestamp` and passed, but nothing forces
     the non-strict operator — the wording is what keeps it off a coin
     flip. ──────────────────────────────────────────────────────────────────── -->

10. Verify no transaction row in the history has a date newer than the row above it, ignoring the April 2026 Net summary row

<!-- ── Form state — field value, disabled, enabled ────────────────────────── -->

11. Verify the transfer Amount field contains 50.20
12. Verify the Transfer button is disabled
13. Verify the Cancel button is enabled

<!-- ── Absence — there is no #transfer-error node on the page at all ──────── -->

14. Verify no error message is shown in the Transfer Funds panel

<!-- ── Status badge on a specific row ─────────────────────────────────────── -->

15. Verify the scheduled payment to "External Transfer — J. Smith" has the status "Pending review"

<!-- ── Empty state — the table renders, it just has no rows ───────────────── -->

16. Verify the Closed Accounts table shows no account rows

<!-- ── Async value. Split into click + verify on purpose: the settlement
     figure takes 2s after Refresh, and by the time the next step's AI turn
     runs it has landed. Written as one step it would instead require the
     model to choose a polling assertion — a real capability, but not one
     this suite should hinge on. ───────────────────────────────────────────── -->

17. Click the Refresh button next to Pending settlement
18. Verify the pending settlement amount is $1,204.75
