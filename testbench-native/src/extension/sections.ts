/**
 * The client's half of the inline-sections contract: what gets sent, and
 * what gets refused before anything is sent.
 *
 * Pure functions in their own module rather than methods on `RunController`,
 * for two reasons. They are the only part of the sectioned-run path that can
 * be unit-tested without a VS Code host — and `run-controller.ts` uses
 * TypeScript parameter properties, which Node's type-stripping test runner
 * cannot parse, so anything importable from there is untestable under
 * `node --test`.
 *
 * See stories/test-script-sections-contract.md §3.2 for the wire shape and
 * §2.5 for the naming rules.
 */

import { readFileSync } from 'node:fs';
import { parseSectionDataRows, extractSections, matchText, sectionNameError } from 'ai-ui-automation-runner-core';

/** One entry of the `sections` request field. */
export interface SectionPayloadEntry {
  name: string;
  headingLine: number;
  steps: string[];
  stepLines: number[];
  /** Rows from a table under the `### Name` heading: the server expands the
   *  body once per row (stories/data-driven-rows.md, part B). */
  rows?: Array<Record<string, string>>;
  /** Where each shipped row sits in the AUTHORED table, 1-based and parallel
   *  to `rows` — sent only when a selection narrowed the loop
   *  (stories/data-row-progress-and-selection.md, decision 1). */
  rowNumbers?: number[];
  /** The authored table's total row count, so a narrowed iteration still
   *  reads `(2/3)`. Sent with `rowNumbers` or not at all — the server refuses
   *  one without the other. */
  rowCount?: number;
  /** 0-based indices into `steps`: run only these body steps, per iteration —
   *  a selection narrows the body the way it narrows the rows
   *  (stories/data-row-progress-and-selection.md, decision 3). Ascending and
   *  unique; absent means the whole body. */
  runSteps?: number[];
}

/**
 * The `sections` request payload for `text`, or null when it defines none.
 *
 * Null rather than `{}` on purpose. The wire contract treats an empty map as
 * absent, and several server gates read `request.sections` directly — sending
 * `{}` would move every sectionless run onto the expansion path, changing
 * behaviour for tests that have nothing to do with this feature.
 *
 * Built on a null-prototype object: `### __proto__` is a legal section name
 * (nothing in the naming rules forbids it), and assigning that key into an
 * object literal invokes the prototype setter instead — the definition would
 * vanish here, before the request was sent, where none of the server's
 * validation could see it. The contract lists this as the fourth of four maps
 * that have to guard against it, and the only one on this side of the wire.
 */
