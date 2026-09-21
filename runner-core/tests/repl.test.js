import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  INTERACTIVE_HELP,
  interpretReplCommand,
  isSecretVarName,
  maskIfSecret,
} from '../dist/repl.js';

const noList = () => '';

// ---------------------------------------------------------------------------
// interpretReplCommand
// ---------------------------------------------------------------------------

test('interpretReplCommand: "/continue" exits the section', () => {
  assert.deepEqual(interpretReplCommand('/continue', noList), { kind: 'exit-section' });
});

test('interpretReplCommand: "/exit" aborts the run', () => {
  assert.deepEqual(interpretReplCommand('/exit', noList), { kind: 'quit-run' });
});

test('interpretReplCommand: "/quit" is an alias for /exit', () => {
  assert.deepEqual(interpretReplCommand('/quit', noList), { kind: 'quit-run' });
});

test('interpretReplCommand: case-insensitive slash commands', () => {
  assert.equal(interpretReplCommand('/CONTINUE', noList).kind, 'exit-section');
  assert.equal(interpretReplCommand('/Exit', noList).kind, 'quit-run');
});

test('interpretReplCommand: "/help" emits the help text as info output', () => {
  const action = interpretReplCommand('/help', noList);
  assert.equal(action.kind, 'output');
  assert.equal(action.level, 'info');
  assert.equal(action.msg, INTERACTIVE_HELP);
});

test('interpretReplCommand: "/list" calls the lazy lister and emits its result', () => {
  let called = 0;
  const lister = () => {
    called++;
    return '  1  open\n  2  click';
  };
  const action = interpretReplCommand('/list', lister);
  assert.equal(called, 1);
  assert.equal(action.kind, 'output');
  assert.equal(action.msg, '  1  open\n  2  click');
});

test('interpretReplCommand: "/list" with no steps falls back to placeholder', () => {
  const action = interpretReplCommand('/list', () => '');
  assert.equal(action.kind, 'output');
  assert.equal(action.msg, '(no steps in this file)');
});

test('interpretReplCommand: "/resume" returns a resume action', () => {
  assert.deepEqual(interpretReplCommand('/resume', noList), { kind: 'resume' });
});

test('interpretReplCommand: "/screenshot" returns a screenshot action', () => {
  assert.deepEqual(interpretReplCommand('/screenshot', noList), { kind: 'screenshot' });
});

test('interpretReplCommand: unknown single-token slash command is a warn output', () => {
  const action = interpretReplCommand('/bogus', noList);
  assert.equal(action.kind, 'output');
  assert.equal(action.level, 'warn');
  assert.match(action.msg, /unknown command/i);
  assert.match(action.msg, /\/bogus/);
});

test('interpretReplCommand: empty input is a noop', () => {
  assert.deepEqual(interpretReplCommand('', noList), { kind: 'noop' });
  assert.deepEqual(interpretReplCommand('   \t  ', noList), { kind: 'noop' });
});

test('interpretReplCommand: anything else becomes a send-step', () => {
  const action = interpretReplCommand('  click the green button  ', noList);
  assert.deepEqual(action, { kind: 'send-step', text: 'click the green button' });
});

test('interpretReplCommand: multi-line input is sent as a single trimmed step', () => {
  const action = interpretReplCommand('line one\nline two', noList);
  assert.equal(action.kind, 'send-step');
  assert.equal(action.text, 'line one\nline two');
});

test('interpretReplCommand: multi-token input starting with / is treated as a Flick step (e.g. paths)', () => {
  const action = interpretReplCommand('/admin/users page should load', noList);
  assert.deepEqual(action, { kind: 'send-step', text: '/admin/users page should load' });
});

test('interpretReplCommand: bare-word "done" returns a deprecation hint warn output', () => {
  const action = interpretReplCommand('done', noList);
  assert.equal(action.kind, 'output');
  assert.equal(action.level, 'warn');
  assert.match(action.msg, /\/continue/);
});

test('interpretReplCommand: bare-word "exit" returns a deprecation hint warn output', () => {
  const action = interpretReplCommand('exit', noList);
  assert.equal(action.kind, 'output');
  assert.equal(action.level, 'warn');
  assert.match(action.msg, /\/exit/);
});

test('interpretReplCommand: previous-design ":continue" returns a deprecation hint pointing at /continue', () => {
  const action = interpretReplCommand(':continue', noList);
  assert.equal(action.kind, 'output');
  assert.equal(action.level, 'warn');
  assert.match(action.msg, /\/continue/);
});

