/**
 * Turning a gesture into "these rows, these steps" — the split, the refusals,
 * the quick-pick items and the two strings a narrowed run prints
 * (stories/data-row-progress-and-selection.md §Running rows).
 *
 * Pure, no VS Code dependency, so the fast `node --test` suite can pin every
 * rule. The same split feeds three entry points — `runSelected`, the gutter's
 * *Run This Row* and the panel's `runRows` message — and they must not be able
 * to disagree about what a selection meant.
 */

import {
  extractSections,
  maskIfSecret,
  matchText,
  parseControlLine,
  parseDataRows,
  scanSectionDataTables,
  type DataTableScan,
  type HostRowsMsg,
} from 'ai-ui-automation-runner-core';
import {
  rowDetailFromHover,
  rowLastRunDetail,
  rowStatusFromLineStatus,
} from './row-summary-core.ts';

/** Which table a row belongs to, in the shape the wire and the panel use. */
export type RowTableRef = 'run' | { section: string };

/** Every data table of a document, scanned once. A malformed table
 *  contributes nothing — the run reports the parse error separately, and a
 *  selection cannot name rows of a table that does not parse. */
export interface ScannedTable {
  table: RowTableRef;
  /** The section name as authored, or null for the table under `## Steps`. */
  section: string | null;
  scan: DataTableScan;
}

export function scanTables(text: string): ScannedTable[] {
  const tables: ScannedTable[] = [];
  try {
    const run = parseDataRows(text);
    if (run) tables.push({ table: 'run', section: null, scan: run });
  } catch {
    /* half-written: no rows to select */
  }
  try {
    for (const [section, scan] of scanSectionDataTables(text)) {
      tables.push({ table: { section }, section, scan });
    }
  } catch {
    /* ditto */
  }
  return tables;
}

/** What a run needs to know about a selection. Absent keys mean "that axis
 *  was not narrowed", which every consumer reads as all of it (decision 3). */
export interface RowSelection {
  /** Step lines, ascending. Empty means every step. */
  lines: number[];
  /** Run-table rows, 1-based table positions, ascending. */
  rows?: number[];
  /** Section name as authored → 1-based table positions, ascending. */
  sectionRows?: Record<string, number[]>;
}

/**
 * Split the lines a selection names into step lines and data rows.
 *
 * Header and delimiter lines are not rows: a selection made only of them
 * narrows nothing, which is what makes "select the whole table" mean "every
 * row" rather than "no rows at all" (§Running rows, Selection + Run).
 *
 * Lines that are neither — prose, headings, blanks — are left in `lines`
 * exactly as they arrive, because `resolveRunSelection` on the other side is
 * the one thing entitled to decide what a non-step line means.
 */
export function splitRowSelection(text: string, lines: number[]): RowSelection {
  const tables = scanTables(text);
  if (tables.length === 0 || lines.length === 0) {
    return { lines: [...lines].sort((a, b) => a - b) };
  }
  /** Every line the tables occupy, so a header or delimiter line can be
   *  dropped from the step lines without being mistaken for a row. */
  const tableLines = new Set<number>();
  for (const { scan } of tables) {
    // The header, its delimiter, and every row: the span from the header to
    // the last row line. A blank line cannot occur inside a GFM table, so the
    // span is contiguous.
    const last = scan.rowLines[scan.rowLines.length - 1] ?? scan.headerLine + 1;
    for (let line = scan.headerLine; line <= last; line++) tableLines.add(line);
  }

  const selected = new Set(lines);
  const stepLines = lines.filter((line) => !tableLines.has(line)).sort((a, b) => a - b);
  const out: RowSelection = { lines: stepLines };
  const sectionRows: Record<string, number[]> = {};
  for (const { section, scan } of tables) {
    const picked = scan.rowLines
      .map((line, index) => ({ line, row: index + 1 }))
      .filter((r) => selected.has(r.line))
      .map((r) => r.row);
    if (picked.length === 0) continue;
    if (section === null) out.rows = picked;
    else sectionRows[section] = picked;
  }
  if (Object.keys(sectionRows).length > 0) out.sectionRows = sectionRows;
  return out;
}

/**
 * One section whose BODY a selection named some steps of.
 *
 * The sibling of a `sectionRows` entry, and independent of it: a selection may
 * narrow a section's rows, its body steps, both or neither, and no axis knows
 * about the others (decision 3).
 */
