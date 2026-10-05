# Debug a skill against a stopped session (run selected skill steps)

Lets the user **Stop** a test that failed inside a skill, keep the browser open,
and then iterate on the skill: select step(s) in the skill file and **run them
against the still-live session**, with the test's variables in scope — so they can
edit the skill `.md` and re-run to confirm a fix without replaying the whole test.

Sibling of [skill-step-rerun-with-variables.md](skill-step-rerun-with-variables.md)
(the paused-on-error "re-run from the failed step" feature, merged 861fc1b). This
spec reuses that feature's machinery (frame-qualified slice, per-step cache
bypass, the `isSessionAlive` liveness pre-flight) and adds the **Stop** path it
deliberately excluded. Also see [debugging-ux.md](debugging-ux.md) (run / pause /
resume / stop) and the step-cache spec, since removed with the step cache (skill
expansion, `frame:scope`, the steps request).

## 1. Background — why Stop is the gap, and what survives it

The merged re-run works only from **paused-on-error**: the scope is held on the
controller and the action gates on it. **Stop throws that away.** `performStop`
([commands/index.ts:64-82](../../src/extension/commands/index.ts#L64-L82)) calls
`resetFrameState()`, which wipes `scopesByFrame` **and** the `_lastSkillFailure`
anchor ([run-controller.ts:301-315](../../src/extension/run-controller.ts#L301-L315)).

But Stop never messages the server — what's lost is **only client state**. The
server keeps everything that actually matters here:

| State after Stop | Survives? | Where |
|---|---|---|
| Browser + server session | ✅ | server, keyed by **test file path** |
| Captured `[store as:]` / `[output:]` vars | ✅ | `session.outputs` |
| Test `## Parameters` | ✅ (also re-derivable from doc) | `session.outputs`, source `parameter` |
| Skill **input** params (`query="cats"`) | ⚠️ not stored; **re-derived** on re-expansion from the test's `[skill:]` line | inlined at [expander.ts:458](../../../src/skills/expander.ts#L458) |
| Skill-internal `__skillN_x` cross-step vars | ❌ | never persisted (server-owned, per-run) |
| Client `scopesByFrame` + `_lastSkillFailure` | ❌ wiped by `resetFrameState` | — |

**Key consequence:** the variables we need already live in the test's server
session and survive Stop. So we do **not** snapshot them on the client — we run
the chosen slice against the **live session** and let it supply (and keep
updating) them. The only thing Stop destroys that we must re-establish is the
**anchor** — which test/skill/lines — and the affordance to run it.

## 2. Decisions (user-set)

- **Run unit = the editor selection.** Run the selected skill step(s); if nothing
  is selected, run the **whole skill body**.
- **Variable model = live / accumulating.** Variables come from the test's **live
  server session** (`session.outputs`), which survived the Stop and is updated on
  every step. Each re-run reads the latest values and writes its captures back, so
  **state accumulates across re-runs** — *not* a frozen restore. (This supersedes
  the earlier "snapshot at Stop" idea, which was point-in-time frozen.)
- **Single debug context.** At most one skill-debug target at a time; the latest
  Stop-in-a-skill **replaces** the previous (the *pointer*, not the data or the
  other browser). No picker, no ambiguity (§3.2, §4).
- **Surfacing = a distinct command + a banner.** A "Run on stopped session"
  command, plus a skill-debug-mode banner naming the target, so it's never
  confused with the skill file's existing standalone run.
- **Guardrails = same as the merged feature:** top-level skills only; refuse when
  a selected step needs an internal `__skill*` var an unselected earlier step
  would have produced.

## 3. Design

### 3.1 The single skill-debug context (set on Stop)

A single registry-level field — `currentSkillDebug` on the controllers registry,
**not** per-controller:

```ts
interface SkillDebugContext {
  testUri: string;   // owning test — session key, controller lookup, re-expansion entry
  testLine: number;  // the test's [skill: …] invocation line
  skillUri: string;  // the skill .md being debugged
  frameId: string;   // the failed top-level frame (fidelity; future multi-invocation disambiguation)
}
```

No captured scope is stored — variables come from the live session (§3.4). The
skill body's line range (for "whole skill" + selection clamping) is computed from
the skill document on demand, not stored.

**Set on Stop only.** Stop and Close Session share `performStop()`
([commands/index.ts:115](../../src/extension/commands/index.ts#L115) and
[:210](../../src/extension/commands/index.ts#L210)), which takes no argument —
give it `performStop({ setSkillDebug })`. Only the **Stop** command passes `true`.
When set, if the active controller has a parked **top-level** skill failure
(`controller.lastSkillFailure`, populated by the merged `recordSkillFailure`,
[run-controller.ts:354-366](../../src/extension/run-controller.ts#L354)), capture
its anchor into `currentSkillDebug` — read **before** `resetFrameState` runs
inside `performStop`. This **replaces** any prior context (latest wins).

**Lifecycle is simple because the context is off-controller.** The merged
feature's `_parkedSkillDebug`-vs-`resetFrameState` hazard does **not** apply:
`runLines` calls `resetFrameState()` unconditionally
([run-controller.ts:747](../../src/extension/run-controller.ts#L747)), but that
touches controller frame state, not the registry field. `currentSkillDebug` is
cleared only when:

- the **owning test runs fresh** — a non-continuation `runLines` on that
  controller (the debug command's own runs are `isContinuation: true`, so they
  preserve it);
- the **owning test's session is closed**; or
- the **liveness pre-flight finds the session dead** (§3.4).

A new Stop-in-a-skill replaces it; running or closing **other** tests leaves it
untouched.

### 3.2 Which session — trivial under single-context

The run targets the **owning test's session** (skill files aren't sessions —
they're keyed by test path). With one context, "which session" is just
`currentSkillDebug.testUri`: resolve the controller via
`registry.controllerForUri(testUri)`
([extension.ts](../../src/extension/extension.ts)) and reuse its `sessionId` (the
open browser). **No per-controller search, no quick-pick.**

`registry.active()` can't be used anyway — it's test-file-only and returns the
skill's own controller (or `undefined`) when the skill `.md` is active
([commands/index.ts:444](../../src/extension/commands/index.ts#L444)), and the
skill is revealed with `preserveFocus`
([extension.ts:461](../../src/extension/extension.ts#L461)). Single-context means
we don't need it: we read the registry field directly. The command is enabled
only when the active editor is the skill file matching `currentSkillDebug.skillUri`,
and the banner names the target (§3.5), so the session can't be mistaken.

### 3.3 Run unit → a `[start, end]` slice

The merged feature slices `startAt → end of frame`
([session-manager.ts:1317-1368](../../../src/server/session-manager.ts#L1317)).
This feature needs a **bounded range**:

- **Selection present:** map the selection's first/last lines to step lines within
  the skill body (reuse `selectionLines` / `resolveRunLines` /
  `findStepsSection`, which are format-agnostic and agree with the server's
  `effectiveSourceLines`). `startAt = firstSelected`, `endAt = lastSelected`;
  ignore non-step lines inside the selection; refuse a selection that escapes the
  one skill body.
- **No selection:** `startAt = body.first`, `endAt = body.last` (whole body).

**Server contract — one new optional field** on `StepRequest`, beside `startAt`:

```ts
endAt?: { uri: string; line: number };
```

`endIndex` = last expanded step in the **same frame** with source line ≤ `endLine`;
default `effectiveSteps.length - 1` when absent — preserving the merged behaviour
**exactly** (regression-guard it). Loop `for (i = startIndex; i <= endIndex; …)`.

**Group-snap is asymmetric**, not "both ends": the existing guard snaps a
mid-group `startIndex` **up** to the group's first member
([:1353-1356](../../../src/server/session-manager.ts#L1353)); the matching end fix
**extends `endIndex` down** to the group's last member. Two different adjustments.

**Cache-off** keys on `startAt` (`isPartialRerun = request.startAt !== undefined`,
[:1112-1114](../../../src/server/session-manager.ts#L1112)). Every request here
sends `startAt` (whole-body uses `body.first`), so the slice always bypasses the
per-step cache — required so an edited skill re-plans instead of replaying a
frozen action list. (The step cache this referred to was removed; there is no cache to bypass now.)

**Client threading:** `endAt` must be added to the `rerun` option type
([run-controller.ts:714-717](../../src/extension/run-controller.ts#L714)), the
`runStepBlock` arg, the request-body spread
([:1182](../../src/extension/run-controller.ts#L1182)), and parsed in
`api-server.ts` beside `startAt`.

### 3.4 Variables come from the live session (accumulating)

The run reuses the test's `sessionId`, so the server resolves variables from the
live `session.outputs` — `{...session.outputs, ...parameters}` with **no
`seedScope`** ([session-manager.ts:915-918](../../../src/server/session-manager.ts#L915-L918)).
That store survived the Stop and holds the captured `[store as:]`/`[output:]` vars
plus test params; skill **input** params are re-inlined on re-expansion from the
test's `[skill:]` line. So the slice runs with the **same variable context the
test had** — and because captures are swept back into `session.outputs` after each
step, **state accumulates across re-runs** (each reads the latest, not a frozen
copy). This is the chosen behaviour.

Reused unchanged from the merged feature:

- **Cache bypass** for the seeded slice (above) — so an edited skill re-plans.
- **Re-expansion** picks up skill edits (`clearSkillCache()` at request start) and
  re-inlines input params from the `[skill:]` line.
- **Liveness pre-flight (mandatory):** probe `isSessionAlive`
  ([api-client.ts:263](../../../runner-core/src/api-client.ts#L263)) before
  running; if the browser was closed since the Stop, **refuse and clear the
  context** — the open browser is the whole point, and a missing session would
  silently spawn a **blank** one
  ([session-manager.ts:570-571](../../../src/server/session-manager.ts#L570)).
- **Internal-var refusal:** a selected step that interpolates a `{{__skill*}}` var
  produced by a *skipped* earlier step can't be resolved from `session.outputs`
  (those are server-internal, never persisted) → the server refuses
  ([:1394-1419](../../../src/server/session-manager.ts#L1394)). Running from the
  body top (or whole skill) re-derives them, so no refusal there.

No client read of `session.outputs` is needed for v1 — we don't display or edit
variables (see §6); the slice just runs and the server owns the values. An
explicit **edit-a-variable** path would send a one-off `seedScope` for that run,
but that's deferred (§6), not part of the core "edit the skill text, re-run" loop.

### 3.5 The command + banner

- **Command** "Steptix: Run selected skill steps on stopped session" (palette +
  skill-file editor context menu + optional gutter), **enabled only** when
  `currentSkillDebug` is set and the active editor matches its `skillUri`.
  Deliberately distinct from the skill file's existing **standalone** run (which
  uses a fresh session) — the name and the banner keep the two apart.
- **Banner** (skill-debug mode): a status-bar item, e.g.
  **"▶ Debugging skill `S` against stopped test `A`"**, shown whenever
  `currentSkillDebug` is set; clicking it can reveal the owning test. It clears
  when the context clears (§3.1), so you always know whether you're targeting a
  stopped session and which one.
- **On invoke:** compute the range (selection / whole body, §3.3) → run the
  liveness pre-flight (refuse + clear if dead) → resolve the controller by
  `testUri` → `runLines([testLine], { isContinuation: true, rerun: { startAt:
  {uri: skillUri, line: rangeFirst}, endAt: {uri: skillUri, line: rangeLast} } })`.
- A slice that fails re-enters the normal paused-on-error flow (a fresh
  `recordSkillFailure`); the debug context persists, and you can edit + run again
  (state having moved on, per accumulating).

### 3.6 Guardrails (kept)

- **Top-level skills only** — the context is set only when `lastSkillFailure` is a
  top-level frame, which `recordSkillFailure` already enforces.
- **Refuse internal-var dependency** — server-side (§3.4).

## 4. Edge cases

| Scenario | Behaviour |
|---|---|
| No selection | Run the whole skill body (`startAt`/`endAt` = body bounds) |
| Selection of steps 2–3 of a 5-step skill | Run only 2–3 against the live page; 4–5 not run |
| Disjoint multi-selection (e.g. steps 1 and 3, not 2) | Runs the contiguous range 1–3 — the gap (step 2) is included; the slice is a `[start,end]` range, not a set |
| Selection escapes the skill body / spans two skills | Refuse — one skill body per run |
| Selection includes blank/header lines | Clamp to the step lines inside it |
| Same skill stopped from Test A then Test B | Context **replaced** by B (latest wins); A's browser/vars still alive on the server but no longer the target; re-stop A to switch back |
| Browser closed since Stop | Liveness pre-flight refuses + clears the context; no blank browser spawned |
| Selected step needs a skipped step's `__skill*` var | Refuse (§3.6) |
| "Run all" re-applies a non-idempotent earlier step | Allowed; inherent to running from the top against a mid-skill page — author's call, surfaced in the command tooltip |
| Re-run fails again | Re-enters paused-on-error; the debug context persists; edit + re-run again (state has moved on — accumulating) |
| Owning test re-run fresh, or Close Session | Context cleared (§3.1) |
| Nested skill failure | Out of scope (top-level only); no context recorded |

## 5. Testing

- **Unit (context lifecycle):** a Stop with a parked top-level skill failure sets
  `currentSkillDebug`; a second Stop **replaces** it; a non-continuation `runLines`
  on the owning controller and `closeSession` **clear** it; the debug command's own
  (continuation) runs **preserve** it. Assert the **Stop vs Close-Session boundary**
  directly: `performStop({ setSkillDebug: true })` sets a context, plain
  `performStop()` does **not** (don't let `closeSession`'s clear mask an erroneous
  set on the Close path). Running an unrelated test leaves the context untouched.
- **Server (`endAt` slice):** a request with `startAt`+`endAt` runs only the
  in-range steps of that frame; absent `endAt` still runs to end-of-frame
  (regression guard); group-snap honoured at both ends (start up, end down).
- **Live / accumulating vars:** a re-run with **no** `seedScope` resolves captures
  from `session.outputs`; a value captured by one re-run is visible to the next
  (accumulation, not a frozen reset); the seeded slice bypasses the per-step cache
  (AI re-invoked, edited skill re-plans).
- **Liveness pre-flight:** browser closed after Stop → the action refuses with a
  clear message, clears the context, and launches no blank browser.
- **Guardrail:** a selection starting mid-body whose step needs a skipped step's
  `__skill*` var is refused.
- **Integration (state machine):** drive a skill step to failure → **Stop** →
  assert the context is set, the banner shows, and the command is enabled on the
  matching skill file (and disabled on a non-matching one) → select steps → fire →
  assert the run reuses the test `sessionId`, runs only the selected range with
  vars from the live session, and does **not** spawn a fresh session or run the
  whole test.

## 6. Status & deferred

**Decided (this spec):** run-unit = selection (whole skill if none); variables =
live/accumulating from the test session; single registry-level context
(latest-Stop-wins); distinct command + skill-debug banner; top-level only + refuse
internal-var deps.

An earlier snapshot-based draft (Plan-agent reviewed) was **re-based on these
decisions**: dropping the frozen client snapshot removes both the
`_parkedSkillDebug`-vs-`resetFrameState` lifecycle hazard and the
input-param/`seedScope` conflict the review flagged, since variables now come from
the live session and the anchor lives on the registry. The `performStop`
Stop-vs-Close distinction and the asymmetric group-snap from that review still
apply and are folded in above.

**Deferred:**

- **Showing / editing live variables** in this flow — needs a client
  `getSession`-with-`outputs` call and a panel; v1 runs without it (the loop is
  "edit skill text, re-run"). An edit would inject a one-off `seedScope`.
- **Multiple simultaneous debug contexts** (debug two stopped tests at once) and
  the owning-test quick-pick that needs.
- **Param editing / re-expansion of changed `[skill:]` args** — inherited non-goal.
- **Nested skills.**
