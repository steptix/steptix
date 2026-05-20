# File-based tools with Playwright access

## Context

The framework's current call vocabulary has two layers:

- **Steps** — natural-language instructions the AI loop interprets and turns
  into browser actions.
- **Skills** — reusable named bundles of natural-language steps, invoked from
  tests via `[skill: name ...]` and expanded at parse time.

Both layers ultimately go through the AI. There are real cases where that's
the wrong tool:

- **The work isn't on the page.** Fetching an OTP from a test inbox, signing
  a JWT, hashing a password, computing an HMAC, calling a backend API to
  seed test data, decoding a base64 download.
- **The action is mechanically tricky for the AI.** HTML5 drag-and-drop with
  intermediate dragover events, file-upload tests, downloading a file and
  inspecting its bytes, multi-page choreography that races on Playwright
  events.
- **The author wants determinism.** Anything where "the AI sometimes does it
  differently" is unacceptable — payment flows, anti-fraud checks, ID
  generation that needs to round-trip with a backend.

For these cases, authors want to drop into deterministic TypeScript with full
Playwright access, run their code, and let the test continue in natural
language afterward. This story introduces **tools** as that third layer.

A tool is a TypeScript function in a separate JS project, registered with the
framework, callable from a test or a skill via `[tool: name ...]`. Tools are
not skills with code — they're a distinct concept with a different contract:

| | Skills | Tools |
|---|---|---|
| Body | Natural-language steps | TypeScript code |
| AI involvement | Driven by the AI loop | None (deterministic) |
| Lives in | `*.md` file | `*.ts` file in a separate package |
| IDE support | Markdown | Full TypeScript (typecheck, autocomplete, lint) |
| Authored by | Test authors | Test authors or framework engineers |
| Composable | From tests, skills, hooks | Same |

## Goals

1. Let test authors invoke deterministic TypeScript code from a test or skill
   with the same call syntax as skills (`[tool: name ...]`), including the
   bare-identifier shorthand we just shipped for skills.
2. Tools live in their own JS project (their own `package.json`,
   `tsconfig.json`) so VS Code typechecks them, autocompletes them, lints
   them, and the AI can author them as standalone files.
3. Tools have full live access to Playwright `page` / `context` / `browser`
   — the same instances the AI loop is using — so actions a tool performs
   carry through to subsequent natural-language steps.
4. Tool inputs and outputs are typed and validated at startup so mistyped
   parameter names or missing outputs surface as parse-time errors, not
   silent runtime weirdness.
5. Tool calls appear in the HTML report with their args, duration, pass/fail,
   and any logs they emitted, alongside AI action entries.
6. Existing skills, tests, and hooks keep working unchanged — this is purely
   additive.

## Design

### Project layout

A tool project is a normal TypeScript project. It can live alongside the
test repo or be fully separate (own repo, own publish lifecycle, consumed
via a path or `npm install`):

```
my-test-project/
├── aiui.config.json
├── tests/
│   └── login-with-otp.md
├── skills/
│   └── login_via_otp.md
└── tools/                        ← own JS project
    ├── package.json              ← own deps (e.g. node-fetch, jsonwebtoken)
    ├── tsconfig.json             ← own TS config
    └── src/
        ├── fetch_otp.ts
        └── drag_to_reorder.ts
```

`tools/package.json` declares `ai-ui-automation` and `@playwright/test` as
devDependencies for type access. The directory is *not* required to be inside
the test repo:

```json
{
  "tests": {
    "toolsDir": "./tools/src"
  }
}
```

`tests.toolsDir` can point anywhere — a sibling project (`./tools/src`), a
separate repo's compiled output (`../shared-tools/dist`), or an installed npm
package (`node_modules/@org/test-tools/dist`).

### Defining a tool — `defineTool`

The framework exports a single helper, `defineTool`, from
`ai-ui-automation/tools`. A tool file default-exports the result.

```ts
// tools/src/fetch_otp.ts
import { defineTool } from 'ai-ui-automation/tools';

export default defineTool({
  name: 'fetch_otp',
  description: 'Fetch the most recent 6-digit OTP from a test inbox',
  parameters: {
    email: { type: 'string', description: 'inbox to read' },
    timeoutMs: { type: 'number', default: 30000 },
  },
  outputs: {
    otp: { type: 'string', description: 'the 6-digit code' },
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

`defineTool` is generic over `parameters` and `outputs`, so:

- The `args` argument to `run` is fully typed (`email: string`,
  `timeoutMs: number`).
- `step.setVar` is restricted to declared output names — `setVar('otpp', ...)`
  is a typecheck error.
- The framework can validate calls at startup against the schema, with
  precise messages.

### Tool context

The second argument to `run` is the live framework context:

```ts
import type { Page, BrowserContext, Browser, Frame } from '@playwright/test';

