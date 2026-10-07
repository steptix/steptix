import { CODE, TEMPLATE, consumeString, consumeTemplate, scan } from './tokenizer.js';

/**
 * Does a code-behind entry ACT on the page, or only read it?
 * (docs/specs/SPEC-codebehind-robustness.md §6.3)
 *
 * One answer for three askers, which is why it lives here rather than in
 * `generate.ts`: the runtime imports it too.
 *
 *  - Generation's unwaited-read check fires only on a read that comes AFTER an
 *    action. A read-only entry has nothing to wait for.
 *  - The runtime waits for what an acting entry's action caused (§6.4) and
 *    skips that wait for a read-only one.
 *  - A failed `step.check` heals only in an entry that takes no action (§6.5):
 *    a heal re-runs the step under AI, and after a click that can submit twice.
 *
 * The third is why every doubt resolves to "acts". A call this module does
 * not know — a helper the entry or its file defines, a method on an object it
 * imported — may do any of the things below, so it counts. Misreading a
 * read-only entry as acting costs a short wait and a step that fails instead
 * of healing, which is today's behaviour; misreading an acting one as
 * read-only could click twice.
 *
 * What counts:
 *  - page and locator actions: `click`, `fill`, `press`, `check`, `focus`, …;
 *  - navigation: `goto`, `reload`, `goBack`, `goForward`;
 *  - anything through `keyboard`, `mouse` or `touchscreen`;
 *  - `tabs` and `browsers` calls that open, switch or close;
 *  - `page.request.*` and `context.request.*`;
 *  - `evaluate` and its kin, which can change the page;
 *  - the DOM's own mutators, inside a page function;
 *  - any call it does not recognise.
 *
 * Read off the code with strings, comments and regex literals blanked — so
 * `getByRole('button', { name: 'Click' })` is not a click — but with a template
 * literal's `${…}` expressions kept, since a call can hide there.
 *
 * At run time the code is `String(entry.run)`: the bundled function's own
 * text, types stripped. A helper defined elsewhere in the file is then visible
 * only as its call, which is enough — an unknown call counts.
 */

/** Why a call counts as acting. */
export type ActingKind =
  | 'action'
  | 'navigation'
  | 'input'
  | 'tabs'
  | 'request'
  | 'evaluate'
  | 'unknown';

export interface ActingCall {
  /** Where the called name starts in the code. */
  index: number;
  /** The call as written, whitespace dropped: `.click(`, `keyboard.press(`,
   *  `tabs.open(`, `signIn(`. What a complaint quotes. */
  call: string;
  kind: ActingKind;
}

/** Playwright and DOM calls that change the page. */
const PAGE_ACTIONS = new Set([
  'click', 'dblclick', 'tap', 'hover', 'fill', 'clear', 'press', 'pressSequentially',
  'type', 'check', 'uncheck', 'setChecked', 'selectOption', 'selectText', 'setInputFiles',
  'dragTo', 'dragAndDrop', 'dispatchEvent', 'focus', 'blur', 'scrollIntoViewIfNeeded',
  'setContent', 'close',
  // The DOM's own, inside a page function.
  'submit', 'requestSubmit', 'reset', 'select', 'remove', 'removeChild', 'append',
  'appendChild', 'prepend', 'insertBefore', 'insertAdjacentHTML', 'insertAdjacentElement',
  'insertAdjacentText', 'replaceWith', 'replaceChildren', 'setAttribute', 'removeAttribute',
  'toggleAttribute', 'setSelectionRange', 'setRangeText', 'showModal', 'showPicker',
  'execCommand', 'scrollIntoView', 'scrollTo', 'scrollBy', 'pushState', 'replaceState',
]);

const NAVIGATION = new Set(['goto', 'reload', 'goBack', 'goForward']);

/** Code the PAGE runs, which can change it. */
const EVALUATE = new Set([
  'evaluate', 'evaluateHandle', 'evaluateAll', '$eval', '$$eval',
  'addScriptTag', 'addInitScript', 'addStyleTag', 'exposeFunction', 'exposeBinding',
]);

