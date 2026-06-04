import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  resolveEffectiveEnv,
  resolveTestCacheBase,
  cacheDirForRun,
} from '../src/runner/test-runner.js';
import {
  cacheDirName,
  envCacheSegment,
  NO_ENV_NAMESPACE,
} from '../src/cache/step-cache.js';

// The CLI cache seam (issues 012 + 027 + 028). `runTest` composes its on-disk
// cache directory as:
//   <cache.dir>/<env-segment>/<basename>-<hash>/
// where the env-segment comes from the env the test ACTUALLY ran under and the
// <basename>-<hash> is path-derived (NOT title-derived). These tests exercise
// the three exported, browser-free helpers that make up that composition.

const ROOT = path.join('proj');
const TEST_FILE = path.join('proj', 'tests', 'checkout.md');
const CACHE_DIR = path.join('proj', '.cache');

describe('resolveEffectiveEnv — env precedence (issue 012, CRITICAL note #1)', () => {
  // run.ts honours a run-wide --env/AUTOMATION_ENV unconditionally and only
  // consults frontmatter env when no run-wide env is set, so the CLI flag WINS.
  // The cache must be keyed by the env the test ACTUALLY ran under.
  it('runEnvName (CLI flag) WINS over frontmatter env', () => {
    expect(resolveEffectiveEnv('staging', 'dev')).toBe('staging');
  });

  it('frontmatter env is used when runEnvName is undefined', () => {
    expect(resolveEffectiveEnv(undefined, 'dev')).toBe('dev');
  });

  it('frontmatter env is trimmed when used', () => {
    expect(resolveEffectiveEnv(undefined, '  dev  ')).toBe('dev');
  });

  it('both undefined → undefined (caller falls back to the default segment)', () => {
    expect(resolveEffectiveEnv(undefined, undefined)).toBeUndefined();
  });

  it('a whitespace-only / empty frontmatter env collapses to undefined', () => {
    expect(resolveEffectiveEnv(undefined, '   ')).toBeUndefined();
    expect(resolveEffectiveEnv(undefined, '')).toBeUndefined();
  });

  it('runEnvName wins even when frontmatter env is empty/whitespace', () => {
    expect(resolveEffectiveEnv('prod', '')).toBe('prod');
    expect(resolveEffectiveEnv('prod', undefined)).toBe('prod');
  });

  it('undefined effectiveEnv maps to the NO_ENV_NAMESPACE segment downstream', () => {
    const eff = resolveEffectiveEnv(undefined, undefined);
    expect(envCacheSegment(eff)).toBe(NO_ENV_NAMESPACE);
  });
});

describe('resolveTestCacheBase — env-namespaced base dir (issue 012)', () => {
  it('appends exactly the env segment under the base cache dir', () => {
    expect(resolveTestCacheBase(CACHE_DIR, 'dev')).toBe(
      path.join(CACHE_DIR, 'dev'),
    );
  });

  it('no env → the `default` sentinel segment', () => {
    expect(resolveTestCacheBase(CACHE_DIR, undefined)).toBe(
      path.join(CACHE_DIR, NO_ENV_NAMESPACE),
    );
  });

  it('two distinct envs never share a base dir', () => {
    expect(resolveTestCacheBase(CACHE_DIR, 'dev')).not.toBe(
      resolveTestCacheBase(CACHE_DIR, 'staging'),
    );
  });

  it('the env segment is sanitised (collision-free)', () => {
    expect(resolveTestCacheBase(CACHE_DIR, '  Staging Env!  ')).toBe(
      path.join(CACHE_DIR, 'staging-env'),
    );
  });
});

