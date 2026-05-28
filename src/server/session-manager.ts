import { basename, join as pathJoin } from 'node:path';
import { stat } from 'node:fs/promises';
import { StepCache, frameScopedStepKey } from '../cache/step-cache.js';
import { resolveProjectRoot } from './project-root.js';
import { chooseCacheHashSource } from './cache-hash-source.js';
import { loadConfig } from '../config/loader.js';
import type { Config } from '../config/types.js';
import type { StepResult, TestReport } from '../report/types.js';
import { AiClient } from '../ai/client.js';
import { TokenTracker } from '../utils/tokens.js';
import { launchBrowser, BrowserTracker, type BrowserSession } from '../browser/manager.js';
import { executeStep, executeBranchedStep } from '../runner/step-executor.js';
import { identifyStepGroups } from '../runner/step-grouper.js';
import { loadContextFiles } from '../context/loader.js';
import { interpolate } from '../parser/parameters.js';
import { interpolateEnvData } from '../parser/interpolate-env-data.js';
import { resolveEnvBundle, type EnvBundle } from '../env/resolve-bundle.js';
import { clearSkillCache, expandSkills, type ExpandedStepOrigin } from '../skills/expander.js';
import { parseToolCall } from '../tools/tool-call-parser.js';
import { executeToolStep } from '../tools/executor.js';
import { loadToolCatalogue, ToolCatalogue } from '../tools/registry.js';
import { formatStepHistoryEntry } from '../ai/prompts.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { ApiResponseStore } from '../api/response-store.js';
import { parseTimeoutMs } from '../runner/test-runner.js';
import { generateReport } from '../report/generator.js';
import {
  logger,
  addLogCallback,
  shouldEmit,
  setLogLevel,
  getLogLevel,
  type ConsoleLogLevel,
} from '../utils/logger.js';
import { openRunLogFile, attachRunLogBridges } from '../utils/run-log.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepRequest {
  /** `cdp` is passed through to the runner verbatim — same loose pass-through
   *  pattern as `baseUrl`/`timeout` — so the server stays schema-agnostic
   *  about CDP attach. The runner validates the shape on receive. */
  config?: { baseUrl?: string; timeout?: string; cdp?: { port: number; tab?: string } };
  steps: string[];
  parameters?: Record<string, string>;
  /**
   * Per-request environment variables (e.g. AI_API_KEY, AI_MODEL). Applied to
   * the session's config only — never written to the server's process.env, so
   * concurrent sessions and the server itself remain isolated.
   */
  env?: Record<string, string>;
  /**
   * Active environment name. When supplied, the server loads `.env.<name>` and
   * `<dataDir>/<name>.json` (where `dataDir` is `tests.dataDir` from the
   * project's `aiui.config.json`, default `data`) from the **test file's
   * project root** — resolved via `resolveProjectRoot(testFilePath)`, NOT the
   * server's cwd. It then interpolates `${env.X}` / `${data.X.Y}` placeholders
   * in each step before the regular `{{...}}` substitution. Resolution is
   * mtime-cached per project (not per session), so a saved edit to
   * `.env`/data/config is picked up on the next batch. See
   * stories/project-scoped-data-dir-and-env.md.
   */
  envName?: string;
  /**
   * Reserved for future breakpoint pause/resume support. Currently logged and
   * ignored — the run executes to completion.
   */
  breakpoints?: number[];
  /**
   * Per-URI breakpoint sets keyed by absolute file path. The step loop
   * checks each step's origin frame (test file OR a skill body line) and
   * pauses via `step:awaiting` before executing a matching step. The
   * client treats the pause as a step-paused state (same yellow ▶ /
   * Continue / StepOver / etc. machinery as the stepMode flow).
   *
   * Entries keyed under `testFilePath` are skipped on the server side —
   * the client already trims at those breakpoints before sending the
   * request. Skill-file breakpoints (the actual motivation for this
   * field) reach the server because the client's pre-expansion trim
   * can't see them.
   */
  breakpointsByUri?: Record<string, number[]>;
  /**
   * 1-based source-document line for each entry in `steps`. When present,
   * step events carry the original line so the client can render gutter
   * status against the document. Defaults to step index when omitted.
   */
  sourceLines?: number[];
  /**
   * Absolute path to the project's skills directory. When supplied, the
   * server runs `expandSkills` over `steps`, flattens `[skill: ...]`
   * invocations, and emits `frame:push` / `frame:pop` events around each
   * expanded skill body so step-into-aware clients can render a multi-file
   * call stack. Omit to keep the legacy behaviour (raw steps fed straight
   * to the runner — fine when no `[skill: ...]` lines are present).
   */
  skillsDir?: string;
  /**
   * Absolute path of the test file the steps were authored in. Used as the
   * origin `uri` on `frame` payloads attached to step events emitted from
   * inline (non-skill) lines. Optional.
   */
  testFilePath?: string;
  /**
   * Absolute path to the project's tools directory. When supplied, the
   * server loads the `ToolCatalogue` once per session and dispatches every
   * `[tool: ...]` step through `executeToolStep` (the same code path the
   * CLI runner uses). Without `toolsDir` the legacy behaviour applies —
   * `[tool: ...]` lines reach the LLM as raw text, which it doesn't know
   * how to execute.
   */
  toolsDir?: string;
  /**
   * One-shot pause-at-next-tool flag (Phase 5 — tool step-into). When
   * true on the initial request body OR delivered via the run-control
   * endpoint, the server emits `tool:awaiting-debugger` before the next
   * `[tool: ...]` step and waits for the client to attach its debugger
   * via the `tool-debugger-ack` endpoint. Consumed on first trigger;
   * subsequent tools run normally until the flag is set again.
   */
  pauseAtNextTool?: boolean;
  /**
   * Initial step-mode for this batch. `continue` (default) runs until the
   * next breakpoint or end. `into` / `over` / `out` start the run paused
   * between steps and emit `step:awaiting` events so the client can drive
   * step-by-step execution via `POST /sessions/:id/run-control`.
   *
   * Reset to `continue` between sessions.
   */
  stepMode?: 'continue' | 'into' | 'over' | 'out';
  /**
   * Per-request logging override. Lets a testbench user flip verbosity on a
   * single run (e.g. `consoleLogLevel: 'debug'` + `serverFileLogLevel: 'full'`
   * for a hung run) without restarting the server. Each field falls back to
   * the server-level `logging.*` config when omitted. The override scope is
   * this single request — the server-level setting is restored when the run
   * completes.
   */
  logging?: {
    consoleLogLevel?: ConsoleLogLevel;
    serverFileLogLevel?: 'off' | 'compact' | 'full';
  };
  /**
   * Enable / disable the per-step AI response cache for this request. When
   * true (and `testFilePath` is present so a project root can be resolved),
   * the server reads cached AI plans from `<project-root>/.cache/<test>/`
   * before calling the AI, and writes successful plans back. Cache hits
   * surface to clients via `step:pass.fromCache = true`.
   *
   * Opt-in: caching only happens when this is explicitly `true` (and a
   * `testFilePath` is present). An absent flag (`undefined`) or `false`
   * means no cache — every step goes through the AI.
   */
  cacheEnabled?: boolean;
  /**
   * Full post-expansion step list for the test. When a run is split into
   * multiple HTTP batches (e.g. paused at a breakpoint), each batch's
   * `steps` field carries only the trimmed slice this batch executes.
   * The cache's bundle-hash needs to be stable across batches of the
   * *same* test, so callers send the full list here. The server hashes
   * `fullSteps ?? steps` — omitting it works for single-batch runs and
   * misbehaves only on multi-batch runs (where the hash would differ
   * between batches and prevent any cache hit).
   */
  fullSteps?: string[];
  /**
   * Re-run seed scope (testbench "re-run a skill step with its variables").
   * Captured/runtime variables to inject into the session scope BEFORE the
   * run, so a partial re-run that starts mid-skill (see `startAt`) can resolve
   * values the skipped earlier steps would have produced. Merged over
   * `session.outputs` and `parameters` (seed wins) — these are the values the
   * user saw, and optionally edited, in the Variables panel.
   *
   * `__skill*`-namespaced names are server-owned internals and are ignored if
   * present. When `seedScope` is set the per-step cache is force-disabled for
   * the run (see `cacheEnabled` handling) so an edited value re-plans instead
   * of replaying a frozen cached action list.
   */
  seedScope?: Record<string, string>;
  /**
   * Start executing partway into the (expanded) step list: skip every expanded
   * step before the first whose origin file === `startAt.uri` AND whose source
   * line ≥ `startAt.line`. Used by "re-run this skill step" — the client sends
   * the single failed `[skill: …]` invocation plus the failed body step's
   * (skill-file) location, and the server runs from there to the end of that
   * expansion. Qualified by `uri` so a line number that recurs in a different
   * (e.g. nested) skill file can't false-match. Omit to run from the start.
   */
  startAt?: { uri: string; line: number };
  /**
   * Upper bound for a bounded partial re-run ("run selected skill steps on a
   * stopped session"): stop after the last expanded step in file `endAt.uri`
   * whose source line ≤ `endAt.line`. Qualified by `uri` like `startAt`. Omit to
   * run to the end of the expansion (i.e. the end of the skill body) — the
   * `startAt`-only behaviour. Only meaningful alongside `startAt`.
   */
  endAt?: { uri: string; line: number };
}

/**
 * Origin frame for step events. Mirrors `FrameInfo` in `runner-core`'s
 * `protocol.ts`. Kept in sync by hand — protocol is owned by runner-core
 * but the server emits these in step-into-aware runs.
 */
export interface FrameInfo {
  id: string;
  parentId: string | null;
  kind: 'test' | 'skill';
  uri: string;
  line: number;
  skillName?: string;
}

/**
 * Run-time event the session manager emits per step. The streaming HTTP
 * endpoint converts these to SSE frames; the non-streaming endpoint ignores
 * them.
 *
 * The `frame:*` variants are emitted only when the client asks for skill
 * expansion (via `StepRequest.skillsDir`). Legacy clients can ignore them.
 */
export type RunEvent =
  | { type: 'step:start'; line: number; frame?: FrameInfo }
  | { type: 'step:pass'; line: number; output?: string; screenshot?: string; frame?: FrameInfo; fromCache?: boolean }
  | { type: 'step:fail'; line: number; error: string; screenshot?: string; frame?: FrameInfo }
  | { type: 'output'; msg: string; kind: 'info' | 'warn' | 'error' }
  | { type: 'capture'; line: number; name: string; value: string; source: 'capture' | 'toolOutput' }
  | { type: 'done'; status: 'passed' | 'failed' | 'error' | 'aborted' }
  | { type: 'frame:push'; frame: FrameInfo }
  | { type: 'frame:pop'; frameId: string; outputs: Record<string, string> }
  | { type: 'frame:scope'; frameId: string; scope: Record<string, string> }
  | { type: 'step:awaiting'; line: number; frame?: FrameInfo }
  | { type: 'tool:awaiting-debugger'; toolName: string; toolFilePath?: string; line: number; frame?: FrameInfo };