export interface ToolContext {
  /** The page the AI loop is currently driving. Same instance — actions persist. */
  page: Page;
  /** The current browser context (cookies, storage, .request, .pages()). */
  context: BrowserContext;
  /** The browser instance (for opening incognito contexts, etc.). */
  browser: Browser;
  /** The active frame the AI loop currently considers in scope. */
  frame: Frame;
  /** Variable scope shared with the surrounding test. */
  step: {
    getVar(name: string): string | undefined;
    setVar(name: string, value: string): void;
    expect(condition: boolean, message?: string): void;
    /** Promote a page so subsequent natural-language steps drive it. */
    setActivePage(page: Page): void;
    /** Push a labelled progress entry into the trace mid-run. */
    report(message: string, data?: unknown): Promise<void>;
  };
  log: { info(...): void; warn(...): void; error(...): void };
  /** Sibling tools, in case one tool wants to call another. */
  tools: Record<string, (args: unknown) => Promise<void>>;
}
```

Two guarantees the runtime makes:

1. **Same instance.** `ctx.page` is the same Playwright `Page` reference the
   AI action loop drives. Anything the tool clicks / navigates / evaluates
   is visible to the next natural-language step.
2. **Variable scope crosses the boundary.** `step.setVar('otp', code)` writes
   into the same map `{{otp}}` reads from in the next step.

No sandbox layer. Tools run in the same Node process as the runner, with
full access. The trust boundary is "is this code in `tools/`?" — reviewed
the same way `src/` is reviewed.

### Calling a tool from a test or skill

Same call syntax as skills, including the bare-identifier and `out.<name>`
shorthand introduced in [skill-call-syntax.md](skill-call-syntax.md):

```markdown
## Steps
1. Navigate to {{baseUrl}}/login
2. Type "{{username}}" into the username field
3. Click "Send code" and verify the prompt appears
4. [tool: fetch_otp email out.otp]
5. Type "{{otp}}" into the verification code field and click Sign in
```

Step 4 desugars to `[tool: fetch_otp email="{{email}}" out.otp="otp"]`.

Tool calls work identically inside skills, including from inside hooks:

```markdown
## Hooks
- before: [tool: seed_test_data tenant="{{tenant_id}}"]
- after: [tool: cleanup_test_data tenant="{{tenant_id}}"]
```

### Tool catalogue

At startup, the runner scans `tests.toolsDir` (defaulting to `./tools/src`) and
imports every `*.ts` / `*.js` file. Each module's default export is read and
registered by its declared `name`. Failures (file doesn't compile, default
export isn't a `defineTool` result, name collision) abort startup with a
clear error pointing at the offending file.

The catalogue is a `Map<string, RegisteredTool>` carried alongside the skill
cache. Tests reference tools by name only; the path is opaque to test
authors.

### Parse-time validation

When a test/skill is parsed, every `[tool: name ...]` reference is checked
against the catalogue:

- Tool name resolves.
- Every required parameter is supplied (matching the schema's required keys).
- Every supplied parameter exists in the schema.
- Every `out.<name>` matches a declared output.
- Type-shape mismatches (e.g. `timeoutMs="not_a_number"`) become parse-time
  errors with a source-line caret, identical in style to
  `SkillCallSyntaxError`.

This means a test can never reach the runtime with a malformed tool call —
the same parse-time guarantee skills get today.

### Runtime execution

A new `tool` step kind is added alongside `step` and the implicit hook step
kinds. When the runner reaches a tool step:

1. Resolve the tool from the catalogue.
2. Interpolate the call args against the current variable scope (so
   `email="{{email}}"` becomes `email="alice@example.com"`).
3. Validate args against the schema (defaults applied, types coerced where
   declared).
4. Build `ToolContext` from the live runner state.
5. `await tool.run(args, ctx)` — exclusive access; the AI loop is paused.
6. Capture pass/fail, duration, logs, any `setVar` writes; record a tool
   step entry in the report.
7. Capture next-step DOM/screenshot just as the runner does after any AI
   action, so subsequent natural-language steps see the post-tool state.

A thrown error fails the step. No retry by default — tool failures are
deterministic, not AI flakiness. `defaultHooks` and per-test hooks still
wrap a tool step the same way they wrap any other step (unless
`[no-hooks]`).

### Reporting

The HTML report grows a new entry kind alongside AI actions:

```
Step 4: [tool: fetch_otp email out.otp]
  Tool: fetch_otp
  Args: { email: "alice@example.com", timeoutMs: 30000 }
  Duration: 2.4s
  Outputs: { otp: "483921" }
  Logs:
    [info] polling inbox for alice@example.com
  Status: ok