export function buildSectionsPayload(
  text: string,
  /**
   * Narrow a section's loop to these 1-based table positions, keyed by the
   * section name as authored (stories/data-row-progress-and-selection.md
   * §Selecting rows of a section). A section not named here ships all of its
   * rows, exactly as before — an axis nobody narrowed means all of it.
   *
   * The chosen rows travel with `rowNumbers` and `rowCount` so the server can
   * number each iteration by its position in the AUTHORED table: without them
   * a run of row 2 alone would be stamped `iteration 1 of 1` and every surface
   * downstream — the frame, the banner, the `(2/3)` badge — would name the
   * wrong row.
   */
  sectionRows?: Record<string, number[]>,
  /**
   * Narrow a `### Section`'s BODY to these 0-based step indices, keyed by the
   * section name as authored. The sibling axis of `sectionRows`: a selection
   * that names three main-flow steps, one body step and one table row narrows
   * all three, and none of the three knows about the others (decision 3).
   *
   * A section not named here ships its whole body, which is every run that
   * existed before this — and so does one whose whole body was selected: a
   * narrowing that keeps everything has narrowed nothing.
   */
  sectionSteps?: Record<string, number[]>,
): Record<string, SectionPayloadEntry> | null {
  const sections = extractSections(text);
  if (sections.length === 0) return null;

  // Rows for any section that carries a data table (part B). Scanned rather
  // than read off `extractSections`, whose return shape is frozen by the
  // sections contract. A malformed table is reported by the run controller,
  // which surfaces the message; here it simply means no rows to ship.
  let rowsByName = new Map<string, Array<Record<string, string>>>();
  try {
    rowsByName = parseSectionDataRows(text);
  } catch {
    /* the run controller reports it */
  }

  const payload = Object.create(null) as Record<string, SectionPayloadEntry>;
  for (const section of sections) {
    const key = matchText(section.name);
    // Keyed by match text, first definition wins — matching the parser. A
    // duplicate is refused by `preflightSections` before this runs, so this
    // is belt-and-braces rather than a policy decision.
    if (key === '' || Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const allRows = rowsByName.get(section.name);
    // The narrowing, applied here rather than at the scan: `rowsByName` is
    // also what says how many rows the table HAS, and `rowCount` is that
    // number — not the number that survived the filter.
    const chosen = sectionRows?.[section.name];
    const narrowed =
      allRows !== undefined && chosen !== undefined && chosen.length > 0
        ? [...new Set(chosen)]
            .sort((a, b) => a - b)
            .filter((n) => n >= 1 && n <= allRows.length)
        : null;
    // Sanitised the way the rows are, and for the same reason: the numbers
    // came from a selection made against a buffer the caller has since let go
    // of, so an index the body does not have is dropped rather than shipped
    // for the server to refuse. A list that survives as "every step" is not a
    // narrowing and is not sent — the wire stays byte-identical for it.
    const chosenSteps = sectionSteps?.[section.name];
    const runSteps =
      chosenSteps === undefined
        ? null
        : (() => {
            const kept = [...new Set(chosenSteps)]
              .filter((n) => Number.isInteger(n) && n >= 0 && n < section.steps.length)
              .sort((a, b) => a - b);
            return kept.length === 0 || kept.length === section.steps.length ? null : kept;
          })();
    payload[key] = {
      name: section.name,
      headingLine: section.headingLine,
      steps: section.steps.map((s) => s.instruction),
      stepLines: section.steps.map((s) => s.line),
      ...(runSteps && { runSteps }),
      ...(allRows !== undefined &&
        (narrowed && narrowed.length > 0
          ? {
              rows: narrowed.map((n) => allRows[n - 1]!),
              rowNumbers: narrowed,
              rowCount: allRows.length,
            }
          : { rows: allRows })),
    };
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

/**
 * Why `text`'s sections can't be run, or null if they can.
 *
 * The CLI refuses bad names at parse time, and the wire format cannot even
 * represent a duplicate — a JSON object collapses them, last one wins. So
 * without this check the CLI would error on a file TestBench ran anyway,
 * silently picking a different definition. That divergence is the reason this
 * feature has a frozen cross-package contract at all.
 *
 * Runs before any request is built, so a refused file costs nothing.
 */
export function preflightSections(text: string): string | null {
  const sections = extractSections(text);
  if (sections.length === 0) return null;

  const seen = new Map<string, number>();
  for (const section of sections) {
    // Empty names reach here only because the line model classifies a
    // hashes-only `###` as a section heading. That rule exists precisely so
    // this check can see them: left as prose, TestBench would run the body
    // below as main-flow steps while the CLI refused the file.
    const invalid = sectionNameError(section.name);
    if (invalid) return `Line ${section.headingLine}: ${invalid}`;

    const key = matchText(section.name);
    const previous = seen.get(key);
    if (previous !== undefined) {
      return (
        `Line ${section.headingLine}: duplicate section "${section.name}" — ` +
        `already defined at line ${previous}. Section names are matched ` +
        `case-insensitively, so only one definition can ever win.`
      );
    }
    seen.set(key, section.headingLine);
  }
  return null;
}

/**
 * Why a re-run against `failure` cannot be anchored safely, or null.
 *
 * Line anchors into a SKILL file assume document order matches execution
 * order there. A skill that defines its own sections breaks that: its section
 * bodies sit numerically below its main flow but execute wherever they are
 * called, so the server's `startAt` scan — which only applies exact matching
 * to the TEST file — falls back to nearest-line and can anchor inside a body
 * that already ran. Measured: re-running from a skill's last step re-executed
 * two already-passed body steps against the live session, and reported green.
 *
 * Fixing that needs "compare against the step's top-level-ancestor source
 * line", which is an anchoring redesign rather than a patch. Until then both
 * skill-anchored flows refuse, per the runtime spec §7.
 *
 * Gated on `kind === 'skill'` deliberately. For a SECTION failure `skillUri`
 * is the test file, which by definition defines sections — a kind-blind check
 * would refuse every section re-run, the exact flow this feature adds.
 */
export function sectionedSkillRefusal(failure: {
  kind: 'skill' | 'section';
  skillUri: string;
  skillName: string;
}): string | null {
  if (failure.kind !== 'skill') return null;
  let text: string;
  try {
    text = readFileSync(failure.skillUri, 'utf-8');
  } catch {
    // Unreadable skill file: let the normal flow run and fail with its own
    // error rather than inventing one here.
    return null;
  }
  if (extractSections(text).length === 0) return null;
  return (
    `TestBench: can't re-run inside "${failure.skillName}" — it defines inline ` +
    `sections, and line anchors into a sectioned skill file can re-run steps ` +
    `that already passed. Run the test again instead.`
  );
}
