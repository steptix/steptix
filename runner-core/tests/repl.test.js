import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  INTERACTIVE_HELP,
  compareVariableNames,
  interpretReplCommand,
  isSecretVarName,
  maskIfSecret,
  maskRecordSecrets,
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

// ---------------------------------------------------------------------------
// The split rule: an author-chosen name vs a page-derived record column
// ---------------------------------------------------------------------------

// A flat name is the author's own word, so the broad list decides it. A dotted
// one is `root.property` where the property came off a page (a `readTable`
// column, a tool's record key), and there the narrow record-column rule
// decides — the same split the server makes (`isSecretName` vs
// `isRecordSecretKey`, src/utils/secrets.ts). The client used to apply one
// rule to both, and so disagreed with the server in both directions.
test('a dotted property that merely contains "key" is not a secret column', () => {
  assert.equal(maskIfSecret('payment.key', 'K-1'), 'K-1');
  assert.equal(maskIfSecret('payment.keys', 'a,b'), 'a,b');
  assert.equal(maskIfSecret('payment.sort_key', 'abc'), 'abc');
  assert.equal(maskIfSecret('payment.keyword', 'search'), 'search');
  assert.equal(maskIfSecret('payment.monkey', 'george'), 'george');
  // One word, no boundary for the rule to read — `api_key` and `apiKey` have
  // one, `apikey` does not. The server answers the same about the column.
  assert.equal(maskIfSecret('payment.apikey', 'abc'), 'abc');
});

test('a dotted property that names a credential IS a secret column', () => {
  for (const property of [
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'otp',
    'credential',
    'credentials',
    'api_key',
    'apiKey',
    'access_key',
    'private_key',
    'auth_key',
    'signing_key',
    'encryption_key',
    'user_password',
  ]) {
    assert.equal(maskIfSecret(`payment.${property}`, 'abc'), '***', property);
  }
});

test('a secret ROOT masks every property under it, column rule or not', () => {
  // The root is author-chosen, so the flat rule applies to it: a record the
  // author stored as `token` says what it is by its name.
  assert.equal(maskIfSecret('token.payee', 'Origin Energy'), '*'.repeat(8));
  assert.equal(maskIfSecret('api_key.id', 'abc'), '***');
});

test('a flat name still takes the broad list — a bare KEY is a secret', () => {
  assert.equal(maskIfSecret('MACHINE_KEY', 'abc'), '***');
  assert.equal(maskIfSecret('key', 'abc'), '***');
  assert.equal(maskIfSecret('sort_key', 'abc'), '***');
  assert.equal(maskIfSecret('apikey', 'abc'), '***');
});

test('isSecretVarName answers the split question too', () => {
  assert.equal(isSecretVarName('payment.sort_key'), false);
  assert.equal(isSecretVarName('payment.api_key'), true);
  assert.equal(isSecretVarName('sort_key'), true);
});

// ---------------------------------------------------------------------------
// maskRecordSecrets
// ---------------------------------------------------------------------------

// `frame:scope` carries raw values by design (the client masks), and a
// `readTable` capture is a whole table under ONE non-secret name. Masking by
// name alone therefore showed `payments` and `payment` in full beside a
// `payment.password` row rendered as `********` — which reads as "masked".
test('maskRecordSecrets: a list of records loses its secret columns', () => {
  const capture = JSON.stringify([
    { _row: '1', payee: 'Origin Energy', password: 'hunter2-not-real' },
    { _row: '2', payee: 'Alinta', password: 'swordfish' },
  ]);
  const masked = maskRecordSecrets(capture);
  assert.ok(!masked.includes('hunter2-not-real'), masked);
  assert.ok(!masked.includes('swordfish'), masked);
  assert.ok(masked.includes('Origin Energy'), 'the readable columns survive');
  assert.deepEqual(JSON.parse(masked), [
    { _row: '1', payee: 'Origin Energy', password: '*'.repeat(8) },
    { _row: '2', payee: 'Alinta', password: '*'.repeat(8) },
  ]);
});

