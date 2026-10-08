import type { Page, BrowserContext, Browser } from 'playwright';
import { bindVariable, dottedThroughRename, interpolate } from '../parser/parameters.js';
import { envDataRefsIn, interpolateEnvData, resolveEnvDataRef, type EnvDataContext } from '../parser/interpolate-env-data.js';
import { createCapturingLog, type CapturedLog } from '../tools/step-api.js';
import type { CodeBehindBinding, CodeBehindVarScope } from './loader.js';
import { entryFunctionActs } from './entry-actions.js';
import { executeAction } from '../browser/actions.js';
import { storeCapture } from '../runner/store-capture.js';
import { runSecrets } from '../utils/secrets.js';
import { WIDE_PLACEHOLDER_SOURCE } from '../parser/parameters.js';
import type { AIAction } from '../ai/types.js';
import { unavailableBrowserApi, unavailableTabApi } from './tabs.js';
import {
  resolveUploadPathSync,
  nonRetryable,
  isNonRetryable,
  type UploadPathContext,
} from '../browser/upload-paths.js';
import { isReturnClaim, type ParsedFlowControlStep } from '../parser/flow-control-step.js';
import type {
  CodeBehindBrowserApi,
  CodeBehindContext,
  CodeBehindStepApi,
  CodeBehindTabApi,
  StepCodeEntry,
  StepReadOptions,
} from './types.js';

/** A `{{name}}` in a recorded field, in the wide grammar the recording uses. */
const PLACEHOLDER_IN_FIELD = new RegExp(WIDE_PLACEHOLDER_SOURCE, 'g');

/**
 * Running one code-behind entry (stories/step-codebehind.md, "Execution").
 *
 * The substrate is the tool layer's: the same live Playwright instances the
 * AI loop drives, and the same variable map `{{var}}` and `[as: x]` use. The
 * one thing tools don't need is frame-aware variables — see `makeStepApi`.
 */

/** A `step.expect` that failed. Distinct because it is a REAL step failure:
 *  broken code heals and falls through to AI, a failed assertion does not. */
export class CodeBehindExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeBehindExpectationError';
  }
}

/**
 * What `step.fail(message)` throws (stories/step-failure-outcomes.md,
 * decision 10).
 *
 * A SUBCLASS of {@link CodeBehindExpectationError} rather than a class beside it,
 * because every existing reading of "the entry's assertion failed" —
 * `expectationFailed`, the runner's do-not-heal rule, an author's own `catch (e)
 * { if (e instanceof CodeBehindExpectationError) … }` — has to stay true for it.
 * The extra fact it carries is only about WORDING: the runner says the step failed
 * as its text says, rather than that an expectation was not met.
 */
export class CodeBehindDeliberateFailure extends CodeBehindExpectationError {
  constructor(message: string) {
    super(message);
    this.name = 'CodeBehindDeliberateFailure';
  }
}

/** What a failed self-check's message starts with, whichever way it fails. */
export const SELF_CHECK_FAILED = 'Self-check failed: ';

/**
 * What a failed `step.check` throws in an entry that takes no action
 * (docs/specs/SPEC-codebehind-robustness.md §6.5, D4).
 *
 * Deliberately NOT a {@link CodeBehindExpectationError}. A self-check is the
 * one the GENERATOR wrote to prove its own read was right — "one name per
 * account row" — and when it fails, what is wrong is the generated code, not
 * the application. So the runner reads it as broken code: the step heals under
 * AI, which reads what the run read, the entry is flagged stale, and the next
 * compile repairs it. Strict replay and keyless runs still never heal.
 *
 * In an entry that ACTS, `step.check` throws a `CodeBehindExpectationError`
 * instead: a heal re-runs the step under AI, and after a click that can submit
 * twice.
 */
export class CodeBehindCheckError extends Error {
  constructor(message: string) {
    super(`${SELF_CHECK_FAILED}${message}`);
    this.name = 'CodeBehindCheckError';
  }
}

/** `step.fail()` with nothing to say. Still a failure — the call is the author
 *  asking for one, and swallowing it because the message was missing would turn a
 *  red step green — with a sentence in place of an empty error cell. */
export const FAIL_WITHOUT_MESSAGE = 'step.fail() was called with no message';

/**
 * What `step.exit()` throws (stories/step-flow-control.md, decision 11).
 *
 * A throw rather than a return value, because the contract is "nothing after
 * it runs" and only an exception gives that from anywhere inside the entry —
 * a nested helper, a `.forEach`, the middle of an `if`. It is a control
 * signal, not a failure: `runCodeBehindEntry` catches it BEFORE the generic
 * handler and answers `passed`.
 */
