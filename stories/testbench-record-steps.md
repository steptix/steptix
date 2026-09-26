# Record Steps: click through the app, get the steps written for you

**Status:** spec, 2026-09-26, decisions confirmed by the author (insert
straight away, a panel **Add check** button, every typed value a parameter).
Not built.

## In plain terms

Writing a test today means knowing the app well enough to describe each step
in words before you have run anything. **Record Steps** turns that around: you
press Record in TestBench, use the app in the test's own browser the way a
user would, press Stop — and the numbered steps appear in your file, written
the way the handbook says to write them.

It is for authors who already know the format and want to go faster. The
output is Markdown steps only — no code-behind — and it lives in TestBench
only.

### What it looks like in practice

**You run** *TestBench: Record New Test*, name it `pay-by-cash`, and the test's
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
**You get** a list of actions in the TestBench panel as you go
(`● Clicked link "Reports"`); remove that one with its ✕ before pressing Stop,
and no step is written for it.

## Decisions

1. **Name: Record Steps.** "Record" alone already means compile's
   Record/Replay (`captureStepContext`, `.aiui-codebehind-cache/*.recording`)
   and `browser.video`. Commands, endpoints and code say *record steps* /
   *step recorder*.

2. **The browser is the test's own session browser.** TestBench's session id
   is the file path, and an interactive session stays open after a run. So
   recording continues from wherever that browser is — the natural way to
   extend a test is *run to the cursor, then record*. With no browser yet,
   starting a recording launches one and goes to `baseUrl`, exactly as the
   first step of a run does. The server's `browser.headed` must be on; a
   headless server refuses with a message saying so.

3. **The server records; TestBench shows and inserts.** A new SSE route,
   `POST /sessions/:id/record-steps`, holds the session's queue for as long as
   the recording lasts (so a Run cannot start in the middle of it), counts as
   in-flight work for the idle reaper, and streams one `record:action` frame
   per action as it happens. `POST /sessions/:id/record-steps/stop` ends it;
   the same stream then carries `record:result` (the Markdown) and `done`. It
   accepts `config` like a first steps request does, and TestBench marks the
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
   keystroke. The draft shows in the TestBench panel as it grows; at Stop it
   is final (one last call when actions arrived after the last draft), and
   goes into the file as one edit, as before. Dropping or restoring an action
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
      renumbered with the existing Renumber Steps logic. One edit, one undo.
    - **A new test** — *TestBench: Record New Test* asks for a name, creates
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
- **TestBench** — *Record Steps* (editor title + panel), *Record New Test*
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
- TestBench unit tests for insertion (region rules, renumbering, one undo
  step) and a fake-server integration test for the panel flow.
