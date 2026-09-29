# AI guide to writing runnable natural-language tests

Use this document as context for an AI that generates tests for **steptix** (`steptix`, also used by Steptix). It describes the implementation in this repository, checked on 2026-09-21. If the framework changes, check the source references at the end before assuming the grammar is unchanged.

This is the rule-by-rule reference. For the mental model of how a step is executed and the phrasing that is known to work, read [test-writing-handbook.md](test-writing-handbook.md) first.

The output is a Markdown test file, optionally accompanied by reusable Markdown skills, TypeScript tools, and fixture data. Ordinary steps are interpreted by AI against the live browser and executed through Playwright. Special forms such as skill calls, tool calls, and variable assignments are handled by the framework. Natural language is flexible; the surrounding file and invocation syntax is not.

## Instructions for the test-writing AI

1. Read the target project's `steptix.config.json`, relevant `context/**/*.md`, existing tests, skills, and tools before writing a test. Directory names below are defaults and can be configured.
2. Use observed UI labels, supplied requirements, and existing application context. Do not invent URLs, selectors, API endpoints, accounts, expected values, skill names, or tool signatures.
3. Write one bounded instruction per numbered step. An action plus its completion condition is a useful single step: `Click Save and wait for the Saved message`.
4. Make the expected result explicit. A successful click is not evidence that the business requirement passed. Add a `Verify` or `Assert` step with a concrete expected value or state.
5. Supply every referenced input before use, and explicitly name every captured value that later steps need. Use placeholders for values that change between runs.
6. Reuse an existing skill or tool only after reading its file. If a required helper does not exist, create it within the requested scope or identify it as a missing dependency. Calling a plausible name does not create a helper.
7. For unattended runs, resolve all parameters and avoid `[input: ...]`, `[interactive]`, and instructions that require a human answer. `[use computer]` is a different case: nobody types, but the run drives the real mouse on a visible desktop nobody may touch, and the project must have opted in — see "Leaving the browser" below before writing one.
8. Return the test and any required supporting files separately. Keep explanations and assumptions outside executable step text. Report whether you actually ran the test; a parser check alone does not establish that the application flow passes.

## Project files and their roles

| Default location | Purpose |
| --- | --- |
| `tests/**/*.md` | Runnable tests. |
| `skills/**/*.md` | Reusable parameterised step sequences invoked explicitly with `[skill: ...]`. |
| `tools/src/` | Project tool modules invoked explicitly with `[tool: ...]`. |
| `context/**/*.md` | Application knowledge supplied to the execution AI: terminology, page descriptions, workflows, and constraints. These files do not execute as skills. |
| `.env`, `.env.<name>` | Environment settings and secret values. |
| `data/<name>.json` | Structured data selected by the environment name. |
| `steptix.config.json` | Browser, AI, execution, directory, and reporting settings. |
| `reports/` | Generated HTML reports by default. |

Framework skills and tools are project files. They are separate from skills/plugins installed in the authoring AI's host. A host tool such as an email connector is not automatically available inside a `steptix` test.

## File format

This is a complete example **template**. The URL, credentials, labels, and expected heading must match the application under test. `TEST_EMAIL` and `TEST_PASSWORD` must be supplied through the project's environment.

```markdown
---
tags: [smoke, login]
timeout: 90s
---

# Valid user can sign in

## Config
- baseUrl: https://app.example.test
- viewport: desktop

## Parameters
- email: $TEST_EMAIL
- password: $TEST_PASSWORD

## Steps
1. Navigate to /login
2. Type "{{email}}" into the Email field
3. Type "{{password}}" into the Password field
4. Click the Sign in button and wait for the Dashboard heading
5. Verify the Dashboard heading is visible
6. Click the Sign out button and wait for the Sign in button
7. Verify the Sign in button is visible
```

Use these authoring conventions for consistent CLI and Steptix behaviour:

- Use one `# Title` and one `## Steps` block. Place configuration, parameters, and hooks before `## Steps`.
- Write unindented `1. ...`, `2. ...` numbered items. Do not use `1)`, bullet lists, nested steps, Gherkin `Scenario`/`Given` blocks, or code fences as executable test structure.
- Keep each numbered instruction on **one physical line**. Editor word wrapping is fine; inserting a newline inside the instruction can produce different parsing across clients or a preflight refusal.
- Leave explanations outside the step list. Do not append `# comments`, arrows, or explanatory notes to a runnable instruction.
- A `### Name` under `## Steps` defines a callable section; it is not just a visual grouping. Numbered items beneath headings of depth four or greater in this block are inert.
- Keep `{{variable_name}}` names simple, preferably `snake_case`, without spaces, dots, or hyphens. Dotted `${data.path}` references use a separate syntax.

Later examples illustrate individual features. Supply their application-specific starting state and any referenced inputs before running them; they are not a suite against a bundled demonstration site.

### Metadata and configuration

| Location | Supported settings relevant to authors |
| --- | --- |
| YAML frontmatter | `tags: [smoke, login]`, `timeout: 90s`, `env: staging`, `dataFile: data/cases.json`, `dataSources:` mapping, and `type: skill` for library files. |
| `## Config` bullet list | `baseUrl`, `timeout`, `viewport`, `cdp`, `cdpTab`, `consoleLogLevel`, `serverFileLogLevel`, and `unmask`. Unrecognised keys are kept and never read, with no warning. |
| `## Parameters` bullet list | `- name: value`, referenced in steps as `{{name}}`. |

`viewport` accepts `mobile` (390×844), `tablet` (768×1024), `desktop` (1440×900), or a size such as `1280x720`. It changes page dimensions, not touch support, user agent, or full mobile-device emulation. Do not combine a per-test viewport with `cdp`.

Use `baseUrl` to establish the application's base address and explicit navigation steps to show the intended starting page. Relative navigation URLs resolve against the configured base. Do not assume a `## Config` key also creates a general-purpose test variable; declare inputs in `## Parameters` when needed.

## Supported browser instructions

These are natural-language examples, not literal command keywords. The model chooses supported actions from the current page. Describe the target by label and context; use a selector only when you have verified it.

