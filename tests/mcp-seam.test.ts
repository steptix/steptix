import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import { ApiHttpError, PreflightFailure, type ApiClient, type McpDeps, type ProjectContext, type RunEvent, type StreamResult } from '../src/mcp/types.js';
import { preflightError } from '../src/mcp/errors.js';

// ---------------------------------------------------------------------------
// The tools, driven through a real MCP client over a real transport, with only
// the outside world faked. This is the layer where the agent-facing contract
// actually lives: what `isError` means, what comes back as structured content,
// whether progress arrives, what cancellation does.
//
// A unit test of the handlers would miss most of that, because the SDK sits
// in between and has opinions — notably that a schema mismatch becomes
// `isError:true` with the structured content stripped.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = 'c:/proj';
const TEST_FILE = 'c:/proj/tests/checkout.md';

function fakeProject(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    scope: 'project',
    configSearch: [],
    projectRoot: PROJECT_ROOT,
    configPath: `${PROJECT_ROOT}/aiui.config.json`,
    env: { AI_API_KEY: 'project-key' },
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

interface Scripted {
  events: RunEvent[];
  streamDropped?: boolean;
  /** Delay before the stream resolves, so a test can cancel mid-run. */
  holdMs?: number;
}

interface Harness {
  client: Client;
  calls: { sessionId: string; body: Record<string, unknown> }[];
  ensureCalls: number;
  /** Every `GET /cdp/browsers` the tools made, so a test can assert the gate
   *  did (or did not) consult the registry, and with what. */
  cdpListCalls: { projectRoot: string; includeForeign?: boolean; includeForeignTabs?: boolean }[];
  cdpStartCalls: Record<string, unknown>[];
  /** Every page read the tools made, so a test can assert what was actually
   *  put on the wire rather than only what came back. */
  pageContentCalls: { sessionId: string; args: Record<string, unknown> }[];
  /** Sessions whose state (and so screenshot) was fetched. */
  sessionStateCalls: string[];
  /** `GET /config` calls, with the session id each asked about or null. */
  configCalls: (string | null)[];
  /** Every argument bag `resolveProject` received. */
  resolveArgs: unknown[];
}

const emptyBrowsers = { running: [], available: [], foreign: [] };

async function connect(opts: {
  script?: Scripted | Scripted[];
  project?: ProjectContext;
  resolveProjectError?: PreflightFailure;
  lastRun?: { finalized: boolean; reportPath?: string | null; tokens?: { total: number; input: number; output: number } | null };
  sessions?: { sessionId: string }[];
  browsers?: {
    running?: { engine: string; profile: string; port: number; profileDir: string; tabs: unknown[] }[];
    available?: { engine: string; profile: string; profileDir: string }[];
    foreign?: { engine: string; port: number; tabs: unknown; tabsWithheld: boolean; error: string | null }[];
  };
  started?: Record<string, unknown>;
  startError?: Error;
  pageContent?: Record<string, unknown>;
  pageContentError?: Error;
  sessionState?: Record<string, unknown>;
  sessionStateError?: Error;
  serverConfig?: Record<string, unknown>;
  configError?: Error;
}): Promise<Harness> {
  const calls: { sessionId: string; body: Record<string, unknown> }[] = [];
  const cdpListCalls: Harness['cdpListCalls'] = [];
  const cdpStartCalls: Record<string, unknown>[] = [];
  const pageContentCalls: Harness['pageContentCalls'] = [];
  const sessionStateCalls: string[] = [];
  const configCalls: (string | null)[] = [];
  /** Every argument bag `resolveProject` received — how a test pins
   *  per-tool resolver flags like `requireProject`. */
  const resolveArgs: unknown[] = [];
  let ensureCalls = 0;
  const scripts = Array.isArray(opts.script) ? [...opts.script] : opts.script ? [opts.script] : [];

  const fakeClient: ApiClient = {
    async streamSteps(sessionId, body, signal, onEvent): Promise<StreamResult> {
      calls.push({ sessionId, body: body as unknown as Record<string, unknown> });
      const script = scripts.shift() ?? { events: [] };
      if (script.holdMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, script.holdMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason as Error);
          });
        });
      }
      for (const event of script.events) onEvent?.(event);
      return {
        events: script.events,
        streamDropped: script.streamDropped ?? false,
        dropped: [],
      };
    },
    async getLastRun() {
      return opts.lastRun ?? { finalized: true, reportPath: 'c:/proj/reports/x.html', tokens: { total: 30, input: 20, output: 10 } };
    },
    async closeSession() {},
    async getPageContent(sessionId, args) {
      pageContentCalls.push({ sessionId, args: args as Record<string, unknown> });
      if (opts.pageContentError) throw opts.pageContentError;
      return {
        sessionId,
        url: 'https://app.test/invoices',
        title: 'Invoices',
        status: 'active',
        format: 'text',
        selector: null,
        content: 'You have 3 unpaid invoices.',
        truncated: false,
        returnedChars: 27,
        availableChars: 27,
        ...opts.pageContent,
      } as never;
    },
    async getSessionState(sessionId) {
      sessionStateCalls.push(sessionId);
      if (opts.sessionStateError) throw opts.sessionStateError;
      return {
        sessionId,
        status: 'active',
        currentUrl: 'https://app.test/invoices',
        pageTitle: 'Invoices',
        screenshot: `data:image/png;base64,${'A'.repeat(64)}`,
        totalStepsExecuted: 1,
        ...opts.sessionState,
      } as never;
    },
    async getConfig(sessionId) {
      configCalls.push(sessionId ?? null);
      if (opts.configError) throw opts.configError;
      return (opts.serverConfig ?? {
        config: {},
        server: {
          model: 'server-model',
          capture: 'on-failure',
          fullPage: false,
          sendScreenshots: false,
          sources: {
            model: 'server',
            capture: 'server',
            fullPage: 'server',
            sendScreenshots: 'server',
          },
        },
        session: null,
      }) as never;
    },
    async listSessions() {
      return opts.sessions ?? [];
    },
    async getCdpBrowsers(args) {
      cdpListCalls.push(args as Harness['cdpListCalls'][number]);
      return { ...emptyBrowsers, ...opts.browsers } as never;
    },
    async startCdpBrowser(body) {
      cdpStartCalls.push(body as unknown as Record<string, unknown>);
      if (opts.startError) throw opts.startError;
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
      ensureCalls++;
    },
    // Injected, not imported: the real one probes a real port, so with a fake
    // client the suite would still fire live requests at 127.0.0.1:3100 and
    // fail on any machine with something else listening there.
    assertServerRecognized: async () => {},
    resolveProject: async (args) => {
      resolveArgs.push(args);
      if (opts.resolveProjectError) throw opts.resolveProjectError;
      return opts.project ?? fakeProject();
    },
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    calls,
    cdpListCalls,
    cdpStartCalls,
    pageContentCalls,
    sessionStateCalls,
    configCalls,
    resolveArgs,
    get ensureCalls() {
      return ensureCalls;
    },
  };
}