export class CodeBehindExitSignal extends Error {
  constructor() {
    super('step.exit() ended the flow this step is in');
    this.name = 'CodeBehindExitSignal';
  }
}

/**
 * `step.exit()` called from an entry whose step does not claim the form
 * (stories/step-flow-control.md, decision 11).
 *
 * Non-retryable, and that is the point: the entry is not broken, so healing it
 * under AI would spend a turn and discard working code over a rule no
 * re-planning can satisfy. The fix is one line of markdown.
 */
export const EXIT_NOT_CLAIMED =
  'step.exit() was called for a step whose text does not say to return. The markdown is ' +
  'what a reader sees, so it has to say what the code does: write the step as ' +
  '"If <condition> then return" (or "… then stop"), or as a step whose whole text is the ' +
  'tail ("Return", "Stop", "Stop running the remaining steps"). ' +
  'Until the step claims the form, its entry may not end the flow.';

/**
 * Which of the two non-retryable failures an entry raised.
 *
 * Both are "the entry is fine, do not heal it under AI", and that is all
 * `nonRetryable` says — but they need opposite sentences in the report cell
 * and the Steptix hover, and the runner must not have to read the message
 * text to tell them apart. So the kind rides out structurally, set where each
 * is thrown.
 *
 *  - `file` — `step.filePath` named something missing, a folder, or a path
 *    outside the project.
 *  - `exit-unclaimed` — `step.exit()` on a step whose markdown does not claim
 *    the flow-control form ({@link EXIT_NOT_CLAIMED}).
 */
export type CodeBehindNonRetryableKind = 'file' | 'exit-unclaimed';

/**
 * The unclaimed-exit refusal, tagged so the runner can tell it from a missing
 * file without matching on the message.
 *
 * `nonRetryable` for the reason above: the entry is not broken, so healing it
 * under AI would spend a turn and discard working code over a rule no
 * re-planning can satisfy. The fix is one line of markdown.
 */
function exitNotClaimed(): Error {
  return Object.assign(nonRetryable(EXIT_NOT_CLAIMED), {
    codeBehindNonRetryableKind: 'exit-unclaimed' as const,
  });
}

/** The kind off a thrown error. Everything untagged is a `file` failure —
 *  the `upload-paths.ts` throws, which are all of them. */
function nonRetryableKindOf(err: unknown): CodeBehindNonRetryableKind {
  const tagged = (err as { codeBehindNonRetryableKind?: unknown } | null)
    ?.codeBehindNonRetryableKind;
  return tagged === 'exit-unclaimed' ? 'exit-unclaimed' : 'file';
}

export interface RunCodeBehindOptions {
  binding: CodeBehindBinding;
  page: Page;
  context: BrowserContext;
  browser: Browser;
  /** Live parameter map — the same object `{{var}}` and `[as: x]` use. */
  resolvedParameters: Record<string, string>;
  /**
   * Tab and browser control (stories/codebehind-framework-actions.md), built
   * over the run's own trackers so a switch here is the switch the following
   * natural-language steps see.
   *
   * Omitted by a caller with no tracker, and replaced with an API whose every
   * method throws — never left undefined, because an entry destructuring
   * `{ tabs }` would then get `undefined` and fail with a TypeError that says
   * nothing about why.
   */
  tabs?: CodeBehindTabApi | undefined;
  browsers?: CodeBehindBrowserApi | undefined;
  /**
   * The run's env/data context, when it has one — what `${data.url}` was
   * resolved against in the step text, and what `step.getVar('data.url')`
   * reads from the entry (stories/codebehind-env-data.md).
   */
  envData?: EnvDataContext | undefined;
  baseUrl?: string | undefined;
  /**
   * Code-behind step-into (stories/codebehind-debugging.md) — hit a
   * `debugger;` immediately before `entry.run(ctx)`. Set only after the
   * session manager's awaiting-debugger/ack round-trip, so an inspector is
   * attached by the time it fires. No-op when none is (a plain `debugger;`
   * without an inspector does nothing).
   */
  pauseBeforeRun?: boolean | undefined;
  /** Step label used in log lines, e.g. `codebehind:12`. */
  label: string;
  /** Where a path passed to `step.filePath` resolves from: the test file's
   *  folder, fenced by the project root. Absent on a run with no test file,
   *  where `step.filePath` accepts only absolute paths. */
  uploadPaths?: UploadPathContext | undefined;
  /**
   * This step's AUTHORED text claims the `If … then return` / `… then stop`
   * form — `parseFlowControlStep(<authored line>)`, computed by the run loop
   * (stories/step-flow-control.md, decision 11).
   *
   * A RETURN claim — `return` or `stop` — is the only thing that lets
   * `step.exit()` through. Present, an exit ends the step passed with
   * `flowControl` on the outcome and the loop skips the rest of the flow;
   * absent, the call fails the step non-retryably with
   * {@link EXIT_NOT_CLAIMED}. Same guard the AI path puts on the `return`
   * action, for the same reason: the markdown has to say the step returns, or
   * a reader of the test has no way to know that it does.
   *
   * So the verb IS read here, through `isReturnClaim`, and only for that gate
   * (stories/step-failure-outcomes.md, decision 1): a `fail` claim says the step
   * ends the RUN in the author's words, the opposite of ending the flow as a pass,
   * so an entry calling `step.exit()` on such a line is refused exactly as an
   * unclaimed exit is. Nothing else reads the verb, so a caller with nothing but a
   * boolean answer can still pass `{ verb: 'return' }`.
   */
  flowControlClaim?: ParsedFlowControlStep | undefined;
  /**
   * The wait after an action, armed for this entry just before it runs
   * (`armActionWatcher`, docs/specs/SPEC-codebehind-robustness.md §6.4) —
   * what `step.settle()` waits on. Absent where there is nothing to wait for
   * (the computer surface, a caller with no page), and `step.settle()` then
   * returns at once.
   */
  watcher?: { settle(signal?: AbortSignal): Promise<unknown> } | undefined;
  /** The run's abort signal: a Stop ends a `step.settle()` at once. */
  signal?: AbortSignal | undefined;
  /** The active page when a `step.read` / `step.count` runs — after a tab
   *  switch the entry made (§6.6). Defaults to `page`. */
  activePage?: (() => Page) | undefined;
  /** How long a count or a read of every match waits for its matches to hold
   *  still (§6.6). Defaults to 10 s. */
  readTimeoutMs?: number | undefined;
}