export interface BodyStepPick {
  /** The section name as authored. */
  section: string;
  /** 0-based indices into the section's body, ascending — the wire's
   *  `runSteps`. */
  indices: number[];
  /** The same steps as 1-based ordinals: what the reader counts in the file,
   *  and what the Output lines say. */
  ordinals: number[];
  /** How many body steps the section has. */
  total: number;
  /** Ordinals the selection did NOT name, kept anyway because dropping them
   *  would split an `If … / Otherwise …` chain. Empty for almost every pick,
   *  and said out loud when it is not. */
  addedForChain: number[];
  /** How many steps of the flow this run executes call this section. More
   *  than one and the narrowing applies to every one of them: `runSteps`
   *  travels on the section DEFINITION, and the wire cannot say "this call
   *  only". */
  callCount: number;
}

/**
 * Every section this run will actually enter, and how many call sites reach
 * each one — keyed by `matchText`, the rule the server expands by.
 *
 * Three kinds of call the naive "is the step's own text a section name?" test
 * misses, and all three end with the author being told their narrowing was
 * ignored while the server honours it:
 *
 *  - a call in a control line's TAIL (`If the user is signed out, then Log
 *    In`). The whole line is not the section's name; the tail is, and the
 *    expander resolves it as a call exactly as it resolves a bare one.
 *  - a NESTED call — a called section's body calling another section. The
 *    frame is entered, so its body can be narrowed.
 *  - and the reason this takes the un-trimmed step list: a breakpoint trims
 *    what runs in THIS batch, not what the run selected. The steps below it
 *    run on Continue, and the narrowing has to survive to meet them.
 */
export function calledSectionNames(
  text: string,
  runningInstructions: string[],
): Map<string, number> {
  const bodies = new Map(
    extractSections(text).map((s) => [
      matchText(s.name),
      s.steps.map((step) => step.instruction),
    ]),
  );
  /** Section name → call sites reaching it. */
  const counts = new Map<string, number>();
  const pending: string[] = [];
  const note = (instruction: string): void => {
    // Resolution order: a bare name is a call, and so is the tail of a
    // control line. Both are tried, because a section may legitimately be
    // NAMED like a control line and then the whole line is the call.
    for (const candidate of [instruction, parseControlLine(instruction)?.tail]) {
      if (candidate === undefined) continue;
      const key = matchText(candidate);
      if (!bodies.has(key)) continue;
      const seen = counts.get(key) ?? 0;
      counts.set(key, seen + 1);
      // Walk each section's body once, however many times it is called: the
      // set of sections entered is what the closure is for, and a cycle
      // (which the server refuses anyway) must not spin here.
      //
      // The WHOLE body, including steps another narrowing may drop. Each
      // section is narrowed independently and in no defined order, so
      // subtracting one narrowing from another's reachability would make the
      // answer depend on that order. The cost of being generous is a
      // `runSteps` shipped for a section that turns out not to run, which
      // executes nothing either way.
      if (seen === 0) pending.push(key);
    }
  };
  for (const instruction of runningInstructions) note(instruction);
  while (pending.length > 0) {
    for (const instruction of bodies.get(pending.pop()!) ?? []) note(instruction);
  }
  return counts;
}

/**
 * Split the body-step lines a selection names, grouped by section, and say
 * which of those narrowings this run can honour.
 *
 * A section is entered only by a step that calls it, so a narrowing whose call
 * is not among the steps about to run narrows nothing — the body will not
 * execute at all. Those come back as `ignored`, to be logged and dropped, for
 * the reason the row equivalent is: an axis nobody selected means all of it,
 * and a drag that stopped a line short of the call has already said which
 * steps it wants.
 *
 * A section whose WHOLE body is selected is in neither list. That is not a
 * narrowing — it is what a drag over the file looks like — and shipping
 * `runSteps` for it would put a line in the log saying the run was narrowed to
 * everything.
 *
 * A selected step that is the `Otherwise` half of a decision brings its `If`
 * with it. A chain lives on consecutive body lines, and a narrowing that kept
 * only the second half would ship a body the server's own parser refuses —
 * `"Otherwise, …" has no decision to be the alternative of` — blaming a file
 * that is perfectly well formed, and which the client's pre-flight (which
 * validates the whole DOCUMENT) has just passed. So the kept set grows
 * BACKWARDS over chain members until the chain is whole, and the additions are
 * said out loud rather than made quietly.
 *
 * `runningInstructions` is the instruction text of the steps this run will
 * execute — un-trimmed by any breakpoint, since a breakpoint decides what runs
 * in this batch and not what the run selected. Which sections those reach is
 * `calledSectionNames`'s question, tails and nested calls included.
 */
