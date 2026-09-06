# AI guide to writing runnable natural-language tests

Use this document as context for an AI that generates tests for **ai-ui-automation** (`aiui`, also used by TestBench). It describes the implementation in this repository, checked on 2026-09-06. If the framework changes, check the source references at the end before assuming the grammar is unchanged.

The output is a Markdown test file, optionally accompanied by reusable Markdown skills, TypeScript tools, and fixture data. Ordinary steps are interpreted by AI against the live browser and executed through Playwright. Special forms such as skill calls, tool calls, and variable assignments are handled by the framework. Natural language is flexible; the surrounding file and invocation syntax is not.

## Instructions for the test-writing AI

1. Read the target project's `aiui.config.json`, relevant `context/**/*.md`, existing tests, skills, and tools before writing a test. Directory names below are defaults and can be configured.
2. Use observed UI labels, supplied requirements, and existing application context. Do not invent URLs, selectors, API endpoints, accounts, expected values, skill names, or tool signatures.
3. Write one bounded instruction per numbered step. An action plus its completion condition is a useful single step: `Click Save and wait for the Saved message`.
4. Make the expected result explicit. A successful click is not evidence that the business requirement passed. Add a `Verify` or `Assert` step with a concrete expected value or state.
5. Supply every referenced input before use, and explicitly name every captured value that later steps need. Use placeholders for values that change between runs.
6. Reuse an existing skill or tool only after reading its file. If a required helper does not exist, create it within the requested scope or identify it as a missing dependency. Calling a plausible name does not create a helper.
7. For unattended runs, resolve all parameters and avoid `[input: ...]`, `[interactive]`, and instructions that require a human answer.
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
| `aiui.config.json` | Browser, AI, execution, directory, reporting, and cache settings. |
| `reports/` | Generated HTML reports by default. |

Framework skills and tools are project files. They are separate from skills/plugins installed in the authoring AI's host. A host tool such as an email connector is not automatically available inside an `aiui` test.

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

Use these authoring conventions for consistent CLI and TestBench behaviour:

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
| `## Config` bullet list | `baseUrl`, `timeout`, `viewport`, `cdp`, `cdpTab`, `consoleLogLevel`, `serverFileLogLevel`, `unmask`. |
| `## Parameters` bullet list | `- name: value`, referenced in steps as `{{name}}`. |

`viewport` accepts `mobile` (390×844), `tablet` (768×1024), `desktop` (1440×900), or a size such as `1280x720`. It changes page dimensions, not touch support, user agent, or full mobile-device emulation. Do not combine a per-test viewport with `cdp`.

Use `baseUrl` to establish the application's base address and explicit navigation steps to show the intended starting page. Relative navigation URLs resolve against the configured base. Do not assume a `## Config` key also creates a general-purpose test variable; declare inputs in `## Parameters` when needed.

## Supported browser instructions

These are natural-language examples, not literal command keywords. The model chooses supported actions from the current page. Describe the target by label and context; use a selector only when you have verified it.

| Capability | Example step text |
| --- | --- |
| Navigation | `Navigate to /orders` |
| Clicking | `Click Edit in the row for order {{order_id}}` |
| Text entry | `Type "{{email}}" into the Email field` |
| Native select or custom dropdown | `Select Australia from the Country dropdown` |
| Checkbox or toggle | `Check the I agree checkbox` |
| Hover | `Hover over Products to reveal its menu` |
| Keyboard | `Press Enter in the Search field` |
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

Text entry normally replaces a field's contents; say explicitly when you need a different keyboard interaction. Scope repeated labels to their form, dialog, section, or row. For example, `Click Save in the Shipping address dialog` is more reliable than `Click Save`.

Tabs share their browser session. A separately opened browser supports independent actors/logins. `main` is the original tab label; `default` is the original browser label. Use explicit names for new tabs and browsers instead of guessing generated tab numbers. The standard close-page action does not close the main tab.

Upload paths are resolved relative to the **test file's directory**, including upload steps expanded from a skill. Prefer forward slashes. Create or supply the fixture files; a path in prose does not generate a file. The upload action handles file inputs and file-chooser controls, not arbitrary operating-system UI.

The engine uses the DOM and can also use screenshots when configured. Do not promise pixel-perfect visual regression, native desktop automation, accessibility audits, or arbitrary JavaScript execution as built-in natural-language test assertions. Implement specialised checks in tools when appropriate. Downloads, drag-and-drop choreography, and native browser-dialog handling should use a verified project tool when the standard action vocabulary is insufficient.

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

