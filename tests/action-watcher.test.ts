import { describe, it, expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { armActionWatcher, SettleTracker } from '../src/browser/page-state.js';

/**
 * The wait after a compiled action (docs/specs/SPEC-codebehind-robustness.md
 * §6.4): first-party requests that began while it was armed, then the page
 * quiet — bounded, and never a failure.
 *
 * A fake context, page and clock throughout. `sleep` advances the clock and
 * fires whatever the test scheduled up to the new time, so a request that
 * "takes 1.5 s" finishes when the clock says so and nothing waits for real.
 */

const ORIGIN = 'http://localhost:8787';

interface FakeRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  frame(): { parentFrame(): unknown };
}

function request(url: string, opts: { method?: string; type?: string; navigation?: boolean; child?: boolean } = {}): FakeRequest {
  return {
    url: () => url,
    method: () => opts.method ?? 'GET',
    resourceType: () => opts.type ?? 'fetch',
    isNavigationRequest: () => opts.navigation === true,
    frame: () => ({ parentFrame: () => (opts.child ? {} : null) }),
  };
}

/** A world: a clock, a timeline of scheduled events, an emitter context, and a
 *  page whose fingerprint the test sets. */
function world(start = 0) {
  let clock = start;
  const timeline: Array<{ at: number; fire: () => void }> = [];
  const listeners = new Map<string, Set<(r: unknown) => void>>();
  let fingerprint: string | undefined = '100:50:10';
  let url = `${ORIGIN}/index.html`;
  const context = {
    on: (event: string, fn: (r: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off: (event: string, fn: (r: unknown) => void) => listeners.get(event)?.delete(fn),
  } as unknown as BrowserContext;
  const emit = (event: string, r: unknown): void => {
    for (const fn of listeners.get(event) ?? []) fn(r);
  };
  const page = {
    url: () => url,
    isClosed: () => false,
    evaluate: async () => {
      if (fingerprint === undefined) throw new Error('Execution context was destroyed');
      const [bodyLen, textLen, elCount] = fingerprint.split(':').map(Number);
      return { bodyLen, textLen, elCount };
    },
  } as unknown as Page;
  const at = (ms: number, fire: () => void): void => {
    timeline.push({ at: ms, fire });
    timeline.sort((a, b) => a.at - b.at);
  };
  const sleep = async (ms: number): Promise<void> => {
    const target = clock + ms;
    while (timeline.length > 0 && timeline[0]!.at <= target) {
      const next = timeline.shift()!;
      clock = Math.max(clock, next.at);
      next.fire();
    }
    clock = target;
  };
  return {
    context,
    page,
    now: () => clock,
    sleep,
    at,
    begin: (r: FakeRequest) => emit('request', r),
    finish: (r: FakeRequest) => emit('requestfinished', r),
    fail: (r: FakeRequest) => emit('requestfailed', r),
    setFingerprint: (fp: string | undefined) => {
      fingerprint = fp;
    },
    navigate: (to: string) => {
      url = to;
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const OPTIONS = { budgetMs: 10_000, quietMs: 600, quickExitMs: 250, pollMs: 50 };

function arm(w: ReturnType<typeof world>, over: Partial<typeof OPTIONS> = {}) {
  return armActionWatcher(w.context, w.page, { ...OPTIONS, ...over, now: w.now, sleep: w.sleep });
}

describe('armActionWatcher — what it waits for', () => {
  it('quick exit: nothing tracked and nothing changed stops at about 250 ms', async () => {
    const w = world();
    const watcher = arm(w);
    const report = await watcher.settle();
    expect(report.tracked).toBe(0);
    expect(report.stillPending).toEqual([]);
    expect(report.waitedMs).toBeGreaterThanOrEqual(250);
    expect(report.waitedMs).toBeLessThan(400);
    watcher.dispose();
  });

  it('waits for a first-party request, then for 600 ms of quiet', async () => {
    const w = world();
    const watcher = arm(w);
    const api = request(`${ORIGIN}/api/login`, { method: 'POST' });
    w.begin(api);
    w.at(1500, () => {
      w.finish(api);
      w.setFingerprint('200:90:20');
    });
    const report = await watcher.settle();
    expect(report.tracked).toBe(1);
    expect(w.now()).toBeGreaterThanOrEqual(1500 + 600);
    expect(w.now()).toBeLessThan(1500 + 600 + 200);
    watcher.dispose();
  });

  it('tracks a chained request — the navigation a login answer starts — until it is done', async () => {
    const w = world();
    const watcher = arm(w);
    const api = request(`${ORIGIN}/api/login`, { method: 'POST' });
    const nav = request(`${ORIGIN}/dashboard.html`, { type: 'document', navigation: true });
    w.begin(api);
    w.at(300, () => {
      w.finish(api);
      w.begin(nav);
      w.setFingerprint(undefined); // between documents
      w.navigate(`${ORIGIN}/dashboard.html`);
    });
    w.at(900, () => {
      w.finish(nav);
      w.setFingerprint('400:200:40');
    });
    const report = await watcher.settle();
    expect(report.tracked).toBe(2);
    expect(w.now()).toBeGreaterThanOrEqual(900 + 600);
    watcher.dispose();
  });

  it('ignores a request open when it was armed — a long-poll the page already had', async () => {
    const w = world();
    const longPoll = request(`${ORIGIN}/api/events`);
    w.begin(longPoll); // before arming: nobody is listening yet
    const watcher = arm(w);
    w.at(5000, () => w.finish(longPoll));
    const report = await watcher.settle();
    expect(report.tracked).toBe(0);
    expect(w.now()).toBeLessThan(400);
    watcher.dispose();
  });

  it('ignores a third-party request, and the kinds of request that are never the action\'s answer', async () => {
    const w = world();
    const watcher = arm(w);
    w.begin(request('https://analytics.example.com/collect', { method: 'POST' }));
    w.begin(request(`${ORIGIN}/logo.png`, { type: 'image' }));
    w.begin(request(`${ORIGIN}/app.js`, { type: 'script' }));
    w.begin(request(`${ORIGIN}/socket`, { type: 'websocket' }));
    w.begin(request(`${ORIGIN}/stream`, { type: 'eventsource' }));
    w.begin(request(`${ORIGIN}/beacon`, { type: 'ping' }));
    const report = await watcher.settle();
    expect(report.tracked).toBe(0);
    expect(w.now()).toBeLessThan(400);
    watcher.dispose();
  });

  it('always counts a main-frame navigation, even to another site — an SSO hop', async () => {
    const w = world();
    const watcher = arm(w);
    const sso = request('https://login.example.com/authorize', { type: 'document', navigation: true });
    w.begin(sso);
    w.at(700, () => {
      w.finish(sso);
      w.setFingerprint('10:10:10');
    });
    const report = await watcher.settle();
    expect(report.tracked).toBe(1);
    expect(w.now()).toBeGreaterThanOrEqual(1300);
    watcher.dispose();
  });

  it('waits for a poll that begins in the window — up to the budget, then reports it and does not fail', async () => {
    const w = world();
    const watcher = arm(w, { budgetMs: 2000 });
    w.begin(request(`${ORIGIN}/api/slow?x=1`, { method: 'POST' }));
    const report = await watcher.settle();
    expect(report.stillPending).toEqual(['POST /api/slow']);
    expect(report.waitedMs).toBeGreaterThanOrEqual(2000);
    expect(report.waitedMs).toBeLessThan(2200);
    watcher.dispose();
  });

  it('a failed request ends like a finished one', async () => {
    const w = world();
    const watcher = arm(w);
    const api = request(`${ORIGIN}/api/x`);
    w.begin(api);
    w.at(200, () => w.fail(api));
    const report = await watcher.settle();
    expect(report.stillPending).toEqual([]);
    expect(w.now()).toBeGreaterThanOrEqual(800);
    watcher.dispose();
  });

  it('waits out a DOM that keeps changing with no request, until it holds still', async () => {
    const w = world();
    const watcher = arm(w);
    w.setFingerprint('101:50:10'); // the entry's own click changed the page
    w.at(400, () => w.setFingerprint('102:50:10'));
    const report = await watcher.settle();
    expect(report.tracked).toBe(0);
    expect(w.now()).toBeGreaterThanOrEqual(400 + 600);
    watcher.dispose();
  });

  it('skips entirely when there was no DOM signal when it was armed', async () => {
    const w = world();
    w.setFingerprint(undefined);
    const watcher = arm(w);
    w.begin(request(`${ORIGIN}/api/x`));
    const report = await watcher.settle();
    expect(report).toEqual({ waitedMs: 0, tracked: 0, stillPending: [] });
    expect(w.now()).toBe(0);
    watcher.dispose();
  });

  it('a second settle waits only for what began after the first', async () => {
    const w = world();
    const watcher = arm(w);
    const api = request(`${ORIGIN}/api/a`);
    w.begin(api);
    w.at(100, () => w.finish(api));
    await watcher.settle();
    const after = w.now();
    const second = await watcher.settle();
    expect(second.tracked).toBe(0);
    expect(w.now() - after).toBeLessThan(400);
    watcher.dispose();
  });

  it('returns at once when the run is stopped', async () => {
    const w = world();
    const watcher = arm(w);
    w.begin(request(`${ORIGIN}/api/x`));
    const abort = new AbortController();
    abort.abort();
    const report = await watcher.settle(abort.signal);
    expect(w.now()).toBe(0);
    expect(report.waitedMs).toBe(0);
    watcher.dispose();
  });

  it('removes its listeners on dispose', () => {
    const w = world();
    const watcher = arm(w);
    expect(w.listenerCount()).toBe(3);
    watcher.dispose();
    expect(w.listenerCount()).toBe(0);
  });
});

describe('SettleTracker — the rules, with no clock at all', () => {
  const tracker = (): SettleTracker => new SettleTracker(0, 'a', { budgetMs: 1000, quietMs: 100, quickExitMs: 50 });

  it('waits while a request is pending, then for quiet after it ends', () => {
    const t = tracker();
    t.requestBegan('r', 'GET /x', 10);
    expect(t.decide(500)).toBe('wait');
    t.requestEnded('r', 600);
    expect(t.decide(650)).toBe('wait');
    expect(t.decide(700)).toBe('settled');
  });

  it('quick-exits when nothing happened', () => {
    const t = tracker();
    expect(t.decide(40)).toBe('wait');
    expect(t.decide(50)).toBe('quick-exit');
  });

  it('a sample that differs is a change, and resets the quiet', () => {
    const t = tracker();
    t.sampled('b', 30);
    expect(t.decide(60)).toBe('wait');
    expect(t.decide(130)).toBe('settled');
  });

  it('stops at the budget with the pending requests named', () => {
    const t = tracker();
    t.requestBegan('r', 'POST /api/slow', 10);
    expect(t.decide(1000)).toBe('budget');
    expect(t.stillPending()).toEqual(['POST /api/slow']);
  });

  it('ignores the end of a request it never saw begin', () => {
    const t = tracker();
    t.requestEnded('stranger', 30);
    expect(t.decide(50)).toBe('quick-exit');
  });
});
