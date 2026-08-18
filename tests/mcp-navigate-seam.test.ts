/**
 * `navigate_tab`, driven through a real MCP client over a real transport with
 * only the outside world faked (stories/navigate-tab.md).
 *
 * What this file is for is the half of the story that is about REFUSING: which
 * tab a write is allowed to land on. The route has its own guards and its own
 * suite; these are the ones that must fire before anything reaches the wire, so
 * that a name — "current" above all — never becomes a navigation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import { describeBrowser, navigateNeedsExactTarget } from '../src/mcp/errors.js';
import * as schemas from '../src/mcp/schemas.js';
import type {
  ApiClient,
  McpDeps,
  NavigateCdpTabArgs,
  NavigatedTab,
  ProjectContext,
} from '../src/mcp/types.js';

const PROJECT_ROOT = 'c:/proj';

function fakeProject(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    scope: 'project',
    configSearch: [],
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

const TABS = [
  { targetId: 'T-DOCS', title: 'OpenRouter — Docs', url: 'https://openrouter.ai/docs', sessionId: null },
  { targetId: 'T-CART', title: 'Cart — Checkout', url: 'https://shop.example/cart', sessionId: null },
];

const RUNNING = [
  {
    engine: 'chrome',
    profile: 'default',
    port: 51000,
    profileDir: 'c:/proj/.aiui/cdp-profiles/chrome-default',
    scope: 'project',
    tabs: TABS,
  },
];

const THIS_BROWSER = describeBrowser({ engine: 'chrome', profile: 'default', scope: 'project' });

interface Harness {
  client: Client;
  /** Every navigation that reached the wire — empty alongside an `isError`
   *  result proves the refusal fired before the browser was touched. */
  navigations: NavigateCdpTabArgs[];
  listCalls: { projectRoot: string; includeForeign?: boolean }[];
}

