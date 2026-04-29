---
tags: [integration, assertion]
timeout: 60s
---

# Assertion — multiple assertions in one step

A single step that asks the AI to verify two distinct facts. The AI should emit
two `assert` actions. Both appear in `StepResult.assertions` and render as two
assertion blocks in the report.

## Config
- baseUrl: http://localhost:8787/assertions

## Steps

1. Verify the Cash & Savings total is $24,582.90 and the Investments total is $118,150.00

<!-- latest-runs:start -->
## Latest runs

- [2026-04-29 10:10:09Z — passed](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-10-09-assertion-multiple-assertions-in-one-step.html)
- [2026-04-29 10:09:36Z — passed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-09-36-assertion-multiple-assertions-in-one-step.html)
- [2026-04-29 10:07:48Z — passed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-07-48-assertion-multiple-assertions-in-one-step.html)
<!-- latest-runs:end -->
