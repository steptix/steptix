import type { AIAction, AssertionEvaluation } from '../ai/types.js';
import type { ActionTargeting } from '../browser/actions.js';

export type StepStatus = 'passed' | 'failed' | 'skipped';

/**
 * Which iteration of a loop a step belongs to (stories/data-driven-rows.md,
 * decision 12). One run writes one report, so the report holds every row's
 * steps and the row has to travel on the step rather than on the report.
 *
 * `kind: 'row'` is a run row — a table under `## Steps`, where the flow being
 * looped is the whole run, so there is no `label`. `kind: 'iteration'` is a
 * section loop, where `label` is the section's name.
 */
export interface LoopMarker {
  kind: 'row' | 'iteration';
  /** The looped section's name; absent for a run row. */
  label?: string;
  /** 1-based. */
  index: number;
  /**
   * How many iterations there are in total — ABSENT while a runtime loop is
   * still running (stories/control-flow.md §"Painting, frames and the report").
   *
   * A table's rows are counted before the first one runs, so a data row and a
   * `For each` always know it. A `While` or `Repeat … until` does not: it stops
   * when the page says so. Those markers are handed out without a count and
   * back-filled in place when the loop ends (`LoopRuntime.endLoop`), so the
   * live band reads `(3/?)` and the rendered report reads `(3/7)`. A count that
   * is still absent at render time means the loop never ended — the run was
   * stopped, or the body failed — and `?` is then the honest answer.
   */
  count?: number;
  /** The row's cells, for the band and the matrix table. */
  values: Record<string, string>;
}

/** Captured data from an API call sub-action */
export interface ApiCallData {
  method: string;
  url: string;
  requestBody?: unknown;
  requestHeaders?: Record<string, string>;
  status: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
}

/** Result of a single sub-action execution */
export interface SubActionResult {
  /** 1-based index within the parent step */
  index: number;
  action: AIAction;
  /** Base64-encoded PNG screenshot taken after this action */
  screenshotBase64?: string;
  /** Cleaned DOM snapshot after this action */
  domSnapshot?: string;
  /** AI reasoning for this specific action */
  aiReasoning?: string;
  durationMs: number;
  error?: string;
  /** Populated for api_call sub-actions */
  apiCallData?: ApiCallData;
  /**
   * What the runtime found at the instant it acted — how many elements the
   * selector matched, how many of those were visible, and a verified selector
   * for the one it touched (stories/codebehind-selector-ambiguity.md).
   *
   * The sub-action record is where the measurement rides from the executor to
   * generation: `actionsOf` merges it onto the action before the transcript is
   * redacted and written. Absent on ordinary runs — it is measured only in a
   * compile mode, plus the visible count alone when
   * `browser.ambiguousTarget: 'fail'` is on — and absent whenever measuring
   * was impossible, which is never an error.
   */
  targeting?: ActionTargeting;
  /** How an `upload` delivered its files. A sibling of `targeting`, never a
   *  field inside it: generation reads `targeting === undefined` as "this
   *  action was not measured", so a route stored in there would misclassify
   *  every upload (stories/upload-action.md, decision 14). */
  upload?: { via: 'input' | 'chooser' };
  /** Page URL at the time the screenshot was captured */
  pageUrl?: string;
  /** ISO 8601 timestamp when this sub-action completed */
  timestamp?: string;
}

/** Result of an assertion embedded in a step */
export interface AssertionResult extends AssertionEvaluation {
  /** Index of this assert action within the step (0-based, in execution order) */
  assertIndex: number;
  /** Turn number this assert was evaluated in (1-based) */
  turnNumber: number;
  /** Sub-action index within the step (1-based, interleaved with other sub-actions) */
  subActionIndex: number;
  /** Human-readable label from the AI's `assert` action */
  description: string;
  /** Natural-language statement of what is being checked */
  condition: string;
  /** Expected value/state. `undefined` for predicate-mode assertions, where
   *  both sides of the comparison are already in `condition`. */
  expected: string | undefined;
  /** Which assertion mode the action used. Drives the report's "Predicate /
   *  Result" vs "Expected / Actual" row labels. Optional for backwards
   *  compatibility with reports written before the predicate mode existed. */
  against?: 'dom' | 'api' | 'both' | 'predicate';
  /** The cached JS code used to evaluate this assertion */
  assertionCode?: string | undefined;
  /** AI interaction that generated the JS code (only when not from cache) */
  aiInteraction?: AiInteraction | undefined;
}

