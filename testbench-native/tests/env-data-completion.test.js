/**
 * Core logic of `${env.X}` / `${data.X.Y}` / `${<source>.X}` completion —
 * cursor-context parsing, tree walking, `$VAR` leaf resolution, and item
 * generation with secret masking. The vscode wiring (file loading, item
 * mapping) lives in env-data-completion.ts and is not under test here.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  envVarCompletions,
  inFrontmatter,
  namespaceCompletions,
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
