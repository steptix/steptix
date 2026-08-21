import type { Page, BrowserContext, Browser } from 'playwright';
import type { ToolLog } from '../tools/types.js';

/**
 * Public shapes for step code-behind (stories/step-codebehind.md).
 *
 * A markdown file's code-behind is a committed sibling `.steps.ts` that
 * default-exports `defineSteps([...])`. Each entry binds to a step by its
 * authored text and replaces the AI call for that step.
 */

/**
 * The variable half of the code-behind context. Deliberately a narrower
 * `ToolStepApi`: an entry declares no `outputs` schema, so `setVar` accepts
 * any name (the test's `[as: x]` capture names are what generated code
 * writes).
 *
 * Both accessors are **frame-aware**. Inside a skill body the author wrote
 * `{{username}}`, but `applySkillScope` rewrote the invocation's step text to
 * the namespaced `{{__skill<N>_username}}`. Generated code is written once per
 * skill, not per invocation, so it keeps using the authored name and the
 * runtime resolves it through the executing frame's namespace.
 */
export interface CodeBehindStepApi {
  /** Read a variable by its **authored** name. */
  getVar(name: string): string | undefined;
  /** Write a variable by its **authored** name (output aliases applied). */
  setVar(name: string, value: string | number | boolean | Array<string | number | boolean>): void;
  /** Throw a labelled assertion error if `condition` is false. A failed
   *  `expect` is a real step failure, never a fall-through to AI. */
  expect(condition: boolean, message?: string): void;
}

/**
 * Runtime context handed to an entry's `run`. The same live Playwright
 * instances the AI loop drives (so anything the code does carries into the
 * following natural-language steps), plus the test's `## Config` baseUrl.
 */
export interface CodeBehindContext {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  step: CodeBehindStepApi;
  log: ToolLog;
  /** The test's `## Config` baseUrl, when it declared one. */
  baseUrl?: string;
}

/**
 * One code-behind entry: the Playwright TypeScript behind a single step.
 *
 * `source` is the step's raw markdown text as authored — everything after the
 * list marker, trimmed, exactly as written in the `.md`, including `{{param}}`
 * placeholders, `[as: x]` markers and any `[no-hooks]` marker — before any
 * interpolation or skill-scope transform. Comparison is case-sensitive exact
 * equality after trimming: an edited step should miss and regenerate, not
 * fuzzily match.
 */
export interface StepCodeEntry {
  source: string;
  /**
   * Name of the `### Section` whose body defines this step, for steps that
   * live in an inline section. Compared with the contract's `matchText`, so
   * casing and a `[no-hooks]` prefix don't matter. Absent for a step in a
   * file's main flow (test or skill body).
   */
  section?: string;
  /**
   * Author escape hatch: this step always runs under AI, and generation never
   * writes over this entry. An `ai: true` entry needs no `run`.
   */
  ai?: boolean;
  run?: (ctx: CodeBehindContext) => Promise<void> | void;
}

/**
 * Author entry point for a `.steps.ts` file — an identity function providing
 * types, exactly like `defineTool`.
 *
 * ```ts
 * import { defineSteps } from 'ai-ui-automation/codebehind';
 *
 * export default defineSteps([
 *   {
 *     source: 'Enter the username {{username}}',
 *     async run({ page, step }) {
 *       await page.locator('#login_field').fill(step.getVar('username')!);
 *     },
 *   },
 * ]);
 * ```
 */
export function defineSteps(entries: StepCodeEntry[]): StepCodeEntry[] {
  return entries;
}
