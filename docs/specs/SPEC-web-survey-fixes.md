# SPEC: framework fixes from the web survey

The web survey ([docs/web-survey-sites.md](../web-survey-sites.md)) ran the 34
section C tests twice: once on `main` and once on PR #19. Each run passed 6 or
7 of the 34. The runs are recorded side by side in
[survey/web/results/section-c-runs.md](../../survey/web/results/section-c-runs.md).
This spec lists every failure that came from Steptix rather than from the test
file or the site, explains each one, and describes the fix.

The failures caused by the test files or the sites are in §3. They are fixed
in the test files, not here.

## 1. Summary

| § | Gap | Tests it failed | What Steptix does today | Fix |
|---|-----|-----------------|-------------------------|-----|
| 2.1 | No way to answer a browser dialog | 43, 48, 50, 54, 57, 60, 61 (7) | Dismisses every alert, confirm and prompt by itself. A step cannot accept a confirm, type into a prompt, or read the dialog's text | A `dialog` action that sets how the next dialog is answered, and a record of every dialog the model and assertions can see |
| 2.2 | No double-click or right-click | 41, 49, 60 (3) | `click` always does one left click. The model sent `doubleClick`, was refused, then declared the step impossible | `clickCount` and `button` on `click`, with the parser mapping `doubleClick`, `rightClick` and similar names onto them |
| 2.3 | Typing does not fire key events | 53, 58 (2) | `type` uses Playwright's `fill`, which fires only `input`. Filters that listen for `keyup` never react | After `fill`, press `End` on the field, which fires `keydown` and `keyup` without changing the text |
| 2.4 | `count` counts hidden elements | 53 | `count` counts every match, so a filtered list counts the same before and after | Count visible matches by default. `includeHidden: true` keeps the old behaviour |
| 2.5 | Ads block clicks | 44, 59 (2) | A Google ad iframe that covers the target makes the click time out after 10 s | When the element blocking the click is an ad, hide the page's ad frames and retry once. An opt-in `browser.blockAds` stops ad requests at the network |
| 2.6 | Key names are case-sensitive | 62, 71 (2) | `keyboard.press("END")` and `press("CTRL+A")` throw "Unknown key" | Map key names to Playwright's spelling, including chords such as `ctrl+a` and `Control+A` |
| 2.7 | `type` breaks on colour, date and range inputs | 46 | `type` clears first. Clearing `<input type=color>` fills `""`, which is a malformed value | Skip the clear on inputs that cannot be empty, and normalise colour values to `#rrggbb` |
| 2.8 | Multi-selects take one value | 50, 56 (2) | `select` passes one string, so `"Red, Green"` matches no option | When the `<select>` is `multiple`, accept a list (`values`) or a comma-separated `value`, matched by value, then by label |
| 2.9 | Drag is a single jump | 52, 72 (2) | `dragTo` jumps from source to target, which jQuery UI's draggable and sortable ignore | Drag with the mouse in steps: press, nudge past the drag threshold, glide to the target, release |
| 2.10 | Hidden checkbox inputs cannot be clicked | 62 | A click on a styled checkbox's hidden `<input>` waits for it to become visible, then times out | When the only match is a hidden checkbox or radio, click its `<label for>` or its nearest visible ancestor |
| 2.11 | Text reads include script source | 64 | `read` takes `textContent`, so reading a container also captured its `<script>` | Drop `<script>`, `<style>` and `<template>` text from element reads |
| 2.12 | Wrong "no value" warnings | every run that captures a value | The MCP run result warns that `{{x}}` "will reach the AI literally" when an earlier `[as: x]` step fills it | Treat names captured by earlier steps as defined |
| 2.13 | Waits cannot compare numbers | 42 | A `wait` on an attribute matches one exact value, so `aria-valuenow=75` misses a bar that steps past 75 | Accept `>=`, `<=`, `>` and `<` in attribute waits |
| 2.14 | Assertion replies in the wrong shape | 53, 54 in the first run with the fixes; 51, 68 recovered earlier | The assertion prompt asks for `{ "code": … }` but goes out beside the action system prompt, so the model sometimes replies `{ "actions": [ … ] }`. The retry sent the same prompt and got the same reply | Take the code from inside an `actions` reply or a ```` ```js ```` fence, and tell the model what was wrong before asking again |
| 2.16 | Passed checks are forgotten | 46 in the first run with the fixes | Passed assertions are left out of the "completed actions" the next turn is shown. A step that verifies two things checked the first, asked to continue, and checked it again, 15 times | List each passed assertion in the next turn's completed actions, with the value it read |
| 2.17 | Settling inside an immediate chain | 42 | After each page-changing action the step loop waits up to 3.5 s for the page to stop changing. On a progress bar that changes every 100 ms, it waited the full 3.5 s after "click Start" and again after the wait, so "click Stop at 75%" clicked Stop at 100% | Skip the settle after a trigger with a `wait` right behind it, and after a `wait` with an action right behind it |
| 2.18 | Textless elements have no identity in the snapshot | 40, 41 | The snapshot keeps only allow-listed attributes, so `class` is always dropped. Three empty circle divs and a tree's empty expand toggle came out as bare `<div>` and `<span>`, and the model could only guess by position | When an element has no text and no naming attribute, keep up to four readable class names (never hashed or generated ones), and allow `draggable` |
| 2.15 | Range values outside the slider | 46 in the first run with the fixes | "Set the slider to its maximum" was typed as `100` into a slider that stops at 10, which Playwright refuses as malformed | Clamp a range value to the input's own `min` and `max`, and read `max` and `min` as the two ends |
| 2.19 | A drag whose target starts below the screen | 40 | `drag` scrolled the source into view, which leaves it at the viewport's bottom edge. The target was still below, so the drag fell back to `dragTo`, which scrolls mid-drag. Chromium drops an HTML5 drag that scrolls, so both circle drags "succeeded" and moved nothing | Before pressing, scroll so source and target are centred on screen together when they fit |
| 2.20 | Typing into a field something covers | 42 | `type` uses `fill`, which types into a field even when another element covers it. The overlapped-element page clears the field on `input` when its centre is covered, so the text vanished | Before typing, when the field is not what the browser hits at its centre, scroll it into view centred, then at the start, then at the end, stopping at the first that uncovers it |
| 2.21 | A threshold wait with a fixed timeout | 42 | A numeric attribute wait (§2.13) fails after 10 s. The progress bar reached 75% after 8, 18 and 22 s on three runs, so the wait timed out on a slow run and the retry clicked Stop at 87% by eye | While the value keeps moving towards the limit, push the deadline out by the timeout each time, up to the 10-minute cap. A value that stands still or moves away still fails after the timeout |
| 2.22 | A drag pressed through an ad | 40 | A drag presses at the source's coordinates without checking what is there. The circles page has side-rail Google ad frames that reposition after a scroll, and about one drag in five pressed on one: no `mousedown` reached the page, the drag "succeeded", and the red circle stayed put | Move the pointer onto the source first and check the source received the `mousemove`. If not, hide the page's ads (as §2.5 does for a click) and try once more; if something else covers it, fall back to `dragTo`, whose actionability check reports what intercepts the pointer |
| 2.23 | `browser.blockAds` ignored on the server | every survey run | On the server path, `browser.*` comes from the server's own config except for a listed few keys, and `blockAds` was not one of them. The survey project set it, and no session ever blocked an ad. A Google vignette covered test 40's last steps | Read `blockAds` off the session's project config at launch, as `launchArgs` already is |
| 2.24 | No press-and-hold | 44 | There was no way to hold a button down. LetCode's "Click and Hold" button only reacts to a press of about two seconds, and `click` releases at once | `holdMs` on `click` (Playwright's `delay` between press and release), with `longPress`, `pressAndHold`, `clickAndHold` and similar names mapped onto it at 2 s |
| 2.25 | A failed check does not say where the expected text is | 45 | An assertion that reads the wrong element fails with "expected X, got Y", and the retry is shown only that, so it reads the same element again. The form results page repeats the empty form above the results; both attempts read the empty textarea ("Comments...") | On a failed DOM assertion, find the smallest visible elements whose text contains the expected value (or a part of it) and add their CSS paths to the failure |
| 2.26 | Shadow DOM missing from the snapshot | 44 | The snapshot walks `childNodes` only, so an open shadow root's content never appeared. LetCode's first-name field sat in `div#open-shadow`'s root, the snapshot showed the div empty, and the model guessed a selector that matched nothing | Walk each open shadow root before the element's light children, between `<!-- shadow-root (open) -->` markers; tell both prompts how to reach it |
| 2.27 | No way to type where `fill` cannot | 44 | `type` uses `fill`, which only takes inputs, textareas and contenteditables, and `keyboard` only presses keys. A field inside a CLOSED shadow root cannot be queried by anyone, Playwright included, so there was no way to type into it | When the target is not fillable, `type` clicks it and types on the keyboard. `keyboard` takes `text` to type into whatever has focus |
| 2.28 | `find` does not say a match is hidden | 45 | A sidebar entry two collapsed levels deep shows in the snapshot only as `<ul><!-- hidden --></ul>`. The model could not tell which section held "Dynamic Buttons 01", wandered for 15 turns, then clicked the hidden link until it timed out | Each `find` match that is not rendered says so and names the collapsed sections around it, outermost first; rule 19 says to `find` an unseen menu entry and open those sections first |
| 2.29 | A text wait ignored its frame | 52 | `wait` with `waitType: text` polled the main page's `document.body.innerText` even when the action named a frame, so it can never see a frame's text. The download dialog inside globalsqa's demo iframe already said "Complete!" and the wait still timed out, twice | Inside a frame, wait for `getByText(condition)` to be visible in that frame |
| 2.30 | Blocking ads broke a page | 58 | `blockAds` (once §2.23 made it work on the server) routed every request through Playwright to abort the ad ones. On LetCode's sister site testmuai, the jQuery download dialog then stuck at "Starting download…" with a page error. A route that blocks NOTHING breaks it the same way, so the interception's own delay loses a race in the page's start-up | In Chromium, block ad hosts with `--host-resolver-rules` (`MAP <host> ~NOTFOUND`), which needs no interception; route only on Firefox and WebKit |
| 2.31 | Checks cannot see inside an iframe | 63 | Assertion code runs with `page.evaluate` in the top document, so `document.querySelector('#checkBox6')` never finds a checkbox inside `#myFrame3`. The click into the frame worked; the check that it was ticked said "element not found", twice | An assert with `frame` runs its code inside that frame; both prompts say how to reach frame content |
| 2.32 | The hidden-toggle stand-in clicked a 1 px wrapper | 62 | §2.10 clicks the nearest visible ancestor of a hidden checkbox input. PrimeFaces wraps the input in a 1×1 px `ui-helper-hidden-accessible` div, which Playwright counts as visible and the real checkbox box covers, so the click timed out on "intercepts pointer events" | A stand-in must also have a box of at least 4×4 px |
| 2.33 | Notifications close before they are checked | 62 | A PrimeFaces growl closes after six seconds and a model turn takes several, so "Verify a message confirms the Ajax checkbox was checked" read a page whose message had gone | The page records toast-like notifications as they appear; the snapshot lists the ones that have closed, and assertion code can read `window.__steptixNotices` |

