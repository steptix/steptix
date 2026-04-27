import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { EnvParseError, parseEnv, resolveEnvFile } from '../dist/env-file.js';

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
  const out = parseEnv('SERVER_URL=http://localhost:3100\nSERVER_API_KEY=abc');
  assert.deepEqual(out, { SERVER_URL: 'http://localhost:3100', SERVER_API_KEY: 'abc' });
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
