/**
 * Where on the page does a failed assertion's expected text actually appear
 * (docs/specs/SPEC-web-survey-fixes.md §2.25)?
 *
 * An assertion that read the wrong element fails with "expected X, got Y", and
 * in the web survey a retry told only that sentence read the same wrong
 * element again. The survey's form-results page shows the submitted form
 * again above the results; both attempts read the empty form, while "Steptix
 * survey" sat in `li#_valuecomments` further down. Saying where the text is
 * turns a second guess into a second look.
 *
 * Never asked for a predicate or an `api` check, neither of which reads the
 * page. For one that may (`dom`, `both`), asked only when what the check read
 * does not hold the expected text even in another letter case — the two
 * compared in lower case and in upper case (`readHoldsExpected` in
 * src/ai/check-retry.ts, called from step-executor.ts): the check read the
 * wrong element. Here the text is matched with letter case kept, in text that
 * is shown: in the case it is shown in, or in its markup's case. The sentence
 * goes in the check's failure, for the person reading it and a retry that
 * plans the step again; a re-check of the same check is not told it
 * (steptix/steptix#97): the part it reads is the one its condition names.
 */
import type { Page } from 'playwright';

/** At most this many fragments are looked for, and this many places each. */
const MAX_FRAGMENTS = 4;
const MAX_PLACES = 3;

/**
 * The pieces of an expected value worth looking for on the page: the whole
 * value, each part of a list (`;`, newline, `, `, ` and `), and the value of a
 * `label: value` part. Fragments under three characters, too short to place,
 * and boolean-like words (`true`, `false`, `yes`, `no`, `null`, `undefined`)
 * are dropped.
 */
export function expectedFragments(expected: string | undefined): string[] {
  if (expected === undefined) return [];
  const out: string[] = [];
  const add = (raw: string): void => {
    // Unwrap one quoted value, but not `"Red" and "Green"`, whose outer
    // quotes belong to two different values.
    const trimmed = raw.trim();
    const quoted = /^["'“”]([^"'“”]*)["'“”]$/.exec(trimmed);
    const text = (quoted ? quoted[1]! : trimmed).trim();
    if (text.length < 3 || /^(true|false|yes|no|null|undefined)$/i.test(text)) return;
    if (!out.includes(text)) out.push(text);
  };
  add(expected);
  for (const part of expected.split(/;|\n|,\s+|\s+and\s+/)) {
    add(part);
    const labelled = /^[\w .-]{1,30}:\s*(.+)$/.exec(part.trim());
    if (labelled) add(labelled[1]!);
  }
  // The whole value first, then the smallest pieces, which place most precisely.
  const [whole, ...parts] = out;
  return [...(whole === undefined ? [] : [whole]), ...parts.sort((a, b) => a.length - b.length)].slice(0, MAX_FRAGMENTS);
}

export interface TextPlace {
  text: string;
  selectors: string[];
}

/**
 * For each fragment, CSS paths to the smallest visible elements whose shown
 * text, whitespace collapsed, contains it, in the case shown or in its
 * markup's case. Fragments found nowhere are left out. Never throws.
 */
