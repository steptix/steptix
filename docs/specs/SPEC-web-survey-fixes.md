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
| 2.5 | Ads block clicks | 44, 59 (2) | A Google ad iframe that covers the target makes the click time out after 10 s | When the element blocking the click is an ad, hide the page's ad frames and retry once. An opt-in `browser.blockAds` stops ad requests at the network **Superseded by §2.47:** the ad hiding is removed. |
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
| 2.22 | A drag pressed through an ad | 40 | A drag presses at the source's coordinates without checking what is there. The circles page has side-rail Google ad frames that reposition after a scroll, and about one drag in five pressed on one: no `mousedown` reached the page, the drag "succeeded", and the red circle stayed put | Move the pointer onto the source first and check the source received the `mousemove`. If not, hide the page's ads (as §2.5 does for a click) and try once more; if something else covers it, fall back to `dragTo`, whose actionability check reports what intercepts the pointer **Superseded by §2.47:** the ad hiding is removed. |
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
| 2.34 | Exact role names miss icon buttons | 62 | An icon font draws its glyph with CSS `::before` content, and that counts in the accessible name. PrimeFaces' Dismiss button is named "<glyph> Dismiss", so `role=button[name="Dismiss"]` matched nothing on an open dialog, twice | When an exact `role=…[name="…"]` matches nothing, act on the one visible element of that role whose visible text, or else whose name with case and symbols aside, is the name; refuse when several are (a plural action takes them all), and list the role's names when none is (issue 26) |
| 2.35 | A navigation to a 404 passed | 62 | "Navigate to input.xhtml" was sent to `/pages/input.xhtml`, which answered 404 Not Found; the navigate succeeded because a page loaded, and the next step had no field to type into and asked for clarification | A navigate reports the document's HTTP status; a 4xx or 5xx fails it (retryably) unless the step mentions an error or a status code |
| 2.36 | A drag cannot say which side to drop on | 72 | "Drag Item 1 below Item 3" let go on Item 3's centre. A jQuery UI sortable decides before or after by which half the pointer is in, so Item 1 landed before Item 3 | `position` on `drag` (`above`, `below`, `left`, `right`) lets go at 20% or 80% of the target's height or width |
| 2.37 | A navigation timeout does not say whether the site is up | 39 | "page.goto: Timeout 30000ms exceeded" and nothing else. the-internet.herokuapp.com answered curl and Firefox in under a second, while Chromium and Edge hung on it every time, and the bare timeout read as "the site is down" | On a navigation timeout, ask the URL once from outside the browser and add which it is: the site answers (with its status and time) or it does not answer at all. The message names the symptom only, not a browser flag |
| 2.38 | "The page says X" is checked by equality on the wrong element | 45 | The check generated for "Verify the page says the confirm returned true" read the value span (`true`) and compared it for equality with the whole sentence, so it failed; §2.25's hint rescued it on the second attempt in every run | The assertion prompt says "says/shows/displays/contains" passes by containment, exact equality only for "equals/exactly/only", and that the element read must hold all of the expected text, with an innermost-element example |
| 2.39 | A step that leaves the choice open made the model ask | 56 | "Pick an experience level and tick two skills" returned a `prompt` action asking which level and which skills, and the step failed waiting for an answer | Rule 7 says a step that leaves a choice open is not unclear: choose any valid option and name it in the description; ask only when the step names something the page does not have |
| 2.40 | A value from an unset environment variable is typed into the page | 41 | `bookstore_user: $DEMOQA_USERNAME` with no such variable stays the literal `$DEMOQA_USERNAME`, with a warning in the run result. The model typed it into the Book Store login, and in one run a check then "found" `$DEMOQA_USERNAME` on the page and passed the section: a false pass | A turn that names a placeholder still holding a bare `$NAME`, or types that literal, is refused before anything runs, naming the variable to set |
| 2.41 | No way to clear a field | 44 | The model sent `clear`, which is not an action, and the turn was refused; the retry selected the text and pressed Backspace | `clear`, `clearField`, `clearInput` and `clearText` map to `type` with an empty value |
| 2.42 | §2.34's rewrite broke on an apostrophe | 70 | The glyph-tolerant name for `role=combobox[name="I'm the only traveler"]` put a bare `'` in the regex. It parsed on its own, so the rewrite was kept, but Playwright's `>>` splitter read the `'` as an open string and the click's own `>> visible=true >> nth=0` made the selector unparsable; the retry recovered | Write `'` and `"` in the rewritten pattern as `'` and `"` |
| 2.43 | A required-field asterisk fails a label check | 70 | "Verify a return date field is shown" expected "Return date" and read "Return date *"; the asterisk is the form's required marker. It failed on attempt 1 and §2.25's hint rescued it | A failed DOM check passes when the page's text, with `*`, `:`, bullets and bars stripped from its ends, equals the expected text as written. The page's text must have had such a mark, and a negative check ("is not", "no longer") never passes this way. Nothing inside the text is ignored, so "Not Done" still fails "Done" |
| 2.44 | Prompt examples copied from tested sites | 44, 45, 50, 56, 62, and the fixture app | Ten examples added with these fixes used ids and text from the sites under test (`#open-shadow`/`#fname`, `#copy`, `'Checked'`, "tick two skills", "confirm returned true", Red and Green in `#colors`), and four older ones used the fixture app and a Telerik grid (`demo@securebank.com`, "Transaction Dispute", `#RadGrid1_ctl00__7`). On those pages the model was shown the answer | Every example uses invented names (`#host`/`#field`, `#item`, `#grid_row_7`, "Ada", "Order 12 was placed."). CLAUDE.md now forbids site-specific selectors and text anywhere in the framework |
| 2.45 | A project's context files never reached the model on the server | every survey run | Context was loaded once per session from the server's own `tests.contextDir`, so the survey's `context/public-sites.md` (close ads and overlays) was replaced by the repo's sample API docs | Load context on every batch from the test's project |
| 2.46 | No way for a test to tell the AI what it needs | 40, 44, 59 and any test | Only the project's context files reached the AI, and the description under the title is not sent | A `## Context` section, sent word for word with every step after the project's context; selectors and frame ids welcome |
| 2.47 | Ads hidden by hardcoded Google selectors | 40, 44, 59 | §2.5 and §2.22 recognised and hid ads by a fixed list of Google ad markup and CSS selectors, which breaks the no-site-specific-code rule and missed other ad networks | Removed. Ads are handled by the test's `## Context` or a step; a covered click or drag fails naming what is in the way |
| 2.48 | The AI could not see what a page adds outside `<body>` | 40, 44 | The snapshot walked `document.body` only. Google's full-screen and anchored ads are appended to `<html>` beside `<body>`, so their Close buttons never reached the AI; told by `## Context` to close ads, it waited and stalled | Walk every child of `<html>` but `<head>`, frames included |
| 2.49 | An unusable model reply left no trace | 40 | 'Assertion code response missing code field' failed c40's 'Verify that 3 equals 3' on two of three runs; the replies were counted but not shown, so the cause was a guess | The report shows unused and replaced replies in full; the failure message quotes the start of the last one |
| 2.50 | Notifications recognised by class-name guesses | 62 | §2.33 recorded an element as a notification if its class contained toast, growl, snackbar or notification. Those are library vocabulary, one of them PrimeFaces' own, so the list suited the sites it came from and missed any other name (`flash-message`) | Only WAI-ARIA live regions count: `role` alert, status or log, an `aria-live` other than off, or `<output>`. Leafground's notification is marked that way and is still recorded |
| 2.51 | A built-in list of ad domains | 40, 44, 59 | `browser.blockAds: true` blocked 13 ad-network domains chosen by the framework: a list that is never complete, goes stale, and decides for every project what counts as an ad | `blockAds` is the project's own list of domains (`["doubleclick.net", …]`); the framework has none. `true` and anything that is not a bare host name are refused at load |

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
code runs on the page. (The first build split a frame selector on the letter
"s" instead of on whitespace, a slip a test frame named `#myFrame3` could not
catch, so `#iframeResult` was never found; the test now uses a name with an
"s".) Without `frame`, the code prompt now says frame content
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
the element, newest last. It records any element the page marks as a live region
(§2.50 replaced an earlier class-name list), both when it is added and when
its text changes. The same text
within 3 s is recorded once. `captureDomSnapshot` appends a comment listing
records from the last 60 s whose element is gone, hidden or now says something
else, with their age. A notification still on screen is in the snapshot itself.
The assertion code prompt shows reading `window.__steptixNotices` for a
message that may have closed. Nothing on the page changes.

