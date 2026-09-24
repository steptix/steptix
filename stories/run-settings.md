# Run settings — the model and the screenshots, changed per session

## In plain terms

Today an agent can run steps but cannot change *how* they run. The model is
whatever the server started with, and screenshots are whatever the server
started with. Both are frozen for the life of the server process, so the only
way to change either is to stop the server and start it again — which kills
every open browser and every signed-in session with it.

This story gives the agent five settings it can change on a live session:

- **Which model runs the steps.** Takes effect on the very next run. No browser
  restart, no closing the session.
- **What gets photographed during a run** — every step, only failures, or
  nothing. These land in the HTML report.
- **What comes back to the chat** — nothing, the failure, or the final page.
  This is deliberately separate from the setting above, because capturing 30
  screenshots into a report is cheap and sending 30 images into a conversation
  is not.
- **Whether the model sees screenshots** while it works, which is the main
  cost lever on a run.
- **Whether AI may be used at all during the run.** `ai: off` makes the run
  behave exactly like a keyless one no matter which keys are configured:
  compiled steps replay, and anything that needs a model — an uncompiled
  step, mid-run healing, the post-failure diagnosis — is skipped or refused
  with the typed no-AI error. The off state is the corporate artifact: "this
  run made zero AI calls, by policy", printed in the report.

Every setting is scoped to one session. That matters because the same server
also serves TestBench: a setting that applied server-wide would let an agent
silently slow down, or inflate the cost of, a run someone is doing by hand.

Each run reports back which settings were in effect, so a preference that stops
being applied shows up in the output instead of failing quietly.

### What it looks like in practice

**You say:** *"Run these steps and screenshot every one — 1. Go to the login
page, 2. Sign in as admin"*
**You get:** the run result, a report with a screenshot of each step, and a
line confirming capture was `every-step` and return was `on-failure`. No images
in the chat, because nothing failed.

**You say:** *"Now run these other steps"*
**You get:** the same browser, the same session, screenshots still being
captured. You don't repeat yourself.

**You say:** *"Show me what the page looks like now"*
**You get:** the current page as an image, without running anything.

**You say:** *"Stop taking screenshots"*
**You get:** capture off from the next run onward. Failure screenshots can stay
on if you want them.

**You say:** *"Use gemini-3-flash for this one"*
**You get:** the next run on that model. Same browser, same page, same captured
variables — only the model changed.

**You say:** *"What settings are you using?"*
**You get:** the model, the three screenshot settings, and where each value came
from — the project's config, the server's default, or something set in this
conversation.

> **Verification rule for this story.** "Done" means: (1) a `run_steps` call
> that sets `capture: "every-step"` produces a report with a screenshot per
> step, against a server whose own config has per-action capture off; (2) a
> second `run_steps` call on the same session that sends no settings at all
> still captures every step — retention, not re-sending, is what makes it
> stick; (3) a `model` override changes which model answers on the next batch of
> an already-open session, with no browser restart; (4) a concurrent run on a
> *different* session on the same server is unaffected by both; (5) every run
> result names the model, capture mode, return mode and AI mode actually in
> effect; (6) `get_run_settings` reports those same values plus their source,
> and starts no server to answer; (7) a run with `ai: "off"` on a *keyed*
> session makes zero AI requests — a stale compiled step takes the keyless
> skip and sidecar, an uncompiled step fails with the policy refusal, no
> diagnosis pass runs — and Compile This Step on that same session
> still compiles.

## Context

Three layers currently decide how a run behaves, and only the middle one is
reachable from a tool call.

| Layer | Reachable? | Holds |
|---|---|---|
| MCP tool arguments | Per call | `include_screenshot` — a boolean, failure-only ([schemas.ts:170](../src/mcp/schemas.ts)) |
| Per-session `config` on the wire | **Write-once** | `baseUrl`, `timeout`, `cdp` — the server throws on an existing session ([session-manager.ts:1179](../src/server/session-manager.ts)) |
| The server's startup config | **Not at all** | The model and every screenshot setting |

That third row is the problem. `aiui serve` calls `loadConfig` once
([serve.ts](../src/cli/commands/serve.ts)) and the result is `this.config` for
the process's whole life. The executor is handed exactly that object at both
call sites — [session-manager.ts:2896](../src/server/session-manager.ts) for a
branched step and [:3273](../src/server/session-manager.ts) for an ordinary one
— so every screenshot decision is read off it per step:

