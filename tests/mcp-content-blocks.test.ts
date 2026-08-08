import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMcpServer } from '../src/mcp/server.js';
import { resetRegistry } from '../src/mcp/registry.js';
import type { ApiClient, McpDeps, ProjectContext, StreamResult } from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// Every tool's `content` blocks must carry its `structuredContent`, serialized.
//
// A tool result has two halves and hosts disagree about which one the model
// sees. Claude Code shows it `structuredContent`; opencode's MCP catalogue
// returns `content` untouched whenever it is non-empty, so a prose summary
// there is ALL the model gets. Measured 2026-08-08 against one server:
// `list_cdp_browsers` reached Claude Code as the full listing and opencode as
// `"1 running, 2 available (not started)"` — carrying none of the `targetId`s
// that `close_cdp_tab`'s own description tells the agent to read out of it.
//
// The guard is driven off `listTools()` rather than a hand-written list,
// because a hand-written list IS the per-tool opt-out this exists to prevent.
// The arguments table below is the same hazard one level down, so its keys are
// asserted equal to the registered tools too.
// ---------------------------------------------------------------------------

/** A port nothing listens on. `server_status` probes for real — that is the
 *  tool's whole job — and a refused connection is both fast and deterministic,
 *  where a plausible-looking dev port would depend on what the machine is
 *  running. Either arm produces a valid result; this one always takes `down`. */
const DEAD_SERVER = 'http://127.0.0.1:1';

const RUNNING_BROWSER = {
  engine: 'edge',
  profile: 'default',
  port: 51000,
  profileDir: 'c:/proj/.aiui/cdp-profiles/edge-default',
  tabs: [
    {
      targetId: 'A1B2C3',
      title: 'OpenRouter — Docs',
      url: 'https://openrouter.ai/docs',
      sessionId: null,
    },
  ],
};

/** Distinctive, and deliberately carrying a newline and a quote — the two
 *  characters JSON escaping touches. */
const PAGE_TEXT = 'Invoices\nYou have 3 unpaid "invoices".';

let tmpDir: string;
let testFile: string;
let previousRoots: string | undefined;

beforeAll(async () => {
  // A real project on disk: `list_test_files` confines `tests.dir` against
  // `allowedRoots()`, and `run_test_file` reads the file it is given, so
  // neither can be answered from a fabricated root.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-blocks-')));
  await fs.writeFile(path.join(tmpDir, 'aiui.config.json'), JSON.stringify({}));
  await fs.mkdir(path.join(tmpDir, 'tests'));
  testFile = path.join(tmpDir, 'tests', 'simple.md');
  await fs.writeFile(testFile, '# Simple\n\n## Steps\n1. Click Login\n');

  previousRoots = process.env['AIUI_MCP_ROOTS'];
  process.env['AIUI_MCP_ROOTS'] = tmpDir;
});

afterAll(async () => {
  if (previousRoots === undefined) delete process.env['AIUI_MCP_ROOTS'];
  else process.env['AIUI_MCP_ROOTS'] = previousRoots;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  resetRegistry();
});

function fakeProject(): ProjectContext {
  return {
    projectRoot: tmpDir,
    configPath: path.join(tmpDir, 'aiui.config.json'),
    env: {},
    envName: null,
    serverUrl: DEAD_SERVER,
    apiKey: 'server-key',
    skillsDir: null,
    toolsDir: null,
    cacheEnabled: false,
    envFilesConsulted: [path.join(tmpDir, '.env')],
    cdpPermissions: { allowUnowned: false, ports: null },
  };
}

