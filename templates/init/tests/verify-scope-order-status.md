---
tags: [live-integration, must-fail]
timeout: 300s
---

# Card orders — status of order 5126

**Step 2 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints it red. A green run here is the bug.
(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

The card orders page (`fixtures/test-app/card-orders.html`) shows order 5126
as "Pending", and orders 5127 and 5128 as "Shipped". Step 2 asks about order
5126, so its check reads that row and fails. A check that looked for
"Shipped" anywhere else, in the table or on the page, would find it in
another row and pass (docs/specs/SPEC-verify-checks.md, section 7).
[verify-scope.md](verify-scope.md) checks order 5127's status, which does say
"Shipped", and passes.

A failed check is retried, and the retry asks the same question
(steptix/steptix#97): it may read order 5126's row again, but not look for
the word in another one.

## Config
- baseUrl: http://localhost:8787/card-orders.html

## Steps
1. Navigate to the baseUrl
2. Verify the status of order 5126 says "Shipped"
