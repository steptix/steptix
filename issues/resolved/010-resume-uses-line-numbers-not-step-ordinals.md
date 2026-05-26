# 010 — Resume / paused-on-error uses raw line numbers, not step ordinals

> **RESOLVED 2026-05-26.** Fixed by anchoring the resume point to a
> `vscode.Position` in `ActiveFileTracker` that shifts as the document is
> edited (the "imitate VS Code's own breakpoint anchoring" option, kept
> separate from `vscode.debug.breakpoints`). `breakpointStop` is still exposed
> to the snapshot as a *current* line, so decorations/webview/protocol are
> unchanged; both consumers (`continueRun` and `dispatchStep`) read the
> anchor-derived value. The shift math (`shiftAnchorForChanges`) is
> column-aware so whole-line selections above the anchor shift rather than
> snap, and the tracker-level anchor is cleared anywhere per-URI state is
> dropped (`reconcile`, `resetAllStateForTests`). Design + behaviour table:
> [resume-position-anchor.md](../../testbench-native/stories/specs/resume-position-anchor.md).
> The original design discussion below is kept for history.

**Status:** resolved (was: open / medium priority)
**Area:** [testbench-native/src/extension/commands/index.ts](../../testbench-native/src/extension/commands/index.ts) — `continueRun` breakpoint-paused branch
**Related:** [testbench-native/src/extension/active-file-tracker.ts](../../testbench-native/src/extension/active-file-tracker.ts) — `breakpointStop` field (now anchor-derived)
**Opened:** 2026-05-18
**Resolved:** 2026-05-26

## Summary

When a run pauses (breakpoint, user pause, or paused-on-error), the resume
point is captured as a raw line number in `breakpointStop`. On Continue the
client re-reads the live document text and filters steps to `line >=
startLine`. This is correct when the document hasn't changed, but
silently misbehaves when the user edits the test file before clicking
Continue.

## Reproduce

1. Test file with 5 steps on lines 8–12.
2. Set a breakpoint on step 3 (line 10). Run.
3. Run pauses; `breakpointStop = 10`.
4. **Edit the test file** before Continue. Three failure modes:
   - **Insert a new step at line 9** (between steps 1 and 2). All later
     steps shift down: old step 3 is now at line 11. Continue filter
     `line >= 10` includes the newly-inserted line 10 step — which the
     user did NOT intend to be the resume point. The intended step 3
     also runs (now at 11). Net result: an extra step executes silently.
   - **Insert a new step at line 10** (where breakpointStop sits). Old
     step 3 shifts to line 11. The new step at line 10 is what runs
     first — likely surprising.
   - **Delete the breakpoint-line step.** Old step 4 (line 11) shifts up
     to line 10 — but the user expected step 3 to run. Filter
     `line >= 10` picks up line 10, which is now what was step 4. The
     intended step is silently skipped.

VS Code's own gutter breakpoints (`SourceBreakpoint`) auto-shift with
edits because VS Code tracks them as anchors. `breakpointStop` is our
tracker-side state — a plain number — and does not auto-shift.

## Affects

- Pause + edit + Continue (user-pause and breakpoint-pause).
- Paused-on-error (Phase d) — same `breakpointStop` mechanism. Editing
  the failed step's wording is fine (no line shift) but inserting/
  deleting steps before the failed line desynchronises the same way.
- Step-paused (`step:awaiting`) yellow ▶ — different field
  (`stepPausedAt`) but same fragility class.

Skill files dodge this because pause-inside-skill anchors `breakpointStop`
to the test-file `[skill: ...]` line and Continue re-runs the entire
skill from the top. Test-file resume is the affected case.

## Cleaner design

Anchor the resume point to a **step identity**, not a line number. Two
candidate identities:

1. **Step ordinal** — "the 3rd step in the document." Trivial to compute
   (count `extractSteps` entries up to the cursor). Stable across inserts/
   deletes anywhere *above* the resume point as long as the resume step
   itself isn't deleted.
2. **VS Code position anchor** — wrap the resume line in a
   `vscode.Range` and track it via the document's change-event stream
   (the same machinery VS Code uses for its own breakpoints). Survives
   edits at arbitrary positions, including the breakpoint line shifting
   down because text was added on the same line.

Option 1 is simpler and probably enough — pause-and-edit-the-paused-step
is the most common workflow, and an ordinal is invariant to that. Option
2 handles every edit cleanly but adds a change-listener and disposal
plumbing per controller.

Whichever we pick, the receiving end (`runLines` / `continueRun`) needs
to translate the anchor back to a current line at Continue time, after
the user's edits have landed.

## Tests this would need

The existing tests (`state-machine.test.cjs`, `frames.test.cjs`) all
exercise the resume path with **no document edits** between pause and
Continue. A bulletproof fix needs:

- Pause, insert a step before the pause line, Continue → resumes from
  the *original* step (now at a higher line).
- Pause, delete the pause-line step, Continue → either resumes from the
  *next* surviving step OR reports "resume point gone" gracefully.
- Paused-on-error, edit the failed step's wording, Continue → retries
  with the new wording. (Already works under line-number semantics
  because the line doesn't shift.)
- Paused-on-error, insert a step before the failed line, Continue → no
  silent execution of the inserted step.

## Why we accepted the line-number approach for now

The fix that introduced this was a one-line addition to the existing
breakpointStop machinery for the paused-on-error prototype (Phase d).
Building a step-ordinal anchor system was out of scope for a prototype
that proves the *concept* of fix-and-resume. Documenting the limitation
here so the next pass can address it deliberately rather than rediscover
the foot-gun.

## Revisit when

- A user reports a "ghost step ran" or "skipped step on resume" bug
  after editing a test mid-pause — likely this issue.
- Paused-on-error graduates from prototype to a documented feature.
- We add an "Insert step" command that operates while paused.
