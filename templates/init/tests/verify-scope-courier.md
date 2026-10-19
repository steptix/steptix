---
tags: [live-integration, must-fail]
timeout: 300s
---

# Card orders — courier

**Step 2 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints it red. A green run here is the bug.
(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

The card orders page (`fixtures/test-app/card-orders.html`) has a courier
dropdown with "Priority courier" chosen. "Collect in branch" is one of its
other options: a person sees only the chosen one in a closed dropdown, so the
page does not say "Collect in branch", and step 2 must fail. The text of
every option is in the dropdown's `innerText`, and in that of everything
around it, the whole page included, so a check that read the page that way
would find it and pass (docs/specs/SPEC-verify-checks.md, section 7).
[verify-scope.md](verify-scope.md) checks that the page says "Priority
courier", and passes.

## Config
- baseUrl: http://localhost:8787/card-orders.html

## Steps
1. Navigate to the baseUrl
2. Verify the page says "Collect in branch"
