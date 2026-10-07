/**
 * Tests for multi-turn step execution:
 * - `count` action parsing
 * - `needs_reeval` field parsing
 * - continuation prompt generation
 * - turn numbering and the iteration cap, through the real executeStep
 * - a switched-to or opened tab brought to the front (cdp-tab-focus.md §4)
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
function makeMockPage(url = 'https://app.example.com'): Page {
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
    url: vi.fn().mockReturnValue(url),
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
  it('single-turn step produces exactly one turn', async () => {
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

  it('two-turn step: each turn is numbered and carries its own AI interaction', async () => {
    const page = makeMockPage();

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
    // page.locator().count() returns 3 via the mock
    const page = makeMockPage();

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
    const page = makeMockPage();

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

// ─── A bare action object with no needs_reeval ───────────────────────────────
//
// Measured in a live run: "Upload file \attachments\statement.pdf as the
// statement, then click Upload" was answered with a bare upload object and no
// needs_reeval, and the step passed without ever clicking Upload. A bare action
// that changed the page gets one more look; anything else ends the step as
// before.

describe('executeStep — a bare action that leaves needs_reeval unstated', () => {
  function run(responses: object[], instruction: string, maxTurns = 5) {
    const page = makeMockPage();
    const aiClient = makeAiClient(responses.map((r) => JSON.stringify(r)));
    const result = executeStep(1, 1, instruction, {
      page,
      config: makeConfig(maxTurns),
      aiClient,
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
    });
    return { page, aiClient, result };
  }

  const actionsOf = (turns: Awaited<ReturnType<typeof executeStep>>['turns']) =>
    turns.map((t) => t.subActions.map((s) => s.action.action));

  it('re-evaluates after a bare mutating action, so the rest of the step still runs', async () => {
    const { page, aiClient, result } = run(
      [
        { action: 'type', selector: '#name', value: 'Ada', description: 'Enter the name' },
        { actions: [{ action: 'click', selector: '#save', description: 'Click Save' }], reasoning: 'r', needs_reeval: false },
      ],
      'enter Ada as the name, then click Save',
    );
    const step = await result;

    expect(step.status).toBe('passed');
    expect(actionsOf(step.turns)).toEqual([['type'], ['click']]);
    expect(aiClient.complete).toHaveBeenCalledTimes(2);
    expect(page.locator('#save').click).toHaveBeenCalled();
  });

  it('ends a finished step on the noop the extra turn answers with', async () => {
    const { aiClient, result } = run(
      [
        { action: 'click', selector: '#save', description: 'Click Save' },
        { action: 'noop', description: 'Save was clicked; nothing left to do' },
      ],
      'click Save',
    );
    const step = await result;

    expect(step.status).toBe('passed');
    expect(step.turns).toHaveLength(2);
    expect(aiClient.complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['noop', { action: 'noop', description: 'Already on the page' }],
    ['count', { action: 'count', selector: '.row', as: 'rows', description: 'Count rows' }],
    // A wait settles the page rather than leaving the step half done, and a
    // second bare wait on an idle page would trip stall detection.
    ['wait', { action: 'wait', waitType: 'selector', condition: '#ready', description: 'Wait for ready' }],
  ])('a bare %s stays terminal', async (_label, response) => {
    const { aiClient, result } = run([response], 'count the rows if there are any');
    const step = await result;

    expect(step.status).toBe('passed');
    expect(step.turns).toHaveLength(1);
    expect(aiClient.complete).toHaveBeenCalledTimes(1);
  });

  it('a bare mutating action that says needs_reeval: false is taken at its word', async () => {
    const { aiClient, result } = run(
      [{ action: 'click', selector: '#save', description: 'Click Save', needs_reeval: false }],
      'click Save',
    );
    const step = await result;

    expect(step.status).toBe('passed');
    expect(step.turns).toHaveLength(1);
    expect(aiClient.complete).toHaveBeenCalledTimes(1);
  });

  it('a wrapped mutating action that omits needs_reeval still ends the step (rule 15)', async () => {
    const { aiClient, result } = run(
      [{ actions: [{ action: 'click', selector: '#save', description: 'Click Save' }], reasoning: 'r' }],
      'click Save',
    );
    const step = await result;

    expect(step.status).toBe('passed');
    expect(step.turns).toHaveLength(1);
    expect(aiClient.complete).toHaveBeenCalledTimes(1);
  });

  // A model that answers bare once tends to answer bare again. Re-evaluating
  // every time would click a wizard's Next until the turn cap.
  it('re-evaluates at most once per step', async () => {
    const { page, aiClient, result } = run(
      [{ action: 'click', selector: '#next', description: 'Click Next' }],
      'click Next',
    );
    const step = await result;

    expect(step.status).toBe('passed');
    expect(step.turns).toHaveLength(2);
    expect(aiClient.complete).toHaveBeenCalledTimes(2);
    expect(page.locator('#next').click).toHaveBeenCalledTimes(2);
  });

  it('does not fail on the turn cap: the model never asked for another turn', async () => {
    const { aiClient, result } = run(
      [{ action: 'click', selector: '#next', description: 'Click Next' }],
      'click Next',
      1,
    );
    const step = await result;

    expect(step.status).toBe('passed');
    expect(step.turns).toHaveLength(1);
    expect(aiClient.complete).toHaveBeenCalledTimes(1);
  });
});

// ─── switchPage / openPage bring the tab forward (cdp-tab-focus.md §4) ───────

import { PageTracker } from '../src/browser/manager.js';
import type { BrowserSession, BrowserTracker } from '../src/browser/manager.js';

/** A stand-in `BrowserContext`. Identity is all that matters — the gate finds
 *  a page's browser by comparing `page.context()` against each tracked
 *  session's `context`. */