export interface CodeBehindOutcome {
  status: 'passed' | 'failed';
  /** True when the failure came from `step.expect` — fail the step, do not
   *  fall through to AI. */
  expectationFailed: boolean;
  /** True when the failure came from `step.fail(message)` — the code form of
   *  `If … then fail the test with error "…"` (stories/step-failure-outcomes.md,
   *  decision 10). Always paired with `expectationFailed: true`: a real failure,
   *  never healed under AI, worded as deliberate rather than as an expectation. */
  deliberate?: boolean;
  durationMs: number;
  logs: CapturedLog[];
  /** Values the entry wrote, under their effective (post-rename) names. */
  outputs: Record<string, string>;
  error?: string;
  /**
   * True when the failure is a fact about the world rather than broken code —
   * today, a `step.filePath` whose file is missing, is a folder, or sits
   * outside the project. The runner must NOT heal these: the entry is fine, so
   * re-running the step under AI would spend a turn and discard a working
   * entry for a failure no re-planning can fix.
   */
  nonRetryable?: boolean;
  /**
   * Which non-retryable failure it was — present exactly when `nonRetryable`
   * is. The runner writes a different explanation for each, and reading the
   * message text to decide would tie the report cell to the wording of an
   * error string (which is how the unclaimed exit came to be reported as a
   * file that could not be resolved).
   */
  nonRetryableKind?: CodeBehindNonRetryableKind;
  /**
   * The entry called `step.exit()`: the step PASSED and the flow it is in ends
   * (stories/step-flow-control.md, decision 11).
   *
   * No verb here. The verb belongs to the authored line — `return` and `stop`
   * mean the same thing and only the report echoes which was written — so the
   * runner takes it from the claim it passed in, and this stays the bare fact
   * that the entry asked to leave.
   */
  flowControl?: { kind: 'return' };
}

/** Execute an entry's `run`. Never throws — the caller decides what a failure
 *  means (heal-and-fall-through, or fail the step). */
