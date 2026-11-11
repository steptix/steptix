/**
 * `junit.xml` and `run.json` kept true while `steptix run` goes on
 * (docs/specs/SPEC-reporters.md §5, §8, §8.1, §8.2, §9).
 *
 * The two writers are stood in for by functions that serialise the run state,
 * so every write can be read back as the state it was made from. What is under
 * test is when the files are written, what state each write carries, and what
 * a failed write does to the run; what the writers make of a state is theirs.
 *
 * Runs go through the `runTestFn` seam, as tests/data-rows-runner.test.ts
 * does, so no browser starts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestContent, parseTestFile } from '../src/parser/markdown.js';
import { runTests, type runTest } from '../src/runner/test-runner.js';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { TestReport } from '../src/report/types.js';
import type { RunState } from '../src/report/reporters/types.js';
import type { RunJson } from '../src/report/reporters/json.js';
import {
  RENAME_ATTEMPTS,
  RunReporters,
  wantsResultFiles,
  type RunReportersOptions,
} from '../src/report/reporters/run-reporters.js';
import { runCommand, type RunCommandDeps, type RunOptions } from '../src/cli/commands/run.js';
import { logger } from '../src/utils/logger.js';

/** Both writers: the state, as JSON, so a file reads back as what it was made from. */
const serialise = (state: RunState): string => JSON.stringify(state);

/** A clock that moves one second per reading, so durations are known. */
function steppingClock(start = Date.parse('2026-11-11T09:00:00.000Z')): () => number {
  let t = start;
  return () => {
    const now = t;
    t += 1000;
    return now;
  };
}

let scratch: string;
let outputDir: string;
let config: Config;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-reporters-run-'));
  outputDir = path.join(scratch, 'reports');
  config = structuredClone(DEFAULT_CONFIG);
  config.reports.outputDir = outputDir;
  config.reports.appendRunHistoryToTestFile = false;
  config.reports.openInBrowserAfterRun = false;
  config.tests.contextDir = path.join(scratch, 'no-context');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

function reporterOptions(overrides: Partial<RunReportersOptions> = {}): RunReportersOptions {
  return {
    reporters: ['junit', 'json'],
    outputDir,
    failOnHealed: false,
    suiteName: 'proj',
    cwd: scratch,
    renderJUnit: serialise,
    renderRunJson: serialise,
    now: steppingClock(),
    sleep: async () => {},
    projectRootOf: async () => scratch,
    steptix: { version: '9.9.9', commit: 'abc1234' },
    ...overrides,
  };
}

function reporter(overrides: Partial<RunReportersOptions> = {}): RunReporters {
  return new RunReporters(reporterOptions(overrides));
}

async function readState(name: 'junit.xml' | 'run.json'): Promise<RunState> {
  return JSON.parse(await fs.readFile(path.join(outputDir, name), 'utf-8')) as RunState;
}

function testAt(name: string, body = '1. Go\n2. Stop\n'): ParsedTest {
  return parseTestContent(`# ${name}\n\n## Steps\n${body}`, path.join(scratch, 'tests', `${name.toLowerCase()}.md`));
}

/** A stub `runTest`: `outcome` decides each test's status, or throws. */
function stubRunner(outcome: (instance: TestInstance) => 'passed' | 'failed') {
  return (async (instance: TestInstance): Promise<TestReport> => {
    const status = outcome(instance);
    return {
      testName: instance.test.title,
      filePath: instance.test.filePath,
      tags: [],
      status,
      steps: instance.test.steps.map((instruction, i) => ({
        index: i + 1,
        instruction,
        status,
        turns: [],
        durationMs: 0,
        retried: false,
      })),
      totalSteps: instance.test.steps.length,
      passedSteps: status === 'passed' ? instance.test.steps.length : 0,
      failedSteps: status === 'failed' ? instance.test.steps.length : 0,
      totalSubActions: 0,
      durationMs: 1000,
      tokensUsed: 10,
      inputTokens: 6,
      outputTokens: 4,
      date: new Date('2026-09-04T00:00:00Z').toISOString(),
      parameters: instance.resolvedParameters,
    };
  }) as unknown as typeof runTest;
}

