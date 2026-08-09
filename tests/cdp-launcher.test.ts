import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectInstalled,
  clearDetectionCache,
  launchCdpBrowser,
  readDevToolsPort,
  searchedPaths,
  manualCommand,
  type LauncherDeps,
} from '../src/browser/cdp-launcher.js';
import {
  classifyEngine,
  probePort,
  discoverCdpPorts,
  toPageTabs,
  closeTab,
  activateTab,
  portAnswers,
} from '../src/browser/cdp-discovery.js';

const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
} as NodeJS.ProcessEnv;

/** A deps bundle with everything stubbed and nothing touching the machine. */
function stubDeps(over: Partial<LauncherDeps> = {}): LauncherDeps {
  return {
    platform: 'win32',
    env: WIN_ENV,
    existsSync: () => true,
    readFileSync: () => '9999\n/devtools/browser/abc',
    mkdirSync: () => {},
    spawn: (() => ({ pid: 4242, unref() {} })) as unknown as LauncherDeps['spawn'],
    probe: async (port: number) => ({ port, reachable: true, engine: 'chrome' as const, tabs: [] }),
    sleep: async () => {},
    launchTimeoutMs: 300,
    ...over,
  };
}

beforeEach(() => clearDetectionCache());

// ---------------------------------------------------------------------------
// classifyEngine — the W0 finding this port exists to fix
// ---------------------------------------------------------------------------

