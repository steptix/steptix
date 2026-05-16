import path from 'node:path';
import { parseSkillFile } from '../parser/markdown.js';
import { interpolate } from '../parser/parameters.js';
import type { ParsedSkill } from '../parser/types.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { logger } from '../utils/logger.js';
import { parseSkillCall as parseSkillCallSyntax } from './skill-call-parser.js';

/**
 * Parse-time expansion of `[skill: name arg="value" out.x="alias"]` step
 * references. Skills are inlined recursively into a flat list of steps so
 * the runner sees no skill machinery.
 */

const STORE_AS_RE = /\[store\s+as:\s*(\w+)\]/g;
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

const MAX_DEPTH = 10;

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
  kind: 'test' | 'skill';
  uri: string;
  invocationLine: number | null;
  skillName?: string;
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
  skillsDir: string,
  envCtx?: EnvDataContext,
  callerFilePath?: string,
): Promise<SkillExpansion> {
  const frames: Record<string, ExpandedFrame> = {};
  const ctx: ExpandContext = {
    skillsDir,
    seq: 0,
    frames,
    ...(envCtx && { envCtx }),
    ...(callerFilePath && { callerFilePath }),
  };
  const result = await expandRecursive(
    steps,
    ctx,
    new Set(),
    0,
    null,
    '',
    null,
    null,
  );
  return { ...result, frames };
}

interface ExpandContext {
  skillsDir: string;
  /** Monotonic counter producing unique prefixes for internal capture names. */
  seq: number;
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
  const origins: ExpandedStepOrigin[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const call = parseSkillCall(step);
    if (!call) {
      out.push(step);
      sources.push(sourceSkill);
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

    const instanceId = ++ctx.seq;
    const expandedBody = applySkillScope(skill, call, instanceId);
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
    };

    // Outermost-skill attribution: keep the first skill we entered as the
    // source for every inner step, so report rows point back to a name the
    // test author actually wrote.
    const innerCtx: ExpandContext = {
      ...ctx,
      currentSkillFilePath: skill.filePath,
      currentSkillName: call.name,
    };
    const recursed = await expandRecursive(
      expandedBody,
      innerCtx,
      new Set([...visited, call.name]),
      depth + 1,
      sourceSkill ?? call.name,
      newFrameId,
      // Inside a skill body, every emitted step is attributed to the
      // [skill: ...] invocation at the current level — that's `i` here.
      attribInputIndex ?? i,
      skill.stepLines,
    );

    out.push(...recursed.steps);
    sources.push(...recursed.sourceSkills);
    origins.push(...recursed.origins);
  }

  return { steps: out, sourceSkills: sources, origins };
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
 * namespacing to a skill's step list. Returns step strings ready for
 * recursion (they may still contain nested `[skill: ...]` calls).
 */
function applySkillScope(
  skill: ParsedSkill,
  call: SkillCall,
  instanceId: number,
): string[] {
  const paramNames = new Set(Object.keys(skill.parameters));
  const outputNames = new Set(skill.outputs);

  // Discover every variable name the skill body uses, via {{X}} or [store as: X].
  const usedNames = new Set<string>();
  for (const step of skill.steps) {
    for (const m of step.matchAll(PLACEHOLDER_RE)) {
      if (m[1]) usedNames.add(m[1]);
    }
    for (const m of step.matchAll(STORE_AS_RE)) {
      if (m[1]) usedNames.add(m[1]);
    }
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

  return skill.steps.map((step) => {
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
  });
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
