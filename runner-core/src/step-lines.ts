/**
 * Step-line classifier.
 *
 * A "test file" is any Markdown that contains a heading matching
 * /^#{2,}\s+steps\s*$/i. Inside the body of that heading (until the next
 * same-or-higher-level heading), numbered list items are step lines.
 *
 * Constraints:
 *  - Only `1.` style is recognised. `1)` is intentionally not supported.
 *  - YAML frontmatter (delimited by `---` on the first non-blank line) is
 *    excluded from classification.
 *  - Indented numbered items (e.g. nested sub-lists) are not steps.
 *
 * Inline sections
 * ---------------
 * A `### Name` heading inside a **depth-2** `## Steps` section opens a named
 * section; its numbered items are that section's body rather than main-flow
 * steps. See stories/test-script-sections-contract.md §5 for the frozen
 * classification order, and §3 of the same document for which exports see
 * body lines:
 *
 *  - main flow only  — `extractSteps`, `resolveRunLines`,
 *    `nearestStepAtOrBelow|Above`. Body lines are `section-step`, so every one
 *    of these filters them out by construction.
 *  - caller's choice — `resolveRunSelection` and `classifySelectedSteps`,
 *    whose `scope` argument defaults to main-flow. `resolveRunSelection` is
 *    the only function allowed to *pick* the scope; see
 *    testbench-native/stories/specs/sections-run-and-resume.md §4.1.
 *  - main + body     — `extractStepLineIds`, which lives in the extension
 *    hosts and webviews, not here.
 */

import { matchText, NO_HOOKS_MARKER } from './section-match.js';
import {
  chainAfterFlowControlMessage,
  chainMemberWord,
  closedChainMemberMessage,
  danglingChainMemberMessage,
  isFlowControlLine,
  parseControlLine,
} from './control-line.js';

export type LineKind =
  | 'step'
  | 'section-heading'
  | 'section-step'
  /**
   * A numbered item inside a depth->=4 heading's ignored region
   * (contract §5 rule 4a). It LOOKS like a step and is not one: nothing
   * runs it, in the main flow or in any body, and nothing may address it.
   *
   * A distinct kind rather than 'prose' because the editor still has to
   * treat it as a numbered item to explain itself — dim it, and say why it
   * will not run — and a distinct kind rather than 'step'/'section-step'
   * because every consumer that dispatches on those must exclude it by
   * construction rather than by remembering to.
   */
  | 'inert-step'
  | 'frontmatter'
  | 'heading'
  | 'prose'
  | 'blank';

export interface ClassifiedLine {
  /** 1-based line number to match Monaco/VS Code conventions. */
  line: number;
  kind: LineKind;
}

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\d+\.\s+\S/;
/**
 * A heading line made of nothing but hashes. `ANY_HEADING_RE` demands a
 * non-space after the hashes and so cannot see these at all — without the
 * dedicated rule a bare `###` would classify as prose, and TestBench would
 * run the items below it as main-flow steps while the CLI refused the file
 * with an empty-name parse error. Contract §5 rule 3.
 */
const HASHES_ONLY_RE = /^#{3,}\s*$/;
/** Depth of the `## Steps` heading under which sections are recognised. */
const SECTION_HOST_DEPTH = 2;
/** The `N. ` ordinal prefix, stripped to get a step's instruction text. */
const STEP_PREFIX_RE = /^\s*\d+\.\s+/;

/**
 * Returns true iff the document contains a Steps heading. Cheap pre-check
 * used by the editor binder to decide whether to claim a `.md` file.
 */
export function isTestFile(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (STEPS_HEADING_RE.test(line)) return true;
  }
  return false;
}

/**
 * Classify every line in the document. Stable, single-pass; the returned
 * array is dense (one entry per source line).
 */
