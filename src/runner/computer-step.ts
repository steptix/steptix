/**
 * One step, answered from a screenshot of the machine's screen
 * (docs/specs/SPEC-use-computer.md §5.5).
 *
 * The computer surface's counterpart to `executeStep`, and deliberately a
 * SEPARATE function rather than a branch inside it. The two loops share a
 * shape — capture, prompt, parse, act, settle, capture — and share nothing
 * else: there is no DOM to snapshot, no selector to resolve, no page to
 * settle, nothing recorded to replay (§5.5: a recorded coordinate has nothing
 * to validate against and would replay blind), and the action vocabulary is a
 * different union. A branch inside `executeStepAttempt` would have had to
 * guard every one of its ~1400 lines.
 *
 * What IS shared is shared by import, not by copy, and the imports say which:
 *
 *  - `withRetry` and the prior-failure plumbing, so a computer step retries
 *    exactly as a page step does (§5.5).
 *  - The `return` / `fail` claim guards — `RETURN_NOT_CLAIMED`,
 *    `FAIL_NOT_CLAIMED`, `composeDeliberateFailure` — because the rule that a
 *    model may only end a flow on a step whose text says to is about the
 *    STEP, not about the surface.
 *  - `buildStepValues` + `maskValueForPrompt`, so the `## Values` a model
 *    reads here is masked by the same three rules it is on the page.
 *  - `executeApiCallAction`, so `api_call` on this surface is the same call it
 *    is on the other one (§5.4: "as today — they touch no surface").
 *  - `applyFailureTail`, so an `… otherwise continue` tail means the same
 *    thing on either surface — and `stripFailureTail` + `enrichAuthored`, so
 *    the model reads the step as the page model does: no tail, and
 *    `[output: x]` as `[store as: x]`.
 *
 * Everything that touches the screen is behind `src/desktop/` and is not
 * re-implemented here: this file decides WHICH action to take and what to do
 * with the answer, and `executeComputerAction` performs it.
 */
import type { AIAction } from '../ai/types.js';
import type { ChatMessage } from '../ai/types.js';
import type { CompleteResult } from '../ai/client.js';
import type {
  AiInteraction,
  AssertionResult,
  StepResult,
  SubActionResult,
  TurnResult,
} from '../report/types.js';
import { formatTestInfo, maskValueForPrompt } from '../ai/prompts.js';
import { isSecretParameterName, isSecretRef, redact } from '../utils/secrets.js';
import { bindVariable } from '../parser/parameters.js';
import { isReturnClaim, parseFlowControlStep } from '../parser/flow-control-step.js';
import { logger } from '../utils/logger.js';
import { withRetry } from './retry.js';
import { substituteAction } from './placeholder-substitution.js';
import type { PlaceholderValues } from './placeholder-substitution.js';
import {
  FAIL_NOT_CLAIMED,
  RETURN_NOT_CLAIMED,
  applyFailureTail,
  buildStepValues,
  composeDeliberateFailure,
  enrichAuthored,
  executeApiCallAction,
  secretsFor,
  type ComputerStepContext,
  type StepExecutorOptions,
} from './step-executor.js';
import { stripFailureTail } from '../parser/failure-tail.js';
import {
  ComputerStallDetector,
  DEFAULT_MAX_IMAGE_WIDTH,
  INPUT_ACTION_TYPES,
  SCREEN_CHANGING_ACTION_TYPES,
  acquireComputerLock,
  buildComputerStepMessage,
  buildComputerSystemPrompt,
  captureView,
  computerStallMessage,
  executeComputerAction,
  parseComputerActions,
  releaseComputerLock,
  type ComputerAction,
  type ComputerLockOptions,
  type DesktopAdapter,
  type ImageView,
} from '../desktop/index.js';
import {
  checkVisionRoute,
  imageInputUnsupportedMessage,
  type VisionRouteAi,
  type VisionRouteResult,
} from '../desktop/vision-route.js';
import type { DesktopConfig } from '../config/types.js';
import { parseToolCall } from '../tools/tool-call-parser.js';
import { parseSkillCall } from '../skills/skill-call-parser.js';
import { unknownWholeStepBracketError } from '../parser/whole-step-bracket.js';
import { parseUseAiStep, parseUseStep } from '../parser/use-step.js';
import { parseSetStep } from '../parser/set-step.js';
import { planAtGuard, type ControlRecord, type ControlState } from './control-flow.js';
import { recordExecutedStep } from './run-stats.js';

/** Options for a computer-mode step: a step's ordinary options, with the
 *  surface's own context guaranteed present. */
export type ComputerStepOptions = StepExecutorOptions & {
  computer: ComputerStepContext & {
    /** §5.5 — the step's wait budget. The runners leave it out and get
     *  {@link COMPUTER_WAIT_BUDGET_MS}; a test passes a small one. */
    waitBudgetMs?: number | undefined;
  };
};

// ---------------------------------------------------------------------------
// Entering and leaving the surface (§5.1, §4.5)
// ---------------------------------------------------------------------------

/** §5.1 item 1, in the spec's own words. */
export const COMPUTER_DISABLED_MESSAGE =
  'computer mode is disabled for this project; set `desktop.enabled: true` in steptix.config.json';

/**
 * The state a run keeps about which surface it is on (§4.5).
 *
 * Held by the session in the server and by a local in the CLI runner, and
 * passed here by reference so one implementation of the state machine serves
 * both — the alternative being two, which is how the two loops would come to
 * disagree about what `[use computer]` does on the second entry.
 */
export interface SurfaceState {
  surface: 'browser' | 'computer';
  /** The adapter this run loaded, while it is in computer mode. Dropped on the
   *  way back to `browser` so nothing can drive the mouse off-surface. */
  adapter?: DesktopAdapter | undefined;
  /**
   * Whether this session holds the machine-wide computer lock RIGHT NOW
   * (§5.9) — which is not the same question as whether it is on the computer
   * surface.
   *
   * The surface outlives a run; the lock does not. A session's surface stays
   * `computer` across a batch boundary (Steptix posts one batch at a time,
   * MCP keeps a session open between calls), but the lock is released at the
   * end of every run and taken again, lazily, at the next step that reads or
   * drives the screen. Measured: an MCP `run_test_file` that ended in computer
   * mode left `steptix-computer.lock` held by an idle session, which would have
   * refused every other computer-mode run on the machine until something
   * closed it.
   *
   * The same goes for a pause inside a run: a run waiting for a person — a
   * breakpoint, step mode, a debugger attach, an `[input:]` prompt — gives the
   * lock back before it waits, and takes it again the same lazy way.
   *
   * Tracked here rather than read off the file each step, so the per-step
   * gate costs nothing when the session already holds it. Every write goes
   * through {@link enterComputerMode}, {@link ensureComputerLock},
   * {@link releaseComputerLockAtRunEnd}, {@link releaseComputerLockForPause}
   * and {@link leaveComputerMode}.
   */
  lockHeld?: boolean | undefined;
}

/**
 * The default §5.1 item 2 loader, and the ONE place outside `src/desktop/`
 * that names `nut-adapter.js`.
 *
 * A dynamic import, at the moment a step asks for computer mode — which is why
 * `src/desktop/index.ts` deliberately does not re-export this file as a value.
 * Importing the barrel must never be what pulls nut.js in: the package carries
 * a prebuilt native binary, and a machine without one must still run every
 * browser test.
 */
export async function defaultLoadDesktopAdapter(): Promise<DesktopAdapter> {
  const { loadNutAdapter } = await import('../desktop/nut-adapter.js');
  return loadNutAdapter();
}

/** The default §5.1 item 4 probe, loaded on the same terms. */
export async function defaultProbeComputerCapture(adapter: DesktopAdapter): Promise<void> {
  const { probeComputerCapture } = await import('../desktop/nut-adapter.js');
  return probeComputerCapture(adapter);
}

export interface EnterComputerModeInput {
  /** Who holds the lock (§5.9). The session id on the server; the run's own
   *  identity on the CLI — see `computerLockIdFor`. */
  lockId: string;
  /**
   * THIS project's `desktop` section — the one loaded from the test file's
   * `steptix.config.json`, not the server's startup config.
   *
   * The section alone rather than the whole `Config`, and that narrowing is
   * the fix for a measured defect: on the server path the `Config` an
   * executor is handed is rebuilt by `resolveRunSettings`
   * (src/config/run-settings.ts) by spreading the SERVER's startup config, so
   * `config.desktop` there was always the server's answer. A project that had
   * opted in was refused because the server had not. Taking `desktop` on its
   * own makes every caller name which project's it is. `undefined` reads as
   * "off", exactly like a missing section (§5.1 item 1).
   */
  desktop: DesktopConfig | undefined;
  state: SurfaceState;
  /** §5.1 item 2 — the lazy nut.js load, injectable so tests never import it
   *  and a machine with no prebuilt binary still runs every browser test. */
  loadDesktopAdapter: () => Promise<DesktopAdapter>;
  /** §5.1 item 4 — the one capture probe. Injectable for the same reason. */
  probeCapture: (adapter: DesktopAdapter) => Promise<void>;
  /** Test seam for the lock file. */
  lock?: ComputerLockOptions | undefined;
  /**
   * §5.1 item 1b / §15.4 — the AI route the NEXT computer-mode request would
   * go out on: the model, gateway URL and key the run's AI client holds at the
   * moment of `[use computer]`. Each caller says which object that is.
   *
   * `undefined` on a keyless run (no key, or AI forbidden by policy), and the
   * check is then skipped: computer mode needs a model whatever the route, and
   * the step's first turn already says so in the words that fit the reason.
   */
  ai?: VisionRouteAi | undefined;
  /** §15.4's check, injectable so no test reaches the network. Defaults to
   *  {@link checkVisionRoute}. */
  checkVisionRoute?: ((ai: VisionRouteAi) => Promise<VisionRouteResult>) | undefined;
}