describe('the files while runTests goes on', () => {
  it('lists every test as not run before the first test, and fills each one in after it', async () => {
    const tests = [testAt('Alpha'), testAt('Beta')];
    const r = reporter();
    const seen: Array<{ junit: RunState; json: RunState }> = [];
    const runOne = stubRunner(() => 'passed');
    // Read the files as each test starts, which is after the previous write.
    const reading = (async (...args: Parameters<typeof runOne>) => {
      seen.push({ junit: await readState('junit.xml'), json: await readState('run.json') });
      return runOne(...args);
    }) as typeof runTest;

    await runTests(tests, config, { runTestFn: reading, observer: r.observer });

    expect(seen).toHaveLength(2);
    const [beforeAlpha, beforeBeta] = seen;
    expect(beforeAlpha!.junit).toEqual(beforeAlpha!.json);
    expect(beforeAlpha!.json.finished).toBe(false);
    expect(beforeAlpha!.json.exitCode).toBeUndefined();
    expect(beforeAlpha!.json.tests.map((t) => [t.title, t.state])).toEqual([
      ['Alpha', 'notRun'],
      ['Beta', 'notRun'],
    ]);
    expect(beforeAlpha!.json.tests[0]!.file).toBe('tests/alpha.md');
    expect(beforeAlpha!.json.steptix).toEqual({ version: '9.9.9', commit: 'abc1234' });
    expect(beforeAlpha!.json.suiteName).toBe('proj');

    expect(beforeBeta!.json.tests.map((t) => t.state)).toEqual(['done', 'notRun']);
    const alpha = beforeBeta!.json.tests[0]!;
    expect(alpha.report?.testName).toBe('Alpha');
    expect(alpha.reportFile).toMatch(/^[^/\\]+-alpha\.html$/);
    await fs.access(path.join(outputDir, alpha.reportFile!));

    const after = await readState('run.json');
    expect(after.tests.map((t) => t.state)).toEqual(['done', 'done']);
    expect(after.finished).toBe(false);

    expect(await r.end(0)).toBe(0);
    const final = await readState('run.json');
    expect(final.finished).toBe(true);
    expect(final.exitCode).toBe(0);
    expect(final.startedAt).toBe('2026-11-11T09:00:00.000Z');
    expect(final.durationMs).toBeGreaterThan(0);
  });

  it('keeps a data-driven test as one entry, done with the merged report once its rows ran', async () => {
    const rows = parseTestContent(
      '# Matrix\n\n## Steps\n| plan |\n|------|\n| basic |\n| pro |\n\n1. Go\n',
      path.join(scratch, 'tests', 'matrix.md'),
    );
    const r = reporter();
    const states: RunState[] = [];
    const runOne = stubRunner(() => 'passed');
    const reading = (async (...args: Parameters<typeof runOne>) => {
      states.push(await readState('run.json'));
      return runOne(...args);
    }) as typeof runTest;

    await runTests([rows], config, { runTestFn: reading, observer: r.observer });

    expect(states.map((s) => s.tests.length)).toEqual([1, 1]);
    expect(states.map((s) => s.tests[0]!.state)).toEqual(['notRun', 'notRun']);
    const done = await readState('run.json');
    expect(done.tests).toHaveLength(1);
    expect(done.tests[0]!.state).toBe('done');
    expect(done.tests[0]!.report?.rows).toHaveLength(2);
  });

  it('leaves the tests --bail did not reach as not run, with bailed set by the end', async () => {
    const tests = [testAt('Alpha'), testAt('Beta'), testAt('Gamma')];
    const r = reporter();

    await runTests(tests, config, {
      bail: true,
      runTestFn: stubRunner((i) => (i.test.title === 'Beta' ? 'failed' : 'passed')),
      observer: r.observer,
    });
    await r.end(1);

    const final = await readState('junit.xml');
    expect(final.bailed).toBe(true);
    expect(final.finished).toBe(true);
    expect(final.exitCode).toBe(1);
    expect(final.tests.map((t) => t.state)).toEqual(['done', 'done', 'notRun']);
    expect(final.tests[1]!.report?.status).toBe('failed');
  });

  it('marks the test that threw as runError with its message, leaves the rest not run, and still throws', async () => {
    const tests = [testAt('Alpha'), testAt('Beta'), testAt('Gamma')];
    const r = reporter();
    const boom = new Error('Data file not found: rows.csv');

    const run = runTests(tests, config, {
      runTestFn: stubRunner((i) => {
        if (i.test.title === 'Beta') throw boom;
        return 'passed';
      }),
      observer: r.observer,
    });
    await expect(run).rejects.toBe(boom);
    await r.end(1);

    const final = await readState('run.json');
    expect(final.tests.map((t) => t.state)).toEqual(['done', 'runError', 'notRun']);
    expect(final.tests[1]!.message).toBe('Data file not found: rows.csv');
    expect(final.exitCode).toBe(1);
  });

  it('does not let an observer that throws change the run', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const summary = await runTests([testAt('Alpha')], config, {
      runTestFn: stubRunner(() => 'passed'),
      observer: {
        onStart: () => {
          throw new Error('observer-start-broke');
        },
        onTestDone: async () => {
          throw new Error('observer-done-broke');
        },
      },
    });
    expect(summary.passedTests).toBe(1);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/observer-start-broke[\s\S]*observer-done-broke/);
  });
});

