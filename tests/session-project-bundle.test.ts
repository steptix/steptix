/**
 * Tests for SessionManager's per-project env/data/config resolution
 * (`resolveProjectBundle`): the bundle is anchored at the TEST FILE's project
 * root (not the server cwd), mtime-cached, isolated per project, with a defaults
 * fallback when no aiui.config.json is found and a hard error on malformed config.
 *
 * `resolveProjectBundle` is private; we reach it via a cast since it's a pure
 * filesystem operation (no browser/AI needed) and is the riskiest new code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/server/session-manager.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { Config } from '../src/config/types.js';

interface ProjectBundleLike {
  projectRoot: string | null;
  config: Config;
  envBundle: { envName: string | null; env: Record<string, string>; data: Record<string, unknown> } | null;
  ambiguousTarget: 'first' | 'fail';
}

/** Reach the private resolver. */
function resolveBundle(
  mgr: SessionManager,
  testFilePath: string | undefined,
  envName: string | null,
): Promise<ProjectBundleLike> {
  return (mgr as unknown as {
    resolveProjectBundle(t: string | undefined, e: string | null): Promise<ProjectBundleLike>;
  }).resolveProjectBundle(testFilePath, envName);
}

/** Write a minimal project: aiui.config.json (+dataDir), .env.<env>, <dataDir>/<env>.json. */
function writeProject(
  root: string,
  opts: { dataDir?: string; configJson?: string; env?: string; envVars?: string; data?: unknown } = {},
): void {
  const dataDir = opts.dataDir ?? 'data';
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  const configJson =
    opts.configJson ?? JSON.stringify({ tests: { dataDir } });
  writeFileSync(path.join(root, 'aiui.config.json'), configJson);
  if (opts.env) {
    writeFileSync(path.join(root, `.env.${opts.env}`), opts.envVars ?? '');
    if (opts.data !== undefined) {
      mkdirSync(path.join(root, dataDir), { recursive: true });
      writeFileSync(path.join(root, dataDir, `${opts.env}.json`), JSON.stringify(opts.data));
    }
  }
}