## 2. Fixes

### 2.1 Browser dialogs

**What happens today.** `installDialogGuard` (`src/browser/manager.ts`)
answers every dialog the instant it opens: it accepts `beforeunload` and
dismisses everything else. So an alert closes, a confirm returns `false`, and a
prompt returns `null`. That is why "accept the alert" sometimes passed (closing
an alert is the same as accepting it), "click Confirm and dismiss" passed, and
every prompt step failed. The model has no action for dialogs. It invented
`accept_alert`, `accept_dialog`, `acceptDialog`, `handleDialog` and `dialog`,
and each was refused as an unknown type. Steptix also cannot read a dialog's
text: test 48 failed checking that the alert said "Hello Steptix", with the
assertion reporting that the text was not in the DOM.

**Why the guard cannot simply wait.** A dialog left open blocks the page: every
`evaluate` call hangs until it is answered, and the DOM snapshot uses one. So
the answer has to be decided before the dialog opens.

**Fix.**

1. A new action, `dialog`, with `value: "accept" | "dismiss"` and, for a
   prompt, `text`. It does nothing on the page. It sets how the **next** dialog
   in the session is answered, and that setting expires when the step ends.
   The model sends it in the same turn as the click that opens the dialog, and
   before that click.
2. The parser maps the names the model reached for (`acceptDialog`,
   `accept_alert`, `acceptAlert`, `confirmDialog`, `handleDialog`,
   `dismissDialog`, `cancelDialog`) onto `dialog`, with `value` taken from
   the name.
