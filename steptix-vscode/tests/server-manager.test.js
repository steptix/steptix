/**
 * Health-probe classification and the spawn/wait-until-healthy policy
 * (story server-lifecycle §5).
 *
 * The probe's four arms are the whole basis of the run path's decision tree,
 * and the difference between "foreign" and "unknown" is load-bearing: a
 * foreign service refuses the run (STX027), while an unidentifiable one — which
 * is what an older Steptix server whose Express 404s /health looks like — must
 * proceed on the legacy path instead.
 */
import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AutoStartGuard,
  compareVersions,
  decideServerAction,
  defaultHealthProbe,
  describeHealth,
  describeServerVersion,
  findInstalledRuntime,
  isLoopbackUrl,
  readAutoStartSettings,
  readLogTail,
  runtimeServeCommand,
  servePortOfCommand,
  startServerAndWait,
  HEALTH_SERVICE_ID,
} from '../src/extension/server-manager.ts';

/** A fresh temp dir, removed when the file is done. `maxRetries`: on Windows
 *  antivirus or the indexer can still hold a file written moments ago, and
 *  `force` does not cover EBUSY/EPERM. */
const made = [];
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Stand up a throwaway http server; returns { url, close }. */
async function stub(handler) {
  const server = createServer((req, res) => {
    req.resume(); // drain, so keep-alive survives for the next probe
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * A loopback URL that refuses connections for as long as it is held: the local
 * end of a client connection to a throwaway server. Nothing listens on that
 * port, so a probe gets a genuine ECONNREFUSED — and unlike a port a stub just
 * let go of, it stays in use until `release()`, so another listener cannot be
 * handed it mid-test and answer in its place.
 */
async function refusingPort() {
  const accepted = new Set();
  const server = createTcpServer((socket) => {
    socket.on('error', () => {});
    accepted.add(socket);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = connect(server.address().port, '127.0.0.1');
  client.on('error', () => {});
  await once(client, 'connect');
  return {
    url: `http://127.0.0.1:${client.localPort}`,
    port: client.localPort,
    release: async () => {
      client.destroy();
      for (const socket of accepted) socket.destroy();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

const healthJson = (over = {}) =>
  JSON.stringify({
    ok: true,
    service: HEALTH_SERVICE_ID,
    version: '1.2.3',
    pid: 42,
    openSessions: 0,
    runsInFlight: 0,
    inspector: 'ws://127.0.0.1:53012/abc',
    idleTimeoutMinutes: 60,
    ...over,
  });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
};

// ---------------------------------------------------------------------------
// defaultHealthProbe
// ---------------------------------------------------------------------------

/** The per-probe budget for every test that is not about the timeout. A
 *  loopback round trip takes milliseconds, but the first `fetch` in the
 *  process pays for undici's start-up and a loaded box can stall past a
 *  second — and a budget that fires turns every arm below into `down`. It
 *  only bounds a wait that ends early; the timeout itself is pinned at 50 ms
 *  in its own test. */
const PROBE_MS = 10_000;

test('probe: our server reads as healthy and carries the inspector url', async () => {
  const s = await stub((_req, res) => json(res, 200, healthJson()));
  try {
    const result = await defaultHealthProbe(s.url, PROBE_MS);
    assert.equal(result.kind, 'healthy', result.detail);
    assert.equal(result.health.inspector, 'ws://127.0.0.1:53012/abc');
    assert.equal(result.health.version, '1.2.3');
  } finally {
    await s.close();
  }
});

test('probe: inspector null survives as null, not undefined', async () => {
  // §7 treats the two differently — null means "no inspector, do not attach",
  // undefined means "no health data, use the settings".
  const s = await stub((_req, res) => json(res, 200, healthJson({ inspector: null })));
  try {
    const result = await defaultHealthProbe(s.url, PROBE_MS);
    assert.equal(result.kind, 'healthy', result.detail);
    assert.equal(result.health.inspector, null);
  } finally {
    await s.close();
  }
});

test('probe: a different service is FOREIGN (never spawn on top of it)', async () => {
  const s = await stub((_req, res) => json(res, 200, JSON.stringify({ service: 'grafana' })));
  try {
    const result = await defaultHealthProbe(s.url, PROBE_MS);
    assert.equal(result.kind, 'foreign', result.detail);
    assert.equal(result.service, 'grafana');
  } finally {
    await s.close();
  }
});

test('probe: a 404 is UNKNOWN, not foreign — that is what an older Steptix server looks like', async () => {
  const s = await stub((_req, res) => json(res, 404, JSON.stringify({ error: 'Not Found' })));
  try {
    const result = await defaultHealthProbe(s.url, PROBE_MS);
    assert.equal(result.kind, 'unknown', result.detail);
    assert.match(result.detail, /404/);
  } finally {
    await s.close();
  }
});

test('probe: non-JSON and JSON-without-service are both UNKNOWN', async () => {
  const s1 = await stub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>hi</html>');
  });
  try {
    const result = await defaultHealthProbe(s1.url, PROBE_MS);
    assert.equal(result.kind, 'unknown', result.detail);
  } finally {
    await s1.close();
  }

  const s2 = await stub((_req, res) => json(res, 200, JSON.stringify({ ok: true })));
  try {
    const result = await defaultHealthProbe(s2.url, PROBE_MS);
    assert.equal(result.kind, 'unknown', result.detail);
    assert.match(result.detail, /service/);
  } finally {
    await s2.close();
  }
});

test('probe: nothing listening is DOWN', async (t) => {
  const gone = await refusingPort();
  t.after(() => gone.release());
  const result = await defaultHealthProbe(gone.url, PROBE_MS);
  assert.equal(result.kind, 'down', result.detail);
});

test('probe: a DOWN detail names the refusal, not just "fetch failed"', async (t) => {
  // Node reports every transport failure as `TypeError: fetch failed` and
  // hides the reason on `cause`. The detail is what the run log prints for
  // "server down at <url> (<detail>)", so it has to carry the cause — the
  // port that refused — or the reader is left guessing which URL was tried
  // and why it did not answer.
  const gone = await refusingPort();
  t.after(() => gone.release());
  const result = await defaultHealthProbe(gone.url, PROBE_MS);
  assert.equal(result.kind, 'down', result.detail);
  assert.match(result.detail, /ECONNREFUSED/);
  assert.match(result.detail, new RegExp(`:${gone.port}`));
});

test('probe: a server that never answers is DOWN with a detail that says it timed out', async () => {
  const s = await stub(() => {
    /* never respond */
  });
  try {
    // Without a caller signal the timeout is the only way out; with one, the
    // timer still has to win. Both must say "timed out", not the generic
    // "This operation was aborted" that a user Stop also produces.
    const alone = await defaultHealthProbe(s.url, 50);
    assert.equal(alone.kind, 'down');
    assert.match(alone.detail, /no answer within 50 ms/);

    const combined = await defaultHealthProbe(s.url, 50, new AbortController().signal);
    assert.equal(combined.kind, 'down');
    assert.match(combined.detail, /no answer within 50 ms/);
  } finally {
    await s.close();
  }
});

test('probe: a trailing slash on STEPTIX_SERVER_URL does not produce //health', async () => {
  let seen = null;
  const s = await stub((req, res) => {
    seen = req.url;
    json(res, 200, healthJson());
  });
  try {
    await defaultHealthProbe(`${s.url}/`, PROBE_MS);
    assert.equal(seen, '/health');
  } finally {
    await s.close();
  }
});

test('probe: a caller abort ends it without needing AbortSignal.any', async () => {
  // Hand-rolled signal combination — AbortSignal.any needs Node 20.3+, and
  // VS Code 1.85 ships Node 18.
  const s = await stub(() => {
    /* never respond */
  });
  try {
    const ac = new AbortController();
    const probing = defaultHealthProbe(s.url, 30_000, ac.signal);
    ac.abort();
    assert.equal((await probing).kind, 'down');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// startServerAndWait
// ---------------------------------------------------------------------------

const noSleep = async () => {};
/**
 * Time that only the injected sleep moves, for the tests that are not about
 * the budget. Wall time then plays no part — a loaded box that takes seconds
 * over three probes cannot run the budget out — yet a loop that stopped
 * ending on its answer would still use up the fake budget and fail. (A clock
 * frozen at 0 would spin that loop forever on microtasks, past any test
 * timeout.)
 */
function fakeTime() {
  let clock = 0;
  return {
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}
const config = (over = {}) => ({
  command: 'node server.js',
  cwd: '/repo',
  // Far more polls than any test here needs, so the budget is never what
  // ends a test that is not about it.
  readyTimeoutSeconds: 60,
  ...over,
});

test('start: refuses without ever spawning when cwd is blank', async () => {
  let spawned = 0;
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config({ cwd: '' }),
    logPath: '/tmp/server.log',
    probe: async () => ({ kind: 'down', detail: 'refused' }),
    spawn: () => spawned++,
    sleep: noSleep,
  });
  assert.equal(result.kind, 'refused');
  assert.match(result.reason, /serverAutoStart\.cwd/);
  // The security property: a blank cwd must not fall back to anything.
  assert.equal(spawned, 0);
});

test('start: refuses without spawning when there is nowhere to write the log', async () => {
  let spawned = 0;
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config(),
    logPath: undefined,
    probe: async () => ({ kind: 'down', detail: 'refused' }),
    spawn: () => spawned++,
    sleep: noSleep,
  });
  assert.equal(result.kind, 'refused');
  assert.equal(spawned, 0);
});

test('start: spawns with the configured command/cwd/log and reports ready', async () => {
  const calls = [];
  let probes = 0;
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config(),
    logPath: '/tmp/server.log',
    probe: async () => {
      probes++;
      return probes < 3
        ? { kind: 'down', detail: 'not yet' }
        : { kind: 'healthy', health: { service: HEALTH_SERVICE_ID, inspector: 'ws://x:1/y' } };
    },
    spawn: (args) => calls.push(args),
    ...fakeTime(),
  });

  assert.deepEqual(calls, [{ command: 'node server.js', cwd: '/repo', logPath: '/tmp/server.log' }]);
  assert.equal(result.kind, 'ready');
  assert.equal(result.health.inspector, 'ws://x:1/y');
});

test('start: an unknown response keeps polling rather than giving up', async () => {
  // A server mid-boot can answer oddly for a moment; falling back to the
  // legacy path against a server we just started ourselves would be wrong.
  let probes = 0;
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config(),
    logPath: '/tmp/server.log',
    probe: async () => {
      probes++;
      return probes < 3
        ? { kind: 'unknown', detail: 'HTTP 502' }
        : { kind: 'healthy', health: { service: HEALTH_SERVICE_ID } };
    },
    spawn: () => {},
    ...fakeTime(),
  });
  assert.equal(result.kind, 'ready');
  assert.ok(probes >= 3);
});

test('start: a foreign service taking the port mid-start stops the attempt', async () => {
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config(),
    logPath: '/tmp/server.log',
    probe: async () => ({ kind: 'foreign', service: 'grafana' }),
    spawn: () => {},
    ...fakeTime(),
  });
  assert.equal(result.kind, 'foreign');
  assert.equal(result.service, 'grafana');
});

