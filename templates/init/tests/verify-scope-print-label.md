---
tags: [live-integration, must-fail]
timeout: 300s
---

# Card orders — print label message

**Step 2 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints it red. A green run here is the bug.
(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

The card orders page (`fixtures/test-app/card-orders.html`) does not show the
words "Label printed". They are in a script inside the page's delivery form,
which would show them after a click on Print label, and this test makes no
click. A person reading the page never sees them, so step 2 must fail. The
form has no empty element waiting for the words, so a check reads the page or
the form, and both hold the script. A check that searched their markup,
script code included, would find the words and pass: a check on another site
passed that way in a real run (docs/specs/SPEC-verify-checks.md, section 11,
case D).

## Config
- baseUrl: http://localhost:8787/card-orders.html

## Steps
1. Navigate to the baseUrl
2. Verify the page says "Label printed"
