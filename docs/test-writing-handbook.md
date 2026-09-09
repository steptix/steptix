# Writing natural-language tests: a handbook for AI authors

This file is meant to be pasted into the context of an AI that writes tests for
**ai-ui-automation** (the `aiui` CLI, the TestBench VS Code extension, and the
MCP server all run the same test files). It explains how the framework reads a
test, which phrasings map to real browser actions, and how to reuse work
through skills and tools. Every statement was checked against the source on
2026-09-06; the last section says where to look when the framework moves on.

The companion [ai-test-authoring-guide.md](ai-test-authoring-guide.md) is the
rule-by-rule reference with more caveats. This handbook is the mental model
plus the phrasing that is known to work, so read this one first.

Every Markdown example below is a complete file that the parser accepts, and
every TypeScript example is a tool the registry loads. Each is introduced by a
`File` line naming where it would live in a project.

## 1. How a step is executed

A test is a Markdown file. The numbered lines under `## Steps` are the
instructions. Five kinds of line are handled by the framework itself rather
than performed by a model:

- `Set {{name}} to "…"` assigns a variable.
- `[skill: name …]` inlines a reusable step sequence from another file.
- `[tool: name …]` runs a TypeScript function.
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
- a screenshot, only when `ai.sendScreenshots` is on in `aiui.config.json`
  (it is off by default, so assume the model works from the DOM).

The model returns **one action per turn**. The framework performs it with
Playwright, takes a fresh snapshot, and asks again until the model reports the
instruction satisfied. The one exception is that a triggering action may be
chained with a single wait when the step names what to wait for. A step is
capped at 15 turns.

A failed action is retried once, and the retry prompt says which selector
failed, how many elements it matched, and why. A `Verify` or `Assert` step is
turned into a JavaScript check that runs in the page (or a pure value
comparison when no page is involved), the check is cached for the next run,
and the step fails when it returns false.

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
| `## Steps` | The instructions. The heading must be exactly this; `## Steps (happy path)` yields a test with no steps. |
| `## Hooks` | Setup and teardown lines (CLI runner only, see §8). |
| `## Outputs` | Skill files only: the variables a skill hands back. |

Any other `##` heading, and everything under it, is ignored. That makes extra
prose sections safe and makes a misspelled `## Step` heading a silent failure.
The order of `## Config` and `## Parameters` does not matter.

### Step lines

- Write `1. text`, unindented, one instruction per physical line. The numbers
  are not checked, so a renumbering mistake does not break the file. HTML
  comments and blank lines between steps are fine.
- Do not wrap a step onto a second line. The CLI folds it, but TestBench sees
  only the first line and refuses the file before running.
- Write `1.` rather than `1)` or a bullet. The CLI happens to accept those,
  but TestBench does not see them as steps, and a file that also has sections
  rejects them outright.
- Keep explanations out of step text. A trailing note becomes part of the
  instruction the model must satisfy.
- `{{name}}` is a placeholder only when written without spaces inside the
  braces; `{{ name }}` is refused.

### Frontmatter

Exactly six keys survive parsing: `tags` (a list, or a comma-separated
string), `timeout`, `env`, `dataFile`, `dataSources` (a mapping), and `type`
(`skill` or `test`). TestBench additionally honours `disabled: true`, which
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
| `cache` | `on` / `off` | Per-test action-cache switch on the TestBench and MCP paths. |

Unrecognised keys are stored and never read, with no warning. A `## Config`
key is not a test variable; declare inputs under `## Parameters`.

## 3. Step vocabulary

The model chooses actions from what the page offers, so these are phrasings,
not keywords. Each row is a shape the executor's prompt rules explicitly map
to an action.

