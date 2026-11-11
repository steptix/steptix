# Reporters: JUnit XML and JSON results from `steptix run`

**Status:** built, in one phase.
**Opened:** 2026-11-11
**Scope:** the `steptix run` command only (§11).

## 1. What this is

Two more files a run can write beside its HTML reports, so that a CI system
and a script can read the results without opening a browser.

What you would type:

```
> steptix run --headless --reporter junit,json
```

and what the run leaves in `reports/`:

```
reports/
├── 2026-11-11_09-14-02-login-flow.html      one per test, as today
├── 2026-11-11_09-14-40-checkout.html
├── junit.xml                                 new
└── run.json                                  new
```

`junit.xml` is what a CI system reads to list tests on a pull request.
`run.json` is the same results in a shape a script or a coding agent can
read. Both point at the HTML reports, which stay the only place screenshots
live.

## 2. Why

Today a CI job learns two things from a run: the exit code, and one HTML
file per test that somebody has to download and open. The pull request page
says "failed" and names no test and no step. The run's results already hold
everything a CI system wants (`RunSummary` in
[src/report/types.ts](../../src/report/types.ts)); nothing writes it in a
format one can read.

`--reporter` already exists on `steptix run` and accepts one value, `html`.

## 3. Decisions

Settled with the user on 2026-11-11:

1. **Screenshots stay in the HTML report.** JUnit and JSON link to it and
   carry no image.
2. **One testcase per test file.** Steps are not testcases: they depend on
   each other, so the steps after a failure would be noise.
3. **A data-driven test is one testcase per row**, named
   `<test title> [row 3]`. All of a test's rows link to its one report.
4. **A healed step is a pass**, and the heal is recorded in the testcase's
   properties. Under `--fail-on-healed` it is a failure, so the files and the
   exit code always agree.
5. **Fixed file names**, `junit.xml` and `run.json`, in `reports.outputDir`,
   overwritten by each run. No `--output` option in this version.
6. **Switched on by `--reporter` or by `reports.reporters`** in
   `steptix.config.json`. The flag wins. HTML is always written.
7. **One testsuite per run**, named after the project folder (§10 says
   how it is found). A testcase's
   `classname` is its test file's path relative to the project root, with `/`
   separators on every platform.
8. **Failure text** is the step number, the step text, the error, and the AI
   diagnosis's root cause and fault category when there is one. No AI request
   or response text.
9. **Tolerated and skipped steps do not fail a testcase.** Their counts go in
   the properties and in the JSON.
10. **The JSON is a summary**: tests and steps, no sub-actions, DOM
    snapshots, AI messages or screenshots. It carries a `schemaVersion`.
11. **`steptix run` only.** Runs from VS Code, MCP and the Runner UI write
    what they write today.
12. **A run that ends early still leaves valid files** that do not read as a
    pass (§8).

## 4. Choosing reporters

```
steptix run --reporter junit
steptix run --reporter html,junit,json
```

```json
{ "reports": { "reporters": ["junit", "json"] } }
```

- The names are `html`, `junit` and `json`, comma-separated on the command
  line, in any order and any letter case. Spaces around a comma are ignored
  and a name given twice counts once.
- The flag can be repeated, and the lists add up: `--reporter junit
  --reporter json` is `--reporter junit,json`.
- `html` is always written whether or not it is named, because the other two
  link to it. Naming it is allowed and changes nothing.
- When `--reporter` is given it replaces `reports.reporters`; the two lists
  are not merged. So `--reporter html` on a project whose config names
  `junit` writes no `junit.xml`.
- A name that is not one of the three is refused before anything runs: a
  usage error naming the three, exit code 1. An unknown name in
  `steptix.config.json` is refused the same way, naming the file. Before
  either refusal, `junit.xml`, `run.json` and their temporary files are
  removed from `reports.outputDir`, both of them, since which reporters were
  meant is not known (§5).
- A `--reporter` that names nothing (`--reporter ""`, as a CI script with an
  unset variable sends) is refused the same way. Taking it as "no reporters"
  would write nothing and say nothing.
- When an unknown name is in a config file found above the working
  directory, the message says `steptix.config.json` without its folder.
- With neither given, a run writes what it writes today.
- Only `steptix run` reads `reports.reporters`. Runs from VS Code, MCP and
  the Runner UI ignore it, whatever it holds, and do not check its names.

The `--reporter` option loses its default value of `html`, so that "not
given" can be told apart from "given as html".

## 5. Where the files go

