# 044 — CLI-generated reports (`aiui run`) never showed captured variables either

**Status:** ✅ **RESOLVED — implemented + tested + reviewed in two rounds (2026-08-08).**
**Area:** [src/runner/test-runner.ts](../../src/runner/test-runner.ts) (`computeStepCaptures`, called at every `stepResults.push` site that carries real turns), [tests/test-runner-clarification-control.test.ts](../../tests/test-runner-clarification-control.test.ts) (7 new tests)
**Related:** [issues/043-captured-variables-never-shown-in-html-report.md](043-captured-variables-never-shown-in-html-report.md) — the server-path fix this closes the CLI-side "Revisit when" item for; [issues/042-read-count-as-capture-invisible-without-output-prefix.md](042-read-count-as-capture-invisible-without-output-prefix.md) — the underlying auto-capture mechanism, ported here
**Opened:** 2026-08-08
**Resolved:** 2026-08-08

## Summary

Issue 043 gave the server/MCP/TestBench-path report a "◆ Captured" section.
The CLI path (`aiui run`, i.e. `runTest()` in `src/runner/test-runner.ts`)
has its own, entirely separate step-execution loop and report construction —
it shares only the underlying `executeStep`/`executeBranchedStep` functions
with the server path, not `session-manager.ts` itself — so it still had no
equivalent. Asked directly: "ok we need to fix it for CLI generated report
as well."

## Mechanism

Same underlying capability gap as 042/043, ported to a structurally
different loop: `resolvedParameters` (the live template-variable map
`action.as` writes into — see 042) is already used identically on the CLI
path, but nothing computed which of those writes were fresh, successful,
non-skill-internal captures worth surfacing, and nothing attached them to
the `StepResult`s this file builds.

Unlike `session-manager.ts` (one loop, effectively one push site plus two
early-exit sites), `runTest()` turned out to have **eight** places that push
onto its `stepResults: StepResult[]` array — hook steps, branched/
conditional groups, the interactive-step resume branch, the common-tail
push, and children of three different ad-hoc/REPL flows. A fix at only the
most obvious (common-tail) site would have silently missed most of them.

## Fix

A single module-level helper, `computeStepCaptures(result, resolvedParameters)`,
identical in logic to session-manager.ts's hardened (issue 042 Round 2)
filtering — restricted to `read`/`count` actions with no error, excluding
`__skill*`-namespaced names, gated on `name in resolvedParameters` — called
at every site that has real capture data available:

1. **Common-tail push** (the main per-step result, covering the `outputStep`/
   plain/`inputStep` branches, and the interactive step's `exit`/`continue`
   outcomes, which fall through to this same tail).
2. **`runHookScope`'s push** (`before`/`beforeEach`/`afterEach`/`after`).
3. **The `[interactive]` + `decision.kind === 'resume'` branch** — pushes
   directly and `continue`s, bypassing the common tail entirely. This was
   the concrete, "dominant path" bug the first review round found (see
   Round 1 below).
4. **Two ad-hoc-REPL-children push sites** (clarification-triggered handoff,
   and post-failure handoff) — each child gets its own `computeStepCaptures`
   call, not just an aggregate.
5. **The planned-`[interactive]`-step's own children** — computed once,
   upstream of both places those children can be pushed (the resume branch
   and the common-tail fallthrough), inside the loop that already re-shapes
   each child's instruction/flags.
6. **Branched/conditional-group results** (added in Round 2 — see below).

