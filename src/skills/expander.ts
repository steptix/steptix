import path from 'node:path';
import { parseSkillFile } from '../parser/markdown.js';
import { interpolate } from '../parser/parameters.js';
import type { ParsedSection, ParsedSkill } from '../parser/types.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { matchInput, matchText, NO_HOOKS_MARKER } from '../parser/section-match.js';
import { logger } from '../utils/logger.js';
import { parseSkillCall as parseSkillCallSyntax } from './skill-call-parser.js';
import { parseSetStep, substitutePreservingSet } from '../parser/set-step.js';
import {
  chainAfterFlowControlMessage,
  chainMemberWord,
  closedChainMemberMessage,
  danglingChainMemberMessage,
  isControlLineClaim,
  parseControlLine,
} from '../parser/control-line.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import type { ControlRecord } from '../runner/control-flow.js';

// Re-exported so a consumer of the expansion has one import for the whole
// shape. The definition lives with the planner that reads it — the expander
// only produces records, and a type-only import keeps this module free of any
// runtime dependency on the runner.
export type { ControlRecord };

/**
 * Parse-time expansion of `[skill: name arg="value" out.x="alias"]` step
 * references. Skills are inlined recursively into a flat list of steps so
 * the runner sees no skill machinery.
 */

const STORE_AS_RE = /\[store\s+as:\s*(\w+)\]/g;
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * Every variable name a step's text references — `{{X}}` reads and
 * `[store as: X]` writes, in source order and deduped per bucket.
 *
 * The skill scoper uses this to decide which names need namespacing; step
 * code-behind uses it to decide which parameters go into the generation
 * prompt (and therefore which values the secret-literal guard looks for).
 * One copy, so the two can't drift over what counts as a reference.
 */
export function referencedVariableNames(
  text: string,
): { placeholders: string[]; captures: string[] } {
  const placeholders: string[] = [];
  const captures: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m[1] && !placeholders.includes(m[1])) placeholders.push(m[1]);
  }
  for (const m of text.matchAll(STORE_AS_RE)) {
    if (m[1] && !captures.includes(m[1])) captures.push(m[1]);
  }
  return { placeholders, captures };
}

/**
 * `interpolateQuiet` for a looped section's body, with the two ways a row
 * value can silently break a `Set` step refused instead
 * (stories/variable-assignment.md).
 *
 * The parse-time guard in `markdown.ts` cannot catch either, because both
 * depend on facts only expansion knows: it checks the step's OWN section's
 * columns, and the bindings here are the merged ones — an enclosing looped
 * section's row values are inherited into a nested body.
 *
 * Both failures found by review, and both were worse than "degrades to
 * prose". A baked-over target stops being a Set step, so the assignment
 * silently never happens AND the following step reads the row value that was
 * baked in — passing green on the wrong data. A row value containing a `"`
 * makes the line unparseable under the value grammar, so that row's
 * assignment is skipped while the variable still holds the PREVIOUS row's
 * value, and the row proceeds on stale data.
 */
function checkedRowInterpolate(
  step: string,
  bindings: Record<string, string>,
  sectionName: string,
): string {
  // `For each {{x}} in {{list}}` binds `x` per pass and reads `list` once, so
  // a row value written over EITHER destroys the loop the same way it
  // destroys a `Set` target. Over the item the line becomes
  // `For each demo@x in {{list}}`, which claims the form and does not
  // complete; over the list it becomes `For each {{x}} in Savings, Everyday`,
  // which does not claim it at all. Both stop being control lines and run as
  // one prose step. The parse-time guard in `markdown.ts` catches a column of
  // the step's OWN section; this one catches the merged bindings an ENCLOSING
  // looped section contributes, which only expansion knows about.
  //
  // A skill parameter as the list is untouched by this: an argument like
  // `list="{{accounts}}"` leaves a placeholder, so the loop still reads a
  // variable at run time.
  const control = parseControlLine(step);
  if (control?.kind === 'foreach') {
    const bakedOver =
      `it is a column of a table this section — or one enclosing it — loops ` +
      `over, and a looped section's row values are written into its step text ` +
      `rather than kept as variables.`;
    if (Object.hasOwn(bindings, control.item)) {
      throw new Error(
        `Cannot loop over {{${control.item}}} in the body of section ` +
          `"${sectionName}": ${bakedOver} The \`For each\` line would stop ` +
          `being one. Loop over a different name.`,
      );
    }
    if (Object.hasOwn(bindings, control.list)) {
      throw new Error(
        `Cannot loop over the items of {{${control.list}}} in the body of ` +
          `section "${sectionName}": ${bakedOver} \`{{${control.list}}}\` ` +
          `would be replaced by this row's value before the line was read, so ` +
          `it would stop being a \`For each\` at all. Capture the list into a ` +
          `differently-named variable and loop over that.`,
      );
    }
  }

  const before = parseSetStep(step);
  if (!before) return interpolateQuiet(step, bindings);

  if (Object.hasOwn(bindings, before.name)) {
    throw new Error(
      `Cannot assign to {{${before.name}}} in the body of section ` +
        `"${sectionName}": it is a column of a table this section — or one ` +
        `enclosing it — loops over, and a looped section's row values are ` +
        `written into its step text rather than kept as variables. The ` +
        `assignment would silently not happen, and a later step reading ` +
        `{{${before.name}}} would see the row value instead. Assign to a ` +
        `different name.`,
    );
  }

  return substitutePreservingSet(
    step,
    (text) => interpolateQuiet(text, bindings),
    (target) =>
      `A row value used by "Set {{${target}}} to …" in the body of section ` +
      `"${sectionName}" makes the step unparseable once it is substituted — ` +
      `almost always because the value contains a double quote, which the ` +
      `assigned value may not. Left to run, that row's assignment would be ` +
      `skipped while {{${target}}} still held the previous row's value.`,
  );
}

const MAX_DEPTH = 10;

/**
 * The body-step indices a `runSteps` narrowing keeps, or null for "all of
 * them".
 *
 * Null rather than `[0..n-1]` on purpose: the caller uses it to decide whether
 * to filter *anything*, and an unnarrowed body must go through the same code
 * it always did — no re-derived arrays, no offsets on its origins.
 *
 * Sanitised here as well as at the wire, because `expandSkills` is also called
 * in-process (the CLI, the tests) where nothing validated the list. An empty
 * result is "all of them", the same reading every other unselected axis gets:
 * a narrowing that names nothing has narrowed nothing.
 */
function keptBodySteps(
  runSteps: number[] | undefined,
  bodyLength: number,
): number[] | null {
  if (runSteps === undefined) return null;
  const kept = [...new Set(runSteps)]
    .filter((n) => Number.isInteger(n) && n >= 0 && n < bodyLength)
    .sort((a, b) => a - b);
  if (kept.length === 0 || kept.length === bodyLength) return null;
  return kept;
}

/**
 * How many same-text steps a narrowing dropped ahead of ONE kept body item —
 * counted separately for each thing that item emits into its own frame.
 *
 * One authored body line is not one emitted step. A control line expands to
 * TWO in the same frame (its guard row, then the step it names after `then`),
 * and those two carry different texts, so they hold different slots and need
 * different offsets. A body item that is a section or skill CALL emits nothing
 * here at all — its steps land in a frame of their own, which counts from
 * zero — so it contributes to nothing.
 *
 * A LIST rather than a `{ self, tail }` pair, because two is not the ceiling:
 * a control line whose tail is itself a control line (`If a is shown, then
 * While b is shown, Click Next`) emits three, and nothing on the TestBench
 * path refuses that shape — the parser's nested-tail refusal lives in
 * src/parser/markdown.ts (the CLI), and runner-core's `parseControlLine`
 * deliberately does not mirror it. A pair silently gave the innermost step
 * offset 0.
 *
 * Index 0 is the item as one step — a plain step, or a control line's guard
 * row — and the rest belong to whatever its tail emits, consumed one level
 * per recursion. Emission order, which is the order the frame's occurrence
 * counter sees them in.
 */
type DroppedAhead = number[];

/**
 * The authored texts one body item contributes to ITS OWN frame's occurrence
 * counts, in emission order.
 *
 * The mirror of the branch order in `expandRecursive`'s loop, and it has to
 * stay one: this is what a dropped item would have added to the counts a kept
 * one is measured against, and a disagreement puts a kept step on another
 * step's code-behind entry — silently, because both entries exist and both
 * run.
 *
 *  - a section call or a `[skill: …]` → `[]` (a new frame, counting afresh);
 *  - a control line → its guard's text, then whatever its tail contributes,
 *    which is that same question one level down;
 *  - anything else → itself.
 */
function bodyFrameTexts(
  ctx: ExpandContext,
  steps: string[],
  rawSteps: string[] | undefined,
  i: number,
  depth = 0,
): string[] {
  const step = steps[i] ?? '';
  const matchSide = matchInput({ steps, rawSteps }, i);
  const control = ctx.controlFlow ? parseControlLine(matchSide) : null;
  let call: SkillCall | null = null;
  try {
    call = parseSkillCall(step);
  } catch {
    // A malformed `[skill: …]` throws when it is EXPANDED, and a dropped step
    // is never expanded. Counting must not be the thing that raises it, so
    // read the line as the plain step it will never get to become — the count
    // is the only thing at stake, and the run's own error is unchanged.
    call = null;
  }
  // Resolution order, verbatim from the loop: a bracket directive is claimed
  // first unless the line is a control line; only then can a bare name be a
  // section call.
  if (call && !control) return [];
  if (resolveSection({ ...ctx, rawSteps }, steps, i)) return [];
  if (!control) return [matchSide];
  // A tail that is itself a control line recurses — that shape reaches the
  // expander on the wire path (only the CLI parser refuses it), and each
  // level adds one more emission to this frame. The cap is what stops a
  // pathological nest from overflowing the stack.
  if (depth >= MAX_DEPTH) return [matchSide];
  const tailText = parseControlLine(step)?.tail ?? control.tail;
  return [matchSide, ...bodyFrameTexts(ctx, [tailText], [control.tail], 0, depth + 1)];
}

