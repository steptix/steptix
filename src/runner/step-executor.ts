import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Config } from '../config/types.js';
import type { AIAction, BranchedAIResponse } from '../ai/types.js';
import type { StepResult, SubActionResult, AiInteraction, TurnResult, ApiCallData } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import {
  buildSystemPrompt,
  buildStepMessage,
  buildClarificationMessage,
  buildContinuationMessage,
  buildAssertionCodePrompt,
  buildRetryContext,
  buildBranchedStepMessage,
  buildConditionJudgeMessage,
  formatTestInfo,
} from '../ai/prompts.js';
import type { PriorFailureContext, RetryDiagnostics, ApiPromptContext, BranchOutcome, ScrollPositionInfo } from '../ai/prompts.js';
import { diagnosePageState, waitForPageStability, waitForPostActionSettle, capturePageSignal, PageActivityTracker } from '../browser/page-state.js';
import type { PageStateDiagnosis } from '../browser/page-state.js';
import type { ChatMessage } from '../ai/types.js';
import { parseAIResponse, parseAssertionCode, parseBranchedResponse } from '../ai/action-parser.js';
import { captureDomSnapshot, findInDom, expandDomSubtree, formatFindResults, formatExpandResult } from '../browser/dom-cleaner.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { executeAction } from '../browser/actions.js';
import type { UploadPathContext } from '../browser/upload-paths.js';
import { launchBrowser, type PageTracker, type BrowserTracker, type LaunchOverrides } from '../browser/manager.js';
import { withRetry } from './retry.js';
import { runInteractiveRepl } from './interactive-repl.js';
import type { InteractiveReader } from './interactive-repl.js';
import { logger, traceOp } from '../utils/logger.js';
import { callApiStandalone, callApiBrowserContext } from '../api/client.js';
import { extractCsrfToken } from '../api/csrf-handler.js';
import type { ApiResponseStore } from '../api/response-store.js';
import type { StepCache, CachedStepData, StepCacheKey } from '../cache/step-cache.js';
import { fingerprintAssertion } from '../cache/step-cache.js';
import type { StepValues } from '../ai/prompts.js';
import {
  checkTurnReferences,
  inlineStoreAsNames,
  substituteAction,
  substituteText,
  type PlaceholderValues,
} from './placeholder-substitution.js';
import { referencedVariableNames } from '../skills/expander.js';
import {
  isReturnClaim,
  parseFlowControlStep,
  type ParsedFlowControlStep,
} from '../parser/flow-control-step.js';
import {
  parseFailureTail,
  stripFailureTail,
  type ParsedFailureTail,
} from '../parser/failure-tail.js';
import { envDataRefsIn, resolveEnvDataRef } from '../parser/interpolate-env-data.js';
import { parseOutputPrefixes, buildEnrichedInstruction } from '../server/run-helpers.js';
import { redact, runSecrets } from '../utils/secrets.js';
import type { CodeBehindBinding } from '../codebehind/loader.js';
import { entrySourceText, runCodeBehindEntry, EXIT_NOT_CLAIMED } from '../codebehind/execute.js';
import { makeBrowserApi, makeTabApi } from '../codebehind/tabs.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import type { StepGroup } from './step-grouper.js';
import type { AssertionResult } from '../report/types.js';

/**
 * Actions that may mutate the page and therefore warrant a post-action settle
 * to let the SPA/legacy app react before we snapshot for the next turn.
 * Observational / control-flow actions are excluded — they don't trigger
 * page changes so a settle is pure overhead.
 */
const MUTATING_ACTIONS: ReadonlySet<AIAction['action']> = new Set([
  'click',
  'type',
  'select',
  'navigate',
  'upload',
  'hover',
  'keyboard',
  'keypress',
  'dismiss',
  'scroll',
  'wait',
]);

function isMutatingAction(action: AIAction): boolean {
  return MUTATING_ACTIONS.has(action.action);
}

/** Mutable ref for capturing all AI turns for cache writing. */
export interface CacheCapture {
  turns: CachedStepData[];
}

/**
 * What a step whose entry broke says on a keyless run
 * (stories/keyless-replay-and-gateway-env.md §Part B).
 *
 * Written for the person reading a red step on a corporate laptop: the entry
 * ran and failed, nothing tried to repair it, and the repair happens on a
 * machine that has a model. It deliberately does not mention API keys — the
 * reader here did not break their config, and the app most likely changed.
 */
export const KEYLESS_HEAL_SKIPPED_ERROR =
  'replay failed and was not healed: AI is not configured on this machine. ' +
  'Recompile or repair this step where AI is available.';

/**
 * The same step on a run that forbids AI by policy
 * (stories/run-settings.md §9).
 *
 * A separate string because {@link KEYLESS_HEAL_SKIPPED_ERROR}'s claim — "AI is
 * not configured on this machine" — is simply untrue here: a key is present and
 * the run was asked to spend nothing. Telling this reader to go find a machine
 * with a model would send them to fix something that is not broken, and it
 * would erase the very distinction the run's echo has to keep.
 *
 * Both settings are named, the way `AI_FORBIDDEN_BY_POLICY_MESSAGE`
 * (src/ai/client.ts) already names both.
 * `runSettings.ai` was once the only way to arrive here, because the
 * switch was server-path-only; the CLI and the Runner UI honour
 * `ai.allowInRuns` now (stories/bedrock-provider.md §"The CLI keyless gap") and
 * neither of them resolves run settings at all. A reader sent to look for
 * `runSettings.ai: off` on those paths would find nothing to turn back on.
 */
export const POLICY_HEAL_SKIPPED_ERROR =
  'replay failed and was not healed: this run forbids AI ' +
  '(runSettings.ai: off, or ai.allowInRuns: false in aiui.config.json). ' +
  'Repair this step, or run again with AI allowed.';

export interface StepExecutorOptions {
  page: Page;
  config: Config;
  aiClient: AiClient;
  contextContent: string;
  testName: string;
  baseUrl?: string;
  conversationHistory: string[];
  apiResponseStore?: ApiResponseStore;
  /** CSRF tokens accumulated across steps — keyed by selector, with '__latest__' for the most recent */
  csrfTokens: Record<string, string>;
  /** Live parameter map — read actions write captured values here for use in later steps */
  resolvedParameters?: Record<string, string>;
  /** Tracks all open pages (popups, tabs) — enables switchPage actions */
  pageTracker?: PageTracker;
  /** Tracks all opened browser sessions — enables openBrowser/switchBrowser/
   *  closeBrowser actions. When undefined, only the single browser passed via
   *  `page`/`pageTracker` is in play (back-compat with single-browser tests). */
  browserTracker?: BrowserTracker;
  /** Pre-initialized step cache — always present; action caching gated by cacheEnabled */
  stepCache?: StepCache;
  /** When true, step action responses are read from / written to the step cache */
  cacheEnabled?: boolean;
  /** On-disk cache identity for this step's files (`step-<cacheKey>.json`). The
   *  server passes a frame-scoped key (`f1-17`) so skill-body steps and repeated
   *  invocations don't collide on a shared source line (issue 016). When absent
   *  (CLI path), the cache falls back to `stepIndex` — the legacy behaviour. */
  cacheKey?: StepCacheKey;
  /** When true, include dismissal-related guidance in the system prompt and
   *  retry hints. Enabled by the runner when the test has hooks configured. */
  dismissalGuidance?: boolean;
  /** Full ordered step list for the test. Forwarded to the AI clarification
   *  REPL so its `/list` and `/resume` menus can drive the outer step loop.
   *  Optional — when absent, the REPL still works but `/resume` only allows
   *  the immediate-next-step default. */
  testSteps?: string[];
  /** When true, there is no interactive console attached to this run (e.g.
   *  it's driven by the Sessions API server, not the CLI). The AI
   *  clarification prompt reads its answer from `process.stdin` via
   *  `readline`; with no console that blocks forever and hangs the run. In
   *  this mode a clarification request fails the step fast instead, with the
   *  AI's question surfaced as the error so the client can show it. See
   *  issues/014. */
  nonInteractive?: boolean;
  /** Run abort signal (client "stop"). Threaded into every AI call so an
   *  in-flight request cancels immediately, checked at the top of each turn so a
   *  stopped step stops spawning turns, and consulted in the catch so an aborted
   *  step reports as aborted (not a spurious failure). See issues/020. */
  signal?: AbortSignal;
  /**
   * This step's code-behind binding, resolved at test load
   * (stories/step-codebehind.md). When it carries an entry, the entry runs in
   * place of the AI; when it doesn't, it names where a generated entry would
   * go. Mutable: a failing entry is discarded here for the rest of the run.
   */
  codeBehind?: CodeBehindBinding;
  /**
   * The run's env/data context — what `${data.url}` in the step text was
   * resolved against. A code-behind entry reads the same references through
   * `step.getVar('data.url')` (stories/codebehind-env-data.md). Absent when
   * the run has no environment.
   */
  envData?: EnvDataContext;
  /**
   * Names and `${…}` refs this test has declared are NOT secrets, from
   * `## Config: unmask: keyword, data.keys.public`
   * (stories/placeholder-preserving-actions.md, decision 2).
   *
   * `isSecretName` is `/password|secret|token|key/i`, so it matches `keyword`,
   * `monkey` and `secretary`. Masking those in the `## Values` block costs the
   * model its eyes and not just its logs — a `keyword` column it has to find in
   * the DOM would arrive as `***`. This is the per-test way out, matched
   * against the exact name (`keyword`) or the exact ref (`data.keys.public`).
   */
  unmask?: ReadonlySet<string>;
  /**
   * Strict code-behind: an entry that throws **fails the step** instead of
   * falling through to AI (stories/codebehind-compile.md, "Replay").
   *
   * Only compile's replay sets this. A replay exists to prove the candidate
   * runs as pure code, and a silent heal would make a red compile look green.
   */
  codeBehindStrict?: boolean;
  /**
   * This run has no AI key at all, so a broken entry **fails the step**
   * instead of falling through to AI
   * (stories/keyless-replay-and-gateway-env.md §Part B).
   *
   * A proactive skip, not a caught crash: healing would build a request, log
   * a POST line and come back with `AiNotConfiguredError`, and the report
   * would read as a broken config rather than "this machine has no AI to
   * repair the step with".
   *
   * Passed in rather than read off `opts.config.ai` because the two disagree
   * on the server path: `executeStep` is handed the server's startup config
   * with only run settings re-sourced, while the key a client's `.env`
   * shipped lives in `applyEnvToAiConfig`'s result. Absent means "not
   * keyless" — every caller that doesn't know stays on today's behaviour.
   */
  keyless?: boolean;
  /**
   * Which kind of keyless this is, and therefore which explanation the skipped
   * step carries (stories/run-settings.md §9). Only read when {@link keyless}
   * is set; `'no-key'` is the default and the behaviour every existing caller
   * keeps.
   */
  keylessReason?: 'no-key' | 'policy';
  /**
   * Code-behind step-into (stories/codebehind-debugging.md): hit a
   * `debugger;` immediately before this step's entry `run()`. The session
   * manager sets it only after emitting `codebehind:awaiting-debugger` and
   * receiving the client's debugger-attach ack, so by the time the entry
   * runs an inspector is listening. No-op without one.
   */
  codeBehindPauseBeforeRun?: boolean;
  /**
   * Capture the DOM + URL either side of the step onto `StepResult.stepContext`
   * — compile's Record phase input. Off for ordinary runs: it costs one extra
   * DOM snapshot per step and nothing else reads it.
   */
  captureStepContext?: boolean;
  /**
   * Where a file named in an `upload` step lives: the test file's folder, and
   * the project root that fences it (stories/upload-action.md §3). Every
   * producer of these options has both to hand — the CLI from `test.filePath`,
   * the Sessions API from the request's `testFilePath` and its project bundle.
   * Absent on a run with no test file, where only absolute paths resolve.
   */
  uploadPaths?: UploadPathContext;
  /**
   * This step's text claims the `If … then return` / `… then stop` form —
   * `parseFlowControlStep(<authored line>)`, computed by the run loop
   * (stories/step-flow-control.md, decision 2).
   *
   * It is the ONLY thing that lets a `return` action through. Set, a `return`
   * ends the step passed with `flowControl` on the result and the loop skips
   * the rest of the flow; absent, the sub-action fails with
   * {@link RETURN_NOT_CLAIMED} and the model is told why on its next attempt.
   * Without that guard a model could end a run early from any line, and the
   * report would be green for work not done.
   *
   * Only the CONDITIONAL form ever reaches here: the unconditional `Return` /
   * `Stop` is dispatched by the loop with no model call at all (decision 3).
   * A claim carrying a `body` also turns on the settle gate below.
   *
   * `| undefined` explicitly (`exactOptionalPropertyTypes` is on) so a caller
   * forwarding someone else's options can CLEAR it — `{ ...opts,
   * flowControlClaim: undefined }` — rather than having to rebuild the object
   * to leave the key out. Every such site is a step that is not the claiming
   * step, and the clear is the whole guard for it.
   */
  flowControlClaim?: ParsedFlowControlStep | undefined;
  /**
   * This step's text carries an `… otherwise fail with message "…"` /
   * `… otherwise continue` tail — `parseFailureTail(<authored line>)`, computed
   * by the run loop (stories/step-failure-outcomes.md, decision 4).
   *
   * Unlike {@link flowControlClaim} this is NOT a permission: it gates nothing
   * the model may do and changes nothing about turns, caching or attempts. It is
   * read at exactly one seam — {@link applyFailureTail}, over a step that has
   * finally FAILED — and decides what that failure is called (`fail` with a
   * message) or whether the run carries on past it (`continue`).
   *
   * Its OUTCOME is the author's and travels from here; its MESSAGE is only the
   * fallback, because the authored line still holds the author's `{{name}}`
   * tokens — see {@link resolvedTailMessage}.
   *
   * The tail is hidden from the model regardless of this field: the prompt texts
   * are stripped by {@link stripFailureTail} off the line itself.
   *
   * `| undefined` explicitly, and cleared at every site that clears
   * {@link flowControlClaim}: both are facts about ONE authored line, and a step
   * that is not that line must not inherit either.
   */
  failureTail?: ParsedFailureTail | undefined;
}

/**
 * What a `return` action is refused with on a step that did not ask for one
 * (stories/step-flow-control.md, decision 2).
 *
 * Retryable on purpose: it comes back to the model as prior-failure context,
 * which is how it learns the rule mid-step rather than after the run.
 */
export const RETURN_NOT_CLAIMED =
  'this step does not say to return — only a step written as ' +
  '"If <condition> then return" (or "… then stop"), or a step that is just ' +
  '"Return"/"Stop", may end the flow. Do what this step asks instead.';

/**
 * What a `fail` action is refused with on a step that did not ask for one
 * (stories/step-failure-outcomes.md, decision 1). The shape of
 * {@link RETURN_NOT_CLAIMED}, and retryable for the same reason: the model reads
 * it back as prior-failure context and learns the rule inside the step.
 *
 * A step claiming `return` / `stop` is refused by this too — the two verbs are
 * opposite outcomes, so a model allowed to swap them could paint a deliberate
 * failure green, or fail a run the author only asked to leave early.
 */
export const FAIL_NOT_CLAIMED =
  'this step does not say to fail — only a step written as ' +
  '"If <condition> then fail the test with error \'…\'", or a step that is ' +
  'just "Fail the test with error \'…\'", may fail the run on purpose. Do what ' +
  'this step asks instead.';

