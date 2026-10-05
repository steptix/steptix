# Scoreboard: how often each AI action works the first time

**Status:** spec, for build. Medium, in three phases (§13).
**Opened:** 2026-09-29
**Scope:** this machine, this user. Nothing is shared or uploaded (§3).

## 1. What this is

A running record of every action the model takes during a run: the kind of
selector it chose, and whether that action worked the first time. It is kept
on this machine, one line per action, and read with one command.

What you would type, and what you would see:

```
> steptix stats

Last 30 days · your runs · all sites

Selector form        Actions   First try ok   Most common failure
role=                    120            97%   no-match (3)
:has-text                 31           100%
:text-is                  17            12%   no-match (14)
[role][name] (CSS)         4             0%   no-match (4)

Steps: 212 run · 88% passed first try · 6% after a retry · 3% after a failed action · 3% failed
Cost:  4,200 tokens a step on average · 1.3 model calls a step
```

The numbers above are invented to show the shape. The command can also list
the failures themselves, each with a link to the report that shows why:

```
> steptix stats --failures --since 1d

Last 1 day · your runs · all sites · 1 failed action, newest first

2026-09-28 07:12  tests/recording.md  step 11  Select "Mr" from the Title Select list …
  click  [role="listbox"] [role="option"]:text-is("Mr")    no-match
  report: file:///C:/…/templates/init/reports/2026-09-28_07-12-50-recording.html#step-11
```

And, after a change to the prompt's rules, whether the change helped:

```
> steptix stats --by prompt --site www.super.test

Last 30 days · your runs · sites matching www.super.test

Rules version           Actions   First try ok   Most common failure   Steps   Tokens a step   Calls a step
p-3f9a1c (to 09-28)          38            50%   no-match (19)            17          11,900            2.1
p-7b20e4 (from 09-28)        41            98%   timeout (1)              19           4,100            1.1
```

## 2. Why

On 2026-09-28 a user said the framework felt unable to complete very simple
test steps. The cause turned out to be narrow and fixable (issue 062): 19 of
38 selector actions across 17 runs of `recording.md` failed on the first try,
and every one of the 19 came from two selector forms that rule 3 of the step
prompt was recommending. Nobody could see that from the framework. It was
found by writing a throwaway script that parsed 17 HTML reports.

Two things follow from that:

- **Nobody can tell whether simple steps are reliable.** Every run writes a
  report, but no view adds them up. A retry that rescues a bad selector turns
  the step green, so a pass rate hides the problem. First-try success is the
  number that shows it.
- **Nobody can tell whether a change to the rules helped or hurt.** The step
  prompt is about 12,000 tokens of rules and grows with every feature. Whether
  a new rule breaks an old one is found out by accident, if at all.

Everything the scoreboard needs is already computed during a run (§5). What's
missing is keeping it, and adding it up.

## 3. Decisions

1. **This machine, this user.** The data lives under the user's own
   machine-level folder (§6) and is never sent anywhere. No team view, no
   server, no upload. Sharing is out of scope (§4); if it is wanted later, the
   same records can move into a shared store without changing what is
   recorded.
2. **Files, not a database.** There is one kind of writer, it only ever adds
   lines, and every question is a grouping over at most a few hundred thousand
   lines. Append-only JSON Lines files answer that in about a second at
   200,000 lines, a fraction of that for a short window (§12), add no
   dependency, and a crash loses at most the line being written.
3. **Every run records, by default.** The data is a by-product of work the run
   already did, so recording costs one short line per action and no extra
   model call or page work. It can be turned off (§6.4).
4. **Each line links to its report.** An action line says *that* a click
   failed; the report says *why*: the snapshot the model saw, its reply and
   Playwright's error. §8 covers how, including runs that write no report.
5. **Code-behind replays are recorded, tagged as code.** They measure
   flakiness in compiled tests, not the quality of the rules, so they are kept
   out of the default view (§5.6) but not thrown away.
6. **Runs by the test suites are tagged and hidden by default.** The live
   integration suite starts four servers against the fixture app; untagged, it
   would swamp the user's own numbers (§5.6).
7. **Tokens are recorded per step, in phase A.** Decided 2026-09-29. What a
   step costs is half of whether it is practical: a step that passes on the
   first try but takes 30,000 tokens is a problem the pass rate hides. Today
   the AI client adds each call's usage to a run-wide total and nothing ties
   it to a step, so §7.1 carries it through.
8. **The scoreboard's work ships in its own PRs**, never mixed with unrelated
   fixes.

## 4. Non-goals

- Sharing, team dashboards, uploading, or any network destination.
- Gating CI on these numbers. The scoreboard informs a person; it does not
  fail builds.
- Storing screenshots, DOM snapshots or model replies. The report already
  keeps them, and the line links to it.
- Judging whether a *passed* action did the right thing. The scoreboard knows
  what the framework knows: an action that "succeeded" on the wrong element
  counts as ok. Catching that is the separate pre-action check proposed in
  issue 062.
