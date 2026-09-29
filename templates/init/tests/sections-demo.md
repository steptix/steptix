---
tags: [demo, sections]
---

# Sections demo

Demonstrates **inline sections**: a reusable block of steps defined by a
`### Name` heading inside `## Steps`, invoked by writing its name as the whole
step text. `Sign in` is defined once and called twice, so its body runs at
both call sites without repeating it.

Open this file in Steptix and run it: the section-body lines paint
their own status, you can set a breakpoint inside a body, and F11 steps into a
section. Go-to-definition on a `Sign in` step jumps to the `### Sign in`
heading; a typo like `Sing in` gets a "did you mean?" squiggle.

## Config
- baseUrl: http://localhost:3000

## Parameters
- email: demo@example.com
- password: $TEST_PASSWORD

## Steps
1. Sign in
2. Open the account settings page
3. Change the display name to "Demo User" and save
4. Sign out
5. Sign in
6. Assert the display name shows "Demo User"

### Sign in
1. Navigate to the login page
2. Enter "{{email}}" in the email field
3. Enter "{{password}}" in the password field
4. Click the Sign In button
5. Assert the dashboard is visible
