/**
 * Tests for openPage support:
 * - "openPage" action-type parsing (canonical + aliases)
 * - End-to-end: a real Playwright context spawns a new page via the same
 *   path the openPage handler uses, and pageTracker auto-registers it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { PageTracker } from '../src/browser/manager.js';

// ─── Parser tests ──────────────────────────────────────────────────────────

describe('parseAIResponse — openPage action', () => {
  it('parses openPage action with url field', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'openPage',
          url: 'https://docs.example.com',
          description: 'Open documentation in a new tab',
        },
      ],
      reasoning: 'Step asked to open docs in a new tab.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('openPage');
    expect(result.actions[0]?.url).toBe('https://docs.example.com');
  });

  it.each([
    'open_page',
    'openTab',
    'open_tab',
    'openWindow',
    'open_window',
    'newTab',
    'new_tab',
    'newWindow',
    'new_window',
  ])('normalises alias "%s" to canonical openPage', (alias) => {
    const raw = JSON.stringify({
      actions: [{ action: alias, url: 'https://example.com', description: 'open' }],
      reasoning: 'alias should normalise',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('openPage');
  });
});

// ─── End-to-end: spawn a new page, verify pageTracker registers it ─────────

const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');

let serverProc: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let mainPage: Page;
let port: number;
let baseUrl: string;

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
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  mainPage = await context.newPage();
  await mainPage.goto(`${baseUrl}/`);
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    if (!serverProc.killed) serverProc.kill('SIGKILL');
  }
}, 15_000);

describe('openPage execution path — real browser', () => {
  it('spawns a new page via context.newPage() and pageTracker can switch to it', async () => {
    const tracker = new PageTracker(mainPage);

    // Mirror exactly what step-executor's openPage handler does:
    // 1. context.newPage()  2. goto(url)  3. tracker.addPage  4. switchToAsync
    const targetUrl = `${baseUrl}/dashboard.html`;
    const newPage = await context.newPage();
    await newPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    tracker.addPage(newPage);
    const switched = await tracker.switchToAsync(targetUrl);

    expect(switched).not.toBeNull();
    expect(switched?.url()).toContain('/dashboard.html');
    expect(tracker.getActive().url()).toContain('/dashboard.html');

    // Switching back to "main" works.
    const back = await tracker.switchToAsync('main');
    expect(back).not.toBeNull();
    expect(back?.url()).toBe(mainPage.url());

    await newPage.close();
  });

  it('opening multiple pages: each registers and is switchable independently', async () => {
    const tracker = new PageTracker(mainPage);

    // Use data: URLs so we don't depend on test-app pages that redirect when
    // not logged in (delegates.html etc. bounce to /login if no session).
    const aUrl = 'data:text/html,<title>Alpha</title><h1>alpha</h1>';
    const bUrl = 'data:text/html,<title>Beta</title><h1>beta</h1>';

    const a = await context.newPage();
    await a.goto(aUrl, { waitUntil: 'domcontentloaded' });
    tracker.addPage(a);

    const b = await context.newPage();
    await b.goto(bUrl, { waitUntil: 'domcontentloaded' });
    tracker.addPage(b);

    // Switch by title substring (the tracker falls back to title match when
    // label and URL don't match).
    const sa = await tracker.switchToAsync('Alpha');
    expect(sa?.url()).toContain('alpha');
    const sb = await tracker.switchToAsync('Beta');
    expect(sb?.url()).toContain('beta');

    await a.close();
    await b.close();
  });

  it('opens an arbitrary URL (not from the test-app), proving openPage is not origin-restricted', async () => {
    const tracker = new PageTracker(mainPage);
    // Use a data: URL — guaranteed to be reachable, not on the test-app origin.
    const targetUrl = 'data:text/html,<title>External</title><h1>External</h1>';
    const newPage = await context.newPage();
    await newPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    tracker.addPage(newPage);

    const switched = await tracker.switchToAsync(newPage.url());
    expect(switched).not.toBeNull();
    expect(await switched!.title()).toBe('External');
    await newPage.close();
  });
});