- End to end on the server, with a real browser: start a recording through
  the real HTTP route on the fixture app, drive that page with Playwright
  input (trusted events, as a person's are), stop, and check the prompt and
  the result with a fake model. A TestBench live test cannot click in the
  server's browser, so the extension half is proven with the fake-server
  harness, and the whole loop by a real-model smoke run plus the author
  trying it.

## On the wire

Owned by the server (`src/`) and by runner-core + TestBench on the other side;
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
    | 'untick' | 'key' | 'upload' | 'navigate' | 'tab' | 'check';
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

**TestBench does the editing:** it numbers `record:result.steps` after the
cursor line (or under `## Steps` of the new file), renumbers the rest, and
adds each parameter it does not already have under `## Parameters` (creating
the section above `## Steps` when there is none) — one edit, one undo. An
existing parameter with the same name is left as it is.

## What the TestBench half decided

Built in `runner-core/` (the frames, `streamRecordSteps`,
`controlRecordSteps`) and `testbench-native/` (tb 0.5.151). The text rules
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
Cancel — could never be recorded into. Headings themselves, prose, fences and
items under a `####` heading are refused with the spec's §10 sentence; the
last three add a clause saying why, since those lines look like steps.

**The line recorded from, when the file changed.** The anchor is remembered
as a line number and that line's text. At Stop it is looked for where it was,
then by its text (when that text is unique in the same flow). When it is
gone, the steps go at the end of the flow the anchor was in — the main flow,
or that section when it still exists — and a warning says so. This is not
the spec's literal "end of `## Steps`": the end of the `## Steps` span is
after the last section's body, where main-flow steps would silently become
part of that section.

**Numbering.** The new steps continue from the anchor step's number as
written (so a `1.`-everywhere list stays consistent), and only the rest of
that one flow is renumbered, by Renumber Steps' own walk. Step texts are
flattened to one line and a stray leading `3. ` is stripped.

**Parameters.** The section is found by runner-core's own rule, so an added
line lands where the parser reads it. New lines go after the last bullet
(after the last non-blank line when there is none); a created section takes
the `## Steps` heading's depth and its blank lines. A name that is not a valid
parameter name, or a value that is empty, is left out with a warning. The
conflict warning is the spec's sentence and names no value. One addition: a
`$NAME` parameter whose variable the resolved `.env` does not define gets a
warning at insertion, since the next Run would fail on it.

**One recording per window.** The Recording block and the status bar item
are window-wide and show whichever file is active: the author is clicking in
a browser, not reading an editor. Only the recorded test's session is held —
runs of other tests are unaffected. The recorded test refuses a Run three
ways: the Run buttons are hidden in the title bar and disabled in the panel,
and the run controller itself refuses (it would otherwise close the session
under the recording on its first-use stale-session clear).

**The session.** A recording goes through the run's own plumbing: the same
env resolution and server check (auto-start included), the same first-use
close of a session another window left keyed on this path, and the same
write-once `config` bookkeeping — sent when the session has not had it,
marked sent on the first frame. The viewport recycle a fresh Run performs is
not done: a recording means "continue from this page", and recycling would
close it.

**Paused runs.** Both kinds are ended with the Stop command's own teardown: a
breakpoint pause (no stream open) and a step pause (the server holds the
stream). For a step pause the client waits for the run to unwind, then
retries a 409 for about ten seconds while the server lets go of the queue.

**Beyond the wire block.** The start body also carries `env` (the resolved
`.env`, as the steps route's does — a recording can be the request that
creates the session, and a session's model client is built from it) and
`envName`. `target.cursorLine` is the anchor's line — the step the steps go
after, or the heading of a flow they open — not the raw cursor position.

**Controls.** Stop before `record:started` is a cancel. Stop sends `dropped`
only when something was dropped. Cancel sends `cancel` and then closes the
stream, and a result that races it in is thrown away. The server's
`done.error` and a 400's reason (the headless refusal) are shown as they
came; a 404 on the start route says the server predates Record Steps;
transport failures get the run's TBxxx payloads.

**Record New Test.** The name is a plain file name (`.md` optional, no
folders, no reserved device names). The title is title case with short
joining words kept lower-case in the middle (`pay-by-cash` → `Pay by Cash`),
per the spec — the story's example shows `Pay by cash`. The folder is
`tests.dir` from the nearest `aiui.config.json` inside the workspace folder
(never above it — a config outside is another project's); else the fixed
start of `testbench-native.testsGlob` (`tests/**/*.md` → `tests/`); else the
workspace folder. The project has no `baseUrl` setting, so it is the active
test's own when that test is in the same folder, else the most common one
among the tests in that folder, written raw (`$APP_URL` stays a reference);
with none, `## Config` is written empty. The file is created with `wx`, so it
is never overwritten. Skill files are refused: a skill has no browser of its
own to record in.

**Where things are.** Title bar: Record (`navigation@10`, on a test that is
idle or paused); while recording, Add Check and Stop Recording at the front.
Palette: all five commands, gated on the context key. Panel: `● Record` and
`New test…` in the toolbar, `● Record new test` on the no-test view, and the
Recording block. The result is applied with one `editor.edit` (re-planned
against the live text if a keystroke lands in between), the inserted steps
are selected, and the file is left unsaved.

## What the server half decided

Built in `src/` — the page script `src/browser/scripts/record-steps.js`, the
recorder and the run in `src/recorder/`, `buildRecordStepsPrompt` in
`src/ai/prompts.ts`, the two routes in `src/server/api-server.ts` and
`beginRecordSteps` / `controlRecordSteps` on the session manager. Pinned by
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
parked inside a batch holds it, and a TestBench breakpoint pause (the batch
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
(a browser someone else started is "Not in the first version").

**The AI switch.** The recording uses the session's client, with the policy
veil lifted for its one call and put back exactly as it was found — not
lowered for good: the veil is the last batch's statement about the session,
and the next batch re-decides it anyway. A log line says so when the veil was
up. The call uses the `authoring` profile.

**Typed navigation.** On Chromium each page gets its own CDP session, and
`Page.frameRequestedNavigation` — which fires for every navigation the page
itself asked for (a link, a form, a script) and never for one the browser
started (the address bar, a bookmark, back/forward) — is the primary signal. A
main-frame commit is recorded as `navigate` only when no such request preceded
it AND the author did not touch the page in the previous 3 seconds (a
pointer-down, a first keystroke, a pick, or any action other than a finished
field of typing — typing is reported on focus-out, which is exactly what
clicking into the address bar causes). Firefox and WebKit get the window alone.
Not recorded: a reload (same address), a non-web address (`about:blank`, the
new-tab page), and a popup's own first load when the tab opened within 3
seconds of a touch (it is part of that click).

**Tabs.** A new tab is a `tab` action (`opened`) carrying its label, title and
URL; acting in a different tab is a `tab` action (`moved`), except in a tab
that opened since the last action — the `opened` one already says it. The
session's active tab follows the author, so a Run after the recording
continues where they left off.

**Control answers 202 or 404 only**, as §9.3 says. After Stop, only `cancel`
still does something — it abandons the model call and the stream ends
`aborted`; a second `stop` or a check is answered 202 with an `ignored` reason
and changes nothing. A body that is none of the four is a 400.

**Typing still open at Stop arrives after Stop.** The page returns any field
still being typed into when the server asks for it at Stop, and those
`record:action` frames are sent before `record:writing`. They cannot be in
`dropped` — the client could not have seen them — so a client should accept
action frames until `record:writing`.

**What becomes an action.** A click into a text field is recorded with
`focusOnly` and dropped by the model when typing into that field follows. A
click on a checkbox, a radio, a label for one, a `<select>`, an option or a
file input is not reported as a click: the `change` reports the outcome
(`tick`/`untick` with `viaLabel`, `select` with the option text, `upload` with
file names). The click a browser makes on a form's submit button when Enter is
pressed in its field is folded into that `key` action. A custom `role=checkbox`
or `switch` is reported as `tick`/`untick` from its `aria-checked` after the
page's handler ran. Escape counts only when the page changed within 300 ms;
Enter on a button or link is its click; Enter in a textarea is typing. A choice
made without pointing (the keyboard, a script) first reports any field still
being typed into, so the order is what happened.

**Crops.** Taken at pointer-down for anything but a text field, and at the
first keystroke (or first `input`) into a text field. A field the secret rule
calls secret by its NAME while showing its value in clear (a `type="text"`
token box) gets no crop at all — the safe direction, departing from decision
6's "anything else visible goes to the model". PNG, cropped to at least
520×320 with 140 px round the target, the target outlined in red, scaled so
the longer side is at most 640. The 40 are counted when taken, so a
pointer-down that never became an action still counts. `ai.sendScreenshots`
resolves as a batch's would: server, then project, then the session's run
setting.

**Secrets beyond the field rule.** A typed value equal to a secret-named
session variable, or to a secret-named literal in the file's `## Parameters`,
is withheld exactly like a secret field's, and the action names that parameter
(`knownSecret`) so the step reuses it. Those values — and the file's own
secret-named literals, wherever they appear in the file excerpt — are masked
in everything the model is sent, in every `record:action` summary and in
`record:started`.

**One `isSecretField`.** The story counted three copies; there were two
(`capture-dom.js` and the `expand` walk in `dom-cleaner.ts`). Both now splice
in `src/browser/scripts/secret-field.js`, and the recorder loads the same
text; `tests/secret-field-parity.test.ts` asks all three the same questions.

**The answer, enforced.** `record:result` is the model's answer after a
file-safety pass. A returned parameter whose name the file already has with a
different value is renamed (`email` → `email_2`) and the new steps rewritten to
match, with a note in §10's words finished with what was done instead
("…; the recorded value was added as email_2 instead.") — the spec has the
client leave such a line alone and warn, which would leave the new steps
typing the old value. Two `.env` references under one name keep the file's.
A value the model could only have seen masked becomes `$NAME`. A `{{name}}`
nothing defines is a note. Stop with every action dropped (or none recorded)
answers an empty result with a note and makes no model call. An unreadable
answer ends with §10's "The steps could not be written: <reason>. Nothing was
inserted." as both the `output` frame and `done.error`.

**Beyond the wire block.** The start body's `env` is accepted (the TestBench
half sends it): it points the session's AI client as a batch would, and a
session the recording creates is built from it. `envName` is not read — the
recording needs no `${env.…}` resolution.

**Also worth knowing.** A recording counts as a run in flight, so `/health`
shows it and `aiui stop` answers 409 while one is open. `DELETE
/sessions/:id` cancels it. After a recording the session's browser context
keeps one binding (`__aiuiRecordSteps`) and one init script for its life —
Playwright can remove neither — and each new document asks the binding once
whether a recording is running; every listener returns at its first line
otherwise. The dialog guard still answers `alert`/`confirm` in that browser as
it does in runs, so a page's native dialog is not something an author can
click through while recording (native dialogs are out of scope).
