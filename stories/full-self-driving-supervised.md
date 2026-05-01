# Full Self Driving (Supervised)

> **Superseded by [unified-interactive-repl.md](unified-interactive-repl.md).**
> The post-failure handoff described below is now part of the unified
> `[interactive]` REPL. Command vocabulary is `/`-prefixed
> (`/continue`, `/resume`, `/screenshot`, `/exit`); annotation fields
> were renamed (`fsdAdHoc` → `interactiveAdHoc`, `fsdResumed` →
> `interactiveResumed`, `supervised` → `humanIntervened`).
> The `INTERACTIVE_ON_FAILURE` env var and the
> `execution.interactiveOnFailure` config field still gate the
> failure-handoff trigger and are unchanged.

## Context

When a test step fails after retries are exhausted, the current runner closes the browser and writes the report. The human loses all of the page state that caused the failure — cookies, local storage, modal dialogs, multi-step form input, whatever was on-screen. The only way to reproduce the conditions under which the test broke is to re-run it from scratch.

**Full Self Driving (Supervised)** — "FSD(S)" — is an opt-in local dev mode that, on unrecoverable step failure, keeps the browser open and drops the developer into a terminal REPL. The developer can:

1. Poke at the live page via ad-hoc Flick steps (executed as normal AI steps against the current page).
2. Take screenshots into the report on demand.
3. Pick a step from the test and resume the run from there — state (captured parameters, csrf tokens, API responses) carries over.

The mode is strictly local and opt-in: it activates only when `INTERACTIVE_ON_FAILURE=true` is set in `.env`, the browser is in headed mode, and `stdout` is a TTY. Any of those conditions failing silently falls back to normal behavior.

## Changes Overview

4 files modified, 1 new file, plus tests.

### 1. New: `src/runner/fsd-repl.ts` — REPL handoff & resume menu

A single module exporting `runFsdRepl(context): Promise<FsdResumeDecision>` where `FsdResumeDecision` is `{ kind: 'resume'; fromStepIndex: number } | { kind: 'exit' }`.

Context includes: the live `Page`, the full ordered list of step instructions, the index of the failed step, the `StepExecutorOptions` used for executing ad-hoc steps, and a reference to the accumulator array where ad-hoc REPL `StepResult`s are appended (so the test runner can include them in the report).

REPL loop:
- Prompt with `fsd> `.
- If input starts with `:`, it's a command:
  - `:help` — list commands.
  - `:list` — print numbered list of all steps in the test, mark failed one.
  - `:screenshot` — capture current page, save to report via an appended `StepResult` with a synthetic instruction like `[fsd: screenshot]`.
  - `:resume` — show resume menu (below).
  - `:exit` / `:quit` — return `{ kind: 'exit' }`.
- Otherwise, treat input as a Flick step and execute it via `executeStep(...)`. Append the result to the ad-hoc results array. **If it fails, log and stay in REPL** — do not re-enter FSD handoff.
- Blank input is a no-op (reprompt).

Resume menu:
- Shows indexed list of all steps; default selection is `failedStepIndex + 1` (the step *after* the failed one).
- Accepts a numeric input (1-based) or blank (= default) or `x` to cancel back to REPL.

All REPL I/O uses `readline/promises` against `process.stdin`/`process.stdout`, mirroring the existing `[interactive]` step pattern in `test-runner.ts`.

### 2. Modify: `src/config/types.ts` — new config field

Add to `ExecutionConfig`:
```ts
/** Drop into a REPL when a step fails after retries (headed + TTY only). */
interactiveOnFailure: boolean;
```

Default to `false` in `src/config/defaults.ts`.

### 3. Modify: `src/config/loader.ts` — read `INTERACTIVE_ON_FAILURE` from env

Extend `withEnvDefaults()` to parse `process.env.INTERACTIVE_ON_FAILURE` as a boolean (`true`, `1`, `yes` → true; anything else → false) and set `config.execution.interactiveOnFailure` when the env var is present. Env value only wins if the user hasn't already set it in their config file (same precedence rule as `AI_API_KEY`).

Add a small helper `parseBoolEnv(value: string | undefined): boolean | undefined` in `src/env/loader.ts` so it's unit-testable and reusable.

### 4. Modify: `src/runner/test-runner.ts` — integrate handoff + resume loop

