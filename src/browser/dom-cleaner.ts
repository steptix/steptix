import type { Page } from 'playwright';

/**
 * Capture a cleaned DOM snapshot from the current page.
 * Runs a script in the browser context to extract a simplified, AI-friendly
 * representation of the interactive and semantic elements.
 */
export async function captureDomSnapshot(page: Page): Promise<string> {
  // Cast to any so TypeScript doesn't complain about DOM types used inside
  // the browser-side function — page.evaluate() serializes it to run in-browser.
  return page.evaluate(cleanDomForAI as () => string);
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
 * This function runs INSIDE the browser via page.evaluate().
 * It must be self-contained — no imports, no external references.
 * DOM types (Element, HTMLElement, Node, document, window) are browser globals
 * that are not available in the Node TypeScript compilation target — they are
 * cast to unknown here and work correctly at runtime inside the browser.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanDomForAI(this: unknown): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const _window = (globalThis as any).window as any;
  const _document = (globalThis as any).document as any;
  const _Node = (globalThis as any).Node as any;
  const INTERACTIVE_TAGS = new Set([
    'input', 'button', 'a', 'select', 'textarea', 'label',
    'nav', 'main', 'header', 'footer', 'form', 'section', 'article',
  ]);

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'svg', 'canvas', 'video', 'audio',
    'meta', 'link', 'base', 'title',
  ]);

  function isVisible(el: any): boolean {
    const style = _window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetParent !== null
    );
  }

  function getAttributes(el: any): string {
    const attrs: string[] = [];

    // Priority attributes
    const important = [
      'id', 'data-testid', 'name', 'type', 'role', 'aria-label',
      'aria-labelledby', 'aria-describedby', 'aria-expanded', 'aria-checked',
      'aria-selected', 'aria-disabled', 'placeholder', 'href', 'value',
      'checked', 'selected', 'disabled', 'readonly', 'required',
      'for', 'action', 'method',
    ];

    for (const attr of important) {
      const val = el.getAttribute(attr);
      if (val !== null && val !== '') {
        attrs.push(`${attr}="${val}"`);
      }
    }

    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  function getVisibleText(el: any): string {
    // For inputs, return value or placeholder
    if (el.tagName.toLowerCase() === 'input') {
      if (el.value) return `[value="${el.value}"]`;
      if (el.placeholder) return `[placeholder="${el.placeholder}"]`;
      return '';
    }

    // Collect direct text nodes only (not nested)
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === _Node.TEXT_NODE) {
        text += (node.textContent ?? '').trim();
      }
    }
    return text.trim().substring(0, 100); // Truncate long text
  }

  function buildSelector(el: any): string {
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;

    const id = el.getAttribute('id');
    if (id) return `#${id}`;

    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) return `${tag}[name="${name}"]`;

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `${tag}[aria-label="${ariaLabel}"]`;

    return tag;
  }

  function processElement(el: any, depth: number): string {
    const tag = el.tagName.toLowerCase();

    if (SKIP_TAGS.has(tag)) return '';
    if (!isVisible(el)) return '';

    const indent = '  '.repeat(depth);
    const attrs = getAttributes(el);
    const text = getVisibleText(el);
    const selector = buildSelector(el);
    const isInteractive = INTERACTIVE_TAGS.has(tag);

    let output = '';

    if (isInteractive || text || attrs) {
      const selectorComment = isInteractive ? ` <!-- ${selector} -->` : '';
      const textContent = text ? ` ${text}` : '';
      output += `${indent}<${tag}${attrs}>${textContent}${selectorComment}\n`;
    }

    // Process children
    for (const child of el.children) {
      output += processElement(child, depth + (isInteractive ? 1 : 0));
    }

    if (isInteractive || text || attrs) {
      if (!['input', 'br', 'hr', 'img', 'link', 'meta'].includes(tag)) {
        output += `${indent}</${tag}>\n`;
      }
    }

    return output;
  }

  try {
    const body = _document.body;
    if (!body) return '<body>(empty)</body>';
    return processElement(body, 0) || '<body>(no visible interactive elements)</body>';
  } catch (err) {
    return `<error>Failed to clean DOM: ${String(err)}</error>`;
  }
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