test('start: a never-healthy server times out and quotes the log tail', async () => {
  const dir = tempDir('tb-log-');
  const logPath = path.join(dir, 'server.log');
  writeFileSync(logPath, 'booting\nError: Cannot find module dist/index.js\n');

  // Fake clock: each sleep advances it, so the 20s budget elapses in a
  // handful of iterations instead of by wall-clock or by busy-spinning.
  let clock = 0;
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config({ readyTimeoutSeconds: 20 }),
    logPath,
    probe: async () => ({ kind: 'down', detail: 'refused' }),
    spawn: () => {},
    sleep: async (ms) => {
      clock += ms * 100; // 250ms poll → 25s of fake time per tick
    },
    now: () => clock,
  });

  assert.equal(result.kind, 'timeout');
  assert.equal(result.seconds, 20);
  assert.equal(result.logPath, logPath);
  // "see the log" is a much worse error than "see the log; it says X".
  assert.match(result.logTail, /Cannot find module/);
});

test('start: an abort during the poll reports aborted, not a failure', async () => {
  // Stop during the wait must yield an aborted run, never an STX028.
  const ac = new AbortController();
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config({ readyTimeoutSeconds: 30 }),
    logPath: '/tmp/server.log',
    probe: async () => ({ kind: 'down', detail: 'not yet' }),
    spawn: () => {},
    sleep: async () => ac.abort(),
    signal: ac.signal,
  });
  assert.equal(result.kind, 'aborted');
});

