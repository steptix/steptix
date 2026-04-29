import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from 'playwright';

/** Default maximum character length for DOM snapshots (prevents token blowup).
 *  Overridable per-call via CaptureDomOptions.domSnapshotCharLimit. */
const DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT = 100_000;
/** Default maximum nesting depth for recursive iframe content capture.
 *  Overridable per-call via CaptureDomOptions.maxIframeDepth. */
const DEFAULT_MAX_IFRAME_DEPTH = 5;

/** Hard timeout for the main page evaluate. Pages with stuck JS otherwise hang forever. */
const PAGE_EVALUATE_TIMEOUT_MS = 30_000;
/** Hard timeout for each iframe evaluate. Cross-origin / busy frames otherwise hang the whole capture. */
const FRAME_EVALUATE_TIMEOUT_MS = 10_000;
/** Timeout for resolving an iframe element handle. */
const IFRAME_HANDLE_TIMEOUT_MS = 5_000;

/**
 * Run target.evaluate with a hard timeout. Playwright's evaluate has no built-in
 * timeout — if the page's JS thread is stuck (long task, infinite loop, blocking
 * sync XHR, etc.) the call blocks indefinitely. We race against a setTimeout so
 * the snapshot can degrade gracefully instead of hanging the whole runner.
 */
async function evaluateWithTimeout<T>(target: Page | Frame, script: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target.evaluate(script) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`evaluate timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Load a browser-side script once at module init. Scripts live in ./scripts/
 * and are copied alongside the compiled output (see package.json build step).
 */
function loadScript(name: string): string {
  const url = new URL(`./scripts/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

/** Template-substitute __TOKEN__ placeholders with the given string values. */
function substitute(template: string, bindings: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(bindings)) {
    out = out.split(`__${k}__`).join(v);
  }
  return out;
}

const CAPTURE_DOM_TEMPLATE = loadScript('capture-dom.js');
const FIND_IN_DOM_TEMPLATE = loadScript('find-in-dom.js');

/** Options for captureDomSnapshot. */
export interface CaptureDomOptions {
  /** Collapse long repetitive sibling runs (table rows, list items, card grids)
   *  into head + omission marker + tail. See stories/collapse-repetitive-dom.md */
  collapseRepetitiveDom?: boolean | undefined;
  /** Replace <svg> geometry with a placeholder comment, keeping the opening tag
   *  and any <title>/<desc> children. Defaults to true in DEFAULT_CONFIG. */
  compactSvg?: boolean | undefined;
  /** Drop `<input type="hidden">` elements. Default true in DEFAULT_CONFIG. */
  hideHiddenInputs?: boolean | undefined;
  /** Drop elements (and subtrees) whose computed `display` is `none`.
   *  Default true in DEFAULT_CONFIG. */
  hideDisplayNoneElements?: boolean | undefined;
  /** Drop elements (and subtrees) marked `aria-hidden="true"`.
   *  Default true in DEFAULT_CONFIG. */
  hideAriaHiddenElements?: boolean | undefined;
  /** Maximum nesting depth for recursive iframe content capture.
   *  Default 5 in DEFAULT_CONFIG. */
  maxIframeDepth?: number | undefined;
  /** Hard character cap on the rendered DOM snapshot.
   *  Default 100000 in DEFAULT_CONFIG. */
  domSnapshotCharLimit?: number | undefined;
}

/** Resolved, all-fields-present option set used internally. */
interface ResolvedDomOptions {
  collapse: boolean;
  compactSvg: boolean;
  hideHiddenInputs: boolean;
  hideDisplayNone: boolean;
  hideAriaHidden: boolean;
  maxIframeDepth: number;
  domSnapshotCharLimit: number;
}

function resolveOptions(opts: CaptureDomOptions): ResolvedDomOptions {
  return {
    collapse: opts.collapseRepetitiveDom === true,
    compactSvg: opts.compactSvg !== false,
    hideHiddenInputs: opts.hideHiddenInputs !== false,
    hideDisplayNone: opts.hideDisplayNoneElements !== false,
    hideAriaHidden: opts.hideAriaHiddenElements !== false,
    maxIframeDepth: opts.maxIframeDepth ?? DEFAULT_MAX_IFRAME_DEPTH,
    domSnapshotCharLimit: opts.domSnapshotCharLimit ?? DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT,
  };
}

