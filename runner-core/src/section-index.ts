/**
 * A whole-document view of a test file's inline sections: what is defined,
 * what calls what, and what looks like a call but resolves to nothing.
 *
 * Built entirely from `classifyLines` / `extractSections`, so it agrees with
 * the editor's own painting by construction. Its consumers are the authoring
 * affordances (go-to-definition, document links, the "never used" and
 * near-miss diagnostics) and the run-time pre-flight that refuses a file the
 * server would mis-execute.
 *
 * See stories/test-script-sections-contract.md §3.5 for the frozen shape and
 * §2.2 / §2.4 for the two rules this file implements that more than one
 * package depends on.
 */

import { classifyLines, extractSections, stepWrapsAt } from './step-lines.js';
import { matchText, NO_HOOKS_MARKER } from './section-match.js';
import { parseControlLine } from './control-line.js';

/** One entry of {@link SectionIndex.sections}. */
interface DefinedSection {
  name: string;
  headingLine: number;
  stepCount: number;
}

export interface SectionIndex {
  /**
   * Defined sections, keyed by `matchText(name)`. First definition wins.
   * Empty-name headings NEVER enter this map — they are unaddressable, so
   * indexing them would invent a section nothing can call.
   */
  sections: Map<string, DefinedSection>;
  /**
   * Every step line resolving to a section — main-flow **and** body lines, so
   * a section calling another section is a call site like any other.
   * `nameStart` is the 0-based column where the match text begins (past the
   * `N. ` prefix and any `[no-hooks] ` marker), which is what a link range or
   * a squiggle underlines.
   */
  calls: { line: number; name: string; nameStart: number }[];
  /** Plain-text steps resolving to nothing. Bracket-directive lines excluded. */
  nonCallSteps: { line: number; matchText: string; nameStart: number }[];
  /**
   * Headings that lost to an earlier definition — the Map collapses them, so
   * without this they would vanish silently — plus EVERY empty-name heading,
   * under name `""`.
   */
  duplicates: { name: string; headingLine: number }[];
}

/**
 * A step opening with `[` is treated as a directive, not a section call.
 *
 * Contract §2.2 names four tokens (`[skill:`, `[tool:`, `[input:`,
 * `[interactive]`); this is deliberately broader. Be precise about what the
 * difference costs:
 *
 *  - For `calls`, broadening is **free**. A section name may not begin with
 *    `[` (§2.5, enforced by `sectionNameError`), so a `[`-leading step can
 *    never equal a name under any reading.
 *  - For `nonCallSteps`, it drops one case: a bracket-ish step that is *not*
 *    a known directive, such as `1. [note] Login`. Under the narrow reading
 *    that would be a near-miss for `### Login`; here it is reported as
 *    neither a call nor a near-miss.
 *
 * That loss is the intended trade. Enumerating the four tokens would put a
 * fifth copy of the bracket grammar in the tree, and it would drift — a new
 * directive added elsewhere would immediately start producing spurious
 * "did you mean" warnings on every line that used it. A missing near-miss
 * hint is a smaller failure than a wrong one.
 */
const DIRECTIVE_STEP_RE = /^\[/;

export function buildSectionIndex(text: string): SectionIndex {
  const sections = new Map<string, DefinedSection>();
  const duplicates: { name: string; headingLine: number }[] = [];

  for (const section of extractSections(text)) {
    const key = matchText(section.name);
    if (key === '') {
      duplicates.push({ name: '', headingLine: section.headingLine });
      continue;
    }
    if (sections.has(key)) {
      duplicates.push({ name: section.name, headingLine: section.headingLine });
      continue;
    }
    sections.set(key, {
      name: section.name,
      headingLine: section.headingLine,
      stepCount: section.steps.length,
    });
  }

  const calls: SectionIndex['calls'] = [];
  const nonCallSteps: SectionIndex['nonCallSteps'] = [];
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(text);

  for (const entry of classified) {
    if (entry.kind !== 'step' && entry.kind !== 'section-step') continue;

    const raw = lines[entry.line - 1] ?? '';
    const located = locateMatchText(raw);
    if (!located) continue;
    if (DIRECTIVE_STEP_RE.test(located.text)) continue;

    // A wrapped list item is one step whose text spans several lines, and the
    // CLI matches on the WHOLE item — which can never equal a single-line
    // heading name. Reading only the first physical line here would draw a
    // link the runtime never follows, with go-to-definition working and the
    // "never used" diagnostic staying quiet while the section never ran.
    const wrapped = stepWrapsAt(lines, classified, entry.line - 1);
    const lookup = (candidateText: string): DefinedSection | undefined =>
      wrapped ? undefined : sections.get(matchText(candidateText));

    // Resolution order (stories/control-flow.md, decision 3): the WHOLE line is
    // tested against the section names FIRST, because a step that IS a section
    // name is a call before it is anything else. A section unwisely named
    // `While waiting, keep the page open` is still called by a step spelling
    // it out, and the CLI expands it that way — so reading the tail first
    // reported both the section and its call site as something they are not.
    let candidate = located;
    let defined = lookup(located.text);

    if (!defined) {
      // Only now is the line allowed to be a control line, and then its TAIL
      // is the call site — the one clause stories/control-flow.md adds to
      // contract §2.4. `nameStart` moves to the tail's first character so a
      // resolved tail underlines the section name and not the keyword, and a
      // NEAR MISS is reported at the same column, where the author has to fix
      // it.
      //
      // A bracket-directive tail (`[skill:]`, `[tool:]`) drops out entirely,
      // for the reason a bracket-directive step does: its own grammar claims
      // it, and a section name may not begin with `[`.
      const control = parseControlLine(located.text);
      if (control) {
        if (DIRECTIVE_STEP_RE.test(control.tail)) continue;
        candidate = { text: control.tail, start: located.start + control.tailStart };
        defined = lookup(control.tail);
      }
    }

    const key = matchText(candidate.text);
    if (defined) {
      // `defined.name` rather than the call site's own casing: consumers use
      // this to look the section back up and to label it, and the definition
      // is what the author named it.
      calls.push({ line: entry.line, name: defined.name, nameStart: candidate.start });
    } else {
      nonCallSteps.push({ line: entry.line, matchText: key, nameStart: candidate.start });
    }
  }

  return { sections, calls, nonCallSteps, duplicates };
}

/**
 * The match-side text of a step line plus the 0-based column it starts at.
 *
 * Returns null for a line with no content after the ordinal — those are
 * culled everywhere else, so indexing them would be the only place a bare
 * `1.` became addressable.
 */
function locateMatchText(raw: string): { text: string; start: number } | null {
  const prefix = /^\s*\d+\.\s+/.exec(raw);
  if (!prefix) return null;

  let start = prefix[0].length;
  const afterPrefix = raw.slice(start);

  const marker = NO_HOOKS_MARKER.exec(afterPrefix);
  if (marker) start += marker[0].length;

  const text = raw.slice(start).trim();
  if (text === '') return null;
  return { text, start };
}
