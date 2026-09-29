# Lazy tool loading and path-qualified tool references

## Context

Tool files are loaded by [`loadToolCatalogue`](../src/tools/registry.ts), which
**eagerly imports every file** in `tests.toolsDir` up front:

```ts
const files = await listToolFiles(dir);
for (const file of files) {
  await loadOne(file, catalogue);   // import() each file, register its exports
}
```

The server builds this catalogue once per session, at the start of the first
run that supplies a `toolsDir` ([session-manager.ts](../src/server/session-manager.ts)),
and the CLI runner does the same at startup ([test-runner.ts](../src/runner/test-runner.ts)).
Two problems fall out of "import everything, up front":

1. **One broken file blocks the whole project.** If any tool file throws while
   loading — an unresolved import, a name-validation failure, a duplicate-name
   collision — the exception propagates out of `loadToolCatalogue`, the server
   catches it and returns the **entire session** as `status: 'error'`. A test
   that never invokes the broken tool — or uses no tools at all — fails before a
   single step runs. This is a real, observed failure: a `check_health.ts` whose
   `import { tool } from 'steptix/tools'` couldn't resolve took down an
   unrelated, tool-free test.

2. **It doesn't scale.** A project with thousands of tools pays to `import()`
   (evaluate the module, resolve its imports) for *every* tool at run start,
   even when a test calls one of them. The cost is linear in the size of the
   tool library, not in what the test actually uses.

The invocation path already does the right thing — [`executeToolStep`](../src/tools/executor.ts)
wraps `catalogue.require(name)` in try/catch and turns a lookup failure into a
single failed step, not a session abort. The only reason a broken tool nukes the
project is the eager *build*. This doc proposes moving tool loading to be lazy
and per-tool, addressing both problems at once, and introduces a reference
grammar that makes lazy resolution unambiguous and O(1).

This supersedes the "Subdirectory namespacing" open question deferred in
[lowering-tool-boilerplate.md](lowering-tool-boilerplate.md).

## Goals

1. **Failure isolation.** A tool file that fails to load must not affect tests
   that don't invoke it. The error surfaces only when a `[tool: ...]` step
   actually asks for that tool, as a single failed step with the real error.
2. **Lazy, O(1) loading.** A test that invokes one tool imports exactly the
   file(s) it needs — never the whole directory. A project with thousands of
   tools has the same run-start cost as a project with three.
3. **Unambiguous resolution.** A tool reference deterministically names one
   file and one tool inside it, with no filesystem-precedence guessing and no
   need for load-time clash validation.
4. **Keep today's common case unchanged.** `[tool: check_health]` for a
   single-tool file named `check_health.ts` keeps working verbatim.

## Design

### Reference grammar: `path.../toolName`

A tool reference is a `/`-separated path. The **last segment is the tool name**;
everything before it is the **file path** (relative to `toolsDir`, `.ts`
appended). A **single segment** is sugar for "this file, its default/sole tool".

```
[tool: check_health]                  → file check_health.ts, default/sole tool   (sugar)
[tool: auth/login]                    → file auth.ts,          tool `login` inside it
[tool: auth/logout]                   → file auth.ts,          tool `logout` inside it
[tool: auth/login/login]              → file auth/login.ts,    tool `login` inside it
[tool: integrations/stripe/refund/refund]
                                      → file integrations/stripe/refund.ts, tool `refund`
```

Formally:

```
ToolRef    := Segment ('/' Segment)*
Segment    := [\w-]+

resolve(ToolRef):
  segments := split(ToolRef, '/')
  if segments.length == 1:
    file := segments[0] + '.ts'        # sugar
    tool := <default/sole export of file>
  else:
    file := join(segments[0..n-1], '/') + '.ts'
    tool := segments[n-1]              # last segment
```

The rule is **fully deterministic** — splitting last-segment-as-tool needs no
disk access. This is what removes the ambiguity that a single `/` delimiter
would otherwise create:

```
tools/src/
├─ auth.ts          (exports `login`, `logout`)
└─ auth/
   └─ login.ts      (tool `login`)
```

- `[tool: auth/login]`        → `auth.ts` → `login`        (file part is `auth`)
- `[tool: auth/login/login]`  → `auth/login.ts` → `login`  (file part is `auth/login`)

The two are spelled differently *by construction*, so the layout above — a file
sharing a name with a sibling directory — is no longer a problem and needs no
validation.

### Consequence: the reference is strict

The last segment is **always** a tool name, never a file's default. So:

- `auth/login` *always* means "tool `login` in `auth.ts`", even if `auth/login.ts`
  also exists. To reach that file you must write `auth/login/login`.
- A nested single-tool file is referenced by spelling out the tool:
  `stripe/refund/refund`. Only the **top-level single-segment** form
  (`check_health`) gets the default-tool sugar.

This trades a little verbosity for total predictability — `auth/login` resolves
identically regardless of what files happen to exist around it.

### Lazy resolution

`loadToolCatalogue(dir)` no longer imports anything. It walks the directory and
builds a cheap **file index** (`relative-path-without-ext → absolute-path`) plus
the existing diagnostics. No `import()` runs at build time.

Resolution becomes async and per-tool:

```
async resolve(ref):
  (filePath, toolName, isSugar) := parseRef(ref)            # pure, no I/O
  if not loaded(filePath):
    loadFile(filePath)                                       # import() exactly one file
  if isSugar:    return the file's default/sole registered tool
  else:          return the tool registered under `toolName` from that file
```

- **O(1):** the file path is explicit in every reference, so we import exactly
  one file. There is **no fallback directory scan** — the grammar guarantees we
  always know which file to load.
- **Cached:** once a file is imported, its tools stay registered for the session;
  later references to the same file are map lookups.
- **Isolation falls out for free:** a file is imported only when something
  references it. If `check_health.ts` is broken, it's imported only when a step
  asks for `check_health`; tests that don't reference it never touch it. There
  is no "broken registry" built up front at all — there's nothing to build.

When `loadFile` fails, the error is recorded against that file and re-thrown by
`resolve`; `executeToolStep` already converts that into a single failed step
(see [executor.ts](../src/tools/executor.ts)). A subsequent reference to a
*different* tool is unaffected.

### Trade-off: cross-file duplicate detection weakens

Eager loading imported every file and so could detect two *different* files that
resolved to the same tool name (e.g. `check_health.ts` and a
`monitoring.ts` that declared `defineTool({ name: 'check_health' })`). Lazy
loading imports only the file a reference names, so it can't see that clash.

Under the new grammar this is largely moot:

- **Within-file duplicates stay caught.** Two exports in one file claiming the
  same name still trip `register` the moment that single file is imported, and
  the file is recorded broken.
- **Cross-file clashes can't be expressed.** A reference resolves to exactly one
  file by path, so `auth/login` and `monitoring/check_health` name distinct
  files; there is no shared namespace for two files to collide in. The eager
  duplicate-name error is therefore retired, not worked around.

### Where failures surface

| Situation | Behaviour |
|---|---|
| Test uses no tools | Catalogue build does no imports → **runs**, regardless of broken files present |
| Test invokes a healthy tool | That one file imports lazily → runs |
| Test invokes a broken tool | That file imports, throws → **single failed step** with the real error |
| Test invokes a missing tool | No such file/tool → single failed step, existing "not found" diagnosis |

## Implementation outline

### Modified code

- **[src/parser/invocation-parser.ts](../src/parser/invocation-parser.ts)** —
  the name is read by `scanner.readIdentifier({ allowHyphen: true })`
  (`[\w-]+`). Allow `/` within the name token so `auth/login/login` is captured
  as a single `name`. (The arg grammar is untouched; `(args)` and `out.x` work
  as before.)
- **[src/tools/tool-call-parser.ts](../src/tools/tool-call-parser.ts)** /
  **[src/tools/types.ts](../src/tools/types.ts)** — split the parsed `name` into
  `{ file, tool, isSugar }` (or carry the raw ref and parse it in the catalogue —
  decide during build). `ToolCall.name` is currently a flat string; either
  extend it or add resolved fields. Keep `label`, `args`, `outputAliases`
  unchanged.
- **[src/tools/registry.ts](../src/tools/registry.ts)**:
  - `loadToolCatalogue` becomes index-only — walk the dir, build the
    path→file map, set `diagnostics`. No imports. (Keep the missing-dir and
    not-a-directory handling.)
  - Extract the import-and-register body of today's `loadOne` into a
    `loadFile(filePath)` that imports one file and registers its exports,
    capturing failures into a per-file `broken` map (keyed by file path).
  - `ToolCatalogue` gains: the file index, a `loadedFiles` set, the `broken`
    map, and an **async `resolve(ref)`** implementing the fast path above.
    `require`/`get` remain for already-loaded lookups; `resolve` is the new
    entry point for invocation.
  - Drop the eager cross-file duplicate-name error (within-file duplicates still
    throw from `register` during `loadFile`).
