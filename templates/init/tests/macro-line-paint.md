---
tags: [live-integration]
---

# Macro-line paint regression test

Fixture for the live integration test that verifies the test file's
`[macro: ...]` row gets painted `running` (and ultimately `pass`)
when a breakpoint inside the macro body pauses the run. The test
trips a breakpoint on the first step of `noop_macro`, so neither
the macro body nor step 2 below ever actually execute.

## Steps
1. [macro: noop_macro]
2. Navigate to about:blank
