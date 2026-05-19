import { describe, it, expect, vi } from 'vitest';
import {
  parseCdpTabSpec,
  resolveCdpTab,
  preflightCdpPort,
  PageTracker,
  type CdpTabSpec,
} from '../src/browser/manager.js';

// ----- parseCdpTabSpec -----

describe('parseCdpTabSpec', () => {
  it('treats undefined / empty as `new`', () => {
    expect(parseCdpTabSpec(undefined)).toEqual({ kind: 'new' });
    expect(parseCdpTabSpec('')).toEqual({ kind: 'new' });
    expect(parseCdpTabSpec('   ')).toEqual({ kind: 'new' });
  });

  it('parses `new`', () => {
    expect(parseCdpTabSpec('new')).toEqual({ kind: 'new' });
    expect(parseCdpTabSpec('NEW')).toEqual({ kind: 'new' });
  });

  it('parses `active`', () => {
    expect(parseCdpTabSpec('active')).toEqual({ kind: 'active' });
    expect(parseCdpTabSpec('Active')).toEqual({ kind: 'active' });
  });

  it('parses integer index', () => {
    expect(parseCdpTabSpec('0')).toEqual({ kind: 'index', index: 0 });
    expect(parseCdpTabSpec('3')).toEqual({ kind: 'index', index: 3 });
  });

  it('rejects negative or non-integer index', () => {
    expect(parseCdpTabSpec('-1').kind).toBe('invalid');
    expect(parseCdpTabSpec('1.5').kind).toBe('invalid');
  });

  it('parses url substring', () => {
    expect(parseCdpTabSpec('url~example.com')).toEqual({
      kind: 'urlSubstring',
      value: 'example.com',
    });
  });

  it('parses title substring', () => {
    expect(parseCdpTabSpec('title~Inbox')).toEqual({
      kind: 'titleSubstring',
      value: 'Inbox',
    });
  });

  it('rejects empty url~ / title~ values', () => {
    expect(parseCdpTabSpec('url~').kind).toBe('invalid');
    expect(parseCdpTabSpec('title~  ').kind).toBe('invalid');
  });

  it('rejects unknown specs', () => {
    expect(parseCdpTabSpec('foo').kind).toBe('invalid');
    expect(parseCdpTabSpec('regex:.*').kind).toBe('invalid');
  });

  it('parses targetId selector, preserving id value verbatim', () => {
    expect(parseCdpTabSpec('targetId:ABC123')).toEqual({
      kind: 'targetId',
      value: 'ABC123',
    });
  });

  it('rejects empty targetId values', () => {
    expect(parseCdpTabSpec('targetId:').kind).toBe('invalid');
    expect(parseCdpTabSpec('targetId:   ').kind).toBe('invalid');
  });

  it('targetId prefix is case-insensitive, value is preserved', () => {
    expect(parseCdpTabSpec('TARGETID:foo')).toEqual({
      kind: 'targetId',
      value: 'foo',
    });
  });
});

// ----- resolveCdpTab -----

interface FakePage {
  url: () => string;
  titleValue: string;
  // Match Playwright's Page.title signature shape we depend on
  title: () => Promise<string>;
}

function fakePage(url: string, title = ''): FakePage {
  return {
    url: () => url,
    titleValue: title,
    title: async () => title,
  };
}

