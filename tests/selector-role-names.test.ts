/**
 * Rule 3's selector advice, checked against what Playwright actually matches
 * (issues/062-selector-rules-steer-the-model-into-selectors-that-match-nothing.md).
 *
 * The old rule recommended two forms that match nothing on ordinary markup:
 * `tag:text-is("label")` when the label sits in a child element, and the CSS
 * `[role="button"][name="..."]`, which looks for an HTML `name` attribute. On
 * 2026-09-28 every one of 19 failed actions across 17 runs on www.super.test
 * used one of them. The rule now recommends Playwright's `role=` form, and
 * every path that takes a model-written selector resolves it through
 * Playwright, so the form works everywhere a selector goes.
 *
 * Asserted on a real Playwright page, because what is being pinned is
 * Playwright's own matching; a mock would only restate this file's beliefs.
 * The markup is copied from the DOM snapshots the model received on that site.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction, executeWait, sanitizeCssSelector } from '../src/browser/actions.js';
import { expandDomSubtree, findInDom } from '../src/browser/dom-cleaner.js';
import { buildSystemPrompt, buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';

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

/** The cases rule 3 now names as limits: where the name is not the text the snapshot shows. */
const LIMITS = `<!doctype html><html><head><style>.next::after { content: " \\2192"; }</style></head><body>
<a href="/join" aria-label="Join Example super today">Join</a>
<span id="lbl">Apply for super</span>
<button aria-labelledby="lbl" aria-label="Apply now">Apply</button>
<button class="next">Next</button>
<button><span>Save</span><span style="margin-left: 6px">draft</span></button>
<a onclick="void 0">Help</a>
<input type="button" value="Print">
<button>Say "hi"</button>
</body></html>`;

