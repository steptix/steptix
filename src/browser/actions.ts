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

/**
 * What the runtime found at the instant it acted
 * (stories/codebehind-selector-ambiguity.md §"Measurement 1").
 *
 * The AI runtime puts every selector through two tolerances — hidden matches
 * are filtered out, and of what remains the first is taken — so a transcript
 * has never been evidence that one match *exists*. Generated code-behind has
 * neither tolerance: Playwright's default is strict and throws on the second
 * match, visible or not. These three facts are what closes that gap.
 *
 * Every field is optional and absence is first-class. Measurement is strictly
 * additive telemetry, so anything that stops it — a detached element, a
 * cross-origin frame, a CSP that blocks `evaluate` — leaves the field off
 * rather than recording a number that is not true. A count is never zero: the
 * hoisted wait proved a match existed, so a zero would describe the gap
 * between the wait and the measurement, not the action.
 */
export interface ActionTargeting {
  /** Every match, hidden included. This is strict mode's number — the one
   *  that predicts whether the generated entry will throw. */
  matchCount?: number;
  /** Visible matches: what the runtime was actually choosing between when it
   *  took `.first()`. A different question from `matchCount` — whether the AI
   *  may have silently acted on the wrong element. */
  visibleMatchCount?: number;
  /** A selector for the element that was acted on, VERIFIED in page context
   *  (`querySelectorAll(sel).length === 1 && [0] === el`). Absent when even a
   *  positional path does not address it uniquely. */
  resolvedSelector?: string;
  /**
   * How `resolvedSelector` was arrived at — a semantic handle
   * (`'attribute'`), that handle qualified by an addressable ancestor
   * (`'scoped'`), or an `nth-of-type` chain (`'positional'`).
   *
   * Reported rather than left to be inferred from the string, because
   * generation has a rule that turns on it: a positional path pins THIS run's
   * row number into a committed file, so when the step or a parameter names
   * what distinguishes the element the entry must build its locator from
   * `step.getVar(...)` instead (issue 024's defect, in the one place it
   * outlives the cache). "Does it contain `nth-of-type`" is not that question
   * — an author's own selector can, and a scoped handle never does.
   *
   * Travels with `resolvedSelector`: both present, or neither.
   */
  resolvedBy?: ResolvedBy;
}

/** How a `resolvedSelector` was arrived at. See {@link ActionTargeting}. */
export type ResolvedBy = 'attribute' | 'scoped' | 'positional';

/** What the browser-side selector builder returns. */
interface ResolvedSelection {
  selector: string;
  by: ResolvedBy;
}

/** Per-call switches for {@link executeAction}. */
export interface ExecuteActionOptions {
  /**
   * Measure {@link ActionTargeting} for this action.
   *
   * Compile-only: generation is the only consumer, and an ordinary run would
   * pay two CDP round-trips per element-targeting action forever for data
   * nobody reads. The caller gates it on the same flag `captureStepContext`
   * uses (stories/codebehind-selector-ambiguity.md §"Where the measurement
   * goes").
   */
  measure?: boolean;
  /**
   * `browser.ambiguousTarget`. Under `'fail'` a singular action whose
   * selector resolves to more than one candidate does not act: it returns a
   * failure carrying the count, which reaches the AI next turn.
   *
   * "Candidate" means whatever the action's OWN `.first()` chose from —
   * visible matches for click/type/select/hover/upload, every match for a
   * singular `read`. See the gate in `executeAction`.
   *
   * This is the stated exception to the compile-only gate: it decides by
   * reading a count, so it cannot work without one. Setting it turns on that
   * ONE count whatever the mode; `resolvedSelector` stays compile-only.
   */
  ambiguousTarget?: 'first' | 'fail' | undefined;
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
  /** What the runtime found at the instant it acted. Absent unless the caller
   *  asked to measure, and absent whenever measurement was impossible. */
  targeting?: ActionTargeting;
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
  options?: ExecuteActionOptions,
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

