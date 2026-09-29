import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from 'playwright';

/** Default maximum character length for DOM snapshots (prevents token blowup).
 *  Overridable per-call via CaptureDomOptions.domSnapshotCharLimit. */
const DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT = 100_000;
/** Default maximum nesting depth for recursive iframe content capture.
 *  Overridable per-call via CaptureDomOptions.maxIframeDepth. */
const DEFAULT_MAX_IFRAME_DEPTH = 5;

/**
 * Curated allowlist of DOM attributes to emit when CaptureDomOptions
 * .useDomAttributeAllowlist is true (the default).
 *
 * Drives both:
 *  - The whole-page snapshot in capture-dom.js (substituted via
 *    `__ALLOWED_ATTRS_JSON__`).
 *  - The targeted `expand` subtree view in expandDomSubtree below.
 *
 * Both paths additionally include all `aria-*` attributes (see the runtime
 * walks in each script). expandDomSubtree also includes all `data-*`
 * attributes for full fidelity when the AI zooms in.
 *
 * Keep this list in sync with the selector hierarchy used by buildSelector
 * (data-testid > id > name > aria-label) — dropping any of those four
 * breaks selector generation downstream.
 *
 * Three of these names are state, not markup: in capture-dom.js `checked`,
 * `selected` and `value` on a form control are read from the element's live
 * IDL properties, because a click or a keystroke changes the property and
 * never the attribute. Dropping one of the three from this list would take
 * that live state out of the snapshot with it. The `expand` walk below reads
 * `value` live for the same reason — two capture tools must not disagree
 * about the same field in the same run — and `checked` / `selected` from the
 * markup, which for those two is no loss: its empty-value skip means neither
 * has ever appeared in `expand` output at all. See its getAttrs.
 */
const ALLOWED_DOM_ATTRIBUTES: readonly string[] = [
  'id', 'data-testid', 'name', 'type', 'role', 'alt', 'label',
  'placeholder', 'href', 'src', 'value', 'checked', 'selected',
  'disabled', 'readonly', 'for', 'action', 'method', 'title',
  // Upload fields: `multiple` decides whether one step can send two files,
  // and `accept` tells the model which field wants which kind of file.
  'accept', 'multiple',
  // The row numbering `readTable` leaves on a table it has read
  // (SPEC-structured-table-reads §7.4): `data-steptix-row="7"` IS the framework's
  // answer to "row 7 of the Orders table", and the allowlist would otherwise
  // drop it with the rest of the `data-*` noise — leaving the model to count
  // rows or, measured on RadGrid, to build an id from the number and act on
  // the row below. The `expand` walk already emits every `data-*`.
  'data-steptix-row',
];

/**
 * Regex source strings (no flags / no leading '/') for IDs that are almost
 * certainly framework-generated and unstable across re-renders. When
 * CaptureDomOptions.dropUnstableIds is true, an `id` attribute matching any
 * of these is omitted from the snapshot — `buildSelector` then falls back
 * through `data-testid > name > aria-label > chained nth-of-type` instead of
 * proposing a selector that won't survive the next render.
 *
 * Patterns are deliberately conservative — high precision, low recall.
 * Numeric / UUID-shaped IDs are NOT matched because they're often legitimate
 * stable database row IDs.
 *
 * Substituted into capture-dom.js as a JSON array via __UNSTABLE_ID_PATTERNS_JSON__.
 */
const UNSTABLE_ID_PATTERNS: readonly string[] = [
  // React 18 useId — lowercase: ":r0:", ":r1f:", ":rA:" (mixed-case suffix)
  '^:r[A-Za-z0-9]+:?$',
  // React server-streaming useId — uppercase: ":R0:", ":Rabc:"
  '^:R[A-Za-z0-9]+:?$',
  // Radix UI — wraps a React useId: "radix-:r3:", "radix-:r3a:"
  '^radix-:r[A-Za-z0-9]+:$',
  // Headless UI — namespaced React useId: "headlessui-listbox-button-:r0:"
  '^headlessui-[a-z-]+-:r[A-Za-z0-9]+:$',
  // MUI v4/v5 auto-generated: "mui-1", "mui-12"
  '^mui-\\d+$',
];

/** Hard timeout for the main page evaluate. Pages with stuck JS otherwise hang forever. */
const PAGE_EVALUATE_TIMEOUT_MS = 30_000;
/** Hard timeout for each iframe evaluate. Cross-origin / busy frames otherwise hang the whole capture. */
const FRAME_EVALUATE_TIMEOUT_MS = 10_000;
/** Timeout for resolving an iframe element handle. */
const IFRAME_HANDLE_TIMEOUT_MS = 5_000;

/** Thrown by evaluateWithTimeout when the race is lost. Typed so callers can
 *  tell "the page's JS thread is wedged" from "the evaluate itself threw". */
class EvaluateTimeout extends Error {}

/**
 * Run target.evaluate with a hard timeout. Playwright's evaluate has no built-in
 * timeout — if the page's JS thread is stuck (long task, infinite loop, blocking
 * sync XHR, etc.) the call blocks indefinitely. We race against a setTimeout so
 * the snapshot can degrade gracefully instead of hanging the whole runner.
 */
