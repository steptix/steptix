import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  StepCache,
  computeStepsHash,
  sanitizeTestName,
  frameScopedStepKey,
  reverseInterpolate,
  forwardInterpolate,
  envCacheSegment,
  cacheDirName,
  NO_ENV_NAMESPACE,
} from '../src/cache/step-cache.js';
import type { AIAction } from '../src/ai/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-cache-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Pure function tests ────────────────────────────────────────────────────

describe('computeStepsHash', () => {
  it('returns consistent hash for the same steps', () => {
    const steps = ['Navigate to login', 'Enter username'];
    expect(computeStepsHash(steps)).toBe(computeStepsHash(steps));
  });

  it('returns different hash when steps change', () => {
    const a = computeStepsHash(['Step 1', 'Step 2']);
    const b = computeStepsHash(['Step 1', 'Step 2 modified']);
    expect(a).not.toBe(b);
  });

  it('returns different hash when step order changes', () => {
    const a = computeStepsHash(['Step 1', 'Step 2']);
    const b = computeStepsHash(['Step 2', 'Step 1']);
    expect(a).not.toBe(b);
  });
});

describe('frameScopedStepKey (issue 016)', () => {
  it('returns the bare line for an inline (frameless) step', () => {
    expect(frameScopedStepKey('', 17)).toBe(17);
    expect(frameScopedStepKey(undefined, 12)).toBe(12);
  });

  it('qualifies a skill-body step with its frame', () => {
    expect(frameScopedStepKey('f1', 17)).toBe('f1-17');
  });

  it('distinguishes two invocations of one skill on the same source line', () => {
    expect(frameScopedStepKey('f1', 17)).not.toBe(frameScopedStepKey('f2', 17));
  });

  it('distinguishes a skill-body step from a test step on the same line', () => {
    expect(frameScopedStepKey('f1', 17)).not.toBe(frameScopedStepKey(undefined, 17));
  });
});

describe('sanitizeTestName', () => {
  it('lowercases and replaces special characters', () => {
    expect(sanitizeTestName('My Test Name!')).toBe('my-test-name');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeTestName('--test--')).toBe('test');
  });

  it('truncates long names', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeTestName(long).length).toBeLessThanOrEqual(100);
  });
});

describe('reverseInterpolate', () => {
  it('replaces parameter values with placeholders in value fields', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#email', value: 'alice@example.com', description: 'Type email' },
    ];
    const params = { email: 'alice@example.com' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]!.value).toBe('{{email}}');
  });

  it('does not replace in selector fields', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '[data-user="alice"]', value: 'alice', description: 'Click user' },
    ];
    const params = { user: 'alice' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]!.selector).toBe('[data-user="alice"]');
    expect(result[0]!.value).toBe('{{user}}');
  });

  it('handles multiple parameters with longest-first priority', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#field', value: 'test@example.com', description: 'Type' },
    ];
    const params = { email: 'test@example.com', name: 'test' };

    const result = reverseInterpolate(actions, params);
    // Should match 'test@example.com' as {{email}}, not 'test' as {{name}}
    expect(result[0]!.value).toBe('{{email}}');
  });

  it('returns actions unchanged when no params', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '#btn', description: 'Click' },
    ];
    const result = reverseInterpolate(actions, {});
    expect(result).toBe(actions); // same reference
  });

  it('skips actions without value field', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '#btn', description: 'Click button' },
    ];
    const params = { btn: '#btn' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]).toBe(actions[0]); // same reference — untouched
  });
});

describe('forwardInterpolate', () => {
  it('replaces placeholders with parameter values in value fields', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#email', value: '{{email}}', description: 'Type email' },
    ];
    const params = { email: 'bob@test.com' };

    const result = forwardInterpolate(actions, params);
    expect(result[0]!.value).toBe('bob@test.com');
  });

  it('leaves unresolved placeholders intact', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#field', value: '{{unknown}}', description: 'Type' },
    ];

    const result = forwardInterpolate(actions, {});
    expect(result[0]!.value).toBe('{{unknown}}');
  });

  it('does not replace in selector fields', () => {
    const actions: AIAction[] = [
      { action: 'click', selector: '{{email}}', value: '{{email}}', description: 'Click' },
    ];
    const params = { email: 'test@example.com' };

    const result = forwardInterpolate(actions, params);
    expect(result[0]!.selector).toBe('{{email}}');
    expect(result[0]!.value).toBe('test@example.com');
  });
});

