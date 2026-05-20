# ai-ui-automation

AI-powered UI test automation using natural language Markdown test files. Write tests in plain English, and an AI model interprets each step using Playwright to drive the browser.

## Prerequisites

- Node.js >= 18
- npm

## Install

```bash
npm install
```

## CLI Usage

### Run tests

```bash
# Run all tests in the default tests/ directory
npx aiui run

# Run a specific test file
npx aiui run tests/login-flow.md

# Run a directory of tests
npx aiui run tests/smoke/

# Filter by tags
npx aiui run --tag smoke,login

# Headless mode
npx aiui run --headless

# Use a specific browser
npx aiui run --browser firefox

# Load environment variables from .env.staging
npx aiui run --env staging
```

### List tests

```bash
npx aiui list
```

### Initialize a new project

```bash
npx aiui init
```

## Runner UI

The Runner UI is an Electron-based desktop application for visually running, debugging, and stepping through tests with breakpoints and live AI output.

### Quick start (production build)

```bash
npm run ui
```

This builds everything (TypeScript + Vite renderer) and launches the Electron app. Pass arguments after `--`:

```bash
npm run ui -- --testsDir ./my-tests --configPath ./my-config.ts
```

### Dev mode (hot-reload)

```bash
# Build TypeScript first
npm run build

# Start Vite dev server + Electron together
npm run dev:ui
```

The renderer hot-reloads as you edit React components. Restart is needed for main process changes.

### Via the CLI

```bash
# Build everything first
npm run build:all

# Launch with default tests/ directory
npx aiui ui

# Specify a tests directory
npx aiui ui ./my-tests

# With environment
npx aiui ui --env staging

# With custom config
npx aiui ui --config ./custom.config.ts
```

### UI Features

- **File explorer** -- browse and open test files
- **Tabbed editor** -- edit multiple files with Markdown syntax highlighting
- **Breakpoints** -- click the gutter on any step line to set a breakpoint
- **Step over** -- execute one step at a time
- **Execution pointer** -- drag the yellow arrow to skip or revisit steps
- **Steering window** -- type free-form instructions while paused at a breakpoint (same as `[interactive]` mode)
- **Live output** -- AI reasoning, sub-actions, and screenshots update in real time per step

## Build Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript (main process + CLI) |
| `npm run build:ui` | Build the renderer with Vite |
| `npm run build:all` | Build both TypeScript and renderer |
| `npm run ui` | Build all and launch the Runner UI |
| `npm run dev:ui` | Dev mode with hot-reload for the renderer |
| `npm run dev` | Run the CLI directly via tsx (no build needed) |
| `npm test` | Run the test suite |
| `npm run lint` | Type-check without emitting |
| `npm run clean` | Remove build artifacts |

## Test File Format

Tests are Markdown files with YAML frontmatter:

```markdown
---
tags: [smoke, login]
timeout: 60s
---

# Login Flow Test

## Config
- baseUrl: https://app.example.com

## Parameters
- username: admin@test.com
- password: $ENV_PASSWORD

## Steps
1. Navigate to the login page
2. Login with "{{username}}" and "{{password}}"
3. Verify the dashboard shows a welcome message
4. Click logout
```

### Special step prefixes

