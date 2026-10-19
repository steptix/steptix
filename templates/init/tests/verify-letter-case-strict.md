---
tags: [live-integration, must-fail]
timeout: 300s
---

# Order confirmation — status

**Step 2 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints it red. A green run here is the bug.
(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

The order confirmation page (`fixtures/test-app/letter-case.html`) shows the
status "Payment received", with a small r. Step 2 expects "Payment Received"
and says nothing about letter case, so the check compares case and fails.
[verify-letter-case.md](verify-letter-case.md) says "ignoring letter case" for
the same kind of check, and passes.

A failed check is retried, and the retry must ask the same question
(steptix/steptix#97): before that, a retry could pass a check like this one by
changing the text it looked for to the page's "Payment received", or by
comparing both sides in small letters (steptix/steptix#66).

## Config
- baseUrl: http://localhost:8787/letter-case.html

## Steps
1. Navigate to the baseUrl
2. Verify the order status says "Payment Received"
