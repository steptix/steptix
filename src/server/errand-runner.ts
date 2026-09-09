import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { Config, EffectiveSettings } from '../config/types.js';
import { resolveRunSettings } from '../config/run-settings.js';
import {
  BrowserTracker,
  briefly,
  closeBrowser,
  launchBrowser,
  type BrowserSession,
  type TrackedPage,
} from '../browser/manager.js';
import { executeStep } from '../runner/step-executor.js';
import type { StepResult } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { ApiResponseStore } from '../api/response-store.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { loadContextFiles } from '../context/loader.js';
import { interpolate } from '../parser/parameters.js';
import { parseSetStep } from '../parser/set-step.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import {
  flowControlExplanation,
  skippedByReturnReason,
} from '../runner/flow-control.js';
import { runSetStep } from '../runner/set-step-runner.js';
import { redact, runSecrets } from '../utils/secrets.js';
import { interpolateEnvData, type EnvDataContext } from '../parser/interpolate-env-data.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { ProjectBundleResolver } from './project-bundle.js';
import {
  applyEnvToAiConfig,
  autoCapturedNames,
  buildEnrichedInstruction,
  isBrowserClosed,
  isSkippableStep,
  parseOutputPrefixes,
  UNATTENDED_SKIP_REASON,
} from './run-helpers.js';
import type {
  ErrandSummary,
  ErrandTab,
  RunEvent,
  RunEventListener,
  SessionsHoldingTargets,
  StepResultResponse,
  TabInfo,
} from './session-manager.js';
import {
  ErrandLease,
  ErrandLocks,
  errandHoldsTabMessage,
  sessionHoldsTabMessage,
  type ErrandRefusal,
} from './errand-locks.js';
import { logger, addLogCallback, shouldEmit } from '../utils/logger.js';

/**
 * Borrow a tab, drive it, hand it back — stories/errands.md.
 *
 * An errand is `attach → act → return → detach` in one request. It lives
 * BESIDE `SessionManager` and never adds to its sessions map, which is what
 * makes "nothing of the errand survives on the server" checkable rather than
 * promised: `list_sessions` returns the same set before and after.
 *
 * The one thing it does borrow is the manager's in-flight run counter, for its
 * lifetime — an errand IS a run, so `/health`, the `POST /admin/shutdown` 409
 * and the idle reaper must all see it (stories/server-lifecycle.md).
 */

/**
 * Just enough of `SessionManager` for an errand to count as a run in flight,
 * and to see which sessions are mid-batch on a tab it wants to borrow.
 *
 * The second half is READ-ONLY and stays that way: an errand consults the
 * session world, never changes it (stories/errands.md §The wheel — sessions
 * neither take nor are blocked by the errand lock).
 */
export interface ErrandRunGate {
  beginExternalRun(): () => void;
  sessionsHoldingTargets(port: number): Promise<SessionsHoldingTargets>;
}

export interface ErrandRequest {
  /** The CDP browser's port. Resolved MCP-side against the server's browser
   *  listing; the server is handed the answer, never the name. */
  port: number;
  /** The borrowed tab, exact. The two-stage matcher runs MCP-side so the
   *  first-match-wins arm of `resolveCdpTab` is never asked to arbitrate. */
  targetId: string;
  steps: string[];
  /**
   * The synthetic `<root>/.aiui-errand.md` — the only thing a project root is
   * resolved from. Without it the project layer of `effectiveSettings` would
   * silently fall back to server defaults.
   */
  testFilePath: string;
  /** The root the errand resolved against, and its scope. Echoed into the
   *  receipt; the server does not re-derive them. */
  root: string;
  scope: 'project' | 'user';
  /** Leave errand-opened TABS behind. Never spares a browser a step opened. */
  keepOpen?: boolean;
  /** Without it no env bundle is built and `${env.X}` passes through as
   *  literal text — there is no default-env concept. */
  envName?: string;
  env?: Record<string, string>;
}

export interface ErrandResponse {
  errandId: string;
  status: 'passed' | 'failed' | 'error' | 'aborted';
  stepsCompleted: number;
  stepsTotal: number;
  results: StepResultResponse[];
  /** Every `store as` capture, by name. This is where an errand's variables
   *  go — to the caller. The server keeps no scope. */
  captures: Record<string, string>;
  /** `step` is 1-based. */
  error: { step: number; message: string } | null;
  effectiveSettings: EffectiveSettings;
  errand: ErrandSummary;
}

/** Bound on a tab title read taken while building the receipt — `page.title()`
 *  has none of its own, and a wedged tab must not stall the hand-back. */
const TAB_TITLE_TIMEOUT_MS = 500;

/**
 * What the step loop has produced so far.
 *
 * Owned by `drive` and mutated by `act` rather than returned, so a throw that
 * escapes the loop still leaves the partial results where the `done` frame can
 * pick them up. That frame is the only thing carrying the errand block, and
 * without it the MCP side has no receipt to hand back at all — only the folded
 * steps and a "the tab was driven, its final state is unknown" result
 * (`unfinishedErrandResult`, src/mcp/tools.ts). Every `done` this runner emits
 * carries the block, so that degraded shape is reserved for a stream that died
 * before the runner could answer.
 */
interface ActOutcome {
  results: StepResultResponse[];
  captures: Record<string, string>;
  status: ErrandResponse['status'];
  stepsCompleted: number;
  error: { step: number; message: string } | null;
  /** 1-based index of the step in flight, so an error nothing else attributed
   *  can still name one. */
  line: number;
}

/** `begin`'s answer: the errand may drive, or somebody else is. */
export type ErrandStart = { ok: true; lease: ErrandLease } | { ok: false; refusal: ErrandRefusal };

export class ErrandRunner {
  constructor(
    private readonly config: Config,
    private readonly gate: ErrandRunGate,
    /** The same resolver the session manager uses, so an errand and a session
     *  running against one project see the same `.env` at the same moment. */
    private readonly projectBundles: ProjectBundleResolver,
    /** Shared with the `close_cdp_tab` guard, which consults the same holds
     *  (stories/errands.md §The wheel). Required, not defaulted: a runner that
     *  quietly minted its own registry would take locks nothing else can see,
     *  and the close guard would wave through every tab an errand is driving. */
    private readonly locks: ErrandLocks,
  ) {}

  /**
   * Take the wheel for the borrowed tab, or say who has it.
   *
   * Separate from `run` because the answer has to be an HTTP status: the
   * streaming route flushes SSE headers before the first event, and a refusal
   * discovered after that could only be a `done` frame on a 200 — which is the
   * shape reserved for "the errand ran and failed".
   *
   * Order is deliberate. The lock is taken FIRST, synchronously, because it is
   * the only step two concurrent errands race on; the session join that follows
   * is an `await`, and checking before taking would let both winners through it.
   * A session refusal then releases what it took.
   */
  async begin(request: ErrandRequest): Promise<ErrandStart> {
    // Short, and alive only for this request: an errandId that outlived the
    // errand would be a handle onto something that no longer exists.
    const errandId = `errand-${randomBytes(4).toString('hex')}`;

    const held = this.locks.acquire(request.port, request.targetId, {
      errandId,
      tabRole: 'borrowed',
    });
    if (held) {
      return {
        ok: false,
        refusal: {
          holder: { kind: 'errand', errandId: held.errandId, tabRole: held.tabRole },
          error: errandHoldsTabMessage(held, request.targetId),
        },
      };
    }

    // Counted from here, not from the first step: the attach itself talks to a
    // browser, and a server that reaped itself during it would kill the request
    // just as dead.
    const lease = new ErrandLease(
      errandId,
      request.port,
      this.locks,
      this.gate.beginExternalRun(),
    );

    const busy = await this.sessionMidBatch(request);
    if (busy !== null) {
      lease.release();
      return {
        ok: false,
        refusal: {
          holder: { kind: 'session', sessionId: busy },
          error: sessionHoldsTabMessage(busy, request.targetId),
        },
      };
    }

    return { ok: true, lease };
  }

