import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  captureDomSnapshot,
  cleanHtmlString,
  expandDomSubtree,
} from '../src/browser/dom-cleaner.js';

describe('cleanHtmlString', () => {
  it('extracts button elements', () => {
    const html = `<div><button type="submit">Sign In</button></div>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<button');
    expect(result).toContain('Sign In');
  });

  it('extracts input elements', () => {
    const html = `<form><input type="email" name="email" placeholder="you@example.com"></form>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<input');
    expect(result).toContain('type="email"');
  });

  it('extracts anchor elements', () => {
    const html = `<nav><a href="/dashboard">Dashboard</a></nav>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<a');
    expect(result).toContain('Dashboard');
  });

  it('extracts select elements', () => {
    const html = `<select name="month"><option value="1">January</option></select>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<select');
  });

  it('extracts textarea elements', () => {
    const html = `<textarea name="notes" placeholder="Enter notes"></textarea>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<textarea');
  });

  it('skips inputs with type="hidden"', () => {
    const html = `<input type="hidden" name="csrf" value="abc123"><input type="text" name="user">`;
    const result = cleanHtmlString(html);
    expect(result).not.toContain('name="csrf"');
    expect(result).toContain('name="user"');
  });

  it('skips elements with display:none', () => {
    const html = `<button style="display:none">Hidden</button><button>Visible</button>`;
    const result = cleanHtmlString(html);
    expect(result).not.toContain('Hidden');
    expect(result).toContain('Visible');
  });

  it('skips elements with visibility:hidden', () => {
    const html = `<button style="visibility:hidden">Invisible</button><button>OK</button>`;
    const result = cleanHtmlString(html);
    expect(result).not.toContain('Invisible');
    expect(result).toContain('OK');
  });

  it('returns empty string for html with no interactive elements', () => {
    const html = `<div><p>Just a paragraph</p><span>Some text</span></div>`;
    const result = cleanHtmlString(html);
    expect(result).toBe('');
  });

  it('extracts form elements', () => {
    const html = `<form id="login-form" action="/login" method="post"><input type="text"></form>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<form');
  });

  it('extracts label elements', () => {
    const html = `<label for="email">Email address</label><input type="email" id="email">`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<label');
    expect(result).toContain('Email address');
  });

  it('handles multiple elements on separate lines', () => {
    const html = `
      <form>
        <input type="email" name="email">
        <input type="password" name="password">
        <button type="submit">Sign In</button>
      </form>
    `;
    const result = cleanHtmlString(html);
    const lines = result.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('normalises whitespace in extracted elements', () => {
    const html = `<button   type="submit"   class="btn">   Sign   In   </button>`;
    const result = cleanHtmlString(html);
    // Each extracted element should be a single cleaned line
    expect(result).not.toMatch(/\s{2,}/);
  });
});

/**
 * The `expand` walk against a real Chromium, for the one property a string
 * test cannot show: the gap between an attribute and the live IDL property.
 *
 * `expand` and the whole-page snapshot are two capture tools a single run
 * uses one turn apart. While this walk read `value` from the attribute map
 * and the snapshot read it from the element, they answered differently about
 * the same field on the same page (review 3, finding 5).
 */
describe('expandDomSubtree — live value, real browser', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* noop */ }
  }, 15_000);

  it('agrees with the snapshot about a field a step typed into', async () => {
    await page.setContent(
      `<body><div id="wrap">` +
        `<input type="text" id="email" name="email" value="preset@old.test">` +
        `</div></body>`,
    );
    await page.fill('#email', 'ada@new.test');

    const expanded = await expandDomSubtree(page, '#wrap');
    const snapshot = await captureDomSnapshot(page);

    expect(expanded).toContain('value="ada@new.test"');
    expect(expanded).not.toContain('preset@old.test');
    // The point of the fix: one answer, not two.
    expect(snapshot).toContain('value="ada@new.test"');
  }, 30_000);

  it('never prints a typed password, toggled to type=text or not', async () => {
    await page.setContent(
      `<body><div id="wrap">` +
        `<input type="password" id="pw" name="password">` +
        `<input type="text" id="tok" name="api-token">` +
        `<input type="text" id="q" aria-label="Search">` +
        `<button id="show" onclick="document.getElementById('pw').type='text'">Show</button>` +
        `</div></body>`,
    );
    await page.fill('#pw', 'hunter2-NOT-IN-EXPAND');
    await page.fill('#tok', 'tok-NOT-IN-EXPAND');
    await page.fill('#q', 'unpaid');

    expect(await expandDomSubtree(page, '#wrap')).not.toContain('hunter2');
    await page.click('#show');

    const expanded = await expandDomSubtree(page, '#wrap');
    expect(expanded).not.toContain('hunter2');
    expect(expanded).not.toContain('tok-NOT-IN-EXPAND');
    // An ordinary field still reports what it holds.
    expect(expanded).toContain('value="unpaid"');
  }, 30_000);

  it('masks a secret field`s value the way the snapshot does, `pwd` included', async () => {
    // Both halves of review 4's findings 1 and 2, checked on the OTHER copy of
    // the rule: `name="pwd"` is a password field, and a field the run filled
    // says so with `***` rather than by dropping the attribute.
    await page.setContent(
      `<body><div id="wrap">` +
        `<input type="password" id="pwd" name="pwd">` +
        `<input type="text" id="cred" name="credential">` +
        `<button id="show" onclick="document.getElementById('pwd').type='text'">Show</button>` +
        `</div></body>`,
    );
    await page.fill('#pwd', 'AAA-pwd-secret');
    await page.fill('#cred', 'BBB-cred-secret');
    await page.click('#show');

    const expanded = await expandDomSubtree(page, '#wrap');
    const snapshot = await captureDomSnapshot(page);

    for (const text of [expanded, snapshot]) {
      expect(text).not.toContain('AAA-pwd-secret');
      expect(text).not.toContain('BBB-cred-secret');
      expect(text).toContain('value="***"');
    }
  }, 30_000);

  it('leaves an untouched textarea`s text to the line that already prints it', async () => {
    // The snapshot speaks up only once the live text has diverged from
    // `defaultValue`, because a textarea's default value IS its child text and
    // both tools print that on the next line. This walk said `value="hello
    // there"` for every untouched textarea on the page, so the two disagreed
    // about a field nobody had touched (review 4, finding 12).
    await page.setContent(
      '<body><div id="wrap"><textarea id="ta" name="notes">hello there</textarea></div></body>',
    );

    const untouched = await expandDomSubtree(page, '#wrap');
    expect(untouched).not.toContain('value="hello there"');
    // The text itself is still there — this is about the attribute only.
    expect(untouched).toContain('hello there');
    expect(await captureDomSnapshot(page)).not.toContain('value="hello there"');

    // ...and once a step types into it, both tools report the new text.
    await page.fill('#ta', 'ada was here');
    const typed = await expandDomSubtree(page, '#wrap');
    expect(typed).toContain('value="ada was here"');
    expect(await captureDomSnapshot(page)).toContain('value="ada was here"');
  }, 30_000);

  it('drops a stale `value` when script empties the field, and says so the same way', async () => {
    // The second carve-out: a blank control whose markup carried no `value`
    // has nothing to say, and the markup's own `value` is not the live one.
    // A field that HAS a `value` attribute is the other case, and it is where
    // the two tools disagreed last: the snapshot printed `value=""` — the run
    // emptied this box — and this walk printed nothing, because its
    // empty-attribute skip swallowed the live reading before the rule was
    // consulted (review 5, finding 5).
    await page.setContent(
      '<body><div id="wrap"><input type="text" id="v6" name="v6" value="preset"></div></body>',
    );
    await page.evaluate(() => {
      (document.getElementById('v6') as HTMLInputElement).value = '';
    });

    const expanded = await expandDomSubtree(page, '#wrap');
    const snapshot = await captureDomSnapshot(page);
    expect(expanded).toContain('id="v6"');
    // Never the markup's stale value, on either tool...
    expect(expanded).not.toContain('preset');
    expect(snapshot).not.toContain('preset');
    // ...and both now say the same thing about what is there instead.
    expect(expanded).toContain('value=""');
    expect(snapshot).toContain('value=""');

    // The carve-out itself, unchanged: no `value` attribute in the markup and
    // nothing typed means neither tool invents one.
    await page.setContent(
      '<body><div id="wrap2"><input type="text" id="v7" name="v7"></div></body>',
    );
    expect(await expandDomSubtree(page, '#wrap2')).not.toContain('value=');
    expect(await captureDomSnapshot(page)).not.toContain('value=');
  }, 30_000);

  it('judges a placeholder by the PASSWORD rule only, on this copy too', async () => {
    // The `expand` half of review 5's finding 1 and finding 2: a placeholder
    // is prose, so the name rule's bare `key` never reads it, while the
    // password rule does — and `pass` inside `passenger` is not a password.
    await page.setContent(
      `<body><div id="wrap">` +
        `<input type="password" id="ph" placeholder="Password">` +
        `<input type="search" id="s" name="q" placeholder="Search by keyword">` +
        `<input type="text" id="pg" name="passenger1_name">` +
        `<input type="text" id="pc" name="pin_code">` +
        `<input type="text" id="sh" name="shipping_address">` +
        `<button id="show" onclick="document.getElementById('ph').type='text'">Show</button>` +
        `</div></body>`,
    );
    await page.fill('#ph', 'PH-secret-A');
    await page.fill('#s', 'unpaid');
    await page.fill('#pg', 'Ada Lovelace');
    // `pin` is a whole-token match on this copy too (review 7, finding 1):
    // `pin_code` masks, `shipping_address` does not.
    await page.fill('#pc', 'PIN-secret-B');
    await page.fill('#sh', '1 Loop Lane');
    await page.click('#show');

    const expanded = await expandDomSubtree(page, '#wrap');
    const snapshot = await captureDomSnapshot(page);

    for (const text of [expanded, snapshot]) {
      expect(text).not.toContain('PH-secret-A');
      expect(text).not.toContain('PIN-secret-B');
      expect(text).toContain('value="***"');
      // Row-specific: the `#pc` line itself must carry the mask, so this
      // cannot stay green on `#ph`'s mask alone if `#pc` dropped out.
      expect(text).toMatch(/id="pc"[^\n]*value="\*\*\*"/);
      expect(text).toContain('value="unpaid"');
      expect(text).toContain('value="Ada Lovelace"');
      expect(text).toContain('value="1 Loop Lane"');
    }
  }, 30_000);

  it('will not hand a masked value back through a data-* attribute', async () => {
    // This walk is the zoomed-in tool and prints every `data-*`, so a page
    // that mirrors its input into an attribute undid the mask on the very
    // line that applied it (review 5, finding 4). The hook's NAME still
    // prints — the model can see it exists — and the whole-page snapshot
    // emits no `data-*` at all, so this moves the two tools closer.
    // Every `data-*` on the field goes, not just one that happens to equal
    // the live value: the leak measured in review 5 held `hunter2-in-data`
    // while the box held `hunter2-typed`, so equality would have missed it.
    // The cost is a state hook on a password field, which the snapshot never
    // showed anyway; `data-testid` is not in this sweep and still targets.
    await page.setContent(
      `<body><div id="wrap">` +
        `<input type="password" id="d1" name="password" data-value="hunter2-in-data" data-state="dirty">` +
        `<input type="text" id="d2" name="city" data-value="Cambridge">` +
        `</div></body>`,
    );
    await page.fill('#d1', 'hunter2-typed');

    const expanded = await expandDomSubtree(page, '#wrap');
    expect(expanded).not.toContain('hunter2-in-data');
    expect(expanded).not.toContain('hunter2-typed');
    expect(expanded).toContain('data-value="***"');
    expect(expanded).toContain('data-state="***"');
    // An ordinary field's hooks are untouched.
    expect(expanded).toContain('data-value="Cambridge"');
  }, 30_000);

  it('keeps a typed textarea on one line', async () => {
    // Every element in this output is one line, so a live value that carries
    // newlines has to be collapsed — the same rule the snapshot applies.
    await page.setContent(
      '<body><div id="wrap"><textarea id="notes" name="notes"></textarea></div></body>',
    );
    await page.fill('#notes', 'line one\nline two');

    const expanded = await expandDomSubtree(page, '#wrap');
    expect(expanded).toContain('value="line one line two"');
  }, 30_000);

  it('leaves `checked` where it always was — absent', async () => {
    // Not a live reading here, deliberately: the walk skips every empty-valued
    // attribute, so `checked` has never appeared in `expand` output at all and
    // making it live would be choosing a new shape rather than fixing a
    // staleness. Pinned so the difference from the snapshot stays a decision.
    await page.setContent(
      '<body><div id="wrap"><input type="checkbox" id="cb" name="cb" checked></div></body>',
    );
    await page.click('#cb');

    const expanded = await expandDomSubtree(page, '#wrap');
    expect(expanded).toContain('id="cb"');
    expect(expanded).not.toContain('checked');
  }, 30_000);
});
