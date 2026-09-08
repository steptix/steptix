import type { Config } from '../config/types.js';
import type {
  HookSourceSkills,
  HookToolCalls,
  ParsedTest,
  TestHooks,
} from '../parser/types.js';
import { EMPTY_HOOKS } from '../parser/types.js';
import { expandSkills } from '../skills/expander.js';
import { parseToolCall } from '../tools/tool-call-parser.js';

export interface ResolvedHooks extends TestHooks {
  /** True when at least one scope contains at least one instruction. */
  hasAny: boolean;
  /** Parallel-to-`hooks` tool-call markers — when non-null, the runner
   *  dispatches the instruction to the tool executor instead of the AI loop. */
  toolCalls: HookToolCalls;
  /** Parallel-to-`hooks` source-skill attribution for report rendering. */
  sourceSkills: HookSourceSkills;
}

/**
 * Merge project-level `execution.defaultHooks` with a test's `## Hooks`
 * section. Defaults run first, per-test hooks second (authors compose on top).
 *
 * If the test's frontmatter sets `hooks: replace`, defaults are ignored and
 * only per-test hooks are used.
 *
 * Skill references in project defaults are expanded here, using the same
 * `skillsDir` that expanded the test's own hooks at parse time. Tool-call
 * markers and source-skill attribution are derived for both default and
 * per-test hooks so the runner can dispatch tools and tag report rows
 * uniformly across all four scopes.
 */
export async function resolveHooks(
  test: ParsedTest,
  config: Config,
): Promise<ResolvedHooks> {
  const replace = test.frontmatter.hooks === 'replace';
  const defaults = replace ? emptyResolvedHooks() : await expandDefaults(config);

  const merged: TestHooks = {
    before: [...defaults.steps.before, ...test.hooks.before],
    beforeEach: [...defaults.steps.beforeEach, ...test.hooks.beforeEach],
    afterEach: [...defaults.steps.afterEach, ...test.hooks.afterEach],
    after: [...defaults.steps.after, ...test.hooks.after],
  };

  const toolCalls: HookToolCalls = {
    before: [...defaults.toolCalls.before, ...test.hookToolCalls.before],
    beforeEach: [...defaults.toolCalls.beforeEach, ...test.hookToolCalls.beforeEach],
    afterEach: [...defaults.toolCalls.afterEach, ...test.hookToolCalls.afterEach],
    after: [...defaults.toolCalls.after, ...test.hookToolCalls.after],
  };

  const sourceSkills: HookSourceSkills = {
    before: [...defaults.sourceSkills.before, ...test.hookSourceSkills.before],
    beforeEach: [...defaults.sourceSkills.beforeEach, ...test.hookSourceSkills.beforeEach],
    afterEach: [...defaults.sourceSkills.afterEach, ...test.hookSourceSkills.afterEach],
    after: [...defaults.sourceSkills.after, ...test.hookSourceSkills.after],
  };

  const hasAny =
    merged.before.length > 0 ||
    merged.beforeEach.length > 0 ||
    merged.afterEach.length > 0 ||
    merged.after.length > 0;

  return { ...merged, hasAny, toolCalls, sourceSkills };
}

/** Internal — defaults expanded with parallel toolCalls + sourceSkills metadata. */
interface ExpandedDefaults {
  steps: TestHooks;
  toolCalls: HookToolCalls;
  sourceSkills: HookSourceSkills;
}

function emptyResolvedHooks(): ExpandedDefaults {
  return {
    steps: EMPTY_HOOKS,
    toolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    sourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  };
}

async function expandDefaults(config: Config): Promise<ExpandedDefaults> {
  const d = config.execution.defaultHooks;
  if (!d) return emptyResolvedHooks();

  const skillsDir = config.tests.skillsDir;
  const expand = async (
    raws: string[] | undefined,
  ): Promise<{ steps: string[]; sources: (string | null)[]; tools: ReturnType<typeof parseToolCall>[] }> => {
    if (!raws || raws.length === 0) return { steps: [], sources: [], tools: [] };
    // `expandControlLines: false` for the same reason the per-file hook
    // scopes pass it: project `defaultHooks` are never validated at parse
    // time, so a control line there would split into an unevaluated guard and
    // an unconditional tail (stories/control-flow.md).
    const exp = await expandSkills(raws, skillsDir, undefined, undefined, undefined, {
      expandControlLines: false,
    });
    return {
      steps: exp.steps,
      sources: exp.sourceSkills,
      tools: exp.steps.map((s) => parseToolCall(s)),
    };
  };

  const before = await expand(d.before);
  const beforeEach = await expand(d.beforeEach);
  const afterEach = await expand(d.afterEach);
  const after = await expand(d.after);

  return {
    steps: {
      before: before.steps,
      beforeEach: beforeEach.steps,
      afterEach: afterEach.steps,
      after: after.steps,
    },
    toolCalls: {
      before: before.tools,
      beforeEach: beforeEach.tools,
      afterEach: afterEach.tools,
      after: after.tools,
    },
    sourceSkills: {
      before: before.sources,
      beforeEach: beforeEach.sources,
      afterEach: afterEach.sources,
      after: after.sources,
    },
  };
}
