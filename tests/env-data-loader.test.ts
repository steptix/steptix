/**
 * Tests for `<dataDir>/<env>.json` loading (config-driven dataDir, default
 * `data`) + dotted-path lookup + `$VAR` secret resolution against an env map.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadDataFile,
  lookupDataPath,
  type DataObject,
} from '../src/env/data-loader.js';

describe('loadDataFile', () => {
  let tmpRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'aiui-data-'));
    mkdirSync(path.join(tmpRoot, 'fixtures', 'data'), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('loads a flat JSON object', async () => {
    writeFileSync(
      path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
      JSON.stringify({ baseUrl: 'https://uat.example.com', timeoutMs: 5000 }),
    );
    const data = await loadDataFile('uat', tmpRoot, 'fixtures/data');
    expect(data).toEqual({ baseUrl: 'https://uat.example.com', timeoutMs: 5000 });
  });

  it('loads a nested JSON object', async () => {
    writeFileSync(
      path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
      JSON.stringify({
        users: { admin: { email: 'a@uat.example.com', password: 'pw' } },
      }),
    );
    const data = await loadDataFile('uat', tmpRoot, 'fixtures/data');
    expect((data['users'] as DataObject)['admin']).toEqual({
      email: 'a@uat.example.com',
      password: 'pw',
    });
  });

  it('resolves $VAR string leaves against process.env', async () => {
    process.env['ADMIN_PWD'] = 's3cret';
    writeFileSync(
      path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
      JSON.stringify({
        users: { admin: { email: 'a@uat.example.com', password: '$ADMIN_PWD' } },
      }),
    );
    const data = await loadDataFile('uat', tmpRoot, 'fixtures/data');
    expect(((data['users'] as DataObject)['admin'] as DataObject)['password']).toBe('s3cret');
  });

  it('keeps the literal $VAR when the env var is not set (with a warning)', async () => {
    delete process.env['MISSING_VAR'];
    writeFileSync(
      path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
      JSON.stringify({ password: '$MISSING_VAR' }),
    );
    const data = await loadDataFile('uat', tmpRoot, 'fixtures/data');
    expect(data['password']).toBe('$MISSING_VAR');
  });

  it('resolves $VAR leaves against an explicit envMap (the per-project server map)', async () => {
    // process.env deliberately does NOT have this key — the value must come
    // from the supplied map, proving the server path doesn't depend on the global.
    delete process.env['PROJ_PWD'];
    writeFileSync(
      path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
      JSON.stringify({ admin: { password: '$PROJ_PWD' } }),
    );
    const data = await loadDataFile('uat', tmpRoot, 'fixtures/data', { PROJ_PWD: 'from-map' });
    expect((data['admin'] as DataObject)['password']).toBe('from-map');
  });

  it('returns {} when the file does not exist', async () => {
    const data = await loadDataFile('does-not-exist', tmpRoot, 'fixtures/data');
    expect(data).toEqual({});
  });

  it('throws on invalid JSON', async () => {
    writeFileSync(path.join(tmpRoot, 'fixtures', 'data', 'broken.json'), '{ not valid json');
    await expect(loadDataFile('broken', tmpRoot, 'fixtures/data')).rejects.toThrow(/Invalid JSON/);
  });

  it('throws when the top-level value is not an object', async () => {
    writeFileSync(path.join(tmpRoot, 'fixtures', 'data', 'arr.json'), JSON.stringify(['a', 'b']));
    await expect(loadDataFile('arr', tmpRoot, 'fixtures/data')).rejects.toThrow(/JSON object at the top level/);
  });

  it('preserves arrays inside the data tree', async () => {
    writeFileSync(
      path.join(tmpRoot, 'fixtures', 'data', 'uat.json'),
      JSON.stringify({ regions: ['au', 'nz', 'us'] }),
    );
    const data = await loadDataFile('uat', tmpRoot, 'fixtures/data');
    expect(data['regions']).toEqual(['au', 'nz', 'us']);
  });
});

describe('lookupDataPath', () => {
  const tree: DataObject = {
    users: {
      admin: { email: 'a@example.com', password: 'pw' },
    },
    regions: ['au', 'nz', 'us'],
    fixture: { count: 42, enabled: true, weight: null },
  };

  it('walks a nested object path', () => {
    expect(lookupDataPath(tree, 'users.admin.email')).toBe('a@example.com');
  });

  it('returns the leaf type unchanged (number)', () => {
    expect(lookupDataPath(tree, 'fixture.count')).toBe(42);
  });

  it('returns the leaf type unchanged (boolean)', () => {
    expect(lookupDataPath(tree, 'fixture.enabled')).toBe(true);
  });

  it('returns null leaves as null (distinct from missing)', () => {
    expect(lookupDataPath(tree, 'fixture.weight')).toBeNull();
  });

  it('indexes into arrays by numeric index', () => {
    expect(lookupDataPath(tree, 'regions.1')).toBe('nz');
  });

  it('returns undefined for unknown intermediate keys', () => {
    expect(lookupDataPath(tree, 'users.viewer.email')).toBeUndefined();
  });

  it('returns undefined for unknown final keys', () => {
    expect(lookupDataPath(tree, 'users.admin.unknown')).toBeUndefined();
  });

  it('returns undefined for an out-of-bounds array index', () => {
    expect(lookupDataPath(tree, 'regions.99')).toBeUndefined();
  });

  it('returns undefined for an empty path', () => {
    expect(lookupDataPath(tree, '')).toBeUndefined();
  });

  it('returns undefined when descending into a non-object scalar', () => {
    expect(lookupDataPath(tree, 'fixture.count.x')).toBeUndefined();
  });
});
