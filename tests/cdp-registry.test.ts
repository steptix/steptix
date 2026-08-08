import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  cdpProfilesRoot,
  profileDirFor,
  validateProfileName,
  parseProfileDirName,
  knownProfiles,
  startCdpBrowser,
  closeCdpTab,
  UNKNOWN_HOLDER,
  resetProfile,
  PROFILE_MARKER,
  type RegistryDeps,
} from '../src/browser/cdp-registry.js';
import { listPageTabs } from '../src/browser/cdp-discovery.js';

const ROOT = path.join('C:', 'proj');
const PROFILES = cdpProfilesRoot(ROOT);

/**
 * A tiny in-memory filesystem. Paths are exact strings; directories are
 * tracked as a set so `existsSync` can answer for both.
 */
function fakeFs(init: { dirs?: string[]; files?: Record<string, string>; symlinks?: string[] } = {}) {
  const dirs = new Set(init.dirs ?? []);
  const files = new Map(Object.entries(init.files ?? {}));
  const symlinks = new Set(init.symlinks ?? []);
  const renames: [string, string][] = [];
  const removed: string[] = [];
  const unlinked: string[] = [];

  const deps: RegistryDeps = {
    existsSync: (p) => dirs.has(p) || files.has(p),
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    readdir: (dir) => {
      if (!dirs.has(dir)) throw new Error(`ENOENT: ${dir}`);
      const children = new Set<string>();
      for (const d of dirs) {
        if (d.startsWith(dir + path.sep)) {
          const rest = d.slice(dir.length + 1);
          if (!rest.includes(path.sep)) children.add(rest);
        }
      }
      return [...children].map((name) => ({ name, isDirectory: () => true }));
    },
    realpath: (p) => {
      if (!dirs.has(p) && !files.has(p)) throw new Error(`ENOENT: ${p}`);
      return p;
    },
    isSymlink: (p) => symlinks.has(p),
    rename: (from, to) => {
      if (!dirs.has(from)) throw new Error(`ENOENT: ${from}`);
      renames.push([from, to]);
      dirs.delete(from);
      dirs.add(to);
      for (const [f, v] of [...files]) {
        if (f.startsWith(from + path.sep)) {
          files.delete(f);
          files.set(to + f.slice(from.length), v);
        }
      }
    },
    rm: (p) => {
      removed.push(p);
      dirs.delete(p);
      for (const f of [...files.keys()]) if (f.startsWith(p + path.sep)) files.delete(f);
    },
    writeFile: (p, d) => {
      files.set(p, d);
    },
    unlink: (p) => {
      unlinked.push(p);
      files.delete(p);
    },
    mkdirSync: (p) => {
      dirs.add(p);
    },
  };

  return { deps, dirs, files, symlinks, renames, removed, unlinked };
}

/** A probe that answers `live` for the given ports, with the given engine. */
function probeFor(live: Record<number, 'chrome' | 'edge'>, tabs: unknown[] = []) {
  return async (port: number) => {
    const engine = live[port];
    if (!engine) {
      return { port, reachable: false, engine: 'unknown' as const, tabs: null, error: 'ECONNREFUSED' };
    }
    return { port, reachable: true, engine, tabs: tabs as never };
  };
}

/**
 * A launcher stub that records its calls and reports a fixed port.
 *
 * It creates the profile directory, because the real `launchCdpBrowser` does
 * (`mkdirSync` before spawn) and a caller that resets a profile and relaunches
 * relies on that to put the directory back.
 */
function launcherStub(port = 40000) {
  const calls: { engine: string; profileDir: string }[] = [];
  const launch = vi.fn(
    async (opts: { engine: string; profileDir: string }, deps?: RegistryDeps) => {
      calls.push(opts);
      deps?.mkdirSync?.(opts.profileDir, { recursive: true });
      return { ok: true as const, port, pid: 1, binary: 'C:\\chrome.exe' };
    },
  );
  return { launch: launch as unknown as RegistryDeps['launch'], calls, spy: launch };
}

// ---------------------------------------------------------------------------
// §1 Profile layout and names
// ---------------------------------------------------------------------------

describe('profile layout', () => {
  it('always uses <engine>-<name>, including for the default', () => {
    expect(profileDirFor(ROOT, 'edge', 'default')).toBe(path.join(PROFILES, 'edge-default'));
    expect(profileDirFor(ROOT, 'edge', 'admin')).toBe(path.join(PROFILES, 'edge-admin'));
  });

  it('round-trips a profile name containing a hyphen', () => {
    // Split is on the FIRST hyphen — engine names contain none, so a profile
    // called signup-test survives enumeration.
    expect(parseProfileDirName('chrome-signup-test')).toEqual({
      engine: 'chrome',
      profile: 'signup-test',
    });
  });

  it('ignores directories that are not ours', () => {
    expect(parseProfileDirName('firefox-default')).toBeNull();
    expect(parseProfileDirName('chrome')).toBeNull();
    expect(parseProfileDirName('-default')).toBeNull();
    expect(parseProfileDirName('.trash-chrome-admin-123')).toBeNull();
  });

  it('refuses a name that is not a single path component', () => {
    for (const bad of ['../../secrets', 'a/b', 'a\\b', '..', '', 'a b', 'a:b']) {
      expect(validateProfileName(bad), bad).not.toBeNull();
    }
    expect(validateProfileName('admin')).toBeNull();
    expect(validateProfileName('signup-test')).toBeNull();
    expect(validateProfileName('uat.2')).toBeNull();
  });

  it('names the permitted characters when it refuses', () => {
    const msg = validateProfileName('../../secrets');
    expect(msg).toContain('letters, digits, dot, underscore and hyphen');
    expect(msg).toContain('admin');
  });
});

