
// Mirrors of src/parser/line-grammar.ts. runner-core cannot import from the
// server package, so these three are the one place the two line grammars can
// drift — which is what tests/data-rows.test.js and the root parser suite are
// run over the same shapes to catch.
/** Mirrors `ANY_HEADING_RE`. */
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
/** Mirrors `STEP_LINE_RE`. */
const STEP_LINE_RE = /^\d+\.\s+\S/;
/** Mirrors `STEPS_HEADING_RE`. */
const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;

/**
 * The raw scan for a data table — the rows that make a flow loop.
 *
 * A GFM table placed directly under `## Steps` runs the whole test once per
 * row (stories/data-driven-rows.md, part A). The same scan will serve a table
 * under a `### Section`, which loops that section's body (part B), which is
 * why it takes a line range rather than finding its own heading.
 *
 * This scan — not marked's `table` token — is the source of truth for the
 * rows, because three of the shapes an author most needs told about by line
 * number do not survive to the token:
 *
 *   - a **ragged** row: marked pads it with empty cells and truncates the
 *     extras, so the token says nothing is wrong;
 *   - a table that follows a numbered step: marked folds it *into* that list
 *     item, so there is no `table` token at all and the CLI would otherwise
 *     run the whole fold as one step;
 *   - a table indented four spaces: that is a code block, so again no token.
 *
 * The token walk still reads the table for its cell text; this scan decides
 * whether the file is legal and which lines the errors point at.
 */

/** A GFM delimiter row: `|---|:--:|` and its unpiped variants. */
const DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A column name. Deliberately stricter than `interpolate`'s `\w+`, which
 *  would also accept a leading digit — `{{1st}}` is not a name anyone means. */
const COLUMN_NAME_RE = /^[A-Za-z_]\w*$/;

/** Four spaces or a tab: the indentation that makes marked see a code block. */
const INDENTED_RE = /^(?: {4,}|\t)/;

export interface DataTableScan {
  /** One entry per data row, column name → cell text (trimmed). */
  rows: Array<Record<string, string>>;
  /** Column names, in table order. */
  columns: string[];
  /** 1-based line of the header row. */
  headerLine: number;
  /** 1-based line of each data row, parallel to `rows`. */
  rowLines: number[];
  /** Index (0-based, into `lines`) of the last line the table occupies. */
  lastIndex: number;
}

export interface ScanDataTableOptions {
  /** The whole file, split on newlines. */
  lines: string[];
  /** 0-based index to start scanning at — the line after the heading. */
  from: number;
  /** 0-based index to stop before — where the flow's span ends. */
  to: number;
  filePath: string;
  /**
   * How to name the flow in an error: "## Steps" for a run loop, or
   * `### <name>` for a section. Appears verbatim in every message.
   */
  flow: string;
}

/**
 * Find and validate the table at the head of a flow's span, or return null
 * when the flow has none. Throws with a file:line on every malformed shape —
 * a table an author half-wrote is never silently ignored, because the
 * alternative is a test that quietly runs once instead of five times.
 */
export function scanDataTable(options: ScanDataTableOptions): DataTableScan | null {
  const { lines, from, to, filePath, flow } = options;

  let table: DataTableScan | null = null;
  let sawStep = false;
  let sawProse: number | null = null;

  for (let i = from; i < to; i++) {
    const raw = lines[i] ?? '';
    const line = i + 1;

    if (raw.trim() === '') continue;

    if (raw.trimStart().startsWith('<!--')) {
      i = skipComment(lines, i, to);
      continue;
    }

    // A heading closes the head region: under `## Steps` that is the first
    // `### Section`, whose own table (part B) is a separate scan.
    if (ANY_HEADING_RE.test(raw)) break;

    if (looksLikeTable(lines, i, to)) {
      if (table) {
        throw new Error(
          `Second table under ${flow} at ${filePath}:${line} — one table per ` +
            `flow. The first is at line ${table.headerLine}. A flow loops over ` +
            `one set of rows; to vary two things independently, add a column.`,
        );
      }
      if (sawStep) {
        throw new Error(
          `Table under ${flow} at ${filePath}:${line} comes after a step. The ` +
            `table has to be the first content under the heading, before the ` +
            `numbered steps it feeds — otherwise Markdown folds it into the ` +
            `step above it and the whole table runs as part of that step.`,
        );
      }
      if (sawProse !== null) {
        throw new Error(
          `Table under ${flow} at ${filePath}:${line} comes after prose at ` +
            `line ${sawProse}. Only blank lines and HTML comments may sit ` +
            `between the heading and its table. Move the description above ` +
            `the heading, or below the steps.`,
        );
      }
      if (INDENTED_RE.test(raw)) {
        throw new Error(
          `Table under ${flow} at ${filePath}:${line} is indented, which makes ` +
            `it a code block rather than a table. Unindent it to the left ` +
            `margin.`,
        );
      }
      table = parseTable(lines, i, to, filePath, flow);
      i = table.lastIndex;
      continue;
    }

    if (STEP_LINE_RE.test(raw)) {
      sawStep = true;
      continue;
    }

    if (sawProse === null) sawProse = line;
  }

  return table;
}

