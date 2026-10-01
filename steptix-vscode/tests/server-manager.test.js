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
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AutoStartGuard,
  decideServerAction,
  defaultHealthProbe,
  describeHealth,
  describeServerVersion,
  isLoopbackUrl,
  readAutoStartSettings,
  readLogTail,
  startServerAndWait,
  HEALTH_SERVICE_ID,
} from '../src/extension/server-manager.ts';

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

test('probe: our server reads as healthy and carries the inspector url', async () => {
  const s = await stub((_req, res) => json(res, 200, healthJson()));
  try {
    const result = await defaultHealthProbe(s.url, 1000);
    assert.equal(result.kind, 'healthy');
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
    const result = await defaultHealthProbe(s.url, 1000);
    assert.equal(result.kind, 'healthy');
    assert.equal(result.health.inspector, null);
  } finally {
    await s.close();
  }
});

test('probe: a different service is FOREIGN (never spawn on top of it)', async () => {
  const s = await stub((_req, res) => json(res, 200, JSON.stringify({ service: 'grafana' })));
  try {
    const result = await defaultHealthProbe(s.url, 1000);
    assert.equal(result.kind, 'foreign');
    assert.equal(result.service, 'grafana');
  } finally {
    await s.close();
  }
});

test('probe: a 404 is UNKNOWN, not foreign — that is what an older Steptix server looks like', async () => {
  const s = await stub((_req, res) => json(res, 404, JSON.stringify({ error: 'Not Found' })));
  try {
    const result = await defaultHealthProbe(s.url, 1000);
    assert.equal(result.kind, 'unknown');
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
    assert.equal((await defaultHealthProbe(s1.url, 1000)).kind, 'unknown');
  } finally {
    await s1.close();
  }

  const s2 = await stub((_req, res) => json(res, 200, JSON.stringify({ ok: true })));
  try {
    const result = await defaultHealthProbe(s2.url, 1000);
    assert.equal(result.kind, 'unknown');
    assert.match(result.detail, /service/);
  } finally {
    await s2.close();
  }
});

test('probe: nothing listening is DOWN', async () => {
  const s = await stub(() => {});
  await s.close();
  const result = await defaultHealthProbe(s.url, 1000);
  assert.equal(result.kind, 'down');
});

test('probe: a DOWN detail names the refusal, not just "fetch failed"', async () => {
  // Node reports every transport failure as `TypeError: fetch failed` and
  // hides the reason on `cause`. The detail is what the run log prints for
  // "server down at <url> (<detail>)", so it has to carry the cause — the
  // port that refused — or the reader is left guessing which URL was tried
  // and why it did not answer.
  const s = await stub(() => {});
  await s.close();
  const port = new URL(s.url).port;
  const result = await defaultHealthProbe(s.url, 1000);
  assert.equal(result.kind, 'down');
  assert.match(result.detail, /ECONNREFUSED/);
  assert.match(result.detail, new RegExp(`:${port}`));
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

test('probe: a trailing slash on SERVER_URL does not produce //health', async () => {
  let seen = null;
  const s = await stub((req, res) => {
    seen = req.url;
    json(res, 200, healthJson());
  });
  try {
    await defaultHealthProbe(`${s.url}/`, 1000);
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
const config = (over = {}) => ({
  command: 'node server.js',
  cwd: '/repo',
  readyTimeoutSeconds: 1,
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
    sleep: noSleep,
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
    sleep: noSleep,
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
    sleep: noSleep,
  });
  assert.equal(result.kind, 'foreign');
  assert.equal(result.service, 'grafana');
});

test('start: a never-healthy server times out and quotes the log tail', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-log-'));
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
  const action = decideServerAction(LOCAL, { kind: 'down', detail: 'refused' }, CONFIGURED);
  assert.equal(action.kind, 'spawn');
  assert.deepEqual(action.config, CONFIGURED);
});

test('decide: down + REMOTE url ⇒ skip, however configured', () => {
  // The rule the manual Start Server command used to be missing: starting a
  // local server for a remote SERVER_URL produces one nothing will talk to.
  const action = decideServerAction('http://build-box:3100', { kind: 'down', detail: 'refused' }, CONFIGURED);
  assert.equal(action.kind, 'skip');
  assert.match(action.reason, /not a localhost URL/);
});

test('decide: down + no command ⇒ skip (auto-start is opt-in)', () => {
  const action = decideServerAction(LOCAL, { kind: 'down', detail: 'refused' }, {
    command: '',
    cwd: '',
    readyTimeoutSeconds: 20,
  });
  assert.equal(action.kind, 'skip');
  assert.match(action.reason, /serverAutoStart\.command/);
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

test('settings: values are trimmed and a bad timeout falls back to 20s', () => {
  assert.deepEqual(
    readAutoStartSettings(
      cfg({
        'serverAutoStart.command': '  node x.js  ',
        'serverAutoStart.cwd': ' /repo ',
        'serverAutoStart.readyTimeoutSeconds': -1,
      }),
    ),
    { command: 'node x.js', cwd: '/repo', readyTimeoutSeconds: 20 },
  );
});

test('settings: everything unset means auto-start is off', () => {
  const settings = readAutoStartSettings(cfg({}));
  assert.equal(settings.command, '');
  assert.equal(settings.cwd, '');
  assert.equal(settings.readyTimeoutSeconds, 20);
});

test('log tail: reads only the end of a large file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-log2-'));
  const logPath = path.join(dir, 'server.log');
  // 3 MB of noise plus a distinctive final line — the tail must not depend on
  // reading the whole file, which can be 5 MB by design.
  writeFileSync(logPath, `${'x'.repeat(3_000_000)}\nfinal line here\n`);
  assert.ok(statSync(logPath).size > 3_000_000);
  assert.match(readLogTail(logPath), /final line here/);
});

test('log tail: a missing or empty log yields undefined, never a throw', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-log3-'));
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
  ]) {
    assert.ok(props[key], `${key} must be declared`);
    assert.equal(props[key].scope, 'machine', `${key} must be machine-scoped`);
  }
});

test('log tail: does not include the whole file when it is short', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-log4-'));
  const logPath = path.join(dir, 'server.log');
  writeFileSync(logPath, ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'));
  const tail = readLogTail(logPath);
  assert.equal(tail, 'c | d | e | f | g'); // last 5 lines
  assert.equal(readFileSync(logPath, 'utf8').includes('a'), true);
});

test('describeServerVersion: the commit after the version, -dirty for uncommitted changes', () => {
  const h = { service: HEALTH_SERVICE_ID, version: '1.0.0-beta.1' };
  assert.equal(describeServerVersion({ ...h, commit: 'b700473', dirty: false }), '1.0.0-beta.1 (b700473)');
  assert.equal(describeServerVersion({ ...h, commit: 'b700473', dirty: true }), '1.0.0-beta.1 (b700473-dirty)');
  // Unknown commit, and a server predating the fields: the version alone.
  assert.equal(describeServerVersion({ ...h, commit: null, dirty: null }), '1.0.0-beta.1');
  assert.equal(describeServerVersion(h), '1.0.0-beta.1');
  assert.equal(describeServerVersion({ service: HEALTH_SERVICE_ID }), undefined);
});

test('describeHealth: the headline names the build', () => {
  const { headline } = describeHealth(LOCAL, {
    kind: 'healthy',
    health: { service: HEALTH_SERVICE_ID, version: '1.0.0-beta.1', commit: 'b700473', dirty: true },
  });
  assert.equal(headline, `Steptix server on ${LOCAL} — v1.0.0-beta.1 (b700473-dirty)`);
});
