---
tags: [assertion-cache, e2e]
timeout: 120s
---

# Assertion Code Cache Test

Exercises the assertion code cache strategy. On first run the AI generates
JavaScript code for each assertion and caches it. On second run all assertions
execute from cache with zero AI calls.

The page contains a 50-row transaction table (collapsed by DOM snapshot
compaction), a 10-item holdings list, and summary cards — covering single-element,
multi-row table, list-based, and cross-element assertion scenarios.

## Config
- baseUrl: http://localhost:8787/assertions

## Steps

<!-- ── Simple single-element assertions ───────────────────────────────────── -->
<!-- AI writes: document.querySelector('#portfolio-total')?.textContent?.trim() -->

1. Navigate to the portfolio dashboard and verify the total portfolio value is $148,320.50

<!-- AI writes: querySelector('#cash-total') comparison -->

2. Verify the Cash & Savings total shown is $24,582.90

<!-- AI writes: querySelector('#daily-change') and checks for '+' prefix -->

3. Verify today's gain/loss is a positive value (starts with +)

<!-- ── Table assertions — row count and totals ────────────────────────────── -->
<!-- AI must write querySelectorAll to count rows, table was collapsed in DOM  -->

4. Verify the transaction table contains at least 40 transaction rows (excluding the totals row)

<!-- AI must locate the net total row by its id -->

5. Verify the April 2026 net transaction figure shown is +$5,209.60

<!-- ── List assertions ────────────────────────────────────────────────────── -->
<!-- AI writes querySelectorAll on the holdings list -->

6. Verify there are exactly 10 holdings in the investment holdings list

<!-- AI must find BHP by data-ticker attribute -->

7. Verify BHP Group Ltd is listed in the holdings with a positive value

<!-- ── Cross-element assertion — holdings sum vs displayed total ──────────── -->
<!-- AI must query all .holding-value .val elements, sum them, compare to #holdings-total -->

8. Verify the displayed holdings total of $52,150.00 matches the sum of all individual holding values

<!-- ── Alert list assertions ───────────────────────────────────────────────── -->

9. Verify there are 5 active alerts shown on the page

10. Verify at least one alert has high severity (indicated by a red circle emoji)
