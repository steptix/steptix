# Step Into — implementation status

Status tracker for the step-into work. The full design lives in
[step-into-design.md](step-into-design.md); this file is the "where
are we?" snapshot.

**Last updated:** 2026-05-17 — Phases 1–4.1 done; Phase 5 (tool
step-into via Node inspector) pending.

## Where the work lives

All commits sit on a linear stack of feature branches off `main`.
**Nothing is on `main` yet.**

```
main (356547f, unchanged)
└─ feat/step-into-phase1-frames        → 56a9a40
   └─ feat/step-into-phase2-callstack  → 36e6d96   (Phase 2 + follow-up)
      └─ feat/step-into-phase2.1-cleanup       → bfcb53e
         └─ feat/step-into-phase3-stepmode     → 3484d86
            └─ feat/step-into-phase3.1-cleanup → 5b97d7b
               └─ feat/step-into-phase4-variables → c8f84f7
                  └─ feat/step-into-phase4.1-cleanup → 7d2edd0
                     └─ docs/step-into-status            ← this file
```

The chain is cherry-pick-clean. To land it, fast-forward `main` to
`7d2edd0` (or whatever the latest tip is) — or open one PR per phase
if you'd rather review them incrementally.

## Phase tracker

| Phase | Commit | Ships |
| --- | --- | --- |
| **1** — frames over the wire | `56a9a40` | `FrameInfo` type + `frame:push` / `frame:pop` / `frame:scope` events + optional `frame?` on step events. `skillsDir` / `testFilePath` on the request body. Server-side skill expansion (and **fixed a latent bug** where `[skill: ...]` from the extension previously went to the AI as a literal string — skills didn't actually work via the extension before this). |
| **2** — frame stack + Call Stack view | `6870c72` + `36e6d96` | Extension consumes frame events, multi-file status decorations (test file + skill `.md`), aggregate pass/fail on `[skill:]` lines, auto-reveal of skill files on descent, Call Stack TreeView in the activity-bar container. Tests + dead-code cleanup in the follow-up. |
| **2.1** — frame state hardening | `bfcb53e` | `markFrameFailed` walks ancestry via a persistent `frameParents` map so a late `step:fail` (after `frame:pop`) still propagates. Per-controller `revealedFrameUris`. `markAllRunningStopped` clears every URI on Stop. Steps-summary suppressed on non-test files. |
| **3** — Step Into / Over / Out | `3484d86` | `StepMode` type + `step:awaiting` event + `stepMode?` on the request body. Server pause-between-steps state machine with depth-aware decisions. New `POST /sessions/:id/run-control` endpoint. Extension commands stepInto / stepOver / stepOut / continueRun + F11 / F10 / Shift+F11 keybindings. **Fixed a Phase 1 gap** — the api-server's request validator was silently dropping `skillsDir` / `testFilePath` / `stepMode` from the JSON body, so Phase 1's wire-level work didn't reach the server until this commit. |
| **3.1** — step-pause polish | `5b97d7b` | Stop clears step-paused marker on its actual URI (not just the active editor). `sendRunControl` swallows `not-found` (409) silently. `dispatchStep` detects running-but-not-step-paused. Step Out at root frame redirects to Continue. End-to-end Step-Over-a-skill test. |
| **4** — Variables panel | `c8f84f7` | Server emits `frame:scope` after every `step:pass` / `step:fail`. `RunController.scopesByFrame` map + `currentScope()` accessor. New `VariablesTreeProvider` (flat scope, alphabetical, `maskIfSecret` for secret-named entries) registered alongside Call Stack. |
| **4.1** — Variables polish | `7d2edd0` | View title flips between "Variables (test)" / "Variables (skill: name)" via `createTreeView`. Test-frame view hides `__skill\d+_` skill-internal names (which the expander never garbage-collects after a skill exits). Render-path secret-mask test. STORIES doc: [variables-panel-scope-semantics.md](variables-panel-scope-semantics.md). |
| **5** — tool step-into | _pending_ | Attach VS Code's Node debugger to the running server process so the user can step into a `[tool: ...]` line's TypeScript source. |

## What works end-to-end right now

- Skill expansion when invoked via the extension (was broken before
  Phase 1).
- Frame stack visible in the Call Stack view; resizes / updates as
  the run descends.
- Status decorations follow frames across files: green/red icons land
  on the right line in the right `.md`.
- Aggregate pass / fail on the `[skill:]` line in the test file
  reflects the descent outcome.
- F11 (Step Into) from idle → starts a stepping run, pauses on the
  first step.
- F11 from step-paused → advances one step, descends into skills.
- F10 (Step Over) → skips a `[skill:]` invocation atomically.
- Shift+F11 (Step Out) → runs to end of current frame (Continue at
  root).
- F5 from step-paused → drains the rest of the run.
- Variables view updates after each step; secret-named entries are
  masked.

## What doesn't work yet

- **Tool step-into.** F11 on a `[tool: ...]` line still treats it as
  an atomic step. Phase 5 is the bridge to VS Code's Node debugger.
- **Skill-file breakpoints.** A breakpoint set inside a skill `.md`
  is read by the tracker but not honored — the extension's
  client-side `trimAtBreakpoint` only looks at the test file's
  breakpoints. Tracked for future work.
- **Per-frame scope filtering.** The Variables view's flat-scope
  model is documented in [variables-panel-scope-semantics.md](variables-panel-scope-semantics.md); a proper per-frame
  filter with reverse-rename resolution is the Phase 4.B follow-up.

## Test + version state

| | Value |
| --- | --- |
| testbench-native version | `0.5.10` (bumps per CLAUDE.md rule) |
| main `vitest` | 810 / 810 |
| testbench-native integration | 60 / 60 |
| runner-core `node:test` | 129 / 131 (2 pre-existing stale tests in `protocol.test.js`, unrelated to this work — they check renamed legacy message types `init` / `documentChanged` / `edit` that no longer exist) |

## Latent bugs surfaced + fixed along the way

Worth knowing about because they shape what tests exist now:

1. **Skills didn't work via the extension.** The server's
   `step-executor.ts` has zero `[skill: ...]` recognition; it sends
   raw text to the AI. The CLI flow ran `expandSkills` at parse time
   so the runner only ever saw flattened steps; the server flow had
   no equivalent. Pre-Phase-1, any `skill-demo.md` run from the
   extension shipped literal `[skill: ...]` strings to the LLM.
   Fixed by Phase 1's server-side expansion when `skillsDir` is
   supplied.

2. **The api-server was silently dropping Phase 1's new fields.**
   The request validator in `src/server/api-server.ts` only forwards
   fields it explicitly pulls. Phase 1 added `skillsDir` /
   `testFilePath` to `StepRequest` but didn't extend the validator,
   so the fields stayed `undefined` server-side. Phase 1's tests all
   called `expandSkills` directly or used a `FakeApiClient` that
   bypassed HTTP, so the gap was invisible. Fixed in Phase 3 along
   with the new `stepMode` field. Now covered by
   `tests/api-server-stepmode.test.ts`.

3. **Stop while step-paused on a skill file left a stale yellow ▶.**
   Stop handlers cleared `breakpointStop` only on the active editor's
   URI. A `step:awaiting` marker placed on a skill file's URI
   survived Stop. Fixed in Phase 3.1 via a new
   `clearAllStepPausedMarkers()` registry method.

Process takeaway baked into the test suite: any new field on
`StreamStepsRequest` needs at least one test that goes through the
actual HTTP route, not just the type definition or the underlying
function.

## Deferred follow-ups

  - **Phase 4.B** — proper per-frame scope filtering server-side
    with reverse-rename resolution. Replaces Phase 4.1's view-side
    `__skill\d+_` filter with real per-frame scopes the expander
    emits filtered + aliased.
  - **Skill-file breakpoints** — extension's `trimAtBreakpoint`
    needs to look at per-URI breakpoint sets (test file + every
    referenced skill `.md`).
  - **Conditional / hit-count breakpoints** — explicitly non-goal in
    the design doc; tracked here for completeness.
  - **F11-from-idle semantics** — the current behaviour executes the
    first step and pauses on the second. A "pre-step" pause point
    would match VS Code's debugger convention more closely.
  - **Pause-on-step-fail** — failures currently break the run; a
    real-debugger pattern would pause for inspection.
  - **Click-through navigation in the Call Stack view** — read-only
    today. Lands when frame navigation makes sense alongside Step
    Into commands in some later iteration.
  - **Variables view: copy-value affordance** — no "copy" right-
    click. Tooltip shows length only.

## Phase 5 preview — tool step-into

Tools are TypeScript code (`src/tools/*.ts`), not markdown — there's
no body to step through line-by-line. The only honest way to "step
into" a `[tool: ...]` line is to attach VS Code's Node.js debugger to
the running server process and pause inside the tool's `.ts` source.

Plan from the design doc:

1. User launches the server with `node --inspect=9229 ...` (we surface
   a clear error if not — for remote `SERVER_URL` we document that
   tool step-into is local-only).
2. F11 on a paused `[tool: ...]` line sends `stepMode.pauseAtNextTool`
   on the next run-control.
3. Server hits a `debugger;` at the tool dispatcher's call site
   ([src/tools/executor.ts](../../src/tools/executor.ts) line 164) and emits a new
   `tool:awaiting-debugger` event.
4. Extension calls `vscode.debug.startDebugging` with a Node attach
   config pointed at the inspector port.
5. The user gets VS Code's standard debugger UI inside the tool's
   `.ts`. When the Node session resumes past the tool's body, the
   testbench run continues.

New surface area: server's `inspector` integration, a new VS Code
setting for the inspector port (default 9229), a "tool is awaiting
debugger" UI state in the extension.

## Files to read if picking this up cold

If you're a future contributor or coming back to this in 6 weeks:

  - [step-into-design.md](step-into-design.md) — the original
    architecture + protocol design across all 3 packages.
  - [variables-panel-scope-semantics.md](variables-panel-scope-semantics.md)
    — current Variables view's contract + Phase 4.B plan.
  - Server step loop:
    [src/server/session-manager.ts](../../src/server/session-manager.ts)
    around the `executeStepsInternal` method — search for "stepMode"
    and "frameInfoFor".
  - Extension frame state:
    [run-controller.ts](../src/extension/run-controller.ts) — the
    `_frameStack` / `frameRoot` / `frameParents` / `failedFrames` /
    `scopesByFrame` cluster.
  - Status routing:
    [extension.ts](../src/extension/extension.ts) — `applyToTracker`
    is the single choke point for incoming SSE events.
  - The two views:
    [call-stack-view.ts](../src/extension/call-stack-view.ts) and
    [variables-view.ts](../src/extension/variables-view.ts).
  - Wire protocol:
    [runner-core/src/protocol.ts](../../runner-core/src/protocol.ts) — the
    `RunEvent` union and `FrameInfo` type are the contract.