async function connect(
  opts: { navigate?: (args: NavigateCdpTabArgs) => NavigatedTab } = {},
): Promise<Harness> {
  const navigations: Harness['navigations'] = [];
  const listCalls: Harness['listCalls'] = [];

  const fakeClient = {
    async getCdpBrowsers(args: { projectRoot: string; includeForeign?: boolean }) {
      listCalls.push(args);
      return { running: RUNNING, available: [], foreign: [] };
    },
    async navigateCdpTab(args: NavigateCdpTabArgs): Promise<NavigatedTab> {
      navigations.push(args);
      return opts.navigate
        ? opts.navigate(args)
        : {
            requestedUrl: args.url,
            url: args.url,
            title: 'Example Domain',
            targetId: args.targetId ?? 'T-NEW',
            openedNewTab: args.targetId === undefined,
            root: PROJECT_ROOT,
            warnings: [],
          };
    },
  } as unknown as ApiClient;

  const deps: McpDeps = {
    createApiClient: () => fakeClient,
    ensureServerReady: async () => {},
    assertServerRecognized: async () => {},
    resolveProject: async () => fakeProject(),
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'navigate', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, navigations, listCalls };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function text(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content
    .map((c) => c.text ?? '')
    .join('\n');
}

function errorText(built: { content: { text: string }[] }): string {
  return built.content.map((c) => c.text).join('\n');
}

async function go(h: Harness, args: Record<string, unknown> = {}) {
  return (await h.client.callTool({
    name: 'navigate_tab',
    arguments: { url: 'https://example.com/', profile: 'default', ...args },
  })) as unknown as Record<string, unknown>;
}

beforeEach(() => resetRegistry());

describe('navigate_tab opens a new tab unless told otherwise', () => {
  it('sends no targetId when none was given — the arm that destroys nothing', async () => {
    const h = await connect();

    const result = await go(h);

    expect(result.isError).toBeFalsy();
    // Absent on the wire, not empty: "open a new tab" is expressed the same way
    // in the arguments and in the request.
    expect(h.navigations[0]).not.toHaveProperty('targetId');
    expect(structured(result)).toMatchObject({ openedNewTab: true, targetId: 'T-NEW' });
    expect(text(result)).toContain('Opened https://example.com/ in a new tab');
  });

  it('forwards an exact targetId that the browser really has', async () => {
    const h = await connect();

    const result = await go(h, { target_id: 'T-CART' });

    expect(result.isError).toBeFalsy();
    expect(h.navigations[0]).toMatchObject({ targetId: 'T-CART', url: 'https://example.com/' });
    expect(structured(result)).toMatchObject({ openedNewTab: false, targetId: 'T-CART' });
    expect(text(result)).toContain('in a tab you already had open');
  });

  it('carries every field through, and names a redirect on its own line', async () => {
    const h = await connect({
      navigate: (args) => ({
        requestedUrl: args.url,
        // The case worth noticing: you asked for a page and got a login screen.
        url: 'https://accounts.example/login?next=%2F',
        title: 'Sign in',
        targetId: 'T-NEW',
        openedNewTab: true,
        root: PROJECT_ROOT,
        warnings: [],
      }),
    });

    const result = await go(h);

    expect(structured(result)).toEqual({
      requestedUrl: 'https://example.com/',
      url: 'https://accounts.example/login?next=%2F',
      title: 'Sign in',
      targetId: 'T-NEW',
      openedNewTab: true,
      root: PROJECT_ROOT,
      scope: 'project',
      warnings: [],
    });
    // On its own line rather than folded into the success sentence — a login
    // bounce should not read like a detail of a job well done.
    expect(text(result)).toContain('Landed on: https://accounts.example/login?next=%2F — "Sign in"');
  });

  it('puts the server warnings in the text half too', async () => {
    // Hosts render one half or the other, so a warning only in the structured
    // half is a warning half the clients never show.
    const h = await connect({
      navigate: (args) => ({
        requestedUrl: args.url,
        url: args.url,
        title: '',
        targetId: 'T-NEW',
        openedNewTab: true,
        root: PROJECT_ROOT,
        warnings: ['The page had not finished loading after 30s.'],
      }),
    });

    const result = await go(h);

    expect(structured(result)['warnings']).toEqual([
      'The page had not finished loading after 30s.',
    ]);
    expect(text(result)).toContain('The page had not finished loading after 30s.');
  });
});

describe('navigate_tab refuses to guess which tab it overwrites', () => {
  it('refuses a NAME where an exact id is required, before the wire', async () => {
    // peek_tab and run_errand accept names because a wrong read is recoverable.
    // Overwriting the wrong page is not, so this verb sits with close_cdp_tab.
    for (const given of ['Cart', 'title~Cart', 'url~shop.example', 'openrouter']) {
      const h = await connect();
      const result = await go(h, { target_id: given });

      expect(result.isError, given).toBe(true);
      expect(text(result)).toBe(errorText(navigateNeedsExactTarget(given, THIS_BROWSER, TABS)));
      // The candidates are offered, and so is the way out that changes nothing.
      expect(text(result)).toContain('T-CART');
      expect(text(result)).toContain('omit target_id entirely');
      expect(h.navigations).toEqual([]);
    }
  });

  it('says WHY when the name was a position — "current", "active"', async () => {
    for (const given of ['current', 'active', 'this', 'frontmost']) {
      const h = await connect();
      const result = await go(h, { target_id: given });

      expect(result.isError, given).toBe(true);
      // The reason is specific, because the caller believes this is resolvable.
      expect(text(result)).toContain('no way to ask which tab is in front');
      expect(text(result)).toContain('minimised');
      expect(text(result)).toContain('unsaved work');
      expect(h.navigations).toEqual([]);
    }
  });

  it('refuses an id that looks exact but is not in the listing', async () => {
    const h = await connect();

    const result = await go(h, { target_id: 'T-CLOSED' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(errorText(navigateNeedsExactTarget('T-CLOSED', THIS_BROWSER, TABS)));
    expect(h.navigations).toEqual([]);
  });

  it('cannot reach a foreign browser, because there is no port to name', async () => {
    const shape = schemas.navigateTabInput.shape;
    expect(Object.keys(shape)).not.toContain('port');
    expect(Object.keys(shape)).not.toContain('allow_unowned');

    // And the listing it resolves the tab against never asks for foreign ones.
    const h = await connect();
    await go(h, { target_id: 'T-CART' });
    expect(h.listCalls.length).toBeGreaterThan(0);
    for (const call of h.listCalls) {
      expect(call).toEqual({ projectRoot: PROJECT_ROOT, includeForeign: false });
    }
  });

  it('does no EXTRA listing when opening a new tab', async () => {
    // Both arms list once to resolve profile → port. Only the replace arm lists
    // a second time, to prove the id it was handed is really there: the safe
    // arm has nothing to disambiguate, so it pays for nothing.
    const fresh = await connect();
    await go(fresh);
    expect(fresh.listCalls).toHaveLength(1);
    expect(fresh.navigations).toHaveLength(1);

    const replacing = await connect();
    await go(replacing, { target_id: 'T-CART' });
    expect(replacing.listCalls).toHaveLength(2);
  });
});