/** A single captured AI response during step execution */
export interface AiInteraction {
  /** What triggered this AI call (e.g. "action-plan", "clarification", "assertion") */
  purpose: string;
  /** Which retry attempt this interaction belongs to (1 = first attempt, 2 = first retry, etc.) */
  attemptNumber?: number;
  /** Text-only messages sent to the AI (base64 images omitted; screenshots are captured separately) */
  requestMessages?: Array<{ role: string; content: string }>;
  /** The raw response text from the AI */
  response: string;
  /** The model that served this response (reported by the gateway envelope) */
  model?: string;
  /** Screenshot the AI saw when making this decision (page state at time of AI call) */
  screenshotBase64?: string;
  /** Page URL at the time of the AI call */
  pageUrl?: string;
  /** ISO 8601 timestamp when the AI was called */
  timestamp?: string;
}

/** A single turn within a step (AI decision + resulting actions) */
export interface TurnResult {
  /** 1-based turn number */
  turnNumber: number;
  /** Which retry attempt this turn belongs to (1 = first attempt, 2 = first retry, etc.) */
  attemptNumber: number;
  /** ISO 8601 timestamp when this turn started */
  timestamp: string;
  /** The AI interaction(s) for this turn (action-plan, and optionally clarification) */
  aiInteractions: AiInteraction[];
  /** Sub-actions executed from this turn's action plan */
  subActions: SubActionResult[];
}

