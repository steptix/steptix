/**
 * The two judgements an action line carries: how its selector found the
 * element (§5.3) and what became of the action (§5.4) — both taken from what
 * the run already has, and both "first rule that fits".
 */
import { isKnownActionType } from '../ai/action-parser.js';
import type { AIAction } from '../ai/types.js';
import type { StepResult, SubActionResult } from '../report/types.js';
import type { SelectorForm, StatsOutcome } from './types.js';

/**
 * The wait types that keep their element's selector in `condition` rather
 * than `selector` — prompt rule 12's shape, and the field `executeWait`
 * (src/browser/actions.ts) reads for them.
 */
const CONDITION_SELECTOR_WAITS: ReadonlySet<string> = new Set(['selector', 'hidden', 'count']);

/**
 * The selector an action targets, as the model wrote it: `selector`, or for a
 * `wait` on an element, the field `executeWait` reads the selector from —
 * `condition` for a `selector`, `hidden` or `count` wait, and `selector` then
 * `condition` for an `attribute` one. `undefined` for an action that targets
 * no element (a `navigate`, a `wait` on a URL or a duration).
 *
 * A `wait` with no `waitType` is not guessed at: `executeWait` infers one from
 * the condition's shape, and a second copy of that heuristic here is a mirror
 * that would drift. Prompt rule 12 always names the type.
 */
export function actionSelector(action: AIAction): string | undefined {
  const selector = nonBlank(action.selector);
  if (action.action !== 'wait') return selector;
  const waitType = action.waitType;
  if (waitType === 'attribute') return selector ?? nonBlank(action.condition);
  if (waitType !== undefined && CONDITION_SELECTOR_WAITS.has(waitType)) {
    return nonBlank(action.condition) ?? nonBlank(action.value) ?? selector;
  }
  return selector;
}

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The selector with the inside of every quoted string emptied:
 * `a[href="#top"]` → `a[href=""]`.
 *
 * Every rule below asks about selector SYNTAX, and a quoted value is page text:
 * the `#` in `a[href="#top"]` is not an id, and `text="role=button"` does not
 * use the role engine. An unterminated quote empties to the end, which is what
 * Playwright would make of it too.
 */
function syntaxOf(selector: string): string {
  return selector.replace(/"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)/g, (quoted) =>
    quoted[0]!.repeat(2),
  );
}

/** Starts a selector or a ` >> ` segment of one. */
const SEGMENT = String.raw`(?:^|>>)\s*`;

/**
 * §5.3's table, in its order. Tested against {@link syntaxOf}'s output.
 * Attribute names are matched case-insensitively, as CSS matches them in HTML;
 * Playwright's engine and pseudo-class names are case-sensitive, so those are
 * not.
 */
