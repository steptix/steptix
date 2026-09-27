/**
 * Pure helpers for the panel's Recording block (stories/testbench-record-steps.md,
 * decision 13; stories/testbench-record-toolbar.md).
 *
 * Inline copies of `formatRecordTime`, `recordingStatusText` and
 * `draftStepMarks` in src/extension/record-steps-core.ts: the webview bundle
 * cannot import the extension's TypeScript, and the status bar and the panel
 * describe the same recording to the same person, so the two must read alike.
 * tests/record-steps.test.js and tests/record-steps-authored.test.js pin the
 * copies to the originals.
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
  return `${state.paused ? "Recording paused" : "Recording"} — ${n} ${n === 1 ? "action" : "actions"}`;
}

/** Steps so far, marked: a lock on each locked step, "yours" on the author's. */
export function draftStepMarksInline(draft) {
  if (!draft) return [];
  const locked = Number.isFinite(draft.locked) ? Number(draft.locked) : 0;
  const yours = new Set(Array.isArray(draft.authored) ? draft.authored : []);
  return draft.steps.map((_, i) => ({ locked: i < locked, yours: yours.has(i) }));
}

// ---------------------------------------------------------------------------
// The Add step box (stories/testbench-record-toolbar.md §"VS Code alongside")
// ---------------------------------------------------------------------------
//
// `{ text, pending, error }`: what is typed in the box; the press waiting for
// the host's answer (`{ id, text }` — the text it sent), or null; and why the
// last press was not taken, or null. The text is never cleared on the press:
// only an answer that the server took the steps clears it, and only when the
// box still holds what was sent (anything typed meanwhile stays).

/** An empty box. */
export const EMPTY_ADD_STEP_BOX = Object.freeze({ text: "", pending: null, error: null });

/** The author typed in the box: the old reason goes, the text is theirs. */
export function addStepBoxEdit(box, text) {
  return { ...box, text, error: null };
}

/** Add pressed, as press `id`: waiting for the answer, the text kept. A blank
 *  box, or one still waiting, sends nothing — `sent` says whether to post. */
export function addStepBoxSend(box, id) {
  if (box.pending || box.text.trim() === "") return { box, sent: false };
  return { box: { ...box, pending: { id, text: box.text }, error: null }, sent: true };
}

/** The host's `recordAddStepResult`: taken — cleared, unless the author typed
 *  something else meanwhile; not taken — the text stays, with the reason. An
 *  answer to another press changes nothing. */
export function addStepBoxAnswer(box, answer) {
  if (!box.pending || !answer || answer.id !== box.pending.id) return box;
  if (answer.accepted === true) {
    return { text: box.text === box.pending.text ? "" : box.text, pending: null, error: null };
  }
  const said = typeof answer.reason === "string" ? answer.reason.trim().replace(/\.+$/, "") : "";
  const reason = said !== "" ? said : "the recording did not take it";
  return { text: box.text, pending: null, error: `The step was not added — ${reason}.` };
}