/** Result of a single test step */
export interface StepResult {
  /** 1-based step number. For hook results, this is the 1-based index of the
   *  step the hook is associated with (the wrapped step for beforeEach/afterEach,
   *  0 for `before`, totalSteps+1 for `after`). */
  index: number;
  instruction: string;
  status: StepStatus;
  /** Set when this step ran inside a loop. Absent on an ordinary step, so a
   *  report with no loops is byte-identical to one from before the feature. */
  loop?: LoopMarker;
  /** Ordered turns — each groups an AI decision with the sub-actions it produced */
  turns: TurnResult[];
  /** All assertions evaluated during this step, in execution order */
  assertions?: AssertionResult[];
  /** Variables this step captured — `as`-tagged read/count actions and
   *  explicit `[output: X]` declarations alike (issue 042), keyed by
   *  variable name. Omitted (not empty) when the step captured nothing, so
   *  the report can skip the section entirely rather than show an empty
   *  box on every ordinary step. Skill-internal `__skill*` names are never
   *  included — same invariant as session.outputs. */
  outputs?: Record<string, string>;
  /** Screenshot captured at the end of the step */
  screenshotBase64?: string;
  /** Page URL at the time the end-of-step screenshot was captured */
  pageUrl?: string;
  /**
   * Which tab this step ran in (stories/mcp-cdp-browser.md §11).
   *
   * Absent on runs from clients that predate it, and on engines that cannot
   * report a CDP target id — the report degrades to what it showed before.
   *
   * `targetId` is what makes this worth carrying. Several tests can share one
   * CDP browser, every tab any of them opens is visible to all of them, and
   * labels are per-session — so `page:2` in two reports may or may not be the
   * same tab, and only the target id answers that.
   */
  tab?: {
    label: string;
    targetId: string | null;
    url: string;
    title: string;
    /** Adopted mid-run with nothing in this session accounting for it —
     *  most often another test running against the same browser. Advisory:
     *  it changes no status and fails no step. */
    unexpected: boolean;
  };
  /** DOM snapshot at the start of the step */
  domSnapshot?: string;
  durationMs: number;
  /** Whether this step was retried */
  retried: boolean;
  error?: string;
  /** AI explanation of what it was attempting (shown on failure) */
  aiExplanation?: string;
  /** True when every AI turn for this step was served from `StepCache` —
   *  no AI call was made. Surfaces in the step:pass event so clients can
   *  paint a distinct glyph and log the run line as `(cached)`. */
  fromCache?: boolean;
  /**
   * True when this step ran its **code-behind** — the committed `.steps.ts`
   * entry beside the test — instead of calling the AI. Sibling of
   * `fromCache`, rendered with its own glyph (the `</>` code mark next to the cache's ⚡).
   * See stories/step-codebehind.md.
   */
  fromCodeBehind?: boolean;
  /** The code-behind entry that ran, for the report's collapsed code block.
   *  Present only when `fromCodeBehind` is true. */
  codeBehind?: {
    /** Absolute path of the `.steps.ts` the entry lives in. */
    file: string;
    /** The entry's `run` function source. */
    code: string;
    logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  };
  /**
   * This step's entry threw and the step fell through to AI
   * (stories/codebehind-compile.md, "The runtime stops generating").
   *
   * Runs no longer rewrite the file, so the failure has to be *flagged*
   * instead: the report renders ⚠, the summary counts it, and `aiui compile
   * --only-stale` regenerates exactly these steps.
   *
   * The flag says the ENTRY broke — it does NOT say the step recovered. The
   * AI attempt that took over can fail too, and then this rides a `failed`
   * step alongside `error` (the AI failure). Anything that means "healed"
   * must pair this with `status === 'passed'` — use `isHealedStep`.
   */
  codeBehindStale?: {
    /** Absolute path of the `.steps.ts` the failing entry lives in. */
    file: string;
    /** The entry's authored `source` — what binds it to this step. */
    source: string;
    /** What the entry threw. */
    error: string;
  };
  /**
   * This step's entry threw and there was no AI to heal it, so the step failed
   * (stories/keyless-replay-and-gateway-env.md §Part B).
   *
   * The same facts as {@link codeBehindStale} and deliberately NOT that field:
   * every heal counter in the codebase — `countStepOrigins`, the report's
   * amber "healed" banner, the run summary's healed-step count and its token
   * figure — is taken off `codeBehindStale`, and nothing healed here. Marking
   * the step stale in-result would report a heal that never happened.
   *
   * The sidecar writers read it anyway and record the row as stale, because
   * the sidecar answers a different question — "which steps does a later
   * compile need to regenerate?" — and the answer for a broken entry is yes
   * whether or not this machine could repair it. Without that, the failure's
   * own advice ("recompile or repair this step where AI is available") would
   * be a no-op: `--only-stale` would not select the step and Compile This Step
   * would generate blind instead of repairing.
   */
  codeBehindHealSkipped?: {
    /** Absolute path of the `.steps.ts` the failing entry lives in. */
    file: string;
    /** The entry's authored `source` — what binds it to this step. */
    source: string;
    /** What the entry threw. */
    error: string;
  };
  /**
   * Page state either side of the step, captured only when the caller asked
   * for it (`captureStepContext`). This is compile's Record phase input — the
   * generator writes far better selectors with the DOM in front of it — and it
   * is deliberately off for ordinary runs, where two more DOM snapshots per
   * step would bloat every report for nobody's benefit.
   */
  stepContext?: {
    /** DOM at turn 1, before the step acted. */
    domBefore?: string;
    urlBefore?: string;
    /** DOM after the step's last action. */
    domAfter?: string;
    urlAfter?: string;
  };
  /**
   * This step ended the flow it was in, as a pass
   * (stories/step-flow-control.md). Present only on the step that returned —
   * the steps it left behind carry `status: 'skipped'` and a reason instead.
   *
   * The four run loops read it to decide where to resume: from the step after
   * the last one in this step's frame. `verb` records which word was written
   * (`return` / `stop`); both mean the same thing (decision 1), and it is kept
   * so a report and a code-behind generator can echo the author's own wording.
   *
   * `kind` is a discriminant with one member today. It is here because the
   * story explicitly leaves "break out of a loop" and "end the whole test from
   * inside a section" for later, and a second kind arriving as a widened union
   * is found by the compiler at every consumer.
   */
  flowControl?: { kind: 'return'; verb: 'return' | 'stop' };
  /** True when this step was typed into the interactive REPL rather than being part of the test file. */
  interactiveAdHoc?: boolean;
  /** True when this step is a user-typed command captured inside an [interactive] step. */
  interactiveChild?: boolean;
  /** True when this step triggered the interactive REPL (planned [interactive] or post-failure handoff)
   *  and the user chose to resume from a different step. */
  interactiveResumed?: boolean;
  /** Hook metadata — absent for regular steps, set for hook executions. */
  hookScope?: 'before' | 'beforeEach' | 'afterEach' | 'after';
  /**
   * Out-of-band control signal from `executeStep` to the test-runner step loop.
   * Currently set only when the user takes control inside the AI clarification REPL.
   *
   *  - `resume` → the test-runner jumps the outer loop to `fromStepIndex` (1-based)
   *    instead of advancing to `i + 1`.
   *  - `exit`   → the test-runner sets `bail = true` immediately, BEFORE the
   *    failure-handoff path, so a `/exit` from the clarification REPL doesn't
   *    re-trigger the failure REPL on top of the user's chosen abort.
   *
   * `adHocResults` carries any StepResults produced inside the clarification REPL
   * (typed Flick steps, /screenshot captures); the runner appends them after the
   * parent step.
   */
  runnerControl?:
    | { kind: 'resume'; fromStepIndex: number; adHocResults?: StepResult[] }
    | { kind: 'exit'; adHocResults?: StepResult[] };
  /** Set when this step was a `[tool: ...]` invocation rather than an AI step. */
  toolStep?: {
    name: string;
    args: Record<string, unknown>;
    outputs: Record<string, string>;
    logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  };
  /** Name of the outermost skill this step came from, if any. Surfaced as a
   *  chip in the step header so the report shows skill provenance even after
   *  parse-time expansion has flattened the call away. */
  sourceSkill?: string;
  /** Name of the inline `### Name` section this step came from, if any.
   *  Rendered as a chip *alongside* the skill chip, not instead of it — a
   *  skill invoked from inside a section carries both. Sections private to a
   *  skill are not surfaced here; see `SkillExpansion.sourceSections`. */
  sourceSection?: string;
  /** True when this is the step that was in flight when the user STOPPED the run
   *  (issue 021). The report renders it as a distinct "aborted" state — not a red
   *  failure — and it's excluded from the failed-step count. `status` stays a
   *  valid `StepStatus` ('failed') for back-compat with older report readers. */
  interrupted?: boolean;
}

