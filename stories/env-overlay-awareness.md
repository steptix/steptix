# The env overlay that silently wins — make setup and the 401 say so

Status: draft — reviewed once, revised
Builds on: [copilot-lm-bridge.md](copilot-lm-bridge.md) (the setup command and the
bridge's 401), the env picker (`testbench-native/src/extension/env-selector.ts`), and the
overlay rule in [project-scoped-data-dir-and-env.md](project-scoped-data-dir-and-env.md).

## What we're building

Two small changes that between them remove a class of "it should work but
doesn't", found the hard way the first time anyone pointed the Copilot bridge at
a real project.

**Today.** A user runs **TestBench: Use Copilot for AI**. It writes `AI_MODEL`,
`AI_GATEWAY_URL` and `AI_API_KEY` into the project's `.env`, correctly, and says
so. They run a test. Every AI call fails:

```
401 The TestBench Copilot bridge needs "Authorization: Bearer <token>" with the
token from AI_API_KEY, written by "TestBench: Use Copilot for AI". If that line
came from another machine it will not work here …
```

Nothing in that message is true of their situation. The token is this machine's,
the file is right, the command did run here. What happened is that the workspace
has an **active environment** — say `uat` — so every run composes `.env.uat`
**over** `.env`, and `.env.uat` carries its own `AI_API_KEY`. The bridge is
handed a different key and correctly refuses it.

Worse, the 401's advice — rerun setup — reproduces the failure: setup sees `.env`
already correct and exits with "nothing to write".

**After.** Setup looks at the active overlay before it plans anything and makes
the user choose where the bridge trio lives; the 401 names the overlay as a
candidate cause; and the run output names which keys the overlay overrode.

### What it looks like in practice

**You run** *TestBench: Use Copilot for AI* in a workspace whose active env is `uat`,
where `.env.uat` sets `AI_API_KEY`.
**You get** a choice, before anything is planned or written:

> The active environment **uat** sets `AI_API_KEY` in `.env.uat`, which
> overrides `.env` on every run. Write the bridge settings to `.env.uat`
> instead? **Write `.env.uat`** · **Continue anyway**

**You run** a test where a stale overlay still shadows the token.
**You get** a 401 that lists the actual suspect:

> … or this workspace has an active environment (`testbench-native.activeEnv`)
> whose `.env.<name>` sets its own AI_API_KEY over `.env`.

**You look at the run output** for any run with an active env.
**You see** `.env.uat overlaid (2 keys: AI_API_KEY, SERVER_URL)` — the keys it
overrode, not just a count.

## Why this is worth doing

The overlay rule is correct and stays: most-specific-wins is what makes named
environments useful. The defect is that **nothing tells you it is in force at
the moment it matters**:

- Setup never looks at `.env.<activeEnv>`, so its success message misleads —
  and its `unchanged` short-circuit means rerunning it cannot help.
- The 401 lists three causes and the real one is not among them.
- The env picker in the status bar is hidden unless a `.md` file is the active
  tab, which it is not while someone is reading an error or editing `.env`.

Cost, measured once: a working configuration that took several rounds to
explain, with the user reasonably concluding the bridge was broken.

## What "wins" actually means — stated precisely, because the builder needs it

The one rule shared everywhere is **`.env.<name>` beats `.env`**. Beyond that,
the paths compose differently, and "Continue anyway" behaves differently on each:

- **TestBench run path.** The extension composes `{ ...base, ...overlay }`
  (`composeEnv`, no `process.env` layer) and ships the result as
  `request.env`; the server applies each of the trio over its own AI config,
  a present key winning unconditionally (`applyEnvToAiConfig`). This is the
  path the incident was on.
- **Server-composed paths** (standalone compile, `resolveEnvBundle`). Baseline
  is the *server's own* `process.env`; base `.env` fills only keys absent from
  it; `.env.<name>` overrides all. Since `aiui serve` runs
  `loadDefaultEnvFileSync()`, a server started from a checkout carries that
  checkout's `.env` in `process.env`, and a project's base `.env` **loses** to
  it — base `.env` is the weakest layer there. With **no** env named, this path
  reads no project `.env` for AI at all.
- **CLI (`aiui run`).** Knows nothing of `testbench-native.activeEnv`; takes its
  env from `--env` / `AUTOMATION_ENV` only, and reads `.env` plus the machine
  floor otherwise.

## Part A — setup checks the overlay's whole trio, before it plans

In `lm-bridge-setup.ts`, **before `planEnvUpdate` and its `unchanged`
short-circuit** — not before the confirm, which is too late for the motivating
case:

1. Read the active env (`EnvSelector.activeEnv()`, a static already read by
   `run-controller.ts`; no import cycle).
2. If set, look for `<target.folder>/.env.<name>` — the target's folder, not
   "the workspace", since `resolveEnvTarget()` already picks the active
   editor's folder in a multi-root workspace. Absent → today's behaviour.
3. Present → read it with **both** readers and take the union of their keys.
   `scanServerEnv` is what `planEnvUpdate` writes with and shares the server's
   grammar; but the path the incident was on — the TestBench run — reads the
   overlay with `readEnvOverlayFile` → `parseEnv`, which strips a leading
   `export `. Measured: `export AI_API_KEY=k` is key `export AI_API_KEY` to the
   scanner and `AI_API_KEY` to the parser, so a scanner-only check reports no
   conflict on exactly the overlay that shadows the token at run time.
   `parseEnv` throws on a malformed line; catch that and keep the scan result as
   the floor. Check the union for **any of `AI_MODEL`, `AI_GATEWAY_URL`,
   `AI_API_KEY`**.
4. None set → today's behaviour. Any set → the choice below decides which
   file(s) the plan targets, and **every file written receives the full trio**.

| Choice | Effect |
|---|---|
| **Write `.env.<name>`** | full trio to the overlay; `.env` untouched |
| **Continue anyway** | today's behaviour, for someone who knows why |

**There is no default.** The modal already interrupts, so making the user
choose costs nothing, and a wrong default here can break an environment's
model pairing.

*Write the overlay* edits exactly the file that runs and leaves `.env` as it
was, so there is one copy of the token and one source of truth. Clearing the
env later yields whatever `.env` produced before setup — a different provider,
or the plain "AI is not configured" — both self-explaining, never a bridge 401.

**The CLI trade, stated rather than papered over.** `aiui run` knows nothing of
`testbench-native.activeEnv`, so after *Write the overlay* a plain `aiui run`
does not reach the bridge — it composes `.env` plus the machine floor and runs
on whatever that names. That is not a misleading failure (a different model, or
"AI is not configured"), and the fix is the one the CLI already has:
`aiui run --env uat`. A "write both files" option was considered and dropped:
it would make the two commands agree at the cost of two copies of the token,
with a later setup rerun updating the overlay only while that env is still
active — the staleness that produces exactly the 401 this story exists to
remove. One file, one truth; the summary says which file.

**Why the whole trio, not just the key.** The three are applied independently
on the server. Writing only the token into an overlay that sets its own
`AI_MODEL=openai/…` would compose a run that posts the bridge token to OpenAI —
a *new* misleading 401, and a real provider key silently overwritten in a file
setup promised not to touch. A wrong `AI_GATEWAY_URL` is no better diagnosed:
through the SDK it surfaces as the literal `'Connection error.'`, naming nothing.
Coherence per file is the invariant.

**Mechanics the builder will hit.** `planEnvUpdate` hardcodes one target — it
needs a target parameter, since the same plan now aims at either `.env` or
`.env.<name>`. The tmp-and-rename write stays single-file. `ENV_COMMENT_LINES`
(the block setup appends alongside the trio) names the 401's causes and must gain
the overlay cause; note it is appended only when a key is appended and only if
its first line is absent, so a revised block never reaches an existing file —
and when the target is `.env.<name>`, its "rerun setup in this window" advice
needs the caveat that setup will target the overlay only while that env is
active. `summary()` names the model and URL today, not the file — it must name
the file written, because which file it was is now the whole point.

## Part B — the 401 names the overlay, with no hint machinery

The first draft passed the bridge a hint at construction naming the active
overlay. That cannot work: the bridge is **one listener per machine** serving
every window, `activeEnv` is **per workspace**, and a request arrives carrying
only a Bearer token and an OpenAI body — no workspace identity. In the
two-window case the standby logic exists for, a hint from the listening window
names the *other* window's problem wrongly. The listener it was to ride on
watches `lmBridge.*` only, so it would also go stale on an env switch.

So: no state, no hint. Two changes, each correct by construction:

1. **`unauthorizedError()` gains one unconditional sentence** naming the overlay
   as a candidate: "…or this workspace has an active environment
   (`testbench-native.activeEnv`) whose `.env.<name>` sets its own AI_API_KEY over
   `.env`." The core module stays free of `vscode` imports and testable under
   `node --test`; the message names a mechanism, never a value, so the
   leak-guard test is unchanged.
2. **The run controller's existing overlay log line names the overridden
   keys.** `.env.<name> overlaid (N key(s))` already prints on every run with an
   active env; extending it to `overlaid (2 keys: AI_API_KEY, SERVER_URL)` is one
   line, per-window-correct because it runs in the window that owns the
   workspace, and puts the signal where the user is already looking when a run
   fails.

## Out of scope — split into its own story

The env picker's visibility. Showing it whenever an environment is *selectable*
is the right idea and the wrong size for this story: `refresh()` is synchronous
and fires on every tab change, while `discoverEnvs` is two async `readdir`s, so
the rule needs a cached scan and a file watcher. And the discovery regex matches
`.env.local` / `.env.development` / `.env.production`, so without gating on an
`aiui.config.json` at the root it would plant a permanent `env: (none)` item in
every Vite or Next repo that happens to have TestBench installed. The bare
minimum — logging the active env in run output — is Part B item 2 above.

Also out of scope: changing the overlay precedence, or making `activeEnv`
anything other than a workspace setting.

## Tests

- **Unit (extension, no host):** overlay detection — no active env; active env
  with no `.env.<name>`; present with none of the trio; present with each of the
  three singly. The planner: each choice produces the right file set with a
  **full trio per file** and `.env` untouched under *Write the overlay*.
- **Unit (core):** `unauthorizedError()` contains the overlay sentence and does
  not contain the expected token.
- **Integration (electron harness):** setup with a conflicting overlay prompts
  once and, on *Write the overlay*, leaves `.env.<name>` holding a coherent trio
  and `.env` byte-identical to before; setup with `.env` already correct and a
  conflicting overlay **still prompts** (the `unchanged` case that swallowed the
  incident); setup with no active env writes exactly what it does today. The
  run-controller log names the overridden keys.
- **Manual, real seat:** the incident — active env with a conflicting key, run,
  confirm the 401 and the run log both name the overlay.

## Rollout

`testbench-native` only. Patch bump, package and install per the repo loop. No
server rebuild, no framework change, no library change.

## Open questions

1. **RESOLVED — *Write both* is dropped.** One file, one truth; the CLI uses
   `--env`. Reasoning in Part A.
2. **Should the overlay check also flag `SERVER_URL` / `AIUI_SERVER_API_KEY`?**
   Not bridge-related, but an overlay that redirects the server is the other
   silent-override that reads as "the bridge is broken". Probably a separate
   change.
