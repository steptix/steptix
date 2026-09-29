import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import {
  describeBrowser,
  peekRouteMissing,
  peekScreenshotArgConflict,
  peekScreenshotTooLarge,
  peekSessionsAreForGetPageContent,
  peekTabAmbiguous,
  peekTabGoneNow,
  peekTabNotFound,
} from '../src/mcp/errors.js';
import { MAX_SCREENSHOT_BASE64 } from '../src/mcp/run-fold.js';
import * as schemas from '../src/mcp/schemas.js';
import { ApiHttpError, ApiRouteNotFoundError } from '../src/mcp/types.js';
import type {
  ApiClient,
  ErrandRequestBody,
  McpDeps,
  PeekCdpTabArgs,
  PeekedTab,
  ProjectContext,
  StreamResult,
} from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// `peek_tab`, driven through a real MCP client over a real transport with only
// the outside world faked (stories/tab-peek.md).
//
// The surface itself is what this file examines, which nothing else can: every
// `tab` spelling and the union it matches over, the profile normalisation, the
// shape of both refusals over a fixture listing, the `session_id` wrong door,
// the route-missing/tab-gone 404 split, and the description's three-door rule.
//
// Item (3)'s sharing clause is pinned the way errands pins it: each tool's
// refusals are asserted against ITS OWN exported builder, and the two tools'
// builders are asserted to be fed the SAME candidate list — which is what
// makes "the matcher is the shared `matchTabsByName`" a claim about the
// product rather than about a copy that happens to agree today.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = 'c:/proj';

function fakeProject(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    scope: 'project',
    configSearch: [],
    projectRoot: PROJECT_ROOT,
    configPath: `${PROJECT_ROOT}/steptix.config.json`,
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
 * The same four tabs the errands seam uses, and deliberately so: item (3)'s
 * last clause is that both tools match over ONE list, and a different fixture
 * here would make that comparison meaningless.
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
    profileDir: 'c:/proj/.steptix/cdp-profiles/edge-default',
    scope: 'project',
    tabs: TABS,
  },
];

const PAGE_TEXT = 'Cart\n1 item\nTotal $42.00';

function peekedTab(args: PeekCdpTabArgs, overrides: Partial<PeekedTab> = {}): PeekedTab {
  return {
    targetId: args.targetId,
    root: PROJECT_ROOT,
    url: 'https://shop.example/cart',
    title: 'Cart — Checkout',
    format: args.format ?? 'text',
    selector: args.selector ?? null,
    content: PAGE_TEXT,
    truncated: false,
    returnedChars: PAGE_TEXT.length,
    availableChars: PAGE_TEXT.length,
    ...overrides,
  };
}

interface Harness {
  client: Client;
  /** Every peek that reached the wire — empty alongside an `isError` result
   *  proves the refusal fired before any browser was touched. */
  peeks: PeekCdpTabArgs[];
  /** Every browser listing. */
  listCalls: { projectRoot: string; includeForeign?: boolean }[];
  /** Every errand and every session batch. A peek must reach neither. */
  errands: ErrandRequestBody[];
  sessionRuns: string[];
}

