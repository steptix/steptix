---
type: macro
---

# noop_macro

A deliberately-simple macro used by the live integration tests:

- The breakpoint-paused test trips a breakpoint on line 16 (the only
  step here) and never executes the body — the macro's job there is
  just to exist so the test file's `[macro: ...]` row has something
  to paint against on `frame:push`.
- The clean-exit test runs this macro through end-to-end and asserts
  the test file's `[macro: ...]` row paints `pass` on `frame:pop`.
  That requires the body to be a single deterministic action — no
  `Verify` steps that depend on AI judgment (those flake on a real
  AI executor since "is about:blank blank?" is interpretive).

## Steps
1. Navigate to about:blank
