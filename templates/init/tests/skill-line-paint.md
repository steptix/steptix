---
tags: [live-integration]
---

# Skill-line paint regression test

Fixture for the live integration test that verifies the test file's
`[skill: ...]` row gets painted `running` (and ultimately `pass`)
when a breakpoint inside the skill body pauses the run. The test
trips a breakpoint on the first step of `noop_skill`, so neither
the skill body nor step 2 below ever actually execute.

## Steps
1. [skill: noop_skill]
2. Navigate to about:blank
