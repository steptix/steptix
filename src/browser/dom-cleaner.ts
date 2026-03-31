import type { Frame, Page } from 'playwright';

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
 */
export async function captureDomSnapshot(page: Page): Promise<string> {
  let snapshot = (await page.evaluate(DOM_CLEANER_SCRIPT) as string | null) ?? '';

  if (snapshot.includes('[iframe:')) {
    snapshot = await injectFrameContent(page, snapshot);
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
        frameContent = await frame.evaluate(DOM_CLEANER_SCRIPT) as string;

        // Recursively capture nested iframe content within this frame.
        // Pass the current frame path so nested iframe comments show the full chain.
        if (depth < MAX_IFRAME_DEPTH && frameContent.includes('[iframe:')) {
          frameContent = await injectFrameContent(frame, frameContent, depth + 1, framePath);
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
 * Self-contained browser script as a string expression.
 * This avoids any Node/TypeScript runtime helpers leaking into the browser context.
 *
 * Iframes are output with a [iframe:N] placeholder — do NOT recurse into them here.
 * captureDomSnapshot handles frame content via Playwright's Frame API instead.
 */
const DOM_CLEANER_SCRIPT = `(() => {
  const INTERACTIVE_TAGS = new Set([
    'input', 'button', 'a', 'select', 'textarea', 'label',
    'nav', 'main', 'header', 'footer', 'form', 'section', 'article',
  ]);

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'svg', 'canvas', 'video', 'audio',
    'meta', 'link', 'base', 'title',
  ]);

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  }

  function getAttributes(el) {
    const attrs = [];
    const important = [
      'id', 'class', 'data-testid', 'name', 'type', 'role', 'aria-label',
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

  function getPositionAnnotation(el) {
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
    return text.trim().substring(0, 100);
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

    const attrs = getAttributes(el);
    const text = getVisibleText(el);
    const selector = buildSelector(el);
    const isInteractive = INTERACTIVE_TAGS.has(tag);

    let output = '';
    if (isInteractive || text || attrs) {
      const selectorComment = isInteractive ? ' <!-- ' + selector + ' -->' : '';
      const posAnnotation = isInteractive ? getPositionAnnotation(el) : '';
      const textContent = text ? ' ' + text : '';
      output += indent + '<' + tag + attrs + '>' + textContent + selectorComment + posAnnotation + '\\n';
    }

    for (const child of el.children) {
      output += processElement(child, depth + (isInteractive ? 1 : 0));
    }

    if (isInteractive || text || attrs) {
      if (!['input', 'br', 'hr', 'img', 'link', 'meta'].includes(tag)) {
        output += indent + '</' + tag + '>\\n';
      }
    }
    return output;
  }

  try {
    const body = document.body;
    if (!body) return '<body>(empty)</body>';
    return processElement(body, 0) || '<body>(no visible interactive elements)</body>';
  } catch (err) {
    return '<error>Failed to clean DOM: ' + String(err) + '</error>';
  }
})()`;

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
