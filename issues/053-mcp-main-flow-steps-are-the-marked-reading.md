# 053 — The MCP producer sends a different step string than every other client

**Status:** open / correctness — pre-existing, and only half of it was fixed.
**Area:** [src/mcp/assemble.ts](../src/mcp/assemble.ts) — `assembleTestFile`
builds the wire body's `steps` from `parsed.steps`.
**Deliberate counterpart:**
[runner-core/src/step-lines.ts](../runner-core/src/step-lines.ts)
(`extractSteps`), which is what TestBench sends: the raw line minus `N. `,
trimmed, `[no-hooks]` intact.
**Related:** the inline-sections contract
[§3.2](../stories/test-script-sections-contract.md) (which defines the wire's
step string as the raw one) and
[036](036-wrapped-main-flow-steps-truncated-on-the-testbench-path.md) (the
other way one step's text differs between the CLI and a client).
**Opened:** 2026-09-09

## Summary

The CLI parser keeps two readings of every step:

| | `steps` | `rawSteps` |
|---|---|---|
| `1. [no-hooks] Type ` + "`hello`" | `` Type hello `` | ``[no-hooks] Type `hello` `` |
| `1. Click **Save**` (loose list) | `Click Save` | `Click **Save**` |

`rawSteps` is the raw line minus the `N. ` prefix; `steps` is the *marked*
reading — `extractPlainText` has stripped inline markdown (in a loose list
only — contract §2.3) and the `[no-hooks]` marker is gone.

Every wire producer is supposed to send the raw one. TestBench does
(`extractSections` / `extractSteps`). The MCP producer sends the marked one
for the main flow:

```ts
// src/mcp/assemble.ts, assembleTestFile
const request: McpStepRequest = {
  steps: parsed.steps,   // ← the marked reading
  ...
```

So `run_test_file` on a file with a loose list, a `[no-hooks]` marker, or bold
in a step sends a string no other client would send for the same file.

## What was fixed, and what was not

The **section payload** half was fixed on 2026-09-09: `sectionsPayload` now
sends `section.rawSteps` under the `steps` key (the field `rawSteps` is still
deliberately absent — §3.2). That one was urgent because a section body's
`steps[i]` becomes the code-behind binding's `source` on the server, so a
looped body's entries bound to text nothing else writes; every iteration ran
under AI and warned that the entry matched no step.

The **main flow** has the same divergence and the same consequence for
binding — `matchInput` falls back to `steps[i]` there too — but the fix is not
a one-liner, for one reason:

**`[no-hooks]` would start reaching the model as literal instruction text.**
Nothing on the server strips a main-flow marker before it becomes the
instruction. The strippers, in full: `src/parser/markdown.ts`,
`src/parser/section-match.ts`, the expander's body-inlining strip, and
`src/parser/set-step.ts`'s `NO_HOOKS_PREFIX` — the last of which strips only
inside its own `normalise`, to decide whether a line is a `Set` step (and
`src/codebehind/compile.ts` relies on exactly that, which is why its own strip
was deleted as dead code). It never changes the text anything runs, so the
conclusion stands. Today the MCP path silently *loses* the opt-out — which
is harmless in practice, because the server path runs no `## Hooks` at all —
and sending the raw line would replace that with a visible defect on every
such step. TestBench already has that defect; joining it is not obviously an
improvement, and the honest fix (strip main-flow markers server-side, once,
for every producer) changes the TestBench path as well.

## What a fix looks like

1. Strip `[no-hooks]` from incoming main-flow steps in the server's step
   request handling, once, so every producer's markers are handled the same
   way (the expander already does exactly this for section bodies).
2. Then change `assemble.ts` to send `parsed.rawSteps` for the main flow, with
   a parity test against `extractSteps` in the shape of
   `tests/data-rows-sections.test.ts`'s "ships the same match side as the CLI
   parser".

Note that step 2 alone still leaves the *instruction* text different between
the CLI and the wire for a loose-list step with inline markdown — the CLI runs
`Click Save`, every wire client runs `Click **Save**`. That is inherent to the
wire carrying one string per step and the contract choosing the raw one; it is
measured and pinned in `tests/data-rows-sections.test.ts` rather than fixed.

## Revisit when

- Someone reports an MCP run behaving differently from the same file run from
  the CLI or TestBench, or
- code-behind entries authored from one path stop binding on another.