  /**
   * The session id of a batch in flight on the borrowed tab, or null.
   *
   * Two rules from stories/errands.md §The wheel, and they point opposite ways
   * to the close guard's on purpose:
   *
   * - An **idle** session blocks nothing. Idle is the safe case; mid-run is the
   *   dangerous one, and every holder is examined rather than the first — an
   *   idle winner must not mask an executing session.
   * - An **incomplete** join does not block either. A close refuses on a maybe
   *   because its failure closes a tab under a live run; a borrow that guesses
   *   wrong is bounded by one request and shows up in both sides' receipts.
   */
  private async sessionMidBatch(request: ErrandRequest): Promise<string | null> {
    let holders;
    try {
      holders = (await this.gate.sessionsHoldingTargets(request.port)).byTarget.get(
        request.targetId,
      );
    } catch (err) {
      // The join is advisory here. A manager that cannot answer at all is the
      // same case as one that answered partially: it does not block the borrow.
      logger.warn(`Errand pre-flight: session join failed, proceeding: ${String(err)}`);
      return null;
    }
    return holders?.find((holder) => holder.status === 'executing')?.sessionId ?? null;
  }

  /**
   * Run one errand start to finish, under a lease `begin` handed out.
   *
   * `onEvent` receives the same `RunEvent` stream a session emits, with the
   * errand's accounting on the `done` frame.
   *
   * The lease is released in a `finally`: finishing IS releasing, including
   * finishing by throw or abort. There is no `close_errand` because there is
   * nothing an errand can be left holding.
   */
  async run(
    lease: ErrandLease,
    request: ErrandRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
  ): Promise<ErrandResponse> {
    try {
      return await this.drive(lease, request, onEvent, signal);
    } finally {
      lease.release();
    }
  }

