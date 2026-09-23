# Computer mode: `[use computer]` and `[use browser]`

**Status:** spec, for build. Medium-large.
**Opened:** 2026-09-23

## 1. What this is

A test can leave the browser and drive the whole screen — the operating
system's own windows, dialogs and menus — with the same natural-language
steps it uses for a page. Two bracket directives switch surface:

```markdown
5. Click the Print button in the PDF viewer's toolbar
6. [use computer]
7. Click the Cancel button in the Print dialog
8. [use browser]
9. Verify the page URL ends with statement.pdf
```

From `[use computer]` on, every step is answered from a screenshot of the
primary display and nothing else: no DOM snapshot, no Playwright. The model
returns screen coordinates and an action; the framework performs it with
nut.js — a real mouse move, a real click, real keystrokes — and takes the
next screenshot. `[use browser]` returns to DOM snapshots and Playwright on
the same tab the test left. The browser is not touched by the switch in
either direction; while in computer mode it is just pixels on the screen
like everything else.

Example step → what happens:

| Step (in computer mode) | What the framework does |
| --- | --- |
| `Focus the window whose title contains "Save As"` | Model emits `focus_window`; nut.js finds the window by title and brings it to the front. No vision involved. |
| `Click the Save button` | Model looks at the screenshot, returns `{"action":"click","x":812,"y":544}`; runtime maps image pixels → screen points and clicks. |
| `Type "C:\Temp\statement.pdf" into the File name field` | Model clicks the field (if needed) then emits `type`; nut.js types into whatever has focus. |
| `Wait until the window titled "Save As" is gone` | Model emits `wait_window` with `state: "gone"`; runtime polls the window list. |
| `Press Ctrl+S` | Model emits `key` with `"ctrl+s"`; nut.js presses the chord. |

A test whose FIRST step is `[use computer]` never launches a browser: the
browser launches when the first step runs in browser mode, and such a test
never has one. That is also how a native application is tested with this
framework.

## 2. Why

Some things a test must drive are not in any page. The case that opened
this: a PDF shown in the browser's built-in viewer, whose toolbar is not
reachable through the DOM, and whose Print and Save As buttons open dialogs
that are not in the tab at all. Chrome's print preview is a separate web
contents laid over the tab; the Save As dialog is a native window. Nothing
CDP can see or touch reaches either — not the screenshot, not the mouse,
not the keyboard, which is delivered to the renderer rather than to whatever
has OS focus. Today a step like `Click Cancel in the print dialog` gets a DOM
snapshot with no dialog in it and a page screenshot with no dialog in it,
and the model can only guess, `noop`, or click something else.

Vision plus coordinates is the one mechanism that behaves the same for a
canvas, a plugin, a browser-owned dialog and an OS dialog, on Windows, macOS
and Linux alike. That uniformity is why the computer surface is pixels-first
rather than accessibility-tree-first (§12 records the tree as deferred).

## 3. Non-goals

- **No per-step surface prefix** (`[use computer] Click Save`). The mode form
  is what was asked for; a one-step form is a natural later addition (§12).
- **No page-surface coordinate click.** Clicking a PDF toolbar button from
  browser mode by coordinates is a separate, smaller feature; in this spec
  the toolbar is clicked in computer mode, where it is pixels like the
  dialog it opens.
- **No accessibility-tree actions** (UI Automation, AX, AT-SPI). Pixels and
  window titles only in v1.
- **No code-behind for computer steps.** Recorded coordinates are specific to
  one machine's resolution, scaling and window layout; §9 excludes them.
- **No multi-monitor capture.** nut.js grabs and clicks the primary display
  only (libnut rejects a point past its edge). What a test drives must be on
  that screen — but `focus_window` now puts it there: a window wholly or
  mostly on another monitor is moved onto the main display (§5.4). A window
  with a usable part already on the main display is left where it is.
- **No Wayland.** libnut is X11 on Linux.
- **Not a way to run two computer-mode tests at once** on one machine (§5.9).

## 4. The directives

### 4.1 Grammar

Two whole-step directives, parsed like `[interactive]` — a bare bracket
token alone as the step, never a sentence for the model:

