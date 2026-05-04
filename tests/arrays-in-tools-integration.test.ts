/**
 * End-to-end integration test for the arrays-in-tools pipeline.
 *
 * Exercises the full chain that the user asked for:
 *
 *   read multiple: true   →   resolvedParameters['links'] = JSON-encoded array
 *                            ↓
 *   `[tool: visit_each urls={{links}}]`   →   tool's `run({ urls })` receives string[]
 *                            ↓
 *   tool loops in TypeScript, captures titles, setVar('titles', titles)
 *                            ↓
 *   resolvedParameters['titles'] = JSON-encoded array, ready for next consumer
 *
 * Real Playwright + the test-app server, same shape as `tool-end-to-end.test.ts`.
 * No AI in the loop — we directly drive the executor primitives so the test
 * is deterministic and cheap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { executeAction } from '../src/browser/actions.js';

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
}, 15_000);

describe('arrays-in-tools — extract → loop → consume', () => {
  it('captures every link via read multiple, then visits each in a tool', async () => {
    // Stage 1 — set up a page with three predictable links so we can assert
    // exact behaviour without depending on test-app DOM specifics.
    const linkPaths = ['/dashboard.html', '/transactions.html', '/delegates.html'];
    const linkBlock = linkPaths.map(
      (p) => `<a href="${baseUrl}${p}" data-test="link">${p}</a>`,
    ).join('\n');
    await page.setContent(`
      <html>
        <body>
          <section class="s1">${linkBlock}</section>
        </body>
      </html>
    `);

    // Stage 2 — the read multiple action populates the parameter map exactly
    // the way the runner does. We mimic the step-executor's storage path.
    const params: Record<string, string> = {};
    const readResult = await executeAction(page, {
      action: 'read',
      selector: '.s1 a[data-test="link"]',
      attribute: 'href',
      as: 'section_links',
      multiple: true,
      description: 'Capture every link href',
    });
    expect(readResult.success).toBe(true);
    expect(readResult.capturedValues).toHaveLength(3);
    // Mirror the storage pass that step-executor.ts does on read multiple.
    params['section_links'] = JSON.stringify(readResult.capturedValues);

    // Stage 3 — invoke the visit_each tool with `urls={{section_links}}`.
    // The bridge decodes the JSON-encoded array into a typed string[] for
    // the tool's `run` function.
    const outcome = await executeToolStep(
      {
        name: 'visit_each',
        args: { urls: '{{section_links}}' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: params, catalogue },
    );

    expect(outcome.status).toBe('passed');
    // Tool produced an array output (titles) — round-tripped through the
    // setVar JSON encoder.
    const decodedTitles = JSON.parse(params['titles']!) as string[];
    expect(decodedTitles).toHaveLength(3);
    expect(decodedTitles.every((t) => typeof t === 'string')).toBe(true);
    // visited_count is a scalar number — stored stringified.
    expect(params['visited_count']).toBe('3');
  });

  it('inline `urls=["…","…"]` literal works end-to-end without a captured variable', async () => {
    const params: Record<string, string> = {};
    const inline = `["${baseUrl}/dashboard.html","${baseUrl}/transactions.html"]`;
    const outcome = await executeToolStep(
      {
        name: 'visit_each',
        args: { urls: inline },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: params, catalogue },
    );

    expect(outcome.status).toBe('passed');
    expect(JSON.parse(params['titles']!)).toHaveLength(2);
    expect(params['visited_count']).toBe('2');
  });

  it('an empty captured list flows through cleanly (tool runs, sees length 0)', async () => {
    await page.setContent('<html><body><section></section></body></html>');
    const params: Record<string, string> = {};
    const readResult = await executeAction(page, {
      action: 'read',
      selector: 'section a',
      attribute: 'href',
      as: 'links',
      multiple: true,
      description: 'no matches',
    });
    expect(readResult.capturedValues).toEqual([]);
    params['links'] = JSON.stringify(readResult.capturedValues);

    const outcome = await executeToolStep(
      { name: 'visit_each', args: { urls: '{{links}}' }, outputAliases: {} },
      { page, context, browser, resolvedParameters: params, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(params['visited_count']).toBe('0');
    expect(JSON.parse(params['titles']!)).toEqual([]);
  });

  it('fails fast with a labelled error when caller passes a non-array string', async () => {
    const outcome = await executeToolStep(
      {
        name: 'visit_each',
        args: { urls: 'not-an-array' },
        outputAliases: {},
      },
      { page, context, browser, resolvedParameters: {}, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/parameter "urls".*expected a string\[\]/);
  });
});
