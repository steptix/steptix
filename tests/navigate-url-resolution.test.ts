import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright';
import { executeAction } from '../src/browser/actions.js';

// The navigate case only touches page.goto — no selector, no frame — so a
// minimal mock is enough (see the dispatch in executeAction).
function makeMockPage() {
  const goto = vi.fn().mockResolvedValue(undefined);
  const page = { goto, url: () => 'about:blank' } as unknown as Page;
  return { page, goto };
}

async function navigatedTo(url: string, baseUrl?: string): Promise<string> {
  const { page, goto } = makeMockPage();
  const result = await executeAction(page, { action: 'navigate', url, description: 'go' }, baseUrl);
  expect(result.success).toBe(true);
  return goto.mock.calls[0]![0] as string;
}

describe('navigate URL resolution', () => {
  const FILE_BASE = 'file:///C:/scratch/smoke/page.html';
  const HTTP_BASE = 'https://example.com/app/';

  it('passes a file:/// URL through untouched against a file:// baseUrl', async () => {
    // The failure this pins: the runner used to produce
    // `file:///…/page.html/file:///…/page.html` → net::ERR_FILE_NOT_FOUND.
    expect(await navigatedTo(FILE_BASE, FILE_BASE)).toBe(FILE_BASE);
  });

  it('passes about:blank through untouched against a file:// baseUrl', async () => {
    expect(await navigatedTo('about:blank', FILE_BASE)).toBe('about:blank');
  });

  it('passes file:/// and about: URLs through untouched against an http baseUrl', async () => {
    expect(await navigatedTo('file:///C:/other/page.html', HTTP_BASE)).toBe('file:///C:/other/page.html');
    expect(await navigatedTo('about:blank', HTTP_BASE)).toBe('about:blank');
  });

  it('passes data: URLs through untouched', async () => {
    expect(await navigatedTo('data:text/html,<h1>hi</h1>', HTTP_BASE)).toBe('data:text/html,<h1>hi</h1>');
  });

  it('keeps http(s) URLs absolute, as before', async () => {
    expect(await navigatedTo('https://other.example/x', HTTP_BASE)).toBe('https://other.example/x');
    expect(await navigatedTo('http://other.example/x', HTTP_BASE)).toBe('http://other.example/x');
  });

  it('still resolves path-absolute and bare-relative URLs against baseUrl', async () => {
    expect(await navigatedTo('/dashboard', HTTP_BASE)).toBe('https://example.com/app/dashboard');
    expect(await navigatedTo('dashboard', HTTP_BASE)).toBe('https://example.com/app/dashboard');
  });

  it('keeps scheme-looking non-URLs on the relative path (the allowlist, not new URL())', async () => {
    // `localhost:3000` and `C:/x` both parse via `new URL` with schemes
    // `localhost:` and `c:`; they must keep today's baseUrl-relative handling.
    expect(await navigatedTo('localhost:3000/x', HTTP_BASE)).toBe('https://example.com/app/localhost:3000/x');
  });

  it('leaves a URL alone when there is no baseUrl at all', async () => {
    expect(await navigatedTo('/dashboard')).toBe('/dashboard');
  });
});