```
[use computer]     enter computer mode
[use browser]      enter browser mode
```

Shape `[<kind> <name>]` with kind `use`, as the invocation tokenizer in
`src/parser/invocation-parser.ts` reads `[skill login]` and `[tool print_all]`:
case-insensitive, whitespace-tolerant, colon optional (`[use: browser]` is
the same directive). Exactly one name from the closed set {`computer`,
`browser`}; no arguments. Refused at parse time, each with a caret at the
offending word:

- `[use]` — no target; message lists the two.
- `[use phone]` — unknown target; message lists the two.
- `[use computer timeout=30]` — arguments are not accepted.
- `[use computer] and click Save` — the directive is the whole step, the
  `Set` rule. Trailing text is an error, not a second step.

The directive is matched on the AUTHORED line, before `{{…}}` interpolation,
and strips a leading `[no-hooks]` marker itself, for the reason
`set-step.ts` gives (runner-core keeps the marker on the wire).

### 4.2 Unknown whole-step brackets are errors

New rule, and the reason the bracket form was chosen over a sentence: **a
step whose ENTIRE text is a single bracket token that matches no directive
is a parse error**, with the known directives listed and the closest offered
("did you mean `[use computer]`"). Known: `[skill …]`, `[tool …]`,
`[input …]`, `[interactive]`, `[use …]`. So `[computer]`, `[use the
computer]`, `[dekstop]` and `[computer-use]` all fail in the editor and at
run time, and none reaches a model as prose to be answered with a silent
`noop`.

The existing rule that a bracket INSIDE a longer step stays prose is
untouched: `[skillful]` and `Verify the [optional] banner` are unchanged.
Only a step that is nothing but one bracket token is judged.

### 4.3 Resolution order

Rung 1 — bracket directives — of the order documented at the head of
`src/parser/control-line.ts`, beside `[skill:`, `[tool:`, `[input:`,
`[interactive]`. Ahead of the bare-name section match, so a section cannot
shadow it. As a control-line TAIL it is legal: `If a window titled "Save As"
is open, then [use computer]`, because unlike `[input:` and `[interactive]`
it hands nothing back to a human. It may not be a control line's condition.

### 4.4 Where it is recognised

Everywhere a step is classified: the markdown parser (`## Steps` and every
`### Section` body), MCP-supplied steps (`mcp/assemble.ts`), hooks
(`config/loader.ts`) where it is REFUSED (a hook runs on the page surface),
the step grouper, the code-behind classifiers (§9), the session manager's
loop, the CLI runner's loop, and the errand runner, where it is refused in
v1 (an errand is a browser errand). TestBench recognises it through the
runner-core mirror (§10.3).

### 4.5 Mode is session state

- The session holds `surface: 'browser' | 'computer'`, default `browser`.
- `[use computer]` → §5.1 preconditions, then `surface = 'computer'`.
  `[use browser]` → `surface = 'browser'`, computer lock released.
- **Re-entering the mode you are in is a no-op** with a log line, not an
  error. Sections and skills will open with `[use computer]` defensively.
- **A skill call restores the caller's surface on return**, whatever the
  skill's body did. An **inline section does not** — it is inline by
  definition, and a section that switches is the way an author writes a
  desktop excursion once and calls it by name.
- **Session close resets** the surface and releases the lock.
- The surface applies to MCP `run_steps` and to steps posted to the Sessions
  API alike: it is the session's, not the file's.

### 4.6 The browser launches lazily

**The browser launches when the first step executes while the surface is
`browser`.** Not at session creation, and not from the file: TestBench
posts steps one request at a time, so the server cannot know at creation
whether step 1 will be `[use computer]`. A test that opens with it never
triggers the launch; a later `[use browser]` triggers it at the next step
boundary. An API-only test still launches at step 1 as today, so no existing
test changes behaviour, only timing.

What moves:

- `BrowserTracker` gains an unlaunched state. It is constructed with a
  launcher (the closure that today runs at creation) rather than a launched
  session; `ensureLaunched()` runs it once. `getActive()` on an unlaunched
  tracker throws a specific "no browser has been launched in this session"
  error — not the existing "closeBrowser left zero browsers" message, which
  would be a lie. `hasActive()` is added for callers that must not launch.
