---
tags: [smoke, multi-browser]
timeout: 180s
---

# Multi-browser demo — Chrome (default) + Edge (via skill)

Demonstrates the framework spawning a second, fully-isolated browser
instance during one test. The default browser is Chrome (whatever the
test config picked); the skill `open_edge_and_check_isolation` then
launches a separate Microsoft Edge process and proves their cookie jars
don't share state.

## Config
- baseUrl: ${env.BASE_URL}

## Steps
1. Navigate to {{baseUrl}}/ and verify the SecureBank "Sign In" form is visible
2. Sign in with email "demo@securebank.com" and password "password123"
3. Verify the dashboard page is now visible (the welcome banner contains "Welcome back")
4. [skill: open_edge_and_check_isolation baseUrl="${env.BASE_URL}"]
5. Switch back to the default browser: [switchBrowser to="default"]
6. Verify we are still signed in on the default browser (the dashboard welcome banner is still visible — the default browser kept its session through the entire skill invocation)
