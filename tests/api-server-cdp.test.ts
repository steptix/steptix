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
const closeCdpTabMock = vi.fn();
const focusCdpTabMock = vi.fn();
const discoverCdpPortsMock = vi.fn();

vi.mock('../src/browser/cdp-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/cdp-registry.js')>();
  return {
    ...actual,
    // The routes sweep via `knownProfilesAcross` (stories/mcp-no-project.md);
    // the mock stands in for the whole sweep, so fixtures carry `scope`.
    knownProfilesAcross: (...args: unknown[]) => knownProfilesMock(...args),
    startCdpBrowser: (...args: unknown[]) => startCdpBrowserMock(...args),
    closeCdpTab: (...args: unknown[]) => closeCdpTabMock(...args),
    focusCdpTab: (...args: unknown[]) => focusCdpTabMock(...args),
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
  // Real behaviour, not a stub: session-manager uses it to bound page reads
  // while listing, and a mock that resolved instantly would hide a hang.
  briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
  resolveVideoMode: vi.fn(() => 'off'),
  finalizeMainPageVideo: vi.fn(),
}));

const { createApiServer } = await import('../src/server/api-server.js');
const { userRootDir } = await import('../src/env/user-root.js');

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
  scope: 'project',
  ...over,
});

const dormantProfile = (over: Record<string, unknown> = {}) => ({
  engine: 'edge',
  profile: 'admin',
  profileDir: path.join(PROJECT, '.aiui', 'cdp-profiles', 'edge-admin'),
  live: false,
  port: null,
  tabs: null,
  scope: 'project',
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
  closeCdpTabMock.mockReset();
  focusCdpTabMock.mockReset();
  discoverCdpPortsMock.mockReset();
  knownProfilesMock.mockResolvedValue([]);
  discoverCdpPortsMock.mockResolvedValue([]);
});

function del(port: number | string, targetId: string, qs = '', headers = auth) {
  const base = `${baseUrl}/cdp/browsers/${port}/tabs/${encodeURIComponent(targetId)}`;
  const query = `projectRoot=${encodeURIComponent(PROJECT)}${qs}`;
  return fetch(`${base}?${query}`, { method: 'DELETE', headers });
}

function focus(port: number | string, targetId: string, qs = '', headers = auth) {
  const base = `${baseUrl}/cdp/browsers/${port}/tabs/${encodeURIComponent(targetId)}/focus`;
  const query = `projectRoot=${encodeURIComponent(PROJECT)}${qs}`;
  return fetch(`${base}?${query}`, { method: 'POST', headers });
}

const focusedTab = (over: Record<string, unknown> = {}) => ({
  ok: true,
  targetId: 'T1',
  title: 'Orders',
  url: 'https://shop/orders',
  engine: 'edge',
  profile: 'default',
  port: 51000,
  owned: true,
  scope: 'project',
  warnings: [],
  ...over,
});

