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
  /** Which readiness check the tool took — `'ensure'` auto-starts a stopped
   *  server, `'assert'` only refuses a squatter. */
  readiness: ('ensure' | 'assert')[];
}

async function connect(
  opts: {
    project?: ProjectContext;
    browsers?: Browsers;
    started?: Record<string, unknown>;
    /** Make the registry unreachable, to prove a listing failure cannot change
     *  a finished run's outcome. */
    browsersThrow?: boolean;
    /**
     * Emit one real step event per run.
     *
     * Needed by any test that wants a SECOND call to see an existing session:
     * `markConfigured()` is guarded on `events.length > 0` — deliberately, so a
     * connect failure cannot burn the flag — so a fake that streams nothing
     * leaves every call looking like the first one.
     */
    emitEvents?: boolean;
  } = {},
): Promise<Harness> {
  const runs: Harness['runs'] = [];
  const listCalls: Harness['listCalls'] = [];
  const startCalls: Harness['startCalls'] = [];
  const readiness: Harness['readiness'] = [];

  const fakeClient: ApiClient = {
    async streamSteps(sessionId, body): Promise<StreamResult> {
      runs.push({ sessionId, body: body as unknown as Record<string, unknown> });
      if (opts.emitEvents !== true) {
        return { events: [], receivedAt: [], streamDropped: false, dropped: [] };
      }
      return {
        events: [{ type: 'step:pass', line: 1 }],
        receivedAt: [0],
        streamDropped: false,
        dropped: [],
      };
    },
    async getLastRun() {
      return { finalized: true, reportPath: null, tokens: null };
    },
    async closeSession() {},
    async getPageContent(sessionId) {
      return {
        sessionId,
        url: 'https://example.test/',
        title: 'Example',
        status: 'active',
        format: 'text',
        selector: null,
        content: 'page text',
        truncated: false,
        returnedChars: 9,
        availableChars: 9,
      } as never;
    },
    async listSessions() {
      return [];
    },
    async getCdpBrowsers(args) {
      listCalls.push(args);
      if (opts.browsersThrow === true) throw new Error('registry unreachable');
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
    ensureServerReady: async () => {
      readiness.push('ensure');
    },
    assertServerRecognized: async () => {
      readiness.push('assert');
    },
    resolveProject: async () => opts.project ?? fakeProject(),
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, runs, listCalls, startCalls, readiness };
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

  it('never starts a server — it only reports what is already there', async () => {
    // The other half of the `start_cdp_browser` regression: this one is a
    // genuine probe and belongs with `list_sessions`. "What browsers do I
    // have?" must not launch a Sessions API server as a side effect.
    const h = await connect();

    await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });

    expect(h.readiness).toEqual(['assert']);
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

  it('auto-starts a stopped server rather than failing on connect', async () => {
    // Regression: this tool reached `withProject` with the probes' default and
    // inherited a rule written for read-only tools ("asking what is running
    // must not cause a server to exist"). Its entire purpose is to make
    // something exist, so against a stopped server it died on a bare
    // ECONNREFUSED — while `run_test_file` from the same agent, one second
    // earlier, would have started the server for itself.
    const h = await connect();

    await h.client.callTool({ name: 'start_cdp_browser', arguments: { engine: 'edge' } });

    expect(h.readiness).toEqual(['ensure']);
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

// ---------------------------------------------------------------------------
// Addressing a browser by profile (stories/cdp-session-binding.md §1)
// ---------------------------------------------------------------------------

describe('config.cdp addressed by profile', () => {
  it('refuses a profile whose browser is not running, naming the remedy', async () => {
    // "Not running" reads as "signed out" to a model, and it is not — the
    // login lives in the profile directory. The message has to say so or the
    // agent concludes the login is gone and starts a sign-in flow.
    const h = await connect({
      browsers: { available: [{ engine: 'edge', profile: 'admin', profileDir: 'c:/p/edge-admin' }] },
    });
    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { profile: 'admin' } } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('start_cdp_browser');
    expect(text(result)).toContain('not a lost login');
    expect(h.runs).toHaveLength(0);
  });

  it('refuses when profile and port are both given', async () => {
    // They can name different browsers. Picking a winner in silence is exactly
    // the class of bug this story exists to remove.
    const h = await connect({ browsers: { running: RUNNING } });
    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { profile: 'default', port: 51000 } } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('both');
    expect(h.runs).toHaveLength(0);
  });

  it('refuses when config.cdp names neither', async () => {
    const h = await connect({ browsers: { running: RUNNING } });
    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: {} } },
    });
    expect(result.isError).toBe(true);
    expect(h.runs).toHaveLength(0);
  });

  it('refuses an ambiguous profile rather than guessing an engine', async () => {
    // The wrong guess is a browser signed in as somebody else.
    const h = await connect({
      browsers: {
        running: [
          { engine: 'chrome', profile: 'default', port: 51000, profileDir: 'a', tabs: [] },
          { engine: 'edge', profile: 'default', port: 51001, profileDir: 'b', tabs: [] },
        ],
      },
    });
    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { profile: 'default' } } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('engine');
    expect(h.runs).toHaveLength(0);
  });

  it('an engine disambiguates the same profile name', async () => {
    const h = await connect({
      browsers: {
        running: [
          { engine: 'chrome', profile: 'default', port: 51000, profileDir: 'a', tabs: [] },
          { engine: 'edge', profile: 'default', port: 51001, profileDir: 'b', tabs: [] },
        ],
      },
    });
    await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { profile: 'default', engine: 'edge' } } },
    });
    expect(h.runs[0]?.body).toMatchObject({ config: { cdp: { port: 51001 } } });
  });
});

