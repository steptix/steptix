/**
 * What a data table's rows say about themselves — the header summary, the
 * hovers on a failed or skipped row, and the worst-of merge that keeps a red
 * row red across the run rows that repaint it.
 *
 * Pure string and counting logic, no VS Code dependency, so the fast
 * `node --test` suite can pin the wording — the same split
 * `failure-hover-core.ts` is on, and for the same reason: the header summary
 * and the hovers are the whole user-visible surface of
 * stories/data-row-progress-and-selection.md, and a decoration's rendered text
 * cannot be read back from the extension host.
 */

import type { DataRowStatus } from 'ai-ui-automation-runner-core';
import { fenced } from './failure-hover-core.ts';

/**
 * Which table a row belongs to, which decides one word in everything this
 * module writes: a run table counts `row`s, a section table counts
 * `iteration`s.
 */
export type RowTableKind = 'run' | 'section';

/** The status vocabulary a row line can wear in the gutter. A subset of the
 *  tracker's `LineStatus`: the `pass-*` origins are step facts (a cache hit, a
 *  code-behind entry) and never land on a row — a row is pass or fail. */
export type RowLineStatus = 'running' | 'pass' | 'fail' | 'skip' | 'stopped';

/** The word for one row of this kind of table, capitalised for a hover. */
export function rowWord(kind: RowTableKind): string {
  return kind === 'section' ? 'iteration' : 'row';
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The tracker's `LineStatus` → the row state the panel and the report use.
 *  `undefined` (no status yet) is `pending`, which is what an unrun row is. */
export function rowStatusFromLineStatus(status: string | undefined): DataRowStatus {
  switch (status) {
    case 'running': return 'running';
    case 'fail': return 'failed';
    case 'skip': return 'skipped';
    case 'stopped': return 'stopped';
    case undefined: return 'pending';
    // Every `pass*` is a pass. A row never wears one of the origins, but a
    // caller reading straight off the tracker must not be surprised by one.
    default: return 'passed';
  }
}

/** The other direction, for the host painting a `rows` message into the
 *  gutter. `pending` has no mark at all, which is the placeholder cell. */
export function lineStatusFromRowStatus(status: DataRowStatus): RowLineStatus | null {
  switch (status) {
    case 'running': return 'running';
    case 'passed': return 'pass';
    case 'failed': return 'fail';
    case 'stopped': return 'stopped';
    case 'skipped': return 'skip';
    case 'pending': return null;
  }
}

/**
 * The after-text on a table's header line, built the way the `## Steps`
 * summary is:
 *
 *     5 rows · row 3 of 5 running · 2 passed      (while looping)
 *     5 rows · 4 passed · 1 failed                (when done)
 *     5 rows · 2 passed · 1 stopped · 2 not run   (after a Stop)
 *     3 rows · iteration 2 of 3 running · 1 passed (a section table)
 *
 * `statuses` is one entry per row line, in table order, straight off the
 * snapshot — `undefined` where the row has no mark. Deriving it from the
 * snapshot rather than from run state is the point: the summary is then
 * correct after a reload, after a partial run, and for a file nobody has run,
 * with no state to keep in sync.
 */
export function rowHeaderSummary(
  statuses: Array<string | undefined>,
  kind: RowTableKind = 'run',
): string {
  const total = statuses.length;
  const parts = [`${total} row${total === 1 ? '' : 's'}`];

  const runningIndex = statuses.findIndex((s) => s === 'running');
  if (runningIndex >= 0) {
    parts.push(`${rowWord(kind)} ${runningIndex + 1} of ${total} running`);
  }

  const count = (...wanted: string[]): number =>
    statuses.filter((s) => s !== undefined && wanted.includes(s)).length;
  // `pass-*` are counted as passes for the same reason `computeStepsSummary`
  // does it: they are all successful. A row should never carry one.
  const passed = count('pass', 'pass-cached', 'pass-code-behind', 'pass-stale');
  const failed = count('fail');
  const stopped = count('stopped');
  const notRun = count('skip');

  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  if (notRun > 0) parts.push(`${notRun} not run`);

  return parts.join(' · ');
}

/** Why a row the loop planned never ran. */
export type RowSkipReason =
  | { kind: 'stopped' }
  | { kind: 'paused' }
  /**
   * The run ended before the loop got here, and nobody asked it to — a
   * server error, a dropped stream, a refusal mid-run. Distinct from
   * `stopped` because "not run (stopped)" is a claim that someone pressed
   * Stop, and a reader who did not press it will go looking for who did.
   */
  | { kind: 'ended' }
  /**
   * The author cancelled an `[input:]` prompt, or quit an `[interactive]`
   * step. That is a Stop as far as the rows after it are concerned — which is
   * why it reads as one — but the row it happened in has its own explanation,
   * since "the run was stopped" would send the author looking for a Stop they
   * did not press.
   */
  | { kind: 'prompt-cancelled' }
  /** A section iteration failed, which ends the run (part B's rule). */
  | { kind: 'iteration-failed'; iteration: number };

/** The panel's short note — `not run (stopped)` — which is also the report's
 *  wording, so the two cannot describe the same row differently. */
export function rowSkipDetail(reason: RowSkipReason): string {
  switch (reason.kind) {
    case 'stopped': return 'not run (stopped)';
    case 'prompt-cancelled': return 'not run (stopped)';
    case 'paused': return 'not run (paused)';
    case 'ended': return 'not run (run ended early)';
    case 'iteration-failed': return `not run (iteration ${reason.iteration} failed)`;
  }
}

/**
 * The hover on the row the run was cut off in the middle of — the ■ mark's
 * only explanation.
 *
 * Worded by what actually ended the run: a Stop is somebody's doing and says
 * so, while a run that died says the run ended, because "the run was stopped"
 * would send a reader looking for a Stop nobody pressed. A pause never
 * reaches here — a pause ends the loop *after* the current row, so the row is
 * finished, not cut off.
 */
export function rowStoppedHover(
  kind: RowTableKind,
  row: number,
  reason: RowSkipReason = { kind: 'stopped' },
): string {
  const what =
    reason.kind === 'ended'
      ? 'the run ended while this row was running'
      : reason.kind === 'prompt-cancelled'
        ? 'the prompt was cancelled'
        : 'the run was stopped while this row was running';
  return `${capitalise(rowWord(kind))} ${row} stopped — ${what}`;
}

/**
 * The gutter hover on a skipped row: the short note, plus — for a pause,
 * where the row is one gesture away from running — how to run it on its own.
 * A pause ends the loop and there is no resume for it, so the hint is the
 * whole answer rather than a nicety.
 */
export function rowSkipHover(
  kind: RowTableKind,
  row: number,
  reason: RowSkipReason,
): string {
  const head = `${capitalise(rowWord(kind))} ${row} ${rowSkipDetail(reason)}`;
  if (reason.kind !== 'paused') return head;
  return (
    `${head} — right-click the line number and pick Run This Row to run it ` +
    'on its own'
  );
}

/**
 * The panel's short note on a failed row.
 *
 * `sourceName` is the file the failing step actually lives in, when that is
 * not the test document — a `[skill:]` body, typically. It outranks the
 * ordinal because the ordinal cannot be computed: `mainFlowOrdinal` counts
 * steps of the TEST file, so a skill-body failure on line 12 would be
 * described as "step 2" and quoted as whatever the test's line 12 says.
 */
export function rowFailureDetail(
  kind: RowTableKind,
  stepOrdinal: number | null,
  sourceName?: string,
): string {
  if (sourceName !== undefined && sourceName !== '') return `failed in ${sourceName}`;
  if (stepOrdinal === null) return 'failed';
  // "step 1 of the section", not "body step 1": nothing else in TestBench
  // calls a section's steps its "body", and a reader who has only ever seen
  // the word `### Section` has to guess what a body step is.
  return kind === 'section'
    ? `failed at step ${stepOrdinal} of the section`
    : `failed at step ${stepOrdinal}`;
}

/**
 * The gutter hover on a failed row — its own Markdown, not the step hover's.
 *
 *     Row 3 failed at step 6 — "Verify the banner is shown"
 *
 *     `email=nobody@bank.com, password=***, outcome=…`
 *
 *     ```
 *     locator.click: Timeout 30000ms exceeded
 *     ```
 *
 * It used to be built as a prefixed `error` and handed to `failHoverMessage`,
 * which reads well for a step and badly for a row: that renderer opens with
 * "This step failed:" — a row is not a step — and then fences EVERYTHING it is
 * given and clips the fence at 1000 characters, so a long Playwright call log
 * pushed the row heading into a code block and cut the values off the end.
 * The two facts a reader needs first (which row, which values) now lead, as
 * prose, and only the error is fenced — by the same `fenced` the step hover
 * uses, so the clipping rule stays in one place.
 *
 * The values are inline code so a cell holding `_`, `*` or a bare URL renders
 * as itself rather than as Markdown.
 */
export function rowFailureError(args: {
  kind: RowTableKind;
  row: number;
  /** 1-based position of the failing step — in the main flow for a run row,
   *  in the section's body for an iteration. Null when it cannot be
   *  resolved, in which case the prefix just says the row failed. */
  stepOrdinal: number | null;
  /** The failing step's text, as authored. Omitted when unknown. */
  stepText?: string;
  /** The failure itself, verbatim. */
  error: string;
  /** The row's `k=v, k=v` values, masked. Omitted for a row with no cells. */
  values?: string;
  /**
   * The basename of the file the failing step lives in, when it is not the
   * test document — a skill body reached from this row. With it, neither the
   * ordinal nor the step text is quoted: both would be read out of the test
   * file at a line number that belongs to another file.
   */
  sourceName?: string;
}): string {
  const { kind, row, stepOrdinal, stepText, error, values, sourceName } = args;
  const fromElsewhere = sourceName !== undefined && sourceName !== '';
  const where = rowFailureDetail(kind, stepOrdinal, sourceName);
  const head =
    `${capitalise(rowWord(kind))} ${row} ${where}` +
    (stepText && !fromElsewhere ? ` — "${stepText}"` : '');
  const parts = [head];
  if (values !== undefined && values !== '') parts.push(`\`${values}\``);
  if (error !== '') parts.push(fenced(error));
  return parts.join('\n\n');
}

/**
 * A section row's hover, plus which RUN rows it describes.
 *
 * A section table inside a data-driven run is looped once per run row, and the
 * worst status per row survives the loop (§Section tables, "Across run rows").
 * The mark that survives then belongs to a run row the reader can no longer
 * see — so it says which, exactly as a step line's worst-of-rows hover says
 * *Failed on rows 2, 4*.
 *
 * Appended rather than woven in: the hover is already built, and the fenced
 * error has to stay last so a long one is clipped where the clipping rule
 * says.
 */
export function withRunRowsNote(
  hover: string | undefined,
  runRows: readonly number[],
): string | undefined {
  if (hover === undefined || runRows.length === 0) return hover;
  const sorted = [...new Set(runRows)].sort((a, b) => a - b);
  const which =
    sorted.length === 1 ? `run row ${sorted[0]}` : `run rows ${sorted.join(', ')}`;
  return `${hover}\n\nOn ${which}.`;
}

/**
 * The short note behind a row hover — `failed at step 6`, `not run (stopped)`,
 * `stopped` — or undefined when the text is not one of ours.
 *
 * The tracker persists a row's hover and its status, not its note, so this is
 * how the note comes back after a reload: for the panel's `detail` column and
 * for the *Run Rows…* pick's "last run: …". Reading it back out of the hover
 * rather than persisting a second field is what keeps the two from drifting —
 * there is one authored string per row and everything else is a projection
 * of it.
 */
export function rowDetailFromHover(hover: string | undefined): string | undefined {
  if (hover === undefined || hover === '') return undefined;
  const first = hover.split('\n')[0] ?? '';
  const stripped = first.replace(/^(?:Row|Iteration) \d+ /, '');
  if (stripped === first) return undefined;
  const detail = (stripped.split(' — ')[0] ?? '').trim();
  return detail === '' ? undefined : detail;
}

/**
 * `last run: …` for the *Run Rows…* pick — what this row did the last time
 * anything ran it, in the panel's own words.
 *
 * The raw status word (`skipped`) is not what any other surface calls it, so
 * the hover's note wins when there is one and the status is only the fallback
 * for a mark with no hover (a pass, or state written by an older build).
 * Undefined for a row nobody has run: the pick is a way to CHOOSE a row, and
 * an unrun row has nothing to say about itself.
 */
export function rowLastRunDetail(
  lineStatus: string | undefined,
  hover?: string,
): string | undefined {
  if (lineStatus === undefined) return undefined;
  const fromHover = rowDetailFromHover(hover);
  if (fromHover !== undefined) return `last run: ${fromHover}`;
  switch (rowStatusFromLineStatus(lineStatus)) {
    case 'pending': return undefined;
    case 'running': return 'last run: running';
    case 'failed': return 'last run: failed';
    case 'stopped': return 'last run: stopped';
    case 'skipped': return 'last run: not run';
    default: return 'last run: passed';
  }
}

/**
 * The worse of two row statuses — the rule that keeps a section table honest
 * across the run rows that repaint it (§Section tables, "Across run rows").
 *
 * A green mark after a red one is a lie, and every run row paints the same
 * section rows, so the last clean run row would otherwise erase a failure
 * three rows back. Same shape as the `rowSummary` rule for step lines, one
 * more kind of line.
 */
const SEVERITY: Record<DataRowStatus, number> = {
  pending: 0,
  running: 1,
  passed: 2,
  skipped: 3,
  stopped: 4,
  failed: 5,
};

export function worseRowStatus(a: DataRowStatus, b: DataRowStatus): DataRowStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}
