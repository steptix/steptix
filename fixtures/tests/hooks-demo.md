---
tags: [hooks, demo]
timeout: 5m
---

# Hooks demo — login, dashboard, logout

Demonstrates the `## Hooks` mechanism. Uses the fixtures/test-app SecureBank
flow:

- `before` hooks sign in once, so every step runs from an authenticated state.
- `beforeEach` calls the `dismiss_obstacles` skill so any cookie banner shown
  on first navigation to a page is dealt with before the main step fires.
- `[no-hooks]` on the balance-read step prevents the beforeEach from firing —
  the balance is stable and we want to keep the trace clean.
- `after` signs the user out regardless of what the body did.

## Config
- baseUrl: http://localhost:8787

## Parameters
- username: demo@securebank.com
- password: password123

## Hooks
- before: Type "{{username}}" into the email field on the login page
- before: Type "{{password}}" into the password field
- before: Click the "Sign In" button and wait for the dashboard to load
- beforeEach: [skill: dismiss_obstacles]
- after: Click the "Sign out" button in the sidebar

## Steps
1. Verify the dashboard shows a balance greater than $0
2. [no-hooks] Capture the text of the `#balance` element on the dashboard [store as: starting_balance]
3. Click on "Transactions" in the sidebar and verify the transactions page loads
4. Verify at least 3 transactions are listed
