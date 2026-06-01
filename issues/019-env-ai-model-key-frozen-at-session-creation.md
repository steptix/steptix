# 019 — A saved `AI_MODEL` / `AI_API_KEY` edit isn't picked up until the session is closed

**Status:** ✅ resolved 2026-06-02 — fix shipped + tested at the AiClient unit and session-manager reuse seams (full suite green, 981 tests)
**Area:** [src/server/session-manager.ts:909](../src/server/session-manager.ts#L909) (env applied only inside `createSession`), [src/server/session-manager.ts:438-453](../src/server/session-manager.ts#L438) (`applyEnvToAiConfig` — the two-knob override), [src/ai/client.ts:48-55](../src/ai/client.ts#L48) (`AiClient` holds `config` privately; model/key read per-request)
**Related:** [issues/011-env-bundle-cached-for-session-lifetime.md](011-env-bundle-cached-for-session-lifetime.md) — same family (a `.env`/data edit not picked up on the next run), but that one is the env/data *bundle* re-read; this is the `AiClient`-binding side, which the bundle fix never touched.
**Opened:** 2026-06-01

## Resolution (2026-06-02)

Shipped exactly as planned below, with the review's must-fix applied (call site
inside the `queueTail`-serialized body, not in `executeSteps`):

- **`src/ai/client.ts`** — added `AiClient.syncAuth(model, apiKey)`: mutates only
  `model`/`apiKey` in place (read fresh per request, so it takes effect on the
  next AI call without a rebuild), returns a key-safe change string or `null`. A
  removed key is `delete`d, not set to `undefined`, to satisfy
  `exactOptionalPropertyTypes`.
- **`src/server/session-manager.ts`** — at the top of `executeStepsInternal`
  (under `queueTail`), recompute `applyEnvToAiConfig(this.config.ai, request.env)`
  from the **server base** and call `session.aiClient.syncAuth(...)`, logging the
  change (key value never logged). Updated the three stale doc comments.

**Tests.** `tests/ai-client.test.ts` — `syncAuth` swaps model/key on the next
real fetch, never leaks the key into the change string, reverts to no-`Authorization`
when the key goes empty, and returns `null` when unchanged. `tests/session-manager.test.ts`
(`issue 019`) — three runs on one reused session prove the per-batch re-sync:
one AiClient built (not rebuilt), `syncAuth` called per batch, and an omitted
`AI_API_KEY` / `AI_MODEL` reverts to the server base rather than sticking.

**Server-only, no version bump** (nothing under `testbench-native/` or
`runner-core/`). The follow-ups below remain open.

## Symptom (user report)

> When I save the `.env` file with a new `AI_MODEL` (or `AI_API_KEY`) and run the
> test again, the run still uses the old model/key. I have to close the session
> (or reload the VS Code window) for the change to take effect.

Confirmed. The connection knobs (`SERVER_URL`, `SERVER_API_KEY`) and `${env.*}`
substitutions *are* picked up every run — only the AI model/key are frozen.

## Mechanism

