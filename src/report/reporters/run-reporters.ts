import fs from 'node:fs/promises';
import path from 'node:path';
import type { ParsedTest } from '../../parser/types.js';
import type { TestReport } from '../types.js';
import type { RunObserver } from '../../runner/test-runner.js';
import { resolveProjectRoot } from '../../server/project-root.js';
import { getBuildInfo, getPackageVersion } from '../../utils/version.js';
import { logger } from '../../utils/logger.js';
import { renderJUnit } from './junit.js';
import { renderRunJson } from './json.js';
import {
  JUNIT_FILE_NAME,
  RUN_JSON_FILE_NAME,
  type RenderRunState,
  type ReporterName,
  type RunState,
  type RunTestEntry,
} from './types.js';

/**
 * The run state behind `junit.xml` and `run.json`, and the writes that keep the
 * two files true while `steptix run` goes on (docs/specs/SPEC-reporters.md §8):
 * before the first test, after each test, and once more when the run ends.
 */

/** What a temporary file is called beside the real one (§8). */
export const TEMP_SUFFIX = '.tmp';

/**
 * How often a rename (or a stale file's removal) another program blocks is
 * tried, and how long apart (§8.2).
 */
export const RENAME_ATTEMPTS = 5;
export const RENAME_RETRY_MS = 100;

/** The errors Windows gives for a file another program has open for a moment. */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RunReportersOptions {
  /** Which reporters are on. `html` is ignored: the runner always writes it. */
  reporters: readonly ReporterName[];
  /** Where the files go, resolved as `generateReport` resolves `reports.outputDir`. */
  outputDir: string;
  /** `--fail-on-healed`. */
  failOnHealed: boolean;
  /** The testsuite's name (§3, decision 7). */
  suiteName: string;
  /** Test files with no project root above them are named relative to this. */
  cwd: string;
  renderJUnit?: RenderRunState;
  renderRunJson?: RenderRunState;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** The wait between rename attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** The test's project root, or null when it has none. */
  projectRootOf?: (testFilePath: string) => Promise<string | null>;
  steptix?: { version: string; commit: string | null };
  /** File operations, replaceable so a test can make one fail. */
  fileOps?: Partial<FileOps>;
}

