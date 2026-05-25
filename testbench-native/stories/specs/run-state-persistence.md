# TestBench Run-State Persistence Spec

Defines how a test's gutter run decorations — the per-step ✓ pass / ⚡ cached /
✗ fail / skip icons, the inline error band, and the `N/M passed` summary — are
stored so they outlive the editor session, and how a skill file shared by
multiple tests avoids showing a misleading mix of marks from different runs.

Companion to [debugging-ux.md](./debugging-ux.md) (run/pause/resume/stop
semantics) and [test-runner.md](./test-runner.md) (multi-test batch runs). All
three feed the same `RunControllerRegistry` and the same per-URI state in
`ActiveFileTracker`.

## 1. Background

Run statuses live in `ActiveFileTracker`, keyed per document URI
(`statuses: Map<line, status>`, `errors`, `breakpointStop`). The
`DecorationManager` paints them onto every visible editor.

Two problems motivated this spec:

1. **The marks were ephemeral.** State was in-memory only and was deleted the
   moment the `.md` closed. Close/reopen, or a VS Code restart, lost every
   tick. (Breakpoints never had this problem — they live in
   `vscode.debug.breakpoints`, VS Code's own persistent store.)

2. **Shared skills showed a stale mix.** A skill's statuses are keyed only by
   the skill file's URI, shared across every test that calls it. The run-start
   clear only wipes the test file plus skills *the same controller* descended
   into on its previous run. So if Test A ran skill `S` to a full pass, then
   Test B (a different file → different controller) descended into `S` and
   failed on step 1, `S` would show **B's ✗ on step 1 and A's stale ✓ on the
   steps B never reached** — making a short-circuited failure look like it
   "continued."

## 2. Goals

1. Run decorations survive closing the `.md`, reopening it, and restarting
   VS Code.
2. They **travel with the project folder** — zip/copy it to another machine or
   teammate and the ticks come along. (TestBench has a zip-handoff workflow;
   see `docs/zip-project-prompt.md`.)
3. A shared skill always reflects the **most recent** run that used it — never
   a blend of two tests' results.
4. Never paint a mark on the wrong step. If a file changed while its marks were
   stored, drop them rather than misattribute them.

### Non-goals

- Persisting transient run state. A run in flight (`running` spinner) and the
  yellow pause-arrow (`breakpointStop`) are not stored — there is no live run
  after a reload.
- Sharing marks through git. The store is git-ignored (see §3.5); it travels by
  zip/copy, not commit. (Avoids run-result churn in diffs/PRs.)
- Cross-machine portability when the test file is *outside* the workspace
  folder (see §6).

## 3. Design — persistence

### 3.1 Location & key

One file per workspace folder, at its root:

```
<workspaceFolder>/.testbench/run-state.json
```

The owning folder for a file is resolved with
`vscode.workspace.getWorkspaceFolder(uri)` — the same resolution runs already
use. Entries are keyed by the file's path **relative to that folder**,
normalized to forward slashes. Relative keys are the crux of portability: the
absolute path differs on another machine, but `fixtures/tests/login.md` is
identical, so the marks still match after the folder moves.

> This is exactly what co-locating in `.cache/` would get wrong: the StepCache's
> per-test directory names embed the *absolute* path
> (`sanitizeTestName(absolutePath)`), so they don't survive a move either.

### 3.2 On-disk shape

```jsonc
{
  "version": 1,
  "files": {
    "fixtures/tests/skill-demo.md": {
      "signature": "k3f9z1",                 // hash of the step lines
      "statuses": [[12, "pass"], [13, "fail"]],
      "errors":   [[13, { "message": "…", "line": 13 }]]
    },
    "fixtures/skills/shared_skill.md": {
      "signature": "9q2a0p",
      "statuses": [[8, "pass"]]
    }
  }
}
```

### 3.3 What is and isn't stored

| Field | Persisted? |
|---|---|
| `pass`, `pass-cached`, `fail`, `skip`, `stopped` | yes |
| `errors` (per-line error payloads) | yes |
| `running` | **no** — filtered out on both read and write |
| `breakpointStop` (pause arrow) | **no** — not a field in the stored shape |
| breakpoints | n/a — owned by `vscode.debug.breakpoints` |

### 3.4 Drift guard (signature)

Each stored file carries a `signature`: a hash of its step lines (each step's
1-based line number + text). Statuses are pinned to line numbers, so if the
file changed while the marks were stored — an edit elsewhere, a `git pull`, a
branch switch, a teammate's edit before you unzip — those line numbers can no
longer be trusted.

On **open** (`onDidOpenTextDocument`) and at activation for already-open docs,
`reconcile()` recomputes the signature from the live document. On a **mismatch**
it **discards that file's entire stored state** rather than paint ✓/✗ on the
wrong steps. A match (or first sighting) just refreshes the stored signature.
This is conservative — it can drop marks after a benign edit — but it never
lies.

### 3.5 Lifecycle & blast radius

| Action | Result |
|---|---|
| Close / reopen the `.md` | marks survive |
| Restart VS Code | marks survive (hydrated from file at activation) |
| Zip / copy folder to another machine | marks **travel** |
| `Clear Cache for This Test` (StepCache) | marks **untouched** |
| `rm -rf .cache` | marks **untouched** |
| `Clear Run Statuses` command | marks cleared (the explicit intent) |
| Edit a step while the file was closed | that file's marks dropped on reopen (§3.4) |

The independence from `.cache` is deliberate: "clear the AI cache" and "forget
my run results" are different intents and must not be coupled.

`.testbench/` is added to `.gitignore` (matches at any depth, so test-fixture
copies are ignored too). It is **not** excluded by `docs/zip-project-prompt.md`,
so it rides along in the handoff zip.

### 3.6 Write & read mechanics

- **Write** is debounced (~400ms) through the single `emit()` chokepoint that
  every state mutation already funnels through. State is bucketed by owning
  workspace folder and each folder's file is written (or removed, when a folder
  has no marks left). All file I/O is best-effort — a read-only filesystem or a
  permissions error must never break the run UX. A pending write is flushed on
  `dispose()` so a quick quit doesn't lose the last result.
