/**
 * `run_errand` driven through the real stack: a real MCP client over a real
 * transport, the real tab matcher, the real HTTP client, and the real
 * `createApiServer` over a real socket — with only the browser and the step
 * executor faked.
 *
 * This exists for the same class of bug as its `run_test_file` sibling:
 * `api-server.ts` builds the errand request from an explicit per-field
 * allow-list, so widening a type compiles cleanly and drops the field at
 * runtime. But it also covers the claim that makes an errand an errand, which
 * only an end-to-end test can make at all — that **nothing of it survives**.
 * A test that inspects the runner in isolation cannot tell you whether
 * `list_sessions` gained a row.
 *
 * Verification items (1), (4), (6) and (7) of stories/errands.md live here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// The user's browser: three tabs they opened themselves, none of them ours.
// ---------------------------------------------------------------------------

interface FakePage {
  targetId: string;
  /** The plain strings the DevTools listing reports. `page.title()` is async,
   *  so reading it back through the mock would put a Promise in the listing. */
  urlText: string;
  titleText: string;
  url: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  bringToFront: ReturnType<typeof vi.fn>;
  closed: boolean;
}

function makePage(targetId: string, url: string, title: string): FakePage {
  const page: FakePage = {
    targetId,
    urlText: url,
    titleText: title,
    url: vi.fn(() => url),
    title: vi.fn(async () => title),
    close: vi.fn(async () => {
      page.closed = true;
    }),
    bringToFront: vi.fn(async () => {}),
    closed: false,
  };
  return page;
}

const CDP_PORT = 51000;

/** Two tabs share a host so a bare name can be genuinely ambiguous, and one is
 *  distinct so it can be borrowed by name. */
const TABS = [
  makePage('tab-cart', 'https://shop.example/cart', 'Cart — Shop'),
  makePage('tab-archive', 'https://shop.example/archive', 'Archive — Shop'),
  makePage('tab-mail', 'https://mail.example/inbox', 'Inbox'),
];

vi.mock('../src/browser/cdp-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/cdp-registry.js')>();
  return {
    ...actual,
    // The whole sweep, so no filesystem is read and no browser is spawned. The
    // tabs are the listing the MCP matcher gets to work with — and they are the
    // page-type-filtered view, which is what stops an iframe ever being a
    // candidate.
    knownProfilesAcross: async () => [
      {
        engine: 'edge',
        profile: 'default',
        profileDir: 'C:/proj/.aiui/cdp-profiles/edge-default',
        live: true,
        port: CDP_PORT,
        scope: 'project',
        tabs: TABS.filter((p) => !p.closed).map((p) => ({
          targetId: p.targetId,
          title: p.titleText,
          url: p.urlText,
        })),
      },
    ],
  };
});

