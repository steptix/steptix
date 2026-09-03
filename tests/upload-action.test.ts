/**
 * The upload action, driven through the real `executeAction` against real
 * Playwright and the real fixture app — stories/upload-action.md §4.
 *
 * These are the behaviours that unit tests cannot prove: that a hidden
 * `<input type="file">` is a legitimate target, that a styled button is clicked
 * and its picker answered, that a visible decoy does not win over the real
 * control, and that a missing file fails before any selector is evaluated.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { executeAction } from '../src/browser/actions.js';
import { logger } from '../src/utils/logger.js';
import type { AIAction } from '../src/ai/types.js';

const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');
/** The base an "Upload file ..." step resolves against in these tests. */
const testDir = path.join(repoRoot, 'fixtures', 'tests');
const uploadPaths = { baseDir: testDir, projectRoot: repoRoot };
const LOGO = 'attachments/logo.png';
const RECEIPT_1 = 'attachments/receipt-1.png';
const RECEIPT_2 = 'attachments/receipt-2.png';

let serverProc: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
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

/** Run one action the way the step executor does. */
function act(
  action: Partial<AIAction> & { action: AIAction['action'] },
  options: Parameters<typeof executeAction>[4] = {},
): ReturnType<typeof executeAction> {
  return executeAction(
    page,
    { description: 'test action', ...action } as AIAction,
    undefined,
    undefined,
    { uploadPaths, ...options },
  );
}

async function rowNames(): Promise<string[]> {
  return page.locator('tr.doc-row').evaluateAll((rows) =>
    rows.map((r) => (r as HTMLElement).dataset['name'] ?? ''));
}

