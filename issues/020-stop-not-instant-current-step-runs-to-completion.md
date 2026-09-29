# 020 — Stop isn't instant: the current step (and its in-flight AI call) runs to completion

**Status:** ✅ resolved 2026-06-02 — implemented + reviewed (two adversarial subagent passes, both findings self-verified and fixed); full suite green (988 tests)

## Resolution (2026-06-02)

Shipped the five layers below. The post-review pass caught one more correctness
gap (BUG-1) which is fixed:

- **`src/ai/client.ts`** — `complete(messages, signal?)` forwards the run signal
  through `completeVision`/`completeStream` to `fetchWithAuth`, which combines it
  with the 120s timeout via `AbortSignal.any([timeout, runSignal])`. An in-flight
  AI request now cancels the instant the client stops, instead of running out the
  timeout (the ≤120s wait that dominated the symptom).
- **`src/runner/retry.ts`** — `withRetry` takes the signal and rethrows
  immediately (no retry) when it's aborted, so a cancelled call doesn't burn a
  retry firing a second request.
- **`src/runner/step-executor.ts`** — `StepExecutorOptions.signal`; abort check
  at the top of each turn in `executeStepAttempt`; `executeStep`'s catch returns
  an aborted-shaped result (no failure screenshot/log) when aborted; signal
  threaded to all four server-path `complete()` sites (turn loop, clarification,
  `EvaluateAssertionParams`, branched poll loop) and the branched poll loop's
  abort check.
- **`src/server/session-manager.ts`** — threads `signal` into `executeStep` and
  `executeBranchedStep` opts; a post-step abort check converts the swallowed-abort
  `failed` result into `overallStatus='aborted'` (no `step:fail`); the branched
  call is wrapped so a thrown abort becomes a clean stop; **and a post-branch
  abort check** (BUG-1 fix) catches the case where the abort lands inside the
  *matched branch's* inner `executeStep` (swallowed → `failed`) — without it a
  branched run would report `failed` instead of `aborted`.
- **`package.json`** — `engines.node` bumped `>=18.0.0` → `>=18.17.0` to match
  `AbortSignal.any`'s floor.

**Deliberate tradeoff (LEAK-1, left as-is).** `AbortSignal.any` keeps a listener
on the long-lived run signal for each fetch, so composites accumulate until the
run ends (~2KB/fetch; a few MB for a very long run, freed at run end). A manual
`AbortController` fan-in with `finally` cleanup was considered and **rejected**:
it would `removeEventListener` once `fetch()` resolves (headers received), which
is *before* the streaming path consumes the response body — breaking mid-stream
cancellation. Keeping the signal live for the whole response lifetime is the
correct semantics; the bounded, run-scoped retention is the acceptable cost.

**Server-only, no version bump** (nothing under `steptix-vscode/` or
`runner-core/`). Restart the Steptix server and it's live.

**Tests.** `tests/ai-client.test.ts` — fetch gets a signal that fires on run
abort and the call rejects; timeout-only path still works. `tests/retry.test.ts`
— no retry when aborted. `tests/session-manager.test.ts` — signal threaded into
`executeStep`; a mid-step abort reports `aborted` (not `failed`) with no
`step:fail`; plus the existing between-step abort cases.

---

