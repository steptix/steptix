# Unified Interactive REPL

Supersedes: `stories/full-self-driving-supervised.md`.

## Context

Two REPLs do almost the same thing today:

- **`[interactive]` step REPL** — opened when control reaches an `[interactive]` marker in a test. Inline loop in [`src/runner/test-runner.ts`](../src/runner/test-runner.ts). User types Flick steps; `done` / blank → next step; `exit` / `quit` → bail.
- **FSD(Supervised) REPL** — opened when a step fails after retries (gated by `INTERACTIVE_ON_FAILURE=true`, headed, TTY). Module [`src/runner/fsd-repl.ts`](../src/runner/fsd-repl.ts). User types Flick steps; `:resume` jumps to a chosen step; `:screenshot` captures into the report; `:exit` / `:quit` bail.

Three differences:

1. FSD has `:resume <n>` (jump to any step). Interactive only continues to the next step.
2. FSD has `:screenshot` (capture into report on demand).
3. FSD is failure-triggered + gated; interactive is marker-triggered + unconditional.

Everything else — typing a line and routing it through `executeStep`, conversation-history tracking, live-page targeting, exit-aborts-the-run — is duplicated. The runner-core REPL ([`runner-core/src/repl.ts`](../runner-core/src/repl.ts)) used by the Steptix extension is a third copy with yet another command vocabulary.

## Goal

One REPL module behind two entry points (planned `[interactive]` step and post-failure handoff). Both gain the union of features. Standardise command vocabulary on `/`-prefixed slash commands across CLI and runner-core.

## Command surface (canonical)

| Command         | Effect                                                   |
| --------------- | -------------------------------------------------------- |
| `/continue`     | Leave REPL, run the next step in the flattened list.     |
| `/resume`       | Open menu, pick any step to jump to (default = next).    |
| `/screenshot`   | Capture current page, attach to the report.              |
| `/list`         | Print numbered step list with current/failed marker.     |
| `/help`         | Show command list.                                       |
| `/exit`         | Abort the entire run.                                    |
| `/quit`         | Alias for `/exit`.                                       |
| *(bare text)*   | Execute as one ad-hoc Flick step against the live page.  |
| *(blank line)*  | No-op (reprompt).                                        |

Detection rule: an input is parsed as a command **only if** the first whitespace-delimited token is one of the known `/`-prefixed names. Otherwise it falls through as an ad-hoc Flick step. This protects users typing instructions that begin with a path (e.g. `/admin/users page should load` is a Flick step, not an unknown command).

