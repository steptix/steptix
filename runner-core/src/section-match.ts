/**
 * The inline-section match rule, client side.
 *
 * This is a deliberate mirror of [src/parser/section-match.ts](../../src/parser/section-match.ts)
 * — runner-core cannot import the CLI parser, so the derivation is written
 * twice and the two copies are kept honest by `fixtures/sections/match-table.json`,
 * which both packages assert against.
 *
 * See stories/test-script-sections-contract.md §2. The rules that keep biting:
 *
 *  - `toLowerCase()`, **never** `toLocaleLowerCase()`. The latter follows the
 *    host locale, so a Turkish-locale editor and a C-locale server would
 *    disagree about dotted/dotless I and the same file would execute
 *    differently depending on where it was launched.
 *  - Strip the marker, then trim, then casefold — in that order. The strip is
 *    anchored at `^`, so a leading space defeats it.
 *  - `trim()` touches the ends only. Internal whitespace runs are significant.
 */

/**
 * Verbatim from src/parser/markdown.ts. Every reimplementation must carry
 * both the anchor and the `/i` flag.
 */
export const NO_HOOKS_MARKER = /^\[no-hooks\]\s*/i;

/** Reserved H2 keywords a section may not be named after (contract §2.5). */
export const RESERVED_SECTION_NAMES: ReadonlySet<string> = new Set([
  'steps',
  'config',
  'parameters',
  'outputs',
  'hooks',
]);

/** The one derivation, applied to both sides of every comparison. */
export function matchText(s: string): string {
  return s.replace(NO_HOOKS_MARKER, '').trim().toLowerCase();
}

/**
 * Why `name` is not a legal section name, or null if it is.
 *
 * Non-throwing so the authoring diagnostics can render one Error row per
 * offending heading rather than failing the whole document; the CLI parser
 * raises the equivalent as a parse error. Duplicate detection is NOT here —
 * it needs the whole document, and `buildSectionIndex` reports it.
 */
export function sectionNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Section heading has an empty name.';
  if (RESERVED_SECTION_NAMES.has(trimmed.toLowerCase())) {
    return `"${trimmed}" is a reserved section keyword.`;
  }
  if (trimmed.startsWith('[')) {
    return `Section name may not begin with "[" — bracket directives are parsed first.`;
  }
  if (name.includes('{{')) {
    return 'Section name may not contain "{{".';
  }
  return null;
}
