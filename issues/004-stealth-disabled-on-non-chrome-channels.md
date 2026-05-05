# 004 — Stealth plugin disabled when launching non-`chrome` chromium channels

**Status:** open / accepted for now
**Area:** [src/browser/manager.ts](../src/browser/manager.ts) — `launchBrowser`
**Opened:** 2026-05-05

## Summary

`puppeteer-extra-plugin-stealth` is applied only when the chromium
channel is `chrome`. For `msedge`, `chrome-beta`, etc, the plain
`chromium.launch()` driver is used without stealth's monkey-patches.

```ts
if (effectiveChannel === 'chrome' && config.stealth !== false) {
  ensureStealth();
  browser = await stealthChromium.launch(chromeOpts) as unknown as Browser;
} else {
  browser = await chromium.launch(chromeOpts);
}
```

## Reasoning

Stealth's job is to hide automation by patching `navigator.*`,
`window.chrome.*`, plugin lists, and other Chrome-internal markers to
match a real Google Chrome's fingerprint. Applying those patches to a
real Microsoft Edge launch would:

1. Patch Chrome-shaped properties onto an Edge fingerprint, producing a
   *less* convincing identity ("Edge whose internals look like Chrome").
2. Override the Edge UA with a Chrome-shaped one in some plugin paths.

If an author asked for `channel: 'msedge'`, the obvious intent is "I
want a real Edge fingerprint." So we skip stealth and let Edge be Edge.

## Trade-offs

- **+** Edge gets its native fingerprint — what the author asked for.
- **+** Avoids stealth's known incompatibilities with Polymer 1 stacks
  (issue [001](001-css-selector-sanitizer-heuristic.md)... actually
  separate; see `MEMORY.md`).
- **−** Tests against bot-detection-heavy sites (Akamai/Imperva) may
  flag an Edge browser running headless with no human input. The
  current binding fixture targets the local test-app, so this isn't
  exercised yet.

## Open question

Should we expose a per-`openBrowser` `stealth` boolean to override the
default? E.g. `[openBrowser as="edge" channel="msedge" stealth=true]`
forces stealth on Edge anyway — useful if a user really wants the
Chrome-fingerprint patches applied to Edge.

## Decision

Skip stealth on non-`chrome` channels for Phase 1. Revisit when:
- A test against a bot-detection-heavy site needs Edge with stealth, **or**
- A user explicitly requests the override knob.
