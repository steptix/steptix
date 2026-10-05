# Step Into — implementation status

Status tracker for the step-into work. The full design lives in
[step-into-design.md](step-into-design.md); this file is the "where
are we?" snapshot.

**Last updated:** 2026-05-17 — Phases 1–4.1 done. Phase 5 split into
**5.A** (server-side tool dispatch — the gap discovered before the
debugger work could begin) and **5.B** (tool step-into proper) — both
landed.

## Where the work lives

All commits sit on a linear stack of feature branches off `main`.
**Nothing is on `main` yet.**

```
main (05df0a6, unchanged)
└─ feat/step-into-phase1-frames        → f9ba24c
   └─ feat/step-into-phase2-callstack  → ffec982   (Phase 2 + follow-up)
      └─ feat/step-into-phase2.1-cleanup        → ce8df97
         └─ feat/step-into-phase3-stepmode      → 0df374e
            └─ feat/step-into-phase3.1-cleanup  → 5b15690
               └─ feat/step-into-phase4-variables   → 7fed755
                  └─ feat/step-into-phase4.1-cleanup  → bfeb529
                     └─ docs/step-into-status          → d38c9d3
                        └─ feat/step-into-phase5-tool-debugger ← this file
                           (5.A → baa2a93, 5.B → HEAD)
```

The chain is cherry-pick-clean. To land it, fast-forward `main` to the
latest tip — or open one PR per phase if you'd rather review them
incrementally.

## Phase tracker

| Phase | Commit | Ships |
| --- | --- | --- |
| **1** — frames over the wire | `f9ba24c` | `FrameInfo` type + `frame:push` / `frame:pop` / `frame:scope` events + optional `frame?` on step events. `skillsDir` / `testFilePath` on the request body. Server-side skill expansion (and **fixed a latent bug** where `[skill: ...]` from the extension previously went to the AI as a literal string — skills didn't actually work via the extension before this). |
| **2** — frame stack + Call Stack view | `b8a6e78` + `ffec982` | Extension consumes frame events, multi-file status decorations (test file + skill `.md`), aggregate pass/fail on `[skill:]` lines, auto-reveal of skill files on descent, Call Stack TreeView in the activity-bar container. Tests + dead-code cleanup in the follow-up. |
| **2.1** — frame state hardening | `ce8df97` | `markFrameFailed` walks ancestry via a persistent `frameParents` map so a late `step:fail` (after `frame:pop`) still propagates. Per-controller `revealedFrameUris`. `markAllRunningStopped` clears every URI on Stop. Steps-summary suppressed on non-test files. |
| **3** — Step Into / Over / Out | `0df374e` | `StepMode` type + `step:awaiting` event + `stepMode?` on the request body. Server pause-between-steps state machine with depth-aware decisions. New `POST /sessions/:id/run-control` endpoint. Extension commands stepInto / stepOver / stepOut / continueRun + F11 / F10 / Shift+F11 keybindings. **Fixed a Phase 1 gap** — the api-server's request validator was silently dropping `skillsDir` / `testFilePath` / `stepMode` from the JSON body, so Phase 1's wire-level work didn't reach the server until this commit. |
| **3.1** — step-pause polish | `5b15690` | Stop clears step-paused marker on its actual URI (not just the active editor). `sendRunControl` swallows `not-found` (409) silently. `dispatchStep` detects running-but-not-step-paused. Step Out at root frame redirects to Continue. End-to-end Step-Over-a-skill test. |
| **4** — Variables panel | `7fed755` | Server emits `frame:scope` after every `step:pass` / `step:fail`. `RunController.scopesByFrame` map + `currentScope()` accessor. New `VariablesTreeProvider` (flat scope, alphabetical, `maskIfSecret` for secret-named entries) registered alongside Call Stack. |
| **4.1** — Variables polish | `bfeb529` | View title flips between "Variables (test)" / "Variables (skill: name)" via `createTreeView`. Test-frame view hides `__skill\d+_` skill-internal names (which the expander never garbage-collects after a skill exits). Render-path secret-mask test. STORIES doc: [variables-panel-scope-semantics.md](variables-panel-scope-semantics.md). |
| **5.A** — server-side tool dispatch | `baa2a93` | `toolsDir` request field; `session-manager.executeStepsInternal` parses `[tool: ...]` lines via `parseToolCall` and dispatches through `executeToolStep` with the session's live `page` / `context` / `browser`. Tool outputs surface as `capture` SSE events. **Discovered + fixed a latent gap**: tools previously didn't work via the extension at all — `[tool: ...]` reached the AI as plain text because the server's step loop had no tool-call recognition. Same shape as Phase 1's skill gap. New test file `tests/api-server-tools.test.ts`. |
| **5.B** — tool step-into | HEAD | Wire-level pieces: `tool:awaiting-debugger` event + `pauseAtNextTool` flag (on initial request body AND `run-control` body) + `POST /sessions/:id/tool-debugger-ack` endpoint. Server emits the event before the next `[tool: ...]` step and parks on a per-session debugger-ack Promise; resumes on ack and hits a cooperative `debugger;` statement which Node's V8 inspector traps. Extension: F11 on a tool line detects the invocation and sends `pauseAtNextTool: true`; the `tool:awaiting-debugger` handler calls `vscode.debug.startDebugging` with a `pwa-node` attach config (settings: `steptix.inspectorPort` / `inspectorHost`); fails gracefully with ack-and-exit when the server isn't local or the inspector isn't reachable. |

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
- `[tool: ...]` invocations dispatch through real TypeScript code on
  the server (was a no-op via the extension before 5.A).
- F11 on a `[tool: ...]` line emits `tool:awaiting-debugger`; VS Code's
  Node debugger attaches (when the server was launched with
  `--inspect=9229`) and the user lands inside the tool's `.ts` source.

## What doesn't work yet

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
| steptix-vscode version | `0.5.13` (bumps per CLAUDE.md rule) |
| main `vitest` | 819 / 819 |
| steptix-vscode integration | 62 / 62 |
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

4. **Tools didn't work via the extension at all.** Mirror of bug #1.
   `[tool: ...]` lines in a session-manager request reached the AI
   as plain text — there was no tool-call recognition in the server's
   step loop. The CLI's `test-runner.ts` did dispatch tools (via
   `executeToolStep`) but the server-flow path didn't. The design doc
   for Phase 5 had assumed the server already executed tools; the gap
   was caught when tracing the would-be `debugger;` pause point.
   Fixed in Phase 5.A by wiring `parseToolCall` + `executeToolStep`
   into `executeStepsInternal`, gated on a new `toolsDir` request
   field (parallel to `skillsDir`). Covered by
   `tests/api-server-tools.test.ts`.

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