| Capability | Example step text |
| --- | --- |
| Navigation | `Navigate to /orders` |
| Browser history | `Go back` / `Go forward` | The browser's own back and forward buttons, on the active tab. Not a click: there is no such element in the page, and a keyboard shortcut does nothing. Fails the step if the tab did not move. |
| Reload | `Reload the page` / `Refresh` | The browser's reload button, on the active tab. Not F5: a key goes to the page, not the browser. |
| Drag and drop | `Drag the Invoice 1043 card onto the Paid column` | One drag from one element onto another, both named like a click's target. Covers HTML drag-and-drop and pointer-driven sortables. |
| Clicking | `Click Edit in the row for order {{order_id}}` |
| Text entry | `Type "{{email}}" into the Email field` |
| Native select or custom dropdown | `Select Australia from the Country dropdown` |
| Checkbox or toggle | `Check the I agree checkbox` |
| Hover | `Hover over Products to reveal its menu` |
| Keyboard | `Type "shoes" into the Search field and press Enter` |
| Scroll to a target | `Scroll to the Reviews section` |
| Page extremes or relative scroll | `Scroll to the bottom of the page` / `Scroll down a little` |
| File upload | `Upload "attachments/statement.pdf" using the Choose file button` |
| Multiple-file upload | `Attach "attachments/receipt-1.png" and "attachments/receipt-2.png" to the Receipts field` |
| Frame interaction | `Inside the Payment iframe, type "{{card_number}}" into Card number` |
| DOM modal/banner | `If the cookie banner is visible, click Reject non-essential cookies` |
| Open and name a tab | `Open https://docs.example.test in a new tab and remember it as docs` |
| Switch tabs | `Switch to the docs tab` / `Switch to the main tab` |
| Close an auxiliary tab | `Close the docs tab` |
| Separate browser session | `Open a second Edge browser and name it reviewer` |
| Switch browser session | `Switch to the default browser` |
| Read or count | `Count the rows in the Orders table [store as: order_count]` |
| Verification | `Verify the status of order {{order_id}} is Shipped` |
| A made-up value (no page) | `[use ai] Create a customer name starting with AUTO [store as: customer]` — see "Capture and reuse" |

Text entry normally replaces a field's contents; say explicitly when you need a different keyboard interaction. A key press is sent to the page, not to a named field, so type into the field in the same step first. Scope repeated labels to their form, dialog, section, or row. For example, `Click Save in the Shipping address dialog` is more reliable than `Click Save`.

Tabs share their browser session. A separately opened browser supports independent actors/logins. `main` is the original tab label; `default` is the original browser label. Use explicit names for new tabs and browsers instead of guessing generated tab numbers. The standard close-page action does not close the main tab.

Upload paths are resolved relative to the **test file's directory**, including upload steps expanded from a skill. Prefer forward slashes. Create or supply the fixture files; a path in prose does not generate a file. The upload action handles file inputs and file-chooser controls, not arbitrary operating-system UI.

The engine uses the DOM and can also use screenshots when configured. Do not promise pixel-perfect visual regression, accessibility audits, or arbitrary JavaScript execution as built-in natural-language test assertions. Implement specialised checks in tools when appropriate. Downloads and drag-and-drop choreography should use a verified project tool when the standard action vocabulary is insufficient. Native dialogs and other operating-system windows are not in this table because they are not in the page; they are reached by switching surface — see "Leaving the browser: `[use computer]` and `[use browser]`" below.

## Leaving the browser: `[use computer]` and `[use browser]`

Two whole-step directives switch which **surface** the following steps run on. From `[use computer]` on, each step is answered from a screenshot of the primary display and nothing else — no DOM snapshot, no Playwright — and the model's answer is performed as a real mouse move, click, or keystroke. `[use browser]` returns to DOM snapshots and Playwright on the same tab the test left. Use it for what is genuinely not in the page: a PDF viewer's toolbar, a print dialog, a native Save As window, a file picker, an installer.

```markdown
## Steps
1. Navigate to statement.pdf
2. Wait for the PDF to finish loading
3. [use computer]
4. Focus the window whose title contains "statement.pdf"
5. Click the Print button in the PDF viewer's toolbar
6. Wait until the Print dialog is showing
7. Click the Cancel button in the Print dialog
8. [use browser]
9. Verify the page URL ends with statement.pdf
```

Rules the generated file must respect:

- **The directive is the whole step.** A bare bracket token alone on the line, like `[interactive]`. `[use computer] Click Cancel` is a parse error, not two steps, and so is any argument. The colon is optional (`[use: browser]` is the same directive). A step that is nothing but an unrecognised bracket — `[computer]`, `[use the computer]`, `[computer-use]` — is also a parse error, by design: none of them should reach a model as prose.
- **The project must opt in.** `desktop.enabled: true` in `steptix.config.json`, which defaults to `false`. Without it, `[use computer]` fails the step. Do not write a computer-mode test for a project whose config you have not read.
- **Switching surface arranges nothing.** It changes what the model is shown and how its answer is performed, and nothing else — so when a run starts from an editor, the first computer-mode screenshot is of that editor. Write a step that brings the target window forward. Two phrasings are answered from the OS window list rather than from pixels: `Focus the window whose title contains "Save As"`, and `Wait until a window titled "Save As" is open` / `… is gone`.
- **A test whose first step is `[use computer]` launches no browser at all.** That is how a native application is tested here.
- **The person at the machine must not touch the mouse or the keyboard** while a computer-mode step runs, and the desktop must be visible and unlocked. Only one computer-mode run per machine — the framework takes a lock and refuses a second. Say this in the test's prose header; do not generate a computer-mode test as if it were an ordinary unattended one.
- **Captures are of the whole screen**, including whatever else is on the desktop, and they go into the report. Text redaction cannot mask pixels. `desktop.reportScreenshots: false` keeps desktop captures out of the report, and stops the MCP server returning a whole-desktop screenshot of a failed computer-mode step to the agent.
- **No code-behind for these steps.** A recorded coordinate has nothing to re-validate against on a machine whose resolution or window layout has moved, so a step that ran in computer mode stays AI-driven when the file is compiled.

Worked examples: `templates/init/tests/pdf-dialog-cancel.md` (open a print dialog and cancel it) and `templates/init/tests/calc-one-plus-one.md` (start Calculator with a tool, type a sum, click the "=" button and read the answer, with no browser launched at all).

