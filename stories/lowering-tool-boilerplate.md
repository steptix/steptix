# Lowering tool boilerplate

## Context

The shape we shipped in [tools-with-playwright-access.md](tools-with-playwright-access.md) is a great fit for tools that are *named, reusable, and shared across tests* — the schema declarations, descriptions, and explicit outputs make the tool inspectable in the report, validated at startup, and discoverable.

It is overkill for the truly common case: the test author wants to write two lines of code (a UUID, a hash, a quick API probe, a one-line page assertion) and inline them into a test. Today that costs ~13 lines of frame:

```ts
import { defineTool } from 'ai-ui-automation/tools';

export default defineTool({
  name: 'uuid',
  parameters: {},
  outputs: { uuid: { type: 'string' } },
  async run(_args, { step }) {
    step.setVar('uuid', crypto.randomUUID());
  },
});
```

The boilerplate-to-body ratio is too high. Authors will reach for natural-language steps (which may not be deterministic) or skip the test entirely.

## Goals

1. **Two-line tools.** The smallest meaningful tool fits in a default export plus a `return`.
2. **No editor regression.** Full TypeScript autocomplete on `page`, `context`, `step`, etc. with no `.d.ts` setup, no tsconfig magic, no globals.
3. **Mix freely.** A project can use the new shape and the old `defineTool` shape side by side. No migration; no flag day.
4. **AI-author friendly.** Generated tool files should be syntactically simple, easy to lint/typecheck, and not require structural decisions the AI is bad at.

## Design

### A three-rung ladder

```ts
// Rung 1 — bare function (smallest, no IDE help on the destructured scope)
// tools/src/check_health.ts
export default async ({ baseUrl, context }) => {
  const res = await context.request.get(`${baseUrl}/health`);
  return res.ok();
};

// Rung 2 — `tool()` helper (recommended; full IDE autocomplete, no annotation)
// tools/src/check_health.ts
import { tool } from 'ai-ui-automation/tools';

export default tool(async ({ baseUrl, context }) => {
  const res = await context.request.get(`${baseUrl}/health`);
  return res.ok();
});

// Rung 3 — `defineTool({...})` (full schema; descriptions, multiple outputs)
import { defineTool } from 'ai-ui-automation/tools';

export default defineTool({
  name: 'check_health',
  parameters: { baseUrl: { type: 'string' } },
  outputs: { healthy: { type: 'boolean' } },
  async run({ baseUrl }, { context, step }) {
    const res = await context.request.get(`${baseUrl}/health`);
    step.setVar('healthy', res.ok());
  },
});
```

Every rung produces the same internal `ToolDefinition` and runs through the existing `executeToolStep` pipeline. Rungs are monotonic: the higher you go, the more you can express; you can stay at any rung indefinitely.

### Filename-as-name

For default exports of bare functions and `tool(...)` (without an explicit name), the tool name is the filename minus extension. So `tools/src/check_health.ts` registers a tool called `check_health`.

Filenames must match `/^[\w-]+$/` (the same regex tool names already obey). A non-conforming filename (e.g. `check health.ts`) is rejected at registry-load time with a clear startup error so the author renames the file.

If the file uses `tool('explicit_name', fn)` or `defineTool({ name: 'explicit_name', ... })`, the explicit name wins. If the explicit name and the filename disagree, we warn but don't fail — explicit beats implicit.

### Named-export-as-name (multi-tool files)

The registry walks every export of a tool file, not just `default`. A named export's *export key* serves as the tool name when none is declared:

```ts
// tools/src/strings.ts
import { tool } from 'ai-ui-automation/tools';

export const slugify = tool(({ s }: { s: string }) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

export const upper = tool(({ s }: { s: string }) => s.toUpperCase());

export const word_count = tool(({ s }: { s: string }) => s.trim().split(/\s+/).length);
```

Three tools, one file, no name repetition. Each tool is callable as `[tool: slugify s="..."]` etc.

A named export that isn't a tool (random helpers, types) is silently ignored. A bare function as a named export is also accepted — the export key becomes the name.

### `tool()` helper

`tool` is an identity wrapper at runtime — it preserves the function and tags it as a deferred tool spec. The registry resolves the name (explicit > export key > filename) and finalises the definition.

Signatures:

```ts
function tool<A = Record<string, unknown>, R = unknown>(
  fn: (scope: ToolScope & A) => R | Promise<R>,
): DeferredTool;

function tool<A = Record<string, unknown>, R = unknown>(
  name: string,
  fn: (scope: ToolScope & A) => R | Promise<R>,
): DeferredTool;
```

The generic `A` lets the author type the args portion of scope when they care:

```ts
export default tool<{ count: number }>(({ count }) => 'x'.repeat(count));
```

### `ToolScope` — the single arg passed in

`ToolScope` is the shape the function receives:

```ts
interface ToolScope {
  /** Live Playwright page (same instance the AI loop drives). */
  page: Page;
  /** Live BrowserContext. */
  context: BrowserContext;
  /** Live Browser. */
  browser: Browser;
  /** Variable-scope API: getVar, setVar, expect. */
  step: ToolStepApi;
  /** Logger that lands entries in the report. */
  log: ToolLog;
  /** Full bag of caller-supplied args (handy when you want to iterate). */
  args: Record<string, unknown>;
  /** Caller args are also spread to the top level for ergonomic destructuring. */
  [key: string]: unknown;
}
```

