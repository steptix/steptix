# Compiling like a run

Builds on [codebehind-compile.md](codebehind-compile.md), which shipped the
compile pipeline, the server endpoint and the TestBench commands. This story
changes *how a compile behaves while it runs and what it leaves behind*.
Nothing about the file format, binding or the generation prompts changes; the
review pass gains one rule, which the build found it needed (see "What was
built").

## What we're building

Today a compile is a box. You press **Compile Code-behind**, the Runner panel
prints "Record — running 9 step(s) under AI", a browser window opens, walks
the test, and when step 5 fails the window vanishes and the panel says
"Record failed — step 5 … There is nothing to compile until the test passes
under AI." Steps 1–4 passed, the model saw every one of them, and nothing was
written for any of them. The same happens at the other end: a replay that
never goes green throws away every entry that *did* replay, into a gitignored
`.candidate` file nobody opens.

After this story, a compile looks and behaves like a run:

- **The gutter moves.** ▶ walks the steps while the model generates them,
  the Record run paints ✓/✗ as any run does, and each Replay round paints ⚙
  on every step that passed as code and ✗ where it stopped, with the error.
- **The browser is yours.** Record runs in the editor's own session, so the
  window is the one you always watch, and it stays open where the run ended —
  exactly as after pressing Run. Most of the time there is no Record at all:
  the run you just did *is* the recording.
- **What passed is written.** A compile proposes every entry it produced, in
  the diff, every time. If the test fails under AI at step 5, you get steps
  1–4 compiled and proven, and a message saying what to do about 5. If a
  replay round dies at step 7 after three repairs, you get 1–6 proven, 7 as
  `ai: true` with the error, and 8–9 as code that the next run will prove.

Example. The author has `tests/checkout.md`, runs it from TestBench, and it
fails at step 5 under AI — a wrong button label. They press **Compile**
anyway. The Runner panel shows:

```
Compile checkout.md
  Select      9 step(s) to generate, 0 kept, 0 already AI
  Record      using this session's last run — it failed at step 5; compiling 1–4
  Generate    4 step(s)
              step 1 generated                   ▶ on line 12 while it works
              step 2 generated
              step 3 generated
              step 4 generated
  Review      revised checkout.steps.ts
  Replay 1    running 4 step(s) as code
              ✓ step 1 (line 12) code-behind     ⚙ lands in the gutter
              ✓ step 2 (line 13) code-behind
              ✓ step 3 (line 14) code-behind
              ✓ step 4 (line 15) code-behind
              4/4 passed as code
  Write       checkout.steps.ts

◐ Compiled checkout.md: 4 of 9 step(s) as code.
  Step 5 failed under AI — "Add to cart" button not found. Steps 6–9 not attempted.
  Fix step 5, run, and compile again for the rest.
```

The diff opens for steps 1–4; they **Apply**. They fix the label on step 5
and press Run: 1–4 paint ⚙ in about a second and cost nothing, 5–9 run under
AI, the run is green. They press Compile again:

```
Compile checkout.md
  Select      5 step(s) to generate, 4 kept, 0 already AI
  Record      using this session's last run (9 steps, green 1 min ago)
  Generate    5 step(s)
              …
  Replay 1    running 9 step(s) as code
              ✓ step 1 (line 12) code-behind
              …
              ✗ step 7 (line 18) — locator timeout on [data-test="promo-code"]
  Repair      step 7 regenerating from the failure
  Replay 2    running 9 step(s) as code
              …
              9/9 passed as code
  Write       checkout.steps.ts

✓ Compiled checkout.md: 9 of 9 step(s) as code, 4 unchanged
```

No second AI run of the test anywhere in that loop. Two compiles, two diffs,
and the tokens spent were for generation, not for re-watching steps the
author already watched.

## Context — what the box gets wrong

Three things, all of them choices in codebehind-compile.md rather than bugs:

1. **Record is a throwaway run.** The server's compile runner drives Record
   and Replay through the session machinery — the same headed browser a Run
   gets — but in a fresh `compile:<uuid>` session that is closed in a
   `finally` the moment the run ends ([compile-runner.ts](../src/server/compile-runner.ts)).
   The window opens, walks the test, and on a failure disappears, leaving
   nothing to look at. A Run leaves its session open on the failing page.

2. **The inner runs are muted.** Record and Replay emit `step:start` /
   `step:pass` / `step:fail` with real line numbers — the compile runner
   passes `sourceLines` — and its listener drops all of them except
   `step:fail`, which becomes a `[warn]` text line. The story's reason was
   "nothing in a compile has a line number". That is true of Generate and
   Review and false of Record and Replay, which run the actual test; and even
   Generate works on a step that has a line.

3. **All or nothing.** A Record that fails at step *k* generates nothing
   (`Record failed … nothing to compile until the test passes under AI`), and
   a Replay that never goes green returns an empty `files` map, so the entries
   that did replay go to `.aiui-codebehind-cache/<name>.steps.ts.candidate`
   and TestBench never shows them. The rule was chosen so only proven code
   lands. But the runtime already has the safety net the rule was standing in
   for: an entry that throws heals under AI and is flagged ⚠ for the next
   compile. The worst case of writing an unproven entry is one heal. The
   worst case of the rule is a whole compile's work discarded.

And one thing that made all three worse: **"Compile from this run" almost
never engages.** It needs the DOM either side of every step, which only a
compile's own Record captured. So every compile paid for a second AI run of
the test — the opaque one — even when the author had just watched it pass.

## Design

> **Amended by [codebehind-recording-on-disk.md](codebehind-recording-on-disk.md).**
> Ordinary runs no longer capture step context and the server no longer
> retains it: the compile's own Record is the recording, written to disk
> beside the test, and every compile records again. The sections below on
> capture-by-default and on reusing a session's last run are withdrawn; the
> gutter, the partial status and the rest stand.

### Ordinary runs capture what a compile needs

Generation needs three things per step: the action transcript, and the page
(DOM + URL) before and after. An ordinary run already keeps the transcript.
With `reports.includeDomSnapshots` on it already keeps the turn-1 DOM on the
step result too. What it does not keep is the post-step DOM — one extra
`captureDomSnapshot` per step, which the code puts at roughly 200ms–2s.

So `captureStepContext` becomes something a client can ask for. It moves from
`InternalRunOptions.codeBehind.captureContext` onto the wire as
`StepRequest.captureStepContext?: boolean`, and TestBench sends it on every
run. Of the four knobs codebehind-compile.md kept off the wire on purpose,
this is the one that only *retains* more; `candidateFiles`, `disabled` and
`strict` change what executes, and they stay internal.

The snapshots live where the compile already looks: `lastRunDetails`, which
the session manager retains for every server run, passed or failed, until the
next run replaces it, and which dies with the session. Size is bounded by
`domSnapshotCharLimit` × 2 × steps, the same ceiling the model's own prompts
live under.

**Cache hits capture too.** A step replayed from the action cache currently
skips the turn-1 DOM snapshot — no AI call, no consumer, and the single biggest
wall-clock win for cached replays. With `captureStepContext` on it takes it.
The cost is transitional by construction: code-behind executes ahead of the
cache, so a ⚡ step is an uncompiled step, and once compiled it is served by
code and captures nothing at all. The author pays 0.2–2s per cached step
until they press Compile, which is the point.

**A step served by code-behind captures nothing**, as today. It is not in
the default selection and has no transcript to generate from anyway.

### Record is a run

> **Withdrawn in part by [codebehind-recording-on-disk.md](codebehind-recording-on-disk.md):**
> the source-run rule below collapses to "Record, in the caller's session,
> every time". A red Record is still a prefix compile.

With the last run carrying context, the compile's source is decided like
this. The request names the editor's session (`sessionId`, replacing
`fromSessionId`), and the server looks at that session's last run:

- **Green, started at step 1, with context** → it is the recording. No Record
  phase. The stream says "using this session's last run (9 steps, green
  1 min ago)".
- **Red or stopped at step *k*, started at step 1, with context** → it is a
  recording of steps 1..*k*−1, and the compile is a **prefix compile** (below).
  The stream says so, and names *k* and its error.
- **Anything else** — no run yet, a run without context (an older client, or
  a subset batch such as a breakpoint continuation), or a selection that
  needs transcripts the run cannot have — → **Record runs in that session.**

Record in the editor's session means: the browser is the one the author
watches; it opens on a fresh file exactly as a first Run does; it stays open
where the run ended, on the failing page if it failed; and the events paint
the gutter through the same path a Run uses. It is not closed afterwards. A
compile may not start a Record in a session that is paused at a breakpoint —
it refuses and says to resume or stop first.

Record keeps code-behind **on** unless the selection includes a step that
already has a working entry (`--all`, or `--steps` naming one). Only then
does the run disable code-behind, because a step served by its entry leaves
no transcript. This is what makes the default compile cheap: with code-behind
on, a Record of a half-compiled test runs the compiled half as code.

The action cache stays as the project has it. A cached transcript is the
model's own actions, recorded earlier, and with the capture rule above it
now comes with the DOM either side; it is as good a recording as a fresh one.