// ── Integration tests (filesystem) ────────────────────────────────────────

describe('StepCache', () => {
  const testSteps = ['Navigate to login', 'Enter {{username}}', 'Click submit'];

  it('creates cache directory and meta.json on initialize', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    expect(cache).toBeDefined();

    const metaPath = path.join(tmpDir, 'my-test', 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    expect(meta.stepsHash).toBe(computeStepsHash(testSteps));
    expect(meta.schemaVersion).toBe(4);
  });

  it('returns null on cache miss', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    const result = await cache.read(1, {});
    expect(result).toBeNull();
  });

  it('roundtrips write then read', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[{"action":"click","selector":"#btn","description":"Click"}],"reasoning":"test"}';
    const parsed = {
      actions: [{ action: 'click' as const, selector: '#btn', description: 'Click' }],
      reasoning: 'test',
    };

    await cache.write(1, [{ rawResponse, ...parsed }], {});
    const result = await cache.read(1, {});

    expect(result).not.toBeNull();
    expect(result![0]!.actions).toEqual(parsed.actions);
    expect(result![0]!.reasoning).toBe('test');
  });

  it('handles parameter interpolation on write/read roundtrip', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[{"action":"type","selector":"#user","value":"alice","description":"Type username"}],"reasoning":"ok"}';
    const parsed = {
      actions: [{ action: 'type' as const, selector: '#user', value: 'alice', description: 'Type username' }],
      reasoning: 'ok',
    };

    // Write with alice's params
    await cache.write(1, [{ rawResponse, ...parsed }], { username: 'alice' });

    // Read with bob's params — should get bob's value
    const result = await cache.read(1, { username: 'bob' });
    expect(result).not.toBeNull();
    expect(result![0]!.actions[0]!.value).toBe('bob');
  });

  it('invalidates step cache', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[],"reasoning":"test"}';
    await cache.write(1, [{ rawResponse, actions: [], reasoning: 'test' }], {});

    // Verify it's there
    expect(await cache.read(1, {})).not.toBeNull();

    // Invalidate
    await cache.invalidateStep(1);
    expect(await cache.read(1, {})).toBeNull();
  });

  it('invalidates entire cache when steps change', async () => {
    // First run — write step 1
    const cache1 = await StepCache.initialize(tmpDir, 'My Test', testSteps);
    await cache1.write(1, [{ rawResponse: '{"actions":[],"reasoning":"v1"}', actions: [], reasoning: 'v1' }], {});
    expect(await cache1.read(1, {})).not.toBeNull();

    // Second run with different steps — cache should be cleared
    const newSteps = ['Navigate to login', 'Enter {{username}}', 'Click submit', 'Verify dashboard'];
    const cache2 = await StepCache.initialize(tmpDir, 'My Test', newSteps);
    expect(await cache2.read(1, {})).toBeNull();
  });

  it('preserves needs_reeval flag', async () => {
    const cache = await StepCache.initialize(tmpDir, 'My Test', testSteps);

    const rawResponse = '{"actions":[],"reasoning":"multi","needs_reeval":true}';
    await cache.write(1, [{ rawResponse, actions: [], reasoning: 'multi', needs_reeval: true }], {});

    const result = await cache.read(1, {});
    expect(result![0]!.needs_reeval).toBe(true);
  });
});

// ── Frame-scoped keys: skill collision prevention (issue 016) ─────────────

