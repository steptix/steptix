# Run and compile a single skill step, against a chosen session

Lets the user put the cursor on one step inside a skill file and **run just
that step** — or **compile just that step** — against a browser they pick:
the session of a test that failed inside this skill, any other open session
of a test that calls it, or a fresh standalone one.

Third sibling of
[skill-step-rerun-with-variables.md](skill-step-rerun-with-variables.md)
(paused-on-error: re-run from the failed step to the end of the skill, from
the Variables panel) and
[skill-debug-after-stop.md](skill-debug-after-stop.md) (Stop: run a
selection of skill steps against the stopped test's live session). This spec
adds the two things neither covers: a **single-step** run unit surfaced in
the skill file's own gutter, and **compile** riding the same slice — so a
skill step can be turned into code-behind from the very session where it
failed, sitting on exactly the right page.

## What we're building

The scenario, in the user's words: test step 1 invokes a skill called
`login`; the skill has six steps (enter username, enter password, click
next, …); step 4 fails. They want to execute just step 4, and to compile
just step 4.

Right-clicking step 4 in `login.md` → **Run Step Here** (or **Compile This
Step**) opens a picker instead of acting immediately:

```
Where should step 4 of login run?
⏸ checkout.md — paused at this step          (its browser sits on the login page)
⏹ signup.md — stopped inside login
▶ orders.md — session open (calls login at line 3)
＋ a fresh standalone session
```

Pick `checkout.md`: step 4 runs in checkout's browser — the one already
sitting where step 3 left it — with checkout's `[skill: login
username="…"]` arguments and checkout's captured variables. Pass or fail
paints the gutter in `login.md` as skill-body runs already do. Compile This
Step does the same run with `compile: 'steps'` riding it: the fresh
transcript is the recording, one generation call, and a one-entry diff opens
for `login.steps.ts`.

The answer to "two tests use this skill in two different browsers — which
one will it use?" is therefore: **the one you point at, every time.** The
picker is mandatory, the rows are labeled with each test's state, and
nothing is ever chosen silently.

## 1. Background — what exists, and the gap

- **Paused-on-error** (merged, 05e40bd): the Variables panel offers "re-run
  from the failed step", seeding the captured scope (editable) — but the run
  unit is failed-step → end of skill, and the affordance lives on the test's
  panel, not the skill file.
- **Stop** (merged, dd704e1): `performStop({setSkillDebug})` parks a single
  registry-level context; "Run selected skill steps on stopped session" runs
  an editor-selection slice (`startAt`+`endAt`) against the stopped test's
  live session with live/accumulating variables. A selection of one line is
  already a single-step run — but only after a Stop, only for the
  latest-stopped test, and never with compile.
- **Compile This Step** (merged, compile-as-you-go): `compile: 'steps'` runs
  the clicked steps in the *document's own* session and generates entries
  from the fresh transcript. In a skill file "the document's own session" is
  a **standalone** one — a fresh browser on about:blank with no parameter
  values (skills declare parameter names, not values;
  [enter_email.md](../../../templates/init/skills/flows/enter_email.md)
  shows the shape). Right for developing a self-contained skill; wrong for
  debugging a failure that happened inside a test.

The wire already carries everything: `POST /sessions/:id/steps` accepts
`startAt`, `endAt`, `seedScope`, `compile`, `compileScope` with no guard
against combining a slice with a compile
([api-server.ts:749-838](../../../src/server/api-server.ts#L749)). No
command has ever combined them; that combination — plus the picker — is
this feature.

## 2. Decisions (user-set, 2026-08-26)

- **Targeting = always a picker.** Every invocation of the step commands in
  a skill file opens the session picker. Eligible test sessions are listed
  first — anchored ones (paused in this skill / stopped in this skill)
  labeled with their state — and "a fresh standalone session" is the last
  row. No silent selection, even when only one candidate exists.
- **Menu shape = one pair.** The existing **Run Step Here** and **Compile
  This Step** commands are repointed *in skill files only* to open the
  picker. No new command ids for the gutter; the standalone behaviour
  becomes the picker's last row (one extra click). Test files are untouched.
- **Variables = live from the chosen session** (the Stop-path model):
  re-expansion re-inlines skill input params from the chosen test's
  `[skill:]` call line; captures resolve from that session's
  `session.outputs`, which accumulates across runs. No `seedScope` on this
  path — editing a value before a re-run stays where it is today, on the
  Variables panel's paused-failure flow.

## 3. Design

### 3.1 Skill-file detection

The fork ("this document's step commands open the picker") applies to
documents that are skills: markdown with `## Steps` that either declares
`type: skill` in frontmatter (`parseFrontmatter` exists in runner-core;
compare case-insensitively — the two current call sites disagree on that
and this adds a third, so settle it) **or** lives under the project's
skills directory (`resolveProjectDirs`) — because the server's `loadSkill`
never checks frontmatter, a frontmatterless file in `skills/` is fully
invocable as a skill, and detection by frontmatter alone would silently
leave its step commands on standalone behaviour with no hint the picker
exists. Test files — including tests that merely *have* sections — keep
today's behaviour verbatim. Detection is a small pure helper beside the
command layer; no change to `ActiveFileTracker`'s notion of a testbench
document (skill files must remain first-class documents so their
controllers, decorations and standalone runs keep working).

