/**
 * `[use ai] <step>` in the CLI run loop (stories/use-ai-step.md §Tests, "Per
 * loop"), main flow and hook scope, with the executor MOCKED on purpose: every
 * claim here is about the LOOP — that it dispatches the step beside `Set`,
 * that the step never reaches `executeStep` (the only thing that runs a
 * `.steps.ts` entry), that the value reaches the next step and the report, and
 * that a second run asks again.
 *
 * The model is a scripted `AiClient.complete` that records what it was sent.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';
import type { ResolvedHooks } from '../src/runner/hooks.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── Harness (the failure-outcomes-runner one, with a scripted model) ───────

const launchBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: vi.fn(),
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
  NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {},
  NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
  BrowserTracker: class BrowserTrackerStub {
    private session: unknown;
    private launch: (() => Promise<unknown>) | undefined;
    constructor(initial: unknown) { this.session = initial; }
    getActive() {
      if (this.session === undefined) throw new Error('no browser has been launched in this session');
      return this.session;
    }
    getActivePage() { return (this.getActive() as { page: unknown }).page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() {}
    list() { return []; }
    get count() { return this.session === undefined ? 0 : 1; }
    hasActive() { return this.session !== undefined; }
    static deferred(launch: () => Promise<unknown>) {
      const tracker = new BrowserTrackerStub(undefined);
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched() {
      if (this.session === undefined) this.session = await this.launch!();
      return this.session;
    }
  },
}));

/** Every `executeStep` call, hooks included. */
const executeStepCalls: Array<{ index: number; instruction: string; opts: Record<string, unknown> }> = [];
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: async (...args: unknown[]): Promise<StepResult> => {
    executeStepCalls.push({
      index: args[0] as number,
      instruction: args[2] as string,
      opts: args[3] as Record<string, unknown>,
    });
    return {
      index: args[0] as number,
      instruction: args[2] as string,
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
    };
  },
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/browser/screenshot.js', () => ({ captureScreenshot: async () => null }));

let hooksStub: ResolvedHooks;
vi.mock('../src/runner/hooks.js', () => ({ resolveHooks: vi.fn(async () => hooksStub) }));

/** The model: a queue of replies, and every request it was sent. With `echo`
 *  it answers every call with its own user message as the value instead — the
 *  bluntest form of what the real model did with issue 060's probe. */
const model = vi.hoisted(() => ({ replies: [] as string[], requests: [] as ChatMessage[][], echo: false }));
vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    async complete(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
      model.requests.push(messages);
      if (model.echo) return { text: JSON.stringify({ value: messages[1]!.content }), model: 'stub-model' };
      const text = model.replies.shift();
      if (text === undefined) throw new Error('the model was asked more times than scripted');
      return { text, model: 'stub-model' };
    }
  },
}));
vi.mock('../src/ai/diagnose.js', () => ({ diagnoseFailure: vi.fn(async () => null) }));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn(async () => ''),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));
vi.mock('../src/report/history-appender.js', () => ({ appendRunHistory: vi.fn(async () => undefined) }));

import { expandTestInstances, runTest } from '../src/runner/test-runner.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { renderReport } from '../src/report/generator.js';
import { addLogCallback } from '../src/utils/logger.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Unique per run (still under tests/), so two runs of this file from one
// checkout never share — or delete — each other's tree.
let tmpBase: string;
let dir: string;
let counter = 0;

type Scope = 'before' | 'beforeEach' | 'afterEach' | 'after';
function hooks(over: Partial<Record<Scope, string[]>> = {}): ResolvedHooks {
  const scopes: Record<Scope, string[]> = { before: [], beforeEach: [], afterEach: [], after: [], ...over };
  const slots = () =>
    Object.fromEntries(Object.entries(scopes).map(([scope, lines]) => [scope, lines.map(() => null)]));
  return {
    ...scopes,
    hasAny: Object.values(scopes).some((lines) => lines.length > 0),
    toolCalls: slots() as ResolvedHooks['toolCalls'],
    sourceSkills: slots() as ResolvedHooks['sourceSkills'],
  };
}

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, apiKey: 'test-key' },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    execution: { ...DEFAULT_CONFIG.execution, retries: 1 },
  };
}

async function instanceOf(
  markdown: string,
  name = 'use-ai.md',
  options: { skillsDir?: string } = {},
): Promise<TestInstance> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, markdown);
  const test: ParsedTest = await parseTestFile(filePath, options);
  return { test, resolvedParameters: {} };
}

const stepsDoc = (...lines: string[]): string =>
  `# t\n\n## Steps\n${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n`;

/** Every line logged while `fn` runs, as one string. */
async function logged<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string }> {
  const lines: string[] = [];
  const off = addLogCallback((_level, message) => lines.push(message));
  try {
    return { value: await fn(), lines: lines.join('\n') };
  } finally {
    off();
  }
}

