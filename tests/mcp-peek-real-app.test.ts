/**
 * `peek_tab` driven through the real stack: a real MCP client over a real
 * transport, the real tab matcher, the real HTTP client, and the real
 * `createApiServer` over a real socket — with only the browser and the three
 * browser-side capture functions faked.
 *
 * It exists for the same class of bug as its `run_errand` sibling: the route
 * builds its request from an explicit per-field read, so widening a type
 * compiles cleanly and drops the field at runtime. But it also covers the two
 * claims only an end-to-end test can make at all — that **nothing of a peek
 * survives** (a test that inspects the route in isolation cannot tell you
 * whether `list_sessions` gained a row), and that the capture ran under the
 * PROJECT's settings rather than the library's, which is a fact assembled from
 * a config file, a synthetic path, a project resolver and a route in that
 * order.
 *
 * Verification items (1), (2) and (4) of stories/tab-peek.md live here. Items
 * (3) and (6) — the two tab refusals and the `session_id` wrong door — fire in
 * the tool layer: the `session_id` one before any HTTP, the tab ones after
 * resolving the browser and listing its tabs, decided over that listing
 * alone. So the real server adds nothing to them beyond the listing:
 * they are in `tests/mcp-peek-seam.test.ts`, and the page-type filter over the
 * real listing is pinned once, in `tests/mcp-errands-real-app.test.ts`, since
 * both tools match over the same candidate list. Item (5)'s no-raise clause is
 * asserted in
 * `tests/browser-manager-focus.test.ts` — the only suite that mocks
 * `playwright` itself and can therefore see the attach-path call; a
 * mocked-manager harness like this one cannot fail on it and must not claim
 * it. Item (1)'s in-flight clause and the route's status contract are in
 * `tests/api-server-cdp.test.ts`, over raw HTTP, because neither has a
 * tool-shaped door.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
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
  /** Only `navigate_tab` calls this (stories/navigate-tab.md). */
  goto: ReturnType<typeof vi.fn>;
}

function makePage(targetId: string, url: string, title: string): FakePage {
  const page: FakePage = {
    targetId,
    urlText: url,
    titleText: title,
    // Read through the mutable field, so a `goto` really moves this page —
    // which is what makes a navigate test about navigation rather than about
    // whether we remembered to update a fixture.
    url: vi.fn(() => page.urlText),
    title: vi.fn(async () => page.titleText),
    close: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
    goto: vi.fn(async (to: string) => {
      // A redirect the caller did not ask for, for the one destination that
      // needs proving end to end: you asked for a page and got a sign-in.
      if (to.includes('needs-login')) {
        page.urlText = 'https://accounts.example/login';
        page.titleText = 'Sign in';
        return;
      }
      page.urlText = to;
      page.titleText = `Page at ${to}`;
    }),
  };
  return page;
}

const CDP_PORT = 51000;

/** Two tabs share a host so a bare name can be genuinely ambiguous, and one is
 *  distinct so it can be read by name. */
const TABS = [
  makePage('tab-cart', 'https://shop.example/cart', 'Cart — Shop'),
  makePage('tab-archive', 'https://shop.example/archive', 'Archive — Shop'),
  makePage('tab-mail', 'https://mail.example/inbox', 'Inbox'),
];

/**
 * The browser's raw `/json/list`, as Chromium actually reports it: real tabs
 * alongside three things that are not tabs, each named so it would match the
 * same words a real tab does.
 *
 * Raw rather than pre-filtered, so the listing every name here resolves
 * against is whatever the REAL `toPageTabs` makes of it rather than an
 * assertion about the fixture. (The filter itself is pinned in the errand
 * twin of this file.)
 */
function rawDevToolsTargets(): unknown[] {
  return [
    ...TABS.map((p) => ({ id: p.targetId, type: 'page', title: p.titleText, url: p.urlText })),
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

/** A DevTools HTTP surface with nothing behind it. */
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

vi.mock('../src/browser/cdp-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/cdp-discovery.js')>();
  return {
    ...actual,
    // The peek route's gone-tab pre-check. Routed through the same fake
    // DevTools surface and the same REAL `toPageTabs`, so the route and the
    // listing agree about what a tab is — which is the property that makes the
    // pre-check a gone-tab check rather than a second opinion.
    listPageTabs: (port: number) => actual.listPageTabs(port, 1_000, devToolsFetch),
  };
});

