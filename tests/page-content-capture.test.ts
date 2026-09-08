/**
 * W1 of stories/page-content.md — the capture helpers behind
 * `GET /sessions/:id/content`.
 *
 * Two halves:
 *  - `captureVisibleText` against a real Chromium, because the property under
 *    test (visible text, not markup text) is a browser behaviour. Asserting it
 *    against a stubbed `evaluate` would only prove we can spell `innerText`.
 *  - `domCaptureFailure` as pure string work — it exists to recognise the
 *    in-band failure strings the runner's capture paths return.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  captureDomSnapshot,
  captureVisibleText,
  domCaptureFailure,
  domSnapshotWasClipped,
  expandDomSubtree,
  PageCaptureError,
} from '../src/browser/dom-cleaner.js';
import { readPageIdentity } from '../src/server/page-capture.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
}, 15_000);

describe('captureVisibleText — real browser', () => {
  it('returns visible text', async () => {
    await page.setContent(`
      <body>
        <h1>Invoices</h1>
        <p>You have 3 unpaid invoices.</p>
      </body>`);

    const text = await captureVisibleText(page);

    expect(text).toContain('Invoices');
    expect(text).toContain('3 unpaid invoices');
  });

  // The regression guard named in the story: if anyone ever swaps innerText for
  // textContent, this is the test that fails. Both subtrees below are in the
  // DOM and both are invisible to a reader.
  it('omits display:none and hidden subtrees', async () => {
    await page.setContent(`
      <body>
        <p>Visible paragraph</p>
        <div style="display:none">SECRET-DISPLAY-NONE</div>
        <div hidden>SECRET-HIDDEN-ATTR</div>
      </body>`);

    const text = await captureVisibleText(page);

    expect(text).toContain('Visible paragraph');
    expect(text).not.toContain('SECRET-DISPLAY-NONE');
    expect(text).not.toContain('SECRET-HIDDEN-ATTR');
  });

  // Found in live testing, and deliberately NOT "fixed".
  //
  // `aria-hidden="true"` hides an element from assistive technology; it stays
  // on screen for everyone else. So `innerText` includes it, while
  // `captureDomSnapshot` drops it (hideAriaHiddenElements) as AI noise. The two
  // formats therefore disagree, and each is right for its own question: `text`
  // answers "what does a person see", `dom` answers "what should a model
  // reason about". Filtering it here would mean reimplementing innerText's
  // layout semantics by hand, and would make `text` lie about the screen.
  it('keeps aria-hidden text, which the DOM snapshot drops', async () => {
    await page.setContent(`
      <body>
        <p>Visible paragraph</p>
        <div aria-hidden="true">ARIA-HIDDEN-BUT-ON-SCREEN</div>
      </body>`);

    const text = await captureVisibleText(page);
    const dom = await captureDomSnapshot(page);

    expect(text).toContain('ARIA-HIDDEN-BUT-ON-SCREEN');
    expect(dom).not.toContain('ARIA-HIDDEN-BUT-ON-SCREEN');
  });

  // Regression: innerText's getter falls back to textContent when the element
  // "is not being rendered" (HTML spec). So reading a display:none element BY
  // SELECTOR used to hand back its hidden text, unspaced, labelled as visible
  // — while the whole-page read correctly omitted the same subtree. Found in
  // adversarial review; the observed leak was "SSN 123-45-6789nested".
  it('refuses a selector on a non-rendered element rather than leaking its text', async () => {
    await page.setContent(`<body>
      <p>Visible</p>
      <div id="secret" style="display:none">SSN 123-45-6789<span>nested</span></div>
      <div id="hid" hidden>HIDDEN-ATTR-TEXT</div>
      <div id="wrapper" style="display:none"><p id="child">CHILD-OF-HIDDEN</p></div>
    </body>`);

    await expect(captureVisibleText(page, { selector: '#secret' }))
      .rejects.toMatchObject({ kind: 'not-rendered' });
    await expect(captureVisibleText(page, { selector: '#hid' }))
      .rejects.toMatchObject({ kind: 'not-rendered' });
    // The ancestor case, which a self-only display check would miss.
    await expect(captureVisibleText(page, { selector: '#child' }))
      .rejects.toMatchObject({ kind: 'not-rendered' });
  });

  // visibility:hidden and opacity:0 still occupy layout and still render text;
  // only display-style non-rendering triggers innerText's fallback. Guards
  // against the not-rendered check being widened into a visibility check.
  it('still reads an element that is rendered but visually suppressed', async () => {
    await page.setContent(`<body>
      <div id="invis" style="visibility:hidden">INVISIBLE-BUT-RENDERED</div>
      <div id="clear" style="opacity:0">TRANSPARENT-BUT-RENDERED</div>
      <span id="empty"></span>
    </body>`);

    // innerText honours visibility:hidden by returning '' — but it is a real
    // read, not a fallback, so it must not raise.
    await expect(captureVisibleText(page, { selector: '#invis' })).resolves.toBe('');
    await expect(captureVisibleText(page, { selector: '#clear' })).resolves.toContain('TRANSPARENT');
    // An empty *inline* element has no client rects; a getClientRects-based
    // check would wrongly call this not-rendered.
    await expect(captureVisibleText(page, { selector: '#empty' })).resolves.toBe('');
  });

  // Regression on the fix above, found in round-2 review. A display:contents
  // element generates no box, so checkVisibility() reports false — but its
  // children render normally and innerText collects them correctly. Testing
  // the element itself turned a working read into a 400, and the idiom is
  // mainstream: transparent flex/grid wrappers, :host { display: contents }.
  it('reads through a display:contents wrapper', async () => {
    await page.setContent(`<body><div id="wrap" style="display:contents">
      <p>VISIBLE-ONE</p><div style="display:none">SECRET-HIDDEN</div><p>VISIBLE-TWO</p>
    </div></body>`);

    const text = await captureVisibleText(page, { selector: '#wrap' });

    expect(text).toContain('VISIBLE-ONE');
    expect(text).toContain('VISIBLE-TWO');
    // Still a real rendered read, not the textContent fallback.
    expect(text).not.toContain('SECRET-HIDDEN');
  });

  it('still refuses a display:contents element under a hidden parent', async () => {
    await page.setContent(`<body><div style="display:none">
      <div id="wrap" style="display:contents"><p>HIDDEN-VIA-ANCESTOR</p></div>
    </div></body>`);

    await expect(captureVisibleText(page, { selector: '#wrap' }))
      .rejects.toMatchObject({ kind: 'not-rendered' });
  });

  it('does not say "undefined" when the whole page is not rendered', async () => {
    await page.setContent('<body style="display:none"><p>hi</p></body>');

    const err = await captureVisibleText(page).catch((e: Error) => e);

    expect((err as Error).message).not.toContain('undefined');
    expect((err as Error).message).toContain('page body');
  });

  // SVG has textContent but no innerText. The caller's own selector chose it,
  // so it is a 400-class error, not a server fault — and falling back to
  // textContent would reintroduce the hidden-content leak.
  it('reports a non-HTML element as the caller\'s error, not a server fault', async () => {
    await page.setContent('<body><svg id="chart"><title>Sales</title></svg></body>');

    const err = await captureVisibleText(page, { selector: '#chart' }).catch((e: Error) => e);

    expect((err as PageCaptureError).kind).toBe('unreadable-element');
    expect((err as Error).message).toContain('format="dom"');
  });

  it('reports an invalid selector as bad-selector, not a server fault', async () => {
    await page.setContent('<body><p>hi</p></body>');

    await expect(captureVisibleText(page, { selector: 'div:has-text("Submit")' }))
      .rejects.toMatchObject({ kind: 'bad-selector' });
  });

  it('excludes script and style bodies', async () => {
    await page.setContent(`
      <body>
        <style>.x { color: SECRET-CSS }</style>
        <script>var s = "SECRET-JS";</script>
        <p>Real content</p>
      </body>`);

    const text = await captureVisibleText(page);

    expect(text).toContain('Real content');
    expect(text).not.toContain('SECRET-CSS');
    expect(text).not.toContain('SECRET-JS');
  });

  it('narrows to a selector', async () => {
    await page.setContent(`
      <body>
        <nav>Navigation noise</nav>
        <main id="content"><p>The part that matters</p></main>
      </body>`);

    const text = await captureVisibleText(page, { selector: '#content' });

    expect(text).toContain('The part that matters');
    expect(text).not.toContain('Navigation noise');
  });

  // "No element matched" and "the element is empty" must not collapse into the
  // same answer — a caller that cannot tell them apart reports the wrong one.
  it('raises selector-miss rather than returning empty', async () => {
    await page.setContent('<body><p>Something</p></body>');

    await expect(captureVisibleText(page, { selector: '#nope' }))
      .rejects.toMatchObject({ kind: 'selector-miss' });
  });

  it('returns empty string for a matched but empty element', async () => {
    await page.setContent('<body><div id="empty"></div></body>');

    await expect(captureVisibleText(page, { selector: '#empty' })).resolves.toBe('');
  });

  it('does not let a quote in the selector break the script', async () => {
    await page.setContent(`<body><div data-label='say "hi"'>Quoted</div></body>`);

    const text = await captureVisibleText(page, { selector: '[data-label="say \\"hi\\""]' });

    expect(text).toContain('Quoted');
  });

  it('reports a malformed selector as a capture failure, not as no content', async () => {
    await page.setContent('<body><p>Something</p></body>');

    const err = await captureVisibleText(page, { selector: ':::' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PageCaptureError);
    expect((err as PageCaptureError).kind).toBe('bad-selector');
  });
});

describe('expandDomSubtree — hidden elements', () => {
  // The two formats must not disagree about the same element: `text` raised
  // not-rendered while `dom` returned 200 with content: "", which is the
  // "empty vs unreadable" conflation this feature exists to remove — on the
  // format the tool description steers agents to for selector work.
  it('reports a not-rendered element rather than returning empty content', async () => {
    await page.setContent('<body><div id="h" style="display:none">SSN 123-45-6789</div></body>');

    const expanded = await expandDomSubtree(page, '#h');

    expect(domCaptureFailure(expanded, 'expand')?.kind).toBe('not-rendered');
    expect(expanded).not.toContain('SSN');
  });

  it('still returns content for a rendered element', async () => {
    await page.setContent('<body><div id="v"><p>Real content</p></div></body>');

    const expanded = await expandDomSubtree(page, '#v');

    expect(domCaptureFailure(expanded, 'expand')).toBeNull();
    expect(expanded).toContain('Real content');
  });
});

/**
 * All one bug: `el.attributes` is what the page SHIPPED, and neither a click
 * nor a keystroke ever writes there. Found live — a condition judge reported
 * "the Cash checkbox is currently checked" about a box the run had just
 * unticked (and whose unticking had disabled the Pay now button, which only
 * happens when it is unticked), so the chain took the wrong branch.
 *
 * A real browser is the only place to test this: the whole point is the gap
 * between the attribute and the IDL property, and a stubbed `evaluate` has
 * neither.
 */