/** Extract text-only content from a ChatMessage (strips base64 image blocks) */
function extractTextFromMessage(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Error subclass that carries failure context for retry enrichment */
class StepFailureError extends Error {
  failures: PriorFailureContext[];
  turns: TurnResult[];
  /** `false` when re-running cannot change the outcome — see `withRetry`. */
  retryable: boolean;
  /**
   * Set when the step's own text asked for this failure — the `fail` verb
   * (stories/step-failure-outcomes.md, decision 2). The marker the outer catch in
   * `executeStep` reads to turn an ordinary red step into `deliberate: true` with
   * an explanation written in terms of the condition. `why` is the model's
   * ALREADY-MASKED account of why the condition held: the seam that composes the
   * error is the one place the run's secrets are applied (decision 3).
   */
  deliberate?: { why: string };
  constructor(
    message: string,
    failures: PriorFailureContext[],
    turns: TurnResult[] = [],
    retryable = true,
    deliberate?: { why: string },
  ) {
    super(message);
    this.name = 'StepFailureError';
    this.failures = failures;
    this.turns = turns;
    this.retryable = retryable;
    if (deliberate) this.deliberate = deliberate;
  }
}


/**
 * Whether **this page** belongs to a browser with a window a human can watch.
 *
 * Asked of the page rather than of the run, because `openBrowser` can override
 * `headed` per browser: one run can hold a headed browser and a headless one at
 * the same time, and "should this window be raised" is a question about the
 * window, not about the run.
 *
 * **Identified by context, and that is the point.** An earlier version read
 * `browserTracker.getActive()`, which is a *different browser* from the one
 * whose tab is being raised: `switchPage` and `openPage` resolve through
 * `opts.pageTracker` — the tracker the step executor was handed — while
 * `add()` auto-promotes the active pointer to whatever `openBrowser` opened
 * last. So a headed run that opened a headless worker browser and then ran
 * `switchTab` consulted the worker, concluded headless, and left the tab
 * unraised on the browser the human was actually watching. A page belongs to
 * exactly one `BrowserContext`, so comparing contexts asks about the right
 * browser however the pointers happen to sit.
 *
 * Falls back to the shared config for the single-browser paths (and the tests)
 * that synthesize a session without going through `launchBrowser`, and for the
 * case where nothing tracked owns this page.
 */
function isPageHeaded(page: Page, opts: StepExecutorOptions): boolean {
  try {
    const context = page.context();
    for (const session of opts.browserTracker?.all() ?? []) {
      if (session.context === context && session.headed !== undefined) return session.headed;
    }
  } catch {
    // `page.context()` throws on a closed page, and `all()` is absent on the
    // hand-built trackers older tests pass. The config is the right answer
    // then, not a crash inside a focus call.
  }
  return opts.config.browser.headed;
}

/**
 * Bring the tab the automation just moved to onto the screen
 * (stories/cdp-tab-focus.md §4).
 *
 * `switchToAsync` moves the tracker's index and returns the Page; nothing
 * raises it. In a headed run that means a `switchTab` step moves the
 * automation *behind* the tab the user is looking at, and the visible tab
 * stops changing while the run continues.
 *
 * **Gated on headed, in both browser modes** — not headed-CDP-only. `headed`
 * defaults to true, a launch-mode run's pages open as tabs in one visible
 * window, and a human watching that has the identical complaint. Headless is
 * the only place the call is pointless, and the only thing it is gated
 * against.
 *
 * Lives here rather than inside `switchToAsync` for layering: `PageTracker`'s
 * constructor takes `(page, ignoredPages)` and knows nothing about headedness
 * or CDP, while the step executor already holds the config and can reach the
 * browsers.
 *
 * Non-fatal, like every other `bringToFront` in the codebase: an OS that
 * declines to raise a window must not fail a step that otherwise worked.
 */
async function showTab(page: Page, opts: StepExecutorOptions): Promise<void> {
  if (!isPageHeaded(page, opts)) return;
  try {
    await page.bringToFront();
  } catch {
    /* non-fatal */
  }
}

/**
 * Snapshot the current state of the browser tracker into the shape
 * `formatTestInfo` consumes. Returns undefined when single-browser mode is
 * in play (no tracker, or only one session) so the prompt's browser block
 * stays empty for those tests.
 */
function buildActiveBrowserInfo(tracker: BrowserTracker | undefined) {
  if (!tracker || tracker.count <= 1) return undefined;
  const list = tracker.list();
  const active = list.find((b) => b.isActive);
  if (!active) return undefined;
  const others = list.filter((b) => !b.isActive).map((b) => ({
    label: b.label,
    engine: b.engine,
    ...(b.channel !== undefined && { channel: b.channel }),
  }));
  return {
    label: active.label,
    engine: active.engine,
    ...(active.channel !== undefined && { channel: active.channel }),
    others,
  };
}

/**
 * Read the document scroller's geometry, for the scroll-position line in the
 * step/continuation messages.
 *
 * Non-fatal by the same policy as screenshot capture: a page mid-navigation (or
 * one that has gone away) yields `undefined`, and the message simply carries no
 * position line that turn rather than the step failing over it.
 */
async function captureScrollPosition(page: Page): Promise<ScrollPositionInfo | undefined> {
  try {
    return await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      const el = doc.scrollingElement ?? doc.documentElement;
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      };
    }) as ScrollPositionInfo;
  } catch (err) {
    logger.debug(`Scroll position capture failed: ${String(err)}`);
    return undefined;
  }
}

/** Determine if a step instruction is asking to extract, read, or capture values from the page.
 * When true, a richer "readable" DOM snapshot is sent that preserves visible text content
 * (table cells, paragraphs, spans, etc.) instead of the compact action-oriented DOM.
 *
 * Detection heuristics:
 *  1. Explicit variable storage patterns: [store as: ...], store/save as {{...}}
 *  2. Extraction verbs at start: get, capture, read, extract, note, record, etc.
 *  3. Question patterns: "what is the", "how many", "what are the"
 */
