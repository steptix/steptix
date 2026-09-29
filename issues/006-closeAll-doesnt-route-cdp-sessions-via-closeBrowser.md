# 006 — `BrowserTracker.closeAll` doesn't route CDP sessions through `closeBrowser`

**Status:** RESOLVED 2026-08-04 — fixed as part of
[stories/mcp-cdp-browser.md](../stories/mcp-cdp-browser.md) W7
**Area:** [src/browser/manager.ts](../src/browser/manager.ts) — `BrowserTracker.closeAll` / `close`
**Opened:** 2026-05-05

## Summary

`closeAll` iterated tracked sessions and called `context.close() +
browser.close()` directly. The existing `closeBrowser(session)` helper
in the same module already handles CDP teardown correctly (severs the
WebSocket without killing the browser, closes only the tab the test
itself opened) — but `closeAll` didn't use it.

```ts
async closeAll(): Promise<void> {
  for (let i = this.sessions.length - 1; i >= 0; i--) {
    const { label, session } = this.sessions[i]!;
    try {
      await session.context.close();
      await session.browser.close();    // ← the worry: would this kill the user's Chrome?
    } catch (err) { ... }
  }
}
```

## What the original analysis got wrong

It said CDP sessions never enter the tracker, because "the test runner's
`finally` checks `initialSession.cdp` and routes CDP through
`closeBrowser` directly, bypassing the tracker entirely."

Two corrections:

1. **A CDP session always entered the tracker.**
   `new BrowserTracker(initialSession)` takes whatever the session is —
   [test-runner.ts:249](../src/runner/test-runner.ts:249) and
   [session-manager.ts:1337](../src/server/session-manager.ts:1337). What
   the CLI runner special-cases is only which teardown *route* it takes.
2. **The server path had no such special case.**
   `SessionManager.closeSession` calls `session.browserTracker.closeAll()`
   unconditionally — and that is the path Steptix, flick and the MCP
   server all use. So CDP sessions were reaching this code every day.

## What was actually happening

Not the feared outcome. Measured on Windows 11 against Chrome
150.0.7871.187 and Edge 151.0.4129.59, both engines identical:

| Call, against a `connectOverCDP` connection | Effect |
| --- | --- |
| `context.close()` on the default context | resolves, **no-op** — browser alive, every tab intact, including the test's own |
| `browser.close()` | severs the WebSocket, browser alive |
| both, then all connections closed | browser still alive |

Nothing was ever destroyed: Playwright's CDP-connected default context
does not own the browser, and neither call can take it down.

The real defect was the opposite of the one described — a **leak, not a
kill**. Only `closeBrowser` knows about `cdpTabOpenedByUs`, so going
around it meant the tab the test opened was never closed. Every CDP run
through the server left a blank tab behind in the user's browser.

Tolerable while CDP was a `## Config` line someone hand-wrote
occasionally. Not tolerable once agents got a tool to launch and drive
CDP browsers, which is what made this worth fixing now — exactly the
"blast radius grows" case this issue anticipated, arriving by a
different route than expected.

## Fix

Both `closeAll` and `close(label)` now route through the existing
helper:

```ts
await closeBrowser(session);
```

Behaviour for non-CDP sessions is byte-identical — `closeBrowser`'s
non-CDP arm is exactly `context.close()` then `browser.close()`.

Covered by
[tests/cdp-teardown-invariant.test.ts](../tests/cdp-teardown-invariant.test.ts):
CDP teardown never closes the context, closes the test's own tab and only
that one, leaves a pre-existing tab alone, and is unchanged for non-CDP.

## Knock-on

Unblocks [002](002-cdp-and-multi-browser-interaction.md) as originally
noted: with the tracker safe for CDP sessions, the special-case branch in
test-runner's `finally` can collapse. Not done here — that is a
simplification rather than a fix, and the CLI path has its own
video-finalisation ordering to keep straight.
