import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
}

/**
 * Capture a full-viewport PNG screenshot and return it as base64.
 * Returns null if capture fails (non-fatal).
 */
export async function captureScreenshot(page: Page): Promise<ScreenshotResult | null> {
  try {
    const buffer = await page.screenshot({
      type: 'png',
      fullPage: false, // Viewport only for performance
    });

    const viewportSize = page.viewportSize();
    return {
      base64: buffer.toString('base64'),
      width: viewportSize?.width ?? 1280,
      height: viewportSize?.height ?? 720,
    };
  } catch (err) {
    logger.warn(`Screenshot capture failed: ${String(err)}`);
    return null;
  }
}

/**
 * Convert a base64 PNG string to a data URI for embedding in HTML.
 */
export function toDataUri(base64: string): string {
  return `data:image/png;base64,${base64}`;
}
