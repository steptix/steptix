# Record Steps: write a test by using the app

**Status:** spec, for build. Medium-large.
**Opened:** 2026-09-26
**Change record:** [stories/testbench-record-steps.md](../../stories/testbench-record-steps.md)
— the decisions, and what each half of the build decided. Where the two
disagree after the build, this spec is updated to match what shipped.

## 1. What this is

An author presses **Record** in TestBench, uses the application in the test's
own browser the way a user would, and presses **Stop**. The framework watches
what they did, and a model writes it down as numbered natural-language steps
in the test file — the same steps the author would have written by hand,
following [the handbook](../test-writing-handbook.md).

| The author does | The file gets |
| --- | --- |
| Types `demo@securebank.com` into the Email box | `Type {{email}} into the Email field`, and `- email: demo@securebank.com` under `## Parameters` |
| Types a password | `Type {{password}} into the Password field`, and `- password: $PASSWORD` — the value never leaves the browser |
| Clicks the Sign in button | `Click the Sign in button` |
| Opens a menu and picks Payments | `Click Payments in the main menu` — one step, not two |
| Ticks Cash (by clicking its label) | `Tick the Cash checkbox` |
| Picks Monthly in a drop-down | `Select "Monthly" from the Frequency list` |
| Presses **Add check**, then clicks the payment panel | `Verify the Payment method panel says "Paid in cash"` — the click is not performed |
| Clicks a trash-can icon with no text | `Click the delete (trash can) icon on the "Everyday" account row` — the model saw a crop of the screen |

It lives in TestBench only, writes Markdown only (no code-behind), and exists
to make authoring faster for people who already know the format.

## 2. Why

Writing steps by hand means describing an application in words before
running anything against it, and naming each target the way the model will
recognise it. The author already knows the flow with their hands. Recording
captures that knowledge directly; the model supplies the wording the
handbook asks for — targets named by visible label, one bounded instruction
per line, values as parameters.

## 3. Using it

### 3.1 Commands

| Command | Where | Does |
| --- | --- | --- |
| **TestBench: Record Steps** | editor title bar, panel, palette | Records into the active test at the cursor (§7.1) |
| **TestBench: Record New Test** | panel, palette | Asks for a name, creates the file (§7.2), records into it |
| **TestBench: Add Check** | while recording | Arms pick mode: the next click becomes a check (§6) |
| **TestBench: Stop Recording** | while recording | Ends the recording and writes the steps |
| **TestBench: Cancel Recording** | while recording | Ends it and writes nothing |

While recording, the editor title bar shows Stop and Add check in place of
Run and Record, and the context key `testbench-native.recording` is set.

### 3.2 The panel while recording

- A **Recording** block listing each action as it happens:
  `● Clicked button "Sign in"  0:07`. Each row has a **✕** that drops it —
  dropped rows are struck through, click again to restore — and dropped
  actions are left out of what the model is shown.
- **Steps so far** — the draft the model has written from those actions
  (§8), numbered, updated a moment after each action, with an **updating…**
  marker while a draft call is running.
- **Add check** as a toggle that shows whether pick mode is armed.
- **Stop** and **Cancel**.
- After Stop, **Finishing…** until the result arrives — immediate when the
  draft already covers every action.

The status bar reads `● Recording — N actions`.

### 3.3 Which browser, and where it starts

Recording uses the test's own session browser — the one Run drives, keyed
by the file's path — and starts from wherever that browser is. The usual way
to extend a test is therefore: set a breakpoint, run to it, put the cursor
there, press Record.

- **No browser yet:** starting a recording launches one and goes to the
  test's `baseUrl`, exactly as the first step of a run does.
- **A run is executing:** Record is refused.
- **A run is paused at a breakpoint:** Record ends that run first. The
  browser stays where it is; ending a run never closes the session.
- **The server is headless** (`browser.headed: false`, a server-wide
  setting): Record is refused with the reason.

A Run cannot start while a recording holds the session.

## 4. What is captured

A script is installed on every page, tab and frame of the session browser's
active context, plus one binding back to the server. It records **events**,
and a few kinds of event are **actions**.

**An action** is what the author does to move the application on, and it is
what sends the draft to the model (§8):

| Kind | Recorded when | Carries |
| --- | --- | --- |
| `click` | A primary click lands on an element (ticking a box and opening a list are clicks) | The element (§4.1) |
| `drag` | The pointer is pressed on one element, moved, and released on another (or an HTML drag-and-drop completes) | The element dragged; the element dropped on |
| `key` | Enter or Tab is pressed in the page | The key; the element |
| `back` / `forward` | The author uses the browser's Back or Forward | The URL arrived at |
| `reload` | The author refreshes the page | The URL |
| `navigate` | The author presses Enter in the address bar (a main-frame navigation nothing in the page caused) | The URL |
| `check` | A click in pick mode (§6) | The element; its text or value at that moment |