- A Steptix view. Possible later; the command and its `--json` output come
  first.

## 5. What is recorded

Three kinds of line, all in the same file, each a single JSON object that
starts `{"v":1,"kind":"…","t":"…"`: the version, the kind, and the time. The
writer puts those three first whatever order the line was built in
(`formatStatsLine`), because the reader decides from that prefix alone whether
a window needs a line before it parses the rest (§6.2).

Only a step that asked the model something, or a code-behind replay, gets
lines at all (§7). Everything below describes the lines such a step writes.

### 5.1 Action lines (`"kind": "action"`)

One per action the model chose, per execution. An action retried in a second
attempt produces a second line with `"attempt": 2`.

| Field | Meaning | Example |
|---|---|---|
| `t` | When the action finished, ISO 8601 UTC | `"2026-09-28T07:12:57.000Z"` |
| `run` | Run id (§8.1) | `"r-20260928-071250-4f1c"` |
| `exec` | The execution this line belongs to: the run's step counter, from 1, unique within the run and shared by a step line and its own action lines. A loop body's second pass, a data row's second step 3 and a `beforeEach` line beside every step are each a new `exec` where `step` repeats. Absent only on lines written before it | `7` |
| `project` | Project root, as an absolute path | `"C:\\…\\templates\\init"` |
| `test` | Test file, relative to the project root, or `null` for ad hoc steps | `"tests/recording.md"` |
| `step` | Step number as the report shows it | `11` |
| `row` | Data row number, when the run has rows | `3` |
| `hook`, `hookIndex` | For a hook's step: its scope (`before`, `beforeEach`, `afterEach`, `after`) and its place in that scope, from 1. A hook step reuses the number of the step it runs beside, so these are what tell it apart | `"beforeEach"`, `2` |
| `stepText` | The step **as written**, placeholders intact (§5.7), cut to 500 characters | `"Select \"Mr\" from the Title …"` |
| `attempt` | Step-level attempt, from 1 | `1` |
| `turn` | Turn within the attempt, from 1 | `1` |
| `action` | Action type as the model wrote it | `"click"` |
| `selector` | Selector as the model wrote it, masked (§5.7), cut to 500 characters; `null` when the action has none | `"[role=\"listbox\"] …"` |
| `form` | Selector form (§5.3); `null` with no selector | `"text-is"` |
| `outcome` | Outcome (§5.4) | `"no-match"` |
| `matchCount` | Elements the selector matched, when known | `0` |
| `ms` | Time the action took | `10012` |
| `site` | Host of the page the action ran on, masked like a URL in the report; absent when the page has no host (`about:blank`, the computer surface) | `"secure.super.test"` |
| `model` | Model that chose the action | `"openai/gpt-6-luna"` |
| `prompt` | Rules fingerprint (§5.5); `null` on imported lines, absent on the lines listed there | `"p-3f9a1c"` |
| `fw` | Framework version and commit, when known | `"1.0.0+02d968b"` |
| `card` | `false` when the report writes no card for the step, so there is no anchor to link to (§8.3); absent, never `true`, otherwise | `false` |
| `suite` | `user`, `live`, `bench` or `compile` (§5.6) | `"user"` |
| `source` | `ai` or `code` (§5.6) | `"ai"` |
| `truncated` | `true` when `stepText` or `selector` was cut, or a field was dropped to keep the line under 4 KB (§6.2); absent otherwise | `true` |
| `imported` | `true` on a line `steptix stats import` rebuilt from a report (§10); absent otherwise | `true` |

Actions with no selector (`navigate`, `wait` on a URL, `keypress`, and so on)
are recorded too, with `selector` and `form` set to `null`. Their success rate
matters as well, and leaving them out would make the totals lie.

### 5.2 Step lines (`"kind": "step"`)

One per recorded step (§7), written when the step ends, after its action
lines. A recorded step is one that asked the model something, or a
code-behind replay; a step that made no model call writes no step line, and
neither do its actions.

| Field | Meaning |
|---|---|
| `t`, `run`, `exec`, `project`, `test`, `step`, `row`, `hook`, `hookIndex`, `stepText`, `suite`, `source`, `prompt`, `fw`, `card`, `truncated`, `imported` | As in §5.1 |
| `site` | The step's first action line's site, or failing that the page its first model call was made on. What a step with no action lines — an assertion, a `[use ai]` call — is counted under |
| `model` | The step's first action line's model, or failing that its first model call's |
| `status` | The step's final `StepStatus`: `passed`, `failed` or `skipped` |
| `tolerated` | `true` for a failure the run carried on past (`otherwise continue`); absent otherwise |
| `interrupted` | `true` for the step a Stop cut short. Its `status` is `failed`, and neither the run line's `failed` nor `steptix stats` counts it; absent otherwise |
| `attempts` | Attempts made |
| `turns` | Model turns across all attempts |
| `firstTry` | `true` when the step passed on attempt 1 with no failed action |
| `ms` | Step duration |
| `calls` | Model calls the step made, all purposes and attempts together |
| `tokensIn`, `tokensOut` | Tokens across those calls (§7.1). `0` for a code step that made no call |
| `tokensCached` | Input tokens the provider served from its prompt cache, when it reports them; absent otherwise |
| `tokensEstimated` | `true` when at least one summed call's usage was the client's estimate (§7.1); absent otherwise |

