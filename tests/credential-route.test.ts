// The `POST /sessions/:id/login` route, over a real socket.
//
// Narrow on purpose. The broker's behaviour is tested against a real browser in
// `credential-broker.test.ts`; what is unproven until something drives HTTP is
// the wiring — that the route is registered at all, that it is behind auth, and
// that its input validation runs before anything reaches a page.
//
// The route-is-registered assertion is the one that earns its keep: every layer
// above it (the MCP tool, the ApiClient method) typechecks perfectly against a
// route that was never added, and would fail at runtime with Express's own HTML
// 404 — which the client layer deliberately reports as "rebuild the server"
// rather than "no such session".

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer } from '../src/server/api-server.js';
import type { Config } from '../src/config/types.js';

const API_KEY = 'sk-credential-route-test';

const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
});

function post(path: string, body: unknown, key = API_KEY): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /sessions/:id/login', () => {
  it('is registered, and answers a JSON 404 for an unknown session', async () => {
    const res = await post('/sessions/mcp:nope/login', {});

    expect(res.status).toBe(404);
    // Our own error envelope, not Express's HTML — that difference is what the
    // client uses to tell "no such session" from "this server predates the
    // route", and they have opposite remedies.
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Session not found' });
  });

  it('is behind the API key', async () => {
    const res = await post('/sessions/mcp:nope/login', {}, 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('rejects a hint that is not an object, before touching a session', async () => {
    const res = await post('/sessions/mcp:nope/login', { hint: 'div#password' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/hint must be an object/i);
  });

  it('rejects an empty selector rather than treating it as absent', async () => {
    // An empty string is falsy, so a validator written the obvious way drops it
    // and the broker silently uses its own scan instead — which looks like the
    // hint working, on a page where it did nothing.
    const res = await post('/sessions/mcp:nope/login', { hint: { password: '' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/non-empty CSS selector/i);
  });

  it('rejects a non-string selector', async () => {
    const res = await post('/sessions/mcp:nope/login', { hint: { username: 42 } });
    expect(res.status).toBe(400);
  });
});