export type RunEventListener = (event: RunEvent) => void;

export interface StepResultResponse {
  step: string;
  status: 'passed' | 'failed' | 'error';
  actions: unknown[];
  screenshot: string;
  reasoning: string;
  outputs: Record<string, string>;
}

export interface StepResponse {
  sessionId: string;
  status: 'passed' | 'failed' | 'error' | 'aborted';
  stepsCompleted: number;
  stepsTotal: number;
  results: StepResultResponse[];
  outputs: Record<string, string>;
  /** Per-key provenance for `outputs`, same keys. Additive: older clients
   *  ignore it. See `ManagedSession.outputSources` for the labelling rules. */
  outputSources: Record<string, 'parameter' | 'capture' | 'toolOutput'>;
  error: { step: number; message: string } | null;
  pageTitle: string;
}

export interface SessionState {
  sessionId: string;
  status: 'active' | 'executing' | 'queued';
  currentUrl: string;
  pageTitle: string;
  screenshot: string;
  outputs: Record<string, string>;
  totalStepsExecuted: number;
}

export interface SessionListItem {
  sessionId: string;
  status: 'active' | 'executing';
  currentUrl: string;
  pageTitle: string;
  totalStepsExecuted: number;
}

// ---------------------------------------------------------------------------
// Internal session data
// ---------------------------------------------------------------------------

/** Pattern for [input: variable_name] steps */
const INPUT_STEP_PATTERN = /^\[input:\s*\w+\]/i;

/** Pattern for [interactive] steps */
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]/i;

/** Pattern for a single [output: variable_name] prefix */
const OUTPUT_PREFIX_PATTERN = /\[output:\s*(\w+)\]/gi;

interface ManagedSession {
  id: string;
  /** Snapshot of the currently-active browser. Refreshed from `browserTracker`
   *  after every step so subsequent steps target whatever openBrowser /
   *  switchBrowser / closeBrowser left as active. */
  browserSession: BrowserSession;
  /** Owns every browser launched in this session — the initial one plus any
   *  added by `openBrowser`. Closing the session calls `closeAll()` so no
   *  named browser leaks. */
  browserTracker: BrowserTracker;
  status: 'active' | 'executing' | 'closed';
  sessionConfig: { baseUrl?: string; timeout?: string };
  configSet: boolean;
  outputs: Record<string, string>;
  /**
   * Provenance label for each key in `outputs`. Written at each variable
   * write site (parameter seeding, tool/skill output, `[output:]` capture,
   * end-of-step sweep). First-write-wins: once a name is labelled it keeps
   * that label even if a later write overwrites the *value* — so a parameter
   * shadowed by a same-named capture still reads as `'parameter'`, preserving
   * the variable's original identity rather than hiding it behind the latest
   * source.
   */
  outputSources: Record<string, 'parameter' | 'capture' | 'toolOutput'>;
  totalStepsExecuted: number;
  conversationHistory: string[];
  aiClient: AiClient;
  tokenTracker: TokenTracker;
  apiResponseStore: ApiResponseStore;
  csrfTokens: Record<string, string>;
  contextContent: string;
  queueTail: Promise<void>;
  /**
   * Cached tool catalogue once `toolsDir` is supplied. Loaded lazily on the
   * first batch that supplies one; a non-empty catalogue from the same
   * `toolsDir` is reused across batches (re-scanning per batch would slow
   * every step run for no gain). The cache is invalidated — and the
   * catalogue reloaded — when the incoming `toolsDir` differs from
   * `toolCatalogueDir`, or when the cached catalogue is empty (a previously
   * missing/empty dir that may now exist or have gained tools). This lets a
   * Continue / re-run on the same session recover from a misconfigured
   * `toolsDir` without a full session restart.
   */
  toolCatalogue?: ToolCatalogue;
  /** Absolute `toolsDir` that produced `toolCatalogue`. Used to detect a
   *  changed `toolsDir` between batches so the catalogue can be reloaded. */
  toolCatalogueDir?: string;
  /**
   * When the step loop pauses awaiting next-step direction (stepMode !==
   * 'continue'), this holds the resolver for the Promise the loop is
   * blocked on. The HTTP run-control endpoint resolves it; the loop then
   * picks up with the supplied mode. Cleared as soon as it resolves so
   * a stale handle can't outlive a single pause point.
   */
  pendingRunControl: { resolve: (mode: 'continue' | 'into' | 'over' | 'out') => void } | null;
  /**
   * Set while the step loop is paused at the tool-dispatcher's
   * `debugger;` ack point (Phase 5). The HTTP `tool-debugger-ack`
   * endpoint resolves the Promise the loop is awaiting; the loop then
   * proceeds into the `debugger;` statement which Node's V8 inspector
   * traps. Cleared as soon as resolved.
   */
  pendingDebuggerAck: { resolve: () => void } | null;
  /**
   * One-shot trigger: when true at the moment the step loop reaches a
   * `[tool: ...]` step, the server emits `tool:awaiting-debugger` and
   * parks on `pendingDebuggerAck` instead of running the tool. The flag
   * is consumed on first trigger so the user gets exactly one tool
   * step-into per F11 press. Set via the HTTP run-control body and via
   * `pauseAtNextTool` on the initial steps request.
   */
  pauseAtNextTool: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse all [output: varname] prefixes from a step instruction.
 * Returns the variable names and the cleaned instruction with output prefixes removed.
 */
function parseOutputPrefixes(instruction: string): {
  variables: string[];
  cleanedInstruction: string;
} {
  const variables: string[] = [];
  let cleaned = instruction;

  // Collect all [output: varname] matches
  let match: RegExpExecArray | null;
  // Reset lastIndex since the regex has the global flag
  OUTPUT_PREFIX_PATTERN.lastIndex = 0;
  while ((match = OUTPUT_PREFIX_PATTERN.exec(instruction)) !== null) {
    variables.push(match[1]!);
  }

  if (variables.length === 0) {
    return { variables: [], cleanedInstruction: instruction };
  }

  // Strip all [output: ...] prefixes from the instruction
  cleaned = instruction.replace(OUTPUT_PREFIX_PATTERN, '').trim();

  if (!cleaned) {
    cleaned = `Capture value into "${variables.join(', ')}"`;
  }

  return { variables, cleanedInstruction: cleaned };
}

/**
 * Build the enriched instruction that tells the AI to capture output values.
 * Appends `[store as: var1, var2]` matching the existing pattern from test-runner.
 */
function buildEnrichedInstruction(
  cleanedInstruction: string,
  variables: string[],
): string {
  return `${cleanedInstruction} [store as: ${variables.join(', ')}]`;
}

/**
 * Check if a step instruction is an input step or interactive step (to be skipped in API mode).
 */
function isSkippableStep(instruction: string): boolean {
  return INPUT_STEP_PATTERN.test(instruction) || INTERACTIVE_STEP_PATTERN.test(instruction);
}

/**
 * Build a per-session AiConfig with optional env overrides applied. Only
 * `apiKey` and `model` are honoured today — these are the env knobs a `.env`
 * shipped from a client realistically wants to override per session. Server
 * process.env is never mutated.
 */
function applyEnvToAiConfig(
  baseConfig: import('../config/types.js').AiConfig,
  envOverrides: Record<string, string> | undefined,
): import('../config/types.js').AiConfig {
  if (!envOverrides) return baseConfig;
  const next = { ...baseConfig };
  const apiKey = envOverrides['AI_API_KEY'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    next.apiKey = apiKey;
  }
  const model = envOverrides['AI_MODEL'];
  if (typeof model === 'string' && model.trim().length > 0) {
    next.model = model.trim();
  }
  return next;
}

/**
 * Check if the browser context has been closed (e.g. after a "Close the browser" step).
 */
function isBrowserClosed(browserSession: BrowserSession): boolean {
  try {
    // Accessing browser.isConnected() is the reliable way to check
    return !browserSession.browser.isConnected();
  } catch {
    return true;
  }
}

/**
 * Walk the frame chain rooted at `frameId` and return the name of the
 * outermost skill encountered. Mirrors the CLI runner's
 * `test.sourceSkills[i]` semantics: for nested `skill_a → skill_b`,
 * every body step (inner or outer) reports `skill_a` so the report's
 * "from skill X" chip reflects the user-visible invocation rather than
 * the immediate frame. Returns undefined for top-level inline steps
 * (frameId empty or pointing at the test frame).
 */
function outermostSkillName(
  frameId: string | undefined,
  frames: Record<string, FrameInfo> | null,
): string | undefined {
  if (!frameId || !frames) return undefined;
  let outermost: FrameInfo | undefined;
  let current: FrameInfo | undefined = frames[frameId];
  while (current) {
    if (current.kind === 'skill') outermost = current;
    if (!current.parentId) break;
    current = frames[current.parentId];
  }
  return outermost?.skillName;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Resolved per-project context for a step batch: the project's config + the
 * env/data bundle, anchored at the test file's project root (NOT the server's
 * cwd). `projectRoot` is null when no `aiui.config.json` was found above the
 * test file (the defaults fallback). See
 * stories/project-scoped-data-dir-and-env.md.
 */
interface ProjectBundle {
  projectRoot: string | null;
  config: Config;
  envBundle: EnvBundle | null;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private config: Config;

  /**
   * Per-project resolution cache, keyed by `<projectRoot>::<envName>`. Holds the
   * resolved bundle plus the mtimes of every input file (config, `.env`,
   * `.env.<name>`, data JSON) so a saved edit is picked up on the next batch
   * (closes issue 011). Independent of session lifetime — survives Close
   * Session, shared across sessions in the same project.
   */
  private projectBundleCache = new Map<string, { mtimes: Map<string, number>; bundle: ProjectBundle }>();
  /** Dedupes concurrent (re)loads of the same key so two in-flight batches for
   *  one project don't both read+parse from disk. */
  private projectBundleInflight = new Map<string, Promise<ProjectBundle>>();

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Resolve the per-project config + env/data bundle for a step batch from the
   * test file's project root. mtime-cached; returns the cached bundle when no
   * input file changed, otherwise reloads. A null project root (no
   * `aiui.config.json` above the file) falls back to server defaults with no
   * project `.env`/data.
   */
  private async resolveProjectBundle(
    testFilePath: string | undefined,
    envName: string | null,
  ): Promise<ProjectBundle> {
    const projectRoot = testFilePath ? await resolveProjectRoot(testFilePath) : null;
    const key = `${projectRoot ?? '<none>'}::${envName ?? '<none>'}`;

    const cached = this.projectBundleCache.get(key);
    if (cached && (await this.bundleInputsUnchanged(cached.mtimes))) {
      return cached.bundle;
    }

    const inflight = this.projectBundleInflight.get(key);
    if (inflight) return inflight;

    const loadPromise = this.loadProjectBundle(projectRoot, envName, key);
    this.projectBundleInflight.set(key, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.projectBundleInflight.delete(key);
    }
  }

