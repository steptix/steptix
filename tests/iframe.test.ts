/**
 * Tests for iframe support:
 * - "frame" field parsing in action-parser
 * - Frame-aware action execution (executeAction routes to FrameLocator)
 */
import { describe, it, expect, vi } from 'vitest';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { executeAction } from '../src/browser/actions.js';
import { DEFAULT_BROWSER_DIMENSIONS } from '../src/config/browser-dimensions.js';
import type { Page, FrameLocator, Locator } from 'playwright';

// ─── Parser: frame field ──────────────────────────────────────────────────────

describe('parseAIResponse — frame field', () => {
  it('parses frame selector from action', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'click',
          selector: '#open-account-btn',
          frame: '#payments-frame',
          description: 'Click Open Account inside the payments iframe',
        },
      ],
      reasoning: 'Target is inside an iframe.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.frame).toBe('#payments-frame');
  });

  it('omits frame when not present in action', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', description: 'Click' }],
      reasoning: 'No frame needed.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.frame).toBeUndefined();
  });

  it('ignores non-string frame values', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', frame: 42, description: 'Click' }],
      reasoning: 'Invalid frame.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.frame).toBeUndefined();
  });
});

// ─── executeAction: frame-aware routing ──────────────────────────────────────

/**
 * Build a mock Locator that supports chaining: .locator() returns itself,
 * .first() returns itself, and action methods are vi.fn().
 */
function makeMockLocator(): Locator {
  const locator: Locator = {
    locator: vi.fn().mockImplementation(() => locator),
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(false),
    waitFor: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue('read-value'),
    count: vi.fn().mockResolvedValue(3),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
  } as unknown as Locator;
  return locator;
}

/**
 * Build a mock FrameLocator whose .locator() returns a mock Locator.
 * Captures whether it was actually used.
 */
function makeMockFrameLocator(): { frameLocator: FrameLocator; innerLocator: Locator } {
  const innerLocator = makeMockLocator();
  const frameLocator = {
    locator: vi.fn().mockReturnValue(innerLocator),
    frameLocator: vi.fn(),
  } as unknown as FrameLocator;
  return { frameLocator, innerLocator };
}

/**
 * Build a mock Page that returns a FrameLocator when page.frameLocator(selector) is called.
 */
function makeMockPage(frameLocatorMap: Record<string, FrameLocator> = {}): {
  page: Page;
  pageLocator: Locator;
} {
  const pageLocator = makeMockLocator();
  const page = {
    locator: vi.fn().mockReturnValue(pageLocator),
    frameLocator: vi.fn().mockImplementation((sel: string) => {
      const fl = frameLocatorMap[sel];
      if (!fl) throw new Error(`No mock frame for selector: ${sel}`);
      return fl;
    }),
    goto: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    viewportSize: vi.fn().mockReturnValue({ ...DEFAULT_BROWSER_DIMENSIONS }),
    url: vi.fn().mockReturnValue('http://localhost/'),
    $eval: vi.fn(),
  } as unknown as Page;
  return { page, pageLocator };
}

describe('executeAction — frame routing', () => {
  it('routes click to FrameLocator when frame is set', async () => {
    const { frameLocator, innerLocator } = makeMockFrameLocator();
    const { page } = makeMockPage({ '#my-frame': frameLocator });

    const result = await executeAction(page, {
      action: 'click',
      selector: '#open-account-btn',
      frame: '#my-frame',
      description: 'Click inside iframe',
    });

    expect(result.success).toBe(true);
    // frameLocator.locator() should have been called, not page.locator()
    expect(frameLocator.locator).toHaveBeenCalledWith('#open-account-btn');
    expect(innerLocator.click).toHaveBeenCalled();
  });

  it('routes click to page when no frame is set', async () => {
    const { frameLocator } = makeMockFrameLocator();
    const { page, pageLocator } = makeMockPage({ '#my-frame': frameLocator });

    const result = await executeAction(page, {
      action: 'click',
      selector: '#btn',
      description: 'Click on page',
    });

    expect(result.success).toBe(true);
    // No frame means the page itself is the root: the frame lookup is never
    // asked, and the selector goes to page.locator.
    expect(page.frameLocator).not.toHaveBeenCalled();
    expect(page.locator).toHaveBeenCalledWith('#btn');
    expect(pageLocator.click).toHaveBeenCalled();
  });

  it('routes type to FrameLocator when frame is set', async () => {
    const { frameLocator, innerLocator } = makeMockFrameLocator();
    const { page } = makeMockPage({ 'iframe#form': frameLocator });

    const result = await executeAction(page, {
      action: 'type',
      selector: 'input[name="amount"]',
      value: '500',
      frame: 'iframe#form',
      description: 'Type in iframe input',
    });

    expect(result.success).toBe(true);
    expect(frameLocator.locator).toHaveBeenCalledWith('input[name="amount"]');
    expect(innerLocator.fill).toHaveBeenCalledWith('500', expect.anything());
  });

  it('read action uses locator.evaluate in frame context', async () => {
    const { frameLocator, innerLocator } = makeMockFrameLocator();
    (innerLocator.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue('Account: 12345');
    const { page } = makeMockPage({ '#data-frame': frameLocator });

    const result = await executeAction(page, {
      action: 'read',
      selector: '.account-number',
      frame: '#data-frame',
      as: 'account_number',
      description: 'Read account number from iframe',
    });

    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('Account: 12345');
    expect(frameLocator.locator).toHaveBeenCalledWith('.account-number');
  });

  it('count action uses root.locator in frame context', async () => {
    const { frameLocator, innerLocator } = makeMockFrameLocator();
    (innerLocator.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    const { page } = makeMockPage({ '#list-frame': frameLocator });

    const result = await executeAction(page, {
      action: 'count',
      selector: 'tr.account-row',
      frame: '#list-frame',
      as: 'account_count',
      description: 'Count accounts in iframe table',
    });

    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('5');
    expect(frameLocator.locator).toHaveBeenCalledWith('tr.account-row');
  });

  it('navigate action always uses page (ignores frame)', async () => {
    const { frameLocator } = makeMockFrameLocator();
    const { page } = makeMockPage({ '#nav-frame': frameLocator });

    const result = await executeAction(page, {
      action: 'navigate',
      url: '/dashboard',
      frame: '#nav-frame',
      description: 'Navigate to dashboard',
    });

    expect(result.success).toBe(true);
    expect(page.goto).toHaveBeenCalledWith('/dashboard', expect.anything());
    // Frame locator should NOT have been used for navigation
    expect(frameLocator.locator).not.toHaveBeenCalled();
  });

  it('returns error with matchCount from frame context on failure', async () => {
    const { frameLocator, innerLocator } = makeMockFrameLocator();
    (innerLocator.click as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Element not found'));
    (innerLocator.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const { page } = makeMockPage({ '#err-frame': frameLocator });

    const result = await executeAction(page, {
      action: 'click',
      selector: '#missing-btn',
      frame: '#err-frame',
      description: 'Click missing button in iframe',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Element not found');
    expect(result.failedSelector).toBe('#missing-btn');
    // matchCount should come from the frame's locator, not page.locator
    expect(frameLocator.locator).toHaveBeenCalledWith('#missing-btn');
  });
});
