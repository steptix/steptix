# 021 — A stopped run's report isn't delivered to the client, can't be opened, and doesn't mark the abort

**Status:** ✅ resolved 2026-06-02 — implemented per the revised plan; reviewed (4-lens plan workflow + final correctness pass, no must-fix); root suite 996 green, runner-core 145, testbench-native integration suite 108 (incl. 3 new stop tests), both extensions bumped + built. Live `stop-report.test.cjs` added (run manually).

## Resolution (2026-06-02)

All four gaps fixed via the revised plan below.
- **Delivery (Gap 1):** server records a manager-level `lastRunInfo` map (survives
  session deletion) with a frozen token snapshot + reportPath + `finalized`,
  served by new `GET /sessions/:id/last-run`. runner-core gains `getLastRun()`.
  testbench-native polls it **on STOP only** (gated `!pauseRequested`, locals
  captured before the finally, background/fire-and-forget so `isRunning` flips
  promptly, generation-guarded against a newer run, injectable backoff, ~12s
  ceiling, poll-until-finalized).
- **Content (Gaps 2+3):** `TestReport.aborted` + `StepResult.interrupted`
  (additive, `StepStatus` un-widened); an interrupted StepResult recorded in the
  3 mid-step abort handlers + the branched throw-catch (never the loop-top check),
  which also makes a step-1 stop produce a report (Gap 3). `generator.ts` renders
  an amber ABORTED banner + interrupted-step state; `failedSteps` excludes it.
- **Tokens (Gap 4):** recording was already correct; delivered as a frozen
  snapshot via `getLastRun` (never recomputed live). A cancelled in-flight call
  records nothing (documented contract).
- **Build:** root `dist/` rebuilt; `testbench-native` 0.5.51→0.5.52 (VSIX
  packaged), `testbench-monaco` 0.1.55→0.1.56 (both bump because runner-core, a
  bundled `file:` dep, changed — per CLAUDE.md).

Known cosmetic follow-ups (non-blocking): the summary bar doesn't add an
"interrupted" stat (banner contextualizes it); `lastRunTokens` is populated only
on the stop path (normal runs show tokens in the report).

---
<details><summary>Plan (implemented)</summary>

**Status:** 🟡 open — diagnosed (4 gaps); plan reviewed (4-lens workflow + self-verified against code); **revised plan below supersedes the original sketch**; ready to implement

## Review outcome → revised plan (2026-06-02, authoritative)

