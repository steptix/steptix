/**
 * The scoreboard at the Sessions API's seam (docs/specs/SPEC-scoreboard.md
 * §15, "At the seam"; acceptance 1, 4, 5, 10).
 *
 * A batch goes in through the real HTTP route, the real session manager, the
 * REAL step executor, the REAL AI client and the REAL report generator. Only
 * the browser and its page, the DOM reader and the gateway library under the
 * client are stubbed — the gateway answers from a script and reports usage as
 * the v2 envelope does, so tokens reach the step lines the production way.
 *
 * The lines land in a temporary user root. Every project is a folder of its
 * own with an `aiui.config.json`, because the server resolves a project per
 * request from the test file's path — and the project's `stats.enabled` is
 * the one that counts, never the server's own config.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AIAction } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';

// ─── The model: a scripted gateway under the real AiClient ───────────────────

type Reply = { text: string; usage?: { input_tokens: number; output_tokens: number } };
const gw = vi.hoisted(() => ({
  /** `signal` is the one the client handed the gateway — the run's Stop and
   *  the request timeout together — so a responder can hang until a Stop. */
  respond: (_text: string, _signal?: AbortSignal): Reply | Promise<Reply> => {
    throw new Error('no responder set');
  },
  requests: 0,
}));

vi.mock('@pkent/aigateway', () => {
  const textOf = (messages: Array<{ content: unknown }>): string =>
    messages
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'),
      )
      .join('\n');
  class FakeGateway {
    static providers(): unknown[] {
      return [];
    }
    async chat(messages: Array<{ content: unknown }>, options?: { signal?: AbortSignal }) {
      gw.requests++;
      const reply = await gw.respond(textOf(messages), options?.signal);
      return {
        model: 'aibroker/test/model',
        content: [{ type: 'text', text: reply.text }],
        ...(reply.usage && { usage: reply.usage }),
      };
    }
    stream(): never {
      throw new Error('this suite does not stream');
    }
  }
  return { AIGateway: FakeGateway, default: FakeGateway };
});

// ─── The browser: a page with no DOM, and actions scripted by selector ───────

const mockPage = {
  url: () => 'https://shop.test/cart',
  title: async () => 'Cart',
  goto: async () => null,
  on: () => {},
  off: () => {},
  context: () => ({ browser: () => ({}) }),
  evaluate: async () => {
    throw new Error('no DOM in this test');
  },
  screenshot: async () => {
    throw new Error('no screenshot in this test');
  },
  waitForLoadState: async () => {},
};

const mockBrowserSession = {
  browser: { isConnected: () => true },
  context: {},
  page: mockPage,
  pageTracker: {
    getActive: () => mockPage,
    count: 1,
    describeActiveTab: async () => undefined,
  },
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
    executeAction: vi.fn(async (_page: unknown, action: AIAction) =>
      action.selector?.includes(':text-is(')
        ? {
            success: false,
            error: 'locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator(\'button:text-is("Pay")\')\n',
            failedSelector: action.selector,
            targeting: { matchCount: 0, visibleMatchCount: 0 },
          }
        : { success: true, targeting: { matchCount: 1, visibleMatchCount: 1 } },
    ),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: async () => '<html><body><button>Pay</button></body></html>' };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false,
    loadingIndicators: [],
    hasErrorOverlay: false,
    errorMessages: [],
    hasModal: false,
    documentLoading: false,
  }),
  waitForPageStability: async () => {},
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://shop.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean {
      return true;
    }
    dispose(): void {}
  },
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: async () => null,
  toDataUri: (b: string) => `data:image/png;base64,${b}`,
}));
vi.mock('../src/context/loader.js', () => ({ loadContextFiles: async () => ({ files: [], combined: '' }) }));

import { createApiServer } from '../src/server/api-server.js';
import { flushStatsWrites, readStatsLines } from '../src/stats/store.js';
import type { StatsActionLine, StatsLine, StatsRunLine, StatsStepLine } from '../src/stats/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';
import { stepAnchor } from '../src/report/anchors.js';

