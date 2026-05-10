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

Non-goals:

- Replacing the inline debug-style UX. Breakpoints, Pause/Resume, F5 stay.
- Step-level TestItem children. File-level only.
- Parallel execution.
- Continuous-run / watch mode (free to enable later — one-line change).
- A "Debug" run profile. Debug remains the inline editor flow.

## 2. What counts as a test

A `.md` file is a TestBench test iff **all three** hold:

1. Path matches the configured glob (`testbench.testsGlob`, default `**/*.md`).
2. Contains a `## Steps` heading (existing `isTestFile()` in
   [runner-core/src/step-lines.ts](../../../runner-core/src/step-lines.ts)).
3. YAML frontmatter does **not** declare `type: skill`.

Skills are reusable building blocks (see `fixtures/skills/*.md`) — they have
the same Steps shape as tests but are invoked via `[skill: name]` from inside
a real test. Running them standalone has no meaning, so the runner hides them.

Skill exclusion is **frontmatter-driven only**. We do not exclude by
directory convention — a file under `tests/` with `type: skill` is still a
skill, and a file under `skills/` without that marker is still a test if it
has Steps.

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
flows through the inline editor.)

When the user clicks Run:

1. VS Code calls `runHandler(request, token)`. `request.include` is the set
   of TestItems the user selected; `request.exclude` is any de-selected
   descendants of an included branch.
2. Resolve include/exclude to an ordered list of leaf TestItems (document
   order within a folder, folders sorted by path).
3. Pre-flight: if any `RunController` is currently running (single-file or
   batch), bail out with a status-bar message and abort the TestRun. One
   run at a time, period — same constraint as `runLines` already enforces.
4. Create a TestRun via `controller.createTestRun(request)`.
5. For each test in order:
   - `run.enqueued(item)` then `run.started(item)`.
   - `vscode.workspace.openTextDocument(uri)` — loads the doc into memory
     without opening a tab.
   - `registry.get(doc)` → `RunController` (created lazily; cached by URI).
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

### 5.1 Continue-on-failure

A `step:fail` fails the **current** test but does not abort the batch.
Subsequent tests still run. Standard CI behavior; matches the user's
expectation that one batch run gives them the full picture.

A `done` with `status: 'error'` (TestBench-level error like `TB001` env
missing) still fails just that test, attaches the error payload as a
TestMessage, and proceeds to the next one.

## 6. Session lifecycle

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

Only one run at a time across the entire extension — single-file or batch.

- `RunController.runLines` already returns `{ ok: false }` if a run is in
  flight per-controller.
- Batch mode is sequential within itself.
- Cross-mode: the batch run handler checks `registry.anyRunning()` at
  entry. If true → status-bar message ("a run is already in flight"),
  TestRun aborted with all items `skipped()`.
- Inverse direction: user attempting F5 / Run Selected while a batch is
  running gets the same refusal from `runLines`'s existing guard.

This matches how the server-side session keying works (one session per
file path) and avoids any chance of overlapping `streamSteps` calls
hitting the same session.

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
| Open a file, F5 | `testbench.runSelected` → `runLines` | unchanged |
| Click ▶ in editor title bar | unchanged | unchanged |
| Click ▶ in webview sidebar | unchanged | unchanged |
| Set/clear breakpoints | unchanged | ignored by batch |
| Pause / Resume | unchanged | not exposed in batch |
| Sidebar status icons during a run | unchanged | still updates if file under test is the active editor |
| Test Explorer tree | n/a | new |
| Test Results panel | n/a | new |

Both paths funnel into `RunControllerRegistry`, so a controller created by
the inline editor and one created by the batch runner are the same
instance for a given URI.

## 11. Configuration

```jsonc
{
  // Glob of files to consider as candidate tests. Files still must contain
  // ## Steps and not be marked type: skill in frontmatter.
  "testbench.testsGlob": "**/*.md"
}
```

Default `**/*.md` is convention-free: every Markdown file is a candidate;
the `isTestFile` + `not-skill` filter does the actual selection. Users
with large repos can narrow it (`tests/**/*.md`) for discovery speed.

## 12. New code

| File | Purpose |
|---|---|
| `runner-core/src/frontmatter.ts` | `parseFrontmatterType(text): 'skill' \| undefined`. Targeted regex over the frontmatter span. |
| `testbench/src/extension/test-discovery.ts` | Glob + classify + watch; emits add/remove events. |
| `testbench/src/extension/test-controller.ts` | Creates the TestController, syncs TestItems with discovery, implements `runHandler`. |

## 13. Existing code, light edits

- `extension.ts activate()` — instantiate `TestDiscovery` and
  `TestController` after the registry exists; push to `context.subscriptions`.
- `run-controller.ts` — surface a way to force-close-session per run for
  batch mode (method or `runLines` option, TBD during implementation).
- `package.json` — declare `testbench.testsGlob` setting.

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
  rename via the watcher's delete+create cycle.
- **Per-test timeout**: defer. Server-side timeouts already exist; the
  runner trusts them.
- **"Run Until Failure"**: VS Code surfaces this for free if we use the
  standard run profile. Confirm during implementation that the existing
  controller copes with rapid back-to-back runs of the same file (it
  should; it's just `runLines` in a loop with a fresh session each time).
