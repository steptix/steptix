/**
 * Core logic of `${...}` go-to-definition — hit-testing the cursor against
 * complete references, locating a dotted path inside raw JSON text, and
 * locating an assignment inside .env text. The vscode wiring (file
 * resolution, Locations, warning toasts) lives in env-data-definition.ts and
 * is covered by the integration suite.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  findEnvLine,
  findParameterBullet,
  locateJsonPath,
  paramDefinition,
  paramRefAtPosition,
  refAtPosition,
} from '../src/extension/env-data-definition-core.ts';
import {
  allCaptureWrites,
  captureNamesBefore,
  hookScopeAt,
  isFencedLine,
} from '../src/extension/env-data-completion-core.ts';

// ---------------------------------------------------------------------------
// refAtPosition — which reference, and which of its tokens, the cursor is on
// ---------------------------------------------------------------------------

//            0123456789...
const LINE = '1. Use ${data.users.admin.email} now';

test('cursor on the namespace token reports segmentIndex -1', () => {
  const ref = refAtPosition(LINE, LINE.indexOf('data') + 2);
  assert.deepEqual(ref, {
    namespace: 'data',
    path: ['users', 'admin', 'email'],
    segmentIndex: -1,
  });
});

test('cursor on each path segment reports its index', () => {
  assert.equal(refAtPosition(LINE, LINE.indexOf('users')).segmentIndex, 0);
  assert.equal(refAtPosition(LINE, LINE.indexOf('admin')).segmentIndex, 1);
  assert.equal(refAtPosition(LINE, LINE.indexOf('email')).segmentIndex, 2);
});

test('a dot belongs to the segment it closes, its next char to the following one', () => {
  const firstDot = LINE.indexOf('.', LINE.indexOf('data'));
  assert.equal(refAtPosition(LINE, firstDot).segmentIndex, -1);
  assert.equal(refAtPosition(LINE, firstDot + 1).segmentIndex, 0);
});

test('the ${ edge clamps to the namespace, the } edge to the last segment', () => {
  const open = LINE.indexOf('${');
  const close = LINE.indexOf('}');
  assert.equal(refAtPosition(LINE, open).segmentIndex, -1);
  assert.equal(refAtPosition(LINE, close).segmentIndex, 2);
  // Just past the closing brace still counts (F12 at either token edge).
  assert.equal(refAtPosition(LINE, close + 1).segmentIndex, 2);
  assert.equal(refAtPosition(LINE, close + 2), null);
});

test('cursor outside any reference is null', () => {
  assert.equal(refAtPosition(LINE, 0), null);
  assert.equal(refAtPosition(LINE, LINE.length), null);
});

test('whitespace padding inside the braces is tolerated, like the runtime', () => {
  const line = 'Go to ${  data.url  } now';
  const ref = refAtPosition(line, line.indexOf('url'));
  assert.deepEqual(ref, { namespace: 'data', path: ['url'], segmentIndex: 0 });
});

test('an unclosed reference is not a jump target', () => {
  const line = '1. Use ${data.users';
  assert.equal(refAtPosition(line, line.indexOf('users')), null);
});

test('a dotless ${data} is not a runtime reference and yields null', () => {
  const line = 'See ${data} here';
  assert.equal(refAtPosition(line, line.indexOf('data')), null);
});

test('${envName} resolves as its own namespace with no path', () => {
  const line = 'Env is ${ envName } today';
  assert.deepEqual(refAtPosition(line, line.indexOf('envName')), {
    namespace: 'envName',
    path: [],
    segmentIndex: -1,
  });
});

test('${{name}} is the {{...}} grammar, not a ${...} reference', () => {
  const line = 'Use ${{name}} here';
  assert.equal(refAtPosition(line, line.indexOf('name')), null);
});

test('with two references on a line, the one under the cursor wins', () => {
  const line = 'A ${env.API_URL} and ${data.user.name} end';
  assert.deepEqual(refAtPosition(line, line.indexOf('API_URL')), {
    namespace: 'env',
    path: ['API_URL'],
    segmentIndex: 0,
  });
  assert.deepEqual(refAtPosition(line, line.indexOf('name')), {
    namespace: 'data',
    path: ['user', 'name'],
    segmentIndex: 1,
  });
});

test('digit and hyphen segments parse, matching the runtime path class', () => {
  const line = 'Item ${data.items.0.unit-price} here';
  const ref = refAtPosition(line, line.indexOf('unit-price'));
  assert.deepEqual(ref, {
    namespace: 'data',
    path: ['items', '0', 'unit-price'],
    segmentIndex: 2,
  });
});

// ---------------------------------------------------------------------------
// locateJsonPath — where a dotted path lives inside raw JSON text
// ---------------------------------------------------------------------------

const PRETTY = [
  '{',
  '  "users": {',
  '    "admin": { "email": "a@x.com", "password": "$TOK" }',
  '  },',
  '  "fixtures": { "currency": "USD" }',
  '}',
].join('\n');

test('a top-level key locates at its name inside the quotes', () => {
  assert.deepEqual(locateJsonPath(PRETTY, ['users']), {
    line: 1,
    column: 3,
    length: 5,
    depth: 1,
  });
});

test('a nested key locates on its own line and column', () => {
  assert.deepEqual(locateJsonPath(PRETTY, ['users', 'admin', 'email']), {
    line: 2,
    column: 16,
    length: 5,
    depth: 3,
  });
});

test('a missing tail reports the deepest existing ancestor and its depth', () => {
  assert.deepEqual(locateJsonPath(PRETTY, ['users', 'nope', 'deeper']), {
    line: 1,
    column: 3,
    length: 5,
    depth: 1,
  });
});

test('a fully missing path reports depth 0 at the top of the file', () => {
  assert.deepEqual(locateJsonPath(PRETTY, ['absent']), {
    line: 0,
    column: 0,
    length: 0,
    depth: 0,
  });
});

test('array segments locate the element value, zero-length', () => {
  const text = '{"list": ["a", "b", {"x": 1}]}';
  assert.deepEqual(locateJsonPath(text, ['list', '1']), {
    line: 0,
    column: 15,
    length: 0,
    depth: 2,
  });
  assert.deepEqual(locateJsonPath(text, ['list', '2', 'x']), {
    line: 0,
    column: 22,
    length: 1,
    depth: 3,
  });
});

test('array index matching mirrors lookupDataPath: Number("01") is index 1', () => {
  const text = '{"arr": ["x","y"]}';
  assert.deepEqual(locateJsonPath(text, ['arr', '01']), {
    line: 0,
    column: 13,
    length: 0,
    depth: 2,
  });
});

test('an out-of-range index stops at the array itself', () => {
  const text = '{"arr": ["x"]}';
  assert.deepEqual(locateJsonPath(text, ['arr', '5']), {
    line: 0,
    column: 2,
    length: 3,
    depth: 1,
  });
});

test('a duplicated key resolves to its LAST occurrence, like JSON.parse', () => {
  const text = '{"a": 1, "a": {"b": 2}}';
  assert.deepEqual(locateJsonPath(text, ['a']), {
    line: 0,
    column: 10,
    length: 1,
    depth: 1,
  });
  assert.deepEqual(locateJsonPath(text, ['a', 'b']), {
    line: 0,
    column: 16,
    length: 1,
    depth: 2,
  });
});

test('escaped quotes in other keys and brace-laden string values are skipped over', () => {
  const escapedKey = '{"we\\"ird": 0, "plain": 1}';
  assert.deepEqual(locateJsonPath(escapedKey, ['plain']), {
    line: 0,
    column: 16,
    length: 5,
    depth: 1,
  });
  const bracesInValue = '{"s": "a{b[\\"", "t": 2}';
  assert.deepEqual(locateJsonPath(bracesInValue, ['t']), {
    line: 0,
    column: 17,
    length: 1,
    depth: 1,
  });
});

test('CRLF line endings still yield the right line and column', () => {
  const text = '{\r\n  "k": 1\r\n}';
  assert.deepEqual(locateJsonPath(text, ['k']), {
    line: 1,
    column: 3,
    length: 1,
    depth: 1,
  });
});

test('a top-level array is walkable by index', () => {
  const text = '[\n  {"id": 1},\n  {"id": 2}\n]';
  assert.deepEqual(locateJsonPath(text, ['1', 'id']), {
    line: 2,
    column: 4,
    length: 2,
    depth: 2,
  });
});

test('a scalar in the middle of the path stops the walk there', () => {
  const text = '{"a": "leaf"}';
  assert.deepEqual(locateJsonPath(text, ['a', 'b']), {
    line: 0,
    column: 2,
    length: 1,
    depth: 1,
  });
});

// ---------------------------------------------------------------------------
// findEnvLine — where a key is assigned in .env text
// ---------------------------------------------------------------------------

test('a plain assignment locates the key token', () => {
  const text = '# comment\nAPI_URL=http://x\nOTHER=1\n';
  assert.deepEqual(findEnvLine(text, 'API_URL'), { line: 1, column: 0, length: 7 });
});

test('indentation shifts the column', () => {
  const text = '   API_URL=http://x\n';
  assert.deepEqual(findEnvLine(text, 'API_URL'), { line: 0, column: 3, length: 7 });
});

test('an `export ` prefix is part of the key, as the SERVER reads it', () => {
  // parseEnvFile (src/env/loader.ts) has no export handling, so this line
  // defines `export API_URL` and ${env.API_URL} would NOT resolve in a run.
  // Navigation must agree with the run, not with the friendlier parseEnv.
  const text = 'export API_URL=http://x\n';
  assert.equal(findEnvLine(text, 'API_URL'), null);
  assert.deepEqual(findEnvLine(text, 'export API_URL'), { line: 0, column: 0, length: 14 });
});

test('space before the = still matches the trimmed key', () => {
  const text = 'API_URL =http://x\n';
  assert.deepEqual(findEnvLine(text, 'API_URL'), { line: 0, column: 0, length: 7 });
});

test('the LAST assignment wins, matching the composed map', () => {
  const text = 'TOKEN=first\nTOKEN=second\n';
  assert.deepEqual(findEnvLine(text, 'TOKEN'), { line: 1, column: 0, length: 5 });
});

test('comment lines mentioning the key do not match', () => {
  const text = '# TOKEN=old\nTOKEN=real\n';
  assert.deepEqual(findEnvLine(text, 'TOKEN'), { line: 1, column: 0, length: 5 });
});

test('a key does not match its own prefix or superstring', () => {
  const text = 'FOOBAR=1\nFOO=2\n';
  assert.deepEqual(findEnvLine(text, 'FOO'), { line: 1, column: 0, length: 3 });
  assert.equal(findEnvLine(text, 'BAR'), null);
});

test('malformed lines are skipped, not thrown on — the server skips them too', () => {
  const text = 'not a pair\n=nokey\nGOOD=yes\n';
  assert.deepEqual(findEnvLine(text, 'GOOD'), { line: 2, column: 0, length: 4 });
});

test('CRLF files locate the same, since the server trims each line', () => {
  const text = 'A=1\r\nTARGET=2\r\n';
  assert.deepEqual(findEnvLine(text, 'TARGET'), { line: 1, column: 0, length: 6 });
});

test('an absent key is null', () => {
  assert.equal(findEnvLine('A=1\n', 'B'), null);
});

// ---------------------------------------------------------------------------
// paramRefAtPosition — the complete {{name}} under the cursor
// ---------------------------------------------------------------------------

test('cursor anywhere inside {{name}}, edges included, yields the name', () => {
  const line = '6. Sign in as {{username}} now';
  const open = line.indexOf('{{');
  const close = line.indexOf('}}') + 2;
  assert.deepEqual(paramRefAtPosition(line, open), { name: 'username' });
  assert.deepEqual(paramRefAtPosition(line, line.indexOf('username') + 3), { name: 'username' });
  assert.deepEqual(paramRefAtPosition(line, close), { name: 'username' });
  assert.equal(paramRefAtPosition(line, open - 1), null);
  assert.equal(paramRefAtPosition(line, close + 1), null);
});

test('${{name}} yields the inner {{name}}, as the runtime resolves it', () => {
  const line = 'Use ${{name}} here';
  assert.deepEqual(paramRefAtPosition(line, line.indexOf('name')), { name: 'name' });
});

test('unclosed or non-word {{...}} forms are not references', () => {
  assert.equal(paramRefAtPosition('Use {{name here', 6), null);
  const spaced = 'Use {{two words}} here';
  assert.equal(paramRefAtPosition(spaced, spaced.indexOf('two')), null);
});

test('with two {{}} refs on a line, the one under the cursor wins', () => {
  const line = 'Check {{a}} vs {{b}} now';
  assert.deepEqual(paramRefAtPosition(line, line.indexOf('a}}')), { name: 'a' });
  assert.deepEqual(paramRefAtPosition(line, line.indexOf('b}}')), { name: 'b' });
});

// ---------------------------------------------------------------------------
// findParameterBullet — the `- name:` line under ## Parameters
// ---------------------------------------------------------------------------

const PARAMS_DOC = [
  '# Title',
  '',
  '## Parameters',
  '- username: demo@x.com',
  '  - password: $PW',
  '',
  '## Steps',
  '- username: not-a-parameter-here',
].join('\n');

test('a declared parameter locates its bullet key, indentation included', () => {
  assert.deepEqual(findParameterBullet(PARAMS_DOC, 'username'), {
    line: 3,
    column: 2,
    length: 8,
  });
  assert.deepEqual(findParameterBullet(PARAMS_DOC, 'password'), {
    line: 4,
    column: 4,
    length: 8,
  });
});

test('the section ends at the next heading — later bullets do not count', () => {
  // `username` re-declared under ## Steps must not shadow line 3.
  assert.equal(findParameterBullet(PARAMS_DOC, 'username').line, 3);
  assert.equal(findParameterBullet(PARAMS_DOC, 'nope'), null);
});

test('heading match is case-insensitive and any ##+ depth, like parseSection', () => {
  const doc = '### parameters\n- key_name: v\n';
  assert.deepEqual(findParameterBullet(doc, 'key_name'), { line: 1, column: 2, length: 8 });
});

test('among duplicate bullets the LAST wins, matching the parsed map', () => {
  const doc = '## Parameters\n- user: first\n- user: second\n';
  assert.equal(findParameterBullet(doc, 'user').line, 2);
});

test('only the FIRST Parameters section is read, like parseSection', () => {
  const doc = '## Parameters\n- a: 1\n## Steps\n## Parameters\n- b: 2\n';
  assert.equal(findParameterBullet(doc, 'b'), null);
});

// ---------------------------------------------------------------------------
// Capture writes — scope AND position from one walk
// ---------------------------------------------------------------------------

/** The write of `name` in scope at 0-based `lineIdx`, as {line, column}. */
const writeOf = (text, lineIdx, name, opts) =>
  captureNamesBefore(text, lineIdx, undefined, opts).find((c) => c.name === name);

