# TestBench Test Runner Spec

A multi-test runner for the TestBench VS Code extension. Lets users browse
tests in the workspace, select any subset, and run them as a batch with
aggregated pass/fail reporting. Sits **alongside** the existing single-file
debug-style UX (gutter breakpoints, F5, Pause/Resume) — both feed into the
same `RunControllerRegistry`.

## 1. Goal

Users today open one `.md` file, set breakpoints, and step through it. That's
useful for authoring and debugging individual tests but doesn't scale: there's
no way to ask "do all 30 of my tests still pass after this change?" without
opening each file and pressing F5.

This spec adds:

- A **Test Explorer** entry in VS Code's native Testing sidebar.
- **Discovery** of `.md` files in the workspace that look like TestBench tests.
- **Multi-select runs** with sequential execution and per-test pass/fail.
- **Inline failure surfacing** — failing step lights up at its line.

Non-goals (deferred to v2+):

- Replacing the inline debug-style UX. Breakpoints, Pause/Resume, F5 stay.
- Step-level TestItem children. File-level only.
- Parallel execution.
- Continuous-run / watch mode (free to enable later — one-line change).
- A "Debug" run profile. Debug remains the inline editor flow.
- Coverage profile.

## 2. What counts as a test

A `.md` file is a TestBench test iff **all four** hold:

1. Path matches the configured glob (`testbench.testsGlob`, default `**/*.md`).
2. Contains a `## Steps` heading (existing `isTestFile()` in
   [runner-core/src/step-lines.ts](../../../runner-core/src/step-lines.ts)).
3. YAML frontmatter does **not** declare `type: skill`.
4. YAML frontmatter does **not** declare `disabled: true`.

Skills are reusable building blocks (see `fixtures/skills/*.md`) — they have
the same Steps shape as tests but are invoked via `[skill: name]` from inside
a real test. Running them standalone has no meaning, so the runner hides them.

Skill exclusion is **frontmatter-driven only**. We do not exclude by
directory convention — a file under `tests/` with `type: skill` is still a
skill, and a file under `skills/` without that marker is still a test if it
has Steps.

`disabled: true` is the "skip without un-checking" mechanism. Un-checking a
test in the explorer is transient (re-checked on refresh / reload), which is
fine for "I only want to run these three tests right now" but doesn't survive
as "this flaky test is parked for the week." Frontmatter `disabled: true`
removes the file from discovery entirely until the marker is removed — the
test doesn't appear in the explorer at all.

### 2.1 Test display name

Each TestItem's label is `# Heading (filename.md)` when the file has a
top-level `# Heading`, else just `filename.md`. The TestItem's description
(hover tooltip / "show description" in the explorer) is the workspace-
relative path of the file, so users can disambiguate when two tests share
the same heading.

## 2.2 Tags

Frontmatter `tags: [smoke, slow]` is surfaced as VS Code TestItem tags. The
Testing API has first-class tag filtering — "Run with tag…" in the explorer
toolbar lets the user batch by tag (e.g. run only `@smoke`). No custom UI
needed; declaring the tags on each TestItem is the one line of integration.

## 3. UI surfaces

### 3.1 Native Testing sidebar (Activity Bar → flask icon)

Tree of TestItems, one per qualifying file. Folders nest naturally based on
file path. Every node has a checkbox; multi-select is built in.

```
▾ ☑ tests/
  ▾ ☑ checkout/
    ☑ ✓ add-to-cart.md          0.4s
    ☑ ✗ apply-coupon.md         0.8s
  ▾ ☑ auth/
    ☑ ● signup.md               0.3s
    ☑ ⊘ password-reset.md
```

- Status glyphs to the left of the name: `✓` pass, `✗` fail, `●` running,
  `⊘` skipped, blank = not yet run.
- Top toolbar: Run, Run Failed, Refresh, filter/search.
- Right-click → Run, Reveal in Explorer, Open file, Run Until Failure.

### 3.2 Editor gutter run icon

