import type { Page, FrameLocator } from 'playwright';
import type { AIAction } from '../ai/types.js';
import { logger } from '../utils/logger.js';

/**
 * Resolves the locator root for an action.
 * When action.frame is set, returns a FrameLocator scoped to that iframe.
 * For nested iframes, the frame selector can chain levels with " >> "
 * (e.g. "#outer-frame >> #inner-frame"), producing a nested FrameLocator.
 * Space-separated selectors (e.g. "#outer #inner") are also accepted as a
 * fallback since AI models sometimes produce CSS-style descendant selectors
 * instead of the canonical ">>" chain syntax.
 * Otherwise returns the top-level Page.
 * Both Page and FrameLocator expose .locator(), so callers are type-compatible.
 */
function resolveLocatorRoot(page: Page, frameSelector?: string): Page | FrameLocator {
  if (!frameSelector) return page;

  // Split on ">>" if present, otherwise fall back to splitting on whitespace.
  const segments = frameSelector.includes('>>')
    ? frameSelector.split('>>').map((s) => s.trim()).filter(Boolean)
    : frameSelector.trim().split(/\s+/);

  let root: Page | FrameLocator = page;
  for (const segment of segments) {
    root = root.frameLocator(segment);
  }
  return root;
}

/**
 * Detect when the AI placed an iframe selector at the start of the element
 * selector instead of in the frame field. If the first space-separated segment
 * of `selector` matches an `<iframe>` inside the current frame context, strip
 * it from the selector and append it to the frame chain.
 *
 * Example: frame="#advisor-frame", selector="#chat-frame #chat-input"
 *       → frame="#advisor-frame >> #chat-frame", selector="#chat-input"
 */
