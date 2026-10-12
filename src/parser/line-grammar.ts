/**
 * The raw-line grammar of a test/skill markdown file.
 *
 * These live here rather than inside the scanner that first needed them
 * because two scanners now read the same span and have to agree about what a
 * line *is*: `scanStepSpans` (src/parser/markdown.ts) collects the numbered
 * items, and `scanDataTable` (src/parser/data-rows.ts) collects the table
 * above them. A copy of `STEP_LINE_RE` in each would be a mirror, and a
 * mirror that drifts is how "the table must come before the first step"
 * quietly stops firing.
 *
 * The step-line rule itself is runner-core's (`createStepLineReader` in
 * runner-core/src/step-lines.ts), mirrored here because the server does not
 * import runner-core. tests/step-line-span-parity.test.ts holds the two to the
 * same answers, and to what `marked` makes of the same files.
 */

/** `## Steps` / `### Steps` — the heading that opens a steps span. */
export const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;

/** Any ATX heading with text after the hashes. */
export const ANY_HEADING_RE = /^(#{1,6})\s+\S/;

/**
 * A numbered list item with text, its marker at most three spaces in: the
 * shape of a step. Whether such a line IS a step also depends on the lines
 * above it — see `createStepLineReader`.
 */
export const STEP_LINE_RE = /^ {0,3}\d+\.\s+\S/;

/** Hashes with nothing after them, at depth 3 or more. */
export const HASHES_ONLY_RE = /^#{3,}\s*$/;

/** Any list item marker, at any indent: what opens an item lines can nest in. */
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+|$)/;
/** `---`, `* * *`, `___`: a thematic break, which ends every open list. */
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** An ATX heading, text or not, or seven-plus bare hashes: ends every list. */
const ATX_HEADING_RE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|#{7,}[ \t]*$)/;
/** A ```` ``` ```` / `~~~` fence delimiter, opening or closing. */
const FENCE_RE = /^\s*(```|~~~)/;
/** The column-0 step shape, the answer inside a fence (see the reader). */
const LEGACY_STEP_LINE_RE = /^\d+\.\s+\S/;

/**
 * Decides, line by line, which numbered lines of a `## Steps` span are steps.
 * Feed it every line of the span in order, blank lines and headings included;
 * it answers true for a step line.
 *
 * Markdown's rule, so the line scan finds the steps `marked` finds: a step is
 * a top-level `N. text` item whose marker is indented by at most three
 * columns. An item indented to the content column of an item above it is
 * nested inside that item (marked folds it into the parent step's text), and
 * four columns at the top level — a tab is four — is indented code. A code
 * fence closes the items it is shallower than; inside one, a numbered line is
 * a step only at column 0, as it always was here (the fenced-line divergence
 * from `marked` that the sectioned-file check refuses).
 *
 * Mirror of runner-core's `createStepLineReader`; keep the two identical.
 */
export function createStepLineReader(): (raw: string) => boolean {
  /** Content columns of the open list items, outermost first. */
  const open: number[] = [];
  let afterBlank = false;
  let inFence = false;
  const closeShallowerThan = (indent: number): void => {
    while (open.length > 0 && open[open.length - 1]! > indent) open.pop();
  };

  return (raw: string): boolean => {
    if (raw.trim() === '') {
      afterBlank = true;
      return false;
    }
    const wasBlank = afterBlank;
    afterBlank = false;

    const indent = columnsOf(/^[ \t]*/.exec(raw)![0]);
    if (FENCE_RE.test(raw)) {
      if (!inFence) closeShallowerThan(indent);
      inFence = !inFence;
      return false;
    }
    if (inFence) return LEGACY_STEP_LINE_RE.test(raw);

    if (ATX_HEADING_RE.test(raw) || THEMATIC_BREAK_RE.test(raw)) {
      open.length = 0;
      return false;
    }

    const item = LIST_ITEM_RE.exec(raw);
    if (!item) {
      // Below a blank line, a line indented less than an item's content ends
      // that item. Directly below an item it continues the item's paragraph.
      if (wasBlank) closeShallowerThan(indent);
      return false;
    }

    closeShallowerThan(indent);
    const nested = open.length > 0;
    // Too deep to open a list at the top level: indented code.
    if (!nested && indent > 3) return false;
    open.push(contentColumn(item));
    return !nested && STEP_LINE_RE.test(raw);
  };
}

/** Width in columns, a tab advancing to the next multiple of four. */
function columnsOf(text: string): number {
  let col = 0;
  for (const ch of text) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}

/** The column a list item's content starts at (Markdown's rule). */
function contentColumn(item: RegExpExecArray): number {
  const markerEnd = columnsOf(item[1]! + item[2]!);
  const after = columnsOf(item[1]! + item[2]! + item[3]!) - markerEnd;
  return after === 0 || after >= 5 ? markerEnd + 1 : markerEnd + after;
}
