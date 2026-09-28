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

> **Note (stories/use-ai-step.md).** The family now has one PER-STEP member,
> `[use ai] <step>`: a prefix rather than a whole step, which sends the rest
> of the line to the model on its own — no page, no screen — and stores the
> value it answers with. It is not a surface and has no mode form, so it
> switches nothing, takes no computer lock, and is allowed in hooks and
> errands where the two switches are not. It is the first of the per-step
> forms §12 deferred; `[use computer] Click Save` remains deferred. The
> refusal messages above now describe the family as it is (two switches as
> whole steps, and `[use ai] <step>`), and `[use ai]` adds refusals of its
> own: nothing after the token, arguments inside the bracket, more than one
> name, and the token anywhere but the start of the step.

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
  `[use browser]` → `surface = 'browser'`, computer lock released if this
  session holds it.
- **Re-entering the mode you are in is a no-op** with a log line, not an
  error. Sections and skills will open with `[use computer]` defensively.
  The one thing a re-entry still does is take the lock (§5.9) when the
  session does not hold it, which is the normal case at the start of a
  later run or after a pause.
- **The surface outlives a batch and a pause; the lock does not.** A session
  that ends a batch on the computer surface is still on it, adapter loaded,
  when the next batch of the same run arrives — a Continue after a
  breakpoint, a step command, the block after an `[input:]` split. The lock
  was released when the last batch ended, or when the run paused for a
  person, and is taken again at the next step that reads or drives the
  screen (§5.9).
- **A new run starts on the surface its file says.** A batch that STARTS a
  run carries `runStart: { stepIndex }` (`StepRequest.runStart`), and before
  its first step the session is put on the surface of the last top-level
  `[use …]` line in `fullSteps` above `stepIndex` — `browser` when there is
  none, which is every run from step 1, and `browser` again when `stepIndex`
  or `fullSteps` is absent or out of range. Going to `browser` is
  `[use browser]`'s transition: adapter dropped, lock released if held. A
  run that starts below a `[use computer]` keeps the computer surface only
  if the session is already on it; on a browser-surface session it runs on
  the browser and the log names the `[use computer]` line to run from,
  because entering computer mode is that step's job, preconditions and row
  included. Why: TestBench reuses one session per test file and MCP's
  `run_test_file` reuses `mcp:<path>`, and a run that failed or was stopped
  between `[use computer]` and `[use browser]` used to hand the next run the
  computer surface — its "Navigate to statement.pdf" went to the real mouse
  and keyboard with VS Code in front. The server cannot infer a run's start
  from the request's shape (a Run From Here and a Continue both send a
  tail), so the client says it:
  - **TestBench** sends it on the first block of every run the user started
    — Run, Run From Here, Run Step Here, a selection, Run & Compile, and each
    row of a kept-session row loop — with `stepIndex` from runner-core's
    `runStartFor`, the block's first step's position in `extractSteps`,
    which is the list it sends as `fullSteps`. A section body line run
    detached has no such position and starts on `browser`. Never on a
    Continue or step command (`isResume`), a re-run injected at a pause
    (`isContinuation`, `rerun`), or the later blocks of a split run.

    "The first block" means the first batch the run actually SENDS. A
    started run can park before sending one — a breakpoint on its first
    selected step, an `[input:]` answered and then a breakpoint, a Pause at
    a prompt — and then its Continue, being `isResume`, would send no
    `runStart`, and the whole run would execute on whatever surface the last
    run left. So the run keeps "`runStart` owed" across the park
    (`parkedRunStartOwed`, kept across a run injected at the pause and
    dropped by Stop) and the Continue or step command's first block carries
    it, with `stepIndex` from that block's own first step. It is spent when
    a batch goes out, before the request is awaited, so a Pause mid-block
    cannot make it ride twice, and a Continue of a run that already sent it
    sends none. An `[interactive]` step counts: the first REPL turn typed
    there is a batch, so it carries `runStart` for the `[interactive]`
    line, with `fullSteps` beside it (the REPL sends none otherwise, and the
    server starts on `browser` without one); a REPL left without a turn
    leaves it owed to the block after.

    The skill-file picker (Run Step Here / Compile This Step in a skill)
    sends its slice as `isContinuation` + `rerun`, but its rows are not all
    re-runs. The ⏸ and ⏹ rows re-run the steps of a run that failed or was
    stopped inside THIS skill, against what it left — surface included, as
    the Variables panel's re-run from the failed step does — and send
    nothing. The ▶ row is an idle session whose last run had nothing to do
    with the skill, so it is a run the user started: it sends `runStart` at
    the test's call line (`startsRun`).
  - **MCP `run_test_file`** sends `{ stepIndex: 0 }` on every call: each one
    runs the whole file from step 1.
  - **The CLI** needs nothing: its surface state is local to one `runTest`,
    so every run, and every data row, starts on `browser`.
  - **Everything else** — MCP `run_steps`, flick, a client that predates the
    field — sends nothing and keeps the session's surface, as below.

  The lines above `stepIndex` are read backwards, each resolved as a step is
  (`surfaceAtRunStart`, src/server/session-manager.ts). A `[use …]` line
  decides. A section call is seen through: its body, from the request's
  `sections`, read the same way, nested calls included — so a desktop
  excursion that ends in `[use browser]` inside a section puts the step after
  the call on `browser`. (Top-level lines alone answered `computer` there, and
  Run From Here sent that step to the real mouse.) A skill call changes
  nothing, because a skill hands its caller back the surface it called from
  (below). A control line whose tail switches surface, directly or through a
  section, may or may not have run; that is not guessed at, and the run
  starts on `browser` with a WARN naming the line. So every miss errs toward
  `browser`, where a desktop step can only fail. The one thing not seen is a
  bare-name section call sent without `sections`, which the server cannot
  tell from prose anywhere.

  A kept `computer` surface is not kept past the project's opt-in: when
  `desktop.enabled` is no longer `true`, the run's first step that reads or
  drives the screen fails with §5.1's message and the session goes back to
  `browser` (§5.1 item 1).
  `GET /sessions/:id` reports the session's current `surface`.
