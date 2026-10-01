/**
 * The scoreboard's two judgements on an action (docs/specs/SPEC-scoreboard.md
 * §5.3 selector form, §5.4 outcome).
 *
 * The outcome rows are built from REAL error text. Everything under `REAL` was
 * captured on 2026-09-29 by driving the framework's own `executeAction` /
 * `executeWait` (and, for the strict-mode and navigation rows, Playwright
 * itself) against a Chromium page under Playwright 1.59.1 — ANSI codes and
 * all, because that is what a run records. The last block re-derives the
 * headline cases on a live page, so a Playwright upgrade that rewords one
 * fails here rather than silently regrouping every line written after it.
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { actionSelector, classifyOutcome, classifySelectorForm } from '../src/stats/classify.js';
import { executeAction, type ActionTargeting } from '../src/browser/actions.js';
import type { AIAction } from '../src/ai/types.js';
import type { SubActionResult } from '../src/report/types.js';

/**
 * A sub-action as the step executor records it. An error defaults to coming
 * from the browser action layer — tagged `errorSource: 'playwright'`, as the
 * executor tags `executeAction`'s — because that is where every `REAL` string
 * below was captured; pass `null` for an error the framework, a page, a server
 * or the model wrote.
 */
function sub(
  action: Partial<AIAction> & { action: string },
  error?: string,
  targeting?: ActionTargeting,
  errorSource: 'playwright' | null = 'playwright',
): SubActionResult {
  return {
    index: 1,
    action: { description: 'test action', ...action } as AIAction,
    durationMs: 10,
    ...(error !== undefined && { error }),
    ...(error !== undefined && errorSource !== null && { errorSource }),
    ...(targeting !== undefined && { targeting }),
  };
}

describe('classifySelectorForm (§5.3)', () => {
  it('every row of the table', () => {
    const rows: Array<[string, string]> = [
      ['role=button[name="Join"]', 'role'],
      ['[role="button"][name="Join"]', 'css-role-name'],
      ['[role="listbox"] [role="option"]:text-is("Mr")', 'text-is'],
      ['button:has-text("Continue")', 'has-text'],
      ['text=Log in', 'text-engine'],
      ['[data-testid="submit"]', 'testid'],
      ['[aria-label="Close dialog"]', 'aria-label'],
      ['#login-btn', 'id'],
      ['input[name="email"]', 'name-attr'],
      ['a[href="/pricing"]', 'href'],
      ['ul.results > li:nth-child(3)', 'positional'],
      ['aria-ref=e12', 'ref'],
      ['.btn.btn-primary', 'css-other'],
    ];
    for (const [selector, form] of rows) {
      expect(classifySelectorForm(selector), selector).toBe(form);
    }
  });

  it('a scope in front does not change the form: the first row that fits wins', () => {
    expect(classifySelectorForm('#nav >> role=link[name="New"]')).toBe('role');
    expect(classifySelectorForm('nav >> role=link[name="New"]')).toBe('role');
    expect(classifySelectorForm('[data-testid="menu"] >> text=Edit')).toBe('text-engine');
    expect(classifySelectorForm('#form input[name="email"]')).toBe('id');
    expect(classifySelectorForm('button:has-text("Save") >> nth=0')).toBe('has-text');
  });

  it('the other spellings each row covers', () => {
    const rows: Array<[string, string]> = [
      ['internal:role=button[name="Join"i]', 'role'],
      ['[role=button][name=Join]', 'css-role-name'],
      ['a[name="x"][role="button"]', 'css-role-name'],
      ['button[role="tab"][aria-selected="true"][name="t1"]', 'css-role-name'],
      ['text="Log in"', 'text-engine'],
      ['form >> text=Submit', 'text-engine'],
      ['[data-test="save"]', 'testid'],
      ['[data-qa=save]', 'testid'],
      ['[data-cy="save"]', 'testid'],
      ['[data-test-id="save"]', 'testid'],
      ['data-testid=save', 'testid'],
      ['button[aria-label]', 'aria-label'],
      ['button#submit', 'id'],
      ['[name]', 'name-attr'],
      ['a[href^="https://"]', 'href'],
      ['tr:nth-of-type(2) td', 'positional'],
      ['li:nth-last-child(1)', 'positional'],
      ['button >> nth=1', 'positional'],
      ['xpath=//div[@class="x"]', 'css-other'],
      ['button:text("Save")', 'css-other'],
    ];
    for (const [selector, form] of rows) {
      expect(classifySelectorForm(selector), selector).toBe(form);
    }
  });

  it('quoted page text is not selector syntax', () => {
    // The `#` is part of the URL, not an id selector.
    expect(classifySelectorForm('a[href="#top"]')).toBe('href');
    // A role name with a # or a pseudo-class in it is still the role engine.
    expect(classifySelectorForm('role=button[name="#1 :text-is(x)"]')).toBe('role');
    // `role=` inside the text engine's argument is the text engine.
    expect(classifySelectorForm('text="role=button"')).toBe('text-engine');
    expect(classifySelectorForm("button:has-text('#results')")).toBe('has-text');
  });

  it('near misses fall through to the right row', () => {
    // A name attribute scoped by a role is not the look-alike.
    expect(classifySelectorForm('[role="dialog"] input[name="q"]')).toBe('name-attr');
    // aria-labelledby is not aria-label.
    expect(classifySelectorForm('[aria-labelledby="lbl"]')).toBe('css-other');
    // data-text= is an attribute, not the text engine.
    expect(classifySelectorForm('[data-text="x"]')).toBe('css-other');
    // data-testing is not a test id.
    expect(classifySelectorForm('[data-testing="x"]')).toBe('css-other');
    // Attribute names are case-insensitive in HTML CSS.
    expect(classifySelectorForm('[ARIA-LABEL="Close"]')).toBe('aria-label');
  });

  it('null when there is no selector', () => {
    expect(classifySelectorForm(undefined)).toBeNull();
    expect(classifySelectorForm(null)).toBeNull();
    expect(classifySelectorForm('')).toBeNull();
    expect(classifySelectorForm('   ')).toBeNull();
  });
});

