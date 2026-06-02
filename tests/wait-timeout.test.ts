import { describe, it, expect, vi } from 'vitest';
import {
  clampWaitTimeout,
  executeWait,
  executeAction,
  withAbort,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
} from '../src/browser/actions.js';
import type { AIAction } from '../src/ai/types.js';

const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

describe('clampWaitTimeout (issue 022)', () => {
  it('honours a valid positive hint', () => {
    expect(clampWaitTimeout(90_000)).toBe(90_000);
  });

  it('caps an over-large hint at MAX_WAIT_TIMEOUT_MS', () => {
    expect(clampWaitTimeout(999_999_999)).toBe(MAX_WAIT_TIMEOUT_MS);
  });

  it('treats the cap boundary inclusively (== MAX passes, MAX+1 clamps)', () => {
    expect(clampWaitTimeout(MAX_WAIT_TIMEOUT_MS)).toBe(MAX_WAIT_TIMEOUT_MS);
    expect(clampWaitTimeout(MAX_WAIT_TIMEOUT_MS + 1)).toBe(MAX_WAIT_TIMEOUT_MS);
  });

  it('falls back to the default when no hint is given', () => {
    expect(clampWaitTimeout(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  });

  it('falls back to the default for non-positive or non-finite hints', () => {
    expect(clampWaitTimeout(0)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(clampWaitTimeout(-5)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(clampWaitTimeout(Number.NaN)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(clampWaitTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  });

  it('the default is below the cap (sanity)', () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBeLessThan(MAX_WAIT_TIMEOUT_MS);
  });
});

describe('executeWait forwards the clamped timeout to Playwright (issue 022)', () => {
  /** Minimal mock Page with just the wait methods exercised here. */
  function mockPage() {
    return {
      waitForURL: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
    };
  }

  it('forwards an AI-supplied url-wait timeout hint verbatim', async () => {
    const page = mockPage();
    const action: AIAction = {
      action: 'wait', waitType: 'url', condition: '**/newurl', timeout: 90_000,
      description: 'Wait up to 90s for /newurl',
    };
    await executeWait(page as any, page as any, action);

    expect(page.waitForURL).toHaveBeenCalledTimes(1);
    expect(page.waitForURL).toHaveBeenCalledWith('**/newurl', { timeout: 90_000 });
  });

  it('forwards the CAPPED timeout when the hint exceeds the max', async () => {
    const page = mockPage();
    const action: AIAction = {
      action: 'wait', waitType: 'url', condition: '**/x', timeout: 999_999_999,
      description: 'absurd hint',
    };
    await executeWait(page as any, page as any, action);

    expect(page.waitForURL).toHaveBeenCalledWith('**/x', { timeout: MAX_WAIT_TIMEOUT_MS });
  });

  it('forwards the default timeout when no hint is given (selector wait)', async () => {
    const page = mockPage();
    const action: AIAction = {
      action: 'wait', waitType: 'selector', condition: '#ready',
      description: 'Wait for #ready',
    };
    await executeWait(page as any, page as any, action);

    expect(page.waitForSelector).toHaveBeenCalledWith('#ready', {
      state: 'visible',
      timeout: DEFAULT_WAIT_TIMEOUT_MS,
    });
  });

  it('forwards the timeout in the OPTIONS arg of waitForFunction (text wait — different arg position)', async () => {
    const page = mockPage();
    const action: AIAction = {
      action: 'wait', waitType: 'text', condition: 'Welcome', timeout: 45_000,
      description: 'Wait for the welcome text',
    };
    await executeWait(page as any, page as any, action);

    expect(page.waitForFunction).toHaveBeenCalledTimes(1);
    // Signature: waitForFunction(fn, arg, { timeout }) — timeout is the 3rd arg.
    const call = page.waitForFunction.mock.calls[0]!;
    expect(call[1]).toBe('Welcome');
    expect(call[2]).toEqual({ timeout: 45_000 });
  });

  it('duration waits ignore the timeout hint — they sleep the parsed duration', async () => {
    const page = mockPage();
    const action: AIAction = {
      action: 'wait', waitType: 'duration', condition: '2s', timeout: 90_000,
      description: 'Wait 2 seconds',
    };
    await executeWait(page as any, page as any, action);

    expect(page.waitForTimeout).toHaveBeenCalledWith(2000); // parsed condition, not the hint
    expect(page.waitForURL).not.toHaveBeenCalled();
  });
});

describe('withAbort — abort-aware waits (issue 022)', () => {
  it('returns the work promise unchanged when no signal is given', async () => {
    await expect(withAbort(Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('rejects immediately with AbortError when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const never = new Promise<void>(() => undefined); // would hang forever
    await expect(withAbort(never, ac.signal)).rejects.toSatisfy(isAbortError);
  });

  it('rejects with AbortError as soon as the signal fires mid-wait', async () => {
    const ac = new AbortController();
    const never = new Promise<void>(() => undefined);
    const p = withAbort(never, ac.signal);
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('resolves normally when work finishes before any abort', async () => {
    const ac = new AbortController();
    await expect(withAbort(Promise.resolve(42), ac.signal)).resolves.toBe(42);
  });

  it('removes its abort listener once work settles (no leak on the run signal)', async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await withAbort(Promise.resolve('done'), ac.signal);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('removes its abort listener on the work-rejects path too', async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await expect(withAbort(Promise.reject(new Error('boom')), ac.signal)).rejects.toThrow('boom');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('swallows a late orphan rejection after an abort (no unhandled rejection)', async () => {
    const ac = new AbortController();
    let rejectWork!: (e: unknown) => void;
    const work = new Promise<void>((_resolve, reject) => { rejectWork = reject; });
    const p = withAbort(work, ac.signal);
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
    // The orphaned work rejects later (e.g. page closed during teardown). It must
    // not surface as an unhandled rejection — reaching the end cleanly is the assertion.
    rejectWork(new Error('page closed'));
    await Promise.resolve();
  });
});

describe('executeAction rethrows on abort instead of returning a failed result (issue 022)', () => {
  it('throws an AbortError when the run is stopped mid-wait', async () => {
    const ac = new AbortController();
    const page = { waitForURL: vi.fn(() => new Promise<void>(() => undefined)) };
    const action: AIAction = {
      action: 'wait', waitType: 'url', condition: '**/slow', description: 'slow wait',
    };
    const p = executeAction(page as any, action, undefined, ac.signal);
    ac.abort();
    // Must THROW (so the run loop reports `aborted`), not resolve to { success: false }.
    await expect(p).rejects.toSatisfy(isAbortError);
  });
});

describe('executeWait is abort-aware (issue 022)', () => {
  it('rejects with AbortError when the run is stopped mid-wait, instead of waiting out the timeout', async () => {
    const ac = new AbortController();
    const page = {
      // A wait that never resolves on its own — only the abort can end it.
      waitForURL: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const action: AIAction = {
      action: 'wait', waitType: 'url', condition: '**/slow', timeout: 600_000,
      description: 'Wait up to 10 min for a slow nav',
    };

    const p = executeWait(page as any, page as any, action, ac.signal);
    ac.abort(); // user hits Stop
    await expect(p).rejects.toSatisfy(isAbortError);
  });
});
