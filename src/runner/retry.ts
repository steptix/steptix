import { logger } from '../utils/logger.js';

export interface RetryOptions {
  maxRetries: number;
  /** Optional delay between retries in ms */
  delayMs?: number;
  /** Label for log messages */
  label?: string;
}

/**
 * Execute an async operation with retry logic.
 * Returns the result on success or throws the last error after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, delayMs = 0, label = 'operation' } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      if (attempt > 1) {
        logger.info(`Retrying ${label} (attempt ${attempt}/${maxRetries + 1})...`);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt <= maxRetries) {
        logger.warn(`${label} failed on attempt ${attempt}: ${String(err)}`);
      }
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
