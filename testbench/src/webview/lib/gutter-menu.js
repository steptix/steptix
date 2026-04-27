// Returns the list of items shown in the gutter line-number right-click
// context menu. Pure data so the menu's contract can be unit-tested without
// rendering React or simulating DOM events.
//
// Inputs:
// - lineNumber: the right-clicked line.
// - hasBreakpoint: whether that line currently has a breakpoint.
// - running: whether a run is in progress.
// - selectedLineCount: how many lines are currently selected; used to switch
//   the run-step label between singular ("Run Test Step") and plural
//   ("Run Test Steps") when 2+ lines are selected.
//
// Each item: { id, label, disabled }
export function getGutterContextMenuItems({
  lineNumber,
  hasBreakpoint,
  running,
  selectedLineCount = 0,
}) {
  if (lineNumber == null) return [];
  const runStepLabel = selectedLineCount >= 2 ? "Run Test Steps" : "Run Test Step";
  return [
    {
      id: "toggle-breakpoint",
      label: hasBreakpoint ? "Remove Breakpoint" : "Add Breakpoint",
      disabled: false,
    },
    {
      id: "run-step",
      label: runStepLabel,
      disabled: !!running,
    },
  ];
}
