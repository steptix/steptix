/**
 * Code-behind for `### Section` body steps run on their own, over HTTP
 * (steptix-vscode/stories/specs/sections-run-and-resume.md §4.2).
 *
 * Select body lines in VS Code and press Run, and the steps are sent DETACHED:
 * as plain steps at the root frame, with nothing invoking their section. The
 * section's compiled entries carry `section: '<name>'`, because a full run
 * reaches those steps through the section. So until `detachedBody` a detached
 * step bound nothing and ran under AI, or bound a top-level entry that happened
 * to share its text, and ran that.
 *
 * Every test POSTs through the real `node:http` entry, for the reason the
 * sections suite gives: `api-server.ts` builds `StepRequest` from an explicit
 * allow-list, so a field added to the TYPE alone is dropped at runtime. The
 * step executor is mocked and records the binding it was handed; the request
 * validation, the expander, the code-behind loader and the session manager run
 * for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';

// ── Mocks (mirror api-server-compile-mode.test.ts) ───────────────────

const mockPage = {
  url: vi.fn(() => 'https://example.com/shop'),
  title: vi.fn(async () => 'Shop'),
  goto: vi.fn(async () => null),
};
const mockPageTracker = { getActive: vi.fn(() => mockPage as any) };
const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: mockPageTracker,
};

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    getActive: ReturnType<typeof vi.fn>;
    closeAll: ReturnType<typeof vi.fn>;
    hasActive: ReturnType<typeof vi.fn>;
    ensureLaunched: ReturnType<typeof vi.fn>;
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.closeAll = vi.fn(async () => {});
      this.hasActive = vi.fn(() => true);
      this.ensureLaunched = vi.fn(async () => initialSession);
    }
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker(undefined as any);
      let launched: any;
      tracker.hasActive = vi.fn(() => launched !== undefined);
      tracker.getActive = vi.fn(() => {
        if (!launched) throw new Error('no browser has been launched in this session');
        return launched;
      });
      tracker.ensureLaunched = vi.fn(async () => {
        if (!launched) launched = await launch();
        return launched;
      });
      return tracker;
    }
  }
  return {
    launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
    PageTracker: vi.fn(),
    NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {
      constructor(message = 'no browser has been launched in this session') {
        super(message);
        this.name = 'NoBrowserLaunchedError';
      }
    },
    NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
    BrowserTracker,
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

/** Every step the executor was asked to run, with the binding it was handed. */
const stepCalls: { instruction: string; binding: CodeBehindBinding | undefined }[] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts: Record<string, unknown>,
  ): Promise<StepResult> => {
    stepCalls.push({ instruction, binding: opts['codeBehind'] as CodeBehindBinding | undefined });
    return {
      index: stepIndex,
      instruction,
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
      aiExplanation: 'ok',
      pageUrl: 'https://example.com/shop',
    } as StepResult;
  }),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    model = 'base';
    chat = vi.fn(async () => '{}');
    complete = vi.fn(async () => ({ text: '{}' }));
    setAiPolicy = vi.fn();
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
  ApiResponseStore: class { store = vi.fn(); getHistory = vi.fn(() => []); },
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
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(),
    step: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';
import { listenFetchable } from './listen-fetchable.cjs';

const API_KEY = 'detached-body-api-key';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

/**
 * The test file. `Click "Continue"` is written five times on purpose: once in
 * the main flow, twice in `Sign in`, once in `Pay`, and as both the tail of a
 * control line and a plain step in `Banner`. Each of those is a different
 * entry, and binding the wrong one runs another step's code without a word.
 */
const FILE = [
  '# Checkout',
  '',
  '## Steps',
  '1. Open the shop',
  '2. Sign in',
  '3. Click "Continue"',
  '',
  '### Sign in',
  '1. Type the username',
  '2. Click "Continue"',
  '3. Type the password',
  '4. Click "Continue"',
  '',
  '### Pay',
  '1. Click "Continue"',
  '2. Enter the card',
  '',
  '### Banner',
  '1. If a banner is shown, then Click "Continue"',
  '2. Click "Continue"',
  '',
  '### Checkout',
  '1. Sign in',
  '2. Pay',
  '',
  '### Accounts',
  '| account |',
  '|---------|',
  '| ada     |',
  '1. Type {{account}} into the username field',
  '2. Click "Continue"',
  '',
].join('\n');

/** Section rows, by name — what the client's `sections` payload carries. */
const ROWS: Record<string, Array<Record<string, string>>> = { Accounts: [{ account: 'ada' }] };

/** `sections`, built from FILE as the client builds it: keyed by the
 *  lower-cased name, steps as authored, the 1-based line of each. */
function sectionsPayload(): Record<string, unknown> {
  const out: Record<string, { name: string; headingLine: number; steps: string[]; stepLines: number[]; rows?: unknown }> = {};
  let current: (typeof out)[string] | null = null;
  FILE.split('\n').forEach((line, i) => {
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      const name = heading[1]!.trim();
      current = { name, headingLine: i + 1, steps: [], stepLines: [], ...(ROWS[name] && { rows: ROWS[name] }) };
      out[name.toLowerCase()] = current;
      return;
    }
    const step = /^\d+\.\s+(.+)$/.exec(line);
    if (step && current) {
      current.steps.push(step[1]!.trim());
      current.stepLines.push(i + 1);
    }
  });
  return out;
}

