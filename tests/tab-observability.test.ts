import { describe, it, expect, vi } from 'vitest';
import { PageTracker } from '../src/browser/manager.js';
import { foldRun } from '../src/mcp/run-fold.js';
import { renderReport } from '../src/report/generator.js';
import type { RunEvent } from '../src/server/session-manager.js';
import type { StepResult, TestReport } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// §11 tab observability: the per-step `tab` field from PageTracker through the
// fold to the report.
//
// The point of the field is `targetId`. Several tests can share one CDP
// browser; W0 confirmed every tab any of them opens is adopted by all of them,
// and labels are per-session — so `page:2` in two runs may or may not be the
// same tab, and only the target id answers that.
// ---------------------------------------------------------------------------

/** A Playwright `Page` with just enough surface for the tracker. */
function fakePage(opts: { url?: string; title?: string; targetId?: string | null; opener?: unknown } = {}) {
  const handlers: Record<string, (() => void)[]> = {};
  const page = {
    url: () => opts.url ?? 'https://example.com',
    title: async () => opts.title ?? 'Example',
    opener: async () => opts.opener ?? null,
    on: (event: string, fn: () => void) => {
      (handlers[event] ??= []).push(fn);
    },
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: opts.targetId ?? 'TGT-DEFAULT' } }),
        detach: async () => {},
      }),
    }),
  };
  return page as never;
}

/** A page on an engine that cannot answer for a target id (Firefox/WebKit). */
function fakePageNoCdp(url = 'https://example.com') {
  return {
    url: () => url,
    title: async () => 'No CDP',
    opener: async () => null,
    on: () => {},
    context: () => ({}),
  } as never;
}

describe('PageTracker target ids', () => {
  it('resolves and caches the target id, one CDP round-trip per page', async () => {
    let sends = 0;
    const page = {
      url: () => 'https://shop/cart',
      title: async () => 'Cart',
      opener: async () => null,
      on: () => {},
      context: () => ({
        newCDPSession: async () => ({
          send: async () => {
            sends += 1;
            return { targetInfo: { targetId: 'AB12CD34' } };
          },
          detach: async () => {},
        }),
      }),
    } as never;

    const tracker = new PageTracker(page);
    const first = await tracker.describeActiveTab();
    const second = await tracker.describeActiveTab();
    const third = await tracker.describeActiveTab();

    expect(first).toMatchObject({ label: 'main', targetId: 'AB12CD34', url: 'https://shop/cart' });
    expect(second!.targetId).toBe('AB12CD34');
    expect(third!.targetId).toBe('AB12CD34');
    // Doing this per step would add a round-trip to EVERY step of EVERY run,
    // in launch mode as well as CDP, to populate a diagnostic field.
    expect(sends).toBe(1);
  });

  it('degrades to a null target id rather than failing on an engine without CDP', async () => {
    const tracker = new PageTracker(fakePageNoCdp());
    const tab = await tracker.describeActiveTab();
    expect(tab).toMatchObject({ label: 'main', targetId: null });
  });

  it('survives a CDP session that throws', async () => {
    const page = {
      url: () => 'https://x',
      title: async () => 'x',
      opener: async () => null,
      on: () => {},
      context: () => ({
        newCDPSession: async () => {
          throw new Error('detached');
        },
      }),
    } as never;
    await expect(new PageTracker(page).describeActiveTab()).resolves.toMatchObject({
      targetId: null,
    });
  });

  it('does not hang the run on a page whose title never resolves', async () => {
    // `page.title()` has no timeout of its own, and this is a diagnostic
    // field — a hung page must not stall the run reporting on it.
    const page = {
      url: () => 'https://slow',
      title: () => new Promise<string>(() => {}),
      opener: async () => null,
      on: () => {},
      context: () => ({}),
    } as never;

    const started = Date.now();
    const tab = await new PageTracker(page).describeActiveTab();
    expect(tab!.title).toBe('');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reports the ACTIVE tab, not the first one', async () => {
    const main = fakePage({ url: 'https://shop', targetId: 'MAIN' });
    const second = fakePage({ url: 'https://shop/cart', targetId: 'SECOND' });
    const tracker = new PageTracker(main);
    tracker.addPage(second);
    tracker.switchTo('cart');

    const tab = await tracker.describeActiveTab();
    expect(tab).toMatchObject({ label: 'page:2', targetId: 'SECOND' });
  });
});

