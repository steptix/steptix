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
