# Browser history: `back` and `forward`

**Status:** spec, for build. Small.
**Opened:** 2026-09-21

## 1. What this is

Two actions, `back` and `forward`, that move the active tab through its own
session history — what a person does with the browser's back button, not a
link the page happens to offer.

## 2. Why

There is no way to do it today, and the failure is silent. Measured on
2026-09-21 against `fixtures/test-app`, on a step reading
`Go back to the previous page using the browser's back button`:

```
Step 3/4: Go back to the previous page using the browser's back button
[DEBUG] AI reasoning (turn 1): Use the browser back keyboard shortcut to return from the dashboard to the previous tables page.
[DEBUG] ▶ BEGIN: action.keypress: Go back to the previous page using the browser back command
[DEBUG] ✔ END: action.keypress: Go back to the previous page using the browser back command (3ms)
[DEBUG] AI reasoning (turn 2): No further action is needed because the original instruction is satisfied.
Step 4/4: Verify the Tables index page is shown
  ✗ Assertion [FAIL]  Expected: Tables index page is shown   Actual: Dashboard
```

The model reached for the only thing in the vocabulary that could mean
"back" — a keypress — and `page.keyboard.press` delivers to the focused
element in the page, not to the browser frame. The press succeeded, the step
passed, the page never moved. Only the `Verify` on the next line caught it,
and a test whose next step tolerated either page would have passed while
testing nothing.

So the cost of the gap is not "you cannot go back". It is a step that
reports success for work it did not do. That is the defect this closes, and
it is why §4.3 fails loudly rather than treating a no-op as success.

Today's workarounds stay valid and are usually better: navigate to the URL,
or click the application's own back control (`Click Back to scheduled
payments`), which is a real user path and worth testing on its own. This is
for the case where the browser's own history is the thing under test — a
back button that must restore a filtered list, a form that must not
re-submit on back, a single-page app that pushes history entries.

## 3. Non-goals

- No history beyond one entry per action. "Go back twice" is two steps, or
  two turns of one step; there is no `times` field in v1 (§9).
- No `reload`. It is a real gap too, and a separate one: `navigate` to the
  same URL is not a reload, and nothing else offers it. Out of scope here so
  this stays small; §9 records it.
- No history manipulation (`pushState`, entry inspection). A test that needs
  that has a tool.
- Not a way to undo a step. Going back after a POST re-presents whatever the
  browser has; that is the application's behaviour, and testing it is the
  point rather than something to smooth over.

## 4. The actions

### 4.1 Shape

```json
{ "action": "back", "description": "Go back to the payments list" }
{ "action": "forward", "description": "Return to the payment details" }
```

No other fields. Both are page-level, like `navigate` (§4.2).

**The near-miss spellings are aliased**, as every other multi-word action's
are: `goBack`, `go_back`, `browserBack`, `navigateBack`, `historyBack` and
the `forward` equivalents all normalise to the canonical name. This is not
tidiness. The parser KEEPS an unrecognised action type, warns, and the
executor then runs it as a no-op that REPORTS SUCCESS — so a model answering
`goBack` would reproduce §2's defect exactly, and `goBack` is the likeliest
miss of all, being the Playwright call the code-generation prompt teaches.

> **Update (2026-09-29):** an unknown action type now fails the step instead of passing it, so a missed alias costs a retry; see CHANGELOG.

`description` is required as it is for every action, and is what the report
row and the log line show.

### 4.2 Which page

The active tab, resolved exactly as `navigate` resolves it: history belongs
to a tab, and a frame does not navigate independently. Inside a
`switchFrame` context the action still applies to the page, and the frame
context does not survive the move — the document the frame lived in is
gone. A step that goes back and then wants a frame switches to it again,
which is what it must already do after a `navigate`.

With several tabs open, `back` acts on the one the run is currently on.
`switchPage` first to act on another.

### 4.3 A move that did not happen

**The step fails.** The whole reason this spec exists is a no-op that reported
success, so a `back` that did not move the tab must say so:

```
back: the browser has no previous page in this tab's history
forward: the browser has no page ahead in this tab's history
```

**Deciding whether it moved is the subtle part, and the obvious reading is
wrong.** The first cut of this section said "`page.goBack()` resolves `null`
when there is no entry to go to", and built the failure on that. Review
measured it: `goBack` resolves `null` whenever the move produced no HTTP
**Response**, which is every SAME-DOCUMENT move — a `#hash` entry, a
`history.pushState` entry — and not only an empty history. So the first cut
failed a `pushState` back that HAD moved the tab, with a message saying there
was no previous page. That is the single-page-app case §2 names as a reason to
build this at all, and the measurement is in §12.