- The step boundary calls `ensureBrowser()` before any capture when the
  surface is `browser`. The launch is in that ONE place; the switch does not
  launch.
- **Base URL navigation** moves from session creation to the launch. The
  teardown-on-setup-failure around it moves with it.
- Viewport (`## Config: viewport:`), video and CDP options are resolved and
  VALIDATED at creation, exactly as today, and consumed by the deferred
  launch. The `viewport`/`cdp` conflict error still fires at creation.
- A launch failure at step N is that step's failure, with the launch error
  as its message. TestBench needs no change (it is an HTTP client), but the
  error appears one screen later than before.
- Endpoints and tools that read a page — `GET /sessions/:id/content`,
  `POST /sessions/:id/login`, the MCP `peek_tab` / `get_page_content` /
  `focus_cdp_tab` — answer "no browser has been launched in this session"
  when `hasActive()` is false.
- `openBrowser` in a desktop-first test works as is (`add()` pushes and
  promotes). `switchBrowser default` when the default was never launched
  launches it on demand.
- `closeSession` is already correct: `closeAll()` over zero browsers does
  nothing. Video finalisation must tolerate a never-launched main page.
- The CLI runner (`src/runner/test-runner.ts`) follows the same rule, so a
  desktop-only test run from the CLI launches no browser either.

## 5. The computer surface

### 5.1 Entering

On `[use computer]`, in order, each failing the STEP with the message given:

1. **Project opt-in.** `desktop.enabled` (aiui.config.json, default
   `false`) must be `true`. Message: computer mode is disabled for this
   project; set `desktop.enabled: true` in aiui.config.json. A test file in
   a shared project must not be able to move the mouse on a machine whose
   owner did not allow it.
2. **nut.js loads.** `@nut-tree-fork/nut-js` is imported lazily HERE and
   never at server start, so a machine with no prebuilt binary, or no
   permission, still runs every browser test. Message names the package
   and the platform, and for macOS adds the two permissions (§11).
3. **The lock** (§5.9) is free or stale.
4. **A capture succeeds.** One grab is taken as a probe. On failure the
   message includes the measured cause on Windows: *screen capture failed
   (BitBlt error 6); the server process cannot read the screen. Processes
   spawned by some sandboxes lack the window station's read-screen right —
   start the server from a normal terminal or from VS Code.* Measured
   2026-09-23: a process started by the Claude desktop app's tool runner
   can enumerate windows and get a screen DC but cannot blit from it, in
   and out of that tool's own sandbox flag; a .NET `CopyFromScreen` fails
   the same way from the same context.

### 5.2 Capture

`screen.grab()` of the primary display, converted with jimp (a dependency
nut.js already carries) to PNG, downscaled so the longer side is at most
`desktop.maxImageWidth` (default 1600) px. The model is told the image's
pixel size in every message and answers in that space. **Two scale
factors** stand between the model's answer and the mouse:

```
physical = image × (grab.width / image.width)
logical  = physical / grab.pixelDensity.scaleX     (and .scaleY for y)
```

nut.js's mouse takes logical points (`screen.width()` is logical). Both
factors live in one function, `mapToScreen(imagePoint, view)`, with a unit
test for a Retina-style density of 2, a downscale, and both together.

**Computer mode always sends its capture to the model**, regardless of
`ai.sendScreenshots`. That flag governs whether the model sees the PAGE
surface's image alongside a DOM; on the computer surface the image is the
whole surface, and withholding it would leave the model blind. Logged once
per session when the flag is off.

`browser.fullPageScreenshots` does not apply; there is no page.

### 5.3 Zoom

`{"action":"zoom","region":{"x":..,"y":..,"width":..,"height":..}}` in the
coordinates of the image the model was last shown. The runtime crops that
region from the FULL-RESOLUTION grab it already holds, scales it up so its
longer side is `maxImageWidth`, and returns it as the next turn's image with
a note: *zoomed view of region (x, y, w, h) of the previous screenshot;
coordinates you return now are in THIS image.* The runtime keeps the
mapping for whichever image is current, so a click after a zoom lands
where the model pointed in the zoomed view. After any real action the next
capture is a fresh full screenshot. Zoom performs nothing on the screen and
costs one model turn; it is what makes a dialog's small text readable in a
downscaled 4K desktop, and it is not optional for that reason.

