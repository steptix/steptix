/**
 * The fixture app's Documents page and `/api/documents` — the contract other
 * tests stand on. No product code runs here.
 *
 * This began as part 1 of stories/file-upload-steps.md: bare Playwright
 * proving each of the page's uploaders was automatable at all. Part 2 — the
 * upload action — now drives those same uploaders through the product, in
 * upload-action.test.ts, so the bare-Playwright card tests went.
 *
 * What stays is what something else relies on, so that a fixture break fails
 * HERE, by name, instead of as a confusing product or live-suite failure:
 *   - the server's contract (multipart parsing, sha256 fidelity, rejection
 *     messages, DELETE → 204), which upload-action.test.ts and the live
 *     templates reset and assert through;
 *   - the page lines the templates in templates/init/tests/ assert —
 *     securebank-upload.md, securebank-upload-rows.md and
 *     table-documents-empty.md: the success and rejection status lines, the
 *     proof-of-identity card's own Upload button, and "Clear all" leaving the
 *     "No documents uploaded yet." row.
 * Boots `fixtures/test-app/server.ts` through tests/fixture-server.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

const repoRoot = path.resolve(__dirname, '..');
const attachmentsDir = path.join(repoRoot, 'fixtures', 'tests', 'attachments');
const LOGO = path.join(attachmentsDir, 'logo.png');
const RECEIPT_1 = path.join(attachmentsDir, 'receipt-1.png');
const RECEIPT_2 = path.join(attachmentsDir, 'receipt-2.png');
const STATEMENT = path.join(attachmentsDir, 'statement.pdf');
const MALWARE = path.join(attachmentsDir, 'malware.exe');

let server: FixtureServer | undefined;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseUrl: string;
let tmpDir: string;
/** Just over the 1 MB per-file limit; generated, never committed. */
let BIG_PDF: string;

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
  server = await startFixtureServer();
  baseUrl = server.baseUrl;

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
  await server?.stop();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 60_000);

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

// ─── The page lines the templates assert ─────────────────────────────────────

describe('Documents page', () => {
  beforeEach(async () => {
    await page.goto(`${baseUrl}/documents`, { waitUntil: 'domcontentloaded' });
    // Not `#documents-empty`: that row is static markup, there before the
    // page's own first GET returns — and when that GET does return it
    // re-renders the table, wiping a row a test's upload added meanwhile.
    await page.locator('#documents-body[data-loaded="true"]').waitFor({ state: 'attached' });
  });

  it('is served at /documents and linked from every sidebar', async () => {
    expect(await page.title()).toBe('SecureBank — Documents');
    expect(await page.locator('nav a.active').textContent()).toContain('Documents');
    for (const other of ['dashboard.html', 'transactions.html']) {
      const html = await (await fetch(`${baseUrl}/${other}`)).text();
      expect(html, `${other} sidebar`).toContain('href="documents.html"');
    }
  });

  it('a successful upload says what it uploaded: name and size for one file, the count for several', async () => {
    // securebank-upload.md asserts both lines; securebank-upload-rows.md
    // asserts the single-file one with "starts with", because of the size.
    const size = (await fs.stat(LOGO)).size;
    await page.locator('#statement-file').setInputFiles(LOGO);
    await page.locator('#statement-upload').click();
    expect(await statusAfterAction()).toEqual({ state: 'success', text: `Uploaded logo.png (${formatSize(size)})` });

    await page.locator('#receipts-files').setInputFiles([RECEIPT_1, RECEIPT_2]);
    await page.locator('#receipts-upload').click();
    // The status is already `success` from the first upload, so wait on the
    // line itself rather than on the state leaving `idle`.
    const status = page.locator('#upload-status', { hasText: 'Uploaded 2 files' });
    await status.waitFor({ timeout: 10_000 });
    expect(await status.getAttribute('data-state')).toBe('success');
  }, 20_000);

  it('the proof-of-identity card uploads the file its hidden input holds, and lists it', async () => {
    // securebank-upload.md steps 6-7: the styled uploader keeps the chosen
    // file in page state and enables its own Upload button; nothing else here
    // clicks `#identity-upload`.
    const size = (await fs.stat(STATEMENT)).size;
    expect(await page.locator('#identity-upload').isDisabled()).toBe(true);
    await page.locator('#identity-file').setInputFiles(STATEMENT);
    await page.locator('#identity-upload').click();

    expect(await statusAfterAction()).toEqual({ state: 'success', text: `Uploaded statement.pdf (${formatSize(size)})` });
    const row = page.locator('tr.doc-row[data-name="statement.pdf"]');
    await row.waitFor();
    expect(await row.locator('td.doc-type').textContent()).toBe('application/pdf');
  }, 20_000);

  it('a disallowed file is refused by the server and the page says so, adding no row', async () => {
    await page.locator('#statement-file').setInputFiles(MALWARE);
    await page.locator('#statement-upload').click();

    expect(await statusAfterAction()).toEqual({ state: 'error', text: 'malware.exe is not an allowed file type' });
    expect(await rowNames()).toEqual([]);
    expect(await page.locator('#documents-empty').isVisible()).toBe(true);
  }, 20_000);

  it('Clear all empties the table and shows the empty row', async () => {
    await page.locator('#statement-file').setInputFiles(LOGO);
    await page.locator('#statement-upload').click();
    await page.locator('tr.doc-row[data-name="logo.png"]').waitFor();

    await page.locator('#documents-clear').click();
    await page.locator('#documents-empty').waitFor();
    expect(await rowNames()).toEqual([]);
    // table-documents-empty.md reads this lone full-width row as "no data".
    expect(await page.locator('#documents-empty').textContent()).toBe('No documents uploaded yet.');
    expect(await page.locator('#documents-count').textContent()).toBe('0 documents');
    expect(await listDocuments()).toEqual([]);
  }, 20_000);
});
