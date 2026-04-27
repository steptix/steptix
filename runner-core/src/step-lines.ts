/**
 * Step-line classifier.
 *
 * A "test file" is any Markdown that contains a heading matching
 * /^#{2,}\s+steps\s*$/i. Inside the body of that heading (until the next
 * same-or-higher-level heading), numbered list items are step lines.
 *
 * Constraints:
 *  - Only `1.` style is recognised. `1)` is intentionally not supported.
 *  - YAML frontmatter (delimited by `---` on the first non-blank line) is
 *    excluded from classification.
 *  - Indented numbered items (e.g. nested sub-lists) are not steps.
 */

export type LineKind = 'step' | 'frontmatter' | 'heading' | 'prose' | 'blank';

export interface ClassifiedLine {
  /** 1-based line number to match Monaco/VS Code conventions. */
  line: number;
  kind: LineKind;
}

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\d+\.\s+\S/;

/**
 * Returns true iff the document contains a Steps heading. Cheap pre-check
 * used by the editor binder to decide whether to claim a `.md` file.
 */
export function isTestFile(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (STEPS_HEADING_RE.test(line)) return true;
  }
  return false;
}

/**
 * Classify every line in the document. Stable, single-pass; the returned
 * array is dense (one entry per source line).
 */
export function classifyLines(text: string): ClassifiedLine[] {
  const lines = text.split(/\r?\n/);
  const out: ClassifiedLine[] = new Array(lines.length);

  // Pass 1 — locate frontmatter span (lines are 0-indexed here).
  const frontmatterEnd = findFrontmatterEnd(lines);

  // Pass 2 — locate the Steps section span.
  const stepsSpan = findStepsSection(lines, frontmatterEnd + 1);

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? '';

    if (i <= frontmatterEnd) {
      out[i] = { line: lineNumber, kind: 'frontmatter' };
      continue;
    }

    if (raw.trim() === '') {
      out[i] = { line: lineNumber, kind: 'blank' };
      continue;
    }

    if (ANY_HEADING_RE.test(raw)) {
      out[i] = { line: lineNumber, kind: 'heading' };
      continue;
    }

    const inSteps = stepsSpan && i >= stepsSpan.start && i <= stepsSpan.end;
    if (inSteps && STEP_LINE_RE.test(raw)) {
      out[i] = { line: lineNumber, kind: 'step' };
      continue;
    }

    out[i] = { line: lineNumber, kind: 'prose' };
  }

  return out;
}

/** True iff the given 1-based line is a step line. */
export function isStepLine(text: string, lineNumber: number): boolean {
  const classified = classifyLines(text);
  const entry = classified[lineNumber - 1];
  return entry?.kind === 'step';
}

/** Nearest step at or below `lineNumber` (1-based), or null. */
export function nearestStepAtOrBelow(text: string, lineNumber: number): number | null {
  const classified = classifyLines(text);
  for (let i = lineNumber - 1; i < classified.length; i++) {
    if (classified[i]?.kind === 'step') return classified[i]!.line;
  }
  return null;
}

/** Nearest step at or above `lineNumber` (1-based), or null. */
export function nearestStepAtOrAbove(text: string, lineNumber: number): number | null {
  const classified = classifyLines(text);
  for (let i = lineNumber - 1; i >= 0; i--) {
    if (classified[i]?.kind === 'step') return classified[i]!.line;
  }
  return null;
}

/**
 * Extract the step instructions in order, returning each step's source line
 * number alongside the cleaned text (number prefix stripped).
 */
export function extractSteps(text: string): { line: number; instruction: string }[] {
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(text);
  const out: { line: number; instruction: string }[] = [];

  for (let i = 0; i < classified.length; i++) {
    if (classified[i]?.kind !== 'step') continue;
    const raw = lines[i] ?? '';
    const instruction = raw.replace(/^\s*\d+\.\s+/, '').trim();
    out.push({ line: i + 1, instruction });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the 0-based index of the closing `---`, or -1 if no frontmatter. */
function findFrontmatterEnd(lines: string[]): number {
  // Skip leading blanks.
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;

  if (i >= lines.length || (lines[i] ?? '').trim() !== '---') return -1;

  for (let j = i + 1; j < lines.length; j++) {
    if ((lines[j] ?? '').trim() === '---') return j;
  }

  // Unterminated frontmatter — be lenient, treat as no frontmatter.
  return -1;
}

interface Span {
  /** 0-based index of the first line *after* the heading. */
  start: number;
  /** 0-based index of the last line in the section (inclusive). */
  end: number;
}

/**
 * Find the body span of the first matching `## Steps` (or deeper) heading.
 * Section ends at the next heading of equal or shallower depth, or EOF.
 */
function findStepsSection(lines: string[], from: number): Span | null {
  let headingIndex = -1;
  let headingDepth = 0;

  for (let i = from; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] ?? '');
    if (m) {
      headingIndex = i;
      headingDepth = m[1]!.length;
      break;
    }
  }

  if (headingIndex < 0) return null;

  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = ANY_HEADING_RE.exec(lines[i] ?? '');
    if (m && m[1]!.length <= headingDepth) {
      return { start: headingIndex + 1, end: i - 1 };
    }
  }

  return { start: headingIndex + 1, end: lines.length - 1 };
}