const STEPS = [
  '## Steps',
  '1. Read the balance [store as: balance]',
  '2. [input: user] sign in',
  '3. [skill: checkout out.total="grand"]',
  '4. Verify {{balance}}',
].join('\n');

test('a capture carries the column of its name token, not the line start', () => {
  const write = writeOf(STEPS, 4, 'balance');
  const line = STEPS.split('\n')[1];
  assert.equal(write.line, 2, '1-based line of the storing step');
  assert.equal(write.column, line.lastIndexOf('balance'));
  assert.equal(write.length, 7);
});

test('[input:] and an out.k="alias" locate their own name tokens', () => {
  const lines = STEPS.split('\n');
  assert.equal(writeOf(STEPS, 4, 'user').column, lines[2].indexOf('user]'));
  assert.equal(writeOf(STEPS, 4, 'grand').column, lines[3].indexOf('grand'));
});

test('a name echoed by an earlier word still locates the real token', () => {
  //           0123456789012345
  const text = '## Steps\n1. [store as: as]';
  assert.equal(writeOf(text, 2, 'as').column, 14);
});

test('two writes on one line are attributed in POSITION order, both located', () => {
  // The `[as:]` pattern is declared before the out-alias one, so a
  // pattern-ordered scan would pick the wrong token here.
  const text = '## Steps\n1. [skill: login out.token="tok"] then confirm [as: tok]';
  const line = text.split('\n')[1];
  const all = captureNamesBefore(text, 2, undefined, { dedupe: false }).filter(
    (c) => c.name === 'tok',
  );
  assert.equal(all.length, 2, 'both writes reported');
  assert.equal(all[0].marker, 'out-alias', 'the leftmost write leads');
  assert.equal(all[0].column, line.indexOf('tok"') , 'located at the alias, not the [as:]');
  assert.equal(all[1].column, line.lastIndexOf('tok'));
});

