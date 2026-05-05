# 009 — `BrowserTracker` mock in test-runner-clarification-control test is hand-rolled

**Status:** open / low priority
**Area:** [tests/test-runner-clarification-control.test.ts](../tests/test-runner-clarification-control.test.ts) — `vi.mock('../src/browser/manager.js', ...)`
**Opened:** 2026-05-05

## Summary

The test mocks `../src/browser/manager.js` with a hand-rolled stub
class for `BrowserTracker`:

```ts
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args) => launchBrowserMock(...args),
  closeBrowser: (...args) => closeBrowserMock(...args),
  BrowserTracker: class {
    constructor(initial) { this.session = initial; }
    getActive() { return this.session; }
    getActivePage() { return this.session.page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() { closeBrowserMock(this.session); }
    list() { return []; }
    get count() { return 1; }
  },
}));
```

When we add new methods or properties to the real `BrowserTracker`,
this stub silently falls behind — calls into the new methods will
throw `TypeError: this.tracker.newMethod is not a function` from
production code paths the mock doesn't cover.

## Cleaner alternative

`vi.importActual` partial mock — keep the real `BrowserTracker` and
mock only the bits the test needs to control:

```ts
vi.mock('../src/browser/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/manager.js')>();
  return {
    ...actual,
    launchBrowser: (...args) => launchBrowserMock(...args),
    closeBrowser: (...args) => closeBrowserMock(...args),
    // BrowserTracker passes through unchanged from `actual`
  };
});
```

The catch: `BrowserTracker` constructor calls `logger.info` which is
fine, but its `closeAll`/`close` call `session.context.close()` and
`session.browser.close()` — the test passes a fake session that
doesn't have those methods. Either:
1. Beef up the fake session to have stubs for `context.close()` /
   `browser.close()`, OR
2. Keep the hand-rolled stub but flag this as a maintenance hazard.

## Decision

Low-priority cleanup. The hand-rolled stub works today and the test
suite catches drift via "Cannot find name X" if the real module's
shape changes (constructor signature, etc.).

Fold into the next refactor that touches `BrowserTracker`'s public
surface, or earlier if it bites.
