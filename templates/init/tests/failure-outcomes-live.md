---
tags: [live-integration]
---

# Failure outcomes live test

Fixture for the live failure-outcomes test (stories/step-failure-outcomes.md).
All three forms run against `fixtures/test-app` in one pass: step 6 passes and
its `otherwise fail` tail does nothing, step 7 fails and its `otherwise
continue` tail tolerates it — amber, and the run carries on — and step 9 fails
the run with the author's own message, so step 10 never starts. The run ends
`failed` with the message from step 9, and the report header reads 7 passed, 1
failed, 1 tolerated. Local and deterministic — no external account, no network.

## Config
- baseUrl: http://localhost:8787/

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
6. Verify the page title contains "Dashboard" otherwise fail the test with message "Sign in did not reach the dashboard"
7. Verify the page title contains "Peanuts" otherwise continue with warning "No peanuts on the dashboard"
8. Set {{a}} to "peanuts"
9. If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"
10. Click "Sign out"