## Phase 5 — tool step-into (shipped)

Tools are TypeScript code (`src/tools/*.ts`), not markdown — there's
no body to step through line-by-line. The honest way to "step into" a
`[tool: ...]` line is to attach VS Code's Node.js debugger to the
running server process and pause inside the tool's `.ts` source.

How it works end-to-end:

1. User launches the server with `node --inspect=9229 dist/server.js`
   (or matches `steptix.inspectorPort` to whatever port they
   chose).
2. F11 on a paused `[tool: ...]` line. The extension detects the tool
   invocation via line-text regex and POSTs `run-control` with
   `pauseAtNextTool: true` (or seeds the same flag on the initial
   request body when the pause came from a breakpoint instead of
   `step:awaiting`).
3. Server reaches the next `[tool: ...]` step, emits
   `tool:awaiting-debugger { toolName, toolFilePath, line, frame? }`
   and parks on `pendingDebuggerAck`.
4. Extension's event handler verifies the run targets `127.0.0.1`,
   calls `vscode.debug.startDebugging` with a `pwa-node` attach
   config (`{ address, port, sourceMaps: true }`), then POSTs
   `/sessions/:id/tool-debugger-ack`.
5. Server resumes, hits the cooperative `debugger;` statement, and
   the V8 inspector traps execution. The user gets VS Code's standard
   debugger UI inside the tool's `.ts`.

When the local-server check fails or the attach hangs/fails, the
extension takes an "ack-and-exit" branch: the run still proceeds (the
tool just executes without a debugger attached) and a status-bar note
tells the user what went wrong.

Files added:
  - `runner-core/src/protocol.ts` — `ToolAwaitingDebuggerEvent` +
    `RunEvent` union extension.
  - `runner-core/src/api-client.ts` — `pauseAtNextTool` on
    `StreamStepsRequest`, `runControl(..., { pauseAtNextTool })`,
    new `ackToolDebugger()` method.
  - `src/server/session-manager.ts` — `pauseAtNextTool` request
    field, `pendingDebuggerAck` per-session resolver, dispatcher
    pause point in the tool branch.
  - `src/server/api-server.ts` — `pauseAtNextTool` on run-control body,
    new `POST /sessions/:id/tool-debugger-ack` endpoint.
  - `steptix-vscode/src/extension/run-controller.ts` —
    `isLocalServer()`, `ackToolDebugger()`, plumbing
    `pauseAtNextTool` into the run-control + initial request body.
  - `steptix-vscode/src/extension/commands/index.ts` —
    `isAtToolLine()` helper; F11-on-tool-line dispatch in both the
    step-paused and breakpoint-paused branches.
  - `steptix-vscode/src/extension/extension.ts` —
    `handleToolAwaitingDebugger()` (local-server check + attach +
    ack), `stepPausedEntry()` registry exposure for the dispatcher.
  - `steptix-vscode/package.json` —
    `steptix.inspectorPort` (default 9229) and
    `inspectorHost` (default 127.0.0.1) settings.
  - `tests/api-server-tools.test.ts` — server-side end-to-end of
    tool dispatch + `pauseAtNextTool` + ack flow (7 cases).
  - `steptix-vscode/tests/integration/suite/tool-debugger.test.cjs`
    — extension dispatch on F11-on-tool-line (2 cases; the full
    debugger-attach path can't be exercised in the test harness so
    that one is covered server-side only).

What's still rough:
  - The "tool is awaiting debugger" UI is a status-bar string, not a
    dedicated overlay panel.
  - Source-map fidelity for tools depends on the user's `tsc` config;
    if `inlineSources` isn't set the debugger pauses on the compiled
    JS instead of the `.ts`. Documented in the design doc, not
    enforced by the extension.
  - The cooperative `debugger;` is a hard pause in the runtime; if
    the user doesn't have an inspector listening, nothing surfaces
    (it's a no-op). The local-server check + clear status-bar message
    are the user's only signal.

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
