import type { Config } from '../config/types.js';
import type { ParsedTest, TestHooks } from '../parser/types.js';
import { EMPTY_HOOKS } from '../parser/types.js';
import { expandSkills } from '../skills/expander.js';

export interface ResolvedHooks extends TestHooks {
  /** True when at least one scope contains at least one instruction. */
  hasAny: boolean;
}

/**
 * Merge project-level `execution.defaultHooks` with a test's `## Hooks`
 * section. Defaults run first, per-test hooks second (authors compose on top).
 *
 * If the test's frontmatter sets `hooks: replace`, defaults are ignored and
 * only per-test hooks are used.
 *
 * Skill references in project defaults are expanded here, using the same
 * `skillsDir` that expanded the test's own hooks at parse time.
 */
export async function resolveHooks(
  test: ParsedTest,
  config: Config,
): Promise<ResolvedHooks> {
  const replace = test.frontmatter.hooks === 'replace';
  const defaults = replace ? EMPTY_HOOKS : await expandDefaults(config);

  const merged: TestHooks = {
    before: [...defaults.before, ...test.hooks.before],
    beforeEach: [...defaults.beforeEach, ...test.hooks.beforeEach],
    afterEach: [...defaults.afterEach, ...test.hooks.afterEach],
    after: [...defaults.after, ...test.hooks.after],
  };

  const hasAny =
    merged.before.length > 0 ||
    merged.beforeEach.length > 0 ||
    merged.afterEach.length > 0 ||
    merged.after.length > 0;

  return { ...merged, hasAny };
}

async function expandDefaults(config: Config): Promise<TestHooks> {
  const d = config.execution.defaultHooks;
  if (!d) return EMPTY_HOOKS;

  const skillsDir = config.tests.skillsDir;
  const expand = async (steps: string[] | undefined): Promise<string[]> => {
    if (!steps || steps.length === 0) return [];
    return expandSkills(steps, skillsDir);
  };

  return {
    before: await expand(d.before),
    beforeEach: await expand(d.beforeEach),
    afterEach: await expand(d.afterEach),
    after: await expand(d.after),
  };
}