export async function runCodeBehindEntry(
  options: RunCodeBehindOptions,
): Promise<CodeBehindOutcome> {
  const start = Date.now();
  const logs: CapturedLog[] = [];
  const outputs: Record<string, string> = {};
  const entry = options.binding.entry;

  if (!entry?.run) {
    return {
      status: 'failed',
      expectationFailed: false,
      durationMs: 0,
      logs,
      outputs,
      error: 'Code-behind entry has no `run` function',
    };
  }

  const ctx: CodeBehindContext = {
    page: options.page,
    context: options.context,
    browser: options.browser,
    step: makeStepApi(
      options.binding.scope,
      options.resolvedParameters,
      outputs,
      options.envData,
      options.uploadPaths,
      options.flowControlClaim !== undefined && isReturnClaim(options.flowControlClaim),
      {
        settle: async () => {
          await options.watcher?.settle(options.signal);
        },
        // Decided once, when the entry loads (§6.5): whether a failed
        // `step.check` may heal. Any call the entry makes that is not known
        // to be read-only counts as acting (`entryActs`).
        acts: typeof entry.run === 'function' && entryFunctionActs(entry.run),
        page: () => options.activePage?.() ?? options.page,
        signal: options.signal,
        readTimeoutMs: options.readTimeoutMs,
      },
    ),
    log: createCapturingLog(options.label, logs),
    tabs: options.tabs ?? unavailableTabApi(),
    browsers: options.browsers ?? unavailableBrowserApi(),
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
  };

  try {
    if (options.pauseBeforeRun) {
      // Cooperative pause point for code-behind step-into. The session
      // manager has already emitted `codebehind:awaiting-debugger` and
      // waited for the client's ack, so a debugger is attached. Stepping
      // past this line lands the user inside `entry.run` — the author's
      // `.steps.ts`, via the bundle's inline sourcemap.
      // eslint-disable-next-line no-debugger
      debugger;
    }
    await Promise.resolve(entry.run(ctx));
    return {
      status: 'passed',
      expectationFailed: false,
      durationMs: Date.now() - start,
      logs,
      outputs,
    };
  } catch (err) {
    // The exit signal FIRST, ahead of every failure reading below
    // (stories/step-flow-control.md, decision 11). `step.exit()` is how a
    // compiled `If … then return` succeeds; taken as a throw it would be
    // "broken code", and `runCodeBehindStep` would heal the step under AI and
    // discard the entry — on every run, for every compiled return.
    if (err instanceof CodeBehindExitSignal) {
      return {
        status: 'passed',
        expectationFailed: false,
        durationMs: Date.now() - start,
        logs,
        outputs,
        flowControl: { kind: 'return' },
      };
    }
    return {
      status: 'failed',
      // True for a deliberate failure too — `CodeBehindDeliberateFailure` extends
      // this class so the do-not-heal rule needs no second condition (decision 10).
      expectationFailed: err instanceof CodeBehindExpectationError,
      ...(err instanceof CodeBehindDeliberateFailure && { deliberate: true }),
      durationMs: Date.now() - start,
      logs,
      outputs,
      error: err instanceof Error ? err.message : String(err),
      ...(isNonRetryable(err) && {
        nonRetryable: true,
        nonRetryableKind: nonRetryableKindOf(err),
      }),
    };
  }
}

/**
 * True when `entry` runs as a STEP's code: it has a `run`, and the author has
 * not opted the line out with `ai: true`.
 *
 * One predicate for every gate that asks "will this step execute its entry?"
 * — `executeStep`'s own and the server's F11 step-into gate, which must agree
 * or the server parks for a debugger ack in front of an entry that never runs.
 * A `condition` entry is NOT step code: bound to an ordinary step it is in the
 * wrong place, and the step runs under AI
 * (stories/codebehind-loops-and-conditions.md, "The entry, loading and running
 * it").
 */
export function isStepCode(entry: StepCodeEntry | undefined): entry is StepCodeEntry & {
  run: NonNullable<StepCodeEntry['run']>;
} {
  return entry !== undefined && entry.ai !== true && typeof entry.run === 'function';
}

/** True when `entry` answers a CONDITION: it has a `condition`, and the author
 *  has not opted the line out with `ai: true`. */
export function isConditionCode(entry: StepCodeEntry | undefined): entry is StepCodeEntry & {
  condition: NonNullable<StepCodeEntry['condition']>;
} {
  return entry !== undefined && entry.ai !== true && typeof entry.condition === 'function';
}

/**
 * What running a `condition` entry produced
 * (stories/codebehind-loops-and-conditions.md, decision 7).
 *
 * The failure fields mean what they mean on {@link CodeBehindOutcome}, so the
 * guard reads them with the step path's rules: broken code (a throw, or a
 * value that is not a boolean) heals under the model, an `expectationFailed`
 * is a real failure of the guard, and `nonRetryable` is a fact about the world
 * that no model can change.
 */
export interface CodeBehindConditionOutcome {
  status: 'passed' | 'failed';
  /** The answer — present exactly when `status` is `passed`. Whether the
   *  condition, as written, holds on the page now. */
  value?: boolean;
  /** A `step.expect` or `step.fail` failed — the guard fails, never healed. */
  expectationFailed: boolean;
  /** It was `step.fail(message)` rather than `step.expect`. */
  deliberate?: boolean;
  /** A `step.filePath` that could not resolve, or a `step.exit()` — which a
   *  condition never claims. The entry is not broken; the guard fails. */
  nonRetryable?: boolean;
  nonRetryableKind?: CodeBehindNonRetryableKind;
  error?: string;
  logs: CapturedLog[];
  durationMs: number;
}

