/**
 * Find the 1-based line numbers of every numbered step under a `## Steps`
 * heading. Mirrors the webview's step-lines-inline.js so the extension
 * doesn't depend on webview source — same regex rules, same scope.
 *
 * A line is a step line iff:
 *   - it lives under a `## Steps` (or deeper) heading, before the next
 *     same-or-shallower heading
 *   - it matches `^\s*\d+\.\s+\S` (numbered list item with content)
 */
const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\s*\d+\.\s+\S/;

export function extractStepLineIds(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const span = findStepsSpan(lines);
  if (!span) return [];
  const out: number[] = [];
  for (let i = span.start; i <= span.end; i++) {
    if (STEP_LINE_RE.test(lines[i] || '')) out.push(i + 1);
  }
  return out;
}

export function findStepsHeadingLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (STEPS_HEADING_RE.test(lines[i] || '')) return i + 1;
  }
  return null;
}

function findStepsSpan(lines: string[]): { start: number; end: number } | null {
  let headingIndex = -1;
  let headingDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] || '');
    if (m) {
      headingIndex = i;
      headingDepth = m[1]!.length;
      break;
    }
  }
  if (headingIndex < 0) return null;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = ANY_HEADING_RE.exec(lines[i] || '');
    if (m && m[1]!.length <= headingDepth) {
      return { start: headingIndex + 1, end: i - 1 };
    }
  }
  return { start: headingIndex + 1, end: lines.length - 1 };
}
