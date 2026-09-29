/**
 * The fixture app's Documents page and `/api/documents` — part 1 of
 * stories/file-upload-steps.md.
 *
 * This is the "an upload is automatable at all" proof that the framework's
 * upload-step support (part 2) will be measured against. Bare Playwright, no
 * AI: `setInputFiles` on the plain field, on the HIDDEN input behind the styled
 * button, through the `filechooser` event, and on the multi-file field — plus
 * the server's own contract (multipart parsing, sha256 fidelity, rejection,
 * clear). Boots `fixtures/test-app/server.ts` the way open-page.test.ts does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');
const attachmentsDir = path.join(repoRoot, 'fixtures', 'tests', 'attachments');
const LOGO = path.join(attachmentsDir, 'logo.png');
const STATEMENT = path.join(attachmentsDir, 'statement.pdf');
const RECEIPT_1 = path.join(attachmentsDir, 'receipt-1.png');
const RECEIPT_2 = path.join(attachmentsDir, 'receipt-2.png');
const MALWARE = path.join(attachmentsDir, 'malware.exe');

let serverProc: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let port: number;
let baseUrl: string;
let tmpDir: string;
/** Just over the 1 MB per-file limit; generated, never committed. */
let BIG_PDF: string;

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

async function sha256Of(file: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/** Mirrors the page's formatSize so size-cell assertions are exact. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileFrom(file: string, type: string): Promise<File> {
  return new File([await fs.readFile(file)], path.basename(file), { type });
}

async function postDocuments(files: File[]): Promise<{ status: number; body: any }> {
  const form = new FormData();
  for (const f of files) form.append('file', f, f.name);
  const res = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

async function listDocuments(): Promise<any[]> {
  const res = await fetch(`${baseUrl}/api/documents`);
  return (await res.json()).documents;
}

async function clearDocuments(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/documents`, { method: 'DELETE' });
  expect(res.status).toBe(204);
}

/** The status region after the page has acted: waits for it to leave `idle`. */
async function statusAfterAction(): Promise<{ state: string; text: string }> {
  const status = page.locator('#upload-status:not([data-state="idle"])');
  await status.waitFor({ timeout: 10_000 });
  return {
    state: (await status.getAttribute('data-state')) ?? '',
    text: (await status.textContent())?.trim() ?? '',
  };
}

async function rowNames(): Promise<string[]> {
  return page.locator('tr.doc-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['name'] ?? ''));
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
  await waitForHttp(`${baseUrl}/api/documents`);

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-upload-'));
  BIG_PDF = path.join(tmpDir, 'big.pdf');
  await fs.writeFile(BIG_PDF, Buffer.alloc(1024 * 1024 + 1, 0x20));

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  // The SecureBank shell shows a cookie banner on first visit; consent it away
  // so it never overlaps a button the tests click.
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
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
}, 15_000);

beforeEach(async () => {
  await clearDocuments();
});

// ─── The API on its own ──────────────────────────────────────────────────────

describe('/api/documents', () => {
  it('stores a binary upload byte-for-byte: name, size, type and sha256 match the file on disk', async () => {
    const { status, body } = await postDocuments([await fileFrom(LOGO, 'image/png')]);
    expect(status).toBe(201);
    expect(body.documents).toHaveLength(1);
    const doc = body.documents[0];
    const bytes = await fs.readFile(LOGO);
    expect(doc).toMatchObject({ name: 'logo.png', size: bytes.length, type: 'image/png' });
    expect(doc.sha256).toBe(await sha256Of(LOGO));
    expect(doc.id).toMatch(/^doc-\d{3}$/);
    expect(() => new Date(doc.uploadedAt).toISOString()).not.toThrow();

    expect(await listDocuments()).toEqual([doc]);
  });

  it('accepts several files in one request, oldest first, each with its own hash', async () => {
    const { status, body } = await postDocuments([
      await fileFrom(RECEIPT_1, 'image/png'),
      await fileFrom(RECEIPT_2, 'image/png'),
    ]);
    expect(status).toBe(201);
    expect(body.documents.map((d: any) => d.name)).toEqual(['receipt-1.png', 'receipt-2.png']);
    expect(body.documents[0].sha256).toBe(await sha256Of(RECEIPT_1));
    expect(body.documents[1].sha256).toBe(await sha256Of(RECEIPT_2));
    expect(body.documents[0].sha256).not.toBe(body.documents[1].sha256);
    expect((await listDocuments()).map((d) => d.name)).toEqual(['receipt-1.png', 'receipt-2.png']);
  });

  it('rejects a disallowed extension with 400 and the exact message, adding nothing', async () => {
    const { status, body } = await postDocuments([await fileFrom(MALWARE, 'application/octet-stream')]);
    expect(status).toBe(400);
    expect(body.error).toBe('malware.exe is not an allowed file type');
    expect(await listDocuments()).toEqual([]);
  });

  it('rejects a file over 1 MB with 413 and the exact message, adding nothing', async () => {
    const { status, body } = await postDocuments([await fileFrom(BIG_PDF, 'application/pdf')]);
    expect(status).toBe(413);
    expect(body.error).toBe('big.pdf is larger than the 1 MB limit');
    expect(await listDocuments()).toEqual([]);
  });

  it('a batch is all-or-nothing: one bad part rejects the good ones too', async () => {
    const { status } = await postDocuments([
      await fileFrom(LOGO, 'image/png'),
      await fileFrom(MALWARE, 'application/octet-stream'),
    ]);
    expect(status).toBe(400);
    expect(await listDocuments()).toEqual([]);
  });

  it('a multipart request with no file part is "Choose a file first"', async () => {
    const form = new FormData();
    form.append('note', 'no file here');
    const res = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Choose a file first');
  });

  it('a non-multipart body is refused rather than parsed', async () => {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'logo.png' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Expected a multipart/form-data body');
  });

  it('a client-supplied path in the filename is reduced to the bare name', async () => {
    // Hand-built body: browsers never send a path, but the parser must not
    // trust that. Also exercises the parser on a body fetch() did not build.
    const boundary = 'steptix-test-boundary';
    const bytes = await fs.readFile(LOGO);
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="C:\\Users\\someone\\Pictures\\logo.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, bytes, tail]),
    });
    expect(res.status).toBe(201);
    const doc = (await res.json()).documents[0];
    expect(doc.name).toBe('logo.png');
    expect(doc.size).toBe(bytes.length);
    expect(doc.sha256).toBe(await sha256Of(LOGO));
  });

  it('DELETE empties the list and answers 204', async () => {
    await postDocuments([await fileFrom(LOGO, 'image/png')]);
    expect(await listDocuments()).toHaveLength(1);
    await clearDocuments();
    expect(await listDocuments()).toEqual([]);
  });
});

