# Writing natural-language tests: a handbook for AI authors

This file is meant to be pasted into the context of an AI that writes tests for
**steptix** (the `steptix` CLI, the Steptix VS Code extension, and the
MCP server all run the same test files). It explains how the framework reads a
test, which phrasings map to real browser actions, and how to reuse work
through skills and tools. Every statement was checked against the source on
2026-09-21; the last section says where to look when the framework moves on.

The companion [ai-test-authoring-guide.md](ai-test-authoring-guide.md) is the
rule-by-rule reference with more caveats. This handbook is the mental model
plus the phrasing that is known to work, so read this one first.

Every Markdown example below is a complete file that the parser accepts, and
every TypeScript example is a tool the registry loads. Each is introduced by a
`File` line naming where it would live in a project.

## 1. How a step is executed

A test is a Markdown file. The numbered lines under `## Steps` are the
instructions. Seven kinds of line are handled by the framework itself rather
than performed by a model:

- `Set {{name}} to "…"` assigns a variable.
- `[use ai] <step>` asks the model for a value and stores it (§3.2). The
  model sees the step text and nothing else — no page, no earlier steps, no
  date — and is asked again on every run.
- `[skill: name …]` inlines a reusable step sequence from another file.
- `[tool: name …]` runs a TypeScript function.
- `[use computer]` / `[use browser]` switch which *surface* the following
  steps run on — the whole screen, or the page (§3.10).
- A line that is exactly the name of a `### Section` in the same file runs
  that section's steps.
- A control line — `If …, then …`, `Else if …`, `Otherwise, …`, `While …`,
  `Repeat … until …` or `For each {{x}} in {{list}}, …` — decides or repeats
  one other step (§3.5). The framework dispatches the line; the *condition* on
  it is the one thing on this list that does reach a model, as a question it
  answers rather than acts on.

Every other line is sent to the executing model together with:

- the step text **as you wrote it**, placeholders intact, plus a `## Values`
  block saying what each `{{name}}` and `${ref}` holds on this run (values with
  a secret-looking name show as `***`);
- a cleaned DOM snapshot of the active tab: interactive elements, visible
  text, roles, ids and test ids. Elements hidden with `display:none` or
  `aria-hidden` collapse to an empty placeholder, and long repetitive runs
  (table rows, list items) collapse to head and tail with an "N similar
  elements omitted" marker;
- the current URL, the viewport size and device class, the open tabs and
  browsers, and the outcome of earlier steps;
- every `context/**/*.md` file in the project, verbatim;
- the test's own `## Context` section, verbatim, after the project's files;
- a screenshot, only when `ai.sendScreenshots` is on in `steptix.config.json`
  (it is off by default, so assume the model works from the DOM).

The model returns **one action per turn**. The framework performs it with
Playwright, takes a fresh snapshot, and asks again until the model reports the
instruction satisfied. The one exception is that a triggering action may be
chained with a single wait when the step names what to wait for. A step is
capped at 15 turns.

A failed action is retried once, and the retry prompt says which selector
failed, how many elements it matched, and why. A `Verify` or `Assert` step is
turned into a JavaScript check that runs in the page (or a pure value
comparison when no page is involved), and the step fails when it returns
false. The check is generated afresh on every run unless the step has been
compiled to code-behind (§10).

Six consequences for how you write:

1. **One bounded instruction per line.** The model is told to stop when the
   instruction is fulfilled and never to run ahead into the next step. Splitting
   "enter credentials" from "click Sign in" is load-bearing, not style.
2. **Name targets by their visible label, then scope them.** `Click Save in
   the Shipping address dialog` beats `Click Save`. The model is told never to
   pick the Nth match; a repeated label with no scope is a guess, and with
   `browser.ambiguousTarget: "fail"` in the project config it is a failed step.
3. **Name the completion condition.** `Click Sign in and wait for the
   Dashboard heading` lets the framework block on that condition instead of
   polling with extra model turns.
4. **Say what to capture and what to call it.** A value the model merely saw
   is not a variable; `[store as: name]` makes it one.
5. **Placeholders are preserved, not pasted.** `{{password}}` reaches the model
   as the token, the model writes the token back into its action, and the real
   value is substituted at the moment of acting. This is why secrets can be
   used without ever being shown to the model.
6. **A placeholder can hold an instruction.** `Verify {{outcome}}` with
   `outcome` set to "the Dashboard page is shown" becomes an assertion of that
   sentence, which is how one data-driven test checks different results per
   row.

## 2. File anatomy

File `tests/login.md`:

```markdown
---
tags: [smoke, login]
timeout: 120s
---

# Valid user can sign in

Anything between the title and the first `##` heading is description. The
parser ignores it, so explain intent here rather than inside a step.

## Context
The account menu is the avatar in the top right corner, `#user-menu`.

## Config
- baseUrl: https://app.example.test
- viewport: desktop

## Parameters
- email: qa.user@example.test
- password: $TEST_PASSWORD

## Steps
1. Navigate to /login
2. Type "{{email}}" into the Email field
3. Type "{{password}}" into the Password field
4. Click the Sign in button and wait for the Dashboard heading
5. Read the name shown in the account menu [store as: display_name]
6. Verify the welcome banner contains "{{display_name}}"
7. Click Sign out and wait for the Sign in button
```

### Headings the parser recognises

| Heading | Purpose |
| --- | --- |
| `# Title` | The test name. One H1. |
| `## Config` | Per-test settings, as `- key: value` bullets. |
| `## Parameters` | Named inputs, as `- name: value` bullets, used as `{{name}}`. |
| `## Context` | Free text the AI is given with every step of this test. See below. |
| `## Steps` | The instructions. The heading must be exactly this; `## Steps (happy path)` yields a test with no steps. |
| `## Hooks` | Setup and teardown lines (CLI runner only, see §8). |
| `## Outputs` | Skill files only: the variables a skill hands back. |

Any other `##` heading, and everything under it, is ignored. That makes extra
prose sections safe and makes a misspelled `## Step` heading a silent failure.
The order of `## Config` and `## Parameters` does not matter.

### `## Context`

`## Context` is what the AI should know for the whole test: how the app
behaves, what may appear on the page, and where things are. It is sent,
word for word, with every step, after the project's `context/**/*.md` files,
so put a note that applies to every test of a project in a context file and a
note about this test here. Unlike the description under the title, the AI
sees it.

Write anything the steps would otherwise have to repeat, including selectors
and frame ids. The framework holds no knowledge of any site, so the test file
is where that knowledge goes:

```markdown
# Pay for the basket

## Context
- The page shows ads, and sometimes a full-screen one. Close any ad or
  overlay that covers what you need (its ✕ or Close button), or scroll past
  it, then carry on. An ad is not a failure.
- The payment form is inside the iframe `#card-frame`. The card number field
  is `[data-test=card-number]`.
- Saving shows a toast that disappears after three seconds; a check about it
  should read it straight away.

## Config
- baseUrl: https://shop.example.test

## Steps
1. Navigate to /basket
2. Click Checkout
3. Type "4242 4242 4242 4242" into the card number field
4. Click Pay and verify the page says "Payment received"
```

Everything from the heading to the next `#` or `##` heading is kept,
including lists, code and `###` subheadings. `{{placeholders}}` in it are
not substituted.

### Step lines

- Write `1. text`, unindented, one instruction per physical line. The numbers
  are not checked, so a renumbering mistake does not break the file. HTML
  comments and blank lines between steps are fine.
- Do not wrap a step onto a second line. The CLI folds it, but Steptix sees
  only the first line and refuses the file before running.
- Write `1.` rather than `1)` or a bullet. The CLI happens to accept those,
  but Steptix does not see them as steps, and a file that also has sections
  rejects them outright.
- Keep explanations out of step text. A trailing note becomes part of the
  instruction the model must satisfy.
- `{{name}}` is a placeholder only when written without spaces inside the
  braces; `{{ name }}` is refused.
- `${name}` is the *environment* form and is not interchangeable with it.
  Writing `${email}` where `email` is a captured value or a loop binding is
  refused before the step runs, naming `{{email}}` as the correction — and
  that holds even when the test declares no environment at all, which is how
  the wrong braces used to reach the browser as written.

### Frontmatter

Exactly six keys survive parsing: `tags` (a list, or a comma-separated
string), `timeout`, `env`, `dataFile`, `dataSources` (a mapping), and `type`
(`skill` or `test`). Steptix additionally honours `disabled: true`, which
hides the file from its test list. Write `timeout: 90s` as a string; a bare
YAML number is dropped without a warning.

### `## Config` keys

| Key | Accepts | Notes |
| --- | --- | --- |
| `baseUrl` | URL | Relative `Navigate to /path` resolves against it. |
| `timeout` | `60s`, `5m` | Whole-test budget, checked between steps only. Frontmatter `timeout` wins if both are set. |
| `viewport` | `mobile`, `tablet`, `desktop`, or `1280x720` | 390×844, 768×1024, 1440×900. Page size only, no touch or user-agent emulation. Cannot be combined with `cdp`; that is a hard error. |
| `cdp` | port number | Attach to a browser you started with `--remote-debugging-port`. |
| `cdpTab` | `new`, `0`, `url~text`, `title~text`, `active` | Which tab of that browser to drive. |
| `consoleLogLevel` | `silent` … `debug` | Console verbosity for the run. |
| `serverFileLogLevel` | `off`, `compact`, `full` | Server-side log file detail. |
| `unmask` | comma-separated names | Stop masking a value whose name merely looks secret. |

Unrecognised keys are stored and never read, with no warning. A `## Config`
key is not a test variable; declare inputs under `## Parameters`.

### Ads and other third-party content

Ads, cookie banners and chat widgets can cover what a step needs to click.
There are two ways to deal with them, and they suit different projects.

**Tell the AI how to handle them, in `## Context`.** The page loads as a real
visitor sees it, ads included, and the AI closes or scrolls past what gets in
the way. Use this when the ads are part of what you are testing, or when you
do not know in advance where they come from:

```markdown
# Search the catalogue

## Context
- The page shows ads, and sometimes a full-screen one when a page opens.
  Close it with its Close or ✕ button before doing anything else. If two are
  stacked, close the top one first.
- A cookie banner may cover the bottom of the page. Click "Accept" on it.

## Config
- baseUrl: https://catalogue.example.test

## Steps
1. Navigate to /search
2. Type "lamp" into the search field and press Enter
3. Verify at least one result mentions "lamp"
```

**Stop them loading, with `browser.blockAds`.** List the domains in the
project's `steptix.config.json`. The browser cannot reach any of them, or any
subdomain of them: requests fail as if the domain did not exist, so their ads
never appear. Every test in the project gets it, at no cost per step:

```json
{
  "browser": {
    "blockAds": [
      "doubleclick.net",
      "googlesyndication.com",
      "adservice.google.com"
    ]
  }
}
```

- **Steptix has no list of its own.** It blocks exactly the domains you name,
  and nothing when the key is absent or `[]`.
- **Write bare host names.** `"doubleclick.net"` blocks `doubleclick.net`
  and `securepubads.g.doubleclick.net`, but not `notdoubleclick.net`. Do not
  write `https://`, a path or a `*`: the config refuses to load and names the
  entry.
- **Finding the domains.** Open the page in a browser, look at the Network
  tab of the developer tools, and note the domains the ads are loaded from.
  An ad's iframe `src` shows it too.
- **It is not only for ads.** Any third-party content a test does not need
  can be blocked the same way, such as a chat widget's domain.
- **When not to use it.** If the app under test integrates with one of those
  services (it shows its own ads, or reports purchases to an ad network),
  blocking it changes what the app does. Leave the domain off the list.
- **Not for a browser you attach to.** A browser reached through `cdp` is
  your own, so nothing is blocked there.

Both can be used together: block the ad networks you know about, and keep a
line in `## Context` for anything that still gets through.

## 3. Step vocabulary

The model chooses actions from what the page offers, so these are phrasings,
not keywords. Each row is a shape the executor's prompt rules explicitly map
to an action.

| Intent | Write | What happens |
| --- | --- | --- |
| Go to a page | `Navigate to /orders` or `Navigate to https://…` | `page.goto`. Relative paths need `baseUrl`. |
| Browser back | `Go back` / `Go back to the previous page` | `page.goBack()` on the active tab — the browser button, not anything in the page. Same-document entries count, so a single-page app that pushes history works. Fails the step when the tab does not move. |
| Browser forward | `Go forward` | `page.goForward()`. Fails the same way when the tab does not move. |
| Reload | `Reload the page` / `Refresh` | `page.reload()` on the active tab — the browser button, not F5 (a key goes to the page). Waits for the page as a navigation does. |
| Click | `Click the Sign in button` | Located by visible label, then the most stable selector on that element. |
| Click, scoped | `Click Edit in the row for order {{order_id}}` | Scoping by row, dialog, section or form is how repeated labels are disambiguated. |
| Enter text | `Type "{{email}}" into the Email field` | Clears the field, then fills. It does not append. |
| Several fields | `Enter the username {{username}} and the password {{password}}` | One field per turn, then the step ends. Fine as one line. |
| Native select | `Select Australia from the Country dropdown` | Acts on the `<select>` by visible option text. |
| Custom dropdown | `Open the Country dropdown and choose Australia` | Two clicks. |
| Checkbox, toggle | `Check the I agree checkbox` | A click. Words like check, confirm and ensure describe an action here, not a verification. |
| Hover | `Hover over Products to reveal its menu` | `hover`. |
| Drag and drop | `Drag the Invoice 1043 card onto the Paid column` | One `drag` action: the element dragged and the element dropped on, each named by visible label and scoped like a click. Works for HTML drag-and-drop and for pointer-driven sortables. |
| Key press | `Type "shoes" into the Search field and press Enter` | The key press is page-level and targets nothing. Put the field first in the same step so it has focus. |
| Scroll a little | `Scroll down a little` / `Scroll down one screen` | About 300px, or a viewport height. |
| Scroll to the end | `Scroll to the bottom of the page` | Exact, whatever the page height. |
| Scroll to a thing | `Scroll to the Reviews section` | Scrolls that element into view. |
| Lazy-loading list | `Keep scrolling down until the list stops growing` | Repeated scroll turns. |
| Upload one file | `Upload attachments/statement.pdf using the Choose file button` | A path with an extension or a folder separator marks the step as an upload. |
| Upload several | `Attach attachments/receipt-1.png and attachments/receipt-2.png to the Receipts field` | One upload action with several files. |
| Inside an iframe | `In the Payment iframe, type "{{card_number}}" into Card number` | The action carries the iframe selector. |
| Cookie banner | `Reject non-essential cookies in the cookie banner` | A click. The framework does not need a banner rule to do this. |
| New tab | `Open https://docs.example.test in a new tab and remember it as docs` | Becomes the active tab and is labelled `docs`. |
| Follow a link that opens a tab | `Click "Open New Tab" and switch to the tab it opened` | New tabs are tracked; the switch makes it active. |
| Switch tab | `Switch to the docs tab` / `Switch back to the main tab` | `main` is the original tab. |
| Close a tab | `Close the tab showing "Account Summary"` | The main tab cannot be closed. |
| Second session | `Open a second browser as reviewer` / `Open an Edge browser as reviewer` | A fully separate browser with its own cookies. `default` is the first browser. |
| Switch session | `Switch back to the default browser` | Subsequent steps drive that browser's active tab. |
| Close session | `Close the reviewer browser` | |
| Wait | `…and wait for the Saved message` | See the next subsection. |
| Capture | `Read the order number from the confirmation panel [store as: order_id]` | A `read` action into the variable. |
| Make up a value | `[use ai] Create a customer name starting with AUTO [store as: customer]` | One model call with the step text alone, no page; asked again every run (§3.2). |
| Count | `Count the rows in the Orders table [store as: row_count]` | A `count` action; the value is a number stored as text. |
| Verify | `Verify the status of order {{order_id}} is Shipped` | An assertion. See §3.3. |

