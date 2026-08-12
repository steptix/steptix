/**
 * `POST /errands` — stories/errands.md, build order step 1 (server half).
 *
 * Every assertion here is about the two things that make an errand an errand
 * rather than a session with a shorter name: it leaves NOTHING on the server
 * (no session, no report, no variable scope), and it leaves the user's browser
 * exactly as it found it (its own tabs closed, everyone else's untouched, the
 * borrowed tab raised on the way out).
 *
 * Driven over real HTTP through the real app, because the route's request
 * builder is an explicit allow-list: widening `ErrandRequest` alone compiles
 * cleanly and drops the field at runtime.
 *
 * The browser is faked at the same seam the other server suites use. The fake
 * `PageTracker` is not a full stand-in and does not try to be — it keeps
 * exactly the two rules the detach path reads, so that "never closes a tab it
 * did not open" is a claim about the errand rather than about the fake:
 *
 *   - pages open at attach time are on the ignore list and are never tracked;
 *   - every page it DOES adopt starts `unexpected` until `markExpected` claims
 *     it, which is what the real `openPage` action calls.
 *
 * Everything else about it (labels, the active index, target-id resolution) is
 * a convenience, and no assertion here rests on it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// A fake CDP browser: pages the user already had, plus whatever gets opened.
// ---------------------------------------------------------------------------

interface FakePage {
  targetId: string;
  url: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  bringToFront: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  closed: boolean;
}

function makePage(targetId: string, url: string, title: string): FakePage {
  const closeHandlers: (() => void)[] = [];
  const page: FakePage = {
    targetId,
    url: vi.fn(() => url),
    title: vi.fn(async () => title),
    // A real page tells its tracker when it goes, and the tracker forgets it —
    // which is the whole reason the receipt cannot be assembled from what is
    // still tracked at the detach.
    close: vi.fn(async () => {
      page.closed = true;
      for (const handler of [...closeHandlers]) handler();
    }),
    bringToFront: vi.fn(async () => {}),
    goto: vi.fn(async () => null),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    }),
    closed: false,
  };
  return page;
}

/** The user's running browser. Rebuilt per test. */
const cdpBrowser: { port: number; pages: FakePage[] } = { port: 51000, pages: [] };
let borrowedPage: FakePage;
let neighbourPage: FakePage;

/** The session `launchBrowser` handed back for the most recent CDP attach. */
let lastBorrowed: any;

const mockLaunchedPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example Page'),
  goto: vi.fn(async () => null),
};

