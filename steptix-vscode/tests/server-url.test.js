/**
 * Which server a run talks to: the project's .env, the environment, the
 * machine .env, then the default `steptix serve` listens on. The last two are
 * what let a project with no .env of its own run a test.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SERVER_URL,
  describeServerUrlOrigin,
  resolveServerUrl,
} from '../src/extension/server-url.ts';

/** A user root of its own, with `machineEnv` as its .env (none when null). */
function machine(machineEnv, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-server-url-'));
  const deps = { env: { LOCALAPPDATA: dir, XDG_CONFIG_HOME: dir, ...env }, platform: process.platform };
  const envPath = path.join(dir, 'steptix', '.env');
  if (machineEnv !== null) {
    mkdirSync(path.dirname(envPath), { recursive: true });
    writeFileSync(envPath, machineEnv);
  }
  return { deps, envPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PROJECT_ENV = path.resolve(path.sep, 'proj', '.env');

test('the project .env wins over everything below it', () => {
  const m = machine('SERVER_URL=http://127.0.0.1:3200\n', { SERVER_URL: 'http://127.0.0.1:3300' });
  try {
    const resolved = resolveServerUrl({ value: ' http://localhost:3106 ', path: PROJECT_ENV }, m.deps);
    assert.deepEqual(resolved, {
      serverUrl: 'http://localhost:3106',
      origin: { kind: 'project', path: PROJECT_ENV },
    });
  } finally {
    m.cleanup();
  }
});

test('the environment comes next, as it does for the key', () => {
  const m = machine('SERVER_URL=http://127.0.0.1:3200\n', { SERVER_URL: 'http://127.0.0.1:3300' });
  try {
    const resolved = resolveServerUrl({ value: '', path: PROJECT_ENV }, m.deps);
    assert.deepEqual(resolved, { serverUrl: 'http://127.0.0.1:3300', origin: { kind: 'environment' } });
  } finally {
    m.cleanup();
  }
});

test('a project with no .env takes the machine .env\'s SERVER_URL', () => {
  const m = machine('STEPTIX_SERVER_API_KEY=k\nSERVER_URL=http://127.0.0.1:3200\n');
  try {
    const resolved = resolveServerUrl(null, m.deps);
    assert.deepEqual(resolved, {
      serverUrl: 'http://127.0.0.1:3200',
      origin: { kind: 'machine', path: m.envPath },
    });
    assert.equal(describeServerUrlOrigin(resolved.origin, m.deps), m.envPath);
  } finally {
    m.cleanup();
  }
});

test('nothing anywhere is the default serve listens on, and the log says where it looked', () => {
  for (const machineEnv of [null, 'STEPTIX_SERVER_API_KEY=k\n']) {
    const m = machine(machineEnv);
    try {
      const resolved = resolveServerUrl({ value: undefined, path: PROJECT_ENV }, m.deps);
      assert.deepEqual(resolved, { serverUrl: DEFAULT_SERVER_URL, origin: { kind: 'default' } });
      assert.ok(describeServerUrlOrigin(resolved.origin, m.deps).includes(m.envPath));
    } finally {
      m.cleanup();
    }
  }
  assert.equal(DEFAULT_SERVER_URL, 'http://127.0.0.1:3100');
});

test('an unreadable machine .env throws rather than falling through to the default', () => {
  // The URL may well be in there; the default would be a guess.
  const m = machine(null);
  try {
    mkdirSync(m.envPath, { recursive: true });
    assert.throws(() => resolveServerUrl(null, m.deps), { code: 'EISDIR' });
  } finally {
    m.cleanup();
  }
});
