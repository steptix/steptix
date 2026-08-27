# Compile-tail progress

Builds on [compile-as-you-go.md](compile-as-you-go.md), which made recording
and generation ride the author's own run. Nothing about what a Run & Compile
*does* changes — the generation queue, the Review pass, the candidate, the
diff → Apply flow are all untouched. What changes is what the author can see
while the tail of that work runs.

Design mockups for everything below were explored on a canvas first
(options A–D plus an A + C composite); the strip, the notification, the
status bar item and the per-file scoping in this story are the shapes that
survived that round.

## What we're building

Today a Run & Compile looks like this from the author's chair:

```
✓ step on line 24
✓ step on line 25
Run passed
                          ← nothing, for up to a minute
◐ Compiled securebank.md: 8 entries (unproven — the next run proves them)
```

The steps paint as they run, the run passes — and then the panel goes silent
while the server does the most expensive part of the whole feature: draining
the generation queue (one model call per AI step) and running the Review pass
(one model call per touched `.steps.ts`). The only signal that anything is
still happening is that the buttons are still disabled. Then the proposal
lands all at once.

After this story, the same minute looks like this:

```
Run passed
Run finished — 8 entries still to generate, then a review pass
generate · step 1 — entry written
generate · step 2 — entry written
…
```

with, at the same time:

- **a status strip in the panel** — spinner, "Compiling code-behind — 5 of 8
  entries generated · review next", the step being generated right now, and a
  thin progress bar;
- **a progress notification and a status bar item** — workbench-global, naming
  the file, so the signal survives switching to another test or hiding the
  panel entirely;
- **the generation log lines in the panel's Output section**, not only in the
  Output channel — and the panel log becomes per-file while we are in there,
  so two compiles can never interleave their lines.

The user's real question — "is it hung, or is it working?" — is answered the
moment the run ends, by one forecast line, and stays answered until the diff
appears.

## Context — why the tail is silent

Three independent reasons, and all three need fixing:

**The server only speaks at completions.** `LiveCompiler`
([live-compile.ts](../src/codebehind/live-compile.ts)) queues a generation per
finished AI step and emits a `compile:step` frame when the entry is *written*
(`applyGenerated` in [candidate.ts](../src/codebehind/candidate.ts)) — never
when one *starts*. `reviewCandidate` ([review.ts](../src/codebehind/review.ts))
is the same: its first emit is after its model call returns. So even a client
that showed every frame would sit quiet for the length of each model call —
and Review, the longest single call, says nothing until it is done.

**The extension shows the frames to the wrong surface.** The run controller
([run-controller.ts](../testbench-native/src/extension/run-controller.ts))
formats one log line per compile event via `compileLogLine` — and sends it to
the VS Code Output *channel* only. The panel webview is posted exactly one
compile message: the final `compile:result` line. The webview even has a
`compiling` state and a "Compiling…" button label wired up
([testbench-runner.jsx](../testbench-native/src/webview/testbench-runner.jsx))
that nothing in the extension host ever sets — dead listeners
(`compileState`, `compileStep`) left from an earlier flow.

**The worst case is the everyday case.** Generation trails the run on
purpose — the browser never waits. So the faster the run (cached transcripts,
steps that already ran as code and healed), the more of the queue is still
unstarted when the last step paints ✓. A run that finishes in seconds can
leave the entire compile — every generation plus Review — in the silent tail.

One nearby fact this story inherits: the panel's Output log is **not**
file-scoped. The file-switch cleanup in the webview clears the selection and
the variables map but deliberately leaves `runLog` alone, so test B's panel
shows test A's lines today, and two concurrent compiles would interleave.

## Design

### The server speaks at starts, and forecasts at run end

Two kinds of event are added to the compile-mode run's stream. Both ride the
frame shapes the stream already has, so an older client logs them or ignores
them and nothing breaks.

**Start messages, as `compile:step` frames.** When the queue picks up a step,
before the model call: `generating…` with the step number and source line.
When Review starts a file, before its model call: `reviewing <file>…` — this
one lands in `reviewCandidate` itself, so the boxed pipeline's log gets it
too. The existing completion messages (`generated`, `kept as AI: …`,
`revised <file>` …) are unchanged.

**A structured progress event, because clients must not parse prose.** The
strip and the status bar need numbers, and deriving them by matching message
strings is exactly the kind of mirror that rots silently. So:

```
{ type: 'compile:progress',
  done: 5,          // entries finished: generated + kept-as-AI + errored
  total: 8,         // entries enqueued so far (final once the run ends)
  phase: 'generate' | 'review',
  step?: 6, line?: 22,   // what is running now, when phase is 'generate'
  reviewPending: true }  // a Review pass is still owed ('run' mode only)
```