/** The one-line refusal a condition entry's non-boolean answer gets. */
export function nonBooleanConditionError(value: unknown): string {
  return `returned ${describeReturned(value)}; a condition must return true or false`;
}

/**
 * What a non-boolean return WAS, in two or three words.
 *
 * Deliberately never the value itself: a condition that returns
 * `page.textContent(...)` by mistake would otherwise put a piece of the page —
 * a balance, a name, a token — into the stale flag, the report and the wire.
 */
function describeReturned(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string': return value === '' ? 'an empty string' : 'a string';
    case 'number': return Number.isNaN(value) ? 'NaN' : 'a number';
    case 'object': return 'an object';
    case 'function': return 'a function';
    case 'bigint': return 'a bigint';
    case 'symbol': return 'a symbol';
    default: return typeof value;
  }
}

/**
 * Execute a `condition` entry: the code form of the condition judge's question
 * (stories/codebehind-loops-and-conditions.md, decisions 4 and 7).
 *
 * Same context and step API as {@link runCodeBehindEntry}, with two
 * differences that follow from what a condition is:
 *
 *  - the answer is the RETURN VALUE, and anything but a boolean is broken
 *    code — never coerced, because `"false"` is truthy and a condition that
 *    returned a string by mistake would run the loop forever;
 *  - `step.exit()` is refused. No flow-control claim is ever passed, so the
 *    call fails non-retryably exactly as it does on any step that does not
 *    claim a return: a condition answers, it does not end the flow.
 *
 * Never throws — the guard decides what a failure means.
 */
export async function runCodeBehindCondition(
  options: Omit<RunCodeBehindOptions, 'flowControlClaim' | 'pauseBeforeRun'>,
): Promise<CodeBehindConditionOutcome> {
  const start = Date.now();
  const logs: CapturedLog[] = [];
  const entry = options.binding.entry;

  if (typeof entry?.condition !== 'function') {
    return {
      status: 'failed',
      expectationFailed: false,
      durationMs: 0,
      logs,
      error: 'Code-behind entry has no `condition` function',
    };
  }

  const ctx: CodeBehindContext = {
    page: options.page,
    context: options.context,
    browser: options.browser,
    step: makeStepApi(
      options.binding.scope,
      options.resolvedParameters,
      // A condition writes nothing the report shows; a `setVar` still lands in
      // the live map, like any entry's.
      {},
      options.envData,
      options.uploadPaths,
      false,
      // No watcher: the framework has settled the page before a condition is
      // asked, and a condition does not act, so `step.settle()` returns at once.
      {},
    ),
    log: createCapturingLog(options.label, logs),
    tabs: options.tabs ?? unavailableTabApi(),
    browsers: options.browsers ?? unavailableBrowserApi(),
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
  };

  try {
    const value: unknown = await Promise.resolve(entry.condition(ctx));
    if (typeof value !== 'boolean') {
      return {
        status: 'failed',
        expectationFailed: false,
        durationMs: Date.now() - start,
        logs,
        error: nonBooleanConditionError(value),
      };
    }
    return {
      status: 'passed',
      value,
      expectationFailed: false,
      durationMs: Date.now() - start,
      logs,
    };
  } catch (err) {
    return {
      status: 'failed',
      expectationFailed: err instanceof CodeBehindExpectationError,
      ...(err instanceof CodeBehindDeliberateFailure && { deliberate: true }),
      durationMs: Date.now() - start,
      logs,
      error: err instanceof Error ? err.message : String(err),
      ...(isNonRetryable(err) && {
        nonRetryable: true,
        nonRetryableKind: nonRetryableKindOf(err),
      }),
    };
  }
}

/** What a run lends the step API beyond the variable view. */
interface StepApiRuntime {
  /** `step.settle()` — the wait on this entry's armed watcher (§6.4). */
  settle?: () => Promise<void>;
  /**
   * The entry ACTS on the page (`entryActs`, §6.3): its failed `step.check`
   * fails the step rather than healing it (§6.5). Absent — a condition entry,
   * which never acts — and a failed check heals like any throw.
   */
  acts?: boolean;
  /** The page a `step.read` / `step.count` reads — the active one, after a
   *  tab switch the entry made (§6.6). Absent, and they throw. */
  page?: () => Page;
  /** The run's abort signal. */
  signal?: AbortSignal | undefined;
  /** How long a count or a read of every match waits for its matches to
   *  stop changing (§6.6). */
  readTimeoutMs?: number | undefined;
}