`firstTry` is the headline number. A step that passed only after a retry is a
pass in the report and not a first try here, and neither is one whose model
recovered from a failed action inside its first attempt; `steptix stats` counts
those two apart (§9).

`status` can still be `skipped`: a `StepResult` can carry it, and older
writers recorded steps that asked no model, skipped ones among them. So
`steptix stats` counts only steps that ran to an end — `passed` or `failed`, and
not `interrupted` — and ignores any `source: "ai"` step line with no call and
no turn (§7).

Tokens live on step lines, not action lines. One model call usually chooses
several actions, so splitting its tokens across them would be invented
precision.

### 5.3 Selector form

Decided when the line is written, from the selector as the model wrote it,
first rule that fits. The raw selector is kept, so old lines can be regrouped
if these rules change.

| `form` | Fits when the selector… |
|---|---|
| `role` | uses Playwright's role engine: `role=button[name="Join"]`, including after ` >> ` |
| `css-role-name` | is the CSS look-alike `[role="…"][name="…"]` |
| `text-is` | uses `:text-is(…)` |
| `has-text` | uses `:has-text(…)` |
| `text-engine` | uses `text=…` |
| `testid` | uses `data-testid`, `data-test`, `data-qa` or `data-cy` |
| `aria-label` | uses `[aria-label=…]` |
| `id` | uses `#id` |
| `name-attr` | uses `[name=…]` |
| `href` | uses `a[href=…]` |
| `positional` | relies on `:nth-child`, `:nth-of-type` or `nth=` |
| `ref` | uses a snapshot reference (reserved for the element-reference idea) |
| `css-other` | anything else |

A selector that fits several (`#nav >> role=link[name="New"]`) takes the
first match in the table: here, `role`. What the form measures is how the
element was found, and a scope in front of it doesn't change that.

### 5.4 Outcome

Decided from the action's result, first rule that fits: by what the action
WAS first, and by its error text only where that text is Playwright's
(`classifyOutcome`, src/stats/classify.ts).

| `outcome` | When |
|---|---|
| `ok` | no error |
| `conceded` | a page `assert` carrying `"holds": false`: the model reported that the step cannot be done, and nothing evaluated it. `steptix stats` shows it as "model gave up" |
| `assert-failed` | any other `assert` that failed: its check came back false. Shown as "assertion failed" |
| `unknown-action` | the action type is not one the framework knows (page surface only: the computer surface refuses an unknown action before anything is recorded under it) |
| `other` | an error that did not come from the browser action layer: a framework refusal, an API's response, the author's `fail` message, a desktop action's message. Their wording is a page's, a server's, an author's or a model's, and reading it for Playwright's words would file "the server said it timed out" as a selector problem |
| `invalid-selector` | Playwright could not parse the selector |
| `no-match` | the selector matched nothing (`matchCount` 0, or a timeout whose call log never resolved an element) |
| `blocked` | an element was found, but another element received the click (`intercepts pointer events`) |
| `ambiguous` | the action refused several matches (strict mode) |
| `timeout` | any other timeout |
| `other` | any other error |

Every outcome but `ok` is a failure. The reader also counts an outcome it does
not know as a failure, so a line from a newer framework is counted rather than
lost; where two failures are equally common, this table's order decides which
one `steptix stats` names.

### 5.5 Rules fingerprint

`prompt` is the first 6 hex digits of the SHA-256 of the step prompt's
**rules** text: `buildSystemPrompt('')` with the run's own options (for
example `dismissalGuidance`), prefixed `p-`. The project's own context files
are left out, so the fingerprint changes exactly when the framework's rules
change, and two projects running the same rules share one fingerprint. The
rules text is already identical on every call (it is kept stable so providers
can cache it; `src/ai/prompts.ts`), so computing it once per process and
option set is enough.