### 2.34 Role names match what a person sees

The accessible name `name=` matches includes text a person does not see as
text: an icon font's `::before` glyph, an `<img>`'s alt, an SVG's `<title>`.
The model writes the visible text it reads in the snapshot. The first fix
allowed symbols around the name, which covered icon fonts but not image or
SVG icons, whose alt text and titles are words, and it clicked the first of
"✔ Save" and "✖ Save" without saying so. Issue 26 replaced it with this.

**Fix.** Before acting, `executeAction` passes the selector through
`resolveRoleName`. It applies to each `>>` segment of the form
`role=X[name="Y"]` (more attributes may follow; a name with an `i`/`s` flag or
a regex is left alone). For each such segment that matches nothing inside what
came before it:

1. **Exact name.** A selector with a visible match is never touched. An
   exact match nobody can see, such as a zero-size duplicate, does not count
   for a singular action, which only ever acts on a visible one. When nothing
   matches, the name as written gets up to 1 s to appear first. The fallback
   runs before the action's own wait, so without that pause an element still
   rendering would lose to one already on screen that only reads the same: a
   row's "✖ Remove" taking the click meant for the dialog's Remove. Issue 26
   asked for no waiting of its own; this pause is the exception, and it only
   costs time when the exact name misses.
2. **Visible text.** Read the `innerText` of the visible elements of role X
   and compare it with Y, ignoring case and runs of spaces. When none equals
   it, compare again with symbols dropped from both ends of each, for a glyph
   written into the DOM as a character. That second pass needs a letter or
   digit in Y, so "×" never matches "✖". The whole text must match: "Dismiss"
   never reaches "Dismiss all" or "Dismiss 3".