test('start: a spawn that throws is refused, not a timeout', async () => {
  const result = await startServerAndWait({
    serverUrl: 'http://127.0.0.1:3100',
    config: config(),
    logPath: '/tmp/server.log',
    probe: async () => ({ kind: 'down', detail: 'refused' }),
    spawn: () => {
      throw new Error('ENOENT');
    },
    sleep: noSleep,
  });
  assert.equal(result.kind, 'refused');
  assert.match(result.reason, /ENOENT/);
});

// ---------------------------------------------------------------------------
// decideServerAction — the triage BOTH the run path and Start Server use
// ---------------------------------------------------------------------------

const LOCAL = 'http://127.0.0.1:3100';
const CONFIGURED = { command: 'node x.js', cwd: '/repo', readyTimeoutSeconds: 20 };
/** Where the configured command listens — the same port as LOCAL. Passed as
 *  the `servePortOf` seam so no test reads this machine's .env. */
const SERVES_3100 = { ok: true, port: 3100, source: 'the default' };
const serves = (servePort) => () => servePort;
const noDiscovery = () => {
  throw new Error('a command setting must not look for a runtime');
};

test('decide: healthy ⇒ proceed, carrying the health through', () => {
  const health = { service: HEALTH_SERVICE_ID, inspector: 'ws://x:1/y' };
  const action = decideServerAction(LOCAL, { kind: 'healthy', health }, CONFIGURED);
  assert.equal(action.kind, 'proceed');
  assert.equal(action.health.inspector, 'ws://x:1/y');
});

