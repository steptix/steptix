/**
 * stories/codebehind-selector-ambiguity.md — "the framework's own selector
 * builder asserts uniqueness it never checks".
 *
 * `strongSelector` (src/browser/scripts/find-in-dom.js) and `buildSelector`
 * (src/browser/scripts/capture-dom.js) walk a candidate hierarchy and return
 * the first stable-*looking* attribute. Both now put each candidate through
 * `document.querySelectorAll(sel).length === 1 && [0] === el` and fall through
 * on failure.
 *
 * Against a real Chromium, because that predicate IS the browser: a stub that
 * answers "how many elements match" would only prove we can spell the call.
 * Duplicate ids, a display:none copy of a header link and a CSS string
 * containing a raw newline are all browser behaviours, not ours.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureDomSnapshot, findInDom } from '../src/browser/dom-cleaner.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
}, 15_000);

/** What the live document says a selector addresses. String-form evaluate and
 *  JSON-quoted interpolation for the same reason the source files use it: no
 *  bundler helpers in browser code, and a quote in a selector must not be able
 *  to terminate the literal. */
async function resolve(sel: string): Promise<{ count: number; text: string }> {
  return await page.evaluate(`(() => {
    const found = document.querySelectorAll(${JSON.stringify(sel)});
    return { count: found.length, text: found[0] ? (found[0].textContent || '').trim() : '' };
  })()`) as { count: number; text: string };
}

describe('strongSelector — verified against the document', () => {
  // The candidate hierarchy is data-testid, id, name, aria-label, anchor href.
  // `name` comes first here and matches twice, so it must be skipped rather
  // than returned — the whole point of walking the rest of the list.
  it('skips a candidate that matches two elements and takes the next one', async () => {
    await page.setContent(`
      <body>
        <div id="toolbar">
          <button name="action" aria-label="Delete invoice 7">Delete</button>
        </div>
        <div id="drawer" style="display:none">
          <button name="action" aria-label="Delete invoice 9">Delete</button>
        </div>
      </body>`);

    const result = await findInDom(page, 'Delete');

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]!.selector).toBe('button[aria-label="Delete invoice 7"]');
    expect(result.matches[1]!.selector).toBe('button[aria-label="Delete invoice 9"]');
    expect((await resolve(result.matches[0]!.selector)).count).toBe(1);
  });

  // The failure the story opens with: one login link in the header, a second
  // in a mobile-nav drawer that never renders. Playwright's strict mode counts
  // the hidden one, so verification must count it too.
  it('counts a hidden duplicate, so a[href] loses to a positional path', async () => {
    await page.setContent(`
      <body>
        <header id="site-header"><a href="/login">Sign in</a></header>
        <div id="mobile-drawer" style="display:none"><a href="/login">Sign in</a></div>
      </body>`);

    const result = await findInDom(page, 'Sign in');
    const selector = result.matches[0]!.selector;

    // What the builder used to return — and what strict mode rejects.
    expect(selector).not.toBe('a[href="/login"]');
    expect((await resolve('a[href="/login"]')).count).toBe(2);

    expect(selector).toBe('#site-header > a:nth-of-type(1)');
    expect((await resolve(selector)).count).toBe(1);
  });

  it('still returns the attribute handle when it is genuinely unique', async () => {
    await page.setContent(`<body><nav><a href="/login">Sign in</a></nav></body>`);

    const result = await findInDom(page, 'Sign in');

    expect(result.matches[0]!.selector).toBe('a[href="/login"]');
  });

  it('falls through to a positional path when the element has no handle', async () => {
    await page.setContent(`
      <body><ul id="items"><li>Alpha</li><li>Beta</li><li>Gamma</li></ul></body>`);

    const result = await findInDom(page, 'Beta');
    const selector = result.matches[0]!.selector;

    expect(selector).toBe('#items > li:nth-of-type(2)');
    expect(await resolve(selector)).toEqual({ count: 1, text: 'Beta' });
  });

  // stableSelector anchors its nth-of-type chain on strongSelector(parent).
  // An unverified anchor makes the whole composed path ambiguous: both spans
  // below used to come back as "#panel > span:nth-of-type(1)".
  it('does not anchor a chain on an ancestor that matches twice', async () => {
    await page.setContent(`
      <body>
        <section id="panel"><span>Total</span></section>
        <section id="panel"><span>Total</span></section>
      </body>`);

    const result = await findInDom(page, 'Total');
    const first = result.matches[0]!.selector;
    const second = result.matches[1]!.selector;

    expect(first).not.toContain('#panel');
    expect(first).not.toBe(second);
    expect(first).toBe('body > section:nth-of-type(1) > span:nth-of-type(1)');
    expect((await resolve(first)).count).toBe(1);
    expect((await resolve(second)).count).toBe(1);
  });

  // querySelectorAll THROWS on a selector it cannot parse — a CSS string
  // cannot contain a raw newline — so verification has to treat a throw as
  // "did not verify" rather than letting it escape and fail the whole walk.
  it('treats a selector that will not parse as unverified, not as an error', async () => {
    await page.setContent(`<body><div id="row"><button aria-label="Save\nand close">Save</button></div></body>`);

    const badCandidate = 'button[aria-label="Save\nand close"]';
    const parseThrows = await page.evaluate(`(() => {
      try { document.querySelectorAll(${JSON.stringify(badCandidate)}); return false; }
      catch (e) { return true; }
    })()`);
    expect(parseThrows).toBe(true); // the premise: this candidate is unusable

    const result = await findInDom(page, 'Save');

    // The browser-side catch-all would surface as a single tag:'error' match.
    expect(result.matches.map((m) => m.tag)).not.toContain('error');
    expect(result.matches[0]!.selector).toBe('#row > button:nth-of-type(1)');
    expect(await resolve(result.matches[0]!.selector)).toEqual({ count: 1, text: 'Save' });
  });
});