### 3.2 Candidate enumeration

On invoke (not continuously — no background scanning), build the picker
rows in this order:

1. **Paused-in-this-skill**: every open controller whose
   `lastSkillFailure.skillUri` is this file. Label
   "⏸ <test> — paused at this step" when `skillLine` matches the clicked
   line, else "paused at step N". Carries `testUri` + `testLine` (the call
   line) from the parked failure.
2. **Stopped-in-this-skill**: `registry.skillDebug` when its `skillUri` is
   this file and no row from (1) already names the same test. Label
   "⏹ <test> — stopped inside <skill>". Carries `testUri` + `testLine`.
3. **Other open sessions of callers**: every other open controller whose
   document invokes this skill (client-side parse of its step lines for
   `[skill: <name-or-path>]`, resolved with the same helpers
   go-to-definition uses — `canonicalSkillName` + the project's skills
   dir) and which probably has a session open. "Probably" is a new,
   named surface: `RunController` today exposes no session-open state
   (`activeSessionId` is nulled when each run ends; the interactive id is
   just the file path). The controller grows a getter over its
   config-sent-for-session marker — set when a stream has answered,
   cleared on close/recycle — as the enumeration signal, with the
   post-pick liveness pre-flight as the truth. Label "▶ <test> — session
   open (calls <skill> at line L)". A test that invokes the skill on two
   lines yields **one row per call line** — the call line decides the
   input params, so it is part of the target, not a detail.