3. **Accessible name.** When no visible text matches, the visible elements of
   role X whose accessible name is Y with case and non-word characters around
   it ignored. A field named by its `<label>` has no text of its own, so this
   is what finds `role=textbox[name="Email"]` for "Email *", and an icon
   button's mis-cased `aria-label`. The rule step 2 replaced did this for every
   element, and dropping it broke both.

   For steps 2 and 3:
   - One match: the segment is replaced by the role narrowed to that
     element's own text, `role=X >> visible=true >> internal:has-text=/^…$/i`,
     kept only when it picks out that element and nothing else. Playwright
     re-resolves a locator on every retry while it waits for the element to
     be actionable, so a position would move to another element when one
     appears before it; the element's own text does not move. Only when the
     filter cannot single it out (its text holds a hidden child that
     `innerText` leaves out) is it pinned by position,
     `role=X >> visible=true >> nth=<i>`. The run log says which element was
     used and its name.
   - Several, for a singular action: the action does not run. It fails with
     `matchCount` set to the number and lists each one's accessible name,
     with the first as an example to retry with
     (`e.g. role=button[name="approve Save"]`). A name the snapshot could not
     read is said to be unreadable, not missing. The example is rebuilt from
     the selector's segments, so a `$` in a page's name stays as it is.
   - Several, for a plural action (`count`, `read` with `multiple`,
     `readTable`): all of them. The selector is the role filtered by the
     text, and is used only when it matches exactly as many elements as step 2
     found. A plural action also keeps any exact match as written, hidden or
     not, since it counts what it matched.