async function evaluateWithTimeout<T>(target: Page | Frame, script: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target.evaluate(script) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new EvaluateTimeout(`evaluate timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Capture failures
//
// The runner's capture paths report failure *in band*, as a string that takes
// the place of the content (`<error>DOM capture timed out…`, `[expand] No
// element found…`). That is right for the runner: a step that cannot read the
// DOM should degrade and let the AI try something else, not abort the run.
//
// It is wrong for a caller that hands the result to someone else, because
// "the page has no text" and "we could not read the page" become the same
// answer — and a reader who cannot tell them apart will confidently report the
// first. stories/page-content.md turns those strings back into throws at the
// boundary, without changing what the runner sees.
// ---------------------------------------------------------------------------

/** Why a capture produced no content. */
export type PageCaptureFailureKind =
  /** The page's JS thread did not answer within the evaluate budget. */
  | 'timeout'
  /** A selector was given and matched nothing. */
  | 'selector-miss'
  /** A selector was given and is not valid CSS — the caller's mistake. */
  | 'bad-selector'
  /** The element matched but is not being rendered, so it has no visible text
   *  to read. Distinct from an empty element, which reads as ''. */
  | 'not-rendered'
  /** The element matched but is not an HTML element, so it has no text to read
   *  (SVG and friends have textContent but no innerText). The caller picked it,
   *  so it is a 400 — not a server fault. */
  | 'unreadable-element'
  /** The page navigated out from under the evaluate — retryable. */
  | 'navigated'
  /** Anything else the evaluate threw. */
  | 'evaluate-failed';

/** A capture that produced no content *because it failed*. */
export class PageCaptureError extends Error {
  constructor(
    readonly kind: PageCaptureFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'PageCaptureError';
  }
}

/** Playwright's wording when an evaluate loses its execution context to a
 *  navigation. Matched on the stable fragment rather than the whole sentence,
 *  which has changed across versions. */
const NAVIGATION_RACE_FRAGMENT = 'execution context was destroyed';

/**
 * Classify a thrown evaluate failure.
 *
 * Exported because the paths that swallow their own errors (`expandDomSubtree`)
 * still let a Playwright-level failure through — the browser script's try/catch
 * cannot catch a context that was destroyed underneath it — and the caller
 * needs that classified the same way rather than reinventing the match.
 */
export function toPageCaptureError(
  err: unknown,
  what: string,
  selectorInvolved = false,
): PageCaptureError {
  if (err instanceof EvaluateTimeout) {
    return new PageCaptureError('timeout', `${what} timed out: ${err.message}`);
  }
  const text = err instanceof Error ? err.message : String(err);
  return classifyFailureText(text, what, selectorInvolved);
}

/** Fragments that identify an invalid CSS selector across the two paths that
 *  can raise one — `querySelector` throwing a DOMException in the page, and
 *  the same surfacing through Playwright. */
function isBadSelectorText(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('is not a valid selector') || lower.includes('syntaxerror');
}

/**
 * Shared classification for a failure we only have the *text* of — whether it
 * arrived as a throw or embedded in an in-band marker.
 *
 * `selectorInvolved` gates the bad-selector branch, which matches on a
 * substring (`syntaxerror`) loose enough to appear in unrelated error text. A
 * whole-page capture that failed with a `SyntaxError` from the page's own code
 * was otherwise reported as "not a valid CSS selector" on a request that
 * supplied no selector — telling the agent to fix an argument it never sent.
 */
function classifyFailureText(
  text: string,
  what: string,
  selectorInvolved: boolean,
): PageCaptureError {
  // Navigation first: it is the only retryable kind, and its text can also
  // carry words the later branches match on.
  if (text.toLowerCase().includes(NAVIGATION_RACE_FRAGMENT)) {
    return new PageCaptureError(
      'navigated',
      `${what} failed because the page navigated while it was being read. Retry once the page has settled.`,
    );
  }
  if (selectorInvolved && isBadSelectorText(text)) {
    return new PageCaptureError('bad-selector', `${what} failed: not a valid CSS selector (${text})`);
  }
  // Only the evaluate-budget message means a timeout. Everything else that the
  // capture paths absorb is an ordinary failure, and calling it a timeout tells
  // the caller to wait when it should narrow or give up.
  if (text.includes('evaluate timed out after')) {
    return new PageCaptureError('timeout', `${what} timed out: ${text}`);
  }
  return new PageCaptureError('evaluate-failed', `${what} failed: ${text}`);
}

/** Marker that captureDomSnapshot substitutes for content when the *evaluate*
 *  fails (Node side). */
const DOM_CAPTURE_ERROR_MARKER = '<error>DOM capture';
/**
 * Envelope shared by every in-band DOM failure, including the one raised
 * *inside* the browser — `capture-dom.js` catches its own walk and returns
 * `<error>Failed to capture DOM: …</error>`, which is a different prefix from
 * the Node-side marker above.
 *
 * Matching the envelope rather than each prefix is what keeps a third one from
 * silently reading as page content: a snapshot legitimately begins `<body`,
 * never `<error>`.
 */
const DOM_ERROR_ENVELOPE = '<error>';
/** Markers expandDomSubtree substitutes for content. */
const EXPAND_MISS_MARKER = '[expand] No element found for selector: ';
const EXPAND_ERROR_MARKER = '[expand] Error: ';
const EXPAND_NOT_RENDERED_MARKER = '[expand] Not rendered: ';
/** Appended by captureDomSnapshot when it clips at domSnapshotCharLimit. The
 *  caller has to be able to tell a clipped snapshot from a complete one, or it
 *  will report a partial page as the whole page. */
export const DOM_SNAPSHOT_TRUNCATION_MARKER =
  '\n<!-- DOM snapshot truncated — page content exceeds size limit -->';

/**
 * Recognise an in-band failure string from `captureDomSnapshot` or
 * `expandDomSubtree`, so a caller that must not pass it off as content can
 * throw instead. Returns null for ordinary content.
 *
 * A predicate rather than a behaviour change in those two functions: the
 * runner depends on their current degrade-to-a-string contract, and this story
 * has no business altering how a step recovers from an unreadable DOM.
 */
export function domCaptureFailure(
  content: string,
  /**
   * Which capture produced this string. Load-bearing, not bookkeeping: the two
   * sources have different in-band vocabularies, and checking for one in the
   * other's output misreads real pages.
   *
   * `snapshot` output always begins `<body` (capture-dom.js), so a leading
   * `<error>` can only be the failure envelope. `expand` output begins with
   * whatever tag was asked for — so a page containing an `<error>` element
   * (measured: `<error class="msg">…</error>`) hit the envelope check and was
   * reported as a capture failure, and if its text happened to contain
   * "SyntaxError" it was reported as an invalid selector.
   */
  source: 'snapshot' | 'expand',
): PageCaptureError | null {
  if (source === 'expand') {
    if (content.startsWith(EXPAND_MISS_MARKER)) {
      return new PageCaptureError(
        'selector-miss',
        `No element matches selector: ${content.slice(EXPAND_MISS_MARKER.length)}`,
      );
    }
    if (content.startsWith(EXPAND_NOT_RENDERED_MARKER)) {
      // Matches the text path, so the two formats give the same answer for the
      // same element instead of one raising and the other returning ''.
      // Deliberately NOT the text path's wording. `expandDomSubtree`'s filter
      // is a visibility test (display, visibility AND opacity), which is wider
      // than the rendered-ness test `captureVisibleText` uses — an `opacity: 0`
      // element IS rendered and `format=text` returns its text. Claiming "not
      // rendered" here would be false for exactly that case.
      return new PageCaptureError(
        'not-rendered',
        `Element at "${content.slice(EXPAND_NOT_RENDERED_MARKER.length)}" is not visible ` +
          '(display:none, visibility:hidden or opacity:0), so the DOM view has nothing to show ' +
          'for it. This is not an empty element — try format="text" if you want its text anyway.',
      );
    }
    if (content.startsWith(EXPAND_ERROR_MARKER)) {
      // Through the shared classifier, not a hardcoded kind: this branch is
      // where an invalid selector lands on the `dom` path, and answering
      // `evaluate-failed` there made it a 500 — the exact "caller error wearing
      // a server fault" that was supposedly fixed for `text` only.
      return classifyFailureText(content.slice(EXPAND_ERROR_MARKER.length), 'DOM capture', true);
    }
    return null;
  }

  // Deliberately the envelope, not `DOM_CAPTURE_ERROR_MARKER`: the browser-side
  // catch in capture-dom.js emits `<error>Failed to capture DOM: …`, which the
  // narrower prefix missed entirely — so a page whose DOM walk threw (a deeply
  // nested tree overflowing the recursive walker is the realistic case) came
  // back as a 200 carrying the error string as its content.
  if (content.startsWith(DOM_ERROR_ENVELOPE)) {
    // The envelope embeds the original `String(err)`, so the navigation race
    // and a genuine timeout are still recoverable from it. No selector is
    // involved on this path — it is the whole-page capture.
    return classifyFailureText(content.replace(/<\/?error>/g, ''), 'DOM capture', false);
  }
  return null;
}

/** True when this snapshot was clipped by `domSnapshotCharLimit` — i.e. the
 *  page has more content than the string represents. */
export function domSnapshotWasClipped(content: string): boolean {
  return content.endsWith(DOM_SNAPSHOT_TRUNCATION_MARKER);
}

/**
 * Load a browser-side script once at module init. Scripts live in ./scripts/
 * and are copied alongside the compiled output (see package.json build step).
 */
function loadScript(name: string): string {
  const url = new URL(`./scripts/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

/** Template-substitute __TOKEN__ placeholders with the given string values. */
function substitute(template: string, bindings: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(bindings)) {
    out = out.split(`__${k}__`).join(v);
  }
  return out;
}

/**
 * The page-side "is this a secret field?" rule — `isSecretField` and the
 * regexes it reads — as source text to splice into a page script.
 *
 * One file, ./scripts/secret-field.js, for every script that decides whether a
 * field's value may leave the page: the whole-page snapshot (capture-dom.js),
 * the `expand` walk below, and the step recorder
 * (src/recorder/page-script.ts). They used to carry hand-kept copies; a third
 * copy for the recorder, where a miss sends a typed password over a binding,
 * is the one that would have drifted. Exported for that third consumer and for
 * tests/secret-field-parity.test.ts.
 */
export function loadSecretFieldRule(): string {
  return SECRET_FIELD_RULE;
}

const SECRET_FIELD_RULE = loadScript('secret-field.js');
const CAPTURE_DOM_TEMPLATE = loadScript('capture-dom.js')
  .split('__SECRET_FIELD_RULE__')
  .join(SECRET_FIELD_RULE);
const FIND_IN_DOM_TEMPLATE = loadScript('find-in-dom.js');

/** Options for captureDomSnapshot. */
export interface CaptureDomOptions {
  /** Collapse long repetitive sibling runs (table rows, list items, card grids)
   *  into head + omission marker + tail. See stories/collapse-repetitive-dom.md */
  collapseRepetitiveDom?: boolean | undefined;
  /** Replace <svg> geometry with a placeholder comment, keeping the opening tag
   *  and any <title>/<desc> children. Defaults to true in DEFAULT_CONFIG. */
  compactSvg?: boolean | undefined;
  /** Drop `<input type="hidden">` elements. Default true in DEFAULT_CONFIG. */
  hideHiddenInputs?: boolean | undefined;
  /** Drop elements (and subtrees) whose computed `display` is `none`.
   *  Default true in DEFAULT_CONFIG. */
  hideDisplayNoneElements?: boolean | undefined;
  /** Drop elements (and subtrees) marked `aria-hidden="true"`.
   *  Default true in DEFAULT_CONFIG. */
  hideAriaHiddenElements?: boolean | undefined;
  /** Maximum nesting depth for recursive iframe content capture.
   *  Default 5 in DEFAULT_CONFIG. */
  maxIframeDepth?: number | undefined;
  /** Hard character cap on the rendered DOM snapshot.
   *  Default 100000 in DEFAULT_CONFIG. */
  domSnapshotCharLimit?: number | undefined;
  /** Restrict emitted attributes to the curated ALLOWED_DOM_ATTRIBUTES list
   *  (plus all aria-*). When false, every attribute is emitted (legacy).
   *  Default true in DEFAULT_CONFIG. */
  useDomAttributeAllowlist?: boolean | undefined;
  /** Strip `id` attributes that match known framework-generated unstable
   *  patterns (UNSTABLE_ID_PATTERNS). Default false in DEFAULT_CONFIG. */
  dropUnstableIds?: boolean | undefined;
}

/** Resolved, all-fields-present option set used internally. */
interface ResolvedDomOptions {
  collapse: boolean;
  compactSvg: boolean;
  hideHiddenInputs: boolean;
  hideDisplayNone: boolean;
  hideAriaHidden: boolean;
  maxIframeDepth: number;
  domSnapshotCharLimit: number;
  useAttributeAllowlist: boolean;
  dropUnstableIds: boolean;
}

function resolveOptions(opts: CaptureDomOptions): ResolvedDomOptions {
  return {
    collapse: opts.collapseRepetitiveDom === true,
    compactSvg: opts.compactSvg !== false,
    hideHiddenInputs: opts.hideHiddenInputs !== false,
    hideDisplayNone: opts.hideDisplayNoneElements !== false,
    hideAriaHidden: opts.hideAriaHiddenElements !== false,
    maxIframeDepth: opts.maxIframeDepth ?? DEFAULT_MAX_IFRAME_DEPTH,
    domSnapshotCharLimit: opts.domSnapshotCharLimit ?? DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT,
    useAttributeAllowlist: opts.useDomAttributeAllowlist !== false,
    dropUnstableIds: opts.dropUnstableIds === true,
  };
}

/**
 * Capture a raw DOM snapshot from the current page.
 *
 * Emits the `<body>` element and its tree almost verbatim — every element
 * with every attribute — stripping `<script>` / `<style>` tags and HTML
 * comments. Text nodes and wrapper divs are preserved. Hidden elements
 * (`<input type="hidden">`, `display: none`, `aria-hidden="true"`) are
 * dropped by default; see CaptureDomOptions to opt out.
 *
 * Iframes are handled in two steps:
 *  1. The browser script marks each iframe with a placeholder ([iframe:N]).
 *  2. captureDomSnapshot replaces each placeholder using Playwright's Frame API,
 *     which uses CDP and works regardless of same-origin / sandbox restrictions —
 *     unlike accessing contentDocument from within page.evaluate().
 *
 * We use a string-based evaluate to avoid TypeScript/esbuild injecting
 * helper functions (like __name) that don't exist in the browser context.
 */
export async function captureDomSnapshot(page: Page, opts: CaptureDomOptions = {}): Promise<string> {
  const resolved = resolveOptions(opts);
  const script = buildDomCleanerScript(resolved);
  let snapshot: string;
  try {
    snapshot = (await evaluateWithTimeout<string | null>(page, script, PAGE_EVALUATE_TIMEOUT_MS)) ?? '';
  } catch (err) {
    // In-band by design — see the "Capture failures" block above. Callers that
    // must not pass this off as content run it through `domCaptureFailure`.
    return `${DOM_CAPTURE_ERROR_MARKER} timed out: ${String(err)}</error>`;
  }

  if (snapshot.includes('[iframe:')) {
    snapshot = await injectFrameContent(page, snapshot, 0, '', resolved);
  }

  if (snapshot.length > resolved.domSnapshotCharLimit) {
    snapshot = snapshot.substring(0, resolved.domSnapshotCharLimit)
      + DOM_SNAPSHOT_TRUNCATION_MARKER;
  }

  return snapshot;
}

/** Options for captureVisibleText. */
export interface CaptureTextOptions {
  /** Restrict the read to the first element matching this CSS selector.
   *  A selector that matches nothing raises rather than returning ''. */
  selector?: string | undefined;
}

/**
 * Capture the page's visible text — what a person reading the screen would
 * see, not what the markup contains.
 *
 * `innerText` rather than `textContent`, and the difference is the whole point:
 * `textContent` returns the text of `display: none` subtrees, `<template>`
 * contents and collapsed accordions, and does not collapse the whitespace the
 * stylesheet collapses. Substituting it would silently hand back text for
 * things the user cannot see, contradicting `captureDomSnapshot`, which drops
 * exactly those subtrees. `innerText` forces layout and is the slower of the
 * two; the evaluate budget is what keeps that bounded.
 *
 * Unlike `captureDomSnapshot`, this **throws** on failure. It has no runner
 * callers to keep degrading gracefully, and its consumer (stories/page-content.md)
 * must never report an unreadable page as an empty one.
 *
 * Returns the full text — truncation belongs to the caller, which is the layer
 * that knows the requested budget and has to report what it dropped.
 */
export async function captureVisibleText(
  page: Page,
  opts: CaptureTextOptions = {},
): Promise<string> {
  const selector = opts.selector;
  // String-based evaluate, and JSON-quoted interpolation, for the same two
  // reasons as everywhere else in this file: esbuild must not inject helpers
  // into browser code, and a selector containing a quote must not be able to
  // terminate the literal.
  // `checkVisibility()` is the guard against innerText's silent fallback: per
  // the HTML spec, the getter returns `textContent` when the element "is not
  // being rendered" — so reading a display:none subtree by selector hands back
  // hidden text, unspaced and labelled as visible. Measured, not assumed: on a
  // `display:none` div, `innerText` returned "SSN 123-45-6789nested" while the
  // whole-page read correctly omitted it.
  //
  // checkVisibility() rather than getClientRects(): an empty *rendered* inline
  // element has no boxes, so a rects check would call it hidden. The default
  // options test exactly what innerText cares about (display:none on the
  // element or an ancestor, and content-visibility), not opacity or
  // visibility:hidden — which do still render text and should still be read.
  //
  // `display: contents` is the exception that forced the ancestor walk. Such an
  // element generates no box of its own, so checkVisibility() reports false —
  // but its CHILDREN render normally and innerText collects them correctly
  // (measured: a display:contents wrapper returned "VISIBLE-ONE\n\nVISIBLE-TWO"
  // with a display:none child properly excluded). Testing the element itself
  // turned that working read into a 400, and `display: contents` is mainstream:
  // transparent flex/grid wrappers and `:host { display: contents }` on custom
  // elements. So we test the nearest ancestor that actually generates a box,
  // which still catches a display:contents node under a display:none parent.
  const script = `(() => {
    var selector = ${selector === undefined ? 'null' : JSON.stringify(selector)};
    var root;
    try {
      root = selector ? document.querySelector(selector) : document.body;
    } catch (err) {
      return { error: 'bad-selector', detail: String(err) };
    }
    if (!root) return { error: selector ? 'selector-miss' : 'no-body' };
    if (typeof root.innerText !== 'string') return { error: 'no-inner-text' };
    if (typeof root.checkVisibility === 'function') {
      var probe = root;
      while (probe && getComputedStyle(probe).display === 'contents') {
        probe = probe.parentElement;
      }
      if (probe && !probe.checkVisibility()) return { error: 'not-rendered' };
    }
    return { text: root.innerText };
  })()`;

  let result: { text?: string; error?: string; detail?: string };
  try {
    result = await evaluateWithTimeout<{ text?: string; error?: string; detail?: string }>(
      page,
      script,
      PAGE_EVALUATE_TIMEOUT_MS,
    );
  } catch (err) {
    throw toPageCaptureError(err, 'Text capture');
  }

  switch (result.error) {
    case undefined:
      break;
    case 'selector-miss':
      throw new PageCaptureError('selector-miss', `No element matches selector: ${String(selector)}`);
    case 'bad-selector':
      throw new PageCaptureError(
        'bad-selector',
        `Not a valid CSS selector: ${String(selector)} (${result.detail ?? 'rejected by the browser'})`,
      );
    case 'not-rendered':
      throw new PageCaptureError(
        'not-rendered',
        selector === undefined
          ? 'The page body is not rendered (display:none), so it has no visible text.'
          : `Element at "${selector}" is on the page but not rendered (display:none or an unrendered ` +
            'ancestor), so it has no visible text. Reading it would return hidden content.',
      );
    case 'no-body':
      throw new PageCaptureError('evaluate-failed', 'The page has no <body> to read.');
    case 'no-inner-text':
      // SVG and other non-HTML elements have textContent but no innerText.
      // Falling back to textContent here would reintroduce exactly the hidden-
      // content problem this function exists to avoid, so it is an error — but
      // the caller's own selector chose this element, so it is their error and
      // must not wear a 500.
      throw new PageCaptureError(
        'unreadable-element',
        `Element at "${String(selector)}" is not an HTML element (SVG or similar), so it has no ` +
          'visible text to read. Use format="dom" to inspect its structure instead.',
      );
    default:
      throw new PageCaptureError('evaluate-failed', `Text capture failed: ${result.error}`);
  }

  return result.text ?? '';
}

/**
 * Replace [iframe:N] placeholders in the snapshot with the actual DOM content
 * of each child frame, captured via Playwright's Frame API.
 *
 * Recurses into nested iframes up to opts.maxIframeDepth levels deep.
 *
 * IMPORTANT: We iterate iframe *elements* in DOM order (via locator) rather
 * than using page.frames(), because page.frames() returns frames in attachment
 * order which may differ from DOM traversal order. The browser script assigns
 * [iframe:N] indices during a depth-first DOM walk, so we must match that order.
 */
async function injectFrameContent(
  root: Page | Frame,
  snapshot: string,
  depth: number = 0,
  parentFramePath: string = '',
  opts: ResolvedDomOptions = {
    collapse: false,
    compactSvg: true,
    hideHiddenInputs: true,
    hideDisplayNone: true,
    hideAriaHidden: true,
    maxIframeDepth: DEFAULT_MAX_IFRAME_DEPTH,
    domSnapshotCharLimit: DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT,
    useAttributeAllowlist: true,
    dropUnstableIds: false,
  },
): Promise<string> {
  const iframeLocators = await root.locator('iframe').all();
  if (iframeLocators.length === 0) return snapshot;

  let result = snapshot;

  // If we're inside a parent frame, rewrite <!-- selector --> comments on <iframe>
  // tags in this snapshot to show the full frame path (e.g. "#outer >> #inner")
  // so the AI can copy the path directly into the "frame" field.
  if (parentFramePath) {
    result = prefixIframeComments(result, parentFramePath);
  }

  let idx = 0;
  for (const iframeLoc of iframeLocators) {
    const placeholder = `[iframe:${idx}]`;
    idx++;

    if (!result.includes(placeholder)) continue;

    // Extract this iframe's selector from the <!-- selector --> comment preceding
    // the placeholder so we can build the full frame path for nested iframes.
    const iframeSelector = extractIframeSelector(result, placeholder);
    const framePath = parentFramePath
      ? `${parentFramePath} >> ${iframeSelector}`
      : iframeSelector;

    let frameContent: string;
    try {
      const handle = await iframeLoc.elementHandle({ timeout: IFRAME_HANDLE_TIMEOUT_MS });
      const frame = handle ? await handle.contentFrame() : null;
      if (!frame) {
        frameContent = '[frame content unavailable]';
      } else {
        // Wait for the frame to finish loading before capturing its content.
        // This handles cases where a prior action updated the iframe's src
        // (e.g. via postMessage) and the new content hasn't loaded yet.
        await frame.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
        // frame.evaluate() uses CDP — works for both same-origin and cross-origin frames.
        // Wrapped in evaluateWithTimeout so a frame with stuck JS can't hang the whole capture.
        try {
          frameContent = await evaluateWithTimeout<string>(
            frame,
            buildDomCleanerScript(opts),
            FRAME_EVALUATE_TIMEOUT_MS,
          );
        } catch {
          frameContent = '[frame content unavailable — evaluate timed out]';
        }

        // Recursively capture nested iframe content within this frame.
        // Pass the current frame path so nested iframe comments show the full chain.
        if (depth < opts.maxIframeDepth && frameContent.includes('[iframe:')) {
          frameContent = await injectFrameContent(frame, frameContent, depth + 1, framePath, opts);
        }
      }
    } catch {
      frameContent = '[frame content unavailable]';
    }

    // Find the placeholder line, determine its indentation, and replace it
    // with the indented frame content.
    const lines = result.split('\n');
    const phIdx = lines.findIndex((l) => l.trim() === placeholder);

    if (phIdx === -1) {
      result = result.replace(placeholder, frameContent);
      continue;
    }

    const phLine = lines[phIdx]!;
    const lineIndent = phLine.match(/^(\s*)/)?.[1] ?? '';

    const indentedLines = frameContent
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => lineIndent + l);

    lines.splice(phIdx, 1, ...indentedLines);
    result = lines.join('\n');
  }

  // Clean up any remaining placeholders (beyond max depth or unresolved)
  result = result.replace(/\[iframe:\d+\]/g, '[nested frame — content not captured]');

  return result;
}

/**
 * Extract the iframe selector from the <!-- selector --> comment that sits
 * on the line with the <iframe> tag above the given placeholder.
 */
function extractIframeSelector(snapshot: string, placeholder: string): string {
  const lines = snapshot.split('\n');
  const phIdx = lines.findIndex((l) => l.trim() === placeholder);
  if (phIdx === -1) return 'iframe';

  // Walk backwards from the placeholder to find the <iframe ...> <!-- selector --> line
  for (let i = phIdx - 1; i >= Math.max(0, phIdx - 3); i--) {
    const match = lines[i]!.match(/<!--\s*(.+?)\s*-->/);
    if (match) return match[1]!;
  }
  return 'iframe';
}

/**
 * Rewrite `<!-- selector -->` comments inside `<iframe>` tags to prepend
 * the parent frame path, producing `<!-- parent >> selector -->`.
 * This gives the AI the full frame chain it needs for the "frame" field.
 */
function prefixIframeComments(content: string, parentPath: string): string {
  // Match: <iframe ...> <!-- selector -->
  return content.replace(
    /(<iframe[^>]*>\s*<!--\s*)(.+?)(\s*-->)/g,
    (_, before, selector, after) => `${before}${parentPath} >> ${selector}${after}`,
  );
}

/** Collapse thresholds — see [stories/collapse-repetitive-dom.md] for rationale. */
const COLLAPSE_MIN_RUN = 50;
const COLLAPSE_HEAD = 3;
const COLLAPSE_TAIL = 1;

/**
 * Build the self-contained browser script by substituting placeholders into the
 * template in [./scripts/capture-dom.js]. See that file for what the script does.
 */
function buildDomCleanerScript(opts: ResolvedDomOptions): string {
  return substitute(CAPTURE_DOM_TEMPLATE, {
    COLLAPSE: opts.collapse ? 'true' : 'false',
    COLLAPSE_MIN_RUN: String(COLLAPSE_MIN_RUN),
    COLLAPSE_HEAD: String(COLLAPSE_HEAD),
    COLLAPSE_TAIL: String(COLLAPSE_TAIL),
    COMPACT_SVG: opts.compactSvg ? 'true' : 'false',
    HIDE_HIDDEN_INPUTS: opts.hideHiddenInputs ? 'true' : 'false',
    HIDE_DISPLAY_NONE: opts.hideDisplayNone ? 'true' : 'false',
    HIDE_ARIA_HIDDEN: opts.hideAriaHidden ? 'true' : 'false',
    USE_ATTR_ALLOWLIST: opts.useAttributeAllowlist ? 'true' : 'false',
    ALLOWED_ATTRS_JSON: JSON.stringify(ALLOWED_DOM_ATTRIBUTES),
    DROP_UNSTABLE_IDS: opts.dropUnstableIds ? 'true' : 'false',
    UNSTABLE_ID_PATTERNS_JSON: JSON.stringify(UNSTABLE_ID_PATTERNS),
  });
}

/** Result of a findInDom search */
export interface DomSearchMatch {
  /** CSS selector for the matching element (stable — auto-chains nth-of-type when no direct id/testid/name/aria-label) */
  selector: string;
  /** Tag name of the matching element */
  tag: string;
  /** Text content of the matching element (truncated) */
  text: string;
  /** Key attributes of the matching element */
  attributes: string;
  /** Ancestor chain for orientation (e.g. "main > div#content > table") */
  context: string;
}

/** Aggregate result of a findInDom call. */
export interface DomSearchResult {
  /** Matches returned (capped at FIND_DISPLAY_CAP). */
  matches: DomSearchMatch[];
  /** Total leaf-like matches discovered in the walked subtree (may exceed matches.length). */
  totalMatches: number;
  /** True when the walk hit FIND_HARD_MAX and stopped counting further. totalMatches is then a lower bound. */
  hitHardMax: boolean;
  /** Error message when the container selector was provided but matched nothing. */
  containerError?: string;
}

/** Maximum matches returned to the AI per find call. */
const FIND_DISPLAY_CAP = 50;
/** Hard ceiling on counting — the walker exits when this is reached. */
const FIND_HARD_MAX = 500;

/**
 * Search the DOM for elements containing the given text.
 *
 * Walks the subtree rooted at `containerSelector` (if provided, else `document.body`)
 * and returns up to FIND_DISPLAY_CAP leaf-like matches (an element is "leaf-like" when
 * no direct child also contains the text). The walker keeps counting past the display
 * cap up to FIND_HARD_MAX so the caller can report "N of M" and the AI can decide
 * whether to refine the query or narrow the scope.
 *
 * Selectors are stable: if the matched element has no direct `data-testid`/`id`/`name`/
 * `aria-label`, the result is a chained selector anchored at the nearest addressable
 * ancestor, with `nth-of-type(N)` steps in between.
 *
 * Used by the "find" exploration action.
 */
export async function findInDom(
  page: Page,
  searchText: string,
  containerSelector?: string,
): Promise<DomSearchResult> {
  let stamp: StampedElement | null = null;
  if (containerSelector) {
    try {
      stamp = await stampFirstMatch(page, containerSelector);
    } catch (err) {
      // The shape the in-page catch has always used for a selector it could
      // not run, so the formatter and the model see the same thing as before.
      return {
        matches: [{ selector: '', tag: 'error', text: String(err), attributes: '', context: '' }],
        totalMatches: 1,
        hitHardMax: false,
      };
    }
  }
  const script = substitute(FIND_IN_DOM_TEMPLATE, {
    SEARCH_TEXT: JSON.stringify(searchText),
    // `null` when the container matched nothing: the script then answers with
    // its own "No element matches container selector" error.
    CONTAINER_EXPR: !containerSelector
      ? 'document.body'
      : stamp
        ? `document.querySelector(${JSON.stringify(stamp.css)})`
        : 'null',
    CONTAINER_LABEL: containerSelector ? JSON.stringify(containerSelector) : '""',
    DISPLAY_CAP: String(FIND_DISPLAY_CAP),
    HARD_MAX: String(FIND_HARD_MAX),
  });
  try {
    return await page.evaluate(script) as DomSearchResult;
  } finally {
    await stamp?.release();
  }
}

/**
 * The attribute {@link stampFirstMatch} writes. `expand` prints every other
 * `data-*` attribute, so it skips this one by name.
 */
const TARGET_STAMP = 'data-steptix-target';

interface StampedElement {
  /** Plain CSS that finds the stamped element with `document.querySelector`. */
  css: string;
  /** Remove the stamp. Never throws: the page may have navigated meanwhile. */
  release: () => Promise<void>;
}

/**
 * Resolve `selector` through Playwright — exactly as every action does, so
 * `role=`, `text=` and " >> " chains work — and stamp the first match, so an
 * in-page script, which can only run `document.querySelector`, finds that same
 * element with plain CSS.
 *
 * `expand` and `find`'s scope used to hand the model's selector straight to
 * `document.querySelector`, which threw on the `role=` form rule 3 now
 * recommends (issue 062). A stamp keeps those long in-page scripts unchanged,
 * where passing an element handle into them would mean rewriting both.
 *
 * Returns `null` when nothing matches (or the match vanished before it could
 * be stamped). An invalid selector throws, at once, from the count. Bounded by
 * the same budget as the evaluates it stands in front of, so a page with a
 * wedged JS thread cannot hold an HTTP caller of `expand` open forever.
 */
async function stampFirstMatch(page: Page, selector: string): Promise<StampedElement | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stampNow(page, selector),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new EvaluateTimeout(`resolving the selector timed out after ${PAGE_EVALUATE_TIMEOUT_MS}ms`)),
          PAGE_EVALUATE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stampNow(page: Page, selector: string): Promise<StampedElement | null> {
  const target = page.locator(selector);
  if ((await target.count()) === 0) return null;
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const stamped = await target
    .first()
    .evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any, [name, value]: [string, string]) => {
        el.setAttribute(name, value);
        return true;
      },
      [TARGET_STAMP, token] as [string, string],
      { timeout: 2_000 },
    )
    .catch(() => false);
  if (!stamped) return null;
  return {
    css: `[${TARGET_STAMP}="${token}"]`,
    release: async () => {
      await page
        .evaluate(([name, value]: [string, string]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = (globalThis as any).document;
          for (const el of doc.querySelectorAll(`[${name}="${value}"]`)) el.removeAttribute(name);
        }, [TARGET_STAMP, token] as [string, string])
        .catch(() => undefined);
    },
  };
}

/**
 * Expand the full DOM subtree for a given selector (CSS or any Playwright form).
 * Returns a detailed snapshot of that element's children — every visible
 * element with attributes and text. Used by the "expand" action, typically
 * after the AI sees a "N similar elements omitted" marker and wants to
 * inspect a specific item's contents.
 */
export async function expandDomSubtree(page: Page, selector: string): Promise<string> {
  // Bounded like every other capture in this file. It used to call
  // `page.evaluate` bare, which was survivable while the only caller was a step
  // with a deadline around it — but it is now reachable from an HTTP GET, where
  // a page with a wedged JS thread would hold the request open forever.
  //
  // The timeout degrades IN BAND rather than throwing, matching what this
  // function's own browser-side catch already does and what `captureDomSnapshot`
  // does with the same budget. Throwing here would have made the runner's
  // `expand` action abort a step that used to survive — same page, same
  // budget, opposite contract — while the new endpoint gets the same
  // classification either way via `domCaptureFailure`.
  //
  // The selector is resolved through Playwright first, so it means here what
  // it means in every action — `role=`, `text=`, " >> " included — and the
  // walk below finds the same element by its stamp (issue 062). The messages
  // still name the selector the caller wrote.
  let stamp: StampedElement | null;
  try {
    stamp = await stampFirstMatch(page, selector);
  } catch (err) {
    return `${EXPAND_ERROR_MARKER}${String(err)}`;
  }
  if (!stamp) return `${EXPAND_MISS_MARKER}${selector}`;

  let result: string;
  try {
    result = await evaluateWithTimeout<string>(page, `(() => {
    const selector = ${JSON.stringify(stamp.css)};
    const label = ${JSON.stringify(selector)};
    const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'meta', 'link', 'base', 'title']);

    // ── Live \`value\`, the same rule capture-dom.js uses ──────────────────
    //
    // Typing sets the \`value\` IDL PROPERTY and never the attribute, so an
    // attribute-only read answers with the page-load value for the life of
    // the page. The whole-page snapshot reads the property (capture-dom.js
    // \`liveState\`), so leaving this walk on attributes made the two capture
    // tools contradict each other about the same field in the same run: the
    // snapshot said \`value="ada@new.test"\` and \`expand\`, one turn later,
    // said \`value="preset@old.test"\`.
    //
    // \`checked\` / \`selected\` stay attribute-sourced here: this walk skips
    // every empty-valued attribute, so those two have never appeared in
    // \`expand\` output at all, and giving them a live reading means choosing
    // a shape (\`checked=""\` against its own empty-skip rule, or
    // \`checked="true"\`) rather than fixing a staleness.
    //
    // The secret-field rule — SECRET_NAME_RE, PASSWORD_FIELD_RE, hasPinToken
    // and isSecretField — is the ONE copy in scripts/secret-field.js, the text
    // capture-dom.js and the step recorder splice in too. This string is
    // evaluated in the page and can import nothing, so it is interpolated.
    ${SECRET_FIELD_RULE}
    const STATIC_VALUE_INPUT_TYPES = new Set([
      'password', 'file', 'hidden', 'submit', 'reset', 'button', 'image',
    ]);

    /** "This attribute is OFF: print nothing, and drop what the markup says."
     *  The snapshot says this with \`{ value: null }\` from \`liveState\`, which
     *  is a different answer from \`liveState\` returning null ("nothing here
     *  is live, the markup rules"). This walk had one null for both, so it
     *  printed a stale markup \`value\` the snapshot had already dropped. */
    const DROP = {};

    /** A secret field says a value is THERE and withheld, never what it is —
     *  the snapshot's \`maskedValue\`. Empty DROPS, so the markup's own
     *  \`value\` cannot stand in for the live one this walk refuses to read. */
    function maskedValueFor(el) {
      const v = el.value == null ? '' : String(el.value);
      return v === '' ? DROP : '***';
    }

    /** The snapshot's \`liveValue\`: a blank control whose markup carried no
     *  \`value\` has nothing to say, and an explicit \`value=""\` still prints. */
    function liveOrDrop(el) {
      const v = el.value == null ? '' : String(el.value);
      if (v === '' && !el.hasAttribute('value')) return DROP;
      return v;
    }

    /** The live \`value\` to print, DROP for "print none", or null to fall
     *  back to the markup's. */
    function liveValueFor(el, tag) {
      if (tag === 'select') return liveOrDrop(el);
      if (tag === 'textarea') {
        if (isSecretField(el)) return maskedValueFor(el);
        // The snapshot's carve-out, mirrored: a textarea's default value IS
        // its child text, which this walk prints on the next line, so it
        // speaks up only once the live text has diverged from it. Without
        // this the two capture tools disagreed about every untouched
        // textarea on the page (review 4, finding 12).
        return el.value === el.defaultValue ? DROP : String(el.value);
      }
      if (tag !== 'input') return null;
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      // A checkbox's \`.value\` is its submit payload ("on" by default), not
      // its state — the same carve-out the snapshot makes.
      if (type === 'checkbox' || type === 'radio') return null;
      if (type !== 'password' && STATIC_VALUE_INPUT_TYPES.has(type)) return null;
      if (isSecretField(el)) return maskedValueFor(el);
      return liveOrDrop(el);
    }

    function getAttrs(el) {
      const attrs = [];
      const important = ${JSON.stringify(ALLOWED_DOM_ATTRIBUTES)};
      const tag = el.tagName.toLowerCase();
      // One line per element here too, so a typed textarea cannot split one.
      const rawLive = liveValueFor(el, tag);
      const live = typeof rawLive === 'string' ? rawLive.replace(/\\s+/g, ' ') : rawLive;
      const secret = (tag === 'input' || tag === 'textarea') && isSecretField(el);
      for (const attr of important) {
        if (attr === 'value' && live !== null) {
          // The live reading answers for this attribute, empty string
          // included: \`value=""\` is how the snapshot says "the run emptied
          // this field", and skipping it here as an empty attribute was the
          // last place the two tools still differed (review 5, finding 5).
          if (live !== DROP) attrs.push('value="' + live + '"');
          continue;
        }
        const val = el.getAttribute(attr);
        if (val !== null && val !== '') {
          attrs.push(attr + '="' + val + '"');
        }
      }
      // Walk all attributes once and pick up the prefix-match families:
      //   - aria-*  (full accessibility surface)
      //   - data-*  (test/state hooks; expand is zoomed-in so full fidelity)
      // Skip data-testid and data-steptix-row since both are already in the named
      // list above — emitted here too, a row a readTable had numbered came out
      // as data-steptix-row="8" data-steptix-row="8". Skip the framework's own
      // lookup stamp too: it is on the element only while this walk runs.
      const allAttrs = el.attributes;
      for (let i = 0; i < allAttrs.length; i++) {
        const a = allAttrs[i];
        if (a.value === '') continue;
        if (a.name.indexOf('aria-') === 0) {
          attrs.push(a.name + '="' + a.value + '"');
        } else if (
          a.name.indexOf('data-') === 0
          && a.name !== 'data-testid'
          && a.name !== 'data-steptix-row'
          && a.name !== '${TARGET_STAMP}'
        ) {
          // A field whose \`value\` was just masked must not hand the same
          // string back in \`data-value\`: a page that mirrors its input into
          // an attribute would undo the mask on the very line that applied it
          // (review 5, finding 4). The hook's NAME still prints, so the model
          // can see it exists, and the whole-page snapshot emits no data-*
          // at all — so this moves the two tools closer, not further apart.
          attrs.push(a.name + '="' + (secret ? '***' : a.value) + '"');
        }
      }
      return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
    }

    function buildSelector(el) {
      const testId = el.getAttribute('data-testid');
      if (testId) return '[data-testid="' + testId + '"]';
      const id = el.getAttribute('id');
      if (id) return '#' + id;
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute('name');
      if (name) return tag + '[name="' + name + '"]';
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return tag + '[aria-label="' + ariaLabel + '"]';
      return tag;
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    var INTERACTIVE = new Set(['input', 'button', 'a', 'select', 'textarea', 'label']);

    function isFileInput(el, tag) {
      return tag === 'input' && String(el.getAttribute('type') || '').toLowerCase() === 'file';
    }

    function processEl(el, depth) {
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return '';
      // Same carve-out as the capture script: a hidden <input type="file"> is
      // the one hidden element worth showing, because it is the one a step can
      // legitimately target. Without this, expanding an uploader card showed
      // the button and no input at all.
      if (!isVisible(el) && !isFileInput(el, tag)) return '';
      const indent = '  '.repeat(depth);
      const attrs = getAttrs(el);
      let text = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += (node.textContent || '').trim();
        }
      }
      text = text.substring(0, 100);
      const isInt = INTERACTIVE.has(tag);
      const selectorComment = isInt ? ' <!-- ' + buildSelector(el) + ' -->' : '';
      const textPart = text ? ' ' + text : '';
      let output = indent + '<' + tag + attrs + '>' + textPart + selectorComment + '\\n';
      for (const child of el.children) {
        output += processEl(child, depth + 1);
      }
      if (!['input', 'br', 'hr', 'img'].includes(tag)) {
        output += indent + '</' + tag + '>\\n';
      }
      return output;
    }

    try {
      const el = document.querySelector(selector);
      if (!el) return '[expand] No element found for selector: ' + label;
      // processEl filters invisible elements to '', which at the top level is
      // indistinguishable from "this element is empty" — the exact conflation
      // the text path raises 'not-rendered' to avoid. Say so instead.
      if (!isVisible(el)) return '[expand] Not rendered: ' + label;
      return processEl(el, 0);
    } catch (err) {
      return '[expand] Error: ' + String(err);
    }
  })()`, PAGE_EVALUATE_TIMEOUT_MS);
  } catch (err) {
    return `${EXPAND_ERROR_MARKER}${String(err)}`;
  } finally {
    await stamp.release();
  }

  return result;
}

/**
 * Format findInDom results for inclusion in the AI continuation message.
 */
export function formatFindResults(result: DomSearchResult, query: string, containerSelector?: string): string {
  const scopePart = containerSelector ? ` (in ${containerSelector})` : '';
  const header = `### find "${query}"${scopePart}`;

  if (result.containerError) {
    return `${header}\n${result.containerError}. Widen the scope or omit the container.`;
  }
  if (result.matches.length === 0) {
    return `${header}\nNo matches found.`;
  }

  const lines = result.matches.map((m, i) => {
    const contextPart = m.context ? ` (in ${m.context})` : '';
    return `${i + 1}. <${m.tag}${m.attributes ? ' ' + m.attributes : ''}> "${m.text}"${contextPart}\n   selector: ${m.selector}`;
  });

  const shown = result.matches.length;
  const total = result.totalMatches;
  let summary: string;
  if (shown === total) {
    summary = `Found ${total} match${total === 1 ? '' : 'es'}:`;
  } else if (result.hitHardMax) {
    summary = `Found ${shown} of ${total}+ matches (counting stopped at ${total}; showing first ${shown}). Refine the query or narrow the container to see specific items.`;
  } else {
    summary = `Found ${shown} of ${total} matches (showing first ${shown}). Refine the query or narrow the container to see more.`;
  }

  return `${header}\n${summary}\n${lines.join('\n')}`;
}

/**
 * Format expandDomSubtree results for inclusion in the AI continuation message.
 */
export function formatExpandResult(content: string, selector: string): string {
  return `### expand "${selector}"\n\`\`\`html\n${content}\n\`\`\``;
}

/**
 * Clean a raw HTML string into a simplified representation.
 * Used in unit tests where a real browser is not available.
 */
export function cleanHtmlString(html: string): string {
  // Parse in Node environment using basic regex-based extraction
  // (Full DOM parsing requires a browser — this is the unit-test-friendly version)
  return extractInteractiveElements(html);
}

/**
 * Simple regex-based HTML element extractor for unit testing.
 * Not as thorough as the browser-based version but works without a DOM.
 */
function extractInteractiveElements(html: string): string {
  const INTERACTIVE = ['input', 'button', 'a', 'select', 'textarea', 'label', 'form'];
  const lines: string[] = [];

  for (const tag of INTERACTIVE) {
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>|<${tag}[^>]*\/?>`, 'gi');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      const element = match[0];
      // Skip hidden elements
      if (/display:\s*none|visibility:\s*hidden/i.test(element)) continue;
      // Skip elements in script/style context
      if (/type="hidden"/i.test(element)) continue;

      lines.push(element.replace(/\s+/g, ' ').trim());
    }
  }

  return lines.join('\n');
}