Files with a `## Steps` heading get a play icon in the gutter next to that
line. Click → runs that file as a single-test batch (one item TestRun).
Right-click extends the same context menu as the sidebar entry.

### 3.3 Test Results panel

Auto-opens on run start. Shows per-test status, per-step output via
`TestRun.appendOutput`, and a `TestMessage` for each `step:fail`.

### 3.4 Inline failure decoration

Each `step:fail` event becomes a `TestMessage` with `location` pointing at
the failing step's source line. VS Code paints a red squiggle / inline
message at that line and links from the Results panel back to it. Hover
shows the full message.

### 3.5 Status bar

While a batch is in flight: `🧪 Running: 3/12 tests…` with click-to-cancel.
Free from the API.

### 3.6 Per-test output panel (Test Results)

Clicking any test in the explorer reveals its individual entry in the Test
Results panel. The entry shows:

- **Result**: passed / failed / skipped, with duration.
- **Step log**: every `step:start`, `step:pass`, `step:fail` and any
  `output` events the controller emitted, in order.
- **Failure messages**: each `step:fail` is a separate `TestMessage` with a
  click-to-jump location at the failing step's source line.
- **Env used**: the resolved env name for that test (see §5.2).
- **Link to the on-disk log** under `reports/logs/` for the run.

Results persist across VS Code reloads — VS Code's TestController stores
last-run state, so after a reload the explorer still shows green / red icons
and the Test Results panel can be re-opened on any test to review its log.

### 3.7 Webview sidebar during a batch run

The existing TestBench sidebar webview stays focused on the active editor,
the same as during single-file runs. While a batch is in flight:

- Run / Pause / Resume buttons are hidden via the existing
  `testbench.running` context key (already true today for single-file runs).
- The webview's Stop button is reinterpreted as **Cancel batch** — clicking
  it cancels the whole TestRun. No per-file stop while the batch owns the
  controller.
- A non-intrusive banner at the top of the webview reads
  `Batch run: 5/12 tests — Open Test Results` with the link opening the
  Test Results panel.
- The prompt UI for interactive `[input: ...]` / `[interactive]` steps
  cannot fire during a batch (those steps auto-fail per §5.4), so there is
  no two-prompt-sources conflict to worry about.

If the active editor happens to be a file currently running in the batch,
the gutter status ticks and yellow ▶ continue to animate as usual — the
single-file decoration system observes the same event stream.

### 3.8 Editor surfaces during a batch run

If a test file is open in an editor while it's running as part of a batch:

- Gutter status icons (pass / fail / running / stopped) update live, same
  as a single-file run.
- The "N/M passed" steps-summary decoration ticks up as steps complete.
- Breakpoints are still rendered in the gutter but **do not fire** —
  batch mode passes an empty breakpoints set (see §7).

If the active editor is some other file (or no file), only the explorer +
status bar + Test Results panel reflect the batch.

## 4. Discovery

`TestDiscovery` is a workspace-scoped service that:

1. **Initial scan** — on activation, glob the workspace with
   `testbench.testsGlob`, classify each match (parse frontmatter + check for
   `## Steps`), and create a TestItem for each qualifying file.
2. **Watch** — a `vscode.workspace.createFileSystemWatcher` for the same
   glob handles `onDidCreate`, `onDidChange`, `onDidDelete`. On change,
   re-classify the single file and add/remove its TestItem.
3. **Refresh handler** — wired to the TestController's refresh button;
   re-runs the initial scan.

Frontmatter parsing lives in `runner-core/src/frontmatter.ts` so the same
rule can be reused server-side or by the CLI later. We only need to read
the `type` field, so a targeted regex (`^type:\s*skill\s*$/m` inside the
frontmatter span) is sufficient — we don't need a full YAML parser.

## 5. Run flow

The TestController is created once on activation. It exposes one
`TestRunProfile` of kind `Run` labelled "Run". (No Debug profile — debug
flows through the inline editor.) The profile has a `configureHandler`
which surfaces the env-picker (see §5.2).