vi.mock('../src/browser/manager.js', () => {
  /** The real tracker's one load-bearing rule: a page open at attach time is on
   *  the ignore list and is never tracked, so "never closes a tab it did not
   *  open" is a claim about the errand and not about this fake. */
  class PageTracker {
    pages: { page: any; label: string; targetId: string | null; unexpected: boolean }[] = [];
    private ignored: Set<any>;
    constructor(initialPage: any, ignoredPages?: Set<any>) {
      this.pages.push({
        page: initialPage,
        label: 'main',
        targetId: initialPage.targetId ?? null,
        unexpected: false,
      });
      this.ignored = ignoredPages ?? new Set();
    }
    addPage(page: any): string | null {
      if (this.ignored.has(page)) return null;
      this.pages.push({
        page,
        label: `page:${this.pages.length + 1}`,
        targetId: page.targetId ?? null,
        unexpected: true,
      });
      return `page:${this.pages.length}`;
    }
    tabs() {
      return this.pages;
    }
    getActive() {
      return this.pages[0]!.page;
    }
    async describeActiveTab() {
      const entry = this.pages[0]!;
      return {
        label: entry.label,
        targetId: entry.targetId,
        url: entry.page.url(),
        title: await entry.page.title(),
        unexpected: entry.unexpected,
      };
    }
    async resolvedTargetIds() {
      return {
        ids: this.pages.map((p) => p.targetId).filter((id): id is string => !!id),
        complete: true,
      };
    }
    async activeTabRef() {
      const entry = this.pages[0]!;
      return { targetId: entry.targetId, url: entry.page.url() };
    }
  }

  class BrowserTracker {
    sessions: any[] = [];
    constructor(initialSession: any) {
      this.sessions.push(initialSession);
    }
    all() {
      return this.sessions;
    }
    getActive() {
      return this.sessions[this.sessions.length - 1];
    }
    closeAll = vi.fn(async () => {
      this.sessions.length = 0;
    });
  }

  return {
    PageTracker,
    BrowserTracker,
    launchBrowser: vi.fn(async (_config: unknown, cdp?: { port: number; tab?: string }) => {
      if (!cdp) throw new Error('this suite only attaches over CDP');
      const targetId = String(cdp.tab ?? '').replace(/^targetId:/, '');
      const page = TABS.find((p) => p.targetId === targetId && !p.closed);
      if (!page) throw new Error(`CDP: no tab matches targetId "${targetId}".`);
      const preExisting = new Set<any>(TABS);
      preExisting.delete(page);
      return {
        browser: { isConnected: () => true },
        context: {},
        page,
        pageTracker: new PageTracker(page, preExisting),
        cdp: true,
        // A `targetId:` attach never opens a tab, so the borrowed one is never
        // the attach's to close.
        cdpTabOpenedByUs: false,
      };
    }),
    closeBrowser: vi.fn(async (session: any) => {
      if (session.cdp && session.cdpTabOpenedByUs) await session.page.close();
    }),
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

/** Every instruction the executor really received — the seam where a
 *  `{{placeholder}}` either resolved or did not. */
const executedSteps: string[] = [];
const CAPTURED_VALUE = 'A-4417';

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(
    async (
      _i: number,
      _t: number,
      instruction: string,
      options: { resolvedParameters: Record<string, string> },
    ): Promise<StepResult> => {
      executedSteps.push(instruction);
      // What a real `read ... as X` does: the executor is what writes a capture
      // into the run's parameter map, and the enriched instruction is how an
      // `[output: X]` prefix arrives here.
      const capture = /\[store as: (\w+)\]/.exec(instruction);
      if (capture) options.resolvedParameters[capture[1]!] = CAPTURED_VALUE;
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

/** AI config each run was constructed with — the only observable effect of the
 *  request's `env` field surviving the wire. */
const aiConfigs: { apiKey?: string; model?: string }[] = [];

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    constructor(config: { apiKey?: string; model?: string }) {
      aiConfigs.push(config ?? {});
    }
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

/** Nothing may call this. An errand writes no report — the receipt IS the
 *  report — so the mock exists to be asserted un-called. */
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApiServer } from '../src/server/api-server.js';
import { generateReport as generateReportMock } from '../src/report/generator.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createApiClient } from '../src/mcp/api-client.js';
import { resolveProject } from '../src/mcp/project.js';
import { resetRegistry } from '../src/mcp/registry.js';

const API_KEY = 'sk-errand-real-app';

const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 'server-model', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let client: Client;
let tmpDir: string;
let previousRoots: string | undefined;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Ordering matters: the project's .env carries SERVER_URL, and the port only
  // exists once the server is listening.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-errand-')));
  await fs.writeFile(
    path.join(tmpDir, '.env'),
    `SERVER_URL=${baseUrl}\nAIUI_SERVER_API_KEY=${API_KEY}\nAI_API_KEY=project-ai-key\nAI_MODEL=project-model\n`,
  );
  await fs.writeFile(path.join(tmpDir, 'aiui.config.json'), JSON.stringify({ tests: { dir: './tests' } }));

  previousRoots = process.env['AIUI_MCP_ROOTS'];
  process.env['AIUI_MCP_ROOTS'] = tmpDir;

  const mcp = createMcpServer({
    createApiClient,
    // The server is already up; this test is about the request path.
    ensureServerReady: async () => {},
    // A bare `createApiServer` serves no /health route through this harness, so
    // the identity probe would refuse a server we know is ours.
    assertServerRecognized: async () => {},
    resolveProject,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'errand-seam', version: '0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  if (previousRoots === undefined) delete process.env['AIUI_MCP_ROOTS'];
  else process.env['AIUI_MCP_ROOTS'] = previousRoots;
  await client?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  resetRegistry();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function listSessionIds(): Promise<string[]> {
  const res = await client.callTool({ name: 'list_sessions', arguments: { project_root: tmpDir } });
  return ((res.structuredContent as { sessions: { sessionId: string }[] }).sessions ?? [])
    .map((s) => s.sessionId)
    .sort();
}

function content(result: unknown): string {
  return JSON.stringify((result as { content: unknown }).content);
}

describe('run_errand over the real HTTP seam', () => {
  it('drives the named tab and creates no session (item 1)', async () => {
    executedSteps.length = 0;
    const before = await listSessionIds();

    const res = await client.callTool({
      name: 'run_errand',
      arguments: {
        tab: 'title~Cart',
        profile: 'default',
        steps: ['click the checkout button'],
        project_root: tmpDir,
      },
    });

    expect(res.isError, content(res)).toBeFalsy();
    const receipt = res.structuredContent as Record<string, unknown>;
    expect(receipt.status).toBe('passed');
    expect(receipt.errandId).toMatch(/^errand-[0-9a-f]+$/);
    expect(executedSteps).toContain('click the checkout button');

    // The claim that makes an errand an errand: no session, before or after.
    expect(await listSessionIds()).toEqual(before);

    // `env` survived the allow-list: the run was built with the PROJECT's AI
    // credentials, not the server process's. Losing this field is silent —
    // errands keep working, they just bill and behave as whoever started the
    // server.
    expect(aiConfigs.at(-1)?.apiKey).toBe('project-ai-key');
    expect(aiConfigs.at(-1)?.model).toBe('project-model');
  }, 30_000);

  it('returns a complete receipt, writes no report, and holds no variables (item 4)', async () => {
    executedSteps.length = 0;

    const first = await client.callTool({
      name: 'run_errand',
      arguments: {
        tab: 'targetId:tab-cart',
        steps: ['[output: orderId] read the order number'],
        project_root: tmpDir,
      },
    });

    expect(first.isError, content(first)).toBeFalsy();
    const receipt = first.structuredContent as Record<string, unknown>;

    // Every field the story's §Return names, from the real runner.
    expect(receipt.root).toBe(tmpDir);
    expect(receipt.scope).toBe('project');
    expect(receipt.captures).toEqual({ orderId: CAPTURED_VALUE });
    expect(receipt.finalUrl).toBe('https://shop.example/cart');
    expect(receipt.finalTitle).toBe('Cart — Shop');
    expect(receipt.openedTabs).toEqual([]);
    expect(receipt.keptOpen).toEqual([]);
    expect((receipt.steps as unknown[])).toHaveLength(1);
    // The settings the errand ran under: server base → project bundle, with no
    // session layer to hold an override.
    expect(receipt.effectiveSettings).toMatchObject({ screenshotsReturn: 'on-failure' });

    // No report file, checked two ways: nothing generated one, and the project
    // gained no report directory.
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(existsSync(path.join(tmpDir, 'reports'))).toBe(false);

    // A second errand starts from nothing. The receipt's per-step `text` echoes
    // what was SENT, so it cannot discriminate — only the executor seam can.
    executedSteps.length = 0;
    const second = await client.callTool({
      name: 'run_errand',
      arguments: {
        tab: 'targetId:tab-cart',
        steps: ['search for order {{orderId}}'],
        project_root: tmpDir,
      },
    });

    expect(second.isError, content(second)).toBeFalsy();
    expect(executedSteps).toContain('search for order {{orderId}}');
    expect(executedSteps.join('\n')).not.toContain(CAPTURED_VALUE);
    expect((second.structuredContent as { captures: Record<string, string> }).captures).toEqual({});
    // And it is not an error — exactly as an unresolved placeholder would not
    // be one on `run_steps`.
    expect((second.structuredContent as { status: string }).status).toBe('passed');
  }, 30_000);

  it('refuses session_id before it touches anything (item 6)', async () => {
    executedSteps.length = 0;
    const before = await listSessionIds();

    const res = await client.callTool({
      name: 'run_errand',
      arguments: {
        tab: 'targetId:tab-cart',
        steps: ['click the checkout button'],
        session_id: 'mcp:steps-1',
        project_root: tmpDir,
      },
    });

    expect(res.isError).toBe(true);
    expect(content(res)).toContain('run_steps');
    expect(executedSteps).toEqual([]);
    expect(await listSessionIds()).toEqual(before);
  });

  it('refuses a name matching nothing, listing what is open (item 7)', async () => {
    executedSteps.length = 0;

    const res = await client.callTool({
      name: 'run_errand',
      arguments: { tab: 'the invoices tab', steps: ['click something'], project_root: tmpDir },
    });

    expect(res.isError).toBe(true);
    // The real listing, straight off the real route.
    expect(content(res)).toContain('Cart — Shop');
    expect(content(res)).toContain('Inbox');
    expect(executedSteps).toEqual([]);
  });

  it('refuses a name matching two, naming both (item 7)', async () => {
    executedSteps.length = 0;

    const res = await client.callTool({
      name: 'run_errand',
      arguments: { tab: 'shop.example', steps: ['click something'], project_root: tmpDir },
    });

    expect(res.isError).toBe(true);
    expect(content(res)).toContain('tab-cart');
    expect(content(res)).toContain('tab-archive');
    // Not the one that did not match.
    expect(content(res)).not.toContain('tab-mail');
    expect(executedSteps).toEqual([]);
  });
});