test('decide: foreign ⇒ refuse, even when auto-start is configured', () => {
  const action = decideServerAction(LOCAL, { kind: 'foreign', service: 'grafana' }, CONFIGURED);
  assert.deepEqual(action, { kind: 'refuse-foreign', service: 'grafana' });
});

test('decide: unknown ⇒ legacy (never refuse, never spawn)', () => {
  const action = decideServerAction(LOCAL, { kind: 'unknown', detail: 'HTTP 404' }, CONFIGURED);
  assert.equal(action.kind, 'legacy');
});

test('decide: down + localhost + configured ⇒ spawn', () => {
  const action = decideServerAction(
    LOCAL,
    { kind: 'down', detail: 'refused' },
    CONFIGURED,
    noDiscovery,
    serves(SERVES_3100),
  );
  assert.equal(action.kind, 'spawn');
  assert.deepEqual(action.config, CONFIGURED);
});

test('decide: down + REMOTE url ⇒ skip, however configured', () => {
  // The rule the manual Start Server command used to be missing: starting a
  // local server for a remote STEPTIX_SERVER_URL produces one nothing will talk to.
  const action = decideServerAction('http://build-box:3100', { kind: 'down', detail: 'refused' }, CONFIGURED);
  assert.equal(action.kind, 'skip');
  assert.match(action.reason, /not a localhost URL/);
});

test('decide: down + the command would listen on another port ⇒ refuse-port, never spawn', () => {
  // stories/machine-server-url.md: a project pointing at 3104 while the
  // command starts on 3100 would leave a stray server and time out (STX028).
  const action = decideServerAction(
    'http://localhost:3104',
    { kind: 'down', detail: 'refused' },
    CONFIGURED,
    noDiscovery,
    serves(SERVES_3100),
  );
  assert.deepEqual(action, { kind: 'refuse-port', servePort: SERVES_3100 });
});

test('decide: down + the command would not start at all ⇒ refuse-port carrying why', () => {
  const servePort = { ok: false, reason: 'STEPTIX_SERVER_URL in /m/.env has no port: "http://x"' };
  const action = decideServerAction(LOCAL, { kind: 'down', detail: 'refused' }, CONFIGURED, noDiscovery, serves(servePort));
  assert.deepEqual(action, { kind: 'refuse-port', servePort });
});

test('decide: a URL with no port is compared as its scheme default', () => {
  const action = decideServerAction(
    'http://localhost',
    { kind: 'down', detail: 'refused' },
    CONFIGURED,
    noDiscovery,
    serves({ ok: true, port: 80, source: '-p' }),
  );
  assert.equal(action.kind, 'spawn');
});

test('decide: a command whose port cannot be read is started, not refused', () => {
  // A wrapper script may pin the right port; only a visible mismatch refuses.
  const action = decideServerAction(
    'http://localhost:3104',
    { kind: 'down', detail: 'refused' },
    CONFIGURED,
    noDiscovery,
    () => null,
  );
  assert.equal(action.kind, 'spawn');
});

test('decide: a running server is used whatever port the command would pick', () => {
  // The port check only guards a spawn; it must never refuse a healthy server.
  const health = { service: HEALTH_SERVICE_ID };
  const asked = [];
  const action = decideServerAction('http://localhost:3104', { kind: 'healthy', health }, CONFIGURED, noDiscovery, (c) => {
    asked.push(c);
    return SERVES_3100;
  });
  assert.equal(action.kind, 'proceed');
  assert.deepEqual(asked, [], 'the port is worked out only for a spawn');
});

const UNCONFIGURED = { command: '', cwd: '', readyTimeoutSeconds: 20, useInstalledRuntime: true };
const DOWN = { kind: 'down', detail: 'refused' };
const RUNTIMES_DIR = path.resolve(path.sep, 'lad', 'steptix', 'runtimes');
const RUNTIME = { version: '1.0.0-beta.1', dir: path.join(RUNTIMES_DIR, '1.0.0-beta.1') };
/** A discovery that finds `runtime`, counting how often it was asked. */
function discovery(runtime) {
  const fn = () => {
    fn.calls++;
    return { runtimesDir: RUNTIMES_DIR, runtime };
  };
  fn.calls = 0;
  return fn;
}