// ---------------------------------------------------------------------------
// Warnings when the CDP intent is lost (§2)
// ---------------------------------------------------------------------------

describe('CDP warnings', () => {
  /** Run once so the session exists, then again — the second call is the one
   *  under test, because config is only honoured at creation. */
  async function secondCall(h: Harness, args: Record<string, unknown>): Promise<unknown> {
    await h.client.callTool({ name: 'run_steps', arguments: { steps: ['first'] } });
    return h.client.callTool({ name: 'run_steps', arguments: { steps: ['second'], ...args } });
  }

  it('W1: warns that config.cdp was dropped on an existing session', async () => {
    // Measured before this existed: status "passed", warnings [], and the
    // steps ran in the wrong browser. Silence was the defect.
    const h = await connect({ browsers: { running: RUNNING }, emitEvents: true });
    const result = await secondCall(h,{ config: { cdp: { port: 51000 } } });
    const warnings = structured(result)['warnings'] as string[];
    expect(warnings.join('\n')).toContain('close_session');
    expect(structured(result)['configApplied']).toBe(false);
  });

  it('W2: warns when a fresh browser was launched while a CDP one sat idle', async () => {
    const h = await connect({ browsers: { running: RUNNING } });
    const result = await h.client.callTool({ name: 'run_steps', arguments: { steps: ['click x'] } });
    const warnings = (structured(result)['warnings'] as string[]).join('\n');
    expect(warnings).toContain('signed-out');
    expect(warnings).toContain('"default"');
  });

  it('W2: silent when nothing is running', async () => {
    const h = await connect();
    const result = await h.client.callTool({ name: 'run_steps', arguments: { steps: ['click x'] } });
    expect((structured(result)['warnings'] as string[]).join('\n')).not.toContain('signed-out');
  });

  it('W2: silent when cdp WAS supplied', async () => {
    const h = await connect({ browsers: { running: RUNNING } });
    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { profile: 'default' } } },
    });
    expect((structured(result)['warnings'] as string[]).join('\n')).not.toContain('signed-out');
  });

  it('W2: silent on a reused session, where the advice is unactionable', async () => {
    // Config is only read at creation, so repeating this on every later call
    // would be noise — and a warning that cries wolf is one nobody reads.
    const h = await connect({ browsers: { running: RUNNING }, emitEvents: true });
    const result = await secondCall(h,{});
    expect((structured(result)['warnings'] as string[]).join('\n')).not.toContain('signed-out');
  });

  it('W2: a registry failure costs the warning, never the run', async () => {
    // This decorates a run that has ALREADY finished. A broken registry must
    // cost a missing warning and nothing else.
    const h = await connect({ browsersThrow: true });
    const result = await h.client.callTool({ name: 'run_steps', arguments: { steps: ['click x'] } });
    expect(result.isError).toBeFalsy();
    expect(h.runs).toHaveLength(1);
    expect((structured(result)['warnings'] as string[]).join('\n')).not.toContain('signed-out');
  });
});

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

  it('does not run the GATE for a run with no cdp', async () => {
    // A run with no `cdp` still reads the registry — that is W2 looking for an
    // idle CDP browser to warn about — but it must not pay for the *gate*,
    // which is the expensive live check and has nothing to verify here. The
    // two are told apart by `includeForeign`: the gate needs foreign browsers
    // to explain WHY a port was refused; W2 only cares what we own.
    const h = await connect();
    const result = await h.client.callTool({ name: 'run_steps', arguments: { steps: ['click x'] } });
    expect(result.isError).toBeFalsy();
    expect(h.listCalls.filter((c) => c.includeForeign === true)).toHaveLength(0);
  });

  it('skips the gate when the port came from resolving a profile', async () => {
    // Not an optimisation. A port read out of our own `running` list is owned
    // by construction, so there is nothing left for the gate to establish —
    // and the gate would refuse a browser we just legitimately resolved.
    const h = await connect({ browsers: { running: RUNNING } });
    const result = await h.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click x'], config: { cdp: { profile: 'default' } } },
    });
    expect(result.isError).toBeFalsy();
    expect(h.listCalls.filter((c) => c.includeForeign === true)).toHaveLength(0);
    expect(h.runs[0]?.body).toMatchObject({ config: { cdp: { port: 51000, profile: 'default' } } });
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