describe('resolveCdpTab', () => {
  it('returns null for `new` (caller should open a new tab)', async () => {
    const pages = [fakePage('https://a.test')];
    const result = await resolveCdpTab(pages as any, { kind: 'new' });
    expect(result).toBeNull();
  });

  it('resolves index match', async () => {
    const pages = [fakePage('https://a.test'), fakePage('https://b.test')];
    const result = await resolveCdpTab(pages as any, { kind: 'index', index: 1 });
    expect(result).toBe(pages[1]);
  });

  it('returns error for out-of-range index', async () => {
    const pages = [fakePage('https://a.test')];
    await expect(resolveCdpTab(pages as any, { kind: 'index', index: 5 }))
      .rejects.toThrow(/no tab at index 5/i);
  });

  it('resolves url substring (case-insensitive)', async () => {
    const pages = [
      fakePage('https://other.test'),
      fakePage('https://Example.com/dashboard'),
    ];
    const result = await resolveCdpTab(
      pages as any,
      { kind: 'urlSubstring', value: 'example.com' },
    );
    expect(result).toBe(pages[1]);
  });

  it('throws when no url match', async () => {
    const pages = [fakePage('https://a.test')];
    await expect(
      resolveCdpTab(pages as any, { kind: 'urlSubstring', value: 'nope' }),
    ).rejects.toThrow(/no tab matches.+url.+nope/i);
  });

  it('resolves title substring (case-insensitive)', async () => {
    const pages = [
      fakePage('https://a.test', 'Home'),
      fakePage('https://b.test', 'My Inbox - Mail'),
    ];
    const result = await resolveCdpTab(
      pages as any,
      { kind: 'titleSubstring', value: 'inbox' },
    );
    expect(result).toBe(pages[1]);
  });

  it('throws when no title match', async () => {
    const pages = [fakePage('https://a.test', 'Home')];
    await expect(
      resolveCdpTab(pages as any, { kind: 'titleSubstring', value: 'inbox' }),
    ).rejects.toThrow(/no tab matches.+title/i);
  });

  it('error message lists open tabs to help author fix selector', async () => {
    const pages = [
      fakePage('https://one.test', 'One'),
      fakePage('https://two.test', 'Two'),
    ];
    let err: Error | undefined;
    try {
      await resolveCdpTab(pages as any, { kind: 'urlSubstring', value: 'nope' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/one\.test/);
    expect(err!.message).toMatch(/two\.test/);
  });

  it('rejects invalid spec', async () => {
    await expect(
      resolveCdpTab([] as any, { kind: 'invalid', reason: 'bad' }),
    ).rejects.toThrow(/bad/);
  });

  // ----- targetId -----

  /**
   * Fake page whose `context()` exposes a `newCDPSession` that, when sent
   * `Target.getTargetInfo`, returns the canned targetId.
   */
  function fakePageWithTargetId(url: string, targetId: string) {
    const session = {
      send: async (method: string) => {
        if (method === 'Target.getTargetInfo') {
          return { targetInfo: { targetId } };
        }
        throw new Error(`unexpected CDP method ${method}`);
      },
    };
    return {
      url: () => url,
      title: async () => '',
      context: () => ({
        newCDPSession: async (_p: unknown) => session,
      }),
    };
  }

  it('resolves targetId by exact match via CDP Target.getTargetInfo', async () => {
    const pageA = fakePageWithTargetId('https://a.test', 'AAA');
    const pageB = fakePageWithTargetId('https://b.test', 'BBB');
    const result = await resolveCdpTab(
      [pageA, pageB] as any,
      { kind: 'targetId', value: 'BBB' },
    );
    expect(result).toBe(pageB);
  });

  it('throws with tab list when no targetId matches', async () => {
    const pageA = fakePageWithTargetId('https://a.test', 'AAA');
    const pageB = fakePageWithTargetId('https://b.test', 'BBB');
    let err: Error | undefined;
    try {
      await resolveCdpTab(
        [pageA, pageB] as any,
        { kind: 'targetId', value: 'ZZZ' },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/targetId/i);
    expect(err!.message).toMatch(/ZZZ/);
    expect(err!.message).toMatch(/a\.test/);
    expect(err!.message).toMatch(/b\.test/);
  });

  it('throws clear error when context has no newCDPSession', async () => {
    const page = {
      url: () => 'https://a.test',
      title: async () => '',
      context: () => ({}),
    };
    await expect(
      resolveCdpTab([page] as any, { kind: 'targetId', value: 'any' }),
    ).rejects.toThrow(/requires.+newCDPSession/i);
  });
});

// ----- preflightCdpPort -----

describe('preflightCdpPort', () => {
  it('passes when /json/version returns 200', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ Browser: 'Chrome/120' }),
    }));
    await expect(preflightCdpPort(9222, fakeFetch as any)).resolves.toBeUndefined();
    expect(fakeFetch).toHaveBeenCalledWith(
      'http://localhost:9222/json/version',
      expect.any(Object),
    );
  });

  it('throws actionable error on connection refused', async () => {
    const fakeFetch = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9222'), {
        code: 'ECONNREFUSED',
      });
    });
    await expect(preflightCdpPort(9222, fakeFetch as any))
      .rejects.toThrow(/Cannot connect to Chrome on port 9222/);
  });

  it('error message tells user how to start Chrome', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
    });
    let err: Error | undefined;
    try {
      await preflightCdpPort(9999, fakeFetch as any);
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toMatch(/--remote-debugging-port=9999/);
  });

  it('throws when /json/version returns non-200', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    await expect(preflightCdpPort(9222, fakeFetch as any))
      .rejects.toThrow(/port 9222/);
  });
});

// ----- PageTracker with ignored pages -----

describe('PageTracker ignored pages (CDP mode)', () => {
  function fakePlaywrightPage(url = 'https://main.test') {
    const handlers: Record<string, Array<() => void>> = {};
    return {
      url: () => url,
      on: (event: string, cb: () => void) => {
        (handlers[event] ??= []).push(cb);
      },
      _emit: (event: string) => {
        for (const cb of handlers[event] ?? []) cb();
      },
    };
  }

  it('skips addPage for pages in the ignored set', () => {
    const main = fakePlaywrightPage('https://main.test');
    const ignored1 = fakePlaywrightPage('https://other.test');
    const ignored2 = fakePlaywrightPage('https://background.test');

    const tracker = new PageTracker(
      main as any,
      new Set<any>([ignored1, ignored2]),
    );

    // Simulating the context.on('page') call path: addPage should be a no-op
    // for ignored pages and return null/empty so the caller's logging branch
    // can detect it.
    const label1 = tracker.addPage(ignored1 as any);
    const label2 = tracker.addPage(ignored2 as any);
    expect(label1).toBeNull();
    expect(label2).toBeNull();
    expect(tracker.count).toBe(1); // only main
  });

  it('still tracks non-ignored pages normally', () => {
    const main = fakePlaywrightPage('https://main.test');
    const ignored = fakePlaywrightPage('https://other.test');
    const popup = fakePlaywrightPage('https://popup.test');

    const tracker = new PageTracker(main as any, new Set<any>([ignored]));

    const label = tracker.addPage(popup as any);
    expect(label).toBe('page:2');
    expect(tracker.count).toBe(2);
  });

  it('without ignored set, tracks all pages (back-compat)', () => {
    const main = fakePlaywrightPage('https://main.test');
    const popup = fakePlaywrightPage('https://popup.test');

    const tracker = new PageTracker(main as any);
    const label = tracker.addPage(popup as any);
    expect(label).toBe('page:2');
    expect(tracker.count).toBe(2);
  });
});