describe('classifyEngine', () => {
  it('classifies modern Edge, which reports "Edg/" not "Edge/"', () => {
    // Measured in W0 against Edge 151.0.4129.59. flick's copy tests `Edge/`
    // and therefore returns 'unknown' here — issues/041.
    expect(classifyEngine('Edg/151.0.4129.59')).toBe('edge');
  });

  it('still classifies the legacy "Edge/" form', () => {
    expect(classifyEngine('Edge/18.19041')).toBe('edge');
  });

  it('classifies Chrome, headless Chrome and Chromium', () => {
    expect(classifyEngine('Chrome/150.0.7871.187')).toBe('chrome');
    expect(classifyEngine('HeadlessChrome/150.0.7871.187')).toBe('chrome');
    expect(classifyEngine('Chromium/120.0.0.0')).toBe('chromium');
  });

  it('classifies a Node inspector so callers can drop it', () => {
    // 9229 is the Node --inspect default and is in the foreign scan list, so
    // this arm is what stops the server offering its own debugger as a browser.
    expect(classifyEngine('node.js/v22.11.0')).toBe('node');
  });

  it('does not mistake Edge for Chrome', () => {
    expect(classifyEngine('Edg/151.0.4129.59')).not.toBe('chrome');
  });

  it('falls back to unknown rather than throwing', () => {
    expect(classifyEngine('')).toBe('unknown');
    expect(classifyEngine('Brave/1.60')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('probePort', () => {
  const jsonRes = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  it('reports unreachable without throwing when nothing is listening', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probePort(9222, 100, fetchFn);
    expect(result.reachable).toBe(false);
    expect(result.tabs).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('enumerates page tabs and drops devtools/extension targets', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/json/version')) return jsonRes({ Browser: 'Edg/151.0.4129.59' });
      return jsonRes([
        { id: 't1', type: 'page', title: 'Orders', url: 'https://shop/orders' },
        { id: 't2', type: 'page', title: 'DevTools', url: 'devtools://devtools/x' },
        { id: 't3', type: 'page', title: 'Ext', url: 'chrome-extension://abc/x.html' },
        { id: 't4', type: 'service_worker', title: 'sw', url: 'https://shop/sw.js' },
        { type: 'page', title: 'no id', url: 'https://shop/x' },
      ]);
    }) as unknown as typeof fetch;

    const result = await probePort(9222, 100, fetchFn);
    expect(result.reachable).toBe(true);
    expect(result.engine).toBe('edge');
    expect(result.tabs).toEqual([{ targetId: 't1', title: 'Orders', url: 'https://shop/orders' }]);
  });

  it('keeps reachable:true when /json/list fails after /json/version succeeded', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/json/version')) return jsonRes({ Browser: 'Chrome/150.0' });
      throw new Error('boom');
    }) as unknown as typeof fetch;

    const result = await probePort(9222, 100, fetchFn);
    expect(result.reachable).toBe(true);
    expect(result.engine).toBe('chrome');
    expect(result.tabs).toBeNull();
    expect(result.error).toContain('boom');
  });

  it('never throws — a per-port failure is captured on that port', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('nope');
    }) as unknown as typeof fetch;
    await expect(discoverCdpPorts([9222, 9223], { fetchFn, timeoutMs: 50 })).resolves.toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Closing a tab (stories/cdp-tabs.md §2)
// ---------------------------------------------------------------------------

describe('toPageTabs — the shared filter', () => {
  it('keeps a new-tab page', () => {
    // W0: a fresh browser's chrome://newtab IS an ordinary closable page
    // target, and a user looking at their window counts it. Excluding it would
    // make the LAST-tab guard fire one tab early — the browser would look
    // empty while a real tab was still open.
    expect(toPageTabs([{ id: 'n1', type: 'page', title: 'New Tab', url: 'chrome://newtab/' }]))
      .toEqual([{ targetId: 'n1', title: 'New Tab', url: 'chrome://newtab/' }]);
  });

  it('drops a browser dialog, which is a page target but not a tab', async () => {
    // Measured in live testing: Edge reports edge://sync-confirmation-dialog/
    // as type:'page'. Counting it turned one real tab into two, so the
    // last-tab guard let the browser exit with nobody passing
    // allow_browser_exit — the exact failure that guard exists to prevent.
    expect(
      toPageTabs([
        { id: 'd1', type: 'page', title: '', url: 'edge://sync-confirmation-dialog/' },
        { id: 't1', type: 'page', title: 'Orders', url: 'https://shop/orders' },
      ]).map((t) => t.targetId),
    ).toEqual(['t1']);
  });

  it('keeps internal pages that ARE real tabs', () => {
    // Only `*-dialog` surfaces are dropped. Settings and history are tabs a
    // user opened, and dropping them would fire the last-tab refusal early.
    expect(
      toPageTabs([
        { id: 's1', type: 'page', title: 'Settings', url: 'edge://settings/' },
        { id: 'h1', type: 'page', title: 'History', url: 'chrome://history/' },
      ]).map((t) => t.targetId),
    ).toEqual(['s1', 'h1']);
  });

  it('is the same filter probePort applies', async () => {
    // The drift this export exists to prevent: if the close path counted tabs
    // differently from the listing, a browser could be reported with one tab
    // and refuse the close as "not the last" — or permit one that silently
    // exits the browser.
    const raw = [
      { id: 't1', type: 'page', title: 'Orders', url: 'https://shop/orders' },
      { id: 't2', type: 'page', title: 'DevTools', url: 'devtools://devtools/x' },
      { id: 't3', type: 'page', title: 'Ext', url: 'chrome-extension://abc/x.html' },
      { id: 't4', type: 'service_worker', title: 'sw', url: 'https://shop/sw.js' },
    ];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/json/version')) {
        return { ok: true, status: 200, json: async () => ({ Browser: 'Chrome/150.0' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => raw } as unknown as Response;
    }) as unknown as typeof fetch;

    const probed = await probePort(9222, 100, fetchFn);
    expect(probed.tabs).toEqual(toPageTabs(raw));
  });

  it('survives a malformed list rather than throwing at a caller mid-close', () => {
    expect(toPageTabs(null)).toEqual([]);
    expect(toPageTabs({ not: 'an array' })).toEqual([]);
  });
});

describe('closeTab', () => {
  it('asks the browser to close, and reports success', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    const result = await closeTab(51000, 'A1B2C3', 100, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, notFound: false, error: null });
    expect(String(fetchFn.mock.calls[0]![0])).toBe('http://127.0.0.1:51000/json/close/A1B2C3');
  });

  it('distinguishes an unknown target id', async () => {
    // W0: the browser itself answers 404 "No such target id" for an id it does
    // not have. Surfacing that separately is what lets the caller say "already
    // closed, or a different browser" instead of swallowing it as success.
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    const result = await closeTab(51000, 'GONE', 100, fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, notFound: true });
  });

  it('encodes the target id into the path', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    await closeTab(51000, 'A/B?C', 100, fetchFn as unknown as typeof fetch);
    expect(String(fetchFn.mock.calls[0]![0])).toBe('http://127.0.0.1:51000/json/close/A%2FB%3FC');
  });

  it('never throws — a dead browser is a result, not an exception', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await closeTab(51000, 'A1B2C3', 100, fetchFn);
    expect(result).toMatchObject({ ok: false, notFound: false });
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('activateTab', () => {
  it('asks the browser to bring the tab forward, and reports success', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    const result = await activateTab(51000, 'A1B2C3', 100, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, notFound: false, error: null });
    expect(String(fetchFn.mock.calls[0]![0])).toBe('http://127.0.0.1:51000/json/activate/A1B2C3');
  });

  it('distinguishes an unknown target id', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    const result = await activateTab(51000, 'GONE', 100, fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, notFound: true });
  });

  it('does not treat a 500 as success', async () => {
    // Reachable, and measured: a `worker` target id answers
    // `500 Could not activate target id`. Falling through to "ok" would report
    // a focus that did not happen.
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const result = await activateTab(51000, 'W1', 100, fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, notFound: false, error: 'HTTP 500' });
  });

  it('encodes the target id into the path', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    await activateTab(51000, 'A/B?C', 100, fetchFn as unknown as typeof fetch);
    expect(String(fetchFn.mock.calls[0]![0])).toBe('http://127.0.0.1:51000/json/activate/A%2FB%3FC');
  });

  it('never throws — a dead browser is a result, not an exception', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await activateTab(51000, 'A1B2C3', 100, fetchFn);
    expect(result).toMatchObject({ ok: false, notFound: false });
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('portAnswers', () => {
  it('is false once the browser has gone — the last-tab success signal', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(portAnswers(51000, 50, dead)).resolves.toBe(false);

    const alive = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ Browser: 'Chrome/150' }) }) as unknown as Response,
    ) as unknown as typeof fetch;
    await expect(portAnswers(51000, 50, alive)).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

