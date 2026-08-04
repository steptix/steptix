import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import type { ApiClient, McpDeps, ProjectContext, StreamResult } from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// The two CDP tools and the §6 gate, driven through a real MCP client over a
// real transport with only the outside world faked.
//
// This is where the reversal in stories/mcp-cdp-browser.md lives: an agent may
// now name a browser, which `assemble.ts` previously refused outright. The
// tests below are the argument that the narrower rule actually holds — that
// only browsers this project launched get through, that a file-declared `cdp`
// still bypasses the gate, and that each refusal carries the next action.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = 'c:/proj';

function fakeProject(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    projectRoot: PROJECT_ROOT,
    configPath: `${PROJECT_ROOT}/aiui.config.json`,
    env: {},
    envName: null,
    serverUrl: 'http://127.0.0.1:3100',
    apiKey: 'server-key',
    skillsDir: null,
    toolsDir: null,
    cacheEnabled: false,
    envFilesConsulted: [`${PROJECT_ROOT}/.env`],
    cdpPermissions: { allowUnowned: false, ports: null },
    ...overrides,
  };
}

interface Browsers {
  running?: { engine: string; profile: string; port: number; profileDir: string; tabs: unknown[] }[];
  available?: { engine: string; profile: string; profileDir: string }[];
  foreign?: { engine: string; port: number; tabs: unknown; tabsWithheld: boolean; error: string | null }[];
}

interface Harness {
  client: Client;
  /** Every `streamSteps` — empty means no run happened. */
  runs: { sessionId: string; body: Record<string, unknown> }[];
  listCalls: { projectRoot: string; includeForeign?: boolean; includeForeignTabs?: boolean }[];
  startCalls: Record<string, unknown>[];
}

async function connect(
  opts: { project?: ProjectContext; browsers?: Browsers; started?: Record<string, unknown> } = {},
): Promise<Harness> {
  const runs: Harness['runs'] = [];
  const listCalls: Harness['listCalls'] = [];
  const startCalls: Harness['startCalls'] = [];

  const fakeClient: ApiClient = {
    async streamSteps(sessionId, body): Promise<StreamResult> {
      runs.push({ sessionId, body: body as unknown as Record<string, unknown> });
      return { events: [], receivedAt: [], streamDropped: false, dropped: [] };
    },
    async getLastRun() {
      return { finalized: true, reportPath: null, tokens: null };
    },
    async closeSession() {},
    async listSessions() {
      return [];
    },
    async getCdpBrowsers(args) {
      listCalls.push(args);
      return { running: [], available: [], foreign: [], ...opts.browsers } as never;
    },
    async startCdpBrowser(body) {
      startCalls.push(body as unknown as Record<string, unknown>);
      return (opts.started ?? {
        engine: 'edge',
        profile: 'default',
        port: 51000,
        profileDir: 'c:/proj/.aiui/cdp-profiles/edge-default',
        binary: 'C:/msedge.exe',
        tabs: [],
        outcome: 'launched_into_new_profile',
        warnings: [],
      }) as never;
    },
  };

  const deps: McpDeps = {
    createApiClient: () => fakeClient,
    ensureServerReady: async () => {},
    assertServerRecognized: async () => {},
    resolveProject: async () => opts.project ?? fakeProject(),
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, runs, listCalls, startCalls };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function text(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content
    .map((c) => c.text ?? '')
    .join('\n');
}

const RUNNING = [
  { engine: 'edge', profile: 'default', port: 51000, profileDir: 'c:/proj/p/edge-default', tabs: [] },
];
const FOREIGN = [{ engine: 'chrome', port: 9222, tabs: null, tabsWithheld: true, error: null }];

beforeEach(() => resetRegistry());

// ---------------------------------------------------------------------------
// list_cdp_browsers
// ---------------------------------------------------------------------------

describe('list_cdp_browsers', () => {
  it('returns the three lists as structured content', async () => {
    const h = await connect({
      browsers: {
        running: RUNNING,
        available: [{ engine: 'edge', profile: 'admin', profileDir: 'c:/proj/p/edge-admin' }],
        foreign: FOREIGN,
      },
    });
    const result = await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });

    expect(result.isError).toBeFalsy();
    const body = structured(result);
    expect(body.running).toHaveLength(1);
    expect(body.available).toHaveLength(1);
    expect(body.foreign).toHaveLength(1);
  });

  it('summarises in text for a host that ignores structured output', async () => {
    const h = await connect({ browsers: { running: RUNNING, foreign: FOREIGN } });
    const result = await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });
    expect(text(result)).toContain('1 running');
    expect(text(result)).toContain('0 available');
  });

  it('does NOT ask for foreign tabs without the opt-in', async () => {
    // Not asking IS the withholding. The server honours whatever it is asked,
    // because it cannot tell an agent from a human — TestBench and flick are
    // authenticated clients too.
    const h = await connect({ browsers: { running: RUNNING, foreign: FOREIGN } });
    await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });
    expect(h.listCalls[0]?.includeForeignTabs).toBeFalsy();
  });

  it('asks for foreign tabs once allowUnowned is set', async () => {
    const h = await connect({
      project: fakeProject({ cdpPermissions: { allowUnowned: true, ports: null } }),
      browsers: { running: RUNNING, foreign: FOREIGN },
    });
    await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });
    expect(h.listCalls[0]?.includeForeignTabs).toBe(true);
  });

  it('names list_sessions in its description, so the other half of the answer exists', async () => {
    // "What browsers do I have?" has two halves — persistent CDP browsers and
    // per-session launch-mode ones. A description covering only the first
    // answers wrongly and gives no hint that it did.
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'list_cdp_browsers')!.description).toContain('list_sessions');
  });
});