**Other events** are captured but send nothing on their own; they go to the
model with the next action (or at Stop, when nothing follows):

| Kind | Recorded when | Carries |
| --- | --- | --- |
| `type` | A text field's value changes — ONE event per field per visit, with the final value | The element; the value, unless secret (§5) |
| `select` | An option is chosen in a `<select>` | The element; the option's text |
| `tick` / `untick` | A checkbox or radio changes | The element |
| `upload` | Files are chosen in a file input | The element; the file names |
| `tab` | A new tab opens, or the author acts in a different tab | The tab's label, title and URL |

So typing an email address costs no model call; the Tab or the click that
follows it does, and the model sees both.

Not captured: Escape and every other key or shortcut, hover, right-click,
scrolling, native dialogs, a second browser, the computer surface.

**The runtime must be able to perform what is recorded.** A run's model has
`back` and `forward` actions; `drag` (a drag from one element onto another)
and `reload` are added to the runtime's action vocabulary with this feature,
so `Drag the Invoice 1043 card onto the Paid column` and `Reload the page`
run like any other step.

After Stop the script cannot be uninstalled (Playwright has no way to remove
an init script); it stays inert, asking the binding whether a recording is
running before it reports anything.

### 4.1 Describing an element

Every action's element is described from the page itself:

- tag and role (explicit `role`, or the implicit role of the tag);
- accessible name: `aria-label`, `aria-labelledby`, `label[for]`, a wrapping
  `<label>`, `alt`, `title`, button or link text, else the placeholder;
- visible text, clipped;
- where it sits: the enclosing dialog, the nearest section heading, the
  fieldset legend, the table row's header cell;
- which frame it is in (its title, name or source);
- a stable selector, verified unique when taken.

### 4.2 The screenshot

At the moment of a click — on mouse-down, before the click lands and the page
moves on — and at the first keystroke into a field, the server captures the
visible page, crops it around the target, draws the target's box on the crop
and scales it down. The model is shown the crop beside the element's
description, and told the box's position in text as well — in the draft call
that covers that action (§8), so crops go to the model **during** the
recording, a moment after each action, not in one batch at the end. A redraft
(an action dropped or restored) sends the crops of every remaining action
again, within the same cap.

- `ai.sendScreenshots: false` sends no crops.
- A model that rejects images is asked once more without them.
- At most 40 crops per recording; later actions carry descriptions only.
- A password field shows dots, as it does on screen. Anything else visible is
  sent, as screenshots already are during runs.

## 5. Secrets

A field is **secret** when the DOM snapshot's secret-field rule says so: its
`type` is `password`; its `autocomplete` names a password; its `name`, `id`,
`aria-label` or `autocomplete` matches the secret-name rule; or its
placeholder matches the password-field rule. For a secret field:

- the page script reports only *that* it was typed into — the value is never
  read into an action, a frame, a log line, a prompt or a file;
- the step reads `Type {{name}} into the … field`;
- the parameter line is `- name: $NAME`, resolved from `.env` at run time as
  any `$VAR` parameter is;
- recording into a test that already fills that field from a parameter
  reuses that parameter.

## 6. Checks

A recording cannot guess what the author meant to assert, so the recorder
writes a `Verify` step **only** from an explicit check:

1. The author presses **Add check**. Pick mode is armed (`record:pick`
   `armed: true`).