  // Whether the caller wants the full measurement, and whether it wants the
  // ambiguity gate. The gate needs `visibleMatchCount` on any run, so it turns
  // the cheap half on by itself.
  const wantMeasure = options?.measure === true;
  const wantGate = options?.ambiguousTarget === 'fail';
  /** What the runtime found. Absent unless we measured and the numbers held. */
  let targeting: ActionTargeting | undefined;
  /** What is left of the action's own budget after the wait hoisted out of it. */
  let remainingMs: number | undefined;

  try {
    // ── Measurement (stories/codebehind-selector-ambiguity.md) ──────────────
    // Hoist the wait the action was going to do anyway, so the count is taken
    // at the instant Playwright would have acted. Measuring cold at T0 would
    // record `matchCount: 0` for the very common case where the element
    // renders 400ms later and the action then succeeds — a confident lie,
    // worse than no data. After the wait resolves at least one match exists by
    // construction, so "zero" is not a measurement outcome at all: it is the
    // wait timing out, which throws into the catch below exactly as the
    // action's own wait would have.
    const singular = wantMeasure || wantGate ? singularTargetOf(root, eff) : null;
    if (singular && eff.selector !== undefined) {
      const startedAt = Date.now();
      await singular.target.waitFor({ state: singular.state, timeout: singular.budgetMs });
      targeting = await measureTargeting(root, eff.selector, singular, wantMeasure);
      // The hoisted wait must not add a SECOND timeout budget: giving it a
      // fresh one would double how long a failing selector takes to report.
      // Time it, and pass the remainder to the action.
      remainingMs = Math.max(singular.budgetMs - (Date.now() - startedAt), MIN_ACTION_TIMEOUT_MS);

      // "Did this action's own `.first()` pick from more than one candidate?"
      // — so each action is gated on the count matching ITS tolerance.
      // click/type/select/hover/upload filter to `visible=true` first, so they
      // gate on the visible count; a singular `read` takes `.first()` over
      // every match, hidden included, so it gates on the total. Gating a read
      // on the visible count would let it silently capture from a hidden first
      // match, which is worse than the click case: it poisons a variable
      // instead of failing loudly.
      const candidates =
        singular.state === 'visible' ? targeting?.visibleMatchCount : targeting?.matchCount;
      if (candidates !== undefined && candidates > 1) {
        const what = singular.state === 'visible' ? 'visible elements' : 'elements';
        const took =
          singular.state === 'visible'
            ? `${eff.action} took the first visible one`
            : `${eff.action} took the first of them, hidden included`;
        if (wantGate) {
          // Don't let the AI resolve ambiguity by accident. The failure
          // carries the count into `collectedFailures`, so the next turn is
          // told its selector was ambiguous and re-plans.
          const message =
            `${candidates} ${what} matched "${eff.selector}" — use a more specific selector `
            + `(browser.ambiguousTarget is "fail")`;
          logger.error(`Action refused [${eff.action}]: ${message}`);
          return {
            success: false,
            error: message,
            failedSelector: eff.selector,
            matchCount: candidates,
            ...(targeting !== undefined && { targeting }),
          };
        }
        logger.warn(`"${eff.selector}" matched ${candidates} ${what} — ${took}`);
      }
    }

    switch (eff.action) {
      case 'click':
        await executeClick(root, eff, remainingMs);
        break;

      case 'type':
        await executeType(root, eff, remainingMs);
        break;

      case 'select':
        await executeSelect(root, eff, remainingMs);
        break;

      case 'navigate':
        // Navigation always operates at the page level — iframes don't navigate independently
        await executeNavigate(page, eff, baseUrl);
        break;

      case 'upload':
        await executeUpload(root, eff, remainingMs);
        break;

      case 'hover':
        await executeHover(root, eff, remainingMs);
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
          // Plural actions are exempt by construction: `evaluateAll` runs
          // across every match, so many matches is the PURPOSE. The count is
          // free here (the page already returned every element), and there is
          // no `resolvedSelector` because there is no single element.
          const list = await executeReadMultiple(root, eff);
          return {
            success: true,
            capturedValues: list.values,
            ...(wantMeasure && { targeting: { matchCount: list.matchCount } }),
          };
        }
        const captured = await executeRead(root, eff, remainingMs);
        return {
          success: true,
          capturedValue: captured,
          ...(targeting !== undefined && { targeting }),
        };
      }

