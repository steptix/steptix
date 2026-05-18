---
tags: [live-integration]
---

# Cache-replay live test

Two-step fixture used by the live cache-replay test. Both steps are
deliberately deterministic AI actions (no external network, no
flaky DOM) so a first run hits the AI, the cache populates, and a
second run replays from cache and paints ⚡ glyphs on both lines.

## Steps
1. Navigate to about:blank
2. Verify the page URL is exactly "about:blank"