The last-run sidecar follows the run's nature: a Record with code-behind on
is an ordinary run and writes it; a Record with code-behind off is excluded
as today, for the reason codebehind-compile.md gives — it would stamp "all
AI" over the findings the compile is acting on. Replays stay excluded.

The CLI is unchanged here: `aiui compile` has no session to reuse and
records in-process, as it does today.

### Every run is on the stream

Each inner run's events ride the compile stream as they happen:

```ts
{ type: 'compile:run'; phase: 'record' | 'replay'; round?: number; event: RunEvent }
```

Every event, `done` included, unchanged inside the wrapper. TestBench folds
`event` through the same path as a run's — ▶ on the running step, ✓ ⚡ ⚙ ✗ as
they land, captures into the Variables panel, the step lines into the panel.
⚙ comes for free: a strict replay's `step:pass` already carries
`fromCodeBehind`. So does the failure screenshot: the strict path already
takes one and `step:fail` already carries it. Between replay rounds the marks
reset the way they do when a new run starts, so the gutter shows *this*
round.

`compile:step` — the Generate and Repair events — gains `line` (and the
origin `frame` for a step inside a skill body, from the expansion the server
already holds), and TestBench paints ▶ on that line while the model works on
the step. The gutter walks the test during Generate too, which is most of a
compile's wall-clock.

The CLI prints the step lines under each phase in the same shape as
`aiui run`.

### Replay keeps its own sessions

Replay rounds still run in a fresh session each, closed after the round. Two
reasons, both still good. A round must start from a clean page, not from
wherever Record or the previous round left the browser. And a replay in the
editor's session would overwrite `lastRunDetails` — the recording the compile
is generating from — with a run that has no transcripts, so a second Compile
from that session would have nothing to work with.

What the author gets instead of a window is the gutter and the panel: ✗ on
the step, the error in the log, the failure screenshot on the event. That is
what the window showed today, for the instant before it closed.

### Write what passed

`CompileStatus` becomes `'green' | 'partial' | 'failed'`, and a compile
proposes its files on green **and** partial. Every proposal still goes
through the diff; Apply is still the author's act; the server still writes
nothing. The rules:

**Prefix compile.** When the source run failed or stopped at step *k*, the
selection is S ∩ {1..*k*−1}. Generate, Review and Replay work on that prefix —
the compile runner already sends its steps pre-expanded, and a prefix keeps
the expansion's indices aligned, so Replay simply sends fewer steps. Steps
from *k* on are not touched: they have no entry, so the next compile's default
selection picks them up by itself. Status is partial; the summary names *k*,
its error, and the steps not attempted.

**After the replay rounds**, each entry in S is in one of three states, and
the candidate is proposed as it stands:

| State | Written as | Meaning |
|---|---|---|
| proven | code | passed as code in the last round that reached it, not regenerated since |
| failed | `ai: true`, error as the comment | the step the final round failed on — the write-off codebehind-compile.md already does after `maxRounds`, applied to the last round's failure too |
| unreached | code, named in the summary | the final round never got there |