// ---------------------------------------------------------------------------
// §2 Ownership
// ---------------------------------------------------------------------------

describe('knownProfiles', () => {
  const portFile = (dir: string) => path.join(dir, 'DevToolsActivePort');

  it('reports a reachable matching-engine port as live', async () => {
    const dir = path.join(PROFILES, 'chrome-default');
    const { deps } = fakeFs({ dirs: [PROFILES, dir], files: { [portFile(dir)]: '48077\n/x' } });
    const [p] = await knownProfiles(ROOT, { ...deps, probe: probeFor({ 48077: 'chrome' }) });
    expect(p).toMatchObject({ engine: 'chrome', profile: 'default', live: true, port: 48077 });
  });

  it('treats a stale file whose port is dead as dormant, keeping the profile', async () => {
    // W0: the file is never deleted, on orderly exit or on crash. The
    // reachability probe is the only thing that ever cleans one up.
    const dir = path.join(PROFILES, 'chrome-default');
    const { deps } = fakeFs({ dirs: [PROFILES, dir], files: { [portFile(dir)]: '48077\n/x' } });
    const [p] = await knownProfiles(ROOT, { ...deps, probe: probeFor({}) });
    expect(p).toMatchObject({ live: false, port: null, tabs: null });
    // Dormant profiles are REPORTED, not dropped — that is what lets an agent
    // reuse `admin` instead of inventing `admin2`.
    expect(p!.profile).toBe('default');
  });

  it('treats a reachable port reporting the WRONG engine as dormant', async () => {
    // A stale Chrome file can point at a port an unrelated Edge has since
    // taken. Without the engine check we would report someone else's browser
    // as ours and hand an agent a port into it.
    const dir = path.join(PROFILES, 'chrome-default');
    const { deps } = fakeFs({ dirs: [PROFILES, dir], files: { [portFile(dir)]: '48077\n/x' } });
    const [p] = await knownProfiles(ROOT, { ...deps, probe: probeFor({ 48077: 'edge' }) });
    expect(p).toMatchObject({ live: false, port: null });
  });

  it('treats a missing port file as dormant', async () => {
    const dir = path.join(PROFILES, 'edge-admin');
    const { deps } = fakeFs({ dirs: [PROFILES, dir] });
    const [p] = await knownProfiles(ROOT, { ...deps, probe: probeFor({}) });
    expect(p).toMatchObject({ engine: 'edge', profile: 'admin', live: false, port: null });
  });

  it('treats a malformed port file as dormant without throwing', async () => {
    const dir = path.join(PROFILES, 'edge-admin');
    const { deps } = fakeFs({ dirs: [PROFILES, dir], files: { [portFile(dir)]: 'garbage' } });
    await expect(knownProfiles(ROOT, { ...deps, probe: probeFor({}) })).resolves.toMatchObject([
      { live: false },
    ]);
  });

  it('returns [] when the project has no profiles directory', async () => {
    const { deps } = fakeFs({});
    await expect(knownProfiles(ROOT, deps)).resolves.toEqual([]);
  });

  it('reports two profiles of one engine independently', async () => {
    const a = path.join(PROFILES, 'edge-default');
    const b = path.join(PROFILES, 'edge-admin');
    const { deps } = fakeFs({
      dirs: [PROFILES, a, b],
      files: { [portFile(a)]: '111\n/x', [portFile(b)]: '222\n/x' },
    });
    const found = await knownProfiles(ROOT, { ...deps, probe: probeFor({ 111: 'edge', 222: 'edge' }) });
    const ports = found.map((p) => p.port).sort();
    expect(ports).toEqual([111, 222]);
  });
});

// ---------------------------------------------------------------------------
// §3 Launch or reuse
// ---------------------------------------------------------------------------

