# JSON-only config migration (`aiui.config.json`)

## Context

The framework config lives in `aiui.config.ts` — a TypeScript module that
default-exports a `defineConfig({...})` object. Two independent consumers read
it, in two incompatible ways:

- **The CLI / server** (`src/config/loader.ts`) dynamically `import()`s the
  file (via tsx) and reads `module.default`, then merges it over
  `DEFAULT_CONFIG`.
- **TestBench-native** (`testbench-native/src/extension/aiui-config.ts`) never
  imports the file — it reads it as **text** and runs a regex to scrape the
  `skillsDir` / `toolsDir` string literals out, because compiling TS inside the
  extension host is impractical.

This split causes three problems:

1. **Editor squiggles on external test repos.** A config that lives outside the
   `ai-ui-automation` package can't resolve `import { defineConfig } from
   'ai-ui-automation'`, so the TS language server flags it — even though the
   import is irrelevant to how TestBench reads the file.
2. **The TestBench regex is fragile.** It only matches plain quoted string
   literals. `skillsDir: path.join(__dirname, 'skills')` silently fails to
   match, and the test then runs with no skills and no error.
3. **Shallow config merge is a footgun.** `mergeConfig`
   ([src/config/loader.ts:10-33](../src/config/loader.ts#L10-L33)) only merges
   two levels deep. A partial `browser.viewport`, `browser.windowSize`, or
   `browser.domNoiseReduction` in a user config silently drops its sibling
   defaults instead of inheriting them.

There is also a latent inconsistency: the scaffolded template puts `skillsDir`
at the **top level** ([templates/init/aiui.config.ts:20](../templates/init/aiui.config.ts#L20)),
but the canonical schema and the CLI both expect it under `tests.skillsDir`
([src/config/types.ts:101-114](../src/config/types.ts#L101-L114)). The CLI
ignores the template's top-level `skillsDir`; only TestBench's loose regex
happens to find it.

The whole user base is migrating in lockstep, so **we do not need backward
compatibility**. We can drop `.ts` / `.js` / `.mjs` config support entirely and
make `aiui.config.json` the single source of truth, read identically (real
`JSON.parse`) by both consumers.

## Goals

1. `aiui.config.json` is the **only** config filename the framework looks for.
   Drop `aiui.config.{ts,js,mjs}` and the legacy `ai-ui-auto.config.*` names
   everywhere.
2. The CLI loader reads JSON via `JSON.parse`, no tsx involvement for config.
3. TestBench-native reads the same JSON via `JSON.parse` and pulls
   `tests.skillsDir` / `tests.toolsDir` from the parsed object — no more regex.
4. A committed JSON Schema lets editors give autocomplete + validation via a
   `"$schema"` key, replacing the type-safety that `defineConfig` gave.
5. `mergeConfig` becomes a true **recursive deep merge** so partial nested
   objects inherit sibling defaults; arrays and primitives still replace.
6. Fix the `skillsDir` nesting inconsistency — canonicalize on
   `tests.skillsDir` / `tests.toolsDir` everywhere (template, docs, project's
   own config).

## Non-goals

- Adding new config fields or changing the `Config` shape (other than the
  `$schema` allowance).
- Changing how secrets/env overrides work — `withEnvDefaults`
  ([src/config/loader.ts:75-118](../src/config/loader.ts#L75-L118)) and
  `applyCliOverrides` stay exactly as they are.
- Touching testbench-monaco or flick-vscode — neither reads the config
  (confirmed: no references to `aiui.config` / `skillsDir` in either tree).

## Design

### Config format

`aiui.config.json` is a plain JSON object matching the existing `UserConfig`
(deep-partial `Config`) shape, plus an optional `$schema` key for editors:

```json
{
  "$schema": "https://raw.githubusercontent.com/pkent/ai-ui-automation/main/schema/aiui.config.schema.json",
  "ai": {
    "gatewayUrl": "https://aiapi.example.com",
    "model": "gpt-5.4-mini"
  },
  "browser": {
    "headed": true
  },
  "tests": {
    "dir": "./tests",
    "contextDir": "./context",
    "skillsDir": "./skills",
    "toolsDir": "./tools/src"
  },
  "reports": {
    "outputDir": "./reports"
  }
}
```

Notes:

- Every field is optional; anything omitted falls back to `DEFAULT_CONFIG`
  ([src/config/defaults.ts](../src/config/defaults.ts)). With the new deep
  merge, `"browser": { "viewport": { "width": 800 } }` now keeps the default
  `height` instead of dropping it.
- Secrets stay in `.env` (`AI_API_KEY`, `SERVER_API_KEY`, etc.) — they were
  never meant to live in the committed config and `withEnvDefaults` already
  injects them.
- The `$schema` key must be allowed through the merge as a no-op (it is not a
  `Config` field). The loader strips it before merging (see Phase 1).

### `$schema` strategy

Generate the schema from the `Config` TypeScript interface so it cannot drift:

- Add `ts-json-schema-generator` as a devDependency.
- Add an npm script `build:schema` that emits
  `schema/aiui.config.schema.json` from `src/config/types.ts` (root type
  `UserConfig`, since all fields are optional in a user config).
- Commit the generated schema to the repo at `schema/aiui.config.schema.json`
  and ship it in the published package `files` list, so consumers can also
  reference it by a relative/installed path if they prefer not to use the URL.
- Reference it from templates and docs via the raw-GitHub URL above (works for
  external test repos with no local install).

Decision to confirm: **generated vs hand-written schema.** Recommendation:
generated, because the `Config` interface is the source of truth and a
hand-written schema will rot. Cost: one devDependency + one build script + a
committed artifact.

### Deep-merge upgrade

Replace the two-level merge in `mergeConfig` with a recursive merge:

- Plain objects (`{}`-like, non-array) merge key-by-key, recursing.
- Arrays replace wholesale (e.g. `execution.defaultHooks.beforeEach` — a user
  array overrides the default array, it does not concatenate).
- Primitives and `undefined`-skips behave as today (`undefined` override is
  ignored, falling through to the default).

This makes `browser.viewport`, `browser.windowSize`, and
`browser.domNoiseReduction` partial-override correctly — the current footgun.

## Phase 1 — CLI / server loader (`src/config/`)

**`src/config/loader.ts`**

- `resolveConfigPath` ([loader.ts:35-68](../src/config/loader.ts#L35-L68)):
  reduce the candidate list to a single name, `aiui.config.json`. Keep the
  `configPath` passthrough for an explicit `--config` flag (must end in
  `.json`).
- `loadConfig` ([loader.ts:121-151](../src/config/loader.ts#L121-L151)):
  replace the dynamic `import(fileUrl)` with
  `JSON.parse(await fs.readFile(resolvedPath, 'utf8'))`. Strip a leading
  `$schema` key from the parsed object before passing to `mergeConfig`.
- **Error behavior change:** today a failed import logs a warning and falls
  back to defaults ([loader.ts:146-150](../src/config/loader.ts#L146-L150)).
  For JSON, **malformed JSON should be a hard error** (throw with the file path
  and parse message) rather than a silent fallback — a typo in the sole config
  source should fail loudly, not run with surprising defaults. A *missing* file
  still falls back to defaults silently (unconfigured project is valid).
  *Decision to confirm.*
- `mergeConfig` ([loader.ts:10-33](../src/config/loader.ts#L10-L33)): replace
  with the recursive deep merge described above.
- `withEnvDefaults` and `applyCliOverrides`: unchanged.

**`src/config/types.ts`**

- Keep `Config`, all sub-interfaces, `DeepPartial`, `UserConfig` — still the
  internal source of truth and the schema-generation input.
- `defineConfig` ([types.ts:237-239](../src/config/types.ts#L237-L239)):
  becomes dead for end users. Remove it from the public surface (and from
  `src/index.ts` exports if present). *Decision to confirm — alternatively
  leave it exported as harmless dead code; recommendation is to remove for a
  clean break.*

**Schema generation**

- `package.json`: add `ts-json-schema-generator` devDependency and a
  `build:schema` script; wire it into the main `build` so the committed schema
  stays current. Add `schema/` to the package `files` allowlist.
- Commit `schema/aiui.config.schema.json`.

**Tooling note:** `tsx` stays in dependencies — it is still used for the dev
runtime (`tsx src/index.ts`) and `.vscode/launch.json`. It is simply no longer
used to load config.

## Phase 2 — `aiui init` scaffolding + project's own config

**`src/cli/commands/init.ts`**

- Scaffold `aiui.config.json` instead of `aiui.config.ts`
  ([init.ts:42-46](../src/cli/commands/init.ts#L42-L46), and the inline
  fallback template at [init.ts:84-104](../src/cli/commands/init.ts#L84-L104)).
- The scaffolded JSON must include `$schema` and put `skillsDir`/`toolsDir`
  under `tests` (fixing the current top-level-`skillsDir` bug).
- Update the "Next steps" hints ([init.ts:77](../src/cli/commands/init.ts#L77))
  to say `aiui.config.json`.

**`templates/init/aiui.config.ts` → `templates/init/aiui.config.json`**

- Replace with the JSON template (delete the `.ts` file).

**`aiui.config.ts` (repo root) → `aiui.config.json`**

- Convert the project's own config to JSON. The current file uses
  `{ ...DEFAULT_BROWSER_DIMENSIONS }` for `viewport`/`windowSize`; in JSON,
  either inline the literal dimensions or omit them to inherit defaults (they
  already equal the default). Drop the commented-out `process.env.AI_API_KEY`
  line — that's handled by `.env` + `withEnvDefaults`. Faithful conversion:

```json
{
  "$schema": "./schema/aiui.config.schema.json",
  "ai": {
    "gatewayUrl": "https://llm.corp.example",
    "maxInputTokens": 1000000,
    "streamResponses": false,
    "sendScreenshots": false
  },
  "browser": {
    "headed": true,
    "slowMo": 0,
    "browser": "chromium",
    "stealth": false,
    "bypassCSP": false
  },
  "tests": {
    "dir": "./fixtures/tests",
    "contextDir": "./fixtures/context",
    "skillsDir": "./fixtures/skills",
    "toolsDir": "./fixtures/tools/src",
    "pattern": "**/*.md"
  },
  "execution": {
    "timeout": 3600000,
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
  },
  "server": { "host": "127.0.0.1", "port": 3100 },
  "cache": { "enabled": true, "dir": ".cache" }
}
```

  (`viewport`/`windowSize` omitted — they equalled the defaults via
  `DEFAULT_BROWSER_DIMENSIONS`. The root `$schema` uses a relative path since
  the schema ships in this repo.)

## Phase 3 — TestBench-native reader

**`testbench-native/src/extension/aiui-config.ts`**

- `CONFIG_FILENAMES` ([aiui-config.ts:19](../testbench-native/src/extension/aiui-config.ts#L19)):
  reduce to `['aiui.config.json']`.
- Replace the regex-based `resolveDeclared`
  ([aiui-config.ts:82-87](../testbench-native/src/extension/aiui-config.ts#L82-L87))
  with `JSON.parse` of the file text, then read `parsed?.tests?.skillsDir` and
  `parsed?.tests?.toolsDir`, resolving each against the config file's directory
  (same `path.resolve(configDir, value)` behavior). Non-string / missing →
  `null`, as today.
- This is strictly more robust: it now reads the canonical `tests.*` nesting
  and tolerates any JSON formatting. Keep the mtime cache
  ([aiui-config.ts:21-23,41-42,57](../testbench-native/src/extension/aiui-config.ts#L21-L23)).
- Wrap `JSON.parse` in try/catch — a malformed config should yield `null`
  (no skills/tools, same as "not found") plus a console warning, not a thrown
  exception that breaks F12 / run.

**`testbench-native/src/extension/definition-provider.ts`**

- Update the warning text "no aiui.config.{ts,js,mjs} found above…"
  ([definition-provider.ts:40](../testbench-native/src/extension/definition-provider.ts#L40))
  to reference `aiui.config.json`.

**`testbench-native/src/extension/cache-paths.ts`**

- `PROJECT_MARKERS` ([cache-paths.ts:4-9](../testbench-native/src/extension/cache-paths.ts#L4-L9)):
  reduce to `['aiui.config.json']` (it already includes it; drop the TS/JS
  variants).

**`testbench-native/src/extension/commands/index.ts`**

- Update the "no aiui.config.* above this file" status message
  (~[commands/index.ts:266](../testbench-native/src/extension/commands/index.ts#L266))
  to name `aiui.config.json`.

**`testbench-native/package.json`**

- Bump the patch version (0.5.32 → 0.5.33) per the repo's extension-bump rule,
  since runner-core isn't touched but extension source is.

**`src/server/project-root.ts`**

- `PROJECT_MARKERS` ([project-root.ts:5-10](../src/server/project-root.ts#L5-L10)):
  reduce to `['aiui.config.json']`.

## Phase 4 — Docs

Rewrite every TS-config example to JSON and update file-name references:

- `README.md` — lines 175, 244-252, 445-465 (project tree + Configuration
  section + `tools.dir` example).
- `SPEC.md` — lines 451-498 (the main `### aiui.config.ts` section → JSON),
  539 (`--config` default), 554 (init tree), 883 ("Load config from…").