beforeEach(() => {
  resetRegistry();
});

describe('tool registration', () => {
  it('exposes exactly the registered tools, under bare names', async () => {
    // Bare because the host prefixes them — an `aiui_` prefix here would
    // render as `mcp__aiui__aiui_run_steps` in Claude Code.
    //
    // The two CDP tools carry `cdp` in their own names on purpose: the
    // framework has two kinds of browser, and a bare `start_browser` would
    // claim authority over both while handling only the persistent kind.
    const { client } = await connect({});
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'close_cdp_tab',
      'close_session',
      'focus_cdp_tab',
      'get_last_run',
      'get_page_content',
      'get_run_settings',
      'list_cdp_browsers',
      'list_sessions',
      'list_test_files',
      'run_errand',
      'run_steps',
      'run_test_file',
      'server_status',
      'start_cdp_browser',
    ]);
  });

  it('documents the step syntax on both run tools', async () => {
    // An agent with no syntax reference writes prose that half-works — and
    // because the AI executes it, the failure is a wrong run, not an error.
    const { client } = await connect({});
    const { tools } = await client.listTools();

    for (const name of ['run_steps', 'run_test_file']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description).toContain('[skill:');
      expect(tool?.description).toContain('${env.');
    }
  });
});

describe('run_steps', () => {
  it('returns a failed run as a normal result, not an error', async () => {
    // The whole `isError` contract: a run that reached the server comes back
    // as structured content whose `status` says what happened. Using isError
    // would strip sessionId, steps and reportPath at the worst moment.
    const { client } = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:fail', line: 1, error: 'element not found' },
          { type: 'done', status: 'failed' },
        ],
      },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['click the thing'], project_root: PROJECT_ROOT },
    });

    // The SDK leaves isError undefined on success rather than setting false.
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe('failed');
    expect(structured.error).toBe('element not found');
    expect(structured.sessionId).toMatch(/^mcp:steps-/);
    expect((structured.steps as unknown[])).toHaveLength(1);
  });

  it('always includes a text summary, for hosts that ignore structured output', async () => {
    const { client } = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
    });

    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.type).toBe('text');
    expect(first?.text).toContain('PASSED');
  });

  it('reuses one session id across calls in a process', async () => {
    const harness = await connect({
      script: [
        { events: [{ type: 'done', status: 'passed' }] },
        { events: [{ type: 'done', status: 'passed' }] },
      ],
    });

    await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['one'], project_root: PROJECT_ROOT },
    });
    await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['two'], project_root: PROJECT_ROOT },
    });

    expect(harness.calls[0]?.sessionId).toBe(harness.calls[1]?.sessionId);
  });

  it('refuses a session that belongs to another client', async () => {
    // A non-mcp: id is typically a developer's open editor, and running steps
    // in it would drive their browser.
    const { client } = await connect({});

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['x'],
        project_root: PROJECT_ROOT,
        session_id: 'c:/proj/tests/someone-elses.md',
      },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('allow_foreign_session');
  });

  it('permits a foreign session when explicitly allowed', async () => {
    const { client } = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['x'],
        project_root: PROJECT_ROOT,
        session_id: 'someone-elses',
        allow_foreign_session: true,
      },
    });

    expect(res.isError).toBeFalsy();
  });
});