The rule is therefore about POSITION, not about the response: record where the
tab stands before the call, and fail only when it stands in the same place
after. The position is the url **and** the history state beside it, because an
app can push two entries at the same url differing only in what it stored — a
filter that pushes `{view:'paid'}` over `{view:'all'}` on `/payments`. An
unreadable state (a document the test cannot script) simply drops out of the
comparison and leaves the url doing the work.

Both failures are **not retryable**. Re-planning cannot conjure a history
entry, so a retry only burns an AI turn — and worse, the re-ask hands the model
a failure it can satisfy with a `navigate` or a `noop`, which would turn this
loud failure back into the quiet pass §2 is about. The upload path already
takes the same flag for the same reason. `otherwise continue` remains the way
to write the tolerant reading, and the ordinary `otherwise`-tail handling
applies (stories/step-failure-outcomes.md).

This is the one decision in this spec worth arguing about, so: the
alternative is a no-op that passes, on the theory that "make sure we are
back at the list" is satisfied if you were already there. Rejected. The
author wrote a step that moves the browser; a step that cannot do what it
says must say so. "Make sure we are at the list" is a `navigate`, and it is
already available.

### 4.4 What counts as arrival

The action waits for `domcontentloaded` with a 30-second budget — the same
wait `executeNavigate` uses, deliberately, so one page is not quick to reach
by URL and slow to reach by history for a reason no author could see
(Playwright's own default is `load`, which a slow image or a third-party
script can hold). Then the framework's ordinary post-action settle runs, as
it does for `navigate`: `back` and `forward` join `MUTATING_ACTIONS`
(src/runner/step-executor.ts). A back that restores a page from the
back/forward cache fires no load event and settles on Playwright's own
resolution; the subsequent snapshot is what the next turn reasons about, so
an SPA that repaints asynchronously is handled by the same settle every
other action relies on, not by anything special here.

## 5. Authoring

The model emits these; the author writes English. The prompt rule (§6) must
cover the spellings an author actually uses:

```markdown
1. Go back
2. Go back to the previous page
3. Click the browser's back button
4. Press browser back
5. Navigate back in the browser history
6. Go forward again
```

All of them are `back`/`forward`. In particular **"click the browser's back
button" is this action, not a `click`** — there is no such element in the
page, and a `click` would go looking for one. And a keypress must not be
reached for: §6 says so in the negative, because the measured failure in §2
is exactly the model choosing a keypress when nothing else fitted.

What is NOT this action: `Click Back to scheduled payments`, `Click the Back
link`, `Click Return to list` — those name something on the page, and the
page is where they should be looked for. The rule in §6 turns on whether the
step names a page element.

## 6. Prompt

One rule, in the numbered list in `src/ai/prompts.ts`:

> **Browser history.** To move the active tab through its own history, use
> `{ "action": "back" }` or `{ "action": "forward" }` — the browser's back
> and forward buttons. A step that says "go back", "browser back", "click
> the browser's back button" or "navigate back" means this. A keyboard
> shortcut does NOT work: a keypress is delivered to the focused element in
> the page, not to the browser, so it silently does nothing. A step that
> names something in the page instead ("Click Back to payments", "Click the
> Return link") is an ordinary `click` on that element, not this action.

## 7. Code-behind

`back` and `forward` compile. They are not `FRAMEWORK_ACTIONS`
(src/codebehind/generate.ts) — those are actions that cannot become code.
The generated entry is:

```ts
await page.goBack();
await page.goForward();
```

The generation prompt lists them alongside the other recorded actions; the
model writes the call from the recorded action as it does for `navigate`.
A generated entry is not required to reproduce §4.3's message — §11.7 pins
only that the entry navigates.

## 8. Report and log

- **Log line:** the ordinary `action.back` / `action.forward` trace line
  carrying the description, and nothing else. A first cut added a second,
  description-less `→ back` line beside it; review found it carried no
  information the two existing lines did not, and it is gone. The URL moved to
  is visible in the next step's context as it is after any navigation.
- **Report:** an ordinary action row. No new field.
- **Step cache:** none. `back`/`forward` were cacheable like `navigate`
  while the step cache existed; it has since been removed, and code-behind
  (§7) is the only replay.
- **Secrets:** nothing to mask. The actions carry no value; the
  `description` is the model's own sentence and goes through the same
  redaction as every other description.

## 9. Deferred

- ~~`reload` (§3). Same shape, same seams, its own decision about what a
  reload means for a form post.~~ **Built** (2026-09-26), because Record Steps
  records a Refresh and a recorded step has to run
  (docs/specs/SPEC-record-steps.md §4). `{ "action": "reload" }`, no other
  fields; `page.reload()` with this spec's arrival rule (`domcontentloaded`,
  30 s, then the ordinary settle — it is in `MUTATING_ACTIONS`); prompt rule
  16b beside 16a; `page.reload()` in code-behind via the same conditional
  rule 7b; `refresh` and the other near-miss spellings aliased. The form-post
  decision is the browser's: a reload after a POST re-sends or not as the
  browser does, which is the application's behaviour under test. There is no
  "did it move?" failure — a current page can always be reloaded; one that
  fails anyway (the server gone, a timeout) is not retryable, as §4.3's are. Pinned by
  `tests/drag-reload-actions.test.ts`, where the three checks §12 found
  toothless here are mutation-checked for `reload` and `drag` too.
