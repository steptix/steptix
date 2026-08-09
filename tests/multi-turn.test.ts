/**
 * Tests for multi-turn step execution:
 * - `count` action parsing
 * - `needs_reeval` field parsing
 * - continuation prompt generation
 * - multi-turn loop safeguards (cycle detection, iteration cap)
 * - turn badge tagging in AI interactions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { buildContinuationMessage } from '../src/ai/prompts.js';

// ─── Parser: needs_reeval ────────────────────────────────────────────────────

describe('parseAIResponse — needs_reeval', () => {
  it('parses needs_reeval: true', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'navigate', url: '/portfolio', description: 'Go to portfolio' }],
      reasoning: 'Need to navigate first.',
      needs_reeval: true,
    });
    const result = parseAIResponse(raw);
    expect(result.needs_reeval).toBe(true);
  });

  it('parses needs_reeval: false as undefined (absent)', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', description: 'Click' }],
      reasoning: 'Done.',
      needs_reeval: false,
    });
    const result = parseAIResponse(raw);
    expect(result.needs_reeval).toBeUndefined();
  });

  it('omits needs_reeval when not present', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', description: 'Click' }],
      reasoning: 'Done.',
    });
    const result = parseAIResponse(raw);
    expect(result.needs_reeval).toBeUndefined();
  });

  it('ignores truthy non-boolean needs_reeval values', () => {
    // Only strict `true` should be treated as needs_reeval
    const raw = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', description: 'Click' }],
      reasoning: 'Done.',
      needs_reeval: 1,
    });
    const result = parseAIResponse(raw);
    // 1 !== true, so needs_reeval should not be set
    expect(result.needs_reeval).toBeUndefined();
  });

  it('parses needs_reeval alongside other fields', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'navigate', url: '/accounts', description: 'Navigate to accounts' },
      ],
      reasoning: 'Need to see the accounts page before counting.',
      needs_reeval: true,
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('navigate');
    expect(result.reasoning).toContain('accounts page');
    expect(result.needs_reeval).toBe(true);
  });
});

// ─── Parser: count action ────────────────────────────────────────────────────

describe('parseAIResponse — count action', () => {
  it('parses a count action with selector and as', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'count', selector: '.account-row', as: 'account_count', description: 'Count account rows' },
      ],
      reasoning: 'Counting the rows.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('count');
    expect(result.actions[0]?.selector).toBe('.account-row');
    expect(result.actions[0]?.as).toBe('account_count');
  });

  it('count action without as is still valid', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'count', selector: 'li.item', description: 'Count items' },
      ],
      reasoning: 'Just counting.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('count');
    expect(result.actions[0]?.as).toBeUndefined();
  });

  it('count can appear alongside needs_reeval: false', () => {
    const raw = JSON.stringify({
      actions: [
        { action: 'count', selector: '.account-row', as: 'account_count', description: 'Count account rows' },
      ],
      reasoning: 'Final turn.',
      needs_reeval: false,
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.action).toBe('count');
    expect(result.needs_reeval).toBeUndefined();
  });
});

// ─── Continuation prompt ─────────────────────────────────────────────────────

describe('buildContinuationMessage', () => {
  it('includes the original instruction', () => {
    const msg = buildContinuationMessage(
      'check how many accounts this user has',
      [{ action: 'navigate', description: 'Navigate to /portfolio' }],
      {},
      'https://app.example.com/portfolio',
      '<html>...</html>',
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : msg.content[0]?.type === 'text' ? msg.content[0].text : '';
    expect(text).toContain('check how many accounts this user has');
  });

  it('lists completed actions', () => {
    const msg = buildContinuationMessage(
      'check accounts',
      [
        { action: 'navigate', description: 'Navigate to /portfolio' },
        { action: 'wait', description: 'Wait for .portfolio-content' },
      ],
      {},
      'https://app.example.com/portfolio',
      '<html>...</html>',
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('Navigate to /portfolio');
    expect(text).toContain('Wait for .portfolio-content');
  });

  it('shows (none) when no actions completed', () => {
    const msg = buildContinuationMessage(
      'check accounts',
      [],
      {},
      'https://app.example.com/',
      '<html></html>',
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('(none)');
  });

  it('includes captured variables', () => {
    const msg = buildContinuationMessage(
      'check balance',
      [{ action: 'read', description: 'Read balance' }],
      { account_balance: '$1,234.56' },
      'https://app.example.com/',
      '<html></html>',
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('account_balance');
    expect(text).toContain('$1,234.56');
  });

  it('shows (none) for variables when none captured', () => {
    const msg = buildContinuationMessage(
      'check balance',
      [{ action: 'navigate', description: 'Navigate' }],
      {},
      'https://app.example.com/',
      '<html></html>',
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    // Should show (none) for variables
    const variableSection = text.split('Variables captured so far:')[1];
    expect(variableSection).toBeDefined();
    expect(variableSection!.trim().startsWith('(none)')).toBe(true);
  });

  it('includes the current URL', () => {
    const url = 'https://app.example.com/portfolio/123';
    const msg = buildContinuationMessage(
      'check accounts',
      [],
      {},
      url,
      '<html></html>',
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain(url);
  });

  it('includes the DOM snapshot', () => {
    const dom = '<html><body><div class="account-row"></div></body></html>';
    const msg = buildContinuationMessage(
      'check accounts',
      [],
      {},
      'https://app.example.com/',
      dom,
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('account-row');
  });

  it('attaches screenshot when provided', () => {
    const msg = buildContinuationMessage(
      'check accounts',
      [],
      {},
      'https://app.example.com/',
      '<html></html>',
      'base64datahere',
      2,
    );
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<{ type: string; image_url?: { url: string } }>;
    const imageBlock = blocks.find((b) => b.type === 'image_url');
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.image_url?.url).toContain('base64datahere');
  });

  it('uses text-only content when screenshot is null', () => {
    const msg = buildContinuationMessage(
      'check accounts',
      [],
      {},
      'https://app.example.com/',
      '<html></html>',
      null,
      2,
    );
    expect(typeof msg.content).toBe('string');
  });

  it('includes turn range in the actions header', () => {
    const msg = buildContinuationMessage(
      'check accounts',
      [{ action: 'navigate', description: 'Navigate' }],
      {},
      'https://app.example.com/',
      '<html></html>',
      null,
      3,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    // Turn 3 continuation should reference turns 1-2
    expect(text).toContain('1–2');
  });

  it('has user role', () => {
    const msg = buildContinuationMessage('x', [], {}, 'http://x', '<html/>', null, 2);
    expect(msg.role).toBe('user');
  });
});

// ─── tagAiResponses logic (tested via step-executor behaviour) ───────────────
// These tests validate the turn-tagging semantics directly without a full
// Page/browser context.  We re-implement the helper logic inline to keep the
// tests self-contained.

describe('turn badge tagging semantics', () => {
  /** Mirrors the tagAiResponses helper in step-executor.ts */
  function tagAiResponses(
    buffer: Array<{ interaction: { purpose: string; attemptNumber?: number }; turn: number }>,
    isMultiTurn: boolean,
  ) {
    return buffer.map(({ interaction, turn }) =>
      isMultiTurn ? { ...interaction, turnNumber: turn } : interaction,
    );
  }

  it('single-turn: no turnNumber on interactions', () => {
    const buffer = [
      { interaction: { purpose: 'action-plan', attemptNumber: 1 }, turn: 1 },
    ];
    const result = tagAiResponses(buffer, false);
    expect(result[0]).not.toHaveProperty('turnNumber');
  });

  it('multi-turn: all interactions get turnNumber', () => {
    const buffer = [
      { interaction: { purpose: 'action-plan', attemptNumber: 1 }, turn: 1 },
      { interaction: { purpose: 'action-plan', attemptNumber: 1 }, turn: 2 },
    ];
    const result = tagAiResponses(buffer, true);
    expect(result[0]).toHaveProperty('turnNumber', 1);
    expect(result[1]).toHaveProperty('turnNumber', 2);
  });

  it('assertion interaction on last turn gets correct turnNumber', () => {
    const buffer = [
      { interaction: { purpose: 'action-plan', attemptNumber: 1 }, turn: 1 },
      { interaction: { purpose: 'action-plan', attemptNumber: 1 }, turn: 2 },
      { interaction: { purpose: 'assertion', attemptNumber: 1 }, turn: 2 },
    ];
    const result = tagAiResponses(buffer, true);
    expect(result[2]).toHaveProperty('turnNumber', 2);
    expect(result[2]).toHaveProperty('purpose', 'assertion');
  });

  it('preserves existing fields when tagging', () => {
    const buffer = [
      { interaction: { purpose: 'action-plan', attemptNumber: 2 }, turn: 1 },
    ];
    const result = tagAiResponses(buffer, true);
    expect(result[0]).toHaveProperty('purpose', 'action-plan');
    expect(result[0]).toHaveProperty('attemptNumber', 2);
    expect(result[0]).toHaveProperty('turnNumber', 1);
  });
});

