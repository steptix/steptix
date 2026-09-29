# Multi-environment + JSON test data

## Context

A test author writes one `.md` test file but routinely needs to run it against
several environments — `local`, `uat`, `staging`, `prod`. Today, the only
mechanism for environment-specific values is `.env.<name>` (loaded via CLI
`--env`, see [src/cli/commands/run.ts:36](../src/cli/commands/run.ts#L36)).
That works for flat key/value secrets, but it's awkward for **structured test
data** — admin/viewer user objects, fixture IDs, threshold values — and it
forces every entry point to re-implement env selection ad hoc.

Concretely:

- The CLI has `--env <name>` already.
- The VS Code steptix has no env-switching UI; it walks-up to the nearest
  `.env` (see [run-controller.ts:155](../steptix/src/extension/run-controller.ts#L155))
  and that's it.
- Programmatic callers and CI need a third path.
- Test data like `users.admin.email` doesn't fit naturally in flat `.env` files;
  authors today either flatten it (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, …) or
  hard-code it.

## Goals

1. One `--env <name>` selector picks **both** environment config (URLs, secrets)
   and structured test data (users, fixtures, business values).
2. Test data lives in **JSON** (`data/<env>.json`) — nestable, machine-checkable,
   diff-friendly.
3. Test authors interpolate values into markdown via `${env.X}` and
   `${data.path.to.value}`. Resolution happens at parse-time so the AI sees the
   final string, not the placeholder.
4. Every entry point (CLI, VS Code, programmatic, CI) selects the env via the
   same resolver and exposes a UI/flag/setting appropriate to the surface.
5. Missing keys fail fast with a clear error pointing at the file and line —
   no `undefined` reaches the AI.

## Design

### File layout

```
steptix/
├── .env                       ← shared defaults (already exists)
├── .env.uat                   ← env-specific secrets / URLs (already exists)
├── .env.staging
├── .env.prod
├── data/
│   ├── uat.json               ← env-specific structured data (NEW)
│   ├── staging.json
│   └── prod.json
└── tests/...
```

Two slots, distinct jobs:

- `.env.<env>` — infra + secrets. Gitignored by convention.
- `data/<env>.json` — business test data. Checked in.

The asymmetry (data shared, secrets private) is the exact split most teams want.

### JSON shape

`data/<env>.json` is an arbitrarily-nested object:

```json
{
  "users": {
    "admin":  { "email": "admin@uat.example.com",  "password": "$ADMIN_PWD" },
    "viewer": { "email": "viewer@uat.example.com", "password": "$VIEWER_PWD" }
  },
  "fixtures": {
    "delegateId": "DEL-1234",
    "approvalThreshold": 5000,
    "currency": "AUD"
  }
}
```

`$NAME` string values resolve from `.env.<env>` so secrets stay out of source
control. Numbers and booleans pass through as their JSON types but are
stringified at interpolation time.

### Markdown interpolation

Two namespaces:

```markdown
## Steps
1. Navigate to ${env.BASE_URL}/admin
2. Log in as ${data.users.admin.email} with password ${data.users.admin.password}
3. Approve delegate ${data.fixtures.delegateId} for ${data.fixtures.approvalThreshold}
```

- `${env.X}` → `process.env.X` (which the env loader has already populated).
- `${data.path.to.value}` → walks the parsed JSON by dotted path.
- Unknown key throws at parse time:
  `unknown data path 'users.admin.emial' at tests/foo.md` (with the
  surrounding step text in the error for context).
- Existing `{{parameter}}` interpolation is **unchanged** — the two syntaxes
  coexist. `{{...}}` remains the right tool for runtime / per-row /
  user-prompted values; `${...}` is for env+data values resolved up-front.

### Env resolution — five entry points, one resolver

A new `resolveEnvBundle({ envName, projectRoot })` function returns
`{ envName, env, data }`. Every surface calls it:

| Entry point | How env name is selected |
|---|---|
| CLI `steptix run` | `--env <name>` flag (existing) |
| VS Code steptix | Status-bar dropdown writes `steptix.activeEnv` workspace setting |
| Programmatic `runTests()` | Caller passes `--env` flag through to `runCommand` |
| CI (GitHub Actions) | `AUTOMATION_ENV` envvar |
| Per-test override | Frontmatter `env: <name>` (escape hatch for tests pinned to one env) |

**Precedence (highest first):** CLI flag → frontmatter → VS Code setting →
`AUTOMATION_ENV` → default `local`.

If `data/<env>.json` doesn't exist, the resolver returns `data: {}` and logs
an info message — interpolation of `${data.*}` then fails with a precise error
naming the missing file. (Symmetrical to how `loadEnvFile` already throws
when `.env.<name>` is missing.)

### VS Code status-bar dropdown

A status-bar item: `🌐 env: uat` (visible while a `.md` test is open).
Click → QuickPick listing every env discovered by scanning `data/*.json` ∪
`.env.*` filenames in the workspace. Selection writes
`steptix.activeEnv` to the workspace settings (so it persists across reloads
and is per-workspace, not global).

The next F5 picks up the new env automatically — `run-controller.runLines`
reads the setting and passes it through the existing `env` field on
`streamSteps`. (For v1, the Steptix server-side flow is unchanged — only the
`.env` selection moves; structured `data/*.json` interpolation runs at
markdown parse-time on the CLI/server side and works the same for steptix
runs as for CLI runs.)

### Implementation outline

1. **`src/env/data-loader.ts`** — async `loadDataFile(envName, projectRoot)`,
   returns the parsed JSON object (or `{}` if absent). Resolves `$NAME` string
   leaves against `process.env` (recursive walk).

2. **`src/env/resolve-bundle.ts`** — `resolveEnvBundle({ envName,
   projectRoot })` orchestrates: loads `.env.<env>` (if envName), loads
   `data/<env>.json` (if envName), returns `{ envName, env, data }`.

3. **`src/parser/interpolate.ts`** — new `interpolateEnvData(text, { env,
   data, filePath })`. Replaces `${env.X}` and `${data.path}`; throws on
   missing keys with file context. Used by the parser before `{{...}}`.

4. **`src/parser/markdown.ts`** — `parseTestFile` accepts `dataContext?: {
   env, data }` in `ParseOptions`; if present, every step + hook + parameter
   value passes through `interpolateEnvData` after skill expansion.

5. **CLI wiring** — `runCommand` calls `resolveEnvBundle({ envName: opts.env,
   projectRoot: cwd })` and passes the result into `parseTestFile`.

6. **Steptix** — new `EnvSelectorItem` (status-bar) + `steptix.activeEnv`
   setting + plumb through `run-controller.runLines` so the runner-core sees
   the chosen env.

7. **Frontmatter `env:`** — added to `TestFrontmatter`; consulted by the CLI
   when no `--env` was passed.

## Example — uat vs staging

A single test:

```markdown
---
name: Delegate approval flow
tags: [smoke, delegates]
---

## Config
- baseUrl: ${env.BASE_URL}

## Steps
1. Log in as ${data.users.admin.email} with password ${data.users.admin.password}
2. Find delegate ${data.fixtures.delegateId}
3. Approve an amount of ${data.fixtures.approvalThreshold} ${data.fixtures.currency}
4. Assert the toast says "Approved"
```

Two data files:

```jsonc
// data/uat.json
{
  "users":    { "admin": { "email": "admin@uat.example.com",  "password": "$ADMIN_PWD" }},
  "fixtures": { "delegateId": "DEL-1234",  "approvalThreshold": 5000, "currency": "AUD" }
}
```
```jsonc
// data/staging.json
{
  "users":    { "admin": { "email": "qa-admin@stg.example.com", "password": "$ADMIN_PWD" }},
  "fixtures": { "delegateId": "DEL-9999",  "approvalThreshold": 250,  "currency": "AUD" }
}
```

```bash
# .env.uat
BASE_URL=https://uat.example.com
ADMIN_PWD=...

# .env.staging
BASE_URL=https://staging.example.com
ADMIN_PWD=...
```

Switching:

1. **CLI:** `steptix run delegate-approval.md --env uat` then `--env staging`.
2. **VS Code:** click status-bar `🌐 env: uat` → pick `staging` → F5.
3. **CI:** the workflow sets `AUTOMATION_ENV=staging`.

The test file never changes between runs.

## Failure modes

| What | When | What user sees |
|---|---|---|
| Unknown env | `--env qa` but no `.env.qa` and no `data/qa.json` | Hard error from existing `loadEnvFile` (matches today's behaviour) |
| Missing data file | `--env uat`, `.env.uat` exists, `data/uat.json` doesn't | Info log; `${data.*}` references then fail at parse time |
| Unknown `${data.X.Y}` path | Path doesn't exist in JSON | Parse-time error: `unknown data path 'X.Y' in <test.md>` |
| Unknown `${env.X}` | `process.env.X` is unset | Parse-time error: `unknown env var 'X' in <test.md>` |
| `$VAR` in JSON value, var unset | `data/uat.json` has `"password": "$ADMIN_PWD"` but `.env.uat` doesn't define it | Warning logged; the literal `$ADMIN_PWD` is used (matches existing parameter behaviour) |

## Migration & backwards compat

- `--env` is unchanged; behaviour for tests that don't use `${...}` is
  byte-identical.
- `{{parameter}}` interpolation is unchanged.
- The `dataFile:` frontmatter (CSV/JSON rows for data-driven tests) is a
  separate, orthogonal feature — kept untouched.
- VS Code steptix: when `steptix.activeEnv` is unset, behaviour matches
  today's walk-up `.env` resolution.

## Open questions (deferred)

- Per-skill data scoping? (v1: global; skills inherit the test's data.)
- Schema validation for `data/<env>.json` (zod)? (v1: no — fail at usage site.)
- `${secret.X}` namespace distinct from `${env.X}` for secrets-only? (v1: no
  — `.env` is already the secret store and `${env.X}` reads it.)
- Encrypted data/secrets? (v1: rely on `.env` gitignore + `$VAR` indirection.)