async function connect(
  opts: {
    project?: ProjectContext;
    running?: unknown[];
    /** What the server answers with — or throws. */
    peek?: (args: PeekCdpTabArgs) => PeekedTab;
    throws?: Error;
  } = {},
): Promise<Harness> {
  const peeks: Harness['peeks'] = [];
  const listCalls: Harness['listCalls'] = [];
  const errands: Harness['errands'] = [];
  const sessionRuns: Harness['sessionRuns'] = [];

  const fakeClient = {
    async streamSteps(sessionId: string): Promise<StreamResult> {
      sessionRuns.push(sessionId);
      return { events: [], receivedAt: [], streamDropped: false, dropped: [] };
    },
    async runErrand(body: ErrandRequestBody): Promise<StreamResult> {
      errands.push(body);
      return { events: [], receivedAt: [], streamDropped: false, dropped: [] };
    },
    async getCdpBrowsers(args: { projectRoot: string; includeForeign?: boolean }) {
      listCalls.push(args);
      return { running: opts.running ?? RUNNING, available: [], foreign: [] };
    },
    async peekCdpTab(args: PeekCdpTabArgs): Promise<PeekedTab> {
      peeks.push(args);
      if (opts.throws) throw opts.throws;
      return opts.peek ? opts.peek(args) : peekedTab(args);
    },
  } as unknown as ApiClient;

  const deps: McpDeps = {
    createApiClient: () => fakeClient,
    ensureServerReady: async () => {},
    assertServerRecognized: async () => {},
    resolveProject: async () => opts.project ?? fakeProject(),
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'peek', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, peeks, listCalls, errands, sessionRuns };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function text(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content
    .map((c) => c.text ?? '')
    .join('\n');
}

/** The one text an `McpToolError` builder carries — compared whole, because a
 *  substring match decays the moment either side is reworded. */
function errorText(built: { content: { text: string }[] }): string {
  return built.content.map((c) => c.text).join('\n');
}

/** One valid call, with everything the test does not care about filled in. */
async function peek(
  h: Harness,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await h.client.callTool({
    name: 'peek_tab',
    arguments: { tab: 'targetId:T-CART', ...args },
  })) as unknown as Record<string, unknown>;
}

const THIS_BROWSER = describeBrowser({ engine: 'edge', profile: 'default', scope: 'project' });

beforeEach(() => resetRegistry());

// ---------------------------------------------------------------------------
// Wrong doors (§Routing 3)
// ---------------------------------------------------------------------------

describe('peek_tab refuses what it cannot do, naming what can', () => {
  it('refuses session_id and names get_page_content, before any browser work', async () => {
    // The argument exists ONLY so this can happen. A bare schema would strip an
    // undeclared key in silence, which is the wrong-door silence the errand
    // story was built to kill and this one inherits.
    const h = await connect();

    const result = await peek(h, { session_id: 'mcp:steps-123' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(errorText(peekSessionsAreForGetPageContent('mcp:steps-123')));
    expect(text(result)).toContain('get_page_content');
    // Before any browser work: nothing was listed and nothing was read.
    expect(h.listCalls).toEqual([]);
    expect(h.peeks).toEqual([]);
  });

  it('treats an empty session_id as absent — a serializer the model cannot control sends ""', async () => {
    // Measured live on run_errand (OpenCode + gpt-5.6-luna, 2026-08-13): the
    // provider layer serializes every declared optional as "", so "call again
    // without session_id" is an instruction the model physically cannot
    // follow. The refusal fires on a non-empty VALUE only.
    const h = await connect();
    const result = await peek(h, { session_id: '' });
    expect(result.isError).toBeFalsy();
    expect(h.peeks).toHaveLength(1);
  });

  it('treats a whitespace session_id the same as empty', async () => {
    const h = await connect();
    const result = await peek(h, { session_id: '  ' });
    expect(result.isError).toBeFalsy();
    expect(h.peeks).toHaveLength(1);
  });

  it('declares session_id only to warn about it', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'peek_tab')!;
    const sessionId = (tool.inputSchema as { properties: Record<string, { description?: string }> })
      .properties.session_id;

    expect(sessionId?.description).toContain('get_page_content');
    expect(sessionId?.description).toMatch(/not a session/i);
  });

  it('carries the three-door rule in its description', async () => {
    // §Routing. A tool description is the only text guaranteed to be in front
    // of the model at the moment of the call, and all three doors have to be
    // in it — naming only this one leaves a model that wants to CLICK on the
    // tab reading a read-only tool's description and finding no way out.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'peek_tab')!.description!;

    expect(description).toContain('run_errand');
    expect(description).toContain('get_page_content');
    expect(description).toMatch(/reading/i);
    expect(description).toMatch(/driving/i);
    // And the promise item (5) is about, said where a model reads it.
    expect(description).toMatch(/does NOT bring the tab forward/);
    expect(description).toContain('focus_cdp_tab');
  });

  it('says the read tool for a tab in the run tools and the session tool alike', async () => {
    // §Routing 3's amendment, applied where the shipped rule ships. The
    // CDP_NOTE sentence must be true of BOTH run tools that carry it —
    // neither of them can peek — and `get_page_content`'s own description is
    // the other end of the same redirect.
    const { client } = await connect();
    const { tools } = await client.listTools();

    for (const name of ['run_steps', 'run_test_file', 'run_errand', 'get_page_content']) {
      const description = tools.find((t) => t.name === name)!.description!;
      expect(description, name).toContain('peek_tab');
    }

    // The split itself, on the tool whose one-question rule it amends.
    const errand = tools.find((t) => t.name === 'run_errand')!.description!;
    expect(errand).toMatch(/READING/);
    expect(errand).toMatch(/ACTING/);
  });
});