export function classifyLines(text: string): ClassifiedLine[] {
  const lines = text.split(/\r?\n/);
  const out: ClassifiedLine[] = new Array(lines.length);

  // Pass 1 — locate frontmatter span (lines are 0-indexed here).
  const frontmatterEnd = findFrontmatterEnd(lines);

  // Pass 2 — locate the Steps section span.
  const stepsSpan = findStepsSection(lines, frontmatterEnd + 1);

  // Sections are recognised only under a depth-2 `## Steps`. Under a `###
  // Steps` a `###` line *closes* the span rather than landing in it, so no
  // section could be defined anyway — but a hashes-only line is invisible to
  // the span scanner too, so without this gate rule 3 would fire inside a
  // deeper Steps heading and diverge from the CLI. Contract §5 precondition.
  const sectionsEnabled = stepsSpan !== null && stepsSpan.headingDepth === SECTION_HOST_DEPTH;

  // Set once the first section heading in the span is seen: from there on,
  // every step line in the span belongs to a body, not the main flow.
  let inSectionBody = false;

  // Set by a depth->=4 heading WITH TEXT inside the span, cleared by the next
  // `section-heading` (a `###` with text, or a hashes-only line at any depth —
  // both of which open a real section). Everything numbered in between is
  // inert: the old grammar called such a heading "inert prose" and then let
  // the items beneath it run, in the main flow or in whichever body was open.
  let inIgnoredRegion = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? '';

    if (i <= frontmatterEnd) {
      out[i] = { line: lineNumber, kind: 'frontmatter' };
      continue;
    }

    if (raw.trim() === '') {
      out[i] = { line: lineNumber, kind: 'blank' };
      continue;
    }

    const inSteps = stepsSpan !== null && i >= stepsSpan.start && i <= stepsSpan.end;
    const inSectionSpan = sectionsEnabled && inSteps;

    if (inSectionSpan && HASHES_ONLY_RE.test(raw)) {
      inIgnoredRegion = false;
      inSectionBody = true;
      out[i] = { line: lineNumber, kind: 'section-heading' };
      continue;
    }

    const heading = ANY_HEADING_RE.exec(raw);
    if (heading) {
      if (inSectionSpan && heading[1]!.length === SECTION_HOST_DEPTH + 1) {
        inIgnoredRegion = false;
        inSectionBody = true;
        out[i] = { line: lineNumber, kind: 'section-heading' };
        continue;
      }
      // A depth->=4 heading with text opens an ignored region: it still does
      // not close the body it sits in, but nothing numbered under it runs.
      if (inSectionSpan) inIgnoredRegion = true;
      out[i] = { line: lineNumber, kind: 'heading' };
      continue;
    }

    if (inSteps && STEP_LINE_RE.test(raw)) {
      out[i] = {
        line: lineNumber,
        kind: inIgnoredRegion ? 'inert-step' : inSectionBody ? 'section-step' : 'step',
      };
      continue;
    }

    out[i] = { line: lineNumber, kind: 'prose' };
  }

  return out;
}

/**
 * True iff the given 1-based line is a **main-flow** step line. A section
 * body line is a step to the eye but not a runnable unit on its own, so this
 * returns false for one.
 */
export function isStepLine(text: string, lineNumber: number): boolean {
  const classified = classifyLines(text);
  const entry = classified[lineNumber - 1];
  return entry?.kind === 'step';
}

/** Nearest **main-flow** step at or below `lineNumber` (1-based), or null. */
export function nearestStepAtOrBelow(text: string, lineNumber: number): number | null {
  const classified = classifyLines(text);
  for (let i = lineNumber - 1; i < classified.length; i++) {
    if (classified[i]?.kind === 'step') return classified[i]!.line;
  }
  return null;
}

/** Nearest **main-flow** step at or above `lineNumber` (1-based), or null. */
export function nearestStepAtOrAbove(text: string, lineNumber: number): number | null {
  const classified = classifyLines(text);
  for (let i = lineNumber - 1; i >= 0; i--) {
    if (classified[i]?.kind === 'step') return classified[i]!.line;
  }
  return null;
}

/**
 * Extract the **main-flow** step instructions in order, returning each step's
 * source line number alongside the cleaned text (number prefix stripped).
 *
 * Section body lines classify as `section-step` and are therefore excluded —
 * a body runs only when something invokes it, so treating body lines as
 * runnable steps would execute them twice (once inline, once per call) and
 * once more with no enclosing frame. Contract §5, consumer split.
 *
 * Note this does **not** apply the §3.1 cull rule (an item that is empty
 * after the `[no-hooks]` strip survives here). That is pre-existing
 * behaviour, relied on by the run paths; `extractSections` culls, this
 * doesn't, and the difference is deliberate.
 */
