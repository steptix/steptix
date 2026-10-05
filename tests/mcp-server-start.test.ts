import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ensureServerReadyWith } from '../src/mcp/server-start.js';
import { lastStartFailure, resetRegistry } from '../src/mcp/registry.js';
import { PreflightFailure } from '../src/mcp/types.js';
import { HEALTH_SERVICE_ID } from '../src/server/health.js';

// ---------------------------------------------------------------------------
// Harness
//
// Nothing here starts a real server. `probe` and `spawn` are injected, and the
// clock is fake so the 20 s poll and the 60 s backoff are reachable in
// microseconds instead of by waiting.
//
// `spawn` is faked at the raw `child_process` level rather than behind a
// "start the server" helper, because the argv and the option bag ARE the
// contract this workstream owns: the normalized --host, shell:false, the
// composed env, the log fds and the `unref()` call.
// ---------------------------------------------------------------------------

const OK_HEALTH = {
  kind: 'ok' as const,
  health: {
    ok: true as const,
    service: HEALTH_SERVICE_ID,
    version: '1.0.0',
    pid: 4242,
    startedAt: new Date().toISOString(),
    openSessions: 0,
    runsInFlight: 0,
    inspector: 'ws://127.0.0.1:9229/abc',
    idleTimeoutMinutes: 60,
  },
};
const DOWN = { kind: 'down' as const, detail: 'connect ECONNREFUSED 127.0.0.1:3100' };

interface FakeChild {
  command: string;
  args: readonly string[];
  options: Record<string, any>;
  handlers: Record<string, (err: Error) => void>;
  unrefCalled: boolean;
  on(event: string, fn: (err: Error) => void): FakeChild;
  unref(): void;
}

let root: string;
let distEntry: string;
let logPath: string;

function makeHarness() {
  const spawns: FakeChild[] = [];
  let resolveSpawned: () => void = () => {};
  const spawned = new Promise<void>((resolve) => {
    resolveSpawned = resolve;
  });

  const h = {
    /** Flipped by a test to make the next probe report a live server. */
    up: false,
    clock: 0,
    spawns,
    spawned,
    /** Swapped wholesale by tests that need an `unrecognized` arm. */
    probeImpl: (): any => (h.up ? OK_HEALTH : DOWN),
    advance(ms: number) {
      h.clock += ms;
    },
    deps: {
      probe: vi.fn(async () => h.probeImpl()),
      spawn: vi.fn((command: string, args: readonly string[], options: any) => {
        const child: FakeChild = {
          command,
          args,
          options,
          handlers: {},
          unrefCalled: false,
          on(event, fn) {
            child.handlers[event] = fn;
            return child;
          },
          unref() {
            child.unrefCalled = true;
          },
        };
        spawns.push(child);
        resolveSpawned();
        return child;
      }),
      // Advancing the clock inside `sleep` is what makes the poll terminate:
      // 20 s of budget is 80 iterations, each one macrotask long.
      sleep: async (ms: number) => {
        h.clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => h.clock,
      get distEntry() {
        return distEntry;
      },
    },
  };
  return h;
}

function makeProject(overrides: Record<string, unknown> = {}): any {
  return {
    projectRoot: root,
    configPath: path.join(root, 'steptix.config.json'),
    env: {
      SERVER_URL: 'http://localhost:3100',
      STEPTIX_SERVER_API_KEY: 'project-key',
      AI_API_KEY: 'ai-secret',
    },
    envName: null,
    serverUrl: 'http://localhost:3100',
    apiKey: 'project-key',
    skillsDir: null,
    toolsDir: null,
    envFilesConsulted: [path.join(root, '.env')],
    ...overrides,
  };
}

/** The text of a `PreflightFailure`'s ready-made tool error. */
function text(err: unknown): string {
  expect(err).toBeInstanceOf(PreflightFailure);
  return (err as PreflightFailure).toolError.content[0]!.text;
}

/** File content, or null when it does not exist. */
function readFileSyncOptional(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject, but it resolved');
    },
    (err: unknown) => err,
  );
}

let userRootTmp: string;
const savedUserRoot: Record<string, string | undefined> = {};

