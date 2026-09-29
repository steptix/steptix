/**
 * Integration tests for the per-test `dataSources` feature.
 *
 * Exercises the full pipeline end-to-end: a test file declares one or more
 * named JSON sources in its frontmatter, parseTestFile resolves the paths
 * relative to the test, loads each file, and the interpolator routes
 * `${<name>.X.Y}` placeholders to the right tree.
 *
 * The contract this guards:
 *  - Tests without `dataSources` parse exactly as before (backward compat).
 *  - Relative source paths resolve against the test file's directory, not cwd.
 *  - Absolute and `~` paths are honoured.
 *  - `$VAR` resolution runs on every namespace, so secrets from `.env.<name>`
 *    are usable from any source file.
 *  - Missing source file → hard error naming the resolved path.
 *  - Unknown namespaces in placeholders pass through unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { resolveEnvBundle } from '../src/env/resolve-bundle.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { interpolateEnvData } from '../src/parser/interpolate-env-data.js';
import type { ParsedTest } from '../src/parser/types.js';

/** One step as the RUNNER sees it. The parse validates references and keeps
 *  the tokens (stories/placeholder-preserving-actions.md §Environment and
 *  data-file references); substitution moved to the run, per step. */
function resolveStep(parsed: ParsedTest, index: number): string {
  return interpolateEnvData(parsed.steps[index]!, parsed.envData!);
}

let tmpRoot: string;
let homeDir: string;
const originalEnv = { ...process.env };

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'steptix-datasources-'));
  homeDir = mkdtempSync(path.join(tmpdir(), 'steptix-home-'));
  // Pretend home is the temp home dir so `~/...` paths land somewhere we
  // control. os.homedir() reads $HOME on POSIX and USERPROFILE on Windows.
  process.env['HOME'] = homeDir;
  process.env['USERPROFILE'] = homeDir;

  // Project layout
  mkdirSync(path.join(tmpRoot, 'fixtures', 'data'), { recursive: true });
  mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
  mkdirSync(path.join(tmpRoot, 'shared'), { recursive: true });
  mkdirSync(path.join(homeDir, 'shared'), { recursive: true });

  // .env.staging — populates process.env for $VAR resolution
  writeFileSync(
    path.join(tmpRoot, '.env.staging'),
    'BASE_URL=https://staging.example.com\nADMIN_PWD=stg-admin\nVIP_PWD=stg-vip\n',
  );

  // env-default data file
  writeFileSync(
    path.join(tmpRoot, 'fixtures', 'data', 'staging.json'),
    JSON.stringify({
      users: { admin: { email: 'admin@stg.example.com', password: '$ADMIN_PWD' } },
      fixtures: { currency: 'USD' },
    }),
  );

  // VIP catalogue — referenced by absolute path
  writeFileSync(
    path.join(tmpRoot, 'shared', 'vip-users.json'),
    JSON.stringify({
      users: { platinum: { email: 'vip@example.com', password: '$VIP_PWD' } },
    }),
  );

  // Per-test override sitting next to the test
  writeFileSync(
    path.join(tmpRoot, 'tests', 'overrides.json'),
    JSON.stringify({
      fixtures: { minOrderTotal: 50000, expectedTier: 'Platinum' },
    }),
  );

  // A second copy under homeDir to exercise `~/...` resolution
  writeFileSync(
    path.join(homeDir, 'shared', 'home-vip.json'),
    JSON.stringify({ users: { home: { email: 'home@example.com' } } }),
  );
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