**Status (original):** 🟡 open — diagnosed, plan reviewed (adversarial subagent + self-verified against code), revised below; ready to implement
**Area:** [src/ai/client.ts:343-351](../src/ai/client.ts#L343) (`fetchWithAuth` attaches only `AbortSignal.timeout(120_000)` — the run signal never reaches the fetch), [src/runner/step-executor.ts:392](../src/runner/step-executor.ts#L392) (the per-step `for currentTurn ≤ maxTurns` loop fires `aiClient.complete()` with no abort check), [src/server/session-manager.ts:1664-1671](../src/server/session-manager.ts#L1664) (abort is checked **only between steps**), [src/server/api-server.ts:252-255](../src/server/api-server.ts#L252) (stop = client closes SSE → `abortController.abort()`)
**Related:** none directly; this is the abort-granularity side of the run loop, orthogonal to the env/AI-config family ([019](019-env-ai-model-key-frozen-at-session-creation.md)).
**Opened:** 2026-06-02

## Symptom (user report)

> When I stop a run it isn't instant. The server seems to keep trying to
> complete the current run/step.

Confirmed. Pressing stop registers immediately at the protocol level, but the
run keeps grinding for a noticeable spell — sometimes many seconds — before it
actually halts.

## Mechanism

Stop is wired correctly *up to* the run loop, then loses its teeth:

1. **Stop → abort.** The client stops by closing the SSE connection. The server
   sees `res.on('close')` and calls `abortController.abort()`
   ([api-server.ts:252-255](../src/server/api-server.ts#L252)). That signal is
   threaded into `executeSteps` → `executeStepsInternal`
   ([api-server.ts:276](../src/server/api-server.ts#L276)).

2. **The signal is only checked *between* steps.** The run loop checks
   `signal?.aborted` at the **top of each iteration**
   ([session-manager.ts:1664-1671](../src/server/session-manager.ts#L1664)), with
   the explicit contract:
   > "We don't try to interrupt a step mid-flight (Playwright actions / AI calls
   > aren't reliably cancelable today) — between-step granularity is the contract."

   So a step already underway runs to completion before the next check fires.

3. **A step is not a single quick unit — it's a multi-turn AI loop.** Inside one
   step, `executeStep` loops `for (let currentTurn = 1; currentTurn <= maxTurns; …)`
   ([step-executor.ts:392](../src/runner/step-executor.ts#L392)) — `maxTurns`
   defaults to **15** ([config/defaults.ts:51](../src/config/defaults.ts#L51)).
   Each turn fires `aiClient.complete()` ([step-executor.ts:583](../src/runner/step-executor.ts#L583),
   and again at [664](../src/runner/step-executor.ts#L664) for clarifications)
   plus Playwright sub-actions. None of these see the run signal, so after you
   hit stop the step can keep spending turns.

4. **The AI fetch ignores the run signal entirely.** Worst of all,
   `fetchWithAuth` attaches **only** a 120-second timeout
   ([client.ts:350](../src/ai/client.ts#L350)):
   ```ts
   return fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
   ```
   So a single in-flight AI request can hang for up to **two minutes** after the
   user stops, because nothing cancels it.

Net worst case felt by the user: finish the current AI call (≤120s) + run the
remaining turns of the current step (each its own `complete()` + browser
actions) before the between-step check at the next iteration finally halts.

## Scope decision (proposed — confirm in review)

- **Target: make stop cancel the in-flight AI call and stop spawning new
  turns/steps immediately.** This collapses the dominant wait (the AI fetch) from
  ≤120s to ~0 and prevents a multi-turn step from burning further turns after
  stop.
- **Residual accepted:** a Playwright action (`click`, `waitForLoadState`, …) in
  flight at the moment of stop still runs out *its own* timeout — Playwright
  actions don't take an `AbortSignal`. That's seconds (bounded by the action
  timeout), not the 2-minute AI window, and cancelling mid-action is a much
  larger, separate change. Document it; don't fix it here.
- **Server-only.** Nothing under `steptix-vscode/` or `runner-core/` changes,
  so **no extension version bump** (per CLAUDE.md). The stop wire-path
  (SSE close → abort) is already in place; we're only making the existing signal
  reach deeper. Restart the Steptix server and it's live.

## Fix sketch (three layers, smallest-to-deepest)

**1. Thread the run signal into the AI fetch — the single biggest win.**
`AiClient.complete()` gains an optional `signal`, forwarded through
`completeVision` / `completeStream` / `fetchWithAuth`, where it's combined with
the existing timeout so *either* aborts the request:
```ts
private fetchWithAuth(url: string, init: RequestInit, runSignal?: AbortSignal): Promise<Response> {
  const headers = new Headers(init.headers);
  if (this.config.apiKey) headers.set('Authorization', `Bearer ${this.config.apiKey}`);
  const timeout = AbortSignal.timeout(120_000);
  const signal = runSignal ? AbortSignal.any([timeout, runSignal]) : timeout;
  return fetch(url, { ...init, headers, signal });
}
```
`AbortSignal.any` typechecks (declared by `@types/node`, same source as the
already-compiling `AbortSignal.timeout`) and runs on this machine (Node v22).
**Caveat verified in review:** it needs Node ≥18.17 / ≥20.3, but `package.json`
`engines.node` says `>=18.0.0`. Bump `engines.node` to `>=18.17.0` as part of
this change so the floor matches what we call. (The manual `AbortController`
fan-in alternative has a listener-leak hazard against the long-lived run signal,
so the engines bump is the cleaner route.)

**2. Check the signal in the step turn loop.** The per-step loop lives in
**`executeStepAttempt`** ([step-executor.ts:324](../src/runner/step-executor.ts#L324),
loop at [392](../src/runner/step-executor.ts#L392)) — *not* `executeStep` (192),
which is the retry wrapper. Bail at the top of each turn when `opts.signal?.aborted`,
*before* firing the next `complete()`, so a stopped step stops spawning AI turns.

**3. Thread `signal` from the session loop into the executor opts.**
- Add `signal?: AbortSignal` to `StepExecutorOptions`
  ([step-executor.ts:68-112](../src/runner/step-executor.ts#L68)) and pass it down
  to **every server-path** `aiClient.complete(messages, opts.signal)` call site —
  audited, there are four `complete()` callers in this file:
  - [583](../src/runner/step-executor.ts#L583) — action plan, `executeStepAttempt`. **Server path; thread it.**
  - [664](../src/runner/step-executor.ts#L664) — clarification re-fetch. **CLI-only** — unreachable on the server because `nonInteractive` (set by the server, [session-manager.ts:2046](../src/server/session-manager.ts#L2046)) `break`s at [617-631](../src/runner/step-executor.ts#L617) before it. Thread anyway for consistency; harmless.
  - [1574](../src/runner/step-executor.ts#L1574) — `evaluateAssertion`, called from the turn loop at [698](../src/runner/step-executor.ts#L698) for every `assert`. **Server path; thread `signal` through `EvaluateAssertionParams`.**
  - [1900](../src/runner/step-executor.ts#L1900) — `executeBranchedStep` (conditional groups), called at [session-manager.ts:1721](../src/server/session-manager.ts#L1721). **Server path; thread it.**
  - ([diagnose.ts:64](../src/ai/diagnose.ts#L64) is CLI-only — `test-runner.ts:818`. Out of scope.)
- Pass `signal` from the run loop into both the `executeStep` opts bag
  ([session-manager.ts:2021-2048](../src/server/session-manager.ts#L2021)) and the
  `executeBranchedStep` opts ([session-manager.ts:1721](../src/server/session-manager.ts#L1721)).

**4. Short-circuit `withRetry` on abort — otherwise the abort fires a *second*
AI call.** `withRetry` ([retry.ts:24-42](../src/runner/retry.ts#L24)) retries on
**any** thrown error, AbortError included, so a cancelled fetch would trigger
attempt 2's `complete()` before the step gives up. Make `withRetry` stop
immediately when the operation aborted — cleanest is to pass it the signal and
break the loop when `signal?.aborted` (don't retry an aborted op). The
top-of-turn check (layer 2) is not enough on its own because `executeStep`'s
catch sits *above* the turn loop.

**5. Make an aborted run resolve as `aborted`, not `failed` — the load-bearing
correctness fix.** This is where the first draft was wrong. The chain on abort
today is: fetch throws `AbortError` → `executeStepAttempt` propagates it →
`withRetry` (after layer 4, stops retrying) rethrows → **`executeStep`'s own
catch** ([step-executor.ts:290-321](../src/runner/step-executor.ts#L290))
swallows it and **returns a `StepResult` with `status:'failed'`** (plus a failure
screenshot). The run loop then takes the failed-step `else` branch
([session-manager.ts:2291-2317](../src/server/session-manager.ts#L2291)) which
sets `overallStatus = 'failed'` and **`break`s**. There is **no post-loop abort
re-check** — `overallStatus` is set to `'aborted'` only at the top-of-loop check
([1668](../src/server/session-manager.ts#L1668)), which a `break` skips. So
without this layer an aborted run reports **`failed`**, not `aborted`.

Fix: when `opts.signal?.aborted`, `executeStep`'s catch must **not** masquerade
as a normal failure. Return a result the run loop recognizes as aborted (e.g.
`status:'aborted'`, or a dedicated sentinel), and in the run loop treat an
aborted step result by setting `overallStatus = 'aborted'` and breaking —
**bypassing** the `step:fail` emit and the failure screenshot
([step-executor.ts:299-302](../src/runner/step-executor.ts#L299),
[session-manager.ts:2301-2307](../src/server/session-manager.ts#L2301)) so the
user gets a clean stop, not a spurious red step + error screenshot against a
page that may already be closing. Apply the same aborted-vs-failed guard to the
branched-step failure handling ([session-manager.ts:1771-1783](../src/server/session-manager.ts#L1771)).
Also skip the catch at [session-manager.ts:2050](../src/server/session-manager.ts#L2050)
(reached only by throws *outside* `executeStep`'s try) when `signal?.aborted`.

## Tests (planned)

Test at the seam where the bug lives — the run loop + AI client, not a unit in
isolation (cf. the recurring "test at the client seam" lesson).

- **Unit (`tests/ai-client.test.ts`):** `complete(messages, signal)` rejects
  promptly when the passed signal is already aborted / aborts mid-flight — assert
  the underlying `fetch` was invoked with a signal that fires on the run abort
  (mock fetch, abort the controller, expect the call to reject with an
  abort-flavoured error). Control: no signal → behaves exactly as today (timeout
  only).
- **Integration (`tests/session-manager.test.ts` / `api-server*` style):** start a
  run whose mock AI call blocks until the controller aborts, abort mid-step, and
  assert (a) the in-flight `complete()` is cancelled rather than awaited to its
  natural return, (b) **no further `complete()` calls fire** for subsequent
  turns/steps **and no retry re-fires `complete()`** (guards layer 4), (c) the run
  resolves with **`status: 'aborted'`** — explicitly *not* `'failed'` or
  `'error'` (guards layer 5, the bug the first draft would have shipped), and (d)
  no `step:fail` event / failure screenshot is emitted for the aborted step.
- **Regression:** a normal (un-aborted) run still completes all steps and is
  unaffected by the new signal plumbing; a genuinely failing step (not aborted)
  still reports `failed` with its `step:fail` event intact.

## Follow-ups (not blocking)

- **Mid-action Playwright cancellation.** Out of scope (see Scope decision). If
  the residual per-action wait proves annoying, a later change could pass each
  action a tighter deadline when an abort is pending, or race actions against the
  signal.
- **CLI parity.** The CLI run path (`test-runner.ts`) has no abort signal at all
  (it's Ctrl+C/process-level). Threading a signal there for a graceful in-run
  stop is a separate enhancement.
