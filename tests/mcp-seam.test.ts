import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createApiClient as realCreateApiClient } from '../src/mcp/api-client.js';
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

// ---------------------------------------------------------------------------
// The same tools, but with the REAL api-client on the streaming route and a
// real socket under it.
//
// Everything above replaces `ApiClient` wholesale, which is the right trade for
// asserting on the agent-facing contract — and exactly the wrong one for
// anything the client itself decides. The client keeps a whitelist of event
// types and records the rest in `dropped[]`; a fake that hands `events` back
// verbatim cannot see an omission from it, and one has already shipped this way
// (`step:skip`, stories/step-flow-control.md). So a run that has to prove it
// crossed the wire scripts the SSE BODY instead of the event array.
// ---------------------------------------------------------------------------

let sseServer: Server | undefined;

/** Serve one scripted SSE body to any `?stream=1` POST, and a finalized
 *  last-run to the poll that follows. Everything else 404s, which every caller
 *  of it already degrades from. */
async function startSseServer(sse: string): Promise<string> {
  sseServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.includes('stream=1')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse);
        res.end();
        return;
      }
      if (url.includes('/last-run')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ finalized: true, reportPath: null, tokens: null }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not in this fixture' }));
    });
  });
  await new Promise<void>((resolve) => sseServer!.listen(0, '127.0.0.1', resolve));
  const address = sseServer.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/** An MCP client whose tools drive the real `createApiClient` against
 *  `startSseServer`. Same server, same transport, same tool handlers as
 *  `connect` — only the client under them is the shipping one. */
