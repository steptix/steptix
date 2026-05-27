import { logger } from './logger.js';

/** Soft warning threshold per step */
const STEP_TOKEN_WARNING = 100_000;

/** Tracks token usage across an entire test run */
export class TokenTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private stepTokens = 0;
  // Snapshot of the cumulative totals at the start of the current run. The
  // server reuses one TokenTracker for a session's whole lifetime, but each
  // run writes its own HTML report — `markRunStart()` records this baseline so
  // the `run*` getters report only the usage spent since, not the (ever-
  // growing) session-cumulative figure. A re-run that's fully cache-served
  // makes no AI calls and so should report ~0, not the prior run's total.
  private runStartInputTokens = 0;
  private runStartOutputTokens = 0;

  addUsage(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.stepTokens += inputTokens + outputTokens;
  }

  resetStep(): void {
    this.stepTokens = 0;
  }

  /**
   * Mark the start of a new run. The `run*` getters then report usage
   * accumulated after this point. Call once at each run/report boundary.
   * A fresh tracker (CLI/UI, one per run) need not call this — its run
   * totals equal its cumulative totals since the baseline is 0.
   */
  markRunStart(): void {
    this.runStartInputTokens = this.totalInputTokens;
    this.runStartOutputTokens = this.totalOutputTokens;
  }

  checkStepBudget(maxInputTokens: number): void {
    if (this.stepTokens > STEP_TOKEN_WARNING) {
      logger.tokenWarning(this.stepTokens, maxInputTokens);
    }
  }

  get total(): number {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  get inputTotal(): number {
    return this.totalInputTokens;
  }

  get outputTotal(): number {
    return this.totalOutputTokens;
  }

  /** Input tokens used since the last `markRunStart()` (or construction). */
  get runInputTotal(): number {
    return this.totalInputTokens - this.runStartInputTokens;
  }

  /** Output tokens used since the last `markRunStart()` (or construction). */
  get runOutputTotal(): number {
    return this.totalOutputTokens - this.runStartOutputTokens;
  }

  /** Total tokens used since the last `markRunStart()` (or construction). */
  get runTotal(): number {
    return this.runInputTotal + this.runOutputTotal;
  }

  getSummary(): string {
    return (
      `Input: ${this.totalInputTokens.toLocaleString()}, ` +
      `Output: ${this.totalOutputTokens.toLocaleString()}, ` +
      `Total: ${this.total.toLocaleString()}`
    );
  }
}

/**
 * Estimates token count for a string using a simple heuristic.
 * Accurate tiktoken encoding is used when available, with fallback to ~4 chars/token.
 */
export async function estimateTokens(text: string): Promise<number> {
  try {
    // tiktoken is optional — may not be available on all platforms
    const { get_encoding } = await import('tiktoken');
    const enc = get_encoding('cl100k_base');
    const tokens = enc.encode(text).length;
    enc.free();
    return tokens;
  } catch {
    // Fallback: approximate 4 characters per token
    return Math.ceil(text.length / 4);
  }
}

/**
 * Estimates token count for a base64 image.
 * Vision models typically charge ~765 tokens for a 512×512 tile at high detail.
 * We approximate based on image size.
 */
export function estimateImageTokens(base64Png: string): number {
  // Base64 length ≈ (rawBytes * 4/3)
  // A 1280×720 screenshot PNG is roughly 500–800 KB
  // GPT-4 vision tiles: ceil(width/512) * ceil(height/512) * 765 tokens
  // We approximate conservatively
  const estimatedBytes = (base64Png.length * 3) / 4;
  const estimatedKB = estimatedBytes / 1024;

  // Rough: 1KB of PNG ≈ 1–2 tokens of image data (tile-based)
  // For a 1280x720 image: 3 tiles wide * 2 tiles tall = 6 tiles * 765 = ~4590 tokens
  return Math.ceil(estimatedKB * 2) + 4590;
}