- `SPEC-API.md` — lines 389, 583-596 (`api` config example).
- `SPEC-UI.md` — line 27.
- `CHANGELOG.md` — add a breaking-change entry: config is now JSON-only.
- `stories/test-hooks.md` (92-95, 227),
  `stories/tools-with-playwright-access.md` (72-97, 472),
  `stories/cdp-connection.md` (107),
  `stories/flick-vscode-cdp-attach.md` (256),
  `fixtures/skills/dismiss_obstacles.md` (14-21) — convert inline config
  snippets.
- `testbench-native/docs/step-into-status.md` (56-59) and
  `testbench-native/stories/specs/step-cache-server.md` (56-59) — update the
  project-root marker lists to `aiui.config.json`.

## Backward compatibility

**None — this is a breaking change**, by explicit decision. After this:

- A project with only `aiui.config.ts` will be treated as **unconfigured** by
  the CLI (falls back to defaults) and as "no config found" by TestBench (no
  skills/tools, F12 warns). There is no shim or auto-migration.
- The CHANGELOG entry must call this out and show the one-step migration
  (rename + reshape to JSON). A tiny `aiui migrate-config` helper is **out of
  scope** unless requested.

## Test plan

**CLI loader — `tests/config-loader.test.ts`** (extend; currently only covers
`withEnvDefaults`):

