import type { Frame, Page } from 'playwright';

/** Maximum character length for DOM snapshots (prevents token blowup). */
const DOM_SNAPSHOT_CHAR_LIMIT = 80_000;

/**
 * Capture a raw DOM snapshot from the current page.
 *
 * Emits the body tree almost verbatim — every element with every attribute —
 * stripping only `<script>` / `<style>` tags and HTML comments. Invisible
 * elements, text nodes, and wrapper divs are preserved.
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
  const script = buildDomCleanerScript();
  let snapshot = (await page.evaluate(script) as string | null) ?? '';

  if (snapshot.includes('[iframe:')) {
    snapshot = await injectFrameContent(page, snapshot, 0, '');
  }

  if (snapshot.length > DOM_SNAPSHOT_CHAR_LIMIT) {
    snapshot = snapshot.substring(0, DOM_SNAPSHOT_CHAR_LIMIT)
      + '\n<!-- DOM snapshot truncated — page content exceeds size limit -->';
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
        frameContent = await frame.evaluate(buildDomCleanerScript()) as string;

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
 * Build the self-contained browser script as a string expression.
 * This avoids any Node/TypeScript runtime helpers leaking into the browser context.
 *
 * Emits every element under `<body>` as raw, indented HTML:
 *  - All attributes are preserved (attribute values with `"` are HTML-escaped).
 *  - `<script>` and `<style>` subtrees are omitted.
 *  - HTML comment nodes are dropped; text nodes are kept (whitespace collapsed).
 *  - Iframes are emitted as `[iframe:N]` placeholders; captureDomSnapshot replaces
 *    them via Playwright's Frame API (CDP-backed, cross-origin-safe).
 */
function buildDomCleanerScript(): string {
  return `(() => {
  var SKIP_TAGS = new Set(['script', 'style']);
  var SELF_CLOSING_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  function buildSelector(el) {
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';
    var id = el.getAttribute('id');
    if (id) return '#' + id;
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + name + '"]';
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return tag + '[aria-label="' + ariaLabel + '"]';
    var src = el.getAttribute('src');
    if (src && tag === 'iframe') return tag + '[src="' + src + '"]';
    return tag;
  }

  function escapeAttr(v) {
    return String(v == null ? '' : v).replace(/"/g, '&quot;');
  }

  function getAttributes(el) {
    var out = '';
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      out += ' ' + a.name + '="' + escapeAttr(a.value) + '"';
    }
    return out;
  }

  var iframeIdx = 0;

  function processElement(el, depth) {
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';

    var indent = '  '.repeat(depth);

    if (tag === 'iframe') {
      var attrs = getAttributes(el);
      var frameSelector = buildSelector(el);
      var idx = iframeIdx++;
      return indent + '<iframe' + attrs + '> <!-- ' + frameSelector + ' -->\\n'
           + indent + '  [iframe:' + idx + ']\\n'
           + indent + '</iframe>\\n';
    }

    var attrs = getAttributes(el);

    if (SELF_CLOSING_TAGS.has(tag)) {
      return indent + '<' + tag + attrs + '>\\n';
    }

    var childOutput = processChildNodes(el, depth + 1);
    return indent + '<' + tag + attrs + '>\\n'
         + childOutput
         + indent + '</' + tag + '>\\n';
  }

  function processChildNodes(parent, depth) {
    var output = '';
    var indent = '  '.repeat(depth);
    var nodes = parent.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType === 1) {
        // ELEMENT_NODE
        output += processElement(node, depth);
      } else if (node.nodeType === 3) {
        // TEXT_NODE — collapse whitespace, drop if empty
        var text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text) {
          output += indent + text + '\\n';
        }
      }
      // COMMENT_NODE (8) and others: drop
    }
    return output;
  }

  try {
    var body = document.body;
    if (!body) return '<body>(empty)</body>';
    var result = processChildNodes(body, 0);
    return result || '<body>(no content)</body>';
  } catch (err) {
    return '<error>Failed to capture DOM: ' + String(err) + '</error>';
  }
})()`;
}

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