test('dedupe keeps the first write; dedupe:false keeps every one', () => {
  const text = ['## Steps', '1. Read [store as: code]', '2. Reread [store as: code]'].join('\n');
  assert.equal(captureNamesBefore(text, 3).filter((c) => c.name === 'code').length, 1);
  const all = captureNamesBefore(text, 3, undefined, { dedupe: false }).filter(
    (c) => c.name === 'code',
  );
  assert.deepEqual(all.map((c) => c.line), [2, 3]);
});

test('a hook write locates its token past the `- scope:` lead-in', () => {
  const text = ['## Hooks', '- before: log in [store as: session]', '', '## Steps', '1. Go'].join(
    '\n',
  );
  const write = writeOf(text, 4, 'session');
  assert.equal(write.column, text.split('\n')[1].indexOf('session'));
  assert.equal(write.length, 7);
});

// ---------------------------------------------------------------------------
// hookScopeAt / POST_HOOK_SCOPES — a read on an after-hook line
// ---------------------------------------------------------------------------

const HOOKED = [
  '## Hooks',
  '- after: verify {{token}}',
  '',
  '## Steps',
  '1. Read the token [store as: token]',
].join('\n');

test('hookScopeAt names the scope of a hook entry line, null elsewhere', () => {
  assert.equal(hookScopeAt(HOOKED, 1), 'after');
  assert.equal(hookScopeAt(HOOKED, 4), null, 'a step line is not a hook entry');
});

