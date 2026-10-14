---
tags: [live-integration]
---

# Interaction highlight live test

The fixture for `steptix-vscode/tests/integration/live/highlight.test.cjs`
(docs/specs/SPEC-interaction-highlight.md §10.2). It lives in its own project,
`templates/highlight/`, whose `steptix.config.json` turns on the three things
the test is about:

- `browser.highlight: true`, so every action that touches an element asks for
  a ring, and the report marks each sub-action with the colour it asked for;
- `browser.captureScreenshotsPerAction: true`, so each sub-action has its own
  screenshot, taken while the ring is up;
- `ai.sendScreenshots: true`, so the model is sent a screenshot every turn and
  the path that hides the rings from it runs.

It signs in to the fixture app (`fixtures/test-app`, port 8787), then reads a
value and counts some elements, so both kinds of ring appear: `act` for the
typing and the click, `read` for the read and the count.

The cookie banner is remembered in `localStorage`: a fresh browser shows it
and a browser that has already answered it does not, so step 2 rejects it
only if it is shown.

## Config
- baseUrl: http://localhost:8787/

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to the baseUrl
2. If the cookie banner is shown, then Reject non-essential cookies in the cookie banner
3. Enter the email {{username}}
4. Enter the password {{password}}
5. Click the Sign In button
6. Read the Available Balance [store as: balance]
7. Count the items in the Recent Transactions list [store as: transaction_count]
