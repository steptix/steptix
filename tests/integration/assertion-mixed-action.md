---
tags: [integration, assertion]
timeout: 60s
---

# Assertion — mixed action and verify in one step

A single step that performs an action and verifies the result. The AI should
emit `[click, assert]` (with an optional wait between). One assertion appears
in the step result.

## Config
- baseUrl: http://localhost:8787/confirm-action

## Steps

1. Click the "Permanently remove access" button and verify the page shows the text "Access removed"

<!-- latest-runs:start -->
## Latest runs

- [2026-04-29 10:07:12Z — passed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-07-12-assertion-mixed-action-and-verify-in-one-step.html)
<!-- latest-runs:end -->
