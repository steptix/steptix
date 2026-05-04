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
  it('loads the fixture tools from disk via the registry', () => {
    expect(catalogue.size).toBeGreaterThanOrEqual(2);
    expect(catalogue.has('fetch_csrf_token')).toBe(true);
    expect(catalogue.has('read_page_title')).toBe(true);
  });

  it('also discovers rung-1 (bare function), rung-2 (tool() helper), and named-export tools', () => {
    expect(catalogue.has('uuid')).toBe(true);          // rung 1, filename-as-name
    expect(catalogue.has('check_health')).toBe(true);  // rung 2, filename-as-name
    expect(catalogue.has('slugify')).toBe(true);       // named export
    expect(catalogue.has('upper')).toBe(true);         // named export
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

  it('runs a multi-tool-file named export — caller arg destructured from scope', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'slugify',
        args: { s: 'Hello, World! 2026' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
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
});