describe('get_page_content', () => {
  it('returns the page as structured content', async () => {
    const { client } = await connect({});

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:a', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      sessionId: 'mcp:a',
      url: 'https://app.test/invoices',
      title: 'Invoices',
      format: 'text',
      selector: null,
      content: 'You have 3 unpaid invoices.',
      truncated: false,
    });
  });

  // The bug this guards: the page used to live ONLY in structuredContent, so a
  // client that surfaces just the content blocks handed the model
  // "Invoices — text, 2995 chars" — a description of the page instead of the
  // page, with no error and a plausible count to make it look like success.
  it('puts the page in the content blocks, not only in structuredContent', async () => {
    const { client } = await connect({
      pageContent: { content: 'You have 3 unpaid invoices. Invoice #2024-11 is overdue.' },
    });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:a', project_root: PROJECT_ROOT },
    });

    const blocks = (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
    expect(blocks).toContain('You have 3 unpaid invoices.');
    expect(blocks).toContain('Invoice #2024-11 is overdue.');
    // The summary stays — it carries the counts and the truncation warning,
    // which the raw page cannot tell you about itself.
    expect(blocks).toContain('chars');
    // And structured output is still there for clients that use it.
    expect(res.structuredContent).toMatchObject({
      content: 'You have 3 unpaid invoices. Invoice #2024-11 is overdue.',
    });
  });

  it('carries a truncation warning in the content blocks too', async () => {
    const { client } = await connect({
      pageContent: { content: 'x'.repeat(50), truncated: true, returnedChars: 50, availableChars: 900 },
    });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:a', project_root: PROJECT_ROOT },
    });

    const blocks = (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
    // A client showing only content blocks must still learn it got a fragment.
    expect(blocks).toContain('900');
    expect(blocks).toContain('narrow with a selector');
  });

  it('sends format, selector and max_chars through to the server', async () => {
    const { client, pageContentCalls } = await connect({});

    await client.callTool({
      name: 'get_page_content',
      arguments: {
        session_id: 'mcp:a',
        project_root: PROJECT_ROOT,
        format: 'dom',
        selector: '#invoice-list',
        max_chars: 5000,
      },
    });

    expect(pageContentCalls).toHaveLength(1);
    expect(pageContentCalls[0]).toMatchObject({
      sessionId: 'mcp:a',
      args: { format: 'dom', selector: '#invoice-list', maxChars: 5000 },
    });
  });

  // Omitted rather than defaulted client-side: the server owns the defaults,
  // and a second copy here would drift from it silently.
  it('sends nothing it was not given', async () => {
    const { client, pageContentCalls } = await connect({});

    await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:a', project_root: PROJECT_ROOT },
    });

    expect(pageContentCalls[0]!.args).toEqual({
      format: undefined,
      selector: undefined,
      maxChars: undefined,
    });
  });

  it('tells the agent a truncated result was truncated', async () => {
    const { client } = await connect({
      pageContent: { truncated: true, returnedChars: 20_000, availableChars: 91_234 },
    });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:a', project_root: PROJECT_ROOT },
    });

    expect(res.structuredContent).toMatchObject({ truncated: true, availableChars: 91_234 });
    // Also in the text summary, which is all a host that ignores structured
    // content will show.
    expect(JSON.stringify(res.content)).toContain('20000');
    expect(JSON.stringify(res.content)).toContain('selector');
  });

  // The point of this workstream. A developer's session may be driving a CDP
  // browser holding real logins, and this returns the text of whatever tab is
  // open — so the read is gated exactly as close_session is.
  it('refuses a foreign session, and says what would be disclosed', async () => {
    const { client, pageContentCalls } = await connect({});

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'c:/proj/tests/theirs.md', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('allow_foreign_session');
    expect(text).toContain('signed in to');
    // Refused before the wire, not after.
    expect(pageContentCalls).toHaveLength(0);
  });

  it('reads a foreign session when explicitly allowed', async () => {
    const { client, pageContentCalls } = await connect({});

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: {
        session_id: 'theirs',
        project_root: PROJECT_ROOT,
        allow_foreign_session: true,
      },
    });

    expect(res.isError).toBeFalsy();
    expect(pageContentCalls).toHaveLength(1);
  });

  it('turns a server refusal into a readable error', async () => {
    const { ApiHttpError } = await import('../src/mcp/types.js');
    const { client } = await connect({
      pageContentError: new ApiHttpError(404, 'Session not found'),
    });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:gone', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('Session not found');
  });

  it('warns that the page may be moving during a run', async () => {
    const { client } = await connect({ pageContent: { status: 'executing' } });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:a', project_root: PROJECT_ROOT },
    });

    expect(res.structuredContent).toMatchObject({ status: 'executing' });
  });
});