VS Code's free "Run Failed Tests" / "Rerun Last" commands work without
extra wiring — the API tracks last-run state per TestItem.

### 5.1 The handler

When the user clicks Run:

When the user clicks Run:

1. VS Code calls `runHandler(request, token)`. `request.include` is the set
   of TestItems the user selected; `request.exclude` is any de-selected
   descendants of an included branch.
2. Resolve include/exclude to an ordered list of leaf TestItems (document
   order within a folder, folders sorted by path).
3. Queue: if another **batch** is currently running, this run is chained onto
   the test controller's internal `runChain` (FIFO) rather than refused — its
   tests show as `enqueued` and a status-bar note says it was queued. It
   executes when the runs ahead of it finish. An interactive editor run never
   blocks a batch (separate controllers + sessions). See §8.
4. Create a TestRun via `controller.createTestRun(request)` and mark its items
   `enqueued` immediately (so a queued run shows as pending).
5. For each test in order:
   - `run.enqueued(item)` then `run.started(item)`.
   - `vscode.workspace.openTextDocument(uri)` — loads the doc into memory
     without opening a tab.
   - `registry.getBatchController(doc)` → a **detached, headless**
     `RunController` (created lazily; cached by URI). It is kept OUT of the
     editor's controller map: its `post` callback is a no-op, so a batch run
     paints no gutter decorations, drives no sidebar webview, sets no
     `testbench-native.running` context key (which gates the title-bar
     Pause/Stop buttons), and never appears in the Call Stack / Variables
     views. The editor surface is untouched by a flask run.
   - **Force a fresh session** for this test (see §6).
   - Subscribe to events on this controller for the duration of this test.
   - `controller.runLines([], { breakpoints: new Set() })` — empty lines
     means "run every step"; empty breakpoints disables trim. Batch mode
     ignores user breakpoints by design (see §7).
   - Buffer step events. On `step:fail`, build a `TestMessage` with
     `location: { uri, range }` pointing at the failing line.
   - On `done`:
     - Status `passed` and no `step:fail` → `run.passed(item, durationMs)`.
     - Otherwise → `run.failed(item, messages, durationMs)`.
   - Append per-step `[ts] step N — instruction` lines via
     `run.appendOutput()` so the Results panel has a per-test log.
   - If `token.isCancellationRequested` → break the loop; call
     `run.skipped()` on every remaining item.
6. `run.end()`.

### 5.2 Environment selection

Each test in a batch resolves its env at run-start in this order:

