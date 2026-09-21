---
tags: [browser-history]
timeout: 300s
---

# Browser history — the back and forward buttons

The acceptance run of
[SPEC-browser-history.md](../../../docs/specs/SPEC-browser-history.md) §10,
against the sidebar nav on `fixtures/test-app/tables.html`.

What it proves is the thing the spec exists for: before these actions, a step
asking for the browser's back button got a keypress, which is delivered to the
focused element inside the page rather than to the browser. The press
succeeded, the step passed, and the page never moved — so step 5 below is what
would have failed, and the run is only green if step 4 really moved the tab.

Steps 4, 6, 9 and 11 must record a `back` or a `forward` action. A `click` on
either would be wrong: there is no back button in the page to click.

**Steps 8 to 14 are the case review found broken**, and they are why this file
does not stop at step 7. The Settings link is `href="#settings"`, so it adds a
SAME-DOCUMENT history entry — and a same-document move returns no HTTP
response, which the first cut of the action read as "there is no history" and
failed on. A run that only ever moves between whole pages (steps 1 to 7) stays
green while a single-page app is broken, which is exactly what happened.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to tables.html
2. Click the "Dashboard" link in the left sidebar
3. Verify the Dashboard page is shown
4. Go back
5. Verify the Tables index page is shown
6. Go forward
7. Verify the Dashboard page is shown
8. Click the "Settings" link in the left sidebar
9. Go back
10. Capture the current page URL [store as: after_back]
11. Go forward
12. Capture the current page URL [store as: after_forward]
13. Verify that "{{after_back}}" does not end with "#settings"
14. Verify that "{{after_forward}}" ends with "#settings"
