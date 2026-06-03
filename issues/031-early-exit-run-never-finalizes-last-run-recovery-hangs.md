# 031 — A run that exits early during setup never finalizes last-run info → stop-recovery hangs

**Status:** 🟡 open — diagnosed; fix below
**Area:** [src/server/session-manager.ts:822](../src/server/session-manager.ts#L822) (the single `executeStepsInternal` call site) — early `return`/`throw` paths in `executeStepsInternal` bypass `recordLastRun`
**Related:** [021](resolved/021-stopped-run-report-not-delivered-or-marked.md) (the recovery feature this gap lives in); [030](030-stop-recovers-stale-previous-run-report.md) (whose run-start reset surfaced it).
**Opened:** 2026-06-04

## Symptom

A client that STOPPED a run recovers the report + tokens by polling
`GET /sessions/:id/last-run` **until `finalized` is true** (issue 021). For most
runs that terminates. But several **run-setup failures** end the run *before* the
main execution block and never call `recordLastRun`, so `finalized` never becomes
true and the client **polls forever**.

This was masked until [030](030-stop-recovers-stale-previous-run-report.md): the
*previous* run's stale `finalized:true` entry used to satisfy the poll (with the
wrong report). 030's fix deletes that entry at run start — correct, but it exposes
this latent hang for early-exit runs.

## Mechanism

`recordLastRun(sessionId, { finalized: true, … })` is called once, at the **normal
end** of `executeStepsInternal` (after the main try/finally). Early-exit paths in
the same method return/throw **before** reaching it:

- malformed/throwing skill bundle,
- missing skill referenced by the test,
- re-run anchor (`startAt`) not found,
- partial-rerun refusal (tail needs an unseedable internal var).

After 030's run-start `lastRunInfo.delete(sessionId)`, these leave **no** entry, so
`getLastRun` returns the synthesized `{ finalized: false }` indefinitely.

## Fix

Guarantee a finalized record on **every** exit of the run, at the one place every
run funnels through — the `queueTail` call site
([session-manager.ts:822](../src/server/session-manager.ts#L822)):

```ts
session.queueTail = session.queueTail
  .then(async () => {
    try {
      return await this.executeStepsInternal(session, sessionId, request, onEvent, signal);
    } finally {
      // If the run exited early without recording (no report written), record a
      // minimal finalized entry so a STOP-recovery poll terminates.
      if (!this.lastRunInfo.get(sessionId)?.finalized) {
        this.recordLastRun(sessionId, { finalized: true, tokens: <run snapshot> });
      }
    }
  })
  .then(resolve, reject);
```

A single chokepoint (not per-early-exit), so future early-exits are covered too.
The normal/abort paths already record `finalized:true`, so the guard makes the
`finally` a no-op for them — no double-record, no overwrite (the queue serializes
runs, so this run's `finally` runs before the next run starts).

## Tests

- **unit** (`tests/session-manager.test.ts`): a partial-rerun-refusal run (returns
  `status:'error'` before the step loop) must leave `getLastRun(sessionId)`
  `finalized:true` with no `reportPath`. Fails (returns `finalized:false`) without
  the guarantee.
