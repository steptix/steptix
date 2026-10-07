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
  /**
   * Resolve a path written in a step — relative to the TEST FILE's folder —
   * to the absolute path Playwright needs:
   *
   * ```ts
   * await page.locator('#statement-file')
   *   .setInputFiles(step.filePath('attachments/logo.png'));
   * ```
   *
   * Synchronous, so an entry stays one expression, and forgiving about
   * separators (`\\attachments\\logo.png` works too). Throws — with the same
   * message an AI run would show — when the file is missing, is a folder, or
   * resolves outside the project. Those throws are tagged non-retryable: the
   * entry is not broken, so the runner fails the step instead of healing it
   * under AI (stories/upload-action.md §8).
   */
  filePath(relative: string): string;
  /** Throw a labelled assertion error if `condition` is false. A failed
   *  `expect` is a real step failure, never a fall-through to AI. */
  expect(condition: boolean, message?: string): void;
  /**
   * A SELF-check: what an entry that only reads asserts about its own read —
   * that the thing it read from was really there and really populated
   * (docs/specs/SPEC-codebehind-robustness.md §6.5).
   *
   * ```ts
   * const names = await page.locator('#account-list .account-name').allTextContents();
   * step.check(names.length === rows, 'one name per account row');
   * ```
   *
   * When it fails, the code is what is wrong, not the application — so in an
   * entry that takes no action it fails as broken code does: "Self-check
   * failed: …", the step re-runs under AI, the entry is flagged stale and the
   * next compile repairs it. In an entry that acts it fails the step like
   * {@link expect}, because a re-run after a click can submit twice. For what
   * the STEP states — "Verify the total is $4.00" — use {@link expect}.
   */
  check(condition: boolean, message?: string): void;
  /**
   * Wait until what this entry's actions started is over: the first-party
   * requests that began since the entry started — or since the last
   * `settle()` — and then the page holding still for 600 ms, within the
   * step's budget (docs/specs/SPEC-codebehind-robustness.md §6.4). It names no
   * URL, so it holds for a data row whose click navigates and one whose click
   * only shows an error:
   *
   * ```ts
   * await page.locator('#sign-in-btn').click();
   * await step.settle();
   * step.expect((await page.title()).includes('Dashboard'), 'signed in');
   * ```
   *
   * Never throws. At its budget it stops, and the run log names what was
   * still pending. The runner also settles after every entry that acts, so it
   * is for the reads and checks INSIDE an entry, after its own action.
   */
  settle(): Promise<void>;
  /**
   * End the flow this step is in, as a PASS — the code form of a
   * `If … then return` / `… then stop` step
   * (stories/step-flow-control.md, decision 11).
   *
   * It throws a sentinel, so nothing after it in the entry runs. The runner
   * reads that throw as a passed step carrying `flowControl`, and the run loop
   * skips the rest of the innermost flow: the `### Section` body, the skill
   * body, or the test itself. Write it as the branch of the condition the step
   * states, and write the other branch by leaving it out:
   *
   * ```ts
   * if ((await page.title()).includes('Dashboard')) step.exit();
   * ```
   *
   * Only an entry bound to a step whose text CLAIMS the form may call it. On
   * any other step the call fails the step non-retryably, naming the rule: the
   * markdown is what a reader sees, so it has to say what the code does.
   */
  exit(): never;
  /**
   * Fail the run deliberately, in the author's words — the code form of
   * `If … then fail the test with error "…"`
   * (stories/step-failure-outcomes.md, decision 10).
   *
   * It throws, like {@link exit}, so nothing after it in the entry runs:
   *
   * ```ts
   * if (step.getVar('a') === 'peanuts') step.fail('The variable value was peanuts. Expected apples');
   * ```
   *
   * The throw is the same class a failed {@link expect} throws, so the runner's
   * existing rule applies unchanged: a real failure, never healed under AI. What
   * the marker adds is the wording — the row says the step failed as written
   * rather than that an expectation was not met.
   *
   * Unlike {@link exit} there is NO claim guard, the mirror of exit's reason: the
   * unsafe direction for an exit is passing work that did not happen, and there
   * is no unsafe direction for failing. An author who writes `step.fail` into an
   * ordinary step's entry has written a failing step.
   */
  fail(message: string): never;
}

/** One tab, as `tabs.list()` reports it. */
export interface CodeBehindTabInfo {
  /** `main`, an author label from `as`, or an auto `page:N`. */
  label: string;
  url: string;
  isActive: boolean;
}

/** One browser, as `browsers.list()` reports it. */
export interface CodeBehindBrowserInfo {
  label: string;
  engine: string;
  channel: string;
  activePageUrl: string;
  isActive: boolean;
}

/**
 * Tab control — the code-behind half of `openPage`, `switchPage` and
 * `closePage` (stories/codebehind-framework-actions.md).
 *
 * Every method that changes which tab is active RETURNS the page that is
 * active afterwards, and generated code must use that handle. `run({ page })`
 * destructures, and destructuring reads once: after a switch the `page`
 * binding still points at the tab the step just left.
 *
 * These drive the run's own `PageTracker`, so a switch here is the same
 * switch a `switchPage` action makes — the natural-language steps that follow
 * target the tab this code moved to.
 */
