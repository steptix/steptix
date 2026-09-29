/**
 * The section-diagnostics decision, with no VS Code dependency.
 *
 * Kept separate from `section-providers.ts` (which imports `vscode`) so the
 * whole decision — which rows fire, where, at what severity — is unit-testable
 * under `node --test`, which cannot load the `vscode` module.
 *
 * Every row but the near-miss restates a parse or expansion error. Liveness
 * uses the expander's exact flat rule (via `buildSectionIndex`), so the
 * "never used" info and the run-time dead-section warning can never disagree.
 * See steptix-vscode/stories/specs/inline-sections-authoring.md §3.4.
 */
import {
  buildSectionIndex,
  classifyLines,
  inertRegionHeading,
  isTestFile,
  matchText,
  sectionNameError,
  stepWrapsAt,
  unknownWholeStepBracketError,
  useStepError,
} from 'steptix-runner-core';

/**
 * A diagnostic as plain data. `line` is 0-based; `[startCol, endCol)` is the
 * squiggle range. The provider maps these onto `vscode.Diagnostic`.
 */
export interface PlainDiagnostic {
  line: number;
  startCol: number;
  endCol: number;
  severity: 'error' | 'warning' | 'information';
  message: string;
}

/**
 * The maximum edit distance at which a plain step is flagged as a possible
 * typo of a section name. 1-2 catches "Logn"/"Login" and "Log in"/"Log inn"
 * without firing on genuinely different instructions.
 */
export const NEAR_MISS_MAX_DISTANCE = 2;