// ─── Cycle detection logic ────────────────────────────────────────────────────

describe('cycle detection logic', () => {
  /** Mirrors the cycle detection condition in step-executor.ts */
  function wouldDetectCycle(urlHistory: string[], currentUrl: string): boolean {
    return urlHistory.length >= 2 && currentUrl === urlHistory[urlHistory.length - 2];
  }

  it('no detection on first turn (empty history)', () => {
    expect(wouldDetectCycle([], 'https://app.example.com/')).toBe(false);
  });

  it('no detection on second turn (history has 1 entry)', () => {
    expect(wouldDetectCycle(['https://app.example.com/'], 'https://app.example.com/portfolio')).toBe(false);
  });

  it('detects cycle on third turn when URL matches turn 1', () => {
    const history = ['https://app.example.com/', 'https://app.example.com/portfolio'];
    expect(wouldDetectCycle(history, 'https://app.example.com/')).toBe(true);
  });

  it('no false positive when turn 3 URL is different from turn 1', () => {
    const history = ['https://app.example.com/', 'https://app.example.com/portfolio'];
    expect(wouldDetectCycle(history, 'https://app.example.com/accounts')).toBe(false);
  });

  it('detects cycle on turn 4 when URL matches turn 2', () => {
    const history = [
      'https://app.example.com/',
      'https://app.example.com/portfolio',
      'https://app.example.com/accounts',
    ];
    expect(wouldDetectCycle(history, 'https://app.example.com/portfolio')).toBe(true);
  });

  it('no cycle when all URLs are distinct', () => {
    const history = [
      'https://app.example.com/',
      'https://app.example.com/portfolio',
      'https://app.example.com/accounts',
    ];
    expect(wouldDetectCycle(history, 'https://app.example.com/transactions')).toBe(false);
  });
});