const API_KEY = 'stats-seam-key';

let tmp: string;
let userRoot: string;
let deps: UserRootDeps;
let server: Server;
let baseUrl: string;
const savedEnv: Record<string, string | undefined> = {};
let unique = 0;

function testConfig(): Config {
  return {
    ai: {
      gatewayUrl: 'https://ai.test',
      model: 'aibroker/test/model',
      apiKey: 'test-key',
      maxInputTokens: 1_000_000,
      streamResponses: false,
      sendScreenshots: false,
      diagnoseFailures: false,
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
    execution: { timeout: 30_000, retries: 1, screenshotOnFailure: false, promptOnAmbiguity: false, maxTurns: 2 },
    reports: {
      outputDir: './reports',
      includeScreenshots: false,
      includeDomSnapshots: false,
      includeAiReasoning: true,
      embedScreenshots: false,
    },
    api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
    server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
    logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
    // The SERVER's own config turns recording off. It must not matter: a run
    // records under the switch of the project it runs, and these projects say
    // nothing — the trap `this.config` would fall into.
    stats: { enabled: false },
  } as unknown as Config;
}

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', () => resolve()));
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
    throw new Error(`${method} ${route} returned non-JSON ${res.status}: ${text.slice(0, 400)}`);
  }
}

/** A project of its own: a root with a config (and `stats` when given) and a test file in it. */
function project(name: string, steps: string[], stats?: { enabled: boolean }): { root: string; file: string } {
  const root = path.join(tmp, `${name}-${++unique}`);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify(stats ? { stats } : {}));
  const file = path.join(root, 'tests', `${name}.md`);
  fs.writeFileSync(file, `# ${name}\n\n## Steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`);
  return { root, file };
}

const plan = (selector: string): string =>
  JSON.stringify({ actions: [{ action: 'click', selector, description: 'do it' }], reasoning: 'planned', needs_reeval: false });

/** A model call in flight when the Stop lands: it answers only by failing,
 *  the way the gateway's request does when its signal aborts. */
