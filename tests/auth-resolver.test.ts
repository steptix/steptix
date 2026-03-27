import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveAuth,
  shouldUseBrowserContext,
  parseApiType,
  extractApiTypeFromContext,
} from '../src/api/auth-resolver.js';

describe('parseApiType', () => {
  it('parses front-proxy variations', () => {
    expect(parseApiType('Front Proxy')).toBe('front-proxy');
    expect(parseApiType('front-proxy')).toBe('front-proxy');
    expect(parseApiType('frontproxy')).toBe('front-proxy');
    expect(parseApiType('FRONT PROXY')).toBe('front-proxy');
  });

  it('parses experience API', () => {
    expect(parseApiType('experience')).toBe('experience');
    expect(parseApiType('Experience API')).toBe('experience');
  });

  it('parses private API', () => {
    expect(parseApiType('Private')).toBe('private');
    expect(parseApiType('private-api')).toBe('private');
    expect(parseApiType('Private API')).toBe('private');
  });

  it('parses serverless API', () => {
    expect(parseApiType('serverless')).toBe('serverless');
    expect(parseApiType('Serverless API')).toBe('serverless');
  });

  it('parses public API', () => {
    expect(parseApiType('public')).toBe('public');
    expect(parseApiType('Public API')).toBe('public');
  });

  it('defaults to public for unknown types', () => {
    expect(parseApiType('unknown-type')).toBe('public');
  });
});

describe('shouldUseBrowserContext', () => {
  it('returns true for front-proxy', () => {
    expect(shouldUseBrowserContext('front-proxy')).toBe(true);
  });

  it('returns true for experience', () => {
    expect(shouldUseBrowserContext('experience')).toBe(true);
  });

  it('returns false for private', () => {
    expect(shouldUseBrowserContext('private')).toBe(false);
  });

  it('returns false for serverless', () => {
    expect(shouldUseBrowserContext('serverless')).toBe(false);
  });

  it('returns false for public', () => {
    expect(shouldUseBrowserContext('public')).toBe(false);
  });
});

describe('extractApiTypeFromContext', () => {
  it('extracts type from context text', () => {
    const context = '# API\n\n- Type: Front Proxy\n- Base URL: https://example.com';
    expect(extractApiTypeFromContext(context)).toBe('front-proxy');
  });

  it('returns undefined when no Type field', () => {
    const context = '# API\n\n- Base URL: https://example.com';
    expect(extractApiTypeFromContext(context)).toBeUndefined();
  });
});

describe('resolveAuth', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore environment
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('returns empty headers for front-proxy (cookies are automatic)', () => {
    const auth = resolveAuth({ type: 'front-proxy' });
    expect(auth.headers).toEqual({});
  });

  it('returns empty headers for experience API', () => {
    const auth = resolveAuth({ type: 'experience' });
    expect(auth.headers).toEqual({});
  });

  it('adds x-api-key for private API when env var matches', () => {
    process.env['NOTIFICATIONS_API_KEY'] = 'test-key-value';
    const auth = resolveAuth({
      type: 'private',
      authDescription: '- x-api-key header from $NOTIFICATIONS_API_KEY',
    });
    expect(auth.headers['x-api-key']).toBe('test-key-value');
  });

  it('returns empty headers for private API when no key found', () => {
    // Ensure no API_KEY env vars are set
    for (const key of Object.keys(process.env)) {
      if (key.includes('API_KEY') || key.includes('_KEY')) {
        delete process.env[key];
      }
    }
    const auth = resolveAuth({
      type: 'private',
      authDescription: 'x-api-key from $SOME_MISSING_KEY',
    });
    expect(auth.headers['x-api-key']).toBeUndefined();
  });

  it('adds Bearer token for serverless API when bearerToken is provided', () => {
    const auth = resolveAuth({
      type: 'serverless',
      bearerToken: 'my-jwt-token',
    });
    expect(auth.headers['authorization']).toBe('Bearer my-jwt-token');
  });

  it('returns empty headers for public API', () => {
    const auth = resolveAuth({ type: 'public' });
    expect(auth.headers).toEqual({});
  });
});
