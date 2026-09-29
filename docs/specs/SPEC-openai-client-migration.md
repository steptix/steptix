# Spec: migrate `AiClient` off `/v2` onto the OpenAI protocol

Status: ready for review
Primary project: **steptix**
Depends on: **aiapi PR #2 (native `/v1/chat/completions`) merged AND deployed** (§9)
Touches: steptix only — `@pkent/aigateway` and aiapi are NOT modified.

---

## 1. Goal

Replace the bespoke `/v2/vision` + `/v2/stream` fetch client in
[src/ai/client.ts](../../src/ai/client.ts) with the standard **`openai` SDK** pointed
at the gateway's new `/v1` surface — while preserving the `AiClient` public
interface so **no call site changes**.

Scope:
- **Phase 1 (this spec — required):** gateway mode. `AiClient` talks to the aiapi
  gateway via the `openai` SDK (`baseURL = …/v1`). This is what the current
  deployment uses (it holds a gateway token, no provider keys).
- **Phase 2 (documented, optional follow-up — §8):** BYOK mode. Route directly
  to providers via `@pkent/aigateway` with the user's own key. Architected here,
  built later; **not required to land Phase 1.**

This is deliberately split so the transport swap ships small and low-risk; BYOK
(the user's "bring your own keys" goal) is a clean additive second mode.

---

## 2. Preserve the public interface (no call-site churn)

`AiClient`'s surface is unchanged:
- `new AiClient(config.ai, tokenTracker)`
- `complete(messages: ChatMessage[], signal?: AbortSignal): Promise<CompleteResult>` where `CompleteResult = { text, model }`
- `syncAuth(model: string, apiKey: string | undefined): string | null`

The 4 construction sites ([test-runner.ts:174](../../src/runner/test-runner.ts#L174),
[session-manager.ts:1166](../../src/server/session-manager.ts#L1166),
[runner-adapter.ts:303](../../src/ui/main/runner-adapter.ts#L303),
[scripts/diag-wait-ai.ts:62](../../scripts/diag-wait-ai.ts#L62)), the `complete()`
callers ([step-executor.ts:615](../../src/runner/step-executor.ts#L615) etc.,
[diagnose.ts:64](../../src/ai/diagnose.ts#L64)), and the single `syncAuth` caller
([session-manager.ts:1243](../../src/server/session-manager.ts#L1243)) all stay as-is.
**Do not change the constructor signature** (this rules out adding an injected
client as a constructor param — see §7 for the test seam).

---

## 3. Phase 1 — gateway mode via the `openai` SDK

### 3.1 Config (unchanged in Phase 1)
`AiConfig` is untouched. Meaning in gateway mode:
- `gatewayUrl` → the `openai` client's `baseURL` is `` `${gatewayUrl}/v1` ``.
- `apiKey` → the gateway Bearer token (the `openai` client's `apiKey`).
- `model` → the fully-qualified `<provider>/<model>` sent verbatim as `model`.
- `streamResponses` → picks `chat.completions.create` with/without `stream:true`.
- `maxInputTokens` → still drives `tokenTracker.checkStepBudget(...)`.

### 3.2 Client construction
```ts
import OpenAI from 'openai';

private buildClient(): OpenAI {
  return new OpenAI({
    baseURL: `${this.config.gatewayUrl.replace(/\/+$/, '')}/v1`,
    apiKey: this.config.apiKey ?? '',
    maxRetries: 0,   // match the old fetch client: no auto-retry (avoids dup calls / surprise latency)
  });
}
```
Build once in the constructor; rebuild on a key change in `syncAuth` (§3.6).

### 3.3 `complete()` dispatch (unchanged shape)
```ts
async complete(messages, signal?) {
  return this.config.streamResponses
    ? this.completeStream(messages, signal)
    : this.completeOnce(messages, signal);
}
```

### 3.4 Non-streaming — `completeOnce`
```ts
const res = await this.client.chat.completions.create({
  model: this.config.model,
  messages: toOpenAIMessages(messages),
  max_completion_tokens: 4096,
  response_format: { type: 'json_object' },
}, { signal: this.buildSignal(signal) });

const text = res.choices[0]?.message?.content ?? '';
if (res.usage) {
  this.tokenTracker.addUsage(res.usage.prompt_tokens, res.usage.completion_tokens);
  this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
}
if (!text) throw new Error('AI response contained no content');
return { text, model: res.model ?? this.config.model };
```

### 3.5 Streaming — `completeStream`
```ts
const stream = await this.client.chat.completions.create({
  model: this.config.model,
  messages: toOpenAIMessages(messages),
  max_completion_tokens: 4096,
  response_format: { type: 'json_object' },
  stream: true,
  stream_options: { include_usage: true },
}, { signal: this.buildSignal(signal) });

let text = '', model = this.config.model, pt = 0, ct = 0;
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) text += delta;
  if (chunk.model) model = chunk.model;
  if (chunk.usage) { pt = chunk.usage.prompt_tokens; ct = chunk.usage.completion_tokens; }
}
if (pt || ct) { this.tokenTracker.addUsage(pt, ct); this.tokenTracker.checkStepBudget(this.config.maxInputTokens); }
else { this.tokenTracker.addUsage(0, Math.ceil(text.length / 4)); }  // estimate fallback, as today
if (!text) throw new Error('AI stream produced no content');
return { text, model };
```

### 3.6 Helpers

**`buildSignal(runSignal?)`** — preserve the exact cancellation + 120s timeout
semantics from the current [client.ts:359-362](../../src/ai/client.ts#L359-L362):
```ts
private buildSignal(runSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(120_000);
  return runSignal ? AbortSignal.any([timeout, runSignal]) : timeout;
}
```

**`toOpenAIMessages(messages)`** — the consumer's `ChatMessage` is already
OpenAI-shaped (`role` + `content` string | array of `{type:'text',text}` /
`{type:'image_url',image_url:{url}}`). The only transform: **strip the `cache`
hint** from content blocks (OpenAI's content-part types don't include it, and the
gateway does no caching, so it's a no-op anyway). A bare `string` content passes
through untouched.
- Type note: the SDK's `ChatCompletionMessageParam` is a narrower role-discriminated
  union (e.g. `role:'tool'` requires `tool_call_id`; `system`/`tool` content is
  text-only). The consumer never emits `role:'tool'` and system content is text-only
  blocks, so a `cache`-stripped `ChatMessage[]` is value-compatible — type the
  mapper's return as `ChatCompletionMessageParam[]` with a narrowing cast where the
  compiler needs it (don't widen the public `ChatMessage` type to satisfy the SDK).

### 3.7 `syncAuth(model, apiKey)`
Same contract (returns a key-safe change description or `null`). Internally:
- `model` change → update `this.config.model` (applied per request via the
  `model` field — no rebuild needed).
- `apiKey` change → update `this.config.apiKey` and **rebuild the `openai`
  client** (the key is bound at construction). Mirror the existing
  delete-vs-assign handling for `exactOptionalPropertyTypes`
  ([client.ts:69-84](../../src/ai/client.ts#L69-L84)).
- Never include the key value in the returned string.

### 3.8 `response_format` note
Always sending `{ type: 'json_object' }` matches today's behavior
([client.ts:111](../../src/ai/client.ts#L111)). The gateway forwards it to
OpenAI-compatible providers; for a direct `anthropic/*` model the library ignores
it (the prompt already instructs JSON). No behavior change vs today.

### 3.9 Logging — preserve the AI request/response traces (do NOT drop)
The current client emits `logger.debug('POST <url> …')` and two structured traces
per call — `logger.trace('ai.request#N', {…})` and `logger.trace('ai.response#N', {…})`
([client.ts:114-122,151-158](../../src/ai/client.ts#L114-L158)) — using
`summarizeMessagesForTrace` ([client.ts:24-38](../../src/ai/client.ts#L24-L38)) to strip
image base64 from the dump. **These are load-bearing:** `run-log.ts` subscribes via
`addTraceCallback` and writes each `ai.request`/`ai.response` trace into the per-run
log file — this IS the `serverFileLogLevel: 'full'` feature
([config/types.ts:230-232](../../src/config/types.ts#L230-L232)). Dropping them silently
regresses `full`-mode run logs.

Port them into the new methods (both modes): keep `summarizeMessagesForTrace`;
before the SDK call emit `ai.request#N` `{ url: `${baseURL}/chat/completions`, model,
messageCount, streaming, messages: summarizeMessagesForTrace(messages) }`; after a
success emit `ai.response#N` `{ model, usage, content }`, and on failure the error
variant `{ ok: false, body: <error message> }`. Keep the `logger.debug` POST line.

---

## 4. Dependencies

- **Add** `openai` (`^6`) to `package.json` dependencies.
- **Remove** `eventsource-parser` **only if** nothing else in the repo imports it
  after `client.ts` stops doing so. Verify first: `grep -rl eventsource-parser src`
  (note `runner-core/` has its own `sse-parser.ts`; the api-server's own SSE may
  also use it). Remove from deps only if the grep comes back empty in `src/`.

`AiClient` is server-side and **not** bundled into the steptix VSIXes (verified:
no `ai/client` import under `runner-core/` or `steptix-*/`), so the `openai` dep
does not affect extension size. It is pulled into the CLI/server and the Tauri
(Flick) Node side.

---

## 5. Dead-code removal

In [src/ai/types.ts](../../src/ai/types.ts), the `/v2` wire types become unused once
the fetch client is gone. **Remove only after a grep confirms each is unreferenced:**
`VisionRequest`, `VisionResponse`, `LegacyVisionResponse`, `StreamEvent`,
`StreamResponseEnvelope`, `LegacyStreamChunk`, `ResponseContentBlock`. **Keep**
`ChatMessage`, `MessageContentBlock`, and the `AIAction`/`AIResponse` domain types.
Notes: `CompleteResult` lives in `client.ts` ([client.ts:41](../../src/ai/client.ts#L41)),
not `types.ts` — it stays as the rewritten client's export. `TokenUsage`
([types.ts:240](../../src/ai/types.ts#L240)) is referenced ONLY by the `/v2` response
types being removed, so it becomes removable too — drop it once those are gone.
Do not remove anything still imported elsewhere.

---

## 6. Tests (vitest)

Rewrite [tests/ai-client.test.ts](../../tests/ai-client.test.ts) — today it mocks
`global.fetch` and asserts `/v2/vision`/`/v2/stream` URLs, which no longer exist.

- **Mock the `openai` module** with `vi.mock('openai', …)` returning a fake whose
  `chat.completions.create` is a `vi.fn()` (returning a `chat.completion` object,
  or an async-iterable of chunks when `stream:true`). Assert the AiClient builds
  the right request: `model`, `messages` (cache stripped), `max_completion_tokens:
  4096`, `response_format`, and that `signal` is forwarded.
- **Map-back assertions:** `complete()` returns `{ text, model }` from
  `choices[0].message.content` / `res.model`; `tokenTracker.addUsage` is called
  with `prompt_tokens`/`completion_tokens` (NOT v2 `input_tokens`).
- **Streaming:** chunks assemble into the full text; usage from the final chunk.
- **`buildSignal`:** a `complete()` with no signal still passes an
  `AbortSignal.timeout`; with a run signal, an `AbortSignal.any` combining both.
- **Cache strip:** a message with `cache:true` blocks reaches the SDK with `cache`
  removed.
- **Keep the `syncAuth` tests:** model swap reflected on the next request; key swap
  not leaked into the change string; **add** that a key swap rebuilds the client.
- Follow the "test the minimum scenario" discipline — don't prime inputs that hide
  the empty-content / no-usage paths.

Live integration tests (per the run-live-integration-tests notes) must wait on §9.

---

## 7. Phase 2 (optional follow-up) — BYOK via `@pkent/aigateway`

Not required to land Phase 1; documented so Phase 1 keeps a clean seam.

- **Add** `@pkent/aigateway` (`^1.1.0`) dependency.
- **New config** `ai.routing?: 'gateway' | 'direct'` (default `'gateway'`). Adding
  a config field means threading it through `config/types.ts`, `config/defaults.ts`,
  the generated JSON schema, the init template, AND — per the
  "thread new config to the server bundle" rule — `resolveProjectBundle` /
  session-creation, or per-project values are silently ignored on the server path.
- **`direct` mode:** `apiKey` is the provider key; build `new AIGateway(model,
  apiKey)`; `complete` → `gateway.chat(messages, { maxTokens: 4096, responseFormat:
  { type: 'json_object' }, signal: buildSignal(signal) })`; streaming →
  `gateway.stream(...)` then `await stream.final`. Messages pass through **as-is**
  (aigateway accepts the same `ChatMessage` shape incl. `image_url` and `cache`
  hints — which it maps to `cache_control` for anthropic). Map the v2 envelope to
  `{ text, model }`: `text = content.filter(b=>b.type==='text').map(b=>b.text).join('')`,
  usage from `usage.input_tokens`/`output_tokens`.
- `syncAuth` in direct mode rebuilds the `AIGateway` on a model OR key change
  (both are bound at construction).

Structure Phase 1 so the mode branch is a single, isolated decision (e.g. a small
private `completeOnce`/`completeStream` pair per mode behind the unchanged public
methods) — do NOT prematurely build a transport-abstraction layer for one mode.

---

## 8. Cross-project sequencing (CRITICAL — verified gap)

The currently **deployed** gateway (`llm.corp.example`) returns **404 on
`/v1/chat/completions`** (verified live during spec work) — the native endpoints
live only in aiapi PR #2, unmerged/undeployed. Therefore:

1. **Merge AND deploy aiapi PR #2 first.** Gateway-mode `AiClient` 404s until `/v1`
   is live.
2. Then land this migration. Live integration tests will fail against an
   un-deployed gateway — gate them on the deploy.

This ordering is non-negotiable; shipping the consumer first breaks all AI calls.

---

## 9. Out of scope

- Retiring `/v2` (server-side, a later step once this is deployed and stable).
- Tool/function calling (deferred gateway-side too).
- Phase 2 BYOK (documented in §7, optional).

---

## 10. Definition of done (Phase 1)

- [ ] `AiClient` uses the `openai` SDK against `${gatewayUrl}/v1`; the bespoke
      `/v2` fetch + SSE code is gone.
- [ ] Public interface unchanged; all call sites compile untouched.
- [ ] `complete()` (stream + non-stream) returns `{ text, model }` and feeds
      `tokenTracker` from OpenAI usage fields; instant-stop + 120s timeout
      preserved via `buildSignal`; `maxRetries: 0`.
- [ ] `syncAuth` swaps model per-request and rebuilds the client on key change,
      never leaking the key.
- [ ] `cache` hints stripped before the SDK; `response_format: json_object` kept.
- [ ] AI request/response traces (`ai.request#N`/`ai.response#N`, image-stripped via
      `summarizeMessagesForTrace`) preserved, so `serverFileLogLevel: 'full'` run logs
      keep the AI blocks.
- [ ] `openai` added; `eventsource-parser` removed iff unused; dead `/v2` types
      removed iff unreferenced.
- [ ] `tests/ai-client.test.ts` rewritten to mock `openai`; `npm test` green.
- [ ] Documented dependency on deployed aiapi `/v1` (§8); no changes to
      `@pkent/aigateway` or aiapi.