1. **Frontmatter override** — if the file's frontmatter declares `env:
   <name>`, that env is used for this test regardless of the batch's
   active env. Lets tests pin themselves to a specific environment (e.g.
   a smoke test that only runs against staging).
2. **Batch env** — picked via the run profile's `configureHandler` (gear
   icon on the "Run" profile in the explorer). Opens a quickPick listing
   every env discovered in the workspace (one entry per `.env.<name>` /
   `data/<name>.json` plus an "(default — no env)" option). The selection
   is **pinned for the duration of this TestRun** — mid-batch env changes
   never split results.
3. **Fallback** — `testbench.activeEnv` setting (the env shown in the
   status-bar item the user toggles for single-file runs).

The TestRun's metadata records the resolved env per test, so the Test
Results panel can show "ran with env: prod" alongside the pass/fail. When
two tests in the same batch run under different envs (e.g. one with a
frontmatter override), that's clearly visible.

### 5.3 Continue-on-failure

A `step:fail` fails the **current** test but does not abort the batch.
Subsequent tests still run. Standard CI behavior; matches the user's
expectation that one batch run gives them the full picture.

A `done` with `status: 'error'` (TestBench-level error like `TB001` env
missing) still fails just that test, attaches the error payload as a
TestMessage, and proceeds to the next one.

### 5.4 Interactive steps in batch mode

Tests can include steps that require a human in the loop:

- `[input: varName]` — prompts the user for a value.
- `[interactive]` — opens a REPL.

In single-file mode these block until the user answers. In batch mode
there is no usable UX for "test 7 of 30 is asking you a question," so:

- When the runner encounters an interactive step in batch mode, it
  **auto-fails the test immediately** with a `TestMessage` whose
  location points at the interactive-step line and whose body reads:
  `Step <N> on line <L> requires interactive input — interactive and
  [input: ...] steps cannot run in batch mode. Run this test from its
  editor (F5) instead.`
- The batch continues with the next test. No prompt UI ever appears.

This needs a small change in `run-controller.ts`: the `RunController`
gains a `batchMode: boolean` option on `runLines`; when true, the
`runInteractive` / `requestPrompt` paths short-circuit to a fail event
instead of blocking. Single-file flow keeps prompting as today.

### 5.5 Cancellation

When the user cancels mid-batch (the X next to the run-progress in the
status bar, or the webview's "Cancel batch" button):

- The currently-running test is marked **`skipped`** (it ran partially,
  but the user told us they don't want results — skipped is more
  truthful than failed).
- The browser session for that test is closed (`controller.closeSession`)
  so the next batch run starts clean.
- All remaining queued tests are marked `skipped` without ever being
  started.
- `run.end()` is called.

The cancel-cleans-session step is critical: without it the next batch
run would inherit a wedged session and hit the same short-circuit bug
that the 0.2.30 `staleSessionCleared` fix addressed. The cancel path
must restore the same clean state we already ensure between batch tests.

## 6. Session lifecycle

> **Superseded by issue 032 (Case 2) + the detached batch controller.** The
> "close before run" / `forceFreshSession` pre-close model below is no longer
> how batch isolation works. Each batch run now gets a **unique per-run
> session id** (`<file path>::run-N`) on a detached, headless controller, and
> closes *that* session in `runLines`' `finally` (post-run, which also
> finalises its video). There is no pre-close for batch. Two runs of the same
> file are therefore two distinct sessions, and a batch can run alongside an
> interactive run of the same file. The text below is kept for historical
> context.

Each test in a batch gets a **fresh server session** — close before run.
This generalizes the `staleSessionCleared` flag added in 0.2.30:

- Single-file flow (today): close once on the first `runLines` per
  controller. Subsequent runs reuse the session.
- Batch flow: close before *every* test, regardless of whether the
  controller is fresh.

Rationale: in a batch, tests must be independent. Browser state from test
N-1 must not leak into test N. The cost (one session-close + one
fresh-browser launch per test) is acceptable — users opted into a batch
run and expect CI-style isolation.

Implementation: `RunController` exposes a `closeStaleSession()` method (or
`runLines` gains a `forceFreshSession?: boolean` option). The single-file
path keeps its current behavior; the batch runner explicitly opts in.

## 7. Breakpoints in batch mode

Batch runs ignore `vscode.debug.breakpoints` entirely — pass an empty
`Set<number>` to `runLines`.

Reasoning: a breakpoint pausing a batch run leads to ambiguous semantics
("does the rest of the batch keep going? is this paused-state per-test or
batch-wide?") and the inline editor is the right place for breakpoint
debugging. If the user wants to debug a specific test, they open it and
use the existing F5 flow.

This is documented in the run profile's description so users don't expect
breakpoints to fire inside the explorer.

## 8. Concurrency

A batch and an interactive editor run are **independent** — they use separate
`RunController` instances (the editor's map vs. the detached batch map) and
separate browser sessions, so they can run at the same time, even for the
same file.

- `RunController.runLines` returns `{ ok: false }` if a run is already in
  flight **on that controller**. Since the editor and batch controllers are
  distinct instances, this only serialises runs *within* one surface.
- Batch mode is sequential within itself.
- Batch vs. batch: a flask run requested while another batch is in flight is
  **queued** (FIFO), not refused. The test controller chains it onto an
  internal `runChain` promise; the queued run's tests are marked `enqueued`
  (so they show as pending in the Test Explorer) and a status-bar note says it
  was queued. Queued runs execute one after another. Cancelling a queued run
  before its turn marks all its items `skipped()`.
- An in-flight interactive run does **not** block a batch (and vice versa);
  the two surfaces own separate controllers and sessions.

Per-run session keying keeps overlapping `streamSteps` calls safe: an
interactive run uses the stable `<file path>` session id while a batch run
uses a unique `<file path>::run-N` id (issue 032), so even the same file
running in both surfaces targets two distinct server **sessions**.

One shared resource used to remain: the server-side step cache, keyed by
`testFilePath` rather than session id, so two concurrent runs of the same
file read and wrote one cache namespace. The step cache has since been
removed.

## 9. Result mapping

File-as-test, but step events still surface as messages.

- **Pass**: `done` with `status: 'passed'`, every `step:start` had a
  `step:pass`, no `step:fail`. → `run.passed(item, durationMs)`.
- **Fail**: any `step:fail`, or `done` with `status: 'failed' | 'error'`.
  → `run.failed(item, messages, durationMs)`.
- **Skipped**: cancellation token tripped before this item ran. →
  `run.skipped(item)`.

Messages attached on fail:

- One `TestMessage` per `step:fail` with `location` set to the failing
  line, message body = the failure reason from the event.
- If `done.status === 'error'`, an additional `TestMessage` for the
  TB-code error payload.

## 10. Coexistence with existing UX

| Surface | Single-file path (existing) | Batch path (new) |
|---|---|---|
| Open a file, F5 | `testbench.runSelected` → `runLines` | refused while a batch is in flight (status-bar message) |
| Click ▶ in editor title bar | unchanged | hidden during batch (gated on `testbench.running`) |
| Click ▶ / ⏵ / ⏸ in webview sidebar | unchanged | hidden during batch |
| Click ⏹ in webview sidebar | stops the single-file run | cancels the whole TestRun |
| Set/clear breakpoints | unchanged | ignored by batch (breakpoints still render in gutter) |
| Pause / Resume | unchanged | not exposed in batch |
| Sidebar status icons during a run | unchanged | still updates if the file under test is open |
| Sidebar webview banner | absent | shows `Batch run: N/M tests — Open Test Results` |
| Test Explorer tree | n/a | new |
| Test Results panel | n/a | new |
| Status bar | env selector / run log link | also shows `🧪 Running: N/M tests…` with cancel |

Both paths funnel into `RunControllerRegistry`, so a controller created by
the inline editor and one created by the batch runner are the same
instance for a given URI.

## 11. Configuration

```jsonc
{
  // Glob of files to consider as candidate tests. Files still must contain
  // ## Steps and not be marked type: skill or disabled: true in frontmatter.
  "testbench.testsGlob": "**/*.md"
}
```

Default `**/*.md` is convention-free: every Markdown file is a candidate;
the `isTestFile` + `not-skill` + `not-disabled` filter does the actual
selection. Users with large repos can narrow it (`tests/**/*.md`) for
discovery speed.

### 11.1 Empty state

When discovery finds zero qualifying files, the Testing sidebar shows
the placeholder:

> No tests found — your `.md` files need a `## Steps` heading.
>
> Tip: `testbench.testsGlob` defaults to `**/*.md`. If your tests live
> in a specific folder, narrow the glob for faster discovery.

