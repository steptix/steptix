# Data rows in TestBench — see which rows are done, run the rows you choose

Built. A follow-on to
[data-driven-rows.md](data-driven-rows.md), whose part A put the run-level
row loop in TestBench (a table under `## Steps` runs the steps once per
row, one report at the end) and whose part B put the section-level loop on
the server (a table under a `### Section` runs that body once per row,
inside one run). This story is about what those loops still leave you
guessing at in the editor — *which rows have finished, and how did each
go* — and the gesture they lack: *run just this row*, or these rows, of
either table.

The rule that holds the whole thing together: **the table is the control
surface.** Rows show their own status in the table, in the same status cell
the steps use; you pick rows by selecting them in the table, or by pointing
at one, the way you already pick steps. Nothing new to learn, no new
notation in the file.

## In plain terms

Today, while a five-row test runs, the six step lines paint green, clear,
paint green again, and the only place the row number appears is a `Row 3 of
5 — email=…` line in the Output log. When the loop ends the steps show the
worst status any row reached, with the failing rows named in a hover. The
table itself — the thing you wrote the rows into — never changes. A
section's table is the same: its body lines repaint per iteration and the
table sits there.

### What you will see

**You write:** `securebank-matrix.md` (five rows, six steps) and press Run.
**You get:** the table rows themselves carry status marks, in the same cell
the steps use. Row 1 spins while it runs, then goes ✓; row 2 spins, then ✓;
row 3 spins — the row that is running is also highlighted across the whole
line, so your eye lands on it — while the six steps below repaint for that
row as they do today. The table's header line reads `5 rows · row 3 of 5
running · 2 passed` at its end, the way `## Steps` reads `4/6 passed`.
Rows 4 and 5 show the empty placeholder cell: not started yet.

```
## Steps                                                          4/6 passed
   | email                 | password    | outcome                    |   5 rows · row 3 of 5 running · 2 passed
   |-----------------------|-------------|----------------------------|
 ✓ | demo@securebank.com   | password123 | the Dashboard page is shown|
 ✓ | demo@securebank.com   | wrongpass   | the "Invalid email…" banner|
 ◌ | nobody@securebank.com | password123 | the "Invalid email…" banner|   ◀ whole line highlighted
   | demo@securebank.com   |             | the "Invalid email…" banner|
   |                       | password123 | the "Invalid email…" banner|

 ✓ 1. Navigate to the baseUrl
 ✓ 2. Reject non-essential cookies in the cookie banner
 ✓ 3. Enter the email {{email}}
 ✓ 4. Enter the password {{password}}
 ◌ 5. Click the Sign In button
   6. Verify {{outcome}}
```

**You write:** nothing more; the loop finishes and row 3 failed at step 6.
**You get:** the table reads ✓ ✓ ✗ ✓ ✓ down its rows and `5 rows · 4
passed · 1 failed` on the header. Hover the ✗ on row 3 and it says *Row 3
failed at step 6 — "Verify the "Invalid email or password" banner is
shown"*, then the row's values, then the error. Step 6 keeps the
worst-of-rows ✗ it gets today, and its hover still says *Failed on row 3*.
The two hovers point at each other: the row says which step, the step says
which rows. The Output log ends with one line per row and a rows line that
matches the CLI's:

```
  Row 1: passed (8.2s)
  Row 2: passed (6.9s)
  Row 3: failed at step 6 (7.4s)
  Row 4: passed (6.8s)
  Row 5: passed (6.7s)
Rows: 5 — 4 passed, 1 failed
Report: reports/2026-09-08-…-securebank-matrix.html
```

Every planned row gets a line, and the parts of the `Rows:` line sum to the
count. That is what a Stop looks like — the row it interrupted is in neither
"ran to the end" nor "never started", and giving it no line while the summary
counted it made the arithmetic wrong by one:

```
  Row 1: passed (8.2s)
  Row 2: passed (6.9s)
  Row 3: stopped (2.1s)
  Row 4: not run (stopped)
  Row 5: not run (stopped)
Rows: 5 — 2 passed, 0 failed, 1 stopped, 2 not run
```

**You write:** the same test, Runner panel open.
**You get:** a **Rows** section above Variables, shown only when the file
has a table. It is the report's matrix table, live: one line per row, the
same status glyphs the Steps list uses, the row's values with secrets
masked (the same text as the Output banner), and the duration once the row
is done. The running row is marked the way a running step is. Click a row
to reveal it in the table.

```
▾ Rows (5)                                ▷ Run all rows   ↻ Re-run failed
  ✓  1   email=demo@securebank.com, password=***, outcome=the Dashboard page is shown          8.2s
  ✓  2   email=demo@securebank.com, password=***, outcome=the "Invalid email or password"…    6.9s
  ✗  3   email=nobody@securebank.com, password=***, outcome=…    failed at step 6            7.4s
  ✓  4   email=demo@securebank.com, password=, outcome=…                                        6.8s
  ✓  5   email=, password=***, outcome=…                                                        6.7s
▸ Variables · row 5 of 5
▾ Steps (6)
▾ Output
```

**You write:** Stop, during row 3.
**You get:** row 3 shows ■ (stopped) with the hover *Row 3 stopped — the run
was stopped while this row was running*, rows 4 and 5 show the skip mark with
the hover *not run (stopped)*, rows 1 and 2 keep their ✓. The header reads
`5 rows · 2 passed · 1 stopped · 2 not run`.

**You write:** a breakpoint on step 4, then Run.
**You get:** the run parks in row 1 and the loop ends there — a pause ends the
loop after the current row, as it does today. Row 1 keeps the running band,
because that is where the run *is*: half its steps have run and Continue will
run the rest. Rows 2 to 5 show the skip mark with *not run (paused) —
right-click the line number and pick Run This Row to run it on its own*, and
the log reads `Rows: 5 — 0 passed, 0 failed, 1 paused, 4 not run`. Continue,
and row 1 goes ✓ or ✗ like any other row; Stop instead, and it goes ■. What it
never does is go ✓ while the arrow sits on step 4 — the loop used to run the
trimmed steps 1–3 five times over and paint the whole matrix green.

**You write:** Escape on an `[input:]` prompt.
**You get:** the same shape as Stop. That row shows ■ with the hover *Row 2
stopped — the prompt was cancelled*, the rows after it are *not run (stopped)*,
and you are not asked again — cancelling used to end only that row's steps, so
the row went ✓ and the next row prompted you all over again.

### Section tables

