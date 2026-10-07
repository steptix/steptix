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
   a site under test could depend on one of them.

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

## 3. Failures caused by the test files or the sites

These are fixed in the test files.

| # | What was wrong | Fix in the test file |
|---|----------------|----------------------|
| 39 | The site never finishes loading in any browser | Left as is. It is recorded as blocked by the site |
| 40 | The table offers 3, 5, 10 and All per page, not 25 | Show All entries |
| 41 | DemoQA's checkbox tree has no "expand all" button any more | Expand Home, then the folders, with the toggle next to each name |
| 47 | Formy's Places autocomplete fills only the address field | Verify the address field instead of the city |
| 55 | The web table's Add form posts to `#` and reloads, so no record is ever added | Search for and delete an existing record instead |
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
- **Assertion responses "missing code field".** They recovered on retry in
  every run, at the cost of an extra model call. Left for a separate change.
