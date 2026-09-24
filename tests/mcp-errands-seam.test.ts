import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import {
  errandDidNotAttach,
  errandTabHeldByErrand,
  errandTabHeldBySession,
} from '../src/mcp/errors.js';
import { STREAM_DROPPED_WARNING } from '../src/mcp/run-fold.js';
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
    /** The one dropped-stream shape `!sawDone` cannot express: the connection
     *  dies AFTER the `done` frame arrived, so the events are complete and yet
     *  the real client still reports `streamDropped: true` — from its catch arm
     *  (src/mcp/api-client.ts), which returns the events it has without ever
     *  consulting `sawDone`. */
    dropAfterDone?: boolean;
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
        // Derived, exactly as the real client derives it — `!sawDone`
        // (src/mcp/api-client.ts:236). Hard-coded `false` here meant a script
        // that ended mid-stream reached the tool claiming the stream was
        // intact, so every warning the truncated path adds went untested.
        // `dropAfterDone` is the client's OTHER source of the same flag (its
        // catch arm), and only an explicit opt-in reaches it, so every other
        // test keeps the `!sawDone` derivation unchanged.
        streamDropped: opts.dropAfterDone === true || !events.some((event) => event.type === 'done'),
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

  it('treats an empty session_id as absent — a serializer the model cannot control sends ""', async () => {
    // Measured live (OpenCode + gpt-5.6-luna, 2026-08-13): the provider layer
    // serializes every declared optional as "", so "call again without
    // session_id" is an instruction the model physically cannot follow.
    // Refusing on presence turned the wrong-door redirect into a livelock;
    // the refusal now fires on a non-empty VALUE only.
    const h = await connect();
    const result = await errand(h, { session_id: '' });
    expect(result.isError).toBeFalsy();
    expect(h.errands).toHaveLength(1);
  });

  it('treats a whitespace session_id the same as empty', async () => {
    const h = await connect();
    const result = await errand(h, { session_id: '  ' });
    expect(result.isError).toBeFalsy();
    expect(h.errands).toHaveLength(1);
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

  it('refuses the colon-less invocation spelling, but not bracketed prose', async () => {
    // The invocation grammar's colon is optional (`[skill login]` is a call),
    // so the errand scan must keep pace — while `[skills]` / `[toolbox]`,
    // which the tokenizer would never claim, must keep flowing as prose.
    const h = await connect();

    const result = await errand(h, {
      steps: ['Open the [skills] page', 'Log in [skill login]', '[tool seed_cart items=2]'],
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('[skill login]');
    expect(text(result)).toContain('[tool seed_cart items=2]');
    expect(text(result)).not.toContain('[skills] page');
    expect(h.errands).toEqual([]);
  });

  it('carries the whose-browser decision rule, now split by read-vs-act, in its description', async () => {
    // §Routing 1. A tool description is the only text guaranteed to be in front
    // of the model at the moment of the call, and the counter-example is the
    // one a model gets wrong by keying on the word "test".
    //
    // The rule gained a clause when the third door shipped
    // (stories/tab-peek.md §Routing 3, a named amendment to errands §Routing
    // 1): the ownership answer splits — theirs to borrow, READING is peek_tab
    // and ACTING is this one. This pin MOVED with the text rather than being
    // weakened around it, so the original four assertions still stand.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'run_errand')!.description!;

    expect(description).toMatch(/whose browser/i);
    expect(description).toContain('run_steps');
    expect(description).toContain('my tab');
    expect(description).toContain('test the checkout on my open tab');

    expect(description).toContain('peek_tab');
    expect(description).toMatch(/READING/);
    expect(description).toMatch(/ACTING/);
  });

  it('splits the same rule in the shared CDP_NOTE, true of both tools that ship it', async () => {
    // `CDP_NOTE` rides on `run_steps` AND `run_test_file`, so the added clause
    // has to read correctly from either — neither of them can peek, and
    // neither of them is the errand. Behaviour unchanged; text changed.
    const { client } = await connect();
    const { tools } = await client.listTools();

    for (const name of ['run_steps', 'run_test_file']) {
      const description = tools.find((t) => t.name === name)!.description!;
      expect(description, name).toMatch(/whose browser/i);
      expect(description, name).toContain('peek_tab');
      expect(description, name).toContain('run_errand');
      // Said of the tool being described, not of the reader: "is not this
      // tool" has to be true whichever of the two is doing the describing.
      expect(description, name).toContain('is not this tool');
    }
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
    // The one-line headline, unchanged for a run that skipped nothing: the
    // count reads `N/M steps` exactly as it always has.
    expect(text(result)).toContain('PASSED — 2/2 steps in "Cart — Checkout"');
  });

  it('says how many steps a return skipped, on the one line a text-only host shows', async () => {
    // stories/step-flow-control.md. Counting only `passed` made an errand that
    // returned read `PASSED — 1/3 steps in "…"` — two shortfalls with nothing
    // saying they were skipped on purpose.
    const h = await connect({
      events: (body) => [
        { type: 'step:start', line: 1 },
        { type: 'step:pass', line: 1, output: 'Ended the run' },
        { type: 'step:skip', line: 2, reason: 'Not run: step 1 ended the run — Stop' },
        { type: 'step:skip', line: 3, reason: 'Not run: step 1 ended the run — Stop' },
        { type: 'done', status: 'passed', errand: errandBlock(body, {}) },
      ],
    });

    const result = await errand(h, { steps: ['Stop', 'click checkout', 'read the total'] });
    expect(text(result)).toContain(
      'PASSED — 1 passed, 2 skipped (a step returned early) of 3 in "Cart — Checkout"',
    );
  });

  it('never says a tab closed when the receipt says it is still open', async () => {
    // `keptOpen` is "still open on return" (src/mcp/schemas.ts), and under the
    // default `keep_open: false` it is normally empty — but not always: a tab
    // this errand opened and another errand took the wheel of is spared the
    // close and is still on screen. "The rest closed on the way out" was
    // arithmetic dressed as an observation, and for that tab it was false.
    const spared = { targetId: 'T-NEW', url: 'https://shop.example/receipt', title: 'Receipt' };
    const collided = await connect({
      events: (body) => [
        { type: 'step:pass', line: 1, output: 'opened it' },
        {
          type: 'done',
          status: 'passed',
          errand: errandBlock(body, { openedTabs: [spared], keptOpen: [spared] }),
        },
      ],
    });

    const result = await errand(collided);

    expect(text(result)).toContain('Opened 1 tab(s); 1 still open.');
    expect(text(result)).not.toMatch(/closed on the way out/);

    // The control, and the ordinary case: nothing survived, so the count of
    // what is gone is the whole list — still without claiming who closed it,
    // since a tab a STEP closed mid-run never reached the detach.
    const swept = await connect({
      events: (body) => [
        { type: 'step:pass', line: 1, output: 'opened two' },
        {
          type: 'done',
          status: 'passed',
          errand: errandBlock(body, {
            openedTabs: [spared, { targetId: 'T-OLD', url: 'https://shop.example/x', title: 'X' }],
            keptOpen: [],
          }),
        },
      ],
    });

    expect(text(await errand(swept))).toContain('Opened 2 tab(s); 0 still open, 2 no longer open.');
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

  it('swaps the get_last_run remedy on a FINISHED receipt too, when the stream died after done', async () => {
    // A dropped stream is not the truncated path's private problem. The client
    // sets `streamDropped` in its catch arm as well (src/mcp/api-client.ts),
    // where it returns the events it already has — so a connection that dies
    // after the `done` frame folds into a complete, finished receipt that the
    // fold has still stamped with `STREAM_DROPPED_WARNING`. That line offers
    // `get_last_run`, addressed by a `session_id` this errand never created:
    // the same impossible remedy, on the receipt that reaches callers most.
    const h = await connect({ dropAfterDone: true });

    const result = await errand(h);

    const receipt = structured(result);
    // Finished, not truncated: the `done` frame arrived, so the errand block is
    // on the receipt — the truncated path reports both of these missing. This
    // is the FINISHED path, and it still says dropped.
    expect(receipt.errandId).toBe('errand-9f2a1c');
    expect(receipt.finalUrl).toBe('https://shop.example/cart?checkout=1');
    expect(receipt.streamDropped).toBe(true);
    // `passed` even though the `done` frame said so would be a claim about a
    // run whose end this client did not see; the fold forces `error` on any
    // dropped stream (run-fold.ts:385). Pinned so the discriminator above stays
    // the errand block rather than the status.
    expect(receipt.status).toBe('error');

    const warnings = receipt.warnings as string[];
    expect(warnings).not.toContain(STREAM_DROPPED_WARNING);
    expect(warnings.join('\n')).not.toMatch(/call get_last_run/);
    expect(warnings.join('\n')).toContain('list_cdp_browsers');
    expect(warnings.join('\n')).toMatch(/idempotent/i);
  });

  it('leaves an intact finished receipt free of the dropped-stream warning', async () => {
    // The other half of the swap: it fires on the condition, not on the path.
    // A stream that neither dropped nor truncated earns neither warning, so the
    // filter cannot be passing the test above by pushing its substitute
    // unconditionally.
    const h = await connect();

    const receipt = structured(await errand(h));

    expect(receipt.streamDropped).toBe(false);
    expect((receipt.warnings as string[]).join('\n')).not.toContain('list_cdp_browsers');
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
    // all has one. Its absence with NO step event means nothing ran — which is
    // the one case `isError` is reserved for.
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

  it('keeps the steps and captures when the stream dies MID-errand', async () => {
    // The other half of "no errand block", and the opposite story: a force
    // shutdown, a crashed server or a proxy timeout ends the stream after steps
    // have already driven the user's tab. Answering that with the attach
    // refusal reports "nothing ran" about a page that was clicked, and throws
    // away the only surviving record of what was done to it.
    const h = await connect({
      events: () => [
        { type: 'step:start', line: 1 },
        { type: 'capture', line: 1, name: 'orderId', value: 'A-4417', source: 'capture' },
        { type: 'step:pass', line: 1, output: 'clicked checkout' },
        // …and then nothing. No `done`, no errand block.
      ],
    });

    const result = await errand(h, {
      tab: 'targetId:T-CART',
      steps: ['click checkout', 'read the order id'],
    });

    // A receipt, not an `isError` — the payload is the point.
    expect(result.isError).toBeFalsy();
    const receipt = structured(result);
    expect(receipt.status).toBe('error');
    expect(receipt.captures).toEqual({ orderId: 'A-4417' });
    const steps = receipt.steps as { text: string; status: string }[];
    expect(steps.map((s) => s.text)).toEqual(['click checkout', 'read the order id']);
    expect(steps[0]!.status).toBe('passed');

    // What it says about the tab: driven, and its end state unknown.
    expect(String(receipt.error)).toMatch(/DROVE tab "targetId:T-CART"/);
    expect(String(receipt.error)).toMatch(/final state is unknown/i);

    // And what it does NOT say. Pinned against the builder rather than a phrase
    // someone can reword: "the errand never got tab X, so nothing ran in it" is
    // the refusal this path exists to stop being.
    expect(text(result)).not.toContain(
      errandDidNotAttach('targetId:T-CART', null).content[0]!.text,
    );

    // Nothing is guessed in the fields the `done` frame owns: they are reported
    // missing, and the warning says missing ≠ empty.
    expect(receipt.errandId).toBe('');
    expect(receipt.finalUrl).toBe('');
    expect(receipt.openedTabs).toEqual([]);
    expect((receipt.warnings as string[]).join('\n')).toContain('openedTabs');

    // The remedy an errand can actually carry out. A stream that ends with no
    // `done` IS a dropped stream, and the fold's own warning for one says "call
    // get_last_run to check" — a call addressed by `session_id` (getLastRunInput)
    // that an errand can never satisfy, because it creates no session. So that
    // line is filtered out by identity and replaced with one aimed at the
    // browser, which is where the tab's real state is.
    expect(receipt.streamDropped).toBe(true);
    const warnings = receipt.warnings as string[];
    expect(warnings).not.toContain(STREAM_DROPPED_WARNING);
    expect(warnings.join('\n')).not.toMatch(/call get_last_run/);
    expect(warnings.join('\n')).toContain('list_cdp_browsers');
    // …and the caveat that makes "just run it again" a decision rather than a
    // reflex: the errand may have kept driving the tab after the stream died.
    expect(warnings.join('\n')).toMatch(/idempotent/i);
  });

  it('keeps the failure screenshot when the stream dies MID-errand', async () => {
    // The picture is of the user's real page at the moment things went wrong,
    // and this is the receipt that can say least about what happened next — the
    // last one that should be dropping it. It was: the truncated path passed no
    // image block at all while the finished path passed one.
    const h = await connect({
      events: () => [
        { type: 'step:start', line: 1 },
        {
          type: 'step:fail',
          line: 1,
          error: 'no Checkout button',
          screenshot: 'data:image/png;base64,QUJD',
        },
        // …and then nothing.
      ],
    });

    const result = await errand(h);

    const blocks = (result as unknown as { content: { type: string; data?: string }[] }).content;
    // Prefix stripped by the fold, and last in the content array, exactly as the
    // finished path returns it.
    expect(blocks.at(-1)).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
  });
});

// ---------------------------------------------------------------------------
// The turn lock, from the tool's side (§The wheel)
// ---------------------------------------------------------------------------

describe('a tab somebody else is driving', () => {
  it('does NOT read a turn-lock 409 as an attach failure', async () => {
    // The trap this suite exists for. A lock 409 and a vanished tab both arrive
    // as an `ApiHttpError`, and the attach message — "the tab may have been
    // closed, call list_cdp_browsers" — is the wrong story AND the wrong next
    // action for a tab that is very much open and very much busy. The `holder`
    // shape is the only thing telling them apart.
    const h = await connect({
      throws: new ApiHttpError(409, 'Errand errand-7c1 is already driving that tab.', {
        kind: 'errand',
        errandId: 'errand-7c1',
        tabRole: 'borrowed',
      }),
    });

    const result = await errand(h, { tab: 'title~Cart' });

    expect(result.isError).toBe(true);
    // Equality against the builder, not a list of phrases the text must avoid:
    // "does not say 'never got tab'" passes again the moment either message is
    // reworded, while this can only pass when the `holder` shape picked THIS
    // refusal.
    expect(text(result)).toBe(
      errandTabHeldByErrand('errand-7c1', 'borrowed', 'title~Cart').content[0]!.text,
    );
  });

  it('names the holding session, and its two remedies, for a session 409', async () => {
    const h = await connect({
      throws: new ApiHttpError(409, 'Session "mcp:steps-1" has a batch in flight.', {
        kind: 'session',
        sessionId: 'mcp:steps-1',
      }),
    });

    const result = await errand(h, { tab: 'title~Cart' });

    expect(result.isError).toBe(true);
    // Unlike an errand, a session outlives its batch — so there are two ways
    // out, and which is right depends on whether it is still wanted. Pinned by
    // equality for the same reason as its sibling above.
    expect(text(result)).toBe(
      errandTabHeldBySession('mcp:steps-1', 'title~Cart').content[0]!.text,
    );
    expect(text(result)).toContain('close_session');
  });

  it('says an errand-OPENED tab will be gone, and sends the caller to re-list', async () => {
    const h = await connect({
      throws: new ApiHttpError(409, 'Errand errand-7c1 opened that tab.', {
        kind: 'errand',
        errandId: 'errand-7c1',
        tabRole: 'opened',
      }),
    });

    const result = await errand(h, { tab: 'title~Cart' });

    expect(text(result)).toMatch(/gone/i);
    expect(text(result)).toContain('list_cdp_browsers');
  });

  it('falls back to the generic message when a 409 carries no usable holder', async () => {
    // A server older than the lock, or a holder shape this build cannot read.
    // Inventing a refusal out of half a shape would put an empty errand id into
    // a sentence telling the model to wait for it.
    const h = await connect({
      throws: new ApiHttpError(409, 'Something else refused this.', null),
    });

    const result = await errand(h, { tab: 'title~Cart' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Something else refused this.');
  });
});