/**
 * `[use computer]` — §5.1's preconditions (1, 1b, 2, 3, 4), in order, each
 * failing the step with the message the spec gives.
 *
 * Returns an error STRING rather than throwing, because the caller's job with
 * it is to fail one step: the run carries on, the report shows the row, and
 * a later `[use browser]` step still works.
 *
 * Re-entering the surface already in force is a no-op with a log line (§4.5):
 * a section that defensively opens with `[use computer]` must not pay for a
 * second adapter load or capture probe. The one thing re-entry still does is
 * take the lock when this run does not hold it yet — the session came into
 * this run on the computer surface, and the previous run released the lock on
 * its way out (§5.9).
 *
 * The opt-in (1) is asked FIRST, re-entry included. The project's config is
 * re-read every batch, and a session that entered while the owner allowed it
 * must not carry on once they have switched it off: re-entry used to skip the
 * check and take the lock. Refused on the computer surface, the session is put
 * back on the browser — {@link leaveComputerMode}, lock and adapter dropped.
 */
export async function enterComputerMode(
  input: EnterComputerModeInput,
): Promise<{ ok: true; reentered: boolean } | { ok: false; error: string }> {
  const { state } = input;

  // 1. Project opt-in. A test file in a shared project must not be able to
  //    move the mouse on a machine whose owner did not allow it.
  if (input.desktop?.enabled !== true) {
    if (state.surface === 'computer') {
      revokeComputerMode(state, input.lockId, input.lock);
    }
    return { ok: false, error: COMPUTER_DISABLED_MESSAGE };
  }

  if (state.surface === 'computer' && state.adapter) {
    const taken = ensureComputerLock(state, input.lockId, input.lock);
    if (!taken.ok) return taken;
    log('already on the computer surface — [use computer] is a no-op here');
    return { ok: true, reentered: true };
  }

  // 1b. The model can see the screen (§15.4). Before nut.js loads, so a route
  //     known to drop images costs nothing on the machine: no native binary,
  //     no lock, no capture. Checked once, here — a model changed afterwards
  //     through run settings is caught by the bridge's 400 instead.
  if (input.ai) {
    const route = await (input.checkVisionRoute ?? checkVisionRoute)(input.ai);
    if (!route.ok) return { ok: false, error: route.error };
    if (route.note) logger.debug(`[computer] vision route: ${route.note}`);
  }

  // 2. nut.js loads — here and never at server start.
  let adapter: DesktopAdapter;
  try {
    adapter = await input.loadDesktopAdapter();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 3. The lock is free or stale.
  try {
    acquireComputerLock(input.lockId, input.lock ?? {});
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 4. A capture succeeds. One grab, as a probe — the measured
  //    read-screen-right failure is this check's whole reason for existing.
  try {
    await input.probeCapture(adapter);
  } catch (err) {
    // The lock was taken a line ago and this session is not going to use it.
    releaseComputerLock(input.lockId, input.lock ?? {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  state.surface = 'computer';
  state.adapter = adapter;
  state.lockHeld = true;
  log('surface → computer');
  return { ok: true, reentered: false };
}

/**
 * `[use browser]` — release the lock, drop the adapter, go back to the page
 * (§4.5). Nothing can fail here: the browser launches at the NEXT step, under
 * the launch gate, and its failure is that step's (§4.6).
 *
 * Touches the lock file only when this session holds the lock. A session that
 * sits on the computer surface between runs holds nothing, and the lock may
 * meanwhile belong to another session — `releaseComputerLock` would refuse to
 * delete that record anyway, but not reading it at all is what "a no-op when
 * the lock is not held" means.
 */
export function leaveComputerMode(
  state: SurfaceState,
  lockId: string,
  lock?: ComputerLockOptions,
  /** `quiet` for the teardown call every run makes whether or not it ever
   *  entered computer mode: §4.5's "a log line, not an error" is about the
   *  DIRECTIVE, and an info line on every browser-only run would be noise. */
  opts?: { quiet?: boolean },
): { reentered: boolean } {
  if (state.surface === 'browser') {
    if (opts?.quiet) logger.debug('[computer] teardown: not on the computer surface');
    else log('already on the browser surface — [use browser] is a no-op here');
    return { reentered: true };
  }
  if (state.lockHeld) releaseComputerLock(lockId, lock ?? {});
  state.lockHeld = false;
  state.surface = 'browser';
  state.adapter = undefined;
  log('surface → browser');
  return { reentered: false };
}

/**
 * The project's owner switched computer mode off while this session sat on the
 * computer surface (§5.1 item 1): back to the browser exactly as `[use
 * browser]` goes — lock released if held, adapter dropped — with a WARN saying
 * why. The caller fails the step it was about to run on the computer surface
 * with {@link COMPUTER_DISABLED_MESSAGE}, before anything is captured.
 *
 * Called from `[use computer]` re-entry and from the step boundary of both
 * loops, whichever meets the switched-off config first. A no-op off the
 * computer surface.
 */
export function revokeComputerMode(
  state: SurfaceState,
  lockId: string,
  lock?: ComputerLockOptions,
): void {
  if (state.surface !== 'computer') return;
  logger.warn(
    `[computer] ${COMPUTER_DISABLED_MESSAGE} — this session was on the computer surface and ` +
      'goes back to the browser',
  );
  leaveComputerMode(state, lockId, lock, { quiet: true });
}

/**
 * The lazy re-take (§5.9): the lock for a step about to read or drive the
 * screen, when this session does not hold it already — because an earlier run
 * released it on the way out, or because this run released it at a pause.
 *
 * Called at the step boundary by both loops, in the same spot and on the same
 * terms as the lazy browser launch (§4.6), and by `[use computer]` re-entry.
 * A refusal is §5.9's message, returned rather than thrown for the
 * reason {@link enterComputerMode} gives: the caller's job with it is to fail
 * one step, before anything is captured or asked of the model.
 *
 * `acquireComputerLock` compares the holder's SESSION as well as its pid, so a
 * second session in the same server process is refused while the first holds
 * the lock, exactly as a session in another process would be.
 */
export function ensureComputerLock(
  state: SurfaceState,
  lockId: string,
  lock?: ComputerLockOptions,
): { ok: true } | { ok: false; error: string } {
  if (state.lockHeld) return { ok: true };
  try {
    acquireComputerLock(lockId, lock ?? {});
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  state.lockHeld = true;
  logger.debug(`[computer] lock taken for session ${lockId}: the next step reads or drives the screen`);
  return { ok: true };
}

/**
 * Release the lock at the end of a run, whatever ended it (§5.9) — and ONLY
 * the lock. The surface stays `computer` and the adapter stays loaded, so the
 * session's next run carries on where this one stopped and takes the lock back
 * at its first computer step ({@link ensureComputerLock}).
 *
 * A no-op when the lock is not held: a browser-only run, a run that never
 * reached a computer step, or one whose re-take was refused.
 */
export function releaseComputerLockAtRunEnd(
  state: SurfaceState,
  lockId: string,
  lock?: ComputerLockOptions,
): void {
  if (!state.lockHeld) return;
  releaseComputerLock(lockId, lock ?? {});
  state.lockHeld = false;
  logger.debug(
    `[computer] run ended: lock released for session ${lockId}; the session stays on the ` +
      `${state.surface} surface and takes the lock again at its next computer step`,
  );
}

/**
 * Release the lock because the run is about to wait for a person (§5.9): a
 * breakpoint, a step-mode pause, a debugger attach, an `[input:]` prompt, an
 * `[interactive]` or failure REPL. Called immediately BEFORE the wait begins,
 * at every place either loop parks for someone.
 *
 * A run waiting for a person must not hold the machine-wide mouse lock: that
 * wait can last as long as the person likes, and another session refused the
 * whole time is exactly what the run-end release exists to prevent.
 *
 * Only the lock, as at run end — the surface and the adapter stay. Nothing is
 * taken back here on resume: the next step that reads or drives the screen
 * takes it at the step boundary ({@link ensureComputerLock}), and fails with
 * §5.9's "in use" message if another session took it meanwhile. A step that
 * touches no screen (`Set`) never needed it; a `[tool:]` line does
 * ({@link stepReadsScreen}).
 *
 * A no-op when the lock is not held, which is every pause off the computer
 * surface (`leaveComputerMode` released it on the way out) and every pause the
 * run reaches before its first computer step.
 */
export function releaseComputerLockForPause(
  state: SurfaceState,
  lockId: string,
  lock: ComputerLockOptions | undefined,
  /** What the run is waiting for, for the log line. */
  why: string,
): void {
  if (!state.lockHeld) return;
  releaseComputerLock(lockId, lock ?? {});
  state.lockHeld = false;
  logger.debug(
    `[computer] paused (${why}): lock released for session ${lockId}; the next step that ` +
      'reads or drives the screen takes it again',
  );
}

/**
 * The two steps that wait for a person, as the CLI recognises them
 * (`INPUT_STEP_PATTERN` / `INTERACTIVE_STEP_PATTERN` in test-runner.ts).
 *
 * The CLI's spelling rather than the server's `isSkippableStep`, whose
 * `[input:` match ignores case: `[INPUT: x]` is prose to the CLI, so the CLI
 * hands it to `executeComputerStep`, and excluding it here would drive the
 * mouse unlocked. The narrower match errs the safe way — on the server that
 * line is skipped, and counting it costs a lock taken one step early.
 */
const PERSON_STEP_RES: readonly RegExp[] = [/^\[input:\s*\w+\]/, /^\[interactive\]/i];

/**
 * Does this step read or drive the screen when it runs on the computer
 * surface — and so need the lock (§5.9)?
 *
 * For a step that is NOT a control-flow guard; a guard asks
 * {@link guardVisitReadsScreen}. Read off the AUTHORED line, the same text
 * both loops dispatch on.
 *
 * No, for the steps both loops answer without a capture, a model call or a
 * program of their own:
 *
 *  - `Set {{x}} to "…"` — an assignment;
 *  - `[use ai] <step>` — one model call about the step's own text, with no
 *    capture of anything (stories/use-ai-step.md);
 *  - a whole-step `Return` / `Stop running the remaining steps` / `Fail the
 *    test with error "…"` — nothing to judge;
 *  - a `[tool: …]` line that does not parse, a raw `[skill: …]` line, and a
 *    bracket §4.2 refuses, which fail with §5.4's message before anything
 *    runs;
 *  - a `[use …]` line, which the surface switch owns (`[use computer]`
 *    re-entry takes the lock itself, in {@link enterComputerMode});
 *  - an `[input: name] …` or `[interactive]` step, which waits for a person
 *    (the CLI prompts, and its REPL drives the page; the server skips both).
 *    Counting them would take the lock at the boundary only for the pause to
 *    give it back a line later ({@link releaseComputerLockForPause}), and would
 *    fail the prompt with §5.9's message when another session holds it.
 *
 * Everything else is yes, and deliberately so: a prose step goes to
 * `executeComputerStep`, and that includes an `If … then return` claim, whose
 * condition is judged from the screen (§5.6). A step this list misses costs a
 * lock taken one step early inside a run that is executing anyway; a step it
 * wrongly excluded would drive the mouse unlocked.
 *
 * A `[tool: …]` line that parses is yes. It reads no screen, but it is code
 * that can drive the machine: the fixture `open_calculator` launches a GUI
 * program, and one run unlocked after a pause could take the front window from
 * another session's computer-mode run. It takes the lock like a screen step,
 * and only on this surface — both loops ask this only there.
 */
export function stepReadsScreen(step: string): boolean {
  if (parseUseStep(step)) return false;
  // `[use ai] <step>`: one model call with no capture and no program — the
  // step text is everything the model sees (stories/use-ai-step.md, decision
  // 8) — so it takes no lock, on this surface or any.
  if (parseUseAiStep(step)) return false;
  if (PERSON_STEP_RES.some((re) => re.test(step))) return false;
  if (parseSetStep(step)) return false;
  const claim = parseFlowControlStep(step);
  if (claim && claim.body === undefined) return false;
  const tool = tryParse(() => parseToolCall(step));
  if (tool !== null) return 'value' in tool;
  if (tryParse(() => parseSkillCall(step)) !== null) return false;
  if (unknownWholeStepBracketError(step) !== null) return false;
  return true;
}

/**
 * Does the control-flow guard visit about to happen at `index` read the screen
 * on the computer surface (§5.6)?
 *
 * Yes when the visit decides a CONDITION — an `If` chain, or a `While` /
 * `Repeat … until` check — because that is what reaches the condition judge,
 * which captures the screen. No for a visit that asks nobody (a `Repeat`'s
 * first pass, a `For each` revisit) and for a `For each` reading its list,
 * which is a variable, not a screen.
 *
 * A condition that turns out to be decidable from its own values
 * (src/runner/literal-decision.ts) never reaches the judge, and still counts
 * here. Telling the two apart at the boundary would be a second copy of
 * `decideLocally`, and a copy that drifted would let the judge capture the
 * screen unlocked; the cost of NOT telling them apart is a lock taken one step
 * early inside a run that is executing anyway.
 */
export function guardVisitReadsScreen(
  controls: readonly (ControlRecord | null)[],
  index: number,
  state: ControlState,
): boolean {
  const ask = planAtGuard(controls, index, state).ask;
  return ask === 'chain' || ask === 'condition';
}

/** The `'mode'` row a `[use …]` step records (§10.1): passed, zero tokens, no
 *  screenshot, no model call, and `surface` saying which way it went. */
export function modeStepResult(
  index: number,
  instruction: string,
  surface: 'browser' | 'computer',
  reentered: boolean,
): StepResult {
  return {
    index,
    instruction,
    status: 'passed',
    stepKind: 'mode',
    surface,
    turns: [],
    durationMs: 0,
    retried: false,
    aiExplanation: reentered
      ? `Already on the ${surface} surface — nothing to switch.`
      : `Switched to the ${surface} surface.`,
  };
}

/** The `→ computer` / `→ browser` label the report row and the wire event
 *  both use, written once so they cannot disagree. */
export function modeMarkerText(surface: 'browser' | 'computer'): string {
  return `→ ${surface}`;
}

// ---------------------------------------------------------------------------
// A bracket directive nobody dispatched never reaches the model (§5.4)
// ---------------------------------------------------------------------------

/** What the calling loop knows about why a directive went undispatched. */
export interface DirectiveDispatchContext {
  /** A tool catalogue is loaded, so the loop dispatches every `[tool:]` line
   *  through it. False on a Sessions API request that carried no `toolsDir`. */
  toolsLoaded: boolean;
  /** A skills directory was supplied, so every `[skill:]` line should have been
   *  expanded into its body before the loop ever saw it. */
  skillsDirSupplied: boolean;
}

/** The sentence every refusal below ends with: why this surface refuses where
 *  the page surface still hands the line to the model as prose. */
function neverActedOut(kind: 'tool' | 'skill' | 'bracket'): string {
  const what = kind === 'bracket' ? 'a bracket step nobody dispatched is' : `a ${kind} line is`;
  return (
    `In computer mode ${what} never handed to the model, because it would act it out ` +
    'on the real screen.'
  );
}

/** Run an invocation parser, keeping a syntax error as a value: a line that
 *  names a tool but does not parse is still a tool line. */
function tryParse<T>(parse: () => T | null): { value: T } | { error: Error } | null {
  try {
    const value = parse();
    return value === null ? null : { value };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * The failure for a step that is a bracket directive the loop did NOT
 * dispatch, when it is about to be answered on the computer surface — or null
 * for a step that is prose and may go to the model.
 *
 * Measured live: a Sessions API request with no `toolsDir` ran
 * `[tool: open_calculator]` in computer mode. With no catalogue loaded the
 * line fell through to the model as prose, and the model ACTED IT OUT — Win+R,
 * `calc`, Enter — launching a program on the real desktop. On the page
 * surface the same fall-through is legacy and mostly harmless; here it is the
 * one thing computer mode must never let a model do.
 *
 * Detection is by the runner's own parsers, not a new pattern: `parseToolCall`
 * and `parseSkillCall` are what decide elsewhere that a line IS a tool or a
 * skill call (a label before the bracket included), and
 * `unknownWholeStepBracketError` is §4.2's rule for a bracket step that names
 * no directive. Both loops call this only once every other dispatch has
 * passed the step by, immediately before `executeComputerStep`.
 */
export function undispatchedDirectiveError(
  step: string,
  context: DirectiveDispatchContext,
): string | null {
  const tool = tryParse(() => parseToolCall(step));
  if (tool) {
    if ('error' in tool) {
      return (
        `This [tool: …] line was not run: it does not parse. ${tool.error.message}\n` +
        neverActedOut('tool')
      );
    }
    const call = `[tool: ${tool.value.name}]`;
    return context.toolsLoaded
      ? `${call} was not run: the runner did not dispatch it as a tool call. ${neverActedOut('tool')}`
      : `${call} was not run: this request carried no tools directory (toolsDir), so no tool ` +
          `is loaded — declare tests.toolsDir in the project's steptix.config.json so the client ` +
          `sends one. ${neverActedOut('tool')}`;
  }

  const skill = tryParse(() => parseSkillCall(step));
  if (skill) {
    if ('error' in skill) {
      return (
        `This [skill: …] line was not run: it does not parse. ${skill.error.message}\n` +
        neverActedOut('skill')
      );
    }
    const call = `[skill: ${skill.value.name}]`;
    return context.skillsDirSupplied
      ? `${call} was not run: skills are expanded into their steps before the run starts, and ` +
          `this line reached the step loop unexpanded. ${neverActedOut('skill')}`
      : `${call} was not run: this request carried no skills directory (skillsDir), so the ` +
          `skill was never expanded into its steps — declare tests.skillsDir in the project's ` +
          `steptix.config.json so the client sends one. ${neverActedOut('skill')}`;
  }

  // §4.2 is enforced where a FILE is parsed and where MCP assembles steps; a
  // bare Sessions API batch reaches this loop without either. On the page
  // surface that stays as it was. Here it would be a model improvising on the
  // real screen from a word in brackets.
  const bracket = unknownWholeStepBracketError(step);
  if (bracket) return `${bracket} ${neverActedOut('bracket')}`;

  return null;
}

/** The row a refused directive records: failed, zero turns, no model call, on
 *  the computer surface it was refused on. The message is the explanation too,
 *  as it is for the §5.1 refusals, so a client that shows `reasoning` rather
 *  than `error` still says why. */
export function undispatchedDirectiveResult(
  index: number,
  instruction: string,
  error: string,
): StepResult {
  return {
    index,
    instruction,
    status: 'failed',
    surface: 'computer',
    turns: [],
    durationMs: 0,
    retried: false,
    error,
    aiExplanation: error,
  };
}

/**
 * §5.10 read into the shape a step's options take.
 *
 * Takes the `desktop` SECTION, not a whole `Config`, for the reason
 * {@link EnterComputerModeInput.desktop} gives: the server path's `Config` is
 * the server's, and these three values are per project.
 */
export function computerContextFor(
  desktop: DesktopConfig | undefined,
  adapter: DesktopAdapter,
): ComputerStepContext {
  return {
    adapter,
    settleMs: desktop?.settleMs ?? 300,
    maxImageWidth: desktop?.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH,
    reportScreenshots: desktop?.reportScreenshots !== false,
  };
}

// ---------------------------------------------------------------------------
// Skill frames restore the caller's surface (§4.5)
// ---------------------------------------------------------------------------

/**
 * "A skill call restores the caller's surface on return, whatever the skill's
 * body did. An inline section does not."
 *
 * Both runners expand skills and sections at PARSE time into one flat step
 * list, so there is no call to hook and no frame to pop: what there is, per
 * step, is the chain of frames it runs in (`ExpandedStepOrigin.frameId` and
 * each frame's `parentId`). This tracker turns that into the push/pop the rule
 * is written in terms of — a skill frame this step is in and the last one was
 * not is an entry, and the reverse is a return.
 *
 * SKILL frames only, which is the whole distinction §4.5 draws: a section is
 * inline by definition, and a section that switches surface is how an author
 * writes a desktop excursion once and calls it by name.
 *
 * Bookkeeping only: it says which surface to go back to, and the caller does
 * the going, because going back to `computer` is `[use computer]` — §5.1's
 * preconditions, the lock, the opt-in — and can fail. See
 * {@link restoreCallerSurface}.
 */
export class SkillSurfaceStack {
  private readonly open: Array<{ frameId: string; surface: 'browser' | 'computer' }> = [];

  /**
   * Move to the step whose skill-frame chain is `chain` (outermost first), and
   * answer the surface the caller must be put back on — or `null` when this
   * move returns from no skill, or the caller is already on the surface it was
   * on when it made the call.
   *
   * Returning from several skills at once answers the OUTERMOST caller's
   * surface: the ones in between would be put on their surface only to be
   * taken off it again, and a `computer` in between would load an adapter and
   * take the lock for nothing.
   */
  enter(chain: readonly string[], current: 'browser' | 'computer'): 'browser' | 'computer' | null {
    // Everything on the stack this step is no longer inside: returned from,
    // innermost first — so the last one popped is the outermost caller.
    let callerSurface: 'browser' | 'computer' | null = null;
    while (this.open.length > 0 && !chain.includes(this.open[this.open.length - 1]!.frameId)) {
      callerSurface = this.open.pop()!.surface;
    }
    const restoreTo = callerSurface !== null && callerSurface !== current ? callerSurface : null;
    // Everything this step is inside that the stack does not yet hold. A frame
    // entered on this step is entered from the surface the caller is going
    // back to.
    for (const frameId of chain) {
      if (this.open.some((f) => f.frameId === frameId)) continue;
      this.open.push({ frameId, surface: restoreTo ?? current });
    }
    return restoreTo;
  }
}

/**
 * Put a caller back on the surface it was on when it called a skill (§4.5), as
 * {@link SkillSurfaceStack.enter} answered it. Shared by both loops so the two
 * cannot disagree about what "restore" means.
 *
 * - `browser` is `[use browser]`'s transition, and cannot fail.
 * - `computer` is `[use computer]`'s, through `enter` — the caller's own
 *   {@link enterComputerMode} with the inputs its `[use computer]` step takes:
 *   the opt-in, the vision route, the adapter load, the lock, the capture
 *   probe. The skill's `[use browser]` dropped the adapter and released the
 *   lock, so there is nothing to keep; this is a fresh entry. It used to be a
 *   no-op, and the caller's next desktop step went to the page.
 *
 * A refusal comes back as the error for the step the restore was made for —
 * the caller's first step after the skill — to fail with, before anything
 * runs on it.
 */
export async function restoreCallerSurface(
  to: 'browser' | 'computer',
  state: SurfaceState,
  lockId: string,
  lock: ComputerLockOptions | undefined,
  enter: () => Promise<{ ok: true; reentered: boolean } | { ok: false; error: string }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  log(`restoring the caller's surface (${to}) on return from a skill`);
  if (to === 'browser') {
    leaveComputerMode(state, lockId, lock);
    return { ok: true };
  }
  const entered = await enter();
  if (entered.ok) return { ok: true };
  return {
    ok: false,
    error:
      `The caller's computer surface could not be restored when it returned from a skill: ` +
      entered.error,
  };
}

/** The chain of SKILL frame ids a step runs in, outermost first — the input
 *  {@link SkillSurfaceStack.enter} takes. */
export function skillFrameChain(
  frameId: string | undefined,
  frames: Readonly<Record<string, { parentId: string | null; kind: string }>> | null | undefined,
): string[] {
  if (!frameId || !frames) return [];
  const chain: string[] = [];
  let id: string | null = frameId;
  for (let depth = 0; id && depth < 64; depth++) {
    const frame: { parentId: string | null; kind: string } | undefined = frames[id];
    if (!frame) break;
    if (frame.kind === 'skill') chain.unshift(id);
    id = frame.parentId;
  }
  return chain;
}

/**
 * Said once per session, not once per step: `ai.sendScreenshots: false` is a
 * project-wide choice about the PAGE surface, and repeating the override on
 * every computer step would bury the run log under it (§5.2).
 *
 * A module-level set rather than session state because the thing being
 * de-duplicated is a log line, and the session id is all it is keyed on.
 * Exported for the test that proves the line is written once.
 */
const screenshotOverrideAnnounced = new Set<string>();

/** Test-only: forget which sessions have been told about the override. */
export function resetComputerScreenshotNotice(): void {
  screenshotOverrideAnnounced.clear();
}

/** What `parseComputerActions` could not build, phrased for the model (§5.4). */
type Refusal = string;

/**
 * A failed computer-mode attempt, carrying what the report needs.
 *
 * Structurally `retryable`, which is the protocol `withRetry` reads
 * (`isNonRetryable` in retry.ts is duck-typed on purpose) — so a deliberate
 * `fail` ends after one attempt here exactly as it does on the page.
 */
class ComputerStepFailure extends Error {
  turns: TurnResult[];
  retryable: boolean;
  deliberate?: { why: string };
  /** Assertions evaluated before the failure — an `assert` with
   *  `holds: false` IS the failure, and a report row showing the error
   *  without the Expected/Actual block loses the evidence the model gave. */
  assertions: AssertionResult[];
  constructor(
    message: string,
    turns: TurnResult[] = [],
    retryable = true,
    deliberate?: { why: string },
    assertions: AssertionResult[] = [],
  ) {
    super(message);
    this.name = 'ComputerStepFailure';
    this.turns = turns;
    this.retryable = retryable;
    this.assertions = assertions;
    if (deliberate) this.deliberate = deliberate;
  }
}

/** `[computer]`-prefixed, per §10.2. One helper so no line can forget it. */
function log(message: string): void {
  logger.info(`[computer] ${message}`);
}

/**
 * One line of the `## Actions already performed for this step` list.
 *
 * Deliberately close to the `[computer]` log line each action already writes
 * (src/desktop/executor.ts) — the same facts in the same order — so a reader
 * comparing the run log with what the model was shown is comparing two
 * spellings of one thing rather than two accounts of it. `type` prints its
 * LENGTH and never its text, for the reason the executor gives: a
 * computer-mode `type` into a password box looks exactly like one into a
 * filename box.
 */
function performedLine(
  turn: number,
  action: ComputerAction,
  outcome: { screenPoint?: { x: number; y: number }; detail?: string },
  elapsedMs: number,
): string {
  const at = (p?: { x: number; y: number }): string => (p ? ` → screen(${p.x},${p.y})` : '');
  const head = `turn ${turn}: `;
  switch (action.action) {
    case 'click': {
      const extra =
        action.button === 'left' && action.count === 1
          ? ''
          : ` [${action.button}${action.count > 1 ? ` ×${action.count}` : ''}]`;
      return `${head}click image(${action.x},${action.y})${at(outcome.screenPoint)} ok${extra}`;
    }
    case 'move':
      return `${head}move image(${action.x},${action.y})${at(outcome.screenPoint)} ok`;
    case 'drag':
      return (
        `${head}drag image(${action.from.x},${action.from.y})→(${action.to.x},${action.to.y})` +
        `${at(outcome.screenPoint)} ok`
      );
    case 'scroll':
      return (
        `${head}scroll image(${action.x},${action.y}) ${action.direction} ` +
        `×${action.amount}${at(outcome.screenPoint)} ok`
      );
    case 'type':
      return `${head}type ${action.text.length} chars → ok`;
    case 'key':
      return `${head}key ${action.key} → ok`;
    case 'wait':
      return `${head}wait ${action.seconds}s → ok`;
    case 'zoom':
      return (
        `${head}zoom (${action.region.x},${action.region.y},` +
        `${action.region.width},${action.region.height}) → shown`
      );
    case 'focus_window':
      // The executor's own account — `already in front`, `restored from
      // minimised, moved onto the main display, now in front` — which is also
      // what its log line says. "Already in front" is the one the model most
      // needs: it is the case where the screen shows no change at all.
      return `${head}focus_window "${action.title}" → ok (${outcome.detail ?? 'now in front'})`;
    case 'wait_window':
      return (
        `${head}wait_window "${action.title}" ${action.state} → ok after ` +
        `${(elapsedMs / 1000).toFixed(1)}s` +
        (action.requestedTimeoutMs !== undefined
          ? ` (timeoutMs capped at ${action.timeoutMs}ms; you asked for ${action.requestedTimeoutMs}ms)`
          : '')
      );
    default:
      return `${head}${action.action} → ok`;
  }
}

/** The log line the safety net writes when it answers a repeat itself. */
export const REPEATED_WINDOW_ACTION_MESSAGE =
  'repeated an already-satisfied window action — not performed again; the model is told so';

/** What the model is told about a window action the net did not repeat. */
const REPEATED_WINDOW_ACTION_NOTE =
  'that window action already succeeded in this step. If the step asks for nothing more, ' +
  'answer noop; otherwise do the rest of it.';

/** What the model is told about the actions behind the first screen-changing
 *  one (§5.5). */
const DROPPED_AFTER_SCREEN_CHANGE_NOTE =
  'only the first screen-changing action of a response is performed; the next screenshot ' +
  'shows its result. Choose again from what it shows.';

/** What the model is told about a `noop` in front of a screen-changing action
 *  (§5.5). The action behind it runs; the noop does not end the step. */
const NOOP_BEFORE_ACTION_NOTE =
  'a noop in front of another action does not end the step; that action was performed and ' +
  'the next screenshot shows its result. If the step is then done, answer noop on its own.';

/** What the model is told about the actions behind one that ended the turn — a
 *  failed or refused action, or one that finished the step (§5.5). */
const CUT_OFF_NOTE =
  'an earlier action in the same answer ended the turn, so the rest of it was not performed.';

/**
 * §5.5 — how long one step may spend in `wait` and `wait_window`, over all its
 * turns and attempts together.
 *
 * The turn cap alone let a wait for something that never comes cost 15 turns
 * of 15 s each — measured, a five-minute step and 15 image requests. A minute
 * of waiting is already generous for a native dialog.
 */
export const COMPUTER_WAIT_BUDGET_MS = 60_000;

/** `60s`, `0.3s`. */
function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

function waitBudgetMessage(budgetMs: number, spentMs: number, last?: string): string {
  return (
    `Step failed: the step's wait budget is used up — wait and wait_window may take at most ` +
    `${seconds(budgetMs)} in one computer-mode step, and this one has waited ${seconds(spentMs)}.` +
    (last ? `\nLast action reported: ${last}` : '')
  );
}

/**
 * A DETERMINISTIC window action as a key — or `null` for any other action.
 *
 * `focus_window` and `wait_window` are the two actions whose success the screen
 * may not show: focusing a window that was already frontmost changes no pixel,
 * and waiting for a window that is already open returns at once. They are also
 * the two answered by the operating system's window list rather than by the
 * model's reading of the image, so repeating one that succeeded on the
 * previous turn, unchanged, cannot mean anything but "I did not notice that it
 * worked" — which {@link computerTurns} answers with a note rather than by
 * acting again. `timeoutMs` is in the key because it is an argument the model
 * chose.
 *
 * A `focus_window` only counts as a success once `bring-to-front.ts` has read
 * the target back as the OS's active window. One the OS refused comes back as
 * a failure, which disarms this net, so the model's retry (or its click on the
 * window instead) reaches the screen.
 */
function windowActionKey(action: ComputerAction): string | null {
  if (action.action === 'focus_window') return `focus_window:${action.title}`;
  if (action.action === 'wait_window') {
    return `wait_window:${action.title}:${action.state}:${action.timeoutMs}`;
  }
  return null;
}

/** How many actions at the FRONT of a response repeat a window action the
 *  previous turn already satisfied. Only the front: behind a repeat, the rest
 *  of the answer is what the model actually wants done next. */
function leadingWindowRepeats(
  actions: readonly ComputerAction[],
  satisfied: ReadonlySet<string> | null,
): number {
  if (!satisfied) return 0;
  let count = 0;
  while (count < actions.length) {
    const key = windowActionKey(actions[count]!);
    if (key === null || !satisfied.has(key)) break;
    count++;
  }
  return count;
}

/**
 * §5.5 — the actions of one response that may run: everything up to and
 * including the FIRST that changes the screen or the image, and nothing after
 * it. Behind that action the model was reading a picture that no longer holds
 * — measured, `[click, assert holds:true]` passed on the pre-click image, and
 * `[zoom, click]` mapped a full-image point through the zoomed crop.
 *
 * `screenChange` is that action when there is one — always the last of `run`.
 * An `assert` or `noop` in front of it does NOT end the step (see the loop):
 * the model asked for the action too, and passing the step there was a pass
 * with nothing done — measured, `[noop, click]` for "Click the Cancel button"
 * passed after one model call with zero clicks.
 */
function splitAtScreenChange(actions: readonly ComputerAction[]): {
  run: ComputerAction[];
  dropped: ComputerAction[];
  screenChange: ComputerAction | undefined;
} {
  const at = actions.findIndex((a) => SCREEN_CHANGING_ACTION_TYPES.has(a.action));
  if (at === -1) return { run: [...actions], dropped: [], screenChange: undefined };
  return {
    run: actions.slice(0, at + 1),
    dropped: actions.slice(at + 1),
    screenChange: actions[at],
  };
}

/** The report row for an action the model asked for that never ran. */
function notPerformedSub(index: number, action: ComputerAction, why: string): SubActionResult {
  return {
    index,
    action: reportAction(action),
    durationMs: 0,
    error: `not performed: ${why}`,
    timestamp: new Date().toISOString(),
  };
}

/** A short name for an action, for the model's "not performed" list. Never a
 *  `type`'s text or a `read`'s value — either may be a secret. */
function actionLabel(action: ComputerAction): string {
  switch (action.action) {
    case 'click':
    case 'move':
    case 'scroll':
      return `${action.action} (${action.x},${action.y})`;
    case 'drag':
      return `drag (${action.from.x},${action.from.y})→(${action.to.x},${action.to.y})`;
    case 'type':
      return `type (${action.text.length} chars)`;
    case 'key':
      return `key ${action.key}`;
    case 'wait':
      return `wait ${action.seconds}s`;
    case 'focus_window':
    case 'wait_window':
      return `${action.action} "${action.title}"`;
    case 'read':
      return `read {{${action.as}}}`;
    case 'assert':
      return `assert "${action.condition}"`;
    default:
      return action.action;
  }
}

/**
 * The model's object as the report and the recording carry it.
 *
 * `SubActionResult.action` is typed `AIAction`, whose `ActionType` is the PAGE
 * vocabulary — thirteen of the eighteen computer actions share a name with it
 * and five (`drag`, `move`, `zoom`, `focus_window`, `wait_window`) do not. The
 * cast is deliberate and is the smaller of two evils: widening `AIAction`
 * would make "a click with a selector" representable on this surface, which is
 * the one thing §5.4 refuses, and mapping the five onto `noop` would put a
 * lie in the report where the reader is looking for what the mouse did.
 *
 * Nothing downstream is misled by it: a computer-mode step compiles to
 * `ai: true` (§9), so no generator ever reads these as page actions, and the
 * report prints `action.action` verbatim. `read`'s `as` is a real `AIAction`
 * field, which is what lets `autoCapturedNames` find a computer capture
 * without knowing this surface exists.
 */
function reportAction(action: ComputerAction): AIAction {
  const raw = (action.raw ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    action: action.action as unknown as AIAction['action'],
    description: action.description,
    ...(action.action === 'read' && { as: action.as, value: action.value }),
  } as AIAction;
}

/**
 * The `## Values` map the model is shown, already resolved and already masked
 * — which is the contract `buildComputerStepMessage` states for `variables`.
 *
 * Built from `buildStepValues` and masked with `maskValueForPrompt`, the two
 * halves the page prompt uses, so a `{{password}}` reads `***` on this surface
 * for the same three reasons it does on the other one.
 */
function maskedVariables(
  authored: string,
  opts: ComputerStepOptions,
): Record<string, string> | undefined {
  const values = buildStepValues(authored, opts);
  if (!values) return undefined;
  const unmask = values.unmask ?? new Set<string>();
  const secrets = values.secrets ?? [];
  const out: Record<string, string> = {};
  for (const p of values.parameters) {
    out[p.name] = maskValueForPrompt(
      isSecretParameterName(p.name, values.map),
      p.name,
      p.value,
      unmask,
      secrets,
    );
  }
  for (const r of values.envRefs ?? []) {
    out[`\${${r.ref}}`] = maskValueForPrompt(isSecretRef(r.ref), r.ref, r.value, unmask, secrets);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Text-only view of a message, for the report's request transcript — the
 *  base64 image is dropped, exactly as the page path drops it. */
function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Run one step on the computer surface.
 *
 * Returns the same {@link StepResult} `executeStep` returns, so every consumer
 * — the two run loops, the report, the recording, the wire events — needs no
 * knowledge of this surface beyond the `surface: 'computer'` field it stamps.
 * That includes the scoreboard: the step records its lines when it ends, as
 * `executeStep` does (docs/specs/SPEC-scoreboard.md §7).
 */
export async function executeComputerStep(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: ComputerStepOptions,
  authoredInstruction?: string,
): Promise<StepResult> {
  const result = await executeComputerStepUnrecorded(
    stepIndex,
    totalSteps,
    instruction,
    opts,
    authoredInstruction,
  );
  if (opts.stats?.enabled) {
    recordExecutedStep(result, opts.stats, {
      stepText: authoredInstruction ?? instruction,
      // No `rules`: this surface is answered from its own prompt
      // (`buildComputerSystemPrompt`), not the step prompt the fingerprint is
      // taken of, so its lines carry no fingerprint rather than the wrong one.
      maskValues: secretsFor(opts),
    });
  }
  return result;
}

/** {@link executeComputerStep} without the scoreboard line. */
async function executeComputerStepUnrecorded(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: ComputerStepOptions,
  authoredInstruction?: string,
): Promise<StepResult> {
  const startTime = Date.now();
  let retried = false;
  let priorAttemptTurns: TurnResult[] = [];
  let priorAssertions: AssertionResult[] = [];
  let mergedFailure: unknown;
  let attemptsMade = 0;
  /** The attempt under way, so a Stop — which passes through
   *  `finalAttemptError` untouched, carrying nothing — can still report the
   *  turns it cut short. */
  let currentProgress: AttemptProgress | undefined;
  // Per STEP, not per attempt: a retry does not buy another minute of waiting.
  const waits: WaitBudget = {
    budgetMs: opts.computer.waitBudgetMs ?? COMPUTER_WAIT_BUDGET_MS,
    spentMs: 0,
  };

  const attempt = async (attemptNumber: number): Promise<StepResult> => {
    attemptsMade = attemptNumber;
    if (attemptNumber === 2) retried = true;
    const progress: AttemptProgress = { touchedScreen: false, turns: [] };
    currentProgress = progress;
    return computerAttempt(
      stepIndex,
      totalSteps,
      instruction,
      opts,
      startTime,
      retried,
      attemptNumber,
      waits,
      progress,
      authoredInstruction,
    );
  };

  try {
    const result = await withRetry(attempt, {
      maxRetries: opts.config.execution.retries,
      label: `step ${stepIndex} [computer]`,
      ...(opts.signal && { signal: opts.signal }),
      onFailure: (err) => {
        if (err instanceof ComputerStepFailure) {
          priorAttemptTurns = [...priorAttemptTurns, ...err.turns];
          priorAssertions = [...priorAssertions, ...err.assertions];
          mergedFailure = err;
        }
      },
    });
    if (priorAttemptTurns.length > 0) {
      return { ...result, turns: [...priorAttemptTurns, ...result.turns] };
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // A Stop, reported as one (`interrupted`) — the page surface's answer, for
    // its reasons: the run loops, the report and the scoreboard all read a
    // stopped step, not a failed one. The stopped attempt's turns ride along,
    // since its calls were made; `retried` is whether a second attempt began.
    if (opts.signal?.aborted) {
      const stopped =
        err !== mergedFailure && currentProgress !== undefined ? turnsSoFar(currentProgress) : [];
      return {
        index: stepIndex,
        instruction,
        status: 'failed',
        surface: 'computer',
        turns: [...priorAttemptTurns, ...stopped],
        durationMs,
        retried,
        interrupted: true,
        error: 'Aborted by client',
        aiExplanation: 'Step aborted by client (run stopped).',
      };
    }

    logger.error(
      attemptsMade > 1
        ? `Step ${stepIndex} FAILED after retry [computer]: ${errorMessage}`
        : `Step ${stepIndex} FAILED [computer]: ${errorMessage}`,
    );

    if (err instanceof ComputerStepFailure && err !== mergedFailure) {
      priorAttemptTurns = [...priorAttemptTurns, ...err.turns];
      priorAssertions = [...priorAssertions, ...err.assertions];
    }
    const deliberate = err instanceof ComputerStepFailure ? err.deliberate : undefined;

    // The failure shot is the last capture the model saw — the report's copy of
    // it, so it obeys `desktop.reportScreenshots` like every other desktop
    // image (§10.1) rather than sneaking the whole screen in on a failure.
    const lastShot = [...priorAttemptTurns].reverse().find((t) => t.computer?.screenshotBase64);

    return applyFailureTail(
      {
        index: stepIndex,
        instruction,
        status: 'failed',
        surface: 'computer',
        turns: priorAttemptTurns,
        ...(priorAssertions.length > 0 && { assertions: priorAssertions }),
        durationMs,
        retried,
        ...(lastShot?.computer?.screenshotBase64 !== undefined && {
          screenshotBase64: lastShot.computer.screenshotBase64,
        }),
        error: errorMessage,
        ...(deliberate && { deliberate: true }),
        aiExplanation: deliberate
          ? deliberate.why
            ? `The step's condition held (${deliberate.why}) and the step says to fail the test.`
            : "The step's condition held and the step says to fail the test."
          : attemptsMade <= 1
            ? `Failed to execute step. Last error: ${errorMessage}`
            : `Failed to execute step after ${attemptsMade} attempts. Last error: ${errorMessage}`,
      },
      opts,
    );
  }
}

/** A step's wait budget and what its `wait` / `wait_window` actions have spent
 *  of it — one object for the whole step, handed to every attempt (§5.5). */
interface WaitBudget {
  budgetMs: number;
  spentMs: number;
}

/** What an attempt has done so far, as {@link finalAttemptError} needs it. */
interface AttemptProgress {
  /** Whether this attempt has driven the real pointer, keyboard or windows. */
  touchedScreen: boolean;
  /** The attempt's turns, pushed as each one is recorded. */
  turns: TurnResult[];
  /**
   * The turn under way, from the moment its model call is about to be made
   * until it is pushed onto {@link turns} — so a throw or a Stop in between
   * still reports the call the model answered and the actions that ran,
   * rather than leaving them out of every result.
   */
  inFlight?: TurnResult | undefined;
}

/** The attempt's turns, with the one a throw or a Stop cut short when it had
 *  done anything — a call answered, an action run. */
function turnsSoFar(progress: AttemptProgress): TurnResult[] {
  const cut = progress.inFlight;
  const useful = cut !== undefined && (cut.aiInteractions.length > 0 || cut.subActions.length > 0);
  return useful && !progress.turns.includes(cut) ? [...progress.turns, cut] : progress.turns;
}

/**
 * The error an attempt ends with, as `withRetry` is to see it (§5.5).
 *
 * Every failure leaves as a `ComputerStepFailure` carrying the attempt's turns,
 * so a model call that throws on turn 3 still leaves turns 1 and 2 on the
 * report. And once the attempt has driven the real pointer, keyboard or windows
 * the failure is final: a retry starts the step over and would type, click or
 * submit a second time — measured, an attempt that typed `1+1` and then stalled
 * was retried and typed it again. A Stop passes through untouched.
 */
function finalAttemptError(
  err: unknown,
  progress: AttemptProgress,
  signal: AbortSignal | undefined,
): unknown {
  if (signal?.aborted) return err;
  // The turn a throw cut short, onto the attempt's turns — the array a
  // failure constructed in the loop already holds, so it is carried either way.
  const turns = turnsSoFar(progress);
  if (turns !== progress.turns) progress.turns.push(progress.inFlight!);
  progress.inFlight = undefined;
  const failure =
    err instanceof ComputerStepFailure
      ? err
      : new ComputerStepFailure(
          err instanceof Error ? err.message : String(err),
          progress.turns,
          (err as { retryable?: unknown } | null)?.retryable !== false,
        );
  if (failure.retryable && progress.touchedScreen) {
    failure.retryable = false;
    log('not retrying: this attempt already acted on the real screen, and a retry would do it again');
  }
  return failure;
}

async function computerAttempt(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: ComputerStepOptions,
  startTime: number,
  retried: boolean,
  attemptNumber: number,
  waits: WaitBudget,
  progress: AttemptProgress,
  authoredInstruction?: string,
): Promise<StepResult> {
  try {
    return await computerTurns(
      stepIndex,
      totalSteps,
      instruction,
      opts,
      startTime,
      retried,
      attemptNumber,
      waits,
      progress,
      authoredInstruction,
    );
  } catch (err) {
    throw finalAttemptError(err, progress, opts.signal);
  }
}

// eslint-disable-next-line complexity
async function computerTurns(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: ComputerStepOptions,
  startTime: number,
  retried: boolean,
  attemptNumber: number,
  waits: WaitBudget,
  progress: AttemptProgress,
  authoredInstruction?: string,
): Promise<StepResult> {
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory } = opts;
  const computer = opts.computer;
  const maxTurns = config.execution.maxTurns;
  // The step as the page model reads it (`executeStepAttempt`): the `otherwise
  // …` tail OFF, because applying it is the framework's job and a model that
  // reads "otherwise continue" answers `noop`; and `[output: x]` as
  // `[store as: x]`, or the model names the capture itself and `{{x}}` stays
  // empty (measured: `{"result":"2"}`). Stripped before the enrichment, for the
  // reason given there.
  const promptAuthored = enrichAuthored(stripFailureTail(authoredInstruction ?? instruction));
  const placeholderValues: PlaceholderValues = {
    parameters: opts.resolvedParameters ?? {},
    ...(opts.envData !== undefined && { envData: opts.envData }),
  };
  /** Stop, checked before every capture, model call and action. The catch in
   *  `executeComputerStep` reports it the way the page surface does. */
  const throwIfAborted = (): void => {
    if (opts.signal?.aborted) throw new DOMException('Run aborted by client', 'AbortError');
  };

  // §5.2 — the image always goes, whatever `ai.sendScreenshots` says, because
  // on this surface the image IS the evidence. Said once per session.
  if (!config.ai.sendScreenshots && !screenshotOverrideAnnounced.has(testName)) {
    screenshotOverrideAnnounced.add(testName);
    log(
      'ai.sendScreenshots is off for this project; computer mode sends its capture anyway — ' +
        'on this surface the screenshot is the whole of what the model can see.',
    );
  }

  const allTurns = progress.turns;
  const assertions: AssertionResult[] = [];
  const stall = new ComputerStallDetector();

  throwIfAborted();
  let view: ImageView = await captureView(computer.adapter, {
    maxImageWidth: computer.maxImageWidth,
  });
  let refusals: Refusal[] = [];
  let notPerformed: string[] = [];
  let priorFailure: string | undefined;
  /**
   * What this attempt has already done, one line per successful action.
   *
   * Lives here — beside `stall`, per ATTEMPT — because a retry starts the step
   * over: the screen is re-read, the turn count starts at 1, and a list of
   * actions from the attempt that failed would tell the model not to redo the
   * very thing the retry exists to redo. The page path resets per attempt for
   * the same reason. (Only an attempt that drove no input is retried at all,
   * so what this list loses is waits and zooms.)
   */
  const performed: string[] = [];
  /** The window actions the previous turn satisfied, when it asked for window
   *  actions and nothing else and every one succeeded. The safety net below is
   *  the only reader. */
  let satisfiedWindowKeys: Set<string> | null = null;
  let lastReasoning = '';
  let flowControlSignal: StepResult['flowControl'] | undefined;
  let flowControlDetail: string | undefined;
  let complete = false;
  let globalSubActionIndex = 0;
  let assertCounter = 0;

  for (let currentTurn = 1; currentTurn <= maxTurns; currentTurn++) {
    throwIfAborted();

    const turnTimestamp = new Date().toISOString();
    const turnAiInteractions: AiInteraction[] = [];
    const turnSubActions: SubActionResult[] = [];
    /** The capture the model was shown THIS turn — kept because `view` moves
     *  on the moment an action lands, and the report must show what was in
     *  front of the model when it decided. */
    const shownView = view;

    // Rebuilt per turn, like the page prompt's `## Values`: a `read` in turn 1
    // can define a name turn 2 references, and a value that arrives mid-step
    // can be a secret turn 2 must not print.
    const variables = maskedVariables(promptAuthored, opts);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildComputerSystemPrompt({
          imageWidth: shownView.imageWidth,
          imageHeight: shownView.imageHeight,
          contextContent,
        }),
      },
      buildComputerStepMessage({
        stepInstruction: promptAuthored,
        pngBase64: shownView.pngBase64,
        imageWidth: shownView.imageWidth,
        imageHeight: shownView.imageHeight,
        ...(variables && { variables }),
        ...(performed.length > 0 && { performed }),
        conversationHistory,
        // No viewport: the browser's size is not this surface's, and a second
        // pair of numbers beside the image's is a second coordinate space.
        testInfoSection: formatTestInfo(testName, baseUrl, stepIndex, totalSteps),
        ...(shownView.requestedRegion && { zoomRegion: shownView.requestedRegion }),
        ...(refusals.length > 0 && { refusals }),
        ...(notPerformed.length > 0 && { notPerformed }),
        ...(priorFailure !== undefined && { priorFailure }),
      }),
    ];
    // Consumed: each is shown for exactly one turn, or the model reads a
    // refusal it has already acted on and spends the turn apologising.
    // `performed` is NOT consumed — it is the step's running record, and a
    // model that is told once and then not told again is back where it started.
    refusals = [];
    notPerformed = [];
    priorFailure = undefined;

    const recordShot = computer.reportScreenshots;
    // The same arrays the turn fills, so a throw or a Stop reports what it did.
    progress.inFlight = {
      turnNumber: currentTurn,
      attemptNumber,
      timestamp: turnTimestamp,
      aiInteractions: turnAiInteractions,
      subActions: turnSubActions,
      computer: computerTurnRecord(shownView, recordShot),
    };
    let completion: CompleteResult;
    try {
      throwIfAborted();
      completion = await aiClient.complete(messages, opts.signal);
    } catch (err) {
      // §15.4 — the model rejected the screenshot. Not retried: a retry sends
      // the same image to the same model and gets the same 400, and on this
      // surface the image cannot be left out. The bridge's own words are the
      // step's error — they name the model and say what computer mode needs.
      const blind = imageInputUnsupportedMessage(err);
      if (blind === null) throw err;
      turnAiInteractions.push({
        purpose: 'computer-action-plan',
        attemptNumber,
        requestMessages: messages.map((m) => ({ role: m.role, content: textOf(m) })),
        response: '',
        ...(recordShot && { screenshotBase64: shownView.pngBase64 }),
        timestamp: turnTimestamp,
      });
      allTurns.push({
        turnNumber: currentTurn,
        attemptNumber,
        timestamp: turnTimestamp,
        aiInteractions: turnAiInteractions,
        subActions: turnSubActions,
        computer: computerTurnRecord(shownView, recordShot),
      });
      progress.inFlight = undefined;
      throw new ComputerStepFailure(blind, allTurns, false);
    }
    // The answer is recorded before the Stop check below: the call was made
    // and paid for whether or not anything it asked for runs.
    turnAiInteractions.push({
      purpose: 'computer-action-plan',
      attemptNumber,
      requestMessages: messages.map((m) => ({ role: m.role, content: textOf(m) })),
      response: completion.text,
      ...(completion.model !== undefined && { model: completion.model }),
      ...(completion.usage !== undefined && { usage: completion.usage }),
      ...(recordShot && { screenshotBase64: shownView.pngBase64 }),
      timestamp: turnTimestamp,
    });
    // A Stop that landed while the model was answering: nothing it asked for
    // runs.
    throwIfAborted();

    let parsed;
    try {
      parsed = parseComputerActions(completion.text);
    } catch (err) {
      // No JSON at all: the turn is lost either way, so it fails the step the
      // way a malformed page response does.
      allTurns.push({
        turnNumber: currentTurn,
        attemptNumber,
        timestamp: turnTimestamp,
        aiInteractions: turnAiInteractions,
        subActions: turnSubActions,
        computer: computerTurnRecord(shownView, recordShot),
      });
      progress.inFlight = undefined;
      throw new ComputerStepFailure(
        `Step failed: ${err instanceof Error ? err.message : String(err)}`,
        allTurns,
      );
    }
    lastReasoning = parsed.reasoning || lastReasoning;

    // The safety net for a model that ignores the "already performed" list: a
    // window action at the front of this answer that the previous turn already
    // satisfied is not performed again, and the model is TOLD so. It used to
    // pass the step — measured, "Focus Calculator and type 1+1" went green on
    // the repeat with nothing typed.
    const repeatCount = leadingWindowRepeats(parsed.actions, satisfiedWindowKeys);
    const repeated = parsed.actions.slice(0, repeatCount);

    // §5.5 — one screen-changing action per response.
    const { run, dropped, screenChange } = splitAtScreenChange(parsed.actions.slice(repeatCount));

    // §5.5 — three turns whose capture AND actions are identical is a stall.
    // Measured over what the model was SHOWN and everything it ASKED for —
    // before the net answers any of it, so a model that repeats a satisfied
    // window action for ever ends here, not at the turn cap. Not retried: the
    // same screen gets the same answer.
    //
    // A WAIT is not a stall. Waiting on an unchanging screen is what a slow
    // "Wait until …" is, and three identical waits used to trip this at about
    // 20–30 s — before the 60 s wait budget, which is the rule written for
    // them. So a turn whose screen-changing action is a `wait` is not counted,
    // and neither is one whose `wait_window` then times out: the budget bounds
    // both, and the turn cap still applies. A `wait_window` that SUCCEEDS is
    // counted, after it has run (it drives nothing, so running it first costs
    // nothing) — which keeps "the repeat counts towards it" true for the net.
    // An uncounted turn leaves the streak where it was rather than resetting
    // it, so `[key, wait, key, wait, key]` on a frozen screen still stalls.
    const stallKey = parsed.actions.length > 0 ? parsed.actions : completion.text;
    const waitTurn = screenChange?.action === 'wait' || screenChange?.action === 'wait_window';
    if (!waitTurn && stall.observe(shownView.pngBase64, stallKey)) {
      allTurns.push({
        turnNumber: currentTurn,
        attemptNumber,
        timestamp: turnTimestamp,
        aiInteractions: turnAiInteractions,
        subActions: turnSubActions,
        computer: computerTurnRecord(shownView, recordShot),
      });
      progress.inFlight = undefined;
      throw new ComputerStepFailure(computerStallMessage(instruction), allTurns, false);
    }

    if (repeated.length > 0) {
      log(REPEATED_WINDOW_ACTION_MESSAGE);
      notPerformed.push(`${repeated.map(actionLabel).join(', ')} — ${REPEATED_WINDOW_ACTION_NOTE}`);
      for (let i = 0; i < repeated.length; i++) {
        turnSubActions.push({
          index: ++globalSubActionIndex,
          action: {
            action: 'noop',
            description: 'This window action already succeeded on the previous turn.',
          } as AIAction,
          durationMs: 0,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // §5.4 — refusals are data the MODEL reads next turn, not failures.
    for (const refused of parsed.refused) {
      refusals.push(refused.reason);
      log(`refused: ${refused.reason}`);
      turnSubActions.push({
        index: ++globalSubActionIndex,
        action: { action: 'noop', description: 'refused' } as AIAction,
        durationMs: 0,
        error: refused.reason,
        timestamp: new Date().toISOString(),
      });
    }

    let turnFailed = false;
    let turnNonRetryable = false;
    let turnError: string | undefined;
    let deliberate: { why: string } | undefined;
    /** Where the pointer went this turn, for the report ring (§10.1). */
    let imagePoint: { x: number; y: number } | undefined;
    let screenPoint: { x: number; y: number } | undefined;
    /** How many of `run` the loop below reached. Whatever lies behind the one
     *  that ended the turn with a `break` never ran, and is reported so. */
    let reached = 0;
    /** Set when this turn's `wait_window` succeeded: that turn counts towards
     *  the stall after all (see the stall check above). */
    let waitWindowSucceeded = false;

    for (const action of run) {
      reached++;
      throwIfAborted();
      const subStartTime = Date.now();
      const aiReasoningVal = config.reports.includeAiReasoning ? parsed.reasoning : undefined;
      const baseSub = (): SubActionResult => ({
        index: ++globalSubActionIndex,
        action: reportAction(action),
        ...(aiReasoningVal !== undefined && { aiReasoning: aiReasoningVal }),
        durationMs: Date.now() - subStartTime,
        timestamp: new Date().toISOString(),
      });

      // ── return: the claim is what makes it legal ──────────────────────────
      if (action.action === 'return') {
        const claim = opts.flowControlClaim;
        if (claim && isReturnClaim(claim)) {
          turnSubActions.push(baseSub());
          flowControlSignal = { kind: 'return', verb: claim.verb };
          flowControlDetail = action.description;
          log(`step ${stepIndex} returned: ${action.description || 'condition holds'}`);
          complete = true;
          break;
        }
        turnSubActions.push({ ...baseSub(), error: RETURN_NOT_CLAIMED });
        refusals.push(RETURN_NOT_CLAIMED);
        logger.warn(`Step ${stepIndex}: ${RETURN_NOT_CLAIMED}`);
        break;
      }

      // ── fail: the sibling guard ───────────────────────────────────────────
      if (action.action === 'fail') {
        const claim = opts.flowControlClaim;
        if (claim && claim.verb === 'fail') {
          const secrets = secretsFor(opts);
          const why = redact(action.description?.trim() ?? '', secrets);
          const composed = composeDeliberateFailure(claim, instruction, why, secrets);
          turnSubActions.push({ ...baseSub(), error: composed });
          turnFailed = true;
          turnNonRetryable = true;
          turnError = composed;
          deliberate = { why };
          logger.error(`Step ${stepIndex} failed as written: ${composed}`);
          break;
        }
        turnSubActions.push({ ...baseSub(), error: FAIL_NOT_CLAIMED });
        refusals.push(FAIL_NOT_CLAIMED);
        logger.warn(`Step ${stepIndex}: ${FAIL_NOT_CLAIMED}`);
        break;
      }

      // ── assert: the model's own judgment of the screen (§5.4) ─────────────
      if (action.action === 'assert') {
        const result: AssertionResult = {
          assertIndex: assertCounter++,
          turnNumber: currentTurn,
          subActionIndex: globalSubActionIndex + 1,
          description: action.description,
          condition: action.condition,
          expected: undefined,
          against: 'predicate',
          pass: action.holds,
          actual: action.evidence,
          explanation: action.evidence,
        };
        assertions.push(result);
        turnSubActions.push({
          ...baseSub(),
          ...(action.holds ? {} : { error: `Assertion failed: ${action.evidence}` }),
        });
        log(`assert "${action.condition}" → ${action.holds ? 'holds' : 'does NOT hold'}`);
        if (!action.holds) {
          // A failed verdict fails the step wherever it stands in the answer;
          // anything behind it is reported as not performed.
          turnFailed = true;
          turnError = `Assertion failed: ${action.condition}. ${action.evidence}`;
          complete = true;
          break;
        }
        // One that holds is the verdict only when nothing behind it changes
        // the screen. In front of a click it is a note about the image the
        // model was shown, not the end of the step: the click runs, and the
        // step goes on to judge its result (§5.5).
        if (screenChange !== undefined) continue;
        complete = true;
        break;
      }

      // ── read: the model transcribes what it sees (§5.4) ───────────────────
      if (action.action === 'read') {
        if (opts.resolvedParameters) {
          bindVariable(opts.resolvedParameters, action.as, action.value);
        }
        turnSubActions.push(baseSub());
        // Masked on the same two rules the page path's capture line uses —
        // shape first, then the run's free-text set — because this line
        // reaches the console and the SSE `output` bridge unredacted.
        log(
          `read "{{${action.as}}}" = "${redact(action.value, secretsFor(opts))}"`,
        );
        continue;
      }

      // ── noop: the step is complete ────────────────────────────────────────
      if (action.action === 'noop') {
        if (screenChange !== undefined) {
          // "Done" in front of an action the model also asked for is refused:
          // the action runs, and the step is over only when a noop is what the
          // model answers after seeing its result (§5.5).
          turnSubActions.push({ ...baseSub(), error: `not performed: ${NOOP_BEFORE_ACTION_NOTE}` });
          notPerformed.push(`noop — ${NOOP_BEFORE_ACTION_NOTE}`);
          log('noop in front of a screen-changing action — refused; the action runs');
          continue;
        }
        turnSubActions.push(baseSub());
        log(`noop: ${action.description || 'the step is already satisfied'}`);
        complete = true;
        break;
      }

      // ── prompt: the clarification path ────────────────────────────────────
      if (action.action === 'prompt') {
        if (!config.execution.promptOnAmbiguity) {
          // The switch is off, so nothing asks — and the page path's answer to
          // that is to skip the action and carry on, not to fail. Same answer
          // here, so a project that turned clarification off behaves the same
          // way on both surfaces. A model that only ever asks is caught by the
          // stall detector rather than by a special case.
          turnSubActions.push(baseSub());
          logger.debug(`[computer] prompt ignored (promptOnAmbiguity off): ${action.question}`);
          continue;
        }
        // Non-interactive is the only mode a server-driven run has, and the
        // computer surface has no page-backed REPL to escape into — so this
        // fails fast with the question as the error, exactly as the page path
        // does for `nonInteractive` (issues/014).
        turnFailed = true;
        turnNonRetryable = true;
        turnError =
          'AI needs clarification, but this run has no interactive prompt to answer it: ' +
          action.question;
        turnSubActions.push({ ...baseSub(), error: turnError });
        break;
      }

      // ── api_call / extract_value: they touch no surface (§5.4) ────────────
      if (action.action === 'api_call') {
        const substituted = substituteAction(reportAction(action), placeholderValues);
        const apiSubResult = await executeApiCallAction(
          substituted,
          undefined,
          stepIndex,
          opts.csrfTokens,
          config.api?.requestTimeout,
          opts.apiResponseStore,
          baseUrl,
        );
        turnSubActions.push({
          ...baseSub(),
          ...(apiSubResult.apiCallData !== undefined && { apiCallData: apiSubResult.apiCallData }),
          ...(apiSubResult.error !== undefined && { error: apiSubResult.error }),
        });
        if (apiSubResult.failed) {
          // Back to the model rather than straight to a red step: it can drop
          // the call, fix the URL, or say the step cannot be done.
          priorFailure = apiSubResult.error;
          break;
        }
        continue;
      }

      if (action.action === 'extract_value') {
        // A documented no-op sub-action on the page surface too: extraction
        // from prior API responses happens in the model's own context.
        turnSubActions.push(baseSub());
        continue;
      }

      // ── wait / wait_window: inside the step's wait budget (§5.5) ──────────
      // What runs is cut to what is left, so the budget is a real bound rather
      // than a check between waits.
      let toRun: ComputerAction = action;
      let cutByBudget = false;
      if (action.action === 'wait' || action.action === 'wait_window') {
        const remaining = waits.budgetMs - waits.spentMs;
        if (remaining <= 0) {
          turnFailed = true;
          turnNonRetryable = true;
          turnError = waitBudgetMessage(waits.budgetMs, waits.spentMs);
          turnSubActions.push({ ...baseSub(), error: turnError });
          break;
        }
        if (action.action === 'wait' && action.seconds * 1000 > remaining) {
          toRun = { ...action, seconds: remaining / 1000 };
          cutByBudget = true;
        } else if (action.action === 'wait_window' && action.timeoutMs > remaining) {
          // The model's own cap note would now be untrue: the budget, not the
          // 30 s maximum, is what shortened it.
          const { requestedTimeoutMs: _asked, ...rest } = action;
          toRun = { ...rest, timeoutMs: remaining };
          cutByBudget = true;
        }
      }

      // ── everything that touches the screen ────────────────────────────────
      if (INPUT_ACTION_TYPES.has(action.action)) progress.touchedScreen = true;
      const outcome = await executeComputerAction(toRun, {
        adapter: computer.adapter,
        view,
        settleMs: computer.settleMs,
        maxImageWidth: computer.maxImageWidth,
        ...(opts.signal && { signal: opts.signal, sleep: interruptibleSleep(opts.signal) }),
      });
      if (action.action === 'wait' || action.action === 'wait_window') {
        waits.spentMs += Date.now() - subStartTime;
      }
      // A Stop during the action — a wait_window cut short only says that it
      // stopped — ends the step here, before anything more is captured.
      throwIfAborted();
      if (outcome.screenPoint) {
        screenPoint = outcome.screenPoint;
        imagePoint = imagePointOf(action);
      }
      turnSubActions.push({
        ...baseSub(),
        ...(outcome.message !== undefined && !outcome.ok && { error: outcome.message }),
      });

      if (!outcome.ok) {
        if (cutByBudget) {
          // The budget, not the model's timeout, ended this wait, and any
          // further wait would be refused: the step is over.
          turnFailed = true;
          turnNonRetryable = true;
          turnError = waitBudgetMessage(waits.budgetMs, waits.spentMs, outcome.message);
          break;
        }
        // A window that never appeared, a title that matched nothing: the
        // model gets the message next turn and can choose differently. This
        // is what `priorFailure` in the step message is for.
        priorFailure = outcome.message;
        break;
      }

      if (action.action === 'wait_window') waitWindowSucceeded = true;

      // It worked, and the screen may be about to show nothing of the sort —
      // a window that was already frontmost, a key that only changed state the
      // image does not carry. The record of it goes to the model on every
      // remaining turn of this step.
      if (outcome.performed) {
        performed.push(performedLine(currentTurn, toRun, outcome, Date.now() - subStartTime));
      }

      if (action.action === 'zoom') {
        // §5.3 — the zoomed image becomes the next turn's, and coordinates
        // move with it. Nothing on the screen changed, so nothing is
        // re-captured.
        view = outcome.view;
      } else {
        // §5.3 — after any real action the next capture is a fresh full
        // screenshot.
        view = await captureView(computer.adapter, { maxImageWidth: computer.maxImageWidth });
      }
    }

    // Behind an action that ended the turn — a failed or refused one, or one
    // that finished the step — inside what `run` kept: on the report as not
    // performed, and in front of the model next turn if there is one. They
    // used to vanish from both, so a `[noop, click]` pass showed no click.
    const cutOff = run.slice(reached);
    if (cutOff.length > 0) {
      const labels = cutOff.map(actionLabel).join(', ');
      log(`not performed (behind an action that ended the turn): ${labels}`);
      notPerformed.push(`${labels} — ${CUT_OFF_NOTE}`);
      for (const action of cutOff) {
        turnSubActions.push(notPerformedSub(++globalSubActionIndex, action, CUT_OFF_NOTE));
      }
    }

    // Behind the screen-changing action: on the report as not performed, and
    // in front of the model next turn with the reason.
    if (dropped.length > 0) {
      const labels = dropped.map(actionLabel).join(', ');
      log(`not performed (behind the first screen-changing action): ${labels}`);
      notPerformed.push(`${labels} — ${DROPPED_AFTER_SCREEN_CHANGE_NOTE}`);
      for (const action of dropped) {
        turnSubActions.push(
          notPerformedSub(++globalSubActionIndex, action, DROPPED_AFTER_SCREEN_CHANGE_NOTE),
        );
      }
    }

    // Armed only by a turn whose actions were window actions and nothing else,
    // each one satisfied — performed now, or repeated from the turn before.
    // Actions dropped behind it never ran and do not count. A refusal, a
    // failure or a deliberate end disarms it, so the next turn's repeat is a
    // real repeat of a real success.
    const windowKeys = [...repeated, ...run].map(windowActionKey);
    satisfiedWindowKeys =
      windowKeys.length > 0 &&
      windowKeys.every((key) => key !== null) &&
      !turnFailed &&
      priorFailure === undefined &&
      parsed.refused.length === 0
        ? new Set(windowKeys as string[])
        : null;

    allTurns.push({
      turnNumber: currentTurn,
      attemptNumber,
      timestamp: turnTimestamp,
      aiInteractions: turnAiInteractions,
      subActions: turnSubActions,
      computer: {
        ...computerTurnRecord(shownView, recordShot),
        ...(imagePoint && { imagePoint }),
        ...(screenPoint && { screenPoint }),
      },
    });
    progress.inFlight = undefined;

    if (turnFailed) {
      throw new ComputerStepFailure(
        turnError ?? 'Step failed',
        allTurns,
        !turnNonRetryable,
        deliberate,
        assertions,
      );
    }

    // The deferred half of the stall check: a `wait_window` that found its
    // window counts, like any other turn that did what it was asked.
    if (waitWindowSucceeded && stall.observe(shownView.pngBase64, stallKey)) {
      throw new ComputerStepFailure(computerStallMessage(instruction), allTurns, false);
    }

    if (complete) break;

    if (currentTurn === maxTurns) {
      // Not retried (§5.5): fifteen turns that did not finish the step will
      // not finish it on a second fifteen, and a wait for something that never
      // comes would cost twice the image requests.
      throw new ComputerStepFailure(
        `Step failed: multi-turn limit reached (${maxTurns} turns) on the computer surface.` +
          (priorFailure ? `\nLast action reported: ${priorFailure}` : ''),
        allTurns,
        false,
      );
    }
  }

  const durationMs = Date.now() - startTime;
  return {
    index: stepIndex,
    instruction,
    status: 'passed',
    surface: 'computer',
    turns: allTurns,
    ...(assertions.length > 0 && { assertions }),
    ...(computer.reportScreenshots && { screenshotBase64: view.pngBase64 }),
    durationMs,
    retried,
    aiExplanation: flowControlSignal
      ? flowControlDetail?.trim() || lastReasoning
      : lastReasoning || 'No reasoning provided',
    ...(flowControlSignal && { flowControl: flowControlSignal }),
  };
}

/** The per-turn computer record, minus the pointer (which is only known once
 *  the turn's actions have run). */
function computerTurnRecord(
  view: ImageView,
  recordShot: boolean,
): NonNullable<TurnResult['computer']> {
  return {
    ...(recordShot && { screenshotBase64: view.pngBase64 }),
    imageWidth: view.imageWidth,
    imageHeight: view.imageHeight,
    kind: view.kind,
  };
}

/** Where in the image the model pointed — the report's ring goes here, because
 *  this is the space the recorded PNG is in. */
function imagePointOf(action: ComputerAction): { x: number; y: number } | undefined {
  if (action.action === 'click' || action.action === 'move' || action.action === 'scroll') {
    return { x: action.x, y: action.y };
  }
  if (action.action === 'drag') return { x: action.to.x, y: action.to.y };
  return undefined;
}

/** A sleep that gives up when the run is stopped, so a 15 s `wait_window` does
 *  not outlive the Stop button by fifteen seconds. */
function interruptibleSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
}
