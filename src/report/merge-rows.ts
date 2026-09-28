import { redactAuthoredMap } from '../utils/secrets.js';
import type { RowSummaryLine, StepResult, TestReport } from './types.js';

/**
 * Fold a data-driven test's per-row reports into the one report the run
 * writes (stories/data-driven-rows.md, decision 12).
 *
 * Each row is still a full `runTest` — its own browser, hooks and recording —
 * so this runs on finished `TestReport`s rather than reaching into the run
 * loop. It also runs *after* each row's own `redactReport`, so every row
 * arrives already masked with its own secrets; merging first would mean one
 * pass over five rows' values with one row's secret list.
 *
 * A test with no rows takes this path too, with one instance, and merges to
 * itself. One code path, so the ordinary case cannot drift from the looped
 * one.
 */
export interface RowReport {
  report: TestReport;
  /** 0-based. Absent for a test with no rows. */
  dataRowIndex?: number;
  dataRowCount?: number;
  /** The row's cells as authored. */
  dataRowValues?: Record<string, string>;
  /**
   * That row's secret values. Each row's report was already redacted with its
   * own secrets inside `runTest`, but the row's *cells* are stamped on here,
   * after that pass — so without this a `$TEST_PASSWORD` cell would arrive
   * masked in the step instruction and in clear in the band beside it.
   */
  secrets?: string[];
}

/** A row the loop never reached, listed in the matrix table as "not run". */
export interface UnrunRow {
  index: number;
  values: Record<string, string>;
  reason: string;
}

export function mergeRowReports(rows: RowReport[], unrun: UnrunRow[] = []): TestReport {
  if (rows.length === 0) {
    throw new Error('mergeRowReports called with no reports');
  }
  const first = rows[0]!;
  // A test with no rows and nothing skipped is not a merge at all. Returning
  // the report untouched is what keeps a single-run report identical to one
  // from before this feature, rather than merely equivalent.
  if (rows.length === 1 && first.dataRowIndex === undefined && unrun.length === 0) {
    return first.report;
  }

  const steps: StepResult[] = [];
  const rowLines: RowSummaryLine[] = [];

  let totalSteps = 0;
  let passedSteps = 0;
  let failedSteps = 0;
  /** Steps a `return` left behind, summed across rows
   *  (stories/step-flow-control.md). A row that returned early is a normal
   *  outcome, so the merged header has to be able to say so too. */
  let skippedSteps = 0;
  /** Steps that failed and were tolerated, summed across rows
   *  (stories/step-failure-outcomes.md, decision 6). NOT folded into `failedSteps`
   *  or `anyFailed`: a row whose only failures were tolerated passed, which each
   *  row's own loop already decided when it computed `r.status`. */
  let toleratedSteps = 0;
  let totalSubActions = 0;
  let durationMs = 0;
  let tokensUsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let anyFailed = false;

  for (const row of rows) {
    const r = row.report;
    const marker =
      row.dataRowIndex === undefined
        ? undefined
        : {
            kind: 'row' as const,
            index: row.dataRowIndex + 1,
            count: row.dataRowCount ?? rows.length,
            // Masked by name as well as by value: a `password` column shows
            // `***` even when its cell is too short or too common for
            // value-masking to be safe to apply.
            //
            // By the AUTHOR rule on the whole key, not the variable map's
            // two-segment one. These keys are the data file's column
            // headings, typed by a person; none of them is half page-derived,
            // which is the only thing the split exists for. Split at the dot,
            // `api.key` leaves `key` — which the record rule deliberately
            // does not mask — and the band printed the credential.
            values: redactAuthoredMap(row.dataRowValues ?? {}, row.secrets ?? []),
          };

    for (const step of r.steps) {
      // An inner loop's marker wins: a section iteration inside a run row is
      // the loop the step's own values came from, and that is what the band
      // above it should read. The enclosing row stays legible from the matrix
      // table and the frames — and from `dataRow`, which every step of a row
      // carries whatever its band says, because the step's anchor names its
      // row (src/report/anchors.ts).
      steps.push(
        marker ? { ...step, dataRow: marker.index, ...(!step.loop && { loop: marker }) } : step,
      );
    }

    totalSteps += r.totalSteps;
    passedSteps += r.passedSteps;
    failedSteps += r.failedSteps;
    skippedSteps += r.skippedSteps ?? 0;
    toleratedSteps += r.toleratedSteps ?? 0;
    totalSubActions += r.totalSubActions;
    durationMs += r.durationMs;
    tokensUsed += r.tokensUsed;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    if (r.status === 'failed') anyFailed = true;

    if (marker) {
      rowLines.push({
        index: marker.index,
        values: marker.values,
        status: r.status,
        durationMs: r.durationMs,
        tokensUsed: r.tokensUsed,
        ...(r.videoRelPath && { videoRelPath: r.videoRelPath }),
      });
    }
  }

  for (const row of unrun) {
    rowLines.push({
      index: row.index,
      // Never run, so no run secrets to mask by value — but the cells are
      // still the data file's, and a `password` column is one by name.
      values: redactAuthoredMap(row.values, []),
      status: 'skipped',
      notRunReason: row.reason,
      durationMs: 0,
      tokensUsed: 0,
    });
  }
  rowLines.sort((a, b) => a.index - b.index);

  const base = first.report;
  const merged: TestReport = {
    ...base,
    steps,
    totalSteps,
    passedSteps,
    failedSteps,
    // Omitted (not 0) when no row returned, so a merged report of ordinary
    // rows is byte-identical to one from before this feature.
    ...(skippedSteps > 0 && { skippedSteps }),
    // Omitted (not 0) for the same reason: a merged report of rows with no
    // `otherwise continue` tail is byte-identical to a pre-feature one.
    ...(toleratedSteps > 0 && { toleratedSteps }),
    totalSubActions,
    durationMs,
    tokensUsed,
    inputTokens,
    outputTokens,
    status: anyFailed ? 'failed' : base.status,
    ...(rowLines.length > 0 && { rows: rowLines }),
  };

  // The parameters block can no longer be a row's values, because there are
  // five sets of them. It keeps what every row shared; the rest is on the
  // matrix table and the bands.
  const shared = sharedParameters(rows.map((r) => r.report.parameters));
  if (shared) merged.parameters = shared;
  else delete merged.parameters;

  // A merged report holds one `.webm` per row, so the single top-level path
  // would name an arbitrary one. The links live on the rows' lines instead.
  if (rowLines.length > 0) delete merged.videoRelPath;

  return merged;
}

/** Keys present with the same value in every row. */
function sharedParameters(
  all: Array<Record<string, string> | undefined>,
): Record<string, string> | undefined {
  const first = all[0];
  if (!first) return undefined;
  const shared: Record<string, string> = {};
  for (const [key, value] of Object.entries(first)) {
    if (all.every((p) => p?.[key] === value)) shared[key] = value;
  }
  return Object.keys(shared).length > 0 ? shared : undefined;
}
