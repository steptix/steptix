---
type: test
---

# Renumber fixture

A step was inserted after `2.` and the `Login` body grew, so both scopes are
misnumbered. The file on disk must stay this way — the renumber suite asserts
against the in-memory buffer and reverts.

## Steps
1. Open the site
2. Login
2. Check the dashboard
3. Sign out

### Login
1. Go to the login page
1. Type the username
2. Click Sign in