const closedTab = (over: Record<string, unknown> = {}) => ({
  ok: true,
  targetId: 'T1',
  title: 'Orders',
  url: 'https://shop/orders',
  engine: 'edge',
  profile: 'default',
  port: 51000,
  remainingTabs: 2,
  browserExited: false,
  scope: 'project',
  warnings: [],
  ...over,
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
      scope: 'project',
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
// The two-root sweep (stories/mcp-no-project.md)
// ---------------------------------------------------------------------------

describe('user-root sweep', () => {
  const userRoot = () => userRootDir();

  it('sweeps the user root alongside the project, tagging every entry', async () => {
    knownProfilesMock.mockResolvedValue([
      liveProfile(),
      liveProfile({ scope: 'user', port: 52000, engine: 'chrome' }),
    ]);
    const body = await (await get(`projectRoot=${encodeURIComponent(PROJECT)}`)).json();

    expect(knownProfilesMock).toHaveBeenCalledWith([
      { root: PROJECT, scope: 'project' },
      { root: userRoot(), scope: 'user' },
    ]);
    expect(body.running.map((r: { scope: string }) => r.scope)).toEqual(['project', 'user']);
  });

  it('projectRoot naming the user root collapses to a single user-scope sweep', async () => {
    knownProfilesMock.mockResolvedValue([liveProfile({ scope: 'user' })]);
    const body = await (await get(`projectRoot=${encodeURIComponent(userRoot())}`)).json();

    // One entry, not the same directory swept twice with every browser
    // listed double.
    expect(knownProfilesMock).toHaveBeenCalledWith([{ root: userRoot(), scope: 'user' }]);
    expect(body.running[0].scope).toBe('user');
  });

  it('a user-root browser on a scanned port is never foreign (rule 4)', async () => {
    knownProfilesMock.mockResolvedValue([
      liveProfile({ scope: 'user', port: 9222, engine: 'chrome' }),
    ]);
    discoverCdpPortsMock.mockResolvedValue([
      { port: 9222, reachable: true, engine: 'chrome', tabs: [] },
    ]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=true`)
    ).json();
    expect(body.running).toHaveLength(1);
    expect(body.foreign).toEqual([]);
  });

  it('POST echoes which scope the launch went into', async () => {
    startCdpBrowserMock.mockResolvedValue({
      ok: true,
      engine: 'chrome',
      profile: 'default',
      profileDir: path.join(userRoot(), '.aiui', 'cdp-profiles', 'chrome-default'),
      port: 52000,
      binary: 'C:\\chrome.exe',
      tabs: [],
      outcome: 'launched_into_new_profile',
      warnings: [],
    });

    const asUser = await (await post({ projectRoot: userRoot(), engine: 'chrome' })).json();
    expect(asUser.scope).toBe('user');
    // The launch itself went to the root the client named — the server adds
    // nothing behind its back.
    expect(startCdpBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: userRoot() }),
    );

    const asProject = await (await post({ projectRoot: PROJECT, engine: 'chrome' })).json();
    expect(asProject.scope).toBe('project');
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

// ---------------------------------------------------------------------------
// DELETE /cdp/browsers/:port/tabs/:targetId (stories/cdp-tabs.md §2)
// ---------------------------------------------------------------------------

describe('DELETE /cdp/browsers/:port/tabs/:targetId', () => {
  it('requires the api key', async () => {
    expect((await del(51000, 'T1', '', {})).status).toBe(401);
  });

  it('closes a tab and echoes what went', async () => {
    closeCdpTabMock.mockResolvedValue(closedTab());
    const res = await del(51000, 'T1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      closed: true,
      targetId: 'T1',
      title: 'Orders',
      url: 'https://shop/orders',
      engine: 'edge',
      profile: 'default',
      port: 51000,
      remainingTabs: 2,
      browserExited: false,
      scope: 'project',
      warnings: [],
    });
  });

  it('passes the target id through undecoded, so an odd id still addresses its tab', async () => {
    closeCdpTabMock.mockResolvedValue(closedTab({ targetId: 'A/B?C' }));
    await del(51000, 'A/B?C');
    expect(closeCdpTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 51000,
        targetId: 'A/B?C',
        roots: expect.arrayContaining([
          expect.objectContaining({ root: PROJECT, scope: 'project' }),
        ]),
      }),
    );
  });

  it('forwards allowBrowserExit only when asked', async () => {
    closeCdpTabMock.mockResolvedValue(closedTab());
    await del(51000, 'T1');
    expect(closeCdpTabMock.mock.calls[0]![0]).toMatchObject({ allowBrowserExit: false });

    closeCdpTabMock.mockClear();
    await del(51000, 'T1', '&allowBrowserExit=true');
    expect(closeCdpTabMock.mock.calls[0]![0]).toMatchObject({ allowBrowserExit: true });
  });

  it('reports a browser that exited with its last tab', async () => {
    closeCdpTabMock.mockResolvedValue(closedTab({ remainingTabs: 0, browserExited: true }));
    const body = await (await del(51000, 'T1', '&allowBrowserExit=true')).json();
    expect(body).toMatchObject({ closed: true, browserExited: true, remainingTabs: 0 });
  });

  it('maps the four failure kinds onto their status codes', async () => {
    // The mapping is the route's whole job, and each code means something
    // different to a client: 404 "not here", 409 "state says no, retrying will
    // not help", 500 "we tried and it broke".
    for (const [kind, status] of [
      ['not_found', 404],
      ['refused', 409],
      ['launch_failed', 500],
      ['invalid_input', 400],
    ] as const) {
      closeCdpTabMock.mockResolvedValue({ ok: false, kind, error: `${kind} happened` });
      const res = await del(51000, 'T1');
      expect(res.status, kind).toBe(status);
      expect((await res.json()).error).toContain(kind);
    }
  });

  it('rejects a bad port before reaching the registry', async () => {
    const res = await del('not-a-port', 'T1');
    expect(res.status).toBe(400);
    expect(closeCdpTabMock).not.toHaveBeenCalled();
  });

  it('rejects a relative projectRoot', async () => {
    const res = await fetch(
      `${baseUrl}/cdp/browsers/51000/tabs/T1?projectRoot=relative`,
      { method: 'DELETE', headers: auth },
    );
    expect(res.status).toBe(400);
    expect(closeCdpTabMock).not.toHaveBeenCalled();
  });

  it('requires projectRoot', async () => {
    const res = await fetch(`${baseUrl}/cdp/browsers/51000/tabs/T1`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).toBe(400);
    expect(closeCdpTabMock).not.toHaveBeenCalled();
  });

  it('serialises concurrent closes against one browser', async () => {
    // Without a queue the `allow_browser_exit` flag is bypassable, which is
    // the one guarantee this route exists to give: two closes against a
    // two-tab browser both read a list of length two, both conclude they are
    // not closing the last tab, and the browser exits with neither caller
    // having asked. An MCP host issuing two tool calls in one turn is enough.
    let inFlight = 0;
    let maxConcurrent = 0;
    closeCdpTabMock.mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return closedTab();
    });

    await Promise.all([del(51000, 'T1'), del(51000, 'T2'), del(51000, 'T3')]);

    expect(maxConcurrent).toBe(1);
    expect(closeCdpTabMock).toHaveBeenCalledTimes(3);
  });

  it('serialises closes on one browser across DIFFERENT project roots', async () => {
    // Round-two regression. The key was `(projectRoot, port)`, which gave one
    // browser a queue per project — and this server is a per-machine singleton
    // serving many roots, with `allowUnowned` explicitly letting one project
    // address another's browser. A port is one socket on this machine, so the
    // port alone identifies the browser.
    let inFlight = 0;
    let maxConcurrent = 0;
    closeCdpTabMock.mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return closedTab();
    });

    const other = path.join('C:', 'other-project');
    await Promise.all([
      del(9222, 'T1'),
      fetch(
        `${baseUrl}/cdp/browsers/9222/tabs/T2?projectRoot=${encodeURIComponent(other)}`,
        { method: 'DELETE', headers: auth },
      ),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it('does not serialise closes against DIFFERENT browsers', async () => {
    // The queue is per browser. Two browsers are independent, and sharing one
    // chain would make an unrelated close wait behind a slow one.
    let inFlight = 0;
    let maxConcurrent = 0;
    closeCdpTabMock.mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return closedTab();
    });

    await Promise.all([del(51000, 'T1'), del(51001, 'T2')]);

    expect(maxConcurrent).toBe(2);
  });

  it('a failed close does not poison the queue for the next caller', async () => {
    closeCdpTabMock.mockRejectedValueOnce(new Error('boom'));
    closeCdpTabMock.mockResolvedValueOnce(closedTab());
    expect((await del(51000, 'T1')).status).toBe(500);
    expect((await del(51000, 'T2')).status).toBe(200);
  });

  it('forwards allowUnowned only when asked', async () => {
    // Mirrors `includeForeignTabs` on the listing: the server honours what it
    // is asked and the withholding lives MCP-side. Without the pass-through,
    // mcp.cdp.allowUnowned would grant nothing for a close.
    closeCdpTabMock.mockResolvedValue(closedTab());
    await del(51000, 'T1');
    expect(closeCdpTabMock.mock.calls[0]![0]).toMatchObject({ allowUnowned: false });

    closeCdpTabMock.mockClear();
    await del(51000, 'T1', '&allowUnowned=true');
    expect(closeCdpTabMock.mock.calls[0]![0]).toMatchObject({ allowUnowned: true });
  });

  it('supplies a session lookup the registry can call', async () => {
    // The registry cannot see the server's sessions, so the route injects the
    // join. Without it the "a session is driving that tab" guard silently
    // never fires — a passing test suite with the guard disconnected.
    closeCdpTabMock.mockResolvedValue(closedTab());
    await del(51000, 'T1');
    const opts = closeCdpTabMock.mock.calls[0]![0] as {
      sessionHolding?: (id: string) => Promise<string | null | symbol>;
    };
    expect(typeof opts.sessionHolding).toBe('function');
    // No sessions at all is a COMPLETE answer of "nobody", not an unknown.
    await expect(opts.sessionHolding!('T1')).resolves.toBeNull();
  });

  it('supplies an errand lookup the registry can call, and relays its holder', async () => {
    // Two halves, each of which fails silently on its own. Without the
    // injection the errand guard never fires — a green suite with the guard
    // disconnected. Without the relay the 409 loses its `holder`, and the MCP
    // side falls back to the generic "the server rejected the request".
    closeCdpTabMock.mockResolvedValue(closedTab());
    await del(51000, 'T1');
    const opts = closeCdpTabMock.mock.calls[0]![0] as {
      errandHolding?: (id: string) => unknown;
    };
    expect(typeof opts.errandHolding).toBe('function');
    // No errand running is a definite "nobody": unlike the session join, an
    // errand's holds live in this process's memory and cannot be unknown.
    expect(opts.errandHolding!('T1')).toBeNull();

    closeCdpTabMock.mockResolvedValue({
      ok: false,
      kind: 'refused',
      error: 'Errand errand-abc123 is driving that tab.',
      holder: { kind: 'errand', errandId: 'errand-abc123', tabRole: 'opened' },
    });
    const refused = await del(51000, 'T1');
    expect(refused.status).toBe(409);
    expect((await refused.json()).holder).toEqual({
      kind: 'errand',
      errandId: 'errand-abc123',
      tabRole: 'opened',
    });
  });
});

// ---------------------------------------------------------------------------
// POST /cdp/browsers/:port/tabs/:targetId/focus (stories/cdp-tab-focus.md §2)
// ---------------------------------------------------------------------------

describe('POST /cdp/browsers/:port/tabs/:targetId/focus', () => {
  it('requires the api key', async () => {
    expect((await focus(51000, 'T1', '', {})).status).toBe(401);
  });

  it('an authenticated focus bumps the idle monitor', async () => {
    // Same reasoning as the listing's: these routes sit behind auth, so they
    // count as activity. Safe only because nothing polls them.
    const { app, idleMonitor } = createApiServer(testConfig);
    const local = await listenOnRandomPort(app);
    try {
      const QUIET_MS = 250;
      await new Promise((r) => setTimeout(r, QUIET_MS));
      expect(idleMonitor.idleFor()).toBeGreaterThanOrEqual(QUIET_MS);

      focusCdpTabMock.mockResolvedValue(focusedTab());
      await fetch(
        `${local.baseUrl}/cdp/browsers/51000/tabs/T1/focus?projectRoot=${encodeURIComponent(PROJECT)}`,
        { method: 'POST', headers: auth },
      );

      expect(idleMonitor.idleFor()).toBeLessThan(QUIET_MS);
    } finally {
      await new Promise<void>((res, rej) => local.server.close((e) => (e ? rej(e) : res())));
    }
  });

  it('focuses a tab and echoes the title and url it brought forward', async () => {
    focusCdpTabMock.mockResolvedValue(focusedTab());
    const res = await focus(51000, 'T1');
    expect(res.status).toBe(200);
    // Exactly this shape — `focused`, not `closed`, and no `remainingTabs` or
    // `browserExited`, because nothing was closed.
    expect(await res.json()).toEqual({
      focused: true,
      targetId: 'T1',
      title: 'Orders',
      url: 'https://shop/orders',
      engine: 'edge',
      profile: 'default',
      port: 51000,
      scope: 'project',
      warnings: [],
    });
  });

  it('passes the target id through undecoded, so an odd id still addresses its tab', async () => {
    focusCdpTabMock.mockResolvedValue(focusedTab({ targetId: 'A/B?C' }));
    await focus(51000, 'A/B?C');
    expect(focusCdpTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 51000,
        targetId: 'A/B?C',
        roots: expect.arrayContaining([
          expect.objectContaining({ root: PROJECT, scope: 'project' }),
        ]),
      }),
    );
  });

  it('forwards allowUnowned only when asked', async () => {
    focusCdpTabMock.mockResolvedValue(focusedTab());
    await focus(51000, 'T1');
    expect(focusCdpTabMock.mock.calls[0]![0]).toMatchObject({ allowUnowned: false });

    focusCdpTabMock.mockClear();
    await focus(51000, 'T1', '&allowUnowned=true');
    expect(focusCdpTabMock.mock.calls[0]![0]).toMatchObject({ allowUnowned: true });
  });

  it('maps the four failure kinds onto their status codes', async () => {
    for (const [kind, status] of [
      ['not_found', 404],
      ['refused', 409],
      ['launch_failed', 500],
      ['invalid_input', 400],
    ] as const) {
      focusCdpTabMock.mockResolvedValue({ ok: false, kind, error: `${kind} happened` });
      const res = await focus(51000, 'T1');
      expect(res.status, kind).toBe(status);
      expect((await res.json()).error).toContain(kind);
    }
  });

  it('validates its inputs before reaching the registry', async () => {
    expect((await focus('not-a-port', 'T1')).status).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/cdp/browsers/51000/tabs/T1/focus?projectRoot=relative`, {
          method: 'POST',
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/cdp/browsers/51000/tabs/T1/focus`, {
          method: 'POST',
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(focusCdpTabMock).not.toHaveBeenCalled();
  });

  it('does NOT serialise concurrent focuses', async () => {
    // The close route queues per port because two concurrent closes can defeat
    // the last-tab guard. Focus has no guard to defeat and no irreversible
    // outcome — two at once simply mean the second wins, which is what "focus"
    // means. Copying the neighbour's queue would be cargo-culting, and this is
    // the assertion that says so out loud.
    let inFlight = 0;
    let maxConcurrent = 0;
    focusCdpTabMock.mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return focusedTab();
    });

    await Promise.all([focus(51000, 'T1'), focus(51000, 'T2'), focus(51000, 'T3')]);

    expect(maxConcurrent).toBe(3);
  });

  it('does not close anything, or create a session', async () => {
    // Verification rule (5), at the layer this suite can reach: the focus route
    // must not touch the close path at all.
    focusCdpTabMock.mockResolvedValue(focusedTab());
    await focus(51000, 'T1');
    expect(closeCdpTabMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tab → session join on the listing (stories/cdp-tabs.md §1)
// ---------------------------------------------------------------------------

describe('GET /cdp/browsers reports which session drives each tab', () => {
  it('adds sessionId to every owned tab', async () => {
    knownProfilesMock.mockResolvedValue([liveProfile()]);
    const body = await (await get(`projectRoot=${encodeURIComponent(PROJECT)}`)).json();
    // No sessions exist in this suite, so the honest answer is null — but the
    // KEY must be present either way: a consumer that reads `tab.sessionId`
    // needs the field, not its absence.
    expect(body.running[0].tabs[0]).toEqual({
      targetId: 'T1',
      title: 'Orders',
      url: 'https://shop/orders',
      sessionId: null,
    });
  });

  it('leaves foreign tabs alone — we have no sessions on a browser we did not start', async () => {
    discoverCdpPortsMock.mockResolvedValue([
      {
        port: 9222,
        reachable: true,
        engine: 'chrome',
        tabs: [{ targetId: 'F1', title: 'Mail', url: 'https://mail' }],
      },
    ]);
    const body = await (
      await get(`projectRoot=${encodeURIComponent(PROJECT)}&includeForeign=true&includeForeignTabs=true`)
    ).json();
    expect(body.foreign[0].tabs[0]).not.toHaveProperty('sessionId');
  });
});