function hangUntilStopped(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const stop = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Wait until the session's run has finished on the server — the client that
 *  closed the stream is not there to be told (`GET …/last-run`, issue 021). */
async function waitForFinalizedRun(id: string): Promise<{ reportPath?: string }> {
  for (let i = 0; i < 200; i++) {
    const last = await api('GET', `/sessions/${id}/last-run`);
    if (last.status === 200 && last.body?.finalized === true) return last.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the run of ${id} never finalized`);
}

async function lines(): Promise<StatsLine[]> {
  await flushStatsWrites();
  const read = await readStatsLines({ deps });
  expect(read.skipped).toBe(0);
  return read.lines;
}
const actionLines = (all: StatsLine[]) => all.filter((l): l is StatsActionLine => l.kind === 'action');
const stepLines = (all: StatsLine[]) => all.filter((l): l is StatsStepLine => l.kind === 'step');
const runLines = (all: StatsLine[]) => all.filter((l): l is StatsRunLine => l.kind === 'run');

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-stats-api-seam-')));
  userRoot = path.join(tmp, 'user-root');
  fs.mkdirSync(userRoot, { recursive: true });
  for (const key of ['AIUI_STATS', 'AIUI_STATS_SUITE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
  delete process.env['AIUI_STATS'];
  delete process.env['AIUI_STATS_SUITE'];
  process.env['LOCALAPPDATA'] = userRoot;
  process.env['XDG_CONFIG_HOME'] = userRoot;
  deps = { env: { LOCALAPPDATA: userRoot, XDG_CONFIG_HOME: userRoot }, platform: process.platform };
  const { app } = createApiServer(testConfig());
  ({ server, baseUrl } = await listenOnRandomPort(app));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await flushStatsWrites();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await flushStatsWrites();
  fs.rmSync(path.join(userRoot, 'aiui', 'stats'), { recursive: true, force: true });
  delete process.env['AIUI_STATS_SUITE'];
});

describe('a Sessions API batch records its actions, steps and run', () => {
  it('lines numbered as the report numbers them, one run line linking the report, and the tokens add up', async () => {
    const { root, file } = project('checkout', ['Pay for the order', 'Open the receipt']);
    let payCalls = 0;
    gw.respond = (text) => {
      if (text.includes('## Current Step\nPay for the order')) {
        payCalls++;
        return payCalls === 1
          ? { text: plan('button:text-is("Pay")'), usage: { input_tokens: 3000, output_tokens: 90 } }
          : { text: plan('role=button[name="Pay"]'), usage: { input_tokens: 3300, output_tokens: 95 } };
      }
      if (text.includes('## Current Step\nOpen the receipt')) {
        return { text: plan('#receipt'), usage: { input_tokens: 2800, output_tokens: 40 } };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const id = `seam-${++unique}`;
    const run = await api('POST', `/sessions/${id}/steps`, {
      steps: ['Pay for the order', 'Open the receipt'],
      // Source lines the report does NOT number by: it shows "Step 1, Step 2".
      sourceLines: [7, 9],
      testFilePath: file,
    });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('passed');

    const all = await lines();
    const runs = runLines(all);
    expect(runs).toHaveLength(1);
    const [runLine] = runs;
    for (const line of all) {
      expect(line).toMatchObject({ run: runLine!.run, project: root, test: 'tests/checkout.md', suite: 'user' });
    }
    expect(actionLines(all).map((a) => [a.step, a.attempt, a.form, a.outcome])).toEqual([
      [1, 1, 'text-is', 'no-match'],
      [1, 2, 'role', 'ok'],
      [2, 1, 'id', 'ok'],
    ]);
    const steps = stepLines(all);
    expect(steps.map((s) => [s.step, s.firstTry, s.attempts, s.calls, s.tokensIn, s.tokensOut])).toEqual([
      [1, false, 2, 2, 6300, 185],
      [2, true, 1, 1, 2800, 40],
    ]);
    expect(runLine).toMatchObject({ status: 'passed', steps: 2, firstTry: 1, failed: 0, tokensIn: 9100, tokensOut: 225 });

    // The report the run line names is the one the batch wrote, and the
    // failing action's anchor is in it.
    expect(runLine!.report).toBeTruthy();
    const html = fs.readFileSync(runLine!.report!, 'utf-8');
    expect(path.dirname(runLine!.report!)).toBe(path.join(root, 'reports'));
    expect(html).toContain(`id="${stepAnchor({ step: 1 })}"`);
    expect(html).toContain(`id="${stepAnchor({ step: 2 })}"`);
    // …and its token counts are the run line's.
    expect(html).toContain('9,325');

    await api('DELETE', `/sessions/${id}`);
  });

  it('a server tagged AIUI_STATS_SUITE=live writes suite: live (acceptance 4)', async () => {
    const { file } = project('live', ['Open the cart']);
    gw.respond = () => ({ text: plan('#cart'), usage: { input_tokens: 10, output_tokens: 1 } });
    process.env['AIUI_STATS_SUITE'] = 'live';
    const id = `seam-${++unique}`;
    await api('POST', `/sessions/${id}/steps`, { steps: ['Open the cart'], testFilePath: file });
    await api('DELETE', `/sessions/${id}`);

    const all = await lines();
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) expect(line.suite).toBe('live');
  });

  it('a project with stats.enabled false writes nothing; another project on the server still records (acceptance 5)', async () => {
    gw.respond = () => ({ text: plan('#go'), usage: { input_tokens: 10, output_tokens: 1 } });
    const quiet = project('quiet', ['Click Go'], { enabled: false });
    const loud = project('loud', ['Click Go']);

    const q = `seam-${++unique}`;
    expect((await api('POST', `/sessions/${q}/steps`, { steps: ['Click Go'], testFilePath: quiet.file })).body.status).toBe('passed');
    await api('DELETE', `/sessions/${q}`);
    await flushStatsWrites();
    expect(fs.existsSync(path.join(userRoot, 'aiui', 'stats'))).toBe(false);

    const l = `seam-${++unique}`;
    await api('POST', `/sessions/${l}/steps`, { steps: ['Click Go'], testFilePath: loud.file });
    await api('DELETE', `/sessions/${l}`);
    const all = await lines();
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((line) => line.project))).toEqual(new Set([loud.root]));
  });

  it('a data-row run: one run id for every row, one run line, beside the ONE report the finalise writes', async () => {
    const { root, file } = project('rows', ['Search for {{customer}}', 'Open the first result']);
    gw.respond = () => ({ text: plan('#result'), usage: { input_tokens: 100, output_tokens: 2 } });
    const id = `seam-rows-${++unique}`;
    for (const [index, customer] of ['Alice', 'Bob'].entries()) {
      const batch = await api('POST', `/sessions/${id}/steps`, {
        steps: ['Search for {{customer}}', 'Open the first result'],
        testFilePath: file,
        parameters: { customer },
        dataRow: index + 1,
        dataRowCount: 2,
        dataRowValues: { customer },
      });
      expect(batch.body.status).toBe('passed');
      // The client closes the session between rows.
      await api('DELETE', `/sessions/${id}`);
      // A row writes no run line of its own: its run is the whole row run.
      await flushStatsWrites();
      expect(runLines((await readStatsLines({ deps })).lines)).toHaveLength(0);
    }
    const finalised = await api('POST', `/sessions/${id}/report`, {});
    expect(finalised.status).toBe(200);

    const all = await lines();
    const runs = runLines(all);
    expect(runs).toHaveLength(1);
    expect(new Set(all.map((l) => l.run))).toEqual(new Set([runs[0]!.run]));
    const steps = stepLines(all);
    expect(steps.map((s) => [s.row, s.step])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ]);
    expect(steps[0]!.stepText).toBe('Search for {{customer}}');
    expect(runs[0]).toMatchObject({ project: root, steps: 4, firstTry: 4, failed: 0, tokensIn: 400, tokensOut: 8 });
    expect(runs[0]!.report).toBe(path.resolve(finalised.body.reportPath));
    const html = fs.readFileSync(runs[0]!.report!, 'utf-8');
    for (const s of steps) expect(html).toContain(`id="${stepAnchor({ step: s.step, row: s.row })}"`);
  });
});

describe('a Stop on the Sessions API: the client closes the stream mid-call (finding 2, contract E)', () => {
  it('the stopped step\'s line says interrupted, its attempts are the ones that ran, and the run line counts no failure', async () => {
    const { root, file } = project('stop', ['Pay for the order', 'Open the receipt']);
    const client = new AbortController();
    let payCalls = 0;
    gw.respond = (text, signal) => {
      if (text.includes('## Current Step\nPay for the order')) {
        payCalls++;
        if (payCalls === 1) return { text: plan('button:text-is("Pay")'), usage: { input_tokens: 3000, output_tokens: 90 } };
        // The retry's call is in flight when the user stops: TestBench closes
        // the stream, and the server's run signal is what reaches the call.
        client.abort();
        return hangUntilStopped(signal);
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const id = `seam-stop-${++unique}`;
    await fetch(`${baseUrl}/sessions/${id}/steps?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ steps: ['Pay for the order', 'Open the receipt'], testFilePath: file }),
      signal: client.signal,
    })
      .then((res) => res.text())
      .catch(() => undefined);
    const last = await waitForFinalizedRun(id);

    const all = await lines();
    const steps = stepLines(all);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      project: root,
      step: 1,
      status: 'failed',
      interrupted: true,
      attempts: 2,
      firstTry: false,
      calls: 1,
      tokensIn: 3000,
    });
    const [runLine] = runLines(all);
    expect(runLine).toMatchObject({ aborted: true, steps: 1, firstTry: 0, failed: 0 });
    expect(runLine!.report).toBe(path.resolve(last.reportPath!));
    await api('DELETE', `/sessions/${id}`);
  });
});

