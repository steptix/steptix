/**
 * `[use ai] <step>` in the Electron runner (stories/use-ai-step.md §Tests,
 * "Per loop"): the fourth loop, beside its `Set` branch.
 *
 * Driven through the adapter's public `start()`, with the browser, the step
 * executor and the AI client replaced and everything between the file on disk
 * and those seams left real — the parser, the adapter's own loop, the shared
 * runner. This runner has no variables event, so the value's proof is where
 * it lands: the next step's text and the report row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepResult, TestReport } from '../src/report/types.js';

const launchBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
}));

const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
}));

const model = vi.hoisted(() => ({ replies: [] as string[], requests: [] as unknown[][] }));
vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    async complete(messages: unknown[]): Promise<{ text: string; model: string }> {
      model.requests.push(messages);
      const text = model.replies.shift();
      if (text === undefined) throw new Error('the model was asked more times than scripted');
      return { text, model: 'stub' };
    }
  },
}));

vi.mock('../src/config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/loader.js')>()),
  loadConfig: async () => structuredClone(DEFAULT_CONFIG),
}));

const reports = vi.hoisted(() => ({ written: [] as unknown[] }));
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn(async (report: unknown) => {
    reports.written.push(report);
    return '';
  }),
}));

import { UIRunnerAdapter } from '../src/ui/main/runner-adapter.js';

type Emitted = { channel: string; data: Record<string, unknown> };

const originalCwd = process.cwd();
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'steptix-ui-use-ai-')));
  process.chdir(root);
  model.replies = [];
  model.requests = [];
  reports.written = [];
  executeStepMock.mockReset();
  executeStepMock.mockImplementation(
    async (index: number, _total: number, instruction: string): Promise<StepResult> => ({
      index,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
    }),
  );
  launchBrowserMock.mockReset();
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'about:blank', goto: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

function writeTest(body: string): string {
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  const file = path.join(root, 'tests', 'use-ai.md');
  writeFileSync(file, body);
  return file;
}

async function run(file: string): Promise<Emitted[]> {
  const events: Emitted[] = [];
  const adapter = new UIRunnerAdapter((channel, data) => {
    events.push({ channel, data: data as Record<string, unknown> });
  });
  await adapter.start(file, []);
  return events;
}

describe('UIRunnerAdapter runs a [use ai] step beside Set', () => {
  it('asks the model the step alone, stores the value, and the next step reads it', async () => {
    const file = writeTest(
      [
        '# Use ai',
        '',
        '## Steps',
        '1. [use ai] Create a name starting with "AUTO" and store it in random_name',
        '2. Type {{random_name}} into the name field',
        '',
      ].join('\n'),
    );
    model.replies = ['{"as": "random_name", "value": "AUTO4821"}'];

    const events = await run(file);

    expect(events.filter((e) => e.channel === 'runner:error')).toEqual([]);
    expect(model.requests).toHaveLength(1);
    const [system, user] = model.requests[0] as Array<{ role: string; content: string }>;
    expect([system!.role, user!.role]).toEqual(['system', 'user']);
    expect(user!.content).toBe('Create a name starting with "AUTO" and store it in random_name');
    // Not an executor call; the next step is, with the value in it.
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual(['Type AUTO4821 into the name field']);
    // The panel sees the step start and pass like any other.
    const completes = events.filter((e) => e.channel === 'runner:step-complete');
    expect(completes[0]!.data).toMatchObject({ stepIndex: 1, status: 'passed' });
    // The report row carries the value — this runner's only place for it.
    const report = reports.written.at(-1) as TestReport;
    expect(report.steps[0]!.outputs).toEqual({ random_name: 'AUTO4821' });
    expect(events.at(-1)).toMatchObject({ channel: 'runner:complete', data: { status: 'passed' } });
  });

  it('a failed [use ai] step stops the run with its reason', async () => {
    const file = writeTest(
      ['# Use ai', '', '## Steps', '1. [use ai] Give tomorrow\'s date [store as: d]', '2. Click Save', ''].join('\n'),
    );
    model.replies = ['{"error": "The step does not say what today is."}'];
    const events = await run(file);
    const errors = events.filter((e) => e.channel === 'runner:error').map((e) => e.data['message']);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('The step does not say what today is.');
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  it('masks a looped section row\'s secret column, which expansion wrote into the text (issue 060)', async () => {
    const file = writeTest(
      [
        '# Use ai',
        '',
        '## Steps',
        '1. Echo each password',
        '',
        '### Echo each password',
        '| password |',
        '|----------|',
        '| ui-row-SECRET-1 |',
        '| ui-row-SECRET-2 |',
        '',
        '1. [use ai] Repeat {{password}} exactly [store as: copy] otherwise continue',
        '',
      ].join('\n'),
    );
    // What an echoing model answers, once per row.
    model.replies = ['{"value": "***"}', '{"value": "***"}'];
    const events = await run(file);
    const sent = model.requests as Array<Array<{ role: string; content: string }>>;
    expect(sent.map((messages) => messages[1]!.content)).toEqual(['Repeat *** exactly', 'Repeat *** exactly']);
    for (const messages of sent) {
      expect(messages[0]!.content).toContain('stands for a value that is hidden from you');
    }
    const completes = events.filter((e) => e.channel === 'runner:step-complete').map((e) => e.data);
    expect(completes.map((c) => [c['status'], c['tolerated']])).toEqual([
      ['failed', true],
      ['failed', true],
    ]);
    expect(String(completes[0]!['error'])).toContain("the mask for a secret written into the step's text");
    expect(JSON.stringify(sent)).not.toContain('ui-row-SECRET');
  });

  it('an `otherwise continue` tail carries the run past a failure, as on any step', async () => {
    const file = writeTest(
      [
        '# Use ai',
        '',
        '## Steps',
        '1. [use ai] Give tomorrow\'s date [store as: d] otherwise continue with warning "no date"',
        '2. Click Save',
        '',
      ].join('\n'),
    );
    model.replies = ['{"error": "The step does not say what today is."}'];
    const events = await run(file);
    expect(events.filter((e) => e.channel === 'runner:error')).toEqual([]);
    const first = events.find((e) => e.channel === 'runner:step-complete')!;
    expect(first.data).toMatchObject({ stepIndex: 1, status: 'failed', tolerated: true, warning: 'no date' });
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual(['Click Save']);
  });
});
