---
tags: [computer, chrome-settings]
timeout: 600s
---

# Chrome — turn on "Ask where to save each file before downloading"

A one-off setup step for [pdf-save-as.md](pdf-save-as.md), run once per
Chrome profile. Chrome's PDF viewer saves a document through the download
system, and with this setting off (the default) a "Save as..." from the
viewer's context menu downloads silently to the Downloads folder — no dialog
ever appears, and a test waiting for a window titled "Save As" waits for
nothing. Measured live on 2026-09-23 (docs/specs/SPEC-use-computer.md §14).

The whole test runs on the computer surface, so it never asks Playwright to
navigate a `chrome://` page: it focuses the Chrome window, types the settings
URL into the address bar, and flips the toggle from the screenshot. Because
the first step is `[use computer]`, no browser is launched — the test drives
whichever Chrome is on screen. Run it against the CDP profile the Save As
test will use, with that Chrome already open and on the primary display.

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
