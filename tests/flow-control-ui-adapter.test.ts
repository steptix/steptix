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

/** Stub the executor: `override` wins where it returns something, else a pass. */
function stubExecutor(
  override: (
    index: number,
    instruction: string,
    opts: StepExecutorOptions,
  ) => StepResult | undefined = () => undefined,
): void {
  executeStepMock.mockImplementation(
    async (index: number, _total: number, instruction: string, opts: StepExecutorOptions) =>
      override(index, instruction, opts) ?? passed(index, instruction),
  );
}

/** Write a numbered `## Steps` test (`head` adds sections above it) and run it. */
async function runSteps(name: string, steps: string[], head = ''): Promise<Emitted[]> {
  const body = `# t\n${head}\n## Steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
  return runAdapter(writeTest(root, name, body));
}

/** The data of the one `runner:step-complete` carrying `status: 'failed'`. */
function failedEvent(events: Emitted[]): Record<string, unknown> {
  return events.find(
    (e) => e.channel === 'runner:step-complete' && e.data['status'] === 'failed',
  )!.data;
}

function runStatus(events: Emitted[]): unknown {
  return events.find((e) => e.channel === 'runner:complete')?.data['status'];
}

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'steptix-ui-flow-')));
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

// The two failure outcomes (stories/step-failure-outcomes.md).

/** What the executor returns once an `otherwise continue` tail has been
 *  applied: still `failed`, with the flag beside it (decision 6). */
function toleratedResult(index: number, instruction: string): StepResult {
  return {
    ...passed(index, instruction),
    status: 'failed',
    error: 'no build number in the footer',
    tolerated: true,
  };
}

describe('the Electron loop and a tolerated failure', () => {
  const line = 'Verify the footer shows the build number otherwise continue';

  it('runs the next step, completes passed, and tails only that step', async () => {
    stubExecutor((index, instruction) =>
      instruction === line ? toleratedResult(index, instruction) : undefined,
    );
    const events = await runSteps('tolerated.md', ['Navigate to /', line, 'Click "Sign out"']);

    // `status` stays `'failed'` on the wire — the step did not do what it
    // said — and the flag beside it is what paints amber (decision 9).
    expect(completions(events)).toEqual([
      [1, 'passed'],
      [2, 'failed'],
      [3, 'passed'],
    ]);
    expect(failedEvent(events)['tolerated']).toBe(true);
    expect(failedEvent(events)['error']).toBe('no build number in the footer');
    // Step 3 really ran: no bail.
    expect(executeStepMock.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(runStatus(events)).toBe('passed');
    // The tail reached the executor for step 2 and for no other step.
    expect(
      executeStepMock.mock.calls.map((c) => (c[3] as StepExecutorOptions).failureTail),
    ).toEqual([
      undefined,
      { body: 'Verify the footer shows the build number', outcome: 'continue' },
      undefined,
    ]);
  });

  it('carries the author`s warning to the panel', async () => {
    // The warning lived only in the row's explanation, which never crosses IPC,
    // so the panel's amber line never said the author expected it (decision 6).
    const warned = 'Verify the footer shows the build number otherwise continue with warning "Footer build number missing"';
    stubExecutor((index, instruction) =>
      instruction === warned
        ? { ...toleratedResult(index, instruction), warning: 'Footer build number missing' }
        : undefined,
    );
    const events = await runSteps('warned.md', ['Navigate to /', warned]);

    expect(failedEvent(events)['warning']).toBe('Footer build number missing');
    // `error` stays the framework's account of what went wrong.
    expect(failedEvent(events)['error']).toBe('no build number in the footer');
  });

  it('an ordinary failure still stops the run — the control for the row above', async () => {
    stubExecutor((index, instruction) =>
      index === 2
        ? { ...passed(2, instruction), status: 'failed' as const, error: 'boom' }
        : undefined,
    );
    const events = await runSteps('stops.md', [
      'Navigate to /',
      'Click the export button',
      'Click "Sign out"',
    ]);

    expect(completions(events)).toEqual([[1, 'passed'], [2, 'failed']]);
    expect(runStatus(events)).toBe('failed');
  });
});

describe('the Electron loop and a deliberate failure', () => {
  it('dispatches a bare `Fail …` with no model call and stops there', async () => {
    stubExecutor();
    const events = await runSteps('bare-fail.md', [
      'Navigate to /',
      'Fail the test with error "No balance was shown"',
      'Click "Sign out"',
    ]);

    // Step 2 never reached the executor (decision 3), and step 3 never ran.
    expect(executeStepMock.mock.calls.map((c) => c[0])).toEqual([1]);
    expect(completions(events)).toEqual([[1, 'passed'], [2, 'failed']]);
    expect(failedEvent(events)['error']).toBe('No balance was shown');
    expect(failedEvent(events)['deliberate']).toBe(true);
    expect(runStatus(events)).toBe('failed');
  });

  it('masks a secret the author interpolated into the message', async () => {
    // The bare `Fail …` dispatch composed its message unredacted here, unlike
    // every other loop, and this event is what the panel logs and the report is
    // built from (decision 3).
    stubExecutor();
    const events = await runSteps(
      'masked-fail.md',
      ['Navigate to /', 'Fail the test with error "Sign-in with {{password}} was rejected"'],
      '\n## Parameters\n- password: hunter2\n',
    );

    expect(failedEvent(events)['error']).toBe('Sign-in with *** was rejected');
    expect(String(failedEvent(events)['error'])).not.toContain('hunter2');
    // Scoped to the completion event on purpose: `runner:step-start` carries the
    // interpolated INSTRUCTION unmasked on every step, which predates this story.
  });

  it('passes a conditional `fail` claim to the executor, and flags the result', async () => {
    const line = 'If the balance is zero then fail the test with error "No balance was shown"';
    stubExecutor((index, instruction, opts) =>
      opts.flowControlClaim
        ? {
            ...passed(index, instruction),
            status: 'failed' as const,
            error: 'No balance was shown',
            deliberate: true,
          }
        : undefined,
    );
    const events = await runSteps('cond-fail.md', ['Navigate to /', line, 'Click "Sign out"']);

    const opts = executeStepMock.mock.calls[1]![3] as StepExecutorOptions;
    expect(opts.flowControlClaim).toEqual({
      verb: 'fail',
      body: 'the balance is zero',
      message: 'No balance was shown',
    });
    expect(opts.failureTail).toBeUndefined();
    expect(failedEvent(events)['deliberate']).toBe(true);
    expect(runStatus(events)).toBe('failed');
  });
});