### 5.4 Actions

The vocabulary in computer mode. Coordinates are in the current image's
pixel space (§5.2, §5.3). Every action carries `description` as today.

| action | fields | performs |
| --- | --- | --- |
| `click` | `x`, `y`, `button?` (`left` default, `right`, `middle`), `count?` (1 default, 2, 3) | move then click |
| `drag` | `from: {x,y}`, `to: {x,y}` | press, move in steps, release |
| `move` | `x`, `y` | move the pointer (hover) |
| `scroll` | `x`, `y`, `direction`, `amount?` (ticks, default 3) | move then wheel |
| `type` | `text` | type into the focused control |
| `key` | `key` | a key or chord: `enter`, `escape`, `tab`, `ctrl+s`, `alt+f4`, `win+r`, `cmd+shift+g`, `f5`. Names are xdotool-style, lower-case, `+`-joined; the adapter maps them to nut.js `Key`s and refuses an unknown name with the list |
| `wait` | `seconds` (≤ 10) | sleep |
| `zoom` | `region` | §5.3 |
| `focus_window` | `title` | bring the first window whose title contains `title` (case-insensitive) to the front, un-minimised and on the main display, and VERIFY it is the OS's active window (`src/desktop/bring-to-front.ts`). Focus; if less than 100 px of it is visible across or down, restore it if it reads 0×0, move it to (40, 40), and if it then runs off the right or bottom edge resize it to the display less 80 px each way. Not in front → focus again → minimise + restore via the per-OS helper (§5.8). Fails if no title matches, and fails with the front window's title if the OS will not put it in front, so the model can click it instead. Never sends a keystroke |
| `wait_window` | `title`, `state` (`open` / `gone`), `timeoutMs?` (default 15000) | poll the window list until a matching window exists / no longer does |
| `read` | `as`, `value` | the model transcribes what it sees into variable `as` |
| `assert` | `condition`, `holds` (boolean), `evidence` | the model's own judgment of the screen; `holds: false` fails the step with `evidence` as the actual |
| `noop` | | the step is complete |
| `prompt` | `question` | as today |
| `return`, `fail` | | as today, under the same claim guards |
| `api_call`, `extract_value` | | as today — they touch no surface |

`focus_window` and `wait_window` are deterministic once emitted: the model
turns the author's words into a title, and nut.js's window list answers.
They are actions rather than step grammars so that no new sentence form,
mirror or completion is needed for them; the prompt teaches the model to
emit them for steps that name a window.

**Refused in computer mode**, with a message the model sees on its next
turn: every page action — `navigate`, `select`, `upload`, `hover`, `dismiss`,
`switchFrame`, `switchPage`, `closePage`, `openPage`, `openBrowser`,
`switchBrowser`, `closeBrowser`, `back`, `forward`, `find`, `expand`,
`count`, `readTable`, `extract_csrf` — and `click`/`type` without
coordinates or with a `selector`. `keyboard` and `keypress` are aliased to
`key`. An unrecognised action type is REFUSED in computer mode, not kept as
a no-op that reports success (the defect SPEC-browser-history §4.1
describes is worse here, where the alternative is a real click).

### 5.5 The loop

The same turn loop as the page surface: capture → prompt → parse → execute
→ settle → capture, until `noop`, `assert`, `return`, `fail`, or the turn
cap. Differences:

- **Settle.** After every action that touches the screen, wait
  `desktop.settleMs` (default 300) before the next capture: native UIs
  redraw asynchronously and a dialog takes a moment to appear.
- **Stall.** The page loop's stall detection reads the DOM; here, three
  consecutive turns whose captures are pixel-identical AND whose actions
  were identical is a stall, and the step fails naming it.
- **No action cache.** Computer-mode steps neither read nor write the step
  cache. A cached selector is validated against a DOM at replay; a cached
  coordinate has nothing to validate against and would replay blind.
- **Retry** works as today (`withRetry`), with the prior failure context.

### 5.6 Conditions

