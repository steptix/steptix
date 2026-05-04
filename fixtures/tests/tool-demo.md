---
tags: [smoke, tools]
---

# Tool demo — fetch a CSRF token and read the page title

Demonstrates `[tool: ...]` invocation against the test-app. Two tools are
called:

1. `fetch_csrf_token` — uses the browser context's request fixture to call
   `/api/csrf-token` directly. The captured token lands in the `{{csrf}}`
   variable for downstream steps.
2. `read_page_title` — drives `page.title()` and stores the result as
   `{{page_title}}`.

Both demonstrate that tools share the live Playwright objects with the AI
loop and write outputs into the same variable scope.

## Config
- baseUrl: http://127.0.0.1:8787

## Steps
1. Navigate to {{baseUrl}}/
2. [tool: read_page_title]
3. [tool: fetch_csrf_token baseUrl]
4. Verify the page title we captured was "{{page_title}}" (just an echo)
5. Verify the CSRF token "{{csrf}}" looks like a base64 string at least 16 characters long
