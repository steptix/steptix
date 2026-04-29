---
tags: [integration, assertion]
timeout: 60s
---

# Assertion — failure naming

The expected value is deliberately wrong. The framework must fail the step
immediately with an error message that names the assertion by its `description`,
not a generic "assertion failed".

This test is expected to FAIL. Run it and inspect the report / error to
confirm the failure message includes the assertion's description.

## Config
- baseUrl: http://localhost:8787/assertions

## Steps

1. Verify the total portfolio value shown is $999,999.99

<!-- latest-runs:start -->
## Latest runs

- [2026-04-29 10:08:15Z — failed — gpt-5.4-mini](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_10-08-15-assertion-failure-naming.html)
<!-- latest-runs:end -->
