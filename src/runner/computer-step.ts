/**
 * One step, answered from a screenshot of the machine's screen
 * (docs/specs/SPEC-use-computer.md §5.5).
 *
 * The computer surface's counterpart to `executeStep`, and deliberately a
 * SEPARATE function rather than a branch inside it. The two loops share a
 * shape — capture, prompt, parse, act, settle, capture — and share nothing
 * else: there is no DOM to snapshot, no selector to resolve, no page to
 * settle, no step cache to read (§5.5: a cached coordinate has nothing to
 * validate against and would replay blind), and the action vocabulary is a
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
 *    thing on either surface.
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
import { isReturnClaim } from '../parser/flow-control-step.js';
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
  executeApiCallAction,
  secretsFor,
  type ComputerStepContext,
  type StepExecutorOptions,
} from './step-executor.js';
import {
  ComputerStallDetector,
  DEFAULT_MAX_IMAGE_WIDTH,
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

/** Options for a computer-mode step: a step's ordinary options, with the
 *  surface's own context guaranteed present. */
export type ComputerStepOptions = StepExecutorOptions & { computer: ComputerStepContext };

// ---------------------------------------------------------------------------
// Entering and leaving the surface (§5.1, §4.5)
// ---------------------------------------------------------------------------

/** §5.1 item 1, in the spec's own words. */
export const COMPUTER_DISABLED_MESSAGE =
  'computer mode is disabled for this project; set `desktop.enabled: true` in aiui.config.json';

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
   * `aiui.config.json`, not the server's startup config.
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
 * Re-entering the surface already in force is a no-op with a log line (§4.5),
 * and it happens BEFORE the preconditions: a section that defensively opens
 * with `[use computer]` must not re-take a lock it holds or pay for a second
 * capture probe.
 */
export async function enterComputerMode(
  input: EnterComputerModeInput,
): Promise<{ ok: true; reentered: boolean } | { ok: false; error: string }> {
  const { state } = input;
  if (state.surface === 'computer' && state.adapter) {
    log('already on the computer surface — [use computer] is a no-op here');
    return { ok: true, reentered: true };
  }

  // 1. Project opt-in. A test file in a shared project must not be able to
  //    move the mouse on a machine whose owner did not allow it.
  if (!input.desktop?.enabled) {
    return { ok: false, error: COMPUTER_DISABLED_MESSAGE };
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
  log('surface → computer');
  return { ok: true, reentered: false };
}

/**
 * `[use browser]` — release the lock, drop the adapter, go back to the page
 * (§4.5). Nothing can fail here: the browser launches at the NEXT step, under
 * the launch gate, and its failure is that step's (§4.6).
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
  releaseComputerLock(lockId, lock ?? {});
  state.surface = 'browser';
  state.adapter = undefined;
  log('surface → browser');
  return { reentered: false };
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
 */
export class SkillSurfaceStack {
  private readonly open: Array<{ frameId: string; surface: 'browser' | 'computer' }> = [];

  /**
   * Move to the step whose skill-frame chain is `chain` (outermost first) and
   * restore the caller's surface for every skill this move returns from.
   *
   * `restore` is called with the surface to go back to — the caller supplies
   * it because the two runners release the lock through different state.
   */
  enter(
    chain: readonly string[],
    current: 'browser' | 'computer',
    restore: (to: 'browser' | 'computer') => void,
  ): void {
    // Everything on the stack this step is no longer inside: returned from,
    // innermost first.
    while (this.open.length > 0 && !chain.includes(this.open[this.open.length - 1]!.frameId)) {
      const frame = this.open.pop()!;
      if (frame.surface !== current) {
        logger.info(
          `[computer] restoring the caller's surface (${frame.surface}) on return from a skill`,
        );
        restore(frame.surface);
        current = frame.surface;
      }
    }
    // Everything this step is inside that the stack does not yet hold.
    for (const frameId of chain) {
      if (this.open.some((f) => f.frameId === frameId)) continue;
      this.open.push({ frameId, surface: current });
    }
  }
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
        `${(elapsedMs / 1000).toFixed(1)}s`
      );
    default:
      return `${head}${action.action} → ok`;
  }
}

/** The log line the safety net writes when it answers a repeat itself. */
export const REPEATED_WINDOW_ACTION_MESSAGE =
  'repeated an already-satisfied window action — step complete';