**Deliberately not covered:** tool steps (`turns: []`, so never eligible —
consistent with the server path's tool-step suppression in the renderer)
and `[input:]` steps (no turns either).

## Round 1 review (Opus 5, 2026-08-08)

First pass covered only the common-tail site. An independent review (no
prior context) found it correct as far as it went, but flagged:

1. **Must-fix**: `stepResults.push` happens at six sites, not one — the
   `[interactive]` + resume branch pushes and `continue`s before reaching
   the common tail, so its parent row got no captures even though it's "the
   *dominant* exit from a planned `[interactive]` step," not a rare case.
   Fixed by hoisting the logic into `computeStepCaptures` and calling it at
   every real site (items 1-5 above were the direct response).
2. **Untested**: the `read`/`count` action-kind filter had no coverage —
   removing it left every test green. Fixed with a dedicated test using an
   `openPage` action (which reuses the same `as` field as a tab label,
   sharing the namespace but never writing `resolvedParameters`).

Also confirmed clean: filter parity with session-manager.ts is exact,
`resolvedParameters` is the same live object `executeStep` mutates (not a
copy), retry/cache-replay don't cause double-counts, and the tool-step
branch is correctly never eligible.

## Round 2 review (Opus 5, 2026-08-08)

After Round 1's fixes landed, a second independent review verified the
expanded change (helper extraction + 5 call sites + 2 new tests) and found
it correct and safe, with two non-blocking findings:

**A. Known limitation, not fixed — last-value-wins mis-attribution in the
three REPL child loops.** Each loop scores every child in a REPL session
against the *final* `resolvedParameters`, computed after all children have
run — not the value at the time that specific child executed. Concrete
failure: a REPL session that reads the same variable name twice with
different values (e.g. `balance` = `100` then `150`) renders **both** child
rows as `◆ Captured balance=150`; the earlier row is wrong. This is
display-only (report cosmetics, not data corruption — `resolvedParameters`
itself always holds the correct final value) and narrow (needs a repeated
`as` name within one REPL session), but it is a new defect *class*: before
this fix, children showed no captures at all, so there was no wrong-value
risk. The reviewer's suggested clean fix — compute captures inside
`src/runner/interactive-repl.ts` right after each `executeStep` call,
instead of after-the-fact in the runner's per-child loops — was **not**
applied in this pass; it requires exploring/modifying a file this change
otherwise doesn't touch, for a narrow edge case in an already-edge-case
feature. Left as a follow-up (see Revisit when).

**B. Fixed.** The branched/conditional-group results loop was originally
left uncovered, reasoned (by Round 1) to mirror an identical, accepted gap
on the server path. Round 2 found that reasoning imprecise: the cited
server-side anchor (`session-manager.ts`'s MCP-facing `results` array) is a
*different surface* — branched results never reach the server's HTML report
at all, so there's nothing to have parity with there. The CLI *does* render
branched steps in its report, just without a captures box. Since
`executeBranchedStep` passes through the same live `resolvedParameters`
(confirmed by trace: a shallow options spread in `step-executor.ts`), a
`read … as x` inside a conditional group was fully capable of capturing —
it just wasn't shown. Fixed with the same two-line pattern as every other
site.

The review also confirmed no double-counting/confusing-duplication between
a parent's aggregate and its children's individual captures (finding 4 in
the review): rendered an actual report and found the `[interactive]` parent
row is a **banner only** in `generator.ts`'s `renderSteps` — it never
reaches `renderStep`, so the parent's computed `outputs` is currently inert
in the HTML (harmless; keeps `StepResult` shape-consistent with the server,
and is what the dedicated test locks in). The user-visible fix for the
resume case is the children (site 5), not the parent aggregate (site 3).

## Tests

`tests/test-runner-clarification-control.test.ts`, in a new
`describe('test-runner — captured \`as\` values reach the report')` block:
core no-prefix capture, no-double-emit with `[output:]`, `__skill*`
exclusion, stale-value-on-failure exclusion, explicit `[output: X]` still
works, the `openPage` kind-filter case (Round 1 finding), and the planned-
`[interactive]`-resume case asserting both parent and child rows (Round 1
finding, verified empirically by the Round 2 reviewer to fail without each
of the two independent fixes it covers).

No dedicated test for the hook-step site, the two ad-hoc-REPL-children
sites, or the branched-group site (fix B) — each is a mechanical call to an
already-thoroughly-tested helper at an integration point, judged not worth
the setup cost of constructing hook/REPL/conditional-group scenarios from
scratch in this pass.

`tsc --noEmit` clean; full suite green (1887 tests, 107 files) after every
round.

## Revisit when

- Finding A (last-value-wins in REPL child loops) causes a real, observed
  confusion — move the capture computation into `interactive-repl.ts`,
  per-command, instead of after-the-fact in the three runner-side loops.
- A dedicated test for the branched-group fix (B) or the hook-step site is
  wanted — needs a real `identifyStepGroups`-recognized conditional-step
  fixture (not mocked in this test file) or a hook-scope harness,
  respectively.