/**
 * True when line `i` opens a GFM table: a row of cells whose very next line is
 * the delimiter. Requiring the delimiter is what keeps a lone pipe in a
 * sentence from being mistaken for a table — and it is marked's own rule, so
 * the two passes agree about where a table starts.
 */
function looksLikeTable(lines: string[], i: number, to: number): boolean {
  const raw = lines[i] ?? '';
  if (!hasUnescapedPipe(raw)) return false;
  if (i + 1 >= to) return false;
  const next = lines[i + 1] ?? '';
  if (next.trim() === '') return false;
  return DELIMITER_RE.test(next);
}

function hasUnescapedPipe(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === '|') return true;
  }
  return false;
}

/** Advance past an HTML comment, which may span lines. */
function skipComment(lines: string[], i: number, to: number): number {
  if ((lines[i] ?? '').includes('-->')) return i;
  for (let j = i + 1; j < to; j++) {
    if ((lines[j] ?? '').includes('-->')) return j;
  }
  return to - 1;
}

function parseTable(
  lines: string[],
  start: number,
  to: number,
  filePath: string,
  flow: string,
): DataTableScan {
  const headerLine = start + 1;
  const columns = splitTableRow(lines[start] ?? '');

  for (const [index, name] of columns.entries()) {
    if (name === '') {
      throw new Error(
        `Empty column name in the table under ${flow} at ` +
          `${filePath}:${headerLine} (column ${index + 1}). Every column is a ` +
          `variable the steps read as {{name}}, so it needs a name.`,
      );
    }
    if (!COLUMN_NAME_RE.test(name)) {
      throw new Error(
        `Invalid column name "${name}" in the table under ${flow} at ` +
          `${filePath}:${headerLine}. A column is read as {{${name}}}, so it ` +
          `must start with a letter or underscore and hold only letters, ` +
          `digits and underscores.`,
      );
    }
    if (columns.indexOf(name) !== index) {
      throw new Error(
        `Duplicate column "${name}" in the table under ${flow} at ` +
          `${filePath}:${headerLine}. Two columns of one name are ` +
          `indistinguishable as {{${name}}}.`,
      );
    }
  }

  const rows: Array<Record<string, string>> = [];
  const rowLines: number[] = [];
  let lastIndex = start + 1; // the delimiter row

  for (let i = start + 2; i < to; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') break;
    if (ANY_HEADING_RE.test(raw)) break;
    if (!hasUnescapedPipe(raw)) break;

    const line = i + 1;
    const cells = splitTableRow(raw);
    if (cells.length !== columns.length) {
      throw new Error(
        `Ragged row in the table under ${flow} at ${filePath}:${line} — ` +
          `${cells.length} cell(s) against ${columns.length} column(s) ` +
          `(${columns.join(', ')}). Markdown pads a short row and drops the ` +
          `extras from a long one, so the row would run with values you did ` +
          `not write.`,
      );
    }

    const row: Record<string, string> = {};
    for (const [index, name] of columns.entries()) {
      const value = cells[index] ?? '';
      if (value.includes('{{')) {
        throw new Error(
          `Cell "${value}" in the table under ${flow} at ${filePath}:${line} ` +
            `holds a {{placeholder}}. A cell is a value, not a reference — ` +
            `combine values in a step instead.`,
        );
      }
      row[name] = value;
    }
    rows.push(row);
    rowLines.push(line);
    lastIndex = i;
  }

  if (rows.length === 0) {
    throw new Error(
      `The table under ${flow} at ${filePath}:${headerLine} has no rows. A ` +
        `header on its own would loop zero times and silently skip every step ` +
        `beneath it.`,
    );
  }

  return { rows, columns, headerLine, rowLines, lastIndex };
}

