# Claude on Bedrock — the customer's own AWS account as the AI endpoint

Status: draft — for review
Builds on: the model-prefix routing
([SPEC-aibroker-routing.md](../SPEC-aibroker-routing.md) plus the `gateway/`
alias from [copilot-lm-bridge.md](copilot-lm-bridge.md) Part B), keyless replay
([keyless-replay-and-gateway-env.md](keyless-replay-and-gateway-env.md),
PR #111), and the AI run switch ([run-settings.md](run-settings.md) §9).

## What we're building

A team whose AI is approved only as "Claude in our own AWS account" can point
this framework at it. Their prompts go to Bedrock in their region, under their
existing AWS agreement, over their own network path — commonly a VPC endpoint,
so nothing traverses the public internet. No new vendor to clear, no API key to
issue or rotate, no per-seat quota.

The whole configuration is two lines in a project `.env`:

```
AI_MODEL=bedrock/anthropic.claude-opus-5
AWS_REGION=eu-west-1
```

There is deliberately **no `AI_API_KEY`**. Bedrock authenticates with whatever
AWS credentials the machine already resolves — env vars, `~/.aws/credentials`,
an SSO profile, or an EC2/ECS instance role — which is the credential their
platform team already manages and rotates. That absence is the interesting
part, and §Part B is mostly about making it work.

Contrast with the Copilot bridge, which solved the same corporate problem the
hard way: Copilot has no sanctioned HTTP surface, so it needed a loopback shim,
a consent flow, and a per-seat quota the story had to design around. Bedrock is
first-class inference — no bridge, no editor, works headless and in CI.

## Part A — the `bedrock` provider (`@pkent/aigateway`)

### The provider

`AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk` exposes the same
`messages.create` / `.stream` surface as the first-party `Anthropic` client
once constructed. That makes this a **constructor swap, not a new
translation**: in [anthropic.js](../node_modules/@pkent/aigateway/src/providers/anthropic.js)
exactly one line is client-specific —

```js
const anthropic = client || new Anthropic({ apiKey, ...(baseURL && { baseURL }) });
```

— and the other ~213 lines (`buildRequest`, `normalize`,
`normalizeContentBlocks`, `extractAnthropicUsage`, the stream translation) are
reached through `anthropic.messages.create(...)` and apply unchanged.

So: factor `createProvider` to take the constructed client, and register a
`bedrock` entry that builds `new AnthropicBedrockMantle({ awsRegion })` instead.
Prefer refactoring over cloning here — unlike the `gateway`/`aibroker` pair
(two 24-line files with no shared logic), this would duplicate 200 lines of
message translation that must not drift.

Use the **Mantle** client specifically. `AnthropicBedrock` without `Mantle` is
the legacy `bedrock-runtime` InvokeModel path; Mantle is the Messages-API
endpoint and is what new code should use.

### Model ids

Bedrock's own ids carry an `anthropic.` prefix — and it is a **dot**, not a
slash, so the existing generic `stripProviderPrefix` (first `/`, `slice`) does
the right thing with no special case:

```
bedrock/anthropic.claude-opus-5   →  forwards  anthropic.claude-opus-5
```

### Region

`awsRegion` is a required constructor argument. Resolution order: an explicit
provider option, else `AWS_REGION`, else `AWS_DEFAULT_REGION`. If none
resolves, throw an `AIGatewayError` naming `AWS_REGION` at construction — the
same shape as `aibroker`'s `missing_base_url`, and for the same reason: fail
loudly at config time rather than with an opaque SDK error mid-run.

### Declaring that this provider needs no API key

Registry entries today are `{ id, prefix, matches, create }`, and
`listProviderEntries()` maps them to `{ id, prefix }`. Add a
`selfAuthenticating: true` field on the bedrock entry and surface it through
`listProviderEntries()`.

This exists so the **framework can ask the library** rather than hardcoding a
prefix list of its own (Part B). A second source of truth for "which providers
need a key" would merge cleanly and then drift silently the next time a
provider is added — the failure mode this repo has been bitten by before.

## Part B — the framework: "configured" without a key

### The problem

[`aiConfigured`](../src/config/loader.ts) is, in full:

```ts
export function aiConfigured(ai: AiConfig): boolean {
  return (ai.apiKey ?? '').trim() !== '';
}
```

A correctly configured Bedrock user has no `AI_API_KEY`, so today they read as
**keyless**: every AI call is refused before reaching the provider, compile and
repair fail with "AI is not configured", and the run reports `AI: off (no
key)`. The framework would be telling them to set a key that Bedrock has no use
for.

### The fix, and why it is cheap

`aiConfigured` already receives the whole `AiConfig`, which carries `model`
alongside `apiKey`. So the predicate can become model-aware **without changing
its signature** — and therefore without touching any of its six call sites
([client.ts:309](../src/ai/client.ts), [run-settings.ts:290](../src/config/run-settings.ts),
[test-runner.ts:311](../src/runner/test-runner.ts),
[session-manager.ts:2579](../src/server/session-manager.ts), and two in
[runner-adapter.ts](../src/ui/main/runner-adapter.ts)):

> AI is configured when the key is non-empty, **or** the model routes to a
> provider the library reports as `selfAuthenticating`.

Every keyless behavior downstream — the heal fall-through skip, the diagnosis
skip, the typed refusal, the `ai: off` policy veil — is untouched, because they
all consume this one predicate.

### The collision with the blank-key pin, and its resolution

Blank `AI_API_KEY=` currently means two things at once: "Bedrock needs no key"
and "this project deliberately forces keyless" (the machine-floor block from
PR #111). Under the new rule a `bedrock/` project with a blank key is
*configured*, so the second meaning is lost for exactly those users.

That is acceptable, and the reason is that §9 already replaced the hack: the
supported way to force a no-AI run is now `runSettings.ai: "off"` or
`ai.allowInRuns: false` — stated policy rather than credential accident, which
was the whole argument for building the switch. The two features compose here
rather than conflict. The docs must say so plainly, because a Bedrock user who
learned the blank-key trick will otherwise be surprised.

### Reporting

`aiOffReason` gains no new value: a Bedrock run that is off is off by policy,
and a Bedrock run with unresolvable AWS credentials is not "no key" — it is a
provider error at call time, with the AWS SDK's own message. Resist mapping it
onto `no-key`; the two failures want different remedies.

## Non-goals

- **Bedrock as a `gateway/` target.** `gateway/` means "OpenAI-compatible
  endpoint at `AI_GATEWAY_URL`"; Bedrock speaks the Anthropic wire with SigV4
  auth. It gets its own prefix precisely so the spelling stays honest.
- **Vertex AI and Microsoft Foundry.** The same shape (`AnthropicVertex`,
  `AnthropicFoundry`, one provider each, same `selfAuthenticating` mechanism)
  and worth doing when a customer asks — but each carries its own auth and
  region story, and shipping one well beats three half-tested.
- **Managing AWS credentials.** The framework never reads, stores, or forwards
  them; the SDK's default chain resolves them. Nothing new goes in `.env`
  beyond a region.
- **Proxy support for Bedrock.** The `NODE_USE_ENV_PROXY` result measured for
  `fetch`/undici does **not** transfer — the AWS SDK uses its own HTTP handler.
  Whether a corporate proxy needs separate configuration here is unmeasured and
  should not be claimed either way until someone tests it.
- **Bedrock inference profiles / cross-region ids.** If a customer needs
  `eu.anthropic.…`-style profile ids, they already work as opaque model
  strings; nothing to build unless they don't.

## Tests

- **Library:** mirror the `anthropic` provider suite against a fake client
  (request shape, normalization, streaming, usage) to prove the refactor left
  the translation identical; plus construction — region resolution order, the
  missing-region throw, `selfAuthenticating` surfaced by
  `listProviderEntries()`, and prefix stripping of
  `bedrock/anthropic.claude-opus-5`.
- **Framework:** `aiConfigured` true for a `bedrock/` model with no key, still
  false for a non-self-authenticating model with no key, still true for any
  model with a key. Then the composition — the standing lesson from
  [feedback on testing guards](../CLAUDE.md): assert the *combined* case, not
  the declined shape alone. A keyless-by-`bedrock` run must actually compile
  (no refusal), while `ai: "off"` on that same run must still refuse, and the
  echo must say `off (policy)`, never `off (no key)`.
- **Live (manual, needs a real AWS account):** one compile and one repair
  against Bedrock in a real region; confirm the run report shows the Bedrock
  model id and non-zero token usage.

## Rollout

Two repos, in order — the same sequencing trap as the `gateway/` work, where
the framework's exact pin meant a published library still wasn't installed:

1. `@pkent/aigateway`: the provider + the `selfAuthenticating` field, version
   bumped and **published**.
2. This repo: bump the `@pkent/aigateway` pin, `npm install` to regenerate the
   lock, then the `aiConfigured` change and docs. Rebuild `dist/` and restart
   the server; no extension bump (framework-only).

Until step 1 lands, `bedrock/` is an unknown provider and fails loudly at
construction — no egress, no silent fallback.

## Open questions

1. **Does the framework ask the library, or does the library's error suffice?**
   Part A/B propose `selfAuthenticating` surfaced through
   `listProviderEntries()`. The lighter alternative is for the framework to
   attempt the call and let the provider throw — no new library field, but the
   keyless machinery then can't tell "no AI here" from "AI failed", which is
   exactly the distinction PR #111 exists to preserve. Recommendation: keep the
   declared field.
2. **Region in `.env` vs `aiui.config.json`.** `AWS_REGION` is the AWS-native
   spelling and works with zero framework code; a config field would be more
   discoverable and per-project. Recommendation: `AWS_REGION` only, revisit if
   someone needs two projects on one machine in different regions.
3. **Do we advertise Vertex/Foundry as "coming" in the docs**, or stay silent
   until one is asked for?
