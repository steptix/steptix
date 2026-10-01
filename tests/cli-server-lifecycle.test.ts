import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { statusCommand, formatUptime } from '../src/cli/commands/status.js';
import { stopCommand } from '../src/cli/commands/stop.js';
import { nonNegativeInt } from '../src/cli/parse-args.js';
import { HEALTH_SERVICE_ID } from '../src/server/health.js';

// ---------------------------------------------------------------------------
// Stub server harness
//
// `status` / `stop` are HTTP clients, so the honest seam is a real socket:
// "connection refused" and "answered with the wrong body" are transport facts
// that a mocked fetch would only assert about itself. Each test stands up a
// throwaway http server (or deliberately doesn't) and drives the real command.
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server | undefined;

async function startStub(handler: Handler): Promise<string> {
  // The request body is drained BEFORE the handler responds. Node decides
  // whether a connection can be kept alive at `res.end()` time, and a request
  // whose body was never read forces the socket closed — undici then reuses
  // that dead connection for the next request and the client sees a transport
  // failure. That surfaced here as `stop` reporting "not running" against a
  // stub that was very much alive.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** A port with nothing on it — bound then released, so connects are refused. */
async function deadUrl(): Promise<string> {
  const url = await startStub(() => {});
  await stopStub();
  return url;
}

/**
 * Close a stub. Takes the target explicitly (defaulting to the current one)
 * because a deferred close — the "server exits shortly after answering the
 * stop" simulation below — must close the instance it was scheduled for. A
 * timer that closed whatever `server` happened to hold when it fired killed a
 * *later* test's stub, which surfaced as `stop` reporting "not running"
 * against a live server.
 */
async function stopStub(target: Server | undefined = server): Promise<void> {
  if (!target) return;
  if (server === target) server = undefined;
  await new Promise<void>((resolve) => target.close(() => resolve()));
}

function healthBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    service: HEALTH_SERVICE_ID,
    version: '1.2.3',
    pid: 4242,
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    openSessions: 2,
    runsInFlight: 0,
    inspector: 'ws://127.0.0.1:53012/abc',
    idleTimeoutMinutes: 60,
    ...overrides,
  });
}

function json(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopStub();
});

describe('steptix status', () => {
  it('exits 0 and reports the health summary when the server is ours', async () => {
    const url = await startStub((req, res) => {
      expect(req.url).toBe('/health');
      json(res, 200, healthBody());
    });

    const code = await statusCommand({ url });

    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/running/);
    expect(text).toContain('1.2.3');
    expect(text).toContain('4242');
    expect(text).toContain('ws://127.0.0.1:53012/abc');
    expect(text).toMatch(/60m/);
    expect(text).toMatch(/1m \d+s/); // uptime
  });

  it('names the build after the version: commit, and modified for uncommitted changes', async () => {
    const url = await startStub((_req, res) => json(res, 200, healthBody({ commit: 'b700473', modified: true })));

    expect(await statusCommand({ url })).toBe(0);
    expect(out.join('\n')).toMatch(/version\s+1\.2\.3 \(b700473, modified\)/);
  });

  it('prints the version alone for a server that does not report its commit', async () => {
    // healthBody() has no commit/modified: a server predating them.
    const url = await startStub((_req, res) => json(res, 200, healthBody()));

    expect(await statusCommand({ url })).toBe(0);
    expect(out.join('\n')).toMatch(/version\s+1\.2\.3$/m);
  });

  it('prints "none" / "off" for a server with no inspector and no idle timeout', async () => {
    const url = await startStub((_req, res) =>
      json(res, 200, healthBody({ inspector: null, idleTimeoutMinutes: null })),
    );

    expect(await statusCommand({ url })).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/inspector\s+none/);
    expect(text).toMatch(/idle timeout\s+off/);
  });

  it('exits 1 with "not running" when nothing is listening', async () => {
    const code = await statusCommand({ url: await deadUrl() });

    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/not running/);
  });

  it('exits 2 when the port answers but is not a Steptix server', async () => {
    const url = await startStub((_req, res) => json(res, 200, JSON.stringify({ service: 'grafana' })));

    const code = await statusCommand({ url });

    expect(code).toBe(2);
    // The message must leave room for "older Steptix server" — the probe cannot
    // distinguish that from a genuinely foreign process.
    expect(out.join('\n')).toMatch(/older Steptix server/);
  });

  it('exits 2 for a legacy Steptix server whose /health 404s', async () => {
    const url = await startStub((_req, res) => json(res, 404, JSON.stringify({ error: 'Not Found' })));

    expect(await statusCommand({ url })).toBe(2);
    expect(out.join('\n')).toMatch(/404/);
  });

  it('exits 2 when the response is not JSON at all', async () => {
    const url = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>hello</html>');
    });

    expect(await statusCommand({ url })).toBe(2);
  });

  it('--json emits the raw health body when up, and {running:false} when down', async () => {
    const url = await startStub((_req, res) => json(res, 200, healthBody()));
    expect(await statusCommand({ url, json: true })).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ service: HEALTH_SERVICE_ID, pid: 4242 });

    await stopStub();
    out = [];
    expect(await statusCommand({ url, json: true })).toBe(1);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ running: false });
  });
});