describe('run settings on the wire', () => {
  const effective = {
    model: 'override/model',
    capture: 'every-step' as const,
    fullPage: false,
    sendScreenshots: false,
    sources: {
      model: 'session' as const,
      capture: 'session' as const,
      fullPage: 'server' as const,
      sendScreenshots: 'server' as const,
    },
  };

  it('sends the four retained settings, and only the ones it was given', async () => {
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    await harness.client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['do a thing'],
        project_root: PROJECT_ROOT,
        capture: 'every-step',
        model: 'override/model',
      },
    });

    // An ABSENT key means "leave what the session has"; sending `undefined`
    // for the two nobody named would make every ordinary run a request to
    // clear them.
    expect(harness.calls[0]?.body.runSettings).toEqual({
      capture: 'every-step',
      model: 'override/model',
    });
  });

  it('omits runSettings entirely when the caller set none', async () => {
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
    });

    expect('runSettings' in (harness.calls[0]?.body ?? {})).toBe(false);
  });

  it('keeps screenshots_return off the wire — it is an MCP-only concern', async () => {
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    await harness.client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['do a thing'],
        project_root: PROJECT_ROOT,
        screenshots_return: 'final',
      },
    });

    expect('runSettings' in (harness.calls[0]?.body ?? {})).toBe(false);
    expect(JSON.stringify(harness.calls[0]?.body)).not.toContain('final');
  });

  it('reports the settings the run used, with the return mode added', async () => {
    const { client } = await connect({
      script: { events: [{ type: 'done', status: 'passed', effectiveSettings: effective }] },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['do a thing'],
        project_root: PROJECT_ROOT,
        capture: 'every-step',
        model: 'override/model',
      },
    });

    expect((res.structuredContent as Record<string, unknown>).effectiveSettings).toEqual({
      ...effective,
      // Nothing was asked for, so this is the tool's default.
      screenshotsReturn: 'on-failure',
    });
  });

  it('names the settings in the summary line, for a host that shows only text', async () => {
    const { client } = await connect({
      script: { events: [{ type: 'done', status: 'passed', effectiveSettings: effective }] },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
    });

    const summary = (res.content as { text?: string }[])[0]?.text ?? '';
    expect(summary).toContain('override/model');
    expect(summary).toContain('every-step');
  });

  it('validates against the output schema when an older server omits the echo', async () => {
    // The regression this guards: `effectiveSettings` is a REQUIRED key in
    // `runResultOutput`, so a missing one would fail `validateToolOutput` and
    // strip the whole run result to `isError` with no structured content — at
    // the end of a run that worked.
    const { client } = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:pass', line: 1 },
          { type: 'done', status: 'passed' },
        ],
      },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    const settings = (res.structuredContent as Record<string, unknown>)
      .effectiveSettings as Record<string, unknown>;
    expect(settings.model).toBeNull();
    expect(settings.capture).toBeNull();
    expect(settings.screenshotsReturn).toBe('on-failure');
  });

  it('returns the failure image by default, as an image block', async () => {
    // A failure is the one moment a picture says something the text cannot, so
    // it comes back without being asked for.
    const png = `data:image/png;base64,${'A'.repeat(80)}`;
    const { client } = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:fail', line: 1, error: 'boom', screenshot: png },
          { type: 'done', status: 'failed' },
        ],
      },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
    });

    const image = (res.content as { type: string; data?: string }[]).find(
      (b) => b.type === 'image',
    );
    expect(image?.data).toBe('A'.repeat(80));
  });

  it('sends no image on a passing run, and none at all under "none"', async () => {
    const png = `data:image/png;base64,${'A'.repeat(80)}`;

    // Nothing failed, so the default is silent even though a screenshot exists.
    const passing = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:pass', line: 1, screenshot: png },
          { type: 'done', status: 'passed' },
        ],
      },
    });
    const passed = await passing.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
    });
    expect((passed.content as { type: string }[]).some((b) => b.type === 'image')).toBe(false);

    // And `none` suppresses it on a failure — the opt-out for a page holding
    // something the user would not want in the conversation.
    const quiet = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:fail', line: 1, error: 'boom', screenshot: png },
          { type: 'done', status: 'failed' },
        ],
      },
    });
    const suppressed = await quiet.client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['do a thing'],
        project_root: PROJECT_ROOT,
        screenshots_return: 'none',
      },
    });
    expect((suppressed.content as { type: string }[]).some((b) => b.type === 'image')).toBe(false);
    const settings = (suppressed.structuredContent as Record<string, any>).effectiveSettings;
    expect(settings.screenshotsReturn).toBe('none');
  });

  it('warns when a model override runs against the step cache', async () => {
    // The cache keys on step text, not the model, so a switched model can be
    // served the previous one's plans — worst exactly when you switched to
    // compare them.
    const { client } = await connect({
      project: fakeProject({ cacheEnabled: true }),
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['do a thing'],
        project_root: PROJECT_ROOT,
        model: 'override/model',
      },
    });

    const warnings = (res.structuredContent as { warnings: string[] }).warnings.join(' ');
    expect(warnings).toContain('cache');
    expect(warnings).toContain('model');
  });
});