1. Loads a valid `aiui.config.json` and merges over defaults (omitted keys take
   defaults).
2. **Deep merge:** `{ browser: { viewport: { width: 800 } } }` yields
   `width: 800` AND the default `height` (the regression this fixes). Same for a
   single `domNoiseReduction` flag leaving the other six at their defaults.
3. **Array replace:** `execution.defaultHooks.beforeEach: ["x"]` replaces, does
   not concatenate.
4. Missing config file → pure defaults, no throw.
5. Malformed JSON → throws with the file path (per the Phase 1 decision).
6. `$schema` key present → ignored, does not appear in the merged `Config`.
7. A `.ts`/`.js`/`.mjs` file present but no `.json` → treated as no config
   (defaults), proving the old formats are no longer loaded.

**Schema:** a test that `JSON.parse`s `schema/aiui.config.schema.json` and
validates the committed `aiui.config.json` and the template against it (using a
lightweight validator, or at minimum asserts the schema parses and has the
expected top-level keys). *Optional — confirm whether to add a validator dep.*

**TestBench-native — add `testbench-native/tests/` unit coverage** for the new
`resolveProjectDirs` (there is none today):

1. Valid JSON with `tests.skillsDir`/`tests.toolsDir` → absolute paths resolved
   against the config dir.
2. JSON without a `tests` block → both `null`.
3. Malformed JSON → both `null`, no throw.
4. mtime cache: second call without a file change returns the cached object.