**You write:** the rows story's upload test — steps 1–3 sign in and clear
the list, step 4 calls *Upload each statement*, whose table has three
files, steps 5–6 count the rows — and press Run.
**You get:** steps 1–3 paint once. Then the section's three table rows go
◌ ✓, ◌ ✓, ◌ ✓ one after another as the iterations run, the running row
highlighted, the two body lines repainting under each as they do today.
The section table's header reads `3 rows · iteration 2 of 3 running · 1
passed`, then `3 rows · 3 passed`. Steps 5–6 paint once. The Rows section
in the panel shows the section's rows under its name, `Rows · Upload each
statement (3)`.

**You write:** the same test, and the second file fails to upload.
**You get:** row 2 goes ✗ with the hover *Iteration 2 failed at step 1 of
the section — "Upload file {{file}} as the statement…"* and the error; row 3 shows
the skip mark, *not run (iteration 2 failed)*; the call-site step 4 is red
as it is today, and steps 5–6 are not run. A failed iteration ends the run
— that is part B's rule, unchanged; the table just shows it now.

### How you run one row, or some

**You write:** right-click the line number of row 4 and pick **Run This
Row**.
**You get:** one ordinary interactive run with row 4's values, in a fresh
browser — as every row of a row run gets, the one it is first in included.
Pause, breakpoints, F11 into a skill, the Variables view and *Re-run from
step N* all work, because it is the run-level loop with one row in it. Row 4
spins then goes ✓ or ✗; the other four rows keep whatever marks they had, or
none. The report's matrix has one line, `Row 4 of 5`, so it is comparable
with the full run's. This is the debugging loop: a matrix goes red on one
row, you fix the row or the page, you run that row alone — on the page that
row starts from, not on whatever the last run left on screen.

**You write:** select rows 2 to 4 in the table (drag, or Shift+click) and
press Run (F5), the same gesture that runs selected steps.
**You get:** rows 2, 3 and 4 run, in table order, each in a fresh browser,
numbered 2, 3 and 4 everywhere. Rows 1 and 5 keep their previous marks.
Select the whole table, or the whole file, and you get every row — a
selection that covers everything means everything, which is what it means
for steps today, and which includes the browser restarting between rows.

**You write:** highlight rows 1 and 2, Alt+click on step 2 and Shift+End
to highlight it too, press F5.
**You get:** step 2 runs with row 1's values, then with row 2's, on the
page the session is already on. No browser restart between them: a fresh
browser per row belongs to the whole-file run, and a selection of steps
runs where the session is — exactly what pressing Run Selected Steps twice
with different values would do. The selection narrows both axes, the steps
in it and the rows in it, and an axis with nothing selected means all of
that axis. So "step 6 with rows 2 to 4" re-checks each outcome on the page
you are on, and "steps 1 to 3 with rows 1 and 2" signs in twice in a row in
one browser. A cursor sitting on a row with nothing highlighted runs
everything, as a cursor on a step does today; Run This Row is the one-row
gesture, not the cursor.

**You write:** after a run with two red rows, click **↻ Re-run failed** in
the Rows header (or run *TestBench: Re-run Failed Rows* from the palette).
**You get:** just those rows, by their table numbers, resolved from the file
as it is now rather than from the numbers the panel happens to be showing.
The button is there while that table has a red row — including after a window
reload, since the marks persist and the offer is read off them. Editing the
row drops its mark, and with it the offer for that row.

**You write:** *TestBench: Run Rows…* from the command palette.
**You get:** a quick pick with one checkbox per row — its number, its
values, its last status, grouped by table when the file has more than one
— and Run runs the ticked ones. The keyboard path to the same thing.

**You write:** select two rows and press Run & Compile.
**You get:** the compile records the *first selected* row, which decision 11
of the rows story already says; the Output log says `compile records row 2`
so a row with an empty referenced value is not a surprise. Put the
populated row first in your selection, as you put it first in the table.

**You write:** in the upload test, right-click the `statement.pdf` row of
the section's table and pick **Run This Row**.
**You get:** the whole test runs — steps 1–3, then the section *once*,
with that row, then steps 5–6. The section's row 2 goes ✓, its rows 1 and
3 are untouched, the Output log says `Upload each statement — iteration 2
of 3` and the report badge reads `(2/3)`: the row keeps its table number.
Step 6, *assert that {{document_count}} equals 3*, then fails, visibly,
because one file was uploaded: narrowing a section changes what the steps
after the call see, and the test says so rather than pretending otherwise.
Selecting several rows of a section table narrows its loop the same way.

**You write:** a smaller test — three main-flow steps, the third of which
calls a section whose table holds two rows and whose body holds two steps —
and you want to re-check just the password field, for the second set of
credentials.

```
## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Log In

