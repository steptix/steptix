/**
 * The CLI runner's half of the mode state machine — SPEC-use-computer.md
 * §4.4, §4.5, §4.6 and acceptance items 2, 6 and 7.
 *
 * Same claim as `computer-mode-session.test.ts`, asserted on the other loop:
 * the two runners must agree about what `[use computer]` does, and the only
 * way to know they do is to ask each of them.
 *
 * Mock wall copied from `cli-lazy-launch.test.ts`, with the step-executor and
 * computer-step modules SPREAD from the real ones rather than stubbed whole —
 * the state machine lives in the second and imports seven values from the
 * first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestConfig, TestInstance } from '../src/parser/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';
import type { ExpandedFrame, ExpandedStepOrigin } from '../src/skills/expander.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const launchBrowserMock = vi.fn();
const closeBrowserMock = vi.fn();

vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: (...args: unknown[]) => closeBrowserMock(...args),
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
  NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {
    constructor(message = 'no browser has been launched in this session') {
      super(message);
      this.name = 'NoBrowserLaunchedError';
    }
  },
  NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
  BrowserTracker: class BrowserTrackerStub {
    session: unknown;
    launch: (() => Promise<unknown>) | undefined;
    constructor(initial: unknown) { this.session = initial; }
    static deferred(launch: () => Promise<unknown>) {
      const tracker = new BrowserTrackerStub(undefined);
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched() {
      if (this.session === undefined) this.session = await this.launch!();
      return this.session;
    }
    hasActive() { return this.session !== undefined; }
    getActive() {
      if (this.session === undefined) {
        throw new Error('no browser has been launched in this session');
      }
      return this.session;
    }
    getActivePage() { return (this.getActive() as { page: unknown }).page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() { if (this.session !== undefined) closeBrowserMock(this.session); }
    list() { return []; }
    get count() { return this.session === undefined ? 0 : 1; }
  },
}));

const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: (...args: unknown[]) => executeStepMock(...args),
  executeBranchedStep: vi.fn(),
}));

const executeComputerStepMock = vi.fn();
vi.mock('../src/runner/computer-step.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/computer-step.js')>()),
  executeComputerStep: (...args: unknown[]) => executeComputerStepMock(...args),
}));

const resolveHooksMock = vi.fn();
vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: (...args: unknown[]) => resolveHooksMock(...args),
}));

vi.mock('../src/ai/diagnose.js', () => ({ diagnoseFailure: vi.fn(async () => null) }));
vi.mock('../src/ai/client.js', () => ({
  AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn().mockResolvedValue(''),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));
vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn().mockResolvedValue(undefined),
}));

/** The console an `[input:]` step prompts on: `promptUserForInput` asks
 *  `readline`, so the question is answered here — and can say what the lock
 *  looked like while the run waited for it. */
const questionMock = vi.fn();
vi.mock('node:readline/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:readline/promises')>();
  const createInterface = () => ({
    question: (query: string) => questionMock(query),
    close: () => {},
  });
  return {
    ...real,
    createInterface,
    default: { ...(real as unknown as { default: object }).default, createInterface },
  };
});

/** The `[interactive]` and failure REPL, answered without a console. */
const runInteractiveReplMock = vi.fn();
vi.mock('../src/runner/interactive-repl.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/interactive-repl.js')>()),
  runInteractiveRepl: (...args: unknown[]) => runInteractiveReplMock(...args),
}));

import { runTest, runTests, type RunTestExtras } from '../src/runner/test-runner.js';
import { FakeDesktopAdapter } from '../src/desktop/fake-adapter.js';
import {
  acquireComputerLock,
  computerLockInUseMessage,
  readComputerLock,
  releaseComputerLock,
} from '../src/desktop/lock.js';
import { parseTestContent } from '../src/parser/markdown.js';
import { COMPUTER_DISABLED_MESSAGE, SkillSurfaceStack } from '../src/runner/computer-step.js';
import { parseToolCall } from '../src/tools/tool-call-parser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession() {
  return { page: { url: () => 'https://example.com/page', goto: vi.fn().mockResolvedValue(undefined) } };
}

