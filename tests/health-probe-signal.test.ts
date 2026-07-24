import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { probeHealth, HEALTH_SERVICE_ID } from '../src/server/health.js';

// ---------------------------------------------------------------------------
// `probeHealth` grew an optional AbortSignal so the MCP server can cut short a
// 20-second wait for a server it spawned when the agent host cancels the tool
// call underneath it.
//
// The trap worth pinning: an aborted fetch rejects, and the function folds
// every rejection into `{kind:'down'}`. That is right for the CLI callers,
// which pass no signal — but it means a polling caller that doesn't check
// `signal.aborted` first will report "the server never came up" when the truth
// is "you cancelled". These tests document that shape so it can't drift.
// ---------------------------------------------------------------------------

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** A server that never answers, so a probe can only end by timeout or abort. */
async function startSilentServer(): Promise<string> {
  server = createServer(() => {
    // deliberately no response
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

async function startHealthyServer(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: HEALTH_SERVICE_ID,
        version: '0.0.0-test',
        pid: 1,
        startedAt: new Date(0).toISOString(),
        openSessions: 0,
        runsInFlight: 0,
        inspector: null,
        idleTimeoutMinutes: null,
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('probeHealth with an AbortSignal', () => {
  it('still works when no signal is passed', async () => {
    const baseUrl = await startHealthyServer();
    const result = await probeHealth(baseUrl, 2000);

    expect(result.kind).toBe('ok');
  });

  it('accepts a signal and succeeds when nothing aborts', async () => {
    const baseUrl = await startHealthyServer();
    const controller = new AbortController();
    const result = await probeHealth(baseUrl, 2000, controller.signal);

    expect(result.kind).toBe('ok');
  });

  it('returns promptly when the caller aborts, well inside the timeout', async () => {
    const baseUrl = await startSilentServer();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const started = Date.now();
    // A 30s timeout the test would never wait out — so returning at all is
    // the assertion that the signal was honoured.
    const result = await probeHealth(baseUrl, 30_000, controller.signal);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    // Documented, and the reason callers must check `signal.aborted` first.
    expect(result.kind).toBe('down');
  });

  it('never throws, whichever way it ends', async () => {
    const controller = new AbortController();
    controller.abort();
    // Nothing is listening on this port, and the signal is already aborted:
    // both failure routes at once.
    await expect(
      probeHealth('http://127.0.0.1:1', 1000, controller.signal),
    ).resolves.toMatchObject({ kind: 'down' });
  });
});