/** Every attach the peek route made, in order — the seam where `activate` and
 *  the exact `targetId:` spec either survived the wire or did not. */
const attaches: { config: unknown; cdp: { port: number; tab?: string; activate?: boolean } }[] = [];
/** Every detach, so a peek that held its connection open is visible. */
const detaches: unknown[] = [];

vi.mock('../src/browser/manager.js', () => {
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

  const closeBrowser = vi.fn(async (session: any) => {
    detaches.push(session);
    // Faithful to the real one on the clause that matters: it CLOSES a tab the
    // attach itself opened. Modelling that is what lets this suite fail when a
    // caller who opened a tab on purpose forgets to disown it
    // (stories/navigate-tab.md — found live, and only because of this line can
    // it be found here).
    if (session.cdp && session.cdpTabOpenedByUs) await session.page.close();
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
    async close(label: string): Promise<void> {
      const idx = this.sessions.findIndex((s) => s.label === label);
      if (idx === -1) throw new Error(`No browser registered as "${label}"`);
      await closeBrowser(this.sessions[idx]!.session);
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
    launchBrowser: vi.fn(
      async (
        config: unknown,
        cdp?: { port: number; tab?: string; activate?: boolean },
      ) => {
        if (!cdp) throw new Error('this suite only attaches over CDP');
        attaches.push({ config, cdp });
        // The `new` arm, which only `navigate_tab` asks for: a tab that did not
        // exist a moment ago, with every pre-existing one ignored so nothing
        // treats them as ours.
        if (cdp.tab === 'new') {
          const opened = makePage('tab-opened', 'about:blank', 'New Tab');
          return {
            browser: { isConnected: () => true },
            context: {},
            page: opened,
            pageTracker: new PageTracker(opened, new Set<any>(TABS)),
            cdp: true,
            cdpTabOpenedByUs: true,
          };
        }
        const targetId = String(cdp.tab ?? '').replace(/^targetId:/, '');
        const page = TABS.find((p) => p.targetId === targetId);
        if (!page) throw new Error(`CDP: no tab matches targetId "${targetId}".`);
        const preExisting = new Set<any>(TABS);
        preExisting.delete(page);
        return {
          browser: { isConnected: () => true },
          context: {},
          page,
          pageTracker: new PageTracker(page, preExisting),
          cdp: true,
          cdpTabOpenedByUs: false,
        };
      },
    ),
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

/**
 * The whole visible text of the fake page — long enough that a small
 * `max_chars` really clips it.
 */
const PAGE_TEXT = 'Cart — Shop\n'.repeat(60);

/** The DOM the fake page reports, before any limit is applied. */
const PAGE_DOM = `<html><body>${'<div>row</div>'.repeat(80)}</body></html>`;

/**
 * The dom options each capture was handed. This is where item (2) is decided:
 * what is on trial is WHICH settings reached the browser-side capture, and
 * that is a fact about the config file, the synthetic path, the project
 * resolver and the route — none of which is faked here.
 */
const domCaptureOptions: { domSnapshotCharLimit?: number; maxIframeDepth?: number }[] = [];

/**
 * A real 1×1 PNG. Decodable on purpose: the MCP SDK validates an image block's
 * `data` as base64 and rejects the whole result otherwise, so a placeholder
 * would fail a screenshot assertion for a reason unrelated to what is on trial.
 */
const SHOT_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The `fullPage` argument each screenshot capture was handed — the screenshot
 * twin of `domCaptureOptions`, and on trial for the same reason
 * (stories/cdp-tab-screenshot.md). `full_page` is read out field by field at
 * four separate layers (tool args → client query string → route parser →
 * capture call), so widening a type compiles cleanly and drops it at runtime.
 */
const screenshotFullPage: boolean[] = [];

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return {
    ...actual,
    captureVisibleText: vi.fn(async () => PAGE_TEXT),
    // Enforces the limit it is GIVEN, exactly as the real one does
    // (dom-cleaner.ts:421) — including the marker `domSnapshotWasClipped`
    // reads, which stays the real function so the `truncated` derivation is
    // the product's.
    captureDomSnapshot: vi.fn(
      async (_page: unknown, opts: { domSnapshotCharLimit?: number; maxIframeDepth?: number }) => {
        domCaptureOptions.push(opts);
        const limit = opts.domSnapshotCharLimit ?? 100_000;
        if (PAGE_DOM.length <= limit) return PAGE_DOM;
        return (
          PAGE_DOM.substring(0, limit) +
          '\n<!-- DOM snapshot truncated — page content exceeds size limit -->'
        );
      },
    ),
    expandDomSubtree: vi.fn(async (_page: unknown, selector: string) => `<div id="${selector}"/>`),
  };
});

/** Every instruction the step executor really received, so a `run_steps`
 *  session can be driven onto the same tab a peek then reads. */
const executedSteps: string[] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (_i: number, _t: number, instruction: string): Promise<StepResult> => {
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
  }),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
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

/** Nothing may call this. A peek writes no report — there is no run to report
 *  on — so the mock exists to be asserted un-called. */
vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: SHOT_B64, width: 1440, height: 900 })),
  // The peek's own capture, which is deliberately NOT the run pipeline's — see
  // the measurement table on `captureTabScreenshot`. Mocked separately so a
  // peek that quietly reverted to the run helper fails here.
  captureTabScreenshot: vi.fn(async (_page: unknown, fullPage = false) => {
    screenshotFullPage.push(fullPage);
    // A taller image when the whole page was asked for, so a test can tell the
    // two captures apart by their result and not only by this recording.
    return { ok: true, image: { base64: SHOT_B64, width: 1689, height: fullPage ? 3361 : 1277 } };
  }),
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