Emitted when a generation starts, when one finishes, when Review starts, and
once — with the final totals — the moment the run's last step ends. That last
one also gets a human line on the stream, the forecast:

```
Run finished — 8 entries still to generate, then a review pass
```

`LiveCompiler` owns the counters: it already knows what it enqueued and what
completed; `finish()` knows the moment the drain begins. A `'steps'`-mode
compile (Compile This Step) emits the same events with `reviewPending` never
set, since that path runs no Review by design.

### The panel strip — strictly per-file

A banner in the panel, rendered between the header and the Steps section,
visible from the moment the run's steps are done until `compile:result`
arrives: spinner, **"Compiling code-behind — 5 of 8 entries generated ·
review next"**, a dimmed second line naming the step being generated right
now, and a 2px determinate progress bar. During the run itself the strip is
absent — the steps painting *are* the progress; the strip exists for the tail,
which is the stretch that has nothing else to show.

The strip is **file-scoped, deliberately.** The panel follows the active file;
the strip is part of that file's run context and leaves the panel with the
rest of it when the author switches files. A cross-file strip was considered
(the batch-run banner is precedent for a global banner in this panel) and
rejected: a panel showing github.md with securebank.md's compile status on it
reads as the wrong file's state, and it has no coherent answer for two
compiles at once — per-file strips scale by doing nothing. The switched-away
case belongs to the workbench-global signals below.

The strip's state lives on the run controller — which is per document — and
is re-posted to the webview whenever that file becomes active again, so
switching away and back restores it mid-tail.

Plumbing note: the dead `compileState`/`compileStep` listeners in the webview
are removed and replaced by the one message that carries this state; the
"Compiling…" button label they were meant to feed goes with them. The buttons
already communicate "busy" through the running state, and the strip is the
replacement narrative.

### The panel log — forwarded, and scoped per controller

Every compile log line the controller already formats for the Output channel
is now also posted to the panel's Output section — starts and completions
both. The Output channel keeps its copy; it remains the full-history surface.

And the panel log becomes **per-controller**: each run controller keeps its
own log, and the webview renders the active file's. Switching files switches
logs; Clear clears the active file's only. This fixes the pre-existing
cross-file bleed (test B's panel showing test A's run) and is what makes
concurrent compiles legible — two files' generation lines can no longer
interleave in one pane, because they were never in one pane to begin with.
The log moves to the host side with the controller (the webview is already
snapshot-driven for everything else file-scoped), so a webview reload or file
switch re-renders it rather than losing it.

### The workbench-global signals — notification and status bar

**One `withProgress` notification per compile**, location Notification,
created when the tail begins and resolved when `compile:result` arrives. The
message names the file — "Compiling code-behind for securebank.md" — because
its whole purpose is to be meaningful after the author has navigated away.
Its progress bar and detail line track `done`/`total` from the structured
event; one button, **Open <file>**, jumps back to the test (where the strip
has the detail).

Closing the toast does nothing to the compile — VS Code moves a dismissed
progress notification to the notification center, where it keeps updating
until done. That is fine, because the notification is not the persistent half:

**One status bar item, owned by a workbench-level aggregator** — not by any
single controller, because controllers are per-document and this item is the
one piece of UI that must see across them. While exactly one compile tail is
running: `$(sync~spin) TestBench: compiling securebank.md 5/8`. While
several: `$(sync~spin) TestBench: compiling 2`. Click: with one, reveal the
file and the panel; with several, a quick-pick of the running compiles
(file, k of n, phase) that jumps to the chosen one. The item hides when no
tail is running.

The division of labour, stated once: **the strip is the detail while you are
looking; the notification is the announcement; the status bar item is the
always-on glance.** The toast can be dismissed and the panel can be hidden;
the status bar item is the signal of last resort and cannot be closed.

The notification is **not cancellable.** A Cancel link on a toast is a
destructive control in a place people click reflexively, and Stop in the
panel already covers aborting the tail (queued generations are skipped, the
in-flight one finishes — its call is paid for — and the partial proposal
still arrives). Mapping a toast Cancel onto those semantics is a possible
later addition, not part of this story.

### Multiple compiles

