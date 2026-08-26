/**
 * Core logic of `${env.X}` / `${data.X.Y}` / `${<source>.X}` completion —
 * cursor-context parsing, tree walking, `$VAR` leaf resolution, and item
 * generation with secret masking — plus the `{{name}}` runtime half: its
 * cursor context, the capture names earlier steps write, and its items. The
 * vscode wiring (file loading, item mapping) lives in env-data-completion.ts
 * and is not under test here.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveValueFromEnv } from 'ai-ui-automation-runner-core';
import {
  captureNamesBefore,
  envVarCompletions,
  inFrontmatter,
  namespaceCompletions,
  paramCompletions,
  paramContextAt,
  refContextAt,
  resolveDataTree,
  treeCompletions,
  walkTree,
} from '../src/extension/env-data-completion-core.ts';

// ---------------------------------------------------------------------------
// refContextAt — where the cursor is inside a `${...` reference
// ---------------------------------------------------------------------------

test('right after ${ is a namespace position with an empty partial', () => {
  const line = '1. Navigate to ${';
  const ctx = refContextAt(line, line.length);
  assert.deepEqual(ctx, { kind: 'namespace', partial: '', replaceStart: line.length });
});

test('a namespace being typed carries the partial and its start column', () => {
  const line = '1. Navigate to ${da';
  const ctx = refContextAt(line, line.length);
  assert.deepEqual(ctx, { kind: 'namespace', partial: 'da', replaceStart: line.length - 2 });
});

test('whitespace after ${ is tolerated, like the runtime regex', () => {
  const line = '1. Go to ${  data';
  const ctx = refContextAt(line, line.length);
  assert.deepEqual(ctx, { kind: 'namespace', partial: 'data', replaceStart: line.length - 4 });
});

test('a dot after the namespace switches to path completion', () => {
  const line = '1. Open ${data.';
  const ctx = refContextAt(line, line.length);
  assert.deepEqual(ctx, {
    kind: 'path',
    namespace: 'data',
    parentPath: [],
    partial: '',
    replaceStart: line.length,
  });
});

test('deep paths split into parent segments and the typed partial', () => {
  const line = '1. Sign in as ${data.users.ad';
  const ctx = refContextAt(line, line.length);
  assert.deepEqual(ctx, {
    kind: 'path',
    namespace: 'data',
    parentPath: ['users'],
    partial: 'ad',
    replaceStart: line.length - 2,
  });
});

test('numeric and hyphenated segments are path-legal (users.0.email-alt)', () => {
  const line = '1. ${data.users.0.email-al';
  const ctx = refContextAt(line, line.length);
  assert.deepEqual(ctx.parentPath, ['users', '0']);
  assert.equal(ctx.partial, 'email-al');
});

test('only the last unclosed ${ counts — closed refs earlier in the line are ignored', () => {
  const line = '1. Open ${data.url} then type ${env.BA';
  const ctx = refContextAt(line, line.length);
  assert.equal(ctx.kind, 'path');
  assert.equal(ctx.namespace, 'env');
  assert.equal(ctx.partial, 'BA');
});

test('a cursor after the closing brace is not in a reference', () => {
  const line = '1. Open ${data.url}';
  assert.equal(refContextAt(line, line.length), null);
});

test('a line with no ${ offers nothing', () => {
  assert.equal(refContextAt('1. Click the login button.', 10), null);
});

test('text after the cursor is ignored — completion mid-reference works', () => {
  const line = '1. ${env.BASE_URL}';
  const ctx = refContextAt(line, '1. ${env.BASE'.length);
  assert.equal(ctx.kind, 'path');
  assert.equal(ctx.partial, 'BASE');
});

test('malformed bodies are not references (space inside, digit-first namespace)', () => {
  const a = '1. ${data .x';
  assert.equal(refContextAt(a, a.length), null);
  const b = '1. ${9data';
  assert.equal(refContextAt(b, b.length), null);
});

// ---------------------------------------------------------------------------
// inFrontmatter
// ---------------------------------------------------------------------------

test('inFrontmatter covers the span, delimiters included, and not the rest', () => {
  const text = ['---', 'type: skill', 'dataSources:', '---', '', '## Steps'].join('\n');
  // Delimiter lines classify as frontmatter too (runner-core classifyLines).
  // Immaterial to the provider: a `---` fence line can never contain `${`.
  assert.equal(inFrontmatter(text, 0), true);
  assert.equal(inFrontmatter(text, 1), true);
  assert.equal(inFrontmatter(text, 2), true);
  assert.equal(inFrontmatter(text, 3), true);
  assert.equal(inFrontmatter(text, 4), false);
  assert.equal(inFrontmatter(text, 5), false);
});

test('a file without frontmatter is never in frontmatter', () => {
  assert.equal(inFrontmatter('## Steps\n1. Go', 0), false);
});

// ---------------------------------------------------------------------------
// walkTree / resolveDataTree
// ---------------------------------------------------------------------------

const TREE = {
  users: {
    admin: { email: 'a@x.com', password: 'hunter2' },
    list: ['first', 'second'],
  },
  count: 3,
};

test('walkTree follows objects and array indices; misses are undefined', () => {
  assert.equal(walkTree(TREE, ['users', 'admin', 'email']), 'a@x.com');
  assert.equal(walkTree(TREE, ['users', 'list', '1']), 'second');
  assert.equal(walkTree(TREE, ['users', 'nope']), undefined);
  assert.equal(walkTree(TREE, ['users', 'list', '9']), undefined);
  assert.equal(walkTree(TREE, ['users', 'list', 'x']), undefined);
  assert.equal(walkTree(TREE, ['count', 'deeper']), undefined);
});

test('resolveDataTree substitutes $VAR leaves and keeps unset ones literal', () => {
  const resolved = resolveDataTree(
    { pw: '$ADMIN_PW', keep: '$NOT_SET', plain: 'x', nest: { v: '$admin_pw' } },
    { ADMIN_PW: 'secret!', admin_pw: 'low' },
  );
  assert.deepEqual(resolved, {
    pw: 'secret!',
    keep: '$NOT_SET',
    plain: 'x',
    nest: { v: 'low' },
  });
});

// ---------------------------------------------------------------------------
// treeCompletions
// ---------------------------------------------------------------------------

test('object nodes offer their keys in author order, shaped by kind', () => {
  const items = treeCompletions(TREE, [], 'data');
  assert.deepEqual(
    items.map((i) => [i.label, i.kind]),
    [
      ['users', 'branch'],
      ['count', 'leaf'],
    ],
  );
  assert.equal(items[0].detail, '{2 keys}');
  assert.equal(items[1].detail, '3');
  // Author order, not alphabetical.
  assert.ok(items[0].sortText < items[1].sortText);
});

test('array nodes offer their indices', () => {
  const items = treeCompletions(TREE, ['users', 'list'], 'data');
  assert.deepEqual(
    items.map((i) => [i.label, i.detail]),
    [
      ['0', 'first'],
      ['1', 'second'],
    ],
  );
});

test('leaves and misses offer nothing further', () => {
  assert.deepEqual(treeCompletions(TREE, ['count'], 'data'), []);
  assert.deepEqual(treeCompletions(TREE, ['no', 'such'], 'data'), []);
});

test('keys the reference grammar cannot express are not offered', () => {
  // `${data.user.name}` would walk `user` → miss, and a key with a space or
  // `@` falls outside the runtime path class entirely — offering them
  // authors references the run can never resolve.
  const tree = {
    'user.name': 'paul',
    'has space': 'x',
    'alice@example.com': 'y',
    plain: 'ok',
  };
  const items = treeCompletions(tree, [], 'data');
  assert.deepEqual(
    items.map((i) => i.label),
    ['plain'],
  );
});

test('secret-named leaves are masked in the preview', () => {
  const items = treeCompletions(TREE, ['users', 'admin'], 'data');
  const password = items.find((i) => i.label === 'password');
  assert.equal(password.detail, '*******'); // hunter2 → 7 stars, never the value
  const email = items.find((i) => i.label === 'email');
  assert.equal(email.detail, 'a@x.com');
});

test('a secret-named ancestor masks everything beneath it', () => {
  const tree = { passwords: { admin: 'hunter2' } };
  const items = treeCompletions(tree, ['passwords'], 'data');
  assert.equal(items[0].detail, '*******');
});

test('bare *Key names mask — the runtime isSecretName rule, not maskIfSecret', () => {
  // The runtime redacts anything matching /password|secret|token|key/i from
  // recordings and reports; the dropdown must not show what a report hides.
  const tree = { privateKey: 'BEGIN RSA PRIVATE', api: { url: 'http://x' } };
  const items = treeCompletions(tree, [], 'data');
  const key = items.find((i) => i.label === 'privateKey');
  assert.equal(key.detail, '********');
  // A secret-named SOURCE taints its whole tree, so the namespace matters.
  const bySource = treeCompletions({ admin: 'hunter2' }, [], 'passwords');
  assert.equal(bySource[0].detail, '*******');
});

test('long previews truncate; newlines flatten', () => {
  const tree = { big: 'x'.repeat(80), lines: 'a\nb' };
  const items = treeCompletions(tree, [], 'data');
  assert.ok(items[0].detail.endsWith('…'));
  assert.ok(items[0].detail.length < 60);
  assert.equal(items[1].detail, 'a␤b');
});

test('null / boolean leaves preview like the runtime stringifies them', () => {
  const items = treeCompletions({ n: null, b: false }, [], 'data');
  assert.equal(items[0].detail, '');
  assert.equal(items[1].detail, 'false');
});

// ---------------------------------------------------------------------------
// envVarCompletions
// ---------------------------------------------------------------------------

test('env vars sort alphabetically and secret names are masked', () => {
  const items = envVarCompletions({
    SB_PASSWORD: 'pw12345678',
    BASE_URL: 'http://x',
    MACHINE_KEY: 'mk-123456789',
  });
  assert.deepEqual(
    items.map((i) => i.label),
    ['BASE_URL', 'MACHINE_KEY', 'SB_PASSWORD'],
  );
  assert.equal(items[0].detail, 'http://x');
  // Bare *_KEY masks — the runtime's isSecretName rule.
  assert.equal(items[1].detail, '********');
  assert.equal(items[2].detail, '********'); // capped at 8 stars
});

// ---------------------------------------------------------------------------
// namespaceCompletions
// ---------------------------------------------------------------------------

const FULL = {
  envName: 'local',
  dataDetail: 'fixtures/data/local.json',
  sources: [{ name: 'catalog', detail: '../data/demo-catalog.json' }],
  envDetail: '.env + .env.local',
};

test('a test with an active env offers data, sources, env, and envName', () => {
  const items = namespaceCompletions(FULL);
  assert.deepEqual(
    items.map((i) => i.label),
    ['data', 'catalog', 'env', 'envName'],
  );
  const data = items[0];
  assert.equal(data.insertText, 'data.');
  assert.equal(data.chain, true);
  assert.equal(data.detail, 'fixtures/data/local.json');
  // envName completes without a dot — it is the one no-dot token.
  assert.equal(items[3].insertText, undefined);
  assert.equal(items[3].detail, 'local');
});

test('null dataDetail suppresses data — how the wiring handles skills', () => {
  const items = namespaceCompletions({ ...FULL, dataDetail: null });
  assert.deepEqual(
    items.map((i) => i.label),
    ['catalog', 'env', 'envName'],
  );
});

test('path position (skill dataSources path) restricts to env + envName', () => {
  const items = namespaceCompletions({ ...FULL, pathPosition: true });
  assert.deepEqual(
    items.map((i) => i.label),
    ['env', 'envName'],
  );
});

// ---------------------------------------------------------------------------
// paramContextAt — where the cursor is inside a `{{...` runtime reference
// ---------------------------------------------------------------------------

test('right after {{ is a param position with an empty partial', () => {
  const line = '3. Verify {{';
  assert.deepEqual(paramContextAt(line, line.length), {
    partial: '',
    replaceStart: line.length,
  });
});

test('a name being typed carries the partial and its start column', () => {
  const line = '1. Sign in as {{us';
  assert.deepEqual(paramContextAt(line, line.length), {
    partial: 'us',
    replaceStart: line.length - 2,
  });
});

test('only the last unclosed {{ counts — a closed one earlier in the line is ignored', () => {
  const line = '1. Sign in as {{username}} with {{pa';
  assert.deepEqual(paramContextAt(line, line.length), {
    partial: 'pa',
    replaceStart: line.length - 2,
  });
});

test('a cursor after the closing }} is not in a reference', () => {
  const line = '1. Sign in as {{username}}';
  assert.equal(paramContextAt(line, line.length), null);
});

test('a line with no {{ offers nothing — one brace is not an opener', () => {
  assert.equal(paramContextAt('1. Click the login button.', 12), null);
  const single = '1. Type {';
  assert.equal(paramContextAt(single, single.length), null);
});

test('${{ is a param context — the runtime resolves the {{name}} inside it', () => {
  // The `${` parse rejects `${{` (`{` is not a namespace character), so the
  // inner `{{` wins here, which is also what the runtime resolves.
  const line = '1. Go to ${{base';
  assert.equal(refContextAt(line, line.length), null);
  assert.deepEqual(paramContextAt(line, line.length), {
    partial: 'base',
    replaceStart: line.length - 4,
  });
});

test('a partial the {{}} grammar cannot hold is not a context', () => {
  // `\{\{(\w+)\}\}` admits neither the space nor the hyphen.
  const spaced = '1. Sign in as {{ user';
  assert.equal(paramContextAt(spaced, spaced.length), null);
  const hyphen = '1. Sign in as {{order-id';
  assert.equal(paramContextAt(hyphen, hyphen.length), null);
});

// ---------------------------------------------------------------------------
// captureNamesBefore — the names earlier steps write
// ---------------------------------------------------------------------------

/** Every capture form, plus markers outside the Steps span that must not
 *  count. Comments carry the 1-based line, which is what CaptureName does. */