describe('get_run_settings', () => {
  const report = {
    config: {},
    server: {
      model: 'server-model',
      capture: 'on-failure',
      fullPage: false,
      sendScreenshots: false,
      sources: {
        model: 'server',
        capture: 'server',
        fullPage: 'server',
        sendScreenshots: 'server',
      },
    },
    session: {
      sessionId: 'mcp:x',
      overrides: { capture: 'every-step', model: 'session/model' },
      effective: {
        model: 'session/model',
        capture: 'every-step',
        fullPage: true,
        sendScreenshots: false,
        sources: {
          model: 'session',
          capture: 'session',
          fullPage: 'project',
          sendScreenshots: 'server',
        },
      },
    },
  };

  it('reports a session\'s effective values, its overrides and the server defaults', async () => {
    const harness = await connect({ serverConfig: report });

    const res = await harness.client.callTool({
      name: 'get_run_settings',
      arguments: { session_id: 'mcp:x', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, any>;
    expect(structured.running).toBe(true);
    expect(structured.sessionId).toBe('mcp:x');
    expect(structured.model).toBe('session/model');
    expect(structured.capture).toBe('every-step');
    expect(structured.sources.fullPage).toBe('project');
    expect(structured.overrides).toEqual({
      model: 'session/model',
      capture: 'every-step',
      fullPage: null,
      sendScreenshots: null,
    });
    expect(structured.serverDefaults.capture).toBe('on-failure');
    expect(harness.configCalls).toEqual(['mcp:x']);
  });

  it('reports the server defaults when no session is named', async () => {
    const harness = await connect({ serverConfig: { ...report, session: null } });

    const res = await harness.client.callTool({
      name: 'get_run_settings',
      arguments: { project_root: PROJECT_ROOT },
    });

    const structured = res.structuredContent as Record<string, any>;
    expect(structured.sessionId).toBeNull();
    expect(structured.model).toBe('server-model');
    expect(structured.overrides).toBeNull();
    expect(harness.configCalls).toEqual([null]);
  });

  it('starts no server to answer', async () => {
    // Asking which model is in play must not cause a server to exist — the same
    // rule `list_sessions` and `server_status` already follow.
    const harness = await connect({ serverConfig: report });

    await harness.client.callTool({
      name: 'get_run_settings',
      arguments: { project_root: PROJECT_ROOT },
    });

    expect(harness.ensureCalls).toBe(0);
  });

  it('reports a stopped server as an answer, not an error', async () => {
    // A transport failure IS the answer here. An `isError` result would make an
    // agent think the tool is broken, when what it learned is that nothing is
    // running — and this tool is not allowed to start one to find out.
    const { client } = await connect({ configError: new TypeError('fetch failed') });

    const res = await client.callTool({
      name: 'get_run_settings',
      arguments: { project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, any>;
    expect(structured.running).toBe(false);
    expect(structured.detail).toContain('fetch failed');
    expect(structured.model).toBeNull();
    expect(structured.serverDefaults).toBeNull();
  });

  it('says an unknown session is not open rather than reporting the defaults', async () => {
    const { client } = await connect({
      configError: new ApiHttpError(404, 'Session not found'),
    });

    const res = await client.callTool({
      name: 'get_run_settings',
      arguments: { session_id: 'mcp:gone', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('mcp:gone');
    expect(text).toContain('list_sessions');
    // Both causes are named, because a 404 with a session id is genuinely
    // ambiguous — see below.
    expect(text).toContain('predates');
  });

  it('reads a route-miss 404 as an older server, not a missing session', async () => {
    // Measured against a Sessions API server left running from an earlier build:
    // Express 404s the ROUTE, and reporting that as "no such session" sends the
    // reader hunting for a session when the fix is to restart the server. With
    // no session_id a 404 cannot mean "session not found", which settles it.
    const { client } = await connect({
      configError: new ApiHttpError(404, 'Not Found'),
    });

    const res = await client.callTool({
      name: 'get_run_settings',
      arguments: { project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('predates');
    expect(text).not.toContain('list_sessions');
    expect(text).not.toContain('undefined');
  });
});

describe('get_page_content format: screenshot', () => {
  it('returns the viewport as an image block, with empty text content', async () => {
    const harness = await connect({});

    const res = await harness.client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:x', project_root: PROJECT_ROOT, format: 'screenshot' },
    });

    expect(res.isError).toBeFalsy();
    // Over `GET /sessions/:id`, which already carried a screenshot — not the
    // content endpoint.
    expect(harness.sessionStateCalls).toEqual(['mcp:x']);
    expect(harness.pageContentCalls).toHaveLength(0);

    const image = (res.content as { type: string; data?: string }[]).find(
      (b) => b.type === 'image',
    );
    expect(image?.data).toBe('A'.repeat(64));
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.format).toBe('screenshot');
    expect(structured.content).toBe('');
    expect(structured.returnedChars).toBe(64);
  });

  it('treats an empty capture as an error, not a blank page', async () => {
    // The server swallows capture failures into '' — reporting that as a blank
    // page would be a claim about the page nobody downstream can correct.
    const { client } = await connect({ sessionState: { screenshot: '' } });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:x', project_root: PROJECT_ROOT, format: 'screenshot' },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('NOT a blank page');
  });

  it('refuses a selector rather than silently widening the read', async () => {
    const { client } = await connect({});

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: {
        session_id: 'mcp:x',
        project_root: PROJECT_ROOT,
        format: 'screenshot',
        selector: '#total',
      },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('selector');
  });

  it('refuses a foreign session, like every other read of that page', async () => {
    const { client } = await connect({});

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'testbench:1', project_root: PROJECT_ROOT, format: 'screenshot' },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('disclose');
  });
});

describe('output validation', () => {
  it('degrades a schema-invalid result instead of losing it', async () => {
    // The SDK's own behaviour on a mismatch is to answer `isError:true` with
    // the structured content stripped — the exact shape a run that reached the
    // server must never produce, because the agent then loses sessionId, the
    // report path and any idea that anything ran.
    //
    // `output` is a good lever: the wire shape-check does not police it (the
    // fold only stores it), but the schema requires string|null.
    const { client } = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:pass', line: 1, output: 12_345 as unknown as string },
          { type: 'done', status: 'passed' },
        ],
      },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['one'], project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    const structured = res.structuredContent as Record<string, unknown>;
    // The three things nothing else can recover.
    expect(structured.sessionId).toMatch(/^mcp:/);
    expect(structured.projectRoot).toBe(PROJECT_ROOT);
    expect(structured.status).toBe('error');
    expect((structured.warnings as string[]).join(' ')).toContain('could not be encoded');
  });
});

describe('pre-flight failures', () => {
  it('come back as isError with no structured content', async () => {
    const { client } = await connect({
      resolveProjectError: new PreflightFailure(
        preflightError('No aiui.config.json found, so there is no project to run against.'),
      ),
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['x'], project_root: 'c:/nowhere' },
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(JSON.stringify(res.content)).toContain('aiui.config.json');
  });
});

describe('progress notifications', () => {
  it('reports one step at a time, strictly increasing and within total', async () => {
    const { client } = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:pass', line: 1 },
          { type: 'step:start', line: 2 },
          { type: 'step:pass', line: 2 },
          { type: 'done', status: 'passed' },
        ],
      },
    });

    const seen: { progress: number; total?: number }[] = [];
    await client.callTool(
      { name: 'run_steps', arguments: { steps: ['one', 'two'], project_root: PROJECT_ROOT } },
      undefined,
      { onprogress: (p) => seen.push({ progress: p.progress, ...(p.total !== undefined ? { total: p.total } : {}) }) },
    );

    expect(seen.map((s) => s.progress)).toEqual([1, 2]);
    // Counting starts as well would repeat a value; counting every event
    // would sail past total. MCP requires progress to increase every time.
    for (const s of seen) expect(s.total).toBe(2);
  });

  it('sends none when the host did not ask for progress', async () => {
    // Passing no `onprogress` is what makes the client omit the token, which
    // is the real-world case that leaves a long run riding the host timeout.
    const { client } = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:pass', line: 1 },
          { type: 'done', status: 'passed' },
        ],
      },
    });

    // Observed, not inferred: asserting only that the call succeeded would
    // pass just as well with the no-token branch broken.
    const notifications: string[] = [];
    client.fallbackNotificationHandler = async (n) => {
      notifications.push(n.method);
    };

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['one'], project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    expect(notifications.filter((m) => m === 'notifications/progress')).toEqual([]);
  });
});

