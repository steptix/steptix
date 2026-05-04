---
type: skill
---

# dismiss_obstacles

Reusable pre-step hook that checks for common unexpected UI obstacles (cookie
banners, announcement banners, full-screen overlays) and dismisses them if
visible, so the main step has a clean page to work with.

The skill returns successfully whether or not an obstacle was found — it's a
no-op when the page is already clean.

Intended use: as a `beforeEach` hook in a test's `## Hooks` section, or as a
project-level default hook in `aiui.config.ts`:

```yaml
execution:
  defaultHooks:
    beforeEach: ['[skill: dismiss_obstacles]']
```

## Steps
1. If a cookie consent banner, announcement banner, or full-page promotional overlay is currently visible and is NOT the element the user is about to interact with, dismiss it by clicking its Accept / OK / Close / Dismiss button. If no such obstacle is visible, do nothing and consider this step satisfied