`fw` is the framework's package version, plus the short commit `dist/` was
built from when it was built in a git checkout (stamped by `npm run build`
into `dist/build-info.json`, read once at start-up). Running from `src/`
(`npm run dev`) reports the version alone, since the stamp describes some
other build. It's absent, not guessed, when unknown. A build with uncommitted changes carries the same form; `GET
/health` reports `modified` alongside.

Which lines carry no fingerprint, and why:

- **Imported lines** have `"prompt": null`: the report they were rebuilt from
  does not say which rules were in force (§10).
- **A step asked through a prompt of its own** — a `[use ai]` step, a
  computer-surface step — has no `prompt` key at all. It was never shown the
  step prompt's rules, so a fingerprint would count it under rules it did not
  use.
- **A code-behind replay** has none either: it made no model call.
- **A line over 4 KB** may have given its fingerprint up to fit, and then
  carries `truncated` (§6.2).

`steptix stats --by prompt` keeps the first two apart, as "(imported, no
fingerprint)" and "(not the step prompt)", after the rules versions.

### 5.6 Suites and sources

`suite` says who ran it:

- **`user`**: the default. Steptix, the CLI, MCP, the Sessions API.
- **`live`**: the live integration suite. `runLiveTest.cjs` sets
  `STEPTIX_STATS_SUITE=live` in the environment of every server it starts.
- **`bench`**: the simple-steps suite (§11). Its runner sets
  `STEPTIX_STATS_SUITE=bench`.
- **`compile`**: the recording run of `steptix compile` and Run & Compile.

`source` says what drove the step: `ai` for the model, `code` for a
code-behind replay (`StepResult.fromCodeBehind`). Code steps have no model
turns, so they write step lines only, unless the replay reports its own
actions. A replay makes no model call and is recorded anyway — the one
exception to §7's rule — because it measures the compiled test.

The default view shows `suite: user` and `source: ai`. Every other slice is
one flag away (§9).

### 5.7 What is never recorded

- **Typed values.** An action's `value` field is not recorded, only its type
  and selector.
- **Filled-in placeholders.** `stepText` is the step as authored, with
  `{{placeholders}}` and `${…}` intact, not the interpolated instruction.
- **Secrets inside selectors.** A selector can carry page text (a name, an
  email). It passes through the same masking the report uses, with the run's
  own secret set (`redact(…, maskValues)` in the step executor), before it is
  written.
- **DOM, screenshots and model replies.** They're in the report.

## 6. Where it lives

### 6.1 Location

`<user root>/stats/actions-YYYY-MM.jsonl`, one file per calendar month (UTC).
`<user root>` is `userRootDir()` in `src/env/user-root.ts`: `%LOCALAPPDATA%\steptix`
on Windows, `$XDG_CONFIG_HOME/steptix` or `~/.steptix` elsewhere. That folder
already holds the machine-wide `.env`. It is per OS user, which is what
decision 1 needs.

### 6.2 Writing

- One `appendFile` per line. Each line is a single JSON object ending in `\n`,
  kept under 4 KB, with `v`, `kind` and `t` first. `stepText` and `selector`
  are cut to 500 characters, with `"truncated": true` set when they are. A
  line still too big gives up `stepText`, then `site`, `model`, `fw`, `prompt`
  and `matchCount`, in that order, rather than be written oversized; one that
  does not fit even then is not written.
- Several processes can write at once (Steptix's server, a CLI run, four
  live-suite servers). Appending whole short lines keeps them from
  interleaving.
- Writing never fails a run. Errors are logged once per process at `debug`
  and otherwise ignored. The write is not awaited on the step's path.

Reading (`readStatsLines`, src/stats/store.ts):

- Each month file from the one holding the window's start is streamed a chunk
  at a time, never loaded whole. A whole-file read stops working past V8's
  longest string, about 540 MB — roughly a million lines.
- A line's prefix says its kind and time. An action or step line outside the
  window is passed over without being parsed. Run lines are kept from the
  window's start on whatever its end, since a run's line is written when it
  ends, which can be after the window, and it is what links a line to its
  report. A line that does not start with the prefix (edited by hand) is
  parsed and held to the window like any other.
- A line the window needs is checked against §5 for its kind: the fields
  every line of that kind carries, with the right types, and the optional
  ones' types when present. One that fails — or does not parse, or has a `v`
  other than 1 — is skipped and counted, and `steptix stats` says how many.
  Suites, sources and outcomes are checked as words, not against today's
  lists: a newer framework's new outcome is still a failure worth counting.
  Fields the reader does not know are let through.

### 6.3 Retention

Month files older than `STEPTIX_STATS_RETAIN_MONTHS` months (default 6) are
deleted at server start and by every `steptix stats`. `pruneStatsFiles` and
`statsSettings` (src/stats/store.ts) do it for both.

- **How old.** A file goes when even its last day is older than the window:
  with 6 in September, March stays and February goes. The current month and
  the six before it are always kept. A value that is not a whole number of at
  least 1 is ignored.
- **Read from the machine-wide `.env` only**, never from a process's
  environment. The server and each `steptix stats` run in different
  environments — Steptix's, a terminal's, a project folder's `.env` loaded
  at CLI start — and they must agree on what to keep: a CLI started from a
  shell that says 1 must not delete months the server was told to keep. The
  machine file is the one place they all read.
- **`steptix stats` prunes after it reads**, and only once the flags have been
  checked and the read has succeeded, so a mistyped flag or an unreadable file
  deletes nothing.
- **Never the window asked for.** `steptix stats` does not delete a month file
  from the start of the window it was asked for onward, however old: asking
  about January is not what deletes January, and the months after it hold the
  run lines January's lines link through. The server's prune at start has no
  window and keeps only the retention rule.

### 6.4 Turning it off

- `STEPTIX_STATS=off`, in the machine-wide `.env` or in the environment of the
  process that records (the server, a CLI run), turns off recording. The
  machine file turns it off for every process on the machine; an environment
  only for the processes started from it.
- `"stats": { "enabled": false }` in a project's `steptix.config.json` turns it
  off for that project, for a project whose step text should not be kept even
  locally.

`steptix stats` says whether recording is on from the machine file — the one
switch a server started elsewhere also reads — and names a `STEPTIX_STATS=off`
in its own shell's environment separately, since that one covers only runs
started from that shell.

## 7. Where it hooks in

Every loop that runs steps goes through `executeStep`
(`src/runner/step-executor.ts`): the CLI runner (main flow and hooks), the
Sessions API (`src/server/session-manager.ts`), the errand runner
(`src/server/errand-runner.ts`) and the REPL. The `StepResult` it returns
already carries every field in §5.1 except the run identity:

- turns, with `attemptNumber` and `turnNumber`
- each turn's actions (`subActions[].action`, with type and selector), error,
  `targeting.matchCount`, `pageUrl` and `durationMs`
- each turn's model, on `aiInteractions`

So there is one recorder, called once at the end of `executeStep`. It turns
the `StepResult` into step and action lines.

- **Run identity comes in through the options.** `StepExecutorOptions` gains
  an optional `stats` field: `{ runId, project, test, row?, suite, maskValues }`.
  Each loop sets it. A test reads the source of every `executeStep` call site
  and fails if one doesn't pass `stats`, so a new loop can't silently record
  lines with no run.
- **Nested calls don't count twice.** `executeStep` calls itself for
  control-flow bodies. Each nested call is a real step with its own number and
  records its own lines, but a wrapper that merges an inner result into an
  outer one must not record both. A test pins exactly one step line per
  recorded step.
- **The Electron runner** (`src/ui/main/runner-adapter.ts`) runs its steps and
  its steering through `executeStep`, so it records like the others.

**What counts as a step.** A step gets lines when it asked the model
something — any call: an action plan, an assertion's code, a readTable
structure question, a clarification, a `[use ai]` call, a computer-surface
turn — or when it is a code-behind replay (`source: "code"`, §5.6), which
makes no call but measures the compiled test. That is `recordable` in
src/stats/recorder.ts, asked by `recordExecutedStep` (src/runner/run-stats.ts),
the one call the end of `executeStep`, of the computer surface's step and of
the `[use ai]` step all record through.

Every other step writes nothing, whatever became of it, because none of them
says anything about how well the model does a step and counted they would move
the first-try rate on steps the model never saw: `Set`, `[tool:]`, `[input:]`,
surface switches, a whole-step Return, Stop or Fail, refused lines, skipped
rows, a condition this run's values answered, a `[use ai]` line refused before
it was sent, a step that failed because the run has no AI key or forbids AI.
Neither are the decision rows of `If`, `While`, `Repeat` and `For each`: a
condition that did not hold is reported as skipped, which is not a failure,
and counting it would drag the headline rate down. Their condition judgements,
and the polls of a watch group, still cost tokens, so those land in the run
line's totals (§8.2), which is why the step lines alone can add up to less.

Older writers did record some of those, with no call and no turn; `steptix stats`
ignores any `source: "ai"` step line like that.

Each recorded step takes the run's next execution number, `exec` (§5.1): the
run's count of step lines so far, so the numbers run 1, 2, 3… across rows,
hooks and loop passes, and the run line's `steps` is the last of them.

### 7.1 Carrying tokens to the step

The AI client gets usage back on every call (`src/ai/client.ts`: the v2
envelope's `usage.input_tokens` / `output_tokens`, and the streamed
equivalent), and adds it to the run's `tokenTracker`. That total is what the
report's token counts come from, and it is the only place usage goes today.

- **Usage goes on the interaction.** `AiInteraction` (`src/report/types.ts`)
  gains `usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }`,
  filled from the value `complete()` already returns, everywhere an interaction
  is built. That covers:
  - a turn's action plan
  - an assertion's code
  - a readTable structure question
  - a `[use ai]` step's call
  - a clarification
  - a retry
- **The step sums its interactions.** The recorder adds up every
  `aiInteractions[].usage` in the step's turns, plus the step's assertions and
  anything else that carries an interaction, into `calls`, `tokensIn`,
  `tokensOut` and `tokensCached`.
- **Calls that belong to the run go on the run line.** For example, the
  failure diagnosis made after the last step. The run line (§8.2) carries the
  run's totals from `tokenTracker`, so step tokens plus run-level tokens can be
  checked against it (acceptance 10).
- **Estimates are marked.** When a provider's stream omits usage, the client
  estimates it (`client.ts`, "Estimate tokens if the stream omitted usage").
  An interaction built from an estimate carries `estimated: true`, and a step
  line that summed any estimate carries `tokensEstimated: true`, so an average
  is never quietly part guess.

The same field makes per-call usage visible in the report as a side effect.
Showing it there is optional and outside this spec.

## 8. The link to the report

### 8.1 Run id

A run id is made when a run starts: the timestamp plus four random hex digits,
for example `r-20260928-071250-4f1c`. Every action and step line of the run
carries it. A data-row run (`stories/data-driven-rows.md`) uses ONE run id for
all its rows, because it writes one report.

### 8.2 The run line (`"kind": "run"`)

Written when the run ends, where the report is written:

- `test-runner.ts`, at the end of a run
- `session-manager.ts`, at the end of a batch, and in `finalizeRowRun` for
  data-row runs
- the stop path that still writes a report

| Field | Meaning |
|---|---|
| `run`, `t`, `project`, `test`, `suite`, `imported` | As in §5.1 |
| `status` | The run's status, and `aborted: true` when the user stopped it |
| `steps`, `firstTry`, `failed` | Counts, so a run can be summarised without reading its steps. `steps` is the step lines the run wrote, and so its last `exec`; `failed` leaves out a step a Stop cut short |
| `tokensIn`, `tokensOut` | The run's totals from `tokenTracker`, including calls that belong to no step |
| `report` | Absolute path of the HTML report, or `null` when the run wrote none |

The report path isn't known until the run ends, so it goes on this one line,
not on every action line, and `steptix stats` joins on `run`. Errands and
ad hoc Sessions API batches that write no report get a run line with
`"report": null`; their lines still count.

### 8.3 Linking to the step, not just the report

The report gives every step card an id: `id="step-11"`, `id="row-3-step-11"`
in a data-row report, and for a hook's step its scope and place,
`id="hook-beforeEach-2-step-5"` (`row-3-hook-before-1-step-0` in a row; a
report or line from before `hookIndex` gets `hook-before-step-0`). One
function builds them, `stepAnchor` in `src/report/anchors.ts`, from exactly
the fields a line records (`step`, `row`, `hook`, `hookIndex`), so the report
generator and `steptix stats` cannot drift apart.

Where the ids are set, all in `src/report/generator.ts`: `renderSteps` hands
an id to every card it draws — a step's own card and a mode switch's
(`renderStep`, `renderModeStep`), the banner of an `[interactive]` prompt and
each step typed at it — and a card drawn without one falls back to its
canonical id. A data-row report's steps carry their row (`dataRow`, set by
`mergeRowReports` in `src/report/merge-rows.ts`), which is what puts `row-3-`
in the id.

A loop body's steps appear once per pass, and a `beforeEach` beside every
step. The first card to claim an id keeps it and later ones take `-2`, `-3`…,
so a link lands on the step's FIRST pass. The lines tell the passes apart
(`exec`), but the anchor does not carry the pass, so a failure on the third
pass links to the first; the report's cards below it show the rest.

`steptix stats --failures` prints the report as a `file:` URL with the anchor
after `#`: `file:///C:/…/reports/2026-09-28_07-12-50-recording.html#step-11`,
which a terminal or editor opens at the failing step. A Windows path with
`#step-11` stuck on the end opens nothing, and a space in it would end the
link early; the URL escapes both. `--json` keeps `path` and `anchor` apart
beside the `href`.