Use exact text, contains, starts-with, counts, and numeric comparisons intentionally. State the relevant currency, format, or tolerance if it affects the result. Value-only assertions can compare captured variables without querying the DOM. Assertion checks use generated/cached checking code; a completed action or a model's narrative is not itself an assertion. Failed assertions fail the step.

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

The framework also supports a prefix such as `[output: order_id] Read the order number`, and natural-language `store as {{order_id}}`. `[as: name]` appears in existing tests. For reusable skills, use **`[store as: name]`**: the current skill expander explicitly rewrites that form for output aliases and internal scope, but does not rewrite `[as: name]` or `[output: name]`. An aliased skill output using those alternative markers can retain the wrong name.

Reading link text and reading its `href` are different operations. Say which one you need. List captures are stored as JSON-encoded arrays. A read can extract a substring with a regex; describe the desired substring precisely, or use a tool for deterministic parsing. Do not rely on the AI remembering a value that was never captured.

`Set {{name}} to "template"` is a deterministic string assignment with no AI call. It resolves existing placeholders, fails for unresolved references, and can store an empty string. It performs no arithmetic or expression evaluation: `"{{count}} + 1"` stores text. The authored template must be double-quoted with no embedded double quotes or trailing instruction. Use a tool for calculations and transformations.

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

Keep real credentials in the environment, not in generated Markdown or fixtures. Never type `***` as a password: it is a redaction marker. Secret-like names are masked by the framework. `unmask` is for a deliberately nonsecret value whose name was mistakenly classified as secret, not for exposing credentials.

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

All main-flow steps must precede the first `###` section. A section body runs only when called; it shares the caller's variables. Sections can call other sections or skills, but recursion/cycles are rejected. Use unique, descriptive names; reserved headings such as `Steps`, `Config`, and `Parameters` cannot be section names. Use the CLI or TestBench Native for sections; the legacy Monaco client refuses sectioned files.

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
- Every declared parameter is required at the call site. Text after `- parameter:` in a skill is descriptive; it does **not** supply an optional default.
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

`tool(...)` from `ai-ui-automation/tools` offers the same single-return-output style with a typed scope argument. Its caller arguments are not automatically coerced to schema types. Use `defineTool` when you need validated numbers, booleans, arrays, defaults, or multiple outputs.

### A typed tool with an array and an explicit output

Create `tools/src/sum_amounts.ts`:

```typescript
import { defineTool } from 'ai-ui-automation/tools';

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

Use lowercase `[skill: ...]` and `[tool: ...]`, one invocation per step. The colon is optional for these two forms, but including it makes malformed calls fail clearly. Separate arguments with spaces, not commas. String values require double quotes; `email=alice`, `email='alice'`, and `email={{email}}` are not supported string forms. There is no embedded-double-quote escape mechanism for the quoted scalar form; pass complex values through a variable or fixture instead. Do not append another action after the closing bracket. A leading descriptive label is allowed but is metadata, not an extra executable instruction.

Tool paths differ from skill paths:

- `[tool: check_health]` selects the tool `check_health` in `tools/src/check_health.ts`.
- `[tool: strings/upper text="hello"]` selects the exported tool `upper` in `tools/src/strings.ts`.
- `[tool: auth/login/login ...]` selects tool `login` in `tools/src/auth/login.ts`.

The final path segment is the tool name; preceding segments identify the module without its extension. A leading slash is not accepted for tools. Use the actual declared tool/output names, which may differ from a module filename. Do not assume an arbitrary named export can always be resolved by its bare name.

## Hooks and conditional steps

The CLI file runner supports hooks before `## Steps`. Do not assume equivalent hook execution in the Sessions/MCP path; its current request assembly and session loop do not carry out these file hooks.

```markdown
## Hooks
- before: Navigate to /login
- beforeEach: If a session warning toast is visible, close that toast
- afterEach: Verify no fatal error overlay is visible
- after: Sign out if the account menu is available
```

`before` runs once before the flow; `beforeEach` and `afterEach` wrap steps; `after` is best-effort teardown. Tools and skills can be called from hooks. Keep essential outcome assertions in the main flow: an `after` failure is logged and does not flip a passing test to failed.

`[no-hooks]` skips the per-step hooks, not the once-per-test hooks. For expanded sections/skills, put it on the **invocation** to cover the body, for example `1. [no-hooks] Inspect warning dialog`. A marker inside a section body is stripped and does not independently disable its hooks.

Implementation caveat: older hook documentation mentions `hooks: replace` and `- beforeEach: none` as overrides. The current Markdown frontmatter parser does not preserve `hooks`, and `none` adds no hook rather than clearing project defaults. Do not rely on those forms to disable configured defaults; use verified project configuration and invocation-level `[no-hooks]` as appropriate.

