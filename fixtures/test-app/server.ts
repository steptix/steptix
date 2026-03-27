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
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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

// CSRF token store: maps session-id → token
const csrfTokens = new Map<string, string>();

// Valid session IDs (populated on login)
const validSessions = new Set<string>();

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

function serveStatic(res: http.ServerResponse, filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
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
  // ── Static files ───────────────────────────────────────────────────────────
  if (!pathname.startsWith('/api/')) {
    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(res, path.join(__dirname, 'index.html'));
    } else if (pathname.endsWith('.html')) {
      serveStatic(res, path.join(__dirname, pathname.slice(1)));
    } else {
      notFound(res);
    }
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

  notFound(res);
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Fixture test server running at http://localhost:${PORT}`);
  console.log(`  Static:  index.html, dashboard.html, delegates.html, transactions.html`);
  console.log(`  API:     /api/delegates, /api/notifications, /api/csrf-token`);
});
