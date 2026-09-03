---
tags: [live-integration]
---

# Compile browser steps live test

Fixture for the browser half of stories/codebehind-framework-actions.md.
Steps 2, 4 and 5 used to be refused for using `openBrowser` / `switchBrowser`
/ `closeBrowser`; they now compile to `ctx.browsers` calls. Local and
deterministic — no external account, no network.

The two browsers sit on pages with different headings on purpose. Step 4 is
the proof: it asserts the DEFAULT browser is still showing "Window & Tab
Test", which can only hold if the compiled switch moved the run's own
`BrowserTracker` rather than just handing the entry a second Playwright
instance.

URLs are spelled out rather than written as paths, for the reason
[compile-tabs.md](compile-tabs.md) gives: a relative `page.goto('/x')` throws,
because nothing sets a Playwright-level `baseURL`.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to http://localhost:8787/new-window
2. Open a second browser as worker
3. Navigate to http://localhost:8787/assertions and confirm the heading "SecureBank Portfolio" is shown
4. Switch back to the default browser and confirm the heading "Window & Tab Test" is shown
5. Close the worker browser
