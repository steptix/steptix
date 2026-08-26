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
import type { ParsedTest, TestConfig, TestInstance } from '../parser/types.js';
import type { TestReport, StepResult, RunSummary } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { launchBrowser, closeBrowser, BrowserTracker, resolveVideoMode, finalizeMainPageVideo, type CdpLaunchOptions } from '../browser/manager.js';
import { executeStep, executeBranchedStep } from './step-executor.js';
import type { StepExecutorOptions } from './step-executor.js';
import { identifyStepGroups } from './step-grouper.js';
import { resolveHooks, type ResolvedHooks } from './hooks.js';
import { runInteractiveRepl } from './interactive-repl.js';
import { loadContextFiles } from '../context/loader.js';
import { resolveParameters, loadDataFile, interpolate } from '../parser/parameters.js';
import { generateReport, getPrimaryModel, buildReportBaseName } from '../report/generator.js';
import { appendRunHistory } from '../report/history-appender.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { diagnoseFailure } from '../ai/diagnose.js';
import { logger, setLogLevel, getLogLevel, type ConsoleLogLevel } from '../utils/logger.js';
import { openRunLogFile, attachRunLogBridges } from '../utils/run-log.js';
import { ApiResponseStore } from '../api/response-store.js';
import { StepCache, envCacheSegment, cacheDirName } from '../cache/step-cache.js';
import { resolveProjectRoot } from '../server/project-root.js';
import { loadToolCatalogue, ToolCatalogue } from '../tools/registry.js';
import { executeToolStep } from '../tools/executor.js';
import type { ToolCall } from '../tools/types.js';
import { buildCodeBehindRegistry, CodeBehindRegistry } from '../codebehind/loader.js';
import { writeLastRun, type LastRunStep } from '../codebehind/last-run.js';
import { writeRecording } from '../codebehind/recording.js';
import { envDataSecretValues } from '../parser/interpolate-env-data.js';
import { redact, redactDeep, redactReport, runSecrets } from '../utils/secrets.js';

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
    .filter((sa) => !sa.error && (sa.action.action === 'read' || sa.action.action === 'count'))
    .map((sa) => sa.action.as)
    .filter((name): name is string => !!name && !name.startsWith('__skill'))
    .reduce<Record<string, string>>((acc, name) => {
      if (name in resolvedParameters) acc[name] = resolvedParameters[name]!;
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
 * The env a test ACTUALLY runs under, used to namespace its cache (issue 012).
 *
 * A run-wide `--env`/`AUTOMATION_ENV` (`runEnvName`) WINS over the test's
 * frontmatter `env:`. This mirrors run.ts's precedence: the CLI flag is honoured
 * unconditionally, and a test's frontmatter env is consulted ONLY when no
 * run-wide env is set. Keying the cache by anything else would read entries
 * written under the env the test did not run under. Returns `undefined` when
 * neither is set (callers fall back to the `default` env segment).
 *
 * Pure and browser-free so the CLI cache seam is unit-testable.
 */
export function resolveEffectiveEnv(
  runEnvName: string | undefined,
  frontmatterEnv: string | undefined,
): string | undefined {
  return runEnvName || frontmatterEnv?.trim() || undefined;
}

/**
 * Env-namespaced cache base directory: `<cacheBaseDir>/<env-segment>` (issue
 * 012). Pure and browser-free so the CLI cache seam is unit-testable.
 */
export function resolveTestCacheBase(cacheBaseDir: string, effectiveEnv?: string): string {
  return path.join(cacheBaseDir, envCacheSegment(effectiveEnv));
}

/**
 * Full per-run cache directory: `<cacheBaseDir>/<env-segment>/<basename>-<hash>`
 * (issues 012/027/028). This is the directory `runTest` actually writes to —
 * `StepCache.initialize(resolveTestCacheBase(...), cacheDirName(...))` yields
 * exactly this path because `cacheDirName` is idempotent under the
 * `sanitizeTestName` that `initialize` applies to its `testName` argument.
 * Exposed purely so tests can assert the path without driving a browser.
 */
export function cacheDirForRun(
  cacheBaseDir: string,
  effectiveEnv: string | undefined,
  testFilePath: string,
  projectRoot?: string | null,
): string {
  return path.join(
    resolveTestCacheBase(cacheBaseDir, effectiveEnv),
    cacheDirName(testFilePath, projectRoot),
  );
}

/**
 * The code-behind knobs `aiui compile` needs from a run, and nothing else.
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
  /** Abort signal, threaded into every step. */
  signal?: AbortSignal;
}

/**
 * Run a single test instance (ParsedTest with resolved parameters).
 * Handles browser lifecycle, step execution, and report generation.
 */
export async function runTest(
  instance: TestInstance,
  config: Config,
  contextContent: string,
  runEnvName?: string,
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

  const baseUrl = test.config.baseUrl;
  const conversationHistory: string[] = [];
  const csrfTokens: Record<string, string> = {};

  // Always initialize cache — used for assertion code even when action caching is off.
  // StepCache.initialize is idempotent (creates dir, writes meta). The stepCache
  // reference is passed to all steps; action caching is further gated by config.cache.enabled.
  //
  // Cache layout is env-namespaced (issue 012) and keyed by a stable path-derived
  // directory name rather than the test title (issues 027/028). The env the test
  // ACTUALLY runs under wins: a run-wide --env/AUTOMATION_ENV (runEnvName) overrides
  // the test's frontmatter env, matching run.ts's precedence (frontmatter only when
  // no run-wide env is set). Final dir: <cache.dir>/<env-segment>/<basename>-<hash>/.
  const effectiveEnv = resolveEffectiveEnv(runEnvName, test.frontmatter.env);
  const projectRoot = await resolveProjectRoot(test.filePath);
  const baseDir = resolveTestCacheBase(config.cache.dir, effectiveEnv);
  const stepCache = await StepCache.initialize(baseDir, cacheDirName(test.filePath, projectRoot), test.steps);

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
    : openRunLogFile(test.title, config.reports.outputDir);
  if (runLog) {
    runLog.stream.write(
      `# test=${test.title} startedAt=${new Date().toISOString()} steps=${test.steps.length} mode=${fileMode}\n`,
    );
    logger.info(`Run log: ${runLog.path}`);
  }
  // What this run must never print (stories/secret-redaction.md): the values
  // of its secret-named parameters and of the env/data secrets its `${…}`
  // references resolved against. Read fresh each time — captures add to it.
  const secretsNow = (): string[] => runSecrets({ parameters: resolvedParameters, envData: test.envData });
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
  // Video recording (Tier 1 — main page only). Resolve the mode once and pass
  // the absolute videos/ dir so launchBrowser attaches recordVideo on the
  // non-CDP path; the .webm is finalised + named in the `finally` below.
  const videoMode = resolveVideoMode(config.browser.video);
  const videoDir = path.resolve(config.reports.outputDir, 'videos');
  const initialSession = await launchBrowser(config.browser, cdpOptions, {
    videoDir,
    // §4's provenance half. Present whenever a size is in effect, so a
    // project-wide pin (§8) is named as such rather than looking like the
    // test's own choice.
    ...(config.browser.fixedViewport
      ? { viewportSource: describeViewportSource(test.config.viewport) }
      : {}),
  });
  const browserTracker = new BrowserTracker(initialSession);
  // `session` is a *snapshot* of the current active browser — re-read from
  // the tracker before/after each step so openBrowser/switchBrowser actions
  // can transparently shift which browser subsequent steps target.
  let session = browserTracker.getActive();

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
  // front, and carry the result into the executor like `stepCache`. A missing
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

  // Hoisted so the `finally` can read the run outcome + mutate the report after
  // the browser is closed (to attach `videoRelPath`). `report` is assigned the
  // SAME object that's returned, so the in-`finally` mutation is visible to the
  // `return report` in the `try` (try/return/finally same-object semantics).
  let report: TestReport | undefined;
  let overallStatus: 'passed' | 'failed' = 'failed';

  try {
    // Navigate to base URL if provided
    if (baseUrl) {
      logger.info(`Navigating to base URL: ${baseUrl}`);
      await session.page.goto(baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }

    const stepResults: StepResult[] = [];
    let timeoutDeadline = Date.now() + testTimeout;
    let bail = false;
    let humanIntervened = false;

    /**
     * The code-behind slice of `StepExecutorOptions` for expanded step `i`.
     * Spread rather than assigned so a step with no binding adds no key —
     * `exactOptionalPropertyTypes` refuses an explicit `undefined`.
     */
    const codeBehindOptionsFor = (
      i: number,
    ): Pick<
      StepExecutorOptions,
      'codeBehind' | 'codeBehindStrict' | 'captureStepContext' | 'signal' | 'envData'
    > => {
      const binding = codeBehind.bindingFor(i);
      return {
        ...(binding && { codeBehind: binding }),
        // The context the parser resolved `${data.url}` with, so the entry's
        // `step.getVar('data.url')` reads the same value.
        ...(test.envData && { envData: test.envData }),
        ...(extras.codeBehindStrict !== undefined && { codeBehindStrict: extras.codeBehindStrict }),
        ...(extras.captureStepContext !== undefined && {
          captureStepContext: extras.captureStepContext,
        }),
        ...(extras.signal && { signal: extras.signal }),
      };
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
      lastRunSteps.push({
        index: i + 1,
        source: binding?.source ?? test.expansion?.rawSteps[i] ?? test.steps[i] ?? '',
        ...(binding?.section !== undefined && { section: binding.section }),
        // The entry's target file, so a later repair cannot conflate a
        // skill-body step with an identically-worded test step. The sidecar is
        // rewritten wholesale, so omitting it here would make every row unfiled
        // after a CLI run and silently restore the conflation.
        ...(binding?.file !== undefined && { file: binding.file }),
        status: result.status,
        fromCodeBehind: result.fromCodeBehind === true,
        stale: stale !== undefined,
        ...(stale && { error: stale.error }),
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
      const activePage = session.pageTracker.getActive();
      const outcome = await executeToolStep(call, {
        page: activePage,
        context: session.context,
        browser: session.browser,
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
      for (let idx = 0; idx < instructions.length; idx++) {
        const raw = instructions[idx]!;
        const toolCall = toolCalls[idx] ?? null;
        const sourceSkill = sourceSkills[idx] ?? null;
        const hookInstruction = interpolate(raw, resolvedParameters);

        let result: StepResult;
        if (toolCall) {
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
            resolvedParameters,
            pageTracker: session.pageTracker,
            browserTracker,
            dismissalGuidance: hooks.hasAny,
            // No stepCache — hook results are usually page-state-dependent
            // (e.g., "accept cookie banner if visible") and shouldn't be replayed blindly.
          });
        }

        result.hookScope = scope;
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
              `(${scope} hook) ${hookInstruction}`,
              result.status === 'passed',
              session.page.url(),
            ),
          );
        }

        if (result.status === 'failed') {
          return {
            failed: true,
            error: result.error ?? `${scope} hook failed`,
          };
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
        break;
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
      if (group && i === group.conditionalSteps[0]!.index) {
        // Start of a conditional group — execute as branched step
        logger.info(`Conditional group detected at step ${i + 1}: ${group.conditionalSteps.length} conditional + 1 continuation`);

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
          resolvedParameters,
          pageTracker: session.pageTracker,
          browserTracker,
          stepCache,
          cacheEnabled: config.cache.enabled,
          dismissalGuidance: hooks.hasAny,
        });

        for (const result of branchedResults) {
          // Tag with originating skill / section if any (result.index is 1-based).
          const branchSourceSkill = test.sourceSkills[result.index - 1] ?? null;
          if (branchSourceSkill) result.sourceSkill = branchSourceSkill;
          const branchSourceSection = test.sourceSections[result.index - 1] ?? null;
          if (branchSourceSection) result.sourceSection = branchSourceSection;
          // Unlike the server path (whose MCP-facing `results` array never
          // includes branched steps at all — a different surface than this
          // report), the CLI does render branched steps, so there's no
          // parity reason to withhold their captures here.
          const branchCaptures = computeStepCaptures(result, resolvedParameters);
          if (branchCaptures) result.outputs = branchCaptures;
          stepResults.push(result);
          const url = session.page.url();
          conversationHistory.push(
            formatStepHistoryEntry(result.index, result.instruction, result.status === 'passed', url),
          );

          if (result.status === 'failed') {
            logger.error(`Step ${result.index} FAILED: ${result.error ?? 'unknown error'}`);
            bail = true;
          } else if (result.status === 'skipped') {
            logger.info(`Step ${result.index} skipped (conditional not matched)`);
          } else {
            logger.success(`Step ${result.index} passed`);
          }
        }

        // Skip past all steps in this group (they've been handled)
        i = group.continuationStep.index;
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
      session = browserTracker.getActive();

      const rawInstruction = test.steps[i] ?? '';
      // Interpolate {{placeholders}} in step text
      const instruction = interpolate(rawInstruction, resolvedParameters);

      // The one log line that ignores the log level — so the one place the
      // resolved password would always print. Masked; the step itself runs
      // with the real value.
      logger.step(i + 1, test.steps.length, redact(instruction, secretsNow()));

      // Handle [input: variable_name] steps — pause for user input
      const inputStep = parseInputStep(instruction);
      const interactiveStep = !inputStep ? parseInteractiveStep(instruction) : null;
      const outputStep = !inputStep && !interactiveStep ? parseOutputStep(instruction) : null;
      let stepResult: StepResult;
      let interactiveResults: StepResult[] = [];

      if (inputStep) {
        const stepStartTime = Date.now();
        const value = await promptUserForInput(inputStep.promptText);
        resolvedParameters[inputStep.variable] = value;
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
            resolvedParameters,
            pageTracker: session.pageTracker,
            browserTracker,
            dismissalGuidance: hooks.hasAny,
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
              ad.instruction,
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
              instruction,
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
          resolvedParameters,
          pageTracker: session.pageTracker,
          browserTracker,
          stepCache,
          cacheEnabled: config.cache.enabled,
          dismissalGuidance: hooks.hasAny,
          testSteps: test.steps,
          ...codeBehindOptionsFor(i),
        });
        if (stepResult.status === 'passed') {
          logger.info(`[output: ${outputStep.variable}] = "${resolvedParameters[outputStep.variable] ?? '(not captured)'}"`);
        }
      } else if (test.toolCalls[i]) {
        // [tool: ...] step — dispatch deterministic code with live page/context/browser.
        // Same path the hook executor uses; see runToolStep above.
        stepResult = await runToolStep(test.toolCalls[i]!, instruction, i + 1);
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
          resolvedParameters,
          pageTracker: session.pageTracker,
          browserTracker,
          stepCache,
          cacheEnabled: config.cache.enabled,
          dismissalGuidance: hooks.hasAny,
          testSteps: test.steps,
          ...codeBehindOptionsFor(i),
        });
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

      recordLastRun(i, stepResult);
      stepResults.push(stepResult);
      if (interactiveStep) {
        stepResults.push(...interactiveResults);
      }

      // Add to conversation history (text summary only)
      const currentUrl = session.page.url();
      conversationHistory.push(
        formatStepHistoryEntry(
          i + 1,
          instruction,
          stepResult.status === 'passed',
          currentUrl,
        ),
      );

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
                `(interactive) ${ad.instruction}`,
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

      if (stepResult.status === 'failed') {
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
            resolvedParameters,
            pageTracker: session.pageTracker,
            browserTracker,
            dismissalGuidance: hooks.hasAny,
          };
          const adHocResults: StepResult[] = [];
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
                `(interactive) ${ad.instruction}`,
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

      tokenTracker.resetStep();
    }

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
    if (keepLastRun && lastRunSteps.length > 0) {
      await writeLastRun(test.filePath, lastRunSteps);
    }

    const durationMs = Date.now() - startTime;
    const passedSteps = stepResults.filter((s) => s.status === 'passed').length;
    const failedSteps = stepResults.filter((s) => s.status === 'failed').length;
    const totalSubActions = stepResults.reduce((sum, s) => sum + s.turns.reduce((tSum, t) => tSum + t.subActions.length, 0), 0);
    const timedOut = stepResults.length < stepLimit && !bail;
    overallStatus = failedSteps > 0 || timedOut || strictLoadError !== undefined ? 'failed' : 'passed';

    // The recording, beside the test, when this run was asked to capture —
    // which is a compile's Record (stories/codebehind-recording-on-disk.md).
    // Written here, once the run is over, and never kept in memory past it.
    if (extras.captureStepContext) {
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

    const dataRowVal = dataRowIndex !== undefined ? dataRowIndex + 1 : undefined;
    // Everything downstream of here — the HTML report, the diagnosis prompt,
    // the run-history line, `aiui run`'s failed-steps summary — sees the
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
      totalSubActions,
      durationMs,
      tokensUsed: tokenTracker.total,
      inputTokens: tokenTracker.inputTotal,
      outputTokens: tokenTracker.outputTotal,
      date: new Date().toISOString(),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(Object.keys(resolvedParameters).length > 0 && { parameters: resolvedParameters }),
      ...(dataRowVal !== undefined && { dataRow: dataRowVal }),
      ...(humanIntervened && { humanIntervened: true }),
      ...(strictLoadError !== undefined && { error: strictLoadError }),
    }, secretsNow());

    if (overallStatus === 'failed' && config.ai.diagnoseFailures) {
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
    }

    return report;
  } finally {
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
    const closeContext = async (): Promise<void> => {
      if (initialSession.cdp) {
        await closeBrowser(initialSession);
      } else {
        await browserTracker.closeAll();
      }
    };
    if (report) {
      const savedAbs = await finalizeMainPageVideo({
        page: initialSession.page,
        mode: videoMode,
        passed: overallStatus === 'passed',
        videoDir,
        stableBaseName: buildReportBaseName(report),
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
  }
}

/**
 * Expand a ParsedTest into one or more TestInstances.
 * Data-driven tests (with dataFile) produce one instance per data row.
 */
export async function expandTestInstances(
  test: ParsedTest,
  config: Config,
): Promise<TestInstance[]> {
  const projectRoot = process.cwd();

  // Load data file rows if specified
  let dataRows: Array<Record<string, string>> | undefined;
  if (test.frontmatter.dataFile) {
    const dataFilePath = test.frontmatter.dataFile;
    dataRows = await loadDataFile(dataFilePath, projectRoot);
    logger.info(`Data file: ${dataFilePath} (${dataRows.length} rows)`);
  }

  if (dataRows && dataRows.length > 0) {
    // Create one instance per data row
    return Promise.all(
      dataRows.map(async (row, index) => {
        const resolvedParameters = await resolveParameters(
          test.parameters,
          row,
          false, // Don't prompt user during data-driven expansion
        );
        return {
          test,
          dataRowIndex: index,
          resolvedParameters,
        };
      }),
    );
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
  options: { bail?: boolean; verbose?: boolean; runEnvName?: string } = {},
): Promise<RunSummary> {
  const context = await loadContextFiles(config.tests.contextDir);

  if (context.files.length > 0) {
    logger.info(`Loaded ${context.files.length} context file(s)`);
  }

  const reports: TestReport[] = [];
  let bailed = false;
  let lastReportPath: string | undefined;

  for (const test of tests) {
    if (bailed) break;

    const instances = await expandTestInstances(test, config);

    for (const instance of instances) {
      if (bailed) break;

      const report = await runTest(instance, config, context.combined, options.runEnvName);
      reports.push(report);

      // Save HTML report
      const reportPath = await generateReport(report, config.reports.outputDir);
      lastReportPath = reportPath;
      logger.info(`Report saved: ${path.relative(process.cwd(), reportPath)}`);

      if (config.reports.appendRunHistoryToTestFile) {
        await appendRunHistory(instance.test.filePath, reportPath, report.status, report.date, getPrimaryModel(report));
      }

      if (report.status === 'failed' && options.bail) {
        logger.warn('Bailing on first failure (--bail flag set)');
        bailed = true;
      }
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