| Setting | Read at | Decides |
|---|---|---|
| `execution.screenshotOnFailure` | [step-executor.ts:323](../src/runner/step-executor.ts) | A capture when a step fails |
| `browser.captureScreenshotsPerAction` | [step-executor.ts:1295](../src/runner/step-executor.ts), [:1484](../src/runner/step-executor.ts) | Per-action and end-of-step captures |
| `browser.fullPageScreenshots` | passed to every `captureScreenshot` call | Full page vs viewport |
| `ai.sendScreenshots` | [step-executor.ts:476](../src/runner/step-executor.ts), [:552](../src/runner/step-executor.ts) | Whether the image goes to the model |

Editing `aiui.config.json` does not help: the server already loaded it. The
per-batch project bundle re-reads it, but only four values are taken from there
— `reports.outputDir` and `browser.video` at session creation
([:894](../src/server/session-manager.ts)), `tests.dataDir`
([:981](../src/server/session-manager.ts)) and `cache.dir`
([:2280](../src/server/session-manager.ts)).

The model is the exception, and it is why this story is smaller than it looks.
The server already re-applies it at the top of *every* batch:
`applyEnvToAiConfig` ([:729](../src/server/session-manager.ts)) folds
`AI_MODEL` / `AI_API_KEY` from the request's `env` over the server base, and
`syncAuth` ([client.ts:102](../src/ai/client.ts)) re-points the client and drops
the memoized gateway, because the model is bound at construction and the
`aibroker/` prefix decides whether the call routes through the gateway or
straight to the provider. That mechanism exists so a saved `.env` edit is picked
up without closing the session. It works just as well for a tool argument.

There is also a precedent for exactly the channel this story needs.
`StepRequest.logging` ([:197](../src/server/session-manager.ts)) is a
per-request override of a server-level setting, forwarded through the route's
allow-list and merged at use. This is the same shape, with retention added.

Two knobs that look relevant are not: `reports.includeScreenshots` and
`reports.embedScreenshots` are declared in
[types.ts](../src/config/types.ts), defaulted, present in the JSON schema and
documented in [SPEC.md](../docs/specs/SPEC.md) — and read by no runtime code anywhere.
They are dead, and exposing them would be shipping a lie.

## Locked decisions

- **Capture and return are two settings, not one.** Capturing every step into
  the HTML report is cheap and often exactly what you want while debugging.
  Returning every step's screenshot into the agent's context is a different and
  much more expensive act — a 30-step run is 30 PNGs, and the fold already drops
  anything over 1.5 MB of base64 ([run-fold.ts:88](../src/mcp/run-fold.ts)).
  Conflating them means "screenshot every step" quietly means "fill my context
  with images". They are separate words with separate values.

- **`capture` is one enum over two booleans.** `captureScreenshotsPerAction`
  and `screenshotOnFailure` describe a four-cell matrix with three meaningful
  cells: capture-everything, capture-only-what-broke, capture-nothing. The
  fourth — every action but *not* the failing step — is nobody's intent. So the
  tool takes `every-step | on-failure | none | default` and the server maps it
  onto the two booleans. The config file keeps both booleans; this is the
  *tool's* vocabulary, not a config change.

- **`return` offers no `every-step`.** `none | on-failure | final | default`.
  The expensive mode is left out rather than left in with a warning, because a
  warning arrives after the images are already in the context window.

- **`send_screenshots` and `full_page` stay their own booleans.** They answer
  different questions from `capture` — what the *model* sees, and what a capture
  *contains*. Folding them into the enum would produce a value list nobody can
  read. Note the existing coupling, which must be stated in the tool
  description: when `sendScreenshots` is on, captures happen per turn regardless
  of `captureScreenshotsPerAction` ([types.ts:95](../src/config/types.ts)),
  because the model's request needs the image.

- **The model is a first-class override, not an injected `env.AI_MODEL`.**
  Merging it into the request's `env` map would work with no server change at
  all, and is rejected anyway: `request.env` is the `${env.X}` interpolation
  scope for step text, so a tool argument landing there changes what a *step*
  can resolve. It also destroys provenance — `get_run_settings` could no longer
  tell "the project's `.env` says this" from "the agent asked for this". The
  override is its own field, applied after `applyEnvToAiConfig`, and beats both.