      case 'count': {
        // Also plural, and its count IS its result — free, and never gated.
        const counted = await executeCount(root, eff);
        const total = Number(counted);
        return {
          success: true,
          capturedValue: counted,
          ...(wantMeasure && Number.isFinite(total) && { targeting: { matchCount: total } }),
        };
      }

      case 'noop':
        logger.debug(`noop action: ${eff.description}`);
        break;

      default:
        logger.warn(`Unknown action type: ${(eff as AIAction).action}`);
    }

    return { success: true, ...(targeting !== undefined && { targeting }) };
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
      ...(targeting !== undefined && { targeting }),
    };
  }
}

/**
 * Per-action Playwright budgets, named because the measurement borrows from
 * them (stories/codebehind-selector-ambiguity.md §"Measurement 1"). Where an
 * action makes two calls, the hoisted wait draws on the FIRST one's budget and
 * hands back the remainder, so the total wall clock of a failing selector is
 * what it was before — not double.
 */
const CLICK_TIMEOUT_MS = 10_000;
const TYPE_CLEAR_TIMEOUT_MS = 5_000;
const TYPE_FILL_TIMEOUT_MS = 10_000;
const SELECT_BY_VALUE_TIMEOUT_MS = 5_000;
const SELECT_BY_LABEL_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 10_000;
const HOVER_TIMEOUT_MS = 10_000;
/** `read` passes no timeout today, so its budget is Playwright's own default. */
const READ_TIMEOUT_MS = 30_000;
/** Floor on what the hoisted wait hands back, so a slow measurement can never
 *  starve the action it is telemetry for. */
const MIN_ACTION_TIMEOUT_MS = 1_000;
/** All the patience the measurement itself gets. It is telemetry: an element
 *  that detached in the gap should cost milliseconds and be forgotten, not
 *  spend Playwright's default 30s retrying before we swallow the throw. */
const MEASUREMENT_TIMEOUT_MS = 2_000;

async function executeClick(
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  await root
    .locator(selector)
    .locator('visible=true')
    .first()
    .click({ timeout: timeoutMs ?? CLICK_TIMEOUT_MS });
}

async function executeType(
  root: Page | FrameLocator,
  action: AIAction,
  clearTimeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  const value = action.value ?? '';
  const locator = root.locator(selector).locator('visible=true').first();
  // Clear existing content first, then type
  await locator.clear({ timeout: clearTimeoutMs ?? TYPE_CLEAR_TIMEOUT_MS });
  await locator.fill(value, { timeout: TYPE_FILL_TIMEOUT_MS });
}

