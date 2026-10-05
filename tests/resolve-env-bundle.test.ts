/**
 * Tests for the unified env+data resolver used by every entry point
 * (CLI, programmatic, server, steptix).
 *
 * The server path is **pure** — it composes a per-project env map and never
 * mutates the global `process.env`. The CLI path opts into mutation with
 * `mutateProcessEnv: true`. The data dir is supplied by the caller (from
 * `tests.dataDir`), defaulting to `data`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveEnvBundle } from '../src/env/resolve-bundle.js';

describe('resolveEnvBundle', () => {
  let tmpRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'steptix-bundle-'));
    mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns empty bundle when no envName supplied', async () => {
    const bundle = await resolveEnvBundle({ projectRoot: tmpRoot });
    expect(bundle.envName).toBeNull();
    expect(bundle.data).toEqual({});
    // env contains the process baseline — won't be empty, just check shape.
    expect(typeof bundle.env).toBe('object');
  });

  it('composes .env.<name> into the bundle map WITHOUT mutating process.env (default/server path)', async () => {
    // The purity check below reads `undefined` as "never written", so the
    // shell running the suite must not have supplied it either.
    delete process.env['BASE_URL_PURE'];
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'BASE_URL_PURE=https://uat.example.com\n');
    writeFileSync(path.join(tmpRoot, 'data', 'uat.json'), JSON.stringify({ region: 'au' }));

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.envName).toBe('uat');
    expect(bundle.env['BASE_URL_PURE']).toBe('https://uat.example.com');
    // Pure: the global is untouched.
    expect(process.env['BASE_URL_PURE']).toBeUndefined();
    expect(bundle.data).toEqual({ region: 'au' });
  });

  it('mutateProcessEnv: true merges .env.<name> into process.env (CLI path)', async () => {
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'BASE_URL_MUT=https://uat.example.com\n');

    const bundle = await resolveEnvBundle({
      envName: 'uat',
      projectRoot: tmpRoot,
      mutateProcessEnv: true,
    });

    expect(bundle.env['BASE_URL_MUT']).toBe('https://uat.example.com');
    expect(process.env['BASE_URL_MUT']).toBe('https://uat.example.com');
  });

  it('uses the supplied dataDir (not the default) to locate the data file', async () => {
    mkdirSync(path.join(tmpRoot, 'fixtures', 'data'), { recursive: true });
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'X=1\n');
    writeFileSync(
      path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
      JSON.stringify({ region: 'eu' }),
    );

    const bundle = await resolveEnvBundle({
      envName: 'uat',
      projectRoot: tmpRoot,
      dataDir: 'fixtures/data',
    });

    expect(bundle.data).toEqual({ region: 'eu' });
  });

  it('defaults the data dir to `data` when none is supplied', async () => {
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'X=1\n');
    writeFileSync(path.join(tmpRoot, 'data', 'uat.json'), JSON.stringify({ region: 'au' }));

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.data).toEqual({ region: 'au' });
  });

  it('resolves $VAR leaves in the data file against the composed map (no global mutation)', async () => {
    // ADMIN_PWD is the name the repo's own fixtures use, so a shell that
    // exported the project `.env` has it. Clear it before the purity check
    // reads it; afterEach puts it back.
    delete process.env['ADMIN_PWD'];
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'ADMIN_PWD=letmein\n');
    writeFileSync(
      path.join(tmpRoot, 'data', 'uat.json'),
      JSON.stringify({ admin: { password: '$ADMIN_PWD' } }),
    );

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect((bundle.data['admin'] as { password: string }).password).toBe('letmein');
    // Still pure — the secret never landed in the global.
    expect(process.env['ADMIN_PWD']).toBeUndefined();
  });

  it('layers base .env under .env.<name> (env-specific wins)', async () => {
    writeFileSync(path.join(tmpRoot, '.env'), 'SHARED_VAL=base\nONLY_BASE=yes\n');
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'SHARED_VAL=override\n');

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.env['SHARED_VAL']).toBe('override');
    expect(bundle.env['ONLY_BASE']).toBe('yes');
  });

  it('base .env does NOT override an existing process baseline value (shell wins)', async () => {
    process.env['SHELL_WINS_KEY'] = 'from-shell';
    writeFileSync(path.join(tmpRoot, '.env'), 'SHELL_WINS_KEY=from-dotenv\n');
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'X=1\n');

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.env['SHELL_WINS_KEY']).toBe('from-shell');
  });

  it('.env.<name> overrides even an existing baseline value', async () => {
    process.env['OVERRIDE_ME'] = 'from-baseline';
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'OVERRIDE_ME=from-env-uat\n');

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.env['OVERRIDE_ME']).toBe('from-env-uat');
  });

  it('returns empty data object when the data file is missing', async () => {
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'BASE_URL=https://uat.example.com\n');

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.envName).toBe('uat');
    expect(bundle.data).toEqual({});
  });

  it('throws when .env.<name> is missing', async () => {
    writeFileSync(path.join(tmpRoot, 'data', 'uat.json'), JSON.stringify({}));

    await expect(
      resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot }),
    ).rejects.toThrow(/Environment file not found/);
  });

  it('whitespace-only envName is treated as unset', async () => {
    const bundle = await resolveEnvBundle({ envName: '   ', projectRoot: tmpRoot });
    expect(bundle.envName).toBeNull();
    expect(bundle.data).toEqual({});
  });
});
