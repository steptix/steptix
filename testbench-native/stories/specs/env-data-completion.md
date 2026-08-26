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

## Where the suggestions come from

Completion mirrors what a run would load, resolved per keystroke so file
edits show up immediately:

- **Env name** — the file's frontmatter `env:` pin, else the workspace
  EnvSelector; the same precedence the batch runner applies
  (`envForThisTest` in test-controller.ts). No env → no `data`, no
  `envName`, and no misleading suggestions for refs that would pass through
  literally.
- **`data.*`** — `<dataDir>/<envName>.json` under the `aiui.config.json`
  directory (walk-up from the document), `tests.dataDir` defaulting to
  `data` — exactly where the server's `resolveProjectBundle` reads it.
- **`env.*`** — the walked-up base `.env` composed with the `.env.<name>`
  overlay, runner-core's `resolveEnvFile`/`composeEnv` — the same two files
  the run composes. (The server layers its own process env underneath;
  those keys are unknowable from the editor and are not offered.)
- **`<source>.*`** — the file's own `dataSources:` frontmatter. Paths
  resolve against the file's directory; skill paths first interpolate
  `${env.X}` / `${envName}`, test paths are literal — matching
  `loadFrontmatterDataSources` vs `applySkillEnvDataInterpolation`.

Namespace rules follow the runtime too: skills are never offered `data`
(they can't reach the caller's env-default file), and inside a skill's
frontmatter — a dataSources *path* position — only `env` and `envName`
complete, since that's all `interpolateDataSourcePath` accepts. A test's
frontmatter completes nothing (nothing interpolates there).

## Secrets stay masked

Leaf previews go through runner-core's `maskIfSecret`, keyed on the full
dotted path, so `users.admin.password` and everything under a
`passwords`-named branch render as `********` — including values that only
become secret after a `$VAR` leaf resolves against the env. The dropdown
never shows a secret value.

## Mechanics

- `env-data-completion-core.ts` — vscode-free: cursor-context parse
  (`refContextAt`), tree walk, `$VAR` resolution, item descriptors.
  Unit-tested in `tests/env-data-completion.test.js`.
- `env-data-completion.ts` — the `CompletionItemProvider`: file loading,
  env composition, vscode item mapping. Registered in extension.ts for
  `markdown`/`file` with trigger characters `{` and `.`.
- Namespace items insert their mandatory trailing dot and re-trigger the
  widget; branch items commit on `.`, leaves on `}` — so
  `${` → `data` → `users` → `admin` → `email` chains without arrow keys.
- Everything is best-effort and silent: a missing/malformed file just means
  fewer suggestions. No toasts from a keystroke path.
- Host-proven in `tests/integration/suite/env-data-completion.test.cjs`
  against a runtime-generated project fixture with its own
  `aiui.config.json` (the walk-up must stop before this repo's root
  config).