export interface CodeBehindTabApi {
  /**
   * Open a new tab at `url` and make it active. `as` names it, so a later
   * `switchTo` can address it exactly rather than by URL substring.
   */
  open(url: string, options?: { as?: string }): Promise<Page>;
  /**
   * Run `trigger` and adopt the tab the PAGE opened as a result — a
   * `window.open`, or a click on `target="_blank"`. The wait is armed before
   * the trigger runs, so there is no window in which the tab exists but
   * nothing is listening; a `switchTo` polling for it afterwards is the racy
   * version of this.
   */
  openedBy(
    trigger: () => unknown | Promise<unknown>,
    options?: { as?: string; timeoutMs?: number },
  ): Promise<Page>;
  /**
   * Make an already-open tab active, by label (`main`, `docs`, `page:2`),
   * URL substring, or title substring — the tracker's own matching, so the
   * identifier a `switchPage` transcript carries works here unchanged.
   */
  switchTo(identifier: string): Promise<Page>;
  /** Close a tab, and return the page that is active afterwards. The main
   *  tab cannot be closed — that throws, as the AI action fails. */
  close(identifier: string): Promise<Page>;
  /** Every tab the run is tracking. */
  list(): CodeBehindTabInfo[];
  /** The active page right now — the fresh handle after any switch. */
  active(): Page;
}

/**
 * Browser control — the code-behind half of `openBrowser`, `switchBrowser`
 * and `closeBrowser` (stories/codebehind-framework-actions.md).
 *
 * A second browser is a second isolated session: its own context, cookies and
 * `PageTracker`. `open` and `switchTo` return the new browser's active page
 * for the same reason the tab API does.
 */
export interface CodeBehindBrowserApi {
  /** Launch a browser under `label` and make it active. Overrides default to
   *  the run's own browser config. */
  open(
    label: string,
    options?: { engine?: 'chromium' | 'firefox' | 'webkit'; channel?: string; headed?: boolean },
  ): Promise<Page>;
  /** Make a tracked browser active, by the label it was opened under.
   *  `default` is the one the test started in. */
  switchTo(label: string): Promise<Page>;
  /**
   * Close a tracked browser. Returns nothing on purpose: closing the last one
   * leaves no active session, and there would be no honest page to hand back.
   * A step that closes a browser asserts on `list()`, not on a page.
   */
  close(label: string): Promise<void>;
  /** Every browser the run is tracking. */
  list(): CodeBehindBrowserInfo[];
  /** The active browser's label. */
  activeLabel(): string;
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
  /** Tabs, driving the run's `PageTracker`. Always present: a run without
   *  page tracking gets an API whose every method throws, because a
   *  `switchTo` that quietly did nothing would leave the following steps on
   *  the wrong tab with everything green. */
  tabs: CodeBehindTabApi;
  /** Browsers, driving the run's `BrowserTracker`. Same always-present,
   *  never-silent contract as `tabs`. */
  browsers: CodeBehindBrowserApi;
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
  /** The step's code: what it does, in place of the model's turns. */
  run?: (ctx: CodeBehindContext) => Promise<void> | void;
  /**
   * A CONDITION's code: whether the condition, as written, holds on the page
   * now (stories/codebehind-loops-and-conditions.md, decision 4). The code
   * form of the question the condition judge is asked, so a compiled `If`,
   * `Else if`, `While` or `Repeat … until` decides with no model call.
   *
   * - `If` / `Else if` — true runs this member's tail (first true wins).
   * - `While` — true runs another pass.
   * - `Repeat X until C` — whether C holds, exactly as written: true STOPS
   *   the loop.
   *
   * Read the page, never act on it: no click, fill, press or navigation. Do
   * not wait for the state to arrive either — the framework has already
   * waited for the page to settle, so an absent element is an answer (check
   * `count()` before a call that would wait for its element). Anything other
   * than `true` or `false` returned is broken code, handled like a `run` that
   * throws: the model decides the guard and the line is flagged stale.
   * `step.expect` / `step.fail` fail the guard for real; `step.exit()` is
   * refused.
   *
   * An entry has `run` or `condition`, never both — the loader warns and
   * drops one that has both. `Otherwise` and `For each` lines get neither:
   * one has no condition, the other reads a list and never asks a model.
   */
  condition?: (ctx: CodeBehindContext) => boolean | Promise<boolean>;
}

/**
 * Author entry point for a `.steps.ts` file — an identity function providing
 * types, exactly like `defineTool`.
 *
 * ```ts
 * import { defineSteps } from 'steptix/codebehind';
 *
 * export default defineSteps([
 *   {
 *     source: 'Enter the username {{username}}',
 *     async run({ page, step }) {
 *       await page.locator('#login_field').fill(step.getVar('username')!);
 *     },
 *   },
 *   // A condition line — `While`, `Repeat … until`, `If`, `Else if` — gets a
 *   // `condition` that answers true or false, read-only:
 *   {
 *     source: 'While the Next button is enabled, Go to the next page',
 *     async condition({ page }) {
 *       const next = page.getByRole('button', { name: 'Next' });
 *       return (await next.count()) > 0 && (await next.isEnabled());
 *     },
 *   },
 * ]);
 * ```
 */
export function defineSteps(entries: StepCodeEntry[]): StepCodeEntry[] {
  return entries;
}
