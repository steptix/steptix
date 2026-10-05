/**
 * Integration test for the arrays-in-tools pipeline, at its two real ends:
 *
 *   executeAction read multiple: true   →   capturedValues (string[])
 *                            ↓  (stored JSON-encoded — written out here, see below)
 *   `[tool: visit_each urls={{links}}]`   →   tool's `run({ urls })` receives string[]
 *                            ↓
 *   tool loops in TypeScript, captures titles, setVar('titles', titles)
 *                            ↓
 *   resolvedParameters['titles'] = JSON-encoded array, ready for next consumer
 *
 * The storage step in the middle is the step executor's — it JSON-encodes
 * `capturedValues` into the parameter map — and this file does NOT drive it:
 * the tests write the same `JSON.stringify` themselves. The executor's own
 * encoding is pinned by step-executor-placeholders.test.ts ("clears order.*
 * on a plural read, which stores a JSON array"), and the decode at the tool
 * boundary by tool-array-params.test.ts.
 *
 * Real Playwright + the test-app server, same shape as `tool-end-to-end.test.ts`.
 * No AI in the loop — we directly drive the executor primitives so the test
 * is deterministic and cheap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { executeAction } from '../src/browser/actions.js';
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

describe('arrays-in-tools — extract → loop → consume', () => {
  it('read multiple captures every link; visit_each decodes the encoded list and visits each', async () => {
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

    // Stage 2 — the read multiple action captures the list; the storage into
    // the parameter map is written out below, in the step executor's shape.
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
});