Status is green when the final round passed end to end (so a single never-
converging step, written off and confirmed, stays green as today) and partial
otherwise.

**A failure on an entry not in S** — the author's own code — still stops the
rounds; the compiler does not rewrite it. It proposes the proven prefix,
marks the step stale, and says "existing entry for step *k* fails; recompile
it with `--steps k` (or Compile This Step)". Partial.

**Why unproven code is written.** An unreached entry was generated from a
green recording with the whole test in view and reviewed; what it lacks is
one execution. The next run supplies it: the entry passes as code (⚙) or
throws, heals under AI, and is flagged ⚠ for the next compile — the loop
codebehind-compile.md built for entries that rot. The post-condition rule
guards the remaining case, an entry that runs without throwing and does the
wrong thing. Against that, the cost of not writing was every entry the
compile produced.

**What stays failed**, with nothing proposed and the candidate left where it
is today: a test that will not parse, a selection error, the writer refusing
a splice (a file with nothing to append to), and an abort.

**Write-offs stay AI.** A step written as `ai: true` by a replay failure is
kept verbatim by the default selection, as today — the model tried
`maxRounds` times and trying again without a change is waste. The summary
lists those steps so the author knows that after fixing the cause the
recourse is **Compile This Step** (or `--steps`), or deleting the entry.

`clearStale` clears the flags of proven steps only.

The CLI writes the proposed files on partial too — it is the scriptable path
and has no diff — and exits **2**, so a script can tell "everything compiled"
(0) from "some did" (2) from "nothing did" (1).

### What the author sees

- **One button.** The panel's **Compile from this run** folds into
  **Compile**. The stream's Record line says which it was: reused, prefix, or
  recording in this session.
- **During** — the gutter: ▶ walks Generate; Record paints as a run; each
  Replay round paints ⚙ per step and ✗ where it stopped. The panel: the phase
  lines as today, with the step lines under them.
- **At the end** — green: as today. Partial: *"Compiled checkout.md: 4 of 9
  steps as code. Step 5 failed under AI — fix it, run, and compile again for
  the rest."* with **Open diff** / **Show log**. Failed: as today.
- **The diff** — unchanged. Apply writes through the workspace API, returns
  focus to the test file.
- **After Apply** — the next Run proves the unproven entries (⚙) or flags
  them (⚠), exactly as it does for entries that rot.

### Server

`POST /codebehind/compile` — `{ testFilePath, steps?, sections?, envName?,
sessionId?, select?, maxRounds?, dryRun? }`. `sessionId` replaces
`fromSessionId` and means more: the session to compile *from* when it can be
and to record *in* when it must. The `api-server` allow-list names it;
`fromSessionId` is dropped rather than aliased, because TestBench is the only
client and the two shipped together.

The step route gains `captureStepContext` on the wire. Its allow-list must
name it — the seam that silently drops unlisted fields is the one that bit the
envName story.

New frames: `compile:run` as above; `compile:step` with `line` and `frame`;
`compile:result.status` admits `partial`; `summary` gains `unproven:
number[]`, `writtenOffAi: number[]`, and `stoppedAt?: { step: number; error:
string }` for the prefix case.

Record in the caller's session goes through `executeSteps` with that session
id and is **not** closed after. The per-session queue already serialises a
Run pressed during it, and the panel already shows "⚙ Compiling…". The
per-file compile lock is unchanged.

`InternalRunOptions.codeBehind` keeps `expansion`, `candidateFiles`,
`disabled` and `strict`; `captureContext` leaves it for the wire.

## Amendments to codebehind-compile.md

- **The runtime stops generating** — the sidecar exclusion narrows: only a
  Record with code-behind off is excluded. A Record with it on is an ordinary
  run and writes it.
- **2. Record** — "Code-behind is off for this run" becomes "off only when
  the selection needs a transcript the entry would hide". The `sessionId`
  fast path becomes the default path; a red or stopped run is a valid source
  for a prefix compile; Record runs in the caller's session, not a fresh one.
- **5. Replay** — a failure on an entry not in S still stops, but proposes
  the proven prefix.
