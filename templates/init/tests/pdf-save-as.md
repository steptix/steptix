---
tags: [computer, pdf]
timeout: 600s
---

# PDF — save it to a temp folder through the native Save As dialog

> **Status: not yet passing live** (2026-09-23, spec §14). Two things about
> Chrome stand in the way, neither of them about the computer surface. Under
> a Playwright-launched Chromium the native Save As dialog can never appear,
> because Playwright routes every download to its own folder with no file
> chooser — so this test must run in a real Chrome attached over CDP
> (session `config.cdp`, launched with `POST /cdp/browsers`). And even there,
> with "Ask where to save each file before downloading" turned on (run
> [chrome-ask-where-to-save.md](chrome-ask-where-to-save.md) first — it does
> that on the computer surface), the viewer's "Save as..." still saved
> silently in the measured run. The step list below is the intended shape;
> steps 1–5 pass, step 6 is where it waits for a window that does not come.

The second half of [docs/specs/SPEC-use-computer.md](../../../docs/specs/SPEC-use-computer.md)
§7, and the harder one. Its sibling
[pdf-print-cancel.md](pdf-print-cancel.md) opens a dialog and closes it again,
so the only evidence it worked is that the dialog appeared. This one drives a
dialog to completion — a context menu, a native **Save As** window, a typed
path, a possible overwrite confirmation — and then checks the result somewhere
the browser cannot see at all: a file on disk.

That last check is why `[tool: assert_file_exists]` exists
(`fixtures/tools/src/assert_file_exists.ts`). Nothing in the browser
vocabulary can look at the file system; the page never sees it.

**Which surface each block runs on:**

- Steps 1–2 — browser. Playwright navigates and waits for the viewer.
- Steps 3–9 — computer. Every step is answered from a screenshot of the whole
  primary display, and performed with a real mouse and real keystrokes. The
  context menu in step 5 and the Save As window in steps 6–9 are native
  windows; neither is in the page, and neither is reachable from browser mode.
- Steps 10–11 — browser again. The tool in step 11 runs server-side and
  touches no surface, but it is written after `[use browser]` so the session
  does not end holding the computer lock.

**Step 4 matters more than it looks.** `[use computer]` does nothing to
arrange the screen — it changes what the model is shown and how the answer is
performed, and nothing else. When a run starts from TestBench, VS Code is
frontmost and the browser is behind it, so without step 4 the first screenshot
is a picture of the editor. `Focus the window whose title contains
"statement.pdf"` is what brings the browser forward.

**Step 8 is a condition, not a step that must run.** Windows shows
*Confirm Save As* only when the file is already there — that is, on the second
and later runs of this test. The `If … then` form means the first run skips it
and a repeat run answers it, with no editing in between.

**`AIUI_SAVE_DIR` is yours to set**, in `templates/.env` beside the other
values this fixture suite reads (`$GITHUB_USERNAME`, `$BANK_PASSWORD`, …).
That file is gitignored, so a fresh checkout has to add the line:

```
AIUI_SAVE_DIR=C:\Users\<you>\AppData\Local\Temp
```

It is a `$VAR` parameter rather than `$TEMP` on purpose. A `## Parameters`
value spelled `$NAME` resolves from **`.env`** when the run comes from
TestBench — the extension composes its env map from `.env` plus a `.env.<name>`
overlay and has no `process.env` baseline layer — and from `process.env` when
the run comes from the CLI. `$TEMP` would therefore work from `aiui run` and
arrive at the Save As dialog as the literal string `$TEMP` from TestBench,
which is the worse of the two failures: the dialog happily accepts it as a
folder name. A name that only ever lives in `.env` resolves the same way from
both.

**What the machine must look like.** A computer-mode run drives the real
mouse and the real keyboard:

- The desktop must be visible and unlocked. A locked screen, a screensaver or
  a disconnected RDP session captures black and the model sees nothing.
- **Do not touch the mouse or the keyboard while it runs.** A stray click
  moves focus and the next screenshot no longer shows what the model was
  answering about — and here a stray keystroke can land in the File name
  field.
- One computer-mode run per machine — two would fight over the one mouse.
  The framework enforces this with a lock file; the parallel live suite keeps
  computer-mode tests out of the shards for the same reason (see CLAUDE.md,
  "Computer-mode live test").
- The project must opt in, with `desktop.enabled` set to true in
  `aiui.config.json`.
- The server must be able to read the screen. A server started by a sandboxed
  spawner cannot (measured — see the spec's §5.1), so start it from a normal
  terminal or from VS Code.

Screenshots taken in computer mode are of the WHOLE screen, not of the page,
and they are embedded in the report — including the Save As dialog's view of
your file system. Turn `desktop.reportScreenshots` off to keep them out.

## Parameters
- save_dir: $AIUI_SAVE_DIR

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to statement.pdf
2. Wait for the PDF to finish loading
3. [use computer]
4. Focus the window whose title contains "statement.pdf"
5. Right-click in the middle of the PDF page and choose "Save as..." from the context menu
6. Wait until a window titled "Save As" is open
7. Type "{{save_dir}}\aiui-statement.pdf" into the File name field and click Save
8. If a window titled "Confirm Save As" is open, then Click the Yes button
9. Wait until the window titled "Save As" is gone
10. [use browser]
11. [tool: assert_file_exists path="{{save_dir}}\aiui-statement.pdf"]
