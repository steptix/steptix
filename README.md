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

## Configuration

Create `ai-ui-auto.config.ts` in your project root:

```typescript
import { defineConfig } from 'ai-ui-automation';

export default defineConfig({
  browser: {
    headed: true,
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
