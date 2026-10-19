---
tags: [live-integration]
timeout: 300s
---

# Card orders — status, notice, instructions, courier and chart

A check reads the part of the page its step names, and only what a person
sees there (docs/specs/SPEC-verify-checks.md, section 7). The card orders
page (`fixtures/test-app/card-orders.html`) holds each kind of text a check
reads. Every step here must pass:

- step 2 reads order 5127's row, where the status is "Shipped";
- step 3 reads the delivery notice, a sentence that holds the order number in
  an element of its own;
- step 5 reads what step 4 typed into the delivery instructions box, which is
  in the box's value and not in the page's markup;
- step 6 reads the courier dropdown's chosen option, not its other options;
- step 7 reads the title drawn in the chart, which is SVG text;
- step 8 reads the whole page, which shows the dropdown's chosen option.

(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

Four companions must fail, each because the text its step expects is not
shown where the step says to look:
[verify-scope-order-status.md](verify-scope-order-status.md) expects order
5126's status to say what other rows say,
[verify-scope-print-label.md](verify-scope-print-label.md) expects words only
the page's script code holds,
[verify-scope-draft-message.md](verify-scope-draft-message.md) expects words
only hidden text holds, and [verify-scope-courier.md](verify-scope-courier.md)
expects the page to say a dropdown option nobody chose.

## Config
- baseUrl: http://localhost:8787/card-orders.html

## Steps
1. Navigate to the baseUrl
2. Verify the status of order 5127 says "Shipped"
3. Verify the delivery notice says "Card order 5127 left the depot on 14 May."
4. Type "Leave at the side gate" into the delivery instructions box
5. Verify the delivery instructions box says "Leave at the side gate"
6. Verify the courier dropdown shows "Priority courier"
7. Verify the title drawn in the chart says "Cards sent this week"
8. Verify the page says "Priority courier"