3. The guard keeps a record of the last 20 dialogs per browser context: type,
   message, how it was answered, and when. The step executor adds the dialogs
   seen during the step to the model's next turn ("A browser confirm appeared:
   'Press a button!'. It was dismissed."), and to the assertion prompt, so a
   step like "Verify the alert says …" can be checked against the record.
4. A `dialog` action that arrives **after** a dialog has already been answered
   in the same step returns an error: the dialog was already answered as
   *dismiss*, so send `dialog` first, then click again. The model's retry then
   gets it right.
5. The default answer for an unexpected dialog does not change.

**Tests.** Unit tests for the arming, the expiry, the record and the aliases,
on a page that opens an alert, a confirm and a prompt (`page.setContent`).

### 2.2 Double-click and right-click

**Fix.** Two optional fields on `click`: `clickCount` (1 or 2) and `button`
(`left`, `right` or `middle`), passed to Playwright's `click`. The parser maps
`doubleClick`, `dblclick`, `double_click` to `click` with `clickCount: 2`, and
`rightClick`, `contextClick`, `contextMenu` to `click` with `button: "right"`.
The action prompt documents both fields. Code-behind generation emits
`dblclick()` or `click({ button: 'right' })` for them.

### 2.3 Typing fires key events

**What happens today.** `executeType` calls `locator.clear()` then
`locator.fill(value)`. `fill` sets the value and fires `input`. It fires no
`keydown`, `keypress` or `keyup`. Measured on both sites: the Automation
Bookstore filter and the LambdaTest task filter showed every row after
`input`, and the filtered rows only after `keyup`.