The family has a third member that switches nothing: `[use ai] <step>` opens a step whose text goes to the model on its own, with no page and no screen, and stores the value it answers with (see "Capture and reuse"). Unlike the two switches it is a prefix, not a whole step, and it takes no computer lock in computer mode.

## Waits and assertions

Prefer an observable completion condition to a fixed sleep:

```markdown
# Save profile

## Steps
1. Click Save and wait up to 30 seconds for the Saved message
2. Verify the profile name is "{{expected_name}}"
```

Supported waits include visible elements, disappearing elements, text, explicit URLs/globs, minimum element counts, attribute changes, navigation, page load, page stability, and durations. Say what should happen and, for a slow operation, how long it may take. Waits have their own bounded timeout; increasing the overall test timeout alone does not increase every wait.

Useful assertions include:

- `Verify the error message is exactly "Invalid email or password"`.
- `Verify the Submit button is disabled`.
- `Verify no row in the Orders table has status Failed`.
- `Assert that {{order_count}} equals 3`.
- `Assert that "{{actual_email}}" equals "{{expected_email}}"`.
- `Assert that "{{summary}}" contains "{{order_id}}"`.

Use exact text, contains, starts-with, counts, and numeric comparisons intentionally. State the relevant currency, format, or tolerance if it affects the result. Value-only assertions can compare captured variables without querying the DOM. Assertion checks run generated checking code, generated afresh on every run unless the step is compiled to code-behind; a completed action or a model's narrative is not itself an assertion. Failed assertions fail the step.

`Confirm by clicking Submit` and `Check the box` express actions. They do not request verification just because they contain words that can also mean “assert”.

## API steps and application context

Natural-language API calls can be mixed with browser steps. Describe the HTTP method, known endpoint, request fields, authentication mode, and expected response. For example, with the real service documented in project context: `Send a GET request to https://api.example.test/orders/{{order_id}} using the current browser session`, followed by `Verify the previous API response has status 200 and its order status is Shipped`.

Put API knowledge in the configured context directory, including service type (`Type: Front Proxy`, for example), actual base URLs, endpoint contracts, authentication requirements, and CSRF location when applicable. The current execution prompt enables its API-specific guidance when the loaded context contains `Type:`. Browser-mode requests use Playwright `context.request` and share cookies; standalone requests use fetch. Do not assume a standalone request inherits a browser login or that naming a Swagger URL supplies every required contract detail.

Prior API responses are available to subsequent AI steps for checking and reasoning. However, the current `extract_value` action logs an extraction without writing a runtime variable. If later steps need a reliable `{{order_id}}` from an API response, use a tool that explicitly calls `step.setVar` for a declared output. Tools are also preferable for exact payloads, polling, and complex authentication. No `[api: ...]` Markdown directive is required or defined.

## Variables and test data

### Capture and reuse

Use an explicit capture target:

```markdown
# Capture an order

## Steps
1. Read the order number from the confirmation panel [store as: order_id]
2. Read the href of the View order link [store as: order_url]
3. Read the current page URL [store as: confirmation_url]
4. Count the rows in the Order items table [store as: item_count]
5. Read the href of every invoice link in the Invoices section [store as: invoice_urls]
6. Set {{summary}} to "Order {{order_id}} has {{item_count}} items"
7. Assert that "{{summary}}" contains "{{order_id}}"
```

The framework also supports a prefix such as `[output: order_id] Read the order number`, and natural-language `store as {{order_id}}`. `[as: name]` is **not** a framework marker: nothing parses it, and it works in some shipped examples only because the model happens to derive the same name from it. Do not use it in new files. For reusable skills, use **`[store as: name]`**: the skill expander rewrites that form (and the prose `store as {{name}}` form, through its braces) for output aliases and internal scope, but does not rewrite `[as: name]` or `[output: name]`. An aliased skill output written with those markers can retain the wrong name.

Placeholders reach the model as tokens, not values: the step is shown as written, with a `## Values` block listing what each `{{name}}` and `${ref}` holds on this run (secret-named ones as `***`), and the real value is substituted when the action executes. An unresolved `{{name}}` stays literal in the step text, is listed as not yet captured, and fails the step if the model uses it in an action.

Reading link text and reading its `href` are different operations. Say which one you need. List captures are stored as JSON-encoded arrays. A read can extract a substring with a regex; describe the desired substring precisely, or use a tool for deterministic parsing. Do not rely on the AI remembering a value that was never captured.

`Set {{name}} to "template"` is a deterministic string assignment with no AI call. It resolves existing placeholders, fails for unresolved references, and can store an empty string. It performs no arithmetic or expression evaluation: `"{{count}} + 1"` stores text. The authored template must be double-quoted with no embedded double quotes or trailing instruction. Use a tool for calculations and transformations.

`[use ai] <step>` asks the model for a value that is not on any page — a test customer's name, filler text, a date worked out from one the step gives — and stores it:

```markdown
## Steps
1. [use ai] Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name
2. [use ai] Today is {{today}}. Give the date 3 days later as yyyymmdd [store as: days_from_now]
3. Type "{{random_name}}" into the Name field
```

Generate these knowing four things. **The model is asked on every run** — the step is never compiled. **It sees only the step text**, placeholders filled in: no page, no earlier steps, no date, so put today's date (or anything else it needs) in the step from a parameter or a tool. **It is a poor source of randomness**: "random" can repeat between runs. **For a value that must be the same every time, write a tool.** Name the value with `[store as: name]`, which is authoritative; without an explicit name the model's name must appear in the step as a whole word, or the step fails. That only rules out invented names: a step that never names its value can be stored under any word of its sentence, so always name it. In a skill the name must be `[store as: name]` or `store as {{name}}`. The step fails, rather than storing anything, when the model says the step cannot be done (for example it needs a date it was not given), when its answer is empty, or when a `{{name}}` / `${…}` in the step does not resolve. Secret-named values reach the model as `***`, and so does a secret that a skill argument or a looped section's row writes into the step's text. A step that needs one fails: the model is told `***` is a value hidden from it, and an answer that still contains the mask, in any spelling, is refused rather than stored. The error names what was hidden, never its value; a variable hidden only by its name (`{{keyword}}` contains `key`) is sent as itself once renamed. `[use ai]` must open the step, and it cannot be a control line's tail.

