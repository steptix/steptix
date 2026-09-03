---
tags: [live-integration]
---

# Compile tab steps live test

Fixture for the tab half of stories/codebehind-framework-actions.md. Every
step is a page action or a tab action against `fixtures/test-app`, so none is
declined — the point of the test is that steps 2, 4 and 5, which used to be
refused for using `openPage` / `switchPage` / `closePage`, now compile to
`ctx.tabs` calls. Local and deterministic — no external account, no network.

Step 1 spells the URL out rather than saying "navigate to /new-window": a
relative path compiles to `page.goto('/new-window')`, which throws because
there is no Playwright-level `baseURL`, so the step healed under AI on every
proving run and cost 15k tokens for nothing.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to http://localhost:8787/new-window
2. Click "Open New Tab" and switch to the tab it opened
3. Confirm the new tab shows the heading "Account Summary"
4. Switch back to the main tab and confirm the heading "Window & Tab Test" is shown
5. Close the tab showing "Account Summary"
