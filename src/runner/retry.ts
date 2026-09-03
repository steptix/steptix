import { logger } from '../utils/logger.js';

export interface RetryOptions {
  maxRetries: number;
  /** Optional delay between retries in ms */
  delayMs?: number;
  /** Label for log messages */
  label?: string;
  /** Called after each failed attempt, before the next retry */
  onFailure?: (err: unknown) => void;
  /** Run abort signal. When it fires, the operation isn't retried — the last
   *  error rethrows immediately. Without this, a cancelled AI call (which throws
   *  an AbortError) would burn a retry firing a second request after "stop". */
  signal?: AbortSignal;
}

/**
 * Execute an async operation with retry logic.
 * Returns the result on success or throws the last error after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, delayMs = 0, label = 'operation', onFailure, signal } = options;
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
      // Don't retry an aborted operation — the run was stopped. Rethrow now so
      // the caller surfaces the abort instead of issuing another attempt.
      if (signal?.aborted) {
        throw err;
      }
      // Some failures are facts about the world, not bad plans: an upload whose
      // file is missing, is a folder, or sits outside the project fails the same
      // way however many times it is re-planned, and each retry costs a full AI
      // turn. The action layer tags those; honour the tag before the warning
      // below, so the log says the retries were skipped on purpose rather than
      // implying another attempt is coming.
      if (isNonRetryable(err)) {
        logger.warn(`${label} failed and will not be retried: ${errorText(err)}`);
        // Still hand the attempt to `onFailure`: it is what carries the turns
        // into the failed result, and without it the report shows the error
        // with no sub-actions, no screenshot and no reasoning behind it.
        onFailure?.(err);
        throw err;
      }
      if (attempt <= maxRetries) {
        logger.warn(`${label} failed on attempt ${attempt}: ${String(err)}`);
        onFailure?.(err);
      }
    }
  }

  throw lastError;
}

/** Did the thrower ask us not to retry? Structural, so any layer can tag an
 *  error without importing a class. */
function isNonRetryable(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && (err as { retryable?: unknown }).retryable === false
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