- **Settings live on the session, applied per request, and are retained.** Not
  in the write-once `config` block, or you could only set them when the session
  is born and turning capture on mid-debug would mean throwing the browser away.
  A request that carries settings updates the session's; a request that carries
  none reuses what the session already has. Retention is what makes a forgotten
  re-send benign rather than a silent revert, and it means the setting survives
  the MCP process restarting.

- **`default` is an explicit value.** Without it, "stop overriding and go back
  to the project's config" is inexpressible — the agent would have to know the
  server's default in order to restore it, and would get it wrong.

- **Every run result names the settings it ran under.** A preference held in a
  conversation degrades silently: the context gets compacted, the flag stops
  being sent, and you find out when you want a screenshot and there isn't one.
  Retention already prevents the revert; the echo is what makes the state
  visible without asking.

- **Session-scoped, never process-wide.** The same server serves TestBench.
  A global setting would let an agent's choice change the cost and speed of a
  human's concurrent run, which is precisely the objection
  [assemble.ts:560](../src/mcp/assemble.ts) already records against forwarding
  log levels.

- **Nothing here writes `aiui.config.json`.** `mcp.cdp.allowUnowned` is
  deliberately gated on a file the agent cannot write
  ([project.ts:283](../src/mcp/project.ts)); a config-writing tool would hand
  the agent the key to its own CDP gate. Persistence, if it is ever wanted, is a
  separate story with an explicit key allow-list.

- **A model change warns about the cache; it does not change the cache key.**
  The step cache keys on step text and identity, not the model
  ([step-cache.ts:319](../src/cache/step-cache.ts) (since removed)), and this project runs with
  caching on. So switching models can serve the previous model's plans — which
  matters most in the case you would switch for, evaluating a different model.
  Adding the model to the key would invalidate every cached entry in every
  project for that one case. The run warns instead, and the caller can turn the
  cache off.

## Design

### 1. The wire

One new optional field on `StepRequest`, beside `logging`:

```jsonc
{
  "steps": ["…"],
  "runSettings": {
    "model": "openrouter/google/gemini-3-flash-preview:nitro",
    "capture": "every-step",        // every-step | on-failure | none | default
    "fullPage": true,
    "sendScreenshots": false,
    "ai": "on"                      // on | off | default
  }
}
```

Every key is optional and independently retained: sending `{ "capture":
"none" }` changes capture and leaves the model alone. `"default"` on the enum,
and `null` on the model and the booleans, clear that one override and fall back
to the project/server value.

`return` is **not** on this field — it never reaches the server. It is an MCP
tool argument that decides what the fold puts in the tool result.

The route must add an explicit branch for `runSettings` in
[api-server.ts](../src/server/api-server.ts)'s request builder. Widening the
type alone compiles cleanly and drops the field at runtime; that is exactly how
`envName` was lost once ([assemble.ts:16](../src/mcp/assemble.ts)). Unknown enum
values are a 400 naming the valid ones, never a silent fallback — an agent that
asked for `all` and quietly got `none` will not notice.

### 2. Retention and application

`ManagedSession` gains a `runSettings` slice, seeded empty at
`createSession` ([:1679](../src/server/session-manager.ts)). At the top of
`executeStepsInternal`, beside the existing `syncAuth` call:

1. If the request carried `runSettings`, merge it over the session's, per key.
2. Resolve the effective config for this batch: server base → project bundle →
   session `runSettings`.
3. Apply the model through the existing path — `applyEnvToAiConfig` first, then
   the override, then `syncAuth`. Log the change the way the `.env` path
   already does.
4. Pass the resolved config to `executeStep` / `executeBranchedStep` in place
   of `this.config` at both call sites.

Step 4 is the only invasive edit, and it wants care: those call sites hand the
executor the *whole* config object, so the merge must produce a complete
`Config`, not a partial. Build it by spreading — `{...this.config, browser:
{...this.config.browser, …}}` — so a setting nobody overrode keeps the exact
value it has today.

