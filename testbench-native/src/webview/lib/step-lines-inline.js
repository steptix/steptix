/**
 * Inline step-line detection for the webview.
 *
 * Mirrors `runner-core/step-lines`'s logic for "what counts as a numbered
 * step line under ## Steps". The webview can't import runner-core directly
 * because Vite's CJS interop drops named exports through __exportStar.
 *
 * A line is a step line iff:
 *   - it lives under a `## Steps` (or deeper) heading, before the next
 *     same-or-shallower heading
 *   - it matches `^\s*\d+\.\s+\S` (numbered list item with content)
 */

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\s*\d+\.\s+\S/;

/** 1-based line numbers of every step under ## Steps. */
export function extractStepLineIds(text) {
  const lines = text.split(/\r?\n/);
  const span = findStepsSpan(lines);
  if (!span) return [];
  const out = [];
  for (let i = span.start; i <= span.end; i++) {
    if (STEP_LINE_RE.test(lines[i] || "")) out.push(i + 1);
  }
  return out;
}

/**
 * Filter a list of {id, text, ...} entries to only those whose `id` is
 * a real step line in `text`. Preserves all extra fields on each entry.
 */
export function filterToStepLines(text, entries) {
  if (!entries || entries.length === 0) return [];
  const ids = new Set(extractStepLineIds(text));
  return entries.filter((e) => ids.has(e.id));
}

function findStepsSpan(lines) {
  let headingIndex = -1;
  let headingDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] || "");
    if (m) {
      headingIndex = i;
      headingDepth = m[1].length;
      break;
    }
  }
  if (headingIndex < 0) return null;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = ANY_HEADING_RE.exec(lines[i] || "");
    if (m && m[1].length <= headingDepth) {
      return { start: headingIndex + 1, end: i - 1 };
    }
  }
  return { start: headingIndex + 1, end: lines.length - 1 };
}