describe('actionSelector: where an action keeps its selector', () => {
  const act = (a: Partial<AIAction> & { action: string }) => ({ description: 'x', ...a }) as AIAction;

  it('`selector`, for everything but a wait', () => {
    expect(actionSelector(act({ action: 'click', selector: '#go' }))).toBe('#go');
    expect(actionSelector(act({ action: 'click', selector: '  ' }))).toBeUndefined();
    expect(actionSelector(act({ action: 'navigate', url: 'https://x.test' }))).toBeUndefined();
  });

  it('a wait on an element keeps it in `condition` (prompt rule 12); an attribute wait in `selector`', () => {
    for (const waitType of ['selector', 'hidden', 'count'] as const) {
      expect(actionSelector(act({ action: 'wait', waitType, condition: 'role=dialog' })), waitType).toBe('role=dialog');
    }
    expect(actionSelector(act({ action: 'wait', waitType: 'attribute', selector: '#save', condition: '!disabled' }))).toBe('#save');
    // `executeWait` falls back to the condition when an attribute wait names no selector.
    expect(actionSelector(act({ action: 'wait', waitType: 'attribute', condition: '#save' }))).toBe('#save');
  });

  it('a wait that targets no element has none, and an untyped one is not guessed at', () => {
    for (const waitType of ['url', 'text', 'duration', 'load', 'navigation', 'stable'] as const) {
      expect(actionSelector(act({ action: 'wait', waitType, condition: '**/join' })), waitType).toBeUndefined();
    }
    expect(actionSelector(act({ action: 'wait', condition: '#spinner' }))).toBeUndefined();
  });
});