test('decide: down + no command + no runtime installed ⇒ skip, naming where it looked', () => {
  const action = decideServerAction(LOCAL, DOWN, UNCONFIGURED, discovery(null));
  assert.equal(action.kind, 'skip');
  assert.match(action.reason, /serverAutoStart\.command/);
  assert.ok(action.reason.includes(RUNTIMES_DIR), action.reason);
});

test('decide: down + no command + a runtime installed ⇒ spawn that runtime on the URL\'s port', () => {
  const action = decideServerAction('http://127.0.0.1:3207', DOWN, UNCONFIGURED, discovery(RUNTIME));
  assert.equal(action.kind, 'spawn');
  assert.deepEqual(action.runtime, RUNTIME);
  assert.equal(action.config.cwd, RUNTIME.dir, 'the runtime starts in its own folder');
  assert.equal(action.config.readyTimeoutSeconds, 20);
  assert.match(action.config.command, /serve --port 3207 --idle-timeout 60$/);
});

test('decide: a command setting wins over an installed runtime, which is not even looked for', () => {
  const discover = discovery(RUNTIME);
  const action = decideServerAction(
    LOCAL,
    DOWN,
    { ...CONFIGURED, useInstalledRuntime: true },
    discover,
    serves(SERVES_3100),
  );
  assert.equal(action.kind, 'spawn');
  assert.deepEqual(action.config, CONFIGURED);
  assert.equal(action.runtime, undefined);
  assert.equal(discover.calls, 0);
});

test('decide: the installed runtime is never port-checked — its command passes the URL\'s port', () => {
  const action = decideServerAction('http://127.0.0.1:3207', DOWN, UNCONFIGURED, discovery(RUNTIME), () => {
    throw new Error('the runtime command must not be port-checked');
  });
  assert.equal(action.kind, 'spawn');
});

test('decide: useInstalledRuntime off ⇒ skip, however many runtimes are installed', () => {
  const discover = discovery(RUNTIME);
  const action = decideServerAction(LOCAL, DOWN, { ...UNCONFIGURED, useInstalledRuntime: false }, discover);
  assert.equal(action.kind, 'skip');
  assert.match(action.reason, /useInstalledRuntime/);
  assert.equal(discover.calls, 0);
});

test('decide: a healthy server costs no runtime scan, and a REMOTE url never starts the runtime', () => {
  const discover = discovery(RUNTIME);
  decideServerAction(LOCAL, { kind: 'healthy', health: { service: HEALTH_SERVICE_ID } }, UNCONFIGURED, discover);
  const remote = decideServerAction('http://build-box:3100', DOWN, UNCONFIGURED, discover);
  assert.equal(remote.kind, 'skip');
  assert.equal(discover.calls, 0);
});

