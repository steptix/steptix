/**
 * What the model is told about the file the recorded steps go into
 * (stories/steptix-record-steps.md, decision 9: "the file around the cursor
 * (its `baseUrl`, parameters and section names, so it can write `Navigate to
 * login.html` and reuse `{{password}}`)").
 *
 * Read off `target.fileText` — the document as it stands in the editor, saved
 * or not — with a deliberately forgiving line scan rather than `parseTestFile`:
 * a file mid-edit may not parse, and a recording should not fail because the
 * author has a half-typed step three lines up. Only the headings the handbook
 * lists matter here (§2), and they are line-shaped.
 */

export interface TargetFileSummary {
  mode: 'cursor' | 'new';
  title?: string;
  /** `## Config: baseUrl`, when the file has one. */
  baseUrl?: string;
  /** `## Parameters` as written — values raw; the prompt masks secret-named
   *  literals, never this. */
  parameters: Array<{ name: string; value: string }>;
  /** `### Section` names under `## Steps`. */
  sections: string[];
  /** 1-based, mode `cursor` only. */
  cursorLine?: number;
  /** The section the cursor sits in, when it is inside one. */
  cursorSection?: string;
  /** Lines around the cursor, numbered as in the file. */
  excerpt?: Array<{ line: number; text: string; cursor?: true }>;
}

/** Lines shown before and after the cursor. */
const BEFORE = 12;
const AFTER = 4;

export function summarizeTargetFile(
  fileText: string,
  mode: 'cursor' | 'new',
  cursorLine?: number,
): TargetFileSummary {
  const lines = fileText.split(/\r?\n/);
  const summary: TargetFileSummary = { mode, parameters: [], sections: [] };

  let start = 0;
  // Frontmatter is fenced by `---` lines at the very top; nothing in it is a
  // heading.
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) start = close + 1;
  }

  let h2: string | null = null;
  const sectionAt: Array<{ line: number; name: string }> = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1 && summary.title === undefined) {
      summary.title = h1[1]!;
      continue;
    }
    const two = /^##\s+(.+?)\s*$/.exec(line);
    if (two && !line.startsWith('###')) {
      h2 = two[1]!.toLowerCase();
      continue;
    }
    const three = /^###\s+(.+?)\s*$/.exec(line);
    if (three && h2 === 'steps') {
      summary.sections.push(three[1]!);
      sectionAt.push({ line: i + 1, name: three[1]! });
      continue;
    }
    const bullet = /^\s*[-*]\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!bullet) continue;
    if (h2 === 'config' && bullet[1]!.toLowerCase() === 'baseurl' && bullet[2]) {
      summary.baseUrl = bullet[2];
    } else if (h2 === 'parameters') {
      summary.parameters.push({ name: bullet[1]!, value: bullet[2] ?? '' });
    }
  }

  if (mode === 'cursor' && cursorLine !== undefined && cursorLine >= 1) {
    const at = Math.min(cursorLine, lines.length);
    summary.cursorLine = at;
    const from = Math.max(1, at - BEFORE);
    const to = Math.min(lines.length, at + AFTER);
    summary.excerpt = [];
    for (let n = from; n <= to; n++) {
      summary.excerpt.push({ line: n, text: lines[n - 1] ?? '', ...(n === at && { cursor: true as const }) });
    }
    const enclosing = sectionAt.filter((s) => s.line <= at).pop();
    if (enclosing) summary.cursorSection = enclosing.name;
  }
  return summary;
}