test('interpretReplCommand: previous-design ":exit" returns a deprecation hint pointing at /exit', () => {
  const action = interpretReplCommand(':exit', noList);
  assert.equal(action.kind, 'output');
  assert.equal(action.level, 'warn');
  assert.match(action.msg, /\/exit/);
});

test('interpretReplCommand: does NOT call lister when not /list', () => {
  let called = 0;
  const lister = () => {
    called++;
    return '';
  };
  interpretReplCommand('do something', lister);
  interpretReplCommand('/help', lister);
  interpretReplCommand('/continue', lister);
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------
// maskIfSecret
// ---------------------------------------------------------------------------

test('maskIfSecret: masks password-style names', () => {
  assert.equal(maskIfSecret('password', 'hunter2'), '*******');
  assert.equal(maskIfSecret('GITHUB_PASSWORD', 'hunter2'), '*******');
  assert.equal(maskIfSecret('userPassword', 'hunter2'), '*******');
});

test('maskIfSecret: masks secret/token/apikey', () => {
  assert.equal(maskIfSecret('SECRET', 'abc'), '***');
  assert.equal(maskIfSecret('api_key', 'abc'), '***');
  assert.equal(maskIfSecret('apiKey', 'abc'), '***');
  assert.equal(maskIfSecret('access_token', 'xyz'), '***');
});

test('maskIfSecret: caps mask length at 8 even for long values', () => {
  assert.equal(maskIfSecret('password', 'a'.repeat(50)), '*'.repeat(8));
});

test('maskIfSecret: returns "(empty)" for empty secret values', () => {
  assert.equal(maskIfSecret('password', ''), '(empty)');
});

test('maskIfSecret: passes through non-secret names', () => {
  assert.equal(maskIfSecret('username', 'alice'), 'alice');
  assert.equal(maskIfSecret('email', 'alice@example.com'), 'alice@example.com');
  assert.equal(maskIfSecret('id', '42'), '42');
});

// The client's rule and the server's `isSecretName` (src/parser/parameters.ts)
// decide the same names: what a report redacts, the Variables view and the
// Output banner must hide too. The regression this pins is a bare `key` — the
// old pattern knew `apikey` and `api_key` and nothing else, so `MACHINE_KEY`
// and `privateKey` rendered in full while every report masked them.
test('maskIfSecret: masks a bare "key", however the name spells it', () => {
  assert.equal(maskIfSecret('key', 'abc'), '***');
  assert.equal(maskIfSecret('MACHINE_KEY', 'abc'), '***');
  assert.equal(maskIfSecret('privateKey', 'abc'), '***');
  assert.equal(maskIfSecret('keys', 'abc'), '***');
  assert.equal(maskIfSecret('APIKEY', 'abc'), '***');
});

// …matched as WORDS, which is the one place the client is deliberately
// tighter: over-masking is its own bug, and a column called `keyword`
// rendered as `********` is a row nobody can read.
test('maskIfSecret: a word that merely contains one is not a secret', () => {
  assert.equal(maskIfSecret('keyword', 'search'), 'search');
  assert.equal(maskIfSecret('monkey', 'george'), 'george');
  assert.equal(maskIfSecret('tokenize', 'yes'), 'yes');
  assert.equal(maskIfSecret('passwordless', 'yes'), 'yes');
});

// A dotted loop binding is one name with a property segment
// (SPEC-structured-table-reads.md §8.4): the property decides, not the record
// variable it arrived under.
test('maskIfSecret: a dotted record property masks on its own segment', () => {
  assert.equal(maskIfSecret('payment.password', 'hunter2'), '*******');
  assert.equal(maskIfSecret('payment.api_key', 'abc'), '***');
  assert.equal(maskIfSecret('payment.payee', 'Origin Energy'), 'Origin Energy');
  assert.equal(maskIfSecret('payment._row', '3'), '3');
});

// The server masks a record COLUMN by a longer list than `isSecretName`
// (`isRecordSecretKey`, src/utils/secrets.ts), and `frame:scope` carries raw
// values — so the client's list must cover every word on it.
test('maskIfSecret: the record-column words the server also treats as secret', () => {
  for (const name of ['passwd', 'pwd', 'user_otp', 'credential', 'api_credentials']) {
    assert.equal(maskIfSecret(name, 'abc'), '***', name);
  }
});

test('isSecretVarName answers the same question without a mask string', () => {
  assert.equal(isSecretVarName('api_key'), true);
  assert.equal(isSecretVarName('payment.password'), true);
  assert.equal(isSecretVarName('keyword'), false);
  assert.equal(isSecretVarName('payee'), false);
});
