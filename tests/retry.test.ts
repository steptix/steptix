import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/runner/retry.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('withRetry', () => {
  it('retries up to maxRetries + 1 times on failure (no signal)', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      throw new Error('boom');
    });
    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow('boom');
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('returns the first successful result without retrying', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      return 'ok';
    });
    await expect(withRetry(fn, { maxRetries: 2 })).resolves.toBe('ok');
    expect(attempts).toBe(1);
  });

  it('does NOT retry when the signal is aborted — rethrows immediately', async () => {
    // The whole point of the abort short-circuit (issue 020): a cancelled AI
    // call throws an AbortError; without this guard withRetry would fire a
    // second request after the user pressed stop.
    const ac = new AbortController();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      ac.abort(); // run stopped during the attempt
      throw new Error('aborted');
    });
    await expect(withRetry(fn, { maxRetries: 3, signal: ac.signal })).rejects.toThrow('aborted');
    expect(attempts).toBe(1); // no retry despite maxRetries: 3
  });
});

describe('withRetry — non-retryable failures (stories/upload-action.md §5)', () => {
  // Some failures are facts about the world, not bad plans: an upload whose
  // file is missing fails identically however many times it is re-planned,
  // and each retry costs a full AI turn.
  it('stops after one attempt when the error is tagged non-retryable', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      throw Object.assign(new Error('Upload file not found: C:/x.png'), { retryable: false });
    });

    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow('Upload file not found');
    expect(attempts).toBe(1);
  });

  it('rethrows the original error object, so callers can still inspect it', async () => {
    const error = Object.assign(new Error('nope'), { retryable: false, marker: 'kept' });
    const fn = vi.fn(async () => { throw error; });

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toBe(error);
  });

  // The composition that matters: the guard must not have turned every
  // failure into a one-shot.
  it('still retries an ordinary failure', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
      return 'ok';
    });

    await expect(withRetry(fn, { maxRetries: 3 })).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('ignores a truthy retryable flag', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      throw Object.assign(new Error('boom'), { retryable: true });
    });
    await expect(withRetry(fn, { maxRetries: 1 })).rejects.toThrow('boom');
    expect(attempts).toBe(2);
  });
});