const CAPTURES = [
  '---', //                                                     1
  'env: local', //                                              2
  'note: [output: fm_ignored]', //                              3
  '---', //                                                     4
  '', //                                                        5
  'Prose mentioning [store as: prose_ignored].', //              6
  '', //                                                        7
  '## Steps', //                                                8
  '', //                                                        9
  '1. [input: username] Enter the account name', //             10
  '2. Read the shown balance [output: balance]', //             11
  '3. Copy the confirmation [as: code]', //                     12
  '4. Grab the reference [store as: order_id]', //              13
  '5. Capture the total and store it as {{total}}', //          14
  '6. [skill: login out.token="session" out.k="not a name"]', // 15
  '7. Verify {{', //                                            16
  '8. Sign out [store as: too_late]', //                        17
].join('\n');

test('every capture form an earlier step can write is offered, in source order', () => {
  // Cursor on step 7 — 1-based line 16, so 0-based 15.
  assert.deepEqual(
    captureNamesBefore(CAPTURES, 15).map((c) => [c.name, c.marker, c.line]),
    [
      ['username', 'input', 10],
      ['balance', 'output', 11],
      ['code', 'as', 12],
      ['order_id', 'as', 13],
      ['total', 'as', 14],
      ['session', 'out-alias', 15],
    ],
  );
});

