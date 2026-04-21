import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildStepMessage, contentBlocksToText, formatTestInfo } from '../src/ai/prompts.js';
import type { MessageContentBlock } from '../src/ai/types.js';

type Marker = { needle: string; cache: boolean; label: string };

const STABLE_MARKERS: Marker[] = [
  { needle: 'expert UI test automation agent', cache: true, label: 'rules+intro' },
  { needle: '## Application Context', cache: true, label: 'application context' },
  { needle: '## API Actions', cache: true, label: 'API actions' },
  { needle: '## Response Format', cache: true, label: 'response format' },
];

function findBlock(blocks: MessageContentBlock[], needle: string): MessageContentBlock | undefined {
  return blocks.find((b) => b.type === 'text' && b.text.includes(needle));
}

function assertCacheFlag(block: MessageContentBlock, expected: boolean, label: string) {
  const actual = 'cache' in block ? block.cache === true : false;
  expect(actual, `${label} should be ${expected ? 'cacheable' : 'uncached'}`).toBe(expected);
}

describe('prompt cache hints', () => {
  it('marks every stable system block as cacheable so the prefix never contains a volatile block', () => {
    const blocks = buildSystemPrompt(
      '### Context: app.md\n\nStable application notes',
      { hasApiContext: true, responseHistory: 'GET /api/foo → 200' },
    );

    for (const m of STABLE_MARKERS) {
      const block = findBlock(blocks, m.needle);
      expect(block, `expected to find block: ${m.label}`).toBeDefined();
      assertCacheFlag(block!, m.cache, m.label);
    }

    // Test Information must NOT appear in the system prompt — it's volatile and now lives in the user message
    expect(findBlock(blocks, '## Test Information')).toBeUndefined();

    // API Response History is volatile but sits at the tail, so it doesn't break the cacheable prefix
    const history = findBlock(blocks, '## API Response History');
    expect(history).toBeDefined();
    assertCacheFlag(history!, false, 'API response history');
    expect(blocks.at(-1)).toBe(history);
  });

  it('omits API blocks entirely when hasApiContext is false', () => {
    const blocks = buildSystemPrompt(
      '### Context: app.md\n\nStable application notes',
      { hasApiContext: false, responseHistory: '' },
    );

    expect(findBlock(blocks, '## API Actions')).toBeUndefined();
    expect(findBlock(blocks, '## API Response History')).toBeUndefined();
    expect(findBlock(blocks, '## Test Information')).toBeUndefined();

    const flat = contentBlocksToText(blocks);
    expect(flat).toContain('## Application Context');
    expect(flat).toContain('## Response Format');
  });

  it('omits the application context block when no context content is provided', () => {
    const blocks = buildSystemPrompt('');
    expect(findBlock(blocks, '## Application Context')).toBeUndefined();
    assertCacheFlag(findBlock(blocks, '## Response Format')!, true, 'response format');
  });
});

describe('formatTestInfo', () => {
  it('formats all provided fields', () => {
    const out = formatTestInfo('Login flow', 'https://example.com', 2, 5, { width: 1440, height: 900 });
    expect(out).toContain('## Test Information');
    expect(out).toContain('- Test: Login flow');
    expect(out).toContain('- Base URL: https://example.com');
    expect(out).toContain('- Current Step: 2 of 5');
    expect(out).toContain('- Viewport: 1440×900px');
  });

  it('drops empty lines when optional fields are absent', () => {
    const out = formatTestInfo('Login flow');
    expect(out).toBe('## Test Information\n- Test: Login flow');
  });
});

describe('buildStepMessage test info prepending', () => {
  it('prepends Test Information at the top of the user message text', () => {
    const testInfo = formatTestInfo('Login flow', 'https://example.com', 1, 1);
    const msg = buildStepMessage('Click login', '<html></html>', null, [], undefined, undefined, testInfo);

    expect(typeof msg.content).toBe('string');
    const text = msg.content as string;
    expect(text.startsWith('## Test Information')).toBe(true);
    expect(text.indexOf('## Test Information')).toBeLessThan(text.indexOf('## Current Step'));
  });

  it('omits the Test Information block when no testInfoSection is provided', () => {
    const msg = buildStepMessage('Click login', '<html></html>', null, []);
    expect(msg.content).not.toContain('## Test Information');
  });
});