/** The parent prefixes the omission markers tell the AI to build nth-of-type
 *  selectors from — the "target directly with X > li:nth-of-type(N)" hint. */
function hintParents(snapshot: string): string[] {
  return Array.from(
    snapshot.matchAll(/target directly with (.+?) > [a-z]+:nth-of-type\(N\)/g),
  ).map((m) => m[1]!);
}

function hintParent(snapshot: string): string | undefined {
  return hintParents(snapshot)[0];
}

describe('buildSelector — the omission marker names a parent that resolves', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `<li>Item ${i + 1}</li>`).join('');

  it('uses the id when it is unique', async () => {
    await page.setContent(`<body><ul id="list">${rows(60)}</ul></body>`);

    const snapshot = await captureDomSnapshot(page, { collapseRepetitiveDom: true });

    expect(snapshot).toContain('elements omitted');
    expect(hintParent(snapshot)).toBe('#list');
    expect(await resolve('#list > li:nth-of-type(30)')).toEqual({ count: 1, text: 'Item 30' });
  });

  // A duplicated id made the hint an instruction that could not work: both
  // lists were named "#list", so the AI was told to target
  // "#list > li:nth-of-type(30)" — which matches one row in each list.
  it('falls through a duplicated id to a positional path', async () => {
    const others = Array.from({ length: 60 }, (_, i) => `<li>Other ${i + 1}</li>`).join('');
    await page.setContent(`<body><ul id="list">${others}</ul><ul id="list">${rows(60)}</ul></body>`);

    const snapshot = await captureDomSnapshot(page, { collapseRepetitiveDom: true });
    const parents = hintParents(snapshot);

    expect((await resolve('#list > li:nth-of-type(30)')).count).toBe(2); // the old hint
    expect(parents).toEqual(['body>ul:nth-of-type(1)', 'body>ul:nth-of-type(2)']);
    expect(await resolve(`${parents[0]} > li:nth-of-type(30)`)).toEqual({ count: 1, text: 'Other 30' });
    expect(await resolve(`${parents[1]} > li:nth-of-type(30)`)).toEqual({ count: 1, text: 'Item 30' });
  });

  // The old last resort was a bare tag, so an unaddressable parent produced
  // "div > li:nth-of-type(N)" — one match per div on the page.
  it('never falls back to a bare tag', async () => {
    await page.setContent(`<body><div><div><ul>${rows(60)}</ul></div></div></body>`);

    const snapshot = await captureDomSnapshot(page, { collapseRepetitiveDom: true });
    const parent = hintParent(snapshot);

    expect(parent).toBe('body>div:nth-of-type(1)>div:nth-of-type(1)>ul:nth-of-type(1)');
    expect(await resolve(`${parent} > li:nth-of-type(30)`)).toEqual({ count: 1, text: 'Item 30' });
  });
});

