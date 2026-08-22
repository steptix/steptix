# Compiling code-behind

Builds on [step-codebehind.md](step-codebehind.md), which shipped the file
format, binding, loading, execution, self-heal and an inline generator. This
story replaces *when and how* code-behind gets generated. Nothing about the
file format, binding or execution changes.

## What we're building

Generating a test's code-behind becomes something the author **does**, once
the test is authored and passing — a build step, not a side effect of
running. The author presses **Compile**; the framework records the test
under AI (or reuses the run they just did), writes TypeScript for every
step with the whole test in view, reviews that code against the rules,
replays the test as pure code until it passes, and only then shows the
author a diff to apply. Normal runs stop generating anything: a broken entry
heals through AI for that one step and is **flagged** for the next compile,
so files never change under an author mid-run.

Example. The author has `tests/github.md` green under AI and presses
**TestBench: Compile Code-behind** (or runs `aiui compile tests/github.md`).
The Runner panel shows:

```
Compile github.md
  Record      reusing session 4f2a (9 steps, green 2 min ago)
  Generate    9 steps → github.steps.ts (2 entries kept, 7 generated)
  Review      2 fixes: step 2 froze a literal date; step 6 lacked a post-condition
  Replay 1    ✗ step 5 — locator timeout on input[name="commit"]
  Repair      step 5 regenerated from the failure
  Replay 2    ✓ 9/9 passed as code, 0 AI calls, 6.1s
  Write       github.steps.ts — 7 entries added, 2 unchanged
```

then a notification: *"Compiled github.md: 9 of 9 steps as code. Used 91k
tokens; these steps now cost 0."* with **Open diff** / **Show log**. The
diff view opens — current file vs. proposed — and **Apply** writes it. From
then on the test replays in seconds with no model calls, as proven in the
step-codebehind smoke (0.8s / 0 tokens with an invalid AI key).

Three weeks later the sign-in page changes. The author runs the test: step
5's entry throws, the AI heals it, the run passes, and the gutter shows
**⚠** on step 5 with *"ran under AI — code-behind failed; recompile"*. They
press Compile again; only the flagged step is regenerated; diff; apply.

## Context — what the inline generator gets wrong

The generator that shipped in step-codebehind.md runs during every recording
run: one model call per step, immediately after the step passes, from that
step's transcript alone. It has three weaknesses the first live runs made
concrete:

1. **Narrow context.** It sees one step's text and transcript — not the
   previous steps, not the existing `.steps.ts`, not the DOM. It cannot
   reuse a selector from step 2 in step 5 or keep the file consistent.
2. **No review, no execution.** Generated code is syntax-checked and
   secret-guarded, then trusted until the *next* run. Two of the three
   defects found in the live smoke (the JSON envelope, the double-escaped
   newlines) were only detectable by running the output. And the most
   characteristic bug of this feature — a model freezing today's date as a
   literal — produces code that *passes* on the day it is written; only a
   review that asks "should this be computed?" catches it.
3. **Surprising side effects.** Files change while a test runs, inside
   whatever tool the author is using. In TestBench that is a file changing
   under an open editor.

The fix is to give generation the whole test, a review pass, and an
execution loop with feedback — and to make it a deliberate act with a diff
at the end. That is a compiler with a test suite, and it gets to iterate.

## Design

### The runtime stops generating

In `executeStep`, the success-path generation hook is removed. The code-behind
branch keeps everything else — execute ahead of the cache, throw → discard →
fall through to AI — and adds one thing: when an entry threw and the step
then passed under AI, the `StepResult` carries

```ts
codeBehindStale?: { file: string; source: string; error: string };
```

The report renders it as **⚠ ran under AI — code-behind failed**, the run
summary counts it ("7 steps as code, 1 AI, 1 stale"), and TestBench shows
⚠ in the gutter. The `codebehind.generate` config key is removed: there is
no longer anything for it to gate.

Every run also writes `.aiui-codebehind-cache/<name>.last-run.json` beside
the test — per step: `source`, `section`, `status`, `fromCodeBehind`,
`stale` — so `--only-stale` and the TestBench gutter have something to read
without re-running.

### The compile pipeline

`compileTest(options)` in `src/codebehind/compile.ts`, one core used by the
CLI in-process and by the server for TestBench. Phases, in order:

**1. Record.** Run the test under AI, in a fresh session, keeping each
step's `StepResult` — the action transcript, DOM snapshot and URL *before*
the step (captured at turn 1) and *after* it (the post-step capture),
resolved parameters, outputs, assertions. TestBench may instead pass a
`sessionId` of a completed, green run whose results still carry DOM
snapshots ("Compile from this run"); then this phase is skipped.

**2. Select.** Decide which steps get (re)generated — the set **S**:
steps with no entry, steps flagged stale, and steps the author named
(`--steps`, "Compile This Step", or `--all`). Existing passing entries and
every `ai: true` entry are kept verbatim. Section-call lines, `[skill:]` and
`[tool:]` steps are never in S.

