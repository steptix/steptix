import type { Page } from 'playwright';
import type { AIAction } from '../ai/types.js';
import { logger } from '../utils/logger.js';

/** Result of executing a single Playwright action */
export interface ActionExecutionResult {
  success: boolean;
  error?: string;
  /** The selector that was used (for failure context on retry) */
  failedSelector?: string;
  /** How many elements matched the selector (0 = not found, >1 = ambiguous) */
  matchCount?: number;
  /** Value captured by a "read" action */
  capturedValue?: string;
}

/**
 * Execute a single AI action via Playwright.
 * Maps each action type to the corresponding Playwright API call.
 */
export async function executeAction(
  page: Page,
  action: AIAction,
  baseUrl?: string,
): Promise<ActionExecutionResult> {
  logger.subAction(action.description);

  try {
    switch (action.action) {
      case 'click':
        await executeClick(page, action);
        break;

      case 'type':
        await executeType(page, action);
        break;

      case 'select':
        await executeSelect(page, action);
        break;

      case 'navigate':
        await executeNavigate(page, action, baseUrl);
        break;

      case 'upload':
        await executeUpload(page, action);
        break;

      case 'hover':
        await executeHover(page, action);
        break;

      case 'wait':
        await executeWait(page, action);
        break;

      case 'scroll':
        await executeScroll(page, action);
        break;

      case 'switchFrame':
        // Frame switching is handled at a higher level
        logger.debug(`switchFrame action: ${action.selector ?? 'default'}`);
        break;

      case 'dismiss':
        await executeDismiss(page, action);
        break;

      case 'keyboard':
      case 'keypress':
        await executeKeyboard(page, action);
        break;

      case 'assert':
        // Assertions are evaluated by the AI — no Playwright action needed
        logger.debug(`assert action: ${action.description}`);
        break;

      case 'prompt':
        // Prompt actions are handled at the step executor level
        logger.debug(`prompt action: ${action.question ?? action.description}`);
        break;

      case 'read': {
        const captured = await executeRead(page, action);
        return { success: true, capturedValue: captured };
      }

      default:
        logger.warn(`Unknown action type: ${(action as AIAction).action}`);
    }

    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Action failed [${action.action}]: ${errorMessage}`);

    // Count how many elements matched the selector for retry context
    let matchCount: number | undefined;
    if (action.selector) {
      try {
        matchCount = await page.locator(action.selector).count();
      } catch {
        // Selector itself may be invalid — leave matchCount undefined
      }
    }

    return {
      success: false,
      error: errorMessage,
      ...(action.selector !== undefined && { failedSelector: action.selector }),
      ...(matchCount !== undefined && { matchCount }),
    };
  }
}

async function executeClick(page: Page, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  await page.locator(selector).locator('visible=true').first().click({ timeout: 10_000 });
}

async function executeType(page: Page, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  const value = action.value ?? '';
  const locator = page.locator(selector).locator('visible=true').first();
  // Clear existing content first, then type
  await locator.clear({ timeout: 5_000 });
  await locator.fill(value, { timeout: 10_000 });
}

async function executeSelect(page: Page, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  const value = action.value ?? '';
  await page.locator(selector).locator('visible=true').first().selectOption(value, { timeout: 10_000 });
}

async function executeNavigate(page: Page, action: AIAction, baseUrl?: string): Promise<void> {
  let url = action.url ?? action.value ?? '';

  if (!url) {
    throw new Error('navigate action requires a url or value');
  }

  // Resolve relative URLs against baseUrl
  if (url.startsWith('/') && baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    url = `${base}${url}`;
  } else if (!url.startsWith('http') && baseUrl) {
    url = `${baseUrl.replace(/\/$/, '')}/${url}`;
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
}

async function executeUpload(page: Page, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  const filePath = action.filePath ?? action.value ?? '';
  if (!filePath) throw new Error('upload action requires a filePath');
  await page.locator(selector).locator('visible=true').first().setInputFiles(filePath, { timeout: 10_000 });
}

async function executeHover(page: Page, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  await page.locator(selector).locator('visible=true').first().hover({ timeout: 10_000 });
}

/**
 * Parse a duration string into milliseconds.
 * Supports simple ("30s", "2 minutes", "500ms") and compound ("1m 30s", "1 min 10 sec") formats.
 */
function parseDuration(value: string): number | null {
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|sec|m|minutes?|min)/gi;
  let totalMs = 0;
  let matched = false;

  for (const match of value.matchAll(pattern)) {
    matched = true;
    const num = parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    if (unit.startsWith('ms') || unit.startsWith('millisecond')) totalMs += num;
    else if (unit.startsWith('s') || unit === 'sec') totalMs += num * 1_000;
    else if (unit.startsWith('m')) totalMs += num * 60_000;
  }

  return matched ? Math.round(totalMs) : null;
}

async function executeWait(page: Page, action: AIAction): Promise<void> {
  const condition = action.condition ?? action.value ?? '';
  const timeout = action.timeout ?? 10_000;

  // Duration-based sleep: "30s", "2m", "500ms", "30 seconds", etc.
  const durationMs = parseDuration(condition);
  if (durationMs !== null) {
    await page.waitForTimeout(durationMs);
    return;
  }

  // Detect CSS selectors: starts with tag name, #, ., or [
  const looksLikeSelector = /^([a-z][a-z0-9]*(\[|#|\.| |,|:)|[#.\[])/.test(condition);
  if (looksLikeSelector) {
    // CSS selector — use 'attached' state so hidden inputs (type="hidden") don't time out.
    // Playwright's default state is 'visible', which hidden elements never satisfy.
    await page.waitForSelector(condition, { state: 'attached', timeout });
  } else if (condition.startsWith('http') || condition.includes('/')) {
    // URL pattern
    await page.waitForURL(condition, { timeout });
  } else if (condition === 'networkidle') {
    await page.waitForLoadState('networkidle', { timeout });
  } else if (condition === 'load') {
    await page.waitForLoadState('load', { timeout });
  } else {
    // Generic wait for condition text to appear
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (text) => (globalThis as any).document.body.textContent?.includes(text) ?? false,
      condition,
      { timeout },
    );
  }
}

async function executeScroll(page: Page, action: AIAction): Promise<void> {
  const direction = action.direction ?? 'down';
  const amount = action.amount ?? 300;

  const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;

  await page.mouse.wheel(deltaX, deltaY);
}

async function executeDismiss(page: Page, action: AIAction): Promise<void> {
  const selector = action.selector;

  if (selector) {
    try {
      const locator = page.locator(selector).locator('visible=true').first();
      if (await locator.isVisible({ timeout: 3_000 })) {
        await locator.click({ timeout: 5_000 });
        return;
      }
    } catch {
      // Element not found or not clickable — try common dismiss patterns
    }
  }

  // Try common dismiss button patterns
  const dismissPatterns = [
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("Close")',
    'button:has-text("OK")',
    'button:has-text("Dismiss")',
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
    '.close-button',
    '#cookie-accept',
  ];

  for (const pattern of dismissPatterns) {
    try {
      const el = page.locator(pattern).first();
      if (await el.isVisible({ timeout: 1_000 })) {
        await el.click({ timeout: 3_000 });
        logger.debug(`Dismissed element matching: ${pattern}`);
        return;
      }
    } catch {
      // Try next pattern
    }
  }

  logger.debug('No dismiss target found — continuing');
}

async function executeKeyboard(page: Page, action: AIAction): Promise<void> {
  const key = action.key ?? action.value ?? '';
  if (!key) throw new Error('keyboard action requires a key');
  await page.keyboard.press(key);
}

function requireSelector(action: AIAction): string {
  if (!action.selector) {
    throw new Error(`Action "${action.action}" requires a selector but none was provided`);
  }
  return action.selector;
}

/**
 * Read the value or text content of an element.
 * Tries the element's `value` attribute first (for inputs), falls back to `textContent`.
 */
async function executeRead(page: Page, action: AIAction): Promise<string> {
  const selector = requireSelector(action);
  logger.subAction(`read ${selector} → ${action.as ?? '(unnamed)'}`);
  const value = await page.$eval(selector, (el) => {
    if ('value' in el && typeof (el as { value: unknown }).value === 'string') {
      return (el as { value: string }).value;
    }
    return el.textContent?.trim() ?? '';
  });
  logger.info(`read captured: "${value}" → variable "${action.as ?? '(unnamed)'}"`);
  return value;
}
