# Steptix — Technical Specification v1.0

**Author:** Greg (AI Tech Lead) / Paul Kent
**Date:** 2026-03-26
**Status:** Draft

---

## 1. Overview

**steptix** is a CLI tool that executes UI tests written in natural language (Markdown). It uses Playwright to drive a browser and an AI model (via the aiapi gateway) to interpret instructions, interact with the DOM, evaluate assertions, and produce detailed HTML reports.

### Core Principles

- Tests are authored in plain Markdown — no selectors, no page objects, no code
- AI reasons about each step using cleaned DOM snapshots and screenshots
- Every sub-action is logged with screenshots, DOM state, and AI reasoning
- Handles multi-step instructions, multi-page flows, popups, iframes, and file uploads

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLI (Entry Point)                 │
│  npx steptix run tests/ --tag smoke --headless   │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│                   Test Runner                        │
│  - Discovers .md files                              │
│  - Parses frontmatter (tags, config)                │
│  - Loads context files from context/                │
│  - Resolves parameters (inline, env, data files)    │
│  - Orchestrates step execution                      │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│                  AI Step Executor                    │
│  - Sends step + DOM snapshot + screenshot to AI     │
│  - Receives planned sub-actions                     │
│  - Executes each sub-action via Playwright          │
│  - Captures screenshot + DOM after each sub-action  │
│  - Evaluates assertions via AI                      │
│  - Handles retries (1 retry before failure)         │
│  - Dismisses unexpected obstacles automatically     │
│  - Prompts user on ambiguity                        │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌──────────────────────────┐    ┌─────────────────────┐
│   Playwright Browser     │    │   aiapi Gateway     │
│  - Headed (default)      │    │  POST /v2/vision    │
│  - Headless (--headless) │    │  POST /v2/stream    │
│  - Multi-page, popups    │    │  Model: gpt-5.4     │
│  - iframes, file upload  │    │  Input: 1M tokens   │
└──────────────────────────┘    └─────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│                  Report Generator                    │
│  - HTML report with embedded screenshots            │
│  - DOM snapshots per sub-action                     │
│  - AI reasoning trace                               │
│  - Extracted assertion values                       │
│  - Failure screenshots with AI explanation          │
│  - Output: ./reports/<timestamp>-<test-name>.html   │
└─────────────────────────────────────────────────────┘
```

---

## 3. Test File Format

Test files are Markdown with YAML frontmatter. Located in a user-specified directory (default: `tests/`).

### Example: `tests/login-flow.md`

```markdown
---
tags: [smoke, login, critical]
timeout: 60s
---

# Login Flow Test

## Config
- baseUrl: https://app.example.com
- timeout: 30s

## Parameters
- username: admin@test.com
- password: $ENV_PASSWORD

## Steps
1. Navigate to the login page
2. Login with "{{username}}" and "{{password}}"
3. Verify the dashboard shows a balance greater than $0
4. Click on "Transaction History" and verify at least 3 transactions are listed
5. Logout and verify the login page is displayed
```

### Frontmatter Fields

| Field     | Type     | Default | Description                          |
|-----------|----------|---------|--------------------------------------|
| `tags`    | string[] | `[]`    | Tags for filtering test execution    |
| `timeout` | string   | `60s`   | Max duration for the entire test     |

### Sections

| Section        | Required | Description                                                |
|----------------|----------|------------------------------------------------------------|
| `# Title`      | Yes      | Test name (H1 heading)                                     |
| `## Config`    | No       | Test-level configuration (baseUrl, timeout overrides)      |
| `## Parameters`| No       | Key-value pairs, supports `$ENV_VAR` and `{{placeholder}}` |
| `## Steps`     | Yes      | Ordered list of natural language instructions               |

### Parameter Resolution Order

1. Inline value in the Parameters section
2. Environment variable (prefixed with `$`)
3. Data file (see Section 4)
4. Prompt user at runtime if unresolved

### Special Step Prefixes

Steps can use special prefix syntax to control execution behaviour:

#### `Set {{name}} to "…"` — Assign a Variable

Stores a value built from values the run already holds. The right-hand side is a double-quoted template; every `{{name}}` and `${env.X}` / `${data.x}` inside it resolves against the run at that step, and the result is stored under the target name.

```markdown
## Steps
1. Read the available balance [as: balance]
2. Set {{summary}} to "{{username}} had {{balance}} available"
```

Runs as code: no AI call and no page interaction. The value is text only — nothing inside the quotes is evaluated beyond substitution, and it may not contain a double quote.

A `{{name}}` the run cannot resolve fails the step, naming it, rather than storing the literal. `Set {{name}} to` claims the line, so a malformed one (no quotes, or text after the closing quote) is a parse error rather than prose sent to the model; `Set the filter to Recent` names no variable and remains an ordinary AI step.

The target must be a runtime variable. A skill's own `## Parameters`, and the columns of a table under a `### Section`, are interpolated into the step text at expansion time rather than kept as variables, so assigning to one is refused at parse time. A test's `## Parameters` and the columns of a table under `## Steps` are runtime values and may be assigned freely.

#### `[use ai] <step>` — Ask the Model for a Value

Sends the rest of the step, with its placeholders filled in, to the model **on its own** — no page, no DOM, no screenshot, no earlier steps, no date — and stores the value it answers with (stories/use-ai-step.md).

```markdown
## Steps
1. [use ai] Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name
2. [use ai] Today is {{today}}. Give the date 3 days later as yyyymmdd [store as: days_from_now]
3. Type "{{random_name}}" into the Name field
```

