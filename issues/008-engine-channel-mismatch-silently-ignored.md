# 008 — `engine='firefox' channel='msedge'` silently uses firefox

**Status:** open / accepted for now
**Area:** [src/browser/manager.ts](../src/browser/manager.ts) — `launchBrowser` switch
**Opened:** 2026-05-05

## Summary

`launchBrowser`'s engine switch only consults `channel` inside the
chromium branch. If an author writes
`[openBrowser as="x" engine="firefox" channel="msedge"]`, firefox is
launched and the channel is silently dropped. No warning, no error.

```ts
switch (browserType) {
  case 'firefox':
    browser = await firefox.launch(launchOptions);    // channel not consulted
    break;
  case 'webkit':
    browser = await webkit.launch(launchOptions);     // channel not consulted
    break;
  case 'chromium':
  default: {
    const effectiveChannel = channel ?? 'chrome';     // only here does channel matter
    // ...
  }
}
```

## Why this is a footgun

Authors writing multi-browser tests are still building the mental model.
A reasonable but wrong incantation like
`engine="firefox" channel="msedge"` should fail with "channel is only
meaningful for engine=chromium" — instead, the author thinks they got
Edge but actually got Firefox, and the test does something
inexplicable.

## Fix

Reject the combo at action-parse time:

```ts
// in src/ai/action-parser.ts, after extracting engine/channel:
if (action.action === 'openBrowser'
    && action.channel
    && action.engine
    && action.engine !== 'chromium') {
  throw new Error(
    `openBrowser action at index ${index}: "channel" is only valid for engine=chromium, got engine="${action.engine}". Drop "channel" or change engine.`,
  );
}
```

~5 lines of code + 1 test.

## Decision

Defer for Phase 1. Low risk in practice (authors of the binding fixture
got it right; the prompt rule documents the pattern). Revisit when:
- Someone hits the silent-drop mode in a real test, **or**
- We do a Phase 2 hardening pass on `openBrowser` validation.