### Log In
| email                 | password    |
|-----------------------|-------------|
| demo@securebank.com   | password123 |
| nobody@securebank.com | wrongpass   |
1. Enter the email {{email}}
2. Enter the password {{password}}
```

Drag over steps 1–3, Alt+click body step 2, Alt+click the table's second row,
Shift+End on each, F5.

**You get:** steps 1–3 run once, the section runs once — row 2, `iteration 2
of 2` — and it enters only the password. Body step 1 gets no mark at all: it
did not run, and a `skip` would claim the run planned it. The section table's
row 2 goes ✓ and row 1 keeps whatever it had. The Output says both narrowings,
one line each:

```
Log In — running rows 2 of 2; steps after this call will see only those rows
Log In — running body steps 2 of 2
```

The two axes are independent — narrow the rows, the body steps, both or
neither — and neither knows about the other. What makes this work at all is
that the body is expanded by the *server*: the selection cannot simply not-send
a body line the way it not-sends a main-flow one, so it says which body steps
to run and the expander honours it (`runSteps`, below). Body lines whose call
is *not* in the selection are dropped and said out loud, exactly as ignored
rows are: `Log In — body steps 2 ignored: the step that calls this section is
not in your selection`. And a selection made of body lines ALONE is still the
detached body run it has always been — it runs those lines at the root frame,
with no call to narrow.

### Selecting rows and steps that are not next to each other

The extension already reads every selection in the editor, not just the
first, and the Runner panel's Steps list already has multi-select. The
gestures, on Windows defaults:

- **Editor.** Alt+click adds a cursor; Shift+End (or Shift+Home) gives
  every cursor a highlighted range on its line; Escape drops the extra
  cursors. So rows 1 and 2 plus step 2 is: drag over rows 1–2, Alt+click
  step 2, Shift+End, F5. Bare cursors are ignored on purpose (a cursor
  means "I'm parked here"), so each pick needs a highlight. With
  `editor.multiCursorModifier` set to `ctrlCmd` the modifier is Ctrl.
- **Panel.** Ctrl+click toggles a row or step, Shift+click selects a range
  from the last one clicked, and the Run button reads `Run (N)`. The Rows
  section gets the same behaviour as the Steps list, and a selection can
  span both lists.

One thing has to be fixed for any of this to be comfortable. The helper
that turns selections into line numbers takes every line from the
selection's first line to its last, without looking at *where* on the last
line the selection ends. The whole-line gestures — triple-click, Ctrl+L,
Shift+Down from column 0 — end at column 0 of the *next* line, so
triple-clicking row 2 today would select row 3 as well, and triple-clicking
step 2 runs steps 2 and 3. No test catches it; the integration tests end
their selections mid-line or use bare cursors. Triple-click is the natural
way to pick a table row, so the guard is a prerequisite of this story
(§"Whole-line selections").

## What exists, and what this adds

The run-level loop is entirely client-side in `run-controller.ts`:
`readDataRows` snapshots the table when Run is pressed, `rowPlan` is the
list of rows, and the loop closes the session, forgets the sent config,
clears the file's statuses, posts `parametersResolved` and a `Row N of M`
Output banner, then runs the step blocks. `rowFailuresByLine` collects
failures per line across rows, and `finishRowRun` posts `rowSummary` (the
worst-of-rows repaint with *Failed on rows 2, 4* hovers), prints a per-row
summary and calls `finalizeRowReport` for the one report. The server sees
a batch per row carrying `dataRow`/`dataRowCount`/`dataRowValues` and
accumulates.

The section-level loop is server-side. `buildSectionsPayload`
(`sections.ts`) ships each section's `rows` with its steps; the expander
loops `section.rows ?? [null]` and stamps every iteration's frame with
`iteration` and `iterationCount`; `session-manager` copies both onto the
wire frame, so every `frame:push` the extension receives for a looped body
already says which iteration it is. The client-side `FrameInfo` in
runner-core's `protocol.ts` does not declare the two fields yet.

Three facts make this story cheap. `parseDataRows` returns `rowLines` and
`headerLine`, so the client knows which editor line each run row is;
`parseSectionDataRows` is built on the same `scanDataTable` and merely
drops those lines from its result. Statuses in the tracker are keyed by
`(uri, line)` with no notion of what kind of line it is — the decoration
manager just reserves a status cell only on lines `extractStepLineIds`
returns. And a line selection already reaches `runLines` as a plain list
of lines, resolved to steps by `resolveRunSelection` and filtered exactly
(`classifySelectedSteps` keeps only the named lines, in document order —
`runner-core/tests/step-lines.test.js` pins it). Painting rows is "add the
tables' data-row lines to the paintable set"; selecting run rows is
"filter `rowPlan`"; selecting section rows is "filter what
`buildSectionsPayload` ships, and say which table positions survived".

## Design

### Row status in the table

- **Which lines.** The data rows of the run-level table and of every
  section table (the lines in each scan's `rowLines`) take a status. Not the
  header, not the delimiter row — a ✓ on a header would read as "the table
  passed", which is not a thing.

  The header and the delimiter do, however, **reserve** the same invisible
  cell. The status cell is a 1.2em `before` attachment, so a line that has one
  sits 1.2em right of a line that has not: give it to the rows alone and the
  pipes stop lining up in every data-driven file, run or not. `alignmentLinesOf`
  (`data-tables-core.ts`) is the two lines per table that join
  `placeholderRanges` without ever joining the status set.
- **Which marks.** The step vocabulary, unchanged: placeholder (not
  started), running, pass, fail, stopped, skip. `pass-cached`,
  `pass-code-behind` and `pass-stale` are step origins and never land on a
  row; a row is pass or fail. For run rows the controller sets them at the
  boundaries it already has: `running` when the row's first batch is sent,
  `pass`/`fail` when the row's steps end, `stopped` on the current row at
  Stop, `skip` on the rows the loop never reached when it ends early. For
  section rows they follow the frames (§"Section tables").
- **The running row is highlighted.** A whole-line background on the row that
  is executing, cleared at the boundary. The spinner alone is a 1.2em glyph in
  a wide table; the band is what makes "row 3 is running" readable from across
  the room. The colour is `editor.stackFrameHighlightBackground` — the
  debugger's "the line executing now", which is what this is, and which is
  legible in both default themes; `editor.rangeHighlightBackground` is ~4%
  white in Dark+ and disappears over a table. The overview-ruler tick uses a
  solid token (`editorOverviewRuler.infoForeground`) rather than the same
  translucent wash, because a 4%-alpha tick in the scrollbar is no tick.
- **Hovers.** A row's hover is its own Markdown, *not* the step hover
  (`failHoverMessage`): that renderer opens with "This step failed:" — a row is
  not a step — and fences everything it is given at 1000 characters, so a long
  Playwright log used to push the heading into a code block and clip the values
  off the end. A failed row reads `Row 3 failed at step 6 — "<step text>"`,
  then the row's values (masked, as inline code so a `_` or `*` in a cell
  renders as itself), then the error alone in a fence — using the same `fenced`
  helper the step hover uses, so the clipping rule stays in one place. The
  decoration renders a data-row line's pinned error verbatim; every other line
  still goes through `failHoverMessage`.

  A skipped row: `Row 5 not run (stopped)` / `(paused)` / `(run ended early)` /
  `(iteration 2 failed)`, with the Run This Row hint on the paused form. The
  row a Stop cut off: `Row 3 stopped — the run was stopped while this row was
  running`, or `— the run ended …` when the run died rather than being
  stopped, or `— the prompt was cancelled` when an `[input:]` prompt was
  escaped — the ■ is the one mark with no other explanation anywhere. A passed
  row: no hover, as a passed step has none.

  A row that died in another FILE — a `[skill:]` the row called — reads
  `Row 3 failed in login.md` and then the error, with no ordinal and no quoted
  step. Both of those are read out of the TEST document at the failure's line,
  so a skill-body failure on line 12 would otherwise be reported as *step 2*
  and quoted as whatever the test's own line 12 says: a step this row may never
  have reached. The failure's frame carries the file it happened in, and that
  is the URI check that decides which form the hover takes — the same one
  `sectionPauseAt` makes.
- **Header summary.** After-text on the table's header line, built the
  way the `## Steps` summary is: `5 rows · row 3 of 5 running · 2 passed`
  while looping, `5 rows · 4 passed · 1 failed` after, `5 rows · 2 passed
  · 1 stopped · 2 not run` after a Stop; `iteration` in place of `row` on
  a section table. The `## Steps` line keeps its step summary, which
  during a loop is the current row's and after it is worst-of-rows — the
  two lines are one apart and say different things.