`If … then` conditions on the computer surface are judged from the capture,
not from a DOM: the condition judge (`buildConditionJudgeMessage`) receives
the screenshot and no DOM. The predicate path — a condition whose two sides
are literals — stays as it is (it needs neither). A condition that names a
window title, `If a window titled "Confirm Save As" is open`, is still
judged by the model from the screenshot in v1; a deterministic window-list
condition is deferred (§12).

### 5.7 Prompt

A computer-mode system prompt replaces the page one for the step. It states:
the model is driving the operating system's screen, not a web page; the
image size and that coordinates are in that space; the action table (§5.4)
with one example each; that `focus_window` / `wait_window` are for steps
that name a window; that `zoom` is for anything too small to read; that
page actions do not exist here; that a step asking to change surface is not
its job and must be reported as unachievable rather than `noop`; and that
nothing may be typed into a password or credential field. The user message
carries the step, the variable map, and the image.

### 5.8 Execution details (nut.js)

`mouse.config.autoDelayMs = 20`, `keyboard.config.autoDelayMs = 20`.
`click` → `mouse.setPosition(point)` then `mouse.click(button)` /
`doubleClick`; `drag` → `mouse.drag([from, to])`; `type` →
`keyboard.type(text)`; `key` → `pressKey(...keys)` then `releaseKey(...)`
in reverse; `scroll` → `mouse.setPosition` then `scrollDown/Up/Left/Right`.
Window operations use `getWindows()`, `getActiveWindow()` and
`Window.getTitle()` / `getRegion()` / `focus()` / `move()` / `resize()`.
Two facts shape them (measured, §14):

- **libnut has no minimise or restore.** `Window.minimize()` and `restore()`
  throw "Method not implemented in libnut.", so they are never called. The
  adapter's `minimiseWindow` / `restoreWindow` use a per-OS helper outside
  it, spawned through `execFile` with a 5 s timeout and no console window: on
  Windows, PowerShell calling user32 `ShowWindow(hwnd, 6 | 9)` with the HWND
  nut.js keeps as `windowHandle`; on macOS, `osascript` through System Events
  (by title); on Linux, `xdotool windowminimize | windowactivate`. A missing
  tool is a clear error naming it. Only the Windows helper has been measured.
- **`getRegion()` is clipped to the main display on every side.** A window's
  true size and off-screen position cannot be read back — only how much of it
  is visible. A window wholly on another monitor reads 0 wide (or high), a
  minimised one reads (0,0 0×0). The `focus_window` policy is written against
  that, and the fake adapter clips identically.

All behind `src/desktop/adapter.ts`, an interface with a nut.js
implementation (`nut-adapter.ts`) and a fake for tests; nothing else imports
nut.js. The adapter is mechanism only; the policy that strings the window
primitives together is `bring-to-front.ts`.

### 5.9 The lock

One computer-mode session per machine: two would fight over the mouse. A
lock file at `path.join(os.tmpdir(), 'aiui-computer.lock')` holding
`{ pid, sessionId, since }`. Taken on `[use computer]`, released on
`[use browser]` and on session close. Held by a LIVE pid → the step fails:
*computer mode is in use by session <id> (pid <n>) — one computer-mode run
per machine.* Held by a dead pid → stale, taken over with a WARN. This is
also why the parallel live suite must not include computer-mode tests
(§13.3).

### 5.10 Config

```jsonc
"desktop": {
  "enabled": false,          // §5.1 — opt in per project
  "maxImageWidth": 1600,     // §5.2 — longer side of the image the model sees
  "settleMs": 300,           // §5.5
  "reportScreenshots": true  // §10.1 — false keeps desktop captures out of the report
}
```

Added to `Config`, the defaults, the loader, and the generated schema.
Also: `browser.launchArgs?: string[]` — extra Chromium launch arguments,
appended to the `--window-size` the launcher already passes. Needed so the
fixture workspace can pass `--disable-print-preview`, which makes Chromium's
Print button open the OPERATING SYSTEM's print dialog instead of its own
preview. Both are dialogs outside the page and both have a Cancel button;
the test in §13.2 is written to pass against either.

## 6. Browser mode, unchanged