async function executeSelect(
  root: Page | FrameLocator,
  action: AIAction,
  byValueTimeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  const value = action.value ?? '';
  const locator = root.locator(selector).locator('visible=true').first();
  try {
    // Try matching by value attribute first
    await locator.selectOption(value, { timeout: byValueTimeoutMs ?? SELECT_BY_VALUE_TIMEOUT_MS });
  } catch {
    // Fall back to matching by visible label text
    await locator.selectOption({ label: value }, { timeout: SELECT_BY_LABEL_TIMEOUT_MS });
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

async function executeUpload(
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  const filePath = action.filePath ?? action.value ?? '';
  if (!filePath) throw new Error('upload action requires a filePath');
  await root
    .locator(selector)
    .locator('visible=true')
    .first()
    .setInputFiles(filePath, { timeout: timeoutMs ?? UPLOAD_TIMEOUT_MS });
}

async function executeHover(
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  await root
    .locator(selector)
    .locator('visible=true')
    .first()
    .hover({ timeout: timeoutMs ?? HOVER_TIMEOUT_MS });
}

/**
 * The element an action is about to act on, plus the wait it was going to do
 * to get there.
 *
 * Only SINGULAR element-targeting actions have one. `read multiple` and
 * `count` are plural by construction — many matches is their purpose — and
 * navigate/keyboard/assert/prompt/noop and the page/browser actions target no
 * element at all.
 *
 * `state` is the state the action's OWN wait would have waited for, which is
 * not the same question for every action: click/type/select/hover/upload all
 * go through `visible=true`, while a singular `read` reads `.first()` of the
 * raw locator and so waits only for `attached` — reading a hidden element is
 * ordinary, and hoisting a visibility wait would change what read means.
 *
 * It doubles as the action's tolerance, which is what `ambiguousTarget: 'fail'`
 * has to gate on: `'visible'` means the runtime chose among the visible
 * matches, `'attached'` means it chose among all of them.
 */
interface SingularTarget {
  target: Locator;
  state: 'visible' | 'attached';
  /** The first budget the action would have spent, which the hoisted wait
   *  borrows from rather than adding to. */
  budgetMs: number;
}

function singularTargetOf(root: Page | FrameLocator, action: AIAction): SingularTarget | null {
  const selector = action.selector;
  if (!selector) return null;
  const visibleFirst = (): Locator => root.locator(selector).locator('visible=true').first();
  switch (action.action) {
    case 'click':
      return { target: visibleFirst(), state: 'visible', budgetMs: CLICK_TIMEOUT_MS };
    case 'type':
      return { target: visibleFirst(), state: 'visible', budgetMs: TYPE_CLEAR_TIMEOUT_MS };
    case 'select':
      return { target: visibleFirst(), state: 'visible', budgetMs: SELECT_BY_VALUE_TIMEOUT_MS };
    case 'hover':
      return { target: visibleFirst(), state: 'visible', budgetMs: HOVER_TIMEOUT_MS };
    case 'upload':
      return { target: visibleFirst(), state: 'visible', budgetMs: UPLOAD_TIMEOUT_MS };
    case 'read':
      if (action.multiple) return null;
      return { target: root.locator(selector).first(), state: 'attached', budgetMs: READ_TIMEOUT_MS };
    default:
      return null;
  }
}

/**
 * Count what the selector matched and identify what is about to be touched.
 *
 * NEVER throws and never fails an action: measurement is strictly additive
 * telemetry, so a mangled selector, a cross-origin frame, a CSP blocking
 * `evaluate`, a closing page or an element that detached in the gap since the
 * wait all leave `targeting` absent and the action behaving exactly as it does
 * today. Absence is first-class downstream; a wrong number would not be.
 *
 * `full` is the compile-only half. With it off — the `ambiguousTarget: 'fail'`
 * exception, which has to read a count on any run — this is ONE call, not
 * three: the count matching the action's own tolerance, which is the only one
 * the gate can act on.
 */
async function measureTargeting(
  root: Page | FrameLocator,
  selector: string,
  singular: SingularTarget,
  full: boolean,
): Promise<ActionTargeting | undefined> {
  try {
    const visibleMatchCount =
      full || singular.state === 'visible'
        ? await root.locator(selector).locator('visible=true').count()
        : undefined;
    const matchCount =
      full || singular.state === 'attached' ? await root.locator(selector).count() : undefined;
    // Explicitly `undefined` arg + options, because `evaluate`'s first overload
    // would otherwise read a lone options object as the page function's
    // ARGUMENT and silently apply Playwright's 30s default — which is what an
    // element that detached in the gap would then spend before throwing. Two
    // seconds is the whole budget telemetry gets.
    const resolved = full
      ? await singular.target.evaluate(resolvedSelectorInPage, undefined, {
          timeout: MEASUREMENT_TIMEOUT_MS,
        })
      : null;

    // Never record a zero. The wait proved a match existed in the state the
    // action needs, so a zero here describes a re-render in the gap rather
    // than the page the action is about to touch. (A `read` waits for
    // `attached`, so zero VISIBLE matches is a legitimate answer there — the
    // field is simply left off rather than discarding the rest.)
    if (matchCount === 0) return undefined;
    if (singular.state === 'visible' && visibleMatchCount === 0) return undefined;

    const out: ActionTargeting = {
      ...(matchCount !== undefined && { matchCount }),
      ...(visibleMatchCount !== undefined && visibleMatchCount > 0 && { visibleMatchCount }),
      ...(resolved !== null && { resolvedSelector: resolved.selector, resolvedBy: resolved.by }),
    };
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `resolvedSelector`'s browser half: a selector that addresses THIS element
 * and nothing else, verified against the live document, plus how it was
 * arrived at. Null when nothing verified.
 *
 * Three candidates, best first, each verified before it is returned:
 *
 *   1. `'attribute'` — the element's own handle (`strongSelector`).
 *   2. `'scoped'` — that same handle qualified by the nearest addressable
 *      ancestor, e.g. `#statements a[href="transactions.html"]`. This is the
 *      form the story's worked example shows, and it is the one the headline
 *      case needs: a hidden drawer copy makes the bare `href` match twice, so
 *      the element's own handle cannot verify even though it describes the
 *      element perfectly well.
 *   3. `'positional'` — `stableSelector`'s `nth-of-type` chain.
 *
 * 2 sits above 3 because the two are not equally good even when both verify.
 * Insert a sibling above the panel and the positional chain silently
 * retargets; the scoped form does not. What this function returns is compiled
 * into a file that gets committed and runs for years, which is exactly where
 * that difference gets expensive — and it is why `resolvedBy` is reported
 * rather than left to be sniffed out of the string: generation has to tell
 * "here is a stable handle" from "this is positional, so build the locator
 * from `step.getVar(...)` if the step names what distinguishes the element".
 *
 * The scope joins with a plain space, not `>`, so an intervening wrapper does
 * not break it — and, like `stableSelector`'s spaced `' > '`, that is safe
 * only because this output is ever an ELEMENT selector and never a frame path,
 * out of reach of `resolveLocatorRoot`'s whitespace split.
 *
 * Runs in the BROWSER context, so it must be self-contained — no closures over
 * Node-side state, no references to other helpers in this module. That is the
 * same constraint (and the same remedy) as `extractValueInPage` /
 * `executeReadMultiple`: Playwright cannot serialise references to Node scope,
 * so the body is duplicated literally and the tests keep the two copies in
 * lockstep.
 *
 * Everything between the MIRROR markers below is copied verbatim from
 * `src/browser/scripts/find-in-dom.js` — `escAttr`, `idSelector`, `verifies`,
 * `strongSelector` and `stableSelector`, in that order — because the story's
 * requirement is that the runtime walks *the existing candidate hierarchy*.
 * A drift between the two is a silent divergence in what the AI is handed
 * versus what the entry is generated from, so
 * `tests/selector-measurement.test.ts` compares the two sources
 * character-for-character (whitespace and TS annotations normalised).
 *
 * The scoped tier is deliberately OUTSIDE those markers: it is this function's
 * own layer, which find-in-dom.js does not have, and a mirror has to stay a
 * mirror. Its candidate list is pinned to `strongSelector`'s by a test that
 * compares the attributes each of them reads, in order.
 */
// This package's `lib` is ES2022 with no DOM — it is a Node process that
// drives a browser, not a browser. Naming `document` (erased at compile time,
// and referenced only from the browser-context function below) is what lets
// the mirrored block stay character-identical to the .js it was copied from
// instead of paraphrasing every reference to it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const document: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolvedSelectorInPage(el: any): ResolvedSelection | null {
  /* MIRROR-BEGIN find-in-dom.js */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function escAttr(v: any) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function idSelector(id: any) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return '#' + id;
    return '[id="' + escAttr(id) + '"]';
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function verifies(sel: any, el: any) {
    try {
      var found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (err) {
      return false;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function strongSelector(el: any) {
    var tag = el.tagName.toLowerCase();
    var testId = el.getAttribute('data-testid');
    if (testId) {
      var testIdSel = '[data-testid="' + escAttr(testId) + '"]';
      if (verifies(testIdSel, el)) return testIdSel;
    }
    var id = el.getAttribute('id');
    if (id) {
      var idSel = idSelector(id);
      if (verifies(idSel, el)) return idSel;
    }
    var name = el.getAttribute('name');
    if (name) {
      var nameSel = tag + '[name="' + escAttr(name) + '"]';
      if (verifies(nameSel, el)) return nameSel;
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      var ariaSel = tag + '[aria-label="' + escAttr(ariaLabel) + '"]';
      if (verifies(ariaSel, el)) return ariaSel;
    }
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href) {
        var hrefSel = 'a[href="' + escAttr(href) + '"]';
        if (verifies(hrefSel, el)) return hrefSel;
      }
    }
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stableSelector(el: any) {
    var direct = strongSelector(el);
    if (direct) return direct;
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      var parent = cur.parentElement;
      var tag = cur.tagName.toLowerCase();
      var n = 1;
      var sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) n++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + n + ')');
      var parentSel = strongSelector(parent);
      if (parentSel) {
        parts.unshift(parentSel);
        return parts.join(' > ');
      }
      cur = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }
  /* MIRROR-END */

  // Every attribute handle the hierarchy above would consider for THIS
  // element, in the same order, but UNVERIFIED — `strongSelector` returns only
  // handles that already address the element on their own, and the whole point
  // of the scoped tier is the case where one does not. The two lists are
  // pinned together by `attributesReadBy` in tests/selector-measurement.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ownAttrSelectors(el: any) {
    var tag = el.tagName.toLowerCase();
    var out = [];
    var testId = el.getAttribute('data-testid');
    if (testId) out.push('[data-testid="' + escAttr(testId) + '"]');
    var id = el.getAttribute('id');
    if (id) out.push(idSelector(id));
    var name = el.getAttribute('name');
    if (name) out.push(tag + '[name="' + escAttr(name) + '"]');
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) out.push(tag + '[aria-label="' + escAttr(ariaLabel) + '"]');
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href) out.push('a[href="' + escAttr(href) + '"]');
    }
    return out;
  }

  try {
    var direct = strongSelector(el);
    if (direct) return { selector: direct, by: 'attribute' };

    // Nearest addressable ancestor first, and within it the strongest handle
    // first — so `#panel [data-testid="x"]` beats `#panel a[href="y"]`, and
    // both beat anything anchored further up the tree.
    var owns = ownAttrSelectors(el);
    if (owns.length > 0) {
      var cur = el.parentElement;
      while (cur && cur !== document.body && cur.parentElement) {
        var anchor = strongSelector(cur);
        if (anchor) {
          for (var i = 0; i < owns.length; i++) {
            var scoped = anchor + ' ' + owns[i];
            if (verifies(scoped, el)) return { selector: scoped, by: 'scoped' };
          }
        }
        cur = cur.parentElement;
      }
    }

    // The last word is the document's, not the builder's: `stableSelector`'s
    // positional chain is unique by construction on ordinary markup, but a
    // camel-cased SVG tag or an element outside `document.body` can defeat it,
    // and a `resolvedSelector` that is not verified is worth less than none.
    var chain = stableSelector(el);
    if (chain && verifies(chain, el)) return { selector: chain, by: 'positional' };
    return null;
  } catch (err) {
    return null;
  }
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
async function executeRead(
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<string> {
  const selector = requireSelector(action);
  const attribute = action.attribute;
  const target = attribute ? `@${attribute}` : 'text';
  logger.subAction(`read ${selector} ${target} → ${action.as ?? '(unnamed)'}`);

  let value = await root
    .locator(selector)
    .first()
    .evaluate(extractValueInPage, attribute, timeoutMs !== undefined ? { timeout: timeoutMs } : undefined);

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
 *
 * Returns the count alongside the values because the page has already told us
 * — it is `targeting.matchCount` for free, useful context for generating the
 * loop, and the only measurement a plural action gets
 * (stories/codebehind-selector-ambiguity.md). It counts MATCHED elements, not
 * captured values: a `pattern` that drops non-matching elements shortens the
 * list without changing what the selector found.
 */
async function executeReadMultiple(
  root: Page | FrameLocator,
  action: AIAction,
): Promise<{ values: string[]; matchCount: number }> {
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
  let matchCount = values.length;
  if (values.length >= READ_MULTIPLE_MAX) {
    const total = await root.locator(selector).count().catch(() => values.length);
    matchCount = total;
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
  return { values: result, matchCount };
}