The "tip" link opens the setting in VS Code.

### 11.2 Frontmatter fields

| Field | Type | Effect |
|---|---|---|
| `type: skill` | string | Excludes the file from test discovery. |
| `disabled: true` | boolean | Excludes the file from test discovery (long-term "skip"). |
| `env: <name>` | string | Pins this test to the named env in batch runs, overriding the batch's selected env. |
| `tags: [...]` | string[] | Surfaced as TestItem tags for filter / "Run with tag…". |

## 12. New code

| File | Purpose |
|---|---|
| `runner-core/src/frontmatter.ts` | `parseFrontmatter(text): { type?, disabled?, env?, tags?, title? }`. Targeted regex parser for the fields we actually use — no full YAML dep. |
| `testbench/src/extension/test-discovery.ts` | Glob + classify + watch; emits add/remove events. Discovers available envs (`.env.*` / `data/*.json`) for the picker. |
| `testbench/src/extension/test-controller.ts` | Creates the TestController, syncs TestItems with discovery, implements `runHandler` and `configureHandler` (env picker). |
| `testbench/src/extension/batch-webview-banner.ts` | Posts the "Batch run: N/M tests" banner state to the sidebar webview; subscribes to TestRun lifecycle. |

## 13. Existing code, light edits

- `extension.ts activate()` — instantiate `TestDiscovery` and
  `TestController` after the registry exists; push to `context.subscriptions`.
