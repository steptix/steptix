# Keyless replay + `AI_GATEWAY_URL` — corporate config groundwork

Status: draft, not yet reviewed.

> **Verification rule for this story.** "Done" means: (1) on a machine with no
> `AI_API_KEY` anywhere (project `.env`, machine `.env`, environment), a
> compiled test replays green with **zero** AI requests, and the same run with
> one deliberately broken code-behind entry fails that step with the exact
> keyless copy below — no `invalid_api_key` anywhere in the report, console,
> or log, and no diagnosis attempt, and the last-run sidecar marks the broken
> step stale so a later keyed compile selects and repairs it; (2)
> `AI_GATEWAY_URL` set in a project's
> `.env` reaches the AiClient on **both** paths — a CLI run in that project,
> and a server run where the Steptix extension shipped that `.env` as env
> overrides — proven at the api-server seam, not just in loader units;
> (3) with neither env nor config-file value, a machine-wide
> `%LOCALAPPDATA%\steptix\.env` `AI_GATEWAY_URL` applies, and a project
> `steptix.config.json` `gatewayUrl` still beats the machine value; (4) editing
> `AI_GATEWAY_URL` in a workspace `.env` between two runs on a reused session
> takes effect on the second run without recycling the session, same as
> `AI_MODEL` today.

## What we're building

Two small changes that together make one corporate story true:

> A machine inside a restricted network can **run** compiled tests with no AI
> configured at all — nothing leaves the network, there is nothing to
> security-review. When a step breaks, the run says plainly that this machine
> has no AI to repair it, instead of surfacing an auth error. And when the org
> *does* approve an internal OpenAI-compatible endpoint, pointing at it is one
> line in `.env` — no tracked-file edit, no code.

Example — corporate laptop, no key, app changed under a compiled test:

```
Step 4: Click the "Transfers" tab
  ✗ failed — replay failed and was not healed: AI is not configured on
    this machine. Recompile or repair this step where AI is available.
```

Today that same situation dies inside the heal fall-through with a gateway
`invalid_api_key` error, and then a second one from the diagnosis pass —
which reads as "my config is broken", not "the app changed". (Implementation
should capture the actual before-output in the PR description.)

Example — org-approved endpoint, shared repo, nothing committed:

```ini
# .env (gitignored) — routes AI through the org's internal gateway
AI_API_KEY=sk-internal-....
AI_MODEL=aibroker/gpt-4.1
AI_GATEWAY_URL=https://llm.corp.example
```

`aibroker/` already means "OpenAI-compatible endpoint at `gatewayUrl`"
([SPEC-aibroker-routing.md](../docs/specs/SPEC-aibroker-routing.md)); today the URL can
only come from `defaults.ts` or the tracked `steptix.config.json`. This story
adds the env var; it changes **no** routing semantics.

## Part A — `AI_GATEWAY_URL`

One new env var, mirroring `AI_MODEL` exactly. `gatewayUrl` is the same kind
of value as `model` — non-secret routing the caller may export explicitly —
so it takes model's precedence, not `apiKey`'s fill-only rule:

```
process env / project .env  >  steptix.config.json  >  user-root .env  >  built-in default
```