describe('the writes', () => {
  it('removes a stale junit.xml, run.json and their temporary files', async () => {
    await fs.mkdir(outputDir, { recursive: true });
    for (const name of ['junit.xml', 'run.json', 'junit.xml.tmp', 'run.json.tmp', 'keep.html']) {
      await fs.writeFile(path.join(outputDir, name), 'from an earlier run');
    }
    await reporter().removeStale();
    expect((await fs.readdir(outputDir)).sort()).toEqual(['keep.html']);
  });

  it('removes only the files of the reporters that are on', async () => {
    await fs.mkdir(outputDir, { recursive: true });
    for (const name of ['junit.xml', 'run.json']) {
      await fs.writeFile(path.join(outputDir, name), 'from an earlier run');
    }
    await reporter({ reporters: ['json'] }).removeStale();
    expect((await fs.readdir(outputDir)).sort()).toEqual(['junit.xml']);
  });

  it('is wanted only when junit or json is on', () => {
    expect(wantsResultFiles([])).toBe(false);
    expect(wantsResultFiles(['html'])).toBe(false);
    expect(wantsResultFiles(['html', 'json'])).toBe(true);
    expect(wantsResultFiles(['junit'])).toBe(true);
  });

  it('writes each file through a temporary file, leaving none behind', async () => {
    const writes: string[] = [];
    const r = reporter({
      fileOps: {
        writeFile: async (file, text) => {
          writes.push(path.basename(file));
          await fs.writeFile(file, text);
        },
      },
    });
    await r.end(0);
    expect(writes).toEqual(['junit.xml.tmp', 'run.json.tmp']);
    expect((await fs.readdir(outputDir)).sort()).toEqual(['junit.xml', 'run.json']);
  });

  it('tries a blocked rename again: no warning, and the exit code unchanged', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const waits: number[] = [];
    let failures = 1;
    const r = reporter({
      sleep: async (ms) => {
        waits.push(ms);
      },
      fileOps: {
        rename: async (from, to) => {
          if (failures-- > 0) throw Object.assign(new Error('held open'), { code: 'EBUSY' });
          await fs.rename(from, to);
        },
      },
    });
    await r.observer.onStart!([testAt('Alpha')]);
    expect(await r.end(0)).toBe(0);
    expect(waits).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect((await readState('run.json')).exitCode).toBe(0);
  });

  it('gives up on a rename after a few attempts, and does not retry other errors', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    let attempts = 0;
    const r = reporter({
      reporters: ['junit'],
      fileOps: {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error('held open'), { code: 'EPERM' });
        },
      },
    });
    await r.end(0);
    expect(attempts).toBe(RENAME_ATTEMPTS);

    attempts = 0;
    const other = reporter({
      reporters: ['junit'],
      fileOps: {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        },
      },
    });
    await other.end(0);
    expect(attempts).toBe(1);
  });

  it('warns about a write that fails during the run, and a passing run still exits 0 when the last one works', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let failNext = true;
    const r = reporter({
      fileOps: {
        writeFile: async (file, text) => {
          if (failNext) throw Object.assign(new Error('disk said no'), { code: 'EIO' });
          await fs.writeFile(file, text);
        },
      },
    });
    await r.observer.onStart!([testAt('Alpha')]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Could not write .*junit\.xml: disk said no/);
    failNext = false;
    expect(await r.end(0)).toBe(0);
    expect((await readState('run.json')).exitCode).toBe(0);
    expect((await fs.readdir(outputDir)).sort()).toEqual(['junit.xml', 'run.json']);
  });

  it('turns exit 0 into 1 when the last write fails, and says so in the file that was written', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const r = reporter({
      renderJUnit: () => {
        throw new Error('cannot render');
      },
    });
    expect(await r.end(0)).toBe(1);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Could not write .*junit\.xml: cannot render/);
    expect((await readState('run.json')).exitCode).toBe(1);
    expect(r.summaryLines()).toEqual([`  JSON:     ${path.join('reports', 'run.json')}`]);
  });

  it('keeps a failing run at 1 when the last write fails', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const r = reporter({
      fileOps: {
        rename: async () => {
          throw Object.assign(new Error('read-only'), { code: 'EROFS' });
        },
      },
    });
    expect(await r.end(1)).toBe(1);
    expect(r.summaryLines()).toEqual([]);
  });

  it('names a test file relative to its project root with / separators, else relative to the working directory', async () => {
    const root = path.join(scratch, 'proj');
    const nested = path.join(root, 'tests', 'deep', 'flow.md');
    const loose = path.join(scratch, 'elsewhere', 'loose.md');
    const r = reporter({
      cwd: scratch,
      projectRootOf: async (file) => (file.startsWith(root) ? root : null),
    });
    await r.observer.onStart!([
      parseTestContent('# Flow\n\n## Steps\n1. Go\n', nested),
      parseTestContent('# Loose\n\n## Steps\n1. Go\n', loose),
    ]);
    const state = await readState('run.json');
    expect(state.tests.map((t) => t.file)).toEqual(['tests/deep/flow.md', 'elsewhere/loose.md']);
  });
});

