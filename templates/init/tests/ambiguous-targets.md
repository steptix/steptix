---
tags: [live-integration]
---

# Ambiguous selector targets

Fixture for the live selector-ambiguity test
(stories/codebehind-selector-ambiguity.md). Drives
`fixtures/test-app/ambiguous-targets.html`, whose markup is built so that the
AI's natural selector choice is ambiguous in a way only the browser can see.

Step 2 is the control: a unique `data-testid`, one match, nothing to
disambiguate. It is here so a measurement that reports anything other than one
match has somewhere obvious to fail.

Step 3 is the reported failure, reproduced. "Open statements" is an
`a[href="transactions.html"]`, and the page carries a second copy inside a
`display:none` nav drawer. The AI runtime clicks it happily — its pipe is
`root.locator(sel).locator('visible=true').first()` — while a compiled entry
that copied the selector straight out of the transcript resolves to 2 elements
and throws under Playwright's strict mode. The hidden copy is invisible in the
DOM snapshot too, because a hidden element's attributes are stripped, so nothing
the model was shown could have warned it.

The point of the test is that step 3 compiles to an entry that passes on its
first replay.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to /ambiguous-targets.html
2. Click the "Save preferences" button and confirm the "Preferences saved" message appears
3. Click the "Open statements" link and wait for the "Transaction History" heading