/**
 * `DroppedAhead` per KEPT body item, in kept order — the array that rides the
 * recursion as `occurrenceOffsets`.
 *
 * Counted over what each dropped item EXPANDS to rather than over the authored
 * lines, which is the whole difference: a body of `If a banner is shown, then
 * Click Next` followed by `Click Next` emits `Click Next` twice, so keeping
 * only the second one has to bind the second entry.
 */
function droppedAheadOf(
  ctx: ExpandContext,
  bodySteps: string[],
  rawSteps: string[] | undefined,
  keep: number[],
): DroppedAhead[] {
  const kept = new Set(keep);
  const droppedSoFar = new Map<string, number>();
  const at = (text: string | undefined): number =>
    text === undefined ? 0 : (droppedSoFar.get(text) ?? 0);
  const out: DroppedAhead[] = [];
  for (let k = 0; k < bodySteps.length; k++) {
    const texts = bodyFrameTexts(ctx, bodySteps, rawSteps, k).map((t) => t.trim());
    if (kept.has(k)) {
      // One offset per emission, in emission order — a kept item adds nothing
      // to the counts itself, so each is read against the same tally.
      out.push(texts.map((text) => at(text)));
      continue;
    }
    for (const text of texts) droppedSoFar.set(text, (droppedSoFar.get(text) ?? 0) + 1);
  }
  return out;
}

/**
 * `interpolate`, minus the warning on an unresolved placeholder.
 *
 * A looped section's body is interpolated with its row, and a body may
 * legitimately reference a caller variable that only exists at run time —
 * `interpolate` would log "Unresolved placeholder" for every such reference,
 * once per iteration. Those are resolved later, by the runner, against the
 * live parameter map.
 */
function interpolateQuiet(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (match, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? match) : match,
  );
}

/**
 * Section definitions the expander can resolve bare-name calls against,
 * keyed by `matchText(name)`.
 *
 * Deliberately structural rather than `Record<string, ParsedSection>`:
 * `rawSteps` is **optional** here because the server's wire shape carries no
 * such parallel (its steps already arrive raw). Both producers — the parser's
 * `ParsedSection` and the wire entry — are assignable to this. Resolution
 * uses `matchInput()`, which falls back to `steps[i]`, so an absent
 * `rawSteps` is normal rather than degraded. See the contract §3.4.
 */
export type SectionDefs = Record<
  string,
  {
    name: string;
    headingLine: number;
    steps: string[];
    stepLines: number[];
    rawSteps?: string[] | undefined;
    /** Rows from a table under the `### Name` heading: each call of the
     *  section runs its body once per row (part B). Optional for the same
     *  reason `rawSteps` is — a wire entry may omit it. */
    rows?: Array<Record<string, string>> | undefined;
    /**
     * Where each shipped row sits in the AUTHORED table, 1-based, parallel to
     * `rows` (stories/data-row-progress-and-selection.md, decision 1). Sent
     * only by a client that shipped a SUBSET of the table's rows; the CLI
     * parser never sets it, because it always ships all of them.
     *
     * Present together with `rowCount` or not at all — the server refuses one
     * without the other at the wire, so the two are read here as a pair.
     * Without them an iteration is numbered by its position in `rows`, which
     * is the same answer whenever the whole table was shipped.
     */
    rowNumbers?: number[] | undefined;
    /** The authored table's total row count — the `of M` half of the pair
     *  above, so a one-row run still reads `iteration 2 of 3`. */
    rowCount?: number | undefined;
    /**
     * 0-based indices into `steps`: run only these body steps, per iteration
     * (stories/data-row-progress-and-selection.md, decision 3 — "the selection
     * narrows every axis"). Sent only by a client whose author selected some
     * of the body; the CLI parser never sets it.
     *
     * Every kept step keeps the identity a full run would have given it — its
     * `stepLines` entry, and its code-behind occurrence among body steps with
     * the same authored text — so a narrowed run binds to the same entries and
     * reports the same lines as the run it is a subset of.
     */
    runSteps?: number[] | undefined;
  }
>;

interface SkillCall {
  name: string;
  args: Record<string, string>;
  outputAliases: Record<string, string>;
}

/**
 * Identity record for a single frame in the step-into call stack. One per
 * `[skill: ...]` invocation instance (nested skills get distinct frames).
 *
 *  - `id` — unique within a single `expandSkills` call. Stable; referenced
 *    by `ExpandedStepOrigin.frameId` and `parentFrameId`.
 *  - `parentId` — the frame the skill was invoked *from*. `null` for the
 *    test frame (the root of every stack).
 *  - `uri` — absolute file path of the file containing this frame's steps.
 *    The test frame's file is the calling test; a skill frame's file is the
 *    skill `.md`.
 *  - `invocationLine` — 1-based line of the `[skill: ...]` call **in the
 *    parent frame's file**. `null` on the test frame (no parent).
 */
export interface ExpandedFrame {
  id: string;
  parentId: string | null;
  /** `'section'` is an inline `### Name` block. Its `uri` is the file that
   *  DEFINES it (the test file, or the skill file for a skill-internal
   *  section) and `skillName` carries the section name — the enclosing
   *  skill, if any, is on the nearest ancestor frame with kind `'skill'`. */
  kind: 'test' | 'skill' | 'section';
  uri: string;
  invocationLine: number | null;
  skillName?: string;
  /**
   * Resolved input parameter values for this skill invocation, keyed
   * by the parameter name as declared in the skill's `## Parameters`.
   * Captured at expansion time from the caller's `call.args`. The
   * server includes these in the `frame:scope` payload emitted on
   * `frame:push` so the Variables view can show "what was passed in"
   * when execution pauses at a breakpoint inside the skill — even
   * before the first step has run. Absent for the test (root) frame.
   *
   * The expander already INTERPOLATES these values directly into the
   * skill body's step text at expansion time (so the runner never
   * sees `{{query}}`), which is why they don't otherwise show up in
   * `resolvedParameters` for the run. This snapshot is the only way
   * a debugger pause inside the skill can surface them.
   */
  inputs?: Record<string, string>;
  /**
   * 1-based iteration of a looped section, and how many there are
   * (stories/data-driven-rows.md, part B). Absent on every other frame — a
   * section called once, a skill, the test frame.
   *
   * The frame IDENTITY of an iteration. The report derives each body step`s
   * `loop` marker from it, and the Variables and Call Stack views label the
   * frame `Name (2/3)` with it.
   */
  iteration?: number;
  iterationCount?: number;
  /**
   * Effective session-scope names this skill's `## Outputs` write to,
   * i.e. each declared output mapped through the caller's alias
   * (`call.outputAliases[output] ?? output`). The server uses these to
   * tag the resulting variables as `'toolOutput'` provenance — without
   * this hint they reach session scope via a rewritten `[store as: ...]`
   * and would be indistinguishable from a plain page capture. Names that
   * are skill-internal (namespaced `__skillN_*`) never reach session
   * scope, so labelling a stale one is harmless. Absent for the test
   * (root) frame.
   */
  outputs?: string[];
  /**
   * Authored variable name → the effective runtime name for this invocation:
   * the `__skill<N>_` renames plus the caller's output aliases that
   * `applySkillScope` applied to this frame's step *text*.
   *
   * Step code-behind is generated once per skill, not per invocation, so
   * generated code keeps using the authored name and the runtime maps it
   * through this table (stories/step-codebehind.md, "Skill variables"). A
   * declared *parameter* is deliberately absent — the expander interpolates
   * its value straight into the step text, so `inputs` above is where it
   * lives. Absent for section and test frames, which share the caller's scope.
   */
  varScope?: Record<string, string>;
}

/**
 * Origin of a single expanded step. One per entry in `SkillExpansion.steps`.
 *
 *  - `inputIndex` — the index in the input `steps` array this expanded entry
 *    came from. Inline steps map to themselves; every step a skill emitted
 *    maps to the `[skill: ...]` line that invoked the (outermost) skill.
 *  - `frameId` — the frame this step runs inside. `''` for top-level inline
 *    steps (the test frame).
 *  - `skillFilePath` / `skillLine` — the per-step origin inside a skill
 *    body, when the entry came from a skill. Absent for inline entries.
 *  - `occurrenceOffset` — how many emissions a narrowing DROPPED ahead of this
 *    one would have carried the same authored text in the same frame. Added to
 *    the live count in `buildCodeBehindRegistry`, so a step that is the second
 *    `Click Next` of a body binds to the second entry even when the first
 *    `Click Next` was not selected. Counted over emissions rather than authored
 *    lines: a dropped control line contributes its guard AND its tail, and a
 *    dropped call contributes nothing (its steps count in their own frame).
 */
export interface ExpandedStepOrigin {
  inputIndex: number;
  frameId: string;
  skillFilePath?: string;
  skillLine?: number;
  occurrenceOffset?: number;
}