export function splitBodySteps(
  text: string,
  lines: number[],
  runningInstructions: string[],
): { narrowed: BodyStepPick[]; ignored: BodyStepPick[] } {
  const narrowed: BodyStepPick[] = [];
  const ignored: BodyStepPick[] = [];
  if (lines.length === 0) return { narrowed, ignored };
  const selected = new Set(lines);
  const sections = extractSections(text);
  const called = calledSectionNames(text, runningInstructions);
  const sectionNames = new Set(sections.map((s) => matchText(s.name)));
  /** Is this body step the `Else if` / `Otherwise` half of a decision — the
   *  one shape that cannot stand without the step above it? A step whose text
   *  names a section is a CALL first (resolution order), the same rung
   *  `danglingChainMemberError` reads before anything else. */
  const needsPredecessor = (instruction: string): boolean => {
    if (sectionNames.has(matchText(instruction))) return false;
    const kind = parseControlLine(instruction)?.kind;
    return kind === 'elseif' || kind === 'else';
  };
  for (const section of sections) {
    const picked = section.steps
      .map((step, index) => ({ line: step.line, index }))
      .filter((s) => selected.has(s.line))
      .map((s) => s.index);
    if (picked.length === 0) continue;
    // One descending pass is enough: a member added at k-1 is visited after
    // k, so a chain of any length unwinds in the one sweep.
    const kept = new Set(picked);
    for (let k = section.steps.length - 1; k > 0; k--) {
      if (kept.has(k) && needsPredecessor(section.steps[k]!.instruction)) kept.add(k - 1);
    }
    // Growing the set can make it the WHOLE body, and then it has stopped
    // being a narrowing — checked here rather than on `picked` for exactly
    // that reason.
    if (kept.size === section.steps.length) continue;
    const indices = [...kept].sort((a, b) => a - b);
    const wanted = new Set(picked);
    const pick: BodyStepPick = {
      section: section.name,
      indices,
      ordinals: indices.map((n) => n + 1),
      total: section.steps.length,
      addedForChain: indices.filter((n) => !wanted.has(n)).map((n) => n + 1),
      callCount: called.get(matchText(section.name)) ?? 0,
    };
    (pick.callCount > 0 ? narrowed : ignored).push(pick);
  }
  return { narrowed, ignored };
}

/** `row 6 is` / `rows 6, 7 are` — the subject of a refusal, agreeing with
 *  itself. A drag that overshot names several rows at once, and the message
 *  that tells the author so should not read as if written for one. */
function rowsAre(rows: number[]): string {
  return rows.length === 1
    ? `row ${rows[0]} is`
    : `rows ${rows.join(', ')} are`;
}

/**
 * Why this row selection cannot run, or null.
 *
 * Refused before anything is sent, and surfaced the way every other pre-flight
 * refusal is — a warning naming what is wrong. The alternative is a run that
 * silently loops the wrong rows, or none.
 */
export function rowSelectionRefusal(
  text: string,
  selection: { rows?: number[]; sectionRows?: Record<string, number[]> },
): string | null {
  const tables = scanTables(text);
  if (selection.rows !== undefined) {
    const run = tables.find((t) => t.section === null);
    if (!run) {
      return (
        'TestBench: this test has no data table under "## Steps", so there are ' +
        'no rows to run.'
      );
    }
    const total = run.scan.rows.length;
    const bad = selection.rows.filter((n) => !Number.isInteger(n) || n < 1 || n > total);
    if (bad.length > 0) {
      return (
        `TestBench: ${rowsAre(bad)} not in the table under "## Steps" — ` +
        `it has ${total} row${total === 1 ? '' : 's'}.`
      );
    }
    if (selection.rows.length === 0) {
      return 'TestBench: no rows selected.';
    }
  }
  for (const [name, rows] of Object.entries(selection.sectionRows ?? {})) {
    const table = tables.find((t) => t.section === name);
    if (!table) {
      return (
        `TestBench: no section "${name}" with a data table in this test, so ` +
        'there are no rows of it to run.'
      );
    }
    const total = table.scan.rows.length;
    const bad = rows.filter((n) => !Number.isInteger(n) || n < 1 || n > total);
    if (bad.length > 0) {
      return (
        `TestBench: ${rowsAre(bad)} not in the table under ` +
        `"### ${name}" — it has ${total} row${total === 1 ? '' : 's'}.`
      );
    }
    if (rows.length === 0) return `TestBench: no rows of "${name}" selected.`;
  }
  return null;
}

