---
tags: [live-integration]
---

# Flow control live test, slow login

`flow-control-live.md` with a login API that takes 1.5 s
(docs/specs/SPEC-codebehind-robustness.md §8): slower than the 1 s of quiet a
compiled `If … then return` waits for, so only the wait after the compiled
sign-in click — which waits for the request and the navigation it starts —
lets the second call find the dashboard. Same layout as `flow-control-live.md`,
so the live test reads both with the same line numbers.

## Config
- baseUrl: http://localhost:8787/index.html?loginDelay=1500

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