### Reading a table into row records

One step may capture several columns of one HTML table as **records** — one flat object per visible data row — instead of several parallel lists. Write it as a single read naming each column and the property it becomes:

```markdown
# Review scheduled payments

## Config
- baseUrl: https://app.example.test

## Steps
1. Navigate to /payments
2. Read the Payee column as payee, Amount column as amount, and Status column as status from every row in the Scheduled payments table [store as: payments]
3. For each {{payment}} in {{payments}}, Review the payment
4. Verify the Scheduled payments table still shows 5 payments

### Review the payment
1. If {{payment.status}} is "Overdue", then return
2. Click View in row {{payment._row}} of the Scheduled payments table
3. Verify the Payment details page shows "{{payment.payee}}" and the amount {{payment.amount}}
4. Click Back to scheduled payments
```

Prefer this to three plural reads of the same rows. Parallel arrays lose their alignment on one hidden row, one empty cell or one selector that matched something slightly different, and the test then checks one row's id against another row's status and passes. Records are built one row at a time, so alignment is the framework's problem rather than the author's.

What the capture holds and how it is addressed:

- `{{payments}}` is a JSON array of objects, so `For each` accepts it directly. Inside the loop, `{{payment}}` is the whole record as JSON and `{{payment.<alias>}}` is one field.
- Exactly **one** property segment is a reference. `{{order.id}}` and `{{order._row}}` resolve; `{{order.address.city}}` and `{{orders[0].id}}` are not references at all and reach the model as the literal text you typed. A dotted reference whose property the record does not have fails the step before any model call and lists the properties it does have.
- Every record carries `{{item._row}}` without being asked: the one-based position of its row among the table's **data rows** at the moment of the read, with hidden rows and full-width message or group rows excluded. Use it to point at a row whose values are not unique ("two rows for Origin Energy"). It is a position, not an identity — if the body changes as you go, re-find by value instead.
- Columns are matched by header text, so reordering the table changes nothing. A table with no header row is addressed by position instead (`the 1st column as payee`, `column 3`, `the second column`), and a positional column needs an alias because there is no header to derive one from. Header and position can be mixed in one step; a column is one or the other.
- `Read … from the first 10 visible rows` bounds the read. A bound makes even a one-column read a record read. There is no last N, no row range and no pagination in the bound; it addresses the currently rendered rows only.

Aliases are copied exactly as written and must look like variables, be unique within the step, and not be `_row`. Omitted, the key is derived from the header by the model (`Order ID` → `order_id`); name the alias yourself whenever a later step uses the field.

Do not assume a table read degrades gracefully. It **fails the step**, with a message naming the table, on: a merged header or cell (`rowspan`/`colspan` > 1); a `<thead>` with more than one row; a duplicate or missing header you named; a selector matching more than one visible table or none; no cell at a resolved column position in a row the read returned; more than 500 visible rows with no bound; more than 20 columns in one step; anything that is not a native `<table>` (`<div role="grid">`, ag-grid, a card list, a table that becomes cards at a phone viewport); and a column asked for as a control's state (a checkbox's tick, an input's value), which is a later phase. An empty table is not a failure: it stores `[]` and the loop runs zero passes, so if emptiness would be a bug, assert the row count on its own line. A "Loading…" row is a full-width message row, which means it is skipped — the read does not wait, so wait on the line before it.

Conditions in the body are cheap. A condition that carries a captured reference and is otherwise a plain comparison (`If {{payment.status}} is "Overdue"`, `If {{payment.reference}} is empty`) is decided by the framework from the values, with no model call: each reference is substituted as a quoted literal and compared exactly, whether or not the author quoted it. A condition with prose in it is about the page and still goes to the model. So does an **ordering** (`is at least`, `is at most`, `is more than`, `is greater than`, `is less than`) whose operands are not plain numbers once the quotes are off: `If "{{payment.amount}}" is more than 100` over a cell holding `$140.00`, or any comparison of dates, is not decided locally, goes to the judge and costs a model call, with no warning. Capture the number without its currency symbol, or do the arithmetic in a tool. An assertion is different. A `Verify`/`Assert` comparing only values is checked as a predicate whose text the model copies as written and the framework substitutes just before generating the check, so an unquoted empty value leaves `is empty` with no left operand. Quote any captured value an assertion compares: `Verify that "{{payment.reference}}" is empty`.

Whole-table assertions are not available yet. Do not write `Assert that {{payments}} contains "Origin Energy"`, or `equals`, or any other predicate over the captured JSON: that is an ordinary AI step with a long JSON literal pasted into it, and the model classifies it as a self-contained predicate only about half the time, otherwise emitting a DOM assertion with no expectation, which fails. Loop over the records and check each against the page, or pass `rows="{{payments}}"` to a tool that does the arithmetic in code.

### Three different data mechanisms

| Syntax | Meaning |
| --- | --- |
| `{{email}}` | Runtime parameter, data-row column, captured value, or tool/skill output. |
| `- password: $TEST_PASSWORD` in Parameters | Resolve a parameter from an environment variable. This is not shell execution or a general inline `$VAR` substitution language. |
| `${env.BASE_URL}` | A setting from the selected environment bundle. |
| `${data.users.admin.email}` | A nested value from the environment's `data/<name>.json`. |
| `${catalog.products.0.name}` | A nested value in a JSON file registered as `catalog` under `dataSources`. |

For `${env.*}`, `${data.*}`, and named-source references, explicitly select an environment using `--env staging` or frontmatter `env: staging`; this ensures the CLI supplies the interpolation context. `.env` and `.env.staging` are composed for that environment. Do not assume that a missing variable will be repaired automatically: different paths can prompt, warn, retain a literal, or fail. Preflight all required values.

Named JSON sources are declared with a block mapping:

```yaml
dataSources:
  catalog: ../data/catalog.json
```

