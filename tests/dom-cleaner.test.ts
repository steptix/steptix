import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  captureDomSnapshot,
  expandDomSubtree,
} from '../src/browser/dom-cleaner.js';

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
  }, 60_000);

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

  it('keeps data-steptix-row in the whole-page snapshot, where nothing else data-* survives', async () => {
    // The numbering `readTable` leaves on the rows it read
    // (SPEC-structured-table-reads §7.4) is the framework's own answer to
    // "row 7 of the Orders table". The snapshot's allowlist drops every other
    // `data-*` as noise, so this attribute is only there because it is named
    // in ALLOWED_DOM_ATTRIBUTES — taken out of that list, the model sees no
    // numbering at all and goes back to counting rows or, measured on
    // RadGrid, building an id from the number and acting on the row below.
    //
    // Written here rather than run through `readTable`, so the assertion is
    // about the snapshot and not about the read.
    await page.setContent(
      `<body><table id="t"><tbody>`
      + `<tr data-steptix-row="1" data-row-key="ORD-1001"><td><button>Review</button></td></tr>`
      + `<tr data-steptix-row="2" data-row-key="ORD-1002"><td><button>Review</button></td></tr>`
      + `</tbody></table></body>`,
    );

    const snapshot = await captureDomSnapshot(page);
    expect(snapshot).toContain('data-steptix-row="1"');
    expect(snapshot).toContain('data-steptix-row="2"');
    // The rest of the `data-*` family is still dropped, which is what makes
    // the line above a decision rather than an accident.
    expect(snapshot).not.toContain('data-row-key');
  }, 30_000);

  it('drops an <input type="hidden"> from the snapshot, value and all', async () => {
    // A hidden input is page state — a CSRF token, a view-state blob — not a
    // target, so the snapshot keeps a bare placeholder that says why and none
    // of its attributes. Asked of the snapshot the model reads, not of a
    // string helper that only looked like it.
    await page.setContent(
      '<body><form id="f">'
      + '<input type="hidden" name="csrf" value="tok-NOT-IN-SNAPSHOT">'
      + '<input type="text" name="user">'
      + '</form></body>',
    );

    const snapshot = await captureDomSnapshot(page);
    expect(snapshot).not.toContain('csrf');
    expect(snapshot).not.toContain('tok-NOT-IN-SNAPSHOT');
    expect(snapshot).toContain('<!-- hidden: input[type=hidden] -->');
    // The visible field beside it is untouched.
    expect(snapshot).toContain('name="user"');
  }, 30_000);

  it('emits data-steptix-row exactly ONCE in the expand walk', async () => {
    // `expand` prints the named allowlist AND then sweeps every `data-*`, so
    // an attribute in both lists comes out twice:
    // `data-steptix-row="8" data-steptix-row="8"`. The sweep skips this one (and
    // `data-testid`) for that reason; drop the skip and the row a read had
    // numbered prints its number twice on one line.
    await page.setContent(
      `<body><div id="wrap"><table><tbody>`
      + `<tr data-steptix-row="8" data-state="expanded"><td><button id="b">Review</button></td></tr>`
      + `</tbody></table></div></body>`,
    );

    const expanded = await expandDomSubtree(page, '#wrap');
    expect(expanded).toContain('data-steptix-row="8"');
    expect(expanded.match(/data-steptix-row="8"/g)).toHaveLength(1);
    // The sweep itself is still running on this element — otherwise the
    // assertion above would pass for the wrong reason.
    expect(expanded).toContain('data-state="expanded"');
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
