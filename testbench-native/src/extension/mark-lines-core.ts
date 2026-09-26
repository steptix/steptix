/**
 * Where a run mark goes when the document is edited under it.
 *
 * The tracker pins every ✓ / ✗ / ◌ / ⚠, the failure detail behind it and the
 * error band to a 1-based line number (active-file-tracker.ts), and the editor
 * repaints from those numbers on every keystroke. A number that does not move
 * with the text paints its mark on whatever slid into the old line: insert a
 * line above step 1 and every mark reads one step early, with the last step's
 * mark on nothing at all.
 *
 * The rule is that a mark follows its line's text:
 *
 *  - an edit that ends at or before the line's start moves it by the lines
 *    that edit added or removed;
 *  - an edit that starts after the line's first character leaves it where it
 *    is — whatever it does further along, this line still begins here;
 *  - an edit confined to the line itself keeps the mark, however much of the
 *    text it rewrote. Fixing a typo, or Renumber Steps rewriting the ordinal,
 *    must not wipe the step's result. When that rewrite starts at column 0 and
 *    puts line breaks in, the mark goes with what is left of the line — the
 *    text after the rewrite, now on a later line — rather than staying on the
 *    new text in front of it (`rewriteTail`);
 *  - an edit that takes the line's start AND a line break removes the mark.
 *    Either the line is gone (Ctrl+Shift+K, a multi-line delete) or what is
 *    left of it now continues another line, which already has a start of its
 *    own (Backspace at column 0, Delete at the end of the line above). The
 *    second case is decided by looking at what ends up in front of the line's
 *    text (`stillStartsLine`), not by any one change, because an event's
 *    changes can touch: two selections deleted together can join a line on
 *    without either doing it alone, and a line break inserted right where
 *    another change ends puts back the break that change took.
 *
 * One exception, for the one editor command that moves text by deleting and
 * re-inserting it: Move Line Up / Down (Alt+↑ / Alt+↓). VS Code reports the
 * line the block moves PAST as deleted and re-inserted on the block's other
 * side, which the rules above would read as a removed step — its ✓ gone
 * although its text never changed. `lineMovedPast` recognises that event and
 * sends the mark with it.
 *
 * The removal rule is where this parts from the resume arrow
 * (`shiftAnchorForChanges`, step-lines.ts), which snaps forward to the next
 * step when its line is deleted. That is right for a place to resume and
 * wrong for a result: a ✓ that slid onto the next step would say a step
 * passed that has not run since it was written.
 *
 * Pure and `vscode`-free, so the fast suite pins it.
 */

/** One content change from a `TextDocumentChangeEvent`, 0-based, in the
 *  document's coordinates BEFORE the event (VS Code reports every change of
 *  one event against the original text, applied simultaneously). */
export interface MarkChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  /** The replacement text, line breaks as the document writes them. */
  text: string;
  /** How many characters the range covered before the edit — the event's
   *  `rangeLength`. Only the Move Line check reads it; absent, that check
   *  goes on the positions alone. */
  rangeLength?: number;
}

/** The length of a line of the document AFTER the event, 0-based — what tells
 *  a rewrite that left part of its line behind from one that replaced all of
 *  it (`rewriteTail`). */
export type PostEditLineLength = (line: number) => number;

/** A change with its text measured once, not once per mark. */
interface Span extends MarkChange {
  /** Line breaks in `text`. */
  added: number;
  /** Characters after the last line break of `text` (all of it when none). */
  lastLength: number;
}

function spansOf(changes: ReadonlyArray<MarkChange>): Span[] {
  return changes.map((c) => {
    const lastBreak = c.text.lastIndexOf('\n');
    return {
      ...c,
      added: lastBreak < 0 ? 0 : c.text.split('\n').length - 1,
      lastLength: c.text.length - (lastBreak + 1),
    };
  });
}

const isInsertion = (s: MarkChange): boolean =>
  s.startLine === s.endLine && s.startCharacter === s.endCharacter;