describe('buildSelector — iframe frame paths', () => {
  /** Every `<iframe ...> <!-- selector -->` comment in the snapshot. */
  function frameComments(snapshot: string): string[] {
    return Array.from(snapshot.matchAll(/<iframe[^>]*>\s*<!--\s*(.+?)\s*-->/g)).map((m) => m[1]!);
  }

  it('keeps a unique src', async () => {
    await page.setContent(`<body><iframe src="about:blank"></iframe></body>`);

    const snapshot = await captureDomSnapshot(page);

    expect(frameComments(snapshot)).toEqual(['iframe[src="about:blank"]']);
  });

  // Two frames of the same src are one page's worth of ads or one widget
  // embedded twice. `iframe[src="…"]` addressed both, so the AI's `frame`
  // field pointed at two frames and Playwright's strict mode refused it.
  it('separates two frames sharing a src, with no whitespace in the path', async () => {
    await page.setContent(`
      <body><iframe src="about:blank"></iframe><iframe src="about:blank"></iframe></body>`);

    const snapshot = await captureDomSnapshot(page);
    const comments = frameComments(snapshot);

    expect(comments).toEqual(['body>iframe:nth-of-type(1)', 'body>iframe:nth-of-type(2)']);
    for (const c of comments) {
      // resolveLocatorRoot (src/browser/actions.ts) splits a frame selector on
      // whitespace when it carries no " >> " chain, so a spaced chain would be
      // torn into three broken frameLocator segments.
      expect(c).not.toMatch(/\s/);
      expect((await resolve(c)).count).toBe(1);
    }
  });
});

// Verification costs a querySelectorAll, so where buildSelector is called
// matters as much as what it does. The collapse call site used to be computed
// eagerly for every parent with children — i.e. per element — which would have
// made this O(n^2) on a large page.
describe('buildSelector — not on the per-element path', () => {
  async function countQsaDuringCapture(html: string): Promise<number> {
    const p = await browser.newPage();
    try {
      await p.setContent(html);
      await p.evaluate(`(() => {
        window.__qsa = 0;
        const orig = Document.prototype.querySelectorAll;
        Document.prototype.querySelectorAll = function () {
          window.__qsa++;
          return orig.apply(this, arguments);
        };
      })()`);
      await captureDomSnapshot(p, { collapseRepetitiveDom: true });
      return await p.evaluate('window.__qsa') as number;
    } finally {
      await p.close();
    }
  }

  it('verifies nothing on a page with no collapsed run and no iframe', async () => {
    const deep = Array.from({ length: 200 }, (_, i) => `<div id="d${i}"><p>row ${i}</p></div>`).join('');

    expect(await countQsaDuringCapture(`<body>${deep}</body>`)).toBe(0);
  });

  it('verifies once for the parent of a collapsed run', async () => {
    const items = Array.from({ length: 60 }, (_, i) => `<li>Item ${i + 1}</li>`).join('');
    const count = await countQsaDuringCapture(`<body><ul id="list">${items}</ul></body>`);

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });
});