test('an out-alias {{}} cannot express is not offered', () => {
  // `out.k="not a name"` is a real capture the run performs; it just has no
  // `{{...}}` form, so completing it would author an unresolvable reference.
  const names = captureNamesBefore(CAPTURES, 15).map((c) => c.name);
  assert.ok(names.includes('session'));
  assert.ok(!names.includes('not a name'));
});

test('captures on the cursor line and below are not offered', () => {
  // On step 1's own line nothing has been captured yet — at run time the
  // step's own `{{x}}` is interpolated before the step writes anything.
  assert.deepEqual(captureNamesBefore(CAPTURES, 9), []);
  assert.deepEqual(
    captureNamesBefore(CAPTURES, 10).map((c) => c.name),
    ['username'],
  );
  assert.ok(!captureNamesBefore(CAPTURES, 15).some((c) => c.name === 'too_late'));
});

test('markers outside the Steps span are not captures', () => {
  const names = captureNamesBefore(CAPTURES, 16).map((c) => c.name);
  assert.ok(!names.includes('fm_ignored')); // frontmatter
  assert.ok(!names.includes('prose_ignored')); // prose above ## Steps
});

test('prose storage names a capture; loose prose names nothing', () => {
  const doc = [
    '## Steps', //                                            1
    '1. Note the order number for later', //                  2
    '2. Capture the balance and store it as {{balance}}', //   3
    '3. Read the fee and save as {{fee}}', //                 4
    '4. Verify {{', //                                        5
  ].join('\n');
  // Step 1 captures something at run time, but the name is invented mid-run —
  // there is nothing to offer until an author writes `store as {{name}}`.
  assert.deepEqual(
    captureNamesBefore(doc, 4).map((c) => [c.name, c.marker, c.line]),
    [
      ['balance', 'as', 3],
      ['fee', 'as', 4],
    ],
  );
});