export async function locateTexts(page: Page, fragments: string[]): Promise<TextPlace[]> {
  if (fragments.length === 0) return [];
  try {
    const found: unknown = await page.evaluate(
      ({ fragments, maxPlaces }) => {
        const g = globalThis as any;
        const doc = g.document;
        const esc = (s: string): string => (g.CSS?.escape ? g.CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
        const visible = (el: any): boolean =>
          typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null;
        const pathOf = (el: any): string => {
          const parts: string[] = [];
          for (let n = el; n && n !== doc.body && parts.length < 5; n = n.parentElement) {
            const tag = String(n.tagName).toLowerCase();
            if (n.id && doc.querySelectorAll(`#${esc(n.id)}`).length === 1) {
              parts.unshift(`${tag}#${esc(n.id)}`);
              return parts.join(' > ');
            }
            const same = n.parentElement
              ? Array.from(n.parentElement.children).filter((c: any) => c.tagName === n.tagName)
              : [n];
            parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
          }
          return parts.join(' > ');
        };
        const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD']);
        // Elements whose content is not text the page shows, though text
        // directly inside one passes `checkVisibility` whenever the element
        // has a box (an `<audio>` has one only with `controls`): a textarea's
        // content is its default value, shown — if at all — as the field's
        // value, which typing changes; an `<iframe>`'s is text between its
        // tags, which the parser keeps and nothing shows; the others' is
        // fallback content, which of these only an `<object>` shows, when it
        // has nothing it can embed. Its `innerText` then holds that text, so
        // the text is still found in the case it is shown in: only its
        // markup's case is left out (no hint rather than a wrong one).
        const NOT_SHOWN_AS_TEXT = 'textarea, canvas, video, audio, iframe, object, progress, meter';
        // An element's text as its markup has it, leaving out text that is
        // hidden or not shown as text: text in an element hidden by `display:
        // none` or `visibility: hidden`, and text inside the elements above.
        // (Transparent text, `opacity: 0`, is kept, as `innerText` keeps it.)
        // Text directly inside an element with no box of its own — `display:
        // contents`, an `<option>` of a closed `<select>` — which
        // `checkVisibility` calls hidden, is left out too: such text is not
        // found in its markup's case. A `<br>` adds no text node, so the text
        // either side of it is joined as the markup has it — with no space
        // between unless the markup has whitespace beside the `<br>` — as a
        // check that follows the assertion-code prompt (src/ai/prompts.ts)
        // joins it.
        const shownMarkup = (el: any): string => {
          let out = '';
          const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const parent = n.parentElement;
            if (!parent || SKIP.has(parent.tagName) || parent.closest(NOT_SHOWN_AS_TEXT)) continue;
            // `checkVisibilityCSS` and `visibilityProperty` are the same
            // option under its old and its new name: both are passed for the
            // engines that know only the old one.
            const shown = typeof parent.checkVisibility === 'function'
              ? parent.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
              : parent.offsetParent !== null;
            if (shown) out += n.data;
          }
          return out.replace(/\s+/g, ' ');
        };
        const all: any[] = Array.from(doc.body ? doc.body.querySelectorAll('*') : []);
        const result: Array<{ text: string; selectors: string[] }> = [];
        for (const text of fragments) {
          // Letter case kept: "Sign in" is not where "Sign In" is. A hint that
          // said it was pointed a retry at the wrong element (steptix/steptix#67).
          // Text as shown (`innerText` of an element that is shown: it leaves
          // hidden descendants out), or, where CSS `text-transform` shows it in
          // another case, as its markup has it — the markup of the text it
          // shows, leaving out hidden text and text not shown as text
          // (`shownMarkup`) — much as the assertion-code prompt
          // (src/ai/prompts.ts) asks a check to compare. Whitespace is
          // collapsed on both sides, as a check compares: a `&nbsp;`, or the
          // line break a `<br>` puts in the shown text, is a space. The case the
          // text is shown in is compared both ways round, as upper-casing can
          // change a text's length ("ß" is shown "SS").
          const spaced = text.replace(/\s+/g, ' ');
          const lowered = spaced.toLowerCase();
          const raised = spaced.toUpperCase();
          const holds = (el: any): boolean => {
            const shown = String(el.innerText ?? '').replace(/\s+/g, ' ');
            if (shown.includes(spaced)) return true;
            const otherCase = shown.toLowerCase().includes(lowered) || shown.toUpperCase().includes(raised);
            return otherCase && shownMarkup(el).includes(spaced);
          };
          const hits = all.filter((el) => {
            if (SKIP.has(el.tagName)) return false;
            if (!holds(el)) return false;
            // The smallest: no child element holds the whole fragment itself —
            // leaving out a child hidden by `display: none`, whose `innerText`
            // is its `textContent`, hidden text and all. A child with no box of
            // its own still counts, its `innerText` being its `textContent`
            // too: an option of a closed `<select>` holds its own text, so the
            // select is never taken for an option it does not show. (Chromium
            // gives a closed select an `innerText` that holds every option;
            // Firefox and WebKit give it none, so there it holds nothing.)
            // Such a child is never a hit itself either (`visible`, below), so
            // text whose smallest holder has no box — a closed select's current
            // option, text directly inside `display: contents` — is not pointed
            // at: no hint rather than a wrong one.
            return !Array.from(el.children).some((c: any) => g.getComputedStyle(c).display !== 'none' && holds(c));
          }).filter(visible);
          if (hits.length > 0) result.push({ text, selectors: hits.slice(0, maxPlaces).map(pathOf) });
        }
        return result;
      },
      { fragments, maxPlaces: MAX_PLACES },
    );
    return Array.isArray(found) ? (found as TextPlace[]) : [];
  } catch {
    return [];
  }
}

/**
 * A sentence to append to an assertion failure, or '' when no fragment of the
 * expected text is found ({@link locateTexts}): when it is nowhere on the
 * page, or there only in a letter case the page neither shows it in nor
 * writes it in, only hidden, only where it is not shown as text, or only where
 * its smallest holder has no box — or when it yields no fragment to look for
 * ({@link expectedFragments}): it is under three characters, or a
 * boolean-like word. Then the failure says all this can.
 */
export async function describeWhereExpectedIs(page: Page, expected: string | undefined): Promise<string> {
  const places = await locateTexts(page, expectedFragments(expected));
  if (places.length === 0) return '';
  const listed = places.map((p) => `"${p.text}" at ${p.selectors.join(', ')}`).join('; ');
  return ` — the page does show ${listed}. If that is what the step means, read it from there`;
}
