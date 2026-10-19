---
tags: [live-integration, must-fail]
timeout: 300s
---

# Order confirmation — delivery method

**Step 2 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints it red. A green run here is the bug.
(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

The order confirmation page (`fixtures/test-app/letter-case.html`) writes the
delivery method "Express courier" in its markup and shows it in capitals by
CSS `text-transform`. A check matches such text in the case it is shown
("EXPRESS COURIER") and in its markup's case ("Express courier") —
[verify-letter-case.md](verify-letter-case.md) passes both — but in no third
case. Step 2 expects "Express Courier", which is neither, and says nothing
about letter case, so it must fail. A check that compared the two sides
ignoring case would pass it, and so would a retry that changed the text it
looked for to either case the page has.

## Config
- baseUrl: http://localhost:8787/letter-case.html

## Steps
1. Navigate to the baseUrl
2. Verify the delivery method says "Express Courier"