A step whose lines carry `card: false` has no card: today, the branch steps
of a watch group on the Sessions API, whose report writes no row for them. It
is linked to the report without an anchor, with a note saying so.

### 8.4 When the report is gone, or not there yet

Reports are deleted and moved. The link is a convenience and the counts don't
depend on it: `steptix stats` still reports a line whose report is missing, and
marks it `(report deleted)`.

A run with no run line has not ended, or never will: it crashed or was killed
before it could write one. `steptix stats` tells the two apart by the run's
newest line — within the last day, `(not written yet)`; older than that,
`(run did not finish)` — so a crashed run does not read as pending forever.

## 9. Reading it: `steptix stats`

A new CLI command, next to `steptix status` and `steptix stop`.

| Flag | Effect |
|---|---|
| (none) | The last 30 days, `suite: user`, `source: ai`, grouped by selector form, plus the steps and cost lines (§1) |
| `--since <when>`, `--until <when>` | The time window; forms below |
| `--site <host>`, `--model <id>`, `--test <path>` | Filters: part of the host, any case; the whole model id, any case; part of the test's path, or a longer path that ends in it, either slash |
| `--suite user,live,bench,compile`, `--source ai,code` | Which runs count (defaults `user` and `ai`) |
| `--by form\|site\|model\|prompt\|test\|outcome` | What to group by. Groupings by step (`site`, `model`, `prompt`, `test`) also show steps, average tokens and calls a step |
| `--failures` | List failed actions, newest first, with step text, selector, outcome and report link (§1) |
| `--costly` | List the steps that used the most tokens, most first — newest first among equals — with their report links. A step with no token count (a code-behind replay, usage never reported) is left out |
| `--limit <n>` | How many `--failures` or `--costly` entries to show, a whole number of at least 1 (default 20); the output says how many more there are. With neither, it does nothing, and a note on stderr says so |
| `--json` | The same result as JSON, for other tools |