4. **None.** The selector runs as written, so Playwright's wait still covers
   an element that has not appeared yet. If it ends with no match, the error
   starts with the visible elements of role X in that scope (up to 20), each
   with its accessible name and, where different, what it reads. Each
   element's name and text are read together, so a page still re-rendering
   cannot pair one element's name with another's text.

Names come from the element's aria snapshot. It uses the standard role,
`innerText`, the accessible name and the model's name, and nothing about any
site or icon library. A frame-scoped action searches only inside that frame.
Known limit: visually hidden helper text is part of `innerText`, so
`<span class="sr-only">Close menu</span>×` reads "Close menu ×". The snapshot
shows the same, so the model and the fallback agree.

**Compiled steps.** Nothing replays this fallback: a compiled entry calls
Playwright with whatever selector it was written with. So when a compile run
measures an action that fell back, `targeting.roleNameFallback` records the
selector acted on. The code prompt explains it, and `entryFaults` and
`staticEntryComplaint` refuse an entry that uses the selector as written
(check `unmatched-role-name`), pointing it at `resolvedSelector` instead.

### 2.35 Error pages are not where the step was going

**Fix.** `executeNavigate` returns the main document's status from
`page.goto`, and `executeAction` puts it on the result as `httpStatus`. When a
navigate succeeds with a status of 400 or more, and `expectsErrorPage` finds
nothing in the step text (a 4xx/5xx number, "error", "not found",
"forbidden", "unauthorized", "status code", "server error"), the step loop
turns it into a retryable failure: `Navigation answered HTTP 404: <url> is an
error page, not the page the step asked for. Check the URL against the
step`. The retry sees that message and the URL it went to.

### 2.36 Drop on a side of the target

**Fix.** `drag` takes `position`. The parser accepts `position`,
`targetPosition` or `dropPosition`, maps after/bottom to `below` and
before/top to `above`, and keeps only above, below, left or right, and only on
a drag. `executeDrag` lets go at 20% (above/left) or 80% (below/right) of the
target's box on that axis, and at the centre otherwise. Rule 16b tells the model
to use it for reordering.

### 2.37 Say why a navigation got no page

**Fix.** `gotoWithDiagnosis` (src/browser/navigate-diagnosis.ts) wraps
`page.goto` for a navigate action and for the base-URL navigation at launch,
on both the server and the CLI runner. When `goto` throws a timeout for an
http(s) URL, it GETs the URL once from Node with a 10 s ceiling and appends one
sentence to the error:

- the site answered: `The site answers outside the browser (HTTP 200 in 764
  ms) but the browser got no page, so something between the browser and this
  site is stalling rather than the site being down.`;
- it did not: `The site does not answer outside the browser either
  (ECONNREFUSED), so it is down or unreachable from this machine.`

Any other failure, and any non-http URL, is rethrown untouched, and the probe
is not made.

Measured on the-internet.herokuapp.com, 2026-10-08: plain Playwright Chromium
with no Steptix settings timed out at 30 s, and so did Edge and
`--disable-quic`; `--disable-http2` loaded it in 5 s, Firefox in 6 s, and
`curl --http2` in under 1 s. So it is Chromium's HTTP/2 to that host from
this network, not the site and not ad blocking. Why Chromium's HTTP/2 stalls
there is not yet known, and turning HTTP/2 off is a workaround for one site,
not a fix, so the survey does not use it: test 39 is recorded as failing on
this network until the cause is found.

Even over HTTP/1.1, which run D tried before the switch was withdrawn, one
navigation to `/shadowdom` got no page in 30 s; the message said the site
answered outside the browser in 712 ms, and the retry loaded it.

### 2.38 "Says" checks read by containment