/** Point the machine `.env` at a temp dir for `fn`, holding `content` (or no file). */
function withMachineEnv(content, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-machine-env-'));
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.LOCALAPPDATA = dir;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    if (content !== null) {
      mkdirSync(path.join(dir, 'steptix'), { recursive: true });
      writeFileSync(path.join(dir, 'steptix', '.env'), content);
    }
    return fn(path.join(dir, 'steptix', '.env'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test('servePortOfCommand: a -p / --port after serve wins, in every spelling', () => {
  withMachineEnv('STEPTIX_SERVER_URL=http://127.0.0.1:3200\n', () => {
    for (const command of [
      'node dist/index.js serve -p 3104 --idle-timeout 60',
      'node dist/index.js serve --port 3104',
      'node dist/index.js serve --port=3104',
      'node dist/index.js serve -p3104',
    ]) {
      const result = servePortOfCommand(command);
      assert.equal(result.ok, true, command);
      assert.equal(result.port, 3104, command);
      assert.match(result.source, /serverAutoStart\.command/, command);
    }
  });
});

test('servePortOfCommand: a launcher flag before serve is not the server port', () => {
  // `npx -p <pkg>` names a package; only flags after `serve` belong to it.
  withMachineEnv(null, () => {
    assert.deepEqual(servePortOfCommand('npx -p 5 steptix serve --idle-timeout 60'), {
      ok: true,
      port: 3100,
      source: 'the default',
    });
  });
});

test('servePortOfCommand: null when the command does not say where it listens', () => {
  withMachineEnv(null, () => {
    // No `serve` argument of its own: a script that may pin any port.
    assert.equal(servePortOfCommand('npm run serve:dev'), null);
    assert.equal(servePortOfCommand('cmd /c start-server.cmd'), null);
    // A port that is not a number until a shell expands it.
    assert.equal(servePortOfCommand('node dist/index.js serve --port $PORT'), null);
    assert.equal(servePortOfCommand('node dist/index.js serve -p %PORT%'), null);
  });
});

test('servePortOfCommand: a quoted launcher path still finds serve and its -p', () => {
  withMachineEnv(null, () => {
    const result = servePortOfCommand('"C:\\Program Files\\steptix\\steptix.cmd" serve -p 3104 --idle-timeout 60');
    assert.equal(result?.ok && result.port, 3104);
  });
});

test('servePortOfCommand: no -p ⇒ the machine STEPTIX_SERVER_URL port, else 3100', () => {
  const bare = 'node --inspect=0 dist/index.js serve --idle-timeout 60';
  withMachineEnv(null, () => {
    assert.deepEqual(servePortOfCommand(bare), { ok: true, port: 3100, source: 'the default' });
  });
  withMachineEnv('STEPTIX_SERVER_URL=http://localhost:3200\n', (envPath) => {
    assert.deepEqual(servePortOfCommand(bare), {
      ok: true,
      port: 3200,
      source: `STEPTIX_SERVER_URL in ${envPath}`,
    });
  });
  withMachineEnv('STEPTIX_SERVER_URL=http://localhost\n', () => {
    const result = servePortOfCommand(bare);
    assert.equal(result.ok, false);
    assert.match(result.reason, /has no port/);
  });
});

// ---------------------------------------------------------------------------
// The installed runtime
// ---------------------------------------------------------------------------

/** A runtimes folder holding `versions`, each with the files named (default:
 *  everything a startable runtime has on any platform). */
function runtimesFolder(versions, files = ['runtime-launcher.cjs', 'server/dist/index.js', 'steptix.cmd']) {
  const dir = tempDir('steptix-runtimes-');
  for (const version of versions) {
    for (const file of files) {
      const full = path.join(dir, version, ...file.split('/'));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, '');
    }
  }
  return dir;
}

test('runtime: the newest version wins, by semver rather than by spelling', () => {
  const dir = runtimesFolder(['1.0.0-beta.2', '1.0.0-beta.10', '0.9.0', '1.0.0-alpha.3']);
  const runtime = findInstalledRuntime(dir);
  assert.deepEqual(runtime, { version: '1.0.0-beta.10', dir: path.join(dir, '1.0.0-beta.10') });
});

test('runtime: a release outranks its prereleases', () => {
  const dir = runtimesFolder(['1.0.0-beta.1', '1.0.0', '1.0.0-rc.1']);
  assert.equal(findInstalledRuntime(dir).version, '1.0.0');
});

test('runtime: a folder missing a launch file is skipped — the leftovers of an unfinished uninstall', () => {
  const dir = runtimesFolder(['1.0.0-beta.1']);
  // A newer folder an uninstall could not finish removing: its server is gone.
  mkdirSync(path.join(dir, '1.0.0-beta.2'), { recursive: true });
  writeFileSync(path.join(dir, '1.0.0-beta.2', 'runtime-launcher.cjs'), '');
  assert.equal(findInstalledRuntime(dir).version, '1.0.0-beta.1');
});

test('runtime: steptix.cmd is required on Windows only', () => {
  const dir = runtimesFolder(['1.0.0'], ['runtime-launcher.cjs', 'server/dist/index.js']);
  assert.equal(findInstalledRuntime(dir, 'win32'), null);
  assert.equal(findInstalledRuntime(dir, 'linux').version, '1.0.0');
  assert.equal(findInstalledRuntime(dir, 'darwin').version, '1.0.0');
});

test('runtime: no runtimes folder at all is null, not a throw', () => {
  assert.equal(findInstalledRuntime(path.join(tmpdir(), 'steptix-no-such-runtimes-dir')), null);
});

test('compareVersions: semver precedence, and names that are not versions sort first', () => {
  const sorted = ['1.0.0', 'scratch', '1.0.0-beta.2', '1.0.0-beta', '0.10.0', '1.0.0-beta.11', '0.9.9', '1.0.0-beta.alpha']
    .sort(compareVersions);
  assert.deepEqual(sorted, [
    'scratch',
    '0.9.9',
    '0.10.0',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-beta.alpha',
    '1.0.0',
  ]);
});

test('runtime command: Windows goes through steptix.cmd, quoted for a path with spaces', () => {
  const runtime = { version: '1.0.0', dir: path.join(tmpdir(), 'local app data', 'steptix', 'runtimes', '1.0.0') };
  assert.equal(
    runtimeServeCommand(runtime, 'http://localhost:3100', { platform: 'win32' }),
    `"${path.join(runtime.dir, 'steptix.cmd')}" serve --port 3100 --idle-timeout 60`,
  );
});

test('runtime command: elsewhere the launcher runs under Node — STEPTIX_NODE when set, as steptix.cmd does', () => {
  const runtime = { version: '1.0.0', dir: path.join(tmpdir(), "it's here", '1.0.0') };
  const launcher = path.join(runtime.dir, 'runtime-launcher.cjs').replace(/'/g, `'\\''`);
  assert.equal(
    runtimeServeCommand(runtime, 'http://127.0.0.1:3200/', { platform: 'linux', env: {} }),
    `'node' '${launcher}' serve --port 3200 --idle-timeout 60`,
  );
  assert.equal(
    runtimeServeCommand(runtime, 'http://127.0.0.1:3200', { platform: 'darwin', env: { STEPTIX_NODE: '/opt/node 22/bin/node' } }),
    `'/opt/node 22/bin/node' '${launcher}' serve --port 3200 --idle-timeout 60`,
  );
});

test('runtime command: a URL with no port starts the server on its scheme\'s', () => {
  const runtime = { version: '1.0.0', dir: path.join(tmpdir(), '1.0.0') };
  assert.match(runtimeServeCommand(runtime, 'http://localhost', { platform: 'linux', env: {} }), /--port 80 /);
});

test('isLoopbackUrl accepts both IPv6 loopback spellings', () => {
  // `new URL('http://[::1]:3100').hostname` keeps the brackets — the form
  // that was silently reading as remote before these were unified.
  for (const url of ['http://127.0.0.1:1', 'http://localhost:1', 'http://[::1]:1']) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of ['http://build-box:1', 'http://10.0.0.5:1', 'not a url']) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});

test('describeHealth: the unknown arm must not claim the port is foreign', () => {
  // §5.4/§6: an older Steptix server without /health looks exactly like this,
  // and runs against it still work.
  const { headline, detail, warn } = describeHealth(LOCAL, { kind: 'unknown', detail: 'HTTP 404' });
  assert.match(`${headline} ${detail}`, /older Steptix server/);
  assert.match(`${headline} ${detail}`, /runs will still be attempted/i);
  assert.equal(warn, true);
});

test('describeHealth: the foreign arm says runs are refused', () => {
  const { detail, warn } = describeHealth(LOCAL, { kind: 'foreign', service: 'grafana' });
  assert.match(detail, /refused/);
  assert.equal(warn, true);
});

test('describeHealth: a healthy server is not a warning', () => {
  const { warn, detail } = describeHealth(LOCAL, {
    kind: 'healthy',
    health: { service: HEALTH_SERVICE_ID, inspector: null, idleTimeoutMinutes: null },
  });
  assert.equal(warn, false);
  assert.match(detail, /inspector: none/);
  assert.match(detail, /idle timeout: off/);
});

// ---------------------------------------------------------------------------
// AutoStartGuard — stops a broken command becoming a per-test spawn storm
// ---------------------------------------------------------------------------

test('guard: a recent failure suppresses the next attempt for the same URL', () => {
  // The scenario: a 40-test Test Explorer batch with `dist/` unbuilt. Each
  // test re-runs the pre-run phase, so without this every one spawns its own
  // detached shell and stalls for readyTimeoutSeconds.
  let clock = 0;
  const guard = new AutoStartGuard(() => clock);

  assert.equal(guard.isSuppressed(LOCAL), false);
  guard.recordFailure(LOCAL);
  assert.equal(guard.isSuppressed(LOCAL), true);
});

test('guard: suppression is per-URL', () => {
  const guard = new AutoStartGuard(() => 0);
  guard.recordFailure(LOCAL);
  assert.equal(guard.isSuppressed('http://127.0.0.1:4000'), false);
});

test('guard: suppression lapses, so fixing the build and re-running works', () => {
  let clock = 0;
  const guard = new AutoStartGuard(() => clock);
  guard.recordFailure(LOCAL);
  clock += 60_001;
  assert.equal(guard.isSuppressed(LOCAL), false);
});

test('guard: a success clears it immediately — no waiting out the backoff', () => {
  const guard = new AutoStartGuard(() => 0);
  guard.recordFailure(LOCAL);
  guard.clear(LOCAL);
  assert.equal(guard.isSuppressed(LOCAL), false);
});

// ---------------------------------------------------------------------------
// settings + log tail
// ---------------------------------------------------------------------------

/** Minimal stand-in for vscode's WorkspaceConfiguration. */
const cfg = (values) => ({
  get: (key, fallback) => (key in values ? values[key] : fallback),
});

test('settings: values are trimmed and a bad timeout falls back to 60s', () => {
  assert.deepEqual(
    readAutoStartSettings(
      cfg({
        'serverAutoStart.command': '  node x.js  ',
        'serverAutoStart.cwd': ' /repo ',
        'serverAutoStart.readyTimeoutSeconds': -1,
      }),
    ),
    { command: 'node x.js', cwd: '/repo', readyTimeoutSeconds: 60, useInstalledRuntime: true },
  );
});

test('settings: everything unset means no command, and the installed runtime is used', () => {
  const settings = readAutoStartSettings(cfg({}));
  assert.equal(settings.command, '');
  assert.equal(settings.cwd, '');
  assert.equal(settings.readyTimeoutSeconds, 60);
  assert.equal(settings.useInstalledRuntime, true);
  assert.equal(
    readAutoStartSettings(cfg({ 'serverAutoStart.useInstalledRuntime': false })).useInstalledRuntime,
    false,
  );
});

test('log tail: reads only the end of a large file', () => {
  const dir = tempDir('tb-log2-');
  const logPath = path.join(dir, 'server.log');
  // 3 MB of noise plus a distinctive final line — the tail must not depend on
  // reading the whole file, which can be 5 MB by design.
  writeFileSync(logPath, `${'x'.repeat(3_000_000)}\nfinal line here\n`);
  assert.ok(statSync(logPath).size > 3_000_000);
  assert.match(readLogTail(logPath), /final line here/);
});

test('log tail: a missing or empty log yields undefined, never a throw', () => {
  const dir = tempDir('tb-log3-');
  assert.equal(readLogTail(path.join(dir, 'nope.log')), undefined);
  const empty = path.join(dir, 'empty.log');
  writeFileSync(empty, '');
  assert.equal(readLogTail(empty), undefined);
});

// ---------------------------------------------------------------------------
// contributes.configuration — a security property, not a preference
// ---------------------------------------------------------------------------

test('the serverAutoStart settings are machine-scoped in contributes.configuration', () => {
  // §5: the extension executes `command` verbatim, so a workspace-settable
  // value would let any cloned repo run arbitrary code the moment the user
  // pressed Run. Only VS Code enforces this, from the manifest — nothing in
  // the extension's own code can, which is exactly why it needs an assertion.
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const props = manifest.contributes.configuration.properties;
  for (const key of [
    'steptix.serverAutoStart.command',
    'steptix.serverAutoStart.cwd',
    'steptix.serverAutoStart.readyTimeoutSeconds',
    'steptix.serverAutoStart.useInstalledRuntime',
  ]) {
    assert.ok(props[key], `${key} must be declared`);
    assert.equal(props[key].scope, 'machine', `${key} must be machine-scoped`);
  }
});

test('log tail: does not include the whole file when it is short', () => {
  const dir = tempDir('tb-log4-');
  const logPath = path.join(dir, 'server.log');
  writeFileSync(logPath, ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'));
  const tail = readLogTail(logPath);
  assert.equal(tail, 'c | d | e | f | g'); // last 5 lines; a and b are dropped
});

test('describeServerVersion: the commit after the version, and modified for uncommitted changes', () => {
  const h = { service: HEALTH_SERVICE_ID, version: '1.0.0-beta.1' };
  assert.equal(describeServerVersion({ ...h, commit: 'b700473', modified: false }), '1.0.0-beta.1 (b700473)');
  assert.equal(describeServerVersion({ ...h, commit: 'b700473', modified: true }), '1.0.0-beta.1 (b700473, modified)');
  // Unknown commit, and a server predating the fields: the version alone.
  assert.equal(describeServerVersion({ ...h, commit: null, modified: null }), '1.0.0-beta.1');
  assert.equal(describeServerVersion(h), '1.0.0-beta.1');
  assert.equal(describeServerVersion({ service: HEALTH_SERVICE_ID }), undefined);
});

test('describeHealth: the headline names the build', () => {
  const { headline } = describeHealth(LOCAL, {
    kind: 'healthy',
    health: { service: HEALTH_SERVICE_ID, version: '1.0.0-beta.1', commit: 'b700473', modified: true },
  });
  // The build as describeServerVersion spells it (all four forms are pinned
  // above), and the URL it was found on. The words around them are free to
  // change: no doc or spec quotes this sentence.
  assert.match(headline, /v1\.0\.0-beta\.1 \(b700473, modified\)/);
  assert.ok(headline.includes(LOCAL), headline);
});
