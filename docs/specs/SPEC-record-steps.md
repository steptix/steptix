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

The **file** shows the draft too, as it grows (§7): each draft is written
into the test where the steps will go — numbered, the rest of the flow
renumbered, its parameters under `## Parameters` — in place of the draft
before it, and the lines being recorded are highlighted. Stop writes the
result over the last draft; Cancel takes the draft back out.

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
scrolling, native dialogs, a second browser, the computer surface — and
anything inside a **closed** shadow root. Its events leave it retargeted to
its host and nothing outside can look in, so typing or choosing there is not
recorded (a Tab or Enter pressed there is, against the host). An **open**
shadow root is recorded like the rest of the page, including its `change`
events, which never leave the root on their own.

Not actions, though they look like one: the click a `<label>` passes on to
its control (a checkbox, a hidden file input, a button — the label's click is
the action; only that one click, in the same task: a later click on the
control, such as Tab to it and Enter, is the author's own); a
press-move-release inside a text field, which selects its text (the click it
ends with is a click into the field); Enter in a textarea, which is typing.
Enter in a contenteditable is decided by what it DID, once the keypress has
settled (100 ms, or the author's next key, click or focus change, or Stop,
whichever is first): a document editor that gained a line or a block is
typing; a chat composer that sent and emptied the box — or a box that was
removed, or did not change — is the typing up to the Enter, reported with the
text it held before the key, then a `key` Enter action. Add check reports any
typing still open before the check itself.

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

The name and text lose the icon glyphs, emoji and decorative symbols at their
ends — a link shown as "💳 Transactions" is named `Transactions`, "Next ›" is
`Next` — and the name as the page gave it travels beside it as `rawName`. A
step that names an element by its decoration breaks the day the icon changes,
and the model copies what it is shown.

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
- **Secrets are painted out.** Before a crop is kept, these are covered with
  a solid fill, on the whole screenshot, so no crop or scaling can bring them
  back:
  - every secret field on the page (§5 — a password box its "show" eye has
    flipped to text, or replaced with a new text box, included);
  - every element whose text shows a secret typed on that page (a "reveal"
    that copies the password into a `<span>`);
  - every field whose value holds a secret the recording knows (§5), and
    every run of text on screen that does. The page reports its field values
    and its visible text with their boxes and the server compares, so the
    known secrets never go into the page.

  Positions inside a frame are measured from the frame's content box, inside
  its border and padding. A frame that cannot account for itself costs the
  crop — it is not sent: one that does not answer in time, whose answer
  fails (mid-navigation it may still show its old document), that has no
  recording script, whose page is too big to report whole, or whose element
  cannot say where it is in time. Only a frame whose element has no box at
  all (hidden) is passed over. A secret field that is itself the target gets
  no crop while it shows its value in clear. Anything else visible is sent, as
  screenshots already are during runs.

## 5. Secrets

A field is **secret** when the DOM snapshot's secret-field rule says so: its
`type` is `password`; its `autocomplete` names a password; its `name`, `id`,
`aria-label` or `autocomplete` matches the secret-name rule; or its
placeholder matches the password-field rule. The recorder adds what the
snapshot cannot:

- **Memory of the field.** A field seen as secret once is secret for as long
  as its document lives. The "show password" eye flips a password box to
  `type="text"`, after which the rule no longer calls it secret; the recorder
  remembers it, catching the flip itself (the `type` attribute's old value)
  even when the author never touched the field before it. Typing into it,
  editing it after the flip, an Add check on it and every crop treat it as
  secret.
- **Memory of the value.** A toggle can also REPLACE the box — Vue's
  `v-if`/`v-else`, Angular's `*ngIf`, a React key change — with a new text
  box holding the same value, which nothing about the new element marks. So
  the page script also remembers, in the page and never sent, what each
  secret field holds (at every keystroke, and whenever it is asked about) and
  what each finished typing into one left. A field whose value IS one of
  those, or contains one of 4 characters or more, is secret (typing, an Add
  check, every crop); every element whose text shows one is painted out of
  the crops (§4.2); and every text the page script sends has them masked
  out. A field secret only because the name rule's bare `key` matched (a
  `keywords` search box) gives its value to this memory only when it looks
  like a credential — 8 characters or more, no spaces — so a search term is
  not masked out of the results page.
- **Its label.** A text field whose `<label>` names a password, passcode,
  passphrase, PIN, secret, token, one-time code or verification code — as
  whole words, not the field rule's substrings, so "Boarding pass number" is
  not one — is secret too, unless the label names another kind of field
  beside it ("Email for password reset", "Password hint", "Security
  question"): on a minimal sign-in form, the only name a flipped password box
  has left. (A box flipped before Record was pressed, on a page the recording
  script was not yet in, is caught by this rule or not at all.)
- **Its style.** A field styled `-webkit-text-security: disc`, `circle` or
  `square` shows dots, as a password box does, and is secret.

For a secret field:

- the page script reports only *that* it was typed into — the value is never
  read into an action, a frame, a log line, a prompt or a file;
- the step reads `Type {{name}} into the … field`;
- the parameter line is `- name: $NAME`, resolved from `.env` at run time as
  any `$VAR` parameter is;
- recording into a test that already fills that field from a parameter
  reuses that parameter.

**Known secrets.** From the first action, the recording also knows secret
VALUES: the session's secret-named variables, the file's secret-named literal
parameters, and the `.env` the request brought (TestBench sends the test's) —
every secret-named key's value, and what each `$VAR` parameter with a
secret-sounding name (or naming a secret-sounding variable) resolves to, the
request's `.env` first and the server's environment after. A value from the
`.env` that is known only because its VARIABLE's name sounds secret must look
like a credential: 4 characters or more (`RECORD_SECRET_MIN_LENGTH`, the
runner's floor for page-derived secrets) and not a boolean or a number —
`TOKEN_TTL_MINUTES=30`, `ENABLE_PASSWORD_RESET=true` and `MAX_TOKENS=2048`
are settings, and masked as substrings they turned a typed "1300" into
"1***0". A `$VAR` parameter the file itself names like a secret (`- password:
$LOGIN_PW`) keeps its value whatever it looks like.

A value typed anywhere — or read by an Add check — that IS one of them is
withheld like a secret field's and names its parameter; one that CONTAINS
one (of 4 characters or more) is withheld whole too, with no parameter
named: spliced, it became a parameter holding `***`. They are masked out of
everything the model is sent, in every spelling — as typed, as it reads inside
a JSON string (`pa"ss` is `pa\"ss` there), and as a URL carries it
(`encodeURIComponent`'s, a form's `+`, `encodeURI`'s) — before any text is
folded or cut: the page sends its text unfolded, and the server masks, then
folds whitespace, then cuts, so a secret holding a double space or a line
break still matches, and one that crossed the cut leaves no prefix behind.
They are masked out of every panel line, `record:started`, the server
warnings forwarded as `output`, and the recording's own log lines.

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

The steps go into the file **while recording**. Each draft (§8) is written
where the steps will go, by the rules below, in place of the draft before it:
the recorded block is replaced, not inserted again — the model may have
rewritten its last steps, so lines change as well as grow — the rest of the
flow is renumbered for the block's length now, and the draft's parameters
are merged under `## Parameters`. What a draft writes is decided by the file
as it stood at the first write and the draft alone, so the file after drafts
1…n reads as draft n alone would have made it. A draft older than the one
written is skipped.

**The rule over all of it: the recording never overwrites text it cannot
prove it wrote.** What it wrote is kept as text — the block's lines, the
parameter lines it added, and for each later step it renumbered the number it
gave it and the rest of that line — and before every write, that text is
checked to be where the recording left it (§7.4).

- **Stop** writes the result the same way, over the last draft. Nothing is
  inserted twice.
- **Cancel** — and a recording that ends in an error, or that the server
  ends — takes out everything the recording wrote: the block, the renumbering
  (every later step gets back the number it had), and the parameter lines it
  added, including a `## Parameters` section it created. A result with no
  steps does the same. Only what is found to be the recording's is taken out;
  a later step gets its number back only when its line still reads exactly as
  the recording numbered it.
- The **author's own edits** elsewhere in the file stay, and what the
  recording wrote is followed through them. An edit wholly **inside** the
  lines being recorded — some recorded text left on either side of it — is
  overwritten by the next draft; the first one is warned about, once per
  recording: "Lines being recorded are rewritten as the model updates them —
  edit them after Stop." Nothing else is warned about: not an undo, a redo, a
  revert or a reload. Replacing ALL the recorded lines at once is not an edit
  inside them: what was typed in their place is the author's.
- **Edges.** Whole lines typed at the start of the first recorded line go
  above the block. Typing at the start of the line after the block is that
  line's. A line break typed at the end of the last recorded line (End,
  Enter) starts a line of the author's **below** the block: a step typed on
  it stays, and the next draft writes above it.
- **Later steps.** A later step's number belongs to the recording while its
  line starts with exactly the number the recording gave it. Anything that
  touches the line's start or its number — text typed in front of it, the
  line indented, the number edited, the line deleted — makes that line the
  author's: it is not renumbered, and Cancel does not give it its number
  back, unless the whole line is found again, exactly (the author pressed
  Enter after the text they typed in front of it, say). The rest of the line
  after the number is the author's to edit throughout.
- The lines being recorded — the steps and the parameter lines — are
  **highlighted** until Stop or Cancel, and only while they are known to be
  where they are. When the editor shows where the steps go, it follows the
  block as it grows.
- The file is **never saved** for the author. A draft that arrives while the
  file is in no visible editor still goes into it (a workspace edit); Stop
  shows the file, as insertion always has.
- A file **renamed** while recording is followed: VS Code opens it under the
  new name with the same unsaved text, and the drafts and the result go on
  going into it there.
- A file **closed** while recording is not written again: the panel keeps
  drafting, and the result is rescued as in §7.1.

**Undo.** One Ctrl+Z after Stop takes the whole recording out. Measured in
VS Code 1.95: the drafts and the result are one undo step, and that undo
restores the file byte for byte and clears its unsaved mark. VS Code closes
an open undo step when the author types in the file, moves its cursor, or
saves it, and a draft written while the file is in no visible editor is an
undo step of its own; when any of that happened, the result is written as two
steps — the drafts taken out, then the result — so the one Ctrl+Z still lands
on the file without the recording, the author's own edits kept (the file
stays marked unsaved). An undo or redo during the recording is one of those
too: one Ctrl+Z after Stop still lands on the file without the recording.
Undoing further walks back through the drafts. After Cancel the file reads as
it did, still marked unsaved; its history then holds one undo step that
changes nothing. A result inserted once at the anchor (§7.4) is an undo step
of its own, and one Ctrl+Z takes out exactly that insertion.

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
blank line between them. A table is what the runner's parser calls one: a
line holding an unescaped `|` with a delimiter row directly under it, the
pipes at a row's ends optional (`user | pass` / `--- | ---` / `a | b` is a
table), its rows running on while each line holds an unescaped `|`. A line
with pipes and no delimiter row under it is not a table; under a step it
continues that step.

The line the steps go after is followed through every edit made to the
document until the first draft is written, which fixes the place: lines
added or removed above it move it, and a renumber that rewrites its number
does not lose it. Only when that line itself is deleted is it looked for
again by its text; when that fails too, the steps go at the end of the flow
the line was in — not of `## Steps`, whose end is inside the last section —
and the author is told. From the first write on, what the recording wrote is
what is followed.

A result is never lost. One that cannot be written — `## Steps` deleted
before anything was written, the file closed or deleted while recording (a
rename is followed, §7), the edit rejected three times, or the drafts not
found and the anchor's flow gone (§7.4) — is written to the TestBench
output, and the error offers **Copy steps**; any draft still found in the
file is taken out. A result with no steps (nothing recorded, or every action
dropped) is said as the server's note, as information rather than an error.

### 7.2 A new test

**Record New Test** asks for a name, and creates `<tests dir>/<name>.md` —
the project's `tests.dir`, or `./tests` beside its `aiui.config.json` when
it declares none (the server's default) — refusing if it exists, and
refusing, before anything is created, a tests folder outside the workspace.
The project is the nearest `aiui.config.json` above the active editor,
within the workspace folder. When that finds none (no editor open, or one
outside any project) the workspace folder is searched a few levels down,
past `node_modules`, `dist` and dot-folders: one config found is the
project; several, and the author is asked which — before the name, so the
name prompt can say where the file goes. None at all: the fixed start of
`testbench-native.testsGlob`, else the workspace folder. The file:

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

### 7.4 Finding what the recording wrote

Most edits can be followed by position: an edit above what the recording
wrote moves it, one below leaves it, one inside it is taken in. Some cannot,
because VS Code reports them as line diffs that reach across the recorded
lines' edges, or as one change over the whole document:

- an **undo** or **redo** (whatever it undoes — the author's typing or a
  draft);
- **File: Revert**, a save conflict resolved by reverting, and a **reload
  from disk** (a checkout while the file is saved, with auto-save on): the
  change that leaves the document with no unsaved changes, which the
  recording did not make;
- a **line-ending change** (LF to CRLF), or any other extension replacing
  the whole document;
- any edit that is partly inside what the recording wrote and partly out.

After one of those, before anything is written, what the recording wrote is
looked for by its text — the last draft's, then each earlier draft's (an
undo can bring any of them back, including one from before the recording
started over at its anchor): its block as one run of whole lines exactly
once in the file, below the anchor, its parameter lines exactly once, and
nothing else of any draft's left outside them. Line endings are compared
after converting the recording's text to the file's.

- **Found:** the recording carries on from there — the next draft replaces
  it.
- **Nothing of it left** (not one line any draft wrote is in the file more
  often than it was before): the next draft goes in afresh at the anchor, as
  the first one did. The anchor must be found — where it was followed to,
  else by its text; failing that, as below. This is an undo that took the
  drafts out, a revert, a reload to a version without them.
- **Anything else** — part of it left, all of it there twice, or lines the
  author edited inside it since the last draft: the recording **stops
  writing into the file** for the rest of this recording. The author is told
  once: "The recorded steps could not be found in the file any more, so they
  are no longer written live; the panel keeps them and Stop will insert them
  at your cursor line." The panel keeps drafting, and nothing is highlighted.
  **Stop** looks once more and, finding it, writes the result over it;
  otherwise it inserts the result once at the anchor, into the file as it is
  — the one-shot insertion every result used before drafts were written live
  (the anchor where it was followed to, else by its text, else the end of its
  flow, said) — and what is left of the drafts is left for the author. When
  even that cannot be written, the result is rescued (§7.1). **Cancel** takes
  out only what it can still find; when it finds nothing, nothing is taken
  out, and the panel's log says so.

### 7.5 A window closed while recording

When the window closes or reloads, or the extension host restarts, while a
recording runs, the recording is cancelled and its draft taken out if the
extension still has a moment to do it (best effort). A window reload usually
does not give it that moment: hot exit backs the unsaved file up — draft and
all — before extensions stop.

So after every write, what the recording has written into the file — the
file, the block's lines, the parameter lines it added, each later step's
number, the number it had and the rest of its line — is kept in the
workspace's state (following the file through a rename), and forgotten when
the recording ends — unless taking the draft out at the end was tried and
the edit did not go through, as when the window goes first. At the next
activation, one still kept whose block and parameter lines are in that file
**exactly** once is offered for removal: **Remove the unfinished recording's
steps** (the empty draft, found by text: the block and parameter lines out,
each later step whose line is exact given its number back) or **Keep them**.
One whose lines were edited since, or are gone, is not offered. The kept
record is forgotten either way.

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
recording ends with an error and the drafts are taken back out of the file.

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
`done` `aborted`; a draft call in flight is abandoned. That holds at any point
before `record:result` — after `stop` too, while the final draft is being
written: no result is sent. A session closed under the recording ends it the
same way, saying why: `done` `aborted` with `error: "The session was closed
while recording."`. `done` is always the last frame.

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
| The author edits a line being recorded | "Lines being recorded are rewritten as the model updates them — edit them after Stop." — a warning, once per recording |
| What the recording wrote can no longer be found in the file (§7.4) | "The recorded steps could not be found in the file any more, so they are no longer written live; the panel keeps them and Stop will insert them at your cursor line." — a warning, once per recording |
| A recording was cut off by a window reload and its draft is still in the file | "Record Steps: a recording was still running when the window closed, and its draft steps are still in <file>." with **Remove the unfinished recording's steps** and **Keep them** (§7.5) |
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
- The file shows each draft as it arrives, in place of the last; Cancel
  restores it byte for byte.
- No undo, redo, revert, reload, line-ending change, rename or edit of the
  author's while recording makes a draft, the result or Cancel delete or
  change a character the recording did not write (bar a later step's number
  while its line is exactly as the recording numbered it, and an edit wholly
  inside the recorded lines, warned about).
- One Ctrl+Z after Stop takes the whole recording out — byte for byte when
  nothing else changed the file while recording.
- A dropped action produces no step.
- A check produces exactly one `Verify` step, and its click did nothing on
  the page.
