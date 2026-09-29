/**
 * `run_test_file` driven through the real stack: a real MCP client over a real
 * transport, the real assembler, the real HTTP client, and the real
 * `createApiServer` over a real socket.
 *
 * This exists for one class of bug. `api-server.ts` builds its request from an
 * explicit per-field allow-list, so widening a TYPE compiles cleanly and drops
 * the field at runtime — this seam has already lost `envName` exactly that way.
 * A test that hands a request object straight to the session manager passes
 * against that bug; only a test that goes over the wire catches it.
 *
 * So the assertions are deliberately about *observable consequences* of each
 * field arriving — a section body that ran, a `${env.X}` that resolved, a
 * `{{param}}` that was substituted — rather than about the request we sent.
 *
 * The browser, AI and step executor are mocked as in the sibling api-server
 * tests; everything between the tool call and the session manager is real.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server-sections.test.ts) ───────────────────────

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example Page'),
  goto: vi.fn(async () => null),
};
const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: { getActive: vi.fn(() => mockPage as never) },
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
    /**
     * Lazy twin of the real static (SPEC-use-computer.md §4.6). Modelled, not
     * stubbed: nothing launches until ensureLaunched(), and it launches at
     * most once — so these suites exercise the same launch-at-first-step rule
     * the session manager now follows instead of hiding it behind a mock that
     * always has a browser.
     */
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

/** The instruction text of every step the runner actually executed — the
 *  evidence that a field survived the wire. */
const executedSteps: string[] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(
    async (_i: number, _t: number, instruction: string): Promise<StepResult> => {
      executedSteps.push(instruction);
      return {
        index: 1,
        instruction,
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
        aiExplanation: 'ok',
      };
    },
  ),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

/** AI config each session was constructed with — the only place the request's
 *  `env` field has an observable effect, since that is how a project's own
 *  AI_API_KEY / AI_MODEL reach a run. */
const aiConfigs: { apiKey?: string; model?: string }[] = [];

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    constructor(config: { apiKey?: string; model?: string }) {
      aiConfigs.push(config ?? {});
    }
    chat = vi.fn(async () => '{}');
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

// The assembler and the parser both log. The house logger mock omits several
// exports; anything missing surfaces as "undefined is not a function" from
// deep inside a parse, so this one is deliberately complete.
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(),
    step: vi.fn(), debug: vi.fn(), trace: vi.fn(), subAction: vi.fn(),
    assertion: vi.fn(), testStart: vi.fn(), testEnd: vi.fn(), tokenWarning: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  setLogCallback: vi.fn(),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
  setVerbose: vi.fn(),
  setLogStream: vi.fn(),
  traceOp: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

import { createApiServer } from '../src/server/api-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createApiClient } from '../src/mcp/api-client.js';
import { resolveProject } from '../src/mcp/project.js';
import { resetRegistry } from '../src/mcp/registry.js';

const API_KEY = 'sk-mcp-seam-test';

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

