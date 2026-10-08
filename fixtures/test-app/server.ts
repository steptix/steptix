/**
 * Fixture test app server.
 *
 * Serves the static HTML files AND provides API endpoints for API testing.
 * Run with: npx tsx fixtures/test-app/server.ts
 *
 * Endpoints:
 *   Static HTML:
 *     GET /          → index.html (login page)
 *     GET /*.html    → static pages
 *
 *   API:
 *     GET  /api/csrf-token         → returns a CSRF token for the current session
 *     GET  /api/delegates          → returns all delegates (requires session cookie)
 *     GET  /api/delegates/:id      → returns a single delegate
 *     PUT  /api/delegates/:id      → updates a delegate (requires CSRF token)
 *     GET  /api/notifications      → returns notifications (requires x-api-key)
 *
 *   Iframe test page:
 *     GET /iframes                  → parent page with 3 iframes
 *     GET /iframe/banner            → top navigation banner (iframe 1)
 *     GET /iframe/sidebar/:category → sidebar options (iframe 2)
 *     GET /iframe/content/:cat/:item → main content (iframe 3)
 *
 *   Nested iframe test page (2 levels deep):
 *     GET /nested-iframes                  → wealth dashboard with 1 iframe (advisor-frame)
 *     GET /iframe/nested/advisor            → advisor portal with 2 nested iframes
 *     GET /iframe/nested/chat               → chat widget (nested inside advisor)
 *     GET /iframe/nested/recommendations    → recommendations panel (nested inside advisor)
 *
 *   New window / tab test page:
 *     GET /new-window          → page with buttons to open a new window and a new tab
 *     GET /new-window/popup    → content served in the new window (popup)
 *     GET /new-window/tab      → content served in the new tab
 *
 *   Documents (file upload) test page — stories/file-upload-steps.md:
 *     GET    /documents        → page with a plain file field, a styled uploader
 *                                whose <input type="file"> is hidden, and a
 *                                multi-file field. No login required.
 *     GET    /api/documents    → every document uploaded since the last clear
 *     POST   /api/documents    → multipart/form-data, field name `file` (repeatable).
 *                                Rejects disallowed extensions (400) and files
 *                                over 1 MB (413); a batch is all-or-nothing.
 *     DELETE /api/documents    → clears the list, so concurrent runs can isolate
 *                                themselves without restarting the server.
 *
 *   Control flow test page — stories/control-flow.md:
 *     GET    /control-flow     → payment-method checkboxes (If / Else if /
 *                                Otherwise), a four-page statement list whose
 *                                Next button disables on the last page (While),
 *                                a Load more button that removes itself on its
 *                                third click (Repeat … until), and three named
 *                                accounts with balances (capture + For each).
 *                                All state is client-side, so it resets on load
 *                                and concurrent shards cannot disturb one another.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { listenFetchable } from '../../tests/listen-fetchable.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env['PORT'] ?? 8787);
const API_KEY = process.env['NOTIFICATIONS_API_KEY'] ?? 'test-api-key-fixture';

// ─── In-memory state ──────────────────────────────────────────────────────────

const delegates = [
  { id: 'del-001', name: 'Alice Johnson', email: 'alice@example.com', mobile: '0411111111', status: 'active' },
  { id: 'del-002', name: 'Bob Smith', email: 'bob@example.com', mobile: '0422222222', status: 'active' },
  { id: 'del-003', name: 'Carol White', email: 'carol@example.com', mobile: '0433333333', status: 'inactive' },
];

const notifications = [
  { id: 'notif-001', message: 'Account balance alert', recipientId: 'user-001', createdAt: '2026-03-27T10:00:00Z' },
  { id: 'notif-002', message: 'Transaction completed', recipientId: 'user-001', createdAt: '2026-03-27T09:00:00Z' },
];

// Orders fixture — used by the `extract_order_ids` tool demo. Each order has
// an `ageDays` so the `/api/orders?sinceDays=N` endpoint can return only
// orders newer than the requested window. Order status varies so a downstream
// "refund only the failed ones" filter has something to work with.
const orders = [
  { id: 'O-1001', status: 'paid',     amount: 4200, ageDays: 1 },
  { id: 'O-1002', status: 'paid',     amount: 1850, ageDays: 2 },
  { id: 'O-1003', status: 'failed',   amount: 999,  ageDays: 3 },
  { id: 'O-1004', status: 'refunded', amount: 250,  ageDays: 5 },
  { id: 'O-1005', status: 'paid',     amount: 3300, ageDays: 7 },
  { id: 'O-1006', status: 'paid',     amount: 720,  ageDays: 9 },
  { id: 'O-1007', status: 'failed',   amount: 1200, ageDays: 12 },
  { id: 'O-1008', status: 'paid',     amount: 5800, ageDays: 20 },
  { id: 'O-1009', status: 'paid',     amount: 410,  ageDays: 35 },
  { id: 'O-1010', status: 'paid',     amount: 90,   ageDays: 60 },
];

// CSRF token store: maps session-id → token
const csrfTokens = new Map<string, string>();

// Valid session IDs (populated on login)
const validSessions = new Set<string>();

// ─── Documents (file upload) ──────────────────────────────────────────────────

interface DocumentRecord {
  id: string;
  name: string;
  size: number;
  /** The MIME type the client sent for the part — what the browser inferred. */
  type: string;
  sha256: string;
  uploadedAt: string;
}

/** Uploaded documents, oldest first. Bytes are hashed and dropped, never kept. */
const documents: DocumentRecord[] = [];
let documentSeq = 0;

const DOCUMENT_ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.csv']);
const DOCUMENT_MAX_BYTES = 1024 * 1024;
/** Cap on the whole multipart request, so a runaway upload cannot pin the fixture. */
const DOCUMENT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k && v !== undefined) result[k.trim()] = decodeURIComponent(v.trim());
  }
  return result;
}

function getSessionId(req: http.IncomingMessage): string | undefined {
  const cookieHeader = req.headers['cookie'] ?? '';
  const cookies = parseCookies(cookieHeader);
  return cookies['session'];
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res: http.ServerResponse): void {
  json(res, 404, { error: 'Not found' });
}

function unauthorized(res: http.ServerResponse, message = 'Unauthorized'): void {
  json(res, 401, { error: message });
}

class BodyTooLarge extends Error {}

/**
 * Read the raw request body into a Buffer. `parseBody` above is JSON-only and
 * must not be used for multipart. Past `limit` the rest is drained and
 * discarded, so the 413 can still be written on a live socket.
 */
function readRawBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (tooLarge) return;
      if (total > limit) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new BodyTooLarge(`Request body exceeds ${limit} bytes`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

interface MultipartPart {
  name: string;
  /** Present for file parts only. */
  filename?: string;
  contentType: string;
  data: Buffer;
}

/**
 * Minimal multipart/form-data parser: enough for what browsers and Node's
 * FormData send, with no dependency. Each part is
 * `--boundary CRLF headers CRLF CRLF data CRLF`, and the body ends with
 * `--boundary--`. Data is sliced by byte offsets so binary parts survive.
 */
function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let pos = body.indexOf(delimiter);
  if (pos < 0) return parts;
  for (;;) {
    pos += delimiter.length;
    // The closing delimiter is `--boundary--`.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headersEnd = body.indexOf('\r\n\r\n', pos);
    if (headersEnd < 0) throw new Error('Malformed multipart body: part headers never end');
    const headers = body.subarray(pos, headersEnd).toString('utf8');
    const dataStart = headersEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next < 0) throw new Error('Malformed multipart body: unterminated part');
    // The part's data is followed by CRLF, then the next delimiter.
    const data = body.subarray(dataStart, Math.max(dataStart, next - 2));
    const disposition = /content-disposition:\s*([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? '';
    const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition);
    const contentType = /content-type:\s*([^\r\n]*)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream';
    const part: MultipartPart = { name, contentType, data };
    if (filenameMatch) part.filename = filenameMatch[1];
    parts.push(part);
    pos = next;
  }
  return parts;
}

/** The stored name is the bare file name — a client-supplied path is dropped. */
function documentName(filename: string | undefined): string {
  const base = (filename ?? '').split(/[\\/]/).pop() ?? '';
  return base || 'unnamed';
}