/**
 * Result of skill expansion. `steps` is the flat list of natural-language
 * step strings the runner sees. `sourceSkills` is a parallel array tagging
 * each step with the *outermost* skill the test author invoked from the
 * caller scope — `null` for steps that were authored inline (not via any
 * skill). `origins` is a parallel array carrying file/line/frame metadata
 * for the step-into protocol (server emits `frame:push` between origin
 * transitions); `frames` is a flat lookup of every frame referenced by
 * `origins`. Legacy consumers can ignore both new fields.
 */
export interface SkillExpansion {
  steps: string[];
  sourceSkills: (string | null)[];
  /**
   * Parallel to `steps` — the inline section each step came from, or null.
   *
   * Set to the outermost section frame that sits *outside any skill frame*,
   * i.e. a section of the root file. A step inside a skill's own internal
   * section is tagged with the enclosing test-file section (if any), never
   * with the skill-private section name: the skill badge already names what
   * the author wrote, and skill-internal names are noise in a test report.
   * Both this and `sourceSkills` can be set for the same step.
   */
  sourceSections: (string | null)[];
  /**
   * Parallel to `steps` — each expanded step's **authored** match-side text,
   * i.e. `matchInput` of the list it was emitted from (contract §2.1). Not
   * derivable from `steps` afterwards: by then the text has been through
   * `extractPlainText`, `applySkillScope` and caller interpolation.
   *
   * This is what step code-behind binds entries against, and what the
   * generation prompt is shown — so an entry written for a skill body matches
   * every invocation of it (stories/step-codebehind.md, "Binding").
   */
  rawSteps: string[];
  origins: ExpandedStepOrigin[];
  frames: Record<string, ExpandedFrame>;
  /**
   * Parallel to `steps` — non-null on a control-flow GUARD (an `If … then`,
   * an `Else if`, an `Otherwise`, a `While`, a `Repeat … until`, a
   * `For each`), giving the index range of its body and, for a chain member,
   * the end of its chain (stories/control-flow.md §Design).
   *
   * Indices are ABSOLUTE in this flat list. Nesting is by containment; a
   * chain's members share a `chainId`. The runtime never grows or shrinks the
   * list — it skips ranges and jumps back — so every consumer that indexes
   * `steps` is untouched by the feature (decision 7).
   *
   * All-null for a list with no control lines, which is every list written
   * before the feature, and for the four hook scopes, which opt out (see
   * `opts.expandControlLines`).
   */
  controls: (ControlRecord | null)[];
}

/**
 * Expand all `[skill: ...]` invocations in `steps` recursively, returning a
 * flat list of fully-resolved natural-language step strings plus a parallel
 * array attributing each step to the outermost skill it came from (or null
 * for inline steps).
 *
 * @param steps  Step list from a test (or another skill).
 * @param skillsDir  Root directory of the project's `*.md` skill files. Skills
 *   may sit in subfolders, referenced path-qualified (`[skill: auth/login]`
 *   resolves `<skillsDir>/auth/login.md`; a leading slash is accepted sugar
 *   for the same file).
 */
export async function expandSkills(
  steps: string[],
  /** Directory containing `*.md` skill files. Optional: a project may define
   *  inline sections and no skills at all. A `[skill: ...]` call encountered
   *  without one throws a clean error naming the missing config. */
  skillsDir: string | undefined,
  envCtx?: EnvDataContext,
  callerFilePath?: string,
  /** Per-step line numbers parallel to `steps`, pulled from the test
   *  file's parsed steps. Threads into the top-level recursion as
   *  `stepLines` so a `[skill: ...]` invocation in the test file gets
   *  its `invocationLine` recorded (which becomes `frame.line` on the
   *  wire — clients use it to paint pass/fail on the test's
   *  `[skill: ...]` row). Optional: legacy callers and tests that don't
   *  care about line attribution can omit it. */
  sourceLines?: number[],
  /** Inline-sections support. Trailing and optional so every existing
   *  positional call site compiles unchanged. */
  opts?: {
    /** Sections defined in the file `steps` came from. */
    sections?: SectionDefs | undefined;
    /** Raw (match-side) text parallel to `steps`. See `matchInput`. */
    rawSteps?: string[] | undefined;
    /**
     * Emit a warning for each section defined but never invoked. Defaults to
     * true. The server passes false on its cache-hash expansion, which exists
     * only to produce a hash and would otherwise double every message.
     */
    warnDeadSections?: boolean | undefined;
    /**
     * Where a dead-section warning goes. Defaults to `logger.warn`.
     *
     * The server substitutes a deduping sink. It sees one document as several
     * batches and cannot tell how a run was carved up, so it dedupes on the
     * MESSAGE — which names the file, the section and the line, and therefore
     * changes exactly when the thing being reported changes. Guessing at
     * "is this the first batch of a run" from the request shape was tried
     * twice and was wrong twice: once it lost the warning for every run
     * starting with an `[input:]` step, and once it kept a key that could not
     * see skill-file edits, so a section a skill edit had just killed went
     * unreported.
     */
    onDeadSection?: ((message: string) => void) | undefined;
    /**
     * The step list to scan for call sites, when it differs from `steps`.
     *
     * Liveness is a property of the DOCUMENT (contract §2.4), but `steps` may
     * be a slice of it — the server sends one batch per breakpoint segment. A
     * section invoked only by a step outside the slice looks uninvoked from
     * inside it, so without this the warning cries wolf on exactly the runs a
     * user is already debugging. The server passes `fullSteps`.
     *
     * Affects the dead-section scan only; expansion still operates on `steps`.
     */
    livenessSteps?: string[] | undefined;
    /**
     * Recognise the six control-flow forms and expand their tails in place.
     * Defaults to true.
     *
     * Passed `false` for the four `## Hooks` scopes, which are the one step
     * list this feature deliberately does not reach — the same carve-out
     * `setStepError` has (a hook entry's malformed claim goes to the model as
     * prose). Without it a hook reading `If the cookie banner appears, then
     * Dismiss cookies` would silently become TWO hook steps: a guard nobody
     * evaluates, handed to the model as prose, and a tail that runs
     * unconditionally.
     */
    expandControlLines?: boolean | undefined;
  },
): Promise<SkillExpansion> {
  const frames: Record<string, ExpandedFrame> = {};
  const sections = opts?.sections ?? {};
  const ctx: ExpandContext = {
    skillsDir,
    seq: { n: 0 },
    chainSeq: { n: 0 },
    frames,
    sections,
    sectionsFilePath: callerFilePath ?? '<inline>',
    warnDeadSections: opts?.warnDeadSections ?? true,
    onDeadSection: opts?.onDeadSection ?? ((message: string) => logger.warn(message)),
    deadScanned: new Set(),
    controlNamedWarned: new Set(),
    insideSkill: false,
    controlFlow: opts?.expandControlLines ?? true,
    ...(envCtx && { envCtx }),
    ...(callerFilePath && { callerFilePath }),
    ...(opts?.rawSteps && { rawSteps: opts.rawSteps }),
  };

  reportDeadSections(ctx, ctx.sectionsFilePath, sections, {
    steps: opts?.livenessSteps ?? steps,
    // `rawSteps` is parallel to `steps`, so it applies only when the liveness
    // scan is over `steps` itself. No caller passes both today — the CLI
    // passes `rawSteps`, the server passes `livenessSteps` and never
    // `rawSteps` (the wire shape deliberately has none, contract §3.2) — but
    // pairing them explicitly means a future caller that does pass both
    // cannot silently zip mismatched arrays.
    ...(opts?.livenessSteps ? {} : opts?.rawSteps ? { rawSteps: opts.rawSteps } : {}),
  });

  const result = await expandRecursive(
    steps,
    ctx,
    new Set(),
    0,
    null,
    null,
    '',
    null,
    sourceLines ?? null,
  );
  return { ...result, frames };
}

/**
 * Warn once per file about sections that are defined but never invoked.
 *
 * "Invoked" is a flat textual scan: any step anywhere in the same file — main
 * flow or *any* section body, including a body that is itself never invoked —
 * whose match text equals the name counts as a call site. Hook entries never
 * count (they are expanded with no sections map at all).
 *
 * This is the author's rename-drift tripwire. Renaming a section without
 * updating its call site is not an error — the orphaned call quietly degrades
 * into an ordinary AI instruction — so this warning is what surfaces it.
 *
 * Lives in the expander rather than in skill parsing because the server clears
 * the skill cache at the top of every batch, which would re-fire a parse-time
 * warning once per batch. Deduped per `expandSkills` call via `ctx.deadScanned`.
 */
function reportDeadSections(
  ctx: ExpandContext,
  filePath: string,
  sections: SectionDefs,
  mainList: { steps: string[]; rawSteps?: string[] | undefined },
): void {
  if (!ctx.warnDeadSections) return;
  if (Object.keys(sections).length === 0) return;
  if (ctx.deadScanned.has(filePath)) return;
  ctx.deadScanned.add(filePath);

  const invoked = new Set<string>();
  const collect = (list: { steps: string[]; rawSteps?: string[] | undefined }): void => {
    for (let i = 0; i < list.steps.length; i++) {
      const text = matchInput(list, i);
      invoked.add(matchText(text));
      // A section named as the TAIL of a control line is invoked — the one
      // clause stories/control-flow.md adds to contract §2.4. Without it,
      // `If the Cash checkbox is ticked, then Pay with cash` would report
      // `### Pay with cash` dead while running it every time the condition
      // held. runner-core's `buildSectionIndex` learns the same clause, so
      // the warning and the editor's "never used" diagnostic still agree.
      const control = parseControlLine(text);
      if (control) invoked.add(matchText(control.tail));
    }
  };
  collect(mainList);
  for (const section of Object.values(sections)) collect(section);

  for (const [key, section] of Object.entries(sections)) {
    if (!invoked.has(key)) {
      ctx.onDeadSection(
        `Section "${section.name}" in ${filePath} is defined but never ` +
          `invoked (line ${section.headingLine}). If a step was meant to call ` +
          `it, the names no longer match — a call site that doesn't resolve ` +
          `runs as an ordinary instruction instead.`,
      );
    }
  }
}

