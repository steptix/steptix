---
tags: [computer, pdf]
timeout: 600s
---

# PDF — open the print dialog and cancel it

Drives a PDF served by the fixture app (`fixtures/test-app/statement.pdf`,
port 8787) and proves the one thing browser mode cannot do: reach a dialog
that is not in the page. This is the acceptance test for
[docs/specs/SPEC-use-computer.md](../../../docs/specs/SPEC-use-computer.md) §7.

Chromium shows a PDF in its own viewer, whose toolbar is not in the DOM. The
Print button on it opens a dialog that is not in the tab at all. Nothing CDP
can see or touch reaches either — so in browser mode a step like *Click Cancel
in the Print dialog* gets a DOM snapshot with no dialog in it and can only
guess. Steps 3 to 8 run on the COMPUTER surface instead, where the toolbar and
the dialog are both just pixels on the screen.

**Which surface each block runs on:**

- Steps 1–2 — browser. Ordinary page steps: Playwright navigates, the model
  answers from a DOM snapshot.
- Steps 3–8 — computer. From `[use computer]` on, every step is answered from
  a screenshot of the whole primary display, and the framework performs the
  model's answer with a real mouse and real keystrokes.
- Steps 9–10 — browser again. `[use browser]` returns to the same tab the test
  left; the browser was never touched by the switch.

**Step 4 matters more than it looks.** `[use computer]` does nothing to
arrange the screen — it changes what the model is shown and how the answer is
performed, and nothing else. When a run starts from TestBench, VS Code is
frontmost and the browser is behind it, so without step 4 the first screenshot
is a picture of the editor. `Focus the window whose title contains
"statement.pdf"` is what brings the browser forward. (Chromium titles the
window after the file, which is why the PDF carries no `/Title` of its own.)

**Either print dialog passes.** Chromium's Print button normally opens
Chromium's OWN print preview, a separate web contents laid over the tab. With
`--disable-print-preview` — which `templates/init/aiui.config.json` passes via
`browser.launchArgs` — it opens the operating system's print dialog instead.
Both are outside the page, both are what this test is about, and both have a
Cancel button, so steps 6 to 8 are written to pass against either. Neither is
reachable from browser mode.

**What the machine must look like.** A computer-mode run drives the real
mouse and the real keyboard:

- The desktop must be visible and unlocked. A locked screen, a screensaver or
  a disconnected RDP session captures black and the model sees nothing.
- **Do not touch the mouse or the keyboard while it runs.** A stray click
  moves focus and the next screenshot no longer shows what the model was
  answering about.
- One computer-mode run per machine — two would fight over the one mouse.
  The framework enforces this with a lock file; the parallel live suite keeps
  computer-mode tests out of the shards for the same reason (see CLAUDE.md,
  "Computer-mode live test").
- The project must opt in: `desktop.enabled: true` in `aiui.config.json`.
- The server must be able to read the screen. A server started by a sandboxed
  spawner cannot (measured — see the spec's §5.1), so start it from a normal
  terminal or from VS Code.

Screenshots taken in computer mode are of the WHOLE screen, not of the page,
and they are embedded in the report. Set `desktop.reportScreenshots: false`
to keep them out of it.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to statement.pdf
2. Wait for the PDF to finish loading
3. [use computer]
4. Focus the window whose title contains "statement.pdf"
5. Click the Print button in the PDF viewer's toolbar
6. Wait until the Print dialog is showing
7. Click the Cancel button in the Print dialog
8. Wait until the Print dialog has closed
9. [use browser]
10. Verify the page URL ends with statement.pdf
