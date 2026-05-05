# 006 — `BrowserTracker.closeAll` doesn't route CDP sessions through `closeBrowser`

**Status:** open / defensive
**Area:** [src/browser/manager.ts](../src/browser/manager.ts) — `BrowserTracker.closeAll`
**Opened:** 2026-05-05

## Summary

`closeAll` iterates tracked sessions and calls `context.close() +
browser.close()` directly. The existing `closeBrowser(session)` helper
in the same module already handles CDP teardown correctly (severs the
WebSocket without killing the user's Chrome, optionally closes the
specific tab the test opened) — but `closeAll` doesn't use it.

```ts
async closeAll(): Promise<void> {
  for (let i = this.sessions.length - 1; i >= 0; i--) {
    const { label, session } = this.sessions[i]!;
    try {
      await session.context.close();
      await session.browser.close();    // ← would kill user's Chrome if session was CDP
    } catch (err) { ... }
  }
}
```

## Why this isn't broken today

CDP sessions don't enter the tracker today — the test runner's `finally`
checks `initialSession.cdp` and routes CDP through `closeBrowser`
directly, bypassing the tracker entirely. `openBrowser` always calls
`launchBrowser(...)` for fresh sessions, never CDP-attach. So every
session that does enter the tracker is a fresh non-CDP one, and
`closeAll`'s blunt teardown is correct for those.

## Why it's still a footgun

A future refactor that lets CDP sessions enter the tracker — e.g.
"register the CDP attach as `default` in the tracker for prompt
grounding consistency" — would silently call `browser.close()` on the
user's real Chrome. That's a bad day for a developer running tests
against their personal browser.

## Defensive fix

Route every entry through the existing helper:

```ts
async closeAll(): Promise<void> {
  for (let i = this.sessions.length - 1; i >= 0; i--) {
    const { label, session } = this.sessions[i]!;
    try { await closeBrowser(session); }
    catch (err) { logger.debug(`Error closing browser "${label}" — ${err}`); }
  }
  this.sessions.length = 0;
}
```

Same for `BrowserTracker.close(label)`. ~6 lines of change. Unblocks
issue [002](002-cdp-and-multi-browser-interaction.md) too — once
CDP sessions can safely enter the tracker, the special-case branch in
test-runner's `finally` collapses.

## Decision

Defer the fix until issue 002 is being addressed (they're naturally
linked — CDP+multi-browser handling needs both). The current code is
correct for everything reachable today.
