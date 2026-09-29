import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import type { Config } from '../config/types.js';
import {
  describeViewportSource,
  resolveViewportSpec,
  viewportCdpConflictError,
  type ViewportSize,
} from '../config/viewport.js';
import { withTableStructure } from '../config/table-structure.js';
import { createStructureMemo } from './structure-memo.js';
import type { ParsedTest, TestConfig, TestInstance } from '../parser/types.js';
import type { TestReport, StepResult, RunSummary } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { aiConfigured, useStepInHookError } from '../config/loader.js';
import { TokenTracker } from '../utils/tokens.js';
import { launchBrowser, closeBrowser, BrowserTracker, resolveVideoMode, finalizeMainPageVideo, type BrowserSession, type CdpLaunchOptions } from '../browser/manager.js';
import { executeStep, executeBranchedStep } from './step-executor.js';
import type { StepExecutorOptions } from './step-executor.js';
import { parseUseAiStep, parseUseStep } from '../parser/use-step.js';
import {
  SkillSurfaceStack,
  computerContextFor,
  defaultLoadDesktopAdapter,
  defaultProbeComputerCapture,
  enterComputerMode,
  ensureComputerLock,
  executeComputerStep,
  guardVisitReadsScreen,
  leaveComputerMode,
  modeStepResult,
  releaseComputerLockAtRunEnd,
  releaseComputerLockForPause,
  restoreCallerSurface,
  skillFrameChain,
  stepReadsScreen,
  undispatchedDirectiveError,
  undispatchedDirectiveResult,
  type SurfaceState,
} from './computer-step.js';
import type { ComputerLockOptions, DesktopAdapter } from '../desktop/index.js';
import type { VisionRouteAi, VisionRouteResult } from '../desktop/vision-route.js';
import { identifyStepGroups } from './step-grouper.js';
import {
  createControlState,
  forEachPassOf,
  guardVisitEvaluates,
  planAfterStep,
  returnExit,
  type ControlRecord,
} from './control-flow.js';
import { boundValue, dottedReferenceError } from './placeholder-substitution.js';
import {
  applyPassBindings,
  evaluateGuard,
  guardCodeBehindFields,
  guardHistoryLines,
  guardResult,
  guardRows,
  type GuardCodeBehind,
  isLoopRecord,
  LoopRuntime,
  skipReasonFor,
  skippedResult,
  SkipQueue,
} from './control-runtime.js';
import { resolveHooks, type ResolvedHooks } from './hooks.js';
import { runInteractiveRepl } from './interactive-repl.js';
import { loadContextFiles } from '../context/loader.js';
import { controlLineDefines } from '../parser/control-line.js';
import {
  bindVariable,
  resolveParameters,
  loadDataFile,
  interpolate,
  warnMultiSegment,
} from '../parser/parameters.js';
import { parseSetStep } from '../parser/set-step.js';
import {
  parseFlowControlStep,
  flowControlInHookError,
  isReturnClaim,
} from '../parser/flow-control-step.js';
import {
  failureTailContradictionError,
  isFailureTailContradiction,
  parseFailureTail,
} from '../parser/failure-tail.js';
import {
  deliberateFailError,
  deliberateFailResult,
  DELIBERATE_FAIL_FALLBACK,
  flowControlExplanation,
  frameExitIndex,
  frameLabel,
  skippedByReturn,
  toleratedHistoryLine,
  toleratedLogLine,
} from './flow-control.js';
import { runSetStep } from './set-step-runner.js';
import { runUseAiStep } from './use-ai-step-runner.js';
import { generateReport, getPrimaryModel, videoBaseNameFor, countStepOrigins } from '../report/generator.js';
import { mergeRowReports, type RowReport } from '../report/merge-rows.js';
import { appendRunHistory } from '../report/history-appender.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { diagnoseFailure } from '../ai/diagnose.js';
import { logger, setLogLevel, getLogLevel, type ConsoleLogLevel } from '../utils/logger.js';
import { openRunLogFile, attachRunLogBridges } from '../utils/run-log.js';
import { ApiResponseStore } from '../api/response-store.js';
import { resolveProjectRoot } from '../server/project-root.js';
import { loadToolCatalogue, ToolCatalogue } from '../tools/registry.js';
import { executeToolStep, type ExecuteToolStepOptions } from '../tools/executor.js';
import type { ToolCall } from '../tools/types.js';
import { buildCodeBehindRegistry, CodeBehindRegistry } from '../codebehind/loader.js';
import { lastRunStaleMemberRow, writeLastRun, type LastRunStep } from '../codebehind/last-run.js';
import { writeRecording } from '../codebehind/recording.js';
import { envDataSecretValues, interpolateEnvData } from '../parser/interpolate-env-data.js';
import { captureScreenshot } from '../browser/screenshot.js';
import {
  maskRecordSecrets,
  redact,
  redactDeep,
  redactReport,
  runSecrets,
  runSecretsWithInputs,
} from '../utils/secrets.js';
import {
  flushRunStats,
  openRunStats,
  projectStatsSwitch,
  recordRunEnd,
  statsEnabledIn,
  type RunStats,
} from './run-stats.js';
import type { StatsSuite } from '../stats/types.js';

/**
 * What the report says in place of a root-cause analysis when the run had no
 * AI to produce one (stories/keyless-replay-and-gateway-env.md §Part B).
 *
 * One line, and no advice: a diagnosis that was never attempted has nothing
 * to suggest, and the failed step already carries the "recompile where AI is
 * available" instruction.
 */
export const KEYLESS_DIAGNOSIS_SKIPPED = 'Diagnosis skipped: AI is not configured.';

/**
 * The same slot, for a run that HAS AI and was told not to use it.
 *
 * Both reasons reach this branch — `keyless` is `no key OR policy off` — but
 * only one of them is about configuration. Telling an operator whose key is
 * present and valid that "AI is not configured" sends them to add a key they
 * already have, or (on Bedrock SigV4) one that would actively break the run by
 * outranking the AWS credential chain. This is the same distinction
 * `aiOffReason` and {@link AI_FORBIDDEN_BY_POLICY_MESSAGE} exist to keep.
 */
export const POLICY_DIAGNOSIS_SKIPPED =
  'Diagnosis skipped: this run was asked to make no AI calls (ai.allowInRuns: false).';

/** Pattern for [input: variable_name] steps that pause for user input */
const INPUT_STEP_PATTERN = /^\[input:\s*(\w+)\]\s*(.*)/;

/** Pattern for [interactive] steps that open a REPL for free-form instructions */
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]\s*(.*)/i;

/** Pattern for [output: variable_name] steps that capture a DOM value into a variable */
const OUTPUT_STEP_PATTERN = /^\[output:\s*(\w+)\]\s*(.*)/i;

/**
 * Check if a step instruction is an input prompt step.
 * Returns the variable name and prompt text if it matches, or null otherwise.
 */
function parseInputStep(instruction: string): { variable: string; promptText: string } | null {
  const match = instruction.match(INPUT_STEP_PATTERN);
  if (!match) return null;
  return { variable: match[1]!, promptText: match[2]?.trim() || `Enter value for "${match[1]}"` };
}

/**
 * Check if a step instruction is an interactive prompt step.
 * Returns the optional hint text if it matches, or null otherwise.
 */
function parseInteractiveStep(instruction: string): { hint: string } | null {
  const match = instruction.match(INTERACTIVE_STEP_PATTERN);
  if (!match) return null;
  return { hint: match[1]?.trim() || '' };
}

/**
 * Check if a step instruction is an output capture step.
 * Returns the variable name and the instruction text (with variable hint appended) if it matches.
 */
function parseOutputStep(instruction: string): { variable: string; enrichedInstruction: string } | null {
  const match = instruction.match(OUTPUT_STEP_PATTERN);
  if (!match) return null;
  const variable = match[1]!;
  const text = match[2]?.trim() || `Capture value into "${variable}"`;
  return {
    variable,
    enrichedInstruction: `${text} [store as: ${variable}]`,
  };
}

/**
 * Captured `as` names from a step's own successful read/count actions,
 * surfaced in the report the same way the server path does (issues
 * 042/043). Deliberately NOT special-cased for `[output: X]` — its enriched
 * instruction (`parseOutputStep`) cues the AI toward `as: <variable>`, so a
 * successful capture is already covered here; a failed one correctly stays
 * out rather than risking a stale value from an earlier step under the same
 * name. Restricted to read/count with no error (the only actions that write
 * `as` into resolvedParameters — see step-executor.ts) and never
 * `__skill*`-namespaced (skill-internal names must never reach the report).
 * Call at every `stepResults.push` site that carries real turns — a hook
 * step, a resumed-from-interactive step, or a normal step — so the report
 * doesn't depend on which branch produced the result.
 */
function computeStepCaptures(
  result: StepResult,
  resolvedParameters: Record<string, string>,
): Record<string, string> | undefined {
  const captures = result.turns
    .flatMap((t) => t.subActions)
    .filter((sa) => !sa.error && (sa.action.action === 'read' || sa.action.action === 'count'
      // A structured table read writes its `as` too (SPEC-structured-table-reads.md §9.3).
      || sa.action.action === 'readTable'))
    .map((sa) => sa.action.as)
    .filter((name): name is string => !!name && !name.startsWith('__skill'))
    .reduce<Record<string, string>>((acc, name) => {
      // `hasOwn`, not `in`: `in` walks the prototype chain, so a step with
      // `[store as: constructor]` whose read found nothing still reported a
      // capture — of the `Object` function, into a `Record<string, string>`.
      if (Object.hasOwn(resolvedParameters, name)) {
        acc[name] = resolvedParameters[name]!;
      }
      return acc;
    }, {});
  return Object.keys(captures).length > 0 ? captures : undefined;
}

/** Prompt the user for a value during test execution */
async function promptUserForInput(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n🔑 User input required:`);
    const answer = await rl.question(`  ${promptText}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Read `cdp:` and `cdpTab:` from a test's `## Config` block. Returns
 * `undefined` (the launchBrowser default) when CDP is not requested. Throws
 * with a clear error if the port value is malformed — better to fail fast
 * here than after the browser has been touched.
 */
function parseCdpOptionsFromTestConfig(testConfig: TestConfig): CdpLaunchOptions | undefined {
  const raw = testConfig.cdp?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid '## Config: cdp: ${raw}' — expected a TCP port number ` +
      `(e.g. \`cdp: 9222\` to attach to Chrome started with --remote-debugging-port=9222).`,
    );
  }
  const tab = testConfig.cdpTab?.trim();
  return tab ? { port, tab } : { port };
}

/**
 * Read `viewport:` from a test's `## Config` block
 * (stories/per-test-viewport.md §6). Returns `undefined` when the key is
 * absent, in which case the launch behaves byte-for-byte as it did before this
 * feature existed (§2) — including honouring a project-wide
 * `browser.fixedViewport` pin (§8), which lives on the config this does not
 * touch.
 *
 * Modelled on `parseCdpOptionsFromTestConfig` above, and called next to it, for
 * the same reason: both turn a `## Config` string into launch input, and both
 * must fail before the browser is touched rather than after.
 *
 * `viewport:` + `cdp:` in one file is refused here (§1) — this is the layer that
 * validates the value, and it is the layer that knows both keys. Refused rather
 * than ignored: the test was authored around a size we cannot impose on the
 * user's own Chrome, so running it anyway would report a pass for a layout
 * nobody asked to see.
 */
function parseViewportFromTestConfig(testConfig: TestConfig): ViewportSize | undefined {
  const size = resolveViewportSpec(testConfig.viewport);
  if (!size) return undefined;
  const cdpRaw = testConfig.cdp?.trim();
  if (cdpRaw) {
    throw new Error(viewportCdpConflictError(testConfig.viewport!.trim(), cdpRaw));
  }
  return size;
}

/**
 * The code-behind knobs `steptix compile` needs from a run, and nothing else.
 *
 * Kept off the positional parameters so ordinary callers are unaffected, and
 * shaped for the compiler rather than for users: none of these has a config
 * key or a CLI flag on the `run` path.
 */
export interface RunTestExtras {
  /**
   * Load these code-behind files from somewhere else: canonical `.steps.ts`
   * path → the path to import instead. Compile's replay points the loader at
   * its candidate; the real file is untouched.
   */
  codeBehindCandidates?: Record<string, string>;
  /**
   * Ignore every code-behind entry, so all steps run under AI.
   *
   * Compile's Record phase needs this: a step served by its existing entry
   * produces no transcript, and generation would then have nothing to work
   * from — which is how "recompile step 3" turned into "step 3 performed no
   * page actions".
   */
  codeBehindDisabled?: boolean;
  /** An entry that throws fails the step instead of healing under AI. */
  codeBehindStrict?: boolean;
  /** Capture DOM + URL either side of every step (compile's Record input). */
  captureStepContext?: boolean;
  /**
   * Run only the first N steps, then finish as a passed run.
   *
   * A prefix compile (stories/codebehind-compile-as-a-run.md §Write what
   * passed) replays the steps it compiled and not the ones the recording never
   * reached — which would run under AI, cost tokens, and fail where the
   * recording did. Hooks still run; the report's `totalSteps` is still the
   * test's, so the compiler indexes it as it would any run.
   */
  stopAfterStep?: number;
  /**
   * Ignore `ai.allowInRuns: false` for this run.
   *
   * A compile is a request *for* AI, not a run the switch should gate
   * (stories/run-settings.md §9) — the whole point of it is to spend tokens
   * once so later runs spend none. The server has always said so via
   * `bypassAiPolicy` (src/server/session-manager.ts, src/server/errand-runner.ts);
   * this is the same escape hatch on the in-process path, which `steptix compile`
   * takes.
   *
   * Set by {@link createTestFileRunner} and nothing else. It is not a config
   * key or a CLI flag, and deliberately not reachable from a test file: it
   * exists so the one caller that IS the request for AI can say so.
   */
  bypassAiPolicy?: boolean;
  /** Abort signal, threaded into every step. */
  signal?: AbortSignal;
  /**
   * How `[use computer]` gets its adapter (SPEC-use-computer.md §5.1 item 2).
   *
   * The seam exists so a unit test can drive the whole mode state machine with
   * `FakeDesktopAdapter` and never import nut.js — which is the same reason
   * the real load is lazy: a machine with no prebuilt binary must still run
   * every browser test. Defaults to `loadNutAdapter`.
   */
  loadDesktopAdapter?: () => Promise<DesktopAdapter>;
  /** §5.1 item 4 — the one capture probe. Defaults to `probeComputerCapture`. */
  probeComputerCapture?: (adapter: DesktopAdapter) => Promise<void>;
  /** §5.9 — where the machine-wide computer lock lives. Overridden by tests so
   *  they never touch the real one in `os.tmpdir()`. */
  computerLock?: ComputerLockOptions;
  /** §5.1 item 1b / §15.4 — the vision-route check. Overridden by tests so
   *  they never reach the network. Defaults to `checkVisionRoute`. */
  checkVisionRoute?: (ai: VisionRouteAi) => Promise<VisionRouteResult>;
  /**
   * The scoreboard run this call is one row of (docs/specs/SPEC-scoreboard.md
   * §8.1). `runTests` opens one per TEST — its rows are one run with one
   * report — and writes the run line where it writes that report. Absent, this
   * call is a run of its own: it opens the context and writes the run line
   * itself, with no report (a compile's record and replay runs).
   */
  stats?: RunStats;
  /** The suite a run this call opens records under, over `STEPTIX_STATS_SUITE`:
   *  `compile` for a compile's runs (§5.6). Ignored when `stats` is given. */
  statsSuite?: StatsSuite;
}

/**
 * Run a single test instance (ParsedTest with resolved parameters).
 * Handles browser lifecycle, step execution, and report generation.
 */