describe('session serialisation', () => {
  it('runs calls sharing a session one at a time and reports the wait', async () => {
    const { client } = await connect({
      script: [
        { events: [{ type: 'done', status: 'passed' }], holdMs: 60 },
        { events: [{ type: 'done', status: 'passed' }] },
      ],
    });

    const args = { steps: ['x'], project_root: PROJECT_ROOT, session_id: 'mcp:shared' };
    const [, second] = await Promise.all([
      client.callTool({ name: 'run_steps', arguments: args }),
      client.callTool({ name: 'run_steps', arguments: args }),
    ]);

    const structured = second.structuredContent as Record<string, unknown>;
    expect(structured.queuedForMs as number).toBeGreaterThan(0);
  });
});

describe('cancellation', () => {
  it('aborts the run and leaves the session open', async () => {
    // A cancelled MCP call returns nothing to the host, so the agent's route
    // back to the report is get_last_run — and the session and its browser
    // stay up, because closing them is close_session's job, not a side effect
    // of giving up on one call.
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }], holdMs: 5_000 },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);

    await expect(
      harness.client.callTool(
        { name: 'run_steps', arguments: { steps: ['slow'], project_root: PROJECT_ROOT } },
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();

    // The session lock must not be left held, or the next call would hang.
    const after = await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['after'], project_root: PROJECT_ROOT },
    });
    expect(after.isError).toBeFalsy();
  }, 30_000);
});

