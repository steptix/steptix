import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestContent } from '../src/parser/markdown.js';
import { expandTestInstances, runTests } from '../src/runner/test-runner.js';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { TestReport } from '../src/report/types.js';

/**
 * The run loop for data-driven rows (stories/data-driven-rows.md, part A).
 *
 * `runTests` boots real browsers, so every case here goes through the
 * `runTestFn` seam: the loop, the merge and `--bail` are the behaviour under
 * test, not what a step does to a page.
 */

function testWithRows(rows: string): ParsedTest {
  return parseTestContent(
    `# Matrix\n\n## Parameters\n- shared: yes\n\n## Steps\n${rows}\n1. Go\n2. Stop\n`,
    path.join(os.tmpdir(), 'matrix.md'),
  );
}

const TABLE =
  '| email | password |\n' +
  '|-------|----------|\n' +
  '| a@b.c | pw1      |\n' +
  '| d@e.f | pw2      |\n' +
  '| g@h.i | pw3      |\n\n';

let outputDir: string;
let config: Config;

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-rows-'));
  config = structuredClone(DEFAULT_CONFIG);
  config.reports.outputDir = outputDir;
  config.reports.appendRunHistoryToTestFile = false;
  config.reports.openInBrowserAfterRun = false;
  config.tests.contextDir = path.join(outputDir, 'no-context');
});

afterEach(async () => {
  await fs.rm(outputDir, { recursive: true, force: true });
});

/** A stub `runTest` that records what it was handed and reports a result. */
function stubRunner(outcome: (instance: TestInstance) => 'passed' | 'failed' = () => 'passed') {
  const seen: TestInstance[] = [];
  const fn = (async (instance: TestInstance): Promise<TestReport> => {
    seen.push(instance);
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
  }) as unknown as typeof import('../src/runner/test-runner.js').runTest;
  return { seen, fn };
}

describe('expandTestInstances with inline rows', () => {
  it('produces one instance per row, indexed from zero', async () => {
    const instances = await expandTestInstances(testWithRows(TABLE), config);
    expect(instances).toHaveLength(3);
    expect(instances.map((i) => i.dataRowIndex)).toEqual([0, 1, 2]);
    expect(instances.every((i) => i.dataRowCount === 3)).toBe(true);
  });

  it('lets a column shadow a parameter and keeps parameters that have no column', async () => {
    const test = parseTestContent(
      '# T\n\n## Parameters\n- email: fallback@x\n- shared: yes\n\n' +
        '## Steps\n| email |\n|-------|\n| row@x |\n\n1. Go\n',
    );
    const [instance] = await expandTestInstances(test, config);
    expect(instance!.resolvedParameters['email']).toBe('row@x');
    expect(instance!.resolvedParameters['shared']).toBe('yes');
  });

  it('carries the row cells separately from the merged parameters', async () => {
    // The matrix table shows the row, not every shared parameter alongside it.
    const [instance] = await expandTestInstances(testWithRows(TABLE), config);
    expect(instance!.dataRowValues).toEqual({ email: 'a@b.c', password: 'pw1' });
    expect(instance!.resolvedParameters['shared']).toBe('yes');
  });

  it('resolves a $VAR cell against the environment', async () => {
    process.env['ROW_PW_TEST'] = 'from-env';
    try {
      const test = testWithRows('| password |\n|----------|\n| $ROW_PW_TEST |\n\n');
      const [instance] = await expandTestInstances(test, config);
      expect(instance!.resolvedParameters['password']).toBe('from-env');
    } finally {
      delete process.env['ROW_PW_TEST'];
    }
  });

  it('leaves an unset $VAR cell literal rather than empty', async () => {
    // Empty would submit the form and fail somewhere far from the cause.
    delete process.env['ROW_PW_MISSING'];
    const test = testWithRows('| password |\n|----------|\n| $ROW_PW_MISSING |\n\n');
    const [instance] = await expandTestInstances(test, config);
    expect(instance!.resolvedParameters['password']).toBe('$ROW_PW_MISSING');
  });

  it('narrows to one row with --row, keeping its original index', async () => {
    const instances = await expandTestInstances(testWithRows(TABLE), config, { row: 3 });
    expect(instances).toHaveLength(1);
    expect(instances[0]!.dataRowIndex).toBe(2);
    expect(instances[0]!.dataRowCount).toBe(3);
  });

  it('rejects a --row outside the table', async () => {
    await expect(expandTestInstances(testWithRows(TABLE), config, { row: 9 })).rejects.toThrow(
      /out of range.*3 row/s,
    );
  });

  it('rejects --row on a test with no rows', async () => {
    const test = parseTestContent('# T\n\n## Steps\n1. Go\n');
    await expect(expandTestInstances(test, config, { row: 1 })).rejects.toThrow(/has no rows/);
  });
});

