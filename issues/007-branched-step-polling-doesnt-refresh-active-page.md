# 007 — `executeBranchedStep` polling loop reads `opts.page` once at entry

**Status:** open / unreachable today
**Area:** [src/runner/step-executor.ts](../src/runner/step-executor.ts) — `executeBranchedStep`
**Opened:** 2026-05-05

## Summary

The branched-step polling loop captures `opts.page` once at function
entry. Inside the polling loop, every DOM snapshot, screenshot, and
test-info block is computed against that captured page — never refreshed
from the BrowserTracker. The flat-step loop in `executeStep` *does*
refresh the active page each turn (via the tracker), so this is an
inconsistency, not a parallel design.

```ts
export async function executeBranchedStep(group, totalSteps, opts) {
  const page = pageTracker ? pageTracker.getActive() : opts.page;
  // ...
  while (Date.now() < deadline && pollCount < maxPolls) {
    const domSnapshot = await captureDomSnapshot(page, ...);   // same `page` every iteration
    const screenshot = await captureScreenshot(page, ...);
    // never re-reads tracker.getActivePage()
  }
}
```

## Why it's not breaking anything today

Branched steps are by design simple if/else state-detection blocks —
the AI looks at the page, picks one of N pre-declared outcomes, and
then `executeStep` runs the matched outcome's instruction normally.
Authors don't typically use branched steps for multi-browser
orchestration; if they did, the branched evaluator would still see
**the page that was active at branched-step entry**, which is usually
right.

The case it's wrong: a branched step is itself preceded by a
`switchBrowser` action emitted by the same evaluator's prior step, AND
the polling loop runs more than one poll. In practice the tracker is
already pointing at the right session before the branched step starts,
because the test-runner refreshes between steps. So today this is
unreachable.

## Defensive fix

Inside the polling loop, refresh from the tracker on each iteration:

```ts
while (Date.now() < deadline && pollCount < maxPolls) {
  const activePage = opts.browserTracker
    ? opts.browserTracker.getActivePage()
    : (pageTracker?.getActive() ?? opts.page);
  const domSnapshot = await captureDomSnapshot(activePage, ...);
  // ...
}
```

Mirrors the refresh logic at [step-executor.ts:347](../src/runner/step-executor.ts#L347)
in the flat-step path.

## Decision

Defer. Branched + multi-browser is a contrived combo. Revisit when:
- Either feature gains a use case where the combo matters, **or**
- A user reports a stale-page issue inside a branched step.
