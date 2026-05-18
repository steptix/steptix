---
tags: [live-integration]
---

# store-as captures survive a breakpoint pause

Mirrors the user-reported bug from skill-demo.md: a skill captures a
value via `[store as: target_url]`, and a subsequent step uses
`{{target_url}}` after a breakpoint pause splits the run into two
batches. Pre-fix, the second batch saw `{{target_url}}` as literal
text because captured values weren't persisted to `session.outputs`.

The live test sets a breakpoint on step 2, runs, then resumes — and
asserts step 2 passes (which it cannot do unless `{{target_url}}`
was interpolated correctly).

## Steps
1. [skill: capture_url]
2. Navigate to {{target_url}}