/**
 * The frame-aware variable view.
 *
 * Generated code is written **once per skill**, not per invocation, so it uses
 * the name the author wrote (`username`). The expander rewrote *this*
 * invocation's step text to `__skill<N>_username` — or to a caller's output
 * alias — and it interpolated declared parameters straight into the text,
 * where they exist under no runtime name at all. So a read resolves in three
 * steps and a write in one:
 *
 *  1. the frame's rename table (internal names + output aliases),
 *  2. the frame's captured inputs (declared parameters),
 *  3. for a DOTTED name whose root the frame renames, the same name with its
 *     ROOT renamed (`order.id` → `__skill3_order.id`: a `For each {{order}}`
 *     inside a skill body binds the scoped keys) — and, like step 1, that
 *     answer is final,
 *  4. the bare name,
 *  5. the environment: `data.url`, `env.BASE_URL`, `<source>.path`,
 *     `envName` — the name inside a `${...}` placeholder, resolved against
 *     the run's context the way the parser resolved the placeholder
 *     (stories/codebehind-env-data.md). Parameters win, as they would in
 *     the markdown; a run with no environment answers `undefined`.
 *
 * Steps at the top level, or in a section that is neither looped nor inside a
 * skill, have an empty scope, so the first four collapse to "the bare name"
 * and this behaves exactly like the tool executor's `step`.
 *
 * A step inside a LOOPED section does have a scope: its iteration's row
 * arrives as `inputs`, so `getVar('file')` answers that iteration's cell
 * (stories/data-driven-rows.md, part B). That is what lets one generated
 * entry serve every iteration.
 */
