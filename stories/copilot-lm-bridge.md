# Copilot LM bridge — compile and repair on the user's Copilot seat

Status: draft — for review
Builds on: [keyless-replay-and-gateway-env.md](keyless-replay-and-gateway-env.md)
(PR #111), the AI run switch ([run-settings.md](run-settings.md) §9), the
model-prefix routing ([SPEC-aibroker-routing.md](../SPEC-aibroker-routing.md);
this story adds the `gateway/` alias), and step code-behind
([codebehind-compile.md](codebehind-compile.md)).

## What we're building

A TestBench user whose only approved AI is a GitHub Copilot subscription can
compile, repair and author tests with it. No AI API key, no external endpoint
to clear with security, nothing new leaves the machine — prompts go out through
Copilot's own channel, which the org has already approved.

The flow, from the user's chair:

1. Run **TestBench: Use Copilot for AI** once. VS Code shows Copilot's consent
   dialog ("TestBench wants to access language models"), they pick a model from
   a list of what their seat offers, and the command writes three lines into
   the project's `.env`.
2. **Compile This Step** / **Repair this step** / compiling a test now run on
   their Copilot seat. Errors from Copilot (quota, consent revoked) surface in
   the same hovers and panel rows as any other compile error.
3. Running a compiled test is unchanged: keyless replay, zero AI calls, zero
   quota spent. Copilot is only touched when a human asks for AI work.

`.env` after setup:

```
# written by "TestBench: Use Copilot for AI"
AI_MODEL=gateway/copilot/gpt-4.1
AI_GATEWAY_URL=http://127.0.0.1:18790
AI_API_KEY=<bridge token>
```

No `/v1` on the URL — `AiClient` appends it (`buildGateway` builds
`${gatewayUrl}/v1`). `gateway/` means "route to `AI_GATEWAY_URL`" (this
story's one framework touch — Part B); `copilot/gpt-4.1` is the
vendor-qualified model id the bridge resolves.

## Why a bridge, and why this shape

Copilot has no sanctioned HTTP surface. GitHub Models (the PAT-authenticated
endpoint) retired 2026-07-30; MCP sampling was deprecated in the 2026-07-28
spec revision; the reverse-engineered `api.githubcopilot.com` projects are
explicitly against GitHub's terms and trip its abuse detection on exactly the
call pattern a test tool produces. What remains is `vscode.lm` — an
extension-host **API**, not a protocol. It cannot be pointed at; it can only be
called from inside a VS Code extension.

Meanwhile every AI call in this framework is made by `AiClient` inside the
Sessions API server process (`test-runner`, `session-manager`,
`compile-runner`, `errand-runner`) — a different process from the extension
host. The only join that respects both facts is a protocol adapter: the
TestBench extension publishes `vscode.lm` as an OpenAI-compatible endpoint on
127.0.0.1, and the server consumes it through routing that already shipped
(the `gateway/` prefix + `AI_GATEWAY_URL`, which the extension already
delivers per-run by shipping the project `.env`). Framework changes: **one
naming alias** (Part B) — nothing behavioral on the run path; the tests below
hold it.

Scope is compile/repair/authoring, **not** per-step run execution. Copilot is
billed in premium requests with per-model multipliers, sized for interactive
chat; the field data from agents that shipped `vscode.lm` providers (Cline,
Roo Code) is quota exhaustion within minutes on agent-style traffic. Code-behind
replay means runs don't need AI; the residual AI is exactly the low-volume,
user-initiated kind a seat survives. The bridge does not try to enforce this —
an uncompiled test with a bridge configured will execute steps through Copilot
and hit its limits; that is the user's quota to spend and the docs say so.

## Part A — the bridge (`testbench-native`)

### Lifecycle

- New module `src/extension/lm-bridge.ts`, started on activation when
  `testbench-native.lmBridge.enabled` is true. **User scope, default false** —
  the same reasoning as `serverAutoStart.cwd`: a workspace-settable switch
  would let any cloned repo open a listener; and a port plus subscription
  spend should never appear silently.
- Binds **127.0.0.1 only**, port from `testbench-native.lmBridge.port`
  (default 18790). One instance per machine: on EADDRINUSE the window stands
  by and periodically retries, claiming the port when the owning window
  closes — the same probe-and-adopt pattern the fixture app uses on 8787.
  Any window's bridge serves the same user's models, so which window owns it
  doesn't matter.
- Auth token: 32 random bytes, minted once into `context.secrets` and reused
  across reloads so written `.env` files never go stale. Every request must
  carry `Authorization: Bearer <token>`; anything else is 401. This is what
  stops an arbitrary local process from spending the seat: the token lives in
  SecretStorage and the project's gitignored `.env` — the same trust level as
  `AI_API_KEY` today.

### Endpoints

- `GET /v1/models` — the result of `vscode.lm.selectChatModels()` mapped to
  OpenAI's list shape (`{data: [{id, owned_by: vendor}]}`), so a user can see
  valid ids without guessing.
- `POST /v1/chat/completions` — non-streaming and `stream: true` (SSE,
  OpenAI delta framing, terminated by `data: [DONE]`).

### Translation

The request's `model` is whatever followed `gateway/` (or legacy `aibroker/`)
in `AI_MODEL` — the routing lib strips exactly that first segment and forwards
the rest verbatim, so `gateway/copilot/gpt-4.1` arrives as `copilot/gpt-4.1`.
The mappings, exhaustively:

| OpenAI wire | `vscode.lm` | Rule |
|---|---|---|
| `model` | `selectChatModels({id})` | exact id; fall back to `{family}`; 404-shaped error naming `/v1/models` if neither matches |
| `role: "system"` | — (only User/Assistant exist) | fold: prepend to the first user message |
| `role: "user"/"assistant"` | `LanguageModelChatMessage.User/Assistant` | 1:1 |
| `content` text blocks | joined text | 1:1 |
| `content` `image_url` blocks | — | **strip**, substituting an inline `[screenshot omitted — images unsupported over the bridge]` note; a once-per-session warning names `ai.sendScreenshots` when that is the source (see non-goals) |
| `max_tokens` | `modelOptions` where supported | pass through |
| `reasoning_effort`, `temperature`, unknowns | — | drop silently, never error — the `retry`/`authoring` profiles send effort and must keep working |
| `response_format: json_object` | — | best-effort emulation, below |
| response fragments | `for await (…of res.text)` | concatenate (non-stream) or re-emit as SSE deltas (stream) |
| usage | — (`vscode.lm` reports none) | zeros; TokenTracker shows 0 for bridge calls |

**`json_object` emulation.** Code-behind compile forces
`response_format: json_object` and parses a strict `{"entry":…}` envelope.
`vscode.lm` has no JSON mode, and models without it like to wrap JSON in
markdown fences. When a request asked for `json_object`, the bridge strips one
leading/trailing ``` fence pair from the completed response before returning
it. Protocol-level, framework untouched; the acceptance below proves it on a
real compile.

### Consent

`selectChatModels` only succeeds inside a user-initiated flow the first time —
and the bridge's calls are triggered by an HTTP request from the server, which
VS Code cannot attribute to any user action. So the **setup command is the
consent moment**: it makes a one-line warm-up request under the user's
command invocation, which raises the consent dialog; once granted, consent
persists for the extension and background-triggered requests succeed. If
consent is later revoked, the bridge maps the `NoPermissions` error to a
response telling the user to rerun **TestBench: Use Copilot for AI**.

### The setup command

**TestBench: Use Copilot for AI** — one command, four effects:

1. Ensure the bridge is enabled and running (flips the User setting with a
   confirmation).
2. QuickPick over `selectChatModels()`; make the warm-up request with the
   chosen model (consent).
3. Write/update the three `.env` lines in the workspace folder of the active
   test (created if absent, existing unrelated lines preserved, shown as a
   confirm before writing — this file holds the user's other secrets).
4. Status bar item while the bridge is up: `$(copilot) TestBench bridge :18790`,
   with request count as tooltip — the visible answer to "is my seat being
   spent".

### Errors

`LanguageModelError` and friends map to OpenAI-style
`{error: {message, type, code}}` with text that says what to do:
quota exhausted → "Copilot premium requests exhausted; resets monthly; runs of
compiled tests don't spend quota"; `NoPermissions` → rerun the setup command;
model gone (subscription tier changed) → rerun setup and re-pick. PR #110's
error surfacing carries these into step hovers and panel rows unchanged. A
server-side connection refusal (window closed, bridge off) is already an
`AiClient` fetch error today; the `.env` comment written by setup names the
symptom.

## Part B — framework

One deliberate change, and it is naming, not behavior: the **`gateway/`
prefix**. `aibroker/` cannot be the documented Copilot spelling — it names the
hosted broker application, and a reviewer reading it beside a loopback URL
misreads the destination. `gateway/` says what the mechanism actually does:
route to `AI_GATEWAY_URL`, whatever it names — this bridge, a corp gateway,
Ollama.

- `@pkent/aigateway`: a provider alias — `aibroker.js` cloned with id
  `gateway` (same openaiCompatible base, same required `baseURL`),
  registered, version bumped, published.
- This repo: `buildGateway`'s prefix check covers both spellings; the
  inert-pair warning says "gateway-routed models"; `.env.example` and the
  README switch their explicit-destination examples to `gateway/`.
- **`gateway/` requires an explicitly set `AI_GATEWAY_URL`** (env, project
  config, or machine `.env`). When the value would come only from the
  built-in default, the request is refused with a clear error naming the
  variable — never sent. Rationale: a corporate user who forgets the URL
  line must get a loud failure, not silent egress of their token and DOM
  payload to the default host. `aibroker/` keeps today's fall-through to
  aiapi — so it is not merely a legacy alias but the zero-config
  hosted-broker spelling, and each name now matches its behavior exactly.
  The loader already knows which layer a value resolved from, so this is a
  provenance check, not new plumbing. Existing `.env` files don't break.

Everything else is already shipped: the extension ships the project `.env`
with each run, so the trio reaches the server's per-run config, and the
gateway routing points the server's calls at 127.0.0.1.

Costs to document rather than change:

- A bridge token is a **key** — with it present, runs are keyed, and the two
  reactive paths spend the seat: the diagnosis pass (one call per failed run,
  text-only over the bridge) and the heal fall-through on a stale step. Green
  compiled runs still make zero AI calls. Spend control is the AI run switch
  ([run-settings.md](run-settings.md) §9): `ai: off` makes a run keyless by
  policy — no healing, no diagnosis, typed refusal on AI steps — without
  touching the `.env`. The setup command's summary says exactly this.
- Remote Sessions API servers are out of scope by construction: the `.env`
  points at 127.0.0.1, which a remote server resolves to itself. The setup
  command warns when `SERVER_URL` is non-local.

## Non-goals

- **Per-step run execution over Copilot.** Works, unadvised, undocumented as a
  workflow; the quota math is the reason this story is compile/repair-shaped.
- **Screenshots/vision.** `LanguageModelDataPart` postdates the extension's
  `^1.85` engine floor; `ai.sendScreenshots` defaults false so the default
  path never sends images. The bridge strips image blocks rather than
  erroring, because the diagnosis pass captures and attaches its own
  screenshot regardless of `sendScreenshots`
  ([diagnose.ts:46](../src/ai/diagnose.ts)) — a hard refusal would break
  diagnosis on every failed keyed run. Raising the floor for real vision is
  its own small story when someone needs it.
- **CLI / CI / MCP-from-another-host.** No extension host, no bridge; replay
  still works keyless there. Compile needs a VS Code window — which is where
  compiles come from anyway.
- **Proxy/CA support.** Separate thread: operator-level environment on
  whoever starts the server, nothing to do with the bridge.
- **Other `vscode.lm` providers.** They work for free (the API is
  provider-agnostic — BYOK and AI Toolkit models appear in the same list); we
  just don't test them. The command name says Copilot because that's the ask.

## Tests

- **Unit (extension repo):** the translation module is pure and
  dependency-free — message folding, fence-strip, SSE framing, error mapping,
  model-id fallback — tested without a VS Code host.
- **Unit (repo root):** `gateway/` parity — the existing `aibroker/` routing
  tests in `ai-client.test.ts` mirrored for the alias: baseURL applied,
  prefix stripped, no inert-pair warning.
- **Integration (electron harness):** a fake `vscode.lm` namespace (the
  FakeApiClient pattern): consent-missing path, 401 without token, EADDRINUSE
  standby/adopt, `/v1/models` shape, streaming and non-streaming bodies.
- **Live (manual checklist, real Copilot seat — not CI-able):** setup command
  end-to-end; Compile This Step through the bridge; compile envelope parses
  (json_object emulation); a keyed failed run performs exactly one diagnose
  call; quota-exhausted error text lands in the hover.

## Rollout

Two repos, in order:

1. `@pkent/aigateway`: publish the version carrying the `gateway/` provider.
2. This repo, framework: the `buildGateway`/warning/docs change — rebuild
   `dist/` and restart :3100. Server-side only; no extension bump for this
   part.
3. This repo, extension: the bridge itself — patch bump, package + install
   per the repo loop.

README: a short "Using GitHub Copilot" subsection under the corporate
configuration notes, stating the compile/repair scope and the quota behavior
plainly.

## Open questions

1. **RESOLVED — second segment.** The bridge accepts both a bare id
   (`gpt-4.1`) and a vendor-qualified one (`copilot/gpt-4.1`), mapping the
   latter onto `selectChatModels({vendor, id})`; exact id is tried first.
2. **RESOLVED — first segment: `gateway/`.** "Route to `AI_GATEWAY_URL`" —
   truthful for the bridge, a corp gateway and Ollama alike. `local/` was
   rejected because it reads wrong the moment it points at a non-local corp
   gateway; `aibroker/` because it names the hosted broker application. The
   legacy spelling keeps working; the work item lives in Part B. Refinement:
   `gateway/` demands an explicitly set URL (loud error otherwise) while
   `aibroker/` keeps the aiapi default — each spelling matches its behavior.
3. **Usage reporting.** Zeros, or estimate via `model.countTokens()` at the
   cost of extra calls? Zeros proposed; revisit if 0-token compile reports
   confuse people.
4. **RESOLVED — diagnosis and quota.** Superseded by the AI run switch
   ([run-settings.md](run-settings.md) §9): setup never touches
   `ai.diagnoseFailures`, spend control is the run mode, and diagnosis works
   text-only over the bridge via the image-strip rule.
