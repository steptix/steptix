import { describe, it, expect } from 'vitest';
import { parseTestContent } from '../src/parser/markdown.js';

describe('parseTestContent', () => {
  it('extracts H1 title', () => {
    const md = `# My Test\n\n## Steps\n- Do something\n`;
    const result = parseTestContent(md);
    expect(result.title).toBe('My Test');
  });

  it('falls back to filename when no H1', () => {
    const md = `## Steps\n- Click button\n`;
    const result = parseTestContent(md, '/tests/my-test.md');
    expect(result.title).toBe('my-test');
  });

  it('parses frontmatter tags', () => {
    const md = `---\ntags: [smoke, regression]\n---\n\n# Test\n\n## Steps\n- Step 1\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.tags).toEqual(['smoke', 'regression']);
  });

  it('parses frontmatter timeout', () => {
    const md = `---\ntimeout: 2m\ntags: []\n---\n\n# Test\n\n## Steps\n- Step 1\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.timeout).toBe('2m');
  });

  it('parses frontmatter dataFile', () => {
    const md = `---\ntags: []\ndataFile: ./data/users.json\n---\n\n# Test\n\n## Steps\n- Login\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.dataFile).toBe('./data/users.json');
  });

  it('parses ## Config section key-value pairs', () => {
    const md = `# Test\n\n## Config\n- baseUrl: http://localhost:3000\n- timeout: 30s\n\n## Steps\n- Visit home\n`;
    const result = parseTestContent(md);
    expect(result.config.baseUrl).toBe('http://localhost:3000');
    expect(result.config.timeout).toBe('30s');
  });

  it('parses ## Config section cdp port shorthand', () => {
    const md = `# Test\n\n## Config\n- baseUrl: http://localhost:3000\n- cdp: 9222\n\n## Steps\n- Visit home\n`;
    const result = parseTestContent(md);
    expect(result.config.cdp).toBe('9222');
    expect(result.config.cdpTab).toBeUndefined();
  });

  it('parses ## Config section cdpTab variants', () => {
    const md = `# Test\n\n## Config\n- cdp: 9222\n- cdpTab: url~example.com\n\n## Steps\n- Visit home\n`;
    const result = parseTestContent(md);
    expect(result.config.cdp).toBe('9222');
    expect(result.config.cdpTab).toBe('url~example.com');
  });

  it('parses ## Parameters section', () => {
    const md = `# Test\n\n## Parameters\n- email: user@example.com\n- password: $TEST_PASS\n\n## Steps\n- Login\n`;
    const result = parseTestContent(md);
    expect(result.parameters['email']).toBe('user@example.com');
    expect(result.parameters['password']).toBe('$TEST_PASS');
  });

  it('parses ## Steps as ordered list', () => {
    const md = `# Test\n\n## Steps\n1. Click Login button\n2. Enter credentials\n3. Assert dashboard visible\n`;
    const result = parseTestContent(md);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]).toBe('Click Login button');
    expect(result.steps[1]).toBe('Enter credentials');
    expect(result.steps[2]).toBe('Assert dashboard visible');
  });

  it('parses ## Steps as unordered list', () => {
    const md = `# Test\n\n## Steps\n- Click button\n- Check result\n`;
    const result = parseTestContent(md);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toBe('Click button');
  });

  it('returns empty steps array when no ## Steps section', () => {
    const md = `# Test\n\nSome text here\n`;
    const result = parseTestContent(md);
    expect(result.steps).toEqual([]);
  });

  it('returns empty tags array when no frontmatter', () => {
    const md = `# Test\n\n## Steps\n- Do thing\n`;
    const result = parseTestContent(md);
    expect(result.frontmatter.tags).toEqual([]);
  });

  it('parses all sections together', () => {
    const md = `---
tags: [smoke]
timeout: 60s
---

# Full Test

## Config
- baseUrl: https://example.com

## Parameters
- username: admin
- password: $ADMIN_PASS

## Steps
1. Go to login page
2. Enter credentials
3. Submit form
4. Assert user is logged in
`;
    const result = parseTestContent(md, '/tests/full.md');
    expect(result.title).toBe('Full Test');
    expect(result.frontmatter.tags).toEqual(['smoke']);
    expect(result.frontmatter.timeout).toBe('60s');
    expect(result.config.baseUrl).toBe('https://example.com');
    expect(result.parameters['username']).toBe('admin');
    expect(result.parameters['password']).toBe('$ADMIN_PASS');
    expect(result.steps).toHaveLength(4);
    expect(result.filePath).toBe('/tests/full.md');
  });

  it('ignores unrecognised level-2 headings', () => {
    const md = `# Test\n\n## Notes\n- This is a note\n\n## Steps\n- Real step\n`;
    const result = parseTestContent(md);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toBe('Real step');
  });

  it('handles colon in parameter value', () => {
    const md = `# Test\n\n## Parameters\n- url: http://localhost:8080/path\n\n## Steps\n- Go\n`;
    const result = parseTestContent(md);
    expect(result.parameters['url']).toBe('http://localhost:8080/path');
  });
});
