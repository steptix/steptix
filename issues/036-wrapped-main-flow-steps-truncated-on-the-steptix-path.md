# 036 — A wrapped main-flow step is truncated on the Steptix path

**Status:** open / correctness — pre-existing, predates inline sections.
**Area:**
[runner-core/src/step-lines.ts](../runner-core/src/step-lines.ts) (`extractSteps`
— reads a step's first physical line only);
[steptix-vscode/src/extension/run-controller.ts](../steptix-vscode/src/extension/run-controller.ts)
and [testbench-monaco/src/extension/run-controller.ts](../testbench-monaco/src/extension/run-controller.ts)
(both build `steps` / `fullSteps` from it).
**Deliberate counterpart:**
[src/parser/markdown.ts](../src/parser/markdown.ts) — the CLI runs each step
through `marked`, which folds a wrapped list item into one step.
**Related:** [035](035-step-line-span-parser-duplicated-six-times.md) (the same
copies); the inline-sections contract
[§3.2](../stories/test-script-sections-contract.md), whose wrapped-item rule
covers section **bodies** and explicitly scopes this one out.
**Opened:** 2026-07-23

## Summary

Markdown continues a list item across lines. The CLI executes the item's whole
folded text; every client-side scanner reads only its first physical line. So
this test:

```markdown
## Steps
1. Type the username
   into the tenant field, then press Enter
2. Submit
```

runs as two steps from the CLI —

```
"Type the username\ninto the tenant field, then press Enter"
"Submit"
```

— and as two *different* steps from Steptix:

```
"Type the username"
"Submit"
```

The second line of the instruction is dropped without a warning. The AI is
asked to do less than the author wrote, and the run may still pass.

## Why it is filed now

It is not new and it is not caused by inline sections. It surfaced while
building the sections line model, because sections raise the stakes of the
same truncation: a wrapped step inside a `### Section` body can truncate to
text that happens to *name another section*, at which point the server
dispatches into that section while the CLI runs the literal instruction — a
silent change of control flow, not just of text.

That body-level case **is** handled: `findWrappedStepLines` detects it and the
contract requires the run-time pre-flight to refuse the file
([§3.2](../stories/test-script-sections-contract.md)). The gate is
deliberately scoped to body steps, so the main-flow case documented here stays
open. This issue exists so that scoping decision has something to point at.

## Detection already exists

`findWrappedStepLines(text)` in
[runner-core/src/step-lines.ts](../runner-core/src/step-lines.ts) already
reports every wrapped step, main flow and body alike — it is only the *gate*
that ignores main-flow lines. Whoever picks this up does not need new
detection, just a decision about what to do with what is already detected.

## Options, roughly in order of cost

1. **Warn.** Surface a diagnostic on a wrapped main-flow step. Cheap, honest,
   and does not change what runs — but leaves the divergence in place.
2. **Refuse.** Widen the pre-flight gate from body-only to all steps. Correct,
   consistent with the body rule, and would reject existing tests that wrap
   for readability today. Needs a survey of real test files first.
3. **Fold client-side.** Reproduce marked's continuation rules in
   `extractSteps`. Makes wrapped steps work everywhere, and is the only option
   the author would actually want — but it means a hand-written copy of
   markdown's block grammar in the client, which is exactly the drift
   [035](035-step-line-span-parser-duplicated-six-times.md) is about. Only
   sane if it lands *as part of* 035's consolidation, in one place.

## Revisit when

- 035 is picked up (option 3 becomes cheap at that point), or
- a user reports a step "not doing all of what it says", which is how this
  will present.
