import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';

/**
 * The `## Values` block reaches the model through the real Sessions API entry
 * (stories/placeholder-preserving-actions.md, decision 1).
 *
 * Every other `api-server-*.test.ts` mocks `executeStep`, which is exactly the
 * piece that builds the block — so none of them can prove this. Here the
 * executor is real and only its edges are stubbed: no browser, no network, a
 * scripted AI client that records what it was sent.
 */

const ai = vi.hoisted(() => ({ requests: [] as ChatMessage[][], responses: [] as string[] }));
const acted = vi.hoisted(() => ({ received: [] as AIAction[] }));
/** What `captureDomSnapshot` answers. Mutable so one test can put a live form
 *  value in the page the model is shown. */
const dom = vi.hoisted(() => ({ text: '<html><body>ok</body></html>' }));

const mockPage = {
  url: () => 'https://app.test/dashboard',
  title: async () => 'Dashboard',
  goto: async () => null,
  on: () => {},
  off: () => {},
  context: () => ({ browser: () => ({}) }),
  evaluate: async () => { throw new Error('no DOM in this test'); },
  screenshot: async () => { throw new Error('no screenshot in this test'); },
  waitForLoadState: async () => {},
};

const mockBrowserSession = {
  browser: { isConnected: () => true },
  context: {},
  page: mockPage,
  pageTracker: { getActive: () => mockPage, count: 1 },
};

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    launched: any = mockBrowserSession;
    getActive = () => this.launched;
    getActivePage = () => mockPage;
    closeAll = async () => {};
    all = () => [];
    count = 1;
    list = () => [];
    hasActive = () => this.launched !== undefined;
    ensureLaunched = async () => (this.launched ??= await this.launch!());
    launch: (() => Promise<any>) | undefined;
    // Lazy twin of the real static (SPEC-use-computer.md §4.6): unlaunched
    // until ensureLaunched(), which the step boundary calls.
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker();
      tracker.launched = undefined;
      tracker.launch = launch;
      return tracker;
    }
  }
  return {
    launchBrowser: async () => ({ ...mockBrowserSession }),
    PageTracker: class {},
    // The 'no browser yet' sentinel (SPEC-use-computer.md §4.6). A mock of
    // this module must export it: api-server and session-manager both do
    // `instanceof` against it, and `instanceof undefined` throws.
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
    resolveVideoMode: () => 'off',
    finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    },
  };
});

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      acted.received.push(action);
      return { success: true };
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: async () => dom.text };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false, loadingIndicators: [], hasErrorOverlay: false,
    errorMessages: [], hasModal: false, documentLoading: false,
  }),
  waitForPageStability: async () => {},
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://app.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean { return true; }
    dispose(): void {}
  },
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: async () => null,
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: async () => ({ files: [], combined: '' }),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy(): void {}
    syncAuth(): null { return null; }
    async complete(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
      ai.requests.push(messages);
      const text = ai.responses[ai.requests.length - 1] ?? ai.responses[ai.responses.length - 1]!;
      return { text, model: 'stub' };
    }
  },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: async () => '/tmp/fake-report.html',
  getPrimaryModel: () => 'stub',
  buildReportBaseName: (report: { testName: string }) => report.testName,
  videoBaseNameFor: () => 'v',
  countStepOrigins: () => ({}),
}));

import { createApiServer } from '../src/server/api-server.js';

const API_KEY = 'values-block-key';

let projectRoot: string;
let testFilePath: string;
let server: Server;
let baseUrl: string;

function testConfig(): Config {
  return {
    ai: {
      gatewayUrl: 'https://ai.test',
      model: 'test-model',
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
      captureScreenshotsPerAction: false,
    },
    tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
    execution: {
      timeout: 30_000, retries: 0, screenshotOnFailure: false,
      promptOnAmbiguity: false, maxTurns: 2,
    },
    reports: {
      outputDir: path.join(projectRoot, 'reports'),
      includeScreenshots: false, includeDomSnapshots: false,
      includeAiReasoning: true, embedScreenshots: false,
    },
    api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
    server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
    cache: { enabled: false, dir: '.cache' },
    logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  } as unknown as Config;
}

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    // Express's default HTML error page, most often. Say what it was, rather
    // than failing on "Unexpected token '<'" three frames away from the cause.
    throw new Error(`${method} ${route} returned non-JSON ${res.status}: ${text.slice(0, 400)}`);
  }
}

