# Arrays in tools — extract a list and iterate in TypeScript

> **Implementation note (post-merge).** The shipped design diverges from the
> sketch below in one place: storage stays `Record<string, string>` end-to-end
> (with arrays JSON-encoded into the string slot), rather than widening to
> `Record<string, VarValue>` where `VarValue = string | string[]`. Reason:
> the wider type would have touched 7+ files including the server's wire
> format (`SessionState.outputs`, `StepRequest.parameters`). The
> JSON-stringly approach delivers the same authoring experience — `read
> multiple: true` produces a typed `string[]` inside the tool's `run({urls})`
> argument — without churning the API surface. Type-widening happens only at
> the tool boundary (parameter coercion + `setVar`); the story's "interpolate
> warns when an array variable is stringified" rule does not apply, since
> there's never an array-typed value in storage.

## Context

Today every variable captured during a test is a single string. The
`resolvedParameters` map is `Record<string, string>` end-to-end:

- [src/browser/actions.ts:76](../src/browser/actions.ts#L76) — `read` / `count`
  return `capturedValue?: string` only.
- [src/runner/step-executor.ts:993](../src/runner/step-executor.ts#L993) —
  `opts.resolvedParameters[action.as] = result.capturedValue` (string assignment).
- [src/tools/types.ts:134](../src/tools/types.ts#L134) — tool
  `outputs: Record<string, string>` and the `coerce` helper at
  [executor.ts:207](../src/tools/executor.ts#L207) only knows `string |
  number | boolean`.
- [src/tools/executor.ts:113](../src/tools/executor.ts#L113) — `setVar`
  stringifies whatever the tool writes (`String(value)`).

So "find every link inside section 1, then loop through them in a tool"
isn't natively expressible. The closest workaround is a tool that internally
queries the page and iterates — but that ties the **extraction selector** to
the tool's source code rather than letting the test author keep it in the
markdown where the rest of the test logic lives.

## Goals

1. Let a step capture **a list of values** from the DOM into a named
   variable — e.g., every `href` under `section 1`.
2. Let a tool receive that list as a typed `string[]` (or `number[]` /
   `boolean[]`) parameter and iterate naturally.
3. Let a tool emit a list output and have it land in `resolvedParameters`
   under the chosen name, ready to feed into the next tool call.
4. Keep string-valued capture and string-valued tool args unchanged —
   nobody who's written a string-only test/tool today needs to migrate.
5. Keep the markdown surface boring — adding a single attribute
   (`multiple: true`) is the entire authoring change.

The for-each markdown construct (AI-driven iteration over a list) is
deliberately **out of scope**. A tool that loops in TypeScript covers most
"scrape and iterate" use cases without touching the parser, runner loop, or
prompt rules. For-each can come later.

## Design

### 1. Storage: widen the variable scope to `string | string[]`

`resolvedParameters` becomes `Record<string, VarValue>` where:

```ts
export type VarValue = string | string[];
```

Two-element union — not a richer type — because the only new shape we need
is "list of strings". Numbers and booleans already round-trip through string
in tool coercion; arrays of those will be supported via the same
string-array storage with type coercion at the tool boundary.

The widening lives in one type alias and propagates everywhere the bag is
threaded today (test-runner, step-executor, server session-manager,
tools/executor). All existing string consumers keep working because:

- `interpolate('{{name}}', params)` — when the value is a `string[]`, it
  stringifies as `JSON.stringify(value)` so an authoring mistake (using a
  list variable in plain text) produces a visible JSON literal rather than
  `[object Array]`. A `dev.warn` notes the misuse.
- The session manager's `outputs` field on `SessionState` is API surface
  and stays `Record<string, string>` for backwards compatibility — list
  values are JSON-encoded when crossing the wire.

### 2. Capture action: `read` with `multiple: true`

Extending `read` is preferred over a new `extract_list` action because the
authoring mental model is identical — `read` already takes a `selector` +
optional `attribute` + `as` variable name. Adding one boolean keeps the
prompt simple.

```ts
// src/ai/types.ts (additions)
export interface AIAction {
  // ...existing fields...
  /**
   * For "read" actions, when true the action collects values from EVERY
   * element matching `selector` and stores them as a string[] in the
   * variable named by `as`. When false/omitted, only the first match is
   * captured (current single-value behaviour). Combine with `attribute`
   * to scrape e.g. every `href` under a section.
   */
  multiple?: boolean;
}
```

`executeRead` in [src/browser/actions.ts:647](../src/browser/actions.ts#L647)
gains a `multiple` branch:

```ts
if (action.multiple) {
  const locators = root.locator(selector);
  const count = await locators.count();
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = locators.nth(i);
    if (attribute === 'href' || attribute === 'src') {
      values.push(await item.evaluate(...));
    } else if (attribute) {
      values.push((await item.getAttribute(attribute)) ?? '');
    } else {
      values.push(await item.evaluate(...));
    }
  }
  return { success: true, capturedValues: values };
}
```

`ActionExecutionResult` gains a parallel field:

```ts
export interface ActionExecutionResult {
  // ...existing fields...
  capturedValue?: string;       // single-value (unchanged)
  capturedValues?: string[];    // list-value (new)
}
```

Step-executor's capture branch becomes:

```ts
if (result.capturedValues !== undefined && action.as) {
  opts.resolvedParameters[action.as] = result.capturedValues;
  logger.info(`Stored ${result.capturedValues.length} captured values as "{{${action.as}}}"`);
} else if (result.capturedValue !== undefined && action.as) {
  opts.resolvedParameters[action.as] = result.capturedValue;
  ...
}
```

The two branches are mutually exclusive — `multiple: true` populates
`capturedValues`, `multiple: false/omitted` populates `capturedValue`.

### Authoring example

```markdown
## Steps
1. Read every link under "Section 1" as href values into `section1Links`
   [as: section1Links] [multiple]
2. [tool: archive-links urls={{section1Links}}]
```

The AI emits:

```json
{
  "action": "read",
  "selector": "section.section-1 a[href]",
  "attribute": "href",
  "as": "section1Links",
  "multiple": true,
  "description": "Capture every link href under section 1"
}
```

Result: `resolvedParameters.section1Links` = `["/foo", "/bar", "/baz"]`.

### 3. Tool parameter type: `string[]`

`ToolParameter.type` gains a `'string[]'` variant (and naturally
`'number[]'` / `'boolean[]'`):

```ts
// src/tools/types.ts
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean'
      | 'string[]' | 'number[]' | 'boolean[]';
  description?: string;
  default?: string | number | boolean | string[] | number[] | boolean[];
}

type ParamValue<T extends ToolParameter> =
  T['type'] extends 'string'    ? string :
  T['type'] extends 'number'    ? number :
  T['type'] extends 'boolean'   ? boolean :
  T['type'] extends 'string[]'  ? string[] :
  T['type'] extends 'number[]'  ? number[] :
  T['type'] extends 'boolean[]' ? boolean[] :
  never;
```

So a tool author writes:

```ts
export default defineTool({
  name: 'archive-links',
  description: 'Save each URL into the archive table.',
  parameters: {
    urls: { type: 'string[]', description: 'URLs to archive' },
  },
  outputs: {
    archivedCount: { type: 'number' },
  },
  async run({ urls }, { page, log, step }) {
    log.info(`archiving ${urls.length} urls`);
    let n = 0;
    for (const url of urls) {                          // ← ergonomic loop
      await page.goto(url);
      await page.click('button.archive');
      n++;
    }
    step.setVar('archivedCount', n);
  },
});
```

### 4. Tool argument bridge: array-aware resolution

The bridge in `resolveAndCoerceArgs`
([executor.ts:166](../src/tools/executor.ts#L166)) currently calls
`interpolate(rawValue, resolvedParameters)` which produces a string. For
list-typed parameters we short-circuit when the raw arg is a single
`{{var}}` reference whose value is already an array:

```ts
function resolveArgValue(
  raw: string,
  schema: ToolParameter | undefined,
  params: Record<string, VarValue>,
): unknown {
  // Whole-arg variable reference: `{{name}}` and nothing else.
  // When the bound value is an array, pass it through verbatim — preserving
  // the array shape lets array-typed parameters skip JSON-string round-trip.
  const m = raw.match(/^\s*\{\{(\w+)\}\}\s*$/);
  if (m && Array.isArray(params[m[1]!])) {
    return params[m[1]!];
  }

  // Inline / mixed-text references stringify (existing behaviour).
  const interpolated = interpolate(raw, params);

  if (schema?.type.endsWith('[]')) {
    // Authoring fallback: accept a JSON literal when the tool wants an array
    // but the caller wrote out the list directly, e.g.
    // `[tool: x urls=["/a","/b"]]`.
    return parseJsonArray(interpolated, schema.type);
  }
  return interpolated;
}
```

Type coercion gains array branches:

```ts
function coerce(toolName, argName, type, raw): unknown {
  if (type === 'string')   return String(raw);
  if (type === 'number')   { /* existing */ }
  if (type === 'boolean')  { /* existing */ }
  if (type === 'string[]')  return assertStringArray(raw);
  if (type === 'number[]')  return assertStringArray(raw).map(coerceNumber);
  if (type === 'boolean[]') return assertStringArray(raw).map(coerceBoolean);
}
```

`assertStringArray` accepts either:
- a real `string[]` (when `raw` came through array passthrough), or
- a JSON-decoded array (when the caller wrote a JSON literal in the
  invocation).

It throws a labelled error if the value is neither — matching the existing
`coerce` error format.

### 5. Tool output bridge: `setVar` accepts arrays

`ToolStepApi.setVar` widens its `value` type:

```ts
setVar(name: OutputName<O>, value: string | number | boolean | string[]): void;
```

The implementation
([executor.ts:107](../src/tools/executor.ts#L107)) stops calling `String(value)`
on arrays:

```ts
setVar(name, value) {
  if (!declaredOutputs.has(name)) { /* unchanged */ }
  const stored: VarValue = Array.isArray(value)
    ? value.map(String)
    : (typeof value === 'string' ? value : String(value));
  options.resolvedParameters[aliased] = stored;
  // For the report's outputs map, store the list as a JSON literal so
  // existing report rendering (which expects strings) keeps working.
  captured[aliased] = Array.isArray(stored) ? JSON.stringify(stored) : stored;
}
```

`ToolOutput.type` gets the same `'string[]'` extension as `ToolParameter`,
so `defineTool` can declare an array output. (Output coercion is light — the
declared type is informational; the runtime value is whatever `setVar`
stored.)

### 6. Markdown shorthand for clarity

Authoring `[tool: x urls={{section1Links}}]` already works through the
bridge changes above. For the inline case (no captured variable), the
caller can write a JSON array literal:

```markdown
1. [tool: archive-links urls=["https://a", "https://b"]]
```

The tool-call parser
([src/tools/tool-call-parser.ts](../src/tools/tool-call-parser.ts)) already
preserves quoted strings; allowing `[...]` arrays is a small extension —
treat the value as raw text up to the matching `]`, and let the bridge's
JSON-array fallback decode it.

### 7. Summary of file-level changes

| File | Change |
|---|---|
| [src/parser/parameters.ts](../src/parser/parameters.ts) | `interpolate` JSON-encodes array values, logs warning. |
| [src/ai/types.ts](../src/ai/types.ts) | `AIAction.multiple?: boolean`. |
| [src/ai/prompts.ts](../src/ai/prompts.ts) | One paragraph documenting `read … multiple: true`. |
| [src/ai/action-parser.ts](../src/ai/action-parser.ts) | Pass `multiple` through. |
| [src/browser/actions.ts](../src/browser/actions.ts) | `executeRead` `multiple` branch; `ActionExecutionResult.capturedValues`. |
| [src/runner/step-executor.ts](../src/runner/step-executor.ts) | Store `capturedValues` into the param map. |
| [src/tools/types.ts](../src/tools/types.ts) | `ToolParameter.type` adds `'*[]'` variants; `ParamValue` mapping; `setVar` widening; new `VarValue` export. |
| [src/tools/executor.ts](../src/tools/executor.ts) | `resolveAndCoerceArgs` array passthrough + JSON-literal fallback; `coerce` array branches; `setVar` array storage. |
| [src/tools/tool-call-parser.ts](../src/tools/tool-call-parser.ts) | Optional: support `[...]` JSON-array literals as raw arg values. |
| [src/server/session-manager.ts](../src/server/session-manager.ts) | Type-thread the widened map; JSON-encode arrays in the API-shaped `outputs`. |

## Worked example — extract → loop

A test that visits every product link in a category and captures its title:

```markdown
---
tags: [smoke, catalog]
---

# Catalog scrape

## Config
- baseUrl: ${env.BASE_URL}

## Steps
1. Open /catalog/widgets and wait for the grid to load
2. Read every product link as an href into `links` [multiple]
3. [tool: visit-each urls={{links}}]
4. Assert that {{titles}} contains "Premium Widget"
```

The `visit-each` tool:

```ts
// fixtures/tools/visit-each.ts
import { defineTool } from 'steptix';

export default defineTool({
  name: 'visit-each',
  description: 'Visit every URL and capture the page title.',
  parameters: {
    urls: { type: 'string[]', description: 'URLs to visit in order' },
  },
  outputs: {
    titles: { type: 'string[]' },
  },
  async run({ urls }, { page, log, step }) {
    const titles: string[] = [];
    for (const url of urls) {
      log.info(`visiting ${url}`);
      await page.goto(url);
      titles.push(await page.title());
    }
    step.setVar('titles', titles);
  },
});
```

Authoring change vs. today: one extra `[multiple]` flag on step 2, one
`'string[]'` parameter type on the tool. Storage, bridge, and consumer all
fall out from the design.

## Failure modes & error messaging

| What | When | What user sees |
|---|---|---|
| `[multiple]` on `read` returns 0 elements | empty selection | Variable bound to `[]` (empty array). Tool sees `urls.length === 0` and can decide whether to fail. No implicit error. |
| Plain `{{links}}` in step text | array variable used in interpolation | Renders as JSON literal `["a","b"]`; warning logged: `array variable "links" stringified into "{{links}}" — use a tool to iterate, or expect JSON literal output`. |
| Tool declares `urls: 'string[]'`, caller passes a string | type mismatch | Existing `coerce` error format: `Tool "x" parameter "urls" expected a string[], got "https://example.com"` |
| Tool declares `urls: 'number[]'`, caller passes `["a","b"]` | per-element coercion | `Tool "x" parameter "urls"[0] expected a number, got "a"` |
| Inline JSON array malformed | `urls=[unclosed` | parse error from tool-call parser, with caret diagnostic. |

## Migration & backwards compat

- Existing string-only tests: byte-identical behaviour.
- Existing string-only tools: byte-identical behaviour. The `ParamValue`
  type union grows but every existing parameter keeps its concrete type.
- Existing `read` calls without `multiple`: byte-identical (single-string
  capture).
- Server SessionState API: `outputs: Record<string, string>` shape kept;
  array values JSON-encode when crossing the wire so external consumers
  (e.g. CI scripts) don't see a type change.
- The `interpolate` warning on array-into-string is informational, not a
  failure — gives time for tests written in the transition window to be
  updated without breaking.

## Open questions (deferred)

- **`for-each` markdown construct**? Out of scope here — tools-loop covers
  the common case. Revisit when AI-driven per-item flows appear.
- **Object arrays** (e.g. `[{href, text}, ...]`)? Out of scope — `string[]`
  + a paired second `read` (e.g. `linkHrefs` and `linkTexts`) covers it
  with one extra step. Object-array support would require widening
  `VarValue` to `JsonValue`, which is a much larger change.
- **Limit / chunking on capture**? Likely needed for huge selections;
  v1 captures all matches.
- **Stable ordering across re-renders**? `locator.nth(i)` follows DOM
  order at capture time; document but don't try to enforce.
- **Array-typed `find`/`extract_value`**? Out of scope — `read multiple`
  is the focused capture path; `find` stays AI-exploration-only.

## Implementation order

1. Widen `VarValue` type and thread through the runner / step-executor /
   server session-manager. Tests pass with no behaviour change.
2. Extend `read` with `multiple: true` and `capturedValues`. Add
   action-parser pass-through and prompt rule.
3. Widen `ToolParameter.type` + `setVar` value type + `coerce` branches.
4. Tool-call parser: accept `[...]` JSON-array literals as inline values.
5. Tests: unit tests on every layer (action parsing, executeRead with
   multiple, coerce array branches, setVar with array, interpolate warning),
   plus an integration test that exercises the full extract → loop → assert
   pipeline against the test-app.
6. Worked example test (`fixtures/tests/array-loop-demo.md`) +
   `fixtures/tools/visit-each.ts`.