/**
 * Split one table row into trimmed cells, honouring `\|` as a literal pipe.
 *
 * A backtick does **not** protect a pipe — measured against the repo's marked,
 * `` `a|b` `` splits into two cells — so this does not special-case code
 * spans. Matching marked exactly is the point: a cell this splitter and marked
 * disagree about is a row that validates here and runs with different values.
 */
export function splitTableRow(raw: string): string[] {
  let s = raw.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * The rows that loop a whole run: the table under this file's `## Steps`,
 * or null when it has none.
 *
 * The client side of the same read `src/parser/data-rows.ts` does on the CLI,
 * and on the Steptix path it is the *only* side that does it — the server
 * receives already-extracted `steps`, never the file — so the validation has
 * to be here too, or a malformed table the CLI refuses would run silently
 * wrong in the editor. `runner-core/tests/data-rows.test.js` and the root
 * `tests/parser.test.ts` are run over the same shapes to keep the two honest.
 *
 * Throws the same errors, with the same wording, as the server-side scan.
 */
export function parseDataRows(text: string, filePath = '<buffer>'): DataTableScan | null {
  const lines = text.split(/\r?\n/);

  // Skip frontmatter, so a `|` inside it cannot read as a table.
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  if (i < lines.length && (lines[i] ?? '').trim() === '---') {
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      if ((lines[j] ?? '').trim() === '---') {
        i = j + 1;
        closed = true;
        break;
      }
    }
    if (!closed) i = 0;
  } else {
    i = 0;
  }

  for (; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] ?? '');
    if (!m) continue;
    // Recognised only under a depth-2 `## Steps`, the same gate sections are
    // behind: under a `### Steps` a `###` line closes the span instead.
    if (m[1]!.length !== 2) return null;
    return scanDataTable({
      lines,
      from: i + 1,
      to: lines.length,
      filePath,
      flow: (lines[i] ?? '## Steps').trim(),
    });
  }
  return null;
}

/**
 * The full scan for every `### Section` that carries a table, keyed by section
 * name as authored.
 *
 * A separate scan rather than a field on `extractSections`, whose return shape
 * is frozen by the sections contract and pinned by a corpus of deep-equal
 * fixtures. Sections are found the same way that scanner finds them, so the
 * two agree about what a section heading is.
 *
 * This is the shape Steptix needs to *paint* a section table — `headerLine`
 * for the header summary and `rowLines` for the per-row status marks
 * (stories/data-row-progress-and-selection.md §Section tables). The runner
 * only ever wanted the cell values, which is what `parseSectionDataRows`
 * returns; it is a projection of this function rather than a second scan, so
 * the two cannot disagree about which table belongs to which section.
 *
 * Throws on a malformed table, exactly as the run-level scan does.
 */
export function scanSectionDataTables(
  text: string,
  filePath = '<buffer>',
): Map<string, DataTableScan> {
  const out = new Map<string, DataTableScan>();
  const lines = text.split(/\r?\n/);

  // Sections live only under a depth-2 `## Steps`, and the span ends at the
  // next heading of depth <= 2.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] ?? '');
    if (m) {
      if (m[1]!.length !== 2) return out;
      start = i + 1;
      break;
    }
  }
  if (start < 0) return out;

  let spanEnd = lines.length;
  const heads: Array<{ name: string; index: number }> = [];
  for (let i = start; i < lines.length; i++) {
    const heading = ANY_HEADING_RE.exec(lines[i] ?? '');
    if (!heading) continue;
    if (heading[1]!.length <= 2) {
      spanEnd = i;
      break;
    }
    if (heading[1]!.length === 3) {
      heads.push({ name: (lines[i] ?? '').replace(/^#{3}\s*/, '').trim(), index: i });
    }
  }

  for (const [n, head] of heads.entries()) {
    const next = heads[n + 1];
    const scan = scanDataTable({
      lines,
      from: head.index + 1,
      to: next ? next.index : spanEnd,
      filePath,
      flow: `### ${head.name}`,
    });
    if (scan) out.set(head.name, scan);
  }
  return out;
}

/**
 * Rows for every `### Section` that carries a table, keyed by section name as
 * authored — a projection of {@link scanSectionDataTables} down to the cell
 * values, which is all the runner ever needed.
 *
 * Throws on a malformed table, exactly as the run-level scan does.
 */
export function parseSectionDataRows(
  text: string,
  filePath = '<buffer>',
): Map<string, Array<Record<string, string>>> {
  const out = new Map<string, Array<Record<string, string>>>();
  for (const [name, scan] of scanSectionDataTables(text, filePath)) {
    out.set(name, scan.rows);
  }
  return out;
}