- **A skill call restores the caller's surface on return**, whatever the
  skill's body did. An **inline section does not** — it is inline by
  definition, and a section that switches is the way an author writes a
  desktop excursion once and calls it by name. Going back to `browser` is
  `[use browser]`'s transition. Going back to `computer` is `[use computer]`:
  the skill's `[use browser]` dropped the adapter and the lock, so the caller
  re-enters through §5.1 — opt-in, vision route, adapter, lock, probe — at its
  first step after the skill, and a refusal fails that step with the entry's
  message before anything runs on it. (An earlier release left the caller on
  `browser` here, and its next desktop step went to the page.) Returning from
  nested skills at once restores the outermost caller's surface only. Skipped
  when that step is itself a `[use …]` line, which sets the surface anyway.
- **Session close resets** the surface, and releases the lock if the session
  holds it — which, since every run gives it back, it does only when the
  close lands mid-run.
- The surface applies to MCP `run_steps` and to steps posted to the Sessions
  API alike: it is the session's, not the file's. A request without
  `runStart` continues whatever surface the session is on.

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

   The server re-reads the project config every batch, and the opt-in is
   asked wherever a session would touch the screen, not only at its first
   `[use computer]`: at `[use computer]` re-entry (ahead of the no-op), at
   the step boundary before a step that reads or drives the screen (§5.9's
   list), and so for a Continue, an MCP `run_steps` and a `runStart` that
   kept the computer surface alike. Switched off, that step fails with this
   message, nothing is captured or asked of the model, and the session goes
   back to `browser` — lock released, adapter dropped (`revokeComputerMode`).
   A session that entered while the owner allowed it used to keep driving
   the mouse after they switched it off. The CLI loads the config once per
   run and starts every run on `browser`, so only the re-entry check applies
   there.

   Only the JSON boolean `true` opts in. The config loader types the
   `desktop` section at load and refuses anything else — the string
   `"false"`, which the truthy gate used to read as ON, the string `"true"`,
   a number — with *Invalid desktop.enabled in <file>: expected true or
   false, got the string "false"*. On the server that fails the batch that
   resolved the project, with the message on the stream; nut.js is never
   loaded. (`reportScreenshots` is typed the same way, for the same reason
   in the other direction: the string `"false"` kept captures in the report.
   `maxImageWidth` and `settleMs` must be numbers.)

   And nothing switches it on for a project that did not: `aiui init`
   writes its own starter `aiui.config.json` (`SCAFFOLD_CONFIG`,
   src/cli/commands/init.ts) and never copies `templates/init/aiui.config.json`,
   which is the live suite's fixture workspace config and carries
   `desktop.enabled: true`, `browser.launchArgs: ["--disable-print-preview"]`
   and a `toolsDir` into `fixtures/`. It used to be copied verbatim into every
   new project.

1b. **The model can see the screen** (§15.4). For a gateway-routed model
   (`gateway/…`, `aibroker/…`) with a custom gateway URL, `GET
   {gatewayUrl}/v1/models` (3 s) is asked whether the route is the TestBench
   Copilot bridge and what it does with images; a bridge that strips images,
   or that marks the selected model `image_input: false`, fails the step with
   §15.4's message. Any other answer, or none, proceeds. Checked against the
   AI route in force at the `[use computer]` step, and skipped on a keyless
   run. Before nut.js loads, so it costs nothing on the machine
   (`src/desktop/vision-route.ts`).

2. **nut.js loads.** `@nut-tree-fork/nut-js` is imported lazily HERE and
   never at server start, so a machine with no prebuilt binary, or no
   permission, still runs every browser test. Message names the package
   and the platform, and for macOS adds the two permissions (§11). A
   module-not-found (`ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`) says instead
   that the package — or the dependency of it that is missing, by name — is
   not installed in the checkout this server runs from, and to run `npm
   install` in that package root (found by walking up from the adapter's own
   file, not from the cwd) and restart the server. That is what a checkout
   whose `node_modules` predates computer mode hits on its first
   `[use computer]`.
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
| `wait_window` | `title`, `state` (`open` / `gone`), `timeoutMs?` (default 15000, at most 30000) | poll the window list every 250 ms until a matching window exists / no longer does. A larger `timeoutMs` is clamped to 30000 and the result the model reads says so. Gives up at its next look when the run is stopped |
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
describes is worse here, where the alternative is a real click). So is
`screenshot` (and `take_screenshot`, `capture_screen`): every turn already
carries a fresh capture, and an earlier release aliased it to `noop`, which
ends the step — measured, "Click Print" passed with zero clicks after one
model call.

