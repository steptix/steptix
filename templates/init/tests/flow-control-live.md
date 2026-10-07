---
tags: [live-integration]
---

# Flow control live test

Fixture for the live flow-control test (stories/step-flow-control.md). The
`Sign in` section is called twice against `fixtures/test-app`: the first call
runs its body and signs in, the second returns at its first line because the
page is already the dashboard, and main-flow step 4 then ends the run as a
pass with step 5 unrun. Local and deterministic — no external account, no
network.

## Config
- baseUrl: http://localhost:8787/

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to the baseUrl
2. Sign in
3. Sign in
4. If the page title contains "Dashboard" then stop running the remaining steps
5. Click "Sign out"

### Sign in
1. If the page title contains "Dashboard" then return
2. If the cookie banner is shown, then Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