Those paths resolve relative to the test file. `env` and `data` are reserved source names. JSON string leaves such as `"$TEST_PASSWORD"` can refer to environment values. A skill may declare its own `dataSources`; those namespaces belong to the skill, and its source paths resolve relative to the skill file. Do not assume a caller's named source is visible inside a skill; pass the needed value as a parameter.

Keep real credentials in the environment, not in generated Markdown or fixtures. Never type `***` as a password: it is a redaction marker. `unmask` is for a deliberately nonsecret value whose name was mistakenly classified as secret, not for exposing credentials. It governs what is shown live — the `## Values` block the model reads and Steptix's Variables surfaces — and never the report, the run log or the console line, which star an unmasked name regardless. So `unmask` cannot put a value into a file that leaves the machine, and it is not a way to make a credential visible in a report. It currently takes effect on the `steptix` CLI and the MCP tools only: a run started from Steptix does not send the list to the server.

Two rules decide what is masked, because a name has two possible authors. A name **you** wrote — a parameter, a `[store as:]` capture, a `${…}` reference — is a secret when `password`, `secret`, `token` or `key` appears anywhere in it, case insensitive. A name the **page** supplied — a table read's column alias, a record key from a tool — is a secret only when it holds `password`, `passwd`, `pwd`, `secret`, `token`, `otp` or `credential`/`credentials` as a whole word, or `key` behind `api`, `access`, `private`, `auth`, `signing` or `encryption` (`api_key`, `apiKey`; a camelCase hump is a word break, so `apikey` is not one). Plain `key`, `keys`, `sort_key` and `keyword` are readable columns: masking a value replaces it everywhere, including in the page snapshot the model plans from, so over-masking a sort key can stop the next step finding its row. A dotted loop binding takes both — `{{user.password}}` by the column, `{{token.payee}}` by the record's own name, `{{payment.sort_key}}` by neither — or by the whole name read as one credential key, so `{{api.key}}` is masked (that last reading uses the column rule, which is why `{{row.keyword}}` is not). A dot alone does not make a binding: a dotted name **you** wrote — a data-file column headed `user.apikey`, a `[store as: api.key]` capture — takes your own rule on the whole key, and the run tells Steptix which dotted names a loop actually bound so its views read them the same way the report does. Masked values are hidden in the report, the run log, the console line, the `## Values` block and Steptix's Variables view and panel; the last two also mask the secret columns *inside* a `{{payments}}` capture or a `{{payment}}` record, which no name rule can catch.

### Data-driven runs and section loops

A table directly under `## Steps`, before its first numbered step, runs the whole test once per row:

```markdown
# Invalid email messages

## Config
- baseUrl: https://app.example.test

## Steps
| email | expected_error |
| --- | --- |
| invalid | Enter a valid email address |
| missing-at.example.test | Enter a valid email address |

1. Navigate to /register
2. Type "{{email}}" into Email
3. Click Create account
4. Verify the email error is exactly "{{expected_error}}"
```

Rows override shared parameters with the same name. In ordinary launch mode, each test row gets a fresh browser; CDP attaches to persistent state and does not provide that isolation. Put a table directly under a `### Section` instead to repeat only that section in the **same session**, with the page state preserved between iterations.

Table headers must be unique variable names; every row must have the same number of cells and at least one data row must exist. Use plain cell values, not Markdown formatting. A section's row bindings are inputs; do not assign to them with `Set`.

Alternatively use frontmatter `dataFile: data/cases.json` or a simple CSV. `dataFile` paths resolve relative to the **project root**, unlike `dataSources` and upload paths. JSON must contain an array of row objects. The CSV loader is a simple comma splitter, so use JSON when cells contain commas or require quoted CSV semantics. Do not combine a top-level table with `dataFile`.

## Inline sections: reuse within one file

```markdown
# Search two products

## Config
- baseUrl: https://app.example.test

## Steps
1. Navigate to /products
2. Search each product
3. Verify the Search field is visible

### Search each product
| query | expected_product |
| --- | --- |
| blue mug | Blue mug |
| green plate | Green plate |

1. Type "{{query}}" into Search
2. Click Search and wait for the results to load
3. Verify a result named "{{expected_product}}" is visible
```

The entire step text `Search each product` calls the section. Matching is trimmed and case-insensitive, but punctuation and Markdown formatting matter: `Search each product.` and `**Search each product**` are not that call. `{{section_name}}` does not dynamically dispatch a section.

All main-flow steps must precede the first `###` section. A section body runs only when called; it shares the caller's variables. Sections can call other sections or skills, but recursion/cycles are rejected. Use unique, descriptive names; reserved headings such as `Steps`, `Config`, and `Parameters` cannot be section names. Use the CLI or Steptix Native for sections; the legacy Monaco client refuses sectioned files.

## Skills: reuse across tests

Create `skills/auth/sign_in.md`:

```markdown
---
type: skill
---

# sign_in

## Parameters
- login_url: Absolute URL of the sign-in page
- email: Account email
- password: Account password

## Outputs
- display_name: Name displayed after sign-in

## Steps
1. Navigate to {{login_url}}
2. Type "{{email}}" into Email
3. Type "{{password}}" into Password
4. Click Sign in and wait for the Dashboard heading
5. Verify the Dashboard heading is visible
6. Read the signed-in user's display name [store as: display_name]
```

Call it from a test with all inputs supplied:

```markdown
# Sign-in greeting

## Parameters
- login_url: https://app.example.test/login
- email: $TEST_EMAIL
- password: $TEST_PASSWORD
- expected_name: Test User

## Steps
1. [skill: auth/sign_in login_url email password out.display_name="signed_in_name"]
2. Assert that "{{signed_in_name}}" equals "{{expected_name}}"
```

Skill rules:

- The path selects the file: `auth/sign_in` means `<skillsDir>/auth/sign_in.md`. Match the file's case and omit `.md`. A leading `/` is optional for skill references.
- Every declared parameter is required at the call site. Text after `- parameter:` in a skill is descriptive; it does **not** supply an optional default. An undeclared extra argument is only warned about, and it still overwrites a same-named `{{name}}` in the body.
- Bare `email` is shorthand for `email="{{email}}"`. Explicit `email="${data.users.admin.email}"` is also useful when an environment bundle is selected.
- Skills expand before execution. Their parameters are substituted and internal variables are namespaced per invocation. Declare anything the caller needs under `## Outputs` and actually capture or assign it in the body.
- Declared outputs use their declared names in the caller unless aliased. `out.display_name="signed_in_name"` maps the declared output to a caller variable. Use different aliases for repeated calls whose outputs must both survive.
- A skill's `Set` step may assign internal variables or declared outputs, but cannot assign to its own input parameters.
- A nested `[skill: auth/mfa ...]` is still resolved from the skills root, not from the calling skill's subfolder. Cycles are errors.
- Prefer explicit parameters over accidental access to a caller's variables. Put setup needed by a skill in its steps; do not assume test-only metadata or hooks in a skill establish a new test run.

## Tools: deterministic code and external work

Use a project tool for fixture setup/cleanup, API calls needing exact request construction, OTP retrieval from a test service, calculations, array processing, downloads, and complex Playwright interactions. A prose step cannot invoke arbitrary Node.js functions or host plugins.

Tools run against the test's live `page`, `context`, and `browser`. They can use `context.request`, installed libraries, `step.getVar`, `step.setVar`, `step.expect`, and report logging. Tool calls have no implicit retry; implement bounded polling in the tool when needed.

### A small tool

Create `tools/src/new_id.ts`:

```typescript
import { randomUUID } from 'node:crypto';

export default () => randomUUID();
```

Call it with `[tool: new_id out.new_id="request_id"]`, then use `{{request_id}}`. A bare function's return value is its single output, named after the tool. `out.request_id` would request a nonexistent declared output; it is not an arbitrary capture-name shortcut.

`tool(...)` from `steptix/tools` offers the same single-return-output style with a typed scope argument. Its caller arguments are not automatically coerced to schema types. Use `defineTool` when you need validated numbers, booleans, arrays, defaults, or multiple outputs.

### A typed tool with an array and an explicit output

Create `tools/src/sum_amounts.ts`:

```typescript
import { defineTool } from 'steptix/tools';

export default defineTool({
  name: 'sum_amounts',
  description: 'Sum numeric fixture amounts',
  parameters: {
    amounts: { type: 'number[]' },
  },
  outputs: {
    total: { type: 'number' },
  },
  run({ amounts }, { step }) {
    step.expect(amounts.length > 0, 'At least one amount is required');
    step.setVar('total', amounts.reduce((sum, amount) => sum + amount, 0));
  },
});
```

```markdown
# Sum fixture amounts

## Steps
1. [tool: sum_amounts amounts=[10,20,5] out.total="expected_total"]
2. Assert that {{expected_total}} equals 35
```

`defineTool` supports `string`, `number`, `boolean`, and arrays of those scalar types. Parameters without `default` are required. Set declared outputs with `step.setVar`; do not expect returning an object from `run` to publish outputs. `step.expect(false, message)` fails the tool. Variables are stored as strings, with arrays JSON-encoded; an array-typed input decodes a captured array at the boundary.