export interface FileOps {
  writeFile(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file; a file that is not there is not an error. */
  remove(file: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

const realFileOps: FileOps = {
  writeFile: (file, text) => fs.writeFile(file, text, 'utf-8'),
  rename: (from, to) => fs.rename(from, to),
  remove: (file) => fs.rm(file, { force: true }),
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A test file that failed to parse, or a parsed test, for {@link RunReporters.parseFailed}. */
export type ParseOutcome =
  | { filePath: string; test: ParsedTest }
  | { filePath: string; error: unknown };

interface FileTarget {
  label: string;
  file: string;
  render: RenderRunState;
}

/** `p` with `/` separators, whatever the platform. */
function slashes(p: string): string {
  return p.split(path.sep).join('/');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Holds one `steptix run`'s {@link RunState} and writes it. Built only when
 * `junit` or `json` is on ({@link wantsResultFiles}), so a run with neither
 * pays nothing for it.
 */
export class RunReporters {
  private readonly targets: FileTarget[];
  private readonly ops: FileOps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly projectRootOf: (testFilePath: string) => Promise<string | null>;
  private readonly startMs: number;
  private readonly state: RunState;
  /** Each test's entry, by the parsed test the runner hands back. */
  private readonly entryOf = new Map<ParsedTest, RunTestEntry>();
  /** Files the last write left in place, for the lines after the summary. */
  private written: FileTarget[] = [];

  constructor(private readonly options: RunReportersOptions) {
    this.ops = { ...realFileOps, ...options.fileOps };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.projectRootOf = options.projectRootOf ?? resolveProjectRoot;
    const targets: FileTarget[] = [];
    if (options.reporters.includes('junit')) {
      targets.push({
        label: 'JUnit:',
        file: path.join(options.outputDir, JUNIT_FILE_NAME),
        render: options.renderJUnit ?? renderJUnit,
      });
    }
    // JSON last: it carries the exit code, which a failed JUnit write changes
    // (see `end`).
    if (options.reporters.includes('json')) {
      targets.push({
        label: 'JSON:',
        file: path.join(options.outputDir, RUN_JSON_FILE_NAME),
        render: options.renderRunJson ?? renderRunJson,
      });
    }
    this.targets = targets;
    this.startMs = this.now();
    const build = options.steptix ?? { version: getPackageVersion(), commit: getBuildInfo().commit };
    this.state = {
      suiteName: options.suiteName,
      startedAt: new Date(this.startMs).toISOString(),
      durationMs: 0,
      finished: false,
      bailed: false,
      failOnHealed: options.failOnHealed,
      steptix: { version: build.version, commit: build.commit },
      tests: [],
    };
  }

  /**
   * Remove the files and temporary files an earlier run left, for each
   * reporter that is on (§5), so a run that stops before its first write does
   * not leave the previous run's results to be published as this one's.
   */
  async removeStale(): Promise<void> {
    await removeFiles(
      this.targets.map((t) => t.file),
      this.ops,
      this.sleep,
      (f) => this.shown(f),
    );
  }

  /** The observer to hand `runTests`. */
  readonly observer: RunObserver = {
    onStart: async (tests) => {
      this.state.tests = [];
      this.entryOf.clear();
      for (const test of tests) {
        const entry: RunTestEntry = {
          title: test.title,
          file: await this.relativeFile(test.filePath),
          tags: [...(test.frontmatter.tags ?? [])],
          state: 'notRun',
        };
        this.state.tests.push(entry);
        this.entryOf.set(test, entry);
      }
      await this.writeAll(false);
    },
    onTestDone: async (test, report: TestReport, reportPath) => {
      const entry = this.entryOf.get(test);
      if (!entry) return;
      entry.state = 'done';
      entry.report = report;
      entry.reportFile = slashes(path.relative(this.options.outputDir, path.resolve(reportPath)));
      delete entry.message;
      await this.writeAll(false);
    },
    onTestError: (test, error) => {
      const entry = this.entryOf.get(test);
      if (!entry) return;
      entry.state = 'runError';
      entry.message = messageOf(error);
      delete entry.report;
      delete entry.reportFile;
    },
    onBail: () => {
      this.state.bailed = true;
    },
  };

  /**
   * Every file was parsed before any test ran, and at least one failed (§8.1):
   * one `parseError` entry per file that failed, named after the file, and the
   * tests that parsed and would have run as not run. `outcomes` is in file order.
   */
  async parseFailed(outcomes: readonly ParseOutcome[]): Promise<void> {
    this.state.tests = [];
    this.entryOf.clear();
    for (const outcome of outcomes) {
      const file = await this.relativeFile(outcome.filePath);
      if ('error' in outcome) {
        this.state.tests.push({ title: file, file, tags: [], state: 'parseError', message: messageOf(outcome.error) });
      } else {
        this.state.tests.push({
          title: outcome.test.title,
          file,
          tags: [...(outcome.test.frontmatter.tags ?? [])],
          state: 'notRun',
        });
      }
    }
  }

  /**
   * The last write (§8, step 3), with the exit code the run is about to end
   * with. Returns the exit code to end with instead: 1 where the run would have
   * exited 0 but a file could not be written (§8.2), since CI would otherwise
   * publish a stale or missing file under a green build.
   */
  async end(exitCode: number): Promise<number> {
    this.state.finished = true;
    this.state.exitCode = exitCode;
    return this.writeAll(true);
  }

  /** The lines that follow the summary (§9), one per file the last write left in place. */
  summaryLines(): string[] {
    return this.written.map(({ label, file }) => `  ${label.padEnd(10)}${this.shown(file)}`);
  }

  /** The state as of now, for tests. */
  snapshot(): RunState {
    return structuredClone(this.state);
  }

  private async relativeFile(testFilePath: string): Promise<string> {
    const absolute = path.resolve(this.options.cwd, testFilePath);
    let root: string | null = null;
    try {
      root = await this.projectRootOf(absolute);
    } catch {
      root = null;
    }
    return slashes(path.relative(root ?? this.options.cwd, absolute));
  }

  private shown(file: string): string {
    return shownPath(this.options.cwd, file);
  }

  /**
   * Write every file. During the run a failure is a warning, since the next
   * write replaces it; on the last write it is an error and turns exit 0 into 1.
   * Returns the exit code the state ends with.
   */
  private async writeAll(last: boolean): Promise<number> {
    this.state.durationMs = Math.max(0, this.now() - this.startMs);
    const written: FileTarget[] = [];
    for (const target of this.targets) {
      try {
        await this.writeOne(target);
        written.push(target);
      } catch (err) {
        const message = `Could not write ${this.shown(target.file)}: ${messageOf(err)}`;
        if (!last) {
          logger.warn(`${message}. The next write will replace it.`);
        } else {
          logger.error(message);
          // So a file written after this one carries the code the run ends with.
          if (this.state.exitCode === 0) this.state.exitCode = 1;
        }
      }
    }
    if (last) this.written = written;
    return this.state.exitCode ?? 0;
  }

  private async writeOne(target: FileTarget): Promise<void> {
    const text = target.render(this.state);
    const temp = target.file + TEMP_SUFFIX;
    await this.ops.mkdir(path.dirname(target.file));
    try {
      await this.ops.writeFile(temp, text);
      await withRetry(() => this.ops.rename(temp, target.file), this.sleep);
    } catch (err) {
      await this.ops.remove(temp).catch(() => {});
      throw err;
    }
  }
}

/** `file` as the terminal shows it: relative to `cwd` where it can be. */
function shownPath(cwd: string, file: string): string {
  return path.relative(cwd, file) || file;
}

/** `op`, tried again a short wait apart while another program holds the file (§8.2). */
async function withRetry(op: () => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await op();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || !code || !RETRYABLE.has(code)) throw err;
      await sleep(RENAME_RETRY_MS);
    }
  }
}

/**
 * Remove each of `files` and its temporary file. One that cannot be removed is
 * logged as a warning, and the rest are still tried.
 */
async function removeFiles(
  files: readonly string[],
  ops: FileOps,
  sleep: (ms: number) => Promise<void>,
  shown: (file: string) => string,
): Promise<void> {
  for (const file of files) {
    for (const f of [file, file + TEMP_SUFFIX]) {
      try {
        await withRetry(() => ops.remove(f), sleep);
      } catch (err) {
        logger.warn(`Could not remove ${shown(f)} from an earlier run: ${messageOf(err)}`);
      }
    }
  }
}

/**
 * Remove `junit.xml`, `run.json` and their temporary files from `outputDir`,
 * both of them. For a run that refuses its reporter names
 * (§4): which files it was meant to write is unknown, so neither file from an
 * earlier run is left for CI to publish as this run's (§5).
 */
export async function removeAllResultFiles(
  options: Pick<RunReportersOptions, 'outputDir' | 'cwd' | 'sleep' | 'fileOps'>,
): Promise<void> {
  await removeFiles(
    [JUNIT_FILE_NAME, RUN_JSON_FILE_NAME].map((name) => path.join(options.outputDir, name)),
    { ...realFileOps, ...options.fileOps },
    options.sleep ?? realSleep,
    (f) => shownPath(options.cwd, f),
  );
}

/**
 * Whether `names` asks for a file besides the HTML reports, which are always
 * written. Without one, `steptix run` builds no {@link RunReporters}.
 */
export function wantsResultFiles(names: readonly ReporterName[]): boolean {
  return names.some((r) => r === 'junit' || r === 'json');
}

/**
 * The testsuite's name: the name of the project folder `cwd` is in, found the
 * way a test's project root is (the nearest folder at or above it holding
 * `steptix.config.json`), else the working directory's own name. That walk
 * also stops at the Steptix user folder, so a run from inside it is named
 * after that folder.
 */
export async function suiteNameFor(
  cwd: string,
  projectRootOf: (testFilePath: string) => Promise<string | null> = resolveProjectRoot,
): Promise<string> {
  let root: string | null = null;
  try {
    // A file name inside `cwd`, because the walk starts at a file's folder.
    root = await projectRootOf(path.join(cwd, 'steptix.config.json'));
  } catch {
    root = null;
  }
  return path.basename(root ?? cwd) || 'steptix';
}