> **Update (2026-09-29):** the page surface now refuses an unknown action type too, failing the step instead of passing it; see CHANGELOG.

**A directive nobody dispatched never reaches the model.** On the computer
surface, a step that is a `[tool: …]` line the loop did not dispatch fails
with a message naming the cause, without a capture or a model call. That
happens when a Sessions API request carried no `toolsDir`, so no catalogue is
loaded. The same goes for a raw `[skill: …]` line (skills are expanded before
the loop, so a raw one means nothing expanded it) and for a whole-step
bracket that §4.2 refuses. The page surface still hands those lines to the
model as prose. Here that was measured live: handed `[tool: open_calculator]`,
the model pressed Win+R, typed `calc` and launched the program itself. An
unknown tool name with a catalogue loaded already failed on both surfaces
with the catalogue's message. Both loops check this last, just before
`executeComputerStep` (`undispatchedDirectiveError` in
`src/runner/computer-step.ts`).

### 5.5 The loop

The same turn loop as the page surface: capture → prompt → parse → execute
→ settle → capture, until `noop`, `assert`, `return`, `fail`, or the turn
cap. Differences:

- **Settle.** After every action that touches the screen, wait
  `desktop.settleMs` (default 300) before the next capture: native UIs
  redraw asynchronously and a dialog takes a moment to appear.
- **One screen-changing action per response.** A response may hold several
  actions; they run in order up to and including the FIRST that changes the
  screen or the image — `click`, `drag`, `move`, `scroll`, `type`, `key`,
  `wait`, `wait_window`, `focus_window`, `zoom` — and everything after it is
  dropped. The model is told next turn, under *Not performed from your last
  answer*, which actions were dropped and why, and the report lists them as
  not performed. Actions that only read the current image (`read`, `assert`)
  or touch no surface (`api_call`, `extract_value`) may run before it. A
  trailing `noop` is dropped too: the model must see the result before it
  says the step is done. Measured before this rule: `[click, assert
  holds:true]` passed on the pre-click image, and in `[zoom, click]` a point
  chosen on the full image was mapped through the zoomed crop.

  In front of the screen-changing action, neither `assert` nor `noop` ends
  the step. An `assert` that holds is recorded (it is the model's reading of
  the image it was shown), the action behind it runs, and the loop goes on
  to judge the result; one that does not hold fails the step as it would
  anywhere, and the action behind it is not performed. A `noop` there is
  refused — the model is told under *Not performed* that a noop in front of
  another action does not end the step — and the action runs. Both used to
  end the step at once: measured, `[noop, click]` and `[assert holds:true,
  click]` for "Click the Cancel button" passed after one model call with
  zero clicks, and the click was not even listed as not performed. `noop`
  and a holding `assert` end the step only when nothing behind them changes
  the screen.

  Whatever ends a turn early — a failed `assert`, a claimed `return` or
  `fail`, a refused one, a failed action, a spent wait budget — leaves the
  actions behind it unperformed, and those are listed exactly as the
  dropped ones are: on the report, and to the model under *Not performed*
  when there is a next turn.
- **Stall.** The page loop's stall detection reads the DOM; here, three
  consecutive turns whose captures are pixel-identical AND whose actions
  were identical is a stall, and the step fails naming it. A turn whose
  screen-changing action is a `wait`, or a `wait_window` that times out, is
  not counted — it leaves the streak where it was — because waiting on an
  unchanging screen is what a slow "Wait until …" is: three identical waits
  used to trip the stall at 20–30 s, before the wait budget below ever
  applied. The wait budget and the turn cap bound those turns instead. A
  `wait_window` that finds its window is counted, after it has run.
