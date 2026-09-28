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
| **TestBench: Pause Recording** / **Resume Recording** | while recording | Nothing is recorded, and no draft call starts, until Resume (stories/testbench-record-toolbar.md §"Pause and resume, in detail") |
| **TestBench: Add Step to Recording** | while recording, palette, panel | Asks for a step and adds it exactly as typed; several lines are several steps (§7.6) |

While recording, the editor title bar shows Stop, Add check and Pause (Resume
while paused) in place of Run and Record, and the context key
`testbench-native.recording` is set; `testbench-native.recordingPaused` is set
while paused.

The same controls — Pause, Add check, Add step, Undo, Stop, Cancel — are in a
toolbar inside the recorded page (stories/testbench-record-toolbar.md), the
server's half. The setting `testbench-native.recordSteps.browserToolbar`
(default on) turns it off; where the author docks it, and whether it is
minimised, is remembered in the workspace's state between recordings and sent
in the next start body (§9.1).

### 3.2 The panel while recording

- A **Recording** block listing each action as it happens:
  `● Clicked button "Sign in"  0:07`. Each row has a **✕** that drops it —
  dropped rows are struck through, click again to restore — and dropped
  actions are left out of what the model is shown.
- **Steps so far** — the draft the model has written from those actions
  (§8), numbered, updated a moment after each action, with an **updating…**
  marker while a draft call is running.
- **Add check** as a toggle that shows whether pick mode is armed — disabled
  while paused ("Resume to add a check").
- **Pause** / **Resume**, a toggle showing what the server's `record:paused`
  said (the browser's toolbar can pause too). The action list gets a
  `❚❚ Paused` or `▶ Resumed` row where it happened; markers are not actions
  and have no ✕.
- An **Add step** box: Enter adds what is in it (Shift+Enter starts another
  line — one step per line), exactly as typed. The box keeps its text until
  the server has taken the steps; when it does not (the recording is
  finishing, the server answers `ignored`), the text stays with the reason
  under it. Each step of the author's —
  from the box, the palette, the browser's toolbar or the test file (§7.6) —
  is a `✎ Your step: …` row in the action list, with a ✕ that drops it by its
  id like an action. A drop or restore made in the browser (its Undo,
  Restore) strikes or restores the row (`record:dropped`).
- **Steps so far** marks each of the author's steps, and each they reworded
  (`record:draft.edited`), with a `yours` tag — and no lock: nothing is locked
  against the author (stories/testbench-record-edit-steps.md, decision 1).
  Each step has a **✕** that deletes it by its id (`drop`, §9.3) — a step the
  model wrote with the recorded actions behind it (§8) — and the file's line
  for it goes at once. A deleted step stays in the list, struck through where
  it was (after the step that was before it), with **Restore**, until it is
  restored — from here, the browser's drawer, or Ctrl+Z of its line in the
  file (§7.6). The actions a delete dropped are struck in the action list
  (`record:dropped.actions`), and the ✕ on each still restores that one alone.
  A step reworded anywhere is a `✎ Edited step 4: …` row in the action list,
  saying where (the browser, the file, the panel) — a marker: an edit is
  undone where it was made, not from here. Editing stays in the file and the
  drawer. A server whose drafts carry no step ids offers none of this: no ✕ on
  a step, and the log says once that recorded lines are written over while
  recording.
- **Stop** and **Cancel**.
- After Stop, **Finishing…** until the result arrives — immediate when the
  draft already covers every action.

The status bar reads `● Recording — N actions`, and `❚❚ Recording paused — N
actions` while paused. A Cancel pressed in the browser ends the recording as
TestBench's own Cancel does, quietly: the drafts come out of the file and the
log says "Recording cancelled in the browser — nothing was written." — no
notification, no error.

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

### 3.4 The toolbar in the browser

The server puts a toolbar into the recorded page (stories/testbench-record-toolbar.md,
which has the design and every state): a dark bar docked bottom centre with
the recording's status (`● REC 02:14 · 9 actions`), **Pause**, **Add check**,
**Add step**, **Undo**, **Stop**, **Cancel** and a minimise button, and a
second row showing the last step as written — or a hint, the step box, a
confirmation or an error. It is in the top-level document of every tab and
popup, comes back after every navigation, and shows the one state the server
pushes to all of them. Frames get no bar, but draw their own pick outline and
take the shortcuts.

| Control | Shortcut |
| --- | --- |
| Pause / Resume | Alt+Shift+P |
| Add check (again to disarm) | Alt+Shift+C |
| Add step (Enter adds, Esc closes and keeps the text) | Alt+Shift+S |
| Undo (Restore on the confirmation) | Alt+Shift+Z |
| Minimise / open | Alt+Shift+M |
| Put keyboard focus on the bar (arrows move, Esc gives it back) | Alt+Shift+R |
| Stop, Cancel (Cancel asks first: Discard / Keep recording) | none |

- **Pause** finishes the typing still open, then records nothing — no
  action, no crop, no pick, none of the navigation the server detects itself —
  and starts no draft call for new actions (a call already running finishes).
  **Resume** re-reads each tab's history as the new starting point and takes
  the first tab acted in as where the author is, with no `tab`; the first
  thing recorded after it carries `afterPause` for the model, and paused time
  is left out of every gap and of the clock. The page shows Paused the moment
  it is pressed; a Pause the server refuses, or does not answer within 3 s, is
  taken back in the page (so is a minimise, a move, an Esc out of Add check,
  and a step leaving the box, whose text goes back into it).
- **Add step** is §7.6's step from the toolbar's box. **Undo** takes out the
  most recent entry still in — an action, an event, a check or a step of the
  author's — as the panel's ✕ does, and walks further back when pressed again;
  **Restore** puts the last one back. When that entry is the last one a step
  the author reworded stands for, Undo takes the step out with it — one Undo,
  the action and its step, deleted as the drawer's ✕ deletes it (the bar says
  `Removed: … and your step "…"`) — and Restore brings both back. (The panel's
  ✕ on that action keeps the reworded step instead, and says once, as an
  `output` line, "Your reworded step N stays — delete it if you meant to.")
