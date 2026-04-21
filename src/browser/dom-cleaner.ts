import type { Frame, Page } from 'playwright';

/**
 * DOM snapshot mode:
 *  - 'compact': action-oriented — only interactive elements, headings, landmarks (default)
 *  - 'readable': extraction-oriented — preserves visible text content in all elements
 */
export type DomMode = 'compact' | 'readable';

/** Options controlling DOM cleaner output beyond mode. */
export interface DomCleanerOptions {
  /** Preserve <div>/other wrappers that carry a `class` attribute and contain
   *  interactive/heading/landmark descendants. Adds grouping context for
   *  disambiguation at the cost of extra tokens. Default false. */
  preserveClassWrappers?: boolean;
}

/** Maximum character length for readable DOM snapshots (prevents token blowup). */
const READABLE_DOM_CHAR_LIMIT = 80_000;

/**
 * Capture a cleaned DOM snapshot from the current page.
 * Runs a script in the browser context to extract a simplified, AI-friendly
 * representation of the interactive and semantic elements.
 *
 * Iframes are handled in two steps:
 *  1. The browser script marks each iframe with a placeholder ([iframe:N]).
 *  2. captureDomSnapshot replaces each placeholder using Playwright's Frame API,
 *     which uses CDP and works regardless of same-origin / sandbox restrictions —
 *     unlike accessing contentDocument from within page.evaluate().
 *
 * We use a string-based evaluate to avoid TypeScript/esbuild injecting
 * helper functions (like __name) that don't exist in the browser context.
 *
 * @param mode - 'compact' (default) for action-oriented DOM, 'readable' for extraction-oriented
 * @param options - extra knobs (e.g. preserveClassWrappers)
 */
export async function captureDomSnapshot(
  page: Page,
  mode: DomMode = 'compact',
  options: DomCleanerOptions = {},
): Promise<string> {
  const script = buildDomCleanerScript(mode, options);
  let snapshot = (await page.evaluate(script) as string | null) ?? '';

  if (snapshot.includes('[iframe:')) {
    snapshot = await injectFrameContent(page, snapshot, 0, '', mode, options);
  }

  // Truncate oversized readable snapshots to prevent token blowup
  if (mode === 'readable' && snapshot.length > READABLE_DOM_CHAR_LIMIT) {
    snapshot = snapshot.substring(0, READABLE_DOM_CHAR_LIMIT)
      + '\n<!-- DOM snapshot truncated — page content exceeds readable mode limit -->';
  }

  return snapshot;
}

/** Maximum nesting depth for recursive iframe content capture. */
const MAX_IFRAME_DEPTH = 3;

/**
 * Replace [iframe:N] placeholders in the snapshot with the actual DOM content
 * of each child frame, captured via Playwright's Frame API.
 *
 * Recurses into nested iframes up to MAX_IFRAME_DEPTH levels deep.
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
  mode: DomMode = 'compact',
  options: DomCleanerOptions = {},
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
  // Track which placeholder index we're at — only visible iframes get an index,
  // matching the browser script's iframeIdx counter which skips non-visible elements.
  let visibleIdx = 0;

  for (const iframeLoc of iframeLocators) {
    // Match the DOM cleaner's isVisible check (display/visibility/opacity).
    // The callback runs in the browser; use `any` to avoid needing DOM lib types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visible = await iframeLoc.evaluate((el: any) => {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }).catch(() => false);
    if (!visible) continue;

    const placeholder = `[iframe:${visibleIdx}]`;
    visibleIdx++;

    if (!result.includes(placeholder)) continue;

    // Extract this iframe's selector from the <!-- selector --> comment preceding
    // the placeholder so we can build the full frame path for nested iframes.
    const iframeSelector = extractIframeSelector(result, placeholder);
    const framePath = parentFramePath
      ? `${parentFramePath} >> ${iframeSelector}`
      : iframeSelector;

    let frameContent: string;
    try {
      const handle = await iframeLoc.elementHandle();
      const frame = handle ? await handle.contentFrame() : null;
      if (!frame) {
        frameContent = '[frame content unavailable]';
      } else {
        // Wait for the frame to finish loading before capturing its content.
        // This handles cases where a prior action updated the iframe's src
        // (e.g. via postMessage) and the new content hasn't loaded yet.
        await frame.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
        // frame.evaluate() uses CDP — works for both same-origin and cross-origin frames
        frameContent = await frame.evaluate(buildDomCleanerScript(mode, options)) as string;

        // Recursively capture nested iframe content within this frame.
        // Pass the current frame path so nested iframe comments show the full chain.
        if (depth < MAX_IFRAME_DEPTH && frameContent.includes('[iframe:')) {
          frameContent = await injectFrameContent(frame, frameContent, depth + 1, framePath, mode, options);
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

/**
 * Build the self-contained browser script as a string expression.
 * This avoids any Node/TypeScript runtime helpers leaking into the browser context.
 *
 * Produces a DOM snapshot designed to be paired with a screenshot.
 *
 * Two modes:
 *  - **compact** (default): selector-focused, for action steps (click/type).
 *    Only interactive elements, headings, landmarks, and elements with id/data-testid.
 *    Everything else is collapsed. Repeated siblings are limited to 2.
 *
 *  - **readable**: content-focused, for extraction/assertion steps.
 *    Preserves visible text in all elements (td, p, span, li, etc.).
 *    Text-bearing tags are shown with content. Container tags are preserved.
 *    Repeated siblings are limited to 5. Position annotations are omitted.
 *
 * Iframes are output with a [iframe:N] placeholder — do NOT recurse into them here.
 * captureDomSnapshot handles frame content via Playwright's Frame API instead.
 */
