# `${…}` reference completion (env, data, dataSources)

## What we're building

Typing `${` in a test step pops IntelliSense for everything a run could
substitute there — and typing `.` walks into the selected environment's data
file, level by level:

```
1. Sign in as ${data.users.│
                           ├─ admin    {2 keys}
                           └─ viewer   {2 keys}
```

With env `local` active (status-bar selector), `${data.` offers the keys of
`fixtures/data/local.json`; `${env.` offers the keys of `.env` + `.env.local`;
a test that declares `dataSources: catalog: …` gets `${catalog.` too; and the
bare `${` position lists the namespaces themselves, plus `envName`. Leaf items
preview the value they would substitute (`email  demo@securebank.com`), so
the dropdown doubles as a peek into the data file.

The other half of the grammar — `{{name}}`, the *runtime* variables filled in
per step — completes too, from the same provider; see
[param-completion.md](param-completion.md).

## Where the suggestions come from

Completion mirrors what the **server** — the component that actually resolves
these references — would load for a run:

- **Env name** — the file's frontmatter `env:` pin when the key is present
  (a blank pin means "no env", exactly what the batch runner's verbatim
  forwarding produces), else the workspace EnvSelector. **No env → no
  suggestions at all**: a run with no env selected performs zero `${...}`
  interpolation, so anything completed would reach the AI as literal text.
  One divergence is documented rather than papered over: interactive
  single-file runs ignore the pin today (only the batch test-controller
  forwards it), so a pinned file completes against its declared env while
  an interactive Run resolves the selector's.
- **`env.*`** — `<projectRoot>/.env` composed with `<projectRoot>/.env.<name>`
  (overlay wins), the exact two files `resolveEnvBundle` reads, resolved
  against the `aiui.config.json` directory with **no walk-up** — the
  test-adjacent walked-up `.env` feeds only the client-side `$VAR` parameter
  pass, not `${env.X}`. The server's own process-env baseline is unknowable
  from the editor and not offered. `env` is flat: nothing is offered below
  `${env.X.`, because no such reference can resolve.
- **`data.*`** — `<dataDir>/<envName>.json` under the same project root,
  `tests.dataDir` defaulting to `data` (one shared constant with the
  EnvSelector's discovery).
- **`<source>.*`** — the file's own `dataSources:` frontmatter. Paths
  resolve against the file's directory; skill paths first interpolate
  `${env.X}` / `${envName}`, test paths are literal — matching
  `loadFrontmatterDataSources` vs `applySkillEnvDataInterpolation`.

Namespace rules follow the runtime too: skills are never offered `data`
(they can't reach the caller's env-default file), and inside a skill's
frontmatter — a dataSources *path* position — only `env` and `envName`
complete, since that's all `interpolateDataSourcePath` accepts. A test's
frontmatter completes nothing (nothing interpolates there). Keys the
reference grammar cannot express (a dot, space, or `@` in a JSON key) are
not offered — accepting one would author a reference `lookupDataPath` can
never resolve.

## Secrets stay masked

Leaf and env-var previews mask under the **runtime's** secret-name rule —
`/password|secret|token|key/i`, the same `isSecretName` that redacts
recordings, reports, and logs — applied to the full dotted path, so
`users.admin.password`, a `privateKey` leaf, a `MACHINE_KEY` env var, and
everything under a `passwords`-named branch or source render as `********`,
including values that only become secret after a `$VAR` leaf resolves
against the env. The dropdown never shows what a report would redact.

## Mechanics

- `env-data-completion-core.ts` — vscode-free: cursor-context parse
  (`refContextAt`), tree walk, `$VAR` resolution (delegating to runner-core's
  `resolveValueFromEnv`), frontmatter span via runner-core's `classifyLines`
  (the same span every other editor feature uses), item descriptors.
  Unit-tested in `tests/env-data-completion.test.js`.
- `env-data-completion.ts` — the `CompletionItemProvider`: file loading,
  env composition, vscode item mapping. Registered in extension.ts for
  `markdown`/`file` with trigger characters `{` and `.`.
- Keystroke-shaped: the line-local `${...` check runs before any
  full-document work (the provider fires on every `.` in every markdown
  file), and all file reads go through an mtime-keyed parse cache — the
  `readProjectDirs` convention.
- Namespace items insert their mandatory trailing dot and re-trigger the
  widget; branch items commit on `.`, leaves on `}` — so
  `${` → `data` → `users` → `admin` → `email` chains without arrow keys.
- Everything is best-effort and silent: a missing/malformed file just means
  fewer suggestions. No toasts from a keystroke path.
- Host-proven in `tests/integration/suite/env-data-completion.test.cjs`
  against a runtime-generated project fixture with its own
  `aiui.config.json` (the walk-up must stop before this repo's root
  config), including the no-walk-up, flat-env, no-env, and blank-pin cases.