TestBench-native is a thin client: it re-reads the whole `.env` from disk on
**every** run ([run-controller.ts:858](../testbench-native/src/extension/run-controller.ts#L858))
and ships the parsed map as `env` on **every** batch
([run-controller.ts:1205](../testbench-native/src/extension/run-controller.ts#L1205)).
So the fresh values reach the server each run. The server is where they get
dropped:

1. **The override runs only at session creation.** `applyEnvToAiConfig(this.config.ai, envOverrides)`
   is called inside `createSession` ([session-manager.ts:909](../src/server/session-manager.ts#L909))
   and nowhere else. It reads exactly two keys
   ([session-manager.ts:444-451](../src/server/session-manager.ts#L444)):
   ```ts
   const apiKey = envOverrides['AI_API_KEY'];  // set if non-empty
   const model  = envOverrides['AI_MODEL'];    // set if non-empty
   ```

2. **Sessions are reused across runs.** A session is keyed by the test file path.
   The controller only closes/recreates it on its *first* run or in batch mode
   ([run-controller.ts:811-819](../testbench-native/src/extension/run-controller.ts#L811)).
   A second F5 on the same file reuses the live session, so `executeSteps` finds
   an existing session and never re-enters `createSession`
   ([session-manager.ts:715-736](../src/server/session-manager.ts#L715)). The
   `env` map on the reused batch is therefore ignored for AI config.

3. **The binding is per-session, by design.** The current doc comment states this
   was deliberate ([session-manager.ts:731-735](../src/server/session-manager.ts#L731)):
   > "Per-request env is applied at session-creation time only — once an AiClient
   > is bound to a session, changing env mid-session is intentionally not supported."

   The session is reused to preserve **browser state**; there's no technical need
   to also freeze the AI model/key. The `AiClient` reads `this.config.model` /
   `this.config.apiKey` fresh on every request
   ([client.ts:74](../src/ai/client.ts#L74), [client.ts:317](../src/ai/client.ts#L317)),
   so updating those two fields in place takes effect on the very next AI call —
   no client rebuild, no browser teardown.

Net: edit `.env` → re-run → reused session → old model/key persists.

## Scope decision (settled with the user)

**Picking up a `.env` edit between runs is acceptable** — the new model/key is
adopted on the next *full* batch (a fresh `streamSteps` / F5 on the reused
session). Note: a breakpoint/stepMode *resume* is **not** a new batch — it
resolves the in-run `pendingRunControl` promise inside the same
`executeStepsInternal`, so it does **not** re-apply env; the model stays put for
the remainder of that run and only refreshes on the next batch. That is the
cleaner boundary anyway. This removes the need for a client-side "fresh run"
flag and keeps the change **server-only** — no `runner-core` /
`testbench-native` edits, no wire-protocol field, **no extension version bump**
(per CLAUDE.md the bump is only for code bundled into a VSIX; this isn't).
Restart the aiui server and it's live.

## Fix sketch (cheapest correct)

Re-apply the env override to the session's `AiClient` at the top of **every**
batch, recomputed from the server base so add *and* remove both behave:

1. **`src/ai/client.ts`** — add a targeted updater (only `model` + `apiKey` are
   env-mutable; gatewayUrl / maxInputTokens / streaming stay server-level):
   ```ts
   /** Re-point an already-bound client at a new model/apiKey (from a saved
    *  .env). Returns a short change description for logging, or null if
    *  nothing changed. */
   syncAuth(model: string, apiKey: string | undefined): string | null
   ```

2. **`src/server/session-manager.ts`** — recompute from the **server base** and
   apply at the **top of `executeStepsInternal`** (~line 965, where `session` and
   `request` are in scope), **not** in `executeSteps`:
   ```ts
   const desired = applyEnvToAiConfig(this.config.ai, request.env);
   const change = session.aiClient.syncAuth(desired.model, desired.apiKey);
   if (change) logger.info(`Session "${sessionId}": ${change}`); // never log the key value
   ```

   - **Placement is load-bearing — it must be inside the queued section.**
     `executeSteps` resolves/creates the session *synchronously* and only then
     queues the real work onto `session.queueTail`
     ([session-manager.ts:746-750](../src/server/session-manager.ts#L746));
     `queueTail` serializes `executeStepsInternal`, **not** `executeSteps`. If
     `syncAuth` ran in `executeSteps` (e.g. right after session resolution at
     [735](../src/server/session-manager.ts#L735)), a batch arriving while a prior
     batch is mid-flight would mutate the shared `AiClient.config` out from under
     that batch's in-flight AI calls. Putting it at the top of
     `executeStepsInternal` (the sole body run under `queueTail`, single caller at
     [748](../src/server/session-manager.ts#L748)) means it runs *after* any prior
     batch finishes and *before* this batch's first AI call — that is the only
     placement where the "no race" guarantee actually holds.
   - **Recompute from `this.config.ai`, not the session's current state.**
     `applyEnvToAiConfig` only overrides when the env value is non-empty
     ([session-manager.ts:444-451](../src/server/session-manager.ts#L444)). If the
     base were the session's *current* model, deleting `AI_MODEL` from `.env`
     would leave the override skipped → the old value sticks. Starting from the
     fixed server base means a removed line cleanly reverts to the base model.
   - **Redundant no-op on a fresh session.** `createSession` already applied the
     same override, so the first batch's `syncAuth` changes nothing — no need to
     branch on "reused vs new", the call runs unconditionally.
   - **The runner contexts hold a live reference, not a snapshot.**
     `aiClient: session.aiClient` is passed by reference into the runner contexts
     ([session-manager.ts:1705](../src/server/session-manager.ts#L1705),
     [2009](../src/server/session-manager.ts#L2009)), so an in-place field update
     is visible to them without rebuilding anything.
   - **Never log the key.** `syncAuth`'s returned change string must report the
     model change and a generic "API key changed" — it must not embed
     `desired.apiKey`, and the call site must not log the value either.

3. **Update the two stale doc comments** that assert creation-time-only:
   the `StepRequest.env` comment ([session-manager.ts:50-55](../src/server/session-manager.ts#L50))
   and the note at [session-manager.ts:731-735](../src/server/session-manager.ts#L731).

## Tests (planned)

Test at the **client/HTTP seam**, not just the resolver in isolation — a unit
test of `applyEnvToAiConfig` alone would miss the api-server reuse path that is
the actual bug (cf. the recurring "test at the client seam" lesson).

- **Unit (`tests` for `AiClient`):** `syncAuth` updates `model`/`apiKey`,
  reports the change, returns `null` when unchanged, and reverts to base when
  `apiKey` goes empty.
- **Integration (`tests/api-server*.test.ts` style):** open one session, run
  batch 1 with `env.AI_MODEL=A`, run batch 2 **on the same session** with
  `env.AI_MODEL=B`, and assert the gateway request for batch 2 carries model
  `B`. Parallel case for `AI_API_KEY`. A control case: omitting `AI_MODEL` on
  batch 2 reverts to the server base model.

## Follow-ups (not blocking)

- **Step cache doesn't key on model.** Switching models on a cache-enabled test
  could replay a plan generated by the old model (the cache hash has no model
  component — same family as [012](012-step-cache-not-env-aware.md) /
  [018](018-step-cache-blind-to-data-file-value-changes.md)). Partly mitigated:
  an explicit re-run forces the cache off
  ([run-controller.ts:1217](../testbench-native/src/extension/run-controller.ts#L1217)),
  but a plain re-run with a changed model can still replay. This fix makes model
  switching easier, so it makes that latent staleness more reachable. Out of
  scope here; address separately if it bites.
- **`AI_MODEL` in a `.env.<name>` is still ignored for the AI client.** The
  override (here and at creation today) reads the client-shipped `request.env`,
  which is the base `.env` the extension parsed
  ([run-controller.ts:858](../testbench-native/src/extension/run-controller.ts#L858)) —
  **not** the server-resolved `.env.<name>` bundle
  ([session-manager.ts:582](../src/server/session-manager.ts#L582)). So an
  environment-specific `AI_MODEL`/`AI_API_KEY` set only in `.env.<name>` won't
  reach the AI client. Pre-existing behaviour, not a regression from this fix,
  but stated so it isn't mistaken for a new bug afterward.
- **Per-project `aiui.config.json` `ai.model` is still ignored on the server
  path.** The session's `AiClient` is built from the server's *startup*
  `this.config.ai` plus the `.env` override — the test project's own
  `aiui.config.json` `ai` block never reaches the running client
  ([session-manager.ts:909](../src/server/session-manager.ts#L909) uses
  `this.config.ai`, while the per-project config loaded at
  [session-manager.ts:570](../src/server/session-manager.ts#L570) feeds only
  dataDir/env/data). So `.env` is the only live lever for model/key on this path.
  Wiring the per-project `ai` block in is a larger, separate change.
