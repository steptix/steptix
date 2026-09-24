import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';

/**
 * A compile's runs start from the parameters a Run would start from
 * (stories/codebehind-compile-as-a-run.md §What was built, "Parameters").
 *
 * Caught live: `tests/github with sections.md` declares
 * `- username: $GITHUB_USERNAME`, runs green from TestBench — which resolves
 * `$VAR` on the client before sending — and compiled with the literal
 * `$GITHUB_USERNAME` typed into the username field. The parser keeps `$VAR`
 * as written; only the CLI's file runner ever resolved it, from `process.env`,
 * which the server deliberately does not share with the project.
 *
 * `runTest` is mocked here so the DEFAULT runner — the CLI's — can be shown to
 * start from the request's map rather than the parsed test's raw values. The
 * pipeline's own resolution is covered in codebehind-compile.test.ts.
 */

const runTestMock = vi.hoisted(() => vi.fn());
vi.mock('../src/runner/test-runner.js', () => ({
  runTest: runTestMock,
}));

import {
  createTestFileRunner,
  firstDataRow,
  resolveCompileParameters,
} from '../src/codebehind/compile.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-compile-parameters');
let counter = 0;
let dir: string;

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
  runTestMock.mockReset();
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

const CONFIG: Config = { ...DEFAULT_CONFIG };

describe('resolveCompileParameters', () => {
  it('walks the run chain: data row, then $VAR from the env, then the inline value', () => {
    const { values, unresolved } = resolveCompileParameters(
      { username: '$GITHUB_USERNAME', password: '$GITHUB_PASSWORD', plan: 'pro', region: '$REGION' },
      { GITHUB_USERNAME: 'octocat', GITHUB_PASSWORD: 'hunter2', REGION: 'eu' },
      { region: 'us', extra: 'from-the-row' },
    );
    expect(values).toEqual({
      username: 'octocat',
      password: 'hunter2',
      plan: 'pro',
      // The row outranks the env, and its extra keys ride along.
      region: 'us',
      extra: 'from-the-row',
    });
    expect(unresolved).toEqual([]);
  });

  it('leaves a $VAR nothing defines as the literal, and names it', () => {
    const { values, unresolved } = resolveCompileParameters(
      { username: '$GITHUB_USERNAME', note: 'plain' },
      {},
    );
    expect(values).toEqual({ username: '$GITHUB_USERNAME', note: 'plain' });
    expect(unresolved).toEqual(['username']);
  });
});

describe('firstDataRow', () => {
  it('is the first row of the frontmatter data file, with the count', async () => {
    await fs.writeFile(
      path.join(dir, 'rows.json'),
      JSON.stringify([{ username: 'row-one' }, { username: 'row-two' }]),
    );
    await fs.writeFile(
      path.join(dir, 'rows.md'),
      ['---', 'dataFile: rows.json', '---', '', '# Rows', '', '## Steps', '1. Do it'].join('\n'),
    );
    const test = await parseTestFile(path.join(dir, 'rows.md'));
    expect(await firstDataRow(test, dir)).toEqual({ row: { username: 'row-one' }, of: 2 });
  });

  it('is nothing for a test without a data file', async () => {
    await fs.writeFile(path.join(dir, 'plain.md'), ['# Plain', '', '## Steps', '1. Do it'].join('\n'));
    const test = await parseTestFile(path.join(dir, 'plain.md'));
    expect(await firstDataRow(test, dir)).toBeUndefined();
  });
});

describe("the default runner — the CLI's", () => {
  it("starts runTest from the request's parameters, not the parsed test's raw values", async () => {
    await fs.writeFile(
      path.join(dir, 'login.md'),
      ['# Login', '', '## Parameters', '- username: $GITHUB_USERNAME', '', '## Steps', '1. Log in'].join('\n'),
    );
    const test = await parseTestFile(path.join(dir, 'login.md'));
    expect(test.parameters).toEqual({ username: '$GITHUB_USERNAME' });
    runTestMock.mockResolvedValue({
      status: 'passed', steps: [], totalSteps: 1, passedSteps: 1, failedSteps: 0,
      totalSubActions: 0, durationMs: 1, tokensUsed: 0, inputTokens: 0, outputTokens: 0,
      date: '', testName: 'Login', filePath: test.filePath, tags: [],
    });

    const runner = createTestFileRunner({
      test, config: CONFIG, contextContent: '', aiClient: {} as never,
    });
    await runner({
      purpose: 'replay',
      parameters: { username: 'octocat' },
      strict: true,
      captureContext: false,
      throughStep: 1,
    });

    expect(runTestMock).toHaveBeenCalledTimes(1);
    const [instance, , , extras] = runTestMock.mock.calls[0]!;
    expect(instance.resolvedParameters).toEqual({ username: 'octocat' });
    expect(extras).toMatchObject({ codeBehindStrict: true, stopAfterStep: 1 });
  });
});
