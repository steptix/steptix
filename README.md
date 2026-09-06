# ai-ui-automation

AI-powered UI test automation using natural language Markdown test files. Write tests in plain English, and an AI model interprets each step using Playwright to drive the browser.

For AI-assisted test generation, give your AI the [test authoring guide](docs/ai-test-authoring-guide.md). It covers supported test language, variables, data-driven flows, skills, tools, and validation.

## Prerequisites

- Node.js >= 22.21 (see [Corporate networks](#corporate-networks) — proxy support relies on it)
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

### Testing the TestBench extension

The VS Code extension has two suites of its own, both run from
`testbench-native/`. Neither is covered by the root `npm test`.

| Script | Description |
|--------|-------------|
| `npm test` | Unit tests (`node --test`). Seconds, no browser |
| `npm run test:integration` | Extension tests in a real VS Code, against a fake API client. No server, no browser |
| `npm run test:live` | The full stack: real VS Code, real server, real browser, real model calls |

```bash
cd testbench-native && npm run test:live
```

That is the whole command. It builds what it needs, starts a server per
worker on a free port from 3200 up, boots the `fixtures/test-app` site on
8787, runs the suite across four VS Code instances, prints a merged report
and tears everything down — about five and a half minutes for 33 tests.

It needs `templates/.env` to carry `AI_API_KEY` and `SERVER_URL`; the model
calls are real and are billed. Useful variants:

```bash
npm run test:live -- --shards=2                       # fewer workers
npm run test:live -- --shards=1 --server=<url>        # serial, against your own server
npm run test:live -- --files=cache-replay.test.cjs    # one file
```

A run can pass with tests *skipped* rather than failed — the report counts
them out loud. The usual cause is `cdp-tab-focus`'s screenshot checks, which
skip when the browser window is occluded and Chromium stops producing frames
for it. See `CLAUDE.md` for the detail.

## MCP Server

`aiui mcp` exposes this framework to coding agents over the Model Context
Protocol, so an agent can run steps in a live browser or run a whole test file
and read structured results back.

It speaks stdio and is spawned by the agent host — you do not run it by hand.
Under the covers it is an HTTP client of the same Sessions API that TestBench
uses, so agent sessions and editor sessions share one server, one browser pool
and one cache. If no server is running it starts one for you.

### Tools

| Tool | What it does |
|------|--------------|
| `run_steps` | Run ad-hoc natural-language steps in a browser session |
| `run_test_file` | Run one `.md` test file end to end |
| `run_errand` | Drive a tab you already have open, then hand it back — no session, nothing kept |
| `list_test_files` | List the project's test files |
| `list_sessions` | List open browser sessions on the server |
| `close_session` | Close a session and its browser |
| `get_last_run` | Report path and token totals for a finished run |
| `get_page_content` | Read a session's current page — visible text, or the cleaned DOM |
| `peek_tab` | Read a tab you already have open — visible text, or the cleaned DOM — changing nothing |
| `server_status` | Health of the Sessions API server |
| `start_cdp_browser` | Launch (or return) a persistent browser you can sign into — see below |
| `list_cdp_browsers` | Which CDP browsers and profiles this project has, and their open tabs |
| `close_cdp_tab` | Close one tab in a CDP browser |
| `focus_cdp_tab` | Bring one tab of a CDP browser to the front, so you can see it |

Successive `run_steps` calls share a browser, so an agent can send a few steps,
read the result, then send a few more against the same page — with captured
variables still in scope.

### Signed-in browsers over CDP

By default every test gets a fresh, empty browser. That is the right thing for
most tests and the wrong thing for anything behind a login: re-running an SSO
or MFA flow on every run is slow, flaky, and sometimes impossible.

The fix is a browser the framework owns and you sign into **once**:

> *"Start an Edge browser over CDP"*

The agent calls `start_cdp_browser` and gets back a port. Sign in by hand in the
window that opens. From then on, steps sent with that port run in your
signed-in browser — and the login survives closing the window, restarting the
server, and restarting your editor, because it lives in a profile directory
under `.aiui/cdp-profiles/`.

```
.aiui/cdp-profiles/edge-default/     ← "start an Edge browser"
.aiui/cdp-profiles/edge-admin/       ← "…with a profile named admin"
```

**A few things that surprise people:**

- **You cannot attach to your everyday browser.** Chrome 122+ and Edge reject
  `--remote-debugging-port` on the default profile, so a normally-started
  browser has no debugging port and cannot be given one. The dedicated profile
  is not a compromise around that — signing into it once achieves the same
  thing.
- **The port changes every launch.** The browser picks its own, so there is no
  fixed 9222 to rely on. Ask `list_cdp_browsers` (or read the tool result); do
  not guess. Closing the browser does **not** lose the login — relaunching the
  same profile gives a new port and the same signed-in state.
- **The profile name is how you pick a browser.** The same name returns the
  same browser; a new name starts a separate one, with its own window, port and
  cookies. That is what makes admin-vs-user and uat-vs-prod testing possible.
- **A profile never forgets on its own.** Test a sign-in flow once and the
  profile stays signed in, so the next run skips the login page — and may pass
  without exercising it. `reset: true` wipes the profile first. It is the only
  destructive operation here and it is refused while the browser is running.

- **Tests sharing a browser are not independent.** Running several at once
  against one profile is supported and often what you want, but they share one
  set of cookies, and they see each other's tabs — a tab any of them opens is
  adopted by all of them. A test that signs out affects the others. Every step
  in the HTML report shows which tab it drove, and flags tabs that appeared
  from somewhere else, so the interference is at least visible afterwards.
  Suites that need real isolation should use ordinary launch mode.
- **Treat a CDP profile as compromised by default.** An agent driving a
  signed-in browser can reach everything that browser can, and per-step output
  goes to the model provider. Sign these profiles into test accounts, not your
  own.
- **Some sites turn the browser away.** A Chrome started with a debugging port
  tells every page it is automated (`navigator.webdriver` reads `true`, even
  with nothing attached), and some sites refuse to let such a browser sign in.
  If a site that works in your everyday browser blocks this one, that is
  usually why. `browser.cdp.hideAutomation` below launches it without that
  signal; it applies at launch, so close a running browser and start it again
  after changing it.

An agent may only drive browsers **this project launched**. Anything else — a
browser you started yourself, or one another tool left on 9222 — is refused,
and listing it withholds its tab titles and URLs. To lift that, a human edits
`aiui.config.json`:

```json
{ "mcp": { "cdp": { "allowUnowned": true } } }
```

That gate deliberately lives in a file an agent cannot write. The same goes
for whether a browser announces itself as automated:

```json
{ "browser": { "cdp": { "hideAutomation": true } } }
```

Off by default. It adds `--disable-blink-features=AutomationControlled` to the
launch, which makes pages read `navigator.webdriver` as `false` the way they
do in a Chrome you started yourself, at the cost of Chrome's yellow
"unsupported command-line flag" bar on launch (dismiss it). The file that
counts is the one in the root the browser is launched into — the project's, or
for a machine-wide browser (`scope: "user"`) the user root's own
`aiui.config.json` under `%LOCALAPPDATA%\aiui` (`~/.aiui` elsewhere). It is
deliberately not a tool argument: if a site refuses the browser, the agent is
told to raise it with you, not to work around the site.

#### Working with its tabs

`list_cdp_browsers` reports each browser's open tabs with a stable `targetId`,
and which session (if any) is driving each one. That id is the address for
everything you can do with a tab:

> *"Close the openrouter tab"*

The agent lists the tabs, works out which one you meant from the titles and
urls, and calls `close_cdp_tab` with that id. Matching is the agent's job on
purpose — there is no fuzzy matching in the tool, because closing the wrong tab
cannot be undone.

> *"Show me the openrouter tab"*

Same shape, `focus_cdp_tab`, and the tab comes to the front of the window so you
can look at it. It changes nothing else: nothing is closed, no session is
created, and a run happening in another tab keeps running — automation drives a
tab whether or not it is the visible one. So it is safe to use to watch a test
while it works, which is the usual reason to want it.

What it cannot promise is that the *window* comes forward. The browser is asked
to raise it, and Windows sometimes answers a background application's request
with a flashing taskbar button instead. If nothing appears, click the browser in
your taskbar — the right tab will be the one showing.

> *"Run the checkout steps in the tab where I set up the cart"*

Same id, passed as `config.cdp: {profile: "default", tab: "targetId:<id>"}` on a
**new** session. Without a `tab`, attaching opens a fresh tab and leaves yours
alone — which is safe, and not what you asked for. Attaching to a tab you named
brings it forward, so you watch the steps run instead of hunting for the right
tab in the strip. So does a `switchTab` step mid-run, in any headed run.

Two refusals worth knowing about:

- **A tab a session is driving cannot be closed.** Close the session first.
  This is why the tab list names the session — you can see it before you try.
- **Closing a browser's last tab closes the browser**, so it needs
  `allow_browser_exit: true`. There is no such thing as a browser with zero
  tabs, so this is the honest way to say "stop the browser". For a browser
  **this project started** nothing is lost — the profile keeps its logins and
  `start_cdp_browser` reopens it signed in. For anything else (only reachable
  with `allowUnowned` above) nothing here can reopen it, and the agent is told
  to ask you first.

To close a **window**, close its tabs — a window disappears with its last one.
A window is not a separate browser: one browser process holds any number of
windows, all sharing the profile, the port and the cookies. A separate browser
is a separate *profile*.

### Host setup

**Claude Code** — [.mcp.json](.mcp.json) is checked in; nothing to do.

**Copilot in VS Code** — [.vscode/mcp.json](.vscode/mcp.json) is checked in.

**Codex CLI** (and the Codex VS Code extension), in `~/.codex/config.toml`:

```toml
[mcp_servers.aiui]
command = "node"
args = ["c:/Projects/vibe/ai-ui-automation/dist/index.js", "mcp"]
env = { AIUI_MCP_ROOTS = "c:/Projects/vibe/ai-ui-automation" }
```

**Copilot CLI**, in `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "aiui": {
      "type": "stdio",
      "command": "node",
      "args": ["c:/Projects/vibe/ai-ui-automation/dist/index.js", "mcp"],
      "env": { "AIUI_MCP_ROOTS": "c:/Projects/vibe/ai-ui-automation" }
    }
  }
}
```

### `AIUI_MCP_ROOTS`

The directories the server is allowed to touch, separated by `;` on Windows and
`:` elsewhere. It defaults to the working directory the host spawned the server
in — fine for Claude Code and VS Code, which start it inside your project.

It is **required** for Codex CLI and Copilot CLI, whose config is machine-global
and whose spawn directory is not your project.

This is a real boundary, not a convenience: an agent names the project and test
paths it wants, and those paths decide which `.env` gets read into steps and
which directory tool code is loaded from. Anything outside the allowed roots is
refused.

### Things worth knowing

- Hosts run `dist/`, so **run `npm run build`** after changing the source — and
  once on a fresh clone, or the configs above point at a file that isn't there.
- If you let the MCP server auto-start the API server, check on it with
  `aiui status --url $SERVER_URL`. Plain `aiui status` reads
  `aiui.config.json`, which can name a different host or port than `SERVER_URL`.
- The Codex VS Code extension currently has an open bug picking up MCP servers
  from `config.toml`. Verify with Codex CLI first — a no-show in the extension
  is not a problem with this server.
- Windows Codex setups sometimes need `startup_timeout_ms` raised in
  `config.toml`.
- `aiui mcp --help` prints the full reference.

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
- viewport: mobile

## Parameters
- username: admin@test.com
- password: $ENV_PASSWORD

## Steps
1. Navigate to the login page
2. Login with "{{username}}" and "{{password}}"
3. Verify the dashboard shows a welcome message
4. Click logout
```

The optional `viewport:` key renders that test's pages at an exact size — a
preset (`mobile` 390×844, `tablet` 768×1024, `desktop` 1440×900) or an explicit
`<width>x<height>` like `390x844` — headed or headless, without affecting other
tests on the same server. It sizes the page for CSS breakpoints only (no touch,
mobile user agent, or devicePixelRatio emulation); see
[stories/per-test-viewport.md](stories/per-test-viewport.md).

### Special step prefixes

- `Set {{name}} to "text"` -- assigns a variable from other variables, with no AI call (see [Variables](#setting-a-variable))
- `[input: variable_name] prompt text` -- pauses for user input, stores as `{{variable_name}}`
- `[interactive] optional hint` -- opens an interactive REPL (commands are `/`-prefixed: `/continue` advance, `/resume` jump to any step, `/screenshot` capture, `/help` for the full list)
- `[skill: name args]` -- inline a reusable named sequence of steps from your `skills/` directory; `[skill: subfolder/name args]` for a skill in a subfolder (see [Skills](#skills))
- `[tool: name args]` -- run deterministic TypeScript code with full Playwright access (see [Tools](#tools))

For `[skill:` and `[tool:` — and only those two — the colon is optional: `[skill login]` is the same call as `[skill: login]`. (`[input:`, `[output:]` and `[interactive]` are unchanged and still need their colon.) The keyword must be followed by the colon or whitespace, so bracketed prose like `[skills]` or `[skillful]` is never mistaken for an invocation, and neither is a markdown link such as `[skill guide](./guide.md)`.

The two spellings differ in one way, deliberately. `[skill: ...]` is unambiguous intent, so a malformed one is a parse error pointing at the problem. The colon-less form is reachable by ordinary English — `Verify the [skill level: expert] badge` — so when it doesn't parse it is simply treated as prose rather than failing the file. Write the colon if you want the strict reading.

### Setting a variable

Every other way a variable gets a value reads it from somewhere outside the test — the page, a tool, a parameter, an environment file. `Set` is the one that builds a value out of values you already have:

```markdown
## Steps
1. Read the available balance [as: balance]
2. Set {{summary}} to "{{username}} had {{balance}} available"
3. Assert that "{{summary}}" contains "{{balance}}"
```

The right-hand side is always a double-quoted string. Every `{{name}}` and `${env.X}` / `${data.x}` inside it resolves against the run as it stands at that step, and the result is stored under the target name. Copying one variable to another is just `Set {{backup}} to "{{original}}"`, and `Set {{x}} to ""` clears one.

It costs nothing: no AI call, no page interaction, no action-cache entry. Notes:

- The value is text, and only text. `"{{n}} + 1"` stores those characters — arithmetic and string surgery belong in a [tool](#tools), where `regex_extract` and friends already live.
- A `{{name}}` the run cannot resolve **fails the step**, naming it. Storing the literal `{{typo}}` would pass green and break a later step instead.
- The value may not contain a double quote — there is no way to tell one inside the value from the one that closes it, and guessing would silently store the wrong text. A step like `Set {{q}} to "shoes" and search for "shoes"` is refused for the same reason.
- `Set {{name}} to` claims the line the way `[skill:` does, so a missing quote is a parse error rather than prose sent to the model. `Set the filter to Recent` names no variable and stays an ordinary AI step.
- Inside a skill you can assign to a declared `## Outputs` name or an internal one, but not to one of the skill's own `## Parameters` — a caller's arguments are written into the step text rather than kept as variables, so there would be no variable there to assign to. The same applies to the columns of a table under a `### Section`. Both are refused when the file is parsed.

## Skills

A skill is a reusable sequence of steps shared **across** tests, kept in its own `.md` file under your project's `skills/` directory. Unlike inline sections (below), a skill has its own parameters and outputs, so it's the right tool when a flow — logging in, seeding data, completing checkout — is used by more than one test.

```markdown
---
type: skill
---

# fill_login_form

## Parameters
- username: the account to sign in as
- password: the account's password

## Outputs
- session_id: the logged-in session identifier

## Steps
1. Navigate to the login page
2. Type "{{username}}" into the username field
3. Type "{{password}}" into the password field
4. Click Sign in
5. [output: session_id] Read the session id from the page
```

Invoke it from any test step, passing arguments and aliasing outputs into the caller's scope:

```markdown
## Steps
1. [skill: fill_login_form username="admin@test.com" password="$ADMIN_PW" out.session_id="admin_session"]
2. Use {{admin_session}} for the next request
```

Skills expand inline before the run, so the runner and the report see the fully-expanded flow, and TestBench (Native) can step **into** a skill body, set breakpoints in it, and show a call stack. The skills directory defaults to `skills/` and is configurable via `tests.skillsDir` in `aiui.config.json`.

Skills may be grouped into subfolders of that directory and referenced path-qualified — `skills/auth/login.md` is `[skill: auth/login]`. A leading slash is optional sugar for the same file (`[skill: /auth/login]`), and the unqualified form (`[skill: login]`) still means a skill sitting directly in `skills/`:

```markdown
## Steps
1. [skill: auth/login username="admin@test.com" password="$ADMIN_PW"]
2. [skill: admin/users/create_user role="viewer"]
```

Two things worth knowing about how those names resolve:

- **A `[skill: ...]` inside a skill body is resolved against the skills root too**, never against the calling skill's own folder. `[skill: mfa]` written inside `skills/auth/login.md` means `skills/mfa.md`, not `skills/auth/mfa.md` — write `[skill: auth/mfa]` for the sibling. One name always means one file, wherever it is written.
- **Names are file paths, so they are case-sensitive wherever the filesystem is** (Linux, macOS by default). Windows will happily open `skills/Auth/Login.md` for `[skill: auth/login]`, so a mismatch that works locally can fail in CI. Match the case on disk.

## Inline Sections

An `### Name` heading **inside `## Steps`** defines a reusable block of steps *within a single test* — an inline skill, without the separate file or the parameter declarations. A step invokes it by writing the section's name as its entire text; the bare name **is** the call.

```markdown
## Steps
1. Login
2. Add the first product to the cart
3. Checkout
4. Login
5. Verify the order confirmation shows "Thank you"

### Login
1. Navigate to the login page
2. Type "{{username}}" into the username field
3. Click Sign in and verify the dashboard loads

### Checkout
1. Open the cart
2. Click the checkout button
```

Steps 1 and 4 both call `### Login`; step 3 calls `### Checkout`. Each expands inline before the run.

- **Section or skill?** A section groups steps within one test and shares the test's scope — no parameters, no outputs, no second file. Use a skill when a block is shared across tests or needs its own inputs.
- **The main flow** is the numbered steps before the first `###`; it can't resume after a section begins.
- **Matching** is the step's raw text, trimmed and case-insensitive (`Login` = `login` = `LOGIN`). `1. **Login**` is an ordinary AI step, not a call; a typo or trailing period is a near-miss. A `[skill:]`/`[tool:]`/`[input:]`/`[interactive]` step is never a section call.
- **Names** may contain spaces. Reserved H2 keywords, names starting with `[` or containing `{{`, empty names, and duplicates are rejected.

TestBench (Native) gives sectioned files full debug support — status on body lines, breakpoints, step-into, go-to-definition, completion, and "did you mean?" diagnostics. TestBench (Monaco), the legacy variant, refuses to run a sectioned file rather than mis-run it; use TestBench (Native) or the CLI. See [SPEC.md](SPEC.md#inline-sections) for the full grammar and semantics.

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
| `upload` | `locator.setInputFiles(...)`, or click the control and answer `page.waitForEvent('filechooser')` |
| `api_call` | HTTP fetch (with session cookies or standalone) |
| `assert` | Second AI call evaluates pass/fail against DOM + screenshot |

A file path named in a step is relative to the folder the test file lives in.

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

Editing `aiui.config.json` inside VS Code with the TestBench extension gives you
autocomplete, enum-checking, and hover docs automatically — the extension ships
the JSON schema and binds it to that filename, so no `"$schema"` key is needed.
Outside the extension, add a `"$schema"` key pointing at the schema shipped in
the installed package, e.g. `"./node_modules/ai-ui-automation/schema/aiui.config.schema.json"`.
Secrets such as `AI_API_KEY` live in `.env`, never in this file.

### Environment variables

Some settings are read from `.env` (see [.env.example](./.env.example) for the full list):

| Variable | Purpose |
| --- | --- |
| `AI_API_KEY` | API key for the aiapi gateway. Required for anything that calls a model — compiling, healing a broken entry, AI-executed steps, errands. A fully compiled test replays without it (see [stories/keyless-replay-and-gateway-env.md](./stories/keyless-replay-and-gateway-env.md)). One exception: a `bedrock/` model supplies its own credentials, so a run with no key here is still treated as having AI — see [Using Amazon Bedrock](#using-amazon-bedrock-claude-in-your-own-aws-account). The runner now uses aiapi v2 endpoints. |
| `AI_MODEL` | Overrides `ai.model` from the config file. Optional — falls back to the project default when unset. The first segment decides routing: `gateway/<model>` routes to whatever `AI_GATEWAY_URL` names (your own gateway, a local bridge, Ollama) and **refuses to run when that variable is unset**, rather than quietly sending the traffic elsewhere; `aibroker/<provider>/<model>` is the hosted broker on the built-in endpoint and needs no URL; `bedrock/<model>` is Claude in your own AWS account, needs `AWS_REGION` and no key; anything else (`openai/…`, `anthropic/…`) goes direct to the provider. |
| `AWS_REGION` | Only for a `bedrock/` model, and then **required** — the client does not read `~/.aws/config`, so an SSO profile carrying a region is not enough. Read by the AWS SDK straight from `process.env`, not by this framework, so unlike every other row in this table it belongs in the **machine environment** — the shell that starts `aiui serve`, or the CI job — rather than in a project `.env`. Same for `AWS_DEFAULT_REGION`, `AWS_PROFILE` and the rest of the credential chain, which work exactly as they do for any AWS tool. A project `.env` reaches it on `aiui run` and the Electron UI only; see [Using Amazon Bedrock](#using-amazon-bedrock-claude-in-your-own-aws-account). |
| `AI_GATEWAY_URL` | Overrides `ai.gatewayUrl` from the config file — the OpenAI-compatible endpoint gateway-routed models go through. Optional; set it when your org runs its own internal gateway, so pointing a shared repo at it stays a one-line `.env` change with nothing tracked to edit. Pair it with `AI_MODEL=gateway/<model>`: that spelling says "route here", and a `gateway/` model with this variable unset is refused rather than sent to the default host. Same precedence as `AI_MODEL` (environment → `aiui.config.json` → machine `.env` → built-in default), and it reaches the server path too: the TestBench extension ships the project's `.env` with each run. |
| `AI_EFFORT` | How hard the model thinks on **routine** steps: `low`, `medium`, `high`, `xhigh`, `max` — plus `none` and `minimal`, but see the warning below before using `none`. Optional — **unset is the default and changes nothing on the wire**. Setting it also raises the routine output cap to 8192, since reasoning tokens count against the same cap. Authoring calls (code-behind generation/review, assertions, failure diagnosis) already run at `high` and are deliberately *not* lowered by this. A level the bound model doesn't support fails on the first AI call with `invalid_effort`. Process-level like `maxInputTokens`, not per-session overridable. |
| `AIUI_SERVER_API_KEY` | Shared secret between the Sessions API server and its clients. **Not usually set anywhere**: `aiui serve` generates a machine key at `%LOCALAPPDATA%\aiui\.env` (`~/.aiui/.env` elsewhere) on first start, and every client falls back to it. Set per-project only to pin a dedicated server's key. |
| `INTERACTIVE_ON_FAILURE` | `true`/`false`. Pause the runner on failure so you can inspect the browser. |
| `OPEN_REPORT_IN_BROWSER_AFTER_RUN` | `true`/`false`. Open the generated HTML report in your OS default browser after `run` completes. Skipped automatically when `CI` is set. |
| `APPEND_RUN_HISTORY_TO_TEST_FILE` | `true`/`false`. Append a "Latest runs" section at the bottom of each test `.md` file after it runs, linking to its HTML report (keeps the most recent 10). Default `false`. |

> **Don't set `AI_EFFORT=none` — it is not the cheap option.** Leaving
> `AI_EFFORT` unset is what saves money. `none` costs *more* and can break runs.
>
> Measured on Anthropic Opus 4.8, three runs of the same prompt: unset averaged
> **91** output tokens, `low` **139**, and `none` **150** — dearer than the
> setting that actually reasons.
>
> Turning thinking off doesn't stop the model reasoning; it moves the reasoning
> into the **visible reply**. That reply is what the runner parses as a JSON
> action list, so the model's commentary lands in the middle of the JSON and the
> step fails to parse. It's a correctness problem, not just a bigger bill — and
> `responseFormat: {type:'json_object'}` won't save you, because Anthropic
> ignores it.
>
> Want to spend less? Leave it unset. Want a guaranteed floor of reasoning? Use
> `low`.

> The per-environment data directory is configured via `tests.dataDir` in
> `aiui.config.json` (default `data`) — **not** an env var. The former
> `AIUI_DATA_DIR` env var has been removed.

### Corporate networks

On a network with a mandatory proxy or TLS interception, three environment
variables have to be set **where the server process starts** — not in a
project's `.env`. All three are read by the Node runtime at startup, before a
line of framework code runs, so they are not framework configuration:

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://corp-proxy:8080 NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem node dist/index.js serve -p 3100
```

| Variable | Why |
| --- | --- |
| `NODE_USE_ENV_PROXY` | The one people miss. Setting `HTTPS_PROXY` alone does **nothing** — Node's `fetch` ignores the proxy environment variables unless this is set, so the server silently goes direct and times out against the firewall instead of reporting a proxy problem. Needs Node >= 22.21 (or >= 24); that is why the floor in [Prerequisites](#prerequisites) is 22.21. Node prints an `EnvHttpProxyAgent is experimental` warning on startup when it is on. |
| `HTTPS_PROXY` | The proxy itself (`HTTP_PROXY` and `NO_PROXY` work too). |
| `NODE_EXTRA_CA_CERTS` | Needed when the proxy re-signs TLS with a private root. Node ships its own root bundle and ignores the OS trust store, so a browser on the same machine succeeds while the server fails certificate validation. |

Set these in the operator's own environment — the shell, service definition, or
MCP client config that launches the server. A project's `.env` deliberately
**cannot** supply `NODE_EXTRA_CA_CERTS`; it is filtered by
`UNSAFE_CHILD_ENV_KEYS` in
[src/mcp/server-start.ts](./src/mcp/server-start.ts). One Sessions API server
serves *every* project pointing at that `SERVER_URL` and holds each one's
credentials, so a CA installed by one project would be trusted for every other
project's calls.

To keep model traffic inside your own network, point
[`AI_GATEWAY_URL`](#environment-variables) at an in-tenant or self-hosted
OpenAI-compatible endpoint and set `AI_MODEL=gateway/<model>`. The `gateway/`
prefix means "route to `AI_GATEWAY_URL`", and it refuses to run when that
variable is unset — so a forgotten URL line fails loudly instead of sending the
key and the page payload to the default host. A fully compiled test replays with
**no AI calls at all** and needs no key — see
[stories/keyless-replay-and-gateway-env.md](./stories/keyless-replay-and-gateway-env.md).

#### Using Amazon Bedrock (Claude in your own AWS account)

If your approved AI is "Claude in our AWS account", set `AI_MODEL=bedrock/<model>`.
Prompts go to Bedrock in your region, under your existing AWS agreement, over
your own network path — commonly a VPC endpoint, so nothing traverses the public
internet. No new vendor to clear, no per-seat quota, and unlike the Copilot
bridge below it works headless and in CI.

**Install the Bedrock SDK first — it is not bundled:**

```bash
npm install @anthropic-ai/bedrock-sdk
```

It is an optional peer dependency of `@pkent/aigateway` rather than something
this framework depends on, deliberately: it pulls the AWS SDK, roughly 50
packages and 38 MB of credential providers and IMDS clients, and depending on it
here would charge every user of this framework for a provider most of them never
use. Only Bedrock users install it. If you forget, the first AI call fails with
`missing_optional_dependency` naming that exact command, so the failure is
loud and self-explaining rather than mysterious.

**The AWS half of this lives in the machine environment, not in the project
`.env`.** `AWS_REGION`, `AWS_PROFILE` and any AWS credentials are read from
`process.env` by the AWS SDK itself, which knows nothing about this framework's
env files. That already matches how AWS credentials work everywhere else — they
come from the machine, an SSO login or an instance role, and never from a file
in the repo — and the region belongs with them.

Concretely: put them in the environment that **starts the Sessions API server**
(or that runs your CI job). The `AI_*` lines below still go in the project
`.env`, which is what the TestBench extension ships with each run.

The project `.env` does work for the AWS variables on two paths only — `aiui
run` and the Electron Runner UI — because those load the project's base `.env`
into their own process at startup. The Sessions API server deliberately does
not: it serves many projects at once and exports none of their `.env` files
into its own process (see
[stories/project-scoped-data-dir-and-env.md](./stories/project-scoped-data-dir-and-env.md)),
so a project `.env` carrying `AWS_REGION` reaches the run's AI config on the
CLI and silently does not on TestBench or MCP. Set it once on the machine and
all four paths agree.

Two ways to authenticate, and the framework does neither itself — the AWS SDK
resolves both.

**A bearer token**, which is an ordinary key:

```
# project .env
AI_MODEL=bedrock/global.anthropic.claude-opus-4-6-v1
AI_API_KEY=<bedrock bearer token>

# machine environment (or the shell that starts `aiui serve`)
AWS_REGION=eu-west-1
```

**Or no key at all**, signing each request with the AWS credential chain — env
credentials, an SSO profile, or an instance role:

```
# project .env — the blank key line is deliberate, see below
AI_MODEL=bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0
AI_API_KEY=

# machine environment (or the shell that starts `aiui serve`)
AWS_REGION=eu-west-1
AWS_PROFILE=acme-dev
```

Three things about that second form are worth knowing before you hit them.

**Keep the empty `AI_API_KEY=` line.** Not as a way to force a keyless run — see
below — but because omitting it entirely is not the same as blanking it. With
no line at all the machine-wide key at `%LOCALAPPDATA%\aiui\.env` fills the gap,
and that key is then handed to AWS as a Bedrock bearer token: it takes
precedence over every AWS credential source, so SigV4 never runs and the request
fails as a 403 that names nothing. A blank line sets the key to empty, which
blocks the machine default and leaves the credential chain in charge.

**`AWS_REGION` must be set explicitly.** Unlike the Python SDK, the TypeScript
client does not read `~/.aws/config`, so an SSO profile that already carries a
region is not enough. With none set, the run fails at construction with a
message naming `AWS_REGION` / `AWS_DEFAULT_REGION`.

**A blank `AI_API_KEY=` no longer forces a keyless run.** This framework reports
AI as configured when the model routes to a provider that supplies its own
credentials, which is the whole point — otherwise a correct Bedrock setup would
be told to set a key Bedrock has no use for. To spend nothing on a run, use
`ai.allowInRuns: false` in `aiui.config.json`, or `runSettings: {ai: "off"}` on
the server path; with no key to blank, that is the switch. Both are honoured by
the `aiui run` CLI as well as by the server.

**Model ids normally carry an inference-profile prefix** (`global.`, `eu.`,
`us.`). That is the norm rather than an edge case: AWS serves most current
Claude models through cross-region inference only, and passing the bare base id
returns HTTP 400 asking for the id or ARN of an inference profile. The suffix
varies per model (`-v1`, `-20250929-v1:0`, or none). Profile **ARNs** are not
supported — they contain slashes, which the provider-prefix strip would mangle.

`AI_GATEWAY_URL` does not apply to a `bedrock/` model and is simply unused when
both are set. The run logs a line saying so; it is not an error, and nothing is
leaving your account.

See [stories/bedrock-provider.md](./stories/bedrock-provider.md).

#### Using GitHub Copilot

If the only AI your organisation has approved is a GitHub Copilot subscription,
the TestBench extension can be that AI. Run **TestBench: Use Copilot for AI**
once: it raises Copilot's consent dialog, asks which of your seat's models to
use, and writes three lines into the project's `.env`.

```
AI_MODEL=gateway/copilot/gpt-4.1
AI_GATEWAY_URL=http://127.0.0.1:18790
AI_API_KEY=<bridge token>
```

Nothing new leaves the machine. VS Code's `vscode.lm` API has no HTTP surface
and the Sessions API server is a separate process, so the extension publishes
that API as an OpenAI-compatible endpoint on 127.0.0.1 and the server reaches it
through the `gateway/` routing above. Prompts still go out over Copilot's own
channel — the one the org already approved. The listener is off by default, is
User-scoped so no workspace can turn it on, and every request needs the bearer
token that setup wrote (kept in this machine's VS Code SecretStorage, so a
`.env` copied to another machine gets a 401).

**Scope: compiling, repairing and authoring — not running.** Copilot bills in
premium requests with per-model multipliers, sized for interactive chat, and
agent-style traffic exhausts a seat in minutes. Code-behind replay means runs
don't need AI at all: a fully compiled test makes **zero** AI calls and spends
**zero** quota, however many times it runs. What does spend quota is a human
asking for AI work — Compile This Step, Repair this step, compiling a test — plus
two reactive paths on a keyed run: the failure-diagnosis pass (one call per
failed run) and a heal attempt on a stale compiled step. Nothing stops you
running uncompiled steps through Copilot; it will work, and it will hit the
seat's limits.

To spend nothing on a particular run without editing `.env`, use the AI run
switch: `runSettings: {ai: "off"}` makes the run keyless *by policy* — compiled
steps replay, a broken entry takes the skip instead of healing, and anything
needing a model is refused with a typed error. The report then says the run made
zero AI calls because it was told to, rather than because a key happened to be
missing. On the `aiui run` CLI there is no per-run channel, so the project-level
`ai.allowInRuns: false` in `aiui.config.json` is the equivalent switch — and it
is the only one for a provider that supplies its own credentials, where there is
no `AI_API_KEY` to blank.

Three limits worth knowing before you set it up. Screenshots are dropped: the
bridge speaks text only, so an image block is replaced with a short note (the
diagnosis pass still works, text-only). The bridge is loopback — a **remote**
Sessions API server would resolve `127.0.0.1` to itself, so this only works with
a server on the same machine; the setup command warns when `SERVER_URL` is not
local. And the `gateway/` prefix is resolved by `@pkent/aigateway` inside the server
process, so the server has to be running a build whose dependency ships it —
`1.4.0-beta.5` or later. If it answers `Unsupported model "gateway/…"` and lists
the providers it does know, that server predates the prefix: rebuild and restart
it from a checkout on this version.

### Per-environment configuration

Your tests project can live anywhere — it doesn't have to be inside this repo. The framework resolves all paths relative to **the directory you run the CLI from** (`process.cwd()`).

A typical external tests project looks like:

```
aitests/
├── aiui.config.json        # project config (tests.dataDir, skillsDir, …)
├── .env                    # base config — shared across all envs (e.g. AI_API_KEY)
├── .env.local              # env-specific secrets / URLs (BASE_URL, passwords, …)
├── .env.staging
├── .env.uat
├── data/                   # default data dir (override path with tests.dataDir)
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

- **Base `.env`** — loaded first, shared across all envs. Put your AI API key and any other settings that don't change between environments here.
- **`.env.<name>`** — loaded on top of the base when you pass `--env <name>` (or pin the test with `env: <name>` in its frontmatter). Holds env-specific secrets and URLs as flat key/value strings. Reference these in tests as `${env.BASE_URL}`.
- **`<dataDir>/<name>.json`** — env-specific structured test data (users, fixtures, thresholds), where `<dataDir>` is `tests.dataDir` from `aiui.config.json` (default `data`). Reference values in tests as `${data.users.admin.email}`. JSON string leaves of the form `$VAR_NAME` are resolved against the environment, so secrets stay in `.env.<name>` and the JSON references them.

Both layers are env-scoped via the same `<name>` suffix. The data folder is optional — tests that don't use `${data.*}` placeholders run fine without it.

#### Why two layers (`.env` + JSON)?

`.env` is flat key/value strings — good for secrets and URLs. JSON is nested/structured — good for users, fixture catalogues, assertion thresholds. Keeping them separate lets you check the JSON into git while keeping secrets out.

#### Per-test data sources (named namespaces)

Sometimes a test wants data from a file outside the env-default data dir — a shared catalogue maintained by another team, or a one-off override that lives next to the test. Declare named **data sources** in the frontmatter:

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
