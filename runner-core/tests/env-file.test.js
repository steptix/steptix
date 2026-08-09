import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import {
  EnvParseError,
  composeEnv,
  parseEnv,
  readEnvOverlayFile,
  resolveEnvFile,
} from '../dist/env-file.js';

/** Create a throwaway dir, run `fn(dir)`, then remove it. */
async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tb-env-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function fakeFs(presentPaths) {
  const set = new Set(presentPaths.map((p) => path.resolve(p)));
  return async (p) => set.has(path.resolve(p));
}

test('resolveEnvFile: finds .env next to the test file', async () => {
  const root = path.resolve('/ws');
  const result = await resolveEnvFile({
    testFile: path.join(root, 'a', 'b', 'login.md'),
    workspaceRoot: root,
    exists: fakeFs([path.join(root, 'a', 'b', '.env')]),
  });
  assert.equal(result.hit, true);
  assert.equal(result.path, path.join(root, 'a', 'b', '.env'));
  assert.equal(result.source, 'walkup');
});

test('resolveEnvFile: walks up to ancestor', async () => {
  const root = path.resolve('/ws');
  const result = await resolveEnvFile({
    testFile: path.join(root, 'a', 'b', 'c', 'login.md'),
    workspaceRoot: root,
    exists: fakeFs([path.join(root, 'a', '.env')]),
  });
  assert.equal(result.hit, true);
  assert.equal(result.path, path.join(root, 'a', '.env'));
});

test('resolveEnvFile: stops at workspace root (inclusive)', async () => {
  const root = path.resolve('/ws');
  const result = await resolveEnvFile({
    testFile: path.join(root, 'a', 'login.md'),
    workspaceRoot: root,
    exists: fakeFs([path.join(root, '.env')]),
  });
  assert.equal(result.hit, true);
  assert.equal(result.path, path.join(root, '.env'));
});

test('resolveEnvFile: does not walk past workspace root', async () => {
  const root = path.resolve('/ws');
  const outside = path.resolve('/.env');
  const result = await resolveEnvFile({
    testFile: path.join(root, 'login.md'),
    workspaceRoot: root,
    exists: fakeFs([outside]),
  });
  assert.equal(result.hit, false);
  assert.ok(result.searchedDirs.length > 0);
});

test('resolveEnvFile: falls back to setting', async () => {
  const root = path.resolve('/ws');
  const fallbackAbs = path.resolve('/elsewhere/team.env');
  const result = await resolveEnvFile({
    testFile: path.join(root, 'a', 'login.md'),
    workspaceRoot: root,
    fallbackPath: fallbackAbs,
    exists: fakeFs([fallbackAbs]),
  });
  assert.equal(result.hit, true);
  assert.equal(result.source, 'fallback');
  assert.equal(result.path, fallbackAbs);
});

test('resolveEnvFile: miss returns searched dirs + fallback path', async () => {
  const root = path.resolve('/ws');
  const result = await resolveEnvFile({
    testFile: path.join(root, 'a', 'b', 'login.md'),
    workspaceRoot: root,
    fallbackPath: '',
    exists: fakeFs([]),
  });
  assert.equal(result.hit, false);
  assert.deepEqual(result.searchedDirs, [
    path.join(root, 'a', 'b'),
    path.join(root, 'a'),
    root,
  ]);
  assert.equal(result.fallbackPath, '');
});

test('parseEnv: KEY=VALUE basic', () => {
  const out = parseEnv('SERVER_URL=http://localhost:3100\nAIUI_SERVER_API_KEY=abc');
  assert.deepEqual(out, { SERVER_URL: 'http://localhost:3100', AIUI_SERVER_API_KEY: 'abc' });
});

test('parseEnv: comments and blank lines ignored', () => {
  const out = parseEnv('# comment\n\nKEY=value\n# trailing');
  assert.deepEqual(out, { KEY: 'value' });
});

test('parseEnv: quoted values strip quotes', () => {
  const out = parseEnv("A='single'\nB=\"double\"\nC=plain");
  assert.deepEqual(out, { A: 'single', B: 'double', C: 'plain' });
});

test('parseEnv: inline comments stripped from unquoted values', () => {
  const out = parseEnv('KEY=value # trailing');
  assert.deepEqual(out, { KEY: 'value' });
});

test('parseEnv: inline-comment marker preserved inside quotes', () => {
  const out = parseEnv('KEY="value # not a comment"');
  assert.deepEqual(out, { KEY: 'value # not a comment' });
});

test('parseEnv: throws EnvParseError with line metadata', () => {
  try {
    parseEnv('GOOD=1\nbad line\nALSO=2');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof EnvParseError);
    assert.equal(err.lineNumber, 2);
    assert.equal(err.line, 'bad line');
  }
});

test('readEnvOverlayFile: reads .env.<name> beside the base .env', async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(path.join(dir, '.env.t2'), 'T2_ONLY=from-t2\nSHARED=t2wins\n');
    const overlay = await readEnvOverlayFile(dir, 't2');
    assert.deepEqual(overlay, { T2_ONLY: 'from-t2', SHARED: 't2wins' });
  });
});

test('readEnvOverlayFile: returns null when .env.<name> is absent', async () => {
  await withTempDir(async (dir) => {
    const overlay = await readEnvOverlayFile(dir, 'nope');
    assert.equal(overlay, null);
  });
});

test('readEnvOverlayFile: trims surrounding whitespace in the env name (quoted "  t2  " → .env.t2)', async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(path.join(dir, '.env.t2'), 'T2_ONLY=from-t2\n');
    // A quoted frontmatter `env: " t2 "` reaches here with the spaces intact;
    // it must still resolve .env.t2, not a spuriously-missing ".env. t2 ".
    const overlay = await readEnvOverlayFile(dir, '  t2  ');
    assert.deepEqual(overlay, { T2_ONLY: 'from-t2' });
  });
});

test('readEnvOverlayFile: throws EnvParseError on a malformed overlay line', async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(path.join(dir, '.env.bad'), 'OK=1\nbroken line\n');
    await assert.rejects(() => readEnvOverlayFile(dir, 'bad'), (err) => {
      assert.ok(err instanceof EnvParseError);
      assert.equal(err.lineNumber, 2);
      assert.equal(err.line, 'broken line');
      return true;
    });
  });
});

test('composeEnv: overlay wins on conflicts, base-only keys survive, overlay-only keys appear', () => {
  const base = { SHARED: 'base', BASE_ONLY: 'b', AIUI_SERVER_API_KEY: 'secret' };
  const overlay = { SHARED: 'overlay', OVERLAY_ONLY: 'o' };
  assert.deepEqual(composeEnv(base, overlay), {
    SHARED: 'overlay',
    BASE_ONLY: 'b',
    AIUI_SERVER_API_KEY: 'secret',
    OVERLAY_ONLY: 'o',
  });
});

test('composeEnv: does not mutate its inputs', () => {
  const base = { A: '1' };
  const overlay = { A: '2', B: '3' };
  composeEnv(base, overlay);
  assert.deepEqual(base, { A: '1' });
  assert.deepEqual(overlay, { A: '2', B: '3' });
});