  private async loadProjectBundle(
    projectRoot: string | null,
    envName: string | null,
    key: string,
  ): Promise<ProjectBundle> {
    // Per-project config (for tests.dataDir et al.) when we have a root;
    // the server's startup config otherwise. A malformed project config fails
    // only this request — it's never cached, so a fix is picked up next batch.
    let config = this.config;
    if (projectRoot) {
      try {
        config = await loadConfig(undefined, projectRoot);
      } catch (err) {
        throw new Error(
          `Failed to load aiui.config.json for project "${projectRoot}": ${(err as Error).message}`,
        );
      }
    }

    const dataDir = config.tests.dataDir;
    let envBundle: EnvBundle | null = null;
    if (envName) {
      if (projectRoot) {
        envBundle = await resolveEnvBundle({ envName, projectRoot, dataDir, mutateProcessEnv: false });
      } else {
        // Null fallback: no project files to read. Provide the process baseline
        // so ${env.X} (server env) and ${envName} still resolve; data is empty,
        // so ${data.X} fails loudly if used.
        const baseline: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === 'string') baseline[k] = v;
        }
        envBundle = { envName, env: baseline, data: {} };
        logger.warn(
          'No aiui.config.json found above the test file — using defaults ' +
            '(no project .env/data). ${data.*} references will fail if used.',
        );
      }
    }