beforeEach(() => {
  resetRegistry();
  root = mkdtempSync(path.join(tmpdir(), 'steptix-mcp-start-'));
  distEntry = path.join(root, 'dist-index.js');
  writeFileSync(distEntry, '// stand-in for dist/index.js\n');
  logPath = path.join(root, '.steptix', 'mcp-server.log');
  process.env['STEPTIX_TEST_INHERITED'] = 'from-parent';
  // The arm-4 fill writes a generated machine key to the user root — point
  // it into this test's tmp dir, never the real %LOCALAPPDATA%\steptix.
  userRootTmp = mkdtempSync(path.join(tmpdir(), 'steptix-user-root-'));
  for (const key of ['LOCALAPPDATA', 'XDG_CONFIG_HOME'] as const) {
    savedUserRoot[key] = process.env[key];
    process.env[key] = userRootTmp;
  }
});

afterEach(() => {
  delete process.env['STEPTIX_TEST_INHERITED'];
  for (const [key, value] of Object.entries(savedUserRoot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(userRootTmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The decision tree
// ---------------------------------------------------------------------------

describe('ensureServerReady — probe arms', () => {
  it('proceeds without spawning when the server is already ours', async () => {
    const h = makeHarness();
    h.up = true;

    await expect(ensureServerReadyWith(makeProject(), undefined, h.deps)).resolves.toBeUndefined();
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });

  it('refuses an unrecognized service without spawning or leaking the key', async () => {
    const h = makeHarness();
    h.probeImpl = () => ({ kind: 'unrecognized', detail: 'service is "grafana", not "steptix"' });

    const err = await failure(ensureServerReadyWith(makeProject(), undefined, h.deps));

    expect(text(err)).toContain('3100');
    expect(text(err)).toContain('grafana');
    // Arm 2 exists precisely so the next request — which carries
    // STEPTIX_SERVER_API_KEY and the whole composed .env — is never sent.
    expect(h.deps.spawn).not.toHaveBeenCalled();
    expect(text(err)).not.toContain('project-key');
    expect(text(err)).not.toContain('ai-secret');
  });

  it('refuses a down remote server instead of starting a local one', async () => {
    const h = makeHarness();
    const project = makeProject({ serverUrl: 'http://192.168.1.50:3100' });

    const err = await failure(ensureServerReadyWith(project, undefined, h.deps));

    expect(text(err)).toContain('192.168.1.50:3100');
    expect(text(err)).toContain('loopback');
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });

  it('refuses a healthy server when no source had a key — never generates for it', async () => {
    // stories/machine-key.md: a running server holds whatever key it was
    // started with; a generated one would just manufacture a 401.
    const h = makeHarness();
    h.up = true;
    const project = makeProject({ apiKey: null });

    const err = await failure(ensureServerReadyWith(project, undefined, h.deps));

    expect(text(err)).toContain('already');
    expect(text(err)).toMatch(/steptix[\\/]\.env/); // names the file to write
    expect(h.deps.spawn).not.toHaveBeenCalled();
    // No key was invented behind the refusal's back.
    expect(readFileSyncOptional(path.join(userRootTmp, 'steptix', '.env'))).toBe(null);
  });

  it('arm 4 with no key generates one, persists it, and spawns the child with it', async () => {
    const h = makeHarness();
    const project = makeProject({ apiKey: null });

    const ready = ensureServerReadyWith(project, undefined, h.deps);
    await h.spawned;
    h.up = true;
    await ready;

    // The generated key is persisted where every other client will read it…
    const written = readFileSyncOptional(path.join(userRootTmp, 'steptix', '.env'));
    expect(written).toMatch(/STEPTIX_SERVER_API_KEY=steptix_[0-9a-f]{64}/);
    // …the project now carries it for the requests that follow…
    expect(project.apiKey).toMatch(/^steptix_[0-9a-f]{64}$/);
    // …and the child was spawned with the SAME key, so both sides agree.
    const env = h.spawns[0]!.options.env as Record<string, string>;
    expect(env['STEPTIX_SERVER_API_KEY']).toBe(project.apiKey);
  });

  it('does not spawn for an aborted call, even though an aborted probe reads as down', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();

    const err = await failure(ensureServerReadyWith(makeProject(), controller.signal, h.deps));

    expect(err).not.toBeInstanceOf(PreflightFailure);
    expect((err as Error).name).toBe('AbortError');
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SERVER_URL validation
// ---------------------------------------------------------------------------

describe('ensureServerReady — SERVER_URL validation', () => {
  it('refuses a path-bearing URL before probing at all', async () => {
    const h = makeHarness();
    h.up = true;
    const project = makeProject({ serverUrl: 'http://localhost:3100/api' });

    const err = await failure(ensureServerReadyWith(project, undefined, h.deps));

    expect(text(err)).toContain('/api');
    // Not merely "did not spawn": probing it would append /health to the path,
    // 404, and report the port as foreign.
    expect(h.deps.probe).not.toHaveBeenCalled();
  });

  it('accepts an https URL that is answering — the check is spawn-time only', async () => {
    const h = makeHarness();
    h.up = true;
    const project = makeProject({ serverUrl: 'https://steptix.internal.example' });

    await expect(ensureServerReadyWith(project, undefined, h.deps)).resolves.toBeUndefined();
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });

  it('refuses to spawn for a down https URL', async () => {
    const h = makeHarness();
    const project = makeProject({ serverUrl: 'https://localhost:3100' });

    const err = await failure(ensureServerReadyWith(project, undefined, h.deps));

    expect(text(err)).toContain('https:');
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });

  it('refuses to spawn for a portless URL rather than defaulting to 80', async () => {
    const h = makeHarness();
    const project = makeProject({ serverUrl: 'http://localhost' });

    const err = await failure(ensureServerReadyWith(project, undefined, h.deps));

    expect(text(err)).toContain('no port');
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });

  it('refuses a SERVER_URL that is not a URL at all', async () => {
    const h = makeHarness();

    const err = await failure(
      ensureServerReadyWith(makeProject({ serverUrl: 'localhost:3100' }), undefined, h.deps),
    );

    expect(text(err)).toContain('localhost:3100');
    expect(h.deps.probe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The spawn recipe
// ---------------------------------------------------------------------------

describe('ensureServerReady — the spawn', () => {
  async function coldStart(project = makeProject()) {
    const h = makeHarness();
    const promise = ensureServerReadyWith(project, undefined, h.deps);
    await h.spawned;
    h.up = true;
    await promise;
    return h;
  }

  it('runs this package with --inspect=0 and the normalized loopback host', async () => {
    const h = await coldStart();

    expect(h.spawns).toHaveLength(1);
    const child = h.spawns[0]!;
    expect(child.command).toBe(process.execPath);
    expect(child.args).toEqual([
      '--inspect=0',
      distEntry,
      'serve',
      // `localhost` would resolve via dns.lookup to ::1 first on a dual-stack
      // Windows box, leaving a server `steptix status`/`steptix stop` cannot see.
      '--host',
      '127.0.0.1',
      '--port',
      '3100',
      '--idle-timeout',
      '60',
    ]);
  });

  it('strips the brackets from an IPv6 loopback host', async () => {
    const h = await coldStart(makeProject({ serverUrl: 'http://[::1]:3100' }));

    expect(h.spawns[0]!.args).toContain('::1');
    expect(h.spawns[0]!.args).not.toContain('[::1]');
  });

  it('spawns detached, hidden, without a shell, in the project root', async () => {
    const h = await coldStart();
    const options = h.spawns[0]!.options;

    expect(options.cwd).toBe(root);
    expect(options.detached).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.stdio[0]).toBe('ignore');
    expect(typeof options.stdio[1]).toBe('number');
    expect(options.stdio[2]).toBe(options.stdio[1]);
  });

  it('attaches an error listener and unrefs the child', async () => {
    const h = await coldStart();

    // Without the listener Node rethrows a spawn failure as an uncaught
    // exception, which in an MCP server drops the host connection.
    expect(typeof h.spawns[0]!.handlers['error']).toBe('function');
    // `unref` is a call, not a spawn option: without it this process would
    // never exit on stdin close while the server it started is alive.
    expect(h.spawns[0]!.unrefCalled).toBe(true);
  });

  it('passes an explicit env carrying the project key, not just the inherited one', async () => {
    const h = await coldStart();
    const env = h.spawns[0]!.options.env as Record<string, string>;

    expect(env['STEPTIX_SERVER_API_KEY']).toBe('project-key');
    expect(env['AI_API_KEY']).toBe('ai-secret');
    expect(env['STEPTIX_TEST_INHERITED']).toBe('from-parent');
  });

  const winIt = process.platform === 'win32' ? it : it.skip;
  winIt('collapses a case-differing parent key rather than sending both', async () => {
    delete process.env['STEPTIX_SERVER_API_KEY'];
    process.env['Steptix_Server_Api_Key'] = 'stale-parent-key';
    try {
      const h = await coldStart();
      const env = h.spawns[0]!.options.env as Record<string, string>;
      const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'steptix_server_api_key');

      expect(keys).toHaveLength(1);
      expect(env[keys[0]!]).toBe('project-key');
    } finally {
      delete process.env['Steptix_Server_Api_Key'];
    }
  });

  it('writes the child output to <root>/.steptix/mcp-server.log', async () => {
    const h = await coldStart();

    expect(h.spawns[0]!.options.stdio[1]).toEqual(expect.any(Number));
    // The directory and file are created by the open, before the spawn.
    expect(() => readFileSync(logPath)).not.toThrow();
  });

  it('refuses fast when dist/index.js has not been built', async () => {
    const h = makeHarness();
    rmSync(distEntry);

    const err = await failure(ensureServerReadyWith(makeProject(), undefined, h.deps));

    expect(text(err)).toContain(distEntry);
    expect(text(err)).toContain('npm run build');
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Poll, failure, backoff
// ---------------------------------------------------------------------------

describe('ensureServerReady — waiting for the server', () => {
  it('reports the log tail when the server never becomes healthy', async () => {
    const h = makeHarness();
    // Written by the fake child, i.e. AFTER the attempt opened the log. The
    // tail is floored at that offset, so content pre-dating the attempt is
    // deliberately not quotable — see the "does not quote an earlier server's
    // log" test below.
    h.deps.spawn.mockImplementation(() => {
      appendFileSync(logPath, 'Error: Cannot find module @pkent/aigateway\n');
      return { on: () => undefined, unref: () => undefined };
    });

    const err = await failure(ensureServerReadyWith(makeProject(), undefined, h.deps));

    expect(text(err)).toContain('did not become healthy');
    expect(text(err)).toContain(logPath);
    expect(text(err)).toContain('Cannot find module');
    // 20 s of budget at a 250 ms cadence.
    expect(h.deps.probe.mock.calls.length).toBeGreaterThan(70);
    // The poll's per-probe budget, distinct from the arm-deciding probe's.
    expect(h.deps.probe.mock.calls.at(-1)?.[1]).toBe(1_000);
  });

  it("does not quote an earlier server's log when this attempt wrote nothing", async () => {
    // The log is append-only across server lifetimes and the server writes
    // step text with ${env.X} already resolved — so quoting "the last lines"
    // after a silent child would hand a previous run's secrets to the agent.
    const h = makeHarness();
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, 'step 3/7: log in as admin with password hunter2\n');

    const err = await failure(ensureServerReadyWith(makeProject(), undefined, h.deps));

    expect(text(err)).toContain('did not become healthy');
    expect(text(err)).not.toContain('hunter2');
    expect(text(err)).toContain('wrote nothing to the log');
  });

  it("surfaces a child's async spawn error through the log tail", async () => {
    const h = makeHarness();
    const promise = ensureServerReadyWith(makeProject(), undefined, h.deps);
    await h.spawned;

    // Node reports a missing cwd / EPERM / EACCES here, not by throwing.
    h.spawns[0]!.handlers['error']!(new Error('spawn ENOENT'));

    const err = await failure(promise);
    expect(text(err)).toContain('spawn ENOENT');
  });

  it('suppresses a repeat attempt for 60s, then allows one', async () => {
    const h = makeHarness();
    await failure(ensureServerReadyWith(makeProject(), undefined, h.deps));
    expect(h.spawns).toHaveLength(1);

    const err = await failure(ensureServerReadyWith(makeProject(), undefined, h.deps));
    expect(text(err)).toContain('not retrying for another 60s');
    // A suppressed attempt has no spawn of its own, so it re-reads the log the
    // previous one left.
    expect(text(err)).toContain(logPath);
    expect(h.spawns).toHaveLength(1);

    // Past the backoff, and still down when asked — so a second spawn is due.
    h.advance(60_001);
    let probes = 0;
    h.probeImpl = () => (probes++ === 0 ? DOWN : OK_HEALTH);
    await expect(ensureServerReadyWith(makeProject(), undefined, h.deps)).resolves.toBeUndefined();
    expect(h.spawns).toHaveLength(2);
  });

  it('clears the backoff once a start succeeds', async () => {
    const h = makeHarness();
    const project = makeProject();
    await failure(ensureServerReadyWith(project, undefined, h.deps));
    expect(lastStartFailure(project.serverUrl)).toBeDefined();

    // Down again on the arm probe, so this really goes through spawn+poll —
    // otherwise the healthy arm would clear it and the assertion would pass
    // for the wrong reason.
    h.advance(60_001);
    let probes = 0;
    h.probeImpl = () => (probes++ === 0 ? DOWN : OK_HEALTH);
    await ensureServerReadyWith(project, undefined, h.deps);

    expect(h.spawns).toHaveLength(2);
    expect(lastStartFailure(project.serverUrl)).toBeUndefined();
  });

  it('clears a stale backoff when the server turns out to be healthy', async () => {
    const h = makeHarness();
    const project = makeProject();
    await failure(ensureServerReadyWith(project, undefined, h.deps));

    h.up = true;
    await ensureServerReadyWith(project, undefined, h.deps);

    expect(lastStartFailure(project.serverUrl)).toBeUndefined();
    expect(h.spawns).toHaveLength(1);
  });

  it('keeps polling through an unrecognized answer from a booting server', async () => {
    const h = makeHarness();
    let probes = 0;
    // Probe 1 is the arm decision and sees `down`, so we spawn; the next three
    // are a server mid-boot answering oddly, which must not abandon the wait.
    h.probeImpl = () => {
      probes += 1;
      if (probes === 1) return DOWN;
      if (probes <= 4) return { kind: 'unrecognized', detail: 'HTTP 503' };
      return OK_HEALTH;
    };

    await expect(ensureServerReadyWith(makeProject(), undefined, h.deps)).resolves.toBeUndefined();
    expect(h.spawns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Single-flight and cancellation
// ---------------------------------------------------------------------------

describe('ensureServerReady — single-flight', () => {
  it('spawns once for two parallel cold starts', async () => {
    const h = makeHarness();
    const a = ensureServerReadyWith(makeProject(), undefined, h.deps);
    const b = ensureServerReadyWith(makeProject(), undefined, h.deps);
    await h.spawned;
    h.up = true;

    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    expect(h.spawns).toHaveLength(1);
  });

  it('leaves the second caller a ready server when the first cancels mid-start', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const cancelled = ensureServerReadyWith(makeProject(), controller.signal, h.deps);
    const survivor = ensureServerReadyWith(makeProject(), undefined, h.deps);

    await h.spawned;
    controller.abort();
    h.up = true;

    const err = await failure(cancelled);
    expect(err).not.toBeInstanceOf(PreflightFailure);
    expect((err as Error).name).toBe('AbortError');
    await expect(survivor).resolves.toBeUndefined();
    expect(h.spawns).toHaveLength(1);
  });

  it('reports an abort during the poll as a cancellation, not an auto-start failure', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const promise = ensureServerReadyWith(makeProject(), controller.signal, h.deps);

    await h.spawned;
    controller.abort();

    const err = await failure(promise);
    expect(err).not.toBeInstanceOf(PreflightFailure);
    expect((err as Error).name).toBe('AbortError');
    expect(String((err as Error).message)).not.toContain('did not become healthy');

    // The shared start is meant to outlive its cancelled caller; let it finish
    // here rather than in whatever test runs next, where its cleanup would
    // delete that test's in-flight entry. Join it rather than wait a while: a
    // caller with no signal is handed the shared promise itself, which settles
    // only after the registry has dropped the entry. The joiner's own first
    // probe must still see `down`, or it returns at once without joining —
    // and its probe and its lookup of the in-flight entry are all microtasks,
    // so one macrotask turn has it joined before the server is seen to be up.
    const joined = ensureServerReadyWith(makeProject(), undefined, h.deps);
    let joinedSettled = false;
    void joined.finally(() => (joinedSettled = true)).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    // Still waiting on the shared start — it joined rather than answering
    // from its own probe.
    expect(joinedSettled).toBe(false);
    h.up = true;
    await expect(joined).resolves.toBeUndefined();
    // Joined, not started afresh: one spawn between the two callers.
    expect(h.spawns).toHaveLength(1);
  });
});
