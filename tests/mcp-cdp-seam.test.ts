import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import { ApiHttpError } from '../src/mcp/types.js';
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
  /** Every `closeCdpTab` that reached the wire — empty means a refusal fired
   *  before the request, which is the point of a pre-flight gate. */
  closeCalls: Record<string, unknown>[];
  /** Same, for `focusCdpTab`. */
  focusCalls: Record<string, unknown>[];
  /** Which readiness check the tool took — `'ensure'` auto-starts a stopped
   *  server, `'assert'` only refuses a squatter. */
  readiness: ('ensure' | 'assert')[];
}

async function connect(
  opts: {
    project?: ProjectContext;
    browsers?: Browsers;
    started?: Record<string, unknown>;
    closed?: Record<string, unknown>;
    focused?: Record<string, unknown>;
    /** Make `focusCdpTab` throw — used for the two 404 readings, which are the
     *  only place the tool inspects an HTTP status itself. */
    focusThrows?: Error;
    /** Sessions `list_sessions` should report. */
    sessions?: Record<string, unknown>[];
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
  const closeCalls: Harness['closeCalls'] = [];
  const focusCalls: Harness['focusCalls'] = [];
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
      return (opts.sessions ?? []) as never;
    },
    async closeCdpTab(args) {
      closeCalls.push(args as unknown as Record<string, unknown>);
      return (opts.closed ?? {
        closed: true,
        targetId: args.targetId,
        title: 'OpenRouter — Docs',
        url: 'https://openrouter.ai/docs',
        engine: 'edge',
        profile: 'default',
        port: args.port,
        remainingTabs: 7,
        browserExited: false,
        owned: true,
        warnings: [],
      }) as never;
    },
    async focusCdpTab(args) {
      focusCalls.push(args as unknown as Record<string, unknown>);
      if (opts.focusThrows) throw opts.focusThrows;
      // Echo the tab the id actually names, the way the real route does — it
      // reads title and url out of the browser's own list. A fake that always
      // answered with one hardcoded title would let a tool that focused the
      // wrong tab pass every assertion about what it says it showed.
      const known = (opts.browsers?.running ?? [])
        .flatMap((b) => b.tabs as { targetId: string; title: string; url: string }[])
        .find((t) => t.targetId === args.targetId);
      return (opts.focused ?? {
        focused: true,
        targetId: args.targetId,
        title: known?.title ?? 'OpenRouter — Docs',
        url: known?.url ?? 'https://openrouter.ai/docs',
        engine: 'edge',
        profile: 'default',
        port: args.port,
        warnings: [],
      }) as never;
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
  return { client, runs, listCalls, startCalls, closeCalls, focusCalls, readiness };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function text(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content
    .map((c) => c.text ?? '')
    .join('\n');
}

/** `content[0]` alone — the human-readable summary, without the serialized
 *  `structuredContent` block that follows it. */
function summary(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content[0]?.text ?? '';
}

const RUNNING = [
  { engine: 'edge', profile: 'default', port: 51000, profileDir: 'c:/proj/p/edge-default', tabs: [] },
];

/** A browser with tabs, one of them driven by a session. The shape the close
 *  flow actually reads. */
const RUNNING_WITH_TABS = [
  {
    engine: 'edge',
    profile: 'default',
    port: 51000,
    profileDir: 'c:/proj/p/edge-default',
    tabs: [
      {
        targetId: 'A1B2C3',
        title: 'OpenRouter — Docs',
        url: 'https://openrouter.ai/docs',
        sessionId: null,
      },
      {
        targetId: 'D4E5F6',
        title: 'Cart — Shop',
        url: 'https://shop.example/cart',
        sessionId: 'mcp:x',
      },
    ],
  },
];
/** A browser holding several tabs — the shape the focus flow is for. Four,
 *  because two would let a toggle pass as a switcher. */
const RUNNING_WITH_MANY_TABS = [
  {
    engine: 'edge',
    profile: 'default',
    port: 51000,
    profileDir: 'c:/proj/p/edge-default',
    tabs: [
      { targetId: 'T-DOCS', title: 'OpenRouter — Docs', url: 'https://openrouter.ai/docs', sessionId: null },
      { targetId: 'T-CART', title: 'Cart — Shop', url: 'https://shop.example/cart', sessionId: 'mcp:x' },
      { targetId: 'T-MAIL', title: 'Inbox', url: 'https://mail.example/inbox', sessionId: null },
      { targetId: 'T-NEW', title: 'New Tab', url: 'edge://newtab/', sessionId: null },
    ],
  },
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

// ---------------------------------------------------------------------------
// close_cdp_tab (stories/cdp-tabs.md §3)
//
// The destructive verb. What these assert is not that a close works — the fake
// always says it did — but that the agent is stopped before the wire when it
// should be, and told enough afterwards to relay what happened.
// ---------------------------------------------------------------------------

describe('close_cdp_tab', () => {
  it('resolves a profile to a port and closes the named tab', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });

    expect(result.isError).toBeFalsy();
    expect(h.closeCalls).toHaveLength(1);
    expect(h.closeCalls[0]).toMatchObject({
      projectRoot: PROJECT_ROOT,
      port: 51000,
      targetId: 'A1B2C3',
    });
    // The agent never sent a port; it named the browser the way a user does.
    expect(h.closeCalls[0]).not.toHaveProperty('allowBrowserExit');
  });

  it('maps every output field through as structured content', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(structured(result)).toMatchObject({
      closed: true,
      targetId: 'A1B2C3',
      title: 'OpenRouter — Docs',
      url: 'https://openrouter.ai/docs',
      engine: 'edge',
      profile: 'default',
      port: 51000,
      remainingTabs: 7,
      browserExited: false,
    });
  });

  it('names the closed tab and the count in text, for a host that shows only that', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(text(result)).toContain('OpenRouter — Docs');
    expect(text(result)).toContain('7 tabs left');
  });

  it('says the browser closed too when the last tab went with it', async () => {
    // The one outcome a user must never learn about by looking at their
    // taskbar. `browserExited` is in structured content, but the summary is
    // all some hosts render — so it has to carry it as well.
    const h = await connect({
      browsers: { running: RUNNING_WITH_TABS },
      closed: {
        closed: true,
        targetId: 'A1B2C3',
        title: 'OpenRouter — Docs',
        url: 'https://openrouter.ai/docs',
        engine: 'edge',
        profile: 'default',
        port: 51000,
        remainingTabs: 0,
        browserExited: true,
        owned: true,
        warnings: [],
      },
    });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3', allow_browser_exit: true },
    });
    expect(structured(result).browserExited).toBe(true);
    // Says the browser went, without asserting WHY. The tab count and the
    // browser's own idea of what keeps it alive can disagree — a dialog
    // reports as a page target — so "that was its last tab" is a claim the
    // summary is not entitled to make.
    expect(text(result)).toMatch(/edge "default" closed with it/);
    // And the reassurance, since "the browser closed" reads as "the login is
    // gone" to a model and it is not.
    expect(text(result)).toContain('logins');
  });

  it('does not report a SUCCESSFUL close as a broken tool on an older server', async () => {
    // The worst version-skew case in the feature, because it lands after an
    // irreversible act. `owned` is required by the output schema; a Sessions
    // API server predating it omits the key, validation fails, and the agent
    // is told the tool is broken with no structured content — for a tab that
    // is already gone. Its natural retry then hits "something else closed it
    // first", so the user hears the close failed twice.
    const h = await connect({
      browsers: { running: RUNNING_WITH_TABS },
      closed: {
        closed: true,
        targetId: 'A1B2C3',
        title: 'OpenRouter — Docs',
        url: 'https://openrouter.ai/docs',
        engine: 'edge',
        profile: 'default',
        port: 51000,
        remainingTabs: 7,
        browserExited: false,
        // no `owned` — the older server's shape
        warnings: [],
      },
    });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });

    expect(result.isError).toBeFalsy();
    // Derived, not defaulted: this call resolved a PROFILE, so the port came
    // out of our own `running` list and is owned by construction.
    expect(structured(result).owned).toBe(true);
    expect(text(result)).toContain('OpenRouter — Docs');
  });

  it('does not claim an older server closed OUR browser when it might not have', async () => {
    // The backfill used to be a flat `true`, justified by "a server without
    // this field has no unowned path". False: a mid-branch server gained
    // `allowUnowned` before it gained `owned`. The assumption failed in the
    // dangerous direction — reporting a human's just-terminated browser as
    // ours and repeating "the profile keeps its logins" about something
    // nothing here can reopen.
    const h = await connect({
      project: fakeProject({ cdpPermissions: { allowUnowned: true, ports: null } }),
      browsers: { running: RUNNING_WITH_TABS, foreign: FOREIGN },
      closed: {
        closed: true,
        targetId: 'A1B2C3',
        title: 'Personal banking',
        url: 'https://bank.example/',
        engine: 'chrome',
        profile: '',
        port: 9222,
        remainingTabs: 0,
        browserExited: true,
        // no `owned` — the mid-branch server's shape
        warnings: [],
      },
    });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { port: 9222, target_id: 'A1B2C3', allow_browser_exit: true },
    });

    expect(result.isError).toBeFalsy();
    // Unknown resolves to the cautious answer.
    expect(structured(result).owned).toBe(false);
    expect(text(result)).not.toMatch(/keeps its logins/i);
    expect(text(result)).toMatch(/nothing here can reopen it/i);
    // And no `chrome ""` from the empty profile. Against `summary()`, not the
    // joined blocks: every result now also carries its serialized
    // `structuredContent`, and `"profile":""` is a legitimate empty string
    // there — the thing being guarded is the prose, which is where an empty
    // profile would read as a browser with no name.
    expect(summary(result)).not.toContain('""');
  });

  it('survives an older server that omits `warnings` too', async () => {
    // The other required field read un-normalised, on the same
    // after-the-tab-is-gone path.
    const h = await connect({
      browsers: { running: RUNNING_WITH_TABS },
      closed: {
        closed: true,
        targetId: 'A1B2C3',
        title: 'Docs',
        url: 'https://openrouter.ai/docs',
        engine: 'edge',
        profile: 'default',
        port: 51000,
        remainingTabs: 7,
        browserExited: false,
      },
    });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });

    expect(result.isError).toBeFalsy();
    expect(structured(result).warnings).toEqual([]);
  });

  it('forwards allow_browser_exit only when it was asked for', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3', allow_browser_exit: true },
    });
    expect(h.closeCalls[0]).toMatchObject({ allowBrowserExit: true });
  });

  it('refuses both `profile` and `port`, and never reaches the wire', async () => {
    // Two addresses that disagree have no correct winner, and this call closes
    // something. The message must name THIS tool's arguments — a refusal that
    // talks about config.cdp cannot be acted on here.
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', port: 51000, target_id: 'A1B2C3' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('config.cdp');
    expect(text(result)).toMatch(/not both/i);
    expect(h.closeCalls).toHaveLength(0);
  });

  it('refuses neither `profile` nor `port`', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { target_id: 'A1B2C3' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('list_cdp_browsers');
    expect(h.closeCalls).toHaveLength(0);
  });

  it('skips the gate for a profile-resolved port', async () => {
    // Same narrowing as the run path: a port read out of our own `running`
    // list is owned by construction, so the gate has nothing left to check.
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(h.listCalls.filter((c) => c.includeForeign === true)).toHaveLength(0);
  });

  it('gates a caller-supplied port, and refuses a foreign one', async () => {
    // Closing tabs in a browser is at least as intrusive as driving one, so it
    // clears the same gate. A foreign browser could be anyone's.
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS, foreign: FOREIGN } });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { port: 9222, target_id: 'A1B2C3' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('mcp.cdp.allowUnowned');
    expect(h.closeCalls).toHaveLength(0);
  });

  it('permits a foreign port once allowUnowned is set', async () => {
    const h = await connect({
      project: fakeProject({ cdpPermissions: { allowUnowned: true, ports: null } }),
      browsers: { running: RUNNING_WITH_TABS, foreign: FOREIGN },
    });
    const result = await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { port: 9222, target_id: 'A1B2C3' },
    });
    expect(result.isError).toBeFalsy();
    expect(h.closeCalls[0]).toMatchObject({ port: 9222 });
  });

  it('auto-starts a stopped server, like the other tools that act', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    await h.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(h.readiness).toEqual(['ensure']);
  });

  it('tells the agent to match the tab itself, and warns about the last tab', async () => {
    // The description is the whole interface for both behaviours: an agent
    // that does not know matching is its job will look for a selector
    // argument, and one that does not know about the last tab will read the
    // refusal as a bug.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'close_cdp_tab')!.description!;
    expect(description).toContain('list_cdp_browsers');
    expect(description).toMatch(/yourself/);
    expect(description).toContain('allow_browser_exit');
    expect(description).toContain('close_session');
  });

  it('never promises unconditionally that a closed browser can be reopened', async () => {
    // The static prose is what an agent reads when it decides to set
    // `allow_browser_exit` pre-emptively — the path where the corrected
    // runtime refusal never fires. Both the description and the argument's own
    // description used to say "nothing is lost", which is false for a browser
    // this project did not start.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'close_cdp_tab')!;
    const argDescription = JSON.stringify(tool.inputSchema);

    for (const text of [tool.description!, argDescription]) {
      // Where the reassurance appears it must be qualified by ownership.
      if (/nothing is lost/i.test(text)) {
        expect(text).toMatch(/this project started|did not start/i);
      }
    }
    expect(tool.description).toMatch(/did not start it|ask the user first/i);
  });
});

