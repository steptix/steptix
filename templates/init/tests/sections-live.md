---
type: test
---

# Sections live regression fixture

Fixture for the live integration test. The FIRST main-flow step is a section
call on purpose: the first step the server executes is then a section body
line, so the test can prove the server expanded the call without depending on
any step succeeding. A stale AI credential or an unreachable site should fail
the test for the right reason, not by starving it of evidence.

Uses `about:blank` and DOM-free assertions so it exercises the sections wire
path without needing a real site to be up.

## Steps

1. Check the page
2. Navigate to about:blank
3. Check the page

### Check the page

1. Confirm the browser is showing a page
2. Confirm the page has finished loading