/** The objects every call through which drives a real input device. */
const INPUT_DEVICES = new Set(['keyboard', 'mouse', 'touchscreen']);

/** `tabs` / `browsers` calls that change which page the run is on, and the
 *  ones that only answer a question about it. */
const TAB_MOVES = new Set(['open', 'openedBy', 'switchTo', 'close']);
const TAB_READS = new Set(['list', 'active', 'activeLabel']);

/** `page.request` / `context.request` calls — an HTTP request in the page's
 *  session, which can change what the page shows next. */
const HTTP_CALLS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

/**
 * Methods that read, wait, build a locator or compute — on a Playwright
 * object, on the step API, or in plain JavaScript (including a page
 * function's DOM reads). Matched by name whatever the receiver: the acting
 * rules above are asked first.
 */
const SAFE_METHODS = new Set([
  // Playwright: locators, reads, waits, listeners.
  'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId',
  'getByAltText', 'getByTitle', 'frameLocator', 'contentFrame', 'owner', 'filter', 'first',
  'last', 'nth', 'and', 'or', 'all', 'count', 'textContent', 'innerText', 'innerHTML',
  'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled',
  'isChecked', 'isEditable', 'allTextContents', 'allInnerTexts', 'boundingBox', 'title',
  'url', 'content', 'waitFor', 'waitForSelector', 'waitForFunction', 'waitForURL',
  'waitForLoadState', 'waitForTimeout', 'waitForResponse', 'waitForRequest', 'waitForEvent',
  'frames', 'mainFrame', 'frame', 'childFrames', 'parentFrame', 'name', '$', '$$',
  'ariaSnapshot', 'jsonValue', 'elementHandle', 'elementHandles', 'isClosed', 'viewportSize',
  'pages', 'context', 'browser', 'opener', 'cookies', 'storageState', 'screenshot',
  'on', 'once', 'off', 'removeListener', 'addListener',
  // Responses and requests.
  'status', 'ok', 'json', 'text', 'body', 'headers', 'headerValue', 'allHeaders', 'method',
  'postData', 'postDataJSON', 'response', 'request', 'resourceType', 'failure', 'timing',
  'statusText', 'isNavigationRequest',
  // The step API and the log. `step.check` is decided by its receiver, below.
  'getVar', 'setVar', 'expect', 'fail', 'exit', 'filePath', 'settle', 'read',
  'info', 'warn', 'error', 'debug', 'log', 'trace',
  // Strings, numbers, regexes.
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'toLocaleLowerCase',
  'toLocaleUpperCase', 'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf',
  'slice', 'substring', 'substr', 'split', 'replace', 'replaceAll', 'match', 'matchAll',
  'search', 'padStart', 'padEnd', 'repeat', 'concat', 'at', 'charAt', 'charCodeAt',
  'codePointAt', 'localeCompare', 'normalize', 'toString', 'valueOf', 'toJSON', 'test',
  'exec', 'toFixed', 'toPrecision', 'toLocaleString', 'isInteger', 'isFinite', 'isNaN',
  'isSafeInteger', 'parseFloat', 'parseInt',
  // Arrays, maps, sets, objects.
  'map', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'reduce',
  'reduceRight', 'forEach', 'flat', 'flatMap', 'join', 'sort', 'toSorted', 'reverse',
  'toReversed', 'push', 'pop', 'shift', 'unshift', 'splice', 'toSpliced', 'keys', 'values',
  'entries', 'from', 'isArray', 'of', 'with', 'has', 'set', 'add', 'delete', 'assign',
  'freeze', 'fromEntries', 'hasOwn', 'hasOwnProperty', 'getOwnPropertyNames', 'create',
  'stringify', 'parse',
  // Math, promises, dates, functions, Intl.
  'max', 'min', 'abs', 'round', 'floor', 'ceil', 'trunc', 'sign', 'pow', 'sqrt', 'random',
  'resolve', 'reject', 'race', 'allSettled', 'any', 'then', 'catch', 'finally',
  'now', 'getTime', 'toISOString', 'toLocaleDateString', 'toLocaleTimeString', 'toDateString',
  'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
  'getMilliseconds', 'getTimezoneOffset', 'setFullYear', 'setMonth', 'setDate', 'setHours',
  'setMinutes', 'setSeconds', 'setMilliseconds', 'setTime', 'UTC',
  'call', 'apply', 'bind',
  'format', 'formatToParts', 'resolvedOptions', 'NumberFormat', 'DateTimeFormat', 'Collator',
  'PluralRules', 'RelativeTimeFormat', 'ListFormat',
  // A page function's DOM reads.
  'querySelector', 'querySelectorAll', 'closest', 'matches', 'contains', 'getElementById',
  'getElementsByClassName', 'getElementsByTagName', 'getElementsByName', 'hasAttribute',
  'getAttributeNames', 'getBoundingClientRect', 'getClientRects', 'getComputedStyle',
  'getPropertyValue', 'checkVisibility', 'item', 'namedItem', 'cloneNode', 'isEqualNode',
  'compareDocumentPosition', 'elementFromPoint', 'elementsFromPoint', 'getSelection',
  'hasChildNodes', 'getRootNode',
]);