- **Read** happens once at activation (`hydrate()` over every workspace folder),
  reconstructing absolute URIs via `vscode.Uri.joinPath(folder.uri, relPath)`.
  `DecorationManager` repaints automatically via its existing
  `onDidChangeVisibleTextEditors` / tracker subscription.

## 4. Design — shared-skill staleness

When a run first descends into a skill file (its `frame:push`), the registry
clears that skill URI's statuses **before** any of the descent's step events
paint. So a shared skill always shows the current run's results, never a blend.

Two guards keep this correct:

1. **Once per URI per run.** `RunController.clearedDescentUris` is an
   atomic test-and-mark set, cleared by `resetFrameState` at run start. A skill
   invoked twice in one run is cleared only on the first descent; the second
   invocation repaints in place without wiping the first.
2. **Suppressed for continuations.** A Continue/Resume run
   (`isContinuation`) re-pushes frames but must **preserve** the marks earned
   before the pause. `shouldClearDescentStatuses` returns `false` for the whole
   continuation run.

The pre-existing run-start clear (test file + skills the *same* controller
previously descended into) stays — it covers skills the new run does **not**
descend into this time, leaving them blank.

## 5. Worked example (the motivating bug)

```
Test A runs skill S → steps 8,9 pass        S: {8:pass, 9:pass}
Test B (different file) runs skill S:
  frame:push S   → descent-clear fires       S: {}            ← was the bug
  step:start 8 / step:fail 8                  S: {8:fail}
  (failure short-circuits; step 9 never runs) S: {8:fail}
```

Result after close/reopen: skill S shows **8 ✗, 9 blank** — B's failure only,
not A's stale ✓ on 9.

## 6. Edge cases

- **File outside every workspace folder** (`getWorkspaceFolder` → `undefined`):
  not persisted — there is no portable folder-relative key to write it under.
  In-memory marks still paint for the session.
- **Skill in a sibling repo** (outside the workspace root): falls under the
  case above — not persisted. In-repo skills (the normal case) are fine.
- **Multi-root workspace**: one `.testbench/run-state.json` per root, each
  holding only its own files. No cross-root relative paths.
- **Two VS Code windows on the same folder**: last-write-wins on the file —
  the same sharing semantics `workspaceState` already had across windows.

## 7. Testing

Integration tests (`tests/integration/suite/frames.test.cjs`) cover:

- **Portability** — after a run, `.testbench/run-state.json` exists and the key
  is the workspace-relative path (never an absolute path or `file://` URI).
- **Shared-skill clear** — Test A passes a skill's lines 8 & 9; Test B (a
  different file) fails line 8; the skill ends as `{8:fail}` with line 9
  cleared, not a stale ✓.
- **Same-run dedupe** — a second descent into the same skill in one run does not
  re-clear the first invocation's marks.
- **Continuation guard** — a Continue-after-pause that re-pushes the skill frame
  preserves the pre-pause pass.

Because the suite reuses one workspace folder across cases, a global
`beforeEach` calls the `resetRunState` test hook to wipe both in-memory and
on-disk state between tests (otherwise the file would leak marks across cases).

## 8. Rejected alternatives

- **`workspaceState`** (the first implementation): correct VS Code home for
  per-workspace state, but stored under the user-data dir *outside* the project,
  so marks never travel with a zip/copy and are keyed by a hash of the absolute
  workspace path. Replaced by the in-folder file.
- **Inside the StepCache per-test dirs (`.cache/<test>/`)**: would be deleted by
  `Clear Cache for This Test` (lifecycle coupling) and is keyed by absolute path
  (not portable). Rejected.