Nothing about a browser-mode step changes except when the browser launches
(§4.6). A test with no `[use …]` line runs exactly as today.

## 7. Authoring

Two fixture tests, both against `fixtures/test-app`, which gains a static
`statement.pdf` served at `/statement.pdf` with `application/pdf`.

`templates/init/tests/pdf-print-cancel.md`:

```markdown
---
tags: [computer, pdf]
timeout: 600s
---

# PDF — open the print dialog and cancel it

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
```

`templates/init/tests/pdf-save-as.md`:

```markdown
---
tags: [computer, pdf]
timeout: 600s
---

# PDF — save it to a temp folder through the native Save As dialog

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Parameters
- save_dir: $TEMP

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
```

`assert_file_exists` is a fixture tool in `fixtures/tools/src`, a few lines;
`$TEMP` resolves from the server's environment like `$TEST_PASSWORD` does.
Step 4 matters more than it looks: when a run starts from TestBench, VS Code
is frontmost and the browser is behind it; this is the step that brings it
forward. The docs say plainly that `[use computer]` does nothing to arrange
the screen, and that the user must not touch the mouse during a computer
step.

Both files carry a prose header (like the other fixtures) saying what they
prove and what the machine must look like to run them.

## 8. Prompt

§5.7. The page prompt is unchanged except for one sentence in its rules:
steps asking to change surface are not page actions and must be reported as
unachievable, never answered with `noop`. (The directive never reaches the
model when spelled right; this is the net for the phrasings §4.2 cannot
catch.)

## 9. Code-behind

`[use …]` lines are not compilable — they are surface switches, like flow
control is a run-loop signal — and the compiler classifies them as such
wherever it classifies `parseFlowControlStep` / `parseControlLine` lines
(`live-compile.ts`, `compile.ts`, `generate.ts`). **A step that executed in
computer mode compiles to `ai: true`** (stays AI at run time) — judged from
the run's recording, which knows the surface at run time, rather than from
the file, which cannot know what surface a shared section ran on. The
compile report says why: *computer-mode step; coordinates are not
portable.*

## 10. Report, log, cache

### 10.1 Report

A `[use …]` step renders as a MODE MARKER row ("→ computer" / "→ browser"),
not as a step that did nothing. Computer-mode steps show the downscaled
capture the model saw, per turn, when `desktop.reportScreenshots` is true;
when false, no desktop image is embedded and the row says so. The report's
click marker: for a `click` / `drag` the capture is annotated with a small
ring where the pointer went, because debugging a coordinate click without
one is guesswork. Desktop captures include the whole screen, so the
`reportScreenshots` switch exists for privacy; the text redaction in
`src/utils/secrets.ts` cannot mask pixels, and the docs say so.

### 10.2 Log

Computer-mode lines are prefixed `[computer]`. The mapped screen point is
logged beside the image point on every pointer action:
`click image(812,544) → screen(1746,1170)`.

### 10.3 TestBench (runner-core mirror)

runner-core's line classifier recognises `[use …]` so the extension paints
the line as a directive, shows the §4.1 / §4.2 diagnostics as squiggles
before a run, offers `[use computer]` and `[use browser]` in the bracket
completion beside `[skill:`, and classifies it as a non-steppable line for
F11. Version bump per CLAUDE.md. The mirror gets the paired test the other
mirrors have.

### 10.4 Cache

§5.5: none in computer mode.

## 11. Platforms

- **Windows.** No permissions. Interactive, unlocked session required; a
  disconnected RDP session captures black. The §5.1 capture probe catches
  the sandboxed-spawn case with the message given there.
- **macOS.** Screen Recording and Accessibility permissions for the calling
  binary (`node`); a new Node version re-prompts. Retina density 2 is the
  second factor in §5.2. `cmd` is a valid modifier in `key`.
- **Linux.** X11 only (libnut). Xvfb in CI is X11. On a Wayland desktop,
  launch the browser with `--ozone-platform=x11` via `browser.launchArgs` so
  it and its GTK dialogs are X11 windows; whether capture then works under
  XWayland is to be measured, not assumed.

Verified by hand on the OSes not in CI; Windows is the one this was built
and measured on.

## 12. Deferred