describe('captureDomSnapshot — live form state', () => {
  const lineFor = (snapshot: string, id: string): string | undefined =>
    snapshot.split('\n').find((l) => l.includes(`id="${id}"`));

  it('drops `checked` from a box the page shipped ticked, once a click unticks it', async () => {
    // The live fixture's own markup (fixtures/test-app/control-flow.html).
    await page.setContent(`<body>
      <label class="choice" for="pay-cash">
        <input type="checkbox" id="pay-cash" name="cash" checked>
        <span>Cash</span>
      </label>
    </body>`);

    const before = lineFor(await captureDomSnapshot(page), 'pay-cash');
    await page.click('#pay-cash');
    const after = lineFor(await captureDomSnapshot(page), 'pay-cash');

    // Untouched, the snapshot says what it always said.
    expect(before).toContain('checked=""');
    expect(await page.isChecked('#pay-cash')).toBe(false);
    expect(after).toBeDefined();
    expect(after).not.toContain('checked');
    // ...and nothing else about the element's line moved.
    expect(after).toContain('type="checkbox"');
    expect(after).toContain('name="cash"');
  }, 30_000);

  it('adds `checked` to a box the page shipped unticked, once a click ticks it', async () => {
    await page.setContent('<body><input type="checkbox" id="pay-card" name="card"></body>');

    expect(lineFor(await captureDomSnapshot(page), 'pay-card')).not.toContain('checked');
    await page.click('#pay-card');

    const after = lineFor(await captureDomSnapshot(page), 'pay-card');
    expect(await page.isChecked('#pay-card')).toBe(true);
    expect(after).toContain('checked=""');
  }, 30_000);

  it('moves `checked` across a radio group when the choice changes', async () => {
    await page.setContent(`<body>
      <input type="radio" id="ship-standard" name="ship" value="standard" checked>
      <input type="radio" id="ship-express" name="ship" value="express">
    </body>`);

    await page.check('#ship-express');
    const snapshot = await captureDomSnapshot(page);

    expect(lineFor(snapshot, 'ship-standard')).not.toContain('checked');
    expect(lineFor(snapshot, 'ship-express')).toContain('checked=""');
    // A radio's `value` is its submit payload, not its state: still the markup's.
    expect(lineFor(snapshot, 'ship-express')).toContain('value="express"');
  }, 30_000);

  it('moves `selected` to the option actually chosen', async () => {
    await page.setContent(`<body>
      <select id="plan" name="plan">
        <option id="opt-basic" value="basic" selected>Basic</option>
        <option id="opt-gold" value="gold">Gold</option>
      </select>
    </body>`);

    await page.selectOption('#plan', 'gold');
    const snapshot = await captureDomSnapshot(page);

    expect(lineFor(snapshot, 'opt-basic')).not.toContain('selected');
    expect(lineFor(snapshot, 'opt-gold')).toContain('selected=""');
    // <select> has no `value` content attribute at all, so its choice was
    // previously readable only from the options.
    expect(lineFor(snapshot, 'plan')).toContain('value="gold"');
  }, 30_000);

  it('shows the value a step typed, and leaves an untouched field as its markup', async () => {
    await page.setContent(`<body>
      <input type="text" id="who" name="who">
      <input type="text" id="preset" name="preset" value="unchanged">
      <input type="text" id="blank" name="blank">
    </body>`);

    await page.fill('#who', 'ada@example.com');
    const snapshot = await captureDomSnapshot(page);

    expect(lineFor(snapshot, 'who')).toContain('value="ada@example.com"');
    expect(lineFor(snapshot, 'preset')).toContain('value="unchanged"');
    // An empty field with no `value` in its markup says nothing, as before —
    // `value=""` on every blank input would be new noise on every page.
    expect(lineFor(snapshot, 'blank')).not.toContain('value=');
  }, 30_000);

  it('keeps a typed textarea on one line', async () => {
    // Every element occupies exactly one line and callers split on '\n' to
    // find one; a textarea's live value is the one that routinely has newlines.
    await page.setContent('<body><textarea id="notes" name="notes"></textarea></body>');

    await page.fill('#notes', 'line one\nline two');
    const snapshot = await captureDomSnapshot(page);

    expect(lineFor(snapshot, 'notes')).toContain('value="line one line two"');
  }, 30_000);

  it('never puts a typed password in the snapshot', async () => {
    // The one field whose live value is a secret by definition. The snapshot
    // reaches the model and can be written to a report, so `type=password`
    // keeps the markup's (normally absent) attribute and nothing else.
    await page.setContent(`<body>
      <input type="password" id="pw" name="password">
      <input type="file" id="doc" name="doc">
    </body>`);

    await page.fill('#pw', 'hunter2-NOT-FOR-THE-SNAPSHOT');
    const snapshot = await captureDomSnapshot(page);

    expect(lineFor(snapshot, 'pw')).toBeDefined();
    expect(snapshot).not.toContain('hunter2');
    // Same rule, different reason: a file input's `.value` is the browser
    // fiction "C:\fakepath\…", which is worth nothing to a model.
    expect(lineFor(snapshot, 'doc')).not.toContain('fakepath');
  }, 30_000);

  it('still withholds the password after a show/hide toggle makes it type=text', async () => {
    // The eye icon on most sign-in forms, and the reason `type` alone cannot
    // answer "is this a password field": one click after the snapshot
    // correctly withheld the value, the same element is an ordinary text
    // input and the typed secret would go straight into the snapshot the
    // model reads and the report can quote (review 3, finding 1).
    await page.setContent(`<body>
      <input type="password" id="pw" name="password">
      <button id="show" onclick="document.getElementById('pw').type='text'">Show</button>
    </body>`);

    await page.fill('#pw', 'hunter2-NOT-FOR-THE-SNAPSHOT');
    expect(await captureDomSnapshot(page)).not.toContain('hunter2');

    await page.click('#show');
    expect(await page.getAttribute('#pw', 'type')).toBe('text');

    const after = await captureDomSnapshot(page);
    expect(after).not.toContain('hunter2');
    // Still described, just not quoted: the model can target the field.
    expect(lineFor(after, 'pw')).toContain('type="text"');
    expect(lineFor(after, 'pw')).toContain('name="password"');
  }, 30_000);

  it('withholds the typed value of every field the PASSWORD rule names, toggled or not', async () => {
    // The mirror of `isSecretName` — /password|secret|token|key/i — is the
    // wrong rule to ask on its own here, and `pwd` is the proof: one of the
    // two commonest names for a password input, matching neither that regex
    // nor `autocomplete`, so a show/hide toggle handed the typed password
    // straight to the snapshot (review 4, finding 1). A FIELD name is judged
    // more harshly than a parameter name because it decides DISCLOSURE of a
    // value the run does not own, not masking of one it does.
    await page.setContent(`<body>
      <input type="password" id="a" name="pwd">
      <input type="password" id="b" name="pass">
      <input type="password" id="passcode">
      <input type="password" id="d" aria-label="login-pin">
      <input type="password" id="e" name="credential">
      <button id="show" onclick="document.querySelectorAll('input[type=password]').forEach(i => i.type = 'text')">Show</button>
    </body>`);

    const typed: Record<string, string> = {
      '#a': 'AAA-pwd-secret',
      '#b': 'BBB-pass-secret',
      '#passcode': 'CCC-passcode-secret',
      '#d': 'DDD-pin-secret',
      '#e': 'EEE-cred-secret',
    };
    for (const [sel, value] of Object.entries(typed)) await page.fill(sel, value);

    // Withheld while the type still says password...
    const before = await captureDomSnapshot(page);
    for (const value of Object.values(typed)) expect(before).not.toContain(value);

    // ...and after the eye icon flips all five to `type="text"`.
    await page.click('#show');
    expect(await page.getAttribute('#a', 'type')).toBe('text');
    const after = await captureDomSnapshot(page);
    for (const value of Object.values(typed)) expect(after).not.toContain(value);
    // Still described, and still saying a value is there: the model can
    // target the field and knows it is filled.
    expect(lineFor(after, 'a')).toContain('name="pwd"');
    expect(lineFor(after, 'a')).toContain('value="***"');
  }, 30_000);

  it('says a secret field HAS a value without saying what it is', async () => {
    // Dropping the attribute reads exactly like an empty field, and a
    // condition, a `Verify` and the watch group's poller all decide from this
    // text (review 4, finding 2).
    await page.setContent(`<body>
      <input type="password" id="pw" name="password">
      <input type="text" id="tok" name="api_key">
      <input type="password" id="empty" name="password2">
    </body>`);

    await page.fill('#pw', 'hunter2-NOT-FOR-THE-SNAPSHOT');
    await page.fill('#tok', 'tok-LIVE-1234');
    const snapshot = await captureDomSnapshot(page);

    expect(snapshot).not.toContain('hunter2');
    expect(snapshot).not.toContain('tok-LIVE-1234');
    expect(lineFor(snapshot, 'pw')).toContain('value="***"');
    expect(lineFor(snapshot, 'tok')).toContain('value="***"');
    // Nothing typed, nothing to withhold: an empty secret field says nothing,
    // so `***` really does mean "filled".
    expect(lineFor(snapshot, 'empty')).not.toContain('value=');
  }, 30_000);

  it('judges a placeholder by the PASSWORD rule only, never by the NAME rule', async () => {
    // Two rules, and a placeholder gets only the harsh one. The name rule
    // over-matches on a bare `key` — "Search by keyword" is where that word
    // actually lives on real pages — so reading a placeholder with it cost
    // ordinary search boxes their live value (review 4, finding 2). But
    // dropping the attribute outright reopened the leak the round was fixing:
    // a placeholder is very often the ONLY thing naming a password box on a
    // minimal sign-in form, and one click of the eye icon then handed the
    // typed password to the snapshot (review 5, finding 1).
    await page.setContent(`<body>
      <input type="search" id="s" name="q" placeholder="Search by keyword">
      <input type="password" id="ph" placeholder="Password">
      <input type="text" id="tok" placeholder="API secret key">
      <input type="text" id="t" name="topic" placeholder="Enter your password hint">
      <button id="show" onclick="document.getElementById('ph').type='text'">Show</button>
    </body>`);

    await page.fill('#s', 'unpaid');
    await page.fill('#ph', 'PH-secret-A');
    await page.fill('#tok', 'sk-LIVE-9999');
    await page.fill('#t', 'invoices');
    await page.click('#show');
    expect(await page.getAttribute('#ph', 'type')).toBe('text');

    const snapshot = await captureDomSnapshot(page);

    // The name rule's `key` never sees a placeholder, so the search box keeps
    // the value the run just typed into it.
    expect(lineFor(snapshot, 's')).toContain('value="unpaid"');
    // The password rule does see it: the field has no name, no id-shaped
    // identity and no aria-label, and is now `type="text"`.
    expect(snapshot).not.toContain('PH-secret-A');
    expect(lineFor(snapshot, 'ph')).toContain('value="***"');
    // ...and an API-key box rendered `type="text"` on purpose, so the user
    // can read it, leaks with no toggle at all if nothing reads its prose.
    expect(snapshot).not.toContain('sk-LIVE-9999');
    expect(lineFor(snapshot, 'tok')).toContain('value="***"');
    // The price of that, pinned rather than hidden: a topic box whose
    // placeholder merely mentions a password is withheld too. One ordinary
    // field's value against a whole family of real sign-in forms.
    expect(snapshot).not.toContain('invoices');
    expect(lineFor(snapshot, 't')).toContain('value="***"');
  }, 30_000);

  it('keeps `pass` inside an ordinary word live — passenger, passport, bypass', async () => {
    // The field rule is harsher than the parameter rule about PASSWORD-shaped
    // names, not about the substring `pass`. Without the lookaround fence a
    // travel booking — a canonical UI-automation subject — could fill a
    // passenger name and then never verify it, because the judge is shown `***`
    // (review 5, finding 2).
    await page.setContent(`<body>
      <input type="text" id="p1" name="passenger1_name">
      <input type="text" id="p2" name="passportNumber">
      <input type="text" id="p3" name="bypass_cache">
      <input type="text" id="p4" name="compass_heading">
      <input type="text" id="p5" aria-label="Passenger 1 full name">
      <input type="text" id="p6" name="pinned">
    </body>`);

    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      await page.fill(`#${id}`, `LIVE-${id}`);
    }
    const snapshot = await captureDomSnapshot(page);

    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      expect(lineFor(snapshot, id)).toContain(`value="LIVE-${id}"`);
    }
  }, 30_000);

  it('still withholds every password-shaped name the fences keep', async () => {
    // The other side of the same rules: fencing `pass` and `pin` must not
    // cost the names review 4 measured as leaking, nor the compounds that
    // match on `password` / `isSecretName` rather than on `pass`.
    await page.setContent(`<body>
      <input type="text" id="w1" name="pwd">
      <input type="text" id="w2" name="pass">
      <input type="text" id="w3" name="passcode">
      <input type="text" id="w4" name="passphrase">
      <input type="text" id="w5" name="passwordField">
      <input type="text" id="w6" aria-label="login-pin">
      <input type="text" id="w7" name="credential">
      <input type="text" id="w8" name="passwd">
      <input type="text" id="w9" name="user_pass">
      <input type="text" id="w10" name="pass1">
      <input type="text" id="w11" name="new_pass">
      <input type="text" id="w12" name="txtPass">
      <input type="text" id="w13" name="signin_pass">
      <input type="text" id="w14" name="pin_code">
      <input type="text" id="w15" name="pinCode">
      <input type="text" id="w16" name="user_pin">
      <input type="text" id="w17" name="pin1">
      <input type="text" id="w18" name="atmPin">
      <input type="text" id="w19" name="mpin">
      <input type="text" id="w20" name="securityPin">
      <input type="text" id="w21" name="PINCODE">
      <input type="text" id="w22" placeholder="Enter your PIN">
    </body>`);

    // w8–w13 are the `pass` names a `\b` fence let through, and w14–w21 the
    // `pin` names it let through the same way: `_` and digits are word
    // characters to JavaScript's `\b` (review 6 finding 1, review 7 finding 1).
    // w22's space-fenced `PIN` always masked; it pins the placeholder channel.
    // They must mask like the seven above. Values carry a terminator so
    // `LEAK-w1` cannot be satisfied by `LEAK-w10`.
    const ids = Array.from({ length: 22 }, (_, i) => `w${i + 1}`);
    for (const id of ids) await page.fill(`#${id}`, `LEAK-${id}-END`);
    const snapshot = await captureDomSnapshot(page);

    for (const id of ids) {
      expect(snapshot).not.toContain(`LEAK-${id}-END`);
      expect(lineFor(snapshot, id)).toContain('value="***"');
    }
  }, 30_000);

  it('keeps `pin` inside an ordinary word live — shipping, spinner, pinned', async () => {
    // `pin` is matched as a whole token, never as a substring: a checkout's
    // shipping address and a loading spinner's label are not PINs.
    await page.setContent(`<body>
      <input type="text" id="n1" name="shipping_address">
      <input type="text" id="n2" name="spinnerLabel">
      <input type="text" id="n3" name="typing_speed">
      <input type="text" id="n4" name="pinned_items">
      <input type="text" id="n5" aria-label="Pinterest handle">
      <input type="text" id="n6" placeholder="Share your opinion">
    </body>`);

    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    for (const id of ids) await page.fill(`#${id}`, `LIVE-${id}-END`);
    const snapshot = await captureDomSnapshot(page);

    for (const id of ids) {
      expect(lineFor(snapshot, id)).toContain(`value="LIVE-${id}-END"`);
    }
  }, 30_000);

  it('still over-matches on a NAME, and now says so with `***`', async () => {
    // `name="monkey"` contains `key`, so the mirror of `isSecretName` masks
    // it — the same over-match the framework makes on a parameter called
    // `keyword`, and deliberately kept: narrowing it to word boundaries would
    // disclose `apikey` and `passwordfield`, which is the wrong direction for
    // a rule about a value the run does not own. What changed is that the
    // over-match is now VISIBLE: `***` says a value is there and withheld,
    // where dropping the attribute was indistinguishable from empty. There is
    // no `unmask` hatch for this rule (review 4, finding 2).
    await page.setContent('<body><input type="text" id="mk" name="monkey"></body>');

    await page.fill('#mk', 'TYPED-monkey');
    const snapshot = await captureDomSnapshot(page);

    expect(snapshot).not.toContain('TYPED-monkey');
    expect(lineFor(snapshot, 'mk')).toContain('value="***"');
  }, 30_000);

  it('withholds the value of a secret-NAMED field that was never type=password', async () => {
    // The name rule mirrors `isSecretName` (src/utils/secrets.ts):
    // /password|secret|token|key/i, read off name / id / aria-label /
    // autocomplete — the four places a field says what it IS, none of which
    // a toggle can move. `autocomplete` is what a field named only in a
    // sibling <label> still has.
    await page.setContent(`<body>
      <input type="text" id="api-token" name="api-token">
      <input type="text" id="pin" autocomplete="current-password">
      <input type="text" id="q" aria-label="Search invoices">
      <textarea id="notes" name="client-secret"></textarea>
    </body>`);

    await page.fill('#api-token', 'tok-LIVE-1234');
    await page.fill('#pin', 'pin-LIVE-9999');
    await page.fill('#q', 'unpaid');
    await page.fill('#notes', 'sk-LIVE-abcdef');
    const snapshot = await captureDomSnapshot(page);

    expect(snapshot).not.toContain('tok-LIVE-1234');
    expect(snapshot).not.toContain('pin-LIVE-9999');
    expect(snapshot).not.toContain('sk-LIVE-abcdef');
    // ...and an ordinary field is untouched by the rule.
    expect(lineFor(snapshot, 'q')).toContain('value="unpaid"');
  }, 30_000);
});