- **6. Write** — "Nothing is written on a non-green compile" is withdrawn;
  replaced by the partial rules above. The `.candidate` file now matters only
  for aborts and writer errors.
- **What the author runs** — the Runner panel row ("Compile from this run")
  folds into Compile.
- **What the author sees / During** — step lines and gutter marks, not phase
  lines alone.
- **Server** — "nothing in a compile has a line number" is withdrawn: Record
  and Replay events carry theirs unchanged inside `compile:run`, and
  `compile:step` carries one too. The paragraph on "Compile from this run"
  being a fast path no plain Run leaves lying around is withdrawn: a plain
  TestBench run now leaves exactly that. `fromSessionId` → `sessionId`;
  `CompileStatus` gains `partial`; the four internal knobs become three.
- **How many prompts** — the Record row reads "none, when the last run has
  context; one AI run otherwise".

## What was built

Everything above, in one pass, with three things the build added:

- **The reviewer may not change the set of entries.** Caught live on the
  first prefix compile: shown the whole test, the review pass wrote an entry
  for the step the recording had never reached — code for a step nobody
  recorded, which the next compile would then have skipped as "already has
  one". The review prompt now says never to add an entry, and because a
  prompt rule is a request, `reviewCandidate` compares the entries before and
  after (`listEntries` in the writer) and rejects a revision that adds or
  removes one, the generated file standing as for any other rejection.
- **`RunDetails.coverage`** — `whole` | `prefix` | `partial` — is how the
  server tells a run that describes the test from step 1 (green, or truncated
  at a breakpoint) from a continuation or a mid-test re-run. Only the first
  two can be a recording; a green `whole` run whose step count no longer
  matches the file is declined too, since the author added a step since.
- **A session with a run in flight refuses a Record** — a step-mode pause or
  a tool debugger parks the batch inside the session, and a Record queued
  behind it would wait forever. It arrives as an error frame, not a 409: the
  decision is made at Record time, after the stream has opened.

And one the first real use found, the day it shipped. `tests/github with
sections.md` declares `- username: $GITHUB_USERNAME`, runs green from
TestBench, and compiled with the literal `$GITHUB_USERNAME` typed into the
username field. A Run resolves `$VAR` parameters before it starts — TestBench
on the client, against the nearest `.env` above the test file with
`.env.<name>` overlaid; `aiui run` from `process.env` — and the compile built
its runs from the parsed test, whose parser keeps `$VAR` as written. Nothing
on the server resolves it: the one resolver lives in the CLI's file runner and
reads `process.env`, which the server deliberately does not share with the
project. Data-file rows (`dataFile:` in frontmatter) went the same way — the
CLI runner applies one per instance; the compile applied none.

So `compileTest` resolves the parameters once, up front, through the chain a
run uses — data row, `$VAR` from an env map the caller supplies, the inline
value — and every Record and Replay starts from that map
(`CompileRunRequest.parameters`); the review's leak guard checks the resolved
values too, since a guard looking for `$GITHUB_PASSWORD` would wave the real
one through. The server composes the env the way TestBench does — process
baseline, the nearest `.env` walking up from the test file, `.env.<name>` from
the project root on top — and passes the first data row; the CLI passes
`process.env` with the project layers merged, and the first row. A `$VAR`
nothing defines is said out loud (a `note` event; an `output` frame on the
wire) and left as the literal. Proven live: a test whose third step asserts
the field holds the real value compiled green, where before the fix it was a
prefix compile stopped at step 3 with `got "$LIVE_WHO"`.

One deviation from the text above: a prefix compile reports `partial` even
when its replay is green, because "green" means the whole test replays as
code and a prefix only proved the prefix — the CLI exits 2 and TestBench's
notification says what is left, which is the point of the status.

Verified by running: root 2710+ (vitest), runner-core 432, testbench-native
unit 223 and integration 186; live through the extension against
`fixtures/test-app` — Compile with no prior run records in the editor's
session and the next run serves every step as code, and Run-then-Compile
reuses the run ("Compiling from session …'s last run (2 step(s), green, 2
with page context)"), records nothing, and paints ⚙ from the replay before
anything is applied; and the prefix compile over HTTP — a run red at step 3,
then `partial` with `stoppedAt: 3`, steps 1–2 proven, and a proposed file of
exactly two entries. The cached-run slowdown with capture on is still
unmeasured.