- `run-controller.ts` —
  - Surface a way to force-close-session per run for batch mode (method or
    `runLines` option, TBD during implementation).
  - Add a `batchMode: boolean` option on `runLines` that short-circuits
    `[interactive]` / `[input: ...]` steps to a `step:fail` event instead
    of blocking on the prompt UI.
  - Plumb a per-run env-name override (today the controller reads from
    `EnvSelector.activeEnv()`; the batch needs to pass an explicit env so
    frontmatter overrides + the batch picker take precedence).
- `package.json` — declare `testbench.testsGlob` setting.
- Webview banner: a new `HostToWebviewMsg` variant `{ type: 'batchBanner',
  state: { running: number, total: number } | null }` posted by the test
  controller; the webview renders the banner when `state` is non-null.

## 14. Verification before / during implementation

1. **Server concurrency model** — confirm whether the server can hold
   sessions for two different file paths simultaneously, or whether it
   serializes globally. Affects only future parallel-mode work; the
   sequential-only v1 is safe either way.
2. **Discovery cost on large repos** — measure initial-scan time on a
   realistic workspace. If it's >1s, lazy-load on first sidebar open
   instead of activate.
3. **FileSystemWatcher edge cases** — folder rename produces a burst of
   delete + create events; debounce or coalesce so we don't churn the
   tree.
4. **Workspace with no folders** — TestController should show "no tests
   found" gracefully, not error.

## 15. Open implementation questions

These don't block design approval but will need decisions in code:

- **Folder TestItems**: do we create explicit folder nodes (group by
  directory) or let VS Code group automatically by URI prefix? Auto-group
  is simpler and matches built-in test extensions.
- **Stable TestItem IDs**: use the file's absolute URI as the id. Survives
  rename via the watcher's delete+create cycle. Cross-machine portability
  (last-run state shared across users) is out of scope; revisit only if we
  ever sync TestController state.
- **Per-test timeout**: defer. Server-side timeouts already exist; the
  runner trusts them.
- **"Run Until Failure"**: VS Code surfaces this for free if we use the
  standard run profile. Confirm during implementation that the existing
  controller copes with rapid back-to-back runs of the same file (it
  should; it's just `runLines` in a loop with a fresh session each time).
- **Run All semantics**: top-toolbar Run with no selection runs every
  discovered test (VS Code default — "everything if nothing is explicitly
  excluded"). Confirmed in spec.

## 16. Future work (deliberately out of scope for v1)

- **Coverage profile**: `TestRunProfileKind.Coverage` exists in the API
  for future code-coverage-style integration. Architecture leaves the
  door open.
- **Continuous run / watch mode**: a one-line addition (set the
  `supportsContinuousRun` flag on the run profile) to re-run selected
  tests on file save.
- **Parallel execution**: needs server-side concurrent-session support
  and a way to bound parallelism. Worth revisiting once batch runs are
  stable.
- **Step-level TestItem children**: would let users run a single step
  from the explorer. Today's gutter "Run Step Here" already covers this
  workflow for the active editor.
