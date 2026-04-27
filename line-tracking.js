// Given a line number and a Monaco IModelContentChange list, returns the line
// number after the edits, or null if the line was deleted.
//
// Each change has:
//   range:  { startLineNumber, startColumn, endLineNumber, endColumn }
//   text:   replacement text
//
// Monaco semantics applied here:
// - Pure insertion (range start == range end): inserted text containing N
//   newlines pushes any line strictly below the insertion line down by N.
//   A line equal to the insertion line shifts down only when the insertion is
//   at column 1 and contains at least one newline (i.e., new content was
//   inserted before the original line content).
// - Replacement / deletion (range covers multiple lines or characters): lines
//   strictly inside the deleted range (between sLine and eLine, exclusive of
//   sLine) are dropped. The startLine survives and absorbs surviving content.
//   Lines past the end of the range shift by (newlinesInText - linesRemoved).
//
// Multiple changes are applied in the order they appear in the array.
export function remapLineForChanges(line, changes) {
  let next = line;
  for (const change of changes || []) {
    if (next == null) return null;
    next = applyOne(next, change);
  }
  return next;
}

function applyOne(line, change) {
  const sLine = change.range.startLineNumber;
  const eLine = change.range.endLineNumber;
  const sCol = change.range.startColumn;
  const eCol = change.range.endColumn;
  const newlineCount = countNewlines(change.text);
  const isInsertion = sLine === eLine && sCol === eCol;

  if (isInsertion) {
    if (line > sLine) return line + newlineCount;
    if (line === sLine && sCol === 1 && newlineCount > 0) return line + newlineCount;
    return line;
  }

  // Replacement / deletion of (sLine,sCol)→(eLine,eCol).
  // A column-1 endpoint is a line boundary, not a position on that line —
  // the corresponding line is not actually consumed. Same family of bug as
  // the Alt+Click selection issue.
  const effectiveEndLine = eCol === 1 ? eLine - 1 : eLine;
  const sLineConsumed = sCol === 1 && sLine < eLine;
  const consumedStartLine = sLineConsumed ? sLine : sLine + 1;
  const linesRemoved = eLine - sLine;
  const delta = newlineCount - linesRemoved;

  if (line < sLine) return line;
  if (line === sLine && !sLineConsumed) return line;
  if (line > effectiveEndLine) return line + delta;
  if (line >= consumedStartLine && line <= effectiveEndLine) return null;
  return null;
}

function countNewlines(text) {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

// Convenience: remap a Set<number> of line numbers, dropping any that were
// deleted or fall outside [1, lineCount].
export function remapLineSet(lineSet, changes, lineCount) {
  const next = new Set();
  for (const line of lineSet) {
    const mapped = remapLineForChanges(line, changes);
    if (mapped != null && mapped >= 1 && mapped <= lineCount) next.add(mapped);
  }
  return next;
}

// Convenience: remap an object keyed by line number (e.g. statuses, errors).
export function remapLineMap(lineMap, changes, lineCount) {
  const next = {};
  for (const [key, value] of Object.entries(lineMap || {})) {
    const mapped = remapLineForChanges(Number(key), changes);
    if (mapped != null && mapped >= 1 && mapped <= lineCount) next[mapped] = value;
  }
  return next;
}
