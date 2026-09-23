/**
 * A new run starts on the surface its file says, over HTTP
 * (SPEC-use-computer.md §4.5, `StepRequest.runStart`).
 *
 * The defect: TestBench reuses one server session per test file, and MCP's
 * `run_test_file` reuses `mcp:<path>`. The session's surface outlived the
 * batch — as it must, or a Continue after a breakpoint inside a desktop
 * excursion would land on the browser — and so a run that FAILED or was
 * stopped between `[use computer]` and `[use browser]` handed the next run the
 * computer surface: its "Navigate to statement.pdf" went to the real mouse and
 * keyboard, with VS Code in front.
 *
 * Every test POSTs through the real `node:http` entry, because `api-server.ts`
 * builds `StepRequest` from a per-field allow-list and a field it does not
 * name is dropped silently — a session-manager test would pass against a
 * server that never sees `runStart`. The project bundle is real too (a temp
 * project whose own `aiui.config.json` opts in), so `desktop.enabled` is read
 * the way a real run reads it. The desktop seams are injected through
 * `createApiServer` — `FakeDesktopAdapter` and a lock file in this test's own
 * temp directory — so nothing here loads nut.js, moves the mouse, or touches
 * the machine's real `aiui-computer.lock`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (the computer-mode-session.test.ts wall, behind the HTTP entry) ──

const mockPage = {
  url: vi.fn(() => 'http://localhost:8787/statement.pdf'),
  title: vi.fn(async () => 'statement.pdf'),
  goto: vi.fn(async () => null),
  video: vi.fn(() => null),
};
const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: { getActive: vi.fn(() => mockPage as any), activeTabRef: vi.fn(async () => null) },
};
const launchBrowserMock = vi.fn(async (..._args: unknown[]) => ({ ...mockBrowserSession }));

vi.mock('../src/browser/manager.js', () => {
  class NoBrowserLaunchedError extends Error {
    constructor(message = 'no browser has been launched in this session') {
      super(message);
      this.name = 'NoBrowserLaunchedError';
    }
  }
  class BrowserTracker {
    sessions: { label: string; session: any }[] = [];
    launch: (() => Promise<any>) | undefined;
    launched = false;
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker();
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched(): Promise<any> {
      if (this.launched) return this.getActive();
      const session = await this.launch!();
      this.sessions.push({ label: 'default', session });
      this.launched = true;
      return session;
    }
    hasActive(): boolean { return this.sessions.length > 0; }
    isLaunched(): boolean { return this.launched; }
    getActive(): any {
      const entry = this.sessions[this.sessions.length - 1];
      if (!entry) throw new NoBrowserLaunchedError();
      return entry.session;
    }
    getActivePage(): any { return this.getActive().pageTracker.getActive(); }
    getActiveLabel(): string { return 'default'; }
    all(): any[] { return this.sessions.map((s) => s.session); }
    list(): any[] { return []; }
    add(label: string, session: any): void { this.sessions.push({ label, session }); }
    closeAll = vi.fn(async () => { this.sessions.length = 0; });
    get count(): number { return this.sessions.length; }
  }
  return {
    launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
    closeBrowser: vi.fn(async () => {}),
    PageTracker: vi.fn(),
    BrowserTracker,
    NoBrowserLaunchedError,
    NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

/**
 * Which surface answered each step, in order — the one observable that says
 * whether a step would have gone to the page or to the real mouse. Each entry
 * also records who held the machine lock at that moment.
 */
const ran: Array<{ surface: 'browser' | 'computer'; instruction: string; lockHolder: string | undefined }> = [];
/** Instructions the computer step mock fails, standing in for a desktop step
 *  that could not find its button. */
const failOnComputer = new Set<string>();
let lockPath = '';

vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  executeStep: vi.fn(async (index: number, _n: number, instruction: string): Promise<StepResult> => {
    const { readComputerLock } = await import('../src/desktop/lock.js');
    ran.push({ surface: 'browser', instruction, lockHolder: readComputerLock({ lockPath })?.sessionId });
    return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false, aiExplanation: 'ok' };
  }),
  executeBranchedStep: vi.fn(async (): Promise<StepResult[]> => []),
}));