2. The author clicks an element. The click is swallowed — not performed on
   the page — and recorded as a `check` action carrying the element and its
   text (or a field's value) at that moment. Pick mode disarms.
3. The model writes one `Verify …` step for it in the handbook's style, e.g.
   `Verify the Payment method panel says "Paid in cash"`.

Pressing Add check again before clicking cancels pick mode.

No other `Verify` steps are written, and no `Wait until …` steps unless a
check calls for one.

## 7. Where the steps go

The result is inserted as **one edit** — one Ctrl+Z restores the file
exactly.

### 7.1 At the cursor

The cursor must be under `## Steps`, not inside a fenced block, on one of:

- a numbered step line in the main flow;
- a numbered step line in a `### Section` body;
- the blank line directly after one of those;
- the blank line under `## Steps` or under a `### Section` heading, which
  opens that flow: the steps go in ahead of its first step;
- the blank line after the data table a flow opens with, which opens that
  flow the same way.

Anywhere else, Record Steps is refused with a message saying where to put
the cursor. The steps are inserted after that line, in the same flow or
section, numbered to follow it; every later step in that flow or section is
renumbered. A flow numbered `1.` on every step keeps that style: the new
steps are `1.` too, and nothing is renumbered.

A flow with no steps yet that opens with a data table gets its steps after
the table — the parser refuses a table that comes after a step — with a
blank line between them.

The line the steps go after is followed through every edit made to the
document while recording: lines added or removed above it move it, and a
renumber that rewrites its number does not lose it. Only when that line
itself is deleted (or the file is closed) is it looked for again by its
text; when that fails too, the steps go at the end of the flow the line was
in — not of `## Steps`, whose end is inside the last section — and the
author is told.

A result is never lost. One that cannot be inserted — `## Steps` deleted,
the file renamed or deleted, the edit rejected three times — is written to
the TestBench output, and the error offers **Copy steps**. A result with no
steps (nothing recorded, or every action dropped) is said as the server's
note, as information rather than an error.

### 7.2 A new test

**Record New Test** asks for a name, and creates `<tests dir>/<name>.md` —
the project's `tests.dir`, or `./tests` beside its `aiui.config.json` when
it declares none (the server's default) — refusing if it exists, and
refusing, before anything is created, a tests folder outside the workspace:

```markdown
# <Name, in title case>

## Config
- baseUrl: <the project's baseUrl, when known>

## Parameters

## Steps
```

It opens the file, puts the cursor under `## Steps`, and records into it. The
first recorded navigation becomes step 1, relative to `baseUrl` when it lies
under it (`Navigate to login.html`).

### 7.3 Parameters

Every **typed** value becomes a parameter; selecting and ticking do not.

- The name comes from the field's label, else its placeholder, else its
  `name`, in snake_case (`email`, `first_name`, `search_term`).
- The same value typed into the same kind of field again reuses the name.
- A parameter the file already has with the same value is reused. A name the
  file already has with a **different** value is never reused — the model
  picks another name.
- New parameters are added under `## Parameters`; the section is created
  directly above `## Steps` when absent. An existing parameter line is never
  changed; a conflicting one is left alone and the author is warned.
- `## Parameters` is found as the runner's parser finds it: a depth-2
  heading outside frontmatter and fenced blocks, running to the next depth-1
  or depth-2 heading; an existing parameter is any list item in it (`-`,
  `*`, `+` or numbered) of the form `name: value`, in every such section.
- A value is written exactly as it was typed, bar the whitespace at its ends
  (which the parser trims). A value with a line break cannot be one
  parameter line: it is left out, and a warning names the parameter.

## 8. Writing the steps

The steps are **drafted live**. Each action goes to the model shortly after
it happens, together with the draft so far; actions that arrive while a call
is running, or within a short settle window, go together in the next call.
The model turns mechanics into intent, and because the next action can
change what the last one meant, it may **rewrite the last three steps** as
well as append:

- a click that only focused a field is dropped;
- keystrokes into one field are one `Type` (typing is one action per field,
  so there is never a call per keystroke);
- a click on a checkbox's label is `Tick the … checkbox`;
- `Click Menu`, followed by a click on Payments, becomes one `Click Payments
  in the main menu`;
- a click that submitted a form and an Enter in its last field are one step.

**Input of a draft call:** the handbook's step-writing rules; the draft so
far (its steps, numbered, and its parameters); the NEW actions, each with its
description (§4.1), its crop (§4.2), the time since the previous action and
its tab; the file around the cursor — `baseUrl`, existing parameters with
their values (secret ones masked), `### Section` names, and the steps just
before and after the insertion point.

**Output of a draft call:** JSON only — the draft's new tail and the whole
parameter list.

```json
{
  "replaceFrom": 4,
  "steps": ["Click Payments in the main menu", "Tick the Cash checkbox"],
  "parameters": [
    { "name": "email", "value": "demo@securebank.com" },
    { "name": "password", "value": "$PASSWORD" }
  ],
  "notes": ["Two clicks on the same Next button were written as one step"]
}
```

`replaceFrom` is the 0-based index in the current draft where `steps`
begins; everything before it is kept. It may not reach back more than three
steps: a smaller value is refused and the call is retried once as a full
redraft. `steps` carry no numbers. `notes` are shown to the author.

**When a draft call fails** (the model errors or answers something
unreadable), the author is told in the panel, the previous draft stands, and
the next call — or Stop — covers those actions again.

**A redraft** — after an action is dropped or restored — is one call over
every remaining action, answering `replaceFrom: 0`.

**At Stop** the draft is final when it already covers every remaining action;
otherwise one more call brings it up to date. If that last call fails, the
recording ends with an error and nothing is inserted.

**Model and policy:** the session's model (including a `runSettings.model`
override). Recording is a request *for* AI, so it runs even where runs forbid
AI (`ai.allowInRuns: false`, `runSettings.ai: off`), as compile does. A
machine with no model configured refuses Record before the browser is
touched.

## 9. On the wire

### 9.1 `POST /sessions/:id/record-steps`

Starts a recording. Always a Server-Sent Events response. `x-api-key` auth as
every route.

```ts
{
  testFilePath: string;        // the session's test file
  config?: {                   // only on the session's FIRST request —
    baseUrl?: string;          // the same object and rule as
    timeout?: number;          // POST /sessions/:id/steps
    viewport?: ViewportConfig;
  };
  target: {
    mode: 'cursor' | 'new';
    fileText: string;          // the document as it stands, for the prompt
    cursorLine?: number;       // 1-based; mode 'cursor' only
  };
}
```

| Status | When |
| --- | --- |
| 200 + SSE | Recording started |
| 400 | Invalid body; `config` sent to an existing session; the server is headless |
| 401 | Missing or wrong `x-api-key` |
| 409 | A run holds the session's queue, or a recording is already running |

### 9.2 Frames

```ts
{ type: 'record:started'; url: string; title: string }
{ type: 'record:action'; id: string;
  kind: 'click' | 'type' | 'select' | 'tick' | 'untick' | 'key' | 'upload'
      | 'navigate' | 'tab' | 'check' | 'drag' | 'back' | 'forward' | 'reload';
  action: boolean;             // true for an ACTION (§4), false for an event that rides with the next one
  summary: string;             // one line for the panel; secrets masked
  atMs: number;                // since record:started
  tab?: string }               // the tab's label when not `main`
{ type: 'record:pick'; armed: boolean }
{ type: 'record:drafting'; busy: boolean }   // a draft call started / finished
{ type: 'record:draft'; revision: number;    // REPLACES the previous draft
  steps: string[];
  parameters: Array<{ name: string; value: string }>;
  notes?: string[];
  through?: string }           // id of the last action the draft covers
{ type: 'record:writing' }     // Stop received; finishing the draft
{ type: 'record:result'; steps: string[];
  parameters: Array<{ name: string; value: string }>;
  notes?: string[] }
{ type: 'output'; … }          // warnings, as on the steps route
{ type: 'done'; status: 'passed' | 'error' | 'aborted'; error?: string }
```

Frames arrive in this order: `record:started`; then, as the author works,
`record:action` and `record:pick`, each burst of actions followed by
`record:drafting` `busy: true`, a `record:draft`, and `record:drafting`
`busy: false`; then — after `stop` — `record:writing`, `record:result` (the
final draft, with parameter conflicts settled), `done`. An action can still
arrive after `stop` (a field being typed into is collected then), until
`record:writing`. A cancel, or the client closing the stream, ends with
`done` `aborted`; a draft call in flight is abandoned.

### 9.3 `POST /sessions/:id/record-steps/control`

```ts
{ action: 'stop'; dropped?: string[] }   // write the steps, leaving these action ids out
{ action: 'drop'; id: string }           // leave this action out; redraft now
{ action: 'restore'; id: string }        // put it back; redraft now
{ action: 'check' }                      // arm pick mode
{ action: 'cancel-check' }               // disarm it
{ action: 'cancel' }                     // end without writing
```

`202` accepted; `404` when no recording is running for the session.

## 10. Errors the author can meet

| Situation | What they see |
| --- | --- |
| Cursor not in a step region | "Put the cursor on a step, or the blank line after one, under ## Steps." |
| A run is executing | "Stop the run before recording." |
| The server is headless | "Record Steps needs a visible browser: this server runs headless (browser.headed: false)." |
| No model configured | "Record Steps needs a model to write the steps; configure ai in aiui.config.json or .env." |
| The model's answer could not be read | "The steps could not be written: <reason>. Nothing was inserted." |
| A parameter name conflicts | "Parameter <name> already exists with a different value; the recorded value was not added." |
| The file for Record New Test exists | "<path> already exists." |
| Record New Test's tests folder is outside the workspace | "The project's tests folder (<path>) is outside this workspace, so Record New Test cannot create a test there. …" |
| The session was closed under the recording (another window's Run, Close Session, the idle reaper) | "The session was closed while recording." — a warning, nothing inserted |
| The result could not be inserted | "Record Steps: the recorded steps were not inserted — <reason>. They are in the TestBench output." with **Copy steps** |

## 11. Limits

- One straight path: loops, decisions and waits are not inferred.
- The actions of §4's table only.
- TestBench only; no MCP or CLI recording.
- Markdown only; compile the recorded test afterwards for code-behind.
- The Electron app is not covered.

## 12. Acceptance

- Signing in and paying by cash on `fixtures/test-app`, recorded into a new
  test, produces steps that run green with no edits.
- A password typed during the recording appears in no frame, no prompt, no
  log line and no file.
- Recording at a cursor inside a `### Section` body inserts there and
  renumbers only that body.
- One Ctrl+Z after insertion restores the file byte for byte.
- A dropped action produces no step.
- A check produces exactly one `Verify` step, and its click did nothing on
  the page.
