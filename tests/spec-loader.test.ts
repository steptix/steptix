import { describe, it, expect } from 'vitest';
import { extractSpecUrlsFromContext } from '../src/api/spec-loader.js';

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
