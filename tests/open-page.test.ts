/**
 * The label an `openPage` step's `as` gives its tab: `PageTracker.relabelPage`,
 * and switching and closing by that label.
 *
 * The openPage handler itself (step-executor) is driven through `executeStep`
 * in multi-turn.test.ts, from the model's reply on: it opens the tab, raises
 * it in a headed run, and names it by `as` so a later switch finds it by that
 * label alone. What is left to pin here is the tracker's bookkeeping, which
 * keys on page identity, URL and title — so stand-in pages do, with no
 * browser and no server. Switching by URL, title and auto-label, and closing,
 * are popup.test.ts's; the `openPage` aliases are unknown-action-type.test.ts's.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright';
import { PageTracker } from '../src/browser/manager.js';

/** A stand-in page: a URL, a title, and close handling the tracker hooks. */
function standIn(url: string, title = ''): Page {
  const onClose: Array<() => void> = [];
  let closed = false;
  return {
    url: vi.fn(() => url),
    title: vi.fn(async () => title),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') onClose.push(handler);
    }),
    isClosed: vi.fn(() => closed),
    close: vi.fn(async () => {
      closed = true;
      for (const h of onClose) h();
    }),
  } as unknown as Page;
}

describe('PageTracker — the label `as` gives a tab', () => {
  const main = (): Page => standIn('https://bank.test/', 'SecureBank');

  it('replaces the auto-generated page:N: the tab answers to its new label and no longer to the old one', async () => {
    const tracker = new PageTracker(main());
    const docs = standIn('https://bank.test/help', 'Help');
    expect(tracker.addPage(docs)).toBe('page:2');

    tracker.relabelPage(docs, 'docs');

    expect(await tracker.switchToAsync('docs')).toBe(docs);
    expect(await tracker.switchToAsync('page:2')).toBeNull();
  });

  it('rejects the reserved name "main"', () => {
    const tracker = new PageTracker(main());
    const p = standIn('https://bank.test/a');
    tracker.addPage(p);
    expect(() => tracker.relabelPage(p, 'main')).toThrow(/reserved/);
  });

  it('rejects the auto-label format page:N', () => {
    const tracker = new PageTracker(main());
    const p = standIn('https://bank.test/a');
    tracker.addPage(p);
    expect(() => tracker.relabelPage(p, 'page:7')).toThrow(/auto-generated/);
  });

  it('rejects illegal characters and a leading digit', () => {
    const tracker = new PageTracker(main());
    const p = standIn('https://bank.test/a');
    tracker.addPage(p);
    expect(() => tracker.relabelPage(p, 'has spaces')).toThrow(/letters, digits/);
    expect(() => tracker.relabelPage(p, '1leading_digit')).toThrow(/start with a letter/);
  });

  it('rejects a label another page already has', () => {
    const tracker = new PageTracker(main());
    const a = standIn('https://bank.test/a');
    const b = standIn('https://bank.test/b');
    tracker.addPage(a);
    tracker.addPage(b);
    tracker.relabelPage(a, 'first');
    expect(() => tracker.relabelPage(b, 'first')).toThrow(/already taken/);
  });

  it('allows the same label again on the same page — the collision check leaves the page itself out', () => {
    const tracker = new PageTracker(main());
    const p = standIn('https://bank.test/a');
    tracker.addPage(p);
    tracker.relabelPage(p, 'inbox');
    expect(() => tracker.relabelPage(p, 'inbox')).not.toThrow();
  });

  it('three tabs with one title: each is reached by its exact label', async () => {
    const tracker = new PageTracker(main());
    // Same title everywhere, so by title a switch would be ambiguous; and no
    // URL contains its label, so only the label itself can find each tab.
    const tabs = ['alpha', 'beta', 'gamma'].map((label, i) => {
      const p = standIn(`https://bank.test/doc/${i + 1}`, 'Document');
      tracker.addPage(p);
      tracker.relabelPage(p, label);
      return [label, p] as const;
    });
    for (const [label, p] of tabs) expect(await tracker.switchToAsync(label), label).toBe(p);
    expect((await tracker.switchToAsync('main'))?.url()).toBe('https://bank.test/');
  });

  it('closes a tab by its label: gone by every name, and the active tab falls back to main', async () => {
    const first = main();
    const tracker = new PageTracker(first);
    const named = standIn('https://bank.test/help', 'Help');
    tracker.addPage(named);
    tracker.relabelPage(named, 'docs');
    expect(await tracker.switchToAsync('docs')).toBe(named);

    const result = await tracker.closePage('docs');
    expect(result).toMatchObject({ closed: true, activePage: first });
    expect(named.isClosed()).toBe(true);
    // Not by its label, its URL or its title.
    expect(await tracker.switchToAsync('docs')).toBeNull();
    expect(await tracker.switchToAsync('/help')).toBeNull();
    expect(await tracker.switchToAsync('Help')).toBeNull();
    expect((await tracker.closePage('docs')).closed).toBe(false);
  });
});
