import { describe, it, expect } from 'vitest';
import { summarizeSpec, extractSpecUrlsFromContext } from '../src/api/spec-loader.js';

describe('summarizeSpec', () => {
  it('returns a string for a valid OpenAPI spec', () => {
    const spec = {
      info: { title: 'Test API', version: '1.0' },
      paths: {
        '/users': {
          get: { summary: 'List users' },
          post: { summary: 'Create user' },
        },
        '/users/{id}': {
          get: { operationId: 'getUser' },
          delete: { summary: 'Delete user' },
        },
      },
    };

    const result = summarizeSpec(spec);
    expect(result).toContain('Test API');
    expect(result).toContain('GET /users');
    expect(result).toContain('List users');
    expect(result).toContain('POST /users');
    expect(result).toContain('Create user');
    expect(result).toContain('GET /users/{id}');
    expect(result).toContain('DELETE /users/{id}');
  });

  it('includes version in header', () => {
    const spec = { info: { title: 'My API', version: '2.1' }, paths: {} };
    const result = summarizeSpec(spec);
    expect(result).toContain('v2.1');
  });

  it('handles spec with no paths', () => {
    const spec = { info: { title: 'Empty API', version: '1.0' } };
    const result = summarizeSpec(spec);
    expect(result).toContain('Empty API');
  });

  it('handles invalid spec gracefully', () => {
    expect(summarizeSpec(null)).toBe('Invalid spec');
    expect(summarizeSpec('not an object')).toBe('Invalid spec');
    expect(summarizeSpec(42)).toBe('Invalid spec');
  });

  it('uses operationId as fallback when no summary', () => {
    const spec = {
      info: { title: 'API', version: '1' },
      paths: {
        '/items': {
          get: { operationId: 'listItems' },
        },
      },
    };
    const result = summarizeSpec(spec);
    expect(result).toContain('listItems');
  });
});

describe('extractSpecUrlsFromContext', () => {
  it('extracts spec URLs from context content', () => {
    const content = `
# Delegates API
- Spec URL: https://api.example.com/delegates/swagger.json
- Base URL: https://api.example.com

# Notifications API
- Spec URL: https://api.example.com/notifications/swagger.json
`;
    const urls = extractSpecUrlsFromContext(content);
    expect(urls).toHaveLength(2);
    expect(urls).toContain('https://api.example.com/delegates/swagger.json');
    expect(urls).toContain('https://api.example.com/notifications/swagger.json');
  });

  it('deduplicates URLs that appear multiple times', () => {
    const content = `
Spec URL: https://api.example.com/swagger.json
Spec URL: https://api.example.com/swagger.json
`;
    const urls = extractSpecUrlsFromContext(content);
    expect(urls).toHaveLength(1);
  });

  it('returns empty array when no spec URLs found', () => {
    const content = 'No spec URLs here';
    expect(extractSpecUrlsFromContext(content)).toHaveLength(0);
  });

  it('handles case-insensitive matching', () => {
    const content = 'SPEC URL: https://api.example.com/swagger.json';
    const urls = extractSpecUrlsFromContext(content);
    expect(urls).toHaveLength(1);
  });

  it('extracts env-var-based spec URLs', () => {
    const content = 'Spec URL: $DELEGATES_SPEC_URL';
    const urls = extractSpecUrlsFromContext(content);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('$DELEGATES_SPEC_URL');
  });
});