// ─── Continuation prompt: exploration results ───────────────────────────────

describe('buildContinuationMessage — exploration results', () => {
  it('includes exploration results when provided', () => {
    const msg = buildContinuationMessage(
      'find order ORD-789 and click Delete',
      [{ action: 'find', description: 'Search for ORD-789' }],
      {},
      'https://app.example.com/orders',
      '<html>...</html>',
      null,
      2,
      undefined,
      ['### find "ORD-789"\nFound 1 match:\n1. <td> "ORD-789" selector: td'],
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('Exploration Results');
    expect(text).toContain('find "ORD-789"');
    expect(text).toContain('Found 1 match');
  });

  it('omits exploration section when no results', () => {
    const msg = buildContinuationMessage(
      'click the button',
      [{ action: 'click', description: 'Click submit' }],
      {},
      'https://app.example.com/',
      '<html>...</html>',
      null,
      2,
    );
    const text = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
    expect(text).not.toContain('Exploration Results');
  });
});

// ─── Format helpers ─────────────────────────────────────────────────────────

import { formatFindResults, formatExpandResult } from '../src/browser/dom-cleaner.js';

describe('formatFindResults', () => {
  it('formats matches with selectors', () => {
    const result = formatFindResults({
      matches: [
        { selector: '#order-789', tag: 'td', text: 'ORD-789', attributes: 'id="order-789"', context: 'table > tbody > tr' },
      ],
      totalMatches: 1,
      hitHardMax: false,
    }, 'ORD-789');
    expect(result).toContain('find "ORD-789"');
    expect(result).toContain('Found 1 match');
    expect(result).toContain('#order-789');
  });

  it('handles no matches', () => {
    const result = formatFindResults({ matches: [], totalMatches: 0, hitHardMax: false }, 'nonexistent');
    expect(result).toContain('No matches found');
  });

  it('signals truncation when total exceeds shown', () => {
    const matches = Array.from({ length: 50 }, (_, i) => ({
      selector: `#row-${i}`,
      tag: 'tr',
      text: `row ${i}`,
      attributes: '',
      context: '',
    }));
    const result = formatFindResults({ matches, totalMatches: 247, hitHardMax: false }, 'row');
    expect(result).toContain('Found 50 of 247 matches');
    expect(result).toContain('Refine the query');
  });

  it('signals hard-max with a + suffix', () => {
    const matches = Array.from({ length: 50 }, (_, i) => ({
      selector: `#row-${i}`,
      tag: 'tr',
      text: `row ${i}`,
      attributes: '',
      context: '',
    }));
    const result = formatFindResults({ matches, totalMatches: 500, hitHardMax: true }, 'row');
    expect(result).toContain('500+');
  });

  it('reports container errors', () => {
    const result = formatFindResults(
      { matches: [], totalMatches: 0, hitHardMax: false, containerError: 'No element matches container selector: "#nope"' },
      'foo',
      '#nope',
    );
    expect(result).toContain('No element matches container selector');
    expect(result).toContain('(in #nope)');
  });

  it('includes container in header when scoped', () => {
    const result = formatFindResults(
      { matches: [{ selector: '#x', tag: 'td', text: 'foo', attributes: '', context: '' }], totalMatches: 1, hitHardMax: false },
      'foo',
      '#orders',
    );
    expect(result).toContain('find "foo" (in #orders)');
  });
});

describe('formatExpandResult', () => {
  it('wraps content in code block with selector', () => {
    const result = formatExpandResult('<table>...</table>', 'table#orders');
    expect(result).toContain('expand "table#orders"');
    expect(result).toContain('```html');
    expect(result).toContain('<table>...</table>');
  });
});

// ─── Integration: step-executor with mocked AI client ────────────────────────

import type { Page } from 'playwright';
import type { Config } from '../src/config/types.js';
import type { AiClient } from '../src/ai/client.js';
import { DEFAULT_BROWSER_DIMENSIONS } from '../src/config/browser-dimensions.js';
import { executeStep } from '../src/runner/step-executor.js';

/** Build a minimal Config for testing */
function makeConfig(maxTurns = 5): Config {
  return {
    ai: { gatewayUrl: '', model: 'test', maxInputTokens: 1000, streamResponses: false },
    browser: {
      headed: false,
      viewport: { ...DEFAULT_BROWSER_DIMENSIONS },
      windowSize: { ...DEFAULT_BROWSER_DIMENSIONS },
      slowMo: 0,
      browser: 'chromium',
      fullPageScreenshots: true,
    },
    tests: { dir: '.', contextDir: '.', pattern: '**/*.md' },
    execution: {
      timeout: 30000,
      retries: 0,
      screenshotOnFailure: false,
      promptOnAmbiguity: false,
      maxTurns,

    },
    reports: {
      outputDir: '.',
      includeScreenshots: false,
      includeDomSnapshots: false,
      includeAiReasoning: false,
      embedScreenshots: true,
    },
    api: { specsDir: '.', requestTimeout: 5000, redactSensitive: false },
  };
}

/** Build a mock Page that returns a fixed URL and empty DOM */
function makeMockPage(urlOrFn: string | (() => string) = 'https://app.example.com'): Page {
  // Allow tests to inject a URL factory so each call returns a different value
  const urlFn = typeof urlOrFn === 'function' ? urlOrFn : () => urlOrFn;

  // Build a chainable locator mock with all the action methods used by executeAction
  const mockLocator: Record<string, unknown> = {};
  mockLocator['locator'] = vi.fn().mockReturnValue(mockLocator);
  mockLocator['first'] = vi.fn().mockReturnValue(mockLocator);
  mockLocator['count'] = vi.fn().mockResolvedValue(3);
  mockLocator['isVisible'] = vi.fn().mockResolvedValue(false);
  mockLocator['click'] = vi.fn().mockResolvedValue(undefined);
  mockLocator['fill'] = vi.fn().mockResolvedValue(undefined);
  mockLocator['clear'] = vi.fn().mockResolvedValue(undefined);
  mockLocator['selectOption'] = vi.fn().mockResolvedValue(undefined);
  mockLocator['hover'] = vi.fn().mockResolvedValue(undefined);
  mockLocator['setInputFiles'] = vi.fn().mockResolvedValue(undefined);

  return {
    url: vi.fn().mockImplementation(urlFn),
    content: vi.fn().mockResolvedValue('<html><body></body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fakepng')),
    viewportSize: vi.fn().mockReturnValue({ ...DEFAULT_BROWSER_DIMENSIONS }),
    locator: vi.fn().mockReturnValue(mockLocator),
    $eval: vi.fn().mockResolvedValue(''),
    evaluate: vi.fn().mockResolvedValue(null),
    waitForSelector: vi.fn().mockResolvedValue(null),
    waitForURL: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(null),
    waitForFunction: vi.fn().mockResolvedValue(null),
    waitForTimeout: vi.fn().mockResolvedValue(null),
    goto: vi.fn().mockResolvedValue(null),
    mouse: { wheel: vi.fn().mockResolvedValue(null) },
    keyboard: { press: vi.fn().mockResolvedValue(null) },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Page;
}

/** Build a mock AiClient whose complete() cycles through the given responses */
function makeAiClient(responses: string[]): AiClient {
  let callCount = 0;
  return {
    complete: vi.fn().mockImplementation(() => {
      const response = responses[callCount % responses.length];
      callCount++;
      return Promise.resolve({ text: response, model: 'test-model' });
    }),
  } as unknown as AiClient;
}

describe('executeStep — multi-turn integration', () => {
  it('single-turn step: no turnNumber on AI responses', async () => {
    const page = makeMockPage();
    const aiResponse = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', description: 'Click' }],
      reasoning: 'Click the button.',
      needs_reeval: false,
    });
    const aiClient = makeAiClient([aiResponse]);

    // Plain action instruction — the AI returns a click and no assert
    const result = await executeStep(1, 1, 'click the submit button', {
      page,
      config: makeConfig(),
      aiClient,
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
    });

    expect(result.status).toBe('passed');
    // Single-turn step should have exactly one turn
    expect(result.turns.length).toBe(1);
    expect(result.turns[0]!.turnNumber).toBe(1);
  });

  it('two-turn step: interactions tagged with turn numbers', async () => {
    // Use a URL factory: turn 1 = /home, turn 2 = /portfolio (distinct — no cycle possible)
    let urlCallCount = 0;
    const turnUrls = ['https://app.example.com/', 'https://app.example.com/portfolio'];
    const page = makeMockPage(() => turnUrls[Math.min(urlCallCount++, turnUrls.length - 1)] ?? turnUrls[0]!);

    // Turn 1: navigate, requests reeval
    const turn1 = JSON.stringify({
      actions: [{ action: 'navigate', url: '/portfolio', description: 'Navigate to portfolio' }],
      reasoning: 'Need to navigate first.',
      needs_reeval: true,
    });
    // Turn 2: count, completes step (not an assertion step)
    const turn2 = JSON.stringify({
      actions: [{ action: 'count', selector: '.account-row', as: 'account_count', description: 'Count account rows' }],
      reasoning: 'Counting rows.',
      needs_reeval: false,
    });

    const aiClient = makeAiClient([turn1, turn2]);
    const resolvedParameters: Record<string, string> = {};

    // Use a non-assertion instruction so the assertion evaluator is NOT invoked
    const result = await executeStep(1, 1, 'navigate to portfolio and count accounts', {
      page,
      config: makeConfig(),
      aiClient,
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters,
    });

    expect(result.status).toBe('passed');

    // Multi-turn step should have two turns
    expect(result.turns.length).toBe(2);
    expect(result.turns[0]!.turnNumber).toBe(1);
    expect(result.turns[1]!.turnNumber).toBe(2);
    expect(result.turns[0]!.aiInteractions.length).toBeGreaterThanOrEqual(1);
    expect(result.turns[1]!.aiInteractions.length).toBeGreaterThanOrEqual(1);
  });

  it('multi-turn: count result stored in resolvedParameters', async () => {
    // Use distinct URLs to avoid cycle detection
    let urlCallCount = 0;
    const turnUrls = ['https://app.example.com/', 'https://app.example.com/portfolio'];
    const page = makeMockPage(() => turnUrls[Math.min(urlCallCount++, turnUrls.length - 1)] ?? turnUrls[0]!);
    // page.locator().count() returns 3 via the mock

    const turn1 = JSON.stringify({
      actions: [{ action: 'navigate', url: '/portfolio', description: 'Navigate' }],
      reasoning: 'Navigate first.',
      needs_reeval: true,
    });
    const turn2 = JSON.stringify({
      actions: [{ action: 'count', selector: '.account-row', as: 'account_count', description: 'Count rows' }],
      reasoning: 'Count.',
      needs_reeval: false,
    });

    const aiClient = makeAiClient([turn1, turn2]);
    const resolvedParameters: Record<string, string> = {};

    // Non-assertion instruction so assertion evaluator is NOT invoked
    const result = await executeStep(1, 1, 'navigate to portfolio and count accounts', {
      page,
      config: makeConfig(),
      aiClient,
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters,
    });

    // The count action should have run even if the step result varies
    expect(resolvedParameters['account_count']).toBe('3');
    expect(result.status).toBe('passed');
  });

  it('fails when multi-turn limit is reached', async () => {
    // Use 3 distinct URLs so cycle detection never fires (only same URL 2-turns-ago triggers it)
    const distinctUrls = [
      'https://app.example.com/page1',
      'https://app.example.com/page2',
      'https://app.example.com/page3',
    ];
    let urlIdx = 0;
    const page = makeMockPage(() => distinctUrls[urlIdx++ % distinctUrls.length] ?? distinctUrls[0]!);

    // AI always returns needs_reeval: true — will hit the cap
    const infiniteReeval = JSON.stringify({
      actions: [{ action: 'navigate', url: '/foo', description: 'Navigate' }],
      reasoning: 'Need more.',
      needs_reeval: true,
    });

    const aiClient = makeAiClient([infiniteReeval]);

    const result = await executeStep(1, 1, 'do something multi-page', {
      page,
      config: makeConfig(3), // maxTurns = 3
      aiClient,
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('multi-turn limit reached');
    expect(result.error).toContain('3 turns');
  });

});

// ─── switchPage / openPage bring the tab forward (cdp-tab-focus.md §4) ───────

import { PageTracker } from '../src/browser/manager.js';
import type { BrowserSession, BrowserTracker } from '../src/browser/manager.js';

/**
 * A page that records `bringToFront` calls and reports a fixed url/title, so
 * `PageTracker.switchToAsync` can find it by either.
 */
function makeSwitchablePage(url: string, title: string) {
  const page = makeMockPage(url) as unknown as Record<string, unknown>;
  page['title'] = vi.fn().mockResolvedValue(title);
  page['bringToFront'] = vi.fn().mockResolvedValue(undefined);
  page['context'] = vi.fn().mockReturnValue({ newPage: vi.fn() });
  return page as unknown as Page & { bringToFront: ReturnType<typeof vi.fn> };
}

/** A tracker holding one session whose `headed` is whatever the test needs.
 *  Mirrors what `launchBrowser` records per browser — `openBrowser` can
 *  override `headed`, so the gate reads the session, not the shared config. */
function trackerWith(session: Partial<BrowserSession>): BrowserTracker {
  return {
    getActive: () => session as BrowserSession,
    // Single-browser shape: `count <= 1` is what keeps the prompt's
    // multi-browser block empty, so `list()` is never reached.
    count: 1,
    list: () => [],
  } as unknown as BrowserTracker;
}

describe('executeStep — a switched-to tab is brought to the front (§4)', () => {
  const SWITCH_RESPONSE = JSON.stringify({
    actions: [{ action: 'switchPage', page: 'cart', description: 'Switch to the cart tab' }],
    reasoning: 'The step names another tab.',
    needs_reeval: false,
  });

  /** Two tracked pages; the second is the one `switchPage: "cart"` resolves to. */
  function twoTabs() {
    const main = makeSwitchablePage('https://shop.example/', 'Shop');
    const cart = makeSwitchablePage('https://shop.example/cart', 'Cart');
    const pageTracker = new PageTracker(main);
    pageTracker.addPage(cart);
    return { main, cart, pageTracker };
  }

  it('raises the tab in a HEADED launch-mode run', async () => {
    // Launch mode, not CDP — `headed` defaults to true, a launch-mode run's
    // pages open as tabs in one visible window, and a human watching has the
    // identical complaint. This is the assertion that would silently regress
    // into CDP-only.
    const { cart, pageTracker } = twoTabs();
    const config = makeConfig();
    config.browser.headed = true;

    const result = await executeStep(1, 1, 'switch to the cart tab', {
      page: pageTracker.getActive(),
      config,
      aiClient: makeAiClient([SWITCH_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
    });

    expect(result.status).toBe('passed');
    expect(cart.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('does not bother in a headless run', async () => {
    const { cart, pageTracker } = twoTabs();
    const config = makeConfig();
    config.browser.headed = false;

    await executeStep(1, 1, 'switch to the cart tab', {
      page: pageTracker.getActive(),
      config,
      aiClient: makeAiClient([SWITCH_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
    });

    expect(cart.bringToFront).not.toHaveBeenCalled();
  });

  it('reads headedness off the ACTIVE browser, not the shared config', async () => {
    // `openBrowser` can override `headed` per browser, so one run can hold a
    // headed browser and a headless one at once. Reading the global config
    // would raise a window for a browser that has none, or skip the raise for
    // the one the user is actually watching.
    const { cart, pageTracker } = twoTabs();
    const config = makeConfig();
    config.browser.headed = false; // global says headless…

    await executeStep(1, 1, 'switch to the cart tab', {
      page: pageTracker.getActive(),
      config,
      aiClient: makeAiClient([SWITCH_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
      // …but the browser this step is driving is headed.
      browserTracker: trackerWith({ headed: true }),
    });

    expect(cart.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('a browser that refuses to raise its window does not fail the step', async () => {
    // Windows can decline a foreground request from a background process. A
    // step that otherwise worked must not fail on it.
    const { cart, pageTracker } = twoTabs();
    const config = makeConfig();
    config.browser.headed = true;
    (cart.bringToFront as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not permitted'));

    const result = await executeStep(1, 1, 'switch to the cart tab', {
      page: pageTracker.getActive(),
      config,
      aiClient: makeAiClient([SWITCH_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
    });

    expect(result.status).toBe('passed');
    expect(cart.bringToFront).toHaveBeenCalled();
  });
});