describe('captureDomSnapshot — clipping and browser-side failures', () => {
  // The route reports `truncated` from this flag. Without it, a snapshot the
  // capture already clipped at domSnapshotCharLimit arrives looking complete,
  // and the agent is told a quarter of a page is the whole page.
  it('marks a snapshot clipped at domSnapshotCharLimit', async () => {
    await page.setContent(`<body><div>${'X'.repeat(5000)}</div></body>`);

    const clipped = await captureDomSnapshot(page, { domSnapshotCharLimit: 500 });
    const whole = await captureDomSnapshot(page, { domSnapshotCharLimit: 100_000 });

    expect(domSnapshotWasClipped(clipped)).toBe(true);
    expect(domSnapshotWasClipped(whole)).toBe(false);
    // The clip is why length alone cannot be trusted as "the page's size".
    expect(clipped.length).toBeGreaterThan(500);
  });

  // capture-dom.js has its OWN try/catch, emitting `<error>Failed to capture
  // DOM: …` — a different prefix from the Node-side marker. Matching only the
  // Node one returned that string to the agent as 200 OK page content.
  it('recognises a failure raised inside the browser script', async () => {
    await page.setContent('<body><p>hi</p></body>');
    await page.evaluate(`window.getComputedStyle = function () { throw new Error('boom'); }`);

    const snapshot = await captureDomSnapshot(page);

    expect(snapshot).toContain('<error>');
    expect(domCaptureFailure(snapshot, 'snapshot')).not.toBeNull();
    expect(domCaptureFailure(snapshot, 'snapshot')?.kind).toBe('evaluate-failed');
  });
});

