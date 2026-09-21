import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  INTERACTIVE_HELP,
  compareVariableNames,
  interpretReplCommand,
  isSecretVarName,
  maskIfSecret,
  maskIfSecretAuthored,
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

// …matched as a SUBSTRING, the server's own breadth. Word boundaries were
// tried here and leaked: `mypassword`, `newpassword` and `apitoken` are one
// word to a splitter, so they matched nothing and rendered their values in the
// Variables view while every report starred them.
test('maskIfSecret: a flat name masks on a substring, as the report does', () => {
  for (const name of [
    'mypassword',
    'newpassword',
    'password2',
    'mytoken',
    'apitoken',
    'mysecret',
    'secret1',
    'MACHINE_KEY',
  ]) {
    assert.equal(maskIfSecret(name, 'hunter2'), '*'.repeat(7), name);
  }
});

// The price of that breadth, stated rather than worked around: a FLAT
// `keyword` masks here because it masks in the report, and a view that
// disagrees with the report beside it about one row is the worse bug. The
// narrow rule still applies where the name came off a page — see the dotted
// cases below.
test('maskIfSecret: a flat name that merely contains one masks too', () => {
  assert.equal(maskIfSecret('keyword', 'search'), '******');
  assert.equal(maskIfSecret('monkey', 'george'), '******');
  assert.equal(maskIfSecret('tokenize', 'yes'), '***');
  assert.equal(maskIfSecret('passwordless', 'yes'), '***');
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

// The record-COLUMN list is longer than `isSecretName` in one direction —
// `pwd`, `otp`, `credential` — and that list decides a COLUMN, not a flat
// name. A flat `pwd` is not masked, because the server does not mask it
// either: the report, the run log and the `## Values` block all print it, and
// the client's job is to say what they say.
test('maskIfSecret: pwd/otp/credential are column words, not flat ones', () => {
  for (const name of ['passwd', 'pwd', 'user_otp', 'credential', 'api_credentials']) {
    assert.equal(maskIfSecret(name, 'abc'), 'abc', `flat ${name}`);
    assert.equal(maskIfSecret(`payment.${name}`, 'abc'), '***', `column ${name}`);
  }
});

test('isSecretVarName answers the same question without a mask string', () => {
  assert.equal(isSecretVarName('api_key'), true);
  assert.equal(isSecretVarName('payment.password'), true);
  assert.equal(isSecretVarName('keyword'), true, 'flat: the server masks it, so this does');
  assert.equal(isSecretVarName('payment.keyword'), false, 'column: the narrow rule');
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

test('a flat name still takes the broad rule — a bare KEY is a secret', () => {
  assert.equal(maskIfSecret('MACHINE_KEY', 'abc'), '***');
  assert.equal(maskIfSecret('key', 'abc'), '***');
  assert.equal(maskIfSecret('sort_key', 'abc'), '***');
  assert.equal(maskIfSecret('apikey', 'abc'), '***');
  assert.equal(maskIfSecret('keyword', 'abc'), '***');
});

// The same word, both sides of the dot: flat it is the author's and masks,
// as a column it is the page's and does not. This pair is the whole split.
test('the split decides `keyword` and `sort_key` twice, and differently', () => {
  assert.equal(maskIfSecret('keyword', 'search'), '******');
  assert.equal(maskIfSecret('payment.keyword', 'search'), 'search');
  assert.equal(maskIfSecret('sort_key', 'abc'), '***');
  assert.equal(maskIfSecret('payment.sort_key', 'abc'), 'abc');
});

test('isSecretVarName answers the split question too', () => {
  assert.equal(isSecretVarName('payment.sort_key'), false);
  assert.equal(isSecretVarName('payment.api_key'), true);
  assert.equal(isSecretVarName('sort_key'), true);
});

// The third clause, and the one the two halves cannot supply between them: the
// WHOLE dotted name read as one credential key, dots as separators. Not every
// dotted name is a pass binding — `api.key` is one word split by a dot, and
// the server has always masked it (`wholeNameIsRecordSecret`, the third arm of
// `isSecretParameterName` in src/utils/secrets.ts). Measured before the fix:
// `isSecretVarName('api.key') === false` while the report said `***`.
test('a dotted name that reads as one credential key is a secret whole', () => {
  for (const name of ['api.key', 'private.key', 'service.access.key', 'auth.keys']) {
    assert.equal(isSecretVarName(name), true, name);
    assert.equal(maskIfSecret(name, 'uk_live_1234'), '*'.repeat(8), name);
  }
});

test('…and it is the RECORD rule doing that reading, so it stays whole-word', () => {
  // Joined, these are `row_keyword`, `payment_sort_key`, `order_monkey`: the
  // narrow rule says no to all three, which is what keeps a loop binding over
  // a `keyword` column readable in the view beside a report that prints it.
  for (const name of ['row.keyword', 'payment.sort_key', 'order.monkey']) {
    assert.equal(isSecretVarName(name), false, name);
    assert.equal(maskIfSecret(name, 'search'), 'search', name);
  }
});

// ---------------------------------------------------------------------------
// `bindings` — whose dotted name is it?
// ---------------------------------------------------------------------------
//
// The three arms above are the reading for a name a `For each` pass bound.
// They were applied to EVERY dotted name, because nothing on the wire said
// which ones a pass bound — the server keeps that in a registry keyed on the
// live map's object identity, and `frame:scope` sends a copy. So a data
// file's own `user.apikey` column heading took the record rule (`apikey` is
// one word, no boundary, not a secret COLUMN) and rendered `uk_live_1234` in
// the Variables view beside a report that starred it: the server's
// `isSecretParameterName` falls back to the FLAT author rule for a dotted name
// no pass bound, and `key` is in it.
//
// `FrameScopeEvent.bindings` is that registry as data, and these are the tests
// that the client now reads it the way the server reads the registry.

test('bindings: a dotted name nobody bound takes the flat author rule', () => {
  // The measured leak. `[]` is a real answer — "this run bound nothing" —
  // and it is what a test with no `For each` in it sends.
  assert.equal(isSecretVarName('user.apikey', []), true);
  assert.equal(maskIfSecret('user.apikey', 'uk_live_1234', { bindings: [] }), '*'.repeat(8));
  assert.equal(maskIfSecret('login.passkey', 'abc', { bindings: [] }), '***');
  // …and it is the WHOLE key that goes to the flat rule, so a name whose
  // halves each say nothing still masks when the join says `key`.
  assert.equal(maskIfSecret('payment.keyword', 'search', { bindings: [] }), '******');
  assert.equal(maskIfSecret('payment.sort_key', 'abc', { bindings: [] }), '***');
});

test('bindings: a dotted name a pass DID bind keeps the two-segment rule', () => {
  const bindings = ['payment.keyword', 'payment.sort_key', 'payment.password', 'payment.payee'];
  // The page named the column, so the narrow rule decides and `AU` stays
  // readable — which is the reason the two-segment rule exists at all.
  assert.equal(maskIfSecret('payment.keyword', 'AU', { bindings }), 'AU');
  assert.equal(maskIfSecret('payment.sort_key', 'abc', { bindings }), 'abc');
  assert.equal(maskIfSecret('payment.payee', 'Origin Energy', { bindings }), 'Origin Energy');
  // …and a column that really is a credential is still hidden.
  assert.equal(maskIfSecret('payment.password', 'hunter2', { bindings }), '*'.repeat(7));
});

test('bindings: one scope, both kinds of name, decided apart', () => {
  // The case the wire exists for: a loop binding and a data-file heading in
  // the SAME map, which no rule could tell apart from the names alone.
  const bindings = ['payment.keyword'];
  assert.equal(maskIfSecret('payment.keyword', 'AU', { bindings }), 'AU');
  assert.equal(maskIfSecret('user.apikey', 'uk_live_1234', { bindings }), '*'.repeat(8));
});

test('bindings: absent is not empty — an older server keeps the old reading', () => {
  // Nothing on the wire means nothing known, and the safe reading of a scope
  // full of real `row.<column>` bindings is the narrow one: collapsing absent
  // into `[]` would mask `AU` out of every row whose column is called
  // `keyword`, against a server that never said so.
  assert.equal(maskIfSecret('payment.keyword', 'AU'), 'AU');
  assert.equal(maskIfSecret('payment.keyword', 'AU', {}), 'AU');
  assert.equal(maskIfSecret('user.apikey', 'uk_live_1234'), 'uk_live_1234');
  assert.equal(isSecretVarName('user.apikey'), false, 'the no-map form is unchanged');
});

test('bindings: a flat name never consults the list', () => {
  // The registry is asked only about a dotted name, server-side too, so a
  // list that happens to be empty must not change what `keyword` does.
  assert.equal(maskIfSecret('keyword', 'search', { bindings: [] }), '******');
  assert.equal(maskIfSecret('payee', 'Alinta', { bindings: [] }), 'Alinta');
  assert.equal(maskIfSecret('payee', 'Alinta', { bindings: ['payee'] }), 'Alinta');
});

test('bindings: a Set and an array are the same answer', () => {
  // The wire hands over an array; a surface holding one for a whole run would
  // rather hold a Set, and `nameIn` probes for `.has` rather than assuming.
  for (const bindings of [['payment.keyword'], new Set(['payment.keyword'])]) {
    assert.equal(maskIfSecret('payment.keyword', 'AU', { bindings }), 'AU');
    assert.equal(maskIfSecret('user.apikey', 'uk_live_1234', { bindings }), '*'.repeat(8));
  }
});

// ---------------------------------------------------------------------------
// `unmask` — the author's hatch, reaching the client
// ---------------------------------------------------------------------------
//
// `## Config: unmask: keyword` says a name the rule matches is not a secret
// after all. It was read on the server only, so the value reached the model
// and the prompt while every client surface starred it.

test('unmask: a named entry is shown in full', () => {
  assert.equal(maskIfSecret('keyword', 'search', { unmask: ['keyword'] }), 'search');
  assert.equal(maskIfSecret('MACHINE_KEY', 'abc', { unmask: ['MACHINE_KEY'] }), 'abc');
  // By the EXACT name, as the server matches it: an unmasked `keyword` says
  // nothing about `password`.
  assert.equal(maskIfSecret('password', 'hunter2', { unmask: ['keyword'] }), '*******');
});

test('unmask: the exemption is from ALL THREE rules, not just the name one', () => {
  // The server's `formatParameterBlock` returns the value verbatim for an
  // unmasked name — no record scan, no free-text masking — because masking a
  // declared non-secret by its shape takes the hatch away through the other
  // door. A `readTable` capture the author unmasked comes back byte for byte.
  const capture = JSON.stringify([{ payee: 'Alinta', password: 'hunter2-not-real' }]);
  assert.equal(maskIfSecret('payments', capture, { unmask: ['payments'] }), capture);
  // …and without the hatch, the same value still loses its secret column.
  assert.ok(!maskIfSecret('payments', capture).includes('hunter2-not-real'));
});

test('unmask: a dotted binding can be unmasked too, whichever rule caught it', () => {
  const bindings = ['payment.password'];
  assert.equal(maskIfSecret('payment.password', 'abc', { bindings }), '***');
  assert.equal(
    maskIfSecret('payment.password', 'abc', { bindings, unmask: ['payment.password'] }),
    'abc',
  );
  // …and an unregistered one, which the flat rule would otherwise catch.
  assert.equal(
    maskIfSecret('user.apikey', 'uk_live_1234', { bindings: [], unmask: ['user.apikey'] }),
    'uk_live_1234',
  );
});

test('unmask: absent changes nothing', () => {
  assert.equal(maskIfSecret('keyword', 'search', {}), '******');
  assert.equal(maskIfSecret('keyword', 'search', { unmask: [] }), '******');
});

// ---------------------------------------------------------------------------
// maskIfSecretAuthored — the author rule on the WHOLE key
// ---------------------------------------------------------------------------
//
// The mirror of the server's `redactAuthoredMap`, for the two maps whose keys
// are author-chosen end to end: a data row's cells and a step's `[store as:]`
// outputs. `maskIfSecret`'s two-segment rule is the variable map's, and it
// answered no about `user.apikey` — so the Run Rows pick, the gutter hover and
// the Output banner printed `uk_live_1234` beside a report matrix saying
// `***`. The pre-feature client starred it.
test('maskIfSecretAuthored: the whole dotted key takes the flat author rule', () => {
  for (const name of ['user.apikey', 'user.apitoken', 'row.mypassword', 'login.passkey', 'api.key']) {
    assert.equal(maskIfSecretAuthored(name, 'uk_live_1234'), '*'.repeat(8), name);
  }
});

test('maskIfSecretAuthored: a flat name answers exactly as maskIfSecret does', () => {
  for (const [name, value] of [
    ['password', 'hunter2'],
    ['MACHINE_KEY', 'abc'],
    ['keyword', 'search'],
    ['username', 'alice'],
    ['payee', 'Origin Energy'],
    ['password', ''],
  ]) {
    assert.equal(maskIfSecretAuthored(name, value), maskIfSecret(name, value), name);
  }
});

test('maskIfSecretAuthored: a value whose NAME says nothing is still scanned', () => {
  // Same second half as `maskIfSecret`: a capture under `payments` is a whole
  // table, and the record-column rule is what hides the password column in it.
  const capture = JSON.stringify([{ payee: 'Alinta', password: 'hunter2-not-real' }]);
  const shown = maskIfSecretAuthored('payments', capture);
  assert.ok(!shown.includes('hunter2-not-real'), shown);
  assert.ok(shown.includes('Alinta'), shown);
  assert.equal(maskIfSecretAuthored('payee', 'Origin Energy'), 'Origin Energy');
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

// A tool returning records can put a number or a boolean under a `password`
// key, and `{"password":123}` rendered it in the clear while
// `{"password":"123"}` starred it — a distinction the surface does not make
// visible and the rule does not intend.
test('maskRecordSecrets: a non-string cell under a secret key masks too', () => {
  assert.deepEqual(JSON.parse(maskRecordSecrets(JSON.stringify({ password: 123 }))), {
    password: '***',
  });
  assert.deepEqual(JSON.parse(maskRecordSecrets(JSON.stringify([{ password: true }]))), [
    { password: '****' },
  ]);
  assert.deepEqual(JSON.parse(maskRecordSecrets(JSON.stringify([{ api_key: 4321 }]))), [
    { api_key: '****' },
  ]);
});

// …and the limit, stated: a null says there is no value, and a nested object
// would have to be walked — neither side masks inside one today.
test('maskRecordSecrets: null and nested objects under a secret key are left alone', () => {
  const withNull = JSON.stringify([{ password: null }]);
  assert.equal(maskRecordSecrets(withNull), withNull);
  const nested = JSON.stringify([{ password: { pin: '1234' } }]);
  assert.equal(maskRecordSecrets(nested), nested);
  const listed = JSON.stringify([{ password: ['a', 'b'] }]);
  assert.equal(maskRecordSecrets(listed), listed);
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

test('maskRecordSecrets: a leading BOM does not smuggle a record past the sniff', () => {
  // U+FEFF is whitespace to JS, so `/^\s*[[{]/` said yes and `JSON.parse`
  // then threw — and the catch returns the value untouched, which is the one
  // outcome this function exists to prevent. A file read as UTF-8-with-BOM is
  // where it comes from.
  const withBom = '\uFEFF[{"password":"hunter2"}]';
  assert.equal(maskRecordSecrets(withBom), '[{"password":"*******"}]');
  // Not a record even with the BOM gone: returned exactly as it arrived, BOM
  // included, because nothing was masked in it.
  assert.equal(maskRecordSecrets('\uFEFFOrigin Energy'), '\uFEFFOrigin Energy');
  assert.equal(maskRecordSecrets('\uFEFF[not json'), '\uFEFF[not json');
  const readable = '\uFEFF[{"payee":"Alinta"}]';
  assert.equal(maskRecordSecrets(readable), readable);
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
