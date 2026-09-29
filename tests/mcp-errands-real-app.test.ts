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
 * Verification items (1), (2), (3), (4), (6) and (7) of stories/errands.md live
 * here. Item (5)'s tab accounting is here too as far as a receipt can show it;
 * its mocked-Playwright-seam assertions — which page was closed, which was
 * raised — are in `api-server-errands.test.ts`, where the fake browser is
 * reachable.
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

/**
 * The browser's raw `/json/list`, as Chromium actually reports it: real tabs
 * alongside three things that are not tabs, each of them named so it would
 * match the same words a real tab does.
 *
 * Raw rather than pre-filtered because the filter is what item (7)'s last
 * clause is about. Writing the filtered list here would assert the fixture;
 * this way the candidate set is whatever the REAL `toPageTabs` makes of it.
 */
function rawDevToolsTargets(): unknown[] {
  return [
    ...TABS.filter((p) => !p.closed).map((p) => ({
      id: p.targetId,
      type: 'page',
      title: p.titleText,
      url: p.urlText,
    })),
    {
      id: 'frame-cart-promo',
      type: 'iframe',
      title: 'Cart — Shop promo',
      url: 'https://shop.example/cart/promo',
    },
    {
      id: 'ui-omnibox',
      type: 'browser_ui',
      title: 'Cart — Shop omnibox',
      url: 'edge://omnibox/',
    },
    {
      id: 'dialog-sync',
      type: 'page',
      title: 'Cart — Shop sync',
      url: 'edge://sync-confirmation-dialog/',
    },
  ];
}

/** A DevTools HTTP surface with nothing behind it. The two endpoints
 *  `probePort` reads, and a throw for anything else so a silent shape change
 *  cannot pass as an empty browser. */
const devToolsFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.endsWith('/json/version')
    ? { Browser: 'Edg/151.0.0.0' }
    : url.endsWith('/json/list')
      ? rawDevToolsTargets()
      : null;
  if (body === null) throw new Error(`unexpected DevTools fetch: ${url}`);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

vi.mock('../src/browser/cdp-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/cdp-registry.js')>();
  const discovery = await import('../src/browser/cdp-discovery.js');
  return {
    ...actual,
    // The whole sweep, so no filesystem is read and no browser is spawned —
    // but the TABS half runs the real probe over the faked DevTools surface
    // above, so `toPageTabs` is the product's filter rather than a stand-in.
    knownProfilesAcross: async () => {
      const probed = await discovery.probePort(CDP_PORT, 1_000, devToolsFetch);
      return [
        {
          engine: 'edge',
          profile: 'default',
          profileDir: 'C:/proj/.steptix/cdp-profiles/edge-default',
          live: true,
          port: CDP_PORT,
          scope: 'project',
          tabs: probed.tabs ?? [],
        },
      ];
    },
  };
});