test('maskRecordSecrets: one record masks the same way', () => {
  const masked = maskRecordSecrets(JSON.stringify({ payee: 'Alinta', api_key: 'pk-live-1' }));
  assert.deepEqual(JSON.parse(masked), { payee: 'Alinta', api_key: '*'.repeat(8) });
});

test('maskRecordSecrets: the record-column rule decides, not the broad one', () => {
  const capture = JSON.stringify([{ sort_key: 'abc', keyword: 'search', key: 'K-1' }]);
  assert.equal(maskRecordSecrets(capture), capture, 'a readable column stays readable');
});

test('maskRecordSecrets: no four-character floor — the KEY is the rule here', () => {
  // The floor belongs to the server's free-text mask set, where a
  // two-character value would be replaced everywhere including the DOM the
  // model plans from. Masking in place by key has no such reach, and the
  // sibling `payment.password` row is masked at any length too.
  assert.deepEqual(JSON.parse(maskRecordSecrets(JSON.stringify([{ password: 'ab' }]))), [
    { password: '**' },
  ]);
  assert.deepEqual(JSON.parse(maskRecordSecrets(JSON.stringify([{ password: '' }]))), [
    { password: '(empty)' },
  ]);
});

test('maskRecordSecrets: anything that is not a record list is returned as it was', () => {
  for (const value of [
    'Origin Energy',
    '',
    '[not json',
    '{oops}',
    '[ "Origin Energy", "Alinta" ]',
    '["password", "token"]',
    '42',
  ]) {
    assert.equal(maskRecordSecrets(value), value, JSON.stringify(value));
  }
});

test('maskRecordSecrets: a value it does not change is returned byte for byte', () => {
  // The re-stringify is compact, and a capture the server wrote is compact
  // too — but a tool may pretty-print, and reformatting a value nobody had to
  // mask would be this helper inventing a change.
  const spaced = '[\n  { "payee": "Alinta" }\n]';
  assert.equal(maskRecordSecrets(spaced), spaced);
});

test('maskIfSecret: a capture under a plain name is masked INSIDE', () => {
  const capture = JSON.stringify([{ payee: 'Alinta', password: 'hunter2-not-real' }]);
  const shown = maskIfSecret('payments', capture);
  assert.ok(!shown.includes('hunter2-not-real'), shown);
  assert.ok(shown.includes('Alinta'));
  // …and the whole-record binding of one pass, which is the same JSON.
  const record = JSON.stringify({ payee: 'Alinta', password: 'hunter2-not-real' });
  assert.ok(!maskIfSecret('payment', record).includes('hunter2-not-real'));
});

test('maskIfSecret: a SECRET-named capture is still masked whole', () => {
  // The name is the rule, and it says secret: nothing of the value shows,
  // not even the columns a record scan would have left readable.
  const capture = JSON.stringify([{ payee: 'Alinta', password: 'hunter2' }]);
  assert.equal(maskIfSecret('tokens', capture), '*'.repeat(8));
});

// ---------------------------------------------------------------------------
// compareVariableNames
// ---------------------------------------------------------------------------

test('compareVariableNames: `_row` leads its record, whatever the aliases are', () => {
  // A plain `.sort()` is by code unit, and `_` (95) sits between the upper
  // and the lower case letters — so an alias the author capitalised
  // (`Amount`) came out ahead of the row number. §7.4 asks for `_row` first.
  const names = ['payment.Amount', 'payment._row', 'payment.payee', 'payment.Status'];
  assert.deepEqual([...names].sort(compareVariableNames), [
    'payment._row',
    'payment.Amount',
    'payment.Status',
    'payment.payee',
  ]);
  assert.equal([...names].sort()[0], 'payment.Amount', 'which the default order got wrong');
});

test('compareVariableNames: the record itself comes before its properties', () => {
  assert.deepEqual(['payment.payee', 'payment', 'payments'].sort(compareVariableNames), [
    'payment',
    'payment.payee',
    'payments',
  ]);
});

test('compareVariableNames: roots still order by name', () => {
  assert.deepEqual(['order.id', 'delivery._row', 'order._row'].sort(compareVariableNames), [
    'delivery._row',
    'order._row',
    'order.id',
  ]);
});
