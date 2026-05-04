/**
 * Tests for the unified env+data resolver used by every entry point
 * (CLI, programmatic, server, testbench).
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
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'aiui-bundle-'));
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
    // env contains process.env snapshot — won't be empty, just check shape.
    expect(typeof bundle.env).toBe('object');
  });

  it('loads .env.<name> into process.env and snapshots it onto the bundle', async () => {
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'BASE_URL=https://uat.example.com\n');
    writeFileSync(path.join(tmpRoot, 'data', 'uat.json'), JSON.stringify({ region: 'au' }));

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.envName).toBe('uat');
    expect(bundle.env['BASE_URL']).toBe('https://uat.example.com');
    expect(process.env['BASE_URL']).toBe('https://uat.example.com');
    expect(bundle.data).toEqual({ region: 'au' });
  });

  it('resolves $VAR leaves in data file against the just-loaded .env', async () => {
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'ADMIN_PWD=letmein\n');
    writeFileSync(
      path.join(tmpRoot, 'data', 'uat.json'),
      JSON.stringify({ admin: { password: '$ADMIN_PWD' } }),
    );

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect((bundle.data['admin'] as { password: string }).password).toBe('letmein');
  });

  it('returns empty data object when data/<env>.json is missing', async () => {
    writeFileSync(path.join(tmpRoot, '.env.uat'), 'BASE_URL=https://uat.example.com\n');

    const bundle = await resolveEnvBundle({ envName: 'uat', projectRoot: tmpRoot });

    expect(bundle.envName).toBe('uat');
    expect(bundle.data).toEqual({});
  });

  it('throws when .env.<name> is missing (matches existing loadEnvFile behaviour)', async () => {
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