test('an after-hook read sees writes from the whole main flow', () => {
  // By file position alone nothing precedes line 1, which is why the hook
  // scope has to override it: `after` runs once every step has.
  assert.equal(writeOf(HOOKED, 1, 'token'), undefined, 'position alone finds nothing');
  const seen = writeOf(HOOKED, HOOKED.split('\n').length, 'token', { mainFlowOnly: true });
  assert.equal(seen.line, 5, 'the storing step is in scope for an after-hook');
});

// ---------------------------------------------------------------------------
// allCaptureWrites — "is it written at all", independent of cursor scope
// ---------------------------------------------------------------------------

test('allCaptureWrites finds a main-flow write below a trailing section body', () => {
  // The scope walk asked about EOF would adopt the trailing section and miss
  // step 5 entirely; this is why the diagnosis uses its own scan.
  const text = [
    '## Steps',
    '1. Open the site',
    '2. Login',
    '3. Verify {{code}}',
    '4. Continue',
    '5. Copy the confirmation [store as: code]',
    '',
    '### Login',
    '1. Sign in [store as: token]',
  ].join('\n');
  const names = allCaptureWrites(text).map((c) => c.name);
  assert.ok(names.includes('code'), 'the main-flow write below the call site is found');
  assert.ok(names.includes('token'), 'the section body write is found too');
  assert.equal(
    captureNamesBefore(text, text.split('\n').length).find((c) => c.name === 'code'),
    undefined,
    'the scope walk at EOF really does miss it — the reason allCaptureWrites exists',
  );
});