interface ExpandContext {
  skillsDir: string | undefined;
  /**
   * Row values bound by every enclosing looped section, innermost winning.
   * Interpolated into a body`s step text as it is inlined, so the runner never
   * sees `{{column}}` and a nested loop can still read the outer row.
   */
  rowBindings?: Record<string, string>;
  /** Sections visible to the step list currently being expanded. Swapped for
   *  the skill's own (scoped) map when recursing into a skill; kept as-is
   *  when recursing into a section body, so a section can call its siblings. */
  sections: SectionDefs;
  /** Absolute path of the file `sections` came from. Namespaces section cycle
   *  keys so two files' same-named sections never collide in `visited`. */
  sectionsFilePath: string;
  /** Match-side text parallel to the step list currently being expanded. */
  rawSteps?: string[] | undefined;
  /** See the `opts.warnDeadSections` docstring on `expandSkills`. */
  warnDeadSections: boolean;
  /** See the `opts.onDeadSection` docstring on `expandSkills`. */
  onDeadSection: (message: string) => void;
  /** Files already scanned for dead sections in this `expandSkills` call. */
  deadScanned: Set<string>;
  /** Sections already warned about for being named like a control line, in
   *  this `expandSkills` call. Keyed the way cycles are — file plus name. */
  controlNamedWarned: Set<string>;
  /** True once the recursion is inside any skill frame. Gates the
   *  `sourceSections` rule: a skill's internal sections never become the tag. */
  insideSkill: boolean;
  /**
   * Monotonic counter producing unique frame ids and unique prefixes for
   * internal capture names.
   *
   * Boxed deliberately. `expandRecursive` hands nested calls a spread copy of
   * this context (`{ ...ctx, currentSkillFilePath }`), which copies primitives
   * by value — so a bare `number` here meant a nested body's increments never
   * reached the parent, and the next sibling invocation at the outer level
   * re-minted an id the nested frame had already taken. That silently
   * overwrote the nested frame in the shared `frames` map (mis-attributing its
   * steps to the sibling skill) and, worse, gave two unrelated skill instances
   * the same `__skill<N>_` namespace, so one instance's captures clobbered the
   * other's. The box makes every level share one counter, like `frames` below.
   */
  seq: { n: number };
  /**
   * Monotonic counter producing unique `chainId`s. Boxed for the same reason
   * `seq` is, and SEPARATE from it because `seq` also mints frame ids and
   * `__skill<N>_` namespaces: sharing it would renumber every frame in every
   * file that gained a chain, for no gain here.
   */
  chainSeq: { n: number };
  /** False for the four hook scopes. See `opts.expandControlLines`. */
  controlFlow: boolean;
  /** Shared `frames` lookup populated as the recursion enters each skill
   *  body. The top-level call seeds this in `expandSkills` so every nested
   *  recursion writes to the same map. */
  frames: Record<string, ExpandedFrame>;
  /** When set, threaded into `parseSkillFile` so the skill's own
   *  `dataSources` resolve via the same env context the caller is using. */
  envCtx?: EnvDataContext;
  /** Absolute path of the test (or other top-level file) that invoked this
   *  expansion. Used to wrap `parseSkillFile` errors with both endpoints —
   *  the skill where the failure landed and the test that triggered it. */
  callerFilePath?: string;
  /** Absolute path of the skill `.md` whose body we're currently emitting
   *  steps from. Set when recursing into a skill; absent at the top level
   *  (where the caller is the test file). Used by origin recording. */
  currentSkillFilePath?: string;
  /** Name of the skill we're currently inside, for symmetry with the above —
   *  retained as part of the recursion context for diagnostics. */
  currentSkillName?: string;
}