function buildDomCleanerScript(mode: DomMode, options: DomCleanerOptions = {}): string {
  const isReadable = mode === 'readable';
  const maxRepeat = isReadable ? 5 : 2;
  const preserveClassWrappers = options.preserveClassWrappers === true;

  return `(() => {
  var MODE = '${mode}';
  var MAX_REPEAT = ${maxRepeat};
  var PRESERVE_CLASS_WRAPPERS = ${preserveClassWrappers};

  const INTERACTIVE_TAGS = new Set([
    'input', 'button', 'a', 'select', 'textarea', 'label',
  ]);

  const LANDMARK_TAGS = new Set([
    'nav', 'main', 'header', 'footer', 'form', 'section', 'article',
  ]);

  const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem',
    'option', 'switch', 'slider', 'spinbutton', 'textbox', 'combobox',
    'searchbox', 'listbox',
  ]);

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'svg', 'canvas', 'video', 'audio',
    'meta', 'link', 'base', 'title',
  ]);

  // Tags that bear readable text content (shown in readable mode)
  var READABLE_TEXT_TAGS = new Set([
    'td', 'th', 'li', 'p', 'span', 'dd', 'dt', 'em', 'strong', 'b', 'i',
    'small', 'abbr', 'time', 'code', 'pre', 'blockquote', 'figcaption',
    'summary', 'caption',
  ]);

  // Container tags that are preserved in readable mode for structure
  var READABLE_CONTAINER_TAGS = new Set([
    'table', 'tr', 'tbody', 'thead', 'tfoot', 'ul', 'ol', 'dl',
    'figure', 'details', 'div',
  ]);

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  }

  function isInteractiveElement(el) {
    if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true;
    const role = el.getAttribute('role');
    return role !== null && INTERACTIVE_ROLES.has(role);
  }

  function getAttributes(el) {
    const attrs = [];
    const important = [
      'id', 'data-testid', 'name', 'type', 'role', 'aria-label',
      'aria-labelledby', 'aria-describedby', 'aria-expanded', 'aria-checked',
      'aria-selected', 'aria-disabled', 'placeholder', 'href', 'src', 'value',
      'checked', 'selected', 'disabled', 'readonly', 'required',
      'for', 'action', 'method', 'title',
    ];
    for (const attr of important) {
      const val = el.getAttribute(attr);
      if (val !== null && val !== '') {
        attrs.push(attr + '="' + val + '"');
      }
    }
    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  function getKeyAttributes(el) {
    const attrs = [];
    const keys = ['id', 'data-testid', 'role', 'aria-label', 'name', 'action', 'method'];
    for (const attr of keys) {
      const val = el.getAttribute(attr);
      if (val !== null && val !== '') {
        attrs.push(attr + '="' + val + '"');
      }
    }
    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  function getPositionAnnotation(el) {
    // Skip position annotations in readable mode — saves tokens, not needed for reading
    if (MODE === 'readable') return '';
    try {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return ' [pos:hidden]';
      return ' [pos:' + Math.round(rect.x) + ',' + Math.round(rect.y) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ']';
    } catch (e) {
      return '';
    }
  }

  function getVisibleText(el) {
    if (el.tagName.toLowerCase() === 'input') {
      if (el.value) return '[value="' + el.value + '"]';
      if (el.placeholder) return '[placeholder="' + el.placeholder + '"]';
      return '';
    }
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += (node.textContent || '').trim();
      }
    }
    text = text.trim();
    if (!text) {
      // Fallback: buttons/links often wrap their label in <span>/<i>/etc.
      // Use full textContent so the AI can match on visible label text.
      text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    }
    return text;
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
    const src = el.getAttribute('src');
    if (src && tag === 'iframe') return tag + '[src="' + src + '"]';
    return tag;
  }

  function hasRelevantDescendant(el) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;
    if (isInteractiveElement(el) || HEADING_TAGS.has(tag) || tag === 'iframe') return true;
    for (const child of el.children) {
      if (hasRelevantDescendant(child)) return true;
    }
    return false;
  }

  // In readable mode, check if an element or its descendants have visible text
  function hasVisibleText(el) {
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;
    var text = (el.textContent || '').trim();
    return text.length > 0;
  }

  let iframeIdx = 0;

  function processElement(el, depth) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';
    if (!isVisible(el)) return '';

    const indent = '  '.repeat(depth);

    // Iframes: output a placeholder keyed by index.
    // captureDomSnapshot replaces these with real frame content via Playwright's Frame API.
    if (tag === 'iframe') {
      const attrs = getAttributes(el);
      const frameSelector = buildSelector(el);
      const idx = iframeIdx++;
      return indent + '<iframe' + attrs + '> <!-- ' + frameSelector + ' -->\\n'
           + indent + '  [iframe:' + idx + ']\\n'
           + indent + '</iframe>\\n';
    }

    // Option elements: show value and text (children of <select>)
    if (tag === 'option') {
      const val = el.getAttribute('value') || '';
      const text = (el.textContent || '').trim().substring(0, 60);
      if (text || val) {
        return indent + '<option value="' + val + '"> ' + text + '</option>\\n';
      }
      return '';
    }

    // Interactive elements: full output with selector and position
    if (isInteractiveElement(el)) {
      const attrs = getAttributes(el);
      const text = getVisibleText(el);
      const selector = buildSelector(el);
      const pos = getPositionAnnotation(el);
      const textContent = text ? ' ' + text : '';
      const selfClose = ['input', 'br', 'hr', 'img'].includes(tag);
      let output = indent + '<' + tag + attrs + '>' + textContent + ' <!-- ' + selector + ' -->' + pos + '\\n';
      if (!selfClose) {
        output += processChildren(el, depth + 1);
        output += indent + '</' + tag + '>\\n';
      }
      return output;
    }

    // Headings: text content for orientation
    if (HEADING_TAGS.has(tag)) {
      const text = (el.textContent || '').trim();
      if (text) return indent + '<' + tag + '> ' + text + '</' + tag + '>\\n';
      return '';
    }

    // Landmarks: structural container with key attributes
    if (LANDMARK_TAGS.has(tag)) {
      const attrs = getKeyAttributes(el);
      const childOutput = processChildren(el, depth + 1);
      if (!childOutput.trim()) return '';
      return indent + '<' + tag + attrs + '>\\n' + childOutput + indent + '</' + tag + '>\\n';
    }

    // Elements with id or data-testid: structural container (preserves semantic markers)
    if (el.getAttribute('id') || el.getAttribute('data-testid')) {
      const attrs = getKeyAttributes(el);
      const childOutput = processChildren(el, depth + 1);
      if (!childOutput.trim()) return '';
      return indent + '<' + tag + attrs + '>\\n' + childOutput + indent + '</' + tag + '>\\n';
    }

    // ── Readable mode: preserve text-bearing and container elements ──
    if (MODE === 'readable') {
      // Text-bearing tags: show tag + text content
      if (READABLE_TEXT_TAGS.has(tag)) {
        var text = (el.textContent || '').trim();
        if (text) {
          var attrs = getKeyAttributes(el);
          return indent + '<' + tag + attrs + '> ' + text + ' </' + tag + '>\\n';
        }
        return '';
      }

      // Container tags: preserve structure, recurse into children
      if (READABLE_CONTAINER_TAGS.has(tag)) {
        var childOutput = processChildren(el, depth + 1);
        if (!childOutput.trim()) return '';
        var attrs = getKeyAttributes(el);
        return indent + '<' + tag + attrs + '>\\n' + childOutput + indent + '</' + tag + '>\\n';
      }

      // Other tags in readable mode: still collapse tag but pass through children
      // (same as compact default below, but we also check for visible text)
      if (hasVisibleText(el)) {
        return processChildren(el, depth);
      }
      return '';
    }

    // ── Compact mode default ──
    if (!hasRelevantDescendant(el)) return '';

    // Optionally preserve wrapper tags that carry a class attribute so the AI
    // can use grouping context (e.g. class="user-card", class="modal-footer")
    // to disambiguate similar interactive elements in different sections.
    if (PRESERVE_CLASS_WRAPPERS) {
      var cls = el.getAttribute('class');
      if (cls && cls.trim()) {
        var childOutput = processChildren(el, depth + 1);
        if (!childOutput.trim()) return '';
        return indent + '<' + tag + ' class="' + cls + '">\\n'
             + childOutput
             + indent + '</' + tag + '>\\n';
      }
    }

    // Default: skip tag, pass through children at same depth
    return processChildren(el, depth);
  }

  function processChildren(parent, depth) {
    const visible = [];
    for (const child of parent.children) {
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (!isVisible(child)) continue;
      visible.push(child);
    }

    let output = '';
    let i = 0;

    while (i < visible.length) {
      const el = visible[i];
      const tag = el.tagName.toLowerCase();

      // Count consecutive same-tag siblings
      let groupEnd = i + 1;
      while (groupEnd < visible.length && visible[groupEnd].tagName.toLowerCase() === tag) {
        groupEnd++;
      }
      const groupSize = groupEnd - i;

      // Collapse repeated siblings — but never collapse if any sibling in the
      // overflow group contains interactive or heading descendants.
      var canCollapse = groupSize > MAX_REPEAT && !isInteractiveElement(el) && !HEADING_TAGS.has(tag);
      if (canCollapse) {
        for (let k = i + MAX_REPEAT; k < groupEnd; k++) {
          if (hasRelevantDescendant(visible[k])) { canCollapse = false; break; }
        }
      }
      if (canCollapse) {
        for (let k = i; k < i + MAX_REPEAT; k++) {
          output += processElement(visible[k], depth);
        }
        const indent = '  '.repeat(depth);
        output += indent + '<!-- ' + (groupSize - MAX_REPEAT) + ' more <' + tag + '> -->\\n';
        i = groupEnd;
      } else {
        output += processElement(el, depth);
        i++;
      }
    }

    return output;
  }

  try {
    const body = document.body;
    if (!body) return '<body>(empty)</body>';
    const result = processChildren(body, 0);
    return result || '<body>(no visible interactive elements)</body>';
  } catch (err) {
    return '<error>Failed to clean DOM: ' + String(err) + '</error>';
  }
})()`;
}