- Per-step surface prefix `[use computer] Click Save`.
- Page-surface coordinate click for canvas/plugin toolbars from browser mode.
- Deterministic window-title conditions (`If a window titled … is open`
  answered from the window list, no model).
- Accessibility-tree actions per OS.
- Sikuli-style replay: nut.js's template matcher finding a recorded crop at
  replay, which is what would make code-behind meaningful here.
- A per-surface model (`desktop.model`) routing computer steps to a
  grounding-capable model; grounding accuracy is per model and must be
  measured against the project's own.
- Multi-monitor; Wayland.
- `[use computer]` in errands and hooks.

## 13. Acceptance

1. `[use computer]` / `[use browser]` parse per §4.1; the refusals in
   §4.1–4.2 fail at parse time with the messages given; a bracket inside a
   longer step is still prose.
2. A session whose first step is `[use computer]` launches no browser; a
   session whose first step is a page step launches at that step and
   navigates to baseUrl there; `[use browser]` after a desktop-first opening
   launches at the next step.
3. In computer mode, a `click` at image (x, y) reaches the adapter at the
   logical screen point §5.2 defines, for density 1 and 2, with and without
   downscale, and after a zoom.
4. Page actions in computer mode are refused with a message; unknown action
   types are refused, not run as no-ops.
5. The lock refuses a second live holder and takes over a dead one.
6. Skill calls restore the caller's surface; sections do not; session close
   resets.
7. `desktop.enabled: false` refuses `[use computer]` with the §5.1 message.
8. Both §7 tests pass live on this machine (§13.2).

### 13.1 Unit (vitest, runner-core `node --test`, testbench-native)

Parser accept/refuse table; unknown-whole-step-bracket rule with
did-you-mean; resolution order and tail composition; mode state machine;
lazy launch with a mocked `launchBrowser` (no call for a desktop-first
opening; one call at the first page step; baseUrl navigated there; endpoint
answers when unlaunched); `mapToScreen` table; computer action parser;
executor with the fake adapter; lock; config defaults and schema; prompt
states image size; report marker; cache bypass; compile classification;
runner-core mirror paired test; TestBench completion and paint.

### 13.2 Live

The two §7 tests, run through a server started OUTSIDE any tool sandbox
(§5.1 item 4), with the desktop visible and the mouse untouched. Expected
observations to record in §14: which print dialog appeared (preview or
OS) and whether `--disable-print-preview` was needed; whether Chromium's
context-menu "Save as..." raised the native dialog under Playwright's
download handling or whether a CDP-launched Chrome was needed; the model's
pointing accuracy at `maxImageWidth` 1600 on a 3440×1440 display; and
whether zoom was used.

### 13.3 Live suite

A `computer-use.test.cjs` under `testbench-native/tests/integration/live`
drives `pdf-print-cancel.md` through the extension, and is **gated by
`TESTBENCH_LIVE_COMPUTER=1`**: it skips itself otherwise, because the
parallel shards cannot share a mouse and the default run must stay
parallel. CLAUDE.md gains a "computer-mode live test" section saying so and
giving the one-shard command.

## 14. What the live run found

Run 2026-09-23 on the Windows 11 box (3440×1440, one display), server
started from the user's own terminal, model `openai/gpt-5.6-luna` via the
broker, `maxImageWidth` 1600 (so the model saw 1600×670 images).

**`pdf-print-cancel.md` passed, 10/10 steps, 101 s, ~101k tokens.** Every
computer-mode step landed first time: `focus_window`, the toolbar Print click,
the wait for the dialog, the Cancel click, the wait for it to close, then
`[use browser]` and a DOM assertion on the same tab. `--disable-print-preview`
reached the Playwright launch and the dialog that appeared was the OS print
dialog.

**Pointing accuracy** at 1600 px wide on a 3440 px screen was good enough on
every target tried — toolbar button, context-menu item, dialog Cancel button,
a settings toggle — with no zoom needed for those. The model reached for
`zoom` twice on its own, both times to read small text (an address bar and a
download bubble) while diagnosing why a dialog had not appeared.