/**
 * Extensions served as BYTES rather than text.
 *
 * The text branch below reads `utf-8`, which is right for the HTML/JS/CSS this
 * app is made of and wrong for anything else: a `%PDF-…` file round-tripped
 * through a utf-8 decode comes back with every byte above 0x7F replaced by
 * U+FFFD, so the response is the right length in characters and the wrong file.
 * Chromium's viewer then shows "Failed to load PDF document" and the
 * computer-mode fixtures (templates/init/tests/pdf-*.md) have no toolbar to
 * click. So the type map decides the READ MODE as well as the header.
 */
const binaryTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function serveStatic(res: http.ServerResponse, filePath: string): void {
  try {
    const ext = path.extname(filePath).toLowerCase();

    const binaryType = binaryTypes[ext];
    if (binaryType) {
      const bytes = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': binaryType,
        'Content-Length': bytes.length,
      });
      res.end(bytes);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const contentType = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'application/javascript'
        : ext === '.css' ? 'text/css'
          : 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    notFound(res);
  }
}

// ─── Iframe content generator ─────────────────────────────────────────────────

const iframeBaseStyle = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  a { text-decoration: none; color: inherit; }
`;

const sidebarItems: Record<string, { label: string; items: { id: string; label: string; icon: string }[] }> = {
  accounts: {
    label: 'Accounts',
    items: [
      { id: 'overview', label: 'Overview', icon: '\u{1F4CA}' },
      { id: 'savings', label: 'Savings Account', icon: '\u{1F4B0}' },
      { id: 'checking', label: 'Checking Account', icon: '\u{1F4B3}' },
      { id: 'credit-card', label: 'Credit Card', icon: '\u{1F4B3}' },
    ],
  },
  payments: {
    label: 'Payments',
    items: [
      { id: 'transfer', label: 'Transfer Money', icon: '\u{1F4E4}' },
      { id: 'pay-bills', label: 'Pay Bills', icon: '\u{1F4DD}' },
      { id: 'scheduled', label: 'Scheduled Payments', icon: '\u{1F4C5}' },
    ],
  },
  support: {
    label: 'Support',
    items: [
      { id: 'faq', label: 'FAQs', icon: '\u{2753}' },
      { id: 'contact', label: 'Contact Us', icon: '\u{2709}\uFE0F' },
      { id: 'report', label: 'Report Issue', icon: '\u{26A0}\uFE0F' },
    ],
  },
};

function wrapIframeHtml(title: string, extraStyle: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${iframeBaseStyle}${extraStyle}</style>
</head>
<body>${body}</body>
</html>`;
}

function generateBannerHtml(): string {
  const categories = [
    { id: 'accounts', label: 'Accounts', defaultItem: 'overview' },
    { id: 'payments', label: 'Payments', defaultItem: 'transfer' },
    { id: 'support', label: 'Support', defaultItem: 'faq' },
  ];

  const style = `
    body { background: #1f2937; color: #f9fafb; height: 64px; display: flex; align-items: center; }
    .banner { display: flex; align-items: center; width: 100%; padding: 0 24px; gap: 32px; }
    .logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; }
    .logo-icon { width: 32px; height: 32px; background: #1a56db; border-radius: 7px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
    nav { display: flex; gap: 4px; }
    .nav-link {
      padding: 8px 18px; border-radius: 6px; font-size: 14px; font-weight: 500;
      cursor: pointer; transition: background 0.15s; color: #d1d5db; border: none; background: none;
    }
    .nav-link:hover { background: #374151; color: #fff; }
    .nav-link.active { background: #1a56db; color: #fff; }
  `;

  const links = categories.map(c =>
    `<button class="nav-link${c.id === 'accounts' ? ' active' : ''}" data-category="${c.id}" data-default="${c.defaultItem}">${c.label}</button>`
  ).join('\n      ');

  const body = `
  <div class="banner">
    <div class="logo">
      <div class="logo-icon">SB</div>
      SecureBank Portal
    </div>
    <nav aria-label="Main navigation">
      ${links}
    </nav>
  </div>
  <script>
    let activeBtn = document.querySelector('.nav-link.active');
    document.querySelectorAll('.nav-link').forEach(btn => {
      btn.addEventListener('click', () => {
        if (activeBtn) activeBtn.classList.remove('active');
        btn.classList.add('active');
        activeBtn = btn;
        window.parent.postMessage({
          type: 'banner-navigate',
          category: btn.dataset.category,
          defaultItem: btn.dataset.default
        }, '*');
      });
    });
  </script>`;

  return wrapIframeHtml('SecureBank — Banner', style, body);
}

function generateSidebarHtml(category: string): string | null {
  const cat = sidebarItems[category];
  if (!cat) return null;

  const style = `
    body { background: #f9fafb; height: 100%; }
    .sidebar { padding: 16px 0; }
    .sidebar-title { padding: 8px 20px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 20px; font-size: 14px; color: #374151;
      cursor: pointer; transition: background 0.15s; border: none; background: none;
      width: 100%; text-align: left;
    }
    .nav-item:hover { background: #e5e7eb; }
    .nav-item.active { background: #dbeafe; color: #1a56db; font-weight: 600; }
    .nav-item-icon { font-size: 16px; width: 24px; text-align: center; }
  `;

  const items = cat.items.map((item, i) =>
    `<button class="nav-item${i === 0 ? ' active' : ''}" data-item="${item.id}" data-category="${category}">
        <span class="nav-item-icon">${item.icon}</span>
        ${item.label}
      </button>`
  ).join('\n      ');

  const body = `
  <div class="sidebar">
    <div class="sidebar-title">${cat.label}</div>
    ${items}
  </div>
  <script>
    let activeItem = document.querySelector('.nav-item.active');
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        if (activeItem) activeItem.classList.remove('active');
        btn.classList.add('active');
        activeItem = btn;
        window.parent.postMessage({
          type: 'sidebar-navigate',
          category: btn.dataset.category,
          item: btn.dataset.item
        }, '*');
      });
    });
  </script>`;

  return wrapIframeHtml(`SecureBank — ${cat.label}`, style, body);
}

