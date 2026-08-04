import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import path from 'node:path';
import type { Config } from '../src/config/types.js';

// ---------------------------------------------------------------------------
// Mocks. The registry and discovery are stubbed so no browser is spawned and
// no filesystem is touched — this suite is about the ROUTES: the three-list
// split, the withholding rule, single-flight, auth and status mapping.
// Registry behaviour itself is covered by cdp-registry.test.ts.
// ---------------------------------------------------------------------------

const knownProfilesMock = vi.fn();
const startCdpBrowserMock = vi.fn();
const discoverCdpPortsMock = vi.fn();

vi.mock('../src/browser/cdp-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/cdp-registry.js')>();
  return {
    ...actual,
    knownProfiles: (...args: unknown[]) => knownProfilesMock(...args),
    startCdpBrowser: (...args: unknown[]) => startCdpBrowserMock(...args),
  };
});

vi.mock('../src/browser/cdp-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/cdp-discovery.js')>();
  return {
    ...actual,
    discoverCdpPorts: (...args: unknown[]) => discoverCdpPortsMock(...args),
  };
});

// The session manager pulls in the browser stack; stub the pieces it reaches
// for so constructing the app is cheap and launches nothing.
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: vi.fn(),
  PageTracker: vi.fn(),
  BrowserTracker: class {
    getActive = vi.fn();
    closeAll = vi.fn(async () => {});
  },
  resolveVideoMode: vi.fn(() => 'off'),
  finalizeMainPageVideo: vi.fn(),
}));