// ─── Through the command ──────────────────────────────────────────────────

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

describe('steptix run with reporters', () => {
  let project: string;
  let savedEnv: NodeJS.ProcessEnv;
  let savedCwd: string;
  let printed: string[];

  beforeEach(async () => {
    savedEnv = { ...process.env };
    savedCwd = process.cwd();
    // Not the developer's machine: the user root, and the env switches the
    // loader reads into the report settings.
    process.env['LOCALAPPDATA'] = scratch;
    process.env['XDG_CONFIG_HOME'] = scratch;
    delete process.env['OPEN_REPORT_IN_BROWSER_AFTER_RUN'];
    delete process.env['APPEND_RUN_HISTORY_TO_TEST_FILE'];
    delete process.env['AUTOMATION_ENV'];
    delete process.env['AI_MODEL'];
    project = path.join(scratch, 'shop-tests');
    await fs.mkdir(path.join(project, 'tests', 'sub'), { recursive: true });
    await fs.writeFile(
      path.join(project, 'steptix.config.json'),
      JSON.stringify({ reports: { outputDir: './reports' }, tests: { dir: './tests', pattern: '**/*.md' } }),
    );
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function deps(overrides: Partial<RunCommandDeps> = {}): RunCommandDeps {
    return {
      usageError: (message) => {
        throw new Error(`usage: ${message}`);
      },
      exit: (code) => {
        throw new Exited(code);
      },
      runTestFn: stubRunner(() => 'passed'),
      reporterOptions: { renderJUnit: serialise, renderRunJson: serialise, now: steppingClock(), sleep: async () => {} },
      ...overrides,
    };
  }

  async function run(target: string | undefined, opts: RunOptions, d = deps()): Promise<number> {
    try {
      await runCommand(target, opts, d);
    } catch (err) {
      if (err instanceof Exited) return err.code;
      throw err;
    }
    throw new Error('runCommand returned without exiting');
  }

  const projectReports = (): string => path.join(project, 'reports');
  async function projectState(name = 'run.json'): Promise<RunState> {
    return JSON.parse(await fs.readFile(path.join(projectReports(), name), 'utf-8')) as RunState;
  }

  it('writes both files and prints where, after the summary', async () => {
    await fs.writeFile(path.join(project, 'tests', 'login.md'), '# Login\n\n## Steps\n1. Go\n');
    process.chdir(project);

    expect(await run(undefined, { reporter: ['junit,json'] })).toBe(0);

    const state = await projectState();
    expect(state.finished).toBe(true);
    expect(state.exitCode).toBe(0);
    expect(state.suiteName).toBe('shop-tests');
    expect(state.tests.map((t) => [t.file, t.state])).toEqual([['tests/login.md', 'done']]);
    const summaryAt = printed.findIndex((l) => l.includes('TEST RUN SUMMARY'));
    const junitAt = printed.findIndex((l) => l === `  JUnit:    ${path.join('reports', 'junit.xml')}`);
    const jsonAt = printed.findIndex((l) => l === `  JSON:     ${path.join('reports', 'run.json')}`);
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(junitAt).toBeGreaterThan(summaryAt);
    expect(jsonAt).toBe(junitAt + 1);
  });

  it('reads reports.reporters when no flag is given, and the flag replaces it', async () => {
    await fs.writeFile(path.join(project, 'tests', 'login.md'), '# Login\n\n## Steps\n1. Go\n');
    await fs.writeFile(
      path.join(project, 'steptix.config.json'),
      JSON.stringify({ reports: { outputDir: './reports', reporters: ['junit'] }, tests: { dir: './tests', pattern: '**/*.md' } }),
    );
    process.chdir(project);

    expect(await run(undefined, {})).toBe(0);
    expect((await fs.readdir(projectReports())).filter((f) => !f.endsWith('.html'))).toEqual(['junit.xml']);

    await fs.rm(path.join(projectReports(), 'junit.xml'));
    expect(await run(undefined, { reporter: ['html'] })).toBe(0);
    expect((await fs.readdir(projectReports())).filter((f) => !f.endsWith('.html'))).toEqual([]);
  });

  /** Files an earlier run left in the reports folder, both reporters' and their temporary files. */
  async function leaveStaleFiles(): Promise<void> {
    await fs.mkdir(projectReports(), { recursive: true });
    for (const name of ['junit.xml', 'run.json', 'junit.xml.tmp', 'run.json.tmp', 'old-report.html']) {
      await fs.writeFile(path.join(projectReports(), name), 'from an earlier run');
    }
  }

  it('refuses an unknown name before anything runs, removing both stale files first', async () => {
    await fs.writeFile(path.join(project, 'tests', 'login.md'), '# Login\n\n## Steps\n1. Go\n');
    await leaveStaleFiles();
    process.chdir(project);
    const runOne = vi.fn(stubRunner(() => 'passed'));

    await expect(run(undefined, { reporter: ['junit,xml'] }, deps({ runTestFn: runOne as unknown as typeof runTest }))).rejects.toThrow(
      'usage: Unknown reporter "xml" in --reporter. The reporters are html, junit, json.',
    );
    expect(runOne).not.toHaveBeenCalled();
    // `junit` was named too, but which files were meant is unknown: neither is kept.
    expect(await fs.readdir(projectReports())).toEqual(['old-report.html']);
  });

  it('refuses an unknown name in reports.reporters, naming the config file, and removes both stale files', async () => {
    await fs.writeFile(
      path.join(project, 'steptix.config.json'),
      JSON.stringify({ reports: { outputDir: './reports', reporters: ['xunit'] } }),
    );
    await leaveStaleFiles();
    process.chdir(project);
    await expect(run(undefined, {})).rejects.toThrow(/usage: Unknown reporter "xunit" in reports\.reporters in steptix\.config\.json/);
    expect(await fs.readdir(projectReports())).toEqual(['old-report.html']);
  });

  it('refuses --row against several files: the stale files are gone and none are written', async () => {
    await fs.writeFile(path.join(project, 'tests', 'a.md'), '# A\n\n## Steps\n1. Go\n');
    await fs.writeFile(path.join(project, 'tests', 'b.md'), '# B\n\n## Steps\n1. Go\n');
    await leaveStaleFiles();
    process.chdir(project);
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    expect(await run(undefined, { reporter: ['junit,json'], row: 1 })).toBe(1);
    expect(await fs.readdir(projectReports())).toEqual(['old-report.html']);
  });

  it('writes one testcase for the row --row narrows to, under its own row number', async () => {
    await fs.writeFile(
      path.join(project, 'tests', 'plans.md'),
      '# Choose a plan\n\n## Steps\n| plan |\n|------|\n| basic |\n| pro |\n| team |\n\n1. Go\n',
    );
    process.chdir(project);
    const d = deps();
    // The real writers, so what is read back is the file CI reads.
    d.reporterOptions = { now: steppingClock(), sleep: async () => {} };
    expect(await run('tests/plans.md', { reporter: ['junit,json'], row: 2 }, d)).toBe(0);

    const xml = await fs.readFile(path.join(projectReports(), 'junit.xml'), 'utf-8');
    expect([...xml.matchAll(/<testcase name="([^"]*)"/g)].map((m) => m[1])).toEqual(['Choose a plan [row 2]']);
    expect(xml).toContain('<property name="row.plan" value="pro"/>');
    const json = JSON.parse(await fs.readFile(path.join(projectReports(), 'run.json'), 'utf-8')) as RunJson;
    expect(json.tests[0]!.rows!.map((r) => [r.row, r.values])).toEqual([[2, { plan: 'pro' }]]);
  });

  describe('a run that healed a step', () => {
    /** A stub run whose one step broke in code-behind and then passed under AI. */
    const passingRun = stubRunner(() => 'passed') as unknown as (instance: TestInstance) => Promise<TestReport>;
    const healing = (async (instance: TestInstance): Promise<TestReport> => {
      const passing = await passingRun(instance);
      return {
        ...passing,
        healedSteps: 1,
        steps: passing.steps.map((s) => ({
          ...s,
          codeBehindStale: { file: 'heal.steps.ts', source: s.instruction, error: 'No such element: #item' },
        })),
      };
    }) as unknown as typeof runTest;

    it.each([
      { failOnHealed: false, code: 0, failures: '0' },
      { failOnHealed: true, code: 1, failures: '1' },
    ])('exits $code with --fail-on-healed $failOnHealed, and both files agree', async ({ failOnHealed, code, failures }) => {
      await fs.writeFile(path.join(project, 'tests', 'heal.md'), '# Heal\n\n## Steps\n1. Add #item\n');
      process.chdir(project);
      const d = deps({ runTestFn: healing });
      d.reporterOptions = { now: steppingClock(), sleep: async () => {} };

      expect(await run(undefined, { reporter: ['junit,json'], failOnHealed }, d)).toBe(code);

      const xml = await fs.readFile(path.join(projectReports(), 'junit.xml'), 'utf-8');
      expect(xml).toMatch(new RegExp(`<testsuites [^>]*failures="${failures}" errors="0"`));
      const json = JSON.parse(await fs.readFile(path.join(projectReports(), 'run.json'), 'utf-8')) as RunJson;
      expect(json.exitCode).toBe(code);
      expect(json.tests[0]).toMatchObject({ status: 'passed', healedSteps: 1 });
    });
  });

  it('removes the stale files when the run stops before it knows its tests', async () => {
    await fs.mkdir(projectReports(), { recursive: true });
    for (const name of ['junit.xml', 'run.json', 'run.json.tmp']) {
      await fs.writeFile(path.join(projectReports(), name), 'old');
    }
    process.chdir(project);
    // An environment that does not load ends the run before discovery.
    expect(await run(undefined, { reporter: ['junit,json'], env: 'no-such-env' })).toBe(1);
    expect(await fs.readdir(projectReports())).toEqual([]);
  });

  it('writes both files with zero tests when no tests are found', async () => {
    process.chdir(project);
    expect(await run(undefined, { reporter: ['junit', 'json'] })).toBe(0);
    for (const name of ['junit.xml', 'run.json']) {
      const state = await projectState(name);
      expect(state.tests).toEqual([]);
      expect(state.finished).toBe(true);
      expect(state.exitCode).toBe(0);
    }
  });

  it('writes zero tests when none match --tag', async () => {
    await fs.writeFile(path.join(project, 'tests', 'login.md'), '# Login\n\n## Steps\n1. Go\n');
    process.chdir(project);
    expect(await run(undefined, { reporter: ['json'], tag: 'nightly' })).toBe(0);
    expect((await projectState()).tests).toEqual([]);
  });

  it('names a file that fails to parse, lists the rest as not run, and throws as before', async () => {
    await fs.writeFile(path.join(project, 'tests', 'a-good.md'), '# Good\n\n## Steps\n1. Go\n');
    const bad = path.join(project, 'tests', 'b-bad.md');
    await fs.writeFile(bad, '# Bad\n\n## Steps\n1. [skill: no-such-skill]\n');
    process.chdir(project);
    const expected = await parseTestFile(bad, { skillsDir: path.join(project, 'skills') }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(expected).not.toBeNull();

    await expect(run(undefined, { reporter: ['junit,json'] })).rejects.toThrow(expected!);

    const state = await projectState();
    expect(state.finished).toBe(true);
    expect(state.exitCode).toBe(1);
    expect(state.tests).toEqual([
      { title: 'Good', file: 'tests/a-good.md', tags: [], state: 'notRun' },
      { title: 'tests/b-bad.md', file: 'tests/b-bad.md', tags: [], state: 'parseError', message: expected },
    ]);
    expect(await projectState('junit.xml')).toEqual(state);
  });

  it('records a test that throws and exits 1', async () => {
    await fs.writeFile(path.join(project, 'tests', 'a.md'), '# A\n\n## Steps\n1. Go\n');
    await fs.writeFile(path.join(project, 'tests', 'b.md'), '# B\n\n## Steps\n1. Go\n');
    process.chdir(project);
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const throwing = stubRunner((i) => {
      if (i.test.title === 'A') throw new Error('row 9 is out of range');
      return 'passed';
    });
    expect(await run(undefined, { reporter: ['json'] }, deps({ runTestFn: throwing }))).toBe(1);
    const state = await projectState();
    expect(state.tests.map((t) => [t.title, t.state, t.message])).toEqual([
      ['A', 'runError', 'row 9 is out of range'],
      ['B', 'notRun', undefined],
    ]);
    expect(state.exitCode).toBe(1);
  });

  it('turns a passing run into exit 1 when the last write fails', async () => {
    await fs.writeFile(path.join(project, 'tests', 'a.md'), '# A\n\n## Steps\n1. Go\n');
    process.chdir(project);
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const d = deps();
    d.reporterOptions = {
      ...d.reporterOptions,
      fileOps: {
        rename: async () => {
          throw Object.assign(new Error('read-only'), { code: 'EROFS' });
        },
      },
    };
    expect(await run(undefined, { reporter: ['junit'] }, d)).toBe(1);
    expect(printed.some((l) => l.includes('JUnit:'))).toBe(false);
  });

  it('gives a test the same file when started from a subfolder', async () => {
    await fs.writeFile(path.join(project, 'tests', 'sub', 'flow.md'), '# Flow\n\n## Steps\n1. Go\n');
    process.chdir(project);
    expect(await run('tests/sub/flow.md', { reporter: ['json'] })).toBe(0);
    const fromRoot = (await projectState()).tests[0]!.file;

    process.chdir(path.join(project, 'tests', 'sub'));
    expect(await run('flow.md', { reporter: ['json'] })).toBe(0);
    // From the subfolder the output folder is relative to it, as the HTML
    // reports' is.
    const fromSub = JSON.parse(
      await fs.readFile(path.join(project, 'tests', 'sub', 'reports', 'run.json'), 'utf-8'),
    ) as RunState;
    expect(fromRoot).toBe('tests/sub/flow.md');
    expect(fromSub.tests[0]!.file).toBe(fromRoot);
    expect(fromSub.suiteName).toBe('shop-tests');
  });

  it('writes no files and prints nothing extra with no reporter chosen', async () => {
    await fs.writeFile(path.join(project, 'tests', 'a.md'), '# A\n\n## Steps\n1. Go\n');
    process.chdir(project);
    let calls = 0;
    const counting = stubRunner(() => {
      calls++;
      return 'passed';
    });
    expect(await run(undefined, {}, deps({ runTestFn: counting }))).toBe(0);
    expect(calls).toBe(1);
    const files = await fs.readdir(projectReports());
    expect(files.every((f) => f.endsWith('.html'))).toBe(true);
    expect(printed.some((l) => /JUnit:|JSON:/.test(l))).toBe(false);
  });
});
