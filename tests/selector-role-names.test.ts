/**
 * Rule 3's selector advice, checked against what Playwright actually matches
 * (issues/062-selector-rules-steer-the-model-into-selectors-that-match-nothing.md).
 *
 * The old rule recommended two forms that match nothing on ordinary markup:
 * `tag:text-is("label")` when the label sits in a child element, and the CSS
 * `[role="button"][name="..."]`, which looks for an HTML `name` attribute. On
 * 2026-09-28 every one of 19 failed actions across 17 runs on www.super.test
 * used one of them. The rule now recommends Playwright's `role=` form.
 *
 * Asserted on a real Playwright page, because what is being pinned is
 * Playwright's own matching; a mock would only restate this file's beliefs.
 * The markup is copied from the DOM snapshots the model received on that site.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction, sanitizeCssSelector } from '../src/browser/actions.js';
import { expandDomSubtree } from '../src/browser/dom-cleaner.js';
import { buildSystemPrompt, contentBlocksToText } from '../src/ai/prompts.js';

const PAGE = `<!doctype html><html><body>
<nav id="site-nav">
  <a href="/new" onclick="event.preventDefault(); document.body.dataset.clicked = 'new'">New</a>
  <a role="button" onclick="document.body.dataset.clicked = 'join'">
    <span>
      Join
    </span>
    <i aria-hidden="true"></i>
  </a>
</nav>
<button onclick="document.body.dataset.clicked = 'continue'">Continue</button>
<a role="button" style="text-transform: uppercase" onclick="document.body.dataset.clicked = 'apply'"><span>Apply</span></a>
<div role="dialog"><button onclick="document.body.dataset.clicked = 'cancel'">Cancel</button></div>
<ul role="listbox" aria-label="Title">
  <li role="option" aria-labelledby="mr-label" onclick="document.body.dataset.clicked = 'mr'">
    <span id="mr-label"><div><span>
      Mr
    </span></div></span>
  </li>
  <li role="option" aria-labelledby="mrs-label" onclick="document.body.dataset.clicked = 'mrs'">
    <span id="mrs-label"><div><span>Mrs</span></div></span>
  </li>
</ul>
</body></html>`;

describe('what Playwright matches (issue 062)', () => {
  let browser: Browser;
  let page: Page;
  const count = (selector: string) => page.locator(selector).count();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(PAGE);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('`:text-is` on the element matches nothing when its label sits in a child element', async () => {
    // The trap itself: `:text-is` skips an element whose child also matches,
    // so the match moves onto the innermost <span>.
    expect(await count('a[role="button"]:text-is("Join")')).toBe(0);
    expect(await count('[role="option"]:text-is("Mr")')).toBe(0);
    expect(await count('span:text-is("Mr")')).toBe(1);
  });

  it('`[role][name]` is CSS: it wants a name attribute, so it matches nothing', async () => {
    expect(await count('[role="button"][name="Join"]')).toBe(0);
  });

  it('`role=` matches the name a screen reader announces, however deep the text is', async () => {
    expect(await count('role=button[name="Join"]')).toBe(1);
    expect(await count('role=option[name="Mr"]')).toBe(1);
    // The whole name, so "Mr" is not a prefix match for "Mrs".
    const picked = await page.locator('role=option[name="Mr"]').innerText();
    expect(picked.trim()).toBe('Mr');
  });

  it('`role=` also matches text that sits directly inside, so nothing that worked stops working', async () => {
    expect(await count('button:text-is("Continue")')).toBe(1);
    expect(await count('role=button[name="Continue"]')).toBe(1);
  });

  it('whitespace is ignored on both sides, capitalisation is not', async () => {
    expect(await count('role=button[name=" Join "]')).toBe(1);
    expect(await count('role=button[name="join"]')).toBe(0);
  });

  it('the name is the page text, not the capitals CSS draws', async () => {
    // Why the rule says to copy the name from the snapshot, not the screenshot.
    expect(await page.locator('role=button[name="Apply"]').innerText()).toBe('APPLY');
    expect(await count('role=button[name="Apply"]')).toBe(1);
    expect(await count('role=button[name="APPLY"]')).toBe(0);
  });

  it('`:has(:text-is())` is not a general answer: it misses text that sits directly inside', async () => {
    expect(await count('a:has(:text-is("New"))')).toBe(0);
    expect(await count('nav >> role=link[name="New"]')).toBe(1);
  });

  it('scoping needs " >> ": with a plain space Playwright rejects the selector at once', async () => {
    await expect(count('nav role=link[name="New"]')).rejects.toThrow(/while parsing css selector/);
  });
});

describe('the role form through the framework', () => {
  let browser: Browser;
  let page: Page;
  const clicked = () => page.evaluate(() => document.body.dataset['clicked'] ?? '');

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    ['role=button[name="Join"]', 'join'],
    ['role=option[name="Mr"]', 'mr'],
    ['[role="dialog"] >> role=button[name="Cancel"]', 'cancel'],
    ['#site-nav >> role=link[name="New"]', 'new'],
  ])('executeAction clicks %s', async (selector, expected) => {
    await page.setContent(PAGE);
    const result = await executeAction(page, {
      action: 'click',
      selector,
      description: `Click ${expected}`,
    });
    expect(result.success, result.error).toBe(true);
    expect(await clicked()).toBe(expected);
  });

  it('the selector sanitiser passes role selectors through unchanged', () => {
    for (const selector of [
      'role=button[name="Join"]',
      'nav >> role=link[name="New"]',
      '[role="dialog"] >> role=button[name="Cancel"]',
      'role=link[name="super.test"]',
      'role=option[name="Mr."]',
    ]) {
      expect(sanitizeCssSelector(selector)).toBe(selector);
    }
  });

  it('expand runs the selector in the page, so it needs plain CSS, as rule 3 says', async () => {
    // Pins the exception the rule names. If expand learns Playwright
    // selectors, this fails, and the rule's exception list should shrink.
    await page.setContent(PAGE);
    expect(await expandDomSubtree(page, 'role=button[name="Join"]')).toMatch(/^\[expand\] Error/);
    expect(await expandDomSubtree(page, 'ul[role="listbox"]')).toContain('Mrs');
  });
});

describe('rule 3 in the system prompt', () => {
  const text = contentBlocksToText(buildSystemPrompt(''));

  it('recommends the role form for buttons, links, options and dialogs', () => {
    expect(text).toContain('Button → role=button[name="Sign in"]');
    expect(text).toContain('nav >> role=link[name="New"]');
    expect(text).toContain('role=option[name="Mr"]');
    expect(text).toContain('[role="dialog"] >> role=button[name="Cancel"]');
  });

  it('names the CSS look-alike only to warn against it', () => {
    expect(text).not.toMatch(/accessible role \+ name/);
    expect(text).not.toContain('[role="button"][name="Sign in"]');
    expect(text.split('[role="button"][name="..."]').length - 1).toBe(1);
    expect(text).toContain('[role="button"][name="..."] is plain CSS');
  });

  it('limits :text-is to text that sits directly inside, and says where the name comes from', () => {
    expect(text).not.toContain('button:text-is("Sign in")');
    expect(text).toContain('a:text-is("Join") does NOT match <a><span>Join</span></a>');
    expect(text).toContain('copy it from the DOM snapshot, not the screenshot');
  });
});
