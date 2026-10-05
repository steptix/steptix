/**
 * End-to-end integration test for "tool returns an array", through the
 * handbook's worked example (docs/test-writing-handbook.md, extract_order_ids):
 *
 *   test-app `/api/orders`         ──┐
 *                                    ├──► extract_order_ids tool
 *                                    │     ├── step.setVar('order_ids', string[])
 *                                    │     └── step.setVar('order_count', number)
 *                                    │
 *   resolvedParameters['order_ids']     ◄── JSON-encoded array in storage
 *
 * One seam test against the live app. What the executor does with an array
 * output from there — aliasing it, and decoding it back into a downstream
 * tool's typed string[] — is the same for any tool and is unit-tested
 * without a browser in tool-array-params.test.ts and tool-executor.test.ts.
 *
 * No AI in the loop — we drive the executor primitives directly so the
 * test stays fast and deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

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

  catalogue = await loadToolCatalogue(toolsDir);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  await server?.stop();
}, 60_000);

describe('extract_order_ids — tool emits a string[] back to the test scope', () => {
  it('produces order_ids and order_count from the live /api/orders endpoint', async () => {
    const params: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'extract_order_ids',
        args: { sinceDays: '30', baseUrl },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: params, catalogue },
    );

    expect(outcome.status).toBe('passed');
    // JSON-encoded array landed in storage.
    const ids = JSON.parse(params['order_ids']!) as string[];
    expect(Array.isArray(ids)).toBe(true);
    // Within the 30-day window the test-app fixture has 8 orders
    // (O-1001..O-1008). O-1009 (ageDays=35) and O-1010 (ageDays=60) fall outside.
    expect(ids.length).toBe(8);
    expect(ids).toContain('O-1001');
    expect(ids).toContain('O-1008');
    expect(ids).not.toContain('O-1009'); // ageDays=35, outside the window
    expect(ids).not.toContain('O-1010'); // ageDays=60, outside the window
    // Scalar output stored as its string form, matches the array length.
    expect(params['order_count']).toBe('8');

    // The handbook's worked example passes status="failed". The tool only
    // forwards it as a query parameter (the filtering is the fixture
    // server's), so this checks the forwarding: drop it and all 8 come back.
    const failed: Record<string, string> = {};
    const filtered = await executeToolStep(
      {
        name: 'extract_order_ids',
        args: { sinceDays: '30', status: 'failed', baseUrl },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: failed, catalogue },
    );
    expect(filtered.status).toBe('passed');
    expect(JSON.parse(failed['order_ids']!)).toEqual(['O-1003', 'O-1007']);
  });
});