const API_KEY = 'sk-peek-real-app';

/** The project's own clip limit, far below both the config default (300 000)
 *  and the library default (100 000) — so a page under both still trips it,
 *  and only the project layer can explain the result. */
const PROJECT_DOM_LIMIT = 200;

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
/** The project that narrows the clip limit, and the one that says nothing. */
let tightDir: string;
let plainDir: string;
let previousRoots: string | undefined;
/** The user root this file resolves against, and the values it displaced. */
let userRootTmp: string;
const savedUserRoot: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Every `resolveProject` reads the machine key from the user root's `.env`
  // and confines paths against that root, so point it into an empty tmp dir —
  // this machine's real %LOCALAPPDATA%\steptix must not decide an outcome here.
  // LOCALAPPDATA is what win32 reads, XDG_CONFIG_HOME what everything else does.
  userRootTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-peek-user-root-')));
  for (const key of ['LOCALAPPDATA', 'XDG_CONFIG_HOME'] as const) {
    savedUserRoot[key] = process.env[key];
    process.env[key] = userRootTmp;
  }

  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const env = `STEPTIX_SERVER_URL=${baseUrl}\nSTEPTIX_SERVER_API_KEY=${API_KEY}\n`;
  tightDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-peek-tight-')));
  await fs.writeFile(path.join(tightDir, '.env'), env);
  await fs.writeFile(
    path.join(tightDir, 'steptix.config.json'),
    JSON.stringify({ tests: { dir: './tests' }, browser: { domSnapshotCharLimit: PROJECT_DOM_LIMIT } }),
  );

  plainDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-peek-plain-')));
  await fs.writeFile(path.join(plainDir, '.env'), env);
  await fs.writeFile(
    path.join(plainDir, 'steptix.config.json'),
    JSON.stringify({ tests: { dir: './tests' } }),
  );

  previousRoots = process.env['STEPTIX_MCP_ROOTS'];
  process.env['STEPTIX_MCP_ROOTS'] = [tightDir, plainDir].join(path.delimiter);

  const mcp = createMcpServer({
    createApiClient,
    ensureServerReady: async () => {},
    assertServerRecognized: async () => {},
    resolveProject,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'peek-real-app', version: '0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  if (previousRoots === undefined) delete process.env['STEPTIX_MCP_ROOTS'];
  else process.env['STEPTIX_MCP_ROOTS'] = previousRoots;
  for (const [key, value] of Object.entries(savedUserRoot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await client?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  resetRegistry();
  for (const dir of [tightDir, plainDir, userRootTmp]) {
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

// The report mock is module-level and the session tests below DO generate
// reports (a `run_steps` batch writes one), so every "nothing generated a
// report" assertion has to start from a clean count — or it holds only while
// those tests happen to run last.
beforeEach(() => {
  vi.mocked(generateReportMock).mockClear();
});

async function listSessionIds(root = tightDir): Promise<string[]> {
  const res = await client.callTool({ name: 'list_sessions', arguments: { project_root: root } });
  return ((res.structuredContent as { sessions: { sessionId: string }[] }).sessions ?? [])
    .map((s) => s.sessionId)
    .sort();
}

function content(result: unknown): string {
  return JSON.stringify((result as { content: unknown }).content);
}

function peek(args: Record<string, unknown>) {
  return client.callTool({ name: 'peek_tab', arguments: { project_root: tightDir, ...args } });
}

describe('peek_tab over the real HTTP seam', () => {
  it('reads the named tab and creates nothing (item 1)', async () => {
    attaches.length = 0;
    detaches.length = 0;
    const before = await listSessionIds();

    const res = await peek({ tab: 'title~Cart', profile: 'default' });

    expect(res.isError, content(res)).toBeFalsy();
    const value = res.structuredContent as Record<string, unknown>;
    expect(value.targetId).toBe('tab-cart');
    expect(value.url).toBe('https://shop.example/cart');
    expect(value.title).toBe('Cart — Shop');
    expect(value.content).toBe(PAGE_TEXT);
    expect(value.format).toBe('text');
    expect(value.selector).toBeNull();
    expect(value.truncated).toBe(false);
    expect(value.returnedChars).toBe(PAGE_TEXT.length);
    expect(value.availableChars).toBe(PAGE_TEXT.length);
    // Every result says which root it used (stories/mcp-no-project.md).
    expect(value.root).toBe(tightDir);
    expect(value.scope).toBe('project');
    // No session and no run status to lie with.
    expect(value).not.toHaveProperty('sessionId');
    expect(value).not.toHaveProperty('status');

    // The claim that makes a peek a peek: no session, before or after.
    expect(await listSessionIds()).toEqual(before);

    // Attached once, to the exact tab, without asking for the window — and
    // detached again. (Whether Chromium would have raised it is item (5)'s,
    // and only the playwright-mocked suite can fail on that.)
    expect(attaches).toHaveLength(1);
    expect(attaches[0]!.cdp).toEqual({
      port: CDP_PORT,
      tab: 'targetId:tab-cart',
      activate: false,
    });
    expect(detaches).toHaveLength(1);

    // No report file, checked two ways: nothing generated one, and the project
    // gained no report directory.
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(existsSync(path.join(tightDir, 'reports'))).toBe(false);
    // Nor did the synthetic path ever become a file.
    expect(existsSync(path.join(tightDir, '.steptix-peek.md'))).toBe(false);
  }, 30_000);

  it('navigates a new tab and a named one, over the same real seam', async () => {
    // stories/navigate-tab.md, through the whole chain: tool arguments → HTTP
    // body → route guards → the attach arm → goto → the result. The per-field
    // reads on that path are exactly what a seam test cannot see.
    attaches.length = 0;
    const before = await listSessionIds();
    const cart = TABS.find((t) => t.targetId === 'tab-cart')!;

    try {
      // The default arm: a new tab, and no existing tab moved.
      const urlsBefore = TABS.map((t) => t.urlText);
      const opened = await client.callTool({
        name: 'navigate_tab',
        arguments: { url: 'https://example.com/pricing', profile: 'default', project_root: tightDir },
      });

      expect(opened.isError, content(opened)).toBeFalsy();
      const openedValue = opened.structuredContent as Record<string, unknown>;
      expect(openedValue.openedNewTab).toBe(true);
      expect(openedValue.requestedUrl).toBe('https://example.com/pricing');
      expect(openedValue.url).toBe('https://example.com/pricing');
      expect(openedValue.targetId).toBe('tab-opened');
      expect(attaches[0]!.cdp).toEqual({ port: CDP_PORT, tab: 'new', activate: false });
      // Item (1) proved the only way that means anything: every tab the user had
      // is still where it was.
      expect(TABS.map((t) => t.urlText)).toEqual(urlsBefore);
      // **The opened tab SURVIVES the detach.** `closeBrowser` closes a tab the
      // attach opened, which is right for a run and exactly wrong here — opening
      // the tab is the job. Found live, where the new tab navigated and then
      // vanished before anything could look at it; pinned here because a detach
      // that quietly took the deliverable with it looked like a success.
      const openedPage = detaches.at(-1)!.page as { close: ReturnType<typeof vi.fn> };
      expect(openedPage.close).not.toHaveBeenCalled();
      expect(detaches.at(-1)!.cdpTabOpenedByUs).toBe(false);

      // The replace arm, by exact id, and the tab really moves.
      const replaced = await client.callTool({
        name: 'navigate_tab',
        arguments: {
          url: 'https://example.com/needs-login',
          target_id: 'tab-cart',
          profile: 'default',
          project_root: tightDir,
        },
      });

      expect(replaced.isError, content(replaced)).toBeFalsy();
      const replacedValue = replaced.structuredContent as Record<string, unknown>;
      expect(replacedValue.openedNewTab).toBe(false);
      expect(replacedValue.targetId).toBe('tab-cart');
      // The redirect, end to end: asked for one page, landed on a sign-in.
      expect(replacedValue.requestedUrl).toBe('https://example.com/needs-login');
      expect(replacedValue.url).toBe('https://accounts.example/login');
      expect(replacedValue.title).toBe('Sign in');
      expect(content(replaced)).toContain('Landed on: https://accounts.example/login');
      expect(cart.urlText).toBe('https://accounts.example/login');
      expect(attaches[1]!.cdp).toEqual({
        port: CDP_PORT,
        tab: 'targetId:tab-cart',
        activate: false,
      });

      // Still no sessions, and no report: a navigation is not a run.
      expect(await listSessionIds()).toEqual(before);
      expect(generateReportMock).not.toHaveBeenCalled();
    } finally {
      // Put the fixture back even when an assertion above failed: every other
      // test reads this tab by name, and a cart left on "Sign in" turns one
      // real failure into a column of unrelated ones.
      cart.urlText = 'https://shop.example/cart';
      cart.titleText = 'Cart — Shop';
    }
  }, 30_000);

  it('photographs the named tab, and full_page survives every layer', async () => {
    // stories/cdp-tab-screenshot.md, through the whole chain this file exists
    // for: tool arguments → client query string → route parser → capture call
    // → response → image block. `full_page` is read out field by field at each
    // of those, which is exactly the shape of bug a seam test cannot see.
    attaches.length = 0;
    detaches.length = 0;
    screenshotFullPage.length = 0;
    const before = await listSessionIds();

    const res = await peek({ tab: 'title~Cart', profile: 'default', format: 'screenshot' });

    expect(res.isError, content(res)).toBeFalsy();
    const value = res.structuredContent as Record<string, unknown>;
    expect(value.format).toBe('screenshot');
    expect(value.targetId).toBe('tab-cart');
    expect(value.title).toBe('Cart — Shop');
    // The picture is not in the structured half — it is in an image block, and
    // `content` being empty is what says so.
    expect(value.content).toBe('');
    expect(value.truncated).toBe(false);
    expect(value.width).toBe(1689);
    expect(value.height).toBe(1277);

    const blocks = (res.content as { type: string; data?: string; mimeType?: string }[]).filter(
      (b) => b.type === 'image',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.data).toBe(SHOT_B64);
    expect(blocks[0]!.mimeType).toBe('image/png');

    // Viewport by default, and the whole page only when asked — read off what
    // the capture was actually handed, four layers down.
    expect(screenshotFullPage).toEqual([false]);
    const whole = await peek({ tab: 'title~Cart', format: 'screenshot', full_page: true });
    expect(whole.isError, content(whole)).toBeFalsy();
    expect(screenshotFullPage).toEqual([false, true]);
    expect((whole.structuredContent as Record<string, unknown>).height).toBe(3361);

    // A photograph is still a peek: nothing created, and the window never asked
    // for — the one read someone might be tempted to activate for.
    expect(await listSessionIds()).toEqual(before);
    expect(attaches).toHaveLength(2);
    expect(attaches[0]!.cdp).toEqual({ port: CDP_PORT, tab: 'targetId:tab-cart', activate: false });
    expect(detaches).toHaveLength(2);
    expect(generateReportMock).not.toHaveBeenCalled();
  }, 30_000);

  it('narrows to one element with a selector, and clips at max_chars (item 2)', async () => {
    const narrowed = await peek({ tab: 'targetId:tab-cart', format: 'dom', selector: '#total' });
    expect(narrowed.isError, content(narrowed)).toBeFalsy();
    expect((narrowed.structuredContent as { content: string }).content).toBe('<div id="#total"/>');
    expect((narrowed.structuredContent as { selector: string }).selector).toBe('#total');

    const clipped = await peek({ tab: 'targetId:tab-cart', max_chars: 40 });
    const value = clipped.structuredContent as Record<string, unknown>;
    expect(value.truncated).toBe(true);
    expect((value.content as string)).toHaveLength(40);
    expect(value.returnedChars).toBe(40);
    expect(value.availableChars).toBe(PAGE_TEXT.length);
    // …and the summary says so, which is all a host that ignores structured
    // content will show.
    expect(content(clipped)).toContain('narrow with a selector');
  }, 30_000);

  it('captures under the PROJECT\'s dom limit, not the library default (item 2)', async () => {
    // The whole reason the request carries a synthetic `<root>/.steptix-peek.md`.
    // Both numbers below are decided by files on disk and a resolver: the
    // library default is 100 000, the config default is 300 000, and this
    // project says 200 — so all three are distinguishable, and only the
    // project layer explains the first result.
    domCaptureOptions.length = 0;

    const tight = await peek({ tab: 'targetId:tab-cart', format: 'dom', max_chars: 100_000 });
    expect(tight.isError, content(tight)).toBeFalsy();
    expect(domCaptureOptions.at(-1)?.domSnapshotCharLimit).toBe(PROJECT_DOM_LIMIT);

    // The silent-clip trap page-content.md §3 records: the capture clipped
    // before this layer ever saw the string, so `availableChars` is well under
    // `max_chars` — and `truncated` must STILL be true, or an agent told
    // otherwise reports that the rest of the page does not exist.
    const value = tight.structuredContent as Record<string, unknown>;
    expect(value.truncated).toBe(true);
    expect(value.availableChars as number).toBeLessThan(100_000);

    // The control, in a project that overrides nothing: the config default
    // reaches the capture, NOT the library's — which is the difference item
    // (2) is about, and the one a missing testFilePath would erase.
    const plain = await client.callTool({
      name: 'peek_tab',
      arguments: {
        tab: 'targetId:tab-cart',
        format: 'dom',
        max_chars: 100_000,
        project_root: plainDir,
      },
    });
    expect(plain.isError, content(plain)).toBeFalsy();
    expect(domCaptureOptions.at(-1)?.domSnapshotCharLimit).toBe(300_000);
    expect((plain.structuredContent as { truncated: boolean }).truncated).toBe(false);
    expect((plain.structuredContent as { root: string }).root).toBe(plainDir);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Item (4): reads coexist with drivers
  // -------------------------------------------------------------------------

  /**
   * A `run_steps` batch on the shared tab, through the door sessions use.
   *
   * `bind` sends `config.cdp`, which the server only honours when it CREATES
   * the session — so it belongs on a session's first batch and nowhere else.
   * Each test uses its own id: the MCP process remembers which ids it has
   * configured (`src/mcp/registry.ts`), so a closed id reused by the next test
   * has its `config` stripped client-side.
   */
  function sessionSteps(id: string, steps: string[], bind: boolean, foreign = false) {
    return client.callTool({
      name: 'run_steps',
      arguments: {
        session_id: id,
        steps,
        project_root: tightDir,
        ...(foreign ? { allow_foreign_session: true } : {}),
        ...(bind ? { config: { cdp: { profile: 'default', tab: 'targetId:tab-mail' } } } : {}),
      },
    });
  }

  function closeSession(id: string, foreign = false) {
    return client.callTool({
      name: 'close_session',
      arguments: {
        session_id: id,
        project_root: tightDir,
        ...(foreign ? { allow_foreign_session: true } : {}),
      },
    });
  }

  it('reads a tab a session is sitting on, and that session still works after (item 4)', async () => {
    // A read races nothing: concurrent CDP CLIENTS on one tab are the
    // measured-safe case (errands §The wheel), and the peek's own connection
    // is held only as long as the extraction takes.
    const id = 'mcp:peek-idle';
    executedSteps.length = 0;
    const before = await listSessionIds();

    try {
      const bound = await sessionSteps(id, ['read the inbox'], true);
      expect(bound.isError, content(bound)).toBeFalsy();
      expect(await listSessionIds()).toEqual([...before, id].sort());

      const read = await peek({ tab: 'targetId:tab-mail' });
      expect(read.isError, content(read)).toBeFalsy();
      expect((read.structuredContent as { title: string }).title).toBe('Inbox');

      // The half a status field cannot make: the session's NEXT batch. A peek
      // that left the tab or the binding broken shows up here and nowhere else.
      const next = await sessionSteps(id, ['read the inbox again'], false);
      expect(next.isError, content(next)).toBeFalsy();
      expect(executedSteps).toContain('read the inbox again');

      // And the peek added nothing to the sessions map on its way through.
      expect(await listSessionIds()).toEqual([...before, id].sort());
    } finally {
      await closeSession(id);
    }
  }, 30_000);

  it('reads a tab a FOREIGN session is bound to (item 4)', async () => {
    // §Disclosure posture's amendment, asserted rather than argued. A foreign
    // SESSION is gated for `get_page_content` because the session address must
    // not become a disclosure channel; a peek addresses no session, and the
    // browser it reads was resolved by profile — so it is registry-owned, and
    // an owned browser is the user's own, which `list_cdp_browsers` already
    // shows them every tab of.
    const id = 'c:/someone-elses/tests/theirs.md';
    const before = await listSessionIds();

    try {
      const bound = await sessionSteps(id, ['read the inbox'], true, true);
      expect(bound.isError, content(bound)).toBeFalsy();
      expect(await listSessionIds()).toEqual([...before, id].sort());

      const read = await peek({ tab: 'targetId:tab-mail' });

      expect(read.isError, content(read)).toBeFalsy();
      expect((read.structuredContent as { content: string }).content).toBe(PAGE_TEXT);
      // The control that makes this a statement about the PEEK: the same tab
      // through the session door is still refused without the opt-in.
      const throughTheSession = await client.callTool({
        name: 'get_page_content',
        arguments: { session_id: id, project_root: tightDir },
      });
      expect(throughTheSession.isError).toBe(true);
      expect(content(throughTheSession)).toContain('allow_foreign_session');
    } finally {
      await closeSession(id, true);
    }
  }, 30_000);

  it('never blocks, and is never blocked by, a session mid-batch on that tab (item 4)', async () => {
    // No lock in either direction. The errand's turn lock exists for DRIVERS;
    // a peek takes it, consults it and blocks on it never.
    const id = 'mcp:peek-midbatch';
    executedSteps.length = 0;
    const before = await listSessionIds();
    let release!: () => void;
    let markParked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const parked = new Promise<void>((r) => (markParked = r));
    const { executeStep } = await import('../src/runner/step-executor.js');
    const original = vi.mocked(executeStep).getMockImplementation()!;
    vi.mocked(executeStep).mockImplementation(async (i, t, instruction, options) => {
      if (String(instruction).includes('park')) {
        markParked();
        await gate;
      }
      return original(i, t, instruction, options);
    });

    let batch: ReturnType<typeof sessionSteps> | undefined;
    try {
      const bound = await sessionSteps(id, ['read the inbox'], true);
      expect(bound.isError, content(bound)).toBeFalsy();

      batch = sessionSteps(id, ['park here'], false);
      await parked;
      // Mid-batch, and it proceeds — the case an errand is refused for.
      const read = await peek({ tab: 'targetId:tab-mail' });
      expect(read.isError, content(read)).toBeFalsy();
      expect((read.structuredContent as { title: string }).title).toBe('Inbox');
    } finally {
      release();
      vi.mocked(executeStep).mockImplementation(original);
      // Let the released batch finish, then close — here rather than after the
      // assertions, so a failure above cannot leave the session open for
      // whichever test runs next.
      await batch?.catch(() => undefined);
      await closeSession(id);
    }
    expect((await batch!).isError).toBeFalsy();
    expect(await listSessionIds()).toEqual(before);
  }, 30_000);
});
