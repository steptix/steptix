import { randomBytes } from 'node:crypto';
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
} from './run-helpers.js';
import type {
  ErrandSummary,
  ErrandTab,
  RunEvent,
  RunEventListener,
  StepResultResponse,
  TabInfo,
} from './session-manager.js';
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

/** Just enough of `SessionManager` for an errand to count as a run in flight. */
export interface ErrandRunGate {
  beginExternalRun(): () => void;
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

/** What the step loop produced, before the detach path adds the tab accounting. */
interface ActOutcome {
  results: StepResultResponse[];
  captures: Record<string, string>;
  status: ErrandResponse['status'];
  stepsCompleted: number;
  error: { step: number; message: string } | null;
}

export class ErrandRunner {
  constructor(
    private readonly config: Config,
    private readonly gate: ErrandRunGate,
    /** The same resolver the session manager uses, so an errand and a session
     *  running against one project see the same `.env` at the same moment. */
    private readonly projectBundles: ProjectBundleResolver,
  ) {}

  /**
   * Run one errand start to finish.
   *
   * `onEvent` receives the same `RunEvent` stream a session emits, with the
   * errand's accounting on the `done` frame.
   */
  async run(
    request: ErrandRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
  ): Promise<ErrandResponse> {
    // Short, and alive only for this request: an errandId that outlived the
    // errand would be a handle onto something that no longer exists.
    const errandId = `errand-${randomBytes(4).toString('hex')}`;
    // Taken at the very entry, released in a `finally` — a throw or an abort
    // must never strand the counter above zero.
    const release = this.gate.beginExternalRun();
    try {
      return await this.drive(errandId, request, onEvent, signal);
    } finally {
      release();
    }
  }