**3. Generate.** One model call per step in S, in step order, each given:

- the **whole test** — every step's text with markers for which are being
  compiled, the test's parameters and config, the project context files;
- the **current candidate file** so far — existing entries plus the ones
  generated earlier in this pass — so selectors and helpers stay consistent;
- for this step: raw text, the transcript, DOM + URL before, DOM + URL after,
  captures, assertions, the referenced parameters with values (the leak
  guard still applies);
- the contract and rules from step-codebehind.md, plus one new rule: **every
  entry ends with a post-condition** — a `locator.waitFor()` on what the
  step should have produced, or a `step.expect` — so that on replay, "did
  not throw" means "the page shows the step succeeded".

The model may decline — `{"entry": null, "reason": "..."}` — for steps that
need framework actions, interactive input, or a judgment code can't
express. A declined step becomes an `ai: true` entry with the reason as a
comment, so the author sees exactly what stayed AI and why.

The response shape is the `{"entry": ...}` JSON envelope (the client forces
`json_object`), parsed by `parseStepCode` as today.

**4. Review.** One model call over the complete candidate file with a
checklist: dynamic values computed at runtime, not frozen; parameters via
`step.getVar`; a post-condition per entry; stable selectors over positional
ones; outputs written; no imports. It returns the revised file in a
`{"file": "..."}` envelope. The revision is esbuild-validated and the leak
guard runs over it; if either fails, the pre-review candidate stands and the
log says so.

**5. Replay.** Run the test as code in a fresh session with the loader
pointed at the candidate (an override path the loader accepts for this
purpose — the real file is untouched) and **strict** code-behind: an entry
that throws fails the step instead of falling through to AI. Steps with
`ai: true` entries run under AI as normal — they are the only AI calls in a
replay. On a failure at step *k*: hand the model the entry, the error, and
the DOM + screenshot at the failure, regenerate step *k* into the
candidate, and run the next round from the start. Bounded by `maxRounds`
(default 3). A step that fails every round is rewritten as `ai: true` with
the last error as its comment, and one final round confirms the rest.

If a failure lands on an entry **not** in S — an existing or hand-edited
entry — compile does not silently replace the author's code: it marks the
step stale, stops, and says "existing entry for step *k* fails; recompile it
with `--steps k` (or Compile This Step)".

**6. Write.** On green, the CLI writes the file(s) and prints the summary;
TestBench receives the proposed content and opens a diff. Nothing is written
on a non-green compile: the candidate is left at
`.aiui-codebehind-cache/<name>.steps.ts.candidate` and the summary says
where, so entries can be salvaged by hand.

Skills: a test that invokes skills compiles entries into the skill's own
`.steps.ts`, so the candidate — and the diff — can span several files.

### What the author runs

| Surface | Full compile | One step |
|---|---|---|
| CLI | `aiui compile tests/github.md` with `--only-stale`, `--all`, `--steps 3-5`, `--dry-run`, `--max-rounds N` | `aiui compile tests/github.md --steps 5` |
| TestBench | **Compile Code-behind** — editor title button beside Run All, command palette | **Compile This Step** in the line-number context menu, beside Run This Step |
| Runner panel | **Compile from this run** after a green run (passes the session id; skips Record) | — |

`--dry-run` runs everything but Write and prints the candidate. Exit code 0
on green, 1 otherwise.

**Compile This Step on a paused session** is the one place generation runs
*before* execution. With the session paused at a breakpoint before step
*k*, the page is already in exactly the right state, so: generate from the
step text, parameters and the *live* DOM, run the entry on the live session,
and if it passes, offer it in the diff. If it throws, report the error and
warn that the page may have changed. No record and no replay rounds — the
real execution just happened. Without a paused session, Compile This Step
is a full compile with `S = {k}`.

### What the author sees

- **During** — the Runner panel and run log show the phases above, one line
  per step event: "step 4 generated", "step 6 replay failed (locator
  timeout) → regenerated → passed", "step 8 kept as AI: needs interactive
  input".
- **At the end** — one notification: *"Compiled github.md: 7 of 9 steps as
  code, 2 kept AI. Used 84k tokens; these 7 steps now cost 0."* with
  **Open diff** / **Show log**; on failure, **Show log** / **Open candidate**.
- **The diff** — VS Code's diff editor, current file vs. proposed, with
  **Apply** and **Discard**. Apply writes through the workspace API so it is
  undoable and shows in Source Control like any edit. The CLI writes
  directly because it is the scriptable path.
- **In the gutter, after runs** — ⚙ the step passed as code, ⚠ its entry
  failed and the step ran under AI (recompile), ✓/✗/⚡ as today. Same
  decoration mechanism and per-file persistence as the existing marks, fed by
  `fromCodeBehind` / `codeBehindStale` on the step events.