async function promoteIframeFromSelector(
  page: Page,
  frame: string | undefined,
  selector: string,
): Promise<{ frame: string | undefined; selector: string }> {
  const parts = selector.trim().split(/\s+/);
  if (parts.length < 2) return { frame, selector };

  const candidate = parts[0]!;
  // Check if the candidate matches an iframe in the current frame context
  const root = resolveLocatorRoot(page, frame);
  const isIframe = await root
    .locator(`iframe${candidate}`)
    .count()
    .catch(() => 0);

  if (isIframe > 0) {
    const newFrame = frame ? `${frame} >> ${candidate}` : candidate;
    const newSelector = parts.slice(1).join(' ');
    logger.debug(`Promoted iframe from selector: frame="${newFrame}", selector="${newSelector}"`);
    // Recurse in case there are multiple nested iframes in the selector
    return promoteIframeFromSelector(page, newFrame, newSelector);
  }

  return { frame, selector };
}

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

  // Auto-promote iframe selectors that the AI accidentally placed in the selector
  // field instead of the frame field. If the first segment of the selector matches
  // an iframe inside the current frame context, move it to the frame chain.
  let effectiveFrame = action.frame;
  let effectiveSelector = action.selector;
  if (effectiveSelector) {
    const promoted = await promoteIframeFromSelector(page, effectiveFrame, effectiveSelector);
    effectiveFrame = promoted.frame;
    effectiveSelector = promoted.selector;
  }

  // Resolve frame context once — used by all locator-based actions and the error handler
  const root = resolveLocatorRoot(page, effectiveFrame);
  if (effectiveFrame) {
    // For nested frames ("A >> B" or "A B"), validate the outermost iframe exists on the page
    const outerSelector = effectiveFrame.includes('>>')
      ? effectiveFrame.split('>>')[0]!.trim()
      : effectiveFrame.trim().split(/\s+/)[0]!;
    const iframeCount = await page.locator(outerSelector).count();
    if (iframeCount === 0) {
      logger.warn(`iframe not found on page: ${outerSelector}`);
    } else {
      const selectorCount = effectiveSelector
        ? await root.locator(effectiveSelector).count().catch(() => 0)
        : null;
      logger.debug(
        `Action scoped to frame: ${effectiveFrame} (${iframeCount} iframe match${iframeCount > 1 ? 'es' : ''}`
        + (selectorCount !== null ? `, ${selectorCount} element match${selectorCount !== 1 ? 'es' : ''} for "${effectiveSelector}")` : ')'),
      );
    }
  }

  // Build an effective action with promoted frame/selector for use in execution
  const eff: AIAction = {
    ...action,
    ...(effectiveFrame !== undefined ? { frame: effectiveFrame } : {}),
    ...(effectiveSelector !== undefined ? { selector: effectiveSelector } : {}),
  };

  try {
    switch (eff.action) {
      case 'click':
        await executeClick(root, eff);
        break;

      case 'type':
        await executeType(root, eff);
        break;

      case 'select':
        await executeSelect(root, eff);
        break;

      case 'navigate':
        // Navigation always operates at the page level — iframes don't navigate independently
        await executeNavigate(page, eff, baseUrl);
        break;

      case 'upload':
        await executeUpload(root, eff);
        break;

      case 'hover':
        await executeHover(root, eff);
        break;

      case 'wait':
        await executeWait(page, root, eff);
        break;

      case 'scroll':
        // Scroll operates on the page viewport, not a frame element
        await executeScroll(page, eff);
        break;

      case 'switchFrame':
        // Superseded by the per-action "frame" field — kept for backward compatibility
        logger.debug(`switchFrame ignored — use the "frame" field on individual actions instead`);
        break;

      case 'switchPage':
        // Handled at the step executor level — it needs to update the active page reference
        logger.debug(`switchPage action: target="${eff.page}" — ${eff.description}`);
        break;

      case 'dismiss':
        await executeDismiss(root, eff);
        break;

      case 'keyboard':
      case 'keypress':
        // Keyboard events go to the focused element — always page-level
        await executeKeyboard(page, eff);
        break;

      case 'assert':
        // Assertions are evaluated by the AI — no Playwright action needed
        logger.debug(`assert action: ${eff.description}`);
        break;

      case 'prompt':
        // Prompt actions are handled at the step executor level
        logger.debug(`prompt action: ${eff.question ?? eff.description}`);
        break;

      case 'read': {
        const captured = await executeRead(root, eff);
        return { success: true, capturedValue: captured };
      }

      case 'count': {
        const counted = await executeCount(root, eff);
        return { success: true, capturedValue: counted };
      }

      default:
        logger.warn(`Unknown action type: ${(eff as AIAction).action}`);
    }

    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Action failed [${eff.action}]: ${errorMessage}`);

    // Count how many elements matched the selector — use the same frame root so the
    // count is meaningful (0 in the frame, not 0 in the main page for the wrong reason)
    let matchCount: number | undefined;
    if (eff.selector) {
      try {
        matchCount = await root.locator(eff.selector).count();
      } catch {
        // Selector itself may be invalid — leave matchCount undefined
      }
    }

    return {
      success: false,
      error: errorMessage,
      ...(eff.selector !== undefined && { failedSelector: eff.selector }),
      ...(matchCount !== undefined && { matchCount }),
    };
  }
}

async function executeClick(root: Page | FrameLocator, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  await root.locator(selector).locator('visible=true').first().click({ timeout: 10_000 });
}

async function executeType(root: Page | FrameLocator, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  const value = action.value ?? '';
  const locator = root.locator(selector).locator('visible=true').first();
  // Clear existing content first, then type
  await locator.clear({ timeout: 5_000 });
  await locator.fill(value, { timeout: 10_000 });
}

async function executeSelect(root: Page | FrameLocator, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  const value = action.value ?? '';
  const locator = root.locator(selector).locator('visible=true').first();
  try {
    // Try matching by value attribute first
    await locator.selectOption(value, { timeout: 5_000 });
  } catch {
    // Fall back to matching by visible label text
    await locator.selectOption({ label: value }, { timeout: 10_000 });
  }
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

async function executeUpload(root: Page | FrameLocator, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  const filePath = action.filePath ?? action.value ?? '';
  if (!filePath) throw new Error('upload action requires a filePath');
  await root.locator(selector).locator('visible=true').first().setInputFiles(filePath, { timeout: 10_000 });
}

async function executeHover(root: Page | FrameLocator, action: AIAction): Promise<void> {
  const selector = requireSelector(action);
  await root.locator(selector).locator('visible=true').first().hover({ timeout: 10_000 });
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

async function executeWait(page: Page, root: Page | FrameLocator, action: AIAction): Promise<void> {
  const condition = action.condition ?? action.value ?? '';
  const timeout = action.timeout ?? 10_000;
  const waitType = action.waitType ?? inferWaitType(condition);

  switch (waitType) {
    case 'duration': {
      const durationMs = parseDuration(condition);
      if (durationMs !== null) {
        await page.waitForTimeout(durationMs);
      }
      break;
    }

    case 'selector':
      // When inside a frame, use locator.waitFor() so the wait is scoped to that frame.
      if (root !== page) {
        await root.locator(condition).first().waitFor({ state: 'visible', timeout });
      } else {
        await page.waitForSelector(condition, { state: 'visible', timeout });
      }
      break;

    case 'text':
      await page.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (text) => (globalThis as any).document.body.textContent?.includes(text) ?? false,
        condition,
        { timeout },
      );
      break;

    case 'url':
      await page.waitForURL(condition, { timeout });
      break;

    case 'load':
      if (condition === 'networkidle' || condition === 'load' || condition === 'domcontentloaded') {
        await page.waitForLoadState(condition, { timeout });
      } else {
        // Default to networkidle for unrecognised load conditions
        await page.waitForLoadState('networkidle', { timeout });
      }
      break;
  }
}

/**
 * Fallback heuristic for when the AI omits waitType.
 * Kept for backward compatibility but should rarely be needed.
 */
function inferWaitType(condition: string): NonNullable<AIAction['waitType']> {
  if (parseDuration(condition) !== null) return 'duration';
  if (condition === 'networkidle' || condition === 'load' || condition === 'domcontentloaded') return 'load';
  if (condition.startsWith('http') || condition.startsWith('*')) return 'url';
  if (/^[#.\[]/.test(condition)) return 'selector';
  // Tag-like selector: starts with a tag name immediately followed by a selector char (no space)
  if (/^[a-z][a-z0-9]*[#.\[:]/.test(condition)) return 'selector';
  return 'text';
}

async function executeScroll(page: Page, action: AIAction): Promise<void> {
  const direction = action.direction ?? 'down';
  const amount = action.amount ?? 300;

  const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;

  await page.mouse.wheel(deltaX, deltaY);
}

async function executeDismiss(root: Page | FrameLocator, action: AIAction): Promise<void> {
  const selector = action.selector;

  if (selector) {
    try {
      const locator = root.locator(selector).locator('visible=true').first();
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
      const el = root.locator(pattern).first();
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
 * Count the number of elements matching a CSS selector.
 * Stores the result as a string (e.g. "3") in resolvedParameters[action.as].
 */
async function executeCount(root: Page | FrameLocator, action: AIAction): Promise<string> {
  const selector = requireSelector(action);
  logger.subAction(`count ${selector} → ${action.as ?? '(unnamed)'}`);
  const count = await root.locator(selector).count();
  const result = String(count);
  logger.info(`count: ${count} elements matching "${selector}" → variable "${action.as ?? '(unnamed)'}"`);
  return result;
}

/**
 * Read the value or text content of an element.
 * Tries the element's `value` attribute first (for inputs), falls back to `textContent`.
 * Uses locator.evaluate() so it works inside both page and FrameLocator contexts.
 */
async function executeRead(root: Page | FrameLocator, action: AIAction): Promise<string> {
  const selector = requireSelector(action);
  logger.subAction(`read ${selector} → ${action.as ?? '(unnamed)'}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value = await root.locator(selector).first().evaluate((el: any) => {
    if (typeof el.value === 'string') return el.value;
    return (el.textContent ?? '').trim();
  });
  logger.info(`read captured: "${value}" → variable "${action.as ?? '(unnamed)'}"`);
  return value;
}