Caller args spread to the top level is the move that makes `({ baseUrl, context }) => ...` "just work." Reserved names (`page`, `context`, `browser`, `step`, `log`, `args`) take precedence — a tool called with `[tool: foo page="x"]` shadows the caller's `page` with the framework's `page` and warns once at startup.

### Single-output return convention

A bare-function or `tool()`-defined tool that **returns a value** registers a single output named after the tool:

```ts
// tools/src/uuid.ts
export default () => crypto.randomUUID();
// → [tool: uuid]            sets {{uuid}}
// → [tool: uuid out.id]     sets {{id}}  (existing alias mechanism)
```

Returning `undefined` (or not returning) registers no output; the tool ran for side-effects only.

Return type coercion to the variable scope (a `Record<string, string>`):
- `string` → stored as-is
- `number` / `boolean` → `String(value)`
- `null` / `undefined` → no write
- object / array → `JSON.stringify(value)`

If you need multiple outputs, types other than the JSON-stringified default, or a description, use `defineTool` (rung 3).

### Examples — full ladder, side by side

```ts
// tools/src/uuid.ts             ← rung 1 (bare function, name from filename)
export default () => crypto.randomUUID();
```

```ts
// tools/src/now.ts               ← rung 2 (tool() helper)
import { tool } from 'ai-ui-automation/tools';
export default tool(() => new Date().toISOString());
```

```ts
// tools/src/check_health.ts     ← rung 2 with Playwright + args
import { tool } from 'ai-ui-automation/tools';
export default tool(async ({ baseUrl, context }) => {
  const res = await context.request.get(`${baseUrl}/health`);
  return res.ok();
});
```

```ts
// tools/src/strings.ts          ← multi-tool file (named-export-as-name)
import { tool } from 'ai-ui-automation/tools';
export const slugify = tool(({ s }: { s: string }) =>
  s.toLowerCase().replace(/\W+/g, '-'));
export const upper = tool(({ s }: { s: string }) => s.toUpperCase());
```

```ts
// tools/src/login_via_otp.ts   ← rung 3 (full schema, the existing API)
import { defineTool } from 'ai-ui-automation/tools';
export default defineTool({ /* full spec */ });
```

## Implementation outline

### New code

- **`src/tools/tool-helper.ts`** — `tool()` overload, `DeferredTool` marker shape, `ToolScope` type. `tool()` is a thin runtime tag; almost all logic happens at registry-load time.
- **`src/tools/finalise.ts`** — pure function that takes `(input, contextHints)` where `input` is one of:
  - `ToolDefinition` (rung 3 — keep as-is)
  - `DeferredTool` (rung 2)
  - bare function (rung 1)
  - and `contextHints` = `{ explicitName?: string; exportKey?: string; filename: string }`. Returns a fully-formed `ToolDefinition` ready to register.

### Modified code

- **`src/tools/registry.ts`** — `loadOne` walks every export (`Object.entries(mod)`), runs each candidate through `finalise`, registers the result. Filename validation moves earlier so a non-conforming filename fails before any imports are attempted.
- **`src/tools/index.ts`** — re-export `tool` and the `ToolScope` type so authors `import { tool } from 'ai-ui-automation/tools'`.
- **`src/tools/types.ts`** — add `ToolScope` (publicly typed).

The executor (`src/tools/executor.ts`) needs **no change**: by the time it runs, every tool is a fully-formed `ToolDefinition`. `finalise` builds a `run` adapter for rungs 1 and 2 that:
1. spreads `args` over the framework scope
2. calls the user function with the assembled `ToolScope`
3. captures the return value as `step.setVar(toolName, ...)` if not undefined

## Tests

- `tests/tool-helper.test.ts` — happy path for `tool(fn)`, `tool(name, fn)`, generic args inference, return-value-to-output convention (string / number / boolean / object / undefined), reserved-name shadowing warning.
- `tests/tool-finalise.test.ts` — pure-function tests for the `finalise` adapter: rung-1 / rung-2 / rung-3 inputs, name resolution priority (explicit > export key > filename), filename-regex enforcement.
- Extend `tests/tool-registry.test.ts` — multi-tool files via named exports, mix of bare-function and `tool()` and `defineTool` in one directory, filename-as-name fallback.
- Extend `tests/tool-end-to-end.test.ts` — add a fixture tool authored at rung 1 (bare function) and assert it executes against the live test-app.
- Add new fixture files at each rung in `fixtures/tools/src/`.

## Migration

Purely additive. Existing `defineTool({...})` files keep working unchanged. Projects with no tools get an empty catalogue. The shorthand call syntax (`[tool: name arg out.foo]`) we shipped earlier needs no change — every rung produces the same internal `ToolDefinition`.

## Open questions (deferred)

- **Reserved-name collision policy.** v1 warns and shadows; could be promoted to a hard error if it bites. Wait for a real case.
- **Filename normalisation.** v1 requires filenames match `/^[\w-]+$/`. Could later auto-normalise (`Capitalised.ts` → `capitalised`) but explicit beats clever for now.
- **Subdirectory namespacing.** `tools/src/strings/slugify.ts` registers as `slugify` in v1. If two files at different paths share a basename, registry throws a duplicate-name error and the author renames. Namespaced names (`strings/slugify`) are a clean follow-up if it bites.
- **Args type inference from `parameters` schema.** Rung 1 / rung 2 currently get `unknown` for caller args (with optional generic `A`). Pulling param types from `parameters` only applies at rung 3, where the existing `defineTool` generics already do the job.
