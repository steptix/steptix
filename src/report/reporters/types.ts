import type { TestReport } from '../types.js';

/**
 * What `steptix run` knows about a run at one moment, and the only input the
 * JUnit and JSON writers take (docs/specs/SPEC-reporters.md).
 *
 * The files are written before the first test, after each test and when the
 * run ends (§8), so every field has to make sense at each of those moments.
 * The writers are pure: the same state always gives the same text.
 */

/** A reporter `--reporter` or `reports.reporters` can name (§4). */
export type ReporterName = 'html' | 'junit' | 'json';

/** The names accepted, in the order a usage error lists them. */
export const REPORTER_NAMES: readonly ReporterName[] = ['html', 'junit', 'json'];

/** The fixed file names (§5), relative to `reports.outputDir`. */
export const JUNIT_FILE_NAME = 'junit.xml';
export const RUN_JSON_FILE_NAME = 'run.json';

/**
 * Where one test stands.
 *
 * - `notRun`: it has not run. While the run goes on this is an error in the
 *   files, so a killed run never reads as a pass; once the run has ended with
 *   {@link RunState.bailed} set it is a test `--bail` stopped the run
 *   reaching, which is skipped (§6.2, §8).
 * - `done`: it ran and its HTML report is written. `report` is set.
 * - `parseError`: the file could not be read as a test (§8.1). `message` is
 *   set, and `title` is the file's relative path.
 * - `runError`: it ended the run by throwing (§8.1). `message` is set.
 */
export type RunTestState = 'notRun' | 'done' | 'parseError' | 'runError';

export interface RunTestEntry {
  /** The test's title; for a `parseError`, the same text as {@link file}. */
  title: string;
  /**
   * The test file relative to its project root, with `/` separators on every
   * platform (§6.1). Relative to the working directory when the file has no
   * project root above it.
   */
  file: string;
  tags: string[];
  state: RunTestState;
  /**
   * The merged report, exactly as the HTML report was rendered from it, so
   * everything in it is already masked. Set when `state` is `done`.
   */
  report?: TestReport;
  /**
   * The HTML report's path relative to the folder the two files are written
   * in, with `/` separators. Set when `state` is `done`.
   */
  reportFile?: string;
  /** Why, for `parseError` and `runError`. */
  message?: string;
}

export interface RunState {
  /** The testsuite's name: the project folder's name (§3, decision 7). */
  suiteName: string;
  /** When the run started, ISO 8601. */
  startedAt: string;
  /** Wall-clock time since {@link startedAt}, as of this write. */
  durationMs: number;
  /** False until the last write of the run (§8, step 3). */
  finished: boolean;
  /** True once `--bail` has stopped the run at a failure. */
  bailed: boolean;
  /** `--fail-on-healed`: a healed test is a failure in the files too (§6.2). */
  failOnHealed: boolean;
  /** The process exit code. Known only on the last write. */
  exitCode?: number;
  /** The Steptix that ran: package version, and commit when known. */
  steptix: { version: string; commit: string | null };
  /** Every test of the run, in run order. */
  tests: RunTestEntry[];
}

/** The signature of both writers: `renderJUnit` and `renderRunJson`. */
export type RenderRunState = (state: RunState) => string;