/**
 * The turn's DETERMINISTIC window actions as one key — or `null` the moment it
 * asks for anything else.
 *
 * `focus_window` and `wait_window` are the two actions whose success the screen
 * may not show: focusing a window that was already frontmost changes no pixel,
 * and waiting for a window that is already open returns at once. They are also
 * the two answered by the operating system's window list rather than by the
 * model's reading of the image, so a turn that repeats one that has just
 * succeeded, unchanged, cannot mean anything but "I did not notice that it
 * worked" — which {@link computerAttempt} answers by completing the step
 * rather than by acting again. `timeoutMs` is in the key because it is an
 * argument the model chose.
 *
 * A `focus_window` only counts as a success once `bring-to-front.ts` has read
 * the target back as the OS's active window. One the OS refused comes back as
 * a failure, which disarms this net, so the model's retry (or its click on the
 * window instead) reaches the screen.
 */
function windowOnlyKey(actions: readonly ComputerAction[]): string | null {
  if (actions.length === 0) return null;
  const parts: string[] = [];
  for (const action of actions) {
    if (action.action === 'focus_window') parts.push(`focus_window:${action.title}`);
    else if (action.action === 'wait_window') {
      parts.push(`wait_window:${action.title}:${action.state}:${action.timeoutMs}`);
    } else return null;
  }
  return parts.join('|');
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
 */
export async function executeComputerStep(
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

  const attempt = async (attemptNumber: number): Promise<StepResult> => {
    attemptsMade = attemptNumber;
    if (attemptNumber === 2) retried = true;
    return computerAttempt(
      stepIndex,
      totalSteps,
      instruction,
      opts,
      startTime,
      retried,
      attemptNumber,
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

    if (opts.signal?.aborted) {
      return {
        index: stepIndex,
        instruction,
        status: 'failed',
        surface: 'computer',
        turns: priorAttemptTurns,
        durationMs,
        retried: true,
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

// eslint-disable-next-line complexity
async function computerAttempt(
  stepIndex: number,
  totalSteps: number,
  instruction: string,
  opts: ComputerStepOptions,
  startTime: number,
  retried: boolean,
  attemptNumber: number,
  authoredInstruction?: string,
): Promise<StepResult> {
  const { config, aiClient, contextContent, testName, baseUrl, conversationHistory } = opts;
  const computer = opts.computer;
  const maxTurns = config.execution.maxTurns;
  const promptAuthored = authoredInstruction ?? instruction;
  const placeholderValues: PlaceholderValues = {
    parameters: opts.resolvedParameters ?? {},
    ...(opts.envData !== undefined && { envData: opts.envData }),
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

  const allTurns: TurnResult[] = [];
  const assertions: AssertionResult[] = [];
  const stall = new ComputerStallDetector();

  let view: ImageView = await captureView(computer.adapter, {
    maxImageWidth: computer.maxImageWidth,
  });
  let refusals: Refusal[] = [];
  let priorFailure: string | undefined;
  /**
   * What this attempt has already done, one line per successful action.
   *
   * Lives here — beside `stall`, per ATTEMPT — because a retry starts the step
   * over: the screen is re-read, the turn count starts at 1, and a list of
   * actions from the attempt that failed would tell the model not to redo the
   * very thing the retry exists to redo. The page path resets per attempt for
   * the same reason.
   */
  const performed: string[] = [];
  /** The window-only key of the previous turn, when every one of its actions
   *  succeeded. The safety net below is the only reader. */
  let satisfiedWindowKey: string | null = null;
  let lastReasoning = '';
  let flowControlSignal: StepResult['flowControl'] | undefined;
  let flowControlDetail: string | undefined;
  let complete = false;
  let globalSubActionIndex = 0;
  let assertCounter = 0;

  for (let currentTurn = 1; currentTurn <= maxTurns; currentTurn++) {
    if (opts.signal?.aborted) throw new DOMException('Run aborted by client', 'AbortError');

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
        testInfoSection: formatTestInfo(
          testName,
          baseUrl,
          stepIndex,
          totalSteps,
          config.browser.headed ? config.browser.windowSize : config.browser.viewport,
        ),
        ...(shownView.requestedRegion && { zoomRegion: shownView.requestedRegion }),
        ...(refusals.length > 0 && { refusals }),
        ...(priorFailure !== undefined && { priorFailure }),
      }),
    ];
    // Consumed: each is shown for exactly one turn, or the model reads a
    // refusal it has already acted on and spends the turn apologising.
    // `performed` is NOT consumed — it is the step's running record, and a
    // model that is told once and then not told again is back where it started.
    refusals = [];
    priorFailure = undefined;

    const recordShot = computer.reportScreenshots;
    let completion: CompleteResult;
    try {
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
      throw new ComputerStepFailure(blind, allTurns, false);
    }
    turnAiInteractions.push({
      purpose: 'computer-action-plan',
      attemptNumber,
      requestMessages: messages.map((m) => ({ role: m.role, content: textOf(m) })),
      response: completion.text,
      ...(completion.model !== undefined && { model: completion.model }),
      ...(recordShot && { screenshotBase64: shownView.pngBase64 }),
      timestamp: turnTimestamp,
    });

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
      throw new ComputerStepFailure(
        `Step failed: ${err instanceof Error ? err.message : String(err)}`,
        allTurns,
      );
    }
    lastReasoning = parsed.reasoning || lastReasoning;

    // The safety net for a model that ignores the list above: a turn whose
    // ONLY actions are window actions that all succeeded, followed by a turn
    // asking for exactly the same ones, is a step that is already done. It is
    // answered here rather than by executing it again — and BEFORE the stall
    // detector observes the turn, so a repeat that the step survives does not
    // also count towards a stall.
    const windowKey = windowOnlyKey(parsed.actions);
    if (windowKey !== null && windowKey === satisfiedWindowKey && parsed.refused.length === 0) {
      log(REPEATED_WINDOW_ACTION_MESSAGE);
      turnSubActions.push({
        index: ++globalSubActionIndex,
        action: {
          action: 'noop',
          description: 'This window action already succeeded on the previous turn.',
        } as AIAction,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      });
      allTurns.push({
        turnNumber: currentTurn,
        attemptNumber,
        timestamp: turnTimestamp,
        aiInteractions: turnAiInteractions,
        subActions: turnSubActions,
        computer: computerTurnRecord(shownView, recordShot),
      });
      break;
    }

    // §5.5 — three turns whose capture AND actions are identical is a stall.
    // Measured over what the model was SHOWN and what it asked for, which is
    // why it is observed here rather than after the actions run.
    if (stall.observe(shownView.pngBase64, parsed.actions.length > 0 ? parsed.actions : completion.text)) {
      allTurns.push({
        turnNumber: currentTurn,
        attemptNumber,
        timestamp: turnTimestamp,
        aiInteractions: turnAiInteractions,
        subActions: turnSubActions,
        computer: computerTurnRecord(shownView, recordShot),
      });
      throw new ComputerStepFailure(computerStallMessage(instruction), allTurns);
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

    for (const action of parsed.actions) {
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
          turnFailed = true;
          turnError = `Assertion failed: ${action.condition}. ${action.evidence}`;
        }
        // Either way the step is over: an assertion is a verdict (§5.5).
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

      // ── everything that touches the screen ────────────────────────────────
      const outcome = await executeComputerAction(action, {
        adapter: computer.adapter,
        view,
        settleMs: computer.settleMs,
        maxImageWidth: computer.maxImageWidth,
        ...(opts.signal && { sleep: interruptibleSleep(opts.signal) }),
      });
      if (outcome.screenPoint) {
        screenPoint = outcome.screenPoint;
        imagePoint = imagePointOf(action);
      }
      turnSubActions.push({
        ...baseSub(),
        ...(outcome.message !== undefined && !outcome.ok && { error: outcome.message }),
      });

      if (!outcome.ok) {
        // A window that never appeared, a title that matched nothing: the
        // model gets the message next turn and can choose differently. This
        // is what `priorFailure` in the step message is for.
        priorFailure = outcome.message;
        break;
      }

      // It worked, and the screen may be about to show nothing of the sort —
      // a window that was already frontmost, a key that only changed state the
      // image does not carry. The record of it goes to the model on every
      // remaining turn of this step.
      if (outcome.performed) {
        performed.push(performedLine(currentTurn, action, outcome, Date.now() - subStartTime));
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

    // Armed only by a turn that asked for window actions and nothing else, and
    // got them all. A refusal, a failure or a deliberate end disarms it, so the
    // next turn's repeat is a real repeat of a real success.
    satisfiedWindowKey =
      windowKey !== null &&
      !turnFailed &&
      priorFailure === undefined &&
      parsed.refused.length === 0
        ? windowKey
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

    if (turnFailed) {
      throw new ComputerStepFailure(
        turnError ?? 'Step failed',
        allTurns,
        !turnNonRetryable,
        deliberate,
        assertions,
      );
    }

    if (complete) break;

    if (currentTurn === maxTurns) {
      throw new ComputerStepFailure(
        `Step failed: multi-turn limit reached (${maxTurns} turns) on the computer surface.` +
          (priorFailure ? `\nLast action reported: ${priorFailure}` : ''),
        allTurns,
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