**Fix.** After `fill`, press `End` on the same element. `End` moves the caret
and leaves the text alone, and it fires `keydown` and `keyup` on the field, so
key-driven widgets see a key event after the value has changed. It is skipped
for input types where `End` would change the value (`range`, `number`, `date`,
`time` and similar) and for `<select>`.

### 2.4 `count` counts what is shown

**Fix.** `executeCount` counts `visible=true` matches. A new optional
`includeHidden: true` counts every match, as before. The action prompt says
that `count` counts visible elements. Code-behind generation emits the same
filter, so a compiled count and an AI count agree.

### 2.5 Ads that block clicks

**What happens today.** On test 59 a Google anchor ad (`iframe#aswift_8`,
inside `ins.adsbygoogle`) sat over the Register button for the whole 10 s of
the click. On test 44 a full-screen vignette (`#goog_fullscreen_ad`) did the
same.

**Fix.**

1. When a click fails, and Playwright's log says the element that "intercepts
   pointer events" is an ad (its markup mentions `adsbygoogle`, `aswift`,
   `googleads`, `google_ads`, `doubleclick` or an `Advertisement` title),
   remove ad containers from the page and from the click's frame, then retry
   the click once. Only ad markup is removed, so a real overlay still fails the
   click.
2. A new opt-in setting, `browser.blockAds` (default `false`), aborts requests
   to well-known ad hosts (`doubleclick.net`, `googlesyndication.com`,
   `googleadservices.com`, `adservice.google.*`, `amazon-adsystem.com`,
   `adnxs.com`, `taboola.com`, `outbrain.com`). It is off by default because
   a site under test could depend on one of them. In Chromium those hosts are
   made unresolvable rather than intercepted (§2.30).

### 2.6 Key names

**Fix.** `executeKeyboard` maps every part of a key chord to Playwright's
spelling before pressing it: `ctrl` and `CTRL` become `Control`, `cmd` becomes
`Meta`, `esc` becomes `Escape`, `end` and `END` become `End`, `del` becomes
`Delete`, `pgdn` becomes `PageDown`, and `+` joins a chord. A single letter
keeps its case.