Removed: the bare-word `done` / `exit` / `quit` aliases. Typing `done` now prints a one-line hint pointing at `/continue`. Typing `:continue` (the previous design's prefix) prints a hint pointing at `/continue`.

## Module: `src/runner/interactive-repl.ts`

Replaces `src/runner/fsd-repl.ts` (deleted).

```ts
export type InteractiveDecision =
  | { kind: 'continue' }                          // /continue → run next step
  | { kind: 'resume'; fromStepIndex: number }     // /resume → jump
  | { kind: 'exit' };                             // /exit | /quit → bail

export interface InteractiveReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface InteractiveReplContext {
  page: Page;
  testSteps: string[];
  /** 1-based. Planned-entry: the [interactive] step's index.
   *  Failure-entry: the failed step's index. Used for /list marker
   *  and /resume default. */
  currentStepIndex: number;
  /** Drives banner text and conversation-history phrasing.
   *  'planned' = entered via [interactive] marker.
   *  'failure' = entered via post-failure handoff. */
  entryReason: 'planned' | 'failure';
  /** Optional hint shown in the planned-entry banner (`[interactive] <hint>`). */
  hint?: string;
  executorOptions: StepExecutorOptions;
  /** Accumulator for ad-hoc StepResults produced inside the REPL. */
  adHocResults: StepResult[];
  /** Optional custom reader (defaults to readline against stdin/stdout). */
  reader?: InteractiveReader;
}

export async function runInteractiveRepl(
  ctx: InteractiveReplContext,
): Promise<InteractiveDecision>;
```

Behavior delta vs current `runFsdRepl`:

- New `/continue` decision (today FSD only has `/resume` and `/exit`).
- Banner text branches on `entryReason`:
  - `planned` → `🎮 Interactive mode (hint). Type /help for commands, /continue to advance.`
  - `failure` → `🛑 Step failed. Dropping into interactive REPL. Type /help for commands.`
- `/resume` default index = `currentStepIndex + 1`, capped at `testSteps.length`.
- Ad-hoc step results all get `interactiveAdHoc: true` (renamed from `fsdAdHoc`).
- Screenshot synthetic instruction = `[interactive: screenshot]` (was `[fsd: screenshot]`).

## Wiring in `src/runner/test-runner.ts`

### Planned `[interactive]` branch

Replace the inline REPL loop ([test-runner.ts:384-460](../src/runner/test-runner.ts#L384-L460)) with a call to `runInteractiveRepl({ entryReason: 'planned', currentStepIndex: i + 1, hint, ... })`. Decision handling:

- `{ kind: 'continue' }` → fall through to `i++` (today's `done` behavior).
- `{ kind: 'resume', fromStepIndex }` → set `i = fromStepIndex - 2` and `continue`. Mark this step's StepResult with `interactiveResumed: true`. Refresh `timeoutDeadline` so debugging time isn't billed against the test.
- `{ kind: 'exit' }` → set `bail = true`.

### Failure-handoff branch

Swap `runFsdRepl(...)` for `runInteractiveRepl({ entryReason: 'failure', currentStepIndex: i + 1, ... })` ([test-runner.ts:519-578](../src/runner/test-runner.ts#L519-L578)). Decisions:

- `{ kind: 'continue' }` (new — wasn't possible from FSD) → don't reset `i`, don't `bail`. Outer loop proceeds to the next step. Meaningful new option: "leave the failed step as failed but keep going."
- `{ kind: 'resume', fromStepIndex }` → today's resume path; mark `interactiveResumed`.
- `{ kind: 'exit' }` → `bail = true`.

Local `supervised` flag → `humanIntervened`.

## Phase 2: `/repl` escape hatch from AI clarification prompts

Today, when the AI returns a `prompt` action ([step-executor.ts:525-551](../src/runner/step-executor.ts#L525-L551)), the executor opens a one-shot `readline` via `promptUser(question)` ([step-executor.ts:1603](../src/runner/step-executor.ts#L1603)) and the user has exactly one option: type an answer. There's no way to bail out, jump elsewhere, or take a screenshot — the only escape today is Ctrl-C, which kills the whole process.

This phase adds `/repl` as an in-prompt escape hatch.

### New `entryReason: 'clarification'`

Extend `InteractiveReplContext`:

```ts
entryReason: 'planned' | 'failure' | 'clarification';
/** Only set when entryReason === 'clarification'. The AI's question. */
clarificationQuestion?: string;
```

Banner text for the new entry reason:

```
🤔 AI asked a clarifying question:
   <question>
   Type /help for commands, /continue to skip the question, /resume to jump elsewhere, /exit to abort.
```

`/resume` default index is `currentStepIndex + 1` as in the other entry reasons. `/screenshot` and ad-hoc Flick steps work the same.

### Decision semantics in clarification context

`runInteractiveRepl` already returns one of `continue` / `resume` / `exit`. The clarification call site needs to translate each into a usable behavior:

- `/continue` → option (a) per design discussion: pass an **empty-string answer** back to the AI through `buildClarificationMessage`. The AI re-decides without forcing the user to give a real answer. Equivalent to today's `promptOnAmbiguity: false` for that one prompt.
- `/resume <n>` → bubble the requested step index back up to the test-runner so it can jump.
- `/exit` → fail the current step (`error: 'user exited from clarification REPL'`) and bubble up so the runner bails.

### Wrapper: `promptUserWithReplEscape`

Replace the bare `promptUser(question)` call at [step-executor.ts:528](src/runner/step-executor.ts#L528) with a thin wrapper:

```ts
type ClarificationOutcome =
  | { kind: 'answer'; text: string }                       // user gave an answer (incl. empty for /continue)
  | { kind: 'resume'; fromStepIndex: number }              // user typed /resume <n>
  | { kind: 'exit' };                                      // user typed /exit

async function promptUserWithReplEscape(
  question: string,
  replContext: Omit<InteractiveReplContext, 'entryReason' | 'clarificationQuestion'>,
): Promise<ClarificationOutcome>;
```

Implementation: open a single readline that shows the question + the `/repl` hint. The prompt accepts exactly two kinds of input:

- `/repl` (case-insensitive, exact match after trim) → hand off to `runInteractiveRepl({ entryReason: 'clarification', clarificationQuestion: question, ... })`.
- Anything else → treat as the literal answer text and pass to `buildClarificationMessage`.

No other slash commands are recognised at the prompt itself. Rationale: the clarification prompt is conceptually "the AI is waiting for your answer." Mixing commands at that level blurs what kind of input the system expects, and would prevent a user from literally answering `/exit` if that ever made sense. The two-keystroke cost of `/repl` → `/exit` is negligible compared to the clarity gain.

Once inside the REPL, `runInteractiveRepl` returns the usual `InteractiveDecision`, which the wrapper translates:

| REPL decision     | ClarificationOutcome                              |
| ----------------- | ------------------------------------------------- |
| `continue`        | `{ kind: 'answer', text: '' }`                    |
| `resume n`        | `{ kind: 'resume', fromStepIndex: n }`            |
| `exit`            | `{ kind: 'exit' }`                                |

### Bubbling `resume` / `exit` out of `executeStep`

The runner currently can't be told "jump to step N" or "the user already chose to abort, don't re-prompt" from inside `executeStep`. Add a discriminated control field on `StepResult`:

```ts
/** Set when the user took control inside the clarification REPL. The
 *  test-runner reads this BEFORE the regular failure-handoff path, so a
 *  /exit from the clarification REPL doesn't re-trigger the failure REPL. */
runnerControl?:
  | { kind: 'resume'; fromStepIndex: number }
  | { kind: 'exit' };
```

In `executeStep`:

- `ClarificationOutcome.answer` → today's flow: build clarification message, re-call AI, continue.
- `ClarificationOutcome.resume` → return early from `executeStep` with `status: 'passed'`, `aiExplanation: 'User resumed from clarification REPL'`, `interactiveResumed: true`, and `runnerControl: { kind: 'resume', fromStepIndex }`.
- `ClarificationOutcome.exit` → return early with `status: 'failed'`, `error: 'user exited from clarification REPL'`, and `runnerControl: { kind: 'exit' }`.

In the test-runner step loop, after `stepResult` comes back from `executeStep` and **before** the existing `if (stepResult.status === 'failed')` block at [test-runner.ts:516](src/runner/test-runner.ts#L516):

```ts
if (stepResult.runnerControl?.kind === 'exit') {
  // User /exited from the clarification REPL. Don't drop them into the
  // failure-handoff REPL on top — they already chose to abort.
  humanIntervened = true;
  stepResults.push(stepResult);
  bail = true;
  continue;
}
if (stepResult.runnerControl?.kind === 'resume') {
  humanIntervened = true;
  stepResults.push(stepResult);
  // history push + timeout refresh as in the other resume paths
  i = stepResult.runnerControl.fromStepIndex - 2;
  tokenTracker.resetStep();
  continue;
}
```

Both branches short-circuit the normal failure-handoff path. Without the `exit` sentinel the user's `/exit` would set `status: 'failed'`, which the existing failure path would then turn into another `runInteractiveRepl({ entryReason: 'failure', ... })` call — a double-prompt loop where `/exit` apparently does nothing until the user types it twice. The sentinel makes the user's first `/exit` final.

Same shape as the existing planned-interactive and failure-handoff resume paths, just triggered from a different source.

### Gating

Same gating as today's clarification prompt: `config.execution.promptOnAmbiguity`. When false, the wrapper is bypassed and the `prompt` action is silently filtered as today. No new config knob.

The `/repl` escape hatch is always available within the clarification prompt when it does fire — no separate flag. Rationale: if a user can answer the question, they can also choose not to.

### Tests

- New unit tests for `promptUserWithReplEscape`:
  - Plain answer text is returned as `{ kind: 'answer', text }`.
  - Text that *starts with* a slash but isn't `/repl` (e.g. `/admin/users`) is returned verbatim as the answer — not interpreted as a command.
  - `/repl` then `/exit` returns `{ kind: 'exit' }`.
  - `/repl` then `/continue` returns `{ kind: 'answer', text: '' }`.
  - `/repl` then `/resume <n>` returns `{ kind: 'resume', fromStepIndex: n }`.
  - `/repl` then ad-hoc step then `/continue` returns `{ kind: 'answer', text: '' }` (and the ad-hoc step result was appended).
- New `runInteractiveRepl` test: `entryReason: 'clarification'` banner includes the question.
- Integration tests in test-runner that mock `executeStep` to return:
  - `runnerControl.resume` → assert the loop jumps to the chosen index and skips the failure-handoff path.
  - `runnerControl.exit` with `status: 'failed'` → assert the loop bails immediately and does **not** call `runInteractiveRepl` a second time (re-entry guard).

### Out of scope (still)

- Generic "drop into REPL anytime" via signal/keybinding — would need stdin multiplexing or a second TTY. Separate story if desired.
- Steptix wiring of clarification REPL — the clarification prompt is CLI-only today (uses readline against stdin). The steptix would need a new prompt mode (`mode: 'clarification'`) and the same UI affordances; defer to a follow-up.

## Annotation rename in `src/report/types.ts`

```ts
// before                    →  after
fsdAdHoc?: boolean;          →  interactiveAdHoc?: boolean;
fsdResumed?: boolean;        →  interactiveResumed?: boolean;
supervised?: boolean;        →  humanIntervened?: boolean;
```

Breaking JSON schema change. Update every reader:

- [`src/report/generator.ts`](../src/report/generator.ts) — `buildScriptText` strips `(fsd)` prefix; rename to `(interactive)` (and accept both for back-compat one release).
- [`src/report/template.ts`](../src/report/template.ts) — class names / badge logic if it references the old fields. (Spot-check only — no current visual surface for these flags beyond the script-text strip.)

History-file (`.runs/`) read-side: accept either old or new key on read for one release. Write-side uses new names only.

## runner-core / steptix REPL

Update [`runner-core/src/repl.ts`](../runner-core/src/repl.ts) `interpretReplCommand` to match the new vocabulary:

- Drop `done` / `exit` / `:exit` → `exit-section` mapping.
- `/continue` → `exit-section`.
- `/exit` / `/quit` → `quit-run`.
- `/resume` → new action `{ kind: 'resume' }` (controller handles step-number prompt).
- `/screenshot` → new action `{ kind: 'screenshot' }`.
- `/list` and `/help` already there; bodies updated to match new vocabulary.

Steptix's [`run-controller.ts`](../steptix/src/extension/run-controller.ts) gains handlers for `'resume'` and `'screenshot'` actions. `/resume` against top-level steps works fine; `/resume` from an `[interactive]` *inside* a skill body has the classifier-doesn't-expand-skills limitation noted as a follow-up — out of scope here.

## Tests

- Move `tests/fsd-repl.test.ts` → `tests/interactive-repl.test.ts`. Each existing test ports with renamed imports/types; `fsdAdHoc` assertions become `interactiveAdHoc`.
- New tests:
  - `/continue` returns `{ kind: 'continue' }` from both `entryReason: 'planned'` and `'failure'`.
  - `/resume` default index = `currentStepIndex + 1` regardless of entryReason.
  - Banner text differs by `entryReason` (assert via captured writes).
  - Bare text whose first token *looks like* a path (`/admin/users …`) is treated as a Flick step, not an unknown command.
  - Bare-word `done` prints the deprecation hint and stays in the REPL.
- runner-core: extend [`tests/repl.test.js`](../runner-core/tests/repl.test.js) for the new vocabulary.

## Docs to update

- [SPEC.md](../docs/specs/SPEC.md) — `[interactive]` section (new commands, drop `done`/blank semantics).
- [SPEC-UI.md](../docs/specs/SPEC-UI.md) — interactive step description.
- [SPEC-SESSIONS-API.md](../docs/specs/SPEC-SESSIONS-API.md) — still skipped server-side, no change.
- [README.md](../README.md) — `[interactive]` cheat-sheet.
- [stories/full-self-driving-supervised.md](full-self-driving-supervised.md) — mark superseded by this story.
- [steptix/stories/interactive-input-and-fsd.md](../steptix/stories/interactive-input-and-fsd.md) — REPL command list.

## Sequencing

**Phase 1 — unified REPL (planned + failure-handoff)**

1. New module `interactive-repl.ts` + new tests (parallel to FSD; build stays green).
2. Rename annotation fields in `report/types.ts` + update generator/template/history readers.
3. Rewire test-runner failure path; delete `fsd-repl.ts`; move/rename its tests.
4. Rewire test-runner planned `[interactive]` path.
5. Update runner-core `repl.ts` + steptix controller.
6. Docs sweep.

**Phase 2 — `/repl` escape hatch from AI clarification prompts**

7. Extend `InteractiveReplContext` with `entryReason: 'clarification'` + `clarificationQuestion`. Add the new banner. Tests for the new banner.
8. Add `runnerControl?: { kind: 'resume'; fromStepIndex: number } | { kind: 'exit' }` to `StepResult` in `report/types.ts`.
9. Add `promptUserWithReplEscape` wrapper alongside `promptUser` in `step-executor.ts`. Unit tests.
10. Replace the `promptUser(...)` call site with `promptUserWithReplEscape(...)`. Translate `ClarificationOutcome` to either the existing clarification round-trip (answer) or an early return with `runnerControl` / `error` (resume / exit).
11. Test-runner: handle both `runnerControl` variants (`resume` jumps, `exit` bails) before the existing `if (stepResult.status === 'failed')` block, so a `/exit` from the clarification REPL doesn't re-trigger the failure-handoff REPL on top.
12. Doc updates: SPEC.md "AI clarification" section, README cheat-sheet adds `/repl` mention.

## Out of scope

- Skill-body `[interactive]` visibility from the Steptix classifier (separate issue: Steptix needs to expand skills before classifying).
- Sessions API support for `[interactive]` (still silently skipped server-side; orthogonal).
- Report HTML redesign for the new annotations (existing badge logic just gets renamed fields).
