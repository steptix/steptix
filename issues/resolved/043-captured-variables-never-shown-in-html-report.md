# 043 — Captured variables (`[output:]` and `as`-tagged) never appear in the HTML report

**Status:** ✅ **RESOLVED — implemented + tested + reviewed (2026-08-07).** An
independent Opus 5 review (no prior context) found no blocking issues after
actively trying to break it (including empirically reverting the fix to
confirm both new tests discriminate) — see [Review](#review-opus-5-2026-08-07).
Three non-blocking findings from that review were applied anyway; see below.
**Area:** [src/report/types.ts](../../src/report/types.ts) (`StepResult.outputs`, new field), [src/server/session-manager.ts:3351-3358](../../src/server/session-manager.ts#L3351) (threads `stepOutputs` into `fullStepResults.push`), [src/report/generator.ts](../../src/report/generator.ts) (`capturesHtml` in `renderStep`, suppressed on tool steps), [src/report/template.ts](../../src/report/template.ts) (`.captures-block`/`.captures-title` CSS), [tests/report-captures.test.ts](../../tests/report-captures.test.ts) (new, 6 cases), [tests/session-manager.test.ts](../../tests/session-manager.test.ts) (2 new tests)
**Related:** [issues/042-read-count-as-capture-invisible-without-output-prefix.md](042-read-count-as-capture-invisible-without-output-prefix.md) — the MCP-response fix this builds on; discovered as a direct follow-up question ("does this end up in the report?") right after verifying 042 live.
**Opened:** 2026-08-07
**Resolved:** 2026-08-07

## Summary

After fixing issue 042 (a `read`/`count` action's `as` capture now reaches
`run_steps`'s `captures` field), the natural next question was whether the
same value shows up in the generated HTML report. It didn't — for **either**
capture mechanism, not just the newly-auto-surfaced one. Checked directly
against a real generated report: `total_available`/`37.76` appeared only
twice, both incidental — once inside the raw JSON action-plan dump (a
debug/transparency view) and three times inside embedded DOM snapshots (the
`aria-label` text the AI read from). No "Captured Variables" section existed
anywhere.

## Mechanism

The HTML report and the MCP response are built from two entirely separate
per-step data structures, populated in the same session-manager step loop but
never reconciled:

- **`results`** (MCP-facing) — each entry gets `outputs: stepOutputs`
  ([session-manager.ts, the loop this issue's fix extends](../../src/server/session-manager.ts#L3252)),
  which is what `run_steps`'s response and (via issue 042) `captures` are
  built from.
- **`fullStepResults`** (report-facing, type `StepResult[]`) — fed straight
  into `generateReport`
  ([session-manager.ts:3604,3621](../../src/server/session-manager.ts#L3604)).
  `StepResult` ([report/types.ts](../../src/report/types.ts)) had **no
  `outputs` field at all** before this fix — not a rendering oversight, the
  data was never carried over in the first place.

One near-miss: the top-level `TestReport` object does get a `parameters`
field populated from the full `resolvedParameters` map when non-empty
([session-manager.ts:3619](../../src/server/session-manager.ts#L3619)), which
already included any `as`-captured value even before issue 042. But
[report/generator.ts](../../src/report/generator.ts) never reads or renders
`report.parameters` anywhere in the HTML template — a dead field for this
purpose. So this gap predates and is independent of issue 042; it would have
existed identically for a plain `[output: X]` capture with no `as` involved.

## Fix

Threaded the same `stepOutputs` the capture loop already computes (per
step, per issue 042) into the report's per-step data, and rendered it:

1. **`StepResult.outputs?: Record<string, string>`** — new optional field.
   Omitted (not `{}`) when a step captured nothing, so the report doesn't
   show an empty box on every ordinary step (`click`, `navigate`, …) — most
   steps capture nothing, unlike a `[tool: ...]` step where an Outputs
   section is always relevant.
2. **`fullStepResults.push({ ..., ...(Object.keys(stepOutputs).length > 0 &&
   { outputs: stepOutputs }) })`** — same conditional-spread idiom already
   used for `TestReport.parameters` two hundred lines below, reusing the
   `stepOutputs` local that's already `__skill`-filtered and stale-value-safe
   (issue 042's Round 2 fix) — no new filtering logic, this only plumbs
   already-correct data to a second destination.
3. **`renderStep` (generator.ts)** — a `capturesHtml` block, same shape as
   the existing `renderToolStep` outputs section (reuses `.tool-kv`/
   `.tool-kv-row`/`.tool-kv-key`/`.tool-kv-value` for the rows), spliced in
   after the turns and before assertions. Unlike the tool-step section, this
   one is omitted entirely (not shown with an empty-state placeholder) when
   there's nothing to show — and also omitted whenever `step.toolStep` is
   set (review finding, see below), even if `step.outputs` is non-empty.
4. **`.captures-block`/`.captures-title` (template.ts)** — new CSS, reusing
   the existing green `--pass` palette (`#f0fdf4`/`#bbf7d0`) already used for
   `.assertion-block.pass`/`.diagnosis-fix`, distinct from the purple
   `.tool-block` so a captures section doesn't read as "this was a tool
   step" on an ordinary AI-driven step. The captured variable *name* is
   recoloured green too (`.captures-block .tool-kv-key`) — it inherited
   purple from the reused `.tool-kv-key` class otherwise (review finding).

The other two `fullStepResults.push` call sites (pre-flight refusal, and the
mid-run error-catch path) are unchanged — no step executed at either, so
there is no `stepOutputs` to attach.

## Tests

- **`tests/report-captures.test.ts`** (new) — `renderStep` unit tests:
  single capture renders name+value, multiple captures all render, block
  omitted when `outputs` is unset, block omitted when `outputs` is `{}`,
  HTML-escaping of both captured names and values, and (added post-review)
  the block is suppressed on a tool step even when `outputs` is set.
- **`tests/session-manager.test.ts`** — two new tests asserting against the
  `generateReport` mock's actual call argument (the established pattern in
  this file, e.g. the issue-021 report tests): a step with an `as` capture
  produces `report.steps[0].outputs === {total_available: '37.76'}`; a step
  with no captures produces `report.steps[0].outputs === undefined`. The
  reviewer independently confirmed both discriminate by reverting the fix
  and watching each fail for a different reason, then restoring it.

`tsc --noEmit` clean; full suite green (1880 tests, 107 files).

## Review (Opus 5, 2026-08-07)

An independent reviewer (general-purpose agent on Opus 5, no prior context)
was asked to try to break this before it shipped — same practice as issue
042's Round 2. **Verdict: correct and safe as-is, no blocking issues.**

Specifically checked and cleared:
- **No divergence risk between the MCP-facing and report-facing `outputs`.**
  `stepOutputs` is declared once, written once, and both `results.push(...)`
  and `fullStepResults.push(...)` hold the *same object reference* — not
  independently-computed copies that could drift apart.
- **The other two `fullStepResults.push` call sites correctly stayed
  untouched** — traced why each legitimately has no capture data available
  (the abort path `break`s before the capture loop ever runs; the
  error-catch path never has a `stepResult` to spread from).
- **`...stepResult` can never silently carry a stale `.outputs` that the new
  spread order would mask** — grepped `step-executor.ts` for every return
  site (all explicit literals, none set `.outputs`) and confirmed the
  on-disk step cache persists raw AI turns, never a `StepResult`, so no
  pre-existing cached report data could reach this path either.
- **`escapeHtml` applies to both captured keys and values**, and every
  writer into `resolvedParameters` produces a string, so nothing
  non-string-typed can reach it.
- **A step that captured something and then failed on a later action**
  correctly shows both the green Captured block and the red failure block —
  reviewed as intentional, not contradictory: the capture genuinely
  happened, and suppressing it would make the report disagree with the
  Variables panel / MCP `captures`, which already reflect it.

Three non-blocking findings, all applied:

1. **Tool-step double-render (the one real edge case).** An undocumented but
   parseable combination, `[output: foo] [tool: t out.x="foo"]`, aliased the
   same value into both `toolStep.outputs` (purple) and the new general
   `outputs` (green) — two boxes showing the same thing. Root cause:
   pre-existing on the wire (two separate `'capture'` SSE events fire for
   that case, sourced `'toolOutput'` then `'capture'`); this fix just made
   the redundancy visible for the first time. Fixed by skipping
   `capturesHtml` whenever `step.toolStep` is set — the tool section already
   covers that case.
2. **Cosmetic.** The captured variable name rendered purple (inherited from
   the reused `.tool-kv-key` class) inside an otherwise-green block. Fixed
   with a scoped override.
3. **Inaccurate comment.** A comment (mine, added in this same change) cited
   `[tool: ... out.foo=bar]` as example syntax; the real syntax requires a
   quoted value (`out.foo="bar"`) or a bare alias (`out.foo`) — the form
   quoted doesn't parse. Fixed.

One observation left as a scope decision, not fixed here: **the CLI runner
(`aiui run`) never populates `StepResult.outputs`** —
`src/runner/test-runner.ts` pushes the raw step result with no equivalent
capture loop, so a report generated via the CLI (rather than the
server/MCP/TestBench path) shows no Captured section for the same test. Also
noted: `TestReport.parameters` (populated on both paths) is still never
rendered anywhere in the HTML — this fix's Captured block is the report's
only surfacing of captured values, and only on the server-driven path.

## Discovered while

Asked directly, right after live-verifying issue 042 against the real
OpenRouter Credits page via a CDP-attached session: "does this end up in the
report?" Checking the actual generated report file (rather than assuming)
showed no dedicated section — leading to tracing `fullStepResults` vs
`results` as two independently-populated structures.

## Revisit when

- ~~A CLI-generated report (`aiui run`) needs the same Captured section.~~
  **Done — see [issues/044-cli-report-missing-captured-variables.md](044-cli-report-missing-captured-variables.md).**
- A run-level summary (e.g. all captures across every step, not just
  per-step inline) is wanted — `TestReport.parameters` already carries the
  full end-of-run map; it would need the same "only when non-empty, only
  non-`__skill`" treatment before being rendered anywhere.
- Captures from inside a conditional branch need reporting — same
  pre-existing `executeBranchedStep` gap noted in issue 042's Revisit list;
  branch results never reach `fullStepResults` via this path either.
