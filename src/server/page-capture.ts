/**
 * Read one Playwright page faithfully — visible text, or the cleaned DOM.
 *
 * Extracted from `SessionManager.getPageContent`/`capturePage` by
 * stories/tab-peek.md so the sharing between a SESSION read and a TAB read is
 * real rather than described: the navigation retry, the whole-code-point slice
 * and the `truncated` derivation live here once, and both doors call this.
 * Two copies is how "a peek agrees with get_page_content" (tab-peek
 * verification item 2) quietly stops being true.
 *
 * Server-side on purpose: it takes a `Page` and reaches into
 * `src/browser/dom-cleaner.ts`, and the MCP process is deliberately
 * browser-free (`tests/mcp-entry-graph.test.ts` pins that import graph).
 */
import type { Page } from 'playwright';
import type { Config } from '../config/types.js';
import {
  captureDomSnapshot,
  captureVisibleText,
  domCaptureFailure,
  domSnapshotWasClipped,
  expandDomSubtree,
  toPageCaptureError,
  PageCaptureError,
} from '../browser/dom-cleaner.js';

export type PageContentFormat = 'text' | 'dom';

/** How to read the page — see stories/page-content.md §1. */
export interface PageContentOptions {
  format: PageContentFormat;
  /** Restrict the read to the first element matching this CSS selector. */
  selector?: string | undefined;
  /** Hard cap on returned characters. Over-limit content is truncated and
   *  flagged, never silently clipped. */
  maxChars: number;
}

/**
 * One page, as read. The half of a `PageContent` response that is about the
 * PAGE rather than about who was addressing it — a session read adds
 * `sessionId` + `status`, a peek adds `targetId` + the root its settings came
 * from.
 */
export interface CapturedPageContent {
  url: string;
  title: string;
  format: PageContentFormat;
  selector: string | null;
  content: string;
  truncated: boolean;
  returnedChars: number;
  /**
   * Characters the capture produced, before this layer's truncation.
   *
   * A floor, not the page's true size: for `format: 'dom'` the capture is
   * itself bounded by the project's `domSnapshotCharLimit`, so a very large
   * page reports the limit rather than its real length. When that happened,
   * `truncated` is true even if `availableChars <= maxChars` — which is the
   * only signal distinguishing "you got everything" from "you got everything
   * we were willing to capture".
   */
  availableChars: number;
}

/** Settle time before the single retry of a page read that lost to a
 *  navigation. Long enough for a same-document commit, short enough that a
 *  caller waiting on a GET does not notice. */
export const NAVIGATION_RETRY_DELAY_MS = 500;

/** One capture's result, plus whether the capture itself already clipped. */
interface CapturedPage {
  text: string;
  /** True when `domSnapshotCharLimit` cut the snapshot before this layer saw
   *  it, so the caller must be told the page is longer than what it received. */
  captureClipped: boolean;
}

/**
 * Slice to at most `max` UTF-16 units without splitting a surrogate pair.
 *
 * `String.prototype.slice` cuts by code unit, so a boundary landing inside an
 * emoji or any astral character leaves a lone high surrogate — which survives
 * `JSON.stringify` but decodes to U+FFFD for whoever reads it. Backing off one
 * unit costs a character and keeps the tail readable.
 */
function sliceWholeCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastUnit = text.charCodeAt(max - 1);
  const endsOnHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return text.slice(0, endsOnHighSurrogate ? max - 1 : max);
}

/**
 * Read `page` under `browserConfig`'s capture settings.
 *
 * Throws `PageCaptureError` when the page could not be read. It deliberately
 * does NOT return empty content for a failed capture: "the page says nothing"
 * and "we could not read the page" are different answers, and a caller that
 * cannot tell them apart will confidently report the first.
 *
 * `browserConfig` is the PROJECT's, never the library defaults — the two
 * differ (a 100k dom clip against a configured 300k, different noise
 * reduction), so a caller that skips resolving a project bundle silently reads
 * a different page than `get_page_content` would.
 */