describe('config and the first-request rule', () => {
  it('sends config on the first call and omits it on the second', async () => {
    // The server accepts config only when it creates the session, and mcp:
    // sessions outlive this process — so the ordinary second call would be
    // rejected if we kept sending it.
    const harness = await connect({
      script: [
        { events: [{ type: 'done', status: 'passed' }] },
        { events: [{ type: 'done', status: 'passed' }] },
      ],
    });

    const args = {
      steps: ['x'],
      project_root: PROJECT_ROOT,
      session_id: 'mcp:cfg',
      config: { baseUrl: 'https://example.test' },
    };
    await harness.client.callTool({ name: 'run_steps', arguments: args });
    await harness.client.callTool({ name: 'run_steps', arguments: args });

    expect(harness.calls[0]?.body.config).toBeDefined();
    expect(harness.calls[1]?.body.config).toBeUndefined();
  });

  it('retries once without config when the server says the session already exists', async () => {
    const harness = await connect({
      script: [
        {
          events: [
            {
              type: 'output',
              kind: 'error',
              msg: 'Server error: Config can only be provided on the first request for a session.',
            },
            { type: 'done', status: 'error' },
          ],
        },
        { events: [{ type: 'done', status: 'passed' }] },
      ],
    });

    const res = await harness.client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['x'],
        project_root: PROJECT_ROOT,
        session_id: 'mcp:pre-existing',
        config: { baseUrl: 'https://example.test' },
      },
    });

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.body.config).toBeUndefined();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe('passed');
    expect(structured.configApplied).toBe(false);
    expect(structured.sessionCreated).toBe(false);
  });
});