function makeInstance(
  steps: string[],
  config: TestConfig = {},
  expansion?: ParsedTest['expansion'],
): TestInstance {
  const test: ParsedTest = {
    filePath: '/tmp/computer-mode-test.md',
    title: 'computer mode test',
    frontmatter: { tags: [] },
    config,
    parameters: {},
    steps,
    stepLines: steps.map((_, i) => i + 1),
    skipHooks: steps.map(() => false),
    toolCalls: steps.map(() => null),
    sourceSkills: steps.map(() => null),
    sourceSections: steps.map(() => null),
    sections: {},
    rawSteps: [...steps],
    hooks: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookToolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookSourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
    ...(expansion && { expansion }),
  };
  return { test, resolvedParameters: {} };
}

function makeConfig(desktop: Partial<Config['desktop']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    execution: { ...DEFAULT_CONFIG.execution, interactiveOnFailure: false },
    ai: { ...DEFAULT_CONFIG.ai, diagnoseFailures: false },
    logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
    desktop: { ...DEFAULT_CONFIG.desktop, enabled: true, maxImageWidth: 200, ...desktop },
  };
}

function passingResult(instruction: string, surface?: 'computer'): StepResult {
  return {
    index: 1,
    instruction,
    status: 'passed',
    turns: [],
    durationMs: 1,
    retried: false,
    ...(surface && { surface }),
  };
}

let lockDir: string;
let lockPath: string;
let adapter: FakeDesktopAdapter;

function extras(over: Partial<RunTestExtras> = {}): RunTestExtras {
  return {
    loadDesktopAdapter: async () => adapter,
    probeComputerCapture: async () => {},
    computerLock: { lockPath },
    ...over,
  };
}