describe('what Playwright matches (issue 062)', () => {
  let browser: Browser;
  let page: Page;
  const count = (selector: string) => page.locator(selector).count();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe('on the markup from the failing runs', () => {
    beforeAll(async () => {
      await page.setContent(PAGE);
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

    it('whitespace around the name is ignored on both sides, capitalisation is not', async () => {
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

  describe('where the name is not the text the snapshot shows (the limits rule 3 names)', () => {
    beforeAll(async () => {
      await page.setContent(LIMITS);
    });

    it('aria-labelledby, else aria-label, REPLACES the text', async () => {
      expect(await count('role=link[name="Join"]')).toBe(0);
      expect(await count('role=link[name="Join Example super today"]')).toBe(1);
      expect(await count('role=button[name="Apply"]')).toBe(0);
      expect(await count('role=button[name="Apply now"]')).toBe(0);
      expect(await count('role=button[name="Apply for super"]')).toBe(1);
    });

    it('CSS-drawn content joins the name, so the fallback (:has-text) is needed', async () => {
      expect(await count('role=button[name="Next"]')).toBe(0);
      expect(await count('button:has-text("Next")')).toBe(1);
    });

    it('words in separate inline elements run together in the name', async () => {
      expect(await count('role=button[name="Save draft"]')).toBe(0);
      expect(await count('role=button[name="Savedraft"]')).toBe(1);
    });

    it('an <a> without href has no role; an <input type="button"> is a button', async () => {
      expect(await count('role=link[name="Help"]')).toBe(0);
      expect(await count('a:text-is("Help")')).toBe(1);
      expect(await count('role=button[name="Print"]')).toBe(1);
    });

    it('a name containing a double quote goes in single quotes', async () => {
      expect(await count(`role=button[name='Say "hi"']`)).toBe(1);
    });
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

  it('the selector sanitiser leaves role selectors matching what they matched', async () => {
    // It may add a backslash before a ":" inside a quoted name; Playwright
    // drops it again, so what matters is the match, not the string.
    await page.setContent(`<a href="/a">super.test:8080</a><a href="/b">Invoice #12: Paid</a>`);
    for (const selector of ['role=link[name="super.test:8080"]', 'role=link[name="Invoice #12: Paid"]']) {
      expect(await page.locator(sanitizeCssSelector(selector)).count()).toBe(1);
    }
    for (const selector of ['role=button[name="Join"]', 'nav >> role=link[name="New"]', 'role=option[name="Mr."]']) {
      expect(sanitizeCssSelector(selector)).toBe(selector);
    }
  });

  it('expand accepts the role form, prints the element, and leaves no stamp behind', async () => {
    await page.setContent(PAGE);
    const subtree = await expandDomSubtree(page, 'role=listbox[name="Title"]');
    expect(subtree).toContain('Mrs');
    expect(subtree).not.toContain('data-aiui-target');
    expect(await page.locator('[data-aiui-target]').count()).toBe(0);
    // Misses and bad selectors still answer in band, naming what was asked for.
    expect(await expandDomSubtree(page, 'role=listbox[name="Nope"]'))
      .toBe('[expand] No element found for selector: role=listbox[name="Nope"]');
    expect(await expandDomSubtree(page, 'nav role=link[name="New"]')).toMatch(/^\[expand\] Error: /);
  });

  it("find's scope accepts the role form, and leaves no stamp behind", async () => {
    await page.setContent(PAGE);
    const found = await findInDom(page, 'Mr', 'role=listbox[name="Title"]');
    expect(found.containerError).toBeUndefined();
    expect(found.matches.map((m) => m.text.trim()).sort()).toEqual(['Mr', 'Mrs']);
    expect(await page.locator('[data-aiui-target]').count()).toBe(0);
    const missing = await findInDom(page, 'Mr', 'role=listbox[name="Nope"]');
    expect(missing.containerError).toBe('No element matches container selector: role=listbox[name="Nope"]');
  });
});

describe('iframes and waits take the role form too', () => {
  let browser: Browser;
  let page: Page;
  const FRAMES: Record<string, string> = {
    '/frames': '<iframe id="pay-frame" src="/pay"></iframe><iframe id="outer" src="/outer"></iframe>',
    '/pay': `<button onclick="document.body.dataset.clicked = 'pay'">Pay now</button>`,
    '/outer': '<iframe id="inner" src="/inner"></iframe>',
    '/inner': `<button onclick="document.body.dataset.clicked = 'deep'">Deep</button>`,
  };

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    // Routed rather than served: the frames load by URL, and nothing here
    // needs a server beyond the bodies below.
    await page.route('**/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: FRAMES[new URL(route.request().url()).pathname] ?? '',
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  const loadFrames = async () => {
    await page.goto('http://127.0.0.1:8787/frames');
    await page.frameLocator('#pay-frame').locator('button').waitFor();
    await page.frameLocator('#outer').frameLocator('#inner').locator('button').waitFor();
  };
  const payClicked = () => page.frameLocator('#pay-frame').locator('body').getAttribute('data-clicked');

  it.each([
    [undefined, '#pay-frame >> role=button[name="Pay now"]'],
    [undefined, '#pay-frame button'],
    ['#pay-frame', 'role=button[name="Pay now"]'],
  ])('clicks inside the iframe (frame=%s, selector=%s)', async (frame, selector) => {
    await loadFrames();
    const result = await executeAction(page, {
      action: 'click',
      selector,
      ...(frame !== undefined && { frame }),
      description: 'Click Pay now',
    });
    expect(result.success, result.error).toBe(true);
    expect(await payClicked()).toBe('pay');
  });

  it('clicks two iframes deep with a " >> " chain in the selector', async () => {
    await loadFrames();
    const result = await executeAction(page, {
      action: 'click',
      selector: '#outer >> #inner >> role=button[name="Deep"]',
      description: 'Click Deep',
    });
    expect(result.success, result.error).toBe(true);
    const deep = page.frameLocator('#outer').frameLocator('#inner').locator('body');
    expect(await deep.getAttribute('data-clicked')).toBe('deep');
  });

  const LATE = `<!doctype html><html><body>
<ul role="list" aria-label="Results"></ul>
<button disabled>Verify</button>
<script>
  setTimeout(() => {
    const list = document.querySelector('ul');
    list.innerHTML = '<li>One</li><li>Two</li>';
    document.querySelector('button').disabled = false;
    const late = document.createElement('button');
    late.textContent = 'Later';
    document.body.appendChild(late);
  }, 300);
</script>
</body></html>`;

  it.each([
    ['count, role form', { waitType: 'count' as const, condition: 'role=listitem', expected: '2' }],
    ['count, " >> " chain', { waitType: 'count' as const, condition: 'role=list[name="Results"] >> role=listitem', expected: '2' }],
    ['attribute, role form', { waitType: 'attribute' as const, selector: 'role=button[name="Verify"]', expected: '!disabled' }],
    ['no waitType, role form', { condition: 'role=button[name="Later"]' }],
  ])('waits until it holds: %s', async (_label, fields) => {
    await page.setContent(LATE);
    const started = Date.now();
    const result = await executeAction(page, {
      action: 'wait',
      timeout: 5_000,
      description: 'Wait',
      ...fields,
    });
    expect(result.success, result.error).toBe(true);
    // Well inside the budget: the wait ended when the page changed, it did
    // not run out its timeout as a text wait for the literal selector would.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('a count wait that never holds fails as a TimeoutError', async () => {
    await page.setContent(LATE);
    await expect(
      executeWait(page, page, {
        action: 'wait',
        waitType: 'count',
        condition: 'role=listitem',
        expected: '5',
        timeout: 700,
        description: 'Wait for five',
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
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
    expect(text).toContain('NOT the CSS look-alike [role="button"][name="..."]');
  });

  it('says where the name comes from, which elements have a role, and what to do when it misses', () => {
    expect(text).toContain('aria-labelledby text, else aria-label, else ALL the text inside');
    expect(text).toContain('An <a> without href or a clickable <div> has no role');
    expect(text).toContain('copied from the DOM snapshot, not the screenshot');
    expect(text).toContain('If it matches nothing');
  });

  it('limits :text-is to text that sits directly inside', () => {
    expect(text).not.toContain('button:text-is("Sign in")');
    expect(text).toContain('a:text-is("Join") misses <a><span>Join</span></a>');
  });

  it('no longer tells the model that waits, expand or find need plain CSS', () => {
    expect(text).not.toContain('keep selectors as pure CSS');
    expect(text).not.toContain('need plain CSS');
    expect(text).not.toContain('"selector" to a CSS selector');
    expect(text).not.toContain('"selector" to the CSS selector');
  });

  it('tells the code generator that a role selector is exact', () => {
    const code = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click Join',
        parameters: [],
        actions: [{ action: 'click', selector: 'role=button[name="Join"]', description: 'Click Join' }],
      }).content,
    );
    expect(code).toContain('exact: true');
  });
});