`junit.xml` and `run.json` are written to `reports.outputDir` (default
`./reports`), beside the HTML reports, and replace the files of the same
name from the run before.

The first thing a run does with them, as soon as the configuration is loaded
and the reporter names are checked, is remove a `junit.xml` or `run.json`
left there by an earlier run, for each of the two reporters that is on. A
run that then stops before it knows its tests (an environment file that
does not load) leaves no file, and CI
cannot publish the previous run's results as this one's.

A run whose reporter names are refused (§4) removes both files, whichever
names it was given, and then stops. A misspelt name in a CI job therefore
leaves no results file at all rather than the last run's. A `--row` that
matches more than one test file is refused after the stale files are gone,
and writes none.

A run that finds no tests (no files, or none matching `--tag`) writes both
files with zero tests. It exits 0 as today.

Two runs that share an output folder overwrite each other's files. A CI job
that calls `steptix run` more than once gives each call its own folder
(`reports.outputDir`) or publishes the files between calls. The README's CI
example shows this, and uploads the whole reports folder whether the run
passed or failed, since the `Report:` line in a failure is a file name in
that folder and not a link.

## 6. `junit.xml`

An invented run of three tests, one of them data-driven with two rows:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="my-tests" tests="4" failures="1" errors="0" skipped="0" time="83.412">
  <testsuite name="my-tests" tests="4" failures="1" errors="0" skipped="0"
             time="83.412" timestamp="2026-11-11T09:14:02.000Z">
    <testcase name="Login Flow Test" classname="tests/login-flow.md"
              file="tests/login-flow.md" time="21.004">
      <properties>
        <property name="report" value="2026-11-11_09-14-02-login-flow-test.html"/>
        <property name="tokens" value="0"/>
        <property name="steps" value="4"/>
        <property name="stepsFromCode" value="4"/>
      </properties>
      <system-out>[[ATTACHMENT|2026-11-11_09-14-02-login-flow-test.html]]</system-out>
    </testcase>
    <testcase name="Checkout [row 1]" classname="tests/checkout.md"
              file="tests/checkout.md" time="18.220">
      ...
    </testcase>
    <testcase name="Checkout [row 2]" classname="tests/checkout.md"
              file="tests/checkout.md" time="19.870">
      <failure type="step" message="Step 6: Verify the order total is &quot;42.00&quot;">Step 6: Verify the order total is "42.00"
Expected "42.00" but the page showed "24.00".
Report: 2026-11-11_09-14-40-checkout.html#row-2-step-6</failure>
      ...
    </testcase>
    ...
  </testsuite>
</testsuites>
```

### 6.1 What becomes a testcase

- A test with no data rows is one testcase. Its `name` is the test's title.
- A data-driven test is one testcase per row in the report's `rows`, named
  `<title> [row N]` with the row's one-based number. The row's values are
  not in the name, so the name stays the same from run to run when the data
  changes; they are properties (`row.<column>`), already masked as the HTML
  report masks them.
- `classname` and `file` are the test file's path relative to its project
  root, with `/` separators. The project root is the one the runner already
  finds by walking up from the test file (`resolveProjectRoot`), not the
  working directory, so a test has the same name wherever `steptix run` was
  started. A test file with no project root above it is named relative to
  the working directory.
- `time` is seconds with three decimals: the test's duration, or the row's.

### 6.2 What a testcase's result is

| The test or row | Element |
| --- | --- |
| Passed | none |
| Passed, with steps that healed | none; with `--fail-on-healed`, `<failure type="healed">` naming the healed steps |
| Failed at a step | `<failure type="step">` |
| Failed before any step failed (the report's `error`) | `<error type="run">` with that text |
| Failed with no failing step and no `error` | `<error type="run" message="The test failed before any step failed.">` |
| Was stopped by the user (`aborted`) | `<error type="stopped">` |
| A report whose status is `skipped` | `<skipped message="The test was skipped."/>` |
| A row `--bail` stopped the run reaching | `<skipped message="Not run: the run stopped at the first failure (--bail)."/>` |
| A test `--bail` stopped the run reaching | the same `<skipped>` |
| A test the run never reached for any other reason | `<error type="not-run">` (§8) |
| A test file that could not be read as a test | `<error type="parse">` with the message (§8.1) |
| A test that ended the run by throwing | `<error type="run">` with the message (§8.1) |

The failing step is the first step of the test, or of that row, whose status
is `failed` and which is not `tolerated`. A failure's `message` is
`Step N: <step text>`, or `<scope> hook: <step text>` when the failing step
is a hook's line (`before hook: Sign in`, `beforeEach hook: Clear the
cart`), since a hook line's number is only the step it ran beside. Its body
is that line, the step's error, and a `Report:` line with the report's file
name and the id the report gives that step's card. The id is `#step-6` or
`#row-2-step-6`, with `-2`, `-3`… added for the second and later cards of a
step that ran more than once (a loop body, a `beforeEach`), so the link
lands on the pass that failed and not on the first one. The writers and the
report take these ids from one place (`stepCardIds` in
`src/report/anchors.ts`). For a test without rows that has an AI
diagnosis, two more lines follow: `Cause: <rootCause>` and
`Category: <faultCategory>`. A data-driven test's diagnosis is not attached
to its rows, because the report holds one diagnosis and it does not say
which row it is about.

