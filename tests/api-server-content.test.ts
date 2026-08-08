/**
 * W2 of stories/page-content.md — `GET /sessions/:id/content`.
 *
 * The capture helpers themselves are covered against a real browser in
 * page-content-capture.test.ts. This file is about the layer above them:
 * query validation, truncation accounting, status mapping, and — the one that
 * fails silently in production — which config's dom-cleaner options reach the
 * capture.
 *
 * `dom-cleaner` is partially mocked: the real `PageCaptureError` and
 * `domCaptureFailure` are kept (the route does `instanceof` checks against the
 * former), while the three capture entry points become spies.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — mirrors api-server.test.ts so no real browser or AI is involved
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com/invoices'),
  title: vi.fn(async () => 'Invoices'),
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
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.closeAll = vi.fn(async () => {});
    }
  }
  return {
    launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
    PageTracker: vi.fn(),
    BrowserTracker,
    // Real behaviour, not a stub: session-manager uses it to bound page reads
    // while listing, and a mock that resolved instantly would hide a hang.
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return {
    ...actual,
    captureVisibleText: vi.fn(async () => 'visible text'),
    captureDomSnapshot: vi.fn(async () => '<body><p>dom</p></body>'),
    expandDomSubtree: vi.fn(async () => '<div>subtree</div>'),
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
    aiExplanation: 'ok',
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
  buildReportBaseName: vi.fn((r: { testName: string }) => r.testName),
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApiServer } from '../src/server/api-server.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import {
  captureVisibleText,
  captureDomSnapshot,
  expandDomSubtree,
  PageCaptureError,
} from '../src/browser/dom-cleaner.js';

const captureText = vi.mocked(captureVisibleText);
const captureDom = vi.mocked(captureDomSnapshot);
const expandDom = vi.mocked(expandDomSubtree);

const API_KEY = 'content-test-key';
/** Distinctive so a test can prove the SERVER's value did not reach a capture. */
const SERVER_CHAR_LIMIT = 999;

