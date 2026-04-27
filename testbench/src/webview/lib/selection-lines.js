// Returns the Set of line numbers covered by the given Monaco selections.
//
// Monaco represents "select whole line N" as a Selection that ENDS at line N+1
// column 1 — the column-1 position is a boundary, not a character on that next
// line. Treating it as part of the selection causes the next line's gutter to
// highlight by mistake (the Alt+Click bug). This helper trims that boundary.
export function getLinesFromSelections(selections, fallbackLine) {
  const lines = new Set();
  for (const selection of selections || []) {
    const sLine = selection.startLineNumber;
    const sCol = selection.startColumn;
    const eLine = selection.endLineNumber;
    const eCol = selection.endColumn;

    let lo = Math.min(sLine, eLine);
    let hi = Math.max(sLine, eLine);

    if (hi > lo) {
      const trailingCol = eLine > sLine ? eCol : sCol;
      if (trailingCol === 1) hi -= 1;
    }

    for (let line = lo; line <= hi; line++) lines.add(line);
  }
  if (lines.size === 0 && fallbackLine != null) return new Set([fallbackLine]);
  return lines;
}

// Pure toggle helper for Alt+Click line-number behavior.
//
// Given the current set of selected lines and a clicked line number, returns
// the next set:
// - If the line is not in the set, add it.
// - If the line is already in the set AND removing it would leave the set
//   empty, keep it (the editor must always have at least one selection).
// - Otherwise remove it.
//
// Driving the toggle from this set — rather than from editor.getSelections() —
// is what fixes the "Alt+Click on the last line" bug: Monaco's default
// mousedown handler may insert its own single-line selection on the last line
// before our listener runs, causing a getSelections-based toggle to flip the
// line back off instead of adding it.
export function toggleLineInSet(currentSet, lineNumber) {
  const next = new Set(currentSet);
  if (next.has(lineNumber)) {
    if (next.size > 1) next.delete(lineNumber);
  } else {
    next.add(lineNumber);
  }
  return next;
}