export function isExtractionStep(instruction: string): boolean {
  const lower = instruction.toLowerCase();

  // Explicit variable storage patterns (anywhere in instruction)
  if (/\[store as:/.test(lower)) return true;
  if (/store\s+(it\s+)?as\s+\{\{/.test(lower)) return true;
  if (/save\s+(it\s+)?as\s+\{\{/.test(lower)) return true;

  // Strip leading [prefix] markers to check intent verbs
  const stripped = instruction.replace(/^\[.*?\]\s*/i, '').toLowerCase();

  // Extraction verbs at start of the instruction
  if (/^(get|capture|read|extract|note|record|store|save|retrieve|collect|grab|copy|take note|what is|what are|how many)/.test(stripped)) {
    return true;
  }

  return false;
}

/**
 * The action cache, minus the one step it must never touch.
 *
 * A flow-control step's whole job is to JUDGE a condition against the live page
 * (stories/step-flow-control.md, decision 2): the model answers `return` when
 * it holds and `noop` when it does not. The cache replays turn 1 verbatim, so a
 * cached `return` is a decision taken against a page that is no longer there —
 * run 1 signs in and the condition holds, run 2 lands on a different page and
 * the cache HITs anyway, with no model call and no page read. The rest of the
 * flow is skipped and the run reports green for work nobody did, which is the
 * failure direction this codebase treats as worst.
 *
 * Read AND write, at one seam so all four loops are covered: withholding the
 * read alone would leave run 1 writing an entry that a later run with the
 * feature disabled would replay. `cacheEnabledForRun` in test-runner.ts and the
 * server's equivalent already exempt data rows for the neighbouring reason;
 * this is the same exemption, taken where the claim is known.
 *
 * A FUNCTION rather than a local const because "one seam" has to mean it: the
 * assertion cache is read and written from `executeStepAttempt`, a different
 * module-level function, and it spent this feature's first round consulting
 * `opts.cacheEnabled` directly — so a flow-control step whose model emitted an
 * `assert` sub-action still cached a judgement about a live page, under a
 * comment saying it could not.
 */
function cacheEnabledFor(opts: StepExecutorOptions): boolean {
  return opts.cacheEnabled === true && opts.flowControlClaim === undefined;
}

/**
 * The tail's message with its `{{name}}` and `${env.X}` tokens RESOLVED
 * (decision 3), or undefined when the tail named none.
 *
 * The tail was parsed off the AUTHORED line, because a tail — like a flow-control
 * claim — has to be the same answer on every run and in every runner. So
 * `opts.failureTail.message` still holds the author's tokens, and a warning
 * written `Missing {{name}}` would reach the row, the hover, the MCP tally and
 * the run log with the braces in it.
 *
 * `result.instruction` IS the interpolated line on every path through the one
 * seam below — the AI flow's outer catch, the cached-fatal throw it shares, the
 * code-behind replay, and the unanswerable-clarification return — enrichment
 * included, since the grammar already holds a trailing run of markers back. So
 * the resolved message is in that text and reading the same grammar off it is
 * how to get it out: one parser read twice, exactly as `deliberateFailError`
 * (src/runner/flow-control.ts) does it for the `fail` verb.
 *
 * `outcome` is compared as well as the parse, so a value that changed which
 * branch the line takes cannot put one tail's message on the other's seam. The
 * fallback to the authored text is reachable: a value carrying the quote
 * character that ENDS the message leaves a line the `$`-anchored grammar no
 * longer matches, and then the author's words are better than none.
 */
function resolvedTailMessage(
  result: StepResult,
  tail: ParsedFailureTail,
): string | undefined {
  const reparsed = parseFailureTail(result.instruction);
  const resolved = reparsed?.outcome === tail.outcome ? reparsed.message : undefined;
  return resolved ?? tail.message;
}

/**
 * The `otherwise …` tail, applied to a step that has finally failed
 * (stories/step-failure-outcomes.md, decisions 5 and 6).
 *
 * ONE seam, deliberately: every failed `StepResult` leaving `executeStep` passes
 * through here — the AI flow's outer catch, the cached-fatal path it shares, and
 * the code-behind path, whose replay failure has to be renamed and tolerated
 * exactly as the AI one is. A forgotten `tolerated` is a run that stops when the
 * author said to carry on.
 *
 * What it does NOT touch, and why:
 *
 * - a PASSED step. The tail describes a failure; there isn't one.
 * - an INTERRUPTED one. The user ended the run, and painting their Stop as "the
 *   run continued past this step" would be a lie in both directions.
 * - the ERROR of a `continue` tail. It stays the framework's: the row still has
 *   to say what went wrong, and the author's warning explains why nobody
 *   stopped rather than replacing the diagnosis.
 * - a message-less `otherwise fail`. Legal, and it changes nothing.
 *
 * The original failure is never lost: a renamed one keeps it in the explanation,
 * and the log line at failure time printed it before this ran (decision 5).
 */
function applyFailureTail(result: StepResult, opts: StepExecutorOptions): StepResult {
  const tail = opts.failureTail;
  if (!tail) return result;
  if (result.status !== 'failed' || result.interrupted) return result;

  const original = result.error ?? 'the step failed';
  // Interpolated, not authored — see {@link resolvedTailMessage}. Read once for
  // both outcomes so neither branch can be the one that forgets.
  const message = resolvedTailMessage(result, tail);

  if (tail.outcome === 'fail') {
    if (!message) return result;
    return {
      ...result,
      // The author's words, masked here because this is where they first become
      // the thing the wire, the report and the log carry (decision 3) — which is
      // why resolution happens BEFORE the redact: a `{{password}}` still in
      // braces would be masked as the token, not as the secret it resolves to.
      error: redact(message, secretsFor(opts)),
      aiExplanation: `Failed as the step says. What failed: ${original}`,
    };
  }

  const warning = message ? redact(message, secretsFor(opts)) : undefined;
  return {
    ...result,
    tolerated: true,
    // Structural as well as folded into the explanation, for the reason the
    // docblock on `StepResult.warning` gives: the explanation does not travel on
    // the `step:fail` wire event and the warning has to — it is the first line of
    // the TestBench hover and the MCP row's reason.
    ...(warning !== undefined && { warning }),
    aiExplanation: warning
      ? `${warning}. The run continued past this step (otherwise continue). What failed: ${original}`
      : `The run continued past this step (otherwise continue). What failed: ${original}`,
  };
}

/**
 * Execute a single test step with retry logic.
 * Returns a StepResult regardless of pass/fail.
 *
 * `instruction` is the SUBSTITUTED text — what the report's instruction line,
 * the console line, the run log and the cache key are built from, and what
 * every text-reading heuristic here (`isExtractionStep`, the `[output:]` parse)
 * has always seen.
 *
 * `authoredInstruction` is the same step with its `{{name}}` and `${…}` tokens
 * INTACT — what the model is shown, beside a `## Values` block saying what each
 * one holds (stories/placeholder-preserving-actions.md, decision 1). It
 * defaults to `instruction`, which is right for a caller that has no separate
 * authored form: the interactive REPL's user-typed line, and a `[skill:]`
 * argument the expander already baked in (phase 2).
 */
export async function executeStep(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: StepExecutorOptions,
  authoredInstruction?: string,
): Promise<StepResult> {
  const startTime = Date.now();
  let retried = false;
  let priorFailures: PriorFailureContext[] = [];
  /** A cached replay that failed for a reason re-planning cannot fix. Thrown
   *  from the first attempt so the shared failure handler builds the result. */
  let cachedFatal: StepFailureError | undefined;
  let priorAttemptTurns: TurnResult[] = [];
  /**
   * The failure whose turns `onFailure` has already merged.
   *
   * `withRetry` hands the FINAL attempt to `onFailure` as well when it declines
   * to retry — every deliberate `fail` (stories/step-failure-outcomes.md,
   * decision 2), every cached upload whose file is missing — and the catch below
   * would then add that attempt's turns a second time, rendering one turn twice
   * in the report. A retryable failure that exhausts its attempts does NOT come
   * through `onFailure`, so the catch is still where those turns arrive.
   */
  let mergedFailure: unknown;
  // Cache files are named by the frame-scoped key when the server supplies one
  // (skill-body steps, repeated invocations); otherwise by stepIndex (CLI path).
  const cacheKey: StepCacheKey = opts.cacheKey ?? stepIndex;

  // --- Code-behind attempt (ahead of the cache) ---
  //
  // Order matters and is the story's: a step with an entry runs as code with
  // no model call, no DOM snapshot and no stall detection — the same bypasses
  // a cache hit gets — and it neither reads nor writes the action cache.
  const binding = opts.codeBehind;
  /** Set when an entry threw and was discarded — the step then heals under AI
   *  and the result is flagged for the next compile. */
  let staleAfterHeal: StepResult['codeBehindStale'] | undefined;
  if (binding?.entry && binding.entry.ai !== true) {
    const codeResult = await runCodeBehindStep(stepIndex, instruction, binding, opts, startTime);
    // The tail applies to a replay failure exactly as to an AI one (decision 5).
    // Applied at the CALL rather than inside, so all six of that function's
    // failing branches are covered by one line.
    if (codeResult.result) return applyFailureTail(codeResult.result, opts);
    staleAfterHeal = codeResult.stale;
    // Fell through: the entry threw and has been discarded for this run. The
    // page is already in the right state, so the AI flow below starts clean —
    // exactly the contract the cache's invalidate-and-fall-through has.
  }
  /** Attach the stale flag to whatever the AI flow produces. Runs no longer
   *  rewrite the file (stories/codebehind-compile.md), so this flag is the only
   *  record that the committed code stopped working. */
  const withStale = (result: StepResult): StepResult =>
    staleAfterHeal ? { ...result, codeBehindStale: staleAfterHeal } : result;

  const cacheEnabled = cacheEnabledFor(opts);

  // --- Cache attempt (before normal AI flow) ---
  if (opts.stepCache && cacheEnabled) {
    const cached = await opts.stepCache.read(cacheKey, opts.resolvedParameters ?? {});
    if (cached) {
      logger.info(`Cache HIT for step ${stepIndex} — replaying ${cached.length} cached turn(s)`);
      try {
        const result = await executeStepAttempt(
          stepIndex,
          totalSteps,
          instruction,
          opts,
          startTime,
          false,
          [],
          1,
          cached,
          undefined,
          authoredInstruction,
        );
        logger.success(`Step ${stepIndex} passed (from cache)`);
        // Mark the result so the server's RunEvent emitter can attach
        // `fromCache: true` to the step:pass wire event. Without this,
        // every cache-hit step would look identical to an AI-run step on
        // the client side — and the ⚡ glyph / `(cached)` log marker
        // wouldn't render.
        return withStale({ ...result, fromCache: true });
      } catch (err) {
        if (err instanceof StepFailureError && !err.retryable) {
          // The cached plan is fine — the file it names is missing. Invalidating
          // would discard a good entry, and re-running under AI would spend a
          // turn on a failure no re-planning can fix. Fail the step instead,
          // through the shared handler below so it still gets a screenshot and
          // a proper StepResult.
          cachedFatal = err;
        } else {
          logger.warn(`Cached actions failed for step ${stepIndex} — invalidating and falling through to AI`);
          await opts.stepCache.invalidateStep(cacheKey);
          // Do NOT propagate failure context — give AI a clean slate
        }
      }
    } else {
      logger.debug(`Cache MISS for step ${stepIndex}`);
    }
  }

  // --- Normal AI flow (with cache-write on success) ---
  const cacheCapture: CacheCapture = { turns: [] };

  /** Attempts actually made — NOT what `execution.retries` allows. A
   *  non-retryable failure ends after the first, and reporting the allowance
   *  told the reader the step was tried twice on exactly the case that exists
   *  to make sure it is tried once. */
  let attemptsMade = 0;
  const attempt = async (attemptNumber: number): Promise<StepResult> => {
    if (cachedFatal) throw cachedFatal;
    attemptsMade = attemptNumber;
    if (attemptNumber === 2) retried = true;

    return executeStepAttempt(
      stepIndex,
      totalSteps,
      instruction,
      opts,
      startTime,
      retried,
      priorFailures,
      attemptNumber,
      undefined,
      cacheCapture,
      authoredInstruction,
    );
  };

  try {
    const result = await withRetry(attempt, {
      maxRetries: opts.config.execution.retries,
      label: `step ${stepIndex}`,
      ...(opts.signal && { signal: opts.signal }),
      onFailure: (err) => {
        // Collect failure context and turns from the attempt for the next retry
        if (err instanceof StepFailureError) {
          priorFailures = [...priorFailures, ...err.failures];
          priorAttemptTurns = [...priorAttemptTurns, ...err.turns];
          mergedFailure = err;
        }
      },
    });

    // Write all turns to cache on success (non-assertion steps only)
    if (opts.stepCache && cacheEnabled && cacheCapture.turns.length > 0) {
      await opts.stepCache.write(
        cacheKey,
        cacheCapture.turns,
        opts.resolvedParameters ?? {},
      );
    }

    // No generation hook here any more. Generation is `aiui compile` — a
    // deliberate act with whole-test context, a review pass and replay-to-green
    // — so a run never rewrites a file under the author
    // (stories/codebehind-compile.md, "The runtime stops generating").

    // If a prior attempt failed, merge its turns into the successful result
    // so the report shows all attempts, not just the one that succeeded
    if (priorAttemptTurns.length > 0) {
      return withStale({
        ...result,
        turns: [...priorAttemptTurns, ...result.turns],
      });
    }
    return withStale(result);
  } catch (err) {
    // All attempts failed
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Aborted (client "stop") — not a real failure. Don't log it as a failure
    // or snap a failure screenshot (the page may already be closing); the run
    // loop detects `signal.aborted` after this returns and records the run as
    // aborted, bypassing the step:fail path. See issues/020.
    // Deliberately NOT `withStale`: a step the user pressed Stop on made no
    // claim about its entry. Flagging it stale would put it in the last-run
    // sidecar for `--only-stale` and render the ⚠ block on a step that was
    // merely cancelled. (The server's abort path drops the flag anyway —
    // `recordInterruptedStep` rebuilds the row — so this is about the CLI
    // path and about not implying an invariant that isn't there.)
    if (opts.signal?.aborted) {
      return {
        index: stepIndex,
        instruction,
        status: 'failed',
        turns: priorAttemptTurns,
        durationMs,
        retried: true,
        pageUrl: opts.page.url(),
        error: 'Aborted by client',
        aiExplanation: 'Step aborted by client (run stopped).',
      };
    }

    logger.error(
      attemptsMade > 1
        ? `Step ${stepIndex} FAILED after retry: ${errorMessage}`
        : `Step ${stepIndex} FAILED: ${errorMessage}`,
    );

    // Capture failure screenshot (full-page for report visibility)
    let failureScreenshot: string | undefined;
    if (opts.config.execution.screenshotOnFailure) {
      const shot = await captureScreenshot(opts.page, opts.config.browser.fullPageScreenshots);
      failureScreenshot = shot?.base64;
    }

    // Collect turns from the final failed attempt too — unless `onFailure`
    // already took them, which it does for a failure `withRetry` declined to
    // retry. See `mergedFailure`.
    if (err instanceof StepFailureError && err !== mergedFailure) {
      priorAttemptTurns = [...priorAttemptTurns, ...err.turns];
    }

    // The step's own text asked for this failure (decision 2). `error` is already
    // the author's message, masked where it was composed; the flag changes what
    // the framework does ABOUT the failure — no retry (already spent: the throw
    // was non-retryable), and no `ai.diagnoseFailures` paragraph guessing at a
    // root cause the author wrote out in full.
    const deliberate = err instanceof StepFailureError ? err.deliberate : undefined;

    // `withStale` here too: when the AI attempt was only happening because the
    // step's entry threw, dropping the flag on failure would erase the
    // code-behind error entirely — the client would see the AI failure and
    // nothing about the crash that caused the fall-through.
    return applyFailureTail(withStale({
      index: stepIndex,
      instruction,
      status: 'failed',
      turns: priorAttemptTurns,
      durationMs,
      retried,
      ...(failureScreenshot !== undefined && { screenshotBase64: failureScreenshot }),
      pageUrl: opts.page.url(),
      error: errorMessage,
      ...(deliberate && { deliberate: true }),
      aiExplanation: deliberate
        ? deliberate.why
          ? `The step's condition held (${deliberate.why}) and the step says to fail the test.`
          : 'The step\'s condition held and the step says to fail the test.'
        : attemptsMade <= 1
          ? `Failed to execute step. Last error: ${errorMessage}`
          : `Failed to execute step after ${attemptsMade} attempts. Last error: ${errorMessage}`,
    }), opts);
  }
}

/** The tracker's active browser session, or undefined when there is no
 *  tracker (single-browser paths and the tests that synthesize a session). */
function tryGetActiveSession(
  opts: StepExecutorOptions,
): { browser: Browser; context: BrowserContext } | undefined {
  try {
    return opts.browserTracker?.getActive();
  } catch {
    // `getActive` throws once `closeBrowser` has left zero browsers tracked.
    return undefined;
  }
}

/**
 * Run a step's code-behind entry.
 *
 * Returns `{ result }` when the step is decided — passed, failed by a
 * `step.expect`, or failed outright under `codeBehindStrict` or on a keyless
 * run — and `{ stale }` when the entry threw and the step falls through to
 * AI, which discards the entry for the rest of the run and hands the step to
 * the AI flow with a clean slate.
 *
 * The `expect` distinction is the assertion code cache's rule, lifted: broken
 * code heals, a failed assertion fails. Two things suspend the healing half.
 * Strict mode, because compile's replay has to see broken code as a red step,
 * not a slow one. And a keyless run, because there is no AI to heal with —
 * an entry that passes still replays, so only the broken step is affected
 * (stories/keyless-replay-and-gateway-env.md §Part B).
 */
async function runCodeBehindStep(
  stepIndex: number,
  instruction: string,
  binding: CodeBehindBinding,
  opts: StepExecutorOptions,
  startTime: number,
): Promise<{ result?: StepResult; stale?: StepResult['codeBehindStale'] }> {
  const entry = binding.entry;
  if (!entry) return {};
  let page = opts.pageTracker ? opts.pageTracker.getActive() : opts.page;
  const code = entrySourceText(entry);
  // Ask the tracker for the browser when there is one: `context.browser()` is
  // null for a persistent context, which is what the CDP path can hand us.
  // The `!` is the same shape `executeToolStep`'s callers already rely on for
  // the tracker-less paths.
  const active = tryGetActiveSession(opts);

  // Tab and browser control, over the run's own trackers
  // (stories/codebehind-framework-actions.md). `showTab` is handed through as
  // the focus hook so a compiled switch raises the tab on screen exactly like
  // the `switchPage` action does — without it a headed run drives an
  // invisible tab while the wrong one is displayed.
  const tabs = opts.pageTracker
    ? makeTabApi(opts.pageTracker, { focus: (p) => showTab(p, opts) })
    : undefined;
  const browsers = opts.browserTracker
    ? makeBrowserApi(
        opts.browserTracker,
        // The run's own browser config, closed over: an entry chooses the
        // engine/channel/headedness the `openBrowser` action can, and nothing
        // else. No `videoDir`, matching that handler.
        (overrides) => launchBrowser(opts.config.browser, undefined, overrides),
        { focus: (p) => showTab(p, opts) },
      )
    : undefined;

  const outcome = await runCodeBehindEntry({
    binding,
    page,
    context: active?.context ?? page.context(),
    browser: active?.browser ?? page.context().browser()!,
    ...(tabs && { tabs }),
    ...(browsers && { browsers }),
    resolvedParameters: opts.resolvedParameters ?? {},
    ...(opts.envData && { envData: opts.envData }),
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
    ...(opts.codeBehindPauseBeforeRun && { pauseBeforeRun: true }),
    ...(opts.uploadPaths !== undefined && { uploadPaths: opts.uploadPaths }),
    // What lets this entry call `step.exit()` (stories/step-flow-control.md,
    // decision 11). The claim is the authored line's, computed by the run loop,
    // so a compiled return is legal exactly where the AI `return` action is.
    ...(opts.flowControlClaim !== undefined && { flowControlClaim: opts.flowControlClaim }),
    label: `codebehind:${stepIndex}`,
  });

  // The entry may have moved the active tab or browser (`ctx.tabs`,
  // `ctx.browsers`). Everything below has to describe where the step ENDED —
  // a screenshot and a `pageUrl` from the tab the step navigated away from
  // are worse than none, because they look right. Same order as the AI loop's
  // own refresh: the browser tracker is the outer one.
  if (opts.browserTracker) {
    try { page = opts.browserTracker.getActivePage(); }
    catch { /* closeBrowser left none — keep the last handle for the report */ }
  } else if (opts.pageTracker) {
    page = opts.pageTracker.getActive();
  }

  // A `step.filePath` that could not resolve is not broken code: the entry is
  // fine and the file is missing, so healing under AI would spend a turn and
  // throw away a working entry for nothing.
  //
  // A `step.exit()` is not broken code either, and it is covered twice over
  // (stories/step-flow-control.md, decision 11): a claimed exit comes back
  // `passed`, and an unclaimed one comes back `nonRetryable`. Neither can be
  // true here — which is the point. Every compiled return would otherwise heal
  // under AI and discard its entry on the first run that took the branch.
  const brokenCode =
    outcome.status === 'failed' && !outcome.expectationFailed && !outcome.nonRetryable;
  // Strict first: a compile replay that also happens to run keyless is still a
  // replay, and its own copy is the one that explains the red step.
  const healingDeclined = opts.codeBehindStrict || opts.keyless;
  if (brokenCode && !healingDeclined) {
    logger.warn(
      `Code-behind failed for step ${stepIndex} — falling through to AI: ${outcome.error ?? 'unknown error'}`,
    );
    binding.entry = undefined;
    return {
      stale: {
        file: binding.file,
        source: binding.source,
        error: outcome.error ?? 'unknown error',
      },
    };
  }

  // Same capture policy as any other step end: no DOM snapshot (nothing reads
  // it when no AI call is made), screenshot only when the user asked for
  // per-action captures or the step failed.
  const wantShot = opts.config.browser.captureScreenshotsPerAction !== false
    || outcome.status === 'failed';
  const shot = wantShot
    ? await captureScreenshot(page, opts.config.browser.fullPageScreenshots)
    : null;

  const base: StepResult = {
    index: stepIndex,
    instruction,
    status: outcome.status,
    turns: [],
    durationMs: Date.now() - startTime,
    retried: false,
    pageUrl: page.url(),
    ...(shot?.base64 !== undefined && { screenshotBase64: shot.base64 }),
    ...(Object.keys(outcome.outputs).length > 0 && { outputs: outcome.outputs }),
    fromCodeBehind: true,
    codeBehind: { file: binding.file, code, logs: outcome.logs },
  };

  if (outcome.status === 'passed') {
    // The entry ended the flow (stories/step-flow-control.md, decision 11).
    // The verb comes from the claim, not from the outcome: `return` and `stop`
    // are one meaning, and only the report echoes which the author wrote.
    //
    // The explanation is the bare DETAIL, exactly as the AI path leaves it —
    // the run loop prefixes it with the flow's name through
    // `flowControlExplanation`, because the executor holds no expansion and
    // cannot know whether this was "Sign in" or the whole test. So this reads
    // out as `Returned from "Sign in": via code-behind`.
    const claim = opts.flowControlClaim;
    // `isReturnClaim` and not a bare truth test: `flowControl` on the result means
    // "the flow ended as a PASS", and only `return` / `stop` mean that
    // (stories/step-failure-outcomes.md, decision 1). For a `fail` claim the guard
    // cannot fire at all — `step.exit()` refuses any non-return claim upstream
    // (`exitNotClaimed`, src/codebehind/execute.ts) — but the predicate stays so
    // the two files say the same thing and the compiler finds this site when the
    // union widens again.
    if (outcome.flowControl && claim && isReturnClaim(claim)) {
      logger.success(`Step ${stepIndex} returned (code-behind)`);
      return {
        result: {
          ...base,
          aiExplanation: 'via code-behind',
          flowControl: { kind: 'return', verb: claim.verb },
        },
      };
    }
    logger.success(`Step ${stepIndex} passed (code-behind)`);
    return { result: { ...base, aiExplanation: 'Ran this step\'s code-behind — no AI call.' } };
  }

  if (brokenCode && opts.codeBehindStrict) {
    logger.error(`Step ${stepIndex} FAILED (code-behind, strict): ${outcome.error ?? ''}`);
    return {
      result: {
        ...base,
        error: outcome.error ?? 'Code-behind entry threw',
        aiExplanation:
          'The code-behind entry threw and strict mode is on, so the step was ' +
          'not re-run under AI. This is a compile replay: the point is to find ' +
          'out whether the code works on its own.',
      },
    };
  }

  if (brokenCode) {
    // Keyless — the only other way healing gets declined above.
    //
    // The `error` is the instruction rather than the thrown message on
    // purpose: it is what the console step line, the report row and the
    // client all render, and the author's next move ("recompile or repair
    // this step where AI is available") is the useful thing to put there. The
    // thrown message is one line down, in the explanation and the log.
    //
    // It also rides out structurally, in `codeBehindHealSkipped`, because that
    // advice has to be actionable on the machine that does have a model: the
    // sidecar writers turn this into a stale row so `--only-stale` selects the
    // step and the repair prompt gets the real failure to work from. NOT
    // `codeBehindStale` — every heal counter reads that field, and this step
    // healed nothing.
    // Policy-off and no-key take the SAME skip and the same sidecar — only the
    // wording differs, because the reader's next move does.
    const byPolicy = opts.keylessReason === 'policy';
    logger.error(
      `Step ${stepIndex} FAILED (code-behind, ${byPolicy ? 'AI forbidden by policy' : 'no AI configured'}): ${outcome.error ?? ''}`,
    );
    return {
      result: {
        ...base,
        error: byPolicy ? POLICY_HEAL_SKIPPED_ERROR : KEYLESS_HEAL_SKIPPED_ERROR,
        codeBehindHealSkipped: {
          file: binding.file,
          source: binding.source,
          error: outcome.error ?? 'unknown error',
        },
        aiExplanation:
          (byPolicy
            ? 'The code-behind entry threw, and this run forbids AI ' +
              '(runSettings.ai: off, or ai.allowInRuns: false in aiui.config.json), ' +
              'so the step was not re-run under AI. '
            : 'The code-behind entry threw, and this machine has no AI configured, ' +
              'so the step was not re-run under AI. ') +
          `The entry failed with: ${outcome.error ?? 'unknown error'}`,
      },
    };
  }

  if (outcome.nonRetryable) {
    // Neither broken code nor a failed expectation. Two different facts arrive
    // here and they need opposite sentences, so the kind is read off the
    // outcome rather than off the message: an unclaimed `step.exit()` used to
    // land in the missing-file branch and tell the author to go looking for a
    // file the step never named. Saying "code-behind assertion" would be wrong
    // for both — it sends the reader after a `step.expect` that does not exist.
    if (outcome.nonRetryableKind === 'exit-unclaimed') {
      logger.error(`Step ${stepIndex} FAILED (code-behind, unclaimed exit): ${outcome.error ?? ''}`);
      return {
        result: {
          ...base,
          error: outcome.error ?? EXIT_NOT_CLAIMED,
          aiExplanation:
            'This step\'s code-behind called `step.exit()`, but the step\'s own text does '
            + 'not say it returns. The markdown is what a reader sees, so it has to say '
            + 'what the code does: write the step as "If <condition> then return", or as a '
            + 'step whose whole text is the tail. The entry was kept — re-running under AI '
            + 'would not change the rule.',
        },
      };
    }
    logger.error(`Step ${stepIndex} FAILED (code-behind): ${outcome.error ?? ''}`);
    return {
      result: {
        ...base,
        error: outcome.error ?? 'Code-behind could not resolve a file',
        aiExplanation:
          'The file this step names could not be resolved, so the entry could not '
          + 'run. The code-behind is not at fault and was kept: re-running the step '
          + 'under AI would not make the file appear.',
      },
    };
  }

  // An expectation message is a STRING THE TEST WROTE, and this is the seam where
  // it becomes what the wire, the report and the log carry — so it is masked here,
  // as at the `fail` verb's site and in `applyFailureTail` above (decision 3).
  // Both branches below: a `step.fail` message built from
  // `step.getVar('password')` is the case that made it necessary, and a
  // `step.expect` message interpolates a captured value just as readily.
  const expectationError =
    outcome.error === undefined ? undefined : redact(outcome.error, secretsFor(opts));

  // `step.fail(message)` — the code form of `If … then fail the test with error
  // "…"` (stories/step-failure-outcomes.md, decision 10). It throws the class
  // `step.expect` throws, so it arrives under the same rule (a real failure,
  // never healed under AI) and only needs its own sentence: sending this reader
  // after a `step.expect` that does not exist is the defect the unclaimed-exit
  // branch above was written to fix.
  if (outcome.expectationFailed && outcome.deliberate) {
    logger.error(`Step ${stepIndex} FAILED (code-behind, as written): ${expectationError ?? ''}`);
    return {
      result: {
        ...base,
        error: expectationError ?? 'Failed by the step, as written',
        deliberate: true,
        aiExplanation:
          'This step\'s code-behind called `step.fail(...)`: a deliberate ' +
          'failure, not broken code, so the step was not re-run under AI.',
      },
    };
  }

  logger.error(`Step ${stepIndex} FAILED (code-behind assertion): ${expectationError ?? ''}`);
  return {
    result: {
      ...base,
      error: expectationError ?? 'Code-behind expectation failed',
      aiExplanation:
        'A `step.expect` in this step\'s code-behind failed. That is a real ' +
        'assertion failure, not broken code, so the step was not re-run under AI.',
    },
  };
}

/**
 * What a name the step references but nothing has captured yet renders as
 * (stories/placeholder-preserving-actions.md, decision 4). Shown rather than
 * hidden: a step that reads `{{balance}}` before the step that captures it has
 * run is a partial re-run, and the model reading "(not yet captured)" is what
 * makes the refusal that follows legible.
 */
const NOT_YET_CAPTURED = '(not yet captured)';

/** The `[output:]` enrichment, applied to the authored text. The runners apply
 *  it to the substituted text before they call in; without this the model is
 *  shown a raw `[output: total]` prefix and no `[store as: total]` telling it
 *  to capture anything. Idempotent — an already-enriched string has no
 *  `[output:]` left to find. */
function enrichAuthored(text: string): string {
  const { variables, cleanedInstruction } = parseOutputPrefixes(text);
  return variables.length > 0 ? buildEnrichedInstruction(cleanedInstruction, variables) : text;
}

/**
 * The `## Values` table for one step: every reference its AUTHORED text makes,
 * with what that reference holds on this run.
 *
 * Derived here rather than passed in, because there are six callers of
 * `executeStep` and only two of them hold a parameter map they could build it
 * from — and it has to be rebuilt per turn anyway, since a `read` in turn 1
 * defines a name turn 2 may reference.
 *
 * Scoped to what the step REFERENCES, not to the whole map: that scoping is
 * what stops every continuation turn of every step rendering every parameter.
 * A name the step DEFINES — `[store as: x]`, or `store as {{x}}` in prose — is
 * not a reference and is left out. `undefined` when the step references
 * nothing, which is what keeps a plain step's prompt byte-identical to the one
 * built before this block existed.
 */
function buildStepValues(authored: string, opts: StepExecutorOptions): StepValues | undefined {
  const params = opts.resolvedParameters ?? {};
  const { placeholders, captures } = referencedVariableNames(authored);
  const defined = new Set([...captures, ...inlineStoreAsNames(authored)]);
  const parameters = placeholders
    .filter((name) => !defined.has(name))
    .map((name) => ({ name, value: params[name] ?? NOT_YET_CAPTURED }));

  const envRefs: Array<{ ref: string; value: string }> = [];
  if (opts.envData) {
    for (const ref of envDataRefsIn(authored)) {
      const value = resolveEnvDataRef(ref, opts.envData);
      // An unresolvable `${…}` threw at parse (CLI) or at the per-step
      // interpolation (server), so this is unreachable for a step that got
      // this far. Skipped rather than rendered: there is nothing to say it
      // holds, and the checker refuses the turn if the model emits it anyway.
      if (value !== undefined) envRefs.push({ ref, value });
    }
  }

  if (parameters.length === 0 && envRefs.length === 0) return undefined;
  return {
    parameters,
    ...(envRefs.length > 0 && { envRefs }),
    ...(opts.unmask !== undefined && { unmask: opts.unmask }),
  };
}

/**
 * The run's secret values, from the options every entry point in this file
 * already carries. Read fresh at each use rather than once: `[as: …]`
 * captures and `[input: …]` answers grow the parameter map while a step runs.
 *
 * One function, three call sites — the step prompt, the condition judge's and
 * the watch group's. The step prompt had it and the other two did not, so a
 * secret typed into a text field reached the model masked on one path and raw
 * on the next turn (review 3, finding 2).
 */
function secretsFor(opts: StepExecutorOptions): string[] {
  return runSecrets({
    parameters: opts.resolvedParameters ?? {},
    ...(opts.envData !== undefined && { envData: opts.envData }),
  });
}

/** Every name the test's steps capture — `[store as: x]` and `store as {{x}}`.
 *  Used only to make a refusal say "captured later" instead of "unknown". */
function namesDefinedIn(steps: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const step of steps) {
    for (const name of referencedVariableNames(step).captures) out.add(name);
    for (const name of inlineStoreAsNames(step)) out.add(name);
  }
  return out;
}

async function executeStepAttempt(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: StepExecutorOptions,
  startTime: number,
  retried: boolean,
  priorFailures: PriorFailureContext[] = [],
  attemptNumber: number = 1,
  cachedTurns?: CachedStepData[],
  cacheCapture?: CacheCapture,
  authoredInstruction?: string,
): Promise<StepResult> {
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory, apiResponseStore, csrfTokens, pageTracker } = opts;

  // The step as WRITTEN, tokens intact — what the model reads, beside the
  // `## Values` block. The `[output:]` enrichment runs on it as well as on the
  // substituted text, or the model is shown a raw `[output: x]` prefix and no
  // `[store as: x]` telling it to capture (stories/placeholder-preserving-actions.md
  // §Executor).
  //
  // And the `otherwise …` tail comes OFF, here and nowhere else
  // (stories/step-failure-outcomes.md, decision 4). Everything else keeps the
  // line the author wrote — `instruction`, the console line, the cache key, the
  // run log — because hiding the tail is about what the model is asked to decide,
  // not about what a reader is shown.
  //
  // Stripped BEFORE the enrichment: `enrichAuthored` appends `[store as: …]` to
  // the END of the line and the tail grammar is `$`-anchored, so a tail with a
  // marker behind it would no longer parse.
  const promptAuthored = enrichAuthored(stripFailureTail(authoredInstruction ?? instruction));
  /** The SUBSTITUTED text a continuation turn quotes back, same treatment. */
  const promptInstruction = stripFailureTail(instruction);
  /** What the model may name: this run's parameters and the environment. */
  const placeholderValues: PlaceholderValues = {
    parameters: opts.resolvedParameters ?? {},
    ...(opts.envData !== undefined && { envData: opts.envData }),
  };
  /** Names some LATER step captures, so a refusal can say "not yet" rather
   *  than send the reader hunting for a typo. Only the CLI and the REPL pass
   *  `testSteps`; without it the refusal is simply less specific. */
  const definedLater = namesDefinedIn(opts.testSteps ?? []);
  // The run's secret values, read fresh at each use: `[as: …]` captures and
  // `[input: …]` answers grow the parameter map as the step runs.
  const secretsNow = (): string[] => secretsFor(opts);
  let page = pageTracker ? pageTracker.getActive() : opts.page;
  const maxTurns = config.execution.maxTurns;

  // Accumulated across all turns
  const allTurns: TurnResult[] = [];
  const allCompletedActions: Array<{ action: string; description: string; selector?: string }> = [];
  const collectedFailures: PriorFailureContext[] = [];
  const attemptStartUrl = page.url();
  /** Results from find/expand exploration actions — included in the continuation message */
  const explorationResults: string[] = [];

  // Stall detection: if the AI keeps issuing "wait" actions but the page
  // (URL + DOM) is unchanged AND the network is idle, the prior action likely
  // didn't register. Fail fast instead of burning turns on a stuck page.
  let activityTrackers = new Map<Page, PageActivityTracker>();
  const trackerFor = (p: Page): PageActivityTracker => {
    let t = activityTrackers.get(p);
    if (!t) { t = new PageActivityTracker(p); activityTrackers.set(p, t); }
    return t;
  };
  trackerFor(page); // attach to initial page
  let prevPageFingerprint: string | undefined;
  let lastActionWasWait = false;
  let stallCount = 0;
  const STALL_LIMIT = 2;

  // Global sub-action counter (1-based, spans all turns)
  let globalSubActionIndex = 0;

  // First-turn state is used for the step result (DOM taken at step start)
  let firstTurnDomSnapshot = '';
  let firstTurnUrl = '';

  // Retained from the final turn for aiExplanation and assertion context
  let lastAiResponse: ReturnType<typeof parseAIResponse> | null = null;

  /** Accumulated assertion results across all turns of this step */
  const assertionResults: AssertionResult[] = [];
  /** Running counter for assertIndex within this step (0-based) */
  let assertCounter = 0;
  let stepFailed = false;
  let stepError: string | undefined;
  let completedTurns = 0;
  /** Set when the user takes control inside the AI clarification REPL. The post-loop
   *  return uses this to short-circuit with the right `runnerControl` payload so the
   *  test-runner doesn't double-prompt. */
  let controlSignal:
    | { kind: 'resume'; fromStepIndex: number }
    | { kind: 'exit' }
    | { kind: 'clarification-unavailable'; question: string }
    | null = null;
  /** Ad-hoc StepResults produced inside the clarification REPL (typed Flick steps,
   *  /screenshot captures). Returned via a side-channel for the runner to merge. */
  const clarificationAdHoc: StepResult[] = [];
  /** Set when the model answered a claimed flow-control step with `return`.
   *  Ends the turn loop and rides out on the StepResult, where the run loop
   *  reads it (stories/step-flow-control.md). */
  let flowControlSignal: StepResult['flowControl'] | undefined;
  /** The model's own words for WHY it returned — the tail of the returning
   *  step's explanation, which the loop prefixes with the flow's name. */
  let flowControlDetail: string | undefined;
  /**
   * Set when the model answered a step claiming the `fail` verb with the
   * `fail` action (stories/step-failure-outcomes.md, decision 2).
   *
   * It rides on the turn's throw rather than on the StepResult, because a
   * deliberate failure IS a failure: it unwinds through `withRetry` — which ends
   * after this one attempt, the throw being non-retryable — and the outer catch
   * turns it into the red step. `why` is already masked.
   */
  let deliberateFailure: { why: string } | undefined;

  try {
  for (let currentTurn = 1; currentTurn <= maxTurns; currentTurn++) {
    completedTurns = currentTurn;

    // Abort check — bail before doing any work on this turn if the run was
    // stopped, so a multi-turn step stops spawning AI calls. Throwing unwinds
    // to withRetry (which won't retry an aborted op) and then to executeStep's
    // catch, which returns an aborted result. See issues/020.
    if (opts.signal?.aborted) {
      throw new DOMException('Run aborted by client', 'AbortError');
    }

    // 0. Refresh active page from tracker (handles switchPage and
    //    openBrowser/switchBrowser/closeBrowser from prior turn).
    if (opts.browserTracker) {
      try { page = opts.browserTracker.getActivePage(); }
      catch { /* no active browser — let downstream fail with clear error */ }
    } else if (pageTracker) {
      page = pageTracker.getActive();
    }
    const tracker = trackerFor(page);

    // 0b. The settle gate before a flow-control judgement
    //     (stories/step-flow-control.md, decision 6).
    //
    // A conditional return is decided by reading the page ONCE, and a title
    // read a millisecond after the click that changes it is the stale answer
    // that makes the return miss. `executeBranchedStep` waits for exactly this
    // reason before its first evaluation, and this is that same budget — up to
    // 10 s, 1 s quiet. Only the conditional form pays it: the unconditional
    // one never reaches the executor at all.
    if (currentTurn === 1 && opts.flowControlClaim?.body !== undefined) {
      await traceOp('settle.flow-control-judgement', () =>
        waitForPageStability(page, {
          timeoutMs: Math.min(10_000, config.execution.timeout * 1000),
          quiesceMs: 1000,
        }),
      ).catch(() => {
        // A settle that cannot complete is not a failed step — the judgement
        // then runs against whatever the page is, exactly as it did before
        // this gate existed.
      });
    }

    // 1b. On retry attempts, diagnose page state and auto-wait if loading
    let pageDiagnosis: PageStateDiagnosis | undefined;
    if (attemptNumber > 1 && currentTurn === 1) {
      pageDiagnosis = await traceOp(`page.diagnose (turn ${currentTurn})`, () => diagnosePageState(page));
      if (pageDiagnosis.isLoading) {
        logger.info('Page appears to be loading on retry — waiting for networkidle (up to 5s)');
        await traceOp('page.waitForLoadState networkidle (5s cap)', () =>
          page.waitForLoadState('networkidle', { timeout: 5000 }),
        ).catch(() => {
          logger.debug('networkidle wait timed out after 5s — proceeding anyway');
        });
        // Re-diagnose after waiting
        pageDiagnosis = await traceOp(`page.diagnose (post-wait, turn ${currentTurn})`, () => diagnosePageState(page));
      }
    }

    // 2. Capture current page state. The DOM snapshot is *only* AI input —
    // once a turn is served from cache, the snapshot has no consumer (the
    // cached action plan was already decided, and cached assertions run
    // against the live DOM via Playwright, not against the snapshot string).
    // Skipping the snapshot on cache hits is the single biggest wall-clock
    // win for cached replays — captureDomSnapshot is typically 200ms–2s.
    //
    // Screenshots are kept on cache hits when the user has opted into the
    // per-action filmstrip (`captureScreenshotsPerAction`). The `sendScreenshots`
    // setting only feeds the AI, so it's irrelevant when we're not calling AI.
    const turnTimestamp = new Date().toISOString();
    const cachedTurnForCapture = cachedTurns?.[currentTurn - 1];
    // Compile's Record input (stories/codebehind-compile-as-a-run.md §Ordinary
    // runs capture what a compile needs): when the caller asked for step
    // context, a cache hit still takes the turn-1 snapshot — it is `domBefore`.
    // Code-behind executes ahead of the cache, so a cached step is by
    // definition an uncompiled one, and the cost ends when it is compiled.
    const wantTurnDom =
      !cachedTurnForCapture || (opts.captureStepContext === true && currentTurn === 1);
    const domSnapshot = !wantTurnDom
      ? ''
      : await traceOp(`captureDomSnapshot (turn ${currentTurn})`, () =>
          captureDomSnapshot(page, {
            ...config.browser.domNoiseReduction,
            maxIframeDepth: config.browser.maxIframeDepth,
            domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
          }),
        );
    const wantPreTurnShot = cachedTurnForCapture
      ? config.browser.captureScreenshotsPerAction !== false
      : config.ai.sendScreenshots || config.browser.captureScreenshotsPerAction !== false;
    const screenshot = wantPreTurnShot
      ? await traceOp(`captureScreenshot (turn ${currentTurn})`, () =>
          captureScreenshot(page, config.browser.fullPageScreenshots),
        )
      : null;
    const screenshotBase64 = screenshot?.base64;
    const currentUrl = page.url();
    // Where the viewport actually is, in text. The DOM snapshot carries no
    // coordinates, so this is the model's only evidence that a scroll landed
    // when screenshots are off — or when they're full-page, and therefore
    // identical at every scroll position. Skipped on cache hits for the same
    // reason as the DOM snapshot: no AI call, so no consumer.
    const scrollPosition = cachedTurnForCapture
      ? undefined
      : await traceOp(`captureScrollPosition (turn ${currentTurn})`, () =>
          captureScrollPosition(page),
        );

    if (currentTurn === 1) {
      firstTurnDomSnapshot = domSnapshot;
      firstTurnUrl = currentUrl;
    }

    // Stall detection: if the prior turn's action was a "wait" and neither the
    // page (URL + DOM) nor the network moved since then, the preceding click
    // (or whatever triggered the wait) likely didn't register. Bail out instead
    // of burning more turns. Skipped on cached turns — the cached action plan
    // is deterministic, "wait" decisions are not in play, and we don't have a
    // DOM snapshot to fingerprint against anyway.
    if (!cachedTurnForCapture) {
      const pageFingerprint = `${currentUrl}\n${domSnapshot}`;
      if (currentTurn > 1 && lastActionWasWait) {
        const unchanged = pageFingerprint === prevPageFingerprint;
        const networkIdle = tracker.isIdle();
        if (unchanged && networkIdle) {
          stallCount++;
          logger.warn(
            `Stall detected (${stallCount}/${STALL_LIMIT}): page unchanged since last turn, network idle, last action was "wait" — prior action may not have registered`,
          );
          if (stallCount >= STALL_LIMIT) {
            throw new StepFailureError(
              `Step stalled: page did not advance after prior action across ${stallCount + 1} turns (URL, DOM, and network all quiet). The preceding action may not have registered — check selector targeting and element interactability.`,
              [],
              allTurns,
            );
          }
        } else {
          stallCount = 0;
        }
      }
      prevPageFingerprint = pageFingerprint;
    }

    // Per-turn accumulators
    const turnAiInteractions: AiInteraction[] = [];
    const turnSubActions: SubActionResult[] = [];



    // 4. Build API context and system prompt (rebuilt each turn so API history stays current)
    const apiContext: ApiPromptContext | undefined = contextContent.includes('Type:')
      ? {
          hasApiContext: true,
          responseHistory: apiResponseStore?.hasResponses()
            ? apiResponseStore.formatForContext()
            : '',
        }
      : undefined;
    const systemPrompt = buildSystemPrompt(contextContent, apiContext, {
      dismissalGuidance: opts.dismissalGuidance ?? false,
    });
    const testInfo = formatTestInfo(
      testName,
      baseUrl,
      stepIndex,
      totalSteps,
      config.browser.headed ? config.browser.windowSize : config.browser.viewport,
      buildActiveBrowserInfo(opts.browserTracker),
    );

    // 5. Build user message (first turn: normal step message; subsequent: continuation prompt)
    const openPages = pageTracker && pageTracker.count > 1
      ? await pageTracker.getPageListWithTitles()
      : undefined;

    let userMessage: ChatMessage;
    const screenshotForAi = config.ai.sendScreenshots ? (screenshotBase64 ?? null) : null;
    // What this step's placeholders hold right now, masked by name/path. Built
    // per turn because a `read` in turn 1 can define a name turn 2 references.
    const stepValues = buildStepValues(promptAuthored, opts);
    // A controlled input that mirrors what was typed into its `value=`
    // attribute puts the password in the snapshot. `capture-dom.js` serialises
    // attributes rather than the `.value` property Playwright's `fill` sets, so
    // a plain form is clean either way — this is the one line that covers the
    // other kind (stories/placeholder-preserving-actions.md §Where a secret
    // still goes). Masked for the MODEL only: the stored `firstTurnDomSnapshot`
    // and the report's copy are untouched.
    const domForAi = redact(domSnapshot, secretsNow());

    if (currentTurn === 1) {
      const retryInput: RetryDiagnostics | undefined = priorFailures.length > 0
        ? {
            failures: priorFailures,
            ...(pageDiagnosis ? { pageState: pageDiagnosis } : {}),
            attemptNumber,
            dismissalGuidance: opts.dismissalGuidance ?? false,
          }
        : undefined;
      const retryHint = retryInput ? buildRetryContext(retryInput) : '';
      // The AUTHORED step, not the substituted one — decision 1. The retry
      // hint is appended to it exactly as it was to the substituted form.
      const enrichedInstruction = retryHint ? `${promptAuthored}${retryHint}` : promptAuthored;
      userMessage = buildStepMessage(
        enrichedInstruction,
        domForAi,
        screenshotForAi,
        conversationHistory,
        openPages,
        testInfo,
        scrollPosition,
        stepValues,
      );
    } else {
      userMessage = buildContinuationMessage(
        promptInstruction,
        allCompletedActions,
        opts.resolvedParameters ?? {},
        currentUrl,
        domForAi,
        screenshotForAi,
        currentTurn,
        openPages,
        explorationResults.length > 0 ? explorationResults : undefined,
        testInfo,
        scrollPosition,
        // Always passed, even empty: without it the continuation turn falls
        // back to rendering the WHOLE resolved parameter map unmasked, which
        // was the widest surface a secret reached (decision 2).
        stepValues ?? { parameters: [] },
        promptAuthored,
      );
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      userMessage,
    ];

    // 6. Get AI action plan (from cache on turn 1 if available, otherwise call AI)
    let rawResponse: string;
    let aiResponse: ReturnType<typeof parseAIResponse>;

    const cachedTurn = cachedTurns?.[currentTurn - 1];
    if (cachedTurn) {
      rawResponse = cachedTurn.rawResponse;
      aiResponse = {
        actions: cachedTurn.actions,
        reasoning: cachedTurn.reasoning,
        ...(cachedTurn.needs_reeval !== undefined && { needs_reeval: cachedTurn.needs_reeval }),
      };
      turnAiInteractions.push({
        purpose: 'action-plan (cached)',
        attemptNumber,
        requestMessages: [],
        response: rawResponse,
        ...(screenshotBase64 !== undefined && { screenshotBase64 }),
        pageUrl: currentUrl,
        timestamp: turnTimestamp,
      });
    } else {
      const completion = await traceOp(`ai.complete (turn ${currentTurn})`, () => aiClient.complete(messages, opts.signal));
      rawResponse = completion.text;
      aiResponse = parseAIResponse(rawResponse);

      turnAiInteractions.push({
        purpose: 'action-plan',
        attemptNumber,
        requestMessages: messages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
        response: rawResponse,
        model: completion.model,
        ...(screenshotBase64 !== undefined && { screenshotBase64 }),
        pageUrl: currentUrl,
        timestamp: turnTimestamp,
      });
    }

    // Capture this turn for cache writing
    if (cacheCapture) {
      cacheCapture.turns.push({
        rawResponse,
        actions: aiResponse.actions,
        reasoning: aiResponse.reasoning,
        ...(aiResponse.needs_reeval !== undefined && { needs_reeval: aiResponse.needs_reeval }),
      });
    }

    lastAiResponse = aiResponse;

    logger.debug(`AI reasoning (turn ${currentTurn}): ${aiResponse.reasoning}`);

    // 7. Handle prompt actions (ambiguity resolution)
    const promptAction = aiResponse.actions.find((a) => a.action === 'prompt');
    if (promptAction && config.execution.promptOnAmbiguity) {
      const question = promptAction.question ?? promptAction.description;
      if (opts.nonInteractive) {
        // No console to read an answer from (server-driven run). Asking via
        // readline would block on stdin forever and hang the test. Fail the
        // step fast, carrying the AI's question as the error so the client
        // can surface it. See issues/014.
        controlSignal = { kind: 'clarification-unavailable', question };
        allTurns.push({
          turnNumber: currentTurn,
          attemptNumber,
          timestamp: turnTimestamp,
          aiInteractions: turnAiInteractions,
          subActions: turnSubActions,
        });
        break;
      }
      const outcome = await promptUserWithReplEscape({
        question,
        page,
        testSteps: opts.testSteps ?? [],
        currentStepIndex: stepIndex,
        // The claim belongs to THIS step's authored line and to nothing else
        // (stories/step-flow-control.md, decision 2). Ad-hoc lines the user
        // types at the REPL run through `executeStep` with these options, so
        // handing `opts` over whole let a `return` action end the flow from a
        // line the framework never read the form off — the exact hole the
        // claim exists to close. `failureTail` goes with it for the same reason
        // (decision 4): a typed line that failed must not be renamed — or
        // tolerated — by a tail belonging to the step that asked the question.
        executorOptions: { ...opts, flowControlClaim: undefined, failureTail: undefined },
        adHocResults: clarificationAdHoc,
      });

      if (outcome.kind === 'exit' || outcome.kind === 'resume') {
        controlSignal = outcome.kind === 'exit'
          ? { kind: 'exit' }
          : { kind: 'resume', fromStepIndex: outcome.fromStepIndex };
        // Push the (incomplete) turn so the report retains the AI's question.
        allTurns.push({
          turnNumber: currentTurn,
          attemptNumber,
          timestamp: turnTimestamp,
          aiInteractions: turnAiInteractions,
          subActions: turnSubActions,
        });
        break;
      }

      const userAnswer = outcome.text;
      const clarificationMsg = buildClarificationMessage(question, userAnswer);
      const clarificationMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        userMessage,
        { role: 'assistant', content: rawResponse },
        clarificationMsg,
      ];
      const clarifiedCompletion = await aiClient.complete(clarificationMessages, opts.signal, { profile: 'retry' });
      const clarifiedResponse = clarifiedCompletion.text;
      turnAiInteractions.push({
        purpose: 'clarification',
        attemptNumber,
        requestMessages: clarificationMessages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
        response: clarifiedResponse,
        model: clarifiedCompletion.model,
        timestamp: new Date().toISOString(),
      });
      aiResponse = parseAIResponse(clarifiedResponse);
      lastAiResponse = aiResponse;
    }

    // 8. Execute each sub-action
    let turnFailed = false;
    /** Set when an action reported a failure no retry could change. */
    let turnNonRetryable = false;
    let turnError: string | undefined;

    // Every reference in every action of THIS turn, checked before any of them
    // runs (stories/placeholder-preserving-actions.md, decision 4). One bad
    // reference and none of the turn's actions execute — a sign-in step cannot
    // type the username and then fail on `{{passwrod}}`. Per turn, so a
    // `needs_reeval` second turn is checked when it arrives and turn 1's
    // actions stand. Retryable: the failure text names the correct key, and the
    // retry prompt carries it, so `{{ email }}` can be fixed on attempt 2.
    const refusal = checkTurnReferences(aiResponse.actions, {
      known: new Set(Object.keys(opts.resolvedParameters ?? {})),
      definedLater,
      ...(opts.envData !== undefined && { envData: opts.envData }),
    });
    if (refusal !== undefined) {
      turnFailed = true;
      turnError = refusal;
      logger.warn(refusal);
      collectedFailures.push({
        selector: '',
        error: refusal,
        actionType: aiResponse.actions[0]?.action ?? 'unknown',
        startUrl: attemptStartUrl,
        failureUrl: page.url(),
        navigated: page.url() !== attemptStartUrl,
      });
    }

    for (const emitted of refusal === undefined ? aiResponse.actions : []) {
      // What the page gets: a COPY with `{{name}}` and `${…}` resolved. The
      // emitted object is never written to — the transcript, the recording and
      // the cache keep it as the model wrote it, which is the whole point of
      // asking for the placeholder (decision 3). Every consumer below reads
      // `action`; the three record sites read `emitted`.
      const action = substituteAction(emitted, placeholderValues);
      if (action.action === 'prompt') continue;

      const subStartTime = Date.now();
      const aiReasoningVal = config.reports.includeAiReasoning ? aiResponse.reasoning : undefined;

      // ── return action: end the flow this step is in ──────────────────────
      // The claim is what makes this legal (stories/step-flow-control.md,
      // decision 2). Checked here rather than in `executeAction`, because the
      // authored step text is an executor fact and the browser layer has no
      // idea what step it is running.
      if (action.action === 'return') {
        const returnSub: SubActionResult = {
          index: ++globalSubActionIndex,
          action: emitted,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          durationMs: Date.now() - subStartTime,
          pageUrl: page.url(),
          timestamp: new Date().toISOString(),
        };
        const returnClaim = opts.flowControlClaim;
        // `isReturnClaim`, so a step claiming the `fail` verb refuses a `return`
        // exactly as an unclaimed step does (decision 1): the verbs are opposite
        // outcomes, and swapping them could paint a failure the author asked for
        // green.
        if (returnClaim && isReturnClaim(returnClaim)) {
          turnSubActions.push(returnSub);
          flowControlSignal = { kind: 'return', verb: returnClaim.verb };
          flowControlDetail = action.description;
          logger.info(
            `Step ${stepIndex} returned: ${action.description || 'condition holds'}`,
          );
          // Nothing after a return runs — not the rest of this turn's actions,
          // and not another turn.
          break;
        }
        turnSubActions.push({ ...returnSub, error: RETURN_NOT_CLAIMED });
        turnFailed = true;
        turnError = RETURN_NOT_CLAIMED;
        logger.warn(`Step ${stepIndex}: ${RETURN_NOT_CLAIMED}`);
        collectedFailures.push({
          selector: '',
          error: RETURN_NOT_CLAIMED,
          actionType: 'return',
          startUrl: attemptStartUrl,
          failureUrl: page.url(),
          navigated: page.url() !== attemptStartUrl,
        });
        break;
      }

      // ── fail action: end the RUN, in the author's words ──────────────────
      // The sibling of `return` and gated identically
      // (stories/step-failure-outcomes.md, decisions 1–3): the line claims the
      // verb, the model judges the condition.
      if (action.action === 'fail') {
        const failSub: SubActionResult = {
          index: ++globalSubActionIndex,
          action: emitted,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          durationMs: Date.now() - subStartTime,
          pageUrl: page.url(),
          timestamp: new Date().toISOString(),
        };
        const failClaim = opts.flowControlClaim;
        if (failClaim && failClaim.verb === 'fail') {
          // The one seam the run's secrets are applied at (decision 3): the
          // author's message and the model's account of the condition both become
          // wire, report and log text from here on, so a `{{password}}` in either
          // is masked once, here, and never re-derived.
          const secrets = secretsNow();
          // May be empty — a model that described nothing still ends the step.
          const why = redact(action.description?.trim() ?? '', secrets);
          // The message comes off the INTERPOLATED line, not off the claim: the
          // claim was read from the AUTHORED text — it has to be the same answer
          // on every run and in every runner — so `failClaim.message` still holds
          // the author's `{{tokens}}`, and `Expected 10, got {{total}}` would
          // reach the report with the braces in it. One parser read twice, exactly
          // as `deliberateFailError` does it for the unconditional form
          // (src/runner/flow-control.ts), fallback included: a value carrying the
          // quote character that ends the message makes the re-parse miss.
          const reparsed = parseFlowControlStep(instruction);
          const resolved = reparsed?.verb === 'fail' ? reparsed.message : undefined;
          const authoredMessage = resolved ?? failClaim.message;
          // A message-less `fail` is legal and the framework words it (decision 3).
          // Read for TRUTH rather than presence: the parser keeps `with error ""`
          // as an empty string, and an empty error is no error to put on the row.
          const composed = authoredMessage
            ? redact(authoredMessage, secrets)
            : `Failed by the step: ${why || 'the condition held'}`;
          turnSubActions.push({ ...failSub, error: composed });
          turnFailed = true;
          // Never retried: a retry hands the model "this failed, try something
          // else" — the one nudge that could turn a deliberate failure into a
          // false pass (decision 2).
          turnNonRetryable = true;
          turnError = composed;
          deliberateFailure = { why };
          logger.error(`Step ${stepIndex} failed as written: ${composed}`);
          // Nothing after it runs, for the reason nothing after a `return` does.
          break;
        }
        turnSubActions.push({ ...failSub, error: FAIL_NOT_CLAIMED });
        turnFailed = true;
        turnError = FAIL_NOT_CLAIMED;
        logger.warn(`Step ${stepIndex}: ${FAIL_NOT_CLAIMED}`);
        collectedFailures.push({
          selector: '',
          error: FAIL_NOT_CLAIMED,
          actionType: 'fail',
          startUrl: attemptStartUrl,
          failureUrl: page.url(),
          navigated: page.url() !== attemptStartUrl,
        });
        break;
      }

      // ── assert action: evaluate inline against current page state ────────
      if (action.action === 'assert') {
        const myAssertIndex = assertCounter++;
        const condition = action.condition ?? '';
        // Preserve `undefined` for predicate mode — the fingerprint, cache,
        // and code generator all distinguish "no expected" from "expected: ''".
        const against = action.against ?? 'dom';
        const expected = against === 'predicate' ? undefined : (action.expected ?? '');
        const description = action.description;

        const assertResult = await evaluateAssertion({
          page,
          stepIndex,
          cacheKey: opts.cacheKey ?? stepIndex,
          assertIndex: myAssertIndex,
          turnNumber: currentTurn,
          subActionIndex: ++globalSubActionIndex,
          condition,
          expected,
          description,
          against,
          poll: action.poll,
          contextContent,
          testName,
          baseUrl,
          aiClient,
          stepCache: opts.stepCache,
          // The same gate the action cache is under — see `cacheEnabledFor`.
          cacheEnabled: cacheEnabledFor(opts),
          resolvedParams: opts.resolvedParameters ?? {},
          apiResponseStore,
          attemptNumber,
          dismissalGuidance: opts.dismissalGuidance ?? false,
          fullPageScreenshots: config.browser.fullPageScreenshots,
          sendScreenshots: config.ai.sendScreenshots,
          ...(opts.signal && { signal: opts.signal }),
        });

        assertionResults.push(assertResult);

        // Record as a sub-action for execution-order interleaving in the report
        turnSubActions.push({
          index: assertResult.subActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
          ...(!assertResult.pass && { error: `Assertion failed: ${assertResult.description} — got "${assertResult.actual}"` }),
        });

        if (!assertResult.pass) {
          turnFailed = true;
          turnError = `Assertion failed: ${assertResult.description} — expected "${assertResult.expected}", got "${assertResult.actual}"`;
          break;
        }
        continue;
      }

      // ── openPage action ───────────────────────────────────────────────────
      // Spawn a brand-new tab/window at a URL the test specifies (vs. waiting
      // for the application to open one via window.open / target="_blank").
      // The new page registers automatically via context.on('page') from
      // browser/manager.ts, then we promote it to active so subsequent
      // actions in the test target it without an explicit switchPage turn.
      if (action.action === 'openPage') {
        let openError: string | undefined;
        const targetUrl = action.url ?? action.value ?? '';
        if (!targetUrl) {
          openError = 'openPage failed: no "url" field specified';
          logger.warn(openError);
        } else if (!pageTracker) {
          openError = 'openPage failed: page tracking is not enabled';
          logger.warn(openError);
        } else {
          try {
            const newPage = await page.context().newPage();
            // This session asked for this tab, so it is not an "unexpected"
            // one in the report. Needed because our own `newPage()` and
            // another session's are indistinguishable from the
            // `context.on('page')` handler's side — both arrive with a null
            // opener — and on a shared CDP browser we see both.
            pageTracker.markExpected(newPage);
            await newPage.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30_000,
            });
            // The context.on('page') handler in browser/manager.ts already
            // registered this page with an auto-label (`page:N`). When the
            // author supplied `as`, replace that with the custom label so
            // subsequent switchPage calls can target this page by name —
            // deterministic across re-runs and immune to "two tabs with the
            // same title" disambiguation.
            if (action.as) {
              try {
                pageTracker.relabelPage(newPage, action.as);
              } catch (relabelErr) {
                openError = `openPage failed: ${(relabelErr as Error).message}`;
                logger.warn(openError);
                await newPage.close();
                throw relabelErr;
              }
            }
            // Switching to it makes it active for the rest of this turn and
            // every subsequent step.
            const switched = await pageTracker.switchToAsync(newPage.url());
            if (switched) page = switched;
            else page = newPage;
            // A newly opened tab the run is about to drive should be the one on
            // screen (§4).
            await showTab(page, opts);
            logger.info(`Opened new page → ${newPage.url()}${action.as ? ` (as "${action.as}")` : ''}`);
          } catch (err) {
            if (!openError) {
              openError = `openPage failed: ${(err as Error).message}`;
              logger.warn(openError);
            }
          }
        }

        let openShot: string | undefined;
        let openUrl: string | undefined;
        if (openError) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          openShot = shot?.base64;
          openUrl = page.url();
        } else {
          openUrl = page.url();
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(openError !== undefined && { error: openError }),
          ...(openShot !== undefined && { screenshotBase64: openShot }),
          ...(openUrl !== undefined && { pageUrl: openUrl }),
          timestamp: new Date().toISOString(),
        });

        if (openError) {
          turnFailed = true;
          turnError = openError;
          break;
        }
        continue;
      }

      // ── openBrowser action ────────────────────────────────────────────────
      // Spawn a new isolated `Browser` instance and register it on the
      // BrowserTracker. Auto-promotes to active (mirrors openPage's
      // promote-to-active behaviour) so subsequent steps target it without
      // an explicit switchBrowser turn.
      if (action.action === 'openBrowser') {
        let openErr: string | undefined;
        if (!opts.browserTracker) {
          openErr = 'openBrowser failed: browser tracking is not enabled';
          logger.warn(openErr);
        } else if (!action.browserLabel) {
          openErr = 'openBrowser failed: missing required "as" field (label)';
          logger.warn(openErr);
        } else if (opts.browserTracker.has(action.browserLabel)) {
          openErr = `openBrowser failed: label "${action.browserLabel}" is already in use`;
          logger.warn(openErr);
        } else {
          try {
            const overrides: LaunchOverrides = {};
            if (action.engine) overrides.engine = action.engine;
            if (action.channel) overrides.channel = action.channel;
            if (action.headed !== undefined) overrides.headed = action.headed;
            // No `videoDir`: Tier 1 video records only the MAIN page. Omitting it
            // keeps secondary `openBrowser` contexts from writing stray .webm
            // files into videos/ (the report links the main page's video only).
            const newSession = await launchBrowser(config.browser, undefined, overrides);
            opts.browserTracker.add(action.browserLabel, newSession);
            // Active session changed — refresh local `page` so the rest of
            // this turn targets the new browser's active page.
            page = opts.browserTracker.getActivePage();
            logger.info(
              `Opened browser "${action.browserLabel}" (${newSession.engine ?? '?'}${newSession.channel ? '/' + newSession.channel : ''}) — auto-switched to active`,
            );
          } catch (err) {
            openErr = `openBrowser failed: ${(err as Error).message}`;
            logger.warn(openErr);
          }
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(openErr !== undefined && { error: openErr }),
          pageUrl: page.url(),
          timestamp: new Date().toISOString(),
        });

        if (openErr) {
          turnFailed = true;
          turnError = openErr;
          break;
        }
        continue;
      }

      // ── switchBrowser action ─────────────────────────────────────────────
      if (action.action === 'switchBrowser') {
        let switchBrErr: string | undefined;
        if (!opts.browserTracker) {
          switchBrErr = 'switchBrowser failed: browser tracking is not enabled';
        } else if (!action.browserLabel) {
          switchBrErr = 'switchBrowser failed: missing required "to" field';
        } else {
          try {
            opts.browserTracker.switchTo(action.browserLabel);
            page = opts.browserTracker.getActivePage();
            logger.info(`Switched to browser "${action.browserLabel}" (${page.url()})`);
          } catch (err) {
            switchBrErr = `switchBrowser failed: ${(err as Error).message}`;
          }
        }
        if (switchBrErr) logger.warn(switchBrErr);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(switchBrErr !== undefined && { error: switchBrErr }),
          pageUrl: page.url(),
          timestamp: new Date().toISOString(),
        });

        if (switchBrErr) {
          turnFailed = true;
          turnError = switchBrErr;
          break;
        }
        continue;
      }

      // ── closeBrowser action ──────────────────────────────────────────────
      // Permissive — closes whatever label you point it at, including
      // `default` and including the last remaining browser. If the close
      // leaves no active browser, the next step fails naturally with
      // `getActive()`'s "no active browser session" error.
      if (action.action === 'closeBrowser') {
        let closeBrErr: string | undefined;
        if (!opts.browserTracker) {
          closeBrErr = 'closeBrowser failed: browser tracking is not enabled';
        } else if (!action.browserLabel) {
          closeBrErr = 'closeBrowser failed: missing required "as" field';
        } else {
          try {
            await opts.browserTracker.close(action.browserLabel);
            // Best-effort: if the active browser is still alive, refresh
            // `page`. If it's not (we just closed the only browser), keep
            // the stale page reference — the following step will fail with
            // a clear error from getActive() on its next refresh.
            try { page = opts.browserTracker.getActivePage(); } catch { /* no active session */ }
            logger.info(`Closed browser "${action.browserLabel}"`);
          } catch (err) {
            closeBrErr = `closeBrowser failed: ${(err as Error).message}`;
          }
        }
        if (closeBrErr) logger.warn(closeBrErr);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(closeBrErr !== undefined && { error: closeBrErr }),
          pageUrl: (() => { try { return page.url(); } catch { return ''; } })(),
          timestamp: new Date().toISOString(),
        });

        if (closeBrErr) {
          turnFailed = true;
          turnError = closeBrErr;
          break;
        }
        continue;
      }

      // ── switchPage action ──────────────────────────────────────────────────
      if (action.action === 'switchPage') {
        let switchError: string | undefined;
        if (pageTracker && action.page) {
          const targetPage = await pageTracker.switchToAsync(action.page);
          if (targetPage) {
            page = targetPage;
            // The tracker moved where automation goes; this moves what is on
            // screen, so a watching human sees the tab being driven (§4).
            await showTab(page, opts);
            logger.info(`Switched to page: ${action.page} (${targetPage.url()})`);
          } else {
            switchError = `switchPage failed: no page matching "${action.page}"`;
            logger.warn(switchError);
          }
        } else if (!pageTracker) {
          switchError = 'switchPage failed: page tracking is not enabled';
          logger.warn(switchError);
        } else {
          switchError = 'switchPage failed: no "page" field specified';
          logger.warn(switchError);
        }

        // Capture screenshot on failure for debugging
        let switchShot: string | undefined;
        let switchUrl: string | undefined;
        if (switchError) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          switchShot = shot?.base64;
          switchUrl = page.url();
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(switchError !== undefined && { error: switchError }),
          ...(switchShot !== undefined && { screenshotBase64: switchShot }),
          ...(switchUrl !== undefined && { pageUrl: switchUrl }),
          timestamp: new Date().toISOString(),
        });

        if (switchError) {
          turnFailed = true;
          turnError = switchError;
          break;
        }
        continue;
      }

      // ── closePage action ──────────────────────────────────────────────────
      if (action.action === 'closePage') {
        let closeError: string | undefined;
        if (pageTracker && action.page) {
          const result = await pageTracker.closePage(action.page);
          if (result.closed) {
            page = result.activePage;
            logger.info(`Closed page: ${action.page} — active page is now ${page.url()}`);
          } else {
            closeError = `closePage failed: ${result.error}`;
            logger.warn(closeError);
          }
        } else if (!pageTracker) {
          closeError = 'closePage failed: page tracking is not enabled';
          logger.warn(closeError);
        } else {
          closeError = 'closePage failed: no "page" field specified';
          logger.warn(closeError);
        }

        // Capture screenshot on failure for debugging
        let closeShot: string | undefined;
        let closeUrl: string | undefined;
        if (closeError) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          closeShot = shot?.base64;
          closeUrl = page.url();
        }

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(closeError !== undefined && { error: closeError }),
          ...(closeShot !== undefined && { screenshotBase64: closeShot }),
          ...(closeUrl !== undefined && { pageUrl: closeUrl }),
          timestamp: new Date().toISOString(),
        });

        if (closeError) {
          turnFailed = true;
          turnError = closeError;
          break;
        }
        continue;
      }

      // ── API action types ─────────────────────────────────────────────────────
      if (action.action === 'extract_csrf') {
        const csrfResult = await extractCsrfToken(
          page,
          action.selector ?? action.source ?? '',
          action.source,
        ).catch((err) => {
          logger.warn(`CSRF extraction failed: ${String(err)}`);
          return undefined;
        });

        const subDuration = Date.now() - subStartTime;
        const subActionResult: SubActionResult = {
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: subDuration,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
        };

        if (csrfResult) {
          csrfTokens[csrfResult.selector] = csrfResult.token;
          csrfTokens['__latest__'] = csrfResult.token;
        } else {
          subActionResult.error = 'CSRF token could not be extracted';
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          if (shot) { subActionResult.screenshotBase64 = shot.base64; }
          subActionResult.pageUrl = page.url();
          turnFailed = true;
          turnError = subActionResult.error;
        }

        turnSubActions.push(subActionResult);
        if (turnFailed) break;
        continue;
      }

      if (action.action === 'extract_value') {
        // Extraction from prior API responses is handled implicitly by the AI's context —
        // log it as a no-op sub-action so it appears in the report.
        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      if (action.action === 'api_call') {
        // If context describes a Front Proxy or Experience API and the AI didn't set apiMode,
        // default to "browser" so the request carries browser session cookies.
        if (!action.apiMode && contextContent.match(/Type:\s*(Front Proxy|Experience)/i)) {
          action.apiMode = 'browser';
          // On the emitted object too, so the recording keeps saying which mode
          // the call actually ran in. The only write to an emitted action, and
          // it predates this story.
          emitted.apiMode = 'browser';
          logger.debug('Auto-set apiMode to "browser" based on Front Proxy/Experience context');
        }

        const apiSubResult = await executeApiCallAction(
          action, // substituted — the request carries values, not placeholders
          page,
          stepIndex,
          csrfTokens,
          config.api?.requestTimeout,
          apiResponseStore,
          baseUrl,
        );

        const subDuration = Date.now() - subStartTime;
        const subActionResult: SubActionResult = {
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: subDuration,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          ...(apiSubResult.apiCallData !== undefined && { apiCallData: apiSubResult.apiCallData }),
          ...(apiSubResult.error !== undefined && { error: apiSubResult.error }),
          timestamp: new Date().toISOString(),
        };

        if (apiSubResult.failed) {
          const shot = await captureScreenshot(page, config.browser.fullPageScreenshots);
          if (shot) { subActionResult.screenshotBase64 = shot.base64; }
          subActionResult.pageUrl = page.url();
        }

        turnSubActions.push(subActionResult);

        if (apiSubResult.failed) {
          turnFailed = true;
          turnError = apiSubResult.error;
          break;
        }
        continue;
      }

      // ── DOM exploration actions (find/expand) ──────────────────────────────────
      if (action.action === 'find') {
        const searchText = action.value ?? action.condition ?? '';
        const scope = action.selector;
        const result = await findInDom(page, searchText, scope);
        const formatted = formatFindResults(result, searchText, scope);
        explorationResults.push(formatted);
        const scopeLog = scope ? ` in "${scope}"` : '';
        const totalLabel = result.hitHardMax ? `${result.totalMatches}+` : `${result.totalMatches}`;
        logger.info(`find "${searchText}"${scopeLog}: ${result.matches.length} shown / ${totalLabel} total`);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
        });
        // Force needs_reeval so the AI sees the results on the next turn
        aiResponse.needs_reeval = true;
        continue;
      }

      if (action.action === 'expand') {
        const expandSelector = action.selector ?? '';
        const subtree = await expandDomSubtree(page, expandSelector);
        const formatted = formatExpandResult(subtree, expandSelector);
        explorationResults.push(formatted);
        logger.info(`expand "${expandSelector}": ${subtree.length} chars`);

        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: emitted,
          durationMs: Date.now() - subStartTime,
          ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
          timestamp: new Date().toISOString(),
        });
        // Force needs_reeval so the AI sees the expanded content on the next turn
        aiResponse.needs_reeval = true;
        continue;
      }

      // ── Browser action types ─────────────────────────────────────────────────
      // Capture a pre-action page signal (cheap URL + DOM fingerprint) so we can
      // detect "did anything actually change" after the action runs. Skip for
      // observational / control-flow actions that don't mutate the page.
      const preSignal = isMutatingAction(action)
        ? await capturePageSignal(page).catch(() => undefined)
        : undefined;

      // Selector measurement (stories/codebehind-selector-ambiguity.md) rides
      // the same gate as `captureStepContext`: generation is its only consumer,
      // so an ordinary run must not pay two CDP round-trips per
      // element-targeting action for data nobody reads. A cache replay is
      // excluded for the same reason the DOM capture is — a cache hit
      // generates nothing. `browser.ambiguousTarget: 'fail'` is the stated
      // exception: it decides by reading the visible count, so it turns that
      // one call on whatever the mode.
      const result = await traceOp(`action.${action.action}: ${action.description}`, () =>
        executeAction(page, action, baseUrl, opts.signal, {
          measure: opts.captureStepContext === true && !cachedTurnForCapture,
          ambiguousTarget: config.browser.ambiguousTarget,
          ...(opts.uploadPaths !== undefined && { uploadPaths: opts.uploadPaths }),
        }),
      );
      const subDuration = Date.now() - subStartTime;

      // Post-action settle: waits for the page to reflect the action's effect
      // (SPA route swap, redirect chain, toast render, etc.) before we capture
      // the next snapshot. Exits early on "no change at all" (no-op) or once
      // the signal has been stable for settleMs. See waitForPostActionSettle.
      if (preSignal && result.success) {
        await traceOp(`settle.post-action (${action.action})`, () =>
          waitForPostActionSettle(page, { preSignal }),
        ).catch(() => {
          /* settle errors are non-fatal — proceed to capture post-state */
        });
      }

      // Store captured value from "read" / "count" actions into the live parameter map
      if (result.capturedValues !== undefined && action.as && opts.resolvedParameters) {
        // List capture (read multiple: true) — JSON-encode so it round-trips
        // through the string-valued param map. Tools that declare an
        // array-typed parameter decode this back into a typed array at the
        // bridge boundary.
        const json = JSON.stringify(result.capturedValues);
        opts.resolvedParameters[action.as] = json;
        logger.info(
          `Stored ${result.capturedValues.length} captured value${
            result.capturedValues.length === 1 ? '' : 's'
          } as "{{${action.as}}}"`,
        );
      } else if (result.capturedValue !== undefined && action.as && opts.resolvedParameters) {
        opts.resolvedParameters[action.as] = result.capturedValue;
        logger.info(`Stored captured value as "{{${action.as}}}": "${result.capturedValue}"`);
      }

      // Capture state after action (full-page for report visibility).
      // Skipped on cache replay — the per-action DOM is only consumed by
      // the report's sub-action filmstrip, and matches the pre-turn rule:
      // when the AI plan came from cache, we don't pay for DOM serialisation.
      // The post-action screenshot below still runs when the user has opted
      // into the filmstrip, since that's the cheap-and-useful half.
      const postDom = cachedTurnForCapture
        ? ''
        : await traceOp(`captureDomSnapshot (post-${action.action})`, () =>
            captureDomSnapshot(page, {
              ...config.browser.domNoiseReduction,
              maxIframeDepth: config.browser.maxIframeDepth,
              domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
            }),
          ).catch(() => '');
      // The post-action shot is only consumed by the report filmstrip — the AI
      // sees the next pre-turn capture rather than this one — so it gates only
      // on captureScreenshotsPerAction, not on ai.sendScreenshots.
      const postShot = config.browser.captureScreenshotsPerAction !== false
        ? await traceOp(`captureScreenshot (post-${action.action})`, () =>
            captureScreenshot(page, config.browser.fullPageScreenshots),
          )
        : null;
      const postShotBase64 = postShot?.base64;
      const postUrl = page.url();
      const domSnapshotVal = config.reports.includeDomSnapshots ? postDom : undefined;
      turnSubActions.push({
        index: ++globalSubActionIndex,
        action: emitted,
        ...(postShotBase64 !== undefined && { screenshotBase64: postShotBase64 }),
        ...(domSnapshotVal !== undefined && { domSnapshot: domSnapshotVal }),
        ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
        // What the runtime found when it ran this action. `actionsOf` merges
        // it onto the action for generation and for the on-disk recording.
        ...(result.targeting !== undefined && { targeting: result.targeting }),
        // Which upload route ran. A sibling of `targeting`, not a field inside
        // it: generation decides "was this action measured" by whether
        // `targeting` exists, so an upload carrying only a route would read as
        // measured and take the wrong selector rules.
        ...(result.upload !== undefined && { upload: result.upload }),
        durationMs: subDuration,
        ...(result.error !== undefined && { error: result.error }),
        pageUrl: postUrl,
        timestamp: new Date().toISOString(),
      });

      // After a successful "wait" on a CSRF-related selector, automatically extract and
      // cache the token value so a subsequent api_call can inject it without needing an
      // explicit extract_csrf action from the AI.
      if (result.success && action.action === 'wait') {
        const waitSelector = action.condition ?? action.value ?? '';
        if (/csrf|__RequestVerificationToken/i.test(waitSelector)) {
          const csrfResult = await extractCsrfToken(page, waitSelector).catch(() => undefined);
          if (csrfResult) {
            csrfTokens[csrfResult.selector] = csrfResult.token;
            csrfTokens['__latest__'] = csrfResult.token;
            logger.debug(`Auto-extracted CSRF token after wait on: ${waitSelector}`);
          }
        }
      }

      if (!result.success) {
        turnFailed = true;
        turnError = result.error;

        // Build list of actions that succeeded before this failure
        const currentTurnSucceeded = aiResponse.actions
          .slice(0, aiResponse.actions.indexOf(emitted))
          .filter((a) => a.action !== 'assert' && a.action !== 'prompt')
          .map((a) => ({ action: a.action, description: a.description }));
        const allSucceeded = [
          ...allCompletedActions.map((a) => ({ action: a.action, description: a.description })),
          ...currentTurnSucceeded,
        ];

        // Collect failure context so retry gets richer info
        const currentUrl = page.url();
        if (result.retryable === false) turnNonRetryable = true;
        collectedFailures.push({
          selector: result.failedSelector ?? action.selector ?? '',
          error: result.error ?? 'Unknown error',
          ...(result.matchCount !== undefined && { matchCount: result.matchCount }),
          actionType: action.action,
          ...(allSucceeded.length > 0 && { completedActions: allSucceeded }),
          startUrl: attemptStartUrl,
          failureUrl: currentUrl,
          navigated: currentUrl !== attemptStartUrl,
        });
        break;
      }
    }

    // Track non-assert/prompt actions for the continuation prompt on the next turn
    allCompletedActions.push(
      ...aiResponse.actions
        .filter((a) => a.action !== 'assert' && a.action !== 'prompt')
        .map((a) => ({
          action: a.action,
          description: a.description,
          ...(a.selector ? { selector: a.selector } : {}),
        })),
    );

    // Remember whether this turn's effective action was a "wait" so next turn
    // can detect a stall (wait → nothing changed → wait again).
    lastActionWasWait = aiResponse.actions.some((a) => a.action === 'wait');

    // Finalize this turn
    allTurns.push({
      turnNumber: currentTurn,
      attemptNumber,
      timestamp: turnTimestamp,
      aiInteractions: turnAiInteractions,
      subActions: turnSubActions,
    });

    if (turnFailed) {
      // The turn is finalised above before this throws, so a deliberate failure's
      // `fail` sub-action is in the report like any other.
      throw new StepFailureError(
        turnError ?? 'Step failed',
        collectedFailures,
        allTurns,
        !turnNonRetryable,
        deliberateFailure,
      );
    }

    // 9. The step returned: it is over whatever `needs_reeval` says. A model
    // that asked for another turn after ending the flow would be asking to act
    // inside a flow that no longer exists.
    if (flowControlSignal) {
      break;
    }

    // 9a. Check needs_reeval: if false/absent, the step is complete after this turn
    if (!aiResponse.needs_reeval) {
      break;
    }

    // needs_reeval is true — enforce the turn cap
    if (currentTurn === maxTurns) {
      throw new StepFailureError(
        `Step failed: multi-turn limit reached (${maxTurns} turns).\nLast URL: ${page.url()}`,
        [],
        allTurns,
      );
    }

    logger.info(`Turn ${currentTurn} complete (needs_reeval=true) — starting turn ${currentTurn + 1}`);
  }

  // (Assertions are evaluated inline within the action loop above — no
  // post-turn assertion phase.)

  } catch (err) {
    if (err instanceof StepFailureError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StepFailureError(message, collectedFailures, allTurns);
  } finally {
    for (const t of activityTrackers.values()) t.dispose();
    activityTrackers = new Map();
  }

  const durationMs = Date.now() - startTime;

  if (controlSignal && controlSignal.kind === 'clarification-unavailable') {
    // Server-driven run with no interactive console: the AI asked a
    // question we can't answer here. Fail the step with the question as the
    // error rather than blocking on stdin. See issues/014.
    //
    // Through the tail seam as well (decisions 5 and 6): it is the one failure
    // that RETURNS rather than throws, so the outer catch never sees it, and a
    // step the author wrote `otherwise continue` on that stops the run because
    // the model asked a question is exactly the stop the tail prevents. The
    // REPL's own `/exit` result below is deliberately NOT routed through it —
    // that is the user ending the run, not the step failing.
    return applyFailureTail({
      index: stepIndex,
      instruction,
      status: 'failed',
      turns: allTurns,
      ...(assertionResults.length > 0 && { assertions: assertionResults }),
      pageUrl: page.url(),
      durationMs,
      retried,
      aiExplanation: `AI asked for clarification: ${controlSignal.question}`,
      error:
        `AI needs clarification, but this run has no interactive prompt ` +
        `to answer it: ${controlSignal.question}`,
    }, opts);
  }

  if (controlSignal) {
    // User took control inside the AI clarification REPL. Return a fully
    // formed StepResult with `runnerControl` set so the test-runner can
    // jump or bail without re-entering the failure-handoff REPL on top.
    const isExit = controlSignal.kind === 'exit';
    const endPageUrl = page.url();
    const adHocPayload = clarificationAdHoc.length > 0
      ? { adHocResults: clarificationAdHoc }
      : {};
    const runnerControl: StepResult['runnerControl'] = isExit
      ? { kind: 'exit', ...adHocPayload }
      : {
          kind: 'resume',
          fromStepIndex: (controlSignal as { kind: 'resume'; fromStepIndex: number }).fromStepIndex,
          ...adHocPayload,
        };
    return {
      index: stepIndex,
      instruction,
      status: isExit ? 'failed' : 'passed',
      turns: allTurns,
      ...(assertionResults.length > 0 && { assertions: assertionResults }),
      pageUrl: endPageUrl,
      durationMs,
      retried,
      aiExplanation: isExit
        ? 'User exited the AI clarification REPL'
        : `User resumed from the AI clarification REPL at step ${(controlSignal as { kind: 'resume'; fromStepIndex: number }).fromStepIndex}`,
      ...(isExit && { error: 'user exited from clarification REPL' }),
      ...(controlSignal.kind === 'resume' && { interactiveResumed: true }),
      runnerControl,
    };
  }

  if (stepFailed) {
    throw new StepFailureError(stepError ?? 'Step failed', collectedFailures, allTurns);
  }

  // Capture end-of-step screenshot (full-page for report visibility).
  // Gated by captureScreenshotsPerAction so users can fully suppress non-failure
  // captures. On-failure / diagnose captures still fire.
  const endScreenshot = config.browser.captureScreenshotsPerAction !== false
    ? await captureScreenshot(page, config.browser.fullPageScreenshots)
    : null;
  const endScreenshotBase64 = endScreenshot?.base64;
  const endPageUrl = page.url();

  const domSnapshotForStep = config.reports.includeDomSnapshots ? firstTurnDomSnapshot : undefined;
  // Compile's Record input. One extra DOM snapshot per step, taken only when
  // the caller asked: the generator writes a post-condition worth having when
  // it can see what the step actually produced.
  const stepContext = opts.captureStepContext
    ? {
        ...(firstTurnDomSnapshot && { domBefore: firstTurnDomSnapshot }),
        ...(firstTurnUrl && { urlBefore: firstTurnUrl }),
        ...(await captureStepEndDom(page, config)),
        urlAfter: endPageUrl,
      }
    : undefined;
  return {
    index: stepIndex,
    instruction,
    status: 'passed',
    turns: allTurns,
    ...(assertionResults.length > 0 && { assertions: assertionResults }),
    ...(endScreenshotBase64 !== undefined && { screenshotBase64: endScreenshotBase64 }),
    pageUrl: endPageUrl,
    ...(domSnapshotForStep !== undefined && { domSnapshot: domSnapshotForStep }),
    ...(stepContext !== undefined && { stepContext }),
    durationMs,
    retried,
    // A returning step explains itself with the model's own account of why the
    // condition held. The run loop prefixes it with the flow's name — the
    // executor has no expansion and cannot know whether this is "Sign in" or
    // the whole test (stories/step-flow-control.md).
    aiExplanation: flowControlSignal
      ? (flowControlDetail?.trim() || lastAiResponse?.reasoning || '')
      : (lastAiResponse?.reasoning ?? 'No reasoning provided'),
    ...(flowControlSignal && { flowControl: flowControlSignal }),
  };
}