let server: Server;
let client: Client;
let tmpDir: string;
let testFilePath: string;
let previousRoots: string | undefined;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Ordering matters: the project's .env carries SERVER_URL, and the port only
  // exists once the server is listening. Writing the fixture first would bake
  // in a port nobody is on.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-seam-')));
  await fs.writeFile(
    path.join(tmpDir, '.env'),
    `SERVER_URL=${baseUrl}\nSTEPTIX_SERVER_API_KEY=${API_KEY}\nAI_API_KEY=project-ai-key\nAI_MODEL=project-model\n`,
  );
  // The environment overlay, so `${env.GREETING}` has something to resolve to
  // — and resolving it is the evidence that `envName` survived the wire.
  await fs.writeFile(path.join(tmpDir, '.env.uat'), 'GREETING=hello-from-uat\n');
  await fs.writeFile(path.join(tmpDir, 'steptix.config.json'), JSON.stringify({ tests: { dir: './tests' } }));

  await fs.mkdir(path.join(tmpDir, 'tests'), { recursive: true });
  testFilePath = path.join(tmpDir, 'tests', 'seam.md');
  await fs.writeFile(
    testFilePath,
    [
      '---',
      'env: uat',
      '---',
      '# Seam test',
      '',
      '## Parameters',
      '- who: world',
      '',
      '## Steps',
      '1. Say ${env.GREETING} to {{who}}',
      '2. Greet Politely',
      '',
      '### Greet Politely',
      '1. Say good morning',
      '',
    ].join('\n'),
  );

  previousRoots = process.env['STEPTIX_MCP_ROOTS'];
  process.env['STEPTIX_MCP_ROOTS'] = tmpDir;

  const mcp = createMcpServer({
    createApiClient,
    // The server is already up; this test is about the request path.
    ensureServerReady: async () => {},
    // The real app under test is a bare `createApiServer`, which serves no
    // /health route through this harness — so the identity probe would refuse
    // a server we know is ours.
    assertServerRecognized: async () => {},
    resolveProject,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'seam', version: '0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  if (previousRoots === undefined) delete process.env['STEPTIX_MCP_ROOTS'];
  else process.env['STEPTIX_MCP_ROOTS'] = previousRoots;
  await client?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  resetRegistry();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('run_test_file over the real HTTP seam', () => {
  it('runs, and every field that shapes the run survived the wire', async () => {
    executedSteps.length = 0;

    const res = await client.callTool({
      name: 'run_test_file',
      arguments: { path: testFilePath },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe('passed');
    expect(structured.projectRoot).toBe(tmpDir);
    expect(structured.sessionId).toBe(`mcp:${testFilePath}`);

    // `envName` arrived: the server resolved ${env.GREETING} from .env.uat,
    // which it can only do if the field survived the allow-list. This is the
    // exact field this seam lost once before.
    expect(executedSteps[0]).toContain('hello-from-uat');

    // `parameters` arrived: {{who}} was substituted.
    expect(executedSteps[0]).toContain('world');

    // `sections` arrived: the bare section name expanded into its body rather
    // than being shipped to the AI as a literal instruction.
    expect(executedSteps).toContain('Say good morning');
    expect(executedSteps).not.toContain('Greet Politely');

    // `env` arrived: the session was built with the PROJECT's AI credentials,
    // not the server process's. Losing this field is silent — runs keep
    // working, they just bill and behave as whoever started the server.
    expect(aiConfigs.at(-1)?.apiKey).toBe('project-ai-key');
    expect(aiConfigs.at(-1)?.model).toBe('project-model');
  }, 30_000);

  it('reports per-step results anchored to the source file', async () => {
    executedSteps.length = 0;

    const res = await client.callTool({
      name: 'run_test_file',
      arguments: { path: testFilePath, session_id: 'mcp:anchored' },
    });

    const steps = (res.structuredContent as { steps: Record<string, unknown>[] }).steps;
    expect(steps.length).toBeGreaterThan(0);

    // `sourceLines` arrived: the first step reports the line it occupies in
    // the test file, not its index in the expanded list.
    const first = steps.find((s) => s.sentIndex === 0);
    expect(first?.line).toBe(10);
    expect(first?.uri).toBe(testFilePath);
    expect(first?.text).toContain('${env.GREETING}');
  }, 30_000);

  it('refuses a real test file that lives outside the allowed roots', async () => {
    // A file that genuinely exists and is genuinely runnable — otherwise the
    // missing-file check answers first and the confinement rule is never
    // exercised. This is the case that matters: an agent naming a real
    // project it was not given.
    const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-outside-')));
    const strayFile = path.join(elsewhere, 'stray.md');
    await fs.writeFile(strayFile, '# Stray\n\n## Steps\n1. Do something\n');

    try {
      const res = await client.callTool({
        name: 'run_test_file',
        arguments: { path: strayFile },
      });

      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('STEPTIX_MCP_ROOTS');
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports a missing file as missing', async () => {
    const res = await client.callTool({
      name: 'run_test_file',
      arguments: { path: path.join(tmpDir, 'tests', 'nope.md') },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('No such file');
  });

  it('lists the project\'s test files', async () => {
    const res = await client.callTool({ name: 'list_test_files', arguments: {} });

    const files = (res.structuredContent as { files: string[] }).files;
    expect(files.map((f) => path.resolve(f))).toContain(path.resolve(testFilePath));
  });

  it('reports the live server through server_status', async () => {
    const res = await client.callTool({ name: 'server_status', arguments: {} });

    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.running).toBe(true);
    expect(structured.openSessions).toBeGreaterThanOrEqual(0);
  });
});
