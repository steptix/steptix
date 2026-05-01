import path from 'node:path';
import { parseSkillFile } from '../parser/markdown.js';
import { interpolate } from '../parser/parameters.js';
import type { ParsedSkill } from '../parser/types.js';
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
 * Expand all `[skill: ...]` invocations in `steps` recursively, returning a
 * flat list of fully-resolved natural-language step strings.
 *
 * @param steps  Step list from a test (or another skill).
 * @param skillsDir  Directory containing `*.md` skill files.
 */
export async function expandSkills(
  steps: string[],
  skillsDir: string,
): Promise<string[]> {
  const ctx = { skillsDir, seq: 0 };
  return expandRecursive(steps, ctx, new Set(), 0);
}

interface ExpandContext {
  skillsDir: string;
  /** Monotonic counter producing unique prefixes for internal capture names. */
  seq: number;
}

async function expandRecursive(
  steps: string[],
  ctx: ExpandContext,
  visited: Set<string>,
  depth: number,
): Promise<string[]> {
  if (depth > MAX_DEPTH) {
    throw new Error(`Skill expansion exceeded max depth of ${MAX_DEPTH} (possible recursion)`);
  }

  const out: string[] = [];

  for (const step of steps) {
    const call = parseSkillCall(step);
    if (!call) {
      out.push(step);
      continue;
    }

    if (visited.has(call.name)) {
      throw new Error(
        `Skill cycle detected: ${[...visited, call.name].join(' -> ')}`,
      );
    }

    const skill = await loadSkill(ctx.skillsDir, call.name);
    validateCall(skill, call);

    const instanceId = ++ctx.seq;
    const expandedBody = applySkillScope(skill, call, instanceId);

    const recursed = await expandRecursive(
      expandedBody,
      ctx,
      new Set([...visited, call.name]),
      depth + 1,
    );

    out.push(...recursed);
  }

  return out;
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

async function loadSkill(skillsDir: string, name: string): Promise<ParsedSkill> {
  const filePath = path.resolve(skillsDir, `${name}.md`);
  const cached = skillCache.get(filePath);
  if (cached) return cached;

  let skill: ParsedSkill;
  try {
    skill = await parseSkillFile(filePath);
  } catch (err) {
    throw new Error(`Skill "${name}" not found at ${filePath}: ${String(err)}`);
  }
  skillCache.set(filePath, skill);
  return skill;
}

/** Reset the in-memory skill cache. Used by tests; the parser does not call this. */
export function clearSkillCache(): void {
  skillCache.clear();
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
