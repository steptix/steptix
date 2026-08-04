import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  cdpProfilesRoot,
  profileDirFor,
  validateProfileName,
  parseProfileDirName,
  knownProfiles,
  startCdpBrowser,
  resetProfile,
  PROFILE_MARKER,
  type RegistryDeps,
} from '../src/browser/cdp-registry.js';

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