vi.mock('../src/browser/manager.js', () => {
  /**
   * Mirrors the real tracker's two load-bearing rules, and nothing else.
   *
   *  1. A page on the ignore list (every tab open when the attach happened) is
   *     never tracked at all.
   *  2. Every page it DOES adopt starts `unexpected: true`, cleared only by
   *     `markExpected` — which is what the real `openPage` action calls once
   *     `context.newPage()` resolves (step-executor.ts:869). A tab that appears
   *     with nobody claiming it that way is somebody else's.
   *  3. A page that closes is dropped (manager.ts:331), so a tab a step opened
   *     and later closed is not in `tabs()` by the time the detach looks.
   */
  class PageTracker {
    pages: { page: any; label: string; targetId: string | null; openedAt: number; unexpected: boolean }[] = [];
    activeIndex = 0;
    private ignored: Set<any>;
    constructor(initialPage: any, ignoredPages?: Set<any>) {
      this.pages.push({
        page: initialPage,
        label: 'main',
        targetId: initialPage.targetId ?? null,
        openedAt: Date.now(),
        unexpected: false,
      });
      this.ignored = ignoredPages ?? new Set();
    }
    addPage(page: any): string | null {
      if (this.ignored.has(page)) return null;
      const label = `page:${this.pages.length + 1}`;
      this.pages.push({
        page,
        label,
        targetId: page.targetId ?? null,
        openedAt: Date.now(),
        unexpected: true,
      });
      page.on?.('close', () => {
        const idx = this.pages.findIndex((p) => p.page === page);
        if (idx === -1) return;
        const wasActive = this.activeIndex === idx;
        this.pages.splice(idx, 1);
        if (wasActive) this.activeIndex = 0;
        else if (this.activeIndex > idx) this.activeIndex--;
      });
      return label;
    }
    markExpected(page: any): void {
      const entry = this.pages.find((p) => p.page === page);
      if (entry) entry.unexpected = false;
    }
    tabs() {
      return this.pages;
    }
    getActive() {
      return (this.pages[this.activeIndex] ?? this.pages[0])!.page;
    }
    async describeActiveTab() {
      const entry = this.pages[this.activeIndex] ?? this.pages[0];
      if (!entry) return null;
      return {
        label: entry.label,
        targetId: entry.targetId,
        url: entry.page.url(),
        title: await entry.page.title(),
        unexpected: entry.unexpected,
      };
    }
    async resolvedTargetIds() {
      return { ids: this.pages.map((p) => p.targetId).filter((id): id is string => !!id), complete: true };
    }
    async activeTabRef() {
      const entry = this.pages[this.activeIndex] ?? this.pages[0];
      return entry ? { targetId: entry.targetId, url: entry.page.url() } : null;
    }
  }

  class BrowserTracker {
    sessions: { label: string; session: any }[] = [];
    activeIndex = 0;
    constructor(initialSession: any, initialLabel = 'default') {
      this.sessions.push({ label: initialLabel, session: initialSession });
    }
    add(label: string, session: any): void {
      this.sessions.push({ label, session });
      this.activeIndex = this.sessions.length - 1;
    }
    all() {
      return this.sessions.map((s) => s.session);
    }
    getActive() {
      const entry = this.sessions[this.activeIndex];
      if (!entry) throw new Error('no active browser session');
      return entry.session;
    }
    getActivePage() {
      return this.getActive().pageTracker.getActive();
    }
    closeAll = vi.fn(async () => {
      this.sessions.length = 0;
    });
    get count() {
      return this.sessions.length;
    }
  }

  return {
    PageTracker,
    BrowserTracker,
    launchBrowser: vi.fn(async (_config: unknown, cdp?: { port: number; tab?: string }) => {
      if (!cdp) {
        // Ordinary launch — the session path, used only by this file's control.
        const tracker = new PageTracker(mockLaunchedPage);
        return {
          browser: { isConnected: () => true },
          context: {},
          page: mockLaunchedPage,
          pageTracker: tracker,
        };
      }
      const targetId = String(cdp.tab ?? '').replace(/^targetId:/, '');
      const page = cdpBrowser.pages.find((p) => p.targetId === targetId && !p.closed);
      if (!page) {
        // The real path's refusal, verbatim in shape: a tab that vanished
        // between the listing and the attach is named, not silently swapped.
        throw new Error(`CDP: no tab matches targetId "${targetId}".`);
      }
      const preExisting = new Set<any>(cdpBrowser.pages);
      preExisting.delete(page);
      lastBorrowed = {
        browser: { isConnected: () => true },
        context: {},
        page,
        pageTracker: new PageTracker(page, preExisting),
        cdp: true,
        // A `targetId:` attach never opens a tab, so the borrowed one is never
        // the attach's to close.
        cdpTabOpenedByUs: false,
        headed: true,
      };
      return lastBorrowed;
    }),
    // Faithful to the real one: severs the connection, and closes a tab only
    // when the ATTACH opened it.
    closeBrowser: vi.fn(async (session: any) => {
      if (session.cdp) {
        if (session.cdpTabOpenedByUs) await session.page.close();
        return;
      }
      await session.context?.close?.();
    }),
    // Real behaviour, not a stub: a mock that resolved instantly would hide a hang.
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (): Promise<StepResult> => ({
    index: 1,
    instruction: 'mock step',
    status: 'passed',
    turns: [],
    durationMs: 10,
    retried: false,
    aiExplanation: 'Did the thing',
  })),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    chat = vi.fn(async () => '{}');
    syncAuth = vi.fn(() => null);
  },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    resetStep = vi.fn();
    markRunStart = vi.fn();
    get total() { return 0; }
    get inputTotal() { return 0; }
    get outputTotal() { return 0; }
    get runTotal() { return 0; }
    get runInputTotal() { return 0; }
    get runOutputTotal() { return 0; }
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class {
    store = vi.fn();
    getHistory = vi.fn(() => []);
  },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fakeBase64' })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApiServer } from '../src/server/api-server.js';
import { ErrandRunner } from '../src/server/errand-runner.js';
import { ErrandLocks } from '../src/server/errand-locks.js';
import { ProjectBundleResolver } from '../src/server/project-bundle.js';
import type { SessionManager, SessionTabHolder } from '../src/server/session-manager.js';
import { executeStep as executeStepMock } from '../src/runner/step-executor.js';
import { closeBrowser as closeBrowserMock, launchBrowser as launchBrowserMock } from '../src/browser/manager.js';
import { generateReport as generateReportMock } from '../src/report/generator.js';

const defaultStepImpl = vi.mocked(executeStepMock).getMockImplementation()!;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'errand-api-key';

const testConfig: Config = {
  ai: {
    gatewayUrl: 'https://ai.test',
    model: 'server-model',
    maxInputTokens: 1000,
    streamResponses: false,
    sendScreenshots: false,
  },
  browser: {
    headed: false,
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1280, height: 720 },
    slowMo: 0,
    browser: 'chromium',
    fullPageScreenshots: false,
  },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: {
    timeout: 30_000,
    retries: 1,
    screenshotOnFailure: true,
    promptOnAmbiguity: false,
    maxTurns: 5,
  },
  reports: {
    outputDir: './reports',
    includeScreenshots: true,
    includeDomSnapshots: true,
    includeAiReasoning: true,
    embedScreenshots: true,
  },
  api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let projectRoot: string;
const requestShutdown = vi.fn<(force: boolean) => void>();

/** Absolute synthetic test file — the only thing the project root resolves
 *  from, exactly as `run_steps` already does it. */
function errandFilePath(): string {
  return path.join(projectRoot, '.aiui-errand.md');
}

/** A minimal errand body; every test overrides what it cares about. */
function errandBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: cdpBrowser.port,
    targetId: 'tab-borrowed',
    steps: ['click the export button'],
    testFilePath: errandFilePath(),
    root: projectRoot,
    scope: 'project',
    ...overrides,
  };
}

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => {
    started.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

async function api(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${urlPath}`, init);
  return { status: res.status, body: await res.json() };
}

/** Read SSE frames into {event, data} pairs. */
async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: { event: string; data: any }[] = [];
  let currentEvent = 'message';
  let currentData: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (currentData.length > 0) {
          try {
            events.push({ event: currentEvent, data: JSON.parse(currentData.join('\n')) });
          } catch {
            events.push({ event: currentEvent, data: currentData.join('\n') });
          }
        }
        currentEvent = 'message';
        currentData = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = (colon < 0 ? '' : line.slice(colon + 1)).replace(/^ /, '');
      if (field === 'event') currentEvent = value;
      else if (field === 'data') currentData.push(value);
    }
  }
  return events;
}

/** A step that captures a value the way a real `[output: x]` read does: the
 *  executor writes it into the live parameter map it was handed. */
function stepThatCaptures(name: string, value: string): void {
  vi.mocked(executeStepMock).mockImplementation(async (idx: number, _total, _instruction, opts) => {
    opts.resolvedParameters![name] = value;
    return {
      index: idx as number,
      instruction: 'captured',
      status: 'passed',
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [
            { index: 1, action: { action: 'read', description: 'read it', as: name }, durationMs: 1 },
          ],
        },
      ],
      durationMs: 5,
      retried: false,
      aiExplanation: 'read it',
    };
  });
}

/** Record every instruction string the executor is handed. */
function recordInstructions(): string[] {
  const seen: string[] = [];
  vi.mocked(executeStepMock).mockImplementation(async (idx: number, _total, instruction) => {
    seen.push(instruction as string);
    return {
      index: idx as number,
      instruction: instruction as string,
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
    };
  });
  return seen;
}

// ---------------------------------------------------------------------------

describe('POST /errands', () => {
  /** The real manager behind the routes, for the one assertion HTTP cannot
   *  make: what the tab→session join itself returns. */
  let sessionManager: SessionManager;
  /** The app's own turn-lock registry — the same object the runner holds, so a
   *  test can play the part of a second errand that got there first. */
  let errandLocks: ErrandLocks;

  beforeAll(async () => {
    const created = createApiServer(testConfig, { requestShutdown });
    sessionManager = created.sessionManager;
    errandLocks = created.errandLocks;
    ({ server, baseUrl } = await listenOnRandomPort(created.app));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'aiui-errand-'));
    // `fullPageScreenshots` is the opposite of the server's, so the receipt's
    // `effectiveSettings` can only report it correctly by actually resolving
    // this file — which is the whole reason the errand carries a testFilePath.
    writeFileSync(
      path.join(projectRoot, 'aiui.config.json'),
      JSON.stringify({ tests: { dataDir: 'data' }, browser: { fullPageScreenshots: true } }),
    );

    borrowedPage = makePage('tab-borrowed', 'https://openrouter.ai/activity', 'Activity | OpenRouter');
    neighbourPage = makePage('tab-neighbour', 'https://mail.example/inbox', 'Inbox');
    cdpBrowser.pages = [borrowedPage, neighbourPage];
    lastBorrowed = undefined;

    vi.mocked(closeBrowserMock).mockClear();
    vi.mocked(generateReportMock).mockClear();
    requestShutdown.mockClear();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.mocked(executeStepMock).mockReset();
    vi.mocked(executeStepMock).mockImplementation(defaultStepImpl);
  });

  // -------------------------------------------------------------------------
  // (a) Nothing on the server — but it IS a run
  // -------------------------------------------------------------------------

  it('creates no session, yet counts as a run in flight while it drives', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (markStarted = r));
    vi.mocked(executeStepMock).mockImplementation(async (idx: number) => {
      markStarted();
      await gate;
      return {
        index: idx as number,
        instruction: 'slow',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });

    const before = (await api('GET', '/sessions')).body.sessions.map((s: any) => s.sessionId);

    const errand = api('POST', '/errands', errandBody());
    try {
      await started;

      // An errand IS a run: the idle reaper reads this field, and a server that
      // reaped itself mid-errand would kill work the user is watching.
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.runsInFlight).toBe(1);

      const stop = await api('POST', '/admin/shutdown', {});
      expect(stop.status).toBe(409);
      expect(stop.body.runsInFlight).toBe(1);
      expect(requestShutdown).not.toHaveBeenCalled();
    } finally {
      // A parked errand outlives a failed assertion and keeps its holds, which
      // would fail every later test in this file for the wrong reason.
      release();
    }
    const { status, body } = await errand;
    expect(status).toBe(200);
    expect(body.status).toBe('passed');

    const after = (await api('GET', '/sessions')).body.sessions.map((s: any) => s.sessionId);
    expect(after).toEqual(before);

    const settled = await (await fetch(`${baseUrl}/health`)).json();
    expect(settled.runsInFlight).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (b) The receipt
  // -------------------------------------------------------------------------

  it('returns a receipt naming the errand, the root, the captures and the tab', async () => {
    stepThatCaptures('token', 'abc-123');

    const { status, body } = await api('POST', '/errands', {
      ...errandBody({ steps: ['[output: token] read the API token'] }),
    });

    expect(status).toBe(200);
    // Shape, not width: how many random bytes an id carries is a tuning
    // decision, and pinning it here would fail a change that broke nothing.
    expect(body.errandId).toMatch(/^errand-[0-9a-f]+$/);
    expect(body.status).toBe('passed');
    expect(body.stepsCompleted).toBe(1);
    expect(body.stepsTotal).toBe(1);
    expect(body.error).toBeNull();
    // The per-step text echoes what was SENT, prefix and all.
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      step: '[output: token] read the API token',
      status: 'passed',
      outputs: { token: 'abc-123' },
    });
    expect(body.captures).toEqual({ token: 'abc-123' });
    // Server base → project bundle, with no session layer to hold overrides.
    // `fullPage` came from the project's own aiui.config.json; nothing here can
    // ever read 'session'.
    expect(body.effectiveSettings).toMatchObject({
      model: 'server-model',
      fullPage: true,
      sources: { model: 'server', fullPage: 'project', sendScreenshots: 'server' },
    });
    expect(body.errand).toEqual({
      errandId: body.errandId,
      root: projectRoot,
      scope: 'project',
      finalUrl: 'https://openrouter.ai/activity',
      finalTitle: 'Activity | OpenRouter',
      openedTabs: [],
      keptOpen: [],
    });

    // The attach spec, exactly as it goes to `launchBrowser`. The `targetId:`
    // prefix is what routes `resolveCdpTab` to its exact-match arm, so dropping
    // it hands the tab argument to first-match-wins — the rule cdp-tabs
    // §Locked refuses, and the one thing this suite's fake normalises away.
    expect(vi.mocked(launchBrowserMock)).toHaveBeenLastCalledWith(expect.anything(), {
      port: cdpBrowser.port,
      tab: 'targetId:tab-borrowed',
    });
  });

  it('streams the same events a session does, with the errand on the done frame', async () => {
    stepThatCaptures('order', 'A-9');

    const res = await fetch(`${baseUrl}/errands?stream=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(errandBody({ steps: ['read the order number'] })),
    });
    const events = await readSse(res);

    expect(events.map((e) => e.event)).toEqual([
      'step:start',
      'capture',
      'step:pass',
      'done',
    ]);
    expect(events[1]!.data).toMatchObject({ name: 'order', value: 'A-9', source: 'capture' });
    // Tab attribution rides the step events, as it does for a session.
    expect(events[2]!.data.tab).toMatchObject({ targetId: 'tab-borrowed' });

    const done = events[3]!.data;
    expect(done.status).toBe('passed');
    expect(done.effectiveSettings.model).toBe('server-model');
    expect(done.errand).toMatchObject({
      root: projectRoot,
      scope: 'project',
      finalUrl: 'https://openrouter.ai/activity',
      finalTitle: 'Activity | OpenRouter',
    });
    // No report, ever — not even a path on the wire.
    expect(done.reportPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (c) + (d) The house rules
  // -------------------------------------------------------------------------

  /** A step that opens one tab and one browser, the way the real actions do —
   *  `addPage` then `markExpected`, which is `openPage`'s own order. */
  function stepThatOpensThings(): { opened: FakePage; worker: any } {
    const opened = makePage('tab-opened', 'https://openrouter.ai/export', 'Export');
    const worker = {
      browser: { isConnected: () => true },
      context: { close: vi.fn(async () => {}) },
      page: makePage('worker-main', 'about:blank', ''),
      pageTracker: null as any,
    };
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, _i, opts) => {
      cdpBrowser.pages.push(opened);
      opts.pageTracker!.addPage(opened as any);
      opts.pageTracker!.markExpected(opened as any);
      opts.browserTracker!.add('worker', worker as any);
      return {
        index: idx as number,
        instruction: 'opened things',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });
    return { opened, worker };
  }

  it('takes its coat when it leaves: closes what it opened, never what it borrowed', async () => {
    const { opened, worker } = stepThatOpensThings();

    const { body } = await api('POST', '/errands', errandBody());

    expect(opened.close).toHaveBeenCalled();
    // The borrowed tab and the user's other tab are not the errand's to close.
    expect(borrowedPage.close).not.toHaveBeenCalled();
    expect(neighbourPage.close).not.toHaveBeenCalled();
    // Hand the keys back visibly.
    expect(borrowedPage.bringToFront).toHaveBeenCalled();
    // A browser a step opened goes regardless; the borrowed one is only
    // disconnected — `closeBrowser` never closes a tab the attach did not open.
    expect(vi.mocked(closeBrowserMock).mock.calls.map((c) => c[0])).toEqual([worker, lastBorrowed]);

    expect(body.errand.openedTabs).toEqual([
      { targetId: 'tab-opened', url: 'https://openrouter.ai/export', title: 'Export' },
    ]);
    expect(body.errand.keptOpen).toEqual([]);
  });

  it('keeps its coat on request — but a step-opened BROWSER still goes', async () => {
    const { opened, worker } = stepThatOpensThings();

    const { body } = await api('POST', '/errands', errandBody({ keepOpen: true }));

    expect(opened.close).not.toHaveBeenCalled();
    expect(body.errand.keptOpen).toEqual([
      { targetId: 'tab-opened', url: 'https://openrouter.ai/export', title: 'Export' },
    ]);
    // `keepOpen` spares tabs only (stories/multi-browser.md's teardown rule).
    expect(vi.mocked(closeBrowserMock).mock.calls.map((c) => c[0])).toContain(worker);
    expect(borrowedPage.close).not.toHaveBeenCalled();
    expect(borrowedPage.bringToFront).toHaveBeenCalled();
  });

  it('runs the house rules on the failure path too', async () => {
    const opened = makePage('tab-opened', 'https://openrouter.ai/export', 'Export');
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, _i, opts) => {
      cdpBrowser.pages.push(opened);
      opts.pageTracker!.addPage(opened as any);
      opts.pageTracker!.markExpected(opened as any);
      return {
        index: idx as number,
        instruction: 'failed',
        status: 'failed',
        turns: [],
        durationMs: 1,
        retried: false,
        error: 'the export button was not there',
      };
    });

    const { body } = await api('POST', '/errands', errandBody());

    expect(body.status).toBe('failed');
    expect(body.error).toEqual({ step: 1, message: 'the export button was not there' });
    // The detach path is a `finally`, not a success-path courtesy.
    expect(opened.close).toHaveBeenCalled();
    expect(borrowedPage.close).not.toHaveBeenCalled();
    expect(neighbourPage.close).not.toHaveBeenCalled();
    expect(borrowedPage.bringToFront).toHaveBeenCalled();
    expect(vi.mocked(closeBrowserMock)).toHaveBeenCalledWith(lastBorrowed);
    expect(body.errand.openedTabs).toHaveLength(1);
  });

  it('leaves a tab it opened but no longer HOLDS: the lease decides the close', async () => {
    // The race the lease gate exists for, and the one `unexpected` cannot see.
    // A tab is unlocked between the step that opens it and the sweep that
    // claims it, and it is in the browser's own /json/list the whole time — so
    // a second errand can name it by title and take the wheel first.
    // `claimOpened` then declines to steal it back (correct), and provenance
    // alone would still close a tab E2 is mid-run on. Its control is the
    // sibling above: same step, same tab, no rival hold, and it IS closed.
    const opened = makePage('tab-opened', 'https://openrouter.ai/export', 'Export');
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, _i, opts) => {
      cdpBrowser.pages.push(opened);
      opts.pageTracker!.addPage(opened as any);
      opts.pageTracker!.markExpected(opened as any);
      // E2, arriving inside that window, on the app's own registry.
      errandLocks.acquire(cdpBrowser.port, 'tab-opened', {
        errandId: 'errand-second',
        tabRole: 'borrowed',
      });
      return {
        index: idx as number,
        instruction: 'opened it',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });

    let body;
    try {
      ({ body } = await api('POST', '/errands', errandBody()));
    } finally {
      // A stray hold would refuse every later errand on that tab.
      errandLocks.release('errand-second');
    }

    expect(body.status).toBe('passed');
    expect(opened.close).not.toHaveBeenCalled();
    // Nor claimed in the receipt: E1 never held it, so it is not E1's to report
    // as one of its own.
    expect(body.errand.openedTabs).toEqual([]);
    expect(body.errand.keptOpen).toEqual([]);
    expect(borrowedPage.close).not.toHaveBeenCalled();
  });

  it('names a tab it opened and then CLOSED — survivors are the smaller list', async () => {
    // `openedTabs` is documented as every tab the errand opened "whether or not
    // it survived" (src/mcp/schemas.ts, `ErrandSummary`), and the tracker drops
    // a page the moment it closes — so a detach that walks what is still
    // tracked can only report survivors. `keep_open` is what tells the two
    // lists apart here: a surviving tab would be in BOTH.
    const opened = makePage('tab-opened', 'https://openrouter.ai/export', 'Export');
    let step = 0;
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, _i, opts) => {
      if (step++ === 0) {
        cdpBrowser.pages.push(opened);
        opts.pageTracker!.addPage(opened as any);
        opts.pageTracker!.markExpected(opened as any);
      } else {
        await opened.close();
      }
      return {
        index: idx as number,
        instruction: 'ran',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });

    const { body } = await api(
      'POST',
      '/errands',
      errandBody({ steps: ['open the export tab', 'close the export tab'], keepOpen: true }),
    );

    expect(body.status).toBe('passed');
    expect(body.errand.openedTabs).toEqual([
      { targetId: 'tab-opened', url: 'https://openrouter.ai/export', title: 'Export' },
    ]);
    expect(body.errand.keptOpen).toEqual([]);
  });

  it('hands the tab back even when a tab it opened refuses to close', async () => {
    // The detach runs inside a `finally`, so anything it lets throw replaces
    // the answer the caller was already sending: measured without the per-tab
    // guard, this request is a 500 with no errand block at all — about a tab
    // the errand has already driven.
    const { opened } = stepThatOpensThings();
    opened.close.mockImplementation(async () => {
      throw new Error('the tab refused to close');
    });

    const { status, body } = await api('POST', '/errands', errandBody());

    expect(status).toBe(200);
    expect(body.errand).toMatchObject({
      errandId: body.errandId,
      finalUrl: 'https://openrouter.ai/activity',
    });
    // And the rest of the hand-back still happened: the keys go back visibly
    // and the borrowed browser is disconnected.
    expect(borrowedPage.bringToFront).toHaveBeenCalled();
    expect(vi.mocked(closeBrowserMock).mock.calls.map((c) => c[0])).toContain(lastBorrowed);
  });

  it('leaves a tab it only ADOPTED alone: not closed, not on the receipt, not locked', async () => {
    // House rule 1's hard case. The attach's ignore set is a SNAPSHOT of the
    // tabs open at that instant; `context.on('page')` then adopts every tab
    // opened on that browser afterwards, whoever opened it — the user in
    // another window, another session, another errand. Those arrive
    // `unexpected`, because nothing in this errand asked for them, and an
    // errand's coat is the tabs it opened itself.
    const stray = makePage('tab-stray', 'https://news.example/', 'The News');
    let release!: () => void;
    let markAdopted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adopted = new Promise<void>((r) => (markAdopted = r));
    let step = 0;
    let parked = false;
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, _i, opts) => {
      if (step++ === 0) {
        // Adopted, never claimed: no `markExpected`, because no step of this
        // errand opened it. That is the whole difference from the tests above.
        cdpBrowser.pages.push(stray);
        opts.pageTracker!.addPage(stray as any);
      } else if (!parked) {
        // ONE step parks, ever — so the second errand below runs through
        // rather than deadlocking on the same gate.
        parked = true;
        markAdopted();
        await gate;
      }
      return {
        index: idx as number,
        instruction: 'ran',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });

    const first = api('POST', '/errands', errandBody({ steps: ['do a thing', 'wait'] }));
    try {
      await adopted;
      // (c) No hold was taken on it, so somebody else may drive it — the
      // sibling test above is the control: a tab this errand DID open answers
      // 409 here.
      const second = await api('POST', '/errands', errandBody({ targetId: 'tab-stray' }));
      expect(second.status).toBe(200);
    } finally {
      release();
    }

    const { body } = await first;
    // (b) Not the errand's to account for…
    expect(body.errand.openedTabs).toEqual([]);
    expect(body.errand.keptOpen).toEqual([]);
    // (a) …and not the errand's to close. Stranding a tab is the safe
    // direction; closing somebody else's is not.
    expect(stray.close).not.toHaveBeenCalled();
    expect(borrowedPage.close).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (e) No report
  // -------------------------------------------------------------------------

  it('writes no report — while the session path still does', async () => {
    await api('POST', '/errands', errandBody());
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(existsSync(path.join(projectRoot, 'reports'))).toBe(false);

    // Control: the same mock, on the door that IS supposed to write one. Without
    // this the assertion above would pass with report generation removed
    // entirely, or with the mock wired to nothing.
    await api('POST', '/sessions/report-control/steps', {
      steps: ['click something'],
      testFilePath: path.join(projectRoot, 'tests', 't.md'),
    });
    expect(generateReportMock).toHaveBeenCalled();
    await api('DELETE', '/sessions/report-control');
  });

  // -------------------------------------------------------------------------
  // (f) The scope dies with the errand
  // -------------------------------------------------------------------------

  it('resolves {{x}} from a capture an EARLIER step of the same errand made', async () => {
    // The half of the scope rule its sibling below cannot state. Within one
    // errand the map is live, so step 2 sees what step 1 read — and only the
    // executor seam can say so, for the same reason: the receipt's per-step
    // `text` echoes the SENT step, prefix and placeholder and all.
    const seen: string[] = [];
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, instruction, opts) => {
      seen.push(instruction as string);
      if ((idx as number) === 1) opts.resolvedParameters!.token = 'abc-123';
      return {
        index: idx as number,
        instruction: instruction as string,
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });

    const { body } = await api(
      'POST',
      '/errands',
      errandBody({
        steps: ['[output: token] read the API token', 'paste {{token}} into the box'],
      }),
    );

    expect(body.status).toBe('passed');
    expect(seen[1]).toBe('paste abc-123 into the box');
    expect(body.captures).toEqual({ token: 'abc-123' });
    // …and the receipt still echoes what was SENT, unresolved.
    expect(body.results[1].step).toBe('paste {{token}} into the box');
  });

  it('does not carry a capture into the next errand — {{x}} reaches the AI literally', async () => {
    stepThatCaptures('token', 'abc-123');
    const first = await api('POST', '/errands', errandBody({ steps: ['read the API token'] }));
    expect(first.body.captures).toEqual({ token: 'abc-123' });

    const seen = recordInstructions();
    const second = await api('POST', '/errands', errandBody({ steps: ['paste {{token}} into the box'] }));

    // Observed at the executor seam: the receipt's per-step `text` echoes the
    // SENT step, so it cannot tell a resolved placeholder from an unresolved one.
    expect(seen).toEqual(['paste {{token}} into the box']);
    expect(second.body.captures).toEqual({});
  });

  // -------------------------------------------------------------------------
  // (g) ${env.X}
  // -------------------------------------------------------------------------

  it('resolves ${env.X} only when envName names an environment', async () => {
    writeFileSync(path.join(projectRoot, '.env.uat'), 'ERRAND_USER=zoe\n');
    mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'data', 'uat.json'), JSON.stringify({ region: 'au' }));

    const withEnv = recordInstructions();
    await api('POST', '/errands', errandBody({ steps: ['sign in as ${env.ERRAND_USER}'], envName: 'uat' }));
    expect(withEnv).toEqual(['sign in as zoe']);

    // No envName means no bundle is built at all — there is no default-env
    // concept, so the placeholder passes through as literal text.
    const without = recordInstructions();
    await api('POST', '/errands', errandBody({ steps: ['sign in as ${env.ERRAND_USER}'] }));
    expect(without).toEqual(['sign in as ${env.ERRAND_USER}']);
  });

  // -------------------------------------------------------------------------
  // The allow-list
  // -------------------------------------------------------------------------

  it('refuses a malformed request by name, before any browser work', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ steps: [] }, /steps/],
      [{ targetId: undefined }, /targetId/],
      [{ port: 'oops' }, /port/],
      [{ scope: 'global' }, /scope/],
      [{ root: 'relative/path' }, /absolute/],
      [{ testFilePath: undefined }, /testFilePath/],
      [{ keepOpen: 'yes' }, /keepOpen/],
    ];
    for (const [overrides, pattern] of cases) {
      const body = errandBody(overrides);
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete body[key];
      }
      const res = await api('POST', '/errands', body);
      expect(res.status, JSON.stringify(overrides)).toBe(400);
      expect(String(res.body.error)).toMatch(pattern);
    }
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (h) The wheel — one driver at a time (stories/errands.md §The wheel,
  //     verification item 3)
  // -------------------------------------------------------------------------

  /**
   * Park one KIND of run, so a second request meets a live holder instead of
   * racing it. The errand's `testName` is `errand:<id>`, which is the only
   * thing telling the two runs apart at this seam.
   *
   * `onStep` parks a chosen step rather than every one, which is how a test
   * gets a holder that has already run a claim sweep — the run must send at
   * least that many steps or `started` never resolves.
   */
  function parkSteps(
    who: 'errand' | 'session',
    onStep?: number,
  ): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (markStarted = r));
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, _i, opts) => {
      const mine = String(opts.testName ?? '').startsWith('errand:') === (who === 'errand');
      if (mine && (onStep === undefined || (idx as number) === onStep)) {
        markStarted();
        await gate;
      }
      return {
        index: idx as number,
        instruction: 'parked',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });
    return { started, release };
  }

  /** A CDP session bound to the borrowed tab, through the door sessions use.
   *  Every caller closes it afterwards — a session left alive holds a stale
   *  page whose target id would block the NEXT test's errand. */
  async function cdpSession(id: string, steps: string[] = ['click something']) {
    return api('POST', `/sessions/${id}/steps`, {
      steps,
      testFilePath: path.join(projectRoot, 'tests', 't.md'),
      config: { cdp: { port: cdpBrowser.port, tab: 'targetId:tab-borrowed' } },
    });
  }

  it('refuses a second errand on the tab an errand is driving, and lets the retry in', async () => {
    // Parked on the SECOND step, like its tab-opened sibling below, so the
    // sweep after step 1 has already re-taken the borrowed tab by the time the
    // refusal is read. `tabRole: 'borrowed'` is then an assertion about role
    // PRESERVATION — a re-take that overwrote the role would call the user's
    // own tab 'opened' and tell the caller to expect it gone.
    const park = parkSteps('errand', 2);
    const first = api('POST', '/errands', errandBody({ steps: ['click the export button', 'wait'] }));
    let second;
    try {
      await park.started;
      second = await api('POST', '/errands', errandBody());
      expect(second.status).toBe(409);
      expect(second.body.holder).toMatchObject({ kind: 'errand', tabRole: 'borrowed' });
      // Wait-and-retry, because there is no close_errand to offer.
      expect(String(second.body.error)).toMatch(/wait/i);
    } finally {
      // A parked errand outlives a failed assertion and keeps its holds, which
      // would fail every later test in this file for the wrong reason.
      park.release();
    }
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    // The refusal named the RUNNING errand, not a placeholder.
    expect(second.body.holder.errandId).toBe(firstRes.body.errandId);
    expect(String(second.body.error)).toContain(firstRes.body.errandId);

    // Finishing IS releasing: the retry is a plain success, not a queued one.
    const retry = await api('POST', '/errands', errandBody());
    expect(retry.status).toBe(200);
    expect(retry.body.errandId).not.toBe(firstRes.body.errandId);
  });

  it('holds the tabs it OPENS too, and says which kind of hold it refused for', async () => {
    // Steps can switch back to a tab the errand opened, so the lock covers
    // every tab it tracks — the rule cdp-tabs §Locked already sets for sessions.
    const opened = makePage('tab-opened', 'https://openrouter.ai/export', 'Export');
    let release!: () => void;
    let markOpened!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const openedNow = new Promise<void>((r) => (markOpened = r));
    let step = 0;
    let parked = false;
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, _i, opts) => {
      if (step++ === 0) {
        cdpBrowser.pages.push(opened);
        opts.pageTracker!.addPage(opened as any);
        opts.pageTracker!.markExpected(opened as any);
      } else if (!parked) {
        // ONE step parks, ever. If the guard were missing, the second errand
        // would attach and park on the same gate, and this test would deadlock
        // instead of failing — a hang reads as a broken test, not a broken lock.
        parked = true;
        markOpened();
        await gate;
      }
      return {
        index: idx as number,
        instruction: 'opened',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });

    const first = api('POST', '/errands', errandBody({ steps: ['open the export tab', 'wait'] }));
    try {
      await openedNow;

      const second = await api('POST', '/errands', errandBody({ targetId: 'tab-opened' }));
      expect(second.status).toBe(409);
      expect(second.body.holder).toMatchObject({ kind: 'errand', tabRole: 'opened' });
      // The role is the whole reason it is on the wire: a borrowed tab is still
      // there after the wait; one the holder opened normally is not.
      expect(String(second.body.error)).toMatch(/gone/i);
    } finally {
      // A parked errand outlives a failed assertion and keeps its holds, which
      // would fail every later test in this file for the wrong reason.
      release();
      await first;
    }
  });

  it('releases every hold when a step throws, not only when one passes', async () => {
    vi.mocked(executeStepMock).mockImplementation(async () => {
      throw new Error('the page went away');
    });
    const failed = await api('POST', '/errands', errandBody());
    expect(failed.body.status).toBe('error');

    // A lock released only on the happy path stays invisible until the next
    // errand — which is exactly what this asserts.
    vi.mocked(executeStepMock).mockImplementation(defaultStepImpl);
    const next = await api('POST', '/errands', errandBody());
    expect(next.status).toBe(200);
    expect(next.body.status).toBe('passed');
  });

  it('refuses an errand while a session has a batch in flight on that tab', async () => {
    const park = parkSteps('session');
    const batch = cdpSession('wheel-busy');
    try {
      await park.started;

      const refused = await api('POST', '/errands', errandBody());
      expect(refused.status).toBe(409);
      expect(refused.body.holder).toEqual({ kind: 'session', sessionId: 'wheel-busy' });
      expect(String(refused.body.error)).toContain('wheel-busy');
    } finally {
      // A parked batch outlives a failed assertion and keeps its session
      // executing, which would refuse every later errand in this file for the
      // wrong reason.
      park.release();
    }
    await batch;
    await api('DELETE', '/sessions/wheel-busy');
  });

  it('reports EVERY session holding a tab, each with its own status', async () => {
    // The extension itself, which no HTTP answer exposes: `sessionsByTarget`
    // keeps one holder per target and no status at all, so an idle winner would
    // mask the session mid-batch behind it. Two real sessions on one tab, one
    // of them parked mid-step, is the shape that tells the two joins apart.
    let release!: () => void;
    let markParked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const parked = new Promise<void>((r) => (markParked = r));
    vi.mocked(executeStepMock).mockImplementation(async (idx: number, _t, instruction) => {
      if (String(instruction).includes('park')) {
        markParked();
        await gate;
      }
      return {
        index: idx as number,
        instruction: String(instruction),
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
      };
    });

    expect((await cdpSession('join-idle', ['click quickly'])).status).toBe(200);
    const busy = cdpSession('join-busy', ['park here']);
    try {
      await parked;

      const join = await sessionManager.sessionsHoldingTargets(cdpBrowser.port);
      const holders = join.byTarget.get('tab-borrowed') ?? [];
      expect(holders.map((h) => h.sessionId).sort()).toEqual(['join-busy', 'join-idle']);
      expect(holders.find((h) => h.sessionId === 'join-busy')?.status).toBe('executing');
      expect(holders.find((h) => h.sessionId === 'join-idle')?.status).toBe('active');

      // And the reduction the listing and the close guard still read is
      // unchanged — one name per tab.
      const flat = await sessionManager.sessionsByTarget(cdpBrowser.port);
      expect(['join-busy', 'join-idle']).toContain(flat.byTarget.get('tab-borrowed'));
    } finally {
      // A parked batch outlives a failed assertion and keeps its session
      // executing, which would refuse every later errand in this file for the
      // wrong reason.
      release();
    }
    await busy;
    await api('DELETE', '/sessions/join-idle');
    await api('DELETE', '/sessions/join-busy');
  });

  it('lets an errand borrow a tab an IDLE session is sitting on, and the session runs on after', async () => {
    // Idle is the safe case and mid-run is the dangerous one; a guard refusing
    // both would put the two-client coexistence this story measured out of
    // reach of the tool. Its sibling above — the same helper, the same tab,
    // refused mid-batch — is the control proving this session IS a holder.
    expect((await cdpSession('wheel-idle')).status).toBe(200);

    const errand = await api('POST', '/errands', errandBody());
    expect(errand.status).toBe(200);
    expect(errand.body.status).toBe('passed');

    // The half a DELETE cannot make (verification item 2): the session's NEXT
    // batch. Closing a session tells you nothing about whether it still worked,
    // and "the errand handed the tab back intact" is exactly what this asks.
    // No `config` this time — a session's browser is fixed at creation, and
    // later batches address it by id alone, which is what a real second call
    // looks like.
    const next = await api('POST', '/sessions/wheel-idle/steps', {
      steps: ['click something else'],
      testFilePath: path.join(projectRoot, 'tests', 't.md'),
    });
    expect(next.status).toBe(200);
    expect(next.body.status).toBe('passed');
    // The same tab it was bound to before the errand borrowed it.
    expect((await sessionManager.sessionsByTarget(cdpBrowser.port)).byTarget.get('tab-borrowed'))
      .toBe('wheel-idle');

    await api('DELETE', '/sessions/wheel-idle');
  });

  it('never blocks a run_steps batch on a tab an errand is driving', async () => {
    // Sessions take no lock and are refused by none. The errand-only guard is
    // a bounded amendment to mcp-cdp-browser §Locked, whose subject — parallel
    // sessions — is untouched.
    const park = parkSteps('errand');
    const errand = api('POST', '/errands', errandBody());
    try {
      await park.started;
      const batch = await cdpSession('wheel-parallel');
      expect(batch.status).toBe(200);
      expect(batch.body.status).toBe('passed');
    } finally {
      park.release();
    }
    expect((await errand).status).toBe(200);
    await api('DELETE', '/sessions/wheel-parallel');
  });

  /** A runner on its OWN lock registry, asking a stubbed join — the seam the
   *  route cannot reach, because a real `SessionManager` decides its own
   *  iteration order and its own timing. */
  function runnerAsking(
    sessionsHoldingTargets: () => Promise<{
      byTarget: Map<string, SessionTabHolder[]>;
      complete: boolean;
    }>,
  ): ErrandRunner {
    const gate = { beginExternalRun: () => () => {}, sessionsHoldingTargets };
    return new ErrandRunner(
      testConfig,
      gate,
      new ProjectBundleResolver(testConfig),
      new ErrandLocks(),
    );
  }

  function runnerWith(byTarget: Map<string, SessionTabHolder[]>, complete = true): ErrandRunner {
    return runnerAsking(async () => ({ byTarget, complete }));
  }

  const request = () => ({
    port: cdpBrowser.port,
    targetId: 'tab-borrowed',
    steps: ['click'],
    testFilePath: errandFilePath(),
    root: projectRoot,
    scope: 'project' as const,
  });

  it('lets exactly one of two simultaneous errands take the wheel', async () => {
    // Atomicity, which only a race can state. `begin` takes the lock FIRST and
    // synchronously, before the session join it must await; a check-then-take
    // split by that await lets both callers see an empty registry and both
    // return ok — two drivers on one tab, which is the entire hazard §The wheel
    // exists for. The join here yields the event loop deliberately, so the
    // split is exercised rather than hoped for.
    const runner = runnerAsking(async () => {
      await new Promise((r) => setImmediate(r));
      return { byTarget: new Map<string, SessionTabHolder[]>(), complete: true };
    });

    const [a, b] = await Promise.all([runner.begin(request()), runner.begin(request())]);

    const winners = [a, b].filter((started) => started.ok);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((started) => !started.ok)!;
    if (loser.ok) return;
    expect(loser.refusal.holder).toMatchObject({ kind: 'errand', tabRole: 'borrowed' });
    for (const started of [a, b]) if (started.ok) started.lease.release();
  });

  // The join extension: "the idle one answered first" is only reproducible
  // against a stub of the join.
  describe('the status-carrying join', () => {
    it('refuses on an executing session the first-writer-wins map would have hidden', async () => {
      // THE test for the extension. `sessionsByTarget` keeps only the first
      // holder per target, so with the idle session answering first, filtering
      // its output reports "idle" and lets the errand take a wheel a live batch
      // is already turning.
      const started = await runnerWith(
        new Map([
          [
            'tab-borrowed',
            [
              { sessionId: 'idle-one', status: 'active' as const },
              { sessionId: 'busy-one', status: 'executing' as const },
            ],
          ],
        ]),
      ).begin(request());

      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.refusal.holder).toEqual({ kind: 'session', sessionId: 'busy-one' });
    });

    it('lets an errand through when every holder is idle', async () => {
      const started = await runnerWith(
        new Map([['tab-borrowed', [{ sessionId: 'idle-one', status: 'active' as const }]]]),
      ).begin(request());
      expect(started.ok).toBe(true);
    });

    it('lets an errand through on an INCOMPLETE join', async () => {
      // The opposite of the close guard, deliberately: a close refuses on a
      // maybe because its failure closes a tab under a live run, while a borrow
      // that guesses wrong is bounded by one request and shows up in both
      // sides' receipts.
      //
      // The holder is on ANOTHER tab, so `complete: false` is the only thing
      // that could refuse this borrow: an empty map would let the test pass for
      // the ordinary reason — nobody holds the tab — and say nothing at all
      // about the incompleteness arm.
      const started = await runnerWith(
        new Map([['tab-elsewhere', [{ sessionId: 'busy-elsewhere', status: 'executing' as const }]]]),
        false,
      ).begin(request());
      expect(started.ok).toBe(true);
    });

    it('lets an errand through when the join THROWS', async () => {
      // Same rule, harder case: a manager that cannot answer AT ALL is the same
      // as one that answered partially. This is the arm a `catch` covers, and
      // without a test the `catch` could equally well be re-raising.
      const started = await runnerAsking(async () => {
        throw new Error('the session manager is wedged');
      }).begin(request());
      expect(started.ok).toBe(true);
    });
  });
});