`--by`, `--failures` and `--costly` each choose what to show, so only one at
a time; two together is refused.

**Time.** `--since` and `--until` take a span back from now — `24h`, `7d`,
`2w`, at least 1 of the unit, and no further back than a date can go — a date
(`2026-09-01`), a date and time (`2026-09-01 07:30`), both read in the local
time zone, or an ISO instant with its own offset (`2026-09-01T07:30:00+10:00`).
A bare date is a whole day: `--since` starts at its first moment and `--until`
ends after its last, so `--since 2026-09-01 --until 2026-09-28` includes the
28th. `--until` alone ends the default 30 days there. The window starts
inclusive and ends exclusive; `--until` must be after `--since`.

**What the numbers count.**

- *First try ok* is the share of actions on a step's first attempt that
  worked, whatever the turn. *Most common failure* counts those same actions,
  so it explains the rate beside it. *Actions* counts every attempt; when the
  table holds retries, a line under it says so. A failure on a retry is still
  in `--by outcome` (every attempt) and in `--failures`.
- *Steps* counts steps that ran to an end, passed or failed, and splits the
  passes: *passed first try*, *after a retry* (a later attempt), *after a
  failed action* (an action failed and a later turn of the first attempt
  recovered; shown only when there are any), and *failed*. The shares are
  rounded so they add up to 100.