/** AI-generated root-cause analysis for a failed test run */
export interface FailureDiagnosis {
  /** One-paragraph explanation of what actually went wrong */
  rootCause: string;
  /**
   * High-level category of the fault — helps triage who should look at it.
   *  - test-spec: the step wording was ambiguous / split badly / missing a wait
   *  - application: a genuine app bug (wrong behaviour, broken UI)
   *  - flake: timing/selector/network instability
   *  - environment: config, network, auth issue outside the test
   *  - unknown: AI could not determine
   */
  faultCategory: 'test-spec' | 'application' | 'flake' | 'environment' | 'unknown';
  /** Concrete observations from the run that support the root cause */
  evidence: string[];
  /** Concrete suggested fix — for test-spec issues, prefer a rewritten step list */
  suggestedFix: string;
  /** AI's self-rated confidence in the diagnosis */
  confidence: 'high' | 'medium' | 'low';
  /** The AI interaction used to produce this diagnosis (for transparency in the report) */
  aiInteraction?: AiInteraction;
}

/** Complete test run report data */
/** One row's line in a merged report's matrix table. */
export interface RowSummaryLine {
  /** 1-based row number, matching the `loop.index` on that row's steps. */
  index: number;
  /** The row's cells as authored. */
  values: Record<string, string>;
  /** `skipped` is a row that never ran — the loop stopped before reaching it. */
  status: StepStatus;
  /** Why it never ran, e.g. "stopped" / "paused". Set only when skipped. */
  notRunReason?: string;
  durationMs: number;
  tokensUsed: number;
  /** This row's video, when one was kept. A merged report holds one `.webm`
   *  per row, so the link belongs on the row rather than on the report. */
  videoRelPath?: string;
}