- **Selecting a subset.** Rows not in the selection are not touched: they
  keep the mark they had from the last run, or the placeholder. They are
  never painted `skip` — skip means "was going to run and did not", and
  the hover on a stale mark from an earlier run would otherwise lie about
  this run. `Clear Run Statuses` clears rows with the steps.
- **Persistence.** Row marks persist with the step marks in
  `.testbench/run-state.json` and are dropped by the same signature check
  when the file changes — every table's `rowLines` join the step lines in
  the signature, so editing a table (add, remove, reorder a row) drops its
  row marks rather than letting ✓ sit on a row that now holds different
  values. The signature is one string for the whole file, so this cuts both
  ways: editing a table cell while the file is closed drops that file's STEP
  marks too. Accepted rather than split into a per-line signature, because the
  cost is a re-run of a file the author was in the middle of editing, and the
  alternative — two signatures that can disagree about whether the state is
  stale — is the bug this check exists to prevent.

### Section tables

- **Lines.** A new `scanSectionDataTables(text)` in runner-core returns
  the full `DataTableScan` per section name; `parseSectionDataRows`
  becomes a projection of it, so the two cannot disagree about which
  table belongs to which section.
- **A malformed section table is reported.** Three places swallow that scan's
  throw for good local reasons — `buildSectionsPayload` so a bad table does not
  stop the run, `dataTablesOf` so it does not take the step marks down with it,
  `scanTables` so a selection cannot name rows of a table that does not parse —
  and the sum of three sensible decisions was that nobody told the author. The
  section then ran once with its `{{placeholders}}` unresolved, which reads as
  a model failure three steps later. The run now says `Section data table not
  read: …` once, beside the run table's own parse error.
- **Painting follows the frames.** `iteration` and `iterationCount` are
  added to the client `FrameInfo` — the server already sends them. On
  `frame:push` for a section frame with `iteration: n` **whose `uri` is this
  test file**, the extension paints row `n` of that section's table `running`
  (with the highlight); a section name is unique within a file and not across
  files, so without the URI check a looped `### Upload each statement` inside a
  skill would paint the test's table of the same name, for iterations of a
  table that is not on screen. `frame.uri` is an fsPath, not a `file://` URI —
  the same comparison `sectionPauseAt` makes;
  on the matching `frame:pop` it paints `pass`, or `fail` if a `step:fail`
  arrived inside that frame — the same bookkeeping the rows story's
  never-downgrade fix gives `handleFramePop` for the call-site line. A
  failed iteration ends the run, so on the run's `done` every row of that
  table after the failed one is painted `skip` with *not run (iteration n
  failed)*. Stop paints the running row `stopped` and the rest `skip`, as
  for run rows.
- **Across run rows.** A section table inside a data-driven run is looped
  once per run row. Its rows repaint per run row like the steps do, and
  at loop end the worst status per row stays, with the run rows named in
  the hover (`On run rows 1, 3.`) — the run-row rule applied to one more kind
  of line. A nested loop (a table in a section called from a looped section)
  paints the inner table per inner iteration; across outer iterations the worst
  status wins, the same rule, no special case.

  The worst is kept **beside** the row's live status, not in it. Each iteration
  starts by setting its row `running`, which is what makes the band follow the
  loop and which also clears the row's detail and hover — so a merge that lived
  in the status alone lost run row 1's failure the moment run row 2 started the
  same iteration, and the row ended green. The live status is what is
  happening; the worst is what happened; the run's end paints the second over
  the first. A row still `running` at that point is exempt: it is where a pause
  parked the run, and its verdict is not in yet.
