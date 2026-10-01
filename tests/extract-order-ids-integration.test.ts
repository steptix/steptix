/**
 * End-to-end integration test for "tool returns an array".
 *
 *   test-app `/api/orders`         ──┐
 *                                    ├──► extract_order_ids tool
 *                                    │     ├── step.setVar('order_ids', string[])
 *                                    │     └── step.setVar('order_count', number)
 *                                    │
 *   resolvedParameters['order_ids']  │  ◄── JSON-encoded array in storage
 *                                    │
 *   `[tool: refund_each ids="{{order_ids}}"]` (downstream consumer)
 *                                    │
 *   refund_each tool                 ◄──── receives typed string[] via bridge
 *
 * No AI in the loop — we drive the executor primitives directly so the
 * test stays fast and deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { defineTool } from '../src/tools/define-tool.js';
import type { ToolDefinition } from '../src/tools/types.js';

const repoRoot = path.resolve(__dirname, '..');
const toolsDir = path.join(repoRoot, 'fixtures', 'tools', 'src');
const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');

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
        srv.close(() => reject(new Error('port allocation failed')));
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
    } catch { /* not ready */ }
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

  catalogue = await loadToolCatalogue(toolsDir);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    if (!serverProc.killed) serverProc.kill('SIGKILL');
  }
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
  });

  it('honours the status filter — failed orders only', async () => {
    const params: Record<string, string> = {};
    const outcome = await executeToolStep(
      {
        name: 'extract_order_ids',
        args: { sinceDays: '30', status: 'failed', baseUrl },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: params, catalogue },
    );

    expect(outcome.status).toBe('passed');
    expect(JSON.parse(params['order_ids']!)).toEqual(['O-1003', 'O-1007']);
    expect(params['order_count']).toBe('2');
  });

  it('output aliases route results into different variables (no overwrite)', async () => {
    // Mirrors the worked-example markdown: call the tool twice with
    // different filters, alias the second call's outputs so the first
    // call's results survive.
    const params: Record<string, string> = {};

    const all = await executeToolStep(
      {
        name: 'extract_order_ids',
        args: { sinceDays: '30', baseUrl },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: params, catalogue },
    );
    expect(all.status).toBe('passed');

    const failed = await executeToolStep(
      {
        name: 'extract_order_ids',
        args: { sinceDays: '30', status: 'failed', baseUrl },
        outputAliases: { order_ids: 'failed_ids', order_count: 'failed_count' },
      },
      { page, context, browser, resolvedParameters: params, catalogue },
    );
    expect(failed.status).toBe('passed');

    // First-call results untouched (8 orders within the 30-day window).
    expect(JSON.parse(params['order_ids']!).length).toBe(8);
    expect(params['order_count']).toBe('8');
    // Aliased outputs from the second call landed under the new names.
    expect(JSON.parse(params['failed_ids']!)).toEqual(['O-1003', 'O-1007']);
    expect(params['failed_count']).toBe('2');
  });

  it("the emitted array piped into a downstream tool decodes back to a typed string[]", async () => {
    // Stage A: produce the array via extract_order_ids.
    const params: Record<string, string> = {};
    const a = await executeToolStep(
      {
        name: 'extract_order_ids',
        args: { sinceDays: '30', status: 'failed', baseUrl },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: params, catalogue },
    );
    expect(a.status).toBe('passed');

    // Stage B: a sink tool registered ad-hoc for the test, declares
    // `ids: 'string[]'`. Receives a real array and asserts shape.
    let received: string[] | undefined;
    const sink: ToolDefinition = defineTool({
      name: 'order-sink',
      parameters: { ids: { type: 'string[]' } },
      outputs: {},
      run: ({ ids }) => {
        received = ids;
      },
    });

    const b = await executeToolStep(
      { name: 'order-sink', args: { ids: '{{order_ids}}' }, outputAliases: {} },
      {
        page,
        context,
        browser,
        resolvedParameters: params,
        catalogue: {
          resolve: async (n: string) => {
            if (n === 'order-sink') return { definition: sink };
            throw new Error(`unknown tool ${n}`);
          },
          require: (n: string) => {
            if (n === 'order-sink') return { definition: sink };
            throw new Error(`unknown tool ${n}`);
          },
          has: (n: string) => n === 'order-sink',
        } as never,
      },
    );

    expect(b.status).toBe('passed');
    expect(received).toEqual(['O-1003', 'O-1007']);
    expect(Array.isArray(received)).toBe(true);
  });
});