/** Real error text, verbatim — see the file header for how it was captured. */
const REAL = {
  clickNoMatch: "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#nope').filter({ visible: true }).first()\u001b[22m\n",
  clickNoMatchMeasured: "locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#nope').filter({ visible: true }).first() to be visible\u001b[22m\n",
  // Issue 062's trap: the label sits in a child <span>, so :text-is matches nothing.
  clickTextIsNested: "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('[role=\"option\"]:text-is(\"Mr\")').filter({ visible: true }).first()\u001b[22m\n",
  clickCssRoleName: "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('[role=\"button\"][name=\"Join\"]').filter({ visible: true }).first()\u001b[22m\n",
  // display:none — the visible=true filter never resolves it.
  clickHidden: "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#hidden').filter({ visible: true }).first()\u001b[22m\n",
  hoverNoMatch: "locator.hover: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#nope').filter({ visible: true }).first()\u001b[22m\n",
  waitSelectorNever: "page.waitForSelector: Timeout 1000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#nope') to be visible\u001b[22m\n",
  getByRoleNoMatch: "locator.click: Timeout 1000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Nope' })\u001b[22m\n",
  frameLocatorNoMatch: "locator.click: Timeout 1000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#nope-frame').contentFrame().locator('button')\u001b[22m\n",
  clickBlocked: "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#covered').filter({ visible: true }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button id=\"covered\">Covered</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is visible, enabled and stable\u001b[22m\n\u001b[2m      - scrolling into view if needed\u001b[22m\n\u001b[2m      - done scrolling\u001b[22m\n\u001b[2m      - <div id=\"overlay\"></div> intercepts pointer events\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is visible, enabled and stable\u001b[22m\n\u001b[2m      - scrolling into view if needed\u001b[22m\n\u001b[2m      - done scrolling\u001b[22m\n\u001b[2m      - <div id=\"overlay\"></div> intercepts pointer events\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    19 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m       - element is visible, enabled and stable\u001b[22m\n\u001b[2m       - scrolling into view if needed\u001b[22m\n\u001b[2m       - done scrolling\u001b[22m\n\u001b[2m       - <div id=\"overlay\"></div> intercepts pointer events\u001b[22m\n\u001b[2m     - retrying click action\u001b[22m\n\u001b[2m       - waiting 500ms\u001b[22m\n",
  clickInvalidSpaceScope: "locator.click: Unexpected token \"=\" while parsing css selector \"nav role=link[name=\"New\"]\". Did you mean to CSS.escape it?\nCall log:\n\u001b[2m  - waiting for nav role=link[name=\"New\"] >> visible=true >> nth=0\u001b[22m\n",
  clickUnknownEngine: "locator.click: Unknown engine \"foo\" while parsing selector foo=bar >> visible=true >> nth=0\nCall log:\n\u001b[2m  - waiting for locator('foo=bar').filter({ visible: true }).first()\u001b[22m\n",
  clickBadAttr: "locator.click: Unexpected token \"\" while parsing css selector \"button[name=\"x\"\". Did you mean to CSS.escape it?\nCall log:\n\u001b[2m  - waiting for button[name=\"x\" >> visible=true >> nth=0\u001b[22m\n",
  countUnterminatedRole: "locator.count: InvalidSelectorError: Unexpected end of selector while parsing selector `button[name=`\n    at syntaxError (<anonymous>:1747:13)\n    at readAttribute (<anonymous>:1880:7)\n    at parseAttributeSelector (<anonymous>:1893:28)\n    at Object.queryAll (<anonymous>:4971:22)\n    at InjectedScript._queryEngineAll (<anonymous>:6645:49)\n    at InjectedScript.querySelectorAll (<anonymous>:6632:30)\n    at eval (eval at evaluate (:302:30), <anonymous>:2:33)\n    at UtilityScript.evaluate (<anonymous>:304:16)\n    at UtilityScript.<anonymous> (<anonymous>:1:44)",
  countBadCssId: "locator.count: SyntaxError: Failed to execute 'querySelectorAll' on 'Document': '#123' is not a valid selector.\n    at query (<anonymous>:5261:41)\n    at <anonymous>:5271:7\n    at SelectorEvaluatorImpl._cached (<anonymous>:5048:20)\n    at SelectorEvaluatorImpl._queryCSS (<anonymous>:5258:17)\n    at SelectorEvaluatorImpl._querySimple (<anonymous>:5138:19)\n    at <anonymous>:5086:29\n    at SelectorEvaluatorImpl._cached (<anonymous>:5048:20)\n    at SelectorEvaluatorImpl.query (<anonymous>:5079:19)\n    at Object.query (<anonymous>:5293:44)\n    at <anonymous>:5251:21",
  countBadXpath: "locator.count: SyntaxError: Failed to execute 'evaluate' on 'Document': The string '//div[' is not a valid XPath expression.\n    at Object.queryAll (<anonymous>:5935:25)\n    at InjectedScript._queryEngineAll (<anonymous>:6645:49)\n    at InjectedScript.querySelectorAll (<anonymous>:6632:30)\n    at eval (eval at evaluate (:302:30), <anonymous>:2:33)\n    at UtilityScript.evaluate (<anonymous>:304:16)\n    at UtilityScript.<anonymous> (<anonymous>:1:44)",
  domQuerySelectorAll: "page.evaluate: SyntaxError: Failed to execute 'querySelectorAll' on 'Document': 'nav role=link[name=\"New\"]' is not a valid selector.\n    at eval (eval at evaluate (:302:30), <anonymous>:1:14)\n    at UtilityScript.evaluate (<anonymous>:304:16)\n    at UtilityScript.<anonymous> (<anonymous>:1:44)",
  strictMode: "locator.click: Error: strict mode violation: locator('button.dup') resolved to 2 elements:\n    1) <button class=\"dup\">Dup A</button> aka getByRole('button', { name: 'Dup A' })\n    2) <button class=\"dup\">Dup B</button> aka getByRole('button', { name: 'Dup B' })\n\nCall log:\n\u001b[2m  - waiting for locator('button.dup')\u001b[22m\n",
  strictModeGetByRole: "locator.click: Error: strict mode violation: getByRole('button', { name: 'Save' }) resolved to 2 elements:\n    1) <button>Save</button> aka getByRole('button', { name: 'Save' }).first()\n    2) <button>Save</button> aka getByRole('button', { name: 'Save' }).nth(1)\n\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Save' })\u001b[22m\n",
  // The framework's own refusal under browser.ambiguousTarget: 'fail'.
  ambiguityGate: "2 visible elements matched \"button.dup\" — use a more specific selector (browser.ambiguousTarget is \"fail\")",
  clickDisabled: "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#disabled').filter({ visible: true }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled id=\"disabled\">Disabled</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    19 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m       - element is not enabled\u001b[22m\n\u001b[2m     - retrying click action\u001b[22m\n\u001b[2m       - waiting 500ms\u001b[22m\n",
  selectMissingOption: "locator.selectOption: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#title').filter({ visible: true }).first()\u001b[22m\n\u001b[2m    - locator resolved to <select id=\"title\">…</select>\u001b[22m\n\u001b[2m  - attempting select option action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible and enabled\u001b[22m\n\u001b[2m      - did not find some options\u001b[22m\n\u001b[2m    - retrying select option action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible and enabled\u001b[22m\n\u001b[2m      - did not find some options\u001b[22m\n\u001b[2m    - retrying select option action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    19 × waiting for element to be visible and enabled\u001b[22m\n\u001b[2m       - did not find some options\u001b[22m\n\u001b[2m     - retrying select option action\u001b[22m\n\u001b[2m       - waiting 500ms\u001b[22m\n",
  waitHiddenNever: "page.waitForSelector: Timeout 1000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#visible') to be hidden\u001b[22m\n\u001b[2m    7 × locator resolved to visible <p id=\"visible\">Visible</p>\u001b[22m\n",
  gotoTimeout: "page.goto: Timeout 1000ms exceeded.\nCall log:\n\u001b[2m  - navigating to \"http://127.0.0.1:47805/\", waiting until \"load\"\u001b[22m\n",
  waitForUrlTimeout: "page.waitForURL: Timeout 1000ms exceeded.\n=========================== logs ===========================\nwaiting for navigation to \"**/never\" until \"load\"\n============================================================",
  typeNotEditable: "locator.clear: Error: Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]\nCall log:\n\u001b[2m  - waiting for locator('#plain').filter({ visible: true }).first()\u001b[22m\n\u001b[2m    - locator resolved to <div id=\"plain\">Plain div</div>\u001b[22m\n\u001b[2m    - fill(\"\")\u001b[22m\n\u001b[2m  - attempting fill action\u001b[22m\n\u001b[2m    - waiting for element to be visible, enabled and editable\u001b[22m\n",
  navigateNoUrl: 'navigate action requires a url or value',
  backNoHistory: "back: the browser has no previous page in this tab's history",
  readPatternMiss: 'read pattern /\\d+/ matched nothing in "Visible"',
};

