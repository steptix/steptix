# Spec: model-prefix routing — `aibroker/` provider + AiClient on `@pkent/aigateway`

Status: ready for review
Spans two repos: **`@pkent/aigateway`** (new `aibroker` provider) and
**steptix** (`AiClient` rework). aiapi is **unchanged**.

---

## 1. Goal

Make routing **driven by the `AI_MODEL` string prefix**, with **one** key
(`AI_API_KEY`) passed straight through as the Bearer for wherever the model
resolves — exactly like configuring an OpenAI client:

| `AI_MODEL` | Routes to | Upstream sees | `AI_API_KEY` is |
|---|---|---|---|
| `openai/chatgpt-5.5` | **OpenAI directly** (BYOK) | `chatgpt-5.5` | the user's OpenAI key |
| `aibroker/openai/chatgpt-5.5` | the **gateway** (`llm.corp.example`) | `openai/chatgpt-5.5` | the gateway token |
| `aibroker/openrouter/openai/chatgpt-5.5` | the **gateway** → OpenRouter | `openrouter/openai/chatgpt-5.5` | the gateway token |

`aibroker/` means "go through the gateway"; everything after it is the gateway's
own model id. The key only authenticates to wherever the model routes — for the
gateway path it authenticates **to the gateway**, which then uses its **own**
downstream provider keys (it is NOT forwarded to OpenAI).

This replaces the per-config-flag idea: there is **no `ai.routing` flag** — the
model string is the single source of truth.

---

## 2. Cross-repo map