function makeContext(opened: Page[] = []) {
  const context: Record<string, unknown> = {};
  context['newPage'] = vi.fn(async () => {
    const p = makeSwitchablePage('https://shop.example/new', 'New');
    (p as unknown as Record<string, unknown>)['context'] = () => context;
    opened.push(p);
    return p;
  });
  return context;
}

/**
 * A page that records `bringToFront` calls and reports a fixed url/title, so
 * `PageTracker.switchToAsync` can find it by either, and belongs to `context`
 * so the §4 gate can work out which browser it is part of.
 */
function makeSwitchablePage(url: string, title: string, context: object = {}) {
  const page = makeMockPage(url) as unknown as Record<string, unknown>;
  page['title'] = vi.fn().mockResolvedValue(title);
  page['bringToFront'] = vi.fn().mockResolvedValue(undefined);
  page['context'] = () => context;
  return page as unknown as Page & { bringToFront: ReturnType<typeof vi.fn> };
}

/**
 * A tracker holding real-ish sessions, each with its own context and its own
 * `headed`. Sessions are listed in creation order and the LAST one is active,
 * mirroring `BrowserTracker.add()`, which auto-promotes whatever `openBrowser`
 * opened most recently.
 */
function trackerOf(...sessions: Partial<BrowserSession>[]): BrowserTracker {
  return {
    all: () => sessions as BrowserSession[],
    getActive: () => sessions[sessions.length - 1] as BrowserSession,
    count: sessions.length,
    list: () => [],
  } as unknown as BrowserTracker;
}