/** Pre-built compact script for backward compatibility (used by cleanHtmlString) */
const DOM_CLEANER_SCRIPT = buildDomCleanerScript('compact');

/** Result of a findInDom search */
export interface DomSearchMatch {
  /** CSS selector for the matching element */
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

/**
 * Search the full DOM for elements containing the given text.
 * Returns matching elements with their selectors and parent context.
 * Used by the "find" exploration action.
 */
export async function findInDom(page: Page, searchText: string): Promise<DomSearchMatch[]> {
  const results = await page.evaluate(`(() => {
    const searchText = ${JSON.stringify(searchText)}.toLowerCase();
    const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'meta', 'link', 'base', 'title']);
    const matches = [];

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

    function getKeyAttrs(el) {
      const attrs = [];
      for (const a of ['id', 'data-testid', 'role', 'name', 'type', 'href']) {
        const v = el.getAttribute(a);
        if (v) attrs.push(a + '="' + v + '"');
      }
      return attrs.join(' ');
    }

    function getAncestorChain(el) {
      const parts = [];
      let cur = el.parentElement;
      let depth = 0;
      while (cur && cur !== document.body && depth < 4) {
        const tag = cur.tagName.toLowerCase();
        const id = cur.getAttribute('id');
        const testId = cur.getAttribute('data-testid');
        let label = tag;
        if (testId) label += '[data-testid="' + testId + '"]';
        else if (id) label += '#' + id;
        parts.unshift(label);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }

    function walk(el) {
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      const text = (el.textContent || '').trim();
      if (text.toLowerCase().includes(searchText)) {
        // Find the most specific element containing the text (leaf-ish match)
        let hasChildMatch = false;
        for (const child of el.children) {
          if ((child.textContent || '').trim().toLowerCase().includes(searchText)) {
            hasChildMatch = true;
            break;
          }
        }
        if (!hasChildMatch) {
          matches.push({
            selector: buildSelector(el),
            tag: tag,
            text: text.substring(0, 200),
            attributes: getKeyAttrs(el),
            context: getAncestorChain(el),
          });
          if (matches.length >= 10) return;
        }
      }
      if (matches.length < 10) {
        for (const child of el.children) {
          walk(child);
          if (matches.length >= 10) return;
        }
      }
    }

    try {
      walk(document.body);
      return matches;
    } catch (err) {
      return [{ selector: '', tag: 'error', text: String(err), attributes: '', context: '' }];
    }
  })()`) as DomSearchMatch[];

  return results;
}

/**
 * Expand the full DOM subtree for a given CSS selector.
 * Returns a detailed snapshot of that element's children — all elements with
 * attributes and text, not the compact version. Used by the "expand" action.
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
export function formatFindResults(matches: DomSearchMatch[], query: string): string {
  if (matches.length === 0) {
    return `### find "${query}"\nNo matches found.`;
  }
  const lines = matches.map((m, i) => {
    const contextPart = m.context ? ` (in ${m.context})` : '';
    return `${i + 1}. <${m.tag}${m.attributes ? ' ' + m.attributes : ''}> "${m.text}"${contextPart}\n   selector: ${m.selector}`;
  });
  return `### find "${query}"\nFound ${matches.length} match${matches.length > 1 ? 'es' : ''}:\n${lines.join('\n')}`;
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