- **Steps so far**, the drawer the status row opens, lists the draft
  numbered, `yours` on the author's own steps and on the ones they reworded,
  and no lock: nothing is locked against the author
  (stories/testbench-record-edit-steps.md). Clicking a step's words — or
  Enter on a focused row — edits it in place: Enter saves (§8, "The author's
  edits"), Esc cancels, an empty save removes it. **✕** removes a step — one
  the model wrote with the recorded actions behind it (§8) — and the row stays
  struck through where it was, with **Restore**, until the next step lands;
  the bar says `Removed "…"` with Restore too, whoever removed it (the drawer,
  the panel or the test file). The **+** in the gap below a row opens Add step
  aimed there ("Goes after step 3"): the step joins between the two, as a line
  typed there in the file does (§7.6). Tab moves round the bar — its buttons,
  the status row, the drawer's rows and their ✕ and + — and never out into the
  page; the arrow keys move from row to row, Delete removes the focused one,
  and focus shows. A change shows at once and is taken back when the server
  refuses it. The drawer scrolls past about eight rows and opens away from the
  docked edge.
- **The drawer keeps focus and words.** A re-render never drops keyboard
  focus into the page, where the next Tab or Enter would be recorded: focus
  stays on the same row or button, else on the row now at its place (a
  redraft replaced the step, a struck row went), else on the Steps so far
  toggle or the bar's first button; the + in a gap shows while the keyboard is
  on it. While a step is edited in place the other rows go on changing around
  it — a ✕ elsewhere strikes its row at once, a new draft shows — and the box
  keeps its words, caret and focus; a step the model rewrote meanwhile keeps
  its box where it was, and Enter sends the edit with the id it had. An open
  edit with changed words is **saved**, as leaving a field saves it, by +, Add
  step, the Steps so far toggle, Stop, Cancel, a click on another step's words,
  and the page going away (sent as the document goes, `pagehide`); only Esc
  throws it away, and a stray click on the page leaves it open. A save of
  nothing of the author's — empty, or a lone number or list marker such as
  `3.` or `-` — is a delete. A double-click on ✕ deletes once: the second
  click is not a Restore, and the struck row's Restore does not show where the
  ✕ was until the pointer moves; the second click of a double-click on + never
  reaches the page. A key the bar used (Enter saving an edit) held down does
  not repeat into the page's field.
- **Stop.** Every Add step, Undo and Restore accepted before Stop is carried
  out before the steps are written — one waiting behind another's model call
  included; an edit or a removal from the drawer is carried out the moment it
  arrives. From the toolbar after Stop, a step, Undo, Restore, Pause, Add
  check, an edit or a removal is refused: the bar says so (through "Writing
  the steps…"), a step's words go to the panel as a warning and onto the end
  line ("Done · 12 steps written to pay-by-cash.md · 1 step typed after Stop
  was not added"), and an edit's words go to the panel as a warning.
- **Typing hidden** shows while a secret field (§5) has focus in any frame of
  any tab — also one that already had focus when the recording reached its
  document (an autofocused password box, the one the author was in when
  Record was pressed) — and goes when focus leaves it, or its frame or page
  goes (a sign-in popup that closes itself). A confirmation or an error
  (Added…, Removed… Restore, Couldn't update…) and the paused line show over
  it.
- **Once it is not recording** (writing, done, ended) the bar takes no pointer
  events but its Close button's: a click on the page under it lands on the
  page. A run started on the session takes the bar out of every page before
  its first step, so the run never clicks it and no screenshot shows it.
- **A native popover the page has open** (`popover="auto"`, a menu) closes
  when a toolbar button is clicked: HTML light-dismisses it on the pointer
  going down, before anything the bar could do. The shortcuts do not touch it
  — Alt+Shift+C arms Add check with the menu still open.
- It is kept out of the recording (§4, §4.2): its clicks and keys never reach
  the recorder or the page's listeners, it is painted out of every crop, and
  nothing of it is in any description.
- The page cannot drive it: every toolbar message carries a token the server
  gave that document alone (§9.4).
- It needs nothing the page's Content-Security-Policy could refuse: a closed
  shadow root styled by one adopted constructable sheet and per-property
  `style.setProperty` on its host, built without HTML strings (Trusted Types),
  in the system font. Measured under `default-src 'none'; style-src 'none';
  script-src 'none'`, with and without `require-trusted-types-for 'script'`:
  the styled bar shows and works.
- It checks in with the server every 2 s; two unanswered in a row — a
  refusal counts as unanswered, and so does a document that has no token to
  ask with — show "The recorder isn't answering…", which clears when an
  answer comes.
- `toolbar.enabled: false` in the start body (§9.1) puts no toolbar in the
  page, and no shortcut is taken from it; the recording is otherwise the same.

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

**Nothing is captured while the recording is paused** (§3.4) — not an action,
not an event, not a crop, not a Back, a Reload, an address or a new tab. The
page stops at once, and what it sends anyway (a frame the pause has not
reached yet) is refused on arrival, in the order the binding delivered it:
what the page sent before its pause is kept.

**The recorder's own toolbar is never captured** — its drawer, its step box
and a step being edited in place included. Its host is a closed shadow
root, so every event from it reaches the page retargeted to the host; the
recorder's first listener on `window` (an init script's, so the first one
registered in every document loaded during the recording) handles those
events itself and stops them there — they are never an action, never typing,
never a focus change, and the page's own listeners never hear them. Pointing
at the toolbar still finishes the typing open in a field, as pointing
anywhere does. The host is left out wherever the recorder asks
`elementFromPoint` or `document.activeElement`, and nothing inside a closed
root is reachable by the queries and text walks a description is built from.

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
  - the recorder's own toolbar (§3.4): the top frame reports its box beside
    its secret fields, and it is filled the same way, so the model never sees
    it and a run — which has no toolbar — never looks for it. The model is
    told a solid dark box is a secret or the recorder's controls, and to name
    neither. A toolbar that is there and cannot say where costs the crop.

  Add check's outline and label sit on the very element a crop is about, so
  they are not painted: they are taken down before any crop is asked for.

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
warnings forwarded as `output`, and the recording's own log lines. One the
author types into a step of their own is written as `{{name}}` (§7.6).

A value typed into a secret field **on the page** is not one the server
knows — the page never sends it — so the server could not keep it out of a
step the author writes. The page does instead: an edit in the drawer or an
Add step from the toolbar's box holding one of the values it remembers (the
memory above, the same match its masking uses) is refused before anything is
sent, and the bar says `That has a password typed on this page in it — write
{{password}} (or the field's parameter) instead.`; the edit or the box stays
open to put it right. The box's unsent text goes to the server with those
values masked.

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
  added, including a `## Parameters` section it created — and the recorded
  lines the author reworded (§7.6), since they describe actions Cancel throws
  away. A result with no steps does the same. Only what is found to be the
  recording's is taken out; a later step gets its number back only when its
  line still reads exactly as the recording numbered it. A draft of the
  server's with no steps (the author deleted every one) takes out only the
  recording's own lines: theirs stay.
- The **author's own edits** elsewhere in the file stay, and what the
  recording wrote is followed through them. With a server whose drafts name
  their steps (`record:draft.ids`), the author edits the recorded lines too, as
  they please (§7.6, "Editing and deleting recorded lines"): a line they reword
  is theirs from the first keystroke, a line they delete is its step deleted,
  and nothing about either is warned. With one that names none, an edit wholly
  **inside** the lines being recorded — some recorded text left on either side
  of it — is overwritten by the next draft; the first one is warned about, once
  per recording: "Lines being recorded are rewritten as the model updates them
  — edit them after Stop." (so is a blank spacing line the recording keeps — a
  table's, a heading's — typed on, either way). Nothing else is warned about:
  not an undo, a redo, a revert or a reload. Replacing ALL the recorded lines
  at once is not an edit inside them: what was typed in their place is the
  author's (with step ids: each step reworded, or deleted).
- **Edges.** Whole lines typed at the start of the first recorded line go
  above the block. Typing at the start of the line after the block is that
  line's. A line break typed at the end of the last recorded line (End,
  Enter) starts a line of the author's **below** the block: a step typed on
  it stays, and — until it counts as a step (§7.6) — the next draft writes
  above it. Whole lines put in between two recorded lines are the author's
  too (§7.6), not an edit inside the recorded lines. With step ids, a
  recorded line joined across the edge — Backspace at the start of the first
  recorded line, Delete at the end of the last, a selection from above the
  block typed over — is that step's line, being edited (§7.6), and a line
  moved past the edge (Alt+Up/Down) is followed as a move: neither stops the
  writing.
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
While recording, a draft that would only give steps their numbers, arriving
while the author's own edit is the last change to the file — the server's
answer to a line they deleted — is not written then: written, it would be the
undo step on top of theirs, and their Ctrl+Z would take back the renumbering
instead of their delete. Measured in VS Code 1.95: an editor edit with
`undoStopBefore: false` does not join the undo step `editor.action.deleteLines`
leaves (one Ctrl+Z then undid only the edit), it joins only typing that no
cursor move has closed, and a WorkspaceEdit never joins one. So one Ctrl+Z of
a deleted line brings it back (and restores its step, §7.6); the numbers catch
up with the next write that changes anything else, or at Stop.
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
  flow, said) — and what is left of the drafts is left for the author. It
  never puts a step in twice: a step whose line the recording wrote is still
  in the file word for word (its number aside, and more often than the file
  had that line before recording) is left out, as the author's own lines are
  (§7.6), and each run of what is left goes in after the line of the step
  before it in the result — at the anchor when none is — so the file keeps
  the result's order around the lines still there; all of it one undo step.
  When even that cannot be written, the result is rescued (§7.1). **Cancel**
  takes out only what it can still find; when it finds nothing, nothing is
  taken out, and the panel's log says so.

