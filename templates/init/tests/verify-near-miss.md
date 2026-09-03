---
tags: [live-integration, must-fail]
timeout: 300s
---

# Verify must fail — near miss

**Step 2 is expected to FAIL.** That is the whole point of the fixture, and
the live suite asserts the gutter paints red. A green run here is the bug.

The expected value is one cent off the real one: the page renders
`$148,320.50` and the step asks for `$148,320.51`. A near miss rather than an
absurd value on purpose — `$999.99` would also be caught by an assertion that
merely checks "is there a dollar figure here", whereas one cent is only
caught by an assertion that actually compares the two numbers.

Worth knowing when reading a run of this: a failed assertion throws
`StepFailureError`, which the step-level `withRetry` catches, so with the
default `execution.retries: 1` the step is attempted twice before it settles
red. Both attempts fail — the page value genuinely differs — but the run log
shows two. The retry is not coached toward passing: assertion failures never
reach `collectedFailures`, so the second attempt's prompt carries no "your
assertion failed, expected X got Y" hint (src/runner/step-executor.ts).

## Config
- baseUrl: http://localhost:8787/assertions

## Steps

1. Navigate to the baseUrl
2. Verify the total portfolio value is $148,320.51
