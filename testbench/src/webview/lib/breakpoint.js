/**
 * Decide where the "paused at breakpoint" yellow arrow should land after a
 * run finishes. The arrow only makes sense when the run reached the trim
 * point cleanly — if a step failed, the user was aborted, or there was a
 * server error, we never actually got to the breakpoint.
 *
 * Inputs:
 *   pausedAt — the line the breakpoint trim selected during executeSteps
 *              (null if no breakpoint trim happened).
 *   doneStatus — the status of the run's final `done` event.
 *
 * Returns the line to mark with the arrow, or null to keep the gutter clean.
 */
export function nextBreakpointStop(pausedAt, doneStatus) {
  if (pausedAt == null) return null;
  if (doneStatus !== "passed") return null;
  return pausedAt;
}