| Intent | Write | What happens |
| --- | --- | --- |
| Go to a page | `Navigate to /orders` or `Navigate to https://…` | `page.goto`. Relative paths need `baseUrl`. |
| Click | `Click the Sign in button` | Located by visible label, then the most stable selector on that element. |
| Click, scoped | `Click Edit in the row for order {{order_id}}` | Scoping by row, dialog, section or form is how repeated labels are disambiguated. |
| Enter text | `Type "{{email}}" into the Email field` | Clears the field, then fills. It does not append. |
| Several fields | `Enter the username {{username}} and the password {{password}}` | One field per turn, then the step ends. Fine as one line. |
| Native select | `Select Australia from the Country dropdown` | Acts on the `<select>` by visible option text. |
| Custom dropdown | `Open the Country dropdown and choose Australia` | Two clicks. |
| Checkbox, toggle | `Check the I agree checkbox` | A click. Words like check, confirm and ensure describe an action here, not a verification. |
| Hover | `Hover over Products to reveal its menu` | `hover`. |
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
- Asking for part of a text ("just the digits after Account number:") makes
  the model add a regular expression. That read **fails the step** if the
  pattern matches nothing, so ask for a substring only when you mean it, and
  use a tool when the slicing must be exact.
- `Count the rows in the uploaded documents table [store as: document_count]`
  stores `"4"`.

A value that was displayed but never captured does not exist in later steps.

### 3.3 Assertions

Any step whose intent is to check something becomes an assertion: `Verify`,
`Assert that`, `Check that it says`, `Confirm the page has finished loading`.
The model generates a JavaScript check against the DOM (or against earlier API
responses, or a pure comparison of values), the framework runs it, and a false
result fails the step. The generated check is cached, so re-running an unchanged
assertion skips the code-generation call.

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

### 3.4 Watching for a state

A step that begins `When prompted …` or `When asked …`, or that begins `If …`
without a `then`, is a watch: it waits for one of several page states to
appear. (`then` changes the meaning of an `If` only; `When prompted …, then …`
is still a watch — with one exception, the same one §3.5 names: a tail that is
`return` or `stop` makes the line flow control, so `When the banner appears,
then return` leaves the flow rather than watching for anything. §3.6.)
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

Conditions are written like `Verify` sentences and reach the model as you
wrote them, placeholders intact: `the Cash checkbox is ticked`, `{{plan}} is
"pro"`, `the Load more button is gone`, `the cart shows more than 3 items`.

#### A chain decides

An `If`, any number of `Else if` lines and at most one `Otherwise`, on
consecutive step lines, are one chain. The page is allowed to settle, every
condition in the chain goes to the model **in one call**, the first that holds
wins, and its tail runs. Every other member — the other guard lines and every
step of their tails — is marked skipped, which is what the report and the
TestBench gutter then show you.

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
TestBench before it runs, in that one wording and naming that one line. Put the
input step before the `If`. Inside a tail's section body it is fine.

#### `then return` is not a tail

One `If … then …` line is **not** a decision: the one whose tail is `return` or
`stop` — bare, or with one of the six endings §3.6 lists, so `then stop running
the remaining steps` counts too. The same goes for a line opening `When`.
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
from `aiui.config.json`, which is 25. **Reaching the cap fails the loop line.**
A cap is a bug net, not an exit; write the condition the page really reaches.

`For each` needs a real list. Its second variable must hold a JSON array — what
a plural read stores ("every", "all", "each", §3.2) or what an array-typed tool
returns. `Set` builds text, and text is not a list: `For each` over
`Savings, Everyday` fails the line and says so rather than guessing a delimiter.

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

What this costs: one model call per evaluation, so a chain costs one and a
`While` that runs three passes costs four. A tail that is a plain instruction
costs another call to perform it. That is why `If a cookie banner appears,
reject it` is still better as a watch (§3.4) — one call, no `then`.

**Hooks do not dispatch control lines.** A `## Hooks` entry — or an
`execution.defaultHooks` entry in `aiui.config.json` — that reads like one is
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
ended. The condition is judged against the live page, the way an `If …` step
is.

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
- A conditional flow-control step compiles like any other: `aiui compile`
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

### 3.7 What does not exist

- No selector language in prose beyond what the model infers. A test id can
  be mentioned when you know it exists.
- No arithmetic or string functions inside step text. `Set` concatenates text
  and `For each` loops over a list a step already captured (§3.5); computing
  anything from a value is a tool's job.
- No `Break`, no `Continue`, no pass counter readable as a variable, and no
  collecting captures across the passes of a loop. A body that must differ per
  pass reads the difference off the page or takes it from `For each`.
