# Claude on Bedrock — the customer's own AWS account as the AI endpoint

Status: draft — reviewed once, revised
Builds on: the model-prefix routing
([SPEC-aibroker-routing.md](../SPEC-aibroker-routing.md) plus the `gateway/`
alias from [copilot-lm-bridge.md](copilot-lm-bridge.md) Part B), keyless replay
([keyless-replay-and-gateway-env.md](keyless-replay-and-gateway-env.md),
PR #111), and the AI run switch ([run-settings.md](run-settings.md) §9).

## What we're building

A team whose AI is approved only as "Claude in our own AWS account" can point
this framework at it. Prompts go to Bedrock in their region, under their
existing AWS agreement, over their own network path — commonly a VPC endpoint,
so nothing traverses the public internet. No new vendor to clear, no per-seat
quota, and it works headless and in CI, which the Copilot bridge cannot.

**Bedrock has two authentication modes, and they cost very different amounts of
work.** That split drives this whole story:

**Mode 1 — bearer token.** Anthropic documents this for exactly our audience:
"corporate environments where teams need access to Bedrock without managing AWS
credentials, IAM roles, or account-level permissions." The token goes in the
existing `AI_API_KEY`, so *every* framework assumption already holds — a key is
present, keyless means what it always meant, nothing in Part B is needed:

```
AI_MODEL=bedrock/global.anthropic.claude-opus-4-6-v1
AI_API_KEY=<bedrock bearer token>
AWS_REGION=eu-west-1
```

**Mode 2 — SigV4 over the AWS credential chain.** No key anywhere; credentials
come from env vars, an SSO profile, or an instance role. This is the mode that
needs Part B, because a correct setup has no `AI_API_KEY` at all and today that
means "no AI":

```
AI_MODEL=bedrock/global.anthropic.claude-opus-4-6-v1
AWS_REGION=eu-west-1
AWS_PROFILE=acme-dev          # or an instance role, or env credentials
```

**Ship Part A first.** It delivers Mode 1 completely and is independently
useful; Part B is a separable follow-on for Mode 2.

## Part A — the `bedrock` provider (`@pkent/aigateway`)

### The provider, and what the refactor actually is

`AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk` (current: 0.33.3)
`extends BaseAnthropic` and declares `messages: Resources.Messages` — the same
resource class the first-party client uses, not a lookalike. So the ~213 lines
of translation in the existing `anthropic` provider (`buildRequest`,
`normalize`, `normalizeContentBlocks`, `extractAnthropicUsage`, the stream
event handling) genuinely apply unchanged, streaming included.

The refactor is narrower than "factor out the client": `createProvider` already
accepts an injected `client` — that is how the offline tests work. The real
work is **parameterizing it by `id`**, because three lines stamp provider
identity: `id: 'anthropic'`, the `provider: 'anthropic'` field in the v2
envelope, and the `anthropic_${…}` stream-id prefix.

One line must **not** be parameterized: `normalizeContentBlocks('anthropic', …)`
names the *wire family*, not the provider, and stays as-is for Bedrock.

The precedent is next door and argues *for* this shape: `gateway` and
`aibroker` are thin registrations over one parameterized
`createOpenAICompatibleProvider({ id, … })`. Do the same here.

Use the **Mantle** client. Plain `AnthropicBedrock` is the legacy
`bedrock-runtime` InvokeModel path; Mantle targets the Messages API endpoint.
Note the package README documents only the legacy client — trust the typings,
not the README.

### Two guards in `AIGateway` that stand in front of the provider

Neither is optional, and the first is why Mode 2 cannot work without a library
change:

1. **The key guard.** `AIGateway`'s constructor throws `invalid_api_key` on an
   empty key *before* `entry.create` runs. A Mode-2 Bedrock config therefore
   dies at construction, no matter what the framework believes. A
   `selfAuthenticating` entry must skip this check, the same way an injected
   `client` already does.
2. **The options allowlist.** `AIGateway` forwards a fixed set
   (`baseURL`, `maxTokens`, `timeout`, `referer`, `title`, `client`, `effort`)
   — there is no arbitrary pass-through, so nothing Bedrock-specific can be
   threaded without editing the constructor.

That second guard is a reason **not** to add region handling: see below.

### Region needs no code

The Mantle client already resolves region itself — the `awsRegion` argument,
else `AWS_REGION`, else `AWS_DEFAULT_REGION`, else an explicit `baseURL` — and
throws a clear construction-time error naming those variables when none
resolves. `awsRegion` is optional, not required. Building aigateway-side
resolution would duplicate working logic, require widening the options
allowlist, and break the library's stated invariant that it reads no
environment variables.

What *is* worth documenting: unlike the Python SDK, the TypeScript client does
**not** read `~/.aws/config`, so an SSO profile that sets a region is not
enough — `AWS_REGION` must be set explicitly.

#### Explicitly *where*, though — the half this section originally left out

"The client reads `AWS_REGION`" is true of the SDK and says nothing about which
process's environment that is, which is exactly how the first draft of the docs
came to tell users to put it in a project `.env`. On two of the four paths that
is silently wrong:

| Path | Project `.env` reaches `process.env`? |
| --- | --- |
| `aiui run` | Yes — `cli/index.ts` calls `loadDefaultEnvFileSync()` at module scope |
| Electron Runner UI | Yes — `ui/main/index.ts` does the same |
| Sessions API server (TestBench) | **No** |
| MCP | **No** |

The server path is not an oversight to repair. `project-bundle.ts` resolves
each request's bundle with `mutateProcessEnv: false` *by design* — one server
serves many projects, and exporting any one project's `.env` into the shared
process is what stories/project-scoped-data-dir-and-env.md exists to prevent.
What travels instead is `applyEnvToAiConfig`, which forwards exactly
`AI_API_KEY`, `AI_MODEL` and `AI_GATEWAY_URL` into the run's `AiConfig`. No AWS
variable is in that list, and the Mantle client would not read `AiConfig`
anyway — it reads `process.env`.

**So the documentation is what changes, not the plumbing.** AWS credentials
already come from the machine — env vars, an SSO profile, an instance role —
and cannot live in a project `.env` in the first place; the region belongs with
the credentials it is part of. Machine-level region is the coherent design, not
a workaround for a limitation. The README and `.env.example` now say to put
`AWS_REGION` / `AWS_PROFILE` in the environment that **starts the Sessions API
server** (or that runs the CI job), and say plainly that the project-`.env`
form works on the CLI and the Electron UI only.

Considered and rejected: **forwarding the AWS variables through the bundle**,
either by adding them to `applyEnvToAiConfig` or by threading `awsRegion` into
the gateway options. It would mean widening `AIGateway`'s fixed option
allowlist — the same widening this section argues against two paragraphs up,
and the same invariant ("reads no environment variables") it would break — to
buy a second, repo-shaped way of configuring something AWS already configures
machine-wide. It also would not generalise: the credential chain is more than
one variable, and forwarding a region while credentials still came from the
machine would be the confusing half-measure.

One consequence worth naming: TestBench's `serverAutoStart` launches the server
as a child process, so the server inherits the environment of whatever launched
VS Code. A region exported in a terminal *after* VS Code started is not in that
environment. Set it where it persists — the user's environment variables, the
shell profile, or the CI job definition — rather than in the shell you happen
to be typing in.

### Model ids

Every Bedrock id form is slash-free, so the generic `stripProviderPrefix`
(first `/`, slice) is correct with no special case:

```
bedrock/global.anthropic.claude-opus-4-6-v1              →  global.anthropic.claude-opus-4-6-v1
bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0     →  eu.anthropic.claude-sonnet-4-5-20250929-v1:0
bedrock/anthropic.claude-sonnet-4-6                      →  anthropic.claude-sonnet-4-6
```

**The prefixed inference-profile form is the norm, not an edge case.** AWS
serves most current Claude models through cross-region inference only, and
passing the bare base id returns HTTP 400 ("Retry your request with the ID or
ARN of an inference profile that contains this model"). Suffixes vary per model
(`-v1`, `-20250929-v1:0`, or none). Docs must lead with a prefixed example.

**Non-goal: inference-profile ARNs.** `arn:aws:bedrock:…:inference-profile/…`
contains slashes and would be mangled by the generic prefix strip. Out of scope
until someone needs it; it would need its own escaping rule.

### Declaring that the provider self-authenticates

Registry entries are `{id, prefix, matches, create}` and `listProviderEntries()`
maps `{id, prefix}`. Add `selfAuthenticating: true` to the bedrock entry,
surface it through `listProviderEntries()`, and — per the key guard above — have
the constructor consult it.

It earns its place twice: it gates the library's own key check, and it lets the
framework ask rather than keeping a second, drift-prone list of key-free
prefixes.

## Part B — the framework: "configured" without a key (Mode 2 only)

### The problem

[`aiConfigured`](../src/config/loader.ts) is `(ai.apiKey ?? '').trim() !== ''`.
A Mode-2 Bedrock user has no key, so every AI call is refused before reaching
the provider and the run reports `AI: off (no key)` — telling them to set a key
Bedrock has no use for.

### The change

`AiConfig` already carries `model` beside `apiKey`, so the predicate becomes
model-aware with **no signature change**: AI is configured when the key is
non-empty **or** the model routes to a provider the library reports as
`selfAuthenticating`.

But "touches none of its six call sites" is wrong, and the exception matters.
Two server-path sites are handed the **pre-override** model while the run
actually uses a session override:

- `session-manager.ts` (`aiConfigured(desiredAi)`) — the code comments there
  are explicit that `desiredAi.model` is the pre-override model, while
  `desiredModel` is what gets `syncAuth`'d into the live client.
- `run-settings.ts` (the `keyed` determination) — the resolved post-override
  model sits unused in a local.

Both must ask about **the model the run will actually use** — still no signature
change, just the right argument. But they earn it on *different* compositions,
and an earlier draft of this section gave both the same one, which is wrong in a
way worth correcting rather than quietly deleting: a reason that does not hold
is what gets a fix reverted later by someone who checks it.

- **`run-settings.ts` owns the `bedrock/` → `anthropic/…` case.** A keyless
  Bedrock project whose session overrides to a provider that needs a key would
  otherwise report `AI: on` and then die on an empty key. Asking with the
  post-override model turns the echo to `off (no-key)` — and because
  `session-manager.ts` also ORs in `effective.ai === 'off'`, that single fix
  already makes the executor's `keyless` flag correct too. The session
  manager's own argument makes no difference to this case at all.

- **`session-manager.ts` earns its fix on the mirror image**: a keyless run on a
  provider that *does* need a key, overridden **to** `bedrock/…`. Now the
  resolver says `ai: on` — correctly, the model the run will use supplies its
  own credentials — so the `|| effective.ai === 'off'` clause is false and the
  `aiConfigured` call is the only thing deciding. Handed the pre-override model
  it answers "no key", and the run tells the executor it is keyless while the
  echo tells the reader it is on. Compiled steps would take the heal skip on a
  run that had a working model.

The other four sites are unaffected.

### The framework cannot read the registry today

It imports only `{ AIGateway }` and types, through a hand-maintained ambient
declaration (`src/types/aigateway.d.ts`) that declares no `providers()`. Part B
must add `static providers(): { id, prefix, selfAuthenticating? }[]` there.
That file is a mirror that goes stale silently — an argument for keeping the
declared surface to exactly one field.

### `aiConfigured`'s contract changes, not just its body

Its docblock currently says "Is there a key to make an AI request with?" and
argues the answer is *detected, never declared*. After this change it is partly
declared — by the library. Update the docblock; consider whether the name still
fits.

### The CLI keyless gap — a real hole, with a one-line fix

`ai.allowInRuns` and `runSettings.ai` are server-path only; the `aiui run` CLI
resolves no run settings and computes keyless from `aiConfigured` alone, where
a blank `AI_API_KEY=` is the only switch. For a Mode-2 Bedrock project there is
no key to blank, so **a CI user loses their only way to force a no-AI run** —
in the very scenario this story markets.

Fix it rather than document it: have the CLI runner honour
`ai.allowInRuns === false` alongside its key check. It also retires the
CLI/server inconsistency that forced a doc-scoping fix earlier.

**Not one line, though — two, and the second is the one that bites.** `runTest`
is shared with the compiler: `compileTest` drives it through
`createTestFileRunner`, so a gate added there gates `aiui compile` as well, and
the switch's own documented carve-out ("Compile, repair and errands are
deliberately NOT gated by it; they are requests *for* AI" — `src/config/types.ts`
and the JSON schema) stops being true on the CLI. The failure is total and
silent in the worst direction: `aiui compile` on an `allowInRuns: false` project
refuses every step and writes nothing, on exactly the projects that set the
switch in order to *have* compiled steps to replay.

The server already solved this with a per-request `bypassAiPolicy`
(`session-manager.ts`, `errand-runner.ts`, `compile-runner.ts`). The in-process
path needs the same escape hatch, threaded through `RunTestExtras` the way
compile already threads `codeBehindStrict` and `codeBehindDisabled`, and set by
`createTestFileRunner` — the one caller that IS the request for AI. Deliberately
not a config key or a CLI flag: nothing a test file or a user can set should be
able to lift the project's own switch.

(`src/ui/main/runner-adapter.ts` has no compile path — it drives `executeStep`
directly and never calls `runTest` or `compileTest` — so the same hole does not
exist there.)

## Non-goals

- **Bedrock as a `gateway/` target.** `gateway/` means OpenAI-compatible at
  `AI_GATEWAY_URL`; Bedrock speaks the Anthropic wire with SigV4.
- **Vertex AI and Microsoft Foundry.** Same shape, same `selfAuthenticating`
  mechanism, worth doing when asked — one shipped well beats three half-tested.
- **Inference-profile ARNs** (slash-bearing — see Model ids).
- **Managing AWS credentials.** The SDK's chain resolves them; nothing new goes
  in `.env` beyond a region.
- **Proxy support.** The `NODE_USE_ENV_PROXY` result is unmeasured here. The
  Mantle client is fetch-based, which makes it *more* likely to transfer than
  assumed — but unmeasured stays unclaimed.

## Tests

- **Library:** run the existing anthropic provider suites parameterized over
  both ids — cheaper and stronger than mirroring ~2,300 lines across six files,
  and it is what the `id` parameterization buys. Plus: `selfAuthenticating`
  surfaced by `listProviderEntries()`; **construction with an empty key
  succeeds** for bedrock and still throws `invalid_api_key` for others; prefix
  stripping of all three id forms above. Add the new test file to
  `prepublishOnly` — it is an explicit list, and an omission silently ungates
  the publish.
  **And assert the mode, not just the construction.** "Constructs with an empty
  key" passes whether the client then signs with SigV4 or sends an empty
  `Authorization: Bearer`, and the second is what a whitespace-only key actually
  produced. The two are distinguishable offline: a loopback server sees the
  header, and pinning the AWS example credentials in the environment for the
  duration of one call makes SigV4 sign deterministically without the machine's
  own credential chain entering the suite at all.
- **Framework — the compositions, not the shapes.** `aiConfigured` true for a
  keyless `bedrock/` model, still false for a keyless non-self-authenticating
  one, still true with a key. Then the two traps: a keyless `bedrock/` config
  **combined with a session model override** to a keyed provider must not
  report configured; and `ai: "off"` on a working Bedrock run must still refuse
  and echo `off (policy)`, never `off (no key)`.
- **CLI:** the gate above is server-path-shaped; add one covering the CLI
  runner honouring `allowInRuns` — **on a keyed config**, or it passes for want
  of a key and never reads the switch. Pair it with the carve-out: a compile of
  an `allowInRuns: false` project must still run under AI, driven through
  `createTestFileRunner` rather than by handing `runTest` the bypass flag
  directly. The flag existing and the compile path setting it are two claims,
  and only the join is the bug.
- **Smoke:** `AI_EFFORT` set with a `bedrock/` model — `output_config.effort`
  is always sent and is not documented either way for Bedrock.
- **Live (manual, real AWS account):** one compile and one repair; confirm the
  report shows the Bedrock model id and non-zero usage.

## Rollout

1. `@pkent/aigateway`: publish. **The `gateway/` provider is still unpublished**
   — it exists only in the local `1.4.0-beta.4` while the latest published is
   `1.4.0-beta.3`, and this repo pins `1.4.0-beta.2` exactly. Bedrock lands in
   that same unpublished version, so this step ships both providers.
2. This repo: bump the pin, `npm install` to regenerate the lock, then Part B
   and docs. Rebuild `dist/`, restart the server; no extension bump.

Until step 1, `bedrock/` is an unknown provider and fails loudly at
construction — no egress, no silent fallback.

## Notes for the builder

- **Cache hints are safe** despite looking unsafe: Bedrock rejects automatic
  top-level `cache_control`, but aigateway only ever sets it per content block,
  which is the explicit-breakpoint form Bedrock supports.
- **Error classes are low-risk:** the framework reads `err.message` and never
  does `instanceof` on Anthropic error types. `@anthropic-ai/bedrock-sdk`
  depends on `@anthropic-ai/sdk >=0.115.1 <1` against aigateway's `^0.120.0`, so
  npm should dedupe — confirm after install rather than assume.
- **Unsupported on Bedrock and unused here:** server-side tools, Files API,
  Batches, server-side fallback. Tool use, thinking and structured outputs are
  supported.
- **The inert-pair warning misfires.** A `bedrock/` model with `AI_GATEWAY_URL`
  set advises "Set AI_MODEL=gateway/<model>" — wrong for Bedrock, and this
  audience is unusually likely to have both set. Widen the warning text.

## Open questions

1. **Ship Mode 1 alone first?** Part A delivers bearer-token Bedrock with no
   framework change at all. Recommendation: yes — merge Part A, then Part B.
2. **Does `awsProfile` deserve surfacing?** The client accepts a named SSO
   profile directly; today it works via `AWS_PROFILE` with no code. Probably
   leave it to the environment.