/**
 * Capture a raw DOM snapshot from the current page.
 *
 * Emits the `<body>` element and its tree almost verbatim — every element
 * with every attribute — stripping `<script>` / `<style>` tags and HTML
 * comments. Text nodes and wrapper divs are preserved. Hidden elements
 * (`<input type="hidden">`, `display: none`, `aria-hidden="true"`) are
 * dropped by default; see CaptureDomOptions to opt out.
 *
 * Iframes are handled in two steps:
 *  1. The browser script marks each iframe with a placeholder ([iframe:N]).
 *  2. captureDomSnapshot replaces each placeholder using Playwright's Frame API,
 *     which uses CDP and works regardless of same-origin / sandbox restrictions —
 *     unlike accessing contentDocument from within page.evaluate().
 *
 * We use a string-based evaluate to avoid TypeScript/esbuild injecting
 * helper functions (like __name) that don't exist in the browser context.
 */
export async function captureDomSnapshot(page: Page, opts: CaptureDomOptions = {}): Promise<string> {
  const resolved = resolveOptions(opts);
  const script = buildDomCleanerScript(resolved);
  let snapshot: string;
  try {
    snapshot = (await evaluateWithTimeout<string | null>(page, script, PAGE_EVALUATE_TIMEOUT_MS)) ?? '';
  } catch (err) {
    return `<error>DOM capture timed out: ${String(err)}</error>`;
  }

  if (snapshot.includes('[iframe:')) {
    snapshot = await injectFrameContent(page, snapshot, 0, '', resolved);
  }

  if (snapshot.length > resolved.domSnapshotCharLimit) {
    snapshot = snapshot.substring(0, resolved.domSnapshotCharLimit)
      + '\n<!-- DOM snapshot truncated — page content exceeds size limit -->';
  }

  return snapshot;
}

/**
 * Replace [iframe:N] placeholders in the snapshot with the actual DOM content
 * of each child frame, captured via Playwright's Frame API.
 *
 * Recurses into nested iframes up to opts.maxIframeDepth levels deep.
 *
 * IMPORTANT: We iterate iframe *elements* in DOM order (via locator) rather
 * than using page.frames(), because page.frames() returns frames in attachment
 * order which may differ from DOM traversal order. The browser script assigns
 * [iframe:N] indices during a depth-first DOM walk, so we must match that order.
 */