export async function runTest(
  instance: TestInstance,
  config: Config,
  contextContent: string,
  extras: RunTestExtras = {},
): Promise<TestReport> {
  const { test, resolvedParameters, dataRowIndex } = instance;
  const startTime = Date.now();

  logger.testStart(
    dataRowIndex !== undefined
      ? `${test.title} (row ${dataRowIndex + 1})`
      : test.title,
  );

  const tokenTracker = new TokenTracker();
  const aiClient = new AiClient(config.ai, tokenTracker);
  const apiResponseStore = new ApiResponseStore();
  /**
   * May this run use AI at all? The CLI resolves no run settings, so
   * `runSettings.ai` never reaches here — but `ai.allowInRuns` is a project
   * setting in `steptix.config.json`, and until now the CLI ignored it outright.
   *
   * That was survivable only while a blank `AI_API_KEY=` was a working
   * substitute. For a project whose provider self-authenticates there is no key
   * to blank (stories/bedrock-provider.md §"The CLI keyless gap"), which would
   * leave a CI user with no way to force a no-AI run in exactly the setup this
   * is for. Honouring it here also retires the CLI/server split, so the same
   * `steptix.config.json` means the same thing on both paths.
   *
   * `bypassAiPolicy` is the one exception, and it is not a hole in the switch:
   * a compile is a request FOR AI (stories/run-settings.md §9), so gating it
   * would mean `steptix compile` produced nothing on the very projects that set
   * `allowInRuns: false` in order to have something to replay. The server
   * already carved out exactly this; the flag is how the in-process path says
   * the same thing.
   */
  const aiAllowed = config.ai.allowInRuns !== false || extras.bypassAiPolicy === true;
  // Lowered for the same reason the server lowers it: with a key present,
  // `AiNotConfiguredError`'s advice ("set AI_API_KEY") would be a false
  // statement about a correct config. Set once — the CLI has no per-batch
  // settings to re-resolve.
  aiClient.setAiPolicy(aiAllowed);
  /**
   * This run has no AI at all (stories/keyless-replay-and-gateway-env.md
   * §Part B), either for want of a key or because the project forbids it. On
   * the CLI path `config.ai` IS the fully resolved config — env, project
   * `.env`, config file and machine floor have all applied by the time
   * `runTest` is called — so it is the right thing to read here. The server
   * path resolves its own and passes the answer into `executeStep` itself.
   *
   * Two things change: a broken code-behind entry fails instead of healing,
   * and the post-failure diagnosis pass is skipped. Both are decided BEFORE
   * calling AI, so the report states an intention rather than reporting a
   * caught auth error.
   */
  const keyless = !aiConfigured(config.ai) || !aiAllowed;

  const baseUrl = test.config.baseUrl;
  const conversationHistory: string[] = [];
  const csrfTokens: Record<string, string> = {};

  const projectRoot = await resolveProjectRoot(test.filePath);

  // What this run learns about a region's structure, once
  // (SPEC-structured-table-reads.md §7.10, src/runner/structure-memo.ts). One
  // per `runTest`, which is one per DATA ROW — the memo is validated against
  // the live page on every reuse, but a row that navigates somewhere else
  // should not start out holding the previous row's answers.
  const structureMemo = createStructureMemo();

  // Where a file named in an "Upload file ..." step lives: beside the test that
  // names it, fenced by the project root (stories/upload-action.md §3). The CLI
  // always has both, so an upload step works from a plain `steptix run`.
  const uploadPaths = { baseDir: path.dirname(test.filePath), projectRoot };

  // Determine timeout: frontmatter > config section > global default
  const testTimeout = parseTimeoutMs(test.frontmatter.timeout ?? test.config.timeout)
    ?? config.execution.timeout;

  const hooks = await resolveHooks(test, config);

  // Per-test logging overrides from the test's `## Config` block. The block
  // can carry `consoleLogLevel:` and `serverFileLogLevel:` keys; either falls
  // back to the global `config.logging.*` when absent or invalid. Validated
  // against the same allow-lists the CLI / server use elsewhere.
  const VALID_LEVELS: readonly ConsoleLogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
  const VALID_FILES: readonly Config['logging']['serverFileLogLevel'][] = ['off', 'compact', 'full'];
  const testLevel = test.config.consoleLogLevel?.trim();
  const testFile = test.config.serverFileLogLevel?.trim();
  const effectiveLevel: ConsoleLogLevel =
    (testLevel && VALID_LEVELS.includes(testLevel as ConsoleLogLevel))
      ? (testLevel as ConsoleLogLevel)
      : config.logging.consoleLogLevel;
  const fileMode: Config['logging']['serverFileLogLevel'] =
    (testFile && VALID_FILES.includes(testFile as Config['logging']['serverFileLogLevel']))
      ? (testFile as Config['logging']['serverFileLogLevel'])
      : config.logging.serverFileLogLevel;
  if (testLevel && !VALID_LEVELS.includes(testLevel as ConsoleLogLevel)) {
    logger.warn(`Ignoring invalid '## Config: consoleLogLevel: ${testLevel}' — expected one of: ${VALID_LEVELS.join(', ')}`);
  }
  if (testFile && !VALID_FILES.includes(testFile as Config['logging']['serverFileLogLevel'])) {
    logger.warn(`Ignoring invalid '## Config: serverFileLogLevel: ${testFile}' — expected one of: ${VALID_FILES.join(', ')}`);
  }
  const previousLevel = getLogLevel();
  setLogLevel(effectiveLevel);

  // Per-run log file. Mirrors the server-side path (SessionManager) so a
  // direct CLI run leaves the same forensic trail under `<reportsDir>/logs/`.
  // failures to open are swallowed and never break the run.
  const runLog = fileMode === 'off'
    ? null
    // The run log stays one file per row: it is written as the row runs, so
    // there is no merge point for a stream the way there is for a report.
    : openRunLogFile(
        dataRowIndex === undefined ? test.title : `${test.title} (row ${dataRowIndex + 1})`,
        config.reports.outputDir,
      );
  if (runLog) {
    runLog.stream.write(
      `# test=${test.title} startedAt=${new Date().toISOString()} steps=${test.steps.length} mode=${fileMode}\n`,
    );
    logger.info(`Run log: ${runLog.path}`);
  }
  // What this run must never print (stories/secret-redaction.md): the values
  // of its secret-named parameters and of the env/data secrets its `${…}`
  // references resolved against. Read fresh each time — captures add to it.
  //
  // And the skill arguments and looped-section rows the expander wrote into
  // step TEXT, which are in no variable map: without them a `password` column
  // printed in clear on the step line, in the report, and — in a `[use ai]`
  // step — in what the model was sent (issue 060). The session loop has held
  // them since data-driven rows; the CLI never did. Pooled per frame, not
  // merged into one map (`runSecretsWithInputs` says why).
  const frameInputs = Object.values(test.expansion?.frames ?? {}).flatMap((frame) =>
    frame.inputs ? [frame.inputs] : [],
  );
  const secretsNow = (): string[] =>
    runSecretsWithInputs({ parameters: resolvedParameters, envData: test.envData }, frameInputs);
  // `## Config: unmask: keyword, data.keys.public` — names this test declares
  // are not secrets, despite `isSecretName` matching them
  // (stories/placeholder-preserving-actions.md, decision 2). Read only by the
  // prompt's `## Values` block: `secretsNow` above is untouched, so the report,
  // the run log and the recording still mask everything they did before.
  const unmaskNames: ReadonlySet<string> = new Set(
    (test.config.unmask ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  /** The executor options every call site shares for this feature. */
  const placeholderOpts = unmaskNames.size > 0 ? { unmask: unmaskNames } : {};
  // Who is running, for the scoreboard (docs/specs/SPEC-scoreboard.md §7). The
  // caller's run when `runTests` opened one for the whole test; otherwise this
  // call is a run of its own and writes its own run line below. `config` is
  // the config this run uses, so its `stats.enabled` is the project switch.
  const ownsStats = extras.stats === undefined;
  const runStats: RunStats =
    extras.stats ??
    openRunStats({
      projectRoot,
      testFilePath: test.filePath,
      projectEnabled: statsEnabledIn(config),
      ...(extras.statsSuite !== undefined && { suite: extras.statsSuite }),
      ...(dataRowIndex !== undefined && { row: dataRowIndex + 1 }),
    });
  /** What each step's options carry: the run, masked with the secrets as they
   *  are now — the executor adds what the step itself captures. */
  const statsFor = (): RunStats =>
    runStats.enabled ? { ...runStats, maskValues: secretsNow() } : runStats;
  const removeFileBridges = runLog
    ? attachRunLogBridges(runLog, fileMode, secretsNow)
    : () => {};

  const cdpOptions = parseCdpOptionsFromTestConfig(test.config);
  // Per-test viewport (stories/per-test-viewport.md §6). Resolved before the
  // launch — an invalid value or a `cdp:` conflict throws here, with no browser
  // to clean up.
  const fixedViewport = parseViewportFromTestConfig(test.config);
  if (fixedViewport) {
    // REBINDING THE PARAMETER, deliberately. `config` is threaded into
    // `executeStep` at six call sites below and into the `openBrowser`
    // relaunch through `config.browser` (step-executor.ts) — which is exactly
    // how §2's "every browser the test opens inherits it" comes for free.
    // Introducing a second name would work only until someone adds a seventh
    // call site with the old one; this way there is no old one left to pass.
    //
    // A fresh object, never a mutation: `runTest` is called once per data row
    // with the SAME `config` the caller holds, so writing through would leak
    // one row's viewport into the next test and into the caller's config.
    config = { ...config, browser: { ...config.browser, fixedViewport } };
  }
  // `## Config: tableStructure: strict` over the project's `tables.structure`
  // (SPEC-structured-table-reads.md §7.10). Rebinding `config` for the same
  // reason the viewport above does: `executeStep` is handed this object at six
  // call sites, and the switch has to reach every one of them. A fresh object,
  // never a mutation — one data row's choice must not leak into the next.
  config = withTableStructure(config, test.config.tableStructure);
  // Video recording (Tier 1 — main page only). Resolve the mode once and pass
  // the absolute videos/ dir so launchBrowser attaches recordVideo on the
  // non-CDP path; the .webm is finalised + named in the `finally` below.
  const videoMode = resolveVideoMode(config.browser.video);
  const videoDir = path.resolve(config.reports.outputDir, 'videos');
  /**
   * The surface the next step runs on (SPEC-use-computer.md §4.5), the CLI's
   * copy of the session's. `browser` until a `[use computer]` step lands; the
   * launch gate below reads it, and so does the step dispatch.
   *
   * An OBJECT rather than a `let`, because `enterComputerMode` /
   * `leaveComputerMode` own the transitions for both runners and need
   * somewhere to write. One state machine, two run loops.
   */
  const surfaceState: SurfaceState = { surface: 'browser' };
  /**
   * Who holds the machine-wide computer lock for this run (§5.9).
   *
   * The CLI has no session id, so the test's own FILE PATH is the identity —
   * stable across the run, unique per test, and the thing a human reading
   * `steptix-computer.lock` would want to see. `title` is the fallback for a test
   * parsed from a string with no file behind it.
   */
  const computerLockId = `cli:${test.filePath || test.title}`;
  /** §4.5 — a skill call restores the caller's surface on return; an inline
   *  section does not. */
  const skillSurfaces = new SkillSurfaceStack();
  /**
   * `[use computer]` for this run, with everything §5.1 reads — written once,
   * because a `[use computer]` step and a skill returning to a computer-surface
   * caller are the same entry (§4.5).
   */
  const enterComputerSurface = () =>
    enterComputerMode({
      lockId: computerLockId,
      // The CLI's `config` IS the project's — it was loaded from the test
      // file's own root — so the section comes straight off it.
      desktop: config.desktop,
      state: surfaceState,
      loadDesktopAdapter: extras.loadDesktopAdapter ?? defaultLoadDesktopAdapter,
      probeCapture: extras.probeComputerCapture ?? defaultProbeComputerCapture,
      ...(extras.computerLock && { lock: extras.computerLock }),
      // §15.4 — `config.ai` is the very object this run's `aiClient` was built
      // from and holds by reference; the CLI resolves no run settings and
      // never re-points the client, so it is the route every computer-mode
      // request goes out on. Keyless skips the check.
      ai: keyless ? undefined : config.ai,
      ...(extras.checkVisionRoute && { checkVisionRoute: extras.checkVisionRoute }),
    });
  /** Put the caller back on its surface on return from a skill: `[use
   *  browser]`'s transition, or `[use computer]`'s through
   *  {@link enterComputerSurface}, which can fail (`restoreCallerSurface`). */
  const restoreSurface = (to: 'browser' | 'computer') =>
    restoreCallerSurface(to, surfaceState, computerLockId, extras.computerLock, enterComputerSurface);
  /**
   * The run is about to wait for a person (§5.9): give the lock back first. A
   * no-op off the computer surface, or before the run's first computer step.
   * The step boundary in the loop below takes it back.
   */
  const releaseLockForPause = (why: string): void =>
    releaseComputerLockForPause(surfaceState, computerLockId, extras.computerLock, why);
  /**
   * The initial browser, once it exists. `undefined` before the first
   * browser-surface step — the teardown below reads it and must tolerate a run
   * that never launched one (a desktop-only test, or a test that timed out at
   * step 0).
   */
  let initialSession: BrowserSession | undefined;
  // THE LAUNCH IS DEFERRED (§4.6): the browser opens at the first step that
  // runs while `surface` is `browser`, not here. Base-URL navigation moved
  // into the closure with it — it needs a page, and a `goto` rejection must
  // close the browser it just opened rather than leak the window past the
  // `finally`, which cannot see a session the tracker never registered.
  const browserTracker = BrowserTracker.deferred(async () => {
    const launched = await launchBrowser(config.browser, cdpOptions, {
      videoDir,
      // §4's provenance half. Present whenever a size is in effect, so a
      // project-wide pin (§8) is named as such rather than looking like the
      // test's own choice.
      ...(config.browser.fixedViewport
        ? { viewportSource: describeViewportSource(test.config.viewport) }
        : {}),
    });
    try {
      if (baseUrl) {
        logger.info(`Navigating to base URL: ${baseUrl}`);
        await launched.page.goto(baseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }
    } catch (err) {
      try {
        await closeBrowser(launched);
      } catch {
        // Best-effort; the original error is the one worth reporting.
      }
      throw err;
    }
    initialSession = launched;
    return launched;
  });
  // `session` is a *snapshot* of the current active browser — re-read from
  // the tracker before/after each step so openBrowser/switchBrowser actions
  // can transparently shift which browser subsequent steps target.
  //
  // Definitely-assigned rather than optional: `ensureBrowser()` below fills it
  // before anything reads it, and every one of the ~30 `session.page` reads in
  // this function sits downstream of a call to it. Making it `| undefined`
  // would put a `!` on all thirty and say nothing the comment does not.
  let session!: BrowserSession;
  /**
   * Open the browser if this run has not yet, and refresh the `session`
   * snapshot. The ONE place this runner launches one.
   *
   * Called at the top of each step (when the surface is `browser`) and at the
   * top of a hook scope — a hook runs on the page surface by definition
   * (§4.4), so a `before` hook is a page step for this purpose even though it
   * is not in the step list.
   */
  const ensureBrowser = async (): Promise<BrowserSession> => {
    session = await browserTracker.ensureLaunched();
    return session;
  };

  // Load the tool catalogue once per test. Node caches dynamic imports so
  // subsequent loads are cheap; failures are surfaced as a fatal startup
  // error so a misconfigured tools/ dir doesn't silently degrade tool calls
  // into "tool not found" runtime errors.
  let toolCatalogue: ToolCatalogue;
  try {
    const toolsDir = path.resolve(process.cwd(), config.tests.toolsDir);
    toolCatalogue = await loadToolCatalogue(toolsDir);
  } catch (err) {
    logger.error(`Failed to load tool catalogue: ${(err as Error).message}`);
    throw err;
  }

  // Code-behind: resolve each expanded step to its `.steps.ts` entry once, up
  // front, and carry the result into the executor like `structureMemo`. A missing
  // or broken file is a warning and an empty registry — the test then runs
  // exactly as it did before this feature existed.
  const codeBehind =
    extras.codeBehindDisabled || !test.expansion
      ? CodeBehindRegistry.empty()
      : await buildCodeBehindRegistry(
          {
            steps: test.steps,
            rawSteps: test.expansion.rawSteps,
            origins: test.expansion.origins,
            frames: test.expansion.frames,
          },
          {
            testFilePath: test.filePath,
            ...(extras.codeBehindCandidates && { candidateFiles: extras.codeBehindCandidates }),
          },
        );
  // A strict run — a compile's replay — exists to find out whether the code
  // works on its own. A file that did not load has no code to run, so the
  // answer is "no", not "every step passed under AI".
  const strictLoadError =
    extras.codeBehindStrict && codeBehind.loadErrors.length > 0
      ? `code-behind file ${codeBehind.loadErrors[0]!.file} could not be loaded: ${codeBehind.loadErrors[0]!.error}`
      : undefined;
  /** Per-expanded-step facts for the last-run sidecar, filled as steps run.
   *  Not written when this run deliberately bypassed code-behind: a compile's
   *  Record would otherwise stamp "0 code-behind, all AI" over the real run's
   *  findings, including the stale flags the compile is acting on. */
  const lastRunSteps: LastRunStep[] = [];
  const keepLastRun = !extras.codeBehindDisabled && !extras.codeBehindCandidates;

  /**
   * What the steps that healed under AI cost in tokens
   * (stories/codebehind-selector-ambiguity.md §"A healed run stops reporting
   * as a clean pass") — the price the author pays again on every run until
   * the entries are repaired, which is the figure the report's banner names.
   *
   * There is no per-step token field to read: `TokenTracker` accumulates a
   * run-wide total, so attribution is the total's delta across the step.
   * Steps run one at a time, so between the two reads the only AI calls are
   * that step's.
   */
  let healedTokens = 0;
  let tokensAtStepStart = 0;

  // Hoisted so the `finally` can read the run outcome + mutate the report after
  // the browser is closed (to attach `videoRelPath`). `report` is assigned the
  // SAME object that's returned, so the in-`finally` mutation is visible to the
  // `return report` in the `try` (try/return/finally same-object semantics).
  let report: TestReport | undefined;
  let overallStatus: 'passed' | 'failed' = 'failed';

  try {
    // (Base-URL navigation lives in the deferred launcher above — it needs a
    // page, and there is none until the first browser-surface step.)

    const stepResults: StepResult[] = [];
    let timeoutDeadline = Date.now() + testTimeout;
    let bail = false;
    let humanIntervened = false;
    /**
     * The run ran out of time.
     *
     * An explicit flag, set where the timeout `break` is, replacing the old
     * inference `stepResults.length < stepLimit` — which was already loose
     * (hook results inflate that array) and became WRONG once a return could
     * legitimately leave steps unrun (stories/step-flow-control.md, decision
     * 15). A main-flow return must read as a pass with N skipped, never as a
     * timeout. A chain or loop guard that skipped its untaken half
     * (stories/control-flow.md) leaves the same shape behind, and must read
     * the same way.
     */
    let timedOut = false;
    /** The run was stopped by its `extras.signal` rather than finishing. Set
     *  by the guard's abort catch below, by a step that comes back
     *  `interrupted` (the executors' answer to a Stop mid-step), and once more
     *  before the report for any interrupted row a hook scope left
     *  (issues/020). */
    let aborted = false;

    /**
     * The code-behind slice of `StepExecutorOptions` for expanded step `i`.
     * Spread rather than assigned so a step with no binding adds no key —
     * `exactOptionalPropertyTypes` refuses an explicit `undefined`.
     */
    const codeBehindOptionsFor = (
      i: number,
    ): Pick<
      StepExecutorOptions,
      | 'codeBehind'
      | 'codeBehindStrict'
      | 'keyless'
      | 'keylessReason'
      | 'captureStepContext'
      | 'signal'
      | 'envData'
    > => {
      const binding = codeBehind.bindingFor(i);
      return {
        ...(binding && { codeBehind: binding }),
        // The context the parser resolved `${data.url}` with, so the entry's
        // `step.getVar('data.url')` reads the same value.
        ...(test.envData && { envData: test.envData }),
        ...(extras.codeBehindStrict !== undefined && { codeBehindStrict: extras.codeBehindStrict }),
        // Only when true: absent is "not keyless", so a keyed run's options
        // are byte-for-byte what they were before this feature existed.
        ...(keyless && { keyless: true }),
        // Which explanation the skipped step carries. Policy first when both
        // hold, matching the server: a key IS present on the policy path, so
        // "no key" would send the reader to fix a line that is correct. Absent
        // means 'no-key', so nothing changes for a run that simply has none.
        // Not also gated on `keyless` — a forbidden run is keyless by
        // construction, so the extra clause could only ever be true.
        ...(!aiAllowed && { keylessReason: 'policy' as const }),
        ...(extras.captureStepContext !== undefined && {
          captureStepContext: extras.captureStepContext,
        }),
        ...(extras.signal && { signal: extras.signal }),
      };
    };

    /**
     * The code-behind a guard's condition is decided with
     * (stories/codebehind-loops-and-conditions.md, "The run loops") — the same
     * registry, strict flag and keyless flags `codeBehindOptionsFor` hands the
     * steps.
     *
     * When this run bypasses code-behind (a compile's Record) no entry may
     * decide, so the guard gets a registry that binds nothing — and still gets
     * `captureEvidence`, because a Record is exactly the run whose judge's
     * page a condition entry is generated from (decision 9). With neither,
     * nothing is passed and every guard is on today's path.
     */
    const guardCodeBehind: GuardCodeBehind | undefined = extras.codeBehindDisabled
      ? extras.captureStepContext
        ? { bindingFor: () => undefined, captureEvidence: true }
        : undefined
      : {
          bindingFor: (k) => codeBehind.bindingFor(k),
          ...(extras.codeBehindStrict && { strict: true }),
          ...(keyless && { keyless: true }),
          ...(!aiAllowed && { keylessReason: 'policy' as const }),
          // A compiling run keeps the page the judge decided on, the way it
          // keeps each step's DOM (`captureStepContext`).
          ...(extras.captureStepContext && { captureEvidence: true }),
        };

    /**
     * Record one expanded step's outcome for the last-run sidecar.
     *
     * Called at the single point every non-hook step result passes through, so
     * the sidecar describes the run whichever branch produced the step.
     */
    const recordLastRun = (i: number, result: StepResult): void => {
      const binding = codeBehind.bindingFor(i);
      const stale = result.codeBehindStale;
      // The AI turn this step needed only because its entry threw.
      if (stale) healedTokens += Math.max(0, tokenTracker.total - tokensAtStepStart);
      // A keyless run's broken entry: failed rather than healed, so it is
      // deliberately not `codeBehindStale` in the result — but the sidecar
      // exists to tell the next compile which entries need regenerating, and
      // this one does. Recorded stale here and nowhere else, so the run's own
      // heal accounting stays at zero
      // (stories/keyless-replay-and-gateway-env.md §Part B).
      const healSkipped = stale ? undefined : result.codeBehindHealSkipped;
      const failure = stale ?? healSkipped;
      // A guard row whose broken entry is ANOTHER member's
      // (stories/codebehind-loops-and-conditions.md, "The run loops"): the row
      // belongs to the member that held, the failure to the one whose code
      // threw. The failure gets a row of its own, keyed to that member's
      // binding, so `--only-stale` and the repair find the right entry — and
      // this row stays clean, because its own entry did nothing wrong.
      const member = staleMemberRow(i, result, failure, healSkipped !== undefined);
      if (member && member.index < i + 1) lastRunSteps.push(member);
      const ownFailure = member ? undefined : failure;
      lastRunSteps.push({
        index: i + 1,
        source: binding?.source ?? test.expansion?.rawSteps[i] ?? test.steps[i] ?? '',
        ...(binding?.section !== undefined && { section: binding.section }),
        // The entry's target file, so a later repair cannot conflate a
        // skill-body step with an identically-worded test step. The sidecar is
        // rewritten wholesale, so omitting it here would make every row unfiled
        // after a CLI run and silently restore the conflation.
        ...(binding?.file !== undefined && { file: binding.file }),
        // Which of the identically-worded steps of this frame instance it is,
        // so a repair finds its row without counting — a looped body's rows
        // are iteration-major. Both writers or neither, for the reason the
        // `file` above gives: the sidecar is rewritten wholesale.
        ...(binding?.occurrence !== undefined && { occurrence: binding.occurrence }),
        status: result.status,
        fromCodeBehind: result.fromCodeBehind === true,
        stale: ownFailure !== undefined,
        ...(ownFailure && { error: ownFailure.error }),
        ...(ownFailure && healSkipped && { healSkipped: true }),
      });
      if (member && member.index > i + 1) lastRunSteps.push(member);
    };

    /**
     * The sidecar row for a guard's stale MEMBER, when it is not the row's own
     * line — or undefined. Shared shape with the server's writer
     * (`lastRunStaleMemberRow`).
     */
    const staleMemberRow = (
      i: number,
      result: StepResult,
      failure: { error: string } | undefined,
      healSkipped: boolean,
    ): LastRunStep | undefined => {
      const at = result.guard?.staleMember;
      if (failure === undefined || at === undefined || at === i) return undefined;
      return lastRunStaleMemberRow({
        index: at,
        binding: codeBehind.bindingFor(at),
        fallbackSource: test.expansion?.rawSteps[at] ?? test.steps[at] ?? '',
        status: result.status,
        error: failure.error,
        healSkipped,
      });
    };

    /**
     * Run a `[tool: ...]` invocation and shape the outcome as a StepResult.
     * Used for tool-step dispatch in both the main step loop and inside
     * hook scopes so the dispatch path is identical everywhere.
     */
    const runToolStep = async (
      call: ToolCall,
      instruction: string,
      stepIndex: number,
    ): Promise<StepResult> => {
      const startedAt = Date.now();
      // `session` is still unset on a computer-first run that has opened no
      // browser (SPEC-use-computer.md §4.6), and a `[tool:]` step is dispatched
      // on either surface. Read it the way the server's dispatch does, with
      // `?.`: a tool that never touches the page then works, an unknown name
      // fails with the catalogue's own message, and a tool that does need the
      // page gets `undefined` and says so — instead of this line throwing a
      // TypeError that ended the whole run.
      const live = session as BrowserSession | undefined;
      const outcome = await executeToolStep(call, {
        page: live?.pageTracker.getActive() as ExecuteToolStepOptions['page'],
        context: live?.context as ExecuteToolStepOptions['context'],
        browser: live?.browser as ExecuteToolStepOptions['browser'],
        resolvedParameters,
        catalogue: toolCatalogue,
        ...(baseUrl !== undefined && { baseUrl }),
      });
      const passed = outcome.status === 'passed';
      if (passed) {
        logger.success(`[tool: ${call.name}] passed in ${outcome.durationMs}ms`);
      } else {
        logger.error(`[tool: ${call.name}] failed: ${outcome.error ?? 'unknown error'}`);
      }
      return {
        index: stepIndex,
        instruction,
        status: passed ? 'passed' : 'failed',
        turns: [],
        durationMs: Date.now() - startedAt,
        retried: false,
        ...(outcome.error !== undefined && { error: outcome.error }),
        aiExplanation: passed
          ? `Tool "${call.name}" produced outputs: ${
              Object.keys(outcome.outputs).length
                ? Object.entries(outcome.outputs)
                    .map(([k, v]) => `${k}="${v}"`)
                    .join(', ')
                : '(none)'
            }`
          : `Tool "${call.name}" failed`,
        toolStep: {
          name: outcome.toolName,
          args: outcome.args,
          outputs: outcome.outputs,
          logs: outcome.logs,
        },
      };
    };

    /** Execute every hook instruction in a scope. Returns true on first failure. */
    const runHookScope = async (
      scope: 'before' | 'beforeEach' | 'afterEach' | 'after',
      instructions: string[],
      toolCalls: (ToolCall | null)[],
      sourceSkills: (string | null)[],
      hookIndex: number,
    ): Promise<{ failed: boolean; error?: string }> => {
      // A hook runs on the PAGE surface by definition (SPEC-use-computer.md
      // §4.4 refuses `[use computer]` in a hook), and `before` hooks run ahead
      // of step 1 — so a run with hooks opens its browser here rather than at
      // the first step. One `await` for a scope, not per hook line:
      // `ensureLaunched` is idempotent, but saying it once is what makes the
      // launch point readable.
      if (instructions.length > 0) await ensureBrowser();
      for (let idx = 0; idx < instructions.length; idx++) {
        const raw = instructions[idx]!;
        const toolCall = toolCalls[idx] ?? null;
        const sourceSkill = sourceSkills[idx] ?? null;
        // Same authored-line rule as the main flow, and `test.envData` below
        // is load-bearing rather than defensive: `applyEnvDataInterpolation`
        // now SKIPS a hook `Set` (a non-Set hook is still baked, having
        // nothing to preserve), so the template can still carry `${…}` and
        // `resolveSetTemplate` is what resolves it. This comment used to say
        // the opposite — that hooks were always baked, so the context was
        // redundant — which would have led anyone trimming it to reinstate a
        // silent failure (stories/variable-assignment.md).
        const hookSetStep = parseSetStep(raw);
        // `[use ai]` as a hook line (stories/use-ai-step.md, verification rule
        // 7): authored text, like `Set` — its runner fills and masks the
        // placeholders itself, and `applyEnvDataInterpolation` leaves its
        // `${…}` intact for the same reason.
        const hookUseAiStep = hookSetStep ? null : parseUseAiStep(raw);
        const hookInstruction =
          hookSetStep || hookUseAiStep ? raw : interpolate(raw, resolvedParameters);

        // A hook line's claim, read off the same text the refusal names. Split out
        // of the `if` below because three things read it: the refusal, the
        // unconditional `Fail` dispatch, and the CONDITIONAL `fail` hook's claim.
        const hookClaim = hookUseAiStep ? null : parseFlowControlStep(hookInstruction);
        // A hook's own `… otherwise …` tail. A hook step is a prose step like
        // any other (stories/step-failure-outcomes.md, decision 7), so it takes
        // one — except where the line is a claim or an assignment, which have
        // grammars of their own (decision 12).
        const hookFailureTail =
          hookSetStep || hookClaim || toolCall ? null : parseFailureTail(hookInstruction);
        let result: StepResult;
        // A hook may not RETURN (stories/step-flow-control.md, decision 8), and
        // since stories/step-failure-outcomes.md decision 7 it may `fail`: a hook
        // can already fail the run, so the verb adds a message, not a power.
        // `isReturnClaim` is the one predicate the three refusal sites share.
        //
        // `## Hooks` and project `defaultHooks` are both refused earlier, at
        // parse and at config load — this is the backstop for the third way a
        // hook line arrives, which neither of those sees: a `[skill: …]` named
        // as a default hook, whose body is read at run time and can hold a
        // flow-control line the config check never looked at. There is no flow
        // to leave from inside a hook, so the hook fails rather than guessing
        // whether it meant the hook scope, the step, or the run.
        if (parseUseStep(raw)) {
          // SPEC-use-computer.md §4.4 — a hook runs on the page surface.
          // Refused at parse for a `## Hooks` entry and at config load for a
          // project default; this is the third way a hook line arrives, which
          // neither of those sees: a `[skill: …]` named as a hook, whose body
          // is read at run time.
          //
          // Read off `raw`, the AUTHORED line: `parseUseStep` normalises the
          // `[no-hooks]` prefix itself, and an interpolated line is not one an
          // author wrote (§4.1).
          const error = useStepInHookError(raw, ` (${scope} hook)`);
          logger.error(error);
          result = {
            index: hookIndex,
            instruction: hookInstruction,
            status: 'failed',
            stepKind: 'mode',
            turns: [],
            durationMs: 0,
            retried: false,
            error,
            aiExplanation: error,
          };
        } else if (hookClaim && isReturnClaim(hookClaim)) {
          const error = flowControlInHookError(hookInstruction, ` (${scope} hook)`);
          logger.error(error);
          result = {
            index: hookIndex,
            instruction: hookInstruction,
            status: 'failed',
            turns: [],
            durationMs: 0,
            retried: false,
            error,
            aiExplanation: error,
          };
        } else if (!hookSetStep && isFailureTailContradiction(hookInstruction)) {
          // Decision 8, on the one hook path with no parse-time validator in
          // front of it. Refused rather than resolved: the line asks to both
          // end the flow and to tolerate its own failure.
          const error = failureTailContradictionError(hookInstruction, ` (${scope} hook)`);
          logger.error(error);
          result = {
            index: hookIndex,
            instruction: hookInstruction,
            status: 'failed',
            turns: [],
            durationMs: 0,
            retried: false,
            error,
            aiExplanation: error,
          };
        } else if (hookClaim && hookClaim.verb === 'fail' && hookClaim.body === undefined) {
          // An unconditional `Fail the test with error "…"` as a hook line: no
          // condition to judge, so no model call (decision 3). It fails the hook,
          // which aborts the run, as any failed hook does.
          //
          // No `deliberateFailError` here, unlike the main loop: `hookClaim` was
          // read off the already-interpolated `hookInstruction`, so its message
          // holds resolved text rather than the author's tokens.
          result = deliberateFailResult(
            hookIndex,
            hookInstruction,
            redact(hookClaim.message ?? DELIBERATE_FAIL_FALLBACK, secretsNow()),
          );
          logger.error(`${scope} hook: ${result.error}`);
        } else if (hookSetStep) {
          logger.info(`Running ${scope} hook: ${hookInstruction}`);
          const outcome = runSetStep(
            hookSetStep,
            hookInstruction,
            hookIndex,
            resolvedParameters,
            test.envData,
          );
          result = outcome.result;
          if (outcome.assigned) {
            logger.info(
              `[set] ${outcome.assigned.name} = "${redact(outcome.assigned.value, secretsNow())}"`,
            );
          }
        } else if (hookUseAiStep) {
          // The hook half of verification rule 7, through the same runner as the
          // main flow.
          logger.info(`Running ${scope} hook: ${redact(hookInstruction, secretsNow())}`);
          const aiOutcome = await runUseAiStep({
            parsed: hookUseAiStep,
            index: hookIndex,
            instruction: hookInstruction,
            scope: resolvedParameters,
            envData: test.envData,
            secrets: secretsNow(),
            unmask: unmaskNames,
            aiClient,
            retries: config.execution.retries,
            signal: extras.signal,
            failureTail: hookFailureTail,
            stats: { ...statsFor(), hook: scope, hookIndex: idx + 1 },
          });
          result = aiOutcome.result;
          if (aiOutcome.name !== undefined) {
            logger.info(
              `[ai] ${aiOutcome.name} = ` +
                `"${redact(maskRecordSecrets(aiOutcome.value ?? ''), secretsNow())}"`,
            );
          }
        } else if (toolCall) {
          logger.info(`Running ${scope} hook (tool): ${hookInstruction}`);
          result = await runToolStep(toolCall, hookInstruction, hookIndex);
        } else {
          logger.info(`Running ${scope} hook: ${hookInstruction}`);
          result = await executeStep(hookIndex, test.steps.length, hookInstruction, {
            page: session.page,
            config,
            aiClient,
            contextContent,
            testName: test.title,
            ...(baseUrl !== undefined && { baseUrl }),
            conversationHistory: [...conversationHistory],
            apiResponseStore,
            csrfTokens,
            uploadPaths,
            resolvedParameters,
            pageTracker: session.pageTracker,
            browserTracker,
            // The run's structure memo, hooks included
            // (SPEC-structured-table-reads.md §7.10: ONE question per
            // structure per run). A `before` hook that reads a legacy grid to
            // establish a starting state asks the same question step 2 then
            // asks again — the memo is keyed by the region and the columns,
            // not by where the read sits, so there is no reason for a hook to
            // be the one caller that pays twice. A memo entry is re-validated
            // against the live page on every reuse.
            structureMemo,
            dismissalGuidance: hooks.hasAny,
            ...placeholderOpts,
            // A CONDITIONAL `fail` hook. The claim is what lets the model's `fail`
            // action through (decision 7); a `return`/`stop` claim never reaches
            // here, having been refused above.
            ...(hookClaim && { flowControlClaim: hookClaim }),
            // A hook step's tail, applied by the same one seam a step's is
            // (decision 7). An `otherwise continue` hook that fails does not
            // fail the hook scope, so it does not abort the run — see the
            // `!result.tolerated` on the scope's own failure check below.
            ...(hookFailureTail && { failureTail: hookFailureTail }),
            // The scope and the line's place in it ride along: `hookScope` and
            // `hookIndex` are stamped below, after the step recorded its lines.
            // And the line as the author wrote it, `${…}` intact: `raw` had its
            // references substituted at parse, so it holds the values — an
            // environment's password included — and it is what the scoreboard
            // would otherwise record as the step's text (§5.7).
            stats: {
              ...statsFor(),
              hook: scope,
              hookIndex: idx + 1,
              stepText: hooks.authored?.[scope]?.[idx] ?? raw,
            },
          },
          // A hook's authored form is `raw`: its `${…}` was substituted at
          // parse (hooks are not shown to the model as authored text the way
          // steps are), its `{{…}}` on the line above.
          raw);
        }

        result.hookScope = scope;
        // Which line of the scope this is: the scope's lines share `index`, and
        // the report's anchors and the scoreboard's lines tell them apart by it.
        result.hookIndex = idx + 1;
        if (sourceSkill) result.sourceSkill = sourceSkill;
        const hookCaptures = computeStepCaptures(result, resolvedParameters);
        if (hookCaptures) result.outputs = hookCaptures;
        stepResults.push(result);
        tokenTracker.resetStep();

        // `before` hooks inform the AI's context for later steps; per-step
        // hooks are plumbing and would just pollute the conversation history.
        if (scope === 'before') {
          conversationHistory.push(
            formatStepHistoryEntry(
              hookIndex,
              redact(`(${scope} hook) ${hookInstruction}`, secretsNow()),
              result.status === 'passed',
              session.page.url(),
            ),
          );
        }

        // `!result.tolerated`: an `otherwise continue` on a hook line composes the
        // obvious way (decision 7). The row still says `failed`, but the SCOPE did
        // not fail, so the run is not aborted and this scope's remaining hooks run.
        if (result.status === 'failed' && !result.tolerated) {
          return {
            failed: true,
            error: result.error ?? `${scope} hook failed`,
          };
        }
        if (result.tolerated) {
          logger.warn(toleratedLogLine(hookIndex, result.error));
        }
      }
      return { failed: false };
    };

    // Run `before` hooks (once per test, before any step runs)
    if (hooks.before.length > 0) {
      const beforeResult = await runHookScope(
        'before',
        hooks.before,
        hooks.toolCalls.before,
        hooks.sourceSkills.before,
        0,
      );
      if (beforeResult.failed) {
        logger.error(`'before' hook failed — aborting test: ${beforeResult.error}`);
        bail = true;
      }
    }

    // Detect conditional step groups for multi-outcome branching
    const stepGroups = identifyStepGroups(test.steps);

    // ── Control flow (stories/control-flow.md) ───────────────────────────
    //
    // `controls[i]` is non-null exactly on a guard — an `If … then`, an
    // `Else if`, an `Otherwise`, a `While`, a `Repeat … until` or a `For
    // each`. All-null for every file written before this feature, so the loop
    // below is byte-for-byte what it was for them.
    const controls: (ControlRecord | null)[] =
      test.expansion?.controls ?? test.steps.map(() => null);
    const hasControls = controls.some((record) => record !== null);
    const controlState = createControlState(config.execution.maxLoopIterations);
    const loops = new LoopRuntime();
    const skipQueue = new SkipQueue();

    /** Tag a result with the skill / section it came from, as the main loop
     *  does — guard and skipped rows are steps like any other in the report. */
    const tagOrigin = (result: StepResult, index0: number): StepResult => {
      const skill = test.sourceSkills[index0] ?? null;
      if (skill) result.sourceSkill = skill;
      const section = test.sourceSections[index0] ?? null;
      if (section) result.sourceSection = section;
      return result;
    };

    /** Why each queued index was skipped — recorded when it is queued, because
     *  the decision that skipped it is long gone by the time the row is. */
    const skipReasons = new Map<number, string>();

    /** Release every queued skipped step the run has now moved past. */
    const flushSkips = (before: number | 'all'): void => {
      const due = before === 'all' ? skipQueue.takeAll() : skipQueue.take(before);
      for (const k of due) {
        stepResults.push(
          tagOrigin(
            skippedResult({
              index: k + 1,
              instruction: test.steps[k] ?? '',
              reason: skipReasons.get(k) ?? 'Skipped',
              loop: loops.markerFor(k),
            }),
            k,
          ),
        );
      }
    };
    /** Where the run goes after step `i`: the next line, or back to a loop's
     *  guard when `i` closed its body. */
    const advanceAfter = (i: number): number => {
      const after = planAfterStep(controls, i, controlState);
      return after ? after.next : i + 1;
    };

    // The last expanded step this run executes (exclusive). A prefix replay
    // stops short of the whole test on purpose; see `RunTestExtras.stopAfterStep`.
    const stepLimit =
      extras.stopAfterStep !== undefined
        ? Math.max(0, Math.min(test.steps.length, extras.stopAfterStep))
        : test.steps.length;

    if (strictLoadError) {
      logger.error(strictLoadError);
      bail = true;
    }

    for (let i = 0; i < stepLimit; i++) {
      if (bail) break;

      if (Date.now() > timeoutDeadline) {
        logger.error(`Test timeout after ${testTimeout}ms at step ${i + 1}`);
        timedOut = true;
        break;
      }

      // ── A SKILL RETURNED: restore the caller's surface (§4.5) ───────────
      //
      // Before the dispatch and the launch gate both, because the surface it
      // restores is what those two read. An inline section is deliberately
      // absent from this: `skillFrameChain` keeps only `kind: 'skill'` frames.
      //
      // Going back to `computer` is `[use computer]` and can fail; that fails
      // THIS step, the caller's first after the skill, before anything runs on
      // it. Skipped when this step is itself a `[use …]` line, which sets the
      // surface anyway — the server's rule, for the server's reason.
      const restoreTo = skillSurfaces.enter(
        skillFrameChain(test.expansion?.origins[i]?.frameId, test.expansion?.frames),
        surfaceState.surface,
      );
      if (restoreTo !== null && !(restoreTo === 'computer' && parseUseStep(test.steps[i] ?? ''))) {
        const restored = await restoreSurface(restoreTo);
        if (!restored.ok) {
          logger.error(`Step ${i + 1} FAILED: ${restored.error}`);
          if (hasControls) flushSkips(i);
          stepResults.push(
            tagOrigin(
              {
                index: i + 1,
                instruction: test.steps[i] ?? '',
                status: 'failed',
                turns: [],
                durationMs: 0,
                retried: false,
                error: restored.error,
                aiExplanation: restored.error,
              },
              i,
            ),
          );
          bail = true;
          break;
        }
      }

      // ── THE SURFACE SWITCH (SPEC-use-computer.md §4.4, §5.1) ────────────
      //
      // Rung 1, with the other bracket directives, and AHEAD of the launch
      // gate below: a test whose step 1 is `[use computer]` must not open a
      // browser to be told it is switching away from one.
      //
      // Read off the AUTHORED line, before any interpolation — `parseUseStep`
      // normalises a `[no-hooks]` prefix itself — so the surface a run drives
      // is readable from the file.
      const useStep = parseUseStep(test.steps[i] ?? '');
      if (useStep) {
        const instruction = test.steps[i] ?? '';
        logger.step(i + 1, test.steps.length, instruction);
        let modeResult: StepResult;
        if (useStep.surface === 'computer') {
          const entered = await enterComputerSurface();
          modeResult = entered.ok
            ? modeStepResult(i + 1, instruction, 'computer', entered.reentered)
            : {
                index: i + 1,
                instruction,
                status: 'failed',
                stepKind: 'mode',
                turns: [],
                durationMs: 0,
                retried: false,
                error: entered.error,
                aiExplanation: entered.error,
              };
          if (!entered.ok) logger.error(`Step ${i + 1} FAILED: ${entered.error}`);
        } else {
          const left = leaveComputerMode(surfaceState, computerLockId, extras.computerLock);
          modeResult = modeStepResult(i + 1, instruction, 'browser', left.reentered);
        }
        recordLastRun(i, modeResult);
        stepResults.push(tagOrigin(modeResult, i));
        if (modeResult.status === 'failed') {
          bail = true;
          break;
        }
        logger.success(`Step ${i + 1} passed`);
        tokenTracker.resetStep();
        i = advanceAfter(i) - 1;
        continue;
      }

      // ── THE BROWSER LAUNCH (SPEC-use-computer.md §4.6) ──────────────────
      //
      // Same rule as the Sessions API's: the browser opens at the first step
      // that runs while the surface is `browser`, so a desktop-only test run
      // from the CLI opens none. Ahead of the control-flow guard below, which
      // reads `session.page` for its executor options — this is the earliest
      // point in the iteration and every page read in the body is downstream
      // of it.
      //
      // A launch failure is THIS STEP's failure: the run records a failed row
      // and bails, exactly as a refused step does, rather than throwing out of
      // `runTest` with no report.
      if (surfaceState.surface === 'browser' && !browserTracker.hasActive()) {
        try {
          await ensureBrowser();
        } catch (err) {
          const error = `browser launch failed: ${(err as Error).message}`;
          logger.error(error);
          stepResults.push(
            tagOrigin(
              {
                index: i + 1,
                instruction: test.steps[i] ?? '',
                status: 'failed',
                turns: [],
                durationMs: 0,
                retried: false,
                error,
                aiExplanation: error,
              },
              i,
            ),
          );
          bail = true;
          break;
        }
      }

      // ── THE COMPUTER LOCK (SPEC-use-computer.md §5.9) ───────────────────
      //
      // The server's step-boundary re-take, in the same place relative to the
      // launch gate and the guard, through the same helpers. Within one
      // `runTest`, being on the computer surface no longer implies holding the
      // lock: every pause for a person — an `[input:]` prompt, an
      // `[interactive]` or failure REPL — gives it back before it waits, and
      // this is where the run takes it again, at the next step that reads or
      // drives the screen. Ahead of the guard because the condition judge
      // (§5.6) captures the screen; `stepReadsScreen` / `guardVisitReadsScreen`
      // decide, so a `Set` or another prompt takes nothing, and a `[tool:]`
      // line takes it — a tool can launch a program and take the front window.
      //
      // No opt-in check here, unlike the server's boundary: the CLI's config is
      // loaded once per `runTest` and every run starts on the browser, so the
      // `[use computer]` that put this run on the surface already asked it.
      //
      // A refusal is THIS step's failure with §5.9's message, and nothing is
      // captured or asked of the model for it — the launch failure's shape.
      if (
        surfaceState.surface === 'computer' &&
        !surfaceState.lockHeld &&
        (hasControls && controls[i]
          ? guardVisitReadsScreen(controls, i, controlState)
          : stepReadsScreen(test.steps[i] ?? ''))
      ) {
        const taken = ensureComputerLock(surfaceState, computerLockId, extras.computerLock);
        if (!taken.ok) {
          const error = taken.error;
          logger.error(`Step ${i + 1} FAILED: ${error}`);
          if (hasControls) flushSkips(i);
          stepResults.push(
            tagOrigin(
              {
                index: i + 1,
                instruction: test.steps[i] ?? '',
                status: 'failed',
                surface: 'computer',
                turns: [],
                durationMs: 0,
                retried: false,
                error,
                aiExplanation: error,
              },
              i,
            ),
          );
          bail = true;
          break;
        }
      }

      // ── Control flow: a guard decides, and the planner says what follows ──
      //
      // Before the hooks, deliberately: a guard is not a page step. It never
      // reaches `executeStep` — its condition is decided by `evaluateGuard`,
      // from its values, its code-behind `condition` entry, or the model
      // (stories/codebehind-loops-and-conditions.md) — and
      // wrapping it in `beforeEach` / `afterEach` would run the test's plumbing
      // twice around one line — once for the decision and once for the step the
      // decision chose (stories/control-flow.md §"What is deliberately
      // unchanged"). Skipped steps get no hooks for the stronger reason that
      // they did not run at all.
      const controlRecord = hasControls ? (controls[i] ?? null) : null;
      if (controlRecord) {
        // Only when there IS one: on the computer surface a run may never have
        // launched a browser (§4.6), and the judge below is handed the
        // computer context instead of a page (§5.6).
        if (browserTracker.hasActive()) session = browserTracker.getActive();
        const guardText = test.steps[i] ?? '';
        // `{{a.b.c}}` matches neither grammar, so it is neither substituted nor
        // warned about as unresolved — it simply reaches the judge as six
        // literal braces. `interpolate` says so for an ordinary step, and this
        // branch `continue`s long before the loop reaches that call, so a
        // control line was the one place in this runner where the warning
        // could not fire. The Sessions API and the Electron adapter resolve
        // every line's text BEFORE their control dispatch and so warned all
        // along; this is the same sentence, from the same function. The guard
        // line is deliberately not interpolated here — the guard path owns its
        // own substitution, and resolving it twice would change what the judge
        // is asked.
        warnMultiSegment(guardText);
        // Same pairing rule the event-emitting loops follow: the console's
        // `Step N` header opens a step, and only a visit that asks somebody
        // closes it with a `Step N passed` (or a failure). A visit that asks
        // nobody — a `Repeat`'s first pass, a `For each`'s revisits — records
        // no row, so printing a header for it announced a step that never
        // reported (stories/control-flow.md §"What the live run found").
        if (guardVisitEvaluates(controls, i, controlState)) {
          logger.step(i + 1, test.steps.length, redact(guardText, secretsNow()));
        }
        tokensAtStepStart = tokenTracker.total;

        let evaluation;
        try {
          evaluation = await evaluateGuard({
          controls,
          index: i,
          state: controlState,
          resolvedParameters,
          // A locally decided condition's reasoning carries VALUES — the
          // judge's never did — so it is masked with this run's secrets
          // before it reaches the log or the report.
          redact: (text) => redact(text, secretsNow()),
          executorOptions: {
            // Absent in fact on the computer surface — see
            // `StepExecutorOptions.page`; `evaluateConditions` branches on
            // `computer` before it reads either of these (§5.6).
            page: session?.page as StepExecutorOptions['page'],
            config,
            aiClient,
            contextContent,
            testName: test.title,
            ...(baseUrl !== undefined && { baseUrl }),
            conversationHistory: [...conversationHistory],
            apiResponseStore,
            csrfTokens,
            uploadPaths,
            resolvedParameters,
            ...(session?.pageTracker && { pageTracker: session.pageTracker }),
            browserTracker,
            dismissalGuidance: hooks.hasAny,
            testSteps: test.steps,
            ...placeholderOpts,
            // The judge reads the condition as AUTHORED beside a `## Values`
            // block, so it needs the same env context an ordinary step's
            // prompt does (stories/placeholder-preserving-actions.md).
            ...(test.envData && { envData: test.envData }),
            ...(extras.signal && { signal: extras.signal }),
            // §5.6 — judged from a capture of the screen, with no DOM.
            ...(surfaceState.surface === 'computer' && surfaceState.adapter
              ? { computer: computerContextFor(config.desktop, surfaceState.adapter) }
              : {}),
          },
          // A condition with a `condition` entry is decided by it, after its
          // own values and before the model (decision 5).
          ...(guardCodeBehind && { codeBehind: guardCodeBehind }),
          });
        } catch (err) {
          // `evaluateGuard` RETHROWS an abort — a stop mid-judge is a stop,
          // not a failure (issues/020) — and until now nothing here caught it,
          // so it would have rejected out of `runTest` with no report written
          // and the browser left open.
          //
          // There is no other abort path in this function to copy: `runTest`
          // threads `extras.signal` into the executor and the judge and
          // handles neither, because `executeStep` swallows an abort and
          // returns a failed result. So this is the CLI's first one, and it
          // ends the run the way the SERVER ends an aborted one — the step in
          // flight is recorded `interrupted`, the report is marked `aborted`,
          // and the report is still written. Nothing today sets
          // `extras.signal` (`steptix run` and `compile` both leave it unset), so
          // this is the hook for whoever wires one rather than a live path.
          if (extras.signal?.aborted || (err as Error | undefined)?.name === 'AbortError') {
            logger.info(`Run stopped at step ${i + 1} while deciding "${redact(guardText, secretsNow())}"`);
            aborted = true;
            stepResults.push(
              tagOrigin(
                {
                  index: i + 1,
                  instruction: redact(guardText, secretsNow()),
                  status: 'failed',
                  turns: [],
                  durationMs: 0,
                  retried: false,
                  interrupted: true,
                  aiExplanation: 'Stopped by user (run aborted).',
                },
                i,
              ),
            );
            bail = true;
            break;
          }
          throw err;
        }
        const { plan } = evaluation;

        // A pass is starting: bind the item, open the band. Bindings go into
        // the live parameter map, so `{{account}}` in the body resolves — and
        // keeps its last value after the loop, which is the documented
        // consequence of there being one map. `applyPassBindings` rather than
        // `Object.assign`, so a row missing a property the last row had does
        // not silently inherit it (control-runtime.ts).
        const marker =
          plan.pass && isLoopRecord(controlRecord)
            ? loops.beginPass(i, controlRecord, plan.pass)
            : undefined;
        if (plan.pass?.bindings) applyPassBindings(resolvedParameters, plan.pass.bindings);
        // The loop ended: every `(n/?)` marker it issued becomes `(n/count)`.
        if (plan.loopEnded) loops.endLoop(plan.loopEnded);

        const rows = guardRows(controlRecord, i, evaluation);
        const reason = skipReasonFor(controlRecord, plan);
        for (const k of rows.skip) skipReasons.set(k, reason);
        skipQueue.add(rows.skip);

        if (rows.guard) {
          flushSkips(rows.guard.index);
          const result = tagOrigin(
            guardResult({
              index: rows.guard.index + 1,
              instruction: test.steps[rows.guard.index] ?? guardText,
              status: rows.guard.status,
              durationMs: evaluation.durationMs,
              reasoning: evaluation.reasoning,
              error: evaluation.error,
              aiInteractions: evaluation.aiInteractions,
              loop: marker,
              ...guardCodeBehindFields(evaluation),
            }),
            rows.guard.index,
          );
          recordLastRun(rows.guard.index, result);
          const guardCaptures = computeStepCaptures(result, resolvedParameters);
          if (guardCaptures) result.outputs = guardCaptures;
          stepResults.push(result);
          // Built from the SELECTED member, with a `did not hold` line for
          // each alternative the judge ruled out — the head of the chain is
          // only where the question was asked from.
          conversationHistory.push(
            ...guardHistoryLines({
              controls,
              index: i,
              rows,
              plan,
              text: (k) => redact(test.steps[k] ?? guardText, secretsNow()),
            }),
          );
        }

        tokenTracker.resetStep();

        if (evaluation.error) {
          logger.error(`Step ${i + 1} FAILED: ${evaluation.error}`);
          // The loop stops where it got to, so its band reports the passes it
          // actually made rather than staying open at `?`.
          if (isLoopRecord(controlRecord)) {
            loops.abandon(i, controlState.passes.get(i) ?? 0);
          }
          bail = true;
          break;
        }

        if (rows.guard?.status === 'passed' && !plan.pass) {
          logger.success(
            `Step ${rows.guard.index + 1} passed${evaluation.fromCodeBehind ? ' (code-behind)' : ''}`,
          );
        }

        // `i++` is about to run, so aim one short of where the plan points.
        i = plan.next - 1;
        continue;
      }

      const stepSkipsHooks = test.skipHooks[i] ?? false;

      // Run `beforeEach` hooks (skipped when the step is marked [no-hooks])
      if (hooks.beforeEach.length > 0 && !stepSkipsHooks) {
        const preResult = await runHookScope(
          'beforeEach',
          hooks.beforeEach,
          hooks.toolCalls.beforeEach,
          hooks.sourceSkills.beforeEach,
          i + 1,
        );
        if (preResult.failed) {
          logger.error(`'beforeEach' hook before step ${i + 1} failed — aborting test: ${preResult.error}`);
          bail = true;
          break;
        }
      }

      // Check if this step is part of a conditional group
      const group = stepGroups.get(i);
      if (group && i === group.conditionalSteps[0]!.index && surfaceState.surface === 'computer') {
        // A watch group polls a PAGE until one of its outcomes matches, and
        // there is no page here (§5.6 gives the computer surface the `If …
        // then` judge and nothing else). Refused by name rather than run
        // against `undefined`, which is what it would have been.
        const error =
          'a conditional watch group needs the page surface; put it before ' +
          '`[use computer]`, or write the decision as an `If … then` line';
        logger.error(`Step ${i + 1} FAILED: ${error}`);
        stepResults.push(
          tagOrigin(
            {
              index: i + 1,
              instruction: test.steps[i] ?? '',
              status: 'failed',
              surface: 'computer',
              turns: [],
              durationMs: 0,
              retried: false,
              error,
              aiExplanation: error,
            },
            i,
          ),
        );
        bail = true;
        break;
      }
      if (group && i === group.conditionalSteps[0]!.index) {
        // Start of a conditional group — execute as branched step
        logger.info(`Conditional group detected at step ${i + 1}: ${group.conditionalSteps.length} conditional + 1 continuation`);

        // Anything an earlier decision skipped, before this group's rows land:
        // every other result-producing path in this loop flushes first, and
        // without it a chain's untaken half sank to the bottom of the report.
        if (hasControls) flushSkips(i);

        const branchedResults = await executeBranchedStep(group, test.steps.length, {
          page: session.page,
          config,
          aiClient,
          contextContent,
          testName: test.title,
          ...(baseUrl !== undefined && { baseUrl }),
          conversationHistory: [...conversationHistory],
          apiResponseStore,
          csrfTokens,
          uploadPaths,
          resolvedParameters,
          pageTracker: session.pageTracker,
          browserTracker,
          structureMemo,
          dismissalGuidance: hooks.hasAny,
          testSteps: test.steps,
          ...placeholderOpts,
          // A branched step's text was never interpolated on the way in —
          // `identifyStepGroups` reads the raw list — so the matched step typed
          // `{{email}}` into the page literally. The executor substitutes now,
          // and needs the run's env context to resolve `${…}` as well
          // (stories/placeholder-preserving-actions.md §Executor).
          ...(test.envData && { envData: test.envData }),
          // The group's steps arrive 0-based and are made 1-based below, after
          // they recorded their lines — so they record under the number the
          // report will show.
          stats: { ...statsFor(), reportIndex: (index0) => index0 + 1 },
        });

        for (const result of branchedResults) {
          // `executeBranchedStep` copies `StepGroup`'s own indices — positions
          // in `test.steps`, so **0-based** — onto every row it builds,
          // including the matched one it passes to `executeStep` as the step
          // index. Every other row in this report carries a 1-based `index`
          // and the HTML report renders `index` verbatim, so a watch group was
          // the one block whose report rows were numbered one low: `1, 1, 2, 4`
          // for a four-step file, one number repeated and one missing, and
          // disagreeing with the console lines below (review 3, finding 6).
          //
          // Converted ONCE, here, so this block has one convention: `index` is
          // the display number from now on and everything that indexes an
          // array takes `sourceIndex`.
          result.index += 1;
          const sourceIndex = result.index - 1;
          const branchSourceSkill = test.sourceSkills[sourceIndex] ?? null;
          if (branchSourceSkill) result.sourceSkill = branchSourceSkill;
          const branchSourceSection = test.sourceSections[sourceIndex] ?? null;
          if (branchSourceSection) result.sourceSection = branchSourceSection;
          // A watch group inside a loop body belongs to the pass that is
          // running, or its rows render as unlabelled duplicates outside every
          // band. Never overwritten: a result that already carries a marker is
          // not this loop's to relabel.
          const branchLoop = loops.markerFor(sourceIndex);
          if (branchLoop && result.loop === undefined) result.loop = branchLoop;
          // Unlike the server path (whose MCP-facing `results` array never
          // includes branched steps at all — a different surface than this
          // report), the CLI does render branched steps, so there's no
          // parity reason to withhold their captures here.
          const branchCaptures = computeStepCaptures(result, resolvedParameters);
          if (branchCaptures) result.outputs = branchCaptures;
          stepResults.push(result);
          const url = session.page.url();
          // Already 1-based — see the stamp at the top of this loop. The
          // history line the model reads, the three console lines below and
          // the report's own row all take this one number now.
          const branchStepNumber = result.index;
          conversationHistory.push(
            formatStepHistoryEntry(branchStepNumber, redact(result.instruction, secretsNow()), result.status === 'passed', url),
          );

          if (result.status === 'failed') {
            logger.error(`Step ${branchStepNumber} FAILED: ${result.error ?? 'unknown error'}`);
            bail = true;
          } else if (result.status === 'skipped') {
            logger.info(`Step ${branchStepNumber} skipped (conditional not matched)`);
          } else {
            logger.success(`Step ${branchStepNumber} passed`);
          }
        }

        // Skip past all steps in this group (they've been handled), then let
        // control flow have its say: the continuation step can be the last
        // step of a loop body, which sends the run back to the guard.
        i = advanceAfter(group.continuationStep.index) - 1;
        tokenTracker.resetStep();
        continue;
      }

      if (group && i !== group.conditionalSteps[0]!.index) {
        // This step is part of a group but not the first — already handled
        continue;
      }

      // Refresh active session — a prior step may have switched browsers
      // via openBrowser/switchBrowser/closeBrowser. Single-browser tests
      // see exactly the same `default` session every iteration.
      //
      // Guarded: a computer-surface run may have launched no browser at all
      // (§4.6), and `getActive()` on an unlaunched tracker throws by design.
      if (browserTracker.hasActive()) session = browserTracker.getActive();

      // The step as AUTHORED: expanded (skill renames applied) with `{{}}` and
      // `${}` tokens intact. `applyEnvDataInterpolation` validates rather than
      // rewrites now, so this is the same form the server has always held as
      // `originalStep` (stories/placeholder-preserving-actions.md §Runner and
      // server). It is what the model reads.
      const rawInstruction = test.steps[i] ?? '';
      // `Set {{x}} to "…"` is read off the AUTHORED line and never
      // interpolated: `interpolate` would replace the TARGET with its own
      // value on any run after the first, and warn about it on the first
      // (stories/variable-assignment.md §Locked, "Recognised on the authored
      // line"). Its own template is resolved inside the branch instead.
      const setStep = parseSetStep(rawInstruction);
      // `[use ai] <step>` (stories/use-ai-step.md), read off the AUTHORED line
      // for `Set`'s reason and dispatched beside it: never interpolated here —
      // the runner fills and masks the placeholders itself, and a prose
      // `store as {{x}}` is a definition that interpolation would overwrite on
      // a second pass.
      const useAiStep = setStep ? null : parseUseAiStep(rawInstruction);
      // `If … then return` / `… then stop`, likewise read off the AUTHORED
      // line (stories/step-flow-control.md, decision 2). The claim is textual
      // and is the same answer in every runner; the model only judges the
      // condition, and only on the conditional form. The line is still
      // interpolated below — a body may reference `{{…}}`, and it is the whole
      // line the model reads.
      const flowControlClaim = setStep || useAiStep ? null : parseFlowControlStep(rawInstruction);
      // Env/data first (parse-time semantics: fixed for the whole run), then
      // runtime `{{...}}` — the server's order, now the CLI's too.
      // `controlLineDefines` is the third argument, and it is not optional in
      // practice: a `For each {{payment}} in {{payments}}` header READS the
      // list and WRITES the item, so without it `interpolate` logged
      // `Unresolved placeholder: {{payment}}` on every visit to every correct
      // table loop — noise in the one output that reads like a diagnosis.
      // Every run loop passes it; that is the whole point of the helper.
      const instruction = setStep || useAiStep
        ? rawInstruction
        : interpolate(
            test.envData ? interpolateEnvData(rawInstruction, test.envData) : rawInstruction,
            resolvedParameters,
            controlLineDefines(rawInstruction),
          );

      // The one log line that ignores the log level — so the one place the
      // resolved password would always print. Masked; the step itself runs
      // with the real value.
      logger.step(i + 1, test.steps.length, redact(instruction, secretsNow()));

      // Baseline for this step's token attribution — taken AFTER the
      // `beforeEach` hooks so their turns are not billed to the step
      // (`recordLastRun` reads it back once the step is done).
      tokensAtStepStart = tokenTracker.total;

      // The unconditional form — a step whose WHOLE text is the tail, so
      // `Stop running the remaining steps` as much as `Return` — has no
      // condition to judge, so it is dispatched here beside `Set`: no model
      // call, no page snapshot (story decision 3). The test is
      // the absent `body`, never the length of the line.
      const unconditionalFlowControl =
        flowControlClaim && flowControlClaim.body === undefined ? flowControlClaim : null;

      // Handle [input: variable_name] steps — pause for user input
      const inputStep =
        setStep || useAiStep || unconditionalFlowControl ? null : parseInputStep(instruction);
      const interactiveStep =
        !inputStep && !setStep && !useAiStep && !unconditionalFlowControl
          ? parseInteractiveStep(instruction)
          : null;
      const outputStep =
        !inputStep && !interactiveStep && !setStep && !useAiStep && !unconditionalFlowControl
          ? parseOutputStep(instruction)
          : null;
      // The `… otherwise fail …` / `… otherwise continue` tail, computed beside the
      // claim and off the same AUTHORED line (stories/step-failure-outcomes.md,
      // decision 12). Leaf PROSE steps only: a `Set`, a `[tool:]`, an `[input:]`
      // and an `[interactive]` step each have a grammar of their own, and a
      // flow-control claim is a different form entirely. (A `### Section` or
      // `[skill:]` call never reaches this loop — the expander replaced it.)
      const failureTail =
        setStep || flowControlClaim || inputStep || interactiveStep || test.toolCalls[i]
          ? null
          : parseFailureTail(rawInstruction);
      // Decision 8's backstop. The parse-time validator refuses this for a
      // file; this catches the line that reaches the loop without one — a
      // `[skill: …]` body read at run time, most of all. No model call: the
      // line asks for two endings at once and there is nothing to judge.
      const tailContradiction =
        setStep || flowControlClaim ? false : isFailureTailContradiction(rawInstruction);
      // A `{{order.statuz}}` the pass cannot answer, refused before the model
      // is asked anything (SPEC-structured-table-reads.md §8.3). Read off the
      // AUTHORED line, because `interpolate` has already replaced every
      // reference it COULD answer and leaves only the ones it could not.
      // Dotted only: an unresolved flat name keeps its warning.
      // Masked here for the same reason the `Step N` line above is: the
      // refusal is written from the run's own values — the properties the row
      // does hold, the keys the loop dropped — and it reaches the console, the
      // report and the run log verbatim.
      // Not for a `[use ai]` step either: its runner refuses every reference it
      // cannot fill, dotted or flat, in `Set`'s words (stories/use-ai-step.md,
      // verification rule 5).
      const dottedRefError = setStep || useAiStep
        ? undefined
        : dottedReferenceError(
            rawInstruction,
            resolvedParameters,
            (item) => forEachPassOf(controls, controlState, item),
            (text) => redact(text, secretsNow()),
          );
      // Read only by the branch just ahead of the computer-surface dispatch, so
      // every earlier branch — `Set`, `[input:]`, a dispatched `[tool:]` — has
      // already taken the steps it owns. This runner always loads a catalogue
      // and always parses with a skills directory, so a directive that reaches
      // that branch was dropped by whatever built `test`, and the message says
      // so rather than blaming a missing directory.
      const undispatchedDirective =
        surfaceState.surface === 'computer' && !setStep && !useAiStep && !unconditionalFlowControl
          ? undispatchedDirectiveError(rawInstruction, { toolsLoaded: true, skillsDirSupplied: true })
          : null;
      let stepResult: StepResult;
      let interactiveResults: StepResult[] = [];

      if (dottedRefError) {
        logger.error(dottedRefError);
        stepResult = {
          index: i + 1,
          instruction,
          status: 'failed',
          turns: [],
          durationMs: 0,
          retried: false,
          error: dottedRefError,
          aiExplanation: dottedRefError,
        };
      } else if (tailContradiction) {
        const error = failureTailContradictionError(rawInstruction);
        logger.error(error);
        stepResult = {
          index: i + 1,
          instruction,
          status: 'failed',
          turns: [],
          durationMs: 0,
          retried: false,
          error,
          aiExplanation: error,
        };
      } else if (unconditionalFlowControl && unconditionalFlowControl.verb === 'fail') {
        // `Fail the test with error "…"` as a whole step: no condition to judge, so
        // no model call and no page snapshot — dispatched here beside `Return` and
        // `Set` (decisions 1 and 3). The author's message was interpolated above
        // and is masked here, where it first becomes what the report, the log and
        // the wire carry.
        stepResult = deliberateFailResult(
          i + 1,
          instruction,
          redact(deliberateFailError(unconditionalFlowControl, instruction), secretsNow()),
        );
        // The same shot a step that failed under the executor gets, on the same
        // config switch: no screenshot where every other failure has one would read
        // as a missing capture.
        // …when there is a page to shoot. A computer-surface run may have
        // launched no browser at all (§4.6).
        if (config.execution.screenshotOnFailure && browserTracker.hasActive()) {
          const shot = await captureScreenshot(session.page, config.browser.fullPageScreenshots);
          if (shot?.base64) stepResult.screenshotBase64 = shot.base64;
        }
      } else if (unconditionalFlowControl) {
        stepResult = {
          index: i + 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 0,
          retried: false,
          aiExplanation: flowControlExplanation(
            frameLabel(test.expansion?.origins, test.expansion?.frames, i),
          ),
          // `isReturnClaim` narrows the union: this record means "the step ended the
          // flow as a PASS", so a `fail` claim must never produce one — it took the
          // branch above (decision 1).
          ...(isReturnClaim(unconditionalFlowControl) && {
            flowControl: { kind: 'return' as const, verb: unconditionalFlowControl.verb },
          }),
        };
      } else if (setStep) {
        const setOutcome = runSetStep(
          setStep,
          instruction,
          i + 1,
          resolvedParameters,
          test.envData,
        );
        stepResult = setOutcome.result;
        if (setOutcome.assigned) {
          logger.info(
            `[set] ${setOutcome.assigned.name} = ` +
              `"${redact(maskRecordSecrets(setOutcome.assigned.value), secretsNow())}"`,
          );
        }
      } else if (useAiStep) {
        // `[use ai] <step>` (stories/use-ai-step.md): the step's text alone goes
        // to the model, and the value it answers with is stored. Beside `Set`
        // and for `Set`'s reasons — no `codeBehindOptionsFor(i)`, no page:
        // `executeStep` is the only reader of code-behind, and this never
        // reaches it, so the model answers on every run.
        const aiOutcome = await runUseAiStep({
          parsed: useAiStep,
          index: i + 1,
          instruction,
          scope: resolvedParameters,
          envData: test.envData,
          secrets: secretsNow(),
          unmask: unmaskNames,
          aiClient,
          retries: config.execution.retries,
          signal: extras.signal,
          failureTail,
          stats: statsFor(),
        });
        stepResult = aiOutcome.result;
        if (aiOutcome.name !== undefined) {
          // Read AFTER the write, so a secret-named target's own value is in
          // the mask set this line is printed through.
          logger.info(
            `[ai] ${aiOutcome.name} = ` +
              `"${redact(maskRecordSecrets(aiOutcome.value ?? ''), secretsNow())}"`,
          );
        }
      } else if (inputStep) {
        const stepStartTime = Date.now();
        // §5.9: a run waiting for a person holds no mouse lock.
        releaseLockForPause(`[input: ${inputStep.variable}]`);
        const value = await promptUserForInput(inputStep.promptText);
        // Through the one helper, like every other write into this map: an
        // `[input: order]` after a `For each {{order}} …` is a rebind of that
        // root, and left to a plain assignment it kept the last pass's
        // `order.id` alive for every step that followed (§8.2).
        bindVariable(resolvedParameters, inputStep.variable, value);
        logger.info(`Stored user input as parameter "{{${inputStep.variable}}}"`);

        // Don't count user input time against the test timeout
        const inputDuration = Date.now() - stepStartTime;
        timeoutDeadline += inputDuration;

        stepResult = {
          index: i + 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: inputDuration,
          retried: false,
          aiExplanation: `User provided input for "${inputStep.variable}"`,
        };
      } else if (interactiveStep) {
        // Planned interactive step — hand off to the unified REPL.
        const stepStartTime = Date.now();
        humanIntervened = true;

        const adHocResults: StepResult[] = [];
        // §5.9: a run waiting for a person holds no mouse lock. The REPL's own
        // commands drive the page, not the screen.
        releaseLockForPause('[interactive]');
        const decision = await runInteractiveRepl({
          page: session.page,
          testSteps: test.steps,
          currentStepIndex: i + 1,
          entryReason: 'planned',
          ...(interactiveStep.hint && { hint: interactiveStep.hint }),
          executorOptions: {
            page: session.page,
            config,
            aiClient,
            contextContent,
            testName: test.title,
            ...(baseUrl !== undefined && { baseUrl }),
            conversationHistory: [...conversationHistory],
            apiResponseStore,
            csrfTokens,
            uploadPaths,
            resolvedParameters,
            pageTracker: session.pageTracker,
            browserTracker,
            dismissalGuidance: hooks.hasAny,
            stats: statsFor(),
          },
          adHocResults,
        });

        // Re-shape the ad-hoc results so the report renderer can group them
        // under the [interactive] banner and number them as Step N.M.
        let childIdx = 1;
        for (const ad of adHocResults) {
          // Skip /screenshot synthetic rows from the interactive-child grouping —
          // they keep their `interactiveAdHoc` flag and render as standalone entries.
          if (ad.instruction === '[interactive: screenshot]') continue;
          ad.instruction = `(interactive ${childIdx}) ${ad.instruction}`;
          ad.interactiveChild = true;
          const childCaptures = computeStepCaptures(ad, resolvedParameters);
          if (childCaptures) ad.outputs = childCaptures;
          conversationHistory.push(
            formatStepHistoryEntry(
              i + 1,
              redact(ad.instruction, secretsNow()),
              ad.status === 'passed',
              session.page.url(),
            ),
          );
          childIdx++;
        }
        interactiveResults = adHocResults;

        const anyFailed = interactiveResults.some((r) => r.status === 'failed');
        const allTurns = interactiveResults.flatMap((r) => r.turns);

        const explanation =
          decision.kind === 'exit'
            ? `Interactive mode: user exited after ${interactiveResults.length} command(s)`
            : decision.kind === 'resume'
              ? `Interactive mode: user resumed at step ${decision.fromStepIndex} after ${interactiveResults.length} command(s)`
              : `Interactive mode: executed ${interactiveResults.length} command(s)`;

        stepResult = {
          index: i + 1,
          instruction,
          status: anyFailed ? 'failed' : 'passed',
          turns: allTurns,
          durationMs: Date.now() - stepStartTime,
          retried: false,
          aiExplanation: explanation,
          ...(anyFailed && { error: 'One or more interactive commands failed' }),
          ...(decision.kind === 'resume' && { interactiveResumed: true }),
        };

        if (decision.kind === 'exit') {
          logger.info('Interactive mode: user exited — stopping test and generating report');
          bail = true;
        } else if (decision.kind === 'resume') {
          // Push the parent + children before jumping so the report stays in order.
          // This branch pushes directly and `continue`s below rather than
          // falling through to the common tail, so it needs its own capture
          // computation — the common tail's doesn't run for it.
          const resumeCaptures = computeStepCaptures(stepResult, resolvedParameters);
          if (resumeCaptures) stepResult.outputs = resumeCaptures;
          recordLastRun(i, stepResult);
          stepResults.push(stepResult);
          stepResults.push(...interactiveResults);
          conversationHistory.push(
            formatStepHistoryEntry(
              i + 1,
              redact(instruction, secretsNow()),
              stepResult.status === 'passed',
              session.page.url(),
            ),
          );
          conversationHistory.push(
            `[interactive] user resumed test at step ${decision.fromStepIndex}`,
          );
          // Refresh the timeout — debugging shouldn't be billed against the test.
          timeoutDeadline = Date.now() + testTimeout;
          // Pre-decrement so the loop's `i++` lands on the chosen index.
          i = decision.fromStepIndex - 2;
          tokenTracker.resetStep();
          continue;
        }
      } else if (outputStep) {
        stepResult = await executeStep(i + 1, test.steps.length, outputStep.enrichedInstruction, {
          page: session.page,
          config,
          aiClient,
          contextContent,
          testName: test.title,
          ...(baseUrl !== undefined && { baseUrl }),
          conversationHistory: [...conversationHistory],
          apiResponseStore,
          csrfTokens,
          uploadPaths,
          resolvedParameters,
          pageTracker: session.pageTracker,
          browserTracker,
          structureMemo,
          dismissalGuidance: hooks.hasAny,
          testSteps: test.steps,
          ...placeholderOpts,
          ...codeBehindOptionsFor(i),
          // This step's own tail, read at one seam over a step that has finally
          // failed (stories/step-failure-outcomes.md, decision 4).
          ...(failureTail && { failureTail }),
          stats: statsFor(),
        },
        // Authored: the executor applies the `[output:]` enrichment to it too,
        // so the model reads `… [store as: total]` rather than a raw
        // `[output: total]` prefix.
        rawInstruction);
        if (stepResult.status === 'passed') {
          // `boundValue`, not a bare index: this line is how an author finds
          // out whether the capture worked, and `[output: constructor]`
          // printed `function Object() { [native code] }` off the prototype of
          // a map that had captured nothing. The step it describes was
          // recorded correctly — `computeStepCaptures` asks `hasOwn` — so the
          // console said one thing and the report another.
          const captured = boundValue(resolvedParameters, outputStep.variable);
          // …and masked, the same composition the executor's own capture line
          // uses: SHAPE first, then free text. Round 5 replaced the bare index
          // read with `boundValue` and left the VALUE raw, so the CLI printed
          // `[output: password] = "hunter2"` to the console and the SSE
          // `output` bridge while the report, the step line and the prompt's
          // `## Values` block all said `***` for it (review 6, finding 3).
          // The shape half is not optional here either: `[output: rows]` over
          // a `readTable` capture is a whole table under a name that says
          // nothing, and a three-character `password` column never joins the
          // free-text set.
          const shown =
            captured === undefined
              ? '(not captured)'
              : redact(maskRecordSecrets(captured), secretsNow());
          logger.info(`[output: ${outputStep.variable}] = "${shown}"`);
        }
      } else if (test.toolCalls[i]) {
        // [tool: ...] step — dispatch deterministic code with live page/context/browser.
        // Same path the hook executor uses; see runToolStep above.
        stepResult = await runToolStep(test.toolCalls[i]!, instruction, i + 1);
      } else if (undispatchedDirective !== null) {
        // SPEC-use-computer.md §5.4: a `[tool:]` / `[skill:]` line that nothing
        // above dispatched is never handed to the computer-surface model, which
        // would act it out on the real screen. The server's loop refuses the
        // same, at the same point in its chain.
        logger.error(undispatchedDirective);
        stepResult = undispatchedDirectiveResult(i + 1, instruction, undispatchedDirective);
      } else if (surfaceState.surface === 'computer' && surfaceState.adapter) {
        // ── THE COMPUTER SURFACE (SPEC-use-computer.md §5.5) ───────────────
        //
        // Last of the dispatches, and that position is the rule: `Set`, a
        // `[tool:]` call, a control line and an `If … then return` claim mean
        // the same thing on either surface and keep their own branches above.
        // What changes here is only how a PROSE step is answered — from a
        // capture of the screen instead of a DOM.
        //
        // No `codeBehindOptionsFor(i)`: a recorded coordinate has nothing to
        // validate against at replay (§5.5), and is not portable to another
        // machine (§9).
        stepResult = await executeComputerStep(
          i + 1,
          test.steps.length,
          instruction,
          {
            // No browser on this surface, and possibly none in the run at all
            // (§4.6) — see `StepExecutorOptions.page`.
            page: undefined as never,
            config,
            aiClient,
            contextContent,
            testName: test.title,
            ...(baseUrl !== undefined && { baseUrl }),
            conversationHistory: [...conversationHistory],
            apiResponseStore,
            csrfTokens,
            uploadPaths,
            resolvedParameters,
            browserTracker,
            testSteps: test.steps,
            ...placeholderOpts,
            ...(test.envData && { envData: test.envData }),
            ...(flowControlClaim && { flowControlClaim }),
            ...(failureTail && { failureTail }),
            ...(extras.signal && { signal: extras.signal }),
            computer: computerContextFor(config.desktop, surfaceState.adapter),
            stats: statsFor(),
          },
          rawInstruction,
        );
      } else {
        stepResult = await executeStep(i + 1, test.steps.length, instruction, {
          page: session.page,
          config,
          aiClient,
          contextContent,
          testName: test.title,
          ...(baseUrl !== undefined && { baseUrl }),
          conversationHistory: [...conversationHistory],
          apiResponseStore,
          csrfTokens,
          uploadPaths,
          resolvedParameters,
          pageTracker: session.pageTracker,
          browserTracker,
          structureMemo,
          dismissalGuidance: hooks.hasAny,
          testSteps: test.steps,
          ...placeholderOpts,
          ...codeBehindOptionsFor(i),
          // The conditional form only — the unconditional one never reaches
          // here. Present, this is what lets the model's `return` action end
          // the step (stories/step-flow-control.md, decision 2); absent, the
          // action is refused and the model is told why. Since
          // stories/step-failure-outcomes.md decision 1 the same field carries a
          // conditional `fail` claim, which is what lets a `fail` action through.
          ...(flowControlClaim && { flowControlClaim }),
          // This step's own tail (decision 4). Never both: `failureTail` is
          // null whenever a claim was read off the line.
          ...(failureTail && { failureTail }),
          stats: statsFor(),
        },
        rawInstruction);
      }

      // Tag the step with its originating skill (if any) so the report can
      // show a "from skill X" chip even after parse-time expansion has
      // flattened the call.
      const stepSourceSkill = test.sourceSkills[i] ?? null;
      if (stepSourceSkill) stepResult.sourceSkill = stepSourceSkill;
      const stepSourceSection = test.sourceSections[i] ?? null;
      if (stepSourceSection) stepResult.sourceSection = stepSourceSection;

      const stepCaptures = computeStepCaptures(stepResult, resolvedParameters);
      if (stepCaptures) stepResult.outputs = stepCaptures;

      // Name the flow the step left. The executor produced the model's own
      // account of why the condition held and nothing more — it holds no
      // expansion, so it cannot know whether this was "Sign in" or the whole
      // test. One formatter for every loop, so the phrasing cannot drift
      // (stories/step-flow-control.md).
      if (stepResult.flowControl && !unconditionalFlowControl) {
        stepResult.aiExplanation = flowControlExplanation(
          frameLabel(test.expansion?.origins, test.expansion?.frames, i),
          stepResult.aiExplanation,
        );
      }

      // Which loop pass this step belongs to — the band the report draws
      // around it, and the `(3/?)` on its section chip.
      const stepLoop = loops.markerFor(i);
      if (stepLoop) stepResult.loop = stepLoop;

      // Untaken branches recorded before this step, so the report reads in the
      // order the file is written in rather than in the order decisions fell.
      flushSkips(i);
      recordLastRun(i, stepResult);
      stepResults.push(stepResult);
      if (interactiveStep) {
        stepResults.push(...interactiveResults);
      }

      // Add to conversation history (text summary only). Empty on the computer
      // surface, where there is no page and often no browser (§4.6) — the
      // history line then simply carries no URL.
      const currentUrl = browserTracker.hasActive() ? session.page.url() : '';
      conversationHistory.push(
        formatStepHistoryEntry(
          i + 1,
          redact(instruction, secretsNow()),
          stepResult.status === 'passed',
          currentUrl,
        ),
      );
      // The steps a return skips are NOT added to the history, so without this
      // line a later step would see an unexplained gap in the numbering and
      // have to guess what happened in it (story decision 4).
      if (stepResult.flowControl) {
        conversationHistory.push(
          `[flow] step ${i + 1} ${stepResult.aiExplanation ?? 'returned'} — the rest of that flow was skipped`,
        );
      }
      // The same problem one step on: the entry above says this step failed and the
      // next says the run carried on regardless, so without this line the model
      // reads a framework that ignored a failure (decision 6).
      if (stepResult.tolerated) {
        conversationHistory.push(toleratedHistoryLine(i + 1));
      }

      // ── runnerControl from the AI clarification REPL ───────────────────────
      // The user took control inside the clarification prompt (typed /repl,
      // then /resume or /exit). Honour that BEFORE the failure-handoff path —
      // a /exit must be final, not re-trigger the failure REPL on top.
      if (stepResult.runnerControl) {
        humanIntervened = true;
        if (stepResult.runnerControl.adHocResults) {
          for (const ad of stepResult.runnerControl.adHocResults) {
            const adCaptures = computeStepCaptures(ad, resolvedParameters);
            if (adCaptures) ad.outputs = adCaptures;
          }
          stepResults.push(...stepResult.runnerControl.adHocResults);
          for (const ad of stepResult.runnerControl.adHocResults) {
            conversationHistory.push(
              formatStepHistoryEntry(
                ad.index,
                redact(`(interactive) ${ad.instruction}`, secretsNow()),
                ad.status === 'passed',
                session.page.url(),
              ),
            );
          }
        }
        if (stepResult.runnerControl.kind === 'resume') {
          conversationHistory.push(
            `[interactive] user resumed test at step ${stepResult.runnerControl.fromStepIndex} from clarification REPL`,
          );
          timeoutDeadline = Date.now() + testTimeout;
          i = stepResult.runnerControl.fromStepIndex - 2;
          tokenTracker.resetStep();
          continue;
        }
        // kind === 'exit' — user chose to abort. Don't drop into the failure REPL.
        bail = true;
        continue;
      }

      if (stepResult.interrupted) {
        // A Stop that landed mid-step (issues/020): the executor answers it
        // with an `interrupted` row, not a failure. The run ends the way the
        // guard's abort catch ends it — the report marked `aborted` — and
        // nobody is asked about a step the user ended.
        logger.info(`Run stopped at step ${i + 1}`);
        aborted = true;
        bail = true;
      } else if (stepResult.status === 'failed' && stepResult.tolerated) {
        // `otherwise continue` (stories/step-failure-outcomes.md, decision 6). The
        // row stays a failure but nothing else happens: no `bail`, no failure REPL,
        // no `overallStatus` change, and the `afterEach` hooks below run as for any
        // completed step. WARN rather than error, because a red line for a failure
        // the author asked to carry past trains a reader to ignore red lines.
        logger.warn(toleratedLogLine(i + 1, stepResult.error));
      } else if (stepResult.status === 'failed') {
        logger.error(`Step ${i + 1} FAILED: ${stepResult.error ?? 'unknown error'}`);

        const canEnterRepl =
          config.execution.interactiveOnFailure &&
          config.browser.headed &&
          Boolean(process.stdout.isTTY);

        if (canEnterRepl) {
          humanIntervened = true;
          const executorOptions: StepExecutorOptions = {
            page: session.page,
            config,
            aiClient,
            contextContent,
            testName: test.title,
            ...(baseUrl !== undefined && { baseUrl }),
            conversationHistory: [...conversationHistory],
            apiResponseStore,
            csrfTokens,
            uploadPaths,
            resolvedParameters,
            pageTracker: session.pageTracker,
            browserTracker,
            dismissalGuidance: hooks.hasAny,
            stats: statsFor(),
          };
          const adHocResults: StepResult[] = [];
          // §5.9 — the failure REPL waits for a person too.
          releaseLockForPause('failure REPL');
          const decision = await runInteractiveRepl({
            page: session.page,
            testSteps: test.steps,
            currentStepIndex: i + 1,
            entryReason: 'failure',
            executorOptions,
            adHocResults,
          });

          for (const ad of adHocResults) {
            const adCaptures = computeStepCaptures(ad, resolvedParameters);
            if (adCaptures) ad.outputs = adCaptures;
          }
          stepResults.push(...adHocResults);
          for (const ad of adHocResults) {
            conversationHistory.push(
              formatStepHistoryEntry(
                ad.index,
                redact(`(interactive) ${ad.instruction}`, secretsNow()),
                ad.status === 'passed',
                session.page.url(),
              ),
            );
          }

          if (decision.kind === 'resume') {
            stepResult.interactiveResumed = true;
            conversationHistory.push(
              `[interactive] user resumed test at step ${decision.fromStepIndex}`,
            );
            // Extend the test timeout so the user's debugging time isn't billed against it
            timeoutDeadline = Date.now() + testTimeout;
            // Pre-decrement so the next `i++` lands on the chosen index
            i = decision.fromStepIndex - 2;
            tokenTracker.resetStep();
            continue;
          }

          if (decision.kind === 'continue') {
            // User chose to leave the failed step as failed and proceed with
            // the next step anyway. Don't bail — fall through to the normal loop.
            conversationHistory.push(
              `[interactive] user continued past failed step ${i + 1}`,
            );
            timeoutDeadline = Date.now() + testTimeout;
          } else {
            // /exit — abort the run.
            bail = true;
          }
        } else {
          bail = true;
        }
      } else {
        logger.success(`Step ${i + 1} passed`);
      }

      // Run `afterEach` hooks — skipped on [no-hooks] steps or if the step
      // bailed (we're about to abort anyway).
      if (!bail && hooks.afterEach.length > 0 && !stepSkipsHooks) {
        const postResult = await runHookScope(
          'afterEach',
          hooks.afterEach,
          hooks.toolCalls.afterEach,
          hooks.sourceSkills.afterEach,
          i + 1,
        );
        if (postResult.failed) {
          logger.error(`'afterEach' hook after step ${i + 1} failed — aborting test: ${postResult.error}`);
          bail = true;
        }
      }

      // ── The step ended the flow it was in ───────────────────────────────
      //
      // Last thing in the loop body, and that position is the story's: the
      // returning step is an ordinary passed step, so it has already run its
      // `afterEach` hooks above (decision 4). Everything from here to the end
      // of its frame is skipped — no hooks, no tokens, no screenshot, and no
      // conversation history, which is why the returning step's own history
      // line says it returned: a later step needs to know why the gap is
      // there (stories/step-flow-control.md).
      if (!bail && stepResult.flowControl) {
        const label = frameLabel(test.expansion?.origins, test.expansion?.frames, i);
        // `stepLimit` still bounds the run: a prefix replay
        // (`stopAfterStep`) must not report steps it was never going to
        // reach as skipped. `returnExit` then clamps that to the innermost
        // control body around the returning step, because an iteration is a
        // flow too — a return inside a loop body ends the PASS, and the loop
        // re-evaluates (stories/control-flow.md §"Composition with
        // `If … then return`").
        const { exit, enclosed } = returnExit(
          controls,
          i,
          Math.min(
            frameExitIndex(test.expansion?.origins, test.expansion?.frames, i, test.steps.length),
            stepLimit - 1,
          ),
        );
        // The returning step's AUTHORED line rides on every reason string, so
        // a reader who only has the editor can find the step that ended the
        // flow (the `step N` half is the expanded index, which the editor does
        // not number by). Authored, never interpolated — see
        // `skippedByReturnReason`.
        const returningText = test.expansion?.rawSteps[i] ?? test.steps[i] ?? '';
        for (let j = i + 1; j <= exit; j++) {
          const skipped = skippedByReturn(j, test.steps[j] ?? '', i, label, returningText);
          const skippedSkill = test.sourceSkills[j] ?? null;
          if (skippedSkill) skipped.sourceSkill = skippedSkill;
          const skippedSection = test.sourceSections[j] ?? null;
          if (skippedSection) skipped.sourceSection = skippedSection;
          // Which pass these rows belong to, stamped exactly as an executed
          // step's is above. Without it the report's iteration band broke at
          // precisely the rows a return produced: `Click Next` and the guard
          // inside the band, the step after the return outside it and
          // indistinguishable from the same row on the next pass. The other
          // skip producer (`flushSkips`) has always stamped it, so a report
          // showed one kind of skip inside the band and the other outside.
          const skippedLoop = loops.markerFor(j);
          if (skippedLoop) skipped.loop = skippedLoop;
          // Deliberately NOT through `recordLastRun`: the sidecar answers
          // "which entries does the next compile need to regenerate", and a
          // step that never ran is no evidence either way (decision 12).
          stepResults.push(skipped);
          logger.info(`Step ${j + 1} skipped — ${skipped.aiExplanation}`);
        }
        // `i++` follows the `continue`, so aim one short of where the run
        // resumes. Inside a control body the planner has the last word — back
        // to a loop's guard, or out past the chain the member belonged to; in
        // the main flow it must NOT be consulted, or a test whose last step
        // closes a loop would jump back into the loop the return just skipped.
        i = enclosed ? advanceAfter(exit) - 1 : exit;
        tokenTracker.resetStep();
        continue;
      }

      tokenTracker.resetStep();

      // A step that closes a loop body sends the run back to its guard rather
      // than to the next line — the jump-back the flat step list never grows
      // to accommodate (stories/control-flow.md, decision 8). `i++` follows,
      // so aim one short. A no-op everywhere else.
      if (hasControls) i = advanceAfter(i) - 1;
    }

    // Anything the last decision skipped and nothing has moved past yet — an
    // `Otherwise` whose body was the end of the test, most often.
    if (hasControls) flushSkips('all');

    // Run `after` hooks — best effort, failures logged but don't flip test status.
    if (hooks.after.length > 0) {
      const afterResult = await runHookScope(
        'after',
        hooks.after,
        hooks.toolCalls.after,
        hooks.sourceSkills.after,
        test.steps.length + 1,
      );
      if (afterResult.failed) {
        logger.warn(`'after' hook failed (test status unchanged): ${afterResult.error}`);
      }
    }

    // The code-behind last-run sidecar. Runs no longer write code-behind, so
    // this is the only thing they leave for the next compile — which steps ran
    // as code, and which had an entry that broke and healed under AI.
    //
    // Only the first row writes it. Both this and the recording below are
    // last-writer-wins on disk, so five rows would leave row 5's behind for
    // the next compile to read — and a compile records row 1
    // (stories/data-driven-rows.md, decision 11).
    if (keepLastRun && lastRunSteps.length > 0 && (dataRowIndex ?? 0) === 0) {
      await writeLastRun(test.filePath, lastRunSteps);
    }

    // A hook step a Stop cut short comes back `interrupted` too, and ends its
    // scope as a failure would — without passing the main loop's check above.
    // Whichever row it was, a stopped run reports as stopped.
    if (stepResults.some((s) => s.interrupted === true)) aborted = true;

    const durationMs = Date.now() - startTime;
    const passedSteps = stepResults.filter((s) => s.status === 'passed').length;
    // `&& !s.interrupted`, the same filter the server uses
    // (session-manager.ts). The row the abort catch above pushes is
    // `status: 'failed', interrupted: true` — a step that was stopped, not one
    // that went wrong — so counting it made a stopped CLI run write
    // `failedSteps: 1, status: 'failed'` where the same stop on the server
    // wrote `failedSteps: 0` and issue 021's amber `aborted` state (review 3,
    // finding 11).
    // `&& !s.tolerated` widens that same filter a second time and for the same
    // reason: a step the author said to carry past is a failure nobody stopped on,
    // so it is not what makes a run red (decision 6). Not silently dropped either
    // — `toleratedSteps` below counts it, and the row still says `failed`.
    const failedSteps = stepResults.filter(
      (s) => s.status === 'failed' && !s.interrupted && !s.tolerated,
    ).length;
    const toleratedSteps = stepResults.filter((s) => s.status === 'failed' && s.tolerated).length;
    const totalSubActions = stepResults.reduce((sum, s) => sum + s.turns.reduce((tSum, t) => tSum + t.subActions.length, 0), 0);
    const skippedSteps = stepResults.filter((s) => s.status === 'skipped').length;
    overallStatus = failedSteps > 0 || timedOut || strictLoadError !== undefined ? 'failed' : 'passed';

    // The recording, beside the test, when this run was asked to capture —
    // which is a compile's Record (stories/codebehind-recording-on-disk.md).
    // Written here, once the run is over, and never kept in memory past it.
    if (extras.captureStepContext && (dataRowIndex ?? 0) === 0) {
      await writeRecording(test.filePath, {
        steps: stepResults,
        status: overallStatus,
        startedAt: new Date(startTime).toISOString(),
        parameters: resolvedParameters,
        ...(test.envData && { secrets: envDataSecretValues(test.envData) }),
        source: 'cli',
      });
    }

    logger.testEnd(test.title, overallStatus === 'passed', durationMs);
    logger.info(`Tokens used: ${tokenTracker.getSummary()}`);

    // Steps that passed only because a broken entry healed under AI. Counted
    // by the same helper the report's origins row uses, so the banner and that
    // row can never disagree — and it already excludes hook and ad-hoc rows,
    // which are not steps of the test.
    const healedSteps = countStepOrigins(stepResults).stale;
    // Everything downstream of here — the HTML report, the diagnosis prompt,
    // the run-history line, `steptix run`'s failed-steps summary — sees the
    // masked copy. The step results themselves (and the recording written
    // above, which masks on its own) keep the values the run used.
    report = redactReport({
      testName: test.title,
      filePath: test.filePath,
      tags: test.frontmatter.tags,
      status: overallStatus,
      steps: stepResults,
      totalSteps: test.steps.length,
      passedSteps,
      failedSteps,
      // Omitted (not 0) on a run that skipped nothing, so a report only grows
      // the field when there is something to say.
      //
      // It counts every `skipped` result, which is MORE than the returns:
      // `executeBranchedStep` has always marked the unmatched branches of a
      // conditional group `skipped`, and nothing ever counted them. So a test
      // with conditional groups grows a Skipped tile it did not have before.
      // That is the intended change and not a leak from this feature — see the
      // field's doc comment in report/types.ts. The alternative, counting only
      // the rows a return produced, would print "4/5 passed" over a report
      // whose fifth row already said SKIPPED.
      ...(skippedSteps > 0 && { skippedSteps }),
      // Omitted (not 0) on a run that tolerated nothing, the rule `skippedSteps`
      // sets: an unchanged run writes an unchanged report. The header reads "7
      // passed, 1 tolerated" when it is there (decision 6).
      ...(toleratedSteps > 0 && { toleratedSteps }),
      totalSubActions,
      durationMs,
      tokensUsed: tokenTracker.total,
      inputTokens: tokenTracker.inputTotal,
      outputTokens: tokenTracker.outputTotal,
      date: new Date().toISOString(),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(Object.keys(resolvedParameters).length > 0 && { parameters: resolvedParameters }),
      ...(humanIntervened && { humanIntervened: true }),
      // The amber "stopped" badge rather than a red failure: the run did not
      // fail, it was stopped (issue 021's state, reached from the CLI for the
      // first time here).
      ...(aborted && { aborted: true }),
      // Omitted (not 0) on a run that healed nothing: an unchanged run writes
      // an unchanged report. `status` above stays 'passed' on purpose — see
      // the field's doc comment in report/types.ts.
      ...(healedSteps > 0 && {
        healedSteps,
        ...(healedTokens > 0 && { healedTokens }),
      }),
      ...(strictLoadError !== undefined && { error: strictLoadError }),
    }, secretsNow());

    // The author already wrote the root cause (stories/step-failure-outcomes.md,
    // decision 2), so an AI paragraph guessing at it would sit ABOVE their sentence
    // in the report. Read off the failing steps rather than a run-level flag,
    // because a run can fail for more than one reason and only an all-deliberate
    // one has nothing to diagnose.
    const failuresToDiagnose = stepResults.filter(
      (s) => s.status === 'failed' && !s.interrupted && !s.tolerated,
    );
    const deliberateFailure =
      failuresToDiagnose.length > 0 && failuresToDiagnose.every((s) => s.deliberate === true);

    // Never on a run the user stopped: a diagnosis of "why did this fail"
    // spends tokens answering a question nobody asked.
    if (
      overallStatus === 'failed' &&
      !aborted &&
      !deliberateFailure &&
      config.ai.diagnoseFailures &&
      !keyless &&
      // A diagnosis reads the page it failed on. A run that never launched a
      // browser (§4.6) has none, and the one thing worse than no diagnosis is
      // a crash inside the teardown that was about to write the report.
      browserTracker.hasActive()
    ) {
      logger.info('Running failure diagnosis…');
      const diagnosis = await diagnoseFailure(report, session.page, aiClient, contextContent, {
        ...config.browser.domNoiseReduction,
        maxIframeDepth: config.browser.maxIframeDepth,
        domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
      });
      if (diagnosis) {
        // The diagnosis reads the live page, where a typed secret can still
        // sit in an input — so its prose is masked like the rest.
        report.diagnosis = redactDeep(diagnosis, secretsNow());
        report.tokensUsed = tokenTracker.total;
        report.inputTokens = tokenTracker.inputTotal;
        report.outputTokens = tokenTracker.outputTotal;
        logger.info(`Likely cause (${diagnosis.faultCategory}, ${diagnosis.confidence} confidence): ${diagnosis.rootCause}`);
      }
    } else if (
      overallStatus === 'failed' &&
      !aborted &&
      !deliberateFailure &&
      config.ai.diagnoseFailures
    ) {
      // Keyless. `diagnoseFailures` stays default-true — keyless is a runtime
      // condition, not a config edit the user should have to know to make — so
      // the run says why it skipped rather than silently producing a report
      // with no analysis in it. The note goes in the diagnosis slot itself, so
      // the HTML report shows it exactly where the analysis would have been
      // with no rendering change; the other fields are the least-claiming
      // values the type allows, because this is a placeholder rather than an
      // analysis (stories/keyless-replay-and-gateway-env.md §Part B).
      // Which of the two reasons put us here decides what to say: a run with a
      // working key that was told not to spend it is not an unconfigured one.
      const skipNote = aiAllowed ? KEYLESS_DIAGNOSIS_SKIPPED : POLICY_DIAGNOSIS_SKIPPED;
      logger.info(skipNote);
      report.diagnosis = {
        rootCause: skipNote,
        faultCategory: 'unknown',
        evidence: [],
        suggestedFix: '',
        confidence: 'low',
      };
    }

    // A run of its own writes its run line here (§8.2): a compile's runs,
    // which write no report. Counted after the diagnosis, whose call belongs to
    // the run. Flushed in the `finally` below, because the process may exit
    // straight after — `steptix compile` does, on success and on a throw alike.
    if (ownsStats) {
      recordRunEnd(runStats, {
        status: report.status,
        aborted: report.aborted,
        tokensIn: report.inputTokens,
        tokensOut: report.outputTokens,
        report: null,
      });
    }

    return report;
  } finally {
    // The computer lock, before anything else in this teardown
    // (SPEC-use-computer.md §5.9): held only while a run executes, so it is
    // given back at the end of every `runTest` — pass, failure, bail, stop or
    // throw — by the same function the server's step loop ends a batch with.
    // First, because everything below can throw and a stranded lock stops the
    // NEXT run on this machine dead — the one failure mode §5.9's stale-pid
    // takeover exists to soften, not to excuse. A no-op for the runs that
    // never took it.
    //
    // A data row is one `runTest`, so this releases once per row. The next
    // row takes the lock again at its own `[use computer]`: `surfaceState` is
    // local to this call, so every row starts on the browser surface and
    // enters computer mode afresh. WITHIN a row the lock can still come and
    // go — a pause for a person gives it back — and the step boundary in the
    // loop takes it again, as the server's does.
    releaseComputerLockAtRunEnd(surfaceState, computerLockId, extras.computerLock);

    // Close all tracked browsers in reverse creation order. For the
    // single-browser path (no openBrowser ever called), this is just the
    // initial session — same teardown as before. CDP sessions are handled
    // specially by closeBrowser; non-CDP sessions go through tracker.
    //
    // Video recording finalises on context close (Playwright writes the .webm
    // there), so the close is routed through finalizeMainPageVideo: it grabs
    // the main page's video handle, closes the browser(s), then saves/renames
    // (or, for retain-on-failure on a pass, deletes) the file. The resulting
    // relative path is written back onto the hoisted `report` so the
    // already-`return`ed object carries `videoRelPath` (try/return/finally
    // same-object mutation). Recording failures never break teardown.
    //
    // `initialSession` is undefined when the run never launched a browser
    // (§4.6) — a desktop-only test, or a failure before step 1. `closeAll()`
    // over an unlaunched tracker is already a no-op, so the else arm is the
    // right fallback, not a special case.
    const closeContext = async (): Promise<void> => {
      if (initialSession?.cdp) {
        await closeBrowser(initialSession);
      } else {
        await browserTracker.closeAll();
      }
    };
    if (report) {
      const savedAbs = await finalizeMainPageVideo({
        // `undefined` on a run that never launched (§4.6). The helper takes it
        // optional and still runs `closeContext()`, so teardown is unchanged;
        // there is simply no `.webm` to finalise.
        page: initialSession?.page,
        mode: videoMode,
        passed: overallStatus === 'passed',
        videoDir,
        stableBaseName: videoBaseNameFor(report, dataRowIndex),
        closeContext,
      });
      if (savedAbs) {
        // POSIX-style relative path so the report's <video src> resolves in a
        // browser regardless of host OS (Windows backslashes don't).
        report.videoRelPath = path
          .relative(config.reports.outputDir, savedAbs)
          .split(path.sep)
          .join('/');
      }
    } else {
      // No report was assembled (early throw before report construction) —
      // still close the browser(s) so nothing leaks.
      await closeContext();
    }
    removeFileBridges();
    setLogLevel(previousLevel);
    if (runLog) {
      runLog.stream.write(`# endedAt=${new Date().toISOString()}\n`);
      runLog.dispose();
    }
    // A run of its own flushes its scoreboard lines, pass or throw, bounded so
    // a stalled append cannot hold the process. A row of `runTests` leaves it
    // to `runTests`, which flushes once for the whole test.
    if (ownsStats) await flushRunStats();
  }
}

/**
 * Expand a ParsedTest into one or more TestInstances.
 * Data-driven tests (with dataFile) produce one instance per data row.
 */
export async function expandTestInstances(
  test: ParsedTest,
  config: Config,
  options: { row?: number } = {},
): Promise<TestInstance[]> {
  const projectRoot = process.cwd();

  // Rows come from a table under `## Steps` or from `dataFile:`, never both —
  // the parser refuses a file carrying the two.
  let dataRows: Array<Record<string, string>> | undefined;
  if (test.dataRows) {
    dataRows = test.dataRows;
    logger.info(`Data table: ${dataRows.length} row(s)`);
  } else if (test.frontmatter.dataFile) {
    const dataFilePath = test.frontmatter.dataFile;
    dataRows = await loadDataFile(dataFilePath, projectRoot);
    logger.info(`Data file: ${dataFilePath} (${dataRows.length} rows)`);
  }

  if (options.row !== undefined) {
    const total = dataRows?.length ?? 0;
    if (total === 0) {
      throw new Error(
        `--row ${options.row} was given but "${test.title}" has no rows. Add a ` +
          `table under \`## Steps\`, or drop the flag.`,
      );
    }
    if (options.row < 1 || options.row > total) {
      throw new Error(
        `--row ${options.row} is out of range: "${test.title}" has ${total} ` +
          `row(s), numbered 1 to ${total}.`,
      );
    }
  }

  if (dataRows && dataRows.length > 0) {
    // One instance per row. `--row` narrows *after* expansion so the surviving
    // instance keeps its original index: `--row 3` must still report row 3 of
    // 5, not row 1 of 1.
    const instances = await Promise.all(
      dataRows.map(async (row, index) => {
        const resolvedParameters = await resolveParameters(
          test.parameters,
          row,
          false, // Don't prompt user during data-driven expansion
        );
        return {
          test,
          dataRowIndex: index,
          dataRowCount: dataRows.length,
          dataRowValues: row,
          resolvedParameters,
        };
      }),
    );
    return options.row === undefined
      ? instances
      : instances.filter((i) => i.dataRowIndex === options.row! - 1);
  }

  // Single instance
  const resolvedParameters = await resolveParameters(test.parameters, undefined, true);
  return [{ test, resolvedParameters }];
}

/**
 * Run multiple tests and produce a summary.
 * Respects the --bail flag by stopping on the first failure.
 */
export async function runTests(
  tests: ParsedTest[],
  config: Config,
  options: {
    bail?: boolean;
    verbose?: boolean;
    /** 1-based: run only this data row. */
    row?: number;
    /**
     * Seam for tests. `runTests` boots real browsers, so the loop — rows,
     * `--bail`, and the merge below — is otherwise unreachable from a unit
     * test. Precedent: the compile pipeline's `createTestFileRunner`.
     */
    runTestFn?: typeof runTest;
  } = {},
): Promise<RunSummary> {
  // `steptix run` exits as soon as this returns — and calls `process.exit(1)` the
  // moment it throws — so an append still queued would die with the process.
  // Flushed in a `finally`, bounded, so a run that throws keeps the lines of
  // the steps it did run and a stalled disk cannot hold the exit.
  try {
    return await runTestsUnflushed(tests, config, options);
  } finally {
    await flushRunStats();
  }
}

/** {@link runTests} without the final scoreboard flush. */
async function runTestsUnflushed(
  tests: ParsedTest[],
  config: Config,
  options: Parameters<typeof runTests>[2] = {},
): Promise<RunSummary> {
  const runOne = options.runTestFn ?? runTest;
  const context = await loadContextFiles(config.tests.contextDir);

  if (context.files.length > 0) {
    logger.info(`Loaded ${context.files.length} context file(s)`);
  }

  const reports: TestReport[] = [];
  let bailed = false;
  let lastReportPath: string | undefined;

  for (const test of tests) {
    if (bailed) break;

    const instances = await expandTestInstances(test, config, {
      ...(options.row !== undefined && { row: options.row }),
    });

    // One test, one report — however many rows it has (decision 12). The rows
    // still run as separate instances with their own browsers and their own
    // redaction; only the writing is folded.
    const rowReports: RowReport[] = [];
    const unrun: Array<{ index: number; values: Record<string, string>; reason: string }> = [];
    // …and one scoreboard run, for the same reason: every row's lines carry
    // one run id, and the run line links the one report (SPEC-scoreboard.md
    // §8.1). Each row runs under a copy that adds its row number and shares
    // the tally the run line counts from.
    //
    // The switch is the TEST's project's, read from the root its lines are
    // filed under — not `config`'s, which is whichever `steptix.config.json` the
    // working directory holds (§6.4).
    const projectRoot = await resolveProjectRoot(test.filePath);
    const testStats = openRunStats({
      projectRoot,
      testFilePath: test.filePath,
      projectEnabled: await projectStatsSwitch(projectRoot, config),
    });

    for (const [position, instance] of instances.entries()) {
      if (bailed) {
        // A row the bail stopped us reaching still gets a line in the matrix
        // table. A matrix that silently omits what it skipped reads as if
        // those rows passed.
        if (instance.dataRowIndex !== undefined) {
          unrun.push({
            index: instance.dataRowIndex + 1,
            values: instance.dataRowValues ?? {},
            reason: 'stopped',
          });
        }
        continue;
      }

      const report = await runOne(instance, config, context.combined, {
        stats:
          instance.dataRowIndex === undefined
            ? testStats
            : { ...testStats, row: instance.dataRowIndex + 1 },
      });
      rowReports.push({
        report,
        ...(instance.dataRowIndex !== undefined && {
          dataRowIndex: instance.dataRowIndex,
          dataRowCount: instance.dataRowCount ?? instances.length,
          dataRowValues: instance.dataRowValues ?? {},
          secrets: runSecrets({
            parameters: instance.resolvedParameters,
            ...(test.envData && { envData: test.envData }),
          }),
        }),
      });

      if (report.status === 'failed' && options.bail) {
        logger.warn(
          instances.length > 1
            ? `Bailing on first failure (--bail flag set) — row ${position + 1} of ${instances.length}`
            : 'Bailing on first failure (--bail flag set)',
        );
        bailed = true;
      }
    }

    if (rowReports.length === 0) continue;

    const merged = mergeRowReports(rowReports, unrun);
    reports.push(merged);

    const reportPath = await generateReport(merged, config.reports.outputDir);
    lastReportPath = reportPath;
    logger.info(`Report saved: ${path.relative(process.cwd(), reportPath)}`);
    // The run line, beside the report it links (§8.2), with the merged
    // report's own token counts — what the report shows is what it records.
    recordRunEnd(testStats, {
      status: merged.status,
      aborted: merged.aborted,
      tokensIn: merged.inputTokens,
      tokensOut: merged.outputTokens,
      report: path.resolve(reportPath),
    });

    // Once per test, not once per row: a five-row run used to spend five of
    // the ten-entry history cap on one execution.
    if (config.reports.appendRunHistoryToTestFile) {
      await appendRunHistory(
        test.filePath,
        reportPath,
        merged.status,
        merged.date,
        getPrimaryModel(merged),
      );
    }
  }

  if (lastReportPath && config.reports.openInBrowserAfterRun && !process.env['CI']) {
    openInDefaultBrowser(lastReportPath);
  }

  const totalTests = reports.length;
  const passedTests = reports.filter((r) => r.status === 'passed').length;
  const failedTests = reports.filter((r) => r.status === 'failed').length;
  const totalDurationMs = reports.reduce((sum, r) => sum + r.durationMs, 0);
  const totalTokensUsed = reports.reduce((sum, r) => sum + r.tokensUsed, 0);
  const totalInputTokens = reports.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = reports.reduce((sum, r) => sum + r.outputTokens, 0);

  return {
    totalTests,
    passedTests,
    failedTests,
    totalDurationMs,
    totalTokensUsed,
    totalInputTokens,
    totalOutputTokens,
    reports,
  };
}

/**
 * Filter a list of parsed tests by required tags.
 * All specified tags must match (AND logic).
 */
export function filterByTags(tests: ParsedTest[], tags: string[]): ParsedTest[] {
  if (tags.length === 0) return tests;
  return tests.filter((test) =>
    tags.every((tag) => test.frontmatter.tags.includes(tag)),
  );
}

/** Parse a timeout string like "60s" or "2m" into milliseconds */
export function parseTimeoutMs(timeout?: string): number | undefined {
  if (!timeout) return undefined;

  const match = timeout.match(/^(\d+(?:\.\d+)?)\s*(s|m|ms)?$/i);
  if (!match) return undefined;

  const value = parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'ms').toLowerCase();

  switch (unit) {
    case 's': return Math.round(value * 1_000);
    case 'm': return Math.round(value * 60_000);
    case 'ms':
    default: return Math.round(value);
  }
}

function openInDefaultBrowser(filePath: string): void {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
    logger.info(`Opening report in default browser: ${path.relative(process.cwd(), filePath)}`);
  } catch (err) {
    logger.warn(`Failed to open report in browser: ${String(err)}`);
  }
}
