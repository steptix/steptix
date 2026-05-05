---
type: skill
---

# open_edge_and_check_isolation

Opens a fresh Microsoft Edge browser session in parallel with the current
browser, navigates it to the test-app's login page, and verifies the user
sees the unauthenticated login form there — proving the new browser does
NOT share cookies/auth state with the calling test's default browser.

This skill is the canonical demonstration of the multi-browser feature:
two distinct `Browser` processes (Chrome via `default`, Edge via `edge`),
isolated session storage, the second proving its independence by NOT
inheriting the first's authenticated session.

The skill leaves the Edge browser open and active when it returns — the
caller can switch back to `default` with a `switchBrowser` action.

## Parameters
- baseUrl: the test-app base URL (e.g. http://localhost:8787)

## Steps
1. Open a new browser as "edge" using the Microsoft Edge channel: [openBrowser as="edge" channel="msedge"]
2. Navigate to {{baseUrl}}/ on the Edge browser
3. Verify the SecureBank "Sign In" form is visible — the email and password fields and the "Sign In" submit button — confirming this Edge session is NOT signed in (cookies isolated from the default browser)