/** The 1-based line of body step `step` (0-based) of `section`. */
function lineOf(section: string, step: number): number {
  const entry = sectionsPayload()[section.toLowerCase()] as { stepLines: number[] };
  return entry.stepLines[step]!;
}

/** The text of body step `step` (0-based) of `section`. */
function textOf(section: string, step: number): string {
  const entry = sectionsPayload()[section.toLowerCase()] as { steps: string[] };
  return entry.steps[step]!;
}

/** Entries named by `id`, so a test can say WHICH one bound. Every entry
 *  shares its text with at least one other, which is the whole hazard. */
const STEPS_TS = [
  "import { defineSteps } from 'steptix/codebehind';",
  'export default defineSteps([',
  "  { id: 'main-continue', source: 'Click \"Continue\"', async run() {} },",
  "  { id: 'sign-in-username', section: 'Sign in', source: 'Type the username', async run() {} },",
  "  { id: 'sign-in-continue-1', section: 'Sign in', source: 'Click \"Continue\"', async run() {} },",
  "  { id: 'sign-in-password', section: 'Sign in', source: 'Type the password', async run() {} },",
  "  { id: 'sign-in-continue-2', section: 'Sign in', source: 'Click \"Continue\"', async run() {} },",
  "  { id: 'pay-continue', section: 'Pay', source: 'Click \"Continue\"', async run() {} },",
  "  { id: 'pay-card', section: 'Pay', source: 'Enter the card', async run() {} },",
  "  { id: 'banner-tail', section: 'Banner', source: 'Click \"Continue\"', async run() {} },",
  "  { id: 'banner-plain', section: 'Banner', source: 'Click \"Continue\"', async run() {} },",
  "  { id: 'accounts-type', section: 'Accounts', source: 'Type {{account}} into the username field', async run() {} },",
  "  { id: 'accounts-continue', section: 'Accounts', source: 'Click \"Continue\"', async run() {} },",
  ']);',
  '',
].join('\n');

let server: Server;
let baseUrl: string;
let tmpDir: string;
let testFilePath: string;
let sessionSeq = 0;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await listenFetchable(server, '127.0.0.1');
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-body-'));
  testFilePath = path.join(tmpDir, 'checkout.md');
  await fs.writeFile(testFilePath, FILE, 'utf-8');
  await fs.writeFile(path.join(tmpDir, 'checkout.steps.ts'), STEPS_TS, 'utf-8');
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  stepCalls.length = 0;
});

type Frame = { type: string; [k: string]: any };

/** POST one batch to a fresh session and fold the stream. */
async function post(body: Record<string, unknown>): Promise<{ status: number; error?: string; frames: Frame[] }> {
  sessionSeq += 1;
  const sessionId = `detached-body-${sessionSeq}`;
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    const parsed = (await res.json()) as { error?: unknown };
    return { status: res.status, error: String(parsed.error), frames: [] };
  }
  const text = await res.text();
  const frames: Frame[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (data) {
      try { frames.push(JSON.parse(data)); } catch { /* keep-alive */ }
    }
  }
  await fetch(`${baseUrl}/sessions/${sessionId}`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
  return { status: res.status, frames };
}

/** A detached batch of body steps, as Steptix sends one: each step's own
 *  text and line, the whole file's sections, and — unless `bare` — where
 *  each step sits. */
function detached(
  picks: Array<[section: string, step: number]>,
  extra: { bare?: boolean } & Record<string, unknown> = {},
): Record<string, unknown> {
  const { bare, ...rest } = extra;
  return {
    steps: picks.map(([s, i]) => textOf(s, i)),
    sourceLines: picks.map(([s, i]) => lineOf(s, i)),
    fullSteps: ['Open the shop', 'Sign in', 'Click "Continue"'],
    testFilePath,
    sections: sectionsPayload(),
    // Named after this test, so nothing mistakes it for a real key.
    env: { AI_API_KEY: 'detached-body-ai-key' },
    ...(!bare && { detachedBody: picks.map(([section, step]) => ({ section, step })) }),
    ...rest,
  };
}

/** The `id` of the entry each executed step was bound to, or null. */
function boundIds(): Array<string | null> {
  return stepCalls.map((c) => (c.binding?.entry as { id?: string } | undefined)?.id ?? null);
}