**Fix.** The assertion-code prompt gains one requirement: text the page
"says", "shows", "displays" or "contains" passes when the element's text,
whitespace collapsed, contains the expected text, and exact equality is for
conditions that say "equals", "exactly" or "only". The element read must hold
all of the expected text — a value span inside the sentence is too small —
and when none picked does, take the innermost element whose text contains it.
The prompt gives that search as code, and a test runs the example against the
eviltester markup to show it picks the `<p>`, not the `<span>`.

### 2.39 An open choice is not a question

**Fix.** Rule 7 of the system prompt keeps "return a prompt action when you
cannot determine what to do", and adds that a step leaving a choice open
("pick an experience level", "tick two skills", "choose any product") is not
unclear: choose any valid option and name it in `description`. Ask only when
the step names something the page does not have, or contradicts the page.

### 2.40 Refuse a value nobody resolved

**Fix.** `checkTurnReferences` gets the run's parameter values as well as
their names. A `{{name}}` in any field of any action whose value is still a
bare `$NAME` (a leading `$` and an identifier) refuses the turn before any
action runs: `… uses {{bookstore_user}} in "value", which still holds
"$DEMOQA_USERNAME": the environment variable DEMOQA_USERNAME is not set …`.
So does typing that literal into a typed field (`value`, `url`, `key`, a
file path), which is the model copying the value instead of naming the
placeholder. `$5` and other values that are not an identifier pass.

A leading `$` in `## Parameters` or a data row is always read as an
environment variable and left literal only when it is unset, so an author
cannot have meant `$DEMOQA_USERNAME` as text. The check lives in the
server's step loop rather than the client that assembles the run, because the
MCP client can be an older build than the server.

### 2.41 Clearing is typing nothing

**Fix.** `clear`, `clearField`, `clearInput` and `clearText` are aliases
of `type`, and `ALIAS_DEFAULTS` gives them `value: ""`, so the field is
cleared and filled with nothing — what "Clear the text box" asks for.

### 2.42 Quotes in a tolerant role name

**Fix.** `tolerateRoleName` escapes regex specials, turns whitespace into
`s+`, and now writes `'` as `'` and `"` as `"`, which the
regex reads as the same characters. No quote character is left for the
selector splitter to pair, so the selector survives whatever is appended to
it. A test clicks a glyph button named "I'm the only traveler" through
`executeAction` — the path that appends the visibility filter — and fails
without the escape.

Since issue 26, §2.34 still builds regexes — the text filter that pins an
element and the accessible-name pattern — and writes `'`, `"` and `>` in
them as hex escapes for the same reason. The test stays: the click must still
survive the filters it appends.

### 2.43 Label marks are not part of a label

**Fix.** `evaluateAssertion` checks a failed DOM or API result once more
with `sameTextIgnoringMarks(actual, expected)`: collapse whitespace on both,
strip `*`, `:`, `•`, `·` and `|` from both ends of what the page shows, and
compare it for equality with the expected text. A match passes the check,
with a debug line saying so. This is deliberately narrower than containment
(§2.38 asks the model for containment where the step means it): marks inside
the text, extra words and an empty expectation never match.

It overrides the check code's own verdict, so it applies only where a label
mark is the one thing in the way (issue 35):

- **Marks come off the page's text, never the expected text.** A check
  written to see `Email *` is about the asterisk, and still fails on `Email`.
- **The page's text must have a mark to strip.** A check that read exactly
  the expected text and still failed, failed for another reason — a negative
  check, a hidden element — so its failure stands. Whitespace alone is not a
  mark.
- **A negative check keeps its failure.** `isNegativeCheck` reads the
  condition and description, with the expected text taken out, for "not",
  "no", "nothing", "never", "none", "without", "cannot" and any "n't". "Verify
  the status is not Pending" fails on `• Pending` as on `Pending`, while a
  label that reads "Do not disturb" is still checked as a label.

### 2.44 Prompt examples name nothing real