/** Post-step DOM for `stepContext`. Non-fatal by the same policy as every
 *  other capture: a page mid-navigation yields no `domAfter`, not a failed
 *  step that otherwise passed. */
async function captureStepEndDom(
  page: Page,
  config: Config,
): Promise<{ domAfter?: string }> {
  try {
    const dom = await captureDomSnapshot(page, {
      ...config.browser.domNoiseReduction,
      maxIframeDepth: config.browser.maxIframeDepth,
      domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
    });
    return dom ? { domAfter: dom } : {};
  } catch (err) {
    logger.debug(`Post-step DOM capture failed: ${String(err)}`);
    return {};
  }
}

interface ApiCallSubResult {
  failed: boolean;
  error?: string;
  apiCallData?: ApiCallData;
}

interface EvaluateAssertionParams {
  page: Page;
  stepIndex: number;
  /** Frame-scoped on-disk cache id for this step's assertion files
   *  (`step-<cacheKey>-asserts.json`); see `StepExecutorOptions.cacheKey`.
   *  Distinct from `stepIndex`, which is the display/source line. */
  cacheKey: StepCacheKey;
  assertIndex: number;
  turnNumber: number;
  subActionIndex: number;
  condition: string;
  expected: string | undefined;
  description: string;
  against: 'dom' | 'api' | 'both' | 'predicate';
  poll: { timeoutMs?: number; intervalMs?: number } | undefined;
  contextContent: string;
  testName: string;
  baseUrl: string | undefined;
  aiClient: AiClient;
  stepCache: StepCache | undefined;
  cacheEnabled: boolean;
  resolvedParams: Record<string, string>;
  apiResponseStore: ApiResponseStore | undefined;
  attemptNumber: number;
  dismissalGuidance: boolean;
  fullPageScreenshots: boolean;
  sendScreenshots: boolean;
  /** Run abort signal — forwarded to the assertion code-gen AI call. See issues/020. */
  signal?: AbortSignal;
}