With the author editing recorded lines (§7.6), the states an undo can bring
back are more than the drafts', and the search knows them all
(stories/testbench-record-edit-steps.md):

- **Undo, measured.** In VS Code 1.95 an undo reports the exact inverse of the
  edits it undoes — the author's typing, a line deleted, a write of two ranges
  alike — never line diffs. So an undo or redo whose every change lies within
  one line of the author's text is their typing on that line undone, and is
  followed by position as the typing was; an undo on a recorded line that no
  earlier state of the file explains is followed the same way (it is an edit
  of the line). Every other undo is looked for by its text, as above.
- **The file just before each of the author's edits** that changed what the
  recorded lines are — a line reworded, deleted, added — is kept beside the
  drafts', so the undo of that edit is found by it: Ctrl+Z of a deleted line
  of a step brings back the state that held it, which is its step restored.
- **The state that says the most.** Newest first, as before; but an earlier
  state that is the same run with more of it in the file — a line of it the
  author deleted at its edge, which Ctrl+Z put back — is taken over the newer,
  smaller one.
- **A run with no words** — every step's line deleted or emptied, the
  author's blank lines left, or nothing — is never unique in a file by its
  text: it is looked for where the steps go, after the anchor (and, with
  nothing in it, by the later steps it renumbered), and taken only if it is
  exactly there. A run of the author's lines alone is found by them.
- What the author did to the steps is not undone with the text: a line sent
  once is never sent again, a step whose line is gone again is deleted again,
  and a line reworded, whose rewording went to the server, that an undo put
  back as the recording wrote it is the author's line again — its words go to
  the server at once (§7.6), rather than the next draft writing the rewording
  back over the undo.
