# Record Steps: click through the app, get the steps written for you

**Status:** spec, 2026-09-26, decisions confirmed by the author (insert
straight away, a panel **Add check** button, every typed value a parameter).
Not built.

## In plain terms

Writing a test today means knowing the app well enough to describe each step
in words before you have run anything. **Record Steps** turns that around: you
press Record in Steptix, use the app in the test's own browser the way a
user would, press Stop — and the numbered steps appear in your file, written
the way the handbook says to write them.

It is for authors who already know the format and want to go faster. The
output is Markdown steps only — no code-behind — and it lives in Steptix
only.

### What it looks like in practice

**You run** *Steptix: Record New Test*, name it `pay-by-cash`, and the test's
browser opens on the project's `baseUrl`. You sign in, open Payments, tick
Cash, click Pay now, and press **Stop**.
**You get** a new `tests/pay-by-cash.md`:

```markdown
# Pay by cash

## Config
- baseUrl: http://localhost:8787/

## Parameters
- email: demo@securebank.com
- password: $PASSWORD

## Steps
1. Navigate to login.html
2. Type {{email}} into the Email field
3. Type {{password}} into the Password field
4. Click the Sign in button
5. Click Payments in the main menu
6. Tick the Cash checkbox
7. Click Pay now
```

The password never left the browser: the recording only knew *something was
typed into a password field*, so the step reads `{{password}}` and the value
comes from `.env`, as it would in a hand-written test.

**You put the cursor** on step 12 of an existing test (after a run that
stopped at a breakpoint there, so the browser is already on the right page)
and press **Record**. You click through three more screens and press Stop.
**You get** the new steps inserted after step 12 and the rest renumbered — one
edit, so one Ctrl+Z takes it back.

**You press Add check**, then click the Payment method panel.
**You get** `Verify the Payment method panel says "Paid in cash"`. That click
was not performed on the page; it picked the thing to check.

**You click a trash-can icon** with no text and no label.
**You get** `Click the delete (trash can) icon on the "Everyday" account row`,
because the model was shown a crop of the page around the icon at the moment
you clicked it, as well as the page's own description of the element.

**You misclick** and open the wrong menu.
**You get** a list of actions in the Steptix panel as you go
(`● Clicked link "Reports"`); remove that one with its ✕ before pressing Stop,
and no step is written for it.

## Decisions

1. **Name: Record Steps.** "Record" alone already means compile's
   Record/Replay (`captureStepContext`, `.steptix-codebehind-cache/*.recording`)
   and `browser.video`. Commands, endpoints and code say *record steps* /
   *step recorder*.

2. **The browser is the test's own session browser.** Steptix's session id
   is the file path, and an interactive session stays open after a run. So
   recording continues from wherever that browser is — the natural way to
   extend a test is *run to the cursor, then record*. With no browser yet,
   starting a recording launches one and goes to `baseUrl`, exactly as the
   first step of a run does. The server's `browser.headed` must be on; a
   headless server refuses with a message saying so.

3. **The server records; Steptix shows and inserts.** A new SSE route,
   `POST /sessions/:id/record-steps`, holds the session's queue for as long as
   the recording lasts (so a Run cannot start in the middle of it), counts as
   in-flight work for the idle reaper, and streams one `record:action` frame
   per action as it happens. `POST /sessions/:id/record-steps/stop` ends it;
   the same stream then carries `record:result` (the Markdown) and `done`. It
   accepts `config` like a first steps request does, and Steptix marks the
   config sent, so the session it creates is the one the next Run uses.

4. **What is captured.** An init script plus one binding on the session
   browser's context, so every page, every tab it opens and every frame is
   covered from the moment the recording starts.

   **An action is a click or a drag, pressing Enter or Tab, or the browser's
   Back, Forward or Refresh** (the author's definition, 2026-09-26) — plus the
   Add check click, and Enter in the address bar. Each action sends the draft
   to the model (decision 9). Everything else is captured and rides with the
   next action: typing (one event per field, its final value), selecting an
   option, ticking or unticking, choosing files (their names), and a new tab
   or the author moving to another tab. Escape is no longer recorded.

   Drag and Refresh were out of scope in the first version, and the runtime
   could not perform either: a run's model has `back` and `forward` actions
   (SPEC-browser-history.md) but no `drag` and no `reload` (deferred there,
   §9). So this feature adds both to the runtime's action vocabulary, the way
   back and forward were added, or a recorded `Drag …` or `Reload the page`
   step could not run.

   Playwright cannot remove an init script, so after Stop the script stays
   installed but inert: every event asks the binding whether a recording is
   running, and the binding says no.

5. **Each action is described from the page itself.** Role, accessible name
   or label, visible text, placeholder, the dialog / section heading / table
   row / fieldset it sits in, the frame it is in, and a stable selector. The
   repo has selector builders (`find-in-dom.js`, `capture-dom.js`) but no
   accessible-name computation, so a small one is written for this, covering
   the common cases (`aria-label`, `aria-labelledby`, `label[for]`, a
   wrapping `<label>`, `alt`, `title`, button and link text).

6. **A screenshot goes with each action.** The page's description misses
   exactly the cases authors trip over: an icon-only button, a clickable
   `<div>`, a chart, two identical "Edit" links told apart only by where they
   sit. So at the moment of a click (mouse-down, before the click lands and
   the page moves on) or the first keystroke into a field, the server crops
   the page around the target, draws the target's box on it (`jimp`, already
   a dependency) and scales it down. The model is shown the crop beside the
   description. Rules:
   - `ai.sendScreenshots: false` sends none; a model that rejects images
     (the Copilot bridge, some providers — SPEC-use-computer §15.4) is retried
     without them.
   - At most 40 crops per recording; after that the descriptions carry on
     alone.
   - A password field shows dots, as on screen. Anything else visible goes to
     the model, as screenshots already do in runs.

7. **A secret never leaves the page.** A field that the DOM snapshot's
   `isSecretField` rule calls secret (type, autocomplete, name/id/aria-label,
   placeholder) sends *that it was typed into*, never the value. Its step
   uses a `{{parameter}}`, and a `## Parameters` line `- <name>: $<NAME>`
   points at `.env`. Recording into an existing test reuses a parameter that
   already fills that field.

8. **Every typed value becomes a parameter** (the author's choice). `Type
   {{email}} into the Email field`, with `- email: demo@securebank.com` added
   under `## Parameters`. The name comes from the field (its label, else its
   placeholder or name), in snake_case; a value typed twice into the same kind
   of field reuses one name. Recording into an existing test reuses a
   parameter the file already has when its value matches, and never
   overwrites an existing line with a different value — the model is shown
   the file's parameters and picks a new name instead. Selecting an option or
   ticking a box is not typing, and stays literal (`Select "Monthly" from the
   Frequency list`). Secrets follow decision 7: the value stays in `.env`.

9. **The steps are drafted live, as the author works** (changed at the
   author's request, 2026-09-26 — the first build wrote them in one call at
   Stop). Each action goes to the model shortly after it happens, with the
   draft so far; actions that arrive while a call is running, or within a
   short settle window after the last one, go together in the next call. The
   model answers with the draft's new TAIL: it may rewrite the last three
   steps as well as append, because turning mechanics into intents needs to
   see what came next — a click that only focused a field is dropped,
   clicking a checkbox's label is `Tick the … checkbox`, `Click Menu`
   followed by a click on Payments becomes one `Click Payments in the main
   menu`. Typing is still one action per field, so there is no call per
   keystroke. The draft shows in the Steptix panel as it grows — and, since
   the author asked for it on 2026-09-27 ("it would be nice if the steps
   appeared in the test after every action"), in the file too (decision 11);
   at Stop it is final (one last call when actions arrived after the last
   draft), and is written over the last draft. Dropping or restoring an action
   redrafts the whole recording in one call. The model is given the
   handbook's step-writing rules, the file around the cursor (its `baseUrl`,
   parameters and section names, so it can write `Navigate to login.html` and
   reuse `{{password}}`), and the time gaps between actions. It uses the
   session's model. Recording is a request FOR AI, so it runs even where runs
   forbid AI (`ai.allowInRuns: false`), as compile does. The cost: roughly one
   call per action or burst, where the first build made one per recording —
   and each call carries the file context again.

10. **Checks come from an explicit gesture.** **Add check** in the panel
    puts the page in pick mode: the next click is swallowed, not performed,
    and records the element and its text at that moment. The model writes a
    `Verify …` step in the handbook's style from it. Without a check, the
    recorder writes no `Verify` — a recording cannot guess what the author
    meant to assert.