describe('a watch group\'s branch steps have no report card on the Sessions API (finding 8, contract F)', () => {
  it('their lines carry card: false, and the report indeed has no card for them', async () => {
    const steps = ['Open the login page', 'If a Remember this device prompt appears, click Not now', 'Open the dashboard'];
    const { file } = project('watch', steps);
    gw.respond = (text) => {
      if (text.includes('## Branched Step — Determine Which Outcome Applies')) {
        return {
          text: JSON.stringify({ matched: 'A', reasoning: 'the prompt is up', actions: [{ action: 'click', selector: '#not-now', description: 'x' }] }),
          usage: { input_tokens: 700, output_tokens: 7 },
        };
      }
      if (text.includes('## Current Step\n')) return { text: plan('#it'), usage: { input_tokens: 100, output_tokens: 1 } };
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };
    const id = `seam-watch-${++unique}`;
    const run = await api('POST', `/sessions/${id}/steps`, { steps, testFilePath: file });
    expect(run.body.status).toBe('passed');
    await api('DELETE', `/sessions/${id}`);

    const all = await lines();
    const byStep = new Map(stepLines(all).map((s) => [s.step, s]));
    expect([...byStep.keys()].sort()).toEqual([1, 2, 3]);
    // The ordinary step has a card; the group's matched step and its
    // continuation do not.
    expect(byStep.get(1)).not.toHaveProperty('card');
    expect(byStep.get(2)).toMatchObject({ card: false, stepText: steps[1] });
    expect(byStep.get(3)).toMatchObject({ card: false, stepText: steps[2] });
    for (const action of actionLines(all)) {
      if (action.step === 1) expect(action).not.toHaveProperty('card');
      else expect(action).toMatchObject({ card: false });
    }
    const [runLine] = runLines(all);
    const html = fs.readFileSync(runLine!.report!, 'utf-8');
    expect(html).toContain(`id="${stepAnchor({ step: 1 })}"`);
    expect(html).not.toContain(`id="${stepAnchor({ step: 2 })}"`);
    expect(html).not.toContain(`id="${stepAnchor({ step: 3 })}"`);
  });
});