- A step is counted under its own line's site and model when it has them —
  the only ones a step with no actions has — else under the ones most of its
  actions carry, so the groups add up to the whole.
- A step's actions are its lines with the same `run` and `exec`; a line from
  before `exec` falls back to the run, row, step, hook, place in the hook
  scope and step text.

**When the view is empty.** With no filter typed, the defaults alone hid what
the window holds, and the command says which default hid what and the flag
that shows it: "1 action and 1 step from the live suite: --suite live shows
them". With nothing in the default window, it names the latest earlier month
on disk. With filters typed, it says which flag left out how many actions and
steps. A `--model` that matches nothing lists the model ids the window has,
since the flag wants the whole id.

**Recording.** Whether recording is on comes from the machine-wide `.env`,
with a shell's own `STEPTIX_STATS=off` named apart (§6.4). Lines skipped as
unreadable (§6.2) and month files pruned (§6.3) are counted in a note at the
end.

**`--json`** carries the window, the filters, the stats folder, `recording`
(the machine's), the lines read and skipped, those in the window, matched and
left out (these three counted as actions and steps), the files pruned, any
notes as `warnings`, `modelsInWindow` when `--model` was given, and the
summary or the list. A list entry's `report` has a `state`: `linked`, with
`path`, `anchor` and `href`; `no-card`, with `path`, `href` and `anchor:
null`; `deleted`, with `path`; or `none`, `pending` or `unfinished` (§8.4). A
failure entry also carries `hook`, `hookIndex` and `exec` when its line does.

Output follows the house style of `steptix status`: plain text, one table, no
colour required. Nothing the command does is allowed to escape as an
exception: a bad flag, an unreadable folder or anything unexpected is a
message on stderr and exit code 1.

## 10. Starting with history

`steptix stats import <reports folder>` reads HTML reports already on disk and
writes the lines they contain, tagged `"imported": true`, with the report
itself as `report`. It is idempotent: `stats/imported.json` records each
report's path and modification time, and a report already imported is
skipped.

It's best-effort. A report that can't be parsed is skipped and counted.
Imported lines have no rules fingerprint (`prompt: null`), because the report
doesn't carry one, and no `exec`, so their steps join their actions by the
older key (§9). `steptix stats --by prompt` shows them as "(imported, no
fingerprint)", apart from today's steps that were never shown the step
prompt (§5.5). Import is what gives the scoreboard a "before": for example,
the 17 super.test runs from before PR #162.

## 11. The simple-steps suite

A small set of simple steps whose first-try rate is the scoreboard's reference
number, in two halves.

- **Offline**, in `fixtures/test-app`: pages that copy the traps already met:
  - a button whose label is inside a `<span>`
  - a React Aria listbox with nested option text
  - `aria-label` different from the visible text
  - a CSS-drawn arrow (`::after`)
  - an `<a>` without `href`
  - a button inside an iframe
  - duplicate mobile and desktop menus

  Steps against them run in the live suite (so `suite: live`), with no
  internet needed.
- **Real sites**: a handful of read-only steps on public sites. Navigate, open
  a menu, pick an option, read a value. No form submissions, no personal data,
  no sign-in.

`npm run bench -- --runs 3 --models <a>,<b>` runs the real-site half several
times per model with `STEPTIX_STATS_SUITE=bench`. It then prints first-try rate,
time and tokens per step, from the same files `steptix stats` reads.