export function computeSectionDiagnostics(text: string): PlainDiagnostic[] {
  if (!isTestFile(text)) return [];
  const index = buildSectionIndex(text);
  const lines = text.split(/\r?\n/);
  const out: PlainDiagnostic[] = [];
  const headingSpan = (lineIdx: number): { startCol: number; endCol: number } => {
    const raw = lines[lineIdx] ?? '';
    const startCol = raw.length - raw.replace(/^#{1,6}\s*/, '').length;
    // A bare `###` has no text after the hashes, so `startCol === raw.length`
    // — a zero-width range is invisible in the editor. Fall back to underlining
    // the hashes themselves so the squiggle is on something.
    if (startCol >= raw.length) return { startCol: 0, endCol: raw.length };
    return { startCol, endCol: raw.length };
  };

  // Numbered items under a `####` heading. They look exactly like steps and
  // nothing runs them — which is precisely why they need saying out loud: the
  // grammar used to absorb them into the main flow or into whichever section
  // body was open, silently, and an author had no way to tell from the file.
  // One row per item, on the item, because that is the line the author will
  // be looking at when they wonder why it never ran.
  for (const entry of classifyLines(text)) {
    if (entry.kind !== 'inert-step') continue;
    const raw = lines[entry.line - 1] ?? '';
    const owner = inertRegionHeading(text, entry.line);
    out.push({
      line: entry.line - 1,
      startCol: 0,
      endCol: raw.length,
      severity: 'warning',
      message:
        "This step never runs: steps under a '####' heading" +
        (owner ? ` ("${owner.name}", line ${owner.line})` : '') +
        " are ignored. Use '###' to define a section, then call it by name from " +
        'the main flow.',
    });
  }

  // Surface switches, and bracket steps that name no directive at all
  // (docs/specs/SPEC-use-computer.md §4.1 / §4.2, surfaced per §10.3).
  //
  // These are the first rows here that restate a STEP-GRAMMAR parse error
  // rather than a section one, and they are here because this is the only
  // while-typing diagnostics surface the extension has. The alternative —
  // meeting `[use phone]` for the first time from a server that has already
  // opened a browser — is the failure §4.2 exists to remove, so it should not
  // be reintroduced one layer up.
  //
  // `[use …]` is asked FIRST: `[use]` and `[use phone]` are whole-step
  // brackets too, and reported by the second rule they would get the generic
  // directive list instead of the sentence naming the two surfaces. Same
  // order the CLI parser uses (src/parser/markdown.ts).
  const classifiedForSteps = classifyLines(text);
  for (const entry of classifiedForSteps) {
    if (entry.kind !== 'step' && entry.kind !== 'section-step') continue;
    // A wrapped list item is ONE step whose text spans several lines, and the
    // CLI judges the whole item. Reading only the first physical line would
    // squiggle `[use computer]` on an item whose real text carries trailing
    // words — a refusal the runtime does not make — so wrapped items are left
    // to the run-time parse error, which sees the whole thing.
    //
    // Indexed by `entry.line - 1`, the idiom `buildSectionIndex` uses, rather
    // than by the loop counter: the two are equal today because `classifyLines`
    // emits one entry per line, and that is a property of the classifier rather
    // than of its contract.
    if (stepWrapsAt(lines, classifiedForSteps, entry.line - 1)) continue;
    const raw = lines[entry.line - 1] ?? '';
    const prefix = /^\s*\d+\.\s+/.exec(raw);
    if (!prefix) continue;
    const startCol = prefix[0].length;
    const instruction = raw.slice(startCol);
    const message =
      useStepError(instruction) ?? unknownWholeStepBracketError(instruction);
    if (message === null) continue;
    out.push({
      line: entry.line - 1,
      startCol,
      endCol: raw.length,
      severity: 'error',
      message,
    });
  }

  // Name-level errors. `duplicates` carries every losing heading AND every
  // empty-name heading (under name ""), so both come from one source.
  for (const dup of index.duplicates) {
    out.push({
      line: dup.headingLine - 1,
      ...headingSpan(dup.headingLine - 1),
      severity: 'error',
      message:
        dup.name === ''
          ? 'A section heading has an empty name. Give it a name after the `###`.'
          : `Duplicate section "${dup.name}" — a section with this name ` +
            `(case-insensitively) is already defined earlier. Only one definition can win.`,
    });
  }

  // A defined name that is itself invalid, or a section with no steps.
  for (const [, section] of index.sections) {
    const span = headingSpan(section.headingLine - 1);
    const invalid = sectionNameError(section.name);
    if (invalid) {
      out.push({ line: section.headingLine - 1, ...span, severity: 'error', message: invalid });
    }
    if (section.stepCount === 0) {
      out.push({
        line: section.headingLine - 1,
        ...span,
        severity: 'error',
        message:
          `Section "${section.name}" has no steps. An invoked section with an empty ` +
          `body fails at expansion time.`,
      });
    }
  }

  // Liveness — any resolved call anywhere counts, including one inside another
  // (even dead) section. A section whose own name is invalid was already
  // reported; don't pile "never used" onto it.
  const invoked = new Set(index.calls.map((c) => matchText(c.name)));
  for (const [key, section] of index.sections) {
    // Skip a section already flagged for an invalid name OR an empty body —
    // both are Errors the author must fix first, and "never used" piled on top
    // is noise pointing at the same line.
    if (sectionNameError(section.name) || section.stepCount === 0) continue;
    if (!invoked.has(key)) {
      out.push({
        line: section.headingLine - 1,
        ...headingSpan(section.headingLine - 1),
        severity: 'information',
        message:
          `Section "${section.name}" is never used. If a step was meant to call it, ` +
          `the names may no longer match.`,
      });
    }
  }

  // Near-miss: a plain step within edit distance 1-2 of exactly one section
  // name. Same match text as resolution, so casing/whitespace never counts as
  // distance; bracket-token lines are already out of `nonCallSteps`.
  //
  // Candidates exclude invalid-named sections. Such a section is already
  // flagged as an Error and can never be a legal call target, so "Did you mean
  // `Steps`?" would send the author to rename a step to a reserved word — a
  // second error. Same skip the liveness loop makes, for the same reason.
  const names = [...index.sections.entries()]
    .filter(([, section]) => sectionNameError(section.name) === null)
    .map(([key]) => key);
  for (const nonCall of index.nonCallSteps) {
    const candidates = names.filter((name) => {
      const d = editDistance(nonCall.matchText, name);
      return d >= 1 && d <= NEAR_MISS_MAX_DISTANCE;
    });
    if (candidates.length !== 1) continue; // unique near-match only
    const section = index.sections.get(candidates[0]!)!;
    const lineIdx = nonCall.line - 1;
    out.push({
      line: lineIdx,
      startCol: nonCall.nameStart,
      endCol: (lines[lineIdx] ?? '').length,
      severity: 'warning',
      message: `Did you mean section "${section.name}"?`,
    });
  }

  return out;
}

/**
 * Levenshtein distance, capped: only whether it is ≤ 2 matters, so bail out of
 * a row once its minimum possible value exceeds the cap. Keeps the O(n·m)
 * inner loop cheap over the many non-call steps of a real document.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > NEAR_MISS_MAX_DISTANCE) return NEAR_MISS_MAX_DISTANCE + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > NEAR_MISS_MAX_DISTANCE) return NEAR_MISS_MAX_DISTANCE + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