**Full regression:** `npx vitest run` (server), `npm test` in testbench-native,
plus the existing runner-core / flick-vscode suites (untouched, but run to
confirm nothing imports the removed `defineConfig`). Typecheck all packages.

## Sequencing

Phase 1 (loader + schema + deep merge) is the spec-locked core and should land
first with its tests green. Phases 2 (scaffolding/own-config) and 4 (docs) are
independent and can proceed in parallel once the JSON shape is fixed. Phase 3
(TestBench) only depends on the agreed JSON shape (canonical `tests.*`
nesting), so it can run in parallel with 2/4. The TestBench VSIX bump + install
verification happens last so the user can confirm skills still resolve from a
real `aiui.config.json`.

## Decisions (confirmed)

1. **Schema:** generated from `src/config/types.ts` via
   `ts-json-schema-generator`, committed to `schema/aiui.config.schema.json`,
   regenerated as part of `build`. ✅
2. **Malformed JSON:** hard error — throw with the file path + parse message.
   A *missing* file still falls back to defaults silently. ✅
3. **`defineConfig`:** removed from the public API (delete the export from
   `src/config/types.ts` and `src/index.ts` if present). ✅
4. **Schema-validation test:** add `ajv` as a devDependency and validate the
   repo's own config + the scaffolded template against the generated schema in
   a test, to catch schema/config drift. ✅
5. **`$schema` reference style:** raw-GitHub URL in the scaffolded template
   (works for external repos with no local install); relative
   `./schema/aiui.config.schema.json` in this repo's own config. ✅
