import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseEnvFile, parseBoolEnv } from '../src/env/loader.js';

describe('parseEnvFile', () => {
  it('parses simple key=value pairs', () => {
    const result = parseEnvFile('FOO=bar\nBAZ=qux');
    expect(result['FOO']).toBe('bar');
    expect(result['BAZ']).toBe('qux');
  });

  it('ignores blank lines', () => {
    const result = parseEnvFile('\nFOO=bar\n\nBAZ=qux\n');
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('ignores comment lines', () => {
    const result = parseEnvFile('# This is a comment\nFOO=bar');
    expect(result['FOO']).toBe('bar');
    expect(result['#']).toBeUndefined();
  });

  it('strips double-quoted values', () => {
    const result = parseEnvFile('FOO="hello world"');
    expect(result['FOO']).toBe('hello world');
  });

  it('strips single-quoted values', () => {
    const result = parseEnvFile("FOO='hello world'");
    expect(result['FOO']).toBe('hello world');
  });

  it('preserves values with equals signs', () => {
    const result = parseEnvFile('DATABASE_URL=postgres://user:pass@host/db?key=value');
    expect(result['DATABASE_URL']).toBe('postgres://user:pass@host/db?key=value');
  });

  it('trims whitespace around keys', () => {
    const result = parseEnvFile('  FOO  =bar');
    expect(result['FOO']).toBe('bar');
  });

  it('handles empty values', () => {
    const result = parseEnvFile('EMPTY=');
    expect(result['EMPTY']).toBe('');
  });

  it('skips lines without an equals sign', () => {
    const result = parseEnvFile('NOEQUALS\nFOO=bar');
    expect(result['NOEQUALS']).toBeUndefined();
    expect(result['FOO']).toBe('bar');
  });
});

describe('parseBoolEnv', () => {
  it.each(['true', 'TRUE', '1', 'yes', 'Yes', 'on', 'ON'])('treats %s as true', (value) => {
    expect(parseBoolEnv(value)).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'No', 'off', 'OFF'])('treats %s as false', (value) => {
    expect(parseBoolEnv(value)).toBe(false);
  });

  it('returns undefined for unset or unparseable values', () => {
    expect(parseBoolEnv(undefined)).toBeUndefined();
    expect(parseBoolEnv('')).toBeUndefined();
    expect(parseBoolEnv('maybe')).toBeUndefined();
    expect(parseBoolEnv('2')).toBeUndefined();
  });
});