- **A repeated window action is not repeated.** When the previous turn asked
  for `focus_window` / `wait_window` and nothing else, and every one
  succeeded, the same window action at the front of the next answer is not
  performed again. The model is told it already succeeded ("if the step asks
  for nothing more, answer noop; otherwise do the rest of it") and the rest
  of that answer runs. It does NOT pass the step: an earlier release did, and
  "Focus Calculator and type 1+1" went green with nothing typed. A model that
  repeats it for ever still ends in the stall above; the repeat counts
  towards it.
- **Wait budget.** The time one step spends in `wait` and `wait_window`, over
  all its turns and attempts, is capped at 60 s (`COMPUTER_WAIT_BUDGET_MS` in
  `src/runner/computer-step.ts`). A wait that would overrun is cut to what is
  left; once the budget is used up the step fails with a message naming it,
  and is not retried. Without it the turn cap was the only bound: a wait for
  something that never comes cost 15 turns of 15 s (§14).
- **Stop.** The run's abort signal is checked before every capture, every
  model call and every action, and `wait_window` checks it at every look; a
  stopped step reports *Aborted by client*, as a page step does. The §5.6
  condition judge's 3 s pause between re-asks of a `waiting` answer gives way
  to it too, on either surface, so a Stop during a `Wait until` / `While`
  judge ends it at once rather than after the pause.
- **No replay.** A computer-mode step always runs under the model. It is
  never compiled to code-behind (§9): a compiled selector is checked against
  a DOM when it replays, while a recorded coordinate has nothing to validate
  against and would replay blind. (There was also a step cache, which
  computer mode bypassed; it has since been removed.)
- **Retry** uses `withRetry`, with two exceptions. An attempt that has driven
  the real pointer, keyboard or windows (`click`, `drag`, `move`, `scroll`,
  `type`, `key`, `focus_window`) is never retried, whatever it failed with: a
  retry starts the step over and would type, click or submit a second time —
  measured, an attempt that typed `1+1` and then stalled was retried and
  typed it again. And a stall or the turn cap is never retried: the same
  screen gets the same answers, and a wait that never comes would cost twice
  the image requests. What may retry is an attempt that performed nothing but
  waits and zooms — a model or network error on the first turn, say.

### 5.6 Conditions

`If … then` conditions on the computer surface are judged from the capture,
not from a DOM. The predicate path — a condition whose two sides are
literals — stays as it is (it needs neither). A condition that names a
window title, `If a window titled "Confirm Save As" is open`, is still
judged by the model from the screenshot in v1; a deterministic window-list
condition is deferred (§12).

**The judge's request on this surface is its own short one**
(`buildComputerConditionJudgeMessages`, `src/desktop/judge-prompt.ts`), not
the page judge's. It says the image is a screenshot of the WHOLE screen and
gives its pixel size; lists the conditions A, B, C… as authored; carries the
`## Values` block built by the page judge's own formatter from the same
`StepValues`, so secrets are masked by the same rules; carries the prior
steps and the project context, as both other prompts do; and asks for the
page judge's response format unchanged (`{"matched": "<label | none |
waiting>", "actions": [], "reasoning"}`), so `parseBranchedResponse` and the
label handling read it as they read the other. No guessing: a condition the
screenshot does not show — off-screen, hidden, unreadable, or false — is
`none`, with the reason; `waiting` only for a screen visibly mid-transition.
No DOM, no page action vocabulary, no API context, no tab list, no viewport.
It used to be the page request with the DOM fence swapped for a sentence —
the whole browser system prompt beside every capture, re-sent on every
3-second re-ask of a `waiting` decision. Measured in
`tests/computer-conditions.test.ts` for one condition with a one-line
context and one prior step: 46,503 characters of text before, 2,098 after
(the page judge's request for the same condition is 46,256). The page
judge's request is unchanged, byte for byte, and a test pins that. A model
that rejects the image still fails the guard with the bridge's words,
unretryable (§15.4).

The judge's capture goes to the model whatever `desktop.reportScreenshots`
says; the copy recorded on the guard's AI interaction — which the report
renders — obeys it (§10.1).

### 5.7 Prompt

A computer-mode system prompt replaces the page one for the step. It states:
the model is driving the operating system's screen, not a web page; the
image size and that coordinates are in that space; the action table (§5.4)
with one example each; that `focus_window` / `wait_window` are for steps
that name a window; that `zoom` is for anything too small to read; that
page actions do not exist here; that a step asking to change surface is not
its job and must be reported as unachievable rather than `noop`; and that
nothing may be typed into a password or credential field. It also says that
only the first screen-changing action of a response is performed (§5.5),
that there is no screenshot action, and that `wait_window`'s `timeoutMs` is at
most 30000. The user message carries the step, the variable map, and the
image. The step is the one the page model would read: its failure tail
(`… otherwise continue`) stripped and `[output: x]` rewritten as
`[store as: x]`, by the same `stripFailureTail` and `enrichAuthored` the page
path uses — before that, the model named its own capture and `{{x}}` stayed
empty. Its test-information block carries the test name, base URL and step
*n* of *m* but no browser viewport: the only coordinate space the model is
given is the image's.

### 5.8 Execution details (nut.js)

`mouse.config.autoDelayMs = 20`, `keyboard.config.autoDelayMs = 20`.
`click` → `mouse.setPosition(point)` then `mouse.click(button)` /
`doubleClick`; `drag` → `mouse.drag([from, to])`; `type` →
`keyboard.type(text)`; `key` → `pressKey(...keys)` then `releaseKey(...keys)`
with the SAME list in the same order, modifiers first and the key last;
`scroll` → `mouse.setPosition` then `scrollDown/Up/Left/Right`.
The `key` order is libnut's rule, not a preference. Both `pressKey` and
`releaseKey` reverse the list, take its last key as the key and the rest as
modifier flags, and make one native `keyToggle(key, down|up, flags)` call;
libnut silently drops a one-character flag name, and its native code refuses
a flag it does not know. An earlier release passed the list reversed, meaning
"let the key go before its modifier". That made libnut read the real key as a
flag: `alt+f4` threw "Invalid key flag specified." (measured live), and
`ctrl+l` / `win+r` released only the modifier and left L / R held down. The
flag set is smaller than the key-name set. Measured on win32 (libnut-win32
2.7.5), `alt`, `control`, `shift`, `win`, `meta`, their `right_` forms and
`fn` are accepted, and `cmd` and `command` are not. So on Windows the adapter
presses `LeftWin` for `cmd` (`chordKeyMembers` in `src/desktop/keys.ts`).
`tests/desktop-nut-keyboard.test.ts` checks the adapter against an emulation
of that libnut layer, read out of the installed source.

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
`{ pid, sessionId, since }`.

**The lock is held only while a run is executing and not waiting for a
person: never across the idle time between runs, and never across a pause.**
A run is one Sessions API batch on the server and one `runTest` in the CLI,
and a data row is one of each.

- **Taken** on `[use computer]` (§5.1 item 3), and taken again lazily at
  the step boundary, before the next step that reads or drives the screen,
  when the session does not hold it — the first such step of a later run, or
  the first after a pause. That is the same spot and pattern as the lazy
  browser launch (§4.6), in both loops. It covers a computer-mode step (an
  `If … then return` claim included), a §5.6 condition judge (an `If`
  chain, or a `While` / `Repeat … until` check), a `[use computer]`
  re-entry, and a `[tool: …]` line: a tool reads no screen, but it can
  drive the machine — the fixture `open_calculator` launches a GUI program —
  and one run unlocked after a pause could take the front window from
  another session's computer-mode run. A tool that waited for a debugger to
  attach takes the lock again after the attach, before it runs. A `Set`, a
  whole-step `Return` / `Stop` / `Fail the test …`, an `[input: …]` or
  `[interactive]` step, a raw `[skill: …]`, a `[tool: …]` line that does
  not parse, a refused bracket, and a guard visit that decides no condition
  (a `For each` reading its list or revisiting, a `Repeat`'s first pass)
  touch no screen and take nothing. A condition decided from its own values
  (literal-decision) still takes it, because telling the two apart at the
  boundary would be a second copy of that rule. On the browser surface
  nothing takes the lock, a `[tool: …]` line included. The same boundary
  asks the project's opt-in first (§5.1 item 1).
- **Released** at the end of every run, whatever ends it: a pass, a failed
  step, a stop, a batch the client cut at a breakpoint, a thrown error. On
  the server this is the step loop's `finally`, and it releases only the
  lock: `surface` stays `computer` and the adapter stays loaded. Also
  released on `[use browser]`, on a batch whose `runStart` puts the session
  back on the browser surface (§4.5 — the same transition), and on session
  close, each a no-op when the session does not hold it. So a session reset
  to `browser` never keeps the lock, and a session kept on `computer` by a
  `runStart` takes it again lazily, like any later batch.
- **Released whenever a run pauses for a person**, immediately before the
  wait begins, and again only the lock. On the server: a skill-file or
  section-body breakpoint, a step-mode (F10/F11) pause, and a tool or
  code-behind debugger attach — released before the `step:awaiting` /
  `*:awaiting-debugger` event, so a client that sees the pause sees the lock
  free. In the CLI: an `[input: …]` prompt, an `[interactive]` REPL, and the
  failure REPL. (The AI clarification prompt is not on the list because it
  never pauses a computer-mode step: a `prompt` action there fails the step
  with its question, and on the page surface no lock is held.) Nothing is
  taken back on resume; the step boundary does that, and a step whose lock
  another session took during the pause fails with the "in use" message
  below, asking nothing of the model. The reason
  is the user's decision: a run waiting for a person must not hold the
  machine-wide mouse lock for as long as that person takes. The cost is that
  a user single-stepping a desktop test can lose the lock between two steps.
- The session tracks whether it holds the lock rather than reading the file
  at every step. Release deletes the file only when both the pid and the
  session match, so a session never releases another session's lock.

Held by a LIVE pid under another session → that step fails with nothing
captured or asked of the model: *computer mode is in use by session <id>
(pid <n>) — one computer-mode run per machine.* The check is on the session
as well as the pid, so two sessions in one server process are refused
exactly as two processes are. Held by a dead pid → stale, taken over with a
WARN. This is also why the parallel live suite must not include
computer-mode tests (§13.3).

Why only while a run executes: an MCP `run_test_file` of
`calc-one-plus-one.md`, which ends in computer mode with no `[use browser]`,
passed on 2026-09-23 and left `aiui-computer.lock` held by its idle session,
because MCP keeps a session open between calls. That would have refused
every other computer-mode session on the machine until something closed it.

### 5.10 Config

```jsonc
"desktop": {
  "enabled": false,          // §5.1 — opt in per project
  "maxImageWidth": 1600,     // §5.2 — longer side of the image the model sees
  "settleMs": 300,           // §5.5
  "reportScreenshots": true  // §10.1 — false keeps desktop captures out of the report
}
```

Added to `Config`, the defaults, the loader, and the generated schema. The
loader types this section at load and refuses a wrong-typed value, naming
the file, the key and the value (§5.1 item 1); the schema rejects the same
values in the editor.
Also: `browser.launchArgs?: string[]` — extra Chromium launch arguments,
appended to the `--window-size` the launcher already passes. Needed so the
fixture workspace can pass `--disable-print-preview`, which makes Chromium's
Print button open the OPERATING SYSTEM's print dialog instead of its own
preview. Both are dialogs outside the page and both have a Cancel button;
the test in §13.2 is written to pass against either. Both it and
`desktop.enabled: true` live in the FIXTURE workspace's config only — `aiui
init` does not copy that file (§5.1 item 1).

## 6. Browser mode, unchanged

Nothing about a browser-mode step changes except when the browser launches
(§4.6). A test with no `[use …]` line runs exactly as today.

## 7. Authoring

The fixture test against `fixtures/test-app`, which gains a static
`statement.pdf` served at `/statement.pdf` with `application/pdf`.
(`calc-one-plus-one.md`, a desktop-first test that launches no browser, came
later; see §14.)

`templates/init/tests/pdf-dialog-cancel.md` (named `pdf-print-cancel.md`
until 2026-09-23; window titles match by case-insensitive substring, so with
that file open in VS Code the editor's own window title contained "print" and
satisfied `wait_window "Print"`, and a wait for the dialog to close could
never end. The §14 and §15.7 runs were made under the old name):

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

Step 4 matters more than it looks: when a run starts from TestBench, VS Code
is frontmost and the browser is behind it; this is the step that brings it
forward. The docs say plainly that `[use computer]` does nothing to arrange
the screen, and that the user must not touch the mouse during a computer
step.

The file carries a prose header (like the other fixtures) saying what it
proves and what the machine must look like to run it.

A second fixture, `pdf-save-as.md`, drove the viewer's native Save As dialog
to completion and checked the saved file with a fixture tool,
`assert_file_exists`. It never passed (§14) and was removed on 2026-09-23;
the tool stays in `fixtures/tools/src`.

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

## 10. Report and log

### 10.1 Report

A `[use …]` step renders as a MODE MARKER row ("→ computer" / "→ browser"),
not as a step that did nothing. Computer-mode steps show the downscaled
capture the model saw, per turn, when `desktop.reportScreenshots` is true;
when false, no desktop image is embedded and the row says so. Each capture
is embedded ONCE, in the turn's own frame with the click ring: the turn's AI
interaction carries the same bytes and its sub-actions carry none, so on a
computer turn neither renders a screenshot block — image or placeholder —
and the row's step-end image renders only when no turn showed it (a
failure's row screenshot is its last turn's capture; a pass's is the screen
after its last action, labelled "Screen", not "Page state"). With the switch
off, the only placeholder on a computer step is the turn's, and it names
`desktop.reportScreenshots`, never `browser.captureScreenshotsPerAction`,
which cannot bring a desktop capture back. Page-surface rows are unchanged.
The report's
click marker: for a `click` / `drag` the capture is annotated with a small
ring where the pointer went, because debugging a coordinate click without
one is guesswork. Desktop captures include the whole screen, so the
`reportScreenshots` switch exists for privacy; the text redaction in
`src/utils/secrets.ts` cannot mask pixels, and the docs say so.

**Where a desktop capture can go, and what the switch does to each.** The
model always gets the capture it is asked about — that is the surface. With
`reportScreenshots: false`, no other copy leaves the run:

| Path | With the switch off |
| --- | --- |
| A computer step's turn image (`TurnResult.computer.screenshotBase64`) and its AI interaction's screenshot — report turn blocks | not recorded (`computer-step.ts`) |
| A computer step's row screenshot (`StepResult.screenshotBase64`, pass or fail) — the report's step-end image, `results[].screenshot` in the JSON response, a recording's `<step>.failure.png` | not recorded, so none of them has one |
| The same, on the SSE `step:pass` / `step:fail` event — TestBench, and the MCP server | not sent: the event's `screenshot` comes from the row |
| A §5.6 condition judge's AI interaction — the guard row's turn in the report | not recorded (`evaluateConditions`); the row says the capture was left out by this switch |
| MCP `run_test_file` / `run_steps` result image | not returned: the MCP server reads the switch from the project's `aiui.config.json` and drops any screenshot on an event marked `surface: 'computer'`, whatever the server sent, and says why instead of advising `capture`. A computer step's `step:pass` or `step:fail` also clears the picture before it whether or not it carried one — a current server strips it before sending — so `final` never hands back the page as it looked before the excursion |

A page capture taken while the run is on the computer surface — the error
screenshot of a step that threw, an unconditional `Fail the test …` — is of
the page, not the screen, and is not this switch's business. The failure
diagnosis pass (CLI, `ai.diagnoseFailures`) sends the model a fresh page
capture, or the failed row's own screenshot, which the switch already
governs.

**The MCP default returns a desktop capture.** With the switch on (the
default), a step that FAILS in computer mode hands the agent a screenshot of
the whole desktop — every window on the screen, not the page — under the
default `screenshots_return: "on-failure"`, and under `final` whatever
screenshot came last. The tool descriptions say so; `screenshots_return:
"none"` or `reportScreenshots: false` is how to keep it out of the
conversation.

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

(Removed with the step cache. §5.5 and §9 cover why a computer-mode step
never replays.)

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
5. The lock refuses a second live holder and takes over a dead one. It is
   released at the end of every run, whatever ends it, and whenever a run
   pauses for a person, while the session stays on the computer surface.
   The session's next computer step takes it again, or fails with §5.9's
   message if another session took it in between.
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
states image size; report marker; compile classification;
runner-core mirror paired test; TestBench completion and paint.

### 13.2 Live

The §7 tests, run through a server started OUTSIDE any tool sandbox
(§5.1 item 4), with the desktop visible and the mouse untouched. Expected
observations to record in §14: which print dialog appeared (preview or
OS) and whether `--disable-print-preview` was needed; whether Chromium's
context-menu "Save as..." raised the native dialog under Playwright's
download handling or whether a CDP-launched Chrome was needed (asked of the
since-removed `pdf-save-as.md`); the model's
pointing accuracy at `maxImageWidth` 1600 on a 3440×1440 display; and
whether zoom was used.

### 13.3 Live suite

A `computer-use.test.cjs` under `testbench-native/tests/integration/live`
drives `pdf-dialog-cancel.md` through the extension, and is **gated by
`TESTBENCH_LIVE_COMPUTER=1`**: it skips itself otherwise, because the
parallel shards cannot share a mouse and the default run must stay
parallel. CLAUDE.md gains a "computer-mode live test" section saying so and
giving the one-shard command.

Beside it, behind the same gate, `computer-calc.test.cjs` drives
`calc-one-plus-one.md` through the extension twice in one kept session: Run
All with a breakpoint on step 5, then Continue, then a second Run All. It
reads the §5.9 lock file from outside the server and requires it free of the
server's pid while TestBench is parked at the breakpoint and after each run,
and held by that pid at some point during each run phase — the positive
control that makes the "free" readings mean something. After the second run it
checks `GET /sessions/:id` reports `surface` (§4.5).

## 14. What the live run found

Run 2026-09-23 on the Windows 11 box (3440×1440, one display), server
started from the user's own terminal, model `openai/gpt-5.6-luna` via the
broker, `maxImageWidth` 1600 (so the model saw 1600×670 images).

**`pdf-dialog-cancel.md` passed, 10/10 steps, 101 s, ~101k tokens.** Every
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
performed for this step" section in the step message (§5.7). A turn that
repeated an already-satisfied window action at first completed the step; that
passed compound steps with the rest undone, so the repeat is now answered with
a note instead (§5.5).

**`pdf-save-as.md` was NOT proven, and was removed on 2026-09-23** because
it could not do what it was written for. Two findings, both about Chrome
rather than the framework:

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
five-minute step — and, since a turn-cap failure was then retried, up to ten
minutes and 30 image requests. §5.5 now caps a step's waiting at 60 s and
never retries a turn-cap or stall failure.

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

**Built policy, checked from dist against real windows** (tool-spawned, a
second throwaway window holding the foreground): behind another window,
minimised, off the screen at x=4200, minimised and off the screen, and
already in front — all five ended in front on attempt 1; the off-screen
cases were moved to (40,40); the fallback chain was never needed.

**End to end through a user-started server** (the context that counts),
session `live-focus-1`, steps posted in three batches against
`pdf-dialog-cancel.md`'s project so `desktop.enabled` applied:

| Setup between batches | Step | Result |
| --- | --- | --- |
| browser minimised from outside (`(0,0 0×0)`, Claude app in front) | `Focus the window whose title contains "statement.pdf"` | `→ ok (restored from minimised, now in front)`, attempt 1 |
| | `Verify the statement PDF is showing on the screen` | holds, judged from the capture |
| browser moved to x=4200 (`(4200,150 0×900)`, a stand-in for a second monitor) | the same focus step | `→ ok (moved onto the main display, already in front)`, now `(40,40 1440×900)` |
| | the same verify step | holds |
| | `[use browser]`, then `Verify the page URL ends with statement.pdf` | passed on the same tab |

Not measured: a real second monitor (this box has one display), and the macOS
and Linux helpers. Windows never refused in the runs above, but did in the
Copilot run later the same day (§15.7): two focus calls refused with the
Extension Development Host in front, and the minimise+restore fallback on
attempt 3 brought the browser forward.

## 15. Over the Copilot bridge

**Status:** spec, for build. Opened 2026-09-23.

### 15.1 The problem

TestBench's Copilot bridge (`testbench-native/src/extension/lm-bridge*.ts`,
stories/copilot-lm-bridge.md) is a local OpenAI-compatible endpoint that the
server reaches as `AI_MODEL=gateway/copilot/<model>` + `AI_GATEWAY_URL`. It
carries text only: every `image_url` block is replaced with
`[screenshot omitted — images unsupported over the bridge]` before the request
reaches `vscode.lm`. Browser mode survives that — it has the DOM. Computer
mode does not: the image is the whole of what the model sees, so over the
bridge the model is asked to click by coordinates on a screen it was never
shown, and the server cannot tell, because the stripping happens after the
request leaves it. The likely outcomes are a guessed click on the real
screen or a `noop` that passes a step that did nothing.

Two changes, each useful without the other.

### 15.2 The bridge forwards images

- An `image_url` block whose URL is a `data:` URL is decoded and sent as
  `vscode.LanguageModelDataPart.image(bytes, mime)` inside the same user
  message, in order with its text parts.
- **Feature-detected, not version-gated.** The extension keeps its `^1.90`
  engine floor. When `vscode.LanguageModelDataPart?.image` is not a function
  (an older VS Code), the bridge strips as today, with the same note and
  once-per-window warning. The `@types/vscode` it compiles against (1.116)
  already declares the class.
- A non-`data:` image URL (`https://…`) cannot be fetched by the bridge and is
  stripped with the note, as today.
- Images in an assistant message are stripped (vscode.lm assistant messages
  take no data parts); the server never sends one.
- **A model that rejects images** — `sendRequest` throws for a request that
  carried image parts — is answered with HTTP 400 and
  `{"error":{"message":…,"type":"invalid_request_error","code":"image_input_unsupported"}}`,
  the message naming the model and saying that computer mode and
  `ai.sendScreenshots` need a model that accepts images. Never silently
  retried without the image.
- The body-size limit is raised if needed so a 1600-px PNG screenshot fits.
- Token measurement (`countTokens`) counts the text parts; an image part is
  not a string and must not make the measurement throw.

### 15.3 The bridge says what it will do with images

`GET /v1/models` gains, additively:

```json
{
  "object": "list",
  "aiui_bridge": { "name": "testbench-copilot-bridge", "images": "forward" },
  "data": [
    { "id": "copilot/gpt-5.6-luna", "object": "model", "owned_by": "copilot",
      "family": "gpt-5.6-luna", "image_input": null }
  ]
}
```

- `aiui_bridge.images` is `"forward"` when §15.2's detection found the data
  part, `"strip"` otherwise. Its presence is how the server knows the endpoint
  is this bridge and not a corporate gateway.
- `image_input` per model is `true` / `false` when the running VS Code exposes
  the model's capabilities at runtime, and `null` when it does not. The
  public `LanguageModelChat` type declares no capabilities (they are on the
  provider-side `LanguageModelChatInformation`), but VS Code 1.138's extension
  host sets `capabilities.supportsImageToText` on the object a caller gets
  back, from the provider's `vision` metadata (read in its extension-host
  code, 2026-09-23). So on current VS Code the answer is `true` or `false`,
  and a provider that declares no vision reads `false` — which §15.4 refuses.
  `null` is left for older builds, and means "forwarded; the model decides".

### 15.4 Computer mode refuses a blind route

A new precondition on `[use computer]`, after the project opt-in (§5.1 item
1) and before nut.js loads, so it costs nothing on the machine:

- Only for a gateway-routed model (`gateway/…`, `aibroker/…`) with a custom
  gateway URL. Other routes are not asked: a direct provider or a real
  gateway answers an image sent to a text-only model with an error, which is
  loud rather than blind.
- `GET {gatewayUrl}/v1/models` with the configured key, 3-second timeout.
  - No `aiui_bridge` field, a non-200, or no answer → proceed (not the
    bridge, or not reachable yet — the first real request will say so).
  - `aiui_bridge.images === "strip"` → the step fails: *Computer mode needs
    the model to see the screen, but the TestBench Copilot bridge drops
    images on this VS Code (it has no image support for language models).
    Update VS Code, or run computer-mode steps with a model that is not
    routed through the bridge.*
  - The selected model's entry has `image_input === false` → the step fails
    naming the model and suggesting one whose entry is not `false`.
  - Otherwise → proceed.
- The check uses the session's effective AI configuration at the moment of
  `[use computer]`. A model changed afterwards through run settings is not
  re-checked; §15.2's 400 is the backstop.
- A computer-mode request answered with `image_input_unsupported` fails the
  step at once, with the bridge's message, and is not retried: retrying sends
  the same image to the same model.

### 15.5 Belt and braces in the prompt

The computer-mode system prompt gains one rule: if a message carries no image,
or says the screenshot was omitted, do not guess coordinates — answer
`assert` with `"holds": false` and evidence *no screenshot was received*.
That covers any stripping route §15.4 cannot see.

### 15.6 Tests

Bridge (runner-free `node --test` over `lm-bridge-core`, plus the fake-`vscode.lm`
integration suite): data-URL decode to bytes + mime; order of text and image
parts preserved; forward vs strip by feature detection; non-data URL
stripped; assistant image stripped; model rejection → 400
`image_input_unsupported`; `/v1/models` carries `aiui_bridge` and
`image_input`; `countTokens` with an image part does not throw; body limit
admits a realistic screenshot. Server (vitest): the §15.4 decision table with
a fake fetch; precondition order; the session and CLI wiring; the
`image_input_unsupported` step failure is not retried; the prompt rule.

A live run over real Copilot needs the user: an Extension Development Host
from this worktree, Copilot signed in, the bridge's one-time model-access
consent, and the server started from their terminal.

### 15.7 Live result (2026-09-23)

Over real Copilot, VS Code 1.138, an Extension Development Host running this
branch's TestBench 0.5.145 as the only VS Code window (see CLAUDE.md on the
bridge port), the server started from a terminal, **TestBench: Use Copilot for
AI** having written `AI_MODEL=gateway/copilot/gpt-6-luna`:

- `GET /v1/models` answered `aiui_bridge: {"images":"forward"}`, and VS Code
  exposed a capability for every model: 42 `true`, two `false`
  (`copilot/gpt-4o-mini`, `copilot/copilot-utility-small`) — none `null`,
  as §15.3 now says.
- **`pdf-dialog-cancel.md` passed 10/10 in 67 s** with every model call going
  to the bridge (14 `POST 127.0.0.1:18790/v1/chat/completions`). The
  `[use computer]` check logged `the bridge forwards images;
  copilot/gpt-6-luna image_input: true`. The bridge logged no image strip,
  and the model clicked Print and Cancel from the pixels.
- **A text-only model is refused at no cost.** `[use computer]` alone with
  `AI_MODEL=gateway/copilot/gpt-4o-mini` failed in 0.2 s with the §15.4
  message listing image-capable models on the same bridge — zero model
  requests, no browser launched.
- **The focus fallback ran for real** (§14): with the dev host window in
  front, Windows refused the first two focus calls from the user-started
  server; attempt 3, minimise + restore through the PowerShell helper, brought
  the browser forward. The step then passed.
