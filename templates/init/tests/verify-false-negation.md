---
tags: [live-integration, must-fail]
timeout: 300s
---

# Verify must fail — negation asserted against the true value

**Step 2 is expected to FAIL.** The live suite asserts the gutter paints red.

The Cash & Savings card reads `$24,582.90`, and step 2 asserts it is NOT that
value. This is the counterpart to step 4 of
[verify-assertions.md](verify-assertions.md), which asserts the same card is
NOT `$60.00` and passes. Together they pin the direction of the negation:
one file proves a true negative goes green, this one proves a false negative
goes red. Either on its own is satisfied by an assertion that ignores the
"NOT" entirely — a mistake worth catching, since dropping the negation is the
most likely way a verification silently inverts.

## Config
- baseUrl: http://localhost:8787/assertions

## Steps

1. Navigate to the baseUrl
2. Verify the Cash & Savings total is NOT $24,582.90