## Implementation outline

- `src/runner/step-executor.ts` — take the turn-1 DOM snapshot on a cache hit
  when `captureStepContext` is on.
- `src/server/session-manager.ts` — `StepRequest.captureStepContext`;
  `InternalRunOptions.codeBehind` drops `captureContext`; `RunDetails.coverage`;
  `sessionStatus` for the busy check.
- `src/server/api-server.ts` — both allow-lists: `captureStepContext` on the
  step route, `sessionId` on the compile route.
- `src/server/compile-runner.ts` — the source-run rule (green / red prefix /
  record); Record in the caller's session, not closed; forward every inner
  event as `compile:run`; send a prefix of steps for a prefix compile; `line`
  and `frame` on `compile:step`.
- `src/codebehind/compile.ts` — per-entry state across rounds (proven /
  failed / unreached); prefix selection from a red source; `partial`; the
  summary fields; `clearStale` for proven steps only; `files` on partial;
  the review entry-set guard. `src/codebehind/review.ts` — the never-add
  rule; `src/codebehind/writer.ts` — `listEntries`.
- `src/cli/commands/compile.ts` — step lines under phases; the partial
  summary; exit code 2.
- `runner-core` — `CompileRunEvent` and the narrower; `partial`; the summary
  fields; `sessionId`; `captureStepContext` on the step request type.
- `testbench-native` — send `captureStepContext: true` on every run; fold
  `compile:run` events through the run path, resetting marks between rounds;
  ▶ on `compile:step.line`; the partial notification and diff; the panel's
  single Compile button. Patch bump per CLAUDE.md (runner-core changed too).

## Tests

- Unit: a cache hit captures context when asked and not otherwise; a red
  source run selects the prefix; after rounds, entries classify as proven /
  failed / unreached and the files reflect it; green vs partial; `clearStale`
  proven-only; CLI exit codes 0/1/2.
- Pipeline with a stub runner: prefix compile replays the prefix only and
  leaves later steps untouched; final-round failure at step 7 proposes 1–6
  as code, 7 as `ai: true`, 8–9 as code and names them; a non-S failure
  proposes the prefix and stops; abort proposes nothing.
- Server: POST through the real `api-server` entry — `captureStepContext`
  reaches the run, `sessionId` reaches the compiler; compile with a green
  session reuses it and never records; with a red session compiles the
  prefix; with no usable run records **in that session** and leaves it open;
  `compile:run` frames arrive in the inner run's order with `done` last;
  `compile:step` carries `line`; a paused session is refused.
- Runner-core: the narrower admits `compile:run` and `partial`.
- Extension integration (FakeApiClient): a run sends `captureStepContext`;
  fake `compile:run` replay frames paint ⚙ then ✗ and reset between rounds;
  `compile:step` paints ▶ on its line; a partial result opens the diff with
  the partial notification.
- Live, through the extension against `fixtures/test-app`: Run, then Compile —
  the stream says it used the run and the log shows no Record. Break a step,
  Run (red at *k*), Compile — the prefix proposal; Apply; fix; Run — ⚙ on the
  prefix, AI on the rest; Compile — the rest only, the prefix byte-identical.
  Plant a failing entry and watch the replay's ✗ land in the gutter.
- Measure, not just read: the cached-run slowdown with capture on, over the
  template tests. The 0.2–2s figure comes from a code comment.

## Non-goals

- Keeping a replay round's browser open after it fails. The gutter, the
  error and the screenshot carry what the window did.
- Resuming from a `.candidate` after an abort. With partial writes the
  candidate matters only for aborts and writer errors; still a gap, a
  smaller one.
- Retrying `ai: true` write-offs automatically once the test changes.
- An MCP `compile_test` tool, auto-compile on save, standalone `.spec.ts`
  export — as before.