/** The table a data-row line belongs to, and which row it is — the gutter's
 *  *Run This Row* input. Null when the line is not a data row (a header, a
 *  delimiter, a step, prose). */
export function rowAtLine(
  text: string,
  line: number,
): { table: RowTableRef; section: string | null; row: number } | null {
  for (const { table, section, scan } of scanTables(text)) {
    const index = scan.rowLines.indexOf(line);
    if (index >= 0) return { table, section, row: index + 1 };
  }
  return null;
}

/**
 * Every row of one table, as 1-based positions — what *Run all rows* runs.
 *
 * The panel's ▷ button names the TABLE for the same reason ↻ Re-run failed
 * does: the numbers it is showing came from a `rows` message that may be a run
 * old, so a table that has since gained a row would run all but the new one,
 * and one that has lost a row would be asked for a row that is not there. The
 * host resolves the set from the file as it is now.
 *
 * `[]` when the file has no such table (or it does not parse), which the
 * caller reports rather than sending — an empty `rows` is not a narrowing.
 */
export function allRowsOfTable(text: string, section: string | null): number[] {
  const table = scanTables(text).find((t) => t.section === section);
  if (!table) return [];
  return table.scan.rows.map((_, index) => index + 1);
}

/** Every data-row line in the document, ascending — the array the gutter menu's
 *  `when` clause tests with `editorLineNumber in ...`. */
export function dataRowLinesOf(text: string): number[] {
  const lines: number[] = [];
  for (const { scan } of scanTables(text)) lines.push(...scan.rowLines);
  return [...new Set(lines)].sort((a, b) => a - b);
}

/** `"k=v, k=v"` with secrets masked — the same text the Output banner, the
 *  panel and the gutter hover use, so no surface can word a row differently. */
