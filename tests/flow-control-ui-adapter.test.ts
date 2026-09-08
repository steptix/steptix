/**
 * The Electron Runner UI loop, once a step returns
 * (stories/step-flow-control.md §"The four loops").
 *
 * Driven through the adapter's public `start()` with the browser, the step
 * executor and the AI client replaced and everything between the file on disk
 * and the emitted IPC events left real — the harness
 * `tests/ui-runner-adapter-env-data.test.ts` established. The assertions are on
 * the EVENTS, because they are what the Runner UI paints: a step nobody ran
 * must not arrive as a pass or as a failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepResult } from '../src/report/types.js';
import type { StepExecutorOptions } from '../src/runner/step-executor.js';

const launchBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
}));

const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));

vi.mock('../src/config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/loader.js')>()),
  loadConfig: async () => structuredClone(DEFAULT_CONFIG),
}));

vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn().mockResolvedValue(''),
}));

import { UIRunnerAdapter } from '../src/ui/main/runner-adapter.js';

type Emitted = { channel: string; data: Record<string, unknown> };

function writeTest(root: string, name: string, body: string): string {
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  const file = path.join(root, 'tests', name);
  writeFileSync(file, body);
  return file;
}

async function runAdapter(file: string): Promise<Emitted[]> {
  const events: Emitted[] = [];
  const adapter = new UIRunnerAdapter((channel, data) => {
    events.push({ channel, data: data as Record<string, unknown> });
  });
  await adapter.start(file, []);
  return events;
}

/** `[stepIndex, status]` for every step-complete, in order. */
function completions(events: Emitted[]): Array<[number, string]> {
  return events
    .filter((e) => e.channel === 'runner:step-complete')
    .map((e) => [e.data['stepIndex'] as number, e.data['status'] as string]);
}

function passed(index: number, instruction: string): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aiui-ui-flow-')));
  process.chdir(root);
  executeStepMock.mockReset();
  launchBrowserMock.mockReset();
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'https://app.test/', goto: vi.fn(async () => undefined) },
    pageTracker: undefined,
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  rmSync(root, { recursive: true, force: true });
});

describe('the Electron loop and a return', () => {
  it('emits `skipped` for every step a section return leaves behind, and runs on after the call', async () => {
    executeStepMock.mockImplementation(
      async (index: number, _total: number, instruction: string) =>
        index === 2
          ? {
              ...passed(2, instruction),
              aiExplanation: 'already signed in',
              flowControl: { kind: 'return' as const, verb: 'return' as const },
            }
          : passed(index, instruction),
    );

    const file = writeTest(root, 'section.md', `# t

## Steps
1. Navigate to /
2. Sign in
3. Click "Sign out"

### Sign in
1. If the page title contains "Dashboard" then return
2. Enter the username
3. Enter the password
`);
    const events = await runAdapter(file);

    // Flat list: [Navigate, body1, body2, body3, Click "Sign out"].
    expect(completions(events)).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [3, 'skipped'],
      [4, 'skipped'],
      [5, 'passed'],
    ]);
    // The skipped ones carry the reason and no error.
    const skipped = events.filter(
      (e) => e.channel === 'runner:step-complete' && e.data['status'] === 'skipped',
    );
    // The reason quotes the returning step's own AUTHORED line — `step 2` is
    // the expanded index, which the editor does not number by.
    const reason = 'Not run: step 2 returned from "Sign in" — ' +
      'If the page title contains "Dashboard" then return';
    expect(skipped.map((e) => e.data['reason'])).toEqual([reason, reason]);
    expect(skipped.every((e) => e.data['error'] === undefined)).toBe(true);
    // The model was asked about the two body steps that ran and the step
    // after the call — never about the skipped ones.
    expect(executeStepMock.mock.calls.map((c) => c[0])).toEqual([1, 2, 5]);
    // A return is not a failure.
    const complete = events.find((e) => e.channel === 'runner:complete');
    expect(complete?.data['status']).toBe('passed');
  });

  it('quotes the AUTHORED line when a skill argument was interpolated into it', async () => {
    // `parsedTest.steps` is the EXPANDED list, so by the time the loop reaches
    // a skill body step the call's arguments are already baked into its text:
    // reading the reason off `parsedTest.steps[i]` puts the literal password
    // into the run log, the report and this IPC message. `expansion.rawSteps`
    // is the match side, which the expander never interpolates.
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    writeFileSync(
      path.join(root, 'skills', 'login.md'),
      `---
type: skill
---
# login

## Parameters
- password: the account password

## Steps
1. If {{password}} is already remembered then return
2. Type the password {{password}}
`,
    );
    executeStepMock.mockImplementation(
      async (index: number, _total: number, instruction: string) =>
        index === 2
          ? {
              ...passed(2, instruction),
              aiExplanation: 'already signed in',
              flowControl: { kind: 'return' as const, verb: 'return' as const },
            }
          : passed(index, instruction),
    );

    const file = writeTest(root, 'skill.md', `# t

## Steps
1. Navigate to /
2. [skill: login password="hunter2"]
3. Click "Sign out"
`);
    const events = await runAdapter(file);

    // The model was handed the resolved line — it has to judge the real page —
    // and the reason quotes the authored one.
    expect(executeStepMock.mock.calls[1]![2]).toBe(
      'If hunter2 is already remembered then return',
    );
    const skipped = events.filter(
      (e) => e.channel === 'runner:step-complete' && e.data['status'] === 'skipped',
    );
    expect(skipped.map((e) => e.data['reason'])).toEqual([
      'Not run: step 2 returned from "login" — If {{password}} is already remembered then return',
    ]);
    expect(JSON.stringify(skipped)).not.toContain('hunter2');
  });

  it('passes the claim to the executor, and dispatches a bare `Stop` without one', async () => {
    executeStepMock.mockImplementation(
      async (index: number, _total: number, instruction: string) => passed(index, instruction),
    );

    const file = writeTest(root, 'bare.md', `# t

## Steps
1. If the dashboard is shown then return
2. Stop
3. Click "Sign out"
`);
    const events = await runAdapter(file);

    // Step 1 went to the model WITH the claim; step 2 never went at all.
    expect(executeStepMock.mock.calls.map((c) => c[0])).toEqual([1]);
    const opts = executeStepMock.mock.calls[0]![3] as StepExecutorOptions;
    expect(opts.flowControlClaim).toEqual({
      verb: 'return',
      body: 'the dashboard is shown',
    });
    // Step 1's condition did not hold (a plain passed result), so step 2 ran
    // and ended the run.
    expect(completions(events)).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [3, 'skipped'],
    ]);
    expect(
      events.find(
        (e) => e.channel === 'runner:step-complete' && e.data['status'] === 'skipped',
      )?.data['reason'],
    ).toBe('Not run: step 2 ended the run — Stop');
  });
});