beforeAll(async () => {
  tmpBase = await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-use-ai-runner-cli-'));
});

beforeEach(async () => {
  executeStepCalls.length = 0;
  model.replies = [];
  model.requests = [];
  model.echo = false;
  hooksStub = hooks();
  launchBrowserMock.mockReset();
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'https://app.test/', goto: vi.fn(async () => undefined) },
  });
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ─── The cases ──────────────────────────────────────────────────────────────

const GENERATE =
  '[use ai] Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name';

describe('the CLI main flow', () => {
  it('asks the model the step alone, stores the value, and hands it to the next step', async () => {
    model.replies = ['{"as": "random_name", "value": "AUTO4821"}'];
    const instance = await instanceOf(stepsDoc(GENERATE, 'Type {{random_name}} into the name field'));
    const { value: report, lines } = await logged<TestReport>(() => runTest(instance, config()));

    expect(report.status).toBe('passed');
    // One model call, the step's own text, and nothing else.
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.map((m) => m.role)).toEqual(['system', 'user']);
    expect(model.requests[0]![1]!.content).toBe(
      'Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name',
    );
    // The [use ai] step never reached the executor; the next step did, with
    // the value in it.
    expect(executeStepCalls.map((c) => c.instruction)).toEqual([
      'Type AUTO4821 into the name field',
    ]);
    // The report row: ◆ Captured from `outputs`, one turn holding the call.
    const row = report.steps.find((s) => s.index === 1)!;
    expect(row.outputs).toEqual({ random_name: 'AUTO4821' });
    expect(row.turns[0]!.aiInteractions[0]!.purpose).toBe('use-ai');
    expect(renderReport(report)).toContain('AUTO4821');
    // The CLI step line.
    expect(lines).toContain('[ai] random_name = "AUTO4821"');
  });

  it('asks the model again on a second run, and never reaches the executor', async () => {
    const md = stepsDoc(GENERATE, 'Type {{random_name}} into the name field');
    model.replies = ['{"as": "random_name", "value": "AUTO1111"}', '{"as": "random_name", "value": "AUTO2222"}'];

    const first = await runTest(await instanceOf(md), config());
    const second = await runTest(await instanceOf(md), config());

    expect(model.requests).toHaveLength(2);
    expect(first.steps[0]!.outputs).toEqual({ random_name: 'AUTO1111' });
    expect(second.steps[0]!.outputs).toEqual({ random_name: 'AUTO2222' });
    // Only the ordinary step reached the executor, once per run; the [use ai]
    // step never did.
    expect(executeStepCalls).toHaveLength(2);
    for (const call of executeStepCalls) {
      expect(call.instruction).not.toContain('[use ai]');
    }
  });

  it('masks a secret-named target on the step line, and the value is still stored', async () => {
    model.replies = ['{"value": "s3cr3t-generated"}'];
    const instance = await instanceOf(
      stepsDoc('[use ai] Make up a password [store as: new_password]', 'Type {{new_password}} into the box'),
    );
    const { value: report, lines } = await logged(() => runTest(instance, config()));
    expect(report.status).toBe('passed');
    expect(lines).toContain('[ai] new_password = "***"');
    expect(lines).not.toContain('s3cr3t-generated');
    expect(executeStepCalls[0]!.instruction).toBe('Type s3cr3t-generated into the box');
  });

  it('fails the step with the model\'s reason, and does not retry an error', async () => {
    model.replies = ['{"error": "The step does not say what today is."}'];
    const report = await runTest(
      await instanceOf(stepsDoc('[use ai] Give the date 3 days from today as yyyymmdd and store it in days_from_now', 'Click Save')),
      config(),
    );
    expect(report.status).toBe('failed');
    expect(model.requests).toHaveLength(1);
    expect(report.steps[0]!.error).toContain('The step does not say what today is.');
    expect(executeStepCalls).toEqual([]);
  });

  it('works inside a `### Section` body and a loop, asked once per pass', async () => {
    const md = [
      '# t',
      '',
      '## Steps',
      '1. For each {{city}} in {{cities}}, Describe it',
      '',
      '### Describe it',
      '1. [use ai] Write a slogan for {{city}} [store as: slogan]',
      '2. Type {{slogan}} into the notes',
      '',
    ].join('\n');
    const instance = await instanceOf(md);
    instance.resolvedParameters = { cities: '["Perth","Hobart"]' };
    model.replies = ['{"value": "Sunny Perth"}', '{"value": "Cool Hobart"}'];
    const report = await runTest(instance, config());
    expect(report.status).toBe('passed');
    expect(model.requests.map((r) => r[1]!.content)).toEqual([
      'Write a slogan for Perth',
      'Write a slogan for Hobart',
    ]);
    expect(executeStepCalls.map((c) => c.instruction)).toEqual([
      'Type Sunny Perth into the notes',
      'Type Cool Hobart into the notes',
    ]);
  });
});