function generateContentHtml(category: string, item: string): string | null {
  const contentMap: Record<string, Record<string, { title: string; html: string }>> = {
    accounts: {
      overview: {
        title: 'Account Overview',
        html: `
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-label">Total Balance</div>
              <div class="stat-value">$24,582.90</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Savings</div>
              <div class="stat-value">$18,230.50</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Checking</div>
              <div class="stat-value">$3,852.40</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Credit Available</div>
              <div class="stat-value">$2,500.00</div>
            </div>
          </div>
          <div class="card">
            <h3>Quick Actions</h3>
            <div class="button-group">
              <button class="btn btn-primary" id="btn-view-all" onclick="document.getElementById('details-panel').style.display='block'; this.textContent='Viewing All Accounts';">View All Accounts</button>
              <button class="btn btn-secondary" id="btn-download" onclick="this.textContent='Downloaded!'; this.disabled=true;">Download Statement</button>
            </div>
            <div id="details-panel" style="display:none; margin-top: 16px;">
              <table class="data-table">
                <thead><tr><th>Account</th><th>Number</th><th>Balance</th><th>Status</th></tr></thead>
                <tbody>
                  <tr><td>Savings Plus</td><td>****4821</td><td>$18,230.50</td><td><span class="badge badge-green">Active</span></td></tr>
                  <tr><td>Everyday Checking</td><td>****7733</td><td>$3,852.40</td><td><span class="badge badge-green">Active</span></td></tr>
                  <tr><td>Platinum Card</td><td>****9102</td><td>-$2,500.00</td><td><span class="badge badge-green">Active</span></td></tr>
                </tbody>
              </table>
            </div>
          </div>`,
      },
      savings: {
        title: 'Savings Account',
        html: `
          <div class="card">
            <div class="account-header">
              <div>
                <div class="stat-label">Savings Plus &mdash; ****4821</div>
                <div class="stat-value">$18,230.50</div>
              </div>
              <span class="badge badge-green">Active</span>
            </div>
            <div class="info-row"><span>Interest Rate:</span><strong>4.25% p.a.</strong></div>
            <div class="info-row"><span>Last Interest Paid:</span><strong>$64.12 on Mar 1</strong></div>
          </div>
          <div class="card">
            <h3>Recent Transactions</h3>
            <div id="savings-txns">
              <table class="data-table">
                <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
                <tbody>
                  <tr><td>Mar 28</td><td>Transfer from Checking</td><td class="amount-positive">+$500.00</td></tr>
                  <tr><td>Mar 25</td><td>Interest Payment</td><td class="amount-positive">+$64.12</td></tr>
                  <tr><td>Mar 20</td><td>Withdrawal</td><td class="amount-negative">-$200.00</td></tr>
                </tbody>
              </table>
            </div>
            <button class="btn btn-secondary" id="btn-load-more" onclick="
              const tbody = document.querySelector('#savings-txns tbody');
              const rows = '<tr><td>Mar 15</td><td>Deposit</td><td class=\\'amount-positive\\'>+$1,200.00</td></tr><tr><td>Mar 10</td><td>Withdrawal</td><td class=\\'amount-negative\\'>-$350.00</td></tr>';
              tbody.insertAdjacentHTML('beforeend', rows);
              this.textContent = 'All transactions loaded';
              this.disabled = true;
            ">Load More</button>
          </div>`,
      },
      checking: {
        title: 'Checking Account',
        html: `
          <div class="card">
            <div class="account-header">
              <div>
                <div class="stat-label">Everyday Checking &mdash; ****7733</div>
                <div class="stat-value">$3,852.40</div>
              </div>
              <span class="badge badge-green">Active</span>
            </div>
            <div class="info-row"><span>Monthly Fee:</span><strong>$0.00 (waived)</strong></div>
            <div class="info-row"><span>Pending Transactions:</span><strong>2</strong></div>
          </div>
          <div class="card">
            <h3>Recent Transactions</h3>
            <div class="filter-bar">
              <label for="txn-filter">Filter:</label>
              <select id="txn-filter" onchange="filterCheckingTxns(this.value)">
                <option value="all">All</option>
                <option value="debit">Debits Only</option>
                <option value="credit">Credits Only</option>
              </select>
            </div>
            <table class="data-table" id="checking-table">
              <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Amount</th></tr></thead>
              <tbody>
                <tr data-type="debit"><td>Mar 29</td><td>Grocery Mart</td><td>Debit</td><td class="amount-negative">-$87.32</td></tr>
                <tr data-type="debit"><td>Mar 28</td><td>Electric Company</td><td>Debit</td><td class="amount-negative">-$142.00</td></tr>
                <tr data-type="credit"><td>Mar 27</td><td>Salary Deposit</td><td>Credit</td><td class="amount-positive">+$3,200.00</td></tr>
                <tr data-type="debit"><td>Mar 26</td><td>Coffee Shop</td><td>Debit</td><td class="amount-negative">-$5.80</td></tr>
                <tr data-type="credit"><td>Mar 25</td><td>Refund &mdash; Online Store</td><td>Credit</td><td class="amount-positive">+$29.99</td></tr>
              </tbody>
            </table>
          </div>
          <script>
            function filterCheckingTxns(type) {
              const rows = document.querySelectorAll('#checking-table tbody tr');
              rows.forEach(row => {
                if (type === 'all') { row.style.display = ''; }
                else { row.style.display = row.dataset.type === type ? '' : 'none'; }
              });
            }
          </script>`,
      },
      'credit-card': {
        title: 'Credit Card',
        html: `
          <div class="card">
            <div class="credit-card-visual">
              <div class="cc-chip"></div>
              <div class="cc-number">**** **** **** 9102</div>
              <div class="cc-details">
                <div><span class="cc-label">Card Holder</span><br>DEMO USER</div>
                <div><span class="cc-label">Expires</span><br>09/28</div>
              </div>
            </div>
          </div>
          <div class="stats-grid cols-3">
            <div class="stat-card"><div class="stat-label">Current Balance</div><div class="stat-value">$2,500.00</div></div>
            <div class="stat-card"><div class="stat-label">Credit Limit</div><div class="stat-value">$5,000.00</div></div>
            <div class="stat-card"><div class="stat-label">Available Credit</div><div class="stat-value">$2,500.00</div></div>
          </div>
          <div class="card">
            <h3>Recent Charges</h3>
            <table class="data-table">
              <thead><tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                <tr><td>Mar 28</td><td>Online Store</td><td class="amount-negative">-$149.99</td><td><span class="badge badge-green">Posted</span></td></tr>
                <tr><td>Mar 27</td><td>Restaurant</td><td class="amount-negative">-$52.30</td><td><span class="badge badge-green">Posted</span></td></tr>
                <tr><td>Mar 26</td><td>Gas Station</td><td class="amount-negative">-$41.20</td><td><span class="badge badge-yellow">Pending</span></td></tr>
              </tbody>
            </table>
            <button class="btn btn-primary" id="btn-pay-balance" onclick="
              document.getElementById('pay-form').style.display = document.getElementById('pay-form').style.display === 'none' ? 'block' : 'none';
            ">Pay Balance</button>
            <div id="pay-form" style="display:none; margin-top: 16px;">
              <div class="form-group">
                <label for="pay-amount">Amount</label>
                <input type="text" id="pay-amount" value="2500.00" class="form-input">
              </div>
              <div class="form-group">
                <label for="pay-from">Pay From</label>
                <select id="pay-from" class="form-input">
                  <option>Savings ****4821</option>
                  <option>Checking ****7733</option>
                </select>
              </div>
              <button class="btn btn-primary" id="btn-confirm-pay" onclick="
                document.getElementById('pay-form').innerHTML = '<div class=\\'success-msg\\'>Payment of $' + document.getElementById('pay-amount').value + ' submitted successfully!</div>';
              ">Confirm Payment</button>
            </div>
          </div>`,
      },
    },
    payments: {
      transfer: {
        title: 'Transfer Money',
        html: `
          <div class="card">
            <h3>New Transfer</h3>
            <form id="transfer-form" onsubmit="return false;">
              <div class="form-group">
                <label for="from-account">From Account</label>
                <select id="from-account" class="form-input">
                  <option value="savings">Savings ****4821 — $18,230.50</option>
                  <option value="checking">Checking ****7733 — $3,852.40</option>
                </select>
              </div>
              <div class="form-group">
                <label for="to-account">To Account</label>
                <select id="to-account" class="form-input">
                  <option value="checking">Checking ****7733</option>
                  <option value="savings">Savings ****4821</option>
                  <option value="external">External Account</option>
                </select>
              </div>
              <div id="external-fields" style="display:none;">
                <div class="form-group">
                  <label for="bsb">BSB</label>
                  <input type="text" id="bsb" class="form-input" placeholder="000-000">
                </div>
                <div class="form-group">
                  <label for="ext-account">Account Number</label>
                  <input type="text" id="ext-account" class="form-input" placeholder="12345678">
                </div>
              </div>
              <div class="form-group">
                <label for="transfer-amount">Amount ($)</label>
                <input type="number" id="transfer-amount" class="form-input" placeholder="0.00" min="0" step="0.01">
              </div>
              <div class="form-group">
                <label for="transfer-desc">Description</label>
                <input type="text" id="transfer-desc" class="form-input" placeholder="Optional description">
              </div>
              <button type="submit" class="btn btn-primary" id="btn-submit-transfer">Submit Transfer</button>
              <div id="transfer-result" style="margin-top: 16px;"></div>
            </form>
          </div>
          <script>
            document.getElementById('to-account').addEventListener('change', function() {
              document.getElementById('external-fields').style.display = this.value === 'external' ? 'block' : 'none';
            });
            document.getElementById('btn-submit-transfer').addEventListener('click', function() {
              const amount = document.getElementById('transfer-amount').value;
              const from = document.getElementById('from-account').selectedOptions[0].text;
              const to = document.getElementById('to-account').selectedOptions[0].text;
              if (!amount || parseFloat(amount) <= 0) {
                document.getElementById('transfer-result').innerHTML = '<div class="error-msg">Please enter a valid amount.</div>';
                return;
              }
              document.getElementById('transfer-result').innerHTML = '<div class="success-msg">Transfer of $' + parseFloat(amount).toFixed(2) + ' from ' + from + ' to ' + to + ' submitted successfully!</div>';
            });
          </script>`,
      },
      'pay-bills': {
        title: 'Pay Bills',
        html: `
          <div class="card">
            <h3>Upcoming Bills</h3>
            <table class="data-table" id="bills-table">
              <thead><tr><th>Biller</th><th>Due Date</th><th>Amount</th><th>Action</th></tr></thead>
              <tbody>
                <tr id="bill-1"><td>Electric Company</td><td>Apr 5</td><td>$142.00</td><td><button class="btn btn-small btn-primary" onclick="payBill('bill-1', 'Electric Company', 142)">Pay Now</button></td></tr>
                <tr id="bill-2"><td>Internet Provider</td><td>Apr 8</td><td>$79.99</td><td><button class="btn btn-small btn-primary" onclick="payBill('bill-2', 'Internet Provider', 79.99)">Pay Now</button></td></tr>
                <tr id="bill-3"><td>Water Utility</td><td>Apr 12</td><td>$55.30</td><td><button class="btn btn-small btn-primary" onclick="payBill('bill-3', 'Water Utility', 55.30)">Pay Now</button></td></tr>
                <tr id="bill-4"><td>Insurance Co.</td><td>Apr 15</td><td>$220.00</td><td><button class="btn btn-small btn-primary" onclick="payBill('bill-4', 'Insurance Co.', 220)">Pay Now</button></td></tr>
              </tbody>
            </table>
            <div id="bill-result" style="margin-top: 16px;"></div>
          </div>
          <script>
            function payBill(rowId, name, amount) {
              const btn = document.querySelector('#' + rowId + ' button');
              btn.textContent = 'Paid';
              btn.disabled = true;
              btn.classList.remove('btn-primary');
              btn.classList.add('btn-disabled');
              document.getElementById('bill-result').innerHTML = '<div class="success-msg">Payment of $' + amount.toFixed(2) + ' to ' + name + ' completed.</div>';
            }
          </script>`,
      },
      scheduled: {
        title: 'Scheduled Payments',
        html: `
          <div class="card">
            <h3>Scheduled Payments</h3>
            <table class="data-table" id="scheduled-table">
              <thead><tr><th>Recipient</th><th>Frequency</th><th>Next Date</th><th>Amount</th><th>Action</th></tr></thead>
              <tbody>
                <tr id="sched-1"><td>Landlord</td><td>Monthly</td><td>Apr 1</td><td>$1,500.00</td><td><button class="btn btn-small btn-danger" onclick="cancelScheduled('sched-1', 'Landlord')">Cancel</button></td></tr>
                <tr id="sched-2"><td>Gym Membership</td><td>Monthly</td><td>Apr 3</td><td>$49.99</td><td><button class="btn btn-small btn-danger" onclick="cancelScheduled('sched-2', 'Gym Membership')">Cancel</button></td></tr>
                <tr id="sched-3"><td>Streaming Service</td><td>Monthly</td><td>Apr 10</td><td>$14.99</td><td><button class="btn btn-small btn-danger" onclick="cancelScheduled('sched-3', 'Streaming Service')">Cancel</button></td></tr>
              </tbody>
            </table>
            <div id="sched-result" style="margin-top: 16px;"></div>
          </div>
          <div class="card">
            <h3>Add New Scheduled Payment</h3>
            <form onsubmit="return false;">
              <div class="form-group">
                <label for="sched-recipient">Recipient</label>
                <input type="text" id="sched-recipient" class="form-input" placeholder="Recipient name">
              </div>
              <div class="form-group">
                <label for="sched-amount">Amount ($)</label>
                <input type="number" id="sched-amount" class="form-input" placeholder="0.00" min="0" step="0.01">
              </div>
              <div class="form-group">
                <label for="sched-freq">Frequency</label>
                <select id="sched-freq" class="form-input">
                  <option>Weekly</option>
                  <option selected>Monthly</option>
                  <option>Quarterly</option>
                </select>
              </div>
              <button class="btn btn-primary" id="btn-add-scheduled" onclick="addScheduled()">Add Payment</button>
              <div id="add-sched-result" style="margin-top: 16px;"></div>
            </form>
          </div>
          <script>
            function cancelScheduled(rowId, name) {
              const row = document.getElementById(rowId);
              row.style.opacity = '0.4';
              row.style.textDecoration = 'line-through';
              row.querySelector('button').disabled = true;
              row.querySelector('button').textContent = 'Cancelled';
              document.getElementById('sched-result').innerHTML = '<div class="info-msg">Scheduled payment to ' + name + ' has been cancelled.</div>';
            }
            let schedCount = 3;
            function addScheduled() {
              const name = document.getElementById('sched-recipient').value;
              const amount = document.getElementById('sched-amount').value;
              const freq = document.getElementById('sched-freq').value;
              if (!name || !amount) {
                document.getElementById('add-sched-result').innerHTML = '<div class="error-msg">Please fill in all fields.</div>';
                return;
              }
              schedCount++;
              const id = 'sched-' + schedCount;
              const tbody = document.querySelector('#scheduled-table tbody');
              tbody.insertAdjacentHTML('beforeend',
                '<tr id="' + id + '"><td>' + name + '</td><td>' + freq + '</td><td>Apr 30</td><td>$' + parseFloat(amount).toFixed(2) + '</td><td><button class="btn btn-small btn-danger" onclick="cancelScheduled(\\'' + id + '\\', \\'' + name + '\\')">Cancel</button></td></tr>'
              );
              document.getElementById('add-sched-result').innerHTML = '<div class="success-msg">Scheduled payment to ' + name + ' added.</div>';
            }
          </script>`,
      },
    },
    support: {
      faq: {
        title: 'Frequently Asked Questions',
        html: `
          <div class="card">
            <h3>FAQs</h3>
            <div class="faq-list">
              <div class="faq-item">
                <button class="faq-question" onclick="toggleFaq(this)">How do I reset my password?</button>
                <div class="faq-answer" style="display:none;">Go to the login page and click "Forgot Password". Enter your registered email and follow the instructions sent to your inbox. The reset link expires after 24 hours.</div>
              </div>
              <div class="faq-item">
                <button class="faq-question" onclick="toggleFaq(this)">What are the transfer limits?</button>
                <div class="faq-answer" style="display:none;">Daily transfer limit is $10,000 for internal transfers and $5,000 for external transfers. You can request a temporary increase by contacting support.</div>
              </div>
              <div class="faq-item">
                <button class="faq-question" onclick="toggleFaq(this)">How do I add a new payee?</button>
                <div class="faq-answer" style="display:none;">Navigate to Payments &gt; Transfer Money, select "External Account" as the destination, and enter the BSB and account number. The payee will be saved for future transfers.</div>
              </div>
              <div class="faq-item">
                <button class="faq-question" onclick="toggleFaq(this)">Is my data secure?</button>
                <div class="faq-answer" style="display:none;">Yes. We use 256-bit encryption, multi-factor authentication, and regular security audits. Your session expires after 15 minutes of inactivity.</div>
              </div>
              <div class="faq-item">
                <button class="faq-question" onclick="toggleFaq(this)">How do I dispute a transaction?</button>
                <div class="faq-answer" style="display:none;">Go to Support &gt; Report Issue and select "Transaction Dispute" as the category. Provide the transaction date and amount, and our team will investigate within 5 business days.</div>
              </div>
            </div>
          </div>
          <script>
            function toggleFaq(btn) {
              const answer = btn.nextElementSibling;
              const isOpen = answer.style.display !== 'none';
              answer.style.display = isOpen ? 'none' : 'block';
              btn.classList.toggle('open', !isOpen);
            }
          </script>`,
      },
      contact: {
        title: 'Contact Us',
        html: `
          <div class="card">
            <h3>Contact Support</h3>
            <form id="contact-form" onsubmit="return false;">
              <div class="form-group">
                <label for="contact-name">Your Name</label>
                <input type="text" id="contact-name" class="form-input" placeholder="Full name">
              </div>
              <div class="form-group">
                <label for="contact-email">Email</label>
                <input type="email" id="contact-email" class="form-input" placeholder="your@email.com">
              </div>
              <div class="form-group">
                <label for="contact-subject">Subject</label>
                <select id="contact-subject" class="form-input">
                  <option value="">Select a topic...</option>
                  <option>Account Inquiry</option>
                  <option>Technical Issue</option>
                  <option>Billing Question</option>
                  <option>Feedback</option>
                  <option>Other</option>
                </select>
              </div>
              <div class="form-group">
                <label for="contact-message">Message</label>
                <textarea id="contact-message" class="form-input" rows="4" placeholder="Describe your inquiry..."></textarea>
              </div>
              <button class="btn btn-primary" id="btn-send-message" onclick="submitContact()">Send Message</button>
              <div id="contact-result" style="margin-top: 16px;"></div>
            </form>
          </div>
          <div class="card">
            <h3>Other Ways to Reach Us</h3>
            <div class="info-row"><span>\u{1F4DE} Phone:</span><strong>1-800-SECURE (732-873)</strong></div>
            <div class="info-row"><span>\u{2709}\uFE0F Email:</span><strong>support@securebank.com</strong></div>
            <div class="info-row"><span>\u{1F553} Hours:</span><strong>Mon-Fri 8am-8pm, Sat 9am-5pm</strong></div>
          </div>
          <script>
            function submitContact() {
              const name = document.getElementById('contact-name').value;
              const email = document.getElementById('contact-email').value;
              const subject = document.getElementById('contact-subject').value;
              const message = document.getElementById('contact-message').value;
              if (!name || !email || !subject || !message) {
                document.getElementById('contact-result').innerHTML = '<div class="error-msg">Please fill in all fields.</div>';
                return;
              }
              document.getElementById('contact-result').innerHTML = '<div class="success-msg">Your message has been sent! Reference #SUP-' + Math.floor(1000 + Math.random() * 9000) + '. We\\'ll respond within 24 hours.</div>';
            }
          </script>`,
      },
      report: {
        title: 'Report an Issue',
        html: `
          <div class="card">
            <h3>Report an Issue</h3>
            <form id="report-form" onsubmit="return false;">
              <div class="form-group">
                <label for="issue-category">Category</label>
                <select id="issue-category" class="form-input">
                  <option value="">Select category...</option>
                  <option>Transaction Dispute</option>
                  <option>Unauthorized Access</option>
                  <option>Card Lost/Stolen</option>
                  <option>App/Website Bug</option>
                  <option>Other</option>
                </select>
              </div>
              <div class="form-group">
                <label for="issue-priority">Priority</label>
                <div class="radio-group">
                  <label class="radio-label"><input type="radio" name="priority" value="low"> Low</label>
                  <label class="radio-label"><input type="radio" name="priority" value="medium" checked> Medium</label>
                  <label class="radio-label"><input type="radio" name="priority" value="high"> High</label>
                  <label class="radio-label"><input type="radio" name="priority" value="urgent"> Urgent</label>
                </div>
              </div>
              <div class="form-group">
                <label for="issue-description">Description</label>
                <textarea id="issue-description" class="form-input" rows="4" placeholder="Describe the issue in detail..."></textarea>
              </div>
              <div class="form-group">
                <label><input type="checkbox" id="issue-contact-me"> Contact me for follow-up</label>
              </div>
              <button class="btn btn-primary" id="btn-submit-issue" onclick="submitIssue()">Submit Report</button>
              <div id="report-result" style="margin-top: 16px;"></div>
            </form>
          </div>
          <script>
            function submitIssue() {
              const category = document.getElementById('issue-category').value;
              const desc = document.getElementById('issue-description').value;
              const priority = document.querySelector('input[name="priority"]:checked')?.value || 'medium';
              if (!category || !desc) {
                document.getElementById('report-result').innerHTML = '<div class="error-msg">Please select a category and provide a description.</div>';
                return;
              }
              const ticketId = 'TKT-' + Math.floor(10000 + Math.random() * 90000);
              document.getElementById('report-result').innerHTML = '<div class="success-msg">Issue reported successfully!<br>Ticket: <strong>' + ticketId + '</strong><br>Priority: <strong>' + priority.charAt(0).toUpperCase() + priority.slice(1) + '</strong><br>We\\'ll investigate and update you within 48 hours.</div>';
            }
          </script>`,
      },
    },
  };

  const contentStyle = `
    body { background: #f0f4f8; padding: 24px; }
    h2 { color: #111827; font-size: 22px; margin-bottom: 20px; }
    h3 { color: #374151; font-size: 16px; margin-bottom: 12px; }
    .card { background: #fff; border-radius: 10px; box-shadow: 0 1px 6px rgba(0,0,0,0.06); padding: 20px; margin-bottom: 20px; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
    .stats-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
    .stat-card { background: #fff; border-radius: 10px; box-shadow: 0 1px 6px rgba(0,0,0,0.06); padding: 16px; }
    .stat-label { font-size: 13px; color: #6b7280; margin-bottom: 4px; }
    .stat-value { font-size: 22px; font-weight: 700; color: #111827; }
    .account-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 16px; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .badge-green { background: #d1fae5; color: #047857; }
    .badge-yellow { background: #fef3c7; color: #92400e; }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; color: #6b7280; }
    .info-row:last-child { border-bottom: none; }
    .data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .data-table th { text-align: left; padding: 10px 12px; background: #f9fafb; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; }
    .data-table td { padding: 10px 12px; border-bottom: 1px solid #f3f4f6; color: #374151; }
    .amount-positive { color: #047857; font-weight: 600; }
    .amount-negative { color: #dc2626; font-weight: 600; }
    .btn { padding: 10px 20px; border-radius: 7px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; margin-top: 12px; }
    .btn-primary { background: #1a56db; color: #fff; }
    .btn-primary:hover { background: #1e40af; }
    .btn-secondary { background: #e5e7eb; color: #374151; }
    .btn-secondary:hover { background: #d1d5db; }
    .btn-danger { background: #fee2e2; color: #dc2626; }
    .btn-danger:hover { background: #fecaca; }
    .btn-small { padding: 5px 12px; font-size: 12px; margin-top: 0; }
    .btn-disabled { background: #d1d5db; color: #9ca3af; cursor: default; }
    .button-group { display: flex; gap: 8px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px; }
    .form-input { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; font-family: inherit; }
    .form-input:focus { outline: none; border-color: #1a56db; box-shadow: 0 0 0 3px rgba(26,86,219,0.1); }
    textarea.form-input { resize: vertical; }
    .radio-group { display: flex; gap: 16px; margin-top: 4px; }
    .radio-label { font-size: 14px; font-weight: 400; color: #374151; display: flex; align-items: center; gap: 4px; }
    .filter-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 14px; }
    .filter-bar select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; }
    .success-msg { background: #d1fae5; color: #047857; padding: 12px 16px; border-radius: 8px; font-size: 14px; }
    .error-msg { background: #fee2e2; color: #dc2626; padding: 12px 16px; border-radius: 8px; font-size: 14px; }
    .info-msg { background: #dbeafe; color: #1e40af; padding: 12px 16px; border-radius: 8px; font-size: 14px; }
    .faq-list { display: flex; flex-direction: column; gap: 2px; }
    .faq-item { border-bottom: 1px solid #f3f4f6; }
    .faq-item:last-child { border-bottom: none; }
    .faq-question { display: block; width: 100%; text-align: left; padding: 12px 0; font-size: 14px; font-weight: 600; color: #1a56db; cursor: pointer; border: none; background: none; font-family: inherit; }
    .faq-question:hover { color: #1e40af; }
    .faq-question::before { content: '\\25B6'; margin-right: 8px; font-size: 10px; display: inline-block; transition: transform 0.15s; }
    .faq-question.open::before { transform: rotate(90deg); }
    .faq-answer { padding: 0 0 12px 20px; font-size: 14px; color: #4b5563; line-height: 1.5; }
    .credit-card-visual { background: linear-gradient(135deg, #1e40af, #7c3aed); color: #fff; border-radius: 12px; padding: 24px; max-width: 380px; }
    .cc-chip { width: 36px; height: 28px; background: #fbbf24; border-radius: 4px; margin-bottom: 20px; }
    .cc-number { font-size: 20px; letter-spacing: 2px; margin-bottom: 20px; font-family: monospace; }
    .cc-details { display: flex; gap: 32px; font-size: 12px; }
    .cc-label { opacity: 0.7; font-size: 10px; text-transform: uppercase; }
  `;

  const cat = contentMap[category];
  if (!cat) return null;
  const content = cat[item];
  if (!content) return null;

  return wrapIframeHtml(`SecureBank — ${content.title}`, contentStyle, `<h2>${content.title}</h2>${content.html}`);
}

