# 002 — CDP attach + multi-browser openBrowser interaction is undefined

**Status:** open / deferred
**Area:** [src/runner/test-runner.ts](../src/runner/test-runner.ts) — finally block
**Opened:** 2026-05-05

## Summary

When the initial browser session is a CDP attach (the test runs against
a user's existing Chrome over `--remote-debugging-port`), the test-runner's
`finally` calls `closeBrowser(initialSession)` and skips
`browserTracker.closeAll()`. If a step in that test ALSO called
`openBrowser`, the freshly-launched browser leaks — its process keeps
running until the OS reaps it.

```ts
if (initialSession.cdp) {
  await closeBrowser(initialSession);          // handles CDP correctly
} else {
  await browserTracker.closeAll();             // handles fresh sessions
}
// ↑ either branch runs, never both — fresh sessions added to the tracker
//   when initial is CDP are never closed.
```

CDP attach is a niche dev workflow ("debug against my real Chrome with
an existing session") and combining it with `openBrowser` isn't a
documented use case. But the current behavior is silent: no error, no
warning, just leaked processes.

## Options

1. **Reject upfront.** When `initialSession.cdp` is true and `openBrowser`
   fires, return a clear error: "openBrowser is not supported in CDP attach
   mode." Smallest change, clearest failure mode.
2. **Handle both paths in finally.** Run `closeAll()` against
   non-CDP-tracked sessions, then `closeBrowser(initialSession)`. Requires
   tagging tracked sessions with their type and routing per-entry.
3. **Status quo.** Document the limitation and accept the leak — CDP users
   are advanced anyway.

## Decision

Defer. No real user has hit this; CDP + multi-browser is a niche on a niche.
Revisit when:
- The combination shows up in a real test, **or**
- A user reports leaked processes from this path.

When we do, **option 1 (reject upfront)** is the right starting point —
fewer moving parts than option 2 and it's easy to relax later.