  private async drive(
    errandId: string,
    request: ErrandRequest,
    onEvent: RunEventListener | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ErrandResponse> {
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
      const settings = resolveRunSettings(this.config, bundle.config, desiredAi.model, {});
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
      const browserTracker = new BrowserTracker(borrowed);
      logger.info(
        `Errand ${errandId}: borrowed tab ${request.targetId} on port ${request.port} ` +
          `(${request.steps.length} step(s))`,
      );

      let outcome: ActOutcome;
      let errand: ErrandSummary;
      try {
        outcome = await this.act({
          errandId,
          steps: request.steps,
          runConfig: settings.config,
          envDataCtx,
          aiClient,
          contextContent: context.combined,
          borrowed,
          browserTracker,
          emit,
          signal,
        });
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
    steps: string[];
    runConfig: Config;
    envDataCtx: EnvDataContext | null;
    aiClient: AiClient;
    contextContent: string;
    borrowed: BrowserSession;
    browserTracker: BrowserTracker;
    emit: (event: RunEvent) => void;
    signal: AbortSignal | undefined;
  }): Promise<ActOutcome> {
    const { errandId, steps, emit, signal, browserTracker } = args;

    const results: StepResultResponse[] = [];
    const captures: Record<string, string> = {};
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

    let status: ErrandResponse['status'] = 'passed';
    let stepsCompleted = 0;
    let error: { step: number; message: string } | null = null;
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

    for (let i = 0; i < steps.length; i++) {
      if (signal?.aborted) {
        status = 'aborted';
        logger.info(`Errand ${errandId}: aborted by client at step ${i + 1}/${steps.length}`);
        break;
      }
      const originalStep = steps[i]!;
      const line = i + 1;

      // Env/data first (parse-time semantics), then runtime `{{...}}` against
      // the errand's own scope. With no env bundle the first pass is skipped
      // entirely, so `${env.X}` survives as literal text.
      const envInterpolated = args.envDataCtx
        ? interpolateEnvData(originalStep, args.envDataCtx)
        : originalStep;
      const interpolated = interpolate(envInterpolated, scope);

      if (isSkippableStep(interpolated)) {
        logger.info(`Errand ${errandId}: skipping step ${line} (input/interactive not supported)`);
        emit({ type: 'step:start', line });
        results.push({
          step: originalStep,
          status: 'passed',
          actions: [],
          screenshot: '',
          reasoning: 'Skipped: [input] and [interactive] steps are not supported in API mode',
          outputs: {},
        });
        emit({ type: 'step:pass', line, output: 'skipped' });
        stepsCompleted++;
        continue;
      }

      const { variables: outputVars, cleanedInstruction } = parseOutputPrefixes(interpolated);
      const instruction =
        outputVars.length > 0
          ? buildEnrichedInstruction(cleanedInstruction, outputVars)
          : interpolated;

      logger.step(line, steps.length, instruction);
      emit({ type: 'step:start', line, ...(await tabSpread()) });

      let stepResult: StepResult;
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
          pageTracker: active.pageTracker,
          browserTracker,
          // No console is attached to an errand either, so an AI clarification
          // must fail the step fast rather than block on stdin.
          nonInteractive: true,
          ...(signal && { signal }),
        });
      } catch (err) {
        if (signal?.aborted) {
          status = 'aborted';
          logger.info(`Errand ${errandId}: aborted by client during step ${line}/${steps.length}`);
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Errand ${errandId} step ${line} error: ${message}`);

        let errorScreenshot = '';
        try {
          const shot = await captureScreenshot(active.pageTracker.getActive());
          errorScreenshot = shot?.base64 ? `data:image/png;base64,${shot.base64}` : '';
        } catch {
          // ignore
        }
        results.push({
          step: originalStep,
          status: 'error',
          actions: [],
          screenshot: errorScreenshot,
          reasoning: message,
          outputs: {},
        });
        emit({
          type: 'step:fail',
          line,
          error: message,
          ...(errorScreenshot && { screenshot: errorScreenshot }),
        });
        status = 'error';
        error = { step: line, message };
        break;
      }

      if (signal?.aborted) {
        status = 'aborted';
        logger.info(`Errand ${errandId}: aborted by client during step ${line}/${steps.length}`);
        break;
      }

      // Captures: explicit `[output: X]` declarations plus this step's own
      // `as`-tagged reads. They accumulate in the receipt AND stay in `scope`
      // for later steps to interpolate.
      const stepOutputs: Record<string, string> = {};
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
        formatStepHistoryEntry(line, interpolated, stepResult.status === 'passed', currentUrl),
      );

      const tabAfterStep = await tabSpread();
      if (stepResult.status === 'passed') {
        stepsCompleted++;
        logger.success(`Errand ${errandId} step ${line} passed`);
        emit({
          type: 'step:pass',
          line,
          ...(stepResult.aiExplanation && { output: stepResult.aiExplanation }),
          ...(screenshotValue && { screenshot: screenshotValue }),
          ...tabAfterStep,
        });
      } else {
        status = 'failed';
        error = { step: line, message: stepResult.error ?? 'Step failed' };
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

    return { results, captures, status, stepsCompleted, error };
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
  }): Promise<ErrandSummary> {
    const { errandId, keepOpen, borrowed, browserTracker } = args;
    const borrowedPage = borrowed.page;

    /**
     * Everything the errand opened: the tracker's pages minus the borrowed one.
     *
     * Pre-existing tabs are not in this list at all — the CDP attach handed the
     * tracker an ignore set of every page open at the time
     * (`connectOverCdpSession`, manager.ts:1363), which is the guard the whole
     * house-rule rests on. It is deliberately NOT filtered on
     * `TrackedPage.unexpected`: that flag is diagnostics-only by standing
     * decision (manager.ts:165), and a wrong guess used as a gate here either
     * strands a tab or closes one that is not ours.
     */
    let opened: TrackedPage[] = [];
    try {
      opened = borrowed.pageTracker.tabs().filter((entry) => entry.page !== borrowedPage);
    } catch {
      // A tracker that cannot list its tabs leaves nothing to close, which is
      // the safe direction for a rule about not closing other people's tabs.
    }

    const openedTabs: ErrandTab[] = [];
    for (const entry of opened) {
      openedTabs.push(await describeTab(entry));
    }

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
      for (const entry of opened) {
        try {
          await entry.page.close();
        } catch {
          // Already gone is the outcome we wanted.
        }
      }
    }

    // `keepOpen` spares tabs only. A browser a step opened is closed
    // regardless — the teardown rule stories/multi-browser.md already sets for
    // runs, and an errand leaving a whole browser behind is not a coat, it is
    // a house guest.
    for (const session of browserTracker.all()) {
      if (session === borrowed) continue;
      await closeBrowser(session);
    }

    // Hand the keys back visibly. "Request" is the honest verb: there is no
    // read of "is this tab frontmost", and Windows may decline a raise from a
    // background process — so this is silent and non-fatal, the same posture as
    // the attach path (manager.ts:1390).
    try {
      await borrowedPage.bringToFront();
    } catch {
      /* non-fatal */
    }

    // Disconnect, never kill. `closeBrowser` severs the CDP websocket and
    // closes only a tab the ATTACH itself opened — which a `targetId:` attach
    // never does, so the borrowed tab survives by construction.
    await closeBrowser(borrowed);

    logger.info(
      `Errand ${errandId}: detached (${openedTabs.length} tab(s) opened, ` +
        `${keepOpen ? 'kept open' : 'closed'})`,
    );

    return {
      errandId,
      root: args.root,
      scope: args.scope,
      finalUrl,
      finalTitle,
      openedTabs,
      keptOpen: keepOpen ? [...openedTabs] : [],
    };
  }
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