describe('a detached body step binds its section\'s entry', () => {
  it('binds nothing without `detachedBody` — the bug', async () => {
    const { status } = await post(detached([['Sign in', 0]], { bare: true }));
    expect(status).toBe(200);
    // Looked up at the top level, where `Type the username` has no entry.
    expect(boundIds()).toEqual([null]);
  });

  it('binds the section entry with it, and still runs detached', async () => {
    const { status, frames } = await post(detached([['Sign in', 0]]));
    expect(status).toBe(200);
    expect(boundIds()).toEqual(['sign-in-username']);
    expect(stepCalls[0]!.binding?.section).toBe('Sign in');
    // Execution is unchanged: nothing invoked the section, so no frame.
    expect(frames.filter((f) => f.type === 'frame:push')).toEqual([]);
  });

  it('binds the section entry, not a top-level entry with the same text', async () => {
    // Without the field the step finds `main-continue`, the main flow's own
    // step, and runs its code. The two may do the same thing; nothing says so.
    await post(detached([['Sign in', 1]], { bare: true }));
    expect(boundIds()).toEqual(['main-continue']);

    stepCalls.length = 0;
    await post(detached([['Sign in', 1]]));
    expect(boundIds()).toEqual(['sign-in-continue-1']);
  });
});

describe('the occurrence is the one in the authored body', () => {
  it('binds the second `Click "Continue"` when only it is run', async () => {
    await post(detached([['Sign in', 3]]));
    expect(boundIds()).toEqual(['sign-in-continue-2']);
  });

  it('binds each repeat to its own slot when the batch holds both', async () => {
    await post(detached([['Sign in', 1], ['Sign in', 2], ['Sign in', 3]]));
    expect(boundIds()).toEqual(['sign-in-continue-1', 'sign-in-password', 'sign-in-continue-2']);
  });

  it('counts a control line\'s tail as an emission ahead of a plain repeat', async () => {
    // `If a banner is shown, then Click "Continue"` emits its guard and then
    // `Click "Continue"` into the section's frame, so the plain step below it
    // holds the SECOND slot for that text.
    await post(detached([['Banner', 1]]));
    expect(boundIds()).toEqual(['banner-plain']);
  });
});

describe('a batch that spans sections', () => {
  it('binds each step under its own section, counting each separately', async () => {
    await post(detached([['Sign in', 3], ['Pay', 0], ['Pay', 1]]));
    expect(boundIds()).toEqual(['sign-in-continue-2', 'pay-continue', 'pay-card']);
  });

  it('leaves a body step that calls a sibling section to that section\'s frame', async () => {
    // `Checkout`'s first step is a call to `Sign in`, which expands in a frame
    // of its own. Only steps a pick emits at the ROOT move under its section;
    // moving these would file `Sign in`'s entries under `Checkout`.
    await post(detached([['Checkout', 0]]));
    expect(boundIds()).toEqual([
      'sign-in-username',
      'sign-in-continue-1',
      'sign-in-password',
      'sign-in-continue-2',
    ]);
  });
});

describe('a looped section, run without its row', () => {
  it('runs a step that reads the row under AI, and says why', async () => {
    const { frames } = await post(detached([['Accounts', 0], ['Accounts', 1]]));
    // `getVar('account')` has no row to answer from in a detached run. The
    // step that does not read the row still replays its entry.
    expect(boundIds()).toEqual([null, 'accounts-continue']);
    const said = frames.filter((f) => f.type === 'output').map((f) => String(f.msg));
    expect(said.some((m) => /runs under AI.*\{\{account\}\}.*has no row/s.test(m))).toBe(true);
  });
});

describe('a malformed `detachedBody` is refused, not ignored', () => {
  const base = (): Record<string, unknown> => detached([['Sign in', 0], ['Sign in', 1]]);

  it.each([
    ['not an array', { detachedBody: { section: 'Sign in', step: 0 } }, /must be an array/],
    ['one entry short', { detachedBody: [{ section: 'Sign in', step: 0 }] }, /one entry per step/],
    ['a step that is not an index', { detachedBody: [{ section: 'Sign in', step: -1 }, { section: 'Sign in', step: 1 }] }, /0-based step index/],
    ['an unnamed section', { detachedBody: [{ section: ' ', step: 0 }, { section: 'Sign in', step: 1 }] }, /non-empty string/],
    ['a section `sections` lacks', { detachedBody: [{ section: 'Nowhere', step: 0 }, { section: 'Sign in', step: 1 }] }, /does not define/],
    ['a position past the body', { detachedBody: [{ section: 'Sign in', step: 0 }, { section: 'Sign in', step: 9 }] }, /has 4 steps/],
    ['a position holding other text', { detachedBody: [{ section: 'Sign in', step: 2 }, { section: 'Sign in', step: 1 }] }, /reads "Type the password"/],
    ['positions out of body order', { steps: ['Click "Continue"', 'Type the username'], detachedBody: [{ section: 'Sign in', step: 1 }, { section: 'Sign in', step: 0 }] }, /must come after/],
    ['a disagreeing compileScope', { compile: 'steps', compileScope: { section: 'Pay' } }, /send one attribution/],
  ])('refuses %s', async (_label, override, message) => {
    const { status, error } = await post({ ...base(), ...override });
    expect(status).toBe(400);
    expect(error).toMatch(message);
    expect(stepCalls).toEqual([]);
  });

  it('refuses it with no `sections` to check it against', async () => {
    const { sections: _dropped, ...noSections } = base();
    const { status, error } = await post(noSections);
    expect(status).toBe(400);
    expect(error).toMatch(/does not define/);
  });
});
