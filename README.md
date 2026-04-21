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
npx ai-ui-auto run

# Run a specific test file
npx ai-ui-auto run tests/login-flow.md

# Run a directory of tests
npx ai-ui-auto run tests/smoke/

# Filter by tags
npx ai-ui-auto run --tag smoke,login

# Headless mode
npx ai-ui-auto run --headless

# Use a specific browser
npx ai-ui-auto run --browser firefox

# Load environment variables from .env.staging
npx ai-ui-auto run --env staging
```

### List tests

```bash
npx ai-ui-auto list
```

### Initialize a new project

```bash
npx ai-ui-auto init
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
npx ai-ui-auto ui

# Specify a tests directory
npx ai-ui-auto ui ./my-tests

# With environment
npx ai-ui-auto ui --env staging

# With custom config
npx ai-ui-auto ui --config ./custom.config.ts
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
- `[interactive] optional hint` -- opens an interactive REPL for ad-hoc commands (type `done` to continue)

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
  ├─ [interactive]  → REPL until "done"
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

Create `ai-ui-auto.config.ts` in your project root:

```typescript
import { defineConfig } from 'ai-ui-automation';

export default defineConfig({
  browser: {
    headed: true,
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1280, height: 720 },
    browser: 'chromium',
  },
  tests: {
    dir: 'tests',
    contextDir: 'context',
  },
  execution: {
    timeout: 60000,
    retries: 1,
  },
});
```

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
