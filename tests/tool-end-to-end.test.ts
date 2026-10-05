import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

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
 *
 * Only the tools that need the live app are here: the server and the browser
 * cost seconds of beforeAll, and a boot failure fails every test in the file.
 * The fixture tools that never touch the page (catalogue loading, uuid,
 * slugify, regex_extract) run in fixture-tools.test.ts without either.
 */

const repoRoot = path.resolve(__dirname, '..');
const toolsDir = path.join(repoRoot, 'fixtures', 'tools', 'src');

let server: FixtureServer | undefined;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseUrl: string;
let catalogue: ToolCatalogue;

beforeAll(async () => {
  server = await startFixtureServer();
  baseUrl = server.baseUrl;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();

  catalogue = await loadToolCatalogue(toolsDir);
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  await server?.stop();
}, 60_000);

describe('end-to-end tool execution against fixtures/test-app', () => {
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
