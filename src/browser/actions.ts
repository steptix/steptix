import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Frame, Page, FrameLocator, Locator } from 'playwright';
import type { AIAction, ActionType, TableReadColumn, TableReadMapping } from '../ai/types.js';
// §9.2: one validator for both paths into the table extractor. The dependency
// points this way because the parser owns the §6.2 rules and their wording;
// nothing in `action-parser.ts` reaches back here. The action vocabulary comes
// from the same place, for the same reason: the parser owns the list, and the
// refusal below is worded once, there.
import {
  validateTableRead,
  MAX_TABLE_ROWS,
  isKnownActionType,
  unknownActionTypeError,
} from '../ai/action-parser.js';
import { logger } from '../utils/logger.js';
import { resolveUploadPaths, uploadPathsOf, type UploadPathContext } from './upload-paths.js';
import { armDialog, describeDialogs, takeUnreportedDefaultAnswers } from './dialogs.js';
import { gotoWithDiagnosis } from './navigate-diagnosis.js';

/**
 * Resolves the locator root for an action.
 * When action.frame is set, returns a FrameLocator scoped to that iframe.
 * For nested iframes, the frame selector can chain levels with " >> "
 * (e.g. "#outer-frame >> #inner-frame"), producing a nested FrameLocator.
 * Space-separated selectors (e.g. "#outer #inner") are also accepted as a
 * fallback since AI models sometimes produce CSS-style descendant selectors
 * instead of the canonical ">>" chain syntax.
 * Otherwise returns the top-level Page.
 * Both Page and FrameLocator expose .locator(), so callers are type-compatible.
 */
function resolveLocatorRoot(page: Page, frameSelector?: string): Page | FrameLocator {
  if (!frameSelector) return page;

  // Split on ">>" if present, otherwise fall back to splitting on whitespace.
  const segments = frameSelector.includes('>>')
    ? frameSelector.split('>>').map((s) => s.trim()).filter(Boolean)
    : frameSelector.trim().split(/\s+/);

  let root: Page | FrameLocator = page;
  for (const segment of segments) {
    root = root.frameLocator(segment);
  }
  return root;
}

/**
 * One `>>` segment that names a role and an exact name — `role=button[name="Dismiss"]`,
 * optionally followed by more attributes (`[pressed]`). Playwright's `i`/`s`
 * flags and regex names are the model choosing its own matching, so they are
 * left alone.
 */
