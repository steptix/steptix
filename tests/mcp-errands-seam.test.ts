import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import { ApiHttpError } from '../src/mcp/types.js';
import type {
  ApiClient,
  ErrandRequestBody,
  McpDeps,
  ProjectContext,
  RunEvent,
  StreamResult,
} from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// `run_errand`, driven through a real MCP client over a real transport with
// only the outside world faked (stories/errands.md).
//
// Two things are on trial here and nothing else is. First, the two-stage
// attach: an errand takes a tab by NAME, which every sibling CDP tool refuses
// to do — so what makes it safe is that zero or several matches refuse with the
// candidates named, and the first-match-wins rule cdp-tabs guards against never
// runs. Second, the wrong-door refusals: `session_id` and `[skill:]` are
// declared only so they can be turned away with the working alternative named,
// and both must fire before anything reaches a browser.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = 'c:/proj';

function fakeProject(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    scope: 'project',
    configSearch: [],
    projectRoot: PROJECT_ROOT,
    configPath: `${PROJECT_ROOT}/aiui.config.json`,
    env: { AI_API_KEY: 'project-ai-key' },
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

/**
 * Four tabs, chosen so each matching rule can be told apart from the others:
 * two share the word "openrouter" (so a bare name is genuinely ambiguous),
 * one is reachable only through its url, and one only through its title.
 */
const TABS = [
  {
    targetId: 'T-DOCS',
    title: 'OpenRouter — Docs',
    url: 'https://openrouter.ai/docs',
    sessionId: null,
  },
  {
    targetId: 'T-ACT',
    title: 'Activity | OpenRouter',
    url: 'https://openrouter.ai/activity',
    sessionId: null,
  },
  {
    targetId: 'T-CART',
    title: 'Cart — Checkout',
    url: 'https://shop.example/cart',
    sessionId: null,
  },
  {
    targetId: 'T-MAIL',
    title: 'Inbox',
    url: 'https://mail.example/folder/1',
    sessionId: 'mcp:someone',
  },
];

const RUNNING = [
  {
    engine: 'edge',
    profile: 'default',
    port: 51000,
    profileDir: 'c:/proj/.aiui/cdp-profiles/edge-default',
    scope: 'project',
    tabs: TABS,
  },
];

/** The `done` frame's errand block, echoing the request the way the runner
 *  does — the receipt must be built from what the SERVER said, not from what
 *  the tool sent. */
function errandBlock(body: ErrandRequestBody, overrides: Record<string, unknown> = {}) {
  return {
    errandId: 'errand-9f2a1c',
    root: body.root,
    scope: body.scope,
    finalUrl: 'https://shop.example/cart?checkout=1',
    finalTitle: 'Checkout — Shop',
    openedTabs: [],
    keptOpen: [],
    ...overrides,
  };
}

interface Harness {
  client: Client;
  /** Every errand that reached the wire — empty means a pre-flight refusal
   *  fired first, which is the point of most of these tests. */
  errands: ErrandRequestBody[];
  /** Every browser listing. Empty alongside an `isError` result proves a
   *  refusal happened before any browser work. */
  listCalls: { projectRoot: string; includeForeign?: boolean }[];
  /** Every `streamSteps`. An errand must never create a session, so this stays
   *  empty for the whole file. */
  sessionRuns: string[];
  resolveArgs: { projectRoot?: string | undefined; envName?: string | undefined }[];
}

async function connect(
  opts: {
    project?: ProjectContext;
    running?: unknown[];
    /** What `runErrand` streams back. Defaults to one passing step and a
     *  `done` carrying the errand block. */
    events?: (body: ErrandRequestBody) => RunEvent[];
    /** Make `runErrand` throw — the 500 the route answers an attach failure
     *  with, which reaches the client as an ordinary HTTP error. */
    throws?: Error;
  } = {},
): Promise<Harness> {
  const errands: Harness['errands'] = [];
  const listCalls: Harness['listCalls'] = [];
  const sessionRuns: Harness['sessionRuns'] = [];
  const resolveArgs: Harness['resolveArgs'] = [];

  // Only the three methods an errand can reach. A throwing stub for every
  // other method would be noise hiding which ones matter.
  const fakeClient = {
    async streamSteps(sessionId: string): Promise<StreamResult> {
      sessionRuns.push(sessionId);
      return { events: [], receivedAt: [], streamDropped: false, dropped: [] };
    },
    async runErrand(body: ErrandRequestBody): Promise<StreamResult> {
      errands.push(body);
      if (opts.throws) throw opts.throws;
      const events = opts.events
        ? opts.events(body)
        : ([
            { type: 'step:pass', line: 1, output: 'did it' },
            { type: 'done', status: 'passed', errand: errandBlock(body) },
          ] as RunEvent[]);
      return {
        events,
        receivedAt: events.map((_e, i) => i),
        streamDropped: false,
        dropped: [],
      };
    },
    async getCdpBrowsers(args: { projectRoot: string; includeForeign?: boolean }) {
      listCalls.push(args);
      return { running: opts.running ?? RUNNING, available: [], foreign: [] };
    },
  } as unknown as ApiClient;

  const deps: McpDeps = {
    createApiClient: () => fakeClient,
    ensureServerReady: async () => {},
    assertServerRecognized: async () => {},
    resolveProject: async (args) => {
      resolveArgs.push({ projectRoot: args.projectRoot, envName: args.envName });
      const base = opts.project ?? fakeProject();
      // Enough of the real layering for the warning branch: naming an
      // environment is what makes `envName` non-null, and non-null is what
      // stops the "nothing will interpolate this" warning.
      return args.envName === undefined ? base : { ...base, envName: args.envName };
    },
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'errands', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, errands, listCalls, sessionRuns, resolveArgs };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function text(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content
    .map((c) => c.text ?? '')
    .join('\n');
}

/** One valid call, with everything the test does not care about filled in. */
async function errand(
  h: Harness,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await h.client.callTool({
    name: 'run_errand',
    arguments: { tab: 'targetId:T-CART', steps: ['click checkout'], ...args },
  })) as unknown as Record<string, unknown>;
}

beforeEach(() => resetRegistry());

// ---------------------------------------------------------------------------
// Wrong doors (§Routing 4)
// ---------------------------------------------------------------------------

describe('run_errand refuses what it cannot do, naming what can', () => {
  it('refuses session_id and names run_steps, before any browser work', async () => {
    // The argument exists ONLY so this can happen. A bare schema would strip an
    // undeclared key in silence, which is the wrong-door silence errands were
    // built to kill.
    const h = await connect();

    const result = await errand(h, { session_id: 'mcp:steps-123' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('run_steps');
    expect(text(result)).toContain('mcp:steps-123');
    // Before any browser work: nothing was listed and nothing was driven.
    expect(h.listCalls).toEqual([]);
    expect(h.errands).toEqual([]);
  });

  it('refuses an empty session_id too — carrying the key is the problem', async () => {
    const h = await connect();
    const result = await errand(h, { session_id: '' });
    expect(result.isError).toBe(true);
    expect(h.errands).toEqual([]);
  });

  it('declares session_id only to warn about it', async () => {
    // The schema description is the only place a model reads before deciding to
    // pass the argument; the handler refusal is the second chance, not the first.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'run_errand')!;
    const sessionId = (tool.inputSchema as { properties: Record<string, { description?: string }> })
      .properties.session_id;

    expect(sessionId?.description).toContain('run_steps');
    expect(sessionId?.description).toMatch(/no sessions/i);
  });

  it('refuses [skill:] and [tool:] steps by name, before any browser work', async () => {
    // An errand carries no skillsDir/toolsDir, so the server would hand these
    // to the AI as prose — a silent, expensive wrong answer three layers down.
    const h = await connect();

    const result = await errand(h, {
      steps: ['open the cart', 'Log in [skill: login]', '[tool: seed_cart items=2]'],
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('[skill: login]');
    expect(text(result)).toContain('[tool: seed_cart items=2]');
    expect(text(result)).toContain('run_steps');
    // Not swept in: the step that only mentions the cart.
    expect(text(result)).not.toContain('open the cart');
    expect(h.listCalls).toEqual([]);
    expect(h.errands).toEqual([]);
  });

  it('carries the whose-browser decision rule in its description', async () => {
    // §Routing 1. A tool description is the only text guaranteed to be in front
    // of the model at the moment of the call, and the counter-example is the
    // one a model gets wrong by keying on the word "test".
    const { client } = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'run_errand')!.description!;

    expect(description).toMatch(/whose browser/i);
    expect(description).toContain('run_steps');
    expect(description).toContain('my tab');
    expect(description).toContain('test the checkout on my open tab');
  });
});

// ---------------------------------------------------------------------------
// Stage two of the attach: which tab (§Attach)
// ---------------------------------------------------------------------------

describe('the tab matcher', () => {
  it('takes targetId: exactly', async () => {
    const h = await connect();

    const result = await errand(h, { tab: 'targetId:T-ACT' });

    expect(result.isError).toBeFalsy();
    expect(h.errands[0]?.targetId).toBe('T-ACT');
    // The port came from the browser resolution, not from the caller — there is
    // no `port` argument on this tool at all.
    expect(h.errands[0]?.port).toBe(51000);
  });

  it('matches a bare string against the title', async () => {
    const h = await connect();
    await errand(h, { tab: 'activity |' });
    expect(h.errands[0]?.targetId).toBe('T-ACT');
  });

  it('matches a bare string against the url as well as the title', async () => {
    // The union is the point: a user naming "the shop tab" may be repeating
    // what they read in the tab strip or what they know the site to be.
    const h = await connect();
    await errand(h, { tab: 'shop.example' });
    expect(h.errands[0]?.targetId).toBe('T-CART');
  });

  it('matches case-insensitively', async () => {
    const h = await connect();
    await errand(h, { tab: 'INBOX' });
    expect(h.errands[0]?.targetId).toBe('T-MAIL');
  });

  it('narrows to titles with title~ and to urls with url~', async () => {
    const byTitle = await connect();
    await errand(byTitle, { tab: 'title~inbox' });
    expect(byTitle.errands[0]?.targetId).toBe('T-MAIL');

    const byUrl = await connect();
    await errand(byUrl, { tab: 'url~folder/1' });
    expect(byUrl.errands[0]?.targetId).toBe('T-MAIL');

    // …and each really does exclude the other half: this substring is in the
    // url only, so as a title it matches nothing.
    const narrowed = await connect();
    const refused = await errand(narrowed, { tab: 'title~mail.example' });
    expect(refused.isError).toBe(true);
    expect(narrowed.errands).toEqual([]);
  });

  it('refuses a name that matches nothing, listing what IS open', async () => {
    // The caller can then re-name one from what is actually there, which is the
    // whole reason a zero match refuses instead of falling back to a new tab.
    const h = await connect();

    const result = await errand(h, { tab: 'the invoices tab' });

    expect(result.isError).toBe(true);
    for (const tab of TABS) {
      expect(text(result)).toContain(tab.title);
      expect(text(result)).toContain(tab.url);
    }
    expect(h.errands).toEqual([]);
  });

  it('refuses a name that matches several, naming every candidate', async () => {
    const h = await connect();

    const result = await errand(h, { tab: 'openrouter' });

    expect(result.isError).toBe(true);
    // All three identifiers per candidate: two tabs routinely share a title,
    // and the caller has to be able to tell them apart.
    for (const tab of [TABS[0]!, TABS[1]!]) {
      expect(text(result)).toContain(tab.title);
      expect(text(result)).toContain(tab.url);
      expect(text(result)).toContain(tab.targetId);
    }
    // …and only the candidates, not the whole listing.
    expect(text(result)).not.toContain('T-CART');
    expect(h.errands).toEqual([]);
  });

  it('normalises an explicit empty profile to the default', async () => {
    // A deliberate divergence from close_cdp_tab's no-default optional: this
    // tool has no `port`, so the "give profile or port" refusal is unreachable
    // and must stay that way. `""` is what a model emits for an unset optional.
    const h = await connect();

    const result = await errand(h, { profile: '   ' });

    expect(result.isError).toBeFalsy();
    expect(h.errands[0]?.port).toBe(51000);
  });

  it('refuses when the named profile is not running, and lists what is', async () => {
    // Reused as-is from the other CDP tools — an errand cannot start a browser,
    // and "not running" reads as "signed out" to a model when it is not.
    const h = await connect();

    const result = await errand(h, { profile: 'admin' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('start_cdp_browser');
    expect(text(result)).toContain('"default"');
    expect(h.errands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The receipt (§Return)
// ---------------------------------------------------------------------------

describe('the receipt', () => {
  it('folds the run and passes the errand block through', async () => {
    const h = await connect({
      events: (body) => [
        { type: 'step:start', line: 1 },
        { type: 'capture', line: 1, name: 'orderId', value: 'A-4417', source: 'capture' },
        { type: 'step:pass', line: 1, output: 'clicked' },
        { type: 'step:start', line: 2 },
        { type: 'step:pass', line: 2, output: 'read it' },
        {
          type: 'done',
          status: 'passed',
          errand: errandBlock(body, {
            openedTabs: [
              { targetId: 'T-NEW', url: 'https://shop.example/receipt', title: 'Receipt' },
              { url: 'https://shop.example/print', title: 'Print' },
            ],
            keptOpen: [{ targetId: 'T-NEW', url: 'https://shop.example/receipt', title: 'Receipt' }],
          }),
        },
      ],
    });

    const result = await errand(h, { steps: ['click checkout', 'read the order id'] });
    const receipt = structured(result);

    expect(result.isError).toBeFalsy();
    expect(receipt.status).toBe('passed');
    expect(receipt.errandId).toBe('errand-9f2a1c');
    expect(receipt.root).toBe(PROJECT_ROOT);
    expect(receipt.scope).toBe('project');
    expect(receipt.finalUrl).toBe('https://shop.example/cart?checkout=1');
    expect(receipt.finalTitle).toBe('Checkout — Shop');
    expect(receipt.captures).toEqual({ orderId: 'A-4417' });
    expect((receipt.steps as { text: string }[]).map((s) => s.text)).toEqual([
      'click checkout',
      'read the order id',
    ]);
    // A tab whose target id never resolved is null, never a missing key — the
    // url and title still identify it.
    expect(receipt.openedTabs).toEqual([
      { targetId: 'T-NEW', url: 'https://shop.example/receipt', title: 'Receipt' },
      { targetId: null, url: 'https://shop.example/print', title: 'Print' },
    ]);
    expect(receipt.keptOpen).toHaveLength(1);
  });

  it('has no session in it, and creates none', async () => {
    // The receipt is the whole surface an errand leaves behind. A `sessionId`
    // here would be something a caller could try to reuse, and there is nothing
    // on the server to reuse.
    const h = await connect();

    const result = await errand(h);

    expect(structured(result)).not.toHaveProperty('sessionId');
    expect(structured(result)).not.toHaveProperty('reportPath');
    expect(h.sessionRuns).toEqual([]);
  });

  it('sends the synthetic test file, the root and the scope', async () => {
    // The server resolves the project layer of `effectiveSettings` from
    // `testFilePath` alone, and echoes root/scope into the receipt.
    const h = await connect();

    await errand(h);

    expect(h.errands[0]?.testFilePath).toMatch(/[\\/]\.aiui-errand\.md$/);
    expect(h.errands[0]?.root).toBe(PROJECT_ROOT);
    expect(h.errands[0]?.scope).toBe('project');
    // The project's own .env, so the run bills and behaves as the project
    // rather than as whoever started the server.
    expect(h.errands[0]?.env).toEqual({ AI_API_KEY: 'project-ai-key' });
  });

  it('passes keep_open only when it was asked for', async () => {
    const kept = await connect();
    await errand(kept, { keep_open: true });
    expect(kept.errands[0]?.keepOpen).toBe(true);

    const swept = await connect();
    await errand(swept);
    expect(swept.errands[0]).not.toHaveProperty('keepOpen');
  });

  it('reports a failed step as a result, not an error', async () => {
    // The `isError` contract: the errand reached the server and drove the tab,
    // so the receipt — which says what it did to someone's real page — must
    // survive.
    const h = await connect({
      events: (body) => [
        { type: 'step:start', line: 1 },
        { type: 'step:fail', line: 1, error: 'no Checkout button' },
        { type: 'done', status: 'failed', errand: errandBlock(body) },
      ],
    });

    const result = await errand(h);

    expect(result.isError).toBeFalsy();
    expect(structured(result).status).toBe('failed');
    expect(structured(result).error).toBe('no Checkout button');
    expect(structured(result).errandId).toBe('errand-9f2a1c');
  });
});

// ---------------------------------------------------------------------------
// Environments (§Act)
// ---------------------------------------------------------------------------

describe('${env.X} without an env_name', () => {
  it('warns that nothing will interpolate it', async () => {
    // The server builds no env bundle without a name, so this would reach the
    // AI as literal text — the same diagnostic run_steps produces, deliberately
    // word for word.
    const h = await connect();

    const result = await errand(h, { steps: ['sign in with ${env.PASSWORD}'] });

    expect((structured(result).warnings as string[]).join('\n')).toContain('${env.PASSWORD}');
    expect((structured(result).warnings as string[]).join('\n')).toContain('env_name');
  });

  it('is silent once an env_name is given', async () => {
    const h = await connect();

    const result = await errand(h, {
      steps: ['sign in with ${env.PASSWORD}'],
      env_name: 'uat',
    });

    expect((structured(result).warnings as string[]).join('\n')).not.toContain('${env.PASSWORD}');
    // …and the name reached both the project resolution and the wire, which is
    // what actually builds the bundle server-side.
    expect(h.resolveArgs.at(-1)?.envName).toBe('uat');
    expect(h.errands[0]?.envName).toBe('uat');
  });

  it('is silent when there is nothing to interpolate', async () => {
    const h = await connect();
    const result = await errand(h, { steps: ['click checkout'] });
    expect(structured(result).warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Attach failures (§Attach)
// ---------------------------------------------------------------------------

describe('an errand that never got the tab', () => {
  it('maps the route 500 to an honest error result', async () => {
    // The tab was listed a moment ago and is gone now. The server refuses the
    // attach by name rather than matching something else, and that message is
    // the one worth showing.
    const h = await connect({
      throws: new ApiHttpError(500, 'CDP: no tab matches targetId "T-CART".'),
    });

    const result = await errand(h);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no tab matches targetId "T-CART"');
    expect(result.structuredContent).toBeUndefined();
  });

  it('maps a done frame with no errand block the same way', async () => {
    // The errand's accounting is built in a `finally`, so an errand that ran at
    // all has one. Its absence means nothing ran — which is the one case
    // `isError` is reserved for.
    const h = await connect({
      events: () => [
        { type: 'output', msg: 'Server error: connect ECONNREFUSED', kind: 'error' },
        { type: 'done', status: 'error' },
      ],
    });

    const result = await errand(h, { tab: 'targetId:T-CART' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('targetId:T-CART');
    expect(text(result)).toContain('ECONNREFUSED');
    expect(text(result)).toContain('list_cdp_browsers');
  });
});