11. **Where the steps go.**
    - **At the cursor** — the cursor must be on a step line, a section-body
      line, or the blank line after one, under `## Steps` (the same regions
      `classifyLines` already knows). The steps are inserted after that line,
      in that flow or section, numbered to follow it, and everything after is
      renumbered with the existing Renumber Steps logic. One undo takes the
      recording back out.
    - **While recording** (changed at the author's request, 2026-09-27 — the
      first build changed the file once, at the result): every draft goes
      into the file as it arrives, by the same rules, REPLACING the block the
      last draft wrote rather than inserting again — the model may rewrite its
      last three steps, so lines change as well as grow — with the rest of the
      flow renumbered for the block's current length and the draft's
      parameters merged. The result is written over the last draft; Cancel
      takes everything the recording wrote back out. The recorded lines are
      highlighted while it runs; an edit inside them is overwritten by the
      next draft and warned about once; the file is never saved for the
      author. Over all of it (0.5.154, after an adversarial review): the
      recording never overwrites text it cannot prove it wrote — it knows its
      lines by their text, finds them again after an undo, a revert, a
      reload or a line-ending change, and when it cannot, stops writing into
      the file and inserts the result once at Stop.
    - **A new test** — *Steptix: Record New Test* asks for a name, creates
      `<tests dir>/<name>.md` with a title, `## Config` (`baseUrl` from the
      project), an empty `## Parameters` and `## Steps`, opens it and starts
      recording into it.

12. **Runs and recording don't overlap.** Record is refused while a run is
    executing. If a run is paused at a breakpoint, Record ends that run first
    (the browser stays where it is — Stop never closes the session) and then
    records from that page.

13. **The panel is the live record.** Each action appears as it happens, with
    a ✕ to drop it before Stop, a count in the status bar, and the Stop and
    Add check buttons. Dropped actions are sent with the stop request and
    left out of the model's input.

## Not in the first version