    const bundle: ProjectBundle = { projectRoot, config, envBundle };
    const mtimes = await this.bundleInputMtimes(projectRoot, envName, dataDir);
    this.projectBundleCache.set(key, { mtimes, bundle });
    return bundle;
  }

  /** mtimeMs of every bundle input file (config, `.env`, `.env.<name>`, data
   *  JSON); a missing file records 0 so its later appearance invalidates. */
  private async bundleInputMtimes(
    projectRoot: string | null,
    envName: string | null,
    dataDir: string,
  ): Promise<Map<string, number>> {
    const paths: string[] = [];
    if (projectRoot) {
      paths.push(pathJoin(projectRoot, 'aiui.config.json'));
      paths.push(pathJoin(projectRoot, '.env'));
      if (envName) {
        paths.push(pathJoin(projectRoot, `.env.${envName}`));
        paths.push(pathJoin(projectRoot, dataDir, `${envName}.json`));
      }
    }
    const m = new Map<string, number>();
    await Promise.all(
      paths.map(async (p) => {
        try {
          m.set(p, (await stat(p)).mtimeMs);
        } catch {
          m.set(p, 0);
        }
      }),
    );
    return m;
  }

  private async bundleInputsUnchanged(mtimes: Map<string, number>): Promise<boolean> {
    for (const [p, prev] of mtimes) {
      let cur = 0;
      try {
        cur = (await stat(p)).mtimeMs;
      } catch {
        cur = 0;
      }
      if (cur !== prev) return false;
    }
    return true;
  }

  /**
   * Resolve a pending run-control wait for `sessionId` with the supplied
   * mode. Called by the HTTP `POST /sessions/:id/run-control` handler.
   * Returns `true` if a paused run actually picked the mode up, `false`
   * if there was no paused run to deliver to (so the handler can return a
   * 409 / "no pause" diagnostic).
   */
  submitRunControl(sessionId: string, mode: 'continue' | 'into' | 'over' | 'out'): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingRunControl) return false;
    const { resolve } = session.pendingRunControl;
    session.pendingRunControl = null;
    resolve(mode);
    return true;
  }

  /**
   * Pass-through to a session's mutable `pauseAtNextTool` flag. The HTTP
   * `run-control` endpoint sets this on the same body that delivers a
   * step-mode command — the next `[tool: ...]` step the loop reaches
   * then emits `tool:awaiting-debugger` and parks on
   * `pendingDebuggerAck` until the client attaches its debugger.
   *
   * Returns `true` when the session existed and the flag was set.
   */
  setPauseAtNextTool(sessionId: string, value: boolean): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pauseAtNextTool = value;
    return true;
  }

  /**
   * Resolve the per-session debugger-ack wait. Returns `true` if a run
   * was actually parked on the ack (so the HTTP handler can 200), `false`
   * if no run is awaiting (handler returns 409).
   */
  submitDebuggerAck(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingDebuggerAck) return false;
    const { resolve } = session.pendingDebuggerAck;
    session.pendingDebuggerAck = null;
    resolve();
    return true;
  }

  /**
   * Execute a batch of steps within a named session.
   * Creates the session on first use. Queues requests if the session is busy.
   *
   * Pass `onEvent` to receive per-step events as they happen (used by the
   * streaming endpoint). The returned promise still resolves with the full
   * StepResponse on completion.
   */
  async executeSteps(
    sessionId: string,
    request: StepRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
  ): Promise<StepResponse> {
    // Clear the module-level skill cache at the start of every request so
    // disk edits to skill files between batches are picked up. The API
    // server is long-lived; without this an edit during a paused run stays
    // masked by the earlier-cached parse. Within a single request the cache
    // is repopulated by expandSkills and still amortises across nested
    // invocations of the same skill.
    clearSkillCache();

    let session = this.sessions.get(sessionId);

    // If session exists but is closed, remove it so a fresh one is created
    if (session && session.status === 'closed') {
      this.sessions.delete(sessionId);
      session = undefined;
    }

    // Validate config on existing session
    if (session && request.config) {
      throw new Error(
        'Config can only be provided on the first request for a session. ' +
          'This session already has a config set.',
      );
    }

    // Create session if it does not exist. Per-request env is applied at
    // session-creation time only — once an AiClient is bound to a session,
    // changing env mid-session is intentionally not supported.
    if (!session) {
      session = await this.createSession(sessionId, request.config, request.env);
    }

    if (request.breakpoints && request.breakpoints.length > 0) {
      logger.warn(
        `Session "${sessionId}": ${request.breakpoints.length} breakpoint(s) requested but ` +
          `pause/resume is not yet implemented — run will execute to completion.`,
      );
    }

    // Queue the work onto the session's promise chain so requests execute sequentially
    const resultPromise = new Promise<StepResponse>((resolve, reject) => {
      session.queueTail = session.queueTail
        .then(() => this.executeStepsInternal(session, sessionId, request, onEvent, signal))
        .then(resolve, reject);
    });

    return resultPromise;
  }

  /**
   * Get the current state of a session. Returns null if the session does not exist.
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'closed') {
      return null;
    }

    const page = session.browserSession.pageTracker.getActive();
    let currentUrl = '';
    let pageTitle = '';
    let screenshotBase64 = '';

    try {
      currentUrl = page.url();
      pageTitle = await page.title();
      const shot = await captureScreenshot(page);
      screenshotBase64 = shot?.base64
        ? `data:image/png;base64,${shot.base64}`
        : '';
    } catch {
      // Browser may be in an intermediate state
    }

    // Determine display status: if queueTail is still pending, we have queued work
    let displayStatus: 'active' | 'executing' | 'queued' = session.status === 'executing'
      ? 'executing'
      : 'active';

    // A rough heuristic: if executing and queueTail isn't resolved, mark as queued
    // We track this by checking if there are pending promises beyond the current execution
    // For simplicity, the session.status covers the primary state
    if (session.status === 'executing') {
      displayStatus = 'executing';
    }

    return {
      sessionId,
      status: displayStatus,
      currentUrl,
      pageTitle,
      screenshot: screenshotBase64,
      outputs: { ...session.outputs },
      totalStepsExecuted: session.totalStepsExecuted,
    };
  }

  /**
   * List all active (non-closed) sessions.
   */
  getActiveSessions(): SessionListItem[] {
    const items: SessionListItem[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'closed') continue;

      const page = session.browserSession.pageTracker.getActive();
      let currentUrl = '';
      let pageTitle = '';

      try {
        currentUrl = page.url();
        // page.title() is async but we need sync here; use URL as fallback
      } catch {
        // ignore
      }

      items.push({
        sessionId: id,
        status: session.status === 'executing' ? 'executing' : 'active',
        currentUrl,
        pageTitle,
        totalStepsExecuted: session.totalStepsExecuted,
      });
    }

    return items;
  }

  /**
   * List all active sessions with async page title resolution.
   */
  async getActiveSessionsWithTitles(): Promise<SessionListItem[]> {
    const items: SessionListItem[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'closed') continue;

      const page = session.browserSession.pageTracker.getActive();
      let currentUrl = '';
      let pageTitle = '';

      try {
        currentUrl = page.url();
        pageTitle = await page.title();
      } catch {
        // ignore
      }

      items.push({
        sessionId: id,
        status: session.status === 'executing' ? 'executing' : 'active',
        currentUrl,
        pageTitle,
        totalStepsExecuted: session.totalStepsExecuted,
      });
    }

    return items;
  }

  /**
   * Close a session: shut down the browser and remove it from the map.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      // closeAll covers every browser the tracker owns — the initial one
      // plus any added by openBrowser. Closing only browserSession would
      // leak named browsers from multi-browser tests.
      await session.browserTracker.closeAll();
    } catch {
      // Best effort
    }

    session.status = 'closed';
    this.sessions.delete(sessionId);
    logger.info(`Session "${sessionId}" closed and removed`);
  }

  /**
   * Close all sessions. Useful for server shutdown.
   */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async createSession(
    sessionId: string,
    sessionConfig?: { baseUrl?: string; timeout?: string; cdp?: { port: number; tab?: string } },
    envOverrides?: Record<string, string>,
  ): Promise<ManagedSession> {
    logger.info(`Creating session "${sessionId}"`);

    // Apply per-request env to a fresh ai config copy. Server's process.env is
    // never mutated; concurrent sessions stay isolated.
    const aiConfig = applyEnvToAiConfig(this.config.ai, envOverrides);

    const browserSession = await launchBrowser(this.config.browser, sessionConfig?.cdp);
    const browserTracker = new BrowserTracker(browserSession);
    const tokenTracker = new TokenTracker();
    const aiClient = new AiClient(aiConfig, tokenTracker);
    const apiResponseStore = new ApiResponseStore();

    // Load context files once per session
    const context = await loadContextFiles(this.config.tests.contextDir);
    if (context.files.length > 0) {
      logger.info(`Session "${sessionId}": loaded ${context.files.length} context file(s)`);
    }

    // Navigate to baseUrl if provided
    if (sessionConfig?.baseUrl) {
      logger.info(`Session "${sessionId}": navigating to base URL ${sessionConfig.baseUrl}`);
      await browserSession.page.goto(sessionConfig.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }

    const session: ManagedSession = {
      id: sessionId,
      browserSession,
      browserTracker,
      status: 'active',
      sessionConfig: sessionConfig ?? {},
      configSet: sessionConfig !== undefined,
      outputs: {},
      outputSources: {},
      totalStepsExecuted: 0,
      conversationHistory: [],
      aiClient,
      tokenTracker,
      apiResponseStore,
      csrfTokens: {},
      contextContent: context.combined,
      queueTail: Promise.resolve(),
      pendingRunControl: null,
      pendingDebuggerAck: null,
      pauseAtNextTool: false,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  private async executeStepsInternal(
    session: ManagedSession,
    sessionId: string,
    request: StepRequest,
    onEvent?: RunEventListener,
    signal?: AbortSignal,
  ): Promise<StepResponse> {
    session.status = 'executing';

    const runStartTime = Date.now();
    // The session's TokenTracker lives for the whole session, accumulating
    // across every run. Snapshot here so this run's report counts only the
    // tokens spent during this run — otherwise a re-run (especially a fully
    // cache-served one that makes no AI calls) would inherit the prior run's
    // total. See src/utils/tokens.ts.
    session.tokenTracker.markRunStart();
    const results: StepResultResponse[] = [];
    /** Full StepResult records accumulated across this request — used to
     *  generate the per-run HTML report at the end. */
    const fullStepResults: StepResult[] = [];
    // stepsTotal mirrors the post-expansion step count once skill expansion
    // runs (further down). Declared `let` because of that. Status displays
    // and `step N/total` log lines reflect what the runner actually executes,
    // not the pre-expansion length.
    let stepsTotal = request.steps.length;
    let stepsCompleted = 0;
    let overallStatus: 'passed' | 'failed' | 'error' | 'aborted' = 'passed';
    let errorInfo: { step: number; message: string } | null = null;

    // Step-execution view of the inbound request. When skill expansion runs
    // (further down, once envDataCtx is resolved) these get rebound to the
    // flattened arrays; the loop only ever reads from them. Declared up
    // here so the `sourceLineFor` closure binds to the live values.
    let effectiveSteps: string[] = request.steps;
    let effectiveSourceLines: number[] | undefined = request.sourceLines;
    let expansionOrigins: ExpandedStepOrigin[] | null = null;
    let expansionFrames: Record<string, FrameInfo> | null = null;
    // Per-skill-frame snapshot of the caller-supplied parameter values
    // recorded by the expander. Merged into `frame:scope` on entry so
    // a debugger pause inside the skill shows what was passed in.
    const frameInputs: Record<string, Record<string, string>> = {};

    // Map a 1-based step index to the source-document line. When the client
    // doesn't supply sourceLines we echo the step index — some clients (e.g.
    // headless runners) don't track source positions. After skill expansion,
    // `effectiveSourceLines` carries per-expanded-step lines (skill-body
    // entries point at their skill `.md`, not the test file).
    const sourceLineFor = (stepIndex0: number): number => {
      const explicit = effectiveSourceLines?.[stepIndex0];
      return typeof explicit === 'number' ? explicit : stepIndex0 + 1;
    };

    const emit = (event: RunEvent): void => {
      if (!onEvent) return;
      try {
        onEvent(event);
      } catch (err) {
        // A failing listener must not crash the run.
        logger.warn(`Session "${sessionId}": run-event listener threw: ${String(err)}`);
      }
    };

    // Resolve per-request logging overrides. The server-level config supplies
    // defaults; the request body can flip them for this single run. Restored
    // in the finally block so the override scope is one request.
    const requestedLevel = request.logging?.consoleLogLevel;
    const fileMode = request.logging?.serverFileLogLevel ?? this.config.logging.serverFileLogLevel;
    const previousLevel = getLogLevel();
    setLogLevel(requestedLevel ?? this.config.logging.consoleLogLevel);

    // Bridge logger calls into the SSE stream as `output` events so the client
    // can see what's happening inside a step. Without this, a hanging step
    // produces only `step:start` followed by silence — the user has no signal
    // about which sub-action is stuck. The bridge mirrors the configured log
    // level (via `shouldEmit`) so the testbench output panel matches the
    // server console.
    //
    // Caveat: logger callbacks are process-global, so concurrent sessions in
    // the same server will see each other's logs. Acceptable for the dev
    // testbench; if multi-tenancy is needed later, switch to AsyncLocalStorage.
    const removeLogBridge = onEvent
      ? addLogCallback((level, message) => {
          if (!shouldEmit(level)) return;
          const kind: 'info' | 'warn' | 'error' =
            level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
          emit({ type: 'output', msg: message, kind });
        })
      : () => {};

    // Per-run log file. Mode is governed by `logging.serverFileLogLevel`:
    //   - 'off':     skip the file entirely
    //   - 'compact': inline log lines only (no AI trace blocks)
    //   - 'full':    inline log lines + full AI request/response trace blocks
    // The file always captures every level regardless of `logging.consoleLogLevel`,
    // so a quiet server still produces a complete forensic trail when enabled.
    const runLog = fileMode === 'off'
      ? null
      : openRunLogFile(sessionId, this.config.reports.outputDir);
    if (runLog) {
      runLog.stream.write(
        `# session=${sessionId} startedAt=${new Date().toISOString()} steps=${stepsTotal} mode=${fileMode}\n`,
      );
      logger.info(`Run log: ${runLog.path}`);
    }
    const removeFileBridges = runLog
      ? attachRunLogBridges(runLog, fileMode)
      : () => {};

    // Re-run seed scope: captured/runtime vars to inject before the run so a
    // partial re-run starting mid-skill (see `startAt`) can resolve values the
    // skipped earlier steps would have produced. `__skill*` names are
    // server-owned internals and are never accepted from a seed.
    const seedScope: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.seedScope ?? {})) {
      if (!k.startsWith('__skill')) seedScope[k] = v;
    }

    // Build the parameter map: session outputs as base, request parameters as
    // overrides, then the seed scope on top (the values the user saw / edited
    // win). The existing post-step sweep persists these into session.outputs
    // and labels them, so no explicit provenance write is needed here.
    const resolvedParameters: Record<string, string> = {
      ...session.outputs,
      ...(request.parameters ?? {}),
      ...seedScope,
    };

    // Label every incoming parameter as 'parameter'. First-write-wins: if a
    // name was already labelled by an earlier batch we leave it alone, so a
    // value reused across batches keeps its original provenance.
    if (request.parameters) {
      for (const k of Object.keys(request.parameters)) {
        if (!(k in session.outputSources)) session.outputSources[k] = 'parameter';
      }
    }

    // Resolve the per-project bundle (config + env + data) anchored at the test
    // file's project root — NOT the server's cwd. mtime-cached per project so
    // repeated batches skip disk; a saved edit to .env/data/config is re-read
    // on the next batch (closes issue 011). A request that omits envName loads
    // no env/data and falls through to plain `{{...}}` interpolation only.
    const requestedEnvName = request.envName?.trim() || null;
    let projectBundle: ProjectBundle;
    try {
      projectBundle = await this.resolveProjectBundle(request.testFilePath, requestedEnvName);
      if (requestedEnvName) {
        logger.info(
          `Session "${sessionId}": env=${requestedEnvName} resolved ` +
            `(project ${projectBundle.projectRoot ?? 'defaults'})`,
        );
      }
    } catch (err) {
      logger.error(`Session "${sessionId}": failed to resolve project bundle: ${(err as Error).message}`);
      throw err;
    }
    const projectConfig = projectBundle.config;
    const envDataCtx = projectBundle.envBundle
      ? {
          env: projectBundle.envBundle.env,
          data: projectBundle.envBundle.data,
          envName: projectBundle.envBundle.envName,
        }
      : null;

    // Determine per-step timeout
    const stepTimeout = parseTimeoutMs(session.sessionConfig.timeout)
      ?? this.config.execution.timeout;

    // Tool catalogue — when the caller supplies `toolsDir`, load it and cache
    // on the session. The step loop later dispatches `[tool: ...]` lines
    // through `executeToolStep` so deterministic tool code runs on the server
    // (parallel to how the CLI runner dispatches them). Without `toolsDir`
    // `[tool: ...]` lines reach the AI as plain text — same as pre-Phase-5
    // behaviour.
    //
    // Reload (rather than reuse the cache) when the `toolsDir` changed since
    // the cached catalogue was built, or when that catalogue is empty — a
    // previously missing/misconfigured dir that the user has since fixed.
    // This makes a Continue / re-run self-heal without a session restart. A
    // populated catalogue from the same dir is reused (the steady-state perf
    // case).
    const cachedCatalogue = session.toolCatalogue;
    const needsCatalogueLoad =
      !!request.toolsDir &&
      (!cachedCatalogue ||
        session.toolCatalogueDir !== request.toolsDir ||
        // Lazy catalogues report 0 *loaded* tools until something resolves, so
        // gate the rescan on the indexed file count — re-scan only when the
        // previous scan found no files (a dir that was missing/empty and may
        // since have been populated).
        cachedCatalogue.indexedCount === 0);
    if (request.toolsDir && needsCatalogueLoad) {
      try {
        session.toolCatalogue = await loadToolCatalogue(request.toolsDir);
        session.toolCatalogueDir = request.toolsDir;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Session "${sessionId}": failed to load tool catalogue "${request.toolsDir}": ${message}`);
        emit({ type: 'output', msg: `Tool catalogue load failed: ${message}`, kind: 'error' });
        emit({ type: 'done', status: 'error' });
        return {
          sessionId,
          status: 'error',
          stepsCompleted: 0,
          stepsTotal,
          results: [],
          outputs: session.outputs,
          outputSources: { ...session.outputSources },
          error: { step: 0, message },
          pageTitle: '',
        };
      }
    }
    const toolCatalogue = session.toolCatalogue;

    // Skill expansion — when the caller supplies `skillsDir`, flatten
    // `[skill: ...]` lines into their bodies before execution and remember
    // the per-step origin so step-into-aware clients see `frame:push` /
    // `frame:pop` events around each skill body. Without `skillsDir` the
    // existing flow is preserved verbatim (raw steps shipped to the runner).
    if (request.skillsDir) {
      try {
        const expansion = await expandSkills(
          request.steps,
          request.skillsDir,
          envDataCtx ?? undefined,
          request.testFilePath,
          // Thread sourceLines so top-level [skill: ...] invocations
          // get a non-zero `frame.line` — the client uses it to paint
          // running/pass on the test file's `[skill: ...]` step row.
          // Without this, the row stays blank.
          request.sourceLines,
        );
        effectiveSteps = expansion.steps;
        stepsTotal = effectiveSteps.length;
        expansionOrigins = expansion.origins;
        // Translate ExpandedFrame (parser shape) into FrameInfo (wire shape):
        // the parser uses `invocationLine | null`, the wire carries a non-null
        // line. We pin the test-frame line to 0 when absent; consumers treat
        // it as "frame has no parent line".
        expansionFrames = {};
        for (const [id, f] of Object.entries(expansion.frames)) {
          expansionFrames[id] = {
            id: f.id,
            parentId: f.parentId,
            kind: f.kind,
            uri: f.uri,
            line: f.invocationLine ?? 0,
            ...(f.skillName !== undefined && { skillName: f.skillName }),
          };
          // Parallel input map kept server-side only (not part of the
          // wire FrameInfo). Merged into the `frame:scope` payload on
          // `frame:push` so a debugger pause inside the skill can see
          // the caller-supplied parameter values, which would
          // otherwise be invisible because the expander inlines them
          // directly into the step text rather than into the
          // resolvedParameters map.
          if (f.inputs) frameInputs[id] = { ...f.inputs };
          // Tag this skill's declared outputs as 'toolOutput' provenance.
          // They reach session scope via a rewritten `[store as: ...]` and
          // would otherwise be swept as plain 'capture' (the runtime can't
          // tell a skill return from a page capture). Seed the label here —
          // before the step loop — using first-write-wins so a name already
          // claimed by a parameter keeps 'parameter'. Skill-internal
          // (`__skill*`) names never reach `session.outputs`, so skip them.
          for (const name of f.outputs ?? []) {
            if (!name.startsWith('__skill') && !(name in session.outputSources)) {
              session.outputSources[name] = 'toolOutput';
            }
          }
        }
        // Re-derive sourceLines: skill-body steps point at the skill file's
        // own line; inline steps keep their original test-file line. Without
        // this, a status emitted for a skill-body step would land on the
        // wrong line in the test editor.
        effectiveSourceLines = expansion.origins.map((o) => {
          if (o.skillLine !== undefined) return o.skillLine;
          return request.sourceLines?.[o.inputIndex] ?? o.inputIndex + 1;
        });
      } catch (err) {
        // Skill expansion failures (cycles, missing files, bad args) abort
        // the run before the browser does any work. Mirror the existing
        // executeStep error path so the SSE stream emits a clean `done`.
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Session "${sessionId}": skill expansion failed: ${message}`);
        emit({ type: 'output', msg: `Skill expansion failed: ${message}`, kind: 'error' });
        emit({ type: 'done', status: 'error' });
        return {
          sessionId,
          status: 'error',
          stepsCompleted: 0,
          stepsTotal,
          results: [],
          outputs: session.outputs,
          outputSources: { ...session.outputSources },
          error: { step: 0, message },
          pageTitle: '',
        };
      }
    }

    // ─── StepCache initialization ────────────────────────────────────────
    //
    // Per-request: clear the skill cache (already done at the top of
    // executeSteps), then build a fresh StepCache anchored at the test's
    // project root. The cache key is (testFilePath, hash(fullSteps)). The
    // hash uses `fullSteps` when the client supplies it (multi-batch runs
    // trim `steps` to a slice; without `fullSteps` the hash would differ
    // between batches of the same test and no cache hit would ever land).
    //
    // Project root is resolved from `testFilePath`, NOT from the server's
    // CWD — testbench-native may launch the server from anywhere. If no
    // project marker is found by walking up from the test file, the cache
    // is disabled for this request with a one-time warning rather than
    // writing to a phantom `.cache` next to the server process.
    // Cache is opt-in: the client must explicitly send `cacheEnabled: true`.
    // An absent flag (`undefined`) means OFF, so a caller that says nothing
    // about caching gets none. (Previously `undefined` meant ON, which made
    // the cache impossible to turn off from clients that never set the flag.)
    // A partial re-run (`startAt`) seeds scope and may carry edited values, but
    // its per-step cache keys are identical to the full run's (same expanded
    // bundle hash + frame-scoped keys), so a cache HIT would replay the frozen
    // action plan and silently ignore an edit meant to change behaviour. Force
    // the cache OFF for any partial re-run regardless of what the client sent.
    const isPartialRerun = request.startAt !== undefined;
    const cacheEnabledForRequest =
      request.cacheEnabled === true && !!request.testFilePath && !isPartialRerun;
    let stepCache: StepCache | undefined;
    if (cacheEnabledForRequest && request.testFilePath) {
      // Reuse the project root already resolved for the env/data bundle (it was
      // hoisted out of this branch — it now runs for every request).
      const projectRoot = projectBundle.projectRoot;
      if (projectRoot) {
        const cacheDir = pathJoin(projectRoot, projectConfig.cache.dir);
        // Bundle-hash source (issue 016 Bug 2). The hash must change when a
        // skill body changes AND be stable across every batch of one document.
        // `effectiveSteps` (the expansion of this batch) is the right source
        // only when the batch IS the whole document; a subset batch must hash
        // the expansion of the FULL document so it matches a full run's hash.
        let cacheHashSource: string[];
        const choice = chooseCacheHashSource(request.steps, request.fullSteps, !!request.skillsDir);
        if (choice === 'raw-full') {
          cacheHashSource = request.fullSteps!;
        } else if (choice === 'expand-full') {
          // Subset batch with skills: expand the full document for the hash.
          // Own try/catch — a skill referenced only outside this batch may be
          // mid-edit/broken; fall back to the raw full list rather than fail an
          // otherwise-valid batch (the broken skill aborts the run elsewhere if
          // the user resumes into it).
          try {
            const fullExpansion = await expandSkills(
              request.fullSteps!,
              request.skillsDir!,
              envDataCtx ?? undefined,
              request.testFilePath,
              request.sourceLines,
            );
            cacheHashSource = fullExpansion.steps;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              `Session "${sessionId}": cache-hash full-document expansion failed (${msg}); falling back to raw fullSteps`,
            );
            cacheHashSource = request.fullSteps!;
          }
        } else {
          // 'effective': batch == fullSteps (or legacy no-fullSteps caller).
          // effectiveSteps already IS the expanded full document — or the raw
          // steps when no skillsDir — so it bakes in skill bodies for the hash.
          cacheHashSource = effectiveSteps;
        }
        try {
          stepCache = await StepCache.initialize(cacheDir, request.testFilePath, cacheHashSource);
        } catch (err) {
          logger.warn(
            `Session "${sessionId}": failed to initialize step cache: ${(err as Error).message} — proceeding without cache`,
          );
        }
      } else {
        logger.warn(
          `Session "${sessionId}": no project root found for ${request.testFilePath} — cache disabled`,
        );
      }
    }

    // Detect conditional step groups for multi-outcome branching — interpolate
    // env/data substitutions first so grouping looks at the final step text
    // (otherwise `${data.foo}` placeholders could change which steps look
    // alike for grouping purposes).
    const interpolatedSteps = envDataCtx
      ? effectiveSteps.map((s) => interpolateEnvData(s, envDataCtx))
      : effectiveSteps;
    const stepGroups = identifyStepGroups(interpolatedSteps);

    // ─── Frame stack ────────────────────────────────────────────────────────
    //
    // For step-into-aware clients: maintain a stack of currently-pushed
    // skill frames, emit `frame:push` / `frame:pop` events to transition
    // the stack to the frame each step belongs to, and return the FrameInfo
    // payload to attach to `step:start` / `step:pass` / `step:fail`.
    //
    // `activeFrames` is the stack of frame ids (without the implicit test
    // root). `desiredFrameChain(frameId)` walks parentId links via
    // `expansionFrames` to produce the chain from outermost to the given
    // frame (empty when the step lives in the test frame).
    const activeFrames: string[] = [];
    const desiredFrameChain = (frameId: string): string[] => {
      if (!expansionFrames || frameId === '') return [];
      const chain: string[] = [];
      let cur: string | null = frameId;
      while (cur && cur !== '') {
        chain.unshift(cur);
        cur = expansionFrames[cur]?.parentId ?? null;
      }
      return chain;
    };
    const transitionToFrame = (frameId: string): void => {
      if (!expansionFrames) return;
      const desired = desiredFrameChain(frameId);
      // Pop until activeFrames matches a prefix of desired.
      while (activeFrames.length > 0) {
        const idx = activeFrames.length - 1;
        if (idx < desired.length && activeFrames[idx] === desired[idx]) break;
        const popped = activeFrames.pop()!;
        emit({ type: 'frame:pop', frameId: popped, outputs: {} });
      }
      // Push the remainder. Each push is paired with a `frame:scope`
      // snapshot so a client that pauses BEFORE the first step in the
      // new frame (e.g. via a skill-file breakpoint) can still see
      // the variables the expander has placed into resolvedParameters
      // for that frame — most importantly, the input parameters the
      // caller passed in. Without this scope-on-entry emit, the
      // Variables view stays empty until a step inside the frame
      // passes/fails, which is too late for a debugger pause point.
      //
      // Merge order matters: `frameInputs[f.id]` (the caller's
      // resolved arg values) overlays `resolvedParameters` so the
      // skill's declared param names take precedence over any same-
      // named entries that may already exist in the test scope.
      while (activeFrames.length < desired.length) {
        const nextId = desired[activeFrames.length]!;
        const f = expansionFrames[nextId];
        if (!f) break;
        activeFrames.push(nextId);
        emit({ type: 'frame:push', frame: f });
        emit({
          type: 'frame:scope',
          frameId: f.id,
          scope: { ...resolvedParameters, ...(frameInputs[f.id] ?? {}) },
        });
      }
    };
    const frameInfoFor = (i: number): FrameInfo | undefined => {
      if (!expansionOrigins || !expansionFrames) return undefined;
      const origin = expansionOrigins[i];
      if (!origin) return undefined;
      if (origin.frameId === '') {
        // Test (top-level inline) frame. Synthesise a FrameInfo so clients
        // get a uri attribution even without an explicit push event.
        return request.testFilePath
          ? { id: '', parentId: null, kind: 'test', uri: request.testFilePath, line: 0 }
          : undefined;
      }
      return expansionFrames[origin.frameId];
    };

    /**
     * Walk the frame's ancestry to get the step's depth. Test (root)
     * frame is depth 0; each nested skill is +1. Used by stepMode pause
     * decisions: 'over' pauses when next depth ≤ current depth; 'out'
     * pauses when next depth < current depth.
     */
    const depthOf = (i: number): number => {
      if (!expansionOrigins || !expansionFrames) return 0;
      const origin = expansionOrigins[i];
      if (!origin || origin.frameId === '') return 0;
      let depth = 0;
      let cur: string | null = origin.frameId;
      const seen = new Set<string>();
      while (cur && cur !== '' && !seen.has(cur)) {
        seen.add(cur);
        depth++;
        cur = expansionFrames[cur]?.parentId ?? null;
      }
      return depth;
    };

    // Initial step mode from the request. Defaults to 'continue' (legacy
    // behaviour). The HTTP run-control endpoint can flip this mid-run by
    // resolving the per-session pendingRunControl Promise the step loop
    // awaits when paused.
    let currentMode: 'continue' | 'into' | 'over' | 'out' = request.stepMode ?? 'continue';

    // Seed the one-shot tool-debugger pause flag from the initial request.
    // The HTTP run-control endpoint can flip it back on mid-run; the step
    // loop consumes it on the first `[tool: ...]` it reaches.
    if (request.pauseAtNextTool) {
      session.pauseAtNextTool = true;
    }

    // Per-URI breakpoint sets for the server-side pause check. Skill-
    // file (and any non-test-file) breakpoints land here; the test file's
    // own breakpoints are skipped because the client already trims at
    // them before sending the request (legacy `trimAtBreakpoint` path).
    const breakpointSetsByUri = new Map<string, Set<number>>();
    if (request.breakpointsByUri) {
      for (const [uri, lines] of Object.entries(request.breakpointsByUri)) {
        if (uri === request.testFilePath) continue;
        if (lines.length === 0) continue;
        breakpointSetsByUri.set(uri, new Set(lines));
      }
    }
    // Initial scope for the test (root) frame. Same rationale as the
    // scope-on-frame-push emit in `transitionToFrame`: a client that
    // pauses BEFORE the first step (e.g. via a breakpoint trim on
    // step 1, or stepMode='into' with run-control before the first
    // execution) needs to see the test's resolved parameters from
    // the start. Without this, the Variables view stays empty until
    // step 1 passes, which is too late for the debugger UX.
    emit({
      type: 'frame:scope',
      frameId: '',
      scope: { ...resolvedParameters },
    });

    // Partial re-run ("re-run this skill step with its variables"): skip every
    // expanded step before the failed one. Match by (origin file, source line)
    // so a line that recurs in a different frame can't false-match. The single
    // sent `[skill: …]` invocation expands to just that skill's body, so running
    // from here to the end of `effectiveSteps` is exactly "from the failed step
    // to the end of the skill".
    // Resolve the origin file of an expanded step — used to match both the
    // startAt lower bound and the endAt upper bound. Test-frame steps map to the
    // test file; skill-body steps map to their skill file.
    const uriOfStep = (i: number): string | undefined => {
      const origin = expansionOrigins?.[i];
      if (!origin || origin.frameId === '') return request.testFilePath;
      return expansionFrames?.[origin.frameId]?.uri;
    };

    let startIndex = 0;
    if (request.startAt) {
      const { uri: startUri, line: startLine } = request.startAt;
      startIndex = effectiveSteps.findIndex(
        (_, i) => uriOfStep(i) === startUri && (effectiveSourceLines?.[i] ?? -1) >= startLine,
      );
      if (startIndex < 0) {
        const message =
          `Re-run anchor not found: no step at or after line ${startLine} in ${startUri}. ` +
          `The skill may have changed since the failed run.`;
        logger.error(`Session "${sessionId}": ${message}`);
        emit({ type: 'output', msg: message, kind: 'error' });
        emit({ type: 'done', status: 'error' });
        return {
          sessionId,
          status: 'error',
          stepsCompleted: 0,
          stepsTotal,
          results: [],
          outputs: session.outputs,
          outputSources: { ...session.outputSources },
          error: { step: 0, message },
          pageTitle: '',
        };
      }
      // Guard: starting on a non-first member of a conditional group would skip
      // the group (the loop's group check `continue`s for non-first members) and
      // finish as a misleading "passed" having executed nothing. Snap the anchor
      // back to the group's first step so its lookahead stays intact. (Latent
      // today — branched steps emit no step:fail, so the client never anchors
      // here — but `startAt` is a public field, so guard it.)
      const anchorGroup = stepGroups.get(startIndex);
      if (anchorGroup && startIndex !== anchorGroup.conditionalSteps[0]!.index) {
        startIndex = anchorGroup.conditionalSteps[0]!.index;
      }
      logger.info(
        `Session "${sessionId}": partial re-run from step ${startIndex + 1}/${stepsTotal} (${startUri}:${startLine})`,
      );
    }

    // Upper bound for a bounded re-run ("run selected skill steps"). Default: the
    // end of the expansion — for a single sent [skill:] invocation that IS the end
    // of the skill body, so omitting endAt preserves the startAt-only behaviour
    // exactly.
    let endIndex = effectiveSteps.length - 1;
    if (request.endAt) {
      const { uri: endUri, line: endLine } = request.endAt;
      let found = -1;
      for (let i = startIndex; i < effectiveSteps.length; i++) {
        if (uriOfStep(i) === endUri && (effectiveSourceLines?.[i] ?? Number.MAX_SAFE_INTEGER) <= endLine) {
          found = i;
        }
      }
      if (found < 0) {
        // endAt present but no step at/after the start in endAt.uri is ≤ endAt.line
        // (an inverted or stale range). Refuse explicitly rather than silently
        // running to the end of the skill — symmetric with the startAt guard above.
        const message =
          `Re-run end anchor not found: no step in the re-run range at or before ` +
          `line ${endLine} in ${endUri}. The skill may have changed since the run was stopped.`;
        logger.error(`Session "${sessionId}": ${message}`);
        emit({ type: 'output', msg: message, kind: 'error' });
        emit({ type: 'done', status: 'error' });
        return {
          sessionId,
          status: 'error',
          stepsCompleted: 0,
          stepsTotal,
          results: [],
          outputs: session.outputs,
          outputSources: { ...session.outputSources },
          error: { step: 0, message },
          pageTitle: '',
        };
      }
      endIndex = found;
      // If endIndex lands inside a conditional group, snap it to the group's last
      // *conditional* member. The group runs atomically from its first member
      // (executeBranchedStep), after which the loop jumps past to the continuation
      // step — so this only needs to guarantee the loop still reaches the group's
      // first member; it can neither split a group nor drop the continuation.
      const endGroup = stepGroups.get(endIndex);
      if (endGroup) {
        const lastInGroup =
          endGroup.conditionalSteps[endGroup.conditionalSteps.length - 1]!.index;
        if (lastInGroup > endIndex) endIndex = lastInGroup;
      }
      logger.info(
        `Session "${sessionId}": bounded re-run to step ${endIndex + 1}/${stepsTotal} (${endUri}:${endLine})`,
      );
    }

    // Step indexes that have already had their breakpoint pause consumed
    // in this batch. Without this, the loop would re-pause forever on
    // the same step after a Continue.
    const consumedBreakpoints = new Set<number>();

    try {
      for (let i = startIndex; i <= endIndex; i++) {
        // Check abort BEFORE starting each step. We don't try to interrupt
        // a step mid-flight (Playwright actions / AI calls aren't reliably
        // cancelable today) — between-step granularity is the contract.
        if (signal?.aborted) {
          overallStatus = 'aborted';
          logger.info(`Session "${sessionId}": run aborted by client at step ${i + 1}/${stepsTotal}`);
          break;
        }
        const originalStep = effectiveSteps[i]!;

        // Apply env-data interpolation first (parse-time semantics: fixed for
        // the whole session), then runtime `{{...}}` parameter substitution.
        const envInterpolated = envDataCtx
          ? interpolateEnvData(originalStep, envDataCtx)
          : originalStep;
        const interpolated = interpolate(envInterpolated, resolvedParameters);

        // Partial re-run guard: a leftover `{{__skill…}}` after interpolation
        // means this tail step needs an internal value that an earlier (skipped)
        // step in the skill produced. Those are namespaced per-expansion and
        // can't be seeded, so refuse with a clear message rather than send the
        // AI a step with a literal placeholder baked in. Can't trip on a normal
        // full run — every internal var is produced before it's consumed. The
        // common case (the failed step itself depends on a skipped step) trips
        // on the first tail step, so nothing runs before the refusal.
        if (isPartialRerun && /\{\{__skill\w*\}\}/.test(interpolated)) {
          const frame = frameInfoFor(i);
          const message =
            `Can't re-run from this step on its own — it uses a value an earlier step ` +
            `in the skill produced, which can't be restored for a partial re-run. ` +
            `Use Continue to re-run the whole skill instead.`;
          logger.info(`Session "${sessionId}": partial re-run refused at step ${i + 1}: ${message}`);
          emit({
            type: 'step:fail',
            line: effectiveSourceLines?.[i] ?? i + 1,
            error: message,
            ...(frame && { frame }),
          });
          emit({ type: 'done', status: 'error' });
          return {
            sessionId,
            status: 'error',
            stepsCompleted: Math.max(0, i - startIndex),
            stepsTotal,
            results: [],
            outputs: session.outputs,
            outputSources: { ...session.outputSources },
            error: { step: i + 1, message },
            pageTitle: '',
          };
        }

        // Check if this step is part of a conditional group
        const group = stepGroups.get(i);
        if (group && i === group.conditionalSteps[0]!.index) {
          logger.info(`Session "${sessionId}": conditional group at step ${i + 1}`);

          const branchedResults = await executeBranchedStep(group, stepsTotal, {
            page: session.browserSession.pageTracker.getActive(),
            config: this.config,
            aiClient: session.aiClient,
            contextContent: session.contextContent,
            testName: `session:${sessionId}`,
            ...(session.sessionConfig.baseUrl !== undefined && {
              baseUrl: session.sessionConfig.baseUrl,
            }),
            conversationHistory: [...session.conversationHistory],
            apiResponseStore: session.apiResponseStore,
            csrfTokens: session.csrfTokens,
            resolvedParameters,
            pageTracker: session.browserSession.pageTracker,
            browserTracker: session.browserTracker,
          });

          let branchFailed = false;
          for (const result of branchedResults) {
            const screenshotValue = result.screenshotBase64
              ? `data:image/png;base64,${result.screenshotBase64}`
              : '';
            const resultStatus: 'passed' | 'failed' | 'error' =
              result.status === 'skipped' ? 'passed' : result.status;

            results.push({
              step: effectiveSteps[result.index] ?? result.instruction,
              status: resultStatus,
              actions: result.turns.flatMap((t) => t.subActions).map((sa) => sa.action),
              screenshot: screenshotValue,
              reasoning: result.aiExplanation ?? '',
              outputs: {},
            });

            let currentUrl = '';
            try {
              currentUrl = session.browserSession.pageTracker.getActive().url();
            } catch { /* ignore */ }

            session.conversationHistory.push(
              formatStepHistoryEntry(
                session.totalStepsExecuted + 1,
                result.instruction,
                result.status === 'passed',
                currentUrl,
              ),
            );
            session.tokenTracker.resetStep();
            session.totalStepsExecuted++;

            if (result.status === 'failed') {
              overallStatus = 'failed';
              errorInfo = { step: result.index, message: result.error ?? 'Step failed' };
              branchFailed = true;
            } else {
              stepsCompleted++;
            }
          }

          // Skip past all steps in this group
          i = group.continuationStep.index;

          if (branchFailed) break;
          continue;
        }

        if (group && i !== group.conditionalSteps[0]!.index) {
          // Part of a group but not the first — already handled
          continue;
        }

        // Transition the frame stack to this step's frame before emitting
        // anything tagged with `line` — clients use the most recent
        // frame:push to scope the line to a file. `frameForStep` is spread
        // into each step event below so step-into-aware clients can attach
        // origin metadata without legacy clients seeing a new mandatory field.
        const stepFrameId = expansionOrigins?.[i]?.frameId ?? '';
        transitionToFrame(stepFrameId);
        const frameForStep = frameInfoFor(i);
        const frameSpread: { frame?: FrameInfo } = frameForStep ? { frame: frameForStep } : {};

        // ── Server-side breakpoint check ────────────────────────────
        //
        // If the next step's origin (URI + source line) matches a
        // breakpoint AND we haven't already paused for this exact step
        // index, emit `step:awaiting` and park on `pendingRunControl`
        // — same machinery the stepMode flow uses. The client treats
        // the pause as step-paused state; F5 / F11 / F10 / Shift+F11
        // all just work.
        //
        // Skill-file breakpoints are the primary reason this exists.
        // Test-file breakpoints are filtered out at map-build time
        // because the client already trims at them client-side via
        // `trimAtBreakpoint` before the request is sent.
        if (
          breakpointSetsByUri.size > 0 &&
          !consumedBreakpoints.has(i) &&
          frameForStep?.uri &&
          !signal?.aborted
        ) {
          const stepUriBps = breakpointSetsByUri.get(frameForStep.uri);
          const stepLine = sourceLineFor(i);
          if (stepUriBps?.has(stepLine)) {
            consumedBreakpoints.add(i);
            emit({
              type: 'step:awaiting',
              line: stepLine,
              ...frameSpread,
            });
            const newMode = await new Promise<'continue' | 'into' | 'over' | 'out'>((resolve) => {
              session.pendingRunControl = { resolve };
              if (signal?.aborted) {
                session.pendingRunControl = null;
                resolve('continue');
                return;
              }
              signal?.addEventListener(
                'abort',
                () => {
                  if (session.pendingRunControl?.resolve === resolve) {
                    session.pendingRunControl = null;
                    resolve('continue');
                  }
                },
                { once: true },
              );
            });
            currentMode = newMode;
          }
        }

        // Check for skippable steps ([input:] and [interactive])
        if (isSkippableStep(interpolated)) {
          logger.info(`Session "${sessionId}": skipping step ${i + 1} (input/interactive not supported in API mode)`);
          emit({ type: 'step:start', line: sourceLineFor(i), ...frameSpread });
          results.push({
            step: originalStep,
            status: 'passed',
            actions: [],
            screenshot: '',
            reasoning: 'Skipped: [input] and [interactive] steps are not supported in API mode',
            outputs: {},
          });
          emit({ type: 'step:pass', line: sourceLineFor(i), output: 'skipped', ...frameSpread });
          stepsCompleted++;
          session.totalStepsExecuted++;
          continue;
        }

        // Parse [output: var] prefixes
        const { variables: outputVars, cleanedInstruction } = parseOutputPrefixes(interpolated);

        // Build the instruction to send to executeStep
        let stepInstruction: string;
        if (outputVars.length > 0) {
          stepInstruction = buildEnrichedInstruction(cleanedInstruction, outputVars);
        } else {
          stepInstruction = interpolated;
        }

        logger.step(
          session.totalStepsExecuted + 1,
          session.totalStepsExecuted + stepsTotal - i,
          stepInstruction,
        );

        emit({ type: 'step:start', line: sourceLineFor(i), ...frameSpread });

        // Tool-step branch — when the step is a `[tool: ...]` invocation
        // AND we have a loaded catalogue, dispatch through `executeToolStep`
        // (the same code path the CLI runner uses) and shape the outcome
        // into a `StepResult` so the rest of the loop is unchanged. Without
        // a catalogue, fall through to `executeStep` and let the AI loop
        // see the raw `[tool: ...]` text (legacy behaviour).
        const toolCall = toolCatalogue ? parseToolCall(originalStep) : null;
        let stepResult: StepResult;
        try {
          if (toolCall && toolCatalogue) {
            // Tool step-into — Phase 5. When the session's one-shot
            // pause-at-next-tool flag is set, surface a
            // `tool:awaiting-debugger` event and wait for the client to
            // attach VS Code's Node debugger. The cooperative
            // `debugger;` lives inside `executeToolStep` immediately
            // before `def.run(...)` so stepping past it lands the user
            // in the tool body rather than in argument-coercion
            // boilerplate (see step-into-design.md §Tool step-into).
            // The flag is consumed here so each F11 yields exactly one
            // pause.
            let pauseBeforeRun = false;
            if (session.pauseAtNextTool && !signal?.aborted) {
              session.pauseAtNextTool = false;
              // Resolve (and lazily import) the tool so its filePath is known
              // for the debugger-attach. Swallow failures — the imminent
              // executeToolStep will surface the real error as a failed step.
              const registered = await toolCatalogue.resolve(toolCall.name).catch(() => undefined);
              emit({
                type: 'tool:awaiting-debugger',
                toolName: toolCall.name,
                ...(registered?.filePath && { toolFilePath: registered.filePath }),
                line: sourceLineFor(i),
                ...frameSpread,
              });
              // Park on the ack. If the run is aborted while we're
              // parked, resolve immediately so the next-iteration abort
              // check picks it up — and skip the cooperative pause
              // because there's no debugger attached on this path.
              let abortedDuringWait = false;
              await new Promise<void>((resolve) => {
                session.pendingDebuggerAck = { resolve };
                if (signal?.aborted) {
                  session.pendingDebuggerAck = null;
                  abortedDuringWait = true;
                  resolve();
                  return;
                }
                signal?.addEventListener(
                  'abort',
                  () => {
                    if (session.pendingDebuggerAck?.resolve === resolve) {
                      session.pendingDebuggerAck = null;
                      abortedDuringWait = true;
                      resolve();
                    }
                  },
                  { once: true },
                );
              });
              // Only arm the cooperative pause when the ack actually
              // arrived (vs. abort). Otherwise we'd hit `debugger;`
              // with no attached inspector even though the user
              // cancelled.
              pauseBeforeRun = !abortedDuringWait;
            }
            const startedAt = Date.now();
            const outcome = await executeToolStep(toolCall, {
              page: session.browserSession.pageTracker.getActive(),
              context: session.browserSession.context,
              browser: session.browserSession.browser,
              resolvedParameters,
              catalogue: toolCatalogue,
              ...(session.sessionConfig.baseUrl !== undefined && {
                baseUrl: session.sessionConfig.baseUrl,
              }),
              ...(pauseBeforeRun && { pauseBeforeRun: true }),
            });
            const passed = outcome.status === 'passed';
            stepResult = {
              index: i + 1,
              instruction: originalStep,
              status: passed ? 'passed' : 'failed',
              turns: [],
              durationMs: Date.now() - startedAt,
              retried: false,
              ...(outcome.error !== undefined && { error: outcome.error }),
              aiExplanation: passed
                ? `Tool "${outcome.toolName}" produced outputs: ${
                    Object.keys(outcome.outputs).length
                      ? Object.entries(outcome.outputs)
                          .map(([k, v]) => `${k}="${v}"`)
                          .join(', ')
                      : '(none)'
                  }`
                : `Tool "${outcome.toolName}" failed`,
              toolStep: {
                name: outcome.toolName,
                args: outcome.args,
                outputs: outcome.outputs,
                logs: outcome.logs,
              },
            };
            // The tool's `setVar` writes to resolvedParameters via the alias.
            // Surface each captured value via a `capture` event so the
            // Variables panel reflects it without waiting for an explicit
            // `[output: ...]` prefix.
            for (const [aliasName, aliasValue] of Object.entries(outcome.outputs)) {
              session.outputs[aliasName] = aliasValue;
              if (!(aliasName in session.outputSources)) session.outputSources[aliasName] = 'toolOutput';
              emit({
                type: 'capture',
                line: sourceLineFor(i),
                name: aliasName,
                value: aliasValue,
                source: 'toolOutput',
              });
            }
          } else {
            // Display/line identity: the source line in this step's own file
            // (test or skill). Drives StepResult.index and status events. NOT
            // unique across files — a skill-body step and a test step (or two
            // invocations of one skill) can share a line number.
            const stepSourceLine = effectiveSourceLines?.[i] ?? i + 1;
            // Cache filename identity: qualify the line with the invocation's
            // frame (`f1-17`) so skill-body steps and repeated invocations get
            // distinct cache files instead of colliding on a shared source line
            // (issue 016). Inline test steps have an empty frame and keep the
            // bare line (`step-17.json`); the no-skills path leaves origins null.
            const stepCacheKey = frameScopedStepKey(
              expansionOrigins?.[i]?.frameId,
              stepSourceLine,
            );
            stepResult = await executeStep(
              stepSourceLine,
              stepsTotal,
              stepInstruction,
              {
                page: session.browserSession.pageTracker.getActive(),
                config: this.config,
                aiClient: session.aiClient,
                contextContent: session.contextContent,
                testName: `session:${sessionId}`,
                ...(session.sessionConfig.baseUrl !== undefined && {
                  baseUrl: session.sessionConfig.baseUrl,
                }),
                conversationHistory: [...session.conversationHistory],
                apiResponseStore: session.apiResponseStore,
                csrfTokens: session.csrfTokens,
                resolvedParameters,
                pageTracker: session.browserSession.pageTracker,
                browserTracker: session.browserTracker,
                ...(stepCache && { stepCache }),
                cacheEnabled: cacheEnabledForRequest && !!stepCache,
                cacheKey: stepCacheKey,
                // No interactive console attached to a server-driven run —
                // an AI clarification prompt must fail the step fast rather
                // than block on stdin and hang the stream. See issues/014.
                nonInteractive: true,
              },
            );
          }
        } catch (err) {
          // Unexpected error during step execution
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Session "${sessionId}" step ${i + 1} error: ${message}`);

          // Capture screenshot on error if possible
          let errorScreenshot = '';
          try {
            const shot = await captureScreenshot(
              session.browserSession.pageTracker.getActive(),
            );
            errorScreenshot = shot?.base64
              ? `data:image/png;base64,${shot.base64}`
              : '';
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
          fullStepResults.push({
            index: i + 1,
            instruction: originalStep,
            status: 'failed',
            turns: [],
            durationMs: 0,
            retried: false,
            error: message,
            ...(errorScreenshot && { screenshotBase64: errorScreenshot.replace(/^data:image\/png;base64,/, '') }),
          });

          emit({
            type: 'step:fail',
            line: sourceLineFor(i),
            error: message,
            ...(errorScreenshot && { screenshot: errorScreenshot }),
            ...frameSpread,
          });

          overallStatus = 'error';
          errorInfo = { step: i, message };
          break;
        }

        // Collect per-step output captures from resolvedParameters
        const stepOutputs: Record<string, string> = {};
        for (const varName of outputVars) {
          if (varName in resolvedParameters) {
            stepOutputs[varName] = resolvedParameters[varName]!;
            // Accumulate into session outputs
            session.outputs[varName] = resolvedParameters[varName]!;
            if (!(varName in session.outputSources)) session.outputSources[varName] = 'capture';
            // Surface the capture to streaming clients so the Variables
            // panel can update live. We only emit for values that were
            // actually set — missing extractions stay silent.
            emit({
              type: 'capture',
              line: sourceLineFor(i),
              name: varName,
              value: resolvedParameters[varName]!,
              source: 'capture',
            });
          }
        }

        // Build the screenshot for the response
        const screenshotValue = stepResult.screenshotBase64
          ? `data:image/png;base64,${stepResult.screenshotBase64}`
          : '';

        // Map internal StepResult to API response format
        const resultStatus: 'passed' | 'failed' | 'error' =
          stepResult.status === 'skipped' ? 'passed' : stepResult.status;

        results.push({
          step: originalStep,
          status: resultStatus,
          actions: stepResult.turns.flatMap((t) => t.subActions).map((sa) => sa.action),
          screenshot: screenshotValue,
          reasoning: stepResult.aiExplanation ?? '',
          outputs: stepOutputs,
        });
        // Report parity with the CLI runner. The CLI tags each step
        // with two things the server must mirror here so the HTML
        // report renders identically:
        //
        //   index        — ordinal in the post-expansion step list
        //                  (1-based). The cache uses source line as
        //                  its identity (so step-<line>.json reads
        //                  human-meaningfully) but the report header
        //                  must show "Step 1, Step 2, …" not
        //                  "Step 17, Step 18, …" because the latter
        //                  leaks the skill-file line number into the
        //                  test author's report.
        //
        //   sourceSkill  — name of the OUTERMOST skill this step came
        //                  from (matches `test.sourceSkills[i]` in
        //                  the CLI's test-runner.ts). For nested
        //                  `skill_a → skill_b`, both inner and outer
        //                  body steps surface "skill_a" so the chip
        //                  reflects the user-visible invocation.
        const sourceSkill = outermostSkillName(
          expansionOrigins?.[i]?.frameId,
          expansionFrames,
        );
        fullStepResults.push({
          ...stepResult,
          index: i + 1,
          instruction: originalStep,
          ...(sourceSkill && { sourceSkill }),
        });

        // Update conversation history
        let currentUrl = '';
        try {
          currentUrl = session.browserSession.pageTracker.getActive().url();
        } catch {
          // ignore
        }

        session.conversationHistory.push(
          formatStepHistoryEntry(
            session.totalStepsExecuted + 1,
            interpolated,
            stepResult.status === 'passed',
            currentUrl,
          ),
        );

        session.tokenTracker.resetStep();
        session.totalStepsExecuted++;

        if (stepResult.status === 'passed') {
          stepsCompleted++;
          logger.success(
            `Session "${sessionId}" step ${i + 1} passed`,
          );
          emit({
            type: 'step:pass',
            line: sourceLineFor(i),
            ...(stepResult.aiExplanation && { output: stepResult.aiExplanation }),
            ...(screenshotValue && { screenshot: screenshotValue }),
            ...frameSpread,
            ...(stepResult.fromCache && { fromCache: true }),
          });

          // ── Frame scope snapshot (Phase 4) ──────────────────────────
          //
          // After every successful step, emit the current scope so the
          // Variables panel can keep up. Phase 4 ships a flat scope —
          // the full `resolvedParameters`, including any namespaced
          // skill-internal `__skillN_x` entries. Per-frame filtering
          // (reverse-rename resolution + skill-private vars only) is
          // tracked as Phase 4.B follow-up; the user gets visibility
          // into the actual runtime state in the meantime.
          //
          // Frame inputs (recorded at expansion time from the caller's
          // `[skill: foo X=...]` args) overlay resolvedParameters so
          // declared parameters stay visible across the frame's
          // lifetime — without this, they'd vanish after step 1 because
          // the expander inlines them into step text rather than into
          // the live scope map.
          emit({
            type: 'frame:scope',
            frameId: stepFrameId,
            scope: { ...resolvedParameters, ...(frameInputs[stepFrameId] ?? {}) },
          });

          // Persist variables captured via [store as: X] to session scope.
          // The outputVars loop above only handles [output: X] prefix steps;
          // [store as: X] writes directly to resolvedParameters via the step
          // executor and would be lost when a breakpoint splits the run into
          // separate batch requests (the next batch seeds resolvedParameters
          // from session.outputs, which never got the value).
          for (const [key, value] of Object.entries(resolvedParameters)) {
            if (!key.startsWith('__skill')) {
              session.outputs[key] = value;
              // Anything that reaches the sweep unlabelled was set by a
              // `[store as:]` modifier (the other write sites label inline).
              // Default to 'capture'; never overwrite an existing label.
              if (!(key in session.outputSources)) session.outputSources[key] = 'capture';
            }
          }

          // ── Step-mode pause decision ────────────────────────────────
          //
          // When the client started this batch with `stepMode !== 'continue'`,
          // we pause after each step depending on the depth relationship
          // between the just-executed step and the next one. The yellow ▶
          // moves to the next step's frame/line on the client; the loop
          // blocks on `pendingRunControl` until the client sends a new
          // mode via the `run-control` endpoint.
          if (currentMode !== 'continue' && i < endIndex) {
            const nextI = i + 1;
            const curDepth = depthOf(i);
            const nextDepth = depthOf(nextI);
            const shouldPause =
              currentMode === 'into' ||
              (currentMode === 'over' && nextDepth <= curDepth) ||
              (currentMode === 'out' && nextDepth < curDepth);
            if (shouldPause) {
              // Pre-transition the frame stack to the next step's frame so
              // step:awaiting carries the right frame payload (the call
              // stack view + yellow ▶ both need the destination, not the
              // origin).
              const nextFrameId = expansionOrigins?.[nextI]?.frameId ?? '';
              transitionToFrame(nextFrameId);
              const nextFrame = frameInfoFor(nextI);
              const nextLine = sourceLineFor(nextI);
              emit({
                type: 'step:awaiting',
                line: nextLine,
                ...(nextFrame && { frame: nextFrame }),
              });
              // Block until the client sends the next mode (or the run
              // gets aborted). On abort we resolve with 'continue' to
              // unblock cleanly — the abort check at the top of the next
              // iteration catches the actual abort.
              const newMode = await new Promise<'continue' | 'into' | 'over' | 'out'>((resolve) => {
                session.pendingRunControl = { resolve };
                if (signal?.aborted) {
                  session.pendingRunControl = null;
                  resolve('continue');
                  return;
                }
                signal?.addEventListener('abort', () => {
                  if (session.pendingRunControl?.resolve === resolve) {
                    session.pendingRunControl = null;
                    resolve('continue');
                  }
                }, { once: true });
              });
              currentMode = newMode;
            }
          }
        } else {
          // Step failed
          overallStatus = 'failed';
          errorInfo = {
            step: i,
            message: stepResult.error ?? 'Step failed',
          };
          logger.error(
            `Session "${sessionId}" step ${i + 1} FAILED: ${stepResult.error ?? 'unknown'}`,
          );
          emit({
            type: 'step:fail',
            line: sourceLineFor(i),
            error: stepResult.error ?? 'Step failed',
            ...(screenshotValue && { screenshot: screenshotValue }),
            ...frameSpread,
          });
          // Phase 4 — surface the scope at failure time too. The user
          // wants to see "what were the variables when this step blew
          // up." Same flat shape as the pass-path emission above.
          // Same frameInputs overlay rationale (see above).
          emit({
            type: 'frame:scope',
            frameId: stepFrameId,
            scope: { ...resolvedParameters, ...(frameInputs[stepFrameId] ?? {}) },
          });
          break;
        }

        // Refresh active browser from the tracker — openBrowser /
        // switchBrowser / closeBrowser may have shifted which browser is
        // active. If the tracker has no browsers left (closeBrowser closed
        // the only one) or the active one was disconnected by the step
        // (e.g. "Close the browser"), tear down the session.
        let trackerEmpty = false;
        try {
          session.browserSession = session.browserTracker.getActive();
        } catch {
          trackerEmpty = true;
        }
        if (trackerEmpty || isBrowserClosed(session.browserSession)) {
          logger.info(`Session "${sessionId}": browser closed by step, removing session`);
          session.status = 'closed';
          this.sessions.delete(sessionId);
          break;
        }
      }
    } finally {
      // Restore status unless session was closed
      if (session.status !== 'closed') {
        session.status = 'active';
      }
      removeLogBridge();
      removeFileBridges();
      setLogLevel(previousLevel);
      if (runLog) {
        runLog.stream.write(
          `# endedAt=${new Date().toISOString()} status=${overallStatus}\n`,
        );
        runLog.dispose();
      }
    }

    // Resolve page title if session is still open
    let pageTitle = '';
    if (session.status !== 'closed') {
      try {
        pageTitle = await session.browserSession.pageTracker.getActive().title();
      } catch {
        // browser may be in an intermediate state
      }
    }

    // Generate an HTML report for this run. Mirrors the CLI test-runner
    // behaviour so testbench F5 produces the same artifact under
    // `<reports.outputDir>/`. Failures here are logged but never break the
    // run — the SSE stream has already delivered everything the client needs.
    // The returned path flows through to the `done` event so the client
    // can surface an "Open Report" button. Undefined when generation
    // failed or no steps ran.
    let reportPath: string | undefined;
    if (fullStepResults.length > 0) {
      try {
        const reportStatus: 'passed' | 'failed' =
          overallStatus === 'passed' ? 'passed' : 'failed';
        const passedSteps = fullStepResults.filter((s) => s.status === 'passed').length;
        const failedSteps = fullStepResults.filter((s) => s.status === 'failed').length;
        const totalSubActions = fullStepResults.reduce(
          (sum, s) => sum + s.turns.reduce((tSum, t) => tSum + t.subActions.length, 0),
          0,
        );
        const testName = basename(sessionId, '.md').replace(/^.*[\\/]/, '') || sessionId;
        const report: TestReport = {
          testName,
          filePath: sessionId,
          tags: [],
          status: reportStatus,
          steps: fullStepResults,
          totalSteps: stepsTotal,
          passedSteps,
          failedSteps,
          totalSubActions,
          durationMs: Date.now() - runStartTime,
          tokensUsed: session.tokenTracker.runTotal,
          inputTokens: session.tokenTracker.runInputTotal,
          outputTokens: session.tokenTracker.runOutputTotal,
          date: new Date().toISOString(),
          ...(session.sessionConfig.baseUrl !== undefined && { baseUrl: session.sessionConfig.baseUrl }),
          ...(Object.keys(resolvedParameters).length > 0 && { parameters: resolvedParameters }),
        };
        reportPath = await generateReport(report, this.config.reports.outputDir);
        logger.info(`Report saved: ${reportPath}`);
      } catch (err) {
        logger.warn(`Failed to generate HTML report for session "${sessionId}": ${String(err)}`);
      }
    }

    // Unwind any frames still on the stack — happens on early exit (fail,
    // error, abort) and on a clean finish where the last executed step was
    // inside a skill body. Clients need the matching pops to keep their
    // call-stack model consistent.
    transitionToFrame('');

    emit({ type: 'done', status: overallStatus, ...(reportPath && { reportPath }) });

    return {
      sessionId,
      status: overallStatus,
      stepsCompleted,
      stepsTotal,
      results,
      outputs: { ...session.outputs },
      outputSources: { ...session.outputSources },
      error: errorInfo,
      pageTitle,
    };
  }
}