- **Selecting rows of a section.** The selection narrows that section's
  loop for a run that still runs the whole flow — steps before the call,
  the call once per selected row, steps after. `buildSectionsPayload`
  ships only the selected rows and, alongside them, two new optional
  fields: `rowNumbers` (each shipped row's 1-based table position) and
  `rowCount` (the table's row count). The expander stamps `iteration`
  from `rowNumbers[i]` and `iterationCount` from `rowCount` when they are
  present, else `i + 1` and `rows.length` as today, so the frame, the
  Output banner, the report badge `(2/3)` and the Variables frame label
  all keep the table's numbers. The server refuses a payload whose
  `rowNumbers` length differs from `rows`, is not ascending, or exceeds
  `rowCount`. The CLI does not send the fields and is unchanged.
- **Selecting body steps of a section.** The same idea one level down, and a
  third optional field: `runSteps`, 0-based indices into that entry's `steps`,
  unique and strictly ascending. The body still travels WHOLE — `runSteps`
  indexes into it — and the expander emits, per iteration, only the steps it
  names. Each kept step keeps the identity a full run would have given it: its
  `stepLines` entry, so the gutter and the report name the line the author
  selected, and its code-behind occurrence among body steps with the same
  authored text, so a body whose third `Click Next` is the only one selected
  still binds the third entry rather than sliding into the first one's. The
  server refuses an empty, unsorted, duplicated, negative, non-integer or
  out-of-range list, for the reason it refuses a bad `rowNumbers`: a list it
  quietly tidied would run a step the author excluded, and say nothing.
  A selection that keeps the WHOLE body is not a narrowing and ships no field,
  so a drag over the file is byte-identical on the wire to what it always was.
  The CLI does not send it and is unchanged.
- **Where the narrowing is decided.** Inside the run controller's
  `runLinesInner`, not in `runSelected` — F5, the panel's Run and a `runRows`
  carrying `lines` all arrive at that one choke point with the body lines
  still in `lines`, and a split done in one of them would be missing from the
  other two. Body lines narrow a section only when the resolved scope is
  `main-flow` (a mixed selection) AND the section's call is among the selected
  steps, the same `matchText` check the row narrowing makes.
- **An older server cannot make the client paint the wrong row.** A
  pre-upgrade Sessions API drops fields it does not know: it receives one row,
  stamps `iteration 1 of 1`, and painting `frame.iteration` would put the green
  mark on row 1 of a run narrowed to row 2, with a `(1/1)` badge and no error
  anywhere. So for a section this run narrowed, the *k*-th iteration frame is
  painted as `requestedRows[k]` — the client shipped the rows, so it knows what
  the *k*-th of them is called — and the frame does not get to overrule that.
  When `frame.iteration` disagrees, the run posts one Output warning naming the
  numbering it got and what to do about it, because the *report* is written by
  that server and only a restart fixes it. The counter resets at each run-row
  boundary, since a section's loop starts over inside every run row.

  `runSteps` has the same hazard and no such fallback: a server that drops it
  runs the whole body, and nothing on the wire admits that. So it is detected
  from the OUTSIDE — a `step:start` (or pass, or fail) for a body line of a
  narrowed section that the run did not select can only mean the field never
  arrived. One Output warning per run, in the same voice: `Log In — the server
  ran the whole section body; restart or update the Sessions API server so a
  selection can narrow it`. Nothing is painted differently, because nothing IS
  different — the step really did run, and hiding its mark would be a second
  untruth on top of the server's.
- **Run This Row on a section row** is the same thing with one row. It
  is offered — the rows story's decision 7 said it was not, because "a
  section iteration only makes sense after the steps that lead to the
  call"; running the whole flow with the loop narrowed is exactly those
  steps followed by that iteration, which is why this story reverses it.
- **What later steps see.** A narrowed section loop changes the page the
  steps after the call find, and any count they assert on. The Output log says
  `Upload each statement — running rows 2 of 3; steps after this call will see
  only those rows` at the call, so the failure downstream reads as a
  consequence of a choice made here rather than as a mystery. A selection of
  section rows whose call is not among the selected steps (a step selection
  that stops before it) has no effect, and the log says so in the reader's
  terms: `Upload each statement — rows 2, 3 ignored: the step that calls this
  section is not in your selection`.

### The Rows section in the Runner panel

- Shown only when the active file has at least one data table; sits above
  Variables, collapsible like the others. One group per table — the run
  table first as `Rows (5)`, then each section table as `Rows · <section
  name> (3)`; a file with one table shows one group with no name. One
  line per row: glyph, number, the `k=v, k=v` values text the Output
  banner already builds (secrets through `maskIfSecret`), then `failed at
  step N` on a failed row and the duration once the row is done.
- It is fed by one new host→webview message, `rows`, posted when Run
  starts (every row pending, or the selected rows pending and the others
  as they were), at each row and iteration boundary, and at run end. It
  carries what the report's matrix and bands carry, so the panel and the
  report cannot disagree. An EMPTY table list is a message too, not a reason to
  stay quiet: a file whose table has been deleted has to say so, or the panel
  keeps showing rows that are no longer in the file.
- **And outside a run.** A section fed only from inside a run is empty until
  you press Run, and empty again after a window reload even though the ✓/✗
  marks are still on the rows — the marks persist and the message that
  described them did not. So the registry *derives* the same message from the
  file plus the tracker's statuses (`buildRowsMessage`) and posts it on every
  editor switch and whenever the derivation changes. Three rules keep it out of
  a live run's way: nothing is posted while that file is running; the
  comparison ignores `durationMs`, which only a run can measure; and after a
  run the tracker was painted *from* the controller's message, so a derivation
  of it is identical and posts nothing. A derived row's `detail` is read back
  out of its persisted hover (`rowDetailFromHover`) rather than persisted
  separately — one authored string per row, everything else a projection.
- Click a row: reveal its line in the table. Ctrl+click / Shift+click:
  multi-select, with the anchor logic the Steps list already has, and a
  selection may span the Rows and Steps lists — Run then sends both.
  Right-click: *Run this row* / *Run selected rows*, both greyed while a run is
  in flight, like the header's **Run all rows**. The group header also carries
  **Re-run failed** while that table has a red row.
- **Both header buttons name the table, not the rows.** ↻ Re-run failed posts
  `rerunFailedRows` with `'run'` or `{ section }`, and the host resolves the
  set through the same `failedRowsToRerun` the palette command uses. ▷ Run all
  rows posts `runRows` with `all:` and the same table ref, and the host reads
  every row of that table out of the file. The panel's own numbers can be a run
  old: re-running a remembered number would run whatever row now sits in that
  position, and "run all" built from remembered numbers would leave out the row
  the author has just added — the one they are most likely to have pressed it
  for.
- Each group's collapsed/expanded state is remembered per FILE as well as per
  table. The panel is one webview shared by every test, like the Output log and
  the compile strip, so a table-only key collapsed the Rows section on every
  data-driven file at once.
- **Run says when it is multiplied.** A step selection in a data-driven file
  runs those steps once per row — right, and previously silent: the button read
  `Run` and the gutter repainted the same step five times. With rows ticked it
  reads `Run (N)`; with steps ticked, no rows, and a run table present it reads
  `Run (×5 rows)`, tooltip *Run 1 selected step for each of 5 rows*. The run
  itself says the same thing once, before the first batch: `Running 1 selected
  step for each of 5 rows — select rows in the table to narrow it`.
- The Variables header gains `· row N of M` during a run-row loop, since
  its values already follow the row (`parametersResolved` per row) and the
  header is where a reader looks to know whose values they are. During a
  section iteration the frame label the Variables view already shows,
  `Upload each statement (2/3)`, does that job.
- Step failure text in the Steps list is prefixed `(row 3)` after a
  run-row loop, matching the gutter hover; during the loop it is the
  current row's and needs no prefix.

### Running rows

One controller entry, four ways in. `runLines` gains a `rows?: number[]`
option (1-based table numbers) and a `sectionRows?: Map<string,
number[]>` option keyed by section name. The run-row loop filters
`rowPlan` to those rows and keeps every number: `dataRow.row` is the
table position and `dataRow.count` is the table's row count, so the
report's `Row 4 of 5` and the panel's numbering hold for any subset. The
section map is handed to `buildSectionsPayload`.

The fourth axis needs no option at all. A selection's **body step lines**
arrive in `lines` like any other line and are split out inside `runLinesInner`,
which is what makes every gesture behave the same; `buildSectionsPayload`
takes them as its third argument and ships them as `runSteps`.

- **Run This Row** — `editor/lineNumber/context`, beside *Run This Step*,
  shown when the clicked line is a data row of any table (a
  `testbench-native.dataRowLines` context key, the pattern *Repair this
  step* uses with `staleStepLines`). A run-table row runs
  `runLines([], { rows: [n] })`; a section-table row runs `runLines([], {
  sectionRows: { <name>: [n] } })`.
- **Selection + Run** — `runSelected` splits `selectionLines(editor)` into
  step lines, run-table rows and section-table rows using the scans. Step
  lines go where they go today; the rest become `rows` and `sectionRows`.
  An empty selection stays "everything". A selection with only header or
  delimiter lines from a table is no rows selected, so all rows — you
  cannot select a table and get nothing. Body step lines are NOT split here:
  they are step lines, they travel in `lines`, and the controller splits them
  at the choke point so F5 and the panel cannot disagree.
- **Rows section** — the panel posts `runRows` with the chosen numbers per
  table, plus any selected step lines.
- **Run Rows…** — a `canPickMany` quick pick with a separator per table.
  A row of the run table is labelled `Row N`; a row of a section table is
  `Iteration N`, the word the gutter, the hovers and the report badge already
  use. The description is the row's masked values and the detail is `last run:
  passed` / `last run: failed at step 6` / `last run: not run (stopped)` —
  the panel's words, not the tracker's raw status. Both are matched on
  (`matchOnDescription`, `matchOnDetail`), because the label alone is "Row 3"
  and the thing you came here to find is an email address.
- **Re-run Failed Rows** — the rows the *gutter* currently marks failed, per
  table (`failedRowsFrom`). Read off the marks rather than remembered from the
  last run this window saw, so the offer survives a reload: the marks persist,
  and the tracker's signature check already drops them when the table changes —
  its signature includes each row line's text, so an edit to a row's values
  drops that row's mark too. There is nothing left for a separate shape check
  to catch, and a red row is re-runnable in a window that never ran it.

**A step selection runs where the session is.** The recycle's
`closeSession`, `forgetSentConfig` and status clear run only for a
whole-file run (the `wholeFileRun` gate that already decides whether the
loop happens at all, narrowed further to "the selection does not cover the
whole flow"). With a proper subset of the steps requested, each selected row
rebuilds `params`, posts `parametersResolved` and its banner, and runs the
selected steps on the current session; only the selected step lines repaint
per row. The Output log's banner reads `Row 2 of 5 (steps 3–6) — …` so the
report and the log say what ran. The batches still carry `dataRow`, so the
server accumulates them into one report as it does for a whole-file loop.

**Covering everything is everything.** Ctrl+A then F5, and shift-clicking the
first step in the panel and the last, both arrive as a step selection naming
every step there is. Reading that as "some steps" put five rows in one browser
and started rows 2–5 on the page row 1 had signed into. So the recycle
restarts the browser when the selection is empty *or* resolves to every
main-flow step — a selection that covers everything means everything, which is
what it already means for steps.

**Before the first row, not only between them.** The recycle is a thing done
*for* each planned row, not a boundary *between* two of them:
`recycleSessionForRow` is called for every row in the plan, index 0 included,
and the first one has the same claim on a fresh browser as the rest. It ran
only at the boundary, so the first planned row of any row run — row 1 of a Run
All, the single row of Run This Row, the first of a subset — inherited whatever
interactive session was already open, along with its page and its
localStorage. Measured: after a green five-row run of `securebank-matrix.md`,
*Run This Row* on row 4 navigated to the baseUrl and then failed step 2, *the
cookie banner is not visible in the current page* — row 5's browser had
answered the banner and the site remembered. Two things stay where they are.
The status clear is still a boundary job: at the first row the run has already
cleared the file and painted the matrix over it, and clearing again would wipe
the marks the unselected rows are seeded from. And a batch run skips the first
row's close, for the reason it skips the pre-run one: it mints its own
`<path>::run-N` session and always launches fresh, so there is nothing of its
own to close.

**Resolves to**, not "contains". The two are different questions and the
gesture that separates them is the most ordinary one there is: drag from
`## Steps` down to step 1 and the raw lines are a heading, the table and a
blank — not one step among them — while `resolveRunSelection`'s fallback
correctly reads that as the whole flow. Asking the raw lines whether they cover
every step answers no, so `securebank-matrix.md` ran five rows in one browser
with no cookie banner left to reject after row 1. The question is asked of the
resolved step set, which is the set that is about to run.

No per-row CodeLens, which decision 7 of the rows story had pencilled in.
A CodeLens renders as a line *above* its anchor, so five rows would get
five lens lines interleaved with them and the table would stop looking
like a table. The gutter menu is the same one-click and leaves the
table alone.

### Whole-line selections

`selectionLines` (`active-file-tracker.ts`) ignores the end line of a
selection that ends at column 0 of a later line — that position is the
line break the whole-line gesture swallowed, not a line the user chose. A
selection that ends past column 0 keeps its end line, as today. The
helper is exported for a `node --test` case that pins both shapes and the
cursor-only rule, since it feeds `runSelected`, `snapshot.selectedLines`
(the panel's fallback) and the new row split alike. This lands first, on
its own, because it changes what *Run Selected Steps* does for a
triple-clicked step today.

**One exception, and it is not about tables at all.** Narrowing a selection
must never widen a run, and the guard on its own could: a drag from a blank or
prose line that stops at the *start* of a step used to name that step
(`[5, 6]` → run step 6). Drop the 6 and the selection names nothing runnable,
so `resolveRunSelection`'s last fallback — "every main-flow step at or below
the lowest selected line", which is what makes "drag over `## Steps`, then Run"
run the file — takes over and runs step 6 *and every step after it*. So
`selectionLines` passes the document's runnable lines (its steps, main-flow and
section-body, plus every data row) into the helper, and the guard keeps the
line it would drop when that line is runnable and nothing else in the selection
is. Triple-click on a step is untouched: the line it swallows is the next step
and the line it keeps is a step, so the exception does not fire. The fix is on
the editor side deliberately — the resolver's fallback is right and is what a
drag over the heading depends on.

### What does not change

- A failing run row does not stop the loop; Stop stops; a pause ends the
  loop after the current row (rows story, decision 6). A failing section
  iteration ends the run (part B, §"Failure"). Run This Row is still the
  way to debug a row with breakpoints.

  What *did* change is that the loop now obeys that rule. The decision is taken
  where the row's block ends, on every path that parks a run — a breakpoint
  trim, a Pause, a server pause, a cancelled `[input:]` or `[interactive]` —
  because the flag those paths set is only assigned once the loop is over, so a
  guard reading it at the top of the next iteration could never fire. It never
  did: a breakpoint on step 4 of the five-row matrix ran the trimmed steps 1–3
  five times, closing the browser between them, and painted `5 rows · 5
  passed`. The parked row keeps its band and is settled by the Continue
  (`isResume`, which carries the row number on the controller) or by a Stop;
  its Output line is `Row 1: paused (2.1s)` and it has its own part in the
  `Rows:` summary, so the parts still sum to the planned count.
- After a multi-row run the interactive session belongs to the last row
  that ran — now the last *selected* row — and *Re-run from step N* re-runs
  that row alone from step N. The Output log says which row, as today. What
  no longer inherits it is the next row run: a whole-file row run closes
  whatever session is open before its FIRST planned row, the same way it does
  between rows, so the row you re-run does not start on the page the last one
  left (§"Before the first row, not only between them").
- Step cache stays off for row runs; compile records the first selected
  run row and every iteration of a narrowed section (decision 11) and the
  Output log names the row.
- The report: one file, the matrix listing the run rows that were part of
  the run, the bands naming section iterations by table position. One thing
  there did change: a secret-named cell that is EMPTY renders `(empty)` rather
  than `***` (`redactMap`, src/utils/secrets.ts). Nothing is disclosed by
  saying a field was left blank, and a matrix whose whole point can be "blank
  password" against "wrong password" could not tell the two rows apart. It is
  the word the client's `maskIfSecret` already prints for the same cell on the
  Output banner.
  Unselected rows are not "not run" — they were never planned — so they
  are not passed to `finalizeRowReport` and do not appear. Rows the loop
  planned and did not reach (Stop, pause, a failed iteration) still do.
- The Test Explorer keeps one item per file and runs every row. Its
  failure messages gain a `(row N)` prefix, which the rows story specified:
  without it, five rows failing step 6 read as five identical messages. In the
  streamed line the row goes with the WHERE — `✗ step on line 12 (row 3)
  failed — …` — because after the dash it reads as part of the error text; the
  TestMessage keeps the prefix, having no line to attach it to.
- The wire to the SERVER gains three optional fields on a section payload entry
  and nothing else; the CLI, the MCP path and `dataFile:` are untouched. An
  unselected body step is not "skipped" on the wire either — it is simply not
  expanded, so no event mentions it and no surface has to invent a mark for
  it. The
  webview protocol gains two messages of its own, `rows` and `rerunFailedRows`,
  which never leave the extension.

## Decisions

1. **Row numbers are table positions, always.** A subset run's rows keep
   their numbers in the gutter, the panel, the log, the report's matrix
   and the section badge, so a `Row 4 of 5` from a one-row run lines up
   with the full matrix and a `(2/3)` badge names the same row it always
   did.
2. **The table is the control surface.** Status is shown on the rows;
   rows are chosen by selecting them or pointing at one. No marker column,
   no frontmatter key, no new syntax — a checked-in test is not changed by
   choosing what to run today.
3. **Selection narrows every axis; nothing selected means all of that
   axis.** Steps in the selection, run rows in it, section rows in it,
   section body steps in it. Cursor-only still means everything; Run This
   Row is the one-row gesture.
4. **A fresh browser per row belongs to the whole-file run.** A selection
   of *some* steps runs where the session is, once per selected row, which
   is what Run Selected Steps has always meant. A selection that covers every
   step is not that: it is the whole file, arrived at by Ctrl+A, and it
   restarts the browser between rows like any whole-file run.
5. **Rows reuse the step marks.** Pass, fail, running, stopped, skip and
   the placeholder; no new icons. The running row additionally gets a
   whole-line highlight.
6. **Unselected rows are untouched, never skipped.** Skip is for rows the
   loop planned and did not reach.
7. **Section tables are painted and selectable, in one run.** Painting
   follows the frames the server already stamps; selecting narrows the
   section's loop inside a run of the whole flow. This reverses the rows
   story's "Run This Row is not offered for section rows".
8. **The Rows section is the matrix table, live.** Same values text as
   the Output banner, same masking, same numbering, same status words as
   the report (`passed`, `failed`, `not run (stopped|paused|iteration n
   failed)`).
9. **Row and step hovers cross-reference.** The row says which step; the
   step says which rows.
10. **A whole-line selection ends where the line ends.** A selection
    ending at column 0 of the next line does not include that line.
11. **No per-row CodeLens.** The table's layout is worth more than a
    second click target that the gutter menu already provides.
12. **Client-side, plus three optional wire fields.** `rows` and
    `sectionRows` are `runLines` options; the run loop filters `rowPlan`;
    the section payload gains `rowNumbers` and `rowCount` so the server
    keeps the numbering honest, and `runSteps` so a selection can narrow a
    body the client cannot expand. Nothing else on the wire, nothing in the
    CLI.

## Tests

- `selectionLines` (`node --test`): a selection ending at column 0 of the
  next line yields its start lines only; one ending mid-line keeps its end
  line; a bare cursor yields nothing; two selections merge sorted. And the
  exception, both ways: a drag from prose that stops at the start of a step
  keeps that step, while a triple-click on a step still drops the step below.
- `data-tables.test` (`node --test`): the data-row lines of run and section
  tables are the ones that take a status; the header and delimiter lines are
  not among them but ARE among the lines that reserve the cell
  (`alignmentLinesOf`), and the two sets never overlap. Asking twice for the
  same text scans once.
- `row-summary.test`: the header summary text for looping, finished, stopped,
  paused and iteration-failed; the failed-row hover's exact Markdown, and that
  a 4000-character error is clipped inside the fence with the row and its
  values still ahead of it; every hover's note is recoverable from it.
- `run-controller` unit: `rows: [4]` sends one batch with `dataRow: {row:
  4, count: 5}`; `rows: [2, 3]` sends two in table order with a session
  close before each; with a session already open from a previous run, a
  one-row run closes it BEFORE its batch, and a step selection of rows closes
  nothing at all; `rows: [1, 2]` plus step lines sends two batches of
  those steps with *no* session close and the `(steps 3–6)` banner; a
  selection naming EVERY step plus rows closes the session between them and a
  proper subset does not; row statuses set at each boundary; unselected rows
  never receive a status; the failed set read off the gutter, per table.
- A Stop mid-row: the interrupted row gets `  Row 3: stopped (2.1s)` and the
  `Rows:` parts sum to the planned count.
- A breakpoint mid-flow in a five-row matrix: ONE batch is sent, row 1 keeps
  the running band, rows 2–5 are `not run (paused)`, the header summary says so
  and the report is finalised with those four rows. Continue closes row 1
  pass/fail; a Stop while parked closes it ■.
- A cancelled `[input:]` prompt: that row ■ with *the prompt was cancelled*,
  the rows after it `not run (stopped)`, and no second prompt.
- A row that fails inside a `[skill:]`: the hover names the skill file, not a
  step of the test.
- A section table repainted across run rows: a failure on run row 1 survives a
  clean run row 2, with the run row named in the hover.
- `sections.ts`: `buildSectionsPayload` with a filter ships the chosen
  rows plus `rowNumbers` and `rowCount`; without one ships neither. With a
  BODY filter it ships `runSteps` and leaves `steps`/`stepLines` whole; with
  both filters it ships all three fields; a filter that keeps the whole body
  ships none.
- `splitBodySteps` (`node --test`): body lines grouped by section; a section
  whose call is not among the running steps comes back `ignored`; a whole-body
  selection is neither; the call matched by `matchText`; two sections answered
  independently. And the three strings — the `running body steps 2 of 2` line,
  its list and range forms, the `ignored` line and the old-server warning.
- Server (`api-server` suites): a section payload with `rowNumbers`
  stamps `iteration` from it and refuses a mismatched, unsorted or
  out-of-range list. `runSteps: [1]` on a two-step body runs only the second
  step per iteration, on its authored line; both narrowings together keep both
  numberings; an absent field runs the whole body; empty, descending,
  duplicated, negative, non-integer, non-array and past-the-end lists are
  400s.
- Expander (`skill-expander-sections`): a narrowed body emits only the named
  steps with their own `stepLines`, and a kept step keeps the code-behind
  occurrence a full run would have given it — a body with three `Click Next`
  steps, narrowed to the third, still binds occurrence 2.
- Fast suite (`suite/data-rows.test.cjs`): the reported gesture through
  `runSelected` — three main-flow ranges, one body line, one row line — ships
  `runSteps: [1]` beside `rowNumbers: [2]`/`rowCount: 2`, logs both lines, and
  leaves only main-flow lines in the request's `sourceLines`; a body selection
  whose call is not selected is ignored and logged; a body-ONLY selection still
  runs detached; a fake server that emits a step for an unselected body line
  gets the old-server warning exactly once, and one that does not gets none.
- Extension frame handling: `frame:push` with `iteration: 2` paints the
  section table's row 2 running; the matching pop paints pass; a
  `step:fail` inside the frame paints fail and the later rows skip on
  `done`. And with a fake server that drops `rowNumbers` — `iteration 1 of 1`
  for a run narrowed to row 2 — row 2 is still the row painted, with one
  Output warning; a server that honours the fields is not warned about.
- `runSelected` split: a selection of run rows only, section rows only,
  steps only, rows and steps, the header alone, the whole file. And a drag from
  `## Steps` to the first step — a heading and a blank, resolving to every step
  — closes the session between rows.
- A malformed section table is reported once, in the Output, and the run still
  goes ahead unlooped.
- Panel: the `rows` message renders one group per table with the masked
  values; selection across Rows and Steps posts `runRows` with both;
  *Re-run failed* appears only while that table has a red row, and posts
  `rerunFailedRows` naming the table rather than the numbers on screen;
  *Run all rows* likewise, and the host resolves it against the current
  document; the collapse key is per file; `Run (×5 rows)` when steps are
  selected and rows are not.
- Rows outside a run: opening a data-driven file yields a `rows` message with
  every row `pending`; coming back to a file whose marks were persisted yields
  one carrying them, notes and all; a file whose table has been deleted yields
  an empty one rather than nothing.
- Test Explorer: `(row N)` prefix on failure messages.
- Live (`tests/integration/live`): `securebank-matrix.md` — a full run
  paints ✓✓✓✓✓ on the rows and the header summary; `rows: [4]` paints
  row 4 only and the report's matrix reads `Row 4 of 5`; rows 1–2 with
  step 2 leaves the session open between them. The rows story's upload
  fixture, once it lands: a full run paints the section's three rows in
  turn; Run This Row on its second row runs the whole flow with
  `iteration 2 of 3` in the log and the `(2/3)` badge in the report.
  And `securebank-login-rows.md` — three main-flow steps, one body step, one
  table row, one F5: the main flow passes, body step 1 has no mark at all,
  body step 2 passes, the table's row 2 goes ✓ and row 1 is untouched, both
  Output lines are there, and the server's own session reports THREE steps
  executed (a section call is replaced by its body, not run alongside it).

## Non-goals

- Rows from `dataFile:`. There are no table lines to paint; the Rows
  section and *Run Rows…* are the surfaces that would carry them, once
  TestBench loops that source at all.
- A persistent "skip this row" marker in the file. Useful for a row that
  is known-broken for a week; it is a file-format change on both runners
  and its own story.
- Resuming the run loop after a pause (rows story, decision 6 stands).
  Parallel rows. Letting a section loop finish after a failed iteration
  (part B's open question stands).
- Painting inner call sites of nested loops (the rows story's non-goal
  stands; inner *tables* are painted, inner *call lines* are not).
- Per-row items in the Test Explorer (the rows story's non-goal stands).
- CLI parity: `--row 2,4` / `--row 2-4`, and a CLI way to narrow a
  section's rows. Cheap, same numbering rule; not asked for.

## Open for review

- Whether the running-row highlight should also follow the *current
  step* — VS Code's debugger highlights the current line, and TestBench
  has never done that for steps; adding it for rows alone might make
  steps look under-painted by comparison.
- Whether the Rows section should show the values at all, or just the
  number and status, with values on hover. Five columns of a wide table
  will not fit; the proposal is to elide with `…` as the Steps list does.
- ~~Whether *Re-run failed* should survive a table edit that keeps the row
  count and columns.~~ Settled by where the failed set is read from: the
  gutter, whose marks the tracker drops per row line when that line's TEXT
  changes. So editing a failed row's values drops its mark and the offer with
  it — the opposite of the proposal, and the price of an offer that survives a
  window reload. Re-running the edited row is one Run This Row away.
- Whether a section-row selection whose call is not among the selected
  steps should be refused rather than logged and ignored. Ignoring it is
  consistent with "an unselected axis means all"; refusing it would catch
  a drag that meant to include the call and stopped a line short.
- Whether a narrowed section should say more than a log line about the
  steps after it — a hover on the call-site step, say. The failure
  downstream is real and the test should fail; the question is only how
  loudly to explain it.