async function connect(): Promise<Client> {
  const fakeClient: ApiClient = {
    async streamSteps(): Promise<StreamResult> {
      return {
        events: [{ type: 'step:pass', line: 1 }],
        receivedAt: [0],
        streamDropped: false,
        dropped: [],
      };
    },
    async getLastRun() {
      return { finalized: true, reportPath: 'c:/proj/reports/x.html', tokens: null };
    },
    async closeSession() {},
    async getPageContent(sessionId) {
      return {
        sessionId,
        url: 'https://app.test/invoices',
        title: 'Invoices',
        status: 'active',
        format: 'text',
        selector: null,
        content: PAGE_TEXT,
        truncated: false,
        returnedChars: PAGE_TEXT.length,
        availableChars: PAGE_TEXT.length,
      } as never;
    },
    async listSessions() {
      return [{ sessionId: 'mcp:a' }] as never;
    },
    async getCdpBrowsers() {
      return { running: [RUNNING_BROWSER], available: [], foreign: [] } as never;
    },
    async startCdpBrowser() {
      return {
        engine: 'edge',
        profile: 'default',
        port: 51000,
        profileDir: 'c:/proj/.aiui/cdp-profiles/edge-default',
        binary: 'C:/msedge.exe',
        tabs: [],
        outcome: 'reused_running_browser',
        warnings: [],
      } as never;
    },
    async closeCdpTab(args) {
      return {
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
      } as never;
    },
  };

  const deps: McpDeps = {
    createApiClient: () => fakeClient,
    ensureServerReady: async () => {},
    assertServerRecognized: async () => {},
    resolveProject: async () => fakeProject(),
  };

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'blocks', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** One valid, succeeding call per tool. Keys are asserted against
 *  `listTools()` below, so adding a tool without adding a row here fails
 *  rather than silently narrowing the guard. */
function argumentsFor(): Record<string, Record<string, unknown>> {
  return {
    run_steps: { steps: ['Click Login'], project_root: tmpDir },
    run_test_file: { path: testFile, project_root: tmpDir },
    list_test_files: { project_root: tmpDir },
    list_sessions: { project_root: tmpDir },
    close_session: { session_id: 'mcp:a', project_root: tmpDir },
    get_last_run: { session_id: 'mcp:a', project_root: tmpDir },
    get_page_content: { session_id: 'mcp:a', project_root: tmpDir },
    server_status: { project_root: tmpDir },
    list_cdp_browsers: { project_root: tmpDir },
    start_cdp_browser: { engine: 'edge', profile: 'default', project_root: tmpDir },
    close_cdp_tab: { profile: 'default', target_id: 'A1B2C3', project_root: tmpDir },
  };
}

function blocks(result: unknown): { type: string; text?: string }[] {
  return (result as { content: { type: string; text?: string }[] }).content;
}

describe('every tool serializes its structured content into a content block', () => {
  it('covers exactly the registered tools', async () => {
    // The table above is a hand-written list, which is the very thing this
    // guard exists to stop a tool escaping through. Pinning it to the
    // registration keeps the coverage honest.
    const client = await connect();
    const { tools } = await client.listTools();

    expect(Object.keys(argumentsFor()).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it.each(Object.keys(argumentsFor()))(
    '%s puts its data in content, not only in structuredContent',
    // `get_last_run` polls; the fake finalizes on the first read, but the
    // budget is ~12 s if that ever changes.
    { timeout: 30_000 },
    async (name) => {
      const client = await connect();
      const result = await client.callTool({ name, arguments: argumentsFor()[name]! });

      // `toBeFalsy`: the SDK leaves `isError` undefined on success, not false.
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(result.structuredContent).toBeDefined();

      // Equality, not `toContain`. A pretty-printed copy would satisfy
      // "contains the data" while costing ~45% more for indentation no model
      // reads, and the point of pinning the exact serialization is that the
      // two halves cannot drift apart.
      const texts = blocks(result).map((b) => b.text);
      expect(texts).toContain(JSON.stringify(result.structuredContent));

      // The summary survives — it carries counts, truncation and warning
      // tallies that raw JSON does not narrate — and stays first.
      expect(texts[0]).toBeTruthy();
      expect(texts[0]).not.toBe(JSON.stringify(result.structuredContent));
    },
  );

  it('does not ship the page twice for get_page_content', async () => {
    // This tool used to append the raw page as its own block. Keeping that on
    // top of the standard one would send the page three times — raw, again
    // inside the JSON, and once more in `structuredContent` — measured at
    // 2.05x the page against 1.05x for letting the standard block carry it.
    const client = await connect();
    const result = await client.callTool({
      name: 'get_page_content',
      arguments: { session_id: 'mcp:a', project_root: tmpDir },
    });

    expect(result.isError).toBeFalsy();
    expect(blocks(result)).toHaveLength(2);

    // The page is present exactly once, and only in escaped form.
    const joined = blocks(result)
      .map((b) => b.text ?? '')
      .join('\n');
    expect(joined).toContain(JSON.stringify(PAGE_TEXT).slice(1, -1));
    expect(joined).not.toContain(PAGE_TEXT);
    expect((result.structuredContent as { content: string }).content).toBe(PAGE_TEXT);
  });

  it('serializes the degraded result, not the one that failed validation', async () => {
    // The one path where the two halves could describe different runs: when
    // `value` fails its own schema, `structuredContent` becomes the fallback,
    // so the text block must follow it rather than the rejected original.
    //
    // `output` is the lever — the wire shape-check does not police it (the
    // fold only stores it), but the schema requires string|null.
    const deps: McpDeps = {
      createApiClient: () => ({
        async streamSteps(): Promise<StreamResult> {
          return {
            events: [
              { type: 'step:start', line: 1 },
              { type: 'step:pass', line: 1, output: { nope: true } as never },
              { type: 'done', status: 'passed' },
            ],
            receivedAt: [0, 1, 2],
            streamDropped: false,
            dropped: [],
          };
        },
        async getLastRun() {
          return { finalized: true, reportPath: null, tokens: null };
        },
        async closeSession() {},
        async getPageContent() {
          throw new Error('not reached');
        },
        async listSessions() {
          return [];
        },
        async getCdpBrowsers() {
          return { running: [], available: [], foreign: [] } as never;
        },
        async startCdpBrowser() {
          throw new Error('not reached');
        },
        async closeCdpTab() {
          throw new Error('not reached');
        },
      }),
      ensureServerReady: async () => {},
      assertServerRecognized: async () => {},
      resolveProject: async () => fakeProject(),
    };
    const server = createMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'blocks-degraded', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'run_steps',
      arguments: { steps: ['Click Login'], project_root: tmpDir },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe('error');
    const texts = blocks(result).map((b) => b.text);
    expect(texts).toContain(JSON.stringify(result.structuredContent));
  });
});