beforeEach(() => {
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  executeStepMock.mockReset();
  executeComputerStepMock.mockReset();
  resolveHooksMock.mockReset();
  questionMock.mockReset();
  questionMock.mockResolvedValue('statement.pdf');
  runInteractiveReplMock.mockReset();
  runInteractiveReplMock.mockResolvedValue({ kind: 'continue' });

  lockDir = mkdtempSync(path.join(os.tmpdir(), 'aiui-computer-cli-'));
  lockPath = path.join(lockDir, 'aiui-computer.lock');
  adapter = new FakeDesktopAdapter({ width: 200, height: 150 });

  launchBrowserMock.mockResolvedValue(makeSession());
  closeBrowserMock.mockResolvedValue(undefined);
  executeStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) =>
    passingResult(instruction),
  );
  executeComputerStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) =>
    passingResult(instruction, 'computer'),
  );
  resolveHooksMock.mockResolvedValue({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
  });
});

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a desktop-first test launches no browser (acceptance 2)', () => {
  it('enters the surface and runs the next step on it', async () => {
    const report = await runTest(
      makeInstance(['[use computer]', 'Click Save in the dialog']),
      makeConfig(),
      '',
      extras(),
    );

    expect(launchBrowserMock).not.toHaveBeenCalled();
    expect(report.status).toBe('passed');
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock).not.toHaveBeenCalled();
    // The `[use …]` row is a MODE MARKER, not a step that did nothing (§10.1).
    expect(report.steps[0]!.stepKind).toBe('mode');
    expect(report.steps[0]!.surface).toBe('computer');
    expect(report.steps[0]!.turns).toHaveLength(0);
  });

  it('[use browser] releases the lock and the next step launches', async () => {
    const report = await runTest(
      makeInstance(['[use computer]', 'Press Ctrl+S', '[use browser]', 'Click the heading']),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('passed');
    expect(launchBrowserMock).toHaveBeenCalledTimes(1);
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock).toHaveBeenCalledTimes(1);
    expect(report.steps[2]!.stepKind).toBe('mode');
    expect(report.steps[2]!.surface).toBe('browser');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('holds the lock for the duration of the run and gives it back in teardown', async () => {
    let heldDuringStep: string | undefined;
    executeComputerStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) => {
      heldDuringStep = readComputerLock({ lockPath })?.sessionId;
      return passingResult(instruction, 'computer');
    });

    await runTest(makeInstance(['[use computer]', 'Click']), makeConfig(), '', extras());

    expect(heldDuringStep).toBe('cli:/tmp/computer-mode-test.md');
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5.9 — the lock is held only while a run executes: one `runTest`, one row
// ---------------------------------------------------------------------------

describe('the CLI gives the lock back at the end of every runTest (§5.9)', () => {
  it('a run that fails on the computer surface releases it', async () => {
    executeComputerStepMock.mockImplementationOnce(async (_i: number, _n: number, instruction: string) => ({
      ...passingResult(instruction, 'computer'),
      status: 'failed',
      error: 'the Save button was not found',
    }));

    const report = await runTest(
      makeInstance(['[use computer]', 'Click Save', 'Click Close']),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('failed');
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a step that throws out of runTest still releases it', async () => {
    executeComputerStepMock.mockImplementationOnce(async () => {
      throw new Error('nut.js exploded');
    });

    let thrown: unknown;
    try {
      await runTest(makeInstance(['[use computer]', 'Click Save']), makeConfig(), '', extras());
    } catch (err) {
      thrown = err;
    }

    expect((thrown as Error | undefined)?.message).toBe('nut.js exploded');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('data rows: each row releases at its end and takes the lock again at its own [use computer]', async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'aiui-computer-cli-rows-'));
    try {
      const config = makeConfig();
      config.reports = {
        ...config.reports,
        outputDir,
        appendRunHistoryToTestFile: false,
        openInBrowserAfterRun: false,
      };
      config.tests = { ...config.tests, contextDir: path.join(outputDir, 'no-context') };
      const filePath = path.join(outputDir, 'rows.md');
      const test = parseTestContent(
        '# Rows\n\n## Steps\n| file |\n|------|\n| a.pdf |\n| b.pdf |\n| c.pdf |\n\n' +
          '1. [use computer]\n2. Type {{file}} into the File name box\n',
        filePath,
      );
      const lockId = `cli:${filePath}`;

      const heldDuringStep: Array<string | undefined> = [];
      executeComputerStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) => {
        heldDuringStep.push(readComputerLock({ lockPath })?.sessionId);
        return passingResult(instruction, 'computer');
      });

      // Between rows: what the lock file says, and — after row 1 — another
      // session takes the lock for the length of row 2, which proves both that
      // row 1 gave it back and that row 2 asks for it again.
      const betweenRows: boolean[] = [];
      const rowReports: TestReport[] = [];
      const summary = await runTests([test], config, {
        runTestFn: (async (...args: Parameters<typeof runTest>) => {
          const row = rowReports.length + 1;
          if (row === 2) acquireComputerLock('mcp:another-session', { lockPath });
          const report = await runTest(args[0], args[1], args[2], extras());
          if (row === 2) releaseComputerLock('mcp:another-session', { lockPath });
          betweenRows.push(existsSync(lockPath));
          rowReports.push(report);
          return report;
        }) as typeof runTest,
      });

      expect(summary.reports[0]!.rows!.map((r) => r.status)).toEqual(['passed', 'failed', 'passed']);
      // Row 2's `[use computer]` was refused by name, and nothing ran on the
      // screen for it.
      expect(rowReports[1]!.steps[0]!.stepKind).toBe('mode');
      expect(rowReports[1]!.steps[0]!.error).toBe(
        computerLockInUseMessage({ pid: process.pid, sessionId: 'mcp:another-session', since: '' }),
      );
      expect(heldDuringStep).toEqual([lockId, lockId]);
      // No row left the lock behind.
      expect(betweenRows).toEqual([false, false, false]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §5.9 — a pause for a person gives the lock back, and the step boundary
// takes it again. Within one `runTest` the computer surface no longer implies
// the lock, which is why the CLI loop now has the server's boundary re-take.
// ---------------------------------------------------------------------------

describe('a CLI pause for a person gives the lock back (§5.9)', () => {
  const LOCK_ID = 'cli:/tmp/computer-mode-test.md';
  const OTHER_IN_USE = computerLockInUseMessage({
    pid: process.pid,
    sessionId: 'mcp:another-session',
    since: '',
  });

  /** Who held the lock each time a computer step ran. */
  function recordHolders(): Array<string | undefined> {
    const holders: Array<string | undefined> = [];
    executeComputerStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) => {
      holders.push(readComputerLock({ lockPath })?.sessionId);
      return passingResult(instruction, 'computer');
    });
    return holders;
  }

  it('[input:]: the prompt waits with the lock free, and the next computer step takes it back', async () => {
    const holders = recordHolders();
    const whilePrompting: boolean[] = [];
    questionMock.mockImplementation(async () => {
      whilePrompting.push(existsSync(lockPath));
      return 'statement.pdf';
    });

    const report = await runTest(
      makeInstance([
        '[use computer]',
        'Click the File name box',
        '[input: file_name] Which file?',
        'Type {{file_name}} into the box',
      ]),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('passed');
    expect(whilePrompting).toEqual([false]);
    // Held before the prompt, and again after it — by the boundary, since
    // nothing else in the loop would take it back.
    expect(holders).toEqual([LOCK_ID, LOCK_ID]);
    expect(executeComputerStepMock.mock.calls[1]![2]).toBe('Type statement.pdf into the box');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('[input:]: another session takes the lock during the prompt, and the next computer step fails with §5.9 without running', async () => {
    const holders = recordHolders();
    questionMock.mockImplementation(async () => {
      acquireComputerLock('mcp:another-session', { lockPath });
      return 'statement.pdf';
    });

    const report = await runTest(
      makeInstance([
        '[use computer]',
        'Click the File name box',
        '[input: file_name] Which file?',
        'Type {{file_name}} into the box',
        'Click Save',
      ]),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('failed');
    expect(report.steps[3]!.status).toBe('failed');
    expect(report.steps[3]!.error).toBe(OTHER_IN_USE);
    expect(report.steps[3]!.surface).toBe('computer');
    expect(report.steps[3]!.turns).toHaveLength(0);
    // Only the step before the prompt ran on the screen.
    expect(holders).toEqual([LOCK_ID]);
    expect(report.steps).toHaveLength(4);
    expect(readComputerLock({ lockPath })!.sessionId).toBe('mcp:another-session');
  });

  it('[input:] takes no lock of its own: a second prompt still asks while another session holds it', async () => {
    recordHolders();
    let asked = 0;
    questionMock.mockImplementation(async () => {
      asked++;
      if (asked === 1) acquireComputerLock('mcp:another-session', { lockPath });
      return 'statement.pdf';
    });

    const report = await runTest(
      makeInstance([
        '[use computer]',
        'Click the File name box',
        '[input: first] First?',
        '[input: second] Second?',
        'Set {{file}} to "{{first}}"',
        'Click Save',
      ]),
      makeConfig(),
      '',
      extras(),
    );

    // Both prompts asked and the `Set` ran; only the computer step was refused.
    expect(asked).toBe(2);
    expect(report.steps.map((s) => s.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
      'failed',
    ]);
    expect(report.steps[5]!.error).toBe(OTHER_IN_USE);
  });

  it('[interactive]: the REPL waits with the lock free, and the next computer step takes it back', async () => {
    const holders = recordHolders();
    const whileInRepl: boolean[] = [];
    runInteractiveReplMock.mockImplementation(async () => {
      whileInRepl.push(existsSync(lockPath));
      return { kind: 'continue' };
    });

    // A page step first: the REPL is handed the run's page, so this run has
    // one to hand it.
    const report = await runTest(
      makeInstance(['Open the page', '[use computer]', 'Click Save', '[interactive]', 'Click Close']),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('passed');
    expect(runInteractiveReplMock).toHaveBeenCalledTimes(1);
    expect(whileInRepl).toEqual([false]);
    expect(holders).toEqual([LOCK_ID, LOCK_ID]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('the failure REPL waits with the lock free, and a `continue` takes it back at the next computer step', async () => {
    const holders: Array<string | undefined> = [];
    executeComputerStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) => {
      holders.push(readComputerLock({ lockPath })?.sessionId);
      return instruction === 'Click Save'
        ? { ...passingResult(instruction, 'computer'), status: 'failed', error: 'no Save button' }
        : passingResult(instruction, 'computer');
    });
    const whileInRepl: boolean[] = [];
    runInteractiveReplMock.mockImplementation(async () => {
      whileInRepl.push(existsSync(lockPath));
      return { kind: 'continue' };
    });
    // The failure REPL opens only for a headed run on a TTY.
    const config = makeConfig();
    config.browser = { ...config.browser, headed: true };
    config.execution = { ...config.execution, interactiveOnFailure: true };
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await runTest(
        makeInstance(['Open the page', '[use computer]', 'Click Save', 'Click Close']),
        config,
        '',
        extras(),
      );
    } finally {
      if (isTTY) Object.defineProperty(process.stdout, 'isTTY', isTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }

    expect(runInteractiveReplMock).toHaveBeenCalledTimes(1);
    expect(runInteractiveReplMock.mock.calls[0]![0]).toMatchObject({ entryReason: 'failure' });
    expect(whileInRepl).toEqual([false]);
    expect(holders).toEqual([LOCK_ID, LOCK_ID]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('data rows: a pause inside each row releases, the row takes the lock back, and every row still gives it back at its end', async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'aiui-computer-cli-rows-pause-'));
    try {
      const config = makeConfig();
      config.reports = {
        ...config.reports,
        outputDir,
        appendRunHistoryToTestFile: false,
        openInBrowserAfterRun: false,
      };
      config.tests = { ...config.tests, contextDir: path.join(outputDir, 'no-context') };
      const filePath = path.join(outputDir, 'rows.md');
      const test = parseTestContent(
        '# Rows\n\n## Steps\n| file |\n|------|\n| a.pdf |\n| b.pdf |\n\n' +
          '1. [use computer]\n2. Click the File name box\n3. [input: note] Anything to add?\n' +
          '4. Type {{file}} into the File name box\n',
        filePath,
      );
      const lockId = `cli:${filePath}`;
      const holders = recordHolders();
      const whilePrompting: boolean[] = [];
      questionMock.mockImplementation(async () => {
        whilePrompting.push(existsSync(lockPath));
        return 'nothing';
      });

      const betweenRows: boolean[] = [];
      const summary = await runTests([test], config, {
        runTestFn: (async (...args: Parameters<typeof runTest>) => {
          const report = await runTest(args[0], args[1], args[2], extras());
          betweenRows.push(existsSync(lockPath));
          return report;
        }) as typeof runTest,
      });

      expect(summary.reports[0]!.rows!.map((r) => r.status)).toEqual(['passed', 'passed']);
      expect(whilePrompting).toEqual([false, false]);
      expect(holders).toEqual([lockId, lockId, lockId, lockId]);
      expect(betweenRows).toEqual([false, false]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe('§5.1 refusals on the CLI path', () => {
  it('desktop.enabled: false fails the step and leaves the surface alone (acceptance 7)', async () => {
    const report = await runTest(
      makeInstance(['[use computer]', 'Click Save']),
      makeConfig({ enabled: false }),
      '',
      extras(),
    );

    expect(report.status).toBe('failed');
    expect(report.steps[0]!.error).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('a failed capture probe fails the step and takes no lock', async () => {
    const report = await runTest(
      makeInstance(['[use computer]']),
      makeConfig(),
      '',
      extras({
        probeComputerCapture: async () => {
          throw new Error('screen capture failed (BitBlt error 6)');
        },
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.steps[0]!.error).toContain('BitBlt error 6');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('§5.1 item 1b — the vision route on the CLI path (§15.4)', () => {
  /** The route the CLI would send computer-mode requests on: a keyed
   *  gateway model on a custom URL — the Copilot bridge's shape. */
  function bridgeConfig(desktop: Partial<Config['desktop']> = {}): Config {
    const config = makeConfig(desktop);
    return {
      ...config,
      ai: {
        ...config.ai,
        model: 'gateway/copilot/gpt-5.6-luna',
        gatewayUrl: 'http://127.0.0.1:4891',
        apiKey: 'bridge-key',
      },
    };
  }

  const REFUSAL =
    'Computer mode needs the model to see the screen, but the TestBench Copilot bridge ' +
    'reports that gateway/copilot/gpt-5.6-luna does not accept images.';

  it('runs after the opt-in and before the adapter loads, and checks config.ai', async () => {
    const order: string[] = [];
    const check = vi.fn(async () => {
      order.push('vision');
      return { ok: true as const };
    });
    const config = bridgeConfig();

    const report = await runTest(
      makeInstance(['[use computer]', 'Click Save']),
      config,
      '',
      extras({
        checkVisionRoute: check,
        loadDesktopAdapter: async () => {
          order.push('adapter');
          return adapter;
        },
        probeComputerCapture: async () => {
          order.push('probe');
        },
      }),
    );

    expect(report.status).toBe('passed');
    expect(order).toEqual(['vision', 'adapter', 'probe']);
    // The effective route IS the run's `config.ai` — the object its AiClient
    // was built from.
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![0]).toMatchObject({
      model: 'gateway/copilot/gpt-5.6-luna',
      gatewayUrl: 'http://127.0.0.1:4891',
      apiKey: 'bridge-key',
    });
  });

  it('is not asked when the project has not opted in', async () => {
    const check = vi.fn(async () => ({ ok: true as const }));

    const report = await runTest(
      makeInstance(['[use computer]']),
      bridgeConfig({ enabled: false }),
      '',
      extras({ checkVisionRoute: check }),
    );

    expect(report.steps[0]!.error).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(check).not.toHaveBeenCalled();
  });

  it('a refusal fails the step with its message and takes no lock', async () => {
    let loaded = false;
    const report = await runTest(
      makeInstance(['[use computer]', 'Click Save']),
      bridgeConfig(),
      '',
      extras({
        checkVisionRoute: async () => ({ ok: false, error: REFUSAL }),
        loadDesktopAdapter: async () => {
          loaded = true;
          return adapter;
        },
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.steps[0]!.stepKind).toBe('mode');
    expect(report.steps[0]!.error).toBe(REFUSAL);
    expect(loaded).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('a keyless run is not asked', async () => {
    const check = vi.fn(async () => ({ ok: false as const, error: 'must not be asked' }));
    const config = bridgeConfig();
    config.ai = { ...config.ai, apiKey: '' };

    const report = await runTest(
      makeInstance(['[use computer]']),
      config,
      '',
      extras({ checkVisionRoute: check }),
    );

    expect(report.status).toBe('passed');
    expect(check).not.toHaveBeenCalled();
  });
});

describe('a [use …] line in a hook is refused (§4.4)', () => {
  it('fails the hook rather than switching surface underneath the test', async () => {
    resolveHooksMock.mockResolvedValue({
      before: ['[use computer]'],
      beforeEach: [],
      afterEach: [],
      after: [],
      hasAny: true,
      toolCalls: { before: [null], beforeEach: [], afterEach: [], after: [] },
      sourceSkills: { before: [null], beforeEach: [], afterEach: [], after: [] },
    });

    const report = await runTest(
      makeInstance(['Click the heading']),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('failed');
    const hookRow = report.steps.find((s) => s.hookScope === 'before');
    expect(hookRow).toBeDefined();
    expect(hookRow!.error).toContain('a hook runs on the page surface');
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.5 — a skill restores the caller's surface, a section does not
// ---------------------------------------------------------------------------

/** Frames for a test whose step 2 is a one-step skill body. */
function skillExpansion(steps: string[], bodyIndexes: number[], kind: 'skill' | 'section'): ParsedTest['expansion'] {
  const frames: Record<string, ExpandedFrame> = {
    f1: { id: 'f1', parentId: null, kind, uri: '/tmp/x', invocationLine: 2, skillName: 'excursion' },
  };
  const origins: ExpandedStepOrigin[] = steps.map((_, i) => ({
    inputIndex: i,
    frameId: bodyIndexes.includes(i) ? 'f1' : '',
  }));
  return { rawSteps: [...steps], origins, frames, controls: steps.map(() => null) };
}

describe('a skill call restores the caller\'s surface (acceptance 6)', () => {
  it('a browser caller is back on the browser after a skill that switched', async () => {
    const steps = ['Click the heading', '[use computer]', 'Press Ctrl+S', 'Click the footer'];
    const report = await runTest(
      makeInstance(steps, {}, skillExpansion(steps, [1, 2], 'skill')),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('passed');
    // Step 3 ran in the skill body, on the computer; step 4 is the caller's
    // and must be back on the page.
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock).toHaveBeenCalledTimes(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a COMPUTER caller is back on the computer after a skill that went to the browser', async () => {
    // Review finding: this restore was a no-op, and step 4 went to the page.
    const holders: Array<string | undefined> = [];
    executeComputerStepMock.mockImplementation(async (_i: number, _n: number, instruction: string) => {
      holders.push(readComputerLock({ lockPath })?.sessionId);
      return passingResult(instruction, 'computer');
    });
    let loads = 0;
    const steps = ['[use computer]', '[use browser]', 'Click the heading', 'Click Save in the dialog'];

    const report = await runTest(
      makeInstance(steps, {}, skillExpansion(steps, [1, 2], 'skill')),
      makeConfig(),
      '',
      extras({
        loadDesktopAdapter: async () => {
          loads++;
          return adapter;
        },
      }),
    );

    expect(report.status).toBe('passed');
    expect(executeStepMock.mock.calls.map((c) => c[2])).toEqual(['Click the heading']);
    expect(executeComputerStepMock.mock.calls.map((c) => c[2])).toEqual(['Click Save in the dialog']);
    // Re-entered through `enterComputerMode`: §5.1 again, lock included.
    expect(loads).toBe(2);
    expect(holders).toEqual(['cli:/tmp/computer-mode-test.md']);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a failed re-entry fails the step it was restoring for, with the enter error', async () => {
    executeStepMock.mockImplementationOnce(async (_i: number, _n: number, instruction: string) => {
      acquireComputerLock('mcp:another-session', { lockPath });
      return passingResult(instruction);
    });
    const steps = ['[use computer]', '[use browser]', 'Click the heading', 'Click Save in the dialog'];

    const report = await runTest(
      makeInstance(steps, {}, skillExpansion(steps, [1, 2], 'skill')),
      makeConfig(),
      '',
      extras(),
    );

    const inUse = computerLockInUseMessage({ pid: process.pid, sessionId: 'mcp:another-session', since: '' });
    expect(report.status).toBe('failed');
    expect(report.steps).toHaveLength(4);
    expect(report.steps[3]!.status).toBe('failed');
    expect(report.steps[3]!.error).toContain(inUse);
    expect(report.steps[3]!.error).toContain('returned from a skill');
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(executeStepMock).toHaveBeenCalledTimes(1);
    expect(readComputerLock({ lockPath })!.sessionId).toBe('mcp:another-session');
  });

  it('an inline SECTION does not restore — that is how a desktop excursion is written once', async () => {
    const steps = ['Click the heading', '[use computer]', 'Press Ctrl+S', 'Click the dialog'];
    const report = await runTest(
      makeInstance(steps, {}, skillExpansion(steps, [1, 2], 'section')),
      makeConfig(),
      '',
      extras(),
    );

    expect(report.status).toBe('passed');
    // Step 4 is OUTSIDE the section and still on the computer surface.
    expect(executeComputerStepMock).toHaveBeenCalledTimes(2);
    expect(executeStepMock).toHaveBeenCalledTimes(1);
  });
});

describe('SkillSurfaceStack — the shared push/pop both loops use', () => {
  it('answers the surface in force when the skill was entered', () => {
    const stack = new SkillSurfaceStack();

    expect(stack.enter([], 'browser')).toBeNull();        // caller, on the page
    expect(stack.enter(['f1'], 'browser')).toBeNull();    // into the skill
    expect(stack.enter(['f1'], 'computer')).toBeNull();   // the skill switched
    expect(stack.enter([], 'computer')).toBe('browser');  // back out
  });

  it('asks nothing of a caller already on the surface it called from', () => {
    const stack = new SkillSurfaceStack();

    expect(stack.enter(['f1'], 'computer')).toBeNull();
    expect(stack.enter([], 'computer')).toBeNull();
  });

  it('answers computer for a computer caller whose skill went to the browser', () => {
    const stack = new SkillSurfaceStack();

    expect(stack.enter(['f1'], 'computer')).toBeNull();
    expect(stack.enter(['f1'], 'browser')).toBeNull();
    expect(stack.enter([], 'browser')).toBe('computer');
  });

  it('unwinds nested skills to the OUTERMOST caller in one answer', () => {
    const stack = new SkillSurfaceStack();

    expect(stack.enter(['outer'], 'browser')).toBeNull();
    // The outer skill went to the computer, then called the inner one.
    expect(stack.enter(['outer', 'inner'], 'computer')).toBeNull();
    expect(stack.enter(['outer', 'inner'], 'browser')).toBeNull();
    // Out of both at once: the inner caller's `computer` is skipped — it would
    // take the lock and load an adapter only to be left again — and the
    // outermost caller's `browser` is the answer.
    expect(stack.enter([], 'browser')).toBeNull();
  });

  it('a frame entered on the step a restore is for is entered from the restored surface', () => {
    const stack = new SkillSurfaceStack();

    stack.enter(['a'], 'computer');
    stack.enter(['a'], 'browser');
    // Straight from skill A into skill B: the caller goes back to `computer`,
    // and B's caller surface is that one, not the browser A left behind.
    expect(stack.enter(['b'], 'browser')).toBe('computer');
    expect(stack.enter(['b'], 'browser')).toBeNull();
    expect(stack.enter([], 'browser')).toBe('computer');
  });
});

// ---------------------------------------------------------------------------
// §5.4 — a bracket directive nobody dispatched never reaches the model
// ---------------------------------------------------------------------------

describe('an undispatched [tool:] / [skill:] line fails on the CLI computer surface (§5.4)', () => {
  const ACTED_OUT =
    'In computer mode a tool line is never handed to the model, because it would act it out on the real screen.';

  let toolsDir: string;
  beforeEach(() => {
    toolsDir = mkdtempSync(path.join(os.tmpdir(), 'aiui-computer-cli-tools-'));
    writeFileSync(
      path.join(toolsDir, 'echo.ts'),
      "export default { name: 'echo', description: 'echo', parameters: {}, run() {} };\n",
    );
  });
  afterEach(() => {
    rmSync(toolsDir, { recursive: true, force: true });
  });

  function configWithTools(): Config {
    const config = makeConfig();
    return { ...config, tests: { ...config.tests, toolsDir } };
  }

  it('a [tool:] line the parse did not dispatch fails, and neither executor is called', async () => {
    // `makeInstance` leaves `toolCalls` null — the shape of a `test` whose
    // builder dropped the dispatch, which is the only way this runner (which
    // always loads a catalogue) reaches the computer branch with a tool line.
    const report = await runTest(
      makeInstance(['[use computer]', '[tool: open_calculator]', 'Click equals']),
      configWithTools(),
      '',
      extras(),
    );

    expect(report.status).toBe('failed');
    expect(report.steps[1]!.status).toBe('failed');
    expect(report.steps[1]!.error).toBe(
      `[tool: open_calculator] was not run: the runner did not dispatch it as a tool call. ${ACTED_OUT}`,
    );
    expect(report.steps[1]!.surface).toBe('computer');
    expect(report.steps[1]!.turns).toHaveLength(0);
    expect(report.steps).toHaveLength(2);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  it('an unknown tool name fails with the catalogue\'s message — even with no browser open', async () => {
    const instance = makeInstance(['[use computer]', '[tool: open_calculator]']);
    instance.test.toolCalls = [null, parseToolCall('[tool: open_calculator]')];

    const report = await runTest(instance, configWithTools(), '', extras());

    expect(report.status).toBe('failed');
    expect(report.steps[1]!.error).toContain('Tool "open_calculator" not found in catalogue.');
    expect(executeComputerStepMock).not.toHaveBeenCalled();
    expect(launchBrowserMock).not.toHaveBeenCalled();
  });

  it('a raw [skill:] line fails the same way', async () => {
    const report = await runTest(
      makeInstance(['[use computer]', '[skill: open-calculator]']),
      configWithTools(),
      '',
      extras(),
    );

    expect(report.status).toBe('failed');
    expect(report.steps[1]!.error).toContain(
      '[skill: open-calculator] was not run: skills are expanded into their steps before the run starts',
    );
    expect(report.steps[1]!.error).toContain('In computer mode a skill line is never handed to the model');
    expect(executeComputerStepMock).not.toHaveBeenCalled();
  });

  it('a [tool:] line on the computer surface takes the lock: after a pause another session holds it, and the tool never runs', async () => {
    // A tool that registers, and says whether it ran and who held the lock.
    const markerPath = path.join(toolsDir, 'ran.txt');
    const toolsIndex = path.resolve(__dirname, '..', 'src', 'tools', 'index.ts').replace(/\\/g, '/');
    writeFileSync(
      path.join(toolsDir, 'launch.ts'),
      `import { defineTool } from '${toolsIndex}';\n` +
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n" +
        "export default defineTool({ name: 'launch', description: 'launch', parameters: {}, outputs: {},\n" +
        '  async run() {\n' +
        `    const lock = ${JSON.stringify(lockPath)};\n` +
        `    writeFileSync(${JSON.stringify(markerPath)}, ` +
        "existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')).sessionId : 'none');\n" +
        '  } });\n',
    );
    questionMock.mockImplementation(async () => {
      acquireComputerLock('mcp:another-session', { lockPath });
      return 'x';
    });
    const instance = makeInstance(['[use computer]', '[input: note] Anything?', '[tool: launch]']);
    instance.test.toolCalls = [null, null, parseToolCall('[tool: launch]')];

    const report = await runTest(instance, configWithTools(), '', extras());

    expect(report.status).toBe('failed');
    expect(report.steps[2]!.error).toBe(
      computerLockInUseMessage({ pid: process.pid, sessionId: 'mcp:another-session', since: '' }),
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it('the page surface is unchanged: an undispatched tool line still goes to executeStep', async () => {
    const report = await runTest(
      makeInstance(['[tool: open_calculator]']),
      configWithTools(),
      '',
      extras(),
    );

    expect(report.status).toBe('passed');
    expect(executeStepMock).toHaveBeenCalledTimes(1);
    expect(executeComputerStepMock).not.toHaveBeenCalled();
  });
});