export function extractSteps(text: string): { line: number; instruction: string }[] {
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(text);
  const out: { line: number; instruction: string }[] = [];

  for (let i = 0; i < classified.length; i++) {
    if (classified[i]?.kind !== 'step') continue;
    const raw = lines[i] ?? '';
    const instruction = raw.replace(STEP_PREFIX_RE, '').trim();
    out.push({ line: i + 1, instruction });
  }

  return out;
}

/**
 * The `runStart` for a batch that starts a new run at `firstLine` — the
 * 1-based document line of the first step it sends (SPEC-use-computer.md
 * §4.5; `StreamStepsRequest.runStart`).
 *
 * `stepIndex` is that step's position in {@link extractSteps}, which is the
 * list a client sends as `fullSteps` — so the server's "last `[use …]` above
 * `stepIndex`" reads the same lines the client numbered. A first line that is
 * not a main-flow step (a `### Section` body line run detached) has no
 * position there, and gets no `stepIndex`: the server then starts the run on
 * the browser surface, which is the safe direction.
 */
export function runStartFor(text: string, firstLine: number): { stepIndex?: number } {
  const index = extractSteps(text).findIndex((s) => s.line === firstLine);
  return index >= 0 ? { stepIndex: index } : {};
}

/**
 * The inline sections defined in `text`, in document order, each with its
 * body steps attached.
 *
 * Empty-name entries **are** emitted (a hashes-only heading, contract §5
 * rule 3): monaco's refusal and native's pre-flight both need to see them in
 * order to refuse the file rather than silently running its bodies. They are
 * the reason this returns an array rather than a map — duplicate and empty
 * names are exactly what the callers are looking for.
 *
 * Applies the §3.1 cull rule: a body item that is empty after the `N. ` strip
 * and the `[no-hooks]` strip is dropped, so a marker-only `1. [no-hooks]`
 * never reaches the wire as a blank instruction. (`extractSteps` does not
 * cull; that asymmetry is deliberate and pinned by tests.)
 */
export function extractSections(
  text: string,
): { name: string; headingLine: number; steps: { line: number; instruction: string }[] }[] {
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(text);
  const out: {
    name: string;
    headingLine: number;
    steps: { line: number; instruction: string }[];
  }[] = [];

  for (let i = 0; i < classified.length; i++) {
    const kind = classified[i]?.kind;
    const raw = lines[i] ?? '';

    if (kind === 'section-heading') {
      out.push({
        name: raw.replace(/^#{3,}\s*/, '').trim(),
        headingLine: i + 1,
        steps: [],
      });
      continue;
    }

    if (kind !== 'section-step') continue;

    // A `section-step` can only follow a `section-heading` in the same span,
    // so `current` is always defined here; the guard keeps this total rather
    // than relying on that invariant holding after a future edit.
    const current = out[out.length - 1];
    if (!current) continue;

    const instruction = raw.replace(STEP_PREFIX_RE, '').trim();
    if (instruction.replace(NO_HOOKS_MARKER, '').trim() === '') continue;
    current.steps.push({ line: i + 1, instruction });
  }

  return out;
}

/**
 * Every section body step in the document, flattened in document order.
 *
 * Sourced from `extractSections` rather than a fresh scan so the §3.1 cull
 * rule applies: a body item that is empty after the `N. ` and `[no-hooks]`
 * strips is not a runnable step and must not be selectable as one.
 */
function sectionBodySteps(text: string): { line: number; instruction: string }[] {
  return extractSections(text).flatMap((s) => s.steps);
}

/**
 * Body step lines of the inline section whose span contains 1-based `line`,
 * or `[]` when `line` sits in no section body.
 *
 * The span deliberately runs **heading to next heading**, not first-body-step
 * to last. The caller is the resume anchor's snap-forward: it asks this
 * question about a line whose own step may have just been deleted, and a span
 * measured from the surviving steps would stop covering it at exactly that
 * moment. Measuring from the heading keeps the answer stable for any edit
 * short of deleting the heading itself.
 *
 * The last section's span is unbounded below. A `line` past the end of the
 * `## Steps` span is therefore attributed to it — harmless, because the only
 * consumer then looks for a body step at or after `line`, finds none, and
 * clears the anchor, which is the same answer an exact bound would give.
 */
export function sectionBodyLinesAt(text: string, line: number): number[] {
  const sections = extractSections(text);
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i]!.headingLine;
    const end = i + 1 < sections.length ? sections[i + 1]!.headingLine - 1 : Infinity;
    if (line >= start && line <= end) return sections[i]!.steps.map((s) => s.line);
  }
  return [];
}