- No way to return from an outer flow by name, and no way to end the whole
  test from inside a section — a `return` leaves the innermost flow it is in
  (§3.6), and an iteration of a loop counts as one of those.
- No implicit variables. `baseUrl` from `## Config` is available to `[tool:]`
  arguments as a convenience, but `{{baseUrl}}` in a prose step is just the
  model reading the test information block.
- No native OS dialogs, no drag-and-drop choreography, no file downloads, no
  visual-regression comparison as built-in vocabulary. Use a tool.
- JavaScript `alert`/`confirm` dialogs are answered automatically by the
  framework (dismissed, and `beforeunload` accepted); you cannot script a
  choice.
- `Press Enter in the Search field` does not focus the field. Type into it in
  the same step first.
- A `prompt` for clarification is what the model does when a step is
  underspecified. On the CLI a person answers; on TestBench, MCP and CI the
  step is skipped or fails. Underspecified steps are therefore not portable.

## 4. Variables and data

### 4.1 Where `{{name}}` values come from

`## Parameters`, the current data-table row (which overrides a same-named
parameter), captures from earlier steps, `Set` assignments, tool and skill
outputs, and `[input:]` answers all write into one variable map, and the
latest write wins. All values are strings; lists are JSON text.

When a `{{name}}` is unresolved: the step text keeps the literal with a
warning, the `## Values` block lists it as "not yet captured", and if the model
uses it in any action field the whole turn is refused and the step fails. A
`Set` with an unresolved reference fails immediately. So a typo in a variable
name fails at the step that uses it, not silently later.

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

A variable whose name matches `password`, `secret`, `token` or `key` (case
insensitive, anywhere in the name) is masked as `***` in the console, the
report, the run log and the `## Values` block. The model never sees the value;
the executor substitutes it when acting. Never write `***` as a value
yourself; the framework refuses an action containing it. If a non-secret name
is caught by the rule, list it under `unmask` in `## Config`.

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

Run one row with `aiui run tests/sign-in-matrix.md --row 2` (one-based). The
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

- `type: skill` in frontmatter is what keeps the file out of `aiui run`'s test
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
import { tool } from 'ai-ui-automation/tools';

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
import { tool } from 'ai-ui-automation/tools';

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
import { defineTool } from 'ai-ui-automation/tools';

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
import { defineTool } from 'ai-ui-automation/tools';

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
  `"type": "module"` and dev dependencies on `ai-ui-automation`, `playwright`
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

