/**
 * Where on the page does a failed assertion's expected text actually appear
 * (docs/specs/SPEC-web-survey-fixes.md §2.25)?
 *
 * An assertion that read the wrong element fails with "expected X, got Y", and
 * the retry gets that sentence and nothing else, so it reads the same wrong
 * element again. The survey's form-results page shows the submitted form again
 * above the results; both attempts read the empty form, while "Steptix survey"
 * sat in `li#_valuecomments` further down. Saying where the text is turns a
 * second guess into a second look.
 */
import type { Page } from 'playwright';

/** At most this many fragments are looked for, and this many places each. */
const MAX_FRAGMENTS = 4;
const MAX_PLACES = 3;

/**
 * The pieces of an expected value worth looking for on the page: the whole
 * value, each part of a list (`;`, newline, `, `, ` and `), and the value of a
 * `label: value` part. Booleans, numbers under three characters and other
 * fragments too short to place are dropped.
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
 * For each fragment, CSS paths to the smallest visible elements whose rendered
 * text contains it. Fragments found nowhere are left out. Never throws.
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
        const all: any[] = Array.from(doc.body ? doc.body.querySelectorAll('*') : []);
        const result: Array<{ text: string; selectors: string[] }> = [];
        for (const text of fragments) {
          const needle = text.toLowerCase();
          const hits = all.filter((el) => {
            if (SKIP.has(el.tagName)) return false;
            const own = String(el.innerText ?? '').toLowerCase();
            if (!own.includes(needle)) return false;
            // The smallest: no child element holds the whole fragment itself.
            return !Array.from(el.children).some((c: any) => String(c.innerText ?? '').toLowerCase().includes(needle));
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
 * A sentence to append to an assertion failure, or '' when the expected text is
 * nowhere on the page (then the failure already says all there is to say).
 */
export async function describeWhereExpectedIs(page: Page, expected: string | undefined): Promise<string> {
  const places = await locateTexts(page, expectedFragments(expected));
  if (places.length === 0) return '';
  const listed = places.map((p) => `"${p.text}" at ${p.selectors.join(', ')}`).join('; ');
  return ` — the page does show ${listed}. If that is what the step means, read it from there`;
}