describe('executeStep — a switched-to tab is brought to the front (§4)', () => {
  const SWITCH_RESPONSE = JSON.stringify({
    actions: [{ action: 'switchPage', page: 'cart', description: 'Switch to the cart tab' }],
    reasoning: 'The step names another tab.',
    needs_reeval: false,
  });

  /** Two tracked pages in one browser context; the second is the one
   *  `switchPage: "cart"` resolves to. */
  function twoTabs() {
    const context = makeContext();
    const main = makeSwitchablePage('https://shop.example/', 'Shop', context);
    const cart = makeSwitchablePage('https://shop.example/cart', 'Cart', context);
    const pageTracker = new PageTracker(main);
    pageTracker.addPage(cart);
    return { main, cart, pageTracker, context };
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

  it('reads headedness off THE PAGE\'S OWN browser, not the shared config', async () => {
    // `openBrowser` can override `headed` per browser, so one run can hold a
    // headed browser and a headless one at once. Reading the global config
    // would raise a window for a browser that has none, or skip the raise for
    // the one the user is actually watching.
    const { cart, pageTracker, context } = twoTabs();
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
      // …but the browser this tab belongs to is headed.
      browserTracker: trackerOf({ context: context as never, headed: true }),
    });

    expect(cart.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('does NOT raise a page whose own browser is headless, whatever the config says', async () => {
    // The inverse of the case above, and the half that catches an inverted
    // gate. A gate that read the config here would call `bringToFront` on a
    // browser with no window at all.
    const { cart, pageTracker, context } = twoTabs();
    const config = makeConfig();
    config.browser.headed = true; // global says headed…

    await executeStep(1, 1, 'switch to the cart tab', {
      page: pageTracker.getActive(),
      config,
      aiClient: makeAiClient([SWITCH_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
      // …but this tab lives in a headless one.
      browserTracker: trackerOf({ context: context as never, headed: false }),
    });

    expect(cart.bringToFront).not.toHaveBeenCalled();
  });

  it('asks about the browser holding the TAB, not whichever browser is active', async () => {
    // Round-two regression, and the bug a review caught after this shipped.
    //
    // `switchPage` always resolves through `opts.pageTracker` — the tracker the
    // step executor was handed, which belongs to the run's FIRST browser —
    // while `BrowserTracker.add()` auto-promotes the active pointer to whatever
    // `openBrowser` opened last. So: a headed run that opens a headless worker
    // browser and then runs `switchTab` was asking the worker whether to raise
    // a tab in the headed browser, concluding headless, and leaving the tab
    // unraised on the one window the human was actually watching.
    //
    // Reachable from ordinary authoring: `openBrowser as "worker" headed:
    // false`, then `switchTab "cart"`.
    const { cart, pageTracker, context } = twoTabs();
    const config = makeConfig();
    config.browser.headed = true;

    await executeStep(1, 1, 'switch to the cart tab', {
      page: pageTracker.getActive(),
      config,
      aiClient: makeAiClient([SWITCH_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
      browserTracker: trackerOf(
        // The browser the tab is in — headed, and NOT active.
        { context: context as never, headed: true },
        // The one `openBrowser` opened last, which `getActive()` returns.
        { context: makeContext() as never, headed: false },
      ),
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

  // ── openPage, the other half of §4 ────────────────────────────────────────

  const OPEN_RESPONSE = JSON.stringify({
    actions: [
      { action: 'openPage', url: 'https://shop.example/new', description: 'Open the docs tab' },
    ],
    reasoning: 'The step asks for a new tab.',
    needs_reeval: false,
  });

  it('raises a tab it just OPENED in a headed run', async () => {
    // Same argument as `switchPage`, and it was untested: a newly opened tab
    // the run is about to drive should be the one on screen, or the automation
    // carries on behind whatever the user was looking at.
    const opened: Page[] = [];
    const context = makeContext(opened);
    const main = makeSwitchablePage('https://shop.example/', 'Shop', context);
    const pageTracker = new PageTracker(main);
    const config = makeConfig();
    config.browser.headed = true;

    const result = await executeStep(1, 1, 'open the docs in a new tab', {
      page: main,
      config,
      aiClient: makeAiClient([OPEN_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
    });

    expect(result.status).toBe('passed');
    expect(opened).toHaveLength(1);
    expect(
      (opened[0] as unknown as { bringToFront: ReturnType<typeof vi.fn> }).bringToFront,
    ).toHaveBeenCalledTimes(1);
  });

  it('does not raise an opened tab in a headless run', async () => {
    const opened: Page[] = [];
    const context = makeContext(opened);
    const main = makeSwitchablePage('https://shop.example/', 'Shop', context);
    const pageTracker = new PageTracker(main);
    const config = makeConfig();
    config.browser.headed = false;

    await executeStep(1, 1, 'open the docs in a new tab', {
      page: main,
      config,
      aiClient: makeAiClient([OPEN_RESPONSE]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
    });

    expect(opened).toHaveLength(1);
    expect(
      (opened[0] as unknown as { bringToFront: ReturnType<typeof vi.fn> }).bringToFront,
    ).not.toHaveBeenCalled();
  });

  it('names an opened tab by its `as`, which is how a later step switches back to it', async () => {
    const opened: Page[] = [];
    const context = makeContext(opened);
    const main = makeSwitchablePage('https://shop.example/', 'Shop', context);
    const pageTracker = new PageTracker(main);
    // What the context's 'page' listener does in a real run: track the new tab.
    const newPage = context['newPage'] as () => Promise<Page>;
    context['newPage'] = async () => {
      const p = await newPage();
      pageTracker.addPage(p);
      return p;
    };

    const result = await executeStep(1, 1, 'open the docs in a new tab called docs', {
      page: main,
      config: makeConfig(),
      aiClient: makeAiClient([JSON.stringify({
        actions: [
          { action: 'openPage', url: 'https://shop.example/new', as: 'docs', description: 'Open the docs tab' },
        ],
        reasoning: 'The step names the new tab.',
        needs_reeval: false,
      })]),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      pageTracker,
    });

    expect(result.status).toBe('passed');
    expect(pageTracker.getActive()).toBe(opened[0]);
    expect(await pageTracker.switchToAsync('main')).toBe(main);
    // Neither its URL nor its title says "docs": only the label finds it.
    expect(await pageTracker.switchToAsync('docs')).toBe(opened[0]);
    expect(await pageTracker.switchToAsync('page:2')).toBeNull();
  });
});