Ensure `tests.toolsDir` points to the module directory (default `./tools/src`) and the tools project has its dependencies installed. The [README tool setup](../README.md#one-time-setup) gives a standalone TypeScript project layout.

### Invocation grammar for skills and tools

| Form | Meaning |
| --- | --- |
| `email="alice@example.test"` | Double-quoted string literal. |
| `email="{{email}}"` or bare `email` | Runtime variable reference. |
| `timeoutMs=30000`, `enabled=true` | Number or boolean literal; typed tools coerce against their schema. |
| `amounts=[10,20,5]` | Inline JSON array for an array-typed tool parameter. |
| `urls="{{invoice_urls}}"` | Pass a JSON-encoded list capture into a typed array parameter. |
| `out.total` | Keep the declared output name `total`. |
| `out.total="expected_total"` | Rename declared output `total` to caller variable `expected_total`. |

`[use ai]` is not an invocation and takes no arguments: `[use ai timeout=30] …` is a parse error. The step it asks goes after the `]`, and the name it stores under goes in `[store as: name]`.

Use lowercase `[skill: ...]` and `[tool: ...]` (the keyword is case-sensitive), one invocation per step. The colon is optional for these two forms, but including it makes malformed calls fail clearly; without it, a malformed call silently becomes prose for the model. Separate arguments with spaces, not commas. String values require double quotes; `email=alice`, `email='alice'`, and `email={{email}}` are not supported string forms. There is no embedded-double-quote escape mechanism for the quoted scalar form; pass complex values through a variable or fixture instead. Do not append another action after the closing bracket. A leading descriptive label is allowed but is metadata, not an extra executable instruction.

Tool paths differ from skill paths:

- `[tool: check_health]` selects the tool `check_health` in `tools/src/check_health.ts`.
- `[tool: strings/upper text="hello"]` selects the exported tool `upper` in `tools/src/strings.ts`.
- `[tool: auth/login/login ...]` selects tool `login` in `tools/src/auth/login.ts`.

The final path segment is the tool name; preceding segments identify the module without its extension. A leading slash is not accepted for tools. Use the actual declared tool/output names, which may differ from a module filename. Do not assume an arbitrary named export can always be resolved by its bare name.

## Hooks, conditional steps and loops

The CLI file runner supports hooks before `## Steps`. Do not assume equivalent hook execution in the Sessions/MCP path; its current request assembly and session loop do not carry out these file hooks, and they issue no warning that the hooks were dropped.

```markdown
## Hooks
- before: Navigate to /login
- beforeEach: If a session warning toast is visible, close that toast
- afterEach: Verify no fatal error overlay is visible
- after: Sign out if the account menu is available
```

`before` runs once before the flow; `beforeEach` and `afterEach` wrap steps; `after` is best-effort teardown. Tools and skills can be called from hooks. Keep essential outcome assertions in the main flow: an `after` failure is logged and does not flip a passing test to failed. An `afterEach` failure, by contrast, aborts the test.

`[no-hooks]` skips the per-step hooks, not the once-per-test hooks. For expanded sections/skills, put it on the **invocation** to cover the body, for example `1. [no-hooks] Inspect warning dialog`. A marker inside a section body is stripped and does not independently disable its hooks.

Implementation caveat: older hook documentation mentions `hooks: replace` and `- beforeEach: none` as overrides. The current Markdown frontmatter parser does not preserve `hooks`, and `none` adds no hook rather than clearing project defaults. Do not rely on those forms to disable configured defaults; use verified project configuration and invocation-level `[no-hooks]` as appropriate.

Conditional language comes in two forms, and one word tells them apart: an `If` line containing `then` is a **decision** the framework dispatches; an `If` line without `then` is a **watch** that waits for a page state to appear. Neither makes the file a general programming language.

Two further step forms sit outside both and are documented in §3.6 and §3.7 of [test-writing-handbook.md](test-writing-handbook.md): an `If … then` line whose tail is `return`, `stop` or `fail the test with error "…"` is a flow-control step rather than a decision, and any ordinary step may end `otherwise fail the test with message "…"` (rename its failure) or `otherwise continue` (fail without stopping the run).

The watch form is unchanged. Steps beginning with `If ...` and containing no `then`, plus every step beginning with `When prompted ...` or `When asked ...` — `then` changes the meaning of an `If` only, so `When prompted for MFA, then enter the code` is still a watch — are grouped as alternative outcomes with the next nonconditional step as continuation. The executor re-reads the page until one alternative matches, one is selected, the rest are skipped, then the continuation runs. Do not write consecutive watch steps expecting every matching condition to execute independently — they are alternatives, and exactly one of them runs.

For example, after submitting a sign-in form:

```markdown
## Steps
1. Click Sign in
2. If a Remember this device prompt appears, choose Not now
3. Wait for the Dashboard heading to appear
4. Verify the Dashboard heading is visible
```

Keep watch bodies to self-contained browser instructions and use a normal browser wait or assertion as continuation. A `[tool: ...]`, `[skill: ...]` or section name inside a watch clause is still not conditional dispatch: the line is prose and the model performs what it can of it.

The decision and loop forms are six numbered-line kinds, each ending in a **tail** that is exactly one step — a `### Section` name, a `[skill: ...]`, a `[tool: ...]`, a `Set {{x}} to "..."`, or a plain browser instruction. A body of more than one step goes in a section, and that is also the only way to nest one decision inside another. Nothing is indented; indented sub-lists are not steps.

```markdown
## Steps
1. Navigate to /invoices/4471
2. If the Cash checkbox is ticked, then Pay with cash
3. Else if the Card checkbox is ticked, then Pay by card
4. Otherwise, Verify the Pay now button is disabled
5. While the Next button is enabled, Go to the next page
6. Repeat Click Load more until the Load more button is gone, up to 20 times
7. Read the name of every account in the Your accounts panel [store as: accounts]
8. For each {{account}} in {{accounts}}, Check the account

### Pay with cash
1. Click Pay now
2. Verify the receipt says "Paid in cash"

### Pay by card
1. Click Pay now
2. Verify the receipt says "Paid by card"

### Go to the next page
1. Click the Next button

### Check the account
1. Verify the Your accounts panel has a row for "{{account}}" showing a balance
```

Rules that decide whether a line parses and what it does:

- An `If` opens a chain that any number of `Else if` lines and at most one final `Otherwise` (or `Else`) may continue, on consecutive step lines. Every condition in the chain is put to the model in one call after the page settles — unless every condition in it is literal, when the chain is decided from the values with no call at all — the first that holds wins, and every other member and every step of its tail is marked skipped. A decision is made once — a false answer is an answer, not something to wait for. With nothing holding and no `Otherwise`, the chain is skipped and the run continues.
- `While <condition>, <tail>` asks before each pass; `Repeat <tail> until <condition>` asks after each one. Both stop at a cap: the line's own `, up to N times`, or `execution.maxLoopIterations` from `steptix.config.json` (25 by default). Reaching the cap **fails the loop line**; a cap is a bug net, not the way a loop is meant to end.
- `For each {{item}} in {{list}}, <tail>` needs `{{list}}` to hold a JSON array, which is what a plural capture ("every", "all", "each") stores, what a table read stores as row records, or what an array-typed tool returns. A `Set` produces text, and a comma-separated string fails the line rather than being split on a guessed delimiter. Over records, the tail's body also reads `{{item.<alias>}}` and `{{item._row}}` — see "Reading a table into row records" above.
- Splitting is positional, so reword rather than fight it: the condition of an `If` or `Else if` ends at the first ` then `, a `While` condition ends at the first comma, and a `Repeat` tail ends at the first ` until `.
- Each evaluation costs one model call — unless every condition in it is literal (see "Conditions in the body are cheap" under "Reading a table into row records" above), when it costs none — so a three-pass `While` costs four, and a plain-instruction tail costs a further call to perform it. `If a cookie banner appears, reject it` is cheaper as a watch.

So embedding a skill or tool in an `If` clause is no longer the thing to avoid — it is the point of the `then` form. Reach for a tool when the branching is arithmetic, string parsing, or anything the page cannot be asked about in a `Verify` sentence, and for a table under a section when the list of cases is fixed and authored rather than read off the page.

For an explicitly attended test, `1. [input: otp] Enter the one-time code` captures the person's answer as `{{otp}}`; `1. [interactive] Complete the manual setup` opens interactive steering. These require a compatible interactive runner. They are not suitable substitutes for automated setup in CI. An `[input: ...]` line placed *between* members of a chain is refused at parse time, because the batch split would put the halves of one decision in different requests; put it inside the tail's section body instead.

## Running and validating generated tests

Run commands from the **test project's root**, with the framework and required browsers installed and the chosen AI backend configured. From this framework's source checkout, `npm run dev -- run ...` invokes the source CLI.

```bash
npx steptix list
npx steptix run tests/login.md
npx steptix run tests/login.md --env staging --headless
npx steptix run tests/smoke/ --tag smoke
npx steptix run tests/login-matrix.md --env staging --row 2
```

`--row` is one-based. Comma-separated `--tag` filters use AND logic. Review the generated report for actual assertions, captured values, failures, skipped branches, and any AI healing of compiled code. A test that requires an input prompt is not unattended merely because it launches headlessly.

For repeated execution, `npx steptix compile tests/login.md --env staging` can record and compile eligible steps to a neighbouring `.steps.ts` file. Compilation runs the flow, including replay, so use repeatable fixture state. It is optional; Markdown remains the authored test. Some steps stay AI-driven. Do not promise a run will be AI-free unless every executed step has a working deterministic path. `--fail-on-healed` on `run` can make CI fail when broken code-behind was repaired through AI fallback.

### When the authoring AI has the framework MCP server

The framework's `steptix mcp` server exposes tools to an external AI host. Read that host's current tool schemas before calling them; these are host calls, not `[tool: ...]` entries in Markdown.

| MCP tool | How it helps author tests |
| --- | --- |
| `list_test_files` | Discover real project tests. |
| `run_test_file` | Run a saved file's steps and sections; takes an absolute `path`, optional `env_name` and `parameters`. Observe the parity limits below. |
| `run_steps` | Explore with an array of step strings and optional `parameters`, `config`, and `env_name`. Reuse the returned session ID as `session_id` to preserve browser state and captures. |
| `get_page_content` | Inspect a session's text or cleaned DOM to ground labels and expectations. |
| `get_last_run`, `get_run_settings` | Inspect the report/token summary and effective execution settings. |
| `list_sessions`, `close_session` | Manage the sessions created for exploration. |
| `start_cdp_browser`, `list_cdp_browsers` | Discover or start a persistent test browser when an existing sign-in is required. Use returned profiles/ports, not guessed identifiers. |
| `peek_tab` | Inspect an existing tab before deciding what to drive. |
| `run_errand` | Perform a temporary task in an existing tab. It refuses skill/tool invocations and a `session_id`, leaves no session or variable scope behind, and is not a replacement for validating a saved test. |
| `navigate_tab`, `focus_cdp_tab`, `close_cdp_tab`, `log_into_site`, `server_status` | Also available: open a URL in a tab with no model turn, bring a CDP tab to the front or close it, run a sign-in flow, and check the server. |

Only use a real, permitted project root; omit `project_root` when the server already has the correct project. A projectless session has no project skills/tools catalogue. Ad-hoc steps also do not automatically import a saved test's section definitions, tables, and hooks: validate the actual file afterwards.

Current MCP limits matter when assessing a green result: `run_test_file` runs only the **first row** of a top-level inline table and returns a warning; it does not expand external `dataFile` rows or execute file hooks. Use the CLI to validate the full file when those features matter, and the CLI or Steptix Native for all inline-table rows. Explicit `[input:]` and `[interactive]` steps are reported as skipped in unattended execution; other requests for clarification can fail. Read warnings and skipped steps, not just the aggregate status.

CDP uses persistent browser state. Configure `cdp` and an appropriate `cdpTab` (`new`, a zero-based index, `url~...`, `title~...`, or `active`) only from known browser details. A login test should start signed out; an already signed-in profile can bypass the behaviour it is supposed to verify.

## Final authoring checklist

- The file has a title, a `## Steps` block, and one instruction per physical line.
- Main flow appears before section definitions, and every intended section is actually called.
- Targets and expected outcomes come from the real application or supplied requirements.
- Every placeholder has a parameter, fixture, capture, loop binding, or declared output that supplies it before use, and every dotted `{{item.property}}` names a column its table read actually asked for, or is `_row`.
- Every referenced skill/tool exists, all required inputs are passed, and output aliases name real outputs.
- Environment selection, relative file paths, and fixture contents are correct for the execution project.
- Waits name observable states; assertions can fail when the requirement is violated.
- Unattended tests contain no unresolved human dependencies. A `[use computer]` test says in its prose what the machine must look like — visible unlocked desktop, mouse untouched, `desktop.enabled: true` — and brings its target window forward itself.
- Specialised or external operations use implemented tools, not invented natural-language capabilities.
- Every `[use ai]` step names its value, carries in its own text everything the model needs (the date included), and is not a value that must repeat run to run — that is a tool.
- The delivery distinguishes “written”, “parser-checked”, and “executed successfully”.

## Implementation references

Use these when extending or checking this guide. Source and tests take precedence over older design stories.

| Topic | Source |
| --- | --- |
| Markdown, metadata, sections, and tables | [markdown.ts](../src/parser/markdown.ts), [frontmatter.ts](../src/parser/frontmatter.ts), [data-rows.ts](../src/parser/data-rows.ts), [step-lines.ts](../runner-core/src/step-lines.ts) |
| Variables and assignments | [parameters.ts](../src/parser/parameters.ts), [set-step.ts](../src/parser/set-step.ts), [interpolate-env-data.ts](../src/parser/interpolate-env-data.ts) |
| Skill scope and invocation grammar | [expander.ts](../src/skills/expander.ts), [invocation-parser.ts](../src/parser/invocation-parser.ts) |
| Tool signatures, lookup, and execution | [types.ts](../src/tools/types.ts), [registry.ts](../src/tools/registry.ts), [executor.ts](../src/tools/executor.ts), [finalise.ts](../src/tools/finalise.ts) |
| Supported AI actions and interpretation | [types.ts](../src/ai/types.ts), [prompts.ts](../src/ai/prompts.ts), [step-executor.ts](../src/runner/step-executor.ts) |
| Table reads: action validation and extraction | [action-parser.ts](../src/ai/action-parser.ts), [actions.ts](../src/browser/actions.ts), [SPEC-structured-table-reads.md](specs/SPEC-structured-table-reads.md) |
| Computer mode: surface switch, screen actions, window lookup | [SPEC-use-computer.md](specs/SPEC-use-computer.md), [control-line.ts](../src/parser/control-line.ts), [invocation-parser.ts](../src/parser/invocation-parser.ts) |
| Watches, decisions, loops, hooks, and test execution | [step-grouper.ts](../src/runner/step-grouper.ts), [control-line.ts](../src/parser/control-line.ts), [control-flow.ts](../src/runner/control-flow.ts), [hooks.ts](../src/runner/hooks.ts), [test-runner.ts](../src/runner/test-runner.ts) |
| MCP inputs and limitations | [schemas.ts](../src/mcp/schemas.ts), [assemble.ts](../src/mcp/assemble.ts) |
| Defaults and application context | [defaults.ts](../src/config/defaults.ts), [loader.ts](../src/context/loader.ts) |