beforeAll(async () => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'aiui-values-block-'));
  mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'aiui.config.json'), JSON.stringify({}));
  writeFileSync(
    path.join(projectRoot, '.env.uat'),
    'BASE_URL=https://uat.app.test\nLOGIN_PASSWORD=hunter2-ENV-SECRET\n',
  );
  writeFileSync(
    path.join(projectRoot, 'data', 'uat.json'),
    JSON.stringify({ url: 'https://uat.app.test/admin' }),
  );
  testFilePath = path.join(projectRoot, 'tests', 'sign-in.md');
  writeFileSync(testFilePath, '# Sign in\n\n## Steps\n1. Sign in\n');

  const { app } = createApiServer(testConfig());
  ({ server, baseUrl } = await listenOnRandomPort(app));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  ai.requests = [];
  ai.responses = [];
  acted.received = [];
  dom.text = '<html><body>ok</body></html>';
});

function allRequestText(): string {
  return ai.requests
    .flat()
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

describe('the ## Values block through the real Sessions API entry', () => {
  it('shows the model the authored step and what each reference resolved to', async () => {
    ai.responses = [
      JSON.stringify({
        actions: [{ action: 'type', selector: '#email', value: '{{email}}', description: 'Enter email' }],
        reasoning: 'fill it',
        needs_reeval: false,
      }),
    ];

    const run = await api('POST', `/sessions/values-block/steps`, {
      steps: ['Open ${data.url} and enter the email {{email}}'],
      parameters: { email: 'demo@securebank.com' },
      envName: 'uat',
      testFilePath,
    });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('passed');

    const sent = allRequestText();
    // The step as WRITTEN, both syntaxes intact...
    expect(sent).toContain('Open ${data.url} and enter the email {{email}}');
    // ...and one line per reference saying what it holds.
    expect(sent).toContain('## Values');
    expect(sent).toContain('- {{email}} resolved to "demo@securebank.com" on this run');
    expect(sent).toContain('- ${data.url} resolved to "https://uat.app.test/admin" on this run');

    // The page still received the value, and the report's instruction line is
    // the substituted form (decision 9).
    expect(acted.received[0]!.value).toBe('demo@securebank.com');
    expect(run.body.results[0].step).toBe('Open ${data.url} and enter the email {{email}}');

    await api('DELETE', `/sessions/values-block`);
  });

  it('masks an ${env.…} secret in the watch group`s poll message', async () => {
    // The watch group's poller reads the page on every poll and sends the
    // snapshot to the model. It redacts with `secretsFor(opts)`, which
    // consults `envData` only when the caller passes it — and the server's
    // `executeBranchedStep` call was the one call site that did not, so this
    // path sent a `${env.PASSWORD}` value in full while every ordinary step
    // on the same run showed `***` (review 4, finding 3).
    //
    // Nothing in the STEP TEXT mentions the secret: the run's secret set is
    // the env context's, not the step's, which is the whole point.
    dom.text =
      '<html><body><input type="text" name="who" value="hunter2-ENV-SECRET">' +
      '<button>Continue</button></body></html>';
    ai.responses = [
      // One poll, answering with the continuation label and no actions, so the
      // group resolves without a second AI call.
      JSON.stringify({ matched: 'B', actions: [], reasoning: 'no banner' }),
    ];

    const run = await api('POST', `/sessions/branched-secrets/steps`, {
      steps: ['If a cookie banner appears, click Reject all', 'Click Continue'],
      envName: 'uat',
      testFilePath,
    });
    expect(run.status).toBe(200);

    const sent = allRequestText();
    expect(sent).not.toContain('hunter2-ENV-SECRET');
    expect(sent).toContain('value="***"');
    // Masked, not dropped: the poller still sees the page it is watching.
    expect(sent).toContain('<button>Continue</button>');

    await api('DELETE', `/sessions/branched-secrets`);
  });

  it('rejects a non-string config.unmask', async () => {
    const bad = await api('POST', `/sessions/unmask-shape/steps`, {
      steps: ['Do a thing'],
      config: { unmask: ['keyword'] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('config.unmask');
  });
});