async function injectFrameContent(
  root: Page | Frame,
  snapshot: string,
  depth: number = 0,
  parentFramePath: string = '',
  opts: ResolvedDomOptions = {
    collapse: false,
    compactSvg: true,
    hideHiddenInputs: true,
    hideDisplayNone: true,
    hideAriaHidden: true,
    maxIframeDepth: DEFAULT_MAX_IFRAME_DEPTH,
    domSnapshotCharLimit: DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT,
  },
): Promise<string> {
  const iframeLocators = await root.locator('iframe').all();
  if (iframeLocators.length === 0) return snapshot;

  let result = snapshot;

  // If we're inside a parent frame, rewrite <!-- selector --> comments on <iframe>
  // tags in this snapshot to show the full frame path (e.g. "#outer >> #inner")
  // so the AI can copy the path directly into the "frame" field.
  if (parentFramePath) {
    result = prefixIframeComments(result, parentFramePath);
  }

  let idx = 0;
  for (const iframeLoc of iframeLocators) {
    const placeholder = `[iframe:${idx}]`;
    idx++;

    if (!result.includes(placeholder)) continue;

    // Extract this iframe's selector from the <!-- selector --> comment preceding
    // the placeholder so we can build the full frame path for nested iframes.
    const iframeSelector = extractIframeSelector(result, placeholder);
    const framePath = parentFramePath
      ? `${parentFramePath} >> ${iframeSelector}`
      : iframeSelector;

    let frameContent: string;
    try {
      const handle = await iframeLoc.elementHandle({ timeout: IFRAME_HANDLE_TIMEOUT_MS });
      const frame = handle ? await handle.contentFrame() : null;
      if (!frame) {
        frameContent = '[frame content unavailable]';
      } else {
        // Wait for the frame to finish loading before capturing its content.
        // This handles cases where a prior action updated the iframe's src
        // (e.g. via postMessage) and the new content hasn't loaded yet.
        await frame.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
        // frame.evaluate() uses CDP — works for both same-origin and cross-origin frames.
        // Wrapped in evaluateWithTimeout so a frame with stuck JS can't hang the whole capture.
        try {
          frameContent = await evaluateWithTimeout<string>(
            frame,
            buildDomCleanerScript(opts),
            FRAME_EVALUATE_TIMEOUT_MS,
          );
        } catch {
          frameContent = '[frame content unavailable — evaluate timed out]';
        }

        // Recursively capture nested iframe content within this frame.
        // Pass the current frame path so nested iframe comments show the full chain.
        if (depth < opts.maxIframeDepth && frameContent.includes('[iframe:')) {
          frameContent = await injectFrameContent(frame, frameContent, depth + 1, framePath, opts);
        }
      }
    } catch {
      frameContent = '[frame content unavailable]';
    }

    // Find the placeholder line, determine its indentation, and replace it
    // with the indented frame content.
    const lines = result.split('\n');
    const phIdx = lines.findIndex((l) => l.trim() === placeholder);

    if (phIdx === -1) {
      result = result.replace(placeholder, frameContent);
      continue;
    }

    const phLine = lines[phIdx]!;
    const lineIndent = phLine.match(/^(\s*)/)?.[1] ?? '';

    const indentedLines = frameContent
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => lineIndent + l);

    lines.splice(phIdx, 1, ...indentedLines);
    result = lines.join('\n');
  }

  // Clean up any remaining placeholders (beyond max depth or unresolved)
  result = result.replace(/\[iframe:\d+\]/g, '[nested frame — content not captured]');

  return result;
}

/**
 * Extract the iframe selector from the <!-- selector --> comment that sits
 * on the line with the <iframe> tag above the given placeholder.
 */
function extractIframeSelector(snapshot: string, placeholder: string): string {
  const lines = snapshot.split('\n');
  const phIdx = lines.findIndex((l) => l.trim() === placeholder);
  if (phIdx === -1) return 'iframe';

  // Walk backwards from the placeholder to find the <iframe ...> <!-- selector --> line
  for (let i = phIdx - 1; i >= Math.max(0, phIdx - 3); i--) {
    const match = lines[i]!.match(/<!--\s*(.+?)\s*-->/);
    if (match) return match[1]!;
  }
  return 'iframe';
}

/**
 * Rewrite `<!-- selector -->` comments inside `<iframe>` tags to prepend
 * the parent frame path, producing `<!-- parent >> selector -->`.
 * This gives the AI the full frame chain it needs for the "frame" field.
 */
function prefixIframeComments(content: string, parentPath: string): string {
  // Match: <iframe ...> <!-- selector -->
  return content.replace(
    /(<iframe[^>]*>\s*<!--\s*)(.+?)(\s*-->)/g,
    (_, before, selector, after) => `${before}${parentPath} >> ${selector}${after}`,
  );
}

/** Collapse thresholds — see [stories/collapse-repetitive-dom.md] for rationale. */
const COLLAPSE_MIN_RUN = 50;
const COLLAPSE_HEAD = 3;
const COLLAPSE_TAIL = 1;

/**
 * Build the self-contained browser script by substituting placeholders into the
 * template in [./scripts/capture-dom.js]. See that file for what the script does.
 */
function buildDomCleanerScript(opts: ResolvedDomOptions): string {
  return substitute(CAPTURE_DOM_TEMPLATE, {
    COLLAPSE: opts.collapse ? 'true' : 'false',
    COLLAPSE_MIN_RUN: String(COLLAPSE_MIN_RUN),
    COLLAPSE_HEAD: String(COLLAPSE_HEAD),
    COLLAPSE_TAIL: String(COLLAPSE_TAIL),
    COMPACT_SVG: opts.compactSvg ? 'true' : 'false',
    HIDE_HIDDEN_INPUTS: opts.hideHiddenInputs ? 'true' : 'false',
    HIDE_DISPLAY_NONE: opts.hideDisplayNone ? 'true' : 'false',
    HIDE_ARIA_HIDDEN: opts.hideAriaHidden ? 'true' : 'false',
  });
}

