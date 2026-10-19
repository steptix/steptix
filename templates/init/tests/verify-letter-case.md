---
tags: [live-integration]
timeout: 300s
---

# Order confirmation — status, reference and delivery method

A check compares text in the letter case the step writes it, unless the step
says to ignore case. The order confirmation page
(`fixtures/test-app/letter-case.html`) shows the status "Payment received",
with a small r, the reference "AB-1042", and the delivery method in capitals —
written "Express courier" in the page's markup, and shown in capitals by CSS.
Every step here must pass:

- step 2 writes the status exactly as the page shows it;
- step 3 writes it in capitals and says to ignore letter case;
- step 4 writes the reference in small letters and says any case will do;
- step 5 writes the delivery method in capitals, as the page shows it, and
  says nothing about case: what a reader sees counts as written;
- step 6 writes it as the page's markup has it, which counts too.

(The title above reaches the model only on a run that does not go through
the server, such as one from the command line, which sends it as the test's
name with every request. The live suite runs through the server, which
sends `session:` and the file's path as the name instead. So the title
names what is checked and gives no verdict away.)

Two companions must fail, and say nothing about case either:
[verify-letter-case-strict.md](verify-letter-case-strict.md) writes the status
with a capital R, and
[verify-letter-case-transform-strict.md](verify-letter-case-transform-strict.md)
writes the delivery method in a third case, neither shown nor in the markup.
Together they show that the step's own words decide.

## Config
- baseUrl: http://localhost:8787/letter-case.html

## Steps
1. Navigate to the baseUrl
2. Verify the order status says "Payment received"
3. Verify the order status says "PAYMENT RECEIVED", ignoring letter case
4. Verify the order reference is "ab-1042" in any letter case
5. Verify the delivery method says "EXPRESS COURIER"
6. Verify the delivery method says "Express courier"