/** Functions called bare that change nothing. */
const SAFE_FUNCTIONS = new Set([
  'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Array', 'Object', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'queueMicrotask', 'requestAnimationFrame', 'getComputedStyle',
  // A Promise executor's own two.
  'resolve', 'reject',
  // Playwright's web-first assertion, and the step API destructured.
  'expect', 'getVar', 'setVar', 'filePath',
]);

/** Constructors that build a value and touch nothing. */
const SAFE_CONSTRUCTORS = new Set([
  'Promise', 'URL', 'URLSearchParams', 'RegExp', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Date',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Array', 'Object', 'Number', 'String',
  'Boolean', 'TextEncoder', 'TextDecoder', 'AbortController', 'DOMParser',
]);

/** Words that put a `(` after themselves without calling anything. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'void',
  'delete', 'in', 'of', 'instanceof', 'yield', 'do', 'else', 'case', 'throw', 'async',
  'super', 'with', 'new', 'try', 'finally', 'let', 'const', 'var', 'class', 'extends',
  'export', 'default', 'this', 'static', 'get', 'set',
]);

/** The entry's own function keys: `run(…): Promise<void> {` defines, never calls. */
const ENTRY_KEYS = new Set(['run', 'condition']);

/**
 * Every call in `code` that counts as acting, in source order.
 */
export function actingCalls(code: string): ActingCall[] {
  // A spread's dots are not member access: `...String(x)` calls `String`.
  const text = codeText(code).replace(/\.\.\./g, '   ');
  const out: ActingCall[] = [];

  // Member calls: `<receiver>.name(`.
  for (const m of text.matchAll(/(\??\.)\s*([A-Za-z_$][\w$]*)/g)) {
    const name = m[2]!;
    const nameAt = m.index! + m[0].length - name.length;
    if (callParenAfter(text, nameAt + name.length) < 0) continue;
    const dot = m.index! + (m[1] === '?.' ? 1 : 0);
    const chain = receiverChain(text, dot);
    const kind = memberKind(chain, name);
    if (kind === undefined) continue;
    const last = lastSegment(chain);
    const qualified = kind === 'input' || kind === 'tabs' || kind === 'request';
    out.push({ index: nameAt, call: `${qualified && last ? last : ''}.${name}(`, kind });
  }

  // Bare calls: `name(`, `new Name(`.
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) {
    const name = m[1]!;
    const at = m.index!;
    if (KEYWORDS.has(name)) continue;
    const paren = callParenAfter(text, at + name.length);
    if (paren < 0) continue;
    const before = text.slice(Math.max(0, at - 12), at);
    // `function name(` / `function* name(` declares.
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;
    if (isDefinition(text, paren, name)) continue;
    if (/(?:^|[^\w$])new\s*$/.test(before)) {
      if (SAFE_CONSTRUCTORS.has(name)) continue;
      out.push({ index: at, call: `new ${name}(`, kind: 'unknown' });
      continue;
    }
    if (SAFE_FUNCTIONS.has(name)) continue;
    out.push({ index: at, call: `${name}(`, kind: 'unknown' });
  }

  return out.sort((a, b) => a.index - b.index);
}

