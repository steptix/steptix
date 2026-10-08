/**
 * stories/codebehind-selector-ambiguity.md — "Measurement 1: what the runtime
 * found", and the `browser.ambiguousTarget` switch that reads it.
 *
 * At the instant the AI runtime acts, it knows exactly how many elements the
 * selector matched and which one it is about to touch, and has always thrown
 * all of it away. These tests pin what it now records: `matchCount` (strict
 * mode's number, hidden matches included), `visibleMatchCount` (what the
 * runtime was choosing between) and a `resolvedSelector` verified against the
 * live document.
 *
 * Against a real headless Chromium and the purpose-built fixture, because
 * every fact here is a browser fact: a `display:none` copy of a header link is
 * counted by `querySelectorAll` and filtered by Playwright's `visible=true`,
 * and no stub can be wrong about that on our behalf in the way a browser can.
 *
 * The fixture's measured cases (fixtures/test-app/ambiguous-targets.html):
 *   a[href="transactions.html"]      2 total / 1 visible  (hidden drawer copy)
 *   a[href="delegates.html"]         2 total / 2 visible
 *   #notices span                    3 visible, no unique attribute handle
 *   #payees button                   3 visible, data-driven rows
 *   [data-testid="save-preferences"] 1 / 1, the control
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction } from '../src/browser/actions.js';
import { findInDom } from '../src/browser/dom-cleaner.js';
import { logger } from '../src/utils/logger.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(repoRoot, 'fixtures', 'test-app', 'ambiguous-targets.html');

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
}, 60_000);

beforeEach(async () => {
  await page.goto(pathToFileURL(FIXTURE).href);
  // Swallow link navigation so a click can be measured without the page
  // leaving under the next assertion. The click itself still happens — this
  // suppresses the default action, not the event.
  await page.evaluate(`document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('a')) e.preventDefault();
  }, true)`);
});

/** What the live document says a selector addresses. */
async function resolve(sel: string): Promise<{ count: number; text: string }> {
  return await page.evaluate(`(() => {
    const found = document.querySelectorAll(${JSON.stringify(sel)});
    return { count: found.length, text: found[0] ? (found[0].textContent || '').trim() : '' };
  })()`) as { count: number; text: string };
}