async function expandRecursive(
  steps: string[],
  ctx: ExpandContext,
  visited: Set<string>,
  depth: number,
  /** When non-null, every emitted step is tagged with this skill name —
   *  the outermost skill the caller invoked. `null` at the top level
   *  (inline steps from the test file). */
  sourceSkill: string | null,
  /** When non-null, every emitted step is tagged with this section name —
   *  the outermost section frame outside any skill. `null` at the top level
   *  and for everything inside a skill's own internal sections. */
  sourceSection: string | null,
  /** Frame id of the calling scope. `''` at the top level (test frame). */
  parentFrameId: string,
  /** Lookup `inputIndex` to attribute every step we emit to a caller-scope
   *  input. Non-null only while recursing inside a skill body; at the top
   *  level we use the current step's own index. */
  attribInputIndex: number | null,
  /** Per-step line numbers parallel to `steps`. Top-level callers pass the
   *  test file's pre-expansion `stepLines`; recursive callers pass the
   *  skill's `stepLines`. */
  stepLines: number[] | null,
  /**
   * Parallel to `steps`: how many same-text steps a narrowing dropped ahead of
   * each one, per thing that step emits into this frame. Non-null only for a
   * section body a `runSteps` narrowed — it is what keeps a kept step's
   * code-behind occurrence equal to the occurrence it would have had in a full
   * run.
   */
  occurrenceOffsets: DroppedAhead[] | null = null,
): Promise<Omit<SkillExpansion, 'frames'>> {
  if (depth > MAX_DEPTH) {
    throw new Error(`Skill expansion exceeded max depth of ${MAX_DEPTH} (possible recursion)`);
  }

  const out: string[] = [];
  const sources: (string | null)[] = [];
  const sourceSecs: (string | null)[] = [];
  const raws: string[] = [];
  const origins: ExpandedStepOrigin[] = [];
  const controls: (ControlRecord | null)[] = [];

  /**
   * Chains being built in THIS step list, by `chainId`, with the output index
   * of each member's guard.
   *
   * A chain is "consecutive step lines of the same flow" (§"A chain is a
   * decision"), and one `expandRecursive` call IS one flow — the main list, a
   * section body, a skill body — so `openChain` only has to survive from one
   * iteration of the loop below to the next. `chainEnd` is back-filled once
   * the list is finished, because it is the LAST member's `bodyEnd` and no
   * member knows that when it is emitted.
   */
  const chains = new Map<string, number[]>();
  let openChain: string | null = null;
  /** Whether the chain the previous step line belonged to has already had its
   *  `Otherwise`. Read and cleared exactly as `openChain` is. */
  let chainClosed = false;
  /** The previous step line when it was a FLOW-CONTROL step — the one kind of
   *  `If` that is not a decision. Read and cleared exactly as `openChain` is,
   *  and set from the ONE place a flow-control step can be recognised on this
   *  path: rung 0 declines it as a control line, so it falls through to the
   *  ordinary-step branch (stories/control-flow.md §"Composition with
   *  `If … then return`"). */
  let openFlowControl: string | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    // A chain runs across CONSECUTIVE step lines, so the previous line's
    // membership is read here and cleared: every branch below that is not a
    // chain member leaves it null, and only the control branch sets it again.
    const previousChain: string | null = openChain;
    const previousClosed = chainClosed;
    const previousFlowControl = openFlowControl;
    openChain = null;
    chainClosed = false;
    openFlowControl = null;
    const call = parseSkillCall(step);
    const matchSide = matchInput({ steps, rawSteps: ctx.rawSteps }, i);
    const control = ctx.controlFlow ? parseControlLine(matchSide) : null;
    // Remembered for the NEXT line, which is the only one that can be wrong
    // about it. `parseControlLine` has already declined this line at rung 0,
    // so the two are mutually exclusive by construction.
    if (ctx.controlFlow && parseFlowControlStep(matchSide)) openFlowControl = matchSide;
    // A hook scope is the one step list control flow does not reach
    // (`opts.expandControlLines`), and until now it said so to nobody: the
    // line simply became prose, so an author who wrote a decision in
    // `## Before Each` watched the model perform some approximation of it.
    // One warning per entry that reaches for a form, naming the entry.
    if (!ctx.controlFlow && isControlLineClaim(matchSide)) {
      logger.warn(
        `Hook step "${matchSide}" reads as a control line, but hooks do not ` +
          `dispatch control lines — it runs as one prose instruction. Put the ` +
          `decision in a numbered step under \`## Steps\`, or in a \`### Section\` ` +
          `the hook calls.`,
      );
    }

    // Resolution order: a bracket token is claimed first and is never a
    // section call, however its text compares. Only plain-text steps reach
    // the bare-name test below.
    //
    // `|| control` is the one exception, and it is about LABELS rather than
    // about control flow. `parseInvocation` accepts any text before the token
    // as a call's label, so `If {{plan}} is "pro", then [skill: enable_pro]`
    // parses as a labelled skill call — and read that way the skill would run
    // UNCONDITIONALLY with the decision as its label, which is the exact line
    // the story uses as its worked example of a conditional skill. Decision 3
    // says a step that OPENS with a bracket directive is a directive; this
    // one does not, so the control form wins. A step that really does open
    // with `[skill:` can never parse as a control line, so that rung is
    // untouched.
    if (!call || control) {
      const section = resolveSection(ctx, steps, i);
      if (section) {
        const cycleKey = sectionCycleKey(ctx.sectionsFilePath, section.name);
        if (visited.has(cycleKey)) {
          throw new Error(
            `Section cycle detected: ${[...visited]
              .map(describeCycleKey)
              .concat(section.name)
              .join(' -> ')}`,
          );
        }
        if (section.steps.length === 0) {
          throw new Error(
            `Section "${section.name}" in ${ctx.sectionsFilePath} is invoked ` +
              `at line ${stepLines?.[i] ?? '?'} but has no steps.`,
          );
        }
        warnControlNamedSection(ctx, section.name);

        // A table under the section's heading makes each call run the body
        // once per row (stories/data-driven-rows.md, part B). Without one this
        // is a single iteration with no bindings — exactly what a section call
        // has always been.
        const iterations = section.rows ?? [null];

        // A client may ship only SOME of the table's rows
        // (stories/data-row-progress-and-selection.md, "Selecting rows of a
        // section"). When it does it says which ones, and the iteration is
        // numbered by its position in the AUTHORED table rather than by its
        // position in what arrived — so a narrowed run's badge still reads
        // `(2/3)` and names the row the reader selected. Absent, the two are
        // the same answer: everything was shipped, in order.
        const rowNumbers = section.rowNumbers;
        const rowCount = section.rowCount;

        for (const [iteration, row] of iterations.entries()) {
          const instanceId = ++ctx.seq.n;
          const newFrameId = `f${instanceId}`;
          ctx.frames[newFrameId] = {
            id: newFrameId,
            parentId: parentFrameId === '' ? null : parentFrameId,
            kind: 'section',
            // The file that DEFINES the section: the test file for a test-file
            // section, the skill file for a skill-internal one.
            uri: ctx.sectionsFilePath,
            invocationLine: stepLines?.[i] ?? null,
            // Field reused for the section name; the enclosing skill (if any)
            // is on the nearest ancestor frame with kind 'skill'.
            skillName: section.name,
            ...(row && {
              // The row as this iteration's inputs, the way a skill call's
              // args are. The server surfaces them in `frame:scope`, so the
              // Variables view shows the iteration's values at a pause with no
              // new wire shape.
              inputs: { ...row },
              iteration: rowNumbers?.[iteration] ?? iteration + 1,
              iterationCount: rowCount ?? iterations.length,
            }),
          };

          // An inner looped body sees its enclosing rows too, innermost
          // winning: a section shares the caller's scope, and a nested loop
          // that could not read the outer row would contradict that. An
          // iteration with no row of its own inherits the caller's, which is
          // what lets an unlooped inner section read the outer table.
          const rowBindings = row
            ? { ...(ctx.rowBindings ?? {}), ...row }
            : ctx.rowBindings;
          // Strip a leading `[no-hooks]` from each body step as it is inlined.
          // The CLI parser already stripped these, but the wire shape carries
          // markers verbatim (the client can't strip them — they are part of
          // the match side), so without this the literal marker text would
          // reach the AI on the server path only. A marker on a body step is
          // stripped and ignored either way: it is the *invocation's* marker
          // that opts the whole body out, via origin mapping.
          let bodySteps = section.steps.map((s) => s.replace(NO_HOOKS_MARKER, ''));
          if (rowBindings) {
            // Interpolated BEFORE the recursion, so a `[skill: x arg="{{col}}"]`
            // line inside the body reaches the skill-call parser with the value
            // already in place — the same order `applySkillScope` uses for a
            // skill's own args. `interpolateQuiet` leaves an unknown
            // placeholder alone without warning: a body may legitimately
            // reference a caller variable that only exists at run time.
            bodySteps = bodySteps.map((s) =>
              checkedRowInterpolate(s, rowBindings, section.name),
            );
          }

          // The BODY-STEP narrowing, the sibling axis of the row one: a
          // selection may name some of a section's body steps as well as some
          // of its rows, and neither narrowing knows about the other
          // (stories/data-row-progress-and-selection.md, decision 3). Absent —
          // the CLI, and every client that predates it — means the whole body.
          //
          // Filtered here rather than by the caller so `stepLines`, `rawSteps`
          // and the steps themselves can only ever be filtered together: they
          // are parallel arrays, and a skew between them is a body step
          // attributed to another one's line.
          const keep = keptBodySteps(section.runSteps, section.steps.length);
          let bodyLines = section.stepLines;
          let bodyRaws = section.rawSteps;
          let occurrenceOffsets: DroppedAhead[] | null = null;
          if (keep) {
            // What each kept body step BINDS as — the loader's occurrence key
            // is (frame, section, this text), so dropping an earlier step that
            // emits the same text would slide every later one down a slot. A
            // body that says `Click Next` three times and runs only the third
            // must still bind the third entry, so each kept step carries how
            // many same-text emissions ahead of it were dropped. Counted over
            // what each item EXPANDS to, because one authored line is not one
            // step: a control line emits its guard AND its tail here, and a
            // call emits nothing here at all.
            occurrenceOffsets = droppedAheadOf(ctx, bodySteps, section.rawSteps, keep);
            bodyLines = keep.map((k) => section.stepLines[k] ?? 0);
            // The same fallback `matchInput` makes: a hole in `rawSteps` means
            // the step text IS the match side, and freezing `''` into the
            // filtered copy would make a narrowed run match on nothing.
            bodyRaws = section.rawSteps
              ? keep.map((k) => section.rawSteps![k] ?? bodySteps[k] ?? '')
              : undefined;
            bodySteps = keep.map((k) => bodySteps[k]!);
          }

          // A section is a macro: it shares the caller's scope, so there is no
          // scope pass here and `ctx` carries through unchanged. The body may
          // call sibling sections, so the sections map stays put — only the
          // match-side array swaps to this body's own.
          //
          // `rawSteps` stays the AUTHORED text even when a row is interpolated
          // into the body below. The wire carries no `rawSteps` (contract
          // §3.2), so `matchInput` falls back to `steps[i]` on the server —
          // and if that were the interpolated text, the match side and the
          // code-behind binding `source` would differ between the CLI and the
          // server, binding entries on one path and not the other.
          const bodyCtx: ExpandContext = {
            ...ctx,
            ...(bodyRaws ? { rawSteps: bodyRaws } : { rawSteps: undefined }),
            ...(rowBindings && { rowBindings }),
          };

          const recursed = await expandRecursive(
            bodySteps,
            bodyCtx,
            new Set([...visited, cycleKey]),
            depth + 1,
            sourceSkill,
            // Outermost-wins, and only outside a skill: a step in a skill's
            // internal section keeps the enclosing test-file section's tag
            // (or null), never the skill-private name.
            ctx.insideSkill ? sourceSection : (sourceSection ?? section.name),
            newFrameId,
            attribInputIndex ?? i,
            bodyLines,
            occurrenceOffsets,
          );

          const base = out.length;
          out.push(...recursed.steps);
          sources.push(...recursed.sourceSkills);
          sourceSecs.push(...recursed.sourceSections);
          raws.push(...recursed.rawSteps);
          origins.push(...recursed.origins);
          controls.push(...shiftControls(recursed.controls, base));
        }
        continue;
      }

      // Control flow, AFTER the bare-name section match: a step that IS a
      // section name is a call before it is anything else (decision 3), so a
      // section unwisely named `While waiting` still resolves as a call.
      //
      // The DECISION was made above on the match side, the same authored text
      // section resolution reads, so a caller's argument interpolated into a
      // skill body cannot make a line start or stop being a control line. The
      // executable tail comes from `step`, which is the interpolated and
      // scoped text the runner must actually perform.
      if (control) {
        const executable = parseControlLine(step);
        const tailText = executable?.tail ?? control.tail;
        // The EXECUTABLE line, when interpolation left it the same form.
        //
        // The decision of whether this is a control line at all was made above
        // on the match side, so a caller's argument cannot make a line start
        // or stop being one. What is read off the line AFTER that decision is
        // a different question, and the answer differs by field:
        //
        //  - the tail, the condition and the label are things the RUN uses, so
        //    they come from `step` — the interpolated, skill-scoped text. A
        //    looped section bakes its row values into the text, so an authored
        //    condition `{{status}} is shown` is a question no `## Values` entry
        //    can answer and every row would ask it identically;
        //  - the authored text stays on `rawSteps`, which is what section
        //    resolution, code-behind binding and the editor read.
        //
        // Null when interpolation left the line no longer parseable as the
        // same form: then the authored names are the best available, and the
        // parse-time refusals cover the shapes that can actually happen.
        const live = executable && executable.kind === control.kind ? executable : null;
        const conditionText =
          live && 'condition' in live
            ? live.condition
            : 'condition' in control
              ? control.condition
              : undefined;

        const guardIndex = out.length;
        out.push(step);
        sources.push(sourceSkill);
        sourceSecs.push(sourceSection);
        raws.push(matchSide);
        // Same origin an ordinary inline step gets: the guard IS an ordinary
        // step as far as attribution, painting and breakpoints are concerned —
        // its code-behind slot among same-text guards included.
        origins.push({
          inputIndex: attribInputIndex ?? i,
          frameId: parentFrameId,
          ...(ctx.currentSkillFilePath !== undefined && {
            skillFilePath: ctx.currentSkillFilePath,
          }),
          ...(stepLines?.[i] !== undefined && stepLines[i]! > 0 && {
            skillLine: stepLines[i]!,
          }),
          ...((occurrenceOffsets?.[i]?.[0] ?? 0) > 0 && {
            occurrenceOffset: occurrenceOffsets![i]![0]!,
          }),
        });
        controls.push(null); // back-filled below, once the body's extent is known

        // The tail is ONE step, expanded through the same recursion in the
        // ENCLOSING frame — so a section tail becomes a section frame exactly
        // as a bare-name call does, a `[skill:]` tail goes through
        // `expandSkills`, and anything else is emitted as itself. Its match
        // side is the AUTHORED tail, which is what keeps code-behind binding
        // on a tail identical to binding on the same step written on its own.
        const tailCtx: ExpandContext = { ...ctx, rawSteps: [control.tail] };
        const recursed = await expandRecursive(
          [tailText],
          tailCtx,
          visited,
          depth + 1,
          sourceSkill,
          sourceSection,
          parentFrameId,
          attribInputIndex ?? i,
          [stepLines?.[i] ?? 0],
          // The tail is emitted in THIS frame, so a narrowing that dropped a
          // same-text step ahead of it slides it exactly as it slides a plain
          // step — and the text it holds a slot for is the tail's, not the
          // guard's. The guard has consumed index 0; the REST rides down, so a
          // tail that is itself a control line finds its own guard's offset at
          // 0 and passes what is left on again. Any depth, one rule.
          occurrenceOffsets ? [(occurrenceOffsets[i] ?? []).slice(1)] : null,
        );
        if (recursed.steps.length === 0) {
          throw new Error(
            `The step "${step}" in ${ctx.sectionsFilePath} names "${control.tail}" ` +
              `as the step to run, but it expands to nothing. A control line ` +
              `must name one step that actually runs.`,
          );
        }

        const bodyStart = out.length;
        out.push(...recursed.steps);
        sources.push(...recursed.sourceSkills);
        sourceSecs.push(...recursed.sourceSections);
        raws.push(...recursed.rawSteps);
        origins.push(...recursed.origins);
        controls.push(...shiftControls(recursed.controls, bodyStart));
        const bodyEnd = out.length - 1;

        switch (control.kind) {
          case 'if':
          case 'elseif':
          case 'else': {
            // `Else if` / `Otherwise` continue the chain the previous step
            // opened. A dangling one is REFUSED here, in the parser's own
            // wording — this is the wire path's only parser (TestBench never
            // calls `parseTestContent`), and an `Otherwise` that opened a chain
            // of its own would be selected by its own fallback and run its tail
            // unconditionally. Refusing costs a failed run; not refusing runs
            // the branch the author wrote as the alternative to something else.
            // The dangling rule's first case, and the one an author actually
            // writes: the line above IS an `If`, but a flow-control one, which
            // ends the flow rather than choosing a branch. Its own sentence,
            // or "no decision above you" reads as a parser bug to someone
            // looking straight at an `If` (stories/control-flow.md
            // §"Composition with `If … then return`").
            if (control.kind !== 'if' && previousFlowControl !== null) {
              throw new Error(
                chainAfterFlowControlMessage({
                  line: matchSide,
                  word: chainMemberWord(control.kind),
                  previous: previousFlowControl,
                  where: `${ctx.sectionsFilePath}${stepLines?.[i] ? `:${stepLines[i]}` : ''}`,
                }),
              );
            }
            if (control.kind !== 'if' && previousChain === null) {
              throw new Error(
                danglingChainMemberMessage({
                  line: matchSide,
                  word: chainMemberWord(control.kind),
                  flow: sourceSection ? `### ${sourceSection}` : '## Steps',
                  where: `${ctx.sectionsFilePath}${stepLines?.[i] ? `:${stepLines[i]}` : ''}`,
                }),
              );
            }
            // …and the other half of the same rule. `fallbackOf` picks the
            // FIRST condition-less member, so a second `Otherwise` below one
            // is unreachable code that is always skipped and an `Else if`
            // below one is still evaluated — neither of which the author can
            // learn from watching the run. Refused by the CLI parser since
            // stage 1; refused here (and in runner-core) so the three agree.
            if (control.kind !== 'if' && previousClosed) {
              throw new Error(
                closedChainMemberMessage({
                  line: matchSide,
                  where: `${ctx.sectionsFilePath}${stepLines?.[i] ? `:${stepLines[i]}` : ''}`,
                }),
              );
            }
            const chainId: string =
              control.kind !== 'if' ? (previousChain as string) : `ch${++ctx.chainSeq.n}`;
            const members = chains.get(chainId) ?? [];
            members.push(guardIndex);
            chains.set(chainId, members);
            openChain = chainId;
            chainClosed = control.kind === 'else';
            controls[guardIndex] = {
              kind: control.kind,
              chainId,
              ...(control.kind !== 'else' &&
                conditionText !== undefined && { condition: conditionText }),
              bodyStart,
              bodyEnd,
              chainEnd: bodyEnd, // provisional; back-filled for every member
            };
            break;
          }
          case 'foreach':
            controls[guardIndex] = {
              kind: 'foreach',
              // The SCOPED names: an item and a list are looked up in
              // `resolvedParameters` at run time, and inside a skill body that
              // map is keyed by the namespaced `__skillN_` form the expander
              // rewrote the body's own `{{…}}` into.
              item: live?.kind === 'foreach' ? live.item : control.item,
              list: live?.kind === 'foreach' ? live.list : control.list,
              bodyStart,
              bodyEnd,
              label: loopLabel(ctx, control.tail, tailText),
            };
            break;
          default:
            controls[guardIndex] = {
              kind: control.kind,
              condition: conditionText ?? control.condition,
              bodyStart,
              bodyEnd,
              ...(control.cap !== undefined && { cap: control.cap }),
              label: loopLabel(ctx, control.tail, tailText),
            };
            break;
        }
        continue;
      }

      out.push(step);
      sources.push(sourceSkill);
      sourceSecs.push(sourceSection);
      // The authored match side for this emitted step. `matchInput` (never
      // `steps[i]`) for the same reason section resolution uses it: inside a
      // skill body `steps[i]` has already been interpolated and namespaced.
      raws.push(matchInput({ steps, rawSteps: ctx.rawSteps }, i));
      // Inline-emit attribution: at top level the caller is the test
      // (inputIndex = our own index, no skill origin); inside a skill body
      // we record the skill's file + its own per-step line.
      origins.push({
        inputIndex: attribInputIndex ?? i,
        frameId: parentFrameId,
        ...(ctx.currentSkillFilePath !== undefined && {
          skillFilePath: ctx.currentSkillFilePath,
        }),
        ...(stepLines?.[i] !== undefined && stepLines![i]! > 0 && {
          skillLine: stepLines![i]!,
        }),
        // Only ever set inside a narrowed section body, and only when
        // something with the same text was actually dropped ahead of this
        // step — so an ordinary expansion's origins are byte-identical.
        ...((occurrenceOffsets?.[i]?.[0] ?? 0) > 0 && {
          occurrenceOffset: occurrenceOffsets![i]![0]!,
        }),
      });
      controls.push(null);
      continue;
    }

    if (visited.has(call.name)) {
      throw new Error(
        `Skill cycle detected: ${[...visited, call.name].join(' -> ')}`,
      );
    }

    if (ctx.skillsDir === undefined) {
      throw new Error(
        `Step "${step}" invokes a skill, but no skills directory is ` +
          `configured. Set \`tests.skillsDir\` in aiui.config.json (or pass ` +
          `\`skillsDir\`) so \`[skill: ...]\` references can be resolved.`,
      );
    }

    let skill: ParsedSkill;
    try {
      skill = await loadSkill(ctx.skillsDir, call.name, ctx.envCtx);
    } catch (err) {
      // Wrap the underlying error so the message names both endpoints —
      // the skill file where parsing/interpolation failed, AND the calling
      // test (if known) plus the invocation line. Authors get clickable
      // pointers to both files instead of having to grep for who called
      // a failing skill.
      throw wrapSkillLoadError(err, call, step, ctx);
    }
    validateCall(skill, call);

    // The skill's own dead sections are scanned against its AUTHORED text —
    // before `applySkillScope` interpolates anything — so this warning and
    // the editor's "never used" diagnostic can never disagree.
    reportDeadSections(ctx, skill.filePath, skill.sections, skill);

    const instanceId = ++ctx.seq.n;
    const scoped = applySkillScope(skill, call, instanceId);
    const expandedBody = scoped.steps;
    const newFrameId = `f${instanceId}`;

    // Record this frame's identity for the server to look up on transitions.
    // `invocationLine` is the line of the `[skill: ...]` call in the parent
    // file — what the call-stack view shows as "invoked from <uri>:<line>".
    ctx.frames[newFrameId] = {
      id: newFrameId,
      parentId: parentFrameId === '' ? null : parentFrameId,
      kind: 'skill',
      uri: skill.filePath,
      invocationLine: stepLines?.[i] ?? null,
      skillName: call.name,
      // Snapshot the caller-supplied parameter values so a debugger
      // pause at the skill's first step (or any step before the
      // skill captures something into the scope) can show what was
      // passed in. The values are also interpolated directly into
      // the skill body's step text (see `applySkillScope`), but
      // that interpolation isn't reversible from the runtime side.
      inputs: { ...call.args },
      // Effective session-scope names for this skill's declared outputs,
      // each mapped through the caller's alias (or the declared name when
      // unaliased). Lets the server tag these variables as 'toolOutput'.
      outputs: skill.outputs.map((o) => call.outputAliases[o] ?? o),
      // The same renames applied to this invocation's step text, kept as a
      // table so step code-behind can resolve authored variable names at
      // runtime instead of being regenerated per invocation.
      varScope: scoped.varScope,
    };

    // Outermost-skill attribution: keep the first skill we entered as the
    // source for every inner step, so report rows point back to a name the
    // test author actually wrote.
    const innerCtx: ExpandContext = {
      ...ctx,
      currentSkillFilePath: skill.filePath,
      currentSkillName: call.name,
      // Swap in the skill's own sections — scoped for THIS invocation — so a
      // bare-name step in its body resolves against them and not the caller's.
      sections: scoped.sections,
      sectionsFilePath: skill.filePath,
      rawSteps: scoped.rawSteps,
      insideSkill: true,
    };
    const recursed = await expandRecursive(
      expandedBody,
      innerCtx,
      new Set([...visited, call.name]),
      depth + 1,
      sourceSkill ?? call.name,
      // A skill invoked from inside a test-file section keeps that section's
      // tag, so a step can carry both a skill and a section badge.
      sourceSection,
      newFrameId,
      // Inside a skill body, every emitted step is attributed to the
      // [skill: ...] invocation at the current level — that's `i` here.
      attribInputIndex ?? i,
      skill.stepLines,
    );

    const base = out.length;
    out.push(...recursed.steps);
    sources.push(...recursed.sourceSkills);
    sourceSecs.push(...recursed.sourceSections);
    raws.push(...recursed.rawSteps);
    origins.push(...recursed.origins);
    controls.push(...shiftControls(recursed.controls, base));
  }

  // A chain's `chainEnd` is its LAST member's `bodyEnd`, shared by every
  // member so the runtime can jump past the whole decision from whichever one
  // it took. Only knowable now.
  for (const members of chains.values()) {
    const last = members[members.length - 1];
    if (last === undefined) continue;
    const chainEnd = (controls[last] as ControlRecord).bodyEnd;
    for (const member of members) {
      const record = controls[member] as Extract<ControlRecord, { chainId: string }>;
      record.chainEnd = chainEnd;
    }
  }

  return {
    steps: out,
    sourceSkills: sources,
    sourceSections: sourceSecs,
    rawSteps: raws,
    origins,
    controls,
  };
}

