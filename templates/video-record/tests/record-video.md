---
tags: [live-integration]
---

# Video-recording live test

Minimal, network-free fixture for the live video-recording test
(`testbench-native/tests/integration/live/video-recording.test.cjs`).

This fixture lives in its **own project** (`templates/video-record/` has its own
`aiui.config.json` with `browser.video: "on"`) so recording is enabled for this
test ONLY — the other live fixtures under `templates/init/` keep video off and
don't accumulate `.webm` files.

The server records the session and finalises a `.webm` when the session is
closed (Tier 1 server behaviour — see `stories/video-recording.md` caveat #7).
The steps are deterministic and offline so the run never flakes.

## Steps
1. Navigate to about:blank
2. Verify the page URL is exactly "about:blank"