describe('detectInstalled', () => {
  it('finds Chrome in LOCALAPPDATA before Program Files', () => {
    const seen: string[] = [];
    const found = detectInstalled({
      platform: 'win32',
      env: WIN_ENV,
      existsSync: (p) => {
        seen.push(p);
        return p.startsWith('C:\\Users');
      },
    });
    expect(found.chrome).toBe('C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
    expect(seen[0]).toContain('AppData');
  });

  it('returns null for an engine that is nowhere', () => {
    const found = detectInstalled({ platform: 'win32', env: WIN_ENV, existsSync: () => false });
    expect(found.chrome).toBeNull();
    expect(found.edge).toBeNull();
  });

  it('searchedPaths lists what detection actually looked at', () => {
    const paths = searchedPaths('edge', { platform: 'win32', env: WIN_ENV });
    expect(paths).toHaveLength(3);
    expect(paths.every((p) => p.includes('msedge.exe'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readDevToolsPort
// ---------------------------------------------------------------------------

describe('readDevToolsPort', () => {
  it('reads line 1 as the port', () => {
    const port = readDevToolsPort('C:\\p', { readFileSync: () => '48077\n/devtools/browser/abc' });
    expect(port).toBe(48077);
  });

  it('tolerates CRLF', () => {
    expect(readDevToolsPort('C:\\p', { readFileSync: () => '48077\r\n/devtools/x' })).toBe(48077);
  });

  it('returns null — never throws — for a missing file', () => {
    expect(
      readDevToolsPort('C:\\p', {
        readFileSync: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
  });

  it('returns null for malformed contents rather than a NaN port', () => {
    for (const raw of ['', 'not-a-port', '0', '-1', '99999', '  ']) {
      expect(readDevToolsPort('C:\\p', { readFileSync: () => raw })).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// launchCdpBrowser
// ---------------------------------------------------------------------------

describe('launchCdpBrowser', () => {
  it('spawns with --remote-debugging-port=0, never a literal port', async () => {
    let args: string[] = [];
    const spawn = vi.fn((_bin: string, a: string[]) => {
      args = a;
      return { pid: 1, unref() {} };
    }) as unknown as LauncherDeps['spawn'];

    const result = await launchCdpBrowser(
      { engine: 'chrome', profileDir: 'C:\\proj\\.aiui\\cdp-profiles\\chrome-default' },
      stubDeps({ spawn }),
    );

    expect(result.ok).toBe(true);
    expect(args).toContain('--remote-debugging-port=0');
    // The whole design rests on never choosing a port ourselves.
    expect(args.some((a) => /--remote-debugging-port=[1-9]/.test(a))).toBe(false);
  });

  it('spawns in array form — a profile dir with spaces stays one argument', async () => {
    // Injection regression guard. String concat here would be a command
    // injection vector: the profile name reaches this path from a tool arg.
    let args: string[] = [];
    const spawn = vi.fn((_bin: string, a: string[]) => {
      args = a;
      return { pid: 1, unref() {} };
    }) as unknown as LauncherDeps['spawn'];

    await launchCdpBrowser(
      { engine: 'chrome', profileDir: 'C:\\my proj\\.aiui\\cdp-profiles\\chrome-a b' },
      stubDeps({ spawn }),
    );

    const dirArg = args.find((a) => a.startsWith('--user-data-dir='));
    expect(dirArg).toBe('--user-data-dir=C:\\my proj\\.aiui\\cdp-profiles\\chrome-a b');
    expect(args.filter((a) => a.includes('my proj'))).toHaveLength(1);
  });

  it('returns the port the browser chose, read back from the file', async () => {
    const result = await launchCdpBrowser(
      { engine: 'edge', profileDir: 'C:\\p' },
      stubDeps({
        readFileSync: () => '51234\n/devtools/browser/xyz',
        probe: async (port) => ({ port, reachable: true, engine: 'edge', tabs: [] }),
      }),
    );
    expect(result).toMatchObject({ ok: true, port: 51234, pid: 4242 });
  });

  it('waits for the port to answer, not merely for the file to exist', async () => {
    // W0 measured a 212-321 ms gap between the two. A launcher that returned
    // as soon as the file appeared would hand back a port that refuses
    // connections, and the caller's first connectOverCDP would fail against a
    // healthy browser.
    let probes = 0;
    const result = await launchCdpBrowser(
      { engine: 'chrome', profileDir: 'C:\\p' },
      stubDeps({
        launchTimeoutMs: 2000,
        probe: async (port) => {
          probes += 1;
          return probes < 3
            ? { port, reachable: false, engine: 'unknown' as const, tabs: null, error: 'ECONNREFUSED' }
            : { port, reachable: true, engine: 'chrome' as const, tabs: [] };
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(probes).toBe(3);
  });

  it('names DevToolsActivePort when the file never appears', async () => {
    const result = await launchCdpBrowser(
      { engine: 'chrome', profileDir: 'C:\\p' },
      stubDeps({
        readFileSync: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // §7: the message must name the file, not say "the browser did not start".
    // The browser almost certainly did start; the mechanism is what failed.
    expect(result.error).toContain('DevToolsActivePort');
    expect(result.error).toContain('C:\\p');
    expect(result.error).toContain('4242');
    expect(result.error.toLowerCase()).toContain('retry');
  });

  it('names the port and the last probe error when the port never answers', async () => {
    const result = await launchCdpBrowser(
      { engine: 'chrome', profileDir: 'C:\\p' },
      stubDeps({
        readFileSync: () => '48077\n/x',
        probe: async (port) => ({
          port,
          reachable: false,
          engine: 'unknown' as const,
          tabs: null,
          error: 'ECONNREFUSED 127.0.0.1:48077',
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('48077');
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.error).toContain('stale');
  });

  it('carries the paths searched and a copy-pasteable command when not installed', async () => {
    const result = await launchCdpBrowser(
      { engine: 'edge', profileDir: 'C:\\p' },
      stubDeps({ existsSync: () => false }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Edge');
    expect(result.error).toContain('msedge.exe');
    expect(result.error).toContain(manualCommand('edge', 'C:\\p'));
    // Next action (§7 column 3).
    expect(result.error).toContain('use the other engine');
  });

  it('reports an unwritable profile dir against the resolved path', async () => {
    const result = await launchCdpBrowser(
      { engine: 'chrome', profileDir: 'C:\\p\\chrome-default' },
      stubDeps({
        mkdirSync: () => {
          throw new Error('EACCES: permission denied');
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('C:\\p\\chrome-default');
    expect(result.error).toContain('EACCES');
    expect(result.error).toContain('.aiui/cdp-profiles/');
  });

  it('does not spawn at all when the binary is missing', async () => {
    const spawn = vi.fn() as unknown as LauncherDeps['spawn'];
    await launchCdpBrowser(
      { engine: 'chrome', profileDir: 'C:\\p' },
      stubDeps({ existsSync: () => false, spawn }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
