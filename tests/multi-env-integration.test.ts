/**
 * Integration tests for the multi-environment + JSON-data feature.
 *
 * These exercise the whole parse pipeline end-to-end: a single test file is
 * parsed twice with two different env bundles, and we verify every
 * `${env.X}` / `${data.X.Y}` placeholder resolves to env-specific values.
 * They simulate exactly what the CLI does in
 * src/cli/commands/run.ts when `--env <name>` is supplied.
 *
 * No browser is launched — we stop short of `runTest` because actually
 * executing AI-driven steps would need network access. The integration
 * boundary covered here is: file system → resolver → parser → resolved
 * test.steps. That's the plumbing the user ultimately sees.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveEnvBundle } from '../src/env/resolve-bundle.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { interpolateEnvData } from '../src/parser/interpolate-env-data.js';
import type { ParsedTest } from '../src/parser/types.js';

/** One step as the RUNNER sees it. The parse validates references and keeps
 *  the tokens; substitution moved to the run, per step, so a test that wants
 *  the resolved text has to do what the run does. */
function resolveStep(parsed: ParsedTest, index: number): string {
  return interpolateEnvData(parsed.steps[index]!, parsed.envData!);
}

let tmpRoot: string;
let testFile: string;
const originalEnv = { ...process.env };

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'aiui-multienv-'));
  mkdirSync(path.join(tmpRoot, 'fixtures', 'data'), { recursive: true });

  // Two env files
  writeFileSync(
    path.join(tmpRoot, '.env.uat'),
    'BASE_URL=https://uat.example.com\nADMIN_PWD=uat-secret\n',
  );
  writeFileSync(
    path.join(tmpRoot, '.env.staging'),
    'BASE_URL=https://staging.example.com\nADMIN_PWD=stg-secret\n',
  );

  // Two data files
  writeFileSync(
    path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
    JSON.stringify({
      users: { admin: { email: 'admin@uat.example.com', password: '$ADMIN_PWD' } },
      fixtures: { delegateId: 'DEL-1234', threshold: 5000, currency: 'AUD' },
    }),
  );
  writeFileSync(
    path.join(tmpRoot, 'fixtures', 'data', 'staging.json'),
    JSON.stringify({
      users: { admin: { email: 'admin@stg.example.com', password: '$ADMIN_PWD' } },
      fixtures: { delegateId: 'DEL-9999', threshold: 250, currency: 'AUD' },
    }),
  );

  // The single test the author writes
  testFile = path.join(tmpRoot, 'delegate-approval.md');
  writeFileSync(
    testFile,
    `---
tags: [smoke, delegates]
---

# Delegate approval flow

## Config
- baseUrl: \${env.BASE_URL}

## Parameters
- baseUrl: \${env.BASE_URL}

## Steps
1. Navigate to \${env.BASE_URL}/admin
2. Login as \${data.users.admin.email} with password \${data.users.admin.password}
3. Find delegate \${data.fixtures.delegateId}
4. Approve \${data.fixtures.threshold} \${data.fixtures.currency}
5. Assert toast says "Approved"

## Hooks
- before: Visit \${env.BASE_URL}/health to warm the connection
- after: Logout from \${env.BASE_URL}/logout
`,
  );
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Restore process.env defensively (these tests use the pure resolver path,
  // which does not mutate process.env, but keep the guard for isolation).
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

describe('multi-env integration: same test, two envs', () => {
  it('parses with the uat bundle → uat-specific values everywhere', async () => {
    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    const parsed = await parseTestFile(testFile, {
      envData: { env: bundle.env, data: bundle.data },
    });

    expect(parsed.config.baseUrl).toBe('https://uat.example.com');
    expect(parsed.parameters['baseUrl']).toBe('https://uat.example.com');

    // Steps KEEP their tokens: the model is shown the step as written, beside
    // a block saying what each reference holds, and the runner substitutes per
    // step (stories/placeholder-preserving-actions.md §Environment and
    // data-file references). Resolution is still proved here — by running the
    // pass the runner runs, against the context the parse kept.
    expect(parsed.steps[0]).toBe('Navigate to ${env.BASE_URL}/admin');
    expect(resolveStep(parsed, 0)).toBe('Navigate to https://uat.example.com/admin');
    expect(resolveStep(parsed, 1)).toBe(
      'Login as admin@uat.example.com with password uat-secret',
    );
    expect(resolveStep(parsed, 2)).toBe('Find delegate DEL-1234');
    expect(resolveStep(parsed, 3)).toBe('Approve 5000 AUD');
    expect(resolveStep(parsed, 4)).toBe('Assert toast says "Approved"');

    expect(parsed.hooks.before).toEqual([
      'Visit https://uat.example.com/health to warm the connection',
    ]);
    expect(parsed.hooks.after).toEqual([
      'Logout from https://uat.example.com/logout',
    ]);
  });

  it('parses with the staging bundle → staging-specific values everywhere', async () => {
    const bundle = await resolveEnvBundle({ envName: 'staging', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    const parsed = await parseTestFile(testFile, {
      envData: { env: bundle.env, data: bundle.data },
    });

    expect(parsed.config.baseUrl).toBe('https://staging.example.com');
    expect(parsed.steps[0]).toBe('Navigate to ${env.BASE_URL}/admin');
    expect(resolveStep(parsed, 0)).toBe('Navigate to https://staging.example.com/admin');
    expect(resolveStep(parsed, 1)).toBe(
      'Login as admin@stg.example.com with password stg-secret',
    );
    expect(resolveStep(parsed, 2)).toBe('Find delegate DEL-9999');
    expect(resolveStep(parsed, 3)).toBe('Approve 250 AUD');

    expect(parsed.hooks.before).toEqual([
      'Visit https://staging.example.com/health to warm the connection',
    ]);
  });

  it('parsing without an envData context leaves placeholders intact', async () => {
    // Mirrors what happens when the CLI is invoked without --env.
    const parsed = await parseTestFile(testFile);
    expect(parsed.steps[0]).toBe('Navigate to ${env.BASE_URL}/admin');
    expect(parsed.steps[1]).toBe(
      'Login as ${data.users.admin.email} with password ${data.users.admin.password}',
    );
  });

  it('parsing with envData throws on an unknown reference, naming the file', async () => {
    const badFile = path.join(tmpRoot, 'broken.md');
    writeFileSync(
      badFile,
      `# bad
## Steps
1. Click \${data.users.admin.emial}
`,
    );
    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot, dataDir: 'fixtures/data' });
    await expect(
      parseTestFile(badFile, { envData: { env: bundle.env, data: bundle.data } }),
    ).rejects.toThrow(/Unknown data path 'users.admin.emial'.*broken\.md/);
  });

  it('frontmatter env: pins a test to a specific env when no CLI flag', async () => {
    const pinnedFile = path.join(tmpRoot, 'pinned.md');
    writeFileSync(
      pinnedFile,
      `---
env: staging
---
# pinned
## Steps
1. Hit \${env.BASE_URL}
`,
    );
    // Simulate CLI behaviour: parse first to read frontmatter, then re-parse with that env's bundle.
    const initial = await parseTestFile(pinnedFile);
    expect(initial.frontmatter.env).toBe('staging');

    const bundle = await resolveEnvBundle({
      envName: initial.frontmatter.env!,
      projectRoot: tmpRoot, dataDir: 'fixtures/data',
    });
    const reparsed = await parseTestFile(pinnedFile, {
      envData: { env: bundle.env, data: bundle.data },
    });
    expect(resolveStep(reparsed, 0)).toBe('Hit https://staging.example.com');
  });
});