export async function capturePageContent(
  page: Page,
  browserConfig: Config['browser'],
  opts: PageContentOptions,
): Promise<CapturedPageContent> {
  let captured: CapturedPage;
  try {
    captured = await capture(page, browserConfig, opts);
  } catch (err) {
    // One retry, for the one failure that is genuinely transient: the read
    // raced a navigation. Everything else propagates immediately — retrying
    // a wedged page or a bad selector just doubles the wait.
    if (!(err instanceof PageCaptureError) || err.kind !== 'navigated') throw err;
    await new Promise((r) => setTimeout(r, NAVIGATION_RETRY_DELAY_MS));
    captured = await capture(page, browserConfig, opts);
  }

  const raw = captured.text;
  const availableChars = raw.length;
  // Two independent clips, and BOTH have to reach the caller. `captureClipped`
  // is the one that bites silently: captureDomSnapshot enforces the project's
  // domSnapshotCharLimit before this layer ever sees the string, so a page
  // clipped there arrives looking complete. An agent told `truncated: false`
  // on a quarter of a page will report that the rest of it does not exist —
  // and raising `max_chars` past the project limit turns a correct warning
  // into a confident wrong answer.
  const truncated = captured.captureClipped || availableChars > opts.maxChars;
  const content =
    availableChars > opts.maxChars ? sliceWholeCodePoints(raw, opts.maxChars) : raw;

  // Best-effort, unlike the content itself: an unreadable title is not the
  // answer to the question that was asked, so it degrades to '' rather than
  // failing a read that otherwise succeeded.
  let url = '';
  let title = '';
  try {
    url = page.url();
    title = await page.title();
  } catch {
    // Browser may be in an intermediate state.
  }

  return {
    url,
    title,
    format: opts.format,
    selector: opts.selector ?? null,
    content,
    truncated,
    returnedChars: content.length,
    availableChars,
  };
}

/** Dispatch one capture. Failures arrive as `PageCaptureError` whichever
 *  path produced them — some throw, some report in band. */
async function capture(
  page: Page,
  browserConfig: Config['browser'],
  opts: PageContentOptions,
): Promise<CapturedPage> {
  if (opts.format === 'text') {
    const text = await captureVisibleText(page, { selector: opts.selector });
    return { text, captureClipped: false };
  }

  // Both DOM paths report failure in band — `expandDomSubtree` catches its
  // own evaluate, and `captureDomSnapshot` catches all of its except
  // `injectFrameContent`, which runs outside its try. The try/catch below is
  // defensive rather than load-bearing for expand today; it stays because an
  // unclassified throw would bypass the navigation retry and land as a bare
  // 500, and that contract should not depend on a helper never changing.
  if (opts.selector !== undefined) {
    let expanded: string;
    try {
      expanded = await expandDomSubtree(page, opts.selector);
    } catch (err) {
      throw toPageCaptureError(err, 'DOM capture', true);
    }
    const failure = domCaptureFailure(expanded, 'expand');
    if (failure) throw failure;
    // No clip flag: expandDomSubtree does not apply domSnapshotCharLimit, so
    // what it returns is the whole subtree (see stories/page-content.md §2).
    return { text: expanded, captureClipped: false };
  }

  // Project settings, not the server's — see `ManagedSession.browserConfig`
  // for a session, and the peek route's project bundle for a tab.
  let snapshot: string;
  try {
    snapshot = await captureDomSnapshot(page, {
      ...browserConfig.domNoiseReduction,
      maxIframeDepth: browserConfig.maxIframeDepth,
      domSnapshotCharLimit: browserConfig.domSnapshotCharLimit,
    });
  } catch (err) {
    throw toPageCaptureError(err, 'DOM capture');
  }
  const failure = domCaptureFailure(snapshot, 'snapshot');
  if (failure) throw failure;
  return { text: snapshot, captureClipped: domSnapshotWasClipped(snapshot) };
}
