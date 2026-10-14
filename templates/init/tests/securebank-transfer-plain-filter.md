---
tags: [live-integration, must-fail]
timeout: 300s
---

# Schedule a transfer must fail — a plain type into a keyup filter

**Step 3 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints it red. A green run here is the bug.

Step 2 types into SecureBank's payee filter
(`fixtures/test-app/schedule-transfer.html`) without asking for key by key.
A plain type fills: the field gets the text and no key, and this filter
reacts only to keys, so all five payees stay listed and step 3 fails. A pass
would mean the model marked the type key by key on its own because the page
looks live, which the action prompt's rule 10 forbids, or that typing pressed
a key nobody asked for, as the End after every fill did
([steptix/steptix#90](https://github.com/steptix/steptix/issues/90)).
[securebank-schedule-transfer.md](securebank-schedule-transfer.md) asks for
the same text one character at a time and passes.

## Config
- baseUrl: http://localhost:8787/schedule-transfer

## Steps
1. Navigate to the baseUrl
2. Type "dent" into the Find a payee box
3. Verify the payee list shows Northside Dental and no other payee
