# Record Steps: click through the app, get the steps written for you

**Status:** spec, 2026-09-26. Not built.

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
- password: $PASSWORD

## Steps
1. Navigate to login.html
2. Type "demo@securebank.com" into the Email field
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
   covered from the moment the recording starts. It records:
   - clicks (the element, and whether it is a link, button, checkbox, radio,
     option or something else);
   - typing — one action per field with its final value, not per keystroke;
   - selecting an option, ticking or unticking;
   - Enter, Escape and Tab when they do something (submit, close, move on);
   - choosing files in a file input (the file names — the step will say
     which file, relative to the test, when it can);
   - navigation the author typed into the address bar, and a new tab opening
     or the author moving to another tab.

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

8. **Other typed values are written literally.** `Type "demo@securebank.com"
   into the Email field` is the fastest thing to author and read, and turning
   it into a parameter later is one edit. Only secrets become parameters.

9. **One model call, at Stop.** The whole recording goes to the model at once,
   because turning mechanics into intents needs to see what came next: a
   click that only focused a field is dropped, keystrokes merge into one
   `Type`, clicking a checkbox's label is `Tick the … checkbox`, a burst of
   clicks through a menu is one `Click Payments in the main menu`. The model
   is given the handbook's step-writing rules, the file around the cursor
   (its `baseUrl`, parameters and section names, so it can write
   `Navigate to login.html` and reuse `{{password}}`), and the time gaps
   between actions. It answers JSON: the steps, and the parameters they need.
   It uses the session's model. Recording is a request FOR AI, so it runs
   even where runs forbid AI (`ai.allowInRuns: false`), as compile does.

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
- Hover menus, drag and drop, right-click, scrolling, keyboard shortcuts
  beyond Enter/Escape/Tab, native dialogs.
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
- A live test: record signing in and paying by cash on the fixture app,
  drive the browser with Playwright from the test itself, check the inserted
  steps run green.

## Open questions

- Should Stop insert straight into the file (undoable), or show the steps as
  a preview to accept first, like the code-behind proposal?
- Is a panel **Add check** button the right gesture, or Alt+click on the page?
- Should typed non-secret values really stay literal (decision 8), or should
  things like email addresses become parameters too?