const DEFAULT_POLL_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_ASSERTION_CODE_ATTEMPTS = 2;

/**
 * Evaluate a single `assert` action inline against the current page state.
 *
 * Cache-first: looks up cached JS code by (stepIndex, assertIndex, fingerprint).
 * On a cache hit, runs `page.evaluate(code)` directly — zero AI calls.
 * On a miss, asks the AI for evaluation code, caches it, runs it.
 *
 * If `poll` is set, the JS code is re-run in a loop until `pass: true` or the
 * timeout. If the JS throws or returns the wrong shape, the cached code is
 * invalidated and regenerated — up to 2 attempts.
 */
async function evaluateAssertion(p: EvaluateAssertionParams): Promise<AssertionResult> {
  const fingerprint = fingerprintAssertion(p.condition, p.expected, p.assertIndex);

  // 1. Try cache
  let assertionCode: string | null = null;
  let fromCache = false;
  if (p.stepCache && p.cacheEnabled) {
    assertionCode = await p.stepCache.readAssertion(p.cacheKey, p.assertIndex, fingerprint, p.resolvedParams);
    fromCache = assertionCode !== null;
  }

  let aiInteraction: AiInteraction | undefined;
  let evalResult: { pass: boolean; actual: string } | null = null;
  let lastErr: string | undefined;

  for (let attempt = 1; attempt <= MAX_ASSERTION_CODE_ATTEMPTS; attempt++) {
    // 2. Generate code on cache miss / regenerate on failure
    if (!assertionCode) {
      // Predicate mode: nothing in the DOM or API needs to be fetched —
      // both sides of the comparison are already in `condition`. Skip
      // DOM capture, screenshot, and API history entirely. Saves tokens
      // and removes irrelevant context from the AI's prompt.
      const skipDomAndScreenshot = p.against === 'api' || p.against === 'predicate';
      const fullDom = skipDomAndScreenshot
        ? null
        : await captureDomSnapshot(p.page, {
            collapseRepetitiveDom: false,
            compactSvg: false,
            hideHiddenInputs: false,
            hideDisplayNoneElements: false,
            hideAriaHiddenElements: false,
            useDomAttributeAllowlist: false,
            dropUnstableIds: false,
          });
      const finalShot = p.sendScreenshots && !skipDomAndScreenshot
        ? await captureScreenshot(p.page, p.fullPageScreenshots)
        : null;

      const apiHistory = p.apiResponseStore?.hasResponses()
        ? p.apiResponseStore.formatForContext()
        : undefined;

      const codeMsg = buildAssertionCodePrompt(
        p.description,
        p.condition,
        p.expected,
        fullDom,
        finalShot?.base64 ?? null,
        apiHistory,
        p.against,
        formatTestInfo(p.testName, p.baseUrl),
      );

      const apiContext: ApiPromptContext | undefined = p.contextContent.includes('Type:')
        ? { hasApiContext: true, responseHistory: apiHistory ?? '' }
        : undefined;

      const assertSystemPrompt = buildSystemPrompt(p.contextContent, apiContext, {
        dismissalGuidance: p.dismissalGuidance,
      });
      const codeCompletion = await p.aiClient.complete([
        { role: 'system', content: assertSystemPrompt },
        codeMsg,
      ], p.signal, { profile: 'authoring' });

      aiInteraction = {
        purpose: `assertion[${p.assertIndex}]`,
        attemptNumber: p.attemptNumber,
        requestMessages: [
          { role: 'system', content: extractTextFromMessage({ role: 'system', content: assertSystemPrompt }) },
          { role: 'user', content: extractTextFromMessage(codeMsg) },
        ],
        response: codeCompletion.text,
        model: codeCompletion.model,
        ...(finalShot?.base64 !== undefined && { screenshotBase64: finalShot.base64 }),
        pageUrl: p.page.url(),
        timestamp: new Date().toISOString(),
      };

      try {
        assertionCode = parseAssertionCode(codeCompletion.text);
      } catch (parseErr) {
        lastErr = `Could not parse assertion code: ${String(parseErr)}`;
        continue;
      }

      if (p.stepCache && p.cacheEnabled) {
        await p.stepCache.writeAssertion(
          p.cacheKey,
          p.assertIndex,
          fingerprint,
          assertionCode,
          p.resolvedParams,
        );
      }
    }

    // 3. Run the JS — with optional polling
    try {
      evalResult = await runAssertionCode(p.page, assertionCode, p.poll);
      if (!evalResult || typeof evalResult.pass !== 'boolean' || typeof evalResult.actual !== 'string') {
        throw new Error(`Assertion code returned unexpected shape: ${JSON.stringify(evalResult)}`);
      }
      break; // success — got a structured result (pass or fail)
    } catch (codeErr) {
      lastErr = String(codeErr);
      logger.warn(`Assertion code failed (attempt ${attempt}/${MAX_ASSERTION_CODE_ATTEMPTS}): ${lastErr}`);
      if (p.stepCache) await p.stepCache.invalidateAssertion(p.cacheKey, p.assertIndex);
      assertionCode = null; // force regeneration on next loop iteration
      fromCache = false;
    }
  }

  if (!evalResult) {
    throw new Error(`Assertion code failed after ${MAX_ASSERTION_CODE_ATTEMPTS} attempts: ${lastErr ?? 'unknown error'}`);
  }

  logger.assertion(evalResult.pass, evalResult.actual, p.description);

  // Predicate-mode failures don't have a literal `expected` to quote — the
  // explanation references the predicate text itself instead.
  const failureExplanation = p.against === 'predicate'
    ? `Predicate "${p.condition}" was false: ${evalResult.actual}`
    : `Expected "${p.expected ?? ''}", got "${evalResult.actual}"`;

  return {
    assertIndex: p.assertIndex,
    turnNumber: p.turnNumber,
    subActionIndex: p.subActionIndex,
    description: p.description,
    condition: p.condition,
    expected: p.expected,
    against: p.against,
    actual: evalResult.actual,
    pass: evalResult.pass,
    explanation: evalResult.pass ? 'Assertion passed' : failureExplanation,
    fromCache,
    ...(assertionCode !== null && { assertionCode }),
    ...(aiInteraction !== undefined && { aiInteraction }),
  };
}

