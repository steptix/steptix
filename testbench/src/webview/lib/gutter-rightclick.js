// Pure helpers for the right-click-preserves-selection behavior on the
// editor gutter.
//
// Background: Monaco's internal mousedown handler collapses the editor's
// selections to the line under a right-click before our context-menu
// listener can run. We work around that by snapshotting the editor's
// selections during the capture-phase mousedown event, then re-applying
// them in a microtask after the context menu opens. These functions
// encode the two decisions involved so they can be unit-tested without
// touching Monaco or the DOM.

// Right-click is button === 2 in the standard MouseEvent.button mapping.
// Returns true when the press should trigger a selection snapshot.
export function shouldSnapshotSelection(mouseButton) {
  return mouseButton === 2;
}

// Returns the selections to restore, or null if there is nothing
// meaningful to put back. We only restore when there was a real selection
// captured (a non-empty array). null/undefined snapshots are skipped, as
// is an empty array (no selection existed at the time of the right-click,
// so there's nothing to restore).
export function getSelectionsToRestore(preserved) {
  if (!preserved) return null;
  if (!Array.isArray(preserved)) return null;
  if (preserved.length === 0) return null;
  return preserved;
}
