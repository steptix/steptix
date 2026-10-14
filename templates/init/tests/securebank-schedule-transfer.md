---
tags: [live-integration]
timeout: 600s
---

# Schedule a transfer — every typed value reaches the page

Drives SecureBank's Schedule a transfer page
(`fixtures/test-app/schedule-transfer.html`) and reads every value back
through its confirmation. A `type` must put in the characters its step names
and press no key the step does not ask for
([steptix/steptix#90](https://github.com/steptix/steptix/issues/90)):

- The transfer date is three spinbutton segments, where End sets the
  maximum. A type that pressed End after the digits scheduled 14/03/2027 as
  31/12/9999, and only the last step can see it.
- The payee filter reacts to keys only, so step 2 asks for its text one
  character at a time, and the model marks that `type` key by key. Its
  companion, [securebank-transfer-plain-filter.md](securebank-transfer-plain-filter.md),
  types the same text without asking, and its check must fail.

## Config
- baseUrl: http://localhost:8787/schedule-transfer

## Steps
1. Navigate to the baseUrl
2. Type "dent" into the Find a payee box one character at a time
3. Verify the payee list shows Northside Dental and no other payee
4. Choose Northside Dental
5. Type 25.00 into the Amount field
6. Type 14 into the Day of the Transfer date
7. Type 03 into the Month of the Transfer date
8. Type 2027 into the Year of the Transfer date
9. Click Schedule transfer
10. Verify the page says "$25.00 to Northside Dental on 14/03/2027"
