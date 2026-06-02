# 022 — Let the AI set a per-wait `timeout` hint so slow waits don't fail at 10s

**Status:** 🟡 open — diagnosed; small plan below
**Area:** [src/browser/actions.ts:409](../src/browser/actions.ts#L409) (`executeWait` default 10s), [src/ai/prompts.ts:172](../src/ai/prompts.ts#L172) (rule 12 — wait guidance, no timeout mention), [src/ai/action-parser.ts:306](../src/ai/action-parser.ts#L306) (already parses `timeout`), [src/ai/types.ts:60](../src/ai/types.ts#L60) (`AIAction.timeout` already exists)
**Related:** none.
**Opened:** 2026-06-02

## Symptom

A step like *"Click Continue and wait until it navigates to /newurl"* (where the
navigation can take ~60s) fails at ~10s. The wait maps to a `wait` action whose
`timeout` defaults to **10s** ([actions.ts:409](../src/browser/actions.ts#L409),
used by every wait branch incl. `url`/`navigation` at [463](../src/browser/actions.ts#L463)/[516](../src/browser/actions.ts#L516)),
and the AI is never told it can ask for longer.

## Mechanism — the plumbing already exists; only the prompt is missing

- `AIAction.timeout?: number` exists ([types.ts:60](../src/ai/types.ts#L60)).
- The parser already preserves it: `if (typeof obj['timeout'] === 'number') action.timeout = obj['timeout']` ([action-parser.ts:306](../src/ai/action-parser.ts#L306)).
- `executeWait` already honours it: `action.timeout ?? 10_000` ([actions.ts:409](../src/browser/actions.ts#L409)).

So the value flows AI → parser → executeWait end-to-end **if the AI sets it** —
but rule 12 / rule 22 in the prompt never mention `timeout`, so the AI never
does. `execution.timeout` (default 1h) is the overall test budget and is **not**
wired to per-wait timeouts.

## Fix (small)

1. **Prompt** ([prompts.ts](../src/ai/prompts.ts) rule 12) — document the optional
   `timeout` (milliseconds) on wait actions: default 10000; raise it when the step
   states/implies a slow wait ("wait up to 60 seconds", "may take a while", a
   known-slow navigation/processing step), choosing a value comfortably above the
   expected duration; framework-capped. Only set when warranted.
2. **Framework clamp** ([actions.ts](../src/browser/actions.ts) `executeWait`) —
   replace the bare `?? 10_000` with a clamp: ignore non-positive/NaN (→ default
   10s), cap at `MAX_WAIT_TIMEOUT_MS` so a hallucinated huge hint can't hang the
   run. Named constants; applies to every wait branch (they share the one
   `timeout`).

   Keeping the default at 10s preserves current behaviour for every step that
   doesn't ask for more — this is purely additive.

   **Cap = 2 minutes (deliberately modest), because of a STOP-latency
   interaction (caught in review).** A run abort does **not** cancel an in-flight
   Playwright wait — issue 020 threads the abort signal into AI calls and the
   turn loop, but `executeAction`/`executeWait` receive no signal and Playwright
   waits take no `AbortSignal`, so a wait already running finishes its own timeout
   before the loop notices the stop. Before this change a stuck wait bounded
   stop-latency at the hardcoded 10s; a generous cap (e.g. 10 min) would raise
   that worst case to the cap, partly undoing 020's fast-stop. 2 min covers the
   stated ~60s slow-nav/upload cases with headroom while keeping stop responsive.
   Note: `waitType "stable"` does two sequential waits and `"navigation"` adds a
   ~1.5s settle tail, so the cap bounds the primary wait, not total wall time.

## Tests

- **action-parser** (`tests/action-parser.test.ts`): a wait with `timeout: 90000`
  lands on `action.timeout`; a non-number `timeout` is dropped.
- **clamp** (`tests/*` for `actions`): export and unit-test the clamp — a positive
  hint passes through, over-cap is clamped to MAX, 0/negative/NaN/undefined →
  default 10s.

## Update — abort-aware waits implemented; cap restored to 10 min

The STOP-latency interaction above is now **fixed**, so the modest 2-min cap was
unnecessary and is back to **10 min** (covers the original "wait 10 min" ask).

- **`withAbort(work, signal)`** ([actions.ts](../src/browser/actions.ts)) — races a
  wait against the run abort signal: on abort it rejects with an `AbortError`
  immediately and lets the orphaned Playwright promise settle on its own
  (rejection swallowed); the `abort` listener is removed on settle so it can't
  accumulate on the long-lived run signal.
- **`executeWait(…, signal?)`** wraps its whole switch body in `withAbort`, so
  EVERY wait branch — including the `duration` sleep and the multi-await
  `stable`/`navigation` paths — is interruptible.
- **`executeAction(…, signal?)`** forwards the signal and, in its catch,
  **rethrows when `signal.aborted`** instead of swallowing into a failed-action
  result — so the abort propagates as the issue-020 mid-step abort (turn-loop
  catch → `withRetry` no-retry → `executeStep` aborted result → run `aborted`).
- **step-executor** passes `opts.signal` into the sub-action `executeAction` call.

Net: a STOP now ends an in-flight wait near-instantly (test:
`executeWait` with a never-resolving `waitForURL` rejects with `AbortError` the
moment the controller aborts), and a generous cap no longer hurts stop latency.

## Follow-ups (not blocking)

- **Other long actions abort-aware too** — `navigate` (goto, 30s) and `click`
  (10s) still run out their own timeout on STOP. Same `withAbort` treatment would
  make those interruptible; waits were the long pole, so done first.
- **Configurable default/cap** (`execution.waitTimeout` / `execution.maxWaitTimeout`)
  rather than constants.
- **Author-set per-step timeout** (e.g. a `[timeout: 90s]` step prefix) for
  deterministic control independent of the AI's judgement.