// ─── The page, driven with bare Playwright ───────────────────────────────────

describe('Documents page', () => {
  beforeEach(async () => {
    await page.goto(`${baseUrl}/documents`, { waitUntil: 'domcontentloaded' });
    await page.locator('#documents-empty').waitFor();
  });

  it('is served at /documents and linked from every sidebar', async () => {
    expect(await page.title()).toBe('SecureBank — Documents');
    expect(await page.locator('nav a.active').textContent()).toContain('Documents');
    for (const other of ['dashboard.html', 'transactions.html']) {
      const html = await (await fetch(`${baseUrl}/${other}`)).text();
      expect(html, `${other} sidebar`).toContain('href="documents.html"');
    }
  });

  it('card 1 — the plain visible field: setInputFiles, Upload, row appears', async () => {
    await page.locator('#statement-file').setInputFiles(LOGO);
    await page.locator('#statement-upload').click();

    const status = await statusAfterAction();
    const size = (await fs.stat(LOGO)).size;
    expect(status).toEqual({ state: 'success', text: `Uploaded logo.png (${formatSize(size)})` });

    const row = page.locator('tr.doc-row[data-name="logo.png"]');
    await row.waitFor();
    expect(await row.locator('td.doc-size').textContent()).toBe(formatSize(size));
    expect(await row.locator('td.doc-type').textContent()).toBe('image/png');
    expect(await row.getAttribute('data-sha256')).toBe(await sha256Of(LOGO));
    expect(await page.locator('#documents-count').textContent()).toBe('1 document');
    // The field is cleared after a successful upload, so a second submit
    // would be "Choose a file first", not a silent re-upload.
    expect(await page.locator('#statement-file').inputValue()).toBe('');
  }, 20_000);

  it('card 2 — the hidden input behind the styled button accepts setInputFiles directly', async () => {
    const input = page.locator('#identity-file');
    expect(await input.isVisible()).toBe(false);
    expect(await page.locator('#identity-upload').isDisabled()).toBe(true);

    await input.setInputFiles(STATEMENT);

    const size = (await fs.stat(STATEMENT)).size;
    expect(await page.locator('#identity-selected').textContent()).toBe(`statement.pdf (${formatSize(size)})`);
    expect(await page.locator('#identity-upload').isDisabled()).toBe(false);
    await page.locator('#identity-upload').click();

    expect(await statusAfterAction()).toEqual({ state: 'success', text: `Uploaded statement.pdf (${formatSize(size)})` });
    const row = page.locator('tr.doc-row[data-name="statement.pdf"]');
    await row.waitFor();
    expect(await row.locator('td.doc-type').textContent()).toBe('application/pdf');
    // Reset after success: the styled uploader is ready for the next file.
    expect(await page.locator('#identity-selected').textContent()).toBe('');
    expect(await page.locator('#identity-upload').isDisabled()).toBe(true);
  }, 20_000);

  it('card 2 — clicking Choose file opens a file chooser that can be answered', async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10_000 }),
      page.locator('#identity-choose').click(),
    ]);
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles(LOGO);

    expect(await page.locator('#identity-selected').textContent()).toContain('logo.png');
    await page.locator('#identity-upload').click();
    expect((await statusAfterAction()).state).toBe('success');
    expect(await rowNames()).toEqual(['logo.png']);
  }, 20_000);

  it('card 3 — the multiple field sends both files in one request', async () => {
    await page.locator('#receipts-files').setInputFiles([RECEIPT_1, RECEIPT_2]);
    await page.locator('#receipts-upload').click();

    expect(await statusAfterAction()).toEqual({ state: 'success', text: 'Uploaded 2 files' });
    await page.locator('tr.doc-row[data-name="receipt-2.png"]').waitFor();
    expect(await rowNames()).toEqual(['receipt-1.png', 'receipt-2.png']);
    expect(await page.locator('#documents-count').textContent()).toBe('2 documents');
    expect(await listDocuments()).toHaveLength(2);
  }, 20_000);

  it('a disallowed file is refused by the server and the page says so, adding no row', async () => {
    await page.locator('#statement-file').setInputFiles(MALWARE);
    await page.locator('#statement-upload').click();

    expect(await statusAfterAction()).toEqual({ state: 'error', text: 'malware.exe is not an allowed file type' });
    expect(await rowNames()).toEqual([]);
    expect(await page.locator('#documents-empty').isVisible()).toBe(true);
  }, 20_000);

  it('an oversized file is refused with the size message', async () => {
    await page.locator('#statement-file').setInputFiles(BIG_PDF);
    await page.locator('#statement-upload').click();

    expect(await statusAfterAction()).toEqual({ state: 'error', text: 'big.pdf is larger than the 1 MB limit' });
    expect(await rowNames()).toEqual([]);
  }, 20_000);

  it('submitting with nothing chosen is "Choose a file first"', async () => {
    await page.locator('#statement-upload').click();
    expect(await statusAfterAction()).toEqual({ state: 'error', text: 'Choose a file first' });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#receipts-upload').click();
    expect(await statusAfterAction()).toEqual({ state: 'error', text: 'Choose a file first' });
  }, 20_000);

  it('Clear all empties the table and shows the empty row', async () => {
    await page.locator('#statement-file').setInputFiles(LOGO);
    await page.locator('#statement-upload').click();
    await page.locator('tr.doc-row[data-name="logo.png"]').waitFor();

    await page.locator('#documents-clear').click();
    await page.locator('#documents-empty').waitFor();
    expect(await rowNames()).toEqual([]);
    expect(await page.locator('#documents-count').textContent()).toBe('0 documents');
    expect(await listDocuments()).toEqual([]);
  }, 20_000);

  it('the list is the server\'s: a reload shows what was uploaded before it', async () => {
    await postDocuments([await fileFrom(RECEIPT_1, 'image/png')]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('tr.doc-row[data-name="receipt-1.png"]').waitFor();
    expect(await rowNames()).toEqual(['receipt-1.png']);
  }, 20_000);
});