- **Asked on every run.** Never compiled into code-behind, and a hand-written `.steps.ts` entry for its text is never run. A value that must be the same every time is a tool's job.
- **The step text is everything the model knows.** Put the date, or anything else it needs, in the step. A secret-named value that fills a placeholder reaches the model as `***` (by the `## Values` block's rule, `## Config: unmask:` included), and an unresolved `{{name}}` or `${…}` fails the step before any model call.
- **A poor source of randomness.** "Random" may repeat between runs.
- **The name.** `[store as: x]`, `[as: x]`, `[output: x]` or prose `store as {{x}}` pins it, and the model's own name is then ignored. With none, the model's name is used only if the step says it as a whole word (case-insensitive); otherwise the step fails, naming both fixes. The check rules out invented names, not unnamed steps: a step that never names its value can be stored under any word of its sentence. More than one name is refused. Inside a skill the name must be `[store as: x]` or `store as {{x}}`.
- **The reply.** The model answers `{"as": name, "value": v}` or `{"error": reason}`. An `error` fails the step with the reason and is not retried; any other shape, an empty value, or a list or object is retried within `execution.retries`.
- `[use ai]` must open the step (after an optional `[no-hooks]`), takes no arguments, and cannot be a control line's tail. The `capture` event for its value carries `source: "generated"`.

#### `[input: variable_name]` — Pause for User Input

Pauses test execution and prompts the user to enter a value in the terminal. The value is stored as a named parameter that can be referenced in subsequent steps using `{{variable_name}}` interpolation. This is useful for values that cannot be known ahead of time, such as OTP codes, CAPTCHAs, or approval codes.

```markdown
## Steps
1. Navigate to the login page
2. Enter "user@example.com" and click Send OTP
3. [input: otp_code] Enter the OTP code sent to your phone
4. Type "{{otp_code}}" into the verification field and submit
5. Verify the dashboard is visible
```

At step 3, the test pauses and the user sees:

```
🔑 User input required:
  Enter the OTP code sent to your phone: _
```

The text after the `[input: name]` prefix is used as the prompt message. If omitted, a default prompt is shown. The step is marked as passed once the user provides a value.

#### `[interactive]` — Interactive REPL Mode

Opens an interactive prompt where the user can type free-form natural language instructions that are executed as AI-driven steps in real time. This turns the test into a live exploration session — useful for debugging, investigating page state, or performing ad-hoc actions mid-test.

```markdown
## Steps
1. Navigate to the login page
2. Login with "admin@test.com" and "password123"
3. [interactive] Explore the dashboard
4. Logout and verify the login page is displayed
```

At step 3, the test pauses and the user enters a REPL:

```
🎮 Interactive mode — Explore the dashboard
   Type /help for commands, /continue to advance, /exit to abort.
> Click on the Settings menu
✓ ad-hoc step passed
> Verify the account name shows "John Smith"
✓ ad-hoc step passed
> /continue
```

Each instruction is executed as a full AI step with screenshots, DOM snapshots, and retry logic. Conversation history accumulates across interactive commands so the AI maintains context.

REPL commands (all `/`-prefixed):

| Command       | Effect                                                  |
| ------------- | ------------------------------------------------------- |
| `/continue`   | Leave the REPL and run the next step.                   |
| `/resume`     | Open a menu to jump to any step in the test.            |
| `/screenshot` | Capture the current page into the report on demand.     |
| `/list`       | Print numbered step list with current-step marker.      |
| `/help`       | Show command list.                                      |
| `/exit`       | Abort the entire run (alias: `/quit`).                  |
| *(any other)* | Executed as a single ad-hoc Flick step.                 |

If any interactive command fails, the overall step is marked as failed. The same REPL is also opened automatically when a step fails after retries — see the `interactiveOnFailure` execution config (env var `INTERACTIVE_ON_FAILURE=true`) for the post-failure handoff. In that mode the REPL banner reads "🛑 Step failed" instead of "🎮 Interactive mode" and the `/resume` menu defaults to the step after the failure.

### Inline Sections

An `### Name` heading **inside `## Steps`** defines a named block of reusable steps — an inline skill, without the separate file or the parameter declarations. A step invokes it by writing the section's name as its **entire text**; the bare name *is* the call.

```markdown
## Parameters
- username: $LOGIN_USERNAME
- password: $LOGIN_PASSWORD

## Steps
1. Login
2. Add the first product to the cart
3. Checkout
4. Login
5. Verify the order confirmation shows "Thank you"

### Login
1. Navigate to {{baseUrl}}/login
2. Type "{{username}}" into the username field
3. Type "{{password}}" into the password field
4. Click Sign in and verify the dashboard loads

### Checkout
1. Open the cart
2. Click the checkout button
```

Here steps 1 and 4 both call `### Login`, and step 3 calls `### Checkout`. Each call expands inline to the section's body before the run, so the runner, the report, and Steptix's debugger see the fully-expanded flow.

**When to use a section instead of a skill:** a section groups steps *within one test* and shares the test's scope — no parameters, no outputs, no second file. Reach for a skill when a block is shared *across* tests or genuinely needs its own inputs.

**Grammar**

- A section's body is every numbered item from its `### Name` heading until the next `###`/`##` heading or end of file. A `####` heading with text inside a body is inert prose; a hashes-only line (`###`, `####`, …) is an error (empty name).
- The **main flow** is the numbered items *before the first `###`*. It cannot resume after a section begins — once the first `###` appears, every later numbered item belongs to a section.
- A section may call other sections in the same file, and may call skills. Skill files follow the same grammar, so a skill body may define and invoke its own sections.
- Sections are macros, not functions: **no per-section `## Parameters`/`## Outputs`**, and a section invoked twice runs twice. A `[store as: X]` inside a test-file section body is visible to every later step of the test.

**Matching** is on the step's raw text (minus the `N. ` prefix), trimmed and **case-insensitive** — `Login`, `login`, and `LOGIN` all call `### Login`. Inline markdown is *not* normalized: `1. **Login**` is an ordinary AI step, not a call. A step that parses as `[skill:]`, `[tool:]`, `[input:]`, or `[interactive]` is never a section call. A trailing period or a typo is a near-miss, not a call — Steptix squiggles those as "Did you mean…?" while you type.

**Names** may contain spaces (`### Log in as admin`). Refused at parse time: a reserved H2 keyword (`Steps`, `Config`, `Parameters`, `Outputs`, `Hooks`), a name beginning with `[`, a name containing `{{`, an empty name, and a duplicate (case-insensitively) within one file.

**Editor support.** Steptix runs sectioned files with full debug parity — gutter status on body lines, breakpoints inside a body, step-into a section, and a call stack that names it — plus go-to-definition, links, completion, and the diagnostics above. TestBench (Monaco), the legacy variant, has no sections support and refuses to run a sectioned file (STX026) rather than mis-run it; use Steptix or the CLI.

Hooks never resolve to sections: a `## Hooks` entry or a project `defaultHooks` entry equal to a section name stays an ordinary AI step.

---

## 4. Parameterisation

### Inline Parameters

```markdown
## Parameters
- username: admin@test.com
- password: $ENV_PASSWORD
```

### Data Files

For data-driven tests, reference a JSON or CSV data file:

```markdown
---
tags: [data-driven]
dataFile: data/users.json
---

# Multi-User Login Test

## Steps
1. Navigate to the login page
2. Login with "{{username}}" and "{{password}}"
3. Verify the welcome message contains "{{displayName}}"
```

`data/users.json`:
```json
[
  { "username": "admin@test.com", "password": "admin123", "displayName": "Admin User" },
  { "username": "viewer@test.com", "password": "viewer123", "displayName": "Viewer" }
]
```

The test runs once per data row. Each run appears as a separate entry in the report.

### Environment Variables

Any parameter value starting with `$` is resolved from the environment:
- `$ENV_PASSWORD` → `process.env.ENV_PASSWORD`

---

## 5. Context Files

Auto-discovered from the `context/` directory (relative to project root). All `.md` files in `context/` are loaded and sent to the AI as system context before test execution begins.

### Purpose

Provide application-specific knowledge so the AI understands the app:

### Example: `context/app-overview.md`

```markdown
# MyApp Overview

MyApp is a financial dashboard application.

## Login Page
- URL: /login
- Has email and password fields
- The "Sign In" button is disabled until both fields are filled
- After login, redirects to /dashboard
- Failed login shows a red banner with "Invalid credentials"

## Dashboard
- Shows account balance in the top-right card
- Balance format: "$X,XXX.XX"
- Navigation menu is on the left sidebar
- "Transaction History" is the 3rd menu item

## Known Quirks
- A cookie consent banner appears on first visit — click "Accept All" to dismiss
- The session expires after 15 minutes of inactivity
```

### Loading Rules

- All `.md` files in `context/` are loaded alphabetically
- Subdirectories are supported: `context/pages/login.md`
- Context is included in the AI system prompt for every step
- Total context size is tracked against the 1M token input limit

---

## 6. AI Interaction Model

### Step Execution Flow

For each natural language step:

```
1. Capture current state
   - Clean DOM snapshot (simplified, see §6.2)
   - Screenshot (PNG, viewport size)

2. Send to AI
   - System prompt: context files + test metadata
   - Conversation history: prior steps and outcomes
   - Current step instruction
   - Current DOM snapshot
   - Current screenshot (base64)

3. AI responds with action plan
   - List of sub-actions to execute
   - Each sub-action: { action, selector, value?, description }

4. Execute each sub-action
   - Perform via Playwright
   - Capture screenshot + DOM after execution
   - Log to report

5. After all sub-actions
   - If step contains assertion: send final state to AI for evaluation
   - AI returns: { pass: boolean, actual: string, explanation: string }

6. On failure
   - Collect failure context: failed selector, error message, element match count
   - Retry once with enriched context (see §6.7)
   - The retry prompt includes a "Previous Attempt Failed" section telling the AI which selectors were tried, how many elements matched, and why they failed — so it picks a different approach
   - If retry fails: capture failure screenshot, AI explains what it was trying to do, mark step as FAILED

7. All raw AI responses (action plan, clarification, assertion) are captured and included in the report (see §9)
```

### 6.1 AI Action Types

The AI returns structured JSON actions. Supported types:

| Action      | Fields                          | Description                     |
|-------------|----------------------------------|---------------------------------|
| `click`     | `selector`, `description`       | Click an element                |
| `type`      | `selector`, `value`, `description` | Type text into a field       |
| `select`    | `selector`, `value`, `description` | Select dropdown option       |
| `navigate`  | `url`, `description`            | Navigate to URL                 |
| `upload`    | `selector`, `filePath` or `filePaths`, `description` | Upload one or more files; the path is relative to the test file's folder |
| `hover`     | `selector`, `description`       | Hover over element              |
| `wait`      | `condition`, `timeout`, `description` | Wait for condition or duration |
| `scroll`    | `direction`, `amount`, `description` | Scroll the page             |
| `switchFrame` | `selector`, `description`     | Switch to iframe               |
| `dismiss`   | `selector`, `description`       | Dismiss popup/modal/banner     |
| `assert`    | `condition`, `expected`, `description` | Evaluate an assertion     |
| `keyboard`  | `key`, `description`            | Press keyboard shortcut         |
| `prompt`    | `question`, `description`       | Ask user for clarification      |

### 6.2 DOM Snapshot Cleaning

Full DOM is too large for AI context. The cleaner produces a simplified representation:

**Included:**
- Interactive elements: `<input>`, `<button>`, `<a>`, `<select>`, `<textarea>`, `<label>`
- Visible text content (trimmed)
- Element roles and aria attributes
- Form structure
- Semantic landmarks (`<nav>`, `<main>`, `<header>`, `<footer>`)
- `data-testid` and `id` attributes
- Element visibility state
- **Hidden-element placeholders**: elements hidden via `display: none` or `aria-hidden="true"` (and `input[type=hidden]`) are collapsed to a tag-only placeholder with a `<!-- hidden: reason -->` comment, attributes dropped. This keeps sibling positions (`nth-of-type`) stable while making non-rendered duplicates (e.g. a mobile nav on desktop) untargetable.

**Excluded:**
- Inline styles and CSS classes (unless semantically meaningful)
- Script and style tags
- SVG paths and complex SVG internals
- Hidden elements' attributes and content (collapsed to the tag-only placeholders above)
- Decorative elements without text or interaction

**Output format:** Indented HTML-like structure; iframes carry a selector comment for the `frame` field, hidden elements collapse to placeholders, and long repetitive runs collapse to omission markers.

**Example output:**
```
<nav role="navigation">
  <a href="/login" role="button"> Log In </a>
</nav>
<nav role="navigation"><!-- hidden: display:none --></nav>
```

### 6.3 Obstacle Handling

When the AI encounters unexpected elements (cookie banners, modals, alerts):

1. AI identifies the obstacle
2. Attempts to dismiss it (click "Accept", "Close", "X", "OK", etc.)
3. Logs the dismissal as a sub-action
4. Continues with the original step
5. If dismissal fails, flags it and continues if possible

### 6.4 Wait Actions

The `wait` action supports several condition types:

| Condition Format | Behaviour | Example |
|-----------------|-----------|---------|
| CSS selector | Waits for element to appear in DOM | `#dashboard`, `.loading-spinner` |
| URL pattern | Waits for navigation to URL | `https://app.example.com/dashboard`, `/dashboard` |
| `networkidle` | Waits for network activity to settle | `networkidle` |
| `load` | Waits for page load event | `load` |
| Duration string | Sleeps for the specified time | `30s`, `2m`, `1m 30s` |
| Text content | Waits for text to appear on page | `Welcome back` |

Duration strings support simple and compound formats:

- Simple: `30s`, `2m`, `500ms`, `30 seconds`, `2 minutes`
- Compound: `1m 30s`, `1 min 10 sec`, `2 minutes 30 seconds`

In natural language steps, the AI is instructed to use duration format for wait/delay steps (e.g. a step like "Wait 30 seconds" produces `{ action: "wait", condition: "30s" }`).

### 6.5 Ambiguity Handling

When the AI cannot determine the correct action:

1. AI returns a `prompt` action with a question
2. CLI displays the question to the user with the current screenshot
3. User provides guidance via stdin
4. AI incorporates the answer and continues

### 6.6 Responsive Layout Handling

Many web applications render duplicate elements for mobile and desktop layouts (e.g. two navigation bars). The tool helps the AI target the correct variant through three mechanisms:

1. **Viewport and device mode in system prompt** — The AI is told the viewport dimensions and a device mode classification:
   - `≥1024px` width → `desktop`
   - `≥768px` width → `tablet`
   - `<768px` width → `mobile`
   - Example: `Viewport: 1280×720px (desktop view)`

2. **Hidden-duplicate placeholders in the DOM snapshot** — Elements hidden via `display: none` or `aria-hidden="true"` are collapsed to tag-only placeholders with a `<!-- hidden: reason -->` comment and their attributes dropped, so a non-rendered duplicate offers nothing to target:
   - Desktop nav rendered in full, with attributes and text
   - Mobile duplicate as `<nav><!-- hidden: display:none --></nav>`

   A duplicate hidden by off-screen positioning or `visibility: hidden` is *not* collapsed and appears fully in the snapshot; the screenshot is the disambiguator there.

3. **AI prompt rule** — The system prompt explicitly instructs the AI to use viewport size and device mode to disambiguate, never to target hidden placeholders, and to confirm against the screenshot which variant is actually visible.

### 6.7 Retry Context Enrichment

When a step fails and is retried, the retry is not blind — it includes context about what was already tried:

1. On action failure, the executor captures:
   - The CSS selector that was used
   - The error message
   - The number of elements that matched the selector (via `page.locator(selector).count()`)

2. On retry, a `## Previous Attempt Failed` block is appended to the step instruction, telling the AI:
   - Which selector was tried and failed
   - If 0 elements matched: "No elements matched this selector"
   - If >1 elements matched: "N elements matched — the first was used but was not the right target. Use a more specific selector."
   - Explicit instruction: "do not reuse the same selectors that failed"

3. Failure context accumulates across retries — if multiple retries are configured, each subsequent attempt sees all prior failures.

---

## 7. Configuration

### `steptix.config.json`

A plain JSON object. Every key is optional and falls back to the built-in
defaults (omitted keys, and omitted siblings of partial nested objects, inherit
from `DEFAULT_CONFIG` via a recursive deep merge). Editing inside VS Code with
the Steptix extension provides autocomplete + validation automatically (the
extension ships the schema and binds it to `steptix.config.json`); outside the
extension, an optional `"$schema"` key pointing at
`./node_modules/steptix/schema/steptix.config.schema.json` gives the same.

```json
{
  "ai": {
    "gatewayUrl": "https://llm.corp.example",
    "model": "gpt-5.4",
    "maxInputTokens": 1000000,
    "streamResponses": true
  },
  "browser": {
    "headed": true,
    "viewport": { "width": 1280, "height": 720 },
    "slowMo": 0,
    "browser": "chromium"
  },
  "tests": {
    "dir": "./tests",
    "contextDir": "./context",
    "pattern": "**/*.md"
  },
  "execution": {
    "timeout": 60000,
    "retries": 1,
    "screenshotOnFailure": true,
    "promptOnAmbiguity": true
  },
  "reports": {
    "outputDir": "./reports",
    "includeScreenshots": true,
    "includeDomSnapshots": true,
    "includeAiReasoning": true,
    "embedScreenshots": true
  }
}
```

Field notes:

- `browser.headed` defaults to `true`; override with `--headless`.
- `browser.slowMo` adds a ms delay between actions (for debugging).
- `browser.browser` is one of `'chromium' | 'firefox' | 'webkit'`.
- `execution.promptOnAmbiguity` asks the user when the AI is unsure.
- `execution.defaultHooks` can declare project-level hooks, e.g.
  `"defaultHooks": { "beforeEach": ["[skill: dismiss_obstacles]"] }`.
- `reports.embedScreenshots` toggles base64 embed vs separate files.
- Secrets (`AI_API_KEY`, etc.) live in `.env`, never in this file — they are
  injected at load time.

---

## 8. CLI Interface

### Commands

```bash
# Run all tests
npx steptix run

# Run specific test file
npx steptix run tests/login-flow.md

# Run all tests in a directory
npx steptix run tests/

# Run tests matching tag
npx steptix run --tag smoke
npx steptix run --tag "smoke,critical"   # AND logic

# Run headless
npx steptix run --headless

# Specify config
npx steptix run --config ./custom.config.ts

# Initialise project structure
npx steptix init

# List discovered tests
npx steptix list
npx steptix list --tag smoke
```

### CLI Flags

| Flag              | Type    | Default                  | Description                        |
|-------------------|---------|--------------------------|------------------------------------|
| `--config`        | string  | `steptix.config.json` | Path to config file                |
| `--tag`           | string  | —                        | Filter by tag (comma-separated)    |
| `--headless`      | boolean | `false`                  | Run browser in headless mode       |
| `--timeout`       | number  | `60000`                  | Test timeout in ms                 |
| `--reporter`      | string  | `html`                   | Reporter type                      |
| `--verbose`       | boolean | `false`                  | Verbose console output             |
| `--bail`          | boolean | `false`                  | Stop on first failure              |
| `--browser`       | string  | `chromium`               | Browser engine                     |

### `steptix init`

Scaffolds a new project:

```
my-project/
├── steptix.config.json
├── context/
│   └── app-overview.md
├── tests/
│   └── example.md
├── data/
│   └── (empty)
├── reports/
│   └── (generated)
└── package.json
```

---

## 9. HTML Report

### Structure

Each test run produces an HTML report at `./reports/<timestamp>-<test-name>.html`.

### Report Contents

```
┌─────────────────────────────────────────────────┐
│  Test: Login Flow Test                          │
│  Status: PASSED (3/3 steps)                     │
│  Duration: 24.3s                                │
│  Tags: smoke, login, critical                   │
│  Date: 2026-03-26 18:30:00 AEDT                │
├─────────────────────────────────────────────────┤
│                                                 │
│  Step 1: Navigate to the login page    ✅ PASS  │
│  ├─ Sub-action 1.1: Navigate to /login          │
│  │  ├─ Screenshot: [embedded image]             │
│  │  ├─ DOM snapshot: [collapsible]              │
│  │  └─ AI reasoning: "Navigating to baseUrl..." │
│  └─ Duration: 1.2s                              │
│                                                 │
│  Step 2: Login with credentials        ✅ PASS  │
│  ├─ Sub-action 2.1: Type username               │
│  │  ├─ Screenshot: [embedded image]             │
│  │  ├─ DOM snapshot: [collapsible]              │
│  │  └─ AI reasoning: "Found email input..."     │
│  ├─ Sub-action 2.2: Type password               │
│  │  ├─ Screenshot: [embedded image]             │
│  │  └─ AI reasoning: "Found password field..."  │
│  ├─ Sub-action 2.3: Click Sign In               │
│  │  ├─ Screenshot: [embedded image]             │
│  │  └─ AI reasoning: "Clicking submit button.." │
│  └─ Duration: 4.8s                              │
│                                                 │
│  Step 3: Verify balance > $0           ✅ PASS  │
│  ├─ Assertion result:                           │
│  │  ├─ Expected: Balance greater than $0        │
│  │  ├─ Actual: $1,234.56                        │
│  │  └─ AI explanation: "Found balance card..."  │
│  ├─ Screenshot: [embedded image]                │
│  └─ Duration: 2.1s                              │
│                                                 │
├─────────────────────────────────────────────────┤
│  Summary                                        │
│  Total steps: 3 | Passed: 3 | Failed: 0        │
│  Total sub-actions: 6                           │
│  AI tokens used: 45,231                         │
└─────────────────────────────────────────────────┘
```

### AI Responses Section

Each step includes a collapsible **AI Responses** section showing every raw AI response captured during that step. Responses are labeled by purpose:

- **action-plan** — the initial response with the list of sub-actions and reasoning
- **clarification** — the follow-up response after user answered an ambiguity prompt
- **assertion** — the assertion evaluation response

All AI responses are captured and displayed regardless of whether the step passed or failed, including responses from all retry attempts. This provides full traceability of the AI's decision-making.

### Failure Report Additions

When a step fails:
- **Failure screenshot** with visual annotation of what the AI was targeting
- **AI explanation** of what it was trying to do and why it failed
- **AI responses** from all attempts (including retries) shown in collapsible sections
- **Retry log** showing both attempts
- **DOM snapshot** at the point of failure

---

## 10. aiapi Gateway Changes

The runner now targets the provider-neutral v2 API. v1 remains available for backward compatibility, but this project should use v2.

### 10.1 `POST /v2/vision`

Multimodal chat endpoint supporting text + image content.

**Request:**
```json
{
  "model": "gpt-5.4",
  "messages": [
    {
      "role": "system",
      "content": "You are a UI test automation agent..."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Current step: Login with admin@test.com and password123\n\nDOM:\n<simplified-dom>...</simplified-dom>"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBOR..."
          }
        }
      ]
    }
  ],
  "max_tokens": 4096,
  "response_format": { "type": "json_object" }
}
```

**Response:** Provider-neutral envelope.

```json
{
  "id": "msg_01ABCXYZ",
  "object": "response",
  "created": 1776675600,
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "role": "assistant",
  "stop_reason": "end_turn",
  "content": [
    { "type": "text", "text": "{\"actions\":[],\"reasoning\":\"...\"}" }
  ],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 9,
    "total_tokens": 19
  }
}
```

**Implementation:**
- Accepts `content` as string (text-only) or array (multimodal)
- Returns provider-neutral `content[]` blocks instead of a v1 `response` string
- OpenAI and Anthropic are normalized into the same envelope
- Input token limit: 1,000,000

### 10.2 `POST /v2/stream`

Streaming chat endpoint (supports both text-only and multimodal).

**Request:** Same schema as `/v2/vision` with an implicit `stream: true`.

**Response:** Provider-neutral Server-Sent Events (SSE).

```
data: {"type":"response.start","response":{"id":"msg_01ABCXYZ","object":"response","created":1776675600,"provider":"anthropic","model":"claude-sonnet-4-5","role":"assistant"}}
data: {"type":"response.content_block.delta","index":0,"delta":{"type":"text_delta","text":"{"}}
data: {"type":"response.content_block.delta","index":0,"delta":{"type":"text_delta","text":"\"actions\""}}
data: {"type":"response.completed","response":{"id":"msg_01ABCXYZ","object":"response","created":1776675600,"provider":"anthropic","model":"claude-sonnet-4-5","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"{\"actions\":[],\"reasoning\":\"...\"}"}],"usage":{"input_tokens":10,"output_tokens":9,"total_tokens":19}}}
data: [DONE]
```

**Implementation:**
- Sets `stream: true` on upstream provider request
- OpenAI and Anthropic are normalized into provider-neutral SSE events
- Supports multimodal input (same as `/v2/vision`)
- Connection timeout: 120s
- Input token limit: 1,000,000

### 10.3 Auth

Both v2 endpoints use the same Bearer token auth as the gateway's other routes.

---

## 11. Project Structure

```
steptix/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # CLI entry point
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── run.ts            # Run command
│   │   │   ├── init.ts           # Init scaffolding
│   │   │   └── list.ts           # List tests
│   │   └── index.ts              # CLI setup (commander/yargs)
│   ├── config/
│   │   ├── loader.ts             # Load & validate config
│   │   ├── defaults.ts           # Default configuration
│   │   └── types.ts              # Config type definitions
│   ├── parser/
│   │   ├── markdown.ts           # Parse .md test files
│   │   ├── frontmatter.ts        # YAML frontmatter parser
│   │   ├── parameters.ts         # Parameter resolution
│   │   └── types.ts              # Parsed test types
│   ├── context/
│   │   └── loader.ts             # Load context/ directory
│   ├── runner/
│   │   ├── test-runner.ts        # Orchestrates test execution
│   │   ├── step-executor.ts      # Executes individual steps
│   │   └── retry.ts              # Retry logic
│   ├── ai/
│   │   ├── client.ts             # aiapi gateway client
│   │   ├── prompts.ts            # System prompts & templates
│   │   ├── action-parser.ts      # Parse AI response to actions
│   │   └── types.ts              # AI request/response types
│   ├── browser/
│   │   ├── manager.ts            # Playwright browser lifecycle
│   │   ├── dom-cleaner.ts        # DOM snapshot cleaning
│   │   ├── screenshot.ts         # Screenshot capture
│   │   ├── actions.ts            # Execute Playwright actions
│   │   └── obstacle-handler.ts   # Auto-dismiss unexpected UI
│   ├── report/
│   │   ├── generator.ts          # HTML report generation
│   │   ├── template.ts           # Report HTML template
│   │   └── types.ts              # Report data types
│   └── utils/
│       ├── logger.ts             # Console logging
│       └── tokens.ts             # Token counting/tracking
├── templates/
│   ├── report.html               # Report HTML template
│   └── init/                     # Init scaffolding templates
│       ├── config.ts.tpl
│       ├── example.md.tpl
│       └── context.md.tpl
└── tests/                        # Unit tests for the tool itself
    ├── parser.test.ts
    ├── dom-cleaner.test.ts
    └── ...
```

---

## 12. Dependencies

| Package              | Purpose                         |
|----------------------|---------------------------------|
| `playwright`         | Browser automation              |
| `commander`          | CLI framework                   |
| `gray-matter`        | YAML frontmatter parsing        |
| `marked`             | Markdown parsing                |
| `tsx`                 | TypeScript execution            |
| `chalk`              | Terminal colours                |
| `ora`                | Terminal spinners                |
| `glob`               | File discovery                  |
| `handlebars`         | HTML report templating          |
| `tiktoken`           | Token counting                  |
| `eventsource-parser` | SSE stream parsing              |

---

## 13. AI System Prompt Design

The system prompt sent to the AI for each step:

```
You are an expert UI test automation agent. You control a web browser to execute test steps described in natural language.

## Application Context
{loaded context files}

## Test Information
- Test: {test name}
- Base URL: {baseUrl}
- Current Step: {step number} of {total steps}
- Viewport: {width}×{height}px ({device mode} view)

## Your Task
Execute the following test step by returning a JSON object with an array of actions.

## Rules
1. Return ONLY valid JSON — no markdown, no explanation outside JSON
2. Each action must have: { "action": string, "description": string } plus relevant fields
3. Use CSS selectors. Prefer data-testid > id > aria-label > name > visible text
4. Many pages render duplicate elements for mobile and desktop layouts. Use the viewport size and device mode (see Test Information) to target the correct variant. Duplicates hidden with display:none or aria-hidden appear only as tag-only placeholders marked <!-- hidden: ... --> — never target those; use the screenshot to confirm which variant is visible
5. If the step requires an assertion, include an "assert" action as the last action
6. If you encounter an unexpected popup/modal/banner, include a "dismiss" action BEFORE your main actions
7. If you cannot determine what to do, return a single "prompt" action with a "question" field
8. For "assert" actions, set "condition" to what you're checking and "expected" to the expected value
9. For "navigate" actions, set "url" to the full or relative URL
10. For "type" actions, set "value" to the text to type
11. For "wait" actions, set "condition" to a CSS selector, URL pattern, keyword like "networkidle", or a duration like "30s", "2m", "1m 30s"

## Current State
Step instruction: "{step text}"

DOM Snapshot:
{cleaned DOM with position annotations}

[Screenshot is attached as an image]

## Response Format
{
  "actions": [
    { "action": "click", "selector": "#login-btn", "description": "Click the login button" }
  ],
  "reasoning": "Brief explanation of your approach"
}
```

### Retry Prompt Enrichment

On retry, a `## Previous Attempt Failed` block is appended to the step instruction:

```
## Previous Attempt Failed
The following actions were tried and failed. Choose a DIFFERENT approach — do not reuse the same selectors that failed.

- Action "click" with selector `a[role='button'][href='/login']` failed: locator.click: Error: ...
  → 3 elements matched this selector — the first one was used but it was not the right target. Use a more specific selector (e.g. scope with a parent, use :nth-of-type(), :has-text(), or combine with other attributes) to target the correct element.
```

---

## 14. Execution Flow (End to End)

```
1. CLI parses arguments
2. Load config from steptix.config.json
3. Discover test files (filtered by --tag if specified)
4. Load context files from context/
5. For each test file:
   a. Parse markdown: frontmatter, config, parameters, steps
   b. Resolve parameters (inline → env → data file → prompt user)
   c. Launch Playwright browser (headed/headless per config)
   d. Navigate to baseUrl (if specified)
   e. For each step:
      i.    Interpolate {{placeholders}} with resolved parameters
      ii.   If step has [input: name] prefix → prompt user, store value as parameter, mark passed
      iii.  If step has [interactive] prefix → enter REPL loop for user-driven commands
      iv.   Otherwise, capture DOM snapshot (with position annotations) + screenshot
      v.    Send to AI via /v2/vision (or /v2/stream), including viewport/device mode
      vi.   Parse AI response into action list
      vii.  Capture raw AI response for the report
      viii. If action is "prompt" → ask user, re-send to AI, capture response
      ix.   Execute each sub-action via Playwright
      x.    After each sub-action: capture screenshot + DOM
      xi.   If step has assertion: send final state to AI for evaluation, capture response
      xii.  On failure: collect failed selector, match count, and error context
      xiii. Retry with enriched prompt (prior failure details), then mark FAILED with explanation
      xiv.  Include all captured AI responses (from all attempts) in the report
   f. Close browser
   g. Generate HTML report
6. Print summary to console
7. Exit with code 0 (all passed) or 1 (any failed)
```

---

## 15. Future Considerations (Post-v1)

- **VS Code Test Explorer extension** — discover and run .md tests from the IDE
- **Parallel test execution** — run multiple test files concurrently
- **Video recording** — Playwright trace/video per test
- **Test generation** — AI observes manual testing and generates .md test files
- **Visual regression** — compare screenshots across runs
- **CI/CD reporters** — JUnit XML, GitHub Actions annotations
- **Shared step libraries** — reusable step definitions across tests
- **npm package** — publish to npm for `npx` usage without local install

---

## 16. Testing Strategy

### 16.1 Unit Tests (Vitest)

| Area               | What's Tested                                                      |
|--------------------|--------------------------------------------------------------------|
| Markdown parser    | Frontmatter extraction, config, parameters, steps from `.md` files |
| Parameter resolver | `$ENV_VAR`, `{{placeholder}}`, data file rows, fallback prompting  |
| DOM cleaner        | Simplified output from raw HTML, element filtering, attribute retention |
| AI response parser | Valid JSON actions, malformed responses, missing fields, edge cases |
| Token counter      | Accurate usage tracking, soft budget warnings at 100K              |
| Report generator   | Valid HTML output, correct pass/fail counts, embedded screenshots  |

### 16.2 Integration Tests

- AI client correctly constructs and sends multimodal payloads to `/v2/vision` and `/v2/stream`
- Playwright action executor maps each AI action type to correct browser operation
- Obstacle handler identifies and dismisses a known modal, then continues
- SSE stream parser handles chunked responses and `[DONE]` termination

### 16.3 End-to-End Tests

**Test target app:** A small static web app (`fixtures/test-app/`) that ships in the repo, served locally during E2E runs. The app includes:

- Login page (email + password, "Sign In" button, error banner on bad credentials)
- Dashboard with balance display (`$1,234.56`), sidebar navigation
- Transaction history page (table with 5 sample transactions)
- Cookie consent banner on first visit
- Logout button that returns to login page

**E2E test approach:**

1. Start local HTTP server serving `fixtures/test-app/`
2. Run `.md` test files against it using the real CLI
3. Real AI calls via aiapi gateway (not mocked)
4. Assert on generated HTML report: correct step count, pass/fail status, screenshots present, extracted assertion values match expected

**E2E test files:**

- `fixtures/tests/login-flow.md` — login, verify balance, logout
- `fixtures/tests/invalid-login.md` — bad credentials, verify error message
- `fixtures/tests/navigation.md` — multi-page flow through all sections
- `fixtures/tests/data-driven-login.md` — parameterised with `fixtures/data/users.json`

### 16.4 Smoke Test (External)

A standalone test that runs against a real public website to validate the tool works outside the controlled fixture environment:

- `fixtures/tests/google-search.md` — search Google and verify results (see below)

---

## 17. Design Decisions

1. **Selector strategy:** AI decides based on context, but is instructed to prefer `data-testid` > `id` > `aria-label` > `name` > visible text when multiple options exist for the same element.
2. **Token budget per step:** Soft budget of 100K tokens per step with a console warning when exceeded. No hard cap — total remains bound by the 1M input limit.
3. **Screenshot resolution:** Full viewport screenshots for v1. Element-level cropping deferred to a future version.
4. **Conversation history:** Prior steps are included as text summaries only (e.g. "Step 2: Logged in successfully, now on /dashboard"). Full DOM snapshots from prior steps are not carried forward.
5. **Responsive disambiguation:** Rather than filtering duplicate mobile/desktop elements at the DOM cleaner level (which could hide elements the AI needs), we annotate all visible interactive elements with their bounding rectangle position and let the AI decide which to target based on viewport dimensions and position context.
6. **Retry enrichment over blind retry:** Retries include full context of what failed (selector, error, match count) so the AI can adapt its approach rather than repeating the same failing action. This is more effective than simply re-running the same step.
7. **AI response capture:** All raw AI responses are captured and included in the HTML report for full traceability, even on failed steps across all retry attempts. This aids debugging and helps users understand AI decision-making.
8. **Direct Playwright over Chrome MCP:** We evaluated using Chrome MCP (Model Context Protocol) as the browser automation layer — where the AI would call standardised MCP tools (`browser_click`, `browser_type`, etc.) exposed by an MCP server wrapping Chrome DevTools Protocol — and chose direct Playwright integration instead. The rationale:

   **What Chrome MCP offers:**
   - Standardised tool interface — any MCP-compatible model can drive the browser without custom integration code
   - Reduced custom code — no need for a bespoke action executor, DOM cleaner, or screenshot pipeline
   - Ecosystem compatibility — other MCP clients (Claude Desktop, Cursor, etc.) can reuse the same browser server
   - Simpler AI prompting — the AI calls tools directly rather than outputting structured JSON that we parse and execute

   **Why direct Playwright is better suited to this use case:**
   - **Pipeline control** — We own the DOM cleaning, screenshot timing, retry logic, and token budgeting. With MCP, we are constrained to whatever the server exposes and its default behaviour
   - **Optimised context** — Our DOM cleaner strips irrelevant nodes, adds position annotations, and keeps snapshots within token budget. A generic MCP server sends back whatever it captures, with no awareness of our token constraints
   - **Test framework integration** — Assertions, reporting, step tracking, context files, and retry enrichment are test-specific concerns that sit above the browser control layer. MCP does not address these
   - **Deterministic execution** — Direct Playwright API calls give us precise control over action execution, waiters, and error handling. MCP adds a network hop and an additional abstraction layer between our executor and the browser
   - **Latency** — Direct Playwright calls are faster than JSON-RPC round-trips through an MCP server for every interaction
   - **Responsive layout handling** — Our position annotation system (§6.6) and viewport-aware prompting require tight integration between DOM cleaning and the AI prompt. An MCP server would not provide this without significant customisation

   **When Chrome MCP would be preferable:** General-purpose AI browser control, ad-hoc automation, or agent-style exploratory workflows where the AI needs flexible, open-ended browser access without a structured test framework around it.

   **Future consideration:** An alternative MCP backend could be offered as a plugin for environments where Chrome MCP is already running, but direct Playwright remains the default for structured test execution.

---

*End of specification.*