Nothing in this table needs a CSS selector, and you should not write one
unless you have verified it in the real page. Test ids are honoured when
present, but the label is what the model matches first.

### 3.1 Waits

Prefer a condition to a sleep. Name the thing that should appear, disappear,
change or load, and the executor pairs the action with the narrowest wait it
has: an element becoming visible or hidden, text appearing, a URL, a page
load, a navigation, an element count, an attribute value, page stability, or a
plain duration.

The default wait budget is ten seconds and the hard cap is ten minutes. A
slow operation needs the duration stated in the step, because the whole-test
`timeout` only ever fires between steps and never shortens or lengthens a wait
in progress.

File `tests/save-profile.md`:

```markdown
# Save profile

## Config
- baseUrl: https://app.example.test

## Steps
1. Navigate to /profile
2. Type "Riley" into the Display name field
3. Click Save and wait up to 45 seconds for the Saved message
4. Wait until the progress spinner disappears
5. Wait 2 seconds
6. Verify the Display name field contains "Riley"
```

Do not encode state in a selector ("wait for `.spinner:hidden`"); say the
state in words and the framework applies it.

### 3.2 Capturing values

A capture writes a variable that later steps read as `{{name}}`. Three
spellings bind the name; pick the first:

- `Read the order number from the confirmation panel [store as: order_id]`
- `[output: order_id] Read the order number from the confirmation panel`
- `Read the order number from the confirmation panel and store as {{order_id}}`

`[as: order_id]` is **not** a framework marker. It appears in some shipped
example files and works only because the model happens to derive the same name
from it. Do not use it in new files.

Say precisely what to read:

- Link text and a link's address are different reads. `Read the href of the
  View order link [store as: order_url]` asks for the attribute.
- `Capture the current page URL [store as: confirmation_url]` is its own idiom
  for the page's own address.
- "every", "all" or "each" makes a list: `Read the href of every invoice link
  in the Invoices section [store as: invoice_urls]`. The variable holds a
  JSON-encoded array, capped at 500 entries, which array-typed tools decode.
  One column, though: two or more columns from the same rows of a table is a
  different read, because three parallel arrays can lose their alignment
  (§3.8).
- A list that comes back empty, or holds more than one kind of element (a
  name and the card number beside it), is shown to the model before the step
  ends. It sees what its selector matched, kind by kind, with a few of the
  values the read stored (a count shows only kinds and numbers). It
  then reads again with a better selector or keeps the list, since an empty
  list can be the right answer. That costs one more model call, and only for
  such a list. In a turn the step adds only to show the list, the model keeps
  it with `noop`; in a turn it asked for anyway, going on with the step keeps
  it. A read the model changes is shown again, for as long as the step has
  turns left, and so is a list it left alone while it read another one again.
  A list that changes every time it is read — a live feed — is shown once
  more, then the step ends on it as read.
  It never fails the step: with no turn left, when the
  same turn then changed the page (a click or a wait after the read), or when the
  model's answer is anything but keeping the list or reading it again, the
  step ends on the list as it came back, and the report marks the step
  **⚠ list not checked**. A count of 0 is treated the same way.
- Asking for part of a text ("just the digits after Account number:") makes
  the model add a regular expression. That read **fails the step** if the
  pattern matches nothing, so ask for a substring only when you mean it, and
  use a tool when the slicing must be exact.
- `Count the rows in the uploaded documents table [store as: document_count]`
  stores `"4"`.

A value that was displayed but never captured does not exist in later steps.

#### A value the model makes up: `[use ai]`

Not every value is on a page. A customer name for a sign-up form, a paragraph
of filler text, a date worked out from one you already have: open the step
with `[use ai]` and the model produces it.

```markdown
5. [use ai] Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name
6. [use ai] Today is {{today}}. Give the date 3 days later as yyyymmdd [store as: days_from_now]
7. Type {{random_name}} into the Name field
```

The step's text, placeholders filled in, goes to the model **on its own**.
Four things follow, and each is on purpose:

- **The model is asked on every run.** A `[use ai]` step is never compiled;
  a compiled test still makes one model call per `[use ai]` step. For a value
  that must be the same every time, write a tool (§7).
- **It sees only the step text** — no page, no earlier steps, no date. If
  "today" matters, put today in the step, from a parameter or a tool's output.
  Asked for "3 days from today" with no date given, the model is told to fail
  the step saying what is missing, rather than guess.
- **It is a poor source of randomness.** "A random number" may well come back
  the same on two runs. Ask a tool when it matters.
- **Only the value is stored.** The model replies in a fixed JSON shape, so no
  preamble ever reaches the variable; an empty answer or a refusal fails the
  step with the model's reason.

Name the value in the step. `[store as: name]` is authoritative — the value is
stored under that name whatever the model calls it — and is the spelling to
use. Without one, the model names the value, and the name it gives must appear
in your step as a whole word ("…and store it in random_name"); a name you never
wrote fails the step, because no later step can be relying on it. That check
rules out invented names, not unnamed steps: a step that never says what to
call its value can be stored under any word of its sentence (`Write a paragraph
about Australia` may become `{{paragraph}}`), so always name it. Inside a
skill the name must be `[store as: name]` or `store as {{name}}`, which the
skill's scoping renames per call. A secret-named value filled into the step
reaches the model as `***`, exactly as in the `## Values` block (§4.4), and so
does a secret that a skill argument or a looped section's row writes into the
step's text, so a step cannot compute from a secret. It fails instead of
guessing: the model is told `***` is a value hidden from it, and an answer that
still contains the mask, however it is spelled (`* * *`, `\*\*\*`), is refused.
The error names what was hidden but never its value, whether the model refused
or answered. A variable hidden only because its name contains `password`,
`secret`, `token` or `key` is sent as itself once renamed; `{{keyword}}` is
the usual surprise. The step's own words are masked with the same set the
report uses, so a short secret value is also masked wherever those characters
appear in the step, as it is in the report.

`[use ai]` goes at the start of the step; anywhere else is a parse error, and
so is `[use ai]` as the step a control line runs (put it in a `### Section`
and name the section instead).

### 3.3 Assertions

Any step whose intent is to check something becomes an assertion: `Verify`,
`Assert that`, `Check that it says`, `Confirm the page has finished loading`.
The model generates a JavaScript check against the DOM (or against earlier API
responses, or a pure comparison of values), the framework runs it, and a false
result fails the step. The check is generated on every run, so each assertion
costs a code-generation call until the test is compiled (§10); a compiled
assertion carries its check as code and asks nothing.

Shapes that are known to pass and, with a wrong expectation, known to fail:

File `tests/portfolio-checks.md`:

```markdown
# Portfolio page checks

## Config
- baseUrl: https://app.example.test

## Steps
1. Navigate to /portfolio
2. Verify the page heading says "SecureBank Portfolio"
3. Verify the total portfolio value is $148,320.50
4. Verify the Cash & Savings total is NOT $60.00
5. Verify the total portfolio value is greater than $100,000
6. Verify the transaction history contains a Woolworths Supermarket transaction
7. Verify there are exactly 10 holdings in the investment holdings list
8. Verify the displayed holdings total of $52,150.00 matches the sum of all individual holding values
9. Verify the transfer Amount field contains 50.20
10. Verify the Transfer button is disabled
11. Verify no error message is shown in the Transfer Funds panel
12. Verify the Closed Accounts table shows no account rows
13. Count the rows in the transaction history [store as: row_count]
14. Assert that {{row_count}} equals 25
15. Assert that "{{row_count}}" is not "0"
```

Steps 14 and 15 compare values only. They need no page, so they run as a
predicate over the `## Values` block, which is the right way to check a
captured value against another variable or a literal.

Two things that are not assertions: `Confirm by clicking Submit` and `Check
the Remember me box` are clicks. And a successful click is not evidence that
the feature worked; add the `Verify` line that would fail if it had not.

For an eventually-consistent value, split the trigger and the check into two
steps, as steps 17 and 18 of the shipped `verify-assertions.md` do. A second
step gets a fresh snapshot after the model's think time, whereas a single step
would have to choose a polling assertion.

A check that should report in your words rather than the framework's takes the
`otherwise fail the test with message "…"` tail from §3.7. The model still does
the same comparison; only the sentence on the failure changes.

### 3.4 Watching for a state

A step that begins `When prompted …` or `When asked …`, or that begins `If …`
without a `then`, is a watch: it waits for one of several page states to
appear. (`then` changes the meaning of an `If` only; `When prompted …, then …`
is still a watch — with one exception, the same one §3.5 names: a tail that is
`return` or `stop` makes the line flow control, so `When prompted for a code,
then return` leaves the flow rather than watching for anything. §3.6. Only
`When prompted` and `When asked` open a watch at all — `When the banner
appears, then …` is not one with any tail.)
Consecutive watch steps are grouped and the next ordinary step is their
continuation. The executor re-reads the page every three seconds until one
branch matches, and fails the step if none does within the wait budget.
Exactly one branch runs, the others are skipped, then the continuation runs.

File `tests/sign-in-with-prompt.md`:

```markdown
# Sign in past an optional prompt

## Config
- baseUrl: https://app.example.test

## Parameters
- email: qa.user@example.test
- password: $TEST_PASSWORD

## Steps
1. Navigate to /login
2. Type "{{email}}" into the Email field
3. Type "{{password}}" into the Password field
4. Click Sign in
5. If a Remember this device prompt appears, click Not now
6. If a Verify your identity page appears, click Skip for now
7. Wait for the Dashboard heading to appear
8. Verify the Dashboard heading is visible
```

Consecutive watch steps are one group in which **exactly one runs**. They are
alternatives, not independent checks — two conditions that can both be true is
the case this shape gets wrong. If you meant alternatives, say so with
`Else if …, then …` (§3.5); if you meant two independent checks, separate them
with an ordinary step so they form two groups.

Keep watch bodies to ordinary page instructions. A `[tool:]`, `[skill:]` or
section name inside a watch clause is not conditional dispatch: the whole line
is prose, and the model performs what it can of it. Adding `then` is what turns
the line into a decision the framework dispatches (§3.5). A `Set` step, any
control line from §3.5, or a flow-control step from §3.6, directly after a
watch is not a continuation: the watch steps then run as plain steps, one at a
time and without the polling. Put an ordinary page step between them when you
need the watch.

### 3.5 Deciding and looping

An `If` with `then` is a **decision**; an `If` without one is the watch above.
That word is the whole opt-in, so `If a Remember this device prompt appears,
click Not now` still means exactly what it meant.

Six line forms. Each is one numbered line whose last part — its **tail** — is
one step to run:

| Write | What happens |
| --- | --- |
| `If the Cash checkbox is ticked, then Pay with cash` | Asks once; runs the tail if the answer is yes. |
| `Else if the Card checkbox is ticked, then Pay by card` | The next member of the same chain. `Otherwise if` also parses. |
| `Otherwise, Verify the Pay now button is disabled` | The last member; runs when nothing above held. `Else,` also parses. |
| `While the Next button is enabled, Go to the next page` | Ask, run the tail, ask again. Zero or more passes. |
| `Repeat Click Load more until the Load more button is gone, up to 20 times` | Run the tail, then ask. One or more passes. |
| `For each {{account}} in {{accounts}}, Check the account` | One pass per element of the list, with `{{account}}` bound to it. |

The tail is one step **of any kind**: a `### Section` name, a `[skill: …]`, a
`[tool: …]`, a `Set {{x}} to "…"`, or a plain page instruction. A body of more
than one step is a section, exactly as it is for reuse (§5), and nesting a
decision inside a branch means putting the inner decision in a section too.
Nothing is indented; an indented sub-list is not a step anywhere in this
format.

Where each keyword splits its line is worth knowing before you fight it:

- `If` and `Else if` end the condition at the **first** ` then `. A condition
  containing the word "then" has to be reworded.
- `While` ends the condition at the **first** comma. The tail may contain
  commas; the condition may not.
- `Repeat` ends the tail at the **first** ` until `. A tail containing the
  word "until" goes in a section.
- `For each` is a fixed shape: `{{item}}`, `in`, `{{list}}`, a comma, the tail.
- `, up to N times` is read off the end of a `While` or a `Repeat` line.

Conditions are written like `Verify` sentences: `the Cash checkbox is
ticked`, `{{plan}} is "pro"`, `the Load more button is gone`, `the cart shows
more than 3 items`. One that asks about the **page** reaches the model as you
wrote it, placeholders intact, with the resolved values listed beside it. One
that is a comparison of values a step already captured is answered by the
framework from those values, with no model call at all (§3.8).

#### A chain decides

An `If`, any number of `Else if` lines and at most one `Otherwise`, on
consecutive step lines, are one chain. The page is allowed to settle, every
condition in the chain goes to the model **in one call** — unless every
condition in it is literal (§3.8), in which case the chain is decided from the
values and there is no call at all — the first that holds wins, and its tail
runs. Every other member — the other guard lines and every step of their
tails — is marked skipped, which is what the report and the
Steptix gutter then show you.

File `tests/pay-invoice.md`:

```markdown
# Pay an invoice

## Config
- baseUrl: https://app.example.test

## Parameters
- card_number: $TEST_CARD_NUMBER

## Steps
1. Navigate to /invoices/4471
2. If the Cash checkbox is ticked, then Pay with cash
3. Else if the Card checkbox is ticked, then Pay by card
4. Otherwise, Verify the Pay now button is disabled
5. Verify the invoice status is Settled

### Pay with cash
1. Click Pay now
2. Verify the receipt says "Paid in cash"

### Pay by card
1. Type "{{card_number}}" into the Card number field
2. Click Pay now
3. Verify the receipt says "Paid by card"
```

Step 4 shows a one-step branch, which needs no section. A decision is made
**once**: a false answer is an answer, not something to wait for. When nothing
holds and there is no `Otherwise`, the whole chain is skipped and the run
carries on at the next step. When the page is visibly mid-transition the
framework re-asks for up to thirty seconds and then fails the line rather than
guessing.

A chain is consecutive step lines, and an `[input:]` line is a step, so an
`[input:]` between an `If` and its `Otherwise` breaks the chain. Any numbered
step between two members does: the `Otherwise` is then refused as having *"no
decision to be the alternative of"* — by the parser, by the server, and by
Steptix before it runs, in that one wording and naming that one line. Put the
input step before the `If`. Inside a tail's section body it is fine.

#### `then return` is not a tail

Some `If … then …` lines are **not** decisions: the ones whose tail is `return`
or `stop` — bare, or with one of the six endings §3.6 lists, so `then stop
running the remaining steps` counts too — and the one whose tail is `fail the
test with error "…"` (§3.7). The same goes for a line opening `When`.
`If the page title contains "Dashboard" then return`
is a flow-control step and is read as one everywhere — by the parser, the
runner, the compiler and the editor — because two grammars claiming one line
and disagreeing is the one way this could quietly do the wrong thing.

The anchor is exact, and it cuts both ways. `If x then return to the dashboard`
has words after the tail, so it is not flow control: it is an ordinary
decision whose tail is the prose "return to the dashboard", which is what you
meant by it. And the rule is on the *head* only, so `Otherwise, return` and
`While the banner is visible, return` are still a branch and a loop whose body
happens to be a return.

Because a flow-control step is not a chain member, an `Else if` or `Otherwise`
directly under one is refused — and refused with its own sentence rather than
the dangling one, since the line above plainly does open `If`. You do not need
one: the steps after a `then return` already run only when the return did not
fire, so the alternative is just the next step.

```markdown
1. If the page title contains "Dashboard" then return
2. Enter the username {{username}}
```

A `return` inside a loop body ends that **pass**, not the loop — an iteration
is a flow, and the loop asks its condition again. Inside a chain's tail it ends
the tail, and the run carries on after the whole chain.

#### A loop decides again

`While` asks before each pass, `Repeat … until` asks after each one, and `For
each` asks nothing at all — the list is its bound. Both asking loops stop at a
**cap**: the line's own `, up to N times`, or `execution.maxLoopIterations`
from `steptix.config.json`, which is 25. **Reaching the cap fails the loop line.**
A cap is a bug net, not an exit; write the condition the page really reaches.

`For each` needs a real list. Its second variable must hold a JSON array — what
a plural read stores ("every", "all", "each", §3.2) or what an array-typed tool
returns. `Set` builds text, and text is not a list: `For each` over
`Savings, Everyday` fails the line and says so rather than guessing a delimiter.

When the elements are records rather than strings — a table read (§3.8), or a
tool that returns objects — the pass binds the whole record as `{{item}}` and
each of its fields as `{{item.field}}` as well. Nothing about the line changes;
the item simply has parts.

File `tests/statement-archive.md`:

```markdown
# Statement archive

## Config
- baseUrl: https://app.example.test

## Steps
1. Navigate to /statements
2. While the Next button is enabled, Go to the next page
3. Verify the Statements panel says "Page 4 of 4"
4. Repeat Click Load more until the Load more button is gone, up to 20 times
5. Verify the Alerts panel says "All alerts loaded"
6. Read the name of every account in the Your accounts panel [store as: accounts]
7. For each {{account}} in {{accounts}}, Check the account
8. Verify there are exactly 3 accounts in the Your accounts panel

### Go to the next page
1. Click the Next button

### Check the account
1. Verify the Your accounts panel has a row for "{{account}}" showing a balance
```

Each pass paints the tail's lines again and gets its own band in the report,
labelled `Go to the next page (3/?)` while the loop is still running and
`(3/7)` once it has ended. A breakpoint on a section-body line fires on every
pass; a breakpoint on the guard pauses before the decision. A loop whose tail
is a plain instruction has no body line of its own, and a breakpoint on that
main-flow line pauses once per run.

What this costs: one model call per evaluation — unless every condition in it
is literal (§3.8), when the evaluation is free — so a chain costs one and a
`While` that runs three passes costs four. A tail that is a plain instruction
costs another call to perform it. That is why `If a cookie banner appears,
reject it` is still better as a watch (§3.4) — one call, no `then`.

Compiling (§10) removes both costs. The steps of a loop body compile once and
replay on every pass, and a condition that looks at the page compiles to a
`condition` entry that answers true or false in code — so a compiled `While`
costs nothing per pass. `Otherwise` and `For each` have nothing to compile;
their tails do.

**Hooks do not dispatch control lines.** A `## Hooks` entry — or an
`execution.defaultHooks` entry in `steptix.config.json` — that reads like one is
handed to the model as a single prose instruction, and the run warns that it
did; put the decision in a numbered step under `## Steps`, or in a `### Section`
the hook calls.

Running versions of all of it are shipped:
`templates/init/tests/control-flow.md` takes the `If` branch,
`control-flow-otherwise.md` falls through to the `Otherwise`, and both drive
`fixtures/test-app/control-flow.html`.

### 3.6 Leaving a flow early

A step that ends `then return` or `then stop` ends the flow it is in, as a
pass. The rest of a `### Section` body, the rest of a skill body, or the rest
of the test when the step is in the main flow. The steps it leaves behind are
marked skipped with a reason, and the run carries on after the flow that
ended. The condition is read the way an `If …` step's is: one that asks about
the page is judged against the live page, and one that only compares values a
step already captured is answered by the framework from those values, with no
model call (§3.8).

```markdown
### Sign in
1. If the page title contains "Dashboard" then return
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
```

The first call to `Sign in` finds the Sign In page, the condition fails, and
steps 2 to 5 run. The second call finds Dashboard, step 1 returns, steps 2 to
5 are skipped with the reason

```
Not run: step 7 returned from "Sign in" — If the page title contains "Dashboard" then return
```

and the caller continues at the step after the call. The call line passes both
times.

The number is the step's position in the **expanded** test — sections and
skills flattened into one list — which is what the report rows and the run log
count by, so a reason and a log line can be read side by side. It is not a line
you can find in the editor, which is why the returning step's own text comes
with it, clipped to 80 characters. That half you can search for anywhere.

In the main flow the same line ends the run as passed:

```markdown
4. If the page title contains "Dashboard" then stop running the remaining steps
5. Click "Sign out"
```

Step 5 is skipped, the `after` hooks still run, and the report reads 4 passed,
1 skipped. Nothing that did not run is counted as passed.

The details:

- `return` and `stop` mean the same thing, and either may be written bare or
  with one of six tails — `here`, `running the steps`, `running the rest of the
  steps`, `running the remaining steps`, `running the below steps`, `running
  the following steps`. So `then stop`, `then stop here` and `then stop running
  the remaining steps` are one instruction written three ways.
- A step whose **whole text** is the tail, with no `If`/`When` in front of it,
  is unconditional and costs no model call at all. `Return` is one; so is `Stop
  running the remaining steps`. It is the missing condition that makes it
  unconditional, not the shortness of the line.
- `If the Save button is visible, click it and return` is one compound step:
  the model clicks Save and then returns.
- `Return` inside a looped section ends that iteration; the next one starts.
  There is no way to break out of a loop. That holds for a `While`, a `Repeat`
  and a `For each` from §3.5 too: the loop asks its condition again, or moves
  to the next element.
- Inside the tail of a decision (§3.5), a return ends that tail. The run
  carries on after the whole chain — the branches that were not taken were
  already skipped by the decision itself and are not skipped twice.
- A flow-control line is never a chain member, so an `Else if` / `Otherwise`
  directly under one is refused. Nothing is lost: the steps below already run
  only when the return did not fire.
- A skipped step runs no hooks and spends no tokens. The returning step runs
  its `afterEach` hooks like any passed step.
- A hook may not return. There is no flow to leave from inside one, and the
  line is refused at parse.
- A conditional flow-control step compiles like any other: `steptix compile`
  writes an entry that reads the condition off the page and calls
  `step.exit()` when it holds, so the replay returns with no model call. The
  unconditional form is never compiled — it already costs nothing.
- Only a line that opens `If` or `When`, or a line that is nothing but the
  tail, is flow control. `Click the details link then return` is an ordinary
  step — after an action, "then return" reads as *navigate back*, and the
  framework does not guess. A typo (`then retun`) is not flow control either,
  but it does still have a ` then ` in it, so it is a decision (§3.5) whose
  tail is the prose "retun" — the tail fails loudly rather than the return
  quietly not happening, which is the direction to be wrong in.

### 3.7 Failing in your own words, and failing without stopping

A failure normally says what the framework found, and it always stops the run.
Three forms change that: two put your sentence on the failure, and the third
lets a failure pass through.

**Fail on a condition.** `fail` is the third verb of §3.6's grammar. The model
judges the condition against the live page the way it judges an `If … then
return`, and when it holds the step fails with your words.

```markdown
3. If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"
```

When the condition does not hold, nothing happens and the next step runs. When
it does, the run stops as it does on any failure, and the error on the row, in
the run log, in the Steptix hover and in the MCP summary is *The variable
value was peanuts. Expected apples* — not the framework's account of what it
compared.

**Rename a failure.** Any ordinary step takes an `otherwise fail … with message
"…"` tail, which renames the failure that step would have reported anyway.

```markdown
4. Verify the title contains "Account details" otherwise fail the test with message "Page did not contain account details"
```

That is an ordinary `Verify` with the ordinary retry policy. If it still fails,
the error becomes *Page did not contain account details* and what the model
actually compared moves into the row's explanation and the run log, where a
reader debugging the page can still find it. If the step passes, the tail did
nothing.

**Let a failure through.** `otherwise continue` tolerates a failure and the run
carries on with the next step.

```markdown
5. Dismiss the promo banner otherwise continue
6. Verify the footer shows the build number otherwise continue with warning "Footer build number missing"
```

The step runs as itself, with its usual retries. If it fails, the row says so —
amber rather than red — and the next step runs. A warning you wrote leads: it is
the first line of the Steptix hover, it opens the run log's `⚠ step 6 failed —
continuing:` line with the framework's own error bracketed after it, and it
reaches an MCP agent on the step's row. What actually went wrong is never
dropped; your sentence just goes first, because it is the one that says the
failure was expected. The run's status is not affected by it: a run whose only
failures were tolerated passes, and the header counts them apart, *7 passed, 1
tolerated*. Nothing that did not do its work is painted green; the row is a
failure you chose not to stop on.

**Fail with no condition at all.** A line that is nothing but the tail fails the
run where it stands, and costs no model call — the same exemption `Return` has.
It reads best as the last member of a decision (§3.5), and works on its own
inside a section body:

```markdown
5. If the balance is shown, then Check the balance
6. Otherwise fail the test with error "No balance was shown"
```

The grammar, reduced to what you have to know to write it:

- The optional words are `the` / `this` and `test` / `run`, so `fail`, `fail the
  test` and `fail this run` are one instruction written three ways. The message
  is introduced by `with error`, `with message`, `with reason` or a bare `with`,
  and either `"…"` or `'…'` quotes it. A message may hold the other kind of
  quote, never its own, and an unclosed quote makes the whole line prose.
- The condition is joined to `fail` by a comma, by `then`, or by `and`. It may
  also be joined by nothing but a space, and then the tail has to say more than
  the bare verb — `fail the test`, or `fail with error "…"`, or both: `If {{a}}
  is "peanuts" fail the test with error "…"` parses, `If {{a}} is "peanuts"
  fail` does not. That bare space is accepted for `fail` only, and only in
  front of such a tail, because a tail that long is not something a condition
  says by accident — where `If the page shows Save return` is, and so is `When
  I submit with bad data, the save should fail`, which is an expectation about
  the page rather than an instruction to end the run. Write the joiner and it
  is an instruction: `When I submit with bad data, then fail the test`.
- `otherwise` has to sit **between a body and an outcome** on one line. `or
  else` and `if it fails` are the same word; `carry on` and `keep going` are
  `continue`; `warn "…"` is `continue with warning "…"`. A message-less
  `otherwise fail` is legal and changes nothing — it is accepted so that
  `otherwise fail` and `otherwise fail the test with message "…"` are one
  grammar rather than two.
- `Otherwise …` at the **start** of a line is the decision's else from §3.5, not
  this. The two never collide: a tail needs a body in front of it on the same
  line, and a chain member has none.
- A tail followed by more prose is not a tail. `Verify the total otherwise
  continue to the next page` stays one ordinary step, and `Verify the total then
  fail the test` is prose — only a line opening `If` or `When`, or a line that is
  nothing but the tail, fails on a condition.

The details:

- A deliberate failure is not retried. You asked for it, and a retry would hand
  the model *this failed, try something else*, which is the one nudge that could
  turn a deliberate failure into a false pass. The CLI's AI failure diagnosis is
  skipped for the same reason: you have already written the cause, and a
  guessed paragraph above your sentence would only argue with it. Nothing
  presents it as a malfunction either — including a *compiled* one, which
  reaches the client out of the entry that `steptix compile` wrote and would
  otherwise be reported as broken code rather than as the line doing what it
  says.
- The model never sees an `otherwise` tail. It is handed the body and nothing
  else, so a model cannot reason "this step is optional" and answer *nothing to
  do*, or judge the check itself and fail it early. Everything else — the
  report's instruction line, the console line, the run log — shows the line you
  wrote. A `fail` **condition** is different: the model reads that whole line,
  because judging the condition is the job.
- The message is interpolated and masked. A `{{name}}` inside a message gets the
  same substitution every other part of the line gets — in a `fail` condition's
  `with error "…"` and in an `otherwise` tail's message alike — and a
  secret-looking value is masked on its way to the report, the wire and the log,
  so a `{{password}}` in a message cannot leak through it. Write no message and
  the framework words the error itself. (One corner: a value that itself
  contains the `"` that closes your message leaves a line that no longer parses,
  and the message then arrives as you typed it, placeholder and all.)
