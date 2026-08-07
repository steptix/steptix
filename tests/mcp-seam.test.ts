import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import { PreflightFailure, type ApiClient, type McpDeps, type ProjectContext, type RunEvent, type StreamResult } from '../src/mcp/types.js';
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
}): Promise<Harness> {
  const calls: { sessionId: string; body: Record<string, unknown> }[] = [];
  const cdpListCalls: Harness['cdpListCalls'] = [];
  const cdpStartCalls: Record<string, unknown>[] = [];
  const pageContentCalls: Harness['pageContentCalls'] = [];
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
    resolveProject: async () => {
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
    get ensureCalls() {
      return ensureCalls;
    },
  };
}

beforeEach(() => {
  resetRegistry();
});

describe('tool registration', () => {
  it('exposes exactly the ten tools, under bare names', async () => {
    // Bare because the host prefixes them — an `aiui_` prefix here would
    // render as `mcp__aiui__aiui_run_steps` in Claude Code.
    //
    // The two CDP tools carry `cdp` in their own names on purpose: the
    // framework has two kinds of browser, and a bare `start_browser` would
    // claim authority over both while handling only the persistent kind.
    const { client } = await connect({});
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'close_session',
      'get_last_run',
      'get_page_content',
      'list_cdp_browsers',
      'list_sessions',
      'list_test_files',
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
});