describe('domCaptureFailure', () => {
  it('returns null for ordinary content', () => {
    expect(domCaptureFailure('<body><p>hello</p></body>', 'snapshot')).toBeNull();
    expect(domCaptureFailure('', 'snapshot')).toBeNull();
    expect(domCaptureFailure('<div>subtree</div>', 'expand')).toBeNull();
  });

  it('recognises an expand selector miss', () => {
    const err = domCaptureFailure('[expand] No element found for selector: #missing', 'expand');

    expect(err?.kind).toBe('selector-miss');
    expect(err?.message).toContain('#missing');
  });

  // The `dom` path is the one the tool description steers agents to for
  // selector work, so an invalid selector must classify there too — it was
  // hardcoded to evaluate-failed, i.e. a 500, while `text` correctly said 400.
  it('recognises an invalid selector on the expand path', () => {
    const err = domCaptureFailure(
      `[expand] Error: SyntaxError: Failed to execute 'querySelector' on 'Document': 'div:has-text("x")' is not a valid selector.`,
      'expand',
    );

    expect(err?.kind).toBe('bad-selector');
  });

  // Both formats must answer the same way for the same element. expandDomSubtree
  // filters invisible elements to '', which at the top level read as "this
  // element is empty" — while `text` raised not-rendered for the same selector.
  it('recognises a not-rendered element on the expand path', () => {
    const err = domCaptureFailure('[expand] Not rendered: #hidden-modal', 'expand');

    expect(err?.kind).toBe('not-rendered');
    expect(err?.message).toContain('#hidden-modal');
  });

  it('recognises an ordinary expand evaluate error', () => {
    const err = domCaptureFailure('[expand] Error: TypeError: boom', 'expand');

    expect(err?.kind).toBe('evaluate-failed');
    expect(err?.message).toContain('TypeError');
  });

  it('recognises an expand timeout', () => {
    const err = domCaptureFailure(
      '[expand] Error: Error: evaluate timed out after 30000ms',
      'expand',
    );

    expect(err?.kind).toBe('timeout');
  });

  // A page may legitimately contain an <error> element, and the expand path
  // returns whatever tag was asked for. Applying the snapshot envelope there
  // turned a real page into a capture failure — and if its text contained
  // "SyntaxError", into a bogus "invalid selector" 400.
  it('does not treat a page\'s own <error> element as a failure', () => {
    const realContent = '<error> SyntaxError while parsing the invoice\n</error>\n';

    expect(domCaptureFailure(realContent, 'expand')).toBeNull();
  });

  it('recognises a snapshot timeout and strips the marker tags', () => {
    const err = domCaptureFailure(
      '<error>DOM capture timed out: Error: evaluate timed out after 30000ms</error>',
      'snapshot',
    );

    expect(err?.kind).toBe('timeout');
    expect(err?.message).not.toContain('<error>');
    expect(err?.message).toContain('timed out');
  });

  // captureDomSnapshot's catch absorbs EVERY evaluate rejection, not just
  // timeouts, so the marker alone does not mean "timed out". Calling an
  // ordinary failure a timeout tells the caller to wait when it should narrow.
  it('does not call an ordinary capture failure a timeout', () => {
    const err = domCaptureFailure(
      '<error>DOM capture timed out: TypeError: x is not a function</error>',
      'snapshot',
    );

    expect(err?.kind).toBe('evaluate-failed');
  });

  // No selector is in play on the whole-page path, so a SyntaxError from the
  // page's own code must not be reported as the caller's bad selector.
  it('does not blame a selector on a request that had none', () => {
    const err = domCaptureFailure(
      '<error>Failed to capture DOM: SyntaxError: Unexpected token }</error>',
      'snapshot',
    );

    expect(err?.kind).toBe('evaluate-failed');
    expect(err?.message).not.toContain('valid CSS selector');
  });

  it('recognises the browser-side capture marker', () => {
    const err = domCaptureFailure(
      '<error>Failed to capture DOM: RangeError: Maximum call stack size exceeded</error>',
      'snapshot',
    );

    expect(err?.kind).toBe('evaluate-failed');
    expect(err?.message).toContain('Maximum call stack');
  });

  it('recognises a navigation race inside either marker', () => {
    expect(
      domCaptureFailure('<error>DOM capture timed out: Error: Execution context was destroyed</error>', 'snapshot')?.kind,
    ).toBe('navigated');
    expect(
      domCaptureFailure('<error>Failed to capture DOM: Error: Execution context was destroyed</error>', 'snapshot')?.kind,
    ).toBe('navigated');
  });

  // The marker is produced in one place and matched in another; if the two ever
  // drift, every unreadable page starts reading as legitimate content.
  it('matches the marker captureDomSnapshot actually emits', async () => {
    const fakePage = {
      evaluate: () => Promise.reject(new Error('boom')),
      locator: () => ({ all: () => Promise.resolve([]) }),
    } as unknown as Page;

    const snapshot = await captureDomSnapshot(fakePage);

    // `evaluate-failed`, not `timeout`: the stub rejects with a plain Error, and
    // the marker means "capture gave up", not "the budget expired".
    expect(domCaptureFailure(snapshot, 'snapshot')?.kind).toBe('evaluate-failed');
  });
});