/**
 * The line a Move Line Up / Down event moved the block PAST, as its old and
 * new 0-based line, or null when the event is not one.
 *
 * The shapes, measured against VS Code 1.95 (the fast suite's
 * `tests/mark-lines.test.js` carries them verbatim):
 *
 *  - Down, block `s..e` past line `e + 1`: delete from the end of `e` to the
 *    end of `e + 1`, and insert that line's text plus a line break at
 *    `(s, 0)`. The line lands on `s`.
 *  - Up, block `s..e` past line `s - 1`: delete `(s - 1, 0)`–`(s, 0)`, and
 *    insert a line break plus that line's text at the end of `e`. The line
 *    lands on `e`.
 *
 * The deleted and inserted text are the same line, so their lengths must
 * agree; that, and the exact positions, is what keeps two unrelated changes
 * from being read as a move. The block's own lines need nothing special — the
 * ordinary rules already move them by one.
 */
function lineMovedPast(spans: ReadonlyArray<Span>): { from: number; to: number } | null {
  if (spans.length !== 2) return null;
  const ins = spans.find((s) => isInsertion(s) && s.added === 1);
  const del = spans.find((s) => s !== ins && s.text === '' && s.endLine === s.startLine + 1);
  if (!ins || !del) return null;
  if (del.rangeLength !== undefined && del.rangeLength !== ins.text.length) return null;
  // `added === 1` above, so a text ending in its break is `line + EOL`, and
  // one starting with it is `EOL + line`.
  const down =
    ins.startCharacter === 0 &&
    ins.lastLength === 0 &&
    ins.startLine <= del.startLine &&
    del.endCharacter === ins.text.length - (ins.text.endsWith('\r\n') ? 2 : 1);
  if (down) return { from: del.endLine, to: ins.startLine };
  const up =
    /^\r?\n/.test(ins.text) &&
    del.startCharacter === 0 &&
    del.endCharacter === 0 &&
    ins.startLine >= del.endLine;
  if (up) return { from: del.startLine, to: ins.startLine };
  return null;
}

/**
 * Does the text that began 0-based `line` still begin a line once the event
 * is applied?
 *
 * Walks back from the line's start through whatever the event put in front of
 * it. New text is fine — typing at column 0, or pasting a prefix, keeps the
 * mark like any in-place edit — so the walk stops, with a yes, at the first
 * line break the event inserted there. What it is looking for is ORIGINAL text
 * of another line: reaching a point partway along a line (`character > 0`)
 * that nothing inserted a break after means this line's text now carries on
 * after that line's own. A point at column 0 is a line break of the original
 * text, or the top of the document.
 *
 * At each point, a zero-width insertion there sits nearer the line's text than
 * the text of a range ending there — VS Code orders one event's changes by
 * where they start — so it is asked first. Every step moves the point strictly
 * back, so the walk ends.
 */
function stillStartsLine(line: number, spans: ReadonlyArray<Span>): boolean {
  let point = { line, character: 0 };
  for (;;) {
    const { line: atLine, character: atCharacter } = point;
    const insertedBreak = spans.some(
      (s) =>
        isInsertion(s) &&
        s.startLine === atLine &&
        s.startCharacter === atCharacter &&
        s.added > 0,
    );
    if (insertedBreak) return true;
    const before = spans.find(
      (s) => !isInsertion(s) && s.endLine === atLine && s.endCharacter === atCharacter,
    );
    if (!before) return atCharacter === 0;
    if (before.added > 0) return true;
    point = { line: before.startLine, character: before.startCharacter };
  }
}

/**
 * Where an in-place rewrite that starts at column 0 and puts line breaks in
 * sends its line's mark: to the line that holds what is left of the original
 * text after the rewrite, when anything is left; otherwise it stays where the
 * rewrite begins.
 *
 * The case that needs it is Undo. Select a whole step, line break included,
 * and type over it: the step below slides up and keeps its mark, now behind
 * the typed character. Undo reports that as the typed character replaced by
 * the deleted step and its line break — a rewrite of the line's first
 * character, with the slid-up step as the tail. Kept where the rewrite begins,
 * the slid-up step's ✗ and hover landed on the restored step above it.
 */
function rewriteTail(
  start: number,
  rewrite: Span,
  postEditLineLength: PostEditLineLength,
): number {
  const tailLine = start + rewrite.added;
  return postEditLineLength(tailLine) > rewrite.lastLength ? tailLine : start;
}

