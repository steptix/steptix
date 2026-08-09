# 034 — TestBench `## Parameters` (and Config / SERVER_*) ignore the selected env file

**Status:** open / high priority — **implemented (not yet committed); see [Implemented](#implemented)**
**Area (extension, the bug):**
[testbench-native/src/extension/run-controller.ts:920-924](../testbench-native/src/extension/run-controller.ts#L920-L924) (`resolveEnvFile`, no env name), [:941](../testbench-native/src/extension/run-controller.ts#L941) (`readEnvFile` — base `.env` only), [:955-970](../testbench-native/src/extension/run-controller.ts#L955-L970) (`SERVER_URL`/`AIUI_SERVER_API_KEY`), [:1008-1015](../testbench-native/src/extension/run-controller.ts#L1008-L1015) (`resolveSection` params + `resolveValue` config), [:1056-1057](../testbench-native/src/extension/run-controller.ts#L1056-L1057) (`effectiveEnvName` computed but only sent to server);
mirror in [testbench-monaco/src/extension/run-controller.ts:165-217](../testbench-monaco/src/extension/run-controller.ts#L165-L217) + [:234-239](../testbench-monaco/src/extension/run-controller.ts#L234-L239) (and the cheap close-path resolve at [:107-122](../testbench-monaco/src/extension/run-controller.ts#L107-L122)).
**Area (the resolver primitives):** [runner-core/src/env-file.ts](../runner-core/src/env-file.ts) (`resolveEnvFile` is hard-wired to a file literally named `.env`, [:71](../runner-core/src/env-file.ts#L71); no `envName` param), [runner-core/src/test-meta.ts:75-88](../runner-core/src/test-meta.ts#L75-L88) (`resolveValueFromEnv`/`resolveSection` — used for `## Parameters`), [runner-core/src/errors.ts](../runner-core/src/errors.ts) (new TB006 code). NB: `## Config` `baseUrl`/`timeout` is resolved by a **controller-local** `resolveValue` (native [run-controller.ts:1608](../testbench-native/src/extension/run-controller.ts#L1608), monaco [:628](../testbench-monaco/src/extension/run-controller.ts#L628)), **not** the imported `resolveValueFromEnv` — but it reads the same `env` map, so overlaying `env` (below) covers it without touching that function.
**Env selection source:** [testbench-native/src/extension/env-selector.ts:58-62](../testbench-native/src/extension/env-selector.ts#L58-L62) (`EnvSelector.activeEnv()` reads `testbench-native.activeEnv`; monaco reads `testbench.activeEnv`), discovers `.env.<name>` at the **workspace root** ([:144-154](../testbench-native/src/extension/env-selector.ts#L144-L154)).
**CLI (already correct — regression test only):** [src/cli/commands/run.ts:73-78](../src/cli/commands/run.ts#L73-L78), [src/env/resolve-bundle.ts:55-73](../src/env/resolve-bundle.ts#L55-L73), [src/parser/parameters.ts:53-59](../src/parser/parameters.ts#L53-L59).
**Related:** [012](012-step-cache-not-env-aware.md) / [028](028-cli-cache-key-collides-and-ignores-env.md) (cache namespacing by env — same "the selection must reach all consumers" theme), [019](019-env-ai-model-key-frozen-at-session-creation.md), [016](016-testbench-config-baseurl-no-datasource-interpolation.md).
**Opened:** 2026-06-18

## Summary

In the TestBench VS Code extension you can pick an active environment via the
status-bar **env selector** (writes `testbench-native.activeEnv` /
`testbench.activeEnv`). The intent is "run this test against `.env.<name>`."

But the extension resolves a test's `## Parameters` **client-side, before the
run is sent**, against the **base `.env` only** — it never overlays the
selected `.env.<name>`. So a parameter that references a variable defined
**only** in `.env.t2`:

```
## Parameters
- token: $T2_ONLY_VAR        # T2_ONLY_VAR lives in .env.t2, not in .env
```

does **not** resolve. `resolveValueFromEnv` returns missing vars unchanged
([test-meta.ts:75-79](../runner-core/src/test-meta.ts#L75-L79)), so the literal
string `$T2_ONLY_VAR` silently passes through and is shipped to the AI as the
`{{token}}` substitution value. No error, no warning.

The same base-`.env`-only blind spot affects, in the extension:
- `## Config` `baseUrl` / `timeout` ([run-controller.ts:1012-1015](../testbench-native/src/extension/run-controller.ts#L1012-L1015)) — and `baseUrl` (the app-under-test URL) is *exactly* the kind of value that differs per env.
- `SERVER_URL` / `AIUI_SERVER_API_KEY` ([run-controller.ts:955-970](../testbench-native/src/extension/run-controller.ts#L955-L970)) — so `.env.t2` can't retarget the server either.

The selected env name **is** transmitted correctly (`effectiveEnvName` →
`envName` in the steps request → server), but it only feeds a *different*
mechanism: server-side `${env.X}` / `${data.X}` interpolation in step text. The
two resolution mechanisms are disjoint, and the env selection reaches only one
of them.

## Root cause — two disjoint resolution paths

**Path A — `## Parameters` / `## Config` `$VAR` (CLIENT-side, base `.env` only). BUGGY.**
1. [run-controller.ts:920-924](../testbench-native/src/extension/run-controller.ts#L920-L924) — `resolveEnvFile({ testFile, workspaceRoot, fallbackPath })`. **No env name is passed**, and `resolveEnvFile` only ever looks for a file literally named `.env` ([env-file.ts:71](../runner-core/src/env-file.ts#L71)). It has no concept of `.env.<name>`.
2. [:941](../testbench-native/src/extension/run-controller.ts#L941) — `env = readEnvFile(path)` → base `.env` map.
3. [:1010](../testbench-native/src/extension/run-controller.ts#L1010) — `resolveSection(rawParameters, env)` resolves `$VAR` against that base map; misses pass through literally.
4. [:1056-1057](../testbench-native/src/extension/run-controller.ts#L1056-L1057) — `effectiveEnvName` is computed *after* params are resolved and is only sent onward. It never re-enters Path A.

**Path B — `${env.X}` in step text (SERVER-side, selected env). ALREADY CORRECT.**
`envName` → api-server → `resolveProjectBundle` → `resolveEnvBundle({ envName })`
([resolve-bundle.ts:55-73](../src/env/resolve-bundle.ts#L55-L73)) composes base
`.env` **then overlays `.env.<name>`** (highest precedence) → `interpolateEnvData`
resolves `${env.X}` against that composed map. `.env.t2`-only vars work here.

**CLI — ALREADY CORRECT (no behavior change needed).** The CLI calls
`resolveEnvBundle({ ..., mutateProcessEnv: true })`
([run.ts:73-78](../src/cli/commands/run.ts#L73-L78)) which overlays base `.env`
+ `.env.<name>` into the real `process.env`; the CLI's `## Parameters` resolver
reads `process.env[VAR]` directly ([parameters.ts:53-59](../src/parser/parameters.ts#L53-L59)),
so a `.env.t2`-only var resolves. Precedence: `--env` > `AUTOMATION_ENV` >
frontmatter `env:` (frontmatter only honored when no run-wide flag —
[run.ts:110](../src/cli/commands/run.ts#L110)). **The fix here is a regression
test that locks this in, not new code.**

## Decisions (agreed with the user, 2026-06-18)

1. **Overlay semantics — base `.env` + `.env.<name>`, selected wins.** Compose
   base `.env`, then `Object.assign` the selected `.env.<name>` on top. Base
   still fills any var `.env.<name>` doesn't define (e.g. shared
   `AIUI_SERVER_API_KEY`). Mirrors Path B / the CLI exactly. **Not** `.env.<name>`-only.
2. **Scope — ALL client-side `$VAR` resolution in the extension.** Apply the
   overlaid map everywhere the run-controller resolves `$VAR` today:
   `## Parameters` (`resolveSection`), `## Config` `baseUrl`/`timeout`
   (`resolveValue`), **and** `SERVER_URL`/`AIUI_SERVER_API_KEY`. This lets `.env.t2`
   retarget the app URL and even the server; where `.env.t2` is silent, base
   `.env` still wins, so it's strictly additive.
3. **Missing selected `.env.<name>` — hard error (new TB006).** If an env is
   selected but `.env.<name>` is not found next to the base `.env`, fail the run
   with a new diagnostic code rather than silently falling back. A deliberate
   selection that can't be honored must not run as if no env were chosen.
   (Contrast the CLI's lenient `readEnvFileVars` — the extension is stricter
   here on purpose, because the selection is an explicit user gesture.)
4. **Both variants.** Fix `testbench-native` **and** `testbench-monaco` for
   parity; both have the identical client-side resolution. Each needs a
   `package.json` patch bump (see CLAUDE.md).

## Implementation plan

### 1. runner-core — overlay primitive + new error code

`runner-core` is the shared `file:` dep bundled into both extensions; put the
overlay logic here so both variants and the parity tests use one source.

**a. `env-file.ts` — add a `.env.<name>` reader + an overlay composer.**
`resolveEnvFile`/`readEnvFile` stay as-is (base `.env` discovery is unchanged).
Add:

```ts
/** Read `.env.<name>` from `dir`. Returns null if the file does not exist;
 *  throws EnvParseError on a malformed line (same as readEnvFile). */
export async function readEnvOverlayFile(
  dir: string,
  envName: string,
): Promise<Record<string, string> | null> {
  const p = path.join(dir, `.env.${envName}`);
  if (!(await defaultExists(p))) return null;
  return parseEnv(await fsp.readFile(p, 'utf8'));
}
```

`readEnvOverlayFile` lives in `env-file.ts`, where `path` ([:15](../runner-core/src/env-file.ts#L15)),
`parseEnv` ([:120](../runner-core/src/env-file.ts#L120)), `fsp` ([:14](../runner-core/src/env-file.ts#L14)),
and the private `defaultExists` ([:177](../runner-core/src/env-file.ts#L177)) are all already in
scope. (You may also just reuse `readEnvFile(p)` after the `defaultExists`
check instead of `parseEnv(await fsp.readFile(...))` — same result, DRYer.)

Look the overlay up in **`path.dirname(envResolution.path)`** — the same
directory as the resolved base `.env`. (In practice both sit at the workspace
root, where `EnvSelector.discoverEnvs` finds `.env.*`
([env-selector.ts:144-154](../testbench-native/src/extension/env-selector.ts#L144-L154)).
If the base `.env` was found by walk-up in a *subdir*, the overlay is expected
beside it — document this; it matches "compose the two files that sit together.")

**b. `errors.ts` — add `TB006`** ("selected env file not found"). Follow the
TB001-005 env-file family. Add to the `ErrorCode` union ([:14-27](../runner-core/src/errors.ts#L14-L27)),
the context map ([:53-66](../runner-core/src/errors.ts#L53-L66)), and the
`CATALOGUE` ([:80-106](../runner-core/src/errors.ts#L80-L106)):

```ts
TB006: { envName: string; expectedPath: string; baseEnvPath: string };
// ...
TB006: (ctx) => ({
  diagnosis: `Active environment "${ctx.envName}" is selected, but no .env.${ctx.envName} was found at ${ctx.expectedPath}`,
  fix: `Create .env.${ctx.envName} next to ${ctx.baseEnvPath}, or clear the env selection in the status bar (🌐 env).`,
  actions: [{ label: 'Reveal .env', command: 'testbench.revealEnvFile' }],
}),
```

> **`actions` is cosmetic here — don't waste time wiring it.** Native's
> `runError` handler stores only `code`/`diagnosis`/`fix` and never reads
> `payload.actions`, so no action button is surfaced in native (true for
> existing TB002-005 too). The catalogue is shared, and monaco does register
> `testbench.revealEnvFile`, so keep that id for consistency — just know the
> button is inert in the native variant. (Native's own reveal command is
> `testbench-native.revealEnvFile`, but since the button isn't surfaced there,
> the mismatch is harmless and pre-existing.)

Add `TB006` to the parity sample contexts in
[runner-core/tests/errors.test.js](../runner-core/tests/errors.test.js) (the
"every code has a sample context" audit fails otherwise). That test imports
from `dist/`, so **rebuild runner-core** before running it.

### 2. testbench-native — overlay the env before any `$VAR` resolution

First **add the `path` import** — neither run-controller imports it today
(native imports only `fs` at [:2](../testbench-native/src/extension/run-controller.ts#L2)):
`import * as path from 'node:path';`. Also add `readEnvOverlayFile` to the
existing `runner-core`/env-file import. (`EnvParseError`, `reportError`,
`EnvSelector`, `readEnvFile` are already imported.)

`env` is declared `let` at [:939](../testbench-native/src/extension/run-controller.ts#L939),
so the reassignment below is valid. After
`env = await readEnvFile(envResolution.path)` ([:941](../testbench-native/src/extension/run-controller.ts#L941))
and **before** the `SERVER_URL` validation at [:955](../testbench-native/src/extension/run-controller.ts#L955),
fold in the overlay:

```ts
const activeEnvName =
  options.envOverride !== undefined ? options.envOverride : EnvSelector.activeEnv();
if (activeEnvName) {
  let overlay: Record<string, string> | null;
  try {
    overlay = await readEnvOverlayFile(path.dirname(envResolution.path), activeEnvName);
  } catch (err) {
    if (err instanceof EnvParseError) {
      return this.fail(reportError('TB005', { envPath: `${path.dirname(envResolution.path)}/.env.${activeEnvName}`, lineNumber: err.lineNumber, line: err.line }), log);
    }
    throw err;
  }
  if (overlay === null) {
    return this.fail(reportError('TB006', {
      envName: activeEnvName,
      expectedPath: path.join(path.dirname(envResolution.path), `.env.${activeEnvName}`),
      baseEnvPath: envResolution.path,
    }), log);
  }
  env = { ...env, ...overlay };  // selected wins (decision 1)
}
```

Everything downstream — `SERVER_URL`/`AIUI_SERVER_API_KEY` validation
([:955-970](../testbench-native/src/extension/run-controller.ts#L955-L970)),
`resolveSection(rawParameters, env)` ([:1010](../testbench-native/src/extension/run-controller.ts#L1010)),
`resolveValue(baseUrl/timeout, env)` ([:1012-1015](../testbench-native/src/extension/run-controller.ts#L1012-L1015))
— then reads the overlaid `env` with no further change (decision 2).

**Subtlety — compute `activeEnvName` once.** It's currently derived at
[:1056-1057](../testbench-native/src/extension/run-controller.ts#L1056-L1057)
as `effectiveEnvName` (honoring `options.envOverride` for batch mode). Hoist
that derivation up to the overlay site and reuse the same value for the
existing `envName` that's sent to the server, so the **client-side overlay and
the server-side `${env.X}` map are guaranteed to use the same env** (otherwise
batch `envOverride` and the selector could disagree).

**Known parity gap — `resolveClient()` ([:692](../testbench-native/src/extension/run-controller.ts#L692)).**
Native has a third `readEnvFile` (base `.env` only) feeding the close /
liveness / last-run client — it resolves no `$VAR` params, so it's not a bug
for *this* issue. But since decision 2 lets `.env.<name>` retarget
`SERVER_URL`, close/liveness could hit the **base** server while the run
targets the overlaid one. Either overlay there too (best-effort, never error)
or document it as a known limitation. Monaco's close-path
([:107-122](../testbench-monaco/src/extension/run-controller.ts#L107-L122)) is
the same case.

### 3. testbench-monaco — same change

Mirror into [testbench-monaco/src/extension/run-controller.ts](../testbench-monaco/src/extension/run-controller.ts):
add the `path` import (monaco doesn't import it either), then overlay after
`readEnvFile` at [:187](../testbench-monaco/src/extension/run-controller.ts#L187),
before the `SERVER_URL` check at [:202](../testbench-monaco/src/extension/run-controller.ts#L202)
and the `resolveSection` at [:236](../testbench-monaco/src/extension/run-controller.ts#L236).

**Monaco's `runLines(lines)` has no `options` arg and no `envOverride`/batch
concept** ([:150](../testbench-monaco/src/extension/run-controller.ts#L150)) — so
do **not** copy native's `options.envOverride` branch here; monaco uses
`EnvSelector.activeEnv()` directly (reading `testbench.activeEnv`).

The cheap session-close resolve at [:107-122](../testbench-monaco/src/extension/run-controller.ts#L107-L122)
only needs `SERVER_URL`/`AIUI_SERVER_API_KEY` and is intentionally forgiving —
leave it base-`.env`-only (or apply the overlay best-effort but never error
there). Document the choice. (Native's analogue is `resolveClient()` —
see the note in step 2.)

### 4. CLI — regression test only (no behavior change)

Add a test proving `## Parameters` `$VAR` resolves from `.env.<name>` when
`--env <name>` is set and the var is absent from base `.env`. Asserts the
[run.ts:73-78](../src/cli/commands/run.ts#L73-L78) → `mutateProcessEnv` →
[parameters.ts:55](../src/parser/parameters.ts#L55) chain stays intact.

### 5. Version bumps (CLAUDE.md)

Both extensions bundle `runner-core`, so editing `runner-core/` **plus** each
`run-controller.ts` requires a **patch bump** of **both**
`testbench-native/package.json` and `testbench-monaco/package.json`, then the
build/package/install-VSIX/reload loop for each.

> Note: `src/` changes (the CLI regression test) are the root package — **not**
> bundled into the extensions, so they don't trigger a bump.

## Tests this needs

- **runner-core unit:** `readEnvOverlayFile` returns the parsed overlay when
  `.env.<name>` exists beside base `.env`; returns `null` when absent; throws
  `EnvParseError` on a malformed overlay line.
- **runner-core unit:** overlay precedence — a key in both base and overlay
  resolves to the overlay value; a base-only key survives; an overlay-only key
  appears.
- **Extension (native + monaco):** with `activeEnv = t2` and `T2_ONLY_VAR` only
  in `.env.t2`, `## Parameters` `- token: $T2_ONLY_VAR` resolves to the
  `.env.t2` value (regression for the reported bug).
- **Extension:** `## Config baseUrl: $APP_URL` and `SERVER_URL=$...`-style vars
  defined only in `.env.t2` are honored when `t2` is active (decision 2).
- **Extension:** `activeEnv = nope` with no `.env.nope` → run fails with
  **TB006** (decision 3), not a silent base-`.env` run.
- **Extension:** with **no** env selected, behavior is identical to today
  (base `.env` only; no overlay, no TB006).
- **errors.test.js:** TB006 renders a diagnosis naming the env and expected path.
- **CLI:** `--env t2` resolves a `.env.t2`-only `## Parameters` var (regression
  lock — see step 4).

## Already covered (no extra work)

- **Re-run paths inherit the overlay automatically.** Native's
  `rerunSkillStepFromFailure` ([:472](../testbench-native/src/extension/run-controller.ts#L472))
  routes back through `runLines` ([:492](../testbench-native/src/extension/run-controller.ts#L492)),
  so it picks up the overlay for free. `skillRerunPayload` / the Variables
  panel render server-supplied scope and don't resolve client-side `$VAR`, so
  there's no second resolution site to patch.

## Out of scope

- Changing the **server-side** `${env.X}` path (Path B) — already correct.
- Changing CLI **behavior** (already correct; test only).
- Reconciling the env-selector's workspace-root discovery with base-`.env`
  walk-up location when they differ across directories — flagged as a
  documentation note above; revisit only if a real layout hits it.
- `## Parameters` still resolves a *missing* var (absent from base **and**
  overlay) to the literal `$VAR` rather than erroring — unchanged here; that's
  a separate "warn on unresolved parameter" improvement.

## Implemented

Implemented on `main` (working tree, not yet committed) following the plan above,
with the `resolveClient` decision resolved as **option B** (the lifecycle client
follows the run's server, not re-read base `.env`).

- **runner-core** — [env-file.ts](../runner-core/src/env-file.ts) gains
  `readEnvOverlayFile(dir, envName)` (returns `null` when the overlay is absent;
  throws `EnvParseError` on a malformed line) and `composeEnv(base, overlay)`
  (overlay wins, pure). New **TB006** code in [errors.ts](../runner-core/src/errors.ts).
- **testbench-native** — [run-controller.ts](../testbench-native/src/extension/run-controller.ts):
  `effectiveEnvName` is hoisted next to env resolution and drives both the
  client-side overlay and the server `envName`; the overlay is folded into `env`
  before any `$VAR` consumer (SERVER_*, Config, Parameters). **Option B:**
  `lastRunServerUrl`/`lastRunApiKey` persist the run's server past run end, and
  `resolveClient()` prefers them so close/liveness/getLastRun follow the run's
  env (falls back to base `.env` only before the first run).
- **testbench-monaco** — mirrored via a shared `overlayActiveEnv` helper: strict
  in `runLines` (TB006/TB005), best-effort in `closeSession`. Monaco has no
  `envOverride`/batch concept, so it reads `EnvSelector.activeEnv()` directly.
- **Versions bumped** — testbench-native `0.5.60 → 0.5.61`, testbench-monaco
  `0.1.56 → 0.1.57`.
- **CLI** — confirmed already-correct; locked in by a regression test, no code
  change.

### Tests (all green)

- **runner-core** (`npm test`, node:test — 151 pass): `readEnvOverlayFile`
  read/null/malformed; `composeEnv` precedence + no-mutation; TB006 catalogue +
  audit/parity.
- **CLI** ([tests/cli-parameters-env.test.ts](../tests/cli-parameters-env.test.ts),
  vitest): `--env t2` resolves a `.env.t2`-only `$VAR` through
  `resolveEnvBundle` → `process.env` → `resolveParameters`; unset var stays empty.
- **testbench-native integration** ([env-overlay.test.cjs](../testbench-native/tests/integration/suite/env-overlay.test.cjs),
  VS Code host — 116 pass incl. the full state-machine/frames suites that exercise
  `resolveClient`): selected env resolves the overlay-only param + forwards
  `envName`; missing `.env.<name>` → TB006, no stream; no env → literal `$VAR`.
  The overlay fixture is written at runtime (`.env.*` is gitignored), and a
  `TESTBENCH_GREP` hook was added to [suite/index.cjs](../testbench-native/tests/integration/suite/index.cjs)
  for scoped local runs.

### Not yet done

- Install/reload the rebuilt VSIXes to confirm the version bump shows in the
  Extensions panel (the user's manual verify step per CLAUDE.md).
- Commit (left for the user to review the diff first).

## Why this matters

The env selector's whole purpose is "run against this environment." Today it
silently honors that only for `${env.X}` in step bodies while quietly ignoring
it for `## Parameters`, `## Config`, and the server connection — the most
common places a user puts per-environment values. The failure is silent (literal
`$VAR` shipped to the AI), which makes it a confusing, hard-to-spot footgun.
