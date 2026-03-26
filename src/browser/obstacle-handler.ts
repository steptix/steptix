import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';

/**
 * Patterns for common UI obstacles that should be auto-dismissed.
 * Each entry has a selector and an optional label for logging.
 */
const OBSTACLE_PATTERNS: Array<{ selector: string; label: string }> = [
  { selector: '[data-testid="cookie-banner"]', label: 'cookie banner' },
  { selector: '#cookie-consent', label: 'cookie consent' },
  { selector: '.cookie-banner', label: 'cookie banner' },
  { selector: '[aria-label="cookie consent"]', label: 'cookie consent' },
  { selector: '.modal-overlay:visible', label: 'modal overlay' },
  { selector: '[role="dialog"]:visible', label: 'dialog' },
  { selector: '[role="alertdialog"]:visible', label: 'alert dialog' },
  { selector: '.announcement-banner:visible', label: 'announcement banner' },
  { selector: '[data-testid="modal"]:visible', label: 'modal' },
];

const DISMISS_BUTTON_PATTERNS = [
  'button:has-text("Accept All")',
  'button:has-text("Accept Cookies")',
  'button:has-text("Accept")',
  'button:has-text("I Accept")',
  'button:has-text("Got it")',
  'button:has-text("OK")',
  'button:has-text("Close")',
  'button:has-text("Dismiss")',
  'button:has-text("No thanks")',
  '[aria-label="Close"]',
  '[aria-label="Dismiss"]',
  '[data-testid="dismiss"]',
  '[data-testid="close"]',
  '.modal-close',
  '.close-btn',
];

export interface ObstacleResult {
  found: boolean;
  dismissed: boolean;
  label?: string;
}

/**
 * Check for and attempt to dismiss unexpected UI obstacles (banners, modals, etc.).
 * Called before each step to ensure a clean page state.
 */
export async function handleObstacles(page: Page): Promise<ObstacleResult[]> {
  const results: ObstacleResult[] = [];

  // Check for known obstacle patterns
  for (const { selector, label } of OBSTACLE_PATTERNS) {
    try {
      const el = page.locator(selector).first();
      const isVisible = await el.isVisible({ timeout: 500 });

      if (isVisible) {
        logger.debug(`Obstacle detected: ${label}`);
        const dismissed = await tryDismissObstacle(page, el.toString(), label);
        results.push({ found: true, dismissed, label });
      }
    } catch {
      // Obstacle not present — continue
    }
  }

  // Also check for any visible dismiss buttons that indicate an overlay is present
  for (const pattern of DISMISS_BUTTON_PATTERNS) {
    try {
      const btn = page.locator(pattern).first();
      if (await btn.isVisible({ timeout: 300 })) {
        logger.debug(`Found dismissible element: ${pattern}`);
        await btn.click({ timeout: 3_000 });
        logger.info(`Auto-dismissed: ${pattern}`);
        results.push({ found: true, dismissed: true, label: pattern });
        // Wait briefly for the animation to complete
        await page.waitForTimeout(300);
        break; // Only dismiss one at a time
      }
    } catch {
      // Button not interactable — try next
    }
  }

  return results;
}

async function tryDismissObstacle(
  page: Page,
  obstacleSelector: string,
  label: string,
): Promise<boolean> {
  // Look for a dismiss button within or near the obstacle
  for (const btnPattern of DISMISS_BUTTON_PATTERNS) {
    try {
      const btn = page.locator(btnPattern).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 3_000 });
        logger.info(`Auto-dismissed ${label} via: ${btnPattern}`);
        await page.waitForTimeout(300);
        return true;
      }
    } catch {
      // Try next pattern
    }
  }

  // Try pressing Escape to close modals
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Check if the obstacle is still visible
    const el = page.locator(obstacleSelector).first();
    const stillVisible = await el.isVisible({ timeout: 500 });
    if (!stillVisible) {
      logger.info(`Dismissed ${label} via Escape key`);
      return true;
    }
  } catch {
    // Escape didn't work
  }

  logger.warn(`Could not dismiss obstacle: ${label} — continuing anyway`);
  return false;
}