/**
 * Whether the step at 0-based `index` is a list item that **wraps** onto
 * following lines.
 *
 * Markdown continues a list item across lines; the CLI matches and executes
 * the item's whole folded text, while everything in this file sees only its
 * first physical line. So for a wrapped item the two disagree about what the
 * step even says:
 *
 *     1. Type the username
 *        into the tenant field, then press Enter
 *
 * runner-core reads `Type the username`; the CLI runs both lines. Folding
 * them here would mean reimplementing marked's list semantics in a fourth
 * place — the exact drift this feature exists to remove — so instead callers
 * are given the means to **refuse**.
 *
 * A **whitelist**: this reports "not wrapped" only for shapes verified
 * unambiguous against the real parser, so every inaccuracy is a false alarm
 * rather than a missed one.
 *
 * The over-refusals are real and not few. Measured against marked, a line
 * directly below a step folds into it when it is prose, a nested bullet, a
 * table row, a setext underline, indented code or a link reference — but does
 * NOT fold when it is a blockquote, an HTML comment or block, a thematic
 * break, a fenced-code opener, or a bare `N.`. This function treats all of
 * them as folding, so the second group is conservatively called wrapped.
 *
 * That list is deliberately **not** encoded here. Splitting it correctly
 * means reimplementing markdown's block grammar in a fourth place, which is
 * the drift §1 of the contract exists to prevent; the cost of getting it
 * wrong in the safe direction is a missing link and a spurious warning, and
 * in the unsafe direction it is a step that silently does something else.
 * `tests/section-index-cli-parity.test.ts` fuzzes the unsafe direction
 * against the real CLI parser.
 */
export function stepWrapsAt(
  lines: string[],
  classified: ClassifiedLine[],
  index: number,
): boolean {
  let sawBlank = false;
  for (let i = index + 1; i < classified.length; i++) {
    const kind = classified[i]!.kind;
    if (kind === 'blank') {
      sawBlank = true;
      continue;
    }
    // A new step, or any heading, unambiguously ends the item.
    if (kind !== 'prose') return false;
    // Prose directly below continues the item, indented or not (markdown's
    // "lazy continuation"). After a blank line only an indented line
    // continues it; an unindented paragraph starts a new block.
    return !(sawBlank && !/^\s/.test(lines[i] ?? ''));
  }
  // End of document: nothing can continue the item.
  return false;
}

/**
 * 1-based lines of every step — main flow **and** section bodies — whose list
 * item wraps onto following lines.
 *
 * The consumer is the run-time pre-flight: a wrapped step cannot be
 * represented on the wire (the `sections` payload carries one string per
 * step), so a file containing one executes differently from TestBench than
 * from the CLI and must be refused rather than silently truncated.
 *
 * Wrapped **main-flow** steps have always been truncated by `extractSteps`,
 * long before sections existed, so those lines are reported for completeness
 * and callers may choose to tolerate them. Wrapped **body** steps are the new
 * hazard and the reason this exists: a body step whose first line happens to
 * equal a section name dispatches into that section on the server path while
 * the CLI runs the wrapped instruction — a silent change of control flow, not
 * merely of text.
 */