Three write sites, and all three are required (each covers a path the others
don't):

1. **`withEnvDefaults`** ([loader.ts](../src/config/loader.ts)) — trimmed,
   non-empty `AI_GATEWAY_URL` overrides the merged config, exactly like the
   `AI_MODEL` block. Covers CLI runs and server startup.
2. **`withMachineAiFloor`** (same file) — machine value applies only when
   neither env nor the config **file** set one. `gatewayUrl` has a built-in
   default (unlike `apiKey`), so post-merge a file value and the default are
   indistinguishable — the check MUST read the *raw* `fileAi.gatewayUrl`,
   the same trap the function already documents for `model`. A floor, never
   an override (stories/machine-key.md).
3. **`applyEnvToAiConfig`** ([run-helpers.ts](../src/server/run-helpers.ts))
   — the server-path overlay for client-shipped `.env` values, which today
   honours **only** `apiKey` and `model` and would silently drop this var.
   This is the exact per-project-bundle trap from the codebehind-env-data
   work: without this site, the loader change works in every unit test and
   does nothing on the Steptix path. Add `AI_GATEWAY_URL` (trimmed,
   non-empty) beside `AI_MODEL`. Grep for any sibling overlay sites
   (errand-runner's `desiredAi` assembly, compile path) — every consumer of
   env overrides must honour the same set.

Reused sessions: `AI_MODEL` / `AI_API_KEY` are re-applied per batch so a
saved `.env` edit lands without recycling
([session-manager.ts:107](../src/server/session-manager.ts)), and
`syncAuth` nulls the memoized gateway so the next call rebuilds it.
`gatewayUrl` is baked into the gateway at build time
([client.ts](../src/ai/client.ts) `buildGateway`), so the re-apply path must
treat a changed `gatewayUrl` the same way model changes are treated: null
the gateway. Extend `syncAuth` (or its caller) accordingly.

Out of scope, on purpose: no new config key (the config key already exists),
no `runSettings` surface for it (per-run model/settings live in
stories/run-settings.md), no URL validation beyond what `buildGateway`
already does (trailing-slash strip). Docs: mention the var wherever
`AI_MODEL`'s env handling is documented — which is [.env.example](../.env.example),
commented out since the default is right for non-corporate users, and the
env-var table in [README.md](../README.md). Not the `init` template: `steptix
init` scaffolds `steptix.config.json`, `tests/`, `context/` and `skills/` and no
`.env` at all, so there are no template `.env` comments to add it to. The
scaffolded `steptix.config.json` should NOT pin a `gatewayUrl` either — a value
there is a deliberate choice that beats the machine floor forever, and one
copied out of a template is nobody's choice.

## Part B — keyless mode

**Definition.** A run is *keyless* when the resolved `ai.apiKey` is
`undefined` or empty **after** all sources have applied (env, project `.env`,
config file, machine floor, server-path overlay). Detected, never declared:
there is no `ai.enabled` flag to drift out of sync with reality. Endpoints
that need no key (Ollama) keep today's contract — set a dummy
`AI_API_KEY=ollama`; this story does not change that.

**Two proactive skips** (the runner checks keyless *before* calling AI, so
the report states intent, not a caught crash):

1. **Heal fall-through.** `runCodeBehindEntry` never throws — the caller
   decides heal-and-fall-through vs fail
   ([execute.ts](../src/codebehind/execute.ts)). There is already a branch
   that fails instead of healing (a failed assertion). Keyless adds a second:
   when the entry fails and the run is keyless, fail the step with

   > `replay failed and was not healed: AI is not configured on this
   > machine. Recompile or repair this step where AI is available.`

   The step is `failed` (not `error`) and the run then does exactly what a
   failed step already makes it do: both runners stop at the first failure
   (`bail` in [test-runner.ts](../src/runner/test-runner.ts), `break` in
   [session-manager.ts](../src/server/session-manager.ts)), and keyless
   changes neither. What the skip must not do is spread: it decides one step,
   leaves every other entry bound and replaying as code, and leaves what a
   failure already means alone.

   **Accounting and repair are decoupled, deliberately.** In the run's own
   result the step is NOT flagged `codeBehindStale`: every heal counter —
   `healedSteps`, `healedTokens`, `countStepOrigins`, the report's amber
   "healed" banner, Steptix's healed-step summary — is read off that field,
   and nothing healed here. But the failure's advice ("recompile or repair
   this step where AI is available") has to be actionable on the machine that
   *does* have a model, so the result carries the entry's failure separately
   (`codeBehindHealSkipped`) and **both** last-run sidecar writers record the
   row as stale, with the underlying thrown message. That is what
   `collectStaleKeys` reads for `steptix compile --only-stale`, and what
   `priorFailure` reads to turn Compile This Step into a repair rather than a
   blind regeneration. The row also carries `healSkipped`, which keeps the
   consecutive-heal streak (`staleRuns`, the "healed under AI (3 runs in a
   row)" marker) from advancing on a machine that has healed nothing.

2. **Diagnosis pass.** The gate at
   [test-runner.ts:1219](../src/runner/test-runner.ts) becomes
   `failed && diagnoseFailures && !keyless`. When skipped for keylessness,
   the report carries a one-line note in the diagnosis slot:

   > `Diagnosis skipped: AI is not configured.`

   `diagnoseFailures` stays default-`true`; keyless is a runtime condition,
   not a config edit the user must know to make.

**One reactive backstop.** `AiClient` currently builds its gateway lazily and
lets `@pkent/aigateway` throw `invalid_api_key` on first use. Add an explicit
check at first use: when keyless, throw a typed `AiNotConfiguredError`:

> `AI is not configured: AI_API_KEY resolved to empty. Compiled tests replay
> without AI; this operation needs a model. Set AI_API_KEY in the project
> .env or the machine .env — and AI_GATEWAY_URL if your org routes through
> its own endpoint. (A blank AI_API_KEY= line in the project .env
> deliberately blocks the machine key.)`

It says "resolved to empty" rather than listing the places the key is missing
from, because a blank `AI_API_KEY=` line — the line `.env.example` ships —
blocks the machine `.env` on purpose: `withMachineAiFloor` is a floor for
values nobody set, not for values someone set to empty, and that is how a
project forces keyless deliberately. Naming the files would be flatly wrong
for the reader who has a machine key and cannot see why it is ignored, so the
parenthetical names the rule instead.

Every operation that genuinely needs AI — compile, errands, AI-executed
steps in an uncompiled test, skill AI steps — inherits this message
reactively with no per-call-site work, replacing the bare gateway error. The
lazy-build behaviour ("construct succeeds; fail at request time") is
unchanged; only the error the request-time failure produces changes.

**What still works keyless / what fails fast:**

| Operation | Keyless behaviour |
|---|---|
| Replay of fully compiled test, all entries green | passes, zero AI calls |
| Replay, an entry fails | that step fails with the heal-skip copy, and the run stops there — exactly as any failed step already ends a run |
| Post-failure diagnosis | skipped with note |
| Uncompiled / partially compiled test (AI steps) | step errors with `AiNotConfiguredError` copy |
| Prose `## Before` / `## After` hooks, and conditional-group polls | never compiled — no entry to replay — so they fail reactively with the `AiNotConfiguredError` copy (hook steps go through `executeStep` with no binding; a poll calls `aiClient.complete` in `executeBranchedStep`). Worth stating plainly because the live-check fixture below has neither, so a green manual check says nothing about them |
| Compile, errand, `run_steps` with AI | fails fast with `AiNotConfiguredError` copy |

Report/wire shape: additive only — the step `error` string and the existing
diagnosis slot carry the copy; no new required fields, no `STXxxx` code, so
the runner-core audit suite is untouched and no extension change or version
bump is needed (the extensions are HTTP clients; this ships by server
restart).

## Tests

- **Loader units** (extend `tests/config-loader.test.ts`): env beats file;
  file beats machine; machine beats default; the raw-`fileAi` nuance —
  a config-file `gatewayUrl` equal to nothing (absent) plus a machine value
  applies the machine value, while an explicit file value blocks it.
- **Api-server seam** (the client-seam rule): POST a run through the real
  api-server entry with env overrides carrying `AI_GATEWAY_URL`, assert the
  AiConfig the run was built with — beside the existing
  `applyEnvToAiConfig` coverage. A loader-only test would have passed while
  the Steptix path dropped the value.
- **Minimum scenario** (no primed inputs): keyless tests must fake
  `readUserRootEnv` and clear `AI_API_KEY` from the process env — on a dev
  machine the machine-wide key silently un-keylesses the test and conditions
  the bug out of the test path.
- **Runner**: compiled fixture replays green keyless with an AiClient spy
  that throws if any request is attempted; same fixture with one broken
  entry → that step failed with the exact copy while the entries either side
  still replay as code at the executor seam (the run itself stops at the
  first failure, as it always has), the result carries no `codeBehindStale`
  but the sidecar row is stale with the thrown message, diagnosis note
  present, spy untouched.
- **Live check** (manual): worktree server started with `AI_API_KEY`
  removed; `templates/init/tests/securebank.md` compiled beforehand on a
  keyed machine; run once green, then break one selector in the app fixture
  and re-run for the keyless failure copy.

## Non-goals

- **Wire redaction** — masking secrets in the AI request payload is its own
  story (reports/logs mask today; the wire deliberately doesn't).
- **Proxy/CA support** — the AI path honours no `HTTP(S)_PROXY` and undici
  ignores those env vars by default; known gap, separate story.
- **Copilot bridges** — assessed 2026-08-27 (memory:
  copilot-integration-assessment); not building any.
- **Per-run gateway override via runSettings** — stories/run-settings.md
  owns per-run knobs.

## Rollout

Server-side only: `npm run build`, restart the `:3100` server. No
`steptix-vscode` version bump. `.env.example`/init-template comment update
rides along.