describe('the other tools', () => {
  it('list_sessions labels who owns each session', async () => {
    const { client } = await connect({
      sessions: [{ sessionId: 'mcp:ours' }, { sessionId: 'c:/theirs.md' }],
    });

    const res = await client.callTool({
      name: 'list_sessions',
      arguments: { project_root: PROJECT_ROOT },
    });

    const sessions = (res.structuredContent as { sessions: { owner: string }[] }).sessions;
    expect(sessions.map((s) => s.owner)).toEqual(['mcp', 'other']);
  });

  it('close_session refuses another client\'s session', async () => {
    // list_sessions hands out ids labelled owner:'other', and closing one
    // kills a developer's live browser mid-run. Closing is not less
    // destructive than running in it.
    const { client } = await connect({});

    const res = await client.callTool({
      name: 'close_session',
      arguments: { session_id: 'c:/proj/tests/theirs.md', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('allow_foreign_session');
  });

  it('close_session succeeds for an unknown id', async () => {
    const { client } = await connect({});

    const res = await client.callTool({
      name: 'close_session',
      arguments: { session_id: 'mcp:never-existed', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { closed: boolean }).closed).toBe(true);
  });

  it('get_last_run reports the finalized report', async () => {
    const { client } = await connect({
      lastRun: { finalized: true, reportPath: 'c:/proj/reports/r.html', tokens: { total: 5, input: 3, output: 2 } },
    });

    const res = await client.callTool({
      name: 'get_last_run',
      arguments: { session_id: 'mcp:x', project_root: PROJECT_ROOT },
    });

    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.finalized).toBe(true);
    expect(structured.reportPath).toBe('c:/proj/reports/r.html');
  });

  it('server_status never starts a server', async () => {
    // Asking whether a server is running must not cause one to exist.
    const harness = await connect({});

    await harness.client.callTool({
      name: 'server_status',
      arguments: { project_root: PROJECT_ROOT },
    });

    expect(harness.ensureCalls).toBe(0);
  });

  // The read/act tools now auto-start (stories/mcp-no-project.md follow-up):
  // whichever aiui tool an agent reaches for first should bring the server up
  // rather than fail on a bare connect error. Only server_status and
  // get_run_settings (above) keep the report-only path, because their contract
  // is to be able to answer "nothing is running".
  it.each([
    ['list_sessions', {}],
    ['get_last_run', { session_id: 'mcp:x' }],
    ['close_session', { session_id: 'mcp:x' }],
  ] as const)('%s auto-starts a stopped server', async (name, extra) => {
    const harness = await connect({ lastRun: { finalized: true } });

    await harness.client.callTool({
      name,
      arguments: { project_root: PROJECT_ROOT, ...extra },
    });

    expect(harness.ensureCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Project-less runs (stories/mcp-no-project.md rules 6 and 7)
// ---------------------------------------------------------------------------

describe('project-less run_steps', () => {
  const userScope = () =>
    fakeProject({
      scope: 'user',
      projectRoot: 'c:/users/x/aiui',
      configPath: 'c:/users/x/aiui/aiui.config.json',
      configSearch: ['c:/somewhere', 'c:/'],
      skillsDir: null,
      toolsDir: null,
    });

  it('rule 7: the result and the summary both say which root the run used', async () => {
    const { client } = await connect({
      project: userScope(),
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['open example.com'] },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.scope).toBe('user');
    expect(structured.projectRoot).toBe('c:/users/x/aiui');
    const first = (res.content as { text?: string }[])[0]?.text ?? '';
    expect(first).toContain('user root');
  });

  it('a project run reports scope: "project" and keeps its summary quiet about it', async () => {
    const { client } = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
    });

    expect((res.structuredContent as Record<string, unknown>).scope).toBe('project');
    expect((res.content as { text?: string }[])[0]?.text ?? '').not.toContain('user root');
  });

  it('rule 6: refuses [skill:] and [tool:] steps before anything reaches the wire', async () => {
    const harness = await connect({ project: userScope() });

    const res = await harness.client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['open the site', 'Log in [skill: login user=bob]', '[tool: fetchOrders]'],
      },
    });

    expect(res.isError).toBe(true);
    const text = (res.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
    expect(text).toContain('no project resolved');
    expect(text).toContain('code belongs to a project');
    // Both offenders named; the innocent step is not.
    expect(text).toContain('[skill: login user=bob]');
    expect(text).toContain('[tool: fetchOrders]');
    expect(text).not.toContain('"open the site"');
    // The walk that found no project is in the message, so a typo'd config
    // filename is diagnosable from the refusal alone.
    expect(text).toContain('c:/somewhere');
    // Refused pre-flight: no session, no run.
    expect(harness.calls).toHaveLength(0);
  });

  it('the same steps run fine inside a project', async () => {
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    const res = await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['Log in [skill: login user=bob]'], project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
  });

  it('run_test_file and list_test_files ask the resolver for a real project', async () => {
    // The two project-shaped tools must pass requireProject — the flag that
    // keeps them refusing instead of falling back to the user root. Pinned at
    // the resolver seam; what the flag *does* is tests/mcp-project.test.ts's
    // job. The other tools must NOT pass it, or project-less mode dies.
    const harness = await connect({});

    await harness.client.callTool({ name: 'list_test_files', arguments: {} });
    expect(harness.resolveArgs.at(-1)).toMatchObject({ requireProject: true });

    await harness.client.callTool({ name: 'server_status', arguments: {} });
    expect(harness.resolveArgs.at(-1)).not.toMatchObject({ requireProject: true });

    await harness.client.callTool({ name: 'run_steps', arguments: { steps: ['x'] } });
    expect(harness.resolveArgs.at(-1)).not.toMatchObject({ requireProject: true });
  });
});