describe('PageTracker unexpected-tab attribution', () => {
  it('does not flag the page the session started on', async () => {
    const tracker = new PageTracker(fakePage());
    expect((await tracker.describeActiveTab())!.unexpected).toBe(false);
  });

  it('flags a tab that appeared with no opener and no step asking for it', async () => {
    // The cross-contamination case: another test running against the same
    // browser opened this, and we adopted it.
    const tracker = new PageTracker(fakePage({ targetId: 'MAIN' }));
    const stranger = fakePage({ url: 'https://elsewhere', targetId: 'STRANGER' });
    tracker.addPage(stranger);
    tracker.switchTo('elsewhere');

    await new Promise((r) => setTimeout(r, 10)); // let opener resolution settle
    expect((await tracker.describeActiveTab())!.unexpected).toBe(true);
  });

  it('does not flag a tab this session deliberately opened', async () => {
    // Our own `context.newPage()` and another session's are indistinguishable
    // from the event handler's side — both arrive with a null opener — so the
    // openPage action marks its own.
    const tracker = new PageTracker(fakePage({ targetId: 'MAIN' }));
    const ours = fakePage({ url: 'https://shop/new', targetId: 'OURS' });
    tracker.addPage(ours);
    tracker.markExpected(ours);
    tracker.switchTo('shop/new');

    expect((await tracker.describeActiveTab())!.unexpected).toBe(false);
  });

  it('does not flag a popup opened by a page we drive', async () => {
    const main = fakePage({ url: 'https://shop', targetId: 'MAIN' });
    const tracker = new PageTracker(main);
    const popup = fakePage({ url: 'https://shop/popup', targetId: 'POPUP', opener: main });
    tracker.addPage(popup);
    tracker.switchTo('popup');

    await new Promise((r) => setTimeout(r, 10));
    expect((await tracker.describeActiveTab())!.unexpected).toBe(false);
  });

  it('flags the popup of a tab it only ADOPTED — provenance does not launder', async () => {
    // Two hops, which is where "the opener is a page we track" and "the opener
    // is a page we account for" come apart. The user opens a tab mid-run (we
    // adopt it, unexpected), then clicks a `target=_blank` link in it. Clearing
    // on the opener's PRESENCE made the popup ours, and an errand closes what
    // is its own — so the safe answer here is the whole of house rule 1
    // (stories/errands.md).
    const main = fakePage({ url: 'https://shop', targetId: 'MAIN' });
    const tracker = new PageTracker(main);

    const theirs = fakePage({ url: 'https://news.example', targetId: 'THEIRS' });
    tracker.addPage(theirs);
    const theirPopup = fakePage({ url: 'https://news.example/story', targetId: 'THEIR-POPUP', opener: theirs });
    tracker.addPage(theirPopup);

    // The control, same tracker and same code path: an opener we DO account for
    // still clears its popup, so this is about the opener's flag rather than
    // opener resolution having stopped working.
    const ourPopup = fakePage({ url: 'https://shop/popup', targetId: 'OUR-POPUP', opener: main });
    tracker.addPage(ourPopup);

    await new Promise((r) => setTimeout(r, 10));
    const byId = new Map(tracker.tabs().map((entry) => [entry.targetId, entry.unexpected]));
    expect(byId.get('THEIRS')).toBe(true);
    expect(byId.get('THEIR-POPUP')).toBe(true);
    expect(byId.get('OUR-POPUP')).toBe(false);
  });

  it('the flag is advisory — it is not a status and cannot fail a step', async () => {
    const tracker = new PageTracker(fakePage({ targetId: 'MAIN' }));
    const stranger = fakePage({ url: 'https://elsewhere', targetId: 'STRANGER' });
    tracker.addPage(stranger);
    tracker.switchTo('elsewhere');
    const tab = await tracker.describeActiveTab();
    // Nothing but a boolean on a diagnostic object — no status, no error.
    expect(Object.keys(tab!).sort()).toEqual(['label', 'targetId', 'title', 'unexpected', 'url']);
  });
});

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

const TAB = (over: Record<string, unknown> = {}) => ({
  label: 'main',
  targetId: 'AAA111',
  url: 'https://shop',
  title: 'Shop',
  unexpected: false,
  ...over,
});

function fold(events: RunEvent[]) {
  return foldRun({
    events,
    receivedAt: events.map((_, i) => i * 10),
    streamDropped: false,
    dropped: [],
    sentSteps: ['one', 'two'],
    sourceLines: [1, 2],
    testFilePath: 'c:/proj/tests/x.md',
  });
}

