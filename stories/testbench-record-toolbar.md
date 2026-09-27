# Record Steps: controls in the browser

**Status:** design approved for build, 2026-09-27 ("That design is very nice … let's build what you designed first"). Not built yet. Extends
`docs/specs/SPEC-record-steps.md` (section numbers below are that spec's) and
`stories/testbench-record-steps.md`. The mockup beside this file,
`testbench-record-toolbar-mockup.html`, shows every state described here.

The author's answers to the open questions at the end are in §"Decisions confirmed", and the exact messages the two halves exchange are in §"The wire, exactly" — both added when the design was approved. Editing recorded steps (in the drawer or the editor) is the NEXT change, not this one.

## What we're building

While you record, your eyes and hands are in the test's Chrome window, but
every control you need is in VS Code. This design puts a small toolbar inside
the recorded page, the way Playwright's codegen does, so you can pause, add a
check, write a step by hand, take back a misclick and stop without leaving the
browser. The TestBench panel stays as the full view. Both show the same
recording and either one can drive it.

Here is what that looks like in use:

- **You press** Pause, go and fetch the one-time code from your email, come
  back and press Resume. **You get** no steps for anything you did while
  paused, and no Navigate step for coming back.
- **You type** `Verify the balance shows "$1,234.56"` into the toolbar's step
  box and press Enter. **You get** exactly that line as the next step. The
  steps above it are locked in, and the model won't write a second Verify for
  the same thing.
- **You type** a step straight into the test file, under the recorded lines.
  **You get** the same result: it joins the recording at that point, and the
  next recorded steps go below it.
- **You click** the wrong menu and press Undo on the toolbar (or Alt+Shift+Z).
  **You see** `Removed: Clicked link "Reports"` with a Restore button, and no
  step is written for it.
- **You press** Add check and move the pointer over the payment panel. **You
  see** it outlined, labelled `Check · panel "Payment method" · "Paid in
  cash"`. Click, and you get `Verify the Payment method panel says "Paid in
  cash"`.

## The toolbar

It's one compact bar in a dark graphite colour, floating over the page, bottom
centre by default. It is dark on every page, light or dark, with a thin light
outline, because its first job is to look like it is not part of the app.
Anything that borrowed the page's colours would sooner or later be mistaken
for the app, by you or in a screenshot.

The **top row** holds, left to right:

- a grip to drag it by;
- the status block, a red dot and **REC** followed by the elapsed recording
  time and the action count (`● REC 02:14 · 9 actions`);
- **Pause**, **Add check**, **Add step** and **Undo**;
- a gap, then **Stop** (the one filled button, because it is how you finish)
  and **Cancel** (quiet, text only);
- a minimise button.

The **second row** is a status line. At rest it shows the last step as written,
with the same number and wording the panel's **Steps so far** has, for
example `7  Click Payments in the main menu`, plus `updating…` while a draft
call runs. On the right is a **Steps so far** toggle that opens a drawer with
the whole draft. Hints, the Add step box, confirmations and errors all appear
in this row. So the bar never grows by more than this one row (or the drawer,
when you open it).

The button row always stays against the edge the bar is docked to, and the
status row and drawer sit on the side facing the middle of the page. Docked
at the bottom, the status line is *above* the buttons, and the bar grows
upwards. Docked at the top, it's below them. Either way, opening the step box
or the drawer never moves a button out from under your pointer.

Some of this goes beyond what you asked for. Here is why each extra is in:

- **The last-step preview** is the cheapest way to see that the model
  understood you. If the step reads wrong, you notice while you are still on
  that page and can press Undo, instead of finding out at Stop. It costs one
  line.
- **The Steps so far drawer** is there for recording on one monitor with
  Chrome maximised, where VS Code isn't visible at all. It is read-only. Edits
  and per-action drops stay in the panel, which is the full view. Locked steps
  show a lock and your own steps show a `yours` tag, so you can see what the
  model can still rewrite.
- **Minimise** folds the bar into a pill (`● REC 02:14`) for when you need to
  work in the corner it covers. Dragging it away is the other answer. Both are
  cheap, and pages differ too much for one fixed position to suit them all.
- **Dragging and docking** are covered below.

Buttons carry an icon and a short label. Below about 560 CSS pixels of page
width (an OAuth popup, a narrow window) the labels drop and the bar starts
minimised.

## Its states

**Recording.** A red dot with a slow pulse (none if you've asked for reduced
motion), `REC`, the time, the action count, and the last step in the second
row. A thin red ring around the bar. This is the state you will see most, so
it's the quietest one apart from the dot.

**Updating.** The same, with `updating…` beside the last step while a draft
call is running. It uses the panel's word for the same thing.

**Paused.** The dot becomes two amber pause bars and `REC` becomes `PAUSED`.
The clock stops, the ring turns amber, and the Pause button becomes
**Resume**. The second row reads `Paused. Nothing you do is recorded.` Add
check is disabled (a check is recording), with the tooltip `Resume to add a
check`. Add step, Undo, Stop and Cancel all still work, because they change
the recording without recording anything.

**Add check armed (pick mode).** The Add check button is pressed and blue, the
ring turns blue, and the second row reads `Click what to check. Esc to
cancel.` On the page, the element under the pointer gets a 2px blue outline
with a light halo, so it shows up on any background, plus a faint blue fill.
A label sits above it (below it when there's no room) saying what the click
will pick, built from the same description the model will get: role, name,
container and current text or value. For example:

- `Check · panel "Payment method" · "Paid in cash"`
- `Check · Email field · "demo@securebank.com"`
- `Check · Cash checkbox · ticked`
- `Check · Password field · value hidden`

The outline is drawn around exactly the element the click will pick, because
the function that picks it (`actionable(target) || target`) also draws the
outline. The pointer is a crosshair. Moving over the toolbar shows no outline,
since the toolbar can't be picked. Pressing Add check again, or Esc, disarms
it. That Esc goes to the recorder and not to the page, so a dialog you were
about to check stays open.

**Add step open.** The second row becomes a text box with focus in it and the
hint `Verify the balance shows "$1,234.56"` as placeholder. Beside it are an
**Add** button and `Enter to add · Esc to close`. Enter adds the step, closes
the box and puts focus back where it was in the page. Esc closes the box
without adding anything. Whatever you had typed is kept, and the box shows it
again the next time you open it. Enter while an input method is composing
text does not submit.

**Step added.** For about four seconds the second row reads `Added as step 8 ·
steps 1–7 locked`, with a green tick, and then settles back to showing the
last step, now your line with a lock and `yours`. If actions were still
waiting to be drafted when you pressed Enter, the row reads `Adding…` for the
moment it takes to bring the steps up to date first.

**Undo.** For about eight seconds the second row reads `Removed: Clicked link
"Reports"` with a **Restore** button, then `updating…` while the model
redrafts. Restore puts the action back, the same as clicking a struck-through
row in the panel.

**Typing hidden.** While focus is in a secret field (§5's rule, in any frame),
a lock chip appears in the second row: `Typing hidden. The value stays in
this browser.` It's there to reassure you, and it's also a visible check that
the recorder recognised the field as secret. If you're typing a password and
the chip isn't there, something is wrong, and you can see that before you
press Stop.

**Steps so far.** The drawer opens past the status row, on the side away from
the docked edge. It shows the whole draft, numbered, and scrolls once it
passes about eight lines. Locked steps have a lock and
yours are tagged. The step being rewritten shows `updating…`.

**Minimised.** A pill with the dot, `REC` or `PAUSED`, the time and an expand
chevron. It still shows pick mode (`Pick…`, in blue) and still shows errors
(amber). It can be dragged like the full bar.

**Cancel, confirm.** Cancel throws away work, so it asks first, in the second
row: `Discard this recording? The steps won't be written.` with **Discard**
and **Keep recording**. Stop doesn't ask.

**Writing.** After Stop, every button is disabled and the row reads `Writing
the steps…`. Nothing on the page is recorded from this point. It matches the
panel's `Finishing…`.

**Done.** `Done · 12 steps written to pay-by-cash.md` with a Close button. It
fades after six seconds, and then the toolbar is removed from the page. A
recording with no steps says `Nothing was recorded, so no steps were
written.`. After a Cancel it says `Recording cancelled. Nothing was written.`

**Not connected.** The toolbar checks in with the server every few seconds. If
two check-ins in a row go unanswered, the dot turns into a hollow amber ring
and the row reads `The recorder isn't answering. What you do now may not be
recorded.` It clears on its own when the server answers again. (If the server
process dies, Playwright's browser usually goes with it, so in practice this
state means a server that is alive but stuck.)

**Ended elsewhere.** If the recording ends somewhere other than this toolbar
(Stop or Cancel in VS Code, the TestBench window closing, the session being
closed under it), the bar shows why, in the words §10 already uses. For
example: `Recording ended: the session was closed while recording. Nothing
was written.` Then it goes away.

**Couldn't update.** When a draft call fails, the row reads `Couldn't update
the steps. They'll catch up with your next action.` in amber. This mirrors the
panel's message (§8).

## Controls and shortcuts

| Control | What it does | Shortcut |
| --- | --- | --- |
| Pause / Resume | Stops recording and drafting new actions, or starts again (see below) | Alt+Shift+P |
| Add check | Arms pick mode; pressing it again disarms (§6) | Alt+Shift+C |
| Add step | Opens the step box | Alt+Shift+S |
| Undo | Removes the most recent action, check or step of yours from the recording | Alt+Shift+Z |
| Stop | Ends the recording and writes the steps | none |
| Cancel | Asks, then ends without writing | none |
| Minimise | Folds the bar into the pill, or opens it again | Alt+Shift+M |
| (focus the toolbar) | Moves keyboard focus onto the bar | Alt+Shift+R |

On macOS the modifier is Option+Shift. Shortcuts are matched on the physical
key there, because Option turns letters into symbols (`∏` and so on).

**Why Alt+Shift, and why those letters.** Plain letters, the way codegen's
pick mode takes over the page, would collide with typing. Ctrl+Shift is where
browsers and DevTools live: Ctrl+Shift+C opens the element inspector, and
some Ctrl+Shift chords can't be overridden by a page at all. Ctrl+Alt is AltGr
on most European layouts, where it types `@`, `€` and `{`. Alt+Shift is
mostly free. Chrome on Windows binds a few (Alt+Shift+I opens the feedback
form, Alt+Shift+T focuses the browser toolbar, Alt+Shift+A focuses an
inactive dialog), and the letters above avoid them. Some web apps use
Alt+Shift+letter: Google Docs opens its menus that way in Chrome (F, E, V, I,
O, T, H), and Firefox uses it for accesskeys, which Wikipedia relies on.
Because the recorder's key listener is the first one on the page (below), a
clash resolves in the toolbar's favour. The only cost is that you can't use
that one page shortcut while recording, and the recorder doesn't record
shortcuts anyway (§4). Keys are only seen while the page has focus, not in
the address bar or DevTools.

Stop and Cancel have no shortcut on purpose. Each ends the recording, you
press it once, and a stray chord that cancels ten minutes of recording costs
far more than the reach for the mouse saves. Undo gets a shortcut because
you'll use it mid-flow and it can be taken back.

Shortcuts work from inside frames too. Every frame's script listens and
passes the command up through the binding, so a login form in an iframe
doesn't make them go dead.

## Where it sits

You **drag** it by the grip. When you let go it **docks** to the nearest of six
places: top or bottom, each at left, centre or right, 16px from the edges.
Free placement sounds nicer but always ends a few pixels over something.
Docking also makes the position mean the same thing across windows of
different sizes.

The position is **remembered** by the server for the rest of the recording and
by TestBench across recordings (workspace state). It is never kept in the
page's own storage. The page's `localStorage` belongs to the app under test.
Writing into it would change the app's state, which is the thing being
tested, and it wouldn't follow you from `localhost:8787` to a login page on
another origin. Playwright's codegen makes the same choice: it sends its drag
offset back to the app instead of storing it in the page.

**Navigation and new tabs.** Every new document gets the recording script
(it's an init script), and its first act is already to ask the binding
whether a recording is running (`hello`). The answer now also carries the
toolbar's state and position, so on a full page load the bar comes back in
the same place, in the same state, as soon as the document has a root
element. A same-page route change in a single-page app doesn't touch it.
Every tab and popup the browser opens gets it too, sharing one state: pause in
one tab and every tab shows Paused. An app that wipes the document (for
example with `document.open` or by replacing `<html>`'s children) gets the bar
put back by an observer.

**Frames.** The bar lives only in the top-level document of each tab. Frames
still get what they need locally: the pick outline and label are drawn by the
frame's own script (the pointer is in that frame's coordinates), the
shortcuts work there, and a secret field focused inside a frame lights up the
Typing hidden chip, carried as a yes/no through the server.

**Pages with no script.** Chrome's own error pages, the built-in PDF viewer
and `view-source:` don't run init scripts, so they get no bar. The panel in
VS Code still works, and the bar returns on the next ordinary page.

## Keeping the toolbar out of the recording

This is the part that has to be right. The recorder's whole value is that
what it writes can be replayed, and during a run there is no toolbar. If
anything about the bar leaks into a step, a crop or a description, the run
will look for something that isn't there.

### Its clicks and keys

The bar is a custom element (`<aiui-recorder>`, say) with a **closed** shadow
root, appended to `<html>` next to `<body>` rather than inside it. Every
event from inside a closed root reaches the page's listeners retargeted to
that one host element. So every recorder listener starts with one question:
does this event's path include the toolbar's host? If it does, the event is
the toolbar being used, not the app, and the recorder ignores it. That check
has to come before everything else the listener does, which today includes:

- taking a screenshot mark;
- flushing typing;
- the label-forwarding logic;
- and, in pick mode, swallowing the click.

Without it, pressing Add check again to disarm pick mode would pick the
toolbar. Without it, Enter in the step box would be recorded as a `key` Enter
action against the host, because §4 records a Tab or Enter pressed inside a
closed shadow root against its host.

One side effect is kept on purpose. Pointing at the toolbar still *finishes*
the typing in the field you were in, the same way pointing anywhere does. So
a field typed just before Pause, Add check or Add step is reported *before*
the pause, check or step, in the order you did them.

The buttons don't take focus when clicked (their pointer-down is cancelled
inside the shadow root). Clicking Pause therefore doesn't blur the app's
field or close its open menu, so you can arm Add check while a menu is open
and then check something inside the menu. The step box is the one exception,
because typing needs focus. When it opens, the page sees its field lose
focus, which is unavoidable. When it closes, focus goes back to where it was.

The page's **Tab order** doesn't include the toolbar: its buttons are
`tabindex="-1"`, and Alt+Shift+R moves focus onto it. This matters for
replay. If Tab could land in the toolbar, a recorded `Press Tab` would, in a
run without the toolbar, land somewhere else.

### Screenshots

The crop (§4.2) is cut from `page.screenshot()` of the whole visible page, so
the toolbar is in the picture whenever it's near the target. There are two
ways to keep it out:

1. **Hide it for the capture.** Playwright's `screenshot({ style })`, or the
   page script setting `visibility: hidden` and the server putting it back
   afterwards.
2. **Paint it out of the picture.** The page script already answers
   `fieldRects` for every frame before every crop, reporting where secret
   fields are so the server can fill them in. The top frame's answer adds the
   toolbar's box, and the server fills it in the same way.

I recommend **painting it out**. The browser is headed, so anything that hides
the bar for the capture hides it on your screen too: it would blink on every
click. Painting out uses machinery that already exists, with the same
fail-closed rule (a frame that can't say where things are costs the crop). It
adds no round trip before the capture, so the picture is still taken before
the click lands. It doesn't depend on how Playwright injects its `style`
option on a page with a strict Content-Security-Policy, which I couldn't
confirm. The model is told that filled boxes are either secrets or the
recorder's own controls, and to name neither. The cost is that the model
doesn't see whatever sits under the bar. You can't see it either, and you
can't click it, so the target is never under the bar.

The **pick outline and label** are a different case. They sit on the very
element the crop is about, so painting them out would paint out the target.
Instead they are taken down in the same instant as the picking pointer-down,
before the crop is requested, and are never in the picture.

### Descriptions and page text

The element description (§4.1), the check's text (§6) and the text the crop's
secret check reads all come from walking the page's DOM. A closed shadow root
isn't reachable by `querySelector`, `TreeWalker`, `innerText` or
`textContent` from outside, so none of the bar's words can turn up as a
section heading, a container's text or visible text. The host element itself
is chosen to match none of the recorder's selectors. It has no `tabindex`,
`role`, `onclick` or `popover` in the `ACTIONABLE` and `CONTAINERS` lists.
It is also left out explicitly wherever the recorder uses `elementFromPoint`
or `document.activeElement` (the active element *is* the host while you type
a step).

After Stop the bar is removed from the DOM, so the runs that follow (and their
DOM snapshots) never see it. The script stays installed but inert, as now.

### The page's layout, CSS and stacking

The host is a **manual popover** (`popover="manual"`) shown as soon as it is
created. That puts it in the browser's top layer, above every `z-index` on the
page, and out of reach of the things that trap `position: fixed` elements:
an ancestor with a `transform` or `filter` (Dark Reader and some zoom tricks
put a filter on `<html>`), and ancestors that clip their overflow. It takes
no space in the page's layout. Every other top-layer element (a modal
dialog, a newer popover, a fullscreen video) paints above whatever entered
the top layer before it. So the bar is shown again (hide, then show) whenever
one appears. Playwright's recorder overlay does this on a 500 ms timer; here
it can be driven by the `toggle` events and an attribute observer, with the
timer as a backstop.

The page's CSS can't reach into the shadow root, but it can style the host
element itself, and outer rules beat `:host` rules. So the host's own
positioning and reset are set as inline declarations with `!important`, one
property at a time through `style.setProperty`. They override the popover's
built-in styles (inset, margin, border, padding, background) and any `*`
rule on the page. The bar's fonts are the system UI stack, so it loads
nothing from anywhere.

### Modal dialogs

A page's modal `<dialog>` (opened with `showModal()`) makes everything outside
it **inert**, and that includes a popover shown on top of it. The bar would be
drawn above the dialog and still not respond to clicks. This is current spec
behaviour, not a browser bug (whatwg/html#10811 discusses changing it).
Playwright's overlay doesn't handle it. Three ways out:

- Move the host inside the topmost modal dialog while it is open, and back
  out when it closes. A descendant of the modal isn't inert. This is the
  recommendation, but it does put a foreign node inside the app's dialog.
  Since it's a closed shadow root, the dialog's text and queries don't see
  its contents. An app that counts its dialog's children, or re-renders the
  dialog from scratch, would notice or drop it, and the observer would put it
  back.
- Leave it inert while the modal is open. The shortcuts still work, because
  the keys reach the page's window listener.
- Both: move it, and fall back to shortcuts when the move fails.

Many React modal libraries set `inert` or `aria-hidden` on the other children
of `<body>` instead. The host being a child of `<html>`, not `<body>`, keeps
it out of their reach.

### Strict Content-Security-Policy

`browser.bypassCSP` defaults to false in this repo, so the bar has to work on
a page whose policy forbids inline styles (`style-src 'self'` with no
`'unsafe-inline'`), and one that enforces Trusted Types. Here is what I found:

- **The script itself is fine.** Init scripts and the binding are installed by
  Playwright through the DevTools protocol, not by the page, so the page's
  `script-src` doesn't apply to them. The recorder already relies on this on
  every page. Confidence: high.
- **A `<style>` element the script creates is blocked** under that policy, and
  so are `setAttribute('style', …)` and assigning `style.cssText`. MDN names
  both of those as blocked. Setting individual properties on an element's
  `style` object is *not* blocked. MDN states this explicitly with the example
  `style.display = "none"`. Confidence: high.
- **A constructable stylesheet adopted into the shadow root works.** That's
  `new CSSStyleSheet()`, then `replaceSync(css)`, then
  `shadowRoot.adoptedStyleSheets = [sheet]`. It isn't checked against
  `style-src` at all. The question was raised against the proposal
  (WICG/construct-stylesheets#98, "replaceSync accepts inline CSS which is not
  CSP compliant") and browsers shipped it unchecked. Playwright's own
  overlay uses exactly this (adopted sheet first, `<style>` only as a
  fallback for browsers without it), and libraries built for strict-CSP sites
  recommend it for the same reason. Confidence: high for Chromium, which is
  what the recorder drives. I read this in the sources and in Playwright's
  code, but haven't measured it in this repo. One check against
  `fixtures/test-app` served with a strict CSP header would settle it.
- **Trusted Types** (`require-trusted-types-for 'script'`) makes `innerHTML`
  throw. So the bar is built with `createElement`, `textContent` and
  `createElementNS` for its SVG icons, and never with HTML strings. Icons
  inline as SVG elements aren't subject to `img-src`, which a `data:` URL
  would be. Confidence: high.
- **Pick mode's crosshair** needs a page-wide `cursor` rule. That goes in a
  constructable sheet adopted by the *document* (`document.adoptedStyleSheets`)
  while pick mode is armed, and is removed afterwards. It's unaffected by CSP
  for the same reason, and it changes no layout.

In short, the bar can be built entirely from adopted sheets and per-property
style setters, and a strict policy then has nothing to block.

### Apps that listen to every key

Many apps put a `keydown` listener on `window` or `document`: `/` to search,
`g i` to go to the inbox, `?` for help. Key events from inside a shadow root
are composed, so they reach those listeners, retargeted to the host. Typing
`g` in the step box would fire the app's shortcut.

The fix relies on ordering. The recording script is an init script, so it
runs before any of the page's scripts and its capture listener on `window` is
the first one registered. Listeners on the same node in the same phase run in
registration order. For any key event whose path includes the host, that
first listener handles the bar's own keys (Enter, Esc, arrows) and then calls
`stopImmediatePropagation()`. The page's listeners never hear it, and the text
still goes into the box, because stopping propagation doesn't cancel the
default action. The bar's key handling therefore lives in that one listener,
not on the input: once propagation stops at `window`, the input's own
listeners wouldn't fire either. The same goes for `keypress`, `keyup`,
`beforeinput` and `input`, and for the pointer events on the bar, so an app's
"click outside to close" never fires when you click the toolbar.

The same listener handles the shortcuts: it acts on a trusted Alt+Shift chord,
cancels the event, and stops it.

### The page cannot drive the toolbar

The binding is a function on `window`, so the app's own scripts can call it.
That's harmless for what exists today. It becomes a real concern for Add
step, because a step is text that ends up in your test file and is later
handed to a model with your credentials in scope. So:

- The server gives each document a random **token** in its `hello` answer. The
  recording script keeps it in its closure, where page code can't read it.
- The script keeps its own reference to the binding function from the moment
  it installs, before any page code runs, so a page that replaces
  `window[binding]` to spy on answers gets nothing.
- Every toolbar command (step, stop, cancel, pause and the rest) carries the
  token. A command without it is refused, and so is a step that doesn't come
  from a top-level frame.
- The bar's handlers act only on trusted events (`isTrusted`).

## Accessibility

The bar is a `role="toolbar"` labelled "Record Steps". Arrow keys move
between its buttons. Pause and Add check are toggle buttons (`aria-pressed`).
Each button names its shortcut (`aria-keyshortcuts`) and says it in its
tooltip. The step box is labelled "Add a step" and described by its hint.
Esc from anywhere on the bar sends focus back to the page element that had
it.

A polite live region inside the shadow root announces the changes a screen
reader user would otherwise miss:

- Recording paused / resumed.
- Add check armed: click what to check.
- Step added as step 8.
- Removed: Clicked link Reports.
- Not connected.
- Writing the steps / Done.

It doesn't announce every action or every draft, which would drown the app's
own announcements. A closed shadow root is still in the accessibility tree,
so screen readers reach the bar normally.

**Contrast.** Text on the graphite surface is about 15:1 (main) and 8:1
(secondary). The REC red is about 5.4:1 and the paused amber and pick blue are
higher. No state relies on colour alone: recording has the dot *and* `REC`,
paused has the bars *and* `PAUSED`, pick mode has the pressed button *and*
the hint text. The pick outline is blue with a light halo, so it's visible on
any page colour.

With reduced motion, nothing pulses or fades: the dot is steady and the
confirmations just appear.

## Pause and resume, in detail

Pressing Pause first finishes any typing still open (as Add check does, §4),
so what you typed before pausing is recorded. From then until Resume:

- the page script records nothing and takes no screenshot marks;
- pick mode is disarmed and can't be armed;
- the server ignores the navigation signals it detects itself (Back, Forward,
  Reload, the address bar, new tabs);
- no new draft calls start. A call already running for actions before the
  pause finishes and is shown.

**On Resume we trust you.** You came back to the same place, so there's no
automatic Navigate step and no question. Two things have to be reset for that
to hold. The server re-reads the tab's history as the new starting point, so
a Back you pressed while paused doesn't show up as a `back` after it. And
whichever tab you act in first after resuming is taken as where you are, with
no `tab` event for that move.

The model is told there was a pause at that point. It's also told the time
across the pause isn't a wait the app needed, and that a pause is not a
reason to write any navigation. The gap it's given for the first action after
Resume excludes the paused time, and so does the toolbar's clock.

The panel shows a `❚❚ Paused` row in the action list at that point. The status
bar reads `❚❚ Recording paused — 9 actions`.

## Steps you write: Add step and the editor

### Locking in

A step you write is a fixed point, and everything before it is settled. When
you add one:

1. Typing still open is finished, as for a check.
2. If actions are waiting to be drafted, the draft is brought up to date first,
   in one call, as Stop does. The toolbar says `Adding…` meanwhile.
3. Your line goes in as the next step, **exactly as you typed it**. A leading
   number (`8.`) or list marker you typed is removed and replaced by the
   recording's numbering, and nothing else is changed. You know the format,
   and the model doesn't reword your line.
4. Every step up to and including yours is **locked**. The model can't rewrite
   locked steps.
5. Recording carries on after it.

If the catch-up call in step 2 fails, your step still goes in where you put
it. The actions before it are drafted into the space above it by the next
call, and nothing after it moves. The lock is really a marker in the stream of
actions ("everything before here is settled"), so the steps that belong
before it can still arrive late.

A pasted block of several lines becomes that many steps, in order. An empty
line adds nothing.

### What the model sees afterwards

The draft call's input (§8) gains structure:

- **The locked steps**, numbered and marked final. They are in the test, and
  the model must not repeat or change them.
- **Your steps among them**, each marked "the author wrote this step by hand
  at this point".
- **The open steps** after the last lock, which the model can still rewrite
  (up to three back, as now).
- The new actions, as now.

It's also given one new rule. A step of yours may describe something you then
did in the browser. If you type `Click Pay now` and then click Pay now, the
actions right after your step that do what it says are covered by it, and
the model writes nothing for them. And it never writes a Verify that repeats
one of yours, even from an Add check.

On the output side, `replaceFrom` may reach back neither more than three
steps nor past the last lock. A value that does is refused, and the call is
retried once as a redraft of the open steps only, not of the whole
recording.

Each draft now only rewrites the open part of the block, below the last lock.
So your lines, and the steps locked with them, are never rewritten in the
file at all. That fits the existing rule that the recording never overwrites
text it can't prove it wrote.

### Steps typed in the editor

Typing a step in the test file during a recording does the same as the
toolbar's box. The region that counts runs from the first recorded line to a
new line opened directly under the last one (End, Enter, which §7 already
treats as a line of yours under the block).

- **A new line at the end of the block** goes in there, at that point in time:
  the draft is brought up to date and locked, and the next recorded steps go
  **below** your line. This reverses today's rule in §7, where the next draft
  writes above it.
- **A new line between two recorded steps** goes in there. Everything
  recorded so far is locked, on both sides of it, and the model is told where
  your step sits. Actions not yet drafted go after the whole block, because
  they happened after all of it.
- **Lines above the block** stay outside the recording, as they are today.

A line counts as written when you leave it (the cursor moves to another line,
or you press Enter) and it isn't blank. It is not counted while you're still
typing, so a half-finished sentence isn't locked in when you pause to think.
Until then the recording doesn't touch that line.

What happens when you *edit* a recorded line rather than add one is an open
question (below). Today that edit is overwritten by the next draft, with a
warning.

### Cancel, and Ctrl+Z after Stop

Steps added from the toolbar were written into the file by the recording, so
Cancel takes them out with everything else. Steps you typed in the editor are
your text, so they stay, like every other edit of yours. That is the
recording's standing rule, and breaking it here would mean Cancel deleting
something you typed. The same goes for the one Ctrl+Z after Stop: it lands on
the file without the recording, with your typed lines still there.

## Undo and locked steps

Undo on the toolbar removes the most recent entry in the recording that's
still in: an action, a check, or a step of yours. Pressing it again walks
further back. It uses the same drop and restore as the panel's ✕, so the
panel shows the removed row struck through, and clicking the row (or Restore
on the toolbar) puts it back.

- **Removing an action after the last lock** redrafts the open steps, as a
  drop does now.
- **Removing a step of yours** takes your line out and lifts its lock. The
  steps before it are open again as if you'd never added it, and the model
  can once more rewrite the last three of them.
- **Removing an action from inside a locked stretch** is allowed. A lock stops
  the model rewriting on its own. It doesn't stop you. That stretch, between
  the lock before it and the lock that ends it, is redrafted in one call. Your
  steps at its edges stay as they are, and nothing outside the stretch
  changes. This replaces §8's "a redraft is one call over every remaining
  action" with a call over just the stretch, which is also cheaper.

## On the wire

These are the additions, described at a high level.

**Starting a recording** can carry the toolbar's preferences: on or off, dock,
minimised.

**The control route** gains:

- pause and resume;
- add-step, for steps typed in the editor. It carries the text, where the
  step sits (after which draft step, in which draft revision the author was
  looking at) and the fact that it came from the editor.

Your steps get ids like actions, so the existing drop and restore remove and
restore them too. The `dropped` list on stop stays as a belt-and-braces. Drops
already reach the server as they happen, and the toolbar's Undo happens
there.

**New frames on the stream:**

- *paused*: paused or resumed, and from where.
- *step*: a step of yours joined the recording, with its id, text, source
  (toolbar or editor) and position. It appears in the panel's action list as
  `✎ Your step: Verify the balance…` with a ✕.
- *dropped*: an action or step was removed or restored somewhere other than
  this client, so the panel can strike it through.
- *toolbar*: the bar moved or was minimised, so TestBench can remember it.

The *draft* frame gains how many leading steps are locked, and which steps are
yours. The panel and the file both mark them. Stop and Cancel pressed in the
browser don't need new frames. Stop goes straight to *writing* then
*result*. Cancel ends with *done* `aborted`, which now says it was cancelled
in the browser, so TestBench takes the drafts out without showing an error.

**Page to server, through the one binding:**

- toolbar commands: pause, resume, check, cancel-check, undo, restore, stop,
  cancel, minimise;
- a step, with its text;
- a move of the bar;
- the box's unsent text, sent as you type after a short pause, so a
  navigation or tab switch under the open box doesn't lose it;
- a *focus* message, only a yes or no for whether the focused field is
  secret. It comes from any frame, and a value never travels in it;
- a regular check-in.

Each carries the document's token.

**Server to page:** the existing state push grows from `{recording, pick}` to
include `paused` and a block for the toolbar:

- phase (recording, writing, done, ended);
- elapsed time;
- action count;
- last step;
- updating;
- the current confirmation or error;
- typing hidden;
- dock and minimised.

The `hello` answer carries the same, plus the token. It's pushed to the
top-level frame of every tab. Everything in it is text the panel already
shows, so it is already masked.

## VS Code alongside

The panel keeps everything it has. For parity it gains Pause/Resume and an
Add step box, and its action list shows pause markers and your steps. There
would be new commands, *TestBench: Pause Recording*, *Resume Recording* and
*Add Step to Recording*, plus a setting to turn the browser toolbar off for
authors who record with VS Code beside the browser and prefer the panel. The
panel's per-action ✕ and the model's notes stay panel-only. The bar is for
the moment, the panel is for the whole record.

## Open questions

1. **Editing a recorded line in the editor.** Today the next draft overwrites
   it and you're warned once. With locks available, I'd lock it in with your
   wording, the same as a new line, and drop the warning. Deleting a recorded
   line would likewise drop that step and tell the model not to put it back.
   Do you want that, or keep the overwrite-and-warn?
2. **Cancel and editor-typed steps.** The proposal keeps them after Cancel,
   because they're your text. Would you rather Cancel take them out too, since
   they were part of the recording?
3. **Screenshots: paint the toolbar out rather than hide it?** The cost is a
   filled box where the bar was, and the benefit is no blink on every click.
   Is that acceptable?
4. **Modal dialogs.** Move the bar inside an open modal dialog so it stays
   clickable (a foreign node in the app's dialog), or leave it inert there and
   rely on the shortcuts?
5. **Shortcuts.** Are Alt+Shift+P/C/S/Z/M/R right for you? Should the letters
   be a setting? Should Stop and Cancel really have none?
6. **Resuming in another tab.** Silently adopting whichever tab you act in
   first fits "trust the author". The alternative is recording a `tab` event
   for it. Which?
7. **The Add step box after Enter.** Close and return focus to the page
   (proposed), or stay open for several steps in a row?
8. **Default position and default on.** Bottom centre, toolbar on unless you
   turn it off?
9. **The Steps so far drawer.** Is it worth its space in the browser, or is the
   last-step line enough, with the whole draft left to the panel?

## Decisions confirmed (2026-09-27)

The author approved the design and asked to build it as designed, before the
editing change. Where an open question above had a proposal, the proposal is
taken; where it had none, the simplest safe choice is:

1. **Editing a recorded line in the editor:** unchanged in this change — the
   next draft overwrites it and the author is warned once (§7). Locking an
   edited line in is the next change.
2. **Cancel keeps editor-typed steps** (they are the author's text); steps
   added from the toolbar's box are the recording's and go with it.
3. **The toolbar is painted out of screenshot crops**, not hidden.
4. **Modal dialogs:** the toolbar stays where it is (inert behind the dialog);
   the shortcuts still work.
5. **Shortcuts:** Alt+Shift+P / C / S / Z / M / R as designed, not
   configurable; none for Stop or Cancel.
6. **Resuming in another tab:** that tab is adopted silently — no `tab` event.
7. **The Add step box closes after Enter** and returns focus to the page.
8. **On by default, docked bottom centre;** a TestBench setting turns it off.
9. **The Steps so far drawer is kept.**

## The wire, exactly

Additions to SPEC-record-steps.md §9. Both halves build against this.

**Start** (`POST /sessions/:id/record-steps`) — the body gains:

```ts
toolbar?: {
  enabled: boolean;                                  // false: no toolbar in the page
  dock?: 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br';    // default 'bc'
  minimised?: boolean;                               // default false
}
```

Absent means `{ enabled: true, dock: 'bc', minimised: false }`.

**Control** (`POST /sessions/:id/record-steps/control`) — gains:

```ts
{ action: 'pause' }
{ action: 'resume' }
{ action: 'add-step';
  text: string;                 // one line; several lines = several steps, in order
  source: 'editor' | 'panel';   // the toolbar's box goes through the page binding, not here
  afterStep?: number;           // 0-based index in the draft the author saw; absent = at the end
  revision?: number }           // the record:draft revision that index refers to
```

`drop` / `restore` take the id of an action OR of an author step. Answers stay
202 (with `ignored` when it does nothing) / 404 / 400.

**Frames** — new:

```ts
{ type: 'record:paused'; paused: boolean; atMs: number; source: 'toolbar' | 'panel' }
{ type: 'record:step'; id: string; text: string;
  source: 'toolbar' | 'editor' | 'panel';
  afterStep: number;            // where it sits: 0-based index in the draft it joined
  atMs: number }
{ type: 'record:dropped'; id: string; dropped: boolean; source: 'toolbar' | 'panel' }
{ type: 'record:toolbar'; dock: 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br'; minimised: boolean }
```

`record:draft` gains:

```ts
locked: number;                 // how many leading steps are locked (the model cannot rewrite them)
authored: number[];             // indices of steps the author wrote (toolbar, editor or panel)
authoredIds?: string[];         // their ids, parallel to `authored`
```

`done` gains, for a Cancel pressed in the browser:

```ts
{ type: 'done'; status: 'aborted'; cancelledBy: 'browser' }   // no error text; TestBench takes the drafts out quietly
```

A Stop pressed in the browser needs no new frame (`record:writing`,
`record:result`, `done` as today).

**Page ↔ server** (through the recorder's one binding — internal to the
server half, listed so the client half knows what exists): toolbar commands
(pause, resume, check, cancel-check, undo, restore, stop, cancel, minimise,
dock), a step with its text, the box's unsent text, a focus message (a yes/no
for "the focused field is secret", never a value), and a check-in. Every
message carries the document's token from the `hello` answer; a message
without the right token is ignored. The server's state push to the page grows
from `{ recording, pick }` to include `paused` and a `toolbar` block (phase,
elapsed, action count, last step, updating, current confirmation or error,
typing hidden, dock, minimised).

**TestBench** keeps the toolbar's dock/minimised between recordings (from
`record:toolbar`, sent in the next start body), adds *TestBench: Pause
Recording*, *Resume Recording*, *Add Step to Recording*, a Pause/Resume and an
Add step box in the panel, pause markers and `✎ Your step: …` rows (with ✕) in
the action list, strikes rows on `record:dropped`, and a setting
`testbench-native.recordSteps.browserToolbar` (boolean, default true).

## What the TestBench half built

TestBench 0.5.155. The wire is as above, with two readings made exact while
building against the server half. `afterStep` in `add-step` is the index of
the step the new one goes **after** in the draft the author saw (0 or more;
absent means at the end), which is how the server reads it
(`src/recorder/draft-engine.ts`); it is sent with the `revision` of the draft
last written into the file, since that is the draft the author was looking at.
And a control answered `202 { ignored: "<why>" }` comes back from runner-core's
`controlRecordSteps` as `{ ignored: true, reason }`, so TestBench can say why a
step was not taken.

**Controls.** The three commands, the context key
`testbench-native.recordingPaused` (Pause shows in the editor title bar while
recording, Resume while paused), the setting, and the panel's Pause/Resume
toggle, Add step box (Enter adds, Shift+Enter for several steps) and new rows
all went in as designed. The toggle and the rows show what the server's frames
said, not what was asked for, because the toolbar can pause or drop things too.
Add check is refused while paused, in the panel and the command. The status bar
reads `❚❚ Recording paused — N actions`. Where the toolbar was left is kept in
the workspace's state. A `done` with `cancelledBy: 'browser'` ends like
TestBench's own Cancel, with one info line in the log and no notification.

**Steps typed in the editor** were the real work, because the recording's
fail-safe rule had to hold with the author's lines inside what it writes. The
recorded block is now a run of parts: block, the author's line, block, and so
on. The author's line is a slot of its own (`mine`) that the recording follows
but never writes or removes. A line counts as written when the cursor leaves it
with a step on it. It then goes out as one `add-step` from the editor, or one
per group of neighbouring lines, sent one after another. Until a draft holds
that step, the draft is divided around the line by count: as many steps above
it as the file had, or all of them for a line below the block, which is today's
"the next draft writes above it". Once a draft holds it (by the id `record:step`
named, or by the text it was sent as if the draft comes first), that step is
the line and is never written beside it. Steps before it go above, steps after
it go below.

Three rules were decided here, not in the design:

1. **The author's line takes the recording's number** while the draft holds its
   step. Only the digits of an `N.` line change, or a list marker (or nothing)
   becomes `N. `. The line gets its own number back when the draft stops holding
   it and at Cancel. This follows the design's "replaced by the recording's
   numbering". Without it, a line typed while more actions were being drafted
   above it kept a stale number, a duplicate of a recorded one. A number the
   author edits afterwards is theirs for good, as a later step's is.
2. **Locked lines are protected by writing less, not by a lock of their own.**
   Each draft now changes a block only where it differs, line by line, and a
   line whose only change is its number has just the digits replaced. So a
   draft that keeps its locked steps touches none of them. An edit the author
   makes inside a recorded line is still written over, locked or not. That is
   today's rule, and changing it is the next change.
3. **A deleted line of the author's closes the block up.** A step the draft
   still holds for it is written by the recording from then on, as its own, and
   the ✕ leaves it out. Treating the deletion as a drop would be the "deleting
   a recorded line drops it" question, which belongs to the next change.

The fail-safe rule was extended in three places. The block and the author's
lines are found by text together, as one run. A record holding lines of the
author's is never "nothing left" while one of them is still in the file,
because writing afresh would duplicate the step, so the recording stops
writing live instead. A draft that places the author's steps in an order the
file does not have is not written. Cancel keeps the typed lines with the
numbers the author gave them, and the one Ctrl+Z after Stop lands on the file
without the recording but with those lines. The reload recovery (§7.5) keeps
them too.

**Tests.** `tests/record-steps-authored.test.js` holds 22 cases against the
pure core. They cover the end-of-block and between-steps lines, CRLF, a block
that ends the file, pasted groups, blank and half-typed lines, lines above the
block, refused lines, edits after sending, numbers, toolbar ids never taken
for typed lines, deletion, the no-fresh-write rule and reload removal. There is
also a 300-seed property run: a write never replaces a character the author
typed (bar a held line's number), an adopted step is never in the file twice,
Cancel leaves only the author's lines, and the writing never loses its place.
The panel's frames, marks and text are covered as well. Six host cases were
added to the integration suite: Pause/Resume, Add Step and its rows, a line at
the end, a line between steps (with the undo after Stop), the remembered
toolbar and the setting, and a browser Cancel. runner-core adds the frame guard,
the two webview messages and the `ignored` answer.
