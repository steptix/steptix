import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALL_ERROR_CODES, reportError } from '../dist/errors.js';

/** The extension that renders these payloads, and owns their commands. */
const STEPTIX_PACKAGE = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'steptix-vscode', 'package.json'),
    'utf-8',
  ),
);

const SAMPLE_CONTEXTS = {
  STX001: { searchedDirs: ['/ws/a/b', '/ws/a', '/ws'], fallbackSetting: '' },
  STX002: { envPath: '/ws/.env' },
  STX003: { envPath: '/ws/.env', machineEnvPath: '/home/x/.steptix/.env' },
  STX004: { envPath: '/ws/.env', value: 'not-a-url' },
  STX005: { envPath: '/ws/.env', lineNumber: 4, line: 'bad line' },
  STX006: { envName: 't2', expectedPath: '/ws/.env.t2', baseEnvPath: '/ws/base/.env' },
  STX007: {
    machineEnvPath: '/home/x/.steptix/.env',
    reason: "EACCES: permission denied, open '/home/x/.steptix/.env'",
  },
  STX010: { serverUrl: 'http://localhost:3100', reason: 'ECONNREFUSED' },
  STX011: { envPath: '/ws/.env', serverUrl: 'http://localhost:3100' },
  STX012: { serverUrl: 'http://localhost:3100' },
  STX013: { serverUrl: 'http://localhost:3100', status: 500, bodyExcerpt: 'oops' },
  STX014: { serverUrl: 'http://localhost:3100', reason: 'ECONNRESET' },
  STX020: { filePath: '/ws/foo.md' },
  STX021: {},
  STX024: { detail: 'duplicate section "Login" at line 12' },
  STX025: {},
  STX026: {},
  STX027: { serverUrl: 'http://localhost:3100', service: 'grafana' },
  STX028: {
    serverUrl: 'http://localhost:3100',
    reason: 'the server did not become healthy within 20s',
    logPath: '/ws/globalStorage/server.log',
    logTail: 'Error: Cannot find module dist/index.js',
  },
  STX030: {},
  STX031: {},
  STX032: {
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

test('every code has a message led by its code, a diagnosis, and a fix sentence that ends with a period', () => {
  for (const code of ALL_ERROR_CODES) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    assert.ok(payload.message.startsWith(`${code}: `), `${code}: message starts with "${code}: " — got "${payload.message}"`);
    assert.ok(payload.diagnosis.length > 0, `${code}: has diagnosis`);
    assert.ok(payload.fix.endsWith('.'), `${code}: fix ends with period — got "${payload.fix}"`);
  }
});

test('errors involving a file path mention the path verbatim', () => {
  const cases = [
    ['STX002', '/ws/.env'],
    ['STX003', '/ws/.env'],
    ['STX004', '/ws/.env'],
    ['STX005', '/ws/.env'],
    ['STX006', '/ws/.env.t2'],
    ['STX007', '/home/x/.steptix/.env'],
    ['STX011', '/ws/.env'],
    ['STX020', '/ws/foo.md'],
  ];
  for (const [code, expected] of cases) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    assert.ok(payload.message.includes(expected), `${code}: message must mention ${expected}`);
  }
});

test('errors involving STEPTIX_SERVER_URL mention it verbatim', () => {
  const cases = ['STX010', 'STX011', 'STX012', 'STX013', 'STX014', 'STX027', 'STX028'];
  for (const code of cases) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    assert.ok(
      payload.message.includes('http://localhost:3100'),
      `${code}: message must include STEPTIX_SERVER_URL`,
    );
  }
});

test('STX001 lists searched directories and the fallback setting name', () => {
  const payload = reportError('STX001', SAMPLE_CONTEXTS.STX001);
  assert.ok(payload.message.includes('/ws/a/b'));
  assert.ok(payload.message.includes('/ws'));
  assert.ok(payload.message.includes('steptix.defaultEnvFile'));
});

test('STX005 mentions the offending line number and content', () => {
  const payload = reportError('STX005', SAMPLE_CONTEXTS.STX005);
  assert.ok(payload.message.includes('line 4'));
  assert.ok(payload.message.includes('bad line'));
});