function generateIframeContent(pathname: string): string | null {
  if (pathname === '/iframe/banner') {
    return generateBannerHtml();
  }

  const sidebarMatch = pathname.match(/^\/iframe\/sidebar\/([a-z-]+)$/);
  if (sidebarMatch) {
    return generateSidebarHtml(sidebarMatch[1]!);
  }

  const contentMatch = pathname.match(/^\/iframe\/content\/([a-z-]+)\/([a-z-]+)$/);
  if (contentMatch) {
    return generateContentHtml(contentMatch[1]!, contentMatch[2]!);
  }

  // Nested iframe routes
  const nestedResult = generateNestedIframeContent(pathname);
  if (nestedResult) return nestedResult;

  return null;
}

// ─── Nested iframe content (for testing recursive frame capture) ─────────────

function generateNestedIframeContent(pathname: string): string | null {
  if (pathname === '/iframe/nested/advisor') {
    return generateAdvisorPortalHtml();
  }
  if (pathname === '/iframe/nested/chat') {
    return generateChatWidgetHtml();
  }
  if (pathname === '/iframe/nested/recommendations') {
    return generateRecommendationsHtml();
  }
  return null;
}

function generateAdvisorPortalHtml(): string {
  const style = `
    body { background: #f8fafc; height: 100%; display: flex; flex-direction: column; }
    .advisor-header {
      background: #fff; border-bottom: 1px solid #e5e7eb; padding: 16px 20px;
      display: flex; align-items: center; gap: 12px; flex-shrink: 0;
    }
    .advisor-avatar {
      width: 40px; height: 40px; border-radius: 50%; background: #dbeafe;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; color: #1a56db; font-size: 16px;
    }
    .advisor-info { flex: 1; }
    .advisor-name { font-size: 15px; font-weight: 600; color: #111827; }
    .advisor-role { font-size: 12px; color: #6b7280; }
    .advisor-status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #047857; font-weight: 600; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; }
    .portal-body { display: flex; flex: 1; min-height: 0; }
    #chat-frame { width: 380px; height: 100%; border: none; border-right: 1px solid #e5e7eb; flex-shrink: 0; }
    #recommendations-frame { flex: 1; height: 100%; border: none; }
  `;

  const body = `
  <div class="advisor-header">
    <div class="advisor-avatar">JM</div>
    <div class="advisor-info">
      <div class="advisor-name">Jane Mitchell, CFA</div>
      <div class="advisor-role">Senior Wealth Advisor</div>
    </div>
    <div class="advisor-status">
      <span class="status-dot"></span>
      Available
    </div>
  </div>
  <div class="portal-body">
    <iframe id="chat-frame" name="chat-frame" src="/iframe/nested/chat" title="Advisor chat"></iframe>
    <iframe id="recommendations-frame" name="recommendations-frame" src="/iframe/nested/recommendations" title="Investment recommendations"></iframe>
  </div>`;

  return wrapIframeHtml('SecureBank \u2014 Advisor Portal', style, body);
}

