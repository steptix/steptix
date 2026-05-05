# 005 — `BrowserTracker.close` promotes the next session to active (not `default`)

**Status:** open / accepted for now
**Area:** [src/browser/manager.ts](../src/browser/manager.ts) — `BrowserTracker.close`
**Opened:** 2026-05-05

## Summary

When the active browser is closed and other tracked sessions remain,
the active pointer falls on whichever session now occupies the same
index — effectively "promote next browser to active." It does NOT
automatically fall back to `default`.

Walk-through with `sessions = [default, edge, firefox]`, `activeIndex = 1`:

1. Author calls `closeBrowser as="edge"`.
2. `splice(1, 1)` → `sessions = [default, firefox]`, length 2.
3. `activeIndex (1) >= length (2)` ? No.
4. `activeIndex (1) > idx (1)` ? No.
5. `activeIndex` stays at `1` → now points at `firefox`.

If the author closed the last entry, the pointer drops to the new last
entry. If everything's closed, `activeIndex = 0` but `sessions.length = 0`
and `getActive()` throws — the resolved permissive policy.

## Why this rule

The alternative — "always fall back to `default` when the active browser
is closed" — special-cases `default` and contradicts our other resolved
decision: `default` is just a label, not magical
([stories/multi-browser.md](../stories/multi-browser.md) "Resolved
decisions"). One-rule consistency over hand-holding.

## When this could surprise an author

```markdown
1. (default Chrome — active)
2. [openBrowser as="edge" ...]      # active now: edge
3. [openBrowser as="firefox" ...]   # active now: firefox
4. [closeBrowser as="firefox"]      # active falls back to edge (the new index 2 → drops to 1)
                                    # author may have expected default
```

Surprise? Mild. The test-info block's `Active Browser:` line shows the
new active label on the very next prompt, so the AI sees the change
explicitly. A human author reading the test will too, if they look.

## Mitigation if surprise becomes a real issue

Add an explicit `[switchBrowser to="default"]` after every `closeBrowser`
in test docs, OR change `closeBrowser` to take an optional
`activate="<label>"` arg so authors can be precise about where to land.

## Decision

Keep "promote next" for Phase 1. Document in user-facing docs when those
get written. Revisit when:
- A real test trips on the surprise, **or**
- We end up writing more than one tutorial paragraph explaining it.
