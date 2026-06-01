import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { parseTestFile } from '../src/parser/markdown.js';

/**
 * End-to-end integration test for the file-based tool layer.
 *
 * Wiring exercised:
 *   - fixtures/tools/src is loaded as a real ToolCatalogue (registry pipeline).
 *   - fixtures/test-app/server.ts is spawned as a child process on a free port.
 *   - Real Playwright chromium drives the page; tools share the same `page`,
 *     `context`, and `browser` instances the runner would.
 *   - Tool outputs land in `resolvedParameters` (the same map the runner uses
 *     to interpolate `{{placeholders}}` in subsequent natural-language steps).
 *   - The test markdown file (`fixtures/tests/tool-demo.md`) is parsed via
 *     `parseTestFile` so the parallel `toolCalls` array is exercised end-to-end.
 */

const repoRoot = path.resolve(__dirname, '..');
const toolsDir = path.join(repoRoot, 'fixtures', 'tools', 'src');
const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');
const demoTestPath = path.join(repoRoot, 'fixtures', 'tests', 'tool-demo.md');

let serverProc: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let port: number;
let baseUrl: string;
let catalogue: ToolCatalogue;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error('Failed to allocate port')));
      }
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not yet ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

beforeAll(async () => {
  port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  serverProc = spawn(process.execPath, ['--import', 'tsx', serverPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr?.on('data', (b: Buffer) => {
    process.stderr.write(`[test-app] ${b.toString()}`);
  });

  await waitForHttp(`${baseUrl}/api/csrf-token`);

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();

  catalogue = await loadToolCatalogue(toolsDir);
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    if (!serverProc.killed) serverProc.kill('SIGKILL');
  }
}, 15_000);

describe('end-to-end tool execution against fixtures/test-app', () => {
  it('indexes the fixture tools from disk and resolves them lazily by name', async () => {
    expect(catalogue.indexedCount).toBeGreaterThanOrEqual(2);
    expect((await catalogue.resolve('fetch_csrf_token')).definition.name).toBe('fetch_csrf_token');
    expect((await catalogue.resolve('read_page_title')).definition.name).toBe('read_page_title');
  });

  it('resolves rung-1 (bare function), rung-2 (tool() helper), and named-export tools', async () => {
    expect((await catalogue.resolve('uuid')).definition.name).toBe('uuid');                  // rung 1
    expect((await catalogue.resolve('check_health')).definition.name).toBe('check_health');  // rung 2
    // Named exports live in a multi-tool file — referenced as `<file>/<tool>`.
    expect((await catalogue.resolve('strings/slugify')).definition.name).toBe('slugify');
    expect((await catalogue.resolve('strings/upper')).definition.name).toBe('upper');
  });

  it('isolates a broken tool file — healthy tools run, the broken one fails only when invoked', async () => {
    // `broken_tool.ts` (imports a missing package) is indexed alongside the
    // healthy tools. A tool we don't reference is unaffected by its presence:
    expect((await catalogue.resolve('uuid')).definition.name).toBe('uuid');
    // …and the broken tool fails as a single failed step, with the real error,
    // only because this step referenced it.
    const outcome = await executeToolStep(
      { name: 'broken_tool', args: {}, outputAliases: {} },
      { page, context, browser, resolvedParameters: {}, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/could not be loaded/);
  });

  it('runs a rung-1 bare-function tool — return value lands in scope under the tool name', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      { name: 'uuid', args: {}, outputAliases: {} },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['uuid']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('runs a rung-2 tool() with live page context against the test-app', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'check_health',
        args: { baseUrl },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['check_health']).toBe('true');
  });

  it('runs a multi-tool-file named export via file/tool — caller arg destructured from scope', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'strings/slugify',
        args: { s: 'Hello, World! 2026' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    // Output lands under the tool's own name, not the path-qualified ref.
    expect(resolvedParameters['slugify']).toBe('hello-world-2026');
  });

  it('parses the demo .md test, recognising tool steps in the parallel toolCalls array', async () => {
    const parsed = await parseTestFile(demoTestPath);
    const toolStepIndices = parsed.toolCalls
      .map((c, i) => (c ? i : -1))
      .filter((i) => i >= 0);
    expect(toolStepIndices).toEqual([1, 2]);
    expect(parsed.toolCalls[1]?.name).toBe('read_page_title');
    expect(parsed.toolCalls[2]).toEqual({
      name: 'fetch_csrf_token',
      args: { baseUrl: '{{baseUrl}}' },
      outputAliases: {},
    });
  });

  it('runs read_page_title against the live page and writes page_title to scope', async () => {
    await page.goto(`${baseUrl}/`);
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      { name: 'read_page_title', args: {}, outputAliases: {} },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['page_title']).toBeTruthy();
    // index.html sets the document title to "SecureBank — Sign In"
    expect(resolvedParameters['page_title']).toContain('SecureBank');
  });

  it('runs fetch_csrf_token, calling the live API and capturing the token', async () => {
    const resolvedParameters: Record<string, string> = { baseUrl };
    const outcome = await executeToolStep(
      {
        name: 'fetch_csrf_token',
        args: { baseUrl: '{{baseUrl}}' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    const token = resolvedParameters['csrf'];
    expect(typeof token).toBe('string');
    expect((token ?? '').length).toBeGreaterThanOrEqual(16);
    // Token from the test-app is base64 of 24 random bytes (~32 chars).
    expect(token).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('respects caller-supplied output aliases (out.csrf="my_token")', async () => {
    const resolvedParameters: Record<string, string> = { baseUrl };
    const outcome = await executeToolStep(
      {
        name: 'fetch_csrf_token',
        args: { baseUrl: '{{baseUrl}}' },
        outputAliases: { csrf: 'my_token' },
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['my_token']).toBeTruthy();
    expect(resolvedParameters['csrf']).toBeUndefined();
  });

  it('captures structured logs from the tool into the outcome', async () => {
    const resolvedParameters: Record<string, string> = { baseUrl };
    const outcome = await executeToolStep(
      {
        name: 'fetch_csrf_token',
        args: { baseUrl: '{{baseUrl}}' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.logs.length).toBeGreaterThanOrEqual(2);
    expect(outcome.logs[0]?.message).toContain('GET');
    expect(outcome.logs.at(-1)?.message).toContain('captured token');
  });

  // ── regex_extract (issue 020 — slice a substring out of a read value) ──────
  // Pure string tool: ignores page/context, so these exercise the extraction
  // semantics directly. The motivating case is a `read` capturing an element's
  // whole textContent when the test only wants a fragment of it.

  it('regex_extract: stores the first capture group', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'regex_extract',
        args: {
          text: 'Account number: 1234 1234 1234 OIN:12345678',
          pattern: 'Account number:\\s*(\\d{4} \\d{4} \\d{4})',
        },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['match']).toBe('1234 1234 1234');
  });

  it('regex_extract: falls back to the whole match when the pattern has no group', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'regex_extract',
        args: { text: 'DE89 3704 0044 0532', pattern: '^[A-Z]{2}' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['match']).toBe('DE');
  });

  it('regex_extract: honours flags and an explicit capture-group index', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'regex_extract',
        args: { text: 'X-abc-Y', pattern: '(a)(B)(c)', flags: 'i', group: '2' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['match']).toBe('b'); // group 2, matched case-insensitively
  });

  it('regex_extract: respects out.match output aliasing', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'regex_extract',
        args: {
          text: 'https://shop.example.com/orders/O-1007/details',
          pattern: '/orders/([A-Z0-9-]+)',
        },
        outputAliases: { match: 'order_id' },
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['order_id']).toBe('O-1007');
    expect(resolvedParameters['match']).toBeUndefined();
  });

  it('regex_extract: FAILS HARD when the pattern matches nothing', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'regex_extract',
        args: { text: 'no digits anywhere', pattern: '(\\d{4})' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/matched nothing/);
    expect(resolvedParameters['match']).toBeUndefined();
  });

  it('regex_extract: FAILS HARD on an invalid pattern', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'regex_extract',
        args: { text: 'whatever', pattern: '(' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/invalid pattern/);
  });

  it('parses the regex-extract demo .md, recognising the three tool steps with quoted args', async () => {
    const parsed = await parseTestFile(
      path.join(repoRoot, 'fixtures', 'tests', 'regex-extract-demo.md'),
    );
    const toolStepIndices = parsed.toolCalls
      .map((c, i) => (c ? i : -1))
      .filter((i) => i >= 0);
    expect(toolStepIndices).toEqual([0, 2, 4]);

    // Quoted values keep spaces and colons intact; out.match aliases the output.
    expect(parsed.toolCalls[0]?.name).toBe('regex_extract');
    expect(parsed.toolCalls[0]?.args['text']).toBe(
      'Account number: 1234 1234 1234 OIN:12345678',
    );
    expect(parsed.toolCalls[0]?.args['pattern']).toBe(
      'Account number: ([0-9]{4} [0-9]{4} [0-9]{4})',
    );
    expect(parsed.toolCalls[0]?.outputAliases).toEqual({ match: 'account_number' });
    expect(parsed.toolCalls[2]?.outputAliases).toEqual({ match: 'iban_country' });
    expect(parsed.toolCalls[4]?.outputAliases).toEqual({ match: 'order_id' });
  });
});