function generateChatWidgetHtml(): string {
  const style = `
    body { background: #fff; height: 100%; display: flex; flex-direction: column; }
    .chat-header {
      background: #1a56db; color: #fff; padding: 12px 16px;
      font-size: 14px; font-weight: 600; flex-shrink: 0;
    }
    .chat-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.4; }
    .msg-advisor { background: #f3f4f6; color: #374151; align-self: flex-start; border-bottom-left-radius: 4px; }
    .msg-user { background: #1a56db; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
    .msg-sender { font-size: 11px; font-weight: 600; margin-bottom: 4px; opacity: 0.7; }
    .msg-time { font-size: 10px; opacity: 0.5; margin-top: 4px; text-align: right; }
    .chat-input-area {
      border-top: 1px solid #e5e7eb; padding: 12px; display: flex; gap: 8px; flex-shrink: 0;
    }
    #chat-input {
      flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 20px;
      font-size: 13px; font-family: inherit; outline: none;
    }
    #chat-input:focus { border-color: #1a56db; }
    #btn-send {
      padding: 8px 16px; background: #1a56db; color: #fff; border: none;
      border-radius: 20px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    #btn-send:hover { background: #1e40af; }
    .typing-indicator { font-size: 12px; color: #6b7280; font-style: italic; padding: 4px 14px; display: none; }
  `;

  const body = `
  <div class="chat-header">Chat with Jane Mitchell</div>
  <div class="chat-messages" id="chat-messages">
    <div class="msg msg-advisor">
      <div class="msg-sender">Jane Mitchell</div>
      Hi! I've reviewed your portfolio. Your equity allocation has performed well this quarter, up 3.8%.
      <div class="msg-time">10:15 AM</div>
    </div>
    <div class="msg msg-user">
      <div class="msg-sender">You</div>
      That's great! Should I rebalance given the recent market volatility?
      <div class="msg-time">10:18 AM</div>
    </div>
    <div class="msg msg-advisor">
      <div class="msg-sender">Jane Mitchell</div>
      Good question. I'd recommend shifting 5% from equities to bonds to lock in some gains. I've added a rebalancing suggestion to your recommendations panel.
      <div class="msg-time">10:20 AM</div>
    </div>
  </div>
  <div class="typing-indicator" id="typing-indicator">Jane is typing...</div>
  <div class="chat-input-area">
    <input type="text" id="chat-input" placeholder="Type your message..." aria-label="Chat message">
    <button id="btn-send">Send</button>
  </div>
  <script>
    document.getElementById('btn-send').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') sendMessage();
    });

    function sendMessage() {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;

      const messages = document.getElementById('chat-messages');
      const now = new Date();
      const time = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') + ' ' + (now.getHours() >= 12 ? 'PM' : 'AM');

      messages.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user"><div class="msg-sender">You</div>' + text + '<div class="msg-time">' + time + '</div></div>'
      );
      input.value = '';
      messages.scrollTop = messages.scrollHeight;

      // Simulate advisor typing and response
      document.getElementById('typing-indicator').style.display = 'block';
      setTimeout(function() {
        document.getElementById('typing-indicator').style.display = 'none';
        messages.insertAdjacentHTML('beforeend',
          '<div class="msg msg-advisor"><div class="msg-sender">Jane Mitchell</div>Thanks for your message. Let me look into that and update your recommendations.<div class="msg-time">' + time + '</div></div>'
        );
        messages.scrollTop = messages.scrollHeight;
      }, 1500);
    }
  </script>`;

  return wrapIframeHtml('SecureBank \u2014 Advisor Chat', style, body);
}

