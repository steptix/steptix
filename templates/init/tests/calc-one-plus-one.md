---
tags: [computer, native-app]
timeout: 300s
---

# Calculator — 1 + 1 = 2, with no browser at all

A computer-mode test that drives a native application from start to finish
(docs/specs/SPEC-use-computer.md). Step 1 is `[use computer]`, so no browser is
ever launched: the browser launches only when a step runs in browser mode, and
no step here does.

- **Step 2 starts Calculator with a tool**, `open_calculator`
  (`fixtures/tools/src/open_calculator.ts`). Starting a program is left to
  the author on purpose. The model can press keys and click, but nothing it
  reads on the screen can make it launch something. The tool returns as soon
  as the operating system accepts the launch.
- **Step 3 waits for the window** through the operating system's window list,
  and step 4 brings it in front. On Windows `calc.exe` hands over to the
  Store app and exits, so waiting on the window is the only reliable signal.
- **Step 5 types the sum** as `1+1`, with no spaces: in Windows Calculator a
  space presses whichever button has keyboard focus.
- **Step 6 clicks the `=` button** on Calculator's keypad. The model finds it
  in the screenshot and the click lands at that point on the real screen.
  This is what the test is really about: a button in a native window, found
  by sight and clicked by coordinates.
- **Step 7 checks the answer from the screenshot.** That judgement is the
  model's own reading of the display.
- **Steps 8 and 9 close Calculator.** Step 8 brings it in front first, and
  fails the run if it cannot, so the Alt+F4 in step 9 can never land on
  another window.

Why the file is not called `calculator.md`: the window steps match a title
by substring. With a file of that name open in VS Code, the editor's window
title contains "calculator" too, and step 3 could be satisfied by the editor.

Needs a project with `desktop.enabled: true` (this one has it), a server
started from a normal terminal so it can capture the screen, a visible
unlocked desktop, and nobody touching the mouse or keyboard while it runs.

## Steps
1. [use computer]
2. [tool: open_calculator]
3. Wait until a window titled "Calculator" is open
4. Focus the window whose title contains "Calculator"
5. Type "1+1"
6. Click the "=" button on the Calculator
7. Verify the Calculator display shows 2
8. Focus the window whose title contains "Calculator"
9. Press Alt+F4 to close Calculator