describe('SessionManager.resolveProjectBundle', () => {
  let tmp: string;
  let mgr: SessionManager;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'aiui-pb-'));
    mgr = new SessionManager(structuredClone(DEFAULT_CONFIG));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('resolves config + env + data from the test file project root', async () => {
    const root = path.join(tmp, 'projA');
    // Unique var name so the purity check isn't confused by ambient env vars.
    writeProject(root, { dataDir: 'data', env: 'uat', envVars: 'PROJA_ONLY_URL=https://a.example\n', data: { region: 'au' } });

    const bundle = await resolveBundle(mgr, path.join(root, 'tests', 't.md'), 'uat');

    expect(bundle.projectRoot).toBe(root);
    expect(bundle.config.tests.dataDir).toBe('data');
    expect(bundle.envBundle?.env['PROJA_ONLY_URL']).toBe('https://a.example');
    expect(bundle.envBundle?.data).toEqual({ region: 'au' });
    // Pure: the project's env never leaks into the global.
    expect(process.env['PROJA_ONLY_URL']).toBeUndefined();
  });

  it('honours a custom tests.dataDir from the project config', async () => {
    const root = path.join(tmp, 'projCustom');
    writeProject(root, { dataDir: 'fixtures/data', env: 'uat', envVars: 'X=1\n', data: { region: 'eu' } });

    const bundle = await resolveBundle(mgr, path.join(root, 'tests', 't.md'), 'uat');

    expect(bundle.config.tests.dataDir).toBe('fixtures/data');
    expect(bundle.envBundle?.data).toEqual({ region: 'eu' });
  });

  it('isolates two projects — neither sees the other\'s env/data', async () => {
    const rootA = path.join(tmp, 'a');
    const rootB = path.join(tmp, 'b');
    writeProject(rootA, { env: 'uat', envVars: 'SECRET=aaa\n', data: { who: 'A' } });
    writeProject(rootB, { env: 'uat', envVars: 'SECRET=bbb\n', data: { who: 'B' } });

    const a = await resolveBundle(mgr, path.join(rootA, 'tests', 't.md'), 'uat');
    const b = await resolveBundle(mgr, path.join(rootB, 'tests', 't.md'), 'uat');

    expect(a.envBundle?.env['SECRET']).toBe('aaa');
    expect(b.envBundle?.env['SECRET']).toBe('bbb');
    expect(a.envBundle?.data).toEqual({ who: 'A' });
    expect(b.envBundle?.data).toEqual({ who: 'B' });
  });

  it('re-reads after a data-file edit (mtime invalidation)', async () => {
    const root = path.join(tmp, 'projEdit');
    writeProject(root, { env: 'uat', envVars: 'X=1\n', data: { v: 'first' } });
    const t = path.join(root, 'tests', 't.md');

    const first = await resolveBundle(mgr, t, 'uat');
    expect(first.envBundle?.data).toEqual({ v: 'first' });

    // Edit the data file and bump its mtime decisively into the future.
    const dataFile = path.join(root, 'data', 'uat.json');
    writeFileSync(dataFile, JSON.stringify({ v: 'second' }));
    const future = new Date(Date.now() + 5000);
    utimesSync(dataFile, future, future);

    const second = await resolveBundle(mgr, t, 'uat');
    expect(second.envBundle?.data).toEqual({ v: 'second' });
  });

  it('serves an unchanged bundle from cache (same object identity)', async () => {
    const root = path.join(tmp, 'projCache');
    writeProject(root, { env: 'uat', envVars: 'X=1\n', data: { v: 1 } });
    const t = path.join(root, 'tests', 't.md');

    const first = await resolveBundle(mgr, t, 'uat');
    const second = await resolveBundle(mgr, t, 'uat');
    expect(second).toBe(first); // cached: identical object, no re-read
  });

  it('falls back to defaults when no aiui.config.json is found above the test file', async () => {
    // A bare temp dir with no config anywhere up to the fs root.
    const stray = mkdtempSync(path.join(tmpdir(), 'aiui-noconfig-'));
    try {
      const bundle = await resolveBundle(mgr, path.join(stray, 't.md'), 'uat');
      expect(bundle.projectRoot).toBeNull();
      // Defaults config (startup) is used; env bundle is the baseline + empty data.
      expect(bundle.config.tests.dataDir).toBe(DEFAULT_CONFIG.tests.dataDir);
      expect(bundle.envBundle?.envName).toBe('uat');
      expect(bundle.envBundle?.data).toEqual({});
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });

  it('throws on a malformed project aiui.config.json (fails only this request)', async () => {
    const root = path.join(tmp, 'projBad');
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'aiui.config.json'), '{ not valid json');

    await expect(
      resolveBundle(mgr, path.join(root, 'tests', 't.md'), 'uat'),
    ).rejects.toThrow(/aiui\.config\.json/);
  });

  it('loads no env/data when envName is null', async () => {
    const root = path.join(tmp, 'projNoEnv');
    writeProject(root, { env: 'uat', envVars: 'X=1\n', data: { v: 1 } });

    const bundle = await resolveBundle(mgr, path.join(root, 'tests', 't.md'), null);
    expect(bundle.envBundle).toBeNull();
    expect(bundle.config.tests.dataDir).toBe('data');
  });

  it('dedupes concurrent resolutions of the same key (inflight)', async () => {
    const root = path.join(tmp, 'projConc');
    writeProject(root, { env: 'uat', envVars: 'X=1\n', data: { v: 1 } });
    const t = path.join(root, 'tests', 't.md');

    // Fire two WITHOUT awaiting between them — the second must ride the first's
    // in-flight load rather than reading from disk again.
    const [a, b] = await Promise.all([resolveBundle(mgr, t, 'uat'), resolveBundle(mgr, t, 'uat')]);
    expect(a).toBe(b);
  });

  it('a thrown bad-config does not poison the cache — a later fix is picked up', async () => {
    const root = path.join(tmp, 'projRecover');
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'aiui.config.json'), '{ not valid json');
    const t = path.join(root, 'tests', 't.md');

    await expect(resolveBundle(mgr, t, null)).rejects.toThrow(/aiui\.config\.json/);

    // Fix the config; the failed attempt must not have been cached, and the
    // in-flight entry must have been cleaned up, so this now succeeds.
    writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify({ tests: { dataDir: 'data' } }));
    const bundle = await resolveBundle(mgr, t, null);
    expect(bundle.config.tests.dataDir).toBe('data');
  });

  it('invalidates when a previously-absent data file later appears', async () => {
    const root = path.join(tmp, 'projAppear');
    writeProject(root, { env: 'uat', envVars: 'X=1\n' }); // no data file yet
    const t = path.join(root, 'tests', 't.md');

    const first = await resolveBundle(mgr, t, 'uat');
    expect(first.envBundle?.data).toEqual({});

    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'uat.json'), JSON.stringify({ appeared: true }));

    const second = await resolveBundle(mgr, t, 'uat');
    expect(second.envBundle?.data).toEqual({ appeared: true });
  });
});

/**
 * `browser.ambiguousTarget` on the SERVER path
 * (stories/codebehind-selector-ambiguity.md).
 *
 * The story's implementation note is the whole point of this block: a new key
 * under `browser` consumed at session-creation time has to arrive through the
 * project bundle, or it is honoured only under the CLI and silently ignored
 * everywhere a server (and therefore TestBench) runs the test. So the
 * assertions are deliberately about *whose* config decided the value, not just
 * about the value being readable — a bundle that echoed the server's startup
 * config would pass a naive "is it 'fail'?" check while shipping the bug.
 */
