---
tags: [conditional, mfa, e2e]
timeout: 120s
---

# MFA Conditional Login Test

Exercises the conditional step lookahead problem. After login, the app shows
an MFA page with a "Sending verification code..." spinner for several seconds
before the code input form appears.

The bug: step 3 ("If prompted for MFA...") is evaluated while the MFA spinner
is visible. The AI sees no input form, decides MFA isn't happening, and falls
through to step 4 ("Wait for dashboard") — which never loads because MFA is
still required. With the lookahead fix, the system would recognise that step 3
is conditional and step 4 is the alternative, wait for the page to settle,
then act on whichever outcome materialises.

## Config
- baseUrl: http://localhost:8787/mfa.html?delay=20000&code=654321

## Parameters
- mfaCode: 654321

## Steps
1. If prompted for MFA verification, enter the code "{{mfaCode}}" and click Verify
2. Wait for the dashboard to load
3. Verify the dashboard shows "Welcome back" on the page
