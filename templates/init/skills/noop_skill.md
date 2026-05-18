---
type: skill
---

# noop_skill

A deliberately-simple skill used by the live integration tests:

- The breakpoint-paused test trips a breakpoint on line 16 (the only
  step here) and never executes the body — the skill's job there is
  just to exist so the test file's `[skill: ...]` row has something
  to paint against on `frame:push`.
- The clean-exit test runs this skill through end-to-end and asserts
  the test file's `[skill: ...]` row paints `pass` on `frame:pop`.
  That requires the body to be a single deterministic action — no
  `Verify` steps that depend on AI judgment (those flake on a real
  AI executor since "is about:blank blank?" is interpretive).

## Steps
1. Navigate to about:blank
