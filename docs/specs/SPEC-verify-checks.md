# Verify checks: what a check reads, and what its retry may change

**Status:** describes branch `fix/97-read-only-check-retry`
(steptix/steptix#97, with #66, #68 and #70).
**Opened:** 2026-10-16

## 1. What this is about

A test step that starts with `Verify` asks Steptix to look at the page and say
whether something is true:

```markdown
5. Verify the order status says "Payment received"
```

If it is true, the step passes (green). If not, it fails (red). That is the
whole value of a test: a green step must mean the page really shows what the
step says, and a red step must mean it does not.

This spec sets out how Steptix keeps checks honest:

- what a check reads, and what it must never read (sections 3 and 7);
- what happens when a check fails and Steptix tries the step again
  (sections 5 and 6);
- how letter case is compared (section 8);
- how a test author writes a check that cannot be read two ways
  (section 10).

It grew out of real failures, listed with their evidence in section 11: a
retry that changed the page until its check passed, a retry that swapped a
hard question for an easy one, a first check that passed by finding the
expected words in the page's own script code, and retries that passed by
reading a dropdown option nobody had chosen.

## 2. How a check works

Two separate requests to the AI make one check.

1. **Planning the step.** The AI reads the step and the page and decides what
   to check: the question, in words, and the text it expects. For
   `Verify the order status says "Payment received"`: the question "the order
   status", the expected text "Payment received".
2. **Writing the check's code.** A second request writes a short piece of
   JavaScript that runs in the page, reads the part the question names, and
   returns two things: whether it holds the expected text, and what it read.

For example (invented names):

```js
(() => {
  const el = document.querySelector('#order-total');
  if (!el) return { pass: false, actual: 'element not found: #order-total' };
  const shown = el.innerText.replace(/\s+/g, ' ').trim();
  return { pass: shown.includes('$42.00'), actual: shown };
})()
```

Steptix runs the code and turns its answer into the step's result. What the
code read goes into the report, so a person can see what was compared.

The two requests matter for everything below: the first decides **what** is
checked, the second decides **how** the page is read. Both are the AI's work.
Steptix tells the AI what a check must not count (section 7), but has no code
of its own that decides what a person sees on a page (section 12).

## 3. The rules

Sections 5 to 9 say how Steptix follows each rule.

### Rule 1. A check reports what the page shows; it never makes the page show it

A check only reads. It never clicks, types, scrolls, focuses or changes the
page. A check that changes the page until its text appears tests nothing: it
would pass whatever the application did. The AI is told this for every
check's code; new code for a retry is also scanned before it runs
(section 5).

> **Real case (section 11, A).** A test types "dent" into a payee filter that
> reacts only to key presses, so the list stays unfiltered and
> `Verify the payee list shows Northside Dental and no other payee` must
> fail. On a retry, the AI typed the filter text again, one key at a time,
> until the list filtered — and the step passed.

### Rule 2. A step says where to look, and the check reads there

The step names the part of the page: a cell, a field, a heading, a message, a
section, or the whole page. The check reads that part and nothing else. It
does not hunt through the rest of the page for the expected text.

- **Clear:** `Verify the page heading contains "Sign in"` — one element.
- **Unclear:** `Verify the page title contains "Sign in"` — the heading on the
  sign-in page says "Sign in", but the browser tab's title says
  "SecureBank — Sign In". The two differ in letter case, so the result
  depends on which one the AI picks.
- **Too loose:** `The total is $42.00` — no "Verify", and no total named.

A check that hunts for the expected text can find it where the step did not
mean: another row, a help text, the page's own script code. Then it passes
for the wrong reason.

### Rule 3. A check reads only what a person would see

Text inside script code, text that is hidden (a closed menu, an element
styled `display: none` or `visibility: hidden`), and the options of a closed
dropdown other than the chosen one are not on the page as far as a person is
concerned. A check must not count them. The AI is told so, and works out
for each page how to leave them out (section 7).

> **Real case (section 11, D).** `Verify the page says the button was clicked`
> passed on its first try. Its code read the page's JavaScript source, which
> contains the words "Event Triggered" whether or not anybody clicked the
> button.

### Rule 4. A retry asks the same question, the same way

When a check fails, Steptix tries the step again. The retry keeps the
question, the expected text and the check's code exactly as they were, and
runs them on the page as it is now. New code is written only when the old
code found nothing (a wrong selector), breaks, was written for a value read
again since, or would change the page (section 5). The retry cannot swap the
question for an easier one, change the text it looks for, or read the page
another way until the check passes.

> **Real case (section 11, B).** `Verify the payee list shows Northside Dental
> and no other payee`. The first check read all five payees and failed,
> correctly. The retry wrote a new check — "the text of the Northside Dental
> option" — read that one label, and passed. "And no other payee" had been
> dropped.

> **Real case (section 11, T).** `Verify the page says "Collect in branch"`,
> where "Collect in branch" is an option of a dropdown with another option
> chosen. The first check failed, correctly, every time. The retry, asked for
> new code, wrote code that read the whole page's text with `innerText`,
> which in Chrome holds every option of a dropdown, and passed in 3 of 9
> runs.

### Rule 5. Letter case counts, unless the step says otherwise

`Verify the status says "Payment received"` passes on "Payment received" and
fails on "Payment Received". To accept any case, the step says so:
`…, ignoring letter case`. Section 8 has the details.

### Rule 6. A wrong fail is better than a wrong pass

When a choice trades one for the other, choose the wrong fail. A wrong fail
shows up in the report, and the author fixes it in minutes by rewording the
step. A wrong pass is silent: the bug ships, and every green result is worth
less.

### Rule 7. Steptix checks only what the step asks

`Click Save` clicks Save and nothing more. The AI is told to add a check only
when the step asks for one ("Only include an "assert" action when the step
instruction's intent is verification", rule 5 of the step prompt). Nothing in
Steptix's code enforces this, because real runs show the AI follows it
(section 11, F).

### Rule 8. What we say about the AI comes from real runs

A unit test can hand Steptix any reply it likes. That shows how Steptix reacts
to the reply, not that an AI would ever send it. A claim about what the AI
does — in a spec, an issue, a commit or a review — cites a real run, or is
written as an example. CLAUDE.md has the full rule, under "Claims about what
a model does need a real run".

## 4. Words used in this spec

- **Step:** one numbered line of a test file.
- **Check:** what a `Verify` (or `Assert that`) step runs: a question, an
  expected text, and the code that reads the page (section 2).
- **Attempt:** one try at a step. By default a failed step gets a second
  attempt (`execution.retries: 1`).
- **Retry:** the second attempt, and any after it.
- **Re-check:** how the next attempt starts after a check ran and came back
  false: the same check runs again, with the same question, expected text
  and code (section 5). A first check whose code never gave an answer is not
  re-checked: its step is planned again, as is an `If …, then …` line
  (section 5).
- **Text box:** a box on the page that a person types into (an `<input>` or a
  `<textarea>`).
- **Markup:** the page's HTML as written, before CSS changes how it looks.
  Text written "Express courier" in the markup can be shown as
  "EXPRESS COURIER" by CSS.

## 5. When a check fails: the retry

**Example** (invented): `Verify the order total is $42.00`. The page shows
$40.00.

| Attempt | What happens |
|---|---|
| 1 | The planning AI plans the check: question "the order total", expected "$42.00". Its code reads the total: "$40.00". The check fails. |
| 2 (the retry) | No AI is asked anything. The same question, expected text and code run again, on the page as it is now. The code reads the total again: "$40.00". The check fails, and so does the step. |

Had the total still been loading at the first check, and shown $42.00 by the
retry, the same code would read "$42.00" and the step would pass.

**When the retry writes new code.** Only in these cases is the AI that
writes check code asked for new code, told how the check failed (section 6):

- **The old code found nothing.** It said "element not found", as the code
  prompt asks when a selector matches nothing: a wrong selector, for new code
  to fix.
- **The old code breaks when it runs again.** It throws an error, or returns
  something other than a result. The new request also quotes that code and
  the first line of its error.
- **A value the check compares with was read again as something else.**
  Values the step stored since the page last changed are read again before
  the re-check (below). The old code holds the old value written into it, so
  when the check's question or expected text comes out different, new code
  is written for the new one.
- **The old code would change the page.** Only a re-check's code is scanned
  for that ("What the retry may not do", below), so a first check could have
  clicked or typed. That code is not run again; new code is written, told why.

**What else the retry does**

- **Reads stored values again:** values the step stored since the page last
  changed (a click, typing, a wait) are read again before the check, so a
  value read before the page finished updating is not checked stale.

**What the retry may not do**

- **Change the question or the expected text.**
- **Read the page another way.** Code that read the page and gave an answer
  runs again as it is. Asked for new code instead, the AI has written code
  that read the page differently and passed a check that must fail (Rule 4,
  section 11, T).
- **Change the page.** New code may only read. Steptix scans it before
  running it; code that would click, type, focus, scroll or change the page
  is not run, and the AI that writes check code is asked again, told why. The
  scan catches the usual ways of writing those calls, not every possible one.
- **Look elsewhere for the text.** New code is not told where else on the
  page the expected text appears (section 9), and it is told to read the part
  the question names.

**What it costs.** A first check whose code read the right part but compared
it wrongly gets no second chance: the same code fails again. Take
`Verify the payee list shows Northside Dental and no other payee` in
`securebank-schedule-transfer.md`, which must pass. Its first check failed in
2 of the 16 runs of it on this branch's builds up to `7678018b`, and both
times the retry's new code passed it (section 11, N to S). In one of them the
first code had compared " Northside Dental", with a space in front, to
"Northside Dental" exactly; the other run's report is gone, so its cause is
not known. Now those retries fail too, so `typing.test.cjs`, which runs that
step, can be expected to go red about one run in eight. That is a wrong fail,
which Rule 6 prefers to the wrong passes of T, and its report shows the code
and what it read.

Steptix does not answer such a failure with a rule of its own about how text
is compared — that spacing never counts, say, or that an icon beside a name
is not part of it. People write checks for every kind of page, and for some a
space, a line break or an icon is the point. The step's words decide, as the
AI reads them: a step that needs spacing ignored, or kept, says so (section
12).

**After the retry**

- **The check passes:** the step carries on with anything else it asks for
  (`Verify the total, then click Pay`), told what the failed attempt already
  did, so nothing is done twice.
- **The check fails:** the step fails with that result. With
  `execution.retries` above 1, each further attempt asks the same question
  again, the same way.

**Check code that does not run.** Separately from retries: when a check's
code throws an error, or returns something other than a result, Steptix asks
for the code again within the same attempt — two tries in all — quoting the
code and the first line of its error. Before, it asked the same thing again
with no word of why, and often got the same broken code back. On a re-check,
the old code run again is the first try. New code for a re-check that
Steptix will not run because it would change the page (above) uses up a try
the same way. When neither try gives an answer, the attempt fails, saying the
code failed, or that it was refused when the last try was code Steptix would
not run. After a first check, the next attempt then plans the step again;
after a re-check, it asks the same question again, and runs the code of the
check that came back false once more first, since what ended the attempt may
not have been that code.

**`If …, then return / stop / fail` lines are retried as before.** In
`If the cookie banner shows, then stop`, the check may be the condition
itself, or something the line verifies after acting; only the planning AI can
tell which. So these lines are planned again on a retry, told how the earlier
attempt failed.

## 6. What new code for a retry is told

When a re-check writes new code (section 5), a check that reads the page
adds this note to the request (the failure line, the read and the code are
filled in):

```text
An earlier attempt at this check failed:
- Assertion failed: Order total is $42.00 — expected "$42.00", got "element not found: #total"
  Its code read: "element not found: #total"
  Its code: (() => { … })()
Write the code for this check again, for the condition and the expected value
given above. Check everything the condition says, and drop no part of it — not
"only", "no other", "all", "exactly", a count, a "not", or whether letter case
counts.
Read the part of the page the condition names, not wherever the expected text
appears. If that code read another part, or found nothing, read the part the
condition names: use a different selector, or JavaScript that works. If it
read that part, read it again and compare it as the requirements above say,
searching nowhere else on the page for the text. What that part holds decides
the check. (Reading `window.__steptixNotices` for a notification that closes
by itself, as the requirements say, is not such a search.)
```

"The requirements above" are the ones every check's code is given, section 7's
among them. The last sentence lets a check find a pop-up message that has
already closed, in the log Steptix keeps of such messages. A check that
compares stored values without reading the page, a check of an API response,
and a check that may read either the page or an API response each get the
note worded for what they read.

When the old code broke on running again, the request goes on with that code,
as if the AI had just sent it, and this:

```text
That code failed: Error: page.evaluate: ReferenceError: total is not defined.
Write it again for the same check, fixing whatever in the code made it fail,
and return { pass, actual }.
```

## 7. Reading only where the step says, and only what is shown

Rules 2 and 3 apply to every check: the first time it runs, not only on a
retry.

### Where to look

The AI that plans the step turns its words into the check's question, the
condition: `Verify the status of order 12 says "Shipped"` becomes "the status
of order 12". The AI that writes the check's code is told to read the part of
the page the condition names — a row, a cell, a field, a heading, a message, a
section — and nothing beyond it: not another row, not another section. Only a
condition about the whole page reads all of it. Wherever else the expected
text appears, what that part shows decides the check.

The planning AI can name a smaller part than the step does, and once it
named the one element the expected text sat in. In the card orders test below,
it turned `Verify the page says "Collect in branch"` into a check of the
courier dropdown's option "Collect in branch", which nobody had chosen. The
check's code read that option, got nothing and failed, as it should. The
retry's new code read the option's label instead and passed: a check that
must fail went green (section 11, M). So:

- When a step names a part of the page and what it says, the planning AI is
  told to name that part in the step's words — "the page" when it says the
  page — and never an element it found holding the expected text in the page
  snapshot it is sent. The snapshot holds text a person does not see, such as
  a dropdown's other options, and the check would then ask whether that
  element says the text, not whether the part the step names does. In M, the
  question became whether the option said "Collect in branch".
- The check's code is told that an option's own `text` and `label` hold its
  words whether it is chosen or not (below).
- A retry runs the failed check's code again (section 5), so code that read
  the part and gave an answer cannot read it another way. New code is still
  written when the old code found nothing, and could then read the option's
  `label` as M's did; it is told what the old code read, and the prompt's
  warning above.

The planning AI has also added a way of comparing that the step does not
use. For `Verify the page says "$25.00 to Northside Dental on 14/03/2027"` it
wrote the condition "the page says exactly", and the check's code then
compared the whole page's text with the expected text for equality, so a
check that must pass failed (section 11, N to S and V). The planning AI is
told to keep the step's own words for how to compare and add none: a part
that "says" or "shows" a value holds it, not only it. Its prompt shows the
condition for an invented step: for `Verify the banner says "Order 12 was
placed."`, "the banner says", not "the banner says exactly". With it, that
step passed at the first try in 10 of 10 runs (W).

The planning AI has narrowed the part in other ways too. In the first version
of the card orders test, it turned `Verify the page says "Label printed"` into
a check of "the print status", an empty line where the words would appear, in
6 of 7 runs (section 11, I), so those runs hardly tested a check of the whole
page against script code; the page has no such line now. For a check that text
is not shown, a smaller part could still let it pass while the text shows
elsewhere on the page (section 14).

### What a person sees

The AI that writes a check's code decides what a person sees, and is told
what not to count. Its prompt says, in these words:

> Read only what a person sees there. Not script code or hidden text: an
> element's `textContent` holds both, and an element that is itself hidden
> (`display: none`) still hands back its text from `innerText`. Not a
> dropdown's options other than the chosen one: a dropdown's `innerText`, and
> each option's own `text` and `label`, hold every option, chosen or not. When
> the condition asks for something other than the text shown, such as a
> link's address (`href`) or a field's placeholder, read that

Each of those reads was seen to hold more than a person sees in a real run:
script code through `textContent` (case D), a hidden element's own
`innerText` (U), and a dropdown option nobody chose (M, T).

It says what to leave out, not how: which property to read, and whether an
element is hidden, is the AI's to work out from the page it is sent. It may
read `innerText`, ask the browser whether an element is shown
(`checkVisibility`), or read a dropdown's chosen option; that is its choice.

**Why the AI decides, not Steptix.** For a while Steptix put a function of
its own in every page, `window.__steptixShownText`, which gave the text an
element shows a person, and the check's code was told to read with it. It
grew to over 800 lines over eight versions, each measured in review and in
live runs (section 11, L to S), and each fix for one kind of page broke
another: a list written out above a dropdown with the same lines as its
options, dropdowns next to each other whose lines make each other's, a
drawing that offers the same label as HTML and as SVG text, a browser that
leaves a dropdown out of `innerText` altogether. Pages combine elements in
more ways than such code can follow, so it was removed (section 12). Since
then the AI decides, as it already decides which element the step means.

What the two usual ways of reading an element's text give, which is why the
prompt warns about both. Measured in Chromium 147 and in Chrome 155, the
browser the live suite runs, with the same results in both:

| On the page | `innerText` | `textContent` |
|---|---|---|
| A `<script>`, read by itself | its code | its code |
| The same `<script>`, read through the element around it | left out | included |
| An element styled `display: none`, read by itself | its text | its text |
| The same element, read through a shown parent | left out | included |
| An element styled `visibility: hidden` | nothing | its text |
| A parent styled `visibility: hidden`, with a child styled `visible` | the child's text | all the text |
| The body of a folded `<details>` section, read through the element around it | left out | included |
| A dropdown with "Beta" chosen, or the section around it | "Alpha" and "Beta": every option | every option |
| Text typed into a text area, read by itself | nothing | the text it started with |
| SVG text that is drawn | none: SVG has no `innerText` | its text |
| SVG text in a definition, in a `<symbol>` (an icon kept for use elsewhere), or in a group styled `display: none`, read through the element around the `<svg>` | its text | its text |
| An icon's tooltip (an SVG `<title>`), read through the element around the `<svg>` | left out | its text |

Firefox and WebKit leave a dropdown out of `innerText`, the chosen option too.

So `innerText` alone is right for most parts of a page and wrong for a few:
the dropdown in T is one, and the card orders tests below hold others. The AI
is sent the page snapshot it plans from, and with `ai.sendScreenshots` a
screenshot of the page too. A way for it to ask for a picture of one element
it names is a follow-up (section 14).

### Finding the element that holds a whole sentence

When the element picked holds only part of the expected text — `12` of
`Order 12 was placed.` — the code is told, in words, to take the smallest
element that shows all of it, inside the part the condition names and nowhere
else; for a condition about the whole page, that part is the whole document
(`document.documentElement`), which also holds what a script adds outside the
page's body. How to tell what an element shows is the AI's, as above.

Before, the prompt gave as its example a search of every element on the page
by its `textContent`. Measured on a test page, that example found the expected
text in a `<script>`, in a hidden element and in another row of a table, and
in case D a check passed on script code that way. The unit test
(`tests/web-survey-fixes.test.ts`, §2.38) checks the prompt's words: the
smallest element that shows the text, inside the part, and no search of every
element by `textContent`.

### The tests

`verify-scope.test.cjs` runs five test files on the SecureBank card orders
page (`fixtures/test-app/card-orders.html`):

| Step | What the page shows | Must |
|---|---|---|
| `Verify the status of order 5126 says "Shipped"` | Order 5126: "Pending". Orders 5127 and 5128: "Shipped". | fail |
| `Verify the page says "Label printed"` | The words only in a script inside the page's form, which would show them after a click the test does not make. | fail |
| `Verify the draft status under the delivery instructions says "Draft saved"` | The words only in that element, styled `display: none`. | fail |
| `Verify the page says "Collect in branch"` | A courier dropdown with "Priority courier" chosen; "Collect in branch" is another of its options. | fail |
| `Verify the status of order 5127 says "Shipped"` | "Shipped" in order 5127's row. | pass |
| `Verify the delivery notice says "Card order 5127 left the depot on 14 May."` | The sentence, with the order number in an element of its own. | pass |
| `Verify the delivery instructions box says "Leave at the side gate"`, after typing it | The typed text, in the box only: it starts empty. | pass |
| `Verify the courier dropdown shows "Priority courier"` | The chosen option. | pass |
| `Verify the title drawn in the chart says "Cards sent this week"` | SVG text. | pass |
| `Verify the page says "Priority courier"` | The chosen option, on the page. | pass |

The page has no empty line waiting for "Label printed" now, so the planning AI
has no empty line to aim at: in the runs with the function, the question for
`Verify the page says "Label printed"` named the page in 32 runs out of 32
(section 11, L to S). The test logs what each failing check read, so a run
whose check read less than the step meant shows it.

**What the runs showed** (section 11, I and L to W). With every version of
the function but one, the five test files passed three runs out of three; on
`54321391` the dropdown check went green once (M). Without the function, and
with the retry writing new code, the dropdown check's first check failed
every time, and its retry passed it in 3 of 9 runs (T). With the retry
running the same code again, no retry passed a check that must fail, in 19
re-checks; one first check passed the hidden "Draft saved" by reading the
hidden element's own `innerText`, which the prompt now warns about (U).
With the warning, that check failed in 8 of 8 runs, and in the full suite all
five test files went as their steps say (V). On the last build, the full
suite passed with none failing, and the one re-check that passed had fixed a
wrong selector (W).

### Steptix's log of pop-up messages

A check about a message that closes by itself may read Steptix's log of such
messages (`window.__steptixNotices`, section 6), and the page snapshot sent
with most requests to the AI lists the messages that have closed. The log
keeps only messages the page marks as announcements for screen readers
(live regions, SPEC-web-survey-fixes.md §2.50). It used to keep their text
hidden or not, so the AI could be told that a message nobody saw had appeared
and closed, and a check could pass on it. In the baseline run of the live
suite, 122 of the 498 requests sent to the AI listed the SecureBank sign-in
page's error message, "Invalid email or password", as one that had closed,
each time while it was hidden and had never been shown on that page (section
11, J).

The log now records a message only while the browser says it is shown
(`checkVisibility`), with the text it shows (`innerText`). It looks when a
message appears or its text changes, and when a class, a style, `hidden` or
`open` changes on the message or on anything around it, which is how a page
usually shows one; a message whose style keeps changing while it stays on
screen is recorded once. Until the page has loaded, the stylesheet that hides
a message may not have arrived, so the log looks at the page's messages once
it has.

This is the one place Steptix asks the browser whether something is shown,
because no AI is there to ask: a message that closes by itself can be gone
before the AI next sees the page. It asks the browser's own question and adds
no rules of its own (section 12). What it misses is listed in section 14.

## 8. Letter case

**By default, case counts.** The text is compared in the case the step writes
it.

**When the step says to ignore case** — "ignoring letter case", "ignoring
case", "case-insensitive", "in any letter case" — both texts are compared in
lower case and in upper case, and they match if either comparison does. Upper
case catches what lower case misses: "ß" is "SS" in upper case, so
"HAUPTSTRASSE" matches "Hauptstraße" only that way.

**When CSS changes how text looks.** CSS can show text in capitals that the
markup writes otherwise. Then the text matches in the case shown, or in the
markup's case, and in no other.

The SecureBank order confirmation page (`fixtures/test-app/letter-case.html`)
shows the status "Payment received", the reference "AB-1042", and a delivery
method its markup writes "Express courier" and CSS shows as
"EXPRESS COURIER". The live test `verify-letter-case.test.cjs` runs every row
of this table against it:

| Step | Result |
|---|---|
| `Verify the order status says "Payment received"` | pass — the case written |
| `Verify the order status says "Payment Received"` | fail — case counts |
| `Verify the order status says "PAYMENT RECEIVED", ignoring letter case` | pass |
| `Verify the order reference is "ab-1042" in any letter case` | pass |
| `Verify the delivery method says "EXPRESS COURIER"` | pass — the case shown |
| `Verify the delivery method says "Express courier"` | pass — the markup's case |
| `Verify the delivery method says "Express Courier"` | fail — neither |

The AI that writes check code is told all of this; it can still get it wrong.
In one live run it lowered the markup's case as well (section 11, G), which
would have passed "Express Courier". The code prompt now says to compare the
markup with its case kept.

## 9. The "the page does show …" note

When a check fails and the expected text is shown elsewhere on the page,
Steptix adds a note to the failure:

```text
Assertion failed: Comment shown — expected "Steptix survey", got "Comments..."
— the page does show "Steptix survey" at li#_valuecomments. If that is what the
step means, read it from there
```

**Who sees it**

| Who | Sees it? |
|---|---|
| The person reading the report | Yes — it shows where the text really is, so the step can be reworded. |
| The retry of a check | No. |
| The retry of an `If …, then …` line | Yes, as before. |

**When it is added:** only for a check that reads the page, and only when
what the check read does not contain the expected text in any letter case.
When it does, the check most likely read the right place and failed for
another reason, such as the letter case itself.

**Why the retry is not told.** Pointing the retry at another place that holds
the expected text invites it to read that place instead — Rule 2 broken, and
a wrong pass (Rule 6). In real case B, the note had named the single
"Northside Dental" label; the retry then checked that label and passed. An
invented example of the same risk: `Verify order 12's status is "Shipped"`
reads "Pending" for order 12, the note says order 13's row shows "Shipped",
and a retry that follows the note passes.

**What it costs.** A check that read the wrong element no longer gets pointed
to the right one. In survey test 45 (section 11, E) the first check read the
empty form's comment box; the note named the list of submitted answers, and
the retry passed. Without the note, the retry has to find that list from the
step's own words: "the results page shows … the comment" — which also fits
the empty form's comment box. The cure is a step that says which comment.
That test has not been run since.

## 10. Writing checks: a guide for test authors

| Do | Don't | Why |
|---|---|---|
| Start a check with `Verify` or `Assert that`. | `The total is $42.00` | The AI decides from a step's wording whether it is a check; those words leave no doubt. "Check the box", "Confirm by clicking" and "Ensure the toggle is on" read as actions. |
| Name the element: `Verify the page heading contains "Sign in"` | `Verify the page title contains "Sign in"` | A page can have two titles: the heading and the browser tab's. |
| Name the row: `Verify the status of order 12 says "Shipped"` | `Verify the status says "Shipped"` | Another row may say "Shipped". |
| Quote the text as the page shows it, or as its markup writes it. | `"Payment Received"` when the page says "Payment received" | Letter case counts. |
| Add `ignoring letter case` when case does not matter. | Rely on the AI to guess. | |
| Put the action and its proof in one step when you mean both: `Click Save, then verify the message says "Saved"` | Expect `Click Save` to check anything. | A step does what it says, and no more. |
| When a check fails, read its failure: "the page does show … at …" says where the text really is. | | The note is for you, not for the retry. |

## 11. Evidence

Each case below was seen in a real run (**observed**), unless marked
**constructed**.

| | What happened | Where | Numbers |
|---|---|---|---|
| A | A retry typed a filter's text again, key by key, until a check that must fail passed. | `typing.test.cjs` on `main`, model `openai/gpt-6-luna` (issue #97) | 4 of 9 runs failed this way. With retries turned off, the check failed red in 5 of 5 runs, as the test intends. |
| B | A retry asked an easier question: one payee's label instead of "Northside Dental and no other payee". The "page does show" note had named that label. | `typing.test.cjs`, 2026-10-16, `openai/gpt-6-luna` (issue #97, first comment) | 2 of 10 runs of the first fix, which stopped retries acting but still let them write a new check. |
| C | A retry changed the text it looked for, so `Verify the page title contains "Sign In"` passed. | `use-ai.test.cjs` step 8 on `main` (#66, #68); the scoreboard | With "Sign In", the first attempt failed in 18 of 31 runs, and 15 of those 18 retries passed. With "Sign in", 12 of 12 passed first time. |
| D | A first check passed on script code: `Verify the page says the button was clicked` read the page's JavaScript source, which contains "Event Triggered" whatever happens. | Survey test 45, run `r-20261008-001709-c04b` | A review of the stored run reports on 2026-10-16 counted 30 of 2,646 passing checks whose code searched every element on the page. |
| E | The "page does show" note rescued a check that read the wrong element: the empty form's comment box instead of the submitted answers. | Survey test 45, run D (`survey/web/results/section-c-runs.md`) | One run. Not run since the retry stopped receiving the note. |
| F | The AI adds a check only when the step asks for one. | The scoreboard, September–October 2026 | 3,455 checks the AI wrote; a search of their steps' wording found none on a step that did not ask for a check. (Three more "checks" were the AI reporting that it could not do a step.) |
| G | A check's code compared the markup ignoring case, which would have passed "Express Courier". | `verify-letter-case.test.cjs`, run `r-20261016-120220-a606`, step 5 | One run; that step's result was still right, because the shown text matched exactly. |
| H | Re-checks on this branch, up to the version of M, nearly all failed again, as they should. One that must fail passed (M). | The scoreboard ([SPEC-scoreboard.md](SPEC-scoreboard.md): one line for each action a run takes), this branch's builds up to `54321391`, 2026-10-16 (UTC) | 101 checks ran on a retry. 100 were re-checks: 99 failed again — 97 that must fail, and 2 of `Confirm the browser is showing a page`, whose result `sections.test.cjs` leaves to the AI — and 1 passed, the card orders check of M. The other passed on a retry that was not a re-check: the AI that writes check code answered `Assert that {{document_count}} equals 3` twice with a step plan instead of code, so the check never gave an answer, and the retry planned the step again and passed. |
| I | On the card orders page, with the first version of section 7 and before it, checks read only the part their step named. For one step, the planning AI named a smaller part than the step did. | `verify-scope.test.cjs` (then four test files), three runs before the first version's prompt change and three after, 2026-10-16 (UTC), `openai/gpt-6-luna`; and the full run in K | 6 of 6 runs passed; every check that must fail failed. None of the 66 check-code replies read beyond the part named. For `Verify the page says "Label printed"`, the planning AI named the print status line, not the page, in 6 of the 7 runs; for `Verify the page says "Draft saved"` it named the page in all 7. |
| J | The page snapshot told the AI that the sign-in page's error message, "Invalid email or password. Please try again.", had appeared and closed, while it was hidden and had never been shown on that page: the page hides it until a sign-in fails, and never hides it again once shown. | The full live suite on this branch before section 7, 2026-10-16 (UTC) | 122 of the run's 498 requests to the AI, in 31 of its 68 reports. After a sign-in with a wrong password (`securebank-matrix.md`) the message was shown, and was not listed. After the first fix (K): none of 528 requests; with the function (L): none of 526. |
| K | The full live suite after the first version of section 7 and the first fix to the log, against the run before them. | The full live suite before section 7 and after `d61105a4`, 2026-10-16 (UTC), `openai/gpt-6-luna` | 80 of 83 tests passed before and 84 of 87 after; 3 skipped both times (computer mode, which runs only when asked); none failed. In neither run did a check's code search every element on the page. Re-checks: 7 before, 11 after: 3 from the new must-fail tests, and 1 from `Confirm the browser is showing a page` on an empty page (`about:blank`). That step's question differed between the runs — "browser page body is present" before, "whether the browser is showing a page with visible content" after, which an empty page fails. The prompt that plans a step was the same in both runs: the AI worded the question differently each time. The step now reads `Verify the page URL is "about:blank"`, which has one answer there: in three runs of `sections.test.cjs` on `ed5f12ed`, 2026-10-19 (UTC), every check of it read the page URL and passed at the first try. |
| L | With the shown-text function, the card orders tests passed as their steps say, every check that read text from the page read it with the function, and the planning AI read the whole page for the script case. | `verify-scope.test.cjs` (five test files), three runs, and the full live suite, on `103e53a8`, 2026-10-16 (UTC), `openai/gpt-6-luna` | 3 of 3 runs of the card orders tests passed. 84 of 88 suite tests passed and 4 skipped (computer mode, and one screenshot check of switching browser tabs, which skips itself when its window is behind another); none failed. The function was in 42 of 42 check-code replies of the card orders runs. Of the suite's 116 replies, 97 read text from the page, all with the function; the other 19 compared values, a URL, a count, a state or the tab title. For `Verify the page says "Label printed"` the condition named the page in 4 of 4 runs. The `about:blank` step of K asked "browser page body is present" again, and passed. |
| M | A check that must fail passed: the planning AI aimed `Verify the page says "Collect in branch"` at the dropdown option that held the words, and the re-check's code read that option's label. | `verify-scope.test.cjs`, three runs, and the full live suite, on `54321391`, 2026-10-16 (UTC), `openai/gpt-6-luna`; the failing run is `r-20261016-160127-7c91` | 2 of 3 runs of the card orders tests passed. In run 1, the condition was "visible text of the Courier option with value branch": the first check read the option with the function, got nothing and failed; the re-check read `label` and passed. Its retry note already said that what the part shows decides the check, and the check-code prompt said not to read `textContent` or `innerText`, but said nothing of `label`. In the other 7 of the 8 runs of this check across L and M, the condition named the page. For `Verify the page says "Label printed"` the condition named the page in 4 of 4 runs. The full suite: 85 of 88 passed, 3 skipped; there the dropdown check failed, as it should. |
| N to S | Seven more builds with the function after the fixes for M: five changed how it read a part (section 12), `211487cc` only the refusal of retry code that read text another way, and `d6e6d21b` was the last. On every one, the card orders tests passed as their steps say, the dropdown check failed every time, and every check that read text from the page read it with the function. One re-check of a check that must pass fixed a comparison and passed. | `verify-scope.test.cjs` three runs, `verify-scope-courier.md` alone six times, and the full live suite, on each of `638f503e`, `939a58a8`, `7ecce9de`, `211487cc`, `da61ef44` and `daf95e0f`, 2026-10-16 (UTC), `openai/gpt-6-luna`; and `d6e6d21b`, 2026-10-16 and 2026-10-17 (UTC) | On each of the six: 3 of 3 runs of the card orders tests passed; the dropdown check failed in 6 of 6 runs of its own and in the full suite's run, and in all 10 runs of it the condition named the page; for `Verify the page says "Label printed"` it did in 4 of 4. The full suite: 84 or 85 of 88 passed, the rest skipped (computer mode, and once a screenshot check of switching browser tabs); none failed. Of the 54 to 152 different check-code replies on each version, those that did not read with the function compared values, a URL, a count or a state, or read the tab title or an element's `aria-label`. On the scoreboard, 29 to 31 checks ran on a retry of each version. Every re-check of a check that must fail failed again. On `211487cc`, `Verify the payee list shows Northside Dental and no other payee` in `securebank-schedule-transfer.md`, which must pass, failed its first check (`r-20261016-200835-2ef4`): its code read " Northside Dental", which starts with a space (the payee's label holds a radio button before its name), and compared it exactly. The re-check's new code trimmed the spaces and passed. On `939a58a8` and `daf95e0f`, `Assert that {{alert_count}} equals 8` passed after its step was planned again (`r-20261016-181854-d0fe`, `r-20261016-215740-ef22`): its first check had no answer, as the AI that writes check code answered it twice with a step plan instead of code, as in H. No retry's code was refused. On `d6e6d21b`, the dropdown check failed on both attempts in 45 of 45 runs, and the five card orders test files went as their steps say in 14 of 14 runs of each. In `typing.test.cjs` there, `Verify the payee list shows Northside Dental and no other payee` (must pass) failed its first check and passed on the re-check's new code (`r-20261017-002140-b2b7`; its report is gone, so why the first check failed is not known); and `Verify the page says "$25.00 to Northside Dental on 14/03/2027"` (must pass) failed on both attempts in 2 of 2 runs, as the planning AI wrote "the page says exactly" for a step that says nothing of exactly (`r-20261016-234632-a571` and the same `b2b7`). The step prompt now tells it to add no word of how to compare that the step does not use. |
| T | Without the function, and with the retry writing new code, the dropdown check's retry passed a check that must fail. | `verify-scope-courier.md` alone six times and `verify-scope.test.cjs` three times, on `f35a50e2`, 2026-10-17 (UTC), `openai/gpt-6-luna`; the wrong passes are `r-20261017-010052-60b6`, `r-20261017-010159-8e47` and `r-20261017-011705-1c9e` | The dropdown check's first check failed in 9 of 9 runs, and its retry passed in 3 of the 9. In each of the three, the first check's code dealt with the dropdown — it walked the page's text itself, or took the dropdown's other options out of the page's `innerText` — and failed; the retry's new code read `document.documentElement.innerText` as it was, which in Chrome holds every option of the dropdown, and passed. The other three checks that must fail failed on both attempts in 3 of 3 runs, and the six that must pass passed at the first try in 3 of 3. `typing.test.cjs`: 2 of 2 runs passed. |
| U | With the retry running the failed check's code again, no retry passed a check that must fail. One first check did: its code read a hidden element's own `innerText`. | `verify-scope-courier.md` alone six times, `verify-scope.test.cjs` three times and `typing.test.cjs` twice, on `7678018b`, 2026-10-17 (UTC), `openai/gpt-6-luna`; the wrong pass is `r-20261017-015609-e734` | 19 checks were re-checked: the dropdown check in 9 of 9 runs, order 5126's status and "Label printed" in 3 of 3, "Draft saved" in 2 of 3, and the plain filter of `typing.test.cjs` in 2 of 2. Each re-check ran the first check's code again, none wrote new code, and every one failed again, as it must. The six checks of `verify-scope.md` passed at the first try in 3 of 3 runs, and the two of `securebank-schedule-transfer.md` in 2 of 2. In the second run of "Draft saved", the first check's code read `#draft-status` with `innerText` and passed: Chrome hands back the text of an element that is itself `display: none` from `innerText`. The check-code prompt said that `textContent` holds hidden text, but not this; the prompt before the function (`d61105a4`) had said it. It says it again now. (The live test reported its must-fail checks red in two of the three runs of `verify-scope.test.cjs` for another reason: it still looked for the note that new code carries. It now looks for the re-check's turn, section 13.) |
| V | With the hidden-element warning back in the check prompt, the hidden "Draft saved" check failed every time. The full live suite's one failure was the planning AI adding "exactly" again. | The "Draft saved" check of `verify-scope.test.cjs` alone eight times, and the full live suite, on `8451229d`, 2026-10-17 (UTC), `openai/gpt-6-luna`; the failure is `r-20261017-022629-b7c0` | "Draft saved" failed on both attempts in 8 of 8 runs; before the warning, its first check passed in 1 of 3 (U). The full suite: 84 of 88 passed, 3 skipped (computer mode, which runs only when asked), and `typing.test.cjs` failed. There, for `Verify the page says "$25.00 to Northside Dental on 14/03/2027"`, which must pass, the planning AI wrote "the page says exactly", its code compared the whole page's text with the expected text for equality, and the re-check ran that code again and failed. Of the suite's 11 re-checks, the other 10 were of checks that must fail, and all failed again. The step prompt now shows the condition for an invented step without "exactly" (section 7). |
| W | With the step prompt's example of a condition without "exactly", every live test went as it should, and one re-check fixed a wrong selector, as section 5 intends. | `typing.test.cjs` ten times and the full live suite, on `3e01bd13`, 2026-10-17 (UTC), `openai/gpt-6-luna`; the re-check that passed is `r-20261017-030043-9fc3` | `typing.test.cjs`: 10 of 10 runs passed. Both checks of `securebank-schedule-transfer.md` passed at the first try in 10 of 10, and the plain filter's check, which must fail, failed on both attempts in 10 of 10. The full suite: 85 of 88 passed and 3 skipped (computer mode, which runs only when asked); none failed. 12 of its 85 checks were re-checked. 11 were of checks that must fail, and all failed again. One of those is `Assert that {{document_count}} equals 3` in `securebank-upload-rows.md` on the run of `data-rows.test.cjs` that runs one row of its three on purpose: one file is uploaded, so the count of 3 must fail, as the test asserts. In `verify-assertions.md`, `Verify the scheduled payment to "External Transfer — J. Smith" …`, which must pass, failed its first check with "element not found: Status cell for External Transfer — J. Smith"; the re-check wrote new code, told what the old code read, which read the row's Status cell, "Pending review", and passed. |

**Constructed** — written to test how Steptix would react, never seen in a
real run, and not built for (Rule 8):

- `Click Save`, with the AI adding its own check that the message says
  "Saved".
- A value read again before a retry failing because a message had closed,
  which stops the retry from running the check.
- A check of an API response retried against the old response, when a job
  would have finished a second later.

## 12. Decisions

| Decision | Why | What was turned down |
|---|---|---|
| A retry of a failed check keeps its question, its expected text and its code. New code is written only when the old code found nothing, breaks when it runs again, was written for a value read again since, or would change the page. | Cases B, C and T. Rules 4 and 6. | Letting the AI plan the step again (weaker checks, case B). Writing new code on every retry, told what the old code read: the new code read the page another way and passed a check that must fail in 3 of 9 runs (T). Not retrying checks at all: no chance to fix a wrong selector, or to see a page that finished updating late. Running the same code costs a first check that compared wrongly its second chance, as the payee check in N to S would have had: a wrong fail, which Rule 6 prefers. |
| New code for a retry may only read the page. | Case A. Rule 1. | |
| The retry is not told where else the expected text appears. | Case B. Rules 2 and 6. Costs case E. | Telling it, with "it counts only if that is the element the step names": keeps E, keeps a risk of B. |
| A step must say where to look; Steptix does not rescue a vague step by searching elsewhere. | Rules 2, 3 and 6. | |
| `use-ai` step 8 says "page heading", not "page title". | Rule 2: one element, not two. | |
| No code enforces "check only when the step asks". | Case F: the AI already follows the rule. Rule 8. | Skipping any check the AI adds to a step without a checking word. |
| `If …, then …` lines are retried as before. | Their check may be the condition; only the planning AI can tell. | |
| Letter case counts by default, with CSS-shown case and markup case both accepted. | Rule 5. Case G led to the stricter wording for the markup. | |
| Every check reads only where the step says, and only what a person sees (section 7). | Case D. Rules 2 and 3. | Doing it in a separate pull request: it edits the same prompt lines. It is in commits of its own instead, each measured: `verify-scope.test.cjs` three times either side of the first version, and the full suite before it; the full suite after it, which ran with the first fix to the log too (K). |
| No code in Steptix decides what a person sees on a page: which element is shown, which option is chosen, which text is drawn. The AI that writes a check's code decides, told in words what not to count (section 7). | Pages combine elements in more ways than such code can follow. Over eight versions of Steptix's own function for it (L to S), each fix for one kind of page broke another (section 7). And a rule in Steptix's code that is wrong is wrong in every check, on every page of that shape. | The shown-text function, `window.__steptixShownText` (from `103e53a8`, removed in `f35a50e2`), which in turn: cut a dropdown's other options out of `innerText` where their words first appeared, and cut shown text instead when the same characters came earlier ("Error 404" became "Error 04"); built the text piece by piece, and counted a folded section's body and spaced "$12.99" as "$ 12 .99"; took out every line like a dropdown's, and with them the same words shown elsewhere; kept every place a dropdown's lines were found, and let an option nobody chose through where dropdowns next to each other make each other's lines; and worked out which of a drawing's alternatives is drawn, where browsers differ. All were measured in review. With it went a refusal of retry code that read text another way than with the function. Before it, telling the AI how to read each kind of element (the first version of section 7): the example it gave the AI picked a dropdown option nobody chose. |
| Steptix sets no rule of its own for how text is compared: whether spacing, line breaks or an icon beside a label count. The step's words decide, as the AI reads them. | Steptix is for every kind of page and test, and for some a space, a line break or an icon is what is being checked. A rule that suits one test is wrong for another. Rule 2: the step says what it means. | A rule in the check-code prompt that every run of whitespace counts as one space, the ends trimmed, and that an icon or emoji beside a label is not part of it, unless the step says otherwise. Proposed after the payee check's leading space (section 5) and withdrawn before it ran. |
| The log of pop-up messages keeps only messages the browser says are shown when it looks, and starts looking once the page has loaded. | Case J. A message that closes by itself can be gone before the AI next sees the page, so the log has to record it with no AI there. It asks the browser's own question (`checkVisibility`) and adds no rule of its own. | Keeping hidden messages (J). Later versions that started at the first drawing, looked again after each drawing and on more kinds of change, and at load withdrew what a late stylesheet had hidden: they read with the shown-text function, and went with it; what they caught is in section 14. Asking about the element around a message styled `display: contents`, which the browser calls hidden: a rule of Steptix's own about what is shown. |

## 13. Tests that guard this

**Live tests**, with the real AI, against the SecureBank test site
(`fixtures/test-app`):

- `typing.test.cjs` — the filter check must stay red; no retry may type key
  by key (case A).
- `verify-assertions.test.cjs`, with `verify-near-miss.md` and others —
  checks that must fail stay red after a retry.
- `verify-letter-case.test.cjs` — every row of the table in section 8, across
  `verify-letter-case.md`, `verify-letter-case-strict.md` and
  `verify-letter-case-transform-strict.md`.
- `use-ai.test.cjs` — step 8, the heading.
- `verify-scope.test.cjs` — section 7, on the card orders page
  (`fixtures/test-app/card-orders.html`). Order 5126's status, words only in
  a script, words only in a hidden element, and a dropdown option nobody chose
  must fail (`verify-scope-order-status.md`, `verify-scope-print-label.md`,
  `verify-scope-draft-message.md`, `verify-scope-courier.md`); a row, a
  sentence, a typed text box, a dropdown, SVG text and the chosen option on
  the page must pass (`verify-scope.md`). Its dropdown check is the one T and
  U ran on its own.

**Unit tests** — `tests/check-retry.test.ts` drives the retry with replies
written into the test. They show how Steptix reacts to a reply, not what an
AI sends (Rule 8). It checks that a re-check runs the failed check's code
again and asks no AI; that it writes new code, told how the check failed,
when the old code found nothing, breaks when it runs again (told the error
too), was written for a value read again as something else, or would change
the page; that new code which would change the page is not run, and the step
says the code was refused when neither try ran; and that every check's code
is told section 7's rules. Its page answers each piece of check code by a
mark in the code, and code marked to answer one way the first time it runs
and another way after stands for a page that changed between attempts.

`tests/web-survey-fixes.test.ts` runs the "page does show" search in a real
browser, and checks the check-code prompt's words for the sentence search
(§2.38). Its §2.33 and §2.50 blocks test the log of pop-up messages: what it
records, when, and what it never records.

## 14. Known gaps and follow-ups

- **What a person sees is the AI's call.** It is told what not to count, and
  can still get it wrong, as T shows a retry doing: text that a page makes
  see-through (`opacity: 0`), moves off the edge of the screen, sizes to
  nothing or leaves in a dropdown's other options is in the page snapshot
  like any other text. Section 10 says how a step leaves it less to work out.
- **No way yet for the AI to look at one element.** With `ai.sendScreenshots`
  it is sent a screenshot of the page. A follow-up would let it ask, at any
  step and not only a check, for a picture of an element it names: Steptix
  would scroll the element into view, leave the page scrolled there so the
  person watching sees where, and send the picture back on the next turn.
- **A first check that compared wrongly** fails again on its retry, as the
  same code runs again (section 5: 2 of 16 runs of one check that must pass
  would have failed so, in N to S).
- **A frame that resolves differently** on the re-check is not noticed: code
  written for the page, when the check's frame was not found at first, runs
  in the frame once it is, or the other way round (constructed).
- **API checks** are retried against the response they already have
  (constructed; a follow-up task checks real runs first).
- **A value that can no longer be read** — a message that has closed — ends
  the retry before its check runs (constructed; a follow-up task checks real
  runs first).
- **Under `npm run dev`** the "page does show" note never appears: the dev
  tool rewrites the in-page search into code the browser cannot run. Normal
  runs are not affected (follow-up task).
- **Prompt rule 13d's example** uses names from the SecureBank site
  (follow-up task).
- **Must-fail test titles.** `verify-near-miss.md`, `verify-false-negation.md`
  and `securebank-transfer-plain-filter.md` say "must fail" in their titles,
  which a command-line run sends to the AI. The live suite sends the file
  path instead.
- **The page-change scan** catches the usual ways of writing a click, a
  scroll or a DOM change, not every way.
- **Compiled checks.** Section 7's rules are in the prompt for check code
  written during a run. A step compiled to code-behind is written by another
  prompt, which does not state them.
- **A smaller part than the step names.** The planning AI is told to keep the
  step's part (section 7), and it can still narrow it. For a check that text
  is not shown, a smaller part could pass while the text shows elsewhere on
  the page (constructed).
- **The log of pop-up messages** does not say where on the page a message
  was, so a check that accepts a logged message cannot tell an error under one
  field from one under another (constructed). It misses (constructed):
  - a message shown and gone before the page has loaded;
  - one shown by something that changes neither the page's elements nor a
    class, style, `hidden` or `open` on them: a ticked box that CSS answers,
    a panel a script pops up over the page, an animation that ends, a style
    rule a script adds;
  - one styled `display: contents`, which the browser calls hidden while its
    text shows;
  - messages inside custom components; and, as far as the page snapshot is
    concerned, messages in frames other than the page's own, as the snapshot
    reads only the page's own log.

  And it records a message that a stylesheet hides only after the page has
  loaded (constructed).
- **Letter case through CSS.** For text that CSS shows in another case, the
  check reads the markup's case from text whose parent element is shown
  (section 8). A parent styled `display: contents` counts as hidden there, so
  such text matches only in the case shown (constructed).

## 15. Where it lives in the code

- `src/ai/check-retry.ts` — the retry of a failed check: sends the same check
  again (`recheckResponse`), says when its code runs again
  (`codeToRunAgain`), and writes the note of section 6 for new code
  (`recheckNote`).
- `src/runner/step-executor.ts` — runs each check (`evaluateAssertion`),
  records a failed one with the values its code was written for, decides when
  a retry runs the same check again, and adds the "page does show" note.
- `src/ai/prompts.ts` — what each AI request is told: the step-planning
  rules (rule 5, check only when asked; rule 8, how a check is described)
  and the requirements for check code (`buildAssertionCodePrompt`: reading
  only the part named and only what is shown, section 7; letter case,
  section 8).
- `src/ai/action-parser.ts` — `assertionCodeFailed`: what the AI that writes
  check code is told when its code failed to run.
- `src/codebehind/generate.ts` — `checkCodeMutation`: the scan for code that
  would change the page.
- `src/browser/locate-text.ts` — finds where the expected text is shown, for
  the note in section 9.
- `src/browser/notices.ts` — the log of pop-up messages, and the list of the
  ones that closed that `captureDomSnapshot` (`src/browser/dom-cleaner.ts`)
  adds to the page snapshot.
- `docs/specs/SPEC-web-survey-fixes.md` §2.25, §2.33, §2.38, §2.43 and
  §2.50 — the history of the note, of the log of pop-up messages, and of how
  checks compare text.