  private async drive(
    lease: ErrandLease,
    request: ErrandRequest,
    onEvent: RunEventListener | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ErrandResponse> {
    const errandId = lease.errandId;
    const emit = (event: RunEvent): void => {
      if (!onEvent) return;
      try {
        onEvent(event);
      } catch (err) {
        // A failing listener must not crash the errand.
        logger.warn(`Errand ${errandId}: run-event listener threw: ${String(err)}`);
      }
    };

    // Same bridge a session installs: without it a hanging step produces
    // `step:start` and then silence. Process-global, so concurrent runs see
    // each other's logs — the caveat the session path already accepts.
    const removeLogBridge = onEvent
      ? addLogCallback((level, message) => {
          if (!shouldEmit(level)) return;
          const kind: 'info' | 'warn' | 'error' =
            level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
          emit({ type: 'output', msg: message, kind });
        })
      : (): void => {};

    try {
      const envName = request.envName?.trim() || null;
      const bundle = await this.projectBundles.resolve(request.testFilePath, envName);
      const desiredAi = applyEnvToAiConfig(this.config.ai, request.env);
      // Server base → project bundle, and no third layer: an errand has no
      // session to hold overrides (stories/errands.md §Return), so `{}` here is
      // the whole story rather than an omission.
      //
      // The AI switch does not gate errands (stories/run-settings.md §9) —
      // an errand is a request FOR AI, and with no session to carry an
      // override the only thing that could gate it is a project's
      // `ai.allowInRuns: false`, which is a statement about RUNS.
      const settings = resolveRunSettings(this.config, bundle.config, desiredAi.model, {}, {
        ai: desiredAi,
        bypassAiPolicy: true,
      });
      const envDataCtx: EnvDataContext | null = bundle.envBundle
        ? {
            env: bundle.envBundle.env,
            data: bundle.envBundle.data,
            envName: bundle.envBundle.envName,
          }
        : null;

      const context = await loadContextFiles(this.config.tests.contextDir);
      const tokenTracker = new TokenTracker();
      // Built from `desiredAi`, not the resolved config: the request's env is
      // where an AI_API_KEY would arrive, and `resolveRunSettings` only ever
      // re-sources the model and the screenshot knobs.
      const aiClient = new AiClient(desiredAi, tokenTracker);

      // Attach. `launchBrowser` with a `cdp` block routes to the CDP path, so
      // the pre-existing-pages guard, the dialog guard and the PageTracker all
      // apply — and an exact `targetId:` spec means a tab that vanished between
      // the listing and here refuses honestly instead of matching something
      // else.
      const borrowed = await launchBrowser(settings.config.browser, {
        port: request.port,
        tab: `targetId:${request.targetId}`,
      });
      /**
       * Every tab this errand opened, as the sweep that saw it did.
       *
       * Declared BEFORE the tracker below, which closes over it.
       *
       * Written during the run rather than walked at detach because the receipt
       * names the tabs an errand opened "whether or not it survived"
       * (src/mcp/schemas.ts, `ErrandSummary` in session-manager.ts): a tab a
       * later step closed is already out of the tracker by the time the detach
       * looks — and so is every tab of a browser a step closed, which
       * `BrowserTracker.close` splices out of `all()` (manager.ts:892).
       *
       * Filled by TWO sweeps, because an errand drives two kinds of browser and
       * each keeps its own `PageTracker`: `claimOpenedTabs` reads the BORROWED
       * one, `recordLaunchedTabs` reads every browser this errand's own steps
       * launched. Both run at the same two moments — in the step loop's
       * `finally`, so what a step opened is recorded before a later step can
       * close it, and once more at the detach, for the tab that arrives after
       * the last step. Neither pass alone is enough at either moment.
       * `recordLaunchedTabs` runs at a THIRD moment as well, inside the wrapped
       * `close` below, because a step's `finally` is already too late for a
       * browser that same step closed.
       *
       * One boundary is left, and it is that same case one size smaller: a PAGE
       * opened and closed inside a SINGLE step of either browser this errand
       * drives — the borrowed one or one a step launched — is out of its
       * tracker (manager.ts:339) before that step's `finally` sweeps, so
       * `openedTabs` does not name it. The launched browser is no better off
       * than the borrowed one here: the step loop's sweep reaches that tracker
       * only after the step, by which time the page has spliced itself out.
       *
       * Closing that gap needs a hook at OPEN time, and an open-time hook is
       * the one moment the receipt cannot use: `addPage` enters every page as
       * `unexpected: true` (manager.ts:327) and only a later `markExpected`
       * (step-executor.ts:869) or `resolveOpener` (manager.ts:394) says
       * otherwise — one after the `newPage()` that produced the tab resolves,
       * the other after an `opener()` round-trip, so both land AFTER the hook
       * would have fired — meaning a hook firing there would be asked the
       * provenance question before anything can answer it, and this
       * errand may only name tabs it can account for. The browser-level case
       * below is reachable because the CLOSE goes through a tracker this errand
       * constructs, and by then the answer is already recorded.
       *
       * Keyed on the PAGE, not the target id, because the id is the one thing
       * about a tab that can be missing: it resolves asynchronously and can
       * fail outright (`TrackedPage.targetId` is permanently null on a context
       * that cannot make CDP sessions). Keying on it meant a tab whose id never
       * resolved was recorded nowhere — dropped from `openedTabs` entirely,
       * even though `ErrandTab.targetId` is optional precisely so such a tab
       * can be named by its url and title. The page object is stable for the
       * whole life of the tab and is the same identity the tracker holds.
       */
      const ownTabs = new Map<Page, ErrandTab>();
      const browserTracker = new BrowserTracker(borrowed);
      /**
       * The browsers a STEP closed, out of the detach's reach, with the tabs
       * the sweep saw in each of them before the splice.
       *
       * The same wedge the detach's own close loop reads for, at the one moment
       * that loop cannot: `closeBrowser` swallows its own failure and returns
       * normally (manager.ts:1541), and `BrowserTracker.close` splices the
       * session out of `all()` (manager.ts:892) either way — so a browser whose
       * `context.close()` rejected is off the list while its window is still on
       * the user's screen. The detach asks `isConnected()` of every session it
       * can still see; this one it cannot see, so without the SESSION kept here
       * its tabs reach `openedTabs` and never `keptOpen`, which is the receipt
       * saying "closed" about a window the user is looking at — the case
       * stories/errands.md §Return item (5) names as "still connected after its
       * close was asked for".
       *
       * The session, not an answer about it: survival is asked at the DETACH
       * (`detach`), because a browser that was still up when its close was
       * asked for can be gone by the time the receipt is written — the wedge
       * clears, the user closes the window, the process dies — and an answer
       * frozen here would have the receipt name a browser that is no longer
       * there. What the wrapper below can do, and the only place it can be
       * done, is catch the SESSION on its way out of `all()`; the pages beside
       * it are the sweep it had just taken, the one that put them in `ownTabs`.
       * The detach works from the keys and asks both halves for itself — of the
       * connection, and of the tracker — so nothing measured here is replayed
       * there as fact.
       */
      const strandedOpen = new Map<BrowserSession, Page[]>();
      /**
       * Record before the splice, and read the wreckage after it.
       *
       * `openBrowser` and `closeBrowser` are SUB-ACTIONS of one `executeStep`
       * turn (step-executor.ts:961, :1034), so a single step can open a browser
       * and close it again — and `BrowserTracker.close` splices the session out
       * of `all()` (manager.ts:892) with every tab it held. By the time that
       * step's `finally` runs `recordLaunchedTabs` there is nothing left to
       * walk, so a whole browser came and went on the user's screen and the
       * receipt named none of its tabs. Sweeping from inside `close`, before it
       * delegates, is the last moment the session is still in the list.
       *
       * Wrapped on the instance rather than pushed into `BrowserTracker`
       * itself: the tracker is the runner's for every other caller too (the
       * session path, the CLI), and none of them keeps an errand receipt.
       *
       * Recording on EVERY close, not just the mid-step ones, costs nothing:
       * `recordLaunchedTabs` is keyed on the page and keeps each entry's first
       * position, so a repeat refreshes a description without reordering the
       * receipt, and it never throws — writing the receipt must not be a new
       * way for `closeBrowser` to fail.
       */
      const closeTrackedBrowser = browserTracker.close.bind(browserTracker);
      browserTracker.close = async (label: string): Promise<void> => {
        const before = await this.recordLaunchedTabs(browserTracker, borrowed, ownTabs);
        // A throw from the delegate short-circuits the check below, and rightly:
        // `BrowserTracker.close` rejects on an unknown label before it touches
        // the list (manager.ts:881), so nothing was spliced and nothing is
        // stranded.
        await closeTrackedBrowser(label);
        const remaining = new Set(browserTracker.all());
        for (const [session, pages] of before) {
          // Load-bearing, not tidiness: `before` is a sweep of EVERY launched
          // browser, so without this a close of one browser would strand every
          // sibling that is still perfectly listed — and the detach would then
          // report as "still open" the tabs of browsers it went on to close
          // cleanly. Still listed means this close was not about it, and the
          // detach's own loop will reach it and ask the same question there.
          if (remaining.has(session)) continue;
          strandedOpen.set(session, pages);
        }
      };
      logger.info(
        `Errand ${errandId}: borrowed tab ${request.targetId} on port ${request.port} ` +
          `(${request.steps.length} step(s))`,
      );

      const outcome: ActOutcome = {
        results: [],
        captures: {},
        status: 'passed',
        stepsCompleted: 0,
        error: null,
        line: 0,
      };
      let errand: ErrandSummary;
      try {
        await this.act({
          errandId,
          lease,
          outcome,
          ownTabs,
          steps: request.steps,
          runConfig: settings.config,
          uploadPaths: {
            baseDir: dirname(request.testFilePath),
            projectRoot: bundle.projectRoot,
          },
          envDataCtx,
          aiClient,
          contextContent: context.combined,
          borrowed,
          browserTracker,
          emit,
          signal,
        });
      } catch (err) {
        // Belt and braces over the per-step guard: nothing in `act` is meant to
        // throw past the loop, but anything that does used to escape `drive`
        // altogether, and the route answered with a bare `done: error` carrying
        // no errand block — costing the caller the receipt for a tab this errand
        // had already driven. The block rides every `done` from here on; the
        // only errand without one is the one that never got the tab, or one
        // whose stream died before this frame could be written.
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Errand ${errandId} failed outside a step: ${message}`);
        emit({ type: 'output', msg: message, kind: 'error' });
        outcome.status = 'error';
        outcome.error = { step: Math.max(outcome.line, 1), message };
      } finally {
        // House rules, on every path including a throw: this is the errand's
        // whole personality, not a tidy-up.
        errand = await this.detach({
          errandId,
          root: request.root,
          scope: request.scope,
          keepOpen: request.keepOpen === true,
          borrowed,
          browserTracker,
          lease,
          ownTabs,
          strandedOpen,
        });
      }

      // No report is EVER written — the receipt IS the report
      // (stories/errands.md §Tool surface). Nothing calls `generateReport`.
      emit({
        type: 'done',
        status: outcome.status,
        effectiveSettings: settings.effective,
        errand,
      });

      return {
        errandId,
        status: outcome.status,
        stepsCompleted: outcome.stepsCompleted,
        stepsTotal: request.steps.length,
        results: outcome.results,
        captures: outcome.captures,
        error: outcome.error,
        effectiveSettings: settings.effective,
        errand,
      };
    } finally {
      removeLogBridge();
    }
  }

  /**
   * Run the steps in the borrowed tab.
   *
   * The session loop's core, minus everything that is session state: no skill
   * or section expansion, no frames, no conditional-group lookahead, no
   * breakpoints or step-mode pauses, no per-step cache, no video, no report.
   * What is left is what an errand is for — plain steps, waits, assertions and
   * captures, through the same `executeStep` and the same AI resolution.
   */
  private async act(args: {
    errandId: string;
    lease: ErrandLease;
    /** Written as the loop goes, so a throw past it still leaves a receipt. */
    outcome: ActOutcome;
    /** Filled by the claim sweep — see `claimOpenedTabs` below. */
    ownTabs: Map<Page, ErrandTab>;
    steps: string[];
    runConfig: Config;
    /** Base + fence for an "Upload file ..." step. An errand's synthetic test
     *  file sits in the project root, so both resolve there. */
    uploadPaths: { baseDir: string; projectRoot: string | null };
    envDataCtx: EnvDataContext | null;
    aiClient: AiClient;
    contextContent: string;
    borrowed: BrowserSession;
    browserTracker: BrowserTracker;
    emit: (event: RunEvent) => void;
    signal: AbortSignal | undefined;
  }): Promise<void> {
    const { errandId, lease, outcome, steps, emit, signal, browserTracker } = args;

    const claimOpenedTabs = (): Promise<void> =>
      this.claimOpenedTabs(lease, args.borrowed, args.ownTabs);
    /** The other half of the same moment — see `recordLaunchedTabs`. The map it
     *  returns is the detach's business; here only the recording matters. */
    const recordLaunchedTabs = async (): Promise<void> => {
      await this.recordLaunchedTabs(browserTracker, args.borrowed, args.ownTabs);
    };

    const { results, captures } = outcome;
    /**
     * The errand's variable scope — LOCAL, and gone when the request is.
     *
     * `executeStep` writes `as`-tagged reads straight into this map, so a later
     * step's `{{x}}` resolves from it; a *second* errand starts with an empty
     * one and its `{{x}}` reaches the AI as literal text, exactly as
     * `run_steps` would leave an unknown placeholder.
     */
    const scope: Record<string, string> = {};
    const conversationHistory: string[] = [];
    const apiResponseStore = new ApiResponseStore();
    const csrfTokens: Record<string, string> = {};

    /** Refreshed from the tracker after each step — openBrowser / switchBrowser
     *  / closeBrowser move which browser is active. */
    let active = args.borrowed;

    /** Which tab this step ran in, read at emit time so a step that switched
     *  tabs reports the one it ENDED in. Never fails a step. */
    const tabSpread = async (): Promise<{ tab?: TabInfo }> => {
      try {
        const tab = await active.pageTracker.describeActiveTab();
        return tab ? { tab } : {};
      } catch {
        return {};
      }
    };

    /**
     * Record a step that threw, so the run can stop on it.
     *
     * Shared by the two things a step can throw from — resolving its
     * placeholders and running it — because from the receipt's side they are
     * the same event: this step, this reason, nothing after it.
     */
    const recordThrow = (line: number, sentStep: string, err: unknown, screenshot: string): void => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Errand ${errandId} step ${line} error: ${message}`);
      results.push({
        step: sentStep,
        status: 'error',
        actions: [],
        screenshot,
        reasoning: message,
        outputs: {},
      });
      emit({
        type: 'step:fail',
        line,
        error: message,
        ...(screenshot && { screenshot }),
      });
      outcome.status = 'error';
      outcome.error = { step: line, message };
    };

    for (let i = 0; i < steps.length; i++) {
      if (signal?.aborted) {
        outcome.status = 'aborted';
        logger.info(`Errand ${errandId}: aborted by client at step ${i + 1}/${steps.length}`);
        break;
      }
      const originalStep = steps[i]!;
      const line = i + 1;
      outcome.line = line;

      // Env/data first (parse-time semantics), then runtime `{{...}}` against
      // the errand's own scope. With no env bundle the first pass is skipped
      // entirely, so `${env.X}` survives as literal text.
      //
      // Guarded, and the guard is the point: `interpolateEnvData` THROWS on an
      // unknown `${env.X}` once an env bundle exists. Uncaught, that throw sat
      // between steps rather than inside one — it escaped `act` and left the
      // request with no errand block at all, so an errand that had already
      // driven the user's tab was reported as never having started.
      // Read off the AUTHORED step and never interpolated — `interpolate`
      // would replace the TARGET with its own value once it holds one
      // (stories/variable-assignment.md §Locked).
      const setStep = parseSetStep(originalStep);
      // `If … then return` / `… then stop`, off the AUTHORED step for the same
      // reason `Set` is (stories/step-flow-control.md, decision 2). An errand
      // is a flat list with no expansion, so the only flow there is to leave is
      // the errand itself — `frameExitIndex`'s no-expansion answer, applied
      // directly: everything after this step.
      const flowControlClaim = setStep ? null : parseFlowControlStep(originalStep);
      const unconditionalFlowControl =
        flowControlClaim && flowControlClaim.body === undefined ? flowControlClaim : null;
      let interpolated: string;
      try {
        // Not evaluated for a Set step — `interpolateEnvData` throws on an
        // unknown `${…}`, which would report the raw parser wording instead
        // of `resolveSetTemplate`'s per-step refusal. Same reason as the
        // session manager, where the throw was worse still.
        const envInterpolated =
          setStep || !args.envDataCtx
            ? originalStep
            : interpolateEnvData(originalStep, args.envDataCtx);
        interpolated = setStep ? originalStep : interpolate(envInterpolated, scope);
      } catch (err) {
        emit({ type: 'step:start', line, ...(await tabSpread()) });
        recordThrow(line, originalStep, err, '');
        break;
      }

      if (isSkippableStep(interpolated)) {
        logger.info(`Errand ${errandId}: skipping step ${line} (input/interactive not supported)`);
        emit({ type: 'step:start', line });
        results.push({
          step: originalStep,
          status: 'passed',
          actions: [],
          screenshot: '',
          reasoning: UNATTENDED_SKIP_REASON,
          outputs: {},
        });
        // `skipKind: 'unattended'` is the machine-readable half of that
        // sentence, and it is what tells the MCP fold this is the skip that
        // needs a human rather than a branch a decision did not choose
        // (runner-core/src/protocol.ts, `StepPassEvent.skipKind`).
        emit({
          type: 'step:pass',
          line,
          output: 'skipped',
          reason: UNATTENDED_SKIP_REASON,
          skipKind: 'unattended',
        });
        outcome.stepsCompleted++;
        continue;
      }

      const { variables: outputVars, cleanedInstruction } = parseOutputPrefixes(interpolated);
      const instruction =
        outputVars.length > 0
          ? buildEnrichedInstruction(cleanedInstruction, outputVars)
          : interpolated;

      // Under `aiui mcp` this line goes to stderr — the host's MCP log — so
      // it is masked like the runners' (stories/secret-redaction.md).
      logger.step(
        line,
        steps.length,
        redact(instruction, runSecrets({ parameters: scope, envData: args.envDataCtx })),
      );
      emit({ type: 'step:start', line, ...(await tabSpread()) });

      let stepResult: StepResult;
      // What a Set step assigned, for the common tail below to report the way
      // it reports a capture. Emitted here rather than there so the `source`
      // can say `assignment`.
      let setAssigned: { name: string; value: string } | undefined;
      if (unconditionalFlowControl) {
        // `Return` / `Stop` as a whole step: no condition, so no model call, no
        // page read, nothing to reclaim — which is why, like `Set`, it sits
        // outside the try/finally (decision 3). The label is null because an
        // errand has no frames, so the phrase is "Ended the run".
        stepResult = {
          index: line,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 0,
          retried: false,
          aiExplanation: flowControlExplanation(null),
          flowControl: { kind: 'return', verb: unconditionalFlowControl.verb },
        };
      } else if (setStep) {
        // Assignment: no model, no page, no tabs to reclaim — which is why
        // this sits outside the try/finally rather than inside it.
        const setOutcome = runSetStep(setStep, instruction, line, scope, args.envDataCtx);
        stepResult = setOutcome.result;
        if (setOutcome.assigned) {
          setAssigned = setOutcome.assigned;
          // `defineProperty`, not `captures[name] =` — same `__proto__`
          // hazard the scope write guards against, one map further on.
          Object.defineProperty(captures, setAssigned.name, {
            value: setAssigned.value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          emit({
            type: 'capture',
            line,
            name: setAssigned.name,
            value: setAssigned.value,
            source: 'assignment',
          });
        }
      } else {
        try {
          stepResult = await executeStep(line, steps.length, instruction, {
            page: active.pageTracker.getActive(),
            config: args.runConfig,
            aiClient: args.aiClient,
            contextContent: args.contextContent,
            testName: `errand:${errandId}`,
            conversationHistory: [...conversationHistory],
            apiResponseStore,
            csrfTokens,
            resolvedParameters: scope,
            uploadPaths: args.uploadPaths,
            pageTracker: active.pageTracker,
            browserTracker,
            // No console is attached to an errand either, so an AI clarification
            // must fail the step fast rather than block on stdin.
            nonInteractive: true,
            // The CONDITIONAL form only — the unconditional one took its own
            // branch above. Present, the model's `return` action ends the step;
            // absent, it is refused and the model is told why (decision 2).
            ...(flowControlClaim && { flowControlClaim }),
            ...(signal && { signal }),
          },
          // The step as the caller wrote it, `{{}}` and `${}` intact — the model
          // reads that beside a `## Values` block and names the placeholder in
          // the action it plans (stories/placeholder-preserving-actions.md,
          // decision 1). The third interpolation site, treated like the other two.
          originalStep);
        } catch (err) {
          if (signal?.aborted) {
            outcome.status = 'aborted';
            logger.info(`Errand ${errandId}: aborted by client during step ${line}/${steps.length}`);
            break;
          }
          let errorScreenshot = '';
          try {
            const shot = await captureScreenshot(active.pageTracker.getActive());
            errorScreenshot = shot?.base64 ? `data:image/png;base64,${shot.base64}` : '';
          } catch {
            // ignore
          }
          recordThrow(line, originalStep, err, errorScreenshot);
          break;
        } finally {
          // Runs before the `break` above takes effect, so a step that opened a
          // tab and then threw still leaves that tab held for the detach.
          await claimOpenedTabs();
          // The borrowed browser is not the only one a step can open a tab in,
          // and the detach is too late to be the only place this runs: a tab a
          // later step closes is out of its tracker by then, and a browser a
          // later step closes is out of `browserTracker.all()` (manager.ts:892)
          // with every tab it ever held. Both are tabs the errand opened, and
          // `openedTabs` owes the caller a line about each.
          await recordLaunchedTabs();
        }
      }

      if (signal?.aborted) {
        outcome.status = 'aborted';
        logger.info(`Errand ${errandId}: aborted by client during step ${line}/${steps.length}`);
        break;
      }

      // Name what the step left. The executor returns the model's own account
      // of why the condition held and nothing more; the loop is what knows
      // which flow ended. Before the receipt row and the `step:pass` event are
      // built from it, so both read the same sentence
      // (stories/step-flow-control.md). The unconditional branch wrote its own.
      if (stepResult.flowControl && !unconditionalFlowControl) {
        stepResult.aiExplanation = flowControlExplanation(null, stepResult.aiExplanation);
      }

      // Captures: explicit `[output: X]` declarations plus this step's own
      // `as`-tagged reads. They accumulate in the receipt AND stay in `scope`
      // for later steps to interpolate.
      const stepOutputs: Record<string, string> = {};
      // A Set step's own write. Its `capture` event has already gone out with
      // the right source; this is the receipt's copy.
      if (setAssigned) {
        // `defineProperty` here too — the same `__proto__` hazard, one map
        // further on. Display-only (this feeds the receipt's per-step row,
        // not the scope), but leaving the third write plain is how the first
        // two came to be missed.
        Object.defineProperty(stepOutputs, setAssigned.name, {
          value: setAssigned.value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      for (const name of new Set([...outputVars, ...autoCapturedNames(stepResult)])) {
        if (!(name in scope)) continue;
        const value = scope[name]!;
        stepOutputs[name] = value;
        captures[name] = value;
        emit({ type: 'capture', line, name, value, source: 'capture' });
      }

      const screenshotValue = stepResult.screenshotBase64
        ? `data:image/png;base64,${stepResult.screenshotBase64}`
        : '';
      results.push({
        step: originalStep,
        status: stepResult.status === 'skipped' ? 'passed' : stepResult.status,
        actions: stepResult.turns.flatMap((t) => t.subActions).map((sa) => sa.action),
        screenshot: screenshotValue,
        reasoning: stepResult.aiExplanation ?? '',
        outputs: stepOutputs,
      });

      let currentUrl = '';
      try {
        currentUrl = active.pageTracker.getActive().url();
      } catch {
        // ignore
      }
      conversationHistory.push(
        // Masked: `## Prior Steps` is rebuilt from these lines on every later
        // step of the errand (stories/placeholder-preserving-actions.md
        // §Where a secret still goes).
        formatStepHistoryEntry(
          line,
          redact(interpolated, runSecrets({ parameters: scope, envData: args.envDataCtx })),
          stepResult.status === 'passed',
          currentUrl,
        ),
      );

      const tabAfterStep = await tabSpread();
      if (stepResult.status === 'passed') {
        outcome.stepsCompleted++;
        logger.success(`Errand ${errandId} step ${line} passed`);
        emit({
          type: 'step:pass',
          line,
          ...(stepResult.aiExplanation && { output: stepResult.aiExplanation }),
          ...(screenshotValue && { screenshot: screenshotValue }),
          ...tabAfterStep,
        });
        // ── The step ended the errand ────────────────────────────────────
        //
        // A flat list has one flow, so a return ends it: every remaining step
        // is skipped, and the errand still reports `passed` — a return is not a
        // failure (stories/step-flow-control.md, decisions 4 and 9). No
        // conversation-history line here, unlike the two frame-aware runners:
        // there is no later step in an outer flow that could need to know why
        // the numbering has a gap.
        if (stepResult.flowControl) {
          // `originalStep` is the AUTHORED line: it rides on the reason so a
          // reader can find the step that ended the errand, and being
          // authored it cannot carry a resolved secret into a log line.
          const reason = skippedByReturnReason(i, null, originalStep);
          for (let j = i + 1; j < steps.length; j++) {
            emit({ type: 'step:skip', line: j + 1, reason });
            results.push({
              step: steps[j] ?? '',
              status: 'skipped',
              actions: [],
              screenshot: '',
              reasoning: reason,
              outputs: {},
            });
            logger.info(`Errand ${errandId} step ${j + 1} skipped — ${reason}`);
          }
          break;
        }
      } else {
        outcome.status = 'failed';
        outcome.error = { step: line, message: stepResult.error ?? 'Step failed' };
        logger.error(`Errand ${errandId} step ${line} FAILED: ${stepResult.error ?? 'unknown'}`);
        emit({
          type: 'step:fail',
          line,
          error: stepResult.error ?? 'Step failed',
          ...(screenshotValue && { screenshot: screenshotValue }),
          ...tabAfterStep,
        });
        break;
      }

      // A step can move or close the active browser. Nothing left to drive is
      // the end of the errand — the detach path still runs and still hands the
      // borrowed tab back if it is there.
      try {
        active = browserTracker.getActive();
      } catch {
        break;
      }
      if (isBrowserClosed(active)) break;
    }
  }

  /**
   * Claim the wheel on every tab the errand OPENED ITSELF, and record what each
   * one looked like.
   *
   * The lock covers the borrowed tab plus everything the errand opened, for the
   * same reason stories/cdp-tabs.md §Locked tracks all of a session's pages: a
   * step can switch back to a tab it opened.
   *
   * Swept rather than hooked at open time because `PageTracker.addPage` is
   * synchronous and the target id it needs is not — this is the same resolved
   * sweep the session join reads. The window it leaves is real, not
   * theoretical: a tab is in the browser's own `/json/list` the moment it
   * exists, so a second errand can name it and take the wheel before this sweep
   * claims it. What makes that harmless is the detach path, which closes only
   * what this lease still holds.
   *
   * Run after every step AND once more at the detach, because the last thing to
   * open a tab need not be a step: a `window.open` the page fires after the
   * final step would otherwise never be claimed, and an unclaimed tab is one
   * the detach deliberately leaves behind.
   *
   * The descriptors are taken here, in the same pass, because the tracker drops
   * a page as soon as it closes — and the receipt owes every tab the errand
   * opened, surviving or not.
   *
   * Never throws: one caller is a `finally` inside the step loop, the other is
   * the detach.
   */
  private async claimOpenedTabs(
    lease: ErrandLease,
    borrowed: BrowserSession,
    ownTabs: Map<Page, ErrandTab>,
  ): Promise<void> {
    try {
      // Awaited for its effect as much as its answer: the sweep resolves the
      // in-flight target ids into the tracker's own entries, which is what
      // makes reading them back beside `unexpected` say anything.
      await borrowed.pageTracker.resolvedTargetIds();
      // A SNAPSHOT, not the tracker's live array. The loop below awaits a page
      // title per entry, and a tab that closes inside one of those awaits
      // splices itself out of `tabs()` — which shifts every later entry down and
      // makes the iterator skip the next one. That tab is claimed (the ids were
      // read before the loop) but never recorded, so the receipt silently loses
      // a tab the errand opened.
      const tracked = [...borrowed.pageTracker.tabs()];
      lease.claimOpened(errandOwnTargetIds(tracked));
      for (const entry of tracked) {
        if (entry.page === borrowed.page) continue;
        // Recorded on PROVENANCE, closed on the LEASE — deliberately two
        // different questions.
        //
        // `openedTabs` promises every tab this errand opened, "whether or not
        // they survived" (src/mcp/schemas.ts, `ErrandSummary` in
        // session-manager.ts). A tab this errand opened but another errand
        // claimed first is spared the close — the lease gate in `detach` sees
        // to that — and it is still a tab this errand opened, so leaving it out
        // of the receipt would hide the very collision the caller needs to
        // explain the page state with.
        if (entry.unexpected) continue;
        // No `targetId !== null` gate on THIS path, unlike the claim above and
        // the close in `detach`: both of those address a tab by its id and
        // cannot act without one, while the receipt names a tab by url and
        // title and carries the id only when there is one (`ErrandTab.targetId`
        // is optional for exactly this case). An unresolved id is a tab the
        // errand opened and cannot close — the one it most owes the caller a
        // line about.
        ownTabs.set(entry.page, await describeTab(entry));
      }
    } catch {
      // A tracker that cannot enumerate leaves the borrowed tab held, which is
      // the claim that matters; a tab whose id never resolved is one no other
      // errand can name either.
    }
  }

  /**
   * Record every tab inside the browsers this errand's own steps LAUNCHED.
   *
   * `claimOpenedTabs`' sibling, and deliberately only half of it: this one
   * RECORDS and does nothing else. An `openBrowser` step builds a second
   * `BrowserSession` with a `PageTracker` all of its own (step-executor.ts:961),
   * and every claim sweep reads the BORROWED browser's tracker — so without this
   * pass a tab in a launched browser reaches no receipt at all and `openedTabs`
   * breaks the promise it makes: every tab the errand opened along the way,
   * whether or not it survived (`ErrandSummary`, session-manager.ts; the same
   * words in src/mcp/schemas.ts, and stories/errands.md §Return item (4)).
   *
   * No `lease.claimOpened`, and nothing here joins the detach's `closable`.
   * Neither is missing by oversight: `openBrowser` launches with no cdp argument
   * at all, so a browser this errand launched has no CDP port for a rival errand
   * to name a tab through, and none of these tabs takes a turn lock — the lease
   * is keyed on the BORROWED browser's port. The detach's browser-close loop
   * takes each launched browser down whole, which is what closes these tabs; a
   * per-tab close would be a second, slower way to do what that already does.
   *
   * A tracker's own first page IS recorded, unlike the borrowed browser's
   * (skipped there as the tab we were lent): this errand opened the browser, so
   * it opened the page the browser came up on.
   *
   * Run after every step AND once more at the detach, for the two things a
   * detach-only walk cannot see — a tab a later step closed, which its tracker
   * drops (manager.ts:339), and a whole browser a later step closed, which
   * `BrowserTracker.close` splices out of `all()` (manager.ts:892) with every
   * tab it held. Recording the same tab twice is free: `ownTabs` is keyed on the
   * page and keeps its first position, so a later pass refreshes the
   * description without reordering the receipt.
   *
   * Run at a THIRD moment too, and for the case neither of those two can reach:
   * `drive` wraps the tracker's own `close` so this runs BEFORE the splice,
   * because `openBrowser` and `closeBrowser` are sub-actions of ONE
   * `executeStep` turn (step-executor.ts:961, :1034) — a browser opened and
   * closed inside a single step is out of `all()` before that step's `finally`
   * ever asks.
   *
   * Returns what it saw THIS pass, per session, so a caller can put a browser's
   * tabs back into `stillOpen` when the close did not take: the detach for a
   * browser it closes itself, the close wrapper for one a STEP closed, which
   * the splice hides from the detach entirely. The step loop's own calls want
   * only the recording and discard it.
   *
   * Never throws: `all()` is a plain array read and `recordSessionTabs` is
   * guarded, which is what lets its callers be a `finally` inside the step loop,
   * the detach, and a browser close that must not start failing because the
   * receipt could not be written.
   */
  private async recordLaunchedTabs(
    browserTracker: BrowserTracker,
    borrowed: BrowserSession,
    ownTabs: Map<Page, ErrandTab>,
  ): Promise<Map<BrowserSession, Page[]>> {
    const launchedTabs = new Map<BrowserSession, Page[]>();
    for (const session of browserTracker.all()) {
      if (session === borrowed) continue;
      launchedTabs.set(session, await this.recordSessionTabs(session, ownTabs));
    }
    return launchedTabs;
  }

  /**
   * One launched browser's sweep: record its tabs, and answer which of them the
   * tracker holds RIGHT NOW.
   *
   * Split out of `recordLaunchedTabs` because the detach needs this for a
   * session that walk can no longer reach — a browser a STEP closed, spliced
   * out of `all()` (manager.ts:892) and kept only in `strandedOpen`. Same two
   * jobs there as here, and for the same reason: the recording is what
   * `openedTabs` is built from, and the return is the evidence `keptOpen` needs
   * about what is on the user's screen at the hand-back rather than earlier.
   *
   * Everything it returns it has just recorded into `ownTabs` one line above,
   * so a caller may put the whole list into `stillOpen` without re-filtering:
   * `keptOpen` walks `ownTabs`, and a page that never entered it could not be
   * named there anyway.
   *
   * Never throws. A tracker that cannot enumerate costs the receipt a line; it
   * must not cost the caller the hand-back, which runs inside a `finally`.
   */
  private async recordSessionTabs(
    session: BrowserSession,
    ownTabs: Map<Page, ErrandTab>,
  ): Promise<Page[]> {
    const recorded: Page[] = [];
    try {
      // A SNAPSHOT, for the reason `claimOpenedTabs` takes one: a tab that
      // closes inside the `describeTab` await splices itself out of `tabs()`
      // and the live iterator then skips its neighbour.
      for (const entry of [...session.pageTracker.tabs()]) {
        // The same provenance gate the borrowed sweep applies: a tab this
        // errand cannot account for is not one it may claim to have opened.
        if (entry.unexpected) continue;
        ownTabs.set(entry.page, await describeTab(entry));
        recorded.push(entry.page);
      }
    } catch {
      // Whatever was recorded before the throw stands.
    }
    return recorded;
  }

  /**
   * Hand the tab back (stories/errands.md §House rules).
   *
   * Enforced here rather than promised in prose, and enforced on error paths
   * too — this method is called from a `finally`, which is why nothing in it is
   * allowed to throw: a failure here would replace the error the caller was
   * already reporting.
   */
  private async detach(args: {
    errandId: string;
    root: string;
    scope: 'project' | 'user';
    keepOpen: boolean;
    borrowed: BrowserSession;
    browserTracker: BrowserTracker;
    /** The turn lock, consulted before every close — see `closable`. */
    lease: ErrandLease;
    /** What the claim sweeps recorded, closed tabs included. */
    ownTabs: Map<Page, ErrandTab>;
    /**
     * The browsers a STEP closed, with what the pre-splice sweep saw in each —
     * gathered by the wrapped `browserTracker.close` in `drive`, because the
     * splice takes those sessions out of reach of the close loop below.
     *
     * Sessions, not a verdict: whether each is still on the user's screen is
     * asked HERE, at the hand-back, like every other survival question on this
     * path.
     */
    strandedOpen: Map<BrowserSession, Page[]>;
  }): Promise<ErrandSummary> {
    const { errandId, keepOpen, borrowed, browserTracker, lease } = args;
    const borrowedPage = borrowed.page;

    // One last claim, before anything is closed or reported: a tab that
    // appeared after the final step's sweep is otherwise unheld, and unheld is
    // exactly what this path leaves behind.
    await this.claimOpenedTabs(lease, borrowed, args.ownTabs);

    /**
     * What the tracker still holds, read ONCE.
     *
     * Two questions are asked of this list and they are not the same question:
     * what this errand may CLOSE, and what of its own is still OPEN. Two reads
     * could disagree about a tab that closed between them, and the receipt
     * would then both close a tab and report it open.
     */
    let tracked: TrackedPage[] = [];
    try {
      tracked = [...borrowed.pageTracker.tabs()];
    } catch {
      // A tracker that cannot list its tabs leaves nothing to close, which is
      // the safe direction for a rule about not closing other people's tabs —
      // and nothing reported still open, which is the safe direction for a
      // claim about the user's screen.
    }

    /**
     * The tabs this errand may close: still tracked, not the borrowed one, and
     * still held by THIS errand's lease.
     *
     * Pages open at attach time are not candidates at all — the CDP attach
     * handed the tracker an ignore set of them (`connectOverCdpSession`,
     * manager.ts:1437). But that set is a snapshot, and `context.on('page')`
     * adopts every tab opened on the browser AFTERWARDS, whoever opened it: the
     * user, another session, another errand.
     *
     * The **lease**, not `unexpected`, is what gates the close — the one place
     * the two questions come apart, since `claimOpenedTabs` records on
     * provenance. A tab this errand opened is unlocked until the next claim
     * sweep, and in that window another errand can name it from the browser's
     * own listing and take the wheel; `claimOpened` then correctly declines to
     * steal it back, so `unexpected` alone would close a tab somebody else is
     * driving. That tab is still named in the receipt (this errand did open
     * it); it is simply not this errand's to close. A tab whose target id never
     * resolved is spared for the same reason stranding is the safe direction
     * (manager.ts:176).
     */
    const closable: TrackedPage[] = tracked.filter(
      (entry) =>
        entry.page !== borrowedPage && entry.targetId !== null && lease.holds(entry.targetId),
    );

    /**
     * The tabs inside browsers this errand's own steps LAUNCHED, as they stand
     * NOW — the last of the same sweeps the step loop ran (`recordLaunchedTabs`).
     *
     * Two jobs, and only the first is shared with the step loop's calls. It
     * records into `ownTabs`, which is what catches a tab opened in a launched
     * browser after the final step; and it answers, per session, which of those
     * tabs are still tracked at the hand-back, which is what lets the close loop
     * below put a browser's tabs back into `stillOpen` when the close did not
     * take — the evidence rule the per-tab closes already follow.
     *
     * Read HERE rather than carried from the step loop for exactly that second
     * job: a tab an earlier step closed is out of its tracker and must not be
     * reported still open, even though it is (rightly) still in `ownTabs`.
     */
    const launchedTabs = await this.recordLaunchedTabs(browserTracker, borrowed, args.ownTabs);

    /**
     * The same two jobs for the browsers a STEP closed, which `launchedTabs`
     * cannot reach: `BrowserTracker.close` spliced them out of `all()`
     * (manager.ts:892), so `drive`'s close wrapper kept the sessions.
     *
     * Survival is asked HERE and nowhere earlier. The wrapper could have read
     * `isConnected()` at the moment of the splice, and that answer would then
     * have been repeated as fact however long the rest of the run took: a
     * browser whose wedge cleared, whose window the user closed, or whose
     * process died mid-run would still be named "still open" on a receipt
     * written afterwards. `keptOpen` is a claim about the browser as the errand
     * hands the tab back, so it is measured then — the same question, the same
     * guard, and the same "unreadable claims nothing" direction as the close
     * loop's own check below.
     *
     * And when the answer is yes, the tracker is re-read rather than trusted
     * from the splice, exactly as `launchedTabs` re-reads instead of carrying
     * the step loop's sweeps: a tab the user closed inside that wedged-open
     * browser has spliced itself out (manager.ts:339) and must not be reported
     * still open, and every descriptor the receipt carries is refreshed to what
     * the tab says now. Recording only — a stranded browser is past closing.
     *
     * Before `openedTabs` below, because that sweep writes into `ownTabs`:
     * anything it finds or refreshes belongs on the receipt it builds.
     */
    const strandedTabs: Page[] = [];
    for (const session of args.strandedOpen.keys()) {
      let survived = false;
      try {
        survived = session.browser.isConnected();
      } catch {
        // No answer either way. The asked-for close is then the only evidence
        // there is, so this claims nothing — the same direction the close
        // loop's own unreadable case takes below.
      }
      if (!survived) continue;
      strandedTabs.push(...(await this.recordSessionTabs(session, args.ownTabs)));
    }

    // Every tab the errand opened, whether or not it survived the run — the
    // promise `openedTabs` makes in src/mcp/schemas.ts and on `ErrandSummary`.
    // Read from the sweeps rather than from what is still tracked, because a
    // tab a later step closed left the tracker when it went.
    const openedTabs: ErrandTab[] = [...args.ownTabs.values()];

    /**
     * Which of those are still open, minus whatever the closes below take away.
     *
     * Built from what is TRACKED, with no `lease.holds` filter: that gate says
     * what this errand may close, which is a different question from what is
     * open. A tab this errand opened but another errand took the wheel of is
     * spared the close (`closable`) and is therefore still on screen — reported
     * through the lease it would be listed as gone, which is a false claim
     * about the user's browser and hides the collision the receipt exists to
     * explain.
     *
     * `tracked` is the BORROWED browser's list, so a launched browser's tabs
     * start outside this set and stay outside it — correctly: the close loop
     * takes their whole browser down, and a tab cannot outlive the browser it
     * is in. The ways back in are the two halves of one evidence rule, for a
     * browser still connected once its close has been asked for — and both
     * halves ask at THIS hand-back, of the connection and of the tracker: the
     * close loop's own check below, for a browser the detach closed, and
     * `strandedTabs` above for one a STEP closed, which the splice
     * (manager.ts:892) put beyond that loop's reach before it ever ran.
     */
    const stillOpen = new Set<Page>(
      tracked.map((entry) => entry.page).filter((page) => args.ownTabs.has(page)),
    );
    // No `ownTabs` filter, and none needed: `recordSessionTabs` records every
    // page it returns, so these are already in `ownTabs` — the same reason the
    // close loop's own arm below adds `launchedTabs` unfiltered.
    for (const page of strandedTabs) stillOpen.add(page);

    let finalUrl = '';
    let finalTitle = '';
    try {
      finalUrl = borrowedPage.url();
    } catch {
      // The tab went away under us; the rest of the receipt still stands.
    }
    try {
      finalTitle = await briefly(borrowedPage.title().catch(() => ''), TAB_TITLE_TIMEOUT_MS, '');
    } catch {
      // ignore
    }

    if (!keepOpen) {
      for (const entry of closable) {
        try {
          await entry.page.close();
          stillOpen.delete(entry.page);
        } catch {
          // Already gone is the outcome we wanted. Guarded per tab, because
          // this runs inside a `finally`: one refusing tab must not replace the
          // receipt — or the error — the caller was already reporting.
          //
          // Left in `stillOpen` deliberately: this tab was in the tracker a
          // moment ago (that is what put it in `closable`), so the evidence
          // says it is open and the close did not answer. Reporting it closed
          // on the strength of having tried is the guess this receipt is meant
          // to replace.
        }
      }
    }

    // `keepOpen` spares tabs only. A browser a step opened is closed
    // regardless — the teardown rule stories/multi-browser.md already sets for
    // runs, and an errand leaving a whole browser behind is not a coat, it is
    // a house guest.
    //
    // Guarded per browser, like the tab closes above: one wedged browser must
    // not take the rest of the hand-back with it, and the raise and the
    // disconnect below are what give the user their tab back.
    for (const session of browserTracker.all()) {
      if (session === borrowed) continue;
      /** Evidence that the browser is still up, from either of the two things
       *  that can say so. */
      let survived = false;
      try {
        await closeBrowser(session);
      } catch {
        // Belt and braces, and named as such: `closeBrowser` wraps its whole
        // body in a try/catch and logs (manager.ts:1541), so in production it
        // does not reject and this arm does not run. It stays because the
        // hand-back is a `finally` — a future edit that lets a throw out must
        // not take the raise and the disconnect below with it — and a close
        // that threw did not answer, which is what the per-tab closes above
        // already treat as "still there".
        survived = true;
      }
      try {
        // The check that actually catches a wedged browser. `closeBrowser`
        // swallowing its own failure means its RETURN says only that it ran;
        // a `context.close()` that rejects leaves the browser up and the caller
        // none the wiser. The connection is the evidence that survives that
        // swallow: a browser still connected is a browser still on screen, and
        // the tabs it held are on screen inside it.
        if (session.browser.isConnected()) survived = true;
      } catch {
        // No answer either way. A close that returned without complaint is the
        // only evidence left, so this leaves `survived` as it stands rather
        // than inventing a browser on the user's screen — the same direction
        // the tracker's own unreadable case takes above.
      }
      if (survived) {
        // Back into `stillOpen`, on the evidence rule the per-tab closes above
        // already follow: these pages were in this browser's tracker a moment
        // ago and the browser is still there, so calling them closed on the
        // strength of having asked is the guess the receipt exists to replace.
        for (const page of launchedTabs.get(session) ?? []) stillOpen.add(page);
      }
    }

    // Hand the keys back visibly. "Request" is the honest verb: there is no
    // read of "is this tab frontmost", and Windows may decline a raise from a
    // background process — so this is silent and non-fatal, the same posture as
    // the attach path (manager.ts:1469).
    try {
      await borrowedPage.bringToFront();
    } catch {
      /* non-fatal */
    }

    // Disconnect, never kill. `closeBrowser` severs the CDP websocket and
    // closes only a tab the ATTACH itself opened — which a `targetId:` attach
    // never does, so the borrowed tab survives by construction.
    try {
      await closeBrowser(borrowed);
    } catch {
      // A socket that will not close cleanly is not worth failing a receipt for.
    }

    /**
     * Still open on return — what `keptOpen` says it is (src/mcp/schemas.ts,
     * `ErrandSummary`), rather than "what `keep_open` spared".
     *
     * Under the default `keep_open: false` this is normally empty, and the
     * exceptions are the whole point of reporting it honestly: a tab another
     * errand took the wheel of was spared the close, a tab that refused to
     * close is still there, and so is every tab of a browser still connected
     * after its close was asked for — whether the detach asked or a step did.
     * All are open, and a caller told they were closed goes looking for a page
     * that is on screen. A tab an earlier step closed is in neither set — it
     * left the tracker when it went.
     */
    const keptOpen: ErrandTab[] = [...args.ownTabs]
      .filter(([page]) => stillOpen.has(page))
      .map(([, tab]) => tab);

    logger.info(
      `Errand ${errandId}: detached (${openedTabs.length} tab(s) opened, ` +
        `${keptOpen.length} still open)`,
    );

    return {
      errandId,
      root: args.root,
      scope: args.scope,
      finalUrl,
      finalTitle,
      openedTabs,
      keptOpen,
    };
  }
}

/**
 * The target ids of the tabs this errand can honestly call its own: the
 * borrowed one, plus the ones its own steps opened.
 *
 * `unexpected` is `PageTracker`'s provenance flag. Every page the tracker adopts
 * starts unexpected and is cleared by whichever of the two legitimate openers
 * did it — an `openPage` step (`markExpected`) or a popup whose opener is a page
 * we drive *and already account for* (`resolveOpener`, which is why an adopted
 * tab's popups stay unexpected). What is left set is a tab that appeared on the
 * browser with nothing in this errand accounting for it: the user opened it,
 * another session did, another errand did.
 *
 * Used as a GATE, which manager.ts:163 rules out for reports — and the exception
 * is the whole of house rule 1. The two failure directions are not symmetric:
 * a tab wrongly called unexpected is stranded (it stays open, and the receipt
 * does not claim it), while one wrongly called ours is CLOSED out from under
 * whoever opened it. Stranding is the safe direction, so the flag gates here
 * even though it is a heuristic.
 */
function errandOwnTargetIds(pages: readonly TrackedPage[]): string[] {
  return pages
    .filter((entry): entry is TrackedPage & { targetId: string } =>
      !entry.unexpected && entry.targetId !== null,
    )
    .map((entry) => entry.targetId);
}

/**
 * One opened tab, as the receipt names it.
 *
 * The target id is read from the tracker's cache rather than a fresh CDP
 * round-trip: this tab is usually about to be closed, and a wedged one must not
 * stall the hand-back. Absent when it never resolved — the url and title still
 * identify it.
 */
async function describeTab(entry: TrackedPage): Promise<ErrandTab> {
  let url = '';
  let title = '';
  try {
    url = entry.page.url();
  } catch {
    // ignore
  }
  try {
    title = await briefly(entry.page.title().catch(() => ''), TAB_TITLE_TIMEOUT_MS, '');
  } catch {
    // ignore
  }
  return {
    ...(entry.targetId !== null && { targetId: entry.targetId }),
    url,
    title,
  };
}