test('a name captured twice lists once, at its first write', () => {
  const doc = [
    '## Steps', //                              1
    '1. Read the total [output: total]', //     2
    '2. Re-read it [store as: total]', //       3
    '3. Verify {{', //                          4
  ].join('\n');
  assert.deepEqual(
    captureNamesBefore(doc, 3).map((c) => [c.name, c.marker, c.line]),
    [['total', 'output', 2]],
  );
});

test('section body steps write captures too (the section-step kind counts)', () => {
  const doc = [
    '## Steps', //                          1
    '1. Sign in', //                        2
    '', //                                  3
    '### Sign in', //                       4
    '1. Enter the code [as: otp]', //       5
    '2. Verify {{', //                      6
  ].join('\n');
  assert.deepEqual(
    captureNamesBefore(doc, 5).map((c) => [c.name, c.line]),
    [['otp', 5]],
  );
});

// ---------------------------------------------------------------------------
// paramCompletions
// ---------------------------------------------------------------------------

test('parameters come first in declared order, then the captures', () => {
  const items = paramCompletions({ username: 'demo@securebank.com', region: 'eu' }, [
    { name: 'balance', marker: 'as', line: 9 },
    { name: 'otp', marker: 'input', line: 4 },
  ]);
  assert.deepEqual(
    items.map((i) => [i.label, i.kind]),
    [
      ['username', 'parameter'],
      ['region', 'parameter'],
      ['balance', 'capture'],
      ['otp', 'capture'],
    ],
  );
  // sortText is what VS Code actually orders on, so it has to agree.
  const sorted = [...items].sort((a, b) => a.sortText.localeCompare(b.sortText));
  assert.deepEqual(
    sorted.map((i) => i.label),
    items.map((i) => i.label),
  );
});