// ---------------------------------------------------------------------------
// Stage two of the attach: which tab (§Attach)
// ---------------------------------------------------------------------------

describe('the tab matcher', () => {
  it('takes targetId: exactly', async () => {
    const h = await connect();

    const result = await peek(h, { tab: 'targetId:T-ACT' });

    expect(result.isError).toBeFalsy();
    expect(h.peeks[0]?.targetId).toBe('T-ACT');
    // The port came from the browser resolution, not from the caller — there is
    // no `port` argument on this tool at all, which is what makes the
    // foreign-browser gate unreachable by construction.
    expect(h.peeks[0]?.port).toBe(51000);
  });

  it('matches a bare string against the title', async () => {
    const h = await connect();
    await peek(h, { tab: 'activity |' });
    expect(h.peeks[0]?.targetId).toBe('T-ACT');
  });

  it('matches a bare string against the url as well as the title', async () => {
    const h = await connect();
    await peek(h, { tab: 'shop.example' });
    expect(h.peeks[0]?.targetId).toBe('T-CART');
  });

  it('matches case-insensitively', async () => {
    const h = await connect();
    await peek(h, { tab: 'INBOX' });
    expect(h.peeks[0]?.targetId).toBe('T-MAIL');
  });

  it('narrows to titles with title~ and to urls with url~', async () => {
    const byTitle = await connect();
    await peek(byTitle, { tab: 'title~inbox' });
    expect(byTitle.peeks[0]?.targetId).toBe('T-MAIL');

    const byUrl = await connect();
    await peek(byUrl, { tab: 'url~folder/1' });
    expect(byUrl.peeks[0]?.targetId).toBe('T-MAIL');

    // …and each really does exclude the other half: this substring is in the
    // url only, so as a title it matches nothing.
    const narrowed = await connect();
    const refused = await peek(narrowed, { tab: 'title~mail.example' });
    expect(refused.isError).toBe(true);
    expect(narrowed.peeks).toEqual([]);
  });

  it('refuses a name that matches nothing, listing what IS open', async () => {
    const h = await connect();

    const result = await peek(h, { tab: 'the invoices tab' });

    expect(result.isError).toBe(true);
    // Word for word against this tool's OWN builder — the errand's would
    // lecture a read about borrowing and driving.
    expect(text(result)).toBe(errorText(peekTabNotFound('the invoices tab', THIS_BROWSER, TABS)));
    expect(text(result)).toContain('nothing to read');
    expect(h.peeks).toEqual([]);
  });

  it('refuses a name that matches several, naming every candidate', async () => {
    const h = await connect();

    const result = await peek(h, { tab: 'openrouter' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      errorText(peekTabAmbiguous('openrouter', [TABS[0]!, TABS[1]!])),
    );
    // All three identifiers per candidate: two tabs routinely share a title.
    for (const tab of [TABS[0]!, TABS[1]!]) {
      expect(text(result)).toContain(tab.title);
      expect(text(result)).toContain(tab.url);
      expect(text(result)).toContain(tab.targetId);
    }
    // …and only the candidates, not the whole listing.
    expect(text(result)).not.toContain('T-CART');
    expect(h.peeks).toEqual([]);
  });

  it('feeds run_errand and peek_tab the SAME candidate list (item 3)', async () => {
    // The sharing clause, and the only way to state it as a claim about the
    // product: one `tab` spelling, one browser listing, two tools — and the
    // candidate sets their refusals name must be identical, character for
    // character. A copied matcher that drifts (a different prefix rule, a
    // title-only union) changes one side of this and nothing else notices.
    const spec = 'openrouter';
    const forErrand = await connect();
    const errandRefusal = (await forErrand.client.callTool({
      name: 'run_errand',
      arguments: { tab: spec, steps: ['click something'] },
    })) as unknown as Record<string, unknown>;

    const forPeek = await connect();
    const peekRefusal = await peek(forPeek, { tab: spec });

    expect(errandRefusal.isError).toBe(true);
    expect(peekRefusal.isError).toBe(true);

    // Each against its own builder, fed the same two candidates — so the
    // equality below is about the CANDIDATES, not about the prose.
    const candidates = [TABS[0]!, TABS[1]!];
    const { errandTabAmbiguous } = await import('../src/mcp/errors.js');
    expect(text(errandRefusal)).toBe(errorText(errandTabAmbiguous(spec, candidates)));
    expect(text(peekRefusal)).toBe(errorText(peekTabAmbiguous(spec, candidates)));

    // And the prose really does differ, so the assertion above is not two
    // names for one string.
    expect(text(errandRefusal)).not.toBe(text(peekRefusal));
  });

  it('never lets a name reach the wire — only an exact target id does', async () => {
    // The first-match-wins arm of the server's own resolver is never asked to
    // arbitrate, which is the whole reason a name-shaped argument is safe here.
    const h = await connect();
    await peek(h, { tab: 'title~Cart' });
    expect(h.peeks[0]?.targetId).toBe('T-CART');
  });

  it('normalises an explicit empty profile to the default', async () => {
    // Same divergence from `close_cdp_tab`'s no-default optional as the
    // errand's: this tool has no `port`, so the "give profile or port" refusal
    // is unreachable and must stay that way.
    const h = await connect();

    const result = await peek(h, { profile: '   ' });

    expect(result.isError).toBeFalsy();
    expect(h.peeks[0]?.port).toBe(51000);
  });

  it('refuses when the named profile is not running, and lists what is', async () => {
    // Reused as-is from the other CDP tools — a peek cannot start a browser.
    const h = await connect();

    const result = await peek(h, { profile: 'admin' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('start_cdp_browser');
    expect(text(result)).toContain('"default"');
    expect(h.peeks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The extraction and what rides back with it (§Detach)
// ---------------------------------------------------------------------------

describe('the result', () => {
  it('sends the synthetic test file, which is what makes it the PROJECT\'s settings', async () => {
    // Verification item (2)'s mechanism at the wire: the server resolves the
    // project root — and with it the dom limits and the noise reduction —
    // from this path and nothing else.
    const h = await connect();

    await peek(h);

    expect(h.peeks[0]?.testFilePath).toMatch(/[\\/]\.steptix-peek\.md$/);
    // Under the project root, so the root it resolves to is the one this call
    // addressed. Separator-agnostic: `path.join` uses the platform's.
    expect(path.dirname(h.peeks[0]!.testFilePath)).toBe(path.normalize(PROJECT_ROOT));
  });

  it('forwards format, selector and max_chars, and only when asked', async () => {
    const asked = await connect();
    await peek(asked, { format: 'dom', selector: '#total', max_chars: 500 });
    expect(asked.peeks[0]).toMatchObject({ format: 'dom', selector: '#total', maxChars: 500 });

    // Omitted rather than defaulted client-side: the server owns the defaults,
    // and sending our own would let the two drift.
    const bare = await connect();
    await peek(bare);
    expect(bare.peeks[0]).not.toHaveProperty('format');
    expect(bare.peeks[0]).not.toHaveProperty('selector');
    expect(bare.peeks[0]).not.toHaveProperty('maxChars');
  });

  it('carries the page, the tab and the root — and no session, no status', async () => {
    const h = await connect();

    const result = await peek(h);
    const value = structured(result);

    expect(result.isError).toBeFalsy();
    expect(value).toEqual({
      targetId: 'T-CART',
      url: 'https://shop.example/cart',
      title: 'Cart — Checkout',
      format: 'text',
      selector: null,
      content: PAGE_TEXT,
      truncated: false,
      // Null rather than absent or 0: a text read has no pixels, and 0 would
      // read as a zero-sized picture (stories/cdp-tab-screenshot.md).
      width: null,
      height: null,
      returnedChars: PAGE_TEXT.length,
      availableChars: PAGE_TEXT.length,
      root: PROJECT_ROOT,
      scope: 'project',
    });
    // Whether another driver was on the tab is that driver's receipt to tell —
    // a `status` here would be a run claim a read cannot make.
    expect(value).not.toHaveProperty('status');
    expect(value).not.toHaveProperty('sessionId');
  });

  it('creates nothing on the way: no session, no errand', async () => {
    const h = await connect();
    await peek(h);
    expect(h.sessionRuns).toEqual([]);
    expect(h.errands).toEqual([]);
  });

  it('reports truncation in the summary, which is all some hosts show', async () => {
    const h = await connect({
      peek: (args) =>
        peekedTab(args, { truncated: true, returnedChars: 500, availableChars: 91_234 }),
    });

    const result = await peek(h, { max_chars: 500 });

    expect(structured(result)).toMatchObject({ truncated: true, availableChars: 91_234 });
    expect(text(result)).toContain('500 of 91234+ chars');
    expect(text(result)).toContain('selector');
  });

  it('names a user-root browser in the summary the way close_cdp_tab does', async () => {
    // The one thing a reader will not expect from the arguments they passed: a
    // project-scope call that read a machine-wide browser.
    const h = await connect({
      running: [{ ...RUNNING[0]!, scope: 'user' }],
    });

    const result = await peek(h, { scope: 'user' });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('(user root)');
  });

  it('falls back to the addressed root when the server reports none', async () => {
    // Null means no `steptix.config.json` stood above the synthetic path, so the
    // server used its own defaults — the root this call addressed is then the
    // honest thing to report, because it is the root the path was built from.
    const h = await connect({ peek: (args) => peekedTab(args, { root: null as never }) });

    const result = await peek(h);

    expect(structured(result).root).toBe(PROJECT_ROOT);
  });
});

// ---------------------------------------------------------------------------
// The 404 split (§The peek route, cdp-tab-focus §6's locked rule)
// ---------------------------------------------------------------------------

describe('the two readings of a 404', () => {
  it('answers a bare non-JSON 404 with "rebuild", never "your tab is gone"', async () => {
    // A server built before this story. Telling a user their tab was closed
    // when the real answer is a stale dist/ sends them looking for a window
    // that is still sitting on their screen.
    const h = await connect({
      throws: new ApiRouteNotFoundError('http://127.0.0.1:3100/cdp/browsers/51000/tabs/T-CART/content'),
    });

    const result = await peek(h);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(errorText(peekRouteMissing('http://127.0.0.1:3100')));
    expect(text(result)).toContain('dist/');
    expect(text(result)).toContain('The tab is fine');
    // And it must not have reached for the other story.
    expect(text(result)).not.toMatch(/already been closed/);
  });

  it('answers a JSON-envelope 404 as the tab being gone, listing what is left', async () => {
    // The tab closed between our listing and the server's. Its row is dropped
    // from the candidates offered, because the server has just proved that
    // entry stale — re-offering it would invite the same failed call again.
    const h = await connect({
      throws: new ApiHttpError(404, 'No tab with target id T-CART is open in the browser on port 51000.'),
    });

    const result = await peek(h);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      errorText(
        peekTabGoneNow(
          'targetId:T-CART',
          THIS_BROWSER,
          TABS.filter((t) => t.targetId !== 'T-CART'),
        ),
      ),
    );
    // Its OWN refusal, not the pre-flight miss over a shorter list. "No tab
    // matches" is false here — one did, a moment ago — and a caller told they
    // named nothing goes hunting for a better name instead of re-reading a
    // browser that moved under them.
    expect(text(result)).toContain('when we listed it');
    expect(text(result)).toContain('closed it in between');
    expect(text(result)).not.toContain('so there is nothing to read');
    // The three still open are named, so the caller can re-aim without a
    // second listing.
    for (const still of TABS.filter((t) => t.targetId !== 'T-CART')) {
      expect(text(result)).toContain(still.targetId);
    }
    // The gone tab is echoed once, as the spec the caller passed — and NOT as
    // a candidate to try again.
    expect(text(result)).not.toContain('(targetId: T-CART)');
    expect(text(result)).not.toContain('rebuild');
  });

  it('does not tell a one-tab browser it "reports no tabs at all"', async () => {
    // The list this arm hands back is one it emptied ITSELF, by dropping the
    // row the server just proved stale. With a single tab open that leaves
    // nothing — and the pre-flight refusal's zero-tab arm then reports the
    // browser as having no tabs and tells the caller to check they named the
    // right profile: two false claims about a browser sitting there with a
    // window open, and a remedy for a mistake nobody made.
    const h = await connect({
      running: [{ ...RUNNING[0]!, tabs: [TABS[2]!] }],
      throws: new ApiHttpError(404, 'No tab with target id T-CART is open in the browser on port 51000.'),
    });

    const result = await peek(h);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(errorText(peekTabGoneNow('targetId:T-CART', THIS_BROWSER, [])));
    expect(text(result)).not.toContain('reports no tabs at all');
    expect(text(result)).not.toContain('check the profile');
    // It still says what happened and what to call next — an empty candidate
    // list is not a reason to say less.
    expect(text(result)).toContain('closed it in between');
    expect(text(result)).toContain('Nothing else is open in that browser now');
    expect(text(result)).toContain('list_cdp_browsers');
  });

  it('leaves every other status to the generic error path', async () => {
    // A 409 from the navigated-page arm is the caller's to retry, and reading
    // it as a missing route or a missing tab would send them somewhere useless.
    const h = await connect({
      throws: new ApiHttpError(409, 'Text capture failed: the page navigated during the read.'),
    });

    const result = await peek(h);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('navigated');
    expect(text(result)).not.toContain('dist/');
  });
});

// ---------------------------------------------------------------------------
// The picture (stories/cdp-tab-screenshot.md)
//
// Everything about ADDRESSING a tab is the text peek's and is covered above —
// what is new here is the second payload: which half of a result carries it,
// what happens when it is too big, and the two arguments a picture cannot
// honour. Those are asserted against the exported builders, the way this file
// asserts every other refusal.
// ---------------------------------------------------------------------------

/**
 * A real 1×1 PNG, base64.
 *
 * Genuinely decodable rather than a placeholder, and that is not fussiness: the
 * MCP SDK validates an image block's `data` as base64 and rejects the whole
 * result otherwise — so a fake string would fail every assertion here for a
 * reason that has nothing to do with what is being tested.
 */
const IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A screenshot response, shaped as the route builds one: the picture and its
 *  pixels, and NONE of the character fields. */
function shotTab(args: PeekCdpTabArgs, overrides: Partial<PeekedTab> = {}): PeekedTab {
  return {
    targetId: args.targetId,
    root: PROJECT_ROOT,
    url: 'https://shop.example/cart',
    title: 'Cart — Checkout',
    format: 'screenshot',
    selector: null,
    screenshot: IMAGE_B64,
    width: 1689,
    height: 1277,
    ...overrides,
  };
}

/** The image blocks of a result, which is where the payload lives. */
function images(result: unknown): { data: string; mimeType: string }[] {
  return (result as { content: { type: string; data?: string; mimeType?: string }[] }).content
    .filter((c) => c.type === 'image')
    .map((c) => ({ data: c.data ?? '', mimeType: c.mimeType ?? '' }));
}

describe('peek_tab photographs a tab that has no session', () => {
  it('asks the server for a picture, and for full_page only when told', async () => {
    const asked = await connect({ peek: shotTab });
    await peek(asked, { format: 'screenshot', full_page: true });
    expect(asked.peeks[0]).toMatchObject({ format: 'screenshot', fullPage: true });

    // `false` is SENT, not dropped as a no-op: it is the default today, and a
    // caller that says so explicitly should not have to depend on that
    // staying true.
    const viewport = await connect({ peek: shotTab });
    await peek(viewport, { format: 'screenshot', full_page: false });
    expect(viewport.peeks[0]).toMatchObject({ format: 'screenshot', fullPage: false });

    // Omitted entirely when unasked, so a text peek's query is byte-identical
    // to what it was before screenshots existed.
    const bare = await connect();
    await peek(bare);
    expect(bare.peeks[0]).not.toHaveProperty('fullPage');
    expect(bare.peeks[0]).not.toHaveProperty('format');
  });

  it('carries the image in an image block and the facts in the structured half', async () => {
    const h = await connect({ peek: shotTab });

    const result = await peek(h, { format: 'screenshot' });

    expect(result.isError).toBeFalsy();
    // The payload, byte for byte, as an image block — not as text, and not
    // repeated into `content` where it would double the response.
    expect(images(result)).toEqual([{ data: IMAGE_B64, mimeType: 'image/png' }]);
    expect(structured(result)).toEqual({
      targetId: 'T-CART',
      url: 'https://shop.example/cart',
      title: 'Cart — Checkout',
      format: 'screenshot',
      // Nothing narrowed it, and nothing could.
      selector: null,
      // Empty on purpose: `format` says which half of the result to read.
      content: '',
      // An image that did not fit is an error, never a partial picture.
      truncated: false,
      width: 1689,
      height: 1277,
      returnedChars: IMAGE_B64.length,
      availableChars: IMAGE_B64.length,
      root: PROJECT_ROOT,
      scope: 'project',
    });
    // The summary names the tab and the browser, so a host rendering only text
    // still learns what was photographed and where.
    expect(text(result)).toContain('Photographed "Cart — Checkout"');
    expect(text(result)).toContain(THIS_BROWSER);
    expect(text(result)).toContain('viewport');
    expect(text(result)).toContain('1689×1277');
  });

  it('says full page in the summary when that is what was captured', async () => {
    const h = await connect({ peek: (a) => shotTab(a, { height: 3361 }) });

    const result = await peek(h, { format: 'screenshot', full_page: true });

    expect(text(result)).toContain('full page');
    expect(text(result)).not.toContain('viewport');
    expect(structured(result)['height']).toBe(3361);
  });

  it('reads the half THIS CALL asked for, not the half that came back', async () => {
    // Version skew: a server answering a picture request with a text body. The
    // text is not the answer to the question that was asked, and folding it in
    // as one would hand back the wrong KIND of thing.
    const h = await connect({ peek: (a) => peekedTab({ ...a, format: 'text' }) });

    const result = await peek(h, { format: 'screenshot' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/bug in the server/i);
  });

  it('refuses an empty picture rather than reporting a blank page', async () => {
    const h = await connect({ peek: (a) => shotTab(a, { screenshot: '' }) });

    const result = await peek(h, { format: 'screenshot' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not a blank page/i);
  });

  it('strips a data-uri prefix rather than emitting an unrenderable block', async () => {
    const h = await connect({
      peek: (a) => shotTab(a, { screenshot: `data:image/png;base64,${IMAGE_B64}` }),
    });

    const result = await peek(h, { format: 'screenshot' });

    expect(images(result)).toEqual([{ data: IMAGE_B64, mimeType: 'image/png' }]);
  });
});

describe('peek_tab refuses a picture it cannot hand over', () => {
  /** One base64 character past the cap. */
  const OVERSIZE = 'A'.repeat(MAX_SCREENSHOT_BASE64 + 1);

  it('reports an over-cap image as an error naming the cap and full_page', async () => {
    const h = await connect({ peek: (a) => shotTab(a, { screenshot: OVERSIZE }) });

    const result = await peek(h, { format: 'screenshot', full_page: true });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      errorText(peekScreenshotTooLarge(THIS_BROWSER, OVERSIZE.length, MAX_SCREENSHOT_BASE64, true)),
    );
    // The fix that actually applies, named: full_page is how a peek gets here.
    expect(text(result)).toContain('full_page: false');
    // And no image block, so nothing downstream renders a truncated picture.
    expect(images(result)).toEqual([]);
  });

  it('does not blame full_page when it was not set', async () => {
    const h = await connect({ peek: (a) => shotTab(a, { screenshot: OVERSIZE }) });

    const result = await peek(h, { format: 'screenshot' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      errorText(peekScreenshotTooLarge(THIS_BROWSER, OVERSIZE.length, MAX_SCREENSHOT_BASE64, false)),
    );
    expect(text(result)).toContain('already set');
    expect(text(result)).toContain('format "text"');
  });

  it('cannot address a foreign browser at all, because there is no port to name', async () => {
    // Story item (5), asserted as the construction it actually is rather than
    // as a gate that could be got wrong. A photograph discloses strictly more
    // than a title, and titles are already withheld for foreign browsers — so
    // the picture inherits the STRONGER posture: `peek_tab` takes no `port`,
    // only a profile, and a profile resolves out of the registry's own running
    // list. mcp-cdp-browser §6's `allowUnowned` gate is unreachable from here,
    // which is why this tool has no such argument either.
    const shape = schemas.peekTabInput.shape;
    expect(Object.keys(shape)).not.toContain('port');
    expect(Object.keys(shape)).not.toContain('allow_unowned');
    // And EVERY listing it resolves against — the profile resolution's and the
    // fresh tab re-read's — asks for owned browsers only. One of the two
    // quietly widening is how a foreign tab becomes nameable after all.
    const h = await connect({ peek: shotTab });
    await peek(h, { format: 'screenshot' });
    expect(h.listCalls.length).toBeGreaterThan(0);
    for (const call of h.listCalls) {
      expect(call).toEqual({ projectRoot: PROJECT_ROOT, includeForeign: false });
    }
  });

  it('refuses selector and max_chars alongside a screenshot, before any browser work', async () => {
    // Refused, never ignored — and before `withProject`, so an impossible
    // combination never starts a server just to be told no.
    const withSelector = await connect();
    const selectorResult = await peek(withSelector, { format: 'screenshot', selector: '#total' });
    expect(selectorResult.isError).toBe(true);
    expect(text(selectorResult)).toBe(errorText(peekScreenshotArgConflict('selector')));
    expect(withSelector.listCalls).toEqual([]);
    expect(withSelector.peeks).toEqual([]);

    const withMax = await connect();
    const maxResult = await peek(withMax, { format: 'screenshot', max_chars: 500 });
    expect(maxResult.isError).toBe(true);
    expect(text(maxResult)).toBe(errorText(peekScreenshotArgConflict('max_chars')));
    expect(withMax.peeks).toEqual([]);

    // Both still work for the formats they belong to.
    const reading = await connect();
    const ok = await peek(reading, { format: 'dom', selector: '#total', max_chars: 500 });
    expect(ok.isError).toBeFalsy();
  });
});