> The neighbouring, larger fix is deliberately **not** taken here: those call
> sites should arguably read the per-batch *project* bundle rather than
> `this.config` at all, which is what [session-manager.ts:553](../src/server/session-manager.ts)
> already describes as correct-but-deferred. Doing it inside this story would
> mean every config value the executor reads changes source at once. It stays a
> follow-up; this change threads one narrow slice and leaves the base alone.

### 3. Capture, mapped

| `capture` | `captureScreenshotsPerAction` | `screenshotOnFailure` |
|---|---|---|
| `every-step` | `true` | `true` |
| `on-failure` | `false` | `true` |
| `none` | `false` | `false` |
| `default` | *(project/server value)* | *(project/server value)* |

`fullPage` maps to `browser.fullPageScreenshots` and `sendScreenshots` to
`ai.sendScreenshots`, unchanged in meaning.

### 4. Return, and where the image comes from

`include_screenshot: boolean` is replaced by `screenshots_return: "none" |
"on-failure" | "final" | "default"`. It is an MCP-only concern: the fold
already sees every `step:pass` and `step:fail` event, and **both** carry a
`screenshot` field ([session-manager.ts:3514](../src/server/session-manager.ts),
[:3627](../src/server/session-manager.ts)). Today the fold records only the
failure one ([run-fold.ts:358](../src/mcp/run-fold.ts)); `final` needs it to
also keep the last screenshot it saw, whatever the step's outcome.

The dependency is real and must be stated in the tool description: a passing
step carries no screenshot at all unless per-action capture is on
([step-executor.ts:1484](../src/runner/step-executor.ts)). So `final` with
`capture: "none"` returns nothing. The fold emits a warning naming the cause
rather than an empty result the caller has to diagnose.

The existing 1.5 MB base64 cap stays and will bite more often once `fullPage`
is on — a full-page PNG of a long page exceeds it — and the existing behaviour
(drop the image, warn, keep the run result) is correct.

### 5. The echo

The `done` event gains an `effectiveSettings` object: the model, the three
screenshot values, and where each came from (`server`, `project`, `session`).
(§9 later adds the AI mode to this same object, plus — when off — whether
policy or a missing key made it so.)
The server is the only party that can report this — the MCP does not know the
server's defaults, and reading the project file itself would answer a different
question.

The fold copies it onto the run result. It must tolerate the field being
absent: an older Sessions API server omits it entirely, and every new field in
`runResultOutput` must be `.nullable()` rather than optional, or a missing key
degrades the whole result to `isError` with no structured content at all (see
the header of [schemas.ts](../src/mcp/schemas.ts)).

### 6. Reading the settings

`GET /config` — unauthenticated like `/health`? **No: behind auth**, because it
reports project paths and the resolved model. It answers with the effective
server config, `ai.apiKey` and `server.apiKey` redacted to a boolean "set", and
takes an optional `?sessionId=` to include that session's retained overrides.

The MCP tool is `get_run_settings`, and it uses `assertServerRecognized`, not
`ensureServerReady` — asking what the settings are must not cause a server to
exist, the same rule `list_sessions` and `server_status` already follow
([tools.ts:466](../src/mcp/tools.ts)).

### 7. A screenshot without a run

"Show me what the page looks like now" needs no new capture code:
`GET /sessions/:id` already returns a base64 screenshot of the active page
([session-manager.ts:1269](../src/server/session-manager.ts)), and the MCP
simply does not expose it. Add `format: "screenshot"` to `get_page_content`,
returning an image content block instead of text.

Two honest limits for the description: it is a **viewport** shot, since
`getSession` calls `captureScreenshot(page)` with no full-page argument; and
`getSession` swallows capture failures into an empty string, so the MCP layer
must treat empty as an error rather than reporting a blank page.

### 8. Refusals

- Unknown enum value → 400 naming the valid values.
- A model string that is empty or whitespace → 400. Anything else is passed
  through: the gateway is the authority on which models exist, and a
  client-side allow-list would go stale.
- `screenshots_return: "final"` with capture off → the run still happens, and
  the result carries a warning naming the setting to change. Not an error: the
  steps are the point, and refusing to run because an image is unavailable is
  the wrong trade.
- A model switch on a session with caching on → warning on the run result,
  naming the cache as the reason results may not reflect the new model.

### 9. The AI switch

