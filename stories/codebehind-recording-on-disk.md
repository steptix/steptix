# The recording lives beside the test

Builds on [codebehind-compile-as-a-run.md](codebehind-compile-as-a-run.md),
which made a compile look and behave like a run. This story changes *where
the compile's input and output live* and *when the input is made*. Nothing
about the pipeline, the prompts, the review pass or the gutter changes.

## What we're building

Today the DOM snapshots a compile generates from are taken on **every** run
and kept in the **server's memory**, on the session, until the next run
replaces them. Nobody can see them; they die with the session; and every run
pays for them. The generated code is only put somewhere visible when a compile
*fails* (the `.candidate` file) — otherwise it exists in a diff and then in
`<test>.steps.ts`.

After this story:

- **Capturing is the compile's job, not every run's.** An ordinary run
  captures nothing. Pressing **Compile** runs the test — in your session,
  with the gutter painting, as it does now — and *that* run is the recording.
  Every compile records again; the steps already compiled run as code at no
  cost, so a re-record costs the steps you were going to compile anyway.
- **The recording is files beside the test.** `.steptix-codebehind-cache/
  <name>.recording/`: one JSON per step — what it did, where it was, whether
  it passed — and the DOM before and after it as files you can open. The
  server holds nothing on the session; the recording is written when the run
  ends, and read by nobody but you and the compile that made it.
- **Generated code lands there too, every time.** The candidate file is
  written after Generate, after Review and after every repair round, and
  stays after a green compile — it is the compile's last proposal, identical
  to `<test>.steps.ts` once you Apply. A replay round that fails leaves its
  evidence next to it: the step, the error, the page's DOM and screenshot at
  the failure.

Example. The author presses **Compile** on `tests/checkout.md`:

```
Compile checkout.md
  Select      9 step(s) to generate, 0 kept, 0 already AI
  Record      running 9 step(s)                    ← in your session, gutter painting
              ✓ step on line 12
              …
  Generate    9 step(s)
  Review      revised checkout.steps.ts
  Replay 1    running 9 step(s) as code
              ✗ step on line 18 — locator timeout
  Repair      step 7 regenerating from the failure
  Replay 2    9/9 passed as code
  Write       dry run — nothing written

✓ Compiled checkout.md: 9 of 9 step(s) as code.
  Recording: tests/.steptix-codebehind-cache/checkout.recording/
```

and on disk, beside the test:

```
tests/.steptix-codebehind-cache/
  checkout.recording/
    recording.json               the run: test, status, step count, parameter names
    step-01.json                 index, text, status, url before/after, actions, outputs
    step-01.before.html          the DOM the generator saw before the step
    step-01.after.html           …and after
    step-07.json
    …
    replay-1.failure.json        round 1: step 7, the error, the url
    replay-1.failure.png         the page at the failure
  checkout.steps.ts.candidate    the proposal — after Generate, Review, each repair
  checkout.last-run.json         (as before) which steps ran as code, which are stale
```

Open `step-07.before.html` and you are looking at exactly what the model was
given when it wrote step 7's entry. Open the candidate and you are looking at
what the diff will offer.

## Context — what the in-memory design gets wrong

codebehind-compile-as-a-run.md made every Steptix run capture the DOM
either side of each step so that "the run you just did is the recording" and
a compile would skip Record. Three things are wrong with that, and the first
live use found all three:

1. **It is invisible.** The snapshots are in `lastRunDetails` on the session.
   When a generated entry is wrong, the author cannot see what the generator
   saw; when the compile declines a step, they cannot see why.
2. **It is the server's.** The server holds, per open session, two DOM
   snapshots per step of the last run — for every test anyone runs, whether
   or not they ever compile it — and it dies with the session. A compile that
   needs a recording from a session that has been closed records again
   anyway.
3. **Every run pays.** One extra DOM capture per step, and for a cache hit
   the turn-1 capture the hit was skipping, on runs that will never be
   compiled.

And the saving it bought — no Record when the last run is green — is worth
less than it looks: during a Record, steps that already have entries run as
code at zero tokens, so a re-record costs only the uncompiled steps, which a
compile was about to spend tokens on regardless.

The generated code has the same visibility problem at the other end: the
`.candidate` file is written only when a compile fails, so a green compile
that wrote something surprising leaves nothing to inspect but the diff.

## Design

### Ordinary runs capture nothing

Steptix stops sending `captureStepContext` on runs. The wire field stays —
it is how the compile's own Record asks for the capture, and nothing stops
another client asking — but nothing sends it by default. The cache-hit
capture rule (a hit takes the turn-1 snapshot when context is asked for)
stays, because the compile's Record in the editor's session runs with the
project's cache setting and needs it.