A run with no AI (no key, or `ai.allowInRuns: false`) makes no diagnosis,
and the HTML report says "Diagnosis skipped" in its place. That note is not
a cause, so neither file carries it: no `Cause:` and `Category:` lines, and
no `diagnosis` in the JSON.

A stopped testcase's message is `The run was stopped by the user.`; its
body adds the step that was in flight and its `Report:` line. A
`--fail-on-healed` failure's message counts and names the healed steps
(`1 step healed (--fail-on-healed): step 2`); its body lists each one and
ends with a `Report:` line.

Inside a testcase the elements come in this order: the result element
(`<failure>`, `<error>` or `<skipped>`) when there is one, then
`<properties>`, then `<system-out>`. A testcase that did not run has only
its result element.

### 6.3 Properties

On every testcase that ran:

| Name | Value |
| --- | --- |
| `report` | The HTML report's file name, relative to `junit.xml` |
| `tokens` | Tokens the test or row used |
| `steps` | Steps that ran |
| `stepsFromCode` | Of those, how many ran from code-behind |
| `healedSteps` | Present when above zero. Counted off the steps for a row, and for a data-driven test as a whole, whose report holds only its first row's figure |
| `toleratedSteps` | Present when above zero |
| `skippedSteps` | Present when above zero |
| `video` | The `.webm`'s relative path, when one was kept |
| `row.<column>` | Each of a row's values, masked |

`<system-out>` holds one `[[ATTACHMENT|<path>]]` line for the report and one
for the video when there is one. Jenkins and several other CI tools turn
that line into a link; the rest ignore it.

### 6.4 Text

Everything written into the XML is escaped, and characters XML 1.0 does not
allow (most control characters) are removed. Terminal colour codes are
stripped first from all of it (titles, step text, errors, row values,
paths): browser errors carry them, and a CI page shows them as `[31m`.
Removing only the forbidden ESC character would leave the `[31m` behind.

## 7. `run.json`

```json
{
  "schemaVersion": 1,
  "steptix": { "version": "1.0.0", "commit": "3f9a1c2" },
  "startedAt": "2026-11-11T09:14:02.000Z",
  "finished": true,
  "durationMs": 83412,
  "exitCode": 1,
  "totals": {
    "tests": 3, "passed": 2, "failed": 1, "stopped": 0, "notRun": 0,
    "tokens": 18400, "inputTokens": 17100, "outputTokens": 1300,
    "healedSteps": 0
  },
  "tests": [
    {
      "title": "Checkout",
      "file": "tests/checkout.md",
      "tags": ["smoke"],
      "status": "failed",
      "durationMs": 38090,
      "tokens": 18400,
      "report": "2026-11-11_09-14-40-checkout.html",
      "rows": [
        { "row": 1, "status": "passed", "durationMs": 18220, "tokens": 0, "values": { "plan": "basic" } },
        { "row": 2, "status": "failed", "durationMs": 19870, "tokens": 18400, "values": { "plan": "pro" } }
      ],
      "failure": {
        "row": 2,
        "step": 6,
        "text": "Verify the order total is \"42.00\"",
        "error": "Expected \"42.00\" but the page showed \"24.00\".",
        "reportAnchor": "row-2-step-6"
      },
      "steps": [
        { "row": 2, "step": 6, "text": "Verify the order total is \"42.00\"",
          "status": "failed", "durationMs": 4100, "source": "ai" }
      ]
    }
  ]
}
```

- `status` of a test is `passed`, `failed`, `stopped` or `notRun`. A test
  that passed only by healing is `passed`, with `healedSteps` above zero on
  the test; `exitCode` shows what `--fail-on-healed` made of it. A report
  whose status is `skipped` is `notRun`. A test that threw out of the runner
  (§8.1) is `failed`.
