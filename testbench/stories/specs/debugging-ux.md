# TestBench Debugging UX Spec (v2)

This spec defines the run / pause / resume / stop semantics for a TestBench
test file inside VS Code. It applies to both surfaces — the editor title-bar
icons and the TestBench sidebar toolbar — which must stay consistent at all
times.

## 1. States

The runner is in exactly one of three states:

| State | Meaning |
|---|---|
| `idle` | No run in progress. Default state. |
| `running` | Steps are actively executing. |
| `paused` | Run is halted at a specific line, awaiting Resume or Stop. |

State transitions:

```
idle   ─Run / RunAll / F5 / RunStepHere─▶  running
running ─hit breakpoint─▶                   paused          (auto-pause)
running ─Pause clicked / F5─▶               paused          (user-pause)
running ─finished─▶                         idle
running ─Stop clicked / Shift+F5─▶          idle
paused  ─Resume clicked / F5─▶              running
paused  ─Stop clicked / Shift+F5─▶          idle
```

`running` and `paused` are mutually exclusive.

**Pause** temporarily halts the run, marks the line that was executing as
the resume point, and keeps all statuses on completed steps. Resume re-runs
from that line.

**Stop** aborts the run, clears the breakpoint-pause indicator, and leaves
completed-step statuses in place so the user can see what happened. Next
Run starts from the user's current selection.

## 2. Context keys

These drive `when` clauses in `package.json` and reactive UI in the sidebar.

| Key | True when |
|---|---|
| `testbench.activeFile` | Active editor is a `.md` file containing a `## Steps` heading |
| `testbench.running` | State is `running` |
| `testbench.paused` | State is `paused` |

## 3. Toolbar buttons (editor title bar AND sidebar — same logic)

A single "primary action" slot that swaps based on state, plus a secondary
slot for Stop. The user always sees one obvious next action.

| State | Primary | Secondary | Always-shown |
|---|---|---|---|
| idle | ▶ Run | — | Run All, Close Session |
| running | ⏸ Pause | ◼ Stop | Run All (disabled), Close Session (disabled) |
| paused | ▶ Resume | ◼ Stop | Run All (disabled), Close Session (disabled) |

## 4. Keybindings (when editor focused on a TestBench file)

| Key | idle | running | paused |
|---|---|---|---|
| F5 | Run | Pause | Resume |
| Shift+F5 | — | Stop | Stop |
| F9 | Toggle breakpoint at cursor line | Toggle | Toggle |

## 5. Pause semantics

- Aborts the in-flight HTTP stream (the runner sends contiguous steps as
  one `streamSteps` request; we cancel it).
- The runner tracks the most recent `step:start` event's source line.
  When the user pauses, that line becomes the resume point — the step
  that was *executing* when Pause fired.
- Resume re-runs from the resume point. The first step on resume bypasses
  the "is there a breakpoint here?" check (otherwise a breakpoint on the
  resume line would trap us in a loop).
- Subsequent breakpoints during the resumed run trigger normally.

## 6. Stop semantics

- Aborts the stream if running. No-op if idle.
- Clears the breakpoint-pause marker (yellow ▶) and the `paused` state.
- Statuses on already-completed steps are kept — they're a record of what
  happened, useful for debugging the failed step.

## 7. Visual indicators

- **Editor gutter**: VS Code's native red dot for breakpoints. Our yellow
  ▶ overlay on the paused line (whether the pause came from a breakpoint
  or a manual Pause).
- **Sidebar step list**: ✓ pass / ✗ fail / … running / ▶ paused per step.
- **Output log**: appends events live; entries persist across runs unless
  the user hits "Clear".

## 8. Edge cases

- **Pause while a non-step item is active** (`[input:]` prompt open or
  interactive REPL): cancel the prompt as part of the pause, mark the
  resume point as the input/interactive line so Resume re-shows the
  prompt.
- **Pause then Stop**: Stop wins, returns to idle.
- **Resume with no pause point** (state is somehow stale): no-op, surface
  a status-bar message.
- **File switched mid-run**: the run keeps running on the original file.
  The sidebar follows the active editor, so switching files shows the
  other file's state (likely idle); switch back to see live updates from
  the in-flight run.
- **Run All while paused**: blocked. User must Stop or Resume first.