### 2.7 Inputs that cannot be cleared

**Fix.** `executeType` reads the input type first. For `color`, `date`,
`datetime-local`, `month`, `time`, `week` and `range` it skips `clear()`,
because an empty value is malformed for them and `fill` replaces the value
anyway. A colour value is normalised to lowercase `#rrggbb`, and a three-digit
`#rgb` is expanded.

### 2.8 Multi-selects

**Fix.** `AIAction` gains `values?: string[]`. `executeSelect` checks the
element: when it is a `<select multiple>` and the action carries `values`, or a
`value` with commas, it selects all of them in one `selectOption` call. Each one
is matched by value, falling back to label. A single-select keeps its current
behaviour.

### 2.9 Stepped drag

**Fix.** `executeDrag` takes the bounding boxes of both elements (page
coordinates, which hold for elements inside frames too). It moves the mouse to
the centre of the source, presses, moves 5 px to pass the drag threshold,
glides to the centre of the target in 15 steps, and releases. If either box is
missing (the element is off-screen or detached) it falls back to `dragTo`.
HTML5 drag-and-drop still works, because Chromium dispatches the drag events
for real mouse movement.

### 2.10 Styled checkboxes and radios

**Fix.** When a click finds no visible match, and every match is an
`<input type=checkbox|radio>`, it clicks the first visible of: the
`<label for=id>`, the enclosing `<label>`, or one of the input's nearest three
ancestors. This is what a person does with a PrimeFaces or Material checkbox.

### 2.11 Text reads skip script source

**Fix.** `extractValueInPage` copies the element when it contains a `<script>`,
`<style>` or `<template>`, strips those from the copy, and reads the copy's
`textContent`. An element without them reads exactly as before.

### 2.12 Placeholder warnings

**Fix.** The MCP placeholder check adds every name an earlier step captures
(`[as: x]`, `[store as: x]`, `[output: x]`, `store as {{x}}`, `Set {{x}} to`)
to the defined set before it reports undefined placeholders.

### 2.13 Numeric attribute waits

**Fix.** An attribute wait condition of the form `attr>=75`, `attr<=75`,
`attr>75` or `attr<75` compares the attribute as a number. `attr=75` keeps its
exact meaning. The prompt shows the form for progress bars and sliders.

### 2.14 Assertion replies in the wrong shape

