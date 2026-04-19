import type { Page } from 'playwright';
import { DEFAULT_BROWSER_DIMENSIONS } from '../config/browser-dimensions.js';
import { logger } from '../utils/logger.js';

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
}

/**
 * Capture a PNG screenshot and return it as base64.
 * @param page - Playwright page
 * @param fullPage - When true, captures the entire scrollable page instead of just the viewport.
 * Returns null if capture fails (non-fatal).
 */
export async function captureScreenshot(page: Page, fullPage = false): Promise<ScreenshotResult | null> {
  try {
    const buffer = await page.screenshot({
      type: 'png',
      fullPage,
    });

    if (fullPage) {
      // For full-page screenshots, read actual dimensions from the PNG header
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { base64: buffer.toString('base64'), width, height };
    }

    const viewportSize = page.viewportSize();
    return {
      base64: buffer.toString('base64'),
      width: viewportSize?.width ?? DEFAULT_BROWSER_DIMENSIONS.width,
      height: viewportSize?.height ?? DEFAULT_BROWSER_DIMENSIONS.height,
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
