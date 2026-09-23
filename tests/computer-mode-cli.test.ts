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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestConfig, TestInstance } from '../src/parser/types.js';
import type { StepResult } from '../src/report/types.js';
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

vi.mock('../src/cache/step-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cache/step-cache.js')>()),
  StepCache: {
    initialize: async () => ({
      read: () => null,
      write: vi.fn(),
      readAssertion: () => null,
      invalidateStep: vi.fn(),
    }),
  },
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

import { runTest, type RunTestExtras } from '../src/runner/test-runner.js';
import { FakeDesktopAdapter } from '../src/desktop/fake-adapter.js';
import { readComputerLock } from '../src/desktop/lock.js';
import { COMPUTER_DISABLED_MESSAGE, SkillSurfaceStack } from '../src/runner/computer-step.js';

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
      undefined,
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
      undefined,
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

    await runTest(makeInstance(['[use computer]', 'Click']), makeConfig(), '', undefined, extras());

    expect(heldDuringStep).toBe('cli:/tmp/computer-mode-test.md');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('§5.1 refusals on the CLI path', () => {
  it('desktop.enabled: false fails the step and leaves the surface alone (acceptance 7)', async () => {
    const report = await runTest(
      makeInstance(['[use computer]', 'Click Save']),
      makeConfig({ enabled: false }),
      '',
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
      extras(),
    );

    expect(report.status).toBe('passed');
    // Step 3 ran in the skill body, on the computer; step 4 is the caller's
    // and must be back on the page.
    expect(executeComputerStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock).toHaveBeenCalledTimes(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('an inline SECTION does not restore — that is how a desktop excursion is written once', async () => {
    const steps = ['Click the heading', '[use computer]', 'Press Ctrl+S', 'Click the dialog'];
    const report = await runTest(
      makeInstance(steps, {}, skillExpansion(steps, [1, 2], 'section')),
      makeConfig(),
      '',
      undefined,
      extras(),
    );

    expect(report.status).toBe('passed');
    // Step 4 is OUTSIDE the section and still on the computer surface.
    expect(executeComputerStepMock).toHaveBeenCalledTimes(2);
    expect(executeStepMock).toHaveBeenCalledTimes(1);
  });
});

describe('SkillSurfaceStack — the shared push/pop both loops use', () => {
  it('restores the surface in force when the skill was entered', () => {
    const stack = new SkillSurfaceStack();
    const restored: string[] = [];
    const restore = (to: 'browser' | 'computer'): void => { restored.push(to); };

    stack.enter([], 'browser', restore);       // caller, on the page
    stack.enter(['f1'], 'browser', restore);   // into the skill
    stack.enter(['f1'], 'computer', restore);  // the skill switched
    stack.enter([], 'computer', restore);      // back out

    expect(restored).toEqual(['browser']);
  });

  it('leaves a caller that was ALREADY in computer mode where it was', () => {
    const stack = new SkillSurfaceStack();
    const restored: string[] = [];
    const restore = (to: 'browser' | 'computer'): void => { restored.push(to); };

    stack.enter(['f1'], 'computer', restore);
    stack.enter([], 'computer', restore);

    expect(restored).toEqual([]);
  });

  it('unwinds nested skills innermost first', () => {
    const stack = new SkillSurfaceStack();
    const restored: string[] = [];
    const restore = (to: 'browser' | 'computer'): void => { restored.push(to); };

    stack.enter(['outer'], 'browser', restore);
    stack.enter(['outer', 'inner'], 'browser', restore);
    stack.enter(['outer', 'inner'], 'computer', restore);
    stack.enter([], 'computer', restore);

    // One restore, not two: the inner frame's caller was the outer frame, and
    // both were entered on the browser.
    expect(restored).toEqual(['browser']);
  });
});
