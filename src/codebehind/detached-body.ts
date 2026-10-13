import { placeholderRoot } from '../parser/parameters.js';
import { matchText } from '../parser/section-match.js';
import {
  detachedBodyOffsets,
  referencedVariableNames,
  type ExpandedFrame,
  type ExpandedStepOrigin,
  type SectionDefs,
} from '../skills/expander.js';
import type { CodeBehindExpansion } from './loader.js';

/**
 * Code-behind for `### Section` body steps that run on their own
 * (steptix-vscode/stories/specs/sections-run-and-resume.md §4.2).
 *
 * Select body lines and press Run, and they are sent DETACHED: as plain steps
 * at the root frame, with nothing invoking the section. That is right for
 * execution, and wrong for binding. The section's compiled entries carry
 * `section: '<its name>'`, because a full run reaches those steps through the
 * section's frame, while a detached step's own expansion says "top level". So
 * a detached step bound nothing and ran under AI, or bound a top-level entry
 * that happened to share its text, and ran that.
 *
 * This moves only the binding. The run's expansion is rewritten for the
 * registry so each of those root-frame steps sits in a section frame of its
 * own section's name, at the occurrence it holds in the authored body. The
 * steps still execute detached. `buildCodeBehindRegistry` binds the result as
 * it binds any section frame, with no special case of its own.
 */

/**
 * Where one step of a detached batch came from: the `### Section` whose body
 * it was selected from, by its authored name, and its 0-based position in that
 * body.
 *
 * `step` is absent on `compileScope`, the older attribution that Compile This
 * Step sends, which names one section for the whole request and no positions.
 * Without positions no occurrence can be corrected, which is why the client
 * refuses a compile that would need one.
 */
export interface DetachedBodyStep {
  section: string;
  step?: number;
}

/**
 * The expansion to bind a detached batch through.
 *
 * `picks` is parallel to the request's INPUT steps (an origin's `inputIndex`),
 * not to the expanded list: one input can expand to several steps. Only the
 * steps an input emits into the ROOT frame move. A body step that calls a
 * sibling section or a `[skill:]` already expanded into that section's or
 * skill's own frame, which binds where it should. Moving it too would file a
 * skill's entries under this section in the test's `.steps.ts`.
 *
 * `sections` supplies the authored bodies the occurrence is counted over. An
 * input with no `step`, or a section not in `sections`, keeps the occurrence
 * it counted within this batch.
 */
export function detachedBodyExpansion(
  expansion: CodeBehindExpansion,
  picks: ReadonlyArray<DetachedBodyStep | undefined>,
  testFilePath: string,
  sections: SectionDefs = {},
): CodeBehindExpansion {
  const offsets = occurrenceOffsets(picks, sections);
  const frames: Record<string, ExpandedFrame> = { ...expansion.frames };
  const frameFor = (section: string): string => {
    // One frame per section, however many of its steps the batch holds, so
    // they count occurrences together, as they would inside one call of it.
    // The expander mints `f<n>`, so this prefix cannot collide with its ids.
    const id = `detached:${matchText(section)}`;
    frames[id] ??= {
      id,
      parentId: null,
      kind: 'section',
      uri: testFilePath,
      invocationLine: null,
      // The field a section frame carries its name in, and the one
      // `resolveDefiningSite` reads the entry's `section:` scope from.
      skillName: section,
    };
    return id;
  };

  const rootEmissions = new Map<number, number>();
  const origins = expansion.origins.map((origin): ExpandedStepOrigin => {
    const pick = picks[origin.inputIndex];
    if (!pick || origin.frameId !== '') return origin;
    // A control line emits its guard and then its tail into this frame, and
    // each holds its own slot (`DroppedAhead` is one offset per emission).
    const nth = rootEmissions.get(origin.inputIndex) ?? 0;
    rootEmissions.set(origin.inputIndex, nth + 1);
    const offset = offsets.get(origin.inputIndex)?.[nth] ?? 0;
    const { occurrenceOffset: _ignored, ...rest } = origin;
    return {
      ...rest,
      frameId: frameFor(pick.section),
      ...(offset > 0 && { occurrenceOffset: offset }),
    };
  });

  return { ...expansion, origins, frames };
}

/**
 * Per input index: how many same-text emissions of its section's body the
 * batch left out ahead of each of its own emissions.
 *
 * Grouped by section and kept in batch order, which the step route has already
 * checked runs in body order. The registry counts the kept ones itself (they
 * share a frame); this supplies the rest. So a body that reads `Click Next`
 * three times and is run from its third line binds the third entry, not the
 * first.
 */
function occurrenceOffsets(
  picks: ReadonlyArray<DetachedBodyStep | undefined>,
  sections: SectionDefs,
): Map<number, number[]> {
  const groups = new Map<string, { section: string; inputs: number[]; steps: number[] }>();
  picks.forEach((pick, input) => {
    if (pick?.step === undefined) return;
    const key = matchText(pick.section);
    let group = groups.get(key);
    if (!group) {
      group = { section: pick.section, inputs: [], steps: [] };
      groups.set(key, group);
    }
    group.inputs.push(input);
    group.steps.push(pick.step);
  });

  const out = new Map<number, number[]>();
  for (const group of groups.values()) {
    const perKept = detachedBodyOffsets(sections, group.section, group.steps);
    if (!perKept) continue;
    group.inputs.forEach((input, j) => out.set(input, perKept[j] ?? []));
  }
  return out;
}

/**
 * The steps of a detached batch whose authored text reads a looped section's
 * row: expanded index → the column it reads. `expansion` is the run's own, the
 * one `detachedBodyExpansion` is given, where those steps are still in the root
 * frame.
 *
 * A looped section binds each iteration's row as that frame's inputs, and its
 * compiled entries read the row with `getVar('<column>')`. A detached run has
 * no row, so that read answers `undefined`. Replaying the entry then throws and
 * marks it ⚠, or does the wrong thing quietly, and neither is the entry's
 * fault. These steps keep running under AI, as every detached step did before.
 *
 * Columns of ANY looped section count, not only the step's own. A section
 * called from inside a looped one inherits that row as well, and no table of
 * its own says so.
 */
export function detachedRowReads(
  expansion: Pick<CodeBehindExpansion, 'origins' | 'rawSteps' | 'steps'>,
  picks: ReadonlyArray<DetachedBodyStep | undefined>,
  sections: SectionDefs = {},
): Map<number, string> {
  const columns = new Set<string>();
  for (const section of Object.values(sections)) {
    for (const row of section.rows ?? []) {
      for (const column of Object.keys(row)) columns.add(column);
    }
  }
  const reads = new Map<number, string>();
  if (columns.size === 0) return reads;

  expansion.origins.forEach((origin, i) => {
    if (origin.frameId !== '' || !picks[origin.inputIndex]) return;
    const text = expansion.rawSteps[i] ?? expansion.steps[i] ?? '';
    const column = referencedVariableNames(text).placeholders
      .map(placeholderRoot)
      .find((name) => columns.has(name));
    if (column !== undefined) reads.set(i, column);
  });
  return reads;
}