export function rowValuesText(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${maskIfSecret(k, v)}`)
    .join(', ');
}

/** One entry of the *Run Rows…* quick pick — a table separator, or a row. */
export type RowPickEntry =
  | { kind: 'separator'; label: string }
  | {
      kind: 'row';
      label: string;
      /** The masked values. */
      description: string;
      /** The row's last status, when the tracker has one. */
      detail?: string;
      table: RowTableRef;
      section: string | null;
      row: number;
      line: number;
    };

/**
 * The quick pick's items: one separator per table, then one line per row.
 *
 * `lastRunOf` answers with the row's persisted gutter state — its status and
 * its hover — from which the `last run: …` detail is built. Undefined when the
 * file has never been run: the pick is a way to choose a row, and a row nobody
 * has run has nothing to say about itself.
 *
 * A section table's rows are labelled `Iteration N`, because that is what the
 * gutter, the hovers and the report's badge already call them; `Row N` in a
 * list that also holds the run table's `Row N` reads as a second copy of the
 * same thing.
 */
export function buildRowPickEntries(
  text: string,
  lastRunOf: (line: number) => { status?: string; hover?: string } | undefined,
): RowPickEntry[] {
  const entries: RowPickEntry[] = [];
  for (const { table, section, scan } of scanTables(text)) {
    entries.push({
      kind: 'separator',
      label: section === null ? 'Rows' : `Rows · ${section}`,
    });
    for (const [index, values] of scan.rows.entries()) {
      const line = scan.rowLines[index] ?? scan.headerLine;
      const last = lastRunOf(line);
      const detail = rowLastRunDetail(last?.status, last?.hover);
      entries.push({
        kind: 'row',
        label: `${section === null ? 'Row' : 'Iteration'} ${index + 1}`,
        description: rowValuesText(values),
        ...(detail !== undefined && { detail }),
        table,
        section,
        row: index + 1,
        line,
      });
    }
  }
  return entries;
}

/**
 * `(steps 3–6)` for the Output banner of a row that runs only some steps.
 *
 * A contiguous run of ordinals reads as a range; anything else is listed, so
 * an Alt+click pick of steps 2 and 5 says exactly that rather than implying it
 * ran 3 and 4 too. Null when no steps were named — a whole-file row, whose
 * banner has no parenthesis at all.
 */
export function stepRangeText(ordinals: number[]): string | null {
  const sorted = [...new Set(ordinals)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return `step ${sorted[0]}`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return contiguous
    ? `steps ${sorted[0]}–${sorted[sorted.length - 1]}`
    : `steps ${sorted.join(', ')}`;
}

/**
 * The Output log's end-of-run rows line, worded as the CLI's
 * (`src/cli/commands/run.ts`):
 *
 *     Rows: 5 — 4 passed, 1 failed
 *     Rows: 2 — 1 passed, 0 failed, 1 not run
 *     Rows: 5 — 2 passed, 0 failed, 1 stopped, 2 not run
 *     Rows: 5 — 0 passed, 0 failed, 1 paused, 4 not run
 *
 * The count is the rows this run PLANNED, not the table's — an unselected row
 * was never part of the run and does not appear in its report either
 * (decision 6). The parts always sum to it: a Stop leaves one row in neither
 * "ran" nor "never reached", and a pause leaves the row it parked in exactly
 * the same way. Without those parts the line was an arithmetic error the
 * reader had to notice for themselves.
 */
export function rowsSummaryLine(counts: {
  planned: number;
  passed: number;
  failed: number;
  stopped?: number;
  /** The row the run is parked in. It has not been judged and is not "not
   *  run": its steps are half-executed and a Continue will finish them. */
  paused?: number;
  notRun: number;
}): string {
  const parts = [`${counts.passed} passed`, `${counts.failed} failed`];
  if ((counts.stopped ?? 0) > 0) parts.push(`${counts.stopped} stopped`);
  if ((counts.paused ?? 0) > 0) parts.push(`${counts.paused} paused`);
  if (counts.notRun > 0) parts.push(`${counts.notRun} not run`);
  return `Rows: ${counts.planned} — ${parts.join(', ')}`;
}

/** `  Row 3: failed at step 6 (7.4s)` — one line per row that ran, plus the
 *  one a Stop cut off (`  Row 3: stopped (7.4s)`) and the one a pause parked
 *  in (`  Row 1: paused (2.1s)`), so every planned row has a line and the
 *  lines account for the summary. */
export function rowOutcomeLine(args: {
  row: number;
  /** `failed at step 6`, or undefined for a plain pass/fail. */
  detail?: string;
  failed: boolean;
  /** The run was cut off inside this row — outranks `failed`, because a row
   *  that never finished has not been judged. */
  stopped?: boolean;
  /** The run parked inside this row (a breakpoint, Pause). Same reasoning as
   *  `stopped`, and it outranks that one: a pause is where the run IS. */
  paused?: boolean;
  durationMs?: number;
}): string {
  const what = args.paused
    ? 'paused'
    : args.stopped
      ? 'stopped'
      : args.failed
        ? (args.detail ?? 'failed')
        : 'passed';
  const duration =
    args.durationMs === undefined ? '' : ` (${(args.durationMs / 1000).toFixed(1)}s)`;
  return `  Row ${args.row}: ${what}${duration}`;
}

/**
 * The line a run of SOME steps over EVERY row prints before the first batch:
 *
 *     Running 1 selected step for each of 5 rows — select rows in the table to narrow it
 *
 * A step selection in a data-driven file runs once per row, which is right and
 * is also the one thing nothing on screen said: the panel button read `Run`,
 * the gutter repainted the same step five times, and the only clue was five
 * `Row N of 5` banners scrolling past. The second half is there because the
 * fix for a reader who did not want five runs is a gesture they may not know
 * they have.
 */
export function stepsPerRowLogLine(steps: number, rows: number): string {
  const s = `${steps} selected step${steps === 1 ? '' : 's'}`;
  const r = `${rows} row${rows === 1 ? '' : 's'}`;
  return `Running ${s} for each of ${r} — select rows in the table to narrow it`;
}

/**
 * The line a narrowed section prints at run start:
 *
 *     Upload each statement — running rows 2 of 3; steps after this call will see only those rows
 *
 * Always plural in "rows 2 of 3": that names positions in a list, and "row 2
 * of 3" would read as an iteration counter, which is what the server's own
 * banner says a line later.
 *
 * The second half is the whole reason the line exists. Narrowing a section
 * changes what the steps AFTER the call find — a count that was 3 is now 1 —
 * so the failure three steps later has to read as a consequence of a choice
 * made here rather than as a mystery (§What later steps see).
 */
export function sectionRowsLogLine(name: string, rows: number[], total: number): string {
  return (
    `${name} — running rows ${rows.join(', ')} of ${total}; ` +
    'steps after this call will see only those rows'
  );
}

/**
 * …and the line it prints instead when the call is not among the steps this
 * run will execute, so the narrowing has nothing to narrow:
 *
 *     Upload each statement — rows 2, 3 ignored: the step that calls this section is not in your selection
 *
 * Logged rather than refused: an axis nobody selected means all of it, and a
 * step selection that stops short of the call has already said which steps it
 * wants. It names the rows and the reason in the reader's terms — the earlier
 * wording ("call not in the selected steps") described the code's test rather
 * than the gesture that tripped it.
 */
export function sectionRowsIgnoredLogLine(name: string, rows: number[]): string {
  return (
    `${name} — rows ${rows.join(', ')} ignored: ` +
    'the step that calls this section is not in your selection'
  );
}

/**
 * `steps 2` / `steps 1, 3` / `steps 2–3` — the body steps a narrowing kept.
 *
 * Always plural, like `rows 2 of 3` a line above it: this names positions in a
 * list, and "step 2 of 2" would read as a progress counter. A contiguous run
 * is a range for the reason `stepRangeText` makes one — an Alt+click pick of
 * body steps 1 and 3 must not read as if it ran 2 as well.
 */
export function bodyStepsText(ordinals: number[]): string {
  const sorted = [...new Set(ordinals)].sort((a, b) => a - b);
  if (sorted.length > 1 && sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1)) {
    return `steps ${sorted[0]}–${sorted[sorted.length - 1]}`;
  }
  return `steps ${sorted.join(', ')}`;
}

/**
 * The line a section with a narrowed BODY prints at run start:
 *
 *     Log In — running body steps 2 of 2
 *
 * The sibling of `sectionRowsLogLine`, in the same voice, and posted beside it
 * when a selection narrowed both axes of the same section. It says less than
 * the rows line because it has less to warn about: a body step that did not
 * run changes what the steps after the call see just as a skipped row does,
 * but the author picked the steps one at a time and can see which.
 */
export function sectionStepsLogLine(
  name: string,
  ordinals: number[],
  total: number,
  callCount = 1,
): string {
  // `runSteps` rides the section DEFINITION, so a flow that calls the same
  // section twice narrows both frames — the wire cannot express "this call
  // only". Not a refusal (the author asked for the body, and got it), but it
  // must not be discovered from the marks: a second call quietly running the
  // same one step is the shape of a bug.
  const scope = callCount > 1 ? ` (applies to all ${callCount} calls)` : '';
  return `${name} — running body ${bodyStepsText(ordinals)} of ${total}${scope}`;
}

/**
 * …and the line the CONTINUATION of a paused run prints:
 *
 *     Log In — the narrowing still applies: body steps 2 of 2
 *
 * A Continue is a separate run with its own log, and it rebuilds its lines
 * from the pause point — so the narrowing it inherits is invisible in
 * everything the author can see. A narrowing announced before a breakpoint and
 * silent after it reads as one that expired there.
 */
export function sectionStepsResumedLogLine(
  name: string,
  ordinals: number[],
  total: number,
): string {
  return `${name} — the narrowing still applies: body ${bodyStepsText(ordinals)} of ${total}`;
}

/** `step 1` / `steps 1, 2` — the additions, counted as things rather than
 *  as positions in a range, so the singular is right. */
function bodyStepWord(ordinals: number[]): string {
  const sorted = [...new Set(ordinals)].sort((a, b) => a - b);
  return `${sorted.length === 1 ? 'step' : 'steps'} ${sorted.join(', ')}`;
}

/**
 * The line a narrowing prints when it kept a body step nobody selected:
 *
 *     Log In — body step 1 kept with 2: an Otherwise needs its If
 *
 * A chain is one decision written across consecutive lines, so half of it is
 * not a smaller version of it — it is a body the parser refuses, in a message
 * that blames the file. The selection is grown instead, and this is what stops
 * that from being a silent difference between what was picked and what ran.
 */
export function chainMembersKeptLogLine(
  name: string,
  added: number[],
  selected: number[],
): string {
  return (
    `${name} — body ${bodyStepWord(added)} kept with ` +
    `${[...new Set(selected)].sort((a, b) => a - b).join(', ')}: ` +
    'an Otherwise needs its If'
  );
}

/**
 * …and the line it prints instead when the call is not among the steps this
 * run will execute:
 *
 *     Log In — body steps 2 ignored: the step that calls this section is not in your selection
 *
 * Logged rather than refused, exactly as the row equivalent is: the body will
 * not be entered at all, and a selection that stops short of the call has
 * already said which steps it wants.
 */
export function sectionStepsIgnoredLogLine(name: string, ordinals: number[]): string {
  return (
    `${name} — body ${bodyStepsText(ordinals)} ignored: ` +
    'the step that calls this section is not in your selection'
  );
}

/**
 * The one warning a run gives about a server that ran the WHOLE body of a
 * section this selection narrowed.
 *
 * `runSteps` is a new optional field, and a server that predates it drops what
 * it does not know — so the body runs whole, the unselected steps paint marks
 * the author did not ask for, and nothing anywhere says why. Detected from the
 * outside: a step event for a body line this run did not select can only mean
 * the narrowing never arrived. Said once, because it is a fact about the
 * server rather than about the step that revealed it.
 */
export function oldServerBodyStepsWarning(name: string): string {
  return (
    `${name} — the server ran the whole section body; restart or update the ` +
    'Sessions API server so a selection can narrow it'
  );
}

/**
 * The live matrix for a file NOBODY is running — every table, every row, and
 * whatever the gutter currently says about it.
 *
 * The Rows section used to appear only once a run had posted to it, so opening
 * a data-driven test showed nothing, and a window reload emptied it even
 * though the ✓/✗ marks were still on the rows. This builds the same
 * `HostRowsMsg` a run posts, out of the file plus the tracker's persisted
 * statuses, so the panel's Rows section is populated the moment you open the
 * file and survives a reload with the marks intact.
 *
 * What it cannot carry is a duration — nothing persists one — so a reloaded
 * row shows its mark and its note and no time. A run's own message replaces
 * this one wholesale and brings the durations back.
 */
export function buildRowsMessage(
  uri: string,
  text: string,
  lastRunOf: (line: number) => { status?: string; hover?: string } | undefined,
): HostRowsMsg | null {
  const tables = scanTables(text);
  if (tables.length === 0) return null;
  return {
    type: 'rows',
    uri,
    tables: tables.map(({ table, scan }) => ({
      table,
      headerLine: scan.headerLine,
      rows: scan.rows.map((values, index) => {
        const line = scan.rowLines[index] ?? scan.headerLine;
        const last = lastRunOf(line);
        const detail = rowDetailFromHover(last?.hover);
        return {
          row: index + 1,
          line,
          values: rowValuesText(values),
          status: rowStatusFromLineStatus(last?.status),
          ...(detail !== undefined && { detail }),
          ...(last?.hover !== undefined && { hover: last.hover }),
        };
      }),
    })),
  };
}

/**
 * The rows of each table the gutter currently marks failed — what *Re-run
 * Failed Rows* runs.
 *
 * Read off the tracker rather than remembered from the last run in this
 * window, which is what makes the offer survive a reload: the marks are
 * persisted, and the tracker's own signature check already drops them when the
 * table changes (its signature includes each row line's TEXT, so an edit to a
 * row's values drops that row's mark too). There is nothing left for a
 * separate shape check to catch.
 */
export function failedRowsFrom(
  text: string,
  statusOf: (line: number) => string | undefined,
): { rows?: number[]; sectionRows?: Record<string, number[]> } | null {
  const out: { rows?: number[]; sectionRows?: Record<string, number[]> } = {};
  const sectionRows: Record<string, number[]> = {};
  for (const { section, scan } of scanTables(text)) {
    const failed = scan.rowLines
      .map((line, index) => ({ line, row: index + 1 }))
      .filter((r) => statusOf(r.line) === 'fail')
      .map((r) => r.row);
    if (failed.length === 0) continue;
    if (section === null) out.rows = failed;
    else sectionRows[section] = failed;
  }
  if (Object.keys(sectionRows).length > 0) out.sectionRows = sectionRows;
  return out.rows === undefined && out.sectionRows === undefined ? null : out;
}