async function connectOverSse(sse: string): Promise<Client> {
  const baseUrl = await startSseServer(sse);
  const project = fakeProject({ serverUrl: baseUrl, apiKey: 'server-key' });
  const deps: McpDeps = {
    createApiClient: realCreateApiClient,
    ensureServerReady: async () => {},
    assertServerRecognized: async () => {},
    resolveProject: async () => project,
  };
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function sseFrames(...events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

afterEach(async () => {
  if (sseServer) {
    await new Promise<void>((resolve) => sseServer!.close(() => resolve()));
    sseServer = undefined;
  }
});

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
      'log_into_site',
      'navigate_tab',
      'peek_tab',
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

  it('counts the steps a return skipped, instead of reporting them as a shortfall', async () => {
    // stories/step-flow-control.md. The line counted `status === 'passed'`
    // over every row, so a run that RETURNED came back as
    // `PASSED — 2/4 steps passed` — which to an agent reading only the text
    // half reads as two failures on a green run, with nothing saying the other
    // two were skipped on purpose.
    const { client } = await connect({
      script: {
        events: [
          { type: 'step:start', line: 1 },
          { type: 'step:pass', line: 1 },
          { type: 'step:start', line: 2 },
          { type: 'step:pass', line: 2, output: 'Ended the run' },
          { type: 'step:skip', line: 3, reason: 'Not run: step 2 ended the run — Stop' },
          { type: 'step:skip', line: 4, reason: 'Not run: step 2 ended the run — Stop' },
          { type: 'done', status: 'passed' },
        ],
      },
    });

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['open it', 'Stop', 'click sign out', 'check the form'],
        project_root: PROJECT_ROOT,
      },
    });

    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain('PASSED — 2 passed, 2 skipped (a step returned early) of 4');
    expect(first?.text).not.toContain('2/4 steps passed');
  });

  it('counts a returned run the same way over the REAL client and a real socket', async () => {
    // The composition the fake above cannot see. Every layer is the shipping
    // one — SseParser, its event whitelist, `consumeRunStream`, `foldRun`,
    // `stepTally`, the tool handler, the MCP transport — and only the server
    // answering is a fixture. With `step:skip` missing from the whitelist this
    // returns `PASSED — 2/4 steps passed` plus two "unrecognised event"
    // warnings, and `structuredContent.steps` holds two rows instead of four.
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'step:start', line: 2 },
        { type: 'step:pass', line: 2, output: 'Ended the run' },
        {
          type: 'step:skip',
          line: 3,
          reason: 'Not run: step 2 ended the run — If the title is Dashboard then stop',
        },
        {
          type: 'step:skip',
          line: 4,
          reason: 'Not run: step 2 ended the run — If the title is Dashboard then stop',
        },
        { type: 'done', status: 'passed' },
      ),
    );

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: [
          'open it',
          'If the title is Dashboard then stop',
          'click sign out',
          'check the form',
        ],
        project_root: PROJECT_ROOT,
      },
    });

    const structured = res.structuredContent as Record<string, unknown>;
    const steps = structured.steps as {
      line: number;
      status: string;
      output: string | null;
      skipCause?: string;
    }[];
    expect(steps.map((s) => [s.line, s.status])).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [3, 'skipped'],
      [4, 'skipped'],
    ]);
    // The cause reaches the agent per row, not only in the one-liner — and the
    // schema declares it, so the SDK's own validation lets it through.
    expect(steps.map((s) => s.skipCause)).toEqual([
      undefined,
      undefined,
      'returned',
      'returned',
    ]);
    // The reason rides out on the row, which is the only place an agent can
    // read WHY the last two steps have no result.
    expect(steps[2]?.output).toContain('Not run: step 2 ended the run');
    // No warning about it: a return is the test doing what it was told, and an
    // unknown event would have produced one per frame.
    expect(structured.warnings).toEqual([]);
    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain('PASSED — 2 passed, 2 skipped (a step returned early) of 4');
  });

  it('says which KIND of skip happened, and says both when a run had both', async () => {
    // `skipped` arrives from two places that want opposite reactions: a return
    // (nothing to do) and an `[input:]` / `[interactive]` step the server
    // declined to run unattended (needs a person before it can ever pass). One
    // clause for both sent the agent after the wrong one half the time.
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'step:start', line: 2 },
        { type: 'step:pass', line: 2, output: 'skipped' },
        { type: 'step:start', line: 3 },
        { type: 'step:pass', line: 3, output: 'Ended the run' },
        { type: 'step:skip', line: 4, reason: 'Not run: step 3 ended the run — Stop' },
        { type: 'done', status: 'passed' },
      ),
    );

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['open it', '[input: code] Type the code', 'Stop', 'click sign out'],
        project_root: PROJECT_ROOT,
      },
    });

    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain(
      'PASSED — 2 passed, 1 skipped (a step returned early), 1 skipped (need a human) of 4',
    );
    // The human-needed warning belongs to the unattended one only, and still
    // fires when a return happened in the same run.
    expect((res.structuredContent as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining('need a human'),
    ]);
  });

  it('does not send an agent looking for a human when a branch was simply not taken', async () => {
    // Through the REAL transport, because the `skipKind` field has to survive
    // the SSE parse and the client's event whitelist to reach the fold — and
    // the whitelist is exactly where `step:skip` nearly did not
    // (stories/step-flow-control.md, decision 9).
    //
    // The shape is an ordinary `If … / Otherwise …`: one branch runs, the
    // other's line and body are reported skipped. Before `skipKind` this run
    // ended with "One or more steps were skipped because they need a human",
    // which is false of every decision anyone will ever write.
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'step:start', line: 2 },
        { type: 'step:pass', line: 2 },
        {
          type: 'step:pass',
          line: 3,
          output: 'skipped',
          reason: 'Skipped: another branch of this decision was taken',
          skipKind: 'not-taken',
        },
        { type: 'done', status: 'passed' },
      ),
    );

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['open it', 'If signed in, click Continue', 'Otherwise, click Sign in'],
        project_root: PROJECT_ROOT,
      },
    });

    const structured = res.structuredContent as {
      warnings: string[];
      steps: { status: string; skipCause?: string; output?: string | null }[];
    };
    expect(structured.warnings).toEqual([]);
    expect(structured.steps[2]).toMatchObject({
      status: 'skipped',
      skipCause: 'not-taken',
      output: 'Skipped: another branch of this decision was taken',
    });
    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain(
      'PASSED — 2 passed, 1 skipped (a branch that was not taken) of 3',
    );
    expect(first?.text).not.toContain('need a human');
  });

  it('says nothing about a human when a chain with no Otherwise found nothing to do', async () => {
    // The GUARD row, which is the shape `If the cookie banner is shown,
    // dismiss it` produces when the banner is not shown — a decision with no
    // `Otherwise`, and the commonest conditional anyone writes. The server
    // emits it from its own site rather than through `emitSkippedStep`, and it
    // sent neither field until the round that added this test: the fold read
    // the absent `skipKind` as the compatibility default `'unattended'` and
    // ended the run telling the agent that steps needed a person, one row
    // above two rows from the same decision that said otherwise.
    //
    // These frames are the ones a real server produces for that shape: the
    // guard's own line, then the tail it did not take.
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        {
          type: 'step:pass',
          line: 2,
          output: 'skipped',
          reason: 'Skipped: no condition in this decision held',
          skipKind: 'not-taken',
        },
        {
          type: 'step:pass',
          line: 4,
          output: 'skipped',
          reason: 'Skipped: no condition in this decision held',
          skipKind: 'not-taken',
        },
        { type: 'step:start', line: 3 },
        { type: 'step:pass', line: 3 },
        { type: 'done', status: 'passed' },
      ),
    );

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['open it', 'If the Cash checkbox is ticked, then Pay with cash', 'Verify the total'],
        project_root: PROJECT_ROOT,
      },
    });

    const structured = res.structuredContent as {
      warnings: string[];
      steps: { status: string; skipCause?: string; output?: string | null }[];
    };
    expect(structured.warnings).toEqual([]);
    // Both rows carry the cause, the guard included.
    expect(structured.steps.filter((s) => s.status === 'skipped')).toEqual([
      expect.objectContaining({
        skipCause: 'not-taken',
        output: 'Skipped: no condition in this decision held',
      }),
      expect.objectContaining({
        skipCause: 'not-taken',
        output: 'Skipped: no condition in this decision held',
      }),
    ]);
    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain(
      'PASSED — 2 passed, 2 skipped (a branch that was not taken) of 4',
    );
    expect(first?.text).not.toContain('need a human');
  });

  it('reports a run that skipped only unattended steps in those words', async () => {
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'step:start', line: 2 },
        { type: 'step:pass', line: 2, output: 'skipped' },
        { type: 'done', status: 'passed' },
      ),
    );

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['open it', '[input: code] Type the code'], project_root: PROJECT_ROOT },
    });

    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain('PASSED — 1 passed, 1 skipped (need a human) of 2');
    expect(first?.text).not.toContain('returned early');
  });

  it('counts a skipped step towards progress, so a returned run still reaches total', async () => {
    // Progress counts terminal events, and `step:skip` is the only terminal a
    // skipped step gets. Left out, a run that returns stops the bar wherever
    // the return happened — which reads as a run that hung.
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'step:skip', line: 2, reason: 'Not run: step 1 ended the run — Stop' },
        { type: 'step:skip', line: 3, reason: 'Not run: step 1 ended the run — Stop' },
        { type: 'done', status: 'passed' },
      ),
    );

    const progress: { progress: number; total?: number }[] = [];
    await client.callTool(
      {
        name: 'run_steps',
        arguments: { steps: ['Stop', 'click sign out', 'check the form'], project_root: PROJECT_ROOT },
      },
      undefined,
      { onprogress: (p) => progress.push(p) },
    );

    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress.at(-1)?.total).toBe(3);
  });

  it('leaves the wording byte-identical when nothing was skipped', async () => {
    // The other half of the same claim: every run that does not return must
    // read exactly as it always did.
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

    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['open it', 'click sign out'], project_root: PROJECT_ROOT },
    });

    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toMatch(/^PASSED — 2\/2 steps passed \(session mcp:steps-/);
    expect(first?.text).not.toContain('skipped');
  });

  it('words a tolerated failure apart from a failure that stopped the run', async () => {
    // `otherwise continue` (stories/step-failure-outcomes.md, decision 9): both
    // halves have to reach the one line a host that ignores structured output
    // shows — "3/3 steps passed" is a green claim over a step that did not do its
    // work, and a plain failure makes a passing run read as broken.
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1 },
        { type: 'step:start', line: 2 },
        { type: 'step:fail', line: 2, error: 'No peanuts on the dashboard', tolerated: true },
        { type: 'step:start', line: 3 },
        { type: 'step:pass', line: 3 },
        { type: 'done', status: 'passed' },
      ),
    );

    const res = await client.callTool({
      name: 'run_steps',
      arguments: {
        steps: ['open it', 'Verify the title contains "Peanuts" otherwise continue', 'click sign out'],
        project_root: PROJECT_ROOT,
      },
    });

    const structured = res.structuredContent as { status: string; error: string | null;
      steps: { status: string; tolerated?: boolean; error?: string | null }[] };
    expect(structured.status).toBe('passed');
    // Not promoted to the run's error: the agent must not be pointed at a step
    // the author said to carry on from.
    expect(structured.error).toBeNull();
    expect(structured.steps[1]).toMatchObject({
      status: 'failed',
      tolerated: true,
      error: 'No peanuts on the dashboard',
    });

    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain('PASSED — 2 passed, 1 failed (tolerated) of 3');
    // No warning was written, so nothing is added to the content lines.
    expect(first?.text).not.toContain('Tolerated on line');
  });

  it('shows the author`s warning on the row and on the content line', async () => {
    // The warning is a field of the event now, and a host that renders only
    // content blocks sees nothing of `structuredContent` — so the sentence has to
    // be on the text lines too (decision 6).
    const client = await connectOverSse(
      sseFrames(
        { type: 'step:start', line: 1 },
        { type: 'step:fail', line: 1, error: 'the title did not contain "Peanuts"',
          tolerated: true, warning: 'No peanuts on the dashboard' },
        { type: 'done', status: 'passed' },
      ),
    );

    const step =
      'Verify the title contains "Peanuts" otherwise continue with warning "No peanuts on the dashboard"';
    const res = await client.callTool({
      name: 'run_steps',
      arguments: { steps: [step], project_root: PROJECT_ROOT },
    });

    const structured = res.structuredContent as {
      steps: { tolerated?: boolean; warning?: string; error?: string | null }[] };
    expect(structured.steps[0]).toMatchObject({
      tolerated: true,
      warning: 'No peanuts on the dashboard',
      // The framework's account keeps its place beside the author's.
      error: 'the title did not contain "Peanuts"',
    });

    const first = (res.content as { type: string; text?: string }[])[0];
    expect(first?.text).toContain('Tolerated on line 1: No peanuts on the dashboard');
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

  it('treats session_id "" as absent and uses the default id', async () => {
    // Some provider layers serialize every declared optional as "" (measured
    // live with OpenCode + gpt-5.6-luna). Without this, "" becomes a real
    // session literally named the empty string.
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['one'], project_root: PROJECT_ROOT, session_id: '' },
    });

    expect(harness.calls[0]?.sessionId).toMatch(/^mcp:steps-/);
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

  it('answers a session-not-found 404 with the read-a-tab redirect, not a mystery', async () => {
    // Measured live (2026-08-13): a model runs run_errand, then reaches for
    // get_page_content — but an errand leaves no session, and the server's
    // honest "Session not found" teaches the model nothing. The refusal names
    // the working doors.
    //
    // Since stories/tab-peek.md the first of those is peek_tab, the direct
    // answer to the question that got the model here; the errand-capture
    // sentence is DEMOTED to the drive-then-read case rather than deleted,
    // because that case really is one errand instead of two calls. This pin
    // moved with the text — every earlier assertion still stands.
    const { ApiHttpError } = await import('../src/mcp/types.js');
    const { client } = await connect({
      pageContentError: new ApiHttpError(404, 'Session not found'),
    });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:gone', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBe(true);
    const body = JSON.stringify(res.content);
    expect(body).toContain('mcp:gone');
    expect(body).toContain('peek_tab');
    expect(body).toContain('run_errand');
    expect(body).toContain('store as');
    expect(body).toContain('list_sessions');
  });

  it('names peek_tab in its own description for the read-a-tab case', async () => {
    // The other half of the same amendment, and the half a model reads BEFORE
    // it makes the wrong call rather than after.
    const { client } = await connect({});
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'get_page_content')!.description!;

    expect(description).toContain('peek_tab');
    expect(description).toContain('run_steps SESSION');
    // Demoted, not deleted: the drive-then-read case is still one errand.
    expect(description).toContain('run_errand');
    expect(description).toContain('store as balance');
  });

  it('leaves a route-missing 404 alone — "rebuild the server" is the opposite remedy', async () => {
    const { ApiRouteNotFoundError } = await import('../src/mcp/types.js');
    const { client } = await connect({
      pageContentError: new ApiRouteNotFoundError('http://localhost:3999/sessions/x/page'),
    });

    const res = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:gone', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).not.toContain('run_errand');
    expect(JSON.stringify(res.content)).not.toContain('peek_tab');
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
    ai: 'on' as const,
    aiOffReason: null,
    sources: {
      model: 'session' as const,
      capture: 'session' as const,
      fullPage: 'server' as const,
      sendScreenshots: 'server' as const,
      ai: 'server' as const,
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

  it('puts ai on the wire, so the switch is reachable from a tool call', async () => {
    // stories/run-settings.md §9. `assemble` forwards `runSettings` wholesale,
    // so the failure mode here is upstream: an argument `readRunSettings` does
    // not read is dropped silently, with the tool schema still advertising it.
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT, ai: 'off' },
    });

    expect(harness.calls[0]?.body.runSettings).toEqual({ ai: 'off' });
  });

  it('forwards "default" rather than swallowing it, so an override can be cleared', async () => {
    const harness = await connect({
      script: { events: [{ type: 'done', status: 'passed' }] },
    });

    await harness.client.callTool({
      name: 'run_steps',
      arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT, ai: 'default' },
    });

    // Absent and 'default' are different requests — one leaves the session's
    // setting alone, the other stops overriding — and only the server can tell
    // them apart.
    expect(harness.calls[0]?.body.runSettings).toEqual({ ai: 'default' });
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
    // AI was on, which is the ordinary case: the line stays quiet about it
    // rather than growing a clause every run has to carry.
    expect(summary).not.toContain('AI:');
  });

  it('distinguishes AI off by policy from AI off for want of a key', async () => {
    // The distinction on the line a host that ignores structured output will
    // show. Support needs to tell them apart, and they need opposite responses.
    const lineFor = async (
      ai: 'off',
      aiOffReason: 'policy' | 'no-key',
    ): Promise<string> => {
      const { client } = await connect({
        script: {
          events: [
            {
              type: 'done',
              status: 'passed',
              effectiveSettings: { ...effective, ai, aiOffReason },
            },
          ],
        },
      });
      const res = await client.callTool({
        name: 'run_steps',
        arguments: { steps: ['do a thing'], project_root: PROJECT_ROOT },
      });
      return (res.content as { text?: string }[])[0]?.text ?? '';
    };

    expect(await lineFor('off', 'policy')).toContain('AI: off (policy)');
    expect(await lineFor('off', 'no-key')).toContain('AI: off (no key)');
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
      ai: null,
    });
    expect(structured.serverDefaults.capture).toBe('on-failure');
    expect(harness.configCalls).toEqual(['mcp:x']);
  });

  it('answers null for the AI switch when the server predates it', async () => {
    // `report` above is deliberately an OLDER server's payload — no `ai`
    // anywhere. The output schema requires every key to be PRESENT, so a
    // missing one would fail validation and strip the whole result; and
    // inventing "on" would be a claim that server never made.
    const harness = await connect({ serverConfig: report });

    const res = await harness.client.callTool({
      name: 'get_run_settings',
      arguments: { session_id: 'mcp:x', project_root: PROJECT_ROOT },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, any>;
    expect(structured.ai).toBeNull();
    expect(structured.aiOffReason).toBeNull();
    expect(structured.sources.ai).toBeNull();
    expect(structured.serverDefaults.ai).toBeNull();
    // …and the settings that server DID report still came through.
    expect(structured.model).toBe('session/model');
  });

  /** `report`'s session, with the §9 pair and an override folded in. */
  const withAi = (
    ai: 'on' | 'off',
    aiOffReason: 'policy' | 'no-key' | null,
    override: 'on' | 'off',
  ) => ({
    ...report,
    session: {
      ...report.session,
      overrides: { ...report.session.overrides, ai: override },
      effective: {
        ...report.session.effective,
        ai,
        aiOffReason,
        sources: { ...report.session.effective.sources, ai: 'session' },
      },
    },
  });

  it('names the standing ai override on the text line when the last run disagreed', async () => {
    // A compile bypasses the switch, so a session holding `ai: off` reports
    // `ai: 'on'` from that run — as does a session whose override was set after
    // its last run. Echoing the effective value alone goes SILENT on the `on`
    // side, and a host that renders only content blocks (OpenCode) then sees
    // nothing saying the switch is still down for the next run.
    const harness = await connect({ serverConfig: withAi('on', null, 'off') });

    const res = await harness.client.callTool({
      name: 'get_run_settings',
      arguments: { session_id: 'mcp:x', project_root: PROJECT_ROOT },
    });

    const text = (res.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
    expect(text).toContain('AI: on for the last run');
    expect(text).toContain('session override ai: off stands for the next run');
    // The extra clause is a text-line fix only; structured output is untouched.
    const structured = res.structuredContent as Record<string, any>;
    expect(structured.ai).toBe('on');
    expect(structured.aiOffReason).toBeNull();
    expect(structured.overrides.ai).toBe('off');
  });

  it('keeps the AI echo to one clause when the override and the last run agree', async () => {
    const harness = await connect({ serverConfig: withAi('off', 'policy', 'off') });

    const res = await harness.client.callTool({
      name: 'get_run_settings',
      arguments: { session_id: 'mcp:x', project_root: PROJECT_ROOT },
    });

    const text = (res.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
    expect(text).toContain('AI: off (policy)');
    expect(text).not.toContain('stands for the next run');
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
