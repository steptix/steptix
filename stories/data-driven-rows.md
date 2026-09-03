# Data-driven rows — a table under a heading, its steps run once per row

Spec only; nothing here is built. One rule, two places: **a Markdown table
placed directly under `## Steps` loops the run; a table placed directly
under a `### Section` loops that section.** There is no reserved `## Data`
heading — the table sits on the flow it drives, and reads the same way in
both places.

The story has two parts because the two loops are different builds. Part A
(rows on `## Steps`) was reviewed 2026-09-03 by three independent passes
while the table still lived under a `## Data` heading; moving the table
under `## Steps` changed the parser and editor sections and nothing else.
Part B (rows on a `### Section`) was added after that review at the user's
direction and reviewed by three further passes the same day. All findings
are folded in and the record is in §"What the review changed".

## In plain terms

### A table under `## Steps` runs the test once per row

```markdown
---
tags: [smoke]
---

# SecureBank sign-in validation

## Config
- baseUrl: http://localhost:8787/

## Steps
| email                 | password    | outcome                                          |
|-----------------------|-------------|--------------------------------------------------|
| demo@securebank.com   | password123 | the Dashboard page is shown                      |
| demo@securebank.com   | wrongpass   | the "Invalid email or password" banner is shown  |
| nobody@securebank.com | password123 | the "Invalid email or password" banner is shown  |
| demo@securebank.com   |             | the "Invalid email or password" banner is shown  |
|                       | password123 | the "Invalid email or password" banner is shown  |

1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter the email {{email}}
4. Enter the password {{password}}
5. Click the Sign In button
6. Verify {{outcome}}
```

Each column is a variable, each row is one run of the steps beneath it.
The columns are referenced exactly like `## Parameters` values —
`{{email}}` — because they *are* parameters, one set per row. Every row
starts in a fresh browser, because a run does. Nothing else about the file
changes: `## Config`, hooks, sections, skills and `[tool: …]` calls all work
as they do today.

### A table under a `### Section` runs that section once per row

```markdown
# SecureBank document upload, one file at a time

## Config
- baseUrl: http://localhost:8787/

## Steps
1. Navigate to documents.html
2. Reject non-essential cookies in the cookie banner
3. Click "Clear all"
4. Upload each statement
5. Count the rows in the uploaded documents table [as: document_count]
6. Assert that {{document_count}} equals 3

### Upload each statement
| file                       | status                 |
|----------------------------|------------------------|
| \attachments\logo.png      | Uploaded logo.png      |
| \attachments\statement.pdf | Uploaded statement.pdf |
| \attachments\receipt-1.png | Uploaded receipt-1.png |
1. Upload file {{file}} as the statement, then click Upload
2. Assert that the status message starts with "{{status}}"
```

