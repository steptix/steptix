import path from 'node:path';
import { parseSkillFile } from '../parser/markdown.js';
import { interpolate } from '../parser/parameters.js';
import type { ParsedSection, ParsedSkill } from '../parser/types.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { matchInput, matchText, NO_HOOKS_MARKER } from '../parser/section-match.js';
import { logger } from '../utils/logger.js';
import { parseSkillCall as parseSkillCallSyntax } from './skill-call-parser.js';

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

const MAX_DEPTH = 10;

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
 */
export interface ExpandedStepOrigin {
  inputIndex: number;
  frameId: string;
  skillFilePath?: string;
  skillLine?: number;
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
}

/**
 * Expand all `[skill: ...]` invocations in `steps` recursively, returning a
 * flat list of fully-resolved natural-language step strings plus a parallel
 * array attributing each step to the outermost skill it came from (or null
 * for inline steps).
 *
 * @param steps  Step list from a test (or another skill).
 * @param skillsDir  Directory containing `*.md` skill files.
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
  },
): Promise<SkillExpansion> {
  const frames: Record<string, ExpandedFrame> = {};
  const sections = opts?.sections ?? {};
  const ctx: ExpandContext = {
    skillsDir,
    seq: { n: 0 },
    frames,
    sections,
    sectionsFilePath: callerFilePath ?? '<inline>',
    warnDeadSections: opts?.warnDeadSections ?? true,
    onDeadSection: opts?.onDeadSection ?? ((message: string) => logger.warn(message)),
    deadScanned: new Set(),
    insideSkill: false,
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
      invoked.add(matchText(matchInput(list, i)));
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
): Promise<Omit<SkillExpansion, 'frames'>> {
  if (depth > MAX_DEPTH) {
    throw new Error(`Skill expansion exceeded max depth of ${MAX_DEPTH} (possible recursion)`);
  }

  const out: string[] = [];
  const sources: (string | null)[] = [];
  const sourceSecs: (string | null)[] = [];
  const raws: string[] = [];
  const origins: ExpandedStepOrigin[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const call = parseSkillCall(step);

    // Resolution order: a bracket token is claimed first and is never a
    // section call, however its text compares. Only plain-text steps reach
    // the bare-name test below.
    if (!call) {
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
        };

        // A section is a macro: it shares the caller's scope, so there is no
        // scope pass here and `ctx` carries through unchanged. The body may
        // call sibling sections, so the sections map stays put — only the
        // match-side array swaps to this body's own.
        const bodyCtx: ExpandContext = {
          ...ctx,
          ...(section.rawSteps
            ? { rawSteps: section.rawSteps }
            : { rawSteps: undefined }),
        };
        // Strip a leading `[no-hooks]` from each body step as it is inlined.
        // The CLI parser already stripped these, but the wire shape carries
        // markers verbatim (the client can't strip them — they are part of
        // the match side), so without this the literal marker text would
        // reach the AI on the server path only. A marker on a body step is
        // stripped and ignored either way: it is the *invocation's* marker
        // that opts the whole body out, via origin mapping.
        const bodySteps = section.steps.map((s) => s.replace(NO_HOOKS_MARKER, ''));

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
          section.stepLines,
        );

        out.push(...recursed.steps);
        sources.push(...recursed.sourceSkills);
        sourceSecs.push(...recursed.sourceSections);
        raws.push(...recursed.rawSteps);
        origins.push(...recursed.origins);
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
      });
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

    out.push(...recursed.steps);
    sources.push(...recursed.sourceSkills);
    sourceSecs.push(...recursed.sourceSections);
    raws.push(...recursed.rawSteps);
    origins.push(...recursed.origins);
  }

  return {
    steps: out,
    sourceSkills: sources,
    sourceSections: sourceSecs,
    rawSteps: raws,
    origins,
  };
}

/** Cycle key for a section. Namespaced by file so two files' same-named
 *  sections never collide, and prefixed so a section can never collide with
 *  a skill name in the same `visited` set. */
function sectionCycleKey(filePath: string, name: string): string {
  return `section:${filePath}#${matchText(name)}`;
}

/** Render a cycle key for the error message — skills are bare names. */
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
  for (const param of Object.keys(skill.parameters)) {
    if (!(param in call.args)) {
      throw new Error(
        `Skill "${skill.name}" requires parameter "${param}" but caller did not supply it`,
      );
    }
  }
  for (const aliasedOutput of Object.keys(call.outputAliases)) {
    if (!skill.outputs.includes(aliasedOutput)) {
      throw new Error(
        `Skill "${skill.name}" has no declared output "${aliasedOutput}" — declared outputs: [${skill.outputs.join(', ') || 'none'}]`,
      );
    }
  }
  const unknownArgs = Object.keys(call.args).filter((k) => !(k in skill.parameters));
  if (unknownArgs.length > 0) {
    logger.warn(
      `Skill "${skill.name}" call passes unknown args: ${unknownArgs.join(', ')} (declared: [${Object.keys(skill.parameters).join(', ') || 'none'}])`,
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

  const apply = (step: string): string => {
    let s = step;

    // 1. Apply output aliases first so subsequent rewrites don't clash.
    for (const [from, to] of outputRenames) {
      s = renameVar(s, from, to);
    }

    // 2. Rewrite internal names to the namespaced form.
    for (const [from, to] of internalRenames) {
      s = renameVar(s, from, to);
    }

    // 3. Interpolate caller-supplied parameter values.
    s = interpolate(s, call.args);

    return s;
  };

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
    sections[key] = {
      name: section.name,
      headingLine: section.headingLine,
      steps: section.steps.map(apply),
      // Copied, not transformed — see the docstring. Fresh arrays either way:
      // the ParsedSkill is shared via skillCache and must never be mutated.
      rawSteps: [...section.rawSteps],
      stepLines: [...section.stepLines],
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