**Fix.** The examples in the action, assertion and recording prompts use
invented names that no tested page uses. The rules around them are unchanged:
each still teaches the same pattern (a shadow root's host and field, a frame's
document, an open choice, containment). Results on 44, 45, 50, 56 and 62 from
runs C and D were measured with the copied examples in place, so they are
reruns' business to confirm.

### 2.45 A project's context files reached no model on the server

**Fix.** The session manager loaded `tests.contextDir` once, when a session
was created, from the SERVER's own config, so every survey run was handed the
repo's sample API docs (`fixtures/context/apis/*.md`) and never the survey's
`context/public-sites.md`, which tells the AI to close ads and overlays. The
context is now loaded on every batch from the test's project bundle:
`tests.contextDir` resolved against the project root, or the server's own when
the test has no project. A session reused for another project's test gets that
project's context, and an edit to a context file is picked up on the next
batch.

### 2.46 A test can tell the AI what it needs to know

**Fix.** A test file may carry a `## Context` section: free text, kept word for
word from the heading to the next `#` or `##` heading (lists, code and `###`
subheadings included), and sent to the AI with every step of the test after the
project's context files, under a heading that says it is the test author's.
It is for whatever the whole test needs: how the app behaves, what may appear
(ads, overlays, toasts), and any selectors or frame ids the author wants used.
That last point is what keeps site knowledge out of the framework: it belongs
in the test, and this is the place for it.

- `src/parser/markdown.ts` keeps the section as `ParsedTest.context`; the CLI
  runner and the Electron runner add it with `withTestContext`
  (`src/context/test-context.ts`).
- On the server path the client sends it as `testContext` on the step request,
  because the server cannot read a buffer the editor has not saved: the MCP
  client from the full parser, the VS Code extension from runner-core's
  `parseContext`, which `tests/test-context.test.ts` holds to the same answer
  as the full parser. The route copies the field explicitly and refuses one
  that is not a string.
- `{{placeholders}}` in the section are not substituted.
- Documented in `docs/test-writing-handbook.md` and
  `docs/ai-test-authoring-guide.md`.

### 2.47 The framework no longer hides ads

**Fix.** §2.5's retry on an ad-covered click and §2.22's ad hiding before a
drag are removed. Both recognised an ad by Google's markup (`adsbygoogle`,
`aswift_`, `google_ads_iframe`, `doubleclick`, `googlesyndication`) and hid it
with a fixed list of CSS selectors: a third party's selectors hardcoded in the
framework, which missed every other ad network. An ad is now the test's to
handle, the way a user would, through `## Context` (§2.46) or a step. What the
framework keeps is generic: a click or drag that something covers fails, and
Playwright's message names the element in the way; a drag still checks that the
pointer reaches its source before pressing. `browser.blockAds`, which stops
requests to a list of ad-network domains when a project turns it on, is
unchanged.

### 2.48 The snapshot reads everything the page shows, not only `<body>`

**Fix.** `capture-dom.js` walked `document.body` and nothing else. Scripts can
add elements as children of `<html>` beside `<body>`, and the browser shows
them like any other: on LetCode and Expand Testing, Google's full-screen and
anchored ads are `<ins>` elements appended to `<html>`, each holding the ad
frame with its Close button. The AI never saw them. With the test's
`## Context` telling it to close ads it recognised the ad from the
`#google_vignette` address, waited, and stalled, because there was nothing in
its snapshot to click. Frames from other domains were never the issue:
`injectFrameContent` reads every frame through Playwright, whatever its
origin.

The snapshot now walks every child of `<html>` except `<head>`, in document
order, so what sits beside `<body>` is captured with its frames, and the
`[iframe:N]` numbering still follows Playwright's `locator('iframe')` order. A
test builds that layout — an overlay appended to `<html>` holding a frame with
a Close button, beside a frame inside `<body>` — and checks both frames land
under their own `<iframe>` and that the Close button can be clicked through its
frame path; it fails with the body-only walk.