- A `times` field, or "go back to the start of the history". Two steps do
  it; a field is cheaper to add once someone wants it than to design now.
- Asserting on history depth, or on whether back is available. A test that
  needs "the back button is disabled here" is asking about an element in the
  page, which is an ordinary verify.

## 10. Acceptance

`fixtures/test-app/` has no page whose back behaviour is worth asserting on
beyond "the previous page is shown", and v1 does not add one: the sidebar
nav on `tables.html` links to real pages, so click a link, go back, and the
index is shown again; go forward, and the linked page is shown again.

`templates/init/tests/browser-history.md`, tagged `browser-history`:

```markdown
## Steps
1. Navigate to tables.html
2. Click the "Dashboard" link in the left sidebar
3. Verify the Dashboard page is shown
4. Go back
5. Verify the Tables index page is shown
6. Go forward
7. Verify the Dashboard page is shown
```

Run by `steptix run -t browser-history` from `templates/init`, with the env
passthrough the other template tests need.

## 11. Tests

1. Parser accepts `{ "action": "back" }` and `{ "action": "forward" }` with
   no other fields, and they survive a round trip unchanged. Pinned by the
   ABSENCE of the "Unknown action type" warning, with a genuinely unknown type
   as the control — an unknown type is kept verbatim, so nothing else would
   notice the list losing an entry. Every alias of §4.1 normalises.

   > **Update (2026-09-29):** an unknown action type now fails the step, so a lost entry would also surface as a refusal; see CHANGELOG.
2. Executor calls `page.goBack()` / `page.goForward()` on the active page,
   not on a frame locator.
3. §4.3, against a REAL browser rather than a mock, because the defect was a
   wrong model of what Playwright returns and a mock that answers `null`
   cannot tell the two cases apart: a `pushState` back, a `#hash` back and a
   back between two entries at one url with different state all SUCCEED; a tab
   with nothing behind it fails with §4.3's message and `retryable: false`.
   The page must sit on a real origin (request interception, not
   `setContent`, which leaves it on `about:blank` where `pushState` throws
   and no history entry is created).
4. A frame context does not survive: the executor passed the page, not the
   frame locator (which is 2 measured on a frame-switched run).
5. `back` and `forward` are in `MUTATING_ACTIONS`, so a post-action settle
   runs (§4.4).
6. The prompt carries the rule, including the negative about keypress.
7. The code-generation prompt names `page.goBack()` for a transcript that
   moved through the history and NOT for one that did not (the rule is
   conditional, like the tab rule beside it), and the action is absent from
   the refusal list so the compile is not declined.
8. (Removed with the step cache.)
9. End to end through the api-server entry: a step whose recorded action is
   `back` runs and emits the ordinary step events.
10. Acceptance: §10's file passes against the fixture app.

## 12. What review found

One round, after the feature was built and its acceptance test passed.

- **BLOCKER.** §4.3 was built on "`null` means no history", which is false:
  `null` means no Response, so every same-document move returned it. Measured
  against the live fixture app — a `pushState` back moved the tab from
  `?view=2` to the bare path and the step failed saying there was no previous
  page. The acceptance test of §10 did not catch it, because the path it
  exercises is cross-document; §11.3 now covers the same-document cases
  against a real browser.
- **The aliases were missing** (§4.1), which is the same silent-no-op defect
  through a different door: an unknown action type reports success.
- **Three tests did not bite.** The `VALID_ACTION_TYPES` entry, the
  code-generation rule (emitted unconditionally, so the assertion held on a
  constant) and the refusal-list claim were all unpinned. Each now has a
  mutation behind it.
- **Smaller:** the wait was Playwright's `load` where `navigate` uses
  `domcontentloaded` (§4.4); a second, description-less log line (§8); the
  failure was retryable, which lets a re-ask turn it back into a pass (§4.3);
  and the authoring guide and README vocabulary tables had not been updated.