/**
 * Re-base a nested expansion's control records onto the parent's flat list.
 *
 * Every index in a `ControlRecord` is absolute, and `expandRecursive` builds
 * its own list from zero — so the one place the two meet is here, at each
 * concatenation site. Missing one would not fail loudly: the records would
 * simply point at the wrong steps, and the runtime would skip somebody else's.
 */
function shiftControls(
  records: readonly (ControlRecord | null)[],
  offset: number,
): (ControlRecord | null)[] {
  if (offset === 0) return [...records];
  return records.map((record) => {
    if (!record) return null;
    const moved = {
      ...record,
      bodyStart: record.bodyStart + offset,
      bodyEnd: record.bodyEnd + offset,
    };
    return 'chainId' in record ? { ...moved, chainEnd: record.chainEnd + offset } : moved;
  });
}

/**
 * A loop band's label: the section's name for a section tail, the tail's own
 * text otherwise (§"Painting, frames and the report").
 *
 * Two tails, because the two halves of that sentence read different text.
 * Resolution happens on the AUTHORED tail — the same map and the same match
 * side `resolveSection` uses, so what the label names and what the run enters
 * cannot disagree. The label itself, when nothing resolves, is the EXECUTABLE
 * tail: inside a looped section every other piece of rendered text shows the
 * row's value, and a band reading `Click {{status}}` beside rows reading
 * `Click Pending` is the label describing a step that never ran.
 */