### 2.49 Replies Steptix could not use are shown

**Fix.** A check whose code the model never delivered in a readable form failed
with "Assertion code response missing code field", and nothing showed what the
model had said: the calls were kept on the step (`discardedAiInteractions`) and
on the check (`supersededAiInteractions`) for counting, but deliberately not
rendered. c40's "Verify that 3 equals 3" failed this way on two of three runs,
and the cause could only be guessed.

- The report shows, under the step, "Model replies this step did not use (N)"
  with each call's request and reply, and under a check that recovered,
  "Earlier code replies, replaced (N)".
- The failure message quotes the start of the last unusable reply (300
  characters, on one line, with its full length), so the run log, the CLI and
  the MCP result carry it too: `… The model replied: "Yes, 3 equals 3."`.

### 2.50 Notifications are what the page marks as live regions

**Problem.** §2.33 decided what counts as a notification partly by class
name: anything whose class contained toast, growl, snackbar or notification.
Those words are libraries' own vocabulary. "growl" is PrimeFaces' name, taken
from the one site where the problem showed up, which is exactly the
site-shaped guess the framework must not make. The list also missed any
library that picked another word (`flash-message`, `alert-bubble`), and
could catch elements that only share the word (a "notification settings"
panel).

**Fix.** The recorder reads only what the page itself declares in WAI-ARIA,
the web standard every page uses to say "announce this to the user": a live
region. An element counts if it has `role` alert, status or log (roles that
are live by definition), an `aria-live` other than `off`, or is an
`<output>` element (implicit role status). A message added inside an element
that is already a live region counts too, because the recorder looks up from
whatever changed to the live region around it. No class name is read.

Leafground was checked live: its notification container carries
`aria-live="polite"` and each message `role="alert"`, so "Checked" is
still recorded and listed once it has closed. A page that shows a message
without marking it is not announcing it to screen readers either. Steptix does
not guess at those: a test can still check the message while it is on screen,
and steptix/steptix#24 collects ways for a test author to handle such pages.

Tests: a message appended to an existing `aria-live` container is recorded;
`role="status"`, `role="log"` and `<output>` are recorded and
`aria-live="off"` is not; elements classed toast, snackbar, notification and
flash-message with no live-region marking are not recorded.

### 2.51 The project lists the domains to block

**Problem.** `browser.blockAds: true` (§2.5, §2.23, §2.30) stopped the
browser reaching 13 ad-network domains chosen by the framework. That is a list
built from the sites the survey met: it is never complete, it goes stale as ad
networks change domains, and a project could neither add a domain nor drop one
it depends on.

**Fix.** `blockAds` is now the project's own list of domains:
`"blockAds": ["doubleclick.net", "googlesyndication.com"]`. Each entry
blocks that host and every subdomain of it, in the same two ways as before:
Chromium's `--host-resolver-rules` (`MAP <host> ~NOTFOUND`), and a route
that aborts matching requests on Firefox and WebKit. The framework holds no
list and blocks nothing unless a project names domains
(`src/config/block-hosts.ts`).

The loader refuses `true`, which would otherwise read as "on" and block
nothing, with the form to write instead. It also refuses any entry that is not
a bare host name, naming each. That matters beyond tidiness: the names go into
a Chromium switch, where a comma or a space would start a rule of the
author's own making (`MAP * 127.0.0.1` sends every request elsewhere).
`hostResolverRule` leaves out anything that is not a host name as well, for a
config that reaches the launcher by another path.

The survey's own `steptix.config.json` now lists the 13 domains it used. The
handbook's "Ads and other third-party content" section shows both ways to deal
with ads: `## Context` to handle them, `blockAds` to stop them loading.

Tests: a list loads as written; no key blocks nothing; `true`, URLs, wildcards,
a rule-injecting entry and a number are refused with each named; the schema
takes a list of strings; host matching covers subdomains, case, look-alikes and
query strings; the resolver rule holds only the listed hosts.