function generateRecommendationsHtml(): string {
  const style = `
    body { background: #f8fafc; padding: 20px; }
    h2 { font-size: 16px; color: #111827; margin-bottom: 16px; }
    .rec-card {
      background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      padding: 16px; margin-bottom: 12px;
    }
    .rec-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px; }
    .rec-title { font-size: 14px; font-weight: 600; color: #111827; }
    .rec-badge { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; }
    .badge-buy { background: #d1fae5; color: #047857; }
    .badge-rebalance { background: #fef3c7; color: #92400e; }
    .badge-hold { background: #dbeafe; color: #1d4ed8; }
    .rec-summary { font-size: 13px; color: #6b7280; margin-bottom: 10px; line-height: 1.4; }
    .rec-details { display: none; margin-top: 10px; padding-top: 10px; border-top: 1px solid #f3f4f6; font-size: 13px; color: #374151; line-height: 1.5; }
    .rec-detail-row { display: flex; justify-content: space-between; padding: 4px 0; }
    .rec-detail-label { color: #6b7280; }
    .rec-detail-value { font-weight: 600; }
    .btn {
      padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: none; transition: background 0.15s; margin-top: 8px;
    }
    .btn-details { background: #e5e7eb; color: #374151; }
    .btn-details:hover { background: #d1d5db; }
    .btn-action { background: #1a56db; color: #fff; margin-left: 8px; }
    .btn-action:hover { background: #1e40af; }
    .btn-action:disabled { background: #9ca3af; cursor: default; }
    .action-msg { font-size: 12px; color: #047857; font-weight: 600; margin-top: 8px; }
  `;

  const body = `
  <h2>Recommendations</h2>

  <div class="rec-card" id="rec-1">
    <div class="rec-header">
      <div class="rec-title">Rebalance: Reduce Equities</div>
      <span class="rec-badge badge-rebalance">Rebalance</span>
    </div>
    <div class="rec-summary">Shift 5% from equities to bonds to reduce volatility exposure and lock in Q1 gains.</div>
    <div class="rec-details" id="rec-1-details">
      <div class="rec-detail-row"><span class="rec-detail-label">Current Equity Allocation</span><span class="rec-detail-value">52%</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Target Equity Allocation</span><span class="rec-detail-value">47%</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Estimated Impact</span><span class="rec-detail-value">-0.3% annual return, -1.2% volatility</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Risk Level</span><span class="rec-detail-value">Low</span></div>
    </div>
    <button class="btn btn-details" onclick="toggleDetails('rec-1')">View Details</button>
    <button class="btn btn-action" id="btn-apply-rec-1" onclick="applyRec('rec-1', 'Rebalance order submitted')">Apply</button>
    <div class="action-msg" id="rec-1-msg"></div>
  </div>

  <div class="rec-card" id="rec-2">
    <div class="rec-header">
      <div class="rec-title">Buy: Vanguard Total Bond ETF (BND)</div>
      <span class="rec-badge badge-buy">Buy</span>
    </div>
    <div class="rec-summary">Increase bond exposure with a low-cost index ETF. Aligns with the rebalancing recommendation above.</div>
    <div class="rec-details" id="rec-2-details">
      <div class="rec-detail-row"><span class="rec-detail-label">Suggested Amount</span><span class="rec-detail-value">$7,142.50</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Current Price</span><span class="rec-detail-value">$72.85</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Yield</span><span class="rec-detail-value">4.2% annual</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Expense Ratio</span><span class="rec-detail-value">0.03%</span></div>
    </div>
    <button class="btn btn-details" onclick="toggleDetails('rec-2')">View Details</button>
    <button class="btn btn-action" id="btn-apply-rec-2" onclick="applyRec('rec-2', 'Buy order for BND placed')">Apply</button>
    <div class="action-msg" id="rec-2-msg"></div>
  </div>

  <div class="rec-card" id="rec-3">
    <div class="rec-header">
      <div class="rec-title">Hold: S&P 500 Index Fund</div>
      <span class="rec-badge badge-hold">Hold</span>
    </div>
    <div class="rec-summary">Strong YTD performance (+8.2%). Maintain current position and review at end of Q2.</div>
    <div class="rec-details" id="rec-3-details">
      <div class="rec-detail-row"><span class="rec-detail-label">Current Value</span><span class="rec-detail-value">$48,200.00</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">YTD Return</span><span class="rec-detail-value">+8.2%</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Next Review</span><span class="rec-detail-value">June 30</span></div>
      <div class="rec-detail-row"><span class="rec-detail-label">Risk Level</span><span class="rec-detail-value">Medium</span></div>
    </div>
    <button class="btn btn-details" onclick="toggleDetails('rec-3')">View Details</button>
  </div>

  <script>
    function toggleDetails(id) {
      var details = document.getElementById(id + '-details');
      var btn = details.previousElementSibling;
      // Actually the button is the next sibling after details... let me just use parent
      var card = document.getElementById(id);
      var detailBtn = card.querySelector('.btn-details');
      if (details.style.display === 'none' || details.style.display === '') {
        details.style.display = 'block';
        detailBtn.textContent = 'Hide Details';
      } else {
        details.style.display = 'none';
        detailBtn.textContent = 'View Details';
      }
    }

    function applyRec(id, message) {
      var btn = document.getElementById('btn-apply-' + id);
      btn.disabled = true;
      btn.textContent = 'Applied';
      document.getElementById(id + '-msg').textContent = message;
    }
  </script>`;

  return wrapIframeHtml('SecureBank \u2014 Recommendations', style, body);
}