describe('steptix stop', () => {
  const savedKey = process.env['STEPTIX_SERVER_API_KEY'];
  // The machine-key chain reads the user root's .env — redirect it into an
  // empty tmp dir so these tests see this machine's real key never.
  const savedUserRoot = {
    LOCALAPPDATA: process.env['LOCALAPPDATA'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
  };
  let userRootTmp: string;

  beforeEach(() => {
    process.env['STEPTIX_SERVER_API_KEY'] = 'cli-key';
    userRootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-stop-test-'));
    process.env['LOCALAPPDATA'] = userRootTmp;
    process.env['XDG_CONFIG_HOME'] = userRootTmp;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env['STEPTIX_SERVER_API_KEY'];
    else process.env['STEPTIX_SERVER_API_KEY'] = savedKey;
    for (const [k, v] of Object.entries(savedUserRoot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(userRootTmp, { recursive: true, force: true });
  });

  it('errors out when no key exists anywhere, without making a request', async () => {
    delete process.env['STEPTIX_SERVER_API_KEY'];
    let hit = false;
    const url = await startStub(() => {
      hit = true;
    });

    expect(await stopCommand({ url })).toBe(1);
    expect(err.join('\n')).toMatch(/No STEPTIX_SERVER_API_KEY available/);
    expect(hit).toBe(false);
  });

  it('falls back to the machine key when the environment has none', async () => {
    delete process.env['STEPTIX_SERVER_API_KEY'];
    const steptixDir = path.join(userRootTmp, 'steptix');
    fs.mkdirSync(steptixDir, { recursive: true });
    fs.writeFileSync(path.join(steptixDir, '.env'), 'STEPTIX_SERVER_API_KEY=machine-key\n');

    let sentKey: string | undefined;
    const url = await startStub((req, res) => {
      if (req.url === '/health') {
        json(res, 200, healthBody());
        return;
      }
      sentKey = req.headers['x-api-key'] as string | undefined;
      json(res, 200, JSON.stringify({ ok: true }));
      // The confirm loop needs the server to go dark after accepting.
      const mine = server;
      setTimeout(() => void stopStub(mine), 10);
    });

    await stopCommand({ url, confirmTimeoutMs: 2_000, confirmPollMs: 50 });
    expect(sentKey).toBe('machine-key');
  });

  it('sends the key + force flag and exits 0 once the server goes dark', async () => {
    let shutdownBody: unknown;
    let sentKey: string | undefined;
    let stopping = false;

    const url = await startStub((req, res, body) => {
      if (req.url === '/admin/shutdown') {
        sentKey = req.headers['x-api-key'] as string;
        shutdownBody = JSON.parse(body);
        stopping = true;
        json(res, 200, JSON.stringify({ ok: true, stopping: true }));
        // Simulate the real grace-delay exit: stop answering shortly after.
        const mine = server;
        setTimeout(() => void stopStub(mine), 20);
        return;
      }
      if (stopping) {
        res.destroy();
        return;
      }
      json(res, 200, healthBody());
    });

    const code = await stopCommand({ url, force: true });

    expect(code).toBe(0);
    expect(sentKey).toBe('cli-key');
    expect(shutdownBody).toEqual({ force: true });
    expect(out.join('\n')).toMatch(/Server stopped/);
  });

  it('exits 1 on 409, naming the counts and pointing at --force', async () => {
    const url = await startStub((req, res) => {
      if (req.url === '/admin/shutdown') {
        json(res, 409, JSON.stringify({ error: 'busy', runsInFlight: 1, openSessions: 3 }));
        return;
      }
      json(res, 200, healthBody());
    });

    const code = await stopCommand({ url });

    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toMatch(/1 run\(s\) executing/);
    expect(text).toMatch(/3 session\(s\) open/);
    expect(text).toMatch(/--force/);
    // The distinction that makes the 409 rule comprehensible.
    expect(text).toMatch(/Open Steptix extension sessions alone never block a stop/);
  });

  it('refuses to send the key to a port that is not a Steptix server', async () => {
    let shutdownHit = false;
    const url = await startStub((req, res) => {
      if (req.url === '/admin/shutdown') shutdownHit = true;
      json(res, 200, JSON.stringify({ service: 'grafana' }));
    });

    const code = await stopCommand({ url });

    expect(code).toBe(1);
    // §1: check `service` BEFORE treating the port as ours. Handing
    // STEPTIX_SERVER_API_KEY to a foreign process is the thing being prevented.
    expect(shutdownHit).toBe(false);
    expect(err.join('\n')).toMatch(/not a Steptix server/);
  });

  it('exits 1 on 401 naming both key sources', async () => {
    const url = await startStub((req, res) => {
      if (req.url === '/health') {
        json(res, 200, healthBody());
        return;
      }
      json(res, 401, JSON.stringify({ error: 'Unauthorized' }));
    });

    const code = await stopCommand({ url });

    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toMatch(/401/);
    // The CLI's actual source this run — the env var was set by beforeEach,
    // and the message also names cwd/.env since the entry folds it in.
    expect(text).toMatch(/the environment \(the shell, or /);
    expect(text).toMatch(/--env-file/); // the server's likely source
  });

  it('treats a 503 as success, but still waits for the port to go free', async () => {
    let healthCalls = 0;
    let gone = false;
    const url = await startStub((req, res) => {
      if (req.url === '/admin/shutdown') {
        json(res, 503, JSON.stringify({ error: 'Server is shutting down' }));
        return;
      }
      healthCalls++;
      // Still tearing down for the first probes, then gone. `close()` alone
      // doesn't end an undici-pooled keep-alive socket, so a departed server
      // has to drop the connection for the probe to see it go dark.
      if (gone) {
        res.destroy();
        return;
      }
      if (healthCalls >= 2) {
        gone = true;
        const mine = server;
        void stopStub(mine);
      }
      json(res, 200, healthBody());
    });

    // An idle expiry (or another `steptix stop`) got there first. Reporting a
    // failure would be wrong — but so would returning before the port is
    // free, since `steptix stop && start-server` would then hit EADDRINUSE.
    const code = await stopCommand({ url, confirmTimeoutMs: 3_000, confirmPollMs: 20 });

    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/already shutting down/);
    expect(out.join('\n')).toMatch(/Server stopped/);
    expect(healthCalls).toBeGreaterThan(1);
    expect(err.join('\n')).toBe('');
  });

  it('exits 1 when nothing is listening', async () => {
    expect(await stopCommand({ url: await deadUrl() })).toBe(1);
    expect(out.join('\n')).toMatch(/not running/);
  });

  it('exits 0 but says "still shutting down" when health never goes dark', async () => {
    const url = await startStub((req, res) => {
      if (req.url === '/admin/shutdown') {
        json(res, 200, JSON.stringify({ ok: true, stopping: true }));
        return;
      }
      json(res, 200, healthBody());
    });

    const code = await stopCommand({ url, confirmTimeoutMs: 300, confirmPollMs: 50 });

    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/still/);
  });
});

describe('nonNegativeInt (--idle-timeout)', () => {
  it('accepts non-negative whole numbers', () => {
    expect(nonNegativeInt('60')).toBe(60);
    expect(nonNegativeInt('0')).toBe(0);
  });

  it('rejects values parseInt would silently truncate', () => {
    // `0.5` → 0 would disarm the timeout the user asked for; `60m` → 60 would
    // quietly mean something other than what was typed.
    expect(() => nonNegativeInt('0.5')).toThrow();
    expect(() => nonNegativeInt('60m')).toThrow();
  });

  it('rejects garbage and negatives', () => {
    expect(() => nonNegativeInt('abc')).toThrow();
    expect(() => nonNegativeInt('-5')).toThrow();
    expect(() => nonNegativeInt('')).toThrow();
  });
});

describe('formatUptime', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatUptime(12_000)).toBe('12s');
    expect(formatUptime(63_000)).toBe('1m 3s');
    expect(formatUptime(7_500_000)).toBe('2h 5m');
  });

  it('is NaN-safe for a malformed startedAt', () => {
    expect(formatUptime(NaN)).toBe('unknown');
    expect(formatUptime(-5)).toBe('unknown');
  });
});
