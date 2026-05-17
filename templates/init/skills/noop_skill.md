---
type: skill
---

# noop_skill

A deliberately-simple skill used by the live integration test that
verifies the test file's `[skill: ...]` row gets painted correctly
when a breakpoint inside the skill body pauses the run. The live
test trips a breakpoint on the first step here, so this body is
never actually executed — anything-shaped steps work, but they're
left textual so the AI executor would have something coherent to
do if the breakpoint ever stopped trapping execution.

## Steps
1. Navigate to about:blank
2. Verify the page is blank