describe('cacheDirForRun — full composed dir (issues 012/027/028, CRITICAL note #2)', () => {
  it('composes exactly <cache.dir>/<env-segment>/<basename>-<hash>/ (no double-nesting)', () => {
    const got = cacheDirForRun(CACHE_DIR, 'dev', TEST_FILE, ROOT);
    const expected = path.join(
      CACHE_DIR,
      envCacheSegment('dev'),
      cacheDirName(TEST_FILE, ROOT),
    );
    expect(got).toBe(expected);

    // Spell the layout out explicitly: base / env / <basename>-<hash>, exactly
    // three segments below the base — no extra sanitised-title level. The
    // dir name must be the path-hash form, never the (absent) title.
    const rel = path.relative(CACHE_DIR, got);
    const segments = rel.split(path.sep);
    expect(segments).toHaveLength(2); // <env-segment>/<basename>-<hash>
    expect(segments[0]).toBe('dev');
    expect(segments[1]).toMatch(/^checkout-[0-9a-f]{12}$/);
  });

  it('no env → the `default` segment, still no double-nesting', () => {
    const eff = resolveEffectiveEnv(undefined, undefined);
    const got = cacheDirForRun(CACHE_DIR, eff, TEST_FILE, ROOT);
    expect(got).toBe(
      path.join(CACHE_DIR, NO_ENV_NAMESPACE, cacheDirName(TEST_FILE, ROOT)),
    );
    expect(path.relative(CACHE_DIR, got).split(path.sep)).toHaveLength(2);
  });

  it('equals what runTest builds: path.join(resolveTestCacheBase, cacheDirName)', () => {
    // Mirrors test-runner.ts: baseDir = join(cache.dir, envCacheSegment(eff));
    // StepCache.initialize(baseDir, cacheDirName(...)) → join(baseDir, sanitize(cacheDirName)).
    // cacheDirName is idempotent under sanitizeTestName, so the two compose to
    // exactly this path.
    const eff = resolveEffectiveEnv('staging', 'dev');
    const got = cacheDirForRun(CACHE_DIR, eff, TEST_FILE, ROOT);
    const handBuilt = path.join(
      resolveTestCacheBase(CACHE_DIR, eff),
      cacheDirName(TEST_FILE, ROOT),
    );
    expect(got).toBe(handBuilt);
  });

  it('the run-wide env wins end-to-end: dir is keyed by CLI env, not frontmatter env', () => {
    const eff = resolveEffectiveEnv('staging', 'dev'); // CLI staging wins
    const got = cacheDirForRun(CACHE_DIR, eff, TEST_FILE, ROOT);
    expect(got).toBe(cacheDirForRun(CACHE_DIR, 'staging', TEST_FILE, ROOT));
    expect(got).not.toBe(cacheDirForRun(CACHE_DIR, 'dev', TEST_FILE, ROOT));
  });

  it('two files with the SAME basename but different paths get DIFFERENT dirs', () => {
    const a = cacheDirForRun(CACHE_DIR, 'dev', path.join('proj', 'auth', 'checkout.md'), ROOT);
    const b = cacheDirForRun(CACHE_DIR, 'dev', path.join('proj', 'admin', 'checkout.md'), ROOT);
    expect(a).not.toBe(b);
  });
});

describe('data-driven rows SHARE one cache dir (issues 027/028)', () => {
  // The on-disk cache dir depends only on (cache.dir, env, filePath, root) —
  // NOT on dataRowIndex. `cacheDirForRun` takes no row index at all, which is
  // itself the proof: every row of a data-driven test resolves to the SAME
  // directory, so cached AI turns are reused across rows (parameters are
  // reverse-interpolated, so the stored payload is row-agnostic).
  it('cacheDirForRun takes no dataRowIndex — every row resolves identically', () => {
    // Simulate "row 0" and "row 2" of one data-driven test: same file, env,
    // root, base. The dir must be byte-identical regardless of row.
    const row0 = cacheDirForRun(CACHE_DIR, 'dev', TEST_FILE, ROOT);
    const row2 = cacheDirForRun(CACHE_DIR, 'dev', TEST_FILE, ROOT);
    expect(row0).toBe(row2);
  });

  it('the signature has exactly four positional inputs, none a row index', () => {
    expect(cacheDirForRun).toHaveLength(4); // (cacheBaseDir, effectiveEnv, testFilePath, projectRoot)
  });
});