```

Playwright tracing already captures `page.click` / `page.mouse.*` /
`page.evaluate` automatically, so anything the tool does to the browser
shows up in `trace.zip` with no extra plumbing on the framework's side.

### Composability with skills

Tools and skills nest freely. A skill can call a tool; a tool can be called
inside a hook; a tool can call sibling tools via `ctx.tools.<name>(args)`.
The cycle-detection logic added for nested skills generalises to tools: a
tool that calls a sibling that calls back into the original tool throws
`Tool cycle detected: a -> b -> a`.

A tool **cannot** call a skill, because skills require the AI loop and
tools are deterministic-code-only by design. If a tool needs natural-
language work, the right answer is to break it back out as a skill in the
calling test.

## Examples

### Example 1 — `tests/login-with-otp.md`

```markdown
---
tags: [smoke, login]
---

# Login with email OTP

## Parameters
- username: $TEST_USERNAME
- email: $TEST_EMAIL

## Steps
1. Navigate to {{baseUrl}}/login
2. Type "{{username}}" into the username field
3. Click "Send code" and verify the prompt appears
4. [tool: fetch_otp email out.otp]
5. Type "{{otp}}" into the verification code field and click Sign in
6. Verify the dashboard greeting reads "Welcome, {{username}}"
```

### Example 2 — drag-and-drop tool

```ts
// tools/src/drag_to_reorder.ts
import { defineTool } from 'ai-ui-automation/tools';

export default defineTool({
  name: 'drag_to_reorder',
  parameters: {
    listSelector: { type: 'string' },
    fromIndex: { type: 'number' },
    toIndex: { type: 'number' },
  },
  outputs: {
    new_order: { type: 'string' },
  },
  async run({ listSelector, fromIndex, toIndex }, { page, step }) {
    const items = page.locator(`${listSelector} > li`);
    const [src, dst] = [items.nth(fromIndex), items.nth(toIndex)];
    const srcBox = await src.boundingBox();
    const dstBox = await dst.boundingBox();
    if (!srcBox || !dstBox) throw new Error('elements not visible');
    await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      await page.mouse.move(
        srcBox.x + (dstBox.x - srcBox.x) * t,
        srcBox.y + (dstBox.y - srcBox.y) * t,
      );
    }
    await page.mouse.up();
    step.setVar('new_order', (await items.allInnerTexts()).join(','));
  },
});
```

### Example 3 — skill that wraps a tool call

```markdown
---
type: skill
---

# login_via_otp

## Parameters
- username: the username to sign in with
- email: the inbox the OTP arrives in

## Outputs
- session_id: the dashboard session id from a cookie

