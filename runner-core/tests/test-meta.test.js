import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseConfig,
  parseParameters,
  parseSection,
  resolveSection,
  resolveValueFromEnv,
  scanSectionItems,
} from '../dist/test-meta.js';

test('parseConfig: reads `- key: value` items under ## Config', () => {
  const text = [
    '## Config',
    '- baseUrl: https://github.com/',
    '- timeout: 30s',
    '',
    '## Steps',
    '1. open',
  ].join('\n');
  assert.deepEqual(parseConfig(text), {
    baseUrl: 'https://github.com/',
    timeout: '30s',
  });
});

test('parseParameters: reads `- key: value` items under ## Parameters', () => {
  const text = [
    '## Parameters',
    '- username: $GITHUB_USERNAME',
    '- password: $GITHUB_PASSWORD',
  ].join('\n');
  assert.deepEqual(parseParameters(text), {
    username: '$GITHUB_USERNAME',
    password: '$GITHUB_PASSWORD',
  });
});

test('parseSection: returns empty when section is absent', () => {
  assert.deepEqual(parseConfig('## Steps\n1. only this'), {});
});

test('parseSection: case-insensitive heading match', () => {
  const text = ['## CONFIG', '- foo: bar'].join('\n');
  assert.deepEqual(parseConfig(text), { foo: 'bar' });
});

test('parseSection: stops at next same-or-shallower heading', () => {
  const text = [
    '## Config',
    '- baseUrl: https://example.com',
    '## Parameters',
    '- user: alice',
  ].join('\n');
  assert.deepEqual(parseConfig(text), { baseUrl: 'https://example.com' });
});

test('parseSection: deeper headings inside the section do not end it', () => {
  const text = [
    '## Config',
    '- baseUrl: https://example.com',
    '### Notes',
    '- timeout: 5s',
  ].join('\n');
  assert.deepEqual(parseConfig(text), {
    baseUrl: 'https://example.com',
    timeout: '5s',
  });
});

test('parseSection: ignores lines that are not `- key: value`', () => {
  const text = [
    '## Config',
    'Some prose',
    '- baseUrl: https://example.com',
    'Not a list item',
  ].join('\n');
  assert.deepEqual(parseConfig(text), { baseUrl: 'https://example.com' });
});

test('parseSection: trims whitespace around values', () => {
  const text = ['## Config', '-   baseUrl:    https://example.com   '].join('\n');
  assert.deepEqual(parseConfig(text), { baseUrl: 'https://example.com' });
});

test('parseSection: works for arbitrary section names', () => {
  const text = ['## Custom', '- foo: bar'].join('\n');
  assert.deepEqual(parseSection(text, 'Custom'), { foo: 'bar' });
});

// ---------------------------------------------------------------------------
// resolveValueFromEnv / resolveSection
// ---------------------------------------------------------------------------

test('resolveValueFromEnv: $VAR resolves to env value', () => {
  assert.equal(resolveValueFromEnv('$NAME', { NAME: 'alice' }), 'alice');
});

test('resolveValueFromEnv: literal value passes through', () => {
  assert.equal(resolveValueFromEnv('plain text', {}), 'plain text');
});

test('resolveValueFromEnv: missing $VAR returns the literal $VAR (not empty)', () => {
  assert.equal(resolveValueFromEnv('$MISSING', {}), '$MISSING');
});

test('resolveValueFromEnv: $ in the middle is not a var reference', () => {
  assert.equal(resolveValueFromEnv('a$b', { b: 'X' }), 'a$b');
});

test('resolveSection: resolves every value', () => {
  const env = { GITHUB_USERNAME: 'alice', GITHUB_PASSWORD: 'hunter2' };
  const got = resolveSection(
    { username: '$GITHUB_USERNAME', password: '$GITHUB_PASSWORD', literal: 'plain' },
    env,
  );
  assert.deepEqual(got, {
    username: 'alice',
    password: 'hunter2',
    literal: 'plain',
  });
});

// ---------------------------------------------------------------------------
// scanSectionItems — the same scan parseSection builds its map from, with
// source positions, so an editor can navigate to a bullet without restating
// the grammar.
// ---------------------------------------------------------------------------

test('scanSectionItems: locates each key token, indentation included', () => {
  const text = ['# Title', '## Parameters', '- username: demo', '  - password: $PW'].join('\n');
  assert.deepEqual(scanSectionItems(text, 'Parameters'), [
    { key: 'username', value: 'demo', line: 2, column: 2, length: 8 },
    { key: 'password', value: '$PW', line: 3, column: 4, length: 8 },
  ]);
});

test('scanSectionItems: stops at the next same-or-shallower heading', () => {
  const text = ['## Parameters', '- a: 1', '## Steps', '- b: 2'].join('\n');
  assert.deepEqual(scanSectionItems(text, 'Parameters').map((i) => i.key), ['a']);
});

test('scanSectionItems: keeps duplicates in order; parseSection takes the last', () => {
  const text = ['## Parameters', '- user: first', '- user: second'].join('\n');
  assert.deepEqual(scanSectionItems(text, 'Parameters').map((i) => [i.key, i.value, i.line]), [
    ['user', 'first', 1],
    ['user', 'second', 2],
  ]);
  assert.deepEqual(parseSection(text, 'Parameters'), { user: 'second' });
});

test('scanSectionItems: only the FIRST matching section is read', () => {
  const text = ['## Parameters', '- a: 1', '## Steps', '## Parameters', '- b: 2'].join('\n');
  assert.deepEqual(scanSectionItems(text, 'Parameters').map((i) => i.key), ['a']);
});

test('scanSectionItems: heading match is case-insensitive at any ##+ depth', () => {
  const text = ['### parameters', '- key_name: v'].join('\n');
  assert.deepEqual(scanSectionItems(text, 'Parameters').map((i) => i.key), ['key_name']);
});

test('scanSectionItems: absent section yields nothing', () => {
  assert.deepEqual(scanSectionItems('# Title\n', 'Parameters'), []);
});