/** Run assertion JS code, optionally polling until pass or timeout. */
async function runAssertionCode(
  page: Page,
  code: string,
  poll: { timeoutMs?: number; intervalMs?: number } | undefined,
): Promise<{ pass: boolean; actual: string }> {
  if (!poll) {
    return await page.evaluate(code) as { pass: boolean; actual: string };
  }

  const timeoutMs = poll.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = poll.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let lastResult = await page.evaluate(code) as { pass: boolean; actual: string };
  while (!lastResult.pass && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    lastResult = await page.evaluate(code) as { pass: boolean; actual: string };
  }
  return lastResult;
}

/**
 * Execute an api_call action using either the Playwright browser context or standalone fetch.
 * Stores the response in the provided ApiResponseStore for subsequent steps.
 */
async function executeApiCallAction(
  action: AIAction,
  page: Page,
  stepIndex: number,
  csrfTokens: Record<string, string>,
  requestTimeout: number | undefined,
  apiResponseStore?: ApiResponseStore,
  baseUrl?: string,
): Promise<ApiCallSubResult> {
  const method = (action.method ?? 'GET').toUpperCase();
  let url = action.url ?? '';

  // Resolve relative URLs against baseUrl or the current page URL
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    const base = baseUrl ?? page.url();
    if (base) {
      try {
        url = new URL(url, base).toString();
        logger.debug(`Resolved relative API URL to: ${url}`);
      } catch {
        // If URL resolution fails, leave as-is and let the fetch fail with a clear error
      }
    }
  }

  if (!url) {
    return { failed: true, error: 'api_call action missing required "url" field' };
  }

  // Merge AI-provided headers with any extracted CSRF token
  const headers: Record<string, string> = { ...(action.apiHeaders ?? {}) };

  // The AI sometimes emits template placeholders like {{csrfToken}} instead of the real
  // value.  Strip out any such placeholder so the injection logic below can fill it in.
  const csrfHeaderKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === 'x-csrf-token',
  );
  if (csrfHeaderKey && /^\{\{.*\}\}$/.test(headers[csrfHeaderKey] ?? '')) {
    logger.info(`Replacing CSRF placeholder "${headers[csrfHeaderKey]}" with real token`);
    delete headers[csrfHeaderKey];
  }

  // If no CSRF token has been captured yet, opportunistically try to extract one from
  // the current page.  This handles the case where the AI skips the navigate/wait steps
  // and goes straight to the api_call without an explicit extract_csrf action.
  if (!csrfTokens['__latest__'] && !headers['x-csrf-token'] && !headers['X-CSRF-Token']) {
    const autoResult = await extractCsrfToken(page, '').catch(() => undefined);
    if (autoResult) {
      csrfTokens[autoResult.selector] = autoResult.token;
      csrfTokens['__latest__'] = autoResult.token;
      logger.debug(`Pre-flight CSRF extraction succeeded via: ${autoResult.selector}`);
    }
  }

  // Inject the latest CSRF token if the AI hasn't already provided one
  const csrfToken = csrfTokens['__latest__'];
  if (csrfToken && !headers['x-csrf-token'] && !headers['X-CSRF-Token']) {
    headers['x-csrf-token'] = csrfToken;
  }

  const callOpts = {
    method,
    url,
    headers,
    body: action.body,
    timeoutMs: requestTimeout ?? 30_000,
  };

  logger.subAction(`API ${method} ${url}`);

  try {
    const apiResult = action.apiMode === 'browser'
      ? await callApiBrowserContext(page, callOpts)
      : await callApiStandalone(callOpts);

    // Store in response store for subsequent steps
    if (apiResponseStore) {
      const endpointPath = extractEndpointPath(url);
      apiResponseStore.add({
        stepNumber: stepIndex,
        endpoint: endpointPath,
        method,
        url,
        ...(action.body !== undefined && { requestBody: action.body }),
        status: apiResult.status,
        headers: apiResult.headers,
        body: apiResult.body,
        timestamp: Date.now(),
      });
    }

    const apiCallData: ApiCallData = {
      method,
      url,
      ...(action.body !== undefined && { requestBody: action.body }),
      ...(Object.keys(headers).length > 0 && { requestHeaders: headers }),
      status: apiResult.status,
      responseHeaders: apiResult.headers,
      responseBody: apiResult.body,
    };

    logger.info(`API response: ${apiResult.status} (${apiResult.durationMs}ms) — mode: ${action.apiMode ?? 'standalone'}`);
    logger.info(`API response body preview: ${JSON.stringify(apiResult.body).substring(0, 200)}`);

    return { failed: false, apiCallData };
  } catch (err) {
    const errorMsg = `API call failed: ${String(err)}`;
    logger.error(errorMsg);
    return { failed: true, error: errorMsg };
  }
}

