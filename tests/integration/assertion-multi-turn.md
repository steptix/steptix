---
tags: [integration, assertion]
timeout: 60s
---

# Assertion — multi-turn step with verification

A single step that navigates and then verifies. Multi-turn: turn 1 navigates
with `needs_reeval: true`, turn 2 emits the `assert`. The assertion is recorded
with `turnNumber: 2` in the report.

## Config
- baseUrl: http://localhost:8787/

## Steps

1. Go to the portfolio dashboard at /assertions and verify there are exactly 5 active alerts shown on the page

<!-- latest-runs:start -->
## Latest runs

- [2026-04-29 10:10:12Z — passed](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-10-12-assertion-multi-turn-step-with-verification.html)
- [2026-04-29 10:09:46Z — passed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-09-46-assertion-multi-turn-step-with-verification.html)
- [2026-04-29 10:08:37Z — passed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-08-37-assertion-multi-turn-step-with-verification.html)
<!-- latest-runs:end -->