function loopLabel(ctx: ExpandContext, authoredTail: string, executableTail: string): string {
  const key = matchText(authoredTail);
  if (Object.prototype.hasOwnProperty.call(ctx.sections, key)) {
    return ctx.sections[key]?.name ?? authoredTail;
  }
  return executableTail;
}

/**
 * A section whose NAME parses as a control line, resolved by bare name.
 *
 * `### Else if b, then S2` is a heading, and a step reading exactly that text
 * resolves to it at rung 2 of the order above — deliberately beating the
 * control split, so the step becomes an unconditional call and the condition
 * in the name is never asked. Resolution is left exactly as it is; this is the
 * only thing that says so out loud.
 *
 * The parser warns too (`src/parser/markdown.ts`, `scanStepSpans`), but that
 * scan runs only on `aiui run` and on a server compile: an ordinary
 * `/sessions/:id/steps` run arrives with `steps` and `sections` already parsed
 * by runner-core in the extension, so on the TestBench and MCP paths — the
 * surfaces where sections are actually authored — the parser's warning is
 * never reached (review 4, finding 10). Here it is, at the moment the call
 * resolves, on every path.
 *
 * Deduped per `expandSkills` call, like `reportDeadSections`: a section called
 * from inside a three-pass loop is one thing to tell the author, not three.
 */
function warnControlNamedSection(ctx: ExpandContext, name: string): void {
  if (!parseControlLine(name)) return;
  const key = sectionCycleKey(ctx.sectionsFilePath, name);
  if (ctx.controlNamedWarned.has(key)) return;
  ctx.controlNamedWarned.add(key);
  logger.warn(
    `Section "${name}" in ${ctx.sectionsFilePath} is named like a control ` +
      `line. A step whose text is exactly this heading calls the section — ` +
      `the condition is part of the name, not a decision the run makes. ` +
      `Rename the section if you meant it to be one.`,
  );
}

/** Cycle key for a section. Namespaced by file so two files' same-named
 *  sections never collide, and prefixed so a section can never collide with
 *  a skill name in the same `visited` set. */
function sectionCycleKey(filePath: string, name: string): string {
  return `section:${filePath}#${matchText(name)}`;
}

/** Render a cycle key for the error message — skill keys are already the
 *  canonical (possibly path-qualified) skill name, so they need no unwrapping. */
function describeCycleKey(key: string): string {
  return key.startsWith('section:') ? (key.split('#')[1] ?? key) : key;
}

/**
 * Resolve step `i` of `steps` to a section, or null.
 *
 * The match side is the raw authored text (`matchInput`), never the step
 * string on its own: by the time the recursion sees a skill body, `steps[i]`
 * has been through `extractPlainText` and `applySkillScope`, so a line
 * authored as `{{target}}` would otherwise resolve against its interpolated
 * value rather than what is on the page.
 */
function resolveSection(
  ctx: ExpandContext,
  steps: string[],
  i: number,
): SectionDefs[string] | null {
  const keys = Object.keys(ctx.sections);
  if (keys.length === 0) return null;
  const key = matchText(matchInput({ steps, rawSteps: ctx.rawSteps }, i));
  // Own-property check, not a bare index. A section name is arbitrary author
  // text, so a step reading `constructor` or `toString` would otherwise
  // resolve against `Object.prototype` and hand the expander a function where
  // it expects a section — `1. constructor` aborted the whole run with
  // "Cannot read properties of undefined (reading 'length')".
  if (!Object.prototype.hasOwnProperty.call(ctx.sections, key)) return null;
  return ctx.sections[key] ?? null;
}

/**
 * Match `[skill: name ...]` at the start of a step. Trailing text after the
 * closing `]` is treated as a human-readable comment and discarded.
 *
 * Returns `null` if the line is not a skill invocation. Throws
 * `SkillCallSyntaxError` if the line opens as one but is malformed.
 */
function parseSkillCall(step: string): SkillCall | null {
  const parsed = parseSkillCallSyntax(step);
  if (!parsed) return null;
  return {
    name: parsed.name,
    args: parsed.args,
    outputAliases: parsed.outputAliases,
  };
}

const skillCache = new Map<string, ParsedSkill>();

async function loadSkill(
  skillsDir: string,
  name: string,
  envCtx?: EnvDataContext,
): Promise<ParsedSkill> {
  // `name` is the canonical form `parseSkillCall` produced, and containment
  // rests on BOTH halves of what that function does:
  //
  //  - the grammar's name class is `[\w\-/]` — no `.`, no `\` — so a name
  //    cannot spell `..` and cannot walk upwards;
  //  - the leading slash is already stripped, without which `path.resolve`
  //    would read `/auth/login` as an absolute path and escape to the drive
  //    root instead of landing in `skillsDir`.
  //
  // Together those make a path-qualified name land in a subfolder of
  // `skillsDir`, so no separate containment check is needed here. A symlinked
  // subdirectory *inside* `skillsDir` can still point elsewhere; that is out of
  // scope — the skills tree is the project's own code, same trust domain as
  // the test file that references it.
  const filePath = path.resolve(skillsDir, `${name}.md`);
  // Cache key includes the active envName because skill-level dataSources may
  // resolve to different files per env (e.g. `../data/${envName}.json`). A
  // shared cache across envs would silently leak stale interpolated output.
  const cacheKey = `${filePath}::${envCtx?.envName ?? ''}`;
  const cached = skillCache.get(cacheKey);
  if (cached) return cached;

  let skill: ParsedSkill;
  try {
    skill = await parseSkillFile(filePath, envCtx);
  } catch (err) {
    // Distinguish "skill markdown file is missing" (author typoed the name)
    // from any other parse-or-interpolation failure (skill exists but its
    // dataSources/JSON resolution went wrong). Letting the latter bubble up
    // unwrapped lets the caller's wrapper produce a single coherent message.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skill "${name}" not found at ${filePath}`);
    }
    throw err;
  }
  skillCache.set(cacheKey, skill);
  return skill;
}

/** Reset the in-memory skill cache. Used by tests, and by long-lived hosts
 *  (e.g. the Electron UI server) at run-start so disk edits to skill files
 *  in the dev loop don't get masked by a stale parse from an earlier run. */
