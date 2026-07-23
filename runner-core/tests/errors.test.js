import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ALL_ERROR_CODES, reportError } from '../dist/errors.js';

const SAMPLE_CONTEXTS = {
  TB001: { searchedDirs: ['/ws/a/b', '/ws/a', '/ws'], fallbackSetting: '' },
  TB002: { envPath: '/ws/.env' },
  TB003: { envPath: '/ws/.env' },
  TB004: { envPath: '/ws/.env', value: 'not-a-url' },
  TB005: { envPath: '/ws/.env', lineNumber: 4, line: 'bad line' },
  TB006: { envName: 't2', expectedPath: '/ws/.env.t2', baseEnvPath: '/ws/base/.env' },
  TB010: { serverUrl: 'http://localhost:3100', reason: 'ECONNREFUSED' },
  TB011: { envPath: '/ws/.env', serverUrl: 'http://localhost:3100' },
  TB012: { serverUrl: 'http://localhost:3100' },
  TB013: { serverUrl: 'http://localhost:3100', status: 500, bodyExcerpt: 'oops' },
  TB014: { serverUrl: 'http://localhost:3100', reason: 'ECONNRESET' },
  TB020: { filePath: '/ws/foo.md' },
  TB021: {},
  TB024: { detail: 'duplicate section "Login" at line 12' },
  TB025: {},
  TB030: {},
  TB031: {},
};

test('every code in catalogue has a sample context (audit)', () => {
  const missing = ALL_ERROR_CODES.filter((c) => !(c in SAMPLE_CONTEXTS));
  assert.deepEqual(missing, []);
});

test('every code produces a payload with code + non-empty message + non-empty fix', () => {
  for (const code of ALL_ERROR_CODES) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    assert.equal(payload.code, code, `${code}: round-trips code`);
    assert.ok(payload.message.startsWith(`${code}:`), `${code}: message starts with code`);
    assert.ok(payload.diagnosis.length > 0, `${code}: has diagnosis`);
    assert.ok(payload.fix.length > 0, `${code}: has fix`);
  }
});

test('every fix sentence ends with a period', () => {
  for (const code of ALL_ERROR_CODES) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    assert.ok(payload.fix.endsWith('.'), `${code}: fix ends with period — got "${payload.fix}"`);
  }
});

test('errors involving a file path mention the path verbatim', () => {
  const cases = [
    ['TB002', '/ws/.env'],
    ['TB003', '/ws/.env'],
    ['TB004', '/ws/.env'],
    ['TB005', '/ws/.env'],
    ['TB006', '/ws/.env.t2'],
    ['TB011', '/ws/.env'],
    ['TB020', '/ws/foo.md'],
  ];
  for (const [code, expected] of cases) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    assert.ok(payload.message.includes(expected), `${code}: message must mention ${expected}`);
  }
});

test('errors involving SERVER_URL mention it verbatim', () => {
  const cases = ['TB010', 'TB011', 'TB012', 'TB013', 'TB014'];
  for (const code of cases) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    assert.ok(
      payload.message.includes('http://localhost:3100'),
      `${code}: message must include SERVER_URL`,
    );
  }
});

test('TB001 lists searched directories and the fallback setting name', () => {
  const payload = reportError('TB001', SAMPLE_CONTEXTS.TB001);
  assert.ok(payload.message.includes('/ws/a/b'));
  assert.ok(payload.message.includes('/ws'));
  assert.ok(payload.message.includes('testbench.defaultEnvFile'));
});

test('TB005 mentions the offending line number and content', () => {
  const payload = reportError('TB005', SAMPLE_CONTEXTS.TB005);
  assert.ok(payload.message.includes('line 4'));
  assert.ok(payload.message.includes('bad line'));
});

test('TB006 names the selected env and the expected .env.<name> path', () => {
  const payload = reportError('TB006', SAMPLE_CONTEXTS.TB006);
  assert.ok(payload.message.includes('t2'), 'mentions the env name');
  assert.ok(payload.message.includes('/ws/.env.t2'), 'mentions the expected overlay path');
  // Distinct from expectedPath so this proves baseEnvPath is actually surfaced
  // (not trivially satisfied as a substring of /ws/.env.t2).
  assert.ok(payload.message.includes('/ws/base/.env'), 'mentions the base .env path');
});

test('actions reference real-looking command ids', () => {
  for (const code of ALL_ERROR_CODES) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    for (const action of payload.actions) {
      assert.ok(action.label.length > 0, `${code}: action label non-empty`);
      assert.ok(action.command.length > 0, `${code}: action command non-empty`);
    }
  }
});