describe('StepCache frame-scoped keys (issue 016)', () => {
  const steps = ['a', 'b', 'c'];

  it('keeps two invocations of one skill (same source line) in separate files', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Skill Test', steps);
    // Both invocations expand to skill line 17 but get distinct frames (f1/f2).
    await cache.write(
      'f1-17',
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'cats', description: 'type cats' }], reasoning: 'cats' }],
      {},
    );
    await cache.write(
      'f2-17',
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'dogs', description: 'type dogs' }], reasoning: 'dogs' }],
      {},
    );

    // Second invocation must NOT replay the first's actions (the old collision).
    expect((await cache.read('f1-17', {}))![0]!.actions[0]!.value).toBe('cats');
    expect((await cache.read('f2-17', {}))![0]!.actions[0]!.value).toBe('dogs');
  });

  it('keeps a skill-body step and a test step on the same line independent', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Mixed Test', steps);
    await cache.write(17, [{ rawResponse: '{}', actions: [], reasoning: 'test-step' }], {});
    await cache.write('f1-17', [{ rawResponse: '{}', actions: [], reasoning: 'skill-step' }], {});

    expect((await cache.read(17, {}))![0]!.reasoning).toBe('test-step');
    expect((await cache.read('f1-17', {}))![0]!.reasoning).toBe('skill-step');
  });

  it('writes one file per frame-scoped key', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Files Test', steps);
    await cache.write('f1-17', [{ rawResponse: '{}', actions: [], reasoning: 'x' }], {});
    await cache.write('f2-17', [{ rawResponse: '{}', actions: [], reasoning: 'y' }], {});

    const dir = path.join(tmpDir, 'files-test');
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('step-')).sort();
    expect(files).toEqual(['step-f1-17.json', 'step-f2-17.json']);
  });

  it('scopes assertion code by frame too', async () => {
    const cache = await StepCache.initialize(tmpDir, 'Assert Test', steps);
    const fp = 'fingerprint-1';
    await cache.writeAssertion('f1-17', 0, fp, 'return { pass: true, actual: "x" };', {});

    expect(await cache.readAssertion('f1-17', 0, fp, {})).toContain('pass: true');
    // A different invocation's frame must not see it.
    expect(await cache.readAssertion('f2-17', 0, fp, {})).toBeNull();
  });
});

// ── issue 018: cache invalidation must track the RESOLVED hash source ──────
//
// The user report: "stop a test, edit a data .json file, save, re-run — the
// change isn't picked up." Root cause: session-manager fed the cache the RAW
// step text (${data.*} / ${source.*} placeholders intact), so a data-VALUE
// edit left the steps-hash — and every positional per-step key — unchanged,
// and a cache HIT replayed the frozen action with the stale value.
//
// StepCache itself is a dumb string-hasher: given identical step strings it
// (correctly) keeps the cache; given different ones it clears. So the FIX
// lives one layer up — session-manager now interpolates env/data into the
// hash source before StepCache.initialize (session-manager.ts ~1355). These
// seam tests pin the StepCache contract the fix relies on; the end-to-end
// guard that session-manager actually interpolates lives in
// session-manager.test.ts ("issue 018").
//
// Models the user's named-dataSource fixture (search-engine.json →
// ${search-engine.query}); the built-in ${data.url} namespace is identical.
describe('cache invalidation tracks the resolved hash source (issue 018)', () => {
  const STEP_KEY = frameScopedStepKey(undefined, 12); // inline step, source line 12

  it('clears the stale entry when the RESOLVED step text changed (the fix lever)', async () => {
    // The pre-fix hash source was the raw placeholder `Search for
    // ${search-engine.query}` — byte-identical no matter what value sits behind
    // it, so the hash could never tell one data value from another (the bug).
    // session-manager now feeds the env/data-INTERPOLATED steps, so a data-value
    // edit changes the resolved text, the hash flips, and initialize() wipes the
    // prior entry — no stale replay.

    // ── Run 1: search-engine.json query = "laptops" → resolved step text. ──
    const run1 = await StepCache.initialize(tmpDir, 'data demo', ['Search for laptops']);
    await run1.write(
      STEP_KEY,
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'laptops', description: 'Search' }], reasoning: 'r' }],
      {},
    );
    expect(await run1.read(STEP_KEY, {})).not.toBeNull(); // cached

    // ── User edits the data file: query → "phones", re-runs. session-manager
    // re-inits with the new resolved text → different hash → cache cleared. ──
    const run2 = await StepCache.initialize(tmpDir, 'data demo', ['Search for phones']);
    expect(await run2.read(STEP_KEY, {})).toBeNull(); // stale entry gone → AI re-runs with "phones"
  });

  it('contrast: a {{parameter}} edit rides the cache (params stay placeholders in the hash)', async () => {
    // interpolateEnvData leaves {{params}} intact, so the hash source is
    // identical across param values → cache survives → read-time interpolation
    // fills the new value. Params ride the cache; data busts it.
    const paramSteps = ['Search for {{query}}']; // unchanged across runs (param not resolved into the hash)
    const run1 = await StepCache.initialize(tmpDir, 'param demo', paramSteps);
    await run1.write(
      STEP_KEY,
      [{ rawResponse: '{}', actions: [{ action: 'type', selector: '#q', value: 'laptops', description: 'Search' }], reasoning: 'r' }],
      { query: 'laptops' }, // stored as {{query}}
    );

    const run2 = await StepCache.initialize(tmpDir, 'param demo', paramSteps);
    const hit = await run2.read(STEP_KEY, { query: 'phones' }); // cache survives; new param value
    expect(hit![0]!.actions[0]!.value).toBe('phones');
  });
});