describe('dataSources — full parse pipeline', () => {
  it('resolves placeholders across env, data, and two extra namespaces', async () => {
    const testFile = path.join(tmpRoot, 'tests', 'multi.md');
    writeFileSync(
      testFile,
      `---
env: staging
dataSources:
  vip: ${path.join(tmpRoot, 'shared', 'vip-users.json')}
  local: ./overrides.json
---

# Multi-source test

## Config
- baseUrl: \${env.BASE_URL}

## Steps
1. Visit \${env.BASE_URL}/admin
2. Login as \${data.users.admin.email} / \${data.users.admin.password}
3. Switch to VIP \${vip.users.platinum.email} / \${vip.users.platinum.password}
4. Place order \${local.fixtures.minOrderTotal} \${data.fixtures.currency}
5. Assert tier "\${local.fixtures.expectedTier}"
`,
    );

    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    const parsed = await parseTestFile(testFile, {
      envData: { env: bundle.env, data: bundle.data },
    });

    expect(parsed.config.baseUrl).toBe('https://staging.example.com');
    expect(resolveStep(parsed, 0)).toBe('Visit https://staging.example.com/admin');
    expect(resolveStep(parsed, 1)).toBe('Login as admin@stg.example.com / stg-admin');
    // $VIP_PWD comes from .env.staging — proves $VAR resolution runs on extra namespaces.
    expect(resolveStep(parsed, 2)).toBe('Switch to VIP vip@example.com / stg-vip');
    expect(resolveStep(parsed, 3)).toBe('Place order 50000 USD');
    expect(resolveStep(parsed, 4)).toBe('Assert tier "Platinum"');
  });

  it('resolves a relative dataSources path against the test file directory, not cwd', async () => {
    // The test imports a file that's a sibling of the .md.  cwd is the
    // project root (tmpRoot), so a `./overrides.json` path that resolved
    // against cwd would miss — proving relative resolution targets the .md.
    const testFile = path.join(tmpRoot, 'tests', 'relative.md');
    writeFileSync(
      testFile,
      `---
env: staging
dataSources:
  local: ./overrides.json
---

# Relative path

## Steps
1. Total \${local.fixtures.minOrderTotal}
`,
    );

    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    const parsed = await parseTestFile(testFile, {
      envData: { env: bundle.env, data: bundle.data },
    });

    expect(resolveStep(parsed, 0)).toBe('Total 50000');
  });

  it('expands `~/...` paths against the user home directory', async () => {
    const testFile = path.join(tmpRoot, 'tests', 'home.md');
    writeFileSync(
      testFile,
      `---
env: staging
dataSources:
  home: ~/shared/home-vip.json
---

# Home path

## Steps
1. Hello \${home.users.home.email}
`,
    );

    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    const parsed = await parseTestFile(testFile, {
      envData: { env: bundle.env, data: bundle.data },
    });

    expect(os.homedir()).toBe(homeDir);
    expect(resolveStep(parsed, 0)).toBe('Hello home@example.com');
  });

  it('throws a clear error when a dataSources file is missing', async () => {
    const testFile = path.join(tmpRoot, 'tests', 'missing.md');
    writeFileSync(
      testFile,
      `---
env: staging
dataSources:
  ghost: ./does-not-exist.json
---

# Missing source

## Steps
1. \${ghost.x}
`,
    );

    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    await expect(
      parseTestFile(testFile, { envData: { env: bundle.env, data: bundle.data } }),
    ).rejects.toThrow(/Data source file not found.*does-not-exist\.json/);
  });

  it('throws when a dataSources file is a JSON array (must be an object)', async () => {
    const arrayFile = path.join(tmpRoot, 'tests', 'arr.json');
    writeFileSync(arrayFile, JSON.stringify(['a', 'b']));
    const testFile = path.join(tmpRoot, 'tests', 'array-source.md');
    writeFileSync(
      testFile,
      `---
env: staging
dataSources:
  bad: ./arr.json
---

# Bad shape

## Steps
1. \${bad.0}
`,
    );

    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    await expect(
      parseTestFile(testFile, { envData: { env: bundle.env, data: bundle.data } }),
    ).rejects.toThrow(/JSON object at the top level/);
  });

  it('passes through unknown namespaces literally (backwards compatible)', async () => {
    // No `dataSources` declared — `${vip.X}` must survive untouched, since
    // pre-existing tests might contain such strings for reasons unrelated to
    // the new feature.
    const testFile = path.join(tmpRoot, 'tests', 'no-sources.md');
    writeFileSync(
      testFile,
      `---
env: staging
---

# Backwards compat

## Steps
1. Visit \${env.BASE_URL} and ignore \${vip.users.x.y}
`,
    );

    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    const parsed = await parseTestFile(testFile, {
      envData: { env: bundle.env, data: bundle.data },
    });

    expect(resolveStep(parsed, 0)).toBe(
      'Visit https://staging.example.com and ignore ${vip.users.x.y}',
    );
  });

  it('throws a clear error when a known extra namespace path is unknown', async () => {
    const testFile = path.join(tmpRoot, 'tests', 'unknown-path.md');
    writeFileSync(
      testFile,
      `---
env: staging
dataSources:
  local: ./overrides.json
---

# Typo in path

## Steps
1. Tier "\${local.fixtures.expectedTeir}"
`,
    );

    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    await expect(
      parseTestFile(testFile, { envData: { env: bundle.env, data: bundle.data } }),
    ).rejects.toThrow(/Unknown data path in 'local'.*expectedTeir/);
  });
});