## 3. Failures caused by the test files or the sites

These are fixed in the test files.

| # | What was wrong | Fix in the test file |
|---|----------------|----------------------|
| 39 | Chromium's HTTP/2 connection to the site stalls from this network; curl and Firefox get the page (§2.37) | Left failing. Turning HTTP/2 off made it pass in run D, but that routes around one site rather than fixing anything, so the switch was withdrawn; the cause is open. A documented per-test and per-project HTTP/2 setting is steptix/steptix#20 |
| 40 | The table offers 3, 5, 10 and All per page, not 25 | Show All entries |
| 41 | DemoQA's checkbox tree has no "expand all" button any more | Expand Home, then the folders, with the toggle next to each name |
| 47 | Formy's Places autocomplete fills only the address field | Verify the address field instead of the city |
| 55 | The web table's Add form posts to `#` and reloads, so no record is ever added. Its "Type to Search" box filters nothing either: typing changes no rows, and Enter submits the form to `?` | Read a cell and count the rows instead |
| 44 | LetCode's Button page no longer has a double-click button, and its "new tab" button opens the workspace URL itself | Drop the double-click (covered by 41, 43, 49, 50), and check the new tab's address starts with the site |
| 57 | `/sliders/` is now a 404; the page moved to `/slider/` | Navigate to `/slider/` |
| 63 | "Drag the logo into the drop box": the logo already sits in one drop box (A), so "the drop box" named neither | Name the boxes as the page labels them, A and B |
| 63 | The drag-and-drop row is `display: none` until the FIRST checkbox is ticked, and the test ticks 2 and 4 | Tick checkbox 1 first |
| 59 | The first frame's dropdowns are now a course list (Java, Dot Net, Python, Javascript) and an IDE list; "Baby Cat" is gone | Select Python |
| 60 | The sample table lists Friends characters now; there is no Clark | Read Joey's occupation |
| 48 | "Open Tab" opens qaclickacademy.com, which answers with a Cloudflare 526 (invalid SSL certificate) page | Check the new tab's address rather than its content |
| 58 | No task in the table mentions jQuery | Search for "Testing" and expect one row |
| 63 | The dropdown drives the meter and the slider drives the progress bar, not the other way round | Swap the two checks |
| 64 | "Navigate to signup" clicked a link that opened a new tab, so "the main tab" was a different tab | Stay in one tab: go to the URLs directly, and close the signup tab rather than switching back |
| 66 | The test had no way to say that a buggy build is meant to fail | Give each row its expected answer, so build 2's wrong answer (23) is the pass condition |
| 70 | "Choose to add 1 more passenger" was ambiguous: the page has a checkbox and a count | Name both controls |
| 56 | The sign-up form shows no confirmation: it reloads with the values in the address. "Verify the page confirms the submission" named something the page does not have, and earlier runs passed it only by accepting the address as evidence | Verify the address carries the submitted name |
| 52 | "Drag the Shopping portlet to the top of its column": Shopping is the only portlet in the middle column, so the step and its check were true before anything moved, and passed twice while the drag only selected text | Drag Shopping by its title bar above Feeds, and check the first column lists Shopping above Feeds and the middle column no longer holds it |
| 41 | The Book Store section signs in with `DEMOQA_USERNAME` and `DEMOQA_PASSWORD`, an account only a person can register (reCAPTCHA) | Left as is: set both in `survey/web/.env`. Until then §2.40 fails the section by name |

## 4. Out of scope

- **Test 42, "click Stop as soon as the bar reaches 75%".** A model turn takes
  seconds. §2.13 makes a `wait` then `click` sequence in one turn possible,
  and that is the fix within reach. Acting faster than one turn is not.
- **Test 45's wrong-element checks** are no longer out of scope: §2.25 tells
  the retry where the expected text is, and §2.38 tells the first attempt to
  read an element that holds all of it.
