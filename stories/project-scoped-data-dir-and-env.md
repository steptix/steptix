# Project-scoped data dir + env (config-driven `tests.dataDir`)

> **Revised after a code-grounded review (2026-05-28).** The first draft
> under-specified the caching coherence and under-counted the `process.env`
> blast radius, and wrongly treated the VS Code client as data-dir-agnostic.
> Changes from that review are marked **[R]** inline.

## Context

Where the per-environment data file lives is configured today by an **env
var** with a hardcoded fallback:

```typescript
// src/env/data-loader.ts:20,33-34
const DEFAULT_DATA_DIR = 'fixtures/data';
const dataDir = process.env['AIUI_DATA_DIR'] ?? DEFAULT_DATA_DIR;
const filePath = path.resolve(projectRoot, dataDir, `${envName}.json`);
```

That's the only knob — the data dir is **not** a field on `aiui.config.json`
([TestsConfig has dir / contextDir / skillsDir / toolsDir / pattern, but no
dataDir](../src/config/types.ts#L101-L114)).

This is a problem for the **shared TestBench server**. The server is launched
once (`node dist/index.js serve`) and serves test files from *many* projects,
but it resolves config, `.env`, and data **all relative to its own launch
`process.cwd()`** — never the test file's project:

- Base `.env` (which carries `AIUI_DATA_DIR`) loads once at startup from cwd:
  [cli/index.ts:1-2](../src/cli/index.ts#L1-L2) → `loadDefaultEnvFileSync()`
  with no arg → `process.cwd()`.
- `aiui.config.json` loads once at startup from cwd and is **cached for the
  whole server lifetime** — `loadConfig` runs once in
  [serve.ts:31](../src/cli/commands/serve.ts#L31), the result is stored as
  `this.config` ([session-manager.ts:488](../src/server/session-manager.ts#L488))
  and never re-read. Editing `aiui.config.json` has no effect until the server
  restarts. **[R]**
- `.env.<envName>` + the data file load per request, but still from cwd:
  [session-manager.ts:943-945](../src/server/session-manager.ts#L943) calls
  `resolveEnvBundle({ envName })` with **no** `projectRoot`, so it falls back
  to `process.cwd()` ([resolve-bundle.ts:30](../src/env/resolve-bundle.ts#L30)),
  and caches the result on the session behind a `!session.envBundle` guard.

**[R] Correction to the first draft:** the project root is **not** "already
resolved per request." `resolveProjectRoot(request.testFilePath)` runs *only
inside the cache branch* — `if (cacheEnabledForRequest && request.testFilePath)`
([session-manager.ts:1124-1125](../src/server/session-manager.ts#L1124-L1125))
— and `cacheEnabledForRequest` requires the client to opt in with
`cacheEnabled: true`. With the cache off (the common case) the root is never
computed. So this work must **hoist** `resolveProjectRoot` to run on every
request, not merely "reuse" an existing call.

Net effect: one shared server is effectively bound to a single project's
env/data/config. Run a test from a different project and it silently reads the
wrong `.env`, wrong data dir, wrong `aiui.config.json`. Same family as
[011 (env bundle cached for session lifetime)](../issues/011-env-bundle-cached-for-session-lifetime.md)
and [016 (TestBench config baseUrl can't interpolate dataSources)](../issues/016-testbench-config-baseurl-no-datasource-interpolation.md).

The CLI is unaffected — you `cd` into a project before `aiui run`, so cwd *is*
the project root, and it already passes `projectRoot: process.cwd()` into
`resolveEnvBundle` ([run.ts:59,106](../src/cli/commands/run.ts#L59)).

## Goals

1. **`tests.dataDir` becomes a config field.** Declared in `aiui.config.json`
   under `tests`, resolved relative to the project root (like `dir` /
   `skillsDir`). Example:

   ```jsonc
   "tests": {
     "dir": "./tests",
     "dataDir": "./data",        // NEW
     "contextDir": "./context",
     "skillsDir": "./skills",
     "toolsDir": "./tools/src",
     "pattern": "**/*.md"
   }
   ```

2. **Default changes to `data`** (from `fixtures/data`). A project that keeps
   its env data in `data/<env>.json` needs no config at all. **Breaking** —
   this repo's own fixtures live in `fixtures/data`, so its `aiui.config.json`
   is migrated to pin `dataDir: "fixtures/data"` as part of this work.

3. **`AIUI_DATA_DIR` is removed completely** — server, CLI, **and both VS Code
   extensions** ([R], see Design §5). Read sites deleted, var stripped from
   `.env`/templates/docs, and a one-time startup warning if it's still present.

4. **The shared server resolves config + `.env` + `.env.<env>` + data dir from
   the test file's project root** — not its launch cwd. Switching between
   projects in TestBench requires no server restart and no per-project env var.

5. **Env loading stops mutating the global `process.env`.** Each project's env
   resolves into an isolated per-project map (Design §3). Load-bearing
   prerequisite for goal 4 and for shared-server concurrency safety (§2).

6. **The VS Code env dropdown reads `dataDir` from config. [R]** The client's
   `discoverEnvs` currently scrapes `AIUI_DATA_DIR` from `.env` to find data
   files ([env-selector.ts:137,178-190](../testbench-native/src/extension/env-selector.ts#L137)).
   It must instead read `tests.dataDir` from `aiui.config.json` (default
   `data`), or removing the var silently drops data-only envs from the dropdown.

7. **Schema (generated) + template + this repo migrated. [R]** The JSON schema
   is **generated from `src/config/types.ts`**, not hand-written
   (note the auto-named `DeepPartial<...>` definitions in
   [schema/aiui.config.schema.json](../schema/aiui.config.schema.json), and its
   `additionalProperties: false` on the `tests` block which will *reject*
   `dataDir` until regenerated). Run the generator, don't hand-edit.

## Non-goals

- **Flick.** The desktop app loads config once from its launch cwd, in-process
  ([runner-adapter.ts:276](../src/ui/main/runner-adapter.ts#L276)). Per-project
  resolution for Flick is **deferred** (see Known gaps). Flick still reads the
  new `tests.dataDir` from the single config it loads, so a single-project Flick
  launch works; multi-project Flick does not (and didn't before either).
- **The data-driven `dataFile` frontmatter** (CSV/JSON test rows) — a separate
  feature, also cwd-bound today ([test-runner.ts:862](../src/runner/test-runner.ts#L862)).
- **Named test-level `dataSources` resolving server-side** — still CLI-only.
- **Client-side `baseUrl` config interpolation** ([016](../issues/016-testbench-config-baseurl-no-datasource-interpolation.md)).
  Different code path: the extension resolves `baseUrl` from `## Config` against
  the client's own `.env` *before* session create
  ([run-controller.ts:927-929](../testbench-native/src/extension/run-controller.ts#L927-L929)).
  **[R] Note:** the per-project server work does *not* converge with 016 — that
  data is resolved entirely client-side and never reaches the server path we're
  changing. The first draft's "may make a future fix easier" was optimistic;
  treat 016 as fully independent.

## Design

### 1. The config field

- Add `dataDir: string` to `TestsConfig`
  ([types.ts:101-114](../src/config/types.ts#L101-L114)).
- Set `DEFAULT_CONFIG.tests.dataDir = 'data'`.
- Delete `DEFAULT_DATA_DIR` and the `AIUI_DATA_DIR` read from
  [data-loader.ts](../src/env/data-loader.ts#L20). `loadDataFile` takes the
  resolved `dataDir` as a parameter instead of reading the env var.
- Path semantics (match the other `tests.*` dirs): relative paths resolve
  against the **project root**; absolute paths used as-is; `~` expanded.
  > **Decided:** a leading slash means *absolute* (filesystem root) — `"/data"`
  > is NOT rewritten to project-relative. Use `"./data"` / `"data"` for the
  > relative form.
- **[R] Escaping paths.** A `dataDir` that resolves *outside* the project root
  (`"../shared"`, `"/etc"`) is a mild data-exposure footgun on a multi-project
  server. At minimum log a warning when the resolved data dir is not within the
  project root; consider rejecting it on the server path (the CLI may stay
  permissive). Reuse the absolute path resolved once — don't re-walk.
- **[R] Schema is generated.** After adding the type field, regenerate
  `schema/aiui.config.schema.json` (don't hand-edit — `additionalProperties:
  false` on the `tests` object rejects unknown keys). Confirm this repo's own
  `aiui.config.json` (which `$schema`-references the file) still validates with
  `dataDir` pinned.

### 2. Per-project resolution on the server

Hoist `resolveProjectRoot(request.testFilePath)` to the top of the steps
handler (it is **not** currently always-on — see Context **[R]**), and drive a
per-project **resolution bundle** from it:

```
projectRoot = resolveProjectRoot(request.testFilePath)   // hoisted out of the cache branch
  → config   = loadConfig({ projectRoot })               // for tests.dataDir et al.
  → env      = base .env + .env.<envName>, read from projectRoot (pure load, §3)
  → data     = <projectRoot>/<config.tests.dataDir>/<envName>.json
```

**Identity — keyed by project root.** Bundles are distinguished by the absolute
project-root path (the dir containing `aiui.config.json`) that
`resolveProjectRoot` returns
([project-root.ts:21-40](../src/server/project-root.ts#L21-L40)). The server
holds a `Map<projectRoot, bundle>`; files under the same root share a bundle,
files under different roots get independent bundles. Same key already used to
anchor `<project-root>/.cache`. Keys are never namespaced *within* a bundle —
separation is purely which-bundle.

**[R] Retire the per-session `envBundle` cache.** The existing
`!session.envBundle` lazy guard ([session-manager.ts:943](../src/server/session-manager.ts#L943))
freezes env/data for the session lifetime — that *is* the 011 bug. This story
must **remove** `session.envBundle` and route *all* `${env.X}` / `${data.X}`
interpolation through the new per-project mtime-cached bundle. If both caches
coexist, 011 is not actually closed. The whole-server-lifetime config cache
(`this.config`, Context **[R]**) is likewise superseded on the per-request path
by the per-project `loadConfig`.

**[R] Concurrency.** The shared server interleaves async requests for different
projects. The bundle cache must be safe under that:
- Bundles are **immutable** once built; nothing on the resolution path mutates
  shared state (this is *why* §3's pure-load matters — a stray `process.env`
  write would cross-contaminate concurrent loads for different projects).
- Cache writes are idempotent (last-writer-wins is fine for identical inputs).
- Dedupe concurrent misses for the same root with an in-flight
  `Map<root, Promise<bundle>>` so two batches don't both read+parse.

**Null fallback.** No `aiui.config.json` above the test file →
`resolveProjectRoot` returns `null` → fall back to **defaults** (data dir
`data`, no project `.env`/`.env.<env>`) with a one-time warning. Never guess a
root or read the server's own cwd files.

**[R] Malformed per-project config.** `loadConfig` throws hard on bad JSON
([config/loader.ts:160-167](../src/config/loader.ts#L160-L167)). On a shared
server one project's broken config must fail **only that project's run** with a
clear error — never crash the server or poison the cache. (Mirror the client's
tolerant parse, which returns null + warns.)

**mtime-based invalidation.** The OS bumps a file's modification time on every
save. Store the mtime seen when a file was cached; before reuse, `fs.stat`
(cheap *metadata* read, not a content read) and compare — newer mtime → re-read
+ update; equal → reuse and skip the parse. **Lazy and on-access: once per step
batch, when the server is about to resolve env/data — no background timer, no
polling.** Idle = nothing checked; active cost = one `stat` per input file
(`.env`, `.env.<env>`, data JSON, `aiui.config.json`) per batch. This closes
[011](../issues/011-env-bundle-cached-for-session-lifetime.md) instead of
building the cache twice.

> Worked example (paused-and-edit): run reads `.env.uat` at mtime `T0` → step
> fails, you pause → you edit + save (`T1 > T0`) → click Continue → the next
> batch stats the file, sees `T1 > T0`, re-reads, new value applies. No restart.
>
> Caveat: mtime resolution is coarse (~1-2s) on some filesystems; two writes in
> the same second could share a timestamp. A non-issue for a human editing
> during a pause; a content hash would be the bulletproof alternative.

### 3. The process.env hazard (the hard part)

`loadEnvFile` and `loadDefaultEnvFileSync` **write into the global
`process.env`** ([loader.ts:32-34,58-61](../src/env/loader.ts#L32-L34)). On a
shared server that's a correctness bug the moment two projects are in play:
loading project B's `.env.uat` after project A's leaves A's keys lingering in
the global, so B's run sees A's secrets. `resolveEnvBundle` snapshots
`process.env` *after* that mutation ([resolve-bundle.ts:45-48](../src/env/resolve-bundle.ts#L45-L48)),
so the snapshot captures the pollution.

Required change — **pure load**: `loadEnvFile` / `loadDefaultEnvFileSync` return
parsed maps; `resolveEnvBundle` composes `{ ...processEnvBaseline, ...baseDotenv,
...dotenvForName }` into a per-project map. Nothing writes `process.env`. This
is the right long-term shape and the root-cause fix behind 011 — and the biggest
single piece of work here, because **every consumer that reads a project-scoped
value straight off `process.env` must instead read the per-project map** (see
the audit table — `auth-resolver`, `spec-loader`, `parameters`, `resolveSecrets`
are all in this set **[R]**).

**The `withEnvDefaults` split.** `loadConfig` runs `withEnvDefaults`
([config/loader.ts:70-101](../src/config/loader.ts#L70-L101)), folding env vars
into config. Under per-project loading it re-runs per project against the global
— same contamination. Split by ownership:
- **Server-global, read once at startup:** `AIUI_SERVER_API_KEY` (the server's own
  auth — exactly one, must not be per-project).
- **Project-scoped, from the project's env map:** `AI_API_KEY`, `AI_MODEL`,
  `INTERACTIVE_ON_FAILURE`, `OPEN_REPORT_IN_BROWSER_AFTER_RUN`,
  `APPEND_RUN_HISTORY_TO_TEST_FILE`.

So `withEnvDefaults(config, envMap)` takes the resolved env map; the server
passes the project map, the CLI passes `process.env` (legitimate there — §6).

### 4. `request.env` precedence vs. server-resolved env **[R]**

The client *already* sends a resolved base-`.env` map (`env`,
[run-controller.ts:1201](../testbench-native/src/extension/run-controller.ts#L1201)),
but the server uses `request.env` **only** to build AI config
(`applyEnvToAiConfig`) — never for `${env.X}` interpolation, which reads
`session.envBundle.env`. Once the server resolves the project env itself, two
env sources coexist and precedence must be defined. Decision: **the
server-resolved project `.env` + `.env.<env>` is authoritative** for `${env.X}`
interpolation and for `withEnvDefaults`; `request.env` continues to feed only
the AI-config overlay (or is dropped if redundant). Document this so the two
never silently disagree.

### 5. Client-side `dataDir` for env discovery **[R]**

Both extensions discover selectable envs by scanning `<dataDir>/*.json`, reading
the dir from `AIUI_DATA_DIR` in `.env` with a `fixtures/data` default
([env-selector.ts:128,137,178-190](../testbench-native/src/extension/env-selector.ts#L128);
mirrored in `testbench-monaco/src/extension/env-selector.ts`). After this story
that scrape is dead and the default is wrong. Fix:
- Teach the client config parser (`aiui-config-parse.js` / `aiui-config.ts`) to
  expose `tests.dataDir`.
- `discoverEnvs` reads it (default `data`); delete `readDataDirFromEnv` and the
  `AIUI_DATA_DIR` regex.
- Note the client already has its own mtime cache for config dirs
  (`aiui-config-parse.js`) — independent of the server bundle cache; a config
  edit needs its own client-side invalidation. Acceptable, just don't be
  surprised by two caches.

### 6. CLI parity **[R]**

- `loadConfig` / `resolveConfigPath` gain a `projectRoot` param. `--config`
  stays **cwd-relative** (today's semantics, [config/loader.ts:51-60](../src/config/loader.ts#L51-L60));
  only auto-discovery moves to projectRoot. Don't let the signature change
  re-base an explicit `--config`.
- CLI passes `projectRoot: process.cwd()` to both `loadConfig` and
  `resolveEnvBundle` so they agree (today config is loaded without a root,
  [run.ts:67](../src/cli/commands/run.ts#L67)).
- CLI `withEnvDefaults` keeps reading the global (correct there — the CLI
  populated it via `loadDefaultEnvFileSync`, [cli/index.ts:2](../src/cli/index.ts#L2)).
  The split must not regress this.

### 7. Secret masking **[R]**

`${env.X}` secret values are redacted in reports/logs (`maskSecret`,
[parameters.ts:149-154](../src/parser/parameters.ts#L149-L154); see
[issue 013](../issues/013-secret-masking-duplicated-and-divergent.md)). If env
values move out of the global into a per-project map, the masking layer must be
fed that map, or `${env.SECRET}` values could appear unmasked. Add a test: a
`${env.PASSWORD}` value is masked in the HTML report on the shared-server path.

### 8. Removing `AIUI_DATA_DIR`

- Delete the read site (data-loader.ts) **and** the client reads (§5).
- On server/CLI startup, if `process.env.AIUI_DATA_DIR` is set, log once:
  *"AIUI_DATA_DIR is no longer supported — set `tests.dataDir` in
  aiui.config.json (default: `data`)."*
- Strip it from external `.env` files, `templates/init`, docs/stories.

## Migration

- **This repo** (`ai-ui-automation`): add `tests.dataDir: "fixtures/data"` to
  its `aiui.config.json` so existing `${data.X}` fixture tests keep resolving.
- **AITests**: needs *nothing* added — files are already in `data/` (the new
  default). Just remove `AIUI_DATA_DIR` from its `.env`. (The concrete payoff:
  the user's `${data.url}` works with zero env-var config once the server
  resolves per-project.)
- **Code/doc references to update [R]** (verified present):
  - `runner-core/src/api-client.ts:37` — doc comment cites
    `fixtures/<envName>.json` / `AIUI_DATA_DIR`.
  - `src/server/session-manager.ts:37,53-54` — `StepRequest.envName` doc cites
    `fixtures/data/<envName>.json` and `AIUI_DATA_DIR`.
  - `README.md`, `SPEC.md` — both reference `AIUI_DATA_DIR` / `fixtures/data`.
  - `stories/data-sources-namespaces.md`, `stories/skill-data-sources.md`.
  - `templates/init/aiui.config.json` gains `dataDir: "data"`.
- **Existing tests to rewrite [R]:**
  - `tests/resolve-env-bundle.test.ts:43` asserts `process.env['BASE_URL']`
    **is mutated** after load — pure-load inverts this; rewrite to assert the
    returned map, not the global.
  - `tests/env-data-loader.test.ts` — uses `fixtures/data` paths and asserts
    `$VAR` resolves "against process.env"; update for the new default + map.

## Tests

- `loadDataFile` resolves `<projectRoot>/<dataDir>/<env>.json` from config;
  default `data` when unset.
- `AIUI_DATA_DIR` is ignored; warning fires when present.
- **Shared-server isolation [R]:** two sessions with test files in different
  projects (different `dataDir`, different `.env.<env>`, different
  `AI_API_KEY`) each resolve their own env/data/config; no value leaks across.
- **Concurrency [R]:** overlapping batches for two projects resolve correctly;
  no `process.env`-derived cross-contamination.
- **Interactive path [R]:** an interactive `send-step` after a run resolves the
  same project root/env as the run it continues (see §9 fix).
- **Malformed config [R]:** a bad `aiui.config.json` in project A fails A's run
  with a clear error and does **not** affect a concurrent project-B run.
- **Masking [R]:** a `${env.PASSWORD}` value is redacted in the report on the
  server path.
- **Client discovery [R]:** the env dropdown lists envs from `tests.dataDir`
  (incl. data-only envs with no `.env.<name>`).
- Per-project config read from the test's own root, not server cwd.
- Regression: CLI `aiui run --env <name>` resolves data via its cwd project.
- Migration: this repo's fixture suite passes with `dataDir: "fixtures/data"`.

## Known gaps (deferred)

- **Flick** — no per-project resolution
  ([runner-adapter.ts:276](../src/ui/main/runner-adapter.ts#L276)); follow-up.
- **`dataFile` frontmatter** (data-driven rows) remains cwd-bound.
- **Named test-level `dataSources`** still resolve only on the CLI parse path.
- **[R] Interactive REPL `testFilePath`** — see §9; fixed here but called out
  because it's an easy regression surface.

## §9 — Interactive REPL must carry `testFilePath` **[R]**

The interactive `send-step` request sends `env`/`envName` but **not**
`testFilePath` ([run-controller.ts:1312-1323](../testbench-native/src/extension/run-controller.ts#L1312-L1323));
the main run path does ([run-controller.ts:1213](../testbench-native/src/extension/run-controller.ts#L1213)).
Under projectRoot-driven resolution an interactive step would resolve no root →
defaults → possibly a *different* data dir than the run it continues. Fix:
either send `testFilePath` on the interactive path too, **or** have the server
reuse the session's first-resolved project root for all later batches in that
session. (The latter also avoids re-walking per batch — store the resolved root
on the session, keyed by testFilePath.)

## Implementation notes (as built)

The first pass took a **server-pure / CLI-compatible** shape rather than
pure-load-everywhere, to fix the user's scenario + the contamination without a
15-file refactor:

- **`resolveEnvBundle` gained `mutateProcessEnv`** ([resolve-bundle.ts](../src/env/resolve-bundle.ts)).
  The **server** composes a per-project env map and never touches the global
  `process.env` (so concurrent projects can't contaminate each other's
  interpolation/data path). The **CLI** passes `mutateProcessEnv: true` —
  single-project, so it still populates `process.env` and nothing regresses for
  consumers that read it directly.
- **Data-secret resolution is threaded** — `loadDataFile`/`loadDataFromPath`/
  `resolveSecrets` take an `envMap` ([data-loader.ts](../src/env/data-loader.ts)),
  so `$VAR` leaves in data files resolve against the per-project map on the
  server.
- **`withEnvDefaults` was NOT split.** In this model the server never pollutes
  the global, so `withEnvDefaults` reading `process.env` sees a stable server
  baseline (no contamination); per-project AI keys still flow via `request.env`
  → `applyEnvToAiConfig`. The split is therefore unnecessary here and was
  skipped.
- **Per-project resolution covers config (`tests.dataDir`/`cache.dir`) + env +
  data.** `ai`/`browser`/`execution` config stay server-global (the browser is
  launched once per session; relaunching per project is out of scope).

**Deferred (documented gap):** the deep API consumers — `api/auth-resolver.ts`,
`api/spec-loader.ts`, `parser/parameters.ts` `$VAR` — still read `process.env`.
On the CLI that's correct (the global is populated). On the **shared server**
they see only the server baseline, not a project's `.env.<name>`, so API-testing
features aren't project-scoped there yet. This is not a contamination bug (the
global is never project-polluted on the server) and these features are
CLI-centric today; threading the map to them is the follow-up to make API
testing project-scoped on a shared server.

## Decisions

1. **Leading-slash `dataDir` is absolute.** Project-root-relative is
   `"./data"` / `"data"`.
2. **mtime-based bundle invalidation; close [011](../issues/011-env-bundle-cached-for-session-lifetime.md).**
   Lazy, once per batch, no polling.
3. **[R] Retire the per-session `envBundle` cache and the whole-server-lifetime
   config cache on the per-request path.** Single source of truth = the
   per-project mtime-cached bundle. (Required, or 011 stays open.)
4. **[R] Client `dataDir` discovery is in scope.** Removing `AIUI_DATA_DIR`
   without it breaks the env dropdown.
5. **[R] Server-resolved project env is authoritative** for interpolation;
   `request.env` feeds only AI config.
6. **[R] One project's malformed config fails only that project**, never the
   server.

## `process.env` audit

Every project-scoped `process.env` read, classified for the pure-load refactor.
**[R]** additions are the rows the first draft missed.

| Site | Read | Classification |
|---|---|---|
| [data-loader.ts:106](../src/env/data-loader.ts#L106) | `$VAR` secret leaves in data files (`resolveSecrets`) | **Move to project env map** — top contamination risk |
| **[R]** [api/auth-resolver.ts:124,147](../src/api/auth-resolver.ts#L124) | `$API_KEY`/`$TOKEN`/`$SECRET` for the **API-under-test** auth headers | **Move** — also breaks (loses bearer token) under pure-load if not migrated |
| **[R]** [api/spec-loader.ts:202](../src/api/spec-loader.ts#L202) | `$ENV_VAR` in OpenAPI spec URLs | **Move** |
| **[R]** [parser/parameters.ts:55](../src/parser/parameters.ts#L55) | `## Parameters` `$VAR` resolution | **Move** (CLI/data-driven path); server resolves params client-side, but the runner can still hit this |
| [resolve-bundle.ts:46](../src/env/resolve-bundle.ts#L46) | snapshot of the (mutated) global into bundle `env` | **Move** — compose from baseline + `.env` + `.env.<env>` |
| [loader.ts:32-34,58-61](../src/env/loader.ts#L32-L34) | `loadEnvFile`/`loadDefaultEnvFileSync` **write** the global | **Move** — root of the hazard; return maps |
| [config/loader.ts:70-101](../src/config/loader.ts#L70-L101) | `withEnvDefaults` config-from-env | **Split** — `AIUI_SERVER_API_KEY` global; rest project-scoped |
| [data-loader.ts:33](../src/env/data-loader.ts#L33) | `AIUI_DATA_DIR` | **Removed** by this story |
| **[R]** [context/loader.ts:70](../src/context/loader.ts#L70) | `ADDITIONAL_CONTEXT_DIR` | Project-scoped in principle; low priority — confirm during build |
| [serve.ts:27](../src/cli/commands/serve.ts#L27) | `AIUI_SERVER_API_KEY` check | Stay global (server startup) |
| [test-runner.ts:941](../src/runner/test-runner.ts#L941) | `CI` | Stay global |
| [browser/manager.ts:64-66](../src/browser/manager.ts#L64-L66) | `ProgramFiles` / `LOCALAPPDATA` | Stay global (OS paths) |
| [run.ts:53](../src/cli/commands/run.ts#L53) | `AUTOMATION_ENV` | Stay global (CLI-only) |
| ui/main/index.*.ts | `VITE_DEV_SERVER_URL` | Stay global (Flick dev; deferred) |
