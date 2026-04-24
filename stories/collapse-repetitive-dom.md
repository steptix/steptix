# Collapse repetitive DOM runs (large tables & lists)

## Context

`captureDomSnapshot` ([src/browser/dom-cleaner.ts](../src/browser/dom-cleaner.ts#L22)) currently emits `<body>` and its tree almost verbatim — every element, every attribute, every text node. The only size control is a blunt 100,000-char truncation at the tail.

This falls over on real pages that contain one or two very large repetitive structures:

- A transactions/orders table with 500 `<tr>` rows
- A search-results list with 200 `<li>` items
- A virtualized-looking grid rendering hundreds of sibling `<div class="card">`

On these pages the snapshot gets cut mid-element by the truncation cap, the AI loses the footer/nav/submit buttons, and `find` (capped at 10 matches) is the only way back in. The "compact DOM" layer that used to guard against this was removed when we moved to the raw-DOM approach; nothing replaced it.

## Goal

Preserve the raw-DOM philosophy for *unique* page content (forms, headers, navigation, dialogs) but collapse *repetitive sibling runs* (table rows, list items, card grids) into a head + tail + omission marker that tells the AI how many items are there and how to address any specific one.

Must be gated behind a config flag (`browser.collapseRepetitiveDom`, default **off**) so it can be adopted site-by-site and rolled back instantly.

## Non-goals

- Collapsing unique content (don't touch `<form>`, `<nav>`, `<header>`, dialogs).
- Replacing the 100k char truncation. It stays as a final safety net.
- Reworking `find`/`expand` semantics. Downstream improvements (scoped find, higher cap, total count) are tracked as follow-ups, not part of this story.

## Design

### Detection heuristic

Inside `processChildNodes` in [buildDomCleanerScript](../src/browser/dom-cleaner.ts#L177), before emitting element children, identify **repetitive runs** among contiguous element siblings:

A run is a maximal sequence of consecutive element children where:
- All elements share the same `tagName` (compared lowercase — HTML DOM returns uppercase `tagName`, SVG/XML can be mixed; normalising makes both behave identically).
- Pure-whitespace text nodes between siblings are transparent (don't break the run); any other text node or mismatched tag terminates it.
- The run length is `>= COLLAPSE_MIN_RUN` (default **50**).

The threshold is deliberately high. Lower values (e.g. 20) would collapse things like 25-link nav menus and 30-option country `<select>`s where the AI typically needs every item individually addressable. 50 catches the pathological case (tables/lists with hundreds of rows) without disturbing ordinary UI structures.

When detected, emit:

```html
<tr>…row 1 verbatim…</tr>
<tr>…row 2 verbatim…</tr>
<tr>…row 3 verbatim…</tr>
<!-- 495 similar <tr> elements omitted (indices 4..498). Use find "<text>" to locate,
     or the nth-of-type selector "tbody > tr:nth-of-type(N)" to target one directly. -->
<tr>…last row verbatim…</tr>
```

Tunables (constants in the script, not config — we can promote to config later if needed):
- `COLLAPSE_MIN_RUN = 50` — below this, keep verbatim.
- `COLLAPSE_HEAD = 3` — how many leading items to render in full.
- `COLLAPSE_TAIL = 1` — how many trailing items to render in full.

Tag-equality is sufficient to start; we don't need attribute-shape similarity as a secondary gate. Adding it later would catch mixed-tag runs (`<div>` + `<div class="divider">`) but costs complexity; defer.

### Stable addressing in the omission marker

The marker must name a selector pattern the AI can copy into a click/read/expand. `nth-of-type` is the right primitive because it survives sibling-tag heterogeneity that `nth-child` doesn't:

```
tbody > tr:nth-of-type(N)
```

For the AI to build a full selector, the marker needs to know its parent's own selector. Use the same `buildSelector` helper already in the script to describe the parent once in the marker.

### Interaction with `find`

After collapse, `find` becomes the primary way into omitted rows (searching by visible text). The walker runs against the *live DOM*, not the snapshot, so it's unaffected by collapse and will still find matches inside omitted rows.

Three improvements to `find` ship in this story so collapsed-run workflows don't hit the old pain points:

- **Display cap raised from 10 to 50**, and the walker now keeps counting past the cap up to a hard max of 500. The caller reports "Found 50 of 247 matches" so the AI knows to refine rather than assume those 10 were all there was.
- **Optional container scope.** The AI can set `"selector"` on the find action to a CSS selector (e.g. `"#orders-table"`) and the walker only traverses that subtree. Narrowing scope produces tighter results and skips hitting the cap.
- **Stable selectors for bare-tag matches.** When a matched element has no direct `data-testid`/`id`/`name`/`aria-label`, the returned selector is now a chained `nth-of-type(N)` path anchored at the nearest addressable ancestor — e.g. `#orders > tr:nth-of-type(42) > td:nth-of-type(3)` instead of the old bare `td`. This makes every match directly actionable without the AI having to guess at ancestor context.

### Interaction with `expand`

`expand` still works: given a row selector (e.g. `tbody > tr:nth-of-type(42)`), it emits the full subtree. No change to its implementation.

### Interaction with iframes

`captureDomSnapshot` emits each iframe as a `[iframe:N]` placeholder; `injectFrameContent` then walks every iframe on the page in DOM order via Playwright's locator and fills them in. The counters must stay aligned. When an iframe lives inside an omitted subtree we don't emit its placeholder, but we must still bump `iframeIdx` so subsequent (non-omitted) iframes get the right index. `countIframesIn` walks each omitted subtree purely to count iframes and advance the counter.

### Feature flag

Add `browser.collapseRepetitiveDom?: boolean` to `BrowserConfig`, default `false`. `captureDomSnapshot` reads it and passes it into the browser script, which branches on it.

When **off**: current behavior, byte-for-byte.
When **on**: collapse applies.

### Prompt updates

[src/ai/prompts.ts:156-157](../src/ai/prompts.ts#L156-L157) currently describes `find`/`expand` in terms of "compact DOM" and "collapsed summary". Those references are already stale but become actively misleading once collapse ships. Rewrite them to mention the omission markers explicitly: "When you see a `<!-- N similar X elements omitted -->` marker, use `find` to locate a specific item by text, or construct an `nth-of-type(N)` selector from the parent selector shown in the marker."

Also clean up the stale "(compact)" header in [src/ai/diagnose.ts:155](../src/ai/diagnose.ts#L155).

## Implementation plan

1. Add `collapseRepetitiveDom?: boolean` to `BrowserConfig` in [src/config/types.ts](../src/config/types.ts) (default undefined = false; no change to `DEFAULT_CONFIG`).
2. Thread the flag into `captureDomSnapshot(page, opts?)` — opts-last so callers that don't care don't break.
3. Update call sites in step-executor / diagnose / fsd-repl to pass `config.browser.collapseRepetitiveDom`.
4. In `buildDomCleanerScript`, accept a `collapse` param, and in `processChildNodes` detect + emit runs.
5. Update prompt text in [src/ai/prompts.ts](../src/ai/prompts.ts).
6. Clean up stale "compact" wording in [src/ai/diagnose.ts](../src/ai/diagnose.ts) and [src/browser/dom-cleaner.ts](../src/browser/dom-cleaner.ts#L386).

## Testing

- Flag off: all existing DOM snapshots unchanged (spot-check against a recorded report).
- Flag on, small page: no collapse applied (no run hits the threshold).
- Flag on, large table page: `<tbody>` emits 3 rows + marker + 1 row; marker names the count and parent selector; snapshot size drops from >100k to well under.
- Flag on, mixed content page: `<form>`, `<nav>`, `<header>` untouched; only the large list/table collapsed.
- `find` on a text that lives inside an omitted row still returns it with an actionable selector.
- `expand` on an `nth-of-type(N)` selector built from the marker works.

## Rollout

1. Land behind flag, default off.
2. Turn on for a known-bad page (one with a big table). Verify AI completes the test.
3. Leave flag off by default for the next release cycle; flip default to on once confidence is high.
4. Promote `COLLAPSE_MIN_RUN` / `HEAD` / `TAIL` to config if any site needs different tuning.

## Follow-ups (not in this story)

- Structure-aware 100k truncation (compress largest remaining run further instead of tail-cutting).
- Allow regex / attribute matching in `find` (currently substring over `textContent`).
- Promote `COLLAPSE_MIN_RUN` / `HEAD` / `TAIL` to config if any site needs different tuning.