/** True when the entry's code makes any call {@link actingCalls} counts. */
export function entryActs(code: string): boolean {
  return actingCalls(code).length > 0;
}

/**
 * {@link entryActs} for an entry's function, read once per function: the
 * runtime asks it of the same entry on every run of a loop body.
 */
const actsCache = new WeakMap<object, boolean>();
export function entryFunctionActs(fn: (...args: never[]) => unknown): boolean {
  const known = actsCache.get(fn);
  if (known !== undefined) return known;
  const acts = entryActs(String(fn));
  actsCache.set(fn, acts);
  return acts;
}

/** Why `<chain>.name(` counts, or undefined when it does not. */
function memberKind(chain: string, name: string): ActingKind | undefined {
  const last = lastSegment(chain);
  if (last !== undefined && INPUT_DEVICES.has(last)) return 'input';
  if (last === 'tabs' || last === 'browsers') {
    if (TAB_MOVES.has(name)) return 'tabs';
    if (TAB_READS.has(name)) return undefined;
    return 'unknown';
  }
  if (last === 'request' && HTTP_CALLS.has(name)) return 'request';
  // The self-check (§6.5) and the step API's own reads are not actions, even
  // where their names are: `step.check(…)` is not a checkbox.
  if (name === 'check' && isStepReceiver(chain)) return undefined;
  if (NAVIGATION.has(name)) return 'navigation';
  if (EVALUATE.has(name)) return 'evaluate';
  if (PAGE_ACTIONS.has(name)) return 'action';
  if (SAFE_METHODS.has(name)) return undefined;
  return 'unknown';
}

/** `step`, `ctx.step` — the step API, however it was reached. */
function isStepReceiver(chain: string): boolean {
  return /(?:^|\.)\s*step$/.test(chain.trim());
}

/** The last bare identifier of a member chain — `keyboard` in `page.keyboard`
 *  — or undefined when the chain ends in a call or an index. */
function lastSegment(chain: string): string | undefined {
  return /(?:^|\.)\s*([A-Za-z_$][\w$]*)\s*$/.exec(chain)?.[1];
}

/**
 * Where the `(` that calls the name ending at `from` is, or -1 when the name
 * is not called. Skips whitespace, an optional-call `?.`, and a TypeScript
 * type-argument list (`evaluateHandle<HTMLElement>(`) — read as one only when
 * it holds nothing a comparison would (`a < b && c > (d)` stays a comparison).
 */
function callParenAfter(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] === '<') {
    let depth = 0;
    let k = i;
    for (; k < text.length; k++) {
      const c = text[k]!;
      if (c === '<') depth++;
      else if (c === '>') {
        if (--depth === 0) break;
      } else if (!/[\w$.,[\]\s|]/.test(c)) return -1;
    }
    if (k >= text.length || text.slice(i, k).includes('||')) return -1;
    i = k + 1;
    while (i < text.length && /\s/.test(text[i]!)) i++;
  }
  if (text[i] === '?' && text[i + 1] === '.') {
    i += 2;
    while (i < text.length && /\s/.test(text[i]!)) i++;
  }
  return text[i] === '(' ? i : -1;
}

/**
 * Is the `name(` whose `(` is at `paren` a definition — a method in an object
 * literal or a class, a getter, the entry's own `run` — rather than a call?
 * A call is never followed by a block; a definition always is. The entry's own
 * keys may carry a return type first (`run(…): Promise<void> {`).
 */