/** Result of a findInDom search */
export interface DomSearchMatch {
  /** CSS selector for the matching element (stable — auto-chains nth-of-type when no direct id/testid/name/aria-label) */
  selector: string;
  /** Tag name of the matching element */
  tag: string;
  /** Text content of the matching element (truncated) */
  text: string;
  /** Key attributes of the matching element */
  attributes: string;
  /** Ancestor chain for orientation (e.g. "main > div#content > table") */
  context: string;
}

/** Aggregate result of a findInDom call. */
export interface DomSearchResult {
  /** Matches returned (capped at FIND_DISPLAY_CAP). */
  matches: DomSearchMatch[];
  /** Total leaf-like matches discovered in the walked subtree (may exceed matches.length). */
  totalMatches: number;
  /** True when the walk hit FIND_HARD_MAX and stopped counting further. totalMatches is then a lower bound. */
  hitHardMax: boolean;
  /** Error message when the container selector was provided but matched nothing. */
  containerError?: string;
}

/** Maximum matches returned to the AI per find call. */
const FIND_DISPLAY_CAP = 50;
/** Hard ceiling on counting — the walker exits when this is reached. */
const FIND_HARD_MAX = 500;

/**
 * Search the DOM for elements containing the given text.
 *
 * Walks the subtree rooted at `containerSelector` (if provided, else `document.body`)
 * and returns up to FIND_DISPLAY_CAP leaf-like matches (an element is "leaf-like" when
 * no direct child also contains the text). The walker keeps counting past the display
 * cap up to FIND_HARD_MAX so the caller can report "N of M" and the AI can decide
 * whether to refine the query or narrow the scope.
 *
 * Selectors are stable: if the matched element has no direct `data-testid`/`id`/`name`/
 * `aria-label`, the result is a chained selector anchored at the nearest addressable
 * ancestor, with `nth-of-type(N)` steps in between.
 *
 * Used by the "find" exploration action.
 */
export async function findInDom(
  page: Page,
  searchText: string,
  containerSelector?: string,
): Promise<DomSearchResult> {
  const containerJson = containerSelector ? JSON.stringify(containerSelector) : null;
  const script = substitute(FIND_IN_DOM_TEMPLATE, {
    SEARCH_TEXT: JSON.stringify(searchText),
    CONTAINER_EXPR: containerJson ? `document.querySelector(${containerJson})` : 'document.body',
    CONTAINER_LABEL: containerJson ?? '""',
    DISPLAY_CAP: String(FIND_DISPLAY_CAP),
    HARD_MAX: String(FIND_HARD_MAX),
  });
  return await page.evaluate(script) as DomSearchResult;
}

/**
 * Expand the full DOM subtree for a given CSS selector.
 * Returns a detailed snapshot of that element's children — every visible
 * element with attributes and text. Used by the "expand" action, typically
 * after the AI sees a "N similar elements omitted" marker and wants to
 * inspect a specific item's contents.
 */