vi.mock('../src/runner/computer-step.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/computer-step.js')>()),
  executeComputerStep: vi.fn(async (index: number, _n: number, instruction: string): Promise<StepResult> => {
    const { readComputerLock } = await import('../src/desktop/lock.js');
    ran.push({ surface: 'computer', instruction, lockHolder: readComputerLock({ lockPath })?.sessionId });
    const failed = failOnComputer.has(instruction);
    return {
      index,
      instruction,
      status: failed ? 'failed' : 'passed',
      surface: 'computer',
      turns: [],
      durationMs: 1,
      retried: false,
      ...(failed ? { error: 'no Cancel button on the screen' } : { aiExplanation: 'computer step ok' }),
    };
  }),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    config: any;
    chat = vi.fn(async () => '{}');
    complete = vi.fn(async () => ({ text: '{}', model: 'fake' }));
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    constructor(config: any) { this.config = config; }
  },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    resetStep = vi.fn();
    markRunStart = vi.fn();
    total = 0; inputTotal = 0; outputTotal = 0;
    runTotal = 0; runInputTotal = 0; runOutputTotal = 0;
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class { store = vi.fn(); getHistory = vi.fn(() => []); },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
  videoBaseNameFor: vi.fn(() => 'video'),
  countStepOrigins: vi.fn(() => ({})),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fake' })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(),
    success: vi.fn(), step: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}), addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false), shouldEmit: vi.fn(() => false),
  setLogLevel: vi.fn(), getLogLevel: vi.fn(() => 'info'),
  traceOp: async (_name: string, fn: () => unknown) => fn(),
}));

import { createApiServer } from '../src/server/api-server.js';
import type { SessionManager } from '../src/server/session-manager.js';
import { FakeDesktopAdapter } from '../src/desktop/fake-adapter.js';
import { readComputerLock } from '../src/desktop/lock.js';
import { logger } from '../src/utils/logger.js';

// ── Server + project ─────────────────────────────────────────────────────

const API_KEY = 'sk-computer-run-start';
const cfg = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 0, screenshotOnFailure: false, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  // The SERVER's own config does not opt in: the project's must, which is
  // the per-project read §5.1 item 1 requires.
  desktop: { enabled: false, maxImageWidth: 400, settleMs: 0, reportScreenshots: true },
} as unknown as Config;

let server: Server;
let baseUrl: string;
let sessionManager: SessionManager;
let tmpDir: string;
/** A project that opts in. */
let testFile: string;
/** A project whose `desktop.enabled` is the STRING "false". */
let stringFalseTestFile: string;
const loadDesktopAdapter = vi.fn(async () => new FakeDesktopAdapter({ width: 200, height: 150 }));

