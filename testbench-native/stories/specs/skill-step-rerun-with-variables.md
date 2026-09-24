# Re-run a skill step with its (editable) variables

Lets the user retry a **failed step inside a skill body** without re-running the
whole test — re-running from the failed step to the end of that skill
invocation, against the still-live browser session, after optionally editing the
runtime variables in scope.

Companion to [debugging-ux.md](debugging-ux.md) (run / pause / resume / stop and
the paused-on-error state this builds on), the step-cache spec, since removed with
the step cache (skill expansion, `frame:scope`, the steps request), and
[run-state-persistence.md](run-state-persistence.md) (per-controller run state).

## 1. Background

When a step inside a skill fails, the run ends and parks a resume point on the
test-file `[skill: …]` line (paused-on-error,
[extension.ts](../../src/extension/extension.ts) `step:fail` handler). Today the
only retry is **Continue**, which re-runs the *entire* `[skill:]` invocation
([run-controller.ts](../../src/extension/run-controller.ts) continue path). There
is no way to retry just the failed step, and no way to retry it with different
variable values.

Two facts make a finer-grained retry tractable:

1. **The variables already exist, captured per step.** The server emits a
   `frame:scope` snapshot **after every successful step**
   ([session-manager.ts:1787-1791](../../../src/server/session-manager.ts#L1787-L1791)),
   carrying the skill's input args plus accumulated `[store as:]` / `[output:]`
   captures. The extension stores the latest snapshot **per frame, per
   controller** (`scopesByFrame` on the RunController,
   [run-controller.ts:160-317](../../src/extension/run-controller.ts#L160-L317)).
   So at the moment of failure we hold the scope *entering* the failed step.

2. **The session stays alive after a failure.** `closeSession` fires only on the
   explicit **Close Session** command, a controller's first run (stale cleanup),
   and batch mode — **not** on Stop. The server is keep-alive, keyed by
   `sessionId = <test file path>`. So after a failure the browser is still open
   at the failure point, and a follow-up run that reuses the same `sessionId`
   lands on the same page.

   ⚠️ **Stop is different from a failure.** `performStop`
   ([commands/index.ts:64-82](../../src/extension/commands/index.ts#L64-L82))
   aborts the run and calls `resetFrameState()`, which **wipes `scopesByFrame`**
   — the captured scope this feature needs. The server session is left alive,
   but the scope is gone. So availability gates on **scope still held by the
   controller**, not on session liveness (§4.5).

The gap is plumbing in three places, none trivial (§4.3, §4.4, §4.5): the steps
request has a `parameters` field (the test's declared `## Parameters`) but **no
way to seed a captured runtime scope**; runs execute from `i=0` over the whole
expanded list with **no way to start partway into a skill body**; and the
Variables panel is **read-only and sourced from the document**, not from the
failed frame's scope.

## 2. The two kinds of variable (why params are read-only in v1)

The captured scope shown in the Variables panel mixes two things that *look*
identical but behave differently when edited:

| Kind | Example | Where it lives | To change it… |
|---|---|---|---|
| **Skill input param** | `query` from `[skill: search query="cats"]` | **Inlined into the step text** at expansion ([expander.ts:458](../../../src/skills/expander.ts#L458)); only *shown* in scope because the server overlays the invocation args back in for visibility ([session-manager.ts:1782-1786](../../../src/server/session-manager.ts#L1782-L1786)) | must **re-expand** the invocation with the new arg — the value is baked into the text, not read from scope at run time |
| **Captured / runtime var** | an `[output:]` / `[store as:]` value, an `out.x` alias | the live session scope (`resolvedParameters` → `session.outputs`) | **inject** the new value into the session scope before the step runs |

v1 makes **captured/runtime vars editable** (the inject path) and leaves **skill
input params read-only context** (re-expansion is deliberately out of scope —
see §7). Editing a captured var takes effect; params are displayed so the user
understands the run context but cannot be changed here. (To change a param,
edit the `[skill:]` line and Continue, which re-expands.)

## 3. Goals

1. From a failed skill step, re-run **from that step to the end of the skill
   invocation** with one action.
2. Reuse the **live session** so the retry runs on the page where it failed — no
   re-running earlier steps, no re-navigation.
3. Let the user **edit captured/runtime variables** in the Variables panel
   before the retry, and have those edits seed the retry's scope.
4. Resolve **which invocation's variables** deterministically when the same
   skill was used by more than one test (see §4.2).

### Non-goals

- **Editing skill input params** (the re-expansion path). Read-only in v1; §7.
- **Cold retry** after the session has been closed/stopped. v1 is live-session
  only; if the session is gone the action is unavailable (§4.5). Replaying
  enough prior context to rebuild page state cold is out of scope.
- Re-running an arbitrary inline (non-skill) step with edited scope. This spec
  is scoped to skill-body steps, where the variable-context problem actually
  bites. (An inline step's scope is the test's own, already visible/editable as
  `## Parameters`.)
- Persisting edited scope across runs. Edits are a one-shot seed for the retry.

## 4. Design

### 4.1 The re-run unit

The unit is **one skill invocation, started partway through its body**:

- **Start:** the failed skill-body step (its line in the skill file, carried on
  the `step:fail` frame).
- **End:** the last step of that same `[skill:]` invocation. The run does **not**
  spill into test steps after the `[skill:]` line — "to end of skill," not "to
  end of test."

Earlier skill steps (the ones before the failed step) are **not** re-executed;
their outputs come from the seeded scope (§4.3). Later steps run normally and
produce their own outputs as they go.

### 4.2 Which variables — per-controller ownership

Scope is stored per **RunController**, and there is **one controller per test
file** ([extension.ts](../../src/extension/extension.ts) `controllers` map keyed
by URI). So when two tests invoke the same skill:

```
Test A: [skill: search query="cats"]   → controller A, scopesByFrame = {…cats…}
Test B: [skill: search query="dogs"]   → controller B, scopesByFrame = {…dogs…}
```

…there is no shared "the skill's scope" to disambiguate — there are two
controllers holding two scopes. The retry uses the scope of **the controller for
the active test file**. After a skill failure the skill file is revealed with
`preserveFocus` (the test file stays the active editor — see
[the per-file `paused` key](debugging-ux.md)), so the active test is naturally
the failed one and `registry.active()` resolves to its controller.

The editable Variables panel makes this **foolproof**: the values it shows are
that controller's captured scope, so the user *sees* `query=cats` and the
retry's seed before running. There is no hidden "most recent run" guess.

**Read the right frame.** Use `scopeFor(<failed frame id>)`, not
`currentScope()`. On any run exit the server pops every frame back to the test
frame (`transitionToFrame('')`), so the client's frame stack is empty by `done`
and `currentScope()` returns the **test** frame's scope, not the failed skill's
([run-controller.ts:315-318](../../src/extension/run-controller.ts#L315-L318)).
The failed frame's scope still lives in `scopesByFrame` (cleared only at the
next run start), keyed by the frame id carried on the `step:fail` event — seed
from that.

**Resolve the controller by the failed frame's root test, not by focus.**
`registry.active()` returns a controller only when the active editor is a test
file; if the user clicks into the revealed skill `.md`, it returns `undefined`
and the panel would parse rows from the *skill* document. Resolve via the failed
frame's root test URI (`frameRoot`) instead, or disable the action when the
active file isn't the owning test.

### 4.3 Server contract — seed the scope

One new optional field on the steps request
([api-server.ts:77-130](../../../src/server/api-server.ts#L77-L130),
`StepRequest`):

```ts
seedScope?: Record<string, string>;
```

Before executing the (sliced) steps, the server merges `seedScope` into the
session's `resolvedParameters` (and mirrors to `session.outputs`, the same place
`[store as:]` captures persist across batches —
[session-manager.ts:1793-1804](../../../src/server/session-manager.ts#L1793-L1804)).
This makes the skipped earlier steps' outputs (and any edited values) available
to the steps that do run.

Only **non-`__skill*`** names are accepted into `seedScope` (internal namespaced
vars are server-owned; see §4.4). Names not referenced by the running steps are
harmless. **Caveat:** a tail step that reads a skill-internal `__skillN_x` var
which an *earlier (skipped)* step would have produced will break — that value
isn't re-derived and can't be hand-seeded. Pure-`out.*` skills and the
first-step case are safe; mid-body re-runs that depend on internal vars are not.
v1 should detect and refuse that case rather than run a half-bound tail.

**Starting partway into the body is net-new work, and the anchor must be
frame-qualified.** Today the step loop runs from `i=0` over the whole expanded
list ([session-manager.ts:1267](../../../src/server/session-manager.ts#L1267));
there is no start offset. A bare source line is **not** a safe anchor — the same
line recurs across frames and across repeated invocations of one skill
([session-manager.ts:1576-1585](../../../src/server/session-manager.ts#L1576-L1585)).
The start anchor must be **frame id + source line**, and the server must compute
the slice over the expanded list from the matching step to the end of that
frame's body. This is the largest piece of the feature, not a field rename.

### 4.3.1 The seeded tail must NOT replay a stale cached plan

> The step cache this section guards against has since been removed, so there is
> no cached plan to replay; the requirement below, and the cache-bypass items in
> the test and delivery lists, are kept as history.

For a subset run with skills, the bundle hash is computed over the *expanded
full document* (`chooseCacheHashSource` → `'expand-full'`,
[cache-hash-source.ts:23-30](../../../src/server/cache-hash-source.ts#L23-L30))
and per-step keys are `frameScopedStepKey(frameId, line)` — both **identical to
the full run's**. Step text doesn't change, so editing `seedScope` does **not**
change any hash. The tail steps would therefore **cache-hit and replay the
frozen action plan**: a typed value that flows through a `{{placeholder}}` is
re-interpolated on replay, but the *element targeting / action list is fixed*,
so an edit meant to drive a different path is silently ignored — possibly a
false pass. **A scope-seeded re-run must bypass the per-step cache** (send
`cacheEnabled: false` for the re-run, or invalidate the affected
`step-<frameId>-<line>.json` keys first). This is a correctness requirement, not
an optimization.

### 4.4 Variables panel — edit & re-run

The panel ([variables-panel.js](../../src/webview/lib/variables-panel.js),
`collectVariables`) is read-only today **and builds its rows by parsing the
active document** — `## Parameters`, `[input:]`/`[output:]` markers, and `out.*`
aliases on `[skill:]` lines; the `frame:scope` payload only feeds *values* into
those rows. So a bare `[store as: foo]` **inside a skill body** (not surfaced via
an `out.foo="…"` alias on the invocation) produces **no row at all** — the panel
literally cannot represent the very vars this feature edits. Re-using the
document-sourced row model is therefore a dead end.

v1 must add a **frame-scope-sourced editable view**, shown only while a skill
step is parked in paused-on-error with its scope still held (§4.5):

- **Source the rows from `scopeFor(<failed frame id>)`**, not the document.
  Show every non-`__skill*` entry; the `__skill*` internal names *do* appear in
  that flat payload (the Phase-4 shape,
  [session-manager.ts:1774-1779](../../../src/server/session-manager.ts#L1774-L1779))
  and must be filtered **here** (this is where the filter actually matters —
  the existing document-sourced panel never had `__skill*` rows to begin with).
- **Editable value cells** for captured/runtime entries. Params that came in as
  frame inputs render read-only with a hint ("edit the `[skill:]` line +
  Continue to change a parameter") — distinguishable because they match the
  invocation's declared args.
- A **"Re-run from failed step"** action. On click the webview posts the edited
  captured-var map to the extension, which:
  1. resolves the active test's controller and its failed frame,
  2. builds `seedScope` = captured scope ∪ edits (captured rows only),
  3. issues a run of the failed `[skill:]` invocation, started at the failed
     step, reusing `sessionId` (live page), with `seedScope`.

Masked rows (`password`/`secret`/`token`-shaped, `maskIfSecretInline`) stay
masked and are **not** editable in v1.

### 4.5 Availability + a mandatory server liveness pre-flight

Two conditions must both hold to offer the retry:

1. **Scope still held.** `scopesByFrame` for the failed frame is non-empty. It is
   wiped by `resetFrameState` on **Stop**, **Close Session**, and the **start of
   any new run** — so any of those withdraws the action regardless of the
   server. (This, not "session died on Stop", is why Stop disables the retry.)
2. **Session still alive on the server** — and this **cannot** be inferred from
   the client. A skill step can close the browser mid-run, reaping the session
   off the Stop path
   ([session-manager.ts:1900-1904](../../../src/server/session-manager.ts#L1900-L1904)),
   so a client "looks live" flag can be a false positive.

Critically, if the session is gone, `executeSteps` **silently creates a fresh
one and launches a blank browser**
([session-manager.ts:546-548](../../../src/server/session-manager.ts#L546-L548))
— there is no "session not found" error to catch in the run path, and a seeded
tail would then run against `about:blank` (and, with cached plans, could even
spuriously pass). So the retry **must** issue a **pre-flight `getSession`
probe** ([session-manager.ts:570-574](../../../src/server/session-manager.ts#L570-L574)
returns null for missing/closed) and abort with a clear message before starting
the run. This pre-flight is mandatory for v1, not optional hardening.

When unavailable, the panel shows the captured scope read-only with no re-run
action (the user can still Continue from the test, which starts a fresh run).

## 5. Edge cases

| Scenario | Behaviour |
|---|---|
| Same skill in Test A (cats) and Test B (dogs), both fail | Each test's controller holds its own scope; retry uses the active test's (§4.2) |
| Failed step is the **first** step of the skill | "From failed step" = whole invocation; seed scope = the invocation's input args only (no earlier captures yet) |
| A later step references a var an earlier (skipped) step produced | Comes from `seedScope` (captured after that earlier step ran) ✓ |
| User edits a captured var to drive a different path | Seeded value flows in; later captures overwrite as normal |
| User edits a **param** | Not possible in v1 (read-only); param rows explain why |
| Session died (Stop / Close / new run) before re-run | Action unavailable; panel read-only (§4.5) |
| Masked (secret-shaped) captured var | Shown masked, not editable in v1 |
| Re-run itself fails again | Ends as a fresh paused-on-error on the same step; panel re-populates with the new captured scope; user can edit + retry again |
| Nested skills (A calls B, B's step fails) | Frame is B's; "end of skill" is the end of B's body, not A's. Scope is B's frame scope. (v1 may restrict to top-level skills — see §7.) |

## 6. Testing

- **Unit ([variables-panel.js](../../src/webview/lib/variables-panel.js)):**
  captured rows are flagged editable, `param` rows are not, `__skill*` names are
  filtered out, masked rows are non-editable.
- **Unit (seedScope build):** the edited map overlays the captured scope;
  param edits are dropped; `__skill*` keys never leave the extension.
- **Server:** a steps request with `seedScope` makes those names resolvable in
  the run; `__skill*` keys in `seedScope` are ignored; a request starting at a
  mid-skill source line runs only that step to the end of the invocation.
- **Integration (state machine):** drive a skill step to failure → assert the
  re-run action is offered only while the scope is held (and withdrawn after
  Stop / Close Session / a new run) → fire it → assert the run reuses the session
  (`forceFreshSession` false / no `closeSession`) and runs the failed step to
  the skill's end with the seeded scope, not the whole test.
- **Cache bypass:** a scope-seeded re-run does **not** replay a cached plan for
  the seeded tail steps (assert the AI is re-invoked / cache is bypassed), so an
  edited value that changes targeting actually re-plans.
- **Liveness pre-flight:** with the server session closed (e.g. a prior browser-
  closing step or Close Session), the re-run aborts with a clear message and
  does **not** launch a blank browser.
- **Multi-test ownership:** Test A (cats) and Test B (dogs) both fail in the
  shared skill; the retry seeded for the active test carries that test's values.

## 7. Status & remaining decisions

A code-grounded review (folded into §1–§6 above) found the motivation and data
model sound but surfaced four load-bearing pieces the first draft underweighted.
All are now in the design; **none is optional**:

1. **Frame-qualified "start partway into a skill body"** (§4.3) — the largest
   net-new piece, client line-model + server slice. Not a field rename.
2. **Cache bypass for the seeded tail** (§4.3.1) — else edits silently replay a
   frozen plan. Correctness, not optimization.
3. **Mandatory `getSession` pre-flight** (§4.5) — else a dead session runs the
   tail on a blank page.
4. **Frame-scope-sourced editable panel** (§4.4) — the document-sourced panel
   can't represent most in-skill captures.

Decided:

- **Top-level skills only in v1.** Re-running a step inside a *nested*
  (non-top-level) skill is out of scope for the first cut; the action is offered
  only when the failed frame is a top-level `[skill:]` invocation.
- **Refuse on internal-var dependency.** If a tail step depends on a value a
  *skipped* earlier step would have produced as an internal `__skillN_x` var
  (§4.3), the partial re-run is **refused with a clear message** rather than run
  as a half-bound tail. (Pure-`out.*` skills and the first-step case are
  unaffected.)

Still deferred:

- **Param editing (re-expansion).** Params stay read-only in v1; changing one
  needs re-expanding the invocation. Logged here so we don't lose it.
