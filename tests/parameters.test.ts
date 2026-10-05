import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveParameters, interpolate } from '../src/parser/parameters.js';

describe('interpolate', () => {
  it('substitutes a single placeholder', () => {
    expect(interpolate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('substitutes multiple placeholders', () => {
    expect(
      interpolate('Sign in as {{email}} with {{password}}', {
        email: 'user@example.com',
        password: 'secret',
      }),
    ).toBe('Sign in as user@example.com with secret');
  });

  it('leaves unresolved placeholders intact', () => {
    expect(interpolate('Hello {{name}}', {})).toBe('Hello {{name}}');
  });

  it('handles repeated placeholders', () => {
    expect(interpolate('{{x}} and {{x}}', { x: 'foo' })).toBe('foo and foo');
  });

  it('returns the string unchanged when no placeholders', () => {
    expect(interpolate('No placeholders here', { foo: 'bar' })).toBe('No placeholders here');
  });

  it('handles empty string', () => {
    expect(interpolate('', { foo: 'bar' })).toBe('');
  });

  it('substitutes a key with underscores, and leaves a hyphenated one literal', () => {
    expect(interpolate('{{foo_bar}} value', { foo_bar: '42' })).toBe('42 value');
    // Not a reference at all, so not looked up — even when the map holds it.
    expect(interpolate('{{order-id}} value', { 'order-id': '42' })).toBe('{{order-id}} value');
  });
});

describe('resolveParameters', () => {
  beforeEach(() => {
    // Clean slate for each test
    Object.keys(process.env).forEach((k) => {
      if (k.startsWith('TEST_PARAM_')) delete process.env[k];
    });
  });

  afterEach(() => {
    // Remove what the test set
    Object.keys(process.env).forEach((k) => {
      if (k.startsWith('TEST_PARAM_')) delete process.env[k];
    });
  });

  it('returns inline values directly', async () => {
    const params = { email: 'user@example.com', name: 'Alice' };
    const resolved = await resolveParameters(params, undefined, false);
    expect(resolved['email']).toBe('user@example.com');
    expect(resolved['name']).toBe('Alice');
  });

  it('resolves environment variable references', async () => {
    process.env['TEST_PARAM_EMAIL'] = 'env@example.com';
    const params = { email: '$TEST_PARAM_EMAIL' };
    const resolved = await resolveParameters(params, undefined, false);
    expect(resolved['email']).toBe('env@example.com');
  });

  it('data row overrides inline value', async () => {
    const params = { email: 'inline@example.com' };
    const dataRow = { email: 'row@example.com' };
    const resolved = await resolveParameters(params, dataRow, false);
    expect(resolved['email']).toBe('row@example.com');
  });

  it('data row overrides env var', async () => {
    process.env['TEST_PARAM_EMAIL'] = 'env@example.com';
    const params = { email: '$TEST_PARAM_EMAIL' };
    const dataRow = { email: 'row@example.com' };
    const resolved = await resolveParameters(params, dataRow, false);
    expect(resolved['email']).toBe('row@example.com');
  });

  it('merges additional data row keys not in params', async () => {
    const params = { email: 'user@example.com' };
    const dataRow = { email: 'row@example.com', role: 'admin' };
    const resolved = await resolveParameters(params, dataRow, false);
    expect(resolved['role']).toBe('admin');
  });

  it('returns empty string for unresolvable param when promptUser=false', async () => {
    const params = { missing: '$NONEXISTENT_VAR_XYZ' };
    const resolved = await resolveParameters(params, undefined, false);
    expect(resolved['missing']).toBe('');
  });

  it('handles empty params object', async () => {
    const resolved = await resolveParameters({}, undefined, false);
    expect(resolved).toEqual({});
  });

  it('handles multiple params with mixed sources', async () => {
    process.env['TEST_PARAM_PASS'] = 'secret123';
    const params = {
      email: 'direct@example.com',
      password: '$TEST_PARAM_PASS',
    };
    const resolved = await resolveParameters(params, undefined, false);
    expect(resolved['email']).toBe('direct@example.com');
    expect(resolved['password']).toBe('secret123');
  });
});