export function clearSkillCache(): void {
  skillCache.clear();
}

/**
 * Wrap an error from `loadSkill` (which today is just `parseSkillFile`) with
 * caller-side context. The underlying error already names the skill file
 * (via `interpolateEnvData`'s `ctx.filePath`); we add the test file path and
 * the literal `[skill: ...]` line that triggered the call so an author has
 * both clickable endpoints in the failure message.
 */
function wrapSkillLoadError(
  err: unknown,
  call: SkillCall,
  invocationLine: string,
  ctx: ExpandContext,
): Error {
  const original = err instanceof Error ? err.message : String(err);
  const callerSuffix = ctx.callerFilePath
    ? `\n  Invoked from ${ctx.callerFilePath}: ${invocationLine}`
    : `\n  Invoked via: ${invocationLine}`;
  return new Error(
    `Skill "${call.name}" failed to load:\n  ${original}${callerSuffix}`,
  );
}

function validateCall(skill: ParsedSkill, call: SkillCall): void {
  // `skill.name` is the H1 inside the file; `call.name` is the path-qualified
  // locator the step wrote. They differ for any skill in a subfolder, and two
  // subfolders may hold the same H1 (`auth/login.md` and `admin/login.md` are
  // both `# login`) — so when they differ, name the invocation too. Appended at
  // the END so the leading `Skill "<H1>" …` phrasing is unchanged.
  const via = call.name !== skill.name ? ` (invoked as "${call.name}")` : '';
  for (const param of Object.keys(skill.parameters)) {
    if (!(param in call.args)) {
      throw new Error(
        `Skill "${skill.name}" requires parameter "${param}" but caller did not supply it${via}`,
      );
    }
  }
  for (const aliasedOutput of Object.keys(call.outputAliases)) {
    if (!skill.outputs.includes(aliasedOutput)) {
      throw new Error(
        `Skill "${skill.name}" has no declared output "${aliasedOutput}" — declared outputs: [${skill.outputs.join(', ') || 'none'}]${via}`,
      );
    }
  }
  const unknownArgs = Object.keys(call.args).filter((k) => !(k in skill.parameters));
  if (unknownArgs.length > 0) {
    logger.warn(
      `Skill "${skill.name}" call passes unknown args: ${unknownArgs.join(', ')} (declared: [${Object.keys(skill.parameters).join(', ') || 'none'}])${via}`,
    );
  }
}

/**
 * Apply parameter interpolation, output aliasing, and internal-name
 * namespacing to a skill's step list and to its own inline sections. Returns
 * strings ready for recursion (they may still contain nested `[skill: ...]`
 * calls or bare-name section calls).
 *
 * Section bodies are transformed on **fresh copies**: the `ParsedSkill` comes
 * from `skillCache` and is shared across every invocation of that skill, so
 * mutating it in place would let a second invocation inherit the first's
 * arguments.
 *
 * `rawSteps` is deliberately NOT transformed. The match side stays the text
 * as authored, so section resolution is decidable from the file alone.
 *
 * The alternative — matching post-interpolation — would let a step written
 * `1. {{target}}`, invoked with `target="Login"`, dispatch to `### Login`.
 * Tempting, but it breaks the editor/runtime agreement this feature is built
 * on: go-to-definition, document links and the "never used" diagnostic all
 * work on static text, so that call site would render with no link and its
 * target would be reported dead — while the runtime called it anyway. Exactly
 * the silent divergence inline sections exist to remove.
 *
 * Renames are safe to omit here for the same reason they cannot matter: they
 * only ever rewrite `{{X}}` placeholders and `[store as: X]` directives, and
 * a section name may contain neither (`{{` and a leading `[` are both refused
 * at parse time), so no rename can create or destroy a match.
 */
function applySkillScope(
  skill: ParsedSkill,
  call: SkillCall,
  instanceId: number,
): {
  steps: string[];
  rawSteps: string[];
  sections: SectionDefs;
  varScope: Record<string, string>;
} {
  const paramNames = new Set(Object.keys(skill.parameters));
  const outputNames = new Set(skill.outputs);

  // Discover every variable name the skill body uses, via {{X}} or [store as: X].
  // Section bodies are scanned too, or an internal variable used *only* inside
  // a section would escape namespacing and leak into the caller's scope.
  const usedNames = new Set<string>();
  const scanForNames = (step: string): void => {
    const { placeholders, captures } = referencedVariableNames(step);
    for (const name of placeholders) usedNames.add(name);
    for (const name of captures) usedNames.add(name);
  };
  for (const step of skill.steps) scanForNames(step);
  for (const section of Object.values(skill.sections)) {
    for (const step of section.steps) scanForNames(step);
  }

  // Names that must be rewritten to a per-instance internal name.
  const internalRenames = new Map<string, string>();
  for (const name of usedNames) {
    if (paramNames.has(name) || outputNames.has(name)) continue;
    internalRenames.set(name, `__skill${instanceId}_${name}`);
  }

  // Output renames: declared output → caller alias (or unchanged if no alias).
  const outputRenames = new Map<string, string>();
  for (const output of outputNames) {
    const alias = call.outputAliases[output];
    if (alias && alias !== output) outputRenames.set(output, alias);
  }

  const applyExcept = (step: string, skip: ReadonlySet<string>): string => {
    let s = step;

    // 1. Apply output aliases first so subsequent rewrites don't clash.
    for (const [from, to] of outputRenames) {
      if (skip.has(from)) continue;
      s = renameVar(s, from, to);
    }

    // 2. Rewrite internal names to the namespaced form.
    for (const [from, to] of internalRenames) {
      if (skip.has(from)) continue;
      s = renameVar(s, from, to);
    }

    // 3. Interpolate caller-supplied parameter values.
    //
    // Guarded for the same two failures the row path guards
    // (`checkedRowInterpolate`), because this is the other site that writes a
    // caller's value into the body TEXT. Two shapes reach here that the
    // parse-time check in `parseSkillContent` cannot see, because both depend
    // on the CALL rather than the skill: an argument named after a declared
    // `## Outputs` name (outputs are excluded from internal renaming, so the
    // target is baked over and the assignment silently vanishes), and an
    // array-literal argument, whose quotes make the interpolated line
    // unparseable.
    s = substitutePreservingSet(
      s,
      (text) => interpolate(text, call.args),
      (target) =>
        `The call to skill "${skill.name}" makes "Set {{${target}}} to …" ` +
        `unparseable once its arguments are substituted. An argument whose ` +
        `name matches the assignment target overwrites it — outputs are not ` +
        `renamed, so a declared output name collides — and an argument whose ` +
        `value contains a double quote breaks the assigned value. Left to ` +
        `run, the assignment would silently not happen.`,
    );

    return s;
  };

  const NOTHING_SKIPPED: ReadonlySet<string> = new Set();
  const apply = (step: string): string => applyExcept(step, NOTHING_SKIPPED);

  // Null-prototype, for the same reason the parser and api-server maps are:
  // `### __proto__` is a legal section name, and assigning it into an object
  // literal invokes the prototype setter — the entry vanishes AND the map's
  // prototype is replaced with the section object, so `sections['name']` then
  // resolves to a string. This is the third of three maps; missing it meant a
  // `### __proto__` worked in a test file and silently degraded inside a
  // skill, with the dead-section warning staying quiet because it scans the
  // untransformed `skill.sections` where the entry is still present.
  const sections: SectionDefs = Object.create(null) as SectionDefs;
  for (const [key, section] of Object.entries(skill.sections)) {
    // A looped section's columns are NOT skill-internal variables: they are
    // bound per iteration by the loop, not by the skill's scope. Namespacing
    // them would rewrite `{{thing}}` to `{{__skill1_thing}}` in the body while
    // the row still binds `thing`, leaving the placeholder to reach the AI as
    // literal text — which is exactly what it did before this exclusion.
    const columns = new Set(Object.keys(section.rows?.[0] ?? {}));
    const applyBody = columns.size === 0
      ? apply
      : (text: string): string => applyExcept(text, columns);
    sections[key] = {
      name: section.name,
      headingLine: section.headingLine,
      steps: section.steps.map(applyBody),
      // Copied, not transformed — see the docstring. Fresh arrays either way:
      // the ParsedSkill is shared via skillCache and must never be mutated.
      rawSteps: [...section.rawSteps],
      stepLines: [...section.stepLines],
      ...(section.rows && { rows: section.rows.map((r) => ({ ...r })) }),
    };
  }

  // Authored name → effective runtime name, for this invocation. Output
  // aliases and internal renames are disjoint by construction
  // (`internalRenames` skips declared params and outputs), so the merge order
  // can't drop an entry. Parameters are absent on purpose: their values are
  // interpolated into the text, never stored under a name.
  const varScope: Record<string, string> = {};
  for (const [from, to] of outputRenames) varScope[from] = to;
  for (const [from, to] of internalRenames) varScope[from] = to;

  return {
    steps: skill.steps.map(apply),
    rawSteps: [...skill.rawSteps],
    sections,
    varScope,
  };
}

/** Rename a variable in both `{{X}}` placeholders and `[store as: X]` directives. */
function renameVar(text: string, from: string, to: string): string {
  const placeholderRe = new RegExp(`\\{\\{${escapeRegex(from)}\\}\\}`, 'g');
  const storeRe = new RegExp(`\\[store\\s+as:\\s*${escapeRegex(from)}\\]`, 'g');
  return text.replace(placeholderRe, `{{${to}}}`).replace(storeRe, `[store as: ${to}]`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
