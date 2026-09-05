---
tags: [live-integration]
---

# Set assignments survive a breakpoint pause

The `Set {{name}} to "…"` step writes a variable with no model and no page
(stories/variable-assignment.md). This file proves the SERVER half of that:
the value has to reach `session.outputs` so a later HTTP batch can seed
`resolvedParameters` from it, exactly as a `[store as: X]` capture does —
see the sibling `store-as-survives.md`, which is the same seam from the
other direction.

The live test breakpoints step 3, runs, then resumes. Step 3 reads
`{{decorated}}`, which step 2 wrote in batch 1, so it can only pass if that
value was carried across the boundary and interpolated in batch 2. If the assignment never reached
`session.outputs`, `{{assigned}}` stays literal and the template resolution
fails the step, naming it.

Every step here is an assignment, so a passing run costs **zero tokens**.
That is the other half of what it proves: nothing in this file may reach
the model.

## Steps
1. Set {{assigned}} to "carried-across"
2. Set {{decorated}} to "[{{assigned}}]"
3. Set {{echo}} to "{{decorated}} and back"