const ROLE_NAME_SEGMENT = /^role=([\w-]+)\[name=(["'])((?:\\.|(?!\2)[^\\])+)\2\]((?:\[[^\]]*\])*)$/;

/** At most this many elements are listed in a role-name failure. */
const ROLE_NAME_LIST_LIMIT = 20;

/**
 * How long the name as written gets to appear before anything else is looked
 * for. The fallback runs before the action's own wait, so without this an
 * element that has not rendered yet loses to one already on screen that only
 * reads the same — a closing dialog's Dismiss, a row's "✖ Remove".
 */
const ROLE_NAME_GRACE_MS = 1_000;

/** Per-call switches for {@link resolveRoleName}. */
export interface RoleNameOptions {
  /**
   * The action takes every match — `count`, `read` with `multiple`,
   * `readTable` — so several elements reading the name is its answer, not an
   * ambiguity, and a match as written, hidden or not, is left alone.
   */
  plural?: boolean;
  /**
   * The action may target a hidden element — `upload`, whose `<input
   * type="file">` is usually hidden on purpose — so a hidden match as written
   * is its answer too.
   */
  hiddenTargets?: boolean;
  /** Overrides {@link ROLE_NAME_GRACE_MS}. */
  graceMs?: number;
}

/** What {@link resolveRoleName} decided for a selector. */
export interface RoleNameResolution {
  /** The selector to act on: as written, or pinned to the one element whose
   *  visible text is the name. */
  selector: string;
  /** Set when more than one element reads the name on screen, or is named
   *  like it, for a singular action: it must not run, and this says which
   *  ones did. */
  refusal?: string;
  /** How many elements the refusal lists. */
  matches?: number;
  /** Set when a role name matched nothing either way. Lists the elements of
   *  that role, read at the moment it is called — after the action's own wait
   *  has timed out, not before. */
  describeMiss?: () => Promise<string>;
}

/**
 * Role names match what a person sees when the accessible name has icon text
 * in it (SPEC-web-survey-fixes.md §2.34, issue 26).
 *
 * The browser's accessible name includes text nobody sees as text: an icon
 * font's `::before` glyph, an `<img>`'s alt, an SVG's `<title>`. The model
 * writes the name it sees in the snapshot, so PrimeFaces' "<glyph> Dismiss"
 * button, or one with `<img alt="tick">` in front, never matched
 * `role=button[name="Dismiss"]`. For each role-name segment of the selector:
 *
 *  1. The exact name, as written, given {@link ROLE_NAME_GRACE_MS} to appear.
 *     A selector with a visible match — any match, for a plural action — is
 *     never touched.
 *  2. Otherwise, the visible elements of that role whose `innerText` equals the
 *     name, ignoring case and runs of spaces — or, when none does, equals it
 *     with symbols around it ignored, for a glyph that is real text in the DOM.
 *  3. Otherwise, the visible elements of that role whose accessible name is
 *     the name with case and symbols around it ignored — a field named by its
 *     `<label>` ("Email *") or an icon button by its `aria-label` has no text
 *     of its own for step 2 to read.
 *
 *     One match is acted on, pinned by its own text where that picks out the
 *     same element and by its position only where it does not. More than one
 *     is refused, because "✔ Save" and "✖ Save" are two buttons and guessing
 *     is how the wrong one gets clicked — unless the action is plural, which
 *     takes them all.
 *  4. Nothing: the selector runs as written, so Playwright's own wait still
 *     covers an element that has not appeared yet, and a timeout lists what
 *     that role does have on the page.
 *
 * The whole text must match, so "Dismiss" never reaches "Dismiss all" or
 * "Dismiss 3". Only the standard role, the browser's own `innerText` and
 * accessible name, and the name the model sent are used; nothing here knows
 * any site.
 */
export async function resolveRoleName(
  root: Page | FrameLocator,
  selector: string,
  options: RoleNameOptions = {},
): Promise<RoleNameResolution> {
  const segments = splitSelectorChain(selector);
  if (!segments.some((s) => ROLE_NAME_SEGMENT.test(s))) return { selector };
  const plural = options.plural === true;
  try {
    const written = root.locator(selector);
    const total = await written.count();
    // A singular action acts on a VISIBLE match, so an exact match nobody can
    // see — a zero-size duplicate in a collapsed menu — is not an answer.
    if (total > 0 && (plural || options.hiddenTargets || (await written.locator('visible=true').count()) > 0)) {
      return { selector };
    }
    if (total === 0) {
      const graceMs = options.graceMs ?? ROLE_NAME_GRACE_MS;
      const appeared = graceMs > 0 && await written.locator('visible=true').first()
        .waitFor({ state: 'visible', timeout: graceMs })
        .then(() => true, () => false);
      if (appeared) return { selector };
    }
    const resolved: string[] = [];
    const notes: string[] = [];
    let rewritten = false;
    for (const [i, segment] of segments.entries()) {
      const parsed = parseRoleNameSegment(segment);
      if (parsed === null) {
        resolved.push(segment);
        continue;
      }
      const last = i === segments.length - 1;
      // Unless something before it was rewritten, the last segment completes
      // the selector as written, which was counted above.
      if (!last || rewritten) {
        const here = root.locator([...resolved, segment].join(' >> '));
        if ((await (last ? here.locator('visible=true') : here).count()) > 0) {
          resolved.push(segment);
          continue;
        }
      }
      const scope = resolved.join(' >> ');
      const found = await findRoleBySight(root, scope, parsed, plural);
      if (found.kind === 'none') {
        // A selector that does match, only not visibly, fails on visibility
        // rather than on its name, so a list of names would mislead.
        return { selector, ...(total === 0 && { describeMiss: () => describeRoleMiss(root, scope, parsed) }) };
      }
      if (found.kind === 'ambiguous') {
        return {
          selector,
          refusal: describeAmbiguousRoleName(selector, segments, i, parsed, found),
          matches: found.names.length,
        };
      }
      resolved.push(found.selector);
      notes.push(`${selector} had no exact match; used ${found.note}.`);
      rewritten = true;
    }
    const pinned = resolved.join(' >> ');
    if ((await root.locator(pinned).count()) > 0) {
      for (const note of notes) logger.info(note);
      return { selector: pinned };
    }
  } catch {
    // A selector Playwright cannot parse is left as the model wrote it, so the
    // failure quotes what it sent.
  }
  return { selector };
}

/** What {@link findRoleBySight} found for one role-name segment. */
type RoleSighting =
  | { kind: 'found'; selector: string; note: string }
  | { kind: 'ambiguous'; names: Array<string | null>; basis: 'text' | 'name' }
  | { kind: 'none' };

/**
 * Steps 2 and 3 of {@link resolveRoleName} for one segment, inside `scope`.
 * The selector it finds is relative to the scope, like the segment it stands
 * in for.
 */
async function findRoleBySight(
  root: Page | FrameLocator,
  scope: string,
  parsed: RoleNameSegment,
  plural: boolean,
): Promise<RoleSighting> {
  const role = `role=${parsed.role}${parsed.rest} >> visible=true`;
  const candidates = root.locator(scoped(scope, role));
  const texts = await visibleTexts(candidates);
  const { hits, loose } = textMatches(texts, parsed.name);

  if (hits.length > 0 && plural) {
    const every = `${role} >> internal:has-text=${seenTextPattern(parsed.name, loose)}`;
    // The filter reads text the way Playwright does, which can differ from
    // `innerText` (hidden child text); only an agreeing count is the same set.
    if ((await root.locator(scoped(scope, every)).count()) !== hits.length) return { kind: 'none' };
    return { kind: 'found', selector: every, note: `the ${hits.length} ${parsed.role} elements whose visible text is "${parsed.name}"` };
  }
  if (hits.length > 1) {
    const names = await Promise.all(hits.slice(0, ROLE_NAME_LIST_LIMIT).map((i) => accessibleName(candidates.nth(i))));
    return { kind: 'ambiguous', names, basis: 'text' };
  }
  if (hits.length === 1) {
    const index = hits[0]!;
    const target = candidates.nth(index);
    const text = oneLine(texts[index]!);
    const name = await accessibleName(target);
    const selector = (await pinByText(root, scope, role, target, text)) ?? `${role} >> nth=${index}`;
    return {
      kind: 'found',
      selector,
      note: `the ${parsed.role} whose visible text is "${text}"${name ? ` (its name is "${name}")` : ''}`,
    };
  }

  const tolerant = `role=${parsed.role}[name=${tolerantNamePattern(parsed.name)}]${parsed.rest} >> visible=true`;
  const named = root.locator(scoped(scope, tolerant));
  const count = await named.count();
  if (count === 0) return { kind: 'none' };
  if (count > 1 && !plural) {
    const shown = Math.min(count, ROLE_NAME_LIST_LIMIT);
    const names = await Promise.all(Array.from({ length: shown }, (_v, i) => accessibleName(named.nth(i))));
    return { kind: 'ambiguous', names, basis: 'name' };
  }
  const name = plural ? null : await accessibleName(named.first());
  return {
    kind: 'found',
    selector: tolerant,
    note: plural
      ? `the ${count} ${parsed.role} elements named like "${parsed.name}"`
      : `the ${parsed.role} named ${name ? `"${name}"` : `like "${parsed.name}"`}`,
  };
}

/** `scope >> selector`, or the selector alone when there is no scope. */
function scoped(scope: string, selector: string): string {
  return scope ? `${scope} >> ${selector}` : selector;
}

/**
 * The element pinned by its own text: the role narrowed to elements whose text
 * is exactly `text`, kept only when that matches this element and nothing
 * else. Playwright re-resolves a locator on every retry while it waits for the
 * element to be actionable, so a position would move to another element when
 * one appears or disappears before it; the element's own text does not.
 * Undefined when the filter does not pick out this element alone.
 */
async function pinByText(
  root: Page | FrameLocator,
  scope: string,
  role: string,
  target: Locator,
  text: string,
): Promise<string | undefined> {
  if (text === '') return undefined;
  const selector = `${role} >> internal:has-text=${exactTextPattern(text)}`;
  try {
    const handle = await target.elementHandle({ timeout: MEASUREMENT_TIMEOUT_MS });
    if (handle === null) return undefined;
    try {
      const same = await root.locator(scoped(scope, selector)).evaluateAll(
        (els, el) => els.length === 1 && els[0] === el,
        handle,
      );
      return same ? selector : undefined;
    } finally {
      await handle.dispose();
    }
  } catch {
    return undefined;
  }
}

/**
 * Text as the body of a regex inside a selector: specials escaped, spaces as
 * `\s+`, and quotes and `>` written as hex escapes, so Playwright's `>>`
 * splitter finds nothing in it to pair or split on (§2.42).
 */
function selectorRegexBody(text: string): string {
  return text.trim()
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
    .replace(/'/g, '\\x27')
    .replace(/"/g, '\\x22')
    .replace(/>/g, '\\x3e');
}

/** Exactly this text, case and spacing aside. */
function exactTextPattern(text: string): string {
  return `/^\\s*${selectorRegexBody(text)}\\s*$/i`;
}

/** The text {@link textMatches} matched by: exactly, or with symbols around it ignored. */
function seenTextPattern(name: string, loose: boolean): string {
  if (!loose) return exactTextPattern(name);
  const body = selectorRegexBody(withoutEdgeSymbols(comparable(name)));
  return `/^[^\\p{L}\\p{N}]*${body}[^\\p{L}\\p{N}]*$/iu`;
}

/** An accessible name, case and symbols around it aside. */
function tolerantNamePattern(name: string): string {
  return `/^\\W*${selectorRegexBody(name)}\\W*$/i`;
}

/** A role-name segment's parts: the name unescaped, and any attributes after it. */
interface RoleNameSegment {
  role: string;
  name: string;
  rest: string;
}

function parseRoleNameSegment(segment: string): RoleNameSegment | null {
  const m = ROLE_NAME_SEGMENT.exec(segment);
  if (!m) return null;
  return { role: m[1]!, name: m[3]!.replace(/\\(.)/g, '$1'), rest: m[4] ?? '' };
}

/**
 * A selector's `>>` segments, trimmed. A `>>` inside a quoted string is part
 * of that string — the way Playwright's own splitter reads it.
 */
function splitSelectorChain(selector: string): string[] {
  const segments: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>' && selector[i + 1] === '>') {
      segments.push(selector.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  segments.push(selector.slice(start).trim());
  return segments.filter(Boolean);
}

/** Each candidate's `innerText`: the words a person sees, as the snapshot shows them. */
function visibleTexts(candidates: Locator): Promise<string[]> {
  return candidates.evaluateAll((els) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    els.map((el: any) => String(el.innerText ?? el.textContent ?? '')),
  );
}

/** Whitespace collapsed and case folded: CSS can uppercase what the DOM says. */
function comparable(text: string): string {
  return oneLine(text).toLowerCase();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Symbols around the text dropped: a glyph written into the DOM as a character. */
function withoutEdgeSymbols(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * The indexes of the texts that read `name`: exactly (case and spacing aside)
 * when any does, and otherwise with symbols around both ignored — `loose`
 * says which. The second pass only runs when the name has a letter or digit
 * in it, so "×" never matches "✖" by both being reduced to nothing.
 */
function textMatches(texts: string[], name: string): { hits: number[]; loose: boolean } {
  const wanted = comparable(name);
  const exact = texts.flatMap((t, i) => (comparable(t) === wanted ? [i] : []));
  if (exact.length > 0) return { hits: exact, loose: false };
  const stripped = withoutEdgeSymbols(wanted);
  if (stripped === '') return { hits: [], loose: false };
  return {
    hits: texts.flatMap((t, i) => (withoutEdgeSymbols(comparable(t)) === stripped ? [i] : [])),
    loose: true,
  };
}

/**
 * The accessible name Playwright matches `name=` against, read from the
 * element's aria snapshot (`- button "tick Dismiss":`). Empty when the element
 * has none; null when the snapshot could not be read, which is not the same
 * fact and is not reported as one.
 */
async function accessibleName(target: Locator): Promise<string | null> {
  try {
    const snapshot = await target.ariaSnapshot({ timeout: MEASUREMENT_TIMEOUT_MS });
    const quoted = /^- [^\s"]+ ("(?:[^"\\]|\\.)*")/.exec(snapshot)?.[1];
    return quoted ? String(JSON.parse(quoted)) : '';
  } catch {
    return null;
  }
}

/** One element as a role-name failure lists it. */
function describeNamed(name: string | null): string {
  if (name === null) return 'whose name could not be read';
  return name ? `named "${name}"` : 'with no name';
}

/** `button` → `Buttons`, `checkbox` → `Checkboxes`. */
function rolePlural(role: string): string {
  const plural = role.endsWith('x') ? `${role}es` : `${role}s`;
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

/** A name as it would be written back into a selector. */
function quoteName(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Safeguard 1: several elements read the name, or are named like it, so say
 * which and let the retry pick. The example is the selector rebuilt with the
 * one segment replaced — by position, so an identical segment earlier in the
 * chain is not the one changed, and without `String.replace`, which would read
 * a `$&` or `$$` in a page's name as a substitution.
 */
function describeAmbiguousRoleName(
  selector: string,
  segments: string[],
  index: number,
  parsed: RoleNameSegment,
  sighting: { names: Array<string | null>; basis: 'text' | 'name' },
): string {
  const { names, basis } = sighting;
  const how = basis === 'text' ? `read "${parsed.name}" on screen` : `are named like "${parsed.name}"`;
  const lines = [
    `${selector}: no ${parsed.role} is named exactly "${parsed.name}", and ${names.length} ${how}:`,
    ...names.map((n) => `  - ${describeNamed(n)}`),
  ];
  const first = names[0];
  if (names.some((n) => n === null)) {
    lines.push('Name the one you mean, or scope the selector to it.');
  } else if (first && names.every((n) => n !== '') && new Set(names).size === names.length) {
    const example = segments
      .map((s, i) => (i === index ? `role=${parsed.role}[name=${quoteName(first)}]${parsed.rest}` : s))
      .join(' >> ');
    lines.push(`Name the one you mean, e.g. ${example}.`);
  } else {
    lines.push('Their names do not tell them apart, so scope the selector to the one you mean.');
  }
  return lines.join('\n');
}

/**
 * Safeguard 2: nothing matched either way, so list what that role does have.
 * Each element's text and name are read together, from the same element, so
 * a page still re-rendering cannot pair one element's name with another's
 * text.
 */
async function describeRoleMiss(root: Page | FrameLocator, scope: string, parsed: RoleNameSegment): Promise<string> {
  const where = scope ? `inside ${scope}` : 'on the page';
  const head = `No ${parsed.role} named "${parsed.name}" and none reads "${parsed.name}" on screen.`;
  const candidates = root.locator(scoped(scope, `role=${parsed.role}${parsed.rest} >> visible=true`));
  const count = await candidates.count();
  if (count === 0) return `${head} There are no visible ${rolePlural(parsed.role).toLowerCase()} ${where}.`;
  const shown = Math.min(count, ROLE_NAME_LIST_LIMIT);
  const rows = await Promise.all(Array.from({ length: shown }, (_v, i) => {
    const el = candidates.nth(i);
    return Promise.all([
      el.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => String(e.innerText ?? e.textContent ?? ''),
        undefined,
        { timeout: MEASUREMENT_TIMEOUT_MS },
      ).catch(() => ''),
      accessibleName(el),
    ]);
  }));
  const lines = rows.map(([text, name]) => {
    const reads = oneLine(text);
    const label = describeNamed(name);
    return reads && comparable(reads) !== comparable(name ?? '') ? `  - ${label} (reads "${reads}")` : `  - ${label}`;
  });
  if (count > shown) lines.push(`  … and ${count - shown} more`);
  return [`${head} ${rolePlural(parsed.role)} ${where}:`, ...lines].join('\n');
}

/**
 * The Playwright `Frame` a frame selector names, with the same segmenting as
 * {@link resolveLocatorRoot}, or null when any level is missing. For code that
 * has to run INSIDE the frame — an assertion's `page.evaluate` — where a
 * FrameLocator will not do (SPEC-web-survey-fixes.md §2.31).
 */
export async function resolveFrame(page: Page, frameSelector: string): Promise<Frame | null> {
  const segments = frameSelector.includes('>>')
    ? frameSelector.split('>>').map((s) => s.trim()).filter(Boolean)
    : frameSelector.trim().split(/\s+/);
  let current: Frame = page.mainFrame();
  for (const segment of segments) {
    try {
      const handle = await current.locator(segment).first().elementHandle({ timeout: 5_000 });
      const next = handle ? await handle.contentFrame() : null;
      if (!next) return null;
      current = next;
    } catch {
      return null;
    }
  }
  return current;
}

/**
 * Detect when the AI placed an iframe selector at the start of the element
 * selector instead of in the frame field. If the first space-separated segment
 * of `selector` matches an `<iframe>` inside the current frame context, strip
 * it from the selector and append it to the frame chain.
 *
 * Example: frame="#advisor-frame", selector="#chat-frame #chat-input"
 *       → frame="#advisor-frame >> #chat-frame", selector="#chat-input"
 *
 * The first segment ends at whitespace OR at a Playwright " >> " chain, and
 * everything after it is kept verbatim. Splitting on whitespace alone turned
 * `#pay-frame >> role=button[name="Pay now"]` into the selector
 * `>> role=button[name="Pay now"]`, which Playwright rejects — and rule 3 now
 * tells the model to scope with " >> " (issue 062). Keeping the rest verbatim
 * also stops a name like `name="a  b"` having its spaces collapsed.
 */
async function promoteIframeFromSelector(
  page: Page,
  frame: string | undefined,
  selector: string,
): Promise<{ frame: string | undefined; selector: string }> {
  const split = /^(\S+?)(?:\s*>>\s*|\s+)(\S[\s\S]*)$/.exec(selector.trim());
  if (!split) return { frame, selector };

  const candidate = split[1]!;
  // Check if the candidate matches an iframe in the current frame context
  const root = resolveLocatorRoot(page, frame);
  const isIframe = await root
    .locator(`iframe${candidate}`)
    .count()
    .catch(() => 0);

  if (isIframe > 0) {
    const newFrame = frame ? `${frame} >> ${candidate}` : candidate;
    const newSelector = split[2]!;
    logger.debug(`Promoted iframe from selector: frame="${newFrame}", selector="${newSelector}"`);
    // Recurse in case there are multiple nested iframes in the selector
    return promoteIframeFromSelector(page, newFrame, newSelector);
  }

  return { frame, selector };
}

/**
 * What the runtime found at the instant it acted
 * (stories/codebehind-selector-ambiguity.md §"Measurement 1").
 *
 * The AI runtime puts every selector through two tolerances — hidden matches
 * are filtered out, and of what remains the first is taken — so a transcript
 * has never been evidence that one match *exists*. Generated code-behind has
 * neither tolerance: Playwright's default is strict and throws on the second
 * match, visible or not. These three facts are what closes that gap.
 *
 * Every field is optional and absence is first-class. Measurement is strictly
 * additive telemetry, so anything that stops it — a detached element, a
 * cross-origin frame, a CSP that blocks `evaluate` — leaves the field off
 * rather than recording a number that is not true. A count is never zero: the
 * hoisted wait proved a match existed, so a zero would describe the gap
 * between the wait and the measurement, not the action.
 */
export interface ActionTargeting {
  /** Every match, hidden included. This is strict mode's number — the one
   *  that predicts whether the generated entry will throw. */
  matchCount?: number;
  /** Visible matches: what the runtime was actually choosing between when it
   *  took `.first()`. A different question from `matchCount` — whether the AI
   *  may have silently acted on the wrong element. */
  visibleMatchCount?: number;
  /** A selector for the element that was acted on, VERIFIED in page context
   *  (`querySelectorAll(sel).length === 1 && [0] === el`). Absent when even a
   *  positional path does not address it uniquely. */
  resolvedSelector?: string;
  /**
   * How `resolvedSelector` was arrived at — a semantic handle
   * (`'attribute'`), that handle qualified by an addressable ancestor
   * (`'scoped'`), or an `nth-of-type` chain (`'positional'`).
   *
   * Reported rather than left to be inferred from the string, because
   * generation has a rule that turns on it: a positional path pins THIS run's
   * row number into a committed file, so when the step or a parameter names
   * what distinguishes the element the entry must build its locator from
   * `step.getVar(...)` instead. "Does it contain `nth-of-type`" is not that question
   * — an author's own selector can, and a scoped handle never does.
   *
   * Travels with `resolvedSelector`: both present, or neither.
   */
  resolvedBy?: ResolvedBy;
  /**
   * The KINDS of element a `read` or `count` matched: each one's tag name and
   * its class names, leaving out generated-looking ones (any with a digit) —
   * `span.account-name` (docs/specs/SPEC-codebehind-robustness.md §6.6).
   *
   * What a read compiled from the recording carries as its self-check: on
   * replay, a match of any other kind means the selector no longer reads what
   * the run read — failure B's selector matched `span.account-number` beside
   * every `span.account-name`. Measured with the rest of `targeting`, and only
   * for reads and counts.
   */
  kinds?: string[];
  /**
   * The selector the runtime acted on because the one the model wrote named
   * a role whose name matched nothing exactly (SPEC-web-survey-fixes.md
   * §2.34): the role narrowed by the element's visible text, or by its name
   * with case and symbols around it ignored. Present only then.
   *
   * What it tells generation: the transcript's selector matches nothing on
   * replay, because nothing replays this fallback. A compiled entry has to use
   * `resolvedSelector`, or locate the element the way this does.
   */
  roleNameFallback?: string;
}

/** How a `resolvedSelector` was arrived at. See {@link ActionTargeting}. */
export type ResolvedBy = 'attribute' | 'scoped' | 'positional';

/** What the browser-side selector builder returns. */
interface ResolvedSelection {
  selector: string;
  by: ResolvedBy;
}

/** Per-call switches for {@link executeAction}. */
export interface ExecuteActionOptions {
  /**
   * Measure {@link ActionTargeting} for this action.
   *
   * Compile-only: generation is the only consumer, and an ordinary run would
   * pay two CDP round-trips per element-targeting action forever for data
   * nobody reads. The caller gates it on the same flag `captureStepContext`
   * uses (stories/codebehind-selector-ambiguity.md §"Where the measurement
   * goes").
   */
  measure?: boolean;
  /**
   * `browser.ambiguousTarget`. Under `'fail'` a singular action whose
   * selector resolves to more than one candidate does not act: it returns a
   * failure carrying the count, which reaches the AI next turn.
   *
   * "Candidate" means whatever the action's OWN `.first()` chose from —
   * visible matches for click/type/select/hover/upload, every match for a
   * singular `read`. See the gate in `executeAction`.
   *
   * This is the stated exception to the compile-only gate: it decides by
   * reading a count, so it cannot work without one. Setting it turns on that
   * ONE count whatever the mode; `resolvedSelector` stays compile-only.
   */
  ambiguousTarget?: 'first' | 'fail' | undefined;
  /**
   * Where a file named in an `upload` step lives: the test file's folder, and
   * the project root that fences it (stories/upload-action.md §3). Absent on
   * a run with no test file — Flick never sends one — in which case only an
   * absolute path can resolve.
   */
  uploadPaths?: UploadPathContext | undefined;
  /**
   * §7.6's secret set for THIS run, used for one thing: the cell text in a
   * §7.10 sketch.
   *
   * The sketch is the only place the extractor quotes page content back out
   * of the page, and it goes to a model call and the debug log, so it is
   * masked where it is built rather than where it is printed. Nothing else in
   * this file reads it; the records are masked at the surfaces that show them,
   * as they always were.
   */
  maskValues?: string[] | undefined;
  /**
   * Which §7.10 layer produced the `mapping` this action carries — `model`
   * or `memo` — for the summary line's parenthetical alone. The caller is the
   * only one that knows: by the time a mapping reaches the extractor, a fresh
   * answer and a remembered one are the same object. Absent means `model`.
   */
  structureSource?: TableStructureSource | undefined;
  /**
   * Collect the {@link ActionTargeting.kinds} of what a `read` or `count`
   * matched, onto the result's `kinds`, without the rest of the measurement —
   * what a read compiled from the recording checks itself against on replay
   * (docs/specs/SPEC-codebehind-robustness.md §6.6). `measure` collects them
   * too, onto `targeting`.
   */
  kinds?: boolean | undefined;
  /**
   * Before a `count` or a `read` of every match, wait until the number of
   * matches has stopped changing for `quietMs`, within `timeoutMs`
   * (docs/specs/SPEC-codebehind-robustness.md §6.6). Neither waits for
   * elements on its own — each returns whatever matches at that instant — and
   * the AI's read always came after the page had settled and the model had
   * thought; a compiled one arrives milliseconds after the step before it.
   */
  settleMatches?: { quietMs: number; timeoutMs: number } | undefined;
}

/** Result of executing a single Playwright action */
export interface ActionExecutionResult {
  success: boolean;
  error?: string;
  /** The selector that was used (for failure context on retry) */
  failedSelector?: string;
  /** How many elements matched the selector (0 = not found, >1 = ambiguous) */
  matchCount?: number;
  /** Value captured by a "read" or "count" action (single-value path). */
  capturedValue?: string;
  /** List of values captured by a "read multiple: true" action (one per
   *  matched element). Mutually exclusive with `capturedValue`. The
   *  step-executor JSON-encodes this into the parameter map so downstream
   *  tools can decode it via array-typed parameters. */
  capturedValues?: string[];
  /**
   * Row records captured by a `readTable` action — one flat object per visible
   * data row, `_row` first (SPEC-structured-table-reads.md §7.1).
   *
   * Deliberately NOT a widening of `capturedValues`: keeping the flat and the
   * structured capture distinct is what stops an existing consumer treating a
   * record as a string it can print.
   */
  capturedRecords?: Array<Record<string, string>>;
  /** What the runtime found at the instant it acted. Absent unless the caller
   *  asked to measure, and absent whenever measurement was impossible. */
  targeting?: ActionTargeting;
  /** `navigate` only: the HTTP status of the document it landed on
   *  (SPEC-web-survey-fixes.md §2.35). */
  httpStatus?: number;
  /** The kinds of element a `read` or `count` matched, when the caller asked
   *  for them ({@link ExecuteActionOptions.kinds}). */
  kinds?: string[];
  /**
   * Do not retry this failure, and do not treat it as a broken plan: the
   * action was never attempted because the file it names is missing, is a
   * folder, or sits outside the project. Re-planning cannot conjure a file,
   * so a retry only burns an AI turn (stories/upload-action.md §5).
   */
  retryable?: false;
  /**
   * The action was refused for its TYPE, before anything touched the page:
   * a type the framework does not have (the model's mistake — retryable), or
   * one the step loop runs and this function never should (a framework bug —
   * not retryable). Either way the selector was never tried, so the step loop
   * keeps it out of the retry's "Failed selectors … choose a different
   * selector" line — which would steer the model off a target it had right,
   * when the only thing wrong was the action's name — while the failure line
   * itself still names it.
   */
  typeRefused?: true;
  /** How an `upload` delivered its files: straight onto an `<input
   *  type="file">`, or by answering the picker a control opened. Recorded so a
   *  compiled code-behind entry writes the shape that actually worked. */
  upload?: { via: UploadRoute };
  /**
   * What the region holds, on a `readTable` that failed for a SHAPE reason
   * (§7.10) — nothing with data rows under it, two things with them, no
   * header found by any path, two header-only candidates, or a pairing whose
   * widths disagree.
   *
   * Its presence is the signal that the model may be asked ONE question about
   * the structure. Absent on every other refusal, because asking about a
   * header typo or a short row would be asking for permission to read a
   * different column.
   */
  sketch?: TableSketch;
}

/** Which of the two upload routes ran. */
export type UploadRoute = 'input' | 'chooser';

/**
 * Execute a single AI action via Playwright.
 * Maps each action type to the corresponding Playwright API call.
 */
export async function executeAction(
  page: Page,
  action: AIAction,
  baseUrl?: string,
  signal?: AbortSignal,
  options?: ExecuteActionOptions,
): Promise<ActionExecutionResult> {
  logger.subAction(action.description);

  // ── The action's type, before anything touches the page ───────────────────
  // A type the framework does not have fails HERE rather than in the switch's
  // default, because everything between here and the switch — iframe
  // promotion's `count()`, the frame check, the hoisted measurement wait —
  // talks to the browser on behalf of an action that is not going to run. It
  // used to reach a default that warned and answered `success: true`, so
  // "Tick the I agree box" answered with `check` passed with the box unticked
  // and the next step failed on the wrong line. The parser keeps such an
  // action on purpose (the transcript shows what the model sent), and the step
  // loop refuses the whole turn before calling here; this is the same answer
  // for any other caller, so no path gets the old silent pass back.
  if (!isKnownActionType(action.action)) {
    return refuseUnknownType(action.action);
  }

  // ── Upload paths, before anything touches the page ────────────────────────
  // Deliberately the FIRST thing an upload does. Everything below — selector
  // sanitising, iframe promotion (a `count()`), the frame checks, the hoisted
  // measurement wait — runs against the browser, so resolving later would let a
  // compile run spend the whole 10s budget on a slightly-wrong selector before
  // noticing the file was never there. Returning (rather than throwing) also
  // keeps the catch below out of it, so no `matchCount` is recorded and the
  // retry prompt cannot claim "No elements matched this selector" about a file
  // that simply does not exist.
  let uploadFiles: string[] | undefined;
  if (action.action === 'upload') {
    const resolved = await resolveUploadPaths(uploadPathsOf(action), options?.uploadPaths ?? {});
    if (!resolved.ok) {
      logger.error(`Action failed [upload]: ${resolved.error}`);
      return {
        success: false,
        error: resolved.error,
        retryable: false,
        ...(action.selector !== undefined && { failedSelector: action.selector }),
      };
    }
    uploadFiles = resolved.absolute;
  }

  // Auto-promote iframe selectors that the AI accidentally placed in the selector
  // field instead of the frame field. If the first segment of the selector matches
  // an iframe inside the current frame context, move it to the frame chain.
  let effectiveFrame = action.frame;
  let effectiveSelector = action.selector ? sanitizeCssSelector(action.selector) : action.selector;
  if (effectiveSelector) {
    const promoted = await promoteIframeFromSelector(page, effectiveFrame, effectiveSelector);
    effectiveFrame = promoted.frame;
    effectiveSelector = promoted.selector;
  }

  // Resolve frame context once — used by all locator-based actions and the error handler
  const root = resolveLocatorRoot(page, effectiveFrame);
  /** What the role-name fallback found the role to have, for a timeout (§2.34). */
  let describeRoleNameMiss: (() => Promise<string>) | undefined;
  /** The selector the role-name fallback acted on instead, when it did (§2.34). */
  let roleNameFallback: string | undefined;
  if (effectiveSelector) {
    // A plural action takes every match, so several reading the name is its
    // answer rather than an ambiguity.
    const plural = action.action === 'count'
      || action.action === 'readTable'
      || (action.action === 'read' && action.multiple === true);
    const roleName = await resolveRoleName(root, effectiveSelector, { plural, hiddenTargets: action.action === 'upload' });
    if (roleName.refusal !== undefined) {
      // Several elements read the name on screen. Acting on the first would be
      // a guess, so nothing runs and the retry is told which names to pick from.
      logger.error(`Action refused [${action.action}]: ${roleName.refusal}`);
      return {
        success: false,
        error: roleName.refusal,
        failedSelector: effectiveSelector,
        ...(roleName.matches !== undefined && { matchCount: roleName.matches }),
      };
    }
    if (roleName.selector !== effectiveSelector) roleNameFallback = roleName.selector;
    effectiveSelector = roleName.selector;
    describeRoleNameMiss = roleName.describeMiss;
  }
  if (effectiveFrame) {
    // For nested frames ("A >> B" or "A B"), validate the outermost iframe exists on the page
    const outerSelector = effectiveFrame.includes('>>')
      ? effectiveFrame.split('>>')[0]!.trim()
      : effectiveFrame.trim().split(/\s+/)[0]!;
    const iframeCount = await page.locator(outerSelector).count();
    if (iframeCount === 0) {
      logger.warn(`iframe not found on page: ${outerSelector}`);
    } else {
      const selectorCount = effectiveSelector
        ? await root.locator(effectiveSelector).count().catch(() => 0)
        : null;
      logger.debug(
        `Action scoped to frame: ${effectiveFrame} (${iframeCount} iframe match${iframeCount > 1 ? 'es' : ''}`
        + (selectorCount !== null ? `, ${selectorCount} element match${selectorCount !== 1 ? 'es' : ''} for "${effectiveSelector}")` : ')'),
      );
    }
  }

  // Build an effective action with promoted frame/selector for use in execution
  const eff: AIAction = {
    ...action,
    ...(effectiveFrame !== undefined ? { frame: effectiveFrame } : {}),
    ...(effectiveSelector !== undefined ? { selector: effectiveSelector } : {}),
  };

  // Whether the caller wants the full measurement, and whether it wants the
  // ambiguity gate. The gate needs `visibleMatchCount` on any run, so it turns
  // the cheap half on by itself.
  const wantMeasure = options?.measure === true;
  const wantGate = options?.ambiguousTarget === 'fail';
  /** Collect what kinds of element a read or count matched (§6.6). */
  const wantKinds = wantMeasure || options?.kinds === true;
  /** What the runtime found. Absent unless we measured and the numbers held. */
  let targeting: ActionTargeting | undefined;
  /** What is left of the action's own budget after the wait hoisted out of it. */
  let remainingMs: number | undefined;
  /** Which route an `upload` took, for the transcript a compile reads. */
  let uploadRoute: UploadRoute | undefined;
  /** The HTTP status a `navigate` landed on (§2.35). */
  let httpStatus: number | undefined;

  try {
    // ── Measurement (stories/codebehind-selector-ambiguity.md) ──────────────
    // Hoist the wait the action was going to do anyway, so the count is taken
    // at the instant Playwright would have acted. Measuring cold at T0 would
    // record `matchCount: 0` for the very common case where the element
    // renders 400ms later and the action then succeeds — a confident lie,
    // worse than no data. After the wait resolves at least one match exists by
    // construction, so "zero" is not a measurement outcome at all: it is the
    // wait timing out, which throws into the catch below exactly as the
    // action's own wait would have.
    const singular = wantMeasure || wantGate ? singularTargetOf(root, eff) : null;
    if (singular && eff.selector !== undefined) {
      const startedAt = Date.now();
      await singular.target.waitFor({ state: singular.state, timeout: singular.budgetMs });
      targeting = await measureTargeting(root, eff.selector, singular, wantMeasure);
      // The hoisted wait must not add a SECOND timeout budget: giving it a
      // fresh one would double how long a failing selector takes to report.
      // Time it, and pass the remainder to the action.
      remainingMs = Math.max(singular.budgetMs - (Date.now() - startedAt), MIN_ACTION_TIMEOUT_MS);

      // "Did this action's own `.first()` pick from more than one candidate?"
      // — so each action is gated on the count matching ITS tolerance.
      // click/type/select/hover/upload filter to `visible=true` first, so they
      // gate on the visible count; a singular `read` takes `.first()` over
      // every match, hidden included, so it gates on the total. Gating a read
      // on the visible count would let it silently capture from a hidden first
      // match, which is worse than the click case: it poisons a variable
      // instead of failing loudly.
      //
      // `upload` is its own case. It waits on `attached`, because a hidden
      // <input type="file"> is a legitimate target — but it still PREFERS a
      // visible match and only falls back to a hidden file input, so neither
      // stored count describes the set it chose from. Worse, on a gate-only run
      // `measureTargeting` never takes the visible count for an `attached`
      // action, and it strips a zero one, so reading either off `targeting`
      // would silently disable the gate. Measure both here, on the gate's own
      // terms, mirroring the executor's target rule exactly.
      let candidates =
        singular.state === 'visible' ? targeting?.visibleMatchCount : targeting?.matchCount;
      let gatedOnVisible = singular.state === 'visible';
      let uploadFallback = false;
      if (eff.action === 'upload') {
        const counts = await uploadCandidateCounts(root, eff.selector);
        gatedOnVisible = counts.visible > 0;
        uploadFallback = !gatedOnVisible;
        candidates = gatedOnVisible ? counts.visible : counts.hiddenFileInputs;
      }
      if (candidates !== undefined && candidates > 1) {
        const what = uploadFallback
          ? 'hidden file inputs'
          : gatedOnVisible
            ? 'visible elements'
            : 'elements';
        const took = uploadFallback
          ? `${eff.action} took the first hidden file input`
          : gatedOnVisible
            ? `${eff.action} took the first visible one`
            : `${eff.action} took the first of them, hidden included`;
        if (wantGate) {
          // Don't let the AI resolve ambiguity by accident. The failure
          // carries the count into `collectedFailures`, so the next turn is
          // told its selector was ambiguous and re-plans.
          const message =
            `${candidates} ${what} matched "${eff.selector}" — use a more specific selector `
            + `(browser.ambiguousTarget is "fail")`;
          logger.error(`Action refused [${eff.action}]: ${message}`);
          return {
            success: false,
            error: message,
            failedSelector: eff.selector,
            matchCount: candidates,
            ...(targeting !== undefined && { targeting }),
          };
        }
        logger.warn(`"${eff.selector}" matched ${candidates} ${what} — ${took}`);
      }
    }

    // §2.34: the selector as written matches nothing on replay, so a compile
    // must see what the runtime acted on instead.
    if (wantMeasure && roleNameFallback !== undefined) targeting = { ...(targeting ?? {}), roleNameFallback };

    switch (eff.action) {
      case 'click':
        await executeClick(page, root, eff, remainingMs);
        break;

      case 'type':
        await executeType(page, root, eff, remainingMs);
        break;

      case 'dialog': {
        const late = executeDialog(page, eff);
        if (late !== undefined) {
          logger.warn(`Action refused [dialog]: ${late}`);
          return { success: false, error: late };
        }
        break;
      }

      case 'select':
        await executeSelect(root, eff, remainingMs);
        break;

      case 'navigate':
        // Navigation always operates at the page level — iframes don't navigate independently
        httpStatus = await executeNavigate(page, eff, baseUrl);
        break;

      case 'back':
      case 'forward':
        // Page-level for the same reason navigate is: session history belongs
        // to the tab, and a frame does not navigate independently
        // (docs/specs/SPEC-browser-history.md §4.2). `page`, never `root` —
        // a frame-switched run must still move the whole tab.
        await executeHistory(page, eff);
        break;

      case 'reload':
        // Page-level for back/forward's reason: the tab reloads, not a frame.
        await executeReload(page);
        break;

      case 'drag':
        await executeDrag(page, root, eff, remainingMs);
        break;

      case 'upload':
        uploadRoute = await executeUpload(page, root, eff, uploadFiles ?? [], remainingMs);
        break;

      case 'hover':
        await executeHover(root, eff, remainingMs);
        break;

      case 'wait':
        await executeWait(page, root, eff, signal);
        break;

      case 'scroll':
        await executeScroll(page, root, eff);
        break;

      case 'switchFrame':
        // Superseded by the per-action "frame" field — kept for backward compatibility
        logger.debug(`switchFrame ignored — use the "frame" field on individual actions instead`);
        break;

      case 'dismiss':
        await executeDismiss(root, eff);
        break;

      case 'keyboard':
      case 'keypress':
        // Keyboard events go to the focused element — always page-level
        await executeKeyboard(page, eff);
        break;

      case 'read': {
        if (eff.multiple) {
          // Plural actions are exempt by construction: `evaluateAll` runs
          // across every match, so many matches is the PURPOSE. The count is
          // free here (the page already returned every element), and there is
          // no `resolvedSelector` because there is no single element.
          if (options?.settleMatches) await settleMatchCount(root, requireSelector(eff), options.settleMatches, signal);
          const list = await executeReadMultiple(root, eff);
          const kinds = wantKinds ? await matchedKinds(root, requireSelector(eff)) : undefined;
          return {
            success: true,
            capturedValues: list.values,
            ...(wantMeasure && {
              targeting: {
                matchCount: list.matchCount,
                ...(kinds !== undefined && { kinds }),
                ...(roleNameFallback !== undefined && { roleNameFallback }),
              },
            }),
            ...(kinds !== undefined && { kinds }),
          };
        }
        const captured = await executeRead(root, eff, remainingMs);
        // The kind of the element read: the first match, as the read took.
        const kinds = wantKinds ? await matchedKinds(root, requireSelector(eff), 1) : undefined;
        const measured = targeting !== undefined || (wantMeasure && kinds !== undefined)
          ? { ...(targeting ?? {}), ...(kinds !== undefined && { kinds }) }
          : undefined;
        return {
          success: true,
          capturedValue: captured,
          ...(measured !== undefined && { targeting: measured }),
          ...(kinds !== undefined && { kinds }),
        };
      }

      // Structured table read (SPEC-structured-table-reads.md §7). Plural by
      // construction like `read multiple`, and exempt from the ambiguity gate
      // for a stronger reason: it runs its OWN uniqueness check, which never
      // takes `.first()` (§7.2). Observational, so no post-action settle —
      // `readTable` is absent from MUTATING_ACTIONS in step-executor.ts.
      case 'readTable': {
        const columns = eff.columns ?? [];
        const table = await readTableRecords(root, {
          selector: requireSelector(eff),
          columns,
          ...(eff.limit !== undefined && { limit: eff.limit }),
          // §7.10: a validated structure the runtime owns, replayed here. The
          // action layer does not ASK the question — a shape refusal leaves
          // here as a `TableShapeError` and the step executor decides — it
          // only applies an answer that has already been through it.
          ...(eff.mapping !== undefined && { mapping: eff.mapping }),
          ...(options?.maskValues !== undefined && { maskValues: options.maskValues }),
          ...(options?.structureSource !== undefined
            && { structureSource: options.structureSource }),
        });
        logger.info(formatTableReadSummary(table, columns.length, eff.as, eff.limit));
        return { success: true, capturedRecords: table.records };
      }

      case 'count': {
        // Also plural, and its count IS its result — free, and never gated.
        if (options?.settleMatches) await settleMatchCount(root, requireSelector(eff), options.settleMatches, signal);
        const counted = await executeCount(root, eff);
        const total = Number(counted);
        const kinds = wantKinds ? await matchedKinds(root, requireSelector(eff)) : undefined;
        return {
          success: true,
          capturedValue: counted,
          ...(wantMeasure && Number.isFinite(total) && {
            targeting: {
              matchCount: total,
              ...(kinds !== undefined && { kinds }),
              ...(roleNameFallback !== undefined && { roleNameFallback }),
            },
          }),
          ...(kinds !== undefined && { kinds }),
        };
      }

      case 'noop':
        logger.debug(`noop action: ${eff.description}`);
        break;

      // ── Types the step loop runs, never this function ─────────────────────
      // Each needs something this layer does not have: the step's authored
      // text (`return` and `fail` — stories/step-flow-control.md,
      // stories/step-failure-outcomes.md), the AI client (`assert`), the
      // person at the console (`prompt`), the page and browser trackers (the
      // tab and browser actions), the API response store and CSRF cache
      // (`api_call`, `extract_csrf`, `extract_value`), or the next turn's
      // prompt (`find`, `expand`). So `executeStepAttempt` intercepts every one
      // before it calls here. Had one arrived anyway, seven would have
      // answered `success: true` from a no-op case here and the other eight
      // from the default, having done nothing — the silent pass the
      // unknown-type refusal closes, through another door. Named one by one,
      // so the `never` below makes a new type choose between running here and
      // being intercepted there.
      case 'prompt':
      case 'return':
      case 'fail':
      case 'assert':
      case 'openPage':
      case 'switchPage':
      case 'closePage':
      case 'openBrowser':
      case 'switchBrowser':
      case 'closeBrowser':
      case 'api_call':
      case 'extract_csrf':
      case 'extract_value':
      case 'find':
      case 'expand':
        return refuseStepLoopType(eff.action);

      default: {
        // Every ActionType has a case above, and `never` keeps it that way: a
        // type added to the union without one does not compile. At run time
        // the check at the top of this function has already refused any
        // string the parser kept; this gives the same answer to a caller that
        // got here some other way, instead of the old warn-and-succeed.
        const unhandled: never = eff.action;
        return refuseUnknownType(unhandled);
      }
    }

    return {
      success: true,
      ...(targeting !== undefined && { targeting }),
      ...(uploadRoute !== undefined && { upload: { via: uploadRoute } }),
      ...(httpStatus !== undefined && { httpStatus }),
    };
  } catch (err) {
    // A run abort (issue 022) must propagate as a throw, not be swallowed into a
    // failed-action result — the step loop / withRetry recognise it and end the
    // run as `aborted` (issue 020), instead of recording a spurious failed
    // action. `executeWait`'s abort race throws an AbortError; any other error
    // raised while the run is already aborting is likewise an abort artifact.
    if (signal?.aborted) {
      throw err;
    }

    let errorMessage = err instanceof Error ? err.message : String(err);

    // Count how many elements matched the selector — use the same frame root so the
    // count is meaningful (0 in the frame, not 0 in the main page for the wrong reason)
    let matchCount: number | undefined;
    if (eff.selector) {
      try {
        matchCount = await root.locator(eff.selector).count();
      } catch {
        // Selector itself may be invalid — leave matchCount undefined
      }
    }

    // A role name that still matches nothing: say what the role does have, so
    // the retry picks a name from the page instead of guessing (§2.34).
    if (matchCount === 0 && describeRoleNameMiss !== undefined) {
      const listing = await describeRoleNameMiss().catch(() => '');
      if (listing) errorMessage = `${listing}\n${errorMessage}`;
    }
    logger.error(`Action failed [${eff.action}]: ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
      // §7.10's sketch, carried on the RESULT and not only on the error: this
      // catch turns every throw into a result, so a caller that only looked at
      // what was thrown would never see one. The sketch rides along exactly
      // when the refusal was a shape reason, which is what tells a caller it
      // may spend a model call on the structure.
      ...(err instanceof TableShapeError && err.sketch !== null && { sketch: err.sketch }),
      // A history move (or a reload) that did not happen cannot be fixed by
      // re-planning, so a retry only burns an AI turn — the upload path takes the same
      // flag for the same reason. Worse here: the re-ask hands the model a
      // failure it can satisfy with a `navigate` or a `noop`, turning the
      // loud failure §4.3 chose back into the quiet pass §2 is about.
      ...((eff.action === 'back' || eff.action === 'forward' || eff.action === 'reload') && {
        retryable: false as const,
      }),
      ...(eff.selector !== undefined && { failedSelector: eff.selector }),
      ...(matchCount !== undefined && { matchCount }),
      ...(targeting !== undefined && { targeting }),
    };
  }
}

/**
 * The model named an action the framework does not have. Retryable: a caller
 * that retries puts the types the model may send instead into the retry prompt
 * (`buildRetryContext`), so the model can answer with a real one. The error
 * itself is the short sentence a person reads.
 */
function refuseUnknownType(type: unknown): ActionExecutionResult {
  logger.error(`Action refused: unknown action type ${JSON.stringify(String(type))}`);
  return { success: false, error: unknownActionTypeError(type), typeRefused: true };
}

/**
 * A known type that only the step loop can run reached `executeAction` — see
 * the case group at the end of its switch. A framework bug rather than a
 * model mistake, so NOT retryable: a re-plan cannot fix the wiring, and asking
 * the model to try again is how a workaround that does nothing gets found.
 */
function refuseStepLoopType(type: ActionType): ActionExecutionResult {
  const error =
    `"${type}" is run by the step loop, never by executeAction — reaching executeAction ` +
    'with it is a framework bug, and nothing was done';
  logger.error(`Action refused [${type}]: ${error}`);
  return { success: false, error, typeRefused: true, retryable: false };
}

/**
 * Per-action Playwright budgets, named because the measurement borrows from
 * them (stories/codebehind-selector-ambiguity.md §"Measurement 1"). Where an
 * action makes two calls, the hoisted wait draws on the FIRST one's budget and
 * hands back the remainder, so the total wall clock of a failing selector is
 * what it was before — not double.
 */
const CLICK_TIMEOUT_MS = 10_000;
const TYPE_CLEAR_TIMEOUT_MS = 5_000;
const TYPE_FILL_TIMEOUT_MS = 10_000;
const SELECT_BY_VALUE_TIMEOUT_MS = 5_000;
const SELECT_BY_LABEL_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 10_000;
const HOVER_TIMEOUT_MS = 10_000;
/** A drag waits for both ends to be actionable, then moves; click's budget. */
const DRAG_TIMEOUT_MS = 10_000;
/** `read` passes no timeout today, so its budget is Playwright's own default. */
const READ_TIMEOUT_MS = 30_000;
/** Floor on what the hoisted wait hands back, so a slow measurement can never
 *  starve the action it is telemetry for. */
const MIN_ACTION_TIMEOUT_MS = 1_000;
/** All the patience the measurement itself gets. It is telemetry: an element
 *  that detached in the gap should cost milliseconds and be forgotten, not
 *  spend Playwright's default 30s retrying before we swallow the throw. */
const MEASUREMENT_TIMEOUT_MS = 2_000;

/**
 * Click, double-click or right-click `selector` (SPEC-web-survey-fixes.md
 * §2.2, §2.5, §2.10).
 *
 * Two recoveries, each for one measured failure and each narrow on purpose:
 *  - a styled checkbox or radio whose `<input>` is hidden gets its label or a
 *    visible ancestor clicked instead, because a hidden input never becomes
 *    clickable and the click would only time out. Not one hidden with what is
 *    around it — a collapsed section, a closed menu: that click waits as any
 *    other, and its failure says to open the container first;
 *  - a click blocked by an AD gets the page's ads hidden and one more try.
 *    Only ad markup counts: a real overlay still fails the click, which is
 *    what tells the author the page is in the way.
 */
async function executeClick(
  page: Page,
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  const hold = action.clickCount === 2 ? 0 : (action.holdMs ?? 0);
  const options = {
    // The hold is part of the click, so it is added to the time allowed.
    timeout: (timeoutMs ?? CLICK_TIMEOUT_MS) + hold,
    ...(action.button !== undefined && action.button !== 'left' && { button: action.button }),
    // Playwright's `delay` is the time between mousedown and mouseup (§2.24).
    ...(hold > 0 && { delay: hold }),
  };
  const press = (target: Locator): Promise<void> =>
    action.clickCount === 2 ? target.dblclick(options) : target.click(options);

  const matches = root.locator(selector);
  const stand = await standInForHiddenToggle(root, matches);
  if (stand !== null) {
    logger.info(`"${selector}" is a hidden checkbox or radio — clicking its visible label instead`);
    await press(stand);
    return;
  }

  const target = matches.locator('visible=true').first();
  try {
    await press(target);
  } catch (err) {
    throw await explainEnclosedToggle(selector, matches, err);
  }
}

/**
 * When every match of a click's selector is a HIDDEN checkbox or radio, the
 * element a person would click instead: its `<label for>`, the `<label>` it
 * sits in, or the nearest of its three closest ancestors that is visible.
 * `null` when the selector matches something else, matches nothing yet (the
 * normal click then waits for it), or has a visible match — and no ancestor
 * when the toggle is hidden with what is around it (§2.10), because then the
 * nearest visible ancestor is a section's frame, not the toggle's box.
 */
async function standInForHiddenToggle(root: Page | FrameLocator, matches: Locator): Promise<Locator | null> {
  try {
    const total = await matches.count();
    if (total === 0) return null;
    if ((await matches.locator('visible=true').count()) > 0) return null;
    const input = matches.first();
    const toggle = await hiddenToggleOf(input);
    if (toggle === null) return null;
    const candidates: Locator[] = [];
    // From the ROOT, which is the input's own frame. A chained XPath that
    // starts with // is relative to the element in Playwright, so it would
    // only ever search inside the input.
    if (toggle.id !== '') {
      const quoted = toggle.id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      candidates.push(root.locator(`label[for="${quoted}"]`));
    }
    candidates.push(input.locator('xpath=ancestor::label[1]'));
    if (toggle.enclosed) {
      logger.debug(`hidden ${toggle.type} inside something hidden — its ancestors do not stand in for it`);
    } else {
      // Never <body> or <html>: clicking the page itself "succeeds" and does nothing.
      for (let depth = 1; depth <= 3; depth++) {
        candidates.push(input.locator(`xpath=ancestor::*[not(self::body) and not(self::html)][${depth}]`));
      }
    }
    for (const candidate of candidates) {
      const first = candidate.first();
      if (!(await first.isVisible().catch(() => false))) continue;
      // "Visible" includes the 1×1 px clip wrapper accessible toggles hide
      // their input in (PrimeFaces' ui-helper-hidden-accessible): something
      // else covers it, so the click timed out (SPEC-web-survey-fixes.md
      // §2.32). Only stand in with something a person could click.
      const box = await first.boundingBox().catch(() => null);
      if (box !== null && box.width >= 4 && box.height >= 4) return first;
    }
  } catch {
    // Anything unexpected leaves the ordinary click to report what is wrong.
  }
  return null;
}

/** What a click needs to know about a hidden checkbox or radio (§2.10). */
export interface HiddenToggle {
  /** `checkbox` or `radio`. */
  type: string;
  /** The input's id; '' when it has none. */
  id: string;
  /**
   * Hidden with what is around it — a collapsed section, a closed menu, an
   * inactive tab — rather than alone behind a box or label drawn in its
   * place. True when its own `<label>` is hidden too, or when the outermost
   * hidden element around it holds anything but the input.
   */
  enclosed: boolean;
  /** What to open to show it, outermost first, named the way `find` names
   *  collapsed sections (§2.28). Empty when the page names none. */
  collapsedUnder: string[];
}

/**
 * {@link HiddenToggle} for `input`, or `null` when it is not a checkbox or
 * radio. It does not ask whether the input is hidden; the caller knows.
 */
export async function hiddenToggleOf(input: Locator): Promise<HiddenToggle | null> {
  return input.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el: any) => {
      if (el.tagName !== 'INPUT' || (el.type !== 'checkbox' && el.type !== 'radio')) return null;
      const w = globalThis as any;
      const body = w.document.body;
      const oneLine = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim().substring(0, 60);
      const rendered = (node: any): boolean => typeof node.checkVisibility === 'function'
        ? node.checkVisibility({ visibilityProperty: true })
        : node.getClientRects().length > 0 && w.getComputedStyle(node).visibility === 'visible';
      const inert = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
      // Anything in `box` but the input, the wrappers it sits in, and hidden
      // form fields: text, a label, a drawn box, another control.
      const holdsMore = (box: any): boolean => {
        for (const other of Array.from(box.querySelectorAll('*')) as any[]) {
          if (other.contains(el) || inert.has(other.tagName)) continue;
          if (other.tagName === 'INPUT' && other.type === 'hidden') continue;
          return true;
        }
        const texts = w.document.createTreeWalker(box, 4 /* NodeFilter.SHOW_TEXT */);
        for (let t = texts.nextNode(); t !== null; t = texts.nextNode()) {
          if (!inert.has(t.parentElement?.tagName) && t.data.trim() !== '') return true;
        }
        return false;
      };

      // A styled toggle hides its input and shows its label in its place. A
      // label too small to click still says the control is on screen.
      const labels = Array.from(el.labels ?? []) as any[];
      const labelHidden = labels.length > 0 && !labels.some(rendered);
      // The outermost hidden element around the input: the input itself, or a
      // wrapper of its own, when it is hidden alone.
      let outer = el;
      for (let cur = el.parentElement; cur && cur !== body; cur = cur.parentElement) {
        if (w.getComputedStyle(cur).display === 'contents') continue;
        if (rendered(cur)) break;
        outer = cur;
      }

      // What a person opens: each container that hides the input and holds
      // more than it, named as §2.28 names one — by what controls it (an
      // accordion header's or a tab's `aria-controls`), what labels it, a
      // closed <details>' summary, else the text beside it in its parent.
      const nameOf = (box: any): string => {
        if (box.tagName === 'DETAILS') return oneLine(box.querySelector(':scope > summary')?.textContent);
        if (box.id) {
          const opener = w.document.querySelector(`[aria-controls~="${w.CSS.escape(box.id)}"]`);
          if (oneLine(opener?.textContent)) return oneLine(opener.textContent);
        }
        const labelledBy = String(box.getAttribute('aria-labelledby') ?? '').split(/\s+/)
          .map((ref: string) => (ref ? oneLine(w.document.getElementById(ref)?.textContent) : ''))
          .filter((name: string) => name !== '');
        if (labelledBy.length > 0) return oneLine(labelledBy.join(' '));
        if (box.getAttribute('aria-label')) return oneLine(box.getAttribute('aria-label'));
        for (const sibling of Array.from(box.parentElement?.children ?? []) as any[]) {
          if (sibling !== box && oneLine(sibling.textContent)) return oneLine(sibling.textContent);
        }
        return '';
      };
      const collapsedUnder: string[] = [];
      for (let child = el, cur = el.parentElement; cur && cur !== body; child = cur, cur = cur.parentElement) {
        const cs = w.getComputedStyle(cur);
        const closed = cs.display === 'none'
          || cur.hidden
          || cs.contentVisibility === 'hidden'
          // Inherited, so only where it starts.
          || (cs.visibility === 'hidden'
            && (cur.parentElement === null || w.getComputedStyle(cur.parentElement).visibility !== 'hidden'))
          || (cur.tagName === 'DETAILS' && !cur.open && child.tagName !== 'SUMMARY');
        if (!closed || !holdsMore(cur)) continue;
        const name = nameOf(cur);
        if (name !== '' && !collapsedUnder.includes(name)) collapsedUnder.unshift(name);
      }

      return {
        type: String(el.type),
        id: String(el.id ?? ''),
        enclosed: labelHidden || (outer !== el && holdsMore(outer)),
        collapsedUnder,
      };
    },
    undefined,
    { timeout: MEASUREMENT_TIMEOUT_MS },
  );
}

/**
 * The error for a click that failed on a checkbox or radio hidden inside
 * something hidden: what to open first, ahead of Playwright's own message.
 * Any other failure comes back as it was.
 */
async function explainEnclosedToggle(selector: string, matches: Locator, err: unknown): Promise<unknown> {
  try {
    if ((await matches.count()) === 0 || (await matches.locator('visible=true').count()) > 0) return err;
    const toggle = await hiddenToggleOf(matches.first());
    if (toggle === null || !toggle.enclosed) return err;
    const where = toggle.collapsedUnder.length === 0
      ? 'inside something hidden, such as a collapsed section, a closed menu or an inactive tab. Open that first'
      : `inside collapsed: ${toggle.collapsedUnder.join(' › ')}. `
        + (toggle.collapsedUnder.length > 1 ? 'Open those first, outermost first' : 'Open it first');
    const cause = err instanceof Error ? err.message : String(err);
    return new Error(
      `"${selector}" is a ${toggle.type} ${where}, then click the ${toggle.type}; `
        + `while it is hidden there is nothing on screen to click.\n${cause}`,
    );
  } catch {
    return err;
  }
}


/**
 * Inputs whose value cannot be empty, so `clear()` (a `fill('')`) throws
 * "Malformed value" on them, and `fill` replaces the value anyway (§2.7).
 */
const MALFORMED_WHEN_EMPTY = /Malformed value/i;

/** Text-like elements, where pressing End moves the caret and nothing else. */
const END_KEY_SAFE_TYPES = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'textarea', 'contenteditable']);

async function executeType(
  page: Page,
  root: Page | FrameLocator,
  action: AIAction,
  clearTimeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  let value = action.value ?? '';
  const locator = root.locator(selector).locator('visible=true').first();
  await uncoverForTyping(locator);
  // A custom element whose field lives in a CLOSED shadow root, a canvas
  // editor, anything `fill` refuses as "not an <input>": click it and type,
  // which is how a person reaches a field nothing can query
  // (SPEC-web-survey-fixes.md §2.27).
  if (!(await isFillable(locator))) {
    await locator.click({ timeout: clearTimeoutMs ?? TYPE_CLEAR_TIMEOUT_MS });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(value);
    return;
  }
  // Clear existing content first, then type. A colour, date or range input
  // cannot be empty, so its clear throws; `fill` replaces its value anyway.
  let clearable = true;
  try {
    await locator.clear({ timeout: clearTimeoutMs ?? TYPE_CLEAR_TIMEOUT_MS });
  } catch (err) {
    if (!MALFORMED_WHEN_EMPTY.test(err instanceof Error ? err.message : String(err))) throw err;
    clearable = false;
  }
  const kind = await inputKindOf(locator);
  if (kind === 'color') value = normaliseColour(value);
  if (kind === 'range') value = await clampToRange(locator, value);
  await locator.fill(value, { timeout: TYPE_FILL_TIMEOUT_MS });
  // `fill` fires `input` and nothing else. A filter or autocomplete that
  // listens for `keyup` never sees the change, which is how two of the
  // survey's sites kept every row after "Type test into the filter" (§2.3).
  // End fires keydown and keyup and leaves the text as it is.
  if (clearable && kind !== undefined && END_KEY_SAFE_TYPES.has(kind)) {
    await locator.press('End', { timeout: MEASUREMENT_TIMEOUT_MS }).catch(() => {});
  }
}

/**
 * Scroll a field out from under whatever covers it before typing
 * (SPEC-web-survey-fixes.md §2.20). `click` retries scroll alignments until
 * the element is what the pointer would hit; `fill` does not, so it types
 * into a field a person could not reach. A page that checks — the survey's
 * overlapped-element page clears the field on `input` when its centre is
 * covered — then loses every character. A person scrolls the field clear
 * first; so does this. Best effort: a field nothing will uncover is typed
 * into as before.
 */
async function uncoverForTyping(locator: Locator): Promise<void> {
  try {
    await locator.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) => {
        const root = el.getRootNode();
        const w = globalThis as any;
        const finder = typeof root.elementFromPoint === 'function' ? root : w.document;
        const reachable = (): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return true;
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          if (x < 0 || y < 0 || x > w.innerWidth || y > w.innerHeight) return false;
          const hit = finder.elementFromPoint(x, y);
          return hit === el || (hit !== null && el.contains(hit));
        };
        if (reachable()) return;
        for (const block of ['center', 'start', 'end']) {
          el.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' });
          if (reachable()) return;
        }
      },
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    // Best effort, never a reason to fail the type.
  }
}

/**
 * Can Playwright's `fill` take this element: an `<input>`, `<textarea>`,
 * `<select>` or contenteditable, or a `<label>` for one? True when it cannot
 * be told, so the ordinary path reports what is wrong.
 */
async function isFillable(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) => {
        const tag = String(el.tagName);
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
        return tag === 'LABEL' && el.control != null;
      },
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    return true;
  }
}

/** The element's input type in lower case, `textarea`, `contenteditable`,
 *  another tag name, or `undefined` when it cannot be read. */
async function inputKindOf(locator: Locator): Promise<string | undefined> {
  try {
    return await locator.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) => {
        if (el.tagName === 'INPUT') return String(el.type || 'text').toLowerCase();
        if (el.isContentEditable) return 'contenteditable';
        return String(el.tagName).toLowerCase();
      },
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }
}

/**
 * A range input refuses a value outside its own min and max as malformed, and
 * "set the slider to its maximum" was typed as 100 into a slider that stops at
 * 10. Clamp a number to the range, and read "max"/"min" as the ends.
 */
async function clampToRange(locator: Locator, value: string): Promise<string> {
  let bounds: { min: number; max: number };
  try {
    bounds = await locator.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) => ({
        min: el.min === '' ? 0 : Number(el.min),
        max: el.max === '' ? 100 : Number(el.max),
      }),
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    return value;
  }
  const word = value.trim().toLowerCase();
  if (/^max(imum)?$/.test(word)) return String(bounds.max);
  if (/^min(imum)?$/.test(word)) return String(bounds.min);
  const n = Number(word.replace(/%$/, ''));
  if (!Number.isFinite(n)) return value;
  return String(Math.min(bounds.max, Math.max(bounds.min, n)));
}

/**
 * A colour input accepts exactly `#rrggbb` in lower case. `#F00` and `F00`
 * are what a step says; anything else is passed through for Playwright to
 * refuse with its own message.
 */
export function normaliseColour(value: string): string {
  const hex = value.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${hex.split('').map((c) => c + c).join('')}`;
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  return value;
}

async function executeSelect(
  root: Page | FrameLocator,
  action: AIAction,
  byValueTimeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  const value = action.value ?? '';
  const locator = root.locator(selector).locator('visible=true').first();
  // A `<select multiple>` takes every option in one call (§2.8). Split only
  // when the element is a multi-select: a single select's option can contain
  // a comma ("Washington, DC").
  const wanted = action.values ?? (value.includes(',') ? value.split(',').map((v) => v.trim()) : undefined);
  if (wanted !== undefined && wanted.filter((v) => v !== '').length > 1 && (await isMultiSelect(locator))) {
    const resolved = await locator.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any, names: string[]) => {
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const options: any[] = Array.from(el.options);
        return names.map((name) => {
          const match = options.find((o) => o.value === name)
            ?? options.find((o) => norm(o.label || o.text) === norm(name))
            ?? options.find((o) => norm(o.value) === norm(name));
          return match ? String(match.value) : null;
        });
      },
      wanted.filter((v) => v !== ''),
      { timeout: byValueTimeoutMs ?? SELECT_BY_VALUE_TIMEOUT_MS },
    );
    const missing = wanted.filter((v) => v !== '').filter((_, i) => resolved[i] === null);
    if (missing.length > 0) {
      throw new Error(`select: the list has no option ${missing.map((m) => `"${m}"`).join(', ')}`);
    }
    await locator.selectOption(resolved as string[], { timeout: SELECT_BY_LABEL_TIMEOUT_MS });
    return;
  }
  try {
    // Try matching by value attribute first
    await locator.selectOption(value, { timeout: byValueTimeoutMs ?? SELECT_BY_VALUE_TIMEOUT_MS });
  } catch {
    // Fall back to matching by visible label text
    await locator.selectOption({ label: value }, { timeout: SELECT_BY_LABEL_TIMEOUT_MS });
  }
}

/** Is the element a `<select multiple>`? False when it cannot be read. */
async function isMultiSelect(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) => el.tagName === 'SELECT' && el.multiple === true,
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    return false;
  }
}

/** How long after a dialog opens a `dialog` action is still "late" for it. */
const LATE_DIALOG_WINDOW_MS = 60_000;

/**
 * Arm the answer for the next dialog (SPEC-web-survey-fixes.md §2.1), and
 * return an error when a dialog that this action meant to answer has already
 * been answered the other way — the answer cannot be changed after the fact,
 * but the model can open the dialog again now that the answer is set.
 * `undefined` when the arming stands on its own.
 */
function executeDialog(page: Page, action: AIAction): string | undefined {
  const accept = action.value !== 'dismiss';
  const context = page.context();
  armDialog(context, { accept, ...(action.text !== undefined && { text: action.text }) });
  const missed = takeUnreportedDefaultAnswers(context, Date.now() - LATE_DIALOG_WINDOW_MS).filter(
    (r) => r.type !== 'beforeunload' && ((r.answer === 'accepted') !== accept || (accept && action.text !== undefined)),
  );
  if (missed.length === 0) return undefined;
  return (
    'The dialog was already answered before this "dialog" action ran — a dialog is answered '
    + `the moment it opens:\n${describeDialogs(missed)}\n`
    + `The answer is now set to ${accept ? 'accept' : 'dismiss'}. Open the dialog again (click the same `
    + 'control) and it will be answered that way. Next time, send the "dialog" action BEFORE the click.'
  );
}

async function executeNavigate(page: Page, action: AIAction, baseUrl?: string): Promise<number | undefined> {
  let url = action.url ?? action.value ?? '';

  if (!url) {
    throw new Error('navigate action requires a url or value');
  }

  // Resolve relative URLs against baseUrl. A URL carrying its own navigable
  // scheme is absolute and passes through untouched — concatenating it onto
  // baseUrl produced `<base>/file:///…` (net::ERR_FILE_NOT_FOUND) whenever a
  // test used a file:// baseUrl, and `<base>/about:blank` on the AI's retry.
  // Deliberately an allowlist rather than `new URL(url)`: `localhost:3000`
  // and Windows paths like `C:/x` parse with schemes (`localhost:`, `c:`)
  // but must keep the baseUrl-relative handling they have today.
  const hasAbsoluteScheme = /^(https?|file|about|data|blob|chrome):/i.test(url);
  if (!hasAbsoluteScheme && baseUrl) {
    if (url.startsWith('/')) {
      const base = baseUrl.replace(/\/$/, '');
      url = `${base}${url}`;
    } else {
      url = `${baseUrl.replace(/\/$/, '')}/${url}`;
    }
  }

  const response = await gotoWithDiagnosis(page, url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // The main document's status, so the step loop can tell a 404 from the page
  // the step asked for (§2.35). Null for a same-document or about: navigation.
  return response?.status();
}

/**
 * Where in its history this tab is standing: the URL, and the history state
 * beside it.
 *
 * The state is read because a single-page app can push two entries at the SAME
 * url and differ only in what it stored — a filter panel that pushes
 * `{view:'paid'}` over `{view:'all'}` on `/payments`. Without it, moving
 * between those two reads as "nothing happened". It is wrapped because reading
 * `history` can throw on a document the test cannot script: an unreadable
 * state is simply left out of the comparison, which leaves the url doing the
 * work it did before.
 */
async function historyPositionOf(page: Page): Promise<{ url: string; state: string }> {
  let state = '';
  try {
    state = await page.evaluate(() => {
      try {
        return JSON.stringify((globalThis as any).history?.state ?? null);
      } catch {
        return '';
      }
    });
  } catch {
    state = '';
  }
  return { url: page.url(), state };
}

/**
 * The browser's back and forward buttons, on the active tab
 * (docs/specs/SPEC-browser-history.md §4).
 *
 * The failure this action exists to close is a silent no-op reported as
 * success (§2: a step asked for the browser's back button, got a keypress that
 * went to the focused element, and passed without moving). So a move that did
 * not happen FAILS the step (§4.3) rather than passing quietly.
 *
 * Deciding whether it happened is the whole subtlety, and the obvious reading
 * is wrong: `goBack`/`goForward` resolve `null` whenever the move produced no
 * HTTP **Response**, which is every SAME-DOCUMENT move — a `#hash` entry, a
 * `history.pushState` entry — not only an empty history. Review measured the
 * first cut of this function failing a `pushState` back that HAD moved the
 * tab, with a message saying there was no previous page: the single-page-app
 * case §2 names as a reason to have the action at all. So `null` is not the
 * test; the position before and after is. A null response with an unchanged
 * position is the real no-op, and only that throws.
 */
async function executeHistory(page: Page, action: AIAction): Promise<void> {
  const forward = action.action === 'forward';
  const before = await historyPositionOf(page);
  // Matching `executeNavigate`: a history move is a navigation, and waiting
  // for `load` (Playwright's default) where a `navigate` waits for
  // `domcontentloaded` would make one page quick to reach one way and slow the
  // other, for no reason an author could see.
  const options = { waitUntil: 'domcontentloaded' as const, timeout: 30_000 };
  const response = forward ? await page.goForward(options) : await page.goBack(options);
  if (response !== null) return;

  const after = await historyPositionOf(page);
  if (after.url !== before.url || after.state !== before.state) return;

  throw new Error(
    forward
      ? "forward: the browser has no page ahead in this tab's history"
      : "back: the browser has no previous page in this tab's history",
  );
}

/**
 * The browser's reload button, on the active tab (SPEC-browser-history.md §9,
 * taken up by docs/specs/SPEC-record-steps.md §4).
 *
 * The same arrival rule as `navigate`, `back` and `forward` — `domcontentloaded`
 * within 30 s — for their reason: one page must not be quick to reach one way
 * and slow another for a cause no author could see. The post-action settle
 * runs as for them (`reload` is in MUTATING_ACTIONS).
 *
 * Unlike `back`, a reload cannot fail to move: there is always a current page
 * to reload, so there is no "did it happen?" check to make. A form POST behind
 * the page is re-sent or not as the browser decides; that is the application's
 * behaviour under test, not something to smooth over.
 */
async function executeReload(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
}

/**
 * Drag `selector` onto `target`, in the action's frame
 * (docs/specs/SPEC-record-steps.md §4).
 *
 * Both ends are resolved the way a click resolves its element — the first
 * VISIBLE match — so a hidden duplicate is never picked up or dropped onto.
 * Playwright's `dragTo` moves the pointer from one to the other, which drives
 * both kinds of drag an application implements: pointer-event sortables and
 * HTML5 drag-and-drop (Chromium dispatches the drag events for it).
 *
 * A drag the application ignored still "succeeds" here, exactly as a click on a
 * dead button does: the next `Verify` is what says whether it worked.
 *
 * The pointer moves in STEPS (SPEC-web-survey-fixes.md §2.9). `dragTo` jumps
 * from source to target, and jQuery UI's draggable and sortable both ignore
 * a jump: the survey's photo-to-trash drag and its sortable list reorder
 * "succeeded" and changed nothing. A person presses, moves a little past the
 * drag threshold, and glides — so this does the same. Chromium still dispatches
 * the HTML5 drag events for real mouse movement, so a native drag-and-drop
 * keeps working. When either end has no box in the viewport (off-screen or
 * detached), `dragTo` takes over, because it scrolls and this cannot.
 */
async function executeDrag(
  page: Page,
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  const target = action.target !== undefined ? sanitizeCssSelector(action.target) : '';
  if (!target) {
    throw new Error('drag action requires a "target": the CSS selector of the element to drop onto');
  }
  const timeout = timeoutMs ?? DRAG_TIMEOUT_MS;
  const source = root.locator(selector).locator('visible=true').first();
  const destination = root.locator(target).locator('visible=true').first();
  await source.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  // A headed launch has `viewport: null`, and so does every CDP page, so
  // `viewportSize()` is null exactly where drags run most. The window's own
  // inner size is in the same CSS pixels as `boundingBox` either way.
  let viewport: { width: number; height: number } | null;
  try {
    viewport = await page.evaluate(() => ({
      width: (globalThis as any).innerWidth as number,
      height: (globalThis as any).innerHeight as number,
    }));
  } catch {
    viewport = page.viewportSize();
  }
  const inView = (box: { x: number; y: number; width: number; height: number } | null): boolean =>
    box !== null && (viewport === null
      || (box.x + box.width / 2 >= 0 && box.y + box.height / 2 >= 0
        && box.x + box.width / 2 <= viewport.width && box.y + box.height / 2 <= viewport.height));
  let from = await source.boundingBox({ timeout }).catch(() => null);
  let to = await destination.boundingBox({ timeout }).catch(() => null);
  if (from !== null && to !== null && viewport !== null && (!inView(from) || !inView(to))) {
    // Scrolling the source in leaves it at the viewport's edge, often with the
    // target still below (SPEC-web-survey-fixes.md §2.19). `dragTo` would then
    // scroll mid-drag, and Chromium abandons an HTML5 drag that scrolls: the
    // drag "succeeds" and nothing is dropped. Centre the pair instead, when
    // they fit on one screen together.
    const scroll = scrollToFitBoth(from, to, viewport);
    if (scroll !== null) {
      // `instant` overrides a page's `scroll-behavior: smooth`, so the boxes
      // read next are where the pointer will actually be.
      try {
        await page.evaluate(({ dx, dy }) => (globalThis as any).scrollBy({ left: dx, top: dy, behavior: 'instant' }), scroll);
      } catch {
        // The boxes are read again below; an unscrolled pair falls back to `dragTo`.
      }
      from = await source.boundingBox({ timeout }).catch(() => null);
      to = await destination.boundingBox({ timeout }).catch(() => null);
    }
  }
  if (from === null || to === null || !inView(from) || !inView(to)) {
    await source.dragTo(destination, { timeout });
    return;
  }
  // A click refuses to press through something laid over its target; a drag
  // by mouse coordinates does not, so anything that slid over the source — an
  // overlay, a banner, an ad frame — took the press and the drag "succeeded"
  // with nothing moved (§2.22). Put the pointer on the source and ask whether
  // the source felt it. If not, `dragTo`'s actionability check names what
  // intercepts the pointer, so the failure says what is in the way.
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const reached = await pointerReaches(page, source, startX, startY);
  if (!reached) {
    await source.dragTo(destination, { timeout });
    return;
  }
  await page.mouse.down();
  // Past the 1–5 px threshold libraries wait for before they call it a drag.
  await page.mouse.move(startX + 6, startY + 6, { steps: 3 });
  // The target can move once the drag starts (a sortable opens a gap), so its
  // box is read again rather than trusted from before the press.
  const landing = (await destination.boundingBox().catch(() => null)) ?? to;
  // A sortable puts the item before or after the target by which half the
  // pointer is in, so "below Item 3" lets go in the lower part, not on the
  // midpoint (SPEC-web-survey-fixes.md §2.36).
  const fx = action.position === 'left' ? 0.2 : action.position === 'right' ? 0.8 : 0.5;
  const fy = action.position === 'above' ? 0.2 : action.position === 'below' ? 0.8 : 0.5;
  await page.mouse.move(landing.x + landing.width * fx, landing.y + landing.height * fy, { steps: 15 });
  await page.mouse.up();
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Move the pointer to (x, y) and say whether the element felt it: a
 * `mousemove` there whose path includes the element. False means something
 * else is on top at that point — a frame over it takes the event and the
 * element's own window sees nothing. True when it cannot be told, so a probe
 * that fails to install leaves the drag as it was.
 */
async function pointerReaches(page: Page, element: Locator, x: number, y: number): Promise<boolean> {
  try {
    await element.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) => {
        const w = globalThis as any;
        if (w.__steptixPointerProbe) w.removeEventListener('mousemove', w.__steptixPointerProbe, true);
        w.__steptixPointerOver = false;
        w.__steptixPointerProbe = (e: any) => { w.__steptixPointerOver = e.composedPath().includes(el); };
        w.addEventListener('mousemove', w.__steptixPointerProbe, true);
      },
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    await page.mouse.move(x, y);
    return true;
  }
  // Two moves, so the last one is a real change of position even when the
  // pointer was already resting at (x, y).
  await page.mouse.move(x - 1, y - 1);
  await page.mouse.move(x, y);
  try {
    return await element.evaluate(
      () => {
        const w = globalThis as any;
        w.removeEventListener('mousemove', w.__steptixPointerProbe, true);
        delete w.__steptixPointerProbe;
        return w.__steptixPointerOver === true;
      },
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    return true;
  }
}

/**
 * The scroll that centres two boxes in the viewport together, or null when
 * their combined extent is wider or taller than the viewport, so no single
 * scroll position shows both centres. Boxes are viewport-relative.
 */
export function scrollToFitBoth(
  a: Box,
  b: Box,
  viewport: { width: number; height: number },
): { dx: number; dy: number } | null {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  if (right - left > viewport.width || bottom - top > viewport.height) return null;
  const dx = Math.round((left + right) / 2 - viewport.width / 2);
  const dy = Math.round((top + bottom) / 2 - viewport.height / 2);
  return dx === 0 && dy === 0 ? null : { dx, dy };
}

/**
 * How many candidates would each of the two upload routes pick from? Mirrors
 * the target rule in {@link executeUpload}: a visible match wins; failing that,
 * a hidden `<input type="file">`. Never throws — it feeds a gate, not an action.
 */
async function uploadCandidateCounts(
  root: Page | FrameLocator,
  selector: string,
): Promise<{ visible: number; hiddenFileInputs: number }> {
  const visible = await root
    .locator(selector)
    .locator('visible=true')
    .count()
    .catch(() => 0);
  if (visible > 0) return { visible, hiddenFileInputs: 0 };
  const hiddenFileInputs = await root
    .locator(selector)
    .and(root.locator('input[type="file"]'))
    .count()
    .catch(() => 0);
  return { visible, hiddenFileInputs };
}

/** Refuse a multi-file upload into a field that takes one, rather than
 *  silently uploading only the first. Retryable: the model can split the step
 *  or pick the multi-file field. */
function assertMultipleAllowed(selector: string, files: string[], multiple: boolean): void {
  if (files.length > 1 && !multiple) {
    throw new Error(
      `"${selector}" accepts one file but the step gave ${files.length}. `
      + 'Split the step, or target a multi-file field',
    );
  }
}

/** Is this element something we can set files on directly? A `<label>` counts:
 *  Playwright retargets a label to its control, so it needs no picker. */
async function classifyUploadTarget(
  target: Locator,
): Promise<{ isFileInput: boolean; multiple: boolean }> {
  try {
    // Explicit `undefined` arg + options — a lone options object would be read
    // as the page function's ARGUMENT and silently take Playwright's 30s
    // default. Same trap as `measureTargeting`.
    return await target.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) => {
        // Duck-typed: this file compiles without the DOM lib, like every other
        // in-page function here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fileInput = (candidate: any) =>
          candidate && candidate.tagName === 'INPUT'
          && String(candidate.type).toLowerCase() === 'file'
            ? candidate
            : null;
        const input = fileInput(el) ?? (el.tagName === 'LABEL' ? fileInput(el.control) : null);
        return { isFileInput: input !== null, multiple: input ? Boolean(input.multiple) : false };
      },
      undefined,
      { timeout: MEASUREMENT_TIMEOUT_MS },
    );
  } catch {
    // An element that detached in the gap, or a frame that will not evaluate.
    // Treat it as an opener: the chooser route reports a clearer failure than
    // a setInputFiles on something that is not an input.
    //
    // `multiple: true` because the probe FAILED, not because it said "many":
    // reporting single here would refuse a two-file step with a confident
    // claim about a field we could not read. Let Playwright's own
    // "non-multiple file input" error speak instead.
    return { isFileInput: false, multiple: true };
  }
}

/**
 * Click a control and answer the file picker it opens.
 *
 * The waiter is armed before the click and its rejection is handled straight
 * away. `Promise.all([waitForEvent, click])` looks equivalent and is not: when
 * the CLICK fails, the waiter keeps running and later rejects with nobody
 * listening, which under Node's default `--unhandled-rejections=throw` ends a
 * CLI run outright (the Sessions API only survives it because of its crash
 * guard). Awaiting the click first also means a click failure — the more
 * specific error — is the one that surfaces.
 */
async function uploadViaChooser(
  page: Page,
  target: Locator,
  selector: string,
  files: string[],
  budgetMs: number,
): Promise<UploadRoute> {
  const chooserPromise = page.waitForEvent('filechooser', { timeout: budgetMs });
  chooserPromise.catch(() => { /* handled below, or by the click's error */ });
  await target.click({ timeout: budgetMs });
  let chooser;
  try {
    chooser = await chooserPromise;
  } catch {
    throw new Error(
      `Clicking "${selector}" did not open a file chooser Playwright can answer. `
      + 'If the snapshot shows an <input type="file"> for this field, target it '
      + 'directly; a picker opened with the File System Access API cannot be driven',
    );
  }
  assertMultipleAllowed(selector, files, chooser.isMultiple());
  await chooser.setFiles(files);
  return 'chooser';
}

/**
 * Put files into the page.
 *
 * `files` arrive already resolved to absolute paths and already proven to exist
 * — {@link executeAction} does that before touching the browser at all.
 *
 * Target rule (stories/upload-action.md, decision 7): a VISIBLE match wins, and
 * is either set directly (a file input, or a label for one) or clicked to open
 * a picker. Only when nothing matches visibly do we fall back to a hidden
 * `<input type="file">` — the one hidden element that is a legitimate target,
 * and the shape every styled uploader on the web uses. A hidden
 * anything-else is not a target: taking it would resurrect the decoy bug that
 * stories/codebehind-selector-ambiguity.md fixed, where the first match in DOM
 * order is a collapsed mobile copy of the real control.
 */
async function executeUpload(
  page: Page,
  root: Page | FrameLocator,
  action: AIAction,
  files: string[],
  timeoutMs?: number,
): Promise<UploadRoute> {
  const selector = requireSelector(action);
  // ONE budget for the whole action, spent down as it goes. Each wait below
  // would otherwise get a fresh 10s, so the failure path could take thirty
  // seconds to say a selector matched nothing.
  const deadline = Date.now() + (timeoutMs ?? UPLOAD_TIMEOUT_MS);
  const remaining = (): number => Math.max(deadline - Date.now(), MIN_ACTION_TIMEOUT_MS);

  const matches = root.locator(selector);
  const visible = matches.locator('visible=true');

  // Something must match — but not necessarily visibly.
  await matches.first().waitFor({ state: 'attached', timeout: remaining() });

  /** Act on the first VISIBLE match: set the files on it when it is a file
   *  input (or a label for one), otherwise click it and answer the picker. */
  const useVisibleTarget = async (): Promise<UploadRoute> => {
    const target = visible.first();
    const kind = await classifyUploadTarget(target);
    if (kind.isFileInput) {
      assertMultipleAllowed(selector, files, kind.multiple);
      logUpload(files, selector, 'input');
      await target.setInputFiles(files, { timeout: remaining() });
      return 'input';
    }
    logUpload(files, selector, 'chooser');
    return await uploadViaChooser(page, target, selector, files, remaining());
  };

  if ((await visible.count().catch(() => 0)) > 0) return await useVisibleTarget();

  const hiddenInput = matches.and(root.locator('input[type="file"]')).first();
  if ((await hiddenInput.count().catch(() => 0)) === 0) {
    // Nothing visible, and no hidden file input either. Let Playwright raise
    // the same "not visible" failure every other action would, rather than
    // inventing one.
    await visible.first().waitFor({ state: 'visible', timeout: remaining() });
    // It became visible inside the budget after all — a slow render, not a
    // missing control. Act on it, rather than falling through to a hidden-input
    // locator that matches nothing and times out blaming the wrong element.
    return await useVisibleTarget();
  }

  const kind = await classifyUploadTarget(hiddenInput);
  assertMultipleAllowed(selector, files, kind.multiple);
  logUpload(files, selector, 'input');
  await hiddenInput.setInputFiles(files, { timeout: remaining() });
  return 'input';
}

/** The one line that names the absolute paths actually sent. The `subAction`
 *  line above carries only the model's description, so without this a failed
 *  upload is the only place a path is ever visible. */
function logUpload(files: string[], selector: string, via: UploadRoute): void {
  const how = via === 'input' ? 'input' : 'via file chooser';
  logger.info(`upload: ${files.join(', ')} → ${selector} (${how})`);
}

async function executeHover(
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<void> {
  const selector = requireSelector(action);
  await root
    .locator(selector)
    .locator('visible=true')
    .first()
    .hover({ timeout: timeoutMs ?? HOVER_TIMEOUT_MS });
}

/**
 * The element an action is about to act on, plus the wait it was going to do
 * to get there.
 *
 * Only SINGULAR element-targeting actions have one. `read multiple` and
 * `count` are plural by construction — many matches is their purpose — and
 * navigate/keyboard/assert/prompt/noop and the page/browser actions target no
 * element at all.
 *
 * `state` is the state the action's OWN wait would have waited for, which is
 * not the same question for every action: click/type/select/hover/upload all
 * go through `visible=true`, while a singular `read` reads `.first()` of the
 * raw locator and so waits only for `attached` — reading a hidden element is
 * ordinary, and hoisting a visibility wait would change what read means.
 *
 * It doubles as the action's tolerance, which is what `ambiguousTarget: 'fail'`
 * has to gate on: `'visible'` means the runtime chose among the visible
 * matches, `'attached'` means it chose among all of them.
 */
interface SingularTarget {
  target: Locator;
  state: 'visible' | 'attached';
  /** The first budget the action would have spent, which the hoisted wait
   *  borrows from rather than adding to. */
  budgetMs: number;
}

function singularTargetOf(root: Page | FrameLocator, action: AIAction): SingularTarget | null {
  const selector = action.selector;
  if (!selector) return null;
  const visibleFirst = (): Locator => root.locator(selector).locator('visible=true').first();
  switch (action.action) {
    case 'click':
      return { target: visibleFirst(), state: 'visible', budgetMs: CLICK_TIMEOUT_MS };
    case 'type':
      return { target: visibleFirst(), state: 'visible', budgetMs: TYPE_CLEAR_TIMEOUT_MS };
    case 'select':
      return { target: visibleFirst(), state: 'visible', budgetMs: SELECT_BY_VALUE_TIMEOUT_MS };
    case 'hover':
      return { target: visibleFirst(), state: 'visible', budgetMs: HOVER_TIMEOUT_MS };
    // The element DRAGGED is the one measured and gated; the drop target is a
    // second selector with the same visible-first rule (`executeDrag`).
    case 'drag':
      return { target: visibleFirst(), state: 'visible', budgetMs: DRAG_TIMEOUT_MS };
    case 'upload':
      // `attached`, not `visible`: the styled uploader's <input type="file"> is
      // `display:none` and is still the right target. The gate compensates —
      // see the upload clause in `executeAction`, which counts what each route
      // would actually pick from rather than trusting either stored count.
      return { target: root.locator(selector).first(), state: 'attached', budgetMs: UPLOAD_TIMEOUT_MS };
    case 'read':
      if (action.multiple) return null;
      return { target: root.locator(selector).first(), state: 'attached', budgetMs: READ_TIMEOUT_MS };
    default:
      return null;
  }
}

/**
 * Count what the selector matched and identify what is about to be touched.
 *
 * NEVER throws and never fails an action: measurement is strictly additive
 * telemetry, so a mangled selector, a cross-origin frame, a CSP blocking
 * `evaluate`, a closing page or an element that detached in the gap since the
 * wait all leave `targeting` absent and the action behaving exactly as it does
 * today. Absence is first-class downstream; a wrong number would not be.
 *
 * `full` is the compile-only half. With it off — the `ambiguousTarget: 'fail'`
 * exception, which has to read a count on any run — this is ONE call, not
 * three: the count matching the action's own tolerance, which is the only one
 * the gate can act on.
 */
async function measureTargeting(
  root: Page | FrameLocator,
  selector: string,
  singular: SingularTarget,
  full: boolean,
): Promise<ActionTargeting | undefined> {
  try {
    const visibleMatchCount =
      full || singular.state === 'visible'
        ? await root.locator(selector).locator('visible=true').count()
        : undefined;
    const matchCount =
      full || singular.state === 'attached' ? await root.locator(selector).count() : undefined;
    // Explicitly `undefined` arg + options, because `evaluate`'s first overload
    // would otherwise read a lone options object as the page function's
    // ARGUMENT and silently apply Playwright's 30s default — which is what an
    // element that detached in the gap would then spend before throwing. Two
    // seconds is the whole budget telemetry gets.
    const resolved = full
      ? await singular.target.evaluate(resolvedSelectorInPage, undefined, {
          timeout: MEASUREMENT_TIMEOUT_MS,
        })
      : null;

    // Never record a zero. The wait proved a match existed in the state the
    // action needs, so a zero here describes a re-render in the gap rather
    // than the page the action is about to touch. (A `read` waits for
    // `attached`, so zero VISIBLE matches is a legitimate answer there — the
    // field is simply left off rather than discarding the rest.)
    if (matchCount === 0) return undefined;
    if (singular.state === 'visible' && visibleMatchCount === 0) return undefined;

    const out: ActionTargeting = {
      ...(matchCount !== undefined && { matchCount }),
      ...(visibleMatchCount !== undefined && visibleMatchCount > 0 && { visibleMatchCount }),
      ...(resolved !== null && { resolvedSelector: resolved.selector, resolvedBy: resolved.by }),
    };
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `resolvedSelector`'s browser half: a selector that addresses THIS element
 * and nothing else, verified against the live document, plus how it was
 * arrived at. Null when nothing verified.
 *
 * Three candidates, best first, each verified before it is returned:
 *
 *   1. `'attribute'` — the element's own handle (`strongSelector`).
 *   2. `'scoped'` — that same handle qualified by the nearest addressable
 *      ancestor, e.g. `#statements a[href="transactions.html"]`. This is the
 *      form the story's worked example shows, and it is the one the headline
 *      case needs: a hidden drawer copy makes the bare `href` match twice, so
 *      the element's own handle cannot verify even though it describes the
 *      element perfectly well.
 *   3. `'positional'` — `stableSelector`'s `nth-of-type` chain.
 *
 * 2 sits above 3 because the two are not equally good even when both verify.
 * Insert a sibling above the panel and the positional chain silently
 * retargets; the scoped form does not. What this function returns is compiled
 * into a file that gets committed and runs for years, which is exactly where
 * that difference gets expensive — and it is why `resolvedBy` is reported
 * rather than left to be sniffed out of the string: generation has to tell
 * "here is a stable handle" from "this is positional, so build the locator
 * from `step.getVar(...)` if the step names what distinguishes the element".
 *
 * The scope joins with a plain space, not `>`, so an intervening wrapper does
 * not break it — and, like `stableSelector`'s spaced `' > '`, that is safe
 * only because this output is ever an ELEMENT selector and never a frame path,
 * out of reach of `resolveLocatorRoot`'s whitespace split.
 *
 * Runs in the BROWSER context, so it must be self-contained — no closures over
 * Node-side state, no references to other helpers in this module. That is the
 * same constraint (and the same remedy) as `extractValueInPage` /
 * `executeReadMultiple`: Playwright cannot serialise references to Node scope,
 * so the body is duplicated literally and the tests keep the two copies in
 * lockstep.
 *
 * Everything between the MIRROR markers below is copied verbatim from
 * `src/browser/scripts/find-in-dom.js` — `escAttr`, `idSelector`, `verifies`,
 * `strongSelector` and `stableSelector`, in that order — because the story's
 * requirement is that the runtime walks *the existing candidate hierarchy*.
 * A drift between the two is a silent divergence in what the AI is handed
 * versus what the entry is generated from, so
 * `tests/selector-measurement.test.ts` compares the two sources
 * character-for-character (whitespace and TS annotations normalised).
 *
 * The scoped tier is deliberately OUTSIDE those markers: it is this function's
 * own layer, which find-in-dom.js does not have, and a mirror has to stay a
 * mirror. Its candidate list is pinned to `strongSelector`'s by a test that
 * compares the attributes each of them reads, in order.
 */
// This package's `lib` is ES2022 with no DOM — it is a Node process that
// drives a browser, not a browser. Naming `document` (erased at compile time,
// and referenced only from the browser-context function below) is what lets
// the mirrored block stay character-identical to the .js it was copied from
// instead of paraphrasing every reference to it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const document: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolvedSelectorInPage(el: any): ResolvedSelection | null {
  /* MIRROR-BEGIN find-in-dom.js */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function escAttr(v: any) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function idSelector(id: any) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return '#' + id;
    return '[id="' + escAttr(id) + '"]';
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function verifies(sel: any, el: any) {
    try {
      var found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (err) {
      return false;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function strongSelector(el: any) {
    var tag = el.tagName.toLowerCase();
    var testId = el.getAttribute('data-testid');
    if (testId) {
      var testIdSel = '[data-testid="' + escAttr(testId) + '"]';
      if (verifies(testIdSel, el)) return testIdSel;
    }
    var id = el.getAttribute('id');
    if (id) {
      var idSel = idSelector(id);
      if (verifies(idSel, el)) return idSel;
    }
    var name = el.getAttribute('name');
    if (name) {
      var nameSel = tag + '[name="' + escAttr(name) + '"]';
      if (verifies(nameSel, el)) return nameSel;
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      var ariaSel = tag + '[aria-label="' + escAttr(ariaLabel) + '"]';
      if (verifies(ariaSel, el)) return ariaSel;
    }
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href) {
        var hrefSel = 'a[href="' + escAttr(href) + '"]';
        if (verifies(hrefSel, el)) return hrefSel;
      }
    }
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stableSelector(el: any) {
    var direct = strongSelector(el);
    if (direct) return direct;
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      var parent = cur.parentElement;
      var tag = cur.tagName.toLowerCase();
      var n = 1;
      var sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) n++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + n + ')');
      var parentSel = strongSelector(parent);
      if (parentSel) {
        parts.unshift(parentSel);
        return parts.join(' > ');
      }
      cur = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }
  /* MIRROR-END */

  // Every attribute handle the hierarchy above would consider for THIS
  // element, in the same order, but UNVERIFIED — `strongSelector` returns only
  // handles that already address the element on their own, and the whole point
  // of the scoped tier is the case where one does not. The two lists are
  // pinned together by `attributesReadBy` in tests/selector-measurement.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ownAttrSelectors(el: any) {
    var tag = el.tagName.toLowerCase();
    var out = [];
    var testId = el.getAttribute('data-testid');
    if (testId) out.push('[data-testid="' + escAttr(testId) + '"]');
    var id = el.getAttribute('id');
    if (id) out.push(idSelector(id));
    var name = el.getAttribute('name');
    if (name) out.push(tag + '[name="' + escAttr(name) + '"]');
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) out.push(tag + '[aria-label="' + escAttr(ariaLabel) + '"]');
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href) out.push('a[href="' + escAttr(href) + '"]');
    }
    return out;
  }

  try {
    var direct = strongSelector(el);
    if (direct) return { selector: direct, by: 'attribute' };

    // Nearest addressable ancestor first, and within it the strongest handle
    // first — so `#panel [data-testid="x"]` beats `#panel a[href="y"]`, and
    // both beat anything anchored further up the tree.
    var owns = ownAttrSelectors(el);
    if (owns.length > 0) {
      var cur = el.parentElement;
      while (cur && cur !== document.body && cur.parentElement) {
        var anchor = strongSelector(cur);
        if (anchor) {
          for (var i = 0; i < owns.length; i++) {
            var scoped = anchor + ' ' + owns[i];
            if (verifies(scoped, el)) return { selector: scoped, by: 'scoped' };
          }
        }
        cur = cur.parentElement;
      }
    }

    // The last word is the document's, not the builder's: `stableSelector`'s
    // positional chain is unique by construction on ordinary markup, but a
    // camel-cased SVG tag or an element outside `document.body` can defeat it,
    // and a `resolvedSelector` that is not verified is worth less than none.
    var chain = stableSelector(el);
    if (chain && verifies(chain, el)) return { selector: chain, by: 'positional' };
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse a duration string into milliseconds.
 * Supports simple ("30s", "2 minutes", "500ms") and compound ("1m 30s", "1 min 10 sec") formats.
 */
function parseDuration(value: string): number | null {
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|sec|m|minutes?|min)/gi;
  let totalMs = 0;
  let matched = false;

  for (const match of value.matchAll(pattern)) {
    matched = true;
    const num = parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    if (unit.startsWith('ms') || unit.startsWith('millisecond')) totalMs += num;
    else if (unit.startsWith('s') || unit === 'sec') totalMs += num * 1_000;
    else if (unit.startsWith('m')) totalMs += num * 60_000;
  }

  return matched ? Math.round(totalMs) : null;
}

/**
 * Escape special characters commonly found in Tailwind CSS classes that are
 * invalid in raw CSS selectors (e.g. `.!fixed` → `.\!fixed`).
 * Exported for tests only.
 */
export function sanitizeCssSelector(selector: string): string {
  // Escape `!` when used inside class names (Tailwind important modifier)
  // e.g.  .!fixed  →  .\!fixed
  let sanitized = selector.replace(/\.!/g, '.\\!');

  // Escape `/` in class names (Tailwind opacity shorthand)
  // e.g.  .bg-black/50  →  .bg-black\/50
  sanitized = sanitized.replace(/(\.[a-zA-Z_][\w-]*)\/(\d+)/g, '$1\\/$2');

  // Escape `@` in class names (Tailwind container query variants)
  // e.g.  .@lg  →  .\@lg
  sanitized = sanitized.replace(/\.@/g, '.\\@');

  // Escape unescaped `[` and `]` inside Tailwind arbitrary-value class names.
  // Tailwind compiles `.z-[999]` to `.z-\[999\]` in CSS, so the AI-written form
  // needs the same escape to match.
  //
  // Ambiguity: `.classname-[href='/logout']` is valid CSS meaning
  // "class ending in '-' followed by attribute selector [href='/logout']". When
  // the bracket content contains `=` it's almost certainly an attribute selector
  // (Tailwind values very rarely contain `=` — only URL query strings, which are
  // vanishingly rare in practice). In that case leave the brackets alone so
  // Playwright parses the attribute selector normally.
  sanitized = sanitized.replace(
    /(\.[a-zA-Z_][\w-]*)-(?<!\\)\[([^\]]*)\]/g,
    (match, classPart, bracketContent) => {
      if (bracketContent.includes('=')) return match;
      return classPart + '-\\[' + bracketContent + '\\]';
    },
  );

  // Escape `:` inside ID and class selectors (e.g. React Aria's
  // `#react-aria-:rb4:` or Tailwind variants like `.hover:bg-blue-500`).
  // In CSS, `:` starts a pseudo-class, so an unescaped `:` in the middle
  // of an id or class name truncates the identifier and breaks parsing.
  // We match `#` or `.` + identifier chars and escape any `:` in that run —
  // but only when the `:` is NOT followed by a known pseudo-class name.
  const pseudoClasses = [
    'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited',
    'link', 'any-link', 'target', 'root', 'scope', 'empty',
    'first-child', 'last-child', 'only-child', 'first-of-type',
    'last-of-type', 'only-of-type',
    'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type',
    'not', 'is', 'where', 'has', 'lang', 'dir',
    'checked', 'disabled', 'enabled', 'required', 'optional',
    'valid', 'invalid', 'in-range', 'out-of-range',
    'read-only', 'read-write', 'placeholder-shown',
    'default', 'indeterminate', 'before', 'after',
    // Playwright-specific pseudo-classes — valid inside locator() selectors.
    // The AI should prefer dedicated waitTypes over encoding state in selectors
    // (see prompt rule 12), but these are legitimate for click/type/select
    // selectors (:has-text() is especially useful for disambiguation).
    'visible', 'hidden', 'has-text', 'text', 'nth-match', 'light',
  ];
  const pseudoRe = new RegExp(`^(?:${pseudoClasses.join('|')})\\b`, 'i');
  sanitized = sanitized.replace(/[#.][^\s.#\[>+~,]+/g, (part) => {
    const prefix = part[0];
    let body = part.slice(1);
    body = body.replace(/(?<!\\):([^\s.#\[>+~,:]*)/g, (match, rest) => {
      return pseudoRe.test(rest) ? match : '\\:' + rest;
    });
    return prefix + body;
  });

  return sanitized;
}

/** Default wait timeout when the AI gives no `timeout` hint. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
/** Upper bound on an AI-supplied wait `timeout` hint (issue 022) — guards
 *  against a hallucinated huge value. Generous (10 min) because waits are now
 *  abort-aware (`withAbort`): a STOP cancels an in-flight wait immediately, so a
 *  long cap no longer hurts stop responsiveness. A genuinely stuck wait the user
 *  doesn't stop is still bounded by the overall test timeout. */
export const MAX_WAIT_TIMEOUT_MS = 600_000;

/**
 * Resolve the effective wait timeout from the AI's optional `timeout` hint
 * (issue 022). A valid positive hint is honoured up to {@link MAX_WAIT_TIMEOUT_MS};
 * anything missing/non-finite/non-positive falls back to
 * {@link DEFAULT_WAIT_TIMEOUT_MS}. The plumbing already carries `action.timeout`
 * end-to-end (AI → parser → here); this just bounds it.
 */
export function clampWaitTimeout(hint: number | undefined): number {
  if (typeof hint !== 'number' || !Number.isFinite(hint) || hint <= 0) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  return Math.min(hint, MAX_WAIT_TIMEOUT_MS);
}

/**
 * Race `work` against the run's abort signal (issue 022). A run abort does NOT
 * cancel an in-flight Playwright wait, so a STOP would otherwise be delayed until
 * the wait runs out its own timeout (the residual issue 020 documented). Racing
 * it makes STOP near-instant: when the signal fires we reject with an AbortError
 * immediately and let the orphaned Playwright promise settle on its own (its
 * eventual resolve/reject is swallowed — harmless). The `abort` listener is
 * removed on settle so it can't accumulate on the long-lived run signal.
 *
 * The thrown AbortError propagates as the same kind of mid-step abort issue 020
 * already handles (turn-loop catch → withRetry no-retry → executeStep returns an
 * aborted result → run reported `aborted`).
 */
export function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(new DOMException('Run aborted by client', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void work.catch(() => undefined);
      reject(new DOMException('Run aborted by client', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/**
 * Ask `check` every 100 ms until it answers true, or fail once `timeout` has
 * passed. The error is named `TimeoutError`, like the Playwright waits beside
 * it, so nothing downstream can tell the two kinds of wait apart. Stops asking
 * once the run is aborted: `withAbort` has already rejected by then, and a
 * poll left running would keep querying a page nobody is waiting on.
 */
async function pollUntil(
  check: () => Promise<boolean>,
  timeout: number,
  what: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (signal?.aborted) return;
    if (await check()) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      const err = new Error(`Timeout ${timeout}ms exceeded waiting for ${what}`);
      err.name = 'TimeoutError';
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, left)));
  }
}

export interface ThresholdWait {
  /** The current number, or null when the element or a number is not there. */
  read: () => Promise<number | null>;
  op: '>=' | '<=' | '>' | '<';
  limit: number;
  /** How long the value may stand still (or move away) before the wait fails. */
  idleMs: number;
  /** The ceiling however steadily it moves. */
  maxMs: number;
  what: string;
  signal?: AbortSignal | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait for a moving number to pass a limit, for as long as it keeps moving
 * towards it (SPEC-web-survey-fixes.md §2.21). The survey's progress bar
 * reached 75% after 8, 18 and 22 seconds on three runs, so any fixed timeout
 * either fails a slow run or makes a wrong selector wait for ages. A person
 * keeps watching while the bar moves and gives up when it stops: each step
 * towards the limit pushes the deadline out by `idleMs`, up to `maxMs`. A
 * value that stands still, or moves the wrong way, fails after `idleMs`, as an
 * ordinary wait would.
 */
export async function waitForThreshold(w: ThresholdWait): Promise<void> {
  const now = w.now ?? Date.now;
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const passes = (n: number): boolean =>
    w.op === '>=' ? n >= w.limit : w.op === '<=' ? n <= w.limit : w.op === '>' ? n > w.limit : n < w.limit;
  const towards = (from: number, to: number): boolean => (w.op === '>=' || w.op === '>' ? to > from : to < from);
  const start = now();
  const ceiling = start + w.maxMs;
  let deadline = Math.min(start + w.idleMs, ceiling);
  let best: number | null = null;
  for (;;) {
    if (w.signal?.aborted) return;
    const n = await w.read();
    if (n !== null) {
      if (passes(n)) return;
      if (best === null || towards(best, n)) {
        if (best !== null) deadline = Math.min(now() + w.idleMs, ceiling);
        best = n;
      }
    }
    const left = deadline - now();
    if (left <= 0) {
      const seen = best === null ? 'no number was read' : `it got no further than ${best}`;
      const err = new Error(
        `Timeout exceeded waiting for ${w.what}: ${seen}, and it stopped moving towards ${w.limit} for ${w.idleMs}ms`,
      );
      err.name = 'TimeoutError';
      throw err;
    }
    await sleep(Math.min(100, left));
  }
}

// Exported for unit tests (issue 022) — verifies the clamped `timeout` is the
// value actually forwarded into Playwright's wait calls. Not part of the public
// API; `executeAction` is the entry point in normal use.
export async function executeWait(
  page: Page,
  root: Page | FrameLocator,
  action: AIAction,
  signal?: AbortSignal,
): Promise<void> {
  const condition = action.condition ?? action.value ?? '';
  const timeout = clampWaitTimeout(action.timeout);
  const waitType = action.waitType ?? inferWaitType(condition);

  // Run the wait, but race it against the run's abort signal so a STOP ends an
  // in-flight wait immediately rather than waiting out its (possibly long)
  // timeout. See `withAbort` / issue 022.
  const runWait = async (): Promise<void> => {
  switch (waitType) {
    case 'duration': {
      const durationMs = parseDuration(condition);
      if (durationMs !== null) {
        await page.waitForTimeout(durationMs);
      }
      break;
    }

    case 'selector': {
      // Strip a trailing ":visible" — visibility is already enforced via
      // state:'visible' below, so encoding it in the selector is redundant
      // and was a common AI failure mode (the sanitizer mangled the colon).
      const rawSel = condition.replace(/:visible$/, '');
      // Sanitize Tailwind-style class names that contain invalid CSS characters
      const sel = sanitizeCssSelector(rawSel);
      // When inside a frame, use locator.waitFor() so the wait is scoped to that frame.
      if (root !== page) {
        await root.locator(sel).first().waitFor({ state: 'visible', timeout });
      } else {
        await page.waitForSelector(sel, { state: 'visible', timeout });
      }
      break;
    }

    case 'hidden': {
      // Strip a trailing ":hidden" or ":not(:visible)" — hiddenness is enforced
      // via state:'hidden' below, so encoding it in the selector is redundant.
      const rawHidden = condition
        .replace(/:hidden$/, '')
        .replace(/:not\(:visible\)$/, '');
      // Wait for an element to disappear (spinner, overlay, loading indicator)
      const hiddenSel = sanitizeCssSelector(rawHidden);
      if (root !== page) {
        await root.locator(hiddenSel).first().waitFor({ state: 'hidden', timeout });
      } else {
        await page.waitForSelector(hiddenSel, { state: 'hidden', timeout });
      }
      break;
    }

    case 'text':
      // Inside a frame, wait in THAT frame (SPEC-web-survey-fixes.md §2.29):
      // the page's own body never contains a frame's text, so a dialog in a
      // demo iframe that already said "Complete!" waited out its timeout.
      // getByText matches rendered text, the frame-scoped counterpart of the
      // innerText check below.
      if (root !== page) {
        await root.getByText(condition).first().waitFor({ state: 'visible', timeout });
        break;
      }
      await page.waitForFunction(
        // Match VISIBLE text via innerText — NOT textContent. textContent
        // concatenates the source of every <script>/<style> and the text of
        // hidden nodes, so a "wait for text X" could match a string the user
        // never sees and the AI was never shown (the cleaned DOM strips
        // script/style too — see dom-cleaner SKIP set). innerText is "what's
        // painted", which is what "appears" means here. (issue 029)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (text) => (globalThis as any).document.body?.innerText?.includes(text) ?? false,
        condition,
        { timeout },
      );
      break;

    case 'url':
      await page.waitForURL(condition, { timeout });
      break;

    case 'load':
      if (condition === 'networkidle' || condition === 'load' || condition === 'domcontentloaded') {
        await page.waitForLoadState(condition, { timeout });
      } else {
        // Default to networkidle for unrecognised load conditions
        await page.waitForLoadState('networkidle', { timeout });
      }
      break;

    // `count` and `attribute` poll through `root.locator` rather than running
    // `document.querySelector` inside `page.waitForFunction`. The in-page form
    // spoke CSS only, so the `role=` selector rule 3 recommends — the same one
    // the model just clicked with — threw a SyntaxError here (issue 062). The
    // locator form accepts every selector an action accepts, and scopes the
    // wait to `frame` the way `selector` and `hidden` already did.
    case 'count': {
      // Wait until a selector matches at least N elements (default 1)
      const expectedCount = parseInt(action.expected ?? '1', 10);
      const target = root.locator(sanitizeCssSelector(condition));
      await pollUntil(
        async () => (await target.count()) >= expectedCount,
        timeout,
        `${condition} to match at least ${expectedCount} element(s)`,
        signal,
      );
      break;
    }

    case 'attribute': {
      // Wait for an element's attribute to reach an expected value
      // condition = selector, expected = "attribute=value" or "!disabled"
      const selector = action.selector ?? condition;
      const expr = action.expected ?? condition;
      const negate = expr.startsWith('!');
      // `aria-valuenow>=75`: a numeric comparison (SPEC-web-survey-fixes.md
      // §2.13). A progress bar steps past 75 without ever sitting on it, so an
      // exact `=75` waits out its whole timeout.
      const compared = negate ? null : /^([^<>=]+?)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(expr);
      const attr = negate ? expr.slice(1) : compared ? compared[1]!.trim() : expr.split('=')[0]!;
      const val = negate || compared ? null : (expr.split('=').slice(1).join('=') || null);
      const comparison = compared ? { op: compared[2]!, limit: Number(compared[3]) } : null;
      const target = root.locator(sanitizeCssSelector(selector));

      if (comparison !== null) {
        await waitForThreshold({
          read: async () => {
            if ((await target.count()) === 0) return null;
            try {
              return await target.first().evaluate(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (el: any, attribute) => {
                  const raw = el.getAttribute(attribute) ?? (attribute === 'value' ? el.value : null);
                  const n = Number.parseFloat(String(raw ?? ''));
                  return Number.isNaN(n) ? null : n;
                },
                attr,
                { timeout: 1_000 },
              );
            } catch {
              return null;
            }
          },
          op: comparison.op as ThresholdWait['op'],
          limit: comparison.limit,
          idleMs: timeout,
          maxMs: MAX_WAIT_TIMEOUT_MS,
          what: `${selector} to have ${expr}`,
          signal,
        });
        break;
      }

      await pollUntil(
        async () => {
          // A bad selector throws here, at once, rather than timing out.
          if ((await target.count()) === 0) return false;
          try {
            return await target.first().evaluate(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (el: any, { attribute, expected, shouldBeAbsent }) => {
                if (shouldBeAbsent) return !el.hasAttribute(attribute);
                if (expected === null) return el.hasAttribute(attribute);
                return el.getAttribute(attribute) === expected;
              },
              { attribute: attr, expected: val, shouldBeAbsent: negate },
              { timeout: 1_000 },
            );
          } catch {
            // Detached between the count and the read — ask again next poll.
            return false;
          }
        },
        timeout,
        `${selector} to have ${expr}`,
        signal,
      );
      break;
    }

    case 'navigation': {
      // Wait for navigation to occur AND settle. Resolves on the final URL of
      // a redirect chain, not the first hop (SSO/OAuth flows chain through
      // several intermediate URLs).
      const startUrl = page.url();
      await page.waitForURL((url) => url.toString() !== startUrl, { timeout });
      // After the first change, give the URL up to 1.5s to stabilise by
      // re-checking at short intervals — if it keeps moving, we're mid-chain.
      const stableDeadline = Date.now() + 1_500;
      let lastUrl = page.url();
      let lastChangeAt = Date.now();
      while (Date.now() < stableDeadline) {
        await page.waitForTimeout(150);
        const currentUrl = page.url();
        if (currentUrl !== lastUrl) {
          lastUrl = currentUrl;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= 400) {
          break;
        }
      }
      break;
    }

    case 'stable':
      // Wait for the page to stabilise: network idle + no pending animations
      await page.waitForLoadState('networkidle', { timeout });
      // Additional check: wait for no layout shifts / DOM mutations
      await page.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => new Promise<boolean>((resolve) => {
          const observer = new (globalThis as any).MutationObserver((_: unknown, obs: { disconnect: () => void }) => {
            obs.disconnect();
            resolve(false);
          });
          observer.observe((globalThis as any).document.body, {
            childList: true, subtree: true, attributes: true,
          });
          setTimeout(() => { observer.disconnect(); resolve(true); }, 500);
        }),
        { timeout },
      );
      break;
  }
  };

  await withAbort(runWait(), signal);
}

/**
 * Fallback heuristic for when the AI omits waitType.
 * Kept for backward compatibility but should rarely be needed.
 */
function inferWaitType(condition: string): NonNullable<AIAction['waitType']> {
  if (parseDuration(condition) !== null) return 'duration';
  if (condition === 'networkidle' || condition === 'load' || condition === 'domcontentloaded') return 'load';
  if (condition.startsWith('http') || condition.startsWith('*')) return 'url';
  if (/^[#.\[]/.test(condition)) return 'selector';
  // Playwright's own selector forms, which rule 3 now recommends (issue 062).
  // Without this a `role=` condition fell through to 'text' and waited out its
  // whole timeout for the literal string "role=button[…]" to appear on screen.
  if (/^(?:role|text|css|xpath)=/.test(condition) || /\s>>\s/.test(condition)) return 'selector';
  // Tag-like selector: starts with a tag name immediately followed by a selector char (no space)
  if (/^[a-z][a-z0-9]*[#.\[:]/.test(condition)) return 'selector';
  return 'text';
}

// ─── Absolute scrolling ──────────────────────────────────────────────────────
//
// The numbers behind the eased glide, in one place. Deliberately constants and
// not a `browser.*` config knob: a per-project value would have to be threaded
// through the server's per-project bundle to actually apply, and nothing
// justifies that plumbing yet.

/** Fixed cost of any glide, before distance is considered. */
const SCROLL_BASE_MS = 250;
/** Pixels of travel per additional millisecond of duration. */
const SCROLL_PX_PER_MS = 4;
/** Hard cap — a 40,000px page still stops gliding after this long. */
const SCROLL_MAX_MS = 1200;
/**
 * Grace period after `duration` before the deadline timer snaps to the target
 * and resolves. requestAnimationFrame is throttled to zero on hidden, occluded
 * or backgrounded pages, so the frame loop cannot be the only thing that ends
 * the animation.
 */
const SCROLL_DEADLINE_MARGIN_MS = 500;
/** How long to wait for a scroll target to become measurable before giving up
 *  on the glide and letting `scrollIntoViewIfNeeded` do the work alone. */
const SCROLL_BOX_TIMEOUT_MS = 5_000;

/** Where an absolute scroll is aimed. A `deltaY` is relative to the scroller's
 *  position when the animation starts (used to bring an element into view). */
type ScrollTargetSpec = 'top' | 'bottom' | { deltaY: number };

/**
 * Drive `document.scrollingElement` to a target with an ease-out curve, and
 * resolve only once motion has ended. The duration and the curve are computed
 * in the page, inside the callback — `page.evaluate` serializes it, so it
 * cannot call back into this module (tests/scroll-action.test.ts runs this very
 * callback against a fake scroller and frame loop to pin both).
 *
 * Neither `behavior: "smooth"` nor `behavior: "instant"` would do. Smooth
 * cannot be awaited — completion needs the `scrollend` event, which WebKit
 * doesn't fire, and the browser picks the duration. Instant teleports: it
 * dispatches no intermediate scroll positions, so IntersectionObserver-driven
 * lazy-loaders and scroll-linked UI never see the journey, on exactly the long
 * pages "scroll to the bottom" exists for. Owning the animation means
 * completion is our own promise, so the caller awaits actual arrival and a
 * follow-up screenshot can never catch a mid-animation frame.
 */
async function animateScrollTo(page: Page, target: ScrollTargetSpec): Promise<void> {
  await page.evaluate(
    (args: {
      target: ScrollTargetSpec;
      baseMs: number;
      pxPerMs: number;
      maxMs: number;
      marginMs: number;
    }) =>
      new Promise<void>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = globalThis as any;
        const el = g.document.scrollingElement ?? g.document.documentElement;
        // The maximum is scrollHeight − clientHeight, NOT scrollHeight. A plain
        // scrollTo gets away with overshooting because the browser clamps; an
        // animation must not, or the visible deceleration compresses against
        // the clamp and dies early.
        const maxScroll = (): number => Math.max(0, el.scrollHeight - el.clientHeight);
        const start: number = el.scrollTop;
        // Re-read every frame so "bottom" tracks a page that grows mid-glide —
        // within the duration cap.
        const targetY = (): number => {
          if (args.target === 'top') return 0;
          if (args.target === 'bottom') return maxScroll();
          return Math.min(Math.max(0, start + args.target.deltaY), maxScroll());
        };
        const duration = Math.min(
          args.maxMs,
          args.baseMs + Math.abs(targetY() - start) / args.pxPerMs,
        );
        // Races the frame loop: when frames stop coming, this snaps to the
        // target and resolves, so the action always terminates.
        const deadline = setTimeout(() => {
          el.scrollTop = targetY();
          resolve();
        }, duration + args.marginMs);
        const t0: number = g.performance.now();
        const tick = (now: number): void => {
          const t = Math.min(1, (now - t0) / duration);
          el.scrollTop = start + (targetY() - start) * (1 - Math.pow(1 - t, 3)); // ease-out cubic
          if (t < 1) {
            g.requestAnimationFrame(tick);
            return;
          }
          clearTimeout(deadline);
          resolve();
        };
        g.requestAnimationFrame(tick);
      }),
    {
      target,
      baseMs: SCROLL_BASE_MS,
      pxPerMs: SCROLL_PX_PER_MS,
      maxMs: SCROLL_MAX_MS,
      marginMs: SCROLL_DEADLINE_MARGIN_MS,
    },
  );
}

/**
 * Glide the document scroller to wherever `locator` sits.
 *
 * `boundingBox()` reports main-frame viewport coordinates even for an element
 * inside an iframe, so the delta it yields is the right one for the document
 * scroller. Best-effort by design: an element that can't be measured (detached,
 * hidden, still rendering) simply gets no glide, and the
 * `scrollIntoViewIfNeeded` backstop at the call site still puts it in view.
 */
async function animateScrollToLocator(page: Page, locator: Locator): Promise<void> {
  const box = await locator
    .boundingBox({ timeout: SCROLL_BOX_TIMEOUT_MS })
    .catch(() => null);
  if (!box) {
    logger.debug('scroll: target not measurable — skipping the glide, relying on scrollIntoViewIfNeeded');
    return;
  }
  await animateScrollTo(page, { deltaY: box.y });
}

/**
 * Scroll the page. Three forms, in precedence order:
 *
 *   1. `selector` — bring an element into view. The eased glide aimed at the
 *      element, then Playwright's `scrollIntoViewIfNeeded` as the correctness
 *      backstop (a no-op when the glide already landed, and the thing that
 *      handles elements inside *nested* scrollable containers — where the
 *      backstop is instant). Routed through `root`, so `frame` works.
 *   2. `to` — absolute and pointer-independent: the top or the current bottom.
 *   3. `direction` + `amount` — the mouse-wheel path, unchanged. The only form
 *      that can reach an inner scrollable pane under the pointer, and so the
 *      fallback for layouts that fix the body and scroll a `<main>`.
 *
 * Precedence rather than rejection: a model that sends both `to` and
 * `direction` is being redundant, not contradictory, and every combination has
 * one sensible reading. Failing here would burn a paid retry turn to punish
 * harmless noise.
 */
async function executeScroll(page: Page, root: Page | FrameLocator, action: AIAction): Promise<void> {
  if (action.selector) {
    const target = root.locator(action.selector).first();
    await animateScrollToLocator(page, target);
    await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
    return;
  }

  if (action.to) {
    await animateScrollTo(page, action.to);
    return;
  }

  const direction = action.direction ?? 'down';
  const amount = action.amount ?? 300;

  const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;

  await page.mouse.wheel(deltaX, deltaY);
}

async function executeDismiss(root: Page | FrameLocator, action: AIAction): Promise<void> {
  const selector = action.selector;

  if (selector) {
    try {
      const locator = root.locator(selector).locator('visible=true').first();
      if (await locator.isVisible({ timeout: 3_000 })) {
        await locator.click({ timeout: 5_000 });
        return;
      }
    } catch {
      // Element not found or not clickable — try common dismiss patterns
    }
  }

  // Try common dismiss button patterns
  const dismissPatterns = [
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("Close")',
    'button:has-text("OK")',
    'button:has-text("Dismiss")',
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
    '.close-button',
    '#cookie-accept',
  ];

  for (const pattern of dismissPatterns) {
    try {
      const el = root.locator(pattern).first();
      if (await el.isVisible({ timeout: 1_000 })) {
        await el.click({ timeout: 3_000 });
        logger.debug(`Dismissed element matching: ${pattern}`);
        return;
      }
    } catch {
      // Try next pattern
    }
  }

  logger.debug('No dismiss target found — continuing');
}

async function executeKeyboard(page: Page, action: AIAction): Promise<void> {
  // `text` types into whatever has focus (§2.27): after a click on a canvas,
  // an editor, or a field inside a closed shadow root.
  if (action.text !== undefined && action.text !== '') {
    await page.keyboard.type(action.text);
    if (action.key === undefined) return;
  }
  const key = action.key ?? action.value ?? '';
  if (!key) throw new Error('keyboard action requires a "key" to press or a "text" to type');
  await page.keyboard.press(normaliseKeyName(key));
}

/** Key names a step or a model writes, folded, mapped to Playwright's (§2.6). */
const KEY_NAMES: Readonly<Record<string, string>> = {
  ctrl: 'Control', control: 'Control', ctl: 'Control',
  cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', windows: 'Meta', super: 'Meta',
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  shift: 'Shift',
  esc: 'Escape', escape: 'Escape',
  enter: 'Enter', return: 'Enter',
  tab: 'Tab',
  space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', bksp: 'Backspace',
  del: 'Delete', delete: 'Delete',
  ins: 'Insert', insert: 'Insert',
  home: 'Home', end: 'End',
  pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pgdown: 'PageDown', pagedown: 'PageDown',
  up: 'ArrowUp', arrowup: 'ArrowUp', down: 'ArrowDown', arrowdown: 'ArrowDown',
  left: 'ArrowLeft', arrowleft: 'ArrowLeft', right: 'ArrowRight', arrowright: 'ArrowRight',
  capslock: 'CapsLock', contextmenu: 'ContextMenu',
};

/**
 * Playwright's spelling of a key or chord: `END` → `End`, `CTRL+A` →
 * `Control+A`, `esc` → `Escape`, `f5` → `F5`. Playwright's key names are
 * case-sensitive and the survey's model wrote `END` and `CTRL`, which threw
 * "Unknown key" twice. A part this table does not know is kept as written, so
 * Playwright still reports a truly unknown key in its own words. A single
 * character keeps its case: `a` and `A` are different keys to press.
 */
export function normaliseKeyName(key: string): string {
  if (key.length === 1) return key;
  // "+" separates a chord, except a "+" that IS the key ("Control++").
  const parts = key.split(/\+(?!$)/);
  return parts
    .map((part) => {
      if (part.length <= 1) return part;
      const folded = part.trim().toLowerCase().replace(/[\s_-]/g, '');
      const named = KEY_NAMES[folded];
      if (named !== undefined) return named;
      if (/^f([1-9]|1[0-9]|2[0-4])$/.test(folded)) return folded.toUpperCase();
      return part.trim();
    })
    .join('+');
}

function requireSelector(action: AIAction): string {
  if (!action.selector) {
    throw new Error(`Action "${action.action}" requires a selector but none was provided`);
  }
  return action.selector;
}

/**
 * Count the number of elements matching a CSS selector.
 * Stores the result as a string (e.g. "3") in resolvedParameters[action.as].
 */
async function executeCount(root: Page | FrameLocator, action: AIAction): Promise<string> {
  const selector = requireSelector(action);
  logger.subAction(`count ${selector} → ${action.as ?? '(unnamed)'}`);
  // VISIBLE matches, unless the step asked for hidden ones too
  // (SPEC-web-survey-fixes.md §2.4). "How many books are shown" on a list a
  // filter hides rather than removes counted 8 before and after filtering.
  // Options are the exception: the options of a closed <select> are never
  // "visible", and "how many options does the list have" means all of them.
  const matches = root.locator(selector);
  const total = await matches.count();
  let count = total;
  if (!action.includeHidden && total > 0) {
    const visible = await matches.locator('visible=true').count();
    const onlyOptions = visible === 0
      && await matches.evaluateAll(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (els: any[]) => els.every((el) => el.tagName === 'OPTION' || el.tagName === 'OPTGROUP'),
      ).catch(() => false);
    if (!onlyOptions) count = visible;
  }
  const result = String(count);
  logger.info(
    `count: ${count} ${action.includeHidden ? '' : 'visible '}elements matching "${selector}"`
      + `${count !== total ? ` (${total} including hidden)` : ''} → variable "${action.as ?? '(unnamed)'}"`,
  );
  return result;
}

/**
 * Per-element value extraction shared by `executeRead` and `executeReadMultiple`.
 * Runs in the BROWSER context (shipped to Playwright via `evaluate` /
 * `evaluateAll`), so it must be a self-contained function — no closures over
 * Node-side state, no references to other helpers in this module. The
 * function source is stringified twice on the way to the page; both call
 * sites pass it through Playwright's serialization the same way.
 *
 * Behaviour:
 *   - With `attribute` `url`: the address of the element's own document. No
 *     element carries the page URL as an attribute, so "capture the current
 *     page URL" had no expression at all in this vocabulary and the model
 *     reached for `@url` anyway — which fell through to `getAttribute('url')`
 *     and captured the empty string silently. Read off the element's
 *     `ownerDocument` rather than the top-level `location` so a read inside a
 *     frame reports the frame the selector resolved against.
 *   - With `attribute`: special-case `href`/`src` so the resolved absolute
 *     URL wins over the raw attribute string (which may be a relative path).
 *   - Without `attribute`: prefer the form-input `value` over `textContent`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractValueInPage(el: any, attribute?: string): string {
  if (attribute) {
    if (attribute === 'url') {
      // Attribute first, like href/src: 'url' is not a standard attribute, but
      // custom elements and data-layer markup do carry one, and a page URL
      // that shadowed it would leave no spelling that reads the real thing.
      const own = typeof el.getAttribute === 'function' ? el.getAttribute('url') : null;
      if (typeof own === 'string' && own.length > 0) return own;
      const doc = el.ownerDocument;
      return doc && doc.location ? doc.location.href : '';
    }
    if (attribute === 'href' || attribute === 'src') {
      const resolved = el[attribute];
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    }
    return typeof el.getAttribute === 'function' ? (el.getAttribute(attribute) ?? '') : '';
  }
  if (typeof el.value === 'string') return el.value;
  // Text that is not text: a container's <script> source, <style> rules and
  // <template> markup are all in textContent, and a read of a whole panel
  // once captured a page's TOTP script along with its credentials
  // (SPEC-web-survey-fixes.md §2.11). Read a copy without them. An element
  // without any reads exactly as before.
  const notText = 'script,style,template,noscript';
  if (typeof el.querySelector === 'function' && el.querySelector(notText)) {
    const copy = el.cloneNode(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    copy.querySelectorAll(notText).forEach((n: any) => n.remove());
    return (copy.textContent ?? '').trim();
  }
  return (el.textContent ?? '').trim();
}

/**
 * Compile a `read` action's `pattern` into a RegExp. Throws a clear error on an
 * invalid pattern — issue 020's fail-hard policy: a malformed regex fails the
 * step instead of being silently ignored (which would store the whole text).
 */
function compileReadPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `read pattern /${pattern}/ is not a valid regular expression — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Apply a compiled `read` pattern to one captured value. Returns the first
 * capture group, or the whole match when the pattern has no capturing group;
 * returns null when the pattern does not match. Callers decide whether a
 * non-match is fatal: a single `read` fails the step, a `multiple` read drops
 * the element.
 */
function sliceWithReadPattern(re: RegExp, value: string): string | null {
  const m = re.exec(value);
  if (m === null) return null;
  return m[1] ?? m[0];
}

/** Trim a captured value for inclusion in a fail-hard error message. */
function truncateForError(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Maximum number of elements `read multiple: true` will capture in one
 * action. Authors who need more should narrow the selector (chunk by
 * section/page); a higher cap usually indicates an over-broad selector.
 * The cap protects the param map from accidentally swallowing an entire
 * page's worth of elements when a selector is mis-typed (e.g. `a` instead
 * of `.section-1 a`).
 */
const READ_MULTIPLE_MAX = 500;

/**
 * Read the value or text content of an element.
 * Tries the element's `value` attribute first (for inputs), falls back to `textContent`.
 * Uses locator.evaluate() so it works inside both page and FrameLocator contexts.
 */
async function executeRead(
  root: Page | FrameLocator,
  action: AIAction,
  timeoutMs?: number,
): Promise<string> {
  const selector = requireSelector(action);
  const attribute = action.attribute;
  const target = attribute ? `@${attribute}` : 'text';
  logger.subAction(`read ${selector} ${target} → ${action.as ?? '(unnamed)'}`);

  let value = await root
    .locator(selector)
    .first()
    .evaluate(extractValueInPage, attribute, timeoutMs !== undefined ? { timeout: timeoutMs } : undefined);

  // Optional substring extraction (issue 020). Applied in Node after capture so
  // it composes with `attribute`. Fail-hard: an invalid pattern or a non-match
  // fails the step rather than silently storing "" or the whole text.
  if (action.pattern) {
    const sliced = sliceWithReadPattern(compileReadPattern(action.pattern), value);
    if (sliced === null) {
      throw new Error(
        `read pattern /${action.pattern}/ matched nothing in ${JSON.stringify(truncateForError(value))}`,
      );
    }
    if (sliced === '') {
      // Fail-hard extends to a match that captured nothing — storing "" is the
      // exact silent-empty outcome `pattern` exists to prevent. (A `multiple`
      // read keeps "": one empty among many is a legitimate list item.)
      throw new Error(
        `read pattern /${action.pattern}/ captured an empty substring (pattern too loose) in ${JSON.stringify(truncateForError(value))}`,
      );
    }
    value = sliced;
  }

  // No line here, deliberately. This one printed the captured text RAW —
  // before the bind, so the name `[store as: password]` chose was not yet in
  // the map the mask set is built from, and nothing at this depth could
  // consult it. The logger does not redact, and the run-log file's own pass
  // masks by the set it has, so a short or freshly-captured credential
  // reached the console, the file and every client on the SSE `output`
  // bridge in clear (review 6, finding 2).
  //
  // The capture is logged ONCE, by `executeStep` (src/runner/step-executor.ts),
  // immediately after `bindVariable` — the seam where the name is known — and
  // masked there by name, by record shape and by value. An `as`-less read
  // stores nothing and gets no value line at all; the `read <selector> <target>
  // → (unnamed)` sub-action above already records that it happened.
  return value;
}

/**
 * Read the value/text/attribute of EVERY element matching the selector and
 * return them as an ordered array — index-aligned with DOM order at capture
 * time. Single round-trip via `evaluateAll`; the per-element extraction is
 * the same body as `executeRead` (see `extractValueInPage`).
 *
 * Returns an empty array when nothing matches; that's a valid (though
 * possibly surprising) outcome and the consuming tool can decide whether
 * an empty list is a failure.
 *
 * Capped at READ_MULTIPLE_MAX. When the selector matches more, the first
 * READ_MULTIPLE_MAX values are returned and a warning names the total — so
 * an over-broad selector is loud rather than silent.
 *
 * Returns the count alongside the values because the page has already told us
 * — it is `targeting.matchCount` for free, useful context for generating the
 * loop, and the only measurement a plural action gets
 * (stories/codebehind-selector-ambiguity.md). It counts MATCHED elements, not
 * captured values: a `pattern` that drops non-matching elements shortens the
 * list without changing what the selector found.
 */
async function executeReadMultiple(
  root: Page | FrameLocator,
  action: AIAction,
): Promise<{ values: string[]; matchCount: number }> {
  const selector = requireSelector(action);
  const attribute = action.attribute;
  const target = attribute ? `@${attribute}` : 'text';
  logger.subAction(`read[multiple] ${selector} ${target} → ${action.as ?? '(unnamed)'}`);

  // Single round-trip: ship the extractor source to the page and run it
  // across every match. The extractor body is duplicated literally inside
  // the evaluateAll callback because Playwright cannot serialise references
  // to closures in Node scope. Keeping this in lockstep with
  // `extractValueInPage` is enforced by the tests in read-multiple.test.ts.
  const values: string[] = await root.locator(selector).evaluateAll(
    (els, args) => {
      const { attribute, max } = args as { attribute?: string; max: number };
      const slice = els.slice(0, max);
      return slice.map((el) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = el as any;
        if (attribute) {
          if (attribute === 'url') {
            const own = typeof e.getAttribute === 'function' ? e.getAttribute('url') : null;
            if (typeof own === 'string' && own.length > 0) return own;
            const doc = e.ownerDocument;
            return doc && doc.location ? doc.location.href : '';
          }
          if (attribute === 'href' || attribute === 'src') {
            const resolved = e[attribute];
            if (typeof resolved === 'string' && resolved.length > 0) return resolved;
          }
          return typeof e.getAttribute === 'function'
            ? (e.getAttribute(attribute) ?? '')
            : '';
        }
        if (typeof e.value === 'string') return e.value;
        // Without script, style and template text, as in extractValueInPage.
        const notText = 'script,style,template,noscript';
        if (typeof e.querySelector === 'function' && e.querySelector(notText)) {
          const copy = e.cloneNode(true);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          copy.querySelectorAll(notText).forEach((n: any) => n.remove());
          return (copy.textContent ?? '').trim();
        }
        return (e.textContent ?? '').trim();
      });
    },
    { attribute, max: READ_MULTIPLE_MAX },
  );

  // We capped inside the page. To tell the author whether anything was
  // truncated, do one cheap follow-up count() — only when the result hit
  // the cap, so the common case stays at one round trip.
  let matchCount = values.length;
  if (values.length >= READ_MULTIPLE_MAX) {
    const total = await root.locator(selector).count().catch(() => values.length);
    matchCount = total;
    if (total > values.length) {
      logger.warn(
        `read[multiple] captured the first ${values.length} of ${total} elements matching "${selector}" — narrow the selector if you need all of them (READ_MULTIPLE_MAX=${READ_MULTIPLE_MAX})`,
      );
    }
  }

  // Optional per-element substring extraction (issue 020). Non-matching
  // elements are dropped (an empty result *list* is a valid outcome); a match
  // that captured an empty string is KEPT — unlike a single read, which fails
  // on empty, here one empty among many is a legitimate list item. An invalid
  // pattern still fails the step via compileReadPattern.
  let result = values;
  if (action.pattern) {
    const re = compileReadPattern(action.pattern);
    result = values
      .map((v) => sliceWithReadPattern(re, v))
      .filter((v): v is string => v !== null);
    logger.info(
      `read[multiple] pattern /${action.pattern}/ sliced ${result.length} of ${values.length} captured value${values.length === 1 ? '' : 's'}`,
    );
  }

  logger.info(
    `read[multiple] captured: ${result.length} value${result.length === 1 ? '' : 's'} → variable "${action.as ?? '(unnamed)'}"`,
  );
  return { values: result, matchCount };
}

/**
 * The kinds of element `selector` matches — each one's tag name and its class
 * names without a digit in them, sorted: `span.account-name`
 * (docs/specs/SPEC-codebehind-robustness.md §6.6). Deduplicated, in the order
 * first met; at most {@link READ_MULTIPLE_MAX} elements looked at, or `limit`.
 *
 * Class names with digits are left out because build tools generate them
 * (`css-1x2y3z`, `jsx-482`): they change between deployments without the
 * element changing what it is. Undefined when the page cannot say.
 */
async function matchedKinds(
  root: Page | FrameLocator,
  selector: string,
  limit = READ_MULTIPLE_MAX,
): Promise<string[] | undefined> {
  try {
    return await root.locator(selector).evaluateAll(
      (els, max) => {
        const seen: string[] = [];
        for (const el of els.slice(0, max as number)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = el as any;
          const classes = (Array.from(e.classList ?? []) as string[])
            .filter((c) => !/\d/.test(c))
            .sort();
          const kind = [String(e.tagName ?? '').toLowerCase(), ...classes].join('.');
          if (!seen.includes(kind)) seen.push(kind);
        }
        return seen;
      },
      limit,
    );
  } catch {
    return undefined;
  }
}

/**
 * Wait until the number of elements `selector` matches has held still for
 * `quietMs`, within `timeoutMs` — a count or a read of every match takes what
 * is there at that instant, and a list still rendering reads short
 * (docs/specs/SPEC-codebehind-robustness.md §6.6). Never throws: at the budget
 * the read goes ahead with what is there, as an AI read would.
 */
async function settleMatchCount(
  root: Page | FrameLocator,
  selector: string,
  opts: { quietMs: number; timeoutMs: number },
  signal?: AbortSignal,
): Promise<void> {
  await waitForStableCount(() => root.locator(selector).count().catch(() => -1), opts, signal);
}

/**
 * {@link settleMatchCount}'s loop, with the count, the clock and the sleep
 * injected — exported for its tests. Returns once `count()` has answered the
 * same number for `quietMs`, or at `timeoutMs`, or on abort.
 */
export async function waitForStableCount(
  count: () => Promise<number>,
  opts: {
    quietMs: number;
    timeoutMs: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
  signal?: AbortSignal,
): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = opts.pollMs ?? 50;
  const started = now();
  let last: number | undefined;
  let since = started;
  while (now() - started < opts.timeoutMs && !signal?.aborted) {
    const current = await count();
    if (current !== last) {
      last = current;
      since = now();
    } else if (now() - since >= opts.quietMs) {
      return;
    }
    await sleep(pollMs);
  }
}

// ── Structured table reads ───────────────────────────────────────────────────
// docs/specs/SPEC-structured-table-reads.md §7. One shared extractor, called
// today by the `readTable` AI action and (phase 3) by generated code-behind's
// `tables.read`: there must not be one header algorithm in generated code and
// another here (§9.2).

/** What a caller asks the extractor for. */
export interface TableReadRequest {
  /** CSS selector that must match exactly one visible native `<table>`, ARIA
   *  grid (§7.9) or grid wrapper. */
  selector: string;
  /** The columns to read, in the order they appear on every record. */
  columns: TableReadColumn[];
  /** At most this many visible data rows, in DOM order (§4.6). Omitted means
   *  all of them, subject to {@link READ_TABLE_MAX_ROWS}. */
  limit?: number | undefined;
  /** A validated structure answer to replay (§7.10). With one, the search of
   *  §7.2/§7.3/§7.3a does not run at all: the mapping names the parts, and
   *  every count in it is checked against the page before a cell is read. */
  mapping?: TableReadMapping | undefined;
  /** §7.6's secret set, used for the SKETCH's cell text and nothing else. The
   *  records themselves are masked where they are presented, as they always
   *  were; the sketch is masked here because it is built in the page and goes
   *  straight to a model call and the debug log. */
  maskValues?: string[] | undefined;
  /**
   * Where {@link mapping} came from, for the summary line alone (§7.6).
   *
   * The extractor cannot tell: an answer the model gave a moment ago and one
   * remembered from an earlier step are the same object by the time it sees
   * them. So the caller says, and the line reads `structure from the model` /
   * `from the run` — which matters because the first of those claims a model
   * call happened, and printing it over a reused mapping is a run log that
   * says money was spent when none was.
   *
   * Defaults to `model` when a mapping arrives with no source, which is what
   * every pre-existing caller means.
   */
  structureSource?: TableStructureSource | undefined;
}

/**
 * Which of §7.10's layers produced the mapping being applied: the one
 * question to the model, or this RUN's memo (`structure reused from step N`).
 */
export type TableStructureSource = 'model' | 'memo';

/**
 * One row of a candidate, as the sketch describes it (§7.10).
 *
 * Text and counts, never markup: the question the model is asked is about
 * SHAPE, and a page of HTML would invite it to answer about anything at all.
 */
export interface TableSketchRow {
  /** `T1.r3` — the candidate's id, then the row's one-based position in it. */
  id: string;
  /**
   * Which part of its candidate the row is in. What turns a model's "row 2 of
   * T1" into a `header` mapping, so the two kinds of row have to be tellable
   * apart here:
   *
   *   `thead` / `tbody` / `tfoot` — a `<tr>`, by the section it sits in.
   *   `header` — an ARIA header row (§7.9), the grid's spelling of `thead`.
   *   `row` — an ARIA data row.
   *
   * An ARIA heading row AFTER the data rows reads `tfoot`: §7.9 excludes it
   * exactly as a `<tfoot>` is excluded, so it gets the word that earns it the
   * footer refusal rather than a body-row number.
   */
  section: 'thead' | 'tbody' | 'tfoot' | 'header' | 'row';
  /** How many cells the row has. */
  cells: number;
  /** `th×8`, `td×1+th×2`, `columnheader×3` — the composition, in
   *  first-appearance order. */
  tags: string;
  /** `colspan 2,3,3; rowspan 2`, or `""`. */
  spans: string;
  rendered: boolean;
  /** The first few cells' rendered text, masked and then cut. */
  text: string[];
}

/** One table or ARIA grid the region holds (§7.10). */
export interface TableSketchCandidate {
  /** `T1`, `T2`, … — what a structure answer names. */
  id: string;
  /** CSS relative to the MAPPING ROOT, resolvable with `root.querySelector`;
   *  `:scope` is that root. This is what a {@link TableReadMapping} carries,
   *  so a caller translating the model's `T2` looks it up here. Never masked,
   *  unlike the text beside it: it is machinery, and a `#***` would resolve
   *  to nothing. */
  selector: string;
  kind: 'table' | 'grid';
  label: string;
  headerRowCount: number;
  dataRowCount: number;
  rows: TableSketchRow[];
  /** Rows beyond the ones listed. Absent when all of them are. */
  moreRows?: number;
}

/** What the region holds, for the one structure question of §7.10. */
export interface TableSketch {
  region: { selector: string; tag: string; id: string; label: string };
  candidates: TableSketchCandidate[];
  /** Candidates beyond the ones listed. Absent when all of them are. */
  moreCandidates?: number;
  /** Set when the sketch was shrunk to fit its size cap. */
  truncated?: boolean;
}

/**
 * A refusal §7.10 can answer: nothing with data rows under the region, two or
 * more of them, no header found by any path, two header-only candidates, or a
 * width mismatch in the pairing.
 *
 * It exists so the caller does not have to match on message text to decide
 * whether to ask the model. Every OTHER refusal — a header typo, a short row,
 * a merged cell, more than 500 rows, an ambiguous selector — is the author's
 * own problem, arrives as a plain `Error`, and carries no sketch: asking the
 * model about one would be asking for permission to read a different column.
 */
export class TableShapeError extends Error {
  readonly sketch: TableSketch | null;

  constructor(message: string, sketch: TableSketch | null) {
    super(message);
    this.name = 'TableShapeError';
    this.sketch = sketch;
  }
}

/** What one extraction found. */
export interface TableReadResult {
  /** One flat object per selected data row, `_row` first (§7.4). */
  records: Array<Record<string, string>>;
  /** Rows skipped for carrying no data: a full-width message row (§4.8), or a
   *  `<tr>` with no cells at all. Reported rather than swallowed so an
   *  unexpectedly short result can be explained from the log alone (§7.6). */
  placeholdersSkipped: number;
  /** Visible data rows found BEFORE `limit` was applied. */
  dataRowCount: number;
  /** The table's accessible name, as the diagnostics spell it. */
  label: string;
  /** Did the header come from a DIFFERENT `<table>` — declared through
   *  `aria-owns` or found beside the rows (§7.3a)? The summary line says so
   *  (§7.6), because a wrong pairing produces records that look exactly like
   *  a correct read and is otherwise invisible in the log. */
  headerFromSeparateTable: boolean;
  /** Present only when a {@link TableReadMapping} produced this read (§7.10).
   *  `summary` is the phrase the log line puts in its parenthetical —
   *  `rows in T2, header row 2 of T1`, or
   *  `12 items by ".account-card"; 2 items missing balance`. `source` is
   *  whichever layer the mapping came from, echoed back from the request.
   *  `rowsElsewhere` says the rows came out of a table that is NOT the
   *  element the author selected — legitimate under a wrapper, worth a warn
   *  line either way. */
  structure?: {
    kind: 'table' | 'collection';
    summary: string;
    source: TableStructureSource;
    rowsElsewhere?: boolean;
  };
  /** For a collection read: how many items each field was absent from, by
   *  column key (§7.10). A field absent from EVERY item fails the read; one
   *  absent from some reads `""` there and is counted here. */
  fieldsMissing?: Record<string, number>;
}

/**
 * Maximum structured rows one `readTable` returns.
 *
 * Unlike `READ_MULTIPLE_MAX` this is never a silent truncation: a table with
 * more rows and no author-requested `limit` FAILS (§7.5). A flat list that
 * stops at 500 is obviously short; a business table that stops at 500 is a
 * convincingly wrong answer, and the step after it asserts on the wrong set.
 */
export const READ_TABLE_MAX_ROWS = MAX_TABLE_ROWS;

// There is no `READ_TABLE_MAX_COLUMNS` beside `READ_TABLE_MAX_ROWS`, and the
// absence is deliberate. §9.2's "both paths validate identically" is kept by
// `validateTableRead` below, which is the parser's own function and enforces
// the column cap along with every other §6.2 rule — so an alias here would be
// a second name for a number nothing in this file reads, claiming to enforce
// something it does not.

/** The property the runtime writes on every record (§4.5). Never an alias —
 *  the parser rejects a column that claims it. */
const ROW_NUMBER_KEY = '_row';

/** What the page-side extractor answers (src/browser/scripts/read-table.js). */
type TableReadOutcome =
  | {
      ok: true;
      records: Array<Record<string, string>>;
      placeholdersSkipped: number;
      dataRowCount: number;
      label: string;
      headerFromSeparateTable: boolean;
      structure?: {
        kind: 'table' | 'collection';
        summary: string;
        source: TableStructureSource;
        rowsElsewhere?: boolean;
      };
      fieldsMissing?: Record<string, number>;
    }
  | { ok: false; error: string; shape: boolean; sketch?: TableSketch | null };

/** What it is asked. */
interface TableReadPageArgs {
  selector: string;
  columns: Array<{ header?: string; index?: number; key: string }>;
  limit: number | null;
  maxRows: number;
  rowKey: string;
  mapping: TableReadMapping | null;
  maskValues: string[];
  structureSource: TableStructureSource;
}

/**
 * The page-side extractor, compiled once.
 *
 * The body lives in `./scripts/read-table.js` and is loaded the way
 * `dom-cleaner.ts` and `login-fields.ts` load theirs — a string read at module
 * init, from a file the build copies next to the compiled output. `new
 * Function` runs in NODE, not in the page, so no page Content-Security-Policy
 * is involved; Playwright then serialises the result with
 * `Function.prototype.toString` and evaluates THAT source in the page, so what
 * the browser runs is the .js file verbatim.
 *
 * Verbatim is the point. Written inline as a TypeScript callback, its named
 * helpers came back from esbuild as `__name(fn, "fn")` — `keepNames` — and
 * `__name` exists only in the bundle: under `tsx` (`npm run dev`) the whole
 * extraction threw `ReferenceError: __name is not defined`, while `dist/`
 * (tsc, no such rewrite) was fine. Phase 3's `tables.read` bundle would have
 * met the same wall.
 */
const READ_TABLE_SCRIPT = readFileSync(
  fileURLToPath(new URL('./scripts/read-table.js', import.meta.url)),
  'utf8',
);
const readTableInPage = new Function(
  'matches',
  'args',
  `return (\n${READ_TABLE_SCRIPT}\n)(matches, args);`,
) as unknown as (matches: unknown[], args: TableReadPageArgs) => TableReadOutcome;

/**
 * Read named columns from one native `<table>` into one record per visible
 * data row.
 *
 * Header mapping, row selection, placeholder skipping, `_row` numbering and
 * every structural refusal happen in ONE browser-context evaluation (§7.5), so
 * a rerender between two round-trips cannot put one version's headers beside
 * another version's rows. That evaluation is also where the table's uniqueness
 * is established — strictly stronger than counting first and extracting after.
 *
 * Throws on every structural problem, with the message the author reads. The
 * caller's try/catch in {@link executeAction} turns that into a failed action,
 * which is what reaches the model and the report.
 *
 * A SHAPE problem (§7.10) throws {@link TableShapeError} instead, carrying the
 * sketch built in the same evaluation — the caller decides whether to ask the
 * model one structure question. Everything else throws a plain `Error` with
 * the sentence it has always had.
 */
export async function readTableRecords(
  root: Page | FrameLocator,
  request: TableReadRequest,
): Promise<TableReadResult> {
  const { selector } = request;
  // §6.2 in full, not just the column cap: the same validator the parser runs,
  // so a caller that never passes through `action-parser.ts` — phase 3's
  // generated `tables.read` — gets the same refusal and the same sentence
  // instead of a silently wrong read (§9.2). `where` is the only difference.
  const { columns, limit } = validateTableRead(
    { columns: request.columns, limit: request.limit },
    'readTable',
  );
  logger.subAction(
    `readTable ${selector} ${columns.length} column${columns.length === 1 ? '' : 's'}`
    + (limit !== undefined ? ` (limit ${limit})` : '')
    + (request.mapping !== undefined ? ` (structure: ${request.mapping.kind})` : ''),
  );

  const outcome = await root.locator(selector).evaluateAll(readTableInPage, {
    selector,
    // Only the fields the page needs. `mode` is phase 1's `'text'` by
    // definition (the parser refuses anything else), so it would be noise.
    columns: columns.map((c) => ({
      ...(c.header !== undefined && { header: c.header }),
      ...(c.index !== undefined && { index: c.index }),
      key: c.key,
    })),
    limit: limit ?? null,
    maxRows: READ_TABLE_MAX_ROWS,
    rowKey: ROW_NUMBER_KEY,
    mapping: request.mapping ?? null,
    maskValues: request.maskValues ?? [],
    structureSource: request.structureSource ?? 'model',
  });
  if (!outcome.ok) {
    // A shape refusal is thrown as its own class rather than matched on by
    // sentence: the sentences are the author's and will keep changing, and a
    // caller deciding whether to spend a model call on string matching is one
    // reworded message away from asking about a header typo (§7.10).
    if (outcome.shape) throw new TableShapeError(outcome.error, outcome.sketch ?? null);
    throw new Error(outcome.error);
  }
  // A structure answer that reads a table OTHER than the one the author's
  // selector matched. Legitimate — a wrapper region's rows are always a table
  // inside it — but it is the difference between reading what was asked for
  // and reading something beside it, and the records look identical either
  // way. WARN, so the line is in the log before anyone is puzzled by the
  // values rather than only in the report afterwards.
  if (outcome.structure?.rowsElsewhere) {
    logger.warn(
      `readTable: the structure given for "${selector}" reads a table that is not the element `
      + `the selector matched (${outcome.structure.summary})`,
    );
  }
  return {
    records: outcome.records,
    placeholdersSkipped: outcome.placeholdersSkipped,
    dataRowCount: outcome.dataRowCount,
    label: outcome.label,
    headerFromSeparateTable: outcome.headerFromSeparateTable,
    ...(outcome.structure !== undefined && { structure: outcome.structure }),
    ...(outcome.fieldsMissing !== undefined && { fieldsMissing: outcome.fieldsMissing }),
  };
}

/**
 * The one summary line a `readTable` writes to the run log (§7.6): counts, not
 * contents. The captured cells belong in the variable and the report, not in
 * every console the run passes through.
 *
 * The bound and the placeholder-skip count ride along because without them a
 * short result has no explanation in the log — "captured 0 rows" and "captured
 * 0 rows (1 placeholder row skipped)" are different findings. The column count
 * comes from what was ASKED for, so an empty table still says how wide the
 * read was.
 *
 * "header from a separate table" is the same argument for §7.3a: a grid whose
 * header was paired with the wrong rows returns records that look exactly like
 * a correct read, and this line is the only place the pairing is visible.
 */
/**
 * How the summary line names each source (§7.6).
 *
 * "the run" rather than "the memo": the reader of a run log has never heard of
 * a memo, and what the phrase has to say is that an EARLIER STEP of this same
 * run paid for the answer. The debug line beside it names the step.
 */
const STRUCTURE_SOURCE_WORDS: Record<TableStructureSource, string> = {
  model: 'the model',
  memo: 'the run',
};

export function formatTableReadSummary(
  result: TableReadResult,
  columnCount: number,
  as: string | undefined,
  limit: number | undefined,
): string {
  const rows = result.records.length;
  const notes: string[] = [];
  if (limit !== undefined) notes.push(`limit ${limit}`);
  if (result.placeholdersSkipped > 0) {
    notes.push(
      `${result.placeholdersSkipped} placeholder row${result.placeholdersSkipped === 1 ? '' : 's'} skipped`,
    );
  }
  if (result.headerFromSeparateTable) notes.push('header from a separate table');
  // §7.10's line: a read the model's structure answer produced looks exactly
  // like a structural one in the records, so the log is the only place the
  // difference is visible — and which table the rows came from is the first
  // thing to check when the values are wrong.
  //
  // It names the SOURCE, not just the fact. "structure from the model" over a
  // mapping reused from an earlier step would say a model call happened where
  // none did, which is the one thing §7.10's cost argument rests on; a reader
  // counting calls in the log would count wrong.
  if (result.structure) {
    notes.push(
      result.structure.kind === 'collection'
        ? `collection: ${result.structure.summary}`
        : `structure from ${STRUCTURE_SOURCE_WORDS[result.structure.source]}: `
          + `${result.structure.summary}`,
    );
  }
  return (
    `readTable captured ${rows} row${rows === 1 ? '' : 's'} `
    + `× ${columnCount} column${columnCount === 1 ? '' : 's'} as "{{${as ?? '(unnamed)'}}}"`
    + (notes.length > 0 ? ` (${notes.join(', ')})` : '')
  );
}