- `[input: variable_name] prompt text` -- pauses for user input, stores as `{{variable_name}}`
- `[interactive] optional hint` -- opens an interactive REPL (commands are `/`-prefixed: `/continue` advance, `/resume` jump to any step, `/screenshot` capture, `/help` for the full list)
- `[skill: name args]` -- inline a reusable named sequence of steps from your `skills/` directory (see [Skills](#skills))
- `[tool: name args]` -- run deterministic TypeScript code with full Playwright access (see [Tools](#tools))

## Tools

Tools are deterministic TypeScript functions you can call from a test step. They are how you escape natural-language prose into real code when:

- The work isn't on the page — fetching an OTP from a test inbox, signing a JWT, hashing a password, calling a backend API to seed test data.
- The action is mechanically tricky for the AI — HTML5 drag-and-drop, file downloads, multi-page choreography that races on Playwright events.
- You want determinism — anything the AI shouldn't decide on the fly.

A tool gets the live Playwright `page`, `context`, and `browser` (the same instances the rest of the test uses), reads/writes the test's variable scope, and is callable from any step or skill via `[tool: name ...]` — including the same shorthand syntax skill calls support.

### Project layout

Tools live in their own TypeScript subproject so they get the full IDE experience (autocomplete, typecheck, lint) without polluting the test markdown. A typical project looks like this:

```
my-test-project/
├── aiui.config.json        ← framework config
├── tests/
│   └── login-flow.md             ← natural-language tests
├── skills/
│   └── login_via_otp.md          ← reusable step macros
└── tools/                        ← own JS project
    ├── package.json              ← own deps
    ├── tsconfig.json             ← own TS config
    └── src/
        ├── uuid.ts               ← rung 1 (bare function)
        ├── check_health.ts       ← rung 2 (`tool()` helper)
        └── fetch_otp.ts          ← rung 3 (`defineTool({...})`)
```

The `tools/` folder is just a path. Point `tests.toolsDir` at any directory you like — alongside the tests, in a sibling repo, or `node_modules/@your-org/test-tools/dist` if you want a versioned shared catalogue across projects.

### One-time setup

Inside your test project's `tools/` directory:

**1. Create `tools/package.json`**

```json
{
  "name": "my-project-tools",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "ai-ui-automation": "^1.0.0",
    "playwright": "^1.59.1",
    "typescript": "^5.5.0"
  }
}
```

**2. Create `tools/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"]
}
```

**3. Install**

```bash
cd tools
npm install
```

That's it. VS Code now autocompletes `context.request.`, `page.locator(...)`, etc. inside your tool files.

**4. Tell the framework where the tools live**

In `aiui.config.json`:

```json
{
  "tests": {
    "toolsDir": "./tools/src"
  }
}
```

(`./tools/src` is the default — you only need this entry if you want a different path.)

### Writing a tool

Three ways to write a tool, in order of ceremony. Pick whichever fits the job; you can mix them in the same project freely.

#### Rung 1 — bare function (zero ceremony)

The filename becomes the tool name. Whatever the function returns becomes the single output, named after the tool. No imports needed.

```ts
// tools/src/uuid.ts
import crypto from 'node:crypto';

export default () => crypto.randomUUID();
```

Call it from a test:

```markdown
1. [tool: uuid out.id]
2. Verify the request id was {{id}}
```

#### Rung 2 — `tool()` helper (recommended for most cases)

`tool()` is a thin wrapper that gives you full IDE autocomplete on the destructured scope without any type annotation. The single argument is a `ToolScope`: framework values (`page`, `context`, `browser`, `step`, `log`, `args`) plus all caller-supplied args spread to the top level for direct destructuring.

```ts
// tools/src/check_health.ts
import { tool } from 'ai-ui-automation/tools';

export default tool(async ({ baseUrl, context }) => {
  const res = await context.request.get(`${baseUrl}/health`);
  return res.ok();
});
```

Call it from a test:

```markdown
## Steps
1. [tool: check_health baseUrl out.healthy]
2. Assert {{healthy}} is "true"
```

You can put multiple tools in one file via named exports — the export key serves as the tool name:

```ts
// tools/src/strings.ts
import { tool } from 'ai-ui-automation/tools';

export const slugify = tool<{ s: string }>(({ s }) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

export const upper = tool<{ s: string }>(({ s }) => s.toUpperCase());
```

Both `[tool: slugify s="Hello World"]` and `[tool: upper s="quiet"]` work.

#### Rung 3 — `defineTool({...})` (full schema)

When you want a parameter schema with types, multiple outputs, descriptions for the report, or validation at startup:

```ts
// tools/src/fetch_otp.ts
import { defineTool } from 'ai-ui-automation/tools';

export default defineTool({
  name: 'fetch_otp',
  description: 'Fetch the most recent 6-digit OTP from a test inbox',
  parameters: {
    email:     { type: 'string', description: 'inbox to read' },
    timeoutMs: { type: 'number', default: 30000 },
  },
  outputs: {
    otp: { type: 'string' },
  },
  async run({ email, timeoutMs }, { step, log }) {
    log.info(`polling inbox for ${email}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`https://test-inbox.local/${email}/latest`);
      const body = (await res.json()) as { body: string };
      const match = body.body.match(/\b(\d{6})\b/);
      if (match) {
        step.setVar('otp', match[1]);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('timed out waiting for OTP');
  },
});
```

### Calling a tool

Tool calls support the same shorthand syntax as skill calls:

```markdown
## Steps
1. [tool: fetch_otp email]                              ← bare arg = "{{email}}"
2. [tool: fetch_otp email="alice@test.local"]           ← explicit value
3. [tool: fetch_otp email out.otp]                      ← capture under declared name
4. [tool: fetch_otp email out.otp="primary_otp"]        ← capture under alias
```

Tool calls are also valid inside skills (`skills/*.md`) and inside hooks (`## Hooks` section), so you can mix them freely with natural-language steps.

### What a tool can do

Inside `run` (rung 3) or the function body (rung 1/2), you have:

| Name      | Type                         | What it is |
|-----------|------------------------------|---|
| `page`    | `playwright.Page`            | The page the test is currently driving |
| `context` | `playwright.BrowserContext`  | Cookies, storage, `.request`, `.pages()` |
| `browser` | `playwright.Browser`         | For opening incognito contexts, etc. |
| `step`    | `{ getVar, setVar, expect }` | Reads/writes the test's variable scope |
| `log`     | `{ info, warn, error }`      | Lands entries in the HTML report |
| `args`    | `Record<string, unknown>`    | Full bag of caller-supplied args (rung 2 only) |

Tool failures abort the step (no implicit retries — tool errors are deterministic, not flakiness). Every tool call appears in the HTML report with its args, duration, captured outputs, and any logs.

## How it works: execution pipeline

When you run a test, here's what happens end to end:

```
.md File
  ↓
[Parser: src/parser/markdown.ts]
  ├─ gray-matter → frontmatter (tags, timeout, dataFile)
  ├─ marked lexer → tokenize body
  └─ Extract: title, config (baseUrl), parameters, steps (string[])
       ↓
[src/runner/test-runner.ts — resolveParameters()]
  ├─ $ENV_VAR  → process.env lookup (or .env file)
  ├─ dataFile  → expand into one TestInstance per CSV/JSON row
  └─ Prompt    → ask user for any unresolved values
       ↓
[runTest() — step loop]
  ├─ [input: var]   → prompt user, store value
  ├─ [interactive]  → REPL until /continue (or /resume / /exit)
  └─ Normal step    → executeStep()
       ↓
[src/runner/step-executor.ts — executeStep()]
  1. captureDomSnapshot()   — walk live DOM, extract interactive elements + positions
  2. captureScreenshot()    — Playwright PNG → base64
  3. Build AI prompt        — system prompt (rules + context) + prior steps + DOM + screenshot
  4. POST to AI model       — returns { actions: [...], reasoning: "..." }
  5. Execute each action    — Playwright browser automation (see table below)
  6. Assertion keywords?    — second AI call to evaluate pass/fail
  7. On failure             — retry (up to 2×) with failure context appended to prompt
       ↓
[src/report/generator.ts]
  └─ Self-contained HTML report with screenshots, AI responses, pass/fail per step
```

### AI action types

| Action | What Playwright does |
|--------|---------------------|
| `click` | `locator(selector).click()` |
| `type` | `locator.clear()` + `locator.fill(value)` |
| `navigate` | `page.goto(url)` |
| `wait` | `waitForSelector()` or `waitForTimeout()` |
| `select` | `locator.selectOption(value)` |
| `scroll` | `page.evaluate()` scroll |
| `hover` | `locator.hover()` |
| `keyboard` | `page.keyboard.press()` |
| `upload` | `locator.setInputFiles(filePath)` |
| `api_call` | HTTP fetch (with session cookies or standalone) |
| `assert` | Second AI call evaluates pass/fail against DOM + screenshot |

### Key source files

| Component | Files |
|-----------|-------|
| Parsing | `src/parser/markdown.ts`, `frontmatter.ts`, `parameters.ts` |
| Running | `src/runner/test-runner.ts`, `step-executor.ts`, `retry.ts` |
| AI | `src/ai/client.ts`, `prompts.ts`, `action-parser.ts` |
| Browser | `src/browser/manager.ts`, `actions.ts`, `dom-cleaner.ts`, `screenshot.ts` |
| CLI | `src/cli/commands/run.ts`, `src/index.ts` |
| Config | `src/config/loader.ts`, `src/env/loader.ts` |
| Reports | `src/report/generator.ts`, `template.ts` |
| Runner UI | `src/ui/` (Electron app) |

## Configuration

Create `aiui.config.json` in your project root:

```json
{
  "$schema": "https://raw.githubusercontent.com/pkent/ai-ui-automation/main/schema/aiui.config.schema.json",
  "browser": {
    "headed": true,
    "viewport": { "width": 1280, "height": 720 },
    "windowSize": { "width": 1280, "height": 720 },
    "browser": "chromium"
  },
  "tests": {
    "dir": "tests",
    "contextDir": "context"
  },
  "execution": {
    "timeout": 60000,
    "retries": 1
  }
}
```

The optional `"$schema"` key gives editors autocomplete and validation. Secrets such as `AI_API_KEY` live in `.env`, never in this file.

### Environment variables

Some settings are read from `.env` (see [.env.example](./.env.example) for the full list):

| Variable | Purpose |
| --- | --- |
| `AI_API_KEY` | API key for the aiapi gateway. Required. The runner now uses aiapi v2 endpoints. |
| `AI_MODEL` | Overrides `ai.model` from the config file. Optional — falls back to the project default when unset. |
| `SERVER_API_KEY` | Shared secret between the API server and Flick. Required. |
| `INTERACTIVE_ON_FAILURE` | `true`/`false`. Pause the runner on failure so you can inspect the browser. |
| `OPEN_REPORT_IN_BROWSER_AFTER_RUN` | `true`/`false`. Open the generated HTML report in your OS default browser after `run` completes. Skipped automatically when `CI` is set. |
| `APPEND_RUN_HISTORY_TO_TEST_FILE` | `true`/`false`. Append a "Latest runs" section at the bottom of each test `.md` file after it runs, linking to its HTML report (keeps the most recent 10). Default `false`. |
| `AIUI_DATA_DIR` | Directory (relative to your project root) holding per-environment JSON test data files. Defaults to `fixtures/data`. |

### Per-environment configuration

Your tests project can live anywhere — it doesn't have to be inside this repo. The framework resolves all paths relative to **the directory you run the CLI from** (`process.cwd()`).

A typical external tests project looks like:

```
aitests/
├── .env                    # base config — shared across all envs (e.g. AI_API_KEY, AIUI_DATA_DIR)
├── .env.local              # env-specific secrets / URLs (BASE_URL, passwords, …)
├── .env.staging
├── .env.uat
├── fixtures/data/          # default data dir (override path with AIUI_DATA_DIR)
│   ├── local.json          # structured test data for `--env local`
│   ├── staging.json
│   └── uat.json
└── tests/
    └── my-test.md
```

Run from that directory:

```bash
cd ~/projects/aitests
aiui run tests/my-test.md --env staging
```

#### Where each setting lives

- **Base `.env`** — loaded first, shared across all envs. Put your AI API key, `AIUI_DATA_DIR`, and any other settings that don't change between environments here.
- **`.env.<name>`** — loaded on top of the base when you pass `--env <name>` (or pin the test with `env: <name>` in its frontmatter). Holds env-specific secrets and URLs as flat key/value strings. Reference these in tests as `${env.BASE_URL}`.
- **`<AIUI_DATA_DIR>/<name>.json`** — env-specific structured test data (users, fixtures, thresholds). Reference values in tests as `${data.users.admin.email}`. JSON string leaves of the form `$VAR_NAME` are resolved against `process.env`, so secrets stay in `.env.<name>` and the JSON references them.

Both layers are env-scoped via the same `<name>` suffix. The data folder is optional — tests that don't use `${data.*}` placeholders run fine without it.

#### Why two layers (`.env` + JSON)?

`.env` is flat key/value strings — good for secrets and URLs. JSON is nested/structured — good for users, fixture catalogues, assertion thresholds. Keeping them separate lets you check the JSON into git while keeping secrets out.

#### Per-test data sources (named namespaces)

Sometimes a test wants data from a file outside `<AIUI_DATA_DIR>` — a shared catalogue maintained by another team, or a one-off override that lives next to the test. Declare named **data sources** in the frontmatter:

```markdown
---
env: staging
dataSources:
  vip:   ~/shared/vip-users.json     # absolute / `~` paths work
  local: ./vip-checkout.data.json    # relative paths resolve against the .md file's directory
---

## Steps
1. Login as "${data.users.admin.email}"          # env default — fixtures/data/staging.json
2. Switch to VIP "${vip.users.platinum.email}"   # ~/shared/vip-users.json
3. Place order ${local.fixtures.orderTotal}      # ./vip-checkout.data.json
```

Each entry registers a placeholder namespace `${<name>.X.Y}`. Each step reads from exactly one source — no merging. The standard `${env.X}` and `${data.X.Y}` namespaces still work alongside.

- **Path resolution:** `~/...` expands to your home directory, absolute paths are used as-is, relative paths resolve against the test `.md` file's directory (so tests stay portable when the suite moves).
- **`$VAR` in JSON:** Secret resolution runs on every namespace. A leaf like `"$VIP_PWD"` in the VIP catalogue is replaced with `process.env.VIP_PWD` — populated from `.env.<envName>`. Same rule that already applies to the env-default data file.
- **Reserved names:** `env` and `data` are taken by the built-in namespaces; any other identifier-shaped name is fine.
- **Errors:** A missing source file is a hard error (you explicitly named it). An unknown path inside a declared source (e.g. `${vip.users.platinum.emial}`) throws at parse time, naming the test file. Unknown namespaces (e.g. `${foo.bar}` when no `foo` source is declared) pass through unchanged for backwards compatibility.

See [stories/data-sources-namespaces.md](./stories/data-sources-namespaces.md) for the full design.

### Browser sizing

`viewport` and `windowSize` are used differently depending on whether the browser is headless or headed.

- `windowSize` is used for headed (`headed: true`) runs
- `viewport` is used for headless (`headed: false`) runs

In other words:

- headed / non-headless: the real browser window is sized from `windowSize`, and Playwright uses `viewport: null`
- headless: the page render surface is sized from `viewport`, and `windowSize` is not used

#### What `windowSize` means

`windowSize` is the outer browser window size.

That includes browser chrome such as:

- title bar
- tabs
- toolbar
- window borders

So if `windowSize` is `1280x720` in headed mode, the visible page content area inside the window will be smaller than `1280x720`.

#### What `viewport` means

`viewport` is the page content area size that Playwright renders into.

That does not mean the outer browser window size. It means the inner page area used for:

- responsive breakpoints
- element positions
- screenshots
- layout/rendering

This is especially important in headless mode, where there is no real native browser window and Playwright needs a deterministic render size.

#### Why the split exists

Using a fixed Playwright `viewport` inside a headed browser window can cause visible resize or flashing behaviour on some platforms, because the native browser window and the emulated page viewport are not the same thing.

In practice, this showed up as the browser briefly shrinking and resizing on each navigation or action during headed runs on macOS. The browser appeared to "flash" even though the test logic itself was fine.

To avoid that:

- headed mode uses `windowSize`
- headless mode uses `viewport`