export function findWrappedStepLines(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(text);
  const out: number[] = [];
  for (let i = 0; i < classified.length; i++) {
    const kind = classified[i]?.kind;
    if (kind !== 'step' && kind !== 'section-step') continue;
    if (stepWrapsAt(lines, classified, i)) out.push(i + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step-class classifier — recognises [input: var] and [interactive] markers
// inside step instructions so the host runner can pause for the user.
// ---------------------------------------------------------------------------

const INPUT_STEP_PATTERN = /^\[input:\s*(\w+)\]\s*(.*)$/i;
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]\s*(.*)$/i;

export type ClassifiedStep =
  | { kind: 'step'; line: number; instruction: string }
  | { kind: 'input'; line: number; varName: string; prompt: string }
  | { kind: 'interactive'; line: number; hint: string };

/**
 * Which step list a run is drawn from. `'section-body'` runs body steps
 * **detached** — at the root frame, with no enclosing invocation — which is
 * sound because a section shares its caller's scope rather than owning one.
 * See sections-run-and-resume.md §4.2.
 */
export type RunScope = 'main-flow' | 'section-body';

export interface RunSelection {
  scope: RunScope;
  /** 1-based lines to execute, ascending. */
  lines: number[];
}

/**
 * Translate a user's line selection into the steps that should run, and say
 * which list they came from.
 *
 * Resolution order, which is the whole of the design (§4.1):
 *
 *  1. Empty request → every main-flow step. "Run everything" never means a
 *     body: a body executes at its call site, so running it inline as well
 *     would run the flow twice.
 *  2. Any selected line is a main-flow step → those, main-flow scope. **Body
 *     lines in the same selection are dropped.** A drag from the main flow
 *     down through a `### Login` body selects both the invocation and the
 *     body it expands to; running both is that same double-run bug wearing a
 *     selection as a disguise. This rung is also what keeps every selection
 *     that worked before sections existed behaving identically.
 *  3. Any selected line is a section-body step → those, section-body scope.
 *     Reachable only when the selection names no main-flow step at all.
 *  4. Otherwise (a heading, prose, a blank) → every main-flow step at or
 *     below the lowest selected line, so clicking `## Steps` and pressing Run
 *     still runs the file.
 *  5. Nothing left → `[]`, and the caller reports TB025.
 */
export function resolveRunSelection(
  text: string,
  requestedLines: number[],
): RunSelection {
  const mainFlow = extractSteps(text);
  if (requestedLines.length === 0) {
    return { scope: 'main-flow', lines: mainFlow.map((s) => s.line) };
  }

  const requested = new Set(requestedLines);

  const mainMatches = mainFlow.filter((s) => requested.has(s.line)).map((s) => s.line);
  if (mainMatches.length > 0) return { scope: 'main-flow', lines: mainMatches };

  const bodyMatches = sectionBodySteps(text)
    .filter((s) => requested.has(s.line))
    .map((s) => s.line);
  if (bodyMatches.length > 0) return { scope: 'section-body', lines: bodyMatches };

  const minSelected = Math.min(...requestedLines);
  return {
    scope: 'main-flow',
    lines: mainFlow.filter((s) => s.line >= minSelected).map((s) => s.line),
  };
}

/**
 * Pull out the steps the user wants to run, classifying each one as a normal
 * step, an `[input: var]` placeholder, or an `[interactive]` REPL handoff.
 *
 * If `requestedLines` is empty, every step in `scope` is returned. Otherwise,
 * only steps in `scope` whose source line is in the set, preserving document
 * order.
 *
 * `scope` is trailing and defaults to `'main-flow'` so every call site that
 * predates sections keeps its old contract: a requested line naming a body
 * step matches nothing. Callers that want body steps must have been handed
 * `'section-body'` by `resolveRunSelection`, which is the only place the
 * choice is made.
 */
export function classifySelectedSteps(
  text: string,
  requestedLines: number[],
  scope: RunScope = 'main-flow',
): ClassifiedStep[] {
  const all = scope === 'section-body' ? sectionBodySteps(text) : extractSteps(text);
  const filtered =
    requestedLines.length === 0
      ? all
      : all.filter((s) => requestedLines.includes(s.line));

  return filtered.map((s) => classifyOne(s));
}

/**
 * Translate a user's line selection into the step lines that should actually
 * run. The contract:
 *
 *  - Empty `requestedLines` → every step in the document.
 *  - If any selected line is a step line, return only those (preserving
 *    document order).
 *  - If the selection contains no step lines (user clicked a heading,
 *    blank line, prose), fall back to "every step at or below the first
 *    selected line" — so clicking `## Steps` and pressing Run executes
 *    the whole section instead of failing with TB021.
 *  - If the fallback finds nothing (selection is past the last step),
 *    return `[]` — caller decides how to surface that.
 *
 * "Step" means **main-flow step** throughout: selecting a section body line
 * resolves to `[]`, and a selection entirely below the last main-flow step
 * resolves to `[]`. Callers must distinguish that empty result from the
 * empty-request case, which means "run everything" — the condition is
 * `requested.length > 0 && resolved.length === 0`, never `resolved.length
 * === 0` alone.
 *
 * Now expressed as `resolveRunSelection` narrowed to the main flow, so the
 * two cannot drift. The narrowing is byte-identical to the standalone version
 * this replaced, not merely close: sections are defined below the main flow
 * inside the `## Steps` span, so a body-only selection's fallback ("main-flow
 * steps at or below the lowest selected line") was already always empty.
 *
 * Kept main-flow-only on purpose — this is what `runLines([])` and the
 * breakpoint trimmer read, and a body step must never appear there.
 */
export function resolveRunLines(text: string, requestedLines: number[]): number[] {
  const selection = resolveRunSelection(text, requestedLines);
  return selection.scope === 'main-flow' ? selection.lines : [];
}

/**
 * Why this document's control flow cannot be run as written, or null.
 *
 * ONE rule with two halves, the same one the CLI parser and the expander
 * apply: *an `Else if` / `Otherwise` must follow a chain member on the
 * previous step line of the same flow, and must not follow the `Otherwise`
 * that closed it*. The wordings come from {@link danglingChainMemberMessage}
 * and {@link closedChainMemberMessage}, mirrored from
 * `src/parser/control-line.ts` and pinned by
 * `tests/control-line-parity.test.ts` — an author who meets this refusal in
 * the editor and again from the CLI must read the same sentence, naming the
 * same line.
 *
 * The client checks it because the client is the one cutting the batch. The
 * case that motivates the check is an `[input: …]` / `[interactive]` step
 * between two members: those end a batch, so the two halves of one decision
 * land in different requests and the `Otherwise` arrives with nothing to be
 * the alternative of. But the rule is stated on the chain rather than on the
 * `[input:]`, because that is a document the CLI parser cannot produce — an
 * `[input:]` line IS a numbered step, so it breaks the chain before it can sit
 * inside one, and blaming it would leave TestBench and the CLI pointing at
 * different lines for the same file.
 *
 * A step whose text names a defined section is a CALL, not a control line
 * (resolution order, decision 3), which is why the section names are read
 * first: without that, a `### Otherwise, …`-named section called from the main
 * flow would be refused for a chain it never joins.
 *
 * Inside a tail's SECTION BODY an `[input:]` is fine — the same carve-out
 * sections already have, and it falls out for free here because a body is a
 * different flow from the main list.
 */
export function danglingChainMemberError(text: string): string | null {
  const sectionList = extractSections(text);
  const sectionNames = new Set(sectionList.map((s) => matchText(s.name)));
  const flows: { name: string; steps: { line: number; instruction: string }[] }[] = [
    { name: '## Steps', steps: extractSteps(text) },
    ...sectionList.map((s) => ({ name: `### ${s.name}`, steps: s.steps })),
  ];

  for (const flow of flows) {
    /** The chain member on the PREVIOUS step line of this flow, or null. */
    let previous: 'if' | 'elseif' | 'else' | null = null;
    /** Whether that chain has already had its `Otherwise`. */
    let closed = false;
    /** The previous step line when it was a FLOW-CONTROL step — an `If` that
     *  ends the flow rather than choosing a branch, and the one an author is
     *  most likely to write an `Otherwise` under. */
    let previousFlowControl: string | null = null;
    for (const step of flow.steps) {
      if (sectionNames.has(matchText(step.instruction))) {
        previous = null;
        previousFlowControl = null;
        closed = false;
        continue;
      }
      const control = parseControlLine(step.instruction);
      if (!control) {
        previous = null;
        // Rung 0 declined it as a control line, so this is where a
        // flow-control step lands and the only place it can be remembered.
        previousFlowControl = isFlowControlLine(step.instruction) ? step.instruction : null;
        closed = false;
        continue;
      }
      if (control.kind === 'elseif' || control.kind === 'else') {
        if (previousFlowControl !== null) {
          return chainAfterFlowControlMessage({
            line: step.instruction,
            word: chainMemberWord(control.kind),
            previous: previousFlowControl,
            where: `Line ${step.line}`,
          });
        }
        if (previous === null) {
          return danglingChainMemberMessage({
            line: step.instruction,
            word: chainMemberWord(control.kind),
            flow: flow.name,
            where: `Line ${step.line}`,
          });
        }
        // The other half of the rule: `Otherwise` is the LAST member, so an
        // `Else if` or a second `Otherwise` under one is refused too. Without
        // it the client ran a file the CLI parser rejects — and at run time a
        // second `Otherwise`'s tail is unreachable (`fallbackOf` takes the
        // first condition-less member) while an `Else if` below one is still
        // evaluated.
        if (closed) {
          return closedChainMemberMessage({
            line: step.instruction,
            where: `Line ${step.line}`,
          });
        }
        previous = control.kind;
        previousFlowControl = null;
        closed = control.kind === 'else';
        continue;
      }
      previous = control.kind === 'if' ? 'if' : null;
      previousFlowControl = null;
      closed = false;
    }
  }
  return null;
}

function classifyOne(step: { line: number; instruction: string }): ClassifiedStep {
  const inputMatch = step.instruction.match(INPUT_STEP_PATTERN);
  if (inputMatch) {
    return {
      kind: 'input',
      line: step.line,
      varName: inputMatch[1]!,
      prompt: (inputMatch[2] ?? '').trim() || `Enter value for {{${inputMatch[1]}}}`,
    };
  }
  const interactiveMatch = step.instruction.match(INTERACTIVE_STEP_PATTERN);
  if (interactiveMatch) {
    return {
      kind: 'interactive',
      line: step.line,
      hint:
        (interactiveMatch[1] ?? '').trim() ||
        'Type instructions to run, "done" to continue, "exit" to stop',
    };
  }
  return { kind: 'step', line: step.line, instruction: step.instruction };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the 0-based index of the closing `---`, or -1 if no frontmatter. */
function findFrontmatterEnd(lines: string[]): number {
  // Skip leading blanks.
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;

  if (i >= lines.length || (lines[i] ?? '').trim() !== '---') return -1;

  for (let j = i + 1; j < lines.length; j++) {
    if ((lines[j] ?? '').trim() === '---') return j;
  }

  // Unterminated frontmatter — be lenient, treat as no frontmatter.
  return -1;
}

interface Span {
  /** 0-based index of the first line *after* the heading. */
  start: number;
  /** 0-based index of the last line in the section (inclusive). */
  end: number;
  /** Hash count of the `Steps` heading itself — 2 for `## Steps`. */
  headingDepth: number;
}

/**
 * Find the body span of the first matching `## Steps` (or deeper) heading.
 * Section ends at the next heading of equal or shallower depth, or EOF.
 */
function findStepsSection(lines: string[], from: number): Span | null {
  let headingIndex = -1;
  let headingDepth = 0;

  for (let i = from; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] ?? '');
    if (m) {
      headingIndex = i;
      headingDepth = m[1]!.length;
      break;
    }
  }

  if (headingIndex < 0) return null;

  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = ANY_HEADING_RE.exec(lines[i] ?? '');
    if (m && m[1]!.length <= headingDepth) {
      return { start: headingIndex + 1, end: i - 1, headingDepth };
    }
  }

  return { start: headingIndex + 1, end: lines.length - 1, headingDepth };
}

/**
 * The depth-≥4 heading whose ignored region contains `line`, or null when the
 * line is not inert (contract §5 rule 4a).
 *
 * Exists so the editor can say *which* heading is stopping a numbered item
 * from running without re-deriving the grammar — the class of duplication
 * this contract exists to prevent. Scans upward for the heading that opened
 * the region the line sits in.
 */
export function inertRegionHeading(
  text: string,
  line: number,
): { line: number; name: string } | null {
  const classified = classifyLines(text);
  if (classified[line - 1]?.kind !== 'inert-step') return null;
  const lines = text.split(/\r?\n/);
  for (let i = line - 2; i >= 0; i--) {
    const kind = classified[i]?.kind;
    // A real section heading ends the region, so nothing above it can own
    // this line. In a well-formed document we meet the opener first.
    if (kind === 'section-heading') return null;
    if (kind !== 'heading') continue;
    const m = /^(#{4,})\s+(\S.*)$/.exec(lines[i] ?? '');
    if (m) return { line: i + 1, name: m[2]!.trim() };
  }
  return null;
}