## Steps
1. Navigate to {{baseUrl}}/login
2. Type "{{username}}" into the username field
3. Click "Send code"
4. [tool: fetch_otp email out.otp]
5. Type "{{otp}}" into the verification code field and click Sign in
6. Read the value of the `sid` cookie [store as: session_id]
```

A test that uses this skill is a one-liner:

```markdown
1. [skill: login_via_otp username email out.session_id]
```

## Implementation outline

### New code

- `src/tools/define-tool.ts` — `defineTool` helper, the public entry point
  re-exported from a new `ai-ui-automation/tools` subpath in the published package.
  Captures `name`, `description`, `parameters`, `outputs`, `run`. Generic
  over the schemas so `args` and `step.setVar` are typed.
- `src/tools/registry.ts` — `loadToolCatalogue(dir: string)` walks the
  directory, dynamically imports each file (using Node's `import()` for
  ESM), validates the default export is a `defineTool` result, and returns
  a `Map<string, RegisteredTool>`. Reports collisions and bad exports as
  startup errors.
- `src/tools/call-parser.ts` — analogous to
  [src/skills/skill-call-parser.ts](../src/skills/skill-call-parser.ts), but
  matches `[tool: ...]` prefix. Reuses the same scanner / shorthand /
  `SkillCallSyntaxError`-style error class. Likely refactor: rename the
  existing parser to a generic `parseInvocation(prefix, line)` and have
  both skill and tool call parsing share it.
- `src/tools/executor.ts` — `executeToolStep(call, ctx)` doing arg
  interpolation, schema validation, building `ToolContext`, awaiting
  `run()`, recording the report entry, and propagating errors.
- `src/tools/context.ts` — typed `ToolContext` interface and
  `buildToolContext(runtimeState)` factory.

### Modified code

- `src/parser/markdown.ts` — recognise `[tool: ...]` references in steps and
  hooks. Validate against the tool catalogue. Add a parallel structural
  field to `ParsedTest.steps` so the runner knows whether a step is `step` /
  `hook` / `tool`. Likely shape: a discriminated union `Step = { kind:
  'natural', text: string } | { kind: 'tool', call: ToolCall }`.
- `src/skills/expander.ts` — when expanding a skill body, allow tool calls
  to pass through unchanged (they are resolved at runner time, not at parse
  time, since they need live `page`).
- `src/runner/test-runner.ts` — dispatch on step kind: natural → existing
  AI loop, tool → `executeToolStep`.
- `src/runner/hooks.ts` — hook steps go through the same dispatcher so a
  hook can be a tool call.
- `src/report/generator.ts` and `src/report/types.ts` — new `ToolStepResult`
  shape with args, outputs, duration, logs, status.
- `src/cli/commands/run.ts` and the project config types — add
  `tests.toolsDir` config, default to `./tools/src`. Surface tool catalogue
  load errors as a clear startup failure.

### Package exports

`package.json`:

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./tools": { "import": "./dist/tools/define-tool.js", "types": "./dist/tools/define-tool.d.ts" }
  }
}
```

So tool authors do `import { defineTool } from 'ai-ui-automation/tools'`.

## Tests

- `tests/define-tool.test.ts` — unit tests for `defineTool`'s type narrowing,
  default-value handling, and runtime arg validation.
- `tests/tool-registry.test.ts` — directory walking, name-collision
  detection, bad-export detection, lazy import behavior.
- `tests/tool-call-parser.test.ts` — mirrors
  [tests/skill-call-parser.test.ts](../tests/skill-call-parser.test.ts) for
  `[tool: ...]` syntax including shorthand and the same error classes.
- `tests/tool-executor.test.ts` — given a stub `RuntimeState`, calls
  `executeToolStep` with a fixture tool that uses `step.setVar` / a stub
  `page`, asserts variable scope updates, error handling, and report-entry
  capture.
- `tests/integration/tool-shorthand-demo.md` (or vitest equivalent) —
  fixture demonstrating the `[tool: ...]` shorthand end-to-end.
- `fixtures/tools/`, `fixtures/skills/login_via_otp.md`, and
  `fixtures/tests/login-with-otp.md` — example tool + skill + test files
  used by the integration test.

## Migration

Purely additive. Existing tests, skills, and hooks are unaffected. Projects
that don't configure `tests.toolsDir` get an empty catalogue; any `[tool: ...]`
reference in such a project fails parse-time with "no tools registered;
configure `tests.toolsDir` in `aiui.config.json`."

The skill mechanism is unchanged — tools are a sibling layer, not a
replacement.

## Open questions (deferred)

- **Async-iterating tools.** Some tools (poll inbox, wait for webhook) want
  to yield progress entries mid-run. v1 supports this via
  `step.report(message, data)` from inside `run`, which writes a labelled
  entry into the trace. A more elaborate streaming API can come later.
- **Per-tool retry policy.** Tools currently fail-fast. A schema-declared
  `retry: { attempts: 3, backoff: 'expo' }` could be added later for tools
  that legitimately race (network polls, eventual consistency).
- **Hot reload during dev.** Editing a tool file while `--watch` is running
  should re-import that file. v1 reloads the catalogue on each test run.
- **Tool versioning across teams.** Once `tests.toolsDir` can point at
  `node_modules/...`, tool authors get full npm semver. No framework work
  needed; worth documenting.
- **Sandboxing for untrusted tool authors.** Out of scope for v1 (tools are
  reviewed code, like the runner). If we ever want to run third-party
  tools, the path is `isolated-vm` per-tool with a marshaled `page`
  proxy — non-trivial, defer until a real use case emerges.
- **Tool calling skills.** Disallowed in v1 to keep the deterministic
  contract crisp. If a real need surfaces, the path is to let a tool
  return a value indicating "now run skill X with these args," which the
  runner orchestrates.