vi.mock('../src/browser/manager.js', () => {
  /**
   * The real tracker's two load-bearing rules, so "never closes a tab it did not
   * open" is a claim about the errand and not about this fake: a page open at
   * attach time is on the ignore list and is never tracked, and every page that
   * IS adopted starts `unexpected` until `markExpected` claims it — which the
   * real `openPage` action does (step-executor.ts:869).
   */
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
    markExpected(page: any): void {
      const entry = this.pages.find((p) => p.page === page);
      if (entry) entry.unexpected = false;
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

  // NEVER REJECTS, like the real one (manager.ts:1541 wraps its whole body and
  // logs), and a close that worked severs the connection — which is what the
  // detach reads to tell a closed browser from a wedged one.
  //
  // Declared out here, not inline below, because `BrowserTracker.close` routes
  // through it exactly as the real tracker routes through the real one.
  const closeBrowser = vi.fn(async (session: any) => {
    try {
      if (session.cdp && session.cdpTabOpenedByUs) await session.page.close();
    } catch {
      return;
    }
    session.browser = { isConnected: () => false };
  });

  class BrowserTracker {
    sessions: { label: string; session: any }[] = [];
    constructor(initialSession: any, initialLabel = 'default') {
      this.sessions.push({ label: initialLabel, session: initialSession });
    }
    add(label: string, session: any): void {
      this.sessions.push({ label, session });
    }
    all() {
      return this.sessions.map((s) => s.session);
    }
    getActive() {
      return this.sessions[this.sessions.length - 1]!.session;
    }
    hasActive(): boolean {
      return this.sessions.length > 0;
    }
    /** Lazy twin of the real static (SPEC-use-computer.md §4.6): the deferred
     *  tracker starts with NO session and launches on first use. */
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker(undefined as any);
      tracker.sessions.length = 0;
      (tracker as any).launch = launch;
      return tracker;
    }
    async ensureLaunched(): Promise<any> {
      if (this.sessions.length > 0) return this.getActive();
      const session = await (this as any).launch();
      this.sessions.push({ label: 'default', session });
      return session;
    }
    /**
     * The real one's load-bearing half (manager.ts:877): route through
     * `closeBrowser`, then SPLICE the session out — so a browser a step closed
     * is gone from `all()`, and with it every tab it ever held.
     *
     * Carried here because the errand runner WRAPS this method to sweep the
     * launched trackers before that splice; a stand-in missing it is not a
     * stand-in for the class the runner is handed. No errand in this suite opens
     * a second browser, so nothing here calls it — it exists so the wrap has
     * something real to wrap.
     */
    async close(label: string): Promise<void> {
      const idx = this.sessions.findIndex((s) => s.label === label);
      if (idx === -1) throw new Error(`No browser registered as "${label}"`);
      const { session } = this.sessions[idx]!;
      try {
        await closeBrowser(session);
      } catch {
        // The real one logs and splices anyway.
      }
      this.sessions.splice(idx, 1);
    }
    closeAll = vi.fn(async () => {
      this.sessions.length = 0;
    });
  }

  return {
    PageTracker,
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
    closeBrowser,
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
import { executeStep as executeStepMock } from '../src/runner/step-executor.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createApiClient } from '../src/mcp/api-client.js';
import { resolveProject } from '../src/mcp/project.js';
import { resetRegistry } from '../src/mcp/registry.js';
import {
  describeBrowser,
  errandDidNotAttach,
  errandTabHeldByErrand,
  errandTabHeldBySession,
  errandTabNotFound,
} from '../src/mcp/errors.js';

const API_KEY = 'sk-errand-real-app';

const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 'server-model', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
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
    `SERVER_URL=${baseUrl}\nSTEPTIX_SERVER_API_KEY=${API_KEY}\nAI_API_KEY=project-ai-key\nAI_MODEL=project-model\n`,
  );
  // An environment with a name, so `${env.X}` is actually resolved rather than
  // passed through — which is the only state in which an UNKNOWN name throws.
  await fs.writeFile(path.join(tmpDir, '.env.uat'), 'ERRAND_USER=zoe\n');
  await fs.writeFile(path.join(tmpDir, 'steptix.config.json'), JSON.stringify({ tests: { dir: './tests' } }));

  previousRoots = process.env['STEPTIX_MCP_ROOTS'];
  process.env['STEPTIX_MCP_ROOTS'] = tmpDir;

  const mcp = createMcpServer({
    createApiClient,
    // The server is already up; this test is about the request path.
    ensureServerReady: async () => {},
    // Never called: `withProject` only reaches this dep when a tool passes
    // `autoStart: false` (none does), and the one tool that calls it directly
    // is `get_run_settings`, which this suite never drives. It is here because
    // `McpDeps` requires it, not because anything reads it — the /health route
    // it would probe IS served by this app, `createApiServer` registering it
    // unconditionally.
    assertServerRecognized: async () => {},
    resolveProject,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'errand-seam', version: '0' });
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

async function listSessionIds(): Promise<string[]> {
  const res = await client.callTool({ name: 'list_sessions', arguments: { project_root: tmpDir } });
  return ((res.structuredContent as { sessions: { sessionId: string }[] }).sessions ?? [])
    .map((s) => s.sessionId)
    .sort();
}

function content(result: unknown): string {
  return JSON.stringify((result as { content: unknown }).content);
}

/** The refusal as a model reads it, for comparison against the exported error
 *  builders — a substring match decays the moment either side is reworded. */
function textOf(result: unknown): string {
  return (result as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('\n');
}

/** The one text an `McpToolError` builder carries. */
function errorText(built: { content: { text: string }[] }): string {
  return built.content.map((c) => c.text).join('\n');
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
    // session layer to hold an override. Asserted on a SERVER-derived value —
    // the model the project's own .env named, which only the `done` frame can
    // carry — because `screenshotsReturn` is decided on this side of the wire
    // and reads the same whether the server reported anything at all.
    expect(receipt.effectiveSettings).toMatchObject({
      model: 'project-model',
      sources: { model: 'project' },
      screenshotsReturn: 'on-failure',
    });

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

  it('refuses a second errand on a tab one is driving, then lets the retry in (item 3)', async () => {
    // Verification item (3), end to end: two real `run_errand` calls through
    // the real MCP client, the real HTTP client and the real route. Nothing
    // between the tool and the lock is stubbed, which is the only way to prove
    // the 409 does not reach the model as `errandDidNotAttach`'s "the tab may
    // have been closed" — advice that would send it re-listing a tab that is
    // open and busy.
    executedSteps.length = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (markStarted = r));
    const original = vi.mocked(executeStepMock).getMockImplementation()!;
    vi.mocked(executeStepMock).mockImplementation(async (i, t, instruction, options) => {
      markStarted();
      await gate;
      return original(i, t, instruction, options);
    });

    const args = {
      tab: 'title~Cart',
      steps: ['click the checkout button'],
      project_root: tmpDir,
    };
    const first = client.callTool({ name: 'run_errand', arguments: args });
    let second: Awaited<ReturnType<typeof client.callTool>>;
    try {
      await started;
      second = await client.callTool({ name: 'run_errand', arguments: args });
      expect(second.isError, content(second)).toBe(true);
    } finally {
      // A parked errand outlives a failed assertion and keeps its holds, which
      // would fail every later test in this file for the wrong reason.
      release();
      vi.mocked(executeStepMock).mockImplementation(original);
    }
    const firstRes = await first;
    expect(firstRes.isError, content(firstRes)).toBeFalsy();
    const holder = (firstRes.structuredContent as { errandId: string }).errandId;

    // Word for word the turn-lock refusal, naming the errand that was actually
    // holding the wheel. Equality rather than "does not say 'never got tab'":
    // this is the one place the `holder` shape is proved to have routed the 409
    // to its own message instead of to the attach refusal ("the tab may have
    // been closed") or the generic HTTP arm — and both of those would still
    // pass a list of things the text must not contain, after a reword.
    expect(textOf(second)).toBe(errorText(errandTabHeldByErrand(holder, 'borrowed', args.tab)));

    // The remedy it offered is a real one.
    const retry = await client.callTool({ name: 'run_errand', arguments: args });
    expect(retry.isError, content(retry)).toBeFalsy();
    expect((retry.structuredContent as { errandId: string }).errandId).not.toBe(holder);

    // And not one of the three left a session behind.
    expect(await listSessionIds()).toEqual([]);
  }, 30_000);

  it('refuses a retry naming a tab the holder OPENED, with the zero-match refusal (item 3)', async () => {
    // The other half of what that refusal promised. It said the tab would
    // normally be GONE by the time the wait ended, because an errand closes
    // what it opened — so the retry does not meet a second lock 409, it meets
    // "no tab matches", listing what actually is open.
    const receiptTab = makePage('tab-receipt', 'https://shop.example/receipt', 'Receipt — Shop');
    const original = vi.mocked(executeStepMock).getMockImplementation()!;
    try {
      vi.mocked(executeStepMock).mockImplementation(async (i, t, instruction, options) => {
        const tracker = (options as unknown as { pageTracker?: { addPage: (p: unknown) => void; markExpected: (p: unknown) => void } }).pageTracker;
        // Appearing DURING the run is the point: a tab already in TABS at attach
        // time is on the tracker's ignore list and never adopted at all.
        // `openPage`'s own two calls, in its order.
        TABS.push(receiptTab);
        tracker?.addPage(receiptTab);
        tracker?.markExpected(receiptTab);
        return original(i, t, instruction, options);
      });

      const opened = await client.callTool({
        name: 'run_errand',
        arguments: { tab: 'targetId:tab-cart', steps: ['open the receipt'], project_root: tmpDir },
      });
      expect(opened.isError, content(opened)).toBeFalsy();
      expect((opened.structuredContent as { openedTabs: unknown }).openedTabs).toEqual([
        { targetId: 'tab-receipt', url: 'https://shop.example/receipt', title: 'Receipt — Shop' },
      ]);
      // Taken with its coat — and therefore out of the listing the next match
      // runs against, which is what makes the refusal below the right one.
      expect(receiptTab.closed).toBe(true);
    } finally {
      vi.mocked(executeStepMock).mockImplementation(original);
    }

    const retry = await client.callTool({
      name: 'run_errand',
      arguments: { tab: 'targetId:tab-receipt', steps: ['click something'], project_root: tmpDir },
    });

    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toBe(
      errorText(
        errandTabNotFound(
          'targetId:tab-receipt',
          describeBrowser({ engine: 'edge', profile: 'default', scope: 'project' }),
          TABS.filter((p) => !p.closed).map((p) => ({
            targetId: p.targetId,
            title: p.titleText,
            url: p.urlText,
          })),
        ),
      ),
    );
  }, 30_000);

  it('never makes an iframe, a browser_ui target or a dialog a candidate (item 7)', async () => {
    // The listing's page-type filter, running for real: the fake DevTools
    // surface behind this suite reports an iframe, a browser_ui target and an
    // `edge://…-dialog` page whose titles all contain "Cart — Shop", so any of
    // them WOULD match if the candidate set were the raw target list.
    executedSteps.length = 0;
    for (const spec of ['targetId:frame-cart-promo', 'targetId:ui-omnibox', 'targetId:dialog-sync']) {
      const res = await client.callTool({
        name: 'run_errand',
        arguments: { tab: spec, steps: ['click something'], project_root: tmpDir },
      });
      expect(res.isError, `${spec}: ${content(res)}`).toBe(true);
      expect(textOf(res), spec).toBe(
        errorText(
          errandTabNotFound(
            spec,
            describeBrowser({ engine: 'edge', profile: 'default', scope: 'project' }),
            TABS.filter((p) => !p.closed).map((p) => ({
              targetId: p.targetId,
              title: p.titleText,
              url: p.urlText,
            })),
          ),
        ),
      );
    }
    // Control: the three are not merely absent from the listing, they are
    // absent from the candidate set for a name they all carry — "Cart — Shop"
    // still resolves to exactly one tab.
    const one = await client.callTool({
      name: 'run_errand',
      arguments: { tab: 'Cart — Shop', steps: ['click something'], project_root: tmpDir },
    });
    expect(one.isError, content(one)).toBeFalsy();
    expect(executedSteps).toEqual(['click something']);
  }, 30_000);

  it('reports an unresolvable ${env.X} as the step it failed on, receipt and all', async () => {
    // The throw that used to escape BETWEEN steps: `interpolateEnvData` refuses
    // an unknown name once an env bundle exists, and that pass sat outside the
    // per-step try. The request then ended with no errand block on its `done`
    // frame, and the tool answered "the errand never got the tab" — about a tab
    // step 1 had already driven.
    executedSteps.length = 0;
    const res = await client.callTool({
      name: 'run_errand',
      arguments: {
        tab: 'targetId:tab-cart',
        env_name: 'uat',
        steps: ['click the checkout button', 'sign in as ${env.NOT_IN_ANY_ENV_FILE}'],
        project_root: tmpDir,
      },
    });

    // A receipt, not an `isError`: the errand ran, and what it did to a real
    // page is the thing the caller most needs back.
    expect(res.isError, content(res)).toBeFalsy();
    const receipt = res.structuredContent as Record<string, unknown>;
    expect(receipt.errandId).toMatch(/^errand-[0-9a-f]+$/);
    expect(receipt.status).toBe('error');
    expect(receipt.finalUrl).toBe('https://shop.example/cart');

    // Step 1 really ran and is recorded; step 2 is the one that failed, by name.
    expect(executedSteps).toEqual(['click the checkout button']);
    const steps = receipt.steps as { status: string; error: string | null }[];
    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe('passed');
    expect(steps[1]!.status).toBe('failed');
    expect(String(steps[1]!.error)).toContain('NOT_IN_ANY_ENV_FILE');

    // …and the "nothing ran" refusal is ruled out by its own builder rather
    // than by a sentence someone can reword.
    expect(textOf(res)).not.toContain(
      errorText(errandDidNotAttach('targetId:tab-cart', null)),
    );
  }, 30_000);

  // -------------------------------------------------------------------------
  // Item (2), and the session half of item (3), through the real tools rather
  // than the raw route: a real `run_steps` session on the same tab.
  // -------------------------------------------------------------------------

  /**
   * A `run_steps` batch on the shared tab, through the door sessions use.
   *
   * `bind` sends `config.cdp`, which the server only honours when it CREATES
   * the session — so it belongs on a session's first batch and nowhere else.
   *
   * Each test uses its own `id`, and that is not tidiness: the MCP process
   * remembers which session ids it has configured (`src/mcp/registry.ts`), so a
   * closed id reused by the next test has its `config` stripped client-side and
   * the server builds a launch-mode session instead of a CDP one.
   */
  function sessionSteps(id: string, steps: string[], bind: boolean) {
    return client.callTool({
      name: 'run_steps',
      arguments: {
        session_id: id,
        steps,
        project_root: tmpDir,
        ...(bind ? { config: { cdp: { profile: 'default', tab: 'targetId:tab-mail' } } } : {}),
      },
    });
  }

  function closeSession(id: string) {
    return client.callTool({
      name: 'close_session',
      arguments: { session_id: id, project_root: tmpDir },
    });
  }

  it('borrows a tab an IDLE session sits on, and that session still works after (item 2)', async () => {
    // Idle is the safe case; mid-run is the dangerous one. Refusing both would
    // put the two-client coexistence this story measured out of reach of the
    // tool — so this is the case that has to keep working, on BOTH sides.
    const id = 'mcp:errand-idle';
    executedSteps.length = 0;
    const bound = await sessionSteps(id, ['read the inbox'], true);
    expect(bound.isError, content(bound)).toBeFalsy();
    expect((bound.structuredContent as { status: string }).status).toBe('passed');
    expect(await listSessionIds()).toEqual([id]);

    try {
      const errand = await client.callTool({
        name: 'run_errand',
        arguments: {
          tab: 'targetId:tab-mail',
          steps: ['archive the first mail'],
          project_root: tmpDir,
        },
      });
      expect(errand.isError, content(errand)).toBeFalsy();
      expect((errand.structuredContent as { status: string }).status).toBe('passed');

      // The half a DELETE cannot make: the session's NEXT batch. An errand that
      // left the tab or the binding broken shows up here and nowhere else.
      const next = await sessionSteps(id, ['read the inbox again'], false);
      expect(next.isError, content(next)).toBeFalsy();
      expect((next.structuredContent as { status: string }).status).toBe('passed');
      expect(executedSteps).toContain('read the inbox again');

      // And the errand added nothing to the sessions map on its way through.
      expect(await listSessionIds()).toEqual([id]);
    } finally {
      await closeSession(id);
    }
  }, 30_000);

  it('is refused while that session is MID-BATCH, naming the session (item 3)', async () => {
    const id = 'mcp:errand-midbatch';
    executedSteps.length = 0;
    let release!: () => void;
    let markParked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const parked = new Promise<void>((r) => (markParked = r));
    const original = vi.mocked(executeStepMock).getMockImplementation()!;
    vi.mocked(executeStepMock).mockImplementation(async (i, t, instruction, options) => {
      if (String(instruction).includes('park')) {
        markParked();
        await gate;
      }
      return original(i, t, instruction, options);
    });

    let refused: Awaited<ReturnType<typeof client.callTool>>;
    let batch: ReturnType<typeof sessionSteps>;
    try {
      const bound = await sessionSteps(id, ['read the inbox'], true);
      expect(bound.isError, content(bound)).toBeFalsy();

      batch = sessionSteps(id, ['park here'], false);
      await parked;
      refused = await client.callTool({
        name: 'run_errand',
        arguments: { tab: 'targetId:tab-mail', steps: ['archive it'], project_root: tmpDir },
      });
      expect(refused.isError, content(refused)).toBe(true);
    } finally {
      release();
      vi.mocked(executeStepMock).mockImplementation(original);
    }
    expect((await batch!).isError).toBeFalsy();

    // Word for word, so the 409's `holder` is proved to have routed this to the
    // session refusal — which offers close_session as well as waiting, because
    // unlike an errand a session outlives its batch.
    expect(textOf(refused!)).toBe(errorText(errandTabHeldBySession(id, 'targetId:tab-mail')));
    // Nothing ran in the tab, which is what "refused before any browser work"
    // means from the caller's side.
    expect(executedSteps).not.toContain('archive it');

    await closeSession(id);
  }, 30_000);

  it('never blocks a run_steps batch on a tab an errand is driving (item 3)', async () => {
    // Sessions take no lock and are refused by none: the errand-only guard is a
    // bounded amendment to mcp-cdp-browser §Locked, whose subject — parallel
    // sessions — is untouched.
    const id = 'mcp:errand-parallel';
    executedSteps.length = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (markStarted = r));
    const original = vi.mocked(executeStepMock).getMockImplementation()!;
    vi.mocked(executeStepMock).mockImplementation(async (i, t, instruction, options) => {
      if (String(instruction).includes('drive slowly')) {
        markStarted();
        await gate;
      }
      return original(i, t, instruction, options);
    });

    const errand = client.callTool({
      name: 'run_errand',
      arguments: { tab: 'targetId:tab-mail', steps: ['drive slowly'], project_root: tmpDir },
    });
    try {
      await started;
      const batch = await sessionSteps(id, ['read the inbox'], true);
      expect(batch.isError, content(batch)).toBeFalsy();
      expect((batch.structuredContent as { status: string }).status).toBe('passed');
    } finally {
      release();
      vi.mocked(executeStepMock).mockImplementation(original);
    }
    expect((await errand).isError).toBeFalsy();

    await closeSession(id);
    expect(await listSessionIds()).toEqual([]);
  }, 30_000);
});