export interface TestReport {
  /**
   * Why the run failed before (or without) a step failing — a code-behind
   * file a strict replay could not load. Absent when the steps tell the story.
   */
  error?: string;
  testName: string;
  filePath: string;
  tags: string[];
  status: StepStatus;
  steps: StepResult[];
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  /**
   * Steps with `status: 'skipped'` — ones a `return` / `stop` left behind
   * (stories/step-flow-control.md, decision 15), and the unmatched branches of
   * a conditional group, which have always carried that status and were simply
   * never counted.
   *
   * Counted separately so the header stays honest: nothing that did not run is
   * counted as passed, and a run that returned from the main flow reads as a
   * pass with N skipped rather than as a timeout.
   *
   * Omitted (not `0`) when nothing was skipped, so a run that skips nothing
   * writes the report it always did.
   */
  skippedSteps?: number;
  totalSubActions: number;
  durationMs: number;
  tokensUsed: number;
  /** Input (prompt) tokens consumed across all AI calls */
  inputTokens: number;
  /** Output (completion) tokens consumed across all AI calls */
  outputTokens: number;
  /** ISO 8601 date string */
  date: string;
  baseUrl?: string;
  /** Parameters every row shared. A data-driven run has one set of these per
   *  row, so the per-row values live on each step's `loop.values` and in the
   *  matrix table instead (stories/data-driven-rows.md, decision 12). */
  parameters?: Record<string, string>;
  /**
   * One line per run row, in row order — the matrix table rendered above the
   * steps. Present only on a merged data-driven report; a row that never ran
   * still gets an entry, because a matrix that silently omits what it skipped
   * is worse than no matrix.
   */
  rows?: RowSummaryLine[];
  /** AI-generated root-cause analysis, populated when the test fails and diagnoseFailures is enabled */
  diagnosis?: FailureDiagnosis;
  /** True when the run entered the interactive REPL at any point (planned [interactive] step or post-failure handoff). */
  humanIntervened?: boolean;
  /** True when the user STOPPED this run (issue 021). Overrides the red
   *  "FAILED" banner with an amber "ABORTED" state. `status` itself stays a
   *  valid `StepStatus` so older report consumers still parse the file. */
  aborted?: boolean;
  /**
   * How many steps healed under AI after their code-behind entry threw — the
   * steps carrying `codeBehindStale`
   * (stories/codebehind-selector-ambiguity.md §"A healed run stops reporting
   * as a clean pass").
   *
   * A separate field rather than a new `StepStatus`, for the same reason
   * `aborted` above and `interrupted` on a step are: `status` is shared with
   * steps, and `leadingPassed` in codebehind/compile.ts breaks its loop on
   * `status !== 'passed'` to decide how much of a recording is usable — so a
   * healed step that stopped being `'passed'` would make a compile silently
   * truncate the prefix. `status` stays `'passed'`; this drives the distinct
   * amber "PASSED — N steps healed" banner and `aiui run --fail-on-healed`.
   *
   * Omitted (not `0`) on a run that healed nothing, so an unchanged run
   * writes an unchanged report.
   */
  healedSteps?: number;
  /**
   * AI tokens spent on those healed steps — the recurring price of leaving the
   * entries broken, which is the whole point of surfacing the healing at all.
   *
   * Measured as the run's token delta across each healed step, so it is only
   * present on paths that track it. Absent means "not attributed", never
   * "zero": the banner then names the count alone rather than inventing a
   * number.
   */
  healedTokens?: number;
  /** Path to the session `.webm` RELATIVE to the report HTML (e.g.
   *  `videos/<timestamp>-<test>.webm`). Set only when video recording kept this
   *  run (mode 'on', or 'retain-on-failure' on a failed/aborted run). Drives the
   *  `<video>` block in the report template; file-linked, not embedded. */
  videoRelPath?: string;
}

/** Summary across all test runs in a session */
export interface RunSummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  totalDurationMs: number;
  totalTokensUsed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  reports: TestReport[];
}

// ---------------------------------------------------------------------------
// Helpers for migrating consumers that used the old flat arrays
// ---------------------------------------------------------------------------

/**
 * Did this step HEAL — its code-behind entry threw and the AI covered for it?
 *
 * `codeBehindStale` alone only says the entry broke. The step then falls
 * through to AI, and that attempt can fail too, which leaves the flag on a
 * `failed` step. Every surface that means "healed" — the report's ⚠ badge and
 * Stale count, the run's `healed` summary — must ask this instead of testing
 * the flag, or it will describe a red step as one that ran fine under AI.
 *
 * Lives here rather than in report/generator.ts because the server needs it
 * too, and a dozen api-server suites replace that module wholesale with a
 * three-export `vi.mock` — importing a fourth name from it would make every
 * one of them throw.
 */
export function isHealedStep(step: StepResult): boolean {
  return step.codeBehindStale !== undefined && step.status === 'passed';
}

/** Extract all sub-actions from a step's turns (replaces step.subActions) */
export function getAllSubActions(step: StepResult): SubActionResult[] {
  return step.turns.flatMap((t) => t.subActions);
}

/** Extract all AI interactions from a step's turns + assertion code generations */
export function getAllAiInteractions(step: StepResult): AiInteraction[] {
  const fromTurns = step.turns.flatMap((t) => t.aiInteractions);
  const fromAssertions = (step.assertions ?? [])
    .map((a) => a.aiInteraction)
    .filter((i): i is AiInteraction => i !== undefined);
  return [...fromTurns, ...fromAssertions];
}