// ---------------------------------------------------------------------------
// start_cdp_browser
// ---------------------------------------------------------------------------

describe('start_cdp_browser', () => {
  it('passes engine and profile through and returns the outcome', async () => {
    const h = await connect({
      started: {
        engine: 'edge',
        profile: 'admin',
        port: 51234,
        profileDir: 'c:/proj/p/edge-admin',
        binary: 'C:/msedge.exe',
        tabs: [],
        outcome: 'launched_into_existing_profile',
        warnings: [],
      },
    });

    const result = await h.client.callTool({
      name: 'start_cdp_browser',
      arguments: { engine: 'edge', profile: 'admin' },
    });

    expect(result.isError).toBeFalsy();
    expect(h.startCalls[0]).toMatchObject({ engine: 'edge', profile: 'admin' });
    expect(structured(result).outcome).toBe('launched_into_existing_profile');
    // The outcome must reach the text summary too: it is what the agent
    // relays, and "may already be signed in" is the point of that arm.
    expect(text(result)).toContain('launched_into_existing_profile');
  });

  it('omits reset entirely unless it is true', async () => {
    // `reset` is a recursive delete of a directory full of logins. It travels
    // only when explicitly asked for.
    const h = await connect();
    await h.client.callTool({
      name: 'start_cdp_browser',
      arguments: { engine: 'chrome', reset: false },
    });
    expect('reset' in h.startCalls[0]!).toBe(false);
  });

  it('sends reset when it is true', async () => {
    const h = await connect();
    await h.client.callTool({
      name: 'start_cdp_browser',
      arguments: { engine: 'chrome', reset: true },
    });
    expect(h.startCalls[0]).toMatchObject({ reset: true });
  });

  it('refuses a profile name that is not a single path component', async () => {
    const h = await connect();
    const result = await h.client.callTool({
      name: 'start_cdp_browser',
      arguments: { engine: 'edge', profile: '../../secrets' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('letters, digits, dot, underscore and hyphen');
    // Refused before any HTTP call.
    expect(h.startCalls).toHaveLength(0);
  });

  it('surfaces warnings in the text summary', async () => {
    const h = await connect({
      started: {
        engine: 'edge',
        profile: 'signup',
        port: 1,
        profileDir: 'c:/p',
        binary: 'b',
        tabs: [],
        outcome: 'launched_after_reset',
        warnings: ['the staging directory could not be removed'],
      },
    });
    const result = await h.client.callTool({
      name: 'start_cdp_browser',
      arguments: { engine: 'edge', profile: 'signup', reset: true },
    });
    expect(text(result)).toContain('staging directory');
  });

  it('describes the behaviours that surprise', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'start_cdp_browser')!.description!;

    // Without this, an agent asked for "a new Chrome" calls with the default
    // profile and is handed the old one.
    expect(description).toContain('To get a genuinely new browser, pass a new `profile` name');
    // Reuse inherits whatever state was left behind — a permission test can
    // otherwise run as the wrong user and pass for the wrong reason.
    expect(description).toContain('may already be signed in');
    // Parallel tests on one profile share cookies.
    expect(description).toContain('one set of cookies');
    // Asking for an existing profile is not an error.
    expect(description).toContain('not** an error');
  });
});

// ---------------------------------------------------------------------------
// The §6 gate
// ---------------------------------------------------------------------------

describe('the gate on an agent-supplied config.cdp', () => {
  it('refuses a port belonging to a browser this project did not start', async () => {
    const h = await connect({ browsers: { foreign: FOREIGN } });

    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { port: 9222 } } },
    });

    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).toContain('9222');
    expect(message).toContain('did not start');
    // The next action — what stops an agent retrying or probing other ports.
    expect(message).toContain('mcp.cdp.allowUnowned');
    expect(message).toContain('list_cdp_browsers');
    // Refused before any run: nothing reached streamSteps.
    expect(h.runs).toHaveLength(0);
  });

  it('permits a port that IS one of this project\u2019s running browsers', async () => {
    const h = await connect({ browsers: { running: RUNNING } });

    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { port: 51000, tab: 'new' } } },
    });

    expect(result.isError).toBeFalsy();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.body.config).toMatchObject({ cdp: { port: 51000, tab: 'new' } });
  });

  it('refuses an unknown port even when nothing at all is listed', async () => {
    const h = await connect({ browsers: {} });
    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { port: 40000 } } },
    });
    expect(result.isError).toBe(true);
    expect(h.runs).toHaveLength(0);
  });

  it('allowUnowned permits an unowned port and skips the round-trip', async () => {
    const h = await connect({
      project: fakeProject({ cdpPermissions: { allowUnowned: true, ports: null } }),
      browsers: { foreign: FOREIGN },
    });

    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { port: 9222 } } },
    });

    expect(result.isError).toBeFalsy();
    expect(h.runs).toHaveLength(1);
    // A human has already said yes; there is nothing left to verify.
    expect(h.listCalls).toHaveLength(0);
  });

  it('tells the agent to relaunch rather than conclude the login is gone', async () => {
    // The row whose absence produces a WRONG conclusion rather than merely an
    // unhelpful one. A closed browser is not a lost browser: the port dies
    // with the process, the profile does not, and relaunching yields a
    // different port with the same signed-in state.
    const h = await connect({
      browsers: { available: [{ engine: 'edge', profile: 'admin', profileDir: 'c:/p/edge-admin' }] },
    });

    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { port: 51000 } } },
    });

    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).toContain('admin');
    expect(message).toContain('start_cdp_browser');
    expect(message).toContain('different');
    expect(message).toContain('still be signed in');
  });

  it('does not consult the registry for a run with no cdp', async () => {
    const h = await connect();
    const result = await h.client.callTool({ name: 'run_steps', arguments: { steps: ['click x'] } });
    expect(result.isError).toBeFalsy();
    expect(h.listCalls).toHaveLength(0);
  });

  it('checks the registry live, not a listing the agent quotes back', async () => {
    // A browser that was running when the agent listed is not necessarily
    // running now. The gate re-reads rather than trusting the argument.
    const h = await connect({ browsers: { running: RUNNING } });
    await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { port: 51000 } } },
    });
    expect(h.listCalls).toHaveLength(1);
    expect(h.listCalls[0]).toMatchObject({ projectRoot: PROJECT_ROOT, includeForeign: true });
  });
});
