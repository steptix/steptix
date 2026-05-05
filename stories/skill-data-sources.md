# Skill-level dataSources — environment-aware skills

## Summary

Today, skills can only read values that the **caller** passes in via
`## Parameters`. The caller is responsible for sourcing those values from a
`dataSources` namespace, env vars, or whatever else.

This story extends `dataSources` to skill files. A skill declares its own
named JSON namespaces in frontmatter and references them in its steps via
`${<name>.X.Y}` — the same surface the test-level feature already provides.
The skill becomes self-contained for catalog-style data (a merchant
directory, a per-env URL map, a country-code table) without forcing every
caller to re-declare the same source.

The hero use case: **a skill that opens an environment-specific URL**. The
skill's `dataSources` path itself uses `${envName}` so the file picked up
varies by `--env`.

```yaml
---
type: skill
dataSources:
  endpoints: ../data/${envName}-endpoints.json
---
```

`aiui run … --env staging` loads `../data/staging-endpoints.json`;
`--env uat` loads `../data/uat-endpoints.json`. The skill itself never
changes.

## User-facing surface

### Skill frontmatter

Identical shape to the test-level feature:

```yaml
---
type: skill
dataSources:
  endpoints: ../data/${envName}-endpoints.json
  catalog:   ~/aiui/shared-fixtures.json
  static:    ./skill-fixtures.json
---
```

- Reserved names (rejected at parse time): `env`, `data`.
- Names match `^[A-Za-z_][A-Za-z0-9_]*$` — same as test-level.
- Path resolution rules:
  - `~/...` → home-expanded.
  - Absolute → used as-is.
  - Relative → resolved relative to **the skill `.md` file's directory**,
    not the calling test or `process.cwd()`.

### Path interpolation

`dataSources` path strings support a narrow interpolation surface:

- `${env.NAME}` — read from `process.env`.
- `${envName}` — the active env name (e.g. `local`, `staging`, `uat`).

Everything else (`${data.X}`, `${<source>.X}`) is rejected at skill-parse
time with a clear error. Reason: `data` and other namespaces aren't loaded
yet at the time we resolve a path string — interpolating them would be a
chicken-and-egg loop.

If the skill is parsed before any env name has been selected (e.g. a CLI
run with no `--env`), `${envName}` errors with a precise message. The skill
is still parseable; the error only fires if a `dataSources` path actually
references it.

### Step interpolation

Steps, parameters, and outputs go through the same `${<ns>.X.Y}` regex as
test-level interpolation, but **scoped to the skill's namespaces**:

- `${env.X}` and `${envName}` — both resolve.
- `${<skill-declared-source>.X.Y}` — resolves against that source's JSON.
- `${data.X}` — passes through unchanged (skills shouldn't reach into the
  caller's env-default data file). Tests will resolve it later if it's
  declared there.
- `${<unknown>.X}` — passes through unchanged (matches today's behaviour).

### `${envName}` — also works in tests

`${envName}` is implemented as a no-dot token recognised by the shared
interpolation pass, not as a skill-only feature. So **any** test or skill
string — step text, hook entry, parameter value, config value, or
`dataSources` path — can reference `${envName}` and get the active env
name (the `--env <name>` flag, or the test's frontmatter `env:` override).

Examples:

```markdown
## Steps
1. Navigate to ${env.BASE_URL}/${envName}/dashboard
2. Verify the env badge reads "${envName}"
```

```yaml
---
dataSources:
  endpoints: ../data/${envName}-endpoints.json
---
```

If `${envName}` appears anywhere in a string but no env was selected, the
interpolation hard-errors with a precise file pointer — no silent literal.

### Skill-vs-caller namespace isolation

When a skill declares `dataSources: catalog: …` and is called from a test
that **also** declares `dataSources: catalog: …` pointing somewhere else,
the skill's own `${catalog.X}` resolves against the **skill's** file. The
test's `catalog` is invisible to the skill body.

This is enforced by ordering: skill-level interpolation runs inside
`parseSkillFile` (before the skill body is inlined into the test). By the
time `expandSkills` splices the skill into the caller's step list, every
skill-private `${<source>.X}` reference is already a literal string. The
test-level interpolation pass has nothing to do for those.

Caller overrides flow through `## Parameters` — the explicit channel.

## Backwards compatibility

- A skill without `dataSources` parses byte-for-byte identically to today.
- The skill-cache key gets a new component (`envName`) so the same skill
  parsed under different `--env` runs doesn't return stale interpolated
  output. Skills with no `dataSources` are unaffected — the cached value
  is the same whatever envName is.
- Existing skills that contain no `${...}` placeholders run an extra
  no-op interpolation pass per parse. Cost is one regex sweep per step
  string; negligible.

## Errors

Hard errors at skill parse time (name the skill file in the message):

- `dataSources` key uses a reserved name (`env`, `data`).
- `dataSources` key fails the identifier regex.
- `dataSources` value isn't a non-empty string.
- A path string references `${data.X}` or any namespace other than
  `env` / `envName`.
- A path string references `${envName}` but no env name was selected for
  this run.
- A path string references `${env.NAME}` and `NAME` isn't in `process.env`.
- The resolved path doesn't exist or isn't readable.
- The resolved file isn't a JSON object at the top level.
- A `${<source>.X.Y}` reference in a skill step resolves to `undefined`.

When a skill-step reference fails, the error message names the **skill**
file. The expander wraps the error with the **calling test** file too so
the author can locate both endpoints.

## Implementation outline

### Files changed

- **`src/parser/types.ts`** — add `dataSources?: Record<string, string>`
  to `ParsedSkill`. Make `EnvDataContext.data` optional and add
  `envName?: string`.
- **`src/parser/interpolate-env-data.ts`** —
  - `buildPattern` includes `data` only when `ctx.data` is set.
  - Add a `${envName}` (no-dot) replacement pass.
  - New `interpolateDataSourcePath(text, { env, envName, filePath })`
    helper restricted to `env` and `envName` only.
- **`src/parser/markdown.ts`** —
  - `parseSkillContent` captures `frontmatter.dataSources` onto
    `ParsedSkill`.
  - `parseSkillFile` accepts an optional `envCtx`. When supplied:
    1. interpolate each `dataSources` path via the new helper,
    2. expand `~`/resolve relative against the skill dir,
    3. load each via `loadDataFromPath`,
    4. run `interpolateEnvData` over `steps`/`parameters`/`outputs` with
       a context that includes `env`, `envName`, and the loaded skill
       sources (no `data`).
- **`src/skills/expander.ts`** — `expandSkills` takes an optional
  `envCtx` and threads it into `parseSkillFile`. Cache key becomes
  `filePath::envName`. (No skill code is run from the cache, so a key
  collision across envs would silently leak stale interpolated output —
  hence the keyed cache.)
- **`src/parser/markdown.ts`** (`parseTestFile`) — passes the existing
  `options.envData` (extended with `envName`) into `expandSkills`.
- **`src/cli/commands/run.ts`** — populates `envData.envName` from
  `runBundle.envName` (already surfaced by `resolveEnvBundle`).

### Why this ordering

Skill-level interpolation has to run **before** the skill body is inlined
into the caller's step list, otherwise the test-level pass would see
skill-private `${<source>.X}` references and either error or — if the
test happens to declare a colliding namespace — silently resolve them
against the wrong file.

Putting the pass in `parseSkillFile` is the natural seam: skill-private
data resolves locally, the skill emits steps that contain only
`{{paramName}}` placeholders plus already-resolved literals.

### `${envName}` plumbing

`resolveEnvBundle` already surfaces the active env name on its returned
bundle. Threading it into `EnvDataContext.envName` and propagating
through `parseTestFile → expandSkills → parseSkillFile` is mechanical.

When no env is selected for the run, `envName` is `undefined`; the
interpolation helpers fail loudly only if a path string actually
references `${envName}`.

## Worked example

```
fixtures/data/local-endpoints.json     → { "api": { "url": "http://localhost:8787" } }
fixtures/data/staging-endpoints.json   → { "api": { "url": "https://stg.securebank.example" } }
fixtures/data/uat-endpoints.json       → { "api": { "url": "https://uat.securebank.example" } }
```

```yaml
---
type: skill
dataSources:
  endpoints: ../data/${envName}-endpoints.json
---

# open_dashboard_for_env

Opens the dashboard URL for whichever environment the run was started in.
The path itself contains `${envName}`, so swapping `--env` swaps the JSON
file the skill reads from. No caller change required.

## Steps
1. Navigate to ${endpoints.api.url}/
2. Verify the SecureBank "Sign In" form is visible
```

```markdown
---
tags: [smoke, skills, data]
---

# Skill-level dataSources demo

## Steps
1. [skill: open_dashboard_for_env]
```

Run `aiui run fixtures/tests/skill-data-sources-demo.md --env local` →
the skill picks `local-endpoints.json` and navigates to
`http://localhost:8787/`. Run with `--env uat` → it'd pick UAT.

## Open issues (deferred)

1. **Per-run skill-parse cache hit rate** — adding `envName` to the cache
   key keeps correctness but loses sharing across envs. Acceptable for
   now; revisit if profiling shows it matters.
2. **Object-form `dataSources` value** — `{ path: …, optional: true }`
   to allow per-env files that may be absent. Out of scope for v1.
3. **Glob-expanded `dataSources`** — `vip-*.json` merged into one tree.
   Probably a bad idea; rejected unless real demand surfaces.
4. **`env: <name>` frontmatter for skills** — letting a skill pin its own
   env independent of the caller. Confusing; deliberately not added.
