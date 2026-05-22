import { describe, it, expect } from 'vitest';
import { parseToolRef } from '../src/tools/registry.js';

describe('parseToolRef', () => {
  it('treats a lone segment as sugar (file basename == tool name)', () => {
    expect(parseToolRef('check_health')).toEqual({ file: 'check_health', tool: 'check_health' });
    expect(parseToolRef('my-cool-tool')).toEqual({ file: 'my-cool-tool', tool: 'my-cool-tool' });
  });

  it('splits the last segment as the tool, the rest as the file path', () => {
    expect(parseToolRef('auth/login')).toEqual({ file: 'auth', tool: 'login' });
    expect(parseToolRef('auth/login/login')).toEqual({ file: 'auth/login', tool: 'login' });
    expect(parseToolRef('a/b/c/run')).toEqual({ file: 'a/b/c', tool: 'run' });
  });

  it('rejects empty path segments', () => {
    expect(() => parseToolRef('auth//login')).toThrow(/empty path segment/);
    expect(() => parseToolRef('/login')).toThrow(/empty path segment/);
    expect(() => parseToolRef('auth/')).toThrow(/empty path segment/);
  });
});