describe('runTests over rows', () => {
  it('runs every row and writes exactly one report', async () => {
    const { seen, fn } = stubRunner();
    const summary = await runTests([testWithRows(TABLE)], config, { runTestFn: fn });

    expect(seen).toHaveLength(3);
    const written = (await fs.readdir(outputDir)).filter((f) => f.endsWith('.html'));
    expect(written).toHaveLength(1);
    // The suffix that used to tell five files apart is gone with them.
    expect(written[0]).not.toMatch(/-row\d/);
  });

  it('counts the test once and the rows separately', async () => {
    const { fn } = stubRunner();
    const summary = await runTests([testWithRows(TABLE)], config, { runTestFn: fn });

    expect(summary.totalTests).toBe(1);
    expect(summary.passedTests).toBe(1);
    expect(summary.reports).toHaveLength(1);
    expect(summary.reports[0]!.rows).toHaveLength(3);
    // Six steps genuinely ran: the origins line and the counts must say so.
    expect(summary.reports[0]!.totalSteps).toBe(6);
    expect(summary.reports[0]!.steps).toHaveLength(6);
  });

  it('does not stop the loop when a row fails', async () => {
    const { seen, fn } = stubRunner((i) => (i.dataRowIndex === 1 ? 'failed' : 'passed'));
    const summary = await runTests([testWithRows(TABLE)], config, { runTestFn: fn });

    expect(seen).toHaveLength(3);
    expect(summary.failedTests).toBe(1);
    expect(summary.reports[0]!.rows!.map((r) => r.status)).toEqual([
      'passed',
      'failed',
      'passed',
    ]);
  });

  it('stops after a failing row under --bail and lists the rest as not run', async () => {
    const { seen, fn } = stubRunner((i) => (i.dataRowIndex === 0 ? 'failed' : 'passed'));
    const summary = await runTests([testWithRows(TABLE)], config, { runTestFn: fn, bail: true });

    expect(seen).toHaveLength(1);
    const rows = summary.reports[0]!.rows!;
    expect(rows.map((r) => r.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(rows[1]!.notRunReason).toBe('stopped');
  });

  it('stamps each row onto its own steps', async () => {
    const { fn } = stubRunner();
    const summary = await runTests([testWithRows(TABLE)], config, { runTestFn: fn });

    const markers = summary.reports[0]!.steps.map((s) => s.loop);
    expect(markers.map((m) => m?.index)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(markers[0]).toMatchObject({
      kind: 'row',
      count: 3,
      // `password` is masked by name — see the secrets case below.
      values: { email: 'a@b.c', password: '***' },
    });
  });

  it('leaves a test without rows exactly as it was', async () => {
    const { fn } = stubRunner();
    const plain = parseTestContent('# Plain\n\n## Steps\n1. Go\n', path.join(os.tmpdir(), 'p.md'));
    const summary = await runTests([plain], config, { runTestFn: fn });

    expect(summary.totalTests).toBe(1);
    expect(summary.reports[0]!.rows).toBeUndefined();
    expect(summary.reports[0]!.steps[0]!.loop).toBeUndefined();
  });
});

describe('secrets in row values', () => {
  it('masks a secret-named column in the band and the matrix table', async () => {
    // The row's cells are stamped onto the report *after* each row's own
    // redaction pass, so without masking at the merge a `$TEST_PASSWORD` cell
    // would arrive masked in the step instruction and in clear beside it.
    const { fn } = stubRunner();
    const test = testWithRows('| email | password |\n|---|---|\n| a@b.c | hunter2000 |\n\n');
    const summary = await runTests([test], config, { runTestFn: fn });

    const marker = summary.reports[0]!.steps[0]!.loop!;
    expect(marker.values['password']).toBe('***');
    expect(marker.values['email']).toBe('a@b.c');
    expect(summary.reports[0]!.rows![0]!.values['password']).toBe('***');
  });
});