describe('a [use ai] step the Sessions API refuses before the call writes no line (finding 4, contract D)', () => {
  it('two names on one [use ai] line: refused, no call, no step line', async () => {
    const steps = ['[use ai] Make up a customer name [store as: first] [store as: second]'];
    const { file } = project('use-ai-refused', ['Click Go']);
    gw.respond = (text) => {
      throw new Error(`the model must not be asked: ${text.slice(0, 200)}`);
    };
    gw.requests = 0;
    const id = `seam-useai-${++unique}`;
    const run = await api('POST', `/sessions/${id}/steps`, { steps, testFilePath: file });
    expect(run.body.status).not.toBe('passed');
    await api('DELETE', `/sessions/${id}`);
    expect(gw.requests).toBe(0);

    const all = await lines();
    expect(stepLines(all)).toEqual([]);
    expect(actionLines(all)).toEqual([]);
  });
});

describe('step lines carry the step\'s site, model and execution number (contracts A and B)', () => {
  it('from the step\'s first action line', async () => {
    const { file } = project('site', ['Open the cart', 'Open the receipt']);
    gw.respond = () => ({ text: plan('#go'), usage: { input_tokens: 10, output_tokens: 1 } });
    const id = `seam-site-${++unique}`;
    await api('POST', `/sessions/${id}/steps`, { steps: ['Open the cart', 'Open the receipt'], testFilePath: file });
    await api('DELETE', `/sessions/${id}`);
    const all = await lines();
    expect(stepLines(all).map((s) => [s.step, s.exec, s.site, s.model])).toEqual([
      [1, 1, 'shop.test', 'aibroker/test/model'],
      [2, 2, 'shop.test', 'aibroker/test/model'],
    ]);
    expect(actionLines(all).map((a) => a.exec)).toEqual([1, 2]);
  });
});
