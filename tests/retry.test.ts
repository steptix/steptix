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