function project(name: string, config: Record<string, unknown>): string {
  const dir = path.join(tmpDir, name);
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'aiui.config.json'), JSON.stringify(config, null, 2));
  const file = path.join(dir, 'tests', 'pdf-print-cancel.md');
  writeFileSync(file, '# placeholder — the server never reads the test file\n');
  return file;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'computer-run-start-'));
  lockPath = path.join(tmpDir, 'aiui-computer.lock');
  testFile = project('opted-in', {
    desktop: { enabled: true, maxImageWidth: 400, settleMs: 0 },
    reports: { outputDir: './reports' },
  });
  stringFalseTestFile = project('string-false', {
    desktop: { enabled: 'false' },
    reports: { outputDir: './reports' },
  });
  const app = createApiServer(cfg, undefined, undefined, {
    loadDesktopAdapter,
    probeComputerCapture: async () => {},
    computerLock: { lockPath },
  });
  sessionManager = app.sessionManager;
  server = createServer(app.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  ran.length = 0;
  failOnComputer.clear();
  loadDesktopAdapter.mockClear();
  launchBrowserMock.mockClear();
  (logger.warn as unknown as { mockClear: () => void }).mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** `pdf-print-cancel.md`'s steps, as TestBench's `fullSteps` carries them. */
const FILE_STEPS = [
  'Navigate to statement.pdf',
  '[use computer]',
  'Click the Cancel button in the Print dialog',
  '[use browser]',
  'Verify the page URL ends with statement.pdf',
];
/** 1-based document lines of each step, as a client sends `sourceLines`. */
const FILE_LINES = [10, 11, 12, 13, 14];

let sessionSeq = 0;
const newSessionId = (): string => `${testFile}#run-start-${++sessionSeq}`;

const headers = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

/** POST one batch — the slice `[from, to)` of the file — and collect its events. */
async function batch(
  sessionId: string,
  opts: { from?: number; to?: number; runStart?: unknown; file?: string } = {},
): Promise<Array<{ type: string; [k: string]: any }>> {
  const from = opts.from ?? 0;
  const to = opts.to ?? FILE_STEPS.length;
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`, {
    method: 'POST',
    headers: { ...headers, Accept: 'text/event-stream' },
    body: JSON.stringify({
      steps: FILE_STEPS.slice(from, to),
      fullSteps: FILE_STEPS,
      sourceLines: FILE_LINES.slice(from, to),
      testFilePath: opts.file ?? testFile,
      ...(opts.runStart !== undefined && { runStart: opts.runStart }),
    }),
  });
  const text = await res.text();
  return text
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)));
}

async function surfaceOf(sessionId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, { headers });
  return ((await res.json()) as { surface: string }).surface;
}

/** A session left where the defect started: a run that failed inside the
 *  desktop excursion, before its `[use browser]`. */
async function failedInsideComputerMode(sessionId: string): Promise<void> {
  failOnComputer.add('Click the Cancel button in the Print dialog');
  const events = await batch(sessionId, { runStart: { stepIndex: 0 } });
  expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  failOnComputer.clear();
  expect(await surfaceOf(sessionId)).toBe('computer');
  ran.length = 0;
  loadDesktopAdapter.mockClear();
}

// ── A fresh run from step 1 ──────────────────────────────────────────────

describe('a run from step 1 after a run that failed in computer mode', () => {
  it('starts on the browser surface: step 1 goes to the page, not to the mouse', async () => {
    const sessionId = newSessionId();
    await failedInsideComputerMode(sessionId);

    const events = await batch(sessionId, { runStart: { stepIndex: 0 } });

    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(ran[0]).toMatchObject({ surface: 'browser', instruction: 'Navigate to statement.pdf' });
    // And the rest of the file ran as written: into computer mode and back.
    expect(ran.map((r) => `${r.surface}:${r.instruction}`)).toEqual([
      'browser:Navigate to statement.pdf',
      'computer:Click the Cancel button in the Print dialog',
      'browser:Verify the page URL ends with statement.pdf',
    ]);
    // The reset dropped the adapter, so the fresh run's [use computer] loaded
    // one again through the full §5.1 entry rather than re-entering.
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
  });

  it('holds no machine lock on the browser surface, and none once the run ends', async () => {
    const sessionId = newSessionId();
    await failedInsideComputerMode(sessionId);

    await batch(sessionId, { runStart: { stepIndex: 0 } });

    expect(ran[0]!.lockHolder).toBeUndefined();
    // …the computer step in the middle did hold it — this session, lazily…
    expect(ran[1]!.lockHolder).toContain(sessionId);
    // …and the run gave it back.
    expect(readComputerLock({ lockPath })).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('WITHOUT runStart (an older client) the defect is what it was: step 1 goes to the computer surface', async () => {
    // Pinned so the contract is legible: absence means "continue", which is
    // what keeps flick and a Continue working — and what the field fixes.
    const sessionId = newSessionId();
    await failedInsideComputerMode(sessionId);

    await batch(sessionId);

    expect(ran[0]).toMatchObject({ surface: 'computer', instruction: 'Navigate to statement.pdf' });
  });
});

// ── A continuation keeps the surface ─────────────────────────────────────

describe('a continuation batch keeps the computer surface', () => {
  it('Continue after a breakpoint inside the excursion answers the next step on the computer surface', async () => {
    const sessionId = newSessionId();
    // Batch 1: the client cut the run at a breakpoint on step 3, inside the
    // desktop excursion (the first block of a fresh run carries runStart).
    const first = await batch(sessionId, { to: 2, runStart: { stepIndex: 0 } });
    expect(first.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(await surfaceOf(sessionId)).toBe('computer');
    // The batch ended, so the lock was released — the surface was not.
    expect(readComputerLock({ lockPath })).toBeNull();

    // Batch 2: Continue — no runStart.
    ran.length = 0;
    const second = await batch(sessionId, { from: 2 });

    expect(second.at(-1)).toMatchObject({ type: 'done', status: 'passed' });
    expect(ran.map((r) => `${r.surface}:${r.instruction}`)).toEqual([
      'computer:Click the Cancel button in the Print dialog',
      'browser:Verify the page URL ends with statement.pdf',
    ]);
    // Taken again lazily at the step boundary, as §5.9 says.
    expect(ran[0]!.lockHolder).toContain(sessionId);
    // Same adapter: the continuation did not re-enter computer mode.
    expect(loadDesktopAdapter).toHaveBeenCalledTimes(1);
  });
});

// ── A run that starts mid-file ───────────────────────────────────────────

describe('a run that starts mid-file (Run From Here / Run Step Here)', () => {
  it('below [use computer], on a session already there: stays on the computer surface', async () => {
    const sessionId = newSessionId();
    await failedInsideComputerMode(sessionId);

    await batch(sessionId, { from: 2, to: 3, runStart: { stepIndex: 2 } });

    expect(ran).toEqual([
      expect.objectContaining({ surface: 'computer', instruction: 'Click the Cancel button in the Print dialog' }),
    ]);
  });

  it('below [use browser], on a session left on computer: starts on the browser surface', async () => {
    const sessionId = newSessionId();
    await failedInsideComputerMode(sessionId);

    await batch(sessionId, { from: 4, runStart: { stepIndex: 4 } });

    expect(ran).toEqual([
      expect.objectContaining({ surface: 'browser', instruction: 'Verify the page URL ends with statement.pdf' }),
    ]);
    expect(await surfaceOf(sessionId)).toBe('browser');
  });

  it('below [use computer], on a session on the browser: stays on the browser and says which line to run from', async () => {
    // Entering computer mode belongs to the [use computer] step — its §5.1
    // preconditions and its row — so a run starting below one does not do it
    // silently. It runs where the session is, and the log names the line.
    const sessionId = newSessionId();

    await batch(sessionId, { from: 2, to: 3, runStart: { stepIndex: 2 } });

    expect(ran).toEqual([
      expect.objectContaining({ surface: 'browser', instruction: 'Click the Cancel button in the Print dialog' }),
    ]);
    expect(loadDesktopAdapter).not.toHaveBeenCalled();
    const warned = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('Run from step 2 to enter computer mode'))).toBe(true);
  });

  it('with no stepIndex, starts on the browser surface', async () => {
    const sessionId = newSessionId();
    await failedInsideComputerMode(sessionId);

    await batch(sessionId, { from: 2, to: 3, runStart: {} });

    expect(ran[0]).toMatchObject({ surface: 'browser' });
  });
});

// ── The wire ─────────────────────────────────────────────────────────────

describe('runStart on the wire', () => {
  it('refuses a runStart that is not an object', async () => {
    const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(newSessionId())}/steps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ steps: ['Navigate to statement.pdf'], testFilePath: testFile, runStart: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('"runStart" must be an object');
  });

  it('a malformed stepIndex still starts a new run — on the browser surface', async () => {
    const sessionId = newSessionId();
    await failedInsideComputerMode(sessionId);

    await batch(sessionId, { from: 2, to: 3, runStart: { stepIndex: 'three' } });

    expect(ran[0]).toMatchObject({ surface: 'browser' });
  });
});

// ── The opt-in gate (A12) ────────────────────────────────────────────────

describe('desktop.enabled as the STRING "false" does not enable computer mode', () => {
  it('the batch fails with the config error naming the file and the value, and nut.js is never loaded', async () => {
    const events = await batch(`${stringFalseTestFile}#gate`, {
      file: stringFalseTestFile,
      runStart: { stepIndex: 0 },
    });

    expect(loadDesktopAdapter).not.toHaveBeenCalled();
    expect(ran.some((r) => r.surface === 'computer')).toBe(false);
    const error = events.find((e) => e.type === 'output' && e.kind === 'error');
    expect(error?.msg).toContain('Invalid desktop.enabled');
    expect(error?.msg).toContain('the string "false"');
    expect(error?.msg).toContain(path.join(path.dirname(path.dirname(stringFalseTestFile)), 'aiui.config.json'));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'error' });
  });
});