### The compile records, every time

`POST /codebehind/compile` no longer reuses a session's last run. Given the
caller's `sessionId`, Record runs **in that session** — the browser the
author watches, left open where the run ended — with `captureStepContext`
on, and the run writes the recording to disk. Without a `sessionId`, Record
runs in a session of the compile's own, closed afterwards, as before.

A red Record is still a recording of the steps before the failure, and the
compile is still a prefix compile of those (codebehind-compile-as-a-run.md
§Write what passed). That logic moves from "the session's last run failed at
*k*" to "the Record failed at *k*" — the same code path, one input fewer.

`lastRunDetails` — the per-session retention of step results — goes, along
with `RunDetails.coverage`, which only existed to judge a retained run. The
server keeps no step context after a run ends.

### The recording on disk

Written by the run itself — the CLI's `runTest` and the server's step loop
alike, at the point they write the last-run sidecar — whenever
`captureStepContext` is on. Not per step: a run's results are assembled as
it goes and written when it ends, which is before Generate starts, so the
author can read the recording while the model works. (A Record the author
stops mid-run writes what it has.)

`.steptix-codebehind-cache/<name>.recording/`, beside the test's cache sidecar,
replaced wholesale by each new recording:

- `recording.json` — `{ test, startedAt, finishedAt, status, steps,
  parameters: [names], source: 'cli' | 'server' }`. Parameter **names**,
  never values.
- `step-NN.json` — `{ index, instruction, status, error?, fromCodeBehind?,
  codeBehindStale?, urlBefore?, urlAfter?, pageUrl, actions: [...],
  assertions?, outputs?, durationMs, files: { before?, after?, screenshot? } }`.
  The actions are the step's transcript as the generator reads it.
- `step-NN.before.html`, `step-NN.after.html` — the DOM snapshots, verbatim.
- `step-NN.failure.png` — the failure screenshot, when the step has one.

**Secrets.** The recording is a project file, gitignored like the rest of the
cache dir but readable by anyone with the checkout. Values of parameters
whose names look secret (`password`, `secret`, `token`, `key`) are redacted
from the actions and the DOM snapshots before writing — the same rule
`maskSecret` applies to logs. A generator reading a redacted value would
write it as `step.getVar(...)` anyway, which is what it is told to do.

> Extended by [secret-redaction.md](secret-redaction.md): the rule and the
> masking moved to `src/utils/secrets.ts`, shared with the console step
> line, the report and the per-run log file, which now mask the same values.

### The candidate trail

`.steptix-codebehind-cache/<name>.steps.ts.candidate` is written after
Generate, after Review, after every repair, and at the end — on green as
well as red — so it is always the compile's latest proposal. It is no longer
deleted by a green compile: after Apply it is identical to
`<name>.steps.ts`, and before Apply it is what the diff shows. For a test
that invokes skills, each skill's candidate lands in that skill's own cache
dir, as its `.steps.ts` does.

A replay round that fails writes `replay-N.failure.json` (`{ round, step,
line?, error, url }`) and `replay-N.failure.png` into the recording dir — the
evidence the repair prompt is given, for the author to see too.

**The code is formatted.** The model emits each entry on one line — a JSON
envelope invites that — and a file of 300-character lines is not code anyone
reads in a diff or edits by hand. The candidate is run through Prettier every
time it changes, so the generate prompt, the trail, the replay, the diff and
the applied file all see the same text: single quotes, 100 columns, trailing
commas — unless the project has a Prettier config of its own, found upward
from the `.steps.ts` the way Prettier finds it, in which case that wins and
the compiled file does not churn under the author's formatter. Prettier is a
runtime dependency of the framework for this: the alternatives are a
hand-rolled splitter that breaks on the first string containing a semicolon,
TypeScript's own formatter (whitespace only, and 60 MB at runtime), or asking
the model, which is neither deterministic nor free. Binding is by each
`source` string's *value*, so the quoting Prettier picks changes nothing.
Code Prettier cannot parse is left as it was, and the esbuild validation that
follows reports the real error.

### What the author sees

- The compile stream and the gutter: unchanged. The Record line reads
  "running 9 step(s)" — never "reusing the supplied run" — and the stream
  says where the recording went.
- The summary carries `recordingDir`, and the compile notification (green,
  partial or failed) gains **Open recording**, which reveals the directory in
  the Explorer. `steptix compile` prints `Recording: <dir>`.
- The files themselves, in the Explorer, beside the test's other cache
  artifacts.

## Amendments to codebehind-compile-as-a-run.md

- **Ordinary runs capture what a compile needs** — withdrawn. They do not;
  the compile's Record does.