- **In the run log and summary** — "✓ step on line 12 passed (code-behind)"
  and "9 steps: 7 code-behind, 1 AI, 1 stale".
- **In the file** — a step compile could not make pass is an `ai: true`
  entry with a comment saying why. It is plain TypeScript; the author can fix
  it by hand, and hand edits are honoured because binding is by step text.
- **Open Code-behind** — a context command on a step that opens its entry in
  the sibling file (the counterpart of Go to Section).

### How many prompts

For an N-step test with *s* steps in S and *f* replay failures:

| Phase | Model calls | Notes |
|---|---|---|
| Record | one AI run of the test | skipped when compiling from a green session |
| Generate | *s* | each with before/after DOM — the largest prompts |
| Review | 1 | whole file |
| Replay | 0 | pure code; only `ai: true` steps call the model |
| Repair | ≤ *f* × rounds | one per failing step per round |

More calls than the inline generator's *s* unreviewed shots — by design.
They happen once, where the author chose, and produce code that has been
executed and reviewed. Every run afterwards makes zero calls for compiled
steps, and the compile summary states the tokens it used so the trade is
visible.

### Server

`POST /codebehind/compile` — `{ testFilePath, steps?, sections?, envName?,
fromSessionId?, select?: { onlyStale?, all?, steps? }, maxRounds?,
dryRun? }` — streams phase and step events in the same framing as step
streaming, then a final `{ status: 'green' | 'failed', files: Record<path,
content>, summary }`. The server writes nothing under the project except
the gitignored candidate; TestBench applies. One compile per test file at a
time. The project bundle is resolved per request, as for any run; the
`api-server` field allow-list must name every new field — an unlisted field
is silently dropped.

`fromSessionId` is valid while that session is open and only if its step
results carry DOM snapshots; otherwise the server records.

## Amendments to step-codebehind.md

- Generation section: superseded by this story; inline generation and
  `codebehind.generate` removed; the post-condition rule added.
- Execution section: throw → heal → `codeBehindStale` on the result.

## Implementation outline

New:

- `src/codebehind/compile.ts` — the pipeline; `src/codebehind/review.ts`
  (review prompt + `parseFileRevision`); `src/codebehind/repair.ts` (failure
  prompt); `buildStepCodePrompt` grows the whole-test, candidate-file and
  before/after-DOM sections and the post-condition rule; the
  `{"entry": null, "reason"}` decline.
- `src/cli/commands/compile.ts` — `aiui compile`.
- `src/server/api-server.ts` + `session-manager.ts` — the compile endpoint,
  streaming, candidate override, strict mode, per-file lock.
- `runner-core/src/api-client.ts` — `compileCodeBehind(...)` stream; step
  event fields `fromCodeBehind`, `codeBehindStale`.
- `testbench-native` — commands `compileCodeBehind`, `compileStepCodeBehind`,
  `openCodeBehind`; diff preview with Apply/Discard; ⚙/⚠ decorations;
  Runner-panel phases and the **Compile from this run** action; summary
  notification. Patch version bump per CLAUDE.md (runner-core changes too).

Modified:

- `src/runner/step-executor.ts` — remove the generation hook; add
  `codeBehindStale`, the `strict` option, and the last-run sidecar write.
- `src/codebehind/loader.ts` — candidate override path.
- `src/config/*`, `schema/` — drop `codebehind.generate`.
- `src/report/*` — ⚠ stale rendering and the code/AI/stale counts.

## Tests

- Unit: selection set S (no-entry, stale, named, `ai: true` kept); strict
  mode fails instead of falling through; stale flag on heal; sidecar
  written; candidate override loading; review revision validated and
  rejected correctly; decline → `ai: true` with reason; repair prompt carries
  entry + error + DOM.
- Pipeline with a stub client and fake page: green first round; failure →
  repair → green; never-converging step → `ai: true` + confirming round;
  failure on a non-S entry stops with the stale message; nothing written on
  failure; multi-file candidates for skills.
- Server: POST through the real `api-server` entry (the seam that silently
  drops fields), streaming events, per-file lock, `fromSessionId` reuse and
  fallback to record.
- CLI: flags, exit codes, `--dry-run` output.
- Extension integration (FakeApiClient): the command, phase lines, diff open,
  Apply writes the file, ⚙/⚠ marks from step events.
- Live: compile the local smoke test from step-codebehind's verification to
  green, then replay with an invalid AI key — 0 tokens.

## Non-goals

- A static ⚙ mark before any run (needs a bindings query; later).
- An MCP `compile_test` tool (natural follow-on once the server endpoint
  exists).
- Auto-compile on save, or compiling a skill in isolation — skills compile
  through the tests that invoke them.
- Standalone `.spec.ts` export — still its own story; the candidate file is
  deliberately shaped so that export is close to concatenation.
