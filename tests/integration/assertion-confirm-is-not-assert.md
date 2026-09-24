---
tags: [integration, assertion]
timeout: 60s
---

# Assertion — "Confirm by clicking" must not trigger an assertion

The instruction starts with the word "Confirm" but the intent is an action
(click a button). The AI should emit only a `click`. The framework must NOT
generate or run any assertion JS for this step.

After the click, a separate verify step explicitly asks for verification — that
step should produce one `assert`.

Expected in the report after a run:
- step 1 (the confirm-by-clicking step) shows a click and no assertion block
- step 2 (the explicit verify step) shows exactly one assertion block

## Config
- baseUrl: http://localhost:8787/confirm-action

## Steps

1. Confirm the action by clicking the red "Permanently remove access" button
2. Verify the delegate status shown is "Status: Access removed"

<!-- latest-runs:start -->
## Latest runs

- [2026-04-29 10:10:06Z — passed](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-10-06-assertion-confirm-by-clicking-must-not-trigger-an-assertion.html)
- [2026-04-29 10:09:27Z — passed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-09-27-assertion-confirm-by-clicking-must-not-trigger-an-assertion.html)
- [2026-04-29 10:06:42Z — passed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-06-42-assertion-confirm-by-clicking-must-not-trigger-an-assertion.html)
- [2026-04-29 10:05:17Z — failed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-05-17-assertion-confirm-by-clicking-must-not-trigger-an-assertion.html)
<!-- latest-runs:end -->