Already reachable today — the compile lock
([compile-lock.ts](../src/server/compile-lock.ts)) is per test file, so a
second Run & Compile of the *same* file is refused with a 409 while two
different files compile concurrently, each on its own controller, stream and
session. The design above makes that state legible instead of merely
possible: per-file strips (each file's view shows exactly its own), per-file
logs (no interleaving), one named toast per compile, and the single
aggregating status bar item as the overview.

## Scenarios

**The everyday tail.** A cached run of a 9-step test finishes in seconds;
all 8 eligible entries are still queued. The forecast line lands with `Run
passed`; the strip appears at 0 of 8; the toast pops; the log ticks a
`generating…` / `entry written` pair per step; the strip's second line names
each step as it starts; Review announces itself before its call; the diff
opens; strip, toast and status bar item all clear.

**Watching a different file.** The author switches to github.md mid-tail.
The panel now shows github.md — no strip, no securebank state, which is
correct: different file, different context. The status bar still reads
`compiling securebank.md 5/8` and the toast is still up; either jumps back,
and the strip is there mid-count when they arrive.

**The toast is dismissed.** Nothing is cancelled; the notification continues
in the notification center; the status bar item carries the visible signal to
the end. Completion still announces itself regardless — the result line and
the diff.

**Two files compiling.** Two toasts, each named. Status bar:
`compiling 2` → quick-pick → jump. Each file's panel view shows its own strip
and its own log lines only.

**Stop mid-tail.** Stop aborts the run signal: generations not yet started
are skipped, the in-flight one completes, `compile:result` arrives with the
partial proposal. Strip and toast resolve with it; the log says what was
skipped.

**A generation fails.** The error path is unchanged — the step stays AI, a
warning names it. For progress it counts as done: `done` advances, the strip
and toast never stall on a failed entry.

**A breakpoint splits the run.** Each block's tail drains at that block's
end (the compiler is retained across blocks; `finish()` runs per block), so
the strip and toast live per block and the existing "paused — Continue to
finish compiling" messaging owns the gap between blocks.

**Compile This Step.** Same events, tiny tail: strip and toast for the
seconds a single generation takes, no `review next` because `'steps'` mode
runs no Review.

**Version skew.** New client, old server: no `compile:progress` arrives, so
the strip falls back to an indeterminate spinner — "Compiling code-behind…"
— from run end (a compile was requested and no result has arrived) until the
result, with no counts. Old client, new server: the new `compile:step` start
frames render as ordinary log lines in the Output channel; the structured
event is ignored by the folding's default case. Neither combination errors.

## Non-goals

- **A cross-file strip.** Considered and rejected above; the switched-away
  case is the notification's and status bar's job.
- **Cancel on the notification.** Stop covers it; see Design.
- **Editor decorations** (per-step `entry written` / `generating…` marks in
  the file). Explored in the mockups, genuinely attractive, and a separate
  story if wanted — it needs a second decoration channel because the green ✓
  gutter icon deliberately never repaints.
- **Shortening the tail.** Parallelising generation, overlapping Review,
  starting generation earlier — all real levers on the *duration*, all
  untouched here. This story is about visibility, and it is worth having even
  if the tail later shrinks.
- **Progress for the boxed pipeline** (`POST /codebehind/compile`). It
  already narrates phases; it inherits the Review start message for free and
  nothing else changes.
- **Streaming partial entry code** into the panel while a generation runs.
  The diff is the reading surface for code.

## Acceptance

- The moment a compile-mode run's last step ends, the stream carries the
  forecast line naming the number of entries still to generate and whether a
  review pass follows; the panel log shows it.
- Each generation emits a start frame before its model call and its existing
  completion frame after; Review emits a start frame per file before its
  call, on the live path and the boxed pipeline both.
- `compile:progress` carries `done`, `total`, `phase`, and current step
  info; its counts agree with the summary the run ends with (attempted =
  generated + kept + errored).
- The strip appears when the run's steps are done and a compile is still
  running, shows k of n and the current step, and disappears on
  `compile:result` — including the aborted and partial cases.
- The strip never renders for a file other than the one whose compile it
  describes: switching files removes it, switching back mid-tail restores it
  at the current count.
- Compile log lines (starts and completions) appear in the panel's Output
  section and still appear in the Output channel.
- The panel log is per-file: switching files switches logs, Clear clears the
  active file's only, and two concurrent compiles never interleave lines in
  one view.
- One notification per compile, naming the file, progress tracking
  `done`/`total`, resolved on `compile:result`; dismissing it does not
  affect the compile.
- The status bar item shows file and k/n for one running compile, a count
  for several, a quick-pick on click with several, and hides when none run.
- Two Run & Compiles of different files run concurrently with correct
  per-file strips, logs, toasts, and an aggregated status item; a second
  compile of the same file is still refused with the 409.
- Stop mid-tail resolves strip, toast and status item with the partial
  result; skipped generations are named in the log.
- A `'steps'`-mode compile shows the same progress without a review phase.
- Against an older server the strip degrades to an indeterminate spinner and
  nothing errors; an older client on a newer server renders the new frames
  as log lines and ignores the structured event.
- The dead `compileState`/`compileStep` webview listeners are gone, replaced
  by the one message that actually drives the strip.
