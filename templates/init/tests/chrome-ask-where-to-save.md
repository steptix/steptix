---
tags: [computer, chrome-settings]
timeout: 600s
---

# Chrome — turn on "Ask where to save each file before downloading"

An example of a desktop-first test: it drives a Chrome window that is already
open, without launching a browser of its own. It was written as setup for a
Save As test that has since been removed (docs/specs/SPEC-use-computer.md §14),
and stays as a worked example of reading and flipping a setting from the
screenshot alone. Note that it changes a real setting in whichever Chrome
profile is on screen.

The whole test runs on the computer surface, so it never asks Playwright to
navigate a `chrome://` page: it focuses the Chrome window, types the settings
URL into the address bar, and flips the toggle from the screenshot. Because
the first step is `[use computer]`, no browser is launched — the test drives
whichever Chrome is on screen, so have Chrome open on the primary display
before running it.

Machine requirements are the same as every computer-mode test: a visible,
unlocked desktop, and hands off the mouse while it runs.

## Steps
1. [use computer]
2. Focus the window whose title contains "Google Chrome"
3. Press Ctrl+L
4. Type "chrome://settings/downloads" and press Enter
5. Wait until the Downloads settings page is showing
6. If the "Ask where to save each file before downloading" toggle is off, then Click the "Ask where to save each file before downloading" toggle
7. Verify the "Ask where to save each file before downloading" toggle is on
