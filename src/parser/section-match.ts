/**
 * The inline-sections match rule — the single derivation every implementation
 * must reproduce. See stories/test-script-sections-contract.md §2.
 *
 * This module exists so the parser and the expander literally share one copy
 * rather than each carrying its own. The client-side reimplementations
 * (runner-core and the extension copies) can't import it, so they are pinned
 * instead by the frozen table at `fixtures/sections/match-table.json`.
 */

/**
 * Prefix marker on a step that opts out of beforeEach / afterEach hooks.
 * Anchored and case-insensitive; both properties are load-bearing for the
 * match rule (`[NO-HOOKS] Login` resolves, `**[no-hooks]** Login` does not).
 */
export const NO_HOOKS_MARKER = /^\[no-hooks\]\s*/i;

/** Reserved `## H2` keywords. A section may not be named any of these — a
 *  file that reads as though it has two `Steps` sections is a bug worth
 *  refusing rather than resolving. */
export const RESERVED_SECTION_NAMES: ReadonlySet<string> = new Set([
  'steps',
  'config',
  'parameters',
  'outputs',
  'hooks',
]);

/**
 * Reduce a raw string to its comparable form.
 *
 * `casefold` is `toLowerCase()` — deliberately NOT `toLocaleLowerCase()`,
 * which follows the host locale: a Turkish-locale client and a C-locale
 * server would disagree about dotted/dotless I and resolve the same file
 * differently. Order is strip → trim → casefold; the strip is anchored, so it
 * runs before the trim can move leading whitespace out of its way.
 *
 * Applied to BOTH sides of every comparison — step text and heading text —
 * and used to key every section map.
 */
export function matchText(s: string): string {
  return s.replace(NO_HOOKS_MARKER, '').trim().toLowerCase();
}

/**
 * The match-side input for step `i` of any step list — main flow or section
 * body, CLI or server (contract §2.1).
 *
 * `rawSteps` is present on the CLI parse path and absent on the server path,
 * where steps already arrive in raw/instruction form. Reading `steps[i]`
 * directly is wrong even where the two happen to be equal: on the CLI path
 * `steps` has been through `extractPlainText` and, inside a skill,
 * `applySkillScope` — so a body line authored as `{{target}}` would resolve
 * against its interpolated value rather than the text on the page.
 */
export function matchInput(
  list: { steps: string[]; rawSteps?: string[] | undefined },
  i: number,
): string {
  return list.rawSteps?.[i] ?? list.steps[i] ?? '';
}

/**
 * Validate a section name, throwing with a file+line pointer on refusal.
 *
 * One list, three enforcement points (contract §2.5): this parser raises a
 * parse error, steptix-vscode's pre-flight refuses the run before building
 * a request, and the authoring diagnostics mirror each as an Error row. They
 * must agree, or a file the CLI rejects runs anyway in the editor.
 */
export function validateSectionName(
  name: string,
  filePath: string,
  headingLine: number,
): void {
  const where = `${filePath}:${headingLine}`;
  const trimmed = name.trim();

  if (trimmed === '') {
    throw new Error(
      `Section heading at ${where} has an empty name. A \`###\` heading inside ` +
        `\`## Steps\` defines a section and must be named (e.g. \`### Login\`).`,
    );
  }
  if (RESERVED_SECTION_NAMES.has(trimmed.toLowerCase())) {
    throw new Error(
      `Section "${trimmed}" at ${where} uses a reserved section keyword. ` +
        `Rename it — a file that reads as though it has two \`${trimmed}\` ` +
        `sections is too easy to misread.`,
    );
  }
  if (trimmed.startsWith('[')) {
    throw new Error(
      `Section "${trimmed}" at ${where} may not begin with "[". Steps starting ` +
        `with a bracket token are claimed by the \`[skill:]\` / \`[tool:]\` ` +
        `parsers first, so this section could never be invoked.`,
    );
  }
  if (trimmed.includes('{{')) {
    throw new Error(
      `Section "${trimmed}" at ${where} may not contain "{{". Inside a skill, ` +
        `\`{{...}}\` in a call line is interpolated but the heading is data, so ` +
        `the call would silently stop matching after interpolation.`,
    );
  }
}