// ── issue 012: env-namespaced cache (entries are never read across envs) ───
//
// Before the fix the step cache lived at `<cache.dir>/<dir>/` with no env
// component, so a `dev` run and a `staging` run of the same file shared one
// cache directory — `staging` could replay actions the AI generated against
// `dev`'s environment. The fix interposes an env segment:
// `<cache.dir>/<env-segment>/<dir>/`. A run with no resolved env falls back to
// the `default` sentinel, which must be STABLE (not oscillate run-to-run) and
// must collide with a literal `env: default`.
//
// These tests exercise both the pure `envCacheSegment` helper and the real
// on-disk behaviour: the caller is responsible for joining the env segment
// onto the base cache dir BEFORE handing it to `StepCache.initialize`, so the
// integration tests model exactly that — base = `<tmp>/<env-segment>`.
describe('envCacheSegment / env namespacing (issue 012)', () => {
  const steps = ['Navigate to login', 'Enter username', 'Click submit'];
  const STEP_KEY = frameScopedStepKey(undefined, 12);

  it('trims, lowercases/sanitises, and maps null/undefined/empty to the sentinel', () => {
    expect(envCacheSegment('  Staging Env!  ')).toBe('staging-env'); // trim + sanitise
    expect(envCacheSegment('DEV')).toBe('dev'); // lowercased
    expect(envCacheSegment(undefined)).toBe(NO_ENV_NAMESPACE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(envCacheSegment(null as any)).toBe(NO_ENV_NAMESPACE);
    expect(envCacheSegment('')).toBe(NO_ENV_NAMESPACE);
    expect(envCacheSegment('   ')).toBe(NO_ENV_NAMESPACE); // whitespace-only trims to sentinel
  });

  it('resolves a no-env run and an explicit env="default" to the SAME segment', () => {
    // The sentinel is the literal string `default`, so a test with frontmatter
    // `env: default` and a no-env run intentionally share one cache namespace.
    expect(envCacheSegment(undefined)).toBe(envCacheSegment('default'));
    expect(NO_ENV_NAMESPACE).toBe('default');
  });

  it('does NOT read an entry written under env=dev when reading under env=staging (MISS)', async () => {
    // The caller joins the env segment onto the base cache dir. Model that:
    // dev writes under <tmp>/dev, staging reads under <tmp>/staging.
    const devBase = path.join(tmpDir, envCacheSegment('dev'));
    const stagingBase = path.join(tmpDir, envCacheSegment('staging'));

    const dev = await StepCache.initialize(devBase, 'My Test', steps);
    await dev.write(
      STEP_KEY,
      [{ rawResponse: '{}', actions: [{ action: 'click', selector: '#dev', description: 'dev' }], reasoning: 'dev' }],
      {},
    );
    expect(await dev.read(STEP_KEY, {})).not.toBeNull(); // HIT in dev's namespace

    const staging = await StepCache.initialize(stagingBase, 'My Test', steps);
    expect(await staging.read(STEP_KEY, {})).toBeNull(); // MISS — different env segment
  });

  it('no-env populate then no-env read → HIT (sentinel is stable, not oscillating)', async () => {
    const base1 = path.join(tmpDir, envCacheSegment(undefined));
    const run1 = await StepCache.initialize(base1, 'My Test', steps);
    await run1.write(
      STEP_KEY,
      [{ rawResponse: '{}', actions: [{ action: 'click', selector: '#x', description: 'x' }], reasoning: 'x' }],
      {},
    );

    // A SECOND no-env run resolves to the identical sentinel segment, so it
    // sees the prior entry. If the sentinel oscillated this would MISS.
    const base2 = path.join(tmpDir, envCacheSegment(''));
    const run2 = await StepCache.initialize(base2, 'My Test', steps);
    expect(base2).toBe(base1); // proves the segment is stable
    expect(await run2.read(STEP_KEY, {})).not.toBeNull(); // HIT
  });

  it('steps-hash stays the inner lever: editing a step under dev invalidates only dev, leaves staging intact', async () => {
    const devBase = path.join(tmpDir, envCacheSegment('dev'));
    const stagingBase = path.join(tmpDir, envCacheSegment('staging'));

    // Populate BOTH envs with the original steps.
    const dev1 = await StepCache.initialize(devBase, 'My Test', steps);
    await dev1.write(STEP_KEY, [{ rawResponse: '{}', actions: [], reasoning: 'dev-v1' }], {});

    const staging1 = await StepCache.initialize(stagingBase, 'My Test', steps);
    await staging1.write(STEP_KEY, [{ rawResponse: '{}', actions: [], reasoning: 'staging-v1' }], {});

    expect(await dev1.read(STEP_KEY, {})).not.toBeNull();
    expect(await staging1.read(STEP_KEY, {})).not.toBeNull();

    // Edit a step under dev only (different steps array → different stepsHash):
    // initialize wipes dev's namespace; staging's namespace is untouched.
    const editedSteps = [...steps, 'Verify dashboard'];
    const dev2 = await StepCache.initialize(devBase, 'My Test', editedSteps);
    expect(await dev2.read(STEP_KEY, {})).toBeNull(); // dev invalidated

    const staging2 = await StepCache.initialize(stagingBase, 'My Test', steps);
    expect(await staging2.read(STEP_KEY, {})).not.toBeNull(); // staging survives
  });

  it('a 100+char test file PATH does not truncate the env segment away', async () => {
    // The env is a SEPARATE path component, so even a pathological test dir
    // name (which `sanitizeTestName` caps at 100 chars) cannot eat the env
    // segment — they live in distinct directory levels.
    const longName = 'x'.repeat(250);
    const devBase = path.join(tmpDir, envCacheSegment('dev'));
    const cache = await StepCache.initialize(devBase, longName, steps);
    await cache.write(STEP_KEY, [{ rawResponse: '{}', actions: [], reasoning: 'r' }], {});

    // The env dir survives as its own component under tmpDir, regardless of the
    // 100-char-truncated test subdir beneath it.
    const envDirContents = await fs.readdir(devBase);
    expect(envDirContents.length).toBeGreaterThan(0); // the test subdir exists under dev/
    expect((await fs.readdir(tmpDir))).toContain('dev'); // dev/ is intact at the top level
    // And reading back in the same env still HITs (the long path didn't corrupt anything).
    expect(await cache.read(STEP_KEY, {})).not.toBeNull();
  });
});

// ── issues 027 + 028: path-derived cache dir name (kills title collisions) ──
//
// Before the fix the cache dir was `sanitizeTestName(test.title)`, so two
// distinct files sharing a `# Title` collided into one cache directory, and
// the server additionally truncated titles to 100 chars (027), conflating
// even more files. `cacheDirName` keys the directory off the test file's PATH
// instead: a readable basename prefix plus a 12-hex-char hash of the
// project-root-RELATIVE normalized path. Same title, different path → different
// dir. It's also idempotent under `sanitizeTestName`, so it can be passed
// straight to `StepCache.initialize` as the `testName` without adding a level.
describe('cacheDirName (issues 027 + 028)', () => {
  const root = path.join(path.sep, 'project', 'root');

  it('two files with the SAME title but different paths → DIFFERENT cacheDirName', () => {
    // cacheDirName never sees the title at all — only the path — so identical
    // `# Title`s in `auth/checkout.md` vs `admin/checkout.md` cannot collide.
    const a = cacheDirName(path.join(root, 'auth', 'checkout.md'), root);
    const b = cacheDirName(path.join(root, 'admin', 'checkout.md'), root);
    expect(a).not.toBe(b);
  });

  it('two files with the same BASENAME in different dirs → DIFFERENT dir (hash distinguishes)', () => {
    const a = cacheDirName(path.join(root, 'auth', 'login.md'), root);
    const b = cacheDirName(path.join(root, 'admin', 'login.md'), root);
    // Same readable basename prefix, but the path hash diverges.
    expect(a.startsWith('login-')).toBe(true);
    expect(b.startsWith('login-')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('is stable across calls for an unchanged (filePath, projectRoot) — deterministic', () => {
    const file = path.join(root, 'tests', 'smoke.md');
    expect(cacheDirName(file, root)).toBe(cacheDirName(file, root));
  });

  it('keys off the project-root-RELATIVE path: same relative path at two roots → SAME name', () => {
    // Two worktree-like absolute prefixes with matching relative layouts must
    // produce the same cache dir, so a clone/worktree reuses the cache.
    const rootA = path.join(path.sep, 'work', 'a');
    const rootB = path.join(path.sep, 'somewhere', 'else', 'b');
    const a = cacheDirName(path.join(rootA, 'tests', 'login.md'), rootA);
    const b = cacheDirName(path.join(rootB, 'tests', 'login.md'), rootB);
    expect(a).toBe(b);
  });

  it('back/forward-slash differences in the input do not change the hash', () => {
    // `normalizeForCache` collapses every non-alphanumeric run (including both
    // slash flavours) to `-`, so a Windows-style and POSIX-style spelling of
    // the same relative path hash identically.
    const back = cacheDirName('C:\\proj\\tests\\login.md', 'C:\\proj');
    const fwd = cacheDirName('C:/proj/tests/login.md', 'C:/proj');
    expect(back).toBe(fwd);
  });

  it('projectRoot = null does not throw and yields a stable name (absolute-path fallback)', () => {
    const file = path.join(root, 'tests', 'login.md');
    let name!: string;
    expect(() => {
      name = cacheDirName(file, null);
    }).not.toThrow();
    expect(name).toBe(cacheDirName(file, null)); // stable
    expect(name.startsWith('login-')).toBe(true);
    // The absolute-path fallback differs from the relative keying.
    expect(name).not.toBe(cacheDirName(file, root));
  });

  it('output is idempotent under sanitizeTestName (no extra dir level via initialize)', () => {
    // initialize() internally does sanitizeTestName(testName). cacheDirName's
    // output is already lowercase/[a-z0-9-]/no-edge-hyphens and well under 100
    // chars, so sanitising it again is a no-op — the on-disk dir is exactly
    // <base>/<cacheDirName>/, not <base>/<cacheDirName>/<sanitised-again>/.
    const name = cacheDirName(path.join(root, 'tests', 'My Big Test.md'), root);
    expect(sanitizeTestName(name)).toBe(name);
  });

  it('end-to-end: passing cacheDirName as initialize testName lands at exactly base/<cacheDirName>', async () => {
    // The authoritative call shape (028 line 150): base = env-namespaced
    // cache.dir, testName = cacheDirName(...). No double nesting.
    const dirName = cacheDirName(path.join(root, 'tests', 'My Big Test.md'), root);
    const cache = await StepCache.initialize(tmpDir, dirName, steps0);
    await cache.write(0, [{ rawResponse: '{}', actions: [], reasoning: 'r' }], {});

    // meta.json sits directly under <tmp>/<cacheDirName>/ — one level, not two.
    const metaPath = path.join(tmpDir, dirName, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    expect(meta.schemaVersion).toBe(4);
    // The cacheDirName dir is a DIRECT child of tmpDir (no nested sanitised dir).
    const children = await fs.readdir(path.join(tmpDir, dirName), { withFileTypes: true });
    expect(children.some((d) => d.isDirectory())).toBe(false);
  });
});

const steps0 = ['Navigate to login', 'Enter username', 'Click submit'];

describe('interpolation of upload paths (stories/upload-action.md §6)', () => {
  // The load-bearing case. The step is interpolated BEFORE the model sees it,
  // so a parameter written with backslashes reaches the model as text and
  // comes back normalised. Searching only for the raw spelling would miss it,
  // freeze the file name into the cache, and break replay on the next machine.
  it('reverses a path parameter written with backslashes', () => {
    const actions: AIAction[] = [
      { action: 'upload', selector: '#f', filePath: 'attachments/statement.pdf', description: 'd' },
    ];
    const params = { statement: '\\attachments\\statement.pdf' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]!.filePath).toBe('{{statement}}');
  });

  it('reverses each entry of filePaths', () => {
    const actions: AIAction[] = [
      { action: 'upload', selector: '#f', filePaths: ['attachments/a.png', 'attachments/b.png'], description: 'd' },
    ];
    const params = { first: 'attachments/a.png', second: '\\attachments\\b.png' };

    const result = reverseInterpolate(actions, params);
    expect(result[0]!.filePaths).toEqual(['{{first}}', '{{second}}']);
  });

  it('leaves a path with no parameter in it alone', () => {
    const actions: AIAction[] = [
      { action: 'upload', selector: '#f', filePath: 'attachments/logo.png', description: 'd' },
    ];
    const result = reverseInterpolate(actions, { other: 'nothing-to-see' });
    expect(result[0]!.filePath).toBe('attachments/logo.png');
  });

  // Longest-first has to span BOTH spellings of every parameter: a short
  // normalised form applied early can otherwise replace inside another
  // parameter's longer raw value.
  it('prefers the longest match across raw and normalised spellings', () => {
    const actions: AIAction[] = [
      { action: 'upload', selector: '#f', filePath: 'attachments/march-statement.pdf', description: 'd' },
    ];
    const params = {
      full: '\\attachments\\march-statement.pdf',
      partial: 'attachments/march',
    };
    const result = reverseInterpolate(actions, params);
    expect(result[0]!.filePath).toBe('{{full}}');
  });

  it('restores the parameter\'s raw spelling on the way back out', () => {
    const actions: AIAction[] = [
      { action: 'upload', selector: '#f', filePath: '{{statement}}', description: 'd' },
    ];
    const params = { statement: '\\attachments\\statement.pdf' };

    const result = forwardInterpolate(actions, params);
    // Raw, not normalised: the executor and step.filePath normalise at the
    // point of use, so both spellings resolve to the same file.
    expect(result[0]!.filePath).toBe('\\attachments\\statement.pdf');
  });

  it('round-trips a path parameter', () => {
    const params = { statement: '\\attachments\\statement.pdf' };
    const original: AIAction[] = [
      { action: 'upload', selector: '#f', filePath: 'attachments/statement.pdf', description: 'd' },
    ];
    const cached = reverseInterpolate(original, params);
    expect(JSON.stringify(cached)).not.toContain('statement.pdf');
    const replayed = forwardInterpolate(cached, params);
    expect(replayed[0]!.filePath).toBe(params.statement);
  });
});

describe('path normalisation must not reach `value` fields', () => {
  // The regression this guards: widening every parameter to its normalised
  // spelling and applying that to `value` too. A leading-slash parameter is
  // ordinary — `path: /reports` — and its normalised form is the bare token
  // `reports`, so a `type` action that legitimately types `reports` was being
  // rewritten to {{path}} and replayed as `/reports`: the wrong text, silently.
  it('does not rewrite a value that merely matches a parameter\'s normalised form', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#q', value: 'reports', description: 'Type reports' },
    ];
    const params = { path: '/reports' };

    const reversed = reverseInterpolate(actions, params);
    expect(reversed[0]!.value).toBe('reports');
    expect(forwardInterpolate(reversed, params)[0]!.value).toBe('reports');
  });

  it('still rewrites a value that matches the parameter exactly', () => {
    const actions: AIAction[] = [
      { action: 'type', selector: '#q', value: '/reports', description: 'Type the path' },
    ];
    const params = { path: '/reports' };
    expect(reverseInterpolate(actions, params)[0]!.value).toBe('{{path}}');
  });

  // The path field, on the same action set, DOES get the normalised spelling.
  it('applies the normalised spelling to path fields only', () => {
    const actions: AIAction[] = [
      { action: 'upload', selector: '#f', filePath: 'attachments/x.png', value: 'attachments/x.png', description: 'd' },
    ];
    const params = { doc: '\\attachments\\x.png' };

    const reversed = reverseInterpolate(actions, params)[0]!;
    expect(reversed.filePath).toBe('{{doc}}');
    // `value` sees the raw spelling only, and the raw spelling is not in it.
    expect(reversed.value).toBe('attachments/x.png');
  });
});
