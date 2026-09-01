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

Left alone, a `bedrock/` project whose session overrides the model to
`anthropic/…` reports `AI: on`, then dies with an empty key. Both sites must
ask about **the model the run will actually use** — still no signature change,
just the right argument.

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
`ai.allowInRuns === false` alongside its key check. One line, and it also
retires the CLI/server inconsistency that forced a doc-scoping fix earlier.

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
- **Framework — the compositions, not the shapes.** `aiConfigured` true for a
  keyless `bedrock/` model, still false for a keyless non-self-authenticating
  one, still true with a key. Then the two traps: a keyless `bedrock/` config
  **combined with a session model override** to a keyed provider must not
  report configured; and `ai: "off"` on a working Bedrock run must still refuse
  and echo `off (policy)`, never `off (no key)`.
- **CLI:** the gate above is server-path-shaped; add one covering the CLI
  runner honouring `allowInRuns`.
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