## 12. Performance

Recording adds no model calls, no page calls and no waits. The recorder does
string work on a result that already exists, plus one unawaited append per
line. The acceptance check (§14) measures it on a 20-step run.

Reading, measured 2026-09-29 on the development machine (12 cores, Node 22)
against one month file of 200,000 lines (105 MB), with the lines in the
current format:

| View | Time | Memory added |
|---|---|---|
| default, 30 days (every line in the window) | 0.9 s | 190 MB |
| `--failures`, 30 days | 0.85 s | 185 MB |
| `--since 1d` (one day of the month) | 0.2 s | 60 MB |

Lines written before `exec` and a step line's own site and model cost more,
since each step's actions are tallied by the older key: about 1.2 s for the
same 30-day view. Time and memory grow with the lines the window keeps, not
the lines on disk, because a line outside the window is passed over from its
prefix (§6.2): 1,100,000 lines (577 MB, past what a whole-file read can hold)
take 4.9 s and 790 MB for a 30-day view that keeps them all, and 0.9 s and
80 MB for one day of them.

## 13. Phases

- **A: record and read.** The recorder, `StatsContext` threaded through every
  loop, per-interaction token usage (§7.1), the run line, `steptix stats` with
  its filters, `--failures`, `--costly` and `--json`, the report's step
  anchors, retention and the off switches. Useful on its own.
- **B: history.** `steptix stats import`.
- **C: the suite.** The fixture trap pages, the real-site steps and
  `npm run bench`.

## 14. Acceptance

1. A run of a test with a failing selector writes, in the month file:
   - action lines with the right `form` and `outcome` (`text-is`, `no-match`)
   - a step line with `firstTry: false`
   - a run line whose `report` is the report written, with a `#step-N` anchor
     that exists in that report
2. `steptix stats` on that data shows the failure under its form, and
   `--failures` prints the step text, the selector and the report link.
3. A test with a secret-named parameter used in a selector writes the selector
   masked. Its `stepText` shows the placeholder, not the value.
4. A live-suite run writes `suite: live` lines, and the default `steptix stats`
   leaves them out.
5. `STEPTIX_STATS=off` writes nothing. A project with `"stats": {"enabled": false}`
   writes nothing, and other projects on the machine still record.
6. Four processes appending at once for a minute leave a file in which every
   line parses.
7. A step line exists for every recorded step (§7) — every step that asked
   the model something, and every code-behind replay — with no duplicates,
   including inside `If`/`While` bodies and data rows, and none for a step
   that made no model call.
8. On a 20-step run, the recorder adds under 5 ms per step, measured.
9. Deleting a report leaves its lines counted, and they are marked
   `(report deleted)`.
10. On a run with no estimated usage, the step lines' `tokensIn` and
    `tokensOut`, plus the calls that belong to no step, add up exactly to the
    run line's totals, which equal the report's token counts.
11. A step that retried shows the tokens of both attempts, and `calls` counts
    both.

## 15. Tests

- **Unit:**
  - the form classifier (every row of §5.3, and the scoped-selector rule)
  - the outcome classifier (every row of §5.4, from real error strings)
  - the rules fingerprint (stable across calls, changes when a rule changes,
    ignores context files)
  - masking
  - line size limits
  - token summing across turns, retries, assertions and structure questions,
    with an estimate marked as such
- **At the seam:** a run through the Sessions API route and one through the
  CLI runner, each producing the expected lines in a temporary user root (the
  `UserRootDeps` seam in `src/env/user-root.ts`).
- **Source pin:** every `executeStep` call site passes `stats` (§7).
- **Concurrency:** parallel appends from child processes, then read back
  (acceptance 6).
- **The rest of the suite never writes real data.** `vitest.config.ts` sets
  `STEPTIX_STATS=off` for every test; the recording tests turn it back on and point
  the user root at a temporary folder.
- **The reader:** streaming across chunk boundaries (multi-byte text, CRLF, a
  byte-order mark); a line outside the window never parsed; a line in another
  key order still read; every field §5 requires, per kind, checked and a bad
  line skipped and counted; run lines kept past `--until`; retention from the
  machine file only, and never the window's months.
- **The command:** `steptix stats`, every `--by`, `--failures`, `--costly` and
  `--json` against a fixture month file in a project whose path has a space;
  each empty-view message; every refused flag, including spans of 0 and spans
  past the calendar; and a failure deep inside reported with exit 1, not
  thrown.

## 16. Open questions

1. **The element-reference idea.** If the model later picks elements by
   reference from Playwright's accessibility snapshot, `form` gains `ref`
   (reserved in §5.3). The scoreboard is how that idea would be judged against
   today's selectors, so phase A should land first. The token counts matter
   here too: the accessibility snapshot measured about a quarter of the size
   of today's page snapshot on www.super.test, and §7.1 is what would show
   whether that saving is real.