| Repo | Change |
|---|---|
| **`@pkent/aigateway`** | Add an `aibroker` provider (an OpenAI-compatible provider that **requires** a `baseURL` — no hardcoded URL). Register it. Tests + README + version bump 1.1.0 → **1.2.0**. Publish (user). |
| **steptix** | Rework `AiClient` to route **all** calls through `@pkent/aigateway` (replacing the direct `openai` SDK from #9). The model prefix drives routing; the consumer supplies the gateway `baseURL` only for `aibroker/` models. |
| **aiapi** | **None.** It already authenticates via Bearer like OpenAI; the `aibroker` provider sends `Bearer <AI_API_KEY>` to `/v1/chat/completions`, which it already validates. |

---

## PART A — `@pkent/aigateway`: the `aibroker` provider

### A.1 The provider (NEW `src/providers/aibroker.js`)

A meta-provider in the same shape as `openrouter` — but it forwards to *any*
gateway you point it at, and **requires** a `baseURL` (so the library embeds no
host):

```js
import { createOpenAICompatibleProvider } from './openaiCompatible.js';
import { AIGatewayError } from '../errors.js';

// "aibroker/<provider>/<model>" routes to an OpenAI-compatible gateway. The
// "aibroker/" segment is stripped (existing stripProviderPrefix) and the rest is
// forwarded verbatim as the model — the gateway does its own routing. The
// caller MUST supply the gateway URL via options.baseURL; there is no default.
export default {
  id: 'aibroker',
  prefix: 'aibroker/',
  matches: model => typeof model === 'string' && model.startsWith('aibroker/'),
  create({ apiKey, baseURL, client }) {
    if (!client && !baseURL) {
      throw new AIGatewayError(
        'The "aibroker" provider requires a baseURL (the gateway URL), e.g. ' +
          'new AIGateway(model, key, { baseURL: "https://your-gateway/v1" })',
        { code: 'missing_base_url' },
      );
    }
    return createOpenAICompatibleProvider({ id: 'aibroker', apiKey, baseURL, client });
  },
};
```

Why this works with **zero** other library changes:
- `AIGateway`'s constructor already destructures `options.baseURL` and passes it
  to `entry.create({ apiKey, baseURL, … })` ([AIGateway.js:30,38](../../../aigateway/src/AIGateway.js#L30)).
- `createOpenAICompatibleProvider` already builds an OpenAI client at `baseURL`
  and **strips the first segment** via `stripProviderPrefix` before the upstream
  call — which produces exactly the forwarded id we want:
  - `aibroker/openai/chatgpt-5.5` → `openai/chatgpt-5.5` → gateway
  - `aibroker/openrouter/openai/chatgpt-5.5` → `openrouter/openai/chatgpt-5.5` → gateway
- The response `normalize()` echoes `model = <the full input>` (e.g.
  `aibroker/openai/chatgpt-5.5`), consistent with how `openrouter/…` echoes its
  full id.

### A.2 Register it (`src/providers/registry.js`)

```js
import aibroker from './aibroker.js';
// …
const ENTRIES = [openrouter, anthropic, qwen, glm, openai, aibroker];
```
(Prefixes are disjoint, so order is irrelevant.)

### A.3 Tests (`test/aibroker.test.js`, offline — injected fake client)

Follow the existing `test/aigateway.test.js` pattern (`fakeOpenAIClient({ capture })`):
- **Resolution:** `new AIGateway('aibroker/openai/x', 'k', { client: fake }).provider === 'aibroker'`.
- **Requires baseURL:** `new AIGateway('aibroker/openai/x', 'k')` (no `baseURL`, no `client`)
  throws `AIGatewayError` `code: 'missing_base_url'`. With `{ baseURL }` or `{ client }` it constructs.
  (Pass a valid key `'k'` — the constructor validates the key BEFORE calling the provider's
  `create`, so an empty key would throw `invalid_api_key` first.)
- **Forwards the stripped id:** with a capturing fake client,
  `aibroker/openai/chatgpt-5.5` → `capture.req.model === 'openai/chatgpt-5.5'`.
- **Nested:** `aibroker/openrouter/openai/chatgpt-5.5` → `capture.req.model === 'openrouter/openai/chatgpt-5.5'`.
- **v2 shape + echoed model:** `chat()` returns the v2 envelope with
  `provider: 'aibroker'`, `model: 'aibroker/openai/chatgpt-5.5'` (the full input),
  and usage normalized to `input_tokens`/`output_tokens`.
- **Streaming** yields `text_delta`s and `.final` resolves the v2 envelope.

### A.4 README + version

- README: add `aibroker` to the routing table / providers list — note it's a
  gateway meta-provider that **requires** `baseURL` (no default) and forwards the
  remainder verbatim.
- `package.json`: bump `1.1.0` → **`1.2.0`**; add `test/aibroker.test.js` to the
  `prepublishOnly` script's file list.
- **Publish** `@pkent/aigateway@1.2.0` to npm (user action — see §C).

---

## PART B — Steptix: `AiClient` rework

Rework `AiClient` ([src/ai/client.ts](../../src/ai/client.ts)) to route **all** calls
through `@pkent/aigateway` instead of the direct `openai` SDK. The public
interface is unchanged (`constructor(config.ai, tokenTracker)`,
`complete(messages, signal?)`, `syncAuth(model, apiKey)`) → no call-site changes.

### B.1 Construction (model-prefix-aware baseURL)

The gateway is built from `model` + `apiKey`, supplying `baseURL` **only** for
`aibroker/` models (do NOT pass it for direct models, or the OpenAI/OpenRouter
client would point at the gateway):

```ts
private buildGateway(): AIGateway {
  const opts = this.config.model.startsWith('aibroker/')
    ? { baseURL: `${this.config.gatewayUrl.replace(/\/+$/, '')}/v1` }
    : {};
  return new AIGateway(this.config.model, this.config.apiKey ?? '', opts);
}
```

**Build lazily + memoized** (do NOT build in the constructor):
`new AIGateway(...)` throws `invalid_api_key` on an empty key and binds the
model at construction. Building lazily preserves the current "construct
succeeds; fail at request time" behavior and means a `syncAuth` model/key change
just invalidates the cached instance:

```ts
private gateway: AIGateway | null = null;
private getGateway(): AIGateway { return (this.gateway ??= this.buildGateway()); }
```

### B.2 `complete()` — non-streaming

```ts
const v2 = await this.getGateway().chat(messages, {        // messages passed through as-is
  maxTokens: 4096,
  responseFormat: { type: 'json_object' },
  signal: this.buildSignal(signal),
});
const text = textFromV2(v2.content);                       // join type:'text' blocks
if (v2.usage) {
  this.tokenTracker.addUsage(v2.usage.input_tokens, v2.usage.output_tokens);  // v2 field names!
  this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
}
if (!text) throw new Error('AI response contained no content');
return { text, model: v2.model ?? this.config.model };
```

- **Messages pass through unchanged** — `@pkent/aigateway` accepts the consumer's
  `ChatMessage` shape (string or `text`/`image_url` blocks) and handles `cache`
  hints itself (maps to `cache_control` for anthropic, strips for
  OpenAI-compatible). So **delete `toOpenAIMessages`** — no cache-stripping here.
- **Usage uses v2 field names** `input_tokens`/`output_tokens` (NOT
  `prompt_tokens` — the library normalizes to the v2 envelope). This reverts the
  #9 mapping.
- `textFromV2(content) = content.filter(b => b.type === 'text').map(b => b.text).join('')`.

### B.3 `complete()` — streaming

```ts
const s = this.getGateway().stream(messages, {
  maxTokens: 4096, responseFormat: { type: 'json_object' }, signal: this.buildSignal(signal),
});
let text = '';
for await (const delta of s) text += delta.text;           // {type:'text_delta', text}
const final = await s.final;                                // full v2 envelope
const model = final.model ?? this.config.model;
if (final.usage && (final.usage.input_tokens || final.usage.output_tokens)) {
  this.tokenTracker.addUsage(final.usage.input_tokens, final.usage.output_tokens);
  this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
} else {
  this.tokenTracker.addUsage(0, Math.ceil(text.length / 4));  // estimate fallback, as today
}
if (!text) throw new Error('AI stream produced no content');
return { text, model };
```

> **Behavior note — the `model` field changes meaning (minor, accepted).**
> `@pkent/aigateway` echoes the *bound* model id (e.g. `aibroker/openai/chatgpt-5.5`)
> — it discards the upstream response's `model` field. So `CompleteResult.model`
> is now always the configured `AI_MODEL`, whereas #9 surfaced the gateway's
> *returned* model (`res.model`/`chunk.model`). In practice the gateway already
> echoes the input, so the visible value is usually identical — but: (a) the
> existing test that mocks a *different* served model (`ai-client.test.ts`,
> `result.model === 'claude-sonnet-4-5'`) must be updated to expect the bound id,
> and (b) HTML reports will show the configured `<provider>/<model>` id. The
> `?? this.config.model` fallback is therefore defensive-only (model is never absent).

### B.4 `syncAuth` — rebuild on model OR key change

Unlike #9 (where model was per-request), `@pkent/aigateway` binds **model** at
construction AND the `baseURL` choice depends on the model prefix. So a model
change OR a key change must invalidate the cached gateway:

```ts
syncAuth(model, apiKey): string | null {
  const changes = [];
  if (model !== this.config.model) { changes.push(`AI model ${this.config.model} → ${model}`); this.config.model = model; }
  if (apiKey !== this.config.apiKey) {
    changes.push('AI API key changed');
    if (apiKey === undefined) delete this.config.apiKey; else this.config.apiKey = apiKey;
  }
  if (changes.length) this.gateway = null;   // rebuild on next getGateway()
  return changes.length ? changes.join('; ') : null;
}
```
Preserve: never leak the key value; keep the delete-vs-assign for `exactOptionalPropertyTypes`.

### B.5 Preserve (unchanged from #9)
- **`buildSignal`** — exact `AbortSignal.any([AbortSignal.timeout(120_000), runSignal])`.
  Passed as the `signal` call-option to `chat`/`stream` (the library forwards it
  to the SDK — cancellation work already wired this).
- **Trace logging §** — keep `summarizeMessagesForTrace` + `ai.request#N` /
  `ai.response#N` (success + error variants) + the `logger.debug` line (feeds
  `serverFileLogLevel:'full'`). The `url` field can drop or reflect the route
  (e.g. `aibroker→gateway` vs `direct:<provider>`); the **AI request/response
  blocks must remain**, image-stripped. The `ai.response` `usage` now logs the v2
  shape (`input_tokens`/`output_tokens`) — fine; just keep the blocks present.
- Public interface, `CompleteResult`, the empty-content throw.

### B.6 Deps & types
- **`package.json`**: add `@pkent/aigateway` (`^1.2.0`); **remove `openai`** (no
  longer imported directly — it becomes transitive via `@pkent/aigateway`).
- **Types:** `@pkent/aigateway` ships **no TypeScript types** (plain JS). Add a
  local ambient declaration in steptix (e.g.
  `src/types/aigateway.d.ts`) for the surface used: the `AIGateway` class
  (`constructor(model, key, options?)`, `chat(messages, opts?): Promise<V2Response>`,
  `stream(messages, opts?): AsyncIterable<{type:'text_delta',text}> & { final: Promise<V2Response> }`)
  where `V2Response = { model?: string; content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number; total_tokens?: number } }`
  (note `usage` is **optional** — absent on the stream estimate-fallback path).
  Keep it minimal — just what `AiClient` calls.

---

## C. Dependency & sequencing (between the two parts)

`@pkent/aigateway` is consumed from **npm** (aiapi uses `^1.1.0` from the
registry). So the `aibroker` provider must exist in a published version before
steptix can depend on it in production.

1. **Implement + review Part A**, bump to 1.2.0.
2. **User publishes `@pkent/aigateway@1.2.0`** to npm (like the aiapi deploy — a
   human step).
3. **Implement + review Part B.**

⚠ **Install ordering:** `npm install`/CI cannot *resolve* `@pkent/aigateway@^1.2.0`
until it's published — `vi.mock('@pkent/aigateway')` stops the real module from
being *imported* at test time, but not from being *installed*. So:
- During Part B development (pre-publish), use a **`file:../aigateway` link** in
  `package.json` so it installs and the live check runs against the local
  `aibroker` provider.
- **Switch to `^1.2.0` only after the publish (step 2)** — that's the form that
  ships in the merged PR.

---

## D. Tests & verification

**Part A (`@pkent/aigateway`):** `node --test`, offline (§A.3). All existing
tests still pass.

**Part B (steptix, vitest):** rewrite `tests/ai-client.test.ts` to
`vi.mock('@pkent/aigateway')` (was mocking `openai`). Assert:
- `chat`/`stream` called with the passed-through `messages` (no cache-strip), `maxTokens: 4096`,
  `responseFormat`, and the composite `signal`.
- map-back to `{ text, model }` from the v2 envelope; `tokenTracker.addUsage(input_tokens, output_tokens)`.
- streaming assembles text + `.final` usage; estimate fallback when usage absent.
- **construction:** an `aibroker/…` model builds the gateway with `{ baseURL: gatewayUrl + '/v1' }`;
  a direct `openai/…` model builds it with **no** baseURL.
- `syncAuth`: model change AND key change each invalidate/rebuild the gateway; key never leaked.
- `buildSignal` timeout-only vs `AbortSignal.any`.
- **Invert the prior `syncAuth` test:** #9 asserts a model change does NOT rebuild
  (per-request); the rework rebuilds on a model change — flip that assertion.
- **Update the `model` assertion:** the test that mocked a different served model
  must now expect the bound `<provider>/<model>` id (see the §B.3 behavior note).
- Run with `--pool=threads` if the default vitest pool is crashing (known env issue).

**Live check (Part B, against the deployed gateway):** with the real
`@pkent/aigateway@1.2.0` (or local link) installed, drive the real `AiClient`:
- `AI_MODEL=aibroker/openrouter/gemini-3-flash-preview:nitro` + the gateway token →
  `complete()` (non-stream + stream) returns real text. (Direct-provider BYOK is
  harder to live-test without a real provider key; the `aibroker/` path is the one
  that matters for this app.)

---

## E. Definition of done

**Part A**
- [ ] `aibroker` provider added + registered; requires `baseURL` (throws `missing_base_url`).
- [ ] Forwards the stripped remainder (`aibroker/openai/x` → `openai/x`; nested too).
- [ ] Tests pass; README updated; version `1.2.0`; no other library code changed.

**Part B**
- [ ] `AiClient` routes via `@pkent/aigateway`; public interface unchanged → no call-site changes.
- [ ] Model prefix drives routing; `baseURL` supplied only for `aibroker/`; one `AI_API_KEY` passed through.
- [ ] v2 → `{text, model}`; usage from `input_tokens`/`output_tokens`; messages passed through (no cache-strip).
- [ ] Instant-stop + 120s timeout preserved; trace logs preserved; `syncAuth` rebuilds on model/key change.
- [ ] `openai` dep removed, `@pkent/aigateway` added; local `.d.ts` for the lib.
- [ ] vitest suite green (mock `@pkent/aigateway`); live `aibroker/` round-trip verified.

## F. Out of scope
- aiapi changes (none).
- Per-user gateway keys / forwarding the caller's key upstream (the gateway uses its own provider keys).
- Tool calling.