test('STX006 names the selected env and the expected .env.<name> path', () => {
  const payload = reportError('STX006', SAMPLE_CONTEXTS.STX006);
  assert.ok(payload.message.includes('t2'), 'mentions the env name');
  assert.ok(payload.message.includes('/ws/.env.t2'), 'mentions the expected overlay path');
  // Distinct from expectedPath so this proves baseEnvPath is actually surfaced
  // (not trivially satisfied as a substring of /ws/.env.t2).
  assert.ok(payload.message.includes('/ws/base/.env'), 'mentions the base .env path');
});

test('STX007 carries the read error, so the cause is not a guess', () => {
  const payload = reportError('STX007', SAMPLE_CONTEXTS.STX007);
  assert.ok(payload.message.includes('EACCES'), 'surfaces the errno');
});

test('STX010 points at the auto-start settings (the §5.5 hint)', () => {
  // "Down + auto-start unconfigured" lands on STX010, and the whole point of
  // the hint is that the user learns the feature exists at the moment they
  // would want it.
  const payload = reportError('STX010', SAMPLE_CONTEXTS.STX010);
  assert.ok(payload.message.includes('steptix.serverAutoStart.command'));
});

test('STX027 names the foreign service so the user knows what is on the port', () => {
  const payload = reportError('STX027', SAMPLE_CONTEXTS.STX027);
  assert.ok(payload.message.includes('grafana'), 'names the service it identified as');
  // The refusal must read as deliberate, not as a transient failure — this is
  // the code that says "we will not spawn on top of someone else's port".
  assert.ok(/will not start a server/i.test(payload.message), 'explains the refusal');
});

test('STX028 names the log path and the settings that control auto-start', () => {
  const payload = reportError('STX028', SAMPLE_CONTEXTS.STX028);
  assert.ok(payload.message.includes('/ws/globalStorage/server.log'), 'names the log path');
  assert.ok(payload.message.includes('steptix.serverAutoStart.command'), 'names the command setting');
  assert.ok(payload.message.includes('steptix.serverAutoStart.cwd'), 'names the cwd setting');
  assert.ok(payload.message.includes('Cannot find module'), 'surfaces the log tail when supplied');
});

test('STX028 still names both settings when no log is available', () => {
  // The cwd-not-set refusal never spawns, so there is no log to point at —
  // the message must still say which settings to fix.
  const payload = reportError('STX028', {
    serverUrl: 'http://localhost:3100',
    reason: 'steptix.serverAutoStart.cwd is not set',
  });
  assert.ok(payload.message.includes('steptix.serverAutoStart.cwd'));
  assert.ok(!payload.message.includes('undefined'), 'no undefined leaks into the message');
});

test('STX028 for the installed runtime names its folder and what usually breaks it', () => {
  // No command setting was involved, so a fix that only said "fix the
  // command setting" would send the user to a setting they never wrote.
  const payload = reportError('STX028', {
    ...SAMPLE_CONTEXTS.STX028,
    runtimeDir: '/home/x/.steptix/runtimes/1.0.0',
  });
  assert.ok(payload.message.includes('/home/x/.steptix/runtimes/1.0.0'), 'names the runtime folder');
  assert.ok(payload.message.includes('/ws/globalStorage/server.log'), 'still names the log');
  assert.ok(/Node\.js/.test(payload.fix), 'says the runtime needs Node');
  assert.ok(payload.fix.endsWith('.'));
});

test('every action runs a VS Code built-in or a command the extension contributes', () => {
  // A button whose command nobody registers fails with "command not found" at
  // the moment the user reaches for help — the one time it must work.
  const contributed = new Set(STEPTIX_PACKAGE.contributes.commands.map((c) => c.command));
  let checked = 0;
  for (const code of ALL_ERROR_CODES) {
    const payload = reportError(code, SAMPLE_CONTEXTS[code]);
    for (const action of payload.actions) {
      assert.ok(action.label.length > 0, `${code}: action label non-empty`);
      assert.ok(
        action.command.startsWith('workbench.') || contributed.has(action.command),
        `${code}: "${action.command}" is neither a workbench.* built-in nor in steptix-vscode/package.json contributes.commands`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, 'no action was checked');
});