export async function expandDomSubtree(page: Page, selector: string): Promise<string> {
  const result = await page.evaluate(`(() => {
    const selector = ${JSON.stringify(selector)};
    const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'meta', 'link', 'base', 'title']);

    function getAttrs(el) {
      const attrs = [];
      const important = [
        'id', 'data-testid', 'name', 'type', 'role', 'aria-label',
        'placeholder', 'href', 'src', 'value', 'checked', 'selected',
        'disabled', 'readonly', 'for', 'action', 'method', 'title',
      ];
      for (const attr of important) {
        const val = el.getAttribute(attr);
        if (val !== null && val !== '') {
          attrs.push(attr + '="' + val + '"');
        }
      }
      return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
    }

    function buildSelector(el) {
      const testId = el.getAttribute('data-testid');
      if (testId) return '[data-testid="' + testId + '"]';
      const id = el.getAttribute('id');
      if (id) return '#' + id;
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute('name');
      if (name) return tag + '[name="' + name + '"]';
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return tag + '[aria-label="' + ariaLabel + '"]';
      return tag;
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    var INTERACTIVE = new Set(['input', 'button', 'a', 'select', 'textarea', 'label']);

    function processEl(el, depth) {
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return '';
      if (!isVisible(el)) return '';
      const indent = '  '.repeat(depth);
      const attrs = getAttrs(el);
      let text = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += (node.textContent || '').trim();
        }
      }
      text = text.substring(0, 100);
      const isInt = INTERACTIVE.has(tag);
      const selectorComment = isInt ? ' <!-- ' + buildSelector(el) + ' -->' : '';
      const textPart = text ? ' ' + text : '';
      let output = indent + '<' + tag + attrs + '>' + textPart + selectorComment + '\\n';
      for (const child of el.children) {
        output += processEl(child, depth + 1);
      }
      if (!['input', 'br', 'hr', 'img'].includes(tag)) {
        output += indent + '</' + tag + '>\\n';
      }
      return output;
    }

    try {
      const el = document.querySelector(selector);
      if (!el) return '[expand] No element found for selector: ' + selector;
      return processEl(el, 0);
    } catch (err) {
      return '[expand] Error: ' + String(err);
    }
  })()`) as string;

  return result;
}

/**
 * Format findInDom results for inclusion in the AI continuation message.
 */
export function formatFindResults(result: DomSearchResult, query: string, containerSelector?: string): string {
  const scopePart = containerSelector ? ` (in ${containerSelector})` : '';
  const header = `### find "${query}"${scopePart}`;

  if (result.containerError) {
    return `${header}\n${result.containerError}. Widen the scope or omit the container.`;
  }
  if (result.matches.length === 0) {
    return `${header}\nNo matches found.`;
  }

  const lines = result.matches.map((m, i) => {
    const contextPart = m.context ? ` (in ${m.context})` : '';
    return `${i + 1}. <${m.tag}${m.attributes ? ' ' + m.attributes : ''}> "${m.text}"${contextPart}\n   selector: ${m.selector}`;
  });

  const shown = result.matches.length;
  const total = result.totalMatches;
  let summary: string;
  if (shown === total) {
    summary = `Found ${total} match${total === 1 ? '' : 'es'}:`;
  } else if (result.hitHardMax) {
    summary = `Found ${shown} of ${total}+ matches (counting stopped at ${total}; showing first ${shown}). Refine the query or narrow the container to see specific items.`;
  } else {
    summary = `Found ${shown} of ${total} matches (showing first ${shown}). Refine the query or narrow the container to see more.`;
  }

  return `${header}\n${summary}\n${lines.join('\n')}`;
}

/**
 * Format expandDomSubtree results for inclusion in the AI continuation message.
 */
export function formatExpandResult(content: string, selector: string): string {
  return `### expand "${selector}"\n\`\`\`html\n${content}\n\`\`\``;
}

/**
 * Clean a raw HTML string into a simplified representation.
 * Used in unit tests where a real browser is not available.
 */
export function cleanHtmlString(html: string): string {
  // Parse in Node environment using basic regex-based extraction
  // (Full DOM parsing requires a browser — this is the unit-test-friendly version)
  return extractInteractiveElements(html);
}

/**
 * Simple regex-based HTML element extractor for unit testing.
 * Not as thorough as the browser-based version but works without a DOM.
 */
function extractInteractiveElements(html: string): string {
  const INTERACTIVE = ['input', 'button', 'a', 'select', 'textarea', 'label', 'form'];
  const lines: string[] = [];

  for (const tag of INTERACTIVE) {
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>|<${tag}[^>]*\/?>`, 'gi');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      const element = match[0];
      // Skip hidden elements
      if (/display:\s*none|visibility:\s*hidden/i.test(element)) continue;
      // Skip elements in script/style context
      if (/type="hidden"/i.test(element)) continue;

      lines.push(element.replace(/\s+/g, ' ').trim());
    }
  }

  return lines.join('\n');
}