test('allCaptureWrites reports writes in file order with their positions', () => {
  const text = ['## Steps', '1. A [store as: one]', '2. B [store as: two]'].join('\n');
  assert.deepEqual(
    allCaptureWrites(text).map((c) => [c.name, c.line]),
    [
      ['one', 2],
      ['two', 3],
    ],
  );
});

test('fenced example writes are excluded from every walk', () => {
  const text = ['## Steps', '```', '1. [store as: fake]', '```', '1. Real'].join('\n');
  assert.deepEqual(allCaptureWrites(text), []);
});

// ---------------------------------------------------------------------------
// isFencedLine — a reference inside an example fence
// ---------------------------------------------------------------------------

test('isFencedLine marks the fenced body and its delimiters, not the prose', () => {
  const text = ['Intro', '```', 'use {{x}}', '```', 'After'].join('\n');
  assert.equal(isFencedLine(text, 0), false);
  assert.equal(isFencedLine(text, 2), true);
  assert.equal(isFencedLine(text, 4), false);
});

// ---------------------------------------------------------------------------
// paramDefinition — which line defines a `{{name}}`, and why none does
// ---------------------------------------------------------------------------
//
// The decision the provider used to make inline. Kept here because it is the
// part that can be wrong: which source wins for a dotted name, and which
// bindings a run has actually reached by the cursor's line.

/** `## Parameters` declares `order`, and a loop binds it too. Line numbers
 *  are 0-based, as `paramDefinition` reports its hits. */
const BOTH_SOURCES = [
  '# Orders', //                                                         0
  '', //                                                                 1
  '## Parameters', //                                                    2
  '- order: ORD-1', //                                                   3
  '', //                                                                 4
  '## Steps', //                                                         5
  '1. Read the Order ID column as id from every row [store as: orders]', // 6
  '2. For each {{order}} in {{orders}}, Check the order', //              7
  '', //                                                                 8
  '### Check the order', //                                              9
  '1. Verify the row for "{{order.id}}" is shown', //                    10
].join('\n');