Replace the current linear `for (let i = 0; i < test.steps.length; i++)` with a `while` loop driven by a `resumeFromIndex` pointer so the outer loop can restart partway through the list.

On step failure (`stepResult.status === 'failed'`) **after** all internal retries:
1. Check gating: `config.execution.interactiveOnFailure && config.browser.headed && process.stdout.isTTY`. If any fail, keep current behavior (set `bail = true`).
2. Otherwise, call `runFsdRepl(...)` with the failed step result, live page, and `test.steps`.
3. On `{ kind: 'resume', fromStepIndex }`: mark the failed step result with `fsdResumed: true`, append any REPL step results to `stepResults`, set `resumeFromIndex = fromStepIndex`, clear `bail`, and continue the outer loop. Push a history entry noting the human intervention so subsequent AI steps see it in conversation history.
4. On `{ kind: 'exit' }`: append REPL results to `stepResults`, set `bail = true`.

Determining final status: if a test fails, the user resumes, and subsequent steps all pass, the report's overall status should be `passed` — but we annotate it. Add a top-level `supervised?: boolean` flag on `TestReport` (set true when FSD(S) was invoked at any point). The failed-then-resumed step keeps its `failed` status in the list but gets an `fsdResumed: true` flag; overall `TestReport.status` derivation treats resumed-failed steps the same as before (any failed step = failed run) **unless** the resume path eventually completed — which is already the case since `failedSteps` count is based on `stepResults.filter(s => s.status === 'failed')`. We honor that: the resumed-failed step still counts as failed, and the overall status is `failed` — but the report UI can render "resolved via FSD" when it sees `fsdResumed` + later successes.

Decision: keep `overallStatus` computation as-is (any `failed` step ⇒ `failed`). Don't invent a `passed-supervised` enum; instead, downstream (report generator) can special-case `supervised && failedSteps === 1 && that step has fsdResumed` to render a "Resolved via FSD" badge. That keeps the report-schema change tiny.

### 5. Modify: `src/report/types.ts` — annotation fields

Add to `StepResult`:
```ts
/** True when this step's instruction was typed into the FSD(S) REPL rather than coming from the test file. */
fsdAdHoc?: boolean;
/** True when the failure on this step was the handoff point that dropped into FSD(S). */
fsdResumed?: boolean;
```

Add to `TestReport`:
```ts
/** True when the run entered FSD(S) REPL at any point. */
supervised?: boolean;
```

Report HTML changes are out of scope for this story — a follow-up can surface the annotations visually. For now it's enough that the JSON/metadata captures the intervention.

## Flick Step Semantics (REPL)

Each line of REPL input = one standalone Flick step. Implementation detail: we pass it through `executeStep()` with `stepCache: undefined` (no caching — REPL lines are not part of the test definition) and a synthetic `stepIndex` one past the end of `test.steps`. Conversation history is updated so that subsequent REPL steps and the resumed test steps both see the REPL activity.

## Implementation Order

1. Add config field + env parsing (`types.ts`, `defaults.ts`, `loader.ts`, `env/loader.ts`).
2. Add report annotation fields (`report/types.ts`).
3. Implement `fsd-repl.ts`.
4. Wire handoff + resume into `test-runner.ts`.
5. Tests.

## Verification

- `npm test` — existing suite stays green.
- New unit tests:
  - `parseBoolEnv` truthy/falsy values.
  - `runFsdRepl` via a test double that feeds scripted lines into the REPL and asserts:
    - `:exit` returns exit decision.
    - `:resume` + numeric input returns resume decision with correct index.
    - `:resume` + blank input returns default (failedStepIndex + 1).
    - Non-command input is routed to `executeStep` and result is appended to the ad-hoc results array.
    - Failed ad-hoc step does not re-trigger handoff.
  - Gating: test-runner does not enter REPL when `interactiveOnFailure=false`, when headless, or when non-TTY.
  - Resume path: when REPL returns `resume`, test-runner continues from the chosen index and merges step results correctly, with `supervised=true` on the final report and `fsdResumed` on the failed step.
- Manual smoke: point a test at a URL that will fail a step, set `INTERACTIVE_ON_FAILURE=true` in `.env`, confirm REPL drops in, type a step, `:screenshot`, `:resume`, confirm remaining steps execute and report reflects intervention.