const FORM_RULES: ReadonlyArray<readonly [SelectorForm, RegExp]> = [
  ['role', new RegExp(`${SEGMENT}(?:internal:)?role=`)],
  // Both attributes in ONE compound: `[role="dialog"] input[name="q"]` is a
  // name attribute scoped by a role, not the look-alike.
  [
    'css-role-name',
    /\[\s*role\s*[~|^$*]?=[^\]]*\](?:\[[^\]]*\])*\[\s*name\s*[~|^$*]?=|\[\s*name\s*[~|^$*]?=[^\]]*\](?:\[[^\]]*\])*\[\s*role\s*[~|^$*]?=/i,
  ],
  ['text-is', /:text-is\(/],
  ['has-text', /:has-text\(/],
  ['text-engine', new RegExp(`${SEGMENT}(?:internal:)?text=`)],
  [
    'testid',
    new RegExp(String.raw`(?:\[\s*|${SEGMENT})data-(?:testid|test-id|test|qa|cy)\b|${SEGMENT}internal:testid=`, 'i'),
  ],
  // `\b` keeps `[aria-labelledby=…]` out.
  ['aria-label', /\[\s*aria-label\b/i],
  // Anything an id selector can start with, escapes and non-ASCII included.
  ['id', /#[\w\\\-\u0080-\uffff]/],
  ['name-attr', /\[\s*name\s*(?:[~|^$*]?=|\])/i],
  ['href', /\[\s*href\s*(?:[~|^$*]?=|\])/i],
  ['positional', new RegExp(String.raw`:nth-(?:last-)?(?:child|of-type)\s*\(|${SEGMENT}nth=`)],
  ['ref', new RegExp(`${SEGMENT}aria-ref=`)],
];

/**
 * How the selector found its element (§5.3), from the selector as the model
 * wrote it. The first row of the table that fits wins, so a scope in front
 * does not change the answer: `#nav >> role=link[name="New"]` is `role`.
 * `null` when there is no selector.
 */
export function classifySelectorForm(selector: string | undefined | null): SelectorForm | null {
  if (selector === undefined || selector === null) return null;
  const trimmed = selector.trim();
  if (trimmed === '') return null;
  const syntax = syntaxOf(trimmed);
  for (const [form, rule] of FORM_RULES) {
    if (rule.test(syntax)) return form;
  }
  return 'css-other';
}

/**
 * Playwright dims its call log with ANSI codes, whether or not anything is
 * listening on a terminal — the error text a run records carries them.
 */
const ANSI = /\u001b\[[0-9;]*m/g;

/** The selector could not be parsed — by Playwright's own parser, or by the
 *  DOM's when a selector reached `querySelectorAll`. */
const INVALID_SELECTOR =
  /while parsing (?:css )?selector|InvalidSelectorError|Unknown engine "|is not a valid (?:selector|XPath expression)/i;

/** A timeout, Playwright's or the framework's own (`pollUntil` names its
 *  error the same way). `timed_out` is Chromium's `net::ERR_TIMED_OUT`. */
const TIMEOUT = /\bTimeout \d+ms exceeded|timed[ _-]?out|TimeoutError/i;

/** A call log line saying the locator found an element (`locator resolved to
 *  <button …>`, `7 × locator resolved to visible <p …>`). */
const RESOLVED = /\b(?:locator|selector) resolved to\b/i;

/**
 * A call log that waited on an element. Lets an action with no `selector`
 * field — a `wait` keeps its selector in `condition` — still read as a
 * selector that matched nothing, while a navigation's timeout (`navigating to
 * …`) stays a timeout.
 */
const WAITED_ON_ELEMENT = /waiting for (?:locator|getBy[A-Za-z]+|frameLocator)\(|waiting for selector\b/;

/** Playwright's strict mode, or the framework's own refusal under
 *  `browser.ambiguousTarget: 'fail'` (src/browser/actions.ts). */
const AMBIGUOUS = /strict mode violation|resolved to \d+ elements|ambiguousTarget is "fail"/i;

/**
 * What became of one action (§5.4). First rule that fits.
 *
 * Decided by STRUCTURE first, then by text only where the text is
 * Playwright's:
 *
 * 1. No error: `ok`.
 * 2. An `assert`: `conceded` for a page-surface one carrying `"holds": false`
 *    — the model's own report that the step cannot be done, which nothing
 *    evaluated — and `assert-failed` for any other, a verdict of false. Its
 *    error quotes page text (`got "…"`) or the model's evidence, so it is
 *    never read for a pattern.
 * 3. An action type the framework does not know: `unknown-action`. Page
 *    surface only — the computer surface has a vocabulary of its own, and
 *    refuses what it does not know before anything is recorded as that type.
 * 4. An error that did not come from the browser action layer
 *    (`sub.errorSource !== 'playwright'`) is `other`: a framework refusal, an
 *    API's response, the author's `fail` message, a desktop action's message.
 *    Those are written by a page, a server, an author or a model, and matching
 *    them against Playwright's wording would file "the server said it timed
 *    out" as a selector problem.
 * 5. Playwright's own errors, from its text and — when the run measured it —
 *    how many elements the selector matched.
 *
 * In step 5 the timeout and parse rules read only the error's FIRST line.
 * Playwright puts its verdict there (`locator.click: Timeout 10000ms
 * exceeded.`) and the call log below it quotes the selector — so a selector
 * like `#timed-out-banner` would otherwise turn an unrelated failure into a
 * timeout. The call-log rules (resolved, intercepts) read the whole text,
 * because that is where those facts are.
 *
 * `surface` is the step's (`StepResult.surface`); absent means the page.
 */
export function classifyOutcome(sub: SubActionResult, surface?: StepResult['surface']): StatsOutcome {
  if (sub.error === undefined) return 'ok';
  const onComputer = surface === 'computer';

  if (sub.action.action === 'assert') {
    return !onComputer && sub.action.holds === false ? 'conceded' : 'assert-failed';
  }
  if (!onComputer && !isKnownActionType(sub.action.action)) return 'unknown-action';
  if (sub.errorSource !== 'playwright') return 'other';

  const text = sub.error.replace(ANSI, '');
  const headline = text.split('\n', 1)[0] ?? '';

  if (INVALID_SELECTOR.test(headline)) return 'invalid-selector';

  const timedOut = TIMEOUT.test(headline);
  if (sub.targeting?.matchCount === 0) return 'no-match';
  // "The selector matched nothing": the wait ran out and the call log never
  // once resolved an element. Only for an action that was looking for one —
  // `page.goto` running out of time is not a selector that matched nothing.
  // The `selector` FIELD, not `actionSelector`: a `count` or `attribute`
  // wait's timeout is the framework's own poll, which writes no call log, so
  // "never resolved" cannot be read off it — two of three rows found is still
  // a timeout. A `selector` / `hidden` wait's call log says it waited on an
  // element, which is what the second half is for.
  const hadSelector = typeof sub.action.selector === 'string' && sub.action.selector.trim() !== '';
  if (timedOut && !RESOLVED.test(text) && (hadSelector || WAITED_ON_ELEMENT.test(text))) {
    return 'no-match';
  }

  // Only ever logged after the element resolved, so the no-match rule above
  // cannot have claimed it.
  if (/intercepts pointer events/i.test(text)) return 'blocked';
  if (AMBIGUOUS.test(headline)) return 'ambiguous';
  if (timedOut) return 'timeout';
  return 'other';
}
