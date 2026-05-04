# Data sources — per-test named namespaces

## Summary

Today every test reads structured data from exactly one file:
`<AIUI_DATA_DIR>/<envName>.json` (default `fixtures/data/<envName>.json`).
Steps reference it via `${data.X.Y}`. The active env is selected by
`--env <name>`, the matching `.env.<name>` file populates `process.env`, and
`$VAR` leaves inside the JSON resolve against `process.env`.

This is fine for the common case but breaks down when:

- A test wants data from a file outside the configured `AIUI_DATA_DIR`
  (e.g. a shared catalogue at `~/shared/vip-users.json`).
- A test wants different steps to read from different files (e.g. step 2 uses
  the standard staging users; step 3 uses a VIP catalogue; step 4 uses a
  one-off override that lives next to the test).
- Two test authors want to share a fixture catalogue without copying it into
  every project's `fixtures/data/` directory.

This story adds **named data-source namespaces** declared per-test in
frontmatter. Each entry registers a top-level placeholder namespace that
behaves exactly like the existing `${data.X.Y}` namespace — independent file,
independent JSON tree, same `$VAR → process.env` secret resolution, accessed
via `${<sourceName>.X.Y}`.

The feature is **purely additive**. Tests without `dataSources` behave
identically to today.

## User-facing surface

### Frontmatter

```yaml
---
env: staging
dataSources:
  vip:   ~/shared/vip-users.json
  local: ./vip-checkout.data.json
---
```

`dataSources` is a YAML map of `<name>: <path>`. Each entry registers a
top-level placeholder namespace.

**Reserved names** (rejected at parse time): `env`, `data`. These are the
existing namespaces.

**Name format**: must match `^[A-Za-z_][A-Za-z0-9_]*$` — same as a
JavaScript identifier. This keeps the placeholder syntax unambiguous and the
namespace name safe to splice into the interpolation regex.

**Path resolution**:

- `~/...` → expanded against the user's home directory.
- Absolute path (`/foo/bar.json`, `C:\...`) → used as-is.
- Relative path (`./special.json`, `../shared/foo.json`, `tests/data.json`)
  → resolved relative to **the test `.md` file's directory**, not
  `process.cwd()`. This keeps tests portable when the suite is moved or
  when the CLI is run from a different directory.

### Step interpolation

```markdown
## Steps
1. Login as "${data.users.admin.email}"          # env default — fixtures/data/staging.json
2. Switch to VIP "${vip.users.platinum.email}"   # ~/shared/vip-users.json
3. Place order ${local.fixtures.orderTotal}      # ./vip-checkout.data.json
```

Each `${<name>.<path>}` placeholder reads from exactly one file. No
merging — each step picks its source.

### `$VAR` resolution inside JSON

Every JSON-backed namespace runs the same `$VAR → process.env` walk that the
env default has always done. A leaf string of the form `$NAME` (matching
`^\$[A-Z_][A-Z0-9_]*$`) is replaced with `process.env.NAME`. This happens
**after** `.env` and `.env.<envName>` are loaded, so secrets stay in
`.env.<envName>` (gitignored) and any JSON file — local or shared across
machines — references them with `$VAR_NAME`.

Example:

```json
// ~/shared/vip-users.json
{ "users": { "platinum": { "password": "$VIP_PWD" } } }
```

```
# .env.staging
VIP_PWD=p1atinum-secret
```

```markdown
3. Login with password "${vip.users.platinum.password}"
```

Renders as `Login with password "p1atinum-secret"`.

If `VIP_PWD` isn't defined, the literal `$VIP_PWD` is kept (with a warning),
matching today's behaviour for the env-default data file.

## Backwards compatibility

This is the load-bearing requirement.

- A test with **no** `dataSources` field behaves byte-for-byte identically to
  today. Same parse output, same interpolation result.
- The interpolation regex in `interpolateEnvData` is **dynamic**: built from
  `['env', 'data', ...declaredSourceNames]`. When no extra sources are
  declared, the regex is exactly today's regex.
- Unknown namespaces (e.g. `${foo.bar}` when no `foo` source is declared)
  pass through unchanged — same as today. They are NOT treated as errors.
  This preserves any existing test that happens to contain a literal
  `${X.Y}` string for unrelated reasons.