Hooks exist only on the CLI file runner. TestBench, the Sessions API and the
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
npx aiui list
npx aiui run tests/login.md
npx aiui run tests/ --tag smoke --headless
npx aiui run tests/login.md --env staging
npx aiui run tests/sign-in-matrix.md --row 2
npx aiui compile tests/login.md --env staging
```

`run` also takes `--timeout <ms>`, `--browser <engine>`, `--bail`,
`--verbose`, `-c <config>`, and `--fail-on-healed`, which fails CI when
compiled code had to be repaired by the model. `compile` records a run and
writes a `.steps.ts` beside the test so future runs replay eligible steps as
code with no tokens; the Markdown stays the authored test and steps that the
compiler declines stay AI-driven.

Interactive markers, for a person at the keyboard only:

- `[input: otp_code] Enter the code sent to your phone` pauses for a typed
  value and stores it as `{{otp_code}}`.
- `[interactive] Explore the dashboard` opens a REPL of ad-hoc steps.

Away from the CLI's terminal (TestBench, MCP, CI) both are reported as
skipped, and a skipped step counts as not run. Do not put them in unattended
tests.

When the authoring AI has the framework's MCP server, `list_test_files`,
`run_test_file`, `run_steps` (exploratory steps that keep a session's browser
state), `get_page_content` (to read real labels before writing steps),
`get_last_run`, `peek_tab`, `navigate_tab`, `log_into_site`, and the CDP
browser tools are available. Limits that affect how green a result really is:
`run_test_file` runs only the first table row, ignores `dataFile` rows,
executes no hooks, and skips `[input:]` and `[interactive]` steps. Validate
the whole file with the CLI or TestBench when those matter.

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
| `If the Cash checkbox is ticked, run the Pay with cash section` | `If the Cash checkbox is ticked, then Pay with cash` | Without `then` the line is a watch, and the section name in it is prose. |
| `If the total is more than $100 then apply the discount, then Verify it` | Reword the condition | The **first** ` then ` ends the condition. |
| `For each {{account}} in {{names}}` where `names` came from a `Set` | Capture it with a plural read | `For each` takes a JSON array, and no delimiter is guessed. |
| `Press Enter in the Search field` | `Type "shoes" into the Search field and press Enter` | The key press targets nothing. |
| `[skill: sign_in]` when the skill declares `email` | `[skill: sign_in email password]` | Every declared parameter is required. |
| `[tool: slugify s="x"]` for a named export | `[tool: strings/slugify s="x"]` | Named exports need the file prefix. |
| `[tool: visit_each urls={{links}}]` | `urls="{{links}}"` | Unquoted templates are a parse error. |
| `[tool: a] [tool: b]` on one line | Two lines | Only one call per line survives. |
| A popup-opening click, then `[tool: …]` | Add `and switch to the tab it opened` to the click | A tab the app opens is tracked but not active; the tool reads the old page and passes. |
| `password: hunter2` under `## Parameters` | `password: $TEST_PASSWORD` | Secrets live in `.env`, and the name alone triggers masking. |
| `[input: otp]` in a CI test | A tool that fetches the code from the test inbox | Input steps are skipped unattended. |
| `## Steps (login)` | `## Steps` | Any other heading yields no steps. |
| `Wait for .spinner:hidden` | `Wait until the spinner disappears` | State belongs in words, not selectors. |
| A section body's steps before the main flow ends | Main flow first, then `###` headings | Everything after the first `###` belongs to a section. |
| `If we are signed in then skip ahead` | `If we are signed in then return` | Only `return` / `stop` (and the six endings §3.6 lists) end a flow. Anything else after ` then ` is a decision whose tail is prose, so "skip ahead" is handed to a model as an instruction — the same way `then retun` is (§3.6). |
| `beforeEach: If already signed in then return` | Put the line in `## Steps` | A hook has no flow to leave; the file is refused at parse. |

## 12. Checklist before handing a test over

- Title, `## Steps` spelled exactly, one instruction per physical line.
- Every `{{name}}` is supplied by a parameter, a row, a capture with
  `[store as:]`, a `Set`, or a skill or tool output that runs first.
- Every `${…}` reference has an environment that defines it, and the test says
  which (`env:` in frontmatter or a documented `--env`).
- Every skill call passes every declared parameter and aliases outputs that
  must survive a second call; every tool call names an existing file and
  declared outputs.
- Every action has a named completion condition where the page is slow, and
  every business outcome has a `Verify` line that could fail.
- Every `While` or `Repeat … until` has an exit the page actually reaches; any
  `, up to N times` is a bug net you meant, not the way the loop ends.
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
| `return` / `stop`, and which steps a return skips | [flow-control-step.ts](../src/parser/flow-control-step.ts), [flow-control.ts](../src/runner/flow-control.ts), [control-flow.ts](../src/runner/control-flow.ts) (`returnExit`), [test-runner.ts](../src/runner/test-runner.ts) |
| Skill files, calls, expansion | [expander.ts](../src/skills/expander.ts), [invocation-parser.ts](../src/parser/invocation-parser.ts) |
| Tools | [types.ts](../src/tools/types.ts), [define-tool.ts](../src/tools/define-tool.ts), [tool-helper.ts](../src/tools/tool-helper.ts), [registry.ts](../src/tools/registry.ts), [executor.ts](../src/tools/executor.ts), working examples in [fixtures/tools/src](../fixtures/tools/src) |
| Tab and browser tracking | [manager.ts](../src/browser/manager.ts), [step-executor.ts](../src/runner/step-executor.ts), [tabs.ts](../src/codebehind/tabs.ts) |
| Shipped example tests and skills | [templates/init/tests](../templates/init/tests), [templates/init/skills](../templates/init/skills) |
| MCP tools and their limits | [schemas.ts](../src/mcp/schemas.ts), [assemble.ts](../src/mcp/assemble.ts) |
| Defaults | [defaults.ts](../src/config/defaults.ts) |