const testConfig: Config = {
  ...DEFAULT_CONFIG,
  browser: { ...DEFAULT_CONFIG.browser, headed: false, domSnapshotCharLimit: SERVER_CHAR_LIMIT },
  server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let tmpRoot: string;

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${p}`, opts);
  return { status: res.status, body: await res.json() };
}

/** Create a session by running one (mocked) step through it. */
async function createSession(id: string, testFilePath?: string): Promise<void> {
  const body: Record<string, unknown> = { steps: ['do a thing'] };
  if (testFilePath) body['testFilePath'] = testFilePath;
  const { status } = await api('POST', `/sessions/${id}/steps`, body);
  expect(status).toBe(200);
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'aiui-content-'));
  const { app } = createApiServer(testConfig);
  ({ server, baseUrl } = await listenOnRandomPort(app));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  captureText.mockReset().mockResolvedValue('visible text');
  captureDom.mockReset().mockResolvedValue('<body><p>dom</p></body>');
  expandDom.mockReset().mockResolvedValue('<div>subtree</div>');
});

describe('GET /sessions/:id/content — success shape', () => {
  it('defaults to visible text and reports what it read', async () => {
    await createSession('s-text');

    const { status, body } = await api('GET', '/sessions/s-text/content');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      sessionId: 's-text',
      url: 'https://example.com/invoices',
      title: 'Invoices',
      status: 'active',
      format: 'text',
      selector: null,
      content: 'visible text',
      truncated: false,
      returnedChars: 'visible text'.length,
      availableChars: 'visible text'.length,
    });
    expect(captureText).toHaveBeenCalledTimes(1);
    expect(captureDom).not.toHaveBeenCalled();
  });

  it('returns the cleaned DOM for format=dom', async () => {
    await createSession('s-dom');

    const { status, body } = await api('GET', '/sessions/s-dom/content?format=dom');

    expect(status).toBe(200);
    expect(body.format).toBe('dom');
    expect(body.content).toBe('<body><p>dom</p></body>');
    expect(captureText).not.toHaveBeenCalled();
  });

  it('narrows to a selector and echoes it back', async () => {
    await createSession('s-sel');

    const { status, body } = await api('GET', '/sessions/s-sel/content?selector=%23content');

    expect(status).toBe(200);
    expect(body.selector).toBe('#content');
    expect(captureText).toHaveBeenCalledWith(expect.anything(), { selector: '#content' });
  });

  it('uses the subtree path when a selector is given with format=dom', async () => {
    await createSession('s-sel-dom');

    const { body } = await api('GET', '/sessions/s-sel-dom/content?format=dom&selector=%23t');

    expect(body.content).toBe('<div>subtree</div>');
    expect(expandDom).toHaveBeenCalledWith(expect.anything(), '#t');
    expect(captureDom).not.toHaveBeenCalled();
  });
});

describe('GET /sessions/:id/content — truncation', () => {
  it('flags truncation and reports both counts', async () => {
    await createSession('s-trunc');
    captureText.mockResolvedValue('x'.repeat(500));

    const { body } = await api('GET', '/sessions/s-trunc/content?max_chars=100');

    expect(body.truncated).toBe(true);
    expect(body.returnedChars).toBe(100);
    expect(body.availableChars).toBe(500);
    expect(body.content).toHaveLength(100);
  });

  // Off-by-one: content exactly at the limit is complete, not truncated.
  it('does not flag content exactly at the limit', async () => {
    await createSession('s-exact');
    captureText.mockResolvedValue('y'.repeat(100));

    const { body } = await api('GET', '/sessions/s-exact/content?max_chars=100');

    expect(body.truncated).toBe(false);
    expect(body.returnedChars).toBe(100);
    expect(body.availableChars).toBe(100);
  });

  it('applies the 20 000-char default when max_chars is absent', async () => {
    await createSession('s-default');
    captureText.mockResolvedValue('z'.repeat(25_000));

    const { body } = await api('GET', '/sessions/s-default/content');

    expect(body.truncated).toBe(true);
    expect(body.returnedChars).toBe(20_000);
  });
});

describe('GET /sessions/:id/content — validation', () => {
  it('rejects an unknown format instead of silently defaulting to text', async () => {
    await createSession('s-badfmt');

    const { status, body } = await api('GET', '/sessions/s-badfmt/content?format=html');

    expect(status).toBe(400);
    expect(body.error).toContain('html');
    expect(body.error).toContain('text');
    expect(body.error).toContain('dom');
    expect(captureText).not.toHaveBeenCalled();
  });

  it.each(['0', '-5', 'abc', '1.5'])('rejects max_chars=%s', async (value) => {
    await createSession('s-badmax');

    const { status, body } = await api('GET', `/sessions/s-badmax/content?max_chars=${value}`);

    expect(status).toBe(400);
    expect(body.error).toContain('max_chars');
  });

  // An array-valued selector used to fail the string check and silently become
  // `undefined`, widening the read from one element to the whole page.
  it('rejects a repeated selector rather than reading the whole page', async () => {
    await createSession('s-dupsel');

    const { status, body } = await api('GET', '/sessions/s-dupsel/content?selector=a&selector=b');

    expect(status).toBe(400);
    expect(body.error).toContain('selector');
    expect(captureText).not.toHaveBeenCalled();
  });

  it('rejects an empty selector rather than reading the whole page', async () => {
    await createSession('s-emptysel');

    const { status, body } = await api('GET', '/sessions/s-emptysel/content?selector=');

    expect(status).toBe(400);
    expect(body.error).toContain('empty');
    expect(captureText).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown session', async () => {
    const { status, body } = await api('GET', '/sessions/nope/content');

    expect(status).toBe(404);
    expect(body.error).toBe('Session not found');
  });

  it('returns 404 for a closed session', async () => {
    await createSession('s-closed');
    await api('DELETE', '/sessions/s-closed');

    const { status } = await api('GET', '/sessions/s-closed/content');

    expect(status).toBe(404);
  });
});

describe('GET /sessions/:id/content — failures are not empty content', () => {
  it('maps a selector miss to 400, not to an empty string', async () => {
    await createSession('s-miss');
    captureText.mockRejectedValue(new PageCaptureError('selector-miss', 'No element matches selector: #gone'));

    const { status, body } = await api('GET', '/sessions/s-miss/content?selector=%23gone');

    expect(status).toBe(400);
    expect(body.error).toContain('#gone');
  });

  it('retries a navigation race once, then answers 409', async () => {
    await createSession('s-nav');
    captureText.mockRejectedValue(new PageCaptureError('navigated', 'page navigated while it was being read'));

    const { status, body } = await api('GET', '/sessions/s-nav/content');

    expect(status).toBe(409);
    expect(body.error).toContain('navigated');
    expect(captureText).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('succeeds when the retry wins the race', async () => {
    await createSession('s-nav-ok');
    captureText
      .mockRejectedValueOnce(new PageCaptureError('navigated', 'navigated'))
      .mockResolvedValueOnce('settled content');

    const { status, body } = await api('GET', '/sessions/s-nav-ok/content');

    expect(status).toBe(200);
    expect(body.content).toBe('settled content');
  }, 10_000);

  // Retrying a wedged page just doubles the wait — only the navigation race is
  // transient enough to be worth a second attempt.
  it('does not retry a timeout', async () => {
    await createSession('s-timeout');
    captureText.mockRejectedValue(new PageCaptureError('timeout', 'evaluate timed out after 30000ms'));

    const { status } = await api('GET', '/sessions/s-timeout/content');

    expect(status).toBe(500);
    expect(captureText).toHaveBeenCalledTimes(1);
  });

  it('turns an in-band dom capture failure into an error, not content', async () => {
    await createSession('s-inband');
    captureDom.mockResolvedValue('<error>DOM capture timed out: Error: boom</error>');

    const { status, body } = await api('GET', '/sessions/s-inband/content?format=dom');

    expect(status).toBe(500);
    expect(body.content).toBeUndefined();
  });

  // The dom+selector path goes through expandDomSubtree, which reports failure
  // in band with its OWN markers. Deleting the domCaptureFailure check on that
  // branch previously left every test green while the route returned
  // "[expand] No element found…" to the agent as 200 OK page content.
  it('turns an expand selector miss into a 400, not content', async () => {
    await createSession('s-expand-miss');
    expandDom.mockResolvedValue('[expand] No element found for selector: #gone');

    const { status, body } = await api('GET', '/sessions/s-expand-miss/content?format=dom&selector=%23gone');

    expect(status).toBe(400);
    expect(body.content).toBeUndefined();
    expect(body.error).toContain('#gone');
  });

  it('turns an expand evaluate error into an error, not content', async () => {
    await createSession('s-expand-err');
    expandDom.mockResolvedValue('[expand] Error: TypeError: boom');

    const { status, body } = await api('GET', '/sessions/s-expand-err/content?format=dom&selector=%23t');

    expect(status).toBe(500);
    expect(body.content).toBeUndefined();
  });

  // `dom` is the format the tool description steers agents to for selector
  // work, so it is the one where a bad selector matters most — and it was
  // answering 500 while `text` correctly answered 400.
  it('answers 400 for an invalid selector on the dom path too', async () => {
    await createSession('s-expand-badsel');
    expandDom.mockResolvedValue(
      `[expand] Error: SyntaxError: Failed to execute 'querySelector' on 'Document': 'div:has-text("x")' is not a valid selector.`,
    );

    const { status, body } = await api(
      'GET',
      '/sessions/s-expand-badsel/content?format=dom&selector=div%3Ahas-text(%22x%22)',
    );

    expect(status).toBe(400);
    expect(body.error).toContain('valid CSS selector');
  });

  // The expand path returns whatever tag was asked for, so a page containing
  // its own <error> element must not read as a capture failure.
  it('serves a page\'s own <error> element as content', async () => {
    await createSession('s-error-el');
    expandDom.mockResolvedValue('<error> SyntaxError while parsing the invoice\n</error>\n');

    const { status, body } = await api('GET', '/sessions/s-error-el/content?format=dom&selector=error');

    expect(status).toBe(200);
    expect(body.content).toContain('parsing the invoice');
  });

  // A bad selector is the caller's mistake. Answered 500, an agent reads it as
  // "the server is broken, retry later" when the fix is its own next argument.
  it('answers 400 for an invalid selector', async () => {
    await createSession('s-badsel');
    captureText.mockRejectedValue(
      new PageCaptureError('bad-selector', 'Not a valid CSS selector: div:has-text("x")'),
    );

    const { status, body } = await api('GET', '/sessions/s-badsel/content?selector=div%3Ahas-text(%22x%22)');

    expect(status).toBe(400);
    expect(body.error).toContain('valid CSS selector');
  });

  it('answers 400 for an element that is not rendered', async () => {
    await createSession('s-notrendered');
    captureText.mockRejectedValue(
      new PageCaptureError('not-rendered', 'Element at "#modal" is on the page but not rendered'),
    );

    const { status, body } = await api('GET', '/sessions/s-notrendered/content?selector=%23modal');

    expect(status).toBe(400);
    expect(body.error).toContain('not rendered');
  });
});

describe('GET /sessions/:id/content — truncation the caller cannot see', () => {
  // captureDomSnapshot enforces the project's domSnapshotCharLimit BEFORE this
  // layer sees the string. Reporting `truncated` from max_chars alone told the
  // agent a clipped page was complete — worst when it raises max_chars above
  // the project limit, flipping a correct warning into a confident all-clear.
  it('flags a snapshot the capture itself clipped, even when it fits max_chars', async () => {
    await createSession('s-preclipped');
    captureDom.mockResolvedValue(
      'X'.repeat(400) + '\n<!-- DOM snapshot truncated — page content exceeds size limit -->',
    );

    const { body } = await api('GET', '/sessions/s-preclipped/content?format=dom&max_chars=20000');

    expect(body.truncated).toBe(true);
    expect(body.returnedChars).toBe(body.availableChars);
  });

  it('does not flag a complete snapshot that fits', async () => {
    await createSession('s-complete');
    captureDom.mockResolvedValue('<body><p>all of it</p></body>');

    const { body } = await api('GET', '/sessions/s-complete/content?format=dom');

    expect(body.truncated).toBe(false);
  });

  // Slicing by code unit can leave a lone high surrogate, which survives JSON
  // but decodes to U+FFFD for the reader.
  it('does not split a surrogate pair at the truncation boundary', async () => {
    await createSession('s-surrogate');
    captureText.mockResolvedValue('ab😀cd');

    const { body } = await api('GET', '/sessions/s-surrogate/content?max_chars=3');

    expect(body.content).toBe('ab');
    expect([...body.content].every((c: string) => c.codePointAt(0)! < 0xd800)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The regression guard the story calls out: per-project config must reach the
// capture. Reading `this.config.browser` instead compiles, passes every test
// above, and is wrong for every project but the server's own.
// ---------------------------------------------------------------------------

describe('GET /sessions/:id/content — project config, not server config', () => {
  const PROJECT_CHAR_LIMIT = 4242;

  it('builds dom options from the project bundle of the session\'s last run', async () => {
    const projectRoot = path.join(tmpRoot, 'proj-a');
    mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, 'aiui.config.json'),
      JSON.stringify({ browser: { domSnapshotCharLimit: PROJECT_CHAR_LIMIT } }),
    );
    const testFile = path.join(projectRoot, 'tests', 'a.md');
    writeFileSync(testFile, '# a\n');

    await createSession('s-proj', testFile);
    await api('GET', '/sessions/s-proj/content?format=dom');

    expect(captureDom).toHaveBeenCalledTimes(1);
    const opts = captureDom.mock.calls[0]![1];
    expect(opts?.domSnapshotCharLimit).toBe(PROJECT_CHAR_LIMIT);
    expect(opts?.domSnapshotCharLimit).not.toBe(SERVER_CHAR_LIMIT);
  }, 30_000);

  it('falls back to server config for a session with no project root', async () => {
    await createSession('s-noproj');

    await api('GET', '/sessions/s-noproj/content?format=dom');

    expect(captureDom.mock.calls[0]![1]?.domSnapshotCharLimit).toBe(SERVER_CHAR_LIMIT);
  });
});