4. **Standalone**: "＋ a fresh standalone session" — today's behaviour,
   exactly (the skill file's own controller and session).

Rows 1–3 are candidates, not promises: the **liveness pre-flight**
(`isRerunSessionLive`) runs after the pick, and a dead session refuses with
the existing message (clearing the skill-debug context when it was row 2's)
rather than silently spawning a blank browser. A running controller
(`isRunning`) is excluded at enumeration — a session mid-run cannot accept
an injected step. So is a controller whose **document is closed**: the
registry never deletes controllers, so one can outlive its editor
indefinitely with a stale buffer and a `testLine` that no longer names the
`[skill:]` call — the enumerator filters on `document.isClosed`, and a
picked row whose call line no longer resolves refuses rather than running
the wrong line.

An empty picker cannot happen: row 4 is always present. When rows 1–3 are
all absent the picker still opens with the one standalone row plus a
disabled note ("no open test session calls this skill — run a test first to
debug against its browser"), so the user learns the mechanism exists.

### 3.3 The run unit — one step, or a selection

Same resolution as the Stop-debug flow: the clicked line when there is no
selection; the selection's step lines when there is one (`startAt` = first,
`endAt` = last — the slice is a contiguous range, gaps included, as today).
For the plain click this collapses to `startAt === endAt`: a true
single-step run. Non-step lines refuse with the existing messages (inert
steps included).

### 3.4 Routing a test-session pick

Reuses `runSkillStepsOnStoppedSession`'s wiring, minus the context gate:

```ts
controller = registry.controllerForUri(testUri)   // the picked row's test
controller.runLines([testLine], {
  isContinuation: true,          // preserve status marks + the registry skillDebug context
  rerun: { startAt: { uri: skillPath, line: first },
           endAt:   { uri: skillPath, line: last } },
  ...(compile && { compile: 'steps' }),            // Compile This Step only
})
```

**Required change — decouple continuation status from compile threading.**
`isContinuation` today does two compile-load-bearing things this flow must
not inherit ([run-controller.ts:2040-2042](../../src/extension/run-controller.ts#L2040)
and [:2087-2089](../../src/extension/run-controller.ts#L2087)):
a continuation *inherits `compileModeOfRun`* — so a plain Run Step Here
pick after the picked test's last fresh run was Run & Compile would
silently ride with `compile: 'run'`, spend a generation the caller never
sees, and (because `'run'` writes the recording wholesale,
[session-manager.ts:4457](../../../src/server/session-manager.ts#L4457))
**replace the test's whole recording dir with a one-step recording** — and
its first block is stamped *`compileContinues: true`*, which makes the
server re-open any `session.liveCompile` left from a previously *completed*
compile (the successful-`finish` path never clears it) instead of taking
the supersede branch, growing the old plan and re-proposing accumulated
files rather than the promised one-entry diff. The fix: `runLines` learns
to distinguish "resuming the same logical run" (Continue/Resume — keeps
both behaviours) from "injecting a new run that preserves state" (this
picker and both merged siblings): injected runs declare compile intent
explicitly — `'steps'` for a compile pick, none for a run pick, never
inherited — and never stamp `compileContinues` on their first block, so
the server's supersede branch discards any retained compiler. **This also
fixes a latent bug in the merged Variables-panel and Stop-debug flows**,
which send bare `isContinuation: true` and are exposed to the same silent
compile + recording clobber whenever the last fresh run was Run & Compile.

**A ⏸ pick consumes the paused anchors.** `runLines` unconditionally
clears the parked paused-on-error ▶ and `resetFrameState` wipes
`scopesByFrame` + `lastSkillFailure` even on a continuation — only status
marks and the registry-level `skillDebug` context survive. So after an
injected run that *passes*, the test demotes from a ⏸ row to a ▶ row on
the next picker invocation, Continue on the test refuses (nothing is
parked any more), and the Variables panel's edit-and-re-run affordance is
withdrawn (the panel must be told — a clearing `skillRerunAvailable` —
rather than left offering a stale action that refuses). An injected run
that *fails inside the skill* re-parks fresh anchors via the normal
`recordSkillFailure` path and the test stays a ⏸ row. This is the honest
trade of running against live, accumulating state; the spec's division of
labour ("variable edits stay on the Variables panel") holds only until
the picker is used on that failure, and says so.

**Breakpoints in the skill file are suppressed for the injected slice.**
Skill-file breakpoints ride every request via the breakpoint provider and
would server-side-pause the slice — a one-step run pausing at its only
step runs nothing and (with compile) proposes nothing. The injected
request suppresses them, matching Compile This Step's existing posture.

What the existing machinery already gives this for free:

- **Re-expansion** re-reads the skill from disk (`clearSkillCache` per
  request) and re-inlines input params from the test's call line — the
  picked test's `username`, not the other test's.
- **Cache off**: any `startAt` request bypasses the per-step cache
  ([session-manager.ts:2803](../../../src/server/session-manager.ts#L2803)),
  so an edited step re-plans — and, for compile, so the transcript is
  fresh. (The step cache this referred to was removed; every step now
  re-plans anyway.)
- **Variables** resolve from the live `session.outputs` (no `seedScope`);
  captures written by this run sweep back, accumulating.
- **Guards**: the `{{__skill*}}` internal-var refusal (a single step that
  consumes an earlier in-skill capture refuses — select the producing step
  too, e.g. 2–4); the `sectionedSkillRefusal` (skills defining inline
  sections cannot be line-anchored — measured hazard, both siblings refuse,
  this flow refuses identically); `endAt`-not-found hard-errors. The
  `{{__skill*}}` refusal's *wording* is updated: today it advises "Use
  Continue to re-run the whole skill instead", which is wrong advice from
  a skill-file gutter — it now suggests selecting from the producing step.
- **Group snap**: `startIndex` snaps up, `endIndex` extends down — a
  single-step click inside a step group runs the whole group, which is the
  only runnable unit there.

The skill document is saved first if dirty (the server expands it from
disk; for compile, the diff and recording must describe what is on disk).
Statuses paint through the existing frame plumbing — the run descends
through the test's `[skill:]` call, so `login.md` gets its ✓/✗ marks the
same way any skill-body run does.

A pick of the **standalone** row routes to today's code path unchanged:
the skill file's own controller, `runLines([lines])` /
`runAndCompile({lines, mode: 'steps'})`.

### 3.5 Compile riding the slice

`compile: 'steps'` + `rerun` on one request — the combination that has
never been sent. Server-side it decomposes into pieces that all exist:

- `'steps'` mode already disables code-behind execution for the request
  (the step must run under AI to leave a transcript) and already builds the
  **generation registry** separately. For this flow that registry is built
  from `expansionForBinding()` — the run's own expansion — which contains
  the **real skill frame**, so `bindingFor(i)` on a skill-body step
  resolves the defining site to the *skill* file: entries land in
  `login.steps.ts` keyed by the skill's authored text, exactly where a
  whole-test compile binds them. **No `compileScope`, no synthesized
  frame** — the section-body special case does not apply, because unlike a
  detached section-body run this slice executes *inside* the real frame.
- **Occurrence is counted over the full expansion**, not the sent slice —
  the request expands the whole skill body and bounds only the execution
  loop — so a repeated step text numbers correctly and the
  partial-selection-of-a-repeated-step refusal that Compile This Step
  needs in test files is unnecessary here.
- **The compile summary must be slice-aware — in three places, not one.**
  `LiveCompiler`'s plan is built over all `effectiveSteps` with
  `inScope: request.compile === 'steps'`; a slice bounds execution, so
  out-of-slice steps are never offered. Three separate consumers then
  misreport them: the plan's `inScope` (fix: mark only in-slice steps —
  the plan itself **stays full-length**, because `offer` and the
  whole-test prompt index it by absolute expanded position); the
  `notAttempted` computation at finish, which walks `1..stepsTotal` over
  the **full expansion** independently of the plan (fix: bound it to
  `[startIndex, endIndex]`, or "compile step 4 of six" reports
  "5 step(s) not attempted"); and `summary.totalSteps = plan.length`,
  which would caption the notification "1 of 6 step(s) as code" styled as
  a warning (fix: `totalSteps` counts in-scope steps, so a clean
  single-step compile reads "1 of 1" and is not `partial`-styled). The
  slice bounds are computed once, before the compiler is constructed
  (today they are computed after — hoist or late-bind).
- **A refusal must terminate the compile it rides on.** Three slice paths
  return early after the compiler exists — `startAt` anchor not found,
  `endAt` anchor not found, the `{{__skill*}}` refusal — and none of them
  is a throw, so `discardLiveCompile` never fires: no `compile:result` is
  emitted, the extension's no-outcome branch answers with the *wrong
  diagnosis* ("Is the server on a build that supports Run & Compile?"),
  and `session.liveCompile` is left holding an unfinished compiler for
  the next request to trip over. Every pre-loop refusal in a compile-mode
  request disposes (or finishes-with-error) the live compiler and emits a
  terminal `compile:result`, so the step's own refusal is the only
  message the author sees. Unreachable today only because no command
  combines `compile` with `startAt`; this feature is that combination.
- **Recording splice**: the fresh one-step transcript splices into the
  *picked test's* recording dir
  (`.aiui-codebehind-cache/<test>.recording/`), replacing that step's JSON
  + DOM files and stamping `recordedAt`, siblings untouched — the merged
  splice mechanics. **The splice identity gains the binding's target
  file.** Verified: today's identity is `(section, source, occurrence)`
  with no file or frame discriminator, and a skill-body step binds with
  no section and per-frame occurrence 0 — the same key as a *test-frame*
  step of identical authored text, so a splice would claim the first
  matching slot in file order and can overwrite the test step's recording
  while the skill step's slot keeps stale content. `RecordedStep` (and
  the last-run sidecar rows) carry the binding's target file, matched in
  `spliceRecording` **and** in `priorFailure`'s sidecar lookup (same
  conflation, second victim: repair could be fed the wrong step's
  failure), falling back to today's key for recordings written before
  this.
- **Repair parity** holds: in `'steps'` mode the failure that feeds
  `buildRepairPrompt` comes from the last-run sidecar on disk, matched by
  binding identity. The sidecar is the *picked test's*
  (`<test>.last-run.json` — sidecars are per test, with skill-step rows
  inside; a skill-adjacent sidecar exists only for standalone runs of the
  skill document), which is the right one: it is where that test's last
  run recorded the entry's failure.
- **The client-side compile gates do not apply to test-session rows.**
  `resolveCompileTarget`'s repeated-step refusal and its
  `sectionOwningLine`-derived `compileScope` belong to the detached
  test-file path; the slice path counts occurrence over the full
  expansion server-side (the gate would spuriously refuse) and must send
  **no `compileScope`**. The standalone row keeps today's gates verbatim.
- **One entry, one diff**: no Review pass (`'steps'` behaviour), the diff
  proposes `login.steps.ts` with the entry spliced. The proposal
  notification names the session it recorded against ("recorded in
  checkout.md's session") — the shared-file caveat made visible: this
  entry will also serve every other caller, values never leak into it
  (leak guard + `step.getVar` discipline, skill-arg resolution per
  PR #87), and a caller it happens not to fit flags it ⚠ stale on their
  next run rather than breaking silently.
- **The compile lock** keys on the *test* file (the session's
  `testFilePath`), as every compile-in-session does. Two tests compiling
  the same skill concurrently therefore both proceed and both propose
  `login.steps.ts` — the same last-Apply-wins exposure the whole-skill
  compile already has from two tests' Run & Compile; the diff is
  user-mediated, accepted for v1, noted here so it is a decision rather
  than a surprise.

The extension side needs `runAndCompile` generalized to take an explicit
controller + `rerun` slice (today it is welded to `registry.active()`).
Three details the generalization owns, beyond the routing:

- **Two dirty documents, two saves.** `runAndCompile` saves the
  controller's document — the *test* on this path; the skill document
  (the one whose step is compiled, whose diff and recording must describe
  disk) is a second, separate save.
- **Apply returns to the skill file.** `applyCodeBehind` reopens the diff
  record's `testFilePath` — the test; the pending-diff record grows a
  return-target so a compile invoked from a skill file lands the author
  back in the skill.
- **Stop and Pause must reach the injected run.** Both act on
  `registry.active()` — with the skill file focused that resolves to the
  skill's *idle* controller, so Stop would wipe UI state while the
  injected compile keeps running on the test's controller. They fall back
  to `registry.runningController()` when the active controller isn't
  running (the routing rule `dispatchStep` already uses). Inherited from
  the merged Stop-debug flow, where it could strand a run; here it could
  strand a compile.

`presentCompile` and the diff flow are otherwise reused as-is.

### 3.6 What the picker pick does NOT do

- No `seedScope`, no variable editing — the Variables panel's
  paused-failure flow keeps that job.
- No re-run-to-here: the step runs against wherever the picked browser
  sits. That is Run Step Here's contract in test files, verbatim, and the
  labels make the state visible ("paused at this step" = the browser is on
  the right page). Picking `orders.md — session open` and compiling step 4
  cold may fail or record the wrong page — visibly, in the window the user
  is watching, proposing nothing for the failed step.
- No cross-test writes beyond the shared `.steps.ts` that skills already
  are: the run touches only the picked session.

## 4. Edge cases

| Scenario | Behaviour |
|---|---|
| Two tests paused inside `login` | Two ⏸ rows; the pick decides — no precedence rule |
| Same test paused in `login` AND holding the stop context | One row (paused wins the label; same session either way) |
| Test invokes the skill at two lines | One row per call line ("via line 3" / "via line 7") |
| Picked session died since the pick was offered | Liveness pre-flight refuses with the existing message; skill-debug context cleared if it was that row |
| Picked test's controller is running by pick time | Refuse ("a run of <test> is in progress"), matching the compile guard's wording |
| Clicked step consumes an earlier in-skill capture (`{{__skill*}}`) | Server refuses (existing guard); message suggests selecting from the producing step |
| Skill defines inline sections | Refuse (existing `sectionedSkillRefusal`) for test-session rows; the standalone row still works (no line anchoring involved) |
| Selection spans lines outside the skill body | Clamp to body step lines (Stop-flow behaviour) |
| Compile picked, generation declines (bracket-marker step, no page actions) | `ai: true` entry with the reason — unchanged decline path |
| Compile picked, the step fails in the session | Run fails visibly; nothing proposed for the failed step (compile-as-you-go rule) |
| Skill file is dirty | Saved before the run (the test document too, on a compile — two saves) |
| ⏸ pick runs and **passes** | The paused anchors are consumed: parked ▶ cleared, `lastSkillFailure` wiped, Variables-panel affordance withdrawn (panel told, not left stale); test shows as ▶ row next time |
| ⏸ pick runs and **fails in the skill** | Fresh anchors re-park via `recordSkillFailure`; the test stays a ⏸ row; edit-and-re-run works on the new failure |
| Breakpoint set inside the skill body slice | Suppressed for the injected request — a one-step slice pausing at its only step runs (and proposes) nothing |
| Picked test's document was closed | Row filtered out (`document.isClosed`) — controllers are never deleted, so "has a controller" proves nothing; a stale `testLine` that no longer names the call refuses |
| Test is parked at a BREAKPOINT (mid Run & Compile, awaiting Continue) | Not a candidate at all: an injected run clears its resume marker and supersedes its retained compiler, so picking it would strand a run the author is in the middle of and discard entries already paid for. Re-checked after the pick, for the window between |
| Test is paused ON ERROR inside this skill | A ⏸ row, and picking it consumes those anchors by design (§3.4) — that is the debugging loop the feature exists for |
| Skill step is inside the skill's own `### Section` body | Runs: lines are classified, so a `section-step` is a step here as it is everywhere else. Test-session rows still refuse via `sectionedSkillRefusal`; the standalone row works |
| `login.steps.ts` diff left unapplied, second compile of another step | Fresh compile supersedes the abandoned one (existing `discardLiveCompile` path); the second diff carries only the second entry against disk |

## 5. Testing

- **Picker enumeration (unit)**: paused/stopped/open-caller/standalone rows
  in order; per-call-line rows; running controllers excluded; no candidates
  → standalone row plus the note. Pure function over registry state — no
  VS Code host needed if the enumerator takes plain data.
- **Routing (integration, FakeApiClient)**: pick a ⏸ row → the request goes
  to that test's session id with `startAt === endAt` at the clicked line
  and `isContinuation`; pick standalone → the skill controller's own
  session; two tests paused → both rows present, the picked one is hit.
- **Compile slice (server, vitest)**: `compile: 'steps'` + `startAt`/`endAt`
  through the HTTP seam: only the sliced step executes; the proposal
  touches only the skill's `.steps.ts`; the entry's identity (file,
  source, occurrence) matches what a whole-test compile of the same step
  produces; the summary reports the slice honestly — `totalSteps` counts
  in-scope steps ("1 of 1"), `notAttempted` is bounded to the slice, and
  a clean single-step compile is not `partial`-styled; recording splices
  into the test's dir with siblings untouched.
- **Continuation decoupling (regression, all three flows)**: an injected
  run on a controller whose last fresh run was Run & Compile carries NO
  compile mode and NO `compileContinues` — asserted for the picker run,
  the Variables-panel re-run, and the Stop-debug run (the two merged
  flows share the latent bug); and a compile pick after a *completed*
  Run & Compile of the same test proposes exactly one entry (the retained
  compiler was superseded, not reopened).
- **Refusal terminates the compile (server)**: each early-return refusal
  (`startAt` not found, `endAt` not found, `{{__skill*}}`) on a
  compile-mode request emits a terminal `compile:result`, leaves no open
  `session.liveCompile`, and the extension surfaces the refusal itself —
  not the "older server?" misdiagnosis.
- **Splice identity collision (regression)**: a recording holding a
  test-frame step and a skill-frame step with identical authored text —
  the skill-step splice replaces the skill row only; `priorFailure`
  resolves the skill row's failure, not the test row's; a pre-change
  recording without the file field still splices via the fallback.
- **Anchor consumption (integration)**: a passing ⏸ pick clears the
  parked failure, withdraws the panel affordance, and demotes the row; a
  failing one re-parks and the row stays ⏸.
- **Occurrence regression**: a skill body with a repeated step compiles the
  second occurrence correctly from a single-step slice (full-expansion
  numbering).
- **Guard reuse**: `{{__skill*}}` dependency refusal, sectioned-skill
  refusal, dead-session refusal — one test each through the new entry
  point, asserting the existing messages.
- **Live (one scenario)**: drive `securebank.md`-style test to a skill-step
  failure, Stop; from the skill file compile that step against the stopped
  session; assert one-entry diff for the skill's `.steps.ts`, recording
  spliced, and a following run of the test serves the step as code.

## 6. Deferred

- **Editing a variable at the picker** (send a one-off `seedScope`) — the
  Variables panel path already covers the paused case; a picker-level edit
  needs a value UI the quick-pick doesn't have.
- **Nested skills** — inherited non-goal of both siblings.
- **Sessions of tests in other VS Code windows** — controllers are
  per-window; the server may hold sessions this window can't see. The
  picker shows this window's candidates only. Same blind spot after a
  window reload: the config-sent marker is controller-lifetime, so a
  still-live server session from before the reload won't enumerate (the
  anchored rows are gone too — anchors don't survive a reload either).
- **Cross-file compile-lock** (locking the target `.steps.ts` rather than
  the test) — v1 keeps the per-test lock and the user-mediated diff.
- **Re-run to here before the step** (auto-running steps 1–3 to set the
  page up) — the selection already covers it manually.

## 7. What the spec review changed (2026-08-26)

An adversarial review of the first draft against the code confirmed the
core bet — no wire guard blocks `compile` + `startAt`/`endAt`; the
generation registry binds a skill-frame step to the skill's `.steps.ts`
with full-expansion occurrence; the per-test compile lock and the
`compile:result` delivery behave exactly as claimed — and found six
things the draft had wrong or missing, all folded in above:

1. **`isContinuation` was not a neutral flag** (§3.4): it inherits
   `compileModeOfRun` and stamps `compileContinues`, which would have made
   a plain run pick silently compile-and-clobber and a compile pick reopen
   a stale retained compiler instead of superseding it. Decoupling is now
   a required change — and fixes the same latent bug in both merged
   sibling flows.
2. **Slice-aware `inScope` was a third of the fix** (§3.5): `notAttempted`
   and `totalSteps` are computed independently of the plan and needed
   their own bounding; the plan itself must stay full-length.
3. **Early-return refusals strand the compiler** (§3.5): no
   `compile:result`, a misleading "older server?" message, and an open
   `session.liveCompile`. Refusals in compile mode now terminate the
   compile.
4. **The splice identity really does collide** (§3.5): verified — no
   file/frame discriminator, first-slot-in-file-order claiming, and the
   same conflation in `priorFailure`. The identity gains the binding's
   target file; the draft had only floated a "verify" note.
5. **A ⏸ pick consumes the paused anchors** (§3.4): the draft said "keep
   anchors"; only status marks and the registry context survive. The
   consumption semantics are now stated, with the panel told to withdraw
   its affordance.
6. Smaller corrections: skill detection also checks the skills dir
   (frontmatterless skills are invocable, finding the fork would silently
   miss them); row 3 needed a new session-open surface on the controller;
   the closed-document filter (controllers are never deleted — the
   draft's "cannot happen" was false); Stop/Pause routing to the running
   controller; the sidecar-location sentence (per test, which is the
   right sidecar anyway); skill-file breakpoints suppressed for the
   slice; the `{{__skill*}}` refusal's wording.

## 8. What was built (2026-08-26)

Everything above, plus one hazard the build itself found: **a partial slice
of a repeated step is refused server-side.** `spliceEntry` places an entry
at `spans[occurrence]` and APPENDS when the slot does not exist, so
compiling only the second "Press the go button" of a skill into an empty
file would write an entry that reads as occurrence 0 and serves the FIRST
step. The client's `resolveCompileTarget` gate never runs for skill files,
so the server refuses before anything runs — unless every earlier
occurrence is inside the slice (the queue generates in order) or already
has an entry (a replacement, not a placement).

Where the build deviated or settled details the spec left open:

- The two anchor-not-found refusals terminate the compile from *before*
  the compiler exists (they emit the same failed `compile:result`), and the
  skill-expansion failure joins them — a compile pick on a mid-edit broken
  skill is this feature's own loop.
- `isResume` is the new `runLines` flag for true Continue/Resume/step
  dispatch; compile inheritance and the first block's `compileContinues`
  key on it alone. The merged Variables-panel and Stop-debug flows send
  bare `isContinuation` and are covered by the same fix.
- The recording splice's file tie-break lives in the CLAIM, not the key
  (`claimSlot`): a filed step claims its own file's slot, then an unfiled
  (pre-field) slot, never another file's; an unfiled incoming step keeps
  the old first-in-file-order behaviour.
- The picker enumeration is a pure module (`skill-run-targets.ts`,
  `node --test`-able like `sections.ts`); the QuickPick is replaced by a
  `setSkillSessionPicker` test hook in integration runs.
- The panel withdrawal happens only when the injected run left no fresh
  failure parked (a failing pick re-parks and re-posts on its own).

## 9. What the code review changed (2026-08-26)

A max-effort review of the merged-shape branch (ten finder angles over the
diff, then verification) found fifteen defects. All are fixed; several were
regressions this feature introduced into flows that already worked.

**The three that broke existing behaviour.** Stop's widened controller
routing was shared with Close Session, so closing an idle test's session
stopped whatever else was running — Stop now opts in (`preferRunning`) and
Close Session keeps the active controller. The picker offered a
breakpoint-paused test as a row, and picking it cleared that test's resume
marker and superseded its retained compiler, losing entries the author had
already paid for; parked controllers are no longer candidates, with a
post-pick re-check for the window between. And the picker gated on
`extractSteps`, which reports only `kind: 'step'`, so a step inside a skill's
inline `### Section` body was refused as "not a step" on both commands —
lines are classified now, and body steps run as they did before.

**The corruption the guard was guarding.** `spliceEntry` silently appends
when `spans[occurrence]` is absent, which renumbers an entry to serve a
different step. The pre-run guard could not actually prevent it (an in-slice
earlier occurrence that declines or errors produces no entry either), so the
refusal moved to where the corruption happens: `spliceEntry` now throws when
`occurrence > spans.length`, covering every caller — the CLI, the boxed
compile and the writer — instead of one request shape. The pre-run guard
stays as the early, cheap refusal, now scoped to a fresh `'steps'` compile
(a `'run'` continuation carrying a slice was being refused, killing the
author's whole run — reproduced with an HTTP-seam test) and frame-aware
(occurrence is counted per frame instance, so a second invocation of the
same skill was mistaken for an unfinished earlier occurrence and refused
with advice no selection could satisfy).

**The identity work was half-wired.** `SKILL_CALL_RE` was `^`-anchored, so
every labelled call (`1. Sign in [skill: login]` — which the runtime
executes, keeping the prefix as the step's label) was invisible to the
picker and those tests simply never appeared; it also accepted
`[ skill : login]`, which the runtime rejects. Both measured against
`parseSkillCall`, and the shared `SKILL_INVOCATION_RE` now backs the editor
and matches the runtime on every spelling. The new `file` discriminator was
compared with raw `===` on absolute paths (drive case differs between
TestBench and CLI writers, as `compileLockKey` documents) and was never
written by the CLI's own last-run producer, which rewrites the sidecar
wholesale — so after any `aiui run` the conflation it exists to prevent came
straight back. Both fixed.

**Compile lifecycle.** `refuseOpenCompile` replaces the per-site pairing:
every compile-mode refusal now both discards the open compiler and emits a
terminal `compile:result`, including the two exits that had one half or
neither (a tool-catalogue failure answered with silence, which the client
reads as "is your server too old?"; a skill-expansion failure answered
without discarding a retained compiler). `compileModeOfRun` is written for
every non-resume run, so an injected compile records its own `'steps'`
instead of leaving a stale `'run'` for the next Continue to inherit, and a
terminal `'steps'` compile is cleared off the session so a later Continue
cannot append a test's tail to it and rewrite the recording wholesale.

**Client contract.** The picker's compile branch now resets and records
`lastCompileError` before its refusals (not after), applies
`runAndCompile`'s parked-at-pause guard before opening a diff, saves the
document before resolving anchors (a formatting save can move the step the
anchors name, and the sectioned-skill refusal reads from disk), runs the
same resolved range on every row so the prompt cannot mean two different
things, and re-syncs the Variables panel rather than blanking it — a
`null` post erased a second test's still-valid affordance, while the guard
that sent it skipped the open/stopped picks that consume anchors too.

Verified by running: root vitest full (incl. 8 new HTTP-seam slice tests in
`api-server-compile-mode.test.ts` — binding into the skill's file, "1 of 1"
summary, refusal→`compile:result`, occurrence guard both ways, plain-slice
regression — and 4 recording-collision tests); testbench unit 345 incl. 11
picker-enumeration tests; testbench integration 238 incl. 5 picker tests
(routing, both decoupling regressions, standalone row, cancel). Live
against the worktree server on :3105 + `fixtures/test-app`: a session
parked on the fixture page by a plain step, then a single-skill-step slice
with `compile: 'steps'` — only skill line 17 ran, one generation call
(7,631 tokens), the proposal touched only
`skills/flows/enter_email.steps.ts`, the code is `step.getVar('email')`-
driven (no literal leaked), the summary read `1 of 1 / notAttempted: []`,
and the recording spliced into the caller's dir with the entry's `file`
stamped.