function makeStepApi(
  scope: CodeBehindVarScope,
  resolvedParameters: Record<string, string>,
  outputs: Record<string, string>,
  envData?: EnvDataContext | undefined,
  uploadPaths?: UploadPathContext | undefined,
  /** Whether the step's authored text claims a RETURN — `return` or `stop`,
   *  not `fail` — which is what `step.exit()` is allowed on
   *  (stories/step-flow-control.md, decision 11). */
  claimsReturn = false,
  /** What the entry's run lends the step API beyond variables — see
   *  {@link StepApiRuntime}. */
  runtime: StepApiRuntime = {},
): CodeBehindStepApi {
  const api: CodeBehindStepApi = {
    getVar(name) {
      // Own properties throughout: a bare index into any of these three plain
      // objects answers `getVar('constructor')` / `getVar('toString')` with a
      // FUNCTION off `Object.prototype`, and the generated code — whose
      // signature promises `string | undefined` — then acts on it.
      const renamed = Object.hasOwn(scope.renames, name) ? scope.renames[name] : undefined;
      if (renamed !== undefined) {
        return Object.hasOwn(resolvedParameters, renamed)
          ? resolvedParameters[renamed]
          : undefined;
      }
      const input = Object.hasOwn(scope.inputs, name) ? scope.inputs[name] : undefined;
      // A caller may have passed `{{outer}}` through as the argument, which
      // the expander interpolates into the body text at run time rather than
      // at expansion time. Resolve it the same way here — and then resolve
      // `${env.X}` / `${data.X}` the way the parser resolved the step text,
      // because the expander captured the argument RAW (env-data
      // interpolation runs after expansion and never walks frame inputs).
      // Fail fast on a reference this run cannot answer: silently handing
      // generated code the literal "${data.x}" text is the same failure with
      // no error message.
      if (input !== undefined) {
        const value = interpolate(input, resolvedParameters);
        const refs = envDataRefsIn(value);
        if (refs.length === 0) return value;
        if (!envData) {
          throw new Error(
            `frame input "${name}" references \${${refs[0]}} and the run has no environment context to resolve it`,
          );
        }
        return interpolateEnvData(value, envData);
      }
      // A DOTTED name whose root the frame renames — `order.id` inside a
      // skill body whose `For each {{order}}` the expander rewrote to
      // `{{__skill3_order}}`. The pass bound `__skill3_order.id`, so without
      // this the entry answered `undefined` on exactly the step the loop exists
      // to vary (stories/codebehind-loops-and-conditions.md, "The entry,
      // loading and running it").
      //
      // BEFORE the bare name, and final like the flat rename above: the frame
      // renames `order`, so `order.id` in this frame IS `__skill3_order.id`.
      // Asked after the bare map, an outer `For each {{order}}` — current, or
      // left behind by an earlier loop — answered with the OUTER item's id
      // while `getVar('order')` answered with the inner item: one step reading
      // two different orders.
      const scoped = dottedThroughRename(name, scope.renames);
      if (scoped !== undefined) {
        return Object.hasOwn(resolvedParameters, scoped)
          ? resolvedParameters[scoped]
          : undefined;
      }
      const bare = Object.hasOwn(resolvedParameters, name)
        ? resolvedParameters[name]
        : undefined;
      if (bare !== undefined) return bare;
      return envData ? resolveEnvDataRef(name, envData) : undefined;
    },
    setVar(name, value) {
      const effective = (Object.hasOwn(scope.renames, name) ? scope.renames[name] : undefined) ?? name;
      const stored = Array.isArray(value)
        ? JSON.stringify(value)
        : typeof value === 'string' ? value : String(value);
      // Through the one helper: a code-behind capture can land on a name a
      // `For each` is binding, and §8.2 says a rebind of a root erases that
      // root's dotted keys — otherwise the last pass's `order.id` answers
      // every later `{{order.id}}`.
      bindVariable(resolvedParameters, effective, stored);
      outputs[effective] = stored;
    },
    expect(condition, message) {
      if (!condition) {
        throw new CodeBehindExpectationError(message ?? 'Code-behind expectation failed');
      }
    },
    check(condition, message) {
      if (condition) return;
      const said = typeof message === 'string' && message.trim() !== '' ? message : "the entry's own check";
      // A heal re-runs the step under AI, and after a click that can submit
      // twice: in an entry that acts, a failed self-check fails the step, as a
      // failed `expect` does (§6.5).
      if (runtime.acts === true) throw new CodeBehindExpectationError(`${SELF_CHECK_FAILED}${said}`);
      throw new CodeBehindCheckError(said);
    },
    async settle() {
      // The wait after an action (docs/specs/SPEC-codebehind-robustness.md
      // §6.4), on the watcher armed for this entry. Never throws: a settle
      // that cannot complete leaves the entry to read the page as it is.
      await runtime.settle?.().catch(() => {});
    },
    fail(message) {
      // No claim guard, the mirror of `exit`'s (decision 10): the unsafe direction
      // for an exit is passing work that did not happen, and there is no unsafe
      // direction for failing. A missing or empty message still fails, with a
      // sentence of our own in place of an empty error cell.
      throw new CodeBehindDeliberateFailure(
        typeof message === 'string' && message.trim() !== '' ? message : FAIL_WITHOUT_MESSAGE,
      );
    },
    exit() {
      // The claim guard (stories/step-flow-control.md, decision 11). Refused
      // here rather than at generation time because a `.steps.ts` is a
      // hand-editable file: an author can write `step.exit()` into any entry,
      // and the rule that the markdown must say what the code does has to hold
      // for hand-written entries too.
      //
      // A `fail` claim is not a claim to return (decision 1) and is refused here
      // with every other unclaimed line: that markdown says the step ends the RUN
      // in the author's words, and an exit would end the flow as a PASS instead —
      // the exact "green for work not done" the guard exists to prevent.
      if (!claimsReturn) throw exitNotClaimed();
      throw new CodeBehindExitSignal();
    },
    filePath(relative) {
      // `step.filePath(step.getVar('x'))` is the parameterised form, and
      // `getVar` answers `undefined` for a name this run has no value for —
      // say so, rather than letting "undefined" become a path segment.
      if (typeof relative !== 'string' || relative.trim() === '') {
        throw nonRetryable(
          'step.filePath needs a path; it was given '
          + (relative === undefined
            ? 'nothing (step.getVar returned undefined?)'
            : JSON.stringify(relative))
          + '. Pass the path as written in the step',
        );
      }
      return resolveUploadPathSync(relative, uploadPaths ?? {});
    },
    read(options) {
      return recordedRead('read', options, { api, scope, resolvedParameters, outputs, envData, runtime });
    },
    async count(options) {
      return Number(
        await recordedRead('count', options, { api, scope, resolvedParameters, outputs, envData, runtime }),
      );
    },
  };
  return api;
}

/** How long the number of matches must hold still before a count or a read
 *  of every match takes them (§6.6). */
const MATCHES_QUIET_MS = 300;