- `totals` counts tests by status (`passed`, `failed`, `stopped`, `notRun`),
  sums the tokens of the tests that ran, and adds up `healedSteps`.
- `exitCode` is `null` until the run's last write, the only one that knows
  it (§8).
- A test that has not run still has `durationMs: 0`, `tokens: 0` and
  `steps: []`.
- `steps` lists every step that ran, in order, hook lines included: its
  number, text, status (`passed`, `failed`, `skipped`), duration, and
  `source` (`code` when it ran from code-behind, `ai` otherwise). `hook`
  (the scope, such as `before`) marks a hook's line. `healed: true`,
  `tolerated: true` and `stopped: true` (the step in flight when the user
  stopped the run, whose status is `failed`) appear when they apply. `row`
  appears on a data-driven test.
- `healedSteps`, `toleratedSteps` and `skippedSteps` appear on a test when
  above zero. A data-driven test counts its healed steps off its steps, as
  in §6.3.
- `failure` is the first failing step, found as in §6.2. `reportAnchor` is
  the id of that step's card, as in the `Report:` line. `hook` names the
  scope when the failing step is a hook's line; `step` is then the step it
  ran beside. A test that failed before any step has `failure.error` alone.
  On a data-driven test it is the first row with a failing step, else the
  first row that failed without one. `diagnosis`
  (`rootCause`, `faultCategory`, `suggestedFix`, `confidence`) appears beside
  it when the report has one.
- Paths are relative to `run.json`'s folder with `/` separators, as in the
  XML. `file` is relative to the project root.
- Step text, errors and row values are the masked forms the HTML report
  shows. Nothing is read from the unmasked run.
- Terminal colour codes are stripped from titles, step text, errors, row
  values and the diagnosis, as in §6.4. Other characters are kept as they
  are; JSON can carry them.
- `schemaVersion` goes up when a field is removed or changes meaning. Adding
  a field does not change it.

## 8. A run that does not finish

`steptix run` has no handler for Ctrl+C, and a CI job that is cancelled or
times out kills the process. A file written only at the end would then be
missing, or be the previous run's. So the files are kept true while the run
goes on:

1. **Before the first test starts**, both files are written with every test
   that is about to run marked as not run: in the XML an
   `<error type="not-run" message="The run ended before this test ran."/>`,
   in the JSON `status: "notRun"` and `finished: false`. A file read at that
   moment says nothing passed.
2. **After each test finishes** and its HTML report is written, both files
   are written again with that test's result in place.
3. **When the run ends**, they are written a last time: `finished: true` and
   the exit code in the JSON, and any test `--bail` stopped the run reaching
   changed from the not-run error to `<skipped>`.

Each write goes to a temporary file in the same folder (`junit.xml.tmp`,
`run.json.tmp`, names a `*.xml` or `*.json` pattern does not pick up) which
is then renamed over the real one, so a reader never sees half a file. A
temporary file an earlier run left is removed with the stale files of §5.

A data-driven test whose rows are not known until it starts is one not-run
testcase under its title until it has run; its rows replace it then.

So a process killed during the third of eight tests leaves two results, and
six testcases that are errors. No CI system reads that as a pass. The
existing rule that a run which never finished cannot exit 0
(`guardUnfinishedRun`) covers the exit code; this covers the files.

### 8.1 A run that ends on an error

Two errors end a run today with exit code 1 and a message in the terminal
only. Both now reach the files, so the CI page says why nothing ran.

- **A test file that cannot be read as a test** (a syntax error in it, a
  skill it names that does not exist). Every file is parsed before any test
  runs, so no test has run. Both files are written with one testcase per
  file that failed to parse, as `<error type="parse">` carrying the message,
  named after the file since it has no title that can be trusted. The files
  that did parse are listed as not run. In the JSON the test's status is
  `notRun` with the message as `failure.error`.
- **A test that throws out of the runner** (a data file that is missing, a
  `--row` out of range). The test in flight becomes `<error type="run">`
  with the thrown message, and the tests after it stay not run.

### 8.2 A file that cannot be written

On Windows a rename over a file another program holds open for a moment (a
virus scanner, a CI uploader) can fail. So the rename is tried again a few
times, a short wait apart, before the write counts as failed.

A write that still fails during the run is logged as a warning and the run
goes on: the next write replaces it. Only the last write, when the run ends,
decides anything. If that one fails (a folder that cannot be written, a full
disk), the error is logged and the run exits 1 if it would have exited 0,
since CI would otherwise publish a stale or missing file under a green
build.