// ---------------------------------------------------------------------------
// focus_cdp_tab (stories/cdp-tab-focus.md §5, §6)
//
// The harmless verb, and that is exactly what needs pinning: it must clear the
// same ownership gate as its destructive neighbour while refusing none of the
// things that neighbour refuses.
// ---------------------------------------------------------------------------

describe('focus_cdp_tab', () => {
  it('resolves a profile to a port and focuses the named tab', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });

    expect(result.isError).toBeFalsy();
    expect(h.focusCalls).toHaveLength(1);
    expect(h.focusCalls[0]).toMatchObject({
      projectRoot: PROJECT_ROOT,
      port: 51000,
      targetId: 'A1B2C3',
    });
  });

  it('maps every output field through as structured content', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(structured(result)).toEqual({
      focused: true,
      targetId: 'A1B2C3',
      title: 'OpenRouter — Docs',
      url: 'https://openrouter.ai/docs',
      engine: 'edge',
      profile: 'default',
      port: 51000,
      warnings: [],
    });
  });

  it('names the tab it brought forward in text, for a host that shows only that', async () => {
    // The whole user-visible payoff: "Brought X to the front" is what the agent
    // repeats back, and a host that ignores structured content sees nothing
    // else. `title` reaching the summary is the difference between the agent
    // saying which tab it showed and saying only that a call succeeded.
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(summary(result)).toContain('OpenRouter — Docs');
    expect(summary(result)).toContain('edge "default"');
  });

  it('switches between every tab of a multi-tab browser, naming each one', async () => {
    // The whole flow, repeated: list once, then ask for one tab after another
    // the way a user does ("now show me the cart", "now the inbox"). Four tabs
    // rather than two, because a toggle would satisfy two. What each hop has
    // to get right is the pairing — the id that reached the wire and the title
    // in the summary must describe the SAME tab, since the summary is what the
    // agent repeats back and the id is what actually moved.
    const h = await connect({ browsers: { running: RUNNING_WITH_MANY_TABS } });

    const listed = await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });
    const tabs = (structured(listed).running as { tabs: { targetId: string; title: string }[] }[])[0]!
      .tabs;
    expect(tabs).toHaveLength(4);

    // Forwards, then backwards, so every tab is both the one being left and
    // the one being asked for.
    const walk = [...tabs, ...[...tabs].reverse()];
    for (const tab of walk) {
      const result = await h.client.callTool({
        name: 'focus_cdp_tab',
        arguments: { profile: 'default', target_id: tab.targetId },
      });
      expect(result.isError, `focusing ${tab.title}`).toBeFalsy();
      expect(structured(result).targetId).toBe(tab.targetId);
      expect(structured(result).title).toBe(tab.title);
      expect(summary(result)).toContain(tab.title);
    }

    expect(h.focusCalls.map((c) => c.targetId)).toEqual(walk.map((t) => t.targetId));
    // One listing, eight focuses: the agent does not have to re-list between
    // hops, because a targetId stays valid while the tab is open.
    expect(h.listCalls).toHaveLength(1 + walk.length);
  });

  it('focuses a tab a session is DRIVING, without a word of complaint', async () => {
    // The deliberate opposite of `close_cdp_tab`, and the single most likely
    // reason anyone calls this: "show me what the test is doing". D4E5F6 is the
    // tab `RUNNING_WITH_TABS` marks as held by session mcp:x.
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'D4E5F6' },
    });
    expect(result.isError).toBeFalsy();
    expect(h.focusCalls[0]).toMatchObject({ targetId: 'D4E5F6' });
  });

  it('survives an older server that omits `warnings`', async () => {
    const h = await connect({
      browsers: { running: RUNNING_WITH_TABS },
      focused: {
        focused: true,
        targetId: 'A1B2C3',
        title: 'Docs',
        url: 'https://openrouter.ai/docs',
        engine: 'edge',
        profile: 'default',
        port: 51000,
      },
    });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result).warnings).toEqual([]);
  });

  it('refuses both `profile` and `port`, and never reaches the wire', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', port: 51000, target_id: 'A1B2C3' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('config.cdp');
    expect(text(result)).toMatch(/not both/i);
    expect(h.focusCalls).toHaveLength(0);
  });

  it('refuses neither `profile` nor `port`, naming its own argument names', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { target_id: 'A1B2C3' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('focus_cdp_tab');
    expect(text(result)).toContain('list_cdp_browsers');
    expect(h.focusCalls).toHaveLength(0);
  });

  it('skips the gate for a profile-resolved port', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(h.listCalls.filter((c) => c.includeForeign === true)).toHaveLength(0);
  });

  it('gates a caller-supplied port, and refuses a foreign one', async () => {
    // Non-destructive is not the same as unobtrusive: focusing a tab in
    // someone else's browser yanks their screen and reveals which tab they are
    // being shown. Same gate as attaching and closing.
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS, foreign: FOREIGN } });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { port: 9222, target_id: 'A1B2C3' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('mcp.cdp.allowUnowned');
    expect(h.focusCalls).toHaveLength(0);
  });

  it('permits a foreign port once allowUnowned is set, and forwards the flag', async () => {
    const h = await connect({
      project: fakeProject({ cdpPermissions: { allowUnowned: true, ports: null } }),
      browsers: { running: RUNNING_WITH_TABS, foreign: FOREIGN },
    });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { port: 9222, target_id: 'A1B2C3' },
    });
    expect(result.isError).toBeFalsy();
    expect(h.focusCalls[0]).toMatchObject({ port: 9222, allowUnowned: true });
  });

  it('does not send allowUnowned when no human permitted it', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(h.focusCalls[0]).not.toHaveProperty('allowUnowned');
  });

  it('auto-starts a stopped server, like the other tools that act', async () => {
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(h.readiness).toEqual(['ensure']);
  });

  it('passes a real 404 through as prose, not as a transport complaint', async () => {
    // The server's own message names the id, both readings and the call that
    // refreshes the list. Wrapping it in "rejected the request (HTTP 404)"
    // buries an actionable message under one the agent cannot act on.
    const h = await connect({
      browsers: { running: RUNNING_WITH_TABS },
      focusThrows: new ApiHttpError(
        404,
        'No tab with target id GONE is open in edge "default" (port 51000).\n\n' +
          'Either it has already been closed, or the id belongs to a different browser.\n' +
          'Call list_cdp_browsers for the tabs open right now.',
      ),
    });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'GONE' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/already been closed/i);
    expect(text(result)).toMatch(/different browser/i);
    expect(text(result)).not.toMatch(/rejected the request/i);
  });

  it('tells the agent to rebuild when the ROUTE is what is missing', async () => {
    // The same status, the opposite meaning. Reachable without doing anything
    // wrong: pull this branch, restart the MCP server, and the Sessions API
    // server from the previous build is still holding the port. Telling the
    // user their tab was closed sends them looking for a window that is still
    // sitting there.
    const h = await connect({
      browsers: { running: RUNNING_WITH_TABS },
      focusThrows: new ApiHttpError(404, ''),
    });
    const result = await h.client.callTool({
      name: 'focus_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/predates this tool|no tab-focus route/i);
    expect(text(result)).toMatch(/npm run build/);
    // And it must NOT say the tab is gone.
    expect(text(result)).not.toMatch(/already been closed/i);
  });

  it('describes what surprises: match it yourself, say which tab, and the weak guarantee', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'focus_cdp_tab')!.description!;

    // An agent that does not know matching is its job looks for a selector.
    expect(description).toContain('list_cdp_browsers');
    expect(description).toMatch(/yourself/);
    // The result is only useful if the agent relays which tab it showed.
    expect(description).toMatch(/say which tab/i);
    // `focused: true` means accepted, and the description has to hold that
    // line — reporting the strong contract while holding the weak one is the
    // one thing the story forbids outright.
    expect(description).toMatch(/accepted the request/i);
    expect(description).toMatch(/taskbar/i);
    // And it is not a way to make steps run somewhere.
    expect(description).toContain('config.cdp.tab');
  });

  it('promises in its schema that focused means accepted, not seen', async () => {
    // The static prose an agent reads before it ever calls this. `closed` on
    // the neighbouring tool means "gone"; if this field claimed the same
    // strength, an agent would report a window the user cannot see as shown.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const output = JSON.stringify(tools.find((t) => t.name === 'focus_cdp_tab')!.outputSchema);
    expect(output).toMatch(/accepted the request/i);
    expect(output).toMatch(/taskbar/i);
  });
});