beforeAll(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProc = spawn(process.execPath, ['--import', 'tsx', serverPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr?.on('data', (b: Buffer) => process.stderr.write(`[test-app] ${b.toString()}`));
  await waitForHttp(`${baseUrl}/api/documents`);

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.addInitScript(() => { localStorage.setItem('cookie-consent', 'rejected'); });
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

// ─── The three real uploaders on the fixture page ────────────────────────────

describe('upload against the SecureBank Documents page', () => {
  beforeEach(async () => {
    await fetch(`${baseUrl}/api/documents`, { method: 'DELETE' });
    await page.goto(`${baseUrl}/documents`, { waitUntil: 'domcontentloaded' });
    await page.locator('#documents-empty').waitFor();
  });

  it('the minimum case: a visible file field, one file', async () => {
    const result = await act({ action: 'upload', selector: '#statement-file', filePath: LOGO });
    expect(result.success, result.error).toBe(true);
    expect(result.upload).toEqual({ via: 'input' });

    await page.locator('#statement-upload').click();
    await page.locator('tr.doc-row[data-name="logo.png"]').waitFor();
    expect(await rowNames()).toEqual(['logo.png']);
  }, 30_000);

  it('sets files straight onto a HIDDEN input — the styled-uploader case', async () => {
    expect(await page.locator('#identity-file').isVisible()).toBe(false);

    const result = await act({ action: 'upload', selector: '#identity-file', filePath: LOGO });
    expect(result.success, result.error).toBe(true);
    expect(result.upload).toEqual({ via: 'input' });
    // The page's change handler ran, so the file really landed on the input.
    expect(await page.locator('#identity-selected').textContent()).toContain('logo.png');
  }, 30_000);

  it('the hidden input still works with measurement and the ambiguity gate on', async () => {
    // Regression guard for the measurement hoist: if `singularTargetOf` ever
    // goes back to waiting for `visible`, this times out instead of passing.
    const result = await act(
      { action: 'upload', selector: '#identity-file', filePath: LOGO },
      { measure: true, ambiguousTarget: 'fail' },
    );
    expect(result.success, result.error).toBe(true);
    expect(result.targeting?.matchCount).toBe(1);
  }, 30_000);

  it('clicks a control and answers the picker it opens', async () => {
    const result = await act({ action: 'upload', selector: '#identity-choose', filePath: LOGO });
    expect(result.success, result.error).toBe(true);
    expect(result.upload).toEqual({ via: 'chooser' });
    expect(await page.locator('#identity-selected').textContent()).toContain('logo.png');
  }, 30_000);

  it('sends several files into a multi-file field in one action', async () => {
    const result = await act({
      action: 'upload',
      selector: '#receipts-files',
      filePaths: [RECEIPT_1, RECEIPT_2],
    });
    expect(result.success, result.error).toBe(true);

    await page.locator('#receipts-upload').click();
    await page.locator('tr.doc-row[data-name="receipt-2.png"]').waitFor();
    expect(await rowNames()).toEqual(['receipt-1.png', 'receipt-2.png']);
  }, 30_000);

  it('refuses two files into a single-file field, and stays retryable', async () => {
    const result = await act({
      action: 'upload',
      selector: '#statement-file',
      filePaths: [RECEIPT_1, RECEIPT_2],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('accepts one file but the step gave 2');
    // The model CAN fix this one by splitting the step, so it must not be
    // tagged non-retryable.
    expect(result.retryable).toBeUndefined();
  }, 30_000);

  it('logs the absolute paths it sent', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(logger, 'info').mockImplementation((m: string) => { lines.push(m); });
    try {
      await act({ action: 'upload', selector: '#statement-file', filePath: LOGO });
    } finally {
      spy.mockRestore();
    }
    const line = lines.find((l) => l.startsWith('upload:'));
    expect(line).toBeDefined();
    expect(line).toContain(path.join(testDir, 'attachments', 'logo.png'));
    expect(line).toContain('#statement-file');
  }, 30_000);

  it('reaches an uploader inside an iframe', async () => {
    await page.setContent(
      `<h1>Wrapper</h1><iframe id="docs" src="${baseUrl}/documents" width="1000" height="800"></iframe>`,
    );
    await page.frameLocator('#docs').locator('#identity-choose').waitFor();

    const result = await act({
      action: 'upload',
      frame: '#docs',
      selector: '#identity-choose',
      filePath: LOGO,
    });
    expect(result.success, result.error).toBe(true);
    // `filechooser` is a Page event, so the chooser route works from a frame.
    expect(result.upload).toEqual({ via: 'chooser' });
  }, 30_000);
});

// ─── Target selection, on pages built for the purpose ────────────────────────

describe('upload target selection', () => {
  it('prefers a VISIBLE control over a hidden decoy that comes first', async () => {
    // The decoy bug stories/codebehind-selector-ambiguity.md fixed: the first
    // match in DOM order is a collapsed mobile copy. Taking it would "succeed"
    // while the page showed nothing.
    await page.setContent(`
      <input type="file" name="file" class="decoy" style="display:none">
      <button type="button" name="file" id="real">Choose file</button>
      <input type="file" id="target" style="display:none">
      <script>
        document.getElementById('real').addEventListener('click', () => {
          document.getElementById('target').click();
        });
        document.getElementById('target').addEventListener('change', (e) => {
          document.title = 'chose:' + e.target.files[0].name;
        });
      </script>
    `);

    const result = await act(
      { action: 'upload', selector: '[name="file"]', filePath: LOGO },
      { ambiguousTarget: 'fail' },
    );
    expect(result.success, result.error).toBe(true);
    expect(result.upload).toEqual({ via: 'chooser' });
    expect(await page.title()).toBe('chose:logo.png');
  }, 30_000);

  it('refuses when TWO visible controls match', async () => {
    await page.setContent(`
      <input type="file" name="file">
      <input type="file" name="file">
    `);
    const result = await act(
      { action: 'upload', selector: '[name="file"]', filePath: LOGO },
      { ambiguousTarget: 'fail' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('use a more specific selector');
  }, 30_000);

  it('refuses when two HIDDEN file inputs match and nothing is visible', async () => {
    await page.setContent(`
      <input type="file" name="file" style="display:none">
      <input type="file" name="file" style="display:none">
    `);
    const result = await act(
      { action: 'upload', selector: '[name="file"]', filePath: LOGO },
      { ambiguousTarget: 'fail' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('use a more specific selector');
  }, 30_000);

  it('treats a <label> for a file input as the input, with no picker', async () => {
    await page.setContent(`
      <label for="f" id="lab">Attach a file</label>
      <input type="file" id="f" style="display:none">
      <script>
        document.getElementById('f').addEventListener('change', (e) => {
          document.title = 'via-label:' + e.target.files[0].name;
        });
      </script>
    `);
    const result = await act({ action: 'upload', selector: '#lab', filePath: LOGO });
    expect(result.success, result.error).toBe(true);
    expect(result.upload).toEqual({ via: 'input' });
    expect(await page.title()).toBe('via-label:logo.png');
  }, 30_000);

  it('reports a clear error when clicking the target opens no picker', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await page.setContent('<button id="inert">Does nothing</button>');
      const result = await act(
        { action: 'upload', selector: '#inert', filePath: LOGO },
        // A short budget: the chooser wait is what we are timing out.
        {},
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('did not open a file chooser');
      // Retryable: the model can retarget.
      expect(result.retryable).toBeUndefined();

      // The waiter must have been handled even though it timed out. An
      // unhandled rejection here ends a CLI run under Node's default.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 40_000);

  it('does not treat a hidden NON-file element as a target', async () => {
    await page.setContent('<button id="b" style="display:none">Hidden</button>');
    const result = await act({ action: 'upload', selector: '#b', filePath: LOGO });
    expect(result.success).toBe(false);
    // Playwright's ordinary "not visible" timeout, not a bogus setInputFiles.
    expect(result.error).not.toContain('did not open a file chooser');
  }, 40_000);
});

// ─── Paths: resolved before anything touches the page ────────────────────────

describe('upload paths', () => {
  beforeEach(async () => {
    await page.goto(`${baseUrl}/documents`, { waitUntil: 'domcontentloaded' });
  });

  it('fails a missing file BEFORE evaluating the selector', async () => {
    // The selector does not exist either. If paths were resolved after the
    // prelude, this would report a selector failure (and burn the 10s budget);
    // resolving first means the file is what it complains about.
    const started = Date.now();
    const result = await act({
      action: 'upload',
      selector: '#no-such-element',
      filePath: 'attachments/missing.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Upload file not found');
    expect(result.error).not.toMatch(/timeout|not visible/i);
    expect(result.retryable).toBe(false);
    // No match count either — the retry prompt must not claim "No elements
    // matched this selector" about a file that simply is not there.
    expect(result.matchCount).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 30_000);

  it('fails before the selector under measurement too', async () => {
    const result = await act(
      { action: 'upload', selector: '#no-such-element', filePath: 'attachments/missing.png' },
      { measure: true, ambiguousTarget: 'fail' },
    );
    expect(result.error).toContain('Upload file not found');
    expect(result.retryable).toBe(false);
  }, 30_000);

  it('accepts the backslash spelling the executor sees after interpolation', async () => {
    // A `{{param}}` path is substituted AFTER the parser normalised the action,
    // so the executor is the layer that has to cope with `\attachments\...`.
    const BS = String.fromCharCode(92);
    const result = await act({
      action: 'upload',
      selector: '#statement-file',
      filePath: `${BS}attachments${BS}logo.png`,
    });
    expect(result.success, result.error).toBe(true);
  }, 30_000);

  it('refuses a path that escapes the project', async () => {
    const result = await act({
      action: 'upload',
      selector: '#statement-file',
      filePath: '../../../../../../etc/passwd',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project folder');
    expect(result.retryable).toBe(false);
  }, 30_000);

  it('refuses an upload action carrying no path at all', async () => {
    const result = await act({ action: 'upload', selector: '#statement-file' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires "filePath" or "filePaths"');
  }, 30_000);
});