**Fix.** `parseAssertionCode` takes `code` from the top level, then from any
action in an `actions` array, then from the first ```` ```js ```` fence holding
a function. When none has it, the next attempt sends the unusable reply back
as the assistant's turn with one line saying what was wrong and the exact shape
to send, instead of the first prompt again.

### 2.15 Range values

**Fix.** `executeType` reads a range input's `min` and `max` (HTML's defaults
are 0 and 100) and clamps a numeric value to them. `max`, `maximum`, `min` and
`minimum` are taken as the two ends.

### 2.16 Passed checks are remembered

**Fix.** The step loop records each assertion that passes and adds it to the
next turn's "completed actions" as `Verified, and it PASSED: <description>
(read "<value>"). Do not check this again`. A failed assertion still ends the
turn as before.

### 2.17 No settle inside an immediate chain

**Fix.** Before the post-action settle, the step loop looks at the next action
in the same turn. It skips the settle when that next action is a `wait` (the
wait is the settle, on the condition the model named), or when the current
action is a `wait` and another action follows it (the condition holds, so act
now). The last action of a turn still settles, so the next snapshot is taken
on a page that has caught up.

### 2.18 A readable class for textless elements

**Fix.** In allow-list mode, `getAttributes` (capture-dom.js) adds a `class`
attribute when the element has no text content and none of `id`,
`data-testid`, `name`, `aria-label`, `title`, `alt`, `placeholder`, `href`,
`for` or `value`. It keeps at most four class tokens, each a plain name
(letters, digits, `-`, `_`). It skips tokens with three or more digits in a
row, framework prefixes (`css-`, `sc-`, `jsx-`, `emotion-` and similar), and
mixed-case-plus-digit or `__hash` tokens, which are generated. `draggable` joins
the allow-list. An element with text, or with a naming attribute, is captured
exactly as before.

### 2.19 A drag whose target starts below the screen

**Fix.** `executeDrag` scrolls the source into view, then reads both boxes
against the window's own `innerWidth` and `innerHeight`. `viewportSize()` is
null for a headed launch and for every CDP page, and with a null size every box
counted as on screen, so the survey's headed run never scrolled at all.
When either centre is off-screen and the two fit on one screen together
(`scrollToFitBoth`), it scrolls the window by the offset that centres their
combined box, with `behavior: 'instant'` so a page's smooth scrolling cannot
move them after they are measured. It then reads the boxes again and drags in
steps as before. A pair too far apart for one screen, or one that scrolls
inside a container the window scroll does not move, still falls back to
`dragTo`.

### 2.20 Typing into a field something covers

**Fix.** Before clearing and filling, `executeType` checks whether the field
is what `elementFromPoint` returns at its centre (the field or something
inside it). If not, it calls `scrollIntoView` with `block` set to
`center`, then `start`, then `end`, and stops at the first that makes the
field reachable. This is the same idea as Playwright's own retry of scroll
alignments for a covered click. If nothing uncovers the field, it is typed into
as before.

### 2.21 Threshold waits follow the value

**Fix.** An attribute wait with `>=`, `<=`, `>` or `<` runs through
`waitForThreshold`. It reads the number every 100 ms and remembers the best
value so far, meaning the closest to the limit. Each new best pushes the
deadline to now plus the wait's timeout, never past `MAX_WAIT_TIMEOUT_MS`. A
reading that does not improve on the best leaves the deadline where it was. So
a wrong selector, a stalled bar, or a value moving the wrong way fails after
the timeout, exactly as before, and the error says how far the value got.
Exact-match and presence waits are unchanged.

### 2.22 A drag checks the pointer reaches the source

**Fix.** Before pressing, `executeDrag` installs a capture-phase
`mousemove` listener on the source's window and moves the pointer to the
source's centre (two moves, so the last is a real change of position). The
source "felt" it when the event's composed path includes the source. A frame
on top takes the event, so the source's window sees nothing. When the source
did not feel it, `hideAds` runs; if it hid anything, the box is read again
and the probe repeats. A source that still does not feel the pointer goes to
`dragTo`, so a non-ad cover fails loudly instead of dragging nothing. The
probe runs at the moment of pressing rather than before the scroll, because the
covering ads move in response to the scroll. If the probe cannot be installed,
the drag proceeds as before. Releasing a press that landed on an ad would click
the ad, which is why the check moves the pointer rather than pressing.

### 2.23 `browser.blockAds` is per project on the server

**Fix.** The session launcher reads `blockAds` the way it reads
`launchArgs`: off `session.browserConfig` (the project's `browser`
section, written by the steps handler before the first step), falling back to
the server's own setting when the project says nothing. A project can turn it
off where the server has it on. `ProjectBundle`'s list of per-project
`browser.*` keys names it. Under the CLI it already worked, since there the
project's config is the run's config.

### 2.24 Press and hold

**Fix.** `click` takes `holdMs`, the milliseconds between mousedown and
mouseup, passed to Playwright as `delay` and added to the click's timeout. It
is read only on a `click`, rounded, and capped at 30 s; a double-click
ignores it. The parser maps `longPress`, `longClick`, `pressAndHold`,
`clickAndHold` and `holdClick` (in any case or separator) to `click` with
`holdMs: 2000` unless the model sent its own. Rule 9a tells the model to use
the time the step names, else 2000.

### 2.25 A failed check says where the expected text is

**Fix.** When a non-predicate assertion fails, the step loop calls
`describeWhereExpectedIs` (src/browser/locate-text.ts). It splits the expected
value into at most four fragments: the whole value, then the parts of a list
split on `;`, newlines, `, ` and ` and `, then the value of each
`label: value` part. Booleans and fragments under three characters are dropped.
For each fragment it finds the smallest visible elements whose `innerText`
contains it (no child holds the whole fragment) and builds a CSS path to up to
three of them, anchored at the nearest unique `id`. Those paths are appended
to the failure: `— the page does show "Steptix survey" at li#_valuecomments. If
that is what the step means, read it from there`. The retry sees the
sentence in its prior failures; a person reading the report sees it too.

Two gaps had kept even the bare failure from the retry. A failed assertion was
never added to the attempt's failure list, so the retry prompt had nothing to
say about it; it is now recorded like a failed action (`Action "assert"
failed: …`). And the second model call, the one that writes the check's code
and so picks the element, saw no prior failures at all; on a retry it now gets
the earlier attempts' check failures as a separate message, with the instruction
not to read the same element again unless it is what the step means. When
the text is nowhere on the page, nothing is added. The hint never passes a
check; the retried assertion still has to read the value and compare.

### 2.26 Open shadow roots in the snapshot

**Fix.** `processElement` (capture-dom.js) emits an element's open
`shadowRoot` children before its light children, between
`<!-- shadow-root (open) -->` and `<!-- /shadow-root -->`, at the next indent.
Hiding, attribute and collapse rules apply inside as anywhere else; a collapse
marker inside a root names the host. A closed root is unreachable from page
script, so it is not shown. An `<iframe>` inside a root is shown with
`<!-- inside a shadow root: contents not captured -->` and no `[iframe:N]`
placeholder. Playwright's `locator('iframe').all()` lists shadow-root frames
after every light-DOM frame (measured), so leaving them unnumbered keeps every
light-DOM frame on its index. The action prompt says a selector reaches open
shadow content as written (Playwright CSS searches open roots). The assertion
code prompt says `document.querySelector` does not, and shows going through
`host.shadowRoot`.

### 2.27 Typing where fill cannot

**Fix.** `executeType` asks first whether the target can be filled: an
`<input>`, `<textarea>`, `<select>`, a contenteditable, or a `<label>` with
a control. When it cannot, it clicks the element, presses
`ControlOrMeta+A` so the text replaces what is there, and types the value on
the keyboard. That is how a person reaches a field inside a closed shadow root,
and it also covers canvas and editor surfaces. When the check itself cannot run,
the ordinary path runs and reports what is wrong. `keyboard` takes `text`,
typed into whatever has focus, before any `key` it also names. Rule 9b
describes both.

### 2.28 `find` names the collapsed sections

**Fix.** For each match, `find-in-dom.js` walks up to `body`. Every ancestor
with `display: none`, `visibility: hidden` or the `hidden` attribute marks the
match hidden. The ancestor's section label is the text of the first sibling
beside it in its parent that has any, else its previous sibling's, capped at 60
characters. Labels are collected outermost first, without repeats, into
`collapsedUnder`. `formatFindResults` appends `hidden — inside collapsed:
Challenges › Synchronization. Open those first, outermost first; clicking it
while hidden times out`, or `hidden — not visible right now` when no label
could be read. Rule 19 tells the model to `find` an entry it cannot see before
guessing, and to open the named sections one per turn.

### 2.29 Text waits in a frame

**Fix.** `executeWait`'s `text` case waits for
`root.getByText(condition).first()` to be visible when `root` is a frame.
`getByText` matches rendered text, as the main-page branch's `innerText` check
does. On the main page nothing changes.

### 2.30 Block ad hosts without intercepting

**Measured.** testmuai's jQuery download demo, four runs each: no
interception gave "Complete!" every time. Aborting ad requests, answering them
with an empty 200, or routing every request and continuing all of them gave
"Starting download..." and `cannot call methods on button prior to
initialization` every time. Even routing that matched no request at all broke
it. With `--host-resolver-rules` the page worked and the ad requests still
failed.

**Fix.** `adHostResolverRule()` builds
`--host-resolver-rules=MAP doubleclick.net ~NOTFOUND, MAP *.doubleclick.net
~NOTFOUND, …` from `AD_HOSTS`. `launchBrowser` passes it to a Chromium launch
when `blockAds` is on, after `--window-size` and before the author's
`launchArgs`, so an author's own switch can still override it. No route is
installed for Chromium. Firefox and WebKit, which have no such switch, keep the
route. The CDP path is unchanged: it attaches to a browser someone else started.

### 2.31 Checks inside an iframe

**Fix.** `resolveFrame` (actions.ts) turns a frame selector (same `>>` or space
segmenting as action frames) into a Playwright `Frame`. When an assert has
`frame`, `evaluateAssertion` resolves it once and runs the generated code,
polling included, in that frame. The code prompt says `document` is the
frame's own document. If the frame is not found, a warning is logged and the
code runs on the page. Without `frame`, the code prompt now says frame content
is not searched by `document.querySelector`, and shows `contentDocument` for
a same-origin frame. Rule 16 says an `assert` takes `frame` like any other
action.

### 2.32 Stand-ins a person could click

**Fix.** In `standInForHiddenToggle`, a candidate (label or ancestor) must be
visible **and** have a bounding box of at least 4×4 px. The 1 px clip wrapper is
skipped, and the next ancestor, the toggle's container, takes the click.

### 2.33 Notifications are remembered

**Fix.** `installNoticeRecorder` (notices.ts) adds an init script to every
launched or attached context, and runs it in the pages already open. It keeps
`window.__steptixNotices`, up to 20 `{ text, at }` records with a WeakRef to
the element, newest last. It records any element matching `role="alert"`,
`role="status"`, `aria-live`, or a class containing toast, growl, snackbar or
notification, both when it is added and when its text changes. The same text
within 3 s is recorded once. `captureDomSnapshot` appends a comment listing
records from the last 60 s whose element is gone, hidden or now says something
else, with their age. A notification still on screen is in the snapshot itself.
The assertion code prompt shows reading `window.__steptixNotices` for a
message that may have closed. Nothing on the page changes.

## 3. Failures caused by the test files or the sites

These are fixed in the test files.

| # | What was wrong | Fix in the test file |
|---|----------------|----------------------|
| 39 | The site never finishes loading in any browser | Left as is. It is recorded as blocked by the site |
| 40 | The table offers 3, 5, 10 and All per page, not 25 | Show All entries |
| 41 | DemoQA's checkbox tree has no "expand all" button any more | Expand Home, then the folders, with the toggle next to each name |
| 47 | Formy's Places autocomplete fills only the address field | Verify the address field instead of the city |
| 55 | The web table's Add form posts to `#` and reloads, so no record is ever added. Its "Type to Search" box filters nothing either: typing changes no rows, and Enter submits the form to `?` | Read a cell and count the rows instead |
| 44 | LetCode's Button page no longer has a double-click button, and its "new tab" button opens the workspace URL itself | Drop the double-click (covered by 41, 43, 49, 50), and check the new tab's address starts with the site |
| 57 | `/sliders/` is now a 404; the page moved to `/slider/` | Navigate to `/slider/` |
| 59 | The first frame's dropdowns are now a course list (Java, Dot Net, Python, Javascript) and an IDE list; "Baby Cat" is gone | Select Python |
| 60 | The sample table lists Friends characters now; there is no Clark | Read Joey's occupation |
| 48 | "Open Tab" opens qaclickacademy.com, which answers with a Cloudflare 526 (invalid SSL certificate) page | Check the new tab's address rather than its content |
| 58 | No task in the table mentions jQuery | Search for "Testing" and expect one row |
| 63 | The dropdown drives the meter and the slider drives the progress bar, not the other way round | Swap the two checks |
| 64 | "Navigate to signup" clicked a link that opened a new tab, so "the main tab" was a different tab | Stay in one tab: go to the URLs directly, and close the signup tab rather than switching back |
| 66 | The test had no way to say that a buggy build is meant to fail | Give each row its expected answer, so build 2's wrong answer (23) is the pass condition |
| 70 | "Choose to add 1 more passenger" was ambiguous: the page has a checkbox and a count | Name both controls |

## 4. Out of scope

- **Test 42, "click Stop as soon as the bar reaches 75%".** A model turn takes
  seconds. §2.13 makes a `wait` then `click` sequence in one turn possible,
  and that is the fix within reach. Acting faster than one turn is not.
- **Test 45, the assertion that read "Password:" instead of the value.**
  Generated assertion code picked the wrong element. It needs a separate look
  at how assertion code locates values.