describe('the fold carries tab through to the MCP step payload', () => {
  it('takes the tab from the terminal event', () => {
    const result = fold([
      { type: 'step:start', line: 1, tab: TAB() as never },
      { type: 'step:pass', line: 1, tab: TAB({ label: 'page:2', targetId: 'BBB222' }) as never },
      { type: 'done', status: 'passed' },
    ]);
    // A step that switched tabs is described by where it ENDED, which is the
    // whole diagnostic.
    expect(result.steps[0]!.tab).toMatchObject({ label: 'page:2', targetId: 'BBB222' });
  });

  it('carries the tab on a failure too', () => {
    const result = fold([
      { type: 'step:start', line: 1 },
      { type: 'step:fail', line: 1, error: 'boom', tab: TAB({ targetId: 'CCC333' }) as never },
      { type: 'done', status: 'failed' },
    ]);
    expect(result.steps[0]!.tab).toMatchObject({ targetId: 'CCC333' });
  });

  it('falls back to the start event when the stream drops before the terminal', () => {
    const result = fold([
      { type: 'step:start', line: 1, tab: TAB({ targetId: 'DDD444' }) as never },
    ]);
    expect(result.steps[0]!.tab).toMatchObject({ targetId: 'DDD444' });
  });

  it('is null — not undefined — when the server reported no tab', () => {
    // A MISSING key is fatal to validateToolOutput where a null is simply
    // "not reported".
    const result = fold([
      { type: 'step:start', line: 1 },
      { type: 'step:pass', line: 1 },
      { type: 'done', status: 'passed' },
    ]);
    expect(result.steps[0]!.tab).toBeNull();
  });

  it('keeps two sessions\u2019 identically-labelled tabs distinguishable', () => {
    // The assertion labels alone cannot make, and the reason targetId is on
    // the wire at all.
    const a = fold([
      { type: 'step:start', line: 1 },
      { type: 'step:pass', line: 1, tab: TAB({ label: 'page:2', targetId: 'SESSION-A-TAB' }) as never },
      { type: 'done', status: 'passed' },
    ]);
    const b = fold([
      { type: 'step:start', line: 1 },
      { type: 'step:pass', line: 1, tab: TAB({ label: 'page:2', targetId: 'SESSION-B-TAB' }) as never },
      { type: 'done', status: 'passed' },
    ]);
    expect(a.steps[0]!.tab!.label).toBe(b.steps[0]!.tab!.label);
    expect(a.steps[0]!.tab!.targetId).not.toBe(b.steps[0]!.tab!.targetId);
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function step(index: number, tab?: StepResult['tab']): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [],
    durationMs: 10,
    retried: false,
    ...(tab ? { tab } : {}),
  };
}

function report(steps: StepResult[]): TestReport {
  return {
    testName: 'checkout',
    filePath: 'c:/proj/tests/checkout.md',
    tags: [],
    baseUrl: 'https://shop',
    status: 'passed',
    date: new Date(0).toISOString(),
    durationMs: 100,
    totalSteps: steps.length,
    passedSteps: steps.length,
    failedSteps: 0,
    totalSubActions: 0,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    steps,
  };
}

describe('the report surfaces the tab', () => {
  it('shows a tab badge per step, with a short target id', () => {
    const html = renderReport(
      report([step(1, { label: 'page:2', targetId: 'AB12CD34EF', url: 'https://shop/cart', title: 'Cart', unexpected: false })]),
    );
    expect(html).toContain('class="badge badge-tab"');
    expect(html).toContain('page:2');
    expect(html).toContain('AB12CD');
    // The full id belongs in the tooltip, where it can be copied.
    expect(html).toContain('AB12CD34EF');
  });

  it('marks an unexpected tab distinctly and explains it', () => {
    const html = renderReport(
      report([step(1, { label: 'page:3', targetId: 'XX', url: 'https://elsewhere', title: 'Other', unexpected: true })]),
    );
    expect(html).toContain('badge-tab-unexpected');
    expect(html).toContain('another test running against the same browser');
  });

  it('omits the timeline for a single-tab run, which has nothing to explain', () => {
    const html = renderReport(
      report([step(1, { label: 'main', targetId: 'A', url: 'https://shop', title: 'Shop', unexpected: false })]),
    );
    // The markup, not the string — the stylesheet names these classes on
    // every report whether or not the block is rendered.
    expect(html).not.toContain('<div class="tab-timeline">');
  });

  it('shows the timeline once a run touched more than one tab', () => {
    const html = renderReport(
      report([
        step(1, { label: 'main', targetId: 'A', url: 'https://shop', title: 'Shop', unexpected: false }),
        step(2, { label: 'page:2', targetId: 'B', url: 'https://shop/cart', title: 'Cart', unexpected: false }),
      ]),
    );
    expect(html).toContain('tab-timeline');
    expect(html).toContain('first used at step 2');
  });

  it('shows the timeline for a single tab when that tab was unexpected', () => {
    const html = renderReport(
      report([step(1, { label: 'page:2', targetId: 'B', url: 'https://x', title: 'X', unexpected: true })]),
    );
    expect(html).toContain('tab-timeline');
    expect(html).toContain('not opened by this test');
  });

  it('groups by target id, so one tab used by many steps is one row', () => {
    const html = renderReport(
      report([
        step(1, { label: 'main', targetId: 'A', url: 'https://shop', title: 'Shop', unexpected: false }),
        step(2, { label: 'main', targetId: 'A', url: 'https://shop/2', title: 'Two', unexpected: false }),
        step(3, { label: 'page:2', targetId: 'B', url: 'https://shop/cart', title: 'Cart', unexpected: false }),
      ]),
    );
    const rows = html.split('tab-row').length - 1;
    // Two tabs, and the class only appears on the unexpected variant, so
    // count the id cells instead.
    expect(html.match(/class="tab-id"/g)).toHaveLength(2);
    expect(rows).toBeGreaterThanOrEqual(0);
  });

  it('renders unchanged for a run with no tab data at all', () => {
    // Older servers and clients predate the field; the report must degrade to
    // exactly what it showed before.
    const html = renderReport(report([step(1), step(2)]));
    expect(html).not.toContain('class="badge badge-tab');
    expect(html).not.toContain('<div class="tab-timeline">');
    expect(html).toContain('step 1');
  });
});