test('a dotted reference prefers the For each over a same-named parameter', () => {
  // A `## Parameters` bullet holds a string; `{{order.id}}` reads a property,
  // which only a record a loop bound has. The bullet is still offered, second
  // — it is what `{{order}}` means everywhere the loop is not running.
  const found = paramDefinition(BOTH_SOURCES, 10, 'order.id');
  assert.equal(found.kind, 'found');
  assert.deepEqual(
    found.hits.map((h) => h.line),
    [7, 3],
  );
});

test('a flat reference prefers the parameter, which is the other reading', () => {
  const found = paramDefinition(BOTH_SOURCES, 10, 'order');
  assert.equal(found.kind, 'found');
  assert.deepEqual(
    found.hits.map((h) => h.line),
    [3, 7],
  );
});

test('the hit selects the name token, not the line it sits on', () => {
  const lines = BOTH_SOURCES.split('\n');
  const hit = paramDefinition(BOTH_SOURCES, 10, 'order.id').hits[0];
  assert.equal(lines[hit.line].slice(hit.column, hit.column + hit.length), 'order');
});

test('a loop below the reference IN THE SAME BODY has not run yet', () => {
  // `{{item}}` on the body's first line, the `For each` that binds it three
  // lines below: the run reaches the reference first, so this is the same
  // miss as a capture written later — not a jump.
  const text = [
    '## Steps', //                                     0
    '1. Read the rows [store as: rows]', //            1
    '2. Check them', //                                2
    '', //                                             3
    '### Check them', //                               4
    '1. Verify {{item.id}} is shown', //               5
    '2. Click Next', //                                6
    '3. For each {{item}} in {{rows}}, Check them', // 7
  ].join('\n');
  assert.deepEqual(paramDefinition(text, 5, 'item.id'), { kind: 'later-loop', line: 8 });
  // …and from BELOW that header, in the same body, it resolves.
  assert.equal(paramDefinition(text, 7, 'item.id').kind, 'found');
});

test('a loop in ANOTHER body is not judged by position — bodies are out of order', () => {
  // The header is on a LOWER line than the reference and still binds it: the
  // body it calls is defined under the main flow, as every body is.
  const text = [
    '## Steps', //                                        0
    '1. Read the rows [store as: rows]', //               1
    '2. For each {{item}} in {{rows}}, Check the row', // 2
    '', //                                                3
    '### Check the row', //                               4
    '1. Verify {{item.id}} is shown', //                  5
  ].join('\n');
  const found = paramDefinition(text, 5, 'item.id');
  assert.equal(found.kind, 'found');
  assert.deepEqual(
    found.hits.map((h) => h.line),
    [2],
  );
});

test('a For each under a #### heading never runs, so it defines nothing', () => {
  // `classifyLines` calls it an `inert-step`, and TestBench's own diagnostic
  // says "This step never runs" on that line. F12 must not land there.
  const text = [
    '## Steps', //                                             0
    '1. Read the rows [store as: rows]', //                    1
    '2. Check the row', //                                     2
    '', //                                                     3
    '#### Idea we dropped', //                                 4
    '1. For each {{item}} in {{rows}}, Check the row', //       5
    '', //                                                     6
    '### Check the row', //                                    7
    '1. Verify {{item.id}} is shown', //                       8
  ].join('\n');
  assert.deepEqual(paramDefinition(text, 8, 'item.id'), { kind: 'none' });
});

test('a numbered line outside the Steps span is prose, not a binding', () => {
  const text = [
    '# Notes', //                                          0
    '', //                                                 1
    '1. For each {{item}} in {{rows}}, do the thing', //    2
    '', //                                                 3
    '## Steps', //                                         4
    '1. Verify {{item.id}} is shown', //                   5
  ].join('\n');
  assert.deepEqual(paramDefinition(text, 5, 'item.id'), { kind: 'none' });
});

test('a capture written later is still reported as later, ahead of any loop', () => {
  const text = ['## Steps', '1. Verify {{token}}', '2. Read it [store as: token]'].join('\n');
  assert.deepEqual(paramDefinition(text, 1, 'token'), { kind: 'later-capture', line: 3 });
});

test('a dotted name whose root nothing binds is a plain miss', () => {
  const text = ['## Steps', '1. Verify {{ghost.id}} is shown'].join('\n');
  assert.deepEqual(paramDefinition(text, 1, 'ghost.id'), { kind: 'none' });
});
