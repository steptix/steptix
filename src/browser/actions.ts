import type { Page, FrameLocator, Locator } from 'playwright';
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
  /** Value captured by a "read" or "count" action (single-value path). */
  capturedValue?: string;
  /** List of values captured by a "read multiple: true" action (one per
   *  matched element). Mutually exclusive with `capturedValue`. The
   *  step-executor JSON-encodes this into the parameter map so downstream
   *  tools can decode it via array-typed parameters. */
  capturedValues?: string[];
}

/**
 * Execute a single AI action via Playwright.
 * Maps each action type to the corresponding Playwright API call.
 */
export async function executeAction(
  page: Page,
  action: AIAction,
  baseUrl?: string,
  signal?: AbortSignal,
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
        await executeWait(page, root, eff, signal);
        break;

      case 'scroll':
        await executeScroll(page, root, eff);
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

      case 'openPage':
        // Handled at the step executor level — it needs to spawn a new page and promote it as active
        logger.debug(`openPage action: url="${eff.url}" — ${eff.description}`);
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
        if (eff.multiple) {
          const list = await executeReadMultiple(root, eff);
          return { success: true, capturedValues: list };
        }
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
    // A run abort (issue 022) must propagate as a throw, not be swallowed into a
    // failed-action result — the step loop / withRetry recognise it and end the
    // run as `aborted` (issue 020), instead of recording a spurious failed
    // action. `executeWait`'s abort race throws an AbortError; any other error
    // raised while the run is already aborting is likewise an abort artifact.
    if (signal?.aborted) {
      throw err;
    }

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

  // Resolve relative URLs against baseUrl. A URL carrying its own navigable
  // scheme is absolute and passes through untouched — concatenating it onto
  // baseUrl produced `<base>/file:///…` (net::ERR_FILE_NOT_FOUND) whenever a
  // test used a file:// baseUrl, and `<base>/about:blank` on the AI's retry.
  // Deliberately an allowlist rather than `new URL(url)`: `localhost:3000`
  // and Windows paths like `C:/x` parse with schemes (`localhost:`, `c:`)
  // but must keep the baseUrl-relative handling they have today.
  const hasAbsoluteScheme = /^(https?|file|about|data|blob|chrome):/i.test(url);
  if (!hasAbsoluteScheme && baseUrl) {
    if (url.startsWith('/')) {
      const base = baseUrl.replace(/\/$/, '');
      url = `${base}${url}`;
    } else {
      url = `${baseUrl.replace(/\/$/, '')}/${url}`;
    }
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

/** Default wait timeout when the AI gives no `timeout` hint. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
/** Upper bound on an AI-supplied wait `timeout` hint (issue 022) — guards
 *  against a hallucinated huge value. Generous (10 min) because waits are now
 *  abort-aware (`withAbort`): a STOP cancels an in-flight wait immediately, so a
 *  long cap no longer hurts stop responsiveness. A genuinely stuck wait the user
 *  doesn't stop is still bounded by the overall test timeout. */
export const MAX_WAIT_TIMEOUT_MS = 600_000;

/**
 * Resolve the effective wait timeout from the AI's optional `timeout` hint
 * (issue 022). A valid positive hint is honoured up to {@link MAX_WAIT_TIMEOUT_MS};
 * anything missing/non-finite/non-positive falls back to
 * {@link DEFAULT_WAIT_TIMEOUT_MS}. The plumbing already carries `action.timeout`
 * end-to-end (AI → parser → here); this just bounds it.
 */
export function clampWaitTimeout(hint: number | undefined): number {
  if (typeof hint !== 'number' || !Number.isFinite(hint) || hint <= 0) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  return Math.min(hint, MAX_WAIT_TIMEOUT_MS);
}

/**
 * Race `work` against the run's abort signal (issue 022). A run abort does NOT
 * cancel an in-flight Playwright wait, so a STOP would otherwise be delayed until
 * the wait runs out its own timeout (the residual issue 020 documented). Racing
 * it makes STOP near-instant: when the signal fires we reject with an AbortError
 * immediately and let the orphaned Playwright promise settle on its own (its
 * eventual resolve/reject is swallowed — harmless). The `abort` listener is
 * removed on settle so it can't accumulate on the long-lived run signal.
 *
 * The thrown AbortError propagates as the same kind of mid-step abort issue 020
 * already handles (turn-loop catch → withRetry no-retry → executeStep returns an
 * aborted result → run reported `aborted`).
 */
export function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(new DOMException('Run aborted by client', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void work.catch(() => undefined);
      reject(new DOMException('Run aborted by client', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

// Exported for unit tests (issue 022) — verifies the clamped `timeout` is the
// value actually forwarded into Playwright's wait calls. Not part of the public
// API; `executeAction` is the entry point in normal use.
export async function executeWait(
  page: Page,
  root: Page | FrameLocator,
  action: AIAction,
  signal?: AbortSignal,
): Promise<void> {
  const condition = action.condition ?? action.value ?? '';
  const timeout = clampWaitTimeout(action.timeout);
  const waitType = action.waitType ?? inferWaitType(condition);

  // Run the wait, but race it against the run's abort signal so a STOP ends an
  // in-flight wait immediately rather than waiting out its (possibly long)
  // timeout. See `withAbort` / issue 022.
  const runWait = async (): Promise<void> => {
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
        // Match VISIBLE text via innerText — NOT textContent. textContent
        // concatenates the source of every <script>/<style> and the text of
        // hidden nodes, so a "wait for text X" could match a string the user
        // never sees and the AI was never shown (the cleaned DOM strips
        // script/style too — see dom-cleaner SKIP set). innerText is "what's
        // painted", which is what "appears" means here. (issue 029)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (text) => (globalThis as any).document.body?.innerText?.includes(text) ?? false,
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
  };

  await withAbort(runWait(), signal);
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

// ─── Absolute scrolling ──────────────────────────────────────────────────────
//
// The numbers behind the eased glide, in one place. Deliberately constants and
// not a `browser.*` config knob: a per-project value would have to be threaded
// through the server's per-project bundle to actually apply, and nothing
// justifies that plumbing yet.

/** Fixed cost of any glide, before distance is considered. */
const SCROLL_BASE_MS = 250;
/** Pixels of travel per additional millisecond of duration. */
const SCROLL_PX_PER_MS = 4;
/** Hard cap — a 40,000px page still stops gliding after this long. */
const SCROLL_MAX_MS = 1200;
/**
 * Grace period after `duration` before the deadline timer snaps to the target
 * and resolves. requestAnimationFrame is throttled to zero on hidden, occluded
 * or backgrounded pages, so the frame loop cannot be the only thing that ends
 * the animation.
 */
const SCROLL_DEADLINE_MARGIN_MS = 500;
/** How long to wait for a scroll target to become measurable before giving up
 *  on the glide and letting `scrollIntoViewIfNeeded` do the work alone. */
const SCROLL_BOX_TIMEOUT_MS = 5_000;

/**
 * Duration of an eased scroll across `distancePx`, in milliseconds.
 *
 * A pure Node-side mirror of the formula the browser-side animator computes for
 * itself. It has to be a mirror rather than a shared call: `page.evaluate`
 * serializes its callback, so the animator cannot reach back into this module.
 * Exported so tests can pin the cap and the distance scaling without a browser
 * — keep the two in step.
 */
export function scrollDurationMs(distancePx: number): number {
  return Math.min(SCROLL_MAX_MS, SCROLL_BASE_MS + Math.abs(distancePx) / SCROLL_PX_PER_MS);
}

/**
 * Ease-out cubic: fast off the mark, decelerating into the stop.
 *
 * Same mirroring caveat as `scrollDurationMs` — the animator carries its own
 * inline copy of this one line. Exported so the deceleration property can be
 * asserted as arithmetic instead of by watching a video.
 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Where an absolute scroll is aimed. A `deltaY` is relative to the scroller's
 *  position when the animation starts (used to bring an element into view). */
type ScrollTargetSpec = 'top' | 'bottom' | { deltaY: number };

/**
 * Drive `document.scrollingElement` to a target with an ease-out curve, and
 * resolve only once motion has ended.
 *
 * Neither `behavior: "smooth"` nor `behavior: "instant"` would do. Smooth
 * cannot be awaited — completion needs the `scrollend` event, which WebKit
 * doesn't fire, and the browser picks the duration. Instant teleports: it
 * dispatches no intermediate scroll positions, so IntersectionObserver-driven
 * lazy-loaders and scroll-linked UI never see the journey, on exactly the long
 * pages "scroll to the bottom" exists for. Owning the animation means
 * completion is our own promise, so the caller awaits actual arrival and a
 * follow-up screenshot can never catch a mid-animation frame.
 */
async function animateScrollTo(page: Page, target: ScrollTargetSpec): Promise<void> {
  await page.evaluate(
    (args: {
      target: ScrollTargetSpec;
      baseMs: number;
      pxPerMs: number;
      maxMs: number;
      marginMs: number;
    }) =>
      new Promise<void>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = globalThis as any;
        const el = g.document.scrollingElement ?? g.document.documentElement;
        // The maximum is scrollHeight − clientHeight, NOT scrollHeight. A plain
        // scrollTo gets away with overshooting because the browser clamps; an
        // animation must not, or the visible deceleration compresses against
        // the clamp and dies early.
        const maxScroll = (): number => Math.max(0, el.scrollHeight - el.clientHeight);
        const start: number = el.scrollTop;
        // Re-read every frame so "bottom" tracks a page that grows mid-glide —
        // within the duration cap.
        const targetY = (): number => {
          if (args.target === 'top') return 0;
          if (args.target === 'bottom') return maxScroll();
          return Math.min(Math.max(0, start + args.target.deltaY), maxScroll());
        };
        const duration = Math.min(
          args.maxMs,
          args.baseMs + Math.abs(targetY() - start) / args.pxPerMs,
        );
        // Races the frame loop: when frames stop coming, this snaps to the
        // target and resolves, so the action always terminates.
        const deadline = setTimeout(() => {
          el.scrollTop = targetY();
          resolve();
        }, duration + args.marginMs);
        const t0: number = g.performance.now();
        const tick = (now: number): void => {
          const t = Math.min(1, (now - t0) / duration);
          el.scrollTop = start + (targetY() - start) * (1 - Math.pow(1 - t, 3)); // ease-out cubic
          if (t < 1) {
            g.requestAnimationFrame(tick);
            return;
          }
          clearTimeout(deadline);
          resolve();
        };
        g.requestAnimationFrame(tick);
      }),
    {
      target,
      baseMs: SCROLL_BASE_MS,
      pxPerMs: SCROLL_PX_PER_MS,
      maxMs: SCROLL_MAX_MS,
      marginMs: SCROLL_DEADLINE_MARGIN_MS,
    },
  );
}

/**
 * Glide the document scroller to wherever `locator` sits.
 *
 * `boundingBox()` reports main-frame viewport coordinates even for an element
 * inside an iframe, so the delta it yields is the right one for the document
 * scroller. Best-effort by design: an element that can't be measured (detached,
 * hidden, still rendering) simply gets no glide, and the
 * `scrollIntoViewIfNeeded` backstop at the call site still puts it in view.
 */
async function animateScrollToLocator(page: Page, locator: Locator): Promise<void> {
  const box = await locator
    .boundingBox({ timeout: SCROLL_BOX_TIMEOUT_MS })
    .catch(() => null);
  if (!box) {
    logger.debug('scroll: target not measurable — skipping the glide, relying on scrollIntoViewIfNeeded');
    return;
  }
  await animateScrollTo(page, { deltaY: box.y });
}

/**
 * Scroll the page. Three forms, in precedence order:
 *
 *   1. `selector` — bring an element into view. The eased glide aimed at the
 *      element, then Playwright's `scrollIntoViewIfNeeded` as the correctness
 *      backstop (a no-op when the glide already landed, and the thing that
 *      handles elements inside *nested* scrollable containers — where the
 *      backstop is instant). Routed through `root`, so `frame` works.
 *   2. `to` — absolute and pointer-independent: the top or the current bottom.
 *   3. `direction` + `amount` — the mouse-wheel path, unchanged. The only form
 *      that can reach an inner scrollable pane under the pointer, and so the
 *      fallback for layouts that fix the body and scroll a `<main>`.
 *
 * Precedence rather than rejection: a model that sends both `to` and
 * `direction` is being redundant, not contradictory, and every combination has
 * one sensible reading. Failing here would burn a paid retry turn to punish
 * harmless noise.
 */
async function executeScroll(page: Page, root: Page | FrameLocator, action: AIAction): Promise<void> {
  if (action.selector) {
    const target = root.locator(action.selector).first();
    await animateScrollToLocator(page, target);
    await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
    return;
  }

  if (action.to) {
    await animateScrollTo(page, action.to);
    return;
  }

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
 * Per-element value extraction shared by `executeRead` and `executeReadMultiple`.
 * Runs in the BROWSER context (shipped to Playwright via `evaluate` /
 * `evaluateAll`), so it must be a self-contained function — no closures over
 * Node-side state, no references to other helpers in this module. The
 * function source is stringified twice on the way to the page; both call
 * sites pass it through Playwright's serialization the same way.
 *
 * Behaviour:
 *   - With `attribute`: special-case `href`/`src` so the resolved absolute
 *     URL wins over the raw attribute string (which may be a relative path).
 *   - Without `attribute`: prefer the form-input `value` over `textContent`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractValueInPage(el: any, attribute?: string): string {
  if (attribute) {
    if (attribute === 'href' || attribute === 'src') {
      const resolved = el[attribute];
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    }
    return typeof el.getAttribute === 'function' ? (el.getAttribute(attribute) ?? '') : '';
  }
  if (typeof el.value === 'string') return el.value;
  return (el.textContent ?? '').trim();
}

/**
 * Compile a `read` action's `pattern` into a RegExp. Throws a clear error on an
 * invalid pattern — issue 020's fail-hard policy: a malformed regex fails the
 * step instead of being silently ignored (which would store the whole text).
 */
function compileReadPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `read pattern /${pattern}/ is not a valid regular expression — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Apply a compiled `read` pattern to one captured value. Returns the first
 * capture group, or the whole match when the pattern has no capturing group;
 * returns null when the pattern does not match. Callers decide whether a
 * non-match is fatal: a single `read` fails the step, a `multiple` read drops
 * the element.
 */
function sliceWithReadPattern(re: RegExp, value: string): string | null {
  const m = re.exec(value);
  if (m === null) return null;
  return m[1] ?? m[0];
}

/** Trim a captured value for inclusion in a fail-hard error message. */
function truncateForError(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Maximum number of elements `read multiple: true` will capture in one
 * action. Authors who need more should narrow the selector (chunk by
 * section/page); a higher cap usually indicates an over-broad selector.
 * The cap protects the param map from accidentally swallowing an entire
 * page's worth of elements when a selector is mis-typed (e.g. `a` instead
 * of `.section-1 a`).
 */
const READ_MULTIPLE_MAX = 500;

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

  let value = await root
    .locator(selector)
    .first()
    .evaluate(extractValueInPage, attribute);

  // Optional substring extraction (issue 020). Applied in Node after capture so
  // it composes with `attribute`. Fail-hard: an invalid pattern or a non-match
  // fails the step rather than silently storing "" or the whole text.
  if (action.pattern) {
    const sliced = sliceWithReadPattern(compileReadPattern(action.pattern), value);
    if (sliced === null) {
      throw new Error(
        `read pattern /${action.pattern}/ matched nothing in ${JSON.stringify(truncateForError(value))}`,
      );
    }
    if (sliced === '') {
      // Fail-hard extends to a match that captured nothing — storing "" is the
      // exact silent-empty outcome `pattern` exists to prevent. (A `multiple`
      // read keeps "": one empty among many is a legitimate list item.)
      throw new Error(
        `read pattern /${action.pattern}/ captured an empty substring (pattern too loose) in ${JSON.stringify(truncateForError(value))}`,
      );
    }
    value = sliced;
  }

  logger.info(`read captured: "${value}" → variable "${action.as ?? '(unnamed)'}"`);
  return value;
}

/**
 * Read the value/text/attribute of EVERY element matching the selector and
 * return them as an ordered array — index-aligned with DOM order at capture
 * time. Single round-trip via `evaluateAll`; the per-element extraction is
 * the same body as `executeRead` (see `extractValueInPage`).
 *
 * Returns an empty array when nothing matches; that's a valid (though
 * possibly surprising) outcome and the consuming tool can decide whether
 * an empty list is a failure.
 *
 * Capped at READ_MULTIPLE_MAX. When the selector matches more, the first
 * READ_MULTIPLE_MAX values are returned and a warning names the total — so
 * an over-broad selector is loud rather than silent.
 */
async function executeReadMultiple(
  root: Page | FrameLocator,
  action: AIAction,
): Promise<string[]> {
  const selector = requireSelector(action);
  const attribute = action.attribute;
  const target = attribute ? `@${attribute}` : 'text';
  logger.subAction(`read[multiple] ${selector} ${target} → ${action.as ?? '(unnamed)'}`);

  // Single round-trip: ship the extractor source to the page and run it
  // across every match. The extractor body is duplicated literally inside
  // the evaluateAll callback because Playwright cannot serialise references
  // to closures in Node scope. Keeping this in lockstep with
  // `extractValueInPage` is enforced by the tests in read-multiple.test.ts.
  const values: string[] = await root.locator(selector).evaluateAll(
    (els, args) => {
      const { attribute, max } = args as { attribute?: string; max: number };
      const slice = els.slice(0, max);
      return slice.map((el) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = el as any;
        if (attribute) {
          if (attribute === 'href' || attribute === 'src') {
            const resolved = e[attribute];
            if (typeof resolved === 'string' && resolved.length > 0) return resolved;
          }
          return typeof e.getAttribute === 'function'
            ? (e.getAttribute(attribute) ?? '')
            : '';
        }
        if (typeof e.value === 'string') return e.value;
        return (e.textContent ?? '').trim();
      });
    },
    { attribute, max: READ_MULTIPLE_MAX },
  );

  // We capped inside the page. To tell the author whether anything was
  // truncated, do one cheap follow-up count() — only when the result hit
  // the cap, so the common case stays at one round trip.
  if (values.length >= READ_MULTIPLE_MAX) {
    const total = await root.locator(selector).count().catch(() => values.length);
    if (total > values.length) {
      logger.warn(
        `read[multiple] captured the first ${values.length} of ${total} elements matching "${selector}" — narrow the selector if you need all of them (READ_MULTIPLE_MAX=${READ_MULTIPLE_MAX})`,
      );
    }
  }

  // Optional per-element substring extraction (issue 020). Non-matching
  // elements are dropped (an empty result *list* is a valid outcome); a match
  // that captured an empty string is KEPT — unlike a single read, which fails
  // on empty, here one empty among many is a legitimate list item. An invalid
  // pattern still fails the step via compileReadPattern.
  let result = values;
  if (action.pattern) {
    const re = compileReadPattern(action.pattern);
    result = values
      .map((v) => sliceWithReadPattern(re, v))
      .filter((v): v is string => v !== null);
    logger.info(
      `read[multiple] pattern /${action.pattern}/ sliced ${result.length} of ${values.length} captured value${values.length === 1 ? '' : 's'}`,
    );
  }

  logger.info(
    `read[multiple] captured: ${result.length} value${result.length === 1 ? '' : 's'} → variable "${action.as ?? '(unnamed)'}"`,
  );
  return result;
}