- **Record is a run** — the source-run rule ("green → the recording; red →
  a prefix; otherwise Record") collapses to "Record, in the caller's session".
  The step-count and coverage checks go with it.
- **Server** — `lastRunDetails` and `RunDetails.coverage` are removed;
  `CompileSummary` gains `recordingDir`; the `.candidate` is written at every
  stage and kept.
- **Non-goals** — "resuming from a `.candidate` after an abort" is no longer
  blocked on anything: the candidate is always there. Still not built.

## What was built

Everything above, as written. Verified by running: root 2728 (vitest),
runner-core 435, steptix-vscode unit 223 and the code-behind integration
group 15; live through the extension against `fixtures/test-app` — Compile
with no prior run records in the editor's session, Apply, and the next run
serves every step as code; and Run then Compile, where the stream now shows
"Recording in session …" and a Record phase, no run is reused, `</>` is painted
from the replay, and beside the test there is `recording.json`, a JSON with
the transcript and the DOM before and after for each of the two steps, and a
`.steps.ts.candidate` byte-identical to what the diff proposes — all before
anything is applied. A server-side compile over HTTP on the same fixture
showed the same directory, with the stream naming it ("Recording to …").

Two things the first real project found, the same day:

- **A project that never installed the framework ran every step under AI.**
  The generated file imports `steptix/codebehind`, and the bundler
  left that for Node to resolve from the project's cache dir — which, in a
  tests-only project driven from Steptix, has no `node_modules` above it.
  The loader warned and fell back. The server (or CLI) loading the file *is*
  the framework and knows where its own modules are, so the bundler now
  resolves `steptix` and its subpaths to the running framework's
  export — read off its `package.json` — whenever the project cannot resolve
  it, and leaves the bare specifier alone when it can (an install, or the
  framework's own checkout). A `package.json` dependency is still the right
  thing for editor types; the run no longer depends on it.
- **The compile's replay said "passed as code" for code that never ran.**
  Strict mode fails an entry that throws, but a *file* that fails to load
  yields no entries, and strict never saw it: the replay ran under AI, passed,
  and the compile went green. The loader now records load failures on the
  registry, and a strict run — both runners — fails before its first step with
  the file and the reason, which the compile reports as "the candidate could
  not be loaded" rather than "no step owns the failure".

One thing the build did not do: the recording is written once, when the run
ends, not streamed per step. A Record the author stops mid-run writes what
it has up to the stop because the run's results are assembled as it goes and
the write happens on every exit path that writes the sidecar.

## Implementation outline

- `src/codebehind/recording.ts` — the format: `recordingDirFor`,
  `writeRecording`, `writeReplayFailure`, `readRecording` (the round trip,
  for tests and for a later `--from-recording`), the secret redaction.
- `src/runner/test-runner.ts` — write the recording at the sidecar site when
  `captureStepContext` is on.
- `src/server/session-manager.ts` — the same at its sidecar site, gated on
  `request.captureStepContext` alone (a Record with code-behind off must
  still be recorded); drop `lastRunDetails`, its accessor, and
  `RunDetails.coverage`.
- `src/server/compile-runner.ts` — drop `reuseRun`; `sessionId` means "record
  here"; `recordingDir` on the summary.
- `src/codebehind/compile.ts` — persist the candidate at every stage, keep
  it on green; write replay failures; `recordingDir` in the summary.
- `src/cli/commands/compile.ts` — print the recording dir.
- `runner-core` — `CompileSummary.recordingDir`.
- `steptix-vscode` — stop sending `captureStepContext`; **Open recording**
  on the compile notification. Patch bump.

## Tests

- Unit: the recording round-trips (steps, DOM files, screenshot, sparse
  indices); secrets are redacted in actions and DOM; a replay failure is
  written; the candidate is written at each stage and survives a green
  compile.
- Runner: `runTest` with `captureStepContext` writes the recording beside
  the test; without it, nothing.
- Server: the step route with `captureStepContext` writes the recording;
  `lastRunDetails` is gone; a compile with `sessionId` records in that
  session every time, even with a green run behind it; the summary names
  the recording dir.
- Extension integration: a run sends no `captureStepContext`; the compile
  notification offers Open recording.
- Live, through the extension: Run, then Compile — the stream shows a Record
  (not a reuse), the recording dir holds a JSON and two DOM files per step,
  the candidate is on disk before Apply.

## Non-goals

- Reusing a fresh on-disk recording instead of re-recording (`steptix compile
  --from-recording`). The format is shaped for it; the decision was to
  re-record every time.
- Per-step streaming of the recording to disk during the run.
- A recording viewer in Steptix beyond revealing the files.