`ai: "on" | "off" | "default"` follows `capture`'s pattern: `"default"` clears
the override and falls back to the project value, a new `ai.allowInRuns`
(default `true`, so absence is exactly today's behavior).

`off` does not invent a mode — it reuses keyless
([keyless-replay-and-gateway-env.md](keyless-replay-and-gateway-env.md),
PR #111) — but there is no single predicate to flip: keyless is enforced at
points that read different inputs, and each needs the policy threaded in. At
the top of `executeStepsInternal`, compute
`runKeyless = !aiConfigured(desiredAi) || effective.ai === 'off'` and pass it
as `opts.keyless`. That reuses, unchanged, the heal fall-through skip in
`runCodeBehindStep` (`codeBehindHealSkipped`, plus the `stale: true` +
`healSkipped` sidecar row so compile-repair still finds the step). The
diagnosis pass needs no gate on this path: it exists only on the CLI runner
(`test-runner.ts`, behind its own local keyless check), and the server path
this wire reaches runs no diagnosis at all — item (7)'s "no diagnosis pass"
is satisfied there by absence, and the CLI's skip is out of this wire's
reach. The refusal on an AI-*executed* step is NOT covered by that
flag: it lives in `AiClient.getGateway()`'s key-presence check, which under
`ai: off` still holds a real key and would happily run the step while the
report claims zero-by-policy. The policy therefore needs its own refusal,
with its own message — "this run forbids AI (runSettings.ai: off)" — because
both existing keyless texts are wrong for policy-off: `AiNotConfiguredError`
says "Set AI_API_KEY in the project .env", and the heal-skip text claims "AI
is not configured on this machine" — untrue when a key is present and policy
is off, and either would erase the very distinction the echo must keep.
Where the refusal lives is decided by a fact, not taste: the branched-step
call site (`executeBranchedStep`) receives neither `keyless` nor
`codeBehind` in its options, so an executor-level gate misses branched AI
steps entirely — the client-side gate covers them for free, which points the
refusal at the client. The
report and `effectiveSettings` distinguish `AI: off (policy)` from
`AI: off (no key)` — support needs to tell them apart — and the two message
variants are explicit work items of this story.

Explicitly NOT gated: compile, Repair This Step, and errands — those are
requests *for* AI. This needs a mechanism, not a sentence: compile rides the
gated pipeline (the compile-runner calls `executeSteps`, and settings are
retained per session), so a session whose retained `ai` is `off` would gate
its own repairs — and the obvious patch, compile sending
`runSettings: {ai: "on"}`, is wrong, because `mergeRunSettings` would retain
it and silently clobber the user's standing `off` for every later run. The
carve-out is therefore a non-retained PER-REQUEST decision, which
`resolveRunSettings` honours by skipping the `ai` slice for that request only.
Three things reach it, and two are on the wire — the sentence that used to
stand here ("never accepted from the wire, the api-server allowlist does not
know it") stopped being true the moment Compile This Step shipped as
`compile: 'steps'` on the step route rather than as its own endpoint:

- the internal flag (`internal.bypassAiPolicy`), set by the compile-runner and
  errand-runner call sites and unreachable from a request;
- `compile` on the wire, which is how Compile This Step and Repair This Step
  actually arrive. The validator makes it carry `?stream=1` and a
  `testFilePath`, and it always leaves a trace the author sees: a proposal on
  the stream, a recording beside the test;
- `withinCompileRun` on the wire — the rest of a logical run that compiles
  once (rows 2..N of a data-driven compile,
  [data-driven-rows.md](data-driven-rows.md) decision 11). It opens no
  compiler and leaves no proposal, so it would be the quietest of the three;
  what gates it is that it must be exactly `'run'` or `'steps'`, is refused
  alongside `compile`, and is refused without a `testFilePath` — the field
  that makes it a statement about one test rather than a traceless AI budget.
  And because that statement is the only trace it has, the server writes it
  down: one `logger.info` per carve-out batch, naming the test file and the
  mode, so a project with `ai.allowInRuns: false` can account for every AI call
  in its log. The file name and the mode and nothing else — a row cell can be a
  password, and this line is written whatever the policy is.

What the wire cannot do is retain the carve-out or turn it into a setting:
both fields are per-request, `mergeRunSettings` never sees them, and the next
plain batch on the same session is gated again. An `ai: off` run
that meets an uncompiled step still fails that step the way keyless does —
"this step needs AI and this run forbids it" — actionable, and marked for
repair.

Why now: the Copilot bridge ([copilot-lm-bridge.md](copilot-lm-bridge.md))
makes a credential permanently present (the bridge token), so "leave the key
blank" stops being available as the way to say "spend nothing". The switch
restores that as stated intent rather than credential accident, for every
provider at once.

What §9 adds to the *built* feature — the §§1–8 wire is implemented, so these
are increments on shipped code: `"ai"` joins `RUN_SETTING_KEYS` (today the
key is refused as unknown); `parseRunSettings` gains the mode enum beside
`CAPTURE_MODES`; `mergeRunSettings` gains the `'default'`-deletes branch;
`resolveRunSettings` and `EffectiveSettings` gain `ai` plus its source and,
when off, the reason (policy vs no key); `ai.allowInRuns` lands in
types/defaults/schema and **must join the hand-grown per-project re-source
list** in `resolveRunSettings` — the exact trap that list's own comment warns
about — or a project's value is silently the server's; and the api-server
enum validation, `get_run_settings` output, `runResultOutput` (nullable,
older-server rule) and both run tools' schemas follow. Tests, on the same
seams as below: `ai` accepted on the wire and an unknown value is a 400;
`off` reaches the executor as keyless-by-policy; retention and
`default`-restores; the echo distinguishes policy from no-key; compile on an
`ai: off` session still compiles.

## Out of scope

- A TestBench run-button toggle for `ai` — the extensions get the wire for
  free; surfacing a mode chooser in their UI is an extension story.
- Writing `aiui.config.json`, or any persistence beyond the session.
- Server-wide settings changes.
- `reports.includeScreenshots` / `reports.embedScreenshots` — dead knobs;
  either delete them or implement them, in a separate change.
- Returning every step's screenshot to the caller.
- Adding the model to the step cache key.
- Threading the project bundle into the executor call sites wholesale (§2).
- Any change to the TestBench extensions — they are HTTP clients and get the
  route for free.
- Video (`browser.video`), which is already per-project and already resolved at
  session creation.

## Composition

| File | Change |
|---|---|
| [src/config/types.ts](../src/config/types.ts) | `RunSettings` — the override slice and its enum. |
| [src/server/session-manager.ts](../src/server/session-manager.ts) | `StepRequest.runSettings`; `ManagedSession.runSettings`; merge + resolve at the top of `executeStepsInternal`; model override after `applyEnvToAiConfig`; resolved config passed to both executor call sites; `effectiveSettings` on the `done` event; `getRunSettings(sessionId)`. |
| [src/server/api-server.ts](../src/server/api-server.ts) | Allow-list branch for `runSettings` with enum validation; `GET /config` with redaction and optional `?sessionId=`. |
| [src/mcp/types.ts](../src/mcp/types.ts) | `RunSettings`, `EffectiveSettings`; `McpStepRequest.runSettings`; `ApiClient.getConfig`. |
| [src/mcp/api-client.ts](../src/mcp/api-client.ts) | The `GET /config` fetch. |
| [src/mcp/assemble.ts](../src/mcp/assemble.ts) | Pass tool settings onto the request. Note this is a *new* field, not part of the `## Config` string merge. |
| [src/mcp/run-fold.ts](../src/mcp/run-fold.ts) | Keep the last screenshot regardless of outcome; `effectiveSettings` passthrough; the capture-off warning. |
| [src/mcp/schemas.ts](../src/mcp/schemas.ts) | `runSettings` input fragment; `screenshots_return`; `effectiveSettings` on `runResultOutput` (nullable); `getRunSettingsInput` / `Output`; `format: "screenshot"` on page content. |
| [src/mcp/tools.ts](../src/mcp/tools.ts) | Register `get_run_settings`; settings arguments on both run tools; the coupling notes in the descriptions. |

## Tests

### Seam (vitest, repo root)

- A request carrying `runSettings` resolves a config whose two screenshot
  booleans differ from `this.config` — asserted on what reaches the executor,
  not on what was stored.
- **A second request with no `runSettings` still runs with the first one's
  values.** This is the retention decision and the one that silently regresses.
- Session A's settings do not appear in session B's resolved config.
- `default` restores the base value rather than the last override.
- A model override changes what `syncAuth` is called with, and beats an
  `AI_MODEL` present in the request's `env`.
- An unknown enum value is a 400 and reaches no session.
- The fold keeps a passing run's last screenshot under `final`, and warns
  rather than silently returning nothing when capture is off.
- `effectiveSettings` absent from `done` still validates against
  `runResultOutput` — the older-server path.

### Route (real app over HTTP)

House pattern — `listenOnRandomPort()` over `node:http` with the nine `vi.mock`
calls; budget for another copy of the [tests/api-server.test.ts](../tests/api-server.test.ts)
scaffold or factor the mock factories into `tests/helpers/`.

- `GET /config` redacts both keys and returns them as booleans.
- `GET /config?sessionId=` includes retained overrides; an unknown session id
  answers 404 rather than silently returning the base config.

### Live (manual, required to merge)

Against a server whose own config has per-action capture **off** — otherwise
every assertion passes for the wrong reason:

1. `run_steps` with `capture: "every-step"` → the report has a screenshot per
   step.
2. A second `run_steps` on that session with no settings → still every step.
3. `model` override → the run log shows the model change and the run answers on
   the new model, with the browser untouched.
4. A TestBench run on another session during (1) → unaffected.
5. `get_run_settings` against a stopped server → reports it is not running and
   starts nothing.

## Risks / open

- **The executor call sites take the whole `Config`.** The merge has to be
  complete and spread carefully; a partial object would blank out settings
  nobody asked to change. The seam test asserts on what reaches the executor
  for this reason.
- **`sendScreenshots` forces per-turn capture** regardless of the capture
  setting, so `capture: "none"` plus `sendScreenshots: true` still takes
  pictures. Documented rather than reconciled — the model's request genuinely
  needs the image.
- **Retention across clients.** Because settings live on the session, a
  TestBench user attached to the same session inherits whatever the agent set.
  That is the intended semantic, and the echo is what makes it discoverable —
  but it is worth watching in real use.
- **The cache interaction** is warned about, not solved.

# Plan

## Workstream graph

```
W1 server override channel ──> W2 GET /config ──> W3 MCP tools
                            └─> W4 screenshot on demand
```

W1 is the only workstream with a hard prerequisite chain; W4 touches an existing
endpoint and can land in any order.

## Workstreams

**W1 — server override channel.** §1–§3, §5. `StepRequest.runSettings`, the
route branch and validation, session retention, the resolved config at both
executor call sites, the model override, `effectiveSettings` on `done`. Write
the retention test and the cross-session isolation test first — both fail
silently in production and nowhere else.

**W2 — `GET /config`.** §6. The route, redaction, the optional session lookup.
Independently useful: TestBench can show the effective settings without any MCP
involvement.

**W3 — MCP tools.** §1, §4, §6, §8. Client method, schemas, the settings
arguments on both run tools, `screenshots_return` replacing
`include_screenshot`, `get_run_settings`, and the fold changes. The descriptions
carry the two couplings — capture-before-return, and sendScreenshots-forces-
capture — because a tool description is the only text guaranteed to be in front
of the model at the moment it calls.

**W4 — screenshot on demand.** §7. `format: "screenshot"` on
`get_page_content`, over the existing `GET /sessions/:id` capture. Small, and
the empty-string-means-failure normalisation is the whole of it.

## Repo gotchas

- **Rebuild `dist/` and restart the Sessions API server.** The running server
  executes compiled `dist/`, and the MCP server the host spawns runs `dist/`
  too — a `src/` edit is live for neither until `npm run build`. No TestBench
  version bump: this is server-side, and the extensions are HTTP clients.
- **The route's request builder is an explicit allow-list.** Widening a type
  without adding the branch compiles and drops the field at runtime.
- **Output schema fields are `.nullable()`, never optional.** A missing key
  degrades the whole result to `isError` with no structured content.
- **The full vitest run is intermittently flaky** (worker-pool crash, all files
  at once, ~8 s, 0 tests). Re-run the single file before believing a regression.
- **Test against a server whose config differs from the override.** A live check
  run against a server that already had capture on would pass without the
  feature existing.