- **[src/tools/executor.ts](../src/tools/executor.ts)** — replace
  `options.catalogue.require(call.name)` with `await options.catalogue.resolve(...)`.
  The surrounding try/catch that maps a failure to a failed `ToolStepOutcome` is
  already correct and stays.
- **[src/server/session-manager.ts](../src/server/session-manager.ts)**:
  - The reload gate currently triggers on `cachedCatalogue.size === 0`
    ([the `needsCatalogueLoad` block](../src/server/session-manager.ts)). With
    lazy loading `size` (loaded count) is legitimately 0 at session start, so
    switch the "empty" check to the **indexed file count** (reload only when the
    prior scan found no files, i.e. a dir that was missing/empty and may now be
    fixed) and on `toolsDir` change.
  - The `tool:awaiting-debugger` path calls `toolCatalogue.get(name)` for the
    tool's `filePath` ([here](../src/server/session-manager.ts)); ensure the file
    is resolved first (`await resolve(...)`, swallowing errors) so the filePath
    is available when stepping into a not-yet-loaded tool.
- **[src/runner/test-runner.ts](../src/runner/test-runner.ts)** — no logic
  change; the startup `loadToolCatalogue` is now cheap (index-only) and tools
  resolve lazily through `executeToolStep`.

### Naming resolution

`loadFile` still uses the existing rung ladder and `resolveName`
([finalise.ts](../src/tools/finalise.ts)): explicit name > export key > filename.
For the **sugar** case (single-segment ref), the file is expected to expose a
single default/sole tool; if a sugar-referenced file registers multiple tools
and none matches the filename, that's a resolution error with a clear message
("file `auth.ts` exposes multiple tools — reference one as `auth/<name>`").

## Tests

- **`tests/tool-ref-parser.test.ts`** — pure parse of references: single-segment
  sugar; `auth/login` → `{ file: 'auth', tool: 'login' }`; `auth/login/login` →
  `{ file: 'auth/login', tool: 'login' }`; hyphens; rejection of empty segments
  (`auth//login`), leading/trailing slash.
- **Extend `tests/tool-registry.test.ts`** — `loadToolCatalogue` imports nothing
  at build time (assert no module side-effects fire until `resolve`); `resolve`
  imports exactly the named file; a broken file does not prevent resolving a
  healthy sibling; within-file duplicate names still throw on that file's load
  and are isolated to it.
- **Extend `tests/tool-end-to-end.test.ts`** — a fixture project with a broken
  tool file plus a tool-free test (the test runs green) and a test that invokes
  the broken tool (that step fails with the import error); a multi-tool file
  referenced via `auth/login` and `auth/logout`; a nested file referenced via
  `dir/file/tool`.
- **Fixtures** — add a multi-tool file and a deliberately-broken tool file under
  `fixtures/tools/src/` (e.g. one importing a non-existent package), and tests
  exercising both reference forms.

## Migration

- **Existing single-tool references are unchanged.** `[tool: check_health]` still
  resolves to `check_health.ts`'s default tool via the sugar rule.
- **Multi-tool files now require the `file/tool` form.** Today a named export
  `login` in `auth.ts` is referenced as `[tool: login]` (flat name). Under this
  design it becomes `[tool: auth/login]`. This is a breaking change for any
  existing test that references a named-export tool by its bare name. Audit
  fixtures and docs; provide a clear "tool 'login' not found — did you mean
  'auth/login'?" hint when a bare name matches a known export in some file.
- **The eager duplicate-name startup error is removed.** Projects that relied on
  it to catch cross-file clashes lose that signal; the path-qualified grammar
  makes such clashes unrepresentable instead.

## Open questions (deferred)

- **Bare-name compatibility shim.** Should we keep a fallback that resolves a
  bare `[tool: login]` to a named export by scanning, purely for migration, with
  a deprecation warning? It reintroduces an O(n) scan, so default to **no** — but
  a behind-a-flag shim could ease a large existing test suite.
- **Sugar for nested single-tool files.** Whether `dir/file` (two segments)
  could ever mean "file `dir/file.ts`, default tool" instead of "tool `file` in
  `dir.ts`". Rejected here (it reintroduces ambiguity), but worth revisiting if
  the verbosity of `dir/file/file` proves annoying in practice.
- **Concurrency.** Steps run sequentially today, so `resolve` needs no locking.
  If tool steps are ever parallelised, `loadFile` should dedupe in-flight imports
  per file via a promise cache.
