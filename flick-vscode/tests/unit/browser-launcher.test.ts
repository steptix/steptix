// Unit coverage for the browser launcher
// (stories/flick-vscode-cdp-attach.md "Extension: Browser launcher").
// All filesystem / spawn / fetch / sleep dependencies are injected, so the
// tests never touch the real machine.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectInstalled,
  clearDetectionCache,
  launchBrowserWithCdp,
  __testCachedDetection,
} from '../../src/extension/browser-launcher';

type ExistsSync = (p: string) => boolean;
type Which = (cmd: string) => string | null;

interface FakeChild {
  pid: number;
  unrefCalled: boolean;
  unref(): void;
}

function makeFakeChild(pid: number): FakeChild {
  const child: FakeChild = {
    pid,
    unrefCalled: false,
    unref() {
      child.unrefCalled = true;
    },
  };
  return child;
}

const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
};

beforeEach(() => {
  clearDetectionCache();
});

test('detectInstalled Windows finds both engines, iteration stops at first hit', () => {
  const calls: string[] = [];
  const existsSync: ExistsSync = (p) => {
    calls.push(p);
    if (p === 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe') {
      return true;
    }
    if (p === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') {
      return true;
    }
    return false;
  };

  const result = detectInstalled({ platform: 'win32', env: WIN_ENV, existsSync });

  assert.equal(
    result.chrome,
    'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  );
  assert.equal(
    result.edge,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  );

  // Chrome iteration must hit LOCALAPPDATA first and stop there (1 chrome call).
  const chromeCalls = calls.filter((c) => c.includes('chrome.exe'));
  assert.equal(chromeCalls.length, 1, 'chrome lookup should stop at first hit');
  assert.equal(
    chromeCalls[0],
    'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  );

  // Edge: must hit PROGRAMFILES(X86) first and stop there (1 edge call).
  const edgeCalls = calls.filter((c) => c.includes('msedge.exe'));
  assert.equal(edgeCalls.length, 1, 'edge lookup should stop at first hit');
  assert.equal(
    edgeCalls[0],
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  );
});

test('detectInstalled Windows finds neither when nothing exists', () => {
  const existsSync: ExistsSync = () => false;
  const result = detectInstalled({ platform: 'win32', env: WIN_ENV, existsSync });
  assert.deepEqual(result, { chrome: null, edge: null });
});

test('detectInstalled macOS returns canonical .app paths', () => {
  const existsSync: ExistsSync = (p) =>
    p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ||
    p === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const result = detectInstalled({ platform: 'darwin', env: {}, existsSync });
  assert.deepEqual(result, {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  });
});

test('detectInstalled Linux via which: chrome found, edge missing', () => {
  const which: Which = (cmd) => {
    if (cmd === 'google-chrome') return '/usr/bin/google-chrome';
    return null;
  };
  const result = detectInstalled({
    platform: 'linux',
    env: {},
    existsSync: () => false,
    which,
  });
  assert.deepEqual(result, { chrome: '/usr/bin/google-chrome', edge: null });
});

test('detectInstalled Linux falls back to google-chrome-stable when google-chrome missing', () => {
  const which: Which = (cmd) => {
    if (cmd === 'google-chrome') return null;
    if (cmd === 'google-chrome-stable') return '/usr/bin/google-chrome-stable';
    return null;
  };
  const result = detectInstalled({
    platform: 'linux',
    env: {},
    existsSync: () => false,
    which,
  });
  assert.equal(result.chrome, '/usr/bin/google-chrome-stable');
});

test('cache: a call with injected deps never writes its answer to the module cache', async () => {
  // The cache serves the real, dep-less caller. A fake answer left in it
  // would make that caller launch a binary that does not exist.
  const overridden = detectInstalled({
    platform: 'linux',
    env: {},
    existsSync: () => false,
    which: () => '/fake/chrome',
  });
  assert.equal(overridden.chrome, '/fake/chrome');
  assert.equal(__testCachedDetection(), null, 'detectInstalled with deps wrote the cache');

  // The launcher detects through the same function, with its own deps. Nothing
  // is installed, so it must stop there; the fakes that throw make sure a
  // regression past that point can never create a directory or start a browser.
  const refuse = (what: string) => () => {
    throw new Error(`launchBrowserWithCdp reached ${what} with no browser installed`);
  };
  const launched = await launchBrowserWithCdp(
    { engine: 'chrome', port: 9222, profileDir: '/tmp/p' },
    {
      platform: 'linux',
      env: {},
      existsSync: () => false,
      which: () => null,
      mkdirSync: refuse('mkdirSync'),
      spawn: refuse('spawn') as unknown as typeof import('node:child_process').spawn,
      fetchFn: refuse('fetch') as unknown as typeof fetch,
      sleep: refuse('sleep') as unknown as (ms: number) => Promise<void>,
    },
  );
  assert.equal(launched.ok, false);
  assert.match(launched.error ?? '', /Chrome not found/);
  assert.equal(__testCachedDetection(), null, 'launchBrowserWithCdp with deps wrote the cache');
});

test('launchBrowserWithCdp happy path (chrome) — array-form spawn, fetch ok on first poll', async () => {
  const spawnCalls: Array<{ binary: string; args: string[]; opts: unknown }> = [];
  const mkdirCalls: Array<{ p: string; opts: { recursive: boolean } }> = [];
  const fakeChild = makeFakeChild(12345);

  const result = await launchBrowserWithCdp(
    { engine: 'chrome', port: 9333, profileDir: '/tmp/.flick/chrome-profile' },
    {
      platform: 'linux',
      env: {},
      existsSync: () => false,
      which: (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : null),
      mkdirSync: (p, opts) => {
        mkdirCalls.push({ p, opts });
      },
      spawn: ((binary: string, args: string[], opts: unknown) => {
        spawnCalls.push({ binary, args, opts });
        return fakeChild as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as typeof import('node:child_process').spawn,
      fetchFn: (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch,
      sleep: async () => {},
    },
  );

  assert.deepEqual(result, {
    ok: true,
    pid: 12345,
    binary: '/usr/bin/google-chrome',
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].binary, '/usr/bin/google-chrome');
  assert.deepEqual(spawnCalls[0].args, [
    '--remote-debugging-port=9333',
    '--user-data-dir=/tmp/.flick/chrome-profile',
    '--no-first-run',
    '--no-default-browser-check',
  ]);
  assert.deepEqual(spawnCalls[0].opts, { detached: true, stdio: 'ignore' });
  assert.equal(fakeChild.unrefCalled, true, 'child must be unref()d');

  assert.equal(mkdirCalls.length, 1);
  assert.deepEqual(mkdirCalls[0], {
    p: '/tmp/.flick/chrome-profile',
    opts: { recursive: true },
  });
});

test('launchBrowserWithCdp both engines spawn with the same arg shape', async () => {
  const spawnCalls: Array<{ binary: string; args: string[] }> = [];
  const baseDeps = {
    platform: 'linux' as NodeJS.Platform,
    env: {},
    existsSync: () => false,
    which: (cmd: string) => {
      if (cmd === 'google-chrome') return '/usr/bin/google-chrome';
      if (cmd === 'microsoft-edge') return '/usr/bin/microsoft-edge';
      return null;
    },
    mkdirSync: () => {},
    spawn: ((binary: string, args: string[]) => {
      spawnCalls.push({ binary, args });
      return makeFakeChild(1) as unknown as ReturnType<
        typeof import('node:child_process').spawn
      >;
    }) as typeof import('node:child_process').spawn,
    fetchFn: (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch,
    sleep: async () => {},
  };

  await launchBrowserWithCdp(
    { engine: 'chrome', port: 9222, profileDir: '/p/chrome-profile' },
    baseDeps,
  );
  await launchBrowserWithCdp(
    { engine: 'edge', port: 9222, profileDir: '/p/edge-profile' },
    baseDeps,
  );

  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0].binary, '/usr/bin/google-chrome');
  assert.equal(spawnCalls[1].binary, '/usr/bin/microsoft-edge');

  // Same arg shape (only the profile-dir value differs).
  assert.deepEqual(spawnCalls[0].args, [
    '--remote-debugging-port=9222',
    '--user-data-dir=/p/chrome-profile',
    '--no-first-run',
    '--no-default-browser-check',
  ]);
  assert.deepEqual(spawnCalls[1].args, [
    '--remote-debugging-port=9222',
    '--user-data-dir=/p/edge-profile',
    '--no-first-run',
    '--no-default-browser-check',
  ]);
});

test('binary missing returns ok:false with engine-specific copy-paste command (edge)', async () => {
  const result = await launchBrowserWithCdp(
    { engine: 'edge', port: 9222, profileDir: '/tmp/edge-profile' },
    {
      platform: 'win32',
      env: WIN_ENV,
      existsSync: () => false,
      which: () => null,
      // mkdir/spawn/fetch should never be called when binary is missing.
      mkdirSync: () => {
        throw new Error('mkdirSync should not be called');
      },
      spawn: (() => {
        throw new Error('spawn should not be called');
      }) as typeof import('node:child_process').spawn,
    },
  );

  assert.equal(result.ok, false);
  assert.ok(result.error, 'expected an error string');
  assert.match(result.error!, /Edge not found/);
  assert.match(result.error!, /msedge --remote-debugging-port=9222/);
  assert.match(result.error!, /--user-data-dir=\/tmp\/edge-profile/);
});

test('binary missing returns ok:false with chrome copy-paste command for chrome engine', async () => {
  const result = await launchBrowserWithCdp(
    { engine: 'chrome', port: 9229, profileDir: '/tmp/chrome-profile' },
    {
      platform: 'linux',
      env: {},
      existsSync: () => false,
      which: () => null,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error!, /Chrome not found/);
  assert.match(result.error!, /^.*chrome --remote-debugging-port=9229/m);
});

test('poll timeout: fetch always throws, returns ok:false with port in error', async () => {
  let sleepCalls = 0;
  // Drive time forward by mocking sleep — bump a Date.now offset so the
  // launcher's deadline arithmetic terminates without real waiting.
  const realNow = Date.now;
  let virtualOffset = 0;
  Date.now = () => realNow() + virtualOffset;
  try {
    const result = await launchBrowserWithCdp(
      { engine: 'chrome', port: 9333, profileDir: '/tmp/p' },
      {
        platform: 'linux',
        env: {},
        existsSync: () => false,
        which: (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : null),
        mkdirSync: () => {},
        spawn: (() =>
          makeFakeChild(42) as unknown as ReturnType<
            typeof import('node:child_process').spawn
          >) as typeof import('node:child_process').spawn,
        fetchFn: (async () => {
          throw new Error('econnrefused');
        }) as typeof fetch,
        sleep: async (ms) => {
          sleepCalls += 1;
          virtualOffset += ms;
        },
        pollTimeoutMs: 600, // 3 polls @ 200ms intervals
      },
    );

    assert.equal(result.ok, false);
    assert.match(result.error!, /9333/);
    assert.match(result.error!, /pid 42/);
    assert.match(result.error!, /econnrefused/);
    assert.ok(sleepCalls > 0, 'sleep should have been called between polls');
  } finally {
    Date.now = realNow;
  }
});
