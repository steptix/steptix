/**
 * A test's own `## Context` (docs/specs/SPEC-web-survey-fixes.md §2.46): free
 * text the author gives the AI for every step of that test — what the app
 * does, what to expect, and any selectors or frame ids to use. Parsed twice,
 * by the full parser (CLI, MCP) and by runner-core's line reader (the VS Code
 * extension, which reads an unsaved buffer), so the two are held to the same
 * answer here.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseTestContent } from '../src/parser/markdown.js';
import { parseContext } from '../runner-core/src/test-meta.js';
import { withTestContext } from '../src/context/test-context.js';

const file = path.resolve(path.sep, 'proj', 'tests', 'checkout.md');

const DOCS: Record<string, string> = {
  'selectors, a frame id and a subheading': [
    '# Checkout',
    '',
    '## Context',
    'The payment form is inside the iframe `#card-frame`; type the card number into `[data-test=card]`.',
    '',
    '- The page may show ads. Close any that cover what you need.',
    '',
    '### After paying',
    'The receipt opens in a new tab.',
    '',
    '## Steps',
    '1. Click "Buy"',
  ].join('\n'),
  'a fenced block whose lines look like headings': [
    '# Checkout',
    '',
    '## Context',
    'The grid renders rows like this:',
    '',
    '```html',
    '## not a heading',
    '<tr id="row-1">',
    '```',
    '',
    '## Steps',
    '1. Click "Buy"',
  ].join('\n'),
  'context after the steps, at the end of the file': [
    '# Checkout',
    '',
    '## Steps',
    '1. Click "Buy"',
    '',
    '## Context',
    'Prices are in euros.',
  ].join('\n'),
};

describe('## Context in a test file', () => {
  it('keeps the section as written, selectors and frame ids included', () => {
    const parsed = parseTestContent(DOCS['selectors, a frame id and a subheading']!, file);
    expect(parsed.context).toContain('iframe `#card-frame`');
    expect(parsed.context).toContain('`[data-test=card]`');
    expect(parsed.context).toContain('Close any that cover what you need.');
    expect(parsed.context).toContain('### After paying');
    expect(parsed.context).toContain('The receipt opens in a new tab.');
    expect(parsed.context).not.toContain('Click "Buy"');
  });

  it('leaves the steps exactly as they were', () => {
    const withContext = parseTestContent(DOCS['selectors, a frame id and a subheading']!, file);
    expect(withContext.steps).toEqual(['Click "Buy"']);
  });

  it('is absent when the file has no ## Context', () => {
    const parsed = parseTestContent('# T\n\n## Steps\n1. Click "Buy"\n', file);
    expect(parsed.context).toBeUndefined();
    expect(parseContext('# T\n\n## Steps\n1. Click "Buy"\n')).toBeUndefined();
  });

  it('is absent when the section is empty', () => {
    const doc = '# T\n\n## Context\n\n## Steps\n1. Click "Buy"\n';
    expect(parseTestContent(doc, file).context).toBeUndefined();
    expect(parseContext(doc)).toBeUndefined();
  });

  for (const [name, doc] of Object.entries(DOCS)) {
    it(`reads the same in the extension's parser: ${name}`, () => {
      expect(parseContext(doc)).toBe(parseTestContent(doc, file).context);
    });
  }
});

describe('the context the AI is given', () => {
  it("puts the test's context after the project's and says whose it is", () => {
    const combined = withTestContext('### Context: app.md\n\nThe app is a shop.', 'Use `#card-frame`.');
    expect(combined.indexOf('The app is a shop.')).toBeLessThan(combined.indexOf('Use `#card-frame`.'));
    expect(combined).toMatch(/### Context: this test \(from the test file's ## Context/);
  });

  it('is the project context alone when the test has none', () => {
    expect(withTestContext('project', undefined)).toBe('project');
    expect(withTestContext('project', '   ')).toBe('project');
  });

  it("is the test's context alone when the project has none", () => {
    expect(withTestContext('', 'Use `#card-frame`.')).toMatch(/^### Context: this test[^\n]*\n\nUse `#card-frame`\.$/);
  });
});
