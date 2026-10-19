---
tags: [live-integration, must-fail]
timeout: 300s
---

# Card orders — draft message

**Step 2 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints it red. A green run here is the bug.
(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

The card orders page (`fixtures/test-app/card-orders.html`) has the words
"Draft saved" only in the draft status under the delivery instructions, an
element styled `display: none`. A person reading the page never sees them,
so step 2 must fail. Read by itself, that element still hands back its text
from `innerText`; a check that read it so, or read the page's markup, hidden
text included, would find the words and pass
(docs/specs/SPEC-verify-checks.md, section 7).

## Config
- baseUrl: http://localhost:8787/card-orders.html

## Steps
1. Navigate to the baseUrl
2. Verify the draft status under the delivery instructions says "Draft saved"