// ---------------------------------------------------------------------------
// Tab <-> session visibility (stories/cdp-tabs.md §1, §4)
// ---------------------------------------------------------------------------

describe('tab and session visibility', () => {
  it('reports which session is driving each tab', async () => {
    // The half that makes a close refusal predictable rather than a surprise.
    const h = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    const result = await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });
    const running = structured(result).running as { tabs: { sessionId: string | null }[] }[];
    expect(running[0]!.tabs.map((t) => t.sessionId)).toEqual([null, 'mcp:x']);
  });

  it('reports which tab each session is on', async () => {
    const h = await connect({
      sessions: [
        {
          sessionId: 'mcp:x',
          status: 'active',
          currentUrl: 'https://shop.example/cart',
          pageTitle: 'Cart',
          totalStepsExecuted: 3,
          cdp: { port: 51000, profile: 'default' },
          tab: { targetId: 'D4E5F6', url: 'https://shop.example/cart' },
        },
      ],
    });
    const result = await h.client.callTool({ name: 'list_sessions', arguments: {} });
    const sessions = structured(result).sessions as Record<string, unknown>[];
    expect(sessions[0]!.tab).toEqual({ targetId: 'D4E5F6', url: 'https://shop.example/cart' });
  });

  it('survives a server that predates the sessionId field', async () => {
    // `sessionId` is required-and-nullable, so an unnormalised missing key
    // fails structuredContent validation and degrades the whole listing to
    // isError with nothing readable in it. Reachable without doing anything
    // wrong: pull this branch, restart the MCP server, and the Sessions API
    // server from the previous build is still holding the port — there is no
    // version check, only an identity one. That would kill the FIRST call of
    // the tab flow.
    const h = await connect({
      browsers: {
        running: [
          {
            engine: 'edge',
            profile: 'default',
            port: 51000,
            profileDir: 'c:/proj/p/edge-default',
            tabs: [{ targetId: 'A1B2C3', title: 'Docs', url: 'https://openrouter.ai/docs' }],
          },
        ],
      },
    });
    const result = await h.client.callTool({ name: 'list_cdp_browsers', arguments: {} });

    expect(result.isError).toBeFalsy();
    const running = structured(result).running as { tabs: { sessionId: string | null }[] }[];
    expect(running[0]!.tabs[0]!.sessionId).toBeNull();
  });

  it('sends allowUnowned for a close only when a human permitted it', async () => {
    // Otherwise the gate lets a foreign port through and the server refuses it
    // one layer later with an unrelated message — an opt-in that grants
    // nothing.
    const plain = await connect({ browsers: { running: RUNNING_WITH_TABS } });
    await plain.client.callTool({
      name: 'close_cdp_tab',
      arguments: { profile: 'default', target_id: 'A1B2C3' },
    });
    expect(plain.closeCalls[0]).not.toHaveProperty('allowUnowned');

    const permitted = await connect({
      project: fakeProject({ cdpPermissions: { allowUnowned: true, ports: null } }),
      browsers: { running: RUNNING_WITH_TABS, foreign: FOREIGN },
    });
    await permitted.client.callTool({
      name: 'close_cdp_tab',
      arguments: { port: 9222, target_id: 'A1B2C3' },
    });
    expect(permitted.closeCalls[0]).toMatchObject({ allowUnowned: true });
  });

  it('reports a null tab rather than dropping the key on an older server', async () => {
    // A MISSING key fails `structuredContent` validation outright; a null one
    // is simply "not reported". The difference is a usable result versus none.
    const h = await connect({
      sessions: [{ sessionId: 'mcp:x', status: 'active', currentUrl: '', pageTitle: '' }],
    });
    const result = await h.client.callTool({ name: 'list_sessions', arguments: {} });
    expect(result.isError).toBeFalsy();
    const sessions = structured(result).sessions as Record<string, unknown>[];
    expect(sessions[0]!.tab).toBeNull();
  });

  it('tells the run tools how to target an existing tab', async () => {
    // The measured trap: an agent that lists tabs, finds the cart, and passes
    // only the profile gets a NEW tab and leaves the user's alone.
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const name of ['run_steps', 'run_test_file']) {
      const description = tools.find((t) => t.name === name)!.description!;
      expect(description).toContain('targetId:');
      expect(description).toMatch(/NEW tab by default/);
    }
  });
});
