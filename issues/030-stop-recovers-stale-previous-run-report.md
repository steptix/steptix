# 030 — A STOP can recover the PREVIOUS run's report (last-run info not reset on re-run)

**Status:** 🟡 open — diagnosed; one-line fix below
**Area:** [src/server/session-manager.ts](../src/server/session-manager.ts) — `executeStepsInternal` run start (no `lastRunInfo` reset) vs `recordLastRun` (writes only at run END)
**Related:** [021](resolved/021-stopped-run-report-not-delivered-or-marked.md) (this is a gap in that feature's recovery path).
**Opened:** 2026-06-04

## Symptom

Stop a run that you've **run before**, and the recovered report can be the
*previous* run's — e.g. a green **PASSED** report for a run you actually aborted.
The live stop-report test (`steptix-vscode/.../stop-report.test.cjs`) caught
this: after a mid-run STOP, the recovered report had no `ABORTED` marker even
though the run was aborted. The *correct* aborted report was generated on disk
(`…-github.html` with `■ ABORTED`); it just wasn't what the client recovered.

## Mechanism — `lastRunInfo` is written at run END but never reset at run START

Issue 021 records per-session last-run info so a client that STOPPED (and so
dropped the SSE `done` event) can recover the report path + tokens via
`GET /sessions/:id/last-run`, polling **until `finalized` is true**.

- `recordLastRun(sessionId, { finalized: true, … })` is called **only at the end
  of a run** ([session-manager.ts:2671](../src/server/session-manager.ts#L2671)).
- Nothing resets it when a **new run starts**.

So when a session is re-run, `lastRunInfo[sessionId]` still holds the *previous*
run's `{ finalized: true, reportPath }`. On a STOP, the client polls
`GET /sessions/:id/last-run`, sees the stale `finalized: true` **immediately**,
and recovers the previous run's report — winning the race against the current
run's own `recordLastRun`, which only fires once the aborted run finishes
unwinding.

This mirrors a bug already guarded for tokens right at run start:
`session.tokenTracker.markRunStart()` ([session-manager.ts:1130](../src/server/session-manager.ts#L1130))
snapshots tokens so a re-run doesn't inherit the prior run's totals. The
`lastRunInfo` reset is the same class of "re-run inherits prior-run state" bug,
just missed.

## Fix (one line)

Invalidate the prior finalized record at the **start** of the run, next to
`markRunStart()`:

```ts
session.tokenTracker.markRunStart();
this.lastRunInfo.delete(sessionId); // issue 030 — see below
```

`getLastRun` already returns `{ finalized: false, … }` for a missing entry, so a
client correctly keeps polling until **this** run finalizes (and `recordLastRun`
re-adds the entry at the end). No change to the recovery/poll protocol.

## Tests

- **unit** (`tests/session-manager.test.ts`): run a session to completion
  (records `finalized: true`), then re-run it and read `getLastRun` **mid-run**
  (on the first `step:pass`) — it must be `finalized: false` with no `reportPath`,
  proving the prior run's report can't be recovered for the new run. Fails
  (returns the stale `finalized: true` + old `reportPath`) without the reset.

## Follow-ups (not blocking)

- The live `stop-report.test.cjs` `/badge-aborted/` assertion is weak — it matches
  the CSS class present in *every* report's `<style>`. The meaningful check is the
  `■ ABORTED` badge text; tighten it so a non-aborted report can't pass.
- **Pre-existing 021 gap (separate ticket):** several pre-run-setup early exits in
  `executeStepsInternal` (skill-expansion failure, re-run-anchor-not-found, bundle
  throw, partial-rerun refusal) end the run *before* the try block and never call
  `recordLastRun`, so a STOP-recovery client polling "until finalized" would poll
  indefinitely on those failures. With this fix they leave `finalized:false`
  (correct for the stale-recovery bug), but recovery still wouldn't terminate.
  Out of scope for 030.