const { createApiServer } = await import('../src/server/api-server.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'test-api-key-cdp';
const PROJECT = path.join('C:', 'proj');

const testConfig = {
  ai: {
    gatewayUrl: 'https://ai.test',
    model: 'test-model',
    maxInputTokens: 1000,
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
    fullPageScreenshots: true,
  },
  tests: {
    dir: './tests',
    dataDir: './data',
    contextDir: './context',
    skillsDir: './skills',
    toolsDir: './tools',
    pattern: '**/*.md',
  },
  execution: {
    timeout: 30_000,
    retries: 1,
    screenshotOnFailure: true,
    promptOnAmbiguity: false,
    maxTurns: 5,
    interactiveOnFailure: false,
  },
  reports: {
    outputDir: './reports',
    includeScreenshots: true,
    includeDomSnapshots: true,
    includeAiReasoning: true,
    embedScreenshots: true,
    openInBrowserAfterRun: false,
    appendRunHistoryToTestFile: false,
  },
  api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
} as unknown as Config;

let server: Server;
let baseUrl: string;

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', () => resolve()));
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

const auth = { 'x-api-key': API_KEY };

function get(qs: string, headers: Record<string, string> = auth) {
  return fetch(`${baseUrl}/cdp/browsers?${qs}`, { headers });
}

function post(body: unknown, headers: Record<string, string> = auth) {
  return fetch(`${baseUrl}/cdp/browsers`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const liveProfile = (over: Record<string, unknown> = {}) => ({
  engine: 'edge',
  profile: 'default',
  profileDir: path.join(PROJECT, '.aiui', 'cdp-profiles', 'edge-default'),
  live: true,
  port: 51000,
  tabs: [{ targetId: 'T1', title: 'Orders', url: 'https://shop/orders' }],
  ...over,
});

const dormantProfile = (over: Record<string, unknown> = {}) => ({
  engine: 'edge',
  profile: 'admin',
  profileDir: path.join(PROJECT, '.aiui', 'cdp-profiles', 'edge-admin'),
  live: false,
  port: null,
  tabs: null,
  ...over,
});

beforeAll(async () => {
  const { app } = createApiServer(testConfig);
  ({ server, baseUrl } = await listenOnRandomPort(app));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  knownProfilesMock.mockReset();
  startCdpBrowserMock.mockReset();
  discoverCdpPortsMock.mockReset();
  knownProfilesMock.mockResolvedValue([]);
  discoverCdpPortsMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('both routes require the api key', async () => {
    expect((await get(`projectRoot=${encodeURIComponent(PROJECT)}`, {})).status).toBe(401);
    expect((await post({ projectRoot: PROJECT, engine: 'edge' }, {})).status).toBe(401);
  });

  it('an authenticated request bumps the idle monitor', async () => {
    // These routes sit behind auth deliberately, so they count as activity.
    // Safe only because nothing polls them — a polling caller here would make
    // the idle timeout dead code.
    const { app, idleMonitor } = createApiServer(testConfig);
    const local = await listenOnRandomPort(app);
    try {
      // Go quiet for long enough that an un-bumped clock is unmistakable,
      // then assert the clock is well inside that window. Comparing against
      // a "before" reading plus the sleep is too tight — the reading is taken
      // after the bump but includes response transit, so a slow machine
      // fails a working implementation.
      const QUIET_MS = 250;
      await new Promise((r) => setTimeout(r, QUIET_MS));
      expect(idleMonitor.idleFor()).toBeGreaterThanOrEqual(QUIET_MS);

      await fetch(`${local.baseUrl}/cdp/browsers?projectRoot=${encodeURIComponent(PROJECT)}`, {
        headers: auth,
      });

      expect(idleMonitor.idleFor()).toBeLessThan(QUIET_MS);
    } finally {
      await new Promise<void>((res, rej) => local.server.close((e) => (e ? rej(e) : res())));
    }
  });
});

// ---------------------------------------------------------------------------
// GET — the three lists
// ---------------------------------------------------------------------------

describe('GET /cdp/browsers', () => {
  it('requires an absolute projectRoot', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('projectRoot=relative/path')).status).toBe(400);
  });

  it('puts live browsers in running, with a port and their tabs', async () => {
    knownProfilesMock.mockResolvedValue([liveProfile()]);
    const res = await get(`projectRoot=${encodeURIComponent(PROJECT)}`);
    const body = await res.json();
    expect(body.running).toHaveLength(1);
    expect(body.running[0]).toMatchObject({ engine: 'edge', profile: 'default', port: 51000 });
    expect(body.running[0].tabs[0].targetId).toBe('T1');
  });

  it('puts dormant profiles in available with NO port field to attach to', async () => {
    knownProfilesMock.mockResolvedValue([dormantProfile()]);
    const body = await (await get(`projectRoot=${encodeURIComponent(PROJECT)}`)).json();
    expect(body.available).toHaveLength(1);
    expect(body.available[0]).toEqual({
      engine: 'edge',
      profile: 'admin',
      profileDir: path.join(PROJECT, '.aiui', 'cdp-profiles', 'edge-admin'),
    });
    // Not `port: null` — a port-shaped hole invites a caller to try it.
    expect('port' in body.available[0]).toBe(false);
  });

  it('a dormant profile NEVER appears in running', async () => {
    // One of the two mistakes the split exists to prevent, so it is asserted
    // directly rather than inferred from field values.
    knownProfilesMock.mockResolvedValue([dormantProfile(), liveProfile()]);
    const body = await (await get(`projectRoot=${encodeURIComponent(PROJECT)}`)).json();
    expect(body.running.map((r: { profile: string }) => r.profile)).toEqual(['default']);
    expect(body.available.map((a: { profile: string }) => a.profile)).toEqual(['admin']);
  });

  it('foreign is [] unless includeForeign is asked for, and nothing is scanned', async () => {
    const body = await (await get(`projectRoot=${encodeURIComponent(PROJECT)}`)).json();
    expect(body.foreign).toEqual([]);
    expect(discoverCdpPortsMock).not.toHaveBeenCalled();
  });

  it('withholds foreign tabs by default', async () => {
    discoverCdpPortsMock.mockResolvedValue([
      { port: 9222, reachable: true, engine: 'chrome', tabs: [{ targetId: 'X', title: 'Bank', url: 'https://bank' }] },
    ]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=true`)
    ).json();
    expect(body.foreign).toHaveLength(1);
    expect(body.foreign[0]).toMatchObject({ engine: 'chrome', port: 9222, tabs: null, tabsWithheld: true });
    // A foreign browser's tabs may be someone's mail or bank, and for an MCP
    // caller that payload goes straight to a model provider.
    expect(JSON.stringify(body)).not.toContain('Bank');
  });

  it('reveals foreign tabs when the caller asks for them', async () => {
    discoverCdpPortsMock.mockResolvedValue([
      { port: 9222, reachable: true, engine: 'chrome', tabs: [{ targetId: 'X', title: 'Bank', url: 'https://bank' }] },
    ]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=1&includeForeignTabs=1`)
    ).json();
    expect(body.foreign[0].tabsWithheld).toBe(false);
    expect(body.foreign[0].tabs[0].title).toBe('Bank');
  });

  it('never lists a Node inspector as a browser', async () => {
    // 9229 is in the scan list and is the Node --inspect default, which this
    // server itself lands on when started with --inspect.
    discoverCdpPortsMock.mockResolvedValue([
      { port: 9229, reachable: true, engine: 'node', tabs: [] },
      { port: 9222, reachable: true, engine: 'chrome', tabs: [] },
    ]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=true`)
    ).json();
    expect(body.foreign.map((f: { port: number }) => f.port)).toEqual([9222]);
    expect(JSON.stringify(body)).not.toContain('node');
  });

  it('drops unreachable scan results', async () => {
    discoverCdpPortsMock.mockResolvedValue([
      { port: 9222, reachable: false, engine: 'unknown', tabs: null, error: 'ECONNREFUSED' },
    ]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=true`)
    ).json();
    expect(body.foreign).toEqual([]);
  });

  it('a browser WE own is never reported as foreign, even on a scanned port', async () => {
    // An OS-assigned port can legitimately land in the scan range — W0 saw
    // ports as low as 7566 — so this is not a hypothetical collision.
    knownProfilesMock.mockResolvedValue([liveProfile({ port: 9222, engine: 'chrome' })]);
    discoverCdpPortsMock.mockResolvedValue([{ port: 9222, reachable: true, engine: 'chrome', tabs: [] }]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=true`)
    ).json();
    expect(body.running).toHaveLength(1);
    expect(body.foreign).toEqual([]);
  });

  it('a foreign browser never appears in running', async () => {
    discoverCdpPortsMock.mockResolvedValue([{ port: 9222, reachable: true, engine: 'chrome', tabs: [] }]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=true`)
    ).json();
    expect(body.running).toEqual([]);
    expect(body.foreign).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST — one test per outcome arm
// ---------------------------------------------------------------------------

describe('POST /cdp/browsers', () => {
  const ok = (outcome: string, over: Record<string, unknown> = {}) => ({
    ok: true,
    engine: 'edge',
    profile: 'default',
    profileDir: path.join(PROJECT, '.aiui', 'cdp-profiles', 'edge-default'),
    port: 51000,
    binary: 'C:\\msedge.exe',
    tabs: [],
    outcome,
    warnings: [],
    ...over,
  });

  it('validates the request shape before doing anything', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ projectRoot: 'rel', engine: 'edge' })).status).toBe(400);
    expect((await post({ projectRoot: PROJECT, engine: 'firefox' })).status).toBe(400);
    expect((await post({ projectRoot: PROJECT, engine: 'edge', profile: 7 })).status).toBe(400);
    expect(startCdpBrowserMock).not.toHaveBeenCalled();
  });

  // Four arms, one test each: the arm is what the agent tells the user, and a
  // wrong one is a silent lie about sign-in state.
  for (const outcome of [
    'launched_into_new_profile',
    'launched_into_existing_profile',
    'reused_running_browser',
    'launched_after_reset',
  ]) {
    it(`returns outcome: ${outcome}`, async () => {
      startCdpBrowserMock.mockResolvedValue(ok(outcome));
      const body = await (await post({ projectRoot: PROJECT, engine: 'edge' })).json();
      expect(body.outcome).toBe(outcome);
      expect(body.port).toBe(51000);
    });
  }

  it('defaults the profile to "default" and passes reset through', async () => {
    startCdpBrowserMock.mockResolvedValue(ok('launched_after_reset'));
    await post({ projectRoot: PROJECT, engine: 'chrome', reset: true });
    expect(startCdpBrowserMock).toHaveBeenCalledWith({
      projectRoot: PROJECT,
      engine: 'chrome',
      profile: 'default',
      reset: true,
    });
  });

  it('two concurrent POSTs for the same key produce ONE launch', async () => {
    // Verification rule (6). Both callers would otherwise see "nothing alive",
    // both spawn, and the loser hit the singleton lock and exit — leaving one
    // client holding a successful-looking result for a browser that is not
    // there.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    startCdpBrowserMock.mockImplementation(async () => {
      await gate;
      return ok('launched_into_new_profile');
    });

    const both = Promise.all([
      post({ projectRoot: PROJECT, engine: 'edge' }),
      post({ projectRoot: PROJECT, engine: 'edge' }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await both;

    expect(startCdpBrowserMock).toHaveBeenCalledTimes(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await a.json()).port).toBe((await b.json()).port);
  });

  it('different profiles are NOT serialised against each other', async () => {
    // Two launches for different profiles are legitimately concurrent — they
    // are different processes on different ports. A key without `profile`
    // would serialise them for no reason.
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    startCdpBrowserMock.mockImplementation(async () => {
      started += 1;
      await gate;
      return ok('launched_into_new_profile');
    });

    const both = Promise.all([
      post({ projectRoot: PROJECT, engine: 'edge', profile: 'admin' }),
      post({ projectRoot: PROJECT, engine: 'edge', profile: 'user' }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(2);
    release();
    await both;
  });

  it('a later POST after the first settles launches again', async () => {
    startCdpBrowserMock.mockResolvedValue(ok('reused_running_browser'));
    await post({ projectRoot: PROJECT, engine: 'edge' });
    await post({ projectRoot: PROJECT, engine: 'edge' });
    expect(startCdpBrowserMock).toHaveBeenCalledTimes(2);
  });

  it('maps a bad profile name to 400 and surfaces the message', async () => {
    startCdpBrowserMock.mockResolvedValue({
      ok: false,
      kind: 'invalid_input',
      error: 'Profile name "../../secrets" is not usable.',
    });
    const res = await post({ projectRoot: PROJECT, engine: 'edge', profile: '../../secrets' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('not usable');
  });

  it('maps a state refusal to 409', async () => {
    startCdpBrowserMock.mockResolvedValue({
      ok: false,
      kind: 'refused',
      error: 'a browser is running on it (port 51000)',
    });
    const res = await post({ projectRoot: PROJECT, engine: 'edge', reset: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('51000');
  });

  it('maps a launch failure to 500 and keeps its remediation text', async () => {
    startCdpBrowserMock.mockResolvedValue({
      ok: false,
      kind: 'launch_failed',
      error: 'Edge is not installed…\nInstall Edge, or use the other engine.',
    });
    const res = await post({ projectRoot: PROJECT, engine: 'edge' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('use the other engine');
  });

  it('does not wedge the single-flight slot when a launch fails', async () => {
    startCdpBrowserMock.mockResolvedValueOnce({ ok: false, kind: 'launch_failed', error: 'boom' });
    startCdpBrowserMock.mockResolvedValueOnce(ok('launched_into_new_profile'));
    expect((await post({ projectRoot: PROJECT, engine: 'edge' })).status).toBe(500);
    expect((await post({ projectRoot: PROJECT, engine: 'edge' })).status).toBe(200);
  });

  it('does not wedge the slot when the registry throws', async () => {
    startCdpBrowserMock.mockRejectedValueOnce(new Error('unexpected'));
    startCdpBrowserMock.mockResolvedValueOnce(ok('launched_into_new_profile'));
    expect((await post({ projectRoot: PROJECT, engine: 'edge' })).status).toBe(500);
    expect((await post({ projectRoot: PROJECT, engine: 'edge' })).status).toBe(200);
  });

  it('passes warnings through', async () => {
    startCdpBrowserMock.mockResolvedValue(ok('launched_after_reset', { warnings: ['trash left behind'] }));
    const body = await (await post({ projectRoot: PROJECT, engine: 'edge' })).json();
    expect(body.warnings).toEqual(['trash left behind']);
  });
});
