/**
 * Where the data tables are in a document — the one under `## Steps` and each
 * `### Section`'s — as header line plus row lines.
 *
 * Pure, no VS Code dependency, so the fast `node --test` suite can pin which
 * lines the decoration pass treats as rows and which merely reserve a status
 * cell. That distinction is the whole of
 * stories/data-row-progress-and-selection.md §"Which lines", and it is
 * emphatically *not* "every line of the table": a rendered decoration's text
 * cannot be read back from the extension host, so if this is not pinned here,
 * the alignment of every data-driven file rests on nothing.
 */

import { parseDataRows, scanSectionDataTables } from 'steptix-runner-core';
import type { RowTableKind } from './row-summary-core.ts';

/** One data table in a document, as the decorations need it. */
export interface DataTableLines {
  kind: RowTableKind;
  /** The section's name as authored, or null for the run table. */
  section: string | null;
  /** 1-based line of the header row. */
  headerLine: number;
  /** 1-based line of each data row, in table order. */
  rowLines: number[];
}

/**
 * Every data table in a document — the one under `## Steps` and each
 * section's — as header line plus row lines.
 *
 * Exported and pure so the row-painting rule is testable without a real
 * editor: which lines get a status cell is the whole of
 * stories/data-row-progress-and-selection.md §"Which lines", and it is
 * emphatically *not* "every line of the table" — the header and the delimiter
 * get nothing.
 *
 * A malformed table yields nothing rather than throwing: the parse error is
 * already reported when the run reads the table, and a decoration pass that
 * threw would take the step marks down with it.
 */
export function dataTablesOf(text: string): DataTableLines[] {
  if (cache !== null && cache.text === text) return cache.tables;
  const tables = scanDataTables(text);
  cache = { text, tables };
  return tables;
}

/**
 * One entry, keyed by the document's whole text.
 *
 * Every tracker `emit()` — one per caret move — asks for these lines twice
 * (once for the decoration pass, once for the run-state signature), and a
 * third time now that a selection has to know which lines are runnable. Each
 * ask was two full parses of the file. Keyed by the text itself rather than by
 * a URI and version so it cannot go stale: a different document, or the same
 * one edited, simply misses.
 *
 * The returned array is shared, so callers must treat it as read-only — every
 * one of them projects out of it rather than mutating it.
 */
let cache: { text: string; tables: DataTableLines[] } | null = null;

/** How many real scans have happened. The memo's only observable effect, so
 *  `tests/data-tables.test.js` can pin that a repeated call with identical
 *  text does not rescan. */
let scans = 0;
export function dataTableScanCount(): number {
  return scans;
}

function scanDataTables(text: string): DataTableLines[] {
  scans += 1;
  const tables: DataTableLines[] = [];
  try {
    const run = parseDataRows(text);
    if (run) {
      tables.push({
        kind: 'run',
        section: null,
        headerLine: run.headerLine,
        rowLines: [...run.rowLines],
      });
    }
  } catch {
    /* the run table is half-written — paint nothing for it */
  }
  try {
    for (const [section, scan] of scanSectionDataTables(text)) {
      tables.push({
        kind: 'section',
        section,
        headerLine: scan.headerLine,
        rowLines: [...scan.rowLines],
      });
    }
  } catch {
    /* ditto for the sections */
  }
  return tables;
}

/**
 * The lines that reserve a status cell without ever taking a status: each
 * table's header row and the `|---|` delimiter under it.
 *
 * The cell is a 1.2em `before` attachment, so a line that has one is indented
 * by 1.2em relative to a line that has not. Give it to the data rows only —
 * which is what "the header and the delimiter get nothing" means for STATUS —
 * and the pipes stop lining up in every data-driven file, run or not: the rows
 * shift right and the header stays put. Reserving the same invisible cell on
 * both keeps the table a table.
 *
 * The delimiter is always the line under the header: GFM requires it there,
 * and `parseTable` reads it at exactly that offset.
 */
export function alignmentLinesOf(tables: readonly DataTableLines[]): number[] {
  return tables.flatMap((t) => [t.headerLine, t.headerLine + 1]);
}