- Code-behind for the recorded steps (the author's choice: Markdown only).
- MCP or CLI recording.
- Inferring loops, decisions or waits. The model is told the time gaps, but
  writes a `Wait until …` only when the author added a check for it.
- Hover menus, right-click, scrolling, Escape and other keyboard shortcuts,
  native dialogs.
- A second browser opened mid-recording, CDP-attached browsers, computer mode.

## Design sketch

- **Page script** `src/browser/scripts/record-steps.js` — capture-phase
  listeners, the element description (decision 5), the secret rule (a fourth
  copy of `isSecretField`, or better, the three existing copies moved into one
  shared script first), pick mode for Add check.
- **Recorder** `src/recorder/step-recorder.ts` — installs the script and the
  binding on the session's context, takes the crops (decision 6), keeps the
  action list, emits `record:action`, and at Stop builds the prompt and parses
  the answer.
- **Prompt** `buildRecordStepsPrompt` in `src/ai/prompts.ts`.
- **Server** — the two routes in `api-server.ts` (SSE via `openSseStream`,
  auth as today), a `recordSteps` method on the session manager that joins the
  session queue and launches the browser when there is none.
- **runner-core** — the new frame types in `protocol.ts` and
  `ApiClient.streamRecordSteps` / `stopRecordSteps`.
- **Steptix** — *Record Steps* (editor title + panel), *Record New Test*
  (command palette + panel), *Add check* and *Stop* while recording, the live
  action list, insertion through the Renumber Steps edit path. Patch bump.

## Tests

- The page script against the fixture app (`fixtures/test-app`): each action
  kind produces one described action; typing produces one action per field;
  a secret field's value never reaches the binding; pick mode swallows the
  click.
- The route through the real HTTP entry: start launches a browser when none
  exists and none otherwise, holds the queue, streams actions, stop returns
  the model's steps, the prompt carries crops and descriptions, secrets are
  absent from the prompt and the stream.
- Steptix unit tests for insertion (region rules, renumbering, one undo
  step) and a fake-server integration test for the panel flow.
- The drafts in the file: every sequence the review reproduced (revert,
  reload, line endings, undo/redo, column-0 typing, indenting, End+Enter,
  rename, window reload) replayed against the pure core with the host's own
  change events, a randomized test that no write ever replaces a character
  the recording did not write, and a host case per sequence (§ The draft in
  the file).
- End to end on the server, with a real browser: start a recording through
  the real HTTP route on the fixture app, drive that page with Playwright
  input (trusted events, as a person's are), stop, and check the prompt and
  the result with a fake model. A Steptix live test cannot click in the
  server's browser, so the extension half is proven with the fake-server
  harness, and the whole loop by a real-model smoke run plus the author
  trying it.

## On the wire

Owned by the server (`src/`) and by runner-core + Steptix on the other side;
both build against this.

**Start** — `POST /sessions/:id/record-steps`, always SSE, `x-api-key` auth as
every route. Body:

```ts
{
  testFilePath: string;            // the session's file; also resolves the project
  config?: { baseUrl?: string; timeout?: number; viewport?: … };
                                   // only when this is the session's FIRST request —
                                   // the same object and rule as the steps route
  target: {
    mode: 'cursor' | 'new';
    fileText: string;              // the document as it stands (for the prompt)
    cursorLine?: number;           // 1-based; mode 'cursor' only
  };
}
```

409 when a run holds the session's queue; 400 on a headless server
(`browser.headed: false`) with the reason.

**Frames** (added to runner-core `protocol.ts`):

```ts
{ type: 'record:started'; url: string; title: string }
{ type: 'record:action'; id: string; kind: 'click' | 'type' | 'select' | 'tick'
    | 'untick' | 'key' | 'upload' | 'navigate' | 'tab' | 'check'
    | 'drag' | 'back' | 'forward' | 'reload';
  action: boolean;                 // true for an ACTION (decision 4), false for an event
  summary: string;                 // one line for the panel, secrets masked
  atMs: number;                    // since record:started
  tab?: string }                   // PageTracker label when not `main`
{ type: 'record:pick'; armed: boolean }   // Add check armed / disarmed
{ type: 'record:drafting'; busy: boolean } // a draft call started / finished (decision 9)
{ type: 'record:draft';            // the draft as it stands — REPLACES the last one
  revision: number;                // increases by one per draft
  steps: string[];                 // step texts, no numbers, in order
  parameters: Array<{ name: string; value: string }>;
  notes?: string[];
  through?: string }               // id of the last action the draft covers
{ type: 'record:writing' }         // Stop received; finishing the draft
{ type: 'record:result';
  steps: string[];                 // step texts, no numbers, in order
  parameters: Array<{ name: string; value: string }>; // value is `$NAME` for a secret
  notes?: string[] }               // anything the author should know
{ type: 'output'; … }              // the existing frame, for warnings
{ type: 'done'; status: 'passed' | 'error' | 'aborted'; error?: string }
```

**Control** — `POST /sessions/:id/record-steps/control`, JSON, answers 202:

```ts
{ action: 'stop'; dropped?: string[] }   // write the steps, leaving these ids out
{ action: 'drop'; id: string }           // leave this action out; redraft now
{ action: 'restore'; id: string }        // put it back; redraft now
{ action: 'check' }                      // arm Add check; the next click is picked
{ action: 'cancel-check' }
{ action: 'cancel' }                     // end without writing anything
```

Closing the stream is `cancel`. 404 when no recording is running.

**Live drafting on the wire** (decision 9): after `record:action` frames, a
`record:drafting` `busy: true`, then a `record:draft` and `record:drafting`
`busy: false`. A draft call that fails is an `output` warning; the previous
draft stands and the next call (or Stop) covers the actions again. At Stop:
`record:writing`, one more call only when the draft does not already cover
every remaining action, then `record:result` — the final draft, with the
server's parameter-conflict renaming applied — and `done`.

**Steptix does the editing:** it numbers `record:result.steps` after the
cursor line (or under `## Steps` of the new file), renumbers the rest, and
adds each parameter it does not already have under `## Parameters` (creating
the section above `## Steps` when there is none) — one edit, one undo. An
existing parameter with the same name is left as it is.

## What the Steptix half decided

Built in `runner-core/` (the frames, `streamRecordSteps`,
`controlRecordSteps`) and `steptix-vscode/` (tb 0.5.152 — main shipped 0.5.151 in PR #160 first; the draft
in the file, below, is tb 0.5.153). The text rules
live in `record-steps-core.ts` and are pinned by `tests/record-steps.test.js`;
the flow is pinned against a fake server by
`tests/integration/suite/record-steps.test.cjs`. Where this differs from
[SPEC-record-steps.md](../docs/specs/SPEC-record-steps.md) it says so.

**Where the cursor may be.** Decision 11's regions, plus three the story left
open. A line that continues a wrapped step counts as that step, and the new
steps go after the continuation, never between the step's two halves. Any
blank line whose nearest non-blank line above is a step counts, not only the
one directly after it (the spec says "directly after"). And the blank line
under `## Steps` or under a `### Section` heading opens that flow: the steps
go in ahead of its first step, numbered from 1. Without that last one an
empty `## Steps` — which is what Record New Test leaves behind after a
Cancel — could never be recorded into. The blank line after the data table
a flow opens with opens that flow the same way (blank lines and HTML
comments may sit between the heading and the table, as the parser allows).
Headings themselves, prose, fences and items under a `####` heading are
refused with the spec's §10 sentence; the last three add a clause saying
why, since those lines look like steps.

**A flow that opens with a data table.** When a flow has no steps yet and
opens with a table, the steps go AFTER the table, with a blank line between:
the parser refuses a table that comes after a step ("the table has to be
the first content under the heading"), so inserting under the heading, as an
empty flow otherwise gets, left a file that no longer parsed. A table that
ends the file, or runs straight into the next heading, gets the blank line
written for it; the steps then get one before that heading too. What counts
as a table is the parser's rule (src/parser/data-rows.ts), mirrored in
`record-steps-core.ts`, not "a line starting with `|`": a line holding an
unescaped `|` with a delimiter row directly under it, rows running on while
each holds an unescaped `|`. So a table written without the outer pipes
(`user | pass` / `--- | ---` / `a | b`) is one — before, its steps went in
ABOVE it and the file no longer parsed, and the blank line after it was
refused — while `a \| b` holds no pipe, and a `| Name | Age |` line with no
delimiter under it is prose: under a step, Markdown and the parser fold it
into that step, so the new steps go after it, not between the two.

**The line recorded from, when the file changed.** The anchor is followed
through the document's own edits while recording, until the first write
fixes the place (see "The draft in the file", below): every `onDidChangeTextDocument` batch moves it by the lines added
or removed above it (`trackAnchorThroughChanges`, pure and pinned). An edit
inside the line — a renumber rewriting `2.` to `3.`, a typo fixed — keeps
it; so does a renamed section, whose new name is read off the document. Text
is only the fallback, for when the track is lost: the line deleted, glued
onto the line above (Backspace at its start), or the document closed. Then
it is the one line in the same flow with the anchor's original text, never
"whatever is at the old line number" — after lines were added above, that is
a different step, and with identical steps (`1. Click Next` twice) the text
alone picked the wrong one. When neither finds it, the steps go at the end
of the flow the anchor was in — the main flow, or that section when it still
exists — and a warning says so. This is not the spec's literal "end of
`## Steps`": the end of the `## Steps` span is after the last section's
body, where main-flow steps would silently become part of that section.

**Numbering.** The new steps continue from the anchor step's number as
written, and only the rest of that one flow is renumbered, by Renumber
Steps' own walk. A flow numbered `1.` on every step (two or more) keeps its
style: the new steps are `1.` too and nothing is renumbered — before, a
`1. A` / `1. B` / `1. C` list came out `1. A` / `1. B` / `2. New` / `3. C`.
One `1.` step is not a style, and continues as `2.`. Step texts are
flattened to one line and a stray leading `3. ` is stripped.

**Parameters.** The section is found the way the SERVER's parser finds it
(src/parser/markdown.ts), not runner-core's looser meta scan: a depth-2
`## Parameters` heading outside frontmatter and fenced blocks — a `##
Parameters` in a fenced example, or a `### Parameters`, is not it — running
to the next depth-1 or depth-2 heading (a `###` inside does not end it). An
existing parameter is any list item in it — `-`, `*`, `+` or numbered — of
the form `name: value`, across every such section, the last of a repeated
name winning, as the parser reads them. New lines go after the first
section's last item (after its last non-blank line when there is none); a
created section is always `## Parameters`, the only depth the parser reads.
Values are written exactly as recorded — internal whitespace kept — bar the
whitespace at their ends, which the parser trims anyway. A value with a line
break cannot be one parameter line, so it is left out with a warning that
names it; escaping it would write a value the parser reads back differently.
A name that is not a valid parameter name, or a value that is empty, is left
out with a warning. The conflict warning is the spec's sentence and names no
value. One addition: a `$NAME` parameter whose variable the resolved `.env`
does not define gets a warning at insertion, since the next Run would fail
on it.

**A result is never lost.** One the plan cannot place (`## Steps` deleted
before anything was written), one whose edit is rejected three times, and
one whose file was closed while recording (renamed, deleted, or closed by
the author) is written, numbered, with its parameters above it, to the
Steptix output, and any draft still in the file is taken out; the error notification offers
**Copy steps** (to the clipboard) and **Show output**. A result with no
steps — nothing recorded, or every action dropped — is an information
message carrying the server's note, not an error.

**Notifications are plain text.** Notes the model wrote, parameter names it
chose and the server's errors can all carry page text, and a VS Code
notification turns `[text](target)` into a link — `command:` targets
included. Every notification Record Steps raises breaks that one pattern up
(`] (`), words unchanged. The panel's log renders text as text and is left
as it came.

**One recording per window.** The Recording block and the status bar item
are window-wide and show whichever file is active: the author is clicking in
a browser, not reading an editor. Only the recorded test's session is held —
runs of other tests are unaffected. The recorded test refuses a Run three
ways: the Run buttons are hidden in the title bar and disabled in the panel,
and the run controller itself refuses (it would otherwise close the session
under the recording on its first-use stale-session clear). **Steptix: Stop
Run** — the palette entry, Shift+F5, the panel's run Stop — means Stop
Recording while the active test records: the steps are written. The run
teardown it otherwise does aborts the recording's stream, which the server
reads as a cancel, so the recording was silently thrown away.

**The session.** A recording goes through the run's own plumbing: the same
env resolution and server check (auto-start included), the same first-use
close of a session another window left keyed on this path, and the same
write-once `config` bookkeeping — sent when the session has not had it,
marked sent when the start request answers 200 (runner-core's
`streamRecordSteps` takes an `onOpen` for it). Not on the first frame: the
server creates the session before the stream opens, so a Cancel while the
browser is still launching left the session holding `config` and the client
believing it had none — the next Run re-sent it into the server's 400. A
request that carried `config` and never got its 200 (cancelled before the
answer, a transport failure, a refusal) leaves it unknown whether the
session exists with it, so the first-use close is re-armed: the next Run or
recording closes whatever is there and sends `config` to a session it knows
is new. A recording the server ends because the session was closed under it
(`done` `aborted` with `error`) forgets the sent `config` too — that session
is gone. The viewport recycle a fresh Run performs is not done: a recording
means "continue from this page", and recycling would close it.

**Paused runs.** Both kinds are ended: a breakpoint pause (no stream open)
and a step pause (the server holds the stream). Only the recorded test's
run is touched — its controller stopped and reset, the spinners on the
files it painted (the test and any skill file it descended into), its own
pause marker and its own step-paused ▶. Not the Stop command's teardown,
which is window-wide: it flips every spinner in the window and clears every
test's step-paused marker. For a step pause the client waits for the run to
unwind, then retries a 409 for about ten seconds while the server lets go of
the queue.

**Beyond the wire block.** The start body also carries `env` (the resolved
`.env`, as the steps route's does — a recording can be the request that
creates the session, and a session's model client is built from it) and
`envName`. `target.cursorLine` is the anchor's line — the step the steps go
after, or the heading of a flow they open — not the raw cursor position.

**The live draft in the panel** (decision 9, as changed). Under the action
list, a **Steps so far** list shows the latest `record:draft` whole, numbered
1..n within the draft. Each draft replaces the list rather than merging into
it, because the model may have rewritten its last steps; a draft whose
`revision` is not newer than the one shown is ignored, so a late frame cannot
put an older list back. Draft texts are cleaned the way the result's are. The
draft's parameter names show on one line under it (names only), and its
`notes` under that. `record:drafting` puts an **updating…** marker (a spinner)
beside the heading; before the first draft the list reads "Writing the first
steps…" while a call runs, and "The steps appear here a moment after each
action" otherwise. After Stop the block reads **Finishing…** (it replaces
"Writing steps…"), and the status bar item reads "Finishing…" with a spinner
instead of `● Recording — N actions`. N counts actions in decision 4's
sense (a frame's `action` flag; an absent flag reads as an action) that were
not dropped; an event that rides with the next action (typing, selecting,
ticking) is listed with a hollow `○` rather than `●`. The frame folding is the pure
`applyRecordFrame` in `record-steps-core.ts`, pinned by the unit suite. The
same draft goes into the file (next).

**The draft in the file** (decision 11, as changed at the author's request,
2026-09-27; tb 0.5.153, made fail-safe in 0.5.154). Every `record:draft`
that is newer than the one written goes into the file as it arrives; drafts
that arrive while a write is in flight coalesce into one write of the latest.
The first write fixes the place: it plans against the document as it is then,
with the tracked anchor, and keeps that text as the recording's BASE together
with three kinds of slot — the block's insertion point, the parameters'
insertion point, and the number of every later step of the flow, with the
number each had (`beginLiveRecord`). Every write after that is the same
`planRecordInsertion` run against the base with the new draft, its pieces
written into the slots (`liveRecordWrite`) — so what a draft writes is a pure
function of the base and the draft, the file after drafts 1…n reads as draft
n alone would have made it, and the EMPTY draft writes back exactly what the
base had. The recording's own writes are told apart by the text they leave,
which the change event is compared against. The result is the last write
through the same path; Cancel, a `done` error or abort, a result with no
steps, and a rescue each write the empty draft.

**Never overwrite what it cannot prove it wrote** (tb 0.5.154). An
adversarial review of 0.5.153 in a real 1.95 host found the slots, which were
offsets and nothing else, following edits they could not follow: File:
Revert arrives as one line diff reaching from the parameters through the
recorded steps, the slot widened over it, and the next draft deleted `## Steps`
and the main flow; LF→CRLF arrives as one change over the whole document and
the file became just the recorded steps; Ctrl+Z then Ctrl+Y duplicated the
steps (undo and redo were taken for the author's edits, `e.reason` unread);
typing at column 0 of a later step went into its number's slot and was
deleted by the next write; a rename was taken for a close and the renamed
buffer kept the draft; a window reload left the draft with no way to take it
out; End+Enter on the last recorded line was counted inside the block; and
Ctrl+Z warned about an edit nobody made. So the recording now identifies its
text by CONTENT, and offsets are only the fast path:

- *What it keeps.* Each slot carries what was written in it (`wrote`); a
  later step carries the number the recording gave it and the rest of its
  line. `LiveRecord.history` keeps the state after every earlier write —
  base, anchor, flow and slots — because an undo can bring any of them back.
- *Before every write* (`locateLiveRecord`), the text is checked. Fast path —
  nothing since the last write the offsets could not follow: every region
  reads what was written there (or was edited only inside, and warned), at a
  line boundary, and every later step's line starts with exactly the number
  written. Otherwise the text is looked for: the last write's, then each
  earlier one's, newest first, each with its own base — the block as a run of
  whole lines exactly once and below the anchor, the parameter lines exactly
  once, and NOTHING of any write's lines left outside the match (without
  that, an undo that restored an edited longer block let an earlier, shorter
  draft match its first lines, and the next write left the rest behind — the
  randomized test found it). Found: carry on from there. Not one line of any
  write left (counted against each state's base): `absent`, and a draft goes
  in afresh at the anchor — which must be found, where it was followed to or
  by its text (`beginLiveRecord(…, { strict: true })`). Anything else: `lost`.
- *Which events cannot be followed* (`followLiveRecord`, what the change
  listener calls): an undo or redo (`e.reason`), the change that leaves the
  document clean without the recording having saved it (a revert, a reload
  from disk — `!e.document.isDirty` at the event, which the extension host
  updates before it fires), and in `trackRecordSlots` any change that
  reaches ACROSS a slot's edge, including one replacing a whole slot exactly.
  For those the text is looked for at once, so the highlight is right; what
  is not found then is looked for again at the next write, and nothing is
  highlighted meanwhile. Only an edit wholly inside warns — not an undo, redo
  or revert (finding 8).
- *Line endings.* A record whose base's line breaks differ from the
  document's is converted — base, written texts, every history state — and
  looked for by text; the next draft is planned against the converted base
  and goes in with the file's line endings. Offsets are not mapped through
  the conversion: a block edited inside before a line-ending change is
  therefore `lost`, the safe way.
- *Edited inside, then an unfollowable change*: only the last write, exactly
  as written, is taken (the author undid their edit); never an earlier one,
  and never `absent` — an edited block cannot be proved gone.
- *Later steps.* Any change touching a later step's line start or number
  unplaces it (`placed: false`) rather than dropping it: at every write it is
  looked for by its whole line, exactly once, in the flow below the block,
  and renumbered only when found — so text typed at its column 0 followed by
  Enter leaves it renumbered and restored by Cancel, while text typed in
  front of it on the same line, or an indent, leaves the line the author's
  for good. The rest of the line after the number is the author's to edit and
  is re-read at every write. (The spec's first wording had the line checked
  "exactly" including that rest; checking the number prefix exactly and
  re-reading the rest keeps a step the author retitles while recording in the
  renumbering, which the existing suite pins.)
- *Edges.* A line break inserted just before the block's final line break
  (End, Enter on the last recorded line), or at the end of a block that ends
  the file, is outside: the slot's text is unchanged up to its end and the new
  line is the author's, below it.
- *`lost`* stops the live writing for the rest of the recording
  (`StepRecorder.detach`): the warning is shown once, the panel keeps
  drafting, the highlight comes off, nothing more is written. Stop looks once
  more (the final write with the record uncertain) and otherwise inserts the
  result once at the anchor into the file as it is (`insertOnce` — the
  pre-0.5.153 insertion, its own undo step), leaving what remains of the
  drafts for the author; Cancel takes out nothing it cannot find and says so
  in the panel's log.
- *Rename.* `onWillRenameFiles` notes where the file is going, so the old
  document closing is not taken for a close; `onDidRenameFiles` (or the next
  write, whichever comes first) switches the recording to the document VS
  Code opened under the new name with the same unsaved text, and the record
  is looked for there by text. A document that cannot be opened there is a
  closed one: rescued at the end.
- *Reload.* After every draft write the record's text (`unfinishedRecordingOf`:
  block, parameter lines, renumbered steps with their numbers and the rest of
  their lines) is kept in `workspaceState` with the file's URI (moved along
  on a rename), and forgotten when the recording ends — unless the edit that
  takes the draft out was tried and did not go through (`keepUnfinished`: the
  window went first). `deactivate` cancels the
  recording and waits up to 1.5 s for its draft to be taken out
  (`StepRecorder.shutdown`); on a window reload hot exit has usually backed
  the buffer up by then, so at the next activation a kept record whose block
  and parameter lines are in that file exactly once is offered for removal —
  "Remove the unfinished recording's steps" (the verified empty draft,
  `removeUnfinishedRecording`) or "Keep them" — and forgotten either way.
  Author edits to a renumbered step's text after the last draft make that
  step's line not match, so its number is not given back; the rest still is.

Where that differs from what the one-shot insertion did, or from the spec's
first wording:

- *The base is fixed at the first write* — and again whenever nothing of the
  recording is left in the file and it starts afresh at the anchor. A step
  the author adds to the flow after the insertion point while recording is
  not renumbered, and a parameter line they add by hand is not seen as
  existing — the one-shot insertion, which planned against the document at
  the end, did both. What they wrote stays; Renumber Steps catches the
  numbering.
- *An edit wholly inside the recorded lines* — the block or the parameter
  lines, with some recorded text left on either side — is taken into the slot
  and overwritten by the next draft, and warned about once per recording, as
  a notification and in the panel's log: "Lines being recorded are rewritten
  as the model updates them — edit them after Stop." At a slot's edge an
  insertion is outside when it cannot be part of it: whole lines typed at the
  block's first line go above it, typing at the start of the line after it is
  that line's, and End, Enter on its last line starts the author's line below
  it. Reverting the file while recording is not an edit inside it (0.5.153
  warned about it and then wrote over the file).
- *A file in no visible editor* still gets the draft, as a WorkspaceEdit —
  the only way to edit a document without an editor, and always an undo step
  of its own (the document's editor, when one is visible in any group, is
  used otherwise, since only it can join an open undo step). Stop shows the
  file first, as the insertion always did, and writes through its editor.
- *A file closed while recording* is not written again, and the result is
  rescued (output + Copy steps) rather than reopened and inserted — the
  first build reopened it. Closing it with "Save" leaves the last draft saved
  in the file; nothing can take it back out then. A file RENAMED while
  recording is followed instead (0.5.154).
- *Highlight*: every recorded line (steps and parameter lines, not the blank
  lines a block carries for spacing) gets a whole-line decoration in the
  theme's own diff colours — `diffEditor.insertedLineBackground`, a 2px bar
  of `editorGutter.addedBackground` at the left, and a mark in the overview
  ruler — on every editor showing the file, until the recording ends, and
  only while the recorded lines are known to be where they are. The editor
  follows the block's last line as it grows only when the author was looking
  at the block; one who scrolled away is left there.

**Tests for the fail-safe rule** (0.5.154). `tests/record-steps-live.test.js`
replays every review sequence against the pure core with the change events
the host logged for it (a `Session` drives the core as `step-recorder.ts`
does), plus the undo-to-an-earlier-draft, undo-past-a-revert, found-twice and
found-in-part cases, the unfinished-recording removal, and a randomized test:
400 seeds of 40 operations (drafts, insertions, deletions, replacements,
undos and redos as line diffs, reverts, line-ending toggles) over five
fixtures, with every character tagged by who wrote it — no write may replace
a character the recording did not write except an author's typing inside its
lines or a step's leading number, and Cancel must leave no whole line of the
recording's behind unless it stopped writing. The file imports the core as a
namespace so each case can run against an older core: all 17 fail on
0.5.153's. The integration suite adds a host case per finding — revert, a
reload from disk after a save, LF→CRLF, undo+redo, undo then Stop and one
Ctrl+Z, column-0 typing, Tab, End+Enter, rename then Stop, rename then
Cancel, shutdown and recovery — all 11 failing on 0.5.153's sources, and two
for the stop-writing fallback (Stop inserts once at the anchor, one Ctrl+Z
takes that out; Cancel takes nothing out).

**Undo, measured** (the integration harness, VS Code 1.95). Each draft goes
in through the document's editor with `undoStopBefore` true for the first
write and false after, and `undoStopAfter` false; the result closes the step
(`undoStopAfter: true` — with an edit that rewrites the block as it is when
the result says nothing new, since an empty edit never reaches VS Code and
so carries no undo stop). With nothing else touching the file, three drafts
and the result are ONE undo step: one Ctrl+Z restores the file byte for byte
and clears its unsaved mark — with the cursor sitting exactly where the steps
go in, too. That grouping does not survive everything, though. Measured with
plain `editor.edit` calls (an open step, something in between, two more
edits joining it): VS Code closes the open step when the author types in the
file, moves the cursor with `cursorDown`, or saves; a selection set through
the API does not close it, and neither does showing another file and coming
back. Measured with the recorder written as above, the one-undo promise then
broke — one Ctrl+Z left a draft on screen:

- the author typed in the file between drafts: three steps — undo 1 back to
  draft 1 with the typing, undo 2 took the typing, undo 3 the draft;
- the author moved the cursor in it (a selection set, then `cursorDown`):
  two steps, undo 1 back to draft 1;
- an author's edit made through the API between drafts: three steps, undo 1
  back to draft 1 with the author's line;
- a draft written while the file was in no visible editor (the
  WorkspaceEdit): three steps, undo 1 back to that draft, undo 2 to draft 1.

So the recorder notes when anything may have closed its step since its first
write (`split`: a change event that is not its own, a selection change that
carries a kind, a save, a WorkspaceEdit draft), and then writes the result as
TWO steps: the empty draft first, closing whatever step is open, then the
result as a step of its own. The state one Ctrl+Z returns to is then the file
without the recording, the author's own edits kept — measured for the four
cases above, for `cursorDown` alone, for a save between drafts, and for a
selection set through the API alone. That last one is a false alarm: VS Code
reports an API selection change with a kind (as a command's), so it counts,
though it does not close the step. A split costs two things, false alarm or
not: the file stays marked unsaved after that undo even when it now matches
the disk, and undoing further walks back through the drafts (undo 2 brings
the last draft back). Counting every selection change with a kind keeps the
costly mistake — a real break missed, a stale draft left by one Ctrl+Z — out
of reach. An auto-save setting that saves while recording is a save like any
other. After Cancel the file reads as before but stays marked unsaved; the
drafts and their removal compress to an undo step that changes nothing
(measured: the next Ctrl+Z changed nothing, and the document's version did
not move).

Re-measured on 0.5.154, where the fail-safe rule changed what a write finds
before it writes but not how it writes: with nothing else touching the file,
one Ctrl+Z still restores it byte for byte and clears the unsaved mark; after
typing, `cursorDown` or a draft into a hidden file, one Ctrl+Z still lands on
the file without the recording. New cases, all measured in the harness: an
undo DURING the recording is a change that is not the recording's own, so it
splits — the next draft goes in as a new step, and one Ctrl+Z after Stop
lands on the file without the recording. Stop, Ctrl+Z (file byte for byte,
clean), Ctrl+Y, then a second recording in the same file: one Ctrl+Z takes
out only the second, a second Ctrl+Z the first. Cancel, then record again and
Stop: one Ctrl+Z takes that recording out, and the next one changes nothing.
When the recording gave up on its file (§7.4) the result is one insertion at
the anchor, its own undo step: one Ctrl+Z takes out exactly that insertion
and leaves what remained of the drafts — which one Ctrl+Z never promised to
reach, since those lines could not be proved to be the recording's. Not
measured: undo after a rename, and after a line-ending change.

**Controls.** Stop before `record:started` is a cancel. The ✕ on an action is
shown at once and sent at once as `drop` (or `restore` when put back), so the
server redrafts without it. Stop still sends the whole `dropped` list, which
the server unions with those, so a drop the server could not take (a 404, or
a transport failure: a warning goes in the panel's log and the row stays
struck through) still counts at Stop. `dropped` is sent only when something
was dropped. From Finishing… on the rows are frozen, since after Stop only
`cancel` does anything server-side. Cancel sends `cancel` and then closes the
stream, and a result that races it in is thrown away. The server's
`done.error` and a 400's reason (the headless refusal) are shown as they
came; a 404 on the start route says the server predates Record Steps;
transport failures get the run's STXxxx payloads. A recording the server ends
itself — `done` `aborted` with an `error`, which it sends when the session
is closed under the recording (another window's Run, Close Session, the
idle reaper) — shows that sentence, "The session was closed while
recording.", as a warning, instead of "Recording cancelled — nothing was
written.": the author did not cancel.

**Record New Test.** The name is a plain file name (`.md` optional, no
folders, no reserved device names). The title is title case with short
joining words kept lower-case in the middle (`pay-by-cash` → `Pay by Cash`),
per the spec — the story's example shows `Pay by cash`. The folder is
`tests.dir` from the nearest `steptix.config.json` above the active editor,
inside the workspace folder (never above it — a config outside is another
project's); a config that declares no `tests.dir` means the server's
default, `./tests` beside it (src/config/defaults.ts) — not the glob's
prefix, which would put the test where the server does not look. When the
active editor leads to no config — none open, or one in no project — the
workspace folder is searched (`findProjectConfigs`: three levels down,
breadth first, skipping `node_modules`, `dist` and every dot-folder, so
`.git`, `.vscode-test`, `.live-shards` and a worktree under `.claude/` are
never read). Walking up alone missed a workspace whose project sits in a
subfolder: with no editor inside it, the test was created at the workspace
root, outside the project. One config found is the project; several, and a
QuickPick asks which, labelled by folder, before the name prompt (which then
names the folder the file goes in); Escape there creates nothing. With no
config at all, the fixed start of `steptix.testsGlob`
(`tests/**/*.md` → `tests/`); else the workspace folder. A `tests.dir` outside the workspace is refused, before
anything is created, naming where it points: Steptix could neither find
nor record a test there. The project has no `baseUrl` setting, so it is the active
test's own when that test is in the same folder, else the most common one
among the tests in that folder, written raw (`$APP_URL` stays a reference);
with none, `## Config` is written empty. The file is created with `wx`, so it
is never overwritten. Skill files are refused: a skill has no browser of its
own to record in.

**Where things are.** Title bar: Record (`navigation@10`, on a test that is
idle or paused); while recording, Add Check and Stop Recording at the front.
Palette: all five commands, gated on the context key. Panel: `● Record` and
`New test…` in the toolbar, `● Record new test` on the no-test view, and the
Recording block. The result is written over the last draft through the
document's editor (re-planned against the live text if a keystroke lands in
between), the recorded steps are selected, and the file is left unsaved.

## What the server half decided

Built in `src/` — the page script `src/browser/scripts/record-steps.js`, the
recorder, the run and the draft engine in `src/recorder/`,
`buildRecordStepsPrompt` in `src/ai/prompts.ts`, the two routes in
`src/server/api-server.ts` and `beginRecordSteps` / `controlRecordSteps` on the
session manager. Pinned by
`tests/record-steps-recorder.test.ts` (the page script and the recorder in a
real Chromium), `tests/api-server-record-steps.test.ts` (the routes through
the real HTTP entry, with a real browser the server launches itself),
`tests/record-steps-prompt.test.ts` and `tests/secret-field-parity.test.ts`.
Where this differs from [SPEC-record-steps.md](../docs/specs/SPEC-record-steps.md)
it says so.

**A steps request during a recording is refused, not queued.** `POST
/sessions/:id/steps` answers 409 ("A Record Steps recording is running in
session … Stop or cancel it before running steps in this session."). A run that
waited behind a recording would sit on an open stream with nothing on it for
as long as the author keeps clicking, and then run in a browser the author has
moved on from. The recording still joins the session's queue, so anything
in-process waits behind it.

**What "a run holds the queue" means.** Any steps batch queued or executing on
the session, counted from the moment it joins the queue — so a step-mode pause
parked inside a batch holds it, and a Steptix breakpoint pause (the batch
already ended) does not. The 409 reads "Stop the run before recording: a run is
executing in this session." (§10's sentence). A second recording on the same
session is a 409 too.

**No model is a 400, decided before anything is created or launched** (spec §8
left the code open). The same class of answer as headless: configuration the
author has to change, not a moment to retry. The question is asked of the
config the call would use — the request's `env` over the server base with the
session's `runSettings.model` override when the request brings `env`, else the
session's client as its last batch left it. §10's sentence, word for word.

**Headless is a 400 with §10's sentence; a CDP-attached session is a 400 too**
(a browser someone else started is "Not in the first version"). Headless is
also asked of the BROWSER, not only the server: `openBrowser` can open a
headless one on a headed server, and the recording follows the session's
active browser, which would then record where nobody can see. A session whose
active browser is headless is a 400 ("…this session's active browser was
opened headless (headed: false)…"); a browser the recording launches itself
is checked again once it is up, and one that came up headless ends the stream
with `done: error` before `record:started`.

**Live drafting** (`src/recorder/draft-engine.ts`). Every call is a draft
call: the draft so far (steps indexed from 0, and its parameters), only the
actions it does not cover yet, and the file context; the answer is `{
replaceFrom, steps, parameters, notes? }`. One prompt serves both shapes — a
full redraft is a draft call over an empty draft.

- *When.* Only an ACTION starts a call (decision 4: click, drag, Enter, Tab,
  Back, Forward, Refresh, a typed address, a check) — once 600 ms pass with no
  new action (the settle window). Every other event (typing, a choice, a tick,
  files, a tab) is kept and goes with the next action's call, or Stop's.
  Actions that arrive while a call runs wait for it and go together in the
  next one, again after the settle window from the last of them; events that
  arrive during a call wait for the next action, as they would have without the
  call. There is never more than one call in flight per recording: every call
  goes through one method that refuses to start a second.
- *What it covers.* An incremental call covers every remaining action the
  draft does not, in order — so what the draft covers is always a prefix of the
  remaining actions, and `record:draft.through` is the last of it.
- *`replaceFrom`.* Must be between `draft.length − 3` and `draft.length`; on an
  empty draft it is taken as 0 whatever it says. Out of range, missing or not a
  whole number, the answer is refused (a log line, nothing in the panel) and
  the same busy period retries ONCE as a full redraft over every remaining
  action. A full redraft's `replaceFrom` is ignored: there is nothing before 0.
- *A failed call* (the model errors, answers something unreadable, or its
  retry fails) is an `output` warning — "The draft could not be updated:
  <reason>. The steps so far stand; the next update covers those actions
  again." — and the draft stands. The engine does not retry on its own: the next
  ACTION starts the next call (an action that arrived during the failed call
  counts), or Stop does.
- *`drop` / `restore`.* A drop of an action the draft covers, or that the call
  in flight was asked about, makes the next call a full redraft and aborts the
  call in flight; its answer is thrown away by a generation counter even if it
  arrives, so no draft that includes a dropped action is ever emitted. A drop
  of an action nothing has seen yet just leaves it out of the next call. A
  restore redrafts in full when the draft (or the call in flight) already
  reaches past the restored action, and otherwise lets the next incremental
  call pick it up. Both start "now" — no settle wait. Dropping every action
  leaves an empty draft, emitted without a model call.
- *Frames.* `record:drafting` `busy: true` / `false` bracket every call,
  retry included; `record:draft` carries `revision` (+1 per draft),
  `steps`, `parameters`, `notes` and `through`. Each draft already has the
  parameter-conflict renaming applied, so the panel shows what will be
  inserted.
- *Stop.* Nothing new is scheduled; late typing is collected (its
  `record:action` goes out); the Stop's `dropped` joins the live drops; then
  `record:writing`. If a call is in flight at that moment the panel gets its
  `busy: false` first, and from `record:writing` on no drafting frames or
  draft warnings are sent — the finish reads "Finishing…", not "updating…".
  The call in flight completes (its answer is used), and ONE more call is made
  only when the draft does not cover every remaining action or a Stop drop
  touched it (then it is a full redraft). That call's failure ends the
  recording with §10's error and nothing inserted.
- *Cancel* or the stream closing abandons the call in flight (its abort signal
  fires) and makes no further calls; no frame about drafting follows. Cancel
  wins at ANY point before `record:result` goes out — after Stop too, while
  the final draft is being written: the call is aborted, no result is sent,
  and `done` is `aborted`. Before this round a Cancel after Stop was answered
  `accepted` and then ignored: the final draft still came back as a result.
- *A closed session* — DELETE, another window's first-use DELETE, the idle
  reaper, shutdown — goes the same way at any point, and its `done` says why:
  `{ status: 'aborted', error: 'The session was closed while recording.' }`
  (`RECORD_STEPS_SESSION_CLOSED_MESSAGE`; the client shows it word for word).
- *`done` is the last frame.* Whatever is still settling behind it — a crop
  being taken, a pick waiting in the recorder's chain, a warning logged
  elsewhere — is dropped by the run, and the recorder's own late work
  (cancelled) records nothing and moves no tab.
- *Images.* Each call sends the crops of the actions it covers — a full
  redraft all remaining ones — within the recording's 40. A model that rejects
  images is asked again without them within the same call; after the first
  rejection the recording stops sending images at all (one warning), rather
  than paying a failed call per action.

**The AI switch.** Every draft call uses the session's client, with the
policy veil lifted for that call and put back exactly as it was found — not
lowered for good: the veil is the last batch's statement about the session,
and the next batch re-decides it anyway. A log line says so when the veil was
up. Calls use the `authoring` profile.

**Back, Forward, Refresh, and a typed address.** On Chromium each page gets
its own CDP session. After every main-frame move — a new document
(`Page.frameNavigated`) or a same-document one (`Page.navigatedWithinDocument`,
which is how a `pushState` Back arrives) — the recorder reads the tab's own
navigation history (`Page.getNavigationHistory`) and compares it with the
reading before: the index moved to an entry that existed with the same id →
`back` (index down) or `forward` (index up); same index, same id → `reload`;
anything else is a new navigation (`classifyHistoryMove`). A traversal or
reload is the author's unless the page asked for it
(`Page.frameRequestedNavigation`) or it came within 1 second of a touch —
`history.back()` or `location.reload()` in a click handler lands that fast, a
person who clicks a link and then presses Back does not, and that common case
must not be swallowed (so this window is shorter than the typed one). A new
navigation is recorded as `navigate` only when no page request preceded it AND
the author did not touch the page in the previous 3 seconds (a pointer-down, a
first keystroke, a pick, or any action other than a finished field of typing —
typing is reported on focus-out, which is exactly what clicking into the
address bar causes). Not recorded: a non-web address (`about:blank`, the
new-tab page), a popup's own first load when the tab opened within 3 seconds of
a touch (it is part of that click), and `pushState`/`#hash` moves (the page's
own doing). A same-document commit at the same history entry is
`history.replaceState` — the page rewriting its own address, however long
after a click — and never `reload`: the Reload button always makes a new
document. The tests drive Back/Forward/Refresh with `page.goBack()` /
`goForward()` / `reload()`: over CDP those are the same browser-initiated
navigations the toolbar makes, so what the recorder reads is identical.

A page's request is not believed forever. One that never commits — a link to
a 204, a download, an aborted navigation — would otherwise stand until the
next new document, and the author's next Back, Reload or typed address would
be taken for the page's. It ends when its load stops without a commit
(`frameStartedLoading` after the request, then `frameStoppedLoading`); when a
navigation starts that is not the one requested (`Page.frameStartedNavigating`
at another address: the page's own request is always followed at once by ITS
start, so any other is the browser's — the author's Reload or Back cutting a
slow one short, measured on Chromium 147 with no stop-loading between them);
when a same-document commit lands on the address it asked for; and after 30
seconds regardless (a slow form post can take that long, and the
typed-navigation window still guards what is left).

Firefox and WebKit have no CDP to ask, so the page script's hints stand in:
the new top document's `performance` navigation type (`reload`,
`back_forward`), `popstate`, and a back/forward-cache `pageshow`. Those cannot
tell Back from Forward, so there a traversal is recorded as `back`. The
typed-navigation check waits 500 ms for a hint, so a traversal is not also
called `navigate`; a document that was already open when Record was pressed
(its hint describes how IT arrived) is ignored.

**Tabs.** A new tab is a `tab` event (`opened`) carrying its label, title and
URL; acting in a different tab is a `tab` event (`moved`), except in a tab
that opened since the last action — the `opened` one already says it. The
session's active tab follows the author, so a Run after the recording
continues where they left off.

**Control answers 202 or 404 only**, as §9.3 says. After Stop, only `cancel`
still does something — until `record:result` is out it abandons the model
call, no result is sent and the stream ends `aborted`; a second `stop` or a check is answered 202 with an `ignored` reason
and changes nothing. A `drop` of an id the recording does not have (or one
already dropped), or a `restore` of one that is not dropped, is also 202 with
`ignored` — not a 404, which a client would read as "no recording is running".
A body that is none of the six, or a `drop`/`restore` with no `id`, is a 400.

**Typing still open at Stop arrives after Stop.** The page returns any field
still being typed into when the server asks for it at Stop, and those
`record:action` frames are sent before `record:writing`. They cannot be in
`dropped` — the client could not have seen them — so a client should accept
action frames until `record:writing`.

**What is recorded, and what is an action.** Every `record:action` frame
carries `action: true|false` (`ACTION_KINDS` in `src/recorder/types.ts`). Only
TRUSTED pointer, click and key events are recorded — what the author did, not
a page script's `input.click()` or a re-fired click. A click into a text field
is a click action with `focusOnly`, which the model drops when typing into that
field follows. A click on a checkbox, a radio, a label for one, a `<select>`,
an option or a file input is a click ACTION like any other ("ticking a box and
opening a list are clicks", spec §4); what it did follows as an EVENT —
`tick`/`untick` (with `viaLabel` when the label was clicked), `select` with the
option text, `upload` with the file names — and rides with it. The click a
browser passes from a label to its control is not a second action — a
checkbox's, a button's, and a hidden file input's behind a styled "Upload"
label alike (that one used to record two clicks). Only that click: the label
is forgotten on the next task, so a later click on the control — Tab to it and
Enter, with no pointer-down between — is the author's own (it used to be
swallowed for as long as the label's pointer-down was the last one, so a
second, keyboard save was lost). A custom
`role=checkbox` or `switch` click is a click action, followed by a
`tick`/`untick` event read from its `aria-checked` after the page's handler
ran. The click a browser makes on a form's submit button when Enter is pressed
in its field is folded into that `key` action. Enter and Tab are the only keys
recorded (Escape no longer is); Enter on a button or link is its click; Enter
in a textarea is typing (kept deliberately — so a TEXTAREA composer that sends
on Enter and empties itself still records neither the message nor the key,
before this round and after; the effect rule below would cover it if
extended). Enter in a contenteditable is decided by its EFFECT,
because the key cannot tell a document editor from a chat composer: once it
settles (100 ms, or at the author's next key, pointer-down, change, focus-out
or submit, or at Stop's flush — whichever is first; a page that empties the
box in a microtask or a re-render has done so by then), a box that gained a
line or a block (`br`, `div`, `p`, `li` …) and was not emptied is typing; one
that was emptied, removed, or left as it was is the typing so far — reported
with the text it held BEFORE the Enter — then a `key` Enter action. Treating
every contenteditable Enter as typing (the previous round) lost a chat
message and its Enter together: the box ended as it began, so the typing
reported nothing. A choice made without pointing
(the keyboard, a script) first reports any field still being typed into, so
the order is what happened — and so does an Add check pick, whose swallowed
click moves no focus: the typing comes before the check.

**Shadow DOM.** Targets are read through `composedPath()`, so an event from
inside an OPEN shadow root is described by the element it happened on, not its
host. `change` and `submit` do not cross a shadow boundary at all, so each
open root the author touches (a pointer-down, a focus, an input) gets its own
listeners — and its own `type` watch for the secret memory. A CLOSED root
cannot be observed from outside: its events arrive retargeted to the host, so
typing or choosing inside one is not recorded (spec §4, "Not captured"), and
nothing typed there reaches the binding either.

**Drag.** A pointer pressed on one element, moved more than 8 CSS pixels and
released on another is one `drag` action carrying the element dragged
(`target`) and the element dropped on (`dropTarget`, what is under the pointer
at release, or its actionable ancestor); an HTML drag-and-drop is the same
action, from `dragstart` to `drop` (a drag with no drop moved nothing). A
release on the same element (or inside it) is not a drag. A press-move-release
that leaves text selected is text selection, not a drag — unless the element
looks meant to be moved (`draggable`, or a `grab`/`move` cursor); real
sortables stop the selection themselves (`user-select: none`), so this only
decides the ambiguous case. A press in a text field that moves is selecting
the field's own text — which `getSelection()` does not report — and is not a
drag either, wherever it is released; the click it ends with (on the common
ancestor) is a click into the field, `focusOnly`. The click a browser fires after a pointer drag is
part of the drag. A drag has TWO crops: at the press, around what was
dragged, and at the drop, around where it landed; both count toward the 40,
and the model is shown both, the second introduced as "where it was dropped".

**Crops.** Taken at pointer-down for anything but a text field, and at the
first keystroke (or first `input`) into a text field. A field the recorder
calls secret while it shows its value in clear (a `type="text"` token box, a
password box its eye has flipped) gets no crop of its own — nor does an Add
check picked on one. Every OTHER crop has the secrets painted out before it
is kept (spec §4.2): the page script reports (`fieldRects`), across every frame
and every open shadow root the author touched, where every secret field is and
every element whose text shows a secret typed on that page (the deepest
element holding each occurrence, so `<b>hun</b>ter2` is found in its parent),
plus every other field's value and — only when the run knows secrets to look
for — every run of text on screen with its box. The server paints over the
secret ones and any field or text run that holds a secret it knows (3
characters or longer; the comparison is on the server, so the known secrets
never go into the page — the request's `.env` includes keys, such as the AI
gateway's, that a page script hooking `String.prototype` could otherwise
read), with a solid fill 3 px wider than the box, on the whole screenshot.
A known secret split across elements in the page's own markup is not found by
the text runs (each is one text node); the typed-secret scan does find those.
Inside a frame, boxes are offset by the frame element's CONTENT box — its
border box moved in by its border and padding (the border box alone missed a
field in a bordered, padded iframe by that much, and put the target's outline
off by the same). The crop fails CLOSED: it is not sent when a frame does not
answer within a second, when its evaluate rejects (mid-navigation it may still
show the old document), when it has no recording script, when it reports
itself too big (more than 2000 fields, 5000 text runs or 400,000 characters of
text, or a typed-secret scan past its budget), or when the frame element cannot
say where it is in time. Only a frame element with no box (hidden) is passed
over. (Measured: the recording script is present even in `sandbox=""` and
script-written `about:blank` frames, so fail-closed costs no crops on ordinary
pages.) All of this departs from decision 6's "anything else visible goes to
the model", in the safe direction; a password box showing dots is painted too
(it costs the model nothing but the dots). PNG, cropped to at least
520×320 with 140 px round the target, the target outlined in red, scaled so
the longer side is at most 640. The 40 are counted when taken, so a
pointer-down that never became an action still counts. `ai.sendScreenshots`
resolves as a batch's would: server, then project, then the session's run
setting.

**Secrets beyond the field rule.** A typed value equal to a secret-named
session variable, to a secret-named literal in the file's `## Parameters`, or
to a secret from the request's `env` is withheld exactly like a secret
field's, and the action names that parameter (`knownSecret`) so the step
reuses it. From `env` (Steptix sends the test's `.env`): every secret-named
key's value, and the value each `$VAR` parameter resolves to — the request's
`env` first, then the server's environment, as a run resolves it — when the
parameter or the variable has a secret-sounding name, named as the parameter.
Not every `$VAR` value: a `- email: $TEST_EMAIL` is a pointer, not a secret,
and masking it would turn a check on the signed-in header into "Welcome ***"
— the same rule a run's masking uses. Those values — and the file's own
secret-named literals, wherever they appear in the file excerpt — are masked
in everything the model is sent, in every `record:action` summary, in
`record:started`, in the warnings forwarded as `output` and in the
recording's own log lines (the "started on <url>" line, and the recorder's
debug lines, which can carry a frame's address).

Not every secret-NAMED `.env` value either (`envSecrets`,
`couldBeCredential`). `.env` files hold settings the name rule catches by a
word — `TOKEN_TTL_MINUTES=30`, `ENABLE_PASSWORD_RESET=true`, `MAX_TOKENS=2048`
— and a known secret is masked as a substring: "1300" typed into an Amount
field was recorded as "1***0", "true story" as "*** story", and a typed "30"
became `{{TOKEN_TTL_MINUTES}}`. A value known only because its VARIABLE's name
sounds secret must be 4 characters or more — `RECORD_SECRET_MIN_LENGTH`, the
floor the runner already applies to page-derived secrets (the runner's own
`.env` masking has none, but it masks the run's output, not what the author
typed), now exported from `src/utils/secrets.ts` — and not a boolean or a
number. A `$VAR` parameter whose own NAME the file makes secret-sounding
(`- password: $LOGIN_PIN`) keeps its value whatever it looks like: the author
named that parameter a password, the deliberate instruction the runner's rule
never floors, and a numeric password is still a password.

A value that CONTAINS a known secret (of 4 characters or more — a shorter one
withholds only a value that IS it) is withheld whole, as a secret field's, with
no `knownSecret`; so is an Add check's field value that holds one. The
previous round spliced it ("Bearer ***"), which became a parameter holding a
mask.

Masked as VALUES, in every spelling, before anything is folded or cut. The
prompt is masked object by object before `JSON.stringify` — once stringified,
a secret holding `"` or `\` is spelled with escapes and no longer matches
itself — and each secret is also masked in its JSON-escaped spelling, which a
page can show too, and in the spellings a URL carries (`secretSpellings`:
`encodeURIComponent`'s, a form's `+` for a space, `encodeURI`'s), because a
link's `href`, a tab's address and a typed navigation hold a token encoded.
Page text is masked first, then whitespace-folded, then clipped: the page
script neither clips to what the model sees (it sends up to 1000 folded
characters of a text, 4000 of a value) nor folds — it trims the ends, and cuts
where the FOLDED text would reach its bound, so the bound means what it did —
and the server masks, folds, then cuts; the panel line masks the whole action
before shortening it to 60 characters. A secret that crossed a cut used to
leave its first characters behind, and one holding a double space or a line
break was folded into a spelling no mask could match.

**The log bridge** forwards a warning or an error the server logs while the
recording runs as an `output` frame. The logger fans out process-wide, so a
line that names ANOTHER session (`Session "…"`) is skipped, and every line
forwarded is masked with this recording's secrets. A line from code that does
not say its session still gets through — masked with this recording's
secrets, not the other session's. Filtering by session exactly would need a
per-session log context (`AsyncLocalStorage`), which the binding callbacks the
recorder runs in would not carry; the steps route's bridge has the same
limitation and says so.

**One `isSecretField`.** The story counted three copies; there were two
(`capture-dom.js` and the `expand` walk in `dom-cleaner.ts`). Both now splice
in `src/browser/scripts/secret-field.js`, and the recorder loads the same
text; `tests/secret-field-parity.test.ts` asks all three the same questions.

**The recorder remembers.** The rule answers about a field as it is NOW, and a
"show password" eye flips a password box to `type="text"` — after which the
rule no longer calls it secret, so its value was typed into an action, sent to
the model, photographed, and read by a pick, one click after being withheld.
The page script keeps a WeakSet of every element it has ever seen as secret,
for the life of the document, asked at focus, pointer-down, the first
keystroke, the end of the typing, a pick and every crop; and a
`MutationObserver` on `type` attributes (with their old value) adds a field at
the flip itself, so one flipped before the author ever touched it is still
known. It also calls a text field secret when its `<label>` names a
password — the one name a minimal sign-in form leaves a flipped box, and the
only cover for one flipped before Record was pressed on a page the script was
not yet in. The label rule is its own, not the field rule's: whole words
(password, passwd, pwd, passcode, passphrase, secret, token, OTP, one-time
code/password/PIN, verification/security/authentication/access code, and a
PIN token), and not when the label also names another kind of field (email,
username, phone, mobile, hint, question, reminder). The field rule's substring
`pass` withheld "Boarding pass number", and the word alone withheld "Email for
password reset". A field styled `-webkit-text-security: disc | circle |
square` is secret too; it shows dots, and is photographed like a password box.

**…and remembers VALUES.** The WeakSet follows an element, and a toggle that
REPLACES the box — Vue `v-if`/`v-else`, Angular `*ngIf`, a React key change —
put a new `<input type="text">` holding the typed password where the old one
was: typed into an action, the summary, the prompt and `## Parameters`, and
photographed. So the page script also keeps, in its closure and never sent,
the value of every secret field (one live entry per field, updated at every
keystroke into it and whenever it is asked about; and every finished value).
A field whose value IS one, or contains one of 4 characters or more
(`TYPED_SECRET_MIN`, pinned equal to `RECORD_SECRET_MIN_LENGTH` by a test), is
secret — typing, an Add check, every crop; every element whose text shows one
is painted out of the crops; and `clip`, which every text the script sends
goes through, masks them — so a check on a "reveal" `<span>` says `***`. The
server's known secrets are NOT handed to the page for this: the page reports
its text with boxes and the server compares (above). One limit on what is
remembered: the shared rule's bare `key` calls a `keywords` search box and
`aria-label="Search by keyword"` secret, and a remembered search term would be
masked out of every description and painted out of every crop of the results
page. A field secret only by that word gives its value to the memory only when
the value looks like a credential — 8 characters or more, no spaces
(`strongSecretField`, `worthRemembering`; pinned by a test that fails without
the gate). The memory, the label and the style only ever ADD to the shared
rule, so the parity test's three readers still agree on everything the rule
itself decides.

**The answer, enforced.** Every draft — and so `record:result`, which is the
final draft — has been through a file-safety pass. What the pass CHANGED stays
in the draft's notes for the rest of the recording (a full redraft starts them
again); what is merely true right now (an undefined placeholder, a secret-named
literal) is recomputed for each draft, so it disappears once the model fixes
it. A returned parameter whose name the file already has with a
different value is renamed (`email` → `email_2`) and the new steps rewritten to
match, with a note in §10's words finished with what was done instead
("…; the recorded value was added as email_2 instead.") — the spec has the
client leave such a line alone and warn, which would leave the new steps
typing the old value. Two `.env` references under one name keep the file's.
A value the model could only have seen masked becomes `$NAME`. A `{{name}}`
nothing defines is a note. Stop with every action dropped (or none recorded)
answers an empty result with a note and makes no model call. An unreadable
answer to Stop's last call ends with §10's "The steps could not be written:
<reason>. Nothing was inserted." as both the `output` frame and `done.error`.

**Beyond the wire block.** The start body's `env` is accepted (the Steptix
half sends it): it points the session's AI client as a batch would, and a
session the recording creates is built from it, and its secrets are known
secrets from the first action (above). `envName` is not read — the recording
needs no `${env.…}` resolution.

**Names without decoration, and the prompt.** An element's name and text lose
the emoji, icon-font glyphs, arrows and chevrons at their ends
(`stripEdgePictographs`); the name as the page gave it goes to the model as
`rawName` beside it. The real-model smoke run wrote `Click 💳 Transactions in
the main navigation`, and rule S2 now says to name an element by its words
only. The same run dropped a "Click Reject in the Cookie consent dialog" step
on its second draft. The prompt never told the model to omit a dismissal, and
a run does not dismiss banners by itself (the executor's "dismiss" nudge is
only in the prompt when the test has hooks), so rule I8 now says to keep every
step that closes a banner, popup or dialog, on every redraft.

**`drag` and `reload` in the runtime** (so recorded steps run). Built the way
`back`/`forward` were (docs/specs/SPEC-browser-history.md): in
`VALID_ACTION_TYPES` with the near-miss spellings aliased (`refresh`,
`dragTo`, `dragAndDrop`, …) because an unknown type was then a no-op that
reported success (since 2026-09-29 it fails the step; see CHANGELOG); `{ action: 'drag', selector, target }` — the parser also reads a
drag's target from `dropTarget`, `targetSelector` or `to`, and its source from
`source`, for a drag only — executed as
`locator(selector).dragTo(locator(target))`, both ends visible-first in the
action's frame, the dragged element measured and gated like a click's;
`reload` is `page.reload()` with navigate's arrival rule, on the page even
inside a frame, and has no "did it move?" failure; a reload that did fail (the
server gone, a timeout) is `retryable: false`, as `back`/`forward`'s are —
re-planning cannot make it happen and only hands the model a failure to
satisfy with a `navigate` or a `noop`. Both are in
`MUTATING_ACTIONS`; the run prompt gains rule 16b; code generation gets
`page.reload()` through the existing conditional rule 7b and `dragTo` through
a new conditional rule 7c; neither is on the compile's refusal list, and a
condition entry may do neither (the static backstop already refused `reload(`
and `dragTo(`). A drag's report row says which selector went onto which.
Computer mode refuses the page spellings (`reload`, `refresh`, `dragTo`, …)
with its page-action message; its own coordinate `drag` is unchanged. The
three pins `back`/`forward`'s review found toothless are mutation-checked for
these two in `tests/drag-reload-actions.test.ts`. Handbook §3, the authoring
guide, the README action table, SPEC-browser-history §9 and the CHANGELOG say
so.

**Also worth knowing.** A recording counts as a run in flight, so `/health`
shows it and `steptix stop` answers 409 while one is open. `DELETE
/sessions/:id` cancels it. After a recording the session's browser context
keeps one binding (`__steptixRecordSteps`) and one init script for its life —
Playwright can remove neither — and each new document asks the binding once
whether a recording is running; every listener returns at its first line
otherwise. The dialog guard still answers `alert`/`confirm` in that browser as
it does in runs, so a page's native dialog is not something an author can
click through while recording (native dialogs are out of scope).
