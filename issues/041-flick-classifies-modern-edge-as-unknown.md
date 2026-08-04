# 041 — flick's `classifyEngine` classifies every modern Edge as `unknown`

**Status:** open / in flick only (fixed in the framework copy)
**Area:** [flick-vscode/src/extension/cdp-discovery.ts](../flick-vscode/src/extension/cdp-discovery.ts) — `classifyEngine`
**Opened:** 2026-08-04

## Summary

`classifyEngine` tests `browser.startsWith('Edge/')`. Edge's
`/json/version` reports **`Edg/`**, not `Edge/`:

```
Chrome 150.0.7871.187  →  "Browser": "Chrome/150.0.7871.187"
Edge   151.0.4129.59   →  "Browser": "Edg/151.0.4129.59"
```

Measured directly in the W0 verification for
[stories/mcp-cdp-browser.md](../stories/mcp-cdp-browser.md) against real
browsers on Windows 11.

So no arm matches — `Edg/…` is not `Edge/…`, and Edge's string contains
no `Chrome/` prefix either — and every modern Edge falls through to
`return 'unknown'`.

## Impact

Cosmetic-to-moderate, and confined to flick. A discovered Edge is still
`reachable: true` with its tabs enumerated, so it can be attached to;
it is only *labelled* wrongly. Anything keying off `engine === 'edge'`
(icon, grouping, filtering, a "relaunch same engine" affordance) treats
it as an unidentified browser.

Not a regression — it has presumably never worked, since `Edg/` has been
Edge's user-agent token since the Chromium switch in 2020. It went
unnoticed because the dropdown shows the tabs regardless.

## Fix

```ts
if (browser.startsWith('Edg/') || browser.startsWith('Edge/')) return 'edge';
```

Already done in the framework's copy at
[src/browser/cdp-discovery.ts](../src/browser/cdp-discovery.ts), which
also documents why Edge must be tested before Chrome.

## Decision

**Not fixed in flick here.** stories/mcp-cdp-browser.md §10 makes
`src/browser/cdp-*.ts` canonical and leaves flick's copies unmaintained
pending a decision on flick's future; the convergence path is for flick
to call `GET /cdp/browsers` and delete its own discovery outright rather
than to have two implementations kept in step. Fixing it there now would
be maintaining the copy this story deliberately stopped maintaining.

Recorded so that whoever makes the flick decision knows the copy is not
merely stale but wrong.