describe('a data-row run', () => {
  it('asks once per row, with that row\'s values filled in', async () => {
    const md = [
      '# t',
      '',
      '## Steps',
      '',
      '| city |',
      '| --- |',
      '| Perth |',
      '| Hobart |',
      '',
      '1. [use ai] Write a slogan for {{city}} [store as: slogan]',
      '2. Type {{slogan}} into the notes',
      '',
    ].join('\n');
    const filePath = path.join(dir, 'rows.md');
    await fs.writeFile(filePath, md);
    const test = await parseTestFile(filePath);
    const instances = await expandTestInstances(test, config());
    expect(instances).toHaveLength(2);
    model.replies = ['{"value": "Sunny Perth"}', '{"value": "Cool Hobart"}'];
    for (const instance of instances) {
      expect((await runTest(instance, config())).status).toBe('passed');
    }
    expect(model.requests.map((r) => r[1]!.content)).toEqual([
      'Write a slogan for Perth',
      'Write a slogan for Hobart',
    ]);
    expect(executeStepCalls.map((c) => c.instruction)).toEqual([
      'Type Sunny Perth into the notes',
      'Type Cool Hobart into the notes',
    ]);
  });
});

describe('a secret the expander wrote into the step text (issue 060)', () => {
  const SENTENCE = 'stands for a value that is hidden from you';
  const IN_TEXT = "The value contains `***` — the mask for a secret written into the step's text";

  it('masks a looped section row\'s secret column in every row, and an echo fails each one', async () => {
    const md = [
      '# t',
      '',
      '## Steps',
      '1. Echo each password',
      '',
      '### Echo each password',
      '| password |',
      '|----------|',
      '| cli-row-SECRET-1 |',
      '| cli-row-SECRET-2 |',
      '',
      '1. [use ai] Repeat {{password}} exactly [store as: copy] otherwise continue',
      '',
    ].join('\n');
    model.echo = true;
    const { value: report, lines } = await logged(async () => runTest(await instanceOf(md), config()));

    expect(model.requests.map((r) => r[1]!.content)).toEqual(['Repeat *** exactly', 'Repeat *** exactly']);
    for (const request of model.requests) expect(request[0]!.content).toContain(SENTENCE);
    expect(report.steps.map((s) => [s.status, s.tolerated])).toEqual([
      ['failed', true],
      ['failed', true],
    ]);
    for (const step of report.steps) expect(step.error).toContain(IN_TEXT);
    // Nothing stored, and — now that `secretsNow()` holds the rows — neither
    // value on the console or in the report, where the CLI used to print them.
    expect(lines).not.toContain('[ai] copy');
    const everything = lines + JSON.stringify(report) + JSON.stringify(model.requests);
    expect(everything).not.toContain('cli-row-SECRET-1');
    expect(everything).not.toContain('cli-row-SECRET-2');
  });

  it('masks a skill argument, and an echo fails the step', async () => {
    const skillsDir = path.join(dir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'echo.md'),
      [
        '---', 'type: skill', '---', '# echo', '',
        '## Parameters', '- password: the value to repeat', '',
        '## Steps', '1. [use ai] Repeat {{password}} exactly [store as: copy]', '',
      ].join('\n'),
    );
    model.echo = true;
    const instance = await instanceOf(stepsDoc('[skill: echo password="cli-skill-SECRET"]'), 'skill.md', {
      skillsDir,
    });
    const { value: report, lines } = await logged(() => runTest(instance, config()));

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]![1]!.content).toBe('Repeat *** exactly');
    expect(model.requests[0]![0]!.content).toContain(SENTENCE);
    expect(report.status).toBe('failed');
    expect(report.steps[0]!.error).toContain(IN_TEXT);
    expect(lines + JSON.stringify(report) + JSON.stringify(model.requests)).not.toContain('cli-skill-SECRET');
  });
});

describe('a CLI hook scope', () => {
  it('runs a [use ai] hook line through the same runner, before step 1', async () => {
    hooksStub = hooks({ before: ['[use ai] Make up an order reference [store as: order_ref]'] });
    model.replies = ['{"value": "ORD-77"}'];
    const report = await runTest(
      await instanceOf(stepsDoc('Type {{order_ref}} into the search box')),
      config(),
    );
    expect(report.status).toBe('passed');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]![1]!.content).toBe('Make up an order reference');
    const hookRow = report.steps.find((s) => s.hookScope === 'before')!;
    expect(hookRow.status).toBe('passed');
    expect(hookRow.outputs).toEqual({ order_ref: 'ORD-77' });
    // Not handed to the executor as a hook step either.
    expect(executeStepCalls.map((c) => c.instruction)).toEqual(['Type ORD-77 into the search box']);
  });
});