## 9. What the terminal shows

After the summary, one line per file written:

```
  JUnit:    reports/junit.xml
  JSON:     reports/run.json
```

The path is relative to the working directory and uses the platform's
separator, so on Windows it reads `reports\junit.xml`. A file the last
write could not leave in place has no line.

## 10. What changes in the code

- `src/report/reporters/`: `junit.ts` and `json.ts`, each a pure function
  from the run's state to text, and `run-reporters.ts`, which holds the
  state (the tests to run, the results so far, each report's path) and does
  the writes of §8.
- `runTests` ([src/runner/test-runner.ts](../../src/runner/test-runner.ts))
  takes an optional observer (`RunObserver`) with four calls: `onStart`
  with every test about to run, before the first one; `onTestDone` with the
  merged report and its path, after each report is written; `onTestError`
  when a test throws out of the runner, before the error goes on to the
  caller unchanged; and `onBail` once, after the `onTestDone` of the test
  `--bail` stopped at. Each call is awaited, and one that throws is logged
  as a warning and otherwise ignored. Each test's body sits in a try/catch
  only so `onTestError` hears which test threw. Nothing else about the loop
  changes.
- `run.ts` parses and checks the reporter names (removing both files when
  it refuses them, §4), removes the stale files, builds the observer, and
  calls its end step with the exit code before `process.exit`. It also
  catches a parse error and a throw from the runner long enough to write the
  files of §8.1, then ends as it does today.
- The testsuite's name is the name of the nearest folder at or above the
  working directory that holds `steptix.config.json`, found the way a
  test's project root is; else the working directory's own name. That walk
  also stops at the Steptix user folder, so a run from inside it is named
  after that folder.
- The step card ids the `Report:` line and `reportAnchor` use come from
  `stepCardIds` in `src/report/anchors.ts`, which the HTML report renders
  its cards with too.
- `ReportsConfig` gains `reporters`, and the JSON schema with it.
- The report's path stays out of `TestReport`, which the server and the
  Runner UI share.
- README: the `--reporter` values, and a short CI example.

## 11. What this does not do

- Runs started from VS Code, MCP or the Runner UI. They go through the
  server or the Electron app, and write the HTML report only.
- Screenshots or videos as loose files for CI to show inline.
- A testcase per step.
- An `--output` path, or a name other than `junit.xml` and `run.json`.
- A GitHub Actions summary, annotations, or any CI-specific format.
- Parallel runs or shards. When those arrive, each worker's results join the
  same two files.

## 12. Tests

Unit tests, with `runTestFn` standing in for the real runner as the
data-driven tests already do:

- Reporter names: each valid form, an unknown name on the flag and in the
  config, the flag replacing the config list, `html` alone.
- One test passed, failed at a step, failed before a step, stopped; a
  tolerated failure; skipped steps.
- A data-driven test: one testcase per row, a failed row, a row `--bail`
  did not reach, `--row` narrowing to one row.
- A healed step with and without `--fail-on-healed`, and the exit code
  matching the files in both.
- `--bail` with tests left over: `<skipped>` at the end.
- The files before the first test and after each one: every state parses,
  and no state before the end reports zero failures and zero errors while a
  test is outstanding.
- A stale `junit.xml` is gone when the run stops before any test, and both
  stale files are gone when the reporter names are refused.
- A step that ran more than once (a loop body), in a test and in a row:
  the link names the card of the pass that failed. A failing hook line is
  named by its scope.
- No tests found: both files written with zero tests.
- A rename that fails once and then works: no warning, and the exit code is
  unchanged. A write that fails during the run and works at the end: a
  passing run exits 0. A last write that fails: a passing run exits 1.
- A test file with a syntax error: both files exist and name the file and
  the message. A test that throws partway through a run: its testcase
  carries the message and the later tests are not run.
- `--reporter junit --reporter json` and `--reporter JUnit` each write what
  `--reporter junit,json` and `--reporter junit` write.
- A run started from a subfolder gives each test the `classname` it has when
  started from the project root.
- An unknown name in `reports.reporters` does not stop a run that is not
  `steptix run` (checked at the config loader, which those paths share).
- Text: `<`, `&`, quotes, a control character and a colour code in a step,
  an error and a row value.
- A masked value in a step, an error and a row value stays masked in both
  files.
- Paths use `/` on Windows, Linux and macOS, built from a root that is
  native to the platform.

One check through the real command: `steptix run` on the sample project
with `--reporter junit,json`, reading both files back.