/** `shiftMarkLine` over measured spans, with the move already recognised. */
function shiftSpans(
  line: number,
  spans: ReadonlyArray<Span>,
  moved: { from: number; to: number } | null,
  postEditLineLength: PostEditLineLength,
): number | null {
  if (moved?.from === line) return moved.to;
  let delta = 0;
  let rewrite: Span | null = null;
  for (const s of spans) {
    // Ends at or before column 0 of the line: the line's text is untouched
    // and only its position moves. This includes an insertion AT column 0 —
    // pressing Enter there pushes the step down, so its mark goes with it.
    if (s.endLine < line || (s.endLine === line && s.endCharacter === 0)) {
      delta += s.added - (s.endLine - s.startLine);
      continue;
    }
    // Starts after the line's first character, or on a later line.
    if (s.startLine > line || (s.startLine === line && s.startCharacter > 0)) continue;
    // Covers the line's start. Kept only when it stays inside the line.
    if (s.startLine === line && s.endLine === line) {
      rewrite = s;
      continue;
    }
    return null;
  }
  if (!stillStartsLine(line, spans)) return null;
  const start = line + delta;
  return rewrite !== null && rewrite.added > 0
    ? rewriteTail(start, rewrite, postEditLineLength)
    : start;
}

/**
 * The new 0-based line of a mark on 0-based `line`, or null when the event
 * removed the line.
 *
 * Every change is classified against the ORIGINAL `line`, never against a
 * running result, for the reason `shiftAnchorForChanges` gives: one event's
 * changes are simultaneous, and folding them one at a time mixes pre- and
 * post-edit coordinates.
 */
export function shiftMarkLine(
  line: number,
  changes: ReadonlyArray<MarkChange>,
  postEditLineLength: PostEditLineLength,
): number | null {
  const spans = spansOf(changes);
  return shiftSpans(line, spans, lineMovedPast(spans), postEditLineLength);
}

/**
 * Where each of `lines` (1-based) goes, for the lines that move or are
 * removed; `null` marks a removal. Returns null when nothing moved at all —
 * the common case, a keystroke inside a line — so the caller can skip the
 * rebuild and the repaint.
 *
 * An event whose every change stays on one line and adds no line break cannot
 * move anything (such a change is at worst an in-place rewrite of its line),
 * so it returns before looking at a single mark: that is every keystroke of
 * ordinary typing.
 *
 * Computed once for the union of every line-keyed store, so the stores cannot
 * disagree. Two lines landing on one should not happen — the rules above
 * remove any line whose text ends up continuing another — but if an event
 * shape nobody measured ever did it, the earlier line keeps the spot: its text
 * comes first, so it is the one that starts the line.
 */
export function markLineMoves(
  lines: Iterable<number>,
  changes: ReadonlyArray<MarkChange>,
  postEditLineLength: PostEditLineLength,
): Map<number, number | null> | null {
  if (changes.every((c) => c.startLine === c.endLine && !c.text.includes('\n'))) return null;
  const spans = spansOf(changes);
  const moved = lineMovedPast(spans);
  const moves = new Map<number, number | null>();
  const taken = new Set<number>();
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const shifted = shiftSpans(line - 1, spans, moved, postEditLineLength);
    const next = shifted === null ? null : shifted + 1;
    if (next === null || taken.has(next)) {
      moves.set(line, null);
      continue;
    }
    taken.add(next);
    if (next !== line) moves.set(line, next);
  }
  return moves.size > 0 ? moves : null;
}

/**
 * Apply `markLineMoves` to one line-keyed store, in place — callers hold
 * references to these maps, so replacing one would strand them. Lines absent
 * from `moves` stay where they are.
 */
export function moveLineKeyed<V>(
  map: Map<number, V>,
  moves: ReadonlyMap<number, number | null>,
): void {
  const entries = [...map];
  map.clear();
  for (const [line, value] of entries) {
    const next = moves.has(line) ? (moves.get(line) as number | null) : line;
    if (next !== null) map.set(next, value);
  }
}