/** Extract just the path portion from a full URL for display purposes */
function extractEndpointPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Execute a group of conditional steps as a multi-outcome branch.
 *
 * Waits for the page to settle, then asks the AI which outcome appeared and
 * executes the matching step. Steps that don't match are marked "skipped".
 *
 * Returns one StepResult per step in the group plus the index of the last
 * step consumed (so the caller can skip ahead).
 */
/**
 * A branch step's substituted form. `identifyStepGroups` reads the raw step
 * list and never interpolates, so before this a matched branch step typed
 * `{{email}}` into the page as six literal characters
 * (stories/placeholder-preserving-actions.md §Executor). The model still sees
 * the authored text — it is passed alongside as `authoredInstruction` — so the
 * fix arrives twice over: the model names the placeholder and the executor
 * substitutes it, and the step's own text resolves too.
 */
function substituteBranchInstruction(instruction: string, opts: StepExecutorOptions): string {
  return substituteText(instruction, {
    parameters: opts.resolvedParameters ?? {},
    ...(opts.envData !== undefined && { envData: opts.envData }),
  });
}

/**
 * How long the condition judge may keep re-asking while the model answers
 * `waiting` (stories/control-flow.md, decision 4).
 *
 * A module constant rather than config, deliberately: the window exists for a
 * page that is visibly mid-transition, not to wait for a state to arrive — the
 * watch form (`If <cond>, <action>` with no `then`) is what waits, and it
 * already honours `execution.timeout`. Making this configurable would invite
 * authors to turn a decision into a slow watch.
 */
export const CONDITION_JUDGE_BUDGET_MS = 30_000;
/** Gap between re-asks inside that budget — the branched step's poll interval. */
const CONDITION_JUDGE_POLL_MS = 3_000;

/** What one judge call returned. */
export interface ConditionVerdict {
  /** Index into the `conditions` array of the FIRST condition that held, or
   *  null for "none of them". Never an index the caller did not supply. */
  selected: number | null;
  /** The model's own words, for the guard's report row. */
  reasoning: string;
  /** Every judge turn, so a guard's cost and its raw answers are as visible in
   *  the report as an ordinary step's. */
  aiInteractions: AiInteraction[];
}

/**
 * Ask the model which of `conditions` holds on the page now
 * (stories/control-flow.md §"Condition evaluation").
 *
 * One call for a whole chain, first-holds-wins (decision 5); one call per pass
 * for a `While` / `Repeat`. It **never performs an action** — the selected
 * tail's steps do that, through `executeStep`, which is why a plain-instruction
 * tail costs two model turns where the watch form costs one.
 *
 * Settles the page first (the branched step's own 10 s / 1 s gate), then
 * re-asks every 3 s while the answer is `waiting` or malformed, for
 * {@link CONDITION_JUDGE_BUDGET_MS}. Still waiting at the end **throws**, and
 * the caller turns that into a failed guard: a decision that cannot be made is
 * not the same as a decision that came out false.
 *
 * `conditions` is the AUTHORED text, placeholders intact.
 */