**A defect the first attempt found, fixed in 7494518:** after
`focus_window` succeeded on turn 1 the next turn showed the same step and the
same screen with no record of the action, so the model repeated it until the
stall detector ended the step. Each attempt now carries an "Actions already
performed for this step" section in the step message (§5.7), and a turn that
repeats an already-satisfied window action completes the step.

**`pdf-save-as.md` is NOT proven.** Two findings, both about Chrome rather
than the framework:

1. Under a Playwright-launched Chromium the native Save As dialog cannot
   appear: Playwright sets `Browser.setDownloadBehavior` on the context and
   every download, including the PDF viewer's "Save as..." and Ctrl+S, is
   routed to its own folder with no file chooser. The step 5 clicks landed
   (the log shows the right-click and the menu item), then `wait_window
   "Save As"` timed out fifteen turns in a row, ~195k tokens. A computer-mode
   Save As test therefore needs a real Chrome attached over CDP
   (`config.cdp`), which the server can launch (`POST /cdp/browsers`).
2. Against that real Chrome the dialog still did not appear, before AND after
   the "Ask where to save each file before downloading" setting was turned
   on. The setting was turned on by the framework itself:
   `templates/init/tests/chrome-ask-where-to-save.md` ran 7/7 in 60 s on the
   computer surface alone — no browser launched, Chrome focused by title,
   Ctrl+L, the URL typed, the toggle judged off from the screenshot by an
   `If … then` condition and clicked, the assertion held. Why the PDF viewer
   still saved silently in a CDP-attached Chrome is not yet understood; the
   run was stopped by the user once the surface itself was proven. Candidates
   to measure next: whether the CDP attach path sets a download behaviour of
   its own, and whether the viewer's "Save as..." honours the prompt setting
   at all.

**Cost.** A computer-mode turn is one image plus a short prompt; the two
passing tests spent ~50–100k tokens each. A step that waits for something
that never comes spends the whole turn cap (15 turns) doing so — the cap is
the only bound, and a `wait_window` timeout of 15 s per turn makes that a
five-minute step. Worth a tighter per-step budget in a later version.

**Tool-sandbox finding**, recorded in §5.1 item 4: everything above needed a
server started outside this tooling; from inside it, `[use computer]` failed
at the capture probe with the message §5.1 specifies, which is the intended
behaviour.

### focus_window: measured Win32 behaviour (2026-09-23)

Measured on the same box with a throwaway WinForms window, from processes
spawned by the tool runner (which cannot capture the screen, but whose window
calls work). These are what `src/desktop/bring-to-front.ts` is built on:

1. **libnut cannot minimise or restore.** `Window.minimize()` / `restore()`
   throw "Method not implemented in libnut."; the native module exports only
   getWindows, getActiveWindow, getWindowRect, getWindowTitle, focusWindow,
   resizeWindow and moveWindow.
2. **nut.js `focus()` restores a minimised window** (4 of 4), but **does not
   always activate it**: once it came back while another app stayed in front.
   A normal window behind the foreground app came to the front 3 of 3 times.
   So focus is the first move, and it is always verified.
3. **user32 `ShowWindow(hwnd, SW_RESTORE)` from a separate PowerShell process
   restored a minimised window and activated it.** nut.js's `windowHandle` is
   the HWND as a number. It costs ~0.5–1 s a spawn, so it is the fallback.
4. **`getRegion()` is clipped to the main display on every side**: minimised
   reads (0,0 0×0); moved to 3000,200 reads (3000,200 440×1240); to 3400,200,
   (3400,200 40×1240); to -300,200, (0,200 2234×1240); to -2000,200,
   (0,200 534×1240); to 300,1300, (300,1300 2534×140); to 300,-200,
   (300,0 2534×1199); resized to 5000×2000 at 300,200, (300,200 3140×1240);
   maximised, (0,0 2527×1399); a normal 640×400 at 300,200 reads exactly
   that. Hence the "less than 100 px visible" rule, and the fake adapter's
   `clipToDisplay`, which reproduces every row.
5. `move()` and `resize()` work, including moving a window back from
   off-screen.

Foreground rules may differ for a server a user starts from their own
terminal, since these processes descend from the foreground app; the
verify-and-fall-back chain is there so the result holds either way.