function isDefinition(text: string, paren: number, name: string): boolean {
  const close = matchClose(text, paren);
  if (close < 0) return false;
  let k = close + 1;
  while (k < text.length && /\s/.test(text[k]!)) k++;
  if (text[k] === '{') return true;
  return text[k] === ':' && ENTRY_KEYS.has(name);
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function matchClose(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k;
  }
  return -1;
}

/**
 * The receiver chain of the member access whose `.` is at `dot`, read
 * backwards over identifiers, `.` / `?.`, a TypeScript `!`, and balanced
 * `( )` / `[ ]` groups: `page.keyboard` for `page.keyboard.press(`,
 * `page.locator('#a')` for `page.locator('#a').click(`.
 */
function receiverChain(text: string, dot: number): string {
  let i = dot - 1;
  const skipSpace = (): void => {
    while (i >= 0 && /\s/.test(text[i]!)) i--;
  };
  if (text[i] === '?') i--;
  skipSpace();
  for (;;) {
    while (i >= 0 && text[i] === '!') i--;
    const c = text[i];
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '[';
      let depth = 0;
      for (; i >= 0; i--) {
        if (text[i] === c) depth++;
        else if (text[i] === open && --depth === 0) break;
      }
      i--;
    } else if (c !== undefined && /[\w$]/.test(c)) {
      while (i >= 0 && /[\w$]/.test(text[i]!)) i--;
    } else {
      break;
    }
    skipSpace();
    if (text[i] === '.') {
      i--;
      if (text[i] === '?') i--;
      skipSpace();
      continue;
    }
    if ((c === ')' || c === ']') && i >= 0 && /[\w$)\]]/.test(text[i]!)) continue;
    break;
  }
  return text.slice(i + 1, dot).replace(/\?\s*$/, '').trim();
}

/**
 * `code` with every string, comment and regex literal blanked to spaces —
 * line breaks kept, so positions and lines still line up — but with each
 * template literal's `${…}` expressions kept as code, recursively.
 *
 * Exported for the checks that pair a call with what comes after it
 * (`unwaitedReadComplaint`): they search this text and read positions off it.
 */
export function codeText(code: string): string {
  const s = scan(code);
  const out = new Array<string>(code.length);
  let i = 0;
  while (i < code.length) {
    const kind = s.mask[i];
    if (kind === CODE) {
      out[i] = code[i]!;
      i++;
      continue;
    }
    if (kind === TEMPLATE && code[i] === '`') {
      const end = Math.min(consumeTemplate(code, i), code.length);
      for (let k = i; k < end; k++) out[k] = code[k] === '\n' ? '\n' : ' ';
      for (const [from, to] of templateExpressions(code, i, end)) {
        const inner = codeText(code.slice(from, to));
        for (let k = 0; k < inner.length; k++) out[from + k] = inner[k]!;
      }
      i = end;
      continue;
    }
    out[i] = code[i] === '\n' ? '\n' : ' ';
    i++;
  }
  return out.join('');
}

/** The `${…}` expression spans of the template literal at [start, end). */
function templateExpressions(code: string, start: number, end: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = start + 1;
  while (i < end - 1) {
    const c = code[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '$' && code[i + 1] === '{') {
      const close = matchTemplateBrace(code, i + 1);
      if (close < 0 || close >= end) break;
      spans.push([i + 2, close]);
      i = close + 1;
      continue;
    }
    i++;
  }
  return spans;
}

/** The `}` closing the `{` at `open`, respecting literals and comments. */
function matchTemplateBrace(code: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i = consumeString(code, i);
      continue;
    }
    if (c === '`') {
      i = consumeTemplate(code, i);
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      i = nl < 0 ? code.length : nl;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      i = close < 0 ? code.length : close + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
    i++;
  }
  return -1;
}