test('parameter previews are $VAR-resolved and masked by name', () => {
  // Composed the way the wiring does it: parseParameters values run through
  // runner-core's resolveValueFromEnv against the composed .env.
  const declared = {
    username: 'demo@securebank.com',
    password: '$SB_PASSWORD',
    MACHINE_KEY: '$AIUI_MACHINE_KEY',
    missing: '$NOT_SET',
  };
  const env = { SB_PASSWORD: 'sw0rdf1sh!', AIUI_MACHINE_KEY: 'mk-123456789' };
  const items = paramCompletions(
    Object.fromEntries(
      Object.entries(declared).map(([k, v]) => [k, resolveValueFromEnv(v, env)]),
    ),
    [],
  );
  const detail = Object.fromEntries(items.map((i) => [i.label, i.detail]));
  assert.equal(detail.username, 'demo@securebank.com');
  assert.equal(detail.password, '********'); // capped at 8 stars, never the value
  // Bare *_KEY masks — the runtime isSecretName rule, not maskIfSecret.
  assert.equal(detail.MACHINE_KEY, '********');
  // An unset $VAR previews as its own literal, exactly as the run substitutes.
  assert.equal(detail.missing, '$NOT_SET');
  assert.ok(!JSON.stringify(items).includes('sw0rdf1sh!'));
});

test('capture detail names the marker form and the line that writes it', () => {
  const items = paramCompletions({}, [
    { name: 'otp', marker: 'input', line: 4 },
    { name: 'balance', marker: 'output', line: 7 },
    { name: 'order_id', marker: 'as', line: 9 },
    { name: 'session', marker: 'out-alias', line: 12 },
  ]);
  assert.deepEqual(
    items.map((i) => i.detail),
    ['[input:] on line 4', '[output:] on line 7', '[as:] on line 9', '[out-alias:] on line 12'],
  );
  // No value preview — a capture has none until the run produces it.
  assert.ok(items.every((i) => i.insertText === undefined && i.chain === undefined));
});

test('a name that is both a parameter and a capture lists once, as the parameter', () => {
  const items = paramCompletions({ balance: '0.00' }, [
    { name: 'balance', marker: 'as', line: 9 },
    { name: 'otp', marker: 'input', line: 4 },
  ]);
  assert.deepEqual(
    items.map((i) => [i.label, i.kind, i.detail]),
    [
      ['balance', 'parameter', '0.00'],
      ['otp', 'capture', '[input:] on line 4'],
    ],
  );
});