(The page's status reads `Uploaded logo.png (87 B)`, hence "starts
with".) Step 4 calls the section by name, as any section call does; the table
makes the call run the body three times, each with one row bound. The
page is *not* reset between iterations — the section starts on whatever
page the previous step left, the same as a section called three times by
hand — which is why step 6 can count three rows. That is the case the
run-level loop cannot express: sign in once, then try each thing.

**One rule for both.** An iteration starts where its flow starts. The
run's flow starts with a fresh browser; a section's flow starts on the
page the previous step left. The table goes directly under the heading of
the flow it drives, before that flow's first numbered step.

The argument for doing this in a natural-language framework is stronger
than in a conventional one. Five copy-pasted tests cost five AI-planned
runs each time. One flow with five rows plans each step once: step
code-behind already stores parameter *placeholders* rather than values
(`step.getVar('email')`), so once the test is compiled, rows two to five
replay what row one recorded. The loop is nearly free.

The word "data" is used three ways in this framework — `dataFile:` (rows in
an external CSV/JSON), `dataSources:` (named JSON trees) and `${data.X}`
(the environment's JSON tree). A row column is `{{email}}`, never
`${data.email}`.

### What it looks like in practice

**You write:** the sign-in file above and run it from the CLI.
**You get:** five runs in sequence, each announced on the console as
`SecureBank sign-in validation (row N)`, five reports named
`…-securebank-sign-in-validation-row1.html` through `-row5.html`, and the
run summary listing each row as its own line. Row 1 ends on the dashboard;
rows 2–5 end on the sign-in page with the red banner. The exit code is
non-zero if any row failed. A wrong expectation in row 3 goes red on row 3
and the remaining rows still run.

**You write:** the same file, and press Run in TestBench.
**You get:** the gutter paints the steps for row 1, clears, then paints
them for row 2, and so on, with a `Row 2 of 5 — email=demo@securebank.com,
password=***, outcome=the "Invalid email…` line in the output log at each
boundary. When the loop ends the gutter shows the *worst* status each
step reached across the rows, and hovering a red step says which rows
failed there. Each row gets its own report, `…-securebank-matrix-row1.html`
through `-row5.html` (the server names reports from the file, the CLI from
the title — only the `-rowN` suffix is common), and the output log links
all five.

**You write:** the sign-in file, put the cursor on the fourth table row,
and pick *Run this row*.
**You get:** one ordinary run, using row 4's values, reported as row 4 of
5. It is an interactive run like any other, so a breakpoint, Pause, F11
into a skill, the Variables view and *Re-run from step N* all work. This
is the debugging loop: a matrix fails on one row, you fix the row or the
page, you re-run that row alone.

**You write:** the upload file above and press Run.
**You get:** one run, one session, one report. Steps 1–3 run once; the
body of *Upload each statement* runs three times, its two lines
repainting per iteration and the output log saying `Upload each
statement — iteration 2 of 3 — file=\attachments\statement.pdf,
status=Uploaded statement.pdf`; then steps 5–6 run once and the count is
3. The report lists six body-step results, each badged `section: Upload
each statement (2/3)`, in the flat list the report has today. A
breakpoint on body line 2 pauses on every iteration, Continue carries on
in place, and the Variables view shows that iteration's `file` and
`status` under a frame labelled `Upload each statement (2/3)`. A failed
iteration ends the run there, as any failed step does: its line and the
call-site step 4 are red, the hover says which iteration, and the
remaining iterations and steps 5–6 are not run. Continue after that
failure re-enters at the call and runs every iteration again.

**You write:** a table under `## Steps` and `dataFile: users.csv` in the
frontmatter.
**You get:** a parse error naming both — a run has one source of rows —
from the CLI, from TestBench's diagnostics, and from a run.

**You write:** the step *"Verify {{outcome}}"* and compile the sign-in
test to code-behind.
**You get:** the compile records row 1 (as it does for `dataFile:` tests
today) and generates entries for steps 1–5, where the row values are typed
into fields and become `step.getVar('email')`. Step 6 stays `ai: true`
with the reason *"`{{outcome}}` decides what the step checks, not what it
types"*. The reason is on the entry so it is not mistaken for a compile
failure. Rows 2–5 replay steps 1–5 from code for zero tokens and spend one
AI turn on step 6 each. The upload section compiles the same way: body
line 1 becomes `step.filePath(step.getVar('file'))`, body line 2 stays AI
because `{{status}}` is what it checks. See §"Code-behind".

**You write:** a `password` column whose cells are `$TEST_PASSWORD`.
**You get:** the real value from `.env`, the way a `## Parameters` value of
`$TEST_PASSWORD` resolves today. This is new work for rows (§"Context"),
not existing behaviour, but it is the same rule.

### More examples

Which loop to reach for:

| You want                                                   | Put the table under |
|------------------------------------------------------------|---------------------|
| every row to start clean — a login, a signup, a checkout   | `## Steps`          |
| rows to build on each other, or to share a login/session   | a `### Section`     |

**MFA codes — a run loop, because a good code navigates away.** The
fixture's MFA page takes the valid code from the query string and sends
the browser to the dashboard on success; the next row has to start on the
MFA page again, so this is a run loop even though the steps are tiny.
The five-digit row never reaches a click: the page keeps Verify disabled
until six digits are typed.

```markdown
## Config
- baseUrl: http://localhost:8787/

## Steps
| code   | result                                            |
|--------|---------------------------------------------------|
| 123456 | the Dashboard page is shown                       |
| 000000 | the "Invalid verification code" banner is shown   |
| 12345  | the Verify Code button is disabled                |

1. Navigate to mfa.html?delay=500
2. Wait for the verification form to appear
3. Enter {{code}} as the verification code
4. Verify {{result}}
```

**The payee gate — a section loop, because it is one form on one page.**
The Transfer button on the fixture's portfolio page is enabled only while
the payee field has text, and the hint beneath it says which. Both states
are reachable by typing, so the rows drive one form back and forth with
no navigation, and step 3 runs once at the end on the same page. The
hint flips only on an `input` event, so body line 1 must clear the
field with a fill rather than skip it when the cell is empty — a `fill('')`
fires the event.

```markdown
## Steps
1. Navigate to http://localhost:8787/assertions
2. Check the payee gate
3. Verify the pending settlement amount is $1,204.75

### Check the payee gate
| payee    | hint                                    | transfer_button |
|----------|-----------------------------------------|-----------------|
| J. Smith | Ready to transfer.                      | enabled         |
|          | Select a payee to enable this transfer. | disabled        |
1. Clear the To payee field and type {{payee}}
2. Verify the hint under the Transfer button says "{{hint}}"
3. Verify the Transfer button is {{transfer_button}}
```

Compiled, body line 1 becomes a `getVar('payee')` fill; lines 2 and 3
stay AI, because `hint` and `transfer_button` decide what is checked.

**Secrets in cells, a parameter shared by every row.** Not a fixture
test. `$VAR` cells resolve from `.env` the way a `$VAR` parameter does
(decision 3), and a `## Parameters` value with no column of its own —
`password` here — is the same for every row. The `email` and `greeting`
columns are masked nowhere; had the column been called `password` the
report would show `***`.

```markdown
## Parameters
- password: $TEST_PASSWORD

## Steps
| email         | greeting        |
|---------------|-----------------|
| $ADMIN_EMAIL  | Welcome, Admin  |
| $VIEWER_EMAIL | Welcome, Viewer |

1. Navigate to the baseUrl
2. Enter the email {{email}}
3. Enter the password {{password}}
4. Click the Sign In button
5. Verify the page greets with "{{greeting}}"
```

**A column as a skill argument.** A body step can pass a column to a
skill exactly as it would pass any variable, because the row is
interpolated into the body before the call line is parsed. The
single-column table is legal. A cell containing a double quote would
break the skill-call parser, as a literal argument would. Body line 2
stays AI under the decline rule — the value appears only in what is
asserted — which is the right outcome: the check differs per row.

```markdown
### Try each spelling
| email                |
|----------------------|
| demo@securebank.com  |
| DEMO@SecureBank.com  |
1. [skill: flows/enter_email email="{{email}}"]
2. Verify the email field shows {{email}}
```

**A capture inside a loop is last-iteration-wins.** Not a fixture test.
After the loop `{{balance}}` holds the Savings Plus figure; the Everyday
Checking value was overwritten. To keep every iteration's value, read
them into a list with one step after the loop, or wait for the
"collect across iterations" follow-on.

```markdown
### Read each balance
| account           |
|-------------------|
| Everyday Checking |
| Savings Plus      |
1. Select {{account}} in the From account dropdown
2. Read the balance shown for the selected account [as: balance]
```

**Nested loops multiply.** Not a fixture test (the portfolio page has no
month filter). A looped section that calls a looped section runs the
inner body once per inner row for each outer row, and the Variables view
shows both frames, `Per account (1/2)` over `Per month (3/3)`. Six
iterations here. The inner body may also reference `{{account}}`: an
inner body is interpolated with every enclosing row, innermost winning
(§"Scope" under part B).

```markdown
### Per account
| account           |
|-------------------|
| Everyday Checking |
| Savings Plus      |
1. Select {{account}} in the From account dropdown
2. Per month

### Per month
| month    |
|----------|
| January  |
| February |
| March    |
1. Select {{month}} in the Month filter
2. Verify the statement heading names {{month}}
```

**Two shapes to avoid.** A column that holds a *verb* — `{{action}} the
Save button` with rows `Click` and `Double-click` — runs fine under AI
and never compiles, since no recorded field carries a verb; write two
steps or two rows of a noun instead. And a section's columns are bound
only inside that section's body: `{{payee}}` in step 3 of the payee
example, after the call, is an unresolved placeholder that reaches the
model as text, and TestBench's completion will not offer it there.

## Context — what exists, and what is missing

More of this exists than the feature's absence from the docs suggests.

**The CLI already loops a run.** `dataFile:` in a test's frontmatter names a
CSV or JSON array. [`expandTestInstances`](../src/runner/test-runner.ts)
(no test covers it today) loads the file with the parser's `loadDataFile`
— not the env layer's function of the same name in
[data-loader.ts](../src/env/data-loader.ts), which reads the `${data.X}`
tree — and produces one `TestInstance` per row:
`{ test, dataRowIndex, resolvedParameters }`. `runTests` runs each
instance as a full `runTest`, so hooks, browser lifecycle and report
generation are per row. `resolveParameters` in
[parameters.ts](../src/parser/parameters.ts) merges the row *over* the
`## Parameters` values (a row column shadows a parameter of the same name;
a parameter with no column keeps its value for every row). The console
announces `Title (row N)`; the run-log *file* does not — it is opened with
the bare title and rows are told apart only by timestamp. The report
carries `dataRow`, renders a "Data row" meta line and gets a `-rowN`
file-name suffix ([generator.ts](../src/report/generator.ts)). `aiui list`
prints a `data-driven` tag from the frontmatter alone; it never parses the
body. The compile pipeline's `firstDataRow`
([compile.ts](../src/codebehind/compile.ts)) records against row 1 and
says so, and `resolveCompileParameters` is a second, independent copy of
the row-over-parameters rule. The `RunSummary` counts every instance as a
separate test (`totalTests = reports.length`); there is no aggregate over a
test's rows.

**A row value skips `$VAR` resolution.** `resolveValue` returns a data-row
value verbatim before it reaches the `$` branch, and row-only keys are
merged verbatim; `resolveCompileParameters` does the same. A
`$TEST_PASSWORD` cell in a `dataFile:` today types the literal string.
Decision 3 makes cells follow the parameter rule, which fixes `dataFile:`
rows too.

**The Sessions API path does not loop for runs.** TestBench parses
`## Config` and `## Parameters` on the client with runner-core's
[test-meta.ts](../runner-core/src/test-meta.ts), resolves `$VAR` with
`resolveValueFromEnv` against the `.env` overlay, and posts the run —
`steps`, `sourceLines`, `parameters`, `sections`, `testFilePath`… — to
`POST /sessions/:id/steps`
([run-controller.ts](../testbench-native/src/extension/run-controller.ts),
`streamSteps`). One Run is one batch per contiguous step block: an
`[input:]` or `[interactive]` step splits it into several `streamSteps`
calls, so the row loop wraps that block loop rather than replacing it. The
server takes `parameters` as given
([session-manager.ts](../src/server/session-manager.ts), "Build the
parameter map") and interpolates `{{…}}` per step, leaving an unresolved
placeholder literal. So a `dataFile:` test run from TestBench runs *once*,
with `{{email}}` reaching the model as text if `## Parameters` did not
also define it. The same is true of the MCP `run_test_file` path
([assemble.ts](../src/mcp/assemble.ts)), which reads `parsed.parameters`
and posts one batch, and of the old Electron UI's `runner-adapter`, which
takes `instances[0]` on purpose. TestBench's *compile* path is different:
[compile-runner.ts](../src/server/compile-runner.ts) parses the file
server-side and already applies `firstDataRow`, so a `dataFile:` compile
from TestBench records row 1 today. Runs are the gap.

**Sections are already called more than once, and each call is a frame.**
A `### Name` block is a macro: it shares the caller's scope, declares no
parameters, and is invoked by writing its name as a whole step
(stories/test-script-sections.md). The expander
([expander.ts](../src/skills/expander.ts)) inlines the body at each call
site and pushes a frame of kind `section` per call, so `sections-demo.md`
calling `Sign in` twice already gets two frames, two sets of painted body
lines, two sets of step results, and step-into per call. Skill frames go
one further: a `[skill: name arg="v"]` call carries `inputs` — the args —
which the expander interpolates into the body text at expansion time and
snapshots on the frame so the Variables view can show them at a pause and
`step.getVar` can read them at replay. Section frames have no `inputs`
today. Code-behind is generated once per body, not per call: "a section
invoked twice binds both invocations to the same entries", frame-aware
`getVar` doing the per-call mapping (stories/step-codebehind.md, "Skill
variables"). TestBench ships section definitions in the batch's
`sections` field (`{ name, headingLine, steps, stepLines }`, contract
§3.2), because the server cannot read an unsaved buffer. Part B is "a
section call with rows is N calls, each a frame with `inputs`" — the
machinery is all there, it has never been fed a table.

**Typed values already reach the code-behind as variables.**
`step.getVar(name)` ([execute.ts](../src/codebehind/execute.ts)) reads the
run's `resolvedParameters` — or, inside a *skill* frame, that frame's
`inputs`; a plain section frame gets an empty scope today
(`varScopeFor`, [loader.ts](../src/codebehind/loader.ts)) — at replay
time. The generator is handed `stepParameters` — the name/value
pairs the step's source references ([generate.ts](../src/codebehind/generate.ts))
— as a prompt plus a leak guard that refuses generated code containing a
parameter's literal value. Built for `## Parameters` and skill args; rows
are just parameters that change per run or per iteration, so a value that
gets *typed* replays unchanged. This is the fact the story leans on.

**The step cache is not part of this story.** It is being removed
(decided 2026-09-03; the retirement is its own story, not yet written).
Worth recording why rows would have forced the question anyway:
[`reverseInterpolate`](../src/cache/step-cache.ts) swaps parameter values
back to `{{name}}` only in an action's `value` field; an `assert` action
carries its expectation in `condition` and `expected`
([ai/types.ts](../src/ai/types.ts)), untouched on write or read; the cache
key is the step index on the CLI and a frame-scoped line key on the
server, row-agnostic either way, and rows already share one cache
directory (`tests/cli-cache-env.test.ts`, "data-driven rows SHARE one
cache dir"); and replay executes `cachedTurn.actions` as stored
([step-executor.ts](../src/runner/step-executor.ts), "from cache on turn
1"). Row 2 of the matrix would replay row 1's assertion — check for the
dashboard, on a page showing the banner. Until the cache is gone, row runs
simply do not use it (decision 8).

**Nothing parses a table.** [markdown.ts](../src/parser/markdown.ts)
`parseSections` recognises five reserved H2s (`Config`, `Parameters`,
`Outputs`, `Steps`, `Hooks`); inside `## Steps` it reads `list` tokens
into steps and ignores every other token, and a raw line scanner
(`scanStepSpans`) pairs the numbered lines with their `###` section
membership. runner-core's `step-lines.ts` and `section-index.ts` do the
same for the editor, treating any non-numbered, non-heading line as prose.
`marked` (the lexer in use) emits GFM `table` tokens already, so the parse
is a new branch in the walk, not a new parser. No test or skill file under
`fixtures/`, `templates/` or `tests/` contains a pipe-led line inside
`## Steps`, so claiming that position breaks nothing.

## Decisions

1. **A table is a loop over the flow whose heading it sits under.** Under
   `## Steps`, it loops the run (part A). Under a `### Section`, it loops
   that section (part B). It must be the first content after the heading —
   blank lines and HTML comments may precede it, prose or a numbered step
   may not, so the rows are always read before the steps they feed and the
   *Run this row* CodeLens has one place to look. A second table in the
   same span is an error ("one table per flow"). A table anywhere else in
   `## Steps` (after a step) is an error naming the rule. `dataFile:` stays
   as the external form for the run loop; a file with both is a parse
   error. A skill file's own `## Steps` refuses a table — a skill is called
   with args, not looped — while a skill's internal `### Section` may carry
   one under part B's rule.

2. **Column names follow the `{{…}}` rule, and then some.** `interpolate`
   matches `\{\{(\w+)\}\}`; a column must match `^[A-Za-z_]\w*$`, which is
   deliberately stricter (no leading digit). Anything else — a space, a
   hyphen, an empty header cell — is a parse error naming the cell.
   Duplicate column names are an error too.

3. **Cell values are parameter values, including `$VAR`.** Trimmed. An
   empty cell is the empty string, which is what the empty-email row above
   needs; it is not "use the `## Parameters` value". A cell beginning with
   `$` resolves against the environment by the parameter rule — new code,
   because today a row value bypasses that branch (§"Context"): on the
   CLI, `resolveValue` applies the `$` test to a data-row value before
   returning it (which fixes `dataFile:` rows at the same time), and
   `resolveCompileParameters` follows suit; in TestBench the loop passes
   each row through `resolveSection`. A `$` cell whose variable is unset
   stays literal with a warning, as a parameter does. A literal dollar
   amount therefore cannot start a cell — write `USD 100` or put the `$`
   after a space — same limit `## Parameters` has. `${env.X}` /
   `${data.X}` / `${source.X}` cells are interpolated at parse time
   alongside `## Parameters`, by the same call; a cell holding
   `${…}`-shaped text that does not resolve throws at parse, as a
   parameter does. A pipe in a cell must be written `\|`; both the token
   and the raw scan honour it. Backticks do not protect a pipe. Backslash
   paths like `\attachments\logo.png` are ordinary text. A cell holding
   `{{…}}` is a parse error: a run-row cell would insert it verbatim and a
   section cell would re-resolve it against the caller's scope at run
   time, and one rule is better than two — combine values in a body
   step instead. A header with no data rows is a parse error ("table has
   no rows"), not a loop of zero.

4. **A run row shadows `## Parameters`; a section row shadows the caller's
   scope for the iteration.** The first is what `expandTestInstances` does
   today, kept; a column with the same name as a parameter is *allowed*
   and is the intended way to give a column a default for single-row use
   (§7). The second is part B's scope rule (§"Scope" under part B).

5. **Every run row is a fresh browser, and the run loop lives in the
   caller.** Row 1 signs in; row 2 must not start on the dashboard. The CLI
   already gives each instance its own browser. TestBench keeps its
   *existing* session id (`<file>` for an interactive run,
   `<file>::run-<n>` for a batch run) and closes the session at every row
   boundary, so the next row's batch creates it afresh under the same id.
   There is no `::row-<n>` id: the first draft had one, and it would have
   broken Continue after a pause (which posts to the stable id), the
   keep-alive, every out-of-band session op, and the leftover-session
   collision `::run-<n>` was minted to avoid. The row number rides the
   request, not the id. The server stays row-agnostic for the run loop: it
   runs a batch with some `parameters`, as now. Two thin loops (CLI has
   one, TestBench gains one) are cheaper and safer than one fat server
   loop that would have to thread rows through step painting, pause,
   breakpoints and re-run. The server gains an optional `dataRow?: number`
   (1-based) and `dataRowCount?: number` on the steps request;
   §"Sessions API" says exactly what they change. Under `cdp:` a fresh
   session attaches to the user's browser, `context.close()` is a no-op
   over CDP, and `localStorage` is shared, so the cookie banner does not
   reappear and step 2 of the sign-in matrix *fails* on rows 2–5. A matrix
   under `cdp:` is allowed but the fixture is not written for it.

6. **A failing row does not stop a loop; a pause ends the run loop.** A
   matrix exists to show *which* rows fail. For the run loop, each row is
   reported on its own; the CLI's exit code and `--bail` behave as they do
   across tests (bail stops after the first failing row); TestBench's Stop
   stops the current row and paints the remaining rows' steps as skipped,
   reported as "not run (stopped)". A pause inside a multi-row run loop —
   breakpoint, Pause, `[input:]`, `[interactive]` — ends the loop after
   the current row: Continue finishes that row in its own session, and the
   rest are reported "not run (paused)". Resuming the run loop from a
   pause needs a row cursor that survives a Continue and is not worth it:
   the debugging loop is *Run this row* (§7), which pauses freely. A
   section loop, by contrast, is one run, and inherits the run's
   stop-on-failure unchanged in this story: a failing iteration marks its
   line and the call site red and ends the run there, the later
   iterations "not run". Letting the loop finish first is new
   loop-aware control flow on both runners (§"Open for review"). A
   breakpoint inside a looped body pauses in place and Continue carries
   on with the same iteration; every resume that re-posts a batch —
   Continue after a failure, Continue after Stop, the Variables-view
   re-run — re-enters at the section call and runs all iterations again,
   because a body-line anchor can only name iteration 1
   (§"Painting, pause, re-run" under part B). Rows never run in parallel
   in this story.

7. **Run one row.** CLI: `aiui run test.md --row 3` (1-based, matching the
   report suffix; out of range is an error naming the count; the pattern
   must match exactly one file). TestBench: a *Run this row* CodeLens on
   each table row — a new provider, the extension has none today — which
   for a run-level table is the ordinary interactive run with the rows
   narrowed to one, so nothing about pause, breakpoints, F11, the
   Variables view or *Re-run from step N* differs. After a *multi-row* run
   the interactive session belongs to the last row, so *Re-run from step
   N* re-runs that row alone from step N, and the Variables view shows its
   values; the output log says so. For a section-level table, *Run this
   row* is not offered in this story: a section iteration only makes sense
   after the steps that lead to the call, and the way to run one iteration
   is to delete or move the other rows for the moment. (An HTML comment
   inside a table ends it under `marked`; rows below the comment become
   prose and the parser reports them, so "comment out a row" does not
   work.)

8. **Row runs never use the step cache.** The cache is being removed and
   this story adds nothing to it. While it still exists, a run that has
   rows anywhere — under `## Steps` or under a section — forces it off the
   way a TestBench re-run already does (`cacheEnabled` omitted from the
   batch; the CLI passes `cacheEnabled: false` for the instance). Replay
   economy for rows comes from code-behind, which is the surviving
   mechanism.

9. **Rows are read once, when Run is pressed.** TestBench re-reads the
   live buffer per step block for `fullSteps` and `sections`; rows — both
   kinds — are snapshotted at the start so a mid-run table edit cannot
   change the count, reorder rows, or make the `-rowN` suffix or the
   iteration numbers lie.

10. **Secrets by column name.** Run-row columns become parameters, so
    `isSecretName` already governs them: a `password` column is masked in
    the run log, the row banner (through `maskIfSecret`), the report's
    parameters block and the compile recording. Section-row columns do
    *not* get this for free: they become frame `inputs`, and both runners
    compute the secret list from the parameter map only, so today a
    literal `[skill: login password="x"]` prints in clear everywhere and a
    `password` column in a looped section would too. Part B feeds every
    frame's secret-named `inputs` into `runSecrets` and the recording's
    secret list on both runners, and masks secret-named keys in the
    `frame:scope` payload — which closes the skill-arg hole at the same
    time. The regex also matches `key`, so an
    `apiKey` column is masked and so is a `monkey` column. Masking is by
    *value*, split-and-join across everything written, so a validation
    matrix whose password cells are `a` or `1` will over-mask every `a`
    in the report. Existing behaviour for `## Parameters`; the matrix
    makes it routine, so the fixture uses cells of realistic length and
    §"Open for review" asks whether a minimum length belongs in
    `secrets.ts`. The fixture table holds `password123` in plain text
    because the fixture app's credentials are public.

11. **Compile records row 1 and iteration 1, and only the first run row
    writes the recording.** The author puts a fully populated row first;
    an empty referenced value in the recorded row declines the step with a
    reason that says so (§"Code-behind"). On the TestBench path only the
    first selected run row's batch carries `compile`; the remaining rows
    run plain, so a matrix Run & Compile produces one recording and one
    generation rather than five that overwrite each other. A section loop
    is inside one run and records every iteration; the generator binds
    them all to the same entries and generates from the first, which is
    what it does for a section called twice today.

## Part A — rows under `## Steps`

### Parser (`src/parser`)

- Inside the `## Steps` walk, a `table` token that precedes the first
  `list` token (and any `###` heading) is the run's rows; a `table` after
  a list, or a second table, is an error naming decision 1. `space` and
  `html` tokens are ignored, because `appendRunHistory` writes an
  `<!-- latest-runs:start -->` marker and a `## Latest runs` heading at
  the end of the file and the marker lexes as an `html` token inside
  whichever section is last. `ParsedTest` gains
  `dataRows?: Array<Record<string, string>>` — absent when there is no
  table, never an empty array, so every existing consumer's `if` reads
  the same.
- Validation per decisions 2/3 runs on a raw scan of the lines between
  the `## Steps` heading and its first numbered item (the source of truth,
  with line numbers), and the `table` token is cross-checked against it —
  the same discipline as the step/line zip `parseSections` already does
  for `## Steps`. A ragged row (fewer or more cells than the header) is an
  error with its line; `marked` pads and truncates silently, so the token
  alone cannot see it. The raw scan honours `\|`. A table indented four
  spaces is a code block to `marked` and "no table" to the scan; the
  error says so.
- `parseTestFile` interpolates env-data placeholders in cells where it does
  for parameters today (the `interpolateEnvData` call on
  `parsed.parameters`), so `dataRows` and `parameters` see the same
  context. `parseSkillFile` refuses a table under the skill's `## Steps`.
- `dataFile:` plus a table throws from the parser. `aiui list` does not
  parse the body, so it gains a scan for a pipe-led line between
  `## Steps` and its first numbered item, to print the `data-driven` tag
  for inline tables; it does not report the conflict.

### Runner (`src/runner/test-runner.ts`)

- `expandTestInstances` reads `test.dataRows` before `frontmatter.dataFile`;
  `resolveValue` applies the `$` rule to a data-row value (decision 3).
  `--row n` filters the instances after expansion; the instance keeps its
  original `dataRowIndex` so the report still says row 3. An instance with
  a `dataRowIndex` runs with `cacheEnabled: false` and writes the recording
  and the last-run sidecar only when the index is 0 (decision 11) — today
  `writeRecording` wipes and rewrites the directory every run, so five rows
  would leave row 5's on disk for a later `POST /codebehind/compile` to
  compile from.
- `runTests` needs no new shape: it already lists each instance in the
  summary. `runTests` boots real browsers, so its loop gets an injectable
  `runTest` seam (the compile pipeline's `createTestFileRunner` is the
  precedent) or the loop tests below cannot exist.
- `runTest` opens the run-log file with `Title (row N)` so the log files
  are told apart like the reports.

### Sessions API (`src/server`)

- `StepsRequest` gains `dataRow?` and `dataRowCount?`. Validation: positive
  integers, `dataRow <= dataRowCount`, `dataRow` without `dataRowCount` is
  400. Exactly three things read them: the report builder sets
  `report.dataRow` (the file gets `-rowN`, the "Data row" meta line
  renders — both existing); the run-log header line gains
  `dataRow=N/M`; and one `output` info event `Row N of M` is emitted at
  batch start so TestBench's log and the Test Explorer's output both carry
  it. The server names reports from the file basename and never reads the
  H1, so the report *title* is not the CLI's and the story does not promise
  it. Tested at the client seam, through the real api-server entry, because
  that is where `envName` was once dropped while the resolver's own unit
  tests stayed green.

### MCP (`src/mcp/assemble.ts`)

`run_test_file` on a file with run rows runs row 1 and says so in its
response, the way the compile path says "compiling with row 1 of N". The
full loop over MCP is a follow-on; a silent single run with `{{email}}`
reaching the model as text is the thing this story must not leave behind.
Section rows need nothing here: they expand on the server, and MCP already
sends `sections`.

### runner-core

- `parseDataRows(text)` mirrors the parser's raw scan for the editor —
  header rule, trimming, `\|`, ragged-row detection, the "first content
  after the heading" position rule — and returns rows plus each row's line
  number, which the CodeLens and the diagnostics need and the server does
  not. It serves both headings: given the `## Steps` span it returns the
  run rows, given a `### Section` span its rows. Kept in step with
  `src/parser` by a shared fixture corpus run through both
  (`runner-core/tests/regression-corpus.test.js` and
  `tests/invocation-mirror-parity.test.ts` are the precedents). That is
  three implementations of the table scan — server parse, server raw
  validation, editor — because the server cannot import runner-core.
- `frontmatter.ts` learns `dataFile` (it parses `dataSources` only today)
  so the "both present" diagnostic can fire client-side; that is a new TB
  code in `preflightSections`, which means a runner-core `node --test` run
  and the `SAMPLE_CONTEXTS` audit.
- `step-lines.ts` is unaffected: a table never contains numbered items,
  so its rows are prose. A test asserts that a table row is classified as
  prose — the existing test file contains no pipe at all.
- `section-index.ts` must not mistake the run table's lines for section
  body content (they precede any `###`, so today they are simply prose;
  the test pins it).

### TestBench (`testbench-native`)

- `run-controller` parses run rows next to `parseParameters` and
  snapshots them (decision 9). With rows, `run` becomes a loop around the
  existing per-block loop. The row boundary, in order: `closeSession()`
  on the current id (unless a pause parked the run — then the loop ends,
  decision 6); `forgetSentConfig()`, because `includeConfig` is
  `!configSentForSession` and today that is reset only in the run's
  `finally`, so without it row 2's session would launch with no `baseUrl`,
  `viewport` or `timeout` and step 1 would fail; rebuild `params` from
  `{...resolvedParameters, ...row}` rather than carrying the previous
  row's map, since `[input:]` answers mutate it; `clearStatusesForUris`
  so the gutter repaints for the row; `ac.signal.aborted` check (Stop
  between rows); post `parametersResolved` with the row's values (the
  Variables view follows the row); then `streamSteps` with
  `dataRow`/`dataRowCount`, `compile` only on the first selected row
  (decision 11), and no `cacheEnabled`. `currentSessionId`/`activeSessionId`
  do not change between rows, which is why the step-control POSTs and the
  awaiting-debugger acks keep working. After the last row of an
  interactive run the session stays open, as today.
- Painting: during a row, decorations behave as for a normal run. The
  controller keeps `Map<line, { worst, failingRows }>` across rows; at loop
  end it posts a new controller→extension message (`rowSummary`) that
  calls `tracker.setStatus(uri, line, worst, detail)` directly, with
  `detail` = "failed on rows 2, 4", which is what the hover shows. Not a
  run event: run events also reach the Test Explorer listener, which would
  count synthetic failures twice. One `done` is emitted, after the loop;
  the extension and the Test Explorer treat `done` as run end. Test
  Explorer failure messages are prefixed `(row N)`, since today they are
  keyed by line and five rows failing step 6 would read as five identical
  messages.
- The output log gets one banner line per row (§"In plain terms" format,
  secrets through `maskIfSecret`) and a one-line-per-row summary at the
  end, with each row's report path and "not run (stopped/paused)" for rows
  that did not run.
- Editor: completion for `{{` already lists parameters
  (`env-data-completion.ts`, PR #95/#96) and now lists columns too, marked
  `Data column` — run columns everywhere in the file, section columns
  inside that section's body. F12 on `{{email}}` goes to the header cell,
  beside the existing jump to a `## Parameters` bullet. The "unknown
  placeholder" diagnostic is *not* in this story: `{{x}}` also names
  `[as: x]`, `[store as: x]`, `[input: x]`, `[output: x]`, skill
  `out.<name>` aliases and tool outputs, no such diagnostic exists today,
  and one built over "parameters ∪ columns" would squiggle
  `{{transactions}}` in `securebank.md`. It is a story of its own, reusing
  the completion walker's execution-order scan.
- *Run this row* CodeLens on each run-table row (new provider plus a
  `package.json` contribution). The Test Explorer keeps one item per file;
  per-row children are a follow-on.

### Step cache

Forced off for row runs (decision 8). TestBench's loop omits
`cacheEnabled` from every row batch, and from any batch whose `sections`
carry rows; `runTest` on the CLI passes `cacheEnabled: false` when the
instance has a `dataRowIndex` or the parsed test has a looped section.
Nothing else; the retirement story removes the rest.

### Code-behind

`## Parameters` values reach generated code as `step.getVar('name')`
because the generator is handed `stepParameters` — the name/value pairs
the step's source references — and a leak guard refuses code that embeds a
value. Rows go through the same door, so a step that *types* a row value
compiles to code that reads the current row at replay. That covers steps
3 and 4 of the matrix, and every "enter", "select", "upload" shape.

Step 6 is different in kind. `{{outcome}}` changes what the step asserts.
An entry generated from row 1's recording would check for the dashboard on
every row; on row 2 it would fail, heal under AI (the existing broken-entry
path), and be marked stale — and on the next run the healed entry would
fail on row 1. Today the leak guard catches this by accident and reports
it as a compile *error*, because the generated code contains the outcome
text. The rule that turns the error into a decline, and prevents the
ping-pong: **when a parameter is referenced in the step's instruction but
its value appears in none of the recorded actions' input-carrying fields,
the step is declined as `ai: true` with the reason "`{{outcome}}` decides
what the step checks, not what it types".** The input-carrying fields are
`value` (type, fill, select, keyboard), `filePath`/`filePaths` (upload)
and `url` (navigate). `selector`, `condition`, `expected`, `description`
and `reasoning` never vouch: an `outcome` cell of `Dashboard` matching
`expected: "Dashboard"` would otherwise compile the hard-coded assertion
and bring the ping-pong back. The cost is that *"Click the {{plan}} tab"*
— a click whose selector text is the row value — is declined although
`getByText(step.getVar('plan'))` would be right; §"Open for review". The
comparison sits beside `unresolvedInputRefs` and reaches the entry through
`aiEntryFor(source, reason)`, which already writes the reason as a
comment. A parameter whose recorded value is empty cannot vouch (an empty
string matches everywhere), so the step is declined with *"row 1 leaves
`{{email}}` empty; compile records row 1 — put a populated row first"*
rather than compiled as AI silently. The minimum test is an assert action
whose `condition` echoes the parameter value verbatim: it must decline.

`firstDataRow` reads `test.dataRows` before `frontmatter.dataFile` and
needs no `projectRoot` for inline rows, so compile-runner's guard becomes
`test.dataRows || bundle.projectRoot` and its info line gets an inline
variant. `resolveCompileParameters` consumes the row and applies the `$`
rule (decision 3). On the TestBench path the `LiveCompiler` is per session
and `writeRecording` wipes the directory each compiling run, which is why
decision 11 sends `compile` on the first selected row only; *Compile This
Step* inside a row run uses that row's parameters and splices against the
recording on disk, which is row 1's.

Rows 2–N replay: a `getVar` entry reads the row; an `ai: true` entry
spends its turn; a broken entry heals as today and marks the step stale.
The last-run sidecar is last-writer-wins today; with rows it is written
by row 1 only (decision 11), so `--only-stale` and the ⚠ hover describe
row 1's replay. A worst-of-rows merge is a follow-on.

### Reports

No template change: `dataRow` already renders. The `-rowN` suffix means
five reports per run; the run summary and the TestBench output log link
them. `appendRunHistory` writes one line per instance, so a matrix run
appends five against the ten-entry cap — accepted, and the parser ignores
the marker it writes (§"Parser"). Report timestamps are second-granular,
so only *Run this row* twice within one second overwrites a report. A
per-run index page that lists rows in one table is a follow-on.

### Hooks

`before`/`after` hooks run per row on the CLI, because each row is a full
`runTest`; the Sessions API has no hook handling at all, so from TestBench
they run zero times. That is today's split, unchanged, but a `before` hook
that seeds state (the fixture's `/api/documents`, say) now runs five times
on one path and never on the other — worth knowing when writing one.

### The fixture test

`templates/init/tests/securebank-matrix.md` is the sign-in file in
§"In plain terms", with these corrections to the obvious first draft:

- The fixture form is `novalidate` with `required` inputs, so an empty
  field does not block submit — the request goes to `/api/login`, is
  rejected with 401, and the banner shows. The empty-email and
  empty-password rows therefore expect the banner, not a disabled button.
- The populated success row is first, so the compile records it
  (decision 11).
- The cookie banner shows once per browser context (`localStorage`), so
  step 2 runs on every row only because every row is a fresh browser
  (decision 5). Under `cdp:` it would show once and step 2 would fail.
- After a failed attempt the page clears the password field. A second
  verification, *"Verify the password field is empty"*, would be true for
  rows 2–5 and false for row 1 (the field is gone with the page). Left out
  of the fixture on purpose: one row-dependent verify is the example, two
  is noise.

## Part B — rows under a `### Section`

Reviewed 2026-09-03 by the same three passes as part A, after the
examples were added; the record is in §"What the review changed". Two
of its headline claims did not survive — that section rows get secret
masking and code-behind variables "for free" — and the failure model was
simplified. What is left is smaller and honest: the runtime half reuses
the frame machinery almost unchanged, the code-behind half is a scope
change of its own and ships as a second PR.

### What it is

A section call whose definition carries a table runs the body once per
row, in the same session, in order, each iteration a section frame with
the row bound as its `inputs`. It is the skill-call pattern applied to a
macro: the expander already turns `[skill: name arg="v"]` into a frame
whose `inputs` are the args and whose body text has the args interpolated;
a looped section is that, N times, with the row as the args, minus the
skill's separate file and declared parameters.

### Scope

A section shares the caller's scope; that does not change. For the
duration of an iteration the row's columns are bound over that scope, so
`{{file}}` in the body reads the row and a caller variable of the same
name is shadowed for those steps only. The binding is textual and
happens at expansion: the body's step text is interpolated with the row,
so nothing about the row ever reaches `session.outputs`, the post-step
sweep or the seed scope, and nothing leaks past the call. Two
consequences worth knowing. A column named like a capture the body makes
(`[as: x]` with a column `x`) makes the capture unreadable *inside* the
body, because its `{{x}}` reads were already replaced; the parser warns.
And a nested looped body is interpolated with every enclosing row,
innermost winning, so `{{account}}` inside *Per month* reads the outer
row — the frame's own `inputs` stay its own row for the Variables view,
and code-behind's scope walk composes the same way (§"Code-behind").

A capture inside the body (`[as: x]`, `[store as: x]`) writes to the
shared scope as it does in any section, so each iteration overwrites the
previous one and the caller sees the last iteration's value after the
loop. Collecting across iterations ("gather every count into a list") is
a follow-on. Row columns are visible inside skills the body calls only
when passed as args, as any caller variable is; the row is interpolated
before the call line is parsed, so `[skill: x email="{{email}}"]` works.

### Expander (`src/skills/expander.ts`)

- `SectionDefs` entries and `ParsedSection` gain
  `rows?: Array<Record<string, string>>` (absent, never empty). When a
  call resolves to a section with rows, the expander inlines the body once
  per row, pushing a `section` frame per iteration with `inputs` = the
  row, `iteration: n` and `iterationCount`. Before interpolating, it
  snapshots the authored body (`section.rawSteps ?? section.steps`) as the
  body context's `rawSteps`: the wire carries no `rawSteps` (contract
  §3.2), so without the snapshot the server path's match side and the
  code-behind binding `source` would become the *interpolated* text while
  the CLI's stay authored, and entries would bind on one path and not the
  other. Body text is then interpolated with the merged enclosing rows
  (inner wins) using a silent variant of `interpolate` — the standard one
  logs `Unresolved placeholder` for every `{{outer}}` it leaves for
  runtime, once per iteration. `{{outer}}` references that are not columns
  are left for runtime, as now.
- The frame's `inputs` snapshot already reaches the `frame:scope` payload
  on `frame:push` (the server merges `frameInputs[id]` for any frame that
  has them), so the Variables view shows the iteration's row at a pause.
  `iteration`/`iterationCount` are *not* free: the server's
  ExpandedFrame→FrameInfo conversion copies fields by name, so both are
  added there and to `FrameInfo` in its two hand-mirrored copies
  (runner-core `protocol.ts`, `session-manager.ts`).
- Nested loops multiply by construction: a looped section calling a looped
  section expands to the product, each inner iteration a frame under its
  outer one. Section recursion is already refused, so there is no infinite
  case. A `[skill:]` call inside the body is expanded per iteration as it
  would be per call today.
- `$VAR` cells do not resolve where skill args resolve — skill args never
  resolve `$VAR`. The CLI parser applies `resolveValue`'s `$` branch per
  cell; TestBench resolves cells with `resolveValueFromEnv` before shipping
  `rows`, as it does for `## Parameters`. `${env.X}` cells are interpolated
  at parse time with the rest of the file.

### Parser and scanners

- The server's token walk ignores `###` entirely (only depth 1 and 2 set
  `currentSection`), so attributing a `table` token to a section is new
  walk state; the depth-≥4 ignored regions drop tables as well. A table
  that directly follows a numbered item — no blank line — never becomes a
  `table` token: `marked` folds it into the list item. The raw scan is
  therefore the refusing side for "table after a step", run per section
  span as well as for the `## Steps` head, so the CLI refuses what
  TestBench's wrap pre-flight already refuses and the two paths do not
  diverge.
- The editor side needs nothing to *find* the body: `classifyLines` makes
  pipe lines prose, `extractSections` (runner-core `step-lines.ts`, the
  body reader behind `buildSectionsPayload`) collects only section-step
  lines, and `section-index` counts steps from it. What changes is that
  `extractSections` reads the table too, so the payload can carry it, and
  `parseDataRows` runs on the section span for the diagnostics. A table
  immediately followed by `1.` lexes as table then list; no blank line is
  needed.
- Decision 9's Run-time row snapshot must be spliced into the per-block
  rebuilt `sections` payload, otherwise a buffer edit changes a section's
  rows between blocks.

### Wire and clients

- `rows` is added to the `sections` wire shape in both hand-written
  copies (`StreamStepsRequest.sections` in runner-core `api-client.ts`,
  `StepRequest.sections` in `session-manager.ts`), to `McpStepRequest`,
  and to the two per-field copies that would otherwise drop it silently:
  api-server's section-entry rebuild and the MCP `sectionsPayload` — the
  seam the contract names as the one that once dropped `envName`.
  `validateSectionEntry` gains rules for `rows` (array, at least one row,
  every row an object with identical identifier keys and string values;
  else 400).
- The contract (stories/test-script-sections-contract.md) is frozen and
  says "edit this file first": part B changes §3.2 (wire), §3.3
  (`FrameInfo` gains `iteration?`/`iterationCount?`), §3.4 (`SectionDefs`
  gains `rows?`), adds a §5 note that table lines inside a section are
  prose, and adds a `fixtures/sections/` corpus entry with at least two
  named consumers per §6.
- The MCP path sends `sections` already; with `sectionsPayload` copying
  `rows` it needs nothing else.

### Painting, pause, re-run

- Each iteration's body steps are real expanded steps on the body's lines,
  so the gutter repaints the body per iteration exactly as it does for a
  section called twice today, and a server breakpoint on a body line
  pauses on every iteration (breakpoints are keyed by expanded index).
  That pause parks in-batch, so Continue carries on with the same
  iteration.
- The call-site line has a bug to fix before rows make it routine: on
  `frame:pop` the extension paints the call site `pass` whenever *that*
  frame had no failure, so a section called twice whose first call failed
  is repainted green by the second. With iterations that becomes "every
  failure is hidden by the next clean iteration" if the loop ever
  continues past one. Fix: `handleFramePop` never downgrades — the
  controller keeps the worst status per `(uri, line)` root, and a pop marks
  `pass` only when no frame with that root has failed. Inner call sites of
  nested loops get no running/pass paint today (the `parentId === null`
  gate), and this story does not add it. The `rowSummary` message from
  part A carries the body lines' worst status and the hover detail
  ("failed on iteration 2"), keyed by line, so the two loops share one
  repaint.
- Every resume that re-posts a batch anchors by `(uri, line)`, and the
  server takes the *first* expanded step at that line — iteration 1,
  whatever iteration was current. Three client paths post such an anchor:
  Continue after a body failure, Continue after Stop (both via the
  section-body resume context), and the Variables-view re-run. Left alone,
  "iteration 2 fails → Continue" would re-run iteration 1's tail, reach
  iteration 2, fail again. So: with `iteration` on `frame:push`,
  `recordSkillFailure` and the section resume context park on the *call*
  line when the frame has one, and every resume re-enters at the call and
  runs all iterations; the output log says so. The Pause button, which
  ends the batch and parks the same way, resumes the same way. The server
  refuses any `startAt` whose step's frame chain contains a looped section
  and no iteration — the way an unanchored `startAt` is refused today —
  and TestBench mirrors it in the pre-flight as a new TB code (next free
  is TB032; runner-core `node --test` and the `SAMPLE_CONTEXTS` audit
  follow). An iteration-aware anchor is a follow-on.
- *Run selected body lines* runs a body detached at the root frame, with
  no invocation and no row, so `{{file}}` would reach the model as text —
  the silent-placeholder hole part A closes for MCP, reopened. A detached
  run of a looped body's lines is refused with the same TB code. This
  withdraws, for looped bodies only, the detached body-run and
  section-body resume the sections feature specified. The way to iterate
  on a body line is to run the test (or the call) with the rows trimmed
  to one for the moment; *Run this row* for section rows (decision 7) and
  an iteration-aware anchor are the follow-ons that give it back.

### Failure

A failed iteration ends the run there, as any failed step does today on
both runners (the server breaks its step loop; the CLI sets `bail`). Its
line and the call site are red, later iterations and the steps after the
call are "not run". Letting the loop finish first — origins carrying the
loop's call index and count, a skip-forward to the next iteration on
failure, per-iteration failure recording, the CLI's interactive-on-failure
REPL per iteration, `afterEach` skipped on the failing step but
`beforeEach` run for the next — is new loop-aware control flow on both
runners and is deferred with "continue past the call" (§"Open for
review"). The upload fixture avoids a failing row, so nothing runnable is
lost. `[input:]` and `[interactive]` inside a looped body are skipped, as
inside any frame body today.

### Secrets

Both runners compute the secret list from the parameter map only, so a
section row bound as frame `inputs` and interpolated into the step text
is masked nowhere: the report's step instruction, the console step line,
the run log, the recording and the `frame:scope` payload would all carry
a `password` cell in clear. A literal `[skill: login password="x"]` has
the same hole today. Part B: every frame's secret-named `inputs` values
(all iterations) join `runSecrets` and the recording's secret list on
both runners, and the `frame:scope` payload masks secret-named keys
through `redactMap`. The report's parameters block gains nothing —
inputs are not parameters — so the masking is by value only, and decision
10's over-masking caveat applies to short cells.

### Hooks

On the CLI, `beforeEach`/`afterEach` wrap every body step of every
iteration, and `[no-hooks]` on the call line covers all iterations — both
by construction through `skipHooks` and the origins. The Sessions API
runs no hooks.

### Code-behind (second PR)

Today `varScopeFor` walks up to the nearest *skill* frame and returns an
empty scope for a plain section; `getVar` reads only that scope's
`inputs`, and `stepParameters` resolves a `{{file}}` reference through
the same scope. For a looped body that means the generator would see no
name→value pair for `{{file}}`, write `step.filePath('attachments/logo.png')`
with the leak guard blind, and replay would read `getVar('file')` as
`undefined`. So section rows need a scope change, not a flag:
`varScopeFor` composes along the frame chain — `renames` from the nearest
skill ancestor, `inputs` merged innermost-wins from every enclosing frame
that has them (looped section over skill over outer looped section) —
and the "steps in a plain section have an empty scope" comment in
`execute.ts` is rewritten. With that in place the rest is part A's:
`stepParameters` sees `file → attachments/logo.png`, the decline rule and
its vouching fields apply with iteration 1's values, an empty referenced
value in row 1 declines with the "populated row first" reason, and
`getVar` reads the current iteration's row at replay.

Generation is once per section body, frame-aware, as for a section
called twice today: the compile records every iteration, `selectSteps`
generates from the first expanded step with a given entry key, and
occurrence counting restarts per frame instance. Two mismatches to state:
the last-run sidecar counts occurrences run-globally while the live
compiler picks by binding occurrence, so after a heal on iteration 3 the
⚠ hover describes iteration 1; and the replay rounds run every iteration
against code generated from iteration 1, so a value that vouches on row
1 and is empty on row 2 replays as `fill('')` and passes silently. Both
are noted, neither is fixed here.

### Report

The report is a flat list with a section badge; a section-call line
expands away and has no result of its own. Body-step results gain
`iteration` and `iterationCount` beside `sourceSection`, derived from the
frame on both runners, and the badge renders
`section: Upload each statement (2/3)`. Results stay flat and the counts
are unchanged. Grouping under a synthetic call-site result is a
follow-on; it would touch every consumer of `results.length`. The
Variables view and the Call Stack view both label frames, so both get
the `(n/N)` suffix.

### Fixture

`templates/init/tests/securebank-upload-rows.md` is the upload file in
§"In plain terms". It depends on the upload action (stories/upload-action.md,
PR #121), and on the Documents page's `Clear all` so the count of three is
exact. All three files exist under `templates/init/tests/attachments/`
and are allowed types; the page's status line carries a size suffix, so
the assertion is "starts with". `malware.exe` is not used because a
rejected row ends the run under stop-on-failure. Two runs at once share
the fixture's document list (CLAUDE.md), so the live test clears it
first.

## Tests

**Parser** (`tests/parser.test.ts`): table under `## Steps` parsed to rows;
header identifier rule; duplicate column; ragged row with its line; `\|` in
a cell; a backticked pipe reported as ragged; empty cell; a `{{…}}` cell
refused; a header-only table refused; second table; table after the first
step refused (folded-list case, via the raw scan); prose between heading
and table refused; `html`/`space` tokens ignored (a file with `## Steps`
last plus an appended run-history block parses); indented table reported
as "no table"; `dataFile` plus a table; a table under a skill's `## Steps`
refused; `$VAR` and `${data.x}` cells; `dataRows` absent (not `[]`)
without a table. Part B: a table under `### Section` lands on that
section's `rows`, not on `dataRows`; a section's numbered steps are found
after its table; a table after a section's first body step refused; a
table in a depth-≥4 ignored region dropped; a table under a skill's
internal section accepted; a column named like a body capture warns.

**Runner** (new `tests/data-rows-runner.test.ts`, through the injectable
`runTest` seam): inline rows produce N instances with `dataRowIndex`
0..N-1; a column shadows a parameter; a parameter with no column survives
every row; a `$VAR` cell resolves and an unset one stays literal with a
warning — for inline rows *and* `dataFile:` rows, since the fix is shared;
`--row` narrows and keeps the index, rejects out-of-range, rejects a
multi-file pattern; a failing row does not stop the loop; `--bail` stops
after it; a row instance runs with the cache off; only row 1 writes the
recording and the sidecar; the run-log file name carries the row. Nothing
tests `expandTestInstances`, `loadDataFile` or `parseCsv` today; these are
the first.

**Expander** (part B, `tests/skill-expander-sections.test.ts`, through
`parseTestFile` per the contract's §2.3 discipline): a section with three
rows expands to three frames with `inputs`, `iteration` 1..3 and
`iterationCount`; body text interpolated per row; the body context's
`rawSteps` stays authored; `{{outer}}` left for runtime with no warning;
an inner looped body sees the outer row's columns, inner wins; nested
looped sections multiply; a capture in the body is last-iteration-wins in
the caller's scope; a skill call inside the body expands per iteration
with the cell substituted into its args; section recursion is still
refused.

**Sessions API** (`tests/api-server-viewport.test.ts` pattern, real
Express entry): `dataRow` on the request appears on the report and in the
file name; the run-log header carries `dataRow=N/M`; the `Row N of M`
output event; invalid values and `dataRow` without `dataRowCount` are 400
with the field named. Part B (`tests/api-server-sections.test.ts`,
`postSteps` through the real entry): `rows` survive the HTTP layer and a
malformed `rows` is 400; `frame:push` carries `iteration`; a looped body
step's binding source is the authored text; body-step results carry
`iteration`; a `startAt` into a looped body is refused with the new code;
a `password` column is masked in the step instruction, the run log and
the recording.

**Secrets** (`tests/secrets.test.ts`, `tests/run-log-secrets.test.ts`): a
looped section with a `password` column, masked in step line, report
instruction, run log, recording and `frame:scope`; a literal skill arg
named `password` now masked too.

**MCP**: `run_test_file` on a rows file runs row 1 and says so; `rows`
survive `sectionsPayload`.

**runner-core** (`node --test`): `parseDataRows` on the shared corpus
agrees with the server parser for both headings; `step-lines` classifies
table rows as prose; `extractSections` carries a section's rows and finds
its first numbered step past the table; `section-index` unchanged;
`frontmatter` reads `dataFile`; the two new TB codes are in
`SAMPLE_CONTEXTS`.

**TestBench integration** (FakeApiClient harness, `batch-mode.test.cjs`
and `viewport.test.cjs` patterns): a 3-row file posts three batches on one
session id with per-row `parameters` and `dataRow`/`dataRowCount`, with
`config` present on *every* row's first batch, `params` unpolluted by row
1's `[input:]` answer, and `closeSessionIds` showing a close between rows;
Run & Compile posts `compile` on the first row only; a single `done`;
Stop during row 2 skips row 3 and paints it skipped; a breakpoint in row
2 ends the loop after Continue finishes row 2; *Run this row* posts one
batch with that row's values on the interactive id; the worst-status
`rowSummary` and its hover detail; Test Explorer messages carry `(row N)`;
column completion; F12 to the header cell. Part B (`frames.test.cjs`,
`sections.test.cjs`): a looped section ships `rows` in `sections` and the
Run-time snapshot overrides a mid-run buffer edit; the batch omits
`cacheEnabled`; push f1 (fail) pop, push f2 (pass) pop on one call line
leaves the call site failed; body lines repaint per iteration; Continue
after a body failure posts `startAt` at the call line; a detached run of
looped body lines is refused with the new code; the Variables view and
Call Stack labels carry `(2/3)`.

**Report** (`tests/report-source-section.test.ts`): the badge renders
`section: Name (2/3)`; counts unchanged.

**Code-behind** (`tests/codebehind-compile-parameters.test.ts` pattern
with the mocked runner): compile the sign-in fixture — steps 3–4 produce
`getVar` entries, step 6 is declined with the stated reason (this also
asserts the leak-guard *error* became a *decline*); the assert-condition-
echo minimum case declines; an empty recorded value declines with the
"populated row first" reason; `firstDataRow` reads inline rows without a
project root; replay rows 1 and 2 (`tests/codebehind-healed-run.test.ts`
home) and assert no heal on either; a two-row TestBench run leaves row 1's
recording on disk. Part B, second PR (`tests/codebehind-vars.test.ts`,
`tests/codebehind-skill-params.test.ts` patterns): inside a looped section
frame `getVar('file')` reads that iteration's inputs; skill → looped
section composes renames and inputs; generation sees
`file → attachments/logo.png` and discards an entry that inlines the
value; the upload fixture compiles body line 1 to a `filePath(getVar('file'))`
entry and declines body line 2; three iterations bind to the same two
entries.

**Live** (`testbench-native/tests/integration/live/`): the sign-in fixture
against `fixtures/test-app`, all five rows; assert the five `-rowN.html`
files from disk (stop-report's pattern); row 1 on the dashboard; rows 2–5
showing the banner text pinned to `fixtures/test-app/index.html`. Part B
(`live/sections.test.cjs` pattern, `DELETE /api/documents` first): the
upload fixture, one report, a document count of 3. Slow, and the only
tests that prove the model reads `{{outcome}}` and `{{status}}` correctly.

## Rollout

Part A first: parser and runner (CLI-complete, useful on its own, and the
`$VAR` fix reaches `dataFile:` users immediately), then the Sessions API
field and the MCP notice, then TestBench. Part B after part A has landed,
as two PRs: the runtime half (scanners, expander loop, wire and contract,
painting fix, secrets, resume refusals, report badge), then the
code-behind scope change. Every part bundles runner-core changes
(`parseDataRows`, `frontmatter`, `extractSections`, the TB codes, the wire
shape, `FrameInfo`), so each bumps the extension's patch version and
follows the install loop in CLAUDE.md. `dataFile:` gets a README section
with part A, since it is currently mentioned only in the pipeline diagram.

## Non-goals

- Parallel rows or iterations.
- Resuming a multi-row run loop after a pause (decision 6).
- *Run this row* for section rows; an iteration-aware resume anchor;
  detached runs of a looped body.
- Letting a section loop finish after a failed iteration, or continuing
  past the call (§"Failure").
- Collecting captures across iterations.
- A table under a skill file's own `## Steps`.
- Grouping body-step results under a synthetic call-site result.
- Painting inner call sites of nested loops.
- Fixing the sidecar-versus-live-compiler occurrence mismatch, or the
  empty-value replay pass.
- Rows from `${data.*}` arrays or a named data source. The external form
  is `dataFile:`; making the JSON data tree a row source is a separate
  story with its own shape questions.
- Fixing `loadDataFile`'s CSV parser (`split(',')`, no quoting; cells are
  trimmed, so a comma breaks and a space does not) or its caller-supplied
  root (the CLI passes `cwd`, the server compile passes the project root).
- The unknown-placeholder diagnostic (its own story).
- The full run loop over MCP.
- Per-row items in the Test Explorer, a per-run report index, a
  worst-of-rows last-run sidecar, one run-history line per matrix run.
- Recording more than one run row during compile.

## Open for review

- Whether the compile decline rule is too coarse — *"Click the {{plan}}
  tab"* is declined because `selector` never vouches, though
  `getByText(step.getVar('plan'))` is the right code. Letting `selector`
  vouch for *click* actions only, never for assert, is the obvious
  loosening; it is generator work and the safe default ships first.
- Whether `secrets.ts` should refuse to mask values shorter than three
  characters, the leak guard's threshold. It changes existing
  `## Parameters` behaviour, so it is not decided here.
- Whether *Run this row* should also exist as a range (`--row 2-4`). Cheap
  to add; not asked for.
- The worst-status repaint versus "last row wins". Worst-status is chosen
  because a green gutter after a red row is a lie; the cost is that the
  gutter no longer matches any single report.
- Part B: whether a failed iteration should stop the run (first cut),
  let the loop finish and then stop, or continue into the steps after the
  call with the call-site step failed. The upload example is happy with
  the first; a "try each filter, then sign out" test wants the third.
  Both alternatives are loop-aware control flow on both runners.
- Part B: whether the table-before-steps position rule is too strict for a
  section whose heading is followed by an explanatory comment line. HTML
  comments are allowed; prose is not.
- Part B: whether refusing `{{…}}` in cells (decision 3) gives up
  something people will want in section rows, where a cell could
  otherwise name a caller variable.

## What the review changed

### Part A

Three passes, run 2026-09-03 after the step cache was taken out of scope,
against the part A design with the table under a reserved `## Data`
heading. The user then moved the table under the heading it loops; that
change was not separately reviewed.

**Claims-vs-code** confirmed most of the code claims and corrected these:
a data-row value bypasses `$VAR` resolution today (decision 3 is new work,
and fixes `dataFile:` rows); the run-log *file* is not titled with the
row, only the console line; `aiui list` prints a tag from the frontmatter
and never parses the body; the CLI summary already counts each row as a
separate test, so "the test is green only if every row is" was a new
aggregate, now dropped in favour of the existing per-instance listing;
TestBench posts one batch per step block, not one per run; the generator's
mechanism is `stepParameters` plus a leak guard, not `resolveInputValue`;
the cache key is the step index on the CLI, and rows already share a cache
directory under test; the "action cache kept for now" citation pointed at
a note that does not exist in the repo; `loadDataFile` resolves against
the caller's root and trims cells; the MCP `run_test_file` path is a third
row-less consumer; `resolveCompileParameters` is a second copy of the row
rule; nothing tests `expandTestInstances` today. (It also found that a
reserved `## Data` name had to join two `RESERVED_SECTION_NAMES` sets;
moot now that there is no reserved heading.)

**Design and test plan** found four blockers on the TestBench half. A
`::row-<n>` session id broke Continue after a pause (which posts to the
stable id), the keep-alive and the out-of-band session ops, and would have
recreated the leftover-session collision — replaced by the existing id
with a close at every row boundary (decision 5), and a pause now ends the
run loop (decision 6). Row 2 would have launched without `baseUrl` because
the write-once config flag is reset per run, not per row — the boundary
is now spelled out step by step (§"TestBench"). `dataRow` on the request
cannot give the CLI's report title because the server names from the file
basename — the story now promises the suffix, the meta line, a run-log
field and an output event. The decline criterion as first worded would
have *compiled* step 6, because the recorded assert action carries the
outcome text in `condition`/`expected` — the rule now names the
input-carrying fields and excludes assert fields. Also: `firstDataRow` is
`dataFile`-only and the recording is rewritten per run, so only row 1
writes it (decision 11); Run & Compile on a matrix would have compiled
five times; the repaint needed a real mechanism (`rowSummary` through
`tracker.setStatus`, not run events); Stop between rows needed a signal
check and skipped painting; the ragged-row check needs a raw scan in
`src/parser`, making three table scans; the unknown-placeholder
diagnostic is a story of its own; no CodeLens provider exists yet; under
`cdp:` step 2 fails rather than "differs"; the runner loop needs an
injectable `runTest` to be testable.

**Adversarial** overlapped on `$VAR` cells, the compile-on-TestBench
overwrite, the vouching fields, `aiui list`, the report-name mismatch and
the diagnostic, and added: `\|` is a legal pipe in a cell and a raw scan
that ignores it reports a false ragged row; the run-history marker lands
inside the last section and would have tripped the "one table" rule;
batch-close semantics contradicted "breakpoints work in a row run",
resolved by decision 7's single-row interactive run and "re-run re-runs
the last row"; rows must be snapshotted at Run; short secret cells
over-mask everything; `--row` on a glob; hooks are CLI-only; Test
Explorer messages lose the row; a table in a skill file parsed silently;
"data" was being used four ways. It also confirmed what holds: skill calls
with `arg="{{email}}"`, fresh sessions emptying `session.outputs` per row,
`interpolate` not re-scanning a cell that contains `{{`, no existing
pipe-led line inside any `## Steps`, and every fixture-page claim.

### Part B

Three passes, run 2026-09-03 after the examples were added.

**Claims-vs-code** confirmed the expander, wire, breakpoint and fixture
claims and corrected these: a plain section frame gets an *empty*
code-behind scope today (`varScopeFor` stops at skill frames), so "frame-
aware `getVar`" is new scope work; the report is a flat list with a badge
and has no call-site result to group under; Continue after a failure
inside a section is a re-expansion anchored on the first exact line
match, which is always iteration 1; `frame:push` gains `iteration` only
if the server's field-by-name frame conversion is updated; the MCP
`sectionsPayload` copies four named fields and would drop `rows`; the
runner-core body reader is `extractSections`, not `section-index`; a table
directly after a numbered item folds into the list item under `marked`,
so the raw scan must refuse it; "comment out a row" does not work in a
GFM table; `interpolate` warns per unresolved placeholder per iteration;
the Documents status line carries a size suffix; the payee hint flips
only on an `input` event.

**Design and test plan** added the two blockers that reshaped the part:
a `password` column in a section row is masked nowhere, because both
runners build the secret list from the parameter map (§"Secrets"); and
the call-site line is repainted green by the last clean iteration on
`frame:pop`, an existing bug for a section called twice (§"Painting, pause, re-run"). It
also settled expansion-time binding over runtime binding — runtime would
break `[skill: x email="{{email}}"]` inside a body and lose the Variables
view — provided the authored body is snapshotted as the match side, or
entries bind on one path and not the other; showed that "the loop
finishes, then the run stops" is new loop-aware control flow on both
runners and should be deferred (§"Failure"); placed the resume refusal on
the server with a TB mirror and named the three client producers; added
the nested-scope rule (inner body sees outer rows); reduced the report
change to a badge; and split part B into a runtime PR and a code-behind
PR.

**Adversarial** overlapped on failure, secrets, the iteration-1 anchor,
the code-behind scope, nested scope and the wire copies, and added: the
detached body run has no row and reopens the silent-placeholder hole;
`$VAR` cells "resolve where skill args resolve" pointed at nothing, since
skill args never resolve `$VAR`; a `{{x}}` section cell would re-resolve
against the caller's scope while a run-row cell stays literal (decision 3
now refuses both); a header-only table needs a rule (now an error); the
sidecar and the live compiler count occurrences differently; an empty
row-2 value replays as `fill('')` and passes; `[input:]`/`[interactive]`
are skipped inside a looped body; the nested example named a month filter
the portfolio page does not have. It confirmed what holds: pipe lines are
prose to every client scanner, a tight table-then-list lexes as two
tokens, breakpoints fire per iteration, and nothing about a row reaches
`session.outputs` or the seed scope.

## Decisions after review (2026-09-03)

- Syntax: no `## Data`. The table sits directly under `## Steps` or a
  `### Section`, before the first numbered step, and loops that flow.
  A `{{…}}` cell and a header-only table are parse errors.
- Session id: keep the existing id per mode, close between run rows; no
  `::row-<n>`.
- Pause in a multi-row run loop ends the loop after the row; no row
  cursor. In a section loop a breakpoint continues in place; every
  re-posted resume re-enters at the call and runs all iterations; a
  `startAt` into a looped body, and a detached run of one, are refused.
- A failed section iteration ends the run, as any failed step does; the
  loop-finishing variants are deferred.
- `$VAR` cells resolve by the parameter rule at `resolveValue`,
  `resolveCompileParameters`, the CLI parser (section cells) and the
  TestBench loop/scanner; `dataFile:` rows benefit.
- Section rows bind at expansion time, with the authored body snapshotted
  as the match side; nested bodies see enclosing rows, inner wins.
- Every frame's secret-named `inputs` join the secret list on both
  runners and are masked in `frame:scope`.
- `handleFramePop` never downgrades a call site.
- Vouching fields for the compile decline: `value`, `filePath(s)`, `url`;
  never `selector` or any assert field. Empty recorded value declines
  with the "populated row first" reason.
- Only run row 1 writes the recording and the sidecar; TestBench sends
  `compile` on the first selected row only. A section loop records every
  iteration in its one run and generates once per body, and needs the
  scope-composition change before any of it compiles.
- Worst-status repaint via a `rowSummary` message and `tracker.setStatus`,
  shared by both loops.
- The report stays flat; body steps gain `iteration` and a badge suffix.
- The CLI summary keeps counting run rows as instances; no new aggregate.
- The unknown-placeholder diagnostic and the MCP run loop are out; the MCP
  path runs row 1 and says so.
- Part B ships after part A as two PRs, runtime then code-behind.
