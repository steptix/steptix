import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ALL_ERROR_CODES, reportError } from '../dist/errors.js';

const SAMPLE_CONTEXTS = {
  TB001: { searchedDirs: ['/ws/a/b', '/ws/a', '/ws'], fallbackSetting: '' },
  TB002: { envPath: '/ws/.env' },
  TB003: { envPath: '/ws/.env', machineEnvPath: '/home/x/.aiui/.env' },
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
  TB026: {},
  TB027: { serverUrl: 'http://localhost:3100', service: 'grafana' },
  TB028: {
    serverUrl: 'http://localhost:3100',
    reason: 'the server did not become healthy within 20s',
    logPath: '/ws/globalStorage/server.log',
    logTail: 'Error: Cannot find module dist/index.js',
  },
  TB030: {},
  TB031: {},
  TB032: {
    // Verbatim `danglingChainMemberError` output, which is verbatim the CLI
    // parser's — see tests/control-line-parity.test.ts.
    detail:
      'Line 7 — "Otherwise, Pay by card" has no decision to be the alternative ' +
      'of. An `Otherwise` line must follow an `If … then …` or another `Else if` ' +
      'on the previous step line of the same flow (## Steps); a blank line or ' +
      'prose between them is fine, another numbered step is not.',
  },
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
  const cases = ['TB010', 'TB011', 'TB012', 'TB013', 'TB014', 'TB027', 'TB028'];
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

test('TB010 points at the auto-start settings (the §5.5 hint)', () => {
  // "Down + auto-start unconfigured" lands on TB010, and the whole point of
  // the hint is that the user learns the feature exists at the moment they
  // would want it.
  const payload = reportError('TB010', SAMPLE_CONTEXTS.TB010);
  assert.ok(payload.message.includes('testbench-native.serverAutoStart.command'));
});

test('TB027 names the foreign service so the user knows what is on the port', () => {
  const payload = reportError('TB027', SAMPLE_CONTEXTS.TB027);
  assert.ok(payload.message.includes('grafana'), 'names the service it identified as');
  // The refusal must read as deliberate, not as a transient failure — this is
  // the code that says "we will not spawn on top of someone else's port".
  assert.ok(/will not start a server/i.test(payload.message), 'explains the refusal');
});

test('TB028 names the log path and the settings that control auto-start', () => {
  const payload = reportError('TB028', SAMPLE_CONTEXTS.TB028);
  assert.ok(payload.message.includes('/ws/globalStorage/server.log'), 'names the log path');
  assert.ok(payload.message.includes('testbench-native.serverAutoStart.command'), 'names the command setting');
  assert.ok(payload.message.includes('testbench-native.serverAutoStart.cwd'), 'names the cwd setting');
  assert.ok(payload.message.includes('Cannot find module'), 'surfaces the log tail when supplied');
});

test('TB028 still names both settings when no log is available', () => {
  // The cwd-not-set refusal never spawns, so there is no log to point at —
  // the message must still say which settings to fix.
  const payload = reportError('TB028', {
    serverUrl: 'http://localhost:3100',
    reason: 'testbench-native.serverAutoStart.cwd is not set',
  });
  assert.ok(payload.message.includes('testbench-native.serverAutoStart.cwd'));
  assert.ok(!payload.message.includes('undefined'), 'no undefined leaks into the message');
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