// ─── New Window / Tab content ─────────────────────────────────────────────────

function generateNewWindowContent(subpage: string): string | null {
  if (subpage === 'popup') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SecureBank — Popup Window</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f4f8;
      padding: 32px;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.10);
      padding: 32px;
      max-width: 500px;
      margin: 0 auto;
    }
    h1 { font-size: 20px; font-weight: 700; color: #111827; margin-bottom: 8px; }
    p { color: #6b7280; font-size: 14px; margin-bottom: 16px; }
    .info { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #1e40af; margin-bottom: 16px; }
    label { display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px; }
    input[type="text"] {
      width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px;
      font-size: 15px; color: #111827; outline: none; margin-bottom: 16px;
    }
    input[type="text"]:focus { border-color: #1a56db; box-shadow: 0 0 0 3px rgba(26,86,219,0.12); }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn-primary { background: #1a56db; color: #fff; }
    .btn-primary:hover { background: #1648c0; }
    .btn-close { background: #ef4444; color: #fff; margin-left: 8px; }
    .btn-close:hover { background: #dc2626; }
    .actions { display: flex; gap: 8px; }
    #result { margin-top: 16px; padding: 12px 16px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; font-size: 13px; color: #166534; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Popup Window</h1>
    <p>This page was opened as a new window (popup).</p>
    <div class="info">Window name: <strong>securebank-popup</strong></div>
    <label for="popup-message">Send a message back to the opener</label>
    <input type="text" id="popup-message" placeholder="Type a message...">
    <div class="actions">
      <button class="btn btn-primary" id="send-btn">Send to Opener</button>
      <button class="btn btn-close" id="close-btn">Close Window</button>
    </div>
    <div id="result"></div>
  </div>
  <script>
    document.getElementById('send-btn').addEventListener('click', function () {
      var msg = document.getElementById('popup-message').value;
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ source: 'popup', message: msg }, '*');
        var r = document.getElementById('result');
        r.style.display = 'block';
        r.textContent = 'Message sent: ' + msg;
      }
    });
    document.getElementById('close-btn').addEventListener('click', function () {
      window.close();
    });
  </script>
</body>
</html>`;
  }

  if (subpage === 'tab') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SecureBank — New Tab</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f4f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.10);
      padding: 48px 40px;
      width: 100%;
      max-width: 500px;
    }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
    .logo-icon {
      width: 36px; height: 36px; background: #1a56db; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-weight: bold; font-size: 18px;
    }
    .logo-name { font-size: 22px; font-weight: 700; color: #111827; }
    h1 { font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 8px; }
    p { color: #6b7280; font-size: 14px; margin-bottom: 16px; }
    .info { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #1e40af; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; }
    td { padding: 10px 12px; font-size: 14px; color: #111827; border-bottom: 1px solid #f3f4f6; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .badge-success { background: #d1fae5; color: #065f46; }
    .badge-pending { background: #fef3c7; color: #92400e; }
    .back-link { display: block; text-align: center; font-size: 13px; color: #1a56db; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">S</div>
      <span class="logo-name">SecureBank</span>
    </div>
    <h1>Account Summary</h1>
    <p>This page was opened in a new tab.</p>
    <div class="info">Opened from the main application window.</div>
    <table>
      <thead>
        <tr><th>Account</th><th>Balance</th><th>Status</th></tr>
      </thead>
      <tbody>
        <tr><td>Savings</td><td>$12,450.00</td><td><span class="badge badge-success">Active</span></td></tr>
        <tr><td>Checking</td><td>$3,280.50</td><td><span class="badge badge-success">Active</span></td></tr>
        <tr><td>Investment</td><td>$45,000.00</td><td><span class="badge badge-pending">Pending</span></td></tr>
      </tbody>
    </table>
    <a href="/dashboard" class="back-link">Go to Dashboard</a>
  </div>
</body>
</html>`;
  }

  return null;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Enable CORS for browser tests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-csrf-token, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  try {
    await handleRequest(req, res, pathname, method);
  } catch (err) {
    console.error('Server error:', err);
    json(res, 500, { error: 'Internal server error' });
  }
});

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<void> {
  // ── Iframe content (dynamically generated HTML) ────────────────────────────
  if (pathname.startsWith('/iframe/')) {
    const iframeHtml = generateIframeContent(pathname);
    if (iframeHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(iframeHtml);
    } else {
      notFound(res);
    }
    return;
  }

  // ── New-window / new-tab content (dynamically generated HTML) ──────────────
  if (pathname.startsWith('/new-window/')) {
    const subpage = pathname.slice('/new-window/'.length);
    const html = generateNewWindowContent(subpage);
    if (html) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      notFound(res);
    }
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────────
  if (!pathname.startsWith('/api/')) {
    // Route friendly URLs to their HTML files
    const friendlyRoutes: Record<string, string> = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/login': 'index.html',
      '/dashboard': 'dashboard.html',
      '/delegates': 'delegates.html',
      '/transactions': 'transactions.html',
      '/iframes': 'iframes.html',
      '/nested-iframes': 'nested-iframes.html',
      '/new-window': 'new-window.html',
      '/mfa-login': 'mfa-login.html',
      '/mfa': 'mfa.html',
      '/assertions': 'assertions.html',
      '/confirm-action': 'confirm-action.html',
      '/dom-noise': 'dom-noise.html',
      '/documents': 'documents.html',
      '/control-flow': 'control-flow.html',
      // Table fixtures (docs/specs/SPEC-structured-table-reads.md); tables.html
      // is the index of all of them.
      '/tables': 'tables.html',
      '/structured-orders': 'structured-orders.html',
      '/structured-orders-many': 'structured-orders-many.html',
      '/scheduled-payments': 'scheduled-payments.html',
      '/payment-details': 'payment-details.html',
      '/statements': 'statements.html',
      '/table-edge-cases': 'table-edge-cases.html',
      // Component grids that split the header and the rows across two tables.
      '/split-grids': 'split-grids.html',
      // Telerik RadGrid: three tables in one wrapper, a banded header with a
      // filter row, and row ids that renumber on every page.
      '/radgrid': 'radgrid.html',
      // Grids with no <table> in them: MUI DataGrid and ag-Grid, where the
      // structure is carried by role, aria-rowindex and aria-colindex alone.
      '/aria-grid': 'aria-grid.html',
      // Four shapes no structural rule reads, for the structure question.
      '/odd-tables': 'odd-tables.html',
      // The one NON-html static asset (docs/specs/SPEC-use-computer.md §7).
      // It is in this map rather than reached by the `.html` fallback below
      // because that fallback is what keeps the static path from serving
      // arbitrary files out of __dirname; a named route adds one file without
      // widening it. `serveStatic` reads it as bytes and answers
      // `application/pdf`, so Chromium shows it in its built-in viewer — the
      // toolbar the computer-mode fixtures click.
      '/statement.pdf': 'statement.pdf',
    };
    const mappedFile = friendlyRoutes[pathname];
    if (mappedFile) {
      serveStatic(res, path.join(__dirname, mappedFile));
    } else if (pathname.endsWith('.html')) {
      serveStatic(res, path.join(__dirname, pathname.slice(1)));
    } else {
      notFound(res);
    }
    return;
  }

  // ── Documents API (file upload) ────────────────────────────────────────────
  if (pathname === '/api/documents' && method === 'GET') {
    json(res, 200, { documents });
    return;
  }

  if (pathname === '/api/documents' && method === 'DELETE') {
    documents.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/documents' && method === 'POST') {
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2])?.trim();
    if (!/^multipart\/form-data/i.test(contentType) || !boundary) {
      json(res, 400, { error: 'Expected a multipart/form-data body' });
      return;
    }

    let body: Buffer;
    try {
      body = await readRawBody(req, DOCUMENT_MAX_REQUEST_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        json(res, 413, { error: `Request body is larger than the ${DOCUMENT_MAX_REQUEST_BYTES / (1024 * 1024)} MB limit` });
        return;
      }
      throw err;
    }

    let parts: MultipartPart[];
    try {
      parts = parseMultipart(body, boundary);
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return;
    }

    const files = parts.filter((p) => p.filename !== undefined);
    if (files.length === 0) {
      json(res, 400, { error: 'Choose a file first' });
      return;
    }

    // Validate every part before adding any: a batch is all-or-nothing, so a
    // test that sends one bad file among good ones sees nothing half-added.
    for (const file of files) {
      const name = documentName(file.filename);
      const ext = path.extname(name).toLowerCase();
      if (!DOCUMENT_ALLOWED_EXTENSIONS.has(ext)) {
        json(res, 400, { error: `${name} is not an allowed file type` });
        return;
      }
      if (file.data.length > DOCUMENT_MAX_BYTES) {
        json(res, 413, { error: `${name} is larger than the 1 MB limit` });
        return;
      }
    }

    const added: DocumentRecord[] = files.map((file) => ({
      id: `doc-${String(++documentSeq).padStart(3, '0')}`,
      name: documentName(file.filename),
      size: file.data.length,
      type: file.contentType,
      sha256: crypto.createHash('sha256').update(file.data).digest('hex'),
      uploadedAt: new Date().toISOString(),
    }));
    documents.push(...added);
    json(res, 201, { documents: added });
    return;
  }

  // ── Login API ──────────────────────────────────────────────────────────────
  if (pathname === '/api/login' && method === 'POST') {
    const body = await parseBody(req) as Record<string, unknown>;
    const email = String(body['email'] ?? '');
    const password = String(body['password'] ?? '');

    if (email === 'demo@securebank.com' && password === 'password123') {
      const sessionId = crypto.randomBytes(16).toString('hex');
      validSessions.add(sessionId);
      res.setHeader('Set-Cookie', `session=${sessionId}; HttpOnly; Path=/`);
      json(res, 200, { success: true, sessionId });
    } else {
      json(res, 401, { error: 'Invalid credentials' });
    }
    return;
  }

  // ── CSRF Token ─────────────────────────────────────────────────────────────
  if (pathname === '/api/csrf-token' && method === 'GET') {
    const sessionId = getSessionId(req) ?? 'anonymous';
    let token = csrfTokens.get(sessionId);
    if (!token) {
      token = crypto.randomBytes(24).toString('base64');
      csrfTokens.set(sessionId, token);
    }
    json(res, 200, { token });
    return;
  }

  // ── Delegates API ──────────────────────────────────────────────────────────
  if (pathname === '/api/delegates' && method === 'GET') {
    const sessionId = getSessionId(req);
    if (!sessionId || !validSessions.has(sessionId)) {
      unauthorized(res, 'Valid session required');
      return;
    }
    json(res, 200, delegates);
    return;
  }

  // GET /api/delegates/:id
  const delegateMatch = pathname.match(/^\/api\/delegates\/([^/]+)$/);
  if (delegateMatch) {
    const id = delegateMatch[1] ?? '';

    if (method === 'GET') {
      const sessionId = getSessionId(req);
      if (!sessionId || !validSessions.has(sessionId)) {
        unauthorized(res, 'Valid session required');
        return;
      }
      const delegate = delegates.find((d) => d.id === id);
      if (!delegate) { notFound(res); return; }
      json(res, 200, delegate);
      return;
    }

    if (method === 'PUT') {
      const sessionId = getSessionId(req);
      if (!sessionId || !validSessions.has(sessionId)) {
        unauthorized(res, 'Valid session required');
        return;
      }

      // CSRF check
      const csrfHeader = req.headers['x-csrf-token'];
      const expectedToken = csrfTokens.get(sessionId ?? 'anonymous');
      if (!csrfHeader || csrfHeader !== expectedToken) {
        json(res, 403, { error: 'Invalid CSRF token' });
        return;
      }

      const index = delegates.findIndex((d) => d.id === id);
      if (index === -1) { notFound(res); return; }

      const body = await parseBody(req) as Record<string, unknown>;
      const delegate = delegates[index]!;
      if (typeof body['mobile'] === 'string') delegate.mobile = body['mobile'];
      if (typeof body['email'] === 'string') delegate.email = body['email'];
      if (typeof body['name'] === 'string') delegate.name = body['name'];
      if (typeof body['status'] === 'string') delegate.status = body['status'];

      json(res, 200, delegate);
      return;
    }
  }

  // ── Notifications API (requires x-api-key) ─────────────────────────────────
  if (pathname === '/api/notifications' && method === 'GET') {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
      json(res, 401, { error: 'Invalid API key' });
      return;
    }
    json(res, 200, notifications);
    return;
  }

  // ── Orders API ─────────────────────────────────────────────────────────────
  // GET /api/orders?sinceDays=N&status=foo
  // Returns every order created within the last N days (default 30), filtered
  // optionally by status. Used by the `extract_order_ids` demo tool to show
  // an array output flowing back from a tool into the test variable scope.
  if (pathname === '/api/orders' && method === 'GET') {
    const reqUrl = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const since = Number(reqUrl.searchParams.get('sinceDays') ?? '30');
    const statusFilter = reqUrl.searchParams.get('status');
    if (!Number.isFinite(since) || since < 0) {
      json(res, 400, { error: 'sinceDays must be a non-negative number' });
      return;
    }
    const filtered = orders
      .filter((o) => o.ageDays <= since)
      .filter((o) => (statusFilter ? o.status === statusFilter : true))
      .map(({ id, status, amount }) => ({ id, status, amount }));
    json(res, 200, filtered);
    return;
  }

  notFound(res);
}

// ─── Start ────────────────────────────────────────────────────────────────────

// With PORT=0 the OS picks the port, and must not pick one `fetch` and
// Chromium refuse to connect to (tests/listen-fetchable.cjs).
const listening = PORT === 0
  ? listenFetchable(server)
  : new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
void listening.then(() => {
  // The port actually bound, not the one asked for: with PORT=0 the OS picks
  // it, and tests/fixture-server.ts reads it from this line.
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : PORT;
  console.log(`Fixture test server running at http://localhost:${bound}`);
  console.log(`  Static:  index.html, dashboard.html, delegates.html, transactions.html, iframes.html, new-window.html, mfa-login.html, mfa.html`);
  console.log(`  Iframes: /iframe/banner, /iframe/sidebar/:cat, /iframe/content/:cat/:item`);
  console.log(`  API:     /api/delegates, /api/notifications, /api/csrf-token`);
});
