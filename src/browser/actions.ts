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
  let effectiveSelector = action.selector ? sanitizeCssSelector(action.selector) : action.selector;
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

      case 'closePage':
        // Handled at the step executor level — it needs to close the page and update the active reference
        logger.debug(`closePage action: target="${eff.page}" — ${eff.description}`);
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

      case 'noop':
        logger.debug(`noop action: ${eff.description}`);
        break;

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

/**
 * Escape special characters commonly found in Tailwind CSS classes that are
 * invalid in raw CSS selectors (e.g. `.!fixed` → `.\!fixed`).
 * Exported for tests only.
 */
export function sanitizeCssSelector(selector: string): string {
  // Escape `!` when used inside class names (Tailwind important modifier)
  // e.g.  .!fixed  →  .\!fixed
  let sanitized = selector.replace(/\.!/g, '.\\!');

  // Escape `/` in class names (Tailwind opacity shorthand)
  // e.g.  .bg-black/50  →  .bg-black\/50
  sanitized = sanitized.replace(/(\.[a-zA-Z_][\w-]*)\/(\d+)/g, '$1\\/$2');

  // Escape `@` in class names (Tailwind container query variants)
  // e.g.  .@lg  →  .\@lg
  sanitized = sanitized.replace(/\.@/g, '.\\@');

  // Escape unescaped `[` and `]` inside Tailwind arbitrary-value class names.
  // Tailwind compiles `.z-[999]` to `.z-\[999\]` in CSS, so the AI-written form
  // needs the same escape to match.
  //
  // Ambiguity: `.classname-[href='/logout']` is valid CSS meaning
  // "class ending in '-' followed by attribute selector [href='/logout']". When
  // the bracket content contains `=` it's almost certainly an attribute selector
  // (Tailwind values very rarely contain `=` — only URL query strings, which are
  // vanishingly rare in practice). In that case leave the brackets alone so
  // Playwright parses the attribute selector normally.
  sanitized = sanitized.replace(
    /(\.[a-zA-Z_][\w-]*)-(?<!\\)\[([^\]]*)\]/g,
    (match, classPart, bracketContent) => {
      if (bracketContent.includes('=')) return match;
      return classPart + '-\\[' + bracketContent + '\\]';
    },
  );

  // Escape `:` inside ID and class selectors (e.g. React Aria's
  // `#react-aria-:rb4:` or Tailwind variants like `.hover:bg-blue-500`).
  // In CSS, `:` starts a pseudo-class, so an unescaped `:` in the middle
  // of an id or class name truncates the identifier and breaks parsing.
  // We match `#` or `.` + identifier chars and escape any `:` in that run —
  // but only when the `:` is NOT followed by a known pseudo-class name.
  const pseudoClasses = [
    'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited',
    'link', 'any-link', 'target', 'root', 'scope', 'empty',
    'first-child', 'last-child', 'only-child', 'first-of-type',
    'last-of-type', 'only-of-type',
    'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type',
    'not', 'is', 'where', 'has', 'lang', 'dir',
    'checked', 'disabled', 'enabled', 'required', 'optional',
    'valid', 'invalid', 'in-range', 'out-of-range',
    'read-only', 'read-write', 'placeholder-shown',
    'default', 'indeterminate', 'before', 'after',
    // Playwright-specific pseudo-classes — valid inside locator() selectors.
    // The AI should prefer dedicated waitTypes over encoding state in selectors
    // (see prompt rule 12), but these are legitimate for click/type/select
    // selectors (:has-text() is especially useful for disambiguation).
    'visible', 'hidden', 'has-text', 'text', 'nth-match', 'light',
  ];
  const pseudoRe = new RegExp(`^(?:${pseudoClasses.join('|')})\\b`, 'i');
  sanitized = sanitized.replace(/[#.][^\s.#\[>+~,]+/g, (part) => {
    const prefix = part[0];
    let body = part.slice(1);
    body = body.replace(/(?<!\\):([^\s.#\[>+~,:]*)/g, (match, rest) => {
      return pseudoRe.test(rest) ? match : '\\:' + rest;
    });
    return prefix + body;
  });

  return sanitized;
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

    case 'selector': {
      // Strip a trailing ":visible" — visibility is already enforced via
      // state:'visible' below, so encoding it in the selector is redundant
      // and was a common AI failure mode (the sanitizer mangled the colon).
      const rawSel = condition.replace(/:visible$/, '');
      // Sanitize Tailwind-style class names that contain invalid CSS characters
      const sel = sanitizeCssSelector(rawSel);
      // When inside a frame, use locator.waitFor() so the wait is scoped to that frame.
      if (root !== page) {
        await root.locator(sel).first().waitFor({ state: 'visible', timeout });
      } else {
        await page.waitForSelector(sel, { state: 'visible', timeout });
      }
      break;
    }

    case 'hidden': {
      // Strip a trailing ":hidden" or ":not(:visible)" — hiddenness is enforced
      // via state:'hidden' below, so encoding it in the selector is redundant.
      const rawHidden = condition
        .replace(/:hidden$/, '')
        .replace(/:not\(:visible\)$/, '');
      // Wait for an element to disappear (spinner, overlay, loading indicator)
      const hiddenSel = sanitizeCssSelector(rawHidden);
      if (root !== page) {
        await root.locator(hiddenSel).first().waitFor({ state: 'hidden', timeout });
      } else {
        await page.waitForSelector(hiddenSel, { state: 'hidden', timeout });
      }
      break;
    }

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

    case 'count': {
      // Wait until a selector matches at least N elements (default 1)
      const expectedCount = parseInt(action.expected ?? '1', 10);
      await page.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ({ sel, min }) => (globalThis as any).document.querySelectorAll(sel).length >= min,
        { sel: condition, min: expectedCount },
        { timeout },
      );
      break;
    }

    case 'attribute': {
      // Wait for an element's attribute to reach an expected value
      // condition = CSS selector, expected = "attribute=value" or "!disabled"
      const selector = action.selector ?? condition;
      const expr = action.expected ?? condition;
      const negate = expr.startsWith('!');
      const attr = negate ? expr.slice(1) : expr.split('=')[0]!;
      const val = negate ? null : (expr.split('=').slice(1).join('=') || null);

      await page.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ({ sel, attribute, expected, shouldBeAbsent }) => {
          const el = (globalThis as any).document.querySelector(sel);
          if (!el) return false;
          if (shouldBeAbsent) return !el.hasAttribute(attribute);
          if (expected === null) return el.hasAttribute(attribute);
          return el.getAttribute(attribute) === expected;
        },
        { sel: selector, attribute: attr, expected: val, shouldBeAbsent: negate },
        { timeout },
      );
      break;
    }

    case 'navigation': {
      // Wait for navigation to occur AND settle. Resolves on the final URL of
      // a redirect chain, not the first hop (SSO/OAuth flows chain through
      // several intermediate URLs).
      const startUrl = page.url();
      await page.waitForURL((url) => url.toString() !== startUrl, { timeout });
      // After the first change, give the URL up to 1.5s to stabilise by
      // re-checking at short intervals — if it keeps moving, we're mid-chain.
      const stableDeadline = Date.now() + 1_500;
      let lastUrl = page.url();
      let lastChangeAt = Date.now();
      while (Date.now() < stableDeadline) {
        await page.waitForTimeout(150);
        const currentUrl = page.url();
        if (currentUrl !== lastUrl) {
          lastUrl = currentUrl;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= 400) {
          break;
        }
      }
      break;
    }

    case 'stable':
      // Wait for the page to stabilise: network idle + no pending animations
      await page.waitForLoadState('networkidle', { timeout });
      // Additional check: wait for no layout shifts / DOM mutations
      await page.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => new Promise<boolean>((resolve) => {
          const observer = new (globalThis as any).MutationObserver((_: unknown, obs: { disconnect: () => void }) => {
            obs.disconnect();
            resolve(false);
          });
          observer.observe((globalThis as any).document.body, {
            childList: true, subtree: true, attributes: true,
          });
          setTimeout(() => { observer.disconnect(); resolve(true); }, 500);
        }),
        { timeout },
      );
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
  const attribute = action.attribute;
  const target = attribute ? `@${attribute}` : 'text';
  logger.subAction(`read ${selector} ${target} → ${action.as ?? '(unnamed)'}`);

  const locator = root.locator(selector).first();

  let value: string;
  if (attribute) {
    // For href/src, prefer the resolved absolute URL over the raw attribute string,
    // which on DOM-string lookup may be a relative path.
    if (attribute === 'href' || attribute === 'src') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value = await locator.evaluate((el: any, attr: string) => {
        const resolved = el[attr];
        if (typeof resolved === 'string' && resolved.length > 0) return resolved;
        return typeof el.getAttribute === 'function' ? (el.getAttribute(attr) ?? '') : '';
      }, attribute);
    } else {
      value = (await locator.getAttribute(attribute)) ?? '';
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value = await locator.evaluate((el: any) => {
      if (typeof el.value === 'string') return el.value;
      return (el.textContent ?? '').trim();
    });
  }

  logger.info(`read captured: "${value}" → variable "${action.as ?? '(unnamed)'}"`);
  return value;
}