- The existing `dataFile:` frontmatter field (data-driven test rows;
  CSV/JSON-array per-row data) is untouched. `dataSources` is a new field.

## Errors

Hard errors (fail at parse time, name the test file):

- `dataSources` key uses a reserved name (`env`, `data`).
- `dataSources` key fails the identifier regex.
- `dataSources` value isn't a string.
- A declared source file doesn't exist or isn't readable. (Unlike the
  env-default file which silently returns `{}`, a `dataSources` entry was
  explicitly requested by the author so silence would be misleading.)
- A declared source file's top-level value isn't a JSON object.
- A `${<name>.path.to.value}` reference resolves to `undefined` because the
  path doesn't exist in the source file's tree. (Same behaviour as
  `${data.X}` today.)

Pass-through (no error):

- `${<name>.X}` where `<name>` is not in `dataSources` and isn't `env` or
  `data`. Left as a literal in the step text. (Same as today.)

## Implementation outline

### Files changed

- `src/parser/types.ts` — extend `TestFrontmatter` with
  `dataSources?: Record<string, string>`.
- `src/parser/frontmatter.ts` — parse and validate `dataSources` (reserved
  names, identifier regex, string values).
- `src/env/data-loader.ts` — extract a `loadDataFromPath(absPath)` helper
  that does the file read + JSON parse + object-shape check + `$VAR`
  resolution (the existing `loadDataFile` keeps its env-name-based signature
  and delegates to the new helper after resolving the path).
- `src/parser/interpolate-env-data.ts` — extend `EnvDataContext` with
  `extraData?: Record<string, DataObject>`. Build the matching regex
  dynamically; route lookups by namespace name.
- `src/parser/markdown.ts` — when frontmatter declares `dataSources`, resolve
  each path against the test's directory, load each file via
  `loadDataFromPath`, pass the resulting map through as
  `envData.extraData`.

### Why per-test loading

The `dataSources` declaration lives in test frontmatter, so loading is
naturally scoped to `parseTestFile`. The run-wide `resolveEnvBundle` stays
unchanged — it still produces the env default. Per-test sources are loaded
on top of that, only when declared.

### Path expansion helper

`~` expansion isn't a Node primitive. Add a small helper:

```typescript
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}
```

Then `path.isAbsolute(expanded) ? expanded : path.resolve(testFileDir, expanded)`.

## Worked example

```
aitests/
├── .env                              # AI_API_KEY=...
├── .env.staging                      # BASE_URL, ADMIN_PWD, VIP_PWD
├── fixtures/data/
│   └── staging.json                  # standard staging users + fixtures
├── shared/
│   └── vip-users.json                # team-wide VIP catalogue
└── tests/
    ├── vip-checkout.md
    └── vip-checkout.data.json        # one-off overrides for this test
```

`fixtures/data/staging.json`:

```json
{
  "users": {
    "admin": { "email": "admin@stg.example.com", "password": "$ADMIN_PWD" }
  },
  "fixtures": { "currency": "USD" }
}
```

`shared/vip-users.json`:

```json
{
  "users": {
    "platinum": { "email": "vip-1@example.com", "password": "$VIP_PWD" }
  }
}
```

`tests/vip-checkout.data.json`:

```json
{ "fixtures": { "minOrderTotal": 50000, "expectedTier": "Platinum" } }
```

`tests/vip-checkout.md`:

```markdown
---
tags: [smoke, vip]
env: staging
dataSources:
  vip:   ~/projects/aitests/shared/vip-users.json
  local: ./vip-checkout.data.json
---

# VIP customer checkout

## Config
- baseUrl: ${env.BASE_URL}

## Steps
1. Navigate to ${env.BASE_URL}/login
2. Login as "${data.users.admin.email}" / "${data.users.admin.password}"
3. Switch to VIP "${vip.users.platinum.email}" / "${vip.users.platinum.password}"
4. Place order ${local.fixtures.minOrderTotal} ${data.fixtures.currency}
5. Assert tier "${local.fixtures.expectedTier}"
```

After parse with `--env staging`, all steps render with concrete values
pulled from the right file each time. `${data.*}` keeps reading
`fixtures/data/staging.json` exactly as today.