- **Read again, line by line.** An edit of the author's the offsets cannot
  follow — one reaching across the edge of the recorded lines or of a line of
  theirs among them, or Alt+Up/Down (VS Code reports a line deleted and put
  in again on the other side of its neighbour, in one event) — is not given
  up on: the run is read again (`rereadRun`). The recorded text is mapped
  through the change; each line the run had either survives on some line now
  (moved, renumbered or edited — two made one are the first's) or is gone,
  its step deleted; a new line with no old line on it is the author's, and
  one with the words of a line that went is that line, moved. Only when that
  cannot follow it either (no ids, the parameters touched, nothing of the run
  left) is the recording looked for by its text.
- **Moved out.** A line of the run moved above the line the steps go after
  has left the recording, as lines above the block are outside it (§7): its
  step is deleted and its text is the author's — kept on the record
  (`LiveRecord.outside`), so that looking for the recording by its text does
  not count it as the recording's text left elsewhere. So is a later step the
  recording renumbered, moved above the run. A recorded line that took in the
  anchor's own line (Backspace at its start) is found at that line.
- The states kept for an undo include one holding only lines of the
  author's (every recorded line deleted, their typed lines left): Ctrl+Z of
  the recording's next write brings it back, found by those lines.

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
steps** (the empty draft, found by text: the block and parameter lines out —
recorded lines the author reworded with them, lines they typed kept — each
later step whose line is exact given its number back) or **Keep them**.
One whose lines were edited since, or are gone, is not offered. The kept
record is forgotten either way.

### 7.6 Steps the author writes

The author can write steps into the recording themselves
(stories/testbench-record-toolbar.md §"Steps you write"). Each is **locked**
with everything recorded before it (§8), goes in exactly as written — a
leading number or list marker is the recording's to give — and is a
`✎ Your step` row in the panel (§3.2).

- **From the panel, the palette or the browser's toolbar:** the step is the
  recording's text, like any other — the drafts write it into the block, and
  Cancel takes it out.
- **In the test file:** a line typed below the last recorded line (End,
  Enter), or put in between two recorded lines. Lines above the first
  recorded line stay outside the recording. The line **counts** when the
  cursor leaves it (moves to another line, Enter, or the file is shown in no
  editor) with a step on it, and when the author leaves VS Code (the window
  loses focus — the cursor's line included); a blank line, or a bare number,
  never counts, and one a cursor is on is still being typed. Only a line that
  is a step, or becomes one when the recording numbers it (text or a list
  item under `## Steps`), counts: a heading, a data table, a fence, an HTML
  comment — or anything below a heading that ends `## Steps` — is the
  author's text and never sent. Then TestBench sends `add-step` with
  `source: 'editor'`, `afterStep` the index of the step it follows in the
  draft that was in the file when the line counted (absent when nothing the
  recording wrote is below it) and `revision` that draft's (§9.3). Lines that
  count together between the same two steps of that draft are one
  `add-step`, several lines in order. A line **waits** while another line of
  the author's between those same two steps was sent and no draft in the file
  holds it yet: both would name the same step, and the server would put them
  in whichever order it takes them. It goes after the next draft write, naming
  its neighbour. **Stop** — TestBench's, or the browser's as `record:writing`
  arrives — first sends every line that counts, the cursor's included, waiting
  for nothing, after the add-steps already on their way. A call that fails, or
  that the server answers `ignored`, leaves the line the author's text in the
  file — said in the log, never sent again. Two sent for the same place in
  the same draft go in in the order they were sent: the second after the
  first (the server's guard behind the wait above).
- **A secret the recording knows** (§5 — the session's, the file's, the
  `.env`'s) in a step from the panel or the toolbar is written as a typed one
  is: the value, in every spelling the recording masks, becomes `{{name}}` —
  the parameter it came from — and the draft gains `name: $NAME` (§5, as for
  a secret field) unless the file already defines `name`. The step, its `record:step`,
  every draft and the result carry `{{name}}`; the value never crosses. From
  the editor it cannot be: that line is the author's own text, which the
  recording does not rewrite, so the `add-step` is answered `ignored` with
  what to write in its place (`{{password}}`), and the line stays theirs.

A line the author typed in the file is **theirs**: the recording never writes
it and never takes it out — bar Undo of its step, and newer words for its step
from the browser's drawer or the panel (both below). Drafts are laid out
around it. Until a draft holds its step (`record:draft.authored` /
`authoredIds`, the id `record:step` named — or, when the draft arrives first,
or `authoredIds` is absent, the step whose text is what the line was sent as),
it divides the draft by count: as many steps above it as the file has now (for
a line below the block, all of them — "the next draft writes above it"; and a
line sent from below the block is below it until a draft holds it, for the
lines above it too). Once a draft holds it, that step IS the line: it is not
written beside it; the steps before it go above, the ones after it below. Its
**leading number** follows the recording's numbering while the draft holds it
— the digits of an `N.` line (after any indentation), or a list marker, `N)` or
nothing replaced by `N. ` (an indented line with no number, or one with no step
left on it, is left alone) — and is given back when the draft no longer holds
it, and by Cancel. A number the author changes after the recording set it —
or after the first draft that held the line found it already right — is
theirs for good, as a later step's is.

- **Undo of a step typed in the file** (the browser toolbar's Undo, or the ✕
  on its row): the line comes out of the file at once, when it still reads
  exactly as the recording last left it, number included; the row and the
  file agree. Restore (↺, or Restore in the browser) puts it back where it
  was, and Cancel puts it back with the number the author gave it. A line the
  author has edited since stays, and the log says so once: "Your step N was
  left in the file because you edited it — delete it if you meant to." (a
  line with no number of its own: "Your step on line N …" — never its words,
  which may hold a secret the server refused).
  A step from the toolbar or the panel that is dropped comes out of the file
  at once too (it is the recording's line).

- **A draft changes only what differs.** Each draft changes a block only
  where it differs from what is there: its lines and the draft's are matched
  by their words, in order, a leading number aside, so a line that stays is
  never rewritten because lines went in or out around it, and a line whose
  only change is its number has only the digits replaced.
- **Cancel** (and the recording's own taking-out: an error, the drafts taken
  out before the result) takes out everything the recording wrote — the
  author's toolbar and panel steps included, and the recorded lines they
  reworded, and a recorded line they emptied that still has no words on it —
  and keeps every line the author typed as a new step, with the number they
  gave it. **One Ctrl+Z after Stop** lands on the file without the recording,
  the typed lines still there: typing in the file split the recording's undo
  step, so the result was written as two (§7).
- **The result** (`record:result`) does not say which of its steps are the
  author's: they are where the last draft had them — or, if the final call
  moved one, the next step with the same text — and their lines are adopted
  as a draft's are. A line sent at Stop that no draft held yet is the
  result's step with the text it was sent as.
- **Found by text** (§7.4): the block and the author's lines in it are looked
  for together, as one run of lines. A record holding lines of the author's is
  never "nothing of it left" while one of those lines is still in the file (a
  draft written afresh would put that step in a second time, beside it): the
  recording stops writing live instead.
- **A draft that holds the author's lines in an order the file does not have
  them in** (two add-steps aimed at one step, placed the other way round) is
  laid out by count, not given up on: each line the draft holds is still its
  step and never written beside it, the draft's other steps are divided around
  the lines by how many the draft has before each, and every step is numbered
  in the order the file has them.
- **A line the author deletes** closes the block up again. With a server that
  names its steps it is its step deleted too (below); with one that does not,
  a step the draft still holds for it is written by the recording from then
  on, as its own — the ✕ on its row leaves it out.
- **After a window reload** (§7.5) what is kept names the author's lines too,
  and "Remove the unfinished recording's steps" keeps the ones they typed.
- The one-shot insertion at Stop after the recording gave up on the file
  (§7.4) inserts the result without the author's steps whose lines are still
  in the file (known by id, or by the text they were sent as) — those lines
  stay where they were typed, and are never put in twice — nor the steps whose
  recorded lines they reworded and are still there (known by the last
  draft's ids, placed in the result), nor those whose recorded lines are
  still there word for word; the rest goes in around them in the result's
  order (§7.4). What is left of the drafts is the author's to tidy, as before.
- **Stop keeps the order.** A line of the author's the result does not hold
  (a typed line the server did not take, a reworded one whose step was
  rewritten or deleted since) stays among the steps where it was. When the
  drafts are taken out before the result goes in (the author typed while
  recording, §7), each part of the run counts as holding what it held until
  then (`RecordSlot.clearedSteps`, `clearedHeld`), so the result is laid out
  around the line as it would have been over the draft — not with the line at
  the top of the block, or at its end.

**Editing and deleting recorded lines** (stories/testbench-record-edit-steps.md
§"In the file"). With a server whose drafts name their steps
(`record:draft.ids`), TestBench keys every recorded line to its step's id, and
no step is locked against the author:

- **A recorded line changed** is **being edited** from the first keystroke
  that changes its words: it is the author's line (as one they typed), which
  the recording never writes again — it goes on writing the lines around it
  and numbering this one, whose number stays the recording's (the author's
  number on it is written over). It is the step it was: a draft holding that
  step's id holds the line, and nothing is written beside it. It counts at the
  moments a typed line counts — the cursor leaves it, the window loses focus,
  Stop — and then goes as `edit-step` with the step's id, the words (the
  line's leading number or marker aside), `source: 'editor'` and the revision
  of the draft in the file (§9.3). A draft that shows the step with those
  words, `edited`, is the line; so is a `record:edited` naming them, whichever
  id it names (the model had rewritten the step meanwhile, and the server put
  the edit on the step that stands for its actions now): the line is that
  step from then on. Until then, a draft that no longer holds the step it was
  (the model rewrote it) writes its new step beside the line, where the old
  one was, and nothing more.
- **Its number alone changed** is no edit: the line stays the recording's,
  and the next draft gives it its number back. **Changed back** to its
  words before anything was sent, it is no edit either: it is the recording's
  line again.
- **Left empty, or only a number,** it is a delete: `drop` with the step's
  id. The line stays as the author left it, a line of theirs with no step on
  it; Cancel takes it out while it still has no words, and words typed on it
  make it a new line of theirs, sent as any typed line is.
- **Whole lines deleted** — one, several, or recorded lines and the author's
  together — are a `drop` of each line's step as soon as they are gone (a line
  of theirs typed and sent before its step had an id is dropped when
  `record:step` names it). The step is left out of every draft written from
  then on, so a draft already on its way does not put it back.
- **Ctrl+Z** of a deletion, or of emptying a line, is a Restore: the line back
  is its step back — `restore` with its id, or, when the `drop` has not gone
  yet, neither. One press does it: the server's answer to the delete, which
  only renumbers, waits (§7, "Undo").
- **Moved** — Alt+Up/Down, or a line cut and pasted back among the recorded
  ones: a changed line whose words (its number aside) a recorded line had is
  that line; it keeps its step's id, and nothing is sent. Of the lines
  moved, the most still in their order stay the recording's; the others are
  the author's where they put them (`RecordSlot.moved`): the recording writes
  their number, never their words, and lays the draft out around them by what
  the file has above them, not by where the draft has their step, so the next
  draft keeps the author's order. If the model later rewrites the step of
  such a line, its words go as an `edit-step`, which puts the step back under
  its id — rather than leaving the model's new step beside it.
- **A line with the words of a step this file deleted** (and not restored),
  back among the recorded lines — cut and pasted, or deleted and typed again —
  is that step restored, where the author put it (`restore`, or neither
  control when the `drop` had not gone), not a new step with no actions. A
  Restore of the same step from the panel afterwards cannot put it in twice:
  the line holds it by its id.
- **Joined across the block's edge** (Backspace at the start of the first
  recorded line, Delete at the end of the last, a selection from above the
  block typed over): the line is the recorded step's, being edited
  (`RecordSlot.joined`), sent as its edit when the author leaves it; the
  recorded lines wholly inside the change are deleted. It holds a line of the
  author's too, so the recording keeps its leading number as it is, never
  puts drawer words on it (the file wins; its words go again), and Cancel
  leaves it — taking it out would take their line with it. One that took in
  the line the steps go after stays the run's first line: no step is written
  above it.
- **A line of the author's typed and sent**, changed afterwards, goes as
  `edit-step` with its step's id at the same moments (with a server that
  names no steps it stays their text, as before: sent once).
- **Ctrl+Z of a rewording the server took** (the author's, from the file):
  the words the line has now go at once, wherever the cursor is — an undo is
  not typing — as an `edit-step`: back to the model's words, which releases
  the rewording on the server (the line is then the recording's again, which
  the model may rewrite), or to an earlier rewording. A second Ctrl+Z before
  the cursor left the line (the recording's own write undone) must not leave
  the server holding words the file no longer has.
- **Newer words from elsewhere** — the browser's drawer or the panel
  (`record:edited` from `toolbar` or `panel`) — for a step a line of the
  author's stands for (a recorded line they reworded, or a line they typed:
  the drawer can reword the author's own steps too) are put on that line at
  once, in place of its words, its number kept — the one time the recording
  writes words onto a line of theirs — while the line still reads as the
  recording last held it. Changed by the author since (they are editing it,
  or it reads otherwise), the file wins: the line keeps what they wrote, what
  they leave on it goes as the edit, after the drawer's, and the log says so
  once for the line, by its number: "A step was reworded in the browser while
  you were changing it in the file (line <n>); the line keeps what you
  wrote." Nor are they put on a line whose edit of the author's is still on
  its way (the server took the drawer's first, so theirs are the newer). When
  the line the file wins for already said what went from the file, those
  words go again — the server does not keep the drawer's words the file does
  not have.
  Words from the file are never put on another line: two lines can stand for
  one step (the model rewrote the step one was being edited for, and the
  author reworded its new line too), and each keeps its own. A step deleted in
  the drawer or the panel takes its line out when the line still reads as the
  recording last left it, as Undo of a typed step does; one whose line the
  author deleted in the file never takes another line of theirs with it.
- **Where a delete came from.** A `drop` or `restore` of a step made in the
  file carries `source: 'editor'`, one from the panel `source: 'panel'`, so
  the step's `record:dropped` says where (§9.3; a server that predates it
  ignores the field). One the server does not take (`ignored`: the step was
  restored some other way, or its actions came back one by one) leaves the
  panel's row as the recording has it, said in the log — a `drop` from the
  file it did not take is struck no more (unless the server said the step is
  deleted already), and Stop's `dropped` list does not send it again over the
  server's answer; the line stays out of the file, where the author deleted
  it.
- **An edit the server does not take** (`ignored` — a secret it knows, a step
  no longer there — or a failed call) leaves the line as the author wrote it,
  still standing for its step, said in the log by its line number, never
  quoted: "Your edit on line <n> was not taken by the recording (<why>); it
  stays in the file as you wrote it." Changed again, it is sent again. (A line
  the author typed stays `sent`: it still stands for its step, so the draft
  never writes that step a second time beside it.)
- **The result** carries no ids: the last draft's are placed in it by their
  steps' words (as the author's steps are), so a reworded line is the
  result's step, written once. Cancel and the one Ctrl+Z after Stop take the
  reworded lines out with the steps they describe.

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
far (its steps, numbered, and its parameters) — each LOCKED step marked final,
each of the author's marked as written by hand at that point (§7.6), each the
author reworded marked `edited`, and every step but the author's own with the
numbers of the recorded actions it stands for (`actions`); the NEW
actions, each with its description (§4.1), its crop (§4.2), the time since the
previous action (paused time left out) and its tab, and `afterPause` on the
first one after a Resume; the file around the cursor — `baseUrl`, existing
parameters with their values (secret ones masked), `### Section` names, and
the steps just before and after the insertion point. The rules add: never
repeat, reword or reach back past a locked step (A1); the actions right after
a step of the author's that only carry it out are covered by it — write
nothing for them (A2); never a Verify that repeats one of the author's (A3);
a step the author reworded is theirs — keep it exactly, write no other step
for its actions, never reach back past it (A4); a pause is not a wait the app
needed nor a reason to navigate (I9); a solid dark box in a crop is a secret
or the recorder's controls (D2).

**Output of a draft call:** JSON only — the draft's new tail, which recorded
actions each of its steps describes, and the whole parameter list.

```json
{
  "replaceFrom": 4,
  "steps": ["Click Payments in the main menu", "Tick the Cash checkbox"],
  "stepActions": [[7, 8], [9, 10]],
  "parameters": [
    { "name": "email", "value": "demo@securebank.com" },
    { "name": "password", "value": "$PASSWORD" }
  ],
  "notes": ["Two clicks on the same Next button were written as one step"]
}
```

`replaceFrom` is the 0-based index in the current draft where `steps`
begins; everything before it is kept. It may reach back neither more than
three steps nor past the last locked step (or step of the author's, or step
they reworded): a value that does is refused and the call is retried once as
a redraft of the OPEN steps only — the steps after the last lock, over the
actions since it — never of the whole recording. Without locks that is the
whole draft, as before. `steps` carry no numbers. `stepActions` is parallel
to `steps`: for each, the numbers (`n`, as the recording in the prompt gives
them — an action's place among the ones still in) of the actions it
describes, typing and choices included. `notes` are shown to the author.

**Which actions a step stands for** (stories/testbench-record-edit-steps.md).
The engine checks `stepActions`: every number one this call may give out —
its own actions, and the ones the steps it replaces stood for — each action in
one step at most, and in the order the author acted. An answer that does not
hold up, or has none, is mapped conservatively instead: each ACTION with the
events recorded before it (they ride with it) is one group, and the groups go
to this call's steps one each from the LAST — the newest step is the one the
newest action asked for — with any earlier groups left over going to the
nearest step, the first (the focus click a `Type` step folded away, the menu
a "Click Payments in the main menu" opened); a step kept unchanged in place
keeps what it stood for; never an action to a step of an earlier call. Either
way an event the answer left out goes with the step that claimed the action
it rode with, and an action no step claimed goes with its events when one
step claimed them all; a click no step claimed goes with the step that
claimed what came next when that is on the same element (the page's
selector, else its tag, role, name, id and `name` attribute, one of those
not empty; same tab and frame) — the click into a field that a "Type … into
the Email field" step folded away is that step's. An action no step
describes stands for no step. The mapping is kept across appends, tail
rewrites, stretch redrafts and full redrafts.

**Step ids.** Every step of the draft has an id (`record:draft.ids`): an
author step its `s` id; a step the model wrote a `d` id, kept while the step
stays unchanged in place (the same words at the same place among the steps a
call replaces) and new each time the model writes or rewrites it. No id is
ever an action's or another step's. The engine remembers what each `d` id
stood for after the model rewrote it, so an edit or a delete naming a step the
author saw a moment ago still lands (below).

**The author's edits** (`edit-step`, §9.3, and the drawer, §3.4). A step the
model wrote becomes the author's: its text is theirs, exactly (a leading
number or list marker aside), it keeps the actions it stands for, and it is
`edited` in the draft. It locks nothing: it is a floor for an ordinary call's
`replaceFrom`, as a step of the author's is, and that is all. The model never
rewrites it — a redraft of its stretch keeps it and puts it back among the new
steps by where its actions are — and writes no other step for its actions:
they are left out of every call (a redraft's prompt lists the step with them,
A4), and a step an answer ties to nothing but them is not written; without a
mapping that holds up, an exact copy of its words is taken for one too — in
an ordinary call's answer as in a redraft's. Edited back to the model's exact
words, it is the model's again. A step of the author's own has its text
replaced (and a redraft of its stretch in flight, shown the old words, is
thrown away and made again). An edit naming a step the model has rewritten
since takes over what THAT step stood for, from whatever steps stand for it
now — one step, the author's words, under the id the edit named: never lost,
never written twice. A step that stood for nothing else goes (the first is
replaced where it stands); one the model merged it into ("Click Two, then
Four" for an edit of "Click Two") keeps the rest of its actions — the author
never saw them in the step they named — and its stretch is redrafted, so the
model writes those actions into a step of their own; merged into a step the
author had reworded too, that step keeps their words for what is left of it.
With no step that stood for nothing else, the edit goes among the steps by
where its actions are. No call is made for an edit bar that redraft; the next
one is shown it. One that arrives while a call is in flight that could rewrite
that step makes the call's answer be thrown away and the call made again: a
redraft of its stretch at once; an ordinary call when its answer comes, if
the steps it replaces are no longer the ones it was shown (every answer of
an ordinary call lands by the ids of the steps it replaces, so a change
before them moves nothing). A reworded step whose actions were all dropped
since stays, where it was: the author's words are never lost.

**The author's deletes** (`drop` of a step id, the drawer's ✕). A step the
model wrote — reworded or not — leaves the draft at once, with no call, and
every recorded action behind it is dropped with it, as the panel's ✕ drops an
action: struck through in the panel, never shown to the model again, so no
redraft brings the step back. So are the entries just before its first action
that no step stands for and that are on the same element (the click into the
field its typing went into, which the model folded away): left behind, the
next redraft wrote them back as a step of their own. `record:dropped.actions`
lists them all. A step of the author's goes as Undo takes it
(below). A parameter no remaining step uses leaves the draft's list — after an
edit that stops using it too; an edit naming a `{{name}}` no parameter
defines is written as it is (the author's business; the draft's notes say
so). **Restore** puts the step back with its actions: exactly where it was,
with no call, when nothing has touched its stretch since; otherwise among the
steps of the stretch its actions are in, by where they are — no earlier than
just after the step that was before it, when that step is there too (so two
neighbours deleted one after the other come back in the order they were
recorded, whatever order they are restored in); a step that stands for no
action goes after the step that was before it. One of its actions
restored on its own from the panel is an action like any other: its stretch
is redrafted and the model writes a step for it — and the deleted step can no
longer come back as it was (Restore answers why), even should that action be
dropped again. A delete naming a step the model has rewritten since drops
what THAT step stood for, as an edit takes it over (above): a step that stood
for nothing else goes, one the model merged it into keeps the rest and is
redrafted; Restore puts the named step back in the words the author last saw,
by where its actions are.

**Locks** (stories/testbench-record-toolbar.md, "Steps you write"). A step of
the author's locks everything before it. The draft is kept as STRETCHES — the
steps between two locks and the actions they are written from — and only the
open stretch, after the last lock, is ever drafted on the model's own
account. A call that places steps rather than extending the tail (a redraft of
the open steps or of one locked stretch, or the steps a failed catch-up left
out) is shown the draft with a marker where its steps go and answers
`replaceFrom` at the marker; every step already in the draft stays. The
author's lines are never rewritten: the parameter pass does not touch them,
and an exact copy of one in the answer is not written a second time.

- **A step added at the end** (the toolbar, the panel, a line under the
  block): the typing still open is collected, the draft is brought up to date
  first in one call over the actions recorded before it (the toolbar reads
  "Adding…"), then the lines go in exactly as written, each locking what is
  above it, and recording carries on below. When that call fails, the step
  still goes in where it was put, and the next call an ACTION causes drafts
  the actions before it into the space above it (as any failed call's
  actions wait for the next action — it is not retried on its own); nothing
  after it moves. Stop drafts them regardless. A step the model had already
  written for actions recorded after it (a call it waited for took them in)
  goes below it, as it is; one written over actions on both sides of it stays
  whole, above it.
- **A step between two recorded steps** (the editor, or the drawer's +): it
  goes in there, with no call; everything drafted so far is locked, on both
  sides of it — actions recorded after the step was sent included, when a
  call it waited for drafted them; actions not drafted yet go after the whole
  block. `afterStep` is read against the draft the author saw (`revision`):
  that step — by its id, else its text — found in the draft as it is now; the
  drawer's + names it by its id directly (`afterId`).

**When a draft call fails** (the model errors or answers something
unreadable), the author is told in the panel, the previous draft stands, and
the next call — or Stop — covers those actions again.

**A redraft** — after an action is dropped or restored — is one call over
the remaining actions of the stretch it is in: after the last lock, the open
steps (`replaceFrom` at the lock; the whole draft when there is none); inside
a locked stretch, that stretch alone, the author's steps at its edges staying
as they are and nothing outside it changing. Dropping a step of the author's
takes its line out at once and lifts its lock: its stretch and the next are
one again, redrafted together when the model had drafted actions after the
step (it may have left them unwritten, A2). Restoring it puts the two
stretches back exactly as they were when nothing touched them since — no call
— and otherwise puts its lock back where it was in the recording and redrafts
both sides; the line goes back at the edge of the stretch it closes, or — one
typed between two recorded steps — after the step that was before it, where
the file still has it.

**While paused** (§3.4) no call starts for new actions; a call already
running finishes, and the calls the author asks for — Add step's catch-up, a
redraft after Undo — still run. On Resume what waited is drafted.

**At Stop** the draft is final when it already covers every remaining action;
otherwise the calls it still needs bring it up to date — one, as before, or
one more per locked stretch the author changed. If one fails, the recording
ends with an error and the drafts are taken back out of the file. A recording
whose only steps are the author's writes them with no call.

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
  toolbar?: {                  // the browser toolbar; absent = { enabled: true, dock: 'bc', minimised: false }
    enabled: boolean;          // TestBench: the testbench-native.recordSteps.browserToolbar setting
    dock?: 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br';   // TestBench: where the last record:toolbar left it
    minimised?: boolean;
  };
}
```

| Status | When |
| --- | --- |
| 200 + SSE | Recording started |
| 400 | Invalid body (a `toolbar` without a boolean `enabled`, or a `dock` that is not one of the six, included); `config` sent to an existing session; the server is headless |
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
  through?: string;            // id of the last action the draft covers
  locked: number;              // how many leading steps are locked (§7.6) — the engine's, never shown to the author
  authored: number[];          // indices of the author's own steps
  authoredIds?: string[];      // their ids (record:step's), parallel to `authored`
  ids: string[];               // one stable id per step (§8, "Step ids")
  edited: number[] }           // indices of the steps the author reworded (§8)
{ type: 'record:edited'; id: string; text: string;     // a step reworded by the author, before the draft that shows it
  source: 'toolbar' | 'editor' | 'panel' }             // `id`: the id the edit named, which now holds `text`
{ type: 'record:paused'; paused: boolean; atMs: number; source: 'toolbar' | 'panel' }
{ type: 'record:step'; id: string; text: string;       // a step of the author's joined
  source: 'toolbar' | 'editor' | 'panel';
  afterStep: number;           // the index of the draft step it follows (-1: the very start)
  atMs: number }
{ type: 'record:dropped'; id: string; dropped: boolean;
  source: 'toolbar' | 'panel' | 'editor';
  actions?: string[] }         // a step of the draft deleted (or restored): the actions dropped (or restored) with it
{ type: 'record:toolbar'; dock: 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br'; minimised: boolean }
{ type: 'record:writing' }     // Stop received; finishing the draft
{ type: 'record:result'; steps: string[];
  parameters: Array<{ name: string; value: string }>;
  notes?: string[] }
{ type: 'output'; … }          // warnings, as on the steps route
{ type: 'done'; status: 'passed' | 'error' | 'aborted'; error?: string;
  cancelledBy?: 'browser' }    // `aborted` by Cancel in the browser's toolbar: no error, ends quietly
```

TestBench reads an absent `locked` as 0 and absent `authored` as none (a
server that predates the toolbar). `record:step` comes before the draft that
holds the step; a client that meets them the other way round still maps an
editor step to its line by the text it sent (§7.6). `record:toolbar` is not the
panel's: TestBench keeps it for the next start body. A Stop pressed in the
browser needs no frame of its own (`record:writing`, `record:result`, `done`).

TestBench reads an absent `ids` as a server that predates editing: the
recorded lines are then written over when the author edits them, as before,
Steps so far offers no ✕ on a step, and the log says so once ("This server
does not name its steps, so recorded lines cannot be edited or deleted while
recording: an edit inside them is rewritten by the next draft — edit them
after Stop."). An absent `edited` reads as none, and a `record:dropped`
without `actions` strikes only its own row. TestBench never counts on
`record:edited` coming before the draft that shows it, nor on the id it names
being the one its `edit-step` named: a draft that shows the step `edited`
with the words a line went as is that line either way (§7.6). The words a
`record:edited` from the file carries answer the `edit-step` that went with
those words — not an older one of the same line's — and the ones from
`toolbar` or `panel` are put on a line of the author's standing for the step
only when no edit of theirs is on its way (frames arrive in the server's
order, so one that came first was taken first) and the line still reads as
the recording last held it (§7.6).

`record:dropped` goes out for a step of the draft deleted or restored from
anywhere — the drawer, the control route (`source` as the control gave it,
`panel` when it gave none), Restore on the bar, the toolbar's Undo of the last
action behind a reworded step (`source: 'toolbar'`, the step's id, §3.4) —
with `actions`, before the draft without (or with) the step. For an action or
a step of the author's it goes out, without `actions`, only when the
browser's toolbar did it (Undo, Restore, the drawer's ✕ on the author's
step), after the draft, as before: the panel's own drops are the panel's.
`record:edited` goes out for every edit, from anywhere, before the draft that
shows it. An edit or a delete naming a step the model had merged into
another (§8) is followed by a draft that still holds the merged step, now
standing for the rest of its actions, and then by the redraft that replaces
it.

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
{ action: 'drop'; id: string;            // leave this action (or step of the author's) out; redraft now —
  source?: 'editor' | 'panel' }          //   or delete a step of the draft (a record:draft.ids id) and the
                                         //   actions behind it, with no call (§8); `source` only names where
                                         //   a step's delete came from, in its record:dropped
{ action: 'restore'; id: string;         // put it back; redraft now — a step of the draft goes back with
  source?: 'editor' | 'panel' }          //   its actions (§8)
{ action: 'edit-step'; id: string;       // the author reworded a step of the draft (§8): one line, kept
  text: string;                          //   exactly (a leading number or list marker aside)
  source: 'editor' | 'panel';
  revision?: number }                    // the record:draft the author saw
{ action: 'check' }                      // arm pick mode
{ action: 'cancel-check' }               // disarm it
{ action: 'cancel' }                     // end without writing
{ action: 'pause' }                      // record nothing, start no draft call, until…
{ action: 'resume' }
{ action: 'add-step';                    // a step the author wrote (§7.6)
  text: string;                          // one line; several lines = several steps, in order
  source: 'editor' | 'panel';            // the toolbar's box goes through the page instead
  afterStep?: number;                    // the 0-based index of the step it goes after, in the draft
                                         //   the author saw; absent = at the end
  revision?: number }                    // the record:draft revision `afterStep` refers to
```

`202` accepted — with `{ ignored: "<why>" }` when the call did nothing (a
pause while paused, a resume while recording, `check` while paused, an
`add-step` whose every line is blank, an `add-step` from the editor holding a
secret the recording knows (§7.6), a `drop` or `restore` of an id the
recording does not have or that is already in that state, a `restore` of a
deleted step one of whose actions came back on its own since (§8), an
`edit-step` of a step the recording does not have, one that is deleted, one
whose actions no step stands for any more, an empty or several-line text (an
empty text, or a lone number or list marker such as `3.` or `-`, is not an
edit — send `drop`), the step's own words, or — from the
editor — a secret the recording knows (from the panel it is written
`{{name}}`, with `name: $NAME`, as in §7.6), anything but `cancel` after
`stop`), which TestBench says where the author asked (an `add-step` or an
`edit-step` from the file leaves the line theirs); `404` when no recording is
running for the session; `400` for a body that is none of these (an
`add-step` with no `text`, an `edit-step` with no `id` or `text`, a `source`
other than `editor` or `panel`, an `afterStep` or `revision` that is not a
whole number 0 or more). An `edit-step`, a `drop` and a `restore` are carried
out the moment they arrive: none needs a model call, so the answer says
whether it applied. `edit-step`'s `revision` is advisory: it is checked (a
whole number) and otherwise unused — a step id names one wording of one step,
never reused, and what each id stood for is remembered, so the id alone finds
it; the draft the author saw adds nothing to that. An `add-step` of only lone
numbers or markers adds nothing (`ignored`). `add-step` is
answered at once and carried out after: bringing the draft up to date is a
model call, and `record:step` says when the step joined. An `add-step`
answered `202` without `ignored` is always carried out, and before the result:
a `stop` that arrives while it waits (behind another step's model call, say)
waits for it.

### 9.4 Page and server (internal)

The page script talks to the server through the recorder's one binding; this
is the server half's own business, listed so the client half knows what
exists. The toolbar's messages: a command (`pause`, `resume`, `check`,
`cancel-check`, `undo`, `restore`, `stop`, `cancel`, `minimise`, `dock`, the
drawer's `delete-step` and `restore-step` with a step's id, and from a frame
`open-step`, `focus-bar`, `toggle-minimised`), a step with its text — and,
from a drawer row's +, the step it goes after (`afterId`, with the index and
draft revision the drawer had, for when the model has rewritten that step
since) — an edit (`edit-step`: a step's id and its new words), the box's
unsent text (the page's typed secrets masked, §5), a focus report — a yes or
no for "the focused field is secret", from any frame, never a value — and a
check-in. A step, an edit and the drawer's commands come from top-level
frames only. Each carries the document's **token**; a message without the
right one is refused (and said in the log). An edit still open in the drawer
when the document goes is sent from its `pagehide` (§3.4): the binding call
leaves before the document does, and the frame's token is still that
document's then — the next document's claim comes after its hello.

The answer says whether it was taken: `{ ok: true }`; `{ ok: false, state }`
when it was this document's and was not (a Pause while paused, Add check while
paused, anything that would change the recording after Stop), with the state
the page should show; `null` for a message that is not this document's. The
page shows some commands before the answer (Pause, minimise, a move, Esc out
of Add check, a step leaving the box, the drawer's edit, removal and Restore
of a row) and takes each back on anything but
`ok: true` — to the `state` given, or, with none (no answer within 3 s, or no
token to send with), to what it showed before, unless the server has pushed a
state since. A check-in answered with anything but `ok: true` counts as
unanswered.

The token is not in the `hello` answer: any page script can call the binding
and say hello. The server makes one for each hello and hands it to the
recorder's script by calling `claim` on the script's frozen control object,
which accepts one token per document and never gives it out; the recorder's
script says hello at document start, before the page's scripts run, so the
first claim is its own, and a token made for a page script's hello is refused
and never registered. The hello's answer waits for the claim at most 2.5 s,
but the claim is registered whenever it lands — a document whose own scripts
keep it busy while it loads answers late — unless a later claim for the same
frame (a newer document's) has been registered first.

The control object is on `window`, so the page's scripts can call it too.
Every method of it (`claim`, `setState`, `flush`, `fieldRects`, `toolbar`)
wants the **control key**: a random value the server writes into the
script's closure when it builds the init script — once per browser context,
since an init script cannot change — and passes as an evaluate argument,
never through the binding or a page global. A page script calling
`claim('x')` before the recorder's claim gets `false`.

This keeps out a page that calls the binding or the control object; it does
not keep out a page written to attack the recorder (Playwright's binding
serialises through page globals — measured in Playwright 1.59 — so such a
page can read what crosses it, the token included; the key crosses by
evaluate, which was not measured and is assumed to be no better).

The server's push to each frame (`setState`, and the `hello` answer) is `{
recording, pick, paused, bar }`; a top-level frame also gets the `toolbar`
block — phase (`recording`, `writing`, `done`, `ended`), the clock and whether
it runs, the action count, the steps with their ids and `yours` (the author's
own, or reworded) — no locked flag, since nothing is locked against the
author — the draft's revision, the steps deleted since the last one landed
(each with the id of the step before it), whether a draft call is running,
the current confirmation or error with how long it
has left, "Typing hidden", dock, minimised, the box's unsent text (empty from
the moment its step arrives) and, at the end, what to say. Everything in it
is text the panel already shows, masked again with the recording's secrets.
When a run starts on the session the last recording's recorder pushes one
more state with no `toolbar` block, which takes the bar out of the page.

## 10. Errors the author can meet

| Situation | What they see |
| --- | --- |
| Cursor not in a step region | "Put the cursor on a step, or the blank line after one, under ## Steps." |
| A run is executing | "Stop the run before recording." |
| The server is headless | "Record Steps needs a visible browser: this server runs headless (browser.headed: false)." |
| No model configured | "Record Steps needs a model to write the steps; configure ai in aiui.config.json or .env." |
| The model's answer could not be read | "The steps could not be written: <reason>. Nothing was inserted." |
| A step entered in the browser's toolbar after Stop (§3.4) | "A step typed in the browser after Stop was not added to the recording: "<text>". Add it to the test by hand." — a warning; the bar's last line says it too |
| A step changed in the browser's drawer after Stop (§3.4) | "A change to a step made in the browser after Stop was not made: "<text>". Change the step in the test by hand." — a warning; the bar says "Your change came after Stop, so it was not made." |
| The author edits a line being recorded, with a server whose drafts name no steps (§7) | "Lines being recorded are rewritten as the model updates them — edit them after Stop." — a warning, once per recording |
| A server whose drafts name no steps (§9.2) | "This server does not name its steps, so recorded lines cannot be edited or deleted while recording: an edit inside them is rewritten by the next draft — edit them after Stop." — in the log, once per recording |
| A step typed in the file that the server does not take (§7.6) | "Your step on line <n> was not added to the recording (<why>); it stays in the file as you wrote it." — in the log. By line, never quoting the step: the server refuses a line holding a secret it knows, and TestBench cannot tell which |
| A step reworded in the file that the server does not take (§7.6) | "Your edit on line <n> was not taken by the recording (<why>); it stays in the file as you wrote it." — in the log, by line, never quoting it, for the same reason |
| A step deleted in the file (or brought back by Ctrl+Z) that the server does not take | "A step whose line you deleted from the file was not taken out of the recording (<why>)." / "A step whose line you brought back in the file was not put back in the recording (<why>)." — in the log |
| A step deleted or restored from the panel's Steps so far that the server does not take | "Could not delete that step (<why>)." / "Could not restore that step (<why>)." — in the log; the row shows what the recording has |
| The browser's drawer rewords a step whose line the author changed in the file since (§7.6) | "A step was reworded in the browser while you were changing it in the file (line <n>); the line keeps what you wrote." — in the log, once per line |
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
