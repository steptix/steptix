# TestBench Resume Position-Anchor Spec

Defines how the **resume point** of a paused run — the yellow ▶ "continue from
here" marker — survives the user editing the test file between pausing and
clicking Continue. Replaces the current raw-line-number `breakpointStop` with a
position that VS Code shifts as text is inserted/deleted around it, so Continue
always resumes the step the user actually paused on.

Companion to [debugging-ux.md](./debugging-ux.md) (run/pause/resume/stop
semantics) and [run-state-persistence.md](./run-state-persistence.md) (the
per-URI state in `ActiveFileTracker`). Addresses
[issues/010-resume-uses-line-numbers-not-step-ordinals.md](../../../issues/010-resume-uses-line-numbers-not-step-ordinals.md).

## 1. Background

When a run pauses — at a breakpoint, on an explicit user Pause, or
paused-on-error — the resume point is stored as a raw 1-based line number in
`FileState.breakpointStop`
([active-file-tracker.ts:54](../../src/extension/active-file-tracker.ts#L54)).
On Continue the client re-reads the live document, extracts the steps, and
filters to `line >= breakpointStop`
([commands/index.ts:177-179](../../src/extension/commands/index.ts#L177-L179)).

This is correct only while the document is unchanged between pause and
Continue. A plain integer has no connection to the text, so if the user edits
the file first, the stored number points at the wrong step:

- **Insert a step above the pause line.** Every later step shifts down. The
  filter `line >= breakpointStop` now also matches the newly-inserted line —
  a step the user never intended to run executes silently, in addition to the
  intended one.
- **Insert a step exactly at the pause line.** The new step becomes the resume
  point; the step the user actually paused on shifts down and runs second.
- **Delete the pause-line step.** The step below slides up into the old line;
  the filter runs *it* while the intended step is silently skipped.

VS Code's own gutter breakpoints (`SourceBreakpoint`) dodge this because VS
Code tracks them as anchors that shift with edits. `breakpointStop` is
TestBench's own tracker-side state — a number — and does not shift.

### Why not the simpler options

- **Step ordinal** ("resume the 3rd step") survives inserts/deletes *above* the
  resume point but fails the same way as a line number when the resume step
  itself is deleted (ordinal 3 silently re-points at the old 4th step), and it
  does not address the rendering of the ▶ arrow after same-line edits.
- **Reusing `vscode.debug.breakpoints`** would get VS Code's shifting for free
  but overloads the user-facing breakpoint list with an internal marker the
  user never set, coupling resume state to a feature with its own
  enable/disable/clear semantics.

We deliberately **imitate** VS Code's breakpoint anchoring with our own
position + change-listener, keeping the resume marker as private extension
state, separate from the breakpoint store.

## 2. Goals

1. After a pause, editing the test file before Continue resumes the step the
   user paused on — regardless of inserts or deletes elsewhere in the file.
2. The ▶ pause arrow stays painted on the correct step as the document is
   edited.
3. When the paused step itself is deleted, Continue resumes from the **next
   surviving step** at or after the deleted position (rather than silently
   running a shifted-up neighbour).
4. No change to the wire protocol, the decoration consumers, or the webview —
   they keep consuming a current line number.
5. The marker remains transient (never persisted) and stays out of
   `vscode.debug.breakpoints`.

## 3. Non-goals

- Persisting the resume point across a VS Code restart. A reload means no live
  run, so there is nothing to resume — `breakpointStop` is already excluded
  from persistence ([active-file-tracker.ts:483](../../src/extension/active-file-tracker.ts#L483))
  and stays so.
- Anchoring inside expanded skill bodies. A pause inside a skill anchors to the
  test-file `[skill: ...]` line and Continue re-runs the whole skill from the
  top ([run-controller.ts:904](../../src/extension/run-controller.ts#L904));
  that line is itself an anchorable step line, so it is covered by the same
  mechanism with no special case.
- Changing the `step:awaiting` (`stepPausedAt`) live-pause path. That Continue
  goes through `sendRunControl('continue')` without re-reading or filtering the
  document, so its line is used only for rendering. Its arrow can still drift on
  edit; fixing that glyph is tracked separately and is out of scope here.

## 4. Design

### 4.1 Anchor as the source of truth, line as the derived view

`ActiveFileTracker` gains a single private field for the live pause:

```ts
private breakpointAnchor: { uri: string; position: vscode.Position } | null = null;
```

It is **not** stored on the per-URI `FileState` (which is persisted and keyed
per document); the anchor is a single live-run marker. `setBreakpointStop(uri,
line)` becomes the one place that records it:

- `line != null` → `breakpointAnchor = { uri, position: new vscode.Position(line - 1, 0) }`
  and `FileState.breakpointStop = line`.
- `line == null` → clears both.

Every snapshot keeps exposing `breakpointStop` **as a line number**, now derived
from the anchor when one exists:

```ts
breakpointStop: this.breakpointAnchor?.uri === key
  ? this.breakpointAnchor.position.line + 1
  : state.breakpointStop,
```

Because the snapshot field stays a line, the decoration manager
([decorations.ts](../../src/extension/decorations.ts)) and the webview
(`Resume (line N)`, per-line ▶) need no changes.

### 4.2 Shifting the anchor on edits

The tracker already subscribes to `onDidChangeTextDocument`
([active-file-tracker.ts:132-138](../../src/extension/active-file-tracker.ts#L132-L138)).
That handler gains anchor maintenance for the file holding the anchor:

For each `event.contentChanges` entry (range `r`, replacement `text`):

1. Compute the net line delta of the edit: `addedLines = count('\n' in text)`,
   `removedLines = r.end.line - r.start.line`, `delta = addedLines - removedLines`.
2. **Edit entirely above the anchor** (`r.end.line < anchorLine`): shift the
   anchor by `delta`.
3. **Edit entirely below the anchor** (`r.start.line > anchorLine`): no change.
4. **Edit touches the anchor line** (`r.start.line <= anchorLine <= r.end.line`):
   the resume step may have been altered or deleted. Re-extract steps from the
   post-edit text and snap the anchor to the **first step line `>=`** the
   anchor's (possibly shifted) position. If no step remains at or after it,
   clear the anchor (Continue then has nothing to resume; treat as run
   complete).

All of a single event's `contentChanges` are reported in the document's
**original** coordinates and applied simultaneously, so the math classifies
**every** change against the *original* `anchorLine` in one pass (function
`shiftAnchorForChanges`) rather than folding them one at a time. Folding
per-change mixed pre- and post-edit coordinates and double-counted an
above-anchor shift whenever the same event also touched the anchor line
(multi-cursor edits, file-wide find/replace, formatters). Because changes
within an event are non-overlapping, at most one can touch the anchor; above
edits sum their deltas, and a touch collapses to the edit's start (shifted by
the above deltas) before the snap. The post-edit step lines are only extracted
when some change actually touches the anchor — plain typing above/below skips
the parse. After processing, if the derived line changed, `emit()` repaints the
arrow at its new location.

This shift math is the only genuinely new logic and carries the bulk of the
unit tests (§6), including multi-change events.

### 4.3 Producers route through `setBreakpointStop`

The three pause producers must funnel through the setter so the anchor is
always captured:

- **Breakpoint pause** — [run-controller.ts:874](../../src/extension/run-controller.ts#L874).
- **User pause** — [run-controller.ts:901-908](../../src/extension/run-controller.ts#L901-L908).
- **Paused-on-error / step:awaiting** — [extension.ts:236/280/282](../../src/extension/extension.ts#L236).

Pre-implementation check: confirm each already calls `setBreakpointStop` rather
than writing `state.breakpointStop` directly. Any direct writer is rerouted
through the setter — otherwise that path captures no anchor and stays broken.

### 4.4 Consumers read the derived current line

`continueRun` ([commands/index.ts:170-184](../../src/extension/commands/index.ts#L170-L184))
and `dispatchStep` ([commands/index.ts:489-519](../../src/extension/commands/index.ts#L489-L519))
already read `breakpointStop` and filter `line >= startLine`. Because the
snapshot value is now anchor-derived and current, both get the fix without
logic changes — but **both** must be verified, since the issue named only the
first and the identical filter lives in `dispatchStep` (Step Into/Over/Out).

### 4.5 Lifecycle

The anchor is cleared wherever `breakpointStop` is cleared today —
`clearBreakpoints`, `clearStatuses`, and run-end/continue via
`setBreakpointStop(uri, null)`. Because the anchor is **tracker-level**, not
per-URI, two paths that drop per-URI state must clear it explicitly too, or it
dangles as a phantom pause that `derivedBreakpointStop` would still report:

- `reconcile()` — when a reopened document's step signature drifted (a git
  pull / branch switch changed the steps), it deletes the URI's state; it now
  also clears the anchor for that URI.
- `resetAllStateForTests()` — the integration harness's between-test reset
  wipes the `states` map; it now nulls the anchor as well. (Missing this is the
  bug that first surfaced as a phantom pause leaking into the next test.)

No new disposable is needed: the anchor rides the tracker's existing
`onDidChangeTextDocument` subscription, already torn down in `dispose()`.

## 5. Edge cases

| Edit between pause and Continue | Behaviour |
|---|---|
| Insert step(s) above the resume step | Anchor shifts down; Continue resumes the same step. No ghost step runs. |
| Insert step(s) below the resume step | No change; Continue resumes the same step. |
| Edit the resume step's wording (within the line) | Anchor unchanged; Continue retries with the new wording (paused-on-error fix-and-retry keeps working). |
| Insert at the *start* of the resume step line (column 0) | Anchor shifts down to the step's new line; Continue resumes the original step, not the inserted line. (A column-0 edit stops before the line's content, so it counts as "above".) |
| Select whole lines *above* the resume step and paste fewer lines | Anchor shifts up by the net lines removed; Continue resumes the original step. The whole-line range ends at column 0 of the resume line, so it doesn't snap. |
| Select lines that *span* the resume step and replace them | Resume step's content was replaced → anchor snaps to the first surviving step at/after the selection start. |
| Delete the resume step | Anchor snaps to the next surviving step at/after the position (Goal 3). |
| Delete all steps at/after the resume point | Anchor clears; Continue has nothing to resume — treated as run complete. |
| Pause inside a skill | Anchored to the test-file `[skill: ...]` line; Continue re-runs the skill (unchanged). |

The above/touch boundary is **column-aware**: a change whose range ends at
column 0 of a line does not touch that line's content, so it's classified as
"above" (shift) rather than "touching" (snap). This is what makes whole-line
selections above the anchor — and inserts at the very start of the anchor line
— shift the resume point instead of snapping it.

## 6. Tests

### Unit — anchor shift math (new)

Drive `ActiveFileTracker` directly:

- Insert N lines above the anchor → derived line increases by N.
- Insert/delete below the anchor → derived line unchanged.
- Delete the resume step → anchor snaps to the next step line.
- Delete the last step at/after the anchor → derived `breakpointStop` is `null`.
- Edit text on the resume line without adding lines → derived line unchanged.

### Integration (`state-machine.test.cjs`, `frames.test.cjs`)

Existing resume cases pause-then-Continue with **no edits** and assert
`breakpointStop === <raw line>`. Add edit-between-pause-and-Continue cases:

- Pause at a breakpoint, **insert a step above** the pause line, Continue →
  resumes the original step (now at a higher line); the inserted step does not
  run.
- Pause, **delete the pause-line step**, Continue → resumes the next surviving
  step.
- Paused-on-error, **insert a step above** the failed line, Continue → no ghost
  step executes.
- Repeat the insert-above case through `dispatchStep` (Step Into) to cover the
  second consumer.

A few existing assertions move from "equals the original raw line" to "equals
the post-edit current line."

## 7. Implementation checklist

- [ ] `active-file-tracker.ts`: add `breakpointAnchor`; capture it in
      `setBreakpointStop`; derive `breakpointStop` in both `snapshot()` and
      `snapshotFor()`; shift/snap/clear it in the `onDidChangeTextDocument`
      handler; clear it in `clearBreakpoints` / `clearStatuses`.
- [ ] Verify (and reroute if needed) the three producers in `run-controller.ts`
      and `extension.ts` go through `setBreakpointStop`.
- [ ] Confirm `continueRun` and `dispatchStep` need no logic change beyond
      reading the now-current `breakpointStop`.
- [ ] Unit tests for the shift math.
- [ ] Integration tests for edit-between-pause-and-Continue (both consumers).
- [ ] Bump the patch version in `testbench-native/package.json` (bundled
      extension code), then build / package / install / reload.
- [ ] On resolution, move
      [issues/010](../../../issues/010-resume-uses-line-numbers-not-step-ordinals.md)
      to `issues/resolved/` with a closing note.

## 8. Open questions (deferred)

- Should the `step:awaiting` arrow get the same anchoring purely for glyph
  accuracy, or is its drift acceptable given Continue ignores its line? (This
  spec leaves it as-is.)
- When the resume step is deleted and we snap forward, should the UI surface a
  one-line notice ("resume point moved to step N") rather than silently
  resuming? (v1: silent snap-forward per Goal 3.)
</content>
</invoke>