Conditional language is supported, but is not a general programming language. Steps beginning with `If ...`, `When prompted ...`, or `When asked ...` can be grouped as alternative outcomes with the next nonconditional step as continuation. One matching alternative is selected; unmatched alternatives are skipped, then the continuation runs. Do not write consecutive conditionals expecting every matching condition to execute independently.

For example, after submitting a sign-in form:

```markdown
## Steps
1. Click Sign in
2. If a Remember this device prompt appears, choose Not now
3. Wait for the Dashboard heading to appear
4. Verify the Dashboard heading is visible
```

Keep conditional bodies self-contained browser instructions and use a normal browser wait/assertion as continuation. Do not embed `[tool: ...]` or `[skill: ...]` in an English `If` clause to simulate conditional dispatch. Use a tool for complex branching or dynamic iteration; use table-driven sections for a fixed list of repeated cases.

For an explicitly attended test, `1. [input: otp] Enter the one-time code` captures the person's answer as `{{otp}}`; `1. [interactive] Complete the manual setup` opens interactive steering. These require a compatible interactive runner. They are not suitable substitutes for automated setup in CI.

## Running and validating generated tests

Run commands from the **test project's root**, with the framework and required browsers installed and the chosen AI backend configured. From this framework's source checkout, `npm run dev -- run ...` invokes the source CLI.

```bash
npx aiui list
npx aiui run tests/login.md
npx aiui run tests/login.md --env staging --headless
npx aiui run tests/smoke/ --tag smoke
npx aiui run tests/login-matrix.md --env staging --row 2
```

`--row` is one-based. Comma-separated `--tag` filters use AND logic. Review the generated report for actual assertions, captured values, failures, skipped branches, and any AI healing of compiled code. A test that requires an input prompt is not unattended merely because it launches headlessly.

For repeated execution, `npx aiui compile tests/login.md --env staging` can record and compile eligible steps to a neighbouring `.steps.ts` file. Compilation runs the flow, including replay, so use repeatable fixture state. It is optional; Markdown remains the authored test. Some steps stay AI-driven. Do not promise a run will be AI-free unless every executed step has a working deterministic path. `--fail-on-healed` on `run` can make CI fail when broken code-behind was repaired through AI fallback.

### When the authoring AI has the framework MCP server

The framework's `aiui mcp` server exposes tools to an external AI host. Read that host's current tool schemas before calling them; these are host calls, not `[tool: ...]` entries in Markdown.

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
| `run_errand` | Perform a temporary task in an existing tab. It refuses skill/tool invocations and is not a replacement for validating a saved test. |

Only use a real, permitted project root; omit `project_root` when the server already has the correct project. A projectless session has no project skills/tools catalogue. Ad-hoc steps also do not automatically import a saved test's section definitions, tables, and hooks: validate the actual file afterwards.

Current MCP limits matter when assessing a green result: `run_test_file` runs only the **first row** of a top-level inline table and returns a warning; it does not expand external `dataFile` rows or execute file hooks. Use the CLI to validate the full file when those features matter, and the CLI or TestBench Native for all inline-table rows. Explicit `[input:]` and `[interactive]` steps are reported as skipped in unattended execution; other requests for clarification can fail. Read warnings and skipped steps, not just the aggregate status.

CDP uses persistent browser state. Configure `cdp` and an appropriate `cdpTab` (`new`, a zero-based index, `url~...`, `title~...`, or `active`) only from known browser details. A login test should start signed out; an already signed-in profile can bypass the behaviour it is supposed to verify.

## Final authoring checklist

- The file has a title, a `## Steps` block, and one instruction per physical line.
- Main flow appears before section definitions, and every intended section is actually called.
- Targets and expected outcomes come from the real application or supplied requirements.
- Every placeholder has a parameter, fixture, capture, or declared output that supplies it before use.
- Every referenced skill/tool exists, all required inputs are passed, and output aliases name real outputs.
- Environment selection, relative file paths, and fixture contents are correct for the execution project.
- Waits name observable states; assertions can fail when the requirement is violated.
- Unattended tests contain no unresolved human dependencies.
- Specialised or external operations use implemented tools, not invented natural-language capabilities.
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
| Branches, hooks, and test execution | [step-grouper.ts](../src/runner/step-grouper.ts), [hooks.ts](../src/runner/hooks.ts), [test-runner.ts](../src/runner/test-runner.ts) |
| MCP inputs and limitations | [schemas.ts](../src/mcp/schemas.ts), [assemble.ts](../src/mcp/assemble.ts) |
| Defaults and application context | [defaults.ts](../src/config/defaults.ts), [loader.ts](../src/context/loader.ts) |