A 4-perspective adversarial workflow reviewed the original sketch; I verified the
load-bearing claims against the code. The diagnosis (all 4 gaps) and direction
hold, but the original Layer-A plumbing was factually wrong (would silently
no-op) and the delivery race was under-specified. **Implement per the revisions
below, not the original sketch.** Verified facts driving the change:
- `getSession` builds a hand-rolled return literal (no session spread) and runs
  `page.title()` + a screenshot on every call ([session-manager.ts:799-807, 778-782](../src/server/session-manager.ts#L799)).
- `runner-core` has **no** `getSession` — only `isSessionAlive`, which discards
  the body and returns a bool ([api-client.ts:286-302](../runner-core/src/api-client.ts#L286)).
- The loop's `finally` restores `status='active'` **before** the report block
  runs ([session-manager.ts:2396](../src/server/session-manager.ts#L2396) vs
  [2429](../src/server/session-manager.ts#L2429)); `lastReportPath` is written
  after `generateReport`'s disk I/O — concurrent with the client's abort.
- A browser-closing stop deletes the session ([2389-2393](../src/server/session-manager.ts#L2389))
  **before** the report block, so `getSession` would 404.
- Report status visuals come from `renderReport`/`renderStep` in
  **generator.ts** ([50-53](../src/report/generator.ts#L50)), not template.ts.

### Revised Layer A — dedicated endpoint + manager-level run-info map (Gaps 1 + 4.1)
Do **not** thread through `getSession` (no-spread literal, screenshot cost, 404s
on closed sessions). Instead:
1. **Server — a manager-level `lastRunInfo: Map<sessionId, { reportPath?: string;
   tokens: { total; input; output }; finalized: boolean }>`** (survives session
   deletion). In the report block ([~2452-2464](../src/server/session-manager.ts#L2452)):
   capture a **frozen** token snapshot at the point the report reads the totals,
   set `finalized: true` + `tokens` always, and `reportPath` only if
   `generateReport` succeeded (on the catch at 2461, leave `reportPath` unset so
   the poll terminates cleanly without a stale path). Write this entry
   **regardless of session liveness** (so a browser-closing stop still delivers).
2. **`GET /sessions/:id/last-run`** ([api-server.ts](../src/server/api-server.ts#L368)
   neighbourhood) → returns the map entry, or `{ finalized: false }` when absent.
   Cheap (no screenshot/title), so polling it is fast. Backward-compatible (new
   route; old server → 404 → client falls back).
3. **runner-core api-client — NEW `getLastRun(sessionId)`** method (not a tweak to
   `isSessionAlive`): GET the new route, mirror `isSessionAlive`'s
   401/connect-failed taxonomy, parse defensively (`await res.json().catch(()=>({}))`),
   return `{ reportPath?, tokens?, finalized } | null` (null on 404). Add optional
   `getLastRun?` to the `ApiClientLike` interface ([run-controller.ts:43-49](../testbench-native/src/extension/run-controller.ts#L43)).
4. **testbench-native — poll on STOP only.** In the user-abort branch
   ([run-controller.ts:1100-1115](../testbench-native/src/extension/run-controller.ts#L1100)):
   gate on `if (!this.pauseRequested)` (line 1113 is reachable on a pause edge
   case when `resumeLine == null` — must not poll on pause). **Capture
   `this.currentClient`/`this.currentSessionId`/`this.currentServerUrl` into locals
   BEFORE any await** (the `finally` nulls them at [1126-1127](../testbench-native/src/extension/run-controller.ts#L1126)),
   guard `typeof c.getLastRun === 'function'`, then `await` a **poll-until-finalized**
   helper (injectable backoff for deterministic tests; safety ceiling ~10-15s, not
   a blind 2s — `generateReport` writes HTML + copies screenshots and can exceed
   2s). On success set `this.lastResolvedReportPath` and surface the token totals.

### Revised Layer B — aborted state + interrupted step (Gaps 2 + 3)
1. **types** — `TestReport.aborted?: boolean`, `StepResult.interrupted?: boolean`
   (both optional; keep `StepStatus` un-widened).
2. **session-manager** — push an interrupted `StepResult` in **exactly the three
   mid-step handlers**: post-branch ([1764](../src/server/session-manager.ts#L1764),
   use the branch continuation index, not `i+1`), per-step catch
   ([2090](../src/server/session-manager.ts#L2090), `index: i+1`), and post-step
   ([2152](../src/server/session-manager.ts#L2152), reuse the existing `stepResult`
   spread like the normal push at [2219](../src/server/session-manager.ts#L2219),
   set `interrupted: true`). **Do NOT** push at the loop-top between-step check
   ([1671](../src/server/session-manager.ts#L1671)) — no step is in flight there
   (would record a phantom step). This also makes `fullStepResults.length > 0` on
   a step-1 stop → **fixes Gap 3**. No `step:fail` emit (keep 020's contract).
3. **counts** — keep the interrupted step **out of** `failedSteps`
   ([2434-2435](../src/server/session-manager.ts#L2434)); add an `interruptedSteps`
   count (or reconcile totals explicitly). Invariant: passed+failed+skipped+
   interrupted == rendered rows. Set `report.aborted` when
   `overallStatus === 'aborted'`; keep `report.status` a valid `StepStatus`.
4. **generator.ts** (not template.ts) — `renderReport` ([47-94](../src/report/generator.ts#L47)):
   when `report.aborted`, override statusClass/Icon/Text to an amber "ABORTED"
   variant. `renderStep` ([~251-273](../src/report/generator.ts#L251)): branch on
   `step.interrupted` **first**, distinct badge, and **suppress** the red
   `.failure-block`. template.ts gets only the new CSS classes; also update the
   auto-open-first-failed selector ([template.ts:433-437](../src/report/template.ts#L433))
   to match the interrupted badge.

### Revised Layer C — token accuracy (Gap 4)
Recording is already correct (3 reviewers verified: `markRunStart` rebaselines
per batch, `resetStep` never touches totals, `addUsage` only on completion). The
fix is **delivery as a frozen snapshot** (Layer A.1) — never recompute `runTotal`
live in the endpoint (a reused session's next `markRunStart` would zero it).
Contract: a cancelled in-flight call records nothing (no completion to read usage
from) — documented, accepted.

### Build / version (hard requirements)
- Root `npm run build` (server runs `dist/`, not `src/`) — see [[feedback_rebuild_dist_after_src]].
- `runner-core` change ⇒ bump **both** `testbench-native` AND `testbench-monaco`
  patch versions, rebuild + repackage + reinstall both (the bundled `dist/`
  changes in both even though Monaco never calls the new code; per CLAUDE.md).

### Tests (revised)
- **Server** — `GET /sessions/:id/last-run` returns frozen reportPath + non-zero
  tokens after an aborted run (the path that fails today; verify it fails pre-fix);
  survives a browser-closing stop; step-1 abort still produces a report; report
  has `aborted` + the interrupted step; tokens still equal `report.tokensUsed`
  after a *subsequent* run starts; a normal failing run is unchanged (no `aborted`,
  emits `step:fail`).
- **runner-core** — `getLastRun` parses fields; 404 → null; older server missing
  fields → undefined, no throw.
- **testbench-native unit (`node --test`, stub api-client, injectable backoff)** —
  stop polls and sets `lastResolvedReportPath` + tokens; the race (absent on first
  poll, present later) resolves; **pause does NOT poll**.
- **testbench-native live (`tests/integration/live/stop-report.test.cjs`, NEW,
  auto-discovered by the glob)** — rebuild `dist/` + restart the server first; run
  github.md, let ≥1 step pass, `testbench-native.stop`; assert `isRunning` flips
  false promptly, `controller.lastReportPath` resolves to an existing file for THIS
  run, the report marks aborted + the interrupted step, and the run token total
  > 0 — assert **before** any `restartSession` teardown. Add a `lastRunTokens`
  `__testHooks` accessor (absent today) to support the token assertion.

---
<details><summary>Original sketch (superseded — kept for history)</summary>

**Status (original):** 🟡 open — diagnosed (4 gaps: delivery, content, step-1, tokens); plan below pending multi-perspective review
**Area:**
- Delivery: [src/server/api-server.ts:252-255, 273](../src/server/api-server.ts#L252) (stop closes SSE → `clientGone` drops the final `done`), [testbench-native/src/extension/run-controller.ts:593](../testbench-native/src/extension/run-controller.ts#L593) (stop aborts the fetch), [runner-core/src/api-client.ts:256](../runner-core/src/api-client.ts#L256) (aborted read throws before `done` is read), [run-controller.ts:1262](../testbench-native/src/extension/run-controller.ts#L1262) (the only place `reportPath` is captured — never reached on abort)
- Content: [src/server/session-manager.ts:2430-2433](../src/server/session-manager.ts#L2430) (report only when ≥1 step completed; aborted→`'failed'`), the post-step abort check breaks **before** the result push so the stopped step isn't recorded, [src/report/types.ts:3](../src/report/types.ts#L3) (`StepStatus` has no `aborted`)
- Tokens: [src/server/session-manager.ts:2452-2454](../src/server/session-manager.ts#L2452) (the aborted report reads `tokenTracker.runTotal/runInputTotal/runOutputTotal` — see Gap 4), [src/ai/client.ts](../src/ai/client.ts) (`addUsage` runs only after a response completes; a cancelled call records nothing)
**Related:** [020](020-stop-not-instant-current-step-runs-to-completion.md) — made stop fast, which exposed these report gaps.
**Opened:** 2026-06-02

## Symptom (user report)

> If I stop the test in TestBench does it still generate a report and should I
> still be able to see the report? Does the report say which step was aborted? I
> don't think the report opens.

Confirmed on all counts. Three distinct gaps.

## Mechanism

### Gap 1 — The stopped run's `reportPath` never reaches the client (delivery)
The server *does* write a report to disk after an aborted run (the generator runs
post-loop, gated only on `fullStepResults.length > 0`, [session-manager.ts:2430](../src/server/session-manager.ts#L2430)),
and emits `done` with `reportPath` ([session-manager.ts:2472](../src/server/session-manager.ts#L2472)).
But the client never sees that path, for **two independent reasons that both fire
on stop**:
1. **Server drops it.** Stop closes the SSE socket → `res.on('close')` sets
   `clientGone = true` ([api-server.ts:252-255](../src/server/api-server.ts#L252)),
   and the emit callback early-returns when `clientGone` ([api-server.ts:273](../src/server/api-server.ts#L273)).
   The `done`/`reportPath` is generated but never written.
2. **Client stops reading.** Stop calls `ac.abort()` ([run-controller.ts:593](../testbench-native/src/extension/run-controller.ts#L593));
   the next `reader.read()` throws `ApiClientError('aborted')` ([api-client.ts:256](../runner-core/src/api-client.ts#L256))
   which unwinds the `for await` loop **before** the `done` capture at
   [run-controller.ts:1262](../testbench-native/src/extension/run-controller.ts#L1262).

There is no fallback (no reports-dir scan). So `lastResolvedReportPath` keeps its
value from a *previous completed* run (or stays null), and "Open Last Report"
([commands/index.ts:431-450](../testbench-native/src/extension/commands/index.ts#L431))
opens the wrong report or says "no report yet". **This is why the report doesn't
open.**

### Gap 2 — The report can't distinguish aborted from failed, and doesn't mark the stopped step (content)
`StepStatus = 'passed' | 'failed' | 'skipped'` ([report/types.ts:3](../src/report/types.ts#L3));
`TestReport.status` reuses it. The report generator maps aborted → `'failed'`
([session-manager.ts:2432-2433](../src/server/session-manager.ts#L2432)). The
stopped step's result is never pushed — the post-step abort check breaks before
the `results.push` — so the report just shows the completed steps labelled
"failed", with no indication of where or why it stopped.

### Gap 3 — Stopping during step 1 produces no report at all
The report gate is `fullStepResults.length > 0`. If you stop before any step
finishes, nothing is recorded → no report file → nothing to open even via a
future fix.

### Gap 4 — Token usage must be recorded accurately across an abrupt stop
The aborted report already reads the run token getters post-loop
([session-manager.ts:2452-2454](../src/server/session-manager.ts#L2452)), and
`markRunStart()` rebaselines per batch ([session-manager.ts:992](../src/server/session-manager.ts#L992)),
so **tokens from AI calls that completed before the stop are recorded correctly**
in the on-disk report. Two real risks to nail down rather than assume:
1. **Delivery (same as Gap 1):** the client never receives those totals on abort
   — no token figure reaches the UI because the `done`/report path is dropped.
   The client should still be able to see accurate run-token usage after a stop.
2. **The in-flight cancelled call records nothing.** `addUsage` runs only after a
   response completes ([client.ts](../src/ai/client.ts)); a fetch aborted
   mid-flight (incl. a streaming call whose `usage` event may have already
   arrived) adds zero. Decide + document the contract: the cancelled call's
   tokens are intentionally not counted (we have no completion to read usage
   from). Confirm there's no path that double-counts or *loses already-recorded*
   usage on abort (e.g. a `resetStep`/rebaseline firing on the abort path).

## Scope decision (proposed — confirm in review)

Fix all three. Direction confirmed with the user (fetch-on-abort for delivery; a
real aborted state for content). Constraints:
- **Touches client code → version bump + repackage.** Delivery needs
  `runner-core` (api-client) + `testbench-native` (abort path) edits, which are
  bundled into the VSIX — per CLAUDE.md, bump the affected variant's patch
  version, rebuild, repackage, reinstall. `runner-core` is a `file:` dep bundled
  into **both** extensions; assess whether the Monaco variant also needs a bump.
- **Server changes need a root `dist/` rebuild** (the running server executes
  `dist/`, not `src/`).
- Keep all wire/type additions **backward-compatible** (older client ↔ newer
  server and vice-versa): new fields optional, no behavioural change for a normal
  (non-aborted) run.

## Fix sketch

### Layer A — Deliver the report path (and run token totals) on abort (Gaps 1 + 4.1)
Reuse the existing `GET /sessions/:id` rather than add a route.
1. **Server** — remember the last report path **and the run token totals** on the
   session. After `generateReport` ([session-manager.ts:2459](../src/server/session-manager.ts#L2459)),
   set `session.lastReportPath = reportPath` (and capture `runTotal`/`runInputTotal`/
   `runOutputTotal` into a `session.lastRunTokens`). Add these as optional fields
   on `SessionState` ([session-manager.ts:275-283](../src/server/session-manager.ts#L275))
   so `getSession` ([api-server.ts:368-382](../src/server/api-server.ts#L368))
   returns them.
2. **runner-core api-client** — extend `getSession(id)` (or add a tiny
   `getLastReportPath(id)`) to return `lastReportPath` + token totals. Additive,
   optional fields; absent on an older server → undefined, no throw.
3. **testbench-native** — on the user-abort branch ([run-controller.ts:1113](../testbench-native/src/extension/run-controller.ts#L1113)),
   after marking the run aborted, `GET /sessions/:id` and, if present, set
   `this.lastResolvedReportPath` (so "Open Last Report" resolves the stopped run)
   and surface the run token totals to the UI.

   - **RACE (must handle):** the client's abort and the server's post-loop report
     generation run concurrently. The server finishes the run (and writes the
     report / sets `lastReportPath`) *after* the client has already disconnected,
     so a single immediate GET may arrive **before** `lastReportPath` is set.
     Mitigation: the client polls `GET /sessions/:id` with a short bounded backoff
     (e.g. ~5 tries over ~2s) until `lastReportPath` is present or the budget
     expires. Alternatively the server could expose a "run finalized" signal —
     evaluate in review. Document whichever is chosen; do not silently single-shot.
   - The session survives a stop (status reset to `'active'` in the `finally`,
     [session-manager.ts:2398-2399](../src/server/session-manager.ts#L2398)), so
     the GET will find it.

### Layer B — Give the report a real aborted state and mark the stopped step (Gaps 2 + 3)
Prefer **additive flags** over widening `StepStatus` (widening ripples through
every `switch (status)` in the report template + runner; the 020 review flagged
this as invasive).
1. **types** — add `TestReport.aborted?: boolean` and a `StepResult.interrupted?:
   boolean` (the step that was running when stop landed). Both optional.
2. **session-manager** — in the post-step / post-branch / catch abort handlers
   ([~2152](../src/server/session-manager.ts#L2152), [~1764](../src/server/session-manager.ts#L1764)),
   push a minimal `StepResult` for the stopped step with `interrupted: true`
   (status `'failed'` for back-compat, or `'skipped'` — decide in review) and a
   clear `aiExplanation` ("Stopped by user"). This also makes
   `fullStepResults.length > 0` even on a step-1 stop → **fixes Gap 3**. Emit a
   `step:fail`? No — keep the no-`step:fail` contract from 020; the recorded
   result is for the on-disk report only.
3. **report generator** — set `report.aborted = true` when
   `overallStatus === 'aborted'`; keep `status` as a valid `StepStatus`
   (`'failed'`), with `aborted` as the overriding display state.
4. **report template** ([src/report/template.ts](../src/report/template.ts)) —
   render an "Aborted" banner/state when `report.aborted`, and mark the
   `interrupted` step distinctly (not a red "failed").

## Tests (planned)

- **Server unit/integration (`tests/session-manager.test.ts`, `tests/api-server*.test.ts`):**
  - After an aborted run with ≥1 completed step, a report is generated, the
    session's `lastReportPath` is set, and `GET /sessions/:id` returns it (+ token
    totals).
  - Aborting during step 1 still produces a report (Gap 3) — `fullStepResults`
    has the interrupted step.
  - `report.aborted === true` and the stopped step carries `interrupted: true`;
    a normal failing run still has `aborted` falsy and emits `step:fail`.
  - **Tokens (Gap 4):** an aborted run whose completed AI calls reported usage has
    accurate non-zero `tokensUsed/inputTokens/outputTokens` in the report **and**
    in the `getSession` token totals — i.e. completed-call tokens survive the
    abort. A control: a cancelled in-flight call adds nothing (no double-count, no
    loss of already-recorded usage).
- **runner-core api-client (`runner-core/tests/api-client.test.js`):** `getSession`
  surfaces `lastReportPath` + token totals; absent fields on an older server →
  undefined, no throw.
- **testbench-native — TWO layers (the user asked specifically to ensure stop is
  covered here):**
  - **Controller unit (`tests/*.test.js`, `node --test`):** on user-abort the
    controller polls `getSession` and sets `lastResolvedReportPath`; the race
    (path absent on first GET, present on a later poll) resolves within the
    bounded budget; "Open Last Report" then resolves the stopped run's path; token
    totals are surfaced. Use a stub api-client so this stays in the fast suite.
  - **Live integration (`tests/integration/live/stop-report.test.cjs`, NEW):**
    mirror [pause-resume.test.cjs](../testbench-native/tests/integration/live/pause-resume.test.cjs)
    — run github.md against the real server, let ≥1 step pass, fire
    `testbench-native.stop`, then assert: `isRunning` flips false promptly (ties
    to 020's fast-stop), `controller.lastReportPath` resolves to an existing file
    for **this** run, the report marks the run aborted + the interrupted step, and
    the run token total is > 0. Runs via `runLiveTest.cjs` (needs a running
    server; not part of the fast suite) — wire it into the live runner alongside
    the existing cases. Confirm no stop-scenario live test exists today (it does
    not) before adding.

</details>
</details>

## Follow-ups (not blocking)

- **Graceful "drain" stop** (keep the SSE open just long enough to receive the
  server's `done`) would deliver `reportPath` without a second GET, but it's a
  larger protocol change; the fetch-on-abort path is the cheaper fix.
- **Auto-open / "Open Report" toast on abort** — currently opening is always a
  manual command; a notification with an action button could be a UX add-on.
