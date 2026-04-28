import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseConfig,
  parseParameters,
  parseSection,
  resolveSection,
  resolveValueFromEnv,
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

test('resolveSection: missing $VARs left untouched', () => {
  const got = resolveSection({ k: '$MISSING' }, {});
  assert.deepEqual(got, { k: '$MISSING' });
});