describe('startCdpBrowser', () => {
  const portFile = (dir: string) => path.join(dir, 'DevToolsActivePort');

  it('reuses a live browser and NEVER calls the launcher', async () => {
    const dir = path.join(PROFILES, 'edge-default');
    const { deps } = fakeFs({ dirs: [PROFILES, dir], files: { [portFile(dir)]: '51000\n/x' } });
    const { launch, spy } = launcherStub();

    const result = await startCdpBrowser(
      { projectRoot: ROOT, engine: 'edge' },
      { ...deps, launch, probe: probeFor({ 51000: 'edge' }) },
    );

    expect(result).toMatchObject({ ok: true, outcome: 'reused_running_browser', port: 51000 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT delete the port file on the reuse branch', async () => {
    // Deleting it while a browser is alive destroys the registry entry for a
    // RUNNING browser — we would lose a signed-in browser we still own, and
    // its port is OS-assigned so nothing could find it again.
    const dir = path.join(PROFILES, 'edge-default');
    const { deps, unlinked } = fakeFs({
      dirs: [PROFILES, dir],
      files: { [portFile(dir)]: '51000\n/x' },
    });
    const { launch } = launcherStub();

    await startCdpBrowser(
      { projectRoot: ROOT, engine: 'edge' },
      { ...deps, launch, probe: probeFor({ 51000: 'edge' }) },
    );

    expect(unlinked).toEqual([]);
  });

  it('DOES delete a stale port file before spawning', async () => {
    // The other direction: a stale file left in place is read as current, and
    // W0 measured it still serving the previous port for ~300ms after a
    // relaunch — always a wrong number, since every relaunch takes a new port.
    const dir = path.join(PROFILES, 'edge-default');
    const { deps, unlinked } = fakeFs({
      dirs: [PROFILES, dir],
      files: { [portFile(dir)]: '51000\n/x' },
    });
    const { launch } = launcherStub(52000);

    await startCdpBrowser(
      { projectRoot: ROOT, engine: 'edge' },
      { ...deps, launch, probe: probeFor({ 52000: 'edge' }) },
    );

    expect(unlinked).toEqual([portFile(dir)]);
  });

  it('reports launched_into_new_profile when the directory did not exist', async () => {
    const { deps } = fakeFs({ dirs: [PROFILES] });
    const { launch } = launcherStub();
    const result = await startCdpBrowser(
      { projectRoot: ROOT, engine: 'chrome', profile: 'fresh' },
      { ...deps, launch, probe: probeFor({ 40000: 'chrome' }) },
    );
    expect(result).toMatchObject({ ok: true, outcome: 'launched_into_new_profile' });
  });

  it('reports launched_into_existing_profile when the directory already existed', async () => {
    // The distinction the four removed booleans got wrong, and the one that
    // decides whether the agent warns the user about an inherited session.
    const dir = path.join(PROFILES, 'chrome-admin');
    const { deps } = fakeFs({ dirs: [PROFILES, dir] });
    const { launch } = launcherStub();
    const result = await startCdpBrowser(
      { projectRoot: ROOT, engine: 'chrome', profile: 'admin' },
      { ...deps, launch, probe: probeFor({ 40000: 'chrome' }) },
    );
    expect(result).toMatchObject({ ok: true, outcome: 'launched_into_existing_profile' });
  });

  it('asking for a profile that exists is not an error', async () => {
    const dir = path.join(PROFILES, 'chrome-admin');
    const { deps } = fakeFs({ dirs: [PROFILES, dir] });
    const { launch } = launcherStub();
    const result = await startCdpBrowser(
      { projectRoot: ROOT, engine: 'chrome', profile: 'admin' },
      { ...deps, launch, probe: probeFor({ 40000: 'chrome' }) },
    );
    expect(result.ok).toBe(true);
  });

  it('writes the .aiui-profile marker on every launch', async () => {
    const { deps, files } = fakeFs({ dirs: [PROFILES] });
    const { launch } = launcherStub();
    await startCdpBrowser(
      { projectRoot: ROOT, engine: 'chrome', profile: 'fresh' },
      { ...deps, launch, probe: probeFor({ 40000: 'chrome' }) },
    );
    expect(files.has(path.join(PROFILES, 'chrome-fresh', PROFILE_MARKER))).toBe(true);
  });

  it('refuses a bad profile name before touching the filesystem', async () => {
    const { deps, unlinked } = fakeFs({ dirs: [PROFILES] });
    const { launch, spy } = launcherStub();
    const result = await startCdpBrowser(
      { projectRoot: ROOT, engine: 'chrome', profile: '../../secrets' },
      { ...deps, launch },
    );
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(unlinked).toEqual([]);
  });

  it('two profiles of one engine get separate directories', async () => {
    const { deps } = fakeFs({ dirs: [PROFILES] });
    const a = launcherStub(111);
    const b = launcherStub(222);
    await startCdpBrowser(
      { projectRoot: ROOT, engine: 'edge', profile: 'admin' },
      { ...deps, launch: a.launch, probe: probeFor({ 111: 'edge' }) },
    );
    await startCdpBrowser(
      { projectRoot: ROOT, engine: 'edge', profile: 'user' },
      { ...deps, launch: b.launch, probe: probeFor({ 222: 'edge' }) },
    );
    expect(a.calls[0]!.profileDir).toBe(path.join(PROFILES, 'edge-admin'));
    expect(b.calls[0]!.profileDir).toBe(path.join(PROFILES, 'edge-user'));
  });

  it('surfaces a launcher failure as the start failure', async () => {
    const { deps } = fakeFs({ dirs: [PROFILES] });
    const launch = (async () => ({ ok: false as const, error: 'Edge is not installed' })) as
      unknown as RegistryDeps['launch'];
    const result = await startCdpBrowser({ projectRoot: ROOT, engine: 'edge' }, { ...deps, launch });
    expect(result).toMatchObject({ ok: false, error: 'Edge is not installed' });
  });
});

// ---------------------------------------------------------------------------
// §12 Reset — one test per guard
// ---------------------------------------------------------------------------

describe('resetProfile', () => {
  const portFile = (dir: string) => path.join(dir, 'DevToolsActivePort');
  const marker = (dir: string) => path.join(dir, PROFILE_MARKER);

  function withProfile(name = 'admin', engine: 'chrome' | 'edge' = 'edge') {
    const dir = path.join(PROFILES, `${engine}-${name}`);
    return {
      dir,
      fs: fakeFs({ dirs: [PROFILES, dir], files: { [marker(dir)]: '{}' } }),
    };
  }

  it('guard 1: refuses a name that is not a single path component', async () => {
    const { deps, renames } = fakeFs({ dirs: [PROFILES] });
    const result = await resetProfile(ROOT, 'edge', '../../secrets', deps);
    expect(result.ok).toBe(false);
    expect(renames).toEqual([]);
  });

  it('guard 2: refuses a symlinked profile directory, and its target survives', async () => {
    const dir = path.join(PROFILES, 'edge-admin');
    const target = path.join('C:', 'Users', 'dev', 'Documents');
    const { deps, dirs, renames, removed } = fakeFs({
      dirs: [PROFILES, dir, target],
      files: { [marker(dir)]: '{}' },
      symlinks: [dir],
    });

    const result = await resetProfile(ROOT, 'edge', 'admin', deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('symbolic link');
    expect(renames).toEqual([]);
    expect(removed).toEqual([]);
    expect(dirs.has(target)).toBe(true);
  });

  it('guard 3: refuses a directory that resolves outside the profiles root', async () => {
    const dir = path.join(PROFILES, 'edge-admin');
    const outside = path.join('C:', 'Users', 'dev', 'Documents');
    const { deps, dirs, renames } = fakeFs({
      dirs: [PROFILES, dir, outside],
      files: { [marker(dir)]: '{}' },
    });
    // realpath resolves the profile dir somewhere else entirely — exactly what
    // a symlink would do, and what path.resolve alone would miss.
    const result = await resetProfile(ROOT, 'edge', 'admin', {
      ...deps,
      realpath: (p) => (p === dir ? outside : p),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not a direct child');
    expect(renames).toEqual([]);
    expect(dirs.has(outside)).toBe(true);
  });

  it('guard 3: refuses the profiles root itself', async () => {
    const dir = path.join(PROFILES, 'edge-admin');
    const { deps, renames } = fakeFs({ dirs: [PROFILES, dir], files: { [marker(dir)]: '{}' } });
    const result = await resetProfile(ROOT, 'edge', 'admin', {
      ...deps,
      realpath: (p) => (p === dir ? PROFILES : p),
    });
    expect(result.ok).toBe(false);
    expect(renames).toEqual([]);
  });

  it('guard 4: refuses a directory with no marker EVEN when the path check passes', async () => {
    // A legitimate-looking dir in exactly the right place. The marker is the
    // guard that does not depend on the path logic being right, so it is
    // asserted against the case where the path logic is happy.
    const dir = path.join(PROFILES, 'edge-admin');
    const { deps, renames, removed } = fakeFs({ dirs: [PROFILES, dir] });

    const result = await resetProfile(ROOT, 'edge', 'admin', deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(PROFILE_MARKER);
    expect(result.error).toContain('did not create it');
    expect(renames).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('guard 5: refuses while a browser is live, naming the port to close', async () => {
    const dir = path.join(PROFILES, 'edge-admin');
    const { deps, renames } = fakeFs({
      dirs: [PROFILES, dir],
      files: { [marker(dir)]: '{}', [portFile(dir)]: '51000\n/x' },
    });

    const result = await resetProfile(ROOT, 'edge', 'admin', {
      ...deps,
      probe: probeFor({ 51000: 'edge' }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('51000');
    expect(result.error).toContain('Close that browser');
    expect(renames).toEqual([]);
  });

  it('guard 6: a failed rename leaves the profile fully intact', async () => {
    const { dir, fs: f } = withProfile();
    const result = await resetProfile(ROOT, 'edge', 'admin', {
      ...f.deps,
      probe: probeFor({}),
      rename: () => {
        throw new Error('EBUSY: resource busy or locked');
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('EBUSY');
    // The atomicity guarantee is only useful if the message states it.
    expect(result.error).toContain('Nothing was deleted');
    expect(f.dirs.has(dir)).toBe(true);
    expect(f.files.has(marker(dir))).toBe(true);
    expect(f.removed).toEqual([]);
  });

  it('renames before deleting, so the profile is never half-removed', async () => {
    const { dir, fs: f } = withProfile();
    const result = await resetProfile(ROOT, 'edge', 'admin', { ...f.deps, probe: probeFor({}) });

    expect(result.ok).toBe(true);
    expect(f.renames).toHaveLength(1);
    expect(f.renames[0]![0]).toBe(dir);
    expect(f.renames[0]![1]).toContain('.trash-edge-admin-');
    // The staging dir is inside cdp-profiles so the rename stays on one
    // filesystem and therefore stays atomic.
    expect(path.dirname(f.renames[0]![1])).toBe(PROFILES);
    expect(f.removed).toEqual([f.renames[0]![1]]);
    expect(f.dirs.has(dir)).toBe(false);
  });

  it('a failed cleanup of the staging directory is a warning, not an error', async () => {
    const { fs: f } = withProfile();
    const result = await resetProfile(ROOT, 'edge', 'admin', {
      ...f.deps,
      probe: probeFor({}),
      rm: () => {
        throw new Error('EPERM');
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toContain('.trash-edge-admin-');
  });

  it('an absent profile is a successful reset — there is nothing to empty', async () => {
    const { deps, renames } = fakeFs({ dirs: [PROFILES] });
    const result = await resetProfile(ROOT, 'edge', 'never-existed', deps);
    expect(result.ok).toBe(true);
    expect(renames).toEqual([]);
  });
});

describe('startCdpBrowser with reset', () => {
  const marker = (dir: string) => path.join(dir, PROFILE_MARKER);

  it('wipes the profile, relaunches and reports launched_after_reset', async () => {
    const dir = path.join(PROFILES, 'edge-signup');
    const { deps, dirs, files } = fakeFs({ dirs: [PROFILES, dir], files: { [marker(dir)]: '{}' } });
    const { launch } = launcherStub(41000);

    const result = await startCdpBrowser(
      { projectRoot: ROOT, engine: 'edge', profile: 'signup', reset: true },
      { ...deps, launch, probe: probeFor({ 41000: 'edge' }) },
    );

    expect(result).toMatchObject({ ok: true, outcome: 'launched_after_reset' });
    // Marker recreated on the way back out, so the profile can be reset again.
    expect(files.has(marker(dir))).toBe(true);
    expect(dirs.has(dir)).toBe(true);
  });

  it('a refused reset refuses the whole start — nothing is launched', async () => {
    const dir = path.join(PROFILES, 'edge-admin');
    const { deps } = fakeFs({ dirs: [PROFILES, dir] }); // no marker
    const { launch, spy } = launcherStub();

    const result = await startCdpBrowser(
      { projectRoot: ROOT, engine: 'edge', profile: 'admin', reset: true },
      { ...deps, launch, probe: probeFor({}) },
    );

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Closing a tab (stories/cdp-tabs.md §2)
//
// Every guard gets its own test, because each closes a different hole and a
// single "it refuses bad input" would pass with any one of them implemented.
// ---------------------------------------------------------------------------

describe('closeCdpTab', () => {
  const DIR = path.join(PROFILES, 'edge-default');
  const PORT = 51000;

  /** A live edge/default browser on PORT, with `tabs` open. */
  function liveBrowser(tabs: { targetId: string; title: string; url: string }[]) {
    const { deps } = fakeFs({
      dirs: [PROFILES, DIR],
      files: { [path.join(DIR, 'DevToolsActivePort')]: `${PORT}\n/devtools/browser/x` },
    });
    // The tab list mutates as tabs are closed, so the confirm-gone poll is
    // exercised against something that actually changes.
    let open = [...tabs];
    const closed: string[] = [];
    let alivePort = true;
    const closeFn = vi.fn(async (_port: number, targetId: string) => {
      closed.push(targetId);
      open = open.filter((t) => t.targetId !== targetId);
      if (open.length === 0) alivePort = false; // last tab ends the browser
      return { ok: true, notFound: false, error: null };
    });
    return {
      deps: {
        ...deps,
        probe: probeFor({ [PORT]: 'edge' }),
        close: closeFn as never,
        listTabs: (async () => (alivePort ? open : null)) as never,
        alive: (async () => alivePort) as never,
        sleep: async () => {},
      },
      closeFn,
      closed,
      openTabs: () => open,
      setAlive: (v: boolean) => {
        alivePort = v;
      },
    };
  }

  const TWO_TABS = [
    { targetId: 'A1B2C3', title: 'OpenRouter — Docs', url: 'https://openrouter.ai/docs' },
    { targetId: 'D4E5F6', title: 'Cart — Shop', url: 'https://shop.example/cart' },
  ];

  it('closes an ordinary tab and reports it gone, with a real remaining count', async () => {
    const h = liveBrowser(TWO_TABS);
    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({
      ok: true,
      targetId: 'A1B2C3',
      title: 'OpenRouter — Docs',
      url: 'https://openrouter.ai/docs',
      engine: 'edge',
      profile: 'default',
      remainingTabs: 1,
      browserExited: false,
    });
    expect(h.openTabs().map((t) => t.targetId)).toEqual(['D4E5F6']);
  });

  it('refuses a port that is not one of ours, and closes nothing', async () => {
    const h = liveBrowser(TWO_TABS);
    const result = await closeCdpTab(
      { projectRoot: ROOT, port: 9222, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'not_found' });
    // Names what we DO have, so the caller can correct itself in one step.
    expect((result as { error: string }).error).toContain('51000');
    expect(h.closeFn).not.toHaveBeenCalled();
  });

  it('refuses an unknown target id, stating BOTH readings', async () => {
    // "Already closed" and "wrong browser" are indistinguishable from here, and
    // treating the pair as an idempotent success would swallow the second.
    const h = liveBrowser(TWO_TABS);
    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'NOPE' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'not_found' });
    const error = (result as { error: string }).error;
    expect(error).toMatch(/already been closed/i);
    expect(error).toMatch(/different browser/i);
    expect(error).toContain('list_cdp_browsers');
    expect(h.closeFn).not.toHaveBeenCalled();
  });

  it('refuses the last tab without allowBrowserExit, and says why', async () => {
    const h = liveBrowser([TWO_TABS[0]!]);
    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'refused' });
    const error = (result as { error: string }).error;
    expect(error).toContain('allow_browser_exit');
    // The reassurance is part of the contract: without it, "the browser will
    // close" reads as "the login will be lost", which is false.
    expect(error).toMatch(/signed in/i);
    expect(error).toContain('start_cdp_browser');
    expect(h.closeFn).not.toHaveBeenCalled();
  });

  it('closes the last tab with allowBrowserExit, and reports the browser exited', async () => {
    const h = liveBrowser([TWO_TABS[0]!]);
    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3', allowBrowserExit: true },
      h.deps,
    );

    expect(result).toMatchObject({
      ok: true,
      browserExited: true,
      remainingTabs: 0,
      warnings: [],
    });
    expect(h.closed).toEqual(['A1B2C3']);
  });

  it('reports browserExited FALSE when the process outlives its last tab', async () => {
    // macOS app semantics, or an Edge background mode. W0 saw a clean exit on
    // both engines here, so this branch is the surprising one — and reporting
    // an exit that did not happen would be a lie the user can see through by
    // looking at their taskbar.
    const h = liveBrowser([TWO_TABS[0]!]);
    // The tab really does close; only the process stays. So the list must
    // still hold the tab for the pre-close read and be empty afterwards —
    // emptying it up front would fail the target lookup instead, testing a
    // different branch entirely.
    let gone = false;
    h.deps.close = (async () => {
      gone = true;
      return { ok: true, notFound: false, error: null };
    }) as never;
    h.deps.listTabs = (async () => (gone ? [] : [TWO_TABS[0]!])) as never;
    h.deps.alive = (async () => true) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3', allowBrowserExit: true },
      h.deps,
    );

    expect(result).toMatchObject({ ok: true, browserExited: false });
    expect((result as { warnings: string[] }).warnings.join(' ')).toMatch(/still\s+running/i);
  });

  it('refuses a tab a live session is driving, naming the session', async () => {
    const h = liveBrowser(TWO_TABS);
    const result = await closeCdpTab(
      {
        projectRoot: ROOT,
        port: PORT,
        targetId: 'D4E5F6',
        sessionHolding: (id) => (id === 'D4E5F6' ? 'mcp:x' : null),
      },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'refused' });
    const error = (result as { error: string }).error;
    expect(error).toContain('mcp:x');
    expect(error).toContain('close_session');
    expect(h.closeFn).not.toHaveBeenCalled();
  });

  it('closes a tab no session holds, even while another tab is held', async () => {
    // The guard is per-tab, not per-browser: a session on one tab must not
    // freeze the whole window.
    const h = liveBrowser(TWO_TABS);
    const result = await closeCdpTab(
      {
        projectRoot: ROOT,
        port: PORT,
        targetId: 'A1B2C3',
        sessionHolding: (id) => (id === 'D4E5F6' ? 'mcp:x' : null),
      },
      h.deps,
    );

    expect(result).toMatchObject({ ok: true, targetId: 'A1B2C3' });
  });

  it('refuses a session-held LAST tab by naming the session, not the exit flag', async () => {
    // The cheap ordering (last-tab first) produced a remedy that does not
    // work: the caller is told to pass allow_browser_exit, does so, and hits a
    // completely different refusal. A one-tab browser driven by a session is
    // reachable — `cdp.tab: 'targetId:<id>'` binds an existing tab and opens
    // nothing new — so the session check has to come first.
    const h = liveBrowser([TWO_TABS[0]!]);
    const result = await closeCdpTab(
      {
        projectRoot: ROOT,
        port: PORT,
        targetId: 'A1B2C3',
        sessionHolding: () => 'mcp:cart',
      },
      h.deps,
    );
    const error = (result as { error: string }).error;
    expect(error).toContain('mcp:cart');
    expect(error).toContain('close_session');
    expect(error).not.toContain('allow_browser_exit');
  });

  it('reports a tab something else closed first, rather than claiming the close', async () => {
    // The browser answers 404 for an id it no longer has. Absorbing that as
    // success would hand back `closed: true` with a title and url for a tab
    // this call did not close.
    const h = liveBrowser(TWO_TABS);
    h.deps.close = (async () => ({ ok: false, notFound: true, error: 'HTTP 404' })) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'not_found' });
    expect((result as { error: string }).error).toMatch(/something else closed it/i);
  });

  it('does not report "still open" about a browser that exited mid-close', async () => {
    // The poll predicate required a READABLE tab list, so a browser that went
    // away during the close could never satisfy it: the full budget burned,
    // then a 500 telling the agent the tab was still open and blaming a
    // "leave site?" dialog — about a browser that no longer existed.
    const h = liveBrowser(TWO_TABS);
    let closedYet = false;
    h.deps.close = (async () => { closedYet = true; return { ok: true, notFound: false, error: null }; }) as never;
    h.deps.listTabs = (async () => (closedYet ? null : TWO_TABS)) as never;
    h.deps.alive = (async () => false) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: true, browserExited: true, remainingTabs: 0 });
  });

  it('warns when an ordinary close leaves a running browser with no tabs', async () => {
    const h = liveBrowser(TWO_TABS);
    let stage = 0;
    h.deps.close = (async () => ({ ok: true, notFound: false, error: null })) as never;
    h.deps.listTabs = (async () => (stage++ === 0 ? TWO_TABS : [])) as never;
    h.deps.alive = (async () => true) as never;
    let clock = 0;
    h.deps.now = (() => (clock += 500)) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    // Zero tabs and a live browser is a contradiction to a reader; it must not
    // be reported in silence.
    expect((result as { warnings: string[] }).warnings.join(' ')).toMatch(/still running/i);
  });

  it('refuses an unowned port, and closes it when allowUnowned is passed', async () => {
    // `knownProfiles` only ever holds this project's profiles, so without the
    // flag a foreign browser can never be closed however the caller is
    // permitted — which made mcp.cdp.allowUnowned advertise something it could
    // not deliver.
    const h = liveBrowser(TWO_TABS);
    h.deps.probe = probeFor({ 9222: 'chrome' }) as never;
    h.deps.listTabs = (async () => TWO_TABS.slice(0, 1)) as never;

    const refused = await closeCdpTab(
      { projectRoot: ROOT, port: 9222, targetId: 'A1B2C3' },
      h.deps,
    );
    expect(refused).toMatchObject({ ok: false, kind: 'not_found' });

    const allowed = await closeCdpTab(
      { projectRoot: ROOT, port: 9222, targetId: 'A1B2C3', allowUnowned: true, allowBrowserExit: true },
      h.deps,
    );
    expect(allowed).toMatchObject({ ok: true, targetId: 'A1B2C3' });
    // No profile of ours stands behind it, and the result says so rather than
    // inventing a name.
    expect((allowed as { profile: string }).profile).not.toBe('default');
  });

  it('still refuses an unowned port with nothing listening on it', async () => {
    const h = liveBrowser(TWO_TABS);
    h.deps.probe = probeFor({}) as never;
    const result = await closeCdpTab(
      { projectRoot: ROOT, port: 9222, targetId: 'A1B2C3', allowUnowned: true },
      h.deps,
    );
    expect(result).toMatchObject({ ok: false, kind: 'not_found' });
    expect((result as { error: string }).error).toMatch(/nothing is listening/i);
  });

  it('counts tabs through the SHARED filter, so the last-tab guard cannot drift', async () => {
    // Story's named must-have test. Every other close test injects `listTabs`,
    // which leaves the real tab source — and therefore the filter — unexercised
    // by this path. A mutation removing `toPageTabs` from `listPageTabs` left
    // 169 tests green.
    //
    // This browser has ONE page tab plus an extension page and a devtools
    // page. If the close path counted raw targets it would see three, decide
    // this is not the last tab, and silently exit the browser.
    const { deps } = fakeFs({
      dirs: [PROFILES, DIR],
      files: { [path.join(DIR, 'DevToolsActivePort')]: `${PORT}\n/devtools/browser/x` },
    });
    const raw = [
      { id: 'A1B2C3', type: 'page', title: 'Orders', url: 'https://shop/orders' },
      { id: 'x1', type: 'page', title: 'Ext', url: 'chrome-extension://abc/x.html' },
      { id: 'x2', type: 'page', title: 'DevTools', url: 'devtools://devtools/y' },
      { id: 'x3', type: 'service_worker', title: 'sw', url: 'https://shop/sw.js' },
    ];
    const fetchFn = (async (url: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/json/list') ? raw : { Browser: 'Edg/151.0' }),
    })) as unknown as typeof fetch;

    const closeSpy = vi.fn(async () => ({ ok: true, notFound: false, error: null }));
    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      {
        ...deps,
        probe: probeFor({ [PORT]: 'edge' }),
        // The REAL listPageTabs — the whole point of this test.
        listTabs: ((p: number) => listPageTabs(p, 100, fetchFn)) as never,
        close: closeSpy as never,
        alive: (async () => true) as never,
        sleep: async () => {},
      },
    );

    expect(result).toMatchObject({ ok: false, kind: 'refused' });
    expect((result as { error: string }).error).toContain('allow_browser_exit');
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('does not report success when the tab never actually goes away', async () => {
    // The browser acknowledges a close in 1-5ms but the tab takes 7-41ms to
    // leave the list (W0), so the ack alone is an intention. A tab held open
    // by a "leave site?" dialog must not be reported as closed.
    const h = liveBrowser(TWO_TABS);
    h.deps.close = (async () => ({ ok: true, notFound: false, error: null })) as never;
    h.deps.listTabs = (async () => TWO_TABS) as never;
    let clock = 0;
    h.deps.now = (() => (clock += 500)) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'launch_failed' });
    expect((result as { error: string }).error).toMatch(/leave site/i);
  });

  it('reports the browser exited when a concurrent close emptied it', async () => {
    // Found in live testing, not predicted. A slow-closing tab finished during
    // our own close, the browser dropped to zero tabs and exited, and the
    // result said `browserExited: false` — so an agent would have told the user
    // their browser was still open while it was gone from the taskbar.
    //
    // `before.length > 1` describes one instant, not a guarantee. When nothing
    // is left afterwards, ask the port instead of trusting the earlier count.
    const h = liveBrowser(TWO_TABS);
    let stage = 0;
    h.deps.close = (async () => ({ ok: true, notFound: false, error: null })) as never;
    // Before the close: both tabs. After: none — the other tab went too.
    h.deps.listTabs = (async () => (stage++ === 0 ? TWO_TABS : [])) as never;
    h.deps.alive = (async () => false) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: true, remainingTabs: 0, browserExited: true });
  });

  it('does not claim an exit when an empty browser is still running', async () => {
    // The other half: zero tabs and a live port is a resident process, not an
    // exit. Reporting `browserExited: true` there would be the same lie in
    // reverse.
    const h = liveBrowser(TWO_TABS);
    let stage = 0;
    h.deps.close = (async () => ({ ok: true, notFound: false, error: null })) as never;
    h.deps.listTabs = (async () => (stage++ === 0 ? TWO_TABS : [])) as never;
    h.deps.alive = (async () => true) as never;
    let clock = 0;
    h.deps.now = (() => (clock += 500)) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: true, remainingTabs: 0, browserExited: false });
  });

  it('does not report a close as done because ONE tab-list read failed', async () => {
    // Round-two regression. The fix for "a browser that exited mid-close can
    // never satisfy the poll" over-reached: it treated EVERY unreadable list as
    // an exit. `listPageTabs` returns null for a failed fetch, a non-200, a
    // parse error or a 1.5s abort — and the poll runs ~200 times against a tab
    // showing a "Leave site?" dialog, so one flaky read reported `closed: true`
    // for a tab the function's own final read could still see.
    const h = liveBrowser(TWO_TABS);
    let reads = 0;
    h.deps.close = (async () => ({ ok: true, notFound: false, error: null })) as never;
    // First poll read fails; every other read succeeds and still has the tab.
    h.deps.listTabs = (async () => (++reads === 1 ? null : TWO_TABS)) as never;
    h.deps.alive = (async () => true) as never; // browser is perfectly fine
    let clock = 0;
    h.deps.now = (() => (clock += 500)) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'launch_failed' });
  });

  it('refuses when it cannot determine whether a session holds the tab', async () => {
    // A guard must fail CLOSED. "I could not find out" reaching the caller as
    // "nobody holds it" is how a slow lookup closes a tab out from under a
    // live run.
    const h = liveBrowser(TWO_TABS);
    const result = await closeCdpTab(
      {
        projectRoot: ROOT,
        port: PORT,
        targetId: 'A1B2C3',
        sessionHolding: () => UNKNOWN_HOLDER,
      },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'refused' });
    const error = (result as { error: string }).error;
    expect(error).toMatch(/could not determine/i);
    expect(error).toMatch(/nothing was closed/i);
    expect(h.closeFn).not.toHaveBeenCalled();
  });

  it('does not promise a foreign browser can be reopened', async () => {
    // The last-tab reassurance is true only of a profile we own. For someone
    // else's signed-in Chrome every clause of it is false, and it is the
    // sentence that decides whether the agent asks before terminating it.
    const h = liveBrowser(TWO_TABS);
    h.deps.probe = probeFor({ 9222: 'chrome' }) as never;
    h.deps.listTabs = (async () => [TWO_TABS[0]!]) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: 9222, targetId: 'A1B2C3', allowUnowned: true },
      h.deps,
    );

    const error = (result as { error: string }).error;
    expect(error).toContain('allow_browser_exit');
    expect(error).not.toMatch(/keeps its signed-in state/i);
    expect(error).not.toContain('start_cdp_browser');
    expect(error).toMatch(/not one this project started/i);
    // And no empty-quoted profile name leaking into the prose.
    expect(error).not.toContain('""');
  });

  it('reports `owned` so the caller can tell whose browser it closed', async () => {
    const h = liveBrowser(TWO_TABS);
    const ours = await closeCdpTab({ projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' }, h.deps);
    expect(ours).toMatchObject({ ok: true, owned: true, profile: 'default' });

    // Keep the harness's stateful tab list — overriding it with a constant
    // means the closed tab never disappears and the poll burns its budget.
    const other = liveBrowser(TWO_TABS);
    other.deps.probe = probeFor({ 9222: 'chrome' }) as never;
    const theirs = await closeCdpTab(
      { projectRoot: ROOT, port: 9222, targetId: 'A1B2C3', allowUnowned: true },
      other.deps,
    );
    expect(theirs).toMatchObject({ ok: true, owned: false, profile: '' });
  });

  it('surfaces a browser that refuses the close outright', async () => {
    const h = liveBrowser(TWO_TABS);
    h.deps.close = (async () => ({ ok: false, notFound: false, error: 'HTTP 500' })) as never;

    const result = await closeCdpTab(
      { projectRoot: ROOT, port: PORT, targetId: 'A1B2C3' },
      h.deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'launch_failed' });
    expect((result as { error: string }).error).toContain('HTTP 500');
  });
});
