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
 */

/** `## Steps` / `### Steps` — the heading that opens a steps span. */
export const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;

/** Any ATX heading with text after the hashes. */
export const ANY_HEADING_RE = /^(#{1,6})\s+\S/;

/** A numbered list item with text: the shape of a step. */
export const STEP_LINE_RE = /^\d+\.\s+\S/;

/** Hashes with nothing after them, at depth 3 or more. */
export const HASHES_ONLY_RE = /^#{3,}\s*$/;