export async function evaluateConditions(
  conditions: string[],
  opts: StepExecutorOptions,
): Promise<ConditionVerdict> {
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory, pageTracker } = opts;
  const page = pageTracker ? pageTracker.getActive() : opts.page;
  const startTime = Date.now();
  const deadline = startTime + CONDITION_JUDGE_BUDGET_MS;
  const aiInteractions: AiInteraction[] = [];

  // The same gate the watch form opens with, and for the same reason: a page
  // that is still painting answers a different question from the one asked.
  await waitForPageStability(page, {
    timeoutMs: Math.min(10_000, config.execution.timeout * 1000),
    quiesceMs: 1000,
  });

  // Every `{{name}}` and `${…}` any condition references, with what it holds
  // now — built off the joined authored text so one block covers the chain.
  const values = buildStepValues(conditions.join('\n'), opts);

  let poll = 0;
  for (;;) {
    poll++;
    if (opts.signal?.aborted) {
      throw new DOMException('Run aborted by client', 'AbortError');
    }

    const domSnapshot = await captureDomSnapshot(page, {
      ...config.browser.domNoiseReduction,
      maxIframeDepth: config.browser.maxIframeDepth,
      domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
    });
    const screenshot = config.ai.sendScreenshots
      ? await captureScreenshot(page, config.browser.fullPageScreenshots)
      : null;
    const screenshotBase64 = screenshot?.base64 ?? null;

    const openPages = pageTracker && pageTracker.count > 1
      ? await pageTracker.getPageListWithTitles()
      : undefined;

    const userMessage = buildConditionJudgeMessage(
      conditions,
      // Masked for the MODEL only, the same one line the step prompt applies
      // to the same string. The snapshot now carries LIVE form values, so a
      // secret this run typed into an ordinary text field is in it — and the
      // judge, one turn after a step that showed `••••`, would otherwise read
      // it in full (review 3, finding 2). Nothing stored is redacted here:
      // `redactReport` covers what is written.
      redact(domSnapshot, secretsFor(opts)),
      screenshotBase64,
      conversationHistory,
      openPages,
      // No step numbers: a guard is not the Nth of N steps in any sense the
      // model could use, and `formatTestInfo` omits the line when they are
      // absent rather than printing "Step 0 of 0".
      formatTestInfo(
        testName,
        baseUrl,
        undefined,
        undefined,
        config.browser.headed ? config.browser.windowSize : config.browser.viewport,
        buildActiveBrowserInfo(opts.browserTracker),
      ),
      values,
    );
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(contextContent, undefined, {
          dismissalGuidance: opts.dismissalGuidance ?? false,
        }),
      },
      userMessage,
    ];

    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch { /* a page mid-navigation still gets judged; the URL is a label */ }

    const completion = await aiClient.complete(messages, opts.signal);
    aiInteractions.push({
      purpose: 'condition-judge',
      requestMessages: messages.map((m) => ({ role: m.role, content: extractTextFromMessage(m) })),
      response: completion.text,
      ...(completion.model !== undefined && { model: completion.model }),
      ...(screenshotBase64 !== null && { screenshotBase64 }),
      pageUrl: currentUrl,
      timestamp: new Date().toISOString(),
    });

    let verdict: BranchedAIResponse | undefined;
    try {
      // `actionsOptional`: the judge is told to return an empty array, and a
      // model that simply omits the key has answered correctly. Counting that
      // as malformed would spend the budget re-asking a question already
      // answered.
      verdict = parseBranchedResponse(completion.text, { actionsOptional: true });
    } catch (err) {
      logger.warn(
        `Condition judge poll ${poll}: malformed AI response — ${(err as Error).message}. Retrying.`,
      );
    }

    if (verdict) {
      const answer = verdict.matched.trim().toUpperCase();
      if (answer === 'NONE') {
        logger.debug(`Condition judge: none held — ${verdict.reasoning}`);
        return { selected: null, reasoning: verdict.reasoning, aiInteractions };
      }
      if (answer !== 'WAITING') {
        const index = answer.length === 1 ? answer.charCodeAt(0) - 65 : -1;
        if (index >= 0 && index < conditions.length) {
          logger.debug(
            `Condition judge: ${answer} ("${conditions[index]}") held — ${verdict.reasoning}`,
          );
          return { selected: index, reasoning: verdict.reasoning, aiInteractions };
        }
        // A label naming no condition is as unusable as no label at all, so it
        // is a malformed answer and gets a re-ask rather than a guess.
        logger.warn(
          `Condition judge poll ${poll}: AI returned unknown outcome label "${verdict.matched}". Retrying.`,
        );
      }
    }

    if (Date.now() + CONDITION_JUDGE_POLL_MS >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, CONDITION_JUDGE_POLL_MS));
    await waitForPageStability(page, {
      timeoutMs: Math.max(0, Math.min(5000, deadline - Date.now())),
      quiesceMs: 500,
    });
  }

  throw new Error(
    `could not decide: the page did not settle within ` +
      `${Math.round(CONDITION_JUDGE_BUDGET_MS / 1000)}s while judging "${conditions[0] ?? ''}"`,
  );
}

export async function executeBranchedStep(
  group: StepGroup,
  totalSteps: number,
  opts: StepExecutorOptions,
): Promise<StepResult[]> {
  const startTime = Date.now();
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory, pageTracker } = opts;
  const page = pageTracker ? pageTracker.getActive() : opts.page;
  const timeout = config.execution.timeout * 1000; // seconds → ms
  const pollInterval = 3000; // 3s between polls
  const deadline = Date.now() + timeout;

  // Build outcome labels: conditionals first, then continuation
  const outcomes: BranchOutcome[] = [];
  const labelMap = new Map<string, { index: number; instruction: string; isConditional: boolean }>();
  let labelChar = 65; // 'A'

  for (const cs of group.conditionalSteps) {
    const label = String.fromCharCode(labelChar++);
    outcomes.push({ label, instruction: cs.instruction, isConditional: true });
    labelMap.set(label, { index: cs.index, instruction: cs.instruction, isConditional: true });
  }
  {
    const label = String.fromCharCode(labelChar);
    outcomes.push({ label, instruction: group.continuationStep.instruction, isConditional: false });
    labelMap.set(label, { index: group.continuationStep.index, instruction: group.continuationStep.instruction, isConditional: false });
  }

  logger.info(`Branched step: ${outcomes.length} outcomes (${group.conditionalSteps.length} conditional + 1 continuation)`);

  // Wait for page stability before the first evaluation
  await waitForPageStability(page, {
    timeoutMs: Math.min(10_000, timeout),
    quiesceMs: 1000,
  });

  // Polling loop: ask AI which outcome matches
  let matched: BranchedAIResponse | null = null;
  let pollCount = 0;
  const maxPolls = Math.max(1, Math.ceil(timeout / pollInterval));

  while (Date.now() < deadline && pollCount < maxPolls) {
    pollCount++;

    // Abort check — stop polling immediately if the run was stopped. See issues/020.
    if (opts.signal?.aborted) {
      throw new DOMException('Run aborted by client', 'AbortError');
    }

    const domSnapshot = await captureDomSnapshot(page, {
      ...config.browser.domNoiseReduction,
      maxIframeDepth: config.browser.maxIframeDepth,
      domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
    });
    // Capture if either consumer needs it: AI (sees this frame on this poll)
    // or report (per-action filmstrip via captureScreenshotsPerAction).
    const wantPollShot = config.ai.sendScreenshots || config.browser.captureScreenshotsPerAction !== false;
    const screenshot = wantPollShot
      ? await captureScreenshot(page, config.browser.fullPageScreenshots)
      : null;
    const screenshotBase64 = screenshot?.base64;

    const openPages = pageTracker && pageTracker.count > 1
      ? await pageTracker.getPageListWithTitles()
      : undefined;

    const screenshotForAi = config.ai.sendScreenshots ? (screenshotBase64 ?? null) : null;
    const branchedTestInfo = formatTestInfo(
      testName,
      baseUrl,
      group.conditionalSteps[0]!.index,
      totalSteps,
      config.browser.headed ? config.browser.windowSize : config.browser.viewport,
      buildActiveBrowserInfo(opts.browserTracker),
    );
    const userMessage = buildBranchedStepMessage(
      outcomes,
      // Same masking as the step prompt and the condition judge — see
      // `secretsFor`. This poller reads the page on every poll of a watch
      // group, so it is the other prompt the live snapshot reaches.
      redact(domSnapshot, secretsFor(opts)),
      screenshotForAi,
      conversationHistory,
      openPages,
      branchedTestInfo,
    );

    const systemPrompt = buildSystemPrompt(contextContent, undefined, {
      dismissalGuidance: opts.dismissalGuidance ?? false,
    });

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      userMessage,
    ];

    const { text: rawResponse } = await aiClient.complete(messages, opts.signal);
    let branchedResponse: BranchedAIResponse;
    try {
      branchedResponse = parseBranchedResponse(rawResponse);
    } catch (err) {
      // The LLM occasionally returns a malformed branched response (e.g. omits
      // the required `matched` field). Treat as a failed poll and continue —
      // never let parser errors escape and crash the CLI.
      logger.warn(
        `Branch poll ${pollCount}: malformed AI response — ${(err as Error).message}. Retrying.`,
      );
      if (Date.now() + pollInterval < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        await waitForPageStability(page, {
          timeoutMs: Math.min(5000, deadline - Date.now()),
          quiesceMs: 500,
        });
      }
      continue;
    }

    logger.debug(`Branch poll ${pollCount}: matched="${branchedResponse.matched}" — ${branchedResponse.reasoning}`);

    if (branchedResponse.matched !== 'waiting') {
      matched = branchedResponse;
      break;
    }

    // Wait before polling again
    if (Date.now() + pollInterval < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      // Wait for any page changes to settle
      await waitForPageStability(page, {
        timeoutMs: Math.min(5000, deadline - Date.now()),
        quiesceMs: 500,
      });
    }
  }

  // Build results
  const results: StepResult[] = [];

  if (!matched) {
    // Timed out waiting — fail all steps in the group
    const durationMs = Date.now() - startTime;
    for (const cs of group.conditionalSteps) {
      results.push({
        index: cs.index,
        instruction: cs.instruction,
        status: 'failed',
        turns: [],
        durationMs,
        retried: false,
        error: `Branched step timed out after ${pollCount} polls — page never settled into a recognisable state`,
        aiExplanation: 'Timed out waiting for page to settle into one of the expected outcomes',
      });
    }
    results.push({
      index: group.continuationStep.index,
      instruction: group.continuationStep.instruction,
      status: 'failed',
      turns: [],
      durationMs,
      retried: false,
      error: 'Branched step timed out — continuation not reached',
      aiExplanation: 'Timed out waiting for conditional resolution',
    });
    return results;
  }

  // Matched an outcome — execute it through the normal step executor
  const matchedOutcome = labelMap.get(matched.matched.toUpperCase());
  if (!matchedOutcome) {
    // AI returned an unexpected label — treat as failure
    const durationMs = Date.now() - startTime;
    for (const cs of group.conditionalSteps) {
      results.push({
        index: cs.index,
        instruction: cs.instruction,
        status: 'failed',
        turns: [],
        durationMs,
        retried: false,
        error: `AI returned unknown outcome label "${matched.matched}"`,
        aiExplanation: matched.reasoning,
      });
    }
    return results;
  }

  logger.info(`Branched step resolved: outcome ${matched.matched} → step ${matchedOutcome.index} "${matchedOutcome.instruction}"`);

  // Execute the matched step normally (the AI already returned actions)
  let matchedResult: StepResult;
  if (matched.actions.length > 0) {
    // Execute the actions the AI returned in the branch response
    matchedResult = await executeStep(
      matchedOutcome.index,
      totalSteps,
      substituteBranchInstruction(matchedOutcome.instruction, opts),
      // Cache by the 1-based step identity (issue 017). `matchedOutcome.index`
      // is the group's 0-based array index, but the normal step loop keys the
      // cache as `executeStep(i + 1, …)`; without this override a branched step
      // and a normal step one position apart would share `step-<n>.json`.
      // `result.index` stays 0-based for the skip/display logic below.
      //
      // `flowControlClaim` is cleared for the reason it is cleared at the REPL
      // seam: a claim is read off ONE authored line, and the line running here
      // is a group member, not the line the claim was parsed from. The grouper
      // never puts a flow-control step in a group (decision 7), so a claim
      // reaching this call is already a claim about a different step. Same for
      // `failureTail` (stories/step-failure-outcomes.md, decision 4).
      {
        ...opts,
        cacheKey: matchedOutcome.index + 1,
        flowControlClaim: undefined,
        failureTail: undefined,
      },
      matchedOutcome.instruction,
    );
  } else {
    // No actions needed (e.g. continuation step = "Wait for dashboard" and dashboard is already loaded)
    matchedResult = {
      index: matchedOutcome.index,
      instruction: matchedOutcome.instruction,
      status: 'passed',
      turns: [],
      durationMs: Date.now() - startTime,
      retried: false,
      aiExplanation: matched.reasoning,
    };
  }

  // Build results for all steps in the group
  for (const cs of group.conditionalSteps) {
    if (cs.index === matchedOutcome.index) {
      results.push(matchedResult);
    } else {
      results.push({
        index: cs.index,
        instruction: cs.instruction,
        status: 'skipped',
        turns: [],
        durationMs: 0,
        retried: false,
        aiExplanation: `Skipped: outcome ${matched.matched} matched instead`,
      });
    }
  }

  // Continuation step
  if (group.continuationStep.index === matchedOutcome.index) {
    results.push(matchedResult);
  } else if (matchedOutcome.isConditional) {
    // A conditional was matched — still need to execute the continuation step after
    const contResult = await executeStep(
      group.continuationStep.index,
      totalSteps,
      substituteBranchInstruction(group.continuationStep.instruction, opts),
      // 1-based cache identity, matching the normal step loop (issue 017).
      // No claim and no tail: see the matched-step call above.
      {
        ...opts,
        cacheKey: group.continuationStep.index + 1,
        flowControlClaim: undefined,
        failureTail: undefined,
      },
      group.continuationStep.instruction,
    );
    results.push(contResult);
  } else {
    // Continuation was the matched outcome (no conditional fired)
    results.push(matchedResult);
  }

  return results;
}

/**
 * Outcome of the AI clarification prompt. The caller switches on `kind`:
 *  - `answer`  → today's flow: build clarification message, re-call AI.
 *  - `resume`  → bubble up to the test-runner via `runnerControl.resume`.
 *  - `exit`    → bubble up to the test-runner via `runnerControl.exit`.
 */
export type ClarificationOutcome =
  | { kind: 'answer'; text: string }
  | { kind: 'resume'; fromStepIndex: number }
  | { kind: 'exit' };

export interface PromptUserWithReplEscapeContext {
  question: string;
  page: Page;
  testSteps: string[];
  /** 1-based index of the step the AI asked the question about. */
  currentStepIndex: number;
  /** Forwarded to runInteractiveRepl for ad-hoc Flick steps. */
  executorOptions: StepExecutorOptions;
  /** Accumulator for ad-hoc REPL StepResults. Caller appends them to the run. */
  adHocResults: StepResult[];
  /** Optional injected reader (tests). When set, wrapper does NOT close it. */
  reader?: InteractiveReader;
  /** Optional output sink (tests). Defaults to console.log. */
  write?: (line: string) => void;
}

/**
 * One-shot clarification prompt with a `/repl` escape hatch.
 *
 * The prompt accepts exactly two kinds of input:
 *  - `/repl` (case-insensitive) → opens the unified interactive REPL with
 *    `entryReason: 'clarification'`.
 *  - anything else → treated verbatim as the answer text and returned to the
 *    caller for the existing AI re-prompt round-trip.
 *
 * Other slash commands are NOT recognised at this prompt — typing `/exit`
 * here returns it as the literal answer. Rationale: the prompt is "the AI
 * is waiting for your answer"; mixing commands at that level blurs what
 * input the system expects. Use `/repl` to take control.
 */
export async function promptUserWithReplEscape(
  ctx: PromptUserWithReplEscapeContext,
): Promise<ClarificationOutcome> {
  const ownsReader = ctx.reader === undefined;
  const reader: InteractiveReader = ctx.reader ?? (() => {
    const rl = readline.createInterface({ input, output });
    return {
      question: (prompt: string) => rl.question(prompt),
      close: () => rl.close(),
    };
  })();
  const write = ctx.write ?? ((s: string): void => { console.log(s); });

  try {
    write('');
    write('⚠  AI needs clarification:');
    if (ctx.question) write(`  ${ctx.question}`);
    write('  Type your answer, or /repl to take control.');
    const raw = await reader.question('  Your answer: ');
    const trimmed = raw.trim();

    if (trimmed.toLowerCase() === '/repl') {
      const decision = await runInteractiveRepl({
        page: ctx.page,
        testSteps: ctx.testSteps,
        currentStepIndex: ctx.currentStepIndex,
        entryReason: 'clarification',
        clarificationQuestion: ctx.question,
        executorOptions: ctx.executorOptions,
        adHocResults: ctx.adHocResults,
        // Always hand a reader to the REPL so it doesn't open a second readline
        // on the same stdin — share whichever one we own.
        reader,
        ...(ctx.write !== undefined && { write: ctx.write }),
      });
      if (decision.kind === 'continue') return { kind: 'answer', text: '' };
      if (decision.kind === 'resume') {
        return { kind: 'resume', fromStepIndex: decision.fromStepIndex };
      }
      return { kind: 'exit' };
    }

    return { kind: 'answer', text: trimmed };
  } finally {
    if (ownsReader) {
      reader.close();
    }
  }
}

/** @deprecated Kept for callers that still want the bare prompt. New code should use `promptUserWithReplEscape`. */
async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n⚠  AI needs clarification:`);
    const answer = await rl.question(`  ${question}\n  Your answer: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}
// Suppress unused-export warning — kept intentionally as a deprecated fallback.
void promptUser;