describe('classifyOutcome (§5.4)', () => {
  it('ok: no error', () => {
    expect(classifyOutcome(sub({ action: 'click', selector: '#go' }))).toBe('ok');
    expect(classifyOutcome(sub({ action: 'navigate', url: 'https://x.test' }))).toBe('ok');
  });

  it('unknown-action: the action type is not one the framework knows — by the type, not the words', () => {
    // The executor's own refusal, which is not the browser layer's.
    expect(classifyOutcome(sub({ action: 'clik' }, 'Unknown action type: "clik"', undefined, null))).toBe('unknown-action');
    expect(
      classifyOutcome(sub({ action: 'tap', selector: '#go' }, 'Unknown action type "tap" — the framework has no such action, so nothing was done on the page', undefined, null)),
    ).toBe('unknown-action');
    // A known action whose error merely SAYS it — a server's response body —
    // is not one: the type decides.
    expect(
      classifyOutcome(sub({ action: 'api_call' }, 'API call failed: 400 {"error":"unknown action type"}', undefined, null)),
    ).toBe('other');
    // The computer surface speaks another vocabulary, and refuses what it does
    // not know before anything is recorded as that type.
    expect(classifyOutcome(sub({ action: 'left_click' }, 'the window never appeared', undefined, null), 'computer')).toBe('other');
  });

  it('invalid-selector: Playwright, or the DOM, could not parse the selector', () => {
    const cases: Array<[string, string]> = [
      [REAL.clickInvalidSpaceScope, 'nav role=link[name="New"]'],
      [REAL.clickUnknownEngine, 'foo=bar'],
      [REAL.clickBadAttr, 'button[name="x"'],
      [REAL.countUnterminatedRole, 'role=button[name='],
      [REAL.countBadCssId, '#123'],
      [REAL.countBadXpath, 'xpath=//div['],
      [REAL.domQuerySelectorAll, 'nav role=link[name="New"]'],
    ];
    for (const [error, selector] of cases) {
      expect(classifyOutcome(sub({ action: 'click', selector }, error)), selector).toBe('invalid-selector');
    }
  });

  it('no-match: a timeout whose call log never resolved an element', () => {
    const cases: Array<[string, string]> = [
      [REAL.clickNoMatch, '#nope'],
      [REAL.clickNoMatchMeasured, '#nope'],
      [REAL.clickTextIsNested, '[role="option"]:text-is("Mr")'],
      [REAL.clickCssRoleName, '[role="button"][name="Join"]'],
      [REAL.clickHidden, '#hidden'],
      [REAL.hoverNoMatch, '#nope'],
    ];
    for (const [error, selector] of cases) {
      expect(classifyOutcome(sub({ action: 'click', selector }, error)), selector).toBe('no-match');
    }
  });

  it('no-match: a wait keeps its selector in `condition`, and a code step names none — the call log says an element was sought', () => {
    expect(
      classifyOutcome(sub({ action: 'wait', waitType: 'selector', condition: '#nope' }, REAL.waitSelectorNever)),
    ).toBe('no-match');
    expect(classifyOutcome(sub({ action: 'click' }, REAL.getByRoleNoMatch))).toBe('no-match');
    expect(classifyOutcome(sub({ action: 'click' }, REAL.frameLocatorNoMatch))).toBe('no-match');
  });

  it('no-match: a measured match count of 0', () => {
    expect(
      classifyOutcome(sub({ action: 'click', selector: '#gone' }, 'Element is not attached to the DOM', { matchCount: 0 })),
    ).toBe('no-match');
  });

  it('blocked: the element resolved, and another one took the click', () => {
    expect(classifyOutcome(sub({ action: 'click', selector: '#covered' }, REAL.clickBlocked))).toBe('blocked');
  });

  it('ambiguous: several matches refused — Playwright strict mode, or the framework gate', () => {
    expect(classifyOutcome(sub({ action: 'click', selector: 'button.dup' }, REAL.strictMode))).toBe('ambiguous');
    expect(classifyOutcome(sub({ action: 'click' }, REAL.strictModeGetByRole))).toBe('ambiguous');
    expect(
      classifyOutcome(sub({ action: 'click', selector: 'button.dup' }, REAL.ambiguityGate, { visibleMatchCount: 2 })),
    ).toBe('ambiguous');
  });

  it('timeout: any other timeout — the element was found, or no element was sought', () => {
    // Resolved, then never enabled / never had the option / never went away.
    expect(classifyOutcome(sub({ action: 'click', selector: '#disabled' }, REAL.clickDisabled))).toBe('timeout');
    expect(classifyOutcome(sub({ action: 'select', selector: '#title' }, REAL.selectMissingOption))).toBe('timeout');
    expect(
      classifyOutcome(sub({ action: 'wait', waitType: 'hidden', condition: '#visible' }, REAL.waitHiddenNever)),
    ).toBe('timeout');
    // No selector anywhere: a navigation running out of time matched nothing
    // because it looked for nothing.
    expect(classifyOutcome(sub({ action: 'navigate', url: 'http://127.0.0.1:47805/' }, REAL.gotoTimeout))).toBe('timeout');
    expect(classifyOutcome(sub({ action: 'wait', waitType: 'url', condition: '**/never' }, REAL.waitForUrlTimeout))).toBe('timeout');
    // The framework's own poll names its error the same way.
    expect(
      classifyOutcome(
        sub({ action: 'wait', waitType: 'count', condition: '#list li' }, 'Timeout 10000ms exceeded waiting for #list li to match at least 3 element(s)'),
      ),
    ).toBe('timeout');
  });

  it('other: anything else', () => {
    const cases: Array<[Partial<AIAction> & { action: string }, string]> = [
      [{ action: 'type', selector: '#plain' }, REAL.typeNotEditable],
      [{ action: 'navigate' }, REAL.navigateNoUrl],
      [{ action: 'back' }, REAL.backNoHistory],
      [{ action: 'read', selector: '#visible' }, REAL.readPatternMiss],
      [{ action: 'click', selector: '#go' }, ''],
    ];
    for (const [action, error] of cases) {
      expect(classifyOutcome(sub(action, error)), error).toBe('other');
    }
  });

  it('assert-failed: an assertion that evaluated false — whatever page text its error quotes', () => {
    expect(
      classifyOutcome(sub({ action: 'assert', condition: 'the total is 3' }, 'Assertion failed: Total shows 3 — got "2"', undefined, null)),
    ).toBe('assert-failed');
    // The page said "timed out"; the assertion is what failed, not a wait.
    expect(
      classifyOutcome(
        sub({ action: 'assert', condition: 'the banner says Saved' }, 'Assertion failed: Banner — got "Session timed out. Timeout 30000ms exceeded."', undefined, null),
      ),
    ).toBe('assert-failed');
    // A computer-surface verdict is the model's judgement of the screen, and a
    // `holds: false` there is a verdict — not a concession.
    expect(
      classifyOutcome(
        sub({ action: 'assert', condition: 'the result is 2', holds: false, evidence: 'strict mode violation on screen' } as never, 'Assertion failed: strict mode violation on screen', undefined, null),
        'computer',
      ),
    ).toBe('assert-failed');
  });

  it('conceded: the model reported the step cannot be done — nothing evaluated it', () => {
    expect(
      classifyOutcome(
        sub(
          { action: 'assert', holds: false, evidence: 'the page has no Title list; the click timed out' } as never,
          'The model reported that this step cannot be done: the page has no Title list; the click timed out',
          undefined,
          null,
        ),
      ),
    ).toBe('conceded');
  });

  it('never reads Playwright\'s wording off text Playwright did not write', () => {
    // Each of these would match a Playwright pattern if its text were read:
    // an API's body, the author's `fail` message, the model's structure answer
    // quoted in a readTable refusal, a desktop action's message.
    const cases: Array<[Partial<AIAction> & { action: string }, string, 'computer' | undefined]> = [
      [{ action: 'api_call' }, 'API call failed: 504 Gateway Timeout — upstream timed out', undefined],
      [{ action: 'fail' }, 'Timeout 5000ms exceeded waiting for the refund', undefined],
      [{ action: 'return' }, 'this step does not say to return — strict mode violation', undefined],
      [
        { action: 'readTable', selector: '#grid' },
        'No table found under "#grid". The model was asked about the region\'s structure and answered: none — the grid timed out while parsing selector',
        undefined,
      ],
      [{ action: 'openPage' }, 'openPage failed: no "url" field specified', undefined],
      [{ action: 'wait_window' }, 'waiting for selector "Save As" timed out', 'computer'],
    ];
    for (const [action, error, surface] of cases) {
      expect(classifyOutcome(sub(action, error, undefined, null), surface), error).toBe('other');
    }
    // The same text, from the browser action layer, IS read.
    expect(
      classifyOutcome(sub({ action: 'wait', waitType: 'url', condition: '**/done' }, 'page.waitForURL: Timeout 1000ms exceeded.')),
    ).toBe('timeout');
  });

  it('reads the verdict from the first line, so the selector quoted in the call log cannot fake one', () => {
    // A resolved element that could not be typed into, whose selector happens
    // to say "timed-out": still `other`, not a timeout.
    const error = REAL.typeNotEditable.replaceAll('#plain', '#timed-out-banner');
    expect(classifyOutcome(sub({ action: 'type', selector: '#timed-out-banner' }, error))).toBe('other');
  });

  it('works with or without the ANSI codes', () => {
    const plain = REAL.clickBlocked.replace(/\u001b\[[0-9;]*m/g, '');
    expect(classifyOutcome(sub({ action: 'click', selector: '#covered' }, plain))).toBe('blocked');
    const plainNoMatch = REAL.clickNoMatch.replace(/\u001b\[[0-9;]*m/g, '');
    expect(classifyOutcome(sub({ action: 'click', selector: '#nope' }, plainNoMatch))).toBe('no-match');
  });
});

describe('classifyOutcome against a live Chromium page', () => {
  const PAGE = `<!doctype html><html><body>
<ul role="listbox" aria-label="Title">
  <li role="option"><span><div><span>Mr</span></div></span></li>
</ul>
<div style="position:relative">
  <button id="covered">Covered</button>
  <div style="position:absolute;inset:0;width:300px;height:60px"></div>
</div>
<button class="dup">A</button><button class="dup">B</button>
</body></html>`;

  let browser: Browser;
  let hang: http.Server;
  let hangUrl: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // Accepts and never answers: a real navigation timeout.
    hang = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', () => resolve()));
    hangUrl = `http://127.0.0.1:${(hang.address() as { port: number }).port}/`;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => hang?.close(resolve));
  });

  async function page(): Promise<Page> {
    const p = await browser.newPage();
    await p.setContent(PAGE);
    return p;
  }

  /** What `executeClick` does, with a short budget instead of its 10 s. */
  async function clickError(selector: string): Promise<string> {
    const p = await page();
    try {
      await p.locator(selector).locator('visible=true').first().click({ timeout: 500 });
      return 'no error';
    } catch (err) {
      return (err as Error).message;
    } finally {
      await p.close();
    }
  }

  it('reproduces each headline outcome from what Playwright says today', async () => {
    const [textIs, blocked, strict, invalid, gate, nav] = await Promise.all([
      clickError('[role="option"]:text-is("Mr")'),
      clickError('#covered'),
      page().then(async (p) => {
        try {
          await p.locator('button.dup').click({ timeout: 500 });
          return 'no error';
        } catch (err) {
          return (err as Error).message;
        } finally {
          await p.close();
        }
      }),
      page().then(async (p) => {
        const result = await executeAction(p, { action: 'click', selector: 'nav role=link[name="New"]', description: 'x' });
        await p.close();
        return result.error ?? 'no error';
      }),
      page().then(async (p) => {
        const result = await executeAction(
          p,
          { action: 'click', selector: 'button.dup', description: 'x' },
          undefined,
          undefined,
          { ambiguousTarget: 'fail' },
        );
        await p.close();
        return result.error ?? 'no error';
      }),
      page().then(async (p) => {
        try {
          await p.goto(hangUrl, { timeout: 500 });
          return 'no error';
        } catch (err) {
          return (err as Error).message;
        } finally {
          await p.close();
        }
      }),
    ]);

    expect(classifyOutcome(sub({ action: 'click', selector: '[role="option"]:text-is("Mr")' }, textIs))).toBe('no-match');
    expect(classifyOutcome(sub({ action: 'click', selector: '#covered' }, blocked))).toBe('blocked');
    expect(classifyOutcome(sub({ action: 'click', selector: 'button.dup' }, strict))).toBe('ambiguous');
    expect(classifyOutcome(sub({ action: 'click', selector: 'nav role=link[name="New"]' }, invalid))).toBe('invalid-selector');
    expect(classifyOutcome(sub({ action: 'click', selector: 'button.dup' }, gate))).toBe('ambiguous');
    expect(classifyOutcome(sub({ action: 'navigate', url: hangUrl }, nav))).toBe('timeout');
  }, 30_000);
});
