/**
 * Tests for popup/new-tab support:
 * - "switchPage" action type parsing in action-parser
 * - "page" field parsing
 * - Action type aliases (switch_page, switchTab, etc.)
 * - PageTracker: tracking, switching, close handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { PageTracker } from '../src/browser/manager.js';
import type { Page } from 'playwright';

// ─── Helper: create a mock Playwright Page ──────────────────────────────────

function mockPage(opts: { url?: string; title?: string; closed?: boolean } = {}): Page {
  const closeHandlers: Array<() => void> = [];
  const page = {
    url: vi.fn(() => opts.url ?? 'about:blank'),
    title: vi.fn(async () => opts.title ?? ''),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    }),
    isClosed: vi.fn(() => opts.closed ?? false),
    // Expose internal close handlers for testing
    _triggerClose() {
      for (const h of closeHandlers) h();
    },
  } as unknown as Page & { _triggerClose: () => void };
  return page;
}

// ─── Parser: switchPage action type ─────────────────────────────────────────

describe('parseAIResponse — switchPage action', () => {
  it('parses switchPage action with page field', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'switchPage',
          page: 'page:2',
          description: 'Switch to popup window',
        },
      ],
      reasoning: 'Need to interact with the popup.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action).toBe('switchPage');
    expect(result.actions[0]?.page).toBe('page:2');
  });

  it('parses page field alongside other fields', () => {
    const raw = JSON.stringify({
      actions: [
        {
          action: 'switchPage',
          page: 'main',
          description: 'Switch back to main page',
        },
      ],
      reasoning: 'Done with popup.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.page).toBe('main');
    expect(result.actions[0]?.description).toBe('Switch back to main page');
  });

  it('ignores non-string page values', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'switchPage', page: 42, description: 'Switch' }],
      reasoning: 'Invalid page.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.page).toBeUndefined();
  });

  it('omits page when not present in action', () => {
    const raw = JSON.stringify({
      actions: [{ action: 'click', selector: '#btn', description: 'Click' }],
      reasoning: 'No page switch.',
    });
    const result = parseAIResponse(raw);
    expect(result.actions[0]?.page).toBeUndefined();
  });
});

// ─── Parser: switchPage aliases ─────────────────────────────────────────────

describe('parseAIResponse — switchPage aliases', () => {
  const aliases = ['switch_page', 'switchTab', 'switch_tab', 'switchWindow', 'switch_window'];

  for (const alias of aliases) {
    it(`normalises "${alias}" to "switchPage"`, () => {
      const raw = JSON.stringify({
        actions: [{ action: alias, page: 'page:2', description: 'Switch' }],
        reasoning: 'Alias test.',
      });
      const result = parseAIResponse(raw);
      expect(result.actions[0]?.action).toBe('switchPage');
    });
  }
});

// ─── PageTracker ────────────────────────────────────────────────────────────

describe('PageTracker', () => {
  let mainPage: Page & { _triggerClose: () => void };
  let tracker: PageTracker;

  beforeEach(() => {
    mainPage = mockPage({ url: 'http://localhost:8787/new-window', title: 'Main Page' }) as Page & { _triggerClose: () => void };
    tracker = new PageTracker(mainPage);
  });

  it('initialises with main page', () => {
    expect(tracker.count).toBe(1);
    expect(tracker.getActive()).toBe(mainPage);
  });

  it('getPageList returns main page with isActive true', () => {
    const list = tracker.getPageList();
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe('main');
    expect(list[0]?.isActive).toBe(true);
  });

  describe('addPage', () => {
    it('adds a new page with auto-generated label', () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup' });
      const label = tracker.addPage(popup);
      expect(label).toBe('page:2');
      expect(tracker.count).toBe(2);
    });

    it('assigns sequential labels', () => {
      const p2 = mockPage({ url: 'http://localhost:8787/popup' });
      const p3 = mockPage({ url: 'http://localhost:8787/tab' });
      expect(tracker.addPage(p2)).toBe('page:2');
      expect(tracker.addPage(p3)).toBe('page:3');
      expect(tracker.count).toBe(3);
    });
  });

  describe('switchTo', () => {
    it('switches by exact label', () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup' });
      tracker.addPage(popup);
      const result = tracker.switchTo('page:2');
      expect(result).toBe(popup);
      expect(tracker.getActive()).toBe(popup);
    });

    it('switches back to main by label', () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup' });
      tracker.addPage(popup);
      tracker.switchTo('page:2');
      const result = tracker.switchTo('main');
      expect(result).toBe(mainPage);
      expect(tracker.getActive()).toBe(mainPage);
    });

    it('switches by URL substring', () => {
      const popup = mockPage({ url: 'http://localhost:8787/new-window/popup' });
      tracker.addPage(popup);
      const result = tracker.switchTo('/popup');
      expect(result).toBe(popup);
    });

    it('returns null for no match', () => {
      const result = tracker.switchTo('nonexistent');
      expect(result).toBeNull();
      // Active page should be unchanged
      expect(tracker.getActive()).toBe(mainPage);
    });
  });

  describe('switchToAsync', () => {
    it('switches by title substring', async () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup', title: 'Popup Window' });
      tracker.addPage(popup);
      const result = await tracker.switchToAsync('Popup Window');
      expect(result).toBe(popup);
      expect(tracker.getActive()).toBe(popup);
    });

    it('switches by label (async)', async () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup' });
      tracker.addPage(popup);
      const result = await tracker.switchToAsync('page:2');
      expect(result).toBe(popup);
    });

    it('switches by URL (async, case insensitive)', async () => {
      const popup = mockPage({ url: 'http://localhost:8787/NEW-WINDOW/popup' });
      tracker.addPage(popup);
      const result = await tracker.switchToAsync('new-window/popup');
      expect(result).toBe(popup);
    });

    it('returns null for no match (async)', async () => {
      const result = await tracker.switchToAsync('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('page close handling', () => {
    it('removes closed page from tracker', () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup' }) as Page & { _triggerClose: () => void };
      tracker.addPage(popup);
      expect(tracker.count).toBe(2);

      popup._triggerClose();
      expect(tracker.count).toBe(1);
    });

    it('falls back to main when active page closes', () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup' }) as Page & { _triggerClose: () => void };
      tracker.addPage(popup);
      tracker.switchTo('page:2');
      expect(tracker.getActive()).toBe(popup);

      popup._triggerClose();
      expect(tracker.getActive()).toBe(mainPage);
    });

    it('maintains correct active page when non-active page closes', () => {
      const p2 = mockPage({ url: 'http://localhost:8787/popup' }) as Page & { _triggerClose: () => void };
      const p3 = mockPage({ url: 'http://localhost:8787/tab' });
      tracker.addPage(p2);
      tracker.addPage(p3);
      tracker.switchTo('page:3');
      expect(tracker.getActive()).toBe(p3);

      p2._triggerClose();
      expect(tracker.getActive()).toBe(p3);
      expect(tracker.count).toBe(2);
    });
  });

  describe('getPageListWithTitles', () => {
    it('returns titles from pages', async () => {
      const popup = mockPage({ url: 'http://localhost:8787/popup', title: 'Popup Window' });
      tracker.addPage(popup);
      const list = await tracker.getPageListWithTitles();
      expect(list).toHaveLength(2);
      expect(list[0]?.title).toBe('Main Page');
      expect(list[0]?.isActive).toBe(true);
      expect(list[1]?.title).toBe('Popup Window');
      expect(list[1]?.isActive).toBe(false);
    });
  });
});