/**
 * `step.read` / `step.count`: the AI's `read` or `count` action, run again —
 * the code half of a step compiled from its recording
 * (docs/specs/SPEC-codebehind-robustness.md §6.6, D7).
 *
 * The same PATH, not just the same reader: the action goes through
 * `executeAction`, which cleans the selector, moves an iframe written into it
 * to the frame field and resolves the frame before it reads — exactly as when
 * the model emitted it. So on the same page it produces exactly what the run
 * produced, and stores it the same way (`storeCapture`, under the frame's name
 * for the capture, as `step.setVar` does).
 *
 * Before a count or a read of every match it waits for the number of matches
 * to hold still for 300 ms: neither waits for elements on its own, and the AI's
 * read came after the page had settled and the model had thought.
 *
 * Its self-check: given the `kinds` the run's read matched, a match of any
 * other kind fails as `step.check` does — in an entry that only reads, the
 * step falls back to AI and the entry is regenerated. An empty result passes:
 * the entry was compiled from a read the model was shown and kept when it
 * came back empty or mixed (src/runner/list-read-review.ts), and one it
 * replaced is never compiled.
 */
async function recordedRead(
  kind: 'read' | 'count',
  options: StepReadOptions,
  ctx: {
    api: CodeBehindStepApi;
    scope: CodeBehindVarScope;
    resolvedParameters: Record<string, string>;
    outputs: Record<string, string>;
    envData: EnvDataContext | undefined;
    runtime: StepApiRuntime;
  },
): Promise<string | string[]> {
  const page = ctx.runtime.page?.();
  if (!page) throw new Error(`step.${kind} needs a page, and this run has none`);
  if (typeof options?.selector !== 'string' || options.selector.trim() === '') {
    throw new Error(`step.${kind} needs a selector`);
  }
  // A placeholder in a recorded field is the AUTHORED name: filled through
  // the frame, as `step.getVar` reads it.
  const fill = (text: string): string =>
    text
      .replace(PLACEHOLDER_IN_FIELD, (_m, name: string) => valueOrThrow(kind, `{{${name}}}`, ctx.api.getVar(name)))
      .replace(/\$\{([^}]+)\}/g, (_m, ref: string) => valueOrThrow(kind, `\${${ref}}`, ctx.api.getVar(ref)));
  const effective =
    options.as === undefined
      ? undefined
      : ((Object.hasOwn(ctx.scope.renames, options.as) ? ctx.scope.renames[options.as] : undefined) ?? options.as);
  const action: AIAction = {
    action: kind,
    selector: fill(options.selector),
    ...(kind === 'read' && options.multiple === true && { multiple: true }),
    ...(kind === 'read' && options.attribute !== undefined && { attribute: fill(options.attribute) }),
    ...(kind === 'read' && options.pattern !== undefined && { pattern: fill(options.pattern) }),
    ...(options.frame !== undefined && { frame: fill(options.frame) }),
    ...(effective !== undefined && { as: effective }),
    description: `${kind} ${options.selector} (code-behind)`,
  };
  const plural = kind === 'count' || options.multiple === true;
  const kinds = options.kinds ?? [];
  const result = await executeAction(page, action, undefined, ctx.runtime.signal, {
    ...(kinds.length > 0 && { kinds: true }),
    ...(plural && {
      settleMatches: { quietMs: MATCHES_QUIET_MS, timeoutMs: ctx.runtime.readTimeoutMs ?? 10_000 },
    }),
  });
  if (!result.success) throw new Error(result.error ?? `step.${kind} failed`);

  // The self-check, before anything is stored: a wrong read must not reach the
  // map, even for the moment before the step falls back to AI.
  if (kinds.length > 0 && result.kinds !== undefined) {
    const other = result.kinds.filter((k) => !kinds.includes(k));
    if (other.length > 0) {
      ctx.api.check(
        false,
        `the ${kind} matched ${other.map((k) => `\`${k}\``).join(', ')} where the run read ` +
          `${kinds.map((k) => `\`${k}\``).join(', ')}`,
      );
    }
  }

  if (effective !== undefined) {
    const stored = storeCapture(ctx.resolvedParameters, effective, result, () =>
      runSecrets({ parameters: ctx.resolvedParameters, ...(ctx.envData !== undefined && { envData: ctx.envData }) }),
    );
    if (stored !== undefined) ctx.outputs[effective] = stored;
  }
  return result.capturedValues ?? result.capturedValue ?? '';
}

/** A placeholder's value, or a throw naming it: a read built around a missing
 *  value would read something else entirely. */
function valueOrThrow(kind: string, placeholder: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`step.${kind}: ${placeholder} has no value on this run`);
  }
  return value;
}

/**
 * The entry's source text, for the report's collapsed code block.
 *
 * Read off the imported function rather than re-reading the file: the entry
 * that ran is the one shown, even when the file has since been edited.
 */
export function entrySourceText(entry: StepCodeEntry): string {
  if (entry.run) return String(entry.run);
  if (entry.condition) return String(entry.condition);
  return '(no run function)';
}