describe('measurement — what the runtime found', () => {
  // The failure the story opens with: a visible link in the page and a second
  // copy inside a drawer that never renders. The AI was right; the generated
  // entry would have thrown on the second match. The hidden copy is counted
  // because the measurement asks the document, not the DOM snapshot — which
  // strips a hidden element's attributes and truncates at 100k.
  it('records both counts and a verified handle for a hidden duplicate', async () => {
    const result = await executeAction(
      page,
      { action: 'click', selector: 'a[href="transactions.html"]', description: 'Open statements' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(true);
    expect(result.targeting?.matchCount).toBe(2);
    expect(result.targeting?.visibleMatchCount).toBe(1);

    // Not the bare href: that is exactly the selector strict mode rejects.
    // The element's own handle, qualified by the nearest addressable ancestor
    // — the form the story's worked example shows.
    expect(result.targeting?.resolvedSelector).toBe('#statements a[href="transactions.html"]');
    expect(result.targeting?.resolvedBy).toBe('scoped');
    expect((await resolve('a[href="transactions.html"]')).count).toBe(2);

    // Verified, and pointing at the element the runtime actually touched.
    const check = await resolve(result.targeting!.resolvedSelector!);
    expect(check.count).toBe(1);
    expect(check.text).toBe('Open statements');
  });

  // Both the scoped form and the positional chain resolve to the target today.
  // They are not equally good: this is what gets compiled into a committed
  // file, so it has to survive the page changing around it.
  it('prefers the scoped handle over a positional chain that a sibling would break', async () => {
    const result = await executeAction(
      page,
      { action: 'hover', selector: 'a[href="transactions.html"]', description: 'Hover statements' },
      undefined,
      undefined,
      { measure: true },
    );
    const scoped = result.targeting!.resolvedSelector!;
    const positional = '#statements > div:nth-of-type(1) > a:nth-of-type(1)';

    // Before: both address the target.
    expect((await resolve(scoped)).text).toBe('Open statements');
    expect((await resolve(positional)).text).toBe('Open statements');

    // A new link lands above it in the panel — an ordinary edit.
    await page.evaluate(`(() => {
      const panel = document.querySelector('#statements .panel');
      const extra = document.createElement('a');
      extra.setAttribute('href', 'archive.html');
      extra.textContent = 'Archived statements';
      panel.insertBefore(extra, panel.querySelector('a'));
    })()`);

    // After: the positional chain silently retargets; the scoped form does not.
    expect((await resolve(positional)).text).toBe('Archived statements');
    expect((await resolve(scoped)).text).toBe('Open statements');
    expect((await resolve(scoped)).count).toBe(1);
  });

  it('records 1/1 and a semantic handle for an unambiguous target', async () => {
    const result = await executeAction(
      page,
      {
        action: 'click',
        selector: '[data-testid="save-preferences"]',
        description: 'Save preferences',
      },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(true);
    expect(result.targeting).toEqual({
      matchCount: 1,
      visibleMatchCount: 1,
      resolvedSelector: '[data-testid="save-preferences"]',
      resolvedBy: 'attribute',
    });
    // The action ran: the fixture's click handler reveals the outcome line.
    expect(await page.locator('#outcome').isVisible()).toBe(true);
  });

  // No id, no data-testid, no name, no aria-label, and the text repeats — the
  // element has no attribute handle to scope either, so the only selector that
  // addresses one node is positional. That is a fact generation has to be told
  // rather than left to sniff out of the string.
  it('falls through to a verified positional path when no attribute handle is unique', async () => {
    const result = await executeAction(
      page,
      { action: 'hover', selector: '#notices span', description: 'Hover the first notice' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(true);
    expect(result.targeting?.matchCount).toBe(3);
    expect(result.targeting?.visibleMatchCount).toBe(3);
    const resolved = result.targeting?.resolvedSelector;
    expect(result.targeting?.resolvedBy).toBe('positional');
    expect(resolved).toMatch(/nth-of-type/);
    expect((await resolve(resolved!)).count).toBe(1);
  });

  // Measuring cold at T0 would say "0 elements matched" for a step whose
  // element renders a moment later and whose click then succeeds — a confident
  // lie. The wait is hoisted precisely so the number is taken after it.
  it('records 1, not 0, for an element that renders 400ms late', async () => {
    await page.setContent(`<body><div id="host"></div><script>
      setTimeout(() => {
        document.getElementById('host').innerHTML =
          '<button data-testid="late">Continue</button>';
      }, 400);
    </script></body>`);

    const result = await executeAction(
      page,
      { action: 'click', selector: '[data-testid="late"]', description: 'Click the late button' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(true);
    expect(result.targeting).toEqual({
      matchCount: 1,
      visibleMatchCount: 1,
      resolvedSelector: '[data-testid="late"]',
      resolvedBy: 'attribute',
    });
  }, 20_000);

  it('measures nothing on an ordinary run — the gate is compile-only', async () => {
    const result = await executeAction(
      page,
      {
        action: 'click',
        selector: '[data-testid="save-preferences"]',
        description: 'Save preferences',
      },
      undefined,
      undefined,
      { ambiguousTarget: 'first' },
    );

    expect(result.success).toBe(true);
    expect(result.targeting).toBeUndefined();
  });

  it('measures nothing when no options are passed at all', async () => {
    const result = await executeAction(page, {
      action: 'click',
      selector: '[data-testid="save-preferences"]',
      description: 'Save preferences',
    });
    expect(result.success).toBe(true);
    expect(result.targeting).toBeUndefined();
  });
});

describe('measurement — when it cannot happen', () => {
  /**
   * `page`, with every locator it hands out recording the options its
   * `waitFor` and `click` were called with. `waitFor` then runs with a short
   * REAL timeout, so a wait that cannot succeed still fails the Playwright way,
   * in milliseconds: what is under test is the budget the action asks for, not
   * how long a loaded machine takes to spend it.
   */
  function budgetRecorder(waitForTimeoutMs: number) {
    const waits: Array<Record<string, unknown>> = [];
    const clicks: Array<Record<string, unknown>> = [];
    const wrap = (loc: object): object =>
      new Proxy(loc, {
        get(target, prop, recv) {
          const value = Reflect.get(target, prop, recv);
          if (typeof value !== 'function') return value;
          if (prop === 'waitFor') {
            return (opts: Record<string, unknown> = {}) => {
              waits.push({ ...opts });
              return value.call(target, { ...opts, timeout: waitForTimeoutMs });
            };
          }
          if (prop === 'click') {
            return (opts: Record<string, unknown> = {}) => {
              clicks.push({ ...opts });
              return value.call(target, opts);
            };
          }
          // Keep recording down a `.locator(…).first()` chain.
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            const isLocator = typeof (out as { waitFor?: unknown } | null)?.waitFor === 'function';
            return isLocator ? wrap(out as object) : out;
          };
        },
      });
    const recording = new Proxy(page, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv);
        if (prop === 'locator' && typeof value === 'function') {
          return (...args: unknown[]) =>
            wrap((value as (...a: unknown[]) => object).apply(target, args));
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Page;
    return { page: recording, waits, clicks };
  }

  // "Wait times out — zero elements" is not a measurement outcome at all: the
  // hoisted wait throws exactly as the action's own wait would have, and the
  // sub-action is recorded WITH an error, which `actionsOf` filters out.
  it('contributes no targeting when the wait times out, inside the click`s one budget', async () => {
    // The budget a click spends on its own when nothing is measured...
    const plain = budgetRecorder(500);
    const clicked = await executeAction(plain.page, {
      action: 'click',
      selector: '[data-testid="save-preferences"]',
      description: 'Save preferences',
    });
    expect(clicked.success).toBe(true);
    expect(plain.waits).toEqual([]);
    expect(plain.clicks).toHaveLength(1);
    const clickBudget = plain.clicks[0]!['timeout'];
    expect(clickBudget).toBeGreaterThan(0);

    const ghost = budgetRecorder(500);
    const result = await executeAction(
      ghost.page,
      { action: 'click', selector: '#never-appears', description: 'Click a ghost' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(false);
    expect(result.targeting).toBeUndefined();
    expect(result.error).toMatch(/Timeout/i);
    // The existing failure path still reports the count it always did.
    expect(result.matchCount).toBe(0);

    // ...is the whole budget a measured click gets. The hoisted wait borrows
    // it rather than adding a second one, and once it runs out nothing else
    // waits — so a selector that never appears fails in one click budget
    // (~10 s), not two.
    expect(ghost.waits).toEqual([{ state: 'visible', timeout: clickBudget }]);
    expect(ghost.clicks).toEqual([]);
  });

  // Measurement is strictly additive telemetry: anything that throws inside it
  // leaves `targeting` absent and the action behaving byte-identically.
  it('swallows a measurement failure and acts anyway', async () => {
    // `count()` is called only by the measurement (and by the failure path,
    // which this action does not reach), so breaking it breaks exactly the
    // telemetry and nothing else.
    const wrapLocator = (loc: unknown): unknown =>
      new Proxy(loc as object, {
        get(target, prop, recv) {
          if (prop === 'count') {
            return () => Promise.reject(new Error('measurement exploded'));
          }
          const value = Reflect.get(target, prop, recv);
          if (prop === 'locator' && typeof value === 'function') {
            return (...args: unknown[]) =>
              wrapLocator((value as (...a: unknown[]) => unknown).apply(target, args));
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const brokenPage = new Proxy(page, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv);
        if (prop === 'locator' && typeof value === 'function') {
          return (...args: unknown[]) =>
            wrapLocator((value as (...a: unknown[]) => unknown).apply(target, args));
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Page;

    const result = await executeAction(
      brokenPage,
      {
        action: 'click',
        selector: '[data-testid="save-preferences"]',
        description: 'Save preferences',
      },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(true);
    expect(result.targeting).toBeUndefined();
    // Byte-identical behaviour: the click still landed.
    expect(await page.locator('#outcome').isVisible()).toBe(true);
  });
});

describe('browser.ambiguousTarget', () => {
  it("fails a click on 3 visible matches under 'fail', without acting", async () => {
    const result = await executeAction(
      page,
      { action: 'click', selector: '#payees button', description: 'Pay the payee again' },
      undefined,
      undefined,
      { measure: true, ambiguousTarget: 'fail' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('3 visible elements matched');
    expect(result.error).toContain('#payees button');
    // Carried as the count, so it reaches the AI through `collectedFailures`.
    expect(result.matchCount).toBe(3);
    expect(result.targeting?.visibleMatchCount).toBe(3);

    // Nothing was clicked: the fixture rewrites a clicked button's label.
    const labels = await page.locator('#payees button').allTextContents();
    expect(labels).toEqual(['Pay again', 'Pay again', 'Pay again']);
  });

  it("proceeds and warns under 'first' (the default)", async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = await executeAction(
        page,
        { action: 'click', selector: '#payees button', description: 'Pay the payee again' },
        undefined,
        undefined,
        { measure: true, ambiguousTarget: 'first' },
      );

      expect(result.success).toBe(true);
      expect(result.targeting?.visibleMatchCount).toBe(3);
      expect(warn.mock.calls.flat().join('\n')).toContain('matched 3 visible elements');

      // It took the first, which is the whole point of the switch.
      const labels = await page.locator('#payees button').allTextContents();
      expect(labels).toEqual(['Paid Aurora', 'Pay again', 'Pay again']);
    } finally {
      warn.mockRestore();
    }
  });

  // The gate reads `visibleMatchCount`, so it cannot be compile-only. It turns
  // on that ONE call whatever the mode — `resolvedSelector` stays compile-only.
  it("measures the visible count, and only that, when 'fail' is set on an ordinary run", async () => {
    const result = await executeAction(
      page,
      { action: 'click', selector: 'a[href="delegates.html"]', description: 'Contact support' },
      undefined,
      undefined,
      { ambiguousTarget: 'fail' },
    );

    expect(result.success).toBe(false);
    expect(result.targeting).toEqual({ visibleMatchCount: 2 });
  });

  // It gates on VISIBLE matches, not all matches. Gating on all would fail the
  // hidden-duplicate case, which is the one the measurement fixes without
  // failing anything.
  it('lets the hidden-duplicate case through under fail', async () => {
    const result = await executeAction(
      page,
      { action: 'click', selector: 'a[href="transactions.html"]', description: 'Open statements' },
      undefined,
      undefined,
      { measure: true, ambiguousTarget: 'fail' },
    );

    expect(result.success).toBe(true);
    expect(result.targeting).toMatchObject({ matchCount: 2, visibleMatchCount: 1 });
  });

  // Each action is gated on the count matching ITS OWN tolerance. A singular
  // `read` takes `.first()` over every match, hidden included, so it gates on
  // the total — this is the case the visible-count rule would have waved
  // through, and it is the worse failure of the two: it poisons a variable
  // with a hidden element's text instead of failing loudly.
  it('gates a singular read on ALL matches, so a hidden first match cannot poison a variable', async () => {
    await page.setContent(`<body>
      <div id="drawer" style="display:none"><span class="total">$0.00</span></div>
      <div id="drawer2" style="display:none"><span class="total">$0.00</span></div>
      <main><span class="total">$310.75</span></main>
    </body>`);

    const gated = await executeAction(
      page,
      { action: 'read', selector: '.total', as: 'total', description: 'Read the total' },
      undefined,
      undefined,
      { measure: true, ambiguousTarget: 'fail' },
    );

    expect(gated.success).toBe(false);
    expect(gated.error).toContain('3 elements matched');
    expect(gated.error).not.toContain('visible elements');
    expect(gated.matchCount).toBe(3);
    // Nothing was captured — which is the whole point.
    expect(gated.capturedValue).toBeUndefined();

    // Only one of the three is visible, so the visible-count rule would have
    // let this through and read "$0.00" out of a hidden drawer.
    expect(gated.targeting?.visibleMatchCount).toBe(1);
    const ungated = await executeAction(
      page,
      { action: 'read', selector: '.total', as: 'total', description: 'Read the total' },
      undefined,
      undefined,
      { measure: true, ambiguousTarget: 'first' },
    );
    expect(ungated.success).toBe(true);
    expect(ungated.capturedValue).toBe('$0.00');
  });

  // The same asymmetry from the other side: a click filters to visible first,
  // so a hidden duplicate is not ambiguity for it — and gating on the total
  // would fail the case the measurement already fixes without failing anything.
  it('does not gate a read whose extra matches are neither visible nor plural', async () => {
    const result = await executeAction(
      page,
      { action: 'read', selector: '#notices h2', as: 'heading', description: 'Read the heading' },
      undefined,
      undefined,
      { measure: true, ambiguousTarget: 'fail' },
    );
    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('Notices');
  });

  it('never gates a plural read, and records its count without a resolvedSelector', async () => {
    const result = await executeAction(
      page,
      {
        action: 'read',
        selector: '#notices span',
        as: 'notices',
        multiple: true,
        description: 'Read every notice',
      },
      undefined,
      undefined,
      { measure: true, ambiguousTarget: 'fail' },
    );

    expect(result.success).toBe(true);
    expect(result.capturedValues).toHaveLength(3);
    // …and the kinds of element it read: a read compiled from the recording
    // checks itself against them (SPEC-codebehind-robustness.md §6.6).
    expect(result.targeting).toEqual({ matchCount: 3, kinds: ['span'] });
    expect(result.targeting?.resolvedSelector).toBeUndefined();
  });

  it('never gates a count, whose many matches are its result', async () => {
    const result = await executeAction(
      page,
      { action: 'count', selector: '#payees button', as: 'payees', description: 'Count payees' },
      undefined,
      undefined,
      { measure: true, ambiguousTarget: 'fail' },
    );

    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('3');
    expect(result.targeting).toEqual({ matchCount: 3, kinds: ['button'] });
  });

  it('leaves plural actions unmeasured on an ordinary run', async () => {
    const result = await executeAction(
      page,
      { action: 'count', selector: '#payees button', as: 'payees', description: 'Count payees' },
      undefined,
      undefined,
      { ambiguousTarget: 'fail' },
    );
    expect(result.capturedValue).toBe('3');
    expect(result.targeting).toBeUndefined();
  });

  it('measures a singular read without disturbing what it reads', async () => {
    const result = await executeAction(
      page,
      { action: 'read', selector: '#notices h2', as: 'heading', description: 'Read the heading' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('Notices');
    expect(result.targeting).toMatchObject({ matchCount: 1, visibleMatchCount: 1 });
    expect((await resolve(result.targeting!.resolvedSelector!)).text).toBe('Notices');
  });

  // A singular `read` acts on `.first()` of the RAW locator, so its hoisted
  // wait is for `attached`, not `visible` — reading a hidden element is
  // ordinary, and a visibility wait would change what read means. Zero visible
  // matches is then a legitimate answer, and the field is left off rather than
  // recorded as a zero.
  it('reads a hidden element and records no visible count for it', async () => {
    const result = await executeAction(
      page,
      { action: 'read', selector: '#outcome', as: 'outcome', description: 'Read the outcome' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(result.success).toBe(true);
    expect(result.capturedValue).toBe('Preferences saved');
    expect(result.targeting).toEqual({
      matchCount: 1,
      resolvedSelector: '#outcome',
      resolvedBy: 'attribute',
      kinds: ['div'],
    });
  });
});

/**
 * The page-side selector builder is duplicated: `resolvedSelectorInPage` in
 * src/browser/actions.ts carries a literal copy of `strongSelector` and
 * friends from src/browser/scripts/find-in-dom.js, because Playwright cannot
 * serialise a reference to a Node-scope helper. That is the same constraint —
 * and the same remedy — as `extractValueInPage`/`executeReadMultiple`.
 *
 * A copy that drifts is a silent divergence between the selector the AI is
 * handed and the one the entry is generated from, so these two tests pin the
 * copies together: one on the source text, one on the behaviour.
 */
describe('the duplicated page function stays in lockstep with find-in-dom.js', () => {
  const actionsSrc = fs.readFileSync(path.join(repoRoot, 'src', 'browser', 'actions.ts'), 'utf-8');
  const findInDomSrc = fs.readFileSync(
    path.join(repoRoot, 'src', 'browser', 'scripts', 'find-in-dom.js'),
    'utf-8',
  );

  /** Comments, TypeScript annotations and layout stripped — what is left is
   *  the code, which is the thing that must not diverge. */
  function normalise(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/:\s*any\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function between(src: string, from: string, to: string): string {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('copies escAttr, idSelector, verifies, strongSelector and stableSelector verbatim', () => {
    const mirrored = between(actionsSrc, '/* MIRROR-BEGIN find-in-dom.js */', '/* MIRROR-END */')
      .replace('/* MIRROR-BEGIN find-in-dom.js */', '');
    const original = between(findInDomSrc, '  function escAttr(v) {', '  function getKeyAttrs(el) {');

    expect(normalise(mirrored)).toBe(normalise(original));
    // Guard the guard: a normaliser that collapsed everything to '' would
    // "pass" forever.
    expect(normalise(mirrored)).toContain('function strongSelector(el)');
    expect(normalise(mirrored).length).toBeGreaterThan(500);
  });

  /** The attributes a function's source reads, in the order it reads them. */
  function attributesReadBy(src: string): string[] {
    return [...src.matchAll(/getAttribute\('([^']+)'\)/g)].map((m) => m[1]!);
  }

  // The scoped tier needs the element's candidate handles UNVERIFIED, which
  // `strongSelector` cannot give it — so `ownAttrSelectors` restates the
  // hierarchy. It sits outside the mirror on purpose (find-in-dom.js has no
  // such layer), which means the textual pin above does not cover it. This
  // does: same attributes, same order.
  it('scopes with the same candidate hierarchy the mirror verifies with', () => {
    const strong = between(actionsSrc, '  function strongSelector(el: any) {', '  function stableSelector(el: any) {');
    const owns = between(actionsSrc, '  function ownAttrSelectors(el: any) {', '\n  try {');

    expect(attributesReadBy(owns)).toEqual(attributesReadBy(strong));
    expect(attributesReadBy(owns)).toEqual(['data-testid', 'id', 'name', 'aria-label', 'href']);
  });

  // Where the element's own handle verifies on its own, the two agree exactly
  // — that is the shared `strongSelector` answering.
  it('produces the same selector as findInDom does when the own handle verifies', async () => {
    const found = await findInDom(page, 'Save preferences');
    expect(found.matches).toHaveLength(1);

    const measured = await executeAction(
      page,
      {
        action: 'hover',
        selector: '[data-testid="save-preferences"]',
        description: 'Hover save',
      },
      undefined,
      undefined,
      { measure: true },
    );

    expect(measured.targeting?.resolvedSelector).toBe(found.matches[0]!.selector);
    expect(measured.targeting?.resolvedBy).toBe('attribute');
  });

  // Where it does not, they deliberately part company: find-in-dom is building
  // a one-shot hint for the model's next turn, so a positional path costs it
  // nothing, while this output is compiled into a committed file.
  it('beats findInDom on the case where a scoped handle exists', async () => {
    const found = await findInDom(page, 'Open statements');
    expect(found.matches[0]!.selector).toBe('#statements > div:nth-of-type(1) > a:nth-of-type(1)');

    const measured = await executeAction(
      page,
      { action: 'hover', selector: 'a[href="transactions.html"]', description: 'Hover statements' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(measured.targeting?.resolvedSelector).toBe('#statements a[href="transactions.html"]');
    expect(measured.targeting?.resolvedBy).toBe('scoped');
  });

  // With no attribute handle to scope, both fall to the same positional chain
  // out of the same shared `stableSelector`.
  it('agrees with findInDom on an element with no attribute handle at all', async () => {
    const found = await findInDom(page, 'Scheduled maintenance');
    expect(found.matches.length).toBeGreaterThan(0);

    const measured = await executeAction(
      page,
      { action: 'hover', selector: '#notices span', description: 'Hover the first notice' },
      undefined,
      undefined,
      { measure: true },
    );

    expect(measured.targeting?.resolvedSelector).toBe(found.matches[0]!.selector);
    expect(measured.targeting?.resolvedBy).toBe('positional');
  });
});