describe("resolveProjectBundle — browser.ambiguousTarget", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'aiui-amb-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A SessionManager whose STARTUP config is the server's, not the project's. */
  function managerWith(startup?: 'first' | 'fail'): SessionManager {
    const config = structuredClone(DEFAULT_CONFIG);
    if (startup) config.browser.ambiguousTarget = startup;
    return new SessionManager(config);
  }

  it("a project that sets 'fail' is seen as 'fail' by a server started on the default", async () => {
    const root = path.join(tmp, 'projFail');
    writeProject(root, { configJson: JSON.stringify({ browser: { ambiguousTarget: 'fail' } }) });

    // Server startup config is the built-in default ('first'). The ONLY place
    // 'fail' exists is the project's own aiui.config.json.
    const bundle = await resolveBundle(managerWith(), path.join(root, 'tests', 't.md'), null);

    expect(bundle.projectRoot).toBe(root);
    expect(bundle.ambiguousTarget).toBe('fail');
    // Both surfaces agree — the hoisted field and the config it came from.
    expect(bundle.config.browser.ambiguousTarget).toBe('fail');
  });

  it("a server started on 'fail' does not impose it on a project that says nothing", async () => {
    // The other direction, and the one that proves the value is per-PROJECT
    // rather than merely non-default: the project config exists and is silent,
    // so it resolves to the built-in 'first' even though the server's own
    // startup config says 'fail'.
    const root = path.join(tmp, 'projSilent');
    writeProject(root, { configJson: JSON.stringify({ tests: { dataDir: 'data' } }) });

    const bundle = await resolveBundle(managerWith('fail'), path.join(root, 'tests', 't.md'), null);

    expect(bundle.projectRoot).toBe(root);
    expect(bundle.ambiguousTarget).toBe('first');
    expect(bundle.config.browser.ambiguousTarget).toBe('first');
  });

  it('two projects on one server get their own answers', async () => {
    const strict = path.join(tmp, 'strictProj');
    const lax = path.join(tmp, 'laxProj');
    writeProject(strict, { configJson: JSON.stringify({ browser: { ambiguousTarget: 'fail' } }) });
    writeProject(lax, { configJson: JSON.stringify({ browser: { ambiguousTarget: 'first' } }) });

    const mgr = managerWith();
    const a = await resolveBundle(mgr, path.join(strict, 'tests', 't.md'), null);
    const b = await resolveBundle(mgr, path.join(lax, 'tests', 't.md'), null);

    expect(a.ambiguousTarget).toBe('fail');
    expect(b.ambiguousTarget).toBe('first');
  });

  it('picks up an edit to the setting on the next resolve (mtime invalidation)', async () => {
    // The bundle now caches a RESOLVED value, not just the config it came from,
    // so the cache has to invalidate on it like every other bundle input —
    // otherwise turning the switch on means restarting the server.
    const root = path.join(tmp, 'projEditAmb');
    writeProject(root, { configJson: JSON.stringify({ tests: { dataDir: 'data' } }) });
    const t = path.join(root, 'tests', 't.md');
    const mgr = managerWith();

    expect((await resolveBundle(mgr, t, null)).ambiguousTarget).toBe('first');

    const configFile = path.join(root, 'aiui.config.json');
    writeFileSync(configFile, JSON.stringify({ browser: { ambiguousTarget: 'fail' } }));
    const future = new Date(Date.now() + 5000);
    utimesSync(configFile, future, future);

    expect((await resolveBundle(mgr, t, null)).ambiguousTarget).toBe('fail');
  });

  it('falls back to the server startup config when there is no project root', async () => {
    // No aiui.config.json anywhere above the file: the server's own value is
    // the only one there is, which is the documented null-project fallback.
    const stray = mkdtempSync(path.join(tmpdir(), 'aiui-amb-noconfig-'));
    try {
      const bundle = await resolveBundle(managerWith('fail'), path.join(stray, 't.md'), null);
      expect(bundle.projectRoot).toBeNull();
      expect(bundle.ambiguousTarget).toBe('fail');
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });

  it("normalises anything that is not 'fail' to 'first'", async () => {
    // A hand-edited config can carry a value the JSON schema would have flagged
    // in the editor but the loader never validates. Absence, a typo and
    // `'first'` all have to mean today's behaviour — the gate is `=== 'fail'`,
    // so a typo must not read as "on".
    const root = path.join(tmp, 'projTypo');
    writeProject(root, { configJson: JSON.stringify({ browser: { ambiguousTarget: 'strict' } }) });

    const bundle = await resolveBundle(managerWith(), path.join(root, 'tests', 't.md'), null);
    expect(bundle.ambiguousTarget).toBe('first');
  });
});
