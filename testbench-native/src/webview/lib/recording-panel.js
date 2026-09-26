/**
 * Pure helpers for the panel's Recording block (stories/testbench-record-steps.md,
 * decision 13).
 *
 * Inline copies of `formatRecordTime` and `recordingStatusText` in
 * src/extension/record-steps-core.ts: the webview bundle cannot import the
 * extension's TypeScript, and the status bar and the panel describe the same
 * recording to the same person, so the two must read alike.
 * tests/record-steps.test.js pins the copies to the originals.
 */

/** `m:ss` since the recording started. */
export function formatRecordTimeInline(atMs) {
  const total = Math.max(0, Math.floor((Number.isFinite(atMs) ? atMs : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The heading line: what the recording is doing, and how many actions count. */
export function recordingStatusTextInline(state) {
  if (state.phase === "finishing") return "Finishing…";
  if (state.phase === "starting") return "Recording — starting…";
  const n = state.actions.filter((a) => !a.dropped && a.action !== false).length;
  return `Recording — ${n} ${n === 1 ? "action" : "actions"}`;
}