- A tolerated step is amber, never green, and counted on its own. It keeps
  `status: failed` in the report and on the wire — it did not do what it said —
  with a flag beside it saying the run continued, and the pass and fail counts
  both leave it out. Your warning travels beside that flag as a field of its
  own, so every client can lead with it; the framework's error stays where it
  was, under it.
- A tolerated step inside a loop keeps looping. `While`, `Repeat … until`, `For
  each` and a looped section all ask their next question as if the pass had
  finished, because it did. (This is not a `Continue` statement: it tolerates
  *this step's* failure, it does not skip to the next pass — §3.9.)
- A hook may `fail`, though it still may not `return`. A hook can already fail
  the run, so the verb adds a message and not a power; there is still no flow
  inside a hook to leave. A tolerated failure in a hook step does not abort the
  run either.
- A tail is read on prose steps only, and the four lines that do not take one
  each say so differently:
  - A `[tool: …]` or `[skill: …]` step is **refused by name** when you write a
    tail on it — *a [tool:] step does not take an "otherwise" tail* — because
    both have a grammar of their own that the tail is not threaded through, and
    a tail that was parsed and then ignored is worse than a refusal. For a
    skill, put the tail on a step inside the skill. For a tool there is nowhere
    to put it — wrapping the call in a section does not help, because the
    wrapper is matched by the exact text of the calling line and a tail on that
    line stops it calling the section (the `### Section` bullet below) — so write
    the check as a step after the call, or make the tool tolerate the failure
    itself.
  - A `Set {{name}} to "…"` step is refused too, and by the `Set` parser rather
    than by anything to do with tails: the line is a malformed `Set`, and the
    message names what is wrong with it — which of the parser's sentences you
    get depends on the tail you wrote. On the raw Sessions API path, where no
    parse-time validator runs, the line is simply not a `Set` — it is handed to
    a model as prose, with the tail applied to whatever the model makes of it,
    exactly as any other malformed `Set` is.
  - A `### Section` call is not refused, and this is the one to watch: writing
    `Sign in otherwise continue` under a `### Sign in` heading no longer matches
    that section at all, because a section call is matched by the **exact text**
    of the line. So the step stops calling the section and becomes an ordinary
    prose step — with a tail on it — handed to a model. Write the tail on a step
    *inside* the section instead.
- A line that asks for two endings at once — `If x then return otherwise
  continue` — is refused by name rather than resolved, at parse and again at
  run time on the raw API path.
- Both forms compile. `steptix compile` writes `step.fail('The variable value was
  peanuts. Expected apples')` for the conditional `fail`, and passes your
  message straight into the entry's `step.expect(…, 'Page did not contain
  account details')` for an `otherwise fail … with message` tail, so a replay
  fails in your words for no tokens. An `otherwise continue` tail compiles as
  its body; tolerating the failure is the runner's business, not the code's.
  The unconditional `Fail …` is never compiled, as `Return` is not — it already
  costs nothing.

`otherwise continue` is for a step that may legitimately fail. It is not the
way to express a step that should only sometimes run: for that, ask the
question — `If the promo banner is visible, then Dismiss the promo banner`
(§3.5), or the watch form of §3.4 — so the report says the step did not apply
rather than that it failed and was forgiven.

### 3.8 Reading a table into rows

A plural read (§3.2) gives you one column as a JSON array of strings. Three
columns written as three plural reads are three arrays with nothing holding
them together: one hidden row, one empty cell or one selector that matched
something slightly different, and the arrays no longer line up — the test then
checks Alice's order against Bob's status and passes. When a step wants more
than one column from the same rows, read the table itself:

```markdown
1. Read the Order ID column as id, Customer column as customer, and Status column as status from every row in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Check the order

### Check the order
1. Verify the Orders table has a row for "{{order.id}}" and customer "{{order.customer}}"
2. Verify the row for "{{order.id}}" shows "{{order.status}}"
```

`{{orders}}` holds one **record** per visible data row, and the loop binds the
whole record as `{{order}}` plus one `{{order.<alias>}}` per column the step
asked for. Alignment is the framework's: the columns are located by their
header text and every record is built from one row, so a release that reorders
the table changes nothing in the test, and a column the step did not name — the
select-all checkbox in the first cell, the Actions button in the last — is not
in the record at all.

**Grids whose header and rows are separate tables.** Telerik/Kendo,
DevExpress and Syncfusion render a scrollable grid as two `<table>` elements
inside one wrapper — the header row in the first, the data rows in the
second, and often a footer in a third. Name the grid the way you see it ("the
Holdings grid") and the framework reads the pair as one table: header names
work exactly as above, the footer is ignored, and `_row` numbers the data
rows. You do not have to switch to column positions because the rows carry no
`<th>`, and you should not point a read at the header table — it has no rows,
so that read is refused rather than quietly storing nothing. Telerik RadGrid
(the ASP.NET AJAX one) is the same thing in three tables — a header table, the
rows, and a pager table in one box — and reads the same way: name the grid, or
the table with the rows in it. A grid with frozen (locked) columns — two
header tables and two row tables, the columns split between the pairs — is
the one native shape no structural rule reads: each row is rendered twice,
split by column, so the wrapper, both header tables and the locked row table
are refused by name rather than half the record returned as the whole. That
refusal is about the shape, so it is one of the cases the structure question
below can settle: the model says which table holds the rows and where their
names are, and the read goes ahead on that half. Pinned columns in an ARIA
grid are a different thing and need no question at all — the two halves of a
row share a row index and the runtime joins them into one record (below).

**Headers of more than one row.** A grid widget's header is often a band row
over groups of columns, then the column names, then a row of filter boxes. Use
the name in the LOWEST heading over the column — `Amount`, not the `LOAN` band
above it — because that is what names the column; a band names a group and is
refused with the leaves under it listed, and a filter row names nothing at all
(its `All` is the state of a dropdown, not a heading). Where the same leaf name
sits under two bands — a `Fee` column under `Q1` and another under `Q2` — the
plain name is ambiguous and the read is refused with both positions, so write
the band with the leaf: `the "Q1 > Fee" column as q1_fee`.

**Quote a placeholder that can be empty — in a step.** An empty cell is
captured as the empty string, and the emptiness survives to somewhere it
matters. A `Verify` or `Assert` whose comparison is entirely between values —
nothing to read off the page — is checked as a **predicate**: the model
copies your sentence into the check as you wrote it, placeholders included,
and the framework substitutes them just before the check is generated. So
`Verify that {{payment.reference}} is empty` becomes `is empty`, a comparison
with nothing on its left, and the step fails on a check that was never the
question you asked. Written `Verify that "{{payment.reference}}" is empty` it
becomes `"" is empty`, which is. The two quote marks are what survive an
empty value; they cost nothing when it is not empty, so put them round any
captured value an assertion compares.

A **condition** — the part of an `If`, `Else if`, `While` or `Repeat … until`
line before its tail — usually needs no such care, because the model is not
what answers it. A condition that carries a `{{…}}` or `${…}` reference and is
otherwise a plain comparison (`is`, `equals`, `is not`, `is empty`, `is not
empty`, `contains`, `starts with`, `ends with`, `is at least`, `is more
than`…) is decided by the framework from the values: each reference is
substituted as a quoted literal, so `If {{payment.status}} is "Overdue"` and
`If {{payment.reference}} is empty` are answered as `"Overdue" is "Overdue"`
and `"" is empty` — with no model call and no page involved, quoted or not.
The guard's row in the report says `decided from the values: "" is empty →
true` in place of a judge's sentence. Equality there compares strings
exactly, which is what you want of the zero-padded ids and money strings a
table read yields: `"0012" is "12"` is false.

The five **orderings** — `is at least`, `is at most`, `is more than`, `is
greater than`, `is less than` — are the one family that is numeric, and they
are only decided here when both sides read as plain numbers once the quotes
are off, so `"5" is at least 10` is answered locally. A cell that is not a
plain number is exactly where that stops: `If "{{payment.amount}}" is more
than 100` over `$140.00`, or any comparison of dates, goes to the judge and
costs a model call, silently — sorting `$140.00` by character code would be
wrong quietly, and answering `false` would be worse. Nothing warns you. If
the ordering matters, capture the number without its currency symbol, or put
the arithmetic in a tool. A condition with prose in it —
`the Cash checkbox is ticked` — is about the page, and goes to the model **as
you authored it**, placeholders intact, with the resolved values listed
beside it (§1, §3.5).

**Aliases.** `… column as id` names the property, and an alias you write is
copied through exactly. It must look like a variable
(`[A-Za-z_][A-Za-z0-9_]*`), must be unique in the step, and cannot be `_row`;
the parser enforces all three and refuses the whole read otherwise.

Omit the alias and the key is derived from the header instead — `Order ID`
becomes `order_id`, `Last updated (UTC)` becomes `last_updated_utc`. That
derivation is a rule the **model** follows (trim, lower-case, replace each run
of non-letters/digits with `_`), not a function the framework runs over the
header text, so treat it as a reliable convention rather than a guarantee:
what the parser guarantees is that every column arrives with a key, that no
two columns share one, and that a step whose two headers would collide is
refused rather than resolved. Name the alias yourself whenever a later step
uses the field — it is shorter, it reads better at every use, and it is the
spelling you can be certain of. A positional column has no header to derive
anything from, so there the alias is required.

**Columns by position.** A table with no header row has nothing for a header
name to match, so name the position and supply the alias yourself:

```markdown
1. Read the 1st column as payee, the 3rd column as amount and the 5th column as status from every row in the Scheduled payments table [store as: payments]
```

"1st", "first", "column 1", "column 3" and "the second column" are the
spellings the model is told to read as a position; any of them, plus your own
alias, names a column without a header. Header and position can be mixed in
one step, but each column is one or the other, and a header name against a
headerless table fails with a message telling you to switch. Where a table
*does* have a header, use it: a header survives a reordering and a position
does not.

**`{{item._row}}`, the row number.** Every record carries `_row` without being
asked, the one-based position of its row among the table's data rows at the
moment of the read. It is what lets a later step point at the row again when no
value is unique — two rows for the same payee are ordinary in a payments table,
and "the row for Origin Energy" is ambiguous on both passes:

File `tests/payments-review.md`:

```markdown
# Review every scheduled payment

## Config
- baseUrl: http://localhost:8787/

## Steps
1. Navigate to scheduled-payments.html
2. Read the 1st column as payee, the 3rd column as amount and the 5th column as status from every row in the Scheduled payments table [store as: payments]
3. For each {{payment}} in {{payments}}, Review the payment
4. Verify the Scheduled payments table still shows 5 payments

### Review the payment
1. If {{payment.status}} is "Overdue", then return
2. Click View in row {{payment._row}} of the Scheduled payments table
3. Verify the Payment details page shows "{{payment.payee}}" and the amount {{payment.amount}}
4. Click Back to scheduled payments
```

A row number survives leaving the page and coming back, which no element
reference would. It is a position, not an identity: if the body of the table
deletes or moves rows, every row below the change has a different number from
that pass on — so for a table you change as you go, re-find by a value, or use
`Repeat … until` so each pass reads the page as it is now.

The read also leaves that numbering on the page: every data row of the table
it read carries `data-steptix-row="N"`, the same N as the record's `_row`, and a
later step's "row 7 of the …" resolves through that attribute rather than
through counting or an element id. You never write it — it is there so that
"row 7" means the seventh row of DATA and not the seventh `<tr>`, on a grid
whose own row ids happen to start at zero.

`_row` counts **data rows**: hidden rows and full-width message or group rows
are excluded and consume no number. The model is told to count the same way
when a step says "row 3", so on most tables the two agree — but one is a
number the framework computed at read time and the other is a model reading a
page snapshot, and on a table whose blocks are separated by group heading rows
that is a place for them to part company. Where the shape is awkward, verify
by value (`the row for "{{account.account}}" with balance
{{account.balance}}`) and keep the row number for pointing at a row whose
values are not unique.

**The first N rows.** For a smoke test that opens the first few and checks they
load, say so and let the framework bound the read:

```markdown
1. Read the Order ID column as id from the first 10 visible rows in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Click the Orders table row whose Order ID is "{{order.id}}"
```

The bound takes the first N of the rows the read would otherwise have
returned — page order, after hidden rows and message rows are dropped — so a
bounded row's `_row` is the number it would have had on an unbounded read.
Fewer rows than you asked for is not an error and not an assertion about the
count — if the test needs at least ten, verify that on its own line first.
There is no "rows 3 through 7", no last N and no "row N onward"; a test that
wants one row by position reads them all and uses `_row`. A bound is also
what makes a ONE-column read a record read: `Read the Order ID column as id
from the first 10 visible rows` stores records with `id` and `_row`, not a
flat list of ten strings.

**Empty tables, "No results" and "Loading…".** A table with no data rows stores
`[]` and the loop runs zero passes; if emptiness is the failure, verify the
table has at least one row on its own line. A body row whose single cell spans
the whole width is a **message**, not data: it is skipped, it consumes no row
number, and a body of nothing else reads as empty. That is deliberate, and it
has a trap in it — a "Loading…" row is such a message, so a read that lands on
one truthfully stores `[]` and the test goes wrong later, somewhere else. The
read does not wait; you do, on the line before it (§3.1).

**Grids with no `<table>` in them.** A MUI DataGrid, an ag-Grid and most of
what a modern component library calls a grid contain no `<table>`, `<tr>` or
`<td>` at all — they are `<div>`s carrying `role="grid"`, `role="row"`,
`role="columnheader"` and `role="gridcell"`, which is what makes them tables to
a screen reader. `role="table"` and `role="treegrid"` read the same way; a
`treegrid` reads flat, every rendered row a data row, with no notion of which
rows are under which. They are tables here too, and you write exactly the same
sentence for one as for a `<table>`: name the grid, name the columns by their
heading text, and `_row` numbers the data rows as always. Two things that look
like they should matter do not. `aria-rowindex` is *not* `_row` — it counts the
header, and a filter that hides rows does not renumber it — so
`row {{a._row}}` is still the position among the rows the read captured. And a
**pinned** (frozen) column is not a column that renders first: it is a second
`role="row"` element in another container holding that row's first cells, and
the runtime joins the two halves back into one record by their shared row
index. `table-aria-grid.md` is the worked example of both.

**When the shape defeats the rules, the model is asked once per run.** There is a long
tail no structural rule reads: headings written as `<td>` in the first body
row, a header table sitting *after* its rows, a list of repeated cards with no
rows or cells anywhere, one small key/value table per record. When a read fails
for a **shape** reason — no table or grid with rows under the selector, two or
more, or column names requested with no header found — the runtime shows the
model a sketch of that region, asks one question about how it is laid out,
validates the answer against the live page, and then reads deterministically.
You write the ordinary sentence and it works; what it costs is one model call
per run. A structure is asked about at most once per run per
table-and-columns, so a later step reading the same thing reuses the answer
(`readTable: structure reused from step 2` in the log). The answer is not kept
between runs: the next run of the file asks once again, and compiling the test
does not change that, because a table read is not compiled to code-behind. In
the run log the question is the line
`readTable: structure asked of the model — …`, with the sketch and the answer
beside it at debug level, and its absence on a repeat read is how you check the
remembering is doing its job. Nothing is taken on trust: a remembered mapping
is checked against the live page before a cell is read, and a page that has
changed falls back to asking again. Two things it deliberately is not: it is never asked
about *your* mistakes — a header you spelled wrong, a short row, a selector
matching several tables keep the refusals below — and it can be turned off
entirely with `tableStructure: strict` in the `## Config` block (or
`"tables": { "structure": "strict" }` in `steptix.config.json` for a whole
project), which makes the shape refusal stand as the step failure. Use it when
a run must never spend a model call nobody planned. `table-odd-shapes.md` is
the worked example.

**What is refused, loudly.** Each of these fails the step rather than
returning plausible data. Most of the messages name the table — by its
`aria-label` or `<caption>`, then the grid's name where the header and the
rows are separate tables, then its id, and failing all of those the selector
that matched it — and the two that cannot say `readTable found no table with
rows under "…"` and `readTable action … requests 24
columns — the maximum is 20`, which are about the selector and the step:

| The table | Why it is refused |
| --- | --- |
| A merged DATA cell (`rowspan`/`colspan` > 1 in a body row) | The logical grid would have to be guessed. Headers are not this case: a header of several rows — a band row over groups of columns, a filter row — is laid out, and each column takes the lowest heading over it. Two body rows are exceptions: the full-width message row above, and the detail row a grid inserts under a record you expanded. |
| Two columns with the same header, or a header you named that is absent from a header the table HAS | An ambiguous or missing match is never resolved by proximity; the message lists the headers the table does have. The structure question is never asked here: the shape was decided, and the name is yours. |
| A header name against a table with no header anywhere — no header row of its own, and none in a table beside it | The one missing-header case that is a *shape* reason, so it is where the structure question fires. With the question turned off, the refusal tells you to name the columns by position instead. |
| A selector matching more than one visible table, or none | Picking one of several would be the misalignment the action exists to prevent. Scope the selector — the structure question is not asked for this one either, since which element you meant is not something a sketch of it can answer. |
| No cell at a column's resolved position, in a row the read returned | Dropping the row or shifting the values is how misalignment happens. Checked on the rows the read returns, so a ragged row past your first-N bound is a row nobody asked for and does not fail anything. |
| More than 500 visible rows with no first-N bound | A silently truncated business table reads as a complete one. |
| More than 20 columns in one step | Read what the test checks. |
| A region holding both a `<table>` with rows and an ARIA grid with rows | Two things with rows under one selector: which one you meant cannot be guessed. Scope the selector, or let the structure question above name the one you meant. |
| A column read as a control's state (a checkbox's tick, an input's value) | Phase 2. Refused by name rather than storing the empty string such a cell renders as. |

**Not yet.** Reading a cell's *control* rather than its text — a checkbox's
ticked state, an input's value, a select's chosen option — is a later phase,
and a step that asks for it is refused by name rather than quietly storing the
empty string a control-only cell renders as. So are whole-table assertions
("every row is Scheduled", "no two rows share a reference", "the amounts add up
to $1,234.56"); until they land, a tool that takes `rows="{{payments}}"` does
the arithmetic, and a prose assertion over a long table is the thing to be
careful of — the page snapshot the model sees collapses repeated rows, so
"verify every row is Completed" checks the rows it can see.

And do **not** substitute the captured list into an assertion in the
meantime. `Assert that {{payments}} contains "Origin Energy"` — and `equals`,
`does not contain`, or any other predicate over the captured JSON — is not
the deterministic check it looks like. It is an ordinary AI step whose text
has had a long JSON literal pasted into it, and the model has to recognise
that as a self-contained predicate rather than something to go and check on
the page; in the acceptance runs it did so about half the time and otherwise
emitted a DOM assertion with no expectation, which fails. Until a real
`contains` over a list exists, loop over the records and check each against
the page — which is what the shipped acceptance tests do.

**Only the reads are dotted.** A property is something a record *has*, never
something a step *writes*: `[store as: orders]` and `Set {{summary}} to "…"`
name a variable and stay flat, `For each {{order}} in {{orders}}` names two
variables, and `{{order.address.city}}` is not a reference — one property
segment, and no deeper. A dotted name with no value fails the step before the
model is asked, and says which properties the record does have.

Running versions of all of it ship in `templates/init/tests/`: the twelve
`table-*.md` files tagged `table-read` cover headers and reordering
(`table-orders.md`), the first-N bound (`table-orders-limit.md`), positions,
duplicates and `_row` (`table-payments-review.md`), pagination
(`table-statements.md`), an empty body (`table-documents-empty.md`), the
awkward shapes (`table-structures.md`), a grid whose header and rows are
separate tables (`table-split-grids.md`), a Telerik RadGrid — three
tables in one box, a banded header with a filter row, and a pager
(`table-radgrid.md`), two grids with no `<table>` in them, one of them with a
pinned column (`table-aria-grid.md`), and the four shapes only the structure
question reads (`table-odd-shapes.md`). Each navigates straight to the page
it needs in the fixture app — `structured-orders.html` and
`structured-orders-many.html`, `scheduled-payments.html`, `statements.html`,
`documents.html`, `table-edge-cases.html`, `split-grids.html`,
`radgrid.html`, `aria-grid.html`, `odd-tables.html`.
`fixtures/test-app/tables.html`
indexes them all and is the page to open by hand when you want to see what a
test is reading.

### 3.9 What does not exist

- No selector language in prose beyond what the model infers. A test id can
  be mentioned when you know it exists.
- No arithmetic or string functions inside step text. `Set` concatenates text
  and `For each` loops over a list a step already captured (§3.5). A
  `[use ai]` step can ask the model to work a value out or make one up (§3.2),
  but it answers afresh on every run and is no calculator, so a value that
  must be exact, or the same every time, is a tool's job.
- No indexing and no deeper paths in a placeholder. A record from a table read
  exposes one property segment — `{{order.id}}`, `{{order._row}}` (§3.8) — and
  that is the whole grammar: `{{orders[1].id}}`, `{{order.address.city}}` and
  anything with a function in it are not references, and reach the model as the
  literal text you typed.
- No `Break`, no `Continue`, no pass counter readable as a variable, and no
  collecting captures across the passes of a loop. A body that must differ per
  pass reads the difference off the page or takes it from `For each`.
  (`{{item._row}}` is not a pass counter: it is the row number the read
  recorded, so a pass over a list that came from anywhere else does not have
  one. And the `otherwise continue` of §3.7 is not a loop `Continue`: it
  tolerates one step's failure, and the pass it is in runs on to its end.)
- No way to return from an outer flow by name, and no way to end the whole
  test from inside a section **as a pass** — a `return` leaves the innermost
  flow it is in (§3.6), and an iteration of a loop counts as one of those. A
  `fail` (§3.7) does end the run from wherever it is written, but as a failure,
  which is the asymmetry: stopping early because the work is done is a local
  decision, and stopping early because the work is wrong is not.
- No run-level "keep going after every failure" mode. `otherwise continue`
  tolerates the one step it is written on, and says so on that line; there is
  no switch that turns the whole run into a survey of everything that broke.
- No implicit variables. `baseUrl` from `## Config` is available to `[tool:]`
  arguments as a convenience, but `{{baseUrl}}` in a prose step is just the
  model reading the test information block. There is no built-in date, time
  or random value either — not even in a `[use ai]` step, whose model is told
  nothing the step does not say.
- No native OS dialogs, no drag-and-drop choreography, no file downloads, no
  visual-regression comparison as built-in vocabulary **in browser mode**. A
  native dialog is reachable by switching surface (§3.10); the rest want a
  tool.
- JavaScript `alert`/`confirm` dialogs are answered automatically by the
  framework (dismissed, and `beforeunload` accepted); you cannot script a
  choice.
- `Press Enter in the Search field` does not focus the field. Type into it in
  the same step first.
- No keyboard route to the BROWSER **in browser mode**. A key press is
  delivered to the focused element inside the page, so a back or refresh
  shortcut does nothing at all — and does it quietly, since the press itself
  succeeds and the step passes. Going back is its own action (`Go back`, §3);
  reloading has none yet, so navigate to the URL again. In computer mode
  (§3.10) a key press goes to whatever has OS focus, which is the whole point
  of that surface and also why it is not a substitute for `Go back`.
- A `prompt` for clarification is what the model does when a step is
  underspecified. On the CLI a person answers; on Steptix, MCP and CI the
  step is skipped or fails. Underspecified steps are therefore not portable.

### 3.10 Leaving the page: `[use computer]` and `[use browser]`

Some things a test must drive are not in any page: a PDF viewer's toolbar, a
print dialog, a native **Save As** window, a file picker, an installer. Two
whole-step directives switch which surface the steps after them run on.

```markdown
5. Click the Print button in the PDF viewer's toolbar
6. [use computer]
7. Click the Cancel button in the Print dialog
8. [use browser]
9. Verify the page URL ends with statement.pdf
```

From `[use computer]` on, every step is answered from **a screenshot of the
primary display and nothing else** — no DOM snapshot, no Playwright. The model
returns screen coordinates and an action; the framework performs it with a
real mouse move, a real click, real keystrokes. `[use browser]` goes back to
DOM snapshots and Playwright, on the same tab the test left. The browser is
not touched by the switch in either direction; while you are in computer mode
it is pixels on the screen like everything else.

Each directive is the **whole step**: a line that is nothing but the bracket,
with no sentence after it. `[use computer] and click Save` is a parse error,
not two steps. Re-entering the mode you are already in is a no-op, so a
section or skill may open with `[use computer]` defensively. A skill call
restores the caller's surface when it returns; an inline section does not —
which is how you write a desktop excursion once and call it by name.

A test whose **first** step is `[use computer]` never launches a browser at
all. That is also how a native application is tested with this framework.

**Steps that name a window.** Two phrasings are deterministic once the model
has turned your words into a title — no vision is involved, the framework asks
the OS for its window list:

- `Focus the window whose title contains "Save As"` brings it to the front.
- `Wait until a window titled "Save As" is open` / `… is gone` polls until it
  is so.

Everything else is ordinary prose about what you can see: `Click the Cancel
button in the Print dialog`, `Type "{{save_dir}}\report.pdf" into the File
name field`, `Press Ctrl+S`.

**What you must arrange yourself.**

- **The project has to opt in.** `desktop.enabled: true` in `steptix.config.json`,
  which defaults to `false`. A test file in a shared project must not be able
  to move the mouse on a machine whose owner did not allow it.
- **`[use computer]` does nothing to arrange the screen.** It changes what the
  model is shown and how its answer is performed, and nothing else. When a run
  starts from Steptix, VS Code is frontmost and the browser is behind it, so
  the first screenshot is a picture of the editor unless a step brings the
  window forward. Write that step — it is what `Focus the window whose title
  contains …` is for.
- **The desktop must be visible and unlocked, and you must not touch the
  mouse or the keyboard while it runs.** A stray click moves focus, and the
  next screenshot no longer shows what the model was answering about. A locked
  screen, a screensaver or a disconnected RDP session captures black.
- **One computer-mode run per machine.** Two would fight over the one mouse,
  so the framework takes a lock and refuses the second.
- **The server must be able to read the screen.** A server started by some
  sandboxed spawners can enumerate windows and still not capture — start it
  from a normal terminal or from VS Code.

**Captures are of the whole screen.** Not of the page: the model needs to see
the dialog, and the dialog is not in the page. Those images are embedded in
the report, which means the report can carry whatever else was on your desktop
— other windows, a file listing, a notification. Redaction cannot help here;
`src/utils/secrets.ts` masks text and there is no text to mask. Set
`desktop.reportScreenshots: false` to keep desktop captures out of the report
entirely. The same switch covers the MCP server: by default a failed
computer-mode step hands the agent a screenshot of the whole desktop, and with
the switch off it hands back none.

**What computer-mode steps do not get.** They are never compiled to
code-behind: a compiled selector is checked against the live DOM when it
replays, and a recorded coordinate has nothing to validate against — it would
replay blind on a machine whose resolution,
scaling or window layout has moved. A compiled step that ran in computer mode
stays AI-driven, and the compile report says so.

Worked examples:
[`templates/init/tests/pdf-dialog-cancel.md`](../templates/init/tests/pdf-dialog-cancel.md)
opens a print dialog from the fixture app's PDF and cancels it, and
[`templates/init/tests/calc-one-plus-one.md`](../templates/init/tests/calc-one-plus-one.md)
starts Calculator with a tool, types a sum, clicks the "=" button and reads
the answer, with no browser launched at all.

## 4. Variables and data

### 4.1 Where `{{name}}` values come from

`## Parameters`, the current data-table row (which overrides a same-named
parameter), captures from earlier steps, `Set` assignments, `[use ai]` values
(§3.2), tool and skill outputs, `[input:]` answers, and the bindings a
`For each` pass makes (§3.5, §3.8) all write into one variable map, and the
latest write wins. All values are strings; lists are JSON text.

A `[use ai]` step is the strictest reader of the map: a `{{name}}` or `${…}`
in it that the run cannot resolve fails the step before the model is asked,
in the words a `Set` uses — a literal `{{today}}` handed to a model is an
invitation to invent a date.

When a `{{name}}` is unresolved: the step text keeps the literal with a
warning, the `## Values` block lists it as "not yet captured", and if the model
uses it in any action field the whole turn is refused and the step fails. A
`Set` with an unresolved reference fails immediately. So a typo in a variable
name fails at the step that uses it, not silently later.

A dotted `{{item.property}}` is stricter, because it is new syntax with no
legacy meaning: a property nothing bound fails the step **before** the model is
called, naming the pass and listing the properties the record does have. It is
also the last write that survives, exactly as the item itself does — after the
loop, `{{order}}` and `{{order.id}}` still hold the final pass's row.

### 4.2 `Set`: build a value from values you already have

```markdown
# Compose a summary

## Parameters
- username: qa.user

## Steps
1. Set {{summary}} to "{{username}} signed in"
2. Set {{backup}} to "{{summary}}"
3. Set {{cleared}} to ""
4. Assert that "{{backup}}" contains "signed in"
```

The right-hand side is always one double-quoted string with no double quote
inside it and nothing after the closing quote. Every `{{name}}`, `${env.X}`
and `${data.x}` inside it is substituted; nothing is evaluated, so `"{{n}} +
1"` stores those characters. `Set the filter to Recent` names no variable and
is an ordinary AI step. Inside a skill, `Set` may target an `## Outputs` name
or a private name but never one of the skill's own parameters; inside a
looped section it may not target a column.

### 4.3 Environment values

Three mechanisms, which are easy to conflate:

| Syntax | Meaning |
| --- | --- |
| `- password: $TEST_PASSWORD` under `## Parameters` | The whole value is the name of an environment variable (from the shell, `.env`, or `.env.<name>`). Only whole-value `$NAME` is recognised; `$NAME` embedded in text is literal. |
| `${env.BASE_URL}` | A key from the selected environment's `.env.<name>` overlay. |
| `${data.users.admin.email}` | A path into `<dataDir>/<name>.json` for the selected environment. |
| `${catalog.products.0.name}` | A path into a JSON file registered under `dataSources` in frontmatter. |

`${…}` references need an environment selected: `--env staging` on the CLI,
the `AUTOMATION_ENV` variable, or `env: staging` in frontmatter. With no
environment selected they are never interpolated and reach the model as
literal text. With one selected, a reference into a known namespace that does
not exist fails at parse time with the file name; an undeclared namespace
passes through untouched. A missing `.env.<name>` file aborts the run; a
missing data file does not, and only the first `${data.…}` use then fails.

`dataSources` paths resolve relative to the test file (`~` and absolute
paths work); `dataFile` resolves relative to the project root. Reserved source
names are `env` and `data`. String leaves in any data JSON that look like
`$VAR` are themselves resolved from the environment, so secrets can stay in
`.env.<name>` while the JSON references them.

### 4.4 Secrets

**A name you chose** — a parameter, a `[store as:]` capture, a `${…}`
reference — is a secret when `password`, `secret`, `token` or `key` appears
anywhere in it, case insensitive. The value is masked as `***` in the console,
the report, the run log and the `## Values` block. The model never sees it;
the executor substitutes it when acting. Never write `***` as a value
yourself; the framework refuses an action containing it. If a non-secret name
is caught by the rule, list it under `unmask` in `## Config`. The hatch
governs what is shown *live* — the `## Values` block the model reads, and
Steptix's Variables view, Variables panel and skill re-run rows — and
deliberately nothing that is written to a file: the report, the run log and
the console line still star an unmasked name, so an `unmask` line can never
put a real credential into an artefact you send someone. Two smaller surfaces
still show the mask because no run is attached to ask: the `[input:]` echo and
the gutter hover. One caveat while it lasts: running from Steptix does not
send the list to the server at all, so `unmask` currently takes effect only on
the `steptix` CLI and the MCP tools
(`docs/specs/SPEC-structured-table-reads.md` §14).

**A name the page chose** is decided more narrowly. A table read's column
aliases and a tool's record keys are not your words, and a substring rule
there hides the wrong things: `keyword` and `sort_key` both contain `key`, and
a masked value is replaced *everywhere*, including in the page snapshot the
model plans its next action from — so a `sort_key` column masked by accident
can stop the next step finding the row. A record column is a secret when it
contains `password`, `passwd`, `pwd`, `secret`, `token`, `otp` or
`credential`/`credentials` as a whole word, or `key` with something that makes
it a credential in front: `api_key`, `apiKey`, `access_key`, `private_key`,
`auth_key`, `signing_key`, `encryption_key`. A camelCase hump counts as a word
break, so `apiKey` masks and `apikey` does not; plain `key`, `keys`,
`sort_key` and `keyword` are readable columns.

**A loop binding is where the two meet.** `{{user.password}}` is masked
because the column says so; `{{token.payee}}` because you called the record
`token`; `{{payment.sort_key}}` by neither, so it shows. Either half, or the
whole name read as one credential key — `api.key` is `api_key` with a dot in
it, and it is masked wherever it occurs. That last reading uses the *column*
rule, not the substring one, so `{{row.keyword}}` and `{{payment.sort_key}}`
stay readable.

**A dot does not by itself make a loop binding.** The three-part reading above
is for a name a `For each` pass bound — `{{payment}}` over a table read, where
the half before the dot is yours and the half after it is the page's. A dotted
name that no pass bound is yours end to end, and takes the plain author rule
**on the whole key**: a data-file column headed `user.apikey`, or a capture
written `[store as: api.key]`, is masked because `key` appears somewhere in
it, exactly as a flat `apikey` parameter would be. Nothing is read as a
column there, because no column is involved.

**A data row's cells and a step's `[store as:]` outputs are yours too**, by
that same whole-key author rule, and on every surface that shows them: the
Run Rows picker, the gutter hover and the Output banner as well as the report.
A `## Steps` data table headed `user.apikey` is a heading you typed.

Steptix reads it the same way, because the run tells it which names a pass
bound: every scope update carries that list, so a data-file `user.apikey` is
starred in the Variables view exactly as it is in the report, while a loop's
`{{payment.keyword}}` beside it stays readable. Against an older server that
sends no list, both views fall back to reading every dotted name as a loop
binding — so the only thing a version skew costs you is a `user.apikey` shown
in full in the panel while the report stars it.

**Length matters in exactly one place.** A value that a record column
contributes has to be at least four characters before the framework will hunt
for it in free text — a `token` column holding `-` and `7` would otherwise
turn every dash and every seven in every output into `***`. An entry masked by
its *name* has no such floor: it is hidden under its own name, where nothing
else can be caught by it, so a one-character `password` parameter or
`{{user.pwd}}` binding is still hidden.

**Where it applies.** The report, the run log, the console step line, the
`## Values` block and the DOM the model is shown — and, on the client side,
Steptix's Variables view and its Variables panel. Those two mask the same
way, and they also look *inside* a captured value: a `readTable` capture is a
whole table under one ordinary name (`{{payments}}`), and the record one pass
binds (`{{payment}}`) is one row of it, so no name rule could catch either.
They render with each secret column replaced and the other columns readable.

Keep real credentials in `.env` files, referenced as `$NAME` from
`## Parameters`, and never in generated Markdown.

### 4.5 Data-driven runs

A table as the first thing under `## Steps` runs the whole test once per row,
each row in a fresh browser (CDP attach is the exception, since it reuses one
browser). Column names become `{{variables}}` and override same-named
parameters.

File `tests/sign-in-matrix.md`:

```markdown
---
tags: [rows]
---

# Sign-in validation

## Config
- baseUrl: https://app.example.test

## Steps
| email                 | password    | outcome                                         |
|-----------------------|-------------|-------------------------------------------------|
| demo@securebank.com   | password123 | the Dashboard page is shown                     |
| demo@securebank.com   | wrongpass   | the "Invalid email or password" banner is shown |
| demo@securebank.com   |             | the "Invalid email or password" banner is shown |

1. Navigate to /login
2. Enter the email {{email}}
3. Enter the password {{password}}
4. Click the Sign in button
5. Verify {{outcome}}
```

Rules: headers are identifiers and unique, every row has every cell, at least
one data row, no `{{` inside a cell, no second table, no table together with
`dataFile`, and no table in a skill's own `## Steps`. Put the successful row
first: a compiled run records row one, and an empty cell in the recorded row
cannot stand in for the parameter.

Run one row with `steptix run tests/sign-in-matrix.md --row 2` (one-based). The
MCP `run_test_file` tool runs only the first row and says so in a warning.

`dataFile: data/cases.json` in frontmatter does the same from a JSON array of
row objects, or a CSV that is split on commas with no quoting.

To repeat only part of a test in the same session, put the table under a
`### Section` instead (§5).

## 5. Sections: reuse inside one file

A `### Name` heading under `## Steps` defines a block. A step whose entire
text is that name runs the block. The main flow is every numbered line before
the first `###`; once a `###` appears, every later numbered line belongs to a
section.

File `tests/search-products.md`:

```markdown
# Search two products

## Config
- baseUrl: https://app.example.test

## Parameters
- email: qa.user@example.test
- password: $TEST_PASSWORD

## Steps
1. Sign in
2. Search each product
3. Verify the Search field is visible
4. Sign out

### Sign in
1. Navigate to /login
2. Type "{{email}}" into the Email field
3. Type "{{password}}" into the Password field
4. Click Sign in and wait for the Dashboard heading

### Search each product
| query      | expected_product |
| ---------- | ---------------- |
| blue mug   | Blue mug         |
| green plate| Green plate      |

1. Type "{{query}}" into Search
2. Click Search and wait for the results to load
3. Verify a result named "{{expected_product}}" is visible

### Sign out
1. Click the account menu
2. Click Sign out and wait for the Sign in button
```

- Matching is on the trimmed text, case-insensitively, against the raw line:
  `search each product` calls it, `**Search each product**` and `Search each
  product.` do not. A `[skill:]`, `[tool:]`, `[input:]` or `[interactive]`
  line is never a section call.
- A table under a section heading loops the section body once per row in the
  same browser, page state preserved between rows.
- A section may be the tail of a control line (§3.5) — `If the Cash checkbox
  is ticked, then Pay with cash` — and that counts as a use, so a section only
  ever named in tails is live, not dead.
- Sections share the test's variables and have no parameters or outputs. A
  section may call other sections and skills. Cycles are refused.
- Names may contain spaces. `Steps`, `Config`, `Parameters`, `Outputs` and
  `Hooks` are reserved. An empty section that is called is an error.
- A `####` heading inside `## Steps` makes the numbered lines under it inert,
  with a warning.

## 6. Skills: reuse across files

A skill is a Markdown file under the project's `skills/` directory (the
`tests.skillsDir` setting) with its own parameters and outputs. It expands
inline before the run, so the report and the debugger show its steps as if
they were written in the caller.

File `skills/auth/sign_in.md`:

```markdown
---
type: skill
---

# sign_in

## Parameters
- login_url: absolute URL of the sign-in page
- email: account email
- password: account password

## Outputs
- display_name: the name shown in the account menu after signing in

## Steps
1. Navigate to {{login_url}}
2. Type "{{email}}" into the Email field
3. Type "{{password}}" into the Password field
4. Click Sign in and wait for the Dashboard heading
5. Read the name shown in the account menu [store as: display_name]
```

File `tests/greeting.md`:

```markdown
# Sign-in greeting

## Parameters
- login_url: https://app.example.test/login
- email: qa.user@example.test
- password: $TEST_PASSWORD
- expected_name: QA User

## Steps
1. [skill: auth/sign_in login_url email password out.display_name="signed_in_name"]
2. Assert that "{{signed_in_name}}" equals "{{expected_name}}"
3. [skill: auth/sign_in login_url email="second.user@example.test" password out.display_name="second_name"]
4. Assert that "{{second_name}}" is not "{{signed_in_name}}"
```

### 6.1 The skill file

- `type: skill` in frontmatter is what keeps the file out of `steptix run`'s test
  discovery and stops MCP running it as a test. Resolution does not depend on
  it, but always write it.
- The `# Title` is a display name; the call path selects the file.
- `## Parameters` bullets declare inputs. The text after the colon is a
  description for the editor's completion popup, **not a default**: every
  declared parameter must be supplied by the caller.
- `## Outputs` bullets declare what the caller receives. Capture or `Set` each
  one somewhere in the body, or the caller gets nothing.
- `## Config` and `## Hooks` in a skill are parsed and silently discarded. A
  data table under a skill's own `## Steps` is an error; a table under one of
  the skill's `### Section` headings loops that section as usual.
- A skill may define and call its own `### Section`s, may call other skills,
  and may carry its own `dataSources`, whose paths resolve relative to the
  skill file.

### 6.2 The call

`[skill: path/name arg… out.output…]`, one call per line, lowercase keyword.

| Form | Meaning |
| --- | --- |
| `auth/sign_in` | `<skillsDir>/auth/sign_in.md`. No `.md`, leading `/` optional, case must match the file on disk (Windows forgives it, Linux CI does not). |
| `email` | Shorthand for `email="{{email}}"`. |
| `email="qa@example.test"` | Literal string. Double quotes only; no escape for a quote inside. Spaces, `=` and `]` are fine inside. |
| `email="${data.users.admin.email}"` | Environment reference inside quotes. |
| `retries=3`, `strict=true` | Bare number or boolean. No exponent form, no other bare words. |
| `ids=["a","b"]` | Inline JSON array. |
| `out.display_name` | Receive the output under its declared name. |
| `out.display_name="signed_in_name"` | Receive it under another name. Needed when the same skill is called twice and both results must survive. |

Rules the expander enforces:

- A missing declared parameter is an error naming the skill and parameter. An
  undeclared extra argument is only a warning, and it still overwrites any
  `{{name}}` of that name in the body.
- `out.x` for an undeclared output is an error listing the declared ones.
- Everything the body captures that is not a declared output is renamed to a
  private `__skillN_x` and stays invisible to the caller. An unparameterised
  `{{foo}}` in a body therefore never reads the caller's `foo`; pass it as a
  parameter.
- `[skill: mfa]` written inside `skills/auth/sign_in.md` means
  `skills/mfa.md`, never `skills/auth/mfa.md`. Cycles are an error, and
  expansion is capped at depth 10.
- Arguments are separated by spaces, never commas. `email={{email}}` without
  quotes, `email='x'` and `email=x` are all parse errors with a message that
  says to quote the value.
- With the colon, a malformed call is a parse error that points at the
  problem. Without the colon (`[skill auth/sign_in …]` is also accepted) a
  malformed call silently becomes prose for the model. Write the colon.
- Text after the closing `]` is dropped; a second call on the same line is
  dropped too. A descriptive label before the bracket is allowed and inert.
- Upload paths inside a skill resolve against the **calling test file's**
  directory, not the skill's.

Skills can also be called from `## Hooks` lines, from section bodies, and from
a looped section with row values in the arguments.

## 7. Tools: deterministic code

A tool is a TypeScript function under `tools/src/` (the `tests.toolsDir`
setting) called with `[tool: name …]`. It runs in Node with the live
Playwright `page`, `context` and `browser`, reads and writes the test's
variables, and never involves a model. Use one for anything that is not a
page interaction, or that must be exact: seeding data through an API, fetching
a one-time code from a test inbox, parsing or arithmetic, polling, downloads,
drag-and-drop, and any branching or looping.

Prose never triggers a tool. The model is not shown a tool catalogue; only a
`[tool:]` line runs one.

### 7.1 Three ways to write one

**A bare function.** The file name is the tool name and the return value is
its single output, also named after the tool.

File `tools/src/uuid.ts`:

```ts
import crypto from 'node:crypto';

export default () => crypto.randomUUID();
```

```markdown
# Bare tool call

## Steps
1. [tool: uuid out.uuid="request_id"]
2. Set {{note}} to "request {{request_id}}"
```

**The `tool()` helper.** Same idea with typed, destructurable scope: caller
arguments arrive spread on the one argument beside `page`, `context`,
`browser`, `step`, `log` and `args`. Every argument arrives as a string.

File `tools/src/check_health.ts`:

```ts
import { tool } from 'steptix/tools';

export default tool(async ({ baseUrl, context }) => {
  const res = await context.request.get(`${baseUrl}/api/health`);
  return res.ok();
});
```

```markdown
# Health check

## Config
- baseUrl: https://app.example.test

## Steps
1. [tool: check_health baseUrl out.check_health="healthy"]
2. Assert that "{{healthy}}" equals "true"
```

`baseUrl` from `## Config` is available to tool arguments by name, so the
bare `baseUrl` shorthand works without a parameter.

Several tools can share a file as named exports; the export name is the tool
name and the call must be path-qualified:

File `tools/src/strings.ts`:

```ts
import { tool } from 'steptix/tools';

export const slugify = tool<{ s: string }>(({ s }) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
);

export const upper = tool<{ s: string }>(({ s }) => s.toUpperCase());
```

```markdown
# Named-export tools

## Steps
1. [tool: strings/slugify s="Hello World" out.slugify="slug"]
2. [tool: strings/upper s="{{slug}}" out.upper="shout"]
3. Assert that "{{shout}}" equals "HELLO-WORLD"
```

`[tool: slugify …]` without the file prefix does not resolve.

**`defineTool`.** Use it for typed parameters with defaults, several outputs,
validation, and a description in the report.

File `tools/src/extract_order_ids.ts`:

```ts
import { defineTool } from 'steptix/tools';

export default defineTool({
  name: 'extract_order_ids',
  description: 'Return the ids of recent orders from the orders API.',
  parameters: {
    baseUrl: { type: 'string', description: 'Origin of the app under test' },
    sinceDays: { type: 'number', default: 30 },
    status: { type: 'string', default: '', description: 'Optional status filter' },
  },
  outputs: {
    order_ids: { type: 'string[]' },
    order_count: { type: 'number' },
  },
  async run({ baseUrl, sinceDays, status }, { context, step, log }) {
    const params = new URLSearchParams({ sinceDays: String(sinceDays) });
    if (status) params.set('status', status);
    const url = `${baseUrl.replace(/\/$/, '')}/api/orders?${params}`;
    log.info(`GET ${url}`);
    const res = await context.request.get(url);
    step.expect(res.ok(), `GET /api/orders returned ${res.status()}`);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((o) => o.id);
    step.setVar('order_ids', ids);
    step.setVar('order_count', ids.length);
  },
});
```

File `tools/src/visit_each.ts`:

```ts
import { defineTool } from 'steptix/tools';

export default defineTool({
  name: 'visit_each',
  description: 'Visit every URL in order and capture each page title.',
  parameters: {
    urls: { type: 'string[]' },
  },
  outputs: {
    titles: { type: 'string[]' },
  },
  async run({ urls }, { page, step }) {
    const titles: string[] = [];
    for (const url of urls) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      titles.push(await page.title());
    }
    step.setVar('titles', titles);
  },
});
```

```markdown
# Orders round trip

## Config
- baseUrl: https://app.example.test

## Steps
1. [tool: extract_order_ids baseUrl status="failed" out.order_ids out.order_count]
2. Assert that {{order_count}} is greater than 0
3. Read the href of every order link in the Orders table [store as: order_links]
4. [tool: visit_each urls="{{order_links}}" out.titles="page_titles"]
```

### 7.2 What the code can use

| In scope | Type | Notes |
| --- | --- | --- |
| `page` | Playwright `Page` | The active tab when the step starts (§7.4). Actions persist for later steps. |
| `context` | `BrowserContext` | Cookies, storage, `context.request` for HTTP calls that share the page's cookies. |
| `browser` | `Browser` | For a fresh incognito context. |
| `step.getVar(name)` | `string \| undefined` | Any test variable. |
| `step.setVar(name, value)` | | Only a declared output name. Arrays are JSON-encoded. |
| `step.expect(cond, message)` | | Throws `message` when `cond` is false; the step fails. |
| `log.info/warn/error` | | Lines land in the HTML report. |
| `args` | `Record<string, unknown>` | The full argument bag (bare function and `tool()` only). |

Not available: calling another tool, a skill or an AI step; the `tabs` and
`browsers` helpers, which belong to compiled code-behind; any retry. A thrown
error or a false `expect` fails the step once, with the message in the report.
Which tab and browser a tool lands in, and how to steer it, is §7.4.

`defineTool` parameters are `string`, `number`, `boolean` or `string[]`,
`number[]`, `boolean[]`. A parameter without `default` is required; an unknown
argument to a `defineTool` tool is an error; `"30"` coerces to a number and a
JSON-array variable decodes into a typed array. `run`'s return value is
ignored; outputs are published only through `step.setVar`. A bare function
that returns an object stores it JSON-encoded, and one that returns
`undefined` stores nothing.

### 7.3 Resolution and setup

- `[tool: uuid]` is `tools/src/uuid.ts`, default export. `[tool: strings/upper]`
  is the `upper` export of `tools/src/strings.ts`. `[tool: auth/login/login]`
  is the tool named `login` in `tools/src/auth/login.ts`. The last path
  segment is the tool's registered name, which for `defineTool` is its
  `name` field and for the others the file or export name.
- `.ts`, `.mts`, `.js` and `.mjs` files are indexed recursively; `.d.ts`,
  `*.test.*`, `node_modules` and dot-directories are skipped. Names and paths
  are case-sensitive. A leading `/` is refused.
- Any exported function in a tool file becomes a tool. Keep helpers unexported.
- A broken tool file only fails the steps that reference it. The failure
  message names the scanned directory and the tools it found.
- The tools directory is its own small Node project: a `package.json` with
  `"type": "module"` and dev dependencies on `steptix`, `playwright`
  and `typescript`, plus a `tsconfig.json`. The README's "One-time setup"
  section has both files. The long-running server reloads a tool when its
  file changes; the CLI loads once per run.

Tool calls use the same argument grammar as skill calls (§6.2). Objects
(`key={…}`) are not accepted; pass a JSON array or a variable.

### 7.4 Which tab and browser the tool runs in

`page`, `context` and `browser` are resolved when the tool step starts, from
the same active pointers the model's own actions use. A tool always gets
whatever the last tab or browser step left active — it cannot ask for a
different one, and no argument selects a page.

That makes the ordering the whole mechanism. A tab the test opens itself is
promoted on the spot, so a tool on the next step is already there:

```markdown
# Order titles without leaving the list

## Config
- baseUrl: https://app.example.test

## Steps
1. Navigate to /orders
2. Read the href of every order link in the Orders table [store as: order_links]
3. Open https://app.example.test/blank in a new tab and remember it as scratch
4. [tool: visit_each urls="{{order_links}}" out.titles="order_titles"]
5. Switch back to the main tab
6. Verify the Orders table is still visible
```

`visit_each` navigates the tab it is handed, which is why step 3 exists: the
scratch tab absorbs the navigation and the Orders list survives it. Step 5 is
not optional either — the promotion in step 3 holds until something moves it,
so without that line every later step is on the scratch tab.

A tab the **application** opens — `window.open`, `target="_blank"`, a popup —
is tracked and labelled but does not become active. A tool placed straight
after the click reads the old tab and passes on the wrong page, which is a
green failure rather than a loud one. Switch first, and in its own step: a
`[tool:]` line takes a leading label but no second instruction, so the switch
cannot ride along with it.

```markdown
# Report opened in a popup

## Config
- baseUrl: https://app.example.test

## Steps
1. Navigate to /reports
2. Click "Open report" and switch to the tab it opened
3. Read the href of every download link on the report [store as: report_links]
4. [tool: visit_each urls="{{report_links}}" out.titles="report_titles"]
5. Close the tab showing "Report"
```

Name a tab with `remember it as …` whenever more than one is open. A switch
matches an exact label first, then a URL substring, then a title substring,
all case-insensitively — so `Switch to the /accounts tab` also matches
`/accounts-archive`, and two tabs both titled "Orders" resolve by whichever
URL happens to hit first. A label is exact on the first pass and survives a
retitle:

```markdown
# Two regions, one tool

## Config
- baseUrl: https://app.example.test

## Steps
1. Open https://app.example.test/eu in a new tab and remember it as eu
2. Open https://app.example.test/us in a new tab and remember it as us
3. Switch to the eu tab
4. Read the href of every product link [store as: eu_links]
5. [tool: visit_each urls="{{eu_links}}" out.titles="eu_titles"]
6. Switch to the us tab
7. Read the href of every product link [store as: us_links]
8. [tool: visit_each urls="{{us_links}}" out.titles="us_titles"]
```

The `out.` aliases are what keep the two results apart; without them the
second call overwrites the first.

A second browser works the same way and moves more than the page: the tool
also gets that browser's `context`, so a `context.request` call carries the
second session's cookies rather than the first's.

```markdown
# Reviewer queue

## Config
- baseUrl: https://app.example.test

## Parameters
- admin_user: reviewer.admin@example.test
- reviewer_user: second.reviewer@example.test

## Steps
1. Navigate to /queue and sign in as {{admin_user}}
2. Open a second browser as reviewer
3. Navigate to /queue and sign in as {{reviewer_user}}
4. [tool: extract_order_ids baseUrl out.order_ids="review_ids"]
5. Switch back to the default browser
```

A tool cannot move the pointer itself. `context.newPage()` inside tool code
opens a real tab and the framework tracks it, but it does not become active,
later steps stay where they were, and the report marks it as a tab the test
did not open. Own the tab from the steps, not from the code.

## 8. Hooks

`## Hooks` before `## Steps` gives the CLI runner setup and teardown lines:

```markdown
# Orders with hooks

## Config
- baseUrl: https://app.example.test

## Hooks
- before: Navigate to /login
- beforeEach: If a session warning toast is visible, close it
- afterEach: Verify no fatal error overlay is visible
- after: Sign out if the account menu is available

## Steps
1. Navigate to /orders
2. [no-hooks] Verify the Orders heading is visible
3. Verify the Orders table has at least one row
```

`before` runs once, `beforeEach` and `afterEach` wrap every step, `after` runs
once at the end. Hooks may call tools and skills. A failing `after` is logged
and does not change the result, but a failing `afterEach` **aborts the test**,
so keep `afterEach` to checks you mean as hard requirements. `[no-hooks]` on a
step skips the two per-step hooks for it; on a section or skill call it covers
the whole expanded body.

Hooks exist only on the CLI file runner. Steptix, the Sessions API and the
MCP server drop them without a warning, so anything a test needs in order to
pass belongs in `## Steps`.

## 9. Context files and API steps

Files under `context/` (the `tests.contextDir` setting) are sent to the model
verbatim on every step. Put there what a new tester would need: page names and
paths, field labels, where errors appear, the cookie banner's wording, timing
quirks, and anything that repeats across tests. Keep it factual and short; it
is prompt text on every step.

For API steps, a context file that contains a `Type:` line (for example
`Type: Front Proxy`) switches on the executor's API guidance. Then a step like
`Send a GET request to https://api.example.test/orders/{{order_id}} using the
current browser session` performs the call, `browser` mode sharing the page's
cookies and `standalone` mode using plain fetch, and a following `Verify the
previous API response has status 200 and its order status is Shipped` checks
it. Values pulled from a response by the model are logged but **not** stored
as variables. When a later step needs a value from an API response, write a
tool that calls the API and sets a declared output.

## 10. Running and validating

```bash
npx steptix list
npx steptix run tests/login.md
npx steptix run tests/ --tag smoke --headless
npx steptix run tests/login.md --env staging
npx steptix run tests/sign-in-matrix.md --row 2
npx steptix compile tests/login.md --env staging
```

`run` also takes `--timeout <ms>`, `--browser <engine>`, `--bail`,
`--verbose`, `-c <config>`, and `--fail-on-healed`, which fails CI when
compiled code had to be repaired by the model. `compile` records a run and
writes a `.steps.ts` beside the test so future runs replay eligible steps as
code with no tokens; the Markdown stays the authored test and steps that the
compiler declines stay AI-driven.

Compiled code is fast — a step that took seconds of model time runs in
milliseconds — so it has to wait for what it causes. A compiled step that acts
on the page (a click, a fill, a navigation, a helper of its own) is followed by
a wait for what its action started: the requests it began on the app's own
site, a login and the navigation it triggers included, then the page holding
still, for up to 10 s. Polls, WebSockets, analytics and other sites' requests
are not waited for. Inside an entry, `await step.settle()` is that same wait,
for code that reads or asserts after its own action:

```ts
{
  source: 'Click the Sign in button',
  async run({ page, step }) {
    await page.locator('#sign-in-btn').click();
    await step.settle();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  },
},
```

`step.settle()` names no URL, so one entry is right for a data row whose
sign-in navigates and one whose sign-in only shows an error. A compiled `If …
then return` waits for the page before it reads it, as the AI's judgement does.

A compiled read keeps the selector the AI read with. When the compile's code
reads with a different one — even one that looks more stable — it is asked to
fix it once, and if it still differs the step is left without code: it stays
AI, which reads what the run read, and the next compile tries again.

A step that only reads or counts is not given to a model at all. When the AI
ran it, it chose a `read` or `count` action and Steptix carried it out, so the
compile writes that action into the entry:

```ts
{
  source: 'Read the name of every account in the Your accounts panel [store as: accounts]',
  fromRecording: true,
  async run({ step }) {
    await step.read({
      selector: '#account-list [data-testid="account-row"] > span > span:first-child',
      multiple: true,
      as: 'accounts',
      kinds: ['span.account-name'],
    });
  },
},
```

`step.read` and `step.count` run the AI's own action again — the same selector
cleaning, frame handling and reader — and store the result the same way, so on
the same page they store what the run stored. A count or a read of every match
first waits until the number of matches stops changing. `kinds` lists the kinds
of element the run read; a read that matches any other kind fails its
self-check (below), and an empty result passes. The read written is the one
the model stood by: when a list came back empty or mixed and the model read it
again (§3.2), only the second read is compiled. A read that came back empty is
never compiled, because on a page with no items every selector matches
nothing, so the read says nothing about its own; nor is a list the model never
saw. Such a step gets no entry, is listed as not attempted, and compiles from
a later run where the list has items. A step whose list is always empty — a
count of error messages that should stay 0 — therefore stays under AI. Steps
that share one entry, such as the rows of a `### Section` table, compile from
the row whose list had items, so an empty first row does not hold the entry
back. A data-driven test compiles from its first data row only, so put a row
whose list has items first. When such a step already had an entry that broke,
the compile leaves that entry as it is and its replay runs the step under AI,
so the steps after it are still proven. Review leaves an entry marked
`fromRecording: true` alone. A step that also acts — a click, then a read —
still goes to the model, which does its read with `step.read` and the recorded
fields; so does a read whose recorded selector held a parameter's value.

When the model writes a read, it checks its own read with
`step.check(condition, message)` rather than `step.expect`:

```ts
{
  source: 'Read the balance of the {{account}} account [store as: balance]',
  async run({ page, step }) {
    const account = step.getVar('account') ?? '';
    const balances = await page
      .locator('#account-list [data-testid="account-row"]')
      .filter({ hasText: account })
      .locator('.account-balance')
      .allTextContents();
    step.check(balances.length === 1, `one row for ${account} (${balances.length} found)`);
    step.setVar('balance', balances[0].trim());
  },
},
```

When a self-check fails, what is wrong is the code, not the application, so it
is handled like an entry that throws: the step re-runs under AI and shows ⚠
with "Self-check failed: …", and the next compile regenerates the entry. In an
entry that acts, `step.check` fails the step as `step.expect` does, because a
re-run after a click would click twice. Use `step.expect` for what the step
itself states ("Verify the total is $4.00"): that is a real failure.

A file that decides and loops (§3.5) compiles too. Each line of a loop body
gets ONE entry, generated from the first pass that ran it and replayed on
every pass; a value that changes per pass (a `For each` item, `{{order.id}}`)
is read with `step.getVar`, never written into the code. An `If`, `Else if`,
`While` or `Repeat … until` line whose condition looks at the page gets an
entry with a `condition` function instead of `run`:

```ts
{
  source: 'While the Next button is enabled, Go to the next page',
  async condition({ page }) {
    const next = page.getByRole('button', { name: 'Next' });
    return (await next.count()) > 0 && (await next.isEnabled());
  },
},
```

It answers whether the condition as written holds right now — for `Repeat …
until` that is the `until` part — and it only reads the page. A run decides a
condition from its values first, then from its entry, then with the model; a
chain is decided in code only when every member has an answer without the
model. An entry that throws, or whose `step.check` fails, is flagged ⚠ and the
model decides for the rest of the run. A compiled loop that reaches its cap asks the model once whether the
condition really still holds, so an entry that never says stop is caught
rather than trusted. `steptix compile` also compares each loop's passes on its
replay with the recording's, and prints a `Warning:` — naming the step that
captured a `For each`'s list — when they differ; check that step's selector,
unless the list really changed between the two runs.

Interactive markers, for a person at the keyboard only:

- `[input: otp_code] Enter the code sent to your phone` pauses for a typed
  value and stores it as `{{otp_code}}`.
- `[interactive] Explore the dashboard` opens a REPL of ad-hoc steps.

Away from the CLI's terminal (Steptix, MCP, CI) both are reported as
skipped, and a skipped step counts as not run. Do not put them in unattended
tests.

A test that uses `[use computer]` (§3.10) is unattended in a different sense:
nobody types, but somebody has to leave the machine alone. It needs a visible,
unlocked desktop, `desktop.enabled: true` in the project's config, and the
mouse untouched for the length of the run, and only one such test can run on a
machine at a time. That last constraint is why they are kept out of parallel
suites rather than sharded with everything else.

When the authoring AI has the framework's MCP server, `list_test_files`,
`run_test_file`, `run_steps` (exploratory steps that keep a session's browser
state), `get_page_content` (to read real labels before writing steps),
`get_last_run`, `peek_tab`, `navigate_tab`, `log_into_site`, and the CDP
browser tools are available. Limits that affect how green a result really is:
`run_test_file` runs only the first table row, ignores `dataFile` rows,
executes no hooks, and skips `[input:]` and `[interactive]` steps. Validate
the whole file with the CLI or Steptix when those matter.

A test is "written" when it parses, "checked" when every step ran green
against the real application, and only the second is evidence. Read the
report's skipped steps and warnings, not just the summary.

## 11. Anti-patterns and their fixes

| Do not write | Write instead | Why |
| --- | --- | --- |
| `Log in and go to the orders page and check the total` | Three steps | The model stops at one instruction; one line of three intents runs the first. |
| `Click Save` when two Save buttons exist | `Click Save in the Shipping address dialog` | Positional picks are forbidden; scope decides. |
| `Click Submit` then `Verify it worked` | `Click Submit and wait for the Order placed message`, then verify a value | "Worked" is not checkable; a named message or value is. |
| `Note the order number` | `Read the order number [store as: order_id]` | Nothing is stored without a name. |
| `Read the order number [as: order_id]` | `[store as: order_id]` | `[as:]` has no parser and is renamed wrongly inside skills. |
| `Set {{total}} to "{{a}} + {{b}}"` | A `defineTool` with number parameters | `Set` is text only. |
| `Make up a customer name and remember it` | `[use ai] Make up a customer name [store as: customer]` | A plain step goes to the page model, whose only way to store anything is to read it off the page. |
| `[use ai] Give the date 3 days from today as yyyymmdd [store as: due]` | `[use ai] Today is {{today}}. Give the date 3 days later as yyyymmdd [store as: due]` | The model sees the step text and nothing else — no date. |
| `[use ai] Write a paragraph about Australia` | `…and store it in text`, or add `[store as: text]` | A name the step never says fails the step; no later step can rely on it. |
| `Write a paragraph [use ai] [store as: text]` | `[use ai] Write a paragraph [store as: text]` | `[use ai]` opens the step; anywhere else is a parse error. |
| `[use ai] Pick a random order number` where the number must repeat | A tool | The model is asked on every run and may or may not answer the same. |
| `If the Cash checkbox is ticked, run the Pay with cash section` | `If the Cash checkbox is ticked, then Pay with cash` | Without `then` the line is a watch, and the section name in it is prose. |
| `If the total is more than $100 then apply the discount, then Verify it` | Reword the condition | The **first** ` then ` ends the condition. |
| `For each {{account}} in {{names}}` where `names` came from a `Set` | Capture it with a plural read | `For each` takes a JSON array, and no delimiter is guessed. |
| Three plural reads for the ID, customer and status columns | One table read (§3.8) | Three arrays lose their alignment on one hidden row or empty cell, and the test then passes against the wrong row. |
| `Click Approve in the row for "{{payment.payee}}"` on a table with two rows for that payee | `Click Approve in row {{payment._row}}` | A value that is not unique names two rows; the row number names one. |
| `Verify that {{payment.reference}} is empty` | `Verify that "{{payment.reference}}" is empty` | A value-only assertion is checked as a predicate, substituted just before the check is generated — so an empty value leaves `is empty` with nothing on its left. Conditions are exempt: the framework decides those from the values, quotes or not (§3.8). |
| `Press Enter in the Search field` | `Type "shoes" into the Search field and press Enter` | The key press targets nothing. |
| `[skill: sign_in]` when the skill declares `email` | `[skill: sign_in email password]` | Every declared parameter is required. |
| `[tool: slugify s="x"]` for a named export | `[tool: strings/slugify s="x"]` | Named exports need the file prefix. |
| `[tool: visit_each urls={{links}}]` | `urls="{{links}}"` | Unquoted templates are a parse error. |
| `[use computer] Click Cancel` | `[use computer]`, then `Click Cancel` | The directive is the whole step; trailing text is a parse error (§3.10). |
| `[computer]`, `[use the computer]`, `[computer-use]` | `[use computer]` | A step that is nothing but an unknown bracket is refused by name, so none of these reaches a model as prose. |
| `[use computer]` with no step bringing the window forward | Add `Focus the window whose title contains "…"` | Switching surface arranges nothing; the first screenshot is whatever was frontmost (§3.10). |
| `[tool: a] [tool: b]` on one line | Two lines | Only one call per line survives. |
| A popup-opening click, then `[tool: …]` | Add `and switch to the tab it opened` to the click | A tab the app opens is tracked but not active; the tool reads the old page and passes. |
| `password: hunter2` under `## Parameters` | `password: $TEST_PASSWORD` | Secrets live in `.env`, and the name alone triggers masking. |
| `[input: otp]` in a CI test | A tool that fetches the code from the test inbox | Input steps are skipped unattended. |
| `## Steps (login)` | `## Steps` | Any other heading yields no steps. |
| `Wait for .spinner:hidden` | `Wait until the spinner disappears` | State belongs in words, not selectors. |
| A section body's steps before the main flow ends | Main flow first, then `###` headings | Everything after the first `###` belongs to a section. |
| `If we are signed in then skip ahead` | `If we are signed in then return` | Only `return` / `stop` (and the six endings §3.6 lists) end a flow, and only `fail …` (§3.7) ends the run in your own words. Anything else after ` then ` is a decision, and a tail that names no `### Section` and no `[skill:]` is prose, so "skip ahead" is handed to a model as an instruction — the same way `then retun` is (§3.6). |
| `beforeEach: If already signed in then return` | Put the line in `## Steps` | A hook has no flow to leave; the file is refused at parse. |

## 12. Checklist before handing a test over

- Title, `## Steps` spelled exactly, one instruction per physical line.
- Every `{{name}}` is supplied by a parameter, a row, a capture with
  `[store as:]`, a `Set`, a `[use ai]` step that names it, or a skill or tool
  output that runs first.
- Every `[use ai]` step carries in its own text everything the model needs —
  the date included — and none of them is a value that must repeat run to run.
- Every `${…}` reference has an environment that defines it, and the test says
  which (`env:` in frontmatter or a documented `--env`).
- Every skill call passes every declared parameter and aliases outputs that
  must survive a second call; every tool call names an existing file and
  declared outputs.
- Every action has a named completion condition where the page is slow, and
  every business outcome has a `Verify` line that could fail.
- Every `While` or `Repeat … until` has an exit the page actually reaches; any
  `, up to N times` is a bug net you meant, not the way the loop ends.
- Every `{{item.property}}` is a column its table read named, or `_row`, and
  every placeholder that can be empty is quoted where it is compared.
- No `[input:]`, `[interactive]`, or underspecified step in an unattended test.
- Upload fixtures exist at the paths written, relative to the test file.
- The report from a real run has no skipped steps and no warnings you have not
  read.

## 13. Where to check when the framework changes

| Topic | Source |
| --- | --- |
| Headings, frontmatter, steps, sections, tables | [markdown.ts](../src/parser/markdown.ts), [frontmatter.ts](../src/parser/frontmatter.ts), [data-rows.ts](../src/parser/data-rows.ts), [section-match.ts](../src/parser/section-match.ts), [step-lines.ts](../runner-core/src/step-lines.ts) |
| `## Config` keys and viewport | [types.ts](../src/parser/types.ts), [viewport.ts](../src/config/viewport.ts) |
| Parameters, `$VAR`, `Set`, `${…}`, secrets | [parameters.ts](../src/parser/parameters.ts), [set-step.ts](../src/parser/set-step.ts), [interpolate-env-data.ts](../src/parser/interpolate-env-data.ts), [secrets.ts](../src/utils/secrets.ts) |
| What the model sees and the action rules | [prompts.ts](../src/ai/prompts.ts), [types.ts](../src/ai/types.ts), [placeholder-substitution.ts](../src/runner/placeholder-substitution.ts) |
| Action execution, waits, reads, uploads | [actions.ts](../src/browser/actions.ts), [step-executor.ts](../src/runner/step-executor.ts), [upload-paths.ts](../src/browser/upload-paths.ts) |
| Watches, decisions, loops and hooks | [step-grouper.ts](../src/runner/step-grouper.ts), [control-line.ts](../src/parser/control-line.ts), [control-flow.ts](../src/runner/control-flow.ts), [hooks.ts](../src/runner/hooks.ts), [test-runner.ts](../src/runner/test-runner.ts) |
| Table reads, records and `{{item.property}}` | [SPEC-structured-table-reads.md](specs/SPEC-structured-table-reads.md), [actions.ts](../src/browser/actions.ts) (the extractor), [parameters.ts](../src/parser/parameters.ts) (the one placeholder grammar), [control-flow.ts](../src/runner/control-flow.ts) (the pass bindings) |
| `return` / `stop`, and which steps a return skips | [flow-control-step.ts](../src/parser/flow-control-step.ts), [flow-control.ts](../src/runner/flow-control.ts), [control-flow.ts](../src/runner/control-flow.ts) (`returnExit`), [test-runner.ts](../src/runner/test-runner.ts) |
| `fail`, and the `otherwise` tails | [flow-control-step.ts](../src/parser/flow-control-step.ts) (the `fail` verb and its message), [failure-tail.ts](../src/parser/failure-tail.ts), [step-executor.ts](../src/runner/step-executor.ts) |
| Skill files, calls, expansion | [expander.ts](../src/skills/expander.ts), [invocation-parser.ts](../src/parser/invocation-parser.ts) |
| Tools | [types.ts](../src/tools/types.ts), [define-tool.ts](../src/tools/define-tool.ts), [tool-helper.ts](../src/tools/tool-helper.ts), [registry.ts](../src/tools/registry.ts), [executor.ts](../src/tools/executor.ts), working examples in [fixtures/tools/src](../fixtures/tools/src) |
| Tab and browser tracking | [manager.ts](../src/browser/manager.ts), [step-executor.ts](../src/runner/step-executor.ts), [tabs.ts](../src/codebehind/tabs.ts) |
| Shipped example tests and skills | [templates/init/tests](../templates/init/tests), [templates/init/skills](../templates/init/skills) |
| MCP tools and their limits | [schemas.ts](../src/mcp/schemas.ts), [assemble.ts](../src/mcp/assemble.ts) |
| Defaults | [defaults.ts](../src/config/defaults.ts) |