// ---------------------------------------------------------------------------
// readPageIdentity (stories/navigate-tab.md §Locked)
//
// Shared by both peeks and by a navigation, so all three describe a page the
// same way. The retry is here because the one failure that is genuinely
// transient — the page moved while we were reading it — usually resolves in
// half a second, and a warning nobody can act on is worse than a short wait.
// ---------------------------------------------------------------------------

describe('readPageIdentity', () => {
  /** A page whose `title()` fails for the first `failures` calls. */
  function flakyPage(opts: { failures: number; urls?: string[]; title?: string }) {
    let calls = 0;
    const urls = opts.urls ?? ['https://shop.example/cart'];
    return {
      calls: () => calls,
      page: {
        url: () => urls[Math.min(calls, urls.length - 1)]!,
        title: async () => {
          const attempt = calls++;
          if (attempt < opts.failures) throw new Error('Execution context was destroyed');
          return opts.title ?? 'Cart';
        },
      } as unknown as Page,
    };
  }

  it('reads in one go when nothing is moving', async () => {
    const { page, calls } = flakyPage({ failures: 0 });

    const identity = await readPageIdentity(page);

    expect(identity).toEqual({ url: 'https://shop.example/cart', title: 'Cart', stale: false });
    // No retry, so no 500ms spent on the overwhelmingly common path.
    expect(calls()).toBe(1);
  });

  it('retries once and reports the page it MOVED to', async () => {
    // The interesting case: the read lost a race with a client-side redirect,
    // and half a second later the new page answers happily. This is why the
    // retry exists — it turns a warning into a non-event.
    const { page } = flakyPage({
      failures: 1,
      urls: ['https://shop.example/cart', 'https://accounts.example/login'],
      title: 'Sign in',
    });

    const identity = await readPageIdentity(page);

    expect(identity).toEqual({
      url: 'https://accounts.example/login',
      title: 'Sign in',
      stale: false,
    });
  });

  it('gives up after the second failure and says the url may be stale', async () => {
    const { page } = flakyPage({ failures: 99 });

    const identity = await readPageIdentity(page);

    // `stale` is really a claim about the URL, not the title: `page.url()` was
    // read BEFORE the title threw, so it is the address from before the move.
    expect(identity.stale).toBe(true);
    expect(identity.url).toBe('https://shop.example/cart');
    expect(identity.title).toBe('');
  });

  it('keeps a url it salvaged rather than answering with nothing', async () => {
    // A stale url beats an empty one — `stale` is what says which it is.
    const { page } = flakyPage({ failures: 99, urls: ['https://shop.example/cart'] });

    const identity = await readPageIdentity(page);

    expect(identity.url).not.toBe('');
  });
});
